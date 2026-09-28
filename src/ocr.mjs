import { createWorker, OEM, PSM } from 'tesseract.js';

export async function createOcrWorker(config, onProgress = () => {}) {
  const options = {
    cachePath: config.ocrCachePath,
    logger: onProgress,
  };
  if (config.ocrLangPath) options.langPath = config.ocrLangPath;
  const worker = await createWorker(config.ocrLanguage, OEM.LSTM_ONLY, options);
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1',
  });
  return worker;
}

export async function recognizePage(worker, imagePath) {
  const result = await worker.recognize(imagePath, {}, { text: true, blocks: true, layoutBlocks: true });
  return result.data;
}

export function extractOcrBlocks(data, width, height, { minConfidence = 0 } = {}) {
  const candidates = data.lines?.length ? data.lines : data.words?.length ? data.words : data.blocks?.length ? data.blocks : [];
  return candidates
    .map((candidate, index) => {
      const text = String(candidate.text || '').replace(/\s+/g, ' ').trim();
      const confidence = Number(candidate.confidence);
      const bbox = candidate.bbox || {};
      const x0 = Number(bbox.x0);
      const y0 = Number(bbox.y0);
      const x1 = Number(bbox.x1);
      const y1 = Number(bbox.y1);
      if (!text || !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || x1 <= x0 || y1 <= y0) return null;
      if (Number.isFinite(confidence) && confidence / 100 < minConfidence) return null;
      return {
        polygon: [
          { x: clamp01(x0 / width), y: clamp01(y0 / height) },
          { x: clamp01(x1 / width), y: clamp01(y0 / height) },
          { x: clamp01(x1 / width), y: clamp01(y1 / height) },
          { x: clamp01(x0 / width), y: clamp01(y1 / height) },
        ],
        sourceText: text,
        confidence: Number.isFinite(confidence) ? clamp01(confidence / 100) : null,
        readingOrder: index,
      };
    })
    .filter(Boolean);
}

export function mergeNearbyOcrBlocks(blocks, width, height, {
  lineGapRatio = 3.5,
  overlapRatio = 0.55,
  maxGroupWidthRatio = 0.1,
  maxGroupHeightRatio = 0.28,
} = {}) {
  if (blocks.length < 2) return blocks;

  const bounds = blocks.map((block) => {
    const points = block.polygon || [];
    const xs = points.map((point) => Number(point.x) * width).filter(Number.isFinite);
    const ys = points.map((point) => Number(point.y) * height).filter(Number.isFinite);
    if (xs.length < 3 || ys.length < 3) return null;
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  });
  const parents = blocks.map((_, index) => index);
  const groupBounds = bounds.slice();
  const find = (index) => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftBounds = groupBounds[leftRoot];
    const rightBounds = groupBounds[rightRoot];
    if (!leftBounds || !rightBounds) return;
    const combined = {
      left: Math.min(leftBounds.left, rightBounds.left),
      top: Math.min(leftBounds.top, rightBounds.top),
      right: Math.max(leftBounds.right, rightBounds.right),
      bottom: Math.max(leftBounds.bottom, rightBounds.bottom),
    };
    if (combined.right - combined.left > width * maxGroupWidthRatio || combined.bottom - combined.top > height * maxGroupHeightRatio) return;
    parents[rightRoot] = leftRoot;
    groupBounds[leftRoot] = combined;
  };

  for (let leftIndex = 0; leftIndex < blocks.length; leftIndex += 1) {
    const left = bounds[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
      const right = bounds[rightIndex];
      if (!right) continue;
      const leftWidth = left.right - left.left;
      const rightWidth = right.right - right.left;
      const leftHeight = left.bottom - left.top;
      const rightHeight = right.bottom - right.top;
      const minCharSize = Math.max(1, Math.min(leftWidth, rightWidth, leftHeight, rightHeight));
      const maxGap = Math.max(2, minCharSize * lineGapRatio);
      const xOverlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
      const yOverlap = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
      const overlapsHorizontally = xOverlap / Math.max(1, Math.min(leftWidth, rightWidth)) >= overlapRatio;
      const overlapsVertically = yOverlap / Math.max(1, Math.min(leftHeight, rightHeight)) >= overlapRatio;
      const verticalGap = Math.max(0, Math.max(left.top, right.top) - Math.min(left.bottom, right.bottom));
      const horizontalGap = Math.max(0, Math.max(left.left, right.left) - Math.min(left.right, right.right));
      if ((overlapsHorizontally && verticalGap <= maxGap) || (overlapsVertically && horizontalGap <= maxGap)) {
        join(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map();
  blocks.forEach((block, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ block, bounds: bounds[index] });
  });

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0].block;
    const valid = group.filter((item) => item.bounds);
    if (!valid.length) return group[0].block;
    const left = Math.min(...valid.map((item) => item.bounds.left));
    const top = Math.min(...valid.map((item) => item.bounds.top));
    const right = Math.max(...valid.map((item) => item.bounds.right));
    const bottom = Math.max(...valid.map((item) => item.bounds.bottom));
    const bestText = [...group]
      .map(({ block }) => block)
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0) || String(b.sourceText).length - String(a.sourceText).length)[0];
    const confidences = group.map(({ block }) => Number(block.confidence)).filter(Number.isFinite);
    return {
      polygon: [
        { x: clamp01(left / width), y: clamp01(top / height) },
        { x: clamp01(right / width), y: clamp01(top / height) },
        { x: clamp01(right / width), y: clamp01(bottom / height) },
        { x: clamp01(left / width), y: clamp01(bottom / height) },
      ],
      sourceText: bestText.sourceText,
      confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      readingOrder: Math.min(...group.map(({ block }) => Number(block.readingOrder) || 0)),
    };
  }).sort((a, b) => a.readingOrder - b.readingOrder);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

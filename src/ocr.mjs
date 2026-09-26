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

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

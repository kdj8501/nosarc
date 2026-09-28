import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOcrBlocks, mergeNearbyOcrBlocks } from '../src/ocr.mjs';

test('extractOcrBlocks normalizes OCR boxes for the reader', () => {
  const blocks = extractOcrBlocks({ lines: [{ text: 'こんにちは', confidence: 88, bbox: { x0: 100, y0: 200, x1: 300, y1: 400 } }] }, 1000, 1000, { minConfidence: 0.5 });
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].polygon[0], { x: 0.1, y: 0.2 });
  assert.equal(blocks[0].confidence, 0.88);
});

test('extractOcrBlocks filters low-confidence and empty candidates', () => {
  const blocks = extractOcrBlocks({ lines: [
    { text: ' ', confidence: 99, bbox: { x0: 0, y0: 0, x1: 20, y1: 20 } },
    { text: 'noise', confidence: 5, bbox: { x0: 0, y0: 0, x1: 20, y1: 20 } },
  ] }, 100, 100, { minConfidence: 0.15 });
  assert.deepEqual(blocks, []);
});

test('mergeNearbyOcrBlocks groups adjacent text strips into larger OCR crops', () => {
  const blocks = [
    { polygon: [{ x: 0.1, y: 0.1 }, { x: 0.16, y: 0.1 }, { x: 0.16, y: 0.112 }, { x: 0.1, y: 0.112 }], sourceText: '첫 줄', confidence: 0.8, readingOrder: 0 },
    { polygon: [{ x: 0.101, y: 0.115 }, { x: 0.161, y: 0.115 }, { x: 0.161, y: 0.127 }, { x: 0.101, y: 0.127 }], sourceText: '둘째 줄', confidence: 0.9, readingOrder: 1 },
    { polygon: [{ x: 0.4, y: 0.1 }, { x: 0.46, y: 0.1 }, { x: 0.46, y: 0.112 }, { x: 0.4, y: 0.112 }], sourceText: '다른 말풍선', confidence: 0.95, readingOrder: 2 },
  ];

  const merged = mergeNearbyOcrBlocks(blocks, 1000, 1000);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].polygon, [
    { x: 0.1, y: 0.1 },
    { x: 0.161, y: 0.1 },
    { x: 0.161, y: 0.127 },
    { x: 0.1, y: 0.127 },
  ]);
  assert.equal(merged[0].sourceText, '둘째 줄');
  assert.equal(merged[0].confidence, 0.8500000000000001);
  assert.equal(merged[1].sourceText, '다른 말풍선');
});

test('mergeNearbyOcrBlocks limits a chain so nearby balloons do not become one oversized crop', () => {
  const blocks = [0, 85, 170].map((offset, readingOrder) => ({
    polygon: [
      { x: (100 + offset) / 1000, y: 0.2 },
      { x: (160 + offset) / 1000, y: 0.2 },
      { x: (160 + offset) / 1000, y: 0.212 },
      { x: (100 + offset) / 1000, y: 0.212 },
    ],
    sourceText: `줄 ${readingOrder}`,
    confidence: 0.8,
    readingOrder,
  }));

  const merged = mergeNearbyOcrBlocks(blocks, 1000, 1000, { lineGapRatio: 5, maxGroupWidthRatio: 0.18 });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].polygon[0].x, 0.1);
  assert.equal(merged[0].polygon[1].x, 0.245);
  assert.equal(merged[1].sourceText, '줄 2');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOcrBlocks } from '../src/ocr.mjs';

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

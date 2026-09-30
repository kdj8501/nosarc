import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as canvas from '@napi-rs/canvas';
import { createInpaintMask, renderTranslatedPage } from '../src/render.mjs';

test('createInpaintMask fills a light uniform OCR region without clearing the whole balloon', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nosarc-mask-'));
  const inputPath = path.join(directory, 'source.png');
  try {
    const source = canvas.createCanvas(200, 120);
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#ffffff';
    sourceContext.fillRect(0, 0, 200, 120);
    await fs.writeFile(inputPath, source.toBuffer('image/png'));
    const sourcePolygon = [
      { x: 0.45, y: 0.35 }, { x: 0.55, y: 0.35 },
      { x: 0.55, y: 0.45 }, { x: 0.45, y: 0.45 },
    ];
    const glyphPolygon = [
      { x: 0.49, y: 0.39 }, { x: 0.51, y: 0.39 },
      { x: 0.51, y: 0.41 }, { x: 0.49, y: 0.41 },
    ];
    const balloonPolygon = [
      { x: 0.4, y: 0.3 }, { x: 0.6, y: 0.3 },
      { x: 0.6, y: 0.5 }, { x: 0.4, y: 0.5 },
    ];
    const mask = await createInpaintMask(inputPath, [{
      text: '\uD14C\uC2A4\uD2B8',
      polygon_json: JSON.stringify(sourcePolygon),
      source_polygon_json: JSON.stringify(sourcePolygon),
      source_layout_hint_json: JSON.stringify({ letteringPolygon: balloonPolygon }),
      inpaint_mask_json: JSON.stringify([glyphPolygon]),
    }], { inpaintPadding: 0.2 });
    const image = await canvas.loadImage(mask);
    const rendered = canvas.createCanvas(image.width, image.height);
    const context = rendered.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const redAt = (x, y) => pixels[(y * image.width + x) * 4];

    assert.equal(redAt(91, 48), 255, 'the OCR region should be cleared beyond the detected ink contour');
    assert.equal(redAt(100, 32), 0, 'the mask should not clear the rest of the speech balloon');
    assert.equal(redAt(78, 48), 0, 'the mask should stay close to the detected text');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('createInpaintMask preserves dark artwork outside glyph contours when the OCR region is unsafe', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nosarc-mask-fallback-'));
  const inputPath = path.join(directory, 'source.png');
  try {
    const source = canvas.createCanvas(200, 120);
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#242424';
    sourceContext.fillRect(0, 0, 200, 120);
    await fs.writeFile(inputPath, source.toBuffer('image/png'));
    const sourcePolygon = [
      { x: 0.4, y: 0.3 }, { x: 0.6, y: 0.3 },
      { x: 0.6, y: 0.5 }, { x: 0.4, y: 0.5 },
    ];
    const glyphPolygon = [
      { x: 0.48, y: 0.38 }, { x: 0.52, y: 0.38 },
      { x: 0.52, y: 0.42 }, { x: 0.48, y: 0.42 },
    ];
    const mask = await createInpaintMask(inputPath, [{
      text: '\uD14C\uC2A4\uD2B8',
      polygon_json: JSON.stringify(sourcePolygon),
      source_polygon_json: JSON.stringify(sourcePolygon),
      source_layout_hint_json: JSON.stringify({}),
      inpaint_mask_json: JSON.stringify([glyphPolygon]),
    }], { inpaintPadding: 0.2 });
    const image = await canvas.loadImage(mask);
    const rendered = canvas.createCanvas(image.width, image.height);
    const context = rendered.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const redAt = (x, y) => pixels[(y * image.width + x) * 4];

    assert.equal(redAt(100, 48), 255, 'detected glyph ink should be inpainted');
    assert.equal(redAt(86, 55), 0, 'dark artwork outside the glyph contour should remain untouched');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('renderTranslatedPage fits text inside its OCR region', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nosarc-render-'));
  const inputPath = path.join(directory, 'source.png');
  try {
    const source = canvas.createCanvas(200, 100);
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#ffffff';
    sourceContext.fillRect(0, 0, 200, 100);
    await fs.writeFile(inputPath, source.toBuffer('image/png'));

    const output = await renderTranslatedPage(inputPath, [{
      polygon: [
        { x: 0.3, y: 0.3 },
        { x: 0.7, y: 0.3 },
        { x: 0.7, y: 0.5 },
        { x: 0.3, y: 0.5 },
      ],
      text: '읽을 수 있어요',
      style: { color: '#000000', background: 'rgba(255, 255, 255, 1)', fontSize: 60, writingMode: 'horizontal-tb' },
    }], { skipInpaint: true });
    const image = await canvas.loadImage(output);
    const rendered = canvas.createCanvas(image.width, image.height);
    const context = rendered.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const pixel = (x, y) => [...pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
    let darkPixelCount = 0;
    for (let y = 30; y < 50; y += 1) {
      for (let x = 60; x < 140; x += 1) {
        if (pixel(x, y).some((channel) => channel < 200)) darkPixelCount += 1;
      }
    }

    assert.deepEqual(pixel(58, 40), [255, 255, 255]);
    assert.ok(darkPixelCount > 0, 'rendered lettering should be visible inside the region');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

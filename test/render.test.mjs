import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as canvas from '@napi-rs/canvas';
import { renderTranslatedPage } from '../src/render.mjs';

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

import * as canvas from '@napi-rs/canvas';
import fs from 'node:fs';

const { createCanvas, loadImage, GlobalFonts } = canvas;
const registeredFonts = new Set();

export async function renderTranslatedPage(sourcePath, layers, {
  inpaintPadding = 0.008,
  fontFamily = 'Malgun Gothic',
  fontPath = '',
  skipInpaint = false,
} = {}) {
  registerFont(fontPath, fontFamily);
  const image = await loadImage(sourcePath);
  const width = image.width;
  const height = image.height;
  const output = createCanvas(width, height);
  const context = output.getContext('2d');
  context.drawImage(image, 0, 0, width, height);

  const safeLayers = layers.filter((layer) => getBounds(layer.polygon_json || layer.polygon, width, height));
  if (!skipInpaint) {
    const imageData = context.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);
    for (const layer of safeLayers) markMask(mask, width, height, layer, inpaintPadding);
    inpaint(imageData, mask, width, height);
    context.putImageData(imageData, 0, 0);
  }

  for (const layer of safeLayers) drawLettering(context, layer, width, height, fontFamily);
  return output.toBuffer('image/png');
}

export async function createInpaintMask(sourcePath, layers, { inpaintPadding = 0.008 } = {}) {
  const image = await loadImage(sourcePath);
  const maskCanvas = createCanvas(image.width, image.height);
  const context = maskCanvas.getContext('2d');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, image.width, image.height);
  context.fillStyle = '#ffffff';
  for (const layer of layers) {
    const bounds = getBounds(layer.polygon_json || layer.polygon, image.width, image.height);
    if (!bounds) continue;
    const padX = Math.max(1, Math.round(image.width * Math.max(0, Number(inpaintPadding) || 0)));
    const padY = Math.max(1, Math.round(image.height * Math.max(0, Number(inpaintPadding) || 0)));
    const left = Math.max(0, bounds.left - padX);
    const top = Math.max(0, bounds.top - padY);
    const right = Math.min(image.width, bounds.right + padX);
    const bottom = Math.min(image.height, bounds.bottom + padY);
    context.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  }
  return maskCanvas.toBuffer('image/png');
}

function markMask(mask, width, height, layer, padding) {
  const bounds = getBounds(layer.polygon_json || layer.polygon, width, height);
  if (!bounds) return;
  const padX = Math.max(1, Math.round(width * Math.max(0, Number(padding) || 0)));
  const padY = Math.max(1, Math.round(height * Math.max(0, Number(padding) || 0)));
  const left = Math.max(0, Math.floor(bounds.left - padX));
  const top = Math.max(0, Math.floor(bounds.top - padY));
  const right = Math.min(width - 1, Math.ceil(bounds.right + padX));
  const bottom = Math.min(height - 1, Math.ceil(bounds.bottom + padY));
  for (let y = top; y <= bottom; y += 1) {
    const offset = y * width;
    mask.fill(1, offset + left, offset + right + 1);
  }
}

function inpaint(imageData, mask, width, height) {
  const { data } = imageData;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let x = 0;
    while (x < width) {
      if (!mask[rowOffset + x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x + 1 < width && mask[rowOffset + x + 1]) x += 1;
      const end = x;
      const left = start > 0 ? readPixel(data, (rowOffset + start - 1) * 4) : null;
      const right = end + 1 < width ? readPixel(data, (rowOffset + end + 1) * 4) : null;
      for (let fillX = start; fillX <= end; fillX += 1) {
        const pixelOffset = (rowOffset + fillX) * 4;
        if (left && right) {
          writePixel(data, pixelOffset, averagePixel(left, right));
        } else {
          const vertical = findVerticalPixel(data, mask, width, height, fillX, y);
          writePixel(data, pixelOffset, vertical || left || right || [255, 255, 255, 255]);
        }
      }
      x += 1;
    }
  }
}

function findVerticalPixel(data, mask, width, height, x, y) {
  let top = y - 1;
  while (top >= 0 && mask[top * width + x]) top -= 1;
  let bottom = y + 1;
  while (bottom < height && mask[bottom * width + x]) bottom += 1;
  const topPixel = top >= 0 ? readPixel(data, (top * width + x) * 4) : null;
  const bottomPixel = bottom < height ? readPixel(data, (bottom * width + x) * 4) : null;
  if (topPixel && bottomPixel) return averagePixel(topPixel, bottomPixel);
  return topPixel || bottomPixel;
}

function drawLettering(context, layer, width, height, fontFamily) {
  const bounds = getBounds(layer.polygon_json || layer.polygon, width, height);
  if (!bounds) return;
  const style = normalizeStyle(layer.style_json || layer.style);
  context.save();
  context.fillStyle = style.background;
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.fillStyle = style.color;
  context.font = `${style.fontWeight} ${Math.max(8, style.fontSize * Math.max(1, width / 760))}px "${fontFamily}", sans-serif`;
  context.textBaseline = 'middle';
  if (style.writingMode === 'vertical-rl') drawVerticalText(context, layer.text, bounds, style);
  else drawHorizontalText(context, layer.text, bounds, style);
  context.restore();
}

function drawHorizontalText(context, value, bounds, style) {
  const fontSize = style.fontSize * Math.max(1, context.canvas.width / 760);
  const lineHeight = fontSize * 1.15;
  const maxWidth = Math.max(fontSize, bounds.width - fontSize * 0.8);
  const lines = wrapText(context, String(value || ''), maxWidth);
  const totalHeight = lines.length * lineHeight;
  const firstY = bounds.top + Math.max(lineHeight / 2, (bounds.height - totalHeight) / 2 + lineHeight / 2);
  for (const [index, line] of lines.entries()) {
    const lineWidth = context.measureText(line).width;
    const x = style.textAlign === 'left'
      ? bounds.left + fontSize * 0.4
      : style.textAlign === 'right'
        ? bounds.right - fontSize * 0.4 - lineWidth
        : bounds.left + (bounds.width - lineWidth) / 2;
    context.fillText(line, x, firstY + index * lineHeight);
  }
}

function drawVerticalText(context, value, bounds, style) {
  const fontSize = style.fontSize * Math.max(1, context.canvas.width / 760);
  const lineHeight = fontSize * 1.1;
  const columnWidth = fontSize * 1.15;
  const rows = Math.max(1, Math.floor((bounds.height - fontSize * 0.4) / lineHeight));
  const characters = Array.from(String(value || '').replaceAll('\n', ''));
  const columns = Math.max(1, Math.ceil(characters.length / rows));
  for (const [index, character] of characters.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = bounds.right - columnWidth * (column + 0.5);
    const y = bounds.top + fontSize * 0.3 + row * lineHeight;
    context.fillText(character, x - context.measureText(character).width / 2, y + fontSize / 2);
  }
}

function wrapText(context, value, maxWidth) {
  const lines = [];
  for (const originalLine of value.split(/\r?\n/)) {
    let line = '';
    for (const character of Array.from(originalLine)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line || ' ');
  }
  return lines.length ? lines : [' '];
}

function getBounds(value, width, height) {
  const polygon = typeof value === 'string' ? parseJson(value, []) : value;
  if (!Array.isArray(polygon)) return null;
  const points = polygon
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return null;
  const xs = points.map((point) => Math.min(1, Math.max(0, point.x)) * width);
  const ys = points.map((point) => Math.min(1, Math.max(0, point.y)) * height);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys)));
  return { left, top, right, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function normalizeStyle(value) {
  const style = typeof value === 'string' ? parseJson(value, {}) : (value || {});
  const fontSize = Number(style.fontSize);
  return {
    fontSize: Number.isFinite(fontSize) ? Math.min(96, Math.max(8, fontSize)) : 24,
    color: /^#[0-9a-f]{6}$/i.test(String(style.color || '')) ? String(style.color) : '#ffffff',
    background: /^rgba?\([0-9.,% ]+\)$/.test(String(style.background || '')) ? String(style.background) : 'rgba(20, 14, 25, 0.72)',
    writingMode: ['vertical-rl', 'horizontal-tb'].includes(style.writingMode) ? style.writingMode : 'vertical-rl',
    textAlign: ['center', 'left', 'right'].includes(style.textAlign) ? style.textAlign : 'center',
    fontWeight: ['400', '600', '700'].includes(String(style.fontWeight)) ? String(style.fontWeight) : '600',
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function registerFont(fontPath, fontFamily) {
  const path = fontPath || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\malgun.ttf' : '');
  if (!path || registeredFonts.has(path) || !fs.existsSync(path)) return;
  if (GlobalFonts.registerFromPath(path, fontFamily)) registeredFonts.add(path);
}

function readPixel(data, offset) {
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function writePixel(data, offset, pixel) {
  data[offset] = pixel[0];
  data[offset + 1] = pixel[1];
  data[offset + 2] = pixel[2];
  data[offset + 3] = pixel[3];
}

function averagePixel(left, right) {
  return [
    Math.round((left[0] + right[0]) / 2),
    Math.round((left[1] + right[1]) / 2),
    Math.round((left[2] + right[2]) / 2),
    Math.round((left[3] + right[3]) / 2),
  ];
}

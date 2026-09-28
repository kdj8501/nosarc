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
  const original = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowOffset + x]) continue;
      const horizontal = interpolateSamples(
        findMaskBoundary(original, mask, width, height, x, y, -1, 0),
        findMaskBoundary(original, mask, width, height, x, y, 1, 0),
      );
      const vertical = interpolateSamples(
        findMaskBoundary(original, mask, width, height, x, y, 0, -1),
        findMaskBoundary(original, mask, width, height, x, y, 0, 1),
      );
      const fill = horizontal && vertical
        ? averagePixel(horizontal, vertical)
        : horizontal || vertical || [255, 255, 255, 255];
      writePixel(data, (rowOffset + x) * 4, fill);
    }
  }
}

function findMaskBoundary(data, mask, width, height, x, y, deltaX, deltaY) {
  let sampleX = x + deltaX;
  let sampleY = y + deltaY;
  let distance = 1;
  while (sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height) {
    if (!mask[sampleY * width + sampleX]) {
      return { pixel: readPixel(data, (sampleY * width + sampleX) * 4), distance };
    }
    sampleX += deltaX;
    sampleY += deltaY;
    distance += 1;
  }
  return null;
}

function interpolateSamples(negative, positive) {
  if (!negative) return positive?.pixel || null;
  if (!positive) return negative.pixel;
  const negativeWeight = positive.distance / (negative.distance + positive.distance);
  const positiveWeight = negative.distance / (negative.distance + positive.distance);
  return negative.pixel.map((value, index) => Math.round(value * negativeWeight + positive.pixel[index] * positiveWeight));
}

function drawLettering(context, layer, width, height, fontFamily) {
  const bounds = getBounds(layer.polygon_json || layer.polygon, width, height);
  if (!bounds) return;
  const style = normalizeStyle(layer.style_json || layer.style);
  context.save();
  context.beginPath();
  context.rect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.clip();
  context.fillStyle = style.background;
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.fillStyle = style.color;
  context.textBaseline = 'middle';
  const baseFontSize = Math.max(8, style.fontSize * Math.max(1, width / 760));
  if (style.writingMode === 'vertical-rl') drawVerticalText(context, layer.text, bounds, style, fontFamily, baseFontSize);
  else drawHorizontalText(context, layer.text, bounds, style, fontFamily, baseFontSize);
  context.restore();
}

function drawHorizontalText(context, value, bounds, style, fontFamily, baseFontSize) {
  const inset = Math.max(1, Math.min(bounds.width, bounds.height) * 0.08);
  const maxWidth = Math.max(1, bounds.width - inset * 2);
  const maxHeight = Math.max(1, bounds.height - inset * 2);
  let fontSize = baseFontSize;
  let lines = [' '];
  while (fontSize > 4) {
    context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    lines = wrapText(context, String(value || ''), maxWidth);
    if (lines.length * fontSize * 1.15 <= maxHeight && lines.every((line) => context.measureText(line).width <= maxWidth)) break;
    fontSize = Math.max(4, fontSize - 1);
  }
  context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
  lines = wrapText(context, String(value || ''), maxWidth);
  const lineHeight = fontSize * 1.15;
  const totalHeight = lines.length * lineHeight;
  const firstY = bounds.top + (bounds.height - totalHeight) / 2 + lineHeight / 2;
  for (const [index, line] of lines.entries()) {
    const lineWidth = context.measureText(line).width;
    const x = style.textAlign === 'left'
      ? bounds.left + inset
      : style.textAlign === 'right'
        ? bounds.right - inset - lineWidth
        : bounds.left + (bounds.width - lineWidth) / 2;
    context.fillText(line, x, firstY + index * lineHeight);
  }
}

function drawVerticalText(context, value, bounds, style, fontFamily, baseFontSize) {
  const inset = Math.max(1, Math.min(bounds.width, bounds.height) * 0.08);
  const maxWidth = Math.max(1, bounds.width - inset * 2);
  const maxHeight = Math.max(1, bounds.height - inset * 2);
  const characters = Array.from(String(value || '').replaceAll('\n', ''));
  let fontSize = baseFontSize;
  let rows = 1;
  let columns = Math.max(1, characters.length);
  while (fontSize > 4) {
    rows = Math.max(1, Math.floor(maxHeight / (fontSize * 1.1)));
    columns = Math.max(1, Math.ceil(characters.length / rows));
    if (columns * fontSize * 1.15 <= maxWidth) break;
    fontSize = Math.max(4, fontSize - 1);
  }
  rows = Math.max(1, Math.floor(maxHeight / (fontSize * 1.1)));
  context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
  const lineHeight = fontSize * 1.1;
  const columnWidth = fontSize * 1.15;
  for (const [index, character] of characters.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = bounds.right - inset - columnWidth * (column + 0.5);
    const y = bounds.top + inset + row * lineHeight;
    context.fillText(character, x - context.measureText(character).width / 2, y + fontSize / 2);
  }
}

function wrapText(context, value, maxWidth) {
  const lines = [];
  for (const originalLine of value.split(/\r?\n/)) {
    let line = '';
    const appendWord = (word) => {
      for (const character of Array.from(word)) {
        if (line && context.measureText(line + character).width > maxWidth) {
          lines.push(line.trimEnd());
          line = character;
        } else {
          line += character;
        }
      }
    };
    for (const token of originalLine.match(/\s+|[^\s]+/gu) || []) {
      if (/^\s+$/u.test(token)) {
        if (line) line += token;
        continue;
      }
      if (line && context.measureText(line + token).width > maxWidth) {
        lines.push(line.trimEnd());
        line = '';
      }
      appendWord(token);
    }
    lines.push(line.trimEnd() || ' ');
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

import * as canvas from '@napi-rs/canvas';
import fs from 'node:fs';

const { createCanvas, loadImage, GlobalFonts } = canvas;
const registeredFonts = new Set();
const CLOSING_PUNCTUATION = new Set(Array.from('、。，．！？：；）〕］｝〉》」』】〙〗〟’”!?.,:;)]}"\'…'));
const OPENING_PUNCTUATION = new Set(Array.from('（〔［｛〈《「『【〘〖〝‘“([{"\''));

export async function renderTranslatedPage(sourcePath, layers, {
  inpaintPadding = 0.12,
  fontFamily = 'Malgun Gothic',
  fontPath = '',
  skipInpaint = false,
  onInpaintProgress = () => {},
} = {}) {
  registerFont(fontPath, fontFamily);
  const image = await loadImage(sourcePath);
  const width = image.width;
  const height = image.height;
  const output = createCanvas(width, height);
  const context = output.getContext('2d');
  context.drawImage(image, 0, 0, width, height);

  const safeLayers = layers.filter(isRenderableLetteringLayer);
  if (!skipInpaint) {
    const imageData = context.getImageData(0, 0, width, height);
    const maskImage = createMaskCanvas(width, height, safeLayers, inpaintPadding, imageData.data);
    const maskPixels = maskImage.getContext('2d').getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = maskPixels[pixel * 4] > 0 ? 1 : 0;
    await inpaint(imageData, mask, width, height, onInpaintProgress);
    context.putImageData(imageData, 0, 0);
  }

  for (const layer of safeLayers) drawLettering(context, layer, width, height, fontFamily);
  return output.toBuffer('image/png');
}

export async function createInpaintMask(sourcePath, layers, { inpaintPadding = 0.12 } = {}) {
  const image = await loadImage(sourcePath);
  const sourceCanvas = createCanvas(image.width, image.height);
  const sourceContext = sourceCanvas.getContext('2d');
  sourceContext.drawImage(image, 0, 0, image.width, image.height);
  const imagePixels = sourceContext.getImageData(0, 0, image.width, image.height).data;
  const safeLayers = layers.filter(isRenderableLetteringLayer);
  return createMaskCanvas(image.width, image.height, safeLayers, inpaintPadding, imagePixels).toBuffer('image/png');
}

export function isRenderableLetteringLayer(layer) {
  if (!String(layer?.text || '').trim()) return false;
  const value = layer.polygon_json || layer.polygon;
  const polygon = typeof value === 'string' ? parseJson(value, []) : value;
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const points = polygon.map((point) => ({
    x: Number(Array.isArray(point) ? point[0] : point?.x),
    y: Number(Array.isArray(point) ? point[1] : point?.y),
  }));
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return false;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys);
}

function createMaskCanvas(width, height, layers, padding, imagePixels = null) {
  const maskCanvas = createCanvas(width, height);
  const context = maskCanvas.getContext('2d');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ffffff';
  context.lineJoin = 'round';
  context.lineCap = 'round';
  const paddingRatio = Math.min(0.24, Math.max(0, Number(padding) || 0));
  for (const layer of layers) {
    const polygons = [...getInpaintPolygons(layer)];
    const sourcePolygon = getSourcePolygon(layer);
    if (sourcePolygon && (hasConfidentBalloonBox(layer, sourcePolygon) || hasLightUniformBackground(
      sourcePolygon,
      getInpaintPolygons(layer),
      width,
      height,
      imagePixels,
    ))) {
      polygons.push(sourcePolygon);
    }
    for (const polygon of polygons) {
      const points = polygon
        .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length < 3) continue;
      const pixelPoints = points.map((point) => ({
        x: Math.min(width, Math.max(0, point.x * width)),
        y: Math.min(height, Math.max(0, point.y * height)),
      }));
      const xs = pixelPoints.map((point) => point.x);
      const ys = pixelPoints.map((point) => point.y);
      const pad = Math.max(2, Math.round(Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * paddingRatio));
      context.beginPath();
      context.moveTo(pixelPoints[0].x, pixelPoints[0].y);
      for (const point of pixelPoints.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fill();
      if (pad > 0) {
        context.lineWidth = pad * 2;
        context.stroke();
      }
    }
  }
  return maskCanvas;
}

function getInpaintPolygons(layer) {
  const value = layer.inpaint_mask_json || layer.inpaintMask;
  const parsed = typeof value === 'string' ? parseJson(value, []) : value;
  if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) return parsed;
  const fallback = getSourcePolygon(layer) || layer.polygon_json || layer.polygon;
  const polygon = typeof fallback === 'string' ? parseJson(fallback, []) : fallback;
  return Array.isArray(polygon) ? [polygon] : [];
}

function getSourcePolygon(layer) {
  const value = layer.source_polygon_json;
  if (!value) return null;
  const polygon = typeof value === 'string' ? parseJson(value, []) : value;
  return Array.isArray(polygon) && polygon.length >= 3 ? polygon : null;
}

function hasConfidentBalloonBox(layer, sourcePolygon) {
  const layout = typeof layer.source_layout_hint_json === 'string'
    ? parseJson(layer.source_layout_hint_json, {})
    : layer.source_layout_hint_json || {};
  const sourceArea = polygonBoundsArea(sourcePolygon);
  const balloonArea = polygonBoundsArea(layout.letteringPolygon);
  return sourceArea > 0 && balloonArea > 0 && balloonArea <= sourceArea * 10;
}

function hasLightUniformBackground(sourcePolygon, glyphPolygons, width, height, pixels) {
  if (!pixels) return false;
  const points = sourcePolygon
    .map((point) => ({ x: Number(point?.x) * width, y: Number(point?.y) * height }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return false;
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y))));
  const shortSide = Math.min(right - left, bottom - top);
  if (shortSide < 10) return false;
  const band = Math.max(2, Math.round(shortSide * 0.16));
  const scaledGlyphs = glyphPolygons.map((polygon) => polygon
    .map((point) => ({ x: Number(point?.x) * width, y: Number(point?.y) * height }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    .filter((polygon) => polygon.length >= 3);
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let bright = 0;
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      if (x - left >= band && right - 1 - x >= band && y - top >= band && bottom - 1 - y >= band) continue;
      if (scaledGlyphs.some((polygon) => pointInPolygon(x + 0.5, y + 0.5, polygon))) continue;
      const offset = (y * width + x) * 4;
      const luminance = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
      count += 1;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (luminance >= 230) bright += 1;
    }
  }
  if (count < 12) return false;
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  // Manga balloon interiors often contain halftone and antialiasing. A strict
  // near-white cutoff leaves original glyph fragments behind after inpainting.
  return mean >= 238 && deviation <= 45 && bright / count >= 0.82;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const left = polygon[current];
    const right = polygon[previous];
    if (((left.y > y) !== (right.y > y))
      && x < ((right.x - left.x) * (y - left.y)) / (right.y - left.y) + left.x) inside = !inside;
  }
  return inside;
}

function polygonBoundsArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  const points = polygon
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return 0;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return Math.max(0, Math.max(...xs) - Math.min(...xs)) * Math.max(0, Math.max(...ys) - Math.min(...ys));
}

async function inpaint(imageData, mask, width, height, onProgress) {
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
    if (y % 16 === 15 || y === height - 1) {
      if (y % 64 === 63 || y === height - 1) {
        onProgress((y + 1) / height);
      }
      await new Promise((resolve) => setImmediate(resolve));
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
  if (Math.abs(style.rotation) > 0.1) {
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    context.translate(centerX, centerY);
    context.rotate(style.rotation * Math.PI / 180);
    context.translate(-centerX, -centerY);
  }
  context.beginPath();
  context.rect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.clip();
  context.fillStyle = style.background;
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.fillStyle = style.color;
  context.textBaseline = 'middle';
  const fontScale = Math.max(1, width / 760);
  const drawStyle = { ...style, outlineWidth: style.outlineWidth * fontScale };
  const baseFontSize = Math.max(8, style.fontSize * fontScale);
  if (drawStyle.writingMode === 'vertical-rl') drawVerticalText(context, layer.text, bounds, drawStyle, fontFamily, baseFontSize);
  else drawHorizontalText(context, layer.text, bounds, drawStyle, fontFamily, baseFontSize);
  context.restore();
}

function drawHorizontalText(context, value, bounds, style, fontFamily, baseFontSize) {
  const inset = Math.max(1, Math.min(bounds.width, bounds.height) * 0.08);
  const maxWidth = Math.max(1, bounds.width - inset * 2);
  const maxHeight = Math.max(1, bounds.height - inset * 2);
  const minimumFontSize = 7;
  let fontSize = baseFontSize;
  let lines = [' '];
  while (fontSize > minimumFontSize) {
    context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    lines = style.balanceLines
      ? wrapTextBalanced(context, String(value || ''), maxWidth)
      : wrapText(context, String(value || ''), maxWidth);
    if (lines.length * fontSize * 1.1 <= maxHeight && lines.every((line) => context.measureText(line).width <= maxWidth)) break;
    fontSize = Math.max(minimumFontSize, fontSize - 1);
  }
  context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
  lines = style.balanceLines
    ? wrapTextBalanced(context, String(value || ''), maxWidth)
    : wrapText(context, String(value || ''), maxWidth);
  if (lines.length * fontSize * 1.1 > maxHeight || lines.some((line) => context.measureText(line).width > maxWidth)) {
    throw new Error('식자 영역이 좁아 글자를 읽을 크기로 배치할 수 없습니다. 말풍선 영역이나 문구를 조정해 주세요.');
  }
  const lineHeight = fontSize * 1.1;
  const totalHeight = lines.length * lineHeight;
  const firstY = bounds.top + (bounds.height - totalHeight) / 2 + lineHeight / 2;
  for (const [index, line] of lines.entries()) {
    const lineWidth = context.measureText(line).width;
    const x = style.textAlign === 'left'
      ? bounds.left + inset
      : style.textAlign === 'right'
      ? bounds.right - inset - lineWidth
      : bounds.left + (bounds.width - lineWidth) / 2;
    drawTextWithOutline(context, line, x, firstY + index * lineHeight, style.color, fontSize, style);
  }
}

function drawVerticalText(context, value, bounds, style, fontFamily, baseFontSize) {
  const inset = Math.max(1, Math.min(bounds.width, bounds.height) * 0.08);
  const maxWidth = Math.max(1, bounds.width - inset * 2);
  const maxHeight = Math.max(1, bounds.height - inset * 2);
  const characters = Array.from(String(value || '').replaceAll('\n', ''));
  const minimumFontSize = 7;
  let fontSize = baseFontSize;
  let rows = 1;
  let columns = Math.max(1, characters.length);
  while (fontSize > minimumFontSize) {
    rows = Math.max(1, Math.floor(maxHeight / (fontSize * 1.1)));
    columns = Math.max(1, Math.ceil(characters.length / rows));
    if (columns * fontSize * 1.15 <= maxWidth) break;
    fontSize = Math.max(minimumFontSize, fontSize - 1);
  }
  rows = Math.max(1, Math.floor(maxHeight / (fontSize * 1.1)));
  columns = Math.max(1, Math.ceil(characters.length / rows));
  if (fontSize * 1.1 > maxHeight || columns * fontSize * 1.15 > maxWidth) {
    throw new Error('식자 영역이 좁아 글자를 읽을 크기로 배치할 수 없습니다. 말풍선 영역이나 문구를 조정해 주세요.');
  }
  context.font = `${style.fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
  const lineHeight = fontSize * 1.1;
  const columnWidth = fontSize * 1.15;
  for (const [index, character] of characters.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = bounds.right - inset - columnWidth * (column + 0.5);
    const y = bounds.top + inset + row * lineHeight;
    drawTextWithOutline(context, character, x - context.measureText(character).width / 2, y + fontSize / 2, style.color, fontSize, style);
  }
}

function drawTextWithOutline(context, text, x, y, color, fontSize, style = {}) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1] || '21121a';
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  const requestedOutlineWidth = Number(style.outlineWidth);
  const outlineWidth = Number.isFinite(requestedOutlineWidth)
    ? Math.min(6, Math.max(0, requestedOutlineWidth))
    : Math.min(2, fontSize * 0.07);
  if (outlineWidth > 0) {
    context.lineJoin = 'round';
    context.lineWidth = Math.max(0.8, outlineWidth);
    context.strokeStyle = style.outlineColor
      ? hexToRgba(style.outlineColor, style.outlineColor === '#ffffff' ? 0.92 : 0.78)
      : luminance >= 145 ? 'rgba(25, 18, 27, 0.78)' : 'rgba(255, 255, 255, 0.92)';
    context.strokeText(text, x, y);
  }
  context.fillStyle = color;
  context.fillText(text, x, y);
}

function wrapText(context, value, maxWidth) {
  const lines = [];
  for (const originalLine of value.split(/\r?\n/)) {
    let line = '';
    const pushLine = () => {
      const trimmedLine = line.trimEnd();
      const characters = Array.from(trimmedLine);
      const lastCharacter = characters.at(-1) || '';
      if (OPENING_PUNCTUATION.has(lastCharacter) && characters.length > 1) {
        characters.pop();
        lines.push(characters.join('').trimEnd());
        line = lastCharacter;
      } else {
        lines.push(trimmedLine);
        line = '';
      }
    };
    const appendWord = (word) => {
      for (const character of Array.from(word)) {
        if (line && context.measureText(line + character).width > maxWidth) {
          if (CLOSING_PUNCTUATION.has(character)) {
            line = `${line.trimEnd()}${character}`;
            continue;
          }
          const trimmedLine = line.trimEnd();
          const lastCharacter = Array.from(trimmedLine).at(-1) || '';
          if (OPENING_PUNCTUATION.has(lastCharacter)) {
            const preceding = Array.from(trimmedLine);
            const opening = preceding.pop();
            if (preceding.length) lines.push(preceding.join('').trimEnd());
            line = opening + character;
            continue;
          }
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
        pushLine();
      }
      appendWord(token);
    }
    lines.push(line.trimEnd() || ' ');
  }
  return lines.length ? lines : [' '];
}

function wrapTextBalanced(context, value, maxWidth) {
  const lines = [];
  for (const paragraph of String(value || '').split(/\r?\n/u)) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (words.length < 2 || words.some((word) => context.measureText(word).width > maxWidth)) {
      lines.push(...wrapText(context, paragraph, maxWidth));
      continue;
    }

    const costs = Array(words.length + 1).fill(Number.POSITIVE_INFINITY);
    const nextWord = Array(words.length).fill(-1);
    costs[words.length] = 0;
    for (let start = words.length - 1; start >= 0; start -= 1) {
      let line = '';
      for (let end = start; end < words.length; end += 1) {
        line = line ? `${line} ${words[end]}` : words[end];
        const lineWidth = context.measureText(line).width;
        if (lineWidth > maxWidth) break;
        if (end < words.length - 1 && !canBreakAfterWord(words[end], words[end + 1])) continue;
        if (!Number.isFinite(costs[end + 1])) continue;

        const remainingWidth = Math.max(0, maxWidth - lineWidth) / maxWidth;
        const finalLineWeight = end === words.length - 1 ? 0.3 : 1;
        const shortWordPenalty = end < words.length - 1 && Array.from(words[end]).length === 1 ? 0.08 : 0;
        const lineCost = remainingWidth ** 2 * finalLineWeight + shortWordPenalty + (end < words.length - 1 ? 0.015 : 0);
        const candidateCost = lineCost + costs[end + 1];
        if (candidateCost < costs[start]) {
          costs[start] = candidateCost;
          nextWord[start] = end + 1;
        }
      }
    }

    if (nextWord[0] < 0) {
      lines.push(...wrapText(context, paragraph, maxWidth));
      continue;
    }
    for (let start = 0; start < words.length;) {
      const end = nextWord[start];
      if (end <= start) break;
      lines.push(words.slice(start, end).join(' '));
      start = end;
    }
  }
  return lines.length ? lines : [' '];
}

function canBreakAfterWord(previous, next) {
  const lastCharacter = Array.from(previous).at(-1) || '';
  const firstCharacter = Array.from(next)[0] || '';
  return !OPENING_PUNCTUATION.has(lastCharacter) && !CLOSING_PUNCTUATION.has(firstCharacter);
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
  const savedBackground = /^rgba?\([0-9.,% ]+\)$/.test(String(style.background || ''))
    ? String(style.background)
    : 'rgba(255, 255, 255, 0)';
  return {
    fontSize: Number.isFinite(fontSize) ? Math.min(96, Math.max(8, fontSize)) : 24,
    color: /^#[0-9a-f]{6}$/i.test(String(style.color || '')) ? String(style.color) : '#21121a',
    background: savedBackground === 'rgba(255, 255, 255, 0.92)' ? 'rgba(255, 255, 255, 0)' : savedBackground,
    writingMode: ['vertical-rl', 'horizontal-tb'].includes(style.writingMode) ? style.writingMode : 'vertical-rl',
    textAlign: ['center', 'left', 'right'].includes(style.textAlign) ? style.textAlign : 'center',
    fontWeight: ['400', '600', '700'].includes(String(style.fontWeight)) ? String(style.fontWeight) : '600',
    rotation: Number.isFinite(Number(style.rotation)) ? Math.min(45, Math.max(-45, Number(style.rotation))) : 0,
    outlineWidth: Number.isFinite(Number(style.outlineWidth)) ? Math.min(6, Math.max(0, Number(style.outlineWidth))) : 1.4,
    outlineColor: /^#[0-9a-f]{6}$/i.test(String(style.outlineColor || '')) ? String(style.outlineColor) : '',
    balanceLines: style.balanceLines === true,
    soundEffect: style.soundEffect === true,
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hexToRgba(value, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value || ''))?.[1];
  if (!hex) return `rgba(255, 255, 255, ${alpha})`;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
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

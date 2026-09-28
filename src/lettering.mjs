const KOREAN_LANGUAGE = /^(?:ko|kor)(?:[-_]|$)/i;
const HANGUL = /[\uac00-\ud7af]/g;
const HAS_HANGUL = /[\uac00-\ud7af]/;

export function autoLetteringStyle(block, translatedText = '', targetLanguage = '', contentKind = '') {
  const polygon = parsePolygon(block?.polygon_json);
  const points = polygon.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const layout = parseObject(block?.layoutHint ?? block?.layout_hint_json);
  const language = String(targetLanguage || '').trim();
  const text = String(translatedText || '').trim();
  const korean = KOREAN_LANGUAGE.test(language) || HAS_HANGUL.test(text);
  const hangulCount = (text.match(HANGUL) || []).length;
  const soundEffect = contentKind === 'sound_effect'
    || (contentKind !== 'dialogue' && contentKind !== 'caption' && looksLikeJapaneseSoundEffect(block?.source_text));

  const sourceBox = polygonDimensions(points);
  const balloonPoints = parsePolygon(layout.letteringPolygon)
    .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const fitBox = !soundEffect && balloonPoints.length >= 3 ? polygonDimensions(balloonPoints) : sourceBox;
  const width = sourceBox.width;
  const height = sourceBox.height;

  // Use horizontal Korean for ordinary text, while preserving vertical flow for
  // very short captions and vertically designed sound effects.
  const tinyVerticalCaption = korean && width > 0 && height > width * 4.5 && hangulCount <= 2;
  const sourceVertical = layout.vertical === true;
  const preserveVertical = (soundEffect && sourceVertical) || tinyVerticalCaption;
  const writingMode = korean
    ? preserveVertical ? 'vertical-rl' : 'horizontal-tb'
    : sourceVertical || height > width * 1.25 ? 'vertical-rl' : 'horizontal-tb';
  const sourceColor = String(layout.foregroundColor || '');
  const sourceRotation = Number(layout.rotation);
  const color = soundEffect && /^#[0-9a-f]{6}$/i.test(sourceColor) ? sourceColor : '#21121a';

  return {
    color,
    outlineColor: soundEffect ? contrastingOutline(color) : '',
    background: 'rgba(255, 255, 255, 0)',
    writingMode,
    fontSize: Math.round(Math.min(32, estimateFontSize(block, text, fitBox.width, fitBox.height) * (soundEffect ? 1.12 : 1))),
    fontWeight: soundEffect ? '700' : '600',
    outlineWidth: soundEffect ? 2.6 : 1.2,
    rotation: soundEffect && Number.isFinite(sourceRotation) ? Math.min(45, Math.max(-45, sourceRotation)) : 0,
    soundEffect,
  };
}

function polygonDimensions(points) {
  if (!points.length) return { width: 0, height: 0 };
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function looksLikeJapaneseSoundEffect(value) {
  const source = String(value || '').trim().replace(/[\s「」『』（）()[\]【】、。，．！？!?…〜～・]/gu, '');
  const characters = Array.from(source);
  if (characters.length < 2 || characters.length > 12) return false;
  const katakana = characters.filter((character) => /\p{Script=Katakana}/u.test(character)).length;
  return katakana >= 2 && katakana / characters.length >= 0.65;
}

function contrastingOutline(color) {
  const channels = color.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16)) || [33, 18, 26];
  const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
  return luminance >= 145 ? '#19121b' : '#ffffff';
}

function estimateFontSize(block, text, boxWidthRatio, boxHeightRatio) {
  if (!(boxWidthRatio > 0) || !(boxHeightRatio > 0)) return 20;
  const pageWidth = Number(block?.width);
  const pageHeight = Number(block?.height);
  const referenceWidth = pageWidth > 0 ? Math.min(760, pageWidth) : 760;
  const width = Math.max(1, boxWidthRatio * referenceWidth);
  const height = Math.max(1, boxHeightRatio * (pageWidth > 0 && pageHeight > 0
    ? pageHeight * referenceWidth / pageWidth
    : referenceWidth));
  const glyphCount = Math.max(1, Array.from(text).filter((character) => !/\s/u.test(character)).length);
  const areaPerGlyph = width * height / glyphCount;
  return Math.round(Math.min(28, Math.max(13, Math.sqrt(areaPerGlyph) * 0.72)));
}

function parsePolygon(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

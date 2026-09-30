const KOREAN_LANGUAGE = /^(?:ko|kor)(?:[-_]|$)/i;
const HANGUL = /[\uac00-\ud7af]/g;
const HAS_HANGUL = /[\uac00-\ud7af]/;
// Korean rewrites need extra space, but loose balloon boxes can overlap art.
// Keep the automatically selected expansion modest and bounded on each axis.
const MAX_BALLOON_AREA_RATIO = 2.5;
const MAX_BALLOON_WIDTH_RATIO = 1.8;
const MAX_BALLOON_HEIGHT_RATIO = 1.6;
const MAX_BRIGHT_BALLOON_AREA_RATIO = 5;

export function autoLetteringStyle(block, translatedText = '', targetLanguage = '', contentKind = '') {
  const polygon = parsePolygon(block?.polygon_json);
  const points = polygon.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const layout = parseObject(block?.layoutHint ?? block?.layout_hint_json);
  const language = String(targetLanguage || '').trim();
  const text = String(translatedText || '').trim();
  const korean = KOREAN_LANGUAGE.test(language) || HAS_HANGUL.test(text);
  const soundEffect = contentKind === 'sound_effect'
    || (contentKind !== 'dialogue' && contentKind !== 'caption' && looksLikeJapaneseSoundEffect(block?.source_text));

  const sourceBox = polygonDimensions(points);
  const balloonPoints = parsePolygon(layout.letteringPolygon)
    .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const balloonBox = polygonDimensions(balloonPoints);
  const useBalloonBox = !soundEffect && isPlausibleBalloonBox(sourceBox, balloonBox);
  const sourceArea = sourceBox.width * sourceBox.height;
  const balloonArea = balloonBox.width * balloonBox.height;
  const hasBrightBalloonCandidate = balloonPoints.length >= 3
    && sourceArea > 0
    && balloonArea <= sourceArea * MAX_BRIGHT_BALLOON_AREA_RATIO;
  const fitBox = useBalloonBox ? balloonBox : sourceBox;
  const width = sourceBox.width;
  const height = sourceBox.height;
  const pageWidth = Number(block?.width);
  const pageHeight = Number(block?.height);
  const regionAspectRatio = width > 0
    ? (height * (pageHeight > 0 ? pageHeight : 1)) / (width * (pageWidth > 0 ? pageWidth : 1))
    : 0;

  // Use horizontal Korean in ordinary bubbles, but keep narrow, tall source
  // columns vertical so one glyph per line does not make long text unreadable.
  const sourceVertical = layout.vertical === true;
  const preserveVertical = sourceVertical && (soundEffect || (korean && regionAspectRatio > 2.4));
  const writingMode = korean
    ? preserveVertical ? 'vertical-rl' : 'horizontal-tb'
    : sourceVertical || regionAspectRatio > 1.25 ? 'vertical-rl' : 'horizontal-tb';
  const sourceColor = String(layout.foregroundColor || '');
  const sourceRotation = Number(layout.rotation);
  // The detector can mistake bright pixels inside its text mask for the ink
  // color. A confidently enclosed white balloon should use readable dark ink.
  const sourceColorIsBright = /^#[0-9a-f]{6}$/i.test(sourceColor) && colorLuminance(sourceColor) >= 210;
  const backgroundLuminance = layout.backgroundLuminance == null ? Number.NaN : Number(layout.backgroundLuminance);
  const hasBackgroundEstimate = Number.isFinite(backgroundLuminance) && backgroundLuminance >= 0 && backgroundLuminance <= 255;
  const correctedInk = !soundEffect && (hasBrightBalloonCandidate || sourceColorIsBright);
  const color = hasBackgroundEstimate && !soundEffect
    ? backgroundLuminance < 128 ? '#ffffff' : '#21121a'
    : correctedInk
      ? '#21121a'
      : /^#[0-9a-f]{6}$/i.test(sourceColor) ? sourceColor : '#21121a';
  const outlineColor = hasBackgroundEstimate || hasBrightBalloonCandidate || !correctedInk
    ? contrastingOutline(color)
    : '#ffffff';
  const correctedBrightInk = !hasBackgroundEstimate && correctedInk && sourceColorIsBright && !hasBrightBalloonCandidate;

  return {
    color,
    outlineColor,
    background: 'rgba(255, 255, 255, 0)',
    writingMode,
    fontSize: Math.round(Math.min(32, estimateFontSize(block, text, fitBox.width, fitBox.height) * (soundEffect ? 1.12 : 1))),
    fontWeight: soundEffect ? '700' : '600',
    outlineWidth: soundEffect ? 2.6 : correctedBrightInk || colorLuminance(color) >= 145 ? 1.1 : 0,
    rotation: soundEffect && Number.isFinite(sourceRotation) ? Math.min(45, Math.max(-45, sourceRotation)) : 0,
    balanceLines: korean,
    soundEffect,
  };
}

export function automaticLetteringPolygon(block) {
  const source = parsePolygon(block?.polygon_json ?? block?.polygon);
  const layout = parseObject(block?.layoutHint ?? block?.layout_hint_json);
  const candidate = parsePolygon(layout.letteringPolygon);
  return isPlausibleBalloonBox(polygonDimensions(source), polygonDimensions(candidate))
    ? candidate
    : source;
}

function isPlausibleBalloonBox(sourceBox, balloonBox) {
  const sourceArea = sourceBox.width * sourceBox.height;
  const balloonArea = balloonBox.width * balloonBox.height;
  if (!(sourceArea > 0 && balloonArea > 0)) return false;
  if (balloonArea > sourceArea * MAX_BALLOON_AREA_RATIO) return false;
  if (balloonBox.width > sourceBox.width * MAX_BALLOON_WIDTH_RATIO) return false;
  if (balloonBox.height > sourceBox.height * MAX_BALLOON_HEIGHT_RATIO) return false;
  return true;
}

export function inferLetteringContentKind(block, preferredKind = '') {
  const preferred = String(preferredKind || '').trim().toLowerCase();
  if (['dialogue', 'caption', 'sound_effect'].includes(preferred)) return preferred;
  return looksLikeJapaneseSoundEffect(block?.source_text) ? 'sound_effect' : 'dialogue';
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
  return colorLuminance(color) >= 145 ? '#19121b' : '#ffffff';
}

function colorLuminance(color) {
  const channels = color.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16)) || [33, 18, 26];
  return (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
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

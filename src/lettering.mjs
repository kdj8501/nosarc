const KOREAN_LANGUAGE = /^(?:ko|kor)(?:[-_]|$)/i;
const HANGUL = /[\uac00-\ud7af]/g;
const HAS_HANGUL = /[\uac00-\ud7af]/;

export function autoLetteringStyle(block, translatedText = '', targetLanguage = '') {
  const polygon = parsePolygon(block?.polygon_json);
  const points = polygon.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const language = String(targetLanguage || '').trim();
  const text = String(translatedText || '').trim();
  const korean = KOREAN_LANGUAGE.test(language) || HAS_HANGUL.test(text);
  const hangulCount = (text.match(HANGUL) || []).length;

  let width = 0;
  let height = 0;
  if (points.length) {
    const xs = points.map((point) => Number(point.x));
    const ys = points.map((point) => Number(point.y));
    width = Math.max(...xs) - Math.min(...xs);
    height = Math.max(...ys) - Math.min(...ys);
  }

  // Korean reads naturally left-to-right; retain vertical layout only for tiny
  // captions in extremely narrow regions where horizontal text cannot fit.
  const tinyVerticalCaption = korean && width > 0 && height > width * 4.5 && hangulCount <= 2;
  const writingMode = korean && !tinyVerticalCaption
    ? 'horizontal-tb'
    : height > width * 1.25 ? 'vertical-rl' : 'horizontal-tb';

  return {
    color: '#21121a',
    background: 'rgba(255, 255, 255, 0)',
    writingMode,
    fontSize: estimateFontSize(block, text, width, height),
  };
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

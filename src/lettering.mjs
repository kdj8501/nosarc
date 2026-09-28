const KOREAN_LANGUAGE = /^(?:ko|kor)(?:[-_]|$)/i;
const HANGUL = /[\uac00-\ud7af]/g;

export function autoLetteringStyle(block, translatedText = '', targetLanguage = '') {
  const polygon = parsePolygon(block?.polygon_json);
  const points = polygon.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  const language = String(targetLanguage || '').trim();
  const korean = KOREAN_LANGUAGE.test(language) || HANGUL.test(String(translatedText));
  HANGUL.lastIndex = 0;
  const hangulCount = (String(translatedText).match(HANGUL) || []).length;

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
    background: 'rgba(255, 255, 255, 0.92)',
    writingMode,
    fontSize: writingMode === 'vertical-rl' ? 22 : 20,
  };
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

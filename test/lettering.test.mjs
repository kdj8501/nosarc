import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLetteringStyle, automaticLetteringPolygon } from '../src/lettering.mjs';

const tallVerticalBlock = {
  polygon_json: JSON.stringify([
    { x: 0.4, y: 0.1 }, { x: 0.6, y: 0.1 },
    { x: 0.6, y: 0.9 }, { x: 0.4, y: 0.9 },
  ]),
  layout_hint_json: JSON.stringify({ vertical: true }),
};

test('Korean dialogue stays horizontal in a reasonably wide speech region', () => {
  const block = {
    polygon_json: JSON.stringify([
      { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 },
      { x: 0.7, y: 0.6 }, { x: 0.3, y: 0.6 },
    ]),
    layout_hint_json: JSON.stringify({ vertical: true }),
  };
  assert.equal(autoLetteringStyle(block, '\uC6B0\uB9AC \uC14B\uC774 \uAC19\uC774 \uAC00\uC790\uACE0?', 'ko').writingMode, 'horizontal-tb');
});

test('vertical source languages retain vertical auto-lettering', () => {
  assert.equal(autoLetteringStyle(tallVerticalBlock, '\u4E09\u4EBA\u3067\u884C\u3053\u3046', 'ja').writingMode, 'vertical-rl');
});

test('Korean retains vertical flow in a narrow, tall source column', () => {
  const narrowBlock = {
    polygon_json: JSON.stringify([
      { x: 0.48, y: 0.1 }, { x: 0.52, y: 0.1 },
      { x: 0.52, y: 0.9 }, { x: 0.48, y: 0.9 },
    ]),
    layout_hint_json: JSON.stringify({ vertical: true }),
  };
  assert.equal(autoLetteringStyle(narrowBlock, '\uC5EC\uAE30\uC11C\uB294 \uC774\uB807\uAC8C \uC77D\uC5B4\uC57C \uD574', 'ko').writingMode, 'vertical-rl');
});

test('plausible balloon bounds are used, but candidates that grow too tall are rejected', () => {
  const source = [
    { x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 },
    { x: 0.55, y: 0.5 }, { x: 0.45, y: 0.5 },
  ];
  const safe = [
    { x: 0.43, y: 0.38 }, { x: 0.57, y: 0.38 },
    { x: 0.57, y: 0.52 }, { x: 0.43, y: 0.52 },
  ];
  const tooTall = [
    { x: 0.41, y: 0.35 }, { x: 0.59, y: 0.35 },
    { x: 0.59, y: 0.63 }, { x: 0.41, y: 0.63 },
  ];
  const safeBlock = { polygon_json: JSON.stringify(source), layout_hint_json: JSON.stringify({ letteringPolygon: safe, foregroundColor: '#ffffff' }) };
  const unsafeBlock = { polygon_json: JSON.stringify(source), layout_hint_json: JSON.stringify({ letteringPolygon: tooTall }) };

  assert.deepEqual(automaticLetteringPolygon(safeBlock), safe);
  assert.deepEqual(automaticLetteringPolygon(unsafeBlock), source);
  assert.equal(autoLetteringStyle(safeBlock, '\uC5B4\uB5BB\uAC8C \uD55C \uAC70\uC57C?', 'ko', 'dialogue').color, '#21121a');
  assert.equal(autoLetteringStyle(unsafeBlock, '\uC5B4\uB5BB\uAC8C \uD55C \uAC70\uC57C?', 'ko', 'dialogue').color, '#21121a');
  assert.equal(
    autoLetteringStyle(unsafeBlock, '\uC5B4\uB5BB\uAC8C \uD55C \uAC70\uC57C?', 'ko', 'dialogue').fontSize,
    autoLetteringStyle({ polygon_json: JSON.stringify(source) }, '\uC5B4\uB5BB\uAC8C \uD55C \uAC70\uC57C?', 'ko', 'dialogue').fontSize,
  );
});

test('bright detector ink guesses do not turn ordinary dialogue white on halftone backgrounds', () => {
  const block = {
    ...tallVerticalBlock,
    layout_hint_json: JSON.stringify({ vertical: true, foregroundColor: '#fefefe' }),
  };
  const style = autoLetteringStyle(block, '\uC774\uB7F0 \uC774\uC57C\uAE30', 'ko', 'dialogue');
  assert.equal(style.color, '#21121a');
  assert.equal(style.outlineColor, '#ffffff');
  assert.ok(style.outlineWidth > 0);
});

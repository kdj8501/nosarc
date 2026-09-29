import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLetteringStyle } from '../src/lettering.mjs';

const tallBubble = {
  polygon_json: JSON.stringify([
    { x: 0.4, y: 0.1 }, { x: 0.6, y: 0.1 },
    { x: 0.6, y: 0.9 }, { x: 0.4, y: 0.9 },
  ]),
};

test('Korean auto-lettering stays horizontal in a tall Japanese speech bubble', () => {
  assert.equal(autoLetteringStyle(tallBubble, '우리 셋이 같이 가자고?', 'ko').writingMode, 'horizontal-tb');
});

test('vertical source languages retain vertical auto-lettering', () => {
  assert.equal(autoLetteringStyle(tallBubble, '三人で行こう', 'ja').writingMode, 'vertical-rl');
});

test('very short Korean captions can remain vertical in an exceptionally narrow region', () => {
  const narrowBubble = {
    polygon_json: JSON.stringify([
      { x: 0.48, y: 0.1 }, { x: 0.52, y: 0.1 },
      { x: 0.52, y: 0.9 }, { x: 0.48, y: 0.9 },
    ]),
  };
  assert.equal(autoLetteringStyle(narrowBubble, '응', 'ko').writingMode, 'vertical-rl');
});

test('Korean lettering ignores a detected balloon candidate that is implausibly broad', () => {
  const block = {
    polygon_json: JSON.stringify([
      { x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 },
      { x: 0.55, y: 0.5 }, { x: 0.45, y: 0.5 },
    ]),
    layout_hint_json: JSON.stringify({ letteringPolygon: [
      { x: 0.37, y: 0.27 }, { x: 0.63, y: 0.27 },
      { x: 0.63, y: 0.63 }, { x: 0.37, y: 0.63 },
    ] }),
  };

  const style = autoLetteringStyle(block, '이렇게까지 타는 건가?', 'ko', 'dialogue');
  const sourceOnly = autoLetteringStyle({ ...block, layout_hint_json: '{}' }, '이렇게까지 타는 건가?', 'ko', 'dialogue');
  assert.equal(style.writingMode, 'horizontal-tb');
  assert.equal(style.fontSize, sourceOnly.fontSize);
});

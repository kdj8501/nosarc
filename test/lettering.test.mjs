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

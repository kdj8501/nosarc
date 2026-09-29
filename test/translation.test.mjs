import test from 'node:test';
import assert from 'node:assert/strict';
import { isKoreanText, translateWithOllama } from '../src/translation.mjs';

test('Korean validation rejects Japanese and English leftovers inside Hangul text', () => {
  assert.equal(isKoreanText('하지만 표면은 타 burned-out 같은데…'), false);
  assert.equal(isKoreanText('환姫의 패커 왼팔에 불을 붙였네…'), false);
  assert.equal(isKoreanText('하지만 표면은 타고 있는데…'), true);
});

test('Ollama translates one line at a time and passes nearby original dialogue only once', async () => {
  const requests = [];
  const progress = [];
  const blocks = [
    { page_id: 'page-a', source_text: '先に行ってから外で待ってて' },
    { page_id: 'page-a', source_text: 'そこでずっと待っててね' },
    { page_id: 'page-b', source_text: '手伝ってくれてありがとう' },
  ];
  const results = await translateWithOllama(blocks, {
    skipNaturalization: true,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const item = JSON.parse(body.messages[1].content).items[0];
      const translations = [{ index: item.index, text: ['먼저 가', '기다려', '고마워'][item.index] }];
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ translations }) } }) };
    },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(results, [
    { text: '먼저 가', kind: 'unknown' },
    { text: '기다려', kind: 'unknown' },
    { text: '고마워', kind: 'unknown' },
  ]);
  assert.equal(requests.length, 3);
  const firstItem = JSON.parse(requests[0].messages[1].content).items[0];
  const secondItem = JSON.parse(requests[1].messages[1].content).items[0];
  const thirdItem = JSON.parse(requests[2].messages[1].content).items[0];
  assert.equal(requests[0].think, true);
  assert.equal(requests[0].options.temperature, 0.6);
  assert.equal(requests[0].options.top_p, 0.95);
  assert.match(requests[0].messages[0].content, /natural Korean/);
  assert.deepEqual(firstItem.nearbyDialogue, [{ position: 'after', distance: 1, text: 'そこでずっと待っててね' }]);
  assert.deepEqual(secondItem.nearbyDialogue, [{ position: 'before', distance: 1, text: '先に行ってから外で待ってて' }]);
  assert.deepEqual(thirdItem.nearbyDialogue, []);
  assert.equal('contextBefore' in firstItem, false);
  assert.equal('translatedNearbyBefore' in firstItem, false);
  assert.deepEqual(progress, [33, 67, 100]);
});

test('Korean naturalization does not receive nearby lines that could be merged into the current item', async () => {
  const requests = [];
  const results = await translateWithOllama([{
    page_id: 'p',
    source_text: '健彦よ．．．',
    nearbyDialogue: [{ position: 'before', distance: 1, text: '環姫さんのパーカーの左腕に火をつけたって事．．．' }],
  }], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        ok: true,
        json: async () => ({ message: { content: JSON.stringify({
          translations: [{ index: 0, text: '건현아…', kind: 'dialogue' }],
        }) } }),
      };
    },
  });

  const polishItems = JSON.parse(requests[1].messages[1].content).items;
  const translationItems = JSON.parse(requests[0].messages[1].content).items;
  assert.deepEqual(translationItems[0].nearbyDialogue, []);
  assert.equal('nearbyDialogue' in polishItems[0], false);
  assert.deepEqual(results, [{ text: '건현아…', kind: 'dialogue' }]);
});

test('Korean naturalization rejects a rewrite that expands a short draft into a different line', async () => {
  let requestCount = 0;
  const results = await translateWithOllama([{ page_id: 'p', source_text: '健彦よ．．．' }], {
    fetchImpl: async () => {
      requestCount += 1;
      const text = requestCount === 1
        ? '건현아…'
        : '건현아, 화염의 고리 여사의 파카 왼팔에 불을 지른 건데 어떻게 그런 일이 일어난 거야?';
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        translations: [{ index: 0, text, kind: 'dialogue' }],
      }) } }) };
    },
  });

  assert.equal(requestCount, 2);
  assert.deepEqual(results, [{ text: '건현아…', kind: 'dialogue' }]);
});

test('Ollama translation rejects missing lines instead of silently shifting dialogue', async () => {
  await assert.rejects(
    translateWithOllama([{ page_id: 'p', source_text: 'こんにちは' }], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: '{"translations":[]}' } }) }),
    }),
    /누락/,
  );
});

test('Ollama skips a line that remains Japanese after a strict Korean retry', async () => {
  const results = await translateWithOllama([{ page_id: 'p', source_text: '履物を．．．' }], {
    skipNaturalization: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({
      translations: [{ index: 0, text: '履物を…' }],
    }) } }) }),
  });

  assert.deepEqual(results, [{ text: '', kind: 'unknown' }]);
});

test('Ollama translation splits and retries a batch when the model omits its translations', async () => {
  const requestSizes = [];
  const progress = [];
  const blocks = Array.from({ length: 8 }, (_, index) => ({
    page_id: 'page-a',
    source_text: `line-${index}`,
  }));
  const results = await translateWithOllama(blocks, {
    batchSize: 8,
    skipNaturalization: true,
    fetchImpl: async (_url, options) => {
      const items = JSON.parse(options.body).messages[1].content;
      const batch = JSON.parse(items).items;
      requestSizes.push(batch.length);
      const translations = batch.length > 4
        ? []
        : batch.map((item) => ({ index: item.index, text: `한국어 번역 ${item.text.replace(/^line-/, '')}` }));
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ translations }) } }) };
    },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(requestSizes, [8, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(results, blocks.map((block) => ({ text: `한국어 번역 ${block.source_text.replace(/^line-/, '')}`, kind: 'unknown' })));
  assert.deepEqual(progress, [100]);
});

test('Ollama translation reports an actionable error when the local service is unavailable', async () => {
  await assert.rejects(
    translateWithOllama([{ page_id: 'p', source_text: 'こんにちは' }], {
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    }),
    /Ollama 서버.*연결할 수 없습니다/,
  );
});

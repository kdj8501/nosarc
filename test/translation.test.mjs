import test from 'node:test';
import assert from 'node:assert/strict';
import { translateWithOllama } from '../src/translation.mjs';

test('Ollama translation preserves block indexes and passes same-page neighboring dialogue as context', async () => {
  const requests = [];
  const progress = [];
  const blocks = [
    { page_id: 'page-a', source_text: '先に行って' },
    { page_id: 'page-a', source_text: '待ってて' },
    { page_id: 'page-b', source_text: 'ありがとう' },
  ];
  const results = await translateWithOllama(blocks, {
    batchSize: 2,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const translations = requests.length === 2
        ? [{ index: 2, text: '고마워' }]
        : [{ index: 1, text: '기다려' }, { index: 0, text: '먼저 가' }];
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ translations }) } }) };
    },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(results, [{ text: '먼저 가' }, { text: '기다려' }, { text: '고마워' }]);
  assert.equal(requests.length, 2);
  const firstBatchItems = JSON.parse(requests[0].messages[1].content).items;
  assert.equal(requests[0].think, false);
  assert.match(requests[0].messages[0].content, /natural Korean/);
  assert.equal(firstBatchItems[0].contextAfter, '待ってて');
  assert.equal(firstBatchItems[1].contextBefore, '先に行って');
  assert.equal(JSON.parse(requests[1].messages[1].content).items[0].contextBefore, '');
  assert.deepEqual(progress, [67, 100]);
});

test('Ollama translation rejects missing lines instead of silently shifting dialogue', async () => {
  await assert.rejects(
    translateWithOllama([{ page_id: 'p', source_text: 'こんにちは' }], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: '{"translations":[]}' } }) }),
    }),
    /누락/,
  );
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
    fetchImpl: async (_url, options) => {
      const items = JSON.parse(options.body).messages[1].content;
      const batch = JSON.parse(items).items;
      requestSizes.push(batch.length);
      const translations = batch.length > 4
        ? []
        : batch.map((item) => ({ index: item.index, text: `ko-${item.text}` }));
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ translations }) } }) };
    },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(requestSizes, [8, 4, 4]);
  assert.deepEqual(results, blocks.map((block) => ({ text: `ko-${block.source_text}` })));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createCanvas } from '@napi-rs/canvas';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error('Pipeline did not reach the expected state.');
}

test('processing survives translation failure and restart, and retries only unfinished pages', { timeout: 30000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nosarc-pipeline-'));
  const media = path.join(temporary, 'media');
  await fs.mkdir(media);
  const workerFile = path.join(temporary, 'fake-worker.mjs');
  await fs.writeFile(workerFile, `
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { createCanvas, loadImage } = createRequire(${JSON.stringify(path.join(root, 'package.json'))})('@napi-rs/canvas');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let body = '';
for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
for (const page of request.pages) {
  if (request.kind === 'prepare') {
    const source = await loadImage(page.imagePath);
    const scale = Math.min(1, request.maxSide / Math.max(source.width, source.height), Math.sqrt(request.maxPixels / (source.width * source.height)));
    const width = Math.floor(source.width * scale), height = Math.floor(source.height * scale);
    const output = createCanvas(width, height);
    output.getContext('2d').drawImage(source, 0, 0, width, height);
    await fs.writeFile(page.outputPath, output.toBuffer('image/png'));
    emit({ type: 'prepared_result', pageId: page.pageId, outputPath: page.outputPath, width, height });
  } else if (request.kind === 'inpaint') {
    await fs.copyFile(page.imagePath, page.outputPath);
    emit({ type: 'inpaint_result', pageId: page.pageId, outputPath: page.outputPath });
  } else throw new Error('Unexpected worker request: ' + request.kind);
}
emit({ type: 'done' });
`);
  let failSecond = true;
  const requests = [];
  const ollama = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/generate') { res.end('{}'); return; }
    const { items } = JSON.parse(body.messages[1].content);
    const isDraft = Object.hasOwn(items[0], 'draft');
    if (!isDraft) requests.push(items[0].text);
    if (!isDraft && items[0].text === '二番目' && failSecond) {
      res.statusCode = 503;
      res.end('temporarily unavailable');
      return;
    }
    res.end(JSON.stringify({ message: { content: JSON.stringify({
      translations: items.map((item) => ({ index: item.index, text: item.draft || '안녕', kind: 'dialogue' })), entities: [],
    }) } }));
  });
  ollama.listen(0, '127.0.0.1');
  await once(ollama, 'listening');
  const modelPath = path.join(temporary, 'fake-lama.onnx');
  await fs.writeFile(modelPath, 'fake model for protocol tests');
  const environment = {
    ...process.env, APP_ENV: 'development', PORT: '0', NOSARC_PROCESS_ROLE: '',
    NOSARC_ACCESS_PASSWORD: 'test-password', NOSARC_ACCESS_PASSWORD_HASH: '', SESSION_SECRET: 'test-session-secret',
    DATABASE_PATH: path.join(temporary, 'archive.db'), MEDIA_ROOT: media,
    OCR_CACHE_PATH: path.join(temporary, 'ocr'), OCR_MANGA_CACHE_PATH: path.join(temporary, 'models'),
    INPAINT_WORK_PATH: path.join(temporary, 'inpaint'), INPAINT_MODEL_PATH: modelPath, INPAINT_PROVIDER: 'lama',
    OCR_PROVIDER: 'tesseract', AI_WORKER_COMMAND: process.execPath, AI_WORKER_SCRIPT: workerFile,
    AI_TRANSLATION_PROVIDER: 'ollama', AI_TRANSLATION_OLLAMA_BATCH_SIZE: '1',
    AI_TRANSLATION_OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`,
    AI_TRANSLATION_OLLAMA_MODEL: 'test-model', PROCESSING_MAX_SIDE: '800', PROCESSING_MAX_PIXELS: '640000',
    AI_TRANSLATION_MODEL_PATH: path.join(temporary, 'translation-model'),
    OCR_TEXT_DETECTOR_MODEL_PATH: path.join(temporary, 'detector.onnx'),
  };
  let child;
  let db;
  let baseUrl;
  let cookie;
  async function stop() {
    if (!child || child.exitCode != null) return;
    const closed = once(child, 'close');
    child.kill();
    await closed;
    child = null;
    await delay(200); // Give the IPC-disconnected worker time to close SQLite.
  }
  t.after(async () => {
    await stop();
    db?.close();
    ollama.closeAllConnections();
    await new Promise((resolve) => ollama.close(resolve));
    // Only remove the directory allocated for this test.
    assert.equal(path.dirname(temporary), os.tmpdir());
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: environment, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    baseUrl = await waitFor(() => {
      if (child.exitCode != null) throw new Error(output);
      return output.match(/listening on (http:\/\/localhost:\d+)/)?.[1];
    }, Boolean);
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  async function api(route, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  await start();
  db = new Database(environment.DATABASE_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const image = createCanvas(1600, 2000);
  const context = image.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 1600, 2000);
  const png = image.toBuffer('image/png');
  await fs.writeFile(path.join(media, 'original.png'), png);
  const now = new Date().toISOString();
  const bounds = (small) => JSON.stringify(small
    ? [{ x: .4, y: .4 }, { x: .40001, y: .4 }, { x: .40001, y: .40001 }, { x: .4, y: .40001 }]
    : [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }]);
  db.transaction(() => {
    db.prepare('INSERT INTO series (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('series', 'Test', now, now);
    db.prepare('INSERT INTO assets (id, storage_key, original_name, mime_type, byte_size, sha256, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('original', 'original.png', 'original.png', 'image/png', png.length, 'test', 'source', now);
    db.prepare('INSERT INTO chapters (id, series_id, number_label, sort_key, source_asset_id, page_count, processing_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('chapter', 'series', '1', 1, 'original', 2, 'completed', now, now);
    for (const index of [0, 1]) {
      db.prepare('INSERT INTO pages (id, chapter_id, page_index, image_asset_id, width, height) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`page-${index}`, 'chapter', index, 'original', 1600, 2000);
      db.prepare('INSERT INTO ocr_blocks (id, page_id, polygon_json, source_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`block-${index}`, `page-${index}`, bounds(index === 1), index ? '二番目' : '一番目', now, now);
    }
  })();
  const job = await api('/api/chapters/chapter/auto-translate', 'POST', { forceTranslation: true });
  await waitFor(() => api(`/api/jobs/${job.id}`), (result) => result.status === 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM translations WHERE is_active = 1').get().count, 1);
  assert.equal(db.prepare('SELECT processing_width, processing_height FROM pages WHERE id = ?').get('page-0').processing_height, 800);
  assert.deepEqual(await fs.readFile(path.join(media, 'original.png')), png);

  await stop();
  failSecond = false;
  await start();
  await fs.unlink(modelPath);
  await api(`/api/jobs/${job.id}/retry`, 'POST');
  const renderFailure = await waitFor(() => api(`/api/jobs/${job.id}`), (result) => result.status === 'failed');
  assert.match(renderFailure.error_message, /LaMa/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM translations WHERE is_active = 1').get().count, 2);
  await fs.writeFile(modelPath, 'fake model for protocol tests');
  await api(`/api/jobs/${job.id}/retry`, 'POST');
  const completed = await waitFor(() => api(`/api/jobs/${job.id}`), (result) => result.status === 'completed');
  assert.match(completed.error_message, /1페이지/);
  assert.deepEqual(requests, ['一番目', '二番目', '二番目']);
  let chapter = await api('/api/chapters/chapter');
  assert.ok(chapter.pages[0].translated_media_url);
  assert.equal(chapter.pages[1].translated_media_url, null);
  assert.ok(chapter.pages[1].render_error);
  const firstRendered = chapter.pages[0].translated_media_url;
  const secondLayer = chapter.pages[1].lettering_layers[0];
  await api(`/api/lettering-layers/${secondLayer.id}`, 'PATCH', { polygon: JSON.parse(bounds(false)) });
  const rendering = await api('/api/chapters/chapter/render', 'POST');
  const rendered = await waitFor(() => api(`/api/jobs/${rendering.id}`), (result) => result.status === 'completed');
  assert.equal(rendered.error_message, null);
  chapter = await api('/api/chapters/chapter');
  assert.equal(chapter.pages[0].translated_media_url, firstRendered);
  assert.ok(chapter.pages[1].translated_media_url);
  assert.equal(chapter.pages[1].render_error, null);
  assert.equal(requests.length, 3);

  await api('/api/chapters/chapter', 'DELETE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  assert.deepEqual(await fs.readdir(media), []);
});

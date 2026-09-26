import 'node:process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as canvas from '@napi-rs/canvas';
import Database from 'better-sqlite3';
import express from 'express';
import multer from 'multer';
import unzipper from 'unzipper';

import {
  createSessionToken,
  parseCookies,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './security.mjs';
import { createOcrWorker, extractOcrBlocks, recognizePage } from './ocr.mjs';

globalThis.DOMMatrix = canvas.DOMMatrix;
globalThis.ImageData = canvas.ImageData;
globalThis.Path2D = canvas.Path2D;
if (typeof process.getBuiltinModule !== 'function') {
  const requireBuiltin = createRequire(import.meta.url);
  process.getBuiltinModule = (name) => requireBuiltin(name);
}
const { createCanvas } = canvas;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));

const config = {
  appName: process.env.APP_NAME || 'Nos Arc',
  env: process.env.APP_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  accessPassword: process.env.NOSARC_ACCESS_PASSWORD || '',
  accessPasswordHash: process.env.NOSARC_ACCESS_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || ((process.env.APP_ENV || 'development') === 'development' ? 'development-only-nosarc-session-secret' : ''),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH || './data/nosarc.db'),
  mediaRoot: resolveFromRoot(process.env.MEDIA_ROOT || './data/media'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 1073741824),
  maxPages: Number(process.env.MAX_PAGES_PER_CHAPTER || 500),
  maxPageBytes: Number(process.env.MAX_PAGE_BYTES || 67108864),
  maxExtractedBytes: Number(process.env.MAX_EXTRACTED_BYTES || 536870912),
  pdfRenderWidth: Number(process.env.PDF_RENDER_WIDTH || 1600),
  ocrProvider: process.env.OCR_PROVIDER || 'tesseract',
  ocrLanguage: process.env.OCR_LANGUAGE || 'jpn',
  ocrLangPath: process.env.OCR_LANG_PATH || '',
  ocrCachePath: resolveFromRoot(process.env.OCR_CACHE_PATH || './data/tesseract'),
  ocrMinConfidence: Number(process.env.OCR_MIN_CONFIDENCE || 0.15),
  aiTranslationProvider: process.env.AI_TRANSLATION_PROVIDER || 'ctranslate2',
  aiWorkerCommand: process.env.AI_WORKER_COMMAND || 'python',
  aiWorkerScript: resolveFromRoot(process.env.AI_WORKER_SCRIPT || './ai-worker/worker.py'),
  aiTranslationModelPath: resolveFromRoot(process.env.AI_TRANSLATION_MODEL_PATH || './data/models/opus-mt-ja-ko-ct2'),
  aiTranslationTokenizerPath: resolveFromRoot(process.env.AI_TRANSLATION_TOKENIZER_PATH || './data/models/opus-mt-ja-ko'),
  aiTranslationComputeType: process.env.AI_TRANSLATION_COMPUTE_TYPE || 'int8',
  aiWorkerThreads: Math.max(1, Number(process.env.AI_WORKER_THREADS || 1)),
};

if (config.env === 'production' && !config.sessionSecret) {
  throw new Error('SESSION_SECRET is required in production.');
}

const dataRoot = path.dirname(config.databasePath);
const uploadRoot = path.join(dataRoot, 'uploads');
await fsp.mkdir(config.mediaRoot, { recursive: true });
await fsp.mkdir(uploadRoot, { recursive: true });
await fsp.mkdir(config.ocrCachePath, { recursive: true });
await fsp.mkdir(path.dirname(config.aiTranslationModelPath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    original_title TEXT,
    description TEXT,
    target_language TEXT NOT NULL DEFAULT 'ko',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS series_tags (
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(series_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('source', 'page', 'cover')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    number_label TEXT NOT NULL,
    sort_key REAL NOT NULL,
    title TEXT,
    source_asset_id TEXT NOT NULL REFERENCES assets(id),
    page_count INTEGER NOT NULL DEFAULT 0,
    processing_status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    image_asset_id TEXT NOT NULL REFERENCES assets(id),
    width INTEGER,
    height INTEGER,
    UNIQUE(chapter_id, page_index)
  );
  CREATE TABLE IF NOT EXISTS ocr_blocks (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    polygon_json TEXT NOT NULL,
    source_text TEXT NOT NULL,
    source_language TEXT NOT NULL DEFAULT 'ja',
    confidence REAL,
    reading_order INTEGER NOT NULL DEFAULT 0,
    model_id TEXT,
    model_version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    ocr_block_id TEXT NOT NULL REFERENCES ocr_blocks(id) ON DELETE CASCADE,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    translator_id TEXT,
    translator_version TEXT,
    glossary_version TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lettering_layers (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    translation_id TEXT REFERENCES translations(id) ON DELETE SET NULL,
    polygon_json TEXT NOT NULL,
    text TEXT NOT NULL,
    style_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    current_stage TEXT NOT NULL DEFAULT 'preparing',
    progress INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
`);

const sessions = new Map();
const ingestQueue = [];
let ingestActive = false;
const ocrQueue = [];
let ocrActive = false;
const autoTranslationQueue = [];
let autoTranslationActive = false;
const activeAiProcesses = new Map();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { fallthrough: false }));

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: config.maxUploadBytes, files: config.maxPages },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowedMimeTypes.has(file.mimetype.toLowerCase()) || allowedArchiveExtensions.has(extension)) return callback(null, true);
    callback(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'application/pdf',
  'application/zip',
  'application/x-cbz',
]);
const allowedArchiveExtensions = new Set(['.zip', '.cbz']);

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(getSession(req)) });
});

app.post('/auth/login', async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const valid = await verifyPassword(password, {
      plainPassword: config.env === 'development' ? (config.accessPassword || 'change-this-password') : '',
      passwordHash: config.accessPasswordHash,
    });
    if (!valid) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });

    const token = createSessionToken();
    sessions.set(token, { createdAt: Date.now() });
    const secure = config.env === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `nosarc_session=${encodeURIComponent(signSessionToken(token, config.sessionSecret))}; HttpOnly; SameSite=Lax; Path=/${secure}`);
    res.json({ authenticated: true });
  } catch (error) {
    next(error);
  }
});

app.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).nosarc_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'nosarc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
});

app.use('/api', requireSession);
app.use('/media', requireSession);

app.get('/api/tags', (_req, res) => {
  res.json(db.prepare('SELECT id, name, slug FROM tags ORDER BY name COLLATE NOCASE').all());
});

app.get('/api/series', (req, res) => {
  const search = String(req.query.search || '').trim();
  const query = `
    SELECT s.id, s.title, s.original_title, s.description, s.target_language, s.status,
      s.created_at, s.updated_at, COUNT(c.id) AS chapter_count,
      GROUP_CONCAT(t.name, ', ') AS tags
    FROM series s
    LEFT JOIN chapters c ON c.series_id = s.id
    LEFT JOIN series_tags st ON st.series_id = s.id
    LEFT JOIN tags t ON t.id = st.tag_id
    WHERE (? = '' OR s.title LIKE '%' || ? || '%' OR COALESCE(s.original_title, '') LIKE '%' || ? || '%')
    GROUP BY s.id
    ORDER BY s.updated_at DESC`;
  res.json(db.prepare(query).all(search, search, search));
});

app.post('/api/series', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title || title.length > 200) return res.status(400).json({ error: '작품명은 1~200자로 입력해 주세요.' });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const tagNames = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO series (id, title, original_title, description, target_language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      title,
      cleanOptional(req.body?.originalTitle),
      cleanOptional(req.body?.description),
      cleanOptional(req.body?.targetLanguage) || 'ko',
      now,
      now,
    );
    attachTags(id, tagNames);
  });
  create();
  res.status(201).json(getSeries(id));
});

app.get('/api/series/:id', (req, res) => {
  const series = getSeries(req.params.id);
  if (!series) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
  res.json({ ...series, chapters: listChapters(req.params.id) });
});

app.patch('/api/series/:id', (req, res) => {
  const current = getSeries(req.params.id);
  if (!current) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
  const title = String(req.body?.title ?? current.title).trim();
  if (!title || title.length > 200) return res.status(400).json({ error: '작품명은 1~200자로 입력해 주세요.' });
  db.prepare(`UPDATE series SET title = ?, original_title = ?, description = ?, target_language = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(title, cleanOptional(req.body?.originalTitle ?? current.original_title), cleanOptional(req.body?.description ?? current.description), cleanOptional(req.body?.targetLanguage ?? current.target_language) || 'ko', req.body?.status === 'archived' ? 'archived' : current.status, new Date().toISOString(), req.params.id);
  if (Array.isArray(req.body?.tags)) attachTags(req.params.id, req.body.tags);
  res.json(getSeries(req.params.id));
});

app.post('/api/series/:id/chapters', upload.array('files', config.maxPages), async (req, res, next) => {
  try {
    const series = getSeries(req.params.id);
    if (!series) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    if (!req.files?.length) return res.status(400).json({ error: '파일을 하나 이상 선택해 주세요.' });

    const files = req.files;
    const unsupportedMix = files.length > 1 && files.some((file) => !file.mimetype.startsWith('image/'));
    if (unsupportedMix) return res.status(400).json({ error: '여러 파일 업로드는 이미지 파일만 지원합니다.' });

    const chapterId = crypto.randomUUID();
    const now = new Date().toISOString();
    const numberLabel = String(req.body?.numberLabel || '').trim() || String((listChapters(series.id).length || 0) + 1);
    const sortKey = parseSortKey(numberLabel);
    const chapterTitle = cleanOptional(req.body?.title);
    const first = files[0];
    const sourceAsset = await saveAsset(first, 'source');
    const pageCount = files.every((file) => file.mimetype.startsWith('image/')) ? files.length : 0;
    const needsIngest = files.length === 1 && !first.mimetype.startsWith('image/');
    const status = needsIngest ? 'queued' : 'completed';
    let jobId = null;

    const insert = db.transaction(() => {
      db.prepare(`INSERT INTO chapters (id, series_id, number_label, sort_key, title, source_asset_id, page_count, processing_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chapterId, series.id, numberLabel, sortKey, chapterTitle, sourceAsset.id, pageCount, status, now, now);
      files.forEach((file, index) => {
        if (!file.mimetype.startsWith('image/')) return;
        const asset = index === 0 ? sourceAsset : null;
        if (asset) {
          insertPage(chapterId, index, asset, file);
        }
      });
      if (needsIngest) {
        jobId = crypto.randomUUID();
        db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'ingest', 'queued', 'preparing', 0, ?)`)
          .run(jobId, chapterId, now);
      }
    });
    insert();

    for (const [index, file] of files.entries()) {
      if (index === 0 || !file.mimetype.startsWith('image/')) continue;
      const asset = await saveAsset(file, 'page');
      db.prepare('INSERT INTO pages (id, chapter_id, page_index, image_asset_id, width, height) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), chapterId, index, asset.id, asset.width, asset.height);
    }
    db.prepare('UPDATE series SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), series.id);
    if (jobId) enqueueIngest(jobId);
    res.status(202).json({ id: chapterId, status, job_id: jobId, chapter: getChapter(chapterId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chapters/:id', (req, res) => {
  const chapter = getChapter(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  res.json(chapter);
});

app.post('/api/chapters/:id/ocr', (req, res) => {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  if (config.ocrProvider !== 'tesseract') return res.status(503).json({ error: `현재 OCR 제공자(${config.ocrProvider})는 사용할 수 없습니다.` });
  if (chapter.page_count < 1) return res.status(409).json({ error: 'OCR을 실행할 페이지가 없습니다.' });
  const activeJob = db.prepare(`SELECT * FROM jobs WHERE chapter_id = ? AND type = 'ocr' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapter.id);
  if (activeJob) return res.status(409).json({ error: '이미 OCR 작업이 진행 중입니다.', job_id: activeJob.id });
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'ocr', 'queued', 'ocr', 0, ?)`).run(jobId, chapter.id, now);
  enqueueOcr(jobId);
  res.status(202).json({ id: jobId, status: 'queued' });
});

app.post('/api/chapters/:id/auto-translate', (req, res) => {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  if (config.aiTranslationProvider !== 'ctranslate2') return res.status(503).json({ error: `현재 번역 제공자(${config.aiTranslationProvider})는 사용할 수 없습니다.` });
  if (chapter.page_count < 1 || chapter.processing_status !== 'completed') return res.status(409).json({ error: '페이지 변환이 완료된 권에서만 자동 번역을 실행할 수 있습니다.' });
  const blockCount = db.prepare(`SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?`).get(chapter.id).count;
  if (!blockCount) return res.status(409).json({ error: '먼저 OCR을 실행해 번역할 텍스트를 만들어 주세요.' });
  const activeJob = db.prepare(`SELECT * FROM jobs WHERE chapter_id = ? AND type = 'auto_translate' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapter.id);
  if (activeJob) return res.status(409).json({ error: '이미 자동 번역 작업이 진행 중입니다.', job_id: activeJob.id });
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'auto_translate', 'queued', 'translation', 0, ?)`).run(jobId, chapter.id, now);
  enqueueAutoTranslation(jobId);
  res.status(202).json({ id: jobId, type: 'auto_translate', status: 'queued' });
});

app.post('/api/pages/:id/ocr-blocks', (req, res) => {
  const page = db.prepare(`SELECT p.id FROM pages p WHERE p.id = ?`).get(req.params.id);
  if (!page) return res.status(404).json({ error: '페이지를 찾을 수 없습니다.' });
  const sourceText = String(req.body?.sourceText || '').trim();
  if (!sourceText) return res.status(400).json({ error: 'OCR 원문을 입력해 주세요.' });
  let polygon;
  try {
    polygon = normalizePolygon(req.body?.polygon);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ocr_blocks (id, page_id, polygon_json, source_text, source_language, confidence, reading_order, model_id, model_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    page.id,
    JSON.stringify(polygon),
    sourceText,
    normalizeLanguage(req.body?.sourceLanguage, 'ja'),
    normalizeConfidence(req.body?.confidence),
    Number.isInteger(req.body?.readingOrder) ? req.body.readingOrder : 0,
    cleanOptional(req.body?.modelId),
    cleanOptional(req.body?.modelVersion),
    now,
    now,
  );
  res.status(201).json(getOcrBlock(id));
});

app.patch('/api/ocr-blocks/:id', (req, res) => {
  const current = getOcrBlock(req.params.id);
  if (!current) return res.status(404).json({ error: 'OCR 블록을 찾을 수 없습니다.' });
  let polygon = current.polygon;
  if (req.body?.polygon !== undefined) {
    try {
      polygon = normalizePolygon(req.body.polygon);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  const sourceText = String(req.body?.sourceText ?? current.source_text).trim();
  if (!sourceText) return res.status(400).json({ error: 'OCR 원문을 입력해 주세요.' });
  const now = new Date().toISOString();
  db.prepare(`UPDATE ocr_blocks SET polygon_json = ?, source_text = ?, confidence = ?, reading_order = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(polygon),
    sourceText,
    normalizeConfidence(req.body?.confidence ?? current.confidence),
    Number.isInteger(req.body?.readingOrder) ? req.body.readingOrder : current.reading_order,
    now,
    req.params.id,
  );
  db.prepare(`UPDATE lettering_layers SET polygon_json = ?, updated_at = ? WHERE translation_id IN (SELECT id FROM translations WHERE ocr_block_id = ? AND is_active = 1)`).run(JSON.stringify(polygon), now, req.params.id);
  res.json(getOcrBlock(req.params.id));
});

app.post('/api/ocr-blocks/:id/translations', (req, res) => {
  const block = db.prepare(`SELECT b.*, s.target_language AS series_target_language FROM ocr_blocks b
    JOIN pages p ON p.id = b.page_id JOIN chapters c ON c.id = p.chapter_id JOIN series s ON s.id = c.series_id
    WHERE b.id = ?`).get(req.params.id);
  if (!block) return res.status(404).json({ error: 'OCR 블록을 찾을 수 없습니다.' });
  const translatedText = String(req.body?.translatedText || '').trim();
  if (!translatedText) return res.status(400).json({ error: '번역문을 입력해 주세요.' });
  const targetLanguage = normalizeLanguage(req.body?.targetLanguage, block.series_target_language || 'ko');
  const style = normalizeLetteringStyle(req.body?.style);
  const now = new Date().toISOString();
  const translationId = crypto.randomUUID();
  const layerId = crypto.randomUUID();
  const create = db.transaction(() => {
    db.prepare(`UPDATE translations SET is_active = 0, updated_at = ? WHERE ocr_block_id = ? AND target_language = ?`).run(now, block.id, targetLanguage);
    db.prepare(`UPDATE lettering_layers SET is_active = 0, updated_at = ? WHERE translation_id IN (SELECT id FROM translations WHERE ocr_block_id = ? AND target_language = ?)`).run(now, block.id, targetLanguage);
    db.prepare(`INSERT INTO translations (id, ocr_block_id, source_language, target_language, translated_text, translator_id, translator_version, glossary_version, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      translationId,
      block.id,
      block.source_language,
      targetLanguage,
      translatedText,
      cleanOptional(req.body?.translatorId),
      cleanOptional(req.body?.translatorVersion),
      cleanOptional(req.body?.glossaryVersion),
      now,
      now,
    );
    db.prepare(`INSERT INTO lettering_layers (id, page_id, translation_id, polygon_json, text, style_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(layerId, block.page_id, translationId, block.polygon_json, translatedText, JSON.stringify(style), now, now);
  });
  create();
  res.status(201).json(getTranslation(translationId));
});

app.patch('/api/lettering-layers/:id', (req, res) => {
  const current = getLetteringLayer(req.params.id);
  if (!current) return res.status(404).json({ error: '식자 레이어를 찾을 수 없습니다.' });
  let polygon = current.polygon;
  if (req.body?.polygon !== undefined) {
    try {
      polygon = normalizePolygon(req.body.polygon);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  const text = String(req.body?.text ?? current.text).trim();
  if (!text) return res.status(400).json({ error: '식자 문구를 입력해 주세요.' });
  const style = req.body?.style === undefined ? current.style : normalizeLetteringStyle(req.body.style);
  db.prepare(`UPDATE lettering_layers SET polygon_json = ?, text = ?, style_json = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(polygon),
    text,
    JSON.stringify(style),
    req.body?.visible === false ? 0 : current.is_active,
    new Date().toISOString(),
    req.params.id,
  );
  res.json(getLetteringLayer(req.params.id));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!['failed', 'cancelled'].includes(job.status)) return res.status(409).json({ error: '실패하거나 취소된 작업만 재시도할 수 있습니다.' });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE jobs SET status = 'queued', current_stage = ?, progress = 0, error_message = NULL, started_at = NULL, finished_at = NULL WHERE id = ?`).run(job.type === 'ocr' ? 'ocr' : job.type === 'auto_translate' ? 'translation' : 'preparing', job.id);
    if (job.type === 'ingest') db.prepare(`UPDATE chapters SET processing_status = 'queued', updated_at = ? WHERE id = ?`).run(now, job.chapter_id);
  })();
  if (job.type === 'ocr') enqueueOcr(job.id);
  else if (job.type === 'auto_translate') enqueueAutoTranslation(job.id);
  else enqueueIngest(job.id);
  res.status(202).json({ id: job.id, status: 'queued' });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!['queued', 'running'].includes(job.status)) return res.status(409).json({ error: '대기 중이거나 진행 중인 작업만 취소할 수 있습니다.' });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE jobs SET status = 'cancelled', current_stage = 'cancelled', finished_at = ? WHERE id = ?`).run(now, job.id);
    if (job.type === 'ingest') db.prepare(`UPDATE chapters SET processing_status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, job.chapter_id);
  })();
  if (job.type === 'auto_translate') activeAiProcesses.get(job.id)?.kill();
  res.json({ id: job.id, status: 'cancelled' });
});

app.get('/media/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).end();
  const filePath = path.join(config.mediaRoot, asset.storage_key);
  if (!filePath.startsWith(config.mediaRoot) || !fs.existsSync(filePath)) return res.status(404).end();
  res.type(asset.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  if (error?.message?.startsWith('Unsupported file type')) return res.status(415).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

const server = app.listen(config.port, () => {
  console.log(`${config.appName} listening on http://localhost:${config.port}`);
});

function requireSession(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ error: '로그인이 필요합니다.' });
}

function getSession(req) {
  const signedToken = parseCookies(req.headers.cookie).nosarc_session;
  if (!signedToken) return null;
  const token = verifySessionToken(signedToken, config.sessionSecret);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 24 * 7) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function getSeries(id) {
  const row = db.prepare(`SELECT s.*, GROUP_CONCAT(t.name, ', ') AS tags FROM series s
    LEFT JOIN series_tags st ON st.series_id = s.id LEFT JOIN tags t ON t.id = st.tag_id WHERE s.id = ? GROUP BY s.id`).get(id);
  return row || null;
}

function listChapters(seriesId) {
  return db.prepare(`SELECT c.*, a.original_name AS source_name FROM chapters c JOIN assets a ON a.id = c.source_asset_id
    WHERE c.series_id = ? ORDER BY c.sort_key ASC, c.created_at ASC`).all(seriesId).map((chapter) => ({
    ...chapter,
    ocr_block_count: db.prepare('SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?').get(chapter.id).count,
    translation_count: db.prepare('SELECT COUNT(*) AS count FROM translations t JOIN ocr_blocks b ON b.id = t.ocr_block_id JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ? AND t.is_active = 1').get(chapter.id).count,
    job_id: db.prepare('SELECT id FROM jobs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapter.id)?.id || null,
    job_type: db.prepare('SELECT type FROM jobs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapter.id)?.type || null,
    job_status: db.prepare('SELECT status FROM jobs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapter.id)?.status || null,
  }));
}

function getChapter(id) {
  const chapter = db.prepare(`SELECT c.*, s.title AS series_title, s.target_language, a.original_name AS source_name FROM chapters c
    JOIN series s ON s.id = c.series_id JOIN assets a ON a.id = c.source_asset_id WHERE c.id = ?`).get(id);
  if (!chapter) return null;
  const pages = db.prepare(`SELECT p.*, a.mime_type, a.original_name, a.id AS asset_id FROM pages p JOIN assets a ON a.id = p.image_asset_id
    WHERE p.chapter_id = ? ORDER BY p.page_index`).all(id);
  const blocks = db.prepare(`SELECT b.* FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ? ORDER BY b.reading_order, b.created_at`).all(id).map(serializeOcrBlock);
  const translations = db.prepare(`SELECT t.* FROM translations t JOIN ocr_blocks b ON b.id = t.ocr_block_id JOIN pages p ON p.id = b.page_id
    WHERE p.chapter_id = ? AND t.is_active = 1`).all(id).map(serializeTranslation);
  const layers = db.prepare(`SELECT l.* FROM lettering_layers l JOIN pages p ON p.id = l.page_id WHERE p.chapter_id = ? AND l.is_active = 1 ORDER BY l.created_at`).all(id).map(serializeLetteringLayer);
  const blocksByPage = groupBy(blocks, 'page_id');
  const translationsByBlock = groupBy(translations, 'ocr_block_id');
  const layersByPage = groupBy(layers, 'page_id');
  chapter.pages = pages.map((page) => ({
    ...page,
    media_url: `/media/${page.asset_id}`,
    ocr_blocks: (blocksByPage[page.id] || []).map((block) => ({ ...block, translation: translationsByBlock[block.id]?.[0] || null })),
    lettering_layers: layersByPage[page.id] || [],
  }));
  chapter.job = db.prepare(`SELECT * FROM jobs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1`).get(id) || null;
  return chapter;
}

function getOcrBlock(id) {
  const block = db.prepare('SELECT * FROM ocr_blocks WHERE id = ?').get(id);
  return block ? serializeOcrBlock(block) : null;
}

function getTranslation(id) {
  const translation = db.prepare('SELECT * FROM translations WHERE id = ?').get(id);
  return translation ? serializeTranslation(translation) : null;
}

function getLetteringLayer(id) {
  const layer = db.prepare('SELECT * FROM lettering_layers WHERE id = ?').get(id);
  return layer ? serializeLetteringLayer(layer) : null;
}

function serializeOcrBlock(block) {
  return { ...block, polygon: parseJson(block.polygon_json, []) };
}

function serializeTranslation(translation) {
  return { ...translation };
}

function serializeLetteringLayer(layer) {
  return { ...layer, polygon: parseJson(layer.polygon_json, []), style: parseJson(layer.style_json, {}) };
}

function groupBy(rows, key) {
  return rows.reduce((groups, row) => {
    (groups[row[key]] ||= []).push(row);
    return groups;
  }, {});
}

function enqueueOcr(jobId) {
  if (!ocrQueue.includes(jobId)) ocrQueue.push(jobId);
  void drainOcrQueue();
}

async function drainOcrQueue() {
  if (ocrActive) return;
  ocrActive = true;
  try {
    while (ocrQueue.length) await runOcrJob(ocrQueue.shift());
  } finally {
    ocrActive = false;
  }
}

async function runOcrJob(jobId) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND type = 'ocr'`).get(jobId);
  if (!job || job.status === 'cancelled') return;
  const pages = db.prepare(`SELECT p.*, a.storage_key, a.original_name, a.mime_type FROM pages p
    JOIN assets a ON a.id = p.image_asset_id WHERE p.chapter_id = ? ORDER BY p.page_index`).all(job.chapter_id);
  if (!pages.length) return failOcrJob(jobId, 'OCR을 실행할 페이지가 없습니다.');

  db.prepare(`UPDATE jobs SET status = 'running', current_stage = 'ocr', progress = 1, started_at = ?, error_message = NULL WHERE id = ?`)
    .run(new Date().toISOString(), jobId);
  let worker;
  try {
    await clearOcrResults(job.chapter_id);
    worker = await createOcrWorker(config);
    for (const [index, page] of pages.entries()) {
      if (isJobCancelled(jobId)) return;
      const data = await recognizePage(worker, assetPath(page));
      const blocks = extractOcrBlocks(data, page.width || 1, page.height || 1, { minConfidence: config.ocrMinConfidence });
      const now = new Date().toISOString();
      const insertBlocks = db.transaction(() => {
        for (const block of blocks) {
          db.prepare(`INSERT INTO ocr_blocks (id, page_id, polygon_json, source_text, source_language, confidence, reading_order, model_id, model_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'tesseract', 'tesseract.js', ?, ?)`).run(
            crypto.randomUUID(), page.id, JSON.stringify(block.polygon), block.sourceText, config.ocrLanguage,
            block.confidence, block.readingOrder, now, now,
          );
        }
      });
      insertBlocks();
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.min(95, Math.round(((index + 1) / pages.length) * 95)), jobId);
    }
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`).run(finishedAt, jobId);
  } catch (error) {
    if (!isJobCancelled(jobId)) await failOcrJob(jobId, error.message || 'OCR 처리에 실패했습니다.');
  } finally {
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

async function clearOcrResults(chapterId) {
  db.transaction(() => {
    db.prepare(`DELETE FROM lettering_layers WHERE translation_id IN (
      SELECT t.id FROM translations t JOIN ocr_blocks b ON b.id = t.ocr_block_id JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?
    )`).run(chapterId);
    db.prepare('DELETE FROM ocr_blocks WHERE page_id IN (SELECT id FROM pages WHERE chapter_id = ?)').run(chapterId);
  })();
}

async function failOcrJob(jobId, message) {
  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!current || current.status === 'cancelled') return;
  db.prepare(`UPDATE jobs SET status = 'failed', current_stage = 'failed', error_message = ?, finished_at = ? WHERE id = ?`).run(String(message).slice(0, 500), new Date().toISOString(), jobId);
}

function enqueueAutoTranslation(jobId) {
  if (!autoTranslationQueue.includes(jobId)) autoTranslationQueue.push(jobId);
  void drainAutoTranslationQueue();
}

async function drainAutoTranslationQueue() {
  if (autoTranslationActive) return;
  autoTranslationActive = true;
  try {
    while (autoTranslationQueue.length) await runAutoTranslationJob(autoTranslationQueue.shift());
  } finally {
    autoTranslationActive = false;
  }
}

async function runAutoTranslationJob(jobId) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND type = 'auto_translate'`).get(jobId);
  if (!job || job.status === 'cancelled') return;
  const chapter = db.prepare(`SELECT c.*, s.target_language FROM chapters c JOIN series s ON s.id = c.series_id WHERE c.id = ?`).get(job.chapter_id);
  const blocks = db.prepare(`SELECT b.*, p.width, p.height FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ? ORDER BY p.page_index, b.reading_order, b.created_at`).all(job.chapter_id);
  if (!chapter || !blocks.length) return failAutoTranslationJob(jobId, '자동 번역할 OCR 블록이 없습니다.');

  db.prepare(`UPDATE jobs SET status = 'running', current_stage = 'translation', progress = 1, started_at = ?, error_message = NULL WHERE id = ?`)
    .run(new Date().toISOString(), jobId);
  try {
    const results = await runTranslationWorker(jobId, {
      sourceLanguage: 'ja',
      targetLanguage: chapter.target_language || 'ko',
      texts: blocks.map((block) => block.source_text),
    }, (progress) => {
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.min(95, 5 + Math.round(progress * 0.9)), jobId);
    });
    if (isJobCancelled(jobId)) return;
    if (!Array.isArray(results) || results.length !== blocks.length) throw new Error('AI 워커가 모든 OCR 블록의 번역 결과를 반환하지 않았습니다.');

    const now = new Date().toISOString();
    const saveTranslations = db.transaction(() => {
      for (const [index, result] of results.entries()) {
        const translatedText = String(result?.text || '').trim();
        if (!translatedText) continue;
        const block = blocks[index];
        const translationId = crypto.randomUUID();
        const layerId = crypto.randomUUID();
        db.prepare(`UPDATE translations SET is_active = 0, updated_at = ? WHERE ocr_block_id = ? AND target_language = ?`).run(now, block.id, chapter.target_language || 'ko');
        db.prepare(`UPDATE lettering_layers SET is_active = 0, updated_at = ? WHERE translation_id IN (SELECT id FROM translations WHERE ocr_block_id = ? AND target_language = ?)`).run(now, block.id, chapter.target_language || 'ko');
        db.prepare(`INSERT INTO translations (id, ocr_block_id, source_language, target_language, translated_text, translator_id, translator_version, glossary_version, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'ctranslate2', ?, NULL, 1, ?, ?)`).run(
          translationId,
          block.id,
          block.source_language || 'ja',
          chapter.target_language || 'ko',
          translatedText,
          path.basename(config.aiTranslationModelPath),
          now,
          now,
        );
        db.prepare(`INSERT INTO lettering_layers (id, page_id, translation_id, polygon_json, text, style_json, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
          layerId,
          block.page_id,
          translationId,
          block.polygon_json,
          translatedText,
          JSON.stringify(autoLetteringStyle(block)),
          now,
          now,
        );
      }
    });
    saveTranslations();
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`).run(finishedAt, jobId);
  } catch (error) {
    if (!isJobCancelled(jobId)) await failAutoTranslationJob(jobId, error.message || '자동 번역에 실패했습니다.');
  } finally {
    activeAiProcesses.delete(jobId);
  }
}

function autoLetteringStyle(block) {
  const polygon = parseJson(block.polygon_json, []);
  const points = polygon.filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
  if (!points.length) return normalizeLetteringStyle({ color: '#21121a', background: 'rgba(255, 255, 255, 0.92)' });
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return normalizeLetteringStyle({
    color: '#21121a',
    background: 'rgba(255, 255, 255, 0.92)',
    writingMode: height > width * 1.25 ? 'vertical-rl' : 'horizontal-tb',
    fontSize: height > width * 1.25 ? 22 : 20,
  });
}

function runTranslationWorker(jobId, payload, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(config.aiWorkerScript)) {
      reject(new Error(`AI 워커 파일을 찾을 수 없습니다: ${config.aiWorkerScript}`));
      return;
    }
    let child;
    try {
      child = spawn(config.aiWorkerCommand, [config.aiWorkerScript], {
        cwd: ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          AI_TRANSLATION_MODEL_PATH: config.aiTranslationModelPath,
          AI_TRANSLATION_TOKENIZER_PATH: config.aiTranslationTokenizerPath,
          AI_TRANSLATION_COMPUTE_TYPE: config.aiTranslationComputeType,
          AI_WORKER_THREADS: String(config.aiWorkerThreads),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`AI 워커를 시작하지 못했습니다: ${error.message}`));
      return;
    }
    activeAiProcesses.set(jobId, child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let finished = false;
    const results = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        fail(new Error(`AI 워커가 잘못된 응답을 반환했습니다: ${line.slice(0, 180)}`));
        return;
      }
      if (event.type === 'progress') onProgress(Math.min(100, Math.max(0, Number(event.progress) || 0)));
      if (event.type === 'result' && Number.isInteger(event.index)) results[event.index] = event;
      if (event.type === 'error') fail(new Error(String(event.message || 'AI 워커가 실패했습니다.')));
      if (event.type === 'done') finished = true;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => fail(new Error(`AI 워커를 실행하지 못했습니다: ${error.message}`)));
    child.on('close', (code) => {
      activeAiProcesses.delete(jobId);
      if (settled) return;
      if (code !== 0) { fail(new Error(stderr.trim().slice(-500) || `AI 워커가 종료되었습니다(${code}).`)); return; }
      if (!finished) { fail(new Error('AI 워커가 완료 이벤트 없이 종료되었습니다.')); return; }
      settled = true;
      resolve(results);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function failAutoTranslationJob(jobId, message) {
  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!current || current.status === 'cancelled') return;
  db.prepare(`UPDATE jobs SET status = 'failed', current_stage = 'failed', error_message = ?, finished_at = ? WHERE id = ?`).run(String(message).slice(0, 500), new Date().toISOString(), jobId);
}

function enqueueIngest(jobId) {
  if (!ingestQueue.includes(jobId)) ingestQueue.push(jobId);
  void drainIngestQueue();
}

async function drainIngestQueue() {
  if (ingestActive) return;
  ingestActive = true;
  try {
    while (ingestQueue.length) {
      await runIngestJob(ingestQueue.shift());
    }
  } finally {
    ingestActive = false;
  }
}

async function runIngestJob(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status === 'cancelled') return;
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(job.chapter_id);
  const sourceAsset = chapter && db.prepare('SELECT * FROM assets WHERE id = ?').get(chapter.source_asset_id);
  if (!chapter || !sourceAsset) return failIngestJob(jobId, '원본 자산을 찾을 수 없습니다.');

  const sourcePath = assetPath(sourceAsset);
  const extension = path.extname(sourceAsset.original_name).toLowerCase();
  const isPdf = sourceAsset.mime_type === 'application/pdf' || extension === '.pdf';
  const isArchive = sourceAsset.mime_type === 'application/zip' || sourceAsset.mime_type === 'application/x-cbz' || ['.zip', '.cbz'].includes(extension);
  const stage = isPdf ? 'rendering' : isArchive ? 'extracting' : 'preparing';

  db.prepare(`UPDATE jobs SET status = 'running', current_stage = ?, progress = 1, started_at = ?, error_message = NULL WHERE id = ?`)
    .run(stage, new Date().toISOString(), jobId);
  db.prepare(`UPDATE chapters SET processing_status = 'preparing', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), chapter.id);

  try {
    await clearGeneratedPages(chapter.id);
    let pageCount = 0;
    const handlePage = async (page, index, total) => {
      if (isJobCancelled(jobId)) throw new IngestCancelledError();
      const asset = await saveBufferAsset(page.buffer, page.originalName, page.mimeType, 'page');
      db.prepare('INSERT INTO pages (id, chapter_id, page_index, image_asset_id, width, height) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), chapter.id, index, asset.id, asset.width || null, asset.height || null);
      pageCount = index + 1;
      const progress = total ? Math.min(95, 5 + Math.round((pageCount / total) * 90)) : 5;
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(progress, jobId);
      db.prepare('UPDATE chapters SET page_count = ?, updated_at = ? WHERE id = ?').run(pageCount, new Date().toISOString(), chapter.id);
    };

    if (isPdf) await renderPdfPages(sourcePath, handlePage);
    else if (isArchive) await extractArchivePages(sourcePath, handlePage);
    else throw new Error('지원하지 않는 원본 형식입니다.');
    if (!pageCount) throw new Error('원본에서 이미지 페이지를 찾지 못했습니다.');

    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`).run(finishedAt, jobId);
    db.prepare(`UPDATE chapters SET processing_status = 'completed', updated_at = ? WHERE id = ?`).run(finishedAt, chapter.id);
  } catch (error) {
    await clearGeneratedPages(chapter.id);
    if (error instanceof IngestCancelledError || isJobCancelled(jobId)) return;
    await failIngestJob(jobId, error.message || '페이지 변환에 실패했습니다.');
  }
}

async function renderPdfPages(filePath, onPage) {
  const pdfData = new Uint8Array(await fsp.readFile(filePath));
  const pdf = await getDocument({ data: pdfData, disableWorker: true, useSystemFonts: true }).promise;
  try {
    if (pdf.numPages > config.maxPages) throw new Error(`PDF 페이지 수가 제한(${config.maxPages}페이지)을 초과했습니다.`);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, config.pdfRenderWidth / baseViewport.width);
        const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });
        const output = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: output.getContext('2d'), viewport }).promise;
        const buffer = output.toBuffer('image/png');
        if (buffer.length > config.maxPageBytes) throw new Error(`PDF 페이지가 제한(${Math.round(config.maxPageBytes / 1024 / 1024)}MB)을 초과했습니다.`);
        await onPage({ buffer, originalName: `page-${String(pageNumber).padStart(4, '0')}.png`, mimeType: 'image/png' }, pageNumber - 1, pdf.numPages);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdf.destroy();
  }
}

async function extractArchivePages(filePath, onPage) {
  const directory = await unzipper.Open.file(filePath);
  const files = directory.files.filter((entry) => entry.type === undefined || entry.type === 'File');
  for (const entry of directory.files) {
    if (!isSafeArchivePath(entry.path)) throw new Error('압축 파일에 안전하지 않은 경로가 포함되어 있습니다.');
    if (entry.type && !['File', 'Directory'].includes(entry.type)) throw new Error('압축 파일에 지원하지 않는 링크가 포함되어 있습니다.');
  }
  const imageEntries = files
    .filter((entry) => imageMimeForExtension(path.extname(entry.path).toLowerCase()))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }));
  if (imageEntries.length > config.maxPages) throw new Error(`압축 파일 페이지 수가 제한(${config.maxPages}페이지)을 초과했습니다.`);
  if (!imageEntries.length) throw new Error('압축 파일에서 이미지 페이지를 찾지 못했습니다.');

  let expandedBytes = 0;
  for (const [index, entry] of imageEntries.entries()) {
    const declaredSize = Number(entry.vars?.uncompressedSize || 0);
    if (declaredSize > config.maxPageBytes || expandedBytes + declaredSize > config.maxExtractedBytes) {
      throw new Error('압축 해제 후 파일 크기 제한을 초과했습니다.');
    }
    const buffer = await entry.buffer();
    if (buffer.length > config.maxPageBytes || expandedBytes + buffer.length > config.maxExtractedBytes) {
      throw new Error('압축 해제 후 파일 크기 제한을 초과했습니다.');
    }
    expandedBytes += buffer.length;
    await onPage({
      buffer,
      originalName: path.basename(entry.path),
      mimeType: imageMimeForExtension(path.extname(entry.path).toLowerCase()),
    }, index, imageEntries.length);
  }
}

async function clearGeneratedPages(chapterId) {
  const assets = db.prepare('SELECT a.* FROM assets a JOIN pages p ON p.image_asset_id = a.id WHERE p.chapter_id = ?').all(chapterId);
  db.transaction(() => {
    db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
    for (const asset of assets) db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
  })();
  await Promise.all(assets.map((asset) => fsp.unlink(assetPath(asset)).catch(() => undefined)));
}

async function failIngestJob(jobId, message) {
  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!current || current.status === 'cancelled') return;
  const now = new Date().toISOString();
  const safeMessage = String(message).slice(0, 500);
  db.prepare(`UPDATE jobs SET status = 'failed', current_stage = 'failed', error_message = ?, finished_at = ? WHERE id = ?`).run(safeMessage, now, jobId);
  db.prepare(`UPDATE chapters SET processing_status = 'failed', updated_at = ? WHERE id = ?`).run(now, current.chapter_id);
}

function isJobCancelled(jobId) {
  return db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status === 'cancelled';
}

class IngestCancelledError extends Error {}

function assetPath(asset) {
  const filePath = path.resolve(config.mediaRoot, asset.storage_key);
  if (!filePath.startsWith(`${path.resolve(config.mediaRoot)}${path.sep}`)) throw new Error('잘못된 자산 경로입니다.');
  return filePath;
}

function attachTags(seriesId, values) {
  const names = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 30);
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM series_tags WHERE series_id = ?').run(seriesId);
    for (const name of names) {
      const slug = slugify(name);
      db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET slug = excluded.slug').run(crypto.randomUUID(), name, slug);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      db.prepare('INSERT OR IGNORE INTO series_tags (series_id, tag_id) VALUES (?, ?)').run(seriesId, tag.id);
    }
  });
  transaction();
}

function insertPage(chapterId, index, asset, file) {
  db.prepare('INSERT INTO pages (id, chapter_id, page_index, image_asset_id, width, height) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), chapterId, index, asset.id, asset.width || null, asset.height || null);
}

async function saveAsset(file, kind) {
  const id = crypto.randomUUID();
  const ext = extensionFor(file.originalname, file.mimetype);
  const storageKey = `${id}${ext}`;
  const destination = path.join(config.mediaRoot, storageKey);
  await fsp.rename(file.path, destination);
  const hash = await sha256(destination);
  const dimensions = file.mimetype.startsWith('image/') ? await readImageSize(destination, file.mimetype) : {};
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, storage_key, original_name, mime_type, byte_size, sha256, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, storageKey, path.basename(file.originalname), file.mimetype, file.size, hash, kind, createdAt);
  return { id, storageKey, width: dimensions.width, height: dimensions.height };
}

async function saveBufferAsset(buffer, originalName, mimeType, kind) {
  if (buffer.length > config.maxPageBytes) throw new Error('페이지 파일 크기 제한을 초과했습니다.');
  const id = crypto.randomUUID();
  const storageKey = `${id}${extensionFor(originalName, mimeType)}`;
  const destination = path.join(config.mediaRoot, storageKey);
  await fsp.writeFile(destination, buffer, { flag: 'wx' });
  const dimensions = mimeType.startsWith('image/') ? await readImageSize(destination, mimeType) : {};
  db.prepare(`INSERT INTO assets (id, storage_key, original_name, mime_type, byte_size, sha256, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, storageKey, path.basename(originalName), mimeType, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex'), kind, new Date().toISOString());
  return { id, storageKey, width: dimensions.width, height: dimensions.height };
}

async function readImageSize(filePath, mimeType) {
  const buffer = await fsp.readFile(filePath);
  if (mimeType === 'image/png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (mimeType === 'image/gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (mimeType === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF') {
    return { width: buffer.readUInt16LE(26), height: buffer.readUInt16LE(28) };
  }
  if (mimeType === 'image/jpeg') return readJpegSize(buffer);
  return {};
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return {};
}

function extensionFor(name, mime) {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (ext && ext.length <= 8) return ext;
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tiff', 'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-cbz': '.cbz' })[mime] || '.bin';
}

function imageMimeForExtension(extension) {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff' })[extension] || null;
}

function isSafeArchivePath(value) {
  const normalized = String(value).replaceAll('\\', '/');
  const clean = path.posix.normalize(normalized);
  return Boolean(normalized) && !normalized.includes('\0') && !clean.startsWith('/') && clean !== '..' && !clean.startsWith('../');
}

function parseSortKey(value) {
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function cleanOptional(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePolygon(value) {
  const polygon = typeof value === 'string' ? parseJson(value, null) : value;
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 16) throw new Error('다각형 좌표는 3~16개의 점이어야 합니다.');
  return polygon.map((point) => {
    const x = Number(Array.isArray(point) ? point[0] : point?.x);
    const y = Number(Array.isArray(point) ? point[1] : point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('다각형 좌표는 0~1 사이의 정규화 좌표여야 합니다.');
    return { x, y };
  });
}

function normalizeLanguage(value, fallback) {
  const language = String(value || fallback).trim().toLowerCase();
  return /^[a-z]{2,10}(?:-[a-z]{2,8})?$/.test(language) ? language : fallback;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null;
}

function normalizeLetteringStyle(value) {
  const input = typeof value === 'string' ? parseJson(value, {}) : (value || {});
  const fontSize = Number(input.fontSize);
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color) : '#ffffff';
  const background = /^rgba?\([0-9.,% ]+\)$/.test(String(input.background || '')) ? String(input.background) : 'rgba(20, 14, 25, 0.72)';
  return {
    fontSize: Number.isFinite(fontSize) ? Math.min(96, Math.max(8, fontSize)) : 24,
    color,
    background,
    writingMode: ['vertical-rl', 'horizontal-tb'].includes(input.writingMode) ? input.writingMode : 'vertical-rl',
    textAlign: ['center', 'left', 'right'].includes(input.textAlign) ? input.textAlign : 'center',
    fontWeight: ['400', '600', '700'].includes(String(input.fontWeight)) ? String(input.fontWeight) : '600',
  };
}

function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '') || crypto.randomUUID();
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function resolveFromRoot(value) {
  return path.resolve(ROOT, value);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

process.on('SIGTERM', () => server.close(() => db.close()));

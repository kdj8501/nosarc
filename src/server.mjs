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
import { createInpaintMask, renderTranslatedPage } from './render.mjs';
import { autoLetteringStyle } from './lettering.mjs';
import { isKoreanTargetLanguage, isKoreanText, translateWithOllama } from './translation.mjs';

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
const venvPythonPath = path.join(ROOT, 'ai-worker', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const configuredWorkerCommand = String(process.env.AI_WORKER_COMMAND || '').trim();
const aiWorkerCommand = (!configuredWorkerCommand || ['python', 'python3', 'python.exe', 'python3.exe'].includes(configuredWorkerCommand.toLowerCase())) && fs.existsSync(venvPythonPath)
  ? venvPythonPath
  : configuredWorkerCommand || (process.platform === 'win32' ? 'python' : 'python3');

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
  ocrProvider: process.env.OCR_PROVIDER || 'manga-ocr',
  ocrLanguage: process.env.OCR_LANGUAGE || 'jpn',
  ocrLangPath: process.env.OCR_LANG_PATH || '',
  ocrCachePath: resolveFromRoot(process.env.OCR_CACHE_PATH || './data/tesseract'),
  ocrMinConfidence: Number(process.env.OCR_MIN_CONFIDENCE || 0.15),
  ocrMangaModel: process.env.OCR_MANGA_MODEL || 'kha-white/manga-ocr-base',
  ocrMangaCachePath: resolveFromRoot(process.env.OCR_MANGA_CACHE_PATH || './data/models/huggingface'),
  ocrMangaPadding: Number(process.env.OCR_MANGA_PADDING || 0.12),
  ocrTextDetectorModelPath: resolveFromRoot(process.env.OCR_TEXT_DETECTOR_MODEL_PATH || './data/models/comictextdetector.pt.onnx'),
  inpaintProvider: process.env.INPAINT_PROVIDER || 'lama',
  inpaintModelPath: resolveFromRoot(process.env.INPAINT_MODEL_PATH || './data/models/lama/inpainting_lama_2025jan.onnx'),
  inpaintWorkPath: resolveFromRoot(process.env.INPAINT_WORK_PATH || './data/inpaint'),
  inpaintThreads: Math.max(1, Number(process.env.INPAINT_THREADS || 1)),
  inpaintPadding: Number(process.env.INPAINT_PADDING || 0.008),
  letteringFontPath: process.env.LETTERING_FONT_PATH || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\malgun.ttf' : ''),
  aiTranslationProvider: String(process.env.AI_TRANSLATION_PROVIDER || 'ctranslate2').trim().toLowerCase(),
  aiTranslationOllamaUrl: process.env.AI_TRANSLATION_OLLAMA_URL || 'http://127.0.0.1:11434',
  aiTranslationOllamaModel: process.env.AI_TRANSLATION_OLLAMA_MODEL || 'qwen3:4b-instruct',
  aiTranslationOllamaTimeoutMs: Math.max(30_000, Number(process.env.AI_TRANSLATION_OLLAMA_TIMEOUT_MS || 180_000)),
  aiWorkerCommand,
  aiWorkerScript: resolveFromRoot(process.env.AI_WORKER_SCRIPT || './ai-worker/worker.py'),
  aiTranslationModelFamily: process.env.AI_TRANSLATION_MODEL_FAMILY || 'nllb',
  aiTranslationModelPath: resolveFromRoot(process.env.AI_TRANSLATION_MODEL_PATH || './data/models/nllb-200-distilled-600M-ct2'),
  aiTranslationTokenizerPath: resolveFromRoot(process.env.AI_TRANSLATION_TOKENIZER_PATH || './data/models/nllb-200-distilled-600M'),
  aiTranslationSourceCode: process.env.AI_TRANSLATION_SOURCE_CODE || 'jpn_Jpan',
  aiTranslationTargetCode: process.env.AI_TRANSLATION_TARGET_CODE || 'kor_Hang',
  aiTranslationComputeType: process.env.AI_TRANSLATION_COMPUTE_TYPE || 'int8',
  aiTranslationBeamSize: Math.max(1, Number(process.env.AI_TRANSLATION_BEAM_SIZE || 4)),
  aiTranslationBatchSize: Math.max(1, Number(process.env.AI_TRANSLATION_BATCH_SIZE || 8)),
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
await fsp.mkdir(config.ocrMangaCachePath, { recursive: true });
await fsp.mkdir(config.inpaintWorkPath, { recursive: true });
await fsp.mkdir(path.dirname(config.inpaintModelPath), { recursive: true });
await fsp.mkdir(path.dirname(config.ocrTextDetectorModelPath), { recursive: true });
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
    rendered_asset_id TEXT REFERENCES assets(id),
    UNIQUE(chapter_id, page_index)
  );
  CREATE TABLE IF NOT EXISTS ocr_blocks (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    polygon_json TEXT NOT NULL,
    inpaint_mask_json TEXT,
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

const pageColumns = db.prepare('PRAGMA table_info(pages)').all();
if (!pageColumns.some((column) => column.name === 'rendered_asset_id')) {
  db.exec('ALTER TABLE pages ADD COLUMN rendered_asset_id TEXT REFERENCES assets(id)');
}
const ocrBlockColumns = db.prepare('PRAGMA table_info(ocr_blocks)').all();
if (!ocrBlockColumns.some((column) => column.name === 'inpaint_mask_json')) {
  db.exec('ALTER TABLE ocr_blocks ADD COLUMN inpaint_mask_json TEXT');
}

const sessions = new Map();
const ingestQueue = [];
let ingestActive = false;
const ocrQueue = [];
let ocrActive = false;
const autoTranslationQueue = [];
let autoTranslationActive = false;
const renderQueue = [];
let renderActive = false;
const activeAiProcesses = new Map();
const activeOcrWorkers = new Map();
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

app.get('/api/jobs/active', (_req, res) => {
  res.json(db.prepare(`SELECT j.*, c.number_label, c.series_id, s.title AS series_title
    FROM jobs j JOIN chapters c ON c.id = j.chapter_id JOIN series s ON s.id = c.series_id
    WHERE j.status IN ('queued', 'running') ORDER BY j.created_at ASC`).all());
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

app.delete('/api/series/:id', async (req, res, next) => {
  try {
    const series = getSeries(req.params.id);
    if (!series) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    const assets = collectSeriesAssets(series.id);
    cancelJobsForChapters(listChapterIds(series.id));
    db.transaction(() => {
      db.prepare('DELETE FROM series WHERE id = ?').run(series.id);
      for (const asset of assets) db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    })();
    await removeAssetFiles(assets);
    res.json({ id: series.id, deleted: true });
  } catch (error) {
    next(error);
  }
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
    else jobId = queueOcrJob(chapterId);
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

app.delete('/api/chapters/:id', async (req, res, next) => {
  try {
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
    if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
    const assets = collectChapterAssets(chapter.id);
    cancelJobsForChapters([chapter.id]);
    db.transaction(() => {
      db.prepare('DELETE FROM chapters WHERE id = ?').run(chapter.id);
      for (const asset of assets) db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    })();
    await removeAssetFiles(assets);
    res.json({ id: chapter.id, deleted: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/chapters/:id/ocr', (req, res) => {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  if (!['tesseract', 'manga-ocr'].includes(config.ocrProvider)) return res.status(503).json({ error: `현재 OCR 제공자(${config.ocrProvider})는 사용할 수 없습니다.` });
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
  if (!['ctranslate2', 'ollama'].includes(config.aiTranslationProvider)) return res.status(503).json({ error: `현재 번역 제공자(${config.aiTranslationProvider})는 사용할 수 없습니다.` });
  if (chapter.page_count < 1 || chapter.processing_status !== 'completed') return res.status(409).json({ error: '페이지 변환이 완료된 권에서만 자동 번역을 실행할 수 있습니다.' });
  const blockCount = db.prepare(`SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?`).get(chapter.id).count;
  if (!blockCount) return res.status(409).json({ error: '먼저 OCR을 실행해 번역할 텍스트를 만들어 주세요.' });
  const activeJob = db.prepare(`SELECT * FROM jobs WHERE chapter_id = ? AND type IN ('auto_translate', 'render') AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapter.id);
  if (activeJob) return res.status(409).json({ error: '이미 자동 번역 작업이 진행 중입니다.', job_id: activeJob.id });
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'auto_translate', 'queued', 'translation', 0, ?)`).run(jobId, chapter.id, now);
  enqueueAutoTranslation(jobId);
  res.status(202).json({ id: jobId, type: 'auto_translate', status: 'queued' });
});

app.post('/api/chapters/:id/render', (req, res) => {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  const layerCount = db.prepare(`SELECT COUNT(*) AS count FROM lettering_layers l JOIN pages p ON p.id = l.page_id WHERE p.chapter_id = ? AND l.is_active = 1`).get(chapter.id).count;
  if (!layerCount) return res.status(409).json({ error: '먼저 번역문을 저장해 주세요.' });
  const activeJob = db.prepare(`SELECT * FROM jobs WHERE chapter_id = ? AND type IN ('auto_translate', 'render') AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapter.id);
  if (activeJob) return res.status(409).json({ error: '이미 이미지 렌더링 작업이 진행 중입니다.', job_id: activeJob.id });
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'render', 'queued', 'rendering', 0, ?)`).run(jobId, chapter.id, now);
  enqueueRender(jobId);
  res.status(202).json({ id: jobId, type: 'render', status: 'queued' });
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

app.patch('/api/ocr-blocks/:id', async (req, res) => {
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
  await clearRenderedPage(current.page_id);
  res.json(getOcrBlock(req.params.id));
});

app.post('/api/ocr-blocks/:id/translations', async (req, res) => {
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
  await clearRenderedPage(block.page_id);
  res.status(201).json(getTranslation(translationId));
});

app.patch('/api/lettering-layers/:id', async (req, res) => {
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
  await clearRenderedPage(current.page_id);
  res.json(getLetteringLayer(req.params.id));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare(`SELECT j.*, c.number_label, c.series_id, s.title AS series_title
    FROM jobs j JOIN chapters c ON c.id = j.chapter_id JOIN series s ON s.id = c.series_id WHERE j.id = ?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!['failed', 'cancelled'].includes(job.status)) return res.status(409).json({ error: '실패하거나 취소된 작업만 재시도할 수 있습니다.' });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE jobs SET status = 'queued', current_stage = ?, progress = 0, error_message = NULL, started_at = NULL, finished_at = NULL WHERE id = ?`).run(job.type === 'ocr' ? 'ocr' : job.type === 'auto_translate' ? 'translation' : job.type === 'render' ? 'rendering' : 'preparing', job.id);
    if (job.type === 'ingest') db.prepare(`UPDATE chapters SET processing_status = 'queued', updated_at = ? WHERE id = ?`).run(now, job.chapter_id);
  })();
  if (job.type === 'ocr') enqueueOcr(job.id);
  else if (job.type === 'auto_translate') enqueueAutoTranslation(job.id);
  else if (job.type === 'render') enqueueRender(job.id);
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
  if (job.type === 'ocr') void activeOcrWorkers.get(job.id)?.terminate().catch(() => undefined);
  if (job.type === 'auto_translate') activeAiProcesses.get(job.id)?.kill();
  if (job.type === 'render') activeAiProcesses.get(job.id)?.kill();
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
  recoverJobs();
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

function listChapterIds(seriesId) {
  return db.prepare('SELECT id FROM chapters WHERE series_id = ?').all(seriesId).map((chapter) => chapter.id);
}

function collectChapterAssets(chapterId) {
  return db.prepare(`SELECT DISTINCT a.* FROM assets a WHERE a.id IN (
    SELECT source_asset_id FROM chapters WHERE id = ?
    UNION SELECT image_asset_id FROM pages WHERE chapter_id = ?
    UNION SELECT rendered_asset_id FROM pages WHERE chapter_id = ?
  )`).all(chapterId, chapterId, chapterId);
}

function collectSeriesAssets(seriesId) {
  return db.prepare(`SELECT DISTINCT a.* FROM assets a WHERE a.id IN (
    SELECT source_asset_id FROM chapters WHERE series_id = ?
    UNION SELECT p.image_asset_id FROM pages p JOIN chapters c ON c.id = p.chapter_id WHERE c.series_id = ?
    UNION SELECT p.rendered_asset_id FROM pages p JOIN chapters c ON c.id = p.chapter_id WHERE c.series_id = ?
  )`).all(seriesId, seriesId, seriesId);
}

function cancelJobsForChapters(chapterIds) {
  if (!chapterIds.length) return;
  const placeholders = chapterIds.map(() => '?').join(', ');
  const jobs = db.prepare(`SELECT * FROM jobs WHERE chapter_id IN (${placeholders}) AND status IN ('queued', 'running')`).all(...chapterIds);
  const now = new Date().toISOString();
  for (const job of jobs) {
    db.prepare(`UPDATE jobs SET status = 'cancelled', current_stage = 'cancelled', finished_at = ? WHERE id = ?`).run(now, job.id);
    removeQueuedJob(ingestQueue, job.id);
    removeQueuedJob(ocrQueue, job.id);
    removeQueuedJob(autoTranslationQueue, job.id);
    removeQueuedJob(renderQueue, job.id);
    activeAiProcesses.get(job.id)?.kill();
    void activeOcrWorkers.get(job.id)?.terminate().catch(() => undefined);
  }
}

function removeQueuedJob(queue, jobId) {
  let index = queue.indexOf(jobId);
  while (index !== -1) {
    queue.splice(index, 1);
    index = queue.indexOf(jobId);
  }
}

async function removeAssetFiles(assets) {
  await Promise.all(assets.map((asset) => fsp.unlink(assetPath(asset)).catch(() => undefined)));
}

function listChapters(seriesId) {
  return db.prepare(`SELECT c.*, a.original_name AS source_name FROM chapters c JOIN assets a ON a.id = c.source_asset_id
    WHERE c.series_id = ? ORDER BY c.sort_key ASC, c.created_at ASC`).all(seriesId).map((chapter) => {
    const job = latestJob(chapter.id);
    return {
      ...chapter,
      ocr_block_count: db.prepare('SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?').get(chapter.id).count,
      translation_count: db.prepare('SELECT COUNT(*) AS count FROM translations t JOIN ocr_blocks b ON b.id = t.ocr_block_id JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ? AND t.is_active = 1').get(chapter.id).count,
      job_id: job?.id || null,
      job_type: job?.type || null,
      job_status: job?.status || null,
      job_stage: job?.current_stage || null,
      job_progress: job?.progress ?? null,
      job_error: job?.error_message || null,
    };
  });
}

function latestJob(chapterId) {
  return db.prepare('SELECT * FROM jobs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapterId) || null;
}

function getChapter(id) {
  const chapter = db.prepare(`SELECT c.*, s.title AS series_title, s.target_language, a.original_name AS source_name FROM chapters c
    JOIN series s ON s.id = c.series_id JOIN assets a ON a.id = c.source_asset_id WHERE c.id = ?`).get(id);
  if (!chapter) return null;
  const pages = db.prepare(`SELECT p.*, a.mime_type, a.original_name, a.id AS asset_id, ra.id AS translated_asset_id, ra.mime_type AS translated_mime_type FROM pages p JOIN assets a ON a.id = p.image_asset_id
    LEFT JOIN assets ra ON ra.id = p.rendered_asset_id
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
    translated_media_url: page.translated_asset_id ? `/media/${page.translated_asset_id}` : null,
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

function queueOcrJob(chapterId) {
  const activeJob = db.prepare(`SELECT id FROM jobs WHERE chapter_id = ? AND type = 'ocr' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapterId);
  if (activeJob) return activeJob.id;
  const jobId = crypto.randomUUID();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at)
    VALUES (?, ?, 'ocr', 'queued', 'ocr', 0, ?)`).run(jobId, chapterId, new Date().toISOString());
  enqueueOcr(jobId);
  return jobId;
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
    const detections = [];
    if (config.ocrProvider === 'manga-ocr') {
      const blocksByPage = await runComicTextDetectorWorker(jobId, pages, (progress) => {
        db.prepare('UPDATE jobs SET current_stage = ?, progress = ? WHERE id = ?').run(
          'detecting', Math.min(45, 5 + Math.round(progress * 0.4)), jobId,
        );
      });
      if (isJobCancelled(jobId)) return;
      for (const page of pages) {
        detections.push({ page, blocks: blocksByPage.get(page.page_index) || [] });
      }
    } else {
      worker = await createOcrWorker(config);
      activeOcrWorkers.set(jobId, worker);
      for (const [index, page] of pages.entries()) {
        if (isJobCancelled(jobId)) return;
        const data = await recognizePage(worker, assetPath(page));
        const blocks = extractOcrBlocks(data, page.width || 1, page.height || 1, { minConfidence: config.ocrMinConfidence });
        detections.push({ page, blocks });
        db.prepare('UPDATE jobs SET current_stage = ?, progress = ? WHERE id = ?').run(
          'ocr', Math.min(95, Math.round(((index + 1) / pages.length) * 95)), jobId,
        );
      }
      await worker.terminate().catch(() => undefined);
      worker = null;
    }

    if (config.ocrProvider === 'manga-ocr' && detections.some((detection) => detection.blocks.length)) {
      const recognized = await runMangaOcrWorker(jobId, detections, (progress) => {
        db.prepare('UPDATE jobs SET current_stage = ?, progress = ? WHERE id = ?').run('recognizing', Math.min(95, 45 + Math.round(progress * 0.5)), jobId);
      });
      if (isJobCancelled(jobId)) return;
      const existingBlockCount = db.prepare('SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?').get(job.chapter_id).count;
      if (!recognized.size && existingBlockCount) throw new Error('Manga OCR returned no readable text; existing OCR results were kept.');
      await clearOcrResults(job.chapter_id);
      for (const { page, blocks } of detections) {
        insertOcrBlocks(page, blocks, recognized, 'comic-text-detector+manga-ocr', `comictextdetector.pt.onnx + ${config.ocrMangaModel}`);
      }
    } else if (config.ocrProvider === 'manga-ocr') {
      const existingBlockCount = db.prepare('SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?').get(job.chapter_id).count;
      if (existingBlockCount) throw new Error('No text regions were detected; existing OCR results were kept.');
      await clearOcrResults(job.chapter_id);
    } else {
      await clearOcrResults(job.chapter_id);
      for (const { page, blocks } of detections) insertOcrBlocks(page, blocks, new Map(), 'tesseract', 'tesseract.js');
    }
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`).run(finishedAt, jobId);
    queueAutoTranslationJob(job.chapter_id);
  } catch (error) {
    if (!isJobCancelled(jobId)) await failOcrJob(jobId, error.message || 'OCR 처리에 실패했습니다.');
  } finally {
    activeOcrWorkers.delete(jobId);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

function insertOcrBlocks(page, blocks, recognized, modelId, modelVersion) {
  const now = new Date().toISOString();
  const insertBlocks = db.transaction(() => {
    for (const [index, block] of blocks.entries()) {
      const key = `${page.page_index}:${index}`;
      const sourceText = recognized.get(key) || block.sourceText;
      db.prepare(`INSERT INTO ocr_blocks (id, page_id, polygon_json, inpaint_mask_json, source_text, source_language, confidence, reading_order, model_id, model_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), page.id, JSON.stringify(block.polygon), JSON.stringify(block.inpaintMask || []), sourceText, config.ocrLanguage,
        block.confidence, block.readingOrder, modelId, modelVersion, now, now,
      );
    }
  });
  insertBlocks();
}

async function clearOcrResults(chapterId) {
  await clearRenderedPages(chapterId);
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

function queueAutoTranslationJob(chapterId) {
  const blockCount = db.prepare(`SELECT COUNT(*) AS count FROM ocr_blocks b JOIN pages p ON p.id = b.page_id WHERE p.chapter_id = ?`).get(chapterId).count;
  if (!blockCount) return null;
  const activeJob = db.prepare(`SELECT id FROM jobs WHERE chapter_id = ? AND type = 'auto_translate' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(chapterId);
  if (activeJob) return activeJob.id;
  const jobId = crypto.randomUUID();
  db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at)
    VALUES (?, ?, 'auto_translate', 'queued', 'translation', 0, ?)`).run(jobId, chapterId, new Date().toISOString());
  enqueueAutoTranslation(jobId);
  return jobId;
}

function recoverJobs() {
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at`).all();
  for (const job of jobs) {
    if (job.status === 'running') {
      db.prepare(`UPDATE jobs SET status = 'queued', current_stage = ?, progress = 0, started_at = NULL WHERE id = ?`)
        .run(job.type === 'ocr' ? 'ocr' : job.type === 'auto_translate' ? 'translation' : job.type === 'render' ? 'rendering' : 'preparing', job.id);
    }
    if (job.type === 'ocr') enqueueOcr(job.id);
    else if (job.type === 'auto_translate') enqueueAutoTranslation(job.id);
    else if (job.type === 'render') enqueueRender(job.id);
    else enqueueIngest(job.id);
  }
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

function enqueueRender(jobId) {
  if (!renderQueue.includes(jobId)) renderQueue.push(jobId);
  void drainRenderQueue();
}

async function drainRenderQueue() {
  if (renderActive) return;
  renderActive = true;
  try {
    while (renderQueue.length) await runRenderJob(renderQueue.shift());
  } finally {
    renderActive = false;
  }
}

async function runRenderJob(jobId) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND type = 'render'`).get(jobId);
  if (!job || job.status === 'cancelled') return;
  db.prepare(`UPDATE jobs SET status = 'running', current_stage = 'rendering', progress = 1, started_at = ?, error_message = NULL WHERE id = ?`)
    .run(new Date().toISOString(), jobId);
  try {
    const rendered = await renderChapterImages(job.chapter_id, jobId, (progress) => {
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.min(99, Math.max(1, Math.round(progress))), jobId);
    });
    if (!rendered || isJobCancelled(jobId)) return;
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`)
      .run(new Date().toISOString(), jobId);
  } catch (error) {
    if (!isJobCancelled(jobId)) {
      db.prepare(`UPDATE jobs SET status = 'failed', current_stage = 'failed', error_message = ?, finished_at = ? WHERE id = ?`)
        .run(String(error.message || '이미지 렌더링에 실패했습니다.').slice(0, 500), new Date().toISOString(), jobId);
    }
  }
}

async function renderChapterImages(chapterId, jobId = null, onProgress = () => {}) {
  const pages = db.prepare(`SELECT p.*, a.storage_key, a.original_name, a.mime_type
    FROM pages p JOIN assets a ON a.id = p.image_asset_id WHERE p.chapter_id = ? ORDER BY p.page_index`).all(chapterId);
  const layers = db.prepare(`SELECT l.*, b.inpaint_mask_json FROM lettering_layers l JOIN pages p ON p.id = l.page_id
    LEFT JOIN translations t ON t.id = l.translation_id
    LEFT JOIN ocr_blocks b ON b.id = t.ocr_block_id
    WHERE p.chapter_id = ? AND l.is_active = 1 AND TRIM(l.text) <> '' ORDER BY l.created_at`).all(chapterId);
  const layersByPage = groupBy(layers, 'page_id');
  const workToken = crypto.randomUUID();
  const inpaintPages = [];
  let completedInpaintProgress = 0;
  try {
    onProgress(0);
    for (const page of pages) {
      const pageLayers = layersByPage[page.id] || [];
      if (!pageLayers.length) continue;
      const maskPath = path.join(config.inpaintWorkPath, `${workToken}-${page.id}-mask.png`);
      const outputPath = path.join(config.inpaintWorkPath, `${workToken}-${page.id}-lama.png`);
      await fsp.writeFile(maskPath, await createInpaintMask(assetPath(page), pageLayers, { inpaintPadding: config.inpaintPadding }));
      inpaintPages.push({ pageId: page.id, imagePath: assetPath(page), maskPath, outputPath });
    }

    let aiOutputs = new Map();
    if (config.inpaintProvider === 'lama' && inpaintPages.length && fs.existsSync(config.inpaintModelPath)) {
      try {
        aiOutputs = await runLamaInpaintWorker(jobId || workToken, inpaintPages, (progress) => {
          const fraction = Math.min(1, Math.max(0, (progress - 5) / 90));
          completedInpaintProgress = Math.max(completedInpaintProgress, fraction * 45);
          onProgress(completedInpaintProgress);
        });
      } catch (error) {
        if (jobId && isJobCancelled(jobId)) return false;
        console.warn(`LaMa 인페인팅을 사용할 수 없어 CPU 보간으로 대체합니다: ${error.message}`);
      }
    }

    const pageRenderProgress = 100 - completedInpaintProgress;
    for (const [index, page] of pages.entries()) {
      if (jobId && isJobCancelled(jobId)) return false;
      const pageLayers = layersByPage[page.id] || [];
      const pageProgress = (fraction) => completedInpaintProgress
        + pageRenderProgress * (index + Math.min(1, Math.max(0, fraction))) / Math.max(1, pages.length);
      if (pageLayers.length) {
        const aiOutput = aiOutputs.get(page.id);
        const basePath = aiOutput || assetPath(page);
        const buffer = await renderTranslatedPage(basePath, pageLayers, {
          inpaintPadding: config.inpaintPadding,
          fontPath: config.letteringFontPath,
          skipInpaint: Boolean(aiOutput),
          onInpaintProgress: (fraction) => onProgress(pageProgress(fraction)),
        });
        await saveRenderedPage(page, buffer);
      } else {
        await clearRenderedPage(page.id);
      }
      onProgress(pageProgress(1));
    }
    return true;
  } finally {
    await Promise.all(inpaintPages.flatMap((page) => [page.maskPath, page.outputPath].map((filePath) => fsp.unlink(filePath).catch(() => undefined))));
  }
}

async function saveRenderedPage(page, buffer) {
  const assetId = crypto.randomUUID();
  const storageKey = `${assetId}.png`;
  const destination = path.join(config.mediaRoot, storageKey);
  await fsp.writeFile(destination, buffer, { flag: 'wx' });
  let previousAsset = null;
  try {
    const now = new Date().toISOString();
    previousAsset = db.prepare(`SELECT a.* FROM pages p LEFT JOIN assets a ON a.id = p.rendered_asset_id WHERE p.id = ?`).get(page.id);
    db.transaction(() => {
      db.prepare(`INSERT INTO assets (id, storage_key, original_name, mime_type, byte_size, sha256, kind, created_at)
        VALUES (?, ?, ?, 'image/png', ?, ?, 'page', ?)`).run(
        assetId,
        storageKey,
        `translated-${Number(page.page_index) + 1}.png`,
        buffer.length,
        crypto.createHash('sha256').update(buffer).digest('hex'),
        now,
      );
      db.prepare('UPDATE pages SET rendered_asset_id = ? WHERE id = ?').run(assetId, page.id);
      if (previousAsset?.id) db.prepare('DELETE FROM assets WHERE id = ?').run(previousAsset.id);
    })();
  } catch (error) {
    await fsp.unlink(destination).catch(() => undefined);
    throw error;
  }
  if (previousAsset?.storage_key) await fsp.unlink(path.join(config.mediaRoot, previousAsset.storage_key)).catch(() => undefined);
}

async function clearRenderedPage(pageId) {
  const previousAsset = db.prepare(`SELECT a.* FROM pages p LEFT JOIN assets a ON a.id = p.rendered_asset_id WHERE p.id = ?`).get(pageId);
  if (!previousAsset?.id) return;
  db.transaction(() => {
    db.prepare('UPDATE pages SET rendered_asset_id = NULL WHERE id = ?').run(pageId);
    db.prepare('DELETE FROM assets WHERE id = ?').run(previousAsset.id);
  })();
  await fsp.unlink(path.join(config.mediaRoot, previousAsset.storage_key)).catch(() => undefined);
}

async function clearRenderedPages(chapterId) {
  const previousAssets = db.prepare(`SELECT a.* FROM pages p JOIN assets a ON a.id = p.rendered_asset_id WHERE p.chapter_id = ?`).all(chapterId);
  if (!previousAssets.length) return;
  db.transaction(() => {
    db.prepare('UPDATE pages SET rendered_asset_id = NULL WHERE chapter_id = ?').run(chapterId);
    const deleteAsset = db.prepare('DELETE FROM assets WHERE id = ?');
    for (const asset of previousAssets) deleteAsset.run(asset.id);
  })();
  await Promise.all(previousAssets.map((asset) => fsp.unlink(path.join(config.mediaRoot, asset.storage_key)).catch(() => undefined)));
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
    await clearRenderedPages(chapter.id);
    const updateTranslationProgress = (progress) => {
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.min(75, 3 + Math.round(progress * 0.72)), jobId);
    };
    let results;
    if (config.aiTranslationProvider === 'ollama') {
      const controller = new AbortController();
      activeAiProcesses.set(jobId, { kill: () => controller.abort() });
      results = await translateWithOllama(blocks, {
        baseUrl: config.aiTranslationOllamaUrl,
        model: config.aiTranslationOllamaModel,
        targetLanguage: chapter.target_language || 'ko',
        batchSize: config.aiTranslationBatchSize,
        timeoutMs: config.aiTranslationOllamaTimeoutMs,
        signal: controller.signal,
        isCancelled: () => isJobCancelled(jobId),
        onProgress: updateTranslationProgress,
      });
    } else {
      results = await runTranslationWorker(jobId, {
        sourceLanguage: 'ja',
        targetLanguage: chapter.target_language || 'ko',
        sourceCode: config.aiTranslationSourceCode,
        targetCode: config.aiTranslationTargetCode,
        texts: blocks.map((block) => block.source_text),
      }, updateTranslationProgress);
    }
    if (isJobCancelled(jobId)) return;
    if (!Array.isArray(results) || results.length !== blocks.length) throw new Error('AI 워커가 모든 OCR 블록의 번역 결과를 반환하지 않았습니다.');

    if (isKoreanTargetLanguage(chapter.target_language || 'ko')
      && results.some((result) => String(result?.text || '').trim() && !isKoreanText(result.text))) {
      throw new Error('번역 모델이 한국어가 아닌 문장을 반환해 저장을 중단했습니다. 목표 언어와 모델 설정을 확인해 주세요.');
    }

    const now = new Date().toISOString();
    const translatorId = config.aiTranslationProvider === 'ollama' ? 'ollama' : 'ctranslate2';
    const translatorVersion = config.aiTranslationProvider === 'ollama'
      ? config.aiTranslationOllamaModel
      : path.basename(config.aiTranslationModelPath);
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
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`).run(
          translationId,
          block.id,
          block.source_language || 'ja',
          chapter.target_language || 'ko',
          translatedText,
          translatorId,
          translatorVersion,
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
          JSON.stringify(autoLetteringStyle(block, translatedText, chapter.target_language || 'ko')),
          now,
          now,
        );
      }
    });
    saveTranslations();
    if (isJobCancelled(jobId)) return;
    db.prepare('UPDATE jobs SET current_stage = ?, progress = ? WHERE id = ?').run('rendering', 75, jobId);
    const rendered = await renderChapterImages(chapter.id, jobId, (progress) => {
      db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.min(99, 75 + Math.round(progress * 0.24)), jobId);
    });
    if (!rendered || isJobCancelled(jobId)) return;
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE jobs SET status = 'completed', current_stage = 'completed', progress = 100, finished_at = ?, error_message = NULL WHERE id = ?`).run(finishedAt, jobId);
  } catch (error) {
    if (!isJobCancelled(jobId)) await failAutoTranslationJob(jobId, error.message || '자동 번역에 실패했습니다.');
  } finally {
    activeAiProcesses.delete(jobId);
  }
}

function runAiWorkerProcess(jobId, payload, onEvent, extraEnv = {}) {
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
          AI_TRANSLATION_MODEL_FAMILY: config.aiTranslationModelFamily,
          AI_TRANSLATION_MODEL_PATH: config.aiTranslationModelPath,
          AI_TRANSLATION_TOKENIZER_PATH: config.aiTranslationTokenizerPath,
          AI_TRANSLATION_COMPUTE_TYPE: config.aiTranslationComputeType,
          AI_TRANSLATION_BEAM_SIZE: String(config.aiTranslationBeamSize),
          AI_TRANSLATION_BATCH_SIZE: String(config.aiTranslationBatchSize),
          AI_WORKER_THREADS: String(config.aiWorkerThreads),
          HF_HOME: config.ocrMangaCachePath,
          OCR_MANGA_MODEL: config.ocrMangaModel,
          OCR_MANGA_PADDING: String(config.ocrMangaPadding),
          OCR_TEXT_DETECTOR_MODEL_PATH: config.ocrTextDetectorModelPath,
          INPAINT_PROVIDER: config.inpaintProvider,
          INPAINT_MODEL_PATH: config.inpaintModelPath,
          INPAINT_THREADS: String(config.inpaintThreads),
          ...extraEnv,
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
      try {
        onEvent(event);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
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
      if (stdout.trim()) handleLine(stdout.trim());
      if (code !== 0) { fail(new Error(stderr.trim().slice(-500) || `AI 워커가 종료되었습니다(${code}).`)); return; }
      if (!finished) { fail(new Error('AI 워커가 완료 이벤트 없이 종료되었습니다.')); return; }
      settled = true;
      resolve();
    });
    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      fail(new Error(`AI 워커 입력을 전달하지 못했습니다: ${error.message}`));
    }
  });
}

function runTranslationWorker(jobId, payload, onProgress) {
  const results = [];
  return runAiWorkerProcess(jobId, payload, (event) => {
    if (event.type === 'progress') {
      onProgress(Math.min(100, Math.max(0, Number(event.progress) || 0)));
    }
    if (event.type === 'result' && Number.isInteger(event.index)) results[event.index] = event;
  }).then(() => results);
}

async function runMangaOcrWorker(jobId, detections, onProgress) {
  const results = new Map();
  const pages = detections.map(({ page, blocks }) => ({
    pageIndex: page.page_index,
    imagePath: assetPath(page),
    candidates: blocks.map((block, candidateIndex) => ({
      candidateIndex,
      polygon: block.polygon,
    })),
  }));
  await runAiWorkerProcess(jobId, { kind: 'ocr', pages }, (event) => {
    if (event.type === 'progress') {
      onProgress(Math.min(100, Math.max(0, Number(event.progress) || 0)));
    }
    if (event.type === 'ocr_result' && Number.isInteger(event.pageIndex) && Number.isInteger(event.candidateIndex)) {
      const text = String(event.text || '').trim();
      if (text) results.set(`${event.pageIndex}:${event.candidateIndex}`, text);
    }
  });
  return results;
}

async function runComicTextDetectorWorker(jobId, pages, onProgress) {
  const blocksByPage = new Map(pages.map((page) => [page.page_index, []]));
  const detectorPages = pages.map((page) => ({ pageIndex: page.page_index, imagePath: assetPath(page) }));
  await runAiWorkerProcess(jobId, { kind: 'detect', pages: detectorPages }, (event) => {
    if (event.type === 'progress') {
      onProgress(Math.min(100, Math.max(0, Number(event.progress) || 0)));
    }
    if (event.type === 'detection_result' && Number.isInteger(event.pageIndex) && Number.isInteger(event.candidateIndex)) {
      const [left, top, right, bottom] = Array.isArray(event.bbox) ? event.bbox.map(Number) : [];
      if (![left, top, right, bottom].every(Number.isFinite)) return;
      const blocks = blocksByPage.get(event.pageIndex);
      if (!blocks) return;
      blocks[event.candidateIndex] = {
        polygon: [
          { x: left, y: top }, { x: right, y: top },
          { x: right, y: bottom }, { x: left, y: bottom },
        ],
        inpaintMask: normalizeInpaintMask(event.maskPolygons),
        sourceText: '',
        confidence: event.confidence == null || !Number.isFinite(Number(event.confidence)) ? null : Number(event.confidence),
        readingOrder: event.candidateIndex,
      };
    }
  });
  for (const [pageIndex, blocks] of blocksByPage) {
    blocksByPage.set(pageIndex, blocks.filter(Boolean));
  }
  return blocksByPage;
}

function normalizeInpaintMask(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((polygon) => {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 16) return [];
    const points = polygon.map((point) => ({ x: Number(point?.x), y: Number(point?.y) }));
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return [];
    return [points.map((point) => ({ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) }))];
  });
}

async function runLamaInpaintWorker(jobId, pages, onProgress) {
  const outputs = new Map();
  await runAiWorkerProcess(jobId, { kind: 'inpaint', pages }, (event) => {
    if (event.type === 'progress') {
      onProgress(Math.min(100, Math.max(0, Number(event.progress) || 0)));
    }
    if (event.type === 'inpaint_result' && event.pageId && event.outputPath) {
      outputs.set(String(event.pageId), String(event.outputPath));
    }
  });
  return outputs;
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
    queueOcrJob(chapter.id);
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
  const status = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status;
  return !status || status === 'cancelled';
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
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color) : '#21121a';
  const savedBackground = /^rgba?\([0-9.,% ]+\)$/.test(String(input.background || '')) ? String(input.background) : 'rgba(255, 255, 255, 0)';
  const background = savedBackground === 'rgba(255, 255, 255, 0.92)' ? 'rgba(255, 255, 255, 0)' : savedBackground;
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

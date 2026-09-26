import 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import multer from 'multer';

import {
  createSessionToken,
  parseCookies,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './security.mjs';

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
};

if (config.env === 'production' && !config.sessionSecret) {
  throw new Error('SESSION_SECRET is required in production.');
}

const dataRoot = path.dirname(config.databasePath);
const uploadRoot = path.join(dataRoot, 'uploads');
await fsp.mkdir(config.mediaRoot, { recursive: true });
await fsp.mkdir(uploadRoot, { recursive: true });

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
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { fallthrough: false }));

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: config.maxUploadBytes, files: config.maxPages },
  fileFilter: (_req, file, callback) => {
    if (allowedMimeTypes.has(file.mimetype.toLowerCase())) return callback(null, true);
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
    const status = files.length === 1 && !first.mimetype.startsWith('image/') ? 'preparing' : 'completed';

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
      if (files.length === 1 && !first.mimetype.startsWith('image/')) {
        db.prepare(`INSERT INTO jobs (id, chapter_id, type, status, current_stage, progress, created_at) VALUES (?, ?, 'ingest', 'queued', 'preparing', 0, ?)`)
          .run(crypto.randomUUID(), chapterId, now);
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
    res.status(202).json({ id: chapterId, status, chapter: getChapter(chapterId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chapters/:id', (req, res) => {
  const chapter = getChapter(req.params.id);
  if (!chapter) return res.status(404).json({ error: '권을 찾을 수 없습니다.' });
  res.json(chapter);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
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
    WHERE c.series_id = ? ORDER BY c.sort_key ASC, c.created_at ASC`).all(seriesId);
}

function getChapter(id) {
  const chapter = db.prepare(`SELECT c.*, s.title AS series_title, a.original_name AS source_name FROM chapters c
    JOIN series s ON s.id = c.series_id JOIN assets a ON a.id = c.source_asset_id WHERE c.id = ?`).get(id);
  if (!chapter) return null;
  chapter.pages = db.prepare(`SELECT p.*, a.mime_type, a.original_name, a.id AS asset_id FROM pages p JOIN assets a ON a.id = p.image_asset_id
    WHERE p.chapter_id = ? ORDER BY p.page_index`).all(id).map((page) => ({ ...page, media_url: `/media/${page.asset_id}` }));
  return chapter;
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

function parseSortKey(value) {
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function cleanOptional(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
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

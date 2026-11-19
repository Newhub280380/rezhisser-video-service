'use strict';

// "Film from your own photos": fixed pre-processing in front of image-to-video.
//
// Every upload goes through the same chain and ends as a clean JPEG that the
// video model receives as the first frame of a scene:
//
//   1. remove background  — external command (FILM_REMOVE_BG_COMMAND), optional
//   2. enhance / upscale  — external command (FILM_ENHANCE_COMMAND), optional
//   3. normalize          — built in, ffmpeg: flatten transparency onto white,
//                           fit into 1280 px, strip metadata, JPEG
//
// The project ships no background-removal or enhancement model, so steps 1–2
// run only when the operator points them at one. A step that did not run is
// reported as `skipped` (or `failed`), never as done, and the photo continues
// with what it had.
//
// Prepared photos are stored per account and addressed by content hash; a job
// refers to them by id, so a client never supplies a file path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanText } = require('./schema.js');

const MAX_PHOTOS = 24;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1280;
const STEP_ORDER = ['remove-bg', 'enhance', 'normalize'];
const PHOTO_ID = /^[a-f0-9]{64}$/;
const USER_DIR = /^[A-Za-z0-9-]{1,64}$/;

class PhotoError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
    if (field) this.field = field;
  }
}

function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// Decodes `data:image/...;base64,...` and checks the real magic bytes, never
// the declared mime type.
function decodeUpload(value, { maxBytes = MAX_BYTES } = {}) {
  if (typeof value !== 'string') throw new PhotoError('invalid_photo', 'Фото должно быть data:URL.');
  const match = value.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new PhotoError('invalid_photo', 'Ожидается data:URL с base64.');
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) throw new PhotoError('invalid_photo', 'Пустой файл.');
  if (buffer.length > maxBytes) throw new PhotoError('photo_too_large', `Файл больше ${Math.round(maxBytes / 1024)} КБ.`);
  const sniffed = sniffImage(buffer);
  if (!sniffed) throw new PhotoError('unsupported_photo', 'Поддерживаются PNG, JPEG, WebP.');
  return { buffer, ...sniffed, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

// Fixed argv, no shell, hard timeout.
function runStep(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve({ ok: false, code: 'tool_missing' });
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', () => finish({ ok: false, code: 'tool_missing' }));
    child.on('close', (status) => finish({ ok: status === 0, code: status === 0 ? 'ok' : 'step_failed', stderr }));
  });
}

// "rembg i {in} {out}" -> { bin: 'rembg', args: ['i', <in>, <out>] }.
function commandFor(template, inPath, outPath) {
  const parts = String(template).trim().split(/\s+/).map((token) => token.split('{in}').join(inPath).split('{out}').join(outPath));
  return { bin: parts[0], args: parts.slice(1) };
}

function normalizeArgs(inPath, outPath, maxSide = MAX_SIDE) {
  const graph = [
    `[0:v]format=rgba,scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease,split[fg][shape]`,
    // A white plate of the same size, so transparent areas end up white.
    '[shape]drawbox=color=white@1:t=fill:replace=1[plate]',
    '[plate][fg]overlay=format=auto,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuvj420p[out]',
  ].join(';');
  return ['-y', '-i', inPath, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', '2', '-map_metadata', '-1', outPath];
}

function createPhotoPipeline({
  workDir,
  ffmpegBin = 'ffmpeg',
  steps = {},
  maxBytes = MAX_BYTES,
  stepTimeoutMs = 120000,
  runner = runStep,
} = {}) {
  const external = { 'remove-bg': steps.removeBg || '', enhance: steps.enhance || '' };

  function capability() {
    return {
      steps: [
        { step: 'remove-bg', configured: Boolean(external['remove-bg']), engine: external['remove-bg'] ? 'external command' : null },
        { step: 'enhance', configured: Boolean(external.enhance), engine: external.enhance ? 'external command' : null },
        { step: 'normalize', configured: true, engine: 'ffmpeg' },
      ],
      missing: [
        ...(external['remove-bg'] ? [] : ['FILM_REMOVE_BG_COMMAND']),
        ...(external.enhance ? [] : ['FILM_ENHANCE_COMMAND']),
      ],
      maxPhotos: MAX_PHOTOS,
      maxBytes,
    };
  }

  function dirFor(userId) {
    if (!workDir || !USER_DIR.test(String(userId))) throw new PhotoError('invalid_owner', 'Не удалось определить владельца фото.');
    return path.join(workDir, String(userId));
  }

  async function prepareDecoded(decoded, dir) {
    const base = path.join(dir, decoded.sha256);
    const sourcePath = `${base}.src.${decoded.ext}`;
    fs.writeFileSync(sourcePath, decoded.buffer);
    const temporary = [sourcePath];
    const report = [];
    let current = sourcePath;
    for (const step of ['remove-bg', 'enhance']) {
      if (!external[step]) {
        report.push({ step, status: 'skipped', reason: 'not_configured' });
        continue;
      }
      const outPath = `${base}.${step}.png`;
      const { bin, args } = commandFor(external[step], current, outPath);
      const result = await runner(bin, args, { timeoutMs: stepTimeoutMs });
      if (result.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        report.push({ step, status: 'done' });
        temporary.push(outPath);
        current = outPath;
      } else {
        // The chain goes on with the previous file; the report says this step
        // did not happen.
        report.push({ step, status: 'failed', reason: result.code || 'step_failed' });
      }
    }
    const finalPath = `${base}.jpg`;
    const normalized = await runner(ffmpegBin, normalizeArgs(current, finalPath), { timeoutMs: stepTimeoutMs });
    for (const file of temporary) fs.rmSync(file, { force: true });
    if (!normalized.ok || !fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      fs.rmSync(finalPath, { force: true });
      throw new PhotoError(
        normalized.code === 'tool_missing' ? 'ffmpeg_missing' : 'normalize_failed',
        normalized.code === 'tool_missing' ? 'Не найден ffmpeg: фото нельзя подготовить.' : 'Не удалось подготовить фото.',
      );
    }
    report.push({ step: 'normalize', status: 'done' });
    return {
      id: decoded.sha256,
      bytes: fs.statSync(finalPath).size,
      report,
      // True only when no configured step failed.
      fullyProcessed: report.every((entry) => entry.status !== 'failed'),
    };
  }

  async function prepareAll(uploads, { userId } = {}) {
    if (!Array.isArray(uploads) || uploads.length === 0) throw new PhotoError('photos_required', 'Загрузите хотя бы одно фото.');
    if (uploads.length > MAX_PHOTOS) throw new PhotoError('too_many_photos', `Не больше ${MAX_PHOTOS} фото.`);
    const dir = dirFor(userId);
    fs.mkdirSync(dir, { recursive: true });
    const seen = new Set();
    const prepared = [];
    for (const upload of uploads) {
      const decoded = decodeUpload(upload, { maxBytes });
      // The same photo twice would render the same scene twice.
      if (seen.has(decoded.sha256)) continue;
      seen.add(decoded.sha256);
      prepared.push(await prepareDecoded(decoded, dir));
    }
    return prepared;
  }

  // ids -> files, only inside this account's folder.
  function resolve(userId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    if (ids.length > MAX_PHOTOS) throw new PhotoError('too_many_photos', `Не больше ${MAX_PHOTOS} фото.`);
    const dir = dirFor(userId);
    return ids.map((id) => {
      const file = PHOTO_ID.test(String(id)) ? path.join(dir, `${id}.jpg`) : null;
      if (!file || !fs.existsSync(file)) throw new PhotoError('unknown_photo', 'Фото не найдено: загрузите его заново.', 'photoIds');
      return { id, path: file };
    });
  }

  return { capability, prepareAll, resolve };
}

// The identity block appended to every scene prompt of a film, so the model is
// told the same cast, places and look in each shot.
function consistencyPrompt({ characters = [], locations = [], style = '' } = {}) {
  const cast = characters
    .map((item) => `${cleanText(item.name, 60)}: ${cleanText(item.description, 200)}${item.wardrobe ? `, wardrobe: ${cleanText(item.wardrobe, 120)}` : ''}`)
    .join('; ');
  const places = locations.map((item) => `${cleanText(item.name, 60)}: ${cleanText(item.description, 160)}`).join('; ');
  return [
    'CONSISTENCY LOCK (identical in every shot, do not redesign):',
    cast ? `Characters — ${cast}.` : '',
    places ? `Locations — ${places}.` : '',
    style ? `Look — ${cleanText(style, 200)}.` : '',
    'Same face, same hair, same wardrobe, same room layout and props as in the reference.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1200);
}

module.exports = {
  MAX_PHOTOS,
  MAX_BYTES,
  STEP_ORDER,
  PhotoError,
  sniffImage,
  decodeUpload,
  normalizeArgs,
  commandFor,
  runStep,
  createPhotoPipeline,
  consistencyPrompt,
};

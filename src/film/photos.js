'use strict';

// "Film from your own photos": fixed pre-processing in front of the renderer.
//
// Every upload goes through the same chain and leaves up to three files in the
// account's folder, all addressed by the content hash of the upload:
//
//   <id>.jpg       clean JPEG, <= 1280 px — first frame for a video model
//   <id>.full.jpg  clean JPEG, <= 2560 px — source for the built-in studio
//   <id>.cut.png   the subject alone on transparency, cropped to its outline
//                  (only when background removal ran and found a subject)
//
// Steps (run in this order; a report lists them as remove-bg, enhance,
// normalize):
//   1. enhance — built in (ffmpeg: light denoise, sharpen, Lanczos resize), or
//      the command in FILM_ENHANCE_COMMAND. The built-in step cleans a photo
//      up; it does not invent detail the way a super-resolution model does.
//   2. normalize — built in: transparency flattened onto white, metadata
//      stripped, even dimensions, JPEG.
//   3. remove background — `rembg` when it is installed (found on PATH), or
//      the command in FILM_REMOVE_BG_COMMAND; "off" disables the step. It runs
//      on the cleaned photo, so its input is always a bounded, plain JPEG.
//
// A step that did not run is reported as `skipped` or `failed`, never as
// done, and the photo continues with what it had.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./compose.js');
const { cleanText } = require('./schema.js');

const MAX_PHOTOS = 24;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1280;
const FULL_SIDE = 2560;
const CUT_SIDE = { min: 1600, max: 2400 };
const REMBG_MODEL = /^[a-z0-9_-]{2,40}$/;
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

// Looks a tool up on PATH without starting it.
function findOnPath(name, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// "rembg i {in} {out}" -> { bin: 'rembg', args: ['i', <in>, <out>] }.
function commandFor(template, inPath, outPath) {
  const parts = String(template).trim().split(/\s+/).map((token) => token.split('{in}').join(inPath).split('{out}').join(outPath));
  return { bin: parts[0], args: parts.slice(1) };
}

const ENHANCE = 'hqdn3d=1.2:1.2:0:0,unsharp=5:5:0.5:5:5:0';

function normalizeArgs(inPath, outPath, maxSide = MAX_SIDE, { enhance = false } = {}) {
  const graph = [
    `[0:v]format=rgba,scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos,split[fg][shape]`,
    // A white plate of the same size, so transparent areas end up white.
    '[shape]drawbox=color=white@1:t=fill:replace=1[plate]',
    `[plate][fg]overlay=format=auto,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white${enhance ? `,${ENHANCE}` : ''},format=yuvj420p[out]`,
  ].join(';');
  return ['-y', '-i', inPath, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', '2', '-map_metadata', '-1', outPath];
}

// Prints the outline of the opaque area of a cut-out and its share of the
// frame. With `mask` the white/opaque area of a mask image is measured
// instead, after scaling the mask to `size`.
function outlineArgs(inPath, { mask = false, size = null } = {}) {
  const chain = [
    size ? `scale=${size.width}:${size.height}:flags=neighbor` : '',
    'format=rgba',
    mask ? 'premultiply=inplace=1,format=gray' : 'alphaextract',
    'bbox=min_val=32',
    'signalstats',
    'metadata=mode=print:file=-',
  ].filter(Boolean).join(',');
  return ['-v', 'error', '-i', inPath, '-vf', chain, '-frames:v', '1', '-f', 'null', '-'];
}

function parseOutline(stdout) {
  const value = (key) => {
    const match = String(stdout || '').match(new RegExp(`${key.replace(/\./g, '\\.')}=([0-9.]+)`));
    return match ? Number(match[1]) : NaN;
  };
  const box = { x: value('lavfi.bbox.x1'), y: value('lavfi.bbox.y1'), w: value('lavfi.bbox.w'), h: value('lavfi.bbox.h') };
  const coverage = value('lavfi.signalstats.YAVG') / 255;
  if (![box.x, box.y, box.w, box.h, coverage].every(Number.isFinite)) return null;
  return { box, coverage };
}

// The subject alone: cropped to its outline, cleaned up, alpha kept.
function cutoutArgs(inPath, outPath, box, { enhance = false } = {}) {
  const factor = `min(${CUT_SIDE.max}/max(iw,ih),max(1,${CUT_SIDE.min}/max(iw,ih)))`;
  const sized = `[0:v]format=rgba,crop=${box.w}:${box.h}:${box.x}:${box.y},scale=w='trunc(iw*${factor}/2)*2':h='trunc(ih*${factor}/2)*2':flags=lanczos,format=rgba`;
  const graph = enhance
    ? `${sized},split[c][a];[a]alphaextract[al];[c]format=yuv444p,${ENHANCE}[e];[e][al]alphamerge,format=rgba[out]`
    : `${sized}[out]`;
  return ['-y', '-i', inPath, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-map_metadata', '-1', outPath];
}

function createPhotoPipeline({
  workDir,
  ffmpegBin = 'ffmpeg',
  steps = {},
  rembgModel = 'u2netp',
  maxBytes = MAX_BYTES,
  stepTimeoutMs = 180000,
  runner = run,
  env = process.env,
} = {}) {
  const model = REMBG_MODEL.test(String(rembgModel)) ? String(rembgModel) : 'u2netp';
  // "" or "auto": use rembg when it is installed; "off": never.
  const wanted = String(steps.removeBg || '').trim();
  const detected = !wanted || wanted === 'auto' ? findOnPath('rembg', env) : null;
  const removeBg = wanted === 'off' ? null
    : detected ? { engine: `rembg (${model})`, bin: detected, args: (input, output) => ['i', '-m', model, input, output] }
      : wanted && wanted !== 'auto' ? { engine: 'external command', template: wanted }
        : null;
  const enhanceCommand = String(steps.enhance || '').trim();

  function capability() {
    return {
      steps: [
        { step: 'remove-bg', configured: Boolean(removeBg), engine: removeBg ? removeBg.engine : null },
        { step: 'enhance', configured: true, engine: enhanceCommand ? 'external command' : 'ffmpeg (denoise, sharpen, lanczos)' },
        { step: 'normalize', configured: true, engine: 'ffmpeg' },
      ],
      // Only what is really absent: enhancement and normalisation are built in.
      missing: removeBg ? [] : ['FILM_REMOVE_BG_COMMAND'],
      maxPhotos: MAX_PHOTOS,
      maxBytes,
    };
  }

  function dirFor(userId) {
    if (!workDir || !USER_DIR.test(String(userId))) throw new PhotoError('invalid_owner', 'Не удалось определить владельца фото.');
    return path.join(workDir, String(userId));
  }

  const produced = (file) => fs.existsSync(file) && fs.statSync(file).size > 0;

  // Background removal -> RGBA PNG of the same size as the input, or null.
  async function cutSubject(inPath, outPath, timeoutMs = stepTimeoutMs) {
    if (!removeBg) return { ok: false, reason: 'not_configured', skipped: true };
    const command = removeBg.template ? commandFor(removeBg.template, inPath, outPath) : { bin: removeBg.bin, args: removeBg.args(inPath, outPath) };
    const result = await runner(command.bin, command.args, { timeoutMs });
    if (!result.ok || !produced(outPath)) {
      fs.rmSync(outPath, { force: true });
      return { ok: false, reason: result.code === 'tool_missing' ? 'tool_missing' : 'step_failed' };
    }
    const probe = await runner(ffmpegBin, outlineArgs(outPath), { timeoutMs: 60000, capture: true });
    const outline = probe.ok ? parseOutline(probe.stdout) : null;
    // No transparency at all, or almost nothing left: no subject was separated.
    if (!outline || outline.coverage > 0.97 || outline.coverage < 0.005 || outline.box.w < 16 || outline.box.h < 16) {
      fs.rmSync(outPath, { force: true });
      return { ok: false, reason: 'no_subject' };
    }
    return { ok: true, ...outline };
  }

  async function prepareFile(sourcePath, id, dir) {
    const base = path.join(dir, id);
    const finalPath = `${base}.jpg`;
    const fullPath = `${base}.full.jpg`;
    const cutPath = `${base}.cut.png`;
    const rawCut = `${base}.rembg.png`;
    const enhancedPath = `${base}.enhance.png`;
    const steps = {};
    fs.rmSync(cutPath, { force: true });
    try {
      let current = sourcePath;
      let builtIn = true;
      if (enhanceCommand) {
        const { bin, args } = commandFor(enhanceCommand, current, enhancedPath);
        const result = await runner(bin, args, { timeoutMs: stepTimeoutMs });
        if (result.ok && produced(enhancedPath)) {
          current = enhancedPath;
          builtIn = false;
          steps.enhance = { step: 'enhance', status: 'done', engine: 'external' };
        } else {
          // The chain goes on with the built-in clean-up; the report says so.
          steps.enhance = { step: 'enhance', status: 'failed', reason: result.code === 'tool_missing' ? 'tool_missing' : 'step_failed', fallback: 'built-in' };
        }
      } else {
        steps.enhance = { step: 'enhance', status: 'done', engine: 'built-in' };
      }
      const normalized = await runner(ffmpegBin, normalizeArgs(current, finalPath, MAX_SIDE, { enhance: builtIn }), { timeoutMs: stepTimeoutMs });
      const full = normalized.ok ? await runner(ffmpegBin, normalizeArgs(current, fullPath, FULL_SIDE, { enhance: builtIn }), { timeoutMs: stepTimeoutMs }) : normalized;
      if (!normalized.ok || !full.ok || !produced(finalPath) || !produced(fullPath)) {
        for (const item of [finalPath, fullPath]) fs.rmSync(item, { force: true });
        const missingTool = normalized.code === 'tool_missing' || full.code === 'tool_missing';
        throw new PhotoError(missingTool ? 'ffmpeg_missing' : 'normalize_failed', missingTool ? 'Не найден ffmpeg: фото нельзя подготовить.' : 'Не удалось подготовить фото.');
      }
      steps.normalize = { step: 'normalize', status: 'done' };

      const cut = await cutSubject(fullPath, rawCut);
      if (cut.ok) {
        const cropped = await runner(ffmpegBin, cutoutArgs(rawCut, cutPath, cut.box), { timeoutMs: stepTimeoutMs });
        if (cropped.ok && produced(cutPath)) steps['remove-bg'] = { step: 'remove-bg', status: 'done' };
        else {
          fs.rmSync(cutPath, { force: true });
          steps['remove-bg'] = { step: 'remove-bg', status: 'failed', reason: 'step_failed' };
        }
      } else {
        steps['remove-bg'] = { step: 'remove-bg', status: cut.skipped ? 'skipped' : 'failed', reason: cut.reason };
      }
    } finally {
      for (const item of [rawCut, enhancedPath]) fs.rmSync(item, { force: true });
    }
    const report = STEP_ORDER.map((step) => steps[step]).filter(Boolean);
    return {
      id,
      bytes: fs.statSync(finalPath).size,
      cutout: produced(cutPath),
      report,
      // True only when no step failed.
      fullyProcessed: report.every((entry) => entry.status !== 'failed'),
    };
  }

  async function prepareDecoded(decoded, dir) {
    const sourcePath = path.join(dir, `${decoded.sha256}.src.${decoded.ext}`);
    fs.writeFileSync(sourcePath, decoded.buffer);
    try {
      return await prepareFile(sourcePath, decoded.sha256, dir);
    } finally {
      fs.rmSync(sourcePath, { force: true });
    }
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

  // Registers an image this service produced (an edited product shot) as a
  // prepared photo of the account, so it can be used in a film.
  async function adopt(userId, filePath) {
    const dir = dirFor(userId);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return prepareFile(filePath, id, dir);
  }

  // ids -> files, only inside this account's folder.
  function resolve(userId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    if (ids.length > MAX_PHOTOS) throw new PhotoError('too_many_photos', `Не больше ${MAX_PHOTOS} фото.`);
    const dir = dirFor(userId);
    return ids.map((id) => {
      const file = PHOTO_ID.test(String(id)) ? path.join(dir, `${id}.jpg`) : null;
      if (!file || !fs.existsSync(file)) throw new PhotoError('unknown_photo', 'Фото не найдено: загрузите его заново.', 'photoIds');
      const fullPath = path.join(dir, `${id}.full.jpg`);
      const cutPath = path.join(dir, `${id}.cut.png`);
      return { id, path: file, fullPath: fs.existsSync(fullPath) ? fullPath : file, cutPath: fs.existsSync(cutPath) ? cutPath : null };
    });
  }

  // Downloads the background-removal model once, off the request path, so the
  // first upload does not wait for it. Never throws.
  async function warmup() {
    if (!removeBg || !workDir) return { ok: false, reason: 'not_configured' };
    const dir = path.join(workDir, '.warmup');
    const probe = path.join(dir, 'probe.png');
    const out = path.join(dir, 'probe.cut.png');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const made = await runner(ffmpegBin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64', '-frames:v', '1', probe], { timeoutMs: 60000 });
      if (!made.ok) return { ok: false, reason: 'ffmpeg_failed' };
      const command = removeBg.template ? commandFor(removeBg.template, probe, out) : { bin: removeBg.bin, args: removeBg.args(probe, out) };
      const result = await runner(command.bin, command.args, { timeoutMs: 1800000 });
      return { ok: Boolean(result.ok), reason: result.ok ? 'ready' : result.code || 'step_failed' };
    } catch {
      return { ok: false, reason: 'warmup_failed' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { capability, prepareAll, adopt, resolve, cutSubject, warmup };
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
  cutoutArgs,
  outlineArgs,
  parseOutline,
  findOnPath,
  commandFor,
  createPhotoPipeline,
  consistencyPrompt,
};

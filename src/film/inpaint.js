'use strict';

// Product shots by mask: change what is around a product, put a product into
// a scene, or clean a small area — without redrawing the product itself.
//
// Two engines:
//
// 1. Built in (always available, ffmpeg + the background-removal step):
//      background — the subject keeps its own pixels and position; everything
//                   else becomes a studio backdrop or the supplied background
//                   photo. A mask, when given, limits which subject is kept.
//      insert     — the product photo is placed into the masked area with its
//                   proportions intact (its own background removed first when
//                   background removal is available).
//      erase      — the masked area is filled from its surroundings. Meant for
//                   a small logo, a stamp or a spot on a plain surface; it
//                   does not invent detail.
//    These are compositing operations: nothing is generated, so the product
//    cannot be distorted. The result is returned as an image and registered as
//    a prepared photo, ready to become a reel.
//
// 2. External generative service (optional, INPAINT_BASE_URL + INPAINT_MODEL):
//      replace, remove, extend — a model draws new content inside the mask.
//    The request is this project's own small contract, not the API of any
//    particular product, and it has not been run against a real engine:
//      POST {base}/inpaint
//        { model, image, mask, prompt, mode, preserve_unmasked: true,
//          reference?, strength, seed? }          images are data: URLs
//        -> { image_url: "https://..." }
//    Without the service these three modes fail and name the variables.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requestJson, assertHttpsBase } = require('../http-client.js');
const { decodeUpload, outlineArgs, parseOutline } = require('./photos.js');
const { run } = require('./compose.js');
const { cleanText } = require('./schema.js');
const { BACKDROPS } = require('./studio.js');

const BUILT_IN_MODES = ['background', 'insert', 'erase'];
const GENERATIVE_MODES = ['replace', 'remove', 'extend'];
const MODES = [...BUILT_IN_MODES, ...GENERATIVE_MODES];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const USER_DIR = /^[A-Za-z0-9-]{1,64}$/;

class InpaintError extends Error {
  constructor(code, message, field, status = 400) {
    super(message);
    this.name = 'InpaintError';
    this.code = code;
    this.status = status;
    if (field) this.field = field;
  }
}

function decodeImage(value, field) {
  try {
    return decodeUpload(value, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    throw new InpaintError(error.code || 'invalid_image', error.message, field);
  }
}

function dataUrl(image) {
  return `data:${image.mime};base64,${image.buffer.toString('base64')}`;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w >= 8 && h >= 8 ? { x, y, w, h } : null;
}

function createInpainter({
  baseUrl = '',
  apiKey = '',
  model = '',
  requestTimeoutMs = 180000,
  fetchImpl = globalThis.fetch,
  studio = null,
  photos = null,
  workDir = '',
  ffmpegBin = 'ffmpeg',
  runner = run,
} = {}) {
  const missing = [baseUrl ? '' : 'INPAINT_BASE_URL', model ? '' : 'INPAINT_MODEL'].filter(Boolean);
  const generative = missing.length === 0;
  const builtIn = Boolean(studio && workDir);
  const base = generative ? assertHttpsBase(baseUrl, 'INPAINT_BASE_URL') : null;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = ['Bearer', apiKey].join(' ');

  function capability() {
    return {
      configured: builtIn || generative,
      builtIn: { available: builtIn, modes: builtIn ? BUILT_IN_MODES : [] },
      generative: { configured: generative, modes: GENERATIVE_MODES, missing },
      missing: builtIn || generative ? [] : missing,
    };
  }

  async function maskBox(maskPath, size) {
    const probe = await runner(ffmpegBin, outlineArgs(maskPath, { mask: true, size }), { timeoutMs: 60000, capture: true });
    const outline = probe.ok ? parseOutline(probe.stdout) : null;
    if (!outline || outline.box.w < 8 || outline.box.h < 8) throw new InpaintError('invalid_mask', 'Маска пустая: выделите область.', 'mask');
    return outline.box;
  }

  async function editBuiltIn({ mode, source, maskImage, product, background, backdrop }, userId) {
    if (!USER_DIR.test(String(userId))) throw new InpaintError('invalid_owner', 'Не удалось определить владельца.', null, 400);
    const dir = path.join(workDir, String(userId), crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    try {
      const write = (name, image) => {
        const file = path.join(dir, `${name}.${image.ext}`);
        fs.writeFileSync(file, image.buffer);
        return file;
      };
      const sourcePath = write('source', source);
      const size = await studio.imageSize(sourcePath);
      const box = maskImage ? await maskBox(write('mask', maskImage), size) : null;
      const outPath = path.join(dir, 'result.jpg');
      const notes = [];

      if (mode === 'background') {
        const cutPath = path.join(dir, 'cut.png');
        const cut = photos ? await photos.cutSubject(sourcePath, cutPath) : { ok: false, reason: 'not_configured' };
        if (!cut.ok) {
          throw new InpaintError(
            cut.reason === 'no_subject' ? 'no_subject' : 'remove_bg_unavailable',
            cut.reason === 'no_subject' ? 'На фото не удалось отделить предмет от фона.' : 'Для замены фона нужно удаление фона: установите rembg или задайте FILM_REMOVE_BG_COMMAND.',
            null,
            cut.reason === 'no_subject' ? 422 : 503,
          );
        }
        const keep = box ? intersect(cut.box, box) : cut.box;
        if (!keep) throw new InpaintError('invalid_mask', 'В выделенной области нет предмета.', 'mask');
        await studio.replaceBackground({ sourcePath, objectPath: cutPath, box: keep, backdrop, backgroundPath: background ? write('background', background) : null, outPath });
      } else if (mode === 'insert') {
        if (!box) throw new InpaintError('mask_required', 'Выделите область, куда поставить товар.', 'mask');
        if (!product) throw new InpaintError('reference_required', 'Загрузите фото товара.', 'reference');
        let referencePath = write('reference', product);
        const cutPath = path.join(dir, 'reference.cut.png');
        const cut = photos ? await photos.cutSubject(referencePath, cutPath) : { ok: false };
        if (cut.ok) {
          // Only the product itself, cropped to its outline.
          const cropped = path.join(dir, 'reference.crop.png');
          const done = await runner(ffmpegBin, ['-y', '-v', 'error', '-i', cutPath, '-vf', `format=rgba,crop=${cut.box.w}:${cut.box.h}:${cut.box.x}:${cut.box.y}`, '-frames:v', '1', cropped], { timeoutMs: 60000 });
          if (done.ok && fs.existsSync(cropped)) referencePath = cropped;
        } else {
          notes.push('reference_background_kept');
        }
        await studio.insertObject({ sourcePath, referencePath, box, outPath });
      } else {
        if (!box) throw new InpaintError('mask_required', 'Выделите область, которую нужно убрать.', 'mask');
        await studio.eraseArea({ sourcePath, box, outPath });
      }

      const buffer = fs.readFileSync(outPath);
      let photoId = null;
      if (photos) {
        // Ready to be used in a reel straight away.
        try {
          photoId = (await photos.adopt(userId, outPath)).id;
        } catch {
          notes.push('not_added_to_photos');
        }
      }
      return { engine: 'studio', mode, image: `data:image/jpeg;base64,${buffer.toString('base64')}`, bytes: buffer.length, photoId, notes };
    } catch (error) {
      if (error instanceof InpaintError) throw error;
      throw new InpaintError(error.code || 'edit_failed', error.message || 'Не удалось обработать изображение.', null, error.code === 'ffmpeg_missing' ? 503 : 422);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function editGenerative({ mode, source, maskImage, product, prompt, seed }) {
    if (!generative) throw new InpaintError('inpaint_not_configured', `Генеративная замена не настроена: задайте ${missing.join(', ')}. Доступны встроенные режимы: background, insert, erase.`, null, 503);
    if (!maskImage) throw new InpaintError('mask_required', 'Выделите область замены.', 'mask');
    const body = {
      model,
      image: dataUrl(source),
      mask: dataUrl(maskImage),
      prompt: cleanText(prompt, 800),
      mode,
      preserve_unmasked: true,
      strength: 0.85,
    };
    if (product) body.reference = dataUrl(product);
    if (Number.isInteger(seed)) body.seed = seed;
    const res = await requestJson(fetchImpl, `${base}/inpaint`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: requestTimeoutMs,
      service: 'inpaint',
    });
    const url = res.ok && res.json ? res.json.image_url : null;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new InpaintError('inpaint_failed', `Сервис inpainting не вернул изображение (HTTP ${res.status}).`, null, 502);
    }
    return { engine: 'external', imageUrl: url, mode, model };
  }

  // image: source photo; mask: PNG, white/opaque where the edit happens;
  // reference: product photo; background: optional new background photo.
  async function edit({ image, mask = null, prompt = '', mode = 'background', reference = null, background = null, backdrop = null, seed = null }, { userId } = {}) {
    if (!MODES.includes(mode)) throw new InpaintError('invalid_mode', `Режим: ${MODES.join(', ')}.`, 'mode');
    const source = decodeImage(image, 'image');
    const maskImage = mask ? decodeImage(mask, 'mask') : null;
    if (maskImage && maskImage.mime !== 'image/png') throw new InpaintError('invalid_mask', 'Маска должна быть PNG.', 'mask');
    const product = reference ? decodeImage(reference, 'reference') : null;
    if (GENERATIVE_MODES.includes(mode)) return editGenerative({ mode, source, maskImage, product, prompt, seed });
    if (!builtIn) throw new InpaintError('inpaint_not_configured', 'Встроенный редактор недоступен.', null, 503);
    if (backdrop && !BACKDROPS[backdrop]) throw new InpaintError('invalid_backdrop', 'Неизвестный фон.', 'backdrop');
    // A missing area is a request error: report it before any ffmpeg call, so the answer is the same on a host without ffmpeg.
    if (mode !== 'background' && !maskImage) throw new InpaintError('mask_required', mode === 'insert' ? 'Выделите область, куда поставить товар.' : 'Выделите область, которую нужно убрать.', 'mask');
    return editBuiltIn({ mode, source, maskImage, product, background: background ? decodeImage(background, 'background') : null, backdrop }, userId);
  }

  return { configured: builtIn || generative, missing: builtIn || generative ? [] : missing, capability, edit };
}

module.exports = { createInpainter, InpaintError, MODES, BUILT_IN_MODES, GENERATIVE_MODES };

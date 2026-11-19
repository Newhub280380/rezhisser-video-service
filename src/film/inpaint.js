'use strict';

// Inpainting / product replacement: an adapter to an image-editing service.
//
// This project has no inpainting model of its own, so the work is done by a
// service the operator runs (INPAINT_BASE_URL). The request below is this
// project's own small contract — it is not the API of any particular product,
// and it has not been run against a real engine:
//
//   POST {base}/inpaint
//     { model, image, mask, prompt, mode, preserve_unmasked: true,
//       reference?, strength, seed? }          images are data: URLs
//     -> { image_url: "https://..." }
//
// What is enforced here: the mask must be a real PNG, the source photo is sent
// unchanged as the texture/shape reference, and the engine is told that pixels
// outside the mask are authoritative. Whether the object really stays intact is
// decided by the engine behind the URL.
//
// Without a configured service the calls fail and name the missing variables;
// there is no "approximate" fallback.

const { requestJson, assertHttpsBase } = require('../http-client.js');
const { decodeUpload } = require('./photos.js');
const { cleanText } = require('./schema.js');

const MODES = ['replace', 'remove', 'extend'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

function createInpainter({ baseUrl = '', apiKey = '', model = '', requestTimeoutMs = 180000, fetchImpl = globalThis.fetch } = {}) {
  const missing = [baseUrl ? '' : 'INPAINT_BASE_URL', model ? '' : 'INPAINT_MODEL'].filter(Boolean);
  if (missing.length) {
    const refuse = async () => {
      throw new InpaintError('inpaint_not_configured', `Inpainting не настроен: задайте ${missing.join(', ')}.`, null, 503);
    };
    return { configured: false, missing, edit: refuse };
  }
  const base = assertHttpsBase(baseUrl, 'INPAINT_BASE_URL');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = ['Bearer', apiKey].join(' ');

  // image: source photo; mask: PNG, opaque where the edit happens;
  // reference: optional product photo to place into the masked area.
  async function edit({ image, mask, prompt, mode = 'replace', reference = null, seed = null }) {
    if (!MODES.includes(mode)) throw new InpaintError('invalid_mode', 'Режим: replace, remove или extend.', 'mode');
    const source = decodeImage(image, 'image');
    const maskImage = decodeImage(mask, 'mask');
    if (maskImage.mime !== 'image/png') throw new InpaintError('invalid_mask', 'Маска должна быть PNG.', 'mask');
    const product = reference ? decodeImage(reference, 'reference') : null;
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
    return { imageUrl: url, mode, model };
  }

  return { configured: true, missing: [], edit };
}

module.exports = { createInpainter, InpaintError, MODES };

'use strict';

// HTTP surface of the film pipeline, mounted by src/production.js.
//
// Read-only catalogue routes are public; everything that creates, reads or
// downloads account data requires the same bearer token as the account API.
// Files are addressed by ids only: a client never sends or receives a path.

const fs = require('node:fs');
const path = require('node:path');
const { listTemplates, buildPreset, TemplateError } = require('./templates.js');
const { PlanError, cleanText } = require('./schema.js');
const { FilmError } = require('./jobs.js');
const { PhotoError } = require('./photos.js');
const { buildPhotoReel } = require('./storyboard.js');
const { ASPECTS } = require('./schema.js');
const { InpaintError } = require('./inpaint.js');
const { AudioError } = require('./audio.js');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SMALL_BODY = 64 * 1024;
// Images travel as data: URLs inside JSON.
const PHOTO_BODY = 14 * 1024 * 1024;
const MAX_PHOTOS_PER_REQUEST = 6;
const NO_STORE = { 'Cache-Control': 'no-store' };
const BRIEF_FIELDS = { brief: 900, niche: 120, subject: 120, location: 120, style: 200, audience: 200, music: 120 };
const MAX_CAPTIONS = 36;
const PHOTO_MODES = ['studio', 'ai'];
const ACCOUNT_PATHS = ['/api/film/jobs', '/api/film/audio/library', '/api/film/audio/link', '/api/film/photos/prepare', '/api/film/inpaint'];

function knownError(error) {
  if (error instanceof FilmError || error instanceof InpaintError) return error.status || 400;
  if (error instanceof PlanError) return 422;
  if (error instanceof TemplateError || error instanceof PhotoError || error instanceof AudioError) return 400;
  return null;
}

// Accepts a string or an object; keeps only known text fields, cleaned and capped.
function normalizeBrief(value) {
  const source = typeof value === 'string' ? { brief: value } : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const brief = {};
  for (const [field, max] of Object.entries(BRIEF_FIELDS)) {
    const text = cleanText(typeof source[field] === 'string' ? source[field] : '', max);
    if (text) brief[field] = text;
  }
  return brief;
}

// Caption lines: an array, or one text with a line per caption.
function normalizeCaptions(value) {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return lines.map((line) => cleanText(String(line), 200)).filter(Boolean).slice(0, MAX_CAPTIONS);
}

function createFilmApi({ config, stack, db, helpers, logger = console }) {
  const { sendJson, readJson, requireUser } = helpers;
  const { pipeline, photos, inpainter, audio } = stack;
  const workRoot = path.resolve(config.filmWorkDir);

  async function createJob(req, res, user) {
    const payload = await readJson(req, res, SMALL_BODY);
    if (!payload) return;
    const input = {
      scenes: payload.scenes,
      durationSeconds: payload.durationSeconds,
      aspect: payload.aspect,
      audio: audio.resolve(user.id, payload.audio),
      voice: audio.resolve(user.id, payload.voice),
      captions: normalizeCaptions(payload.captions),
      photoMode: PHOTO_MODES.includes(payload.photoMode) ? payload.photoMode : undefined,
      backdrop: typeof payload.backdrop === 'string' ? payload.backdrop : undefined,
      cutout: payload.cutout === false ? false : undefined,
    };
    const reelPhotos = Array.isArray(payload.photoIds) ? payload.photoIds.length : 0;
    if (payload.photoReel === true) {
      // One scene per photo; nothing to describe.
      if (!reelPhotos) throw new PhotoError('photos_required', 'Сначала подготовьте фото.', 'photoIds');
      input.templateId = 'photo-reel';
      input.presetPlan = buildPhotoReel({
        count: reelPhotos,
        aspect: ASPECTS.includes(payload.aspect) ? payload.aspect : '9:16',
        secondsPerPhoto: payload.secondsPerPhoto,
        title: typeof payload.title === 'string' ? payload.title : '',
        style: typeof payload.style === 'string' ? payload.style : '',
      });
      input.scenes = undefined;
      // The studio is the default here: the photos stay exactly as shot.
      if (!input.photoMode) input.photoMode = 'studio';
    } else if (payload.templateId !== undefined && payload.templateId !== null) {
      const preset = buildPreset({ templateId: payload.templateId, metadata: payload.metadata });
      input.templateId = preset.templateId;
      input.presetPlan = preset.plan;
      input.scenes = undefined;
    } else {
      input.brief = normalizeBrief(payload.brief);
    }
    if (Array.isArray(payload.photoIds) && payload.photoIds.length) {
      // Prepared photos become the scenes: files for the built-in studio,
      // first frames for a video model.
      input.photos = photos.resolve(user.id, payload.photoIds);
    }
    const job = await pipeline.start(user, input);
    sendJson(res, 201, { job: pipeline.publicJob(job) }, NO_STORE);
  }

  async function ownJob(res, user, id) {
    const job = UUID_PATTERN.test(id) ? await db.getFilmJob(id) : null;
    if (!job || job.userId !== user.id) {
      sendJson(res, 404, { error: 'film_job_not_found' });
      return null;
    }
    return job;
  }

  // The assembled film for its owner: a signed storage link when the film was
  // uploaded, otherwise the local file streamed from the work folder.
  function sendVideo(res, job) {
    const view = pipeline.publicJob(job);
    if (view.video && view.video.url) {
      res.writeHead(302, { Location: view.video.url, ...NO_STORE });
      res.end();
      return;
    }
    const file = job.outputUrl ? path.resolve(job.outputUrl) : null;
    if (!file || !file.startsWith(workRoot + path.sep) || !fs.existsSync(file)) {
      sendJson(res, 404, { error: 'film_not_available', message: 'Файл фильма недоступен.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': 'attachment; filename="film.mp4"',
      'Cache-Control': 'private, no-store',
    });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function route(req, res, pathname) {
    const { method } = req;
    if (method === 'GET' && pathname === '/api/film/capabilities') {
      sendJson(res, 200, stack.capabilities());
      return true;
    }
    if (method === 'GET' && pathname === '/api/film/templates') {
      sendJson(res, 200, { templates: listTemplates() });
      return true;
    }
    if (method === 'POST' && pathname === '/api/film/presets') {
      // Free preview of a template: the fixed plan, no provider is called.
      const payload = await readJson(req, res, SMALL_BODY);
      if (payload) sendJson(res, 200, { preset: buildPreset({ templateId: payload.templateId, metadata: payload.metadata }) });
      return true;
    }

    const jobMatch = pathname.match(/^\/api\/film\/jobs\/([^/]+)(?:\/(video|cancel))?$/);
    if (!jobMatch && !ACCOUNT_PATHS.includes(pathname)) return false;
    const user = await requireUser(req, res);
    if (!user) return true;

    if (pathname === '/api/film/jobs' && method === 'POST') {
      await createJob(req, res, user);
      return true;
    }
    if (pathname === '/api/film/jobs' && method === 'GET') {
      const jobs = await db.listFilmJobs(user.id, { limit: 50 });
      sendJson(res, 200, { jobs: jobs.map((job) => pipeline.publicJob(job)) }, NO_STORE);
      return true;
    }
    if (jobMatch && method === 'GET' && !jobMatch[2]) {
      const job = await ownJob(res, user, jobMatch[1]);
      if (job) sendJson(res, 200, { job: pipeline.publicJob(job, await db.listFilmShots(job.id)) }, NO_STORE);
      return true;
    }
    if (jobMatch && method === 'GET' && jobMatch[2] === 'video') {
      const job = await ownJob(res, user, jobMatch[1]);
      if (job) sendVideo(res, job);
      return true;
    }
    if (jobMatch && method === 'POST' && jobMatch[2] === 'cancel') {
      const job = await ownJob(res, user, jobMatch[1]);
      if (job) sendJson(res, 200, { job: pipeline.publicJob(await pipeline.cancel(job.id, user.id)) }, NO_STORE);
      return true;
    }
    if (pathname === '/api/film/audio/library' && method === 'GET') {
      sendJson(res, 200, { tracks: audio.library.list(), capability: audio.capability() });
      return true;
    }
    if (pathname === '/api/film/audio/link' && method === 'POST') {
      const payload = await readJson(req, res, SMALL_BODY);
      if (!payload) return true;
      const track = await audio.downloadByUrl(user.id, payload.url);
      sendJson(res, 201, { audio: { downloadId: track.id, title: track.title, bytes: track.bytes } }, NO_STORE);
      return true;
    }
    if (pathname === '/api/film/photos/prepare' && method === 'POST') {
      const payload = await readJson(req, res, PHOTO_BODY);
      if (!payload) return true;
      if (!Array.isArray(payload.photos) || payload.photos.length > MAX_PHOTOS_PER_REQUEST) {
        sendJson(res, 400, { error: 'invalid_photos', message: `Передайте от 1 до ${MAX_PHOTOS_PER_REQUEST} фото за запрос.` });
        return true;
      }
      sendJson(res, 201, { photos: await photos.prepareAll(payload.photos, { userId: user.id }), capability: photos.capability() }, NO_STORE);
      return true;
    }
    if (pathname === '/api/film/inpaint' && method === 'POST') {
      const payload = await readJson(req, res, PHOTO_BODY);
      if (!payload) return true;
      const result = await inpainter.edit({
        image: payload.image,
        mask: payload.mask,
        prompt: payload.prompt,
        mode: payload.mode,
        reference: payload.reference || null,
        background: payload.background || null,
        backdrop: typeof payload.backdrop === 'string' && payload.backdrop ? payload.backdrop : null,
        seed: Number.isInteger(payload.seed) ? payload.seed : null,
      }, { userId: user.id });
      sendJson(res, 201, { result }, NO_STORE);
      return true;
    }
    return false;
  }

  // Returns true when the request was handled. Unknown errors propagate to the
  // caller, which also knows the account and billing error types.
  async function handle(req, res, pathname) {
    try {
      return await route(req, res, pathname);
    } catch (error) {
      const status = knownError(error);
      if (!status) throw error;
      logger.error(`film api ${req.method} ${pathname}: ${error.code}`);
      sendJson(res, status, { error: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
      return true;
    }
  }

  return { handle };
}

module.exports = { createFilmApi, normalizeBrief, normalizeCaptions, MAX_PHOTOS_PER_REQUEST };

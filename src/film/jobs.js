'use strict';

// Film job orchestrator: plan -> render every scene in parallel -> upscale ->
// assemble -> tear down the rented cluster.
//
// Rules this file enforces:
//
// * Nothing is invented. No planner, no renderer or a failed scene means a
//   failed job with the reason, never a placeholder film.
// * A rented cluster is always torn down in `finally`. If teardown fails the job
//   is flagged `needs_attention` (the finished film stays downloadable).
// * A failed or canceled job returns the reserved generation to the account.
// * No auto-resume: jobs interrupted by a restart are failed, refunded and
//   their clusters torn down by recover().

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validatePlan, outputSize, ASPECTS, MIN_SCENES, MAX_SCENES } = require('./schema.js');
const { buildSubtitles } = require('./compose.js');
const { consistencyPrompt } = require('./photos.js');
const { downloadClip } = require('./render.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['queued', 'planning', 'provisioning', 'rendering', 'upscaling', 'assembling'];
const CAMERA_PHRASES = {
  static: 'locked-off static camera',
  'pan-left': 'camera movement: slow pan left',
  'pan-right': 'camera movement: slow pan right',
  'dolly-in': 'camera movement: slow dolly in',
  'dolly-out': 'camera movement: slow dolly out',
  'crane-up': 'camera movement: crane up',
  orbit: 'camera movement: slow orbit',
  handheld: 'subtle handheld camera',
};

class FilmError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FilmError';
    this.code = code;
    this.status = status;
  }
}

function nearest(value, allowed) {
  return allowed.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), allowed[0]);
}

function createFilmPipeline({
  config,
  db,
  storage = null,
  billing = null,
  planner = null,
  ray = null,
  sky = null,
  localPool = null,
  upscaler = null,
  composer = null,
  cache = null,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
} = {}) {
  const running = new Map();
  const driverPath = config.filmDriverPath;

  // Which engine renders scenes, in order of preference.
  function renderMode() {
    if (ray) return 'ray';
    if (sky && sky.enabled && !sky.dryRun) return 'sky';
    if (localPool) return 'local';
    return null;
  }

  function publicJob(job, shots = null) {
    const hasOutput = Boolean(job.outputKey || job.outputUrl);
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      templateId: job.templateId,
      sceneCount: job.sceneCount,
      aspect: job.aspect,
      engine: job.engine,
      progress: job.progress,
      costEstimateUsd: Number(job.costUsd) || 0,
      plan: job.plan || null,
      audio: job.audio
        ? {
            music: job.audio.music ? { source: job.audio.music.source, title: job.audio.music.title } : null,
            voice: job.audio.voice ? { source: job.audio.voice.source, title: job.audio.voice.title } : null,
          }
        : null,
      infra: job.infra || null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error || null,
      // With object storage the buyer gets a signed link; otherwise the file is
      // served by the authenticated download route. A server path never leaves.
      video: hasOutput
        ? {
            url: job.outputKey && storage ? storage.presignGet(job.outputKey, config.videoUrlTtlSeconds, { downloadName: 'film.mp4' }) : null,
            download: `/api/film/jobs/${job.id}/video`,
            bytes: job.outputBytes,
          }
        : null,
      shots: shots
        ? shots.map((shot) => ({ n: shot.sceneNumber, status: shot.status, durationSeconds: shot.durationSeconds, error: shot.error || null }))
        : undefined,
    };
  }

  const patch = (jobId, fields) => db.updateFilmJob(jobId, fields);

  // ---- plan ---------------------------------------------------------------

  async function planStage(job, input) {
    await patch(job.id, { status: 'planning', stage: 'plan' });
    // A template is a fixed storyboard: no model is asked, so the same four
    // answers always give the same plan.
    if (input.presetPlan) {
      const count = input.presetPlan.scenes.length;
      return { plan: validatePlan(input.presetPlan, { aspect: job.aspect, minScenes: count, maxScenes: count }), engine: 'template' };
    }
    if (!planner) throw new FilmError('planner_not_configured', 'SGLang не настроен: задайте SGLANG_BASE_URL и SGLANG_MODEL.', 503);
    const options = { aspect: job.aspect, scenes: job.sceneCount, durationSeconds: input.durationSeconds };
    const key = cache && cache.enabled ? cache.key('plan', { brief: input.brief, options, model: planner.model }) : null;
    const hit = key ? cache.get(key) : null;
    // A cached plan is validated again: an old shape must never reach a renderer.
    if (hit) return { plan: validatePlan(hit, { aspect: job.aspect }), engine: 'sglang-cache' };
    const { plan } = await planner.writePlan(input.brief, options);
    if (key) cache.set(key, plan);
    return { plan, engine: 'sglang' };
  }

  // The video provider accepts only certain clip lengths; the plan is aligned
  // to them so subtitles and music match what is actually rendered.
  function alignDurations(plan, mode) {
    const allowed = mode === 'local' ? config.filmSceneDurations : null;
    if (!allowed || !allowed.length) return plan;
    const scenes = plan.scenes.map((scene) => ({ ...scene, durationSeconds: nearest(scene.durationSeconds, allowed) }));
    return { ...plan, scenes, totalSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) };
  }

  // ---- render -------------------------------------------------------------

  function renderPayload(job, plan, photos) {
    const identity = consistencyPrompt({ characters: plan.characters, locations: plan.locations, style: plan.style });
    return {
      jobId: job.id,
      fps: plan.fps,
      aspect: plan.aspect,
      resolution: job.baseResolution,
      shots: plan.scenes.map((scene, index) => ({
        shotId: `${job.id}:${scene.n}`,
        n: scene.n,
        prompt: `${scene.prompt} ${CAMERA_PHRASES[scene.camera] || ''}. ${identity}`.replace(/\s+/g, ' ').trim().slice(0, 2400),
        negativePrompt: scene.negativePrompt || plan.negativePrompt || '',
        durationSeconds: scene.durationSeconds,
        // "Film from your photos": each scene starts from one of the prepared
        // photos (first frame), cycling through them in order.
        ...(photos.length ? { image: photos[index % photos.length] } : {}),
      })),
    };
  }

  async function renderStage(job, plan, mode, photos, signal, state) {
    const payload = renderPayload(job, plan, photos);
    const onProgress = (progress) => {
      const done = Number(progress && progress.done) || 0;
      const total = Number(progress && progress.total) || payload.shots.length;
      patch(job.id, { progress: Math.min(80, 10 + Math.round((done / Math.max(1, total)) * 70)) }).catch(() => null);
    };
    let result;
    if (mode === 'sky') {
      await patch(job.id, { status: 'provisioning', stage: 'infra' });
      const { offer, reason } = await sky.cheapest();
      // No known price means no launch: the ceiling could not be honoured.
      if (!offer) throw new FilmError('no_gpu_offer', `SkyPilot не нашёл предложение GPU под лимит цены (${reason}).`, 502);
      const clusterName = `rezhisser-${job.id.slice(0, 8)}-${crypto.randomBytes(2).toString('hex')}`;
      state.lease = await db.createInfraLease({
        id: crypto.randomUUID(),
        jobId: job.id,
        provider: 'skypilot',
        clusterName,
        region: offer.region,
        accelerator: offer.spec,
        hourlyUsd: offer.hourlyUsd,
        status: 'running',
        launchedAt: new Date(now()).toISOString(),
        detail: { cloud: offer.cloud, spot: offer.spot },
      });
      await patch(job.id, { status: 'rendering', stage: 'render', infra: { provider: 'skypilot', cluster: clusterName, accelerator: offer.spec, cloud: offer.cloud, spot: offer.spot, hourlyUsd: offer.hourlyUsd } });
      result = await sky.runFilm({
        clusterName,
        accelerator: offer.spec,
        cloud: offer.cloud,
        region: offer.region,
        payload,
        workDir: path.join(config.filmWorkDir, String(job.id), 'sky'),
        driverPath,
        env: config.filmRenderEndpoint ? { FILM_RENDER_ENDPOINT: config.filmRenderEndpoint } : {},
        onProgress,
        signal,
      });
    } else {
      await patch(job.id, { status: 'rendering', stage: 'render', infra: { provider: mode } });
      result = await (mode === 'ray' ? ray : localPool).run(payload, { onProgress, signal });
    }

    const rendered = new Map();
    for (const shot of (result && result.shots) || []) {
      if (shot && shot.ok !== false) rendered.set(Number(shot.scene), shot);
    }
    const failed = new Map(((result && result.failures) || []).map((item) => [Number(item.scene), item]));
    const dir = path.join(config.filmWorkDir, String(job.id), 'clips');
    const clips = [];
    const missing = [];
    for (const shot of await db.listFilmShots(job.id)) {
      const out = rendered.get(shot.sceneNumber);
      let file = null;
      let error = failed.get(shot.sceneNumber) || { code: 'missing_output' };
      try {
        if (out && mode === 'local' && out.path && fs.existsSync(out.path)) file = out.path;
        // A cluster's local path means nothing here: remote clips need a URL.
        else if (out && out.url) file = (await downloadClip(out.url, path.join(dir, `scene-${shot.sceneNumber}.mp4`), { fetchImpl })).path;
        else if (out) error = { code: 'clip_not_reachable', message: 'Рендер не вернул https-ссылку на клип.' };
      } catch (downloadError) {
        error = { code: downloadError.code || 'clip_download_failed', message: downloadError.message };
      }
      if (file) {
        await db.updateFilmShot(shot.id, { status: 'ready', attempts: shot.attempts + 1, localPath: file, clipUrl: out.url || null, completedAt: new Date(now()).toISOString(), error: null });
        clips.push({ shotId: shot.id, scene: shot.sceneNumber, path: file });
      } else {
        await db.updateFilmShot(shot.id, { status: 'failed', attempts: shot.attempts + 1, error: { code: error.code || 'render_failed', message: String(error.message || 'Сцена не отрендерена.').slice(0, 200) } });
        missing.push(shot.sceneNumber);
      }
    }
    if (missing.length) throw new FilmError('scenes_failed', `Не отрендерены сцены: ${missing.join(', ')}.`, 502);
    return clips;
  }

  // ---- upscale ------------------------------------------------------------

  async function upscaleStage(job, clips, signal) {
    // Without ReCaVSR the assembler resizes with Lanczos — a resize, not
    // super-resolution — and the job says so.
    if (!upscaler) return { clips, engine: 'ffmpeg-lanczos' };
    await patch(job.id, { status: 'upscaling', stage: 'upscale' });
    const { results, failures } = await upscaler.upscaleAll(clips, {
      signal,
      onProgress: ({ done, total }) => patch(job.id, { progress: Math.min(92, 80 + Math.round((done / Math.max(1, total)) * 12)) }).catch(() => null),
    });
    if (failures.length && config.filmUpscaleRequired) throw new FilmError('upscale_failed', `Апскейл не выполнен для ${failures.length} сцен.`, 502);
    const upscaled = new Map(results.map((item) => [item.shotId, item.path]));
    return {
      clips: clips.map((clip) => ({ ...clip, path: upscaled.get(clip.shotId) || clip.path })),
      engine: failures.length ? (results.length ? 'recavsr-partial' : 'ffmpeg-lanczos') : 'recavsr',
      failed: failures.length,
    };
  }

  // ---- assemble -----------------------------------------------------------

  async function assembleStage(job, plan, clips) {
    await patch(job.id, { status: 'assembling', stage: 'assemble', progress: 93 });
    const ordered = [...clips].sort((a, b) => a.scene - b.scene);
    // Real clip lengths drive subtitles and music, not the planned ones.
    const durations = [];
    for (const clip of ordered) durations.push((await composer.probeDuration(clip.path)) || plan.scenes[clip.scene - 1].durationSeconds);
    const seconds = durations.reduce((sum, value) => sum + value, 0);
    const timed = { scenes: plan.scenes.map((scene, i) => ({ ...scene, durationSeconds: durations[i] })) };
    const { srt, count } = config.filmSubtitles ? buildSubtitles(timed) : { srt: '', count: 0 };
    const composed = await composer.assemble({
      jobId: job.id,
      clips: ordered,
      size: outputSize(plan.aspect, job.targetResolution),
      seconds,
      srt,
      music: job.audio && job.audio.music ? { path: job.audio.music.path } : null,
      voice: job.audio && job.audio.voice ? { path: job.audio.voice.path } : null,
      frameRate: plan.fps,
    });
    let outputKey = null;
    if (storage) {
      const key = `films/${job.userId}/${job.id}.mp4`;
      try {
        await storage.putFile(composed.path, key, 'video/mp4');
        outputKey = key;
      } catch (error) {
        // The film stays available through the download route.
        logger.error(`film upload failed: ${error.code || 'error'}`);
      }
    }
    return { ...composed, outputKey, seconds, subtitleCues: count };
  }

  // ---- orchestration ------------------------------------------------------

  async function refund(job) {
    const source = job.options && job.options.billingSource;
    if (!billing || !source || (job.options && job.options.refunded)) return;
    await billing.refundGeneration({ id: job.id, userId: job.userId, billingSource: source });
    await patch(job.id, { options: { ...job.options, refunded: true } });
  }

  async function execute(job, input, signal) {
    const state = { lease: null };
    const mode = renderMode();
    try {
      const planned = await planStage(job, input);
      const plan = alignDurations(planned.plan, mode);
      await patch(job.id, { plan, planHash: plan.hash, engine: planned.engine, sceneCount: plan.scenes.length, progress: 10 });
      for (const scene of plan.scenes) {
        await db.createFilmShot({ id: crypto.randomUUID(), jobId: job.id, sceneNumber: scene.n, prompt: scene.prompt, durationSeconds: scene.durationSeconds });
      }
      const rendered = await renderStage(job, plan, mode, input.photos || [], signal, state);
      const upscaled = await upscaleStage(job, rendered, signal);
      const film = await assembleStage(job, plan, upscaled.clips);
      const current = await db.getFilmJob(job.id);
      const hours = state.lease ? (now() - Date.parse(state.lease.launchedAt)) / 3600000 : 0;
      await patch(job.id, {
        status: 'succeeded',
        stage: 'done',
        progress: 100,
        outputKey: film.outputKey,
        outputUrl: film.outputKey ? null : film.path,
        outputBytes: film.bytes,
        // Rented time x listed hourly price: an estimate, not the provider's invoice.
        costUsd: Math.round(hours * Number(state.lease ? state.lease.hourlyUsd : 0) * 10000) / 10000,
        completedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + config.filmRetentionDays * DAY_MS).toISOString(),
        error: null,
        infra: { ...(current.infra || {}), upscaler: upscaled.engine, audio: film.audioMode, subtitleCues: film.subtitleCues, seconds: Math.round(film.seconds * 100) / 100 },
      });
    } catch (error) {
      const canceled = Boolean(signal && signal.aborted);
      logger.error(`film job ${job.id} ${canceled ? 'canceled' : 'failed'}: ${error.code || 'error'}`);
      const failed = await patch(job.id, {
        status: canceled ? 'canceled' : 'failed',
        error: canceled ? { code: 'canceled', message: 'Отменено пользователем.' } : { code: error.code || 'film_failed', message: String(error.message || 'Задача не выполнена.').slice(0, 300) },
        completedAt: new Date(now()).toISOString(),
      });
      await refund(failed).catch((refundError) => logger.error(`film refund ${job.id} failed: ${refundError.code || 'error'}`));
    } finally {
      if (state.lease) await releaseLease(state.lease, job.id);
    }
  }

  async function releaseLease(lease, jobId) {
    const result = await sky.teardown(lease.clusterName);
    await db.updateInfraLease(lease.id, { status: result.ok ? 'torn_down' : 'leak_suspected', teardownAt: new Date(now()).toISOString() }).catch(() => null);
    if (result.ok || !jobId) return result;
    const job = await db.getFilmJob(jobId);
    await patch(jobId, {
      status: 'needs_attention',
      error: { code: 'teardown_failed', message: `Кластер ${lease.clusterName} не удалён — удалите его вручную: sky down ${lease.clusterName}` },
      infra: { ...((job && job.infra) || {}), teardown: 'failed' },
    }).catch(() => null);
    return result;
  }

  // Validates, reserves one generation, creates the job and starts it.
  // input: { brief, presetPlan?, templateId?, scenes?, durationSeconds?, aspect?, audio?, voice?, photos? }
  async function start(user, input) {
    if (!config.filmEnabled) throw new FilmError('film_disabled', 'Конвейер фильмов выключен (FILM_ENABLED=false).', 503);
    const mode = renderMode();
    if (!mode) throw new FilmError('render_not_configured', 'Нет движка рендера: настройте RAY_DASHBOARD_URL, SkyPilot или SEEDANCE_API_KEY.', 503);
    if (!input.presetPlan) {
      if (!planner) throw new FilmError('planner_not_configured', 'SGLang не настроен: задайте SGLANG_BASE_URL и SGLANG_MODEL.', 503);
      if (!input.brief || typeof input.brief.brief !== 'string' || input.brief.brief.trim().length < 8) {
        throw new FilmError('brief_required', 'Опишите фильм одной фразой (минимум 8 символов).');
      }
    }
    const scenes = input.scenes === undefined ? 30 : Number(input.scenes);
    if (!Number.isInteger(scenes) || scenes < MIN_SCENES || scenes > MAX_SCENES) {
      throw new FilmError('invalid_scene_count', `Сцен должно быть от ${MIN_SCENES} до ${MAX_SCENES}.`);
    }
    const photos = Array.isArray(input.photos) ? input.photos : [];
    // Reference photos are sent inline; a cluster payload cannot carry them.
    if (photos.length && mode !== 'local') {
      throw new FilmError('photos_need_local_render', 'Ролик по своим фото пока работает только с локальным рендером (без Ray и SkyPilot).', 409);
    }
    let billingSource = null;
    if (billing) billingSource = await billing.consumeGeneration(user);
    let job;
    try {
      job = await db.createFilmJob({
        id: crypto.randomUUID(),
        userId: user.id,
        status: 'queued',
        stage: 'queued',
        templateId: input.templateId || null,
        sceneCount: input.presetPlan ? input.presetPlan.scenes.length : scenes,
        aspect: input.presetPlan ? input.presetPlan.aspect : ASPECTS.includes(input.aspect) ? input.aspect : '16:9',
        baseResolution: config.filmBaseResolution,
        targetResolution: config.filmTargetResolution,
        audio: input.audio || input.voice ? { music: input.audio || null, voice: input.voice || null } : null,
        options: { billingSource, photos: photos.length },
      });
    } catch (error) {
      if (billing) await billing.refundGeneration({ id: null, userId: user.id, billingSource });
      throw error;
    }
    if (billing) await billing.recordGeneration(user.id, billingSource, job.id).catch(() => null);
    const controller = new AbortController();
    const durationSeconds = Math.min(600, Math.max(30, Number(input.durationSeconds) || 150));
    const promise = execute(job, { ...input, photos, durationSeconds }, controller.signal)
      .catch((error) => logger.error(`film job ${job.id} crashed: ${error.code || error.message}`))
      .finally(() => running.delete(job.id));
    running.set(job.id, { controller, promise });
    return job;
  }

  async function cancel(jobId, userId) {
    const job = await db.getFilmJob(jobId);
    if (!job || job.userId !== userId) throw new FilmError('film_job_not_found', 'Задача не найдена.', 404);
    if (!ACTIVE_STATUSES.includes(job.status)) throw new FilmError('job_finished', 'Задача уже завершена.', 409);
    const entry = running.get(jobId);
    if (!entry) throw new FilmError('job_not_running', 'Задача не выполняется в этом процессе.', 409);
    // execute() marks the job canceled, refunds it and tears the cluster down.
    entry.controller.abort();
    await entry.promise;
    return db.getFilmJob(jobId);
  }

  // After a restart: fail and refund interrupted jobs, tear down their clusters.
  async function recover() {
    const report = { interrupted: 0, tornDown: 0, leaked: [] };
    for (const job of await db.listFilmJobsByStatus(ACTIVE_STATUSES)) {
      if (running.has(job.id)) continue;
      const failed = await patch(job.id, { status: 'failed', error: { code: 'interrupted', message: 'Сервер перезапустился во время выполнения.' }, completedAt: new Date(now()).toISOString() });
      await refund(failed).catch(() => null);
      report.interrupted += 1;
    }
    if (sky) {
      for (const lease of await db.listOpenInfraLeases()) {
        const result = await releaseLease(lease, null);
        if (result.ok) report.tornDown += 1;
        else report.leaked.push(lease.clusterName);
      }
    }
    return report;
  }

  // Removes the files of expired films (object storage and local work folder).
  async function cleanup() {
    let removed = 0;
    for (const job of await db.listFilmJobsByStatus(['succeeded', 'failed', 'canceled', 'needs_attention'])) {
      const finishedAt = Date.parse(job.completedAt || job.createdAt);
      if (!(finishedAt + config.filmRetentionDays * DAY_MS < now())) continue;
      if (!job.outputKey && !job.outputUrl && !fs.existsSync(path.join(config.filmWorkDir, String(job.id)))) continue;
      if (job.outputKey && storage) await storage.deleteObject(job.outputKey).catch(() => null);
      fs.rmSync(path.join(config.filmWorkDir, String(job.id)), { recursive: true, force: true });
      await patch(job.id, { outputKey: null, outputUrl: null });
      removed += 1;
    }
    return removed;
  }

  function close() {
    for (const entry of running.values()) entry.controller.abort();
  }

  return { renderMode, publicJob, start, cancel, recover, cleanup, close, activeCount: () => running.size };
}

module.exports = { createFilmPipeline, FilmError, ACTIVE_STATUSES };

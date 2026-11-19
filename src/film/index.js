'use strict';

// Builds the film pipeline from environment configuration.
//
// Fail-closed, like the rest of the service: a stage either has a real adapter
// or is reported as not configured, with the names of the missing variables
// (names only, never values).

const path = require('node:path');
const { createSglangPlanner } = require('./sglang.js');
const { createRayCluster, createLocalPool } = require('./ray.js');
const { createSkyPilot, DEFAULT_ACCELERATORS } = require('./skypilot.js');
const { createUpscaler } = require('./recavsr.js');
const { createComposer } = require('./compose.js');
const { createAudio, DEFAULT_HOSTS } = require('./audio.js');
const { createInpainter } = require('./inpaint.js');
const { createPhotoPipeline } = require('./photos.js');
const { createSceneRenderer } = require('./render.js');
const { createCache } = require('./cache.js');
const { createFilmPipeline } = require('./jobs.js');
const { MIN_SCENES, MAX_SCENES, BASE_RESOLUTIONS, TARGET_RESOLUTIONS } = require('./schema.js');

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function float(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function filmConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');
  const durations = list(env.FILM_SCENE_DURATIONS).map(Number).filter((value) => Number.isFinite(value) && value >= 2 && value <= 10);
  return {
    filmEnabled: flag(env.FILM_ENABLED, false),
    filmWorkDir: env.FILM_WORK_DIR || path.join(dataDir, 'film'),
    filmCacheDir: env.FILM_CACHE_DIR || path.join(dataDir, 'film-cache'),
    filmMusicDir: env.FILM_MUSIC_DIR || '',
    filmBaseResolution: BASE_RESOLUTIONS[env.FILM_BASE_RESOLUTION] ? env.FILM_BASE_RESOLUTION : '480p',
    filmTargetResolution: TARGET_RESOLUTIONS[env.FILM_TARGET_RESOLUTION] ? env.FILM_TARGET_RESOLUTION : '2160p',
    filmSubtitles: flag(env.FILM_SUBTITLES, true),
    filmUpscaleRequired: flag(env.FILM_UPSCALE_REQUIRED, false),
    filmMaxRuntimeSeconds: int(env.FILM_MAX_RUNTIME_SECONDS, 5400, 60, 86400),
    filmRetentionDays: int(env.FILM_RETENTION_DAYS, 30, 1, 3650),
    filmAllowAudioDownload: flag(env.FILM_ALLOW_AUDIO_DOWNLOAD, true),
    filmAudioHosts: list(env.FILM_AUDIO_HOSTS).length ? list(env.FILM_AUDIO_HOSTS) : DEFAULT_HOSTS,
    filmAccelerators: list(env.FILM_ACCELERATORS).length ? list(env.FILM_ACCELERATORS) : DEFAULT_ACCELERATORS,
    // Clip lengths the local video provider accepts (this project's Seedance
    // profiles list 5 and 10 seconds).
    filmSceneDurations: durations.length ? durations : [5, 10],
    filmLocalConcurrency: int(env.FILM_LOCAL_CONCURRENCY, 4, 1, 16),
    // Render service the cluster driver calls for every scene.
    filmRenderEndpoint: (env.FILM_RENDER_ENDPOINT || '').trim(),
    filmDriverPath: path.join(__dirname, '..', '..', 'python', 'rezhisser_film', 'film_job.py'),
    ytDlpBin: env.YT_DLP_BIN || 'yt-dlp',
    sglang: {
      baseUrl: (env.SGLANG_BASE_URL || '').trim(),
      model: (env.SGLANG_MODEL || '').trim(),
      apiKey: env.SGLANG_API_KEY || '',
      requestTimeoutMs: int(env.SGLANG_REQUEST_TIMEOUT_MS, 180000, 5000, 900000),
    },
    ray: {
      apiUrl: (env.RAY_DASHBOARD_URL || '').trim(),
      token: env.RAY_DASHBOARD_TOKEN || '',
      entrypoint: env.RAY_ENTRYPOINT || 'python film_job.py',
      workingDir: (env.RAY_WORKING_DIR || '').trim(),
      pollIntervalMs: int(env.RAY_POLL_INTERVAL_MS, 3000, 500, 60000),
    },
    skypilot: {
      bin: env.SKYPILOT_BIN || 'sky',
      enabled: flag(env.SKYPILOT_ENABLED, false),
      dryRun: flag(env.SKYPILOT_DRY_RUN, true),
      useSpot: flag(env.SKYPILOT_USE_SPOT, true),
      clouds: list(env.SKYPILOT_CLOUDS),
      maxHourlyUsd: float(env.SKYPILOT_MAX_HOURLY_USD, 0, 0, 1000),
      taskYaml: env.SKYPILOT_TASK_YAML || path.join(__dirname, '..', '..', 'python', 'rezhisser_film', 'sky_task.yaml'),
    },
    recavsr: {
      command: (env.RECAVSR_COMMAND || '').trim(),
      timeoutMs: int(env.RECAVSR_TIMEOUT_MS, 1800000, 10000, 14400000),
    },
    inpaint: {
      baseUrl: (env.INPAINT_BASE_URL || '').trim(),
      apiKey: env.INPAINT_API_KEY || '',
      model: (env.INPAINT_MODEL || '').trim(),
    },
    photoSteps: {
      removeBg: (env.FILM_REMOVE_BG_COMMAND || '').trim(),
      enhance: (env.FILM_ENHANCE_COMMAND || '').trim(),
    },
    composer: {
      ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
      ffprobeBin: env.FFPROBE_BIN || 'ffprobe',
      crf: int(env.FILM_CRF, 18, 12, 30),
      preset: env.FILM_PRESET || 'medium',
    },
  };
}

// `config` is the service config merged with filmConfig(). `runners` replaces
// external processes in tests: { scene, process, skyCli }.
function createFilmStack(config, { db, storage = null, billing = null, seedance = null, logger = console, fetchImpl = globalThis.fetch, runners = {} } = {}) {
  const planner = config.sglang.baseUrl && config.sglang.model ? createSglangPlanner({ ...config.sglang, fetchImpl, logger }) : null;
  const ray = createRayCluster({ ...config.ray, renderEndpoint: config.filmRenderEndpoint, maxRuntimeSeconds: config.filmMaxRuntimeSeconds, fetchImpl, logger });
  const sky = createSkyPilot({
    ...config.skypilot,
    accelerators: config.filmAccelerators,
    maxRuntimeSeconds: config.filmMaxRuntimeSeconds,
    logger,
    ...(runners.skyCli ? { cli: runners.skyCli } : {}),
  });
  const processRunner = runners.process ? { runner: runners.process } : {};
  const renderer = createSceneRenderer({
    provider: seedance,
    workDir: config.filmWorkDir,
    pollIntervalMs: config.seedance ? config.seedance.pollIntervalMs : 5000,
    maxWaitMs: config.seedance ? config.seedance.maxWaitMs : 900000,
    fetchImpl,
    logger,
  });
  const sceneRunner = runners.scene || (renderer ? renderer.renderScene : null);
  const localPool = sceneRunner ? createLocalPool({ runner: sceneRunner, concurrency: config.filmLocalConcurrency, logger }) : null;
  const upscaler = createUpscaler({ ...config.recavsr, logger, ...processRunner });
  const composer = createComposer({ ...config.composer, workDir: config.filmWorkDir, burnSubtitles: config.filmSubtitles, ...processRunner });
  const audio = createAudio({
    workDir: path.join(config.filmWorkDir, 'audio'),
    libraryDir: config.filmMusicDir,
    ytDlpBin: config.ytDlpBin,
    hosts: config.filmAudioHosts,
    downloadEnabled: config.filmAllowAudioDownload,
    logger,
    ...processRunner,
  });
  const photos = createPhotoPipeline({
    workDir: path.join(config.filmWorkDir, 'photos'),
    ffmpegBin: config.composer.ffmpegBin,
    steps: config.photoSteps,
    ...processRunner,
  });
  const inpainter = createInpainter({ ...config.inpaint, fetchImpl });
  const cache = createCache({ dir: config.filmCacheDir });
  const pipeline = createFilmPipeline({ config, db, storage, billing, planner, ray, sky, localPool, upscaler, composer, cache, fetchImpl, logger });

  // What works right now. Variable names only, never values.
  function capabilities() {
    const mode = pipeline.renderMode();
    return {
      enabled: config.filmEnabled,
      planner: {
        engine: 'sglang',
        configured: Boolean(planner),
        missing: [config.sglang.baseUrl ? '' : 'SGLANG_BASE_URL', config.sglang.model ? '' : 'SGLANG_MODEL'].filter(Boolean),
      },
      render: {
        mode,
        missing: mode ? [] : ['RAY_DASHBOARD_URL', 'SKYPILOT_ENABLED', 'SEEDANCE_API_KEY'],
      },
      infra: { provider: 'skypilot', enabled: sky.enabled, dryRun: sky.dryRun, spot: sky.useSpot, priceCeilingSet: sky.maxHourlyUsd > 0 },
      upscaler: {
        engine: upscaler ? 'recavsr' : 'ffmpeg-lanczos',
        configured: Boolean(upscaler),
        missing: upscaler ? [] : ['RECAVSR_COMMAND'],
      },
      audio: audio.capability(),
      photos: photos.capability(),
      inpaint: { configured: inpainter.configured, missing: inpainter.missing },
      cache: { enabled: cache.enabled },
      limits: { minScenes: MIN_SCENES, maxScenes: MAX_SCENES },
    };
  }

  return { pipeline, planner, ray, sky, localPool, upscaler, composer, audio, photos, inpainter, cache, capabilities };
}

module.exports = { filmConfig, createFilmStack };

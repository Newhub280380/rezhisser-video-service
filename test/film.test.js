'use strict';

// Film pipeline tests. External services (SGLang, Ray, SkyPilot, the video
// provider, yt-dlp, the generative inpainting service) are replaced by fakes
// that record what they were asked. ffmpeg is the exception: when it is
// installed, the assembly, the photo clean-up, the built-in studio and the
// product-shot editor are run for real, because a filter graph that only
// "looks right" proves nothing. Background removal runs for real only when
// rembg and its model are already on the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const { validatePlan, planJsonSchema, outputSize, PlanError } = require('../src/film/schema.js');
const { createSglangPlanner, extractJson } = require('../src/film/sglang.js');
const { createRayCluster, createLocalPool, parseMarkers } = require('../src/film/ray.js');
const { createSkyPilot, parseGpuPricing } = require('../src/film/skypilot.js');
const { createUpscaler } = require('../src/film/recavsr.js');
const { createComposer, buildSubtitles, buildAssemblyArgs, srtTime } = require('../src/film/compose.js');
const { createAudio, validateSourceUrl, AudioError } = require('../src/film/audio.js');
const { createCache } = require('../src/film/cache.js');
const { listTemplates, buildPreset } = require('../src/film/templates.js');
const { createPhotoPipeline, sniffImage, parseOutline, findOnPath, PhotoError } = require('../src/film/photos.js');
const { createStudio, motion, pickBackdrop, listBackdrops } = require('../src/film/studio.js');
const { buildStoryboard, buildPhotoReel, applyCaptions } = require('../src/film/storyboard.js');
const { createInpainter } = require('../src/film/inpaint.js');
const { createSceneRenderer, downloadClip } = require('../src/film/render.js');
const { createFilmPipeline } = require('../src/film/jobs.js');
const { filmConfig, createFilmStack, limited } = require('../src/film/index.js');
const { createMemoryDatabase } = require('../src/db/memory.js');
const { withServer, fakeServices, productionOptions, accountClient } = require('./helpers/production.js');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
// Real background removal is exercised only where the tool and its model are
// already present: a test must never download a model.
const REMBG_MODEL_FILES = [
  path.join(process.env.U2NET_HOME || path.join(os.homedir(), '.u2net'), 'u2netp.onnx'),
  path.join(os.homedir(), '.rembg', 'models', 'u2netp', 'u2netp.onnx'),
];
const HAS_REMBG = HAS_FFMPEG && Boolean(findOnPath('rembg')) && REMBG_MODEL_FILES.some((file) => fs.existsSync(file));
const NO_PATH = { PATH: '' };
const quiet = { error() {}, log() {}, warn() {} };

function ffmpegOk(args) {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  assert.equal(result.status, 0, String(result.stderr));
}

function probeVideo(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,pix_fmt', '-of', 'json', file]).stdout.toString();
  return JSON.parse(out).streams[0];
}

// A "product photo": a dark red box on a light backdrop.
function productPhoto(file, size = '640x480') {
  ffmpegOk(['-f', 'lavfi', '-i', `color=c=0xd8d2c8:s=${size}`, '-vf', 'drawbox=x=iw/2-60:y=ih/2-110:w=120:h=220:color=0x7a1f3d:t=fill', '-frames:v', '1', file]);
  return file;
}

function asDataUrl(file) {
  const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'film-test-'));
}

// http-client reads `res.text()` and parses JSON itself.
function jsonRes(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => (typeof value === 'string' ? value : JSON.stringify(value)) };
}

function rawPlan(count = 30, overrides = {}) {
  return {
    title: 'Кофейня',
    logline: 'Один день кофейни',
    style: 'cinematic, soft light',
    aspect: '16:9',
    fps: 24,
    scenes: Array.from({ length: count }, (_, i) => ({
      durationSeconds: 5,
      prompt: `Barista at the counter, morning light, 35mm lens, take ${i + 1}`,
      camera: 'dolly-in',
      onScreenText: i === 0 ? 'Доброе утро' : '',
    })),
    ...overrides,
  };
}

// ---- plan schema ----

test('plan: a valid plan is normalized, numbered and hashed', () => {
  const plan = validatePlan(rawPlan());
  assert.equal(plan.scenes.length, 30);
  assert.equal(plan.totalSeconds, 150);
  assert.deepEqual(plan.scenes.slice(0, 3).map((scene) => scene.n), [1, 2, 3]);
  assert.match(plan.hash, /^[a-f0-9]{64}$/);
});

test('plan: scene count, prompts and durations are enforced', () => {
  assert.throws(() => validatePlan(rawPlan(23)), PlanError);
  assert.throws(() => validatePlan(rawPlan(37)), PlanError);
  // A template plan passes its own bounds explicitly.
  assert.equal(validatePlan(rawPlan(3), { minScenes: 3, maxScenes: 3 }).scenes.length, 3);

  const empty = rawPlan();
  empty.scenes[2].prompt = '   ';
  assert.throws(() => validatePlan(empty), (error) => error.code === 'invalid_plan');

  const odd = rawPlan();
  odd.scenes[0].durationSeconds = 45;
  odd.scenes[1].camera = 'teleport';
  delete odd.scenes[5].durationSeconds;
  assert.throws(() => validatePlan(odd), PlanError);
  odd.scenes[5].durationSeconds = 1;
  const fixed = validatePlan(odd);
  assert.equal(fixed.scenes[0].durationSeconds, 10);
  assert.equal(fixed.scenes[5].durationSeconds, 2);
  assert.equal(fixed.scenes[1].camera, fixed.scenes[0].camera);
});

test('plan: control characters are stripped from prompts', () => {
  const raw = rawPlan();
  raw.scenes[0].prompt = 'Shot one\u202e hidden\u0007 text';
  assert.doesNotMatch(validatePlan(raw).scenes[0].prompt, /[\u202e\u0007]/);
});

test('plan: the JSON schema sent to SGLang matches the validator bounds', () => {
  const schema = planJsonSchema();
  assert.equal(schema.properties.scenes.minItems, 24);
  assert.equal(schema.properties.scenes.maxItems, 36);
  assert.equal(schema.additionalProperties, false);
  assert.ok(!Object.keys(schema).some((key) => key.startsWith('x-')));
});

test('output size follows the aspect, vertical stays vertical', () => {
  assert.deepEqual(outputSize('16:9', '2160p'), { width: 3840, height: 2160 });
  assert.deepEqual(outputSize('9:16', '2160p'), { width: 2160, height: 3840 });
  assert.deepEqual(outputSize('1:1', '1080p'), { width: 1080, height: 1080 });
  const scope = outputSize('2.39:1', '2160p');
  assert.equal(scope.width, 3840);
  assert.equal(scope.height % 2, 0);
});

// ---- SGLang ----

test('sglang: extractJson handles fences and trailing commas', () => {
  assert.deepEqual(extractJson('```json\n{"a":1,}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here: {"a":{"b":2}} ok'), { a: { b: 2 } });
  assert.equal(extractJson('no json'), null);
});

test('sglang: request uses json_schema and an identical system prefix', async () => {
  const bodies = [];
  const planner = createSglangPlanner({
    baseUrl: 'https://sglang.example.com',
    model: 'test-model',
    logger: quiet,
    fetchImpl: async (url, options) => {
      bodies.push({ url, body: JSON.parse(options.body) });
      return jsonRes({ choices: [{ message: { content: JSON.stringify(rawPlan()) } }] });
    },
  });
  await planner.writePlan({ brief: 'Фильм о кофейне' }, { scenes: 30, durationSeconds: 150 });
  await planner.writePlan({ brief: 'Совсем другой фильм' }, { scenes: 24, durationSeconds: 120 });

  const [first, second] = bodies.map((entry) => entry.body);
  assert.equal(bodies[0].url, 'https://sglang.example.com/v1/chat/completions');
  assert.equal(first.response_format.type, 'json_schema');
  assert.equal(first.response_format.json_schema.schema.properties.scenes.minItems, 24);
  assert.equal(first.temperature, 0);
  // Prefix caching needs the same leading tokens on every request.
  assert.equal(first.messages[0].role, 'system');
  assert.equal(first.messages[0].content, second.messages[0].content);
  assert.notEqual(first.messages[1].content, second.messages[1].content);
  // Only documented request fields are sent.
  assert.deepEqual(Object.keys(first).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature', 'top_p']);
});

test('sglang: one repair turn, then fail closed', async () => {
  let calls = 0;
  const answers = [JSON.stringify(rawPlan(4)), JSON.stringify(rawPlan())];
  const planner = createSglangPlanner({
    baseUrl: 'https://sg.example.com',
    model: 'm',
    logger: quiet,
    fetchImpl: async () => jsonRes({ choices: [{ message: { content: answers[Math.min(calls++, 1)] } }] }),
  });
  const result = await planner.writePlan({ brief: 'Фильм' }, {});
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);

  const broken = createSglangPlanner({
    baseUrl: 'https://sg.example.com',
    model: 'm',
    logger: quiet,
    fetchImpl: async () => jsonRes({ choices: [{ message: { content: 'I cannot.' } }] }),
  });
  await assert.rejects(() => broken.writePlan({ brief: 'Фильм' }, {}), (error) => error.code === 'invalid_plan');
});

test('sglang: 503 is retried, 400 is not', async () => {
  let calls = 0;
  const flaky = createSglangPlanner({ baseUrl: 'https://sg.example.com', model: 'm', logger: quiet, maxRetries: 1, fetchImpl: async () => { calls += 1; return jsonRes({}, 503); } });
  await assert.rejects(() => flaky.writePlan({ brief: 'Фильм' }, {}), (error) => error.code === 'sglang_error');
  assert.equal(calls, 2);

  calls = 0;
  const bad = createSglangPlanner({ baseUrl: 'https://sg.example.com', model: 'm', logger: quiet, maxRetries: 3, fetchImpl: async () => { calls += 1; return jsonRes({}, 400); } });
  await assert.rejects(() => bad.writePlan({ brief: 'Фильм' }, {}), (error) => error.status === 400);
  assert.equal(calls, 1);
});

// ---- Ray ----

test('ray: markers are found even behind a log prefix', () => {
  const parsed = parseMarkers('boot\n(pid=42) FILM_PROGRESS {"done":1,"total":2}\nFILM_RESULT {"shots":[{"scene":1,"ok":true}],"failures":[]}\n');
  assert.equal(parsed.progress[0].done, 1);
  assert.equal(parsed.result.shots.length, 1);
});

test('ray: submits one job, reads {logs}, returns the result', async () => {
  const requests = [];
  let polls = 0;
  const ray = createRayCluster({
    apiUrl: 'https://ray.example.com',
    entrypoint: 'python film_job.py',
    pollIntervalMs: 1,
    logger: quiet,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/api/jobs/')) return jsonRes({ job_id: 'raysubmit_1' });
      if (url.endsWith('/logs')) return jsonRes({ logs: 'FILM_PROGRESS {"done":2,"total":2}\nFILM_RESULT {"shots":[{"scene":1,"ok":true,"url":"https://cdn.example.com/1.mp4"}],"failures":[]}\n' });
      polls += 1;
      return jsonRes({ status: polls > 1 ? 'SUCCEEDED' : 'RUNNING' });
    },
  });
  const progress = [];
  const result = await ray.run({ jobId: 'job-1', shots: [{ n: 1, prompt: "it's $HOME `x`" }] }, { onProgress: (step) => progress.push(step) });
  assert.equal(result.shots[0].url, 'https://cdn.example.com/1.mp4');
  assert.equal(progress[0].done, 2);

  const submit = requests[0];
  assert.equal(submit.url, 'https://ray.example.com/api/jobs/');
  // The payload is base64 on the command line: prompt text never meets a shell.
  const encoded = submit.body.entrypoint.match(/^python film_job\.py --payload-gz64 ([A-Za-z0-9+/=]+)$/)[1];
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')).shots[0].prompt, "it's $HOME `x`");
  assert.equal(submit.body.runtime_env, undefined);

  // The driver location and the render service are passed through runtime_env.
  const withEnv = createRayCluster({
    apiUrl: 'https://ray.example.com',
    workingDir: 'https://example.com/driver.zip',
    renderEndpoint: 'https://render.example.com',
    logger: quiet,
    fetchImpl: async (url, options) => { requests.push({ body: JSON.parse(options.body) }); return jsonRes({ job_id: 'raysubmit_3' }); },
  });
  await withEnv.submit({ jobId: 'job-2', shots: [] });
  assert.deepEqual(requests[requests.length - 1].body.runtime_env, { working_dir: 'https://example.com/driver.zip', env_vars: { FILM_RENDER_ENDPOINT: 'https://render.example.com' } });
  // A plan that cannot fit one shell argument is refused before submission.
  await assert.rejects(() => withEnv.submit({ jobId: 'big', blob: require('node:crypto').randomBytes(90000).toString('hex') }), (error) => error.code === 'payload_too_large');
});

test('ray: a failed job without a result throws a bounded error', async () => {
  const ray = createRayCluster({
    apiUrl: 'https://ray.example.com',
    pollIntervalMs: 1,
    logger: quiet,
    fetchImpl: async (url) => {
      if (url.endsWith('/api/jobs/')) return jsonRes({ job_id: 'raysubmit_2' });
      if (url.endsWith('/logs')) return jsonRes({ logs: '' });
      return jsonRes({ status: 'FAILED', message: 'x'.repeat(2000) });
    },
  });
  await assert.rejects(() => ray.run({ jobId: 'j', shots: [] }), (error) => error.code === 'ray_job_failed' && error.message.length <= 300);
  assert.equal(createRayCluster({}), null);
});

test('local pool: bounded concurrency, per-scene failures, no fake clips', async () => {
  let active = 0;
  let peak = 0;
  const pool = createLocalPool({
    concurrency: 2,
    logger: quiet,
    runner: async (scene) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (scene.n === 3) throw Object.assign(new Error('bad prompt'), { code: 'render_failed' });
      return { path: `/tmp/${scene.n}.mp4` };
    },
  });
  const result = await pool.run({ shots: [1, 2, 3, 4, 5].map((n) => ({ n })) });
  assert.equal(result.shots.length, 4);
  assert.deepEqual(result.failures.map((item) => item.scene), [3]);
  assert.equal(peak, 2);

  const empty = await createLocalPool({ logger: quiet }).run({ shots: [{ n: 1 }] });
  assert.equal(empty.shots.length, 0);
  assert.equal(empty.failures[0].code, 'render_not_configured');
});

// ---- SkyPilot ----

test('skypilot: prices are parsed, never guessed', () => {
  const rows = parseGpuPricing([
    { cloud: 'runpod', accelerators: [{ accelerator_name: 'L4', price_per_hour: { on_demand: 0.44, spot: 0.19 } }] },
    { accelerators: [{ name: 'A100', price: 1.9 }, { name: 'T4', price: 'n/a' }] },
  ]);
  assert.equal(rows.length, 3);
  assert.ok(rows.some((row) => row.accelerator === 'L4' && row.spot && row.hourlyUsd === 0.19 && row.cloud === 'runpod'));
  assert.deepEqual(parseGpuPricing('garbage'), []);
});

test('skypilot: cheapest offer respects spot, cloud and the price ceiling', async () => {
  const listing = JSON.stringify([
    { cloud: 'runpod', accelerators: [{ accelerator_name: 'L4', price_per_hour: { on_demand: 0.4, spot: 0.2 } }, { accelerator_name: 'L40S', price_per_hour: { spot: 0.9 } }] },
    { cloud: 'aws', accelerators: [{ accelerator_name: 'L4', price_per_hour: { spot: 0.1 } }, { accelerator_name: 'L40', price_per_hour: { spot: 0.05 } }] },
  ]);
  const cli = async (bin, args) => (args[0] === 'gpus' ? { ok: true, stdout: listing } : { ok: true, stdout: '' });
  const spot = createSkyPilot({ enabled: true, dryRun: false, maxHourlyUsd: 0.5, clouds: ['runpod'], accelerators: ['L4:1', 'L40S:1'], cli, logger: quiet });
  const { offer } = await spot.cheapest();
  assert.equal(offer.cloud, 'runpod');
  assert.equal(offer.hourlyUsd, 0.2);
  // `--gpus` takes name:count, and "L4" must not match "L40".
  assert.equal(offer.spec, 'L4:1');

  const onDemand = createSkyPilot({ enabled: true, dryRun: false, useSpot: false, maxHourlyUsd: 1, accelerators: ['L4:1'], cli, logger: quiet });
  assert.equal((await onDemand.cheapest()).offer.hourlyUsd, 0.4);

  const tight = createSkyPilot({ enabled: true, dryRun: false, maxHourlyUsd: 0.01, accelerators: ['L4:1'], cli, logger: quiet });
  assert.deepEqual(await tight.cheapest(), { offer: null, reason: 'no_offer_under_ceiling' });

  const unparsable = createSkyPilot({ enabled: true, dryRun: false, cli: async () => ({ ok: true, stdout: 'a table' }), logger: quiet });
  assert.equal((await unparsable.cheapest()).reason, 'unparsable_pricing');
});

test('skypilot: launch command is fixed, validated and auto-down', () => {
  const sky = createSkyPilot({ enabled: true, dryRun: false, maxHourlyUsd: 1, taskYaml: 'task.yaml', logger: quiet });
  const args = sky.launchArgs({ clusterName: 'rezhisser-abc-1', accelerator: 'L4:1', cloud: 'runpod', region: 'US', workdir: '/tmp/job', env: { FILM_RENDER_ENDPOINT: 'https://render.example.com' } });
  assert.equal(args[0], 'launch');
  for (const flag of ['--use-spot', '--down', '-y']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--infra') + 1], 'runpod/US');
  assert.equal(args[args.indexOf('--env') + 1], 'FILM_RENDER_ENDPOINT=https://render.example.com');
  assert.throws(() => sky.launchArgs({ clusterName: '../etc', accelerator: 'L4:1' }), (error) => error.code === 'invalid_cluster');
  assert.throws(() => sky.launchArgs({ clusterName: 'ok-name', accelerator: 'L4:1; rm -rf /' }), (error) => error.code === 'invalid_accelerator');
  assert.throws(() => sky.launchArgs({ clusterName: 'ok-name', accelerator: 'L4:1', env: { 'bad key': '1' } }), (error) => error.code === 'invalid_env');
});

test('skypilot: runFilm ships the payload as a file and reads the result from the task log', async () => {
  const dir = tempDir();
  const driver = path.join(dir, 'driver.py');
  fs.writeFileSync(driver, '# driver');
  const seen = [];
  const cli = async (bin, args, options) => {
    seen.push(args);
    options.onLine('(task) FILM_PROGRESS {"done":1,"total":1}');
    options.onLine('(task) FILM_RESULT {"shots":[{"scene":1,"ok":true,"url":"https://cdn.example.com/1.mp4"}],"failures":[]}');
    return { ok: true, stdout: '', stderr: '', status: 0 };
  };
  const sky = createSkyPilot({ enabled: true, dryRun: false, maxHourlyUsd: 1, cli, logger: quiet });
  const workDir = path.join(dir, 'job');
  const progress = [];
  const result = await sky.runFilm({ clusterName: 'rezhisser-abc-1', accelerator: 'L4:1', cloud: 'runpod', payload: { shots: [{ n: 1 }] }, workDir, driverPath: driver, onProgress: (step) => progress.push(step) });
  assert.equal(result.shots[0].scene, 1);
  assert.equal(progress[0].done, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workDir, 'film_payload.json'), 'utf8')), { shots: [{ n: 1 }] });
  assert.ok(fs.existsSync(path.join(workDir, 'film_job.py')));
  assert.ok(!seen[0].join(' ').includes('"shots"'));

  await assert.rejects(
    () => createSkyPilot({ enabled: true, dryRun: false, maxHourlyUsd: 0, cli, logger: quiet }).runFilm({ clusterName: 'rezhisser-abc-1', accelerator: 'L4:1', payload: {}, workDir, driverPath: driver }),
    (error) => error.code === 'ceiling_required',
  );
  await assert.rejects(
    () => createSkyPilot({ enabled: true, dryRun: true, maxHourlyUsd: 1, cli, logger: quiet }).runFilm({ clusterName: 'rezhisser-abc-1', accelerator: 'L4:1', payload: {}, workDir, driverPath: driver }),
    (error) => error.code === 'sky_dry_run',
  );
});

test('skypilot: teardown retries, accepts an absent cluster, reports failure', async () => {
  let calls = 0;
  const flaky = createSkyPilot({ dryRun: false, retryDelayMs: 1, logger: quiet, cli: async () => { calls += 1; return calls < 2 ? { ok: false, code: 'cli_failed', stderr: 'timeout', stdout: '' } : { ok: true, stdout: '', stderr: '' }; } });
  assert.deepEqual(await flaky.teardown('rezhisser-abc-1'), { ok: true, attempts: 2 });

  const gone = createSkyPilot({ dryRun: false, retryDelayMs: 1, logger: quiet, cli: async () => ({ ok: false, code: 'cli_failed', stderr: 'Cluster rezhisser-abc-1 not found', stdout: '' }) });
  assert.equal((await gone.teardown('rezhisser-abc-1')).missing, true);

  const dead = createSkyPilot({ dryRun: false, retryDelayMs: 1, teardownRetries: 2, logger: quiet, cli: async () => ({ ok: false, code: 'cli_failed', stderr: 'api error', stdout: '' }) });
  assert.equal((await dead.teardown('rezhisser-abc-1')).ok, false);
  assert.equal((await dead.teardown('bad name')).ok, false);

  // Dry-run never starts a process.
  const dry = createSkyPilot({ dryRun: true, cli: async () => { throw new Error('must not run'); }, logger: quiet });
  assert.equal((await dry.teardown('rezhisser-abc-1')).dryRun, true);
  assert.equal((await dry.cheapest()).reason, 'dry_run');
});

// ---- upscaler ----

test('upscaler: runs the configured command per clip and reports failures', async () => {
  assert.equal(createUpscaler({ command: '' }), null);
  assert.throws(() => createUpscaler({ command: 'python infer.py' }), /\{in\}/);
  const dir = tempDir();
  const clips = [1, 2].map((n) => ({ shotId: `s${n}`, path: path.join(dir, `scene-${n}.mp4`) }));
  const calls = [];
  const upscaler = createUpscaler({
    command: 'python infer.py --input {in} --output {out}',
    logger: quiet,
    runner: async (bin, args) => {
      calls.push([bin, ...args]);
      const out = args[args.indexOf('--output') + 1];
      if (!out.includes('scene-2')) fs.writeFileSync(out, 'upscaled');
      return { ok: !out.includes('scene-2'), code: 'process_failed' };
    },
  });
  const { results, failures } = await upscaler.upscaleAll(clips);
  assert.deepEqual(calls[0].slice(0, 4), ['python', 'infer.py', '--input', clips[0].path]);
  assert.deepEqual(results, [{ shotId: 's1', path: path.join(dir, 'scene-1.up.mp4') }]);
  assert.deepEqual(failures, [{ shotId: 's2', code: 'upscale_failed' }]);
});

// ---- assembly ----

test('subtitles: one cue per scene with text, timed by scene length', () => {
  const plan = validatePlan(rawPlan());
  plan.scenes[2].voiceover = 'Голос за кадром';
  const { srt, count } = buildSubtitles(plan);
  assert.equal(count, 2);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:05,000\nДоброе утро\n/);
  assert.match(srt, /2\n00:00:10,000 --> 00:00:15,000\nГолос за кадром/);
  assert.equal(srtTime(3661.5), '01:01:01,500');
  assert.equal(srtTime(1.9996), '00:00:02,000');
});

test('assembly command: frame size, order and audio routing', () => {
  const clips = [{ path: 'a.mp4', hasAudio: true }, { path: 'b.mp4', hasAudio: true }];
  const base = { clips, outputPath: 'out.mp4', width: 2160, height: 3840, fps: 24, seconds: 10 };

  const own = buildAssemblyArgs(base);
  assert.equal(own.audioMode, 'scene-audio');
  const graph = own.args[own.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[0:v\]scale=2160:3840:force_original_aspect_ratio=decrease/);
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vcat\]/);

  const music = buildAssemblyArgs({ ...base, music: { path: 'm.mp3' }, subtitles: true });
  assert.equal(music.audioMode, 'music');
  assert.deepEqual(music.args.slice(5, 9), ['-stream_loop', '-1', '-i', 'm.mp3']);
  const musicGraph = music.args[music.args.indexOf('-filter_complex') + 1];
  assert.match(musicGraph, /\[2:a\].*atrim=0:10.*afade=t=out:st=8\.5/);
  assert.match(musicGraph, /subtitles=subtitles\.srt/);

  const both = buildAssemblyArgs({ ...base, music: { path: 'm.mp3' }, voice: { path: 'v.wav' } });
  assert.equal(both.audioMode, 'music+voice');
  assert.match(both.args[both.args.indexOf('-filter_complex') + 1], /asplit=2\[vkey\]\[vmix\];\[music\]\[vkey\]sidechaincompress/);

  const silent = buildAssemblyArgs({ ...base, clips: [{ path: 'a.mp4', hasAudio: false }, { path: 'b.mp4', hasAudio: true }] });
  assert.equal(silent.audioMode, 'none');
  assert.ok(silent.args.includes('-an'));
});

test('assembly: a missing clip is an error before ffmpeg runs', async () => {
  const dir = tempDir();
  const composer = createComposer({ workDir: dir, runner: async () => { throw new Error('must not run'); } });
  await assert.rejects(
    () => composer.assemble({ jobId: 'j', clips: [{ scene: 1, path: path.join(dir, 'nope.mp4') }], size: { width: 320, height: 180 }, seconds: 1 }),
    (error) => error.code === 'missing_clip',
  );
});

test('assembly (real ffmpeg): clips of different sizes + music + subtitles -> one MP4', { skip: !HAS_FFMPEG }, async () => {
  const dir = tempDir();
  const make = (name, size, withAudio) => {
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24:duration=1`];
    if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest');
    args.push('-pix_fmt', 'yuv420p', path.join(dir, name));
    assert.equal(spawnSync('ffmpeg', args).status, 0, `could not create ${name}`);
    return path.join(dir, name);
  };
  // A quote in the file name must not break the command.
  const clips = [{ scene: 1, path: make("it's one.mp4", '320x180', false) }, { scene: 2, path: make('two.mp4', '640x360', false) }];
  const musicPath = path.join(dir, 'music.wav');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.5', musicPath]).status, 0);

  const composer = createComposer({ workDir: dir, preset: 'ultrafast' });
  assert.equal(await composer.probeDuration(clips[0].path) > 0.9, true);
  const film = await composer.assemble({
    jobId: 'job-1',
    clips,
    size: { width: 180, height: 320 },
    seconds: 2,
    srt: '1\n00:00:00,000 --> 00:00:01,000\nПривет: мир\n',
    music: { path: musicPath },
  });
  assert.equal(film.audioMode, 'music');
  assert.equal(film.subtitles, true);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', film.path]);
  const info = JSON.parse(probe.stdout.toString());
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [180, 320]);
  assert.ok(info.streams.some((stream) => stream.codec_type === 'audio'), 'the looped music track is present');
  assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.3, `duration ${info.format.duration}`);

  // Without music, scene audio is kept only if every clip has it.
  const withSound = [{ scene: 1, path: make('s1.mp4', '320x180', true) }, { scene: 2, path: make('s2.mp4', '320x180', true) }];
  assert.equal((await composer.assemble({ jobId: 'job-2', clips: withSound, size: { width: 320, height: 180 }, seconds: 2 })).audioMode, 'scene-audio');
  assert.equal((await composer.assemble({ jobId: 'job-3', clips, size: { width: 320, height: 180 }, seconds: 2 })).audioMode, 'none');
});

// ---- audio ----

test('audio: links are limited to allowed https hosts', () => {
  assert.equal(validateSourceUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(validateSourceUrl('https://youtu.be/abc'), 'https://youtu.be/abc');
  for (const bad of ['http://youtube.com/watch?v=1', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://youtube.com.evil.example/x', 'https://user:pass@youtube.com/x', 'file:///etc/passwd', '--exec=x']) {
    assert.throws(() => validateSourceUrl(bad), AudioError, bad);
  }
});

test('audio: a download lands in the account folder and is resolved by id only', async () => {
  const dir = tempDir();
  const calls = [];
  const audio = createAudio({
    workDir: dir,
    logger: quiet,
    runner: async (bin, args) => {
      calls.push([bin, ...args]);
      fs.writeFileSync(args[args.indexOf('--output') + 1].replace('%(ext)s', 'm4a'), 'audio-bytes');
      return { ok: true, stdout: 'Song Title\n' };
    },
  });
  const track = await audio.downloadByUrl('user-1', 'https://www.youtube.com/watch?v=abc');
  assert.equal(track.title, 'Song Title');
  assert.equal(track.path, undefined);
  // The URL is the last argument, after `--`.
  assert.deepEqual(calls[0].slice(-2), ['--', 'https://www.youtube.com/watch?v=abc']);
  assert.ok(calls[0].includes('--no-playlist'));

  const resolved = audio.resolve('user-1', { downloadId: track.id });
  assert.equal(resolved.title, 'Song Title');
  assert.ok(resolved.path.startsWith(path.join(dir, 'user-1')));
  // Another account, or a path instead of an id, resolves nothing.
  assert.throws(() => audio.resolve('user-2', { downloadId: track.id }), (error) => error.code === 'unknown_track');
  assert.throws(() => audio.resolve('user-1', { downloadId: '../user-1/x' }), (error) => error.code === 'unknown_track');
  assert.equal(audio.resolve('user-1', null), null);

  const missing = createAudio({ workDir: dir, logger: quiet, runner: async () => ({ ok: false, code: 'tool_missing' }) });
  await assert.rejects(() => missing.downloadByUrl('user-1', 'https://youtu.be/abc'), (error) => error.code === 'downloader_missing');
  const off = createAudio({ workDir: dir, downloadEnabled: false, logger: quiet });
  await assert.rejects(() => off.downloadByUrl('user-1', 'https://youtu.be/abc'), (error) => error.code === 'download_disabled');
});

test('audio: the library lists audio files and resolves only its own ids', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'Calm Morning.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const audio = createAudio({ workDir: tempDir(), libraryDir: dir, logger: quiet });
  const tracks = audio.library.list();
  assert.deepEqual(tracks.map((track) => track.title), ['Calm Morning']);
  assert.equal(audio.resolve('user-1', { trackId: tracks[0].id }).path, path.join(dir, 'Calm Morning.mp3'));
  assert.throws(() => audio.resolve('user-1', { trackId: 'nope' }), (error) => error.code === 'unknown_track');
});

// ---- cache ----

test('cache: stable keys, expiry', () => {
  let clock = 1000;
  const cache = createCache({ dir: tempDir(), ttlMs: 100, now: () => clock });
  const key = cache.key('plan', { a: 1, b: 2 });
  assert.equal(key, cache.key('plan', { b: 2, a: 1 }));
  cache.set(key, { title: 'x' });
  assert.deepEqual(cache.get(key), { title: 'x' });
  clock += 200;
  assert.equal(cache.get(key), null);
});

// ---- templates ----

test('templates: the same four answers give the same fixed plan', () => {
  const metadata = { niche: 'кофейня', subject: 'капучино', location: 'стойка у окна', style: 'тёплый' };
  const a = buildPreset({ templateId: 'reels-food', metadata });
  const b = buildPreset({ templateId: 'reels-food', metadata: { ...metadata, cameraMovement: 'Whip Pan', fps: 60 } });
  assert.deepEqual(a.plan, b.plan);
  assert.deepEqual(b.ignoredFields.sort(), ['cameraMovement', 'fps']);
  assert.equal(a.plan.fps, 24);
  assert.equal(a.plan.aspect, '9:16');
  assert.ok(a.plan.scenes.every((scene) => scene.camera === 'pan-left' && scene.durationSeconds === 5));
  assert.match(a.plan.scenes[0].prompt, /капучино/);
  assert.doesNotMatch(JSON.stringify(a.plan), /\{(niche|subject|location|style)\}/);
  // The fixed plan is valid input for the pipeline.
  const count = a.plan.scenes.length;
  assert.equal(validatePlan(a.plan, { aspect: '9:16', minScenes: count, maxScenes: count }).scenes.length, count);
});

test('templates: every template is locked the same way; bad input is rejected', () => {
  const templates = listTemplates();
  assert.ok(templates.length >= 5);
  for (const template of templates) {
    assert.equal(template.locked.cameraMovement, 'Pan Left');
    assert.equal(template.locked.fps, 24);
    assert.equal(template.locked.style, 'Cinematic 4K');
    assert.equal(template.locked.totalSeconds, template.locked.shots * 5);
  }
  assert.throws(() => buildPreset({ templateId: 'nope', metadata: {} }), (error) => error.code === 'unknown_template');
  assert.throws(() => buildPreset({ templateId: 'reels-food', metadata: { niche: 'кафе', subject: 'кофе', location: 'зал' } }), (error) => error.code === 'metadata_required' && error.field === 'style');
  // Braces cannot inject a placeholder into the template.
  const injected = buildPreset({ templateId: 'reels-food', metadata: { niche: '{style}', subject: 'кофе', location: 'зал', style: 'тёплый' } });
  assert.doesNotMatch(injected.plan.logline, /[{}]/);
});

// ---- photos ----

test('photos: real magic bytes decide, uploads are validated', async () => {
  assert.equal(sniffImage(Buffer.from(PNG_1PX.split(',')[1], 'base64')).mime, 'image/png');
  assert.equal(sniffImage(Buffer.from('definitely not an image')), null);
  const pipeline = createPhotoPipeline({ workDir: tempDir(), env: NO_PATH, runner: async () => ({ ok: false, code: 'step_failed' }) });
  await assert.rejects(() => pipeline.prepareAll([], { userId: 'u1' }), PhotoError);
  await assert.rejects(() => pipeline.prepareAll(['data:image/png;base64,bm90YW5pbWFnZQ=='], { userId: 'u1' }), (error) => error.code === 'unsupported_photo');
  await assert.rejects(() => pipeline.prepareAll([PNG_1PX], { userId: '../x' }), (error) => error.code === 'invalid_owner');
});

test('photos: enhancement is built in; a failed background removal is reported; duplicates dropped', async () => {
  const dir = tempDir();
  const calls = [];
  const runner = async (bin, args) => {
    calls.push(bin);
    if (bin === 'rembg') return { ok: false, code: 'step_failed' };
    fs.writeFileSync(args[args.length - 1], 'jpeg-bytes');
    return { ok: true };
  };
  const pipeline = createPhotoPipeline({ workDir: dir, steps: { removeBg: 'rembg i {in} {out}' }, env: NO_PATH, runner });
  const photos = await pipeline.prepareAll([PNG_1PX, PNG_1PX], { userId: 'user-1' });
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].report, [
    { step: 'remove-bg', status: 'failed', reason: 'step_failed' },
    { step: 'enhance', status: 'done', engine: 'built-in' },
    { step: 'normalize', status: 'done' },
  ]);
  assert.equal(photos[0].fullyProcessed, false);
  assert.equal(photos[0].cutout, false);
  // Clean-up first (two sizes), then background removal on the cleaned photo.
  assert.deepEqual(calls, ['ffmpeg', 'ffmpeg', 'rembg']);
  assert.deepEqual(pipeline.capability().missing, []);

  // Only the two clean JPEGs are kept, and only their owner can resolve them.
  const id = photos[0].id;
  assert.deepEqual(fs.readdirSync(path.join(dir, 'user-1')).sort(), [`${id}.full.jpg`, `${id}.jpg`]);
  const resolved = pipeline.resolve('user-1', [id])[0];
  assert.equal(resolved.path, path.join(dir, 'user-1', `${id}.jpg`));
  assert.equal(resolved.fullPath, path.join(dir, 'user-1', `${id}.full.jpg`));
  assert.equal(resolved.cutPath, null);
  assert.throws(() => pipeline.resolve('user-2', [id]), (error) => error.code === 'unknown_photo');
  assert.throws(() => pipeline.resolve('user-1', ['../../etc/passwd']), (error) => error.code === 'unknown_photo');
});

test('photos: rembg is used when it is installed, never when switched off', async () => {
  const bin = tempDir();
  const tool = path.join(bin, process.platform === 'win32' ? 'rembg.exe' : 'rembg');
  fs.writeFileSync(tool, '');
  const env = { PATH: bin };
  assert.equal(findOnPath('rembg', env), tool);
  assert.equal(findOnPath('rembg', NO_PATH), null);

  const found = createPhotoPipeline({ workDir: tempDir(), env }).capability();
  assert.deepEqual(found.steps[0], { step: 'remove-bg', configured: true, engine: 'rembg (u2netp)' });
  assert.deepEqual(found.missing, []);
  const absent = createPhotoPipeline({ workDir: tempDir(), env: NO_PATH }).capability();
  assert.equal(absent.steps[0].configured, false);
  assert.deepEqual(absent.missing, ['FILM_REMOVE_BG_COMMAND']);
  assert.equal(createPhotoPipeline({ workDir: tempDir(), env, steps: { removeBg: 'off' } }).capability().steps[0].configured, false);
  // Enhancement and normalisation never depend on anything external.
  assert.ok(absent.steps.slice(1).every((step) => step.configured));

  // The installed tool is started with a fixed argv; a cut-out with no
  // transparency is "no subject", not a success.
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === tool) fs.writeFileSync(args[args.length - 1], 'png');
    if (cmd === 'ffmpeg' && args.includes('null')) return { ok: true, stdout: 'lavfi.bbox.x1=0\nlavfi.bbox.y1=0\nlavfi.bbox.w=64\nlavfi.bbox.h=64\nlavfi.signalstats.YAVG=255\n' };
    return { ok: true };
  };
  const pipeline = createPhotoPipeline({ workDir: tempDir(), env, runner });
  const out = path.join(tempDir(), 'cut.png');
  assert.deepEqual(await pipeline.cutSubject('in.jpg', out), { ok: false, reason: 'no_subject' });
  assert.deepEqual(calls[0], [tool, 'i', '-m', 'u2netp', 'in.jpg', out]);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(parseOutline('lavfi.bbox.x1=646\nlavfi.bbox.y1=147\nlavfi.bbox.w=309\nlavfi.bbox.h=807\nlavfi.signalstats.YAVG=29.8\n').box, { x: 646, y: 147, w: 309, h: 807 });
  assert.equal(parseOutline('nothing'), null);
});

test('photos (real ffmpeg): a transparent PNG becomes a clean JPEG', { skip: !HAS_FFMPEG }, async () => {
  const dir = tempDir();
  const source = path.join(dir, 'src.png');
  // 300x200 half-transparent red: an odd-ish size with an alpha channel.
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=301x200,format=rgba', '-frames:v', '1', source]);
  const pipeline = createPhotoPipeline({ workDir: dir, steps: { removeBg: 'off' } });
  const [photo] = await pipeline.prepareAll([asDataUrl(source)], { userId: 'user-1' });
  assert.deepEqual(photo.report.map((step) => step.status), ['skipped', 'done', 'done']);
  const resolved = pipeline.resolve('user-1', [photo.id])[0];
  for (const file of [resolved.path, resolved.fullPath]) {
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', file]).stdout.toString());
    assert.equal(probe.streams[0].codec_name, 'mjpeg');
    assert.equal(probe.streams[0].width % 2, 0);
    assert.equal(probe.streams[0].height, 200);
    assert.doesNotMatch(probe.streams[0].pix_fmt, /a$/);
  }
});

test('photos (real rembg): the subject is cut out and cropped to its outline', { skip: !HAS_REMBG }, async () => {
  const dir = tempDir();
  const pipeline = createPhotoPipeline({ workDir: dir });
  const [photo] = await pipeline.prepareAll([asDataUrl(productPhoto(path.join(dir, 'p.jpg')))], { userId: 'user-1' });
  assert.deepEqual(photo.report.map((step) => [step.step, step.status]), [['remove-bg', 'done'], ['enhance', 'done'], ['normalize', 'done']]);
  assert.equal(photo.cutout, true);
  const cut = pipeline.resolve('user-1', [photo.id])[0].cutPath;
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', cut]).stdout.toString()).streams[0];
  assert.match(probe.pix_fmt, /rgba/);
  // Cropped to the box (120x220 in the source), then enlarged: taller than wide.
  assert.ok(probe.height > probe.width * 1.5, JSON.stringify(probe));
});

// ---- built-in studio ----

test('studio: camera moves are bounded expressions; the backdrop follows the style', () => {
  const size = { width: 1080, height: 1920 };
  assert.deepEqual(motion('static', 5, size), { z: '1', dx: '0', dy: '0' });
  // The camera pans left, so the subject travels right: from -a to +a.
  assert.equal(motion('pan-left', 5, size).dx, '98*((t/5)-0.5)');
  assert.equal(motion('pan-right', 5, size).dx, '-98*((t/5)-0.5)');
  assert.equal(motion('dolly-in', 4, size).z, '(1+0.09*(t/4))');
  assert.equal(pickBackdrop('dark', 'тёплый'), 'dark');
  assert.equal(pickBackdrop(undefined, 'тёплый минимализм'), 'warm');
  assert.equal(pickBackdrop('nope', ''), 'light');
  assert.ok(listBackdrops().length >= 5);
});

test('studio (real ffmpeg): a photo becomes a clip of the exact size and length; the subject is not redrawn', { skip: !HAS_FFMPEG }, async () => {
  const dir = tempDir();
  const photo = productPhoto(path.join(dir, 'p.jpg'));
  // The cut-out: the product box alone on transparency.
  const cut = path.join(dir, 'cut.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=0x7a1f3d:s=120x220,format=rgba', '-frames:v', '1', cut]);
  const studio = createStudio({ workDir: dir });
  const context = { jobId: 'job', fps: 24, size: { width: 540, height: 960 } };

  const full = await studio.renderScene({ n: 1, durationSeconds: 2, camera: 'pan-left', photo: { path: photo } }, context);
  assert.equal(full.look, 'photo');
  assert.deepEqual(probeVideo(full.path), { codec_name: 'h264', width: 540, height: 960, pix_fmt: 'yuv420p', nb_read_frames: '48' });

  const pack = await studio.renderScene({ n: 2, durationSeconds: 2, camera: 'static', photo: { path: photo, cutPath: cut } }, { ...context, backdrop: 'dark' });
  assert.equal(pack.look, 'packshot');
  assert.equal(probeVideo(pack.path).nb_read_frames, '48');
  // Centre pixel = the product's own colour; corner = the dark backdrop.
  const pixel = (x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', pack.path, '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout];
  const centre = pixel(270, 480);
  assert.ok(Math.abs(centre[0] - 0x7a) < 12 && Math.abs(centre[1] - 0x1f) < 12 && Math.abs(centre[2] - 0x3d) < 12, String(centre));
  assert.ok(pixel(6, 6).every((channel) => channel < 40));
  // Regression: a shrinking subject (dolly-out) used to crash ffmpeg when the
  // shadow was derived from the animated layer. Every move must render.
  for (const camera of ['dolly-out', 'dolly-in', 'orbit', 'crane-up', 'handheld', 'pan-right']) {
    const clip = await studio.renderScene({ n: 10, durationSeconds: 2, camera, photo: { path: photo, cutPath: cut } }, context);
    assert.equal(probeVideo(clip.path).nb_read_frames, '48', camera);
  }
  // "cutout: false" keeps the whole photo even when a cut-out exists.
  assert.equal((await studio.renderScene({ n: 3, durationSeconds: 2, camera: 'dolly-in', photo: { path: photo, cutPath: cut } }, { ...context, cutout: false })).look, 'photo');
  await assert.rejects(() => studio.renderScene({ n: 4, durationSeconds: 2 }, context), (error) => error.code === 'photo_required');
});

// ---- built-in storyboard ----

test('storyboard: a long film is planned without a language model, the same way every time', () => {
  const brief = { brief: 'Один день небольшой кофейни', location: 'стойка у окна', style: 'тёплый свет' };
  const plan = buildStoryboard(brief, { aspect: '9:16', scenes: 30, durationSeconds: 150 });
  assert.equal(plan.scenes.length, 30);
  assert.equal(plan.aspect, '9:16');
  assert.equal(plan.totalSeconds, 150);
  assert.equal(plan.scenes[0].camera, 'dolly-in');
  assert.equal(plan.scenes[29].title.startsWith('Финал'), true);
  assert.ok(plan.scenes.every((scene) => /Один день небольшой кофейни/.test(scene.prompt) && /тёплый свет/.test(scene.prompt)));
  // More than one camera move, so the film does not look like a slideshow.
  assert.ok(new Set(plan.scenes.map((scene) => scene.camera)).size >= 5);
  assert.equal(buildStoryboard(brief, { aspect: '9:16', scenes: 30, durationSeconds: 150 }).hash, plan.hash);

  // Captions are spread over the whole film, in order.
  const captioned = applyCaptions(plan, ['Открытие', 'Работа', 'Вечер']);
  assert.deepEqual(captioned.scenes.map((scene, i) => (scene.onScreenText ? i : null)).filter((i) => i !== null), [0, 10, 20]);
  assert.equal(applyCaptions(plan, []), plan);

  const reel = buildPhotoReel({ count: 5, secondsPerPhoto: 3 });
  assert.equal(reel.scenes.length, 5);
  assert.equal(reel.aspect, '9:16');
  assert.equal(reel.totalSeconds, 15);
  assert.equal(buildPhotoReel({ count: 99 }).scenes.length, 36);
});

// ---- inpaint ----

test('inpaint: generative modes need the service and name the variables; a request keeps the source intact', async () => {
  const off = createInpainter({});
  assert.deepEqual(off.missing, ['INPAINT_BASE_URL', 'INPAINT_MODEL']);
  assert.equal(off.capability().builtIn.available, false);
  await assert.rejects(() => off.edit({ image: PNG_1PX, mask: PNG_1PX, mode: 'replace' }), (error) => error.code === 'inpaint_not_configured' && error.status === 503);

  const bodies = [];
  const inpainter = createInpainter({
    baseUrl: 'https://inpaint.example.com',
    model: 'fill-model',
    fetchImpl: async (url, options) => {
      bodies.push({ url, body: JSON.parse(options.body) });
      return jsonRes({ image_url: 'https://cdn.example.com/out.png' });
    },
  });
  const result = await inpainter.edit({ image: PNG_1PX, mask: PNG_1PX, prompt: 'glass jar', reference: PNG_1PX, mode: 'replace' });
  assert.equal(result.imageUrl, 'https://cdn.example.com/out.png');
  assert.equal(result.engine, 'external');
  assert.equal(bodies[0].url, 'https://inpaint.example.com/inpaint');
  assert.equal(bodies[0].body.preserve_unmasked, true);
  assert.equal(bodies[0].body.image, PNG_1PX);
  assert.equal(bodies[0].body.reference, PNG_1PX);

  const jpegMask = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12)]).toString('base64')}`;
  await assert.rejects(() => inpainter.edit({ image: PNG_1PX, mask: jpegMask, prompt: 'x', mode: 'replace' }), (error) => error.code === 'invalid_mask');
  await assert.rejects(() => inpainter.edit({ image: 'nope', mask: PNG_1PX, prompt: 'x', mode: 'replace' }), (error) => error.field === 'image');
  await assert.rejects(() => inpainter.edit({ image: PNG_1PX, mask: PNG_1PX, prompt: 'x', mode: 'explode' }), (error) => error.code === 'invalid_mode');
  await assert.rejects(() => inpainter.edit({ image: PNG_1PX, prompt: 'x', mode: 'remove' }), (error) => error.code === 'mask_required');

  const bad = createInpainter({ baseUrl: 'https://inpaint.example.com', model: 'm', fetchImpl: async () => jsonRes({ image_url: 'http://insecure/x.png' }) });
  await assert.rejects(() => bad.edit({ image: PNG_1PX, mask: PNG_1PX, prompt: 'x', mode: 'replace' }), (error) => error.code === 'inpaint_failed');
});

test('product shots (real ffmpeg): background, insert and erase never repaint the product', { skip: !HAS_FFMPEG }, async () => {
  const dir = tempDir();
  const source = productPhoto(path.join(dir, 'p.jpg'));
  // Mask: transparent canvas with an opaque white rectangle, as the page sends it.
  const mask = path.join(dir, 'mask.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=black@0:s=640x480,format=rgba', '-vf', 'drawbox=x=40:y=60:w=160:h=200:color=white@1:t=fill:replace=1', '-frames:v', '1', mask]);
  const studio = createStudio({ workDir: dir });
  // Stand-in for background removal: the product box alone, same canvas size.
  const cutter = {
    cutSubject: async (input, output) => {
      ffmpegOk(['-f', 'lavfi', '-i', 'color=c=black@0:s=640x480,format=rgba', '-vf', 'drawbox=x=260:y=130:w=120:h=220:color=0x7a1f3d@1:t=fill:replace=1', '-frames:v', '1', output]);
      return { ok: true, box: { x: 260, y: 130, w: 120, h: 220 }, coverage: 0.09 };
    },
    adopt: async () => ({ id: 'a'.repeat(64) }),
  };
  const editor = createInpainter({ studio, photos: cutter, workDir: path.join(dir, 'edits') });
  assert.deepEqual(editor.capability().builtIn.modes, ['background', 'insert', 'erase']);
  assert.equal(editor.configured, true);

  const save = (result, name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(result.image.split(',')[1], 'base64'));
    return file;
  };
  const pixel = (file, x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout];
  const near = (actual, expected, tolerance = 14) => actual.every((channel, i) => Math.abs(channel - expected[i]) <= tolerance);
  const product = [0x7a, 0x1f, 0x3d];
  const wall = [0xd8, 0xd2, 0xc8];

  // background: the product keeps its pixels and place, the wall is replaced.
  const background = await editor.edit({ image: asDataUrl(source), mode: 'background', backdrop: 'dark' }, { userId: 'user-1' });
  assert.equal(background.engine, 'studio');
  assert.equal(background.photoId, 'a'.repeat(64));
  const bgFile = save(background, 'bg.jpg');
  assert.ok(near(pixel(bgFile, 320, 240), product), String(pixel(bgFile, 320, 240)));
  assert.ok(pixel(bgFile, 20, 20).every((channel) => channel < 70), String(pixel(bgFile, 20, 20)));

  // insert: the product photo lands inside the mask; the rest is untouched.
  const reference = path.join(dir, 'ref.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=0x1f5a7a:s=100x100', '-frames:v', '1', reference]);
  const noCut = createInpainter({ studio, photos: { cutSubject: async () => ({ ok: false, reason: 'no_subject' }), adopt: cutter.adopt }, workDir: path.join(dir, 'edits') });
  const inserted = await noCut.edit({ image: asDataUrl(source), mask: asDataUrl(mask), reference: asDataUrl(reference), mode: 'insert' }, { userId: 'user-1' });
  assert.deepEqual(inserted.notes, ['reference_background_kept']);
  const insFile = save(inserted, 'ins.jpg');
  assert.ok(near(pixel(insFile, 120, 160), [0x1f, 0x5a, 0x7a]), String(pixel(insFile, 120, 160)));
  assert.ok(near(pixel(insFile, 320, 240), product));
  assert.ok(near(pixel(insFile, 600, 20), wall));

  // erase: the masked product area is filled from the wall around it.
  const eraseMask = path.join(dir, 'erase.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=black@0:s=640x480,format=rgba', '-vf', 'drawbox=x=240:y=110:w=160:h=260:color=white@1:t=fill:replace=1', '-frames:v', '1', eraseMask]);
  const erased = save(await editor.edit({ image: asDataUrl(source), mask: asDataUrl(eraseMask), mode: 'erase' }, { userId: 'user-1' }), 'erase.jpg');
  assert.ok(near(pixel(erased, 320, 240), wall, 20), String(pixel(erased, 320, 240)));

  await assert.rejects(() => editor.edit({ image: asDataUrl(source), mode: 'insert' }, { userId: 'user-1' }), (error) => error.code === 'mask_required');
  await assert.rejects(() => editor.edit({ image: asDataUrl(source), mask: asDataUrl(mask), mode: 'insert' }, { userId: 'user-1' }), (error) => error.code === 'reference_required');
  await assert.rejects(() => editor.edit({ image: asDataUrl(source), mode: 'background', backdrop: 'neon' }, { userId: 'user-1' }), (error) => error.code === 'invalid_backdrop');
  await assert.rejects(() => noCut.edit({ image: asDataUrl(source), mode: 'background' }, { userId: 'user-1' }), (error) => error.code === 'no_subject' && error.status === 422);
  // Nothing is left behind in the work folder.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'edits', 'user-1')), []);
});

// ---- local scene renderer ----

test('renderer: submits 480p with the first frame, downloads the clip to disk', async () => {
  const dir = tempDir();
  const submitted = [];
  const provider = {
    acquire: () => () => {},
    submit: async (input) => { submitted.push(input); return 'task-1'; },
    get: async () => ({ status: 'succeeded', videoUrl: 'https://cdn.example.com/v.mp4' }),
    cancel: async () => {},
  };
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Map(), body: (async function* stream() { yield Buffer.from('mp4-bytes'); })() });
  const renderer = createSceneRenderer({ provider, workDir: dir, pollIntervalMs: 1, fetchImpl, logger: quiet });
  const out = await renderer.renderScene({ n: 2, prompt: 'p', durationSeconds: 5, image: PNG_1PX }, { jobId: 'job', aspect: '2.39:1', resolution: '480p' });
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'mp4-bytes');
  assert.deepEqual(submitted[0], { prompt: 'p', image: PNG_1PX, aspect: '21:9', duration: 5, resolution: '480p' });
  assert.equal(createSceneRenderer({ provider: null }), null);

  await assert.rejects(() => downloadClip('http://cdn/x.mp4', path.join(dir, 'a.mp4'), { fetchImpl }), (error) => error.code === 'invalid_clip_url');
  const huge = async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(600 * 1024 * 1024)]]), body: [] });
  await assert.rejects(() => downloadClip('https://cdn/x.mp4', path.join(dir, 'b.mp4'), { fetchImpl: huge }), (error) => error.code === 'clip_too_large');
});

test('seedance: a per-request resolution overrides the configured default', () => {
  const { createSeedanceProvider } = require('../src/providers/seedance.js');
  const provider = createSeedanceProvider({ apiKey: 'k', model: 'seedance-test', resolution: '720p' });
  assert.equal(provider.buildRequest({ prompt: 'p', aspect: '16:9', duration: 5 }).resolution, '720p');
  assert.equal(provider.buildRequest({ prompt: 'p', aspect: '16:9', duration: 5, resolution: '480p' }).resolution, '480p');
});

// ---- orchestrator ----

function fakeSky(overrides = {}) {
  const calls = { run: [], teardown: [] };
  return {
    calls,
    enabled: true,
    dryRun: false,
    useSpot: true,
    maxHourlyUsd: 1,
    cheapest: async () => ({ offer: { accelerator: 'L4', spec: 'L4:1', cloud: 'runpod', region: 'US', hourlyUsd: 0.4, spot: true } }),
    runFilm: async (options) => {
      calls.run.push(options);
      return { shots: options.payload.shots.map((shot) => ({ scene: shot.n, ok: true, url: `https://cdn.example.com/${shot.n}.mp4` })), failures: [] };
    },
    teardown: async (cluster) => { calls.teardown.push(cluster); return { ok: true }; },
    ...overrides,
  };
}

function fakeBilling() {
  const events = [];
  return {
    events,
    consumeGeneration: async () => { events.push('consume'); return 'credits'; },
    recordGeneration: async () => { events.push('record'); },
    refundGeneration: async () => { events.push('refund'); },
  };
}

async function pipelineFixture({ sky = null, ray = null, runner, planner, upscaler = null, billing = fakeBilling(), storage = null, fetchImpl, now, studioRunner = null, videoModel = true, config = {} } = {}) {
  const workDir = tempDir();
  const db = createMemoryDatabase({ dataDir: tempDir() });
  const user = await db.createUser({ id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com', passwordHash: 'x' });
  const sceneRunner = runner || (async (scene, context) => {
    const file = path.join(workDir, context.jobId, 'clips', `scene-${scene.n}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'clip');
    return { path: file };
  });
  const assembled = [];
  const composer = {
    probeDuration: async () => 5,
    assemble: async (options) => {
      assembled.push(options);
      const file = path.join(workDir, String(options.jobId), 'final.mp4');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'final-mp4');
      return { path: file, bytes: 9, audioMode: options.music ? 'music' : 'none', subtitles: Boolean(options.srt) };
    },
  };
  const pipeline = createFilmPipeline({
    config: {
      ...filmConfig({}),
      filmEnabled: true,
      filmWorkDir: workDir,
      videoUrlTtlSeconds: 3600,
      filmDriverPath: path.join(workDir, 'driver.py'),
      filmRenderEndpoint: 'https://render.example.com',
      ...config,
    },
    db,
    storage,
    billing,
    planner: planner === undefined ? { model: 'test-model', writePlan: async () => ({ plan: validatePlan(rawPlan()) }) } : planner,
    ray,
    sky,
    localPool: sky || ray || !videoModel ? null : createLocalPool({ runner: sceneRunner, concurrency: 4, logger: quiet }),
    studioPool: studioRunner ? createLocalPool({ runner: studioRunner, concurrency: 2, logger: quiet }) : null,
    upscaler,
    composer,
    cache: null,
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, headers: new Map(), body: (async function* stream() { yield Buffer.from('clip'); })() })),
    logger: quiet,
    ...(now ? { now } : {}),
  });
  async function finished(id) {
    for (let i = 0; i < 400; i += 1) {
      const job = await db.getFilmJob(id);
      if (!['queued', 'planning', 'provisioning', 'rendering', 'upscaling', 'assembling'].includes(job.status) && pipeline.activeCount() === 0) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('film job did not finish');
  }
  return { pipeline, db, user, billing, assembled, workDir, finished };
}

test('pipeline: a 30-scene film runs locally end to end', async () => {
  const fx = await pipelineFixture();
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Один день кофейни, 30 сцен' }, scenes: 30, aspect: '16:9' });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.engine, 'sglang');
  assert.equal(done.progress, 100);
  assert.equal(done.infra.provider, 'local');
  // No ReCaVSR configured: the job says it was a plain resize.
  assert.equal(done.infra.upscaler, 'ffmpeg-lanczos');
  const shots = await fx.db.listFilmShots(job.id);
  assert.equal(shots.length, 30);
  assert.ok(shots.every((shot) => shot.status === 'ready'));
  // Scenes are assembled in order, at the film's output size, with subtitles.
  const call = fx.assembled[0];
  assert.deepEqual(call.clips.map((clip) => clip.scene), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(call.size, { width: 3840, height: 2160 });
  assert.match(call.srt, /Доброе утро/);
  assert.deepEqual(fx.billing.events, ['consume', 'record']);
  // The buyer sees a download route, never a server path.
  const view = fx.pipeline.publicJob(done);
  assert.equal(view.video.download, `/api/film/jobs/${job.id}/video`);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(fx.workDir.replace(/\\/g, '\\\\').slice(0, 12)));
});

test('pipeline: a template needs no language model; without SGLang a long film uses the built-in storyboard', async () => {
  const fx = await pipelineFixture({ planner: null });
  const preset = buildPreset({ templateId: 'reels-food', metadata: { niche: 'кофейня', subject: 'капучино', location: 'стойка', style: 'тёплый' } });
  const job = await fx.pipeline.start(fx.user, { templateId: preset.templateId, presetPlan: preset.plan });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.engine, 'template');
  assert.equal(done.sceneCount, 3);
  assert.deepEqual(fx.assembled[0].size, { width: 2160, height: 3840 });
  assert.equal(fx.assembled[0].frameRate, 24);

  // No planner configured: the film is still made, and says who planned it.
  const long = await fx.finished((await fx.pipeline.start(fx.user, { brief: { brief: 'Длинный фильм про кофейню' }, scenes: 24, captions: ['Открытие', 'Финал'] })).id);
  assert.equal(long.status, 'succeeded');
  assert.equal(long.engine, 'storyboard');
  assert.equal(long.plan.scenes.length, 24);
  assert.match(fx.assembled[1].srt, /Открытие[\s\S]*Финал/);
});

test('pipeline: a planner that is down does not stop the film', async () => {
  const fx = await pipelineFixture({ planner: { model: 'm', writePlan: async () => { throw Object.assign(new Error('down'), { code: 'sglang_unreachable' }); } } });
  const done = await fx.finished((await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм, когда модель недоступна' }, scenes: 24 })).id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.engine, 'storyboard');
  assert.equal(done.infra.plannerFallback, 'sglang_unreachable');
  assert.deepEqual(fx.billing.events, ['consume', 'record']);
});

test('pipeline: prompts carry the camera move and the consistency block; photos become first frames', async () => {
  const seen = [];
  const dir = tempDir();
  const fx = await pipelineFixture({
    runner: async (scene, context) => {
      seen.push({ scene, context });
      const file = path.join(dir, `scene-${scene.n}.mp4`);
      fs.writeFileSync(file, 'clip');
      return { path: file };
    },
    planner: { model: 'm', writePlan: async () => ({ plan: validatePlan(rawPlan(24, { characters: [{ name: 'Анна', description: 'бариста, 30 лет', wardrobe: 'зелёный фартук' }] })) }) },
  });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм про бариста Анну' }, scenes: 24, photos: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'] });
  assert.equal((await fx.finished(job.id)).status, 'succeeded');
  const first = seen.find((entry) => entry.scene.n === 1);
  assert.match(first.scene.prompt, /camera movement: slow dolly in/);
  assert.match(first.scene.prompt, /Анна: бариста, 30 лет, wardrobe: зелёный фартук/);
  assert.equal(first.context.resolution, '480p');
  // Photos are used in order and cycle.
  assert.equal(first.scene.image, 'data:image/jpeg;base64,AAA');
  assert.equal(seen.find((entry) => entry.scene.n === 2).scene.image, 'data:image/jpeg;base64,BBB');
  assert.equal(seen.find((entry) => entry.scene.n === 3).scene.image, 'data:image/jpeg;base64,AAA');
});

test('pipeline: own photos are rendered by the built-in studio — no video model, no upscale, any render mode', async () => {
  const dir = tempDir();
  const photoA = path.join(dir, 'a.jpg');
  const photoB = path.join(dir, 'b.jpg');
  fs.writeFileSync(photoA, 'a');
  fs.writeFileSync(photoB, 'b');
  const photos = [{ id: 'a', path: photoA, fullPath: photoA, cutPath: null }, { id: 'b', path: photoB, fullPath: photoB, cutPath: null }];
  const seen = [];
  const studioRunner = async (scene, context) => {
    seen.push({ scene, context });
    const file = path.join(dir, `studio-${scene.n}.mp4`);
    fs.writeFileSync(file, 'clip');
    return { path: file, engine: 'studio' };
  };
  const upscaled = [];
  const upscaler = { upscaleAll: async (clips) => { upscaled.push(clips); return { results: [], failures: [] }; } };
  const reel = buildPhotoReel({ count: 2, secondsPerPhoto: 3 });

  // 1. No video model at all: the reel is still made.
  const bare = await pipelineFixture({ videoModel: false, studioRunner, upscaler, planner: null });
  assert.equal(bare.pipeline.renderMode(), null);
  const job = await bare.pipeline.start(bare.user, { templateId: 'photo-reel', presetPlan: reel, photos, backdrop: 'dark', cutout: false, captions: ['Новая коллекция'] });
  const done = await bare.finished(job.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.engine, 'photo-reel');
  assert.equal(done.infra.provider, 'studio');
  // Rendered straight at the final size: nothing to upscale.
  assert.equal(done.infra.upscaler, 'native');
  assert.equal(upscaled.length, 0);
  const first = seen.find((entry) => entry.scene.n === 1);
  assert.deepEqual(first.context.size, { width: 2160, height: 3840 });
  assert.equal(first.context.backdrop, 'dark');
  assert.equal(first.context.cutout, false);
  assert.equal(first.scene.photo.path, photoA);
  assert.equal(first.scene.camera, 'dolly-in');
  assert.equal(first.scene.image, undefined);
  assert.equal(seen.find((entry) => entry.scene.n === 2).scene.photo.path, photoB);
  assert.match(bare.assembled[0].srt, /Новая коллекция/);
  // Without photos there is nothing to shoot, and nothing is charged.
  await assert.rejects(() => bare.pipeline.start(bare.user, { brief: { brief: 'Фильм без фото и без модели' } }), (error) => error.code === 'render_not_configured' && /фото/.test(error.message));
  assert.deepEqual(bare.billing.events, ['consume', 'record']);

  // 2. On a cluster deployment photos no longer fail: the studio renders them here.
  const sky = fakeSky();
  const cluster = await pipelineFixture({ sky, studioRunner, planner: null });
  assert.equal(cluster.pipeline.renderMode(), 'sky');
  const onCluster = await cluster.finished((await cluster.pipeline.start(cluster.user, { templateId: 'photo-reel', presetPlan: reel, photos })).id);
  assert.equal(onCluster.status, 'succeeded');
  assert.equal(onCluster.infra.provider, 'studio');
  assert.equal(sky.calls.run.length, 0);
  await assert.rejects(() => cluster.pipeline.start(cluster.user, { templateId: 'photo-reel', presetPlan: reel, photos, photoMode: 'ai' }), (error) => error.code === 'photos_need_local_render');

  // 3. With a video model on this host the buyer chooses: studio or the model.
  const local = await pipelineFixture({ studioRunner });
  assert.equal(local.pipeline.modeFor(photos, undefined), 'local');
  assert.equal(local.pipeline.modeFor(photos, 'studio'), 'studio');
  assert.equal(local.pipeline.modeFor(photos, 'ai'), 'local');
  assert.equal(local.pipeline.modeFor([], 'studio'), 'local');
});

test('pipeline: FILM_STUDIO_FREE makes studio reels free; a failed studio scene still fails the job', async () => {
  const dir = tempDir();
  const photo = path.join(dir, 'a.jpg');
  fs.writeFileSync(photo, 'a');
  const photos = [{ id: 'a', path: photo, fullPath: photo, cutPath: null }];
  const reel = buildPhotoReel({ count: 1 });
  const ok = async (scene) => {
    const file = path.join(dir, `s-${scene.n}.mp4`);
    fs.writeFileSync(file, 'clip');
    return { path: file };
  };
  const free = await pipelineFixture({ videoModel: false, studioRunner: ok, planner: null, config: { filmStudioFree: true } });
  assert.equal((await free.finished((await free.pipeline.start(free.user, { templateId: 'photo-reel', presetPlan: reel, photos })).id)).status, 'succeeded');
  assert.deepEqual(free.billing.events, []);

  const broken = await pipelineFixture({ videoModel: false, planner: null, studioRunner: async () => { throw Object.assign(new Error('boom'), { code: 'studio_render_failed' }); } });
  const failed = await broken.finished((await broken.pipeline.start(broken.user, { templateId: 'photo-reel', presetPlan: reel, photos })).id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'scenes_failed');
  assert.deepEqual(broken.billing.events, ['consume', 'record', 'refund']);
});

test('pipeline: a failed scene fails the job, names the scene and refunds', async () => {
  const dir = tempDir();
  const fx = await pipelineFixture({
    runner: async (scene) => {
      if (scene.n === 7) throw Object.assign(new Error('content rejected'), { code: 'policy' });
      const file = path.join(dir, `scene-${scene.n}.mp4`);
      fs.writeFileSync(file, 'clip');
      return { path: file };
    },
  });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм с одной плохой сценой' }, scenes: 30 });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'scenes_failed');
  assert.match(done.error.message, /: 7\./);
  assert.equal(fx.assembled.length, 0);
  assert.deepEqual(fx.billing.events, ['consume', 'record', 'refund']);
  const failedShot = (await fx.db.listFilmShots(job.id)).find((shot) => shot.sceneNumber === 7);
  assert.equal(failedShot.error.code, 'policy');
});

test('pipeline: SkyPilot run leases a cluster and always tears it down', async () => {
  const sky = fakeSky();
  const fx = await pipelineFixture({ sky });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм на арендованном кластере' }, scenes: 24 });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.infra.provider, 'skypilot');
  assert.equal(sky.calls.run[0].accelerator, 'L4:1');
  assert.equal(sky.calls.run[0].env.FILM_RENDER_ENDPOINT, 'https://render.example.com');
  assert.deepEqual(sky.calls.teardown, [sky.calls.run[0].clusterName]);
  const leases = await fx.db.listInfraLeases(job.id);
  assert.equal(leases[0].status, 'torn_down');
  assert.equal((await fx.db.listOpenInfraLeases()).length, 0);
  // Photos cannot be shipped to a cluster.
  await assert.rejects(() => fx.pipeline.start(fx.user, { brief: { brief: 'Фильм по фото на кластере' }, photos: ['data:image/jpeg;base64,AAA'] }), (error) => error.code === 'photos_need_local_render');

  // Teardown also happens when rendering throws.
  const failing = fakeSky({ runFilm: async () => { throw Object.assign(new Error('spot preempted'), { code: 'sky_no_result' }); } });
  const fx2 = await pipelineFixture({ sky: failing });
  const job2 = await fx2.pipeline.start(fx2.user, { brief: { brief: 'Фильм, который упадёт на кластере' }, scenes: 24 });
  const done2 = await fx2.finished(job2.id);
  assert.equal(done2.status, 'failed');
  assert.equal(failing.calls.teardown.length, 1);
  assert.deepEqual(fx2.billing.events, ['consume', 'record', 'refund']);
});

test('pipeline: no price, no launch; a failed teardown is flagged but the film is kept', async () => {
  const noOffer = fakeSky({ cheapest: async () => ({ offer: null, reason: 'unparsable_pricing' }) });
  const fx = await pipelineFixture({ sky: noOffer });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм без известной цены GPU' }, scenes: 24 });
  const done = await fx.finished(job.id);
  assert.equal(done.error.code, 'no_gpu_offer');
  assert.equal(noOffer.calls.run.length, 0);
  assert.equal(noOffer.calls.teardown.length, 0);

  const leaky = fakeSky({ teardown: async () => ({ ok: false, code: 'cli_failed' }) });
  const fx2 = await pipelineFixture({ sky: leaky });
  const job2 = await fx2.pipeline.start(fx2.user, { brief: { brief: 'Фильм с неудалённым кластером' }, scenes: 24 });
  const done2 = await fx2.finished(job2.id);
  assert.equal(done2.status, 'needs_attention');
  assert.match(done2.error.message, /sky down rezhisser-/);
  assert.equal((await fx2.db.listInfraLeases(job2.id))[0].status, 'leak_suspected');
  // The finished film is still downloadable, and it was not refunded.
  assert.ok(fx2.pipeline.publicJob(done2).video);
  assert.deepEqual(fx2.billing.events, ['consume', 'record']);
});

test('pipeline: Ray clips are downloaded by URL; a path-only result is rejected', async () => {
  const ray = { run: async (payload) => ({ shots: payload.shots.map((shot) => (shot.n === 2 ? { scene: 2, ok: true, path: '/remote/2.mp4' } : { scene: shot.n, ok: true, url: `https://cdn.example.com/${shot.n}.mp4` })), failures: [] }) };
  const fx = await pipelineFixture({ ray });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм на готовом Ray-кластере' }, scenes: 24 });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error.message, /: 2\./);
  const shots = await fx.db.listFilmShots(job.id);
  assert.equal(shots.find((shot) => shot.sceneNumber === 2).error.code, 'clip_not_reachable');
  assert.ok(fs.existsSync(shots.find((shot) => shot.sceneNumber === 1).localPath));
});

test('pipeline: upscaled clips replace the originals; a partial upscale is labelled', async () => {
  const upscaler = {
    upscaleAll: async (clips) => ({
      results: clips.filter((clip) => clip.scene !== 3).map((clip) => ({ shotId: clip.shotId, path: `${clip.path}.up` })),
      failures: [{ shotId: clips.find((clip) => clip.scene === 3).shotId, code: 'upscale_failed' }],
    }),
  };
  const fx = await pipelineFixture({ upscaler });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм с апскейлом клипов' }, scenes: 24 });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.infra.upscaler, 'recavsr-partial');
  const clips = fx.assembled[0].clips;
  assert.ok(clips.find((clip) => clip.scene === 1).path.endsWith('.up'));
  assert.ok(!clips.find((clip) => clip.scene === 3).path.endsWith('.up'));
});

test('pipeline: cancel stops the job, refunds it; recover fails interrupted jobs and frees clusters', async () => {
  const fx = await pipelineFixture({
    runner: (scene, context) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'canceled' })));
    }),
  });
  const job = await fx.pipeline.start(fx.user, { brief: { brief: 'Фильм, который отменят' }, scenes: 24 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(() => fx.pipeline.cancel(job.id, 'someone-else'), (error) => error.code === 'film_job_not_found');
  const canceled = await fx.pipeline.cancel(job.id, fx.user.id);
  assert.equal(canceled.status, 'canceled');
  assert.deepEqual(fx.billing.events, ['consume', 'record', 'refund']);
  await assert.rejects(() => fx.pipeline.cancel(job.id, fx.user.id), (error) => error.code === 'job_finished');

  // A job left active by a previous process, with an open lease.
  const sky = fakeSky();
  const fx2 = await pipelineFixture({ sky });
  const stale = await fx2.db.createFilmJob({ id: '22222222-2222-4222-8222-222222222222', userId: fx2.user.id, status: 'rendering', options: { billingSource: 'credits' } });
  await fx2.db.createInfraLease({ id: '33333333-3333-4333-8333-333333333333', jobId: stale.id, provider: 'skypilot', clusterName: 'rezhisser-stale-1', status: 'running' });
  const report = await fx2.pipeline.recover();
  assert.deepEqual(report, { interrupted: 1, tornDown: 1, leaked: [] });
  assert.equal((await fx2.db.getFilmJob(stale.id)).error.code, 'interrupted');
  assert.deepEqual(sky.calls.teardown, ['rezhisser-stale-1']);
  assert.deepEqual(fx2.billing.events, ['refund']);
});

test('pipeline: input is validated before anything is charged', async () => {
  const fx = await pipelineFixture();
  await assert.rejects(() => fx.pipeline.start(fx.user, { brief: { brief: 'коротко' } }), (error) => error.code === 'brief_required');
  await assert.rejects(() => fx.pipeline.start(fx.user, { brief: { brief: 'Нормальное описание фильма' }, scenes: 12 }), (error) => error.code === 'invalid_scene_count');
  assert.deepEqual(fx.billing.events, []);

  const off = createFilmPipeline({ config: { ...filmConfig({}), filmEnabled: false }, db: fx.db, logger: quiet });
  await assert.rejects(() => off.start(fx.user, { brief: { brief: 'Нормальное описание фильма' } }), (error) => error.code === 'film_disabled');
  const noRender = createFilmPipeline({ config: { ...filmConfig({}), filmEnabled: true }, db: fx.db, planner: { model: 'm' }, logger: quiet });
  await assert.rejects(() => noRender.start(fx.user, { brief: { brief: 'Нормальное описание фильма' } }), (error) => error.code === 'render_not_configured' && error.status === 503);
});

test('pipeline: music and voiceover reach the assembler; expired films are cleaned up', async () => {
  let clock = Date.now();
  const fx = await pipelineFixture({ now: () => clock });
  const job = await fx.pipeline.start(fx.user, {
    brief: { brief: 'Фильм с музыкой и озвучкой' },
    scenes: 24,
    audio: { source: 'library', title: 'Calm', path: '/music/calm.mp3' },
    voice: { source: 'library', title: 'Voice', path: '/music/voice.wav' },
  });
  const done = await fx.finished(job.id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(fx.assembled[0].music, { path: '/music/calm.mp3' });
  assert.deepEqual(fx.assembled[0].voice, { path: '/music/voice.wav' });
  const view = fx.pipeline.publicJob(done);
  assert.deepEqual(view.audio, { music: { source: 'library', title: 'Calm' }, voice: { source: 'library', title: 'Voice' } });
  assert.doesNotMatch(JSON.stringify(view), /calm\.mp3|voice\.wav/);

  // Retention: nothing is removed early; after the period the files are gone.
  assert.equal(await fx.pipeline.cleanup(), 0);
  clock += 31 * 24 * 60 * 60 * 1000;
  assert.equal(await fx.pipeline.cleanup(), 1);
  const cleaned = await fx.db.getFilmJob(job.id);
  assert.equal(cleaned.outputUrl, null);
  assert.equal(fx.pipeline.publicJob(cleaned).video, null);
  assert.equal(fs.existsSync(path.join(fx.workDir, job.id)), false);
  assert.equal(await fx.pipeline.cleanup(), 0);
});

test('load: an account has a cap on films in progress; studio renders share one queue', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fx = await pipelineFixture({ runner: async (scene, context) => {
    await gate;
    const file = path.join(fx.workDir, context.jobId, `s-${scene.n}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'clip');
    return { path: file };
  } });
  const input = () => ({ brief: { brief: 'Фильм для проверки очереди' }, scenes: 24 });
  const first = await fx.pipeline.start(fx.user, input());
  const second = await fx.pipeline.start(fx.user, input());
  // The third is refused before anything is charged.
  await assert.rejects(() => fx.pipeline.start(fx.user, input()), (error) => error.code === 'too_many_active' && error.status === 429);
  assert.deepEqual(fx.billing.events, ['consume', 'record', 'consume', 'record']);
  release();
  assert.equal((await fx.finished(first.id)).status, 'succeeded');
  assert.equal((await fx.finished(second.id)).status, 'succeeded');
  assert.equal((await fx.finished((await fx.pipeline.start(fx.user, input())).id)).status, 'succeeded');

  // limited(): never more than `max` at once, every call completes, errors pass through.
  let active = 0;
  let peak = 0;
  const work = limited(async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (value === 3) throw new Error('three');
    return value * 2;
  }, 2);
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((value) => work(value)));
  assert.equal(peak, 2);
  assert.deepEqual(results.map((item) => (item.status === 'fulfilled' ? item.value : item.reason.message)), [2, 4, 'three', 8, 10, 12]);
});

// ---- configuration ----

test('config: paid engines are off by default; the built-in ones are always there', () => {
  const config = filmConfig({});
  assert.equal(config.filmEnabled, false);
  assert.equal(config.skypilot.dryRun, true);
  assert.equal(config.skypilot.maxHourlyUsd, 0);
  assert.equal(config.filmBaseResolution, '480p');
  assert.equal(config.filmStudioFree, false);
  assert.equal(config.filmRembgModel, 'u2netp');
  assert.equal(filmConfig({ FILM_BASE_RESOLUTION: '8k' }).filmBaseResolution, '480p');

  const db = createMemoryDatabase({ dataDir: tempDir() });
  const stack = createFilmStack({ ...config, filmEnabled: true, filmWorkDir: tempDir(), filmCacheDir: tempDir() }, { db, logger: quiet, runners: { env: NO_PATH } });
  const caps = stack.capabilities();
  // Planning and the studio need nothing; the upgrades name their variables.
  assert.deepEqual([caps.planner.engine, caps.planner.configured, caps.planner.missing], ['storyboard', true, []]);
  assert.deepEqual(caps.planner.upgrade, ['SGLANG_BASE_URL', 'SGLANG_MODEL']);
  assert.equal(caps.studio.available, true);
  assert.ok(caps.studio.backdrops.length >= 5);
  assert.equal(caps.render.mode, null);
  assert.deepEqual(caps.render.missing, ['SEEDANCE_API_KEY', 'RAY_DASHBOARD_URL', 'SKYPILOT_ENABLED']);
  assert.equal(caps.upscaler.engine, 'ffmpeg-lanczos');
  assert.equal(caps.inpaint.configured, true);
  assert.deepEqual(caps.inpaint.builtIn.modes, ['background', 'insert', 'erase']);
  assert.deepEqual(caps.inpaint.generative.missing, ['INPAINT_BASE_URL', 'INPAINT_MODEL']);
  assert.deepEqual(caps.photos.missing, ['FILM_REMOVE_BG_COMMAND']);
  // Only variable names are reported.
  assert.doesNotMatch(JSON.stringify(caps), /https?:\/\//);
});

// ---- HTTP ----

function filmServerOptions(services, { film = {}, runners } = {}) {
  const dir = tempDir();
  return productionOptions(services, {
    film: { ...filmConfig({}), filmEnabled: true, filmWorkDir: path.join(dir, 'film'), filmCacheDir: path.join(dir, 'cache'), ...film },
    filmRunners: runners,
  });
}

test('http: /api/film does not exist unless FILM_ENABLED is on; /film is served with the strict CSP', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    assert.equal((await fetch(`${base}/api/film/capabilities`)).status, 404);
    const page = await fetch(`${base}/film`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${base}/assets/film.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/film.css`)).status, 200);
  });
});

test('http: a template reel end to end — account, quota, render, download', async () => {
  const services = fakeServices();
  const assemble = async (bin, args) => {
    // ffprobe answers "no audio"/a duration; ffmpeg writes the output file.
    if (bin === 'ffprobe') return { ok: true, stdout: args.includes('format=duration') ? '5.0\n' : '' };
    fs.writeFileSync(args[args.length - 1], 'final-mp4-bytes');
    return { ok: true };
  };
  await withServer(filmServerOptions(services, { runners: { process: assemble } }), async ({ base, app }) => {
    const anonymous = accountClient(base);
    assert.equal((await anonymous.get('/api/film/capabilities')).json.render.mode, 'local');
    assert.equal((await anonymous.get('/api/film/templates')).json.templates.length >= 5, true);
    assert.equal((await anonymous.get('/api/film/jobs')).status, 401);
    const preview = await anonymous.post('/api/film/presets', { templateId: 'reels-food', metadata: { niche: 'кофейня', subject: 'капучино', location: 'стойка', style: 'тёплый' } });
    assert.equal(preview.json.preset.plan.scenes.length, 3);

    const api = accountClient(base);
    const userId = (await api.register('film@example.com')).json.user.id;
    const body = { templateId: 'reels-food', metadata: { niche: 'кофейня', subject: 'капучино', location: 'стойка', style: 'тёплый' } };
    // The Free tier has no generations.
    assert.equal((await api.post('/api/film/jobs', body)).status, 402);
    await app.db.addCredits(userId, 1);

    const created = await api.post('/api/film/jobs', body);
    assert.equal(created.status, 201);
    const id = created.json.job.id;
    let job;
    for (let i = 0; i < 400; i += 1) {
      job = (await api.get(`/api/film/jobs/${id}`)).json.job;
      if (!['queued', 'planning', 'rendering', 'upscaling', 'assembling'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.engine, 'template');
    assert.equal(job.shots.length, 3);
    assert.equal((await app.db.getUserById(userId)).credits, 0);

    // Each scene was submitted at the cheap base resolution, vertical, 5 s.
    const submits = services.calls.filter((call) => call.method === 'POST' && call.url.includes('/contents/generations/tasks')).map((call) => JSON.parse(call.body));
    assert.equal(submits.length, 3);
    assert.ok(submits.every((request) => request.resolution === '480p' && request.ratio === '9:16' && request.duration === 5));
    assert.match(submits[0].content[0].text, /camera movement: slow pan left/);

    // The film was uploaded; the buyer gets a signed link and the route redirects.
    assert.match(job.video.url, /^https:\/\/s3\.test\/rezhisser-videos\/films\//);
    const download = await fetch(`${base}${job.video.download}`, { headers: { Authorization: `Bearer ${api.state.token}` }, redirect: 'manual' });
    assert.equal(download.status, 302);
    assert.equal((await fetch(`${base}${job.video.download}`)).status, 401);

    // Another account cannot see the job.
    const other = accountClient(base);
    await other.register('other@example.com');
    assert.equal((await other.get(`/api/film/jobs/${id}`)).status, 404);
    assert.equal((await other.get('/api/film/jobs')).json.jobs.length, 0);
  });
});

test('http: without object storage the film is streamed to its owner only', async () => {
  const services = fakeServices();
  const assemble = async (bin, args) => {
    if (bin === 'ffprobe') return { ok: true, stdout: args.includes('format=duration') ? '5.0\n' : '' };
    fs.writeFileSync(args[args.length - 1], 'final-mp4-bytes');
    return { ok: true };
  };
  const options = filmServerOptions(services, { runners: { process: assemble } });
  options.s3 = { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' };
  await withServer(options, async ({ base, app }) => {
    const api = accountClient(base);
    await app.db.addCredits((await api.register('local@example.com')).json.user.id, 1);
    const created = await api.post('/api/film/jobs', { templateId: 'reels-auto', metadata: { niche: 'автосалон', subject: 'седан', location: 'шоурум', style: 'строгий' } });
    let job;
    for (let i = 0; i < 400; i += 1) {
      job = (await api.get(`/api/film/jobs/${created.json.job.id}`)).json.job;
      if (job.status === 'succeeded' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.video.url, null);
    const file = await fetch(`${base}${job.video.download}`, { headers: { Authorization: `Bearer ${api.state.token}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    assert.equal(await file.text(), 'final-mp4-bytes');
  });
});

test('http: validation errors are specific; nothing is charged for a rejected request', async () => {
  await withServer(filmServerOptions(fakeServices()), async ({ base, app }) => {
    const api = accountClient(base);
    const userId = (await api.register('errors@example.com')).json.user.id;
    await app.db.addCredits(userId, 2);

    const noStyle = await api.post('/api/film/jobs', { templateId: 'reels-food', metadata: { niche: 'кафе', subject: 'кофе', location: 'зал' } });
    assert.deepEqual([noStyle.status, noStyle.json.error, noStyle.json.field], [400, 'metadata_required', 'style']);
    const short = await api.post('/api/film/jobs', { brief: 'кофе', scenes: 30 });
    assert.deepEqual([short.status, short.json.error], [400, 'brief_required']);
    const reel = await api.post('/api/film/jobs', { photoReel: true });
    assert.deepEqual([reel.status, reel.json.error, reel.json.field], [400, 'photos_required', 'photoIds']);
    assert.equal((await api.post('/api/film/jobs', { templateId: 'reels-food', metadata: { niche: 'кафе', subject: 'кофе', location: 'зал', style: 'тёплый' }, audio: { trackId: 'nope' } })).json.error, 'unknown_track');
    assert.equal((await api.post('/api/film/jobs', { templateId: 'reels-food', metadata: { niche: 'кафе', subject: 'кофе', location: 'зал', style: 'тёплый' }, photoIds: ['../../x'] })).json.error, 'unknown_photo');
    assert.equal((await api.post('/api/film/audio/link', { url: 'https://evil.example/x' })).json.error, 'host_not_allowed');
    // Generative modes need the external service; the built-in ones need an area.
    const generative = await api.post('/api/film/inpaint', { image: PNG_1PX, mask: PNG_1PX, prompt: 'x', mode: 'replace' });
    assert.deepEqual([generative.status, generative.json.error], [503, 'inpaint_not_configured']);
    assert.equal((await api.post('/api/film/inpaint', { image: PNG_1PX, mode: 'insert' })).json.error, 'mask_required');
    assert.equal((await api.post('/api/film/inpaint', { image: PNG_1PX, mode: 'paint' })).json.error, 'invalid_mode');
    assert.equal((await api.post('/api/film/photos/prepare', { photos: [] })).status, 400);
    assert.equal((await api.get('/api/film/jobs/not-a-uuid')).status, 404);
    assert.equal((await api.get('/api/film/unknown')).status, 404);
    assert.equal((await app.db.getUserById(userId)).credits, 2);
  });
});

test('http (real ffmpeg): photos in, finished vertical reel out — no video model, no language model, no storage', { skip: !HAS_FFMPEG, timeout: 180000 }, async () => {
  const dir = tempDir();
  const options = filmServerOptions(fakeServices(), { film: { filmTargetResolution: '1080p', filmStudioFree: true, photoSteps: { removeBg: 'off', enhance: '' } } });
  options.seedance = { apiKey: '' };
  options.s3 = { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' };
  await withServer(options, async ({ base, app }) => {
    const api = accountClient(base);
    const userId = (await api.register('studio@example.com')).json.user.id;
    const caps = (await api.get('/api/film/capabilities')).json;
    assert.equal(caps.render.mode, null);
    assert.equal(caps.studio.free, true);

    const prepared = await api.post('/api/film/photos/prepare', { photos: [asDataUrl(productPhoto(path.join(dir, 'a.jpg'))), asDataUrl(productPhoto(path.join(dir, 'b.jpg'), '480x640'))] });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.json));
    assert.equal(prepared.json.photos.length, 2);

    // A Free account with no credits: a studio reel is not charged.
    const created = await api.post('/api/film/jobs', { photoReel: true, photoIds: prepared.json.photos.map((photo) => photo.id), secondsPerPhoto: 2, captions: 'Новая коллекция\nУже в продаже' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    let job;
    for (let i = 0; i < 1500; i += 1) {
      job = (await api.get(`/api/film/jobs/${created.json.job.id}`)).json.job;
      if (!['queued', 'planning', 'rendering', 'upscaling', 'assembling'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.deepEqual([job.engine, job.infra.provider, job.infra.upscaler, job.infra.subtitleCues], ['photo-reel', 'studio', 'native', 2]);
    assert.equal((await app.db.getUserById(userId)).credits, 0);

    const response = await fetch(`${base}${job.video.download}`, { headers: { Authorization: `Bearer ${api.state.token}` } });
    assert.equal(response.status, 200);
    const file = path.join(dir, 'reel.mp4');
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const video = probeVideo(file);
    assert.deepEqual([video.codec_name, video.width, video.height, video.nb_read_frames], ['h264', 1080, 1920, '96']);
  });
});

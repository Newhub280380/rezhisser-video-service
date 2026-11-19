'use strict';

// Parallel scene rendering: an existing Ray cluster or a local pool.
//
// Ray mode submits one job per film through the Ray Jobs REST API. The driver
// (python/rezhisser_film/film_job.py) prints `FILM_PROGRESS {json}` lines and a
// final `FILM_RESULT {json}` line; this module reads them from the job logs.
//
// Local mode runs the per-scene worker it is given with bounded concurrency.
// It has no renderer of its own: without one, every scene fails loudly instead
// of producing a placeholder clip.

const zlib = require('node:zlib');
const { requestJson, assertHttpsBase } = require('../http-client.js');

// Linux limits one argument to 128 KiB, and the entrypoint is a single one.
const MAX_ENTRYPOINT_PAYLOAD = 100000;

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'STOPPED']);
const FAILED = new Set(['FAILED', 'STOPPED']);

class RayError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RayError';
    this.code = code;
    if (status) this.status = status;
  }
}

function markerPayload(line, marker) {
  // Log collectors prefix lines (for example "(task, pid=42) "), so the marker
  // is searched for inside the line, not only at its start.
  const at = line.indexOf(marker);
  if (at === -1) return undefined;
  try {
    return JSON.parse(line.slice(at + marker.length).trim());
  } catch {
    return undefined;
  }
}

function parseMarkers(logs) {
  const progress = [];
  let result = null;
  for (const line of String(logs || '').split(/\r?\n/)) {
    const step = markerPayload(line, 'FILM_PROGRESS ');
    if (step !== undefined) progress.push(step);
    const final = markerPayload(line, 'FILM_RESULT ');
    if (final !== undefined) result = final;
  }
  return { progress, result };
}

function createRayCluster({
  apiUrl = '',
  token = '',
  entrypoint = 'python film_job.py',
  workingDir = '',
  renderEndpoint = '',
  requestTimeoutMs = 30000,
  pollIntervalMs = 3000,
  maxRuntimeSeconds = 3600,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
} = {}) {
  if (!apiUrl) return null;
  const base = assertHttpsBase(apiUrl, 'RAY_DASHBOARD_URL');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = ['Bearer', token].join(' ');

  function call(method, suffix, body) {
    return requestJson(fetchImpl, `${base}/api/jobs/${suffix}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: requestTimeoutMs,
      service: 'ray',
    });
  }

  async function submit(payload) {
    // The entrypoint runs through a shell on the head node. gzip + base64 keeps
    // prompt text (quotes, `$`, backticks) out of that shell and keeps it short.
    const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
    if (encoded.length > MAX_ENTRYPOINT_PAYLOAD) throw new RayError('payload_too_large', 'План фильма слишком велик для запуска на Ray.');
    const body = {
      entrypoint: `${entrypoint} --payload-gz64 ${encoded}`,
      metadata: { film_job_id: String(payload.jobId || '') },
    };
    // The REST API does not upload local folders: this must be a URI the
    // cluster can fetch. Empty means the driver is already on the cluster.
    const runtimeEnv = {};
    if (workingDir) runtimeEnv.working_dir = workingDir;
    if (renderEndpoint) runtimeEnv.env_vars = { FILM_RENDER_ENDPOINT: renderEndpoint };
    if (Object.keys(runtimeEnv).length) body.runtime_env = runtimeEnv;
    const res = await call('POST', '', body);
    if (!res.ok || !res.json || typeof res.json.job_id !== 'string') {
      throw new RayError('ray_submit_failed', `Ray rejected the job (HTTP ${res.status}).`, res.status);
    }
    return res.json.job_id;
  }

  async function status(submissionId) {
    const res = await call('GET', encodeURIComponent(submissionId));
    if (!res.ok || !res.json) throw new RayError('ray_status_failed', `Ray status failed (HTTP ${res.status}).`, res.status);
    return {
      status: String(res.json.status || 'PENDING').toUpperCase(),
      message: typeof res.json.message === 'string' ? res.json.message : '',
    };
  }

  // The endpoint answers {"logs": "..."}.
  async function logs(submissionId) {
    const res = await call('GET', `${encodeURIComponent(submissionId)}/logs`).catch(() => null);
    if (!res || !res.ok || !res.json) return '';
    return typeof res.json.logs === 'string' ? res.json.logs : '';
  }

  async function stop(submissionId) {
    await call('POST', `${encodeURIComponent(submissionId)}/stop`, {}).catch((error) => {
      logger.error(`ray stop failed: ${error.code || 'error'}`);
    });
  }

  // Runs the whole film job and returns { shots, failures }.
  async function run(payload, { onProgress = () => {}, signal = null } = {}) {
    const submissionId = await submit(payload);
    const startedAt = now();
    for (;;) {
      if (signal && signal.aborted) {
        await stop(submissionId);
        throw new RayError('canceled', 'Задача отменена.');
      }
      if (now() - startedAt > maxRuntimeSeconds * 1000) {
        await stop(submissionId);
        throw new RayError('ray_timeout', 'Рендеринг занял больше допустимого времени.');
      }
      const state = await status(submissionId);
      const markers = parseMarkers(await logs(submissionId));
      if (markers.progress.length) onProgress(markers.progress[markers.progress.length - 1]);
      if (TERMINAL.has(state.status)) {
        // A result line is trusted even when the driver exit code was not zero:
        // it lists exactly which scenes rendered and which did not.
        if (markers.result) return { ...markers.result, submissionId };
        if (FAILED.has(state.status)) {
          throw new RayError('ray_job_failed', `Ray job ${state.status}: ${state.message || 'no message'}`.slice(0, 300));
        }
        throw new RayError('ray_no_result', 'Ray job finished without a FILM_RESULT line.');
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return { mode: 'ray-jobs', remote: true, base, submit, status, logs, stop, run };
}

// Same contract as the cluster, on this machine. `runner(scene, context)` must
// return { path } and/or { url } for the rendered clip.
function createLocalPool({ concurrency = 4, logger = console, runner = null } = {}) {
  async function run(payload, { onProgress = () => {}, signal = null } = {}) {
    const scenes = Array.isArray(payload.shots) ? payload.shots : [];
    const shots = [];
    const failures = [];
    let next = 0;
    let done = 0;
    async function worker() {
      for (;;) {
        if (signal && signal.aborted) return;
        const scene = scenes[next];
        next += 1;
        if (!scene) return;
        try {
          if (!runner) {
            throw new RayError('render_not_configured', 'Рендер не настроен: нет видеодвижка для сцен.');
          }
          const out = await runner(scene, { ...payload, signal });
          shots.push({ shotId: scene.shotId, scene: scene.n, ok: true, ...out });
        } catch (error) {
          failures.push({
            shotId: scene.shotId,
            scene: scene.n,
            code: error.code || 'render_failed',
            message: String(error.message || '').slice(0, 200),
          });
          logger.error(`local render scene ${scene.n} failed: ${error.code || 'error'}`);
        }
        done += 1;
        onProgress({ done, total: scenes.length });
      }
    }
    const width = Math.max(1, Math.min(concurrency, scenes.length || 1));
    await Promise.all(Array.from({ length: width }, worker));
    if (signal && signal.aborted) throw new RayError('canceled', 'Задача отменена.');
    return { shots, failures };
  }

  return { mode: 'local', remote: false, concurrency, run };
}

module.exports = { createRayCluster, createLocalPool, parseMarkers, RayError };

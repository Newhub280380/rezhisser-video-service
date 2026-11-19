'use strict';

// SkyPilot infrastructure manager.
//
// Finds the cheapest GPU offer under a price ceiling, runs the film driver on a
// rented cluster and destroys the cluster afterwards.
//
// Teardown is layered, because a leaked GPU is a leaked invoice:
//   1. `sky launch --down` — SkyPilot tears the cluster down when the task ends
//      (per its docs, NOT when provisioning or setup fails);
//   2. an explicit `sky down` from the orchestrator's `finally` block;
//   3. a row in `infra_leases`, reconciled at service start.
//
// Prices come only from the SkyPilot CLI. If its output cannot be parsed there
// is no offer and a live launch is refused — a price is never assumed.
//
// Dry-run (the default) never starts a process: it only reports the command.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseMarkers } = require('./ray.js');

const NAME = 'skypilot';
const DEFAULT_ACCELERATORS = ['L4:1', 'A10G:1', 'L40S:1', 'A100:1', 'RTX4090:1'];

class SkyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkyError';
    this.code = code;
  }
}

// Fixed argv, no shell. Everything that reaches the CLI matches these.
const CLUSTER_PATTERN = /^[a-z0-9][a-z0-9-]{2,48}$/;
const ACCELERATOR_PATTERN = /^[A-Za-z0-9._-]{1,32}:\d{1,2}$/;
const CLOUD_PATTERN = /^[a-z0-9-]{2,24}$/i;
const REGION_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,48}$/;

function runCli(bin, args, { timeoutMs = 120000, env = {}, onLine = null, signal = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    } catch (error) {
      resolve({ ok: false, code: 'cli_missing', stdout: '', stderr: String(error.message || ''), status: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs);
    if (signal) signal.addEventListener('abort', kill, { once: true });
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', kill);
      resolve(payload);
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      // Keep the tail: the result marker is the last thing a task prints.
      stdout = (stdout + text).slice(-512 * 1024);
      if (!onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.on('error', () => done({ ok: false, code: 'cli_missing', stdout, stderr, status: null }));
    child.on('close', (status) => {
      if (onLine && pending) onLine(pending);
      done({ ok: status === 0, code: status === 0 ? 'ok' : 'cli_failed', stdout, stderr, status });
    });
  });
}

// Tolerant reader for the CLI's JSON price listing. It accepts several nesting
// shapes and returns [{accelerator, cloud, region, hourlyUsd, spot}]. Rows
// without a positive numeric price are dropped.
function parseGpuPricing(json) {
  const rows = [];
  const push = (accelerator, cloud, region, price, spot) => {
    const value = Number(price);
    if (!accelerator || !Number.isFinite(value) || value <= 0) return;
    rows.push({ accelerator: String(accelerator), cloud: cloud || null, region: region || null, hourlyUsd: value, spot: Boolean(spot) });
  };
  const walk = (node, cloud, region) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, cloud, region);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const nextCloud = node.cloud || node.cloud_name || cloud;
    const nextRegion = node.region || region;
    const name = node.accelerator_name || node.accelerator;
    if (typeof name === 'string') {
      if (node.price !== undefined) push(name, nextCloud, nextRegion, node.price, false);
      if (node.hourly_usd !== undefined) push(name, nextCloud, nextRegion, node.hourly_usd, false);
      if (node.spot_price !== undefined) push(name, nextCloud, nextRegion, node.spot_price, true);
    }
    if (Array.isArray(node.accelerators)) {
      for (const item of node.accelerators) {
        if (!item || typeof item !== 'object') continue;
        const itemName = item.accelerator_name || item.name;
        const prices = item.price_per_hour || item.prices;
        if (prices && typeof prices === 'object') {
          for (const [kind, price] of Object.entries(prices)) push(itemName, nextCloud, nextRegion, price, /spot|preempt/i.test(kind));
        } else if (item.price !== undefined) {
          push(itemName, nextCloud, nextRegion, item.price, false);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'accelerators' && value && typeof value === 'object') walk(value, nextCloud, nextRegion);
    }
  };
  walk(json, null, null);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.accelerator}|${row.cloud}|${row.region}|${row.hourlyUsd}|${row.spot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createSkyPilot({
  bin = 'sky',
  enabled = false,
  dryRun = true,
  useSpot = true,
  taskYaml = 'python/rezhisser_film/sky_task.yaml',
  accelerators = DEFAULT_ACCELERATORS,
  clouds = [],
  maxHourlyUsd = 0,
  maxRuntimeSeconds = 3600,
  teardownRetries = 3,
  retryDelayMs = 2000,
  cli = runCli,
  logger = console,
} = {}) {
  const allowedAccelerators = accelerators.filter((item) => ACCELERATOR_PATTERN.test(item));
  const allowedClouds = clouds.filter((item) => CLOUD_PATTERN.test(item)).map((item) => item.toLowerCase());

  async function showGpus() {
    if (dryRun) return { ok: false, code: 'dry_run', rows: [] };
    // Current CLI first, then the name older releases used.
    for (const args of [['gpus', 'list', '--all', '-o', 'json'], ['show-gpus', '--all', '-o', 'json']]) {
      const res = await cli(bin, args, { timeoutMs: 90000 });
      if (!res.ok) {
        logger.error(`sky ${args[0]} failed: ${res.code}`);
        continue;
      }
      try {
        return { ok: true, rows: parseGpuPricing(JSON.parse(res.stdout)) };
      } catch {
        return { ok: false, code: 'unparsable_pricing', rows: [] };
      }
    }
    return { ok: false, code: 'pricing_unavailable', rows: [] };
  }

  // Cheapest offer among the allowed accelerators and clouds, under the ceiling.
  async function cheapest() {
    const listing = await showGpus();
    if (!listing.ok) return { offer: null, reason: listing.code };
    const wanted = allowedAccelerators.map((item) => ({ name: item.split(':')[0].toUpperCase(), spec: item }));
    const candidates = [];
    for (const row of listing.rows) {
      if (useSpot !== row.spot) continue;
      const match = wanted.find((item) => row.accelerator.toUpperCase() === item.name);
      if (!match) continue;
      if (allowedClouds.length && !allowedClouds.includes(String(row.cloud || '').toLowerCase())) continue;
      if (maxHourlyUsd > 0 && row.hourlyUsd > maxHourlyUsd) continue;
      // `spec` (name:count) is what `--gpus` takes.
      candidates.push({ ...row, spec: match.spec });
    }
    candidates.sort((a, b) => a.hourlyUsd - b.hourlyUsd);
    if (!candidates.length) return { offer: null, reason: 'no_offer_under_ceiling' };
    return { offer: candidates[0], reason: null };
  }

  function launchArgs({ clusterName, accelerator, cloud = null, region = null, workdir = null, env = {} }) {
    if (!CLUSTER_PATTERN.test(String(clusterName))) throw new SkyError('invalid_cluster', 'Недопустимое имя кластера.');
    if (!ACCELERATOR_PATTERN.test(String(accelerator))) throw new SkyError('invalid_accelerator', 'Недопустимый ускоритель.');
    const args = [
      'launch', path.resolve(taskYaml),
      '--cluster', clusterName,
      '--gpus', accelerator,
      useSpot ? '--use-spot' : '--no-use-spot',
      // Destroy the cluster when the task ends; never ask for confirmation.
      '--down',
      '-y',
    ];
    if (workdir) args.push('--workdir', workdir);
    if (cloud) {
      if (!CLOUD_PATTERN.test(cloud)) throw new SkyError('invalid_cloud', 'Недопустимое облако.');
      if (region && !REGION_PATTERN.test(region)) throw new SkyError('invalid_region', 'Недопустимый регион.');
      args.push('--infra', region ? `${cloud}/${region}` : cloud);
    }
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY_PATTERN.test(key)) throw new SkyError('invalid_env', 'Недопустимое имя переменной окружения.');
      args.push('--env', `${key}=${value}`);
    }
    return args;
  }

  // Runs the film driver on a rented cluster and returns its FILM_RESULT.
  // Blocks until the task ends: `sky launch` streams the task log to stdout.
  async function runFilm({ clusterName, accelerator, cloud, region, payload, workDir, driverPath, env = {}, onProgress = () => {}, signal = null }) {
    if (dryRun) throw new SkyError('sky_dry_run', 'SKYPILOT_DRY_RUN=true: кластер не запускается.');
    if (!(maxHourlyUsd > 0)) {
      throw new SkyError('ceiling_required', 'Задайте SKYPILOT_MAX_HOURLY_USD: без потолка цены аренда GPU не запускается.');
    }
    const args = launchArgs({ clusterName, accelerator, cloud, region, workdir: workDir, env });
    // The payload travels as a file in the synced workdir, never on a command line.
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(driverPath, path.join(workDir, 'film_job.py'));
    fs.writeFileSync(path.join(workDir, 'film_payload.json'), JSON.stringify(payload));
    let result = null;
    const res = await cli(bin, args, {
      timeoutMs: maxRuntimeSeconds * 1000 + 120000,
      signal,
      onLine(line) {
        const markers = parseMarkers(line);
        if (markers.progress.length) onProgress(markers.progress[markers.progress.length - 1]);
        if (markers.result) result = markers.result;
      },
    });
    if (signal && signal.aborted) throw new SkyError('canceled', 'Задача отменена.');
    if (!result) result = parseMarkers(res.stdout).result;
    if (!result) {
      const tail = String(res.stderr || '').slice(-300);
      throw new SkyError('sky_no_result', `sky launch завершился без результата (${res.status === null ? res.code : res.status}). ${tail}`.trim());
    }
    return result;
  }

  async function down(clusterName) {
    if (!CLUSTER_PATTERN.test(String(clusterName))) throw new SkyError('invalid_cluster', 'Недопустимое имя кластера.');
    if (dryRun) return { ok: true, dryRun: true };
    let last = null;
    for (let attempt = 1; attempt <= teardownRetries; attempt += 1) {
      const res = await cli(bin, ['down', '--yes', clusterName], { timeoutMs: 180000 });
      if (res.ok) return { ok: true, attempts: attempt };
      last = res;
      // A cluster that is already gone (or never came up) is a finished teardown.
      if (/not found|does not exist|no cluster/i.test(`${res.stderr}${res.stdout}`)) return { ok: true, attempts: attempt, missing: true };
      logger.error(`sky down ${clusterName} attempt ${attempt} failed: ${res.code}`);
      if (attempt < teardownRetries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
    return { ok: false, code: last ? last.code : 'unknown', stderr: last ? String(last.stderr || '').slice(-300) : '' };
  }

  // Never throws: the caller records the outcome on the lease.
  async function teardown(clusterName) {
    try {
      return await down(clusterName);
    } catch (error) {
      return { ok: false, code: error.code || 'teardown_failed' };
    }
  }

  return {
    name: NAME,
    enabled,
    dryRun,
    useSpot,
    maxHourlyUsd,
    allowedAccelerators,
    showGpus,
    cheapest,
    launchArgs,
    runFilm,
    down,
    teardown,
  };
}

module.exports = { createSkyPilot, parseGpuPricing, runCli, SkyError, DEFAULT_ACCELERATORS, NAME };

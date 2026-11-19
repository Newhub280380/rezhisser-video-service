'use strict';

// Local scene worker: one scene in, one clip on disk out, through the video
// provider this service already has (Seedance). Used by the local pool; a Ray
// or SkyPilot cluster renders with its own driver instead.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_CLIP_BYTES = 512 * 1024 * 1024;
// Ratios the provider accepts; anything else is rendered in the nearest one and
// padded to the exact film frame at assembly.
const PROVIDER_ASPECT = { '2.39:1': '21:9', '4:5': '3:4' };

class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

// Downloads a clip over https with a size cap. Redirects are refused.
async function downloadClip(url, targetPath, { fetchImpl = globalThis.fetch, timeoutMs = 300000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RenderError('invalid_clip_url', 'Некорректная ссылка на клип.');
  }
  if (parsed.protocol !== 'https:') throw new RenderError('invalid_clip_url', 'Ссылка на клип должна быть https.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: 'error' });
    } catch {
      throw new RenderError('clip_download_failed', 'Клип не скачался.');
    }
    if (!res.ok) throw new RenderError('clip_download_failed', `Клип не скачался (HTTP ${res.status}).`);
    const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > MAX_CLIP_BYTES) throw new RenderError('clip_too_large', 'Клип больше допустимого размера.');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body || []) {
      total += chunk.length;
      if (total > MAX_CLIP_BYTES) throw new RenderError('clip_too_large', 'Клип больше допустимого размера.');
      chunks.push(Buffer.from(chunk));
    }
    if (!total) throw new RenderError('clip_download_failed', 'Пустой файл клипа.');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, Buffer.concat(chunks, total));
    return { path: targetPath, bytes: total };
  } finally {
    clearTimeout(timer);
  }
}

function createSceneRenderer({
  provider,
  workDir,
  pollIntervalMs = 5000,
  maxWaitMs = 900000,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
} = {}) {
  if (!provider) return null;

  // Submit, poll, download. The clip is on disk before this resolves.
  async function renderScene(scene, context = {}) {
    const signal = context.signal || null;
    const target = path.join(workDir, String(context.jobId || 'local'), 'clips', `scene-${scene.n}-${crypto.randomBytes(3).toString('hex')}.mp4`);
    const release = provider.acquire ? provider.acquire() : () => {};
    try {
      const taskId = await provider.submit({
        prompt: scene.prompt,
        image: scene.image || null,
        aspect: PROVIDER_ASPECT[context.aspect] || context.aspect || '16:9',
        duration: scene.durationSeconds,
        resolution: context.resolution,
      });
      const startedAt = now();
      for (;;) {
        if (signal && signal.aborted) {
          await provider.cancel(taskId);
          throw new RenderError('canceled', 'Задача отменена.');
        }
        if (now() - startedAt > maxWaitMs) {
          await provider.cancel(taskId);
          throw new RenderError('scene_timeout', `Сцена ${scene.n} не отрендерена за отведённое время.`);
        }
        let state;
        try {
          state = await provider.get(taskId);
        } catch (error) {
          // A failed poll is retried until the time cap.
          logger.error(`scene ${scene.n} poll failed: ${error.code || 'error'}`);
          state = { status: 'processing' };
        }
        if (state.status === 'succeeded') {
          const file = await downloadClip(state.videoUrl, target, { fetchImpl });
          return { path: file.path, url: state.videoUrl };
        }
        if (state.status === 'failed') {
          const error = state.error || {};
          throw new RenderError(error.code || 'scene_failed', error.message || `Сцена ${scene.n} завершилась ошибкой.`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      release();
    }
  }

  return { renderScene };
}

module.exports = { createSceneRenderer, downloadClip, RenderError, MAX_CLIP_BYTES };

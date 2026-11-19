'use strict';

// Upscaling stage: cheap 480p clips in, target-resolution clips out.
//
// ReCaVSR is a research model with no standard API, so the integration point is
// a command the operator configures, run once per clip on the machine that
// holds the clips (the rented cluster, or this host in local mode):
//
//   RECAVSR_COMMAND = "python /opt/recavsr/infer.py --input {in} --output {out}"
//
// `{in}` and `{out}` are replaced with file paths; the command is started with a
// fixed argv and no shell. This repository does not ship ReCaVSR itself or its
// weights, and the command above is an example, not a tested invocation.
//
// Without a command the stage is skipped and the assembler scales with Lanczos.
// That is a plain resize, not super-resolution, and the job is labelled so.

const fs = require('node:fs');
const { run } = require('./compose.js');

const NAME = 'recavsr';

class UpscaleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpscaleError';
    this.code = code;
  }
}

function commandFor(template, inPath, outPath) {
  const parts = String(template).trim().split(/\s+/).map((token) => token.split('{in}').join(inPath).split('{out}').join(outPath));
  return { bin: parts[0], args: parts.slice(1) };
}

function createUpscaler({ command = '', timeoutMs = 1800000, concurrency = 1, runner = run, logger = console } = {}) {
  const template = String(command || '').trim();
  if (!template) return null;
  if (!template.includes('{in}') || !template.includes('{out}')) {
    throw new Error('RECAVSR_COMMAND must contain the {in} and {out} placeholders.');
  }

  async function upscaleOne(inPath) {
    const outPath = inPath.replace(/\.mp4$/i, '') + '.up.mp4';
    const { bin, args } = commandFor(template, inPath, outPath);
    const result = await runner(bin, args, { timeoutMs });
    if (!result.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fs.rmSync(outPath, { force: true });
      throw new UpscaleError(
        result.code === 'tool_missing' ? 'upscaler_missing' : 'upscale_failed',
        result.code === 'tool_missing' ? 'Команда апскейлера не найдена.' : 'Апскейлер завершился с ошибкой.',
      );
    }
    return outPath;
  }

  // clips: [{ shotId, path }] -> { results: [{ shotId, path }], failures: [...] }
  async function upscaleAll(clips, { onProgress = () => {}, signal = null } = {}) {
    const results = [];
    const failures = [];
    let next = 0;
    let done = 0;
    async function worker() {
      for (;;) {
        if (signal && signal.aborted) return;
        const clip = clips[next];
        next += 1;
        if (!clip) return;
        try {
          results.push({ shotId: clip.shotId, path: await upscaleOne(clip.path) });
        } catch (error) {
          failures.push({ shotId: clip.shotId, code: error.code || 'upscale_failed' });
          logger.error(`upscale ${clip.shotId} failed: ${error.code || 'error'}`);
        }
        done += 1;
        onProgress({ done, total: clips.length });
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, clips.length || 1)) }, worker));
    return { results, failures };
  }

  return { name: NAME, command: template, upscaleOne, upscaleAll };
}

module.exports = { createUpscaler, commandFor, UpscaleError, NAME };

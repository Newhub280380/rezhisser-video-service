'use strict';

// SGLang client for the screenwriting stage.
//
// SGLang serves an OpenAI-compatible API, so this module speaks
// /v1/chat/completions with `response_format: {"type": "json_schema"}`:
// xgrammar compiles the shot_plan schema into a decoding grammar, which makes
// syntactically broken JSON impossible rather than merely unlikely.
//
// RadixAttention caches KV prefixes per exact token prefix, so the system
// prompt is built once, is byte-identical for every request of a template, and
// is placed first. The per-film brief goes last. That way the expensive prefix
// is computed once and then reused across the 24–36 scene continuation calls
// and across all films of the same template.

const { requestJson, assertHttpsBase, ExternalError } = require('../http-client.js');
const { PlanError, MIN_SCENES, MAX_SCENES, validatePlan, planJsonSchema } = require('./schema.js');

const NAME = 'sglang';
// 36 scenes with full prompts do not fit in 8k tokens; a truncated answer is
// invalid JSON, so the cap is generous.
const MAX_COMPLETION_TOKENS = 16384;

// Deterministic system prompt. Never interpolated: every byte is cacheable.
const SYSTEM_PROMPT = [
  'You are a senior commercial film director and screenwriter.',
  'You turn a client brief into a shot plan for a short film that is rendered scene by scene by a video model.',
  '',
  'Rules you must follow:',
  '1. Return one JSON object that matches the provided schema. No prose, no markdown, no comments.',
  '2. Produce between ' + MIN_SCENES + ' and ' + MAX_SCENES + ' scenes. Each scene is one continuous take.',
  '3. Scene durations are 2 to 10 seconds. Total length must stay close to the requested duration.',
  '4. Every scene prompt is self-contained English: subject, action, setting, light, lens, camera move.',
  '5. Keep characters and locations identical across scenes: reuse the exact names from `characters` and `locations`.',
  '6. Never put on-screen text, logos or subtitles into `prompt`; use `onScreenText` for that.',
  '7. Camera moves come only from: static, pan-left, pan-right, dolly-in, dolly-out, crane-up, orbit, handheld.',
  '8. Transitions come only from: cut, dissolve, fade, whip-pan, match-cut.',
  '9. Continuity matters: each scene states what must stay the same as the previous one.',
].join('\n');

class SglangError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SglangError';
    this.code = code;
    if (status) this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Removes markdown fences and trailing commas, then extracts the outermost
// balanced object. Even with constrained decoding a proxy may wrap the answer,
// so the repair path stays cheap and local.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  body = body.slice(start, end + 1);
  const cleaned = body.replace(/,\s*([}\]])/g, '$1');
  for (const candidate of [cleaned, body]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function briefMessage(brief, { durationSeconds, aspect, scenes }) {
  const lines = [
    `Client brief: ${brief.brief}`,
  ];
  if (brief.niche) lines.push(`Niche: ${brief.niche}`);
  if (brief.subject) lines.push(`Subject: ${brief.subject}`);
  if (brief.location) lines.push(`Location: ${brief.location}`);
  if (brief.style) lines.push(`Style: ${brief.style}`);
  if (brief.audience) lines.push(`Audience: ${brief.audience}`);
  if (brief.music) lines.push(`Music mood: ${brief.music}`);
  lines.push(`Target length: about ${durationSeconds} seconds in total.`);
  lines.push(`Scenes: about ${scenes}.`);
  lines.push(`Aspect ratio: ${aspect}. Frame rate: 24 fps.`);
  lines.push('Return only the JSON object.');
  return lines.join('\n');
}

function createSglangPlanner({
  baseUrl,
  model,
  apiKey = '',
  requestTimeoutMs = 120000,
  maxRetries = 3,
  temperature = 0,
  topP = 0.9,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!baseUrl) return null;
  if (!model) throw new Error('SGLANG_MODEL must be set to the served model name.');
  const base = assertHttpsBase(baseUrl, 'SGLANG_BASE_URL');
  const schema = planJsonSchema();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = ['Bearer', apiKey].join(' ');

  async function call(messages, { maxTokens = MAX_COMPLETION_TOKENS, schemaResponse = true } = {}) {
    const body = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      stream: false,
    };
    if (schemaResponse) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'shot_plan', schema, strict: true } };
    }
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const res = await requestJson(fetchImpl, `${base}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          timeoutMs: requestTimeoutMs,
          service: 'sglang',
        });
        if (res.ok && res.json) return res.json;
        const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
        lastError = new SglangError('sglang_error', `SGLang returned HTTP ${res.status}.`, res.status);
        // A 4xx is our request being wrong: retrying it only delays the error.
        if (!retryable) lastError.final = true;
        throw lastError;
      } catch (error) {
        lastError = error instanceof SglangError ? error : new SglangError(error.code || 'sglang_unreachable', 'SGLang is unreachable.');
        if (lastError.final || attempt === maxRetries) throw lastError;
      }
      // 300 ms, 600 ms, 1200 ms — bounded so a dead server fails a job fast.
      await sleep(300 * 2 ** attempt);
    }
    throw lastError || new SglangError('sglang_error', 'SGLang failed.');
  }

  function contentOf(data) {
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) return '';
    const message = choice.message || {};
    if (typeof message.content === 'string') return message.content;
    // Some deployments return content parts.
    if (Array.isArray(message.content)) {
      return message.content.map((part) => (typeof part === 'string' ? part : part && part.text) || '').join('');
    }
    if (typeof choice.text === 'string') return choice.text;
    return '';
  }

  // Returns { plan, raw, attempts, cachedTokens }. Throws SglangError/PlanError.
  async function writePlan(brief, { aspect = '16:9', scenes, durationSeconds } = {}) {
    const userTurn = briefMessage(brief, {
      aspect,
      scenes: scenes || 30,
      durationSeconds: durationSeconds || 150,
    });
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userTurn },
    ];
    const first = await call(messages);
    let raw = contentOf(first);
    let parsed = extractJson(raw);
    if (parsed) {
      try {
        return { plan: validatePlan(parsed, { aspect }), raw, attempts: 1, usage: first.usage || null };
      } catch (error) {
        if (!(error instanceof PlanError)) throw error;
        logger.error(`sglang plan failed validation: ${error.code} ${error.field || ''}`);
        // One repair turn: show the model its own output and the exact error.
        const repair = await call(
          [
            ...messages,
            { role: 'assistant', content: raw.slice(0, 8000) },
            {
              role: 'user',
              content: `The JSON does not satisfy the schema: ${error.message}. Return the corrected JSON object only.`,
            },
          ],
          { maxTokens: MAX_COMPLETION_TOKENS },
        );
        raw = contentOf(repair);
        parsed = extractJson(raw);
        if (!parsed) throw new PlanError('invalid_plan', 'Модель не вернула JSON после исправления.');
        return { plan: validatePlan(parsed, { aspect }), raw, attempts: 2, usage: repair.usage || null };
      }
    }
    throw new PlanError('invalid_plan', 'Модель вернула ответ, который не удалось разобрать как JSON.');
  }

  return {
    name: NAME,
    model,
    baseUrl: base,
    writePlan,
    // Exposed for tests and for the /api/film/capabilities report.
    systemPrompt: SYSTEM_PROMPT,
    jsonSchema: schema,
  };
}

module.exports = { createSglangPlanner, extractJson, SYSTEM_PROMPT, SglangError, NAME };

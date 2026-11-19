'use strict';

// shot_plan.json contract for the film pipeline.
//
// One plan describes a 24–36 scene film. Every field below is validated here
// (no JSON-Schema library: the repo has two dependencies and stays that way).
// The same shape is sent to SGLang as `response_format.json_schema`, so the
// model is constrained by the server and then re-checked here — a plan that
// fails this validator is never rendered.

const crypto = require('node:crypto');

const PLAN_VERSION = 1;
const MIN_SCENES = 24;
const MAX_SCENES = 36;
const SHOT_SECONDS = { min: 2, max: 10 };
const FPS_ALLOWED = [24, 25, 30];
// 480p base render + ReCaVSR one-step 4K upscale is the default cost profile.
const BASE_RESOLUTIONS = { '480p': [854, 480], '540p': [960, 540], '720p': [1280, 720] };
const TARGET_RESOLUTIONS = { '1080p': [1920, 1080], '2160p': [3840, 2160] };
const ASPECTS = ['16:9', '9:16', '1:1', '4:5', '2.39:1'];
const FILM_MOODS = ['cinematic', 'documentary', 'commercial', 'noir', 'warm', 'tech', 'epic', 'minimal'];
const CAMERA_MOVES = ['static', 'pan-left', 'pan-right', 'dolly-in', 'dolly-out', 'crane-up', 'orbit', 'handheld'];
const TRANSITIONS = ['cut', 'dissolve', 'fade', 'whip-pan', 'match-cut'];
const DEFAULT_NEGATIVE =
  'blurry, low quality, distorted faces, deformed hands, extra fingers, warped text, watermark, flicker, jump cuts, inconsistent clothing';

const LIMITS = {
  title: 120,
  logline: 400,
  style: 400,
  sceneTitle: 120,
  action: 900,
  prompt: 1200,
  negativePrompt: 400,
  onScreenText: 200,
  voiceover: 400,
  location: 120,
  characters: 240,
  continuity: 400,
};

class PlanError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    if (field) this.field = field;
  }
}

// Control characters and line separators are removed so a prompt can never
// smuggle a newline-based instruction or break the JSON we log.
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max ? text.slice(0, max) : text;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function planHash(plan) {
  const stable = {
    version: plan.version,
    aspect: plan.aspect,
    fps: plan.fps,
    scenes: plan.scenes.map((scene) => ({
      n: scene.n,
      durationSeconds: scene.durationSeconds,
      prompt: scene.prompt,
      camera: scene.camera,
      transition: scene.transition,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// The JSON Schema handed to SGLang. Bounds mirror the checks below so the
// server-side constrained decoding and our validator agree.
function planJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'logline', 'style', 'aspect', 'fps', 'scenes'],
    properties: {
      title: { type: 'string', maxLength: LIMITS.title },
      logline: { type: 'string', maxLength: LIMITS.logline },
      style: { type: 'string', maxLength: LIMITS.style },
      mood: { type: 'string', enum: FILM_MOODS },
      // Optional film-wide negative prompt, applied to every scene that does
      // not define its own.
      negativePrompt: { type: 'string', maxLength: LIMITS.negativePrompt },
      aspect: { type: 'string', enum: ASPECTS },
      fps: { type: 'integer', enum: FPS_ALLOWED },
      characters: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description'],
          properties: {
            name: { type: 'string', maxLength: 60 },
            description: { type: 'string', maxLength: LIMITS.characters },
            wardrobe: { type: 'string', maxLength: LIMITS.characters },
          },
        },
      },
      locations: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description'],
          properties: {
            name: { type: 'string', maxLength: 60 },
            description: { type: 'string', maxLength: LIMITS.location },
            timeOfDay: { type: 'string', maxLength: 40 },
          },
        },
      },
      scenes: {
        type: 'array',
        minItems: MIN_SCENES,
        maxItems: MAX_SCENES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['n', 'title', 'durationSeconds', 'prompt'],
          properties: {
            n: { type: 'integer', minimum: 1, maximum: MAX_SCENES },
            title: { type: 'string', maxLength: LIMITS.sceneTitle },
            durationSeconds: { type: 'number', minimum: SHOT_SECONDS.min, maximum: SHOT_SECONDS.max },
            prompt: { type: 'string', maxLength: LIMITS.prompt },
            negativePrompt: { type: 'string', maxLength: LIMITS.negativePrompt },
            camera: { type: 'string', enum: CAMERA_MOVES },
            transition: { type: 'string', enum: TRANSITIONS },
            onScreenText: { type: 'string', maxLength: LIMITS.onScreenText },
            voiceover: { type: 'string', maxLength: LIMITS.voiceover },
            location: { type: 'string', maxLength: LIMITS.location },
            characters: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 60 } },
            continuity: { type: 'string', maxLength: LIMITS.continuity },
          },
        },
      },
    },
  };
}

function normalizeScene(raw, index, previous) {
  if (!isPlainObject(raw)) throw new PlanError('invalid_plan', `Сцена ${index + 1} — не объект.`, `scenes[${index}]`);
  const prompt = cleanText(raw.prompt, LIMITS.prompt);
  if (prompt.length < 8) {
    throw new PlanError('invalid_plan', `В сцене ${index + 1} пустой промпт.`, `scenes[${index}].prompt`);
  }
  const duration = clampNumber(raw.durationSeconds, SHOT_SECONDS.min, SHOT_SECONDS.max, null);
  if (duration === null) {
    throw new PlanError('invalid_plan', `В сцене ${index + 1} нет длительности.`, `scenes[${index}].durationSeconds`);
  }
  const characters = Array.isArray(raw.characters)
    ? raw.characters.map((name) => cleanText(String(name), 60)).filter(Boolean).slice(0, 6)
    : [];
  return {
    n: index + 1,
    title: cleanText(raw.title, LIMITS.sceneTitle) || `Сцена ${index + 1}`,
    durationSeconds: Math.round(duration * 100) / 100,
    prompt,
    negativePrompt: cleanText(raw.negativePrompt, LIMITS.negativePrompt),
    camera: oneOf(raw.camera, CAMERA_MOVES, previous ? previous.camera : 'static'),
    transition: oneOf(raw.transition, TRANSITIONS, 'cut'),
    onScreenText: cleanText(raw.onScreenText, LIMITS.onScreenText),
    voiceover: cleanText(raw.voiceover, LIMITS.voiceover),
    location: cleanText(raw.location, LIMITS.location),
    characters,
    continuity: cleanText(raw.continuity, LIMITS.continuity),
  };
}

// Validates and normalizes a plan. Throws PlanError; never returns a partial
// plan, because a half-valid plan renders as a broken film.
function validatePlan(raw, { aspect = '16:9', minScenes = MIN_SCENES, maxScenes = MAX_SCENES } = {}) {
  if (!isPlainObject(raw)) throw new PlanError('invalid_plan', 'План должен быть объектом.');
  if (!Array.isArray(raw.scenes)) throw new PlanError('invalid_plan', 'В плане нет массива scenes.', 'scenes');
  if (raw.scenes.length < minScenes || raw.scenes.length > maxScenes) {
    throw new PlanError(
      'invalid_plan',
      `Нужно от ${minScenes} до ${maxScenes} сцен, получено ${raw.scenes.length}.`,
      'scenes',
    );
  }
  const scenes = [];
  for (let i = 0; i < raw.scenes.length; i += 1) {
    scenes.push(normalizeScene(raw.scenes[i], i, scenes[i - 1]));
  }
  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .filter(isPlainObject)
        .map((item) => ({
          name: cleanText(item.name, 60),
          description: cleanText(item.description, LIMITS.characters),
          wardrobe: cleanText(item.wardrobe, LIMITS.characters),
        }))
        .filter((item) => item.name)
        .slice(0, 12)
    : [];
  const locations = Array.isArray(raw.locations)
    ? raw.locations
        .filter(isPlainObject)
        .map((item) => ({
          name: cleanText(item.name, 60),
          description: cleanText(item.description, LIMITS.location),
          timeOfDay: cleanText(item.timeOfDay, 40),
        }))
        .filter((item) => item.name)
        .slice(0, 12)
    : [];
  const plan = {
    version: PLAN_VERSION,
    title: cleanText(raw.title, LIMITS.title) || 'Без названия',
    logline: cleanText(raw.logline, LIMITS.logline),
    style: cleanText(raw.style, LIMITS.style) || 'cinematic, filmic, natural light',
    mood: oneOf(raw.mood, FILM_MOODS, 'cinematic'),
    negativePrompt: cleanText(raw.negativePrompt, LIMITS.negativePrompt) || DEFAULT_NEGATIVE,
    aspect: oneOf(raw.aspect, ASPECTS, aspect),
    fps: FPS_ALLOWED.includes(Number(raw.fps)) ? Number(raw.fps) : 24,
    // Base seed for the renderer; each scene adds its own number to it.
    seed: Number.isInteger(raw.seed) && raw.seed >= 0 ? raw.seed : null,
    characters,
    locations,
    scenes,
    totalSeconds: Math.round(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) * 100) / 100,
  };
  plan.hash = planHash(plan);
  return plan;
}

// Pixel size of the final film. The short side follows the target tier, so a
// vertical 9:16 reel is 2160x3840 and not a stretched landscape frame.
function outputSize(aspect, target) {
  const short = target === '1080p' ? 1080 : 2160;
  const even = (value) => Math.round(value / 2) * 2;
  if (aspect === '9:16') return { width: short, height: even((short * 16) / 9) };
  if (aspect === '1:1') return { width: short, height: short };
  if (aspect === '4:5') return { width: short, height: even((short * 5) / 4) };
  const width = even((short * 16) / 9);
  if (aspect === '2.39:1') return { width, height: even(width / 2.39) };
  return { width, height: short };
}

function resolutionFor(base, target) {
  const basePair = BASE_RESOLUTIONS[base] || BASE_RESOLUTIONS['480p'];
  const targetPair = TARGET_RESOLUTIONS[target] || TARGET_RESOLUTIONS['2160p'];
  return {
    base: { name: BASE_RESOLUTIONS[base] ? base : '480p', width: basePair[0], height: basePair[1] },
    target: { name: TARGET_RESOLUTIONS[target] ? target : '2160p', width: targetPair[0], height: targetPair[1] },
  };
}

module.exports = {
  PLAN_VERSION,
  MIN_SCENES,
  MAX_SCENES,
  SHOT_SECONDS,
  BASE_RESOLUTIONS,
  TARGET_RESOLUTIONS,
  ASPECTS,
  FILM_MOODS,
  CAMERA_MOVES,
  TRANSITIONS,
  LIMITS,
  FPS_ALLOWED,
  DEFAULT_NEGATIVE,
  PlanError,
  cleanText,
  isPlainObject,
  planJsonSchema,
  validatePlan,
  planHash,
  resolutionFor,
  outputSize,
};

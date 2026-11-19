'use strict';

// Built-in storyboard writer: a long film plan without a language model.
//
// It is used when no SGLang server is configured, so a long film never stops
// on "connect a model first". It does not write a story — it lays the buyer's
// own words out over a fixed editorial rhythm (opening, context, details,
// process, people, result, closing) with a rotating set of camera moves, and
// the plan passes the same validator as a model-written one. Same input, same
// plan. A job planned this way reports the engine `storyboard`; with SGLang
// configured the model writes the plan instead.

const { cleanText, validatePlan } = require('./schema.js');

const BEATS = [
  { title: 'Открытие', shot: 'wide establishing shot', camera: 'dolly-in' },
  { title: 'Контекст', shot: 'medium shot showing the surroundings', camera: 'pan-left' },
  { title: 'Герой', shot: 'hero shot, subject centred', camera: 'static' },
  { title: 'Деталь', shot: 'macro close-up of the key detail', camera: 'dolly-in' },
  { title: 'Фактура', shot: 'close-up of texture and material', camera: 'pan-right' },
  { title: 'Процесс', shot: 'medium shot of the subject in use', camera: 'handheld' },
  { title: 'Ракурс', shot: 'low-angle three-quarter view', camera: 'orbit' },
  { title: 'Атмосфера', shot: 'wide atmospheric shot with depth', camera: 'crane-up' },
  { title: 'Акцент', shot: 'tight shot with shallow depth of field', camera: 'dolly-out' },
];
const OPENING = BEATS[0];
const CLOSING = { title: 'Финал', shot: 'clean final hero shot with space for a caption', camera: 'dolly-out' };

function buildStoryboard(brief = {}, { aspect = '16:9', scenes = 30, durationSeconds = 150 } = {}) {
  const idea = cleanText(brief.brief, 400);
  const subject = cleanText(brief.subject, 120) || idea;
  const location = cleanText(brief.location, 120);
  const style = cleanText(brief.style, 200) || 'cinematic, natural light, shallow depth of field';
  const niche = cleanText(brief.niche, 120);
  const seconds = Math.max(2, Math.min(10, Math.round((durationSeconds / scenes) * 2) / 2));
  const list = [];
  for (let i = 0; i < scenes; i += 1) {
    const beat = i === 0 ? OPENING : i === scenes - 1 ? CLOSING : BEATS[1 + ((i - 1) % (BEATS.length - 1))];
    list.push({
      n: i + 1,
      title: `${beat.title} ${Math.floor(i / BEATS.length) + 1}`,
      durationSeconds: seconds,
      prompt: [
        `${beat.shot} of ${subject}`,
        location ? `in ${location}` : '',
        niche ? `(${niche})` : '',
        idea && idea !== subject ? `— ${idea}` : '',
        `. ${style}.`,
      ].filter(Boolean).join(' ').replace(/\s+\./g, '.'),
      camera: beat.camera,
      transition: 'cut',
      location,
    });
  }
  return validatePlan(
    {
      title: cleanText(idea || subject, 120),
      logline: idea,
      style,
      aspect,
      fps: 24,
      locations: location ? [{ name: 'Локация', description: location }] : [],
      scenes: list,
    },
    { aspect, minScenes: scenes, maxScenes: scenes },
  );
}

// "Reel from my photos" in one step: one scene per photo, in upload order,
// with a rotating set of calm camera moves. 24 photos at 5–7 s give a
// 2–3 minute story reel.
const REEL_CAMERAS = ['dolly-in', 'pan-left', 'dolly-out', 'pan-right', 'orbit', 'crane-up'];

function buildPhotoReel({ count, aspect = '9:16', secondsPerPhoto = 4, title = '', style = '' } = {}) {
  const total = Math.max(1, Math.min(36, Number(count) || 0));
  const seconds = Math.max(2, Math.min(10, Number(secondsPerPhoto) || 4));
  const look = cleanText(style, 200) || 'clean studio light, premium commercial look';
  return validatePlan(
    {
      title: cleanText(title, 120) || 'Ролик из фото',
      style: look,
      aspect,
      fps: 24,
      scenes: Array.from({ length: total }, (_, i) => ({
        n: i + 1,
        title: `Фото ${i + 1}`,
        durationSeconds: seconds,
        prompt: `Slow cinematic camera move over the reference photo ${i + 1}; the subject stays exactly as photographed. ${look}.`,
        camera: REEL_CAMERAS[i % REEL_CAMERAS.length],
        transition: 'cut',
      })),
    },
    { aspect, minScenes: total, maxScenes: total },
  );
}

// Buyer-written caption lines laid over the scenes in order: with fewer lines
// than scenes they are spread evenly, so the text spans the whole film.
function applyCaptions(plan, captions) {
  const lines = (Array.isArray(captions) ? captions : []).map((line) => cleanText(String(line), 200)).filter(Boolean).slice(0, plan.scenes.length);
  if (!lines.length) return plan;
  const step = plan.scenes.length / lines.length;
  const scenes = plan.scenes.map((scene) => ({ ...scene }));
  lines.forEach((line, index) => {
    scenes[Math.min(scenes.length - 1, Math.floor(index * step))].onScreenText = line;
  });
  return { ...plan, scenes };
}

module.exports = { buildStoryboard, buildPhotoReel, applyCaptions, BEATS, REEL_CAMERAS };

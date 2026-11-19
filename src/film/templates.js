'use strict';

// Commercial Reels presets.
//
// The buyer types four things: niche, subject, location, style. A template is a
// fixed storyboard: the shots, their order and length, the camera move, frame
// rate, format and look are written here and are the same on every run. No
// language model is involved, so the same four answers always produce the same
// shot plan and the same prompts.
//
// What this does and does not guarantee: the *request* is identical every time.
// The video model is still generative, so two runs are consistent in framing
// and pacing but not pixel-identical. Camera move and look are enforced through
// the prompt; 24 fps and the frame size are enforced when the film is assembled.

const { cleanText } = require('./schema.js');

const METADATA_FIELDS = ['niche', 'subject', 'location', 'style'];
const FIELD_LABELS = { niche: 'Ниша', subject: 'Объект', location: 'Локация', style: 'Стиль' };

const LOCKED = Object.freeze({
  cameraMovement: 'Pan Left',
  fps: 24,
  style: 'Cinematic 4K',
  aspect: '9:16',
  sceneSeconds: 5,
});
const LOOK = 'Cinematic 4K look, steady gimbal, shallow depth of field, soft key light, natural colours';
const NEGATIVE = 'blurry, low quality, distorted text, watermark, deformed hands, extra fingers, flicker, warping, camera shake';

// {niche} {subject} {location} {style} are the only variables.
const TEMPLATES = [
  {
    id: 'reels-product-hero',
    label: 'Продукт-герой',
    hint: 'Один предмет в центре кадра: общий план, деталь, финальный кадр.',
    shots: [
      'Wide establishing shot of {subject} on a clean surface in {location}, {style} styling, product centered',
      'Macro detail of {subject}: texture, edges and label in sharp focus, {style} styling',
      'Hero shot of {subject} in {location}, full product in frame with empty space above for a caption, {style} styling',
    ],
  },
  {
    id: 'reels-interior',
    label: 'Интерьер / недвижимость',
    hint: 'Проход по помещению: вход, главная зона, деталь, общий вид.',
    shots: [
      'Entrance view into {location}, {style} interior, straight verticals, daylight',
      'Main area of {location} with {subject} as the focal point, {style} interior',
      'Close detail of {subject} in {location}: materials and finish, {style} interior',
      'Wide final view of {location} showing the whole space, {style} interior',
    ],
  },
  {
    id: 'reels-clinic',
    label: 'Клиника / услуга',
    hint: 'Спокойная подача: пространство, подготовка, результат. Без крови и игл крупным планом.',
    shots: [
      'Bright, clean {location}, calm atmosphere, {style} setting, no people in distress',
      'Gloved hands of a professional preparing {subject} on a sterile tray in {location}, {style} setting, no blood, no needles in close-up',
      '{subject} presented neatly in {location}, professional {niche} setting, {style} styling',
    ],
  },
  {
    id: 'reels-food',
    label: 'Еда / напиток',
    hint: 'Аппетитная текстура: общий план, макро, подача.',
    shots: [
      '{subject} served on a table in {location}, {style} styling, warm side light',
      'Macro of {subject}: texture, steam and droplets, {style} styling',
      'Final serving shot of {subject} in {location}, garnish in focus, {style} styling',
    ],
  },
  {
    id: 'reels-fashion',
    label: 'Мода / образ',
    hint: 'Образ целиком, ткань крупно, финальная поза.',
    shots: [
      'Full-length view of {subject} in {location}, {style} styling, editorial light',
      'Close detail of {subject}: fabric, stitching and fit, {style} styling',
      'Medium shot of {subject} in {location}, poised final pose, {style} styling',
    ],
  },
  {
    id: 'reels-auto',
    label: 'Авто / техника',
    hint: 'Силуэт, детали, финальный ракурс три четверти.',
    shots: [
      'Side profile of {subject} in {location}, {style}, controlled highlights',
      'Detail of {subject}: badge, wheel and body line, realistic reflections, {style}',
      'Interior or control detail of {subject}, {style}',
      'Three-quarter front view of {subject} in {location}, {style}',
    ],
  },
];

const BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));

class TemplateError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    if (field) this.field = field;
  }
}

function listTemplates() {
  return TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    hint: template.hint,
    fields: FIELD_LABELS,
    locked: { ...LOCKED, shots: template.shots.length, totalSeconds: template.shots.length * LOCKED.sceneSeconds },
  }));
}

// Only the four metadata fields are read. Anything else the client sent is
// listed in `ignored`, so the UI can show that it had no effect.
function validateMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TemplateError('invalid_metadata', 'Нужны поля ниши, объекта, локации и стиля.');
  }
  const values = {};
  for (const field of METADATA_FIELDS) {
    const text = cleanText(typeof payload[field] === 'string' ? payload[field] : '', 120).replace(/[{}]/g, '');
    if (text.length < 2) throw new TemplateError('metadata_required', `Заполните поле «${FIELD_LABELS[field]}».`, field);
    values[field] = text;
  }
  return { values, ignored: Object.keys(payload).filter((key) => !METADATA_FIELDS.includes(key)) };
}

// Returns the complete, fixed shot plan for a template.
function buildPreset({ templateId, metadata } = {}) {
  const template = BY_ID.get(templateId);
  if (!template) throw new TemplateError('unknown_template', 'Неизвестный шаблон.', 'templateId');
  const { values, ignored } = validateMetadata(metadata);
  const fill = (text) => text.replace(/\{(niche|subject|location|style)\}/g, (_, key) => values[key]);
  return {
    templateId: template.id,
    label: template.label,
    metadata: values,
    ignoredFields: ignored,
    locked: { ...LOCKED, shots: template.shots.length, totalSeconds: template.shots.length * LOCKED.sceneSeconds },
    plan: {
      title: `${template.label}: ${values.subject}`,
      logline: `${values.niche} — ${values.subject}, ${values.location}`,
      style: `${LOOK}, ${values.style}`,
      aspect: LOCKED.aspect,
      fps: LOCKED.fps,
      negativePrompt: NEGATIVE,
      scenes: template.shots.map((shot, index) => ({
        title: `Кадр ${index + 1}`,
        durationSeconds: LOCKED.sceneSeconds,
        prompt: `${fill(shot)}. ${LOOK}.`,
        camera: 'pan-left',
        transition: 'cut',
      })),
    },
  };
}

module.exports = { TEMPLATES, LOCKED, METADATA_FIELDS, TemplateError, listTemplates, validateMetadata, buildPreset };

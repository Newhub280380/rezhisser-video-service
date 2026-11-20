'use strict';

// Templates as data, not code. A template answers one question — "what kind of
// film is this" — and the renderer only follows the answers: how many shots,
// how long each one lives, what the camera does, how the title is set.
//
// The five presets are the ones the business actually sells: a product reel, a
// dark trailer, a property walkthrough, a long YouTube cut and a chat story.
// Each shot names a camera move the renderer already knows; nothing here needs
// a model, so the same photo always gives the same result.

const CAMERAS = ['push', 'pull', 'pan', 'hold', 'tilt'];

const TEMPLATES = {
  paragon: {
    id: 'paragon',
    title: 'PARAGON',
    subtitle: 'Товар крупно',
    note: 'Пять кадров, твист в титре. Подходит для упаковки и флаконов.',
    aspect: '9:16',
    size: { width: 1080, height: 1920 },
    fps: 24,
    shots: [
      { camera: 'push', seconds: 3 },
      { camera: 'pan', seconds: 3 },
      { camera: 'pull', seconds: 3 },
      { camera: 'push', seconds: 3 },
      { camera: 'hold', seconds: 4 },
    ],
    title: { text: '', size: 62, position: 'bottom', fadeIn: 0.4 },
    mood: 'dark',
  },
  ragnarok: {
    id: 'ragnarok',
    title: 'RAGNAROK',
    subtitle: 'Тёмный трейлер',
    note: 'Шесть кадров, жёсткий контраст, короткие склейки.',
    aspect: '9:16',
    size: { width: 1080, height: 1920 },
    fps: 24,
    shots: [
      { camera: 'hold', seconds: 2 },
      { camera: 'push', seconds: 2 },
      { camera: 'tilt', seconds: 2 },
      { camera: 'pan', seconds: 2 },
      { camera: 'pull', seconds: 3 },
      { camera: 'hold', seconds: 4 },
    ],
    title: { text: '', size: 74, position: 'center', fadeIn: 0.6 },
    mood: 'dark',
  },
  rubicon: {
    id: 'rubicon',
    title: 'RUBICON',
    subtitle: 'Недвижимость',
    note: 'Панорама помещения, медленный ход, спокойные титры.',
    aspect: '9:16',
    size: { width: 1080, height: 1920 },
    fps: 25,
    shots: [
      { camera: 'pan', seconds: 4 },
      { camera: 'push', seconds: 4 },
      { camera: 'tilt', seconds: 4 },
      { camera: 'hold', seconds: 3 },
    ],
    title: { text: '', size: 54, position: 'bottom', fadeIn: 0.5 },
    mood: 'light',
  },
  youtube: {
    id: 'youtube',
    title: 'YOUTUBE',
    subtitle: 'Длинный выпуск',
    note: 'Горизонталь, длинные кадры, титр сверху.',
    aspect: '16:9',
    size: { width: 1920, height: 1080 },
    fps: 25,
    shots: [
      { camera: 'push', seconds: 5 },
      { camera: 'pan', seconds: 5 },
      { camera: 'hold', seconds: 5 },
      { camera: 'pull', seconds: 5 },
    ],
    title: { text: '', size: 56, position: 'top', fadeIn: 0.5 },
    mood: 'dark',
  },
  chat: {
    id: 'chat',
    title: 'ЧАТ',
    subtitle: 'История переписки',
    note: 'Вертикаль под скрин: кадр держится, чтобы текст успели прочитать.',
    aspect: '9:16',
    size: { width: 1080, height: 1920 },
    fps: 24,
    shots: [
      { camera: 'hold', seconds: 5 },
      { camera: 'push', seconds: 3 },
      { camera: 'hold', seconds: 5 },
    ],
    title: { text: '', size: 50, position: 'top', fadeIn: 0.3 },
    mood: 'light',
  },
};

function list() {
  return Object.values(TEMPLATES).map(({ id, title, subtitle, note, aspect, shots }) => ({
    id,
    title,
    subtitle,
    note,
    aspect,
    seconds: shots.reduce((sum, shot) => sum + shot.seconds, 0),
    shots: shots.length,
  }));
}

function get(id) {
  const template = TEMPLATES[String(id || '').toLowerCase()];
  if (!template) {
    const error = new Error(`неизвестный шаблон: ${id}`);
    error.code = 'template_unknown';
    throw error;
  }
  return template;
}

module.exports = { TEMPLATES, CAMERAS, list, get };

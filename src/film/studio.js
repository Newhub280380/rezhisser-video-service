'use strict';

// Built-in "photo studio" renderer: a scene clip made from the buyer's own
// photo with a virtual camera move, on ffmpeg alone.
//
// Why it exists: a generative video model redraws the subject in every frame,
// so a label, a logo or a face can drift. Here the subject's pixels are never
// regenerated — the photo (or its cut-out) is only moved, scaled and lit:
//
//   * cut-out available -> the subject floats over a studio backdrop with a
//     soft shadow, and the camera move is applied to the subject (packshot);
//   * no cut-out        -> the whole photo gets a slow pan/zoom; when its shape
//     is far from the frame it sits on a blurred copy of itself.
//
// It needs no GPU, no network and no paid provider, renders straight at the
// target size (so there is nothing to upscale), and the same input always
// gives the same clip. It is camera motion over a still image: people do not
// move and nothing new is drawn — the job reports this engine as `studio`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./compose.js');

const BACKDROPS = {
  light: { label: 'Светлая студия', center: '0xf6f3ee', edge: '0xcfc9bf' },
  dark: { label: 'Тёмная студия', center: '0x3a3a40', edge: '0x0c0c0f' },
  warm: { label: 'Тёплый беж', center: '0xf5e6d3', edge: '0xcfa986' },
  cool: { label: 'Холодный серо-голубой', center: '0xe6eef5', edge: '0x9fb4c7' },
  blush: { label: 'Пудровый розовый', center: '0xf8e8ea', edge: '0xd6aeb8' },
};
const BACKDROP_HINTS = [
  ['dark', /dark|noir|black|night|тёмн|темн|ноч|чёрн|черн/i],
  ['warm', /warm|cozy|gold|beige|тёпл|тепл|уют|беж|золот/i],
  ['cool', /cool|cold|tech|clinic|steel|холод|техно|клиник|стал/i],
  ['blush', /blush|pink|beauty|rose|розов|пудр|бьюти|нежн/i],
];
const CAMERAS = ['static', 'pan-left', 'pan-right', 'dolly-in', 'dolly-out', 'crane-up', 'orbit', 'handheld'];

class StudioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
  }
}

function pickBackdrop(name, hint = '') {
  if (BACKDROPS[name]) return name;
  const match = BACKDROP_HINTS.find(([, pattern]) => pattern.test(String(hint)));
  return match ? match[0] : 'light';
}

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

// Camera move as ffmpeg expressions of `t`. `dx`/`dy` are offsets in canvas
// pixels (the camera pans left -> the subject travels right), `z` is a scale
// factor that never goes below 1.
function motion(camera, seconds, { width, height, amplitude = 0.045 }) {
  const p = `(t/${seconds})`;
  const ax = Math.round(width * amplitude);
  const ay = Math.round(height * amplitude);
  switch (camera) {
    case 'pan-left':
      return { z: '1', dx: `${2 * ax}*(${p}-0.5)`, dy: '0' };
    case 'pan-right':
      return { z: '1', dx: `${-2 * ax}*(${p}-0.5)`, dy: '0' };
    case 'dolly-in':
      return { z: `(1+0.09*${p})`, dx: '0', dy: '0' };
    case 'dolly-out':
      return { z: `(1.09-0.09*${p})`, dx: '0', dy: '0' };
    case 'crane-up':
      return { z: '1', dx: '0', dy: `${2 * ay}*(${p}-0.5)` };
    case 'orbit':
      return { z: `(1+0.04*sin(PI*${p}))`, dx: `${ax}*sin(2*PI*${p})`, dy: '0' };
    case 'handheld':
      return { z: '1.02', dx: `${Math.round(ax / 4)}*sin(2*PI*0.7*t)`, dy: `${Math.round(ay / 5)}*sin(2*PI*0.45*t+1)` };
    default:
      return { z: '1', dx: '0', dy: '0' };
  }
}

function backdropInput(name, width, height, seconds, fps) {
  const tone = BACKDROPS[name] || BACKDROPS.light;
  // Radial light: bright behind the subject, darker towards the corners.
  const source = [
    `gradients=s=${width}x${height}`,
    `c0=${tone.center}`,
    `c1=${tone.edge}`,
    `x0=${Math.round(width / 2)}`,
    `y0=${Math.round(height * 0.46)}`,
    'x1=0',
    'y1=0',
    'type=radial',
    'speed=0',
    `rate=${fps}`,
    `duration=${seconds}`,
  ].join(':');
  return ['-f', 'lavfi', '-i', source];
}

// Size of the soft-shadow still made from a cut-out: a quarter-size silhouette
// with a transparent margin for the blur.
function shadowShape(cut) {
  const width = even(cut.width / 4);
  const height = even(cut.height / 4);
  const margin = even(Math.max(width, height) * 0.07);
  return { width, height, margin, sigma: Math.max(2, Math.round(margin / 3)) };
}

function shadowArgs(cutPath, outPath, shape) {
  const chain = [
    'format=rgba',
    `scale=${shape.width}:${shape.height}`,
    `pad=${shape.width + 2 * shape.margin}:${shape.height + 2 * shape.margin}:${shape.margin}:${shape.margin}:color=black@0`,
    'colorchannelmixer=rr=0:gg=0:bb=0:aa=0.38',
    `gblur=sigma=${shape.sigma}`,
  ].join(',');
  return ['-i', cutPath, '-vf', chain];
}

// Subject (RGBA cut-out) over a studio backdrop, with a soft shadow.
//
// The shadow is a separate still input. Deriving it from the animated subject
// with `split` crashes ffmpeg when the per-frame size shrinks (dolly-out), and
// blurring it once is also several times faster.
function packshotArgs({ cutPath, cut, platePath, shadowPath, width, height, fps, seconds, camera, outPath, supersample = 1 }) {
  const cw = width * supersample;
  const ch = height * supersample;
  const fit = Math.min((cw * 0.74) / cut.width, (ch * 0.64) / cut.height);
  const bw = cut.width * fit;
  const bh = cut.height * fit;
  const move = motion(camera, seconds, { width: cw, height: ch });
  const shape = shadowShape(cut);
  const sw = bw * ((shape.width + 2 * shape.margin) / shape.width);
  const sh = bh * ((shape.height + 2 * shape.margin) / shape.height);
  const sized = (w, h) => `scale=w='trunc(${w.toFixed(2)}*${move.z}/2)*2':h='trunc(${h.toFixed(2)}*${move.z}/2)*2':eval=frame`;
  const drop = Math.round(ch * 0.018);
  const graph = [
    `[0:v]format=rgba,${sized(bw, bh)}[obj]`,
    `[2:v]format=rgba,${sized(sw, sh)}[shadow]`,
    '[1:v]format=yuv420p[bg]',
    `[bg][shadow]overlay=x='(W-w)/2+0.85*(${move.dx})+${Math.round(drop / 2)}':y='(H-h)/2+(${move.dy})+${drop}':eval=frame:format=yuv420[lit]`,
    `[lit][obj]overlay=x='(W-w)/2+(${move.dx})':y='(H-h)/2+(${move.dy})':eval=frame:shortest=1:format=yuv420${supersample > 1 ? `,scale=${width}:${height}:flags=lanczos` : ''},format=yuv420p[out]`,
  ].join(';');
  const input = (file) => ['-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', file];
  return [
    '-y', ...input(cutPath), ...input(platePath), ...input(shadowPath),
    '-filter_complex', graph, '-map', '[out]', '-frames:v', String(Math.round(seconds * fps)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', outPath,
  ];
}

// The whole photo with a slow pan/zoom.
function fullFrameArgs({ photoPath, photo, width, height, fps, seconds, camera, outPath, supersample = 1 }) {
  const cw = width * supersample;
  const ch = height * supersample;
  const frameAspect = cw / ch;
  const photoAspect = photo.width / photo.height;
  // Close shapes fill the frame; a very different shape would lose most of the
  // picture to cropping, so it is shown whole over a blurred copy.
  const cover = Math.max(frameAspect, photoAspect) / Math.min(frameAspect, photoAspect) <= 1.45;
  const scale = cover
    ? Math.max(cw / photo.width, ch / photo.height) * 1.1
    : Math.min(cw / photo.width, ch / photo.height);
  const bw = photo.width * scale;
  const bh = photo.height * scale;
  const move = motion(camera, seconds, { width: cw, height: ch, amplitude: cover ? 0.04 : 0.03 });
  // A JPEG is full-range; the clip must be ordinary limited-range video.
  const fg = `scale=w='trunc(${bw.toFixed(2)}*${move.z}/2)*2':h='trunc(${bh.toFixed(2)}*${move.z}/2)*2':eval=frame:out_range=tv,format=yuv420p`;
  const place = `overlay=x='(W-w)/2+(${move.dx})':y='(H-h)/2+(${move.dy})':eval=frame:shortest=1`;
  const tail = `${supersample > 1 ? `,scale=${width}:${height}:flags=lanczos` : ''},format=yuv420p[out]`;
  const graph = cover
    ? [`color=c=black:s=${cw}x${ch}:r=${fps}:d=${seconds}[bg]`, `[0:v]${fg}[fg]`, `[bg][fg]${place}${tail}`].join(';')
    : [
        '[0:v]split[a][b]',
        // Blur on a small copy, then enlarge: same look, a fraction of the time.
        `[a]scale=${even(cw / 8)}:${even(ch / 8)}:force_original_aspect_ratio=increase:out_range=tv,format=yuv420p,crop=${even(cw / 8)}:${even(ch / 8)},gblur=sigma=7,eq=brightness=-0.05:saturation=0.9,scale=${cw}:${ch}[bg]`,
        `[b]${fg}[fg]`,
        `[bg][fg]${place}${tail}`,
      ].join(';');
  return [
    '-y', '-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', photoPath,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', String(Math.round(seconds * fps)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', outPath,
  ];
}

function createStudio({ ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe', workDir, timeoutMs = 600000, runner = run } = {}) {
  const sizes = new Map();

  async function imageSize(file) {
    if (sizes.has(file)) return sizes.get(file);
    const probe = await runner(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { capture: true, timeoutMs: 30000 });
    const match = String((probe && probe.stdout) || '').match(/(\d+)x(\d+)/);
    if (!probe.ok || !match) throw new StudioError(probe.code === 'tool_missing' ? 'ffmpeg_missing' : 'photo_unreadable', 'Не удалось прочитать фото для сцены.');
    const size = { width: Number(match[1]), height: Number(match[2]) };
    sizes.set(file, size);
    return size;
  }

  // The studio backdrop is drawn once per size and reused by every scene.
  const plates = new Map();
  function backdropPlate(name, width, height) {
    const key = `${name}-${width}x${height}`;
    if (!plates.has(key)) {
      const file = path.join(workDir, 'plates', `${key}.png`);
      const make = async () => {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const draft = `${file}.${crypto.randomBytes(3).toString('hex')}.png`;
        // A little grain hides gradient banding after H.264.
        await still([...backdropInput(name, width, height, 1, 1), '-vf', 'noise=alls=3:allf=u'], draft, 'backdrop_failed');
        fs.renameSync(draft, file);
        return file;
      };
      plates.set(key, make().catch((error) => { plates.delete(key); throw error; }));
    }
    return plates.get(key);
  }

  // The soft shadow of a cut-out, made once and reused by all its scenes.
  const shadows = new Map();
  function shadowStill(cutPath, cut) {
    const stat = fs.statSync(cutPath);
    const key = crypto.createHash('sha1').update(`${cutPath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    if (!shadows.has(key)) {
      const file = path.join(workDir, 'shadows', `${key}.png`);
      const make = async () => {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const draft = `${file}.${crypto.randomBytes(3).toString('hex')}.png`;
        await still(shadowArgs(cutPath, draft, shadowShape(cut)), draft, 'shadow_failed');
        fs.renameSync(draft, file);
        return file;
      };
      shadows.set(key, make().catch((error) => { shadows.delete(key); throw error; }));
    }
    return shadows.get(key);
  }

  // scene: { n, durationSeconds, camera, photo: { path, fullPath?, cutPath? } }
  // context: { jobId, fps, size: { width, height }, backdrop, style, cutout }
  async function renderScene(scene, context = {}) {
    if (context.signal && context.signal.aborted) throw new StudioError('canceled', 'Задача отменена.');
    const photo = scene.photo || null;
    if (!photo || !(photo.fullPath || photo.path)) throw new StudioError('photo_required', 'Для сцены нет фото.');
    const { width, height } = context.size || { width: 1080, height: 1920 };
    const fps = Number(context.fps) || 24;
    const seconds = Math.max(2, Math.min(10, Number(scene.durationSeconds) || 5));
    const camera = CAMERAS.includes(scene.camera) ? scene.camera : 'static';
    // Integer pixel steps are visible at small sizes; render them at 2x.
    const supersample = Math.min(width, height) <= 1080 ? 2 : 1;
    const dir = path.join(workDir, String(context.jobId || 'studio'), 'clips');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `scene-${scene.n}-${crypto.randomBytes(3).toString('hex')}.mp4`);
    const useCut = Boolean(photo.cutPath) && context.cutout !== false && fs.existsSync(photo.cutPath);
    const source = useCut ? photo.cutPath : photo.fullPath || photo.path;
    const size = await imageSize(source);
    const args = useCut
      ? packshotArgs({ cutPath: source, cut: size, shadowPath: await shadowStill(source, size), platePath: await backdropPlate(pickBackdrop(context.backdrop, context.style), width * supersample, height * supersample), width, height, fps, seconds, camera, outPath, supersample })
      : fullFrameArgs({ photoPath: source, photo: size, width, height, fps, seconds, camera, outPath, supersample });
    const result = await runner(ffmpegBin, ['-hide_banner', '-loglevel', 'error', ...args], { timeoutMs });
    if (!result.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fs.rmSync(outPath, { force: true });
      throw new StudioError(result.code === 'tool_missing' ? 'ffmpeg_missing' : 'studio_render_failed', result.code === 'tool_missing' ? 'Не найден ffmpeg.' : `Сцена ${scene.n} не собрана.`);
    }
    return { path: outPath, engine: 'studio', look: useCut ? 'packshot' : 'photo' };
  }

  // ---- still-image tools used by the product-shot editor -------------------

  async function still(args, outPath, code) {
    const result = await runner(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-frames:v', '1', ...(outPath.endsWith('.png') ? [] : ['-q:v', '2']), '-map_metadata', '-1', outPath], { timeoutMs: 120000 });
    if (!result.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fs.rmSync(outPath, { force: true });
      throw new StudioError(result.code === 'tool_missing' ? 'ffmpeg_missing' : code, result.code === 'tool_missing' ? 'Не найден ffmpeg.' : 'Не удалось собрать изображение.');
    }
    return outPath;
  }

  // The subject (pixels inside `box`, or the cut-out) is kept as is; everything
  // else becomes a studio backdrop or the supplied background photo.
  async function replaceBackground({ sourcePath, objectPath, box, backdrop, backgroundPath = null, outPath }) {
    const frame = await imageSize(sourcePath);
    const width = even(frame.width);
    const height = even(frame.height);
    const sigma = Math.max(6, Math.round(width / 60));
    const layer = `[0:v]format=rgba,crop=${box.w}:${box.h}:${box.x}:${box.y},split[obj][mask]`;
    const shadow = `[mask]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.36,gblur=sigma=${sigma}[shadow]`;
    const bg = backgroundPath
      ? `[1:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgba[bg]`
      : '[1:v]noise=alls=3:allf=t,format=rgba[bg]';
    const graph = [
      layer, shadow, bg,
      `[bg][shadow]overlay=x=${box.x + Math.round(sigma / 3)}:y=${box.y + Math.round(height * 0.014)}[lit]`,
      `[lit][obj]overlay=x=${box.x}:y=${box.y},format=yuvj420p[out]`,
    ].join(';');
    const second = backgroundPath ? ['-i', backgroundPath] : backdropInput(pickBackdrop(backdrop), width, height, 1, 1);
    return still(['-i', objectPath, ...second, '-filter_complex', graph, '-map', '[out]'], outPath, 'packshot_failed');
  }

  // Places a product photo into `box` without stretching it; the rest of the
  // source is untouched.
  async function insertObject({ sourcePath, referencePath, box, outPath }) {
    const graph = [
      `[1:v]format=rgba,scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease[ref]`,
      `[0:v][ref]overlay=x='${box.x}+(${box.w}-w)/2':y='${box.y}+(${box.h}-h)/2',format=yuvj420p[out]`,
    ].join(';');
    return still(['-i', sourcePath, '-i', referencePath, '-filter_complex', graph, '-map', '[out]'], outPath, 'insert_failed');
  }

  // Fills `box` from its surroundings. Good for a small logo, a date stamp or
  // a spot on a plain surface; it does not invent detail.
  async function eraseArea({ sourcePath, box, outPath }) {
    const frame = await imageSize(sourcePath);
    const x = Math.max(1, box.x);
    const y = Math.max(1, box.y);
    const w = Math.min(box.w, frame.width - x - 1);
    const h = Math.min(box.h, frame.height - y - 1);
    if (w < 2 || h < 2) throw new StudioError('invalid_mask', 'Область слишком мала.');
    return still(['-i', sourcePath, '-vf', `delogo=x=${x}:y=${y}:w=${w}:h=${h},format=yuvj420p`], outPath, 'erase_failed');
  }

  return { engine: 'studio', renderScene, imageSize, replaceBackground, insertObject, eraseArea };
}

function listBackdrops() {
  return Object.entries(BACKDROPS).map(([id, tone]) => ({ id, label: tone.label }));
}

module.exports = { createStudio, listBackdrops, pickBackdrop, motion, shadowShape, packshotArgs, fullFrameArgs, BACKDROPS, CAMERAS, StudioError };

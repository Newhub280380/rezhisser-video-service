'use strict';

// The renderer: one photo in, one finished film out.
//
// Everything is ffmpeg, so the same photo always gives the same reel and a
// twenty-clip order does not need a GPU. A template only says how many shots,
// how long and what the camera does; this file turns that into filters.
//
// Usage:
//   node app/render.mjs --photo photo.png --template paragon --title "Sagitta" --out out

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { get } = require('./templates.js');

const MOODS = {
  dark: { from: '0x14181f', to: '0x30363f', title: 'white' },
  light: { from: '0xdad6cf', to: '0xb8b2a8', title: '0x14181f' },
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function ffmpeg(args, label) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${label}: ${String(result.stderr || '').slice(0, 400)}`);
  }
}

function hasAlpha(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return /yuva|rgba|bgra|argb|abgr|ya/i.test(String(probe.stdout || ''));
}

// A 4K frame: subject on a studio gradient, fitted inside 82% of the canvas so
// a camera move has room and nothing is cropped.
function still(photo, template, target) {
  const mood = MOODS[template.mood] || MOODS.dark;
  const { width, height } = template.size;
  const gradient = `gradients=s=${width}x${height}:c0=${mood.from}:c1=${mood.to}:x0=0:y0=0:x1=${width}:y1=${height}`;
  const fitW = Math.round(width * 0.82);
  const fitH = Math.round(height * 0.82);
  ffmpeg([
    '-f', 'lavfi', '-i', gradient,
    '-i', photo,
    '-filter_complex', `[1:v]scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2:format=auto`,
    '-frames:v', '1', '-q:v', '2', target,
  ], 'кадр');
  return target;
}

// One shot: the still is held for N seconds while the camera moves across it.
// zoompan is the whole trick — no re-render of the photo per frame.
function shot(source, spec, template, target) {
  const { width, height } = template.size;
  const frames = Math.round(spec.seconds * template.fps);
  const moves = {
    push: `z='min(zoom+0.0012,1.15)'`,
    pull: `z='if(lte(zoom,1.001),1.15,max(1.001,zoom-0.0012))'`,
    pan: `z=1.08:x='(iw-iw/zoom)*on/${frames}':y='(ih-ih/zoom)/2'`,
    tilt: `z=1.08:x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*on/${frames}'`,
    hold: `z=1.0`,
  };
  const move = moves[spec.camera] || moves.hold;
  const filter = `zoompan=${move}:d=${frames}:s=${width}x${height}:fps=${template.fps}`;
  ffmpeg([
    '-loop', '1', '-i', source, '-t', String(spec.seconds), '-r', String(template.fps),
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    target,
  ], `кадр ${spec.camera}`);
  return target;
}

// Titles are drawn on the assembled film, not on each shot, so the caption does
// not disappear at a cut.
function withTitle(input, template, text, target) {
  if (!text) {
    fs.copyFileSync(input, target);
    return target;
  }
  const mood = MOODS[template.mood] || MOODS.dark;
  const { width, height } = template.size;
  const size = template.title.size;
  const y = template.title.position === 'top' ? Math.round(height * 0.08) : template.title.position === 'center' ? '(h-text_h)/2' : `h-text_h-${Math.round(height * 0.1)}`;
  const safe = String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const font = 'C\\:/Windows/Fonts/segoeuib.ttf';
  ffmpeg([
    '-i', input,
    '-vf', `drawtext=fontfile='${font}':text='${safe}':fontcolor=${mood.title}:fontsize=${size}:x=(w-text_w)/2:y=${y}:alpha='if(lt(t,${template.title.fadeIn}),t/${template.title.fadeIn},1)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
    target,
  ], 'титр');
  return target;
}

function render({ photo, template: templateId, title = '', outDir = 'out' }) {
  if (!photo || !fs.existsSync(photo)) throw new Error(`нет фото: ${photo}`);
  const template = get(templateId);
  const work = path.join(outDir, 'work', path.basename(photo, path.extname(photo)));
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();

  const frame = still(photo, template, path.join(work, 'frame.jpg'));
  const clips = template.shots.map((spec, index) => shot(frame, spec, template, path.join(work, `shot-${String(index + 1).padStart(2, '0')}.mp4`)));

  const listFile = path.join(work, 'concat.txt');
  // Paths in the list are resolved against the list file, not the working
  // directory, so they have to be absolute.
  fs.writeFileSync(listFile, clips.map((file) => `file '${path.resolve(file).replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const joined = path.join(work, 'joined.mp4');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined], 'склейка');

  const name = `${path.basename(photo, path.extname(photo))}-${template.id}.mp4`;
  fs.mkdirSync(outDir, { recursive: true });
  const final = withTitle(joined, template, title, path.join(outDir, name));

  const seconds = template.shots.reduce((sum, s) => sum + s.seconds, 0);
  return {
    path: final,
    template: template.id,
    seconds,
    shots: template.shots.length,
    size: { ...template.size },
    alpha: hasAlpha(photo),
    ms: Date.now() - started,
  };
}

if (require.main === module) {
  try {
    const result = render({
      photo: arg('photo'),
      template: arg('template', 'paragon'),
      title: arg('title', ''),
      outDir: arg('out', 'out'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`ошибка: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { render, MOODS };

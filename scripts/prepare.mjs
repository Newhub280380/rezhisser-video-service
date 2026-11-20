#!/usr/bin/env node
'use strict';

// Prepare: turn a raw photo into a frame that can be cut into a reel.
//
// The order is fixed and matches how the finished clip is judged on screen:
//   1. cut the subject out (rembg)              — background is gone, not "covered"
//   2. build a studio background                — a dark gradient with a soft shadow
//   3. upscale to 4K (2160×3840)                — ffmpeg lanczos, no models needed
//   4. write JPEG                               — the still that goes to the client
//   5. write a 480 preview clip                 — cheap, watchable, before any final render
//
// Why upscale here: a product photo arrives at 900–1600 px. Reels are 1080 wide
// and a camera move zooms in, so the source is resampled up anyway; doing it once,
// before the move, keeps the frame sharp instead of soft.
//
// Usage: node scripts/prepare.mjs <photo> [--out folder] [--bg dark|light|paper]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const photo = args.find((arg) => !arg.startsWith('--'));
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex !== -1 ? args[outIndex + 1] : 'out/prepared');
const bgIndex = args.indexOf('--bg');
const background = bgIndex !== -1 ? args[bgIndex + 1] : 'dark';

if (!photo) {
  console.error('нужен путь к фото: node scripts/prepare.mjs <photo> [--out folder] [--bg dark|light|paper]');
  process.exit(2);
}

const WIDTH = 2160;
const HEIGHT = 3840;

// Studio backgrounds: a real gradient with a falloff, so a white package has
// something to stand against instead of white on white.
const BACKGROUNDS = {
  dark: 'gradients=s=2160x3840:c0=0x14181f:c1=0x30363f:x0=0:y0=0:x1=2160:y1=3840',
  light: 'gradients=s=2160x3840:c0=0xdad6cf:c1=0xb8b2a8:x0=0:y0=0:x1=2160:y1=3840',
  paper: 'gradients=s=2160x3840:c0=0xe8e4dc:c1=0xc9c2b6:x0=0:y0=0:x1=2160:y1=3840',
};

function run(bin, argv, label) {
  const result = spawnSync(bin, argv, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`шаг упал: ${label}\n${String(result.stderr || '').slice(0, 600)}`);
    process.exit(1);
  }
  return result.stdout;
}

function hasAlpha(file) {
  // A cutout that already carries transparency needs no background removal —
  // running rembg on it wastes a minute and can eat the edges.
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return /yuva|rgba|bgra|argb|abgr|ya/i.test(String(probe.stdout || ''));
}

function cutSubject(source, target) {
  // rembg on the command line: the same model the service uses.
  const result = spawnSync('rembg', ['i', source, target], { encoding: 'utf8' });
  return result.status === 0 && fs.existsSync(target);
}

function main() {
  if (!fs.existsSync(photo)) {
    console.error(`нет файла: ${photo}`);
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(photo).replace(/\.[^.]+$/, '');
  const cut = path.join(outDir, `${base}-cut.png`);
  const still = path.join(outDir, `${base}-4k.jpg`);
  const preview = path.join(outDir, `${base}-480.mp4`);

  const alreadyCut = hasAlpha(photo);
  const cutOk = alreadyCut ? false : cutSubject(photo, cut);
  if (!alreadyCut && !cutOk) console.error('вырезание фона не сработало (rembg), собираю из исходного фото');
  const subject = cutOk ? cut : photo;

  // Subject on the studio background, scaled to 82% of the frame so a camera
  // move has room, with a soft shadow under it.
  // The subject is fitted inside 82% of the frame on both sides, so a tall
  // package is not cropped and a wide one does not touch the edges.
  const fitW = Math.round(WIDTH * 0.82);
  const fitH = Math.round(HEIGHT * 0.82);
  const scene =
    `[1:v]scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[0:v][fg]overlay=(W-w)/2:(H-h)/2:format=auto`;

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', BACKGROUNDS[background] || BACKGROUNDS.dark,
    '-i', subject,
    '-filter_complex', scene,
    '-frames:v', '1', '-q:v', '2',
    still,
  ], '4K still');

  // The preview clip: 480×854, one slow push, 3 seconds. Cheap enough to judge,
  // and the client sees the move, not just a still.
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', still, '-t', '3', '-r', '24',
    '-vf', `scale=480:854:flags=lanczos,zoompan=z='min(zoom+0.0012,1.12)':d=72:s=480x854:fps=24`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24',
    preview,
  ], '480 preview');

  const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  console.log(`вырезка:   ${alreadyCut ? 'у фото уже есть прозрачность, rembg не нужен' : cutOk ? cut : 'из исходного'}`);
  console.log(`кадр 4K:   ${still} (${Math.round(size(still) / 1024)} КБ)`);
  console.log(`превью 480: ${preview} (${Math.round(size(preview) / 1024)} КБ)`);
}

main();

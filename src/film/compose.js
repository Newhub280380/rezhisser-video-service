'use strict';

// Final assembly: scene clips -> one MP4 with subtitles and an audio mix.
//
// * Order and completeness: clips are taken in scene order; a missing file is an
//   error, never a shorter film.
// * Frame: every clip is scaled and padded to the film's exact output size and
//   frame rate, so 480p and upscaled clips can be mixed and a vertical film
//   stays vertical.
// * Audio: chosen music (looped, trimmed to the film length, faded) and/or a
//   voiceover; with both, the music is ducked under the voice. With neither,
//   the scenes' own audio is kept when every clip has an audio stream.
//
// ffmpeg runs with a fixed argv and no shell, with the job folder as its
// working directory: the subtitle file is referenced by a bare name, so no
// buyer text and no OS path ever needs escaping inside a filter graph.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SRT_NAME = 'subtitles.srt';

class ComposeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
  }
}

function srtTime(seconds) {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const ms = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)},${pad(ms, 3)}`;
}

// One cue per scene at the scene's own time. On-screen text wins; the
// voiceover line is used only when a scene has no on-screen text.
function buildSubtitles(plan, { includeVoiceover = true } = {}) {
  const cues = [];
  let cursor = 0;
  for (const scene of plan.scenes) {
    const start = cursor;
    cursor += scene.durationSeconds;
    const text = String(scene.onScreenText || (includeVoiceover ? scene.voiceover : '') || '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ index: cues.length + 1, start, end: cursor, text });
  }
  const srt = cues.map((cue) => `${cue.index}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
  return { srt, count: cues.length, cues };
}

const STEREO = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

// Builds the complete ffmpeg argv. `clips`: [{ path, hasAudio }] in scene order.
function buildAssemblyArgs({
  clips,
  outputPath,
  width,
  height,
  fps = 24,
  seconds,
  subtitles = false,
  music = null,
  voice = null,
  musicVolume = 0.7,
  fadeSeconds = 1.5,
  crf = 18,
  preset = 'medium',
}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new ComposeError('no_clips', 'Нет клипов для сборки.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new ComposeError('invalid_size', 'Не задан размер кадра.');
  }
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) throw new ComposeError('invalid_duration', 'Неизвестна длительность ролика.');

  const args = ['-y'];
  for (const clip of clips) args.push('-i', clip.path);
  let musicIndex = null;
  let voiceIndex = null;
  if (music) {
    musicIndex = clips.length;
    // A short track is looped; `atrim` below cuts it to the film length.
    args.push('-stream_loop', '-1', '-i', music.path);
  }
  if (voice) {
    voiceIndex = clips.length + (music ? 1 : 0);
    args.push('-i', voice.path);
  }

  const graph = [];
  clips.forEach((clip, i) => {
    graph.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  });
  graph.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vcat]`);
  graph.push(subtitles ? `[vcat]subtitles=${SRT_NAME}[vout]` : '[vcat]null[vout]');

  const fade = Math.min(fadeSeconds, total / 4);
  let audioLabel = null;
  let audioMode = 'none';
  if (music) {
    graph.push(
      `[${musicIndex}:a]${STEREO},loudnorm=I=-16:TP=-1.5:LRA=11,atrim=0:${total},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, total - fade)}:d=${fade},volume=${musicVolume}[music]`,
    );
  }
  if (voice) {
    // Padded with silence so the mix always lasts the whole film.
    graph.push(`[${voiceIndex}:a]${STEREO},loudnorm=I=-14:TP=-1.0:LRA=9,apad,atrim=0:${total},asetpts=PTS-STARTPTS[voice]`);
  }
  if (music && voice) {
    // The voice is used twice (as the ducking key and in the mix).
    graph.push('[voice]asplit=2[vkey][vmix]');
    graph.push('[music][vkey]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[ducked]');
    graph.push('[ducked][vmix]amix=inputs=2:duration=first:normalize=0[aout]');
    audioLabel = '[aout]';
    audioMode = 'music+voice';
  } else if (music) {
    audioLabel = '[music]';
    audioMode = 'music';
  } else if (voice) {
    audioLabel = '[voice]';
    audioMode = 'voice';
  } else if (clips.every((clip) => clip.hasAudio)) {
    clips.forEach((clip, i) => graph.push(`[${i}:a]${STEREO}[a${i}]`));
    graph.push(`${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[scene]`);
    audioLabel = '[scene]';
    audioMode = 'scene-audio';
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (audioLabel) args.push('-map', audioLabel, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);
  return { args, audioMode };
}

function run(bin, args, { cwd, timeoutMs = 3600000, capture = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    } catch {
      resolve({ ok: false, code: 'tool_missing', stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    if (capture) child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', () => finish({ ok: false, code: 'tool_missing', stdout, stderr }));
    child.on('close', (status) => finish({ ok: status === 0, code: status === 0 ? 'ok' : 'process_failed', stdout, stderr }));
  });
}

function createComposer({
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  workDir,
  fps = 24,
  crf = 18,
  preset = 'medium',
  burnSubtitles = true,
  runner = run,
} = {}) {
  async function hasAudio(file) {
    const res = await runner(ffprobeBin, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], {
      timeoutMs: 30000,
      capture: true,
    });
    return Boolean(res.ok && String(res.stdout || '').trim());
  }

  async function probeDuration(file) {
    const res = await runner(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      timeoutMs: 30000,
      capture: true,
    });
    const value = Number.parseFloat(String(res.stdout || '').trim());
    return res.ok && Number.isFinite(value) && value > 0 ? value : null;
  }

  // clips: [{ scene, path }]; size: { width, height }; seconds: film length.
  async function assemble({ jobId, clips, size, seconds, srt = '', music = null, voice = null, frameRate = fps }) {
    if (!Array.isArray(clips) || clips.length === 0) throw new ComposeError('no_clips', 'Нет клипов для сборки.');
    for (const clip of clips) {
      if (!clip || typeof clip.path !== 'string' || !fs.existsSync(clip.path)) {
        throw new ComposeError('missing_clip', `Клип сцены ${clip ? clip.scene : '?'} не найден.`);
      }
    }
    const dir = path.join(workDir, String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    const withSubtitles = Boolean(burnSubtitles && srt);
    if (withSubtitles) fs.writeFileSync(path.join(dir, SRT_NAME), srt, 'utf8');
    const probed = [];
    for (const clip of clips) {
      // Scene audio matters only when no music or voice replaces it.
      probed.push({ path: path.resolve(clip.path), hasAudio: music || voice ? false : await hasAudio(clip.path) });
    }
    const outputPath = path.join(dir, 'final.mp4');
    const { args, audioMode } = buildAssemblyArgs({
      clips: probed,
      outputPath,
      width: size.width,
      height: size.height,
      fps: frameRate,
      seconds,
      subtitles: withSubtitles,
      music: music ? { path: path.resolve(music.path) } : null,
      voice: voice ? { path: path.resolve(voice.path) } : null,
      crf,
      preset,
    });
    const result = await runner(ffmpegBin, args, { cwd: dir });
    if (!result.ok || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new ComposeError(
        result.code === 'tool_missing' ? 'ffmpeg_missing' : 'ffmpeg_failed',
        result.code === 'tool_missing' ? 'Не найден ffmpeg: сборка невозможна.' : `Сборка не удалась: ${String(result.stderr || '').slice(-300)}`,
      );
    }
    return { path: outputPath, bytes: fs.statSync(outputPath).size, audioMode, subtitles: withSubtitles };
  }

  return { assemble, hasAudio, probeDuration };
}

module.exports = { createComposer, buildSubtitles, buildAssemblyArgs, srtTime, run, ComposeError, SRT_NAME };

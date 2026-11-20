'use strict';

// Voiceover: a script read out loud, with the exact time of every sentence.
//
// Why the voice comes first: a reel with narration has to be cut to the voice,
// not the voice squeezed into fixed 5-second scenes. This module turns
// "sentence per line" into an audio file plus cue times, and the film pipeline
// then makes one scene per sentence with the length the voice actually takes.
//
// Engine: edge-tts (free, no key) — the CLI of the `edge-tts` package. It gives
// a sentence-level .srt next to the audio, which is exactly what scene timing
// needs. Two things were measured on this host and are handled here:
//
//   * the service drops requests: some lines return "No audio received".
//     Synthesis therefore retries, then falls back to another voice;
//   * the version matters (an older one fails outright).
//
// Edge TTS is Microsoft's read-aloud service used without a contract. That is
// fine for personal work; for paying clients an operator should switch to Azure
// Speech (same voices, a proper key). The interface below is what such a switch
// replaces — nothing else in the pipeline knows which engine spoke.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./compose.js');
const { cleanText } = require('./schema.js');

const MAX_TEXT = 4000;
const MAX_SCENES = 36;
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,3}-[A-Za-z]{2,40}Neural$/;
const DEFAULT_VOICE = 'ru-RU-SvetlanaNeural';
const FALLBACK_VOICE = 'ru-RU-DmitryNeural';
// A line the service refuses once usually goes through on a retry; measured
// rate on ru-RU voices is roughly one refusal in three.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VoiceError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
    this.status = code === 'voice_unavailable' ? 503 : 400;
    if (field) this.field = field;
  }
}

// "00:00:02,897 --> 00:00:07,341" -> { start: 2.897, end: 7.341 }
function parseTime(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))) / 1000;
}

// Reads the sentence-level SRT edge-tts writes next to the audio.
function parseCues(srt) {
  const cues = [];
  const blocks = String(srt || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timing = lines.find((line) => line.includes('-->'));
    if (!timing) continue;
    const [from, to] = timing.split('-->').map(parseTime);
    const text = lines.slice(lines.indexOf(timing) + 1).join(' ').trim();
    if (from === null || to === null || !text) continue;
    cues.push({ start: from, end: to, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function srtOf(cues) {
  const time = (value) => {
    const ms = Math.round(value * 1000);
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  return cues.map((cue, index) => `${index + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${cue.text}\n`).join('\n');
}

// Turns cue times into scene lengths: one scene per cue, each ending where the
// next begins, the last one running to the end of the audio. Durations are kept
// inside what the plan schema accepts (2–10 s), so a very long sentence is
// split into two scenes rather than producing an invalid plan.
function sceneTimings(cues, { audioSeconds = 0, min = 2, max = 10 } = {}) {
  if (!cues.length) return [];
  const end = Math.max(audioSeconds, cues[cues.length - 1].end);
  const scenes = [];
  for (let i = 0; i < cues.length; i += 1) {
    const start = i === 0 ? 0 : cues[i].start;
    const stop = i === cues.length - 1 ? end : Math.max(cues[i + 1].start, cues[i].end);
    // The full spoken length, never shortened: a sentence longer than the
    // schema allows becomes several scenes of equal length, so the picture
    // keeps changing while the voice keeps talking.
    const length = Math.max(min, stop - start);
    const parts = Math.max(1, Math.ceil(length / max));
    for (let part = 0; part < parts; part += 1) {
      scenes.push({
        start: Math.round((start + (length / parts) * part) * 1000) / 1000,
        durationSeconds: Math.round((length / parts) * 100) / 100,
        text: cues[i].text,
      });
    }
    if (scenes.length >= MAX_SCENES) break;
  }
  return scenes;
}

function normalizeScript(value) {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return lines
    .map((line) => cleanText(String(line), 300))
    .filter(Boolean)
    .slice(0, MAX_SCENES)
    .join('\n');
}

function createVoice({
  bin = 'edge-tts',
  workDir,
  defaultVoice = DEFAULT_VOICE,
  fallbackVoice = FALLBACK_VOICE,
  rate = '+0%',
  timeoutMs = 180000,
  runner = run,
  exists = (file) => fs.existsSync(file),
  local = null,
} = {}) {
  // Detected once: a missing CLI is a capability answer, not a crash per job.
  let available = null;
  async function probe() {
    if (available !== null) return available;
    const result = await runner(bin, ['--version'], { timeoutMs: 20000, capture: true });
    available = Boolean(result.ok);
    return available;
  }

  function capability() {
    return {
      engine: 'edge-tts',
      configured: Boolean(workDir),
      bin,
      voices: [defaultVoice, fallbackVoice],
      // Spoken when edge-tts refuses: the system engine needs no network.
      fallback: local ? local.capability() : null,
      note: 'бесплатный голос Microsoft через edge-tts; для коммерческих заказов лучше Azure Speech',
      missing: workDir ? [] : ['FILM_WORK_DIR'],
    };
  }

  function voiceOr(defaultValue, value) {
    const candidate = String(value || '').trim();
    return VOICE_PATTERN.test(candidate) ? candidate : defaultValue;
  }

  // One synthesis attempt. Returns null on "no audio" instead of throwing, so
  // the caller can retry with another voice.
  async function attempt(text, voice, dir, tag) {
    const media = path.join(dir, `voice-${tag}.mp3`);
    const subs = path.join(dir, `voice-${tag}.srt`);
    const source = path.join(dir, `voice-${tag}.txt`);
    // The text goes through a file: no quoting issues, no command-line limit.
    fs.writeFileSync(source, text, 'utf8');
    const result = await runner(bin, ['--voice', voice, '--file', source, '--rate', rate, '--write-media', media, '--write-subtitles', subs], { timeoutMs });
    if (!result.ok || !exists(media) || fs.statSync(media).size === 0) {
      fs.rmSync(media, { force: true });
      fs.rmSync(subs, { force: true });
      return null;
    }
    return { media, subs: exists(subs) ? subs : null };
  }

  // text -> { path, voice, cues, srt }. Throws VoiceError with the reason.
  // `voice` is the voice name; `tag` names the folder (a job id, usually).
  async function speak(text, { userId, voice: wanted, tag, fallback } = {}) {
    if (!workDir) throw new VoiceError('voice_unavailable', 'Озвучка не настроена: не задан рабочий каталог.');
    const raw = Array.isArray(text) ? text.join('\n') : String(text || '');
    if (raw.length > MAX_TEXT) throw new VoiceError('script_too_long', `Текст озвучки до ${MAX_TEXT} символов.`, 'voiceover');
    const script = normalizeScript(text);
    if (!script) throw new VoiceError('script_required', 'Введите текст озвучки: одна фраза на строку.', 'voiceover');
    // The offline engine is the safety net: it speaks when edge-tts is missing
    // or has stopped answering, so a job is not lost to a remote service.
    const localReady = local ? await local.probe() : false;
    if (!(await probe()) && !localReady) throw new VoiceError('voice_unavailable', 'Не найден edge-tts: установите его (pip install edge-tts), чтобы включить озвучку.');

    const dir = path.join(workDir, String(userId || 'anon'), tag ? String(tag) : crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const nonce = crypto.randomBytes(4).toString('hex');
    const primary = voiceOr(defaultVoice, wanted);
    const voices = fallback === false ? [primary] : [...new Set([primary, voiceOr(fallbackVoice, null)])];
    if (await probe()) {
      for (const voice of voices) {
        for (let attemptNo = 0; attemptNo < ATTEMPTS; attemptNo += 1) {
          const made = await attempt(script, voice, dir, `${nonce}-${voice.slice(-8)}-${attemptNo}`);
          if (made) {
            const cues = made.subs ? parseCues(fs.readFileSync(made.subs, 'utf8')) : [];
            return {
              path: made.media,
              voice,
              bytes: fs.statSync(made.media).size,
              cues,
              srt: cues.length ? srtOf(cues) : '',
            };
          }
          await sleep(RETRY_DELAY_MS * (attemptNo + 1));
        }
      }
    }

    if (localReady) {
      const spoken = await local.speak(script.split('\n'), { dir, tag: nonce });
      if (spoken) {
        return {
          path: spoken.path,
          voice: spoken.voice,
          bytes: spoken.bytes,
          cues: spoken.cues,
          srt: spoken.cues.length ? srtOf(spoken.cues) : '',
        };
      }
    }
    throw new VoiceError('voice_failed', 'Сервис озвучки не ответил. Попробуйте ещё раз через минуту.');
  }

  return { capability, speak, parseCues, sceneTimings, probe };
}

module.exports = { createVoice, parseCues, srtOf, sceneTimings, normalizeScript, VoiceError, DEFAULT_VOICE, FALLBACK_VOICE };

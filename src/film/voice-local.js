'use strict';

// Local voiceover: the system speech engine, no network.
//
// Why it exists: edge-tts (see voice.js) is free but the service drops requests
// and can stop answering altogether — measured on this host, five attempts in a
// row returned no audio, and the retries inside voice.js cannot fix a service
// that answers nothing. Windows already has Russian voices installed
// (Microsoft Irina, Microsoft Pavel), so the pipeline keeps working offline.
//
// Timing: each line is synthesised to its own wav, so every sentence gets its
// exact spoken length instead of an estimate. Scene timing is then as precise
// as with edge-tts, which reports sentence marks itself.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./compose.js');

const SAMPLE_RATE = 22050;
const GAP_MS = 120;
const MAX_LINES = 36;
const DEFAULT_VOICE = 'Microsoft Irina';

// The same dialog edge-tts produces: sentence per line, exact window per line.
// Durations come from the files themselves, so the cues follow the real audio.
function buildCues(durations, { gapMs = GAP_MS } = {}) {
  const gap = gapMs / 1000;
  const cues = [];
  let cursor = 0;
  for (const { text, seconds } of durations) {
    const start = cursor;
    const end = start + seconds;
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
    cursor = end + gap;
  }
  return cues;
}

// ffmpeg concatenates equal-format wavs listed in a text file; the list needs
// the gap between lines, otherwise sentences run into one another.
function concatList(parts) {
  return parts
    .map((file) => `file '${String(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
}

function createLocalVoice({
  platform = process.platform,
  shellBin = null,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  voice = DEFAULT_VOICE,
  gapMs = GAP_MS,
  timeoutMs = 180000,
  runner = run,
  exists = (file) => fs.existsSync(file),
} = {}) {
  // Only Windows ships a speech engine with Russian voices; elsewhere the
  // engine simply reports itself as unavailable and voice.js keeps its answer.
  const supported = platform === 'win32';
  const shell = shellBin || 'powershell';
  let available = null;

  // One process speaks every line, so a 36-line script costs one start-up.
  // The path parameter is deliberately not called $Lines: PowerShell ignores
  // case, and assigning an array to a [string] parameter joins it into one line.
  const script = `
param([string]$LinesPath, [string]$OutDir, [string]$Voice)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -Path $LinesPath -Raw -Encoding UTF8 | ConvertFrom-Json
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $syn.SelectVoice($Voice) } catch { }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$i = 0
foreach ($line in $items) {
  $i = $i + 1
  $file = Join-Path $OutDir ("line-{0:D2}.wav" -f $i)
  $syn.SetOutputToWaveFile($file, $fmt)
  $syn.Speak([string]$line)
}
$syn.SetOutputToNull()
$syn.Dispose()
Write-Output $i
`;

  async function probe() {
    if (available !== null) return available;
    if (!supported) {
      available = false;
      return available;
    }
    const result = await runner(shell, ['-NoProfile', '-Command', 'if (Get-Command Add-Type) { "ok" }'], { timeoutMs: 20000, capture: true });
    available = Boolean(result.ok && String(result.stdout || '').includes('ok'));
    return available;
  }

  function capability() {
    return {
      engine: 'system-speech',
      configured: supported,
      voice,
      note: 'локальный голос Windows, без сети; звучит проще, чем edge-tts',
      missing: supported ? [] : ['системный синтез речи доступен только в Windows'],
    };
  }

  async function duration(file) {
    const result = await runner(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30000, capture: true });
    const seconds = Number.parseFloat(String(result.stdout || '').trim());
    return result.ok && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  // lines -> { path, voice, bytes, cues }. Returns null when the engine could
  // not speak, so the caller keeps its own error message.
  async function speak(lines, { dir, tag } = {}) {
    if (!supported || !lines.length) return null;
    if (!(await probe())) return null;
    const work = path.join(dir, `local-${tag || crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(work, { recursive: true });
    const linesFile = path.join(work, 'lines.json');
    fs.writeFileSync(linesFile, JSON.stringify(lines.slice(0, MAX_LINES)), 'utf8');
    const scriptFile = path.join(work, 'speak.ps1');
    fs.writeFileSync(scriptFile, script, 'utf8');

    const spoken = await runner(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-LinesPath', linesFile, '-OutDir', work, '-Voice', voice], { timeoutMs });
    if (!spoken.ok) return null;

    const parts = [];
    const measured = [];
    for (let i = 1; i <= lines.length; i += 1) {
      const file = path.join(work, `line-${String(i).padStart(2, '0')}.wav`);
      if (!exists(file) || fs.statSync(file).size === 0) return null;
      const seconds = await duration(file);
      if (seconds === null) return null;
      parts.push(file);
      measured.push({ text: lines[i - 1], seconds });
    }

    // The gap between sentences is one short silent wav of the same format.
    const silence = path.join(work, 'silence.wav');
    const made = await runner(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`, '-t', String(gapMs / 1000), '-c:a', 'pcm_s16le', silence], { timeoutMs: 60000 });
    if (!made.ok || !exists(silence)) return null;

    const sequence = [];
    parts.forEach((file, index) => {
      sequence.push(file);
      if (index < parts.length - 1) sequence.push(silence);
    });
    const listFile = path.join(work, 'concat.txt');
    fs.writeFileSync(listFile, concatList(sequence), 'utf8');
    const out = path.join(work, 'voice.mp3');
    const encoded = await runner(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '5', out], { timeoutMs });
    if (!encoded.ok || !exists(out) || fs.statSync(out).size === 0) return null;

    return {
      path: out,
      voice,
      bytes: fs.statSync(out).size,
      cues: buildCues(measured, { gapMs }),
    };
  }

  return { capability, probe, speak, buildCues };
}

module.exports = { createLocalVoice, buildCues, concatList, DEFAULT_VOICE, GAP_MS };

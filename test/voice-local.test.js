'use strict';

// Offline voice: the parts that must hold on any host (cue maths, list format,
// reporting itself unavailable off Windows) plus one real synthesis on Windows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLocalVoice, buildCues, concatList, GAP_MS } = require('../src/film/voice-local.js');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('cues follow the measured lengths and leave a gap between sentences', () => {
  const cues = buildCues([
    { text: 'Первая.', seconds: 2 },
    { text: 'Вторая.', seconds: 3 },
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 2, text: 'Первая.' },
    { start: 2 + GAP_MS / 1000, end: 5 + GAP_MS / 1000, text: 'Вторая.' },
  ]);
});

test('cue times are rounded to milliseconds so the srt is stable', () => {
  const cues = buildCues([{ text: 'Точная.', seconds: 1.23456 }]);
  assert.equal(cues[0].end, 1.235);
});

test('a changed gap moves every start after the first line', () => {
  const cues = buildCues(
    [
      { text: 'Раз.', seconds: 1 },
      { text: 'Два.', seconds: 1 },
    ],
    { gapMs: 500 },
  );
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].start, 1.5);
});

test('the concat list uses slashes ffmpeg accepts and escapes quotes', () => {
  const list = concatList(['C:\\tmp\\a b\\line-01.wav', "C:\\tmp\\it's\\line-02.wav"]);
  assert.equal(list.split('\n')[0], "file 'C:/tmp/a b/line-01.wav'");
  // A quote inside the path must not end the entry early.
  assert.ok(list.split('\n')[1].startsWith("file 'C:/tmp/it'"));
  assert.ok(list.split('\n')[1].endsWith("line-02.wav'"));
});

test('off Windows the engine reports itself unavailable instead of failing late', async () => {
  const local = createLocalVoice({ platform: 'linux' });
  assert.equal(await local.probe(), false);
  assert.equal(local.capability().configured, false);
  assert.equal(await local.speak(['Текст.'], { dir: os.tmpdir() }), null);
});

test('one real synthesis: exact cues, one mp3', { skip: !(process.platform === 'win32' && HAS_FFMPEG && HAS_FFPROBE), timeout: 180000 }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-local-'));
  const local = createLocalVoice({ voice: 'Microsoft Irina' });
  const spoken = await local.speak(['Кофе в Алматы начинается с утра.', 'Приходите до десяти.'], { dir: workDir, tag: 'test' });

  assert.ok(spoken, 'engine spoke');
  assert.equal(spoken.cues.length, 2);
  assert.equal(spoken.cues[0].text, 'Кофе в Алматы начинается с утра.');
  assert.equal(spoken.cues[0].start, 0);
  assert.ok(spoken.cues[1].start > spoken.cues[0].end, 'second line starts after the first ends');
  assert.ok(spoken.bytes > 1000, 'mp3 has audio');
  assert.deepEqual(spoken.cues.map((cue) => cue.text), ['Кофе в Алматы начинается с утра.', 'Приходите до десяти.']);
});

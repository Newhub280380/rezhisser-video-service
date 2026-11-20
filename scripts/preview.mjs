#!/usr/bin/env node
'use strict';

// Preview: a local page with every rendered reel, so a clip is watched and
// approved before it goes to a client or a social network.
//
// Usage: node scripts/preview.mjs [folder] [--open]
//   folder  where the mp4s are (default: ./out)
//   --open  open the page in the default browser
//
// The page is a single self-contained html: no server, no dependencies. Each
// clip gets a player, its numbers (size, duration, date) and two buttons that
// remember the verdict in the browser (localStorage) — approving is a review
// action, nothing is uploaded anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const openAfter = args.includes('--open');
const folder = path.resolve(args.find((arg) => !arg.startsWith('--')) || 'out');

function duration(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const seconds = Number.parseFloat(String(probe.stdout || '').trim());
  return Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : null;
}

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return /\.(mp4|webm|mov)$/i.test(entry.name) ? [full] : [];
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const clips = collect(folder).map((file) => {
  const stat = fs.statSync(file);
  return {
    name: path.relative(folder, file),
    // A file:// page can play a file next to it by relative path.
    src: encodeURI(path.relative(folder, file).split(path.sep).join('/')),
    mb: Math.round((stat.size / 1048576) * 10) / 10,
    seconds: duration(file),
    date: stat.mtime.toLocaleString('ru-RU'),
  };
});

const cards = clips
  .map(
    (clip, index) => `
    <article class="card" data-key="${escapeHtml(clip.name)}">
      <video src="${clip.src}" controls preload="metadata" playsinline></video>
      <div class="meta">
        <div class="title">${escapeHtml(clip.name)}</div>
        <div class="nums">${clip.seconds === null ? 'длительность неизвестна' : clip.seconds.toFixed(1) + ' с'} · ${clip.mb} МБ · ${escapeHtml(clip.date)}</div>
      </div>
      <div class="verdict">
        <button class="ok" data-vote="ok">Утвердить</button>
        <button class="no" data-vote="no">Отклонить</button>
        <span class="state"></span>
      </div>
    </article>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Режиссёр — просмотр роликов</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #101216; color: #e8e8ea; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 21px; font-weight: 600; letter-spacing: .2px; }
  .count { color: #8b8f98; font-size: 14px; }
  .path { width: 100%; color: #6f747d; font-size: 12px; word-break: break-all; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 18px; }
  .card { background: #171a20; border: 1px solid #23262e; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  .card.approved { border-color: #2f6b45; }
  .card.rejected { border-color: #6b3030; opacity: .75; }
  video { width: 100%; aspect-ratio: 9/16; background: #000; display: block; }
  .meta { padding: 10px 12px 4px; }
  .title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nums { color: #8b8f98; font-size: 12px; margin-top: 3px; }
  .verdict { display: flex; gap: 8px; align-items: center; padding: 10px 12px 12px; }
  button { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #2b2f38; background: #1e222a; color: #e8e8ea; font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { background: #262b35; }
  button[aria-pressed="true"].ok { background: #22503a; border-color: #2f6b45; }
  button[aria-pressed="true"].no { background: #522626; border-color: #6b3030; }
  .state { font-size: 12px; color: #8b8f98; min-width: 66px; text-align: right; }
  .empty { padding: 40px 0; color: #8b8f98; }
</style>
</head>
<body>
<header>
  <h1>Просмотр роликов</h1>
  <span class="count">${clips.length ? `${clips.length} файл(ов)` : 'пока пусто'}</span>
  <span class="path">${escapeHtml(folder)}</span>
</header>
${clips.length ? `<main class="grid">${cards}</main>` : '<div class="empty">В папке нет роликов. Соберите ролик в студии — он появится здесь.</div>'}
<script>
  const store = 'rezhisser-review-v1';
  const votes = JSON.parse(localStorage.getItem(store) || '{}');
  document.querySelectorAll('.card').forEach((card) => {
    const key = card.dataset.key;
    const paint = () => {
      const vote = votes[key];
      card.classList.toggle('approved', vote === 'ok');
      card.classList.toggle('rejected', vote === 'no');
      card.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vote === vote)));
      card.querySelector('.state').textContent = vote === 'ok' ? 'утверждён' : vote === 'no' ? 'отклонён' : '';
    };
    card.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        votes[key] = votes[key] === button.dataset.vote ? null : button.dataset.vote;
        localStorage.setItem(store, JSON.stringify(votes));
        paint();
      });
    });
    paint();
  });
</script>
</body>
</html>`;

const target = path.join(folder, 'preview.html');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(target, html, 'utf8');
console.log(`превью: ${target} (${clips.length} ролик(ов))`);

if (openAfter) {
  spawnSync('cmd', ['/c', 'start', '', target], { stdio: 'ignore' });
}

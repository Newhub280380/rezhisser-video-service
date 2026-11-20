'use strict';

// Local app server: one page, one folder of results.
//
// Deliberately small — no database, no accounts, no build step. It serves the
// page, lists the templates, renders a reel from an uploaded photo and returns
// the file. Everything the studio needs to be usable by a person who is not a
// developer: open, drop a photo, press a button.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { render } = require('./render.cjs');
const templates = require('./templates.js');

const PORT = Number(process.env.PORT || 4100);
const ROOT = path.resolve(__dirname);
const OUT = path.resolve(ROOT, '..', process.env.OUT_DIR || 'out');
const UPLOADS = path.join(OUT, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webm': 'video/webm',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data));
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('файл больше 40 МБ'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Uploaded photos arrive as data urls, so a page can send a dropped file
// without a multipart parser.
function savePhoto(dataUrl, name) {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('нужно изображение');
  const ext = match[1].includes('png') ? '.png' : '.jpg';
  const safe = String(name || 'photo').replace(/[^\w.-]+/g, '_').replace(/\.[^.]+$/, '').slice(0, 40) || 'photo';
  const file = path.join(UPLOADS, `${Date.now()}-${safe}${ext}`);
  fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
  return file;
}

function serveStatic(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, path.join(ROOT, 'index.html'));
    }
    if (req.method === 'GET' && url.pathname === '/api/templates') {
      return json(res, 200, { templates: templates.list(), moods: Object.keys(require('./render.cjs').MOODS) });
    }
    if (req.method === 'GET' && url.pathname === '/api/results') {
      const files = fs.existsSync(OUT)
        ? fs.readdirSync(OUT, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(mp4|webm)$/i.test(entry.name))
            .map((entry) => {
              const stat = fs.statSync(path.join(OUT, entry.name));
              return { name: entry.name, url: `/files/${encodeURIComponent(entry.name)}`, mb: Math.round((stat.size / 1048576) * 10) / 10, at: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.at.localeCompare(a.at))
        : [];
      return json(res, 200, { results: files });
    }
    if (req.method === 'POST' && url.pathname === '/api/render') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const photo = savePhoto(body.photo, body.name);
      const result = render({ photo, template: body.template, title: body.title || '', outDir: OUT });
      return json(res, 200, { ...result, url: `/files/${encodeURIComponent(path.basename(result.path))}` });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const name = decodeURIComponent(url.pathname.slice('/files/'.length));
      return serveStatic(res, path.join(OUT, path.basename(name)));
    }
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Режиссёр: http://127.0.0.1:${PORT}`);
  console.log(`результаты: ${OUT}`);
});

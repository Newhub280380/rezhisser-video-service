'use strict';

// Music and voiceover sources for the final mix: a track from the local
// library, or the audio track of a video page (YouTube by default).
//
// * Links are accepted only for an allowlist of hosts (FILM_AUDIO_HOSTS) over
//   https, with no credentials in the URL. yt-dlp receives the page URL after a
//   `--`, so a link can never be read as an option.
// * A download is stored in the account's own folder and addressed by an id.
//   A job refers to audio by id; a client never supplies or receives a path.
// * The operator is responsible for having the rights to the music used.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cleanText } = require('./schema.js');
const { run } = require('./compose.js');

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.flac'];
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const MAX_LIBRARY_TRACKS = 500;
const DEFAULT_HOSTS = ['youtube.com', 'youtu.be'];
const DOWNLOAD_ID = /^[a-f0-9]{16}$/;
const USER_DIR = /^[A-Za-z0-9-]{1,64}$/;

class AudioError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    if (field) this.field = field;
  }
}

function hostAllowed(hostname, hosts) {
  const host = String(hostname || '').toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function validateSourceUrl(value, hosts = DEFAULT_HOSTS) {
  if (typeof value !== 'string' || !value.trim()) throw new AudioError('invalid_url', 'Нужна ссылка на страницу с аудио.', 'url');
  if (value.length > 2048) throw new AudioError('invalid_url', 'Слишком длинная ссылка.', 'url');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AudioError('invalid_url', 'Ссылка не разбирается.', 'url');
  }
  if (url.protocol !== 'https:') throw new AudioError('invalid_url', 'Разрешены только https-ссылки.', 'url');
  if (url.username || url.password) throw new AudioError('invalid_url', 'Ссылка с логином или паролем запрещена.', 'url');
  if (!hostAllowed(url.hostname, hosts)) {
    throw new AudioError('host_not_allowed', `Аудио по ссылке берётся только с: ${hosts.join(', ')}.`, 'url');
  }
  return url.href;
}

function trackId(name) {
  return crypto.createHash('sha1').update(name).digest('hex').slice(0, 16);
}

function createLibrary(dir) {
  const available = () => Boolean(dir) && fs.existsSync(dir);
  function files() {
    if (!available()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
      .slice(0, MAX_LIBRARY_TRACKS)
      .map((entry) => ({ id: trackId(entry.name), title: path.basename(entry.name, path.extname(entry.name)), file: path.join(dir, entry.name) }));
  }
  return {
    available,
    list: () => files().map(({ id, title }) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
    // Only files this library listed can be resolved.
    resolve: (id) => files().find((track) => track.id === id) || null,
  };
}

function createAudio({
  workDir,
  libraryDir = '',
  ytDlpBin = 'yt-dlp',
  hosts = DEFAULT_HOSTS,
  downloadEnabled = true,
  maxBytes = MAX_AUDIO_BYTES,
  runner = run,
  logger = console,
} = {}) {
  const library = createLibrary(libraryDir);
  const allowedHosts = hosts.map((host) => String(host).toLowerCase()).filter(Boolean);

  function capability() {
    return {
      download: { enabled: downloadEnabled, hosts: allowedHosts, tool: 'yt-dlp' },
      library: { available: library.available(), missing: library.available() ? [] : ['FILM_MUSIC_DIR'] },
    };
  }

  function userDir(userId) {
    if (!workDir || !USER_DIR.test(String(userId))) throw new AudioError('invalid_owner', 'Не удалось определить владельца аудио.');
    return path.join(workDir, String(userId));
  }

  function downloadArgs(url, template) {
    return [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--max-filesize', String(maxBytes),
      '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0',
      '--output', template,
      '--print', 'after_move:title',
      '--', url,
    ];
  }

  // Extracts the audio track of a page into the account folder (m4a).
  async function downloadByUrl(userId, pageUrl) {
    if (!downloadEnabled) throw new AudioError('download_disabled', 'Загрузка аудио по ссылке отключена (FILM_ALLOW_AUDIO_DOWNLOAD=false).');
    const url = validateSourceUrl(pageUrl, allowedHosts);
    const dir = userDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const result = await runner(ytDlpBin, downloadArgs(url, path.join(dir, `${id}.%(ext)s`)), { timeoutMs: 240000, capture: true });
    const file = path.join(dir, `${id}.m4a`);
    if (!result.ok || !fs.existsSync(file)) {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(`${id}.`)) fs.rmSync(path.join(dir, name), { force: true });
      if (result.code === 'tool_missing') throw new AudioError('downloader_missing', 'Не найден yt-dlp: установите его или выберите трек из библиотеки.');
      throw new AudioError('download_failed', 'Не удалось извлечь аудио по этой ссылке.');
    }
    const bytes = fs.statSync(file).size;
    if (bytes === 0 || bytes > maxBytes) {
      fs.rmSync(file, { force: true });
      throw new AudioError('audio_too_large', 'Аудиофайл пустой или больше допустимого размера.');
    }
    const title = cleanText(String(result.stdout || '').trim().split(/\r?\n/).pop(), 120) || 'audio';
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ title }));
    logger.log(`audio extracted: ${bytes} bytes`);
    return { id, title, bytes };
  }

  // { trackId } (library) or { downloadId } (this account's download) -> file.
  function resolve(userId, ref) {
    if (!ref || typeof ref !== 'object') return null;
    if (typeof ref.trackId === 'string' && ref.trackId) {
      const track = library.resolve(ref.trackId);
      if (!track) throw new AudioError('unknown_track', 'Трек не найден в библиотеке.', 'trackId');
      return { source: 'library', title: track.title, path: track.file };
    }
    if (typeof ref.downloadId === 'string' && ref.downloadId) {
      const file = DOWNLOAD_ID.test(ref.downloadId) ? path.join(userDir(userId), `${ref.downloadId}.m4a`) : null;
      if (!file || !fs.existsSync(file)) throw new AudioError('unknown_track', 'Аудио не найдено: загрузите его заново.', 'downloadId');
      let title = 'audio';
      try {
        title = JSON.parse(fs.readFileSync(file.replace(/\.m4a$/, '.json'), 'utf8')).title || title;
      } catch {
        /* the title is cosmetic */
      }
      return { source: 'link', title, path: file };
    }
    return null;
  }

  return { capability, library, downloadByUrl, downloadArgs, resolve, hosts: allowedHosts };
}

module.exports = { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES, DEFAULT_HOSTS, AudioError, validateSourceUrl, hostAllowed, createAudio };

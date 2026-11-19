'use strict';

// Cache for expensive, deterministic results: written plans and upscaled clips.
//
// Keys are content hashes, never user ids, so the same brief from two accounts
// reuses one plan and one upscale. Values carry their own expiry; eviction is
// LRU by byte budget, so a full cache degrades latency instead of disk space.
// Nothing secret is stored in the key: the hash covers the normalized inputs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class CacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function createCache({ dir = '', ttlMs = 24 * 60 * 60 * 1000, maxBytes = 512 * 1024 * 1024, now = Date.now } = {}) {
  const enabled = Boolean(dir);
  const index = new Map();

  if (enabled) {
    fs.mkdirSync(dir, { recursive: true });
    // Rebuild the index from disk so a restart keeps the cache.
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        const metaPath = `${full}.meta.json`;
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
        index.set(name, { bytes: stat.size, expiresAt: meta && meta.expiresAt ? meta.expiresAt : 0, usedAt: stat.mtimeMs });
      } catch {
        /* a broken entry is ignored and re-created on demand */
      }
    }
  }

  function key(namespace, payload) {
    return `${namespace}-${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 40)}`;
  }

  function evict() {
    let total = 0;
    const rows = [];
    for (const [name, entry] of index) {
      total += entry.bytes;
      rows.push({ name, ...entry });
    }
    if (total <= maxBytes) return 0;
    rows.sort((a, b) => a.usedAt - b.usedAt);
    let removed = 0;
    for (const row of rows) {
      if (total <= maxBytes) break;
      try {
        fs.rmSync(path.join(dir, row.name), { force: true });
        fs.rmSync(path.join(dir, `${row.name}.meta.json`), { force: true });
      } catch {
        /* already gone */
      }
      index.delete(row.name);
      total -= row.bytes;
      removed += 1;
    }
    return removed;
  }

  function get(name) {
    if (!enabled) return null;
    const entry = index.get(name);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= now()) {
      fs.rmSync(path.join(dir, name), { force: true });
      fs.rmSync(path.join(dir, `${name}.meta.json`), { force: true });
      index.delete(name);
      return null;
    }
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      entry.usedAt = now();
      return value;
    } catch {
      index.delete(name);
      return null;
    }
  }

  function set(name, value, { ttl = ttlMs } = {}) {
    if (!enabled) return false;
    const body = JSON.stringify(value);
    const full = path.join(dir, name);
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, full);
    fs.writeFileSync(`${full}.meta.json`, JSON.stringify({ expiresAt: now() + ttl }));
    index.set(name, { bytes: Buffer.byteLength(body), expiresAt: now() + ttl, usedAt: now() });
    evict();
    return true;
  }

  // Returns the cached value or computes, stores and returns it.
  async function remember(name, compute, options) {
    const hit = get(name);
    if (hit !== null) return { value: hit, cached: true };
    const value = await compute();
    set(name, value, options);
    return { value, cached: false };
  }

  function stats() {
    let bytes = 0;
    for (const entry of index.values()) bytes += entry.bytes;
    return { enabled, entries: index.size, bytes, maxBytes, ttlMs };
  }

  function clear() {
    if (!enabled) return 0;
    let removed = 0;
    for (const name of Array.from(index.keys())) {
      fs.rmSync(path.join(dir, name), { force: true });
      fs.rmSync(path.join(dir, `${name}.meta.json`), { force: true });
      index.delete(name);
      removed += 1;
    }
    return removed;
  }

  return { enabled, key, get, set, remember, stats, clear, evict };
}

module.exports = { createCache, stableStringify, CacheError };

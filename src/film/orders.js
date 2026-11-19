'use strict';

// Orders: a batch of reels made as one piece of work.
//
// A board request is rarely one video — "20 reels for Instagram", "2 reels
// about the stone". An order is that request: one title, one set of photos,
// one caption line per reel, and one progress number the buyer cares about
// ("12 из 20").
//
// Rules:
//
// * An order never runs more reels at once than the account's own limit, so a
//   20-reel order cannot crowd out the rest of the machine. The rest wait in a
//   queue and start as slots free up.
// * Every reel is a normal film job: it can be opened, downloaded and canceled
//   on its own, and the order shows its state.
// * Nothing is charged by the order itself. Each reel reserves its generation
//   exactly as a single reel does (studio reels are free when
//   FILM_STUDIO_FREE is on).
// * A reel that fails does not stop the order: the order ends `partial` with
//   the failed count, and those reels can be retried without the client.
// * An order interrupted by a restart is marked failed; its reels are failed
//   and refunded by the pipeline's own recovery.

const crypto = require('node:crypto');
const { buildPhotoReel } = require('./storyboard.js');
const { ACTIVE_STATUSES, FilmError } = require('./jobs.js');
const { cleanText } = require('./schema.js');

const MAX_ITEMS = 50;
const POLL_MS = 1500;
const TITLE_MAX = 80;
const CAPTION_MAX = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a promise but never longer than `ms`: a stuck renderer must not
// make "cancel" hang forever. The work is aborted either way.
function settledWithin(promise, ms) {
  return Promise.race([Promise.resolve(promise).catch(() => null), sleep(ms)]);
}

// "line one\nline two" or an array -> one caption per reel, cleaned and capped.
function normalizeTitles(value) {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return lines.map((line) => cleanText(String(line), CAPTION_MAX)).filter(Boolean).slice(0, MAX_ITEMS);
}

function createOrderService({ config, db, pipeline, photos, logger = console, now = Date.now } = {}) {
  const runners = new Map();
  // One order's items are written by several reels at once; a per-order chain
  // keeps those read-modify-write updates from losing each other.
  const locks = new Map();

  function withLock(orderId, fn) {
    const previous = locks.get(orderId) || Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(orderId, next.catch(() => null));
    return next.finally(() => {
      if (locks.get(orderId) === next) locks.delete(orderId);
    });
  }

  function requireEnabled() {
    if (!config.filmEnabled) throw new FilmError('film_disabled', 'Конвейер фильмов выключен (FILM_ENABLED=false).', 503);
  }

  // Turns a request into an ordered list of reels plus the settings a later
  // retry needs. Photo ids are stored: without them a retry would need the client.
  function buildPlan(user, payload) {
    const titles = normalizeTitles(payload.titles);
    const requested = payload.count === undefined ? Math.max(1, titles.length) : Number(payload.count);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new FilmError('invalid_order_size', `В заказе от 1 до ${MAX_ITEMS} роликов.`);
    }
    // More caption lines than reels: the reels follow the lines. Fewer lines
    // than reels: the remaining reels are made without a caption.
    const total = Math.max(requested, titles.length);
    if (total > MAX_ITEMS) throw new FilmError('invalid_order_size', `В заказе от 1 до ${MAX_ITEMS} роликов.`);

    const ids = Array.isArray(payload.photoIds) ? payload.photoIds : [];
    if (!ids.length) throw new FilmError('photos_required', 'Для заказа нужны подготовленные фото.', 400);
    // Resolving here means a bad id fails the whole order before anything starts.
    const files = photos.resolve(user.id, ids);

    const settings = {
      aspect: payload.aspect || '9:16',
      secondsPerPhoto: payload.secondsPerPhoto,
      backdrop: payload.backdrop || null,
      cutout: payload.cutout !== false,
      style: payload.style || '',
      photoIds: ids,
      audio: payload.audio || null,
      voice: payload.voice || null,
    };

    const reels = Array.from({ length: total }, (_, index) => ({
      index,
      caption: titles[index] || '',
      settings,
    }));

    return {
      title: cleanText(payload.title, TITLE_MAX) || `Заказ из ${total} роликов`,
      reels,
      options: settings,
    };
  }

  // A reel's full input, from its settings. Used for the first run and retries.
  function reelInput(reel, files) {
    const { settings } = reel;
    return {
      templateId: 'photo-reel',
      presetPlan: buildPhotoReel({
        count: files.length,
        aspect: settings.aspect,
        secondsPerPhoto: settings.secondsPerPhoto,
        title: reel.caption,
        style: settings.style,
      }),
      photos: files,
      photoMode: 'studio',
      backdrop: settings.backdrop,
      cutout: settings.cutout,
      captions: reel.caption ? [reel.caption] : [],
      audio: settings.audio,
      voice: settings.voice,
    };
  }

  async function start(user, payload) {
    requireEnabled();
    const plan = buildPlan(user, payload);
    const order = await db.createFilmOrder({
      id: crypto.randomUUID(),
      userId: user.id,
      title: plan.title,
      status: 'queued',
      total: plan.reels.length,
      done: 0,
      failed: 0,
      // Items appear as their reels start; a waiting line has no jobId yet.
      items: plan.reels.map((reel) => ({ index: reel.index, caption: reel.caption, status: 'pending' })),
      options: plan.options,
    });
    const controller = new AbortController();
    const promise = run(order, plan.reels, user, controller)
      .catch((error) => logger.error(`film order ${order.id} crashed: ${error.code || error.message}`))
      .finally(() => runners.delete(order.id));
    runners.set(order.id, { controller, promise, userId: user.id });
    return order;
  }

  // Records one reel's outcome and keeps the counters honest.
  function settle(orderId, index, patch) {
    return withLock(orderId, async () => {
      const order = await db.getFilmOrder(orderId);
      if (!order) return null;
      const items = (Array.isArray(order.items) ? order.items : []).map((item) =>
        item.index === index ? { ...item, ...patch } : item,
      );
      const done = items.filter((item) => item.status === 'succeeded').length;
      const failed = items.filter((item) => item.status === 'failed').length;
      const canceled = items.filter((item) => item.status === 'canceled').length;
      const finished = done + failed + canceled;
      const next = { items, done, failed };
      if (finished === order.total) {
        // A canceled reel is neither a success nor a failure: an order of
        // nothing but canceled reels is canceled, not "succeeded".
        next.status = done === order.total ? 'succeeded'
          : done > 0 ? 'partial'
            : canceled === order.total ? 'canceled'
              : 'failed';
        next.completedAt = new Date(now()).toISOString();
      }
      return db.updateFilmOrder(orderId, next);
    });
  }

  // Starts one reel, waiting out the account limit instead of failing the order.
  async function startReel(user, input) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await pipeline.start(user, input);
      } catch (error) {
        if (error.code !== 'too_many_active' || attempt >= 150) throw error;
        await sleep(2000);
      }
    }
  }

  async function runItem(order, reel, files, user, signal) {
    if (signal.aborted) {
      await settle(order.id, reel.index, { status: 'canceled' });
      return;
    }
    let job;
    try {
      job = await startReel(user, { ...reelInput(reel, files), order: { id: order.id, index: reel.index } });
    } catch (error) {
      await settle(order.id, reel.index, {
        status: 'failed',
        error: { code: error.code || 'reel_failed', message: String(error.message || 'Ролик не запущен.').slice(0, 200) },
      });
      return;
    }
    await settle(order.id, reel.index, { status: 'running', jobId: job.id });
    // The job owns its own progress; the order only waits for the end. A reel
    // left `queued` by a restart never leaves this loop, so the timeout below
    // is what keeps the order from hanging forever.
    let state = job;
    const deadline = now() + config.filmMaxRuntimeSeconds * 1000 + 60000;
    while (!signal.aborted && ACTIVE_STATUSES.includes(state.status)) {
      if (now() > deadline) {
        await pipeline.cancel(job.id, user.id).catch(() => null);
        state = (await db.getFilmJob(job.id)) || state;
        break;
      }
      await sleep(POLL_MS);
      state = (await db.getFilmJob(job.id)) || state;
    }
    if (signal.aborted || state.status === 'canceled') {
      await settle(order.id, reel.index, { status: 'canceled', jobId: job.id });
      return;
    }
    await settle(order.id, reel.index, {
      status: state.status === 'succeeded' ? 'succeeded' : 'failed',
      jobId: job.id,
      ...(state.status === 'succeeded' ? {} : { error: state.error || { code: 'reel_failed' } }),
    });
  }

  async function run(order, reels, user, controller) {
    await db.updateFilmOrder(order.id, { status: 'running' });
    const files = photos.resolve(user.id, (order.options && order.options.photoIds) || []);
    // Reels run through as many slots as the account may occupy at once.
    const slots = Math.max(1, Math.min(config.filmMaxActivePerUser, reels.length));
    const queue = [...reels];
    const worker = async () => {
      for (;;) {
        const reel = queue.shift();
        if (!reel) return;
        try {
          await runItem(order, reel, files, user, controller.signal);
        } catch (error) {
          logger.error(`film order ${order.id} reel ${reel.index}: ${error.code || error.message}`);
          await settle(order.id, reel.index, { status: 'failed', error: { code: error.code || 'reel_failed' } }).catch(() => null);
        }
      }
    };
    await Promise.all(Array.from({ length: slots }, worker));
    const final = await db.getFilmOrder(order.id);
    // An order whose every reel was canceled is canceled, not failed.
    if (controller.signal.aborted && final && final.status !== 'succeeded') {
      await db.updateFilmOrder(order.id, { status: 'canceled', completedAt: new Date(now()).toISOString() });
    }
  }

  async function view(order, { withReels = true } = {}) {
    const items = Array.isArray(order.items) ? order.items : [];
    const base = {
      id: order.id,
      title: order.title,
      status: order.status,
      total: order.total,
      done: order.done,
      failed: order.failed,
      progress: order.total ? Math.round(((order.done + order.failed) / order.total) * 100) : 0,
      options: order.options
        ? { aspect: order.options.aspect, secondsPerPhoto: order.options.secondsPerPhoto, photos: (order.options.photoIds || []).length, audio: order.options.audio ? order.options.audio.source : null, voice: order.options.voice ? order.options.voice.source : null }
        : null,
      createdAt: order.createdAt,
      completedAt: order.completedAt,
    };
    if (!withReels) return base;
    const reels = [];
    for (const item of items) {
      const job = item.jobId ? await db.getFilmJob(item.jobId) : null;
      reels.push({
        index: item.index,
        caption: item.caption || '',
        status: item.status,
        error: item.error || (job && job.error) || null,
        job: job ? pipeline.publicJob(job) : null,
      });
    }
    return { ...base, reels };
  }

  async function list(user, { limit = 20 } = {}) {
    const orders = await db.listFilmOrders(user.id, { limit });
    return Promise.all(orders.map((order) => view(order, { withReels: false })));
  }

  async function own(user, orderId) {
    const order = await db.getFilmOrder(orderId);
    if (!order || order.userId !== user.id) throw new FilmError('order_not_found', 'Заказ не найден.', 404);
    return order;
  }

  async function get(user, orderId) {
    return view(await own(user, orderId));
  }

  // Cancels the queue and every reel still running.
  //
  // Bounded on purpose: aborting is instant, but a renderer that ignores the
  // signal would otherwise keep this request (and the buyer) waiting.
  async function cancel(user, orderId) {
    const order = await own(user, orderId);
    const entry = runners.get(orderId);
    if (entry) entry.controller.abort();
    // The queue stops now; waiting reels are marked canceled below.
    const items = Array.isArray(order.items) ? order.items : [];
    await Promise.all(items
      .filter((item) => item.jobId && item.status === 'running')
      .map((item) => settledWithin(pipeline.cancel(item.jobId, user.id), 15000)));
    for (const item of items) {
      if (item.status === 'pending' || item.status === 'running') {
        await settle(orderId, item.index, item.jobId ? { status: 'canceled', jobId: item.jobId } : { status: 'canceled' });
      }
    }
    if (entry) await settledWithin(entry.promise, 15000);
    const final = await db.getFilmOrder(orderId);
    if (final && final.status !== 'succeeded') {
      // Every reel is accounted for, so the order is finished, not running.
      const done = (final.items || []).filter((item) => item.status === 'succeeded').length;
      await db.updateFilmOrder(orderId, {
        status: done ? 'partial' : 'canceled',
        done,
        failed: (final.items || []).filter((item) => item.status === 'failed').length,
        completedAt: final.completedAt || new Date(now()).toISOString(),
      });
    }
    return view(await db.getFilmOrder(orderId));
  }

  // Runs the failed reels again, keeping the ones that worked. No client input
  // needed: the reels are rebuilt from what the order stored.
  async function retry(user, orderId) {
    requireEnabled();
    const order = await own(user, orderId);
    if (runners.has(orderId)) throw new FilmError('order_running', 'Заказ ещё выполняется.', 409);
    const items = Array.isArray(order.items) ? order.items : [];
    const retryable = items.filter((item) => item.status === 'failed' || item.status === 'canceled');
    if (!retryable.length) throw new FilmError('nothing_to_retry', 'В заказе нет неудачных роликов.', 409);
    const settings = order.options || {};
    const files = photos.resolve(user.id, settings.photoIds || []);
    if (!files.length) throw new FilmError('photos_missing', 'Фото заказа больше не сохранены: соберите заказ заново.', 409);

    const reels = retryable.map((item) => ({ index: item.index, caption: item.caption || '', settings }));
    const cleared = items.map((item) =>
      retryable.some((entry) => entry.index === item.index) ? { index: item.index, caption: item.caption, status: 'pending' } : item,
    );
    await db.updateFilmOrder(orderId, {
      status: 'running',
      items: cleared,
      done: cleared.filter((item) => item.status === 'succeeded').length,
      failed: 0,
      completedAt: null,
    });
    const controller = new AbortController();
    const promise = run(order, reels, user, controller)
      .catch((error) => logger.error(`film order ${orderId} retry crashed: ${error.code || error.message}`))
      .finally(() => runners.delete(orderId));
    runners.set(orderId, { controller, promise, userId: user.id });
    return view(await db.getFilmOrder(orderId));
  }

  // After a restart: an order that was running has nothing to wait for. Its
  // reels are failed and refunded by the pipeline's own recover().
  async function recover() {
    let interrupted = 0;
    for (const order of await db.listFilmOrdersByStatus(['queued', 'running'])) {
      if (runners.has(order.id)) continue;
      await db.updateFilmOrder(order.id, {
        status: 'failed',
        completedAt: new Date(now()).toISOString(),
        items: (Array.isArray(order.items) ? order.items : []).map((item) =>
          item.status === 'running' || item.status === 'pending'
            ? { ...item, status: 'failed', error: { code: 'interrupted' } }
            : item,
        ),
      });
      interrupted += 1;
    }
    return { interrupted };
  }

  function close() {
    for (const entry of runners.values()) entry.controller.abort();
  }

  return {
    start,
    list,
    get,
    cancel,
    retry,
    recover,
    close,
    view,
    activeCount: () => runners.size,
    maxItems: MAX_ITEMS,
  };
}

module.exports = { createOrderService, normalizeTitles, MAX_ITEMS };

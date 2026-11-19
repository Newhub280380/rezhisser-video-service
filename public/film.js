'use strict';

/* Режиссёр Фильм — page controller.
   Every node is built with createElement/textContent, so no server or user
   string can become markup. The account token is the one Studio stores. */

(function initFilmPage() {
  var API = '/api/film';
  var TOKEN_KEY = 'rezhisser.token.v1';
  var ACTIVE = ['queued', 'planning', 'provisioning', 'rendering', 'upscaling', 'assembling'];
  var STATUS_LABELS = {
    queued: 'в очереди',
    planning: 'пишется план',
    provisioning: 'аренда GPU',
    rendering: 'рендер сцен',
    upscaling: 'апскейл',
    assembling: 'сборка MP4',
    succeeded: 'готово',
    failed: 'ошибка',
    canceled: 'отменено',
    needs_attention: 'готово, но кластер не удалён',
  };
  var state = { templates: [], selected: null, audio: null, voice: null, photoIds: [], timer: null, mask: null, orderTimer: null };

  function $(id) { return document.getElementById(id); }

  function token() {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, kind) {
    var node = $('film-toast');
    node.textContent = message;
    node.dataset.kind = kind || 'info';
    node.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () { node.hidden = true; }, 7000);
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(API + path, {
      method: opts.method || (opts.body === undefined ? 'GET' : 'POST'),
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (payload) {
        if (response.ok) return payload || {};
        var error = new Error((payload && payload.message) || (response.status === 401 ? 'Войдите в аккаунт.' : 'Ошибка ' + response.status));
        error.status = response.status;
        throw error;
      });
    });
  }

  function fail(error) { toast(error.message, 'error'); }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error('Не удалось прочитать файл.')); };
      reader.readAsDataURL(file);
    });
  }

  /* ---- templates ---- */

  function renderTemplates() {
    var grid = $('template-grid');
    grid.textContent = '';
    state.templates.forEach(function (template) {
      var card = el('button', 'template-card');
      card.type = 'button';
      card.setAttribute('aria-pressed', String(template.id === state.selected));
      card.append(el('strong', '', template.label), el('span', '', template.hint));
      card.append(el('span', 'template-meta', template.locked.shots + ' кадра · ' + template.locked.totalSeconds + ' с · ' + template.locked.aspect));
      card.addEventListener('click', function () {
        state.selected = template.id;
        $('preview-box').hidden = true;
        renderTemplates();
      });
      grid.append(card);
    });
  }

  function metadata() {
    return {
      niche: $('meta-niche').value.trim(),
      subject: $('meta-subject').value.trim(),
      location: $('meta-location').value.trim(),
      style: $('meta-style').value.trim(),
    };
  }

  function previewPreset() {
    api('/presets', { body: { templateId: state.selected, metadata: metadata() } }).then(function (data) {
      var preset = data.preset;
      $('preview-meta').textContent = 'Камера: ' + preset.locked.cameraMovement + ' · ' + preset.locked.fps + ' кадров/с · ' + preset.locked.aspect + ' · ' + preset.locked.style;
      var list = $('preview-shots');
      list.textContent = '';
      preset.plan.scenes.forEach(function (scene) {
        list.append(el('li', '', scene.durationSeconds + ' с — ' + scene.prompt));
      });
      $('preview-box').hidden = false;
    }).catch(fail);
  }

  function jobExtras(payload) {
    if (state.audio) payload.audio = state.audio.ref;
    if (state.voice) payload.voice = state.voice;
    if (state.photoIds.length) payload.photoIds = state.photoIds;
    return payload;
  }

  function showReelForm() {
    $('reel-form').hidden = state.photoIds.length === 0;
  }

  // One button: every prepared photo becomes a scene.
  function startReel() {
    if (!state.photoIds.length) { toast('Сначала подготовьте фото.', 'error'); return; }
    startJob({
      photoReel: true,
      aspect: $('reel-aspect').value,
      secondsPerPhoto: Number($('reel-seconds').value),
      backdrop: $('reel-backdrop').value || undefined,
      cutout: $('reel-look').value === 'cutout',
      captions: $('reel-captions').value,
    }, $('reel-submit'));
  }

  function startJob(payload, button) {
    button.disabled = true;
    api('/jobs', { body: jobExtras(payload) }).then(function (data) {
      toast('Задача создана. Готовый ролик появится в списке ниже.', 'ok');
      return loadJobs().then(function () { showJob(data.job.id); });
    }).catch(fail).then(function () { button.disabled = false; });
  }

  /* ---- photos ---- */

  function uploadPhotos() {
    var files = Array.prototype.slice.call($('photo-files').files || []);
    if (!files.length) { toast('Выберите фото.', 'error'); return; }
    var list = $('photo-list');
    list.textContent = '';
    state.photoIds = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        if (file.size > 8 * 1024 * 1024) throw new Error(file.name + ': файл больше 8 МБ.');
        return readAsDataUrl(file);
      }).then(function (dataUrl) {
        // One photo per request keeps every request under the body limit.
        return api('/photos/prepare', { body: { photos: [dataUrl] } });
      }).then(function (data) {
        data.photos.forEach(function (photo) {
          if (state.photoIds.indexOf(photo.id) === -1) state.photoIds.push(photo.id);
          var steps = photo.report.map(function (step) {
            var label = { 'remove-bg': 'фон', enhance: 'улучшение', normalize: 'формат' }[step.step] || step.step;
            var status = { done: 'сделано', skipped: 'не настроено', failed: step.reason === 'no_subject' ? 'предмет не отделился' : 'ошибка' }[step.status] || step.status;
            return label + ': ' + status;
          });
          list.append(el('li', '', file.name + ' — ' + steps.join(', ')));
        });
      });
    });
    chain.then(function () {
      toast('Фото подготовлены (' + state.photoIds.length + '). Нажмите «Собрать ролик из фото».', 'ok');
    }).catch(fail).then(showReelForm);
  }

  /* ---- audio ---- */

  function showAudio() {
    $('audio-chosen').textContent = state.audio ? 'Выбрано: ' + state.audio.title : 'Музыка не выбрана.';
  }

  function loadLibrary() {
    return api('/audio/library').then(function (data) {
      var select = $('audio-library');
      data.tracks.forEach(function (track) {
        [select, $('voice-library')].forEach(function (target) {
          var option = el('option', '', track.title);
          option.value = track.id;
          target.append(option);
        });
      });
      if (!data.capability.library.available) {
        $('audio-library').disabled = true;
        $('voice-library').disabled = true;
      }
      if (!data.capability.download.enabled) {
        $('audio-url').disabled = true;
        $('audio-fetch').disabled = true;
      }
    }).catch(function () { /* shown as not signed in elsewhere */ });
  }

  function fetchAudio() {
    var url = $('audio-url').value.trim();
    if (!url) { toast('Вставьте ссылку.', 'error'); return; }
    $('audio-fetch').disabled = true;
    api('/audio/link', { body: { url: url } }).then(function (data) {
      state.audio = { ref: { downloadId: data.audio.downloadId }, title: data.audio.title };
      $('audio-library').value = '';
      showAudio();
    }).catch(fail).then(function () { $('audio-fetch').disabled = false; });
  }

  /* ---- inpaint ---- */

  function loadMaskImage() {
    var file = ($('inpaint-source').files || [])[0];
    if (!file) return;
    readAsDataUrl(file).then(function (dataUrl) {
      var image = new Image();
      image.onload = function () {
        // Downscaled so the request stays small; the mask has the same size.
        var scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        var canvas = $('inpaint-canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        state.mask = { image: image, rect: null };
        canvas.hidden = false;
        drawMask();
      };
      image.src = dataUrl;
    }).catch(fail);
  }

  function drawMask() {
    var canvas = $('inpaint-canvas');
    var ctx = canvas.getContext('2d');
    ctx.drawImage(state.mask.image, 0, 0, canvas.width, canvas.height);
    var rect = state.mask.rect;
    if (!rect) return;
    ctx.fillStyle = 'rgba(124, 92, 255, 0.35)';
    ctx.strokeStyle = '#19e3d4';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }

  function canvasPoint(event) {
    var canvas = $('inpaint-canvas');
    var box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - box.left) * (canvas.width / box.width))),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - box.top) * (canvas.height / box.height))),
    };
  }

  function bindMaskDrawing() {
    var canvas = $('inpaint-canvas');
    var origin = null;
    canvas.addEventListener('pointerdown', function (event) {
      if (!state.mask) return;
      origin = canvasPoint(event);
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!origin) return;
      var point = canvasPoint(event);
      state.mask.rect = { x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), w: Math.abs(point.x - origin.x), h: Math.abs(point.y - origin.y) };
      drawMask();
    });
    canvas.addEventListener('pointerup', function () { origin = null; });
  }

  function offscreen(draw) {
    var canvas = document.createElement('canvas');
    canvas.width = $('inpaint-canvas').width;
    canvas.height = $('inpaint-canvas').height;
    draw(canvas.getContext('2d'), canvas);
    return canvas;
  }

  function runInpaint() {
    if (!state.mask) { toast('Загрузите исходное фото.', 'error'); return; }
    var rect = state.mask.rect;
    var hasRect = Boolean(rect && rect.w >= 8 && rect.h >= 8);
    // Replacing the background works on the whole photo; the other modes need an area.
    if (!hasRect && $('inpaint-mode').value !== 'background') { toast('Выделите область на фото.', 'error'); return; }
    var source = offscreen(function (ctx, canvas) { ctx.drawImage(state.mask.image, 0, 0, canvas.width, canvas.height); }).toDataURL('image/jpeg', 0.92);
    // Transparent PNG with an opaque white rectangle where the edit happens.
    var mask = hasRect ? offscreen(function (ctx) { ctx.fillStyle = '#ffffff'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }).toDataURL('image/png') : null;
    var product = ($('inpaint-product').files || [])[0];
    $('inpaint-run').disabled = true;
    var background = ($('inpaint-background').files || [])[0];
    Promise.all([product ? readAsDataUrl(product) : null, background ? readAsDataUrl(background) : null]).then(function (files) {
      return api('/inpaint', { body: {
        image: source,
        mask: mask,
        prompt: $('inpaint-prompt').value.trim(),
        mode: $('inpaint-mode').value,
        reference: files[0],
        background: files[1],
        backdrop: $('inpaint-backdrop').value || null,
      } });
    }).then(function (data) {
      var result = data.result;
      var address = result.image || result.imageUrl;
      $('inpaint-link').href = address;
      $('inpaint-image').hidden = !result.image;
      if (result.image) $('inpaint-image').src = result.image;
      var notes = [];
      if (result.photoId) {
        if (state.photoIds.indexOf(result.photoId) === -1) state.photoIds.push(result.photoId);
        $('photo-list').append(el('li', '', 'Кадр из предметной съёмки — добавлен в ролик'));
        notes.push('Кадр добавлен к фото для ролика.');
        showReelForm();
      }
      if ((result.notes || []).indexOf('reference_background_kept') !== -1) notes.push('Фон у фото товара не отделился — вставлено как есть.');
      $('inpaint-status').textContent = notes.join(' ');
      $('inpaint-result').hidden = false;
    }).catch(fail).then(function () { $('inpaint-run').disabled = false; });
  }

  /* ---- jobs ---- */

  function download(job) {
    if (job.video.url) { window.open(job.video.url, '_blank', 'noopener'); return; }
    // The download route needs the account token, so the file is fetched and
    // handed to the browser as a blob.
    fetch(job.video.download, { headers: { Authorization: 'Bearer ' + token() } }).then(function (response) {
      if (!response.ok) throw new Error('Файл недоступен.');
      return response.blob();
    }).then(function (blob) {
      var link = el('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'film.mp4';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 60000);
    }).catch(fail);
  }

  function jobRow(job) {
    var row = el('li', 'job-row');
    var title = el('div', 'job-title', (job.plan && job.plan.title) || 'Ролик');
    var status = el('span', 'job-status', STATUS_LABELS[job.status] || job.status);
    status.dataset.state = job.status;
    var sub = el('div', 'job-sub', (job.sceneCount || 0) + ' сцен · ' + job.aspect + ' · ' + (job.progress || 0) + '%');
    var actions = el('div', 'job-actions');
    var open = el('button', 'btn btn-ghost', 'Раскадровка');
    open.type = 'button';
    open.addEventListener('click', function () { showJob(job.id); });
    actions.append(open);
    if (job.video) {
      var get = el('button', 'btn btn-primary', 'Скачать MP4');
      get.type = 'button';
      get.addEventListener('click', function () { download(job); });
      actions.append(get);
    }
    if (ACTIVE.indexOf(job.status) !== -1) {
      var cancel = el('button', 'btn btn-ghost', 'Отменить');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        api('/jobs/' + job.id + '/cancel', { method: 'POST' }).then(function () { toast('Задача отменена.', 'info'); return loadJobs(); }).catch(fail);
      });
      actions.append(cancel);
    }
    var bar = el('progress', 'job-progress');
    bar.max = 100;
    bar.value = job.progress || 0;
    row.append(title, status, sub, actions, bar);
    if (job.error && job.error.message) row.append(el('p', 'error-text', job.error.message));
    return row;
  }

  // A narrated reel: the voice is spoken first and sets the length of every shot.
  function startNarrated(button) {
    if (!state.photoIds.length) { toast('Нужны фото: из них собираются кадры.', 'error'); return; }
    var script = $('voice-script').value.trim();
    if (!script) { toast('Напишите текст озвучки.', 'error'); return; }
    button.disabled = true;
    api('/jobs', { body: {
      voiceover: script,
      voiceVoice: $('voice-name').value,
      photoIds: state.photoIds,
      aspect: $('voice-aspect').value,
      photoMode: 'studio',
      audio: state.audio ? state.audio.ref : undefined,
    } }).then(function (data) {
      // Synthesis happens inside the job: the list shows its stages.
      toast('Озвучка и ролик запущены: голос синтезируется первым, кадры подстраиваются под него.', 'ok');
      return loadJobs();
    }).catch(fail).then(function () { button.disabled = false; });
  }

  // ---- orders: a batch of reels as one piece of work ----

  var ORDER_STATUS = {
    queued: 'в очереди', running: 'идёт', succeeded: 'готовы',
    partial: 'частично', failed: 'не выполнен', canceled: 'отменён',
  };

  function orderRow(order) {
    var row = el('li', 'job-row');
    var title = el('div', 'job-title', order.title);
    var status = el('span', 'job-status', ORDER_STATUS[order.status] || order.status);
    status.dataset.state = order.status === 'succeeded' ? 'succeeded' : order.status === 'failed' ? 'failed' : order.status === 'canceled' ? 'canceled' : 'processing';
    var sub = el('div', 'job-sub', order.done + ' из ' + order.total + ' готово' + (order.failed ? ' · ' + order.failed + ' с ошибкой' : ''));
    var bar = el('progress', 'job-progress');
    bar.max = 100;
    bar.value = order.progress || 0;
    var actions = el('div', 'job-actions');
    if (order.status === 'running' || order.status === 'queued') {
      var cancel = el('button', 'btn btn-ghost', 'Отменить заказ');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        api('/orders/' + order.id + '/cancel', { method: 'POST' }).then(function () { return loadOrders(); }).catch(fail);
      });
      actions.append(cancel);
    }
    if (order.failed) {
      var retry = el('button', 'btn btn-ghost', 'Повторить неудачные');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        retry.disabled = true;
        api('/orders/' + order.id + '/retry', { method: 'POST' }).then(function () { return loadOrders(); }).catch(fail);
      });
      actions.append(retry);
    }
    row.append(title, status, sub, actions, bar);
    return row;
  }

  function loadOrders() {
    var list = $('order-list');
    if (!token()) {
      list.textContent = '';
      return Promise.resolve();
    }
    return api('/orders').then(function (data) {
      list.textContent = '';
      if (!data.orders.length) list.append(el('li', 'film-hint', 'Заказов пока нет: соберите пачку из своих фото.'));
      data.orders.forEach(function (order) { list.append(orderRow(order)); });
      var active = data.orders.some(function (order) { return order.status === 'running' || order.status === 'queued'; });
      window.clearTimeout(state.orderTimer);
      if (active) state.orderTimer = window.setTimeout(loadOrders, 4000);
    }).catch(fail);
  }

  // One request per order: each line becomes one reel with its own caption.
  function startOrder(button) {
    if (!state.photoIds.length) { toast('Сначала подготовьте фото — из них собираются все ролики заказа.', 'error'); return; }
    var lines = $('order-titles').value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
    var count = Number($('order-count').value) || 1;
    button.disabled = true;
    api('/orders', { method: 'POST', body: {
      title: $('order-title').value.trim(),
      count: Math.max(count, lines.length),
      titles: lines,
      photoIds: state.photoIds,
      aspect: $('order-aspect').value,
      secondsPerPhoto: Number($('order-seconds').value),
      cutout: $('order-look').value === 'cutout',
      audio: state.audio ? state.audio.ref : undefined,
      voice: state.voice || undefined,
    } }).then(function (data) {
      toast('Заказ принят: ' + data.order.total + ' роликов.', 'ok');
      $('order-titles').value = '';
      $('order-title').value = '';
      return loadOrders();
    }).catch(fail).then(function () { button.disabled = false; });
  }

  function loadJobs() {
    var list = $('job-list');
    if (!token()) {
      list.textContent = '';
      list.append(el('li', 'film-hint', 'Войдите в аккаунт, чтобы создавать ролики и видеть их здесь.'));
      return Promise.resolve();
    }
    return api('/jobs').then(function (data) {
      list.textContent = '';
      if (!data.jobs.length) list.append(el('li', 'film-hint', 'Пока нет роликов.'));
      data.jobs.forEach(function (job) { list.append(jobRow(job)); });
      var active = data.jobs.some(function (job) { return ACTIVE.indexOf(job.status) !== -1; });
      window.clearTimeout(state.timer);
      if (active) state.timer = window.setTimeout(loadJobs, 5000);
    }).catch(fail);
  }

  function showJob(id) {
    api('/jobs/' + id).then(function (data) {
      var job = data.job;
      $('job-detail').hidden = false;
      $('job-detail-title').textContent = (job.plan && job.plan.title) || 'Раскадровка';
      var meta = [];
      if (job.engine) meta.push({ template: 'план: шаблон', 'photo-reel': 'план: по фото', storyboard: 'план: встроенная раскадровка', sglang: 'план: SGLang', 'sglang-cache': 'план: SGLang (из кэша)' }[job.engine] || job.engine);
      if (job.infra && job.infra.plannerFallback) meta.push('SGLang не ответил');
      if (job.infra && job.infra.provider) meta.push('рендер: ' + ({ studio: 'встроенная студия (движение камеры по фото)', local: 'видеомодель', ray: 'Ray-кластер', skypilot: 'SkyPilot + Ray' }[job.infra.provider] || job.infra.provider));
      if (job.infra && job.infra.upscaler) meta.push({ recavsr: 'апскейл: ReCaVSR', 'recavsr-partial': 'апскейл: ReCaVSR частично', native: 'снято сразу в итоговом размере' }[job.infra.upscaler] || 'масштабирование ffmpeg (не апскейл)');
      if (job.audio && job.audio.music) meta.push('музыка: ' + job.audio.music.title);
      if (job.audio && job.audio.voice) meta.push('озвучка: ' + job.audio.voice.title);
      $('job-detail-meta').textContent = meta.join(' · ');
      var list = $('shot-list');
      list.textContent = '';
      ((job.plan && job.plan.scenes) || []).forEach(function (scene) {
        var shot = (job.shots || []).filter(function (item) { return item.n === scene.n; })[0];
        var item = el('li', '', scene.durationSeconds + ' с · ' + scene.camera + ' — ' + scene.prompt);
        item.dataset.state = shot ? shot.status : 'pending';
        list.append(item);
      });
    }).catch(fail);
  }

  /* ---- capabilities ---- */

  function missing(names) { return 'не настроено (' + names.join(', ') + ')'; }

  function fillBackdrops(select, backdrops, auto) {
    select.textContent = '';
    var first = el('option', '', auto);
    first.value = '';
    select.append(first);
    backdrops.forEach(function (item) {
      var option = el('option', '', item.label);
      option.value = item.id;
      select.append(option);
    });
  }

  function renderCapabilities(caps) {
    var bg = caps.photos.steps.filter(function (step) { return step.step === 'remove-bg'; })[0];
    var rows = [
      ['Ролик из своих фото', 'встроенная студия — работает всегда' + (caps.studio.free ? ', без списания генераций' : '')],
      ['Сценарий длинного фильма', caps.planner.engine === 'sglang' ? 'SGLang' : 'встроенная раскадровка; SGLang не подключён (' + caps.planner.upgrade.join(', ') + ')'],
      ['Генерация сцен с нуля', caps.render.mode ? { ray: 'Ray-кластер', sky: 'SkyPilot + Ray', local: 'видеомодель, параллельно' }[caps.render.mode] : 'видеомодель не подключена (' + caps.render.missing.join(', ') + ')'],
      ['Аренда GPU (SkyPilot)', !caps.infra.enabled ? 'выключена' : caps.infra.dryRun ? 'dry-run: кластер не запускается' : caps.infra.priceCeilingSet ? 'включена' : 'нет потолка цены (SKYPILOT_MAX_HOURLY_USD)'],
      ['Апскейл видеомодели', caps.upscaler.configured ? 'ReCaVSR' : 'масштабирование ffmpeg; ReCaVSR ' + missing(caps.upscaler.missing)],
      ['Музыка по ссылке', caps.audio.download.enabled ? caps.audio.download.hosts.join(', ') : 'выключена'],
      ['Библиотека музыки', caps.audio.library.available ? 'подключена' : missing(caps.audio.library.missing)],
      ['Удаление фона', bg && bg.configured ? bg.engine : 'не найдено: установите rembg (' + caps.photos.missing.join(', ') + ')'],
      ['Улучшение фото', 'встроено'],
      ['Предметная съёмка', 'фон, вставка, очистка — встроено; нейросеть: ' + (caps.inpaint.generative.configured ? 'подключена' : missing(caps.inpaint.generative.missing))],
    ];
    var list = $('caps-list');
    list.textContent = '';
    rows.forEach(function (row) { list.append(el('dt', '', row[0]), el('dd', '', row[1])); });
    fillBackdrops($('reel-backdrop'), caps.studio.backdrops, 'Подобрать автоматически');
    fillBackdrops($('inpaint-backdrop'), caps.studio.backdrops, 'Светлая студия');
    state.generative = caps.inpaint.generative.configured;
    state.renderMode = caps.render.mode;
    Array.prototype.forEach.call($('inpaint-mode').options, function (option) {
      if (option.dataset.generative && !state.generative) option.disabled = true;
    });
    if (!bg || !bg.configured) {
      $('reel-look').value = 'photo';
      $('reel-look').options[0].disabled = true;
    }
    if (!caps.render.mode) {
      $('templates-note').textContent = 'Видеомодель не подключена: шаблон будет снят по вашим фото. Сначала подготовьте фото ниже.';
      $('film-note').textContent = 'Видеомодель не подключена: фильм будет собран из ваших фото по встроенной раскадровке. Сначала подготовьте фото.';
    }
  }

  // Without a video model a template or a long film is shot from the photos.
  function needsPhotos() {
    if (state.renderMode || state.photoIds.length) return false;
    toast('Сначала подготовьте фото в разделе «Свои фото».', 'error');
    return true;
  }

  /* ---- boot ---- */

  function boot() {
    api('/capabilities').then(function (caps) {
      $('film-on').hidden = false;
      renderCapabilities(caps);
      return api('/templates');
    }).then(function (data) {
      state.templates = data.templates;
      state.selected = data.templates.length ? data.templates[0].id : null;
      renderTemplates();
      if (token()) $('film-login').hidden = true;
      return Promise.all([loadLibrary(), loadJobs(), loadOrders()]);
    }).catch(function (error) {
      if (error.status === 404) $('film-off').hidden = false;
      else fail(error);
    });

    $('preview-btn').addEventListener('click', previewPreset);
    $('preset-form').addEventListener('submit', function (event) {
      event.preventDefault();
      if (needsPhotos()) return;
      startJob({ templateId: state.selected, metadata: metadata() }, $('preset-submit'));
    });
    $('film-form').addEventListener('submit', function (event) {
      event.preventDefault();
      if (needsPhotos()) return;
      startJob({
        brief: { brief: $('film-brief').value.trim() },
        scenes: Number($('film-scenes').value),
        durationSeconds: Number($('film-duration').value),
        aspect: $('film-aspect').value,
      }, $('film-submit'));
    });
    $('photo-upload').addEventListener('click', uploadPhotos);
    $('reel-submit').addEventListener('click', startReel);
    $('order-submit').addEventListener('click', function () { startOrder($('order-submit')); });
    $('voice-submit').addEventListener('click', function () { startNarrated($('voice-submit')); });
    $('photo-clear').addEventListener('click', function () {
      state.photoIds = [];
      showReelForm();
      $('photo-list').textContent = '';
      $('photo-files').value = '';
    });
    $('audio-library').addEventListener('change', function () {
      var select = $('audio-library');
      state.audio = select.value ? { ref: { trackId: select.value }, title: select.options[select.selectedIndex].textContent } : null;
      showAudio();
    });
    $('voice-library').addEventListener('change', function () {
      state.voice = $('voice-library').value ? { trackId: $('voice-library').value } : null;
    });
    $('audio-fetch').addEventListener('click', fetchAudio);
    $('inpaint-source').addEventListener('change', loadMaskImage);
    $('inpaint-run').addEventListener('click', runInpaint);
    $('refresh-btn').addEventListener('click', loadJobs);
    bindMaskDrawing();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

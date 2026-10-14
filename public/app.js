'use strict';

// BalaoTools, client side. One screen, four states (empty -> tracing ->
// ready | error), the trace started on the server and polled here, the
// result and the last 12 conversions kept on this device.

(function () {
  // ── The elements the two drawn screens carry ─────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'),
    choose: $('choose-image'),
    input: $('file-input'),
    fileCard: $('file-card'),
    fileThumb: $('file-thumb'),
    fileName: $('file-name'),
    fileMeta: $('file-meta'),
    changeImage: $('change-image'),
    origMeta: $('orig-meta'),
    origArt: $('orig-art'),
    vecMeta: $('vec-meta'),
    vecArt: $('vec-art'),
    traceOverlay: $('trace-overlay'),
    traceStatus: $('trace-status'),
    errorState: $('error-state'),
    errorTitle: $('error-title'),
    errorText: $('error-text'),
    tryAgain: $('try-again'),
    errorChange: $('error-change'),
    optsRow: $('opts-row'),
    anchorSwitch: $('anchor-switch'),
    downloads: $('downloads'),
    dlSvg: $('dl-svg'),
    dlEps: $('dl-eps'),
    toast: $('toast'),
    demoNote: $('demo-note'),
    recentList: $('recent-list'),
    rowTpl: $('row-tpl'),
    recentEmpty: $('recent-empty'),
    recentUnavailable: $('recent-unavailable'),
  };

  const MAX_BYTES = 30 * 1024 * 1024;
  const TYPES = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
  };
  const POLL_MS = 1500;

  // The iframe adds ?token=…; forward it on every API call.
  const token = new URLSearchParams(location.search).get('token') || '';
  const authHeaders = () => (token ? { 'x-usernode-token': token } : {});

  // ── State ────────────────────────────────────────────────────────────────
  // current: { filename, format, width, height, svg, eps, shapes, thumbUrl,
  //            originalSrc, id (null while fresh) }
  let current = null;
  let pollTimer = null;
  let pendingFile = null; // the file being traced, until the result arrives
  let anchorsOn = true;

  function setState(state) {
    el.app.dataset.state = state;
    el.choose.hidden = state !== 'empty';
    el.fileCard.hidden = state === 'empty';
    el.traceStatus.hidden = state !== 'tracing';
    el.traceOverlay.hidden = state !== 'tracing';
    el.errorState.hidden = state !== 'error';
    el.optsRow.hidden = state !== 'ready';
    el.downloads.hidden = state !== 'ready';
    if (state === 'empty') {
      el.origArt.replaceChildren();
      el.vecArt.replaceChildren();
      el.origMeta.textContent = '';
      el.vecMeta.textContent = '';
    }
  }

  function showError(title, text, retryable) {
    el.errorTitle.textContent = title;
    el.errorText.textContent = text;
    el.tryAgain.hidden = !retryable;
    setState('error');
  }

  // ── The compare panes ────────────────────────────────────────────────────
  function svgFromText(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    return svg.nodeName.toLowerCase() === 'svg' && !svg.querySelector('parsererror')
      ? svg : null;
  }

  function showOriginal() {
    el.origArt.replaceChildren();
    el.origMeta.textContent = current.format;
    if (!current.originalSrc) return;
    if (current.originalSrc.startsWith('<svg')) {
      const svg = svgFromText(current.originalSrc);
      if (svg) {
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        el.origArt.appendChild(svg);
        return;
      }
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = current.originalSrc;
    el.origArt.appendChild(img);
  }

  // The anchor-point overlay: every segment endpoint of every traced path,
  // capped so a photo's thousands of points don't drown the picture.
  function anchorPoints(d, cap) {
    const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
    const pts = [];
    let i = 0;
    let cur = null;
    while (i < tokens.length && pts.length < cap) {
      const t = tokens[i++];
      if (t === 'Z') continue;
      const count = t === 'M' || t === 'L' ? 2 : t === 'Q' ? 4 : t === 'C' ? 6 : 0;
      if (count === 0) { // a bare number: an implicit repeat of the last op
        cur = [parseFloat(t), parseFloat(tokens[i++])];
        pts.push(cur);
        continue;
      }
      const vals = [];
      for (let k = 0; k < count; k++) vals.push(parseFloat(tokens[i++]));
      cur = [vals[count - 2], vals[count - 1]];
      pts.push(cur);
    }
    return pts;
  }

  function renderVector() {
    el.vecArt.replaceChildren();
    if (!current || !current.svg) return;
    const svg = svgFromText(current.svg);
    if (!svg) return;
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (anchorsOn) {
      const vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
      const box = Math.max(3, vb[2] / 27); // the drawn screen's 6-in-160 square
      const cap = 1500;
      const overlayPaths = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      overlayPaths.setAttribute('fill', 'none');
      overlayPaths.setAttribute('style', 'stroke:rgb(var(--accent))');
      overlayPaths.setAttribute('stroke-width', '1');
      const dots = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      dots.setAttribute('style', 'fill:rgb(var(--surface));stroke:rgb(var(--accent))');
      dots.setAttribute('stroke-width', '1.25');
      for (const path of svg.querySelectorAll('path')) {
        const d = path.getAttribute('d');
        if (!d) continue;
        const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        ghost.setAttribute('d', d);
        ghost.setAttribute('vector-effect', 'non-scaling-stroke');
        overlayPaths.appendChild(ghost);
        for (const [x, y] of anchorPoints(d, cap - dots.childElementCount)) {
          const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          r.setAttribute('x', (x - box / 2).toFixed(2));
          r.setAttribute('y', (y - box / 2).toFixed(2));
          r.setAttribute('width', box.toFixed(2));
          r.setAttribute('height', box.toFixed(2));
          dots.appendChild(r);
        }
        if (dots.childElementCount >= cap) break;
      }
      svg.appendChild(overlayPaths);
      svg.appendChild(dots);
    }
    el.vecArt.appendChild(svg);
  }

  function showResult() {
    el.fileName.textContent = current.filename;
    el.fileMeta.textContent = current.metaText;
    showOriginal();
    el.vecMeta.textContent = current.shapes + ' shapes';
    renderVector();
    setState('ready');
  }

  // ── Picking a file ───────────────────────────────────────────────────────
  function pickFile() {
    if (!el.input.hidden || el.app.dataset.state === 'tracing') return;
    el.input.value = '';
    el.input.click();
  }

  el.choose.addEventListener('click', pickFile);
  el.choose.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickFile();
    }
  });
  el.changeImage.addEventListener('click', pickFile);
  el.errorChange.addEventListener('click', pickFile);
  el.input.addEventListener('change', () => {
    if (el.input.files && el.input.files[0]) startWithFile(el.input.files[0]);
  });

  // Drag & drop anywhere on the screen.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    el.choose.classList.add('drag');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      el.choose.classList.remove('drag');
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.choose.classList.remove('drag');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) startWithFile(file);
  });

  function startWithFile(file) {
    if (el.app.dataset.state === 'tracing') return;
    if (!TYPES[file.type]) {
      showFileError(file, 'Unsupported file type', 'Use a PNG, JPEG, WebP or GIF image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      showFileError(file, 'That file is too large', 'Images can be up to 30 MB. Pick a smaller file.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      beginTrace(file, img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showFileError(file, 'Couldn’t read that image', 'The file looks broken. Try another one.');
    };
    img.src = url;
  }

  function showFileError(file, title, text) {
    el.fileName.textContent = file.name;
    el.fileMeta.textContent = Math.max(1, Math.round(file.size / 1024)) + ' KB';
    el.fileThumb.replaceChildren();
    el.origArt.replaceChildren();
    el.vecArt.replaceChildren();
    el.origMeta.textContent = TYPES[file.type] || '';
    el.vecMeta.textContent = '';
    showError(title, text, false);
  }

  // ── Tracing ──────────────────────────────────────────────────────────────
  async function beginTrace(file, width, height) {
    pendingFile = file;
    el.fileThumb.replaceChildren();
    el.fileName.textContent = file.name;
    el.fileMeta.textContent = width + ' × ' + height +
      ' px, ' + Math.max(1, Math.round(file.size / 1024)) + ' KB';
    el.origMeta.textContent = TYPES[file.type];
    el.vecMeta.textContent = 'Tracing';
    el.origArt.replaceChildren();
    const preview = document.createElement('img');
    preview.alt = '';
    preview.src = URL.createObjectURL(file);
    el.origArt.appendChild(preview);
    el.vecArt.replaceChildren();
    setState('tracing');

    let created;
    try {
      const res = await fetch('/api/trace?name=' + encodeURIComponent(baseName(file.name)), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...authHeaders() },
        body: file,
      });
      if (res.status === 401) {
        return showError('Make an account to continue',
          'Converting images needs a Homeroom account. Open this app from Homeroom and try again.', false);
      }
      if (res.status === 409) {
        return showError('One conversion at a time',
          'Your previous trace is still running. Wait for it to finish, then try this one.', false);
      }
      if (res.status === 413) {
        return showError('That file is too large',
          'Images can be up to 30 MB. Pick a smaller file.', false);
      }
      if (res.status === 415) {
        return showError('Unsupported file type',
          'Use a PNG, JPEG, WebP or GIF image.', false);
      }
      if (!res.ok) throw new Error('status ' + res.status);
      created = await res.json();
    } catch {
      return showError('Couldn’t reach the server',
        'Check your connection and try again. Nothing was traced yet.', true);
    }
    poll(created.id, 0);
  }

  function poll(id, failures) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (el.app.dataset.state !== 'tracing') return;
      let res;
      try {
        res = await fetch('/api/trace/' + id, { headers: authHeaders() });
      } catch {
        return poll(id, failures + 1);
      }
      if (failures >= 8) {
        return showError('Lost contact with the server',
          'The trace is still running on the server, but this screen can’t see it any more. Try again to start over.', true);
      }
      if (!res.ok) return poll(id, failures + 1);
      let job;
      try {
        job = await res.json();
      } catch {
        return poll(id, failures + 1);
      }
      if (job.status === 'queued' || job.status === 'tracing') return poll(id, 0);
      if (job.status === 'failed') {
        const messages = {
          timeout: ['That took too long', 'Tracing was stopped after five minutes. A smaller image usually finishes faster.', true],
        };
        const m = messages[job.error] ||
          ['Couldn’t trace that image', 'Something went wrong while tracing. What you already have still works — try this image again.', true];
        return showError(m[0], m[1], m[2]);
      }
      // Ready. Zero shapes is not an error, but there is nothing to show.
      if (!job.shapes) {
        return showError('Nothing to trace',
          'This image is fully transparent, so it has no shapes to trace. Try a picture with visible colours.', false);
      }
      current = {
        id: null,
        filename: pendingFile ? pendingFile.name : '',
        format: pendingFile ? (TYPES[pendingFile.type] || '') : '',
        width: job.width,
        height: job.height,
        shapes: job.shapes,
        svg: job.svg,
        eps: job.eps,
        metaText: el.fileMeta.textContent,
        originalSrc: '',
      };
      // Keep the pixel preview (the traced image) as the "original".
      if (el.origArt.firstElementChild) {
        current.originalSrc = el.origArt.firstElementChild.src;
      }
      current.thumbUrl = await makeThumb(current.originalSrc);
      setFileThumb(current.thumbUrl || current.originalSrc);
      finishReady();
    }, POLL_MS);
  }

  function setFileThumb(src) {
    el.fileThumb.replaceChildren();
    if (!src) return;
    if (src.startsWith('<svg')) {
      const svg = svgFromText(src);
      if (svg) {
        svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        el.fileThumb.appendChild(svg);
        return;
      }
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    el.fileThumb.appendChild(img);
  }

  function finishReady() {
    showResult();
    saveConversion();
    renderRecent();
  }

  // ── The anchor switch and the downloads ──────────────────────────────────
  el.anchorSwitch.addEventListener('click', () => {
    anchorsOn = !anchorsOn;
    el.anchorSwitch.setAttribute('aria-checked', String(anchorsOn));
    renderVector();
  });

  function baseName(filename) {
    return filename.replace(/\.[a-z0-9]+$/i, '') || 'vector';
  }

  // Saving a file gives no signal of its own inside the frame, so confirm it:
  // a short toast names the file, and the tapped button's icon shows a check
  // for two seconds. Only the main download buttons carry an icon; the list
  // rows' SVG/EPS buttons get the toast alone.
  let toastTimer = null;
  let iconTimer = null;
  const flashedPaths = new Set();

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2000);
  }

  function flashCheck(btn) {
    const path = btn.querySelector('svg path');
    if (!path) return;
    for (const p of flashedPaths) p.setAttribute('d', p.dataset.orig);
    flashedPaths.clear();
    path.dataset.orig = path.getAttribute('d');
    path.setAttribute('d', 'M5 13L10 18L19 7');
    flashedPaths.add(path);
    clearTimeout(iconTimer);
    iconTimer = setTimeout(() => {
      for (const p of flashedPaths) p.setAttribute('d', p.dataset.orig);
      flashedPaths.clear();
    }, 2000);
  }

  function download(text, type, filename, btn) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast(filename + ' downloaded');
    if (btn) flashCheck(btn);
  }

  el.dlSvg.addEventListener('click', () => {
    if (current && current.svg) download(current.svg, 'image/svg+xml', baseName(current.filename) + '.svg', el.dlSvg);
  });
  el.dlEps.addEventListener('click', () => {
    if (current && current.eps) download(current.eps, 'application/postscript', baseName(current.filename) + '.eps', el.dlEps);
  });

  // ── The recent list, on this device ──────────────────────────────────────
  const DB_NAME = 'balaotools';
  let dbPromise = null;
  let storeBroken = false;

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('no idb'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversions')) {
          db.createObjectStore('conversions', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb failed'));
      req.onblocked = () => reject(new Error('idb blocked'));
    });
    return dbPromise;
  }

  function listConversions() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('conversions', 'readonly');
      const req = tx.objectStore('conversions').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function saveConversion() {
    if (!current || !current.svg) return;
    const record = {
      id: 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      filename: current.filename,
      createdAt: new Date().toISOString(),
      width: current.width,
      height: current.height,
      shapes: current.shapes,
      svg: current.svg,
      eps: current.eps,
      thumb: current.thumbUrl || '',
    };
    current.id = record.id;
    openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('conversions', 'readwrite');
      const store = tx.objectStore('conversions');
      store.put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('save aborted'));
    })).then(() => {
      // The list is drawn from what we keep in memory as well as the store.
      recentItems = [record].concat(recentItems).slice(0, 12);
      renderRecent();
      // Keep only the last 12 in the store itself.
      return listConversions().then((all) => {
        const old = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(12);
        if (!old.length) return;
        return openDb().then((db) => new Promise((resolve, reject) => {
          const tx = db.transaction('conversions', 'readwrite');
          for (const r of old) tx.objectStore('conversions').delete(r.id);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        }));
      });
    }).catch(() => { storeBroken = true; renderRecent(); });
  }

  function makeThumb(src) {
    return new Promise((resolve) => {
      if (!src) return resolve('');
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }

  function whenLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const days = Math.round((day(now) - day(d)) / 86400000);
    const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (days <= 0) return 'Today, ' + hh;
    if (days === 1) return 'Yesterday, ' + hh;
    return d.getDate() + ' ' + months[d.getMonth()] + ', ' + hh;
  }

  // The list: on-device items, plus the staging demo's samples in front.
  let demoItems = [];
  let recentItems = [];
  let recentLoaded = false;

  function allRows() {
    return demoItems.concat(recentItems);
  }

  function renderRecent() {
    const rows = allRows();
    el.recentList.replaceChildren();
    el.recentEmpty.hidden = true;
    el.recentUnavailable.hidden = !storeBroken;
    el.demoNote.hidden = !demoItems.length;
    if (storeBroken) return;
    if (!recentLoaded) return; // still loading: skeletons go below
    if (!rows.length) {
      el.recentEmpty.hidden = false;
      return;
    }
    const openId = current && current.id;
    for (const item of rows) el.recentList.appendChild(rowFor(item, item.id === openId));
  }

  function rowFor(item, isOpen) {
    const row = el.rowTpl.content.firstElementChild.cloneNode(true);
    const thumbBox = row.querySelector('.thumb');
    if (item.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = item.thumb;
      thumbBox.replaceChildren(img);
    } else if (item.svg) {
      const svg = svgFromText(item.svg);
      if (svg) {
        svg.setAttribute('width', '40');
        svg.setAttribute('height', '40');
        thumbBox.replaceChildren(svg);
      }
    }
    const name = row.querySelector('.ellip');
    name.textContent = item.filename;
    const meta = row.querySelector('.grow .num');
    if (isOpen) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Open now ';
      meta.appendChild(tag);
      row.classList.add('current');
    }
    meta.appendChild(document.createTextNode(whenLabel(item.createdAt)));
    const [svgBtn, epsBtn] = row.querySelectorAll('.fmt button');
    svgBtn.addEventListener('click', () => {
      if (item.svg) download(item.svg, 'image/svg+xml', baseName(item.filename) + '.svg', svgBtn);
    });
    epsBtn.addEventListener('click', () => {
      if (item.eps) download(item.eps, 'application/postscript', baseName(item.filename) + '.eps', epsBtn);
    });
    // Tapping the row (not the download buttons) opens it in the viewer.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.fmt')) return;
      openConversion(item);
    });
    return row;
  }

  function openConversion(item) {
    if (el.app.dataset.state === 'tracing') return;
    const ext = (item.filename.match(/\.([a-z0-9]+)$/i) || [])[1];
    current = {
      id: item.id || null,
      filename: item.filename,
      format: ext ? ext.toUpperCase() : '',
      width: item.width,
      height: item.height,
      shapes: item.shapes,
      svg: item.svg,
      eps: item.eps,
      thumbUrl: item.thumb || '',
      originalSrc: item.originalSvg || item.thumb || '',
      metaText: item.width + ' × ' + item.height + ' px',
    };
    setFileThumb(item.thumb || item.originalSvg || item.svg || '');
    showResult();
    renderRecent();
  }

  function renderSkeletons() {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const row = el.rowTpl.content.firstElementChild.cloneNode(true);
      row.querySelector('.thumb').replaceChildren(Object.assign(document.createElement('div'), { className: 'skeleton', style: 'width:40px;height:40px' }));
      row.querySelector('.ellip').replaceChildren(Object.assign(document.createElement('div'), { className: 'skeleton', style: 'width:120px;height:16px' }));
      row.querySelector('.grow .num').replaceChildren(Object.assign(document.createElement('div'), { className: 'skeleton', style: 'width:80px;height:12px' }));
      row.querySelector('.fmt').replaceChildren();
      rows.push(row);
    }
    el.recentList.replaceChildren(...rows);
  }

  function loadRecent() {
    renderSkeletons();
    listConversions().then((all) => {
      recentItems = all
        .filter((r) => r.svg)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 12);
      recentLoaded = true;
      renderRecent();
    }).catch(() => {
      storeBroken = true;
      recentLoaded = true;
      renderRecent();
    });
  }

  // ── The staging demo ─────────────────────────────────────────────────────
  function isDemo() {
    return new URLSearchParams(location.search).get('demo') === '1';
  }

  // The staging server injects the samples into the page itself
  // (window.USERNODE_DEMO, see server.js), so the demo renders without an
  // API round-trip and works for signed-out loads too.
  function loadDemo() {
    const list = window.USERNODE_DEMO;
    if (!Array.isArray(list) || !list.length) return;
    demoItems = list.map((d) => ({
      id: d.id,
      filename: d.filename,
      createdAt: d.createdAt,
      width: d.width,
      height: d.height,
      shapes: d.shapes,
      svg: d.svg,
      eps: d.eps,
      originalSvg: d.originalSvg,
      thumb: '',
    }));
    renderRecent();
    openConversion(demoItems[0]);
  }

  // ── Start ────────────────────────────────────────────────────────────────
  setState('empty');
  loadRecent();
  if (isDemo()) loadDemo();
})();
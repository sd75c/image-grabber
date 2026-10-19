/* 图提取 ImageGrab — 画廊页
 *
 * 从 chrome.storage.session 读取一次提取结果，负责：
 *  - 缩略图网格、尺寸、勾选 / 全选 / 反选 / 已选数量；
 *  - 按需申请图片域名权限，fetch 原图并转换为 PNG；
 *  - 通过 chrome.downloads 下载、跟踪进度并回写每张图的状态。
 */
(() => {
  'use strict';

  const MAX_PIXELS = 24000000; // 超过约 2400 万像素不做 canvas 转换，避免内存占用过高
  const FETCH_TIMEOUT = 25000;
  const PARALLEL = 3;
  const OBJECT_URL_TTL = 10 * 60 * 1000;

  const STATUS_TEXT = {
    idle: '',
    working: '处理中…',
    downloading: '下载中…',
    done: '已下载',
    failed: '失败',
  };

  const EXT_BY_MIME = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };

  const state = {
    capture: null,
    images: [],
    running: false,
    batch: { total: 0, processed: 0, converted: 0, direct: 0 },
    grantedOrigins: new Set(),
    objectUrls: new Map(),
    byDownloadId: new Map(),
    bannerTimer: 0,
  };

  const el = {};

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ------------------------------------------------------------------ *
   * 初始化与数据加载
   * ------------------------------------------------------------------ */

  function init() {
    el.captureTitle = document.getElementById('capture-title');
    el.captureMeta = document.getElementById('capture-meta');
    el.pageLink = document.getElementById('page-link');
    el.toolbar = document.getElementById('toolbar');
    el.selectAll = document.getElementById('btn-select-all');
    el.invert = document.getElementById('btn-invert');
    el.selectedCount = document.getElementById('selected-count');
    el.pngToggle = document.getElementById('png-toggle');
    el.download = document.getElementById('btn-download');
    el.hint = document.getElementById('hint');
    el.banner = document.getElementById('banner');
    el.progress = document.getElementById('progress');
    el.progressTrack = el.progress.querySelector('.progress__track');
    el.progressBar = document.getElementById('progress-bar');
    el.progressText = document.getElementById('progress-text');
    el.grid = document.getElementById('grid');
    el.empty = document.getElementById('empty-state');
    el.fatal = document.getElementById('fatal');
    el.fatalText = document.getElementById('fatal-text');

    if (!el.grid || !el.download) return;

    bindEvents();
    registerDownloadWatcher();
    void loadCapture();
  }

  function bindEvents() {
    el.selectAll.addEventListener('change', () => {
      const checked = el.selectAll.checked;
      state.images.forEach((item) => {
        item.selected = checked;
        syncCardSelection(item);
      });
      updateSelectionUI();
    });

    el.invert.addEventListener('click', () => {
      state.images.forEach((item) => {
        item.selected = !item.selected;
        syncCardSelection(item);
      });
      updateSelectionUI();
    });

    el.download.addEventListener('click', () => {
      void startBatch();
    });

    el.pngToggle.addEventListener('change', () => {
      if (state.running) {
        el.pngToggle.checked = !el.pngToggle.checked;
        showBanner('下载进行中，暂时不能切换 PNG 选项。', 'warn', 3000);
      }
    });
  }

  async function loadCapture() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      showFatal('链接里缺少提取结果编号（id）。');
      return;
    }

    const api = typeof chrome !== 'undefined' ? chrome : null;
    const store = api && api.storage;
    const area = store && (store.session || store.local);
    if (!area) {
      showFatal('当前环境无法访问扩展存储，请确认插件已正确加载。');
      return;
    }

    try {
      const key = 'capture:' + id;
      const data = await area.get(key);
      const capture = data && data[key];
      if (!capture || !Array.isArray(capture.images) || capture.images.length === 0) {
        showFatal('这次提取结果不存在，或已被更新的提取结果覆盖（只保留最近 5 次）。');
        return;
      }

      state.capture = capture;
      state.images = capture.images.map((image, index) => ({
        index,
        url: String(image.url || ''),
        width: Number(image.width) || 0,
        height: Number(image.height) || 0,
        source: String(image.source || ''),
        unknown: Boolean(image.unknown),
        selected: true,
        status: 'idle',
        note: '',
        converted: false,
        direct: false,
        downloadId: null,
        card: null,
        statusEl: null,
      }));

      renderHeader();
      renderGrid();
      updateSelectionUI();
    } catch (error) {
      console.error('[ImageGrab] 读取提取结果失败', error);
      showFatal('读取提取结果失败：' + ((error && error.message) || String(error)));
    }
  }

  function showFatal(message) {
    document.body.classList.add('is-fatal');
    if (el.fatal) el.fatal.hidden = false;
    if (el.fatalText) el.fatalText.textContent = message;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderHeader() {
    const capture = state.capture;
    const stats = capture.stats || {};
    document.title = `图提取 · ${capture.siteName || '商品图片'}`;

    el.captureTitle.textContent = capture.title ? truncate(capture.title, 110) : '商品图片';
    el.captureTitle.title = capture.title || '';

    const parts = [capture.siteName || '未知站点', formatTime(capture.capturedAt), `共 ${state.images.length} 张`];
    if (stats.scanned > state.images.length) {
      parts.push(`候选 ${stats.scanned} 张，已过滤 ${stats.scanned - state.images.length} 张`);
    }
    el.captureMeta.textContent = parts.filter(Boolean).join(' · ');

    if (capture.pageUrl && /^https?:\/\//i.test(capture.pageUrl)) {
      el.pageLink.href = capture.pageUrl;
      el.pageLink.hidden = false;
    } else {
      el.pageLink.hidden = true;
    }
  }

  function renderGrid() {
    el.grid.textContent = '';
    const fragment = document.createDocumentFragment();
    state.images.forEach((item) => fragment.appendChild(createCard(item)));
    el.grid.appendChild(fragment);
    el.empty.hidden = state.images.length > 0;
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.selected = 'true';
    card.dataset.status = 'idle';

    const pick = document.createElement('label');
    pick.className = 'card__pick';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('aria-label', `选择第 ${item.index + 1} 张图片`);
    const pickUi = document.createElement('span');
    pickUi.className = 'card__pick-ui';
    pick.append(box, pickUi);

    const media = document.createElement('div');
    media.className = 'card__media';
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => card.classList.add('is-broken'), { once: true });
    image.src = item.url;
    media.appendChild(image);

    const preview = document.createElement('a');
    preview.className = 'card__preview';
    preview.href = item.url;
    preview.target = '_blank';
    preview.rel = 'noreferrer noopener';
    preview.title = '在新标签页打开原图';
    preview.setAttribute('aria-label', '在新标签页打开原图');
    preview.textContent = '↗';
    preview.addEventListener('click', (event) => event.stopPropagation());
    media.appendChild(preview);

    const info = document.createElement('div');
    info.className = 'card__info';
    const dims = document.createElement('span');
    dims.className = 'card__dims';
    dims.textContent = item.width && item.height ? `${item.width} × ${item.height}` : '尺寸未知';
    const status = document.createElement('span');
    status.className = 'card__status';
    info.append(dims, status);

    card.append(pick, media, info);

    box.addEventListener('change', () => {
      item.selected = box.checked;
      card.dataset.selected = String(item.selected);
      updateSelectionUI();
    });

    card.addEventListener('click', (event) => {
      if (event.target.closest('.card__pick') || event.target.closest('.card__preview')) return;
      item.selected = !item.selected;
      box.checked = item.selected;
      card.dataset.selected = String(item.selected);
      updateSelectionUI();
    });

    item.card = card;
    item.statusEl = status;
    return card;
  }

  function syncCardSelection(item) {
    if (!item.card) return;
    item.card.dataset.selected = String(item.selected);
    const box = item.card.querySelector('.card__pick input');
    if (box) box.checked = item.selected;
  }

  function updateSelectionUI() {
    const total = state.images.length;
    const selected = state.images.filter((item) => item.selected).length;

    el.selectedCount.textContent = `已选 ${selected} / ${total}`;
    const pending = state.images.filter(
      (item) => item.selected && (item.status === 'idle' || item.status === 'failed')
    ).length;
    el.download.disabled = state.running || pending === 0;
    el.download.textContent = selected > 0 ? `下载选中 (${selected})` : '下载选中';

    el.selectAll.checked = total > 0 && selected === total;
    el.selectAll.indeterminate = selected > 0 && selected < total;
  }

  function updateProgress() {
    if (!el.progressText) return;
    const batch = state.batch;
    const pct = batch.total ? Math.round((batch.processed / batch.total) * 100) : 0;
    el.progressBar.style.width = `${pct}%`;
    if (el.progressTrack) el.progressTrack.setAttribute('aria-valuenow', String(pct));

    const selectedImages = state.images.filter((item) => item.selected);
    const done = selectedImages.filter((item) => item.status === 'done').length;
    const failed = selectedImages.filter((item) => item.status === 'failed').length;

    if (state.running) {
      el.progressText.textContent =
        `正在处理 ${batch.processed} / ${batch.total} · 已完成 ${done} 张 · 失败 ${failed} 张`;
      return;
    }

    if (batch.total > 0) {
      const extras = [];
      if (batch.converted) extras.push(`转 PNG ${batch.converted} 张`);
      if (batch.direct) extras.push(`原图直下 ${batch.direct} 张`);
      el.progressText.textContent =
        `本轮已发起 ${batch.total} 张下载${extras.length ? `（${extras.join('，')}）` : ''}` +
        ` · 已完成 ${done} 张${failed ? ` · 失败 ${failed} 张` : ''}`;
      return;
    }

    el.progressText.textContent = '';
  }

  /* ------------------------------------------------------------------ *
   * 批量下载
   * ------------------------------------------------------------------ */

  async function startBatch() {
    if (state.running) return;

    const targets = state.images.filter(
      (item) => item.selected && (item.status === 'idle' || item.status === 'failed')
    );
    if (!targets.length) {
      showBanner('选中的图片都已下载，或没有可下载的项。', 'warn', 3200);
      return;
    }

    const wantPng = el.pngToggle.checked;
    state.running = true;
    state.batch = { total: targets.length, processed: 0, converted: 0, direct: 0 };
    setControlsDisabled(true);
    el.progress.hidden = false;
    updateProgress();
    updateSelectionUI();

    // 必须在用户手势的同一个任务中调用 permissions.request。
    let permissionOK = !wantPng;
    if (wantPng) {
      const origins = uniqueOrigins(targets.map((item) => item.url)).filter(
        (origin) => !state.grantedOrigins.has(origin)
      );
      if (!origins.length) {
        permissionOK = true;
      } else if (chrome.permissions && chrome.permissions.request) {
        try {
          permissionOK = await chrome.permissions.request({ origins });
          if (permissionOK) origins.forEach((origin) => state.grantedOrigins.add(origin));
        } catch (error) {
          console.warn('[ImageGrab] 权限请求失败', error);
          permissionOK = false;
        }
      } else {
        permissionOK = false;
      }
    }

    if (!permissionOK) {
      showBanner('未获得图片域名访问权限，本次直接下载原图，不做 PNG 转换。', 'warn', 9000);
    }

    const options = { convert: permissionOK };
    let cursor = 0;
    const runners = [];
    const count = Math.min(PARALLEL, targets.length);
    for (let i = 0; i < count; i += 1) {
      runners.push((async () => {
        while (cursor < targets.length) {
          const index = cursor;
          cursor += 1;
          await processItem(targets[index], options);
          state.batch.processed += 1;
          updateProgress();
        }
      })());
    }

    await Promise.all(runners);
    state.running = false;
    setControlsDisabled(false);
    updateSelectionUI();
    updateProgress();

    const failed = state.images.filter((item) => item.selected && item.status === 'failed').length;
    const done = state.images.filter((item) => item.selected && item.status === 'done').length;
    const extras = [];
    if (state.batch.converted) extras.push(`转 PNG ${state.batch.converted} 张`);
    if (state.batch.direct) extras.push(`原图直下 ${state.batch.direct} 张`);
    showBanner(
      `已发起 ${state.batch.total} 张下载${extras.length ? `（${extras.join('，')}）` : ''}` +
        ` · 已完成 ${done} 张${failed ? ` · 失败 ${failed} 张` : ''}`,
      failed ? 'warn' : 'ok',
      9000
    );
  }

  function setControlsDisabled(disabled) {
    el.selectAll.disabled = disabled;
    el.invert.disabled = disabled;
    el.pngToggle.disabled = disabled;
    el.download.disabled = disabled;
    if (el.hint) el.hint.classList.toggle('is-muted', disabled);
  }

  async function processItem(item, options) {
    if (item.status === 'done' || item.status === 'downloading') return;

    setStatus(item, 'working');
    item.converted = false;
    item.direct = false;
    const base = filenameBase(item);

    try {
      if (!options.convert) {
        await startUrlDownload(item, `${base}.${extFromUrl(item.url)}`);
        state.batch.direct += 1;
        item.direct = true;
        setStatus(item, 'downloading', '原图直下');
        return;
      }

      let fetched;
      try {
        fetched = await fetchImage(item.url);
      } catch (error) {
        console.warn('[ImageGrab] 读取图片失败，改为直连下载', item.url, error);
        await startUrlDownload(item, `${base}.${extFromUrl(item.url)}`);
        state.batch.direct += 1;
        item.direct = true;
        setStatus(item, 'downloading', '直连下载');
        return;
      }

      const mime = normalizeMime(fetched.blob.type || fetched.contentType, item.url);
      if (!(await isImageBlob(fetched.blob))) {
        throw new Error('服务器返回的不是图片内容');
      }

      if (mime === 'image/png') {
        await startBlobDownload(item, fetched.blob, `${base}.png`);
        setStatus(item, 'downloading', 'PNG 原图');
        return;
      }

      if (mime === 'image/gif' || mime === 'image/svg+xml') {
        await startBlobDownload(item, fetched.blob, `${base}.${extFromMime(mime)}`);
        state.batch.direct += 1;
        item.direct = true;
        setStatus(item, 'downloading', '保留原格式');
        return;
      }

      setStatus(item, 'working', '转换为 PNG…');
      let png = null;
      try {
        png = await toPng(fetched.blob);
      } catch (error) {
        console.warn('[ImageGrab] PNG 转换失败', item.url, error);
      }

      if (png) {
        await startBlobDownload(item, png, `${base}.png`);
        state.batch.converted += 1;
        item.converted = true;
        setStatus(item, 'downloading', '已转 PNG');
      } else {
        await startBlobDownload(item, fetched.blob, `${base}.${extFromMime(mime)}`);
        state.batch.direct += 1;
        item.direct = true;
        setStatus(item, 'downloading', '原格式下载');
      }
    } catch (error) {
      console.warn('[ImageGrab] 下载失败', item.url, error);
      setStatus(item, 'failed', '下载失败');
      if (item.statusEl) item.statusEl.title = (error && error.message) || String(error);
    }
  }

  function setStatus(item, status, note) {
    item.status = status;
    if (note !== undefined) item.note = note;
    if (item.card) item.card.dataset.status = status;
    if (item.statusEl) {
      item.statusEl.textContent = note || STATUS_TEXT[status] || '';
      item.statusEl.dataset.status = status;
    }
  }

  /* ------------------------------------------------------------------ *
   * 下载实现
   * ------------------------------------------------------------------ */

  function registerDownloadWatcher() {
    const downloads = typeof chrome !== 'undefined' ? chrome.downloads : null;
    const onChanged = downloads && downloads.onChanged;
    if (!onChanged || !onChanged.addListener) return;
    onChanged.addListener((delta) => {
      if (!delta) return;
      const item = state.byDownloadId.get(delta.id);
      if (!item) return;
      const current = delta.state && delta.state.current;
      if (current === 'complete') {
        setStatus(item, 'done', item.note || '已下载');
        releaseObjectUrl(delta.id);
        updateProgress();
      } else if (current === 'interrupted') {
        setStatus(item, 'failed', '下载中断');
        releaseObjectUrl(delta.id);
        updateProgress();
      }
    });
  }

  async function startBlobDownload(item, blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    state.objectUrls.set(downloadId, objectUrl);
    trackDownload(downloadId, item);
    setTimeout(() => releaseObjectUrl(downloadId), OBJECT_URL_TTL);
    return downloadId;
  }

  async function startUrlDownload(item, filename) {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    trackDownload(downloadId, item);
    return downloadId;
  }

  function trackDownload(downloadId, item) {
    item.downloadId = downloadId;
    state.byDownloadId.set(downloadId, item);
    // 极小的图片可能在监听生效前就下载完成，补一次状态查询。
    setTimeout(() => {
      void verifyDownload(downloadId);
    }, 1500);
  }

  async function verifyDownload(downloadId) {
    const item = state.byDownloadId.get(downloadId);
    if (!item || item.status !== 'downloading') return;
    if (!chrome.downloads || !chrome.downloads.search) return;
    try {
      const found = await chrome.downloads.search({ id: downloadId });
      const record = Array.isArray(found) ? found[0] : null;
      if (!record) return;
      if (record.state === 'complete') {
        setStatus(item, 'done', item.note || '已下载');
        releaseObjectUrl(downloadId);
        updateProgress();
      } else if (record.state === 'interrupted') {
        setStatus(item, 'failed', '下载中断');
        releaseObjectUrl(downloadId);
        updateProgress();
      }
    } catch (error) {
      /* 状态补偿是尽力而为 */
    }
  }

  function releaseObjectUrl(downloadId) {
    const objectUrl = state.objectUrls.get(downloadId);
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    state.objectUrls.delete(downloadId);
  }

  async function fetchImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        cache: 'force-cache',
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error('图片内容为空');
      return { blob, contentType: response.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  }

  // 防盗链失败时 CDN 往往返回 200 + HTML，不能把它当图片下载。
  async function isImageBlob(blob) {
    const declared = String(blob.type || '').toLowerCase();
    if (declared.indexOf('image/') === 0) return true;

    let head;
    try {
      head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    } catch (error) {
      return false;
    }
    if (head.length < 4) return false;

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return true; // GIF
    if (head[0] === 0x42 && head[1] === 0x4d) return true; // BMP
    if (
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    ) {
      return true; // WEBP
    }
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true; // AVIF/HEIC
    return false;
  }

  /* ------------------------------------------------------------------ *
   * PNG 转换
   * ------------------------------------------------------------------ */

  async function toPng(blob) {
    const decoded = await decodeImage(blob);
    try {
      const { source, width, height } = decoded;
      if (!width || !height) throw new Error('无法读取图片尺寸');
      if (width * height > MAX_PIXELS) return null;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器不支持 Canvas 2D');
      context.drawImage(source, 0, 0, width, height);

      const png = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('PNG 编码失败'));
        }, 'image/png');
      });

      canvas.width = 0;
      canvas.height = 0;
      return png;
    } finally {
      decoded.dispose();
    }
  }

  async function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          dispose: () => {
            try {
              bitmap.close();
            } catch (error) {
              /* 忽略 */
            }
          },
        };
      } catch (error) {
        /* 退回 <img> 解码 */
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.onerror = () => reject(new Error('图片解码失败'));
        node.src = objectUrl;
      });
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(objectUrl),
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  /* ------------------------------------------------------------------ *
   * 格式化与工具
   * ------------------------------------------------------------------ */

  function filenameBase(item) {
    const site = sanitizeSegment(state.capture.siteId || 'images', 'images');
    const title = sanitizeSegment(state.capture.title || 'image', 'image').slice(0, 60);
    const seq = String(item.index + 1).padStart(3, '0');
    return `ImageGrab/${site}/${title}-${seq}`;
  }

  function sanitizeSegment(input, fallback) {
    let value = String(input || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    value = value.replace(/^[.\s]+|[.\s]+$/g, '');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
    if (!value) value = fallback;
    return value.slice(0, 80);
  }

  function extFromUrl(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const match = /\.([a-z0-9]{2,5})$/.exec(path);
      const ext = match ? match[1] : '';
      if (/^(?:jpe?g|png|webp|gif|avif|bmp)$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    } catch (error) {
      /* 忽略 */
    }
    return 'jpg';
  }

  function extFromMime(mime) {
    return EXT_BY_MIME[mime] || 'jpg';
  }

  function normalizeMime(type, url) {
    const clean = String(type || '').split(';')[0].trim().toLowerCase();
    if (clean.indexOf('image/') === 0) return clean;
    const ext = extFromUrl(url);
    return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  }

  function uniqueOrigins(urls) {
    const origins = new Set();
    for (const raw of urls) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        origins.add(`${url.protocol}//${url.hostname}/*`);
      } catch (error) {
        /* 忽略无效 URL */
      }
    }
    return Array.from(origins);
  }

  function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!value) return '';
    try {
      return new Date(value).toLocaleString('zh-CN', { hour12: false });
    } catch (error) {
      return '';
    }
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function showBanner(message, type, timeout) {
    if (!el.banner) return;
    clearTimeout(state.bannerTimer);
    const token = (state.bannerToken = (state.bannerToken || 0) + 1);
    el.banner.hidden = false;
    el.banner.textContent = message;
    el.banner.dataset.type = type || 'ok';
    requestAnimationFrame(() => el.banner.classList.add('is-visible'));
    state.bannerTimer = setTimeout(() => {
      if (state.bannerToken !== token) return;
      el.banner.classList.remove('is-visible');
      setTimeout(() => {
        if (state.bannerToken === token) el.banner.hidden = true;
      }, 220);
    }, timeout || 6000);
  }
})();

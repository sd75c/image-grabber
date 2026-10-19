/* 图提取 ImageGrab — content script
 *
 * 职责：
 *  1. 只在受支持的商品详情页挂载右下角浮动按钮；
 *  2. 点击后从 img / srcset / 懒加载属性 / background-image 中收集候选 URL；
 *  3. 预加载候选图片拿到真实尺寸，过滤小图、图标、占位图并按商品图优先排序；
 *  4. 把结果发给 service worker，由它写入 session storage 并打开画廊标签页。
 *
 * 注意：本文件由 manifest 注入，运行在 content script 的隔离世界中。
 */
(() => {
  'use strict';

  if (window.__IMAGE_GRAB_CONTENT__) return;
  window.__IMAGE_GRAB_CONTENT__ = true;

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  const MAX_CANDIDATES = 300;
  const MAX_MEASURE = 120;
  const MAX_RESULTS = 120;
  const MEASURE_CONCURRENCY = 8;
  const MEASURE_TIMEOUT = 6000;

  // 尺寸门槛：过滤图标、小缩略图，同时保留 750x100 这类详情长图切片。
  const MIN_AREA = 60000;
  const MIN_EDGE = 80;
  const MIN_LONG_EDGE = 300;

  const LAZY_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-origin',
    'data-lazy-img',
    'data-ks-lazyload',
    'data-actualsrc',
    'data-echo',
    'data-org-src',
  ];

  // 只对文件名做关键词过滤，避免误伤带查询参数的正常图片。
  const BAD_NAME = /(?:sprite|spacer|placeholder|transparent|loading|lazyload|qrcode|erweima|avatar|nopic|noimg|no[-_]image|default[-_](?:img|pic|image|avatar|logo)|1x1|2x2|blank\.(?:gif|png|jpe?g)|pixel\.(?:gif|png))|(?:^|[/_.-])(?:logo|icon|icons|iconfont)(?:[/_.-]|$)/i;

  const CDN_HOST = /(?:^|\.)(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn|360buyimg\.com|jdimg\.com|jd\.com|pddpic\.com|yangkeduo\.com|pinduoduo\.com)$/i;

  const ICON_SVG = [
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M12 3v11"></path>',
    '<path d="M7.5 10.5 12 15l4.5-4.5"></path>',
    '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>',
    '</svg>',
  ].join('');

  /* ------------------------------------------------------------------ *
   * 站点适配
   * ------------------------------------------------------------------ */

  const ALI_SELECTORS = [
    '#J_ImgBooth',
    '#J_UlThumb img',
    '.tb-thumb img',
    '.tb-gallery img',
    '#J_DivItemDesc img',
    '#description img',
    '[class*="PicGallery"] img',
    '[class*="mainPic"] img',
    '[class*="MainPic"] img',
    '[class*="thumbnail"] img',
    '[class*="Thumbnail"] img',
    '[class*="detailContent"] img',
    '[class*="DetailContent"] img',
    '[class*="descV8"] img',
  ];

  const SITES = [
    {
      id: 'taobao',
      name: '淘宝 / 天猫',
      test(loc) {
        const host = loc.hostname.toLowerCase();
        if (!/(^|\.)(taobao\.com|tmall\.com|tmall\.hk)$/.test(host)) return false;
        if (/^\/item\.htm$/i.test(loc.pathname)) return true;
        return loc.searchParams.has('id') && /^\/(?:item|detail)\.htm$/i.test(loc.pathname);
      },
      selectors: ALI_SELECTORS,
      bgSelectors: [
        '[class*="PicGallery"]',
        '[class*="thumbnails"]',
        '[class*="Thumbnail"]',
        '.tb-gallery',
      ],
    },
    {
      id: 'jd',
      name: '京东',
      test(loc) {
        const host = loc.hostname.toLowerCase();
        if (!/(^|\.)(jd\.com|jd\.hk)$/.test(host)) return false;
        return /^\/(?:product\/)?\d+\.html$/.test(loc.pathname);
      },
      selectors: [
        '#spec-img',
        '#spec-list img',
        '.spec-items img',
        '#preview img',
        '#J_UlThumb img',
        '#J-detail-content img',
        '.detail-content img',
        '[class*="preview"] img',
        '[class*="thumb"] img',
      ],
      bgSelectors: ['#spec-list', '.spec-items'],
    },
    {
      id: 'pdd',
      name: '拼多多',
      test(loc) {
        const host = loc.hostname.toLowerCase();
        if (!/(^|\.)(yangkeduo\.com|pinduoduo\.com)$/.test(host)) return false;
        const hasGoodsId = loc.searchParams.has('goods_id') || loc.searchParams.has('goodsId');
        return hasGoodsId || /\/goods\d*(?:_detail)?\.html$/i.test(loc.pathname);
      },
      selectors: [
        '[class*="goods"] img',
        '[class*="Goods"] img',
        '[class*="banner"] img',
        '[class*="Banner"] img',
        '[class*="swiper"] img',
        '[class*="Swiper"] img',
        '[class*="carousel"] img',
        '[class*="detail"] img',
        '[class*="thumb"] img',
        'img[src*="pddpic"]',
        'img[data-src*="pddpic"]',
      ],
      bgSelectors: [
        '[class*="banner"]',
        '[class*="Banner"]',
        '[class*="swiper"]',
        '[class*="Swiper"]',
        '[class*="carousel"]',
        '[class*="thumb"]',
      ],
    },
  ];

  function detectSite() {
    if (globalThis.__IMAGEGRAB_TEST_HOOK__ && globalThis.__IMAGEGRAB_TEST_SITE__) {
      return globalThis.__IMAGEGRAB_TEST_SITE__;
    }
    let loc;
    try {
      loc = new URL(location.href);
    } catch (error) {
      return null;
    }
    for (const site of SITES) {
      try {
        if (site.test(loc)) {
          const isTmall = site.id === 'taobao' && /tmall/i.test(loc.hostname);
          return isTmall ? Object.assign({}, site, { name: '天猫' }) : site;
        }
      } catch (error) {
        /* 单个适配器异常不影响其他站点 */
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * URL 处理与过滤
   * ------------------------------------------------------------------ */

  function normalizeUrl(raw) {
    if (!raw) return null;
    let value = String(raw).trim().replace(/^['"]|['"]$/g, '');
    value = value.replace(/&amp;/g, '&');
    if (!value) return null;
    if (/^(?:data|blob|javascript|about|chrome-extension|moz-extension):/i.test(value)) return null;
    if (value.startsWith('//')) value = 'https:' + value;
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (url.protocol === 'http:' && CDN_HOST.test(url.hostname)) url.protocol = 'https:';
      url.hash = '';
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function isProbablyImage(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (/\.(?:svg|ico)$/.test(path)) return false;
      if (BAD_NAME.test(path)) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  // 把同一张图的缩略图/原图变体归到同一个 key，保留尺寸最大的那个 URL。
  function dedupeKey(url) {
    const parsed = new URL(url);
    const cdn = parsed.hostname.toLowerCase().match(
      /(?:^|\.)((?:alicdn|taobaocdn|tbcdn|360buyimg|jdimg|pddpic|yangkeduo|pinduoduo|jd)\.(?:com|cn|net))$/i
    );

    let path = parsed.pathname;
    // Alicdn: xxx.jpg_430x430q90.jpg  -> xxx.jpg
    path = path.replace(/(\.(?:jpe?g|png|webp|gif|avif|bmp))_[^/]+$/i, '$1');
    // JD: /n0/、/n1/s450x450_jfs/ 等尺寸目录统一成 /jfs/
    path = path.replace(/^\/n\d+\//i, '/');
    path = path.replace(/^\/s\d+x\d+_jfs\//i, '/jfs/');
    // JD: xxx.jpg!q70.dpg -> xxx.jpg
    path = path.replace(/(\.(?:jpe?g|png|webp|gif|avif))![^/]*$/i, '$1');

    let query = '';
    if (!cdn) {
      const params = [];
      parsed.searchParams.forEach((value, key) => {
        if (/^(?:utm_[\w-]+|spm|scm|from|source|ref|width|height|w|h|q|quality|size|thumbnail|thumb|resize)$/i.test(key)) return;
        params.push([key, value]);
      });
      params.sort((a, b) => a[0].localeCompare(b[0]));
      query = params.map((pair) => `${pair[0]}=${pair[1]}`).join('&');
    }

    const host = cdn ? cdn[1].toLowerCase() : parsed.hostname.toLowerCase();
    let decodedPath = path;
    try {
      decodedPath = decodeURIComponent(path);
    } catch (error) {
      decodedPath = path;
    }
    return `${host}${decodedPath}?${query}`;
  }

  // 判断一个 URL 更像原图还是被 CDN 缩放过的缩略图。
  // 只对识别得出的 CDN 给结论，其余返回 unknown，避免误判导致下载错图。
  function urlQuality(raw) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (error) {
      return 'unknown';
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    const query = parsed.search;

    // 阿里 CDN 的尺寸后缀：xxx.jpg_430x430q90.jpg
    if (/(?:alicdn|taobaocdn|tbcdn)\./i.test(host) && /_\d+x\d+[^/]*$/i.test(path)) {
      return 'resized';
    }
    // 京东：/n1/s450x450_jfs/... 与 /n0/jfs/...
    if (/(?:360buyimg|jdimg)\./i.test(host)) {
      if (/\/s\d+x\d+_jfs\//i.test(path) || /^\/n[1-9]\d*\//i.test(path)) return 'resized';
      if (/^\/n0\//i.test(path) || /\/jfs\//i.test(path)) return 'original';
      return 'unknown';
    }
    // 拼多多 / 七牛等常见缩放参数
    if (/(?:imageView2|imageMogr2|\/w\/\d+|\/h\/\d+)/i.test(query)) return 'resized';
    if (/[?&](?:w|width|h|height|size|thumbnail|thumb|resize)=/i.test(query)) return 'resized';

    if (CDN_HOST.test(host) && /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(path)) {
      return 'original';
    }
    return 'unknown';
  }

  function parseSrcset(value) {
    if (!value) return null;
    let best = null;
    let bestScore = -1;
    for (const part of String(value).split(',')) {
      const segment = part.trim();
      if (!segment) continue;
      const bits = segment.split(/\s+/);
      const url = bits[0];
      if (!url) continue;
      const descriptor = bits[1] || '';
      let score = 1;
      if (/w$/i.test(descriptor)) score = parseInt(descriptor, 10) || 1;
      else if (/x$/i.test(descriptor)) score = (parseFloat(descriptor) || 1) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  function isBigEnough(width, height) {
    if (!width || !height) return false;
    const area = width * height;
    const minEdge = Math.min(width, height);
    const maxEdge = Math.max(width, height);
    return area >= MIN_AREA && minEdge >= MIN_EDGE && maxEdge >= MIN_LONG_EDGE;
  }

  function measureImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve({ ok, w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      };
      const timer = setTimeout(() => finish(false), MEASURE_TIMEOUT);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.decoding = 'async';
      img.src = url;
    });
  }

  async function runPool(items, limit, worker) {
    let cursor = 0;
    const size = Math.max(1, Math.min(limit, items.length));
    const runners = [];
    for (let i = 0; i < size; i += 1) {
      runners.push((async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  /* ------------------------------------------------------------------ *
   * 图片扫描
   * ------------------------------------------------------------------ */

  async function captureImages(site, onProgress) {
    const candidates = new Map();

    const add = (raw, priority, source, dims) => {
      const url = normalizeUrl(raw);
      if (!url || !isProbablyImage(url)) return;

      let key;
      try {
        key = dedupeKey(url);
      } catch (error) {
        return;
      }

      const previous = candidates.get(key);
      if (previous) {
        if (priority < previous.priority) {
          previous.priority = priority;
          previous.source = source;
        }

        const incomingQuality = urlQuality(url);
        const previousQuality = urlQuality(previous.url);
        const hasDims = Boolean(dims && dims.w > 0 && dims.h > 0);

        // 同一个 key 下优先保留原图；已有原图时不再被缩略图覆盖。
        if (incomingQuality === 'original' && previousQuality === 'resized') {
          if (previous.width > 0 && previous.height > 0 && isBigEnough(previous.width, previous.height)) {
            previous.fallback = {
              url: previous.url,
              width: previous.width,
              height: previous.height,
              source: previous.source,
            };
          }
          previous.url = url;
          previous.source = source;
          previous.width = hasDims ? dims.w : 0;
          previous.height = hasDims ? dims.h : 0;
          return;
        }
        if (incomingQuality !== 'original' && previousQuality === 'original') return;

        if (hasDims) {
          const oldArea = (previous.width || 0) * (previous.height || 0);
          const newArea = dims.w * dims.h;
          // 旧地址尺寸未知时，不让已知的小缩略图把它顶掉（未知的更可能是原图）。
          if (oldArea === 0 ? isBigEnough(dims.w, dims.h) : newArea > oldArea) {
            previous.url = url;
            previous.width = dims.w;
            previous.height = dims.h;
            previous.source = source;
          }
        } else if (previous.width > 0 && previous.height > 0 && !isBigEnough(previous.width, previous.height)) {
          // 已知当前变体过小，换成尺寸未知的新地址重新测量。
          previous.url = url;
          previous.width = 0;
          previous.height = 0;
          previous.source = source;
        }
        return;
      }

      if (candidates.size >= MAX_CANDIDATES) return;
      candidates.set(key, {
        url,
        key,
        priority,
        source,
        width: (dims && dims.w) || 0,
        height: (dims && dims.h) || 0,
      });
    };

    const addImageElement = (img, priority) => {
      if (!img || img.tagName !== 'IMG') return;

      // 有 srcset 时只取最大候选并交给预加载测量真实尺寸：
      // naturalWidth 在 srcset + sizes 下会被密度修正，不能直接当作原图尺寸。
      if (img.getAttribute('srcset')) {
        add(parseSrcset(img.getAttribute('srcset')), priority, 'srcset');
      } else {
        const known = img.complete && img.naturalWidth > 0
          ? { w: img.naturalWidth, h: img.naturalHeight }
          : null;
        add(img.currentSrc || img.getAttribute('src'), priority, 'src', known);
      }

      for (const attr of LAZY_ATTRS) {
        const value = img.getAttribute(attr);
        if (value) add(value, priority, attr);
      }
    };

    // 1) 站点主图/缩略图/详情图容器，优先级最高。
    for (const selector of site.selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        continue;
      }
      nodes.forEach((node) => {
        if (node.tagName === 'IMG') {
          addImageElement(node, 1);
        } else if (node.querySelectorAll) {
          node.querySelectorAll('img').forEach((img) => addImageElement(img, 1));
        }
      });
    }

    // 2) 全页 img 与 picture > source，作为兜底。
    document.querySelectorAll('img').forEach((img) => addImageElement(img, 2));
    document.querySelectorAll('picture source[srcset]').forEach((source) => {
      add(parseSrcset(source.getAttribute('srcset')), 2, 'srcset');
    });

    // 3) background-image：先扫站点容器，再扫内联样式和常见类名。
    const seenElements = new WeakSet();
    const inspectBackground = (element, priority) => {
      if (!element || seenElements.has(element)) return;
      seenElements.add(element);

      let rect;
      try {
        rect = element.getBoundingClientRect();
      } catch (error) {
        return;
      }
      if (rect.width < 60 || rect.height < 60) return;

      let background;
      try {
        background = getComputedStyle(element).backgroundImage;
      } catch (error) {
        return;
      }
      if (!background || background === 'none' || background.indexOf('url(') === -1) return;

      const matcher = /url\((['"]?)([^'")]+)\1\)/g;
      let match = matcher.exec(background);
      while (match) {
        add(match[2], priority, 'background-image');
        match = matcher.exec(background);
      }
    };

    for (const selector of site.bgSelectors || []) {
      try {
        document.querySelectorAll(selector).forEach((element) => inspectBackground(element, 1));
      } catch (error) {
        /* 忽略无效选择器 */
      }
    }

    try {
      document.querySelectorAll('[style*="background-image"],[style*="background:"]').forEach((element) => {
        inspectBackground(element, 2);
      });
    } catch (error) {
      /* 忽略 */
    }

    const heuristicSelector = [
      '[class*="thumb"]',
      '[class*="Thumb"]',
      '[class*="swiper"]',
      '[class*="Swiper"]',
      '[class*="banner"]',
      '[class*="Banner"]',
      '[class*="carousel"]',
      '[class*="slide"]',
      '[class*="pic"]',
    ].join(',');
    try {
      let count = 0;
      document.querySelectorAll(heuristicSelector).forEach((element) => {
        if (count >= 1500) return;
        count += 1;
        inspectBackground(element, 2);
      });
    } catch (error) {
      /* 忽略 */
    }

    // 4) 商品图优先，其次按已知面积从大到小。
    const primary = [];
    const secondary = [];
    for (const candidate of candidates.values()) {
      if (candidate.priority === 1) primary.push(candidate);
      else secondary.push(candidate);
    }
    const picked = primary.concat(secondary).slice(0, MAX_MEASURE);

    // 5) 未知尺寸的候选通过预加载测量（并发受限，带超时）。
    const toMeasure = picked.filter((item) => !(item.width > 0 && item.height > 0));
    let measured = 0;
    if (onProgress && toMeasure.length > 0) onProgress(0, toMeasure.length);

    await runPool(toMeasure, MEASURE_CONCURRENCY, async (item) => {
      const result = await measureImage(item.url);
      measured += 1;
      if (result.ok) {
        item.width = result.w;
        item.height = result.h;
      } else {
        item.failed = true;
      }
      if (onProgress && (measured % 4 === 0 || measured === toMeasure.length)) {
        onProgress(measured, toMeasure.length);
      }
    });

    // 6) 过滤与排序。
    const kept = [];
    for (const item of picked) {
      // 原图地址测量失败或反而更小时，退回之前已知可用的变体。
      if (item.fallback) {
        const fallbackUsable = isBigEnough(item.fallback.width, item.fallback.height);
        const currentUsable = item.width > 0 && item.height > 0 && isBigEnough(item.width, item.height);
        if (fallbackUsable && !currentUsable) {
          item.url = item.fallback.url;
          item.width = item.fallback.width;
          item.height = item.fallback.height;
          item.source = item.fallback.source;
          item.failed = false;
        }
      }

      if (item.width > 0 && item.height > 0) {
        if (isBigEnough(item.width, item.height)) kept.push(item);
        continue;
      }
      // 站点主图即使预加载失败也保留（可能有防盗链，下载仍可能成功）。
      if (item.priority === 1) {
        try {
          if (CDN_HOST.test(new URL(item.url).hostname)) kept.push(item);
        } catch (error) {
          /* 忽略 */
        }
      }
    }

    kept.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.width * b.height) - (a.width * a.height);
    });

    const images = kept.slice(0, MAX_RESULTS).map((item) => ({
      url: item.url,
      width: item.width || 0,
      height: item.height || 0,
      source: item.source,
      unknown: !(item.width > 0 && item.height > 0),
    }));

    return {
      siteId: site.id,
      siteName: site.name,
      pageUrl: location.href,
      title: document.title,
      capturedAt: Date.now(),
      stats: {
        scanned: candidates.size,
        measured: toMeasure.length,
        kept: images.length,
      },
      images,
    };
  }

  /* ------------------------------------------------------------------ *
   * 浮动按钮 UI
   * ------------------------------------------------------------------ */

  let ui = null;
  let busy = false;
  let lastHref = location.href;

  function mountUI() {
    if (ui || !document.body) return;

    const host = document.createElement('div');
    host.id = 'igrab-host';
    host.innerHTML = [
      '<div class="igrab-wrap">',
      '  <div class="igrab-toast" role="status" aria-live="polite" hidden></div>',
      '  <button class="igrab-fab" type="button" aria-label="获取当前商品页图片">',
      '    <span class="igrab-spinner" aria-hidden="true"></span>',
      `    <span class="igrab-icon" aria-hidden="true">${ICON_SVG}</span>`,
      '    <span class="igrab-label">获取图片</span>',
      '    <span class="igrab-count" hidden>0</span>',
      '  </button>',
      '</div>',
    ].join('');
    document.body.appendChild(host);

    const wrap = host.querySelector('.igrab-wrap');
    ui = {
      host,
      fab: host.querySelector('.igrab-fab'),
      label: host.querySelector('.igrab-label'),
      count: host.querySelector('.igrab-count'),
      toast: host.querySelector('.igrab-toast'),
      toastTimer: 0,
      toastToken: 0,
    };

    ui.fab.addEventListener('click', () => {
      void handleGrab();
    });
    // 下一帧触发出场动画
    requestAnimationFrame(() => {
      if (ui) ui.fab.classList.add('is-in');
    });
  }

  function removeUI() {
    if (!ui) return;
    clearTimeout(ui.toastTimer);
    ui.host.remove();
    ui = null;
  }

  function setFabMode(mode, count) {
    if (!ui) return;
    ui.fab.disabled = mode === 'scanning';
    ui.fab.classList.toggle('is-scanning', mode === 'scanning');
    ui.fab.classList.toggle('is-done', mode === 'done');
    ui.fab.setAttribute('aria-busy', mode === 'scanning' ? 'true' : 'false');
    if (mode === 'scanning') ui.label.textContent = '扫描中…';
    else if (mode === 'done') ui.label.textContent = '已获取';
    else ui.label.textContent = '获取图片';
    if (typeof count === 'number') {
      ui.count.hidden = count <= 0;
      ui.count.textContent = count > 999 ? '999+' : String(count);
    }
  }

  function toast(message, type) {
    if (!ui) return;
    const node = ui.toast;
    const token = (ui.toastToken = (ui.toastToken || 0) + 1);
    node.textContent = message;
    node.hidden = false;
    node.classList.toggle('is-error', type === 'error');
    requestAnimationFrame(() => node.classList.add('is-visible'));
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      if (!ui || ui.toastToken !== token) return;
      node.classList.remove('is-visible');
      setTimeout(() => {
        if (ui && ui.toast === node && ui.toastToken === token) node.hidden = true;
      }, 220);
    }, type === 'error' ? 5200 : 3200);
  }

  function friendlyError(error) {
    const message = String((error && error.message) || error || '未知错误');
    if (/context invalidated|Extension context/i.test(message)) {
      return '插件已更新或重新加载，请刷新页面后重试';
    }
    if (/Receiving end does not exist/i.test(message)) {
      return '后台服务未响应，请刷新页面后重试';
    }
    return '处理失败：' + message;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      // 后台标签页里 rAF 可能被暂停，用定时器兜底，避免扫描一直卡在「扫描中」。
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 150);
    });
  }

  async function handleGrab() {
    if (busy || !ui) return;
    const site = detectSite();
    if (!site) {
      toast('当前页面不是受支持的商品详情页', 'error');
      return;
    }

    busy = true;
    setFabMode('scanning');
    await nextPaint();

    try {
      const payload = await captureImages(site, (done, total) => {
        if (!ui) return;
        ui.label.textContent = `扫描中 ${done}/${total}`;
      });

      if (!payload.images.length) {
        setFabMode('idle', 0);
        toast('没有找到符合条件的图片。先滚动页面让图片加载，再重试。', 'error');
        return;
      }

      const result = await chrome.runtime.sendMessage({
        type: 'IGRAB_CAPTURE',
        payload,
      });

      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || '打开图片画廊失败');
      }

      setFabMode('done', payload.images.length);
      toast(`已提取 ${payload.images.length} 张图片`);
      setTimeout(() => {
        if (ui && !busy) setFabMode('idle');
      }, 2600);
    } catch (error) {
      console.error('[ImageGrab] 提取失败', error);
      setFabMode('idle');
      toast(friendlyError(error), 'error');
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 启动与 SPA 导航监听
   * ------------------------------------------------------------------ */

  function syncPage() {
    const site = detectSite();
    if (!site) {
      removeUI();
      return;
    }
    if (!ui) mountUI();
    else if (!ui.host.isConnected) document.body.appendChild(ui.host);
  }

  const runtime = typeof chrome !== 'undefined' && chrome.runtime;
  if (runtime && runtime.onMessage && runtime.onMessage.addListener) {
    runtime.onMessage.addListener((message) => {
      if (message && message.type === 'IGRAB_TRIGGER') {
        void handleGrab();
      }
    });
  }

  syncPage();
  window.addEventListener('pageshow', syncPage);

  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncPage();
      return;
    }
    if (ui && !ui.host.isConnected && document.body) {
      document.body.appendChild(ui.host);
    }
  }, 1000);

  // 开发/自测钩子：只有测试页会预先设置该标记。
  if (globalThis.__IMAGEGRAB_TEST_HOOK__) {
    globalThis.__IMAGEGRAB_TEST__ = {
      captureImages,
      detectSite,
      normalizeUrl,
      dedupeKey,
      urlQuality,
      parseSrcset,
      isBigEnough,
    };
  }
})();

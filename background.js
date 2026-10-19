/* 图提取 ImageGrab — service worker
 *
 * 内容脚本不能直接打开扩展页面，因此由这里：
 *  1. 接收提取结果，写入 chrome.storage.session（短期保存，关闭浏览器即清空）；
 *  2. 打开 gallery.html?id=...；
 *  3. 顺手在工具栏图标上显示本次提取数量；
 *  4. 响应工具栏图标点击，转发一次扫描指令。
 */

'use strict';

const CAPTURE_PREFIX = 'capture:';
const MAX_CAPTURES = 5;
const MAX_IMAGES = 200;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'IGRAB_CAPTURE') {
    handleCapture(message.payload, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('[ImageGrab] 保存提取结果失败', error);
        sendResponse({ ok: false, error: (error && error.message) || String(error) });
      });
    return true; // 异步 sendResponse
  }

  return undefined;
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  chrome.tabs.sendMessage(tab.id, { type: 'IGRAB_TRIGGER' }).catch(() => {
    flashBadge(tab.id, '!');
  });
});

chrome.runtime.onInstalled.addListener(() => {
  // 清空可能残留的旧版本提取结果。
  storageArea()
    .get(null)
    .then((all) => {
      const keys = Object.keys(all || {}).filter((key) => key.startsWith(CAPTURE_PREFIX));
      if (keys.length) return storageArea().remove(keys);
      return undefined;
    })
    .catch(() => {});
});

/* ------------------------------------------------------------------ */

function storageArea() {
  // storage.session 需要 Chrome 102+；缺失时退回 local，画廊页也做了同样回退。
  return chrome.storage.session || chrome.storage.local;
}

async function handleCapture(payload, sender) {
  if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
    throw new Error('没有可展示的图片');
  }

  const images = payload.images
    .slice(0, MAX_IMAGES)
    .map((image) => ({
      url: String((image && image.url) || ''),
      width: Number(image && image.width) || 0,
      height: Number(image && image.height) || 0,
      source: String((image && image.source) || ''),
      unknown: Boolean(image && image.unknown),
    }))
    .filter((image) => /^https?:\/\//i.test(image.url));

  if (!images.length) throw new Error('图片地址无效');

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    siteId: String(payload.siteId || ''),
    siteName: String(payload.siteName || ''),
    pageUrl: String(payload.pageUrl || ''),
    title: String(payload.title || ''),
    capturedAt: Number(payload.capturedAt) || Date.now(),
    stats: payload.stats && typeof payload.stats === 'object' ? payload.stats : {},
    images,
  };

  const key = CAPTURE_PREFIX + id;
  await storageArea().set({ [key]: record });
  await pruneOldCaptures(id);

  const galleryUrl = `${chrome.runtime.getURL('gallery.html')}?id=${encodeURIComponent(id)}`;
  await chrome.tabs.create({ url: galleryUrl, active: true });

  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId === 'number') {
    const text = images.length > 99 ? '99+' : String(images.length);
    try {
      await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5', tabId });
      await chrome.action.setBadgeText({ text, tabId });
    } catch (error) {
      /* 角标失败不影响主流程 */
    }
  }

  return { ok: true, id, count: images.length };
}

async function pruneOldCaptures(currentId) {
  const area = storageArea();
  const all = await area.get(null);
  const currentKey = CAPTURE_PREFIX + currentId;
  const stale = Object.keys(all || {})
    .filter((key) => key.startsWith(CAPTURE_PREFIX) && key !== currentKey)
    .sort((a, b) => ((all[b] && all[b].capturedAt) || 0) - ((all[a] && all[a].capturedAt) || 0))
    .slice(MAX_CAPTURES - 1);

  if (stale.length) await area.remove(stale);
}

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c', tabId });
    await chrome.action.setBadgeText({ text, tabId });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    }, 2500);
  } catch (error) {
    /* 忽略 */
  }
}

/* 仅用于开发：在 Node 中用桩对象验证 background.js 的消息处理 / 存储 / 清理逻辑。
 * 运行：node tools/background-harness.js
 */

'use strict';

const path = require('path');
const assert = require('assert');

const storageData = new Map();
const createdTabs = [];
const badges = [];
let messageListener = null;

function makeArea() {
  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(storageData.entries());
      }
      if (typeof keys === 'string') {
        return storageData.has(keys) ? { [keys]: storageData.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const result = {};
        keys.forEach((key) => {
          if (storageData.has(key)) result[key] = storageData.get(key);
        });
        return result;
      }
      return {};
    },
    async set(items) {
      Object.entries(items).forEach(([key, value]) => storageData.set(key, value));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => storageData.delete(key));
    },
  };
}

global.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
    onInstalled: { addListener() {} },
    getURL(file) {
      return 'chrome-extension://unit-test/' + file;
    },
  },
  action: {
    onClicked: { addListener() {} },
    async setBadgeBackgroundColor(details) {
      badges.push({ type: 'color', details });
    },
    async setBadgeText(details) {
      badges.push({ type: 'text', details });
    },
  },
  tabs: {
    async create(options) {
      createdTabs.push(options);
      return { id: createdTabs.length };
    },
    async sendMessage() {
      return undefined;
    },
  },
  storage: {
    session: makeArea(),
    local: makeArea(),
  },
};

require(path.join(__dirname, '..', 'background.js'));

function send(message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sendResponse 超时')), 2000);
    const keepAlive = messageListener(message, sender || {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    if (keepAlive !== true) {
      clearTimeout(timeout);
      resolve(undefined);
    }
  });
}

function payload(index) {
  return {
    siteId: 'taobao',
    siteName: '淘宝',
    pageUrl: 'https://item.taobao.com/item.htm?id=1',
    title: `测试商品 ${index}`,
    capturedAt: 1700000000000 + index * 1000,
    stats: { scanned: 3, kept: 2 },
    images: [
      { url: 'https://img.alicdn.com/a.jpg', width: 800, height: 800, source: 'src' },
      { url: 'https://img.alicdn.com/b.jpg', width: 600, height: 400, source: 'background-image' },
      { url: 'data:image/png;base64,AAAA', width: 10, height: 10, source: 'src' },
    ],
  };
}

(async function run() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ ok: true, name });
    } catch (error) {
      results.push({ ok: false, name, detail: error.message });
    }
  };

  const sender = { tab: { id: 7 } };

  const first = await send({ type: 'IGRAB_CAPTURE', payload: payload(1) }, sender);
  check('有效请求返回 ok 和数量', () => {
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.count, 2);
    assert.ok(first.id);
  });
  check('写入 session storage', () => {
    const record = storageData.get('capture:' + first.id);
    assert.ok(record);
    assert.strictEqual(record.images.length, 2);
    assert.strictEqual(record.title, '测试商品 1');
  });
  check('打开画廊页并携带 id', () => {
    assert.strictEqual(createdTabs.length, 1);
    assert.ok(createdTabs[0].url.startsWith('chrome-extension://unit-test/gallery.html?id='));
  });
  check('工具栏角标显示数量', () => {
    const text = badges.filter((badge) => badge.type === 'text').pop();
    assert.ok(text);
    assert.strictEqual(text.details.text, '2');
    assert.strictEqual(text.details.tabId, 7);
  });

  const empty = await send({ type: 'IGRAB_CAPTURE', payload: { images: [] } }, sender);
  check('空图片列表返回错误', () => {
    assert.strictEqual(empty.ok, false);
    assert.ok(/没有可展示的图片/.test(empty.error));
  });

  const invalid = await send({
    type: 'IGRAB_CAPTURE',
    payload: { images: [{ url: 'data:image/png;base64,AAAA' }] },
  });
  check('全部为非法 URL 时返回错误', () => {
    assert.strictEqual(invalid.ok, false);
    assert.ok(/图片地址无效/.test(invalid.error));
  });

  for (let i = 2; i <= 6; i += 1) {
    await send({ type: 'IGRAB_CAPTURE', payload: payload(i) }, sender);
  }

  const captureKeys = Array.from(storageData.keys()).filter((key) => key.startsWith('capture:'));
  check('最多保留 5 次提取结果', () => {
    assert.strictEqual(captureKeys.length, 5);
  });
  check('保留的是最新 5 次', () => {
    const times = captureKeys.map((key) => storageData.get(key).capturedAt).sort((a, b) => a - b);
    assert.deepStrictEqual(times, [1700000002000, 1700000003000, 1700000004000, 1700000005000, 1700000006000]);
  });

  const passed = results.filter((result) => result.ok).length;
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? '  -> ' + result.detail : ''}`);
  }
  console.log(`\n${passed} / ${results.length} checks passed`);
  if (passed !== results.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

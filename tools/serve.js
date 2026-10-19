/* 仅用于开发：本地静态服务器，方便在 Chrome 中打开自测页面。
 * 运行：node tools/serve.js  ->  http://127.0.0.1:8123/tools/gallery-harness.html
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${PORT}`).pathname);
  } catch (error) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const relative = pathname === '/' ? '/tools/gallery-harness.html' : pathname;
  const file = path.resolve(ROOT, '.' + relative);

  if (!file.startsWith(ROOT)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ImageGrab dev server: http://127.0.0.1:${PORT}/tools/gallery-harness.html`);
});

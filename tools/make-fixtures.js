/* 仅用于开发：生成 content.js 自测用的本地图片。
 * 运行：node tools/make-fixtures.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { encodePng } = require('./png');

const OUT_DIR = path.join(__dirname, 'fixtures');

const SPECS = [
  { name: '400.png', width: 400, height: 400, color: [79, 70, 229] },
  { name: '48.png', width: 48, height: 48, color: [148, 163, 184] },
  { name: '600x120.png', width: 600, height: 120, color: [14, 165, 233] },
  { name: '640.png', width: 640, height: 640, color: [16, 185, 129] },
  { name: '320.png', width: 320, height: 320, color: [245, 158, 11] },
  { name: '800.png', width: 800, height: 800, color: [236, 72, 153] },
  { name: '900.png', width: 900, height: 900, color: [37, 99, 235] },
  { name: '900.png_100x100q90.png', width: 100, height: 100, color: [37, 99, 235] },
  { name: '200.png', width: 200, height: 200, color: [100, 116, 139] },
  { name: 'logo-big.png', width: 400, height: 400, color: [220, 38, 38] },
];

function render(spec) {
  const { width, height, color } = spec;
  const rgba = Buffer.alloc(width * height * 4);

  const centerX = width / 2;
  const centerY = height / 2;
  const outer = Math.min(width, height) * 0.24;
  const inner = outer * 0.58;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / Math.max(1, height - 1);
      let r = color[0] * (1 - t * 0.32);
      let g = color[1] * (1 - t * 0.32);
      let b = color[2] * (1 - t * 0.32);

      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance <= outer) {
        r = 255;
        g = 255;
        b = 255;
      }
      if (distance <= inner) {
        r = color[0] * 0.72;
        g = color[1] * 0.72;
        b = color[2] * 0.72;
      }

      const index = (y * width + x) * 4;
      rgba[index] = Math.round(r);
      rgba[index + 1] = Math.round(g);
      rgba[index + 2] = Math.round(b);
      rgba[index + 3] = 255;
    }
  }

  return encodePng(width, height, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const spec of SPECS) {
  const file = path.join(OUT_DIR, spec.name);
  const buffer = render(spec);
  fs.writeFileSync(file, buffer);
  console.log(`${spec.name}  ${spec.width}x${spec.height}  ${buffer.length} bytes`);
}

// 1x1 透明 GIF：用于验证占位图关键词过滤。
fs.writeFileSync(
  path.join(OUT_DIR, 'loading.gif'),
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
);
console.log('loading.gif  1x1');

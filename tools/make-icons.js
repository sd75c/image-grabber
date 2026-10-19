/* 仅用于开发：生成扩展图标（4x 超采样，无第三方依赖）。
 * 运行：node tools/make-icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { encodePng } = require('./png');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4;

const BG_START = [79, 70, 229]; // indigo-600
const BG_END = [14, 165, 233]; // sky-500
const GLYPH = [255, 255, 255];

function insideRoundRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function sample(nx, ny) {
  if (!insideRoundRect(nx, ny, 0.03, 0.03, 0.97, 0.97, 0.235)) return [0, 0, 0, 0];

  const glyph =
    insideRoundRect(nx, ny, 0.455, 0.235, 0.545, 0.555, 0.024) ||
    insideTriangle(nx, ny, 0.3, 0.52, 0.7, 0.52, 0.5, 0.715) ||
    insideRoundRect(nx, ny, 0.265, 0.75, 0.735, 0.84, 0.045);

  if (glyph) return [GLYPH[0], GLYPH[1], GLYPH[2], 255];

  const t = Math.min(1, Math.max(0, nx * 0.55 + ny * 0.45));
  return [
    BG_START[0] + (BG_END[0] - BG_START[0]) * t,
    BG_START[1] + (BG_END[1] - BG_START[1]) * t,
    BG_START[2] + (BG_END[2] - BG_START[2]) * t,
    255,
  ];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const pixel = sample(nx, ny);
          r += pixel[0] * pixel[3];
          g += pixel[1] * pixel[3];
          b += pixel[2] * pixel[3];
          a += pixel[3];
        }
      }
      const index = (y * size + x) * 4;
      if (a > 0) {
        rgba[index] = Math.round(r / a);
        rgba[index + 1] = Math.round(g / a);
        rgba[index + 2] = Math.round(b / a);
        rgba[index + 3] = Math.round(a / samples);
      }
    }
  }

  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  const buffer = renderIcon(size);
  fs.writeFileSync(file, buffer);
  console.log(`${path.relative(process.cwd(), file)}  ${size}x${size}  ${buffer.length} bytes`);
}

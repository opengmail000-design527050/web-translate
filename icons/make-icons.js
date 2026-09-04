/* 生成图标 PNG：深灰圆角底 + 两条文本线（上灰=原文，下粉=译文）。
 * 用法：node icons/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 4; // 超采样倍数，用来做抗锯齿

function roundedRectCoverage(x, y, w, h, r) {
  // 返回点 (x,y) 是否在圆角矩形内（0/1），配合超采样得到抗锯齿
  if (x < 0 || y < 0 || x > w || y > h) return 0;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function draw(size) {
  const W = size, H = size;
  const buf = Buffer.alloc(W * H * 4);

  const bg = [23, 24, 26];
  const bar1 = [176, 178, 182];   // 原文：灰
  const bar2 = [254, 188, 185];   // 译文：浅粉

  const radius = size * 0.22;

  // 字幕条的几何（相对尺寸）
  const b1 = { x: size * 0.22, y: size * 0.355, w: size * 0.56, h: Math.max(1.5, size * 0.10) };
  const b2 = { x: size * 0.22, y: size * 0.545, w: size * 0.44, h: Math.max(1.5, size * 0.10) };
  const br = size * 0.05;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let aBg = 0, a1 = 0, a2 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          aBg += roundedRectCoverage(x, y, W, H, radius);
          a1 += roundedRectCoverage(x - b1.x, y - b1.y, b1.w, b1.h, Math.min(br, b1.h / 2));
          a2 += roundedRectCoverage(x - b2.x, y - b2.y, b2.w, b2.h, Math.min(br, b2.h / 2));
        }
      }
      const n = SS * SS;
      aBg /= n; a1 /= n; a2 /= n;

      let r = bg[0], g = bg[1], b = bg[2];
      r = r * (1 - a1) + bar1[0] * a1; g = g * (1 - a1) + bar1[1] * a1; b = b * (1 - a1) + bar1[2] * a1;
      r = r * (1 - a2) + bar2[0] * a2; g = g * (1 - a2) + bar2[1] * a2; b = b * (1 - a2) + bar2[2] * a2;

      const o = (py * W + px) * 4;
      buf[o] = Math.round(r);
      buf[o + 1] = Math.round(g);
      buf[o + 2] = Math.round(b);
      buf[o + 3] = Math.round(aBg * 255);
    }
  }
  return { W, H, buf };
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(W, H, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const { W, H, buf } = draw(size);
  const out = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(out, png(W, H, buf));
  console.log('wrote', out);
}

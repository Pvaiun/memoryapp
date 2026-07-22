// Render public/icons/badge.svg to badge-96.png: a monochrome white silhouette
// on a transparent background. Android/Chrome mask the notification badge from
// the alpha channel and tint it, so an opaque icon shows as a white square —
// the badge must carry the shape in its alpha. Dependency-free (no browser):
// we know the badge is just circles, so we rasterise them directly.
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const SIZE = 96;
// Keep these in sync with public/icons/badge.svg.
const circles = [
  { cx: 38, cy: 41, r: 21 },
  { cx: 62, cy: 56, r: 13 },
  { cx: 64, cy: 32, r: 8 },
  { cx: 41, cy: 68, r: 6 },
];

// RGBA buffer, transparent white (colour fixed, coverage in alpha).
const px = Buffer.alloc(SIZE * SIZE * 4);
const SS = 4; // supersampling for anti-aliased edges
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px2 = x + (sx + 0.5) / SS;
        const py2 = y + (sy + 0.5) / SS;
        for (const c of circles) {
          const dx = px2 - c.cx;
          const dy = py2 - c.cy;
          if (dx * dx + dy * dy <= c.r * c.r) { hits++; break; }
        }
      }
    }
    const a = Math.round((hits / (SS * SS)) * 255);
    const i = (y * SIZE + x) * 4;
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = a;
  }
}

// Minimal PNG encoder (RGBA, no filter).
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public/icons/badge-96.png');
fs.writeFileSync(out, png);
console.log('badge-96.png written');

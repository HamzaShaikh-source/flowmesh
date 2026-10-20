'use strict';
/**
 * Generate the app icon with no graphics dependencies: a 512px PNG and a
 * 256px ICO (PNG-compressed), drawn from raw RGBA scanlines and deflated.
 *
 *   node scripts/make_icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'electron', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const BG = [11, 13, 16, 255];      // near-black page background
const BAR = [199, 248, 90, 255];  // lime accent used across the console

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      pixels.set(BG, offset);
    }
  }
  // Rounded-square plate so the icon has an edge on light desktops.
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, 0, x - (size - radius));
      const dy = Math.max(radius - y, 0, y - (size - radius));
      if (Math.hypot(dx, dy) > radius) {
        const offset = (y * size + x) * 4;
        pixels[offset + 3] = 0; // outside the rounded plate → transparent
      }
    }
  }
  // Four bars, the mark from the site header.
  const bars = [0.34, 0.55, 0.42, 0.72];
  const width = size * 0.096;
  const gap = size * 0.052;
  const total = bars.length * width + (bars.length - 1) * gap;
  let x0 = (size - total) / 2;
  const baseY = size * 0.76;
  bars.forEach((height) => {
    const barHeight = size * height * 0.72;
    const top = baseY - barHeight;
    for (let y = Math.floor(top); y < Math.floor(baseY); y += 1) {
      for (let x = Math.floor(x0); x < Math.floor(x0 + width); x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        pixels.set(BAR, (y * size + x) * 4);
      }
    }
    x0 += width + gap;
  });
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = chunk.crcTable || (chunk.crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })());
  let crc = -1;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([length, body, crcBuffer]);
}

function png(size) {
  const pixels = draw(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(image) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256px
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
}

const large = png(512);
const small = png(256);
fs.writeFileSync(path.join(OUT, 'icon.png'), large);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(small));
console.log('icon.png', large.length, 'bytes · icon.ico', ico(small).length, 'bytes');

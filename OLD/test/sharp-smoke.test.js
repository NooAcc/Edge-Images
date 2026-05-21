import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { loadSharp, processImage } from '../lib/process-image.js';

test('smoke: actual sharp pipeline decodes PNG and emits WebP bytes', async () => {
  const png = makeRgbaPng(2, 2, [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ]);

  const { buffer } = await processImage(png, {
    fit: 'inside',
    quality: 85,
    background: [255, 255, 255],
    flip: '',
  });

  assert.equal(buffer.slice(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buffer.slice(8, 12).toString('ascii'), 'WEBP');
  assert.ok(buffer.length > 32);
});

test('smoke: actual WebP output preserves transparent alpha', async () => {
  const png = makeRgbaPng(2, 1, [
    [255, 0, 0, 0],
    [0, 0, 255, 255],
  ]);

  const { buffer: output } = await processImage(png, {
    fit: 'inside',
    quality: 85,
    background: [255, 255, 255],
    flip: '',
  });
  const sharp = await loadSharp();
  const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  assert.equal(decoded.info.width, 2);
  assert.equal(decoded.info.height, 1);
  assert.equal(decoded.info.channels, 4);
  assert.equal(decoded.data[3], 0);
  assert.equal(decoded.data[7], 255);
});

function makeRgbaPng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const scanlines = [];
  for (let y = 0; y < height; y += 1) {
    scanlines.push(0);
    for (let x = 0; x < width; x += 1) {
      scanlines.push(...pixels[y * width + x]);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from(scanlines))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

const crcTable = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

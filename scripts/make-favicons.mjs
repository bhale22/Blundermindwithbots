#!/usr/bin/env node
/**
 * Generate the browser-tab favicons from icons/icon-512.png (the chimera mark).
 *
 *   node scripts/make-favicons.mjs
 *
 * Two decisions worth knowing before regenerating:
 *
 *  - The small sizes are CROPPED ~28%. icon-512 carries padding that is correct
 *    for a launcher/maskable icon but wastes most of a 16px tab favicon, where
 *    the dark half of the knight sinks into the dark background and the mark
 *    reads as a blob. Cropping in makes it legible.
 *  - Downscaling goes through Chromium's canvas rather than a resize library,
 *    because neither sharp nor ImageMagick is a dependency here and the browser
 *    is already available for the test suite.
 *
 * apple-touch (180) is left uncropped: iOS puts it on a rounded tile and the
 * padding is what keeps the mark off the corners.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'icons');
const SRC = path.join(ICONS, 'icon-512.png');

const CROPPED = [16, 32, 48, 64];   // tab favicons — fill the frame
const PLAIN   = [180];              // apple-touch — keep the safe padding
const CROP_ZOOM = 0.72;             // keep the middle 72%
const ICO_SIZES = [16, 32, 48];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body></body>');
const src = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');

async function render(size, zoom) {
  const dataUrl = await page.evaluate(async ([src, s, z]) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = src; });
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const side = img.width * z, off = (img.width - side) / 2;
    ctx.drawImage(img, off, off, side, side, 0, 0, s, s);
    return c.toDataURL('image/png');
  }, [src, size, zoom]);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const pngs = new Map();
for (const s of CROPPED) {
  const buf = await render(s, CROP_ZOOM);
  fs.writeFileSync(path.join(ICONS, `icon-${s}.png`), buf);
  pngs.set(s, buf);
  console.log(`icon-${s}.png  ${buf.length}b (cropped)`);
}
for (const s of PLAIN) {
  const buf = await render(s, 1.0);
  fs.writeFileSync(path.join(ICONS, 'apple-touch-icon.png'), buf);
  console.log(`apple-touch-icon.png  ${buf.length}b (uncropped)`);
}
await browser.close();

// ── favicon.ico ─────────────────────────────────────────────────────────────
// PNG-encoded entries, which every browser since IE11 accepts and which keeps
// the file small. Browsers request /favicon.ico by default whether or not it is
// declared, so shipping one avoids a 404 on every cold load.
const entries = ICO_SIZES.map((s) => ({ size: s, data: pngs.get(s) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);

let offset = 6 + 16 * entries.length;
const dir = [];
for (const e of entries) {
  const d = Buffer.alloc(16);
  d.writeUInt8(e.size === 256 ? 0 : e.size, 0);   // width  (0 means 256)
  d.writeUInt8(e.size === 256 ? 0 : e.size, 1);   // height
  d.writeUInt8(0, 2); d.writeUInt8(0, 3);          // palette, reserved
  d.writeUInt16LE(1, 4);                           // colour planes
  d.writeUInt16LE(32, 6);                          // bits per pixel
  d.writeUInt32LE(e.data.length, 8);
  d.writeUInt32LE(offset, 12);
  offset += e.data.length;
  dir.push(d);
}
const ico = Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
fs.writeFileSync(path.join(ROOT, 'favicon.ico'), ico);
console.log(`favicon.ico  ${ico.length}b  (${ICO_SIZES.join(', ')})`);

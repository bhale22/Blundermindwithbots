// Icon set checks. No server needed; run from the repo root after
// `node scripts/make-icons.mjs`:  node scripts/verify-icons.mjs
//
// The chimera mark is black-on-light for one half and white-on-dark for the
// other, which is the whole reason it works — so the thing worth pinning is
// that BOTH halves keep their separation from the ground behind them. The
// previous mark shipped at 1.00:1 for the knight (pixel-identical to its
// background) and nobody noticed until it was measured.
//
// Decoded with zlib, which Node already has — no image dependency to add.
import { readFileSync, existsSync } from 'fs';
import { inflateSync } from 'zlib';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

function decode(path) {
  const d = readFileSync(path);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + path);
  let i = 8, idat = [], w = 0, h = 0, bitDepth = 0, colour = 0;
  while (i < d.length) {
    const len = d.readUInt32BE(i), type = d.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = d.readUInt32BE(i + 8); h = d.readUInt32BE(i + 12);
      bitDepth = d[i + 16]; colour = d[i + 17];
    } else if (type === 'IDAT') idat.push(d.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('expected 8-bit, got ' + bitDepth);
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (!bpp) throw new Error('expected RGB/RGBA, got colour type ' + colour);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      cur[x] = (line[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : f === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  return { w, h, bpp, data: out, px: (x, y) => { const o = y * stride + x * bpp; return [out[o], out[o + 1], out[o + 2], bpp === 4 ? out[o + 3] : 255]; } };
}

const lum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const files = [
  ['icons/icon-192.png', 192],
  ['icons/icon-512.png', 512],
  ['icons/icon-maskable-512.png', 512],
  ['icons/apple-touch-icon.png', 180],
];

console.log('\nFiles and dimensions');
const imgs = {};
for (const [f, size] of files) {
  if (!existsSync(f)) { ok(f + ' exists', false); continue; }
  const im = decode(f);
  imgs[f] = im;
  ok(`${f} is ${size}×${size}`, im.w === size && im.h === size, `${im.w}×${im.h}`);
}

console.log('\nOpacity — Play rejects icons with transparency');
for (const [f] of files) {
  const im = imgs[f]; if (!im) continue;
  if (im.bpp === 3) { ok(`${f} has no alpha channel`, true); continue; }
  let minA = 255;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) minA = Math.min(minA, im.px(x, y)[3]);
  ok(`${f} is fully opaque`, minA === 255, 'min alpha ' + minA);
}

console.log('\nBoth halves must separate from the ground behind them');
{
  const im = imgs['icons/icon-512.png'];
  if (im) {
    // Points chosen off the 512 composition: knight cheek and the moonlit
    // ground beside it; pawn body and the night ground beside it.
    const knight = im.px(212, 212), moonlit = im.px(52, 108);
    const pawn = im.px(330, 360), night = im.px(452, 128);
    const kc = contrast(knight, moonlit), pc = contrast(pawn, night);
    ok(`knight reads against the moonlight (${kc.toFixed(2)}:1, need ≥3)`, kc >= 3,
       `knight rgb(${knight.slice(0, 3)}) vs ground rgb(${moonlit.slice(0, 3)})`);
    ok(`pawn reads against the night (${pc.toFixed(2)}:1, need ≥3)`, pc >= 3,
       `pawn rgb(${pawn.slice(0, 3)}) vs ground rgb(${night.slice(0, 3)})`);
    ok('the two halves separate from each other', contrast(knight, pawn) >= 4.5,
       contrast(knight, pawn).toFixed(2));
  }
}

console.log('\nMaskable must survive a circular launcher crop');
{
  // The mark cannot be separated from this ground by colour — the moon glow is
  // as bright as the pawn and the far corners are as dark as the knight. So the
  // mark is re-rendered on transparency and measured by alpha. It is drawn from
  // the same MASK constant the generator uses, which is the value that can
  // regress; a check that re-derived the placement would prove nothing.
  const { chromium } = await import('playwright');
  const { MASK, mark, BASE } = await import('./icon-art.mjs');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: BASE, height: BASE }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>
    <div style="position:relative;width:${BASE}px;height:${BASE}px;overflow:hidden">${mark(MASK)}</div>`);
  await p.waitForTimeout(200);
  const buf = await p.screenshot({ omitBackground: true });
  await browser.close();

  const { writeFileSync, unlinkSync } = await import('fs');
  const tmp = 'icons/.ink-probe.png';
  writeFileSync(tmp, buf);
  const im = decode(tmp);
  unlinkSync(tmp);

  const cx = im.w / 2, cy = im.h / 2, R = im.w * 0.667 / 2;
  let far = 0, x0 = im.w, x1 = -1, y0 = im.h, y1 = -1;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    if (im.px(x, y)[3] > 24) {
      far = Math.max(far, Math.hypot(x - cx, y - cy));
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  ok(`mark stays inside the safe circle (${(far / R).toFixed(2)} of safe radius)`, far <= R,
     `farthest ink ${far.toFixed(0)}px, safe radius ${R.toFixed(0)}px`);
  const icx = (x0 + x1) / 2, icy = (y0 + y1) / 2;
  ok('mark is centred on its ink, not its glyph box',
     Math.abs(icx - cx) <= 8 && Math.abs(icy - cy) <= 8,
     `ink centre (${icx.toFixed(0)}, ${icy.toFixed(0)}) vs tile centre (${cx}, ${cy})`);
}

console.log('\nThe visor has to survive downscaling');
{
  const im = imgs['icons/icon-192.png'];
  if (im) {
    let reddest = 0;
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
      const [r, g, b] = im.px(x, y);
      if (r > 120 && r - Math.max(g, b) > 60) reddest++;
    }
    ok(`the red eye is still there at 192 (${reddest}px)`, reddest >= 12, String(reddest));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

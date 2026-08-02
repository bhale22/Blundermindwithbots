// Generates the PWA icon set into ./icons. Run from the repo root:
//   node scripts/make-icons.mjs
//
// Rendered with the Playwright Chromium that is already a devDependency, so
// there is no image-processing dependency to add. Re-run after changing the
// mark; the output is committed so deploys don't need a build step.
//
// Maskable icons are cropped by the launcher to a circle/squircle, so the mark
// has to sit inside the middle 80% ("safe zone"). That is why the maskable
// variant draws the glyph smaller on a full-bleed background rather than
// reusing the standard icon.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const CARBON = '#0e0f11';
const AMBER = '#c8922a';

// ♞ on carbon, with a thin amber rule under it echoing the panel's borders.
const page = (size, safeScale) => `
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;}
  .bg{width:${size}px;height:${size}px;background:${CARBON};
      display:flex;align-items:center;justify-content:center;}
  .mark{
    width:${size * safeScale}px;height:${size * safeScale}px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:${size * 0.03}px;
  }
  .glyph{
    font-family:'Segoe UI Symbol','Noto Sans Symbols 2',sans-serif;
    font-size:${size * safeScale * 0.72}px;line-height:1;
    color:${AMBER};
    text-shadow:0 0 ${size * 0.04}px rgba(200,146,42,0.45);
  }
  .rule{width:${size * safeScale * 0.52}px;height:${Math.max(1, size * 0.012)}px;
        background:${AMBER};opacity:0.75;border-radius:99px;}
</style>
<div class="bg"><div class="mark">
  <div class="glyph">&#9822;</div>
  <div class="rule"></div>
</div></div>`;

mkdirSync('icons', { recursive: true });

const browser = await chromium.launch();
// safeScale 0.78 keeps the mark inside the maskable safe zone; 0.94 fills the
// tile for the standard icons, which are shown uncropped.
const targets = [
  { file: 'icons/icon-192.png',          size: 192, safe: 0.94 },
  { file: 'icons/icon-512.png',          size: 512, safe: 0.94 },
  { file: 'icons/icon-maskable-512.png', size: 512, safe: 0.62 },
  { file: 'icons/apple-touch-icon.png',  size: 180, safe: 0.90 },
];

for (const t of targets) {
  const ctx = await browser.newContext({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(page(t.size, t.safe));
  await p.waitForTimeout(120);
  await p.screenshot({ path: t.file, omitBackground: false });
  await ctx.close();
  console.log('  wrote ' + t.file + '  (' + t.size + '×' + t.size + ')');
}
await browser.close();
console.log('done');

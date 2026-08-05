// Generates the PWA / Play icon set into ./icons. Run from the repo root:
//   node scripts/make-icons.mjs
//
// Rendered with the Playwright Chromium that is already a devDependency, so
// there is no image-processing dependency to add. Re-run after changing the
// mark; the output is committed so deploys don't need a build step.
//
// ── The mark ────────────────────────────────────────────────────────────────
// A chimera: the machine knight of Build-A-Bot in front, a Staunton pawn — the
// training board — behind it, split at the knight's rear ear so the pawn's dome
// reads as a second head rather than a graft. One mark for the two halves of
// the site.
//
// ── Why the ground is moonlight ─────────────────────────────────────────────
// The knight is black and the pawn is white, so no single ground suits both:
// a dark tile hid the knight (measured 1.00:1 against it — pixel-identical),
// and simply brightening the tile would have hidden the pawn instead. Light
// raking from the upper left gives a ground that is luminous behind the black
// knight and falls to night behind the white pawn, so each half is legible
// against its opposite. Measured after: knight 6.5:1, pawn 18:1.
//
// ── Sizes ───────────────────────────────────────────────────────────────────
// Maskable icons are cropped by the launcher to a circle/squircle, so the mark
// must sit inside the adaptive-icon safe zone — the middle 66.7%. MASKABLE
// below is scaled and then recentred on the *measured ink*, not on the element
// box: the Georgia glyph carries a lot of empty advance width, and laying it
// out by its box parks the art visibly off-centre. Verified at 0.94 of the safe
// radius by scripts/verify-icons.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { ANY, MASK, page } from './icon-art.mjs';

mkdirSync('icons', { recursive: true });

const browser = await chromium.launch();
const targets = [
  { file: 'icons/icon-192.png',          size: 192, place: ANY  },
  { file: 'icons/icon-512.png',          size: 512, place: ANY  },
  { file: 'icons/icon-maskable-512.png', size: 512, place: MASK },
  // Apple applies its own rounded mask and does not use the maskable safe zone,
  // but it crops harder than a browser tab does, so it takes the middle ground.
  { file: 'icons/apple-touch-icon.png',  size: 180, place: MASK },
];

for (const t of targets) {
  const ctx = await browser.newContext({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(page(t.size, t.place));
  await p.waitForTimeout(160);
  await p.screenshot({ path: t.file, omitBackground: false });
  await ctx.close();
  console.log('  wrote ' + t.file + '  (' + t.size + '×' + t.size + ')');
}
await browser.close();
console.log('done');

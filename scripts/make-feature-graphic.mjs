// Generates the Play Store feature graphic. Run from the repo root:
//   node scripts/make-feature-graphic.mjs
//
// Play requires exactly 1024×500 with no transparency. It also re-crops the
// graphic for different placements, so every word sits in the middle band and
// nothing load-bearing goes near an edge.
//
// This is the original composition — carbon ground, the lift from below, the
// wordmark centred — with the chimera in place of the plain knight watermark,
// so the banner and the app icon show the same mark.
//
// The one addition their layout needed: a pool of moonlight behind the chimera.
// The mark's knight half is near-black by design, and on a carbon ground a
// black shape on black is invisible; the original solved that by drawing its
// knight as a faint *white* ghost, which would have inverted the mark and
// broken the match with the icon. Lighting the corner instead keeps the mark
// exactly as it appears everywhere else.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { mark } from './icon-art.mjs';

const W = 1024, H = 500;

const html = `<style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:#0e0f11;}
  .wrap{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#0e0f11;}
  .lift{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 120%,#1a2b3a 0%,#0e0f11 62%);}
  .pool{position:absolute;inset:0;background:radial-gradient(44% 66% at 16% 80%,rgba(158,196,226,.52) 0%,rgba(96,138,180,.24) 38%,rgba(0,0,0,0) 72%);}
  /* Far enough in that the muzzle is not clipped by the edge — the nose is the
     read on a knight, and cropping it turns the mark into an anonymous shape. */
  .art{position:absolute;left:14px;bottom:-118px;}
  .copy{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:22px;padding:0 60px;text-align:center;}
  .name{font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:92px;
        line-height:1;letter-spacing:-.02em;color:#f2f4f6;}
  .name b{color:#4a9fe0;font-weight:inherit;}
  .tag{font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:36px;
       line-height:1.2;color:#b9bfc6;}
  .eyebrow{display:flex;align-items:center;gap:16px;margin-top:8px;}
  .eyebrow .rule{width:36px;height:1px;background:#3a4048;}
  .eyebrow .txt{font-family:ui-monospace,Consolas,monospace;font-size:17px;
       letter-spacing:.2em;text-transform:uppercase;color:#8b9096;}
</style>
<div class="wrap">
  <div class="lift"></div>
  <div class="pool"></div>
  <div class="art" style="width:420px;height:336px">${mark({ s: 1.26, x: 0, y: 0 })}</div>
  <div class="copy">
    <div class="name">Blunder<b>mind</b></div>
    <div class="tag">Stop getting blundermined.</div>
    <div class="eyebrow">
      <span class="rule"></span>
      <span class="txt">Board vision · Build-a-bot chess</span>
      <span class="rule"></span>
    </div>
  </div>
</div>`;

mkdirSync('icons', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.setContent(html);
await p.waitForTimeout(250);
await p.screenshot({ path: 'icons/feature-graphic-1024x500.png', omitBackground: false });
await browser.close();
console.log('  wrote icons/feature-graphic-1024x500.png  (1024×500)');

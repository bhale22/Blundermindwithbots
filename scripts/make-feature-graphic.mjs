// Generates the Play Store feature graphic. Run from the repo root:
//   node scripts/make-feature-graphic.mjs
//
// Play requires exactly 1024×500 with no transparency. It also re-crops the
// graphic for different placements, so every word sits inside the middle band
// and nothing load-bearing goes near an edge.
//
// The mark is the same chimera as the app icon, on the same moonlit ground —
// a listing that shows one logo on the tile and a different one on the banner
// reads as two products. It sits bottom-left at low opacity so the wordmark
// stays the loudest thing on the banner.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { mark } from './icon-art.mjs';

const W = 1024, H = 500;

// Wider than the icon tile, so the ground is re-composed rather than stretched:
// the moon sits further left and the lake horizon drops, which gives the
// wordmark a calm band to sit in.
const ground = `
  <div style="position:absolute;inset:0;background:linear-gradient(150deg,#16283a 0%,#0b1622 44%,#060a10 100%)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(46% 78% at 20% 34%,#c8dcee 0%,rgba(170,202,228,.62) 26%,rgba(110,152,190,.30) 52%,rgba(0,0,0,0) 78%)"></div>
  <div style="position:absolute;left:0;right:0;top:76%;bottom:0;background:linear-gradient(180deg,#33556f 0%,#0a121b 100%)"></div>
  <div style="position:absolute;left:0;right:0;top:76%;height:2px;background:linear-gradient(90deg,rgba(214,234,250,0) 0%,rgba(214,234,250,.7) 18%,rgba(214,234,250,.12) 54%,rgba(214,234,250,0) 100%)"></div>
  <div style="position:absolute;left:6%;right:64%;top:76%;bottom:0;background:linear-gradient(180deg,rgba(190,220,244,.28) 0%,rgba(190,220,244,0) 76%);filter:blur(7px)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(90% 120% at 88% 60%,rgba(0,0,0,.66) 0%,rgba(0,0,0,0) 62%)"></div>`;

const html = `<style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:#060a10;}
  .wrap{position:relative;width:${W}px;height:${H}px;overflow:hidden;}
  /* Only the head clears the bottom edge. The split head is the recognisable
     part of the mark, and cropping to it keeps the wordmark the loudest thing
     on the banner — a full figure at this opacity competed with the type. */
  .art{position:absolute;left:16px;top:292px;opacity:.72;}
  .copy{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:20px;padding:0 90px 128px;text-align:center;}
  .name{font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:92px;
        line-height:1;letter-spacing:-.02em;color:#f2f4f6;
        text-shadow:0 2px 26px rgba(0,0,0,.55);}
  .name b{color:#7cb8e8;font-weight:inherit;}
  .tag{font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:35px;
       line-height:1.2;color:#c6ced6;text-shadow:0 2px 18px rgba(0,0,0,.6);}
  .eyebrow{display:flex;align-items:center;gap:16px;margin-top:6px;}
  .eyebrow span.rule{width:36px;height:1px;background:#5b6774;}
  .eyebrow span.txt{font-family:ui-monospace,Consolas,monospace;font-size:16px;
       letter-spacing:.2em;text-transform:uppercase;color:#9aa6b2;}
</style>
<div class="wrap">
  ${ground}
  <div class="art" style="width:420px;height:210px">${mark({ s: 1.42, x: 0, y: 0 })}</div>
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

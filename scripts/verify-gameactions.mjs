// Resign / Offer draw placement on the Visualization board. Server on :3100,
// run from the repo root:  node scripts/verify-gameactions.mjs
//
// The bug: #gameActions sat after #board-settings in the sidebar, so opening
// the board-vision drawer (~450px of settings) pushed Resign and Offer draw
// below the fold during a live game — the one moment they are needed.
//
// The fix is a single `order:-1` inside the phone media query. These checks
// pin the three things that could silently undo it:
//   · phone  — the row sits under the clock and above the drawer toggle
//   · phone  — it STAYS above the toggle with the drawer expanded (the bug)
//   · desktop — 1440 is untouched, since #board-settings is display:contents
//               there and the media query never applies
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

// Landing → Visualization Training Board, with #gameActions forced visible.
// updateSidePanel() only reveals it during a live game; forcing display here
// keeps the check about layout rather than about starting an engine.
async function shell(width, height, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // Pick the Visualization board by its label rather than by index, so a
  // reordered landing page fails loudly here instead of testing the wrong shell.
  const picked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.landing-shell-btn')]
      .find(el => /visuali/i.test(el.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const ga = document.getElementById('gameActions');
    if (ga) ga.style.display = 'flex';
  });
  await page.waitForTimeout(300);
  return { ctx, page, picked };
}

const rects = page => page.evaluate(() => {
  const r = id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, h: b.height };
  };
  return { clock: r('playerBoxW'), ga: r('gameActions'),
           toggle: r('bv-toggle'), settings: r('board-settings') };
});

console.log('\nPhone — 390x844');
{
  const { ctx, page, picked } = await shell(390, 844, true);
  ok('Visualization shell reachable from the landing page', picked);

  const a = await rects(page);
  ok('Resign / Offer draw is rendered', a.ga && a.ga.h > 0,
     a.ga ? 'height ' + a.ga.h : 'missing');
  ok('sits below the clock', a.ga && a.clock && a.ga.top >= a.clock.bottom - 1,
     a.ga && a.clock ? `ga.top ${a.ga.top.toFixed(0)} vs clock.bottom ${a.clock.bottom.toFixed(0)}` : 'missing');
  ok('sits above the board-vision toggle', a.ga && a.toggle && a.ga.bottom <= a.toggle.top + 1,
     a.ga && a.toggle ? `ga.bottom ${a.ga.bottom.toFixed(0)} vs toggle.top ${a.toggle.top.toFixed(0)}` : 'missing');

  // The regression that motivated the change.
  await page.evaluate(() => toggleBoardSettings());
  await page.waitForTimeout(400);
  const b = await rects(page);
  const open = await page.evaluate(() =>
    document.getElementById('board-settings').classList.contains('open'));
  ok('drawer actually opened', open);
  ok('drawer is tall enough to have caused the bug', b.settings && b.settings.h > 200,
     b.settings ? 'height ' + b.settings.h.toFixed(0) : 'missing');
  ok('STILL above the toggle with the drawer open',
     b.ga && b.toggle && b.ga.bottom <= b.toggle.top + 1,
     b.ga && b.toggle ? `ga.bottom ${b.ga.bottom.toFixed(0)} vs toggle.top ${b.toggle.top.toFixed(0)}` : 'missing');
  ok('still on screen with the drawer open', b.ga && b.ga.bottom <= 844,
     b.ga ? 'ga.bottom ' + b.ga.bottom.toFixed(0) : 'missing');

  // Buttons stay a real tap target once moved.
  const tap = await page.evaluate(() =>
    [...document.querySelectorAll('#gameActions .gbtn')]
      .map(el => Math.round(el.getBoundingClientRect().height)));
  ok('both buttons are >= 42px tall', tap.length === 2 && tap.every(h => h >= 42),
     JSON.stringify(tap));

  await ctx.close();
}

console.log('\nDesktop — 1440x900 (must be unchanged)');
{
  const { ctx, page } = await shell(1440, 900, false);
  const a = await rects(page);
  ok('board-settings is display:contents',
     await page.evaluate(() => getComputedStyle(document.getElementById('board-settings')).display === 'contents'));
  ok('the toggle stays hidden',
     await page.evaluate(() => getComputedStyle(document.getElementById('bv-toggle')).display === 'none'));
  ok('order is not applied at desktop width',
     await page.evaluate(() => getComputedStyle(document.getElementById('gameActions')).order === '0'),
     await page.evaluate(() => getComputedStyle(document.getElementById('gameActions')).order));
  ok('Resign / Offer draw still sits below the settings rows',
     await page.evaluate(() => {
       const ga = document.getElementById('gameActions').getBoundingClientRect();
       const rows = [...document.querySelectorAll('#board-settings .s-row')];
       if (!rows.length) return false;
       return ga.top >= rows[rows.length - 1].getBoundingClientRect().top;
     }));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

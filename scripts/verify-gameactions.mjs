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

  // On a phone the two live-game buttons are on #phoneBar, under the board,
  // and #gameActions is hidden inside the tray — the tray covers the board
  // when it is open, which is the last place a resignation should live. The
  // assertions below are the old ones re-pointed at the bar: still "these are
  // reachable without opening anything, and they are a real tap target".
  ok('the bar carries nothing to press before a game starts',
     await page.evaluate(() => {
       botActive = false; gameOver = false; updateActionBtn();
       const d = id => getComputedStyle(document.getElementById(id)).display;
       return d('pbResign') === 'none' && d('pbDraw') === 'none';
     }));
  await page.evaluate(() => { botActive = true; updateActionBtn(); });
  await page.waitForTimeout(200);

  const a = await page.evaluate(() => {
    const r = id => { const e = document.getElementById(id); const b = e.getBoundingClientRect();
                      return { top: b.top, bottom: b.bottom, h: b.height }; };
    return { clock: r('playerBoxW'), bar: r('phoneBar'), tray: r('sidebar'),
             gaDisplay: getComputedStyle(document.getElementById('gameActions')).display };
  });
  ok('Resign / Offer draw are on the game bar once a game is live',
     await page.evaluate(() => {
       const d = id => getComputedStyle(document.getElementById(id)).display;
       return d('pbResign') !== 'none' && d('pbDraw') !== 'none';
     }));
  ok('the sidebar copy stays out of the way inside the tray', a.gaDisplay === 'none', a.gaDisplay);
  ok('the bar sits below the clock', a.bar.top >= a.clock.bottom - 1,
     `bar.top ${a.bar.top.toFixed(0)} vs clock.bottom ${a.clock.bottom.toFixed(0)}`);
  ok('the bar sits above the closed tray', a.bar.bottom <= a.tray.top + 1,
     `bar.bottom ${a.bar.bottom.toFixed(0)} vs tray.top ${a.tray.top.toFixed(0)}`);
  ok('the bar is on screen', a.bar.bottom <= 844, 'bar.bottom ' + a.bar.bottom.toFixed(0));

  // The regression that motivated all of this: opening the board-vision
  // controls used to push the live-game buttons off the screen. Now the
  // controls are a sheet that slides OVER the board, so the bar does not move
  // at all — it is simply covered, and closing the sheet brings it straight
  // back. That is the property worth pinning.
  const before = a.bar.top;
  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({
    barTop: document.getElementById('phoneBar').getBoundingClientRect().top,
    open: !document.getElementById('visPanel').hidden,
    panelH: document.getElementById('visCard').getBoundingClientRect().height,
  }));
  ok('the panel actually opened', opened.open === true, String(opened.open));
  ok('it is tall enough to have caused the old bug', opened.panelH > 400,
     'height ' + opened.panelH.toFixed(0));
  ok('opening it does not move the game bar', Math.abs(opened.barTop - before) < 2,
     `${before.toFixed(0)} → ${opened.barTop.toFixed(0)}`);
  await page.evaluate(() => visPanelClose());
  await page.waitForTimeout(400);
  ok('closing it brings the bar back untouched',
     await page.evaluate(t => Math.abs(document.getElementById('phoneBar').getBoundingClientRect().top - t) < 2, before));

  // Buttons stay a real tap target.
  const tap = await page.evaluate(() =>
    [...document.querySelectorAll('#phoneBar .pbtn')]
      .filter(el => getComputedStyle(el).display !== 'none')
      .map(el => Math.round(el.getBoundingClientRect().height)));
  ok('every visible button is >= 42px tall', tap.length >= 2 && tap.every(h => h >= 42),
     JSON.stringify(tap));

  // End of game: the sidebar row still hands over to Rematch / Review, and the
  // bar drops the two buttons that no longer apply.
  const endRow = await page.evaluate(() => {
    gameOver = true;
    if (typeof gameMovesAlgebraic !== 'undefined') gameMovesAlgebraic = ['e4', 'e5'];
    updateActionBtn();
    // #gameActions is display:none on a phone, so offsetParent is null for
    // every child of it — read the inline display the sync actually sets.
    const vis = [...document.querySelectorAll('#gameActions .gbtn')]
      .filter(el => el.style.display !== 'none').map(el => el.textContent.trim());
    const barResign = getComputedStyle(document.getElementById('pbResign')).display;
    gameOver = false; botActive = false;
    if (typeof gameMovesAlgebraic !== 'undefined') gameMovesAlgebraic = [];
    updateActionBtn();
    return { vis, barResign };
  });
  ok('Rematch and Review take the Draw/Resign slot at the end',
     endRow.vis.some(t => /Rematch/.test(t)) && endRow.vis.some(t => /Review/.test(t)),
     endRow.vis.join(' | '));
  ok('the game bar drops Resign once the game is over', endRow.barResign === 'none',
     endRow.barResign);

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
  // The settings checkboxes this used to measure against moved into the Board
  // settings panel, so #board-settings .s-row matches nothing any more. The
  // intent survives: the action row belongs BELOW the board-vision controls,
  // never above them. Measure against the last control that is actually there.
  ok('Resign / Offer draw still sits below the board-vision controls',
     await page.evaluate(() => {
       const ga = document.getElementById('gameActions').getBoundingClientRect();
       const utils = document.querySelector('.ind-utils');
       if (!utils) return false;
       return ga.top >= utils.getBoundingClientRect().top;
     }));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

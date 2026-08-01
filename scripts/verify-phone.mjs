// Phone-layout verification. Needs the server running on :3100 and must be run
// from the repo root (node_modules resolution):  node scripts/verify-phone.mjs
//
// Covers the July-31 phone pass:
//   · Expert board — opponent clock ABOVE the board, player clock BELOW it
//   · Expert board — notation collapsed to its header, taps open
//   · Bot Builder — one-row header, every quick-start pill visible, Start fixed
//   · Bot Builder — time / colour reachable in two taps
//   · Slide-in panels full-bleed
//   · Desktop (1440) unchanged by all of the above
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok  = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                 : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

async function ctxFor(width, height, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2,
    isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(() => {
    try { ['bm_bottour','bm_tour_pro','bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  return ctx;
}

// Landing → chosen shell → Bot Builder modal. Stops with the panel OPEN, so the
// panel assertions run against a laid-out iframe (starting the game closes the
// modal and every rect in it collapses to zero).
async function openBuilder(page, shellIdx) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const sb = await page.$$('.landing-shell-btn');
  if (sb[shellIdx]) { await sb[shellIdx].click(); await page.waitForTimeout(400); }
  for (const c of await page.$$('.landing-card')) {
    if ((await c.innerText()).toLowerCase().includes('build a bot')) { await c.click(); break; }
  }
  await page.waitForTimeout(2000);
  const f = page.frames().find(x => x.url().includes('bot-control-panel'));
  await f.evaluate(() => { const o = document.getElementById('botTourOverlay'); if (o) o.style.display = 'none'; });
  // Stockfish plays without the 87MB Maia download; Black for the human means
  // the bot moves first, so there is always a move for the notation peek.
  await f.evaluate(() => {
    const c = document.querySelector('.mcard[data-engine="stockfish"]'); if (c) selEngineMode(c);
    const b = document.querySelector('#qs-drop-color .pa-btn[data-color="black"]'); if (b) selColor(b);
  });
  await page.waitForTimeout(300);
  return f;
}

async function startGame(page, frame) {
  await frame.evaluate(() => { const b = document.querySelector('.start-btn'); if (b) b.click(); });
  await page.waitForFunction(() => typeof gameMovesAlgebraic !== 'undefined' && gameMovesAlgebraic.length > 0,
                             null, { timeout: 30000 });
  await page.waitForTimeout(600);
}

const box = (page, sel) => page.evaluate(s => {
  const e = document.querySelector(s); if (!e) return null;
  const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { top: b.top, bottom: b.bottom, w: b.width, h: b.height, display: cs.display };
}, sel);

// ── PHONE ──────────────────────────────────────────────────────────────────
console.log('\nPHONE 390×844');
{
  const ctx = await ctxFor(390, 844, true);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => d.accept());

  const frame = await openBuilder(page, 1);   // 1 = Expert board

  console.log(' Bot Builder panel');
  const hdr  = await frame.evaluate(() => document.querySelector('.header').getBoundingClientRect().height);
  ok('header is one row (was 173px)', hdr < 90, hdr + 'px');
  const more = await frame.evaluate(() => getComputedStyle(document.querySelector('.hdr-more')).display);
  ok('⋯ overflow button is shown', more !== 'none', more);
  const toolsClosed = await frame.evaluate(() => getComputedStyle(document.getElementById('hdr-tools')).display);
  ok('tools menu starts closed', toolsClosed === 'none', toolsClosed);
  const pills = await frame.evaluate(() =>
    ['qs-engine-pill','qs-time-btn','qs-color-btn','qs-ttime-btn','qs-pers-btn','qs-cpb-btn','qs-bots-btn']
      .filter(id => { const e = document.getElementById(id); return e && e.getBoundingClientRect().height > 0; }).length);
  ok('all 7 quick-start pills visible without a fold', pills === 7, pills + '/7');
  const start = await frame.evaluate(() => {
    const e = document.querySelector('.start-btn'); const cs = getComputedStyle(e);
    const b = e.getBoundingClientRect();
    return { pos: cs.position, bottom: Math.round(innerHeight - b.bottom), z: cs.zIndex };
  });
  ok('Start is fixed to the bottom of the viewport', start.pos === 'fixed' && start.bottom === 0, JSON.stringify(start));
  // Start must paint above the section cards, not behind them.
  const startOnTop = await frame.evaluate(() => {
    const b = document.querySelector('.start-btn').getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!(hit && hit.closest('.start-btn'));
  });
  ok('Start is the topmost element at its own centre', startOnTop);
  ok('dead Setup-fold machinery is gone',
     await frame.evaluate(() => !document.getElementById('qs-more-btn') && typeof toggleQsMore === 'undefined'));

  console.log(' Bot Builder — two taps to change a setting');
  await frame.evaluate(() => document.getElementById('qs-time-btn').click());
  await page.waitForTimeout(400);
  ok('tap 1 on Time opens the clock sheet',
     await frame.evaluate(() => document.getElementById('qs-drop-time').classList.contains('open')));
  ok('sheet Done button clears the host modal close button',
     await frame.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.tcm-head')).paddingRight) >= 50));
  await frame.evaluate(() => { const t = [...document.querySelectorAll('.tcm-opt')].find(o => o.dataset.t === '5'); if (t) t.click(); });
  await page.waitForTimeout(400);
  ok('tap 2 picks a time control',
     (await frame.evaluate(() => document.getElementById('qs-time-value').textContent)).includes('5 min'));
  await frame.evaluate(() => closeAllQsDropdowns());
  await page.waitForTimeout(300);
  await frame.evaluate(() => document.getElementById('qs-color-btn').click());
  await page.waitForTimeout(300);
  ok('tap 1 on Play as opens the colour list',
     await frame.evaluate(() => document.getElementById('qs-drop-color').classList.contains('open')));
  await frame.evaluate(() => closeAllQsDropdowns());

  console.log(' Bot Builder — header menu');
  await frame.evaluate(() => toggleHdrTools(true));
  await page.waitForTimeout(300);
  ok('menu opens with Tour + Appearance + text sizes',
     await frame.evaluate(() => {
       const t = document.getElementById('hdr-tools');
       return getComputedStyle(t).display === 'flex'
         && t.querySelector('.hdr-tour').getBoundingClientRect().height > 0
         && t.querySelectorAll('.hdr-text .rs-btn').length === 3;
     }));
  await frame.evaluate(() => toggleHdrTools(false));
  ok('menu closes again',
     await frame.evaluate(() => getComputedStyle(document.getElementById('hdr-tools')).display === 'none'));

  await startGame(page, frame);

  console.log(' Expert board');
  const canvas = await box(page, '#cv');
  const top    = await box(page, '#proPlayerTop');
  const bottom = await box(page, '#proPlayerBottom');
  ok('opponent clock sits ABOVE the board', top.bottom <= canvas.top + 1,
     `clock bottom ${Math.round(top.bottom)} vs board top ${Math.round(canvas.top)}`);
  ok('your clock sits BELOW the board', bottom.top >= canvas.bottom - 1,
     `clock top ${Math.round(bottom.top)} vs board bottom ${Math.round(canvas.bottom)}`);
  ok('your clock is adjacent to the board (nothing wedged between)',
     bottom.top - canvas.bottom < 24, Math.round(bottom.top - canvas.bottom) + 'px gap');
  ok('the wrappers are dissolved, not reordered as blocks',
     (await box(page, '#proSide')).display === 'contents' &&
     (await box(page, '#board-col')).display === 'contents');
  ok('board + both clocks fit above the fold',
     bottom.bottom <= 844, Math.round(bottom.bottom) + 'px');

  console.log(' Expert board — collapsed notation');
  ok('move list is collapsed', (await box(page, '#proMoves')).display === 'none');
  const peekTxt = await page.evaluate(() => document.getElementById('proNotationPeek').textContent);
  ok('peek shows the latest moves in reading order', /^\d+\./.test(peekTxt), JSON.stringify(peekTxt));
  await page.evaluate(() => proToggleNotation());
  await page.waitForTimeout(250);
  ok('tapping the header opens the list', (await box(page, '#proMoves')).display !== 'none');
  await page.evaluate(() => proToggleNotation());
  ok('tapping again closes it', (await box(page, '#proMoves')).display === 'none');

  console.log(' Panels');
  await page.evaluate(() => openPanel('themePanel'));
  await page.waitForTimeout(500);
  const th = await box(page, '#themePanel');
  ok('Theme panel is full-bleed', Math.round(th.w) === 390, Math.round(th.w) + 'px');
  ok('swatches are 44px touch targets',
     await page.evaluate(() => { const s = document.querySelector('#bgSwatches .swatch');
       return s && Math.round(s.getBoundingClientRect().width) === 44; }));
  await page.evaluate(() => closeAllPanels());
  await page.waitForTimeout(400);
  await page.evaluate(() => openPanel('mpPanel'));
  await page.waitForTimeout(500);
  ok('2-player panel still full-bleed', Math.round((await box(page, '#mpPanel')).w) === 390);
  await page.evaluate(() => closeAllPanels());

  console.log(' Training board (shell 0)');
  const p2 = await ctx.newPage();
  p2.on('dialog', d => d.accept());
  p2.on('pageerror', e => errs.push(e.message));
  await startGame(p2, await openBuilder(p2, 0));
  const labels = await p2.evaluate(() =>
    [...document.querySelectorAll('#gameActions button, #bottom-controls .ctrl-row button')]
      .filter(b => b.offsetParent !== null).map(b => b.textContent.trim()));
  ok('Resign appears exactly once',
     labels.filter(l => /resign/i.test(l)).length === 1, JSON.stringify(labels));
  // The human is Black here, so the board is flipped and White is the side at
  // the top — the boxes follow the pieces, not the colours.
  const cB = await box(p2, '#cv'), bB = await box(p2, '#playerBoxB'), wB = await box(p2, '#playerBoxW');
  // Read the class, not `boardFlipped` — the bundle declares it with `let`, so
  // it never lands on `window` and always reads back as undefined here.
  const flipped = await p2.evaluate(() =>
    document.getElementById('board-col').classList.contains('board-flipped'));
  const upper = flipped ? wB : bB, lower = flipped ? bB : wB;
  ok('clocks flank the board, each beside its own pieces',
     upper.bottom <= cB.top + 1 && lower.top >= cB.bottom - 1,
     `flipped=${flipped} upper ${Math.round(upper.bottom)}/${Math.round(cB.top)} lower ${Math.round(lower.top)}/${Math.round(cB.bottom)}`);

  ok('no console errors anywhere on phone', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  await ctx.close();
}

// ── DESKTOP (regression) ───────────────────────────────────────────────────
console.log('\nDESKTOP 1440×900 — nothing above should have touched this');
{
  const ctx = await ctxFor(1440, 900, false);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => d.accept());

  const frame = await openBuilder(page, 1);
  ok('panel header still one line with Tour/Appearance/Text inline',
     await frame.evaluate(() => {
       const h = document.querySelector('.header').getBoundingClientRect();
       const t = document.querySelector('.hdr-tour').getBoundingClientRect();
       const x = document.querySelector('.hdr-text').getBoundingClientRect();
       return getComputedStyle(document.getElementById('hdr-tools')).display === 'contents'
         && getComputedStyle(document.querySelector('.hdr-more')).display === 'none'
         && h.height < 120 && Math.abs(t.top - x.top) < 4;
     }));
  ok('Start still sits in the quick-start bar',
     await frame.evaluate(() => {
       const s = document.querySelector('.start-btn');
       return getComputedStyle(s).position === 'static'
         && s.getBoundingClientRect().top === document.querySelector('.qs-bar').getBoundingClientRect().top;
     }));
  await startGame(page, frame);
  ok('pro column is still a column beside the board',
     await page.evaluate(() => {
       const ps = document.getElementById('proSide').getBoundingClientRect();
       const cv = document.getElementById('cv').getBoundingClientRect();
       return getComputedStyle(document.getElementById('proSide')).display === 'flex'
         && ps.left > cv.right - 1 && Math.round(ps.width) === 330;
     }));
  ok('notation list is open, peek and caret hidden',
     await page.evaluate(() =>
       getComputedStyle(document.getElementById('proMoves')).display !== 'none'
       && getComputedStyle(document.querySelector('.pro-note-peek')).display === 'none'
       && getComputedStyle(document.querySelector('.pro-note-caret')).display === 'none'));
  ok('slide panels keep their desktop width',
     await page.evaluate(async () => {
       openPanel('themePanel');
       await new Promise(r => setTimeout(r, 400));
       const w = Math.round(document.getElementById('themePanel').getBoundingClientRect().width);
       closeAllPanels();
       return w === 300;
     }));
  ok('no console errors on desktop', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

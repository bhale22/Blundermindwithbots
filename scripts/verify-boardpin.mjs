// Phone board-visibility verification. Needs the server running on :3100 and
// must be run from the repo root (node_modules resolution):
//   node scripts/verify-boardpin.mjs
//
// The problem this exists to prevent coming back has not changed: every
// overlay is a VISUAL control, and the ninth one used to sit 586px down a
// stacked page where the board was entirely off screen — so you could never
// see what the control you were pressing did.
//
// The ANSWER changed twice. It used to be position:sticky, pinning the board
// and scrolling the controls through the ~370px that were left; this file was
// written against that. Then it was a sheet dragged up from the bottom edge.
// It is now a panel that slides in from the right when you ask for it, so the
// page under the panel is only ever the board and the things that belong with
// it. The assertions below are the same questions asked of that arrangement:
//
//   · every overlay is reachable, and the board is whole and unscrolled the
//     moment the panel is closed (the assertion this whole pass is about)
//   · the pinned strip puts the overlays you are drilling beside the board,
//     so the common case needs no panel at all
//   · playing Black swaps which clock sits above the board
//   · replay controls sit below the board block, not inside it
//   · a narrow landscape phone still fits board, clocks and game bar
//   · desktop is untouched by all of the above
//
// The panel's own behaviour — four states, Clear/Show all, explain mode, the
// three ways to close it — is verify-vispanel.mjs, not this file.
//
// Deliberately does NOT start a bot game — that is what makes verify-phone.mjs
// flaky, and none of the above needs one.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

async function open(width, height, mobile = true) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1,
    isMobile: mobile, hasTouch: mobile,
    userAgent: mobile
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36'
      : undefined,
  });
  await ctx.addInitScript(() => {
    try {
      ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1'));
      localStorage.setItem('bm_shell', 'amateur');
      // The first-visit dialog's veil swallows every tap until it is answered.
      localStorage.setItem('bm_welcomed', '1');
      localStorage.removeItem('bm_pins');
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// All thirteen overlays are in the panel, and opening it is how you reach any
// of them.
const openSheet = page => page.evaluate(() => visPanelOpen());

console.log('\n1    Every overlay is reachable, and the board is one flick away');
{
  const { ctx, page, errors } = await open(412, 915);
  await openSheet(page);
  await page.waitForTimeout(450);

  const reach = await page.evaluate(() => {
    const card = document.getElementById('visCard').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#visList .vis-row')];
    const unreachable = [];
    rows.forEach(el => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      // Inside the panel's own viewport, and a real target once there.
      if (r.height < 44 || r.bottom <= card.top || r.top >= card.bottom) unreachable.push(el.id);
    });
    return { count: rows.length, unreachable };
  });
  ok('all thirteen overlays are in the panel', reach.count === 13, String(reach.count));
  ok('every one is scrollable into view at 44px+', reach.unreachable.length === 0,
     reach.unreachable.join(', '));

  // Close it: the board must be whole, on screen, and the page unscrolled.
  await page.evaluate(() => visPanelClose());
  await page.waitForTimeout(450);
  const board = await page.evaluate(() => {
    const b = document.getElementById('board-canvas-wrap').getBoundingClientRect();
    return {
      size: Math.round(b.width),
      vis: Math.round(Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0))),
      panelGone: document.getElementById('visPanel').hidden,
      scrollY: window.scrollY,
      // Everything the board needs — clocks, strip, game bar — above the fold.
      barBottom: Math.round(document.getElementById('phoneBar').getBoundingClientRect().bottom),
      vh: innerHeight,
    };
  });
  ok('closing the panel leaves the board fully visible', board.vis === board.size,
     board.vis + ' of ' + board.size + 'px');
  ok('the panel leaves the page entirely', board.panelGone);
  ok('and it took no scrolling to get there', board.scrollY === 0, 'scrollY=' + board.scrollY);
  ok('the board, its clocks, the strip and the bar all fit above the fold',
     board.barBottom <= board.vh, board.barBottom + ' of ' + board.vh);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n2    The pinned strip needs no sheet at all');
{
  const { ctx, page, errors } = await open(412, 915);
  const r = await page.evaluate(() => {
    // Pin the classic drill: checks, threats and captures.
    visClearAll();
    ['checkthreats','threats','counts'].forEach(k => visCycle(k));
    const strip = document.getElementById('pinStrip').getBoundingClientRect();
    const board = document.getElementById('board-canvas-wrap').getBoundingClientRect();
    const bar = document.getElementById('phoneBar').getBoundingClientRect();
    const chips = [...document.querySelectorAll('#pinChips .pin-chip')];
    // Cycle one from the strip without opening anything.
    IND.threats.on = false; IND.threats.pre = false; ibUpdateUI('threats');
    ibTap('threats');
    const afterTap = { on: IND.threats.on, pre: IND.threats.pre,
                       cls: document.getElementById('pin-threats').className,
                       panelShut: document.getElementById('visPanel').hidden };
    return {
      chips: chips.length,
      minH: Math.min(...chips.map(c => Math.round(c.getBoundingClientRect().height))),
      belowBoard: strip.top >= board.bottom - 1,
      aboveTray: strip.bottom <= bar.top + 1,
      boardVisible: board.bottom <= innerHeight,
      afterTap,
    };
  });
  ok('the pinned overlays get a chip each', r.chips === 3, String(r.chips));
  ok('chips are a real touch target', r.minH >= 32, r.minH + 'px');
  ok('the strip sits below the board', r.belowBoard);
  ok('and above the game bar', r.aboveTray);
  ok('the board stays fully visible beside it', r.boardVisible);
  ok('a chip cycles its overlay without opening the panel',
     r.afterTap.pre === true && r.afterTap.panelShut === true,
     JSON.stringify(r.afterTap));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n3    Playing Black swaps which clock sits above the board');
{
  const { ctx, page, errors } = await open(412, 915);
  await page.evaluate(() => {
    boardFlipped = true;
    if (typeof syncBoardOrientation === 'function') syncBoardOrientation();
    if (typeof render === 'function') render();
  });
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const r = i => document.getElementById(i).getBoundingClientRect();
    const b = r('board-canvas-wrap');
    return { w: Math.round(r('playerBoxW').top), bl: Math.round(r('playerBoxB').top),
             board: Math.round(b.top), size: Math.round(b.width),
             vis: Math.round(Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0))) };
  });
  ok('White’s clock takes the top slot', g.w < g.board, 'playerBoxW@' + g.w + ' board@' + g.board);
  ok('Black’s clock sits below the board', g.bl > g.board, 'playerBoxB@' + g.bl);
  ok('the board is still fully visible', g.vis === g.size, g.vis + 'px of ' + g.size);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n4    Replay controls sit below the board block');
{
  const { ctx, page, errors } = await open(412, 915);
  await page.evaluate(() => {
    if (typeof gameMovesAlgebraic !== 'undefined') gameMovesAlgebraic = ['e4', 'e5', 'Nf3'];
    if (typeof startReplayOfCurrentGame === 'function') startReplayOfCurrentGame();
  });
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => {
    const el = document.getElementById('replayControls');
    const shown = getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const r = i => document.getElementById(i).getBoundingClientRect();
    return { shown, replay: Math.round(r('replayControls').top),
             board: Math.round(r('board-canvas-wrap').bottom),
             clock: Math.round(r('playerBoxW').top) };
  });
  ok('replay controls are shown', g.shown);
  // They belong between the board and the bottom clock, in DOM order — the old
  // failure was them wedging in above the board.
  ok('they sit below the board', !g.shown || g.replay >= g.board - 1,
     'replay@' + g.replay + ' board.bottom@' + g.board);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n5    A narrow landscape phone still fits the essentials');
{
  const { ctx, page, errors } = await open(740, 360);
  const g = await page.evaluate(() => {
    const r = i => document.getElementById(i).getBoundingClientRect();
    const b = r('board-canvas-wrap');
    return {
      sheet: getComputedStyle(document.getElementById('sidebar')).position,
      square: Math.abs(b.width - b.height) < 2,
      size: Math.round(b.width),
      barBottom: Math.round(r('phoneBar').bottom),
      boardBottom: Math.round(b.bottom),
      // In the fallback nothing is fixed, so the board is only ever covered by
      // something that is — which is the failure this guards against.
      boardClear: [...document.querySelectorAll('body *')].every(el => {
        if(getComputedStyle(el).position !== 'fixed') return true;
        const q = el.getBoundingClientRect();
        if(q.width === 0 || q.height === 0) return true;
        return q.top >= b.bottom - 1 || q.bottom <= b.top + 1 ||
               q.left >= b.right - 1 || q.right <= b.left + 1;
      }),
      hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  // Scroll to the end and check the controls actually come into view.
  const g2 = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const bar = document.getElementById('phoneBar').getBoundingClientRect();
    return { barBottom: Math.round(bar.bottom), vh: innerHeight };
  });
  g.barReachable = g2.barBottom <= g2.vh + 1;
  g.barBottom = g2.barBottom;
  // Nothing is fixed over the page any more, at any height — the controls are
  // a panel you open. A 360px-tall screen simply scrolls, which is what it did
  // before any of this.
  ok('740×360: the sidebar is a plain column', g.sheet === 'static', g.sheet);
  ok('740×360: the board is square', g.square, g.size + 'px');
  ok('740×360: the board is not covered by anything fixed', g.boardClear,
     'board.bottom@' + g.boardBottom);
  ok('740×360: the controls are reachable by scrolling', g.barReachable,
     'bar.bottom@' + g.barBottom + ' after scroll');
  ok('740×360: no horizontal scroll', !g.hScroll);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// Sections 6, 7 and 8 moved out with the things they tested.
//
// 6 measured the overlay grid's phone presentation — two up, names spelled
//   out, a state glyph per button. That grid is not on the phone any more:
//   it belongs to the sidebar, and the sidebar's overlay controls are
//   display:none under 760px. The panel's rows replaced it, and
//   verify-vispanel.mjs section 2 measures those. The grid's remaining
//   desktop presentation is section 9 below.
// 7 tested the "?" marks and explain mode; explain mode is a control in the
//   board-vision panel now (verify-vispanel.mjs section 5).
// 8 tested the "drawing now" bar, which is gone entirely — every overlay that
//   draws has a chip beside the board in its own state colour, which is
//   section 2 above.

console.log('\n9    Desktop is untouched');
for (const [w, h] of [[1440, 900], [1366, 600]]) {
  const { ctx, page, errors } = await open(w, h, false);
  const d = await page.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('.ind-grid')).gridTemplateColumns.split(' ').length,
    sheet: getComputedStyle(document.getElementById('sidebar')).position,
    strip: getComputedStyle(document.getElementById('pinStrip')).display,
    bar2: getComputedStyle(document.getElementById('phoneBar')).display,
    stick: getComputedStyle(document.getElementById('board-canvas-wrap')).position,
    col: getComputedStyle(document.getElementById('board-col')).display,
    keyRow: getComputedStyle(document.querySelector('.ind-key-row')).display,
    keyG: getComputedStyle(document.querySelector('.ind-key-g')).display,
    keyHold: getComputedStyle(document.querySelector('.key-hold')).display,
    lblSize: getComputedStyle(document.querySelector('#ib-counts .ib-lbl')).fontSize,
    clip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')].map(b => b.scrollWidth - b.clientWidth)),
    scrolls: document.documentElement.scrollHeight > innerHeight + 2,
  }));
  ok(w + ': grid is still two columns', d.cols === 2, String(d.cols));
  ok(w + ': the sidebar is a column, not a panel', d.sheet === 'static', d.sheet);
  ok(w + ': the pinned strip is hidden', d.strip === 'none', d.strip);
  ok(w + ': the phone game bar is hidden', d.bar2 === 'none', d.bar2);
  ok(w + ': the board is not pinned', d.stick === 'relative', d.stick);
  ok(w + ': #board-col is still a real box', d.col === 'flex', d.col);
  ok(w + ': the swatch key is kept', d.keyRow !== 'none', d.keyRow);
  ok(w + ': the glyph key is hidden', d.keyG === 'none', d.keyG);
  // Hold-to-peek survives where the controls sit beside the board.
  ok(w + ': the key still promises hold-to-peek', d.keyHold !== 'none', d.keyHold);
  // The phone blanks the short label to swap in data-full; desktop must not.
  ok(w + ': labels are not blanked', d.lblSize !== '0px', d.lblSize);
  ok(w + ': nothing clips', d.clip === 0, 'worst ' + d.clip + 'px');
  ok(w + ': the page still fits one screen', !d.scrolls);
  ok(w + ': no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

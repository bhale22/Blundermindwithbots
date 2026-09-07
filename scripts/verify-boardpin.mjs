// Phone board-visibility verification. Needs the server running on :3100 and
// must be run from the repo root (node_modules resolution):
//   node scripts/verify-boardpin.mjs
//
// The problem this exists to prevent coming back has not changed: every
// overlay is a VISUAL control, and the ninth one used to sit 586px down a
// stacked page where the board was entirely off screen — so you could never
// see what the control you were pressing did.
//
// The ANSWER changed. It used to be position:sticky, pinning the board and its
// clocks and scrolling the controls through the ~370px that were left; this
// file was written against that. The controls are now a bottom sheet that
// covers the board while it is open (see the bv-tray CSS block), which buys a
// whole screen to find a control in and puts the board one flick away instead
// of one scroll. The assertions below are the same questions asked of the new
// arrangement:
//
//   · every overlay is reachable, and the board is whole and unscrolled
//     the moment the sheet is closed (the assertion this whole pass is about)
//   · the pinned strip puts the overlays you are drilling beside the board,
//     so the common case needs no sheet at all
//   · playing Black swaps which clock sits above the board
//   · replay controls sit below the board block, not inside it
//   · a narrow landscape phone still fits board, clocks and game bar
//   · grid buttons are two-up, spell their names out, carry a state glyph
//   · no "?" is left inside a toggle to be hit by accident; explain mode is
//     the one deliberate way into help
//   · the "drawing now" bar lists always-on overlays only
//   · desktop is untouched by all of the above
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
      localStorage.removeItem('bm_bvt');
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// The sheet replaces the old "More board vision" disclosure: all thirteen
// overlays are simply in it, and opening it is how you reach any of them.
const openSheet = page => page.evaluate(() => bvTraySet('full'));

console.log('\n1    Every overlay is reachable, and the board is one flick away');
{
  const { ctx, page, errors } = await open(412, 915);
  await openSheet(page);
  await page.waitForTimeout(450);

  const reach = await page.evaluate(() => {
    const sheet = document.getElementById('sidebar');
    const ids = [...document.querySelectorAll('.ind-grid .ib[id^="ib-"]')].map(e => e.id);
    const sr = sheet.getBoundingClientRect();
    const unreachable = [];
    ids.forEach(id => {
      const el = document.getElementById(id);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      // Inside the sheet's own viewport, and a real target once there.
      if (r.height < 44 || r.bottom <= sr.top || r.top >= sr.bottom) unreachable.push(id);
    });
    return { count: ids.length, unreachable };
  });
  ok('all thirteen overlays are in the sheet', reach.count === 13, String(reach.count));
  ok('every one is scrollable into view at 44px+', reach.unreachable.length === 0,
     reach.unreachable.join(', '));

  // Close it: the board must be whole, on screen, and the page unscrolled.
  await page.evaluate(() => bvTraySet('closed'));
  await page.waitForTimeout(450);
  const board = await page.evaluate(() => {
    const b = document.getElementById('board-canvas-wrap').getBoundingClientRect();
    const tray = document.getElementById('sidebar').getBoundingClientRect();
    return {
      top: Math.round(b.top), bottom: Math.round(b.bottom), size: Math.round(b.width),
      vis: Math.round(Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0))),
      coveredByTray: b.bottom > tray.top,
      scrollY: window.scrollY,
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 2,
    };
  });
  ok('closing the sheet leaves the board fully visible', board.vis === board.size,
     board.vis + ' of ' + board.size + 'px');
  ok('the closed sheet does not cover the board', !board.coveredByTray);
  ok('and it took no scrolling to get there', board.scrollY === 0 && !board.pageScrolls,
     'scrollY=' + board.scrollY);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n2    The pinned strip needs no sheet at all');
{
  const { ctx, page, errors } = await open(412, 915);
  const r = await page.evaluate(() => {
    // Pin the classic drill: checks, threats and captures.
    pinToggleKey('checkthreats'); pinToggleKey('threats'); pinToggleKey('counts');
    const strip = document.getElementById('pinStrip').getBoundingClientRect();
    const board = document.getElementById('board-canvas-wrap').getBoundingClientRect();
    const tray = document.getElementById('sidebar').getBoundingClientRect();
    const chips = [...document.querySelectorAll('#pinChips .pin-chip')];
    // Cycle one from the strip without opening anything.
    IND.threats.on = false; IND.threats.pre = false; ibUpdateUI('threats');
    ibTap('threats');
    const afterTap = { on: IND.threats.on, pre: IND.threats.pre,
                       cls: document.getElementById('pin-threats').className,
                       tray: document.getElementById('sidebar').dataset.bvt };
    return {
      chips: chips.length,
      minH: Math.min(...chips.map(c => Math.round(c.getBoundingClientRect().height))),
      belowBoard: strip.top >= board.bottom - 1,
      aboveTray: strip.bottom <= tray.top + 1,
      boardVisible: board.bottom <= tray.top,
      afterTap,
    };
  });
  ok('the pinned overlays get a chip each', r.chips === 3, String(r.chips));
  ok('chips are a real touch target', r.minH >= 32, r.minH + 'px');
  ok('the strip sits below the board', r.belowBoard);
  ok('and above the closed sheet', r.aboveTray);
  ok('the board stays fully visible beside it', r.boardVisible);
  ok('a chip cycles its overlay without opening the sheet',
     r.afterTap.pre === true && r.afterTap.tray === 'closed',
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
      state: document.getElementById('sidebar').dataset.bvt,
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
      gridVisible: document.querySelector('.ind-grid').getBoundingClientRect().height > 0 &&
                   getComputedStyle(document.querySelector('.ind-grid')).visibility !== 'hidden',
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
  // A 360px-tall screen has no room for a sheet: the closed strip alone would
  // sit on the board's last two ranks. Below 520px tall the sidebar goes back
  // into the flow and the controls are reached by scrolling — the same
  // concession the old sticky layout made at the same breakpoint.
  ok('740×360: the sheet stands down to a column', g.sheet === 'static', g.sheet);
  ok('740×360: nothing is hidden by the closed state', g.gridVisible, String(g.gridVisible));
  ok('740×360: the board is square', g.square, g.size + 'px');
  ok('740×360: the board is not covered by anything fixed', g.boardClear,
     'board.bottom@' + g.boardBottom);
  ok('740×360: the controls are reachable by scrolling', g.barReachable,
     'bar.bottom@' + g.barBottom + ' after scroll');
  ok('740×360: no horizontal scroll', !g.hScroll);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n6    Grid buttons: two up, spelled out, state on the button');
{
  const { ctx, page } = await open(412, 915);
  await openSheet(page);
  await page.waitForTimeout(450);
  const c = await page.evaluate(() => {
    const grid = document.querySelector('.ind-grid');
    const btns = [...document.querySelectorAll('.ind-grid .ib-main')];
    const glyph = k => getComputedStyle(document.querySelector('#ib-' + k + ' .ib-main'), '::before').content;
    IND.pins.on = false; IND.pins.pre = false; ibUpdateUI('pins');
    const off = glyph('pins');
    IND.pins.pre = true; ibUpdateUI('pins');
    const exp = glyph('pins');
    IND.pins.on = true; ibUpdateUI('pins');
    const on = glyph('pins');
    return {
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      clip: Math.max(...btns.map(b => b.scrollWidth - b.clientWidth)),
      minH: Math.min(...btns.map(b => Math.round(b.getBoundingClientRect().height))),
      glyphs: [off, exp, on],
      spelled: ['weakb', 'discoveredopp', 'counts'].map(k =>
        document.querySelector('#ib-' + k + ' .ib-lbl').getAttribute('data-full')),
      aria: document.querySelector('#ib-pins .ib-main').getAttribute('aria-label'),
      keyRow: getComputedStyle(document.querySelector('.ind-key-row')).display,
    };
  });
  ok('two columns', c.cols === 2, String(c.cols));
  ok('nothing clips out of a button', c.clip === 0, 'worst ' + c.clip + 'px');
  ok('buttons clear the 44px touch minimum', c.minH >= 44, c.minH + 'px');
  ok('the three states are three different glyphs',
     new Set(c.glyphs).size === 3, c.glyphs.join(' / '));
  ok('the abbreviations are spelled out', c.spelled.every(v => v && v.length > 12), c.spelled.join(' | '));
  ok('state is in the accessible name too', /always on/.test(c.aria || ''), c.aria);
  ok('the swatch key gives way to the glyph key', c.keyRow === 'none', c.keyRow);
  await ctx.close();
}

console.log('\n7    No "?" to mis-tap; explain mode is the deliberate way in');
{
  const { ctx, page } = await open(412, 915);
  await openSheet(page);
  await page.waitForTimeout(450);
  const r = await page.evaluate(() => {
    const marks = document.querySelectorAll('.ind-grid .ib-help').length;
    IND.pins.on = false; IND.pins.pre = false; ibUpdateUI('pins');

    // Unarmed, a tap on the button cycles and opens nothing.
    ibTap('pins');
    const plain = { pre: IND.pins.pre,
                    help: document.getElementById('helpPanel').classList.contains('open') };

    // Armed, the same tap explains and leaves the overlay exactly as it was.
    ibExplainToggle(true);
    const armedCls = document.getElementById('bvtHelp').classList.contains('armed');
    const before = { on: IND.pins.on, pre: IND.pins.pre };
    ibTap('pins');
    const armed = {
      help: document.getElementById('helpPanel').classList.contains('open'),
      title: document.getElementById('helpPanelTitle').textContent,
      unchanged: IND.pins.on === before.on && IND.pins.pre === before.pre,
      disarmed: !document.getElementById('bvtHelp').classList.contains('armed'),
    };
    closeAllPanels();
    return { marks, plain, armedCls, armed };
  });
  ok('no "?" is left inside a toggle', r.marks === 0, String(r.marks));
  ok('a plain tap cycles and opens nothing', r.plain.pre === true && r.plain.help === false,
     JSON.stringify(r.plain));
  ok('the help control arms visibly', r.armedCls);
  ok('an armed tap opens that overlay’s help', r.armed.help && /pin/i.test(r.armed.title), r.armed.title);
  ok('an armed tap does not toggle the overlay', r.armed.unchanged);
  ok('and the mode disarms itself after one use', r.armed.disarmed);
  await ctx.close();
}

console.log('\n8    The "drawing now" bar tracks always-on only');
{
  const { ctx, page } = await open(412, 915);
  const r = await page.evaluate(() => {
    const bar = document.getElementById('indActiveBar');
    const chips = () => [...document.querySelectorAll('.iab-chip')].map(e => e.textContent.trim());
    // Twelve of thirteen default to "while exploring" — the bar must stay away.
    const atRest = { hidden: bar.hidden, pre: Object.keys(IND).filter(k => IND[k].pre).length,
                     idle: !document.getElementById('bvtIdle').hidden };
    IND.threats.on = true; ibUpdateUI('threats');
    const withOne = { hidden: bar.hidden, chips: chips(),
                      idle: !document.getElementById('bvtIdle').hidden };
    document.querySelector('.iab-chip').click();
    const afterTap = { hidden: bar.hidden, on: IND.threats.on, pre: IND.threats.pre };
    return { atRest, withOne, afterTap };
  });
  ok('hidden when nothing is always-on', r.atRest.hidden === true,
     'hidden=' + r.atRest.hidden + ' with ' + r.atRest.pre + ' exploring');
  ok('the closed sheet says so rather than showing a bare heading', r.atRest.idle === true);
  ok('appears when one is switched on', r.withOne.hidden === false && r.withOne.chips.length === 1,
     JSON.stringify(r.withOne));
  ok('and the idle line stands down', r.withOne.idle === false);
  ok('the chip names the overlay in full', /Threats & captures/.test(r.withOne.chips[0] || ''),
     r.withOne.chips[0]);
  ok('tapping a chip switches that overlay off',
     r.afterTap.on === false && r.afterTap.pre === false && r.afterTap.hidden === true,
     JSON.stringify(r.afterTap));
  await ctx.close();
}

console.log('\n9    Desktop is untouched');
for (const [w, h] of [[1440, 900], [1366, 600]]) {
  const { ctx, page, errors } = await open(w, h, false);
  const d = await page.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('.ind-grid')).gridTemplateColumns.split(' ').length,
    sheet: getComputedStyle(document.getElementById('sidebar')).position,
    handle: getComputedStyle(document.getElementById('bvtHandle')).display,
    strip: getComputedStyle(document.getElementById('pinStrip')).display,
    bar2: getComputedStyle(document.getElementById('phoneBar')).display,
    stick: getComputedStyle(document.getElementById('board-canvas-wrap')).position,
    col: getComputedStyle(document.getElementById('board-col')).display,
    bar: getComputedStyle(document.getElementById('indActiveBar')).display,
    keyRow: getComputedStyle(document.querySelector('.ind-key-row')).display,
    keyG: getComputedStyle(document.querySelector('.ind-key-g')).display,
    keyHold: getComputedStyle(document.querySelector('.key-hold')).display,
    lblSize: getComputedStyle(document.querySelector('#ib-counts .ib-lbl')).fontSize,
    clip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')].map(b => b.scrollWidth - b.clientWidth)),
    scrolls: document.documentElement.scrollHeight > innerHeight + 2,
  }));
  ok(w + ': grid is still two columns', d.cols === 2, String(d.cols));
  ok(w + ': the sidebar is a column, not a sheet', d.sheet === 'static', d.sheet);
  ok(w + ': the sheet handle is hidden', d.handle === 'none', d.handle);
  ok(w + ': the pinned strip is hidden', d.strip === 'none', d.strip);
  ok(w + ': the phone game bar is hidden', d.bar2 === 'none', d.bar2);
  ok(w + ': the board is not pinned', d.stick === 'relative', d.stick);
  ok(w + ': #board-col is still a real box', d.col === 'flex', d.col);
  ok(w + ': the bar stays out of it', d.bar === 'none', d.bar);
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

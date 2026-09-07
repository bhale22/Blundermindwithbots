// Phone board-pinning verification. Needs the server running on :3100 and must
// be run from the repo root (node_modules resolution):
//   node scripts/verify-boardpin.mjs
//
// Guards the September phone pass on the Visualization board. The problem it
// exists to prevent coming back: every overlay is a VISUAL control, and the
// ninth one used to sit 586px down a stacked page where the board was entirely
// off screen — so you could never see what the control you were pressing did.
//
// Covers:
//   · the board block is pinned, and EVERY overlay is reachable with all of it
//     on screen (the single assertion this whole pass is about)
//   · the sticky members have no transparent seams between them
//   · playing Black swaps which clock pins where
//   · replay controls sit below the pinned block, not inside it
//   · a narrow LANDSCAPE phone does not pin a block taller than its screen
//   · chips are two-up, spell their names out, and carry a state glyph
//   · tapping "?" opens help WITHOUT cycling the overlay it sits in
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
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// Open the second overlay group — nine of the thirteen live behind it.
const openMore = page => page.evaluate(() => {
  const t = document.getElementById('bv-toggle');
  if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
});

console.log('\n1    Every overlay is reachable with the board still on screen');
{
  const { ctx, page, errors } = await open(412, 915);
  await openMore(page);
  await page.waitForTimeout(300);
  const worst = await page.evaluate(async () => {
    const ids = [...document.querySelectorAll('.ind-grid .ib[id^="ib-"]')].map(e => e.id);
    let min = Infinity, minId = null;
    for (const id of ids) {
      document.getElementById(id).scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 30));
      const b = document.getElementById('board-canvas-wrap').getBoundingClientRect();
      const vis = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
      if (vis < min) { min = vis; minId = id; }
    }
    const h = Math.round(document.getElementById('board-canvas-wrap').getBoundingClientRect().height);
    return { min: Math.round(min), minId, board: h, count: ids.length };
  });
  ok('all thirteen overlays are present', worst.count === 13, String(worst.count));
  // This is the whole point of the pass. Before it, the last two overlays left 0px.
  ok('the board never leaves the screen', worst.min === worst.board,
     'worst was ' + worst.minId + ' at ' + worst.min + '/' + worst.board + 'px');
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n2    The pinned block has no transparent seams');
{
  const { ctx, page } = await open(412, 915);
  await openMore(page);
  await page.evaluate(() => document.getElementById('ib-weakb').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const r = i => document.getElementById(i).getBoundingClientRect();
    const t = r('playerBoxB'), b = r('board-canvas-wrap'), w = r('playerBoxW');
    const opaque = i => getComputedStyle(document.getElementById(i)).backgroundColor;
    return { seams: [Math.round(b.top - t.bottom), Math.round(w.top - b.bottom)],
             top: Math.round(t.top),
             bg: [opaque('playerBoxB'), opaque('board-canvas-wrap'), opaque('playerBoxW')] };
  });
  ok('the top clock is pinned at the viewport top', g.top === 0, String(g.top));
  ok('the gaps are the layout gap, not a hole', g.seams.every(v => v === 8), JSON.stringify(g.seams));
  // A transparent member would let the controls scroll through it.
  ok('every pinned member paints a background',
     g.bg.every(c => c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)), g.bg.join(' / '));
  await ctx.close();
}

console.log('\n3    Playing Black swaps which clock pins where');
{
  const { ctx, page, errors } = await open(412, 915);
  await page.evaluate(() => {
    boardFlipped = true;
    document.getElementById('board-col').classList.add('board-flipped');
    if (typeof render === 'function') render();
  });
  await openMore(page);
  await page.evaluate(() => document.getElementById('ib-weakb').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  // Sticky elements report their CURRENT position, so read the viewport rather
  // than trying to reconstruct layout order from scrollY.
  const g = await page.evaluate(() => {
    const r = i => document.getElementById(i).getBoundingClientRect();
    const b = r('board-canvas-wrap');
    return { w: Math.round(r('playerBoxW').top), bl: Math.round(r('playerBoxB').top),
             board: Math.round(b.top),
             vis: Math.round(Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0))) };
  });
  ok('White’s clock takes the top slot', g.w === 0, 'playerBoxW@' + g.w);
  ok('Black’s clock sits below the board', g.bl > g.board, 'playerBoxB@' + g.bl);
  ok('the board is still fully visible', g.vis === 392, g.vis + 'px');
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n4    Replay controls sit below the pinned block');
{
  const { ctx, page, errors } = await open(412, 915);
  await page.evaluate(() => parsePgnAndStartReplay('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'));
  await page.evaluate(() => rebuildToReplayIdx(4));
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const R = i => { const b = document.getElementById(i).getBoundingClientRect();
                     return { y: Math.round(b.top + scrollY), h: Math.round(b.height) }; };
    return { replay: R('replayControls'), clockW: R('playerBoxW'), dist: R('distPanel') };
  });
  ok('replay controls are shown', r.replay.h > 0, JSON.stringify(r.replay));
  // They are between the board and the clock in the DOM; order: moves them out,
  // or they would wedge into the pinned block and break its height arithmetic.
  ok('they do not wedge into the pinned block', r.replay.y > r.clockW.y,
     'replay@' + r.replay.y + ' vs clock@' + r.clockW.y);
  ok('the Maia odds panel is shown during review', r.dist.h > 0, JSON.stringify(r.dist));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n5    A narrow landscape phone does not pin');
{
  // Portrait limits the board by WIDTH, so the pinned block is ~59% of the
  // screen. Landscape under the 760px breakpoint limits it by HEIGHT, and the
  // block would take 312px of a 360px screen — worse than not pinning at all.
  for (const [w, h, shouldPin] of [[740, 360, false], [412, 915, true], [360, 640, true]]) {
    const { ctx, page } = await open(w, h);
    const r = await page.evaluate(() => ({
      pos: getComputedStyle(document.getElementById('board-canvas-wrap')).position,
      board: Math.round(document.getElementById('board-canvas-wrap').getBoundingClientRect().height),
    }));
    const pinned = r.pos === 'sticky';
    ok(w + '×' + h + ': ' + (shouldPin ? 'pins' : 'does not pin'), pinned === shouldPin, r.pos);
    if (pinned) {
      const left = h - (44 + 8 + r.board + 8 + 44);
      ok(w + '×' + h + ': leaves room to scroll', left >= 150, left + 'px left');
    }
    await ctx.close();
  }
}

console.log('\n6    Chips: two up, spelled out, state on the chip');
{
  const { ctx, page } = await open(412, 915);
  await openMore(page);
  await page.waitForTimeout(300);
  const c = await page.evaluate(() => {
    const grid = document.querySelector('.ind-grid');
    const chips = [...document.querySelectorAll('.ind-grid .ib-main')];
    const glyph = k => { const el = document.querySelector('#ib-' + k + ' .ib-main');
      return getComputedStyle(el, '::before').content; };
    IND.pins.on = false; IND.pins.pre = false; ibUpdateUI('pins');
    const off = glyph('pins');
    IND.pins.pre = true; ibUpdateUI('pins');
    const exp = glyph('pins');
    IND.pins.on = true; ibUpdateUI('pins');
    const on = glyph('pins');
    return {
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      clip: Math.max(...chips.map(b => b.scrollWidth - b.clientWidth)),
      minH: Math.min(...chips.map(b => Math.round(b.getBoundingClientRect().height))),
      helpW: Math.round(document.querySelector('.ind-grid .ib-help').getBoundingClientRect().width),
      helpH: Math.round(document.querySelector('.ind-grid .ib-help').getBoundingClientRect().height),
      glyphs: [off, exp, on],
      spelled: ['weakb', 'discoveredopp', 'counts'].map(k =>
        document.querySelector('#ib-' + k + ' .ib-lbl').getAttribute('data-full')),
      aria: document.querySelector('#ib-pins .ib-main').getAttribute('aria-label'),
      keyRow: getComputedStyle(document.querySelector('.ind-key-row')).display,
    };
  });
  ok('two columns', c.cols === 2, String(c.cols));
  ok('nothing clips out of a chip', c.clip === 0, 'worst ' + c.clip + 'px');
  ok('chips clear the 44px touch minimum', c.minH >= 44, c.minH + 'px');
  ok('the help mark is its own target', c.helpW >= 40 && c.helpH >= 44, c.helpW + '×' + c.helpH);
  ok('the three states are three different glyphs',
     new Set(c.glyphs).size === 3, c.glyphs.join(' / '));
  ok('the abbreviations are spelled out', c.spelled.every(v => v && v.length > 12), c.spelled.join(' | '));
  ok('state is in the accessible name too', /always on/.test(c.aria || ''), c.aria);
  ok('the swatch key gives way to the glyph key', c.keyRow === 'none', c.keyRow);
  await ctx.close();
}

console.log('\n7    Tapping "?" opens help without cycling the overlay');
{
  const { ctx, page, errors } = await open(412, 915);
  const before = await page.evaluate(() => ({ on: IND.pins.on, pre: IND.pins.pre }));
  const box = await page.locator('#ib-pins .ib-help').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    on: IND.pins.on, pre: IND.pins.pre,
    title: (document.getElementById('helpPanelTitle') || {}).textContent,
  }));
  // The mark used to guard onmousedown only, while the button around it listens
  // on ontouchstart — which fires first and bubbles. A tap cycled the overlay
  // AND opened an empty panel, so per-overlay help never worked on a phone.
  ok('the overlay is untouched by a help tap',
     before.on === after.on && before.pre === after.pre,
     JSON.stringify(before) + ' → ' + JSON.stringify(after));
  ok('help opens on the right topic', after.title === 'Pins', JSON.stringify(after.title));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n8    The "drawing now" bar tracks always-on only');
{
  const { ctx, page } = await open(412, 915);
  const r = await page.evaluate(() => {
    const bar = document.getElementById('indActiveBar');
    const chips = () => [...document.querySelectorAll('.iab-chip')].map(e => e.textContent.trim());
    // Twelve of thirteen default to "while exploring" — the bar must stay away.
    const atRest = { hidden: bar.hidden, pre: Object.keys(IND).filter(k => IND[k].pre).length };
    IND.threats.on = true; ibUpdateUI('threats');
    const withOne = { hidden: bar.hidden, chips: chips() };
    document.querySelector('.iab-chip').click();
    const afterTap = { hidden: bar.hidden, on: IND.threats.on, pre: IND.threats.pre };
    return { atRest, withOne, afterTap };
  });
  ok('hidden when nothing is always-on', r.atRest.hidden === true,
     'hidden=' + r.atRest.hidden + ' with ' + r.atRest.pre + ' exploring');
  ok('appears when one is switched on', r.withOne.hidden === false && r.withOne.chips.length === 1,
     JSON.stringify(r.withOne));
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
    stick: getComputedStyle(document.getElementById('board-canvas-wrap')).position,
    col: getComputedStyle(document.getElementById('board-col')).display,
    bar: getComputedStyle(document.getElementById('indActiveBar')).display,
    keyRow: getComputedStyle(document.querySelector('.ind-key-row')).display,
    keyG: getComputedStyle(document.querySelector('.ind-key-g')).display,
    lblSize: getComputedStyle(document.querySelector('#ib-counts .ib-lbl')).fontSize,
    clip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')].map(b => b.scrollWidth - b.clientWidth)),
    scrolls: document.documentElement.scrollHeight > innerHeight + 2,
  }));
  ok(w + ': grid is still two columns', d.cols === 2, String(d.cols));
  ok(w + ': the board is not pinned', d.stick === 'relative', d.stick);
  ok(w + ': #board-col is still a real box', d.col === 'flex', d.col);
  ok(w + ': the bar stays out of it', d.bar === 'none', d.bar);
  ok(w + ': the swatch key is kept', d.keyRow !== 'none', d.keyRow);
  ok(w + ': the glyph key is hidden', d.keyG === 'none', d.keyG);
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

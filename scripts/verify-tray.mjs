// Smoke test for the phone tray rework. Run from the repo root with the
// server up on :3100:  node <this file>
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? (pass++, console.log('  ✓ ' + n))
    : (fail++, console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + extra : '')));
};

const browser = await chromium.launch();

async function phone(w = 412, h = 915) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { if (!document.getElementById('bmWelcome').hidden) bmWelcomeChoose('solo'); } catch (e) {} });
  await page.waitForTimeout(600);
  return { ctx, page, errs };
}

console.log('\n── Phone 412x915 ──');
{
  const { ctx, page, errs } = await phone();

  const g = await page.evaluate(() => {
    const r = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
    const cs = id => { const e = document.getElementById(id); return e ? getComputedStyle(e) : null; };
    const sb = document.getElementById('sidebar');
    return {
      vh: window.innerHeight, vw: window.innerWidth,
      sbPos: cs('sidebar').position,
      sbState: sb.dataset.bvt,
      sbTop: r('sidebar').top,
      handleVisible: r('bvtHandle') && r('bvtHandle').height > 0,
      board: r('board-canvas-wrap'),
      pinStrip: r('pinStrip'),
      phoneBar: r('phoneBar'),
      pbW: r('playerBoxW'), pbB: r('playerBoxB'),
      helpMarks: document.querySelectorAll('.ind-grid .ib-help').length,
      bvToggle: cs('bv-toggle').display,
      boardSettings: cs('board-settings').display,
      pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
      scrollH: document.documentElement.scrollHeight,
      hasBvtFns: ['bvTraySet', 'bvTrayTap', 'pinRender', 'pinPickerOpen', 'flipPerspective', 'syncPhoneBar', 'ibTap', 'ibExplainToggle', 'boardViewFlipped']
        .filter(f => typeof window[f] !== 'function'),
    };
  });

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  ok('all new globals defined', g.hasBvtFns.length === 0, g.hasBvtFns.join(','));
  ok('sidebar is a fixed sheet', g.sbPos === 'fixed', g.sbPos);
  ok('sheet starts closed', g.sbState === 'closed', g.sbState);
  ok('closed sheet shows only its strip (top near fold)',
    g.sbTop > g.vh - 80 && g.sbTop < g.vh - 30, 'top=' + Math.round(g.sbTop) + ' vh=' + g.vh);
  ok('handle is on screen', g.handleVisible);
  ok('no "?" marks left on indicator buttons', g.helpMarks === 0, g.helpMarks);
  ok('"More board vision" toggle is gone', g.bvToggle === 'none', g.bvToggle);
  ok('board-settings is open, not folded', g.boardSettings !== 'none', g.boardSettings);
  ok('pinned strip on screen', g.pinStrip && g.pinStrip.height > 0);
  ok('game bar on screen', g.phoneBar && g.phoneBar.height > 0);

  // The whole point: board + clocks + strip + bar fit above the closed tray.
  const bottom = g.phoneBar ? g.phoneBar.bottom : 0;
  ok('everything fits above the closed tray',
    bottom <= g.sbTop + 1, 'bar bottom=' + Math.round(bottom) + ' tray top=' + Math.round(g.sbTop));
  ok('page does not scroll', !g.pageScrollable, 'scrollH=' + g.scrollH + ' vh=' + g.vh);
  ok('board is square', Math.abs(g.board.width - g.board.height) < 2,
    g.board.width + 'x' + g.board.height);
  ok('board is a usable size', g.board.width >= 300, g.board.width);
  ok('clocks bracket the board',
    g.pbB.bottom <= g.board.top + 1 && g.pbW.top >= g.board.bottom - 1,
    `B=${Math.round(g.pbB.bottom)} board=${Math.round(g.board.top)}..${Math.round(g.board.bottom)} W=${Math.round(g.pbW.top)}`);

  // ── Tray opens by tap ──
  await page.evaluate(() => bvTrayTap());
  await page.waitForTimeout(450);
  const half = await page.evaluate(() => ({
    st: document.getElementById('sidebar').dataset.bvt,
    top: document.getElementById('sidebar').getBoundingClientRect().top,
  }));
  ok('tap opens the sheet to half', half.st === 'half', half.st);
  ok('half covers about half the screen', half.top > 300 && half.top < 560, Math.round(half.top));

  await page.evaluate(() => bvTrayTap());
  await page.waitForTimeout(450);
  const full = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    const grid = document.querySelector('.ind-grid');
    return {
      st: sb.dataset.bvt, top: sb.getBoundingClientRect().top,
      gridVisible: grid.getBoundingClientRect().height > 0,
      firstBtn: document.querySelector('#ib-threats .ib-main').getBoundingClientRect(),
    };
  });
  ok('tap again opens it full', full.st === 'full', full.st);
  ok('overlay grid is on screen when full', full.gridVisible && full.firstBtn.top < 915 && full.firstBtn.height > 0,
    JSON.stringify(full.firstBtn));

  // ── Three states, no peek on the tray button ──
  const cyc = await page.evaluate(() => {
    const st = () => { const e = document.getElementById('ib-pins'); return e.className.replace('ib', '').trim(); };
    IND.pins.on = false; IND.pins.pre = false; ibUpdateUI('pins');
    const a = st(); ibTap('pins');
    const b = st(); ibTap('pins');
    const c = st(); ibTap('pins');
    return [a, b, c, st()];
  });
  ok('tap cycles off → exploring → always on → off',
    JSON.stringify(cyc) === JSON.stringify(['', 'pre', 'on', '']), JSON.stringify(cyc));

  // ── Explain mode ──
  const ex = await page.evaluate(() => {
    ibExplainToggle(true);
    const armed = document.getElementById('bvtHelp').classList.contains('armed');
    const before = { on: IND.pins.on, pre: IND.pins.pre };
    ibTap('pins');
    const panelOpen = document.getElementById('helpPanel').classList.contains('open');
    const title = document.getElementById('helpPanelTitle').textContent;
    const unchanged = IND.pins.on === before.on && IND.pins.pre === before.pre;
    const disarmed = !document.getElementById('bvtHelp').classList.contains('armed');
    closeAllPanels();
    return { armed, panelOpen, title, unchanged, disarmed };
  });
  ok('help arms', ex.armed);
  ok('armed tap opens that overlay’s help', ex.panelOpen && /pin/i.test(ex.title), ex.title);
  ok('armed tap does not toggle the overlay', ex.unchanged);
  ok('mode disarms after one use', ex.disarmed);

  // ── Pinned strip ──
  const pinres = await page.evaluate(() => {
    pinPickerOpen();
    const open = !document.getElementById('pinPicker').hidden;
    const nOpts = document.querySelectorAll('#pinPickerList .pin-opt').length;
    pinToggleKey('forksw'); pinToggleKey('weakw');
    pinPickerClose();
    const chips = [...document.querySelectorAll('#pinChips .pin-chip')].map(b => b.id);
    const hintHidden = document.getElementById('pinHint').hidden;
    return { open, nOpts, chips, hintHidden, stored: localStorage.getItem('bm_pins') };
  });
  ok('picker opens and lists every overlay', pinres.open && pinres.nOpts === 13, pinres.nOpts);
  ok('pinning adds chips', JSON.stringify(pinres.chips) === '["pin-forksw","pin-weakw"]', JSON.stringify(pinres.chips));
  ok('hint hides once something is pinned', pinres.hintHidden);
  ok('pins persist', pinres.stored === '["forksw","weakw"]', pinres.stored);

  // Chip state tracks IND, and hold-to-peek still works there.
  const chipState = await page.evaluate(async () => {
    IND.forksw.on = false; IND.forksw.pre = false; ibUpdateUI('forksw');
    const a = document.getElementById('pin-forksw').className;
    ibCycle('forksw');
    const b = document.getElementById('pin-forksw').className;
    // simulate a hold
    ibMainDown('forksw', null);
    await new Promise(r => setTimeout(r, 420));
    const held = document.getElementById('pin-forksw').className;
    ibMainUp('forksw');
    const after = document.getElementById('pin-forksw').className;
    return { a, b, held, after };
  });
  ok('chip is dark when the overlay is off', chipState.a.trim() === 'pin-chip', chipState.a);
  ok('chip follows the tray button', /pre/.test(chipState.b), chipState.b);
  ok('hold on a chip is a peek', /pressing/.test(chipState.held), chipState.held);
  ok('peek reverts on release', /pre/.test(chipState.after) && !/pressing/.test(chipState.after), chipState.after);

  await ctx.close();
}

console.log('\n── Flip perspective ──');
{
  const { ctx, page, errs } = await phone();
  const f = await page.evaluate(() => {
    const before = boardViewFlipped();
    flipPerspective();
    const after = boardViewFlipped();
    const cls = document.getElementById('board-col').classList.contains('board-flipped');
    // A view flip must not touch who is playing what.
    const seat = boardFlipped;
    const order = {
      W: getComputedStyle(document.getElementById('playerBoxW')).order,
      B: getComputedStyle(document.getElementById('playerBoxB')).order,
    };
    flipPerspective();
    return { before, after, cls, seat, order, back: boardViewFlipped() };
  });
  ok('flip changes the drawn orientation', f.before !== f.after);
  ok('flip does not change which colour you play', f.seat === false, String(f.seat));
  ok('clocks swap with the board', f.cls === true && f.order.W === '1' && f.order.B === '6', JSON.stringify(f.order));
  ok('flipping back restores it', f.back === f.before);

  // Playing Black online used to make the flip button a no-op.
  const mp = await page.evaluate(() => {
    mpRole = 'black';
    const _in = window.mpInGame; window.mpInGame = () => true;
    const seated = boardViewFlipped();      // true: sitting on Black's side
    flipPerspective();
    const turned = boardViewFlipped();      // must be false: turned round
    flipPerspective(); window.mpInGame = _in; mpRole = null;
    return { seated, turned };
  });
  ok('flip works while playing Black online', mp.seated === true && mp.turned === false,
    JSON.stringify(mp));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── Threat circles ──');
{
  const { ctx, page, errs } = await phone();
  const t = await page.evaluate(() => {
    // Build positions by hand and ask getCaptureColor directly.
    const mk = spec => {
      const bd = new Array(64).fill(null);
      for (const [sq, p, c] of spec) bd[sq] = { piece: p, color: c };
      return bd;
    };
    const probe = (bd, sq) => {
      const atk = buildDirectAtk(bd);
      return getCaptureColor(sq, bd[sq].color, bd, atk);
    };
    const S = n => n; // squares are 0..63, a1=0 style handled by rcSq elsewhere
    const out = {};

    // Queen on d4 (27) attacked by a rook, defended by three pawns.
    out.queenDefended = probe(mk([
      [27, 'Q', 'w'], [59, 'R', 'b'],
      [18, 'P', 'w'], [20, 'P', 'w'], [34, 'P', 'w'],
    ]), 27);

    // Knight attacked once, defended once.
    out.minorEven = probe(mk([[27, 'N', 'w'], [59, 'R', 'b'], [19, 'R', 'w']]), 27);
    // Knight attacked once, defended twice.
    out.minorOver = probe(mk([[27, 'N', 'w'], [59, 'R', 'b'], [19, 'R', 'w'], [26, 'R', 'w']]), 27);
    // Pawn attacked once, defended once.
    out.pawnEven = probe(mk([[27, 'P', 'w'], [59, 'R', 'b'], [19, 'R', 'w']]), 27);
    // Pawn attacked once, defended twice.
    out.pawnOver = probe(mk([[27, 'P', 'w'], [59, 'R', 'b'], [19, 'R', 'w'], [26, 'R', 'w']]), 27);
    // Rook attacked by a bishop (cheaper) though defended.
    out.rookCheap = probe(mk([[27, 'R', 'w'], [45, 'B', 'b'], [19, 'R', 'w']]), 27);
    // Nothing pointing at it.
    out.quiet = probe(mk([[27, 'N', 'w'], [19, 'R', 'w']]), 27);
    out.inks = Object.keys(THREAT_INK);
    return out;
  });
  ok('attacked queen → red sawtooth even when defended 3×', t.queenDefended === 'saw', t.queenDefended);
  ok('minor, evenly defended → yellow', t.minorEven === 'yellow', t.minorEven);
  ok('minor, over-defended → yellow/green', t.minorOver === 'yellowgreen', t.minorOver);
  ok('pawn, evenly defended → grey', t.pawnEven === 'grey', t.pawnEven);
  ok('pawn, over-defended → green', t.pawnOver === 'green', t.pawnOver);
  ok('cheap attacker still wins → red', t.rookCheap === 'red', t.rookCheap);
  ok('unattacked → no circle', t.quiet === 'none', t.quiet);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── A live game ──');
{
  const { ctx, page, errs } = await phone();
  await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
  await page.waitForTimeout(2200);
  const live = await page.evaluate(() => {
    const d = id => getComputedStyle(document.getElementById(id)).display;
    return {
      botActive: typeof botActive !== 'undefined' && botActive,
      quickBot: d('quickBot'), resign: d('pbResign'), draw: d('pbDraw'),
      chat: d('pbChat'), save: d('pbSave'), flip: d('pbFlip'), peek: d('pbPeek'),
      botBtn: d('botSidebarBtn'), mpBtn: d('mpSidebarBtn'),
      trayTop: document.getElementById('sidebar').getBoundingClientRect().top,
      barBottom: document.getElementById('phoneBar').getBoundingClientRect().bottom,
      boardW: document.getElementById('board-canvas-wrap').getBoundingClientRect().width,
    };
  });
  ok('game is running', live.botActive);
  ok('"Start Game vs Bot" is gone the moment the game starts', live.quickBot === 'none', live.quickBot);
  ok('the other starters are gone too', live.botBtn === 'none' && live.mpBtn === 'none',
    live.botBtn + '/' + live.mpBtn);
  ok('Resign is on the game bar', live.resign !== 'none', live.resign);
  ok('Offer draw is on the game bar', live.draw !== 'none', live.draw);
  ok('Peek / Flip / Settings / Save stay put',
    live.peek !== 'none' && live.flip !== 'none' && live.save !== 'none');
  ok('Chat stays hidden against a bot', live.chat === 'none', live.chat);
  ok('board still fits above the tray', live.barBottom <= live.trayTop + 1,
    Math.round(live.barBottom) + ' vs ' + Math.round(live.trayTop));

  // Ending it brings the starters back.
  const ended = await page.evaluate(() => {
    gameOver = true;
    if (typeof botStop === 'function') botStop();
    updateActionBtn();
    return {
      quickBot: getComputedStyle(document.getElementById('quickBot')).display,
      resign: getComputedStyle(document.getElementById('pbResign')).display,
    };
  });
  ok('starters return when the game ends', ended.quickBot !== 'none', ended.quickBot);
  ok('Resign goes when there is nothing to resign', ended.resign === 'none', ended.resign);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── Drag and flick ──');
{
  const { ctx, page, errs } = await phone();
  const grip = await page.evaluate(() => {
    const r = document.getElementById('bvtHandle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 14 };
  });

  // A slow, long drag upward should land on full.
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(grip.x, grip.y - i * 40, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  ok('dragging the grip up opens the sheet',
    await page.evaluate(() => document.getElementById('sidebar').dataset.bvt) === 'full');

  // Dragging it back down closes it.
  const gripFull = await page.evaluate(() => {
    const r = document.getElementById('bvtHandle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 14 };
  });
  await page.mouse.move(gripFull.x, gripFull.y);
  await page.mouse.down();
  for (let i = 1; i <= 22; i++) await page.mouse.move(gripFull.x, gripFull.y + i * 40, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  ok('dragging it back down closes it',
    await page.evaluate(() => document.getElementById('sidebar').dataset.bvt) === 'closed');

  // A short, fast flick from the closed strip must still open it — this is the
  // case that "snap to whatever is nearest" gets wrong.
  const g2 = await page.evaluate(() => {
    const r = document.getElementById('bvtHandle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 14 };
  });
  await page.mouse.move(g2.x, g2.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(g2.x, g2.y - i * 14, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  const flicked = await page.evaluate(() => document.getElementById('sidebar').dataset.bvt);
  ok('a short flick up opens it rather than snapping back', flicked !== 'closed', flicked);

  // Pressing a chip in the strip must not drag the sheet.
  await page.evaluate(() => { bvTraySet('closed'); IND.pins.on = true; ibUpdateUI('pins'); });
  await page.waitForTimeout(400);
  const chipHit = await page.evaluate(() => {
    const c = document.querySelector('#indActiveChips .iab-chip');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  ok('the closed strip lists what is drawing', chipHit !== null);
  if (chipHit) {
    await page.mouse.click(chipHit.x, chipHit.y);
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => ({
      on: IND.pins.on, state: document.getElementById('sidebar').dataset.bvt,
    }));
    ok('tapping a chip turns that overlay off', after.on === false, String(after.on));
    ok('and does not drag the sheet open', after.state === 'closed', after.state);
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── Small phone 360x640 ──');
{
  const { ctx, page, errs } = await phone(360, 640);
  const g = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    return {
      board: r('board-canvas-wrap'), bar: r('phoneBar'),
      tray: r('sidebar'), vh: window.innerHeight,
      barBtns: [...document.querySelectorAll('#phoneBar .pbtn')]
        .filter(b => getComputedStyle(b).display !== 'none')
        .map(b => Math.round(b.getBoundingClientRect().width)),
    };
  });
  ok('board is still square', Math.abs(g.board.width - g.board.height) < 2);
  ok('board is not crushed', g.board.width >= 280, g.board.width);
  ok('game bar clears the tray', g.bar.bottom <= g.tray.top + 1,
    Math.round(g.bar.bottom) + ' vs ' + Math.round(g.tray.top));
  ok('every game-bar button is still tappable', g.barBtns.every(w => w >= 40), g.barBtns.join(','));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── Landscape 740x360 ──');
{
  const { ctx, page, errs } = await phone(740, 360);
  const g = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    return {
      sbPos: getComputedStyle(document.getElementById('sidebar')).position,
      state: document.getElementById('sidebar').dataset.bvt,
      board: r('board-canvas-wrap'), tray: r('sidebar'), vh: window.innerHeight,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  // Below 520px tall there is no room for a sheet — see the max-height:520px
  // block. It stands down to an in-flow column, which verify-boardpin covers
  // in full; here we only check the fallback engages and stays sane.
  ok('the sheet stands down to a column', g.sbPos === 'static', g.sbPos);
  ok('board is square', Math.abs(g.board.width - g.board.height) < 2,
    g.board.width + 'x' + g.board.height);
  ok('no horizontal scroll', !g.hScroll);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n── Desktop 1440x900 unchanged ──');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { if (!document.getElementById('bmWelcome').hidden) bmWelcomeChoose('solo'); } catch (e) {} });
  await page.waitForTimeout(500);
  const d = await page.evaluate(() => {
    const cs = id => getComputedStyle(document.getElementById(id));
    const r = id => document.getElementById(id).getBoundingClientRect();
    return {
      sbPos: cs('sidebar').position,
      handle: cs('bvtHandle').display,
      pin: cs('pinStrip').display,
      bar: cs('phoneBar').display,
      settings: cs('board-settings').display,
      board: r('board-canvas-wrap'),
      sidebar: r('sidebar'),
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  ok('sidebar is still a column', d.sbPos === 'static', d.sbPos);
  ok('tray handle hidden', d.handle === 'none', d.handle);
  ok('pinned strip hidden', d.pin === 'none', d.pin);
  ok('game bar hidden', d.bar === 'none', d.bar);
  ok('board-settings still display:contents', d.settings === 'contents', d.settings);
  ok('sidebar sits beside the board', d.sidebar.left > d.board.right - 1,
    `board.right=${Math.round(d.board.right)} sidebar.left=${Math.round(d.sidebar.left)}`);
  ok('no horizontal scroll', !d.hScroll);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

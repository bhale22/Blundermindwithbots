// Board-vision panel verification. Needs the server running on :3100 and must
// be run from the repo root (node_modules resolution):
//   node scripts/verify-vispanel.mjs
//
// Covers the phone pass that replaced the sidebar controls with one right-side
// panel:
//   · the panel is the only control surface under 760px, and it opens from the
//     pinned strip
//   · four states per overlay, and "on" always implies a chip beside the board
//   · the chips cycle the three display states and never unselect
//   · Clear all / Show all, moved here from the sidebar's hold-only utilities
//   · explain mode STAYS armed, so several overlays can be read in a row
//   · closes on ✕, on a swipe right, and on a tap outside
//   · state survives a reload
//   · the game bar: Resign/Draw/Peek/Flip/Settings/Save/Chat
//   · flip changes the view without changing who is playing what
//   · the threat-circle rules, and forks with no material judgement in them
//   · desktop is untouched
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? (pass++, console.log('  ✓ ' + n))
    : (fail++, console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + extra : '')));
};

const browser = await chromium.launch();

async function open(w = 412, h = 915, mobile = true, seed, shell = 'amateur') {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: 1,
    isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(a => {
    try {
      ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1'));
      localStorage.setItem('bm_shell', a.shell);
      localStorage.setItem('bm_welcomed', '1');
      if (a.seed) localStorage.setItem('bm_pins', a.seed); else localStorage.removeItem('bm_pins');
    } catch (e) {}
  }, { seed: seed || null, shell });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    try { if (!document.getElementById('bmWelcome').hidden) bmWelcomeChoose('solo'); } catch (e) {}
    // The Expert shell opens on a full landing page, not on the board.
    try { if (typeof landingDismiss === 'function') landingDismiss(); } catch (e) {}
  });
  await page.waitForTimeout(600);
  return { ctx, page, errs };
}

console.log('\n1    The panel is the control surface');
{
  const { ctx, page, errs } = await open();
  const g = await page.evaluate(() => {
    const d = s => getComputedStyle(document.querySelector(s)).display;
    return {
      fns: ['visPanelOpen','visPanelClose','visCycle','visState','visClearAll','visShowAll','visPaintRow','flipPerspective']
        .filter(f => typeof window[f] !== 'function'),
      // Nothing that used to be a control is left loose in the page.
      sidebarShown: [...document.getElementById('sidebar').children]
        .filter(c => getComputedStyle(c).display !== 'none')
        .map(c => c.id || c.className),
      grid: d('.ind-grid'),
      key: d('.ind-key'),
      toggle: d('#bv-toggle'),
      strip: d('#pinStrip'),
      bar: d('#phoneBar'),
      panelHidden: document.getElementById('visPanel').hidden,
      // The tray is gone, root and branch.
      trayLeftovers: ['bvtHandle','indActiveBar','pinPicker'].filter(i => document.getElementById(i)),
    };
  });
  ok('all panel globals defined', g.fns.length === 0, g.fns.join(','));
  ok('the sidebar keeps only start-a-game and the floor',
    JSON.stringify(g.sidebarShown) === '["quickBot","bottom-controls"]', JSON.stringify(g.sidebarShown));
  ok('the overlay grid is not loose in the page', g.grid === 'none', g.grid);
  ok('nor its key, nor the old disclosure', g.key === 'none' && g.toggle === 'none');
  ok('the pinned strip is on screen', g.strip === 'flex', g.strip);
  ok('the game bar is on screen', g.bar === 'flex', g.bar);
  ok('the panel starts closed', g.panelHidden === true);
  ok('no trace of the bottom tray is left', g.trayLeftovers.length === 0, g.trayLeftovers.join(','));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n2    Four states, and "on" always has a chip');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(300);

  const rows = await page.evaluate(() => document.querySelectorAll('#visList .vis-row').length);
  ok('one row per overlay', rows === 13, String(rows));

  const cyc = await page.evaluate(() => {
    // Start from unselected whatever the defaults did.
    while (visState('overloaded') !== 0) visCycle('overloaded');
    const snap = () => {
      const r = document.getElementById('vis-overloaded');
      return {
        st: visState('overloaded'),
        cls: r.className.replace('vis-row', '').trim(),
        word: r.querySelector('.vis-st').textContent,
        chip: !!document.getElementById('pin-overloaded'),
        drawing: IND.overloaded.on,
        exploring: IND.overloaded.pre,
      };
    };
    const out = [snap()];
    for (let i = 0; i < 4; i++) { visCycle('overloaded'); out.push(snap()); }
    return out;
  });
  ok('0 unselected — no chip, nothing drawing',
    cyc[0].st === 0 && !cyc[0].chip && !cyc[0].drawing && !cyc[0].exploring, JSON.stringify(cyc[0]));
  ok('1 selected — chip beside the board, overlay off',
    cyc[1].st === 1 && cyc[1].chip && !cyc[1].drawing && !cyc[1].exploring && cyc[1].cls === 'sel',
    JSON.stringify(cyc[1]));
  ok('2 exploring — purple row, drawn while exploring',
    cyc[2].st === 2 && cyc[2].chip && cyc[2].exploring && !cyc[2].drawing && /exp/.test(cyc[2].cls),
    JSON.stringify(cyc[2]));
  ok('3 always on — green row, drawn all the time',
    cyc[3].st === 3 && cyc[3].chip && cyc[3].drawing && /\bon\b/.test(cyc[3].cls),
    JSON.stringify(cyc[3]));
  ok('and back to unselected', cyc[4].st === 0 && !cyc[4].chip, JSON.stringify(cyc[4]));
  ok('every state says which it is in words',
    cyc.slice(1, 4).every(s => s.word.length > 0), cyc.map(s => s.word).join('|'));

  // The invariant the single axis exists to guarantee.
  const inv = await page.evaluate(() => {
    visShowAll();
    const drawing = Object.keys(IND).filter(k => document.getElementById('ib-' + k) && IND[k].on);
    return drawing.filter(k => !document.getElementById('pin-' + k));
  });
  ok('nothing can be drawing without a chip naming it', inv.length === 0, inv.join(','));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n3    Chips cycle the display states and never unselect');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    visPanelOpen();
    while (visState('pins') !== 1) visCycle('pins');   // selected, off
    const seen = [];
    for (let i = 0; i < 4; i++) { ibTap('pins'); seen.push(visState('pins')); }
    return { seen, stillPinned: pinnedInds.indexOf('pins') >= 0 };
  });
  ok('a chip walks 1 → 2 → 3 → 1', JSON.stringify(r.seen) === '[2,3,1,2]', JSON.stringify(r.seen));
  ok('and never drops the overlay off the strip', r.stillPinned);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n4    Clear all and Show all');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    visPanelOpen();
    visShowAll();
    const all = {
      pinned: pinnedInds.length,
      chips: document.querySelectorAll('#pinChips .pin-chip').length,
      on: Object.keys(IND).filter(k => document.getElementById('ib-' + k) && IND[k].on).length,
    };
    visClearAll();
    const none = {
      pinned: pinnedInds.length,
      chips: document.querySelectorAll('#pinChips .pin-chip').length,
      on: Object.keys(IND).filter(k => IND[k].on).length,
      pre: Object.keys(IND).filter(k => document.getElementById('ib-' + k) && IND[k].pre).length,
      hint: !document.getElementById('pinHint').hidden,
      strip: getComputedStyle(document.getElementById('pinStrip')).display,
    };
    return { all, none };
  });
  ok('Show all selects and lights every overlay',
    r.all.pinned === 13 && r.all.chips === 13 && r.all.on === 13, JSON.stringify(r.all));
  ok('Clear all empties the strip', r.none.pinned === 0 && r.none.chips === 0, JSON.stringify(r.none));
  ok('and leaves nothing drawing', r.none.on === 0 && r.none.pre === 0, JSON.stringify(r.none));
  ok('the empty strip explains itself', r.none.hint === true);
  ok('the strip stays as the door to the panel', r.none.strip === 'flex', r.none.strip);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n5    Explain mode stays armed');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    visPanelOpen();
    const before = { on: IND.forksw.on, pre: IND.forksw.pre, st: visState('forksw') };
    ibExplainToggle(true);
    const armed = document.getElementById('visInfo').classList.contains('armed');
    visCycle('forksw');
    const first = {
      title: document.getElementById('helpPanelTitle').textContent,
      open: document.getElementById('helpPanel').classList.contains('open'),
      stillArmed: document.getElementById('visInfo').classList.contains('armed'),
      unchanged: visState('forksw') === before.st,
    };
    // The point of pinning it: a second question costs no second press.
    visCycle('checkthreats');
    const second = {
      title: document.getElementById('helpPanelTitle').textContent,
      stillArmed: ibExplain,
      unchanged: IND.checkthreats.on === false,
    };
    ibExplainToggle(false);
    const off = { armed: document.getElementById('visInfo').classList.contains('armed') };
    // And once disarmed it cycles again.
    const st0 = visState('checkthreats');
    visCycle('checkthreats');
    const cycles = visState('checkthreats') !== st0;
    return { armed, first, second, off, cycles };
  });
  ok('the ? arms visibly', r.armed);
  ok('an armed tap explains instead of toggling',
    r.first.open && /fork/i.test(r.first.title) && r.first.unchanged, JSON.stringify(r.first));
  ok('and stays armed for the next question', r.first.stillArmed);
  ok('a second overlay explains without re-arming',
    /check/i.test(r.second.title) && r.second.stillArmed && r.second.unchanged, JSON.stringify(r.second));
  ok('pressing ? again disarms it', r.off.armed === false);
  ok('after which rows cycle normally', r.cycles);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n6    Three ways to close it');
{
  const { ctx, page, errs } = await open();
  const shown = () => page.evaluate(() =>
    !document.getElementById('visPanel').hidden &&
    document.getElementById('visPanel').classList.contains('in'));

  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(300);
  ok('opens', await shown());
  await page.click('.vis-x');
  await page.waitForTimeout(350);
  ok('the ✕ closes it', !(await shown()));

  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(300);
  // A tap on the board behind it.
  await page.mouse.click(30, 400);
  await page.waitForTimeout(350);
  ok('a tap outside closes it', !(await shown()));

  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => {
    const r = document.getElementById('visCard').getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + i * 18, box.y, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  ok('a swipe right closes it', !(await shown()));

  // A vertical drag is a scroll, not a close.
  await page.evaluate(() => { visPanelOpen(); });
  await page.waitForTimeout(300);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x, box.y - i * 18, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  ok('a vertical drag does not close it', await shown());
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n7    Choices survive a reload');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => {
    visPanelOpen(); visClearAll();
    while (visState('xray') !== 3) visCycle('xray');            // always on
    while (visState('overloaded') !== 1) visCycle('overloaded'); // selected, off
  });
  const stored = await page.evaluate(() => localStorage.getItem('bm_pins'));
  ok('states are written, not just the selection',
    /"xray":3/.test(stored) && /"overloaded":1/.test(stored), stored);
  await ctx.close();
  // A fresh context seeded with exactly what the first one wrote. Reloading the
  // same page would not test this: the init script above re-seeds storage on
  // every navigation, so a reload would wipe what we just saved.
  const second = await open(412, 915, true, stored);
  const page2 = second.page;
  errs.push(...second.errs);
  const back = await page2.evaluate(() => ({
    xray: visState('xray'), over: visState('overloaded'),
    threats: visState('threats'),
    chips: [...document.querySelectorAll('#pinChips .pin-chip')].map(c => c.id.slice(4)).sort(),
    drawing: IND.xray.on,
  }));
  ok('an always-on overlay comes back always-on', back.xray === 3 && back.drawing, JSON.stringify(back));
  ok('a selected-but-off overlay comes back selected and off', back.over === 1, String(back.over));
  ok('a cleared overlay stays cleared', back.threats === 0, String(back.threats));
  ok('and the strip matches', JSON.stringify(back.chips) === '["overloaded","xray"]', JSON.stringify(back.chips));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await second.ctx.close();
}

console.log('\n8    First visit');
{
  const { ctx, page, errs } = await open();
  const g = await page.evaluate(() => ({
    pinned: pinnedInds.slice(),
    states: pinnedInds.map(k => visState(k)),
    drawingAtRest: Object.keys(IND).filter(k => document.getElementById('ib-' + k) && IND[k].on),
  }));
  ok('a first visit starts with the "start with these" four',
    JSON.stringify(g.pinned) === '["threats","counts","unprotected","pins"]', JSON.stringify(g.pinned));
  ok('set to draw while exploring, not always on',
    g.states.every(s => s === 2), JSON.stringify(g.states));
  ok('so a first board is not covered in thirteen layers',
    g.drawingAtRest.length === 0, g.drawingAtRest.join(','));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n9    The game bar');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
  await page.waitForTimeout(2200);
  const live = await page.evaluate(() => {
    const d = id => getComputedStyle(document.getElementById(id)).display;
    return {
      quickBot: d('quickBot'), resign: d('pbResign'), draw: d('pbDraw'), chat: d('pbChat'),
      peek: d('pbPeek'), flip: d('pbFlip'), settings: d('pbSettings'), save: d('pbSave'),
    };
  });
  ok('"Start Game vs Bot" goes when the game starts', live.quickBot === 'none', live.quickBot);
  ok('Resign and Offer draw arrive', live.resign !== 'none' && live.draw !== 'none');
  ok('Peek / Flip / Settings / Save stay put',
    [live.peek, live.flip, live.settings, live.save].every(v => v !== 'none'));
  ok('Chat stays away against a bot', live.chat === 'none', live.chat);

  const f = await page.evaluate(() => {
    const before = boardViewFlipped(), seat = boardFlipped;
    flipPerspective();
    return { changed: boardViewFlipped() !== before, seatUnchanged: boardFlipped === seat,
             cls: document.getElementById('board-col').classList.contains('board-flipped') };
  });
  ok('Flip turns the board round', f.changed && f.cls);
  ok('without changing which colour you are playing', f.seatUnchanged);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n10   Threat circles and forks');
{
  const { ctx, page, errs } = await open();
  const t = await page.evaluate(() => {
    const mk = spec => { const bd = new Array(64).fill(null);
      for (const [sq, p, c] of spec) bd[sq] = { piece: p, color: c }; return bd; };
    const probe = (bd, sq) => getCaptureColor(sq, bd[sq].color, bd, buildDirectAtk(bd));
    return {
      queenDefended: probe(mk([[27,'Q','w'],[59,'R','b'],[18,'P','w'],[20,'P','w'],[34,'P','w']]), 27),
      minorEven: probe(mk([[27,'N','w'],[59,'R','b'],[19,'R','w']]), 27),
      minorOver: probe(mk([[27,'N','w'],[59,'R','b'],[19,'R','w'],[26,'R','w']]), 27),
      pawnEven: probe(mk([[27,'P','w'],[59,'R','b'],[19,'R','w']]), 27),
      pawnOver: probe(mk([[27,'P','w'],[59,'R','b'],[19,'R','w'],[26,'R','w']]), 27),
      rookCheap: probe(mk([[27,'R','w'],[45,'B','b'],[19,'R','w']]), 27),
      quiet: probe(mk([[27,'N','w'],[19,'R','w']]), 27),
    };
  });
  ok('attacked queen → red sawtooth even when defended 3×', t.queenDefended === 'saw', t.queenDefended);
  ok('minor, evenly defended → yellow', t.minorEven === 'yellow', t.minorEven);
  ok('minor, over-defended → yellow/green', t.minorOver === 'yellowgreen', t.minorOver);
  ok('pawn, evenly defended → grey', t.pawnEven === 'grey', t.pawnEven);
  ok('pawn, over-defended → green', t.pawnOver === 'green', t.pawnOver);
  ok('cheap attacker still wins → red', t.rookCheap === 'red', t.rookCheap);
  ok('unattacked → no circle', t.quiet === 'none', t.quiet);

  // Forks: no material arithmetic left, one exclusion.
  const fk = await page.evaluate(() => {
    const src = computeForkData.toString();
    return {
      noCombined: !/combinedVal/.test(src),
      noSee: !/seeLandingScore/.test(src),
      hangRule: /landAtt\s*>\s*0\s*&&\s*landDef\s*===\s*0/.test(src),
    };
  });
  ok('no combined-value judgement left in forks', fk.noCombined);
  ok('no static-exchange judgement left either', fk.noSee);
  ok('the one exclusion is "would hang on the landing square"', fk.hangRule);

  // And a concrete one: a knight forking two pawns used to be judged not worth
  // showing. It is a fork, so it shows.
  const cur = await page.evaluate(() => {
    const bd = new Array(64).fill(null);
    bd[27] = { piece:'N', color:'w' };      // d4
    bd[42] = { piece:'P', color:'b' };      // c6 — knight-move from d4
    bd[44] = { piece:'P', color:'b' };      // e6 — knight-move from d4
    const r = computeForkData(bd, 'w', new Set());
    return r.current.length;
  });
  ok('a knight forking two pawns is shown', cur >= 1, String(cur));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n11   Board settings');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => openPanel('boardSettingsPanel'));
  await page.waitForTimeout(350);
  const g = await page.evaluate(() => {
    const p = document.getElementById('boardSettingsPanel').getBoundingClientRect();
    const heads = [...document.querySelectorAll('#boardSettingsPanel .bs-head')].map(h => h.textContent.trim());
    return {
      heads,
      left: Math.round(p.left), top: Math.round(p.top),
      vw: innerWidth, vh: innerHeight,
      board: document.getElementById('bsBoardVal').textContent,
      piece: document.getElementById('bsPieceVal').textContent,
      theme: document.getElementById('bsThemeVal').textContent,
      ghostHere: !!document.querySelector('#boardSettingsPanel #soloGhostDepth'),
      ghostGone: !document.querySelector('#sidebar #soloGhostDepth'),
    };
  });
  ok('"What counts as a threat" is gone', !g.heads.includes('What counts as a threat'), g.heads.join(' | '));
  ok('Appearance, Board and Ghost replies are the three groups',
    JSON.stringify(g.heads) === '["Appearance","Board","Ghost replies"]', JSON.stringify(g.heads));
  ok('ghost replies moved into the panel', g.ghostHere && g.ghostGone);
  ok('it leaves the left quarter of the screen free', g.left >= g.vw * 0.22,
    g.left + ' of ' + g.vw);
  ok('and the upper third', g.top >= g.vh * 0.30, g.top + ' of ' + g.vh);
  ok('Board names the shell it is on', /Visualization Board/.test(g.board), g.board);
  ok('Piece style names the set', g.piece.length > 2, g.piece);
  ok('Board & background names the theme', g.theme.length > 1, g.theme);

  const sw = await page.evaluate(() => { bsToggleShell(); const v = document.getElementById('bsBoardVal').textContent; bsToggleShell(); return v; });
  ok('the Board row switches shells', /Expert Board/.test(sw), sw);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n12   The panel is two up, and sized to what it holds');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => visPanelOpen());
  await page.waitForTimeout(350);
  const g = await page.evaluate(() => {
    const card = document.getElementById('visCard').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#visList .vis-row')];
    const lefts = new Set(rows.map(r => Math.round(r.getBoundingClientRect().left)));
    const wide = rows.filter(r => r.classList.contains('vis-wide'));
    return {
      cols: getComputedStyle(document.getElementById('visList')).gridTemplateColumns.split(' ').length,
      distinctLefts: lefts.size,
      wide: wide.map(r => r.id),
      cardTop: Math.round(card.top), cardH: Math.round(card.height), vh: innerHeight,
      cardLeft: Math.round(card.left), vw: innerWidth,
      clipped: rows.filter(r => { const n = r.querySelector('.vis-nm'); return n.scrollWidth > n.clientWidth + 1; }).length,
      minH: Math.min(...rows.map(r => Math.round(r.getBoundingClientRect().height))),
    };
  });
  ok('the list is a two-column grid', g.cols === 2, String(g.cols));
  ok('and the rows actually sit in two columns', g.distinctLefts === 2, String(g.distinctLefts));
  ok('the one overlay with no pair spans the row',
    JSON.stringify(g.wide) === '["vis-checkthreats"]', JSON.stringify(g.wide));
  ok('it does not stretch to the full height of the screen',
    g.cardH < g.vh * 0.85, g.cardH + ' of ' + g.vh);
  ok('it leaves the top of the screen free', g.cardTop > g.vh * 0.2,
    g.cardTop + ' of ' + g.vh);
  ok('and the left edge', g.cardLeft > 0, g.cardLeft + ' of ' + g.vw);
  ok('no name is clipped in a half-width cell', g.clipped === 0, String(g.clipped));
  ok('rows are still a real touch target', g.minH >= 44, g.minH + 'px');
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n13   Flip turns the pieces, not just the squares');
{
  const { ctx, page, errs } = await open();
  // Sample the top-left square of the canvas. Unflipped it holds a black rook;
  // flipped it must hold a white one. The bug this guards against had render()
  // asking boardViewFlipped() while sqCanvas/sqXY read boardFlipped directly,
  // so the board turned under the pieces and left them where they were.
  const px = () => page.evaluate(() => {
    const cv = document.getElementById('cv');
    const s = cv.width / 8;
    const d = cv.getContext('2d').getImageData(Math.round(s * 0.5), Math.round(s * 0.5), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  const before = await px();
  await page.evaluate(() => { flipPerspective(); render(); });
  await page.waitForTimeout(250);
  const after = await px();
  ok('a1 corner holds a dark piece to begin with', before[0] < 90, JSON.stringify(before));
  ok('and a light one once flipped', after[0] > 180, JSON.stringify(after));
  ok('boardViewFlipped agrees', await page.evaluate(() => boardViewFlipped()) === true);
  await page.evaluate(() => { flipPerspective(); render(); });
  await page.waitForTimeout(250);
  ok('flipping back restores it', JSON.stringify(await px()) === JSON.stringify(before));
  ok('nothing reads boardFlipped behind the helper’s back',
    await page.evaluate(() => /boardViewFlipped/.test(sqCanvas.toString()) &&
                              /boardViewFlipped/.test(sqXY.toString())));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n14   The Expert board');
for (const [w, h, label] of [[412, 915, 'phone'], [1440, 900, 'desktop']]) {
  const { ctx, page, errs } = await open(w, h, w < 761, null, 'pro');
  await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
  await page.waitForTimeout(2200);

  const g = await page.evaluate(() => {
    const r = i => { const e = document.getElementById(i); return e ? e.getBoundingClientRect() : null; };
    return {
      proMode,
      topH: Math.round(r('proPlayerTop').height),
      botH: Math.round(r('proPlayerBottom').height),
      chipTop: r('proChipMount') ? Math.round(r('proChipMount').getBoundingClientRect ? 0 : 0) : null,
      chipY: r('proChipMount') ? Math.round(r('proChipMount').top) : null,
      ownClockY: Math.round(r('proPlayerBottom').top),
      gearGone: !document.getElementById('proGearMenu'),
      steps: (startTour(), _tourSteps.map(s => s.title)),
    };
  });
  ok(label + ': the two clock rows are the same height', g.topH === g.botH, g.topH + ' vs ' + g.botH);
  ok(label + ': and neither is a tall slab', g.topH <= 56, g.topH + 'px');
  ok(label + ': the commit chip sits below your own row', g.chipY >= g.ownClockY,
    'chip@' + g.chipY + ' row@' + g.ownClockY);
  ok(label + ': the redundant gear menu is gone', g.gearGone);
  ok(label + ': the tour has all four steps', g.steps.length === 4, JSON.stringify(g.steps));

  // Clicking away ends it. "Away" has to be computed: the panel is full-width
  // on a phone and moves per step, so a fixed point is sometimes on it — which
  // is the reason the tour also carries a ✕ now.
  const away = await page.evaluate(() => {
    const p = document.getElementById('tourPanel').getBoundingClientRect();
    // Somewhere vertically clear of the panel, inside the viewport.
    const y = p.top > 120 ? Math.round(p.top / 2) : Math.round((p.bottom + innerHeight) / 2);
    return { x: Math.round(innerWidth / 2), y: Math.min(Math.max(y, 8), innerHeight - 8) };
  });
  await page.mouse.click(away.x, away.y);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    active: _tourActive,
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
    ring: getComputedStyle(document.getElementById('tourRing')).display,
    back: document.getElementById('tourBackdrop')
      ? getComputedStyle(document.getElementById('tourBackdrop')).display : 'none',
  }));
  ok(label + ': clicking away ends the tour', after.active === false);
  ok(label + ': and clears everything it put up',
    after.overlay === 'none' && after.ring === 'none' && after.back === 'none',
    JSON.stringify(after));

  // And the ✕ always works, wherever the panel happens to be sitting.
  await page.evaluate(() => startTour());
  await page.waitForTimeout(250);
  await page.click('#tourPanel .tour-x');
  await page.waitForTimeout(300);
  ok(label + ': the ✕ closes it too',
    await page.evaluate(() => _tourActive === false &&
      getComputedStyle(document.getElementById('tourOverlay')).display === 'none'));

  // Settings: the same panel, minus what the Expert board cannot use.
  await page.evaluate(() => openPanel('boardSettingsPanel'));
  await page.waitForTimeout(350);
  const st = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#boardSettingsPanel .bs-row')]
      .map(b => b.querySelector('.bs-row-k').textContent.trim()),
    checks: [...document.querySelectorAll('#boardSettingsPanel .s-row')]
      .filter(r => getComputedStyle(r).display !== 'none')
      .map(r => r.querySelector('.s-lbl').textContent.trim().replace(/\?$/, '')),
    ghost: getComputedStyle(document.querySelector('#boardSettingsPanel .bs-group.bs-vision')).display,
    board: document.getElementById('bsBoardVal').textContent,
  }));
  ok(label + ': sound and legal moves are reachable at last',
    st.checks.includes('🔊 Move sounds:') && st.checks.includes('Show legal moves:'),
    JSON.stringify(st.checks));
  ok(label + ': ghost replies are not offered here', st.ghost === 'none', st.ghost);
  ok(label + ': nor the two threat-counting rules',
    !st.checks.some(c => /Batteries|queen pins/i.test(c)), JSON.stringify(st.checks));
  ok(label + ': nor the influence overlay, which draws nothing here',
    !st.checks.some(c => /influence/i.test(c)), JSON.stringify(st.checks));
  ok(label + ': Appearance names the board, pieces and theme',
    st.rows.slice(0, 3).join('|') === 'Board|Piece style|Board & background', JSON.stringify(st.rows));
  ok(label + ': and it says which board you are on', /Expert Board/.test(st.board), st.board);
  ok(label + ': the tour has a home here now', st.rows.some(r => /tour/i.test(r)), JSON.stringify(st.rows));
  ok(label + ': no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n15   Desktop is untouched');
for (const [w, h] of [[1440, 900], [1366, 600]]) {
  const { ctx, page, errs } = await open(w, h, false);
  const d = await page.evaluate(() => {
    const cs = s => getComputedStyle(document.querySelector(s));
    return {
      sidebar: cs('#sidebar').position,
      grid: cs('.ind-grid').display,
      cols: cs('.ind-grid').gridTemplateColumns.split(' ').length,
      settings: cs('#board-settings').display,
      strip: cs('#pinStrip').display,
      bar: cs('#phoneBar').display,
      utils: cs('.ind-utils').display,
      keyHold: cs('.key-hold').display,
      pinned: pinnedInds.length,
      // The IND defaults still apply on desktop: pinLoad() must not have
      // switched twelve overlays off behind the sidebar's back.
      exploring: Object.keys(IND).filter(k => IND[k].pre).length,
      hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  ok(w + ': the sidebar is still a column', d.sidebar === 'static', d.sidebar);
  ok(w + ': the overlay grid is still there, two up', d.grid === 'grid' && d.cols === 2, d.grid + '/' + d.cols);
  ok(w + ': board-settings is still display:contents', d.settings === 'contents', d.settings);
  ok(w + ': Clear / Hide / Peek / Show all stay in the column', d.utils !== 'none', d.utils);
  ok(w + ': the phone furniture stays hidden', d.strip === 'none' && d.bar === 'none');
  ok(w + ': hold-to-peek is still promised', d.keyHold !== 'none', d.keyHold);
  ok(w + ': pinning does not reach desktop', d.pinned === 0, String(d.pinned));
  ok(w + ': the IND defaults are untouched', d.exploring >= 10, String(d.exploring));
  ok(w + ': no horizontal scroll', !d.hScroll);
  ok(w + ': no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

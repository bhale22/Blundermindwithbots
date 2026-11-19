// Opening stages: Repertoire and Main Line are separate switches, run in that
// order, and the engine's own Lichess book no longer depends on either.
// Needs the server on :3100 (PORT=3100 node server.js). From the repo root:
//   node scripts/verify-opening-stages.mjs
//
// They used to be one-of-three per colour (Off / Main Line / Repertoire), so a
// bot could play the Italian or follow the Main Line, never the Italian and
// then the Main Line. This plays real games through botMakeMove, configured by
// the builder's own getBotConfig(), with the explorer answered by a small fake
// book: the Lichess token is not available locally, and a fake book is the only
// way to know which move the Main Line should play.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

// Main Line book, keyed by the moves played (the `play=` the explorer is asked
// with). Its first move is the "most popular". 1.d4 and 4.c3 are picked so that
// a Main Line move can never be mistaken for the repertoire's.
const BOOK = {
  '':                                         ['d2d4', 'e2e4'],
  'e2e4,c7c5':                                ['b1c3', 'g1f3'],
  'e2e4,e7e5,g1f3,b8c6,f1c4,f8c5':            ['c2c3', 'e1g1', 'd2d3'],
  'e2e4,e7e5,g1f3,b8c6,f1c4,f8c5,c2c3,g8f6':  ['d2d4', 'd2d3'],
};
// The engine's book is asked by FEN. Only the start position is in it.
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENGINE_BOOK = { [START_FEN]: ['g2g3'] };

const answer = list => ({
  opening: { eco: 'A00', name: 'Fake book' },
  moves: (list || []).map((uci, i) => ({ uci, san: uci, white: 1000 - i * 100, draws: 0, black: 0 })),
});
const asked = { play: [], fen: [] };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
});
await ctx.route(/\/api\/(masters|lichess)\?/, route => {
  const u = new URL(route.request().url());
  // As server.js does. Answering this anyway is how a Main Line bot playing White
  // lost its Main Line on move 1 with every check here passing.
  if (!u.searchParams.get('fen') && !u.searchParams.get('play')) {
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"need fen or play"}' });
  }
  let body;
  if (u.searchParams.has('play')) {
    const play = u.searchParams.get('play') || '';
    asked.play.push(play);
    body = answer(BOOK[play]);
  } else {
    const fen = u.searchParams.get('fen') || '';
    asked.fen.push(fen);
    body = answer(ENGINE_BOOK[fen]);
  }
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

const errs = [];
const panel = await ctx.newPage();
panel.on('pageerror', e => errs.push('panel: ' + e.message));
await panel.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await panel.waitForTimeout(600);

const app = await ctx.newPage();
app.on('pageerror', e => errs.push('app: ' + e.message));
app.on('dialog', d => d.accept());
await app.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await app.waitForTimeout(1600);
await app.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

// Build a config in the builder, the way a user would leave it.
// stages: { rep, ml } for White; book: the engine's Lichess book.
const buildConfig = (o) => panel.evaluate((o) => {
  const card = document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]');
  if (card) selEngineMode(card);
  setEngineBook(o.book ? 'on' : 'off');
  repSlots.white.length = 0; repSlots.black.length = 0;
  if (o.italian) addRepFromSearch('C50', 'Italian Game', 'white');
  // "No opening sequence" at o.nonePct of White's games, the Italian the rest.
  if (o.nonePct != null) {
    repAddNone(null, 'white');
    repSlots.white.forEach(s => { s.pct = s.none ? o.nonePct : 100 - o.nonePct; });
    renderRepSlots('white');
  }
  setOpStage('white', 'rep', !!o.rep);
  setOpStage('white', 'ml', !!o.ml);
  setOpStage('black', 'rep', false);
  setOpStage('black', 'ml', false);
  const cfg = getBotConfig();
  cfg.color = 'black';          // the HUMAN's colour: the bot plays White
  cfg.tcTime = 0; cfg.tcInc = 0; // untimed
  return cfg;
}, o);

// Start a game with that config, then play the human's moves; after each bot
// move record [uci, source].
async function play(cfg, humanMoves) {
  asked.play.length = 0; asked.fen.length = 0;
  await app.evaluate((cfg) => { window.postMessage(cfg, location.origin); }, cfg);
  const log = [];
  for (let i = 0; i <= humanMoves.length; i++) {
    const n = i * 2 + 1;   // plies on the board once the bot has made move i+1
    await app.waitForFunction((n) => botMoveHistory.length >= n && !botThinking, n, { timeout: 45000 })
      .catch(() => {});
    const r = await app.evaluate(() => ({
      uci: botMoveHistory[botMoveHistory.length - 1], src: lastBotMoveSource, plies: botMoveHistory.length,
    }));
    if (r.plies < n) { log.push(['(no move)', '']); break; }
    log.push([r.uci, r.src]);
    if (i === humanMoves.length) break;
    await app.evaluate((u) => {
      const mv = uciToSq(u);
      executeMove(mv.from, mv.to, null);
    }, humanMoves[i]);
  }
  return log;
}
const fmt = log => log.map(([u, s]) => u + '(' + s + ')').join(' ');

console.log('\n1   Repertoire (Italian) then Main Line');
{
  const cfg = await buildConfig({ italian: true, rep: true, ml: true });
  ok('the builder emits both stages for White',
    cfg.openingRepWhite === true && cfg.openingMainLineWhite === true && cfg.openingRepBlack === false,
    JSON.stringify([cfg.openingRepWhite, cfg.openingMainLineWhite, cfg.openingRepBlack]));
  const log = await play(cfg, ['e7e5', 'b8c6', 'f8c5', 'g8f6', 'e5d4']);
  console.log('      ' + fmt(log));
  ok('1.e4 2.Nf3 3.Bc4 come from the repertoire, not the book\'s 1.d4',
    log.slice(0, 3).map(x => x.join(':')).join(' ') === 'e2e4:ECO g1f3:ECO f1c4:ECO', fmt(log.slice(0, 3)));
  ok('the Italian on the board, the Main Line takes over: 4.c3 from the book',
    log[3] && log[3][0] === 'c2c3' && log[3][1] === 'Book', fmt(log.slice(3, 4)));
  ok('and stays on it: 5.d4', log[4] && log[4][0] === 'd2d4' && log[4][1] === 'Book', fmt(log.slice(4, 5)));
  ok('out of book, the engine plays', log[5] && log[5][1] !== 'Book' && log[5][1] !== 'ECO' && log[5][0] !== '(no move)',
    fmt(log.slice(5)));
}

console.log('\n2   Repertoire alone plays its ticked line, then hands to the engine');
{
  const cfg = await buildConfig({ italian: true, rep: true, ml: false });
  const log = await play(cfg, ['e7e5', 'b8c6', 'f8c5']);
  console.log('      ' + fmt(log));
  ok('moves 1-3 from the repertoire', log.slice(0, 3).every(x => x[1] === 'ECO'), fmt(log.slice(0, 3)));
  // Nov 2026: the ticked line is "Italian Game" (3.Bc4). It used to wander on
  // through every C50 line with equal odds (4.Bxf7+, the Jerome Gambit, one
  // game in five); now the line ends and the engine plays move 4.
  ok('move 4 from the engine: the ticked line ended at 3.Bc4', log[3] && log[3][1] !== 'ECO' && log[3][0] !== '(no move)',
    fmt(log.slice(3)));
  ok('the Main Line book was never asked', asked.play.length === 0, asked.play.join(' | '));
}

console.log('\n3   Main Line alone');
{
  const cfg = await buildConfig({ italian: true, rep: false, ml: true });
  const log = await play(cfg, []);
  console.log('      ' + fmt(log));
  ok('a repertoire left switched off is ignored: 1.d4 from the book',
    log[0] && log[0][0] === 'd2d4' && log[0][1] === 'Book', fmt(log));
}

console.log('\n4   Opponent leaves the repertoire: the Main Line picks it up');
{
  const cfg = await buildConfig({ italian: true, rep: true, ml: true });
  const log = await play(cfg, ['c7c5']);
  console.log('      ' + fmt(log));
  ok('1.e4 from the repertoire', log[0] && log[0][0] === 'e2e4' && log[0][1] === 'ECO', fmt(log.slice(0, 1)));
  ok('1...c5 is no Italian; 2.Nc3 from the book', log[1] && log[1][0] === 'b1c3' && log[1][1] === 'Book',
    fmt(log.slice(1)));
}

console.log('\n5   The engine\'s Lichess book works with Opening Behavior off');
{
  const cfg = await buildConfig({ rep: false, ml: false, book: true });
  ok('builder: Flounder + book, both opening stages off',
    cfg.engine === 'lcsf' && !cfg.openingRepWhite && !cfg.openingMainLineWhite, cfg.engine);
  const log = await play(cfg, []);
  console.log('      ' + fmt(log));
  ok('1.g3 from the engine\'s book (it was never asked before)',
    log[0] && log[0][0] === 'g2g3' && log[0][1] === 'LC Explorer', fmt(log) + ' fen asks: ' + asked.fen.length);
}

console.log('\n6   Old bots load as they played');
{
  const r = await panel.evaluate(() => {
    const base = getBotConfig();
    const old = Object.assign({}, base, { openingModeWhite: 'mainline', openingModeBlack: 'repertoire' });
    ['openingRepWhite', 'openingRepBlack', 'openingMainLineWhite', 'openingMainLineBlack'].forEach(k => delete old[k]);
    applyBotConfig(old);
    const a = { repW: repOn.white, mlW: mainLine.white, repB: repOn.black, mlB: mainLine.black,
                st: document.getElementById('st-opening').textContent };
    const older = Object.assign({}, base, { openingMode: 'mainline' });
    ['openingRepWhite', 'openingRepBlack', 'openingMainLineWhite', 'openingMainLineBlack',
     'openingModeWhite', 'openingModeBlack'].forEach(k => delete older[k]);
    applyBotConfig(older);
    a.olderW = mainLine.white && !repOn.white; a.olderB = mainLine.black && !repOn.black;
    return a;
  });
  ok('builder: per-colour modes map to one stage each',
    r.mlW && !r.repW && r.repB && !r.mlB, JSON.stringify(r));
  ok('builder: status reads them back', r.st === 'W: Main Line · B: Repertoire', r.st);
  ok('builder: a single global openingMode applies to both colours', r.olderW && r.olderB, JSON.stringify(r));

  const s = await app.evaluate(() => {
    const cfg = Object.assign({}, window._lastAppliedBotConfig,
      { type: 'botConfig', _applyOnly: true, openingModeWhite: 'mainline', openingModeBlack: 'repertoire' });
    ['openingRepWhite', 'openingRepBlack', 'openingMainLineWhite', 'openingMainLineBlack'].forEach(k => delete cfg[k]);
    return new Promise(res => {
      window.postMessage(cfg, location.origin);
      setTimeout(() => res({ ...botOpeningConfig, white: undefined, black: undefined }), 300);
    });
  });
  ok('app: an old config maps to the same stages',
    s.mainLineWhite === true && s.repWhite === false && s.repBlack === true && s.mainLineBlack === false,
    JSON.stringify(s));

  const t = await app.evaluate(() => {
    botApplyConfig({ opening: { mode: 'mainline', config: { modeWhite: 'repertoire', modeBlack: 'mainline' } } });
    return { repW: botOpeningConfig.repWhite, mlW: botOpeningConfig.mainLineWhite,
             repB: botOpeningConfig.repBlack, mlB: botOpeningConfig.mainLineBlack,
             stale: 'modeWhite' in botOpeningConfig };
  });
  ok('app: an old saved session restores to the same stages',
    t.repW && !t.mlW && !t.repB && t.mlB && !t.stale, JSON.stringify(t));
}

console.log('\n7   No opening sequence');
{
  // Nov 18 2026 (Ben): one line under the search, always there. 100% with no
  // opening ticked, 0% once the first one is; no longer picked from the List.
  const b = await panel.evaluate(() => {
    repSlots.white.length = 0; repSlots.black.length = 0;
    setOpStage('white', 'rep', false);
    renderRepSlots('white');
    const line = () => document.getElementById('rep-none-line-white');
    const box = () => line().querySelector('input');
    const out = { emptyTxt: line().textContent, emptyVal: box().value, emptyRo: box().readOnly,
                  emptyLock: !!line().querySelector('.rep-lock'),
                  emptyCfg: JSON.stringify(getBotConfig().repSlots.white) };
    repBrowse(null, 'white', true);
    out.inList = !!document.querySelector('#rep-dropdown-white .eco-none') ||
                 /No opening sequence/.test(document.getElementById('rep-dropdown-white').textContent);
    onRepSearch('none', 'white');
    out.inSearch = /No opening sequence/.test(document.getElementById('rep-dropdown-white').textContent);
    repCloseResults(null, 'white');
    addRepFromSearch('C50', 'Italian Game', 'white');
    out.afterTick = JSON.stringify(repSlots.white.map(s => [!!s.none, s.pct]));
    out.afterVal = box().value;
    out.repOn = repOn.white;
    out.lockNow = !!line().querySelector('.rep-lock');
    const ni = repSlots.white.findIndex(s => s.none);
    box().value = '30';
    onRepPctChange(ni, 30, 'white');
    out.typed = JSON.stringify(repSlots.white.map(s => [!!s.none, s.pct]));
    out.italianBox = document.querySelector('#rep-slots-list-white input[aria-label="Share for Italian Game"]').value;
    const cfg = getBotConfig();
    out.cfg = cfg;
    applyBotConfig(Object.assign({}, cfg, { repSlots: { white: [], black: [] } }));
    out.cleared = JSON.stringify(repSlots.white.map(s => [!!s.none, s.pct]));
    applyBotConfig(cfg);
    out.reloaded = JSON.stringify(repSlots.white.map(s => [!!s.none, s.pct]));
    return out;
  });
  ok('builder: with no opening ticked the line reads 100%, fixed, with no lock',
    /No opening sequence/.test(b.emptyTxt) && b.emptyVal === '100' && b.emptyRo && !b.emptyLock, JSON.stringify(b));
  ok('builder: and nothing is saved for it, so the Main Line still plays', b.emptyCfg === '[]', b.emptyCfg);
  ok('builder: it is no longer offered in the List or the search', !b.inList && !b.inSearch);
  ok('builder: the first opening takes 100%, the line goes to 0%, the repertoire switches on',
    b.afterTick === '[[true,0],[false,100]]' && b.afterVal === '0' && b.repOn && b.lockNow, b.afterTick);
  ok('builder: typing 30% in the line leaves the Italian 70%',
    b.typed === '[[true,30],[false,70]]' && b.italianBox === '70', b.typed + ' box ' + b.italianBox);
  ok('builder: a bot with no openings loads at 100%', b.cleared === '[[true,100]]', b.cleared);
  ok('builder: saved and loaded with the bot', b.reloaded === '[[true,30],[false,70]]', b.reloaded);

  // A locked share stays put while the others change (a tester, Nov 18 2026).
  const L = await panel.evaluate(() => {
    repSlots.white.length = 0;
    const tick = p => { const r = ECO_DATA.find(x => x.path === p); repToggleRow(null, 'white', r.i, true); };
    const st = () => JSON.stringify(repSlots.white.map(s => [s.none ? 'none' : s.fam, s.pct, !!s.locked]));
    const idx = f => repSlots.white.findIndex(s => (f ? s.fam === f : s.none));
    const out = {};
    tick('e4 e5 Nf3 Nc6 Bc4');
    onRepPctChange(idx('Italian Game'), 50, 'white');
    repToggleLock('white', idx('Italian Game'));
    out.lockedBox = document.querySelector('#rep-slots-list-white input[aria-label="Share for Italian Game"]').readOnly;
    tick('e4 e5 Nf3 Nc6 Bb5');
    out.ruy = st();
    tick('e4 e5 Nf3 Nc6 d4');
    out.scotch = st();
    onRepPctChange(idx('Ruy Lopez'), 40, 'white');
    out.ruy40 = st();
    onRepPctChange(idx('Scotch Game'), 70, 'white');
    out.capped = st();
    onRepPctChange(idx('Italian Game'), 10, 'white');
    out.ignored = st();
    removeRepSlot(idx('Scotch Game'), 'white');
    out.removed = st();
    const cfg = getBotConfig();
    out.cfgLock = JSON.stringify(cfg.repSlots.white.map(s => [s.fam || 'none', !!s.locked]));
    applyBotConfig(Object.assign({}, cfg, { repSlots: { white: [], black: [] } }));
    applyBotConfig(cfg);
    out.reloaded = st();
    return out;
  });
  ok('lock: the locked box cannot be typed in', L.lockedBox === true);
  ok('lock: the Ruy joins with the 50% the locked Italian leaves',
    L.ruy === '[["none",0,false],["Italian Game",50,true],["Ruy Lopez",50,false]]', L.ruy);
  ok('lock: the Scotch shares it with the Ruy, the Italian stays 50%',
    L.scotch === '[["none",0,false],["Italian Game",50,true],["Ruy Lopez",25,false],["Scotch Game",25,false]]', L.scotch);
  ok('lock: Ruy 40% takes from the Scotch, not the Italian',
    L.ruy40 === '[["none",0,false],["Italian Game",50,true],["Ruy Lopez",40,false],["Scotch Game",10,false]]', L.ruy40);
  ok('lock: 70% in the Scotch is held to the 50% the lock leaves',
    L.capped === '[["none",0,false],["Italian Game",50,true],["Ruy Lopez",0,false],["Scotch Game",50,false]]', L.capped);
  ok('lock: a locked share ignores a typed value', L.ignored === L.capped, L.ignored);
  ok('lock: removing the Scotch hands its share to the unlocked Ruy',
    L.removed === '[["none",0,false],["Italian Game",50,true],["Ruy Lopez",50,false]]', L.removed);
  ok('lock: saved with the bot, and loaded locked',
    L.cfgLock === '[["Italian Game",true],["Ruy Lopez",false]]' && L.reloaded === L.removed, L.cfgLock + ' ' + L.reloaded);

  const a = await app.evaluate((cfg) => new Promise(res => {
    window.postMessage(Object.assign({}, cfg, { type: 'botConfig', _applyOnly: true }), location.origin);
    setTimeout(() => {
      let skipped = 0; const N = 4000;
      for (let i = 0; i < N; i++) if (botOpeningSkipsThisGame('White')) skipped++;
      res({ share: botOpeningConfig.noneWhite, slots: botOpeningConfig.white.map(s => s.name), skipped: skipped / N });
    }, 300);
  }), b.cfg);
  ok('app: it is a share of games, not a line: 30%, and only the Italian left to steer into',
    Math.abs(a.share - 0.3) < 1e-9 && JSON.stringify(a.slots) === '["Italian Game"]', JSON.stringify(a));
  ok('app: rolled once a game, it comes up in about 30% of them (' + Math.round(a.skipped * 100) + '%)',
    Math.abs(a.skipped - 0.3) < 0.03, a.skipped);

  const cfg100 = await buildConfig({ italian: true, nonePct: 100, rep: true, ml: true });
  const log = await play(cfg100, ['e7e5']);
  console.log('      ' + fmt(log));
  ok('100%: the bot plays its own moves from move 1, neither the repertoire nor the Main Line',
    log.length >= 2 && log.every(x => x[1] !== 'ECO' && x[1] !== 'Book' && x[0] !== '(no move)') && asked.play.length === 0,
    fmt(log) + ' play asks: ' + asked.play.length);
  const noneNow = await app.evaluate(() => botNoOpeningThisGame);
  ok('and the app says this game has no opening sequence', noneNow === true);

  const cfg0 = await buildConfig({ italian: true, nonePct: 0, rep: true, ml: true });
  const log0 = await play(cfg0, []);
  console.log('      ' + fmt(log0));
  ok('0%: the slot sits there and the repertoire plays every game: 1.e4 from it',
    log0[0] && log0[0][0] === 'e2e4' && log0[0][1] === 'ECO', fmt(log0));
}

console.log('\n8   Ticked lines (Nov 2026): follow them, step back in one move away, at the opening\'s share');
{
  // White: three Italian lines (4.c3 75 / 4.b4 25 where they part) and the Réti.
  const ticked = (o) => panel.evaluate((o) => {
    const card = document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]');
    if (card) selEngineMode(card);
    setEngineBook('off');
    repSlots.white.length = 0; repSlots.black.length = 0;
    const tick = p => { const r = ECO_DATA.find(x => x.path === p); repToggleRow(null, 'white', r.i, true); };
    ['e4 e5 Nf3 Nc6 Bc4 Bc5 c3', 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4', 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3', 'Nf3 d5 c4'].forEach(tick);
    const it = repSlots.white.find(s => s.fam === 'Italian Game'), re = repSlots.white.find(s => s.fam === 'Réti Opening');
    it.pct = o.italian; re.pct = o.reti;
    it.fork['e4 e5 Nf3 Nc6 Bc4 Bc5'] = { c3: 75, b4: 25 };
    renderRepSlots('white');
    setOpStage('white', 'rep', true);
    setOpStage('white', 'ml', !!o.ml);
    setOpStage('black', 'rep', false);
    setOpStage('black', 'ml', false);
    const cfg = getBotConfig();
    cfg.color = 'black'; cfg.tcTime = 0; cfg.tcInc = 0;
    return cfg;
  }, o);
  // Fix the app's dice for one game: every draw returns r.
  const dice = r => app.evaluate((r) => { window.__realRandom = window.__realRandom || Math.random; Math.random = () => r; }, r);
  const undice = () => app.evaluate(() => { if (window.__realRandom) Math.random = window.__realRandom; });

  let cfg = await ticked({ italian: 65, reti: 35, ml: true });
  ok('builder: the config carries the ticked lines and the split',
    cfg.repSlots.white.length === 2 && cfg.repSlots.white[0].lines.length === 3 &&
    JSON.stringify(cfg.repSlots.white[0].fork['e4 e5 Nf3 Nc6 Bc4 Bc5']) === '{"c3":75,"b4":25}',
    JSON.stringify(cfg.repSlots.white.map(s => [s.fam, s.pct, s.lines.length])));

  await dice(0.01);
  let log = await play(cfg, ['d7d5']);
  console.log('      ' + fmt(log));
  ok('the Tennison case: 1.e4 from the Italian, and after 1...d5 the Réti does not play 2.Nf3',
    log[0] && log[0][0] === 'e2e4' && log[0][1] === 'ECO' && log[1] && log[1][1] !== 'ECO' && log[1][0] !== '(no move)',
    fmt(log));

  log = await play(cfg, ['e7e5', 'b8c6', 'f8c5']);
  console.log('      ' + fmt(log));
  ok('the 4th-move split: 4.c3 on a low draw (75%), from the repertoire',
    log[3] && log[3][0] === 'c2c3' && log[3][1] === 'ECO', fmt(log.slice(3)));
  // The Réti at 0% so a high draw still opens 1.e4 and reaches the split.
  cfg = await ticked({ italian: 100, reti: 0, ml: true });
  await dice(0.99);
  log = await play(cfg, ['e7e5', 'b8c6', 'f8c5']);
  console.log('      ' + fmt(log));
  ok('and 4.b4 on a high one (25%), never an unticked Italian line',
    log[0] && log[0][0] === 'e2e4' && log[3] && log[3][0] === 'b2b4' && log[3][1] === 'ECO', fmt(log));

  // 1.Nf3 e5: 2.e4 reaches the Italian in one move. Its share is the chance.
  cfg = await ticked({ italian: 100, reti: 1, ml: false });
  await dice(0.999);   // picks the 1% Réti, then rolls 99 against the Italian's 100%
  log = await play(cfg, ['e7e5']);
  console.log('      ' + fmt(log));
  const detail = await app.evaluate(() => lastBotMoveDetail);
  ok('one move away: 1.Nf3 e5 2.e4, stepping back into the Italian (not 2.Nxe5)',
    log[0] && log[0][0] === 'g1f3' && log[1] && log[1][0] === 'e2e4' && log[1][1] === 'ECO' && /stepped back in/.test(detail),
    fmt(log) + ' · ' + detail);
  cfg = await ticked({ italian: 50, reti: 50, ml: false });
  await dice(0.99);    // the Réti, then a roll of 99 against the Italian's 50%: it stays out
  log = await play(cfg, ['e7e5']);
  console.log('      ' + fmt(log));
  ok('a roll that misses: the engine plays move 2, not the repertoire',
    log[0] && log[0][0] === 'g1f3' && log[1] && log[1][1] !== 'ECO' && log[1][0] !== '(no move)', fmt(log));
  await undice();
}

ok('no page errors', errs.length === 0, errs.join(' | '));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

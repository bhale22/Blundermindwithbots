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

console.log('\n2   Repertoire alone is unchanged');
{
  const cfg = await buildConfig({ italian: true, rep: true, ml: false });
  const log = await play(cfg, ['e7e5', 'b8c6', 'f8c5']);
  console.log('      ' + fmt(log));
  ok('moves 1-3 from the repertoire', log.slice(0, 3).every(x => x[1] === 'ECO'), fmt(log.slice(0, 3)));
  ok('move 4 still follows the C50 lines (no Main Line to hand to)', log[3] && log[3][1] === 'ECO', fmt(log.slice(3)));
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

ok('no page errors', errs.length === 0, errs.join(' | '));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

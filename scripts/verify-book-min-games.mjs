// How long does a bot stay in book, and is the book asked about the right position?
//
// Min games: a position with fewer games than the builder's setting is out of book
// for the rest of the game, for the engine's book and the Main Line alike. Before it
// a book lasted down to one game, which leaves a personality one move to choose from.
//
// The start of the game: the Main Line asked the explorer with `play` alone. At the
// start of a game that is empty and the proxy answers 400, so a bot playing White
// lost its Main Line before move 1. In a game begun with "Play from here" the moves
// were read from the standard position. The fake explorer here refuses what the real
// proxy refuses. A kinder one is how the bug stayed hidden: it answered the empty
// request, so the tests passed.
//
// No network, Lichess token or Maia download needed.
// Needs the dev server on :3100 (or BM_URL). PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const MIDGAME = 'rnb1k2r/pp2bpp1/7p/2pB4/4P3/2N2N2/PPP2PPP/R3K2R b KQkq - 0 11';
const MIDGAME_SANS = 'e4 e5 Nc3 d6 Bc4 c6 Nf3 h6 d4 exd4 Qxd4 c5 Qd5 Qe7 Bf4 Nf6 Bxd6 Nxd5 Bxe7 Bxe7 Bxd5'.split(' ');

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const mv = (uci, games) => ({ uci, san: uci, white: games, draws: 0, black: 0, game: null, opening: null });

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
});

// `book({ db, fen, play })` answers the explorer: an array of moves, or null for none.
let book = () => null;
let asked = [];
await ctx.route(/\/api\/(lichess|masters)\?/, route => {
  const u = new URL(route.request().url());
  const q = { db: u.pathname.endsWith('masters') ? 'masters' : 'lichess',
              fen: u.searchParams.get('fen') || '', play: u.searchParams.get('play') || '' };
  asked.push(q);
  // As server.js does (the /api/masters and /api/lichess routes).
  if (!q.fen && !q.play) {
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"need fen or play"}' });
  }
  route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ opening: { eco: 'A00', name: 'Fake book' }, moves: book(q) || [] }) });
});

const errs = [];
const app = await ctx.newPage();
app.on('pageerror', e => errs.push('app: ' + e.message));
app.on('dialog', d => d.accept());
await app.goto(BASE, { waitUntil: 'domcontentloaded' });
await app.waitForTimeout(1600);
await app.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

const CFG = {
  type: 'botConfig', engine: 'lcsf', elo: 1500, lcsfElo: 1500, lcMaiaLcElo: 1500, lcMaiaMaiaElo: 1500,
  openingBook: true, cpBudget: 160, hardFloorCp: 160, convictionPct: 0, blindConviction: false,
  tcTime: 0, timingMode: 'instant', premoveEnabled: false,
  attractorValues: {}, pieceValues: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0, king: 0 },
  openingRepWhite: false, openingRepBlack: false, openingMainLineWhite: false, openingMainLineBlack: false,
  repSlots: { white: [], black: [] }, customControls: [],
};
// A Main Line bot with no book of its own, so the Main Line is all that asks.
const MAIN_LINE = { engine: 'stockfish', openingBook: false, openingSource: 'masters', openingDepth: 20 };

async function start(cfg, fen, sans) {
  asked = [];
  await app.evaluate(({ cfg, fen, sans }) => {
    botStop();
    botApplyPanelConfig(cfg, true);
    if (fen) window._pendingStartPos = { fen, sans: sans || [] };
    botStart();
  }, { cfg: { ...CFG, ...cfg }, fen, sans });
}
const state = () => app.evaluate(() => ({
  history: botMoveHistory.slice(), src: lastBotMoveSource, thinking: botThinking,
  mainLine: mainLineActive, explorer: lichessExplorerActive,
}));
// Wait until the bot has moved and `n` moves of this game are on record.
async function moved(n, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await app.waitForTimeout(100);
    const s = await state();
    if (s.history.length >= n && !s.thinking) return s;
  }
  return null;
}
const human = uci => app.evaluate(u => { const m = uciToSq(u); tryCommit(m.from, m.to, null); }, uci);

// ── The real proxy's rule ──────────────────────────────────────────────────
// What the fake explorer above assumes, checked against the real routes. Past the
// 400 they go upstream, so the answer depends on a token; only "refused" is tested.
console.log('the proxy:');
{
  const req = q => ctx.request.get(new URL(q, BASE).href).then(r => r.status());
  const start = encodeURIComponent(START);
  ok('refuses a request with no position', await req('api/masters?play=&moves=1') === 400
    && await req('api/lichess?play=&moves=1') === 400);
  ok('accepts the start position with no moves yet', await req('api/masters?fen=' + start + '&play=&moves=1') !== 400
    && await req('api/lichess?fen=' + start + '&play=&moves=1') !== 400);
}

// ── Main Line from the first move ──────────────────────────────────────────
console.log('Main Line as White:');
{
  const LINE = { '': 'd2d4', 'd2d4,g8f6': 'c2c4' };
  book = q => (LINE[q.play] ? [mv(LINE[q.play], 500)] : null);
  await start({ ...MAIN_LINE, color: 'black', openingMainLineWhite: true });
  let s = await moved(1);
  ok('plays the book\'s first move', s && s.history[0] === 'd2d4' && s.src === 'Book', JSON.stringify(s));
  ok('and the Main Line is still on', s && s.mainLine === true, JSON.stringify(s));
  ok('having asked about the start position', asked[0] && asked[0].fen === START && asked[0].play === '', JSON.stringify(asked[0]));
  await human('g8f6');
  s = await moved(3);
  ok('and it carries on: 2.c4', s && s.history[2] === 'c2c4' && s.src === 'Book', JSON.stringify(s));
}
console.log('Main Line as Black is unchanged:');
{
  book = q => (q.play === 'e2e4' ? [mv('c7c5', 500)] : null);
  await start({ ...MAIN_LINE, color: 'white', openingMainLineBlack: true });
  await human('e2e4');
  const s = await moved(2);
  ok('answers 1.e4 from the book', s && s.history[1] === 'c7c5' && s.src === 'Book', JSON.stringify(s));
}

// ── "Play from here" ───────────────────────────────────────────────────────
// 1.d4 is the standard position's book move and is also legal here, so a lookup
// from the wrong position would play it rather than fail.
console.log('Main Line from a chosen position:');
{
  book = q => {
    if (q.fen === START) return [mv('d2d4', 9000)];
    if (q.fen !== AFTER_E4_E5) return null;
    return q.play === '' ? [mv('g1f3', 500)] : q.play === 'g1f3,b8c6' ? [mv('f1c4', 500)] : null;
  };
  await start({ ...MAIN_LINE, color: 'black', openingMainLineWhite: true }, AFTER_E4_E5, ['e4', 'e5']);
  let s = await moved(1);
  ok('plays the book move for the position on the board', s && s.history[0] === 'g1f3' && s.src === 'Book', JSON.stringify(s));
  await human('b8c6');
  s = await moved(3);
  ok('and follows it from there', s && s.history[2] === 'f1c4' && s.src === 'Book', JSON.stringify(s));
  ok('every lookup named the starting position', asked.length > 0 && asked.every(q => q.fen === AFTER_E4_E5), JSON.stringify(asked));

  // The same moves (none yet) from two starting positions are different lookups.
  await start({ ...MAIN_LINE, color: 'black', openingMainLineWhite: true });
  s = await moved(1);
  ok('the next game, from the standard position, is not served that answer',
    s && s.history[0] === 'd2d4' && s.src === 'Book', JSON.stringify(s));
}

// ── Min games: the engine's book ───────────────────────────────────────────
console.log('Min games, the engine\'s book:');
for (const [name, moves, min, inBook] of [
  ['1 game, min 4: out', [1], 4, false],
  ['3 games, min 4: out', [3], 4, false],
  ['4 games, min 4: in', [4], 4, true],
  ['counted across the position: 2+1, min 4: out', [2, 1], 4, false],
  ['counted across the position: 2+2, min 4: in', [2, 2], 4, true],
  ['1 game, min 1: in', [1], 1, true],
  ['99 games, min 100: out', [99], 100, false],
  ['100 games, min 100: in', [100], 100, true],
]) {
  const ucis = ['a7a6', 'b8c6'];
  book = () => moves.map((g, i) => mv(ucis[i], g));
  await start({ color: 'white', openingMinGames: min }, MIDGAME, MIDGAME_SANS);
  const s = await moved(1);
  ok(name, s && (inBook ? s.src === 'LC Explorer' : s.src !== 'LC Explorer') && s.explorer === inBook, JSON.stringify(s));
}

console.log('every engine with a book, and a bot saved before the setting existed:');
for (const [name, cfg] of [
  ['LC+Flounder', { engine: 'lcsf' }],
  ['LC+Maia', { engine: 'lcmaia' }],
  ['Hybrid with book', { engine: 'hybrid', openingBook: true,
    hybridSlots: [{ type: 'sf', flounderElo: 1500, level: 5, pct: 100 }] }],
]) {
  for (const [games, inBook] of [[3, false], [4, true]]) {
    book = () => [mv('a7a6', games)];
    await start({ ...cfg, color: 'white' }, MIDGAME, MIDGAME_SANS);   // no openingMinGames: the default
    const s = await moved(1);
    ok(name + ', ' + games + ' games: ' + (inBook ? 'in' : 'out'),
      s && (inBook ? s.src === 'LC Explorer' : s.src !== 'LC Explorer'), JSON.stringify(s));
  }
}

console.log('out of book stays out:');
{
  book = () => [mv('a7a6', 3)];
  await start({ color: 'white' }, MIDGAME, MIDGAME_SANS);
  let s = await moved(1);
  ok('the bot leaves on the thin position', s && s.explorer === false, JSON.stringify(s));
  const n = asked.length;
  book = () => [mv('a7a6', 100000)];
  const reply = await app.evaluate(() => {
    const m = allLegalMoves(board, turn, epSq, castling)[0];
    return sqToUci(m.from, m.to, null);
  });
  await human(reply);
  s = await moved(3);
  ok('and does not ask again, even where the games are', s && asked.length === n, n + ' -> ' + asked.length);
}

// ── Min games: the Main Line ───────────────────────────────────────────────
console.log('Min games, the Main Line:');
{
  // The app's cache outlives a game, and each of these changes the book under it.
  const run = async (masters, lichess, cfg = {}, keepCache = false) => {
    book = q => (q.db === 'masters' ? (masters ? [mv('e2e4', masters)] : null) : (lichess ? [mv('d2d4', lichess)] : null));
    if (!keepCache) await app.evaluate(() => _openingCache.clear());
    await start({ ...MAIN_LINE, color: 'black', openingMainLineWhite: true, ...cfg });
    const s = await moved(1);
    return { s, dbs: asked.map(q => q.db) };
  };
  let r = await run(4, 5000);
  ok('Masters with enough games: plays it, Lichess not asked',
    r.s && r.s.history[0] === 'e2e4' && r.s.src === 'Book' && !r.dbs.includes('lichess'), JSON.stringify(r));
  r = await run(3, 5000);
  ok('Masters too thin: drops to the Lichess games',
    r.s && r.s.history[0] === 'd2d4' && r.s.src === 'Book', JSON.stringify(r));
  r = await run(3, 3);
  ok('both too thin: the Main Line ends and the engine plays',
    r.s && r.s.src !== 'Book' && r.s.mainLine === false, JSON.stringify(r));
  r = await run(1, 0, { openingMinGames: 1 });
  ok('min 1: one master game is still book',
    r.s && r.s.history[0] === 'e2e4' && r.s.src === 'Book', JSON.stringify(r));
  r = await run(0, 3, { openingSource: 'lichess' });
  ok('Lichess database too thin: ends, without asking Masters',
    r.s && r.s.src !== 'Book' && !r.dbs.includes('masters'), JSON.stringify(r));
  // The cache holds "off book" answers, so it has to know the setting they came from.
  r = await run(3, 3);
  ok('at min 4 the same position is off book', r.s && r.s.src !== 'Book', JSON.stringify(r));
  r = await run(3, 3, { openingMinGames: 3 }, true);
  ok('a new minimum is not served the old answer: the same position is book at 3',
    r.s && r.s.history[0] === 'e2e4' && r.s.src === 'Book', JSON.stringify(r));
}

// ── The builder ────────────────────────────────────────────────────────────
console.log('the builder:');
{
  const panel = await ctx.newPage();
  panel.on('pageerror', e => errs.push('panel: ' + e.message));
  await panel.goto(new URL('bot-control-panel.html', BASE).href, { waitUntil: 'networkidle' });
  await panel.waitForTimeout(600);

  const r = await panel.evaluate(() => {
    const out = {};
    const row = () => document.querySelector('#engine-book-row .book-min-input');
    const white = () => document.querySelector('#op-ml-white .book-min-input');
    const black = () => document.querySelector('#op-ml-black .book-min-input');
    const boxes = () => [row().value, white().value, black().value].join('/');
    const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const leave = el => el.dispatchEvent(new Event('change', { bubbles: true }));
    const emitted = () => getBotConfig().openingMinGames;

    out.default = { emitted: emitted(), boxes: boxes() };

    setEngineBook('off');
    out.hiddenOff = getComputedStyle(row().closest('.ob-elo')).display;
    setEngineBook('on');
    out.shownOn = getComputedStyle(row().closest('.ob-elo')).display;

    // "1" on the way to "12" is a value to keep, and must not be rewritten mid-edit.
    type(row(), '1');
    out.midEdit = { box: row().value, emitted: emitted() };
    type(row(), '12');
    out.typed = { emitted: emitted(), boxes: boxes() };
    leave(row());

    // The other direction, from a Main Line bar.
    type(white(), '30'); leave(white());
    out.fromBar = { emitted: emitted(), boxes: boxes() };

    // Clearing the box keeps the last good number.
    type(row(), ''); out.clearing = row().value; leave(row());
    out.cleared = { emitted: emitted(), boxes: boxes() };
    type(row(), '0'); leave(row());
    out.zero = { emitted: emitted(), boxes: boxes() };
    type(row(), '99999'); leave(row());
    out.huge = { emitted: emitted(), boxes: boxes() };

    // The depth boxes sit in the same bar and share a wrapper with these.
    type(row(), '7'); leave(row());
    setBookDepth(25);
    const depths = [...document.querySelectorAll('.ml-depth input:not(.book-min-input)')].map(i => i.value);
    out.depth = { boxes: boxes(), depths, emitted: emitted(), depth: getBotConfig().openingDepth };
    setBookDepth(20);

    // Redrawing the bars keeps it.
    setBookSource('lichess'); setBookSource('masters');
    out.redrawn = boxes();

    // Saved bots.
    const saved = getBotConfig();
    saved.openingMinGames = 10;
    applyBotConfig(saved);
    out.loaded = { emitted: emitted(), boxes: boxes() };
    delete saved.openingMinGames;
    applyBotConfig(saved);
    out.oldBot = { emitted: emitted(), boxes: boxes() };
    return out;
  });
  const j = JSON.stringify;
  ok('defaults to 4, shown in every box', r.default.emitted === 4 && r.default.boxes === '4/4/4', j(r.default));
  ok('the book row\'s box only shows with the book on', r.hiddenOff === 'none' && r.shownOn === 'flex', r.hiddenOff + ' ' + r.shownOn);
  ok('a number on its way is left in the box', r.midEdit.box === '1', j(r.midEdit));
  ok('typing updates the bot and the other boxes', r.typed.emitted === 12 && r.typed.boxes === '12/12/12', j(r.typed));
  ok('the Main Line\'s box is the same setting', r.fromBar.emitted === 30 && r.fromBar.boxes === '30/30/30', j(r.fromBar));
  ok('clearing the box lets you type', r.clearing === '', r.clearing);
  ok('leaving it empty keeps the last number', r.cleared.emitted === 30 && r.cleared.boxes === '30/30/30', j(r.cleared));
  ok('0 becomes 1', r.zero.emitted === 1 && r.zero.boxes === '1/1/1', j(r.zero));
  ok('too large becomes the maximum', r.huge.emitted === 10000 && r.huge.boxes === '10000/10000/10000', j(r.huge));
  ok('changing the book depth leaves it alone', r.depth.boxes === '7/7/7' && r.depth.emitted === 7, j(r.depth));
  ok('and it leaves the book depth alone', r.depth.depth === 25 && r.depth.depths.every(d => d === '25'), j(r.depth));
  ok('it survives a redraw of the Main Line bars', r.redrawn === '7/7/7', r.redrawn);
  ok('a saved bot restores its number', r.loaded.emitted === 10 && r.loaded.boxes === '10/10/10', j(r.loaded));
  ok('a bot saved before the setting existed gets 4', r.oldBot.emitted === 4 && r.oldBot.boxes === '4/4/4', j(r.oldBot));

  // All the way to the game, the way the builder sends it.
  const cfg = await panel.evaluate(() => { const c = getBotConfig(); c.openingMinGames = 9; return { ...c, _applyOnly: true }; });
  const reached = await app.evaluate(cfg => new Promise(res => {
    window.postMessage(cfg, location.origin);
    setTimeout(() => res(botOpeningConfig.minGames), 300);
  }), cfg);
  ok('the number reaches the game', reached === 9, String(reached));
  await panel.close();
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

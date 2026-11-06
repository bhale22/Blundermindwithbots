// Does a bot castle when its opening book says to?
//
// Reported from a real game: a Pawn Pusher bot on LC+Maia reached 11.Bxd5, the
// explorer's only move there was O-O, and the bot never moved again. The clock ran,
// the status was blank and nothing was logged.
//
// The explorer writes castling as king-takes-rook (uci "e8h8", san "O-O"). Nothing
// else in the app reads that form, and botMakeMove's legality check dropped the
// pick without a word. Not Pawn Pusher's fault, or Blind Conviction's: any bot with
// a book did this, on the first castling move the book chose.
//
// The explorer is mocked, with responses copied from the real thing, so this needs
// no network, no Lichess token and no Maia download.
//
// Needs the dev server on :3100 (or BM_URL). PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

const mv = (uci, san, games = 1) => ({ uci, san, white: games, draws: 0, black: 0, game: null, opening: null });

// `book(url)` answers explorer requests: an array of moves, or null for off book.
async function openPage(book) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route(/\/api\/(lichess|masters)/, route => {
    const moves = book(new URL(route.request().url())) || [];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ white: 1, draws: 0, black: 0, moves }) });
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  return { page, ctx, errs };
}

const BASE_CFG = {
  type: 'botConfig', engine: 'lcmaia', elo: 1325, lcMaiaLcElo: 1325, lcMaiaMaiaElo: 1325,
  openingBook: true, cpBudget: 160, hardFloorCp: 160, convictionPct: 0, blindConviction: false,
  tcTime: 0, timingMode: 'instant', premoveEnabled: false,
  attractorValues: {}, pieceValues: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0, king: 0 },
  openingRepWhite: false, openingRepBlack: false, openingMainLineWhite: false, openingMainLineBlack: false,
  repSlots: { white: [], black: [] }, customControls: [],
};

async function startFrom(page, cfg, fen, sans) {
  await page.evaluate(({ cfg, fen, sans }) => {
    botApplyPanelConfig(cfg, true);
    if (fen) window._pendingStartPos = { fen, sans };
    botStart();
  }, { cfg: { ...BASE_CFG, ...cfg }, fen, sans });
}

const state = page => page.evaluate(() => {
  const at = s => { const p = board[fileRankToSq(s)]; return p ? p.color + p.piece : null; };
  return {
    plies: gameMovesAlgebraic.length, last: gameMovesAlgebraic[gameMovesAlgebraic.length - 1],
    src: lastBotMoveSource, thinking: botThinking,
    squares: { e8: at('e8'), f8: at('f8'), g8: at('g8'), h8: at('h8'), c8: at('c8'), d8: at('d8'), a8: at('a8'),
               e1: at('e1'), f1: at('f1'), g1: at('g1'), h1: at('h1') },
  };
});

// Wait for the bot's reply; null if it never comes (the failure being tested for).
async function reply(page, plies, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(150);
    const s = await state(page);
    if (s.plies > plies && !s.thinking) return s;
  }
  return null;
}

// ── The translation itself ─────────────────────────────────────────────────
console.log('explorerMoveUci:');
{
  const { page, ctx } = await openPage(() => null);
  const r = await page.evaluate(() => ({
    wk: explorerMoveUci({ uci: 'e1h1', san: 'O-O' }),
    wq: explorerMoveUci({ uci: 'e1a1', san: 'O-O-O' }),
    bk: explorerMoveUci({ uci: 'e8h8', san: 'O-O' }),
    bq: explorerMoveUci({ uci: 'e8a8', san: 'O-O-O' }),
    check: explorerMoveUci({ uci: 'e8h8', san: 'O-O+' }),
    mate: explorerMoveUci({ uci: 'e1a1', san: 'O-O-O#' }),
    standard: explorerMoveUci({ uci: 'e1g1', san: 'O-O' }),
    rook: explorerMoveUci({ uci: 'e1h1', san: 'Rh1' }),
    queen: explorerMoveUci({ uci: 'e8a8', san: 'Qa8+' }),
    pawn: explorerMoveUci({ uci: 'e7e8q', san: 'e8=Q' }),
    noSan: explorerMoveUci({ uci: 'e2e4' }),
  }));
  ok('O-O and O-O-O become king moves, for both colours',
    r.wk === 'e1g1' && r.wq === 'e1c1' && r.bk === 'e8g8' && r.bq === 'e8c8', JSON.stringify(r));
  ok('with a check or mate suffix too', r.check === 'e8g8' && r.mate === 'e1c1', JSON.stringify(r));
  ok('a move already in the standard form is unchanged', r.standard === 'e1g1', r.standard);
  ok('a rook or queen on e1/e8 keeps its real move', r.rook === 'e1h1' && r.queen === 'e8a8', JSON.stringify(r));
  ok('everything else is unchanged', r.pawn === 'e7e8q' && r.noSan === 'e2e4', JSON.stringify(r));
  await ctx.close();
}

// ── The reported game ──────────────────────────────────────────────────────
// The exact position and the explorer's exact answer. The Pawn Pusher settings are
// the reporter's: its only candidate is also the most popular move, so Blind
// Conviction hands it straight back unchecked.
const REPORTED_FEN = 'rnb1k2r/pp2bpp1/7p/2pB4/4P3/2N2N2/PPP2PPP/R3K2R b KQkq - 0 11';
const REPORTED_SANS = 'e4 e5 Nc3 d6 Bc4 c6 Nf3 h6 d4 exd4 Qxd4 c5 Qd5 Qe7 Bf4 Nf6 Bxd6 Nxd5 Bxe7 Bxe7 Bxd5'.split(' ');

console.log('the reported position, on every engine with a book:');
{
  const { page, ctx, errs } = await openPage(() => [mv('e8h8', 'O-O')]);
  const pawnPusher = { blindConviction: true, pieceValues: { ...BASE_CFG.pieceValues, pawn: 5 } };
  for (const [name, cfg] of [
    ['LC+Maia, Pawn Pusher with Blind Conviction', { ...pawnPusher, color: 'white' }],
    ['LC+Maia, Conviction 100%', { convictionPct: 100, pieceValues: { ...BASE_CFG.pieceValues, pawn: 5 }, color: 'white' }],
    ['LC+Maia, no personality', { color: 'white' }],
    ['LC+Flounder', { engine: 'lcsf', lcsfElo: 1325, color: 'white' }],
    ['Hybrid with book', { engine: 'hybrid', color: 'white' }],
  ]) {
    await startFrom(page, cfg, REPORTED_FEN, REPORTED_SANS);
    const s = await reply(page, REPORTED_SANS.length);
    const castled = s && s.last === 'O-O' && s.squares.g8 === 'bK' && s.squares.f8 === 'bR' && !s.squares.e8 && !s.squares.h8;
    ok(name + ' castles', castled, JSON.stringify(s));
    await page.evaluate(() => botStop());
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ── The other three castling moves ─────────────────────────────────────────
console.log('the other castling moves:');
{
  const OPEN = 'r3k2r/ppp2ppp/2n1bn2/3qp3/8/2NP1N2/PPPQ1PPP/R3K2R';
  const cases = [
    { name: 'Black O-O-O', fen: OPEN + ' b KQkq - 0 10', color: 'white', book: mv('e8a8', 'O-O-O'),
      check: s => s.last === 'O-O-O' && s.squares.c8 === 'bK' && s.squares.d8 === 'bR' && !s.squares.a8 },
    { name: 'White O-O', fen: OPEN + ' w KQkq - 0 10', color: 'black', book: mv('e1h1', 'O-O'),
      check: s => s.last === 'O-O' && s.squares.g1 === 'wK' && s.squares.f1 === 'wR' && !s.squares.h1 },
    { name: 'White O-O-O', fen: OPEN + ' w KQkq - 0 10', color: 'black', book: mv('e1a1', 'O-O-O'),
      check: s => s.last === 'O-O-O' },
  ];
  for (const c of cases) {
    const { page, ctx } = await openPage(() => [c.book]);
    await startFrom(page, { color: c.color }, c.fen, []);
    const s = await reply(page, 0);
    ok(c.name, s && c.check(s), JSON.stringify(s));
    await ctx.close();
  }
}

// ── Not everything that looks like castling is ─────────────────────────────
console.log('a rook move written the same way:');
{
  const { page, ctx } = await openPage(() => [mv('e1h1', 'Rh1')]);
  await startFrom(page, { color: 'black' }, '4k3/8/8/8/8/8/5K2/4R3 w - - 0 1', []);
  const s = await reply(page, 0);
  ok('Re1-h1 is played as a rook move', s && s.last === 'Rh1' && s.squares.h1 === 'wR', JSON.stringify(s));
  await ctx.close();
}

// ── Main Line: the book's own most-played move ─────────────────────────────
// 4...O-O is the main move of the Nimzo-Indian, so this was not a thin-data fluke.
console.log('Main Line:');
{
  const NIMZO = {
    'd2d4': 'g8f6/Nf6', 'd2d4,g8f6,c2c4': 'e7e6/e6', 'd2d4,g8f6,c2c4,e7e6,b1c3': 'f8b4/Bb4',
    'd2d4,g8f6,c2c4,e7e6,b1c3,f8b4,e2e3': 'e8h8/O-O',
  };
  const { page, ctx, errs } = await openPage(u => {
    const line = NIMZO[u.searchParams.get('play')];
    if (!line) return null;
    const [uci, san] = line.split('/');
    return [mv(uci, san, 100)];
  });
  await startFrom(page, { color: 'white', openingMainLineBlack: true, openingSource: 'masters', openingDepth: 20 });
  const white = ['d2d4', 'c2c4', 'b1c3', 'e2e3'];
  let s = null;
  for (let i = 0; i < white.length; i++) {
    await page.evaluate(u => { const m = uciToSq(u); tryCommit(m.from, m.to, null); }, white[i]);
    s = await reply(page, i * 2 + 1);
    if (!s) break;
  }
  const moves = await page.evaluate(() => gameMovesAlgebraic.join(' '));
  ok('the bot plays the Nimzo through to 4...O-O', moves === 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O', moves);
  ok('and the book played it', s && s.src === 'Book', s && s.src);

  // The surprise check compares the human's move with the book's. Their castling
  // has to match too, or every castling move reads as a novelty worth a long pause.
  const standard = await page.evaluate(() => {
    const cached = [..._openingCache.values()].flatMap(d => (d && d.moves) || []);
    return { any: cached.length > 0, raw: cached.filter(m => /h8$|a8$|h1$|a1$/.test(m.uci) && /^O-O/.test(m.san)).length };
  });
  ok('the cached book holds no king-takes-rook moves', standard.any && standard.raw === 0, JSON.stringify(standard));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ── If a pick is still illegal, the game goes on ───────────────────────────
console.log('an illegal pick from anywhere:');
{
  // A book answering with a move from a different position.
  const { page, ctx, errs } = await openPage(() => [mv('a2a4', 'a4', 100), mv('h7h5', 'h5', 50)]);
  await startFrom(page, { color: 'white', convictionPct: 100 }, REPORTED_FEN, REPORTED_SANS);
  const s = await reply(page, REPORTED_SANS.length);
  ok('the game does not stall', !!s, JSON.stringify(await state(page)));
  ok('the bot plays a legal move', s && s.plies === REPORTED_SANS.length + 1, JSON.stringify(s));
  await page.evaluate(() => botStop());

  // Forced, so this holds whatever the pipeline picks: a pick nothing can play.
  await page.evaluate(() => {
    window.__realPick = botPickFromProbs;
    botPickFromProbs = async () => 'e8h8';
  });
  await startFrom(page, { color: 'white' }, REPORTED_FEN, REPORTED_SANS);
  const t = await reply(page, REPORTED_SANS.length);
  ok('a pick the board refuses becomes the last-resort move', t && t.src === 'Fallback', JSON.stringify(t));
  const warned = await page.evaluate(() => {
    const el = document.getElementById('bm-engine-warn');
    return el ? el.textContent : null;
  });
  ok('and the warning gives the real reason', /wouldn.t accept/.test(warned || ''), warned);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// A Main Line move for some other position must hand over to the engine.
console.log('a Main Line move the board refuses:');
{
  const { page, ctx } = await openPage(u => (u.searchParams.has('play') ? [mv('a2a4', 'a4', 100)] : [mv('h7h5', 'h5', 100)]));
  await startFrom(page, { color: 'white', openingMainLineBlack: true, openingSource: 'lichess', openingDepth: 20 },
    'rnb1k2r/pp2bpp1/7p/2pB4/4P3/2N2N2/PPP2PPP/R3K2R w KQkq - 0 11', []);
  // Any legal White move leaves a history for the book to misread.
  await page.evaluate(() => { const m = uciToSq('a2a3'); tryCommit(m.from, m.to, null); });
  const s = await reply(page, 1);
  ok('the bot still moves', !!s, JSON.stringify(await state(page)));
  ok('and the Main Line steps aside', s && s.src !== 'Book', s && s.src);
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

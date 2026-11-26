// The Chess960 opening book (Nov 21 2026, Ben): Opening Behavior's "In Chess960
// games" row, Off / Most common move / Follow the distribution.
//   1. The proxy passes variant=chess960 on to Lichess, and nothing else.
//   2. Config: opening960 reaches botOpeningConfig.book960; old configs read Off.
//   3. Off: a 960 game asks no book and the engine plays move 1.
//   4. Most common move: the 960 database is asked (variant, the game's start
//      FEN, no Masters, no Modern date cut) and its top move played.
//   5. Follow the distribution: a move drawn in proportion to its games, and
//      the surprise check counts the games of the move actually played.
//   6. Min games still ends it; a castle comes back king-takes-rook and is played.
//   7. A standard game is untouched: no 960 book, the Main Line as before.
//   8. The builder: the three-way switch, the section status, save and load.
//
// The explorer is mocked in the browser, and a stand-in Lichess answers the
// proxy, so this needs no network, no Lichess token and no Maia download.
// Needs the dev server on :3100 (or BM_URL). PW_CHROMIUM=<path> for a system Chromium.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.BM_URL || 'http://localhost:3100/';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(150); }
  return false;
}

// ── 1. The proxy ─────────────────────────────────────────────────────────────
console.log('1. The proxy');
{
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ white: 1, draws: 0, black: 0, moves: [] }));
  });
  await new Promise(r => stub.listen(3118, '127.0.0.1', r));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '3117', EXPLORER_HOST: 'http://127.0.0.1:3118', LICHESS_TOKEN: 'stand-in' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  srv.stdout.on('data', d => { if (/running on port/i.test(String(d))) up = true; });
  await until(() => up, 15000);
  const fen = encodeURIComponent('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1');
  const get = async q => { const n = seen.length; await fetch('http://127.0.0.1:3117/api/lichess?' + q); return seen.slice(n); };
  const a = await get('variant=chess960&fen=' + fen + '&play=&moves=20');
  ok('variant=chess960 goes on to Lichess with the 960 FEN', a.length === 1 && /^\/lichess\?variant=chess960&fen=bbqnnrkr/.test(a[0]) && /moves=20/.test(a[0]), a);
  const b = await get('variant=atomic&fen=' + fen + '&play=e2e4');
  ok('any other variant is dropped (Lichess then means standard)', b.length === 1 && !/variant=/.test(b[0]), b);
  const c = await get('fen=' + fen + '&play=d2d4');
  ok('no variant, none sent', c.length === 1 && !/variant=/.test(c[0]), c);
  const d = await get('fen=' + fen + '&play=c2c4');
  const e = await get('variant=chess960&fen=' + fen + '&play=c2c4');
  ok('the cache keeps a 960 answer apart from a standard one', d.length === 1 && e.length === 1, { d, e });
  srv.kill();
  stub.close();
}

// ── The site ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const mv = (uci, san, games) => ({ uci, san, white: games, draws: 0, black: 0, game: null, opening: null });

// `book(url)` answers explorer requests with a move list; every request is kept.
async function openPage(book) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [], reqs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route(/\/api\/(lichess|masters)/, route => {
    const u = new URL(route.request().url());
    reqs.push(u);
    const moves = book(u) || [];
    const n = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ white: n, draws: 0, black: 0, moves, opening: null }) });
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  return { page, ctx, errs, reqs };
}

// Flounder at 1200, answering at once; the bot plays White.
const CFG = {
  type: 'botConfig', engine: 'stockfish', elo: 1200, flounderElo: 1200, openingBook: false,
  cpBudget: 160, hardFloorCp: 160, convictionPct: 0, blindConviction: false,
  tcTime: 0, timingMode: 'instant', premoveEnabled: false, variant: 'chess960',
  attractorValues: {}, pieceValues: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0, king: 0 },
  openingRepWhite: true, openingRepBlack: true, openingMainLineWhite: true, openingMainLineBlack: true,
  openingMinGames: 4, modernOnly: true, repSlots: { white: [], black: [] }, customControls: [],
};
// Two pawn moves, legal in every Chess960 start: b3 is played 90 times, g3 10.
const TWO = () => [mv('b2b3', 'b3', 90), mv('g2g3', 'g3', 10)];

async function botFirstMove(page, cfg, opts = {}) {
  await page.evaluate(({ cfg, opts }) => {
    botApplyPanelConfig(cfg, true);
    if (opts.start) window._pendingStartPos = opts.start;
    botSetPlayerColor('black');
    botStart();
    // A fixed draw for the sampler, to know which move it should take.
    if (opts.draw != null) {
      if (!window._origSample) window._origSample = bookSampleMove;
      bookSampleMove = moves => window._origSample(moves, opts.draw);
    }
  }, { cfg: { ...CFG, ...cfg }, opts });
  await until(() => page.evaluate(() => (botMoveHistory || []).length >= 1 && !botThinking), 15000);
  return page.evaluate(() => ({
    hist: botMoveHistory.slice(), src: lastBotMoveSource, detail: lastBotMoveDetail, is960: chess960,
    start: _gameStartFen, mainLine: mainLineActive, lastBook: _botLastBookMove ? Object.assign({}, _botLastBookMove) : null,
    king: (() => { for (let s = 0; s < 64; s++) { const p = board[s]; if (p && p.color === 'w' && p.piece === 'K') return sqName(s); } })(),
    rookF1: (() => { const p = board[fileRankToSq('f1')]; return p ? p.color + p.piece : null; })(),
  }));
}

console.log('\n2. Config');
let P = await openPage(() => TWO());
const cfgRead = await P.page.evaluate(base => {
  const read = extra => { botApplyPanelConfig(Object.assign({}, base, extra), true); return botOpeningConfig.book960; };
  return { top: read({ opening960: 'top' }), sample: read({ opening960: 'sample' }), none: read({}), junk: read({ opening960: 'always' }) };
}, CFG);
ok('opening960 reaches the app (top, sample)', cfgRead.top === 'top' && cfgRead.sample === 'sample', cfgRead);
ok('a config without it, or with nonsense, reads Off', cfgRead.none === 'off' && cfgRead.junk === 'off', cfgRead);
// Ratings (Nov 26): each end a Lichess group, or the engine's own (null).
const bandRead = await P.page.evaluate(base => {
  const read = extra => { botApplyPanelConfig(Object.assign({}, base, extra), true); return [botOpeningConfig.book960From, botOpeningConfig.book960To]; };
  return { set: read({ opening960RatingFrom: 1000, opening960RatingTo: 2500 }), none: read({}), junk: read({ opening960RatingFrom: 1500, opening960RatingTo: 'high' }) };
}, CFG);
ok('Ratings reach the app; a config without them, or with ratings that are not groups, asks for the engine\'s group',
  bandRead.set.join() === '1000,2500' && bandRead.none.join() === ',' && bandRead.junk.join() === ',', bandRead);

console.log('\n3. Off');
let r = await botFirstMove(P.page, { opening960: 'off' });
ok('a Chess960 game', r.is960 && /^[rnbqk]{8}\/pppppppp/.test(r.start || ''), r.start);
ok('no book was asked, Repertoire and Main Line on or not', P.reqs.length === 0, P.reqs.map(String));
ok('the engine played move 1', r.hist.length === 1 && r.src !== 'Book', r);

console.log('\n4. Most common move');
P.reqs.length = 0;
r = await botFirstMove(P.page, { opening960: 'top' });
const q = P.reqs[0];
ok('one lookup, to the Lichess database only', P.reqs.length >= 1 && P.reqs.every(u => u.pathname === '/api/lichess'), P.reqs.map(String));
ok('asked as variant=chess960 from the game\'s start FEN', q && q.searchParams.get('variant') === 'chess960' && q.searchParams.get('fen') === r.start && q.searchParams.get('play') === '', q && String(q));
ok('at the bot\'s rating, 20 moves, no Modern date cut', q && q.searchParams.get('ratings') === '1200' && q.searchParams.get('moves') === '20' && !q.searchParams.has('since'), q && String(q));
ok('played the most common move (b3, 90 of 100)', r.hist[0] === 'b2b3' && r.src === 'Book', r);
ok('the move log names the 960 book', /^Chess960 book \(most common move\)/.test(r.detail), r.detail);
P.reqs.length = 0;
r = await botFirstMove(P.page, { opening960: 'top', opening960RatingFrom: 1000, opening960RatingTo: 2500 });
ok('Ratings 1000 to 2500+: every group between asked for', P.reqs[0] && P.reqs[0].searchParams.get('ratings') === '1000,1200,1400,1600,1800,2000,2200,2500' && r.src === 'Book',
  P.reqs[0] && String(P.reqs[0]));
P.reqs.length = 0;
r = await botFirstMove(P.page, { opening960: 'top', opening960RatingTo: 1600 });
ok('only a highest end (1600): from the engine\'s group (1200) up to it', P.reqs[0] && P.reqs[0].searchParams.get('ratings') === '1200,1400,1600',
  P.reqs[0] && String(P.reqs[0]));

console.log('\n5. Follow the distribution');
const dist = await P.page.evaluate(() => {
  const ms = [{ uci: 'a', white: 90, draws: 0, black: 0 }, { uci: 'b', white: 6, draws: 2, black: 2 }];
  const at = x => bookSampleMove(ms, x).uci;
  let b = 0; for (let i = 0; i < 20000; i++) if (bookSampleMove(ms).uci === 'b') b++;
  return { d0: at(0), d89: at(0.89), d90: at(0.9), d99: at(0.999), share: b / 20000 };
});
ok('the draw walks the moves by games (0→a, 0.89→a, 0.90→b, 0.999→b)', dist.d0 === 'a' && dist.d89 === 'a' && dist.d90 === 'b' && dist.d99 === 'b', dist);
ok('over 20,000 draws the 10% move comes up 10% of the time (' + (100 * dist.share).toFixed(1) + '%)', Math.abs(dist.share - 0.1) < 0.01, dist.share);
r = await botFirstMove(P.page, { opening960: 'sample' }, { draw: 0.95 });
ok('a draw of 0.95 plays the rarer move (g3, 10 of 100)', r.hist[0] === 'g2g3' && r.src === 'Book', r);
ok('the move log says sampled', /^Chess960 book \(sampled\)/.test(r.detail), r.detail);
ok('the surprise check counts the games of the move played (10, not 90)', r.lastBook && r.lastBook.games === 10, r.lastBook);
r = await botFirstMove(P.page, { opening960: 'sample' }, { draw: 0.5 });
ok('a draw of 0.5 plays b3', r.hist[0] === 'b2b3', r);
await P.ctx.close();

console.log('\n6. Min games, and castling');
P = await openPage(() => [mv('b2b3', 'b3', 2), mv('g2g3', 'g3', 1)]);
r = await botFirstMove(P.page, { opening960: 'top' });
ok('3 games against Min games 4: out of book, the engine plays', r.hist.length === 1 && r.src !== 'Book' && !r.mainLine, r);
await P.ctx.close();
P = await openPage(() => [mv('e1h1', 'O-O', 12), mv('d2d3', 'd3', 3)]);
r = await botFirstMove(P.page, { opening960: 'top' }, {
  start: { fen: 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', sans: [], chess960: true },
});
ok('the book\'s O-O (e1h1) is played as it came: king g1, rook f1', r.hist[0] === 'e1h1' && r.king === 'g1' && r.rookF1 === 'wR' && r.src === 'Book', r);
await P.ctx.close();

console.log('\n7. A standard game');
P = await openPage(u => u.searchParams.get('play') === '' ? [mv('e2e4', 'e4', 900), mv('d2d4', 'd4', 100)] : []);
r = await botFirstMove(P.page, { variant: 'standard', opening960: 'top', openingRepWhite: false, openingMainLineWhite: false, openingRepBlack: false, openingMainLineBlack: false });
ok('Main Line off: no book asked, the 960 setting has no say', !r.is960 && P.reqs.length === 0, P.reqs.map(String));
P.reqs.length = 0;
r = await botFirstMove(P.page, { variant: 'standard', opening960: 'sample', openingRepWhite: false, openingMainLineWhite: true, modernOnly: false, openingSource: 'lichess' });
const sq = P.reqs[0];
ok('Main Line on: asked as before (no variant, 10 moves) and plays the top move', sq && !sq.searchParams.has('variant') && sq.searchParams.get('moves') === '10' && r.hist[0] === 'e2e4' && /^Book/.test(r.detail), { url: sq && String(sq), r });

console.log('\n8. The builder');
await P.page.evaluate(() => { openBotModal(); });
const f = await (await P.page.waitForSelector('#botModalFrame')).contentFrame();
await f.waitForFunction(() => typeof setBook960 === 'function');
const ui0 = await f.evaluate(() => ({ v: getBotConfig().opening960, sel: document.querySelector('#op-960 .seg-btn.sel').dataset.b960 }));
await f.evaluate(() => applyBotConfig({ type: 'botConfig' }));
const ui1 = await f.evaluate(() => ({ v: getBotConfig().opening960, sel: document.querySelector('#op-960 .seg-btn.sel').dataset.b960 }));
ok('a config without the setting shows Off', ui1.v === 'off' && ui1.sel === 'off', { ui0, ui1 });
await f.evaluate(() => toggleSec('opening'));
// The section expands over 0.45 s and then scrolls itself into view. Playwright's
// click, which scrolls again on every retry, kept meeting a section header over
// the button and never landed (Nov 22, with this builder and the one before
// it). So: wait until the button is what is under its centre, where a person
// would click it, and click it there.
await f.waitForFunction(() => {
  const b = document.querySelector('#op-960 .seg-btn[data-b960="sample"]');
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
  if (hit) b.click();
  return hit;
}, null, { timeout: 5000 });
const ui2 = await f.evaluate(() => ({
  v: getBotConfig().opening960, aria: document.querySelector('#op-960 [data-b960="sample"]').getAttribute('aria-checked'),
  others: [...document.querySelectorAll('#op-960 .seg-btn.sel')].length, st: document.getElementById('st-opening').textContent,
}));
ok('clicking Follow the distribution selects it alone and saves "sample"', ui2.v === 'sample' && ui2.aria === 'true' && ui2.others === 1, ui2);
ok('the section status says so ("' + ui2.st + '")', /960: Distribution$/.test(ui2.st), ui2.st);
await f.evaluate(() => applyBotConfig({ type: 'botConfig', opening960: 'top', openingMinGames: 7 }));
const ui3 = await f.evaluate(() => ({
  v: getBotConfig().opening960, sel: document.querySelector('#op-960 .seg-btn.sel').dataset.b960,
  min: document.querySelector('#op-960 .book-min-input').value, st: document.getElementById('st-opening').textContent,
}));
ok('loading a bot with "top" selects Most common move, its Min games in the row (7)', ui3.v === 'top' && ui3.sel === 'top' && ui3.min === '7' && /960: Most common$/.test(ui3.st), ui3);
await f.evaluate(() => { const i = document.querySelector('#op-ml-white .book-min-input'); i.value = '9'; onBookMinGamesInput(i); });
ok('Min games is one setting: typed in the Main Line, the 960 row shows it', await f.evaluate(() => document.querySelector('#op-960 .book-min-input').value === '9' && getBotConfig().openingMinGames === 9));
// Ratings: two lists of the Lichess groups, the engine's own first; the note
// says what is asked for; saved and loaded with the bot.
const band0 = await f.evaluate(() => ({
  opts: [...document.querySelectorAll('#b960-from option')].map(o => o.value + ':' + o.textContent).join(' | '),
  toN: document.querySelectorAll('#b960-to option').length,
  v: [getBotConfig().opening960RatingFrom, getBotConfig().opening960RatingTo], note: document.getElementById('b960-band-note').textContent,
}));
ok('the Ratings lists: the engine\'s group, then 0–999 to 2500+', /^:The engine’s group \| 0:0–999 \| 1000:1000–1199 .*\| 2200:2200–2499 \| 2500:2500\+$/.test(band0.opts) && band0.toN === 10, band0.opts);
ok('to start, the engine\'s group alone, and the note names it', band0.v[0] === null && band0.v[1] === null && /^Asks for Lichess games rated (\d+–\d+|under 1000|2500\+): the group the engine’s \d+ is in\.$/.test(band0.note), band0);
const band1 = await f.evaluate(() => {
  setElo(1500);
  document.getElementById('b960-from').value = '1000';
  document.getElementById('b960-to').value = '2500';
  onBook960BandChange();
  const a = { v: [getBotConfig().opening960RatingFrom, getBotConfig().opening960RatingTo], note: document.getElementById('b960-band-note').textContent };
  document.getElementById('b960-from').value = '';
  onBook960BandChange();
  a.oneEnd = document.getElementById('b960-band-note').textContent;
  applyBotConfig({ type: 'botConfig', opening960: 'top', opening960RatingFrom: 1800, opening960RatingTo: 2200 });
  a.loaded = [document.getElementById('b960-from').value, document.getElementById('b960-to').value, document.getElementById('b960-band-note').textContent];
  applyBotConfig({ type: 'botConfig', opening960: 'top' });
  a.old = [document.getElementById('b960-from').value, document.getElementById('b960-to').value];
  return a;
});
ok('picking 1000 to 2500+ saves the two groups, and the note says 1000 and up (both ends set: the engine\'s rating has no say)',
  band1.v.join() === '1000,2500' && band1.note === 'Asks for Lichess games rated 1000 and up.', band1);
ok('with only the highest end set, the engine\'s group is the lowest', band1.oneEnd === 'Asks for Lichess games rated 1400 and up (the engine plays at 1500).', band1.oneEnd);
ok('a bot saved with Ratings loads them; one saved before them shows the engine\'s group', band1.loaded[0] === '1800' && band1.loaded[1] === '2200' &&
  band1.loaded[2] === 'Asks for Lichess games rated 1800–2499.' && band1.old.join() === ',', band1);
const vis = await f.evaluate(() => { const b = document.getElementById('op-960').getBoundingClientRect(); return b.width > 0 && b.height > 0; });
ok('the row is on screen in the open section', vis);
ok('no page errors', P.errs.length === 0, P.errs);
await P.ctx.close();

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

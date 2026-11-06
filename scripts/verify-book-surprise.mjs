// Does a Main Line bot think longer when the human plays a move the book rarely sees?
//
// The pause existed and almost never happened:
//   - the check read the position the human moved FROM, which the Main Line never
//     looks up (it asks about the positions the BOT moves from), so it found nothing;
//   - a Main Line move takes the book delay and never read the boost;
//   - on an engine move the rough estimate spent it, not the call that sets the delay;
//   - modes that return early left it pending for some later move.
//
// The frequency is now games at the new position over games with the bot's last book
// move, from lookups the Main Line makes anyway. Looking up the human's position
// instead doubled the requests and ran a fast game into the proxy's rate limit, where
// a refused lookup ends the Main Line, so the request count is checked here too.
//
// These play real games through botMakeMove against a fake explorer whose numbers
// decide what counts as rare. No network, Lichess token or Maia download needed.
// Needs the dev server on :3100 (or BM_URL). PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const mv = (uci, games) => ({ uci, san: uci, white: games, draws: 0, black: 0, game: null, opening: null });

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
});

// A small book, keyed by the moves played. 1.e4 has 1000 games, and the games at each
// position after it set how common the reply was: c5 60%, e6 10%, d6 4%, a6 1%.
const BOOK = {
  '': [mv('e2e4', 1000), mv('d2d4', 500)],
  'e2e4,c7c5': [mv('g1f3', 600)], 'e2e4,e7e6': [mv('d2d4', 100)],
  'e2e4,d7d6': [mv('d2d4', 40)],  'e2e4,a7a6': [mv('d2d4', 10)],
};
const STANDARD = q => BOOK[q.play] || null;
let book = STANDARD;
let asked = [];
await ctx.route(/\/api\/(lichess|masters)\?/, async route => {
  const u = new URL(route.request().url());
  const q = { db: u.pathname.endsWith('masters') ? 'masters' : 'lichess',
              fen: u.searchParams.get('fen') || '', play: u.searchParams.get('play') || '' };
  asked.push(q);
  if (!q.fen && !q.play) {
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"need fen or play"}' });
  }
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ opening: { eco: 'A00', name: 'Fake book' }, moves: book(q) || [] }) });
});

const errs = [];
const app = await ctx.newPage();
app.on('pageerror', e => errs.push(e.message));
app.on('dialog', d => d.accept());
await app.goto(BASE, { waitUntil: 'domcontentloaded' });
await app.waitForTimeout(1600);
await app.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

// Record what each delay call was asked to do, and what it returned.
await app.evaluate(() => {
  window.__book = []; window.__think = [];
  const realBook = botBookMoveDelayMs, realThink = botThinkTime;
  botBookMoveDelayMs = function (clockMs, mult) {
    const ms = realBook(clockMs, mult);
    __book.push({ mult: mult === undefined ? 1 : mult, ms });
    return ms;
  };
  botThinkTime = function (probs, clockMs, opts) {
    const before = _explorerSurpriseBoost;
    const ms = realThink(probs, clockMs, opts);
    __think.push({ rough: !!(opts && opts.rough), before, after: _explorerSurpriseBoost, ms });
    return ms;
  };
});

const CFG = {
  type: 'botConfig', engine: 'stockfish', elo: 1500, openingBook: false, cpBudget: 160, hardFloorCp: 160,
  convictionPct: 0, blindConviction: false, tcTime: 0, timingMode: 'complexity', premoveEnabled: false,
  attractorValues: {}, pieceValues: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0, king: 0 },
  openingRepWhite: false, openingRepBlack: false, openingMainLineWhite: true, openingMainLineBlack: false,
  openingSource: 'masters', openingDepth: 20, repSlots: { white: [], black: [] }, customControls: [], color: 'black',
};

async function start(cfg = {}, bookFn = STANDARD) {
  book = bookFn;
  asked = [];
  await app.evaluate(cfg => {
    botStop();
    _openingCache.clear();
    __book.length = 0; __think.length = 0;
    botApplyPanelConfig(cfg, true);
    botStart();
  }, { ...CFG, ...cfg });
}
const state = () => app.evaluate(() => ({
  history: botMoveHistory.slice(), src: lastBotMoveSource, thinking: botThinking, mainLine: mainLineActive,
  boost: _explorerSurpriseBoost, book: __book.slice(), think: __think.slice(),
}));
async function moved(n, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await app.waitForTimeout(40);
    const s = await state();
    if (s.history.length >= n && !s.thinking) return s;
  }
  return null;
}
const human = uci => app.evaluate(u => { const m = uciToSq(u); tryCommit(m.from, m.to, null); }, uci);
const lastBook = s => s && s.book[s.book.length - 1];
const j = JSON.stringify;

// ── The size of the pause ──────────────────────────────────────────────────
console.log('the bot plays 1.e4 (1000 games) and the human answers:');
for (const [name, reply, mult] of [
  ['60% of games: expected, no pause', 'c7c5', 1],
  ['10%: a partial pause', 'e7e6', 1.75],
  ['4%: the full pause', 'd7d6', 2.5],
  ['1%: the full pause', 'a7a6', 2.5],
]) {
  await start();
  await moved(1);
  const t0 = Date.now();
  await human(reply);
  const s = await moved(3);
  const elapsed = Date.now() - t0;
  const last = lastBook(s);
  ok(name + ' (x' + mult + ')', s && s.src === 'Book' && last && Math.abs(last.mult - mult) < 1e-9, j(last));
  if (mult > 1) ok('  and the move really does wait that long', last && elapsed >= last.ms - 60, elapsed + ' ms vs ' + (last && last.ms));
  ok('  and it is spent', s && s.boost === 0, s && String(s.boost));
}

console.log('the pause is for one reply:');
{
  await start({}, q => (q.play === 'e2e4,d7d6,d2d4,g8f6' ? [mv('b1c3', 30)] : STANDARD(q)));
  await moved(1);
  await human('d7d6');
  let s = await moved(3);
  ok('the rare reply gets it', lastBook(s) && lastBook(s).mult === 2.5, s && j(s.book));
  await human('g8f6');   // 30 of the 40 games with 2.d4
  s = await moved(5);
  ok('the common reply after it does not', lastBook(s) && lastBook(s).mult === 1, s && j(s.book));
}

// ── What the pause costs ───────────────────────────────────────────────────
console.log('the request count:');
{
  await start({}, q => (q.play === 'e2e4,d7d6,d2d4,g8f6' ? [mv('b1c3', 30)] : STANDARD(q)));
  await moved(1);
  await human('d7d6');
  await moved(3);
  await human('g8f6');
  await moved(5);
  await app.waitForTimeout(300);
  const plays = asked.map(q => q.play);
  ok('one lookup per bot move, and only for positions the bot moves from',
    j(plays) === j(['', 'e2e4,d7d6', 'e2e4,d7d6,d2d4,g8f6']), j(plays));
}

// ── Where there is nothing to measure against ──────────────────────────────
console.log('the bot plays Black, and the human moves first:');
{
  const LINE = { 'a2a4': [mv('d7d5', 500)], 'a2a4,d7d5,h2h3': [mv('g8f6', 5)] };
  await start({ color: 'white', openingMainLineWhite: false, openingMainLineBlack: true }, q => LINE[q.play] || null);
  await human('a2a4');
  let s = await moved(2);
  ok('nothing to measure a first move against: no pause', s && s.src === 'Book' && lastBook(s).mult === 1, s && j(lastBook(s)));
  await human('h2h3');   // 5 of the 500 games with 1...d5
  s = await moved(4);
  ok('the next reply is measured: 1%, the full pause', s && s.src === 'Book' && lastBook(s).mult === 2.5, s && j(lastBook(s)));
}

console.log('leaving a repertoire:');
{
  const LINE = { 'e2e4,a7a6': [mv('d2d4', 10)], 'e2e4,a7a6,d2d4,h7h5': [mv('b1c3', 5)] };
  await start({ openingRepWhite: true, repSlots: { white: [{ code: 'C50', name: 'Italian Game', pct: 100 }], black: [] } },
    q => LINE[q.play] || null);
  const a = await moved(1);
  ok('1.e4 from the repertoire', a && a.history[0] === 'e2e4' && a.src === 'ECO', a && a.src);
  await human('a7a6');
  const s = await moved(3);
  ok('the reply to a repertoire move has nothing to measure against: no pause',
    s && s.src === 'Book' && lastBook(s).mult === 1, s && j({ src: s.src, last: lastBook(s) }));
}

console.log('a bot premove in between:');
{
  await start();
  await moved(1);
  // Two more plies than a reply: the bot's own premove and another human move.
  const r = await app.evaluate(() => {
    _explorerSurpriseBoost = 0;
    _botLastBookMove = { games: 1000, db: 'masters', ply: botMoveHistory.length - 2 };
    botNoteBookReply({ db: 'masters', moves: [{ white: 1, draws: 0, black: 0 }] });
    return { boost: _explorerSurpriseBoost, cleared: _botLastBookMove === null };
  });
  ok('the numbers are for different positions, so no pause', r.boost === 0 && r.cleared, j(r));
}

// ── Leaving the book ───────────────────────────────────────────────────────
// The Main Line ends, so the engine's move is the reply that pauses, and the estimate
// must not spend it first.
console.log('a reply that leaves the book:');
{
  await start();
  await moved(1);
  await human('h7h5');   // not listed anywhere
  const s = await moved(3);
  ok('the Main Line ends and the engine plays', s && s.src !== 'Book' && s.mainLine === false, s && s.src);
  const rough = s && s.think.find(t => t.rough), real = s && s.think.find(t => !t.rough);
  ok('the rough estimate leaves the pause alone', rough && rough.before === 1 && rough.after === 1, j(rough));
  ok('the real delay takes it', real && real.before === 1 && real.after === 0, j(real));
}
{
  // The bot's move has 10 games and the reply fewer than 4. That could be 3 of 10:
  // the book running out is not the human doing something rare.
  await start({}, q => (q.play === '' ? [mv('e2e4', 10)] : null));
  await moved(1);
  await human('c7c5');
  const s = await moved(3);
  const real = s && s.think.find(t => !t.rough);
  ok('a thin book running out is no surprise', s && s.src !== 'Book' && real && real.before === 0, j(real));
}
{
  await start({ openingDepth: 1 });
  await moved(1);
  await human('a7a6');   // 1% of games, but the book stops at this depth regardless
  const s = await moved(3);
  const real = s && s.think.find(t => !t.rough);
  ok('reaching the book depth is no surprise', s && s.src !== 'Book' && real && real.before === 0, j(real));
}

// ── Two databases ──────────────────────────────────────────────────────────
console.log('Masters running out into the Lichess games:');
{
  // Counts from the two databases are not comparable: 50000 Lichess games over 1000
  // master games would read as "expected" for a reply masters almost never play.
  const db = q => (q.play === '' ? (q.db === 'masters' ? [mv('e2e4', 1000)] : null)
    : (q.db === 'masters' ? [mv('g1f3', 2)] : [mv('g1f3', 50000)]));
  await start({}, db);
  await moved(1);
  await human('c7c5');
  const s = await moved(3);
  ok('fewer than Min games of 1000: the full pause', s && s.src === 'Book' && lastBook(s).mult === 2.5, s && j(lastBook(s)));
}
{
  await start({ openingSource: 'lichess' });
  await moved(1);
  await human('d7d6');
  const s = await moved(3);
  ok('the Lichess database on its own works the same', s && s.src === 'Book' && lastBook(s).mult === 2.5, s && j(lastBook(s)));
}
{
  // A rare move order into a well-known position.
  await start({}, q => (q.play === '' ? [mv('e2e4', 1000)] : q.play === 'e2e4,a7a6' ? [mv('d2d4', 40000)] : null));
  await moved(1);
  await human('a7a6');
  const s = await moved(3);
  ok('a transposition into known theory: no pause', s && s.src === 'Book' && lastBook(s).mult === 1, s && j(lastBook(s)));
}

// ── Modes that set their own pace ──────────────────────────────────────────
console.log('modes that set their own pace:');
for (const mode of ['fixed', 'instant', 'mirror']) {
  await start({ timingMode: mode, fixedDelayMs: 300 });
  await moved(1);
  await human('d7d6');
  const s = await moved(3);
  const last = lastBook(s);
  ok(mode + ': no pause, and nothing left pending', s && last && last.mult === 1 && s.boost === 0, j(last));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

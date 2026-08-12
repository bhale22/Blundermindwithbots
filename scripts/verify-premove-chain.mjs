// Headless verification of PLAYER premove chains (Chess.com-style queues).
// Distinct from scripts/verify-premove.mjs, which covers the BOT's own premove.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-premove-chain.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(700);

console.log('wiring:');
const wiring = await page.evaluate(() => ({
  queue:  Array.isArray(premoveQueue),
  max:    typeof PREMOVE_MAX !== 'undefined' ? PREMOVE_MAX : null,
  fns:    ['hasPremove','premoveSpecState','premoveSquareMap','queuePremove',
           'cancelPremove','tryFirePremove','premoveDests']
            .filter((f) => typeof window[f] === 'function'),
  oldGone: typeof window.activePremove === 'undefined',
}));
ok(wiring.queue, 'premoveQueue is an array');
ok(wiring.max === 10, 'PREMOVE_MAX is 10 (' + wiring.max + ')');
ok(wiring.fns.length === 7, 'all premove functions defined (' + wiring.fns.join(',') + ')');
ok(wiring.oldGone, 'the old single-slot activePremove global is gone');

// Put the app into "waiting for the opponent" without needing a live engine:
// botActive + botThinking is exactly what isWaitingTurn() keys off, and
// botPlayerColor is the HUMAN's colour.
const arm = async (fen) => page.evaluate((f) => {
  board = parseFen(f);          // also sets turn / castling / epSq globals
  atkMap = buildAtk(board);
  premoveQueue = [];
  botActive = true; botThinking = true; botPlayerColor = 'white';
  gameOver = false; selSq = -1; legalMoves = [];
  render();
}, fen);

console.log('\nchaining:');
// White: Ng1, Bf1, Rh1, Ke1. Black to move, so we are "waiting".
await arm('4k3/8/8/8/8/8/8/4KBNR b K - 0 1');

const chain = await page.evaluate(() => {
  const sq = fileRankToSq;
  const r = {};
  r.q1 = tryCommit(sq('g1'), sq('f3'));            // Nf3
  r.afterOne = premoveQueue.length;
  // The knight has left g1 on the speculative board...
  r.specEmptyG1 = !premoveSpecState().board[sq('g1')];
  r.specHasF3   = !!premoveSpecState().board[sq('f3')];
  // ...so the next link must be generated FROM f3.
  r.q2 = tryCommit(sq('f3'), sq('e5'));            // Ne5
  r.afterTwo = premoveQueue.length;
  // A link that vacates a square for a later one.
  r.q3 = tryCommit(sq('f1'), sq('c4'));            // Bc4
  r.q4 = tryCommit(sq('h1'), sq('f1'));            // Rf1 — only legal once Bf1 left
  r.len = premoveQueue.length;
  r.moves = premoveQueue.map((p) => sqName(p.from) + sqName(p.to));
  return r;
});
ok(chain.q1 && chain.afterOne === 1, 'first premove queues');
ok(chain.specEmptyG1 && chain.specHasF3, 'speculative board moves the knight g1→f3');
ok(chain.q2 && chain.afterTwo === 2, 'second link generates from the knight\'s NEW square');
ok(chain.q3, 'bishop link queues');
ok(chain.q4, 'rook may follow onto f1 because the bishop premove vacated it');
ok(chain.len === 4, 'four links queued (' + chain.len + ')');
ok(chain.moves.join(' ') === 'g1f3 f3e5 f1c4 h1f1',
   'queue order preserved: ' + chain.moves.join(' '));

// Optimistic legality: a move that is NOT legal right now must still queue.
await arm('4k3/8/8/4P3/8/8/8/4K3 b - - 0 1');
const optimistic = await page.evaluate(() => {
  const sq = fileRankToSq;
  return {
    legalNow: legalMovesFor(sq('e5'), board, epSq, castling).map(sqName),
    queued:   tryCommit(sq('e5'), sq('d6')),   // pawn takes into empty air
    len:      premoveQueue.length,
  };
});
ok(!optimistic.legalNow.includes('d6'), 'exd6 is not legal in the current position');
ok(optimistic.queued && optimistic.len === 1, 'but it still queues as a premove');

console.log('\ncap:');
await arm('4k3/8/8/8/8/8/8/R3K2R b KQ - 0 1');
const capped = await page.evaluate(() => {
  const sq = fileRankToSq;
  // Shuffle the rook back and forth to build a long chain cheaply.
  const path = ['a1a2','a2a1','a1a2','a2a1','a1a2','a2a1','a1a2','a2a1','a1a2','a2a1','a1a2','a2a1'];
  const results = path.map((m) => tryCommit(sq(m.slice(0, 2)), sq(m.slice(2))));
  return { len: premoveQueue.length, accepted: results.filter(Boolean).length };
});
ok(capped.len === 10, 'queue caps at PREMOVE_MAX = 10 (' + capped.len + ')');
ok(capped.accepted === 10, 'the 11th and 12th attempts are refused (' + capped.accepted + ' accepted)');

console.log('\nfiring:');
// One link fires per opponent reply — not the whole chain at once.
await arm('4k3/8/8/8/8/8/8/4K1NR b K - 0 1');
const firing = await page.evaluate(() => {
  const sq = fileRankToSq;
  tryCommit(sq('g1'), sq('f3'));
  tryCommit(sq('f3'), sq('e5'));
  const before = premoveQueue.length;
  // It is our turn now (as it would be right after the opponent moved).
  turn = 'w'; botThinking = false;
  tryFirePremove();
  return {
    before,
    after: premoveQueue.length,
    knightOnF3: !!board[sq('f3')] && board[sq('f3')].piece === 'N',
    stillQueued: premoveQueue.map((p) => sqName(p.from) + sqName(p.to)),
  };
});
ok(firing.before === 2, 'two links queued before firing');
ok(firing.knightOnF3, 'the first link played (knight now on f3)');
ok(firing.after === 1, 'exactly ONE link consumed, not the whole chain');
ok(firing.stillQueued.join(' ') === 'f3e5', 'the remainder waits: ' + firing.stillQueued.join(' '));

// A broken link discards the rest — the chain was planned as a whole.
await arm('4k3/8/8/8/8/8/8/4K1NR b K - 0 1');
const broken = await page.evaluate(() => {
  const sq = fileRankToSq;
  tryCommit(sq('g1'), sq('f3'));
  tryCommit(sq('f3'), sq('e5'));
  // One of OUR OWN pawns ends up on f3, so Nf3 is genuinely illegal when it
  // fires. (A black piece there would not do: the knight would simply take it.)
  board[sq('f3')] = { piece: 'P', color: 'w' };
  atkMap = buildAtk(board);
  turn = 'w'; botThinking = false;
  const legalBefore = legalMovesFor(sq('g1'), board, epSq, castling).map(sqName);
  tryFirePremove();
  return { legalBefore, len: premoveQueue.length, knightStillG1: !!board[sq('g1')] };
});
ok(!broken.legalBefore.includes('f3'), 'setup: Nf3 is illegal once our own pawn sits on f3');
ok(broken.knightStillG1, 'the broken link is not played');
ok(broken.len === 0, 'and it takes the rest of the chain with it (' + broken.len + ' left)');

console.log('\nrender + cancel:');
await arm('4k3/8/8/8/8/8/8/4K1NR b K - 0 1');
const painted = await page.evaluate(() => {
  const sq = fileRankToSq;
  tryCommit(sq('g1'), sq('f3'));
  tryCommit(sq('f3'), sq('e5'));
  const map = premoveSquareMap();
  let threw = null;
  try { render(); } catch (e) { threw = e.message; }
  return {
    threw,
    marks: [...map.entries()].map(([s, v]) => sqName(s) + ':' + v.kind + v.n).sort(),
  };
});
ok(painted.threw === null, 'render() draws a queued chain without throwing');
ok(painted.marks.join(' ') === 'e5:to2 f3:to1 g1:from1',
   'every link is marked with its order: ' + painted.marks.join(' '));

const cancelled = await page.evaluate(() => {
  const cv = document.getElementById('cv');
  cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return premoveQueue.length;
});
ok(cancelled === 0, 'right-click clears the whole queue');

// A real click on the canvas must compose a premove through the live input path.
console.log('\nlive input:');
await arm('4k3/8/8/8/8/8/8/4K1NR b K - 0 1');
const geom = await page.evaluate(() => {
  const cv = document.getElementById('cv');
  const rect = cv.getBoundingClientRect();
  const sqPx = rect.width / 8;
  const at = (name) => {
    const s = fileRankToSq(name);
    const flipped = boardFlipped || (typeof mpRole !== 'undefined' && mpRole === 'black' &&
                                     typeof mpInGame === 'function' && mpInGame());
    const r = Math.floor(s / 8), c = s % 8;
    const dr = flipped ? 7 - r : r, dc = flipped ? 7 - c : c;
    return { x: rect.left + (dc + 0.5) * sqPx, y: rect.top + (dr + 0.5) * sqPx };
  };
  return { g1: at('g1'), f3: at('f3') };
});
await page.mouse.click(geom.g1.x, geom.g1.y);
await page.waitForTimeout(120);
const selected = await page.evaluate(() => ({ sel: selSq, dests: legalMoves.map(sqName).sort() }));
ok(selected.dests.includes('f3'), 'clicking the knight offers premove destinations: ' + selected.dests.join(','));
await page.mouse.click(geom.f3.x, geom.f3.y);
await page.waitForTimeout(150);
const liveQueued = await page.evaluate(() => premoveQueue.map((p) => sqName(p.from) + sqName(p.to)));
ok(liveQueued.join(' ') === 'g1f3', 'a real two-click drag queues the premove: ' + (liveQueued.join(' ') || '(none)'));

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

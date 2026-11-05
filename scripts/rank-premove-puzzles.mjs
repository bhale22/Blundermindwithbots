// Keep only the premove puzzles a player could have seen coming, and order
// them from easy to hard. A premove puzzle is fair only when you could expect
// both halves of it:
//   1. the move your opponent was premoving against is forced, as near as a
//      player of your rating plays: Maia at the solver's rating gives one move
//      at least FORCED_MIN, and
//   2. against that move the premove is the obvious reply: Maia at the
//      premover's rating gives it at least PREMOVE_MIN.
// Then you know they are likely to premove, and what. A puzzle is also
// dropped when an honest move does about as well as the trap (EXPLOIT_MIN):
// with a mate on the board, the premove doesn't matter.
//
// The order is by how often a 1500 player would find the first move: Maia
// 1500's probability for the moves that solve it (the accepted answers, plus
// any reply scoring within 8 win% points of the best).
//
// Runs the app's own Maia in a headless browser, so the numbers are the ones
// the board would give. Needs the server running on :3100
// (PORT=3100 node server.js). From repo root:
//   node scripts/rank-premove-puzzles.mjs <in.json> [out.json]
// out defaults to data/premove-puzzles.json. Adds `expected`, `expectedP`,
// `premoveP` and `maia1500` to each puzzle it keeps.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3100';
const SLACK = 8;          // PZ_SLACK in src/68-premove-puzzles.js
const FORCED_MIN = 0.8;
const PREMOVE_MIN = 0.8;
const EXPLOIT_MIN = 20;   // win% points the trap must beat the best honest move by
const [inPath, outPath = 'data/premove-puzzles.json'] = process.argv.slice(2);
if (!inPath) { console.error('usage: node scripts/rank-premove-puzzles.mjs <in.json> [out.json]'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => { localStorage.setItem('bm_welcomed', '1'); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  if (!_maiaWorker) { maiaInit(); _maiaLoadMappings(); }
  setTimeout(() => { if (!_maiaReady) maiaDownloadModel(); }, 1500);
});
await page.waitForFunction(() => _maiaReady === true, null, { timeout: 300000, polling: 500 });
console.log('Maia ready');

// maia3GetMoveProbs plays both sides at one rating. Here each side is its own
// player: Maia as `self`, facing `oppo`.
const probs = (fen, self, oppo) => page.evaluate(async ([fen, self, oppo]) => {
  if (!_maia3MoveIndex && !(await _maiaLoadMappings())) return null;
  const clamp = r => Math.max(600, Math.min(2600, r || 1500));
  const enc = _maiaEncode(fen);
  const mask = _maiaLegalMask(fen);
  if (!mask) return null;
  const id = _maiaNextId++;
  const res = await new Promise((resolve, reject) => {
    _maiaPendingInferences.set(id, { resolve, reject });
    _maiaWorker.postMessage({
      type: 'inference', id, tokens: enc.tokens.buffer, batchSize: 1,
      eloSelfs: Float32Array.from([clamp(self)]).buffer, eloOppos: Float32Array.from([clamp(oppo)]).buffer,
    }, [enc.tokens.buffer]);
  });
  const out = _maiaProcess(fen, res.logitsMove, res.logitsValue, mask);
  // Maia names castling king-to-rook in some mappings; count either spelling.
  const alias = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
  const norm = {};
  for (const [u, pr] of Object.entries(out || {})) norm[alias[u] || u] = (norm[alias[u] || u] || 0) + pr;
  return norm;
}, [fen, self, oppo]);

// The position after one move, and its legal moves, with the app's own rules.
const after = (fen, uci) => page.evaluate(([fen, uci]) => {
  const f = fen.split(' ');
  const bd = parseFenBoard(fen);
  const cst = { wK: f[2].includes('K'), wQ: f[2].includes('Q'), bK: f[2].includes('k'), bQ: f[2].includes('q') };
  const ep = f[3] && f[3] !== '-' ? fileRankToSq(f[3]) : -1;
  const m = uciToSq(uci), p = bd[m.from];
  const next = boardToFen(applyMove(m.from, m.to, bd, ep, m.promo), f[1] === 'w' ? 'b' : 'w',
    updateCastling(m.from, m.to, p, cst), computeEP(m.from, m.to, bd),
    p.piece === 'P' || bd[m.to] ? 0 : (+f[4] || 0) + 1, (+f[5] || 1) + (f[1] === 'b' ? 1 : 0));
  return { fen: next, legal: _fenLegalUcis(next) };
}, [fen, uci]);

const solving = p => {
  let best = 0;
  for (const k in p.moves) best = Math.max(best, p.moves[k][0]);
  return [...new Set([...p.accept, ...Object.keys(p.moves).filter(u => p.moves[u][0] >= best - SLACK)])];
};

const kept = [], why = { forced: 0, premove: 0, exploit: 0 };
for (let i = 0; i < doc.puzzles.length; i++) {
  const p = doc.puzzles[i];
  const premoverRating = p.premoverRating, solverRating = p.solverRating;
  const mine = await probs(p.fen, solverRating, premoverRating);
  if (!mine) throw new Error('Maia returned nothing for ' + p.id);
  const [expected, expectedP] = Object.entries(mine).sort((a, b) => b[1] - a[1])[0];
  const next = await after(p.fen, expected);
  const legal = next.legal.some(u => u.slice(0, 4) === p.premove.slice(0, 4));
  const theirs = legal ? await probs(next.fen, premoverRating, solverRating) : {};
  const premoveP = Object.entries(theirs).filter(([u]) => u.slice(0, 4) === p.premove.slice(0, 4)).reduce((s, [, pr]) => s + pr, 0);
  let best = 0;
  for (const k in p.moves) best = Math.max(best, p.moves[k][0]);
  Object.assign(p, {
    expected, expectedP: Math.round(expectedP * 1000) / 1000, premoveP: Math.round(premoveP * 1000) / 1000,
  });
  if (expectedP < FORCED_MIN) why.forced++;
  else if (premoveP < PREMOVE_MIN) why.premove++;
  else if (best - p.wpRoot < EXPLOIT_MIN) why.exploit++;
  else {
    const m1500 = await probs(p.fen, 1500, 1500);
    p.maia1500 = Math.round(solving(p).reduce((s, u) => s + (m1500[u] || 0), 0) * 1000) / 1000;
    kept.push([p, i]);
  }
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${doc.puzzles.length}: ${kept.length} kept`);
}
await browser.close();

// Stable: equal probabilities keep the input order.
doc.puzzles = kept.sort((a, b) => b[0].maia1500 - a[0].maia1500 || a[1] - b[1]).map(x => x[0]);
doc.order = 'easiest first: Maia 1500 probability of a solving first move';
doc.filter = `Maia at the solver's rating plays one move ≥ ${FORCED_MIN * 100}%, Maia at the premover's rating ` +
  `answers it with the premove ≥ ${PREMOVE_MIN * 100}%, and the trap beats the best honest move by ≥ ${EXPLOIT_MIN} win% points`;
fs.writeFileSync(outPath, JSON.stringify(doc));
const q = doc.puzzles.map(p => p.maia1500);
console.log(`dropped: ${why.forced} not forced, ${why.premove} premove not expected, ${why.exploit} an honest move does as well`);
console.log(`wrote ${outPath}: ${q.length} puzzles` + (q.length ? `, easiest ${q[0]}, median ${q[Math.floor(q.length / 2)]}, hardest ${q[q.length - 1]}` : ''));

// Confounder / Simplifier and Sharp / Drawish (Nov 2026): personality traits
// that score a move by Maia's view of the position it leaves — the opponent's
// entropy there, and Maia's draw chance. The Maia call itself (maia3ChildStats)
// needs the model and runs in the browser; here its result is planted, and the
// real applyMoveAttractors scores against it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FEN = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 30';
const ctx = { document: { getElementById: () => null }, indActive: () => false, console, window: {} };
ctx.uciToSq = function (uci) {
  if (!uci || uci.length < 4) return null;
  return { from: ctx.fileRankToSq(uci.slice(0, 2)), to: ctx.fileRankToSq(uci.slice(2, 4)), promo: uci.length > 4 ? uci[4] : null };
};
ctx.sqToUci = (from, to, promo) => ctx.sqName(from) + ctx.sqName(to) + (promo || '');
vm.createContext(ctx);
const SRC = path.join(__dirname, '..', 'src');
vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
// The live position's FEN, as 40-engines.js writes it (only the first four
// fields are compared).
let liveFen = FEN;
ctx.boardToFen = () => liveFen;

// Four candidates, equally popular. d1d8 mates: no reply to find, no draw.
const STATS = {
  f2f4: { h: 2.0, draw: 0.020 },
  g2g3: { h: 1.0, draw: 0.030 },
  h2h3: { h: 1.5, draw: 0.025 },
  d1d8: { h: 0, draw: 0, terminal: true },
};
const RAW = { f2f4: 0.25, g2g3: 0.25, h2h3: 0.25, d1d8: 0.25 };

function shape(attractors, probed = FEN) {
  ctx.window._bcpAttractorValues = attractors;
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCpBudget = 150;
  ctx.window._bcpCustomControls = [];
  ctx.botPlayerColor = 'black';   // the human's colour: the bot is White
  ctx.botMinProbPct = 0; ctx.botDayLower = 0; ctx.botDayUpper = 100; ctx.botBadDayMode = false;
  ctx.botMoveHistory = []; ctx.gameMovesAlgebraic = new Array(58).fill('x'); ctx.sfCplxEval = null;
  ctx.board = ctx.parseFen(FEN);
  ctx.atkMap = ctx.buildDirectAtk(ctx.board, new Set(), new Set(), new Set(), new Set());
  ctx.__stats = STATS;
  ctx.__key = probed.split(' ').slice(0, 4).join(' ');
  vm.runInContext('_maiaChild = { key: __key, stats: __stats }', ctx);
  const out = ctx.applyMoveAttractors(Object.assign({}, RAW));
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  const share = {};
  for (const m in out) share[m] = out[m] / total;
  return share;
}
const order = s => Object.keys(s).filter(m => m !== 'd1d8').sort((a, b) => s[b] - s[a]);

test('Confounder favours the move that leaves the opponent the most playable replies', () => {
  assert.deepStrictEqual(order(shape({ entropy: 5 })), ['f2f4', 'h2h3', 'g2g3']);
});

test('Simplifier favours the move that leaves one obvious reply', () => {
  assert.deepStrictEqual(order(shape({ entropy: -5 })), ['g2g3', 'h2h3', 'f2f4']);
});

test('Sharp favours the lowest draw chance; Drawish the highest', () => {
  assert.deepStrictEqual(order(shape({ sharpness: 5 })), ['f2f4', 'h2h3', 'g2g3']);
  assert.deepStrictEqual(order(shape({ sharpness: -5 })), ['g2g3', 'h2h3', 'f2f4']);
});

test('a move that ends the game scores neutral, as the average candidate does', () => {
  // h2h3 sits at the candidates' average entropy (1.5), so it is not moved either.
  for (const v of [5, -5]) {
    const s = shape({ entropy: v });
    assert.ok(Math.abs(s.d1d8 - s.h2h3) < 1e-9, v + ': mate ' + s.d1d8 + ' vs average ' + s.h2h3);
  }
});

test('a position Maia was not asked about (a premove\'s, say) scores neutral', () => {
  const s = shape({ entropy: 5, sharpness: 5 }, '8/8/8/8/8/8/8/K6k w - - 0 1');
  for (const m in s) assert.ok(Math.abs(s[m] - 0.25) < 1e-9, m + ' ' + s[m]);
});

test('the push is held by the CP Budget, like every other trait', () => {
  // At Budget 150 the whole personality is worth one log unit, so the most a
  // single trait can tilt two moves apart is e^(2 × 150 / 150) = e².
  const s = shape({ entropy: 5 });
  assert.ok(s.f2f4 / s.g2g3 > 1.5 && s.f2f4 / s.g2g3 < Math.exp(2) + 1e-9, 'ratio ' + (s.f2f4 / s.g2g3).toFixed(3));
});

test('only the two traits turn the Maia look on; it asks the most popular moves, to 90% or 8', () => {
  ctx.window._bcpAttractorValues = { complexity: 3 };
  assert.strictEqual(ctx.botUsesMaiaChild(), false);
  ctx.window._bcpAttractorValues = { sharpness: -1 };
  assert.strictEqual(ctx.botUsesMaiaChild(), true);
  assert.deepStrictEqual([...ctx._maiaChildOrder({ a: 0.6, b: 0.25, c: 0.1, d: 0.05 })], ['a', 'b', 'c']);
  const many = {};
  for (let i = 0; i < 20; i++) many['m' + i] = 1 / 20;
  assert.strictEqual(ctx._maiaChildOrder(many).length, 8);
});

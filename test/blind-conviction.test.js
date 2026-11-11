// Tests for Blind Conviction in src/50-bot-engine.js — the personality alone
// ranks the moves the Move Distribution Range lets through (blindConvictionOrder)
// and the bot plays its favourite within the CP Budget of the most popular move
// (blindConvictionPick) — and for the Range itself, whose upper handle used to
// cut the wrong end (_distributionBand).
//
// Same vm approach as move-pick.test.js: the chess core and the bot engine in
// one shared scope, with only the engine probe stubbed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EMPTY = new Set();

function makeCtx() {
  const ctx = {
    console: { log() {}, warn: console.warn },
    window: {},
    document: { getElementById: () => null },
    indActive: () => false,
    setTimeout: (fn) => fn(),
  };
  ctx.uciToSq = (uci) => (!uci || uci.length < 4) ? null
    : { from: ctx.fileRankToSq(uci.slice(0, 2)), to: ctx.fileRankToSq(uci.slice(2, 4)),
        promo: uci.length > 4 ? uci[4] : null };
  ctx.sqToUci = (from, to, promo) => ctx.sqName(from) + ctx.sqName(to) + (promo || '');
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  // The app shell's globals the Range and the attractors read.
  ctx.botMinProbPct = 0;
  ctx.botDayLower = 0;
  ctx.botDayUpper = 100;
  ctx.botBadDayMode = false;
  ctx.window._bcpAttractorValues = {};
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCustomControls = [];
  ctx.window._bcpCpBudget = 100;
  return ctx;
}

// The bot is White in the start position.
function atStart(ctx) {
  ctx.botPlayerColor = 'black';   // the HUMAN's colour
  ctx.botMoveHistory = [];
  ctx.gameMovesAlgebraic = [];
  ctx.sfCplxEval = null;
  ctx.board = ctx.parseFen(START);
  ctx.atkMap = ctx.buildDirectAtk(ctx.board, EMPTY, EMPTY, EMPTY, EMPTY);
}

function stubProbe(ctx, evals) {
  ctx.sfReady = true;
  ctx.probes = 0;
  ctx.sfEvalMoves = async (fen, moves) => {
    ctx.probes++;
    if (evals === null) return null;
    return Object.fromEntries(moves.map(m => [m, evals[m] != null ? evals[m] : 0]));
  };
}

const keys = o => Object.keys(o).sort();
const PROBS = { e2e4: 0.5, d2d4: 0.3, c2c4: 0.15, g1f3: 0.05 };

// ── The Move Distribution Range ───────────────────────────────────────────────

test('the Range: lowering "Exclude moves above" cuts the mainstream end', () => {
  const ctx = makeCtx();
  ctx.botDayUpper = 40;
  // Rarest first: g1f3 0–5%, c2c4 5–20%, d2d4 20–50%, e2e4 50–100%.
  assert.deepEqual(keys(ctx._distributionBand(PROBS, 0)), ['c2c4', 'd2d4', 'g1f3']);
});

test('the Range: raising "Exclude lowest" cuts the rare end', () => {
  const ctx = makeCtx();
  ctx.botDayLower = 60;
  assert.deepEqual(keys(ctx._distributionBand(PROBS, 0)), ['e2e4']);
});

test('the Range: a Good day still shifts toward the mainstream', () => {
  const ctx = makeCtx();
  // luck +3 trims the rarest 12% — the same moves it trimmed before the fix.
  assert.deepEqual(keys(ctx._distributionBand(PROBS, 3)), ['c2c4', 'd2d4', 'e2e4']);
});

test('the Range: at its defaults every move stays', () => {
  assert.deepEqual(keys(makeCtx()._distributionBand(PROBS, 0)), keys(PROBS));
});

// ── Ranking ───────────────────────────────────────────────────────────────────

test('Blind Conviction is off by default', () => {
  assert.equal(makeCtx().botBlindConviction, false);
});

test('no personality: every move ties, so the order is Maia\'s', () => {
  const ctx = makeCtx();
  atStart(ctx);
  assert.deepEqual(ctx.blindConvictionOrder(PROBS), ['e2e4', 'd2d4', 'c2c4', 'g1f3']);
});

test('the Range\'s floor decides what is a candidate', () => {
  const ctx = makeCtx();
  atStart(ctx);
  ctx.botMinProbPct = 10;
  assert.deepEqual(ctx.blindConvictionOrder(PROBS), ['e2e4', 'd2d4', 'c2c4']);
});

test('a move the personality loves comes first however rare it is', () => {
  const ctx = makeCtx();
  atStart(ctx);
  ctx.window._bcpPieceValues = { knight: 1 };
  const probs = { e2e4: 0.97, d2d4: 0.0299, g1h3: 0.0001 };
  // Ordinary conviction cannot reach it: e^(100/150) is no match for 9700x.
  const shaped = ctx.applyMoveAttractors(probs);
  assert.ok(shaped.e2e4 > shaped.g1h3, 'the popular move still tops the shaped distribution');
  // Blind: the knight move first, then the rest in Maia's order.
  assert.deepEqual(ctx.blindConvictionOrder(probs), ['g1h3', 'e2e4', 'd2d4']);
});

// ── The pick ──────────────────────────────────────────────────────────────────

test('the favourite is played when it is within the Budget', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -80 });
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'e2e4', 'd2d4'], false), 'g1f3');
  assert.equal(vm.runInContext('_cpBudgetVerifiedThisMove', ctx), true, 'the Hard Floor need not look again');
});

test('over the Budget: the next favourite within it, not the popular move', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -300, c2c4: -60 });
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'c2c4', 'e2e4'], false), 'c2c4');
});

test('a favourite better than the popular move is played', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, c2c4: 400 });
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['c2c4', 'e2e4'], false), 'c2c4');
});

test('Budget 0: only moves at least as good as the popular one', async () => {
  const ctx = makeCtx();
  ctx.window._bcpCpBudget = 0;
  stubProbe(ctx, { e2e4: 0, g1f3: -10, c2c4: 0 });
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'c2c4', 'e2e4'], false), 'c2c4');
});

test('the popular move as favourite costs no engine time', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, {});
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['e2e4', 'd2d4'], false), 'e2e4');
  assert.equal(ctx.probes, 0);
});

test('scores already in hand (Flounder\'s probe) are used, not probed again', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, {});
  const evals = { e2e4: 0, g1f3: -50 };
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'e2e4'], false, evals), 'g1f3');
  assert.equal(ctx.probes, 0);
});

test('an unchecked favourite is never played: the popular move, or no premove', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, null);   // the engine is busy
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'e2e4'], false), 'e2e4');
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'e2e4'], true), null);
});

test('the shared pick routes to Blind Conviction when it is on', async () => {
  const ctx = makeCtx();
  atStart(ctx);
  ctx.window._bcpPieceValues = { knight: 1 };
  ctx.botBlindConviction = true;
  stubProbe(ctx, { e2e4: 0, g1h3: -40 });
  const probs = { e2e4: 0.97, d2d4: 0.0299, g1h3: 0.0001 };
  assert.equal(await ctx.botPickFromProbs('fen', probs, 1.0), 'g1h3');
});

// ── The Choice mix ────────────────────────────────────────────────────────────

const ORDER4 = ['g1f3', 'c2c4', 'e2e4', 'd2d4'];
const EVALS4 = { e2e4: 0, g1f3: -80, c2c4: -60, d2d4: -20 };   // all four within 100
const rolls = (ctx, ...seq) => {
  ctx.rollSeq = seq;
  vm.runInContext('Math.random = () => rollSeq.length ? rollSeq.shift() : 0.5;', ctx);
};

test('a bot without a mix plays its favourite every move, as before the mix', () => {
  const ctx = makeCtx();
  assert.deepEqual(vm.runInContext('botBlindChoicePcts', ctx), [100, 0, 0, 0]);
  assert.deepEqual(ctx.blindChoicePctsFrom(undefined), [100, 0, 0, 0]);
  assert.deepEqual(ctx.blindChoicePctsFrom([0, 0, 0, 0]), [100, 0, 0, 0], 'all 0 is the favourite');
  assert.deepEqual(ctx.blindChoicePctsFrom([60, 20, 15, 5]), [60, 20, 15, 5]);
  assert.deepEqual(ctx.blindChoicePctsFrom([150, -3, 'x', 5, 9]), [100, 0, 0, 5], 'clamped, four shares');
});

test('the mix: a roll past the favourite plays the next choice within the Budget', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, EVALS4);
  rolls(ctx, 0.65);   // 65 of 100: past the favourite's 60, inside the second's 20
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ORDER4, false), 'c2c4');
  rolls(ctx, 0.97);   // the fourth's 5
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ORDER4, false), 'd2d4');
  assert.equal(vm.runInContext('_cpBudgetVerifiedThisMove', ctx), true);
});

test('the mix counts only moves within the Budget', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, Object.assign({}, EVALS4, { g1f3: -300 }));   // the favourite is over it
  rolls(ctx, 0.1);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ORDER4, false), 'c2c4', 'first within the Budget');
  rolls(ctx, 0.65);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ORDER4, false), 'e2e4', 'second within it');
});

test('a choice past the moves within the Budget rolls again among those there are', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, { e2e4: 0, g1f3: -50, c2c4: -60, d2d4: -500 });
  // Only g1f3 and e2e4 are within 100 in this order; a roll for the third
  // choice rolls again over 60:20.
  rolls(ctx, 0.9, 0.8);   // third; then 64 of 80, the second
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['g1f3', 'd2d4', 'e2e4'], false), 'e2e4');
});

test('the favourite that is the popular move still costs no engine time; another choice is checked', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, { e2e4: 0, d2d4: -10, c2c4: -20 });
  rolls(ctx, 0.3);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['e2e4', 'd2d4', 'c2c4'], false), 'e2e4');
  assert.equal(ctx.probes, 0);
  rolls(ctx, 0.7);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['e2e4', 'd2d4', 'c2c4'], false), 'd2d4');
  assert.equal(ctx.probes, 1);
});

test('an unchecked choice is never played under the mix either', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, null);
  rolls(ctx, 0.7);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['e2e4', 'd2d4'], false), 'e2e4', 'the popular move');
  rolls(ctx, 0.7);
  assert.equal(await ctx.blindConvictionPick('fen', PROBS, ['e2e4', 'd2d4'], true), null, 'or no premove');
});

test('played over many moves: 60/20/15/5, and 75/25 when only two are within the Budget', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  const N = 6000;
  const share = async (evals, order) => {
    stubProbe(ctx, evals);
    const n = {};
    for (let i = 0; i < N; i++) { const m = await ctx.blindConvictionPick('fen', PROBS, order, false); n[m] = (n[m] || 0) + 1; }
    return Object.fromEntries(Object.entries(n).map(([m, c]) => [m, c / N]));
  };
  const four = await share(EVALS4, ORDER4);
  [['g1f3', 0.6], ['c2c4', 0.2], ['e2e4', 0.15], ['d2d4', 0.05]].forEach(([m, p]) =>
    assert.ok(Math.abs((four[m] || 0) - p) < 0.025, m + ' ' + four[m] + ' vs ' + p));
  const two = await share({ e2e4: 0, g1f3: -50, d2d4: -500 }, ['g1f3', 'd2d4', 'e2e4']);
  assert.ok(Math.abs((two.g1f3 || 0) - 0.75) < 0.025 && Math.abs((two.e2e4 || 0) - 0.25) < 0.025, JSON.stringify(two));
});

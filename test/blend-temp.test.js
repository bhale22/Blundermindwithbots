// Tests for Temp (botBlendTemp in src/50-bot-engine.js), the Lichess chat's
// one dial from Maia alone to the personality alone. Among the candidates
// Blind Conviction would have, the bot blends popularity × personality^(2T):
// T/10 of its moves are picked from the top of the blend by the Choice mix,
// the rest drawn from it at random, and the CP Budget still decides which
// moves may be played:
//   temp 0     Maia's top move, every time;
//   temp 0.01  Maia's distribution, near enough;
//   temp 9.9   the personality leads, popularity still counting;
//   temp 10    Blind Conviction: the personality's order and the Choice mix.
//
// Same vm approach as blind-conviction.test.js.

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
  ctx.botMinProbPct = 0;
  ctx.botDayLower = 0;
  ctx.botDayUpper = 100;
  ctx.botBadDayMode = false;
  ctx.window._bcpAttractorValues = {};
  // A personality that loves knight moves: e^1 at full strength.
  ctx.window._bcpPieceValues = { knight: 1 };
  ctx.window._bcpCustomControls = [];
  ctx.window._bcpCpBudget = 150;
  // The bot is White in the start position.
  ctx.botPlayerColor = 'black';   // the HUMAN's colour
  ctx.botMoveHistory = [];
  ctx.gameMovesAlgebraic = [];
  ctx.sfCplxEval = null;
  ctx.board = ctx.parseFen(START);
  ctx.atkMap = ctx.buildDirectAtk(ctx.board, EMPTY, EMPTY, EMPTY, EMPTY);
  return ctx;
}

function stubProbe(ctx, evals) {
  ctx.sfReady = true;
  ctx.probes = 0;
  ctx.sfEvalMoves = async (fen, moves) => {
    ctx.probes++;
    return Object.fromEntries(moves.map(m => [m, evals[m] != null ? evals[m] : 0]));
  };
}
const rolls = (ctx, ...seq) => {
  ctx.rollSeq = seq;
  vm.runInContext('Math.random = () => rollSeq.length ? rollSeq.shift() : 0.5;', ctx);
};

// The knight move is the second most popular, 1.67x (0.51 log units) behind:
// the personality's e^1, doubled and times T, overturns that at 0.5, not 0.1.
const NEAR = { e2e4: 0.5, g1f3: 0.3, d2d4: 0.15, c2c4: 0.05 };
// Here it is 5x (1.61) behind: overturned at 1, not at 0.5.
const FAR = { e2e4: 0.5, d2d4: 0.3, g1f3: 0.1, c2c4: 0.1 };
const order = (ctx, t, probs) => { ctx.botBlendTemp = t; return ctx.blindConvictionOrder(probs); };

// What the bot plays over N moves, as shares.
async function shares(ctx, probs, N) {
  const n = {};
  for (let i = 0; i < N; i++) { const m = await ctx.blindConvictionMove('fen', probs, false); n[m] = (n[m] || 0) + 1; }
  for (const m in n) n[m] /= N;
  return n;
}

test('Temp is off by default, and the bot picks as it was built', () => {
  const ctx = makeCtx();
  assert.equal(ctx.botBlendTemp, null);
  assert.equal(ctx._blindPicks(), false);
  assert.equal(ctx.blindConvictionPlan(NEAR).blend, null, 'nothing to draw from');
});

// ── The ranking ───────────────────────────────────────────────────────────────

test('temp 0: Maia\'s order, whatever the personality loves', () => {
  const ctx = makeCtx();
  assert.deepEqual(order(ctx, 0, NEAR), ['e2e4', 'g1f3', 'd2d4', 'c2c4']);
});

test('temp 10: Blind Conviction\'s order', () => {
  const ctx = makeCtx();
  const blind = ctx.blindConvictionOrder(FAR);   // Temp off: Blind Conviction's own ranking
  assert.equal(blind[0], 'g1f3');
  assert.deepEqual(order(ctx, 10, FAR), blind);
  assert.deepEqual(order(ctx, 50, FAR), blind, 'past 10 is still 10');
  assert.equal(ctx.blindConvictionPlan(FAR).blend, null, 'and nothing is drawn');
});

test('between: the higher the Temp, the bigger the popularity gap the personality overturns', () => {
  const ctx = makeCtx();
  assert.equal(order(ctx, 0.1, NEAR)[0], 'e2e4', '0.1: a 1.67x gap holds');
  assert.equal(order(ctx, 0.5, NEAR)[0], 'g1f3', '0.5: a 1.67x gap is overturned');
  assert.equal(order(ctx, 0.5, FAR)[0], 'e2e4', '0.5: a 5x gap holds');
  assert.equal(order(ctx, 1, FAR)[0], 'g1f3', '1: a 5x gap is overturned');
});

test('9.9 is not Blind Conviction: popularity still counts', () => {
  const ctx = makeCtx();
  // The knight move is a billion times rarer than e2e4: 20.7 log units, more
  // than the personality's 1 doubled and times 9.9. At 10 popularity only
  // breaks ties.
  const RARE = { e2e4: 0.98, d2d4: 0.019999999, g1h3: 0.000000001 };
  assert.deepEqual(order(ctx, 9.9, RARE), ['e2e4', 'g1h3', 'd2d4']);
  assert.deepEqual(order(ctx, 10, RARE), ['g1h3', 'e2e4', 'd2d4']);
});

test('the CP Budget does not change the ranking, only what may be played', () => {
  const ctx = makeCtx();
  ctx.window._bcpCpBudget = 30;    // at the bot's own Budget the knight would get e^0.2, too little
  assert.equal(order(ctx, 0.5, NEAR)[0], 'g1f3');
  ctx.window._bcpCpBudget = 300;   // ...and e^2 here, enough for the 5x gap
  assert.equal(order(ctx, 0.5, FAR)[0], 'e2e4');
});

test('the Range\'s floor still decides what is a candidate', () => {
  const ctx = makeCtx();
  ctx.botMinProbPct = 12;
  assert.deepEqual(order(ctx, 10, FAR), ['e2e4', 'd2d4']);
  assert.deepEqual(Object.keys(ctx.blindConvictionPlan(FAR).blend || {}).sort(), [],
    'at 10 there is no blend');
  ctx.botBlendTemp = 1;
  assert.deepEqual(Object.keys(ctx.blindConvictionPlan(FAR).blend).sort(), ['d2d4', 'e2e4'], 'nor anything to draw past it');
});

// ── The pick ──────────────────────────────────────────────────────────────────

test('temp 0 plays the top move every time: no Choice mix, no engine time', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [0, 100, 0, 0];', ctx);   // always the second choice
  stubProbe(ctx, {});
  ctx.botBlendTemp = 0;
  for (let i = 0; i < 20; i++) assert.equal(await ctx.blindConvictionMove('fen', NEAR, false), 'e2e4');
  assert.equal(ctx.probes, 0);
});

test('temp 0.01: Maia\'s distribution, near enough', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, { e2e4: 0, g1f3: -10, d2d4: -10, c2c4: -10 });
  ctx.botBlendTemp = 0.01;
  const s = await shares(ctx, NEAR, 6000);
  for (const m in NEAR) assert.ok(Math.abs((s[m] || 0) - NEAR[m]) < 0.02, m + ' ' + s[m] + ' vs ' + NEAR[m]);
});

test('temp 1: a tenth by the ranking, the rest drawn from popularity × personality squared', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [60, 20, 15, 5];', ctx);
  stubProbe(ctx, { e2e4: 0, g1f3: -10, d2d4: -10, c2c4: -10 });
  ctx.botBlendTemp = 1;
  // The blend: the knight move ×e², the rest as Maia has them.
  const q = { e2e4: 0.5, g1f3: 0.3 * Math.exp(2), d2d4: 0.15, c2c4: 0.05 };
  const qs = Object.values(q).reduce((a, b) => a + b, 0);
  // Its order g1f3, e2e4, d2d4, c2c4, picked 60/20/15/5.
  const ranked = { g1f3: 0.6, e2e4: 0.2, d2d4: 0.15, c2c4: 0.05 };
  const s = await shares(ctx, NEAR, 8000);
  for (const m in q) {
    const want = 0.1 * ranked[m] + 0.9 * q[m] / qs;
    assert.ok(Math.abs((s[m] || 0) - want) < 0.02, m + ' ' + s[m] + ' vs ' + want);
  }
});

test('a draw keeps to the Budget: one past it is drawn again from those within', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -200, d2d4: -10, c2c4: -10 });
  ctx.botBlendTemp = 1;
  const s = await shares(ctx, NEAR, 2000);
  assert.equal(s.g1f3 || 0, 0, 'the loved move is past the Budget, so never played');
  assert.ok(s.d2d4 > 0 && s.c2c4 > 0, 'and the others still are drawn: ' + JSON.stringify(s));
});

test('drawing the most popular move costs no engine time; drawing another is checked', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -10, d2d4: -10, c2c4: -10 });
  ctx.botBlendTemp = 0.01;
  const plan = ctx.blindConvictionPlan(NEAR);
  assert.deepEqual(plan.order, ['e2e4', 'g1f3', 'd2d4', 'c2c4']);
  rolls(ctx, 0.5, 0);        // 0.5 × 10 ≥ 0.01: a draw; then the first move in the blend
  assert.equal(await ctx.blindConvictionPick('fen', NEAR, plan.order, false, undefined, plan.blend), 'e2e4');
  assert.equal(ctx.probes, 0);
  rolls(ctx, 0.5, 0.9999);   // a draw, the last move in the blend
  assert.equal(await ctx.blindConvictionPick('fen', NEAR, plan.order, false, undefined, plan.blend), 'c2c4');
  assert.equal(ctx.probes, 1);
  assert.equal(vm.runInContext('_cpBudgetVerifiedThisMove', ctx), true);
});

test('temp 10 plays the mix as built, never a draw', async () => {
  const ctx = makeCtx();
  vm.runInContext('botBlindChoicePcts = [0, 100, 0, 0];', ctx);   // always the second choice
  stubProbe(ctx, { e2e4: 0, g1f3: -80, c2c4: -60, d2d4: -20 });
  ctx.botBlendTemp = 10;
  for (let i = 0; i < 20; i++) assert.equal(await ctx.blindConvictionMove('fen', FAR, false), 'e2e4');
});

test('the Budget still rules the ranking: a favourite past it gives way', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -200 });
  ctx.botBlendTemp = 1;
  assert.equal(await ctx.blindConvictionPick('fen', NEAR, ctx.blindConvictionOrder(NEAR), false), 'e2e4');
});

test('a Temp sends a bot built without Blind Conviction the Blind Conviction way', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, g1f3: -20 });
  assert.equal(ctx.botBlindConviction, false);
  ctx.botBlendTemp = 10;
  assert.equal(ctx._blindPicks(), true);
  assert.equal(await ctx.botPickFromProbs('fen', FAR, 1.0), 'g1f3');
  ctx.botBlendTemp = 0;
  assert.equal(await ctx.botPickFromProbs('fen', FAR, 1.0), 'e2e4');
});

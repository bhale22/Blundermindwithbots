// Tests for how a move is picked from the shaped distribution in
// src/50-bot-engine.js: the Conviction share (pickFromProbs) and the
// "never play better than the most popular move" switch
// (applyDegradationEvalGuard). Both used to be fixed — 30% argmax, check always
// on — so a Maia bot at T 1.0 could not sample Maia's distribution as it is.
//
// Same vm approach as bot-premove.test.js: the chess core and the bot engine in
// one shared scope, with only the engine probe stubbed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx() {
  const ctx = {
    console,
    window: {},
    document: { getElementById: () => null },
    indActive: () => false,
    setTimeout: (fn) => fn(),
    Math: Object.create(Math),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  return ctx;
}

// How often each move comes out of pickFromProbs over n draws.
function pickShares(ctx, probs, T, n) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const m = ctx.pickFromProbs(probs, T);
    counts[m] = (counts[m] || 0) + 1;
  }
  const out = {};
  for (const m in probs) out[m] = (counts[m] || 0) / n;
  return out;
}

const PROBS = { e2e4: 0.4, d2d4: 0.35, c2c4: 0.25 };
const N = 40000;
const TOL = 0.015;

// ── Conviction ───────────────────────────────────────────────────────────────

test('Conviction defaults to 0% — every move sampled', () => {
  assert.equal(makeCtx().botConvictionPct, 0);
});

test('Conviction 0% at T 1.0 plays each move as often as the distribution says', () => {
  const ctx = makeCtx();
  ctx.botConvictionPct = 0;
  const s = pickShares(ctx, PROBS, 1.0, N);
  for (const m in PROBS) {
    assert.ok(Math.abs(s[m] - PROBS[m]) < TOL,
      m + ' played ' + s[m].toFixed(3) + ', distribution says ' + PROBS[m]);
  }
});

test('Conviction 100% always plays the top of the distribution', () => {
  const ctx = makeCtx();
  ctx.botConvictionPct = 100;
  const s = pickShares(ctx, PROBS, 1.0, 2000);
  assert.equal(s.e2e4, 1);
});

test('Conviction c plays the top move c + (1 - c) x its probability of the time', () => {
  const ctx = makeCtx();
  ctx.botConvictionPct = 30;
  const s = pickShares(ctx, PROBS, 1.0, N);
  // The builder chart's "Played" bar draws exactly this mix (_convictionMix).
  assert.ok(Math.abs(s.e2e4 - (0.3 + 0.7 * 0.4)) < TOL, 'top ' + s.e2e4.toFixed(3));
  assert.ok(Math.abs(s.d2d4 - 0.7 * 0.35) < TOL, 'second ' + s.d2d4.toFixed(3));
});

// ── Never play better than the most popular move ─────────────────────────────

function stubProbe(ctx, evals) {
  ctx.sfReady = true;
  ctx.probes = 0;
  ctx.sfEvalMoves = async (fen, moves) => {
    ctx.probes++;
    return Object.fromEntries(moves.map(m => [m, evals[m] != null ? evals[m] : 0]));
  };
}

test('the no-upgrade check is off by default', () => {
  assert.equal(makeCtx().botNoUpgradeGuard, false);
});

test('switched off, a sampled move that beats the popular one is played, unprobed', async () => {
  const ctx = makeCtx();
  stubProbe(ctx, { e2e4: 0, c2c4: 150 });
  const pick = await ctx.applyDegradationEvalGuard('fen', 'c2c4', PROBS);
  assert.equal(pick, 'c2c4');
  assert.equal(ctx.probes, 0, 'nothing to check, so no engine time');
});

test('switched on, a sampled move that beats the popular one is swapped back', async () => {
  const ctx = makeCtx();
  ctx.botNoUpgradeGuard = true;
  stubProbe(ctx, { e2e4: 0, c2c4: 150 });
  const pick = await ctx.applyDegradationEvalGuard('fen', 'c2c4', PROBS);
  assert.equal(pick, 'e2e4');
});

test('switched on, a sampled move no better than the popular one stands', async () => {
  const ctx = makeCtx();
  ctx.botNoUpgradeGuard = true;
  stubProbe(ctx, { e2e4: 0, c2c4: -40 });
  const pick = await ctx.applyDegradationEvalGuard('fen', 'c2c4', PROBS);
  assert.equal(pick, 'c2c4');
});

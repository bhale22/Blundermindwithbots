// Acceptance tests for the closed-form Curve A default: the Regan time–rating
// model (elo-degradation-brief.md). Loads 20-chess-core.js + 50-bot-engine.js
// into one vm context (same trick as custom-controls.test.js) and checks the
// brief's §4 reference vectors and §7 acceptance criteria against the real
// engine functions.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  document: { getElementById: () => null },
  indActive: () => false,
  console,
  window: {},
  // Globals normally declared in 10-app-shell.js / 40-engines.js
  maia3SelectedRating: 1500,
  botPressureReganA: null,
  botPressureCurveA: null,
  botPressureCurveB: null,
};
vm.createContext(ctx);

const SRC = path.join(__dirname, '..', 'src');
vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
vm.runInContext(
  fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8') +
    '\nthis._reganDegradation = reganDegradation;' +
    '\nthis._reganEffectiveElo = reganEffectiveElo;' +
    '\nthis._reganSlotElo = reganSlotElo;' +
    '\nthis._pressureEffectiveMaiaEloByThink = pressureEffectiveMaiaEloByThink;' +
    '\nthis._pressureSlotEloByThink = pressureSlotEloByThink;',
  ctx
);

// Brief §2 constants, anchored for 1500 @ 15+0 (anchorSec = 900/60 + 0 = 15)
const P = { c: 339, k: 1442, alpha: 0.283, anchorSec: 15 };
const rawElo = (e0, s) =>
  e0 + ctx._reganDegradation(s, P) - ctx._reganDegradation(P.anchorSec, P);

// ── §4 reference vectors — 1500 @ 15+0 ───────────────────────────────────────

test('unclamped effective ELO matches the §4 vectors to ±0.5', () => {
  const vectors = [
    [15, 1500.0], [10, 1418.5], [5, 1255.6], [2.5, 1057.5],
    [1, 728.1], [0.75, 605.8], [0.5, 415.6], [0.1, -596.6],
  ];
  for (const [s, expected] of vectors) {
    const raw = rawElo(1500, s);
    assert.ok(Math.abs(raw - expected) <= 0.5,
      `thinkSec ${s}: raw ${raw.toFixed(1)} vs expected ${expected}`);
  }
});

test('clamped effective ELO matches the §4 clamped column', () => {
  const vectors = [
    [15, 1500], [10, 1419], [5, 1256], [2.5, 1057],
    [1, 728], [0.75, 606], [0.5, 600], [0.1, 600],
  ];
  for (const [s, expected] of vectors) {
    assert.equal(ctx._reganEffectiveElo(1500, s, P), expected, `thinkSec ${s}`);
  }
});

// ── §7 acceptance criteria ───────────────────────────────────────────────────

test('criterion 1: effectiveELO(anchorSec) = E0 exactly for any time control', () => {
  // 15+0 → 15 s, 5+3 → 8 s, 3+0 → 3 s, 1+0 → 1 s
  for (const anchor of [15, 8, 3, 1]) {
    const p = { ...P, anchorSec: anchor };
    for (const e0 of [800, 1500, 2400]) {
      assert.equal(ctx._reganEffectiveElo(e0, anchor, p), e0,
        `anchor ${anchor}, E0 ${e0}`);
    }
  }
});

test('criterion 2: monotonically non-increasing as thinkSec shrinks; never above E0', () => {
  const grid = [500, 165, 60, 30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.01];
  let prev = Infinity;
  for (const s of grid) {
    const v = ctx._reganEffectiveElo(1500, s, P);
    assert.ok(v <= prev, `not monotone at ${s}: ${v} > ${prev}`);
    assert.ok(v <= 1500, `above E0 at ${s}`);
    prev = v;
  }
});

test('criterion 4: clamps to [600, 2600] and survives thinkSec <= 0', () => {
  assert.equal(ctx._reganEffectiveElo(1500, 0, P), 600);       // floored at 0.05 s
  assert.equal(ctx._reganEffectiveElo(1500, -3, P), 600);
  assert.equal(ctx._reganEffectiveElo(5000, 1000, P), 2600);   // E0 capped at Maia max
  assert.equal(ctx._reganEffectiveElo(100, 1000, P), 600);     // E0 floored at Maia min
});

test('criterion 5: hybrid slots take identical absolute drops at equal thinkSec', () => {
  const dropOf = (slotElo, s) => slotElo - ctx._reganSlotElo(slotElo, s, P);
  for (const s of [10, 5, 2.5, 1]) {
    const d = dropOf(2400, s);
    assert.ok(d > 0, `no drop at ${s}`);
    assert.equal(dropOf(1800, s), d, `slot drops differ at thinkSec ${s}`);
  }
  // No drop at or above the anchor (degradation only)
  assert.equal(dropOf(2400, 15), 0);
  assert.equal(dropOf(2400, 165), 0);
});

// ── Engine wiring: closed form takes precedence, spline still works ──────────

test('pressure fns use the Regan closed form when botPressureReganA is set', () => {
  ctx.botPressureReganA = { ...P };
  ctx.botPressureCurveA = [{ x: 0.1, y: 1500 }, { x: 1000, y: 1500 }]; // flat decoy
  ctx.maia3SelectedRating = 1500;
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(5), 1256);   // closed form, not 1500
  assert.equal(ctx._pressureSlotEloByThink(1800, 15), 1800);
  assert.ok(ctx._pressureSlotEloByThink(1800, 5) < 1800);
  ctx.botPressureReganA = null;
  ctx.botPressureCurveA = null;
});

test('spline fallback unchanged when botPressureReganA is null', () => {
  ctx.botPressureReganA = null;
  ctx.botPressureCurveA = [{ x: 1, y: 900 }, { x: 100, y: 1500 }];
  ctx.maia3SelectedRating = 1500;
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(1), 900);
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(100), 1500);
  const mid = ctx._pressureEffectiveMaiaEloByThink(10);          // log-x midpoint
  assert.ok(mid > 1150 && mid < 1250, `log-x interpolation off: ${mid}`);
  ctx.botPressureCurveA = null;
});

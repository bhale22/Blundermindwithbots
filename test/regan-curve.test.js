// Curve A default: draggable spline SEEDED on the Regan time–rating model
// (elo-degradation-brief.md). The panel seeds 8 control points on
// D(s) = 339 − 1442·s^(−0.283) anchored at the time control's pace; the engine
// always evaluates the spline (evalPressureCurve, log-x linear interpolation).
// This test mirrors the panel's seeding and checks the engine's behavior on
// the seeded default shape.

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
  botPressureCurveA: null,
  botPressureCurveB: null,
};
vm.createContext(ctx);

const SRC = path.join(__dirname, '..', 'src');
vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
vm.runInContext(
  fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8') +
    '\nthis._evalPressureCurve = evalPressureCurve;' +
    '\nthis._pressureEffectiveMaiaEloByThink = pressureEffectiveMaiaEloByThink;' +
    '\nthis._pressureSlotEloByThink = pressureSlotEloByThink;',
  ctx
);

// ── Mirror of the panel's Curve A seeding (bot-control-panel.html) ───────────
const REGAN = { C: 339, K: 1442, ALPHA: 0.283, SMIN: 0.05 };
const D = (s) => REGAN.C - REGAN.K * Math.pow(Math.max(REGAN.SMIN, s), -REGAN.ALPHA);
const reganElo = (e0, anchor, t) =>
  Math.max(600, Math.min(e0, Math.round(e0 + D(t) - D(anchor))));

const X_MIN = 1, X_MAX = 1000;
function buildXs() {
  const n = 120, xs = [];
  const logMax = Math.log10(X_MAX), logMin = Math.log10(X_MIN);
  for (let i = 0; i <= n; i++) xs.push(+(Math.pow(10, logMax - (logMax - logMin) * (i / n))).toFixed(4));
  return xs;
}
function seedCurveA(e0, anchorRaw) {
  const anchor = Math.max(1.001, Math.min(X_MAX / 2, anchorRaw));
  const xsA = [X_MAX, anchor];
  const steps = 5, r = Math.pow(X_MIN / anchor, 1 / (steps + 1));
  for (let k = 1; k <= steps; k++) xsA.push(anchor * Math.pow(r, k));
  xsA.push(X_MIN);
  return xsA.map(x => ({ x: +x.toFixed(3), y: reganElo(e0, anchorRaw, x) }));
}

// Default TC in the panel is 30+0 → anchorSec 30; 15+0 → 15
test('seeded points lie on the Regan curve and pass through E0 at the anchor', () => {
  const pts = seedCurveA(1500, 15);
  for (const p of pts) assert.equal(p.y, reganElo(1500, 15, p.x), `knot at ${p.x}s`);
  // Everything at or slower than the anchor is exactly E0 (degradation-only)
  for (const p of pts.filter(p => p.x >= 15)) assert.equal(p.y, 1500);
  assert.equal(pts[pts.length - 1].x, 1);          // fastest knot at the 1 s chart edge
  assert.ok(pts.filter(p => p.x < 15).length >= 5, 'dense sampling in the dive region');
});

test('engine spline reproduces the seeded shape (exact at knots, close between)', () => {
  const pts = seedCurveA(1500, 15);
  ctx.botPressureCurveA = pts;
  ctx.maia3SelectedRating = 1500;
  for (const p of pts) {
    assert.equal(ctx._pressureEffectiveMaiaEloByThink(p.x), p.y, `knot ${p.x}s`);
  }
  // Between knots, log-x linear interpolation stays within a few ELO of the
  // true power law (the anchor knot removes the corner-cutting at the kink)
  for (const s of [12, 10, 5, 2.5, 1.8, 1.2]) {
    const spline = ctx._pressureEffectiveMaiaEloByThink(s);
    const model = reganElo(1500, 15, s);
    assert.ok(Math.abs(spline - model) <= 6, `at ${s}s: spline ${spline} vs model ${model}`);
  }
  ctx.botPressureCurveA = null;
});

test('monotone non-increasing as think shrinks; never above E0; flat below the 1 s edge', () => {
  ctx.botPressureCurveA = seedCurveA(1500, 15);
  ctx.maia3SelectedRating = 1500;
  let prev = Infinity;
  for (const s of [1000, 165, 60, 30, 15, 10, 5, 2, 1]) {
    const v = ctx._pressureEffectiveMaiaEloByThink(s);
    assert.ok(v <= prev, `not monotone at ${s}`);
    assert.ok(v <= 1500, `above E0 at ${s}`);
    prev = v;
  }
  const edge = ctx._pressureEffectiveMaiaEloByThink(1);
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(0.5), edge); // spline clamps flat below 1 s
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(0), edge);   // and survives thinkSec ≤ 0
  ctx.botPressureCurveA = null;
});

test('hybrid slots take identical relative drops from the seeded curve', () => {
  ctx.botPressureCurveA = seedCurveA(1500, 15);
  const dropOf = (slotElo, s) => slotElo - ctx._pressureSlotEloByThink(slotElo, s);
  assert.equal(dropOf(2400, 165), 0);                 // relaxed think → no drop
  for (const s of [5, 2.5, 1]) {
    const d = dropOf(2400, s);
    assert.ok(d > 0, `no drop at ${s}`);
    assert.equal(dropOf(1800, s), d, `slot drops differ at ${s}s`);
  }
  ctx.botPressureCurveA = null;
});

test('no curve set → base rating unchanged (pressure off / legacy fallback)', () => {
  ctx.botPressureCurveA = null;
  ctx.maia3SelectedRating = 1500;
  assert.equal(ctx._pressureEffectiveMaiaEloByThink(1), 1500);
  assert.equal(ctx._pressureSlotEloByThink(2400, 1), 2400);
});

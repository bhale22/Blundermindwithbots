// Tests for the custom-control system in src/50-bot-engine.js.
// Loads the pure chess-fact layer (20-chess-core.js) and the bot engine
// (50-bot-engine.js) into one vm context — the same trick the browser uses
// (shared global scope) — and exercises the real code paths:
//   • each metric's count() on crafted positions,
//   • _botGamePhase / _ccPhaseMatch / _ccResultMatch gates,
//   • the full applyMoveAttractors reweight reading window._bcpCustomControls.
//
// uciToSq/sqToUci live in 40-engines.js (not loaded), so we provide faithful
// stubs — the only chess-engine functions the custom-control path touches.

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
};
// uciToSq stub: "e2e4" -> { from, to, promo }
ctx.uciToSq = function (uci) {
  if (!uci || uci.length < 4) return null;
  return { from: ctx.fileRankToSq(uci.slice(0, 2)), to: ctx.fileRankToSq(uci.slice(2, 4)),
           promo: uci.length > 4 ? uci[4] : null };
};
ctx.sqToUci = function (from, to, promo) {
  return ctx.sqName(from) + ctx.sqName(to) + (promo || '');
};
vm.createContext(ctx);

const SRC = path.join(__dirname, '..', 'src');
vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
// Append a shim so the const _ccMetrics registry is reachable from the test.
vm.runInContext(
  fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8') +
    '\nthis._ccMetrics = _ccMetrics;',
  ctx
);

const EMPTY = new Set();
function pos(fen) { return ctx.parseFen(fen); }
function atkOf(bd) { return ctx.buildDirectAtk(bd, EMPTY, EMPTY, EMPTY, EMPTY); }
function metric(id, fen, me = 'w', opp = 'b') {
  const bd = pos(fen);
  const m = ctx._ccMetrics[id];
  const atk = m.needsAtk ? atkOf(bd) : null;
  return m.fn(bd, { me, opp, atk });
}

// ── Metric correctness ───────────────────────────────────────────────────────

test('passedPawns: lone pawn is passed; an enemy pawn on an adjacent file blocks it', () => {
  assert.equal(metric('passedPawns', '8/8/8/P7/8/8/8/8 w - - 0 1'), 1);
  assert.equal(metric('passedPawns', '8/1p6/8/P7/8/8/8/8 w - - 0 1'), 0); // black b7 covers a-passer
});

test('pawnAdvance: sums ranks advanced from the start rank', () => {
  assert.equal(metric('pawnAdvance', '8/8/8/P7/8/8/8/8 w - - 0 1'), 3); // a-pawn on rank 5 = 3 steps
  assert.equal(metric('pawnAdvance', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'), 0);
});

test('outpost: supported, unchallengeable minor counts; an enemy pawn that can challenge cancels it', () => {
  assert.equal(metric('outpost', '8/8/8/3N4/4P3/8/8/8 w - - 0 1'), 1); // Nd5 backed by e4-pawn
  assert.equal(metric('outpost', '4p3/8/8/3N4/4P3/8/8/8 w - - 0 1'), 0); // black e-pawn can come to challenge
});

test('centralization: central pieces score higher than rim pieces', () => {
  const central = metric('centralization', '8/8/8/3N4/8/8/8/8 w - - 0 1'); // Nd5
  const rim     = metric('centralization', 'N7/8/8/8/8/8/8/8 w - - 0 1');  // Na8 corner
  assert.ok(central > rim, `central ${central} should exceed rim ${rim}`);
});

test('attackedPieces: counts distinct enemy pieces the bot hits', () => {
  assert.equal(metric('attackedPieces', '8/p7/8/8/8/8/8/R7 w - - 0 1'), 1); // Ra1 x-rays a7 pawn
});

test('hangingPieces: own attacked + undefended piece counts', () => {
  assert.equal(metric('hangingPieces', '8/8/p7/1N6/8/8/8/8 w - - 0 1'), 1); // Nb5 hit by a6 pawn, no defender
});

test('kingZoneAttackers: counts bot attacks on the enemy king ring', () => {
  assert.equal(metric('kingZoneAttackers', '4k3/8/8/8/8/8/8/4R3 w - - 0 1'), 2); // Re1 hits e7 and e8
});

// ── Phase / result gates ─────────────────────────────────────────────────────

test('_botGamePhase: opening vs endgame by material + ply', () => {
  ctx.gameMovesAlgebraic = [];
  ctx.board = pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1');
  assert.equal(ctx._botGamePhase(), 'opening');
  ctx.board = pos('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'); // bare K+P each → ≤6 majors/minors
  assert.equal(ctx._botGamePhase(), 'endgame');
});

test('_ccPhaseMatch and _ccResultMatch', () => {
  assert.equal(ctx._ccPhaseMatch('all', 'opening'), true);
  assert.equal(ctx._ccPhaseMatch('endgame', 'opening'), false);
  assert.equal(ctx._ccResultMatch('any', null), true);
  assert.equal(ctx._ccResultMatch('winning', null), false);   // no eval → don't fire
  assert.equal(ctx._ccResultMatch('winning', 200), true);
  assert.equal(ctx._ccResultMatch('losing', 200), false);
  assert.equal(ctx._ccResultMatch('equal', 10), true);
});

test('_ccUnderPressure and _ccPressureMatch (time-pressure gate)', () => {
  ctx.botStartClockMs = 300000;                  // 5-minute game
  assert.equal(ctx._ccUnderPressure(null), false);    // untimed
  assert.equal(ctx._ccUnderPressure(20000), true);    // < 30 s
  assert.equal(ctx._ccUnderPressure(40000), true);    // < 15% of start (45 s)
  assert.equal(ctx._ccUnderPressure(60000), false);   // above both thresholds
  assert.equal(ctx._ccPressureMatch('any',    999999, 999999), true);
  assert.equal(ctx._ccPressureMatch('self',   10000,  999999), true);
  assert.equal(ctx._ccPressureMatch('self',   999999, 10000),  false);
  assert.equal(ctx._ccPressureMatch('opp',    999999, 10000),  true);
  assert.equal(ctx._ccPressureMatch('either', 999999, 10000),  true);
  assert.equal(ctx._ccPressureMatch('either', 999999, 999999), false);
});

// ── Full reweight through applyMoveAttractors ────────────────────────────────

function reweightSetup(controls) {
  ctx.window._bcpAttractorValues = {};
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCpBudget = 200;
  ctx.window._bcpCustomControls = controls;
  ctx.botPlayerColor = 'black';   // bot plays White
  ctx.botMinProbPct = 0;
  ctx.botBlunderLimitCp = 400;    // both → candidate filter is skipped
  ctx.botDayLower = 0;
  ctx.botDayUpper = 100;
  ctx.botBadDayMode = false;
  ctx.botPressureCurveA = null;
  ctx.botPressureCurveB = null;
  ctx.maia3SelectedRating = 1500;
  ctx.botMoveHistory = [];
  ctx.gameMovesAlgebraic = [];
  ctx.sfCplxEval = null;
  ctx.board = pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1');
  ctx.atkMap = atkOf(ctx.board);
}

test('a pawnAdvance control boosts a pawn push over a knight move', () => {
  reweightSetup([{ id: 't', name: 'Push', metric: 'pawnAdvance', phase: 'all', result: 'any', value: 5 }]);
  const out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.ok(out.e2e4 > out.g1f3, `e2e4 ${out.e2e4} should exceed g1f3 ${out.g1f3}`);
});

test('phase gate: an endgame-only control does nothing in the opening', () => {
  reweightSetup([{ id: 't', name: 'Push', metric: 'pawnAdvance', phase: 'endgame', result: 'any', value: 5 }]);
  const out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.equal(out.e2e4, out.g1f3);
});

test('result gate: a "when winning" control waits for a positive eval', () => {
  const control = [{ id: 't', name: 'Push', metric: 'pawnAdvance', phase: 'all', result: 'winning', value: 5 }];
  reweightSetup(control);                       // sfCplxEval = null → inactive
  let out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.equal(out.e2e4, out.g1f3);
  reweightSetup(control);
  ctx.sfCplxEval = 200;                         // winning → active
  out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.ok(out.e2e4 > out.g1f3);
});

test('zero budget neutralizes a custom control', () => {
  reweightSetup([{ id: 't', name: 'Push', metric: 'pawnAdvance', phase: 'all', result: 'any', value: 5 }]);
  ctx.window._bcpCpBudget = 0;
  const out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.equal(out.e2e4, out.g1f3);
});

// ── Expanded metric catalog ──────────────────────────────────────────────────

test('material: counts net piece value from the bot side', () => {
  assert.equal(metric('material', '4k3/8/8/8/8/8/8/3QK3 w - - 0 1'), 9); // lone extra queen
});

test('mobility: a rook on an open board reaches 14 squares', () => {
  assert.equal(metric('mobility', '8/8/8/3R4/8/8/8/8 w - - 0 1'), 14);
});

test('givesCheck: 1 when the enemy king is in check, else 0', () => {
  assert.equal(metric('givesCheck', '4k3/8/8/8/8/8/8/4R3 w - - 0 1'), 1); // Re1 checks Ke8
  assert.equal(metric('givesCheck', '4k3/8/8/8/8/8/8/R3K3 w - - 0 1'), 0);
});

test('doubledPawns / bishopPair / rooksOpenFiles', () => {
  assert.equal(metric('doubledPawns', '8/8/8/8/3P4/8/3P4/8 w - - 0 1'), 1);
  assert.equal(metric('bishopPair', '8/8/8/8/8/8/8/2B2B2 w - - 0 1'), 1);
  assert.equal(metric('bishopPair', '8/8/8/8/8/8/8/2B5 w - - 0 1'), 0);
  assert.equal(metric('rooksOpenFiles', '8/8/8/8/8/8/8/R7 w - - 0 1'), 1);
  assert.equal(metric('rooksOpenFiles', 'P7/8/8/8/8/8/8/R7 w - - 0 1'), 0); // a-pawn blocks the file
});

test('centerControl / enemyHanging / kingDanger', () => {
  assert.equal(metric('centerControl', '8/8/8/8/8/5N2/8/8 w - - 0 1'), 2);  // Nf3 hits d4 + e5
  assert.equal(metric('enemyHanging', '8/8/8/8/8/8/n7/R7 w - - 0 1'), 1);   // Ra1 wins loose Na2
  assert.equal(metric('kingDanger', '4r3/8/8/8/8/8/8/4K3 w - - 0 1'), 2);   // Re8 hits e1 + e2
});

test('a givesCheck control boosts a checking move over a quiet one', () => {
  reweightSetup([{ id: 'k', name: 'Checks', metric: 'givesCheck', phase: 'all', result: 'any', value: 5 }]);
  ctx.board = pos('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'); // Qd1, Ke1 vs Ke8
  ctx.atkMap = atkOf(ctx.board);
  const out = ctx.applyMoveAttractors({ d1d8: 0.5, d1d2: 0.5 }); // Qd8+ vs quiet Qd2
  assert.ok(out.d1d8 > out.d1d2, `Qd8+ ${out.d1d8} should exceed Qd2 ${out.d1d2}`);
});

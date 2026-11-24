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

test('pawnAdvance: counts the distance still to travel, negated', () => {
  assert.equal(metric('pawnAdvance', '8/8/8/P7/8/8/8/8 w - - 0 1'), -3);   // a5 is 3 short
  assert.equal(metric('pawnAdvance', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'), -48);
});

test('pawnAdvance: promoting is progress, not a loss', () => {
  // Measured as distance covered, a promoted pawn takes its whole contribution
  // off the board with it and queening reads as a large step backwards. This is
  // the case the metric is shaped around.
  const beforePromo = metric('pawnAdvance', '8/P7/8/8/8/8/8/8 w - - 0 1');  // a7, one short
  const afterPromo  = metric('pawnAdvance', 'Q7/8/8/8/8/8/8/8 w - - 0 1');  // queened
  assert.equal(beforePromo, -1);
  assert.equal(afterPromo, 0);
  assert.ok(afterPromo > beforePromo, 'promoting must score as an advance');
});

test('outpost: a square no enemy pawn can reach, whether or not a pawn defends it', () => {
  assert.equal(metric('outpost', '8/8/8/3N4/4P3/8/8/8 w - - 0 1'), 1);  // Nd5, nothing can challenge
  assert.equal(metric('outpost', '4p3/8/8/3N4/4P3/8/8/8 w - - 0 1'), 0); // black e-pawn can come to e6
  // Pawn support is not what makes an outpost. A knight on a square no pawn can
  // ever attack is on one; a knight a pawn can still be pushed at is not, however
  // well defended it happens to be.
  assert.equal(metric('outpost', '8/8/8/3N4/8/8/8/8 w - - 0 1'), 1);     // unsupported, unchallengeable
  assert.equal(metric('outpost', '2p5/8/8/3N4/4P3/8/8/8 w - - 0 1'), 0); // c7 pawn can come to c6
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

// Lichess's division (scalachess Divider), not a move number (Nov 2026).
test('_botGamePhase: a developed back rank is the middlegame at any move number', () => {
  ctx.gameMovesAlgebraic = [];   // ply 0: the old rule called this the opening
  // White has three pieces left on its first rank: under Lichess's four.
  ctx.board = pos('r1bqkb1r/pppppppp/2n2n2/8/8/2NBBN2/PPPQPPPP/R4RK1 w kq - 0 1');
  assert.equal(ctx._botGamePhase(), 'middlegame');
  // Ten pieces besides kings and pawns is the middlegame too, even undeveloped.
  ctx.board = pos('rn1qk1nr/pppppppp/8/8/8/8/PPPPPPPP/RN1QK1NR w KQkq - 0 1');
  assert.equal(ctx.botPhaseFeatures(ctx.board).majMin, 10);
  assert.equal(ctx._botGamePhase(), 'middlegame');
  // Seven is still the middlegame; six is the endgame.
  ctx.board = pos('3qk3/pppppppp/8/8/8/8/PPPPPPPP/R1BQKB1R w - - 0 1');
  assert.equal(ctx.botPhaseFeatures(ctx.board).majMin, 6);
  assert.equal(ctx._botGamePhase(), 'endgame');
});

test('_botGamePhase: once the game has reached a phase, it does not go back', () => {
  const developed = pos('r1bqkb1r/pppppppp/2n2n2/8/8/2NBBN2/PPPQPPPP/R4RK1 w kq - 0 1');
  ctx.positionCounts = {};
  ctx.positionCounts[ctx.positionKey(developed, 'w', { wK: false, wQ: false, bK: true, bQ: true }, -1)] = 1;
  // The pieces went home again: on its own this board reads as the opening.
  ctx.board = pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1');
  assert.equal(ctx.botPhaseOfPositions([ctx.botPhaseFeatures(ctx.board)]), 'opening');
  assert.equal(ctx._botGamePhase(), 'middlegame');
  delete ctx.positionCounts;
  assert.equal(ctx._botGamePhase(), 'opening');
});

test('mixed armies (Lichess mixedness over 150) are the middlegame', () => {
  // Every piece still on the board and both back ranks full, but the pawns
  // are all through each other (not a legal game, only the test's input).
  // Two such ranks score 133 (worked by hand from Lichess's table too); four, 245.
  assert.equal(ctx.botPhaseFeatures(pos('rnbqkbnr/8/8/pPpPpPpP/PpPpPpPp/8/8/RNBQKBNR w - - 0 1')).mixedness, 133);
  const f = ctx.botPhaseFeatures(pos('rnbqkbnr/8/pPpPpPpP/PpPpPpPp/pPpPpPpP/PpPpPpPp/8/RNBQKBNR w - - 0 1'));
  assert.equal(f.majMin, 14);
  assert.equal(f.backrankSparse, false);
  assert.ok(f.mixedness > 150, 'mixedness ' + f.mixedness);
  assert.equal(ctx.botPhaseOfPositions([f]), 'middlegame');
  // The start position is not mixed at all.
  assert.ok(ctx.botPhaseFeatures(pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1')).mixedness <= 150);
});

// ── Rules: which one runs (Nov 2026) ────────────────────────────────────────

test('botRuleWinners: the narrowest rule that holds wins, then the higher one', () => {
  const rules = [
    { id: 'a', metric: 'trait:attacker', phase: 'all',     result: 'any',     pressure: 'any', value: 2 },
    { id: 'b', metric: 'trait:attacker', phase: 'endgame', result: 'any',     pressure: 'any', value: 0 },
    { id: 'c', metric: 'trait:attacker', phase: 'endgame', result: 'winning', pressure: 'any', value: 4 },
    { id: 'd', metric: 'trait:sharpness', phase: 'endgame', result: 'any',    pressure: 'any', value: 3 },
    { id: 'e', metric: 'trait:sharpness', phase: 'endgame', result: 'any',    pressure: 'any', value: 1 },
  ];
  let w = ctx.botRuleWinners(rules, 'opening', null, null, null);
  assert.equal(w['trait:attacker'].rule.id, 'a');
  assert.equal(w['trait:sharpness'], undefined);
  w = ctx.botRuleWinners(rules, 'endgame', null, null, null);
  assert.equal(w['trait:attacker'].rule.id, 'b');     // Endgame beats All game
  assert.equal(w['trait:sharpness'].rule.id, 'd');    // equally narrow: the higher one
  w = ctx.botRuleWinners(rules, 'endgame', 200, null, null);
  assert.equal(w['trait:attacker'].rule.id, 'c');     // Endgame + winning beats Endgame
});

test('botRulesInstall puts the rules that hold in for one move, then puts the bot back', async () => {
  ctx.gameMovesAlgebraic = [];
  ctx.board = pos('3qk3/pppppppp/8/8/8/8/PPPPPPPP/R1BQKB1R w - - 0 1');   // endgame
  const av = { attacker: 2, entropy: 1 }, pv = { pawn: 1 };
  ctx.window._bcpAttractorValues = av;
  ctx.window._bcpPieceValues = pv;
  ctx.window._bcpCpBudget = 100;
  ctx.window._bcpCpHardFloor = 150;
  ctx.window._bcpCpFromChat = false;
  ctx.window._bcpCustomControls = [
    { id: 'r1', metric: 'trait:entropy',     phase: 'opening', result: 'any', pressure: 'any', value: 4 },
    { id: 'r2', metric: 'trait:sharpness',   phase: 'endgame', result: 'any', pressure: 'any', value: 4 },
    { id: 'r3', metric: 'trait:attacker',    phase: 'endgame', result: 'any', pressure: 'any', value: 0 },
    { id: 'r4', metric: 'piece:pawn',        phase: 'endgame', result: 'any', pressure: 'any', value: 3 },
    { id: 'r5', metric: 'strength:cpBudget', phase: 'endgame', result: 'any', pressure: 'any', value: 200 },
  ];
  const restore = await ctx.botRulesInstall('3qk3/pppppppp/8/8/8/8/PPPPPPPP/R1BQKB1R w - - 0 1');
  const inAv = ctx.window._bcpAttractorValues;
  assert.equal(inAv.sharpness, 4);
  assert.equal(inAv.attacker, 0);      // a rule at 0 switches the trait off
  assert.equal(inAv.entropy, 1);       // its rule is for the opening: the slider value runs
  assert.equal(ctx.window._bcpPieceValues.pawn, 3);
  assert.equal(ctx.window._bcpCpBudget, 200);
  assert.equal(ctx.window._bcpCpHardFloor, 200);   // never under the Budget
  restore();
  assert.equal(ctx.window._bcpAttractorValues, av);
  assert.equal(ctx.window._bcpPieceValues, pv);
  assert.equal(ctx.window._bcpCpBudget, 100);
  assert.equal(ctx.window._bcpCpHardFloor, 150);
  // A Budget the opponent asked for in the chat is left alone.
  ctx.window._bcpCpFromChat = true;
  const restore2 = await ctx.botRulesInstall('x');
  assert.equal(ctx.window._bcpCpBudget, 100);
  restore2();
  ctx.window._bcpCpFromChat = false;
  ctx.window._bcpCustomControls = [];
});

test('board-feature rules: a narrower rule at 0 switches a broader one off', () => {
  reweightSetup([
    { id: 'n', name: 'Push', metric: 'pawnAdvance', phase: 'opening', result: 'any', pressure: 'any', value: 0 },
    { id: 'b', name: 'Push', metric: 'pawnAdvance', phase: 'all',     result: 'any', pressure: 'any', value: 5 },
  ]);
  const out = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  assert.equal(out.e2e4, out.g1f3);
});

test('botWeighsMoves: a Strength rule alone is not a personality', () => {
  ctx.botBlindConviction = false;
  ctx.window._bcpAttractorValues = {};
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCustomControls = [{ id: 's', metric: 'strength:cpBudget', phase: 'endgame', result: 'any', pressure: 'any', value: 40 }];
  assert.equal(ctx.botWeighsMoves(), false);
  ctx.window._bcpCustomControls.push({ id: 't', metric: 'trait:sharpness', phase: 'endgame', result: 'any', pressure: 'any', value: 3 });
  assert.equal(ctx.botWeighsMoves(), true);
  ctx.window._bcpCustomControls = [];
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

test('budget recalibrates to active controls — an inactive phase-gated sibling does not dilute', () => {
  // Active control alone (start position = opening phase).
  reweightSetup([{ id:'a', name:'A', metric:'pawnAdvance', phase:'all', result:'any', pressure:'any', value:5 }]);
  const solo = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  // Same control + an endgame-only sibling that is INACTIVE in the opening.
  reweightSetup([
    { id:'a', name:'A', metric:'pawnAdvance',    phase:'all',     result:'any', pressure:'any', value:5 },
    { id:'b', name:'B', metric:'centralization', phase:'endgame', result:'any', pressure:'any', value:5 },
  ]);
  const withInactive = ctx.applyMoveAttractors({ e2e4: 0.5, g1f3: 0.5 });
  // Per-active recalibration: the inactive sibling must not change A's effect.
  assert.ok(Math.abs(withInactive.e2e4 - solo.e2e4) < 1e-9,
    'inactive sibling diluted the active control: ' + withInactive.e2e4 + ' vs ' + solo.e2e4);
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

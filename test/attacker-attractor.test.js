// Tests for the Attacker / Peacemaker attractor and the Trade capture cap in
// src/50-bot-engine.js, run through the real applyMoveAttractors.
//
// Attacker is two-tier: every capture outranks every quiet move, and among
// quiet moves the one that adds the most attacks on enemy pieces wins. Scored
// as a plain attack-count delta it did the opposite — taking a piece deletes
// every attack on it — and the Attacky preset ranked a free rook 8th of 28.

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
vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);

const EMPTY = new Set();

// Reweights a uniform distribution over every legal move in `fen` and returns
// [{ uci, capture, w }] sorted by the reweighted probability, highest first.
function rank(fen, attractors, budget = 200) {
  const side = fen.split(' ')[1];
  ctx.window._bcpAttractorValues = attractors;
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCpBudget = budget;
  ctx.window._bcpCustomControls = [];
  ctx.botPlayerColor = side === 'w' ? 'black' : 'white';   // the HUMAN's colour
  ctx.botMinProbPct = 0;
  ctx.botDayLower = 0;
  ctx.botDayUpper = 100;
  ctx.botBadDayMode = false;
  ctx.botPressureCurveA = null;
  ctx.botPressureCurveB = null;
  ctx.maia3SelectedRating = 1500;
  ctx.botMoveHistory = [];
  ctx.gameMovesAlgebraic = new Array(30).fill('x');           // out of the opening
  ctx.sfCplxEval = null;
  ctx.board = ctx.parseFen(fen);
  ctx.atkMap = ctx.buildDirectAtk(ctx.board, EMPTY, EMPTY, EMPTY, EMPTY);

  const moves = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = ctx.board[sq];
    if (!p || p.color !== side) continue;
    for (const t of ctx.legalMovesFor(sq, ctx.board, -1, {})) {
      moves.push(ctx.sqName(sq) + ctx.sqName(typeof t === 'object' ? t.to : t));
    }
  }
  const uniq = [...new Set(moves)];
  const probs = Object.fromEntries(uniq.map(m => [m, 1 / uniq.length]));
  const out = ctx.applyMoveAttractors(probs);
  return uniq
    .map(m => ({ uci: m, capture: !!ctx.board[ctx.fileRankToSq(m.slice(2, 4))], w: out[m] }))
    .sort((a, b) => b.w - a.w);
}

function capturesFirst(rows) {
  const caps = rows.filter(r => r.capture);
  assert.ok(caps.length, 'position must offer a capture');
  const worstCap = Math.min(...caps.map(r => r.w));
  const bestQuiet = Math.max(...rows.filter(r => !r.capture).map(r => r.w));
  return { worstCap, bestQuiet };
}

const FREE_ROOK   = 'rn1qkbnr/p1pppppp/8/8/8/6P1/PPPPPPBP/RNBQK1NR w KQkq - 0 1';   // Bxa8 wins a rook
const FREE_PAWN_EG = '4k3/8/8/3p4/8/1B6/8/3RK3 w - - 0 1';                         // Bxd5 / Rxd5
const QGD         = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9';
const NO_CAPTURES = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'; // 1.e4 e5

test('Attacker: a free rook outranks every quiet move', () => {
  const rows = rank(FREE_ROOK, { attacker: 5 });
  assert.equal(rows[0].uci, 'g2a8');
  const { worstCap, bestQuiet } = capturesFirst(rows);
  assert.ok(worstCap > bestQuiet);
});

test('Attacker: takes the endgame pawn rather than piling attacks onto it', () => {
  const rows = rank(FREE_PAWN_EG, { attacker: 5 });
  const w = Object.fromEntries(rows.map(r => [r.uci, r.w]));
  assert.ok(w.d1d5 > w.d1d4, `Rxd5 ${w.d1d5} should beat Rd4 ${w.d1d4}`);
  assert.ok(w.b3d5 > w.d1d4, `Bxd5 ${w.b3d5} should beat Rd4 ${w.d1d4}`);
  const { worstCap, bestQuiet } = capturesFirst(rows);
  assert.ok(worstCap > bestQuiet);
});

test('Attacker: every capture outranks every quiet move in a full middlegame', () => {
  const { worstCap, bestQuiet } = capturesFirst(rank(QGD, { attacker: 5 }));
  assert.ok(worstCap > bestQuiet, `worst capture ${worstCap} vs best quiet ${bestQuiet}`);
});

test('Attacker: with nothing to take, more attacks ranks higher', () => {
  const rows = rank(NO_CAPTURES, { attacker: 5 });
  assert.ok(rows.every(r => !r.capture), 'position must offer no captures');
  const w = Object.fromEntries(rows.map(r => [r.uci, r.w]));
  // Qh5 hits e5, f7 and h7; Nf3 hits e5; a3 hits nothing.
  assert.ok(w.d1h5 > w.g1f3, `Qh5 ${w.d1h5} should beat Nf3 ${w.g1f3}`);
  assert.ok(w.g1f3 > w.a2a3, `Nf3 ${w.g1f3} should beat a3 ${w.a2a3}`);
});

test('Peacemaker mirrors it: every quiet move outranks every capture', () => {
  for (const fen of [FREE_ROOK, FREE_PAWN_EG, QGD]) {
    const rows = rank(fen, { attacker: -5 });
    const caps = rows.filter(r => r.capture);
    const bestCap = Math.max(...caps.map(r => r.w));
    const worstQuiet = Math.min(...rows.filter(r => !r.capture).map(r => r.w));
    assert.ok(worstQuiet > bestCap, `${fen}: worst quiet ${worstQuiet} vs best capture ${bestCap}`);
  }
});

test('Trade: a threat never outscores a capture', () => {
  // Uncapped, Rd4 (one threat) beat Rxd5 here, because the endgame shrinks the
  // threat divisor; in a middlegame two threats were enough.
  for (const fen of [FREE_PAWN_EG, FREE_ROOK, QGD]) {
    const { worstCap, bestQuiet } = capturesFirst(rank(fen, { trade: 5 }));
    assert.ok(worstCap >= bestQuiet - 1e-12, `${fen}: worst capture ${worstCap} vs best quiet ${bestQuiet}`);
  }
});

test('Attacky preset: captures first on every test position', () => {
  const attacky = { complexity: 0, compwin: 1, spacecadet: 0, fortkx: 0, gambito: 0, trade: 3,
                    structure: 0, hustle: -2, luck: 0, pressure: 1, attacker: 5 };
  for (const fen of [FREE_ROOK, FREE_PAWN_EG, QGD]) {
    const { worstCap, bestQuiet } = capturesFirst(rank(fen, attacky));
    assert.ok(worstCap > bestQuiet, `${fen}: worst capture ${worstCap} vs best quiet ${bestQuiet}`);
  }
});

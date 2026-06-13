// Tests for src/20-chess-core.js — the pure chess-fact layer.
// Run with:  node --test
//
// The core file is plain script (shared global scope in the browser), so we
// load it into a vm context with minimal stubs for the two UI touchpoints
// (document.getElementById for the queen-pin checkbox, indActive for battery
// mode). Everything tested here is pure board-in/facts-out.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  document: { getElementById: () => null }, // queen-pin checkbox absent → off
  indActive: () => false,                   // battery mode off
  console,
};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', '20-chess-core.js'), 'utf8'),
  ctx
);

// Helpers — parseFen sets ctx.turn / ctx.castling / ctx.epSq as globals
function pos(fen) {
  const bd = ctx.parseFen(fen);
  return { bd, turn: ctx.turn, castling: ctx.castling, epSq: ctx.epSq };
}
const sq = (name) => ctx.fileRankToSq(name);

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('square name round-trip', () => {
  for (let i = 0; i < 64; i++) assert.equal(sq(ctx.sqName(i)), i);
  assert.equal(sq('e4'), 36);
  assert.equal(sq('a8'), 0);
  assert.equal(sq('h1'), 63);
});

test('starting position: 20 legal moves each side', () => {
  const p = pos(START);
  assert.equal(ctx.allLegalMoves(p.bd, 'w', p.epSq, p.castling).length, 20);
  assert.equal(ctx.allLegalMoves(p.bd, 'b', p.epSq, p.castling).length, 20);
});

test('absolutely pinned piece cannot move off the ray', () => {
  // White knight on d2 pinned by rook on d8 to king on d1
  const p = pos('3r4/8/8/8/8/8/3N4/3K4 w - - 0 1');
  const moves = ctx.legalMovesFor(sq('d2'), p.bd, p.epSq, p.castling);
  assert.deepEqual(moves, [], 'pinned knight has no legal moves');
});

test('pinned pieces are excluded from defender counts (buildAtk)', () => {
  // Same pin; the knight on d2 must not count as a defender of pawn on e4
  const p = pos('3r4/8/8/8/4P3/8/3N4/3K4 w - - 0 1');
  const atk = ctx.buildAtk(p.bd);
  assert.equal(atk[sq('e4')].w.length, 0, 'pinned knight defends nothing off-ray');
});

test('en passant is generated and applied', () => {
  // White pawn e5, black just played d7-d5 → ep on d6
  const p = pos('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const moves = ctx.legalMovesFor(sq('e5'), p.bd, p.epSq, p.castling);
  assert.ok(moves.includes(sq('d6')), 'ep capture offered');
  const bd2 = ctx.applyMove(sq('e5'), sq('d6'), p.bd, p.epSq);
  assert.ok(!bd2[sq('d5')], 'captured pawn removed from d5');
  assert.ok(bd2[sq('d6')] && bd2[sq('d6')].piece === 'P', 'pawn landed on d6');
});

test('castling legality: blocked and through-check are rejected', () => {
  // Clear kingside, but black rook on f8 covers f1 → O-O illegal
  const p1 = pos('5r2/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.equal(ctx.castlingLegal(p1.bd, 'w', 'K'), false, 'cannot castle through check');
  const p2 = pos('8/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.equal(ctx.castlingLegal(p2.bd, 'w', 'K'), true, 'clear kingside castle is legal');
});

test('checkmate and stalemate detection', () => {
  // Back-rank mate: black king h8, white queen g7 defended by king g6
  const mate = pos('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(ctx.allLegalMoves(mate.bd, 'b', mate.epSq, mate.castling).length, 0);
  assert.equal(ctx.inCheck(mate.bd, 'b'), true);
  // Classic stalemate: black king a8, white queen c7, white king c6 — wait,
  // use known stalemate: black king h8, white king f7, white queen g6
  const stale = pos('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1');
  assert.equal(ctx.allLegalMoves(stale.bd, 'b', stale.epSq, stale.castling).length, 0);
  assert.equal(ctx.inCheck(stale.bd, 'b'), false);
});

test('moveToSAN: pawn move, capture, check, promotion', () => {
  const p = pos(START);
  assert.equal(ctx.moveToSAN(sq('e2'), sq('e4'), null, p.bd, p.epSq, p.castling), 'e4');
  assert.equal(ctx.moveToSAN(sq('g1'), sq('f3'), null, p.bd, p.epSq, p.castling), 'Nf3');
  // Promotion with check: white pawn a7 promotes, black king e8
  const pr = pos('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const san = ctx.moveToSAN(sq('a7'), sq('a8'), 'Q', pr.bd, pr.epSq, pr.castling);
  assert.equal(san, 'a8=Q+');
});

test('positionKey: distinguishes turn, castling, ep; equal for equal positions', () => {
  const a = pos(START);
  const k1 = ctx.positionKey(a.bd, 'w', a.castling, -1);
  const k2 = ctx.positionKey(a.bd, 'b', a.castling, -1);
  assert.notEqual(k1, k2, 'side to move differs');
  const noCastle = { wK: false, wQ: false, bK: false, bQ: false };
  assert.notEqual(k1, ctx.positionKey(a.bd, 'w', noCastle, -1), 'castling rights differ');
  assert.notEqual(k1, ctx.positionKey(a.bd, 'w', a.castling, sq('e3')), 'ep square differs');
  const b = pos(START);
  assert.equal(k1, ctx.positionKey(b.bd, 'w', b.castling, -1), 'same position → same key');
});

test('threefold scenario: shuffling knights reproduces the same key', () => {
  let p = pos(START);
  let { bd, epSq, castling } = p;
  const baseKey = ctx.positionKey(bd, 'w', castling, epSq);
  // Ng1-f3 Ng8-f6 Nf3-g1 Nf6-g8 → identical position, white to move
  const seq = [['g1','f3'], ['g8','f6'], ['f3','g1'], ['f6','g8']];
  let turn = 'w';
  for (const [f, t] of seq) {
    const nextEp = ctx.computeEP(sq(f), sq(t), bd);
    bd = ctx.applyMove(sq(f), sq(t), bd, epSq);
    epSq = nextEp;
    turn = turn === 'w' ? 'b' : 'w';
  }
  assert.equal(ctx.positionKey(bd, turn, castling, epSq), baseKey);
});

test('isInsufficientMaterial: classifications', () => {
  const yes = [
    '4k3/8/8/8/8/8/8/4K3 w - - 0 1',        // K vs K
    '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',       // K+B vs K
    '4k3/8/8/8/8/8/8/3NK3 w - - 0 1',       // K+N vs K
    '2b1k3/8/8/8/8/8/8/3BK3 w - - 0 1',     // same-color bishops (d1 light, c8 light)
  ];
  const no = [
    START,
    '4k3/8/8/8/8/8/8/3QK3 w - - 0 1',       // queen on the board
    '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',      // pawn can promote
    '1b2k3/8/8/8/8/8/8/3BK3 w - - 0 1',     // opposite-color bishops (mate constructible)
    '2n1k3/8/8/8/8/8/8/3NK3 w - - 0 1',     // N vs N — helpmate constructible
  ];
  for (const f of yes) assert.equal(ctx.isInsufficientMaterial(pos(f).bd), true, f);
  for (const f of no) assert.equal(ctx.isInsufficientMaterial(pos(f).bd), false, f);
});

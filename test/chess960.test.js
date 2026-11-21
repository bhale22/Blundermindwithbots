// Chess960 rules in src/20-chess-core.js, checked against python-chess.
// Run with:  node --test
//
// test/fixtures/chess960.json was made by python-chess 1.11.2 with
// chess960=True: the legal moves of each position (castling written king takes
// rook, as Lichess and Stockfish write it) and perft counts. 300 of its
// positions were built around castling: the back rank thinned out, the rights a
// random subset, attackers dropped in, so about half allow a castle and half
// hold a right that cannot be used. Standard chess is checked too, so the
// rewrite of castling cannot have changed it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { document: { getElementById: () => null }, indActive: () => false, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', '20-chess-core.js'), 'utf8'), ctx);
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chess960.json'), 'utf8'));

function load(fen, is960) {
  ctx.setChess960(is960);
  const bd = ctx.parseFen(fen);
  return { bd, turn: ctx.turn, cst: { ...ctx.castling }, ep: ctx.epSq };
}
const uci = (from, to, promo) => ctx.sqName(from) + ctx.sqName(to) + (promo || '');
function legalUcis(p) {
  const out = [];
  for (const m of ctx.allLegalMoves(p.bd, p.turn, p.ep, p.cst)) {
    const pc = p.bd[m.from];
    const promo = pc.piece === 'P' && (m.to < 8 || m.to >= 56);
    if (promo) for (const q of 'qrbn') out.push(uci(m.from, m.to, q));
    else out.push(uci(m.from, m.to));
  }
  return out.sort();
}
function perft(bd, t, cst, ep, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of ctx.allLegalMoves(bd, t, ep, cst)) {
    const pc = bd[m.from];
    const promos = pc.piece === 'P' && (m.to < 8 || m.to >= 56) ? ['Q', 'R', 'B', 'N'] : [null];
    for (const pr of promos) {
      const nb = ctx.applyMove(m.from, m.to, bd, ep, pr || 'Q');
      n += perft(nb, t === 'w' ? 'b' : 'w', ctx.updateCastling(m.from, m.to, pc, cst),
                 ctx.computeEP(m.from, m.to, bd), d - 1);
    }
  }
  return n;
}

test('Chess960 numbering matches python-chess (518 is the standard position)', () => {
  for (const s of FIX.starts) {
    assert.equal(ctx.chess960BackRank(s.n), s.back, 'position ' + s.n);
    assert.equal(ctx.chess960StartFen(s.n).split(' ')[0], s.fen.split(' ')[0], 'position ' + s.n);
    assert.equal(ctx.chess960NumberOf(s.fen), s.n);
  }
  assert.equal(ctx.chess960BackRank(518), 'RNBQKBNR');
});

test('every one of the 960 back ranks is legal and different', () => {
  const seen = new Set();
  for (let n = 0; n < 960; n++) {
    const br = ctx.chess960BackRank(n);
    assert.equal(br.length, 8);
    const k = br.indexOf('K'), r1 = br.indexOf('R'), r2 = br.lastIndexOf('R');
    assert.ok(r1 < k && k < r2, n + ': king between the rooks');
    const b1 = br.indexOf('B'), b2 = br.lastIndexOf('B');
    assert.notEqual(b1 % 2, b2 % 2, n + ': bishops on opposite colours');
    assert.equal([...br].sort().join(''), 'BBKNNQRR');
    seen.add(br);
  }
  assert.equal(seen.size, 960);
});

test('start positions: perft 1-3 as python-chess', () => {
  for (const s of FIX.starts) {
    const p = load(s.fen, true);
    for (let d = 1; d <= 3; d++)
      assert.equal(perft(p.bd, p.turn, p.cst, p.ep, d), s.perft[d - 1], 'position ' + s.n + ' depth ' + d);
  }
});

test('castling positions: the same legal moves as python-chess (X-FEN and Shredder-FEN)', () => {
  let castles = 0;
  for (const c of FIX.castling) {
    for (const fen of [c.fen, c.shredder]) {
      const p = load(fen, true);
      assert.deepEqual(legalUcis(p), c.moves, fen);
    }
    castles += c.castles;
  }
  assert.ok(castles > 100, 'the fixture really does exercise castling');
});

// Depth 3 is slow on this board representation, so a sample: the move lists
// above already cover every castling position at depth 1.
test('castling positions: perft 3 as python-chess (sample)', () => {
  for (const c of FIX.castling.filter(x => x.perft3).slice(0, 6)) {
    const p = load(c.fen, true);
    assert.equal(perft(p.bd, p.turn, p.cst, p.ep, 3), c.perft3, c.fen);
  }
});

test('played-out positions: moves and perft 2 as python-chess, perft 3 on a sample', () => {
  FIX.positions.forEach((c, i) => {
    const p = load(c.fen, true);
    assert.deepEqual(legalUcis(p), c.moves, c.fen);
    assert.equal(perft(p.bd, p.turn, p.cst, p.ep, 2), c.perft2, c.fen);
    if (i < 6) assert.equal(perft(p.bd, p.turn, p.cst, p.ep, 3), c.perft3, c.fen);
  });
});

test('standard chess is unchanged: moves and perft as python-chess', () => {
  for (const s of FIX.standard) {
    const p = load(s.fen, false);
    assert.deepEqual(legalUcis(p), s.moves, s.fen);
    for (let d = 1; d <= 3; d++) assert.equal(perft(p.bd, p.turn, p.cst, p.ep, d), s.perft[d - 1], s.fen + ' d' + d);
  }
});

test('a Chess960 castle: board, rights, SAN, FEN and the SAN parser', () => {
  // Position 0: BBQNNRKR. Clear f1..g1? The king is on g1, the h-rook beside it:
  // O-O leaves the king where it is and puts the rook on f1.
  const p = load('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNN1KR w KQkq - 0 1', true);
  const g1 = ctx.fileRankToSq('g1'), h1 = ctx.fileRankToSq('h1'), f1 = ctx.fileRankToSq('f1');
  assert.ok(ctx.legalMovesFor(g1, p.bd, p.ep, p.cst).includes(h1), 'king takes rook is the castle');
  assert.equal(ctx.moveToSAN(g1, h1, null, p.bd, p.ep, p.cst), 'O-O');
  assert.ok(ctx.isCastleMove(p.bd, g1, h1));
  assert.equal(ctx.moveCaptures(p.bd, g1, h1, p.ep), false, 'landing on its own rook is not a capture');
  const nb = ctx.applyMove(g1, h1, p.bd, p.ep, 'Q');
  assert.equal(nb[g1].piece, 'K');
  assert.equal(nb[f1].piece, 'R');
  assert.equal(nb[h1], undefined);
  const nc = ctx.updateCastling(g1, h1, p.bd[g1], p.cst);
  assert.deepEqual(nc, { wK: false, wQ: false, bK: true, bQ: true });
  assert.deepEqual(ctx.algebraicToMove('O-O', p.bd, 'w', p.ep, p.cst), { from: g1, to: h1 });
  assert.deepEqual(ctx.algebraicToMove('O-O+', p.bd, 'w', p.ep, p.cst), { from: g1, to: h1 });
  // The kingside rook file came from the FEN. The queenside right has no rook
  // left to belong to (f1 is empty), so it offers nothing.
  assert.equal(ctx.castleFiles.wK, 7);
  assert.deepEqual(ctx.legalMovesFor(g1, p.bd, p.ep, p.cst).map(ctx.sqName).sort(), ['f1', 'h1']);
});

test('X-FEN out: K/Q while the rook is the outermost, its file letter when not', () => {
  load('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1', true);
  const bd = ctx.parseFen('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1');
  assert.equal(ctx.castlingFieldFor(bd, ctx.castling), 'KQkq');
  // A second white rook arrives on a1, outside the castling rook on f1: the
  // queenside right must now name its file.
  const bd2 = Object.assign({}, bd);
  bd2[ctx.fileRankToSq('a1')] = { piece: 'R', color: 'w' };
  delete bd2[ctx.fileRankToSq('b1')];
  assert.equal(ctx.castlingFieldFor(bd2, ctx.castling), 'KFkq');
  ctx.setChess960(false);
  assert.equal(ctx.castlingFieldFor(bd2, ctx.castling), 'KQkq', 'standard games always write KQkq');
});

test('chess960CastleAlias: e1g1 spelled the standard way becomes king takes rook', () => {
  // King e1, rooks a1/h1, Chess960 position 518: O-O is e1h1 here.
  const p = load('rnbqk2r/pppppppp/8/8/8/8/PPPPPPPP/RNBQK2R w KQkq - 0 1', true);
  const e1 = ctx.fileRankToSq('e1'), g1 = ctx.fileRankToSq('g1'), h1 = ctx.fileRankToSq('h1');
  assert.equal(ctx.chess960CastleAlias(p.bd, e1, g1, p.ep, p.cst), h1);
  // King f1 with g1 empty: f1g1 is an ordinary king step and stays one.
  const q = load('rnbqkr2/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1K1R w Kq - 0 1', true);
  const f1 = ctx.fileRankToSq('f1');
  assert.equal(ctx.chess960CastleAlias(q.bd, f1, g1, q.ep, q.cst), g1);
  ctx.setChess960(false);
  assert.equal(ctx.chess960CastleAlias(p.bd, e1, g1, p.ep, p.cst), g1, 'standard games: nothing to translate');
});

test('standard games still castle king-two-squares even after a Chess960 game', () => {
  load('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1', true);
  const p = load('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', false);
  const e1 = ctx.fileRankToSq('e1');
  const to = ctx.legalMovesFor(e1, p.bd, p.ep, p.cst).map(ctx.sqName).sort();
  assert.deepEqual(to, ['c1', 'd1', 'd2', 'e2', 'f1', 'f2', 'g1']);
  assert.deepEqual(ctx.castleFiles, { wK: 7, wQ: 0, bK: 7, bQ: 0 });
});

// Move notation, against python-chess's SAN for every legal move (check and
// mate marks left off: castles here never carry them). Covers Chess960
// castles (O-O / O-O-O from any start) and disambiguation, which used to swap
// file and rank: rooks on a1 and f1 wrote Rf1-d1 as "R1d1".
function sansOf(p) {
  const out = [];
  for (const m of ctx.allLegalMoves(p.bd, p.turn, p.ep, p.cst)) {
    const pc = p.bd[m.from];
    const promos = pc.piece === 'P' && (m.to < 8 || m.to >= 56) ? ['Q', 'R', 'B', 'N'] : [null];
    for (const pr of promos) out.push(ctx.moveToSAN(m.from, m.to, pr, p.bd, p.ep, p.cst).replace(/[+#]$/, ''));
  }
  return out.sort();
}
test('SAN matches python-chess: Chess960 positions', () => {
  // A sample: SAN looks every move ahead for check, which is slow here.
  for (const c of FIX.castling.slice(0, 100).concat(FIX.positions)) assert.deepEqual(sansOf(load(c.fen, true)), c.sans, c.fen);
});
test('SAN matches python-chess: standard positions, disambiguation included', () => {
  for (const c of FIX.standard.concat(FIX.disambiguation)) assert.deepEqual(sansOf(load(c.fen, false)), c.sans, c.fen);
  const p = load('4k3/8/8/8/8/8/8/R4RK1 w - - 0 1', false);
  assert.equal(ctx.moveToSAN(ctx.fileRankToSq('f1'), ctx.fileRankToSq('d1'), null, p.bd, p.ep, p.cst), 'Rfd1');
});
test('the SAN parser reads every move back to the move it names', () => {
  for (const [list, is960] of [[FIX.castling.slice(0, 40), true], [FIX.disambiguation.slice(-60), false]]) {
    for (const c of list) {
      const p = load(c.fen, is960);
      for (const m of ctx.allLegalMoves(p.bd, p.turn, p.ep, p.cst)) {
        const pc = p.bd[m.from];
        const pr = pc.piece === 'P' && (m.to < 8 || m.to >= 56) ? 'N' : null;
        const san = ctx.moveToSAN(m.from, m.to, pr, p.bd, p.ep, p.cst);
        const back = ctx.algebraicToMove(san, p.bd, p.turn, p.ep, p.cst);
        assert.ok(back && back.from === m.from && back.to === m.to, c.fen + ' ' + san);
      }
    }
  }
});

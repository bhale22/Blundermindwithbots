// Premove generation + chain semantics.
//
// The premove set is deliberately WIDER than the legal set: it is composed
// before the opponent has replied, so it cannot be validated yet. These tests
// pin the three ways it differs (enemy pieces are not blockers, pawns may take
// diagonally into empty air, check is not evaluated) and the one way it does
// not (our own pieces still block, because nothing can move them aside first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'src', '20-chess-core.js'), 'utf8');
const ctx = vm.createContext({ console });
vm.runInContext(core, ctx);

const sq = (s) => ctx.fileRankToSq(s);
const names = (list) => list.map(ctx.sqName).sort();
// parseFen returns the board and sets turn/castling/epSq as globals, so read
// them back off the VM context rather than expecting a bundled object.
const load = (fen) => {
  const board = ctx.parseFen(fen);
  return { board, castling: ctx.castling, epSq: ctx.epSq, turn: ctx.turn };
};
const pd = (fen, from, cst) => {
  const st = load(fen);
  return names(ctx.premoveDests(sq(from), st.board, cst || st.castling));
};

test('enemy pieces do not block a premove ray, and can be landed on', () => {
  // White rook a1, black knight a4, empty above. A legal rook move stops at a4;
  // a premove may continue through it, because the knight may well move.
  const fen = 'r3k2r/8/8/8/n7/8/8/R3K2R w KQkq - 0 1';
  const dests = pd(fen, 'a1');
  assert.ok(dests.includes('a4'), 'may capture the enemy knight');
  assert.ok(dests.includes('a5'), 'may slide THROUGH the enemy knight');
  assert.ok(dests.includes('a8'), 'reaches the far end of the file');

  const st = load(fen);
  const legal = names(ctx.legalMovesFor(sq('a1'), st.board, st.epSq, st.castling));
  assert.ok(legal.includes('a4'), 'legal set also allows the capture');
  assert.ok(!legal.includes('a5'), 'but the legal set stops at the blocker');
});

test('our own pieces still block — nothing can move them aside first', () => {
  // White rook a1 with a white knight on a3.
  const dests = pd('4k3/8/8/8/8/N7/8/R3K3 w - - 0 1', 'a1');
  assert.ok(!dests.includes('a3'), 'cannot land on our own knight');
  assert.ok(!dests.includes('a5'), 'and cannot slide past it');
  assert.ok(dests.includes('a2'), 'the square before it is still offered');
});

test('a pawn may premove diagonally onto an empty square', () => {
  // The recapture you pre-commit to: nothing is on d5 or f5 yet.
  const dests = pd('4k3/8/8/4P3/8/8/8/4K3 w - - 0 1', 'e5');
  assert.ok(dests.includes('d6'), 'diagonal capture into empty air');
  assert.ok(dests.includes('f6'), 'both diagonals');
  assert.ok(dests.includes('e6'), 'and the ordinary push');
});

test('pawn double-step is offered past an ENEMY blocker but not our own', () => {
  assert.ok(pd('4k3/8/8/8/8/n7/P7/4K3 w - - 0 1', 'a2').includes('a4'),
    'enemy piece on a3 may move away, so a4 stays available');
  assert.ok(!pd('4k3/8/8/8/8/N7/P7/4K3 w - - 0 1', 'a2').includes('a4'),
    'our own knight on a3 will still be there');
});

test('check is not evaluated — a pinned piece may still be premoved', () => {
  // White knight d2 is pinned to the king by the rook on d8. Illegal now, but a
  // premove is fine: the opponent's move may break the pin, and if it doesn't,
  // the premove is simply discarded when it fires.
  const fen = '3rk3/8/8/8/8/8/3N4/3K4 w - - 0 1';
  const st = load(fen);
  assert.equal(ctx.legalMovesFor(sq('d2'), st.board, st.epSq, st.castling).length, 0,
    'the knight has no legal moves at all');
  assert.ok(pd(fen, 'd2').includes('f3'), 'but it can still be premoved');
});

test('king may premove onto an attacked square', () => {
  // e1 king, black rook on f8 covering the f-file. Kf1 is illegal now.
  const fen = '5r2/8/8/8/8/8/8/4K3 w - - 0 1';
  const st = load(fen);
  assert.ok(!names(ctx.legalMovesFor(sq('e1'), st.board, st.epSq, st.castling)).includes('f1'));
  assert.ok(pd(fen, 'e1').includes('f1'), 'premove offers it anyway');
});

test('castling is offered on rights + empty path, not on safety', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.ok(pd(fen, 'e1').includes('g1'), 'kingside');
  assert.ok(pd(fen, 'e1').includes('c1'), 'queenside');
  // Rights withdrawn → not offered.
  const noRights = { wK: false, wQ: false, bK: false, bQ: false };
  const dests = pd(fen, 'e1', noRights);
  assert.ok(!dests.includes('g1') && !dests.includes('c1'), 'no rights, no castle');
  // Path blocked by our own piece → not offered.
  assert.ok(!pd('r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1', 'e1').includes('g1'),
    'own bishop on f1 blocks the kingside path');
});

test('a knight is never offered a square holding one of our own pieces', () => {
  const dests = pd('4k3/8/8/8/8/2P5/8/1N2K3 w - - 0 1', 'b1');
  assert.ok(!dests.includes('c3'), 'our own pawn sits there');
  assert.ok(dests.includes('a3'), 'the other knight square is fine');
  assert.ok(dests.includes('d2'), 'and so is d2');
});

test('the speculative board chains: link 2 generates from where link 1 lands', () => {
  // Ng1, and we queue Nf3. The next link must come from f3, not g1.
  const st = load('4k3/8/8/8/8/8/8/4K1N1 w - - 0 1');
  const after = ctx.applyMove(sq('g1'), sq('f3'), st.board, -1, 'Q');
  assert.ok(!after[sq('g1')], 'knight has left g1');
  const second = names(ctx.premoveDests(sq('f3'), after, st.castling));
  assert.ok(second.includes('e5'), 'Nf3-e5 available on the speculative board');
  assert.ok(second.includes('g5'), 'and Nf3-g5');
  assert.equal(ctx.premoveDests(sq('g1'), after, st.castling).length, 0,
    'nothing left on g1 to move');
});

test('a chain can vacate a square for a later link', () => {
  // Bf1 then Rf1: illegal to queue Rf1 first, but fine once the bishop leaves.
  const st = load('4k3/8/8/8/8/8/8/4KB1R w K - 0 1');
  assert.ok(!names(ctx.premoveDests(sq('h1'), st.board, st.castling)).includes('f1'),
    'rook cannot reach f1 while our bishop is on it');
  const after = ctx.applyMove(sq('f1'), sq('c4'), st.board, -1, 'Q');
  assert.ok(names(ctx.premoveDests(sq('h1'), after, st.castling)).includes('f1'),
    'once the bishop premoves away, the rook may follow onto f1');
});

test('premove set is always a superset of the legal set', () => {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  ];
  for (const fen of fens) {
    const st = load(fen);
    for (let s = 0; s < 64; s++) {
      const p = st.board[s];
      if (!p || p.color !== 'w') continue;
      const legal = ctx.legalMovesFor(s, st.board, st.epSq, st.castling);
      const pre = new Set(ctx.premoveDests(s, st.board, st.castling));
      for (const d of legal) {
        // En passant is the one legal move a premove cannot express: the right
        // exists only for the single ply after the enemy's double-step, which
        // by definition has not happened when the premove is composed.
        const isEp = p.piece === 'P' && d === st.epSq;
        if (isEp) continue;
        assert.ok(pre.has(d),
          `${fen}: legal ${ctx.sqName(s)}->${ctx.sqName(d)} missing from premove set`);
      }
    }
  }
});

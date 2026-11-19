// The repertoire's move choice: the ticked lines (Nov 2026).
//
// A tester's Réti slot played 2.Nf3 against 1.e4 d5 (the Tennison Gambit)
// because the old matcher counted any line of the slot's ECO code. The rules
// now: follow the ticked lines; where they branch on the bot's move, the
// opening percentages and each opening's split decide; off the lines, step
// back in only when a ticked line is on the board or one legal bot move away,
// with one roll per opening per game at its own percentage.
//
// Same vm approach as the other engine tests: the pure chess layer plus the
// bot engine in one scope.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx() {
  const ctx = { console, window: {}, document: { getElementById: () => null }, setTimeout: (fn) => fn(),
                Math: Object.create(Math), botOpeningConfig: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  return ctx;
}
const ctx = makeCtx();

// A position after these SAN moves from the start.
function pos(sans) {
  let p = ctx.repFenPosition(ctx.REP_START_FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  for (const san of sans) {
    const m = ctx.algebraicToMove(san, p.bd, p.turn, p.ep, p.cst);
    assert.ok(m, 'illegal test move ' + san);
    const piece = p.bd[m.from];
    p = { bd: ctx.applyMove(m.from, m.to, p.bd, p.ep, m.promo || 'Q'),
          turn: p.turn === 'w' ? 'b' : 'w',
          cst: ctx.updateCastling(m.from, m.to, piece, p.cst),
          ep: ctx.computeEP(m.from, m.to, p.bd) };
  }
  return p;
}
const L = (code, name, moves) => ({ code, name, moves });
const WHITE = [
  { fam: 'Italian Game', name: 'Italian Game', pct: 65, lines: [
      L('C53', 'Italian Game: Classical Variation', 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3'),
      L('C51', 'Italian Game: Evans Gambit', 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4'),
      L('C55', "Italian Game: Two Knights Defense, Modern Bishop's Opening", 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3') ],
    fork: { 'e4 e5 Nf3 Nc6 Bc4 Bc5': { c3: 75, b4: 25 } } },
  { fam: 'Réti Opening', name: 'Réti Opening', pct: 30, lines: [ L('A09', 'Réti Opening', 'Nf3 d5 c4') ], fork: {} },
];
const BLACK = [
  { fam: 'French Defense', name: 'French Defense', pct: 60, lines: [
      L('C15', 'French Defense: Winawer Variation', 'e4 e6 d4 d5 Nc3 Bb4'),
      L('C11', 'French Defense: Classical Variation', 'e4 e6 d4 d5 Nc3 Nf6') ],
    fork: { 'e4 e6 d4 d5 Nc3': { Bb4: 70, Nf6: 30 } } },
  { fam: 'Sicilian Defense', name: 'Sicilian Defense', pct: 40, lines: [
      L('B90', 'Sicilian Defense: Najdorf Variation', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6') ], fork: {} },
];
const sans = d => Object.fromEntries((d.cands || []).map(c => [c.san, +c.p.toFixed(3)]));
const always = () => 0, never = () => 0.999;

test('on the lines: the first move splits by the opening percentages', () => {
  const R = ctx.repPrepare(WHITE, []);
  const d = ctx.repDecide(R, ctx.repNewState(), pos([]), always);
  assert.strictEqual(d.kind, 'line');
  // 65 / (65 + 30) and 30 / 95
  assert.deepStrictEqual(sans(d), { e4: 0.684, Nf3: 0.316 });
});

test('the Tennison case: after 1.e4 d5 the Réti is never played (no 2.Nf3)', () => {
  const R = ctx.repPrepare(WHITE, []);
  const st = ctx.repNewState();
  const d = ctx.repDecide(R, st, pos(['e4', 'd5']), always);
  assert.strictEqual(d.kind, 'main', JSON.stringify(sans(d)));
  assert.ok(d.ended, 'leaving the lines is reported');
  assert.strictEqual(st.mode, 'off');
  assert.strictEqual(d.rolls.length, 0, 'nothing in reach, so nothing rolled');
});

test('one move away: 1.Nf3 e5 steps back into the Italian with 2.e4, at its own 65%', () => {
  const R = ctx.repPrepare(WHITE, []);
  const st = ctx.repNewState();
  const d = ctx.repDecide(R, st, pos(['Nf3', 'e5']), () => 0.64);   // roll 64 < 65: in
  assert.strictEqual(d.kind, 'reenter');
  assert.deepStrictEqual(sans(d), { e4: 1 });
  assert.strictEqual(d.rolls[0].roll.pct, 65);
  // Not 2.Nxe5 ("The Walrus"), which the old ECO-code matcher played every time.
  const st2 = ctx.repNewState();
  const d2 = ctx.repDecide(R, st2, pos(['Nf3', 'e5']), () => 0.65);  // roll 65: out
  assert.strictEqual(d2.kind, 'main');
  assert.ok(st2.out.size === 1, 'a missed roll keeps the opening out');
  const again = ctx.repDecide(R, st2, pos(['Nf3', 'e5']), always);
  assert.strictEqual(again.kind, 'main', 'one roll per game: it stays out');
  assert.strictEqual(again.rolls.length, 0);
});

test('where the lines split on the bot\'s move, the opening\'s split decides', () => {
  const R = ctx.repPrepare(WHITE, []);
  const d = ctx.repDecide(R, ctx.repNewState(), pos(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']), always);
  assert.strictEqual(d.kind, 'line');
  assert.deepStrictEqual(sans(d), { c3: 0.75, b4: 0.25 });
  // No unticked Italian lines (Jerome Gambit 4.Bxf7+ and the rest).
  assert.ok(!('Bxf7+' in sans(d)) && !('Bxf7' in sans(d)));
});

test('where they split on the opponent\'s move, the bot follows whichever was played', () => {
  const R = ctx.repPrepare(WHITE, []);
  const d = ctx.repDecide(R, ctx.repNewState(), pos(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']), always);
  assert.deepStrictEqual(sans(d), { d3: 1 });
});

test('a line that ends hands over: after 4.c3 the next stage plays', () => {
  const R = ctx.repPrepare(WHITE, []);
  const st = ctx.repNewState();
  const d = ctx.repDecide(R, st, pos(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6']), always);
  assert.strictEqual(d.kind, 'main');
});

test('as Black: French 60 / Sicilian 40, then the Winawer / Classical split', () => {
  const R = ctx.repPrepare(BLACK, []);
  assert.deepStrictEqual(sans(ctx.repDecide(R, ctx.repNewState(), pos(['e4']), always)), { e6: 0.6, c5: 0.4 });
  assert.deepStrictEqual(sans(ctx.repDecide(R, ctx.repNewState(), pos(['e4', 'e6', 'd4', 'd5', 'Nc3']), always)),
    { Bb4: 0.7, Nf6: 0.3 });
});

test('a transposition onto a ticked line is a roll too: 1.d4 e6 2.e4 d5', () => {
  const R = ctx.repPrepare(BLACK, []);
  const st = ctx.repNewState();
  assert.strictEqual(ctx.repDecide(R, st, pos(['d4']), always).kind, 'main');   // 1.d4: off the lines
  const d = ctx.repDecide(R, st, pos(['d4', 'e6', 'e4']), () => 0.1);
  assert.strictEqual(d.kind, 'reenter');
  assert.deepStrictEqual(sans(d), { d5: 1 });                                   // not 2...d6
  assert.strictEqual(d.rolls[0].via, 'here');
});

test('the Najdorf by another move order', () => {
  const R = ctx.repPrepare(BLACK, []);
  const st = ctx.repNewState();
  st.mode = 'off';
  const d = ctx.repDecide(R, st, pos(['e4', 'c5', 'Nc3', 'd6', 'Nf3', 'Nf6', 'd4', 'cxd4', 'Nxd4']), always);
  assert.strictEqual(d.kind, 'reenter');
  assert.deepStrictEqual(sans(d), { a6: 1 });
});

test('a split saved before a move was added fits the moves there now', () => {
  const slot = { fork: { p: { c3: 75, b4: 25 } } };
  const w = ctx.repForkWeights(slot, 'p', ['c3', 'b4', 'd4']);
  assert.ok(Math.abs(w.c3 + w.b4 + w.d4 - 1) < 1e-9);
  assert.ok(Math.abs(w.c3 / w.b4 - 3) < 1e-9, 'the saved 75/25 keeps its proportion');
  const ev = ctx.repForkWeights({ fork: {} }, 'p', ['a', 'b']);
  assert.strictEqual(JSON.stringify(ev), JSON.stringify({ a: 0.5, b: 0.5 }));   // (objects from the vm realm)
});

test('an older slot (one ECO code + name) is the table entry it names', () => {
  const rows = [
    { eco: 'C50', name: 'Italian Game', sanMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
    { eco: 'C50', name: 'Italian Game: Jerome Gambit', sanMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Bxf7+'] },
  ];
  assert.deepStrictEqual(ctx.repSlotLines({ eco: 'C50', exactEco: 'C50', name: 'Italian Game', pct: 100 }, rows).map(x => x.moves),
    ['e4 e5 Nf3 Nc6 Bc4']);
  const R = ctx.repPrepare([{ eco: 'C50', exactEco: 'C50', name: 'Italian Game', pct: 100 }], rows);
  // After 3.Bc4 Bc5 the slot's line has ended: the Jerome Gambit is not played.
  assert.strictEqual(ctx.repDecide(R, ctx.repNewState(), pos(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']), always).kind, 'main');
});

test('a line with a move that is not legal stops where it is', () => {
  const R = ctx.repPrepare([{ fam: 'X', name: 'X', pct: 100, lines: [L('A00', 'X', 'e4 e5 Ke3')], fork: {} }], []);
  assert.strictEqual(R.maxPly, 2);
});

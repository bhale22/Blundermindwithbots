// Tests for the bot premove system in src/50-bot-engine.js.
//
// The premise being tested is the whole point of the feature: the bot commits
// to a reply BEFORE seeing the human's move, so a human who baits the
// prediction and then plays something else can punish the committed move.
// That means the tests that matter most are the ones where the premove is
// WRONG — the trap cases.
//
// Same vm trick as custom-controls.test.js: load the pure chess layer plus the
// bot engine into one shared global scope, stubbing only the touchpoints the
// premove path actually uses (Maia inference, DOM status line, executeMove).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

// Build a fresh context per test — premove state is module-global by design
// (it mirrors the browser), so tests must not share it.
function makeCtx() {
  const ctx = {
    console,
    window: {},
    document: { getElementById: () => null },
    indActive: () => false,
    setTimeout: (fn) => fn(),
    Math: Object.create(Math),
  };
  ctx.uciToSq = function (uci) {
    if (!uci || uci.length < 4) return null;
    return {
      from: ctx.fileRankToSq(uci.slice(0, 2)),
      to: ctx.fileRankToSq(uci.slice(2, 4)),
      promo: uci.length > 4 ? uci[4].toUpperCase() : null,
    };
  };
  ctx.sqToUci = function (from, to, promo) {
    return ctx.sqName(from) + ctx.sqName(to) + (promo || '');
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);

  // ── Stubs for the touchpoints the premove path reaches ────────────────────
  ctx.executed = [];
  ctx.executeMove = function (from, to, promo) {
    ctx.executed.push({ from, to, promo });
    ctx.board = ctx.applyMove(from, to, ctx.board, ctx.epSq, promo || 'Q');
    ctx.turn = ctx.turn === 'w' ? 'b' : 'w';
  };
  ctx.moveToSAN = () => 'stub';
  ctx.botRecordMove = () => {};
  ctx.botClockMs = () => null; // untimed unless a test overrides
  ctx.boardToFen = (bd, t) => 'fen:' + t;
  ctx.gameMovesAlgebraic = [];
  ctx.halfmoveClock = 0;
  ctx.gameOver = false;
  ctx.botActive = true;
  ctx._botGameGen = 0;
  ctx.lastBotMoveSource = null;
  ctx._maiaReady = true;
  return ctx;
}

// Load a position into the context's live globals (board/turn/castling/epSq).
function setPos(ctx, fen) {
  ctx.board = ctx.parseFen(fen);
  // parseFen assigns turn/castling/epSq inside the context already.
}

// Program the two-step Maia prediction: first call answers "what will the
// human play", second answers "what should the bot reply". Both are the real
// call sites the feature uses, in order.
function stubMaia(ctx, humanProbs, botProbs) {
  const queue = [humanProbs, botProbs];
  ctx.maia3GetMoveProbs = async () => queue.shift() || null;
}

const sq = (ctx, n) => ctx.fileRankToSq(n);

// ── Arming ───────────────────────────────────────────────────────────────────

test('arms a premove from Maia\'s predicted human move, then Maia\'s reply to it', async () => {
  const ctx = makeCtx();
  // Black (bot) to face 1.e4; predict e7e5 reply chain.
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';   // human is white, bot is black
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.botPremoveMinPct = 40;
  stubMaia(ctx, { e2e4: 0.8, d2d4: 0.2 }, { e7e5: 0.9, c7c5: 0.1 });

  await ctx.botPremoveArm();

  assert.ok(ctx.botActivePremove, 'a premove should be armed');
  assert.equal(ctx.botActivePremove.predictedUci, 'e2e4');
  assert.equal(ctx.botActivePremove.uci, 'e7e5');
  assert.equal(ctx.botActivePremove.from, sq(ctx, 'e7'));
  assert.equal(ctx.botActivePremove.to, sq(ctx, 'e5'));
  assert.equal(ctx.botPremoveStats.armed, 1);
});

test('does not arm when Maia is unsure of the human reply (below min confidence)', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.botPremoveMinPct = 60;              // require 60%
  stubMaia(ctx, { e2e4: 0.35, d2d4: 0.33 }, { e7e5: 0.9 }); // top is only 35%

  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null, 'murky position should not be premoved');
});

test('does not arm when the Maia model is unavailable', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx._maiaReady = false;                 // model not downloaded
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });

  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null, 'no model means no prediction, so no premove');
});

test('rate of 0 never arms; disabled never arms', async () => {
  for (const cfg of [{ botPremoveRatePct: 0 }, { botPremoveEnabled: false }]) {
    const ctx = makeCtx();
    setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    ctx.botPlayerColor = 'white';
    ctx.botPremoveEnabled = true;
    ctx.botPremoveRatePct = 100;
    Object.assign(ctx, cfg);
    stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
    await ctx.botPremoveArm();
    assert.equal(ctx.botActivePremove, null, JSON.stringify(cfg) + ' should not arm');
  }
});

test('low-clock gating: untimed games never premove when the gate is on', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.botPremoveOnlyLowClock = true;
  ctx.botPremoveOppClockSecs = 30;
  ctx.botPremoveClockSecs = 30;
  ctx.botClockMs = () => null;            // untimed — both clocks read null
  ctx.botOppClockMs = null;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });

  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null);
});

// Two independent triggers live under the low-clock gate: the opponent being
// low (play for the flag) and the bot itself being low (own desperation).
// Either alone arms a premove; 0 switches a trigger off.
async function armWithClocks(opts) {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.botPremoveOnlyLowClock = true;
  ctx.botPremoveOppClockSecs = opts.oppThreshold != null ? opts.oppThreshold : 0;
  ctx.botPremoveClockSecs    = opts.ownThreshold != null ? opts.ownThreshold : 0;
  ctx.botOppClockMs = opts.oppSecs != null ? opts.oppSecs * 1000 : null;
  ctx.botClockMs = () => (opts.ownSecs != null ? opts.ownSecs * 1000 : null);
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();
  return ctx.botActivePremove;
}

test('low-clock gating: arms once the BOT clock drops under its threshold', async () => {
  assert.equal(await armWithClocks({ ownThreshold: 30, ownSecs: 60, oppSecs: 300 }), null,
    '60s left is not a time scramble');
  assert.ok(await armWithClocks({ ownThreshold: 30, ownSecs: 10, oppSecs: 300 }),
    '10s left should premove');
});

test('low-clock gating: arms once the OPPONENT clock drops — playing for the flag', async () => {
  assert.equal(await armWithClocks({ oppThreshold: 30, oppSecs: 90, ownSecs: 300 }), null,
    'opponent at 90s is not flaggable yet');
  assert.ok(await armWithClocks({ oppThreshold: 30, oppSecs: 8, ownSecs: 300 }),
    'opponent at 8s should trigger flag-hunting premoves even with the bot on 300s');
});

test('either trigger alone is enough to arm a premove', async () => {
  // Opponent low, bot comfortable
  assert.ok(await armWithClocks({ oppThreshold: 30, ownThreshold: 30, oppSecs: 5, ownSecs: 600 }),
    'opponent-low alone should arm');
  // Bot low, opponent comfortable
  assert.ok(await armWithClocks({ oppThreshold: 30, ownThreshold: 30, oppSecs: 600, ownSecs: 5 }),
    'bot-low alone should arm');
  // Neither low
  assert.equal(await armWithClocks({ oppThreshold: 30, ownThreshold: 30, oppSecs: 600, ownSecs: 600 }), null,
    'neither low should not arm');
});

test('a threshold of 0 switches that trigger off without disabling the other', async () => {
  // Opponent trigger off; bot trigger still fires
  assert.ok(await armWithClocks({ oppThreshold: 0, ownThreshold: 30, oppSecs: 1, ownSecs: 5 }),
    'bot trigger should still work when the opponent trigger is off');
  // Opponent at 1s but its trigger is off, and the bot is comfortable
  assert.equal(await armWithClocks({ oppThreshold: 0, ownThreshold: 30, oppSecs: 1, ownSecs: 600 }), null,
    'a disabled opponent trigger must not fire even at 1s');
  // Both off
  assert.equal(await armWithClocks({ oppThreshold: 0, ownThreshold: 0, oppSecs: 1, ownSecs: 1 }), null,
    'both triggers off means no premoving');
});

test('untimed games never satisfy either trigger', async () => {
  assert.equal(await armWithClocks({ oppThreshold: 30, ownThreshold: 30, oppSecs: null, ownSecs: null }), null,
    'null clocks (untimed) cannot trigger a time scramble');
});

// ── Firing: the prediction was right ─────────────────────────────────────────

test('fires instantly when the human plays the predicted move', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();

  // Human actually plays the predicted 1.e4
  ctx.executeMove(sq(ctx, 'e2'), sq(ctx, 'e4'), null);
  ctx.executed = [];

  const fired = ctx.botPremoveTryFire();
  assert.equal(fired, true, 'premove should fire');
  assert.equal(ctx.executed.length, 1);
  assert.equal(ctx.executed[0].from, sq(ctx, 'e7'));
  assert.equal(ctx.executed[0].to, sq(ctx, 'e5'));
  assert.equal(ctx.botPremoveStats.fired, 1);
  assert.equal(ctx.botPremoveStats.busted, 0);
  assert.equal(ctx.lastBotMoveSource, 'PREMOVE');
});

test('fires even when the human plays something else, as long as it stays legal', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();

  // Human plays 1.d4 instead — e7e5 is still legal, so the premove commits to it
  ctx.executeMove(sq(ctx, 'd2'), sq(ctx, 'd4'), null);
  ctx.executed = [];

  assert.equal(ctx.botPremoveTryFire(), true);
  assert.equal(ctx.executed[0].to, sq(ctx, 'e5'), 'plays its committed move regardless');
});

// ── The trap: prediction was wrong and the premove is punished ───────────────

test('TRAP: premove is busted when the human\'s move exposes a pin on the premoved piece', async () => {
  const ctx = makeCtx();
  // The exact exploit this feature exists to train. Black (bot) has a knight
  // on e5 eyeing the bishop on c4, and a rook sits on e1 behind a white knight
  // on e3. While e3 is occupied, ...Nxc4 is perfectly legal, so the bot happily
  // commits to it. White then plays Ne3-d5, discovering the rook down the
  // e-file and pinning the black knight to its king: the committed ...Nxc4 is
  // now illegal, the premove is busted, and the human has won the exchange of
  // ideas rather than a piece.
  setPos(ctx, 'rnbqkbnr/pppp1ppp/8/4n3/2B5/4N3/PPPP1PPP/RNBQR1K1 w - - 0 1');
  ctx.botPlayerColor = 'white';   // human white, bot black
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  // Bot predicts a quiet white move and commits to grabbing the bishop.
  stubMaia(ctx, { d2d3: 0.9 }, { e5c4: 0.9 });
  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove.uci, 'e5c4', 'bot commits to ...Nxc4');

  // Human springs the trap instead: Ne3-d5 discovers the pin.
  ctx.executeMove(sq(ctx, 'e3'), sq(ctx, 'd5'), null);
  ctx.executed = [];

  const fired = ctx.botPremoveTryFire();
  assert.equal(fired, false, 'a pinned piece cannot execute its premove');
  assert.equal(ctx.executed.length, 0, 'no move should be executed');
  assert.equal(ctx.botPremoveStats.busted, 1, 'the trap should be counted as a bust');
  assert.equal(ctx.botActivePremove, null, 'busted premove is cleared so the bot thinks');
});

test('TRAP: premove is busted when the human captures the piece it was going to move', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { f3e5: 0.9 }, { f6e4: 0.9 }); // bot commits to moving the f6 knight
  await ctx.botPremoveArm();

  // White plays Nxe5 as predicted... but suppose instead the f6 knight is
  // removed from the board. Simulate the human capturing it.
  ctx.board[sq(ctx, 'f6')] = null;
  ctx.turn = 'b';

  assert.equal(ctx.botPremoveTryFire(), false, 'no piece on the from-square → cannot fire');
  assert.equal(ctx.botPremoveStats.busted, 1);
});

// ── Busted-premove tax ───────────────────────────────────────────────────────
// Busting a premove should cost the bot time: it committed, the commitment
// failed, and it now has to think from scratch. That extra delay is the user's
// reward for setting the trap.

test('busting a premove arms the re-evaluation tax', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppp1ppp/8/4n3/2B5/4N3/PPPP1PPP/RNBQR1K1 w - - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { d2d3: 0.9 }, { e5c4: 0.9 });
  await ctx.botPremoveArm();

  assert.equal(ctx._botPremoveBusted, false, 'no tax pending before the bust');
  // Human springs the discovered-pin trap
  ctx.executeMove(sq(ctx, 'e3'), sq(ctx, 'd5'), null);
  assert.equal(ctx.botPremoveTryFire(), false, 'premove should be busted');
  assert.equal(ctx._botPremoveBusted, true, 'the bust should arm the tax');
});

test('a premove that fires costs the bot nothing — it moved instantly', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();

  ctx.executeMove(sq(ctx, 'e2'), sq(ctx, 'e4'), null);
  assert.equal(ctx.botPremoveTryFire(), true);
  assert.equal(ctx._botPremoveBusted, false,
    'a fired premove must not tax the bot — the move already happened');
});

test('the tax is one-shot: it applies to the next move only', () => {
  const ctx = makeCtx();
  ctx.botPremoveBustDelayMs = 2000;
  ctx._botPremoveBusted = true;
  assert.equal(ctx.botPremoveBustTaxMs(), 2000, 'first call collects the tax');
  assert.equal(ctx.botPremoveBustTaxMs(), 0, 'second call collects nothing');
  assert.equal(ctx._botPremoveBusted, false, 'flag is consumed');
});

test('the tax is configurable, including zero for no penalty', () => {
  const ctx = makeCtx();
  for (const ms of [0, 500, 2000, 5000]) {
    ctx.botPremoveBustDelayMs = ms;
    ctx._botPremoveBusted = true;
    assert.equal(ctx.botPremoveBustTaxMs(), ms, 'tax of ' + ms + ' ms should be honoured');
  }
});

test('a negative delay can never speed the bot up', () => {
  const ctx = makeCtx();
  ctx.botPremoveBustDelayMs = -3000;
  ctx._botPremoveBusted = true;
  assert.equal(ctx.botPremoveBustTaxMs(), 0, 'negative config must clamp to zero');
});

test('botPremoveReset clears a pending tax so it cannot leak into a new game', () => {
  const ctx = makeCtx();
  ctx._botPremoveBusted = true;
  ctx.botPremoveReset();
  assert.equal(ctx._botPremoveBusted, false);
});

// ── Arming races the human ───────────────────────────────────────────────────
// Two Maia inferences run while the human is free to move. In fast games they
// routinely move first (inference is ~100-400 ms), and the premove must still
// arm: it was computed for the position they moved FROM, which is precisely
// what a premove is. This was a real bug — the bot silently skipped premoves
// for every quick recapture in a whole game.

test('the position is snapshotted, so a mid-inference human move cannot corrupt it', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.gameMovesAlgebraic = [];

  const seenFens = [];
  let call = 0;
  ctx.boardToFen = (bd, t) => {
    // Record which board object each FEN was built from
    const key = Object.keys(bd).sort().join(',');
    return 'fen:' + t + ':' + key.length;
  };
  ctx.maia3GetMoveProbs = async (fen) => {
    seenFens.push(fen);
    call++;
    if (call === 1) {
      // Human moves while inference 1 is in flight: mutate the live globals
      ctx.board = ctx.applyMove(sq(ctx, 'e2'), sq(ctx, 'e4'), ctx.board, -1, 'Q');
      ctx.turn = 'b';
      ctx.gameMovesAlgebraic.push('e4');
      return { e2e4: 0.9 };
    }
    return { e7e5: 0.9 };
  };

  await ctx.botPremoveArm();
  assert.ok(ctx.botActivePremove, 'premove must still arm after a mid-inference move');
  assert.equal(ctx.botActivePremove.uci, 'e7e5');
});

test('a premove overtaken by more than one ply is discarded as stale', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.gameMovesAlgebraic = [];

  let call = 0;
  ctx.maia3GetMoveProbs = async () => {
    call++;
    if (call === 1) {
      // Two further plies land while we were computing — the game has moved on
      ctx.gameMovesAlgebraic.push('e4', 'e5');
      return { e2e4: 0.9 };
    }
    return { e7e5: 0.9 };
  };

  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null,
    'a premove more than one ply behind the game must not arm');
});

test('arming reports failures instead of swallowing them', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  ctx.maia3GetMoveProbs = async () => { throw new Error('inference exploded'); };

  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null, 'a throw must not arm a bogus premove');
  assert.match(ctx.botPremoveLastError || '', /inference exploded/,
    'the failure must be recorded, not silently discarded');
});

// ── State hygiene ────────────────────────────────────────────────────────────

test('a premove never fires on the wrong side\'s turn', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();

  // Still white (human) to move — the bot must not fire.
  assert.equal(ctx.turn, 'w');
  assert.equal(ctx.botPremoveTryFire(), false);
  assert.equal(ctx.executed.length, 0);
});

test('a premove never fires after game over', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();

  ctx.executeMove(sq(ctx, 'e2'), sq(ctx, 'e4'), null);
  ctx.executed = [];
  ctx.gameOver = true;

  assert.equal(ctx.botPremoveTryFire(), false);
  assert.equal(ctx.executed.length, 0);
});

test('botPremoveReset clears the pending premove and the stats', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;
  stubMaia(ctx, { e2e4: 0.9 }, { e7e5: 0.9 });
  await ctx.botPremoveArm();
  assert.ok(ctx.botActivePremove);

  ctx.botPremoveReset();
  assert.equal(ctx.botActivePremove, null);
  assert.deepEqual(ctx.botPremoveStats, { armed: 0, fired: 0, busted: 0 });
});

test('a premove computed for a superseded position is discarded (generation guard)', async () => {
  const ctx = makeCtx();
  setPos(ctx, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botPremoveEnabled = true;
  ctx.botPremoveRatePct = 100;

  // Maia resolves slowly; the game is restarted while inference is in flight.
  ctx.maia3GetMoveProbs = async () => {
    ctx._botGameGen++;                     // simulate botStart/botStop mid-flight
    return { e2e4: 0.9 };
  };
  await ctx.botPremoveArm();
  assert.equal(ctx.botActivePremove, null, 'stale inference must not arm a premove');
});

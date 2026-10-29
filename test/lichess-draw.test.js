// Tests for how the bot answers a Lichess draw offer (src/50-bot-engine.js).
//
// On Lichess a move declines the opponent's standing draw offer. The bot used
// to put an offer that arrived mid-think off until its move was done — by
// which time its own move had declined it unread — and an armed premove fired
// straight past one. Now the answer comes first: just before the move goes out
// (_botAnswerDrawFirst), and a premove stands aside while an offer waits.
//
// Same vm approach as bot-premove.test.js, with the bridge's hooks stubbed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx(o) {
  o = o || {};
  const ctx = {
    console,
    window: {},
    document: { getElementById: () => null },
    indActive: () => false,
    setTimeout: (fn) => fn(),
    Math: Object.create(Math),
    atkMap: {},
    botMinProbPct: 0, botDayLower: 0, botDayUpper: 100, botBadDayMode: false,
    // Draw settings live in 10-app-shell.js; these are its defaults.
    botAcceptDraws: true, botDrawAcceptMargin: 200, botDrawUseObjectiveEval: false,
  };
  ctx.uciToSq = (uci) => (!uci || uci.length < 4) ? null : {
    from: ctx.fileRankToSq(uci.slice(0, 2)), to: ctx.fileRankToSq(uci.slice(2, 4)),
    promo: uci.length > 4 ? uci[4].toUpperCase() : null,
  };
  ctx.sqToUci = (from, to, promo) => ctx.sqName(from) + ctx.sqName(to) + (promo || '');
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);

  ctx.gameOver = false;
  ctx.botActive = true;
  ctx.botThinking = false;
  ctx.botPlayerColor = 'white';   // the human is White; the bot Black
  ctx.turn = 'w';                 // the human's turn unless a test says otherwise
  ctx._botDrawToast = () => {};
  // How the bot sees the position (cp, its own side), and how often it looked.
  ctx.looks = 0;
  ctx.botPerceivedAdvantageCp = async () => { ctx.looks++; return o.adv != null ? o.adv : 0; };
  // The bridge, as a Lichess game in progress with an offer standing.
  ctx.sent = [];
  ctx.pending = o.pending !== undefined ? o.pending : true;
  ctx.lichessGameLive = () => true;
  ctx.lichessSendDraw = (yes) => { ctx.sent.push(yes); if (ctx.pending) ctx.pending = false; };
  ctx.lichessDrawAwaitingAnswer = () => ctx.pending;
  ctx.lichessDrawAccepted = () => false;
  ctx.executed = [];
  ctx.executeMove = (from, to, promo) => { ctx.executed.push(ctx.sqToUci(from, to)); };
  ctx.moveToSAN = () => 'stub';
  ctx.botRecordMove = () => {};
  return ctx;
}

// ── Answering before the move ────────────────────────────────────────────────

test('an offer waiting as the bot is about to move is answered first — a losing bot takes it', async () => {
  const ctx = makeCtx({ adv: -900 });
  assert.equal(await ctx._botAnswerDrawFirst(), true, 'the move is not played');
  assert.deepEqual(ctx.sent, [true]);
});

test('a bot that is better declines first, then moves', async () => {
  const ctx = makeCtx({ adv: 600 });
  assert.equal(await ctx._botAnswerDrawFirst(), false, 'the move goes ahead');
  assert.deepEqual(ctx.sent, [false]);
});

test('nothing waiting: no look at the position, no answer', async () => {
  const ctx = makeCtx({ pending: false, adv: -900 });
  assert.equal(await ctx._botAnswerDrawFirst(), false);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.looks, 0);
});

test('an offer already answered (the bot took it) holds the move', async () => {
  const ctx = makeCtx({ pending: false });
  ctx.lichessDrawAccepted = () => true;
  assert.equal(await ctx._botAnswerDrawFirst(), true);
});

// ── An offer that arrives mid-think ──────────────────────────────────────────

test('on Lichess, an offer arriving mid-think is left for the move, not retried after it', async () => {
  const ctx = makeCtx({ adv: -900 });
  const timers = [];
  ctx.setTimeout = (fn) => { timers.push(fn); };
  ctx.botThinking = true;
  await ctx.botConsiderDrawOffer();
  assert.deepEqual(ctx.sent, [], 'not answered yet');
  assert.equal(timers.length, 0, 'no retry that would land after the move');
  ctx.botThinking = false;   // the move is ready: the answer comes first
  assert.equal(await ctx._botAnswerDrawFirst(), true);
  assert.deepEqual(ctx.sent, [true]);
});

test('off Lichess, an offer mid-think still waits and is retried', async () => {
  const ctx = makeCtx();
  ctx.lichessGameLive = () => false;
  const timers = [];
  ctx.setTimeout = (fn) => { timers.push(fn); };
  ctx.botThinking = true;
  await ctx.botConsiderDrawOffer();
  assert.equal(timers.length, 1);
});

test('a no that needs no thought (draws switched off) is given at once, even mid-think', async () => {
  const ctx = makeCtx({ adv: -900 });
  ctx.botAcceptDraws = false;
  ctx.botThinking = true;
  await ctx.botConsiderDrawOffer();
  assert.deepEqual(ctx.sent, [false]);
  assert.equal(ctx.looks, 0);
});

test('on the opponent\'s turn the bot answers at once', async () => {
  const ctx = makeCtx({ adv: -900 });
  ctx.botPlayerColor = 'white';   // the human is White
  ctx.turn = 'w';
  await ctx.botConsiderDrawOffer();
  assert.deepEqual(ctx.sent, [true]);
});

test('on the bot\'s own turn the answer waits for its move — after its thinking, before the move', async () => {
  const ctx = makeCtx({ adv: -900 });
  ctx.botPlayerColor = 'white';
  ctx.turn = 'b';                 // the offer came with White's move
  await ctx.botConsiderDrawOffer();
  assert.deepEqual(ctx.sent, []);
  assert.equal(await ctx._botAnswerDrawFirst(), true);
  assert.deepEqual(ctx.sent, [true]);
});

// ── Premoves ─────────────────────────────────────────────────────────────────

function armE5(ctx) {
  // 1.e4 played; the bot (Black) had premoved ...e5.
  ctx.board = ctx.parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  ctx.botPlayerColor = 'white';
  ctx.botActivePremove = { uci: 'e7e5', from: ctx.fileRankToSq('e7'), to: ctx.fileRankToSq('e5'), promo: null };
  ctx.botPremoveStats.armed = 1;
}

test('an armed premove stands aside while an offer waits', () => {
  const ctx = makeCtx();
  armE5(ctx);
  assert.equal(ctx.botPremoveTryFire(), false, 'the normal turn answers, then moves');
  assert.deepEqual(ctx.executed, []);
  assert.equal(ctx.botPremoveStats.busted, 0, 'not counted as busted — the human did not beat it');
  assert.equal(ctx.botPremoveStats.armed, 0);
});

test('with no offer waiting the premove fires as before', () => {
  const ctx = makeCtx({ pending: false });
  armE5(ctx);
  assert.equal(ctx.botPremoveTryFire(), true);
  assert.deepEqual(ctx.executed, ['e7e5']);
});

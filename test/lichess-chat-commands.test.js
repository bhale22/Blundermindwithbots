// Tests for the Lichess game chat's commands (src/65-lichess-bridge.js) and
// the engine state they set (src/50-bot-engine.js): think auto / mirror,
// degrade, pm and conf (premoves), book (the Lichess explorer), and temp as
// Maia's own temperature on a bot with no personality — what a player needs
// to dial a premoving Maia bot down to pure Maia.
//
// The parser and the reply splitter are pure; the engine hooks run in a vm
// like blend-temp.test.js. The whole flow, against a stand-in Lichess, is in
// scripts/verify-lichess-bridge.mjs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function bridgeCtx() {
  const ctx = {
    console, window: {},
    document: { getElementById: () => null, addEventListener() {} },
    LC_RATING_BUCKETS: [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '65-lichess-bridge.js'), 'utf8'), ctx);
  return ctx;
}

function engineCtx() {
  const ctx = {
    console: { log() {}, warn: console.warn },
    window: {},
    document: { getElementById: () => null },
    indActive: () => false,
    setTimeout: (fn) => fn(),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  ctx.window._bcpAttractorValues = {};
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCustomControls = [];
  ctx.botMaiaTempValue = 1.3;   // the builder's Temperature (10-app-shell.js)
  return ctx;
}

const parse = (ctx, s) => {
  const c = ctx._lbParseCommand(s);
  return c && JSON.parse(JSON.stringify(c));
};

test('think: seconds, auto (complexity) and mirror', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'think 15 s'), { think: 15 });
  assert.deepStrictEqual(parse(b, 'think auto'), { think: 'auto' });
  assert.deepStrictEqual(parse(b, 'Think Mirror'), { think: 'mirror' });
  assert.deepStrictEqual(parse(b, '"think mirror"'), { think: 'mirror' });
});

test('degrade on / off / auto', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'degrade off'), { degrade: 'off' });
  assert.deepStrictEqual(parse(b, 'Degradation ON'), { degrade: 'on' });
  assert.deepStrictEqual(parse(b, 'degrade auto'), { degrade: 'auto' });
  assert.strictEqual(parse(b, 'degrade'), null);
  assert.strictEqual(parse(b, 'degrade maybe'), null);
});

test('premove rate (pm) and certainty (conf)', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'pm90'), { pm: 90 });
  assert.deepStrictEqual(parse(b, 'premove 95%'), { pm: 95 });
  assert.deepStrictEqual(parse(b, 'premoves 0'), { pm: 0 });
  assert.deepStrictEqual(parse(b, 'pm off'), { pm: 0 }, 'off is a rate of 0');
  assert.deepStrictEqual(parse(b, 'pm auto'), { pm: 'auto' });
  assert.deepStrictEqual(parse(b, 'conf95'), { conf: 95 });
  assert.deepStrictEqual(parse(b, 'pm conf 80%'), { conf: 80 }, 'pm conf is the certainty, not a rate');
  assert.deepStrictEqual(parse(b, 'certainty 70'), { conf: 70 });
  assert.deepStrictEqual(parse(b, 'confidence auto'), { conf: 'auto' });
  assert.deepStrictEqual(parse(b, 'pm50 conf90'), { pm: 50, conf: 90 });
  assert.strictEqual(parse(b, 'conf off'), null, 'certainty has no off: 0 would premove on anything');
});

test('book: off, a depth, a depth and a rating', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'book off'), { book: 'off' });
  assert.deepStrictEqual(parse(b, 'book auto'), { book: 'auto' });
  assert.deepStrictEqual(parse(b, 'book on'), { book: 'on' });
  assert.deepStrictEqual(parse(b, 'book 10'), { book: { depth: 10, rating: null } });
  assert.deepStrictEqual(parse(b, 'book 10 1800'), { book: { depth: 10, rating: 1800 } });
  assert.deepStrictEqual(parse(b, 'book10/1800'), { book: { depth: 10, rating: 1800 } });
  assert.deepStrictEqual(parse(b, 'book 12 @ 2200'), { book: { depth: 12, rating: 2200 } });
  // A rating right after book is the book's, never the bot's.
  assert.deepStrictEqual(parse(b, 'book 10 elo1800'), { book: { depth: 10, rating: 1800 } });
  assert.deepStrictEqual(parse(b, 'book 10 1800elo'), { book: { depth: 10, rating: 1800 } });
  assert.deepStrictEqual(parse(b, 'ELO1500 book 10'), { elo: 1500, book: { depth: 10, rating: null } });
  assert.strictEqual(parse(b, 'book'), null);
});

test('temp still parses as before, and as "temperature"', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'temp1'), { temp: 1 });
  assert.deepStrictEqual(parse(b, 'temp .5'), { temp: 0.5 });
  assert.deepStrictEqual(parse(b, 'temperature 1.2'), { temp: 1.2 });
  assert.deepStrictEqual(parse(b, 'temp auto'), { temp: 'auto' });
});

test('pure Maia in one line, and what is not a command', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(parse(b, 'ELO1500 temp1 think mirror degrade off pm0 book off'),
    { elo: 1500, temp: 1, think: 'mirror', degrade: 'off', pm: 0, book: 'off' });
  assert.deepStrictEqual(parse(b, 'pm90, conf 95, degrade on, book 8 1600'),
    { pm: 90, conf: 95, degrade: 'on', book: { depth: 8, rating: 1600 } });
  assert.strictEqual(parse(b, 'pm 90 please'), null, 'a line that is more than commands');
  assert.strictEqual(parse(b, 'pm90 pm80'), null, 'one of each a line');
  assert.strictEqual(parse(b, 'book off book 10'), null);
  assert.strictEqual(parse(b, 'I premove a lot'), null);
});

test('a reply too long for a chat line splits where its parts join', () => {
  const b = bridgeCtx();
  assert.deepStrictEqual(Array.from(b._lbChatLines('short')), ['short']);
  const parts = Array.from({ length: 12 }, (_, i) => 'part number ' + i + ' of the reply');
  const lines = Array.from(b._lbChatLines(parts.join(', ')));
  assert.ok(lines.length > 1);
  assert.ok(lines.every(l => l.length <= 140), lines);   // LB_CHAT_MAX
  assert.strictEqual(lines.join(' ').replace(/, ?/g, ' '), parts.join(' '));
});

test('the explorer band as the reply gives it', () => {
  const b = bridgeCtx();
  assert.strictEqual(b._lbBandText('1800'), '1800-1999');
  assert.strictEqual(b._lbBandText('0'), '0-999');
  assert.strictEqual(b._lbBandText('2200,2500'), '2200+');
});

test('a chat Maia temperature replaces the built one; 0 plays the top move', () => {
  const e = engineCtx();
  assert.strictEqual(e.botMaiaBaseTemp(), 1.3, 'as built');
  e.botChatMaiaTemp = 0.5;
  assert.strictEqual(e.botMaiaBaseTemp(), 0.5);
  e.window._bcpHustlerTempMode = true;
  e.hustlerPhaseTemp = () => 3;
  assert.strictEqual(e.botMaiaBaseTemp(), 0.5, 'ahead of the Hustler override too');
  e.window._bcpHustlerTempMode = false;
  e.botChatMaiaTemp = 0;
  assert.strictEqual(e.botMaiaBaseTemp(), 1.3, 'temperature 0 is no temperature: it is the top move');
  const probs = { e2e4: 0.3, d2d4: 0.5, g1f3: 0.2 };
  vm.runInContext('Math.random = () => 0.999;', e);   // would sample the last move
  e.botConvictionPct = 0;
  for (let i = 0; i < 5; i++) assert.strictEqual(e.pickFromProbs(probs, 1), 'd2d4');
  e.botChatMaiaTemp = null;
  assert.notStrictEqual(e.pickFromProbs(probs, 1), 'd2d4', 'without it the roll samples');
});

test('botWeighsMoves: what counts as a personality', () => {
  const e = engineCtx();
  assert.strictEqual(e.botWeighsMoves(), false, 'nothing set: pure Maia');
  e.window._bcpAttractorValues = { hustle: 3, luck: -2, pressure: 4, compwin: 1, tension: 0 };
  assert.strictEqual(e.botWeighsMoves(), false, 'Hustle, Luck, Calm/Panicky and Front-runner do not rank moves');
  e.window._bcpAttractorValues = { tension: 2 };
  assert.strictEqual(e.botWeighsMoves(), true);
  e.window._bcpAttractorValues = {};
  e.window._bcpPieceValues = { knight: 1 };
  assert.strictEqual(e.botWeighsMoves(), true);
  e.window._bcpPieceValues = {};
  e.window._bcpCustomControls = [{ value: 0 }, { value: 5 }];
  assert.strictEqual(e.botWeighsMoves(), true);
  e.window._bcpCustomControls = [];
  e.botBlindConviction = true;
  assert.strictEqual(e.botWeighsMoves(), true);
});

test('the chat book: its band, its depth, and out of book for good', async () => {
  const e = engineCtx();
  const asked = [];
  let games = true;
  e.lcSelectedRating = '1500';
  e.maiaGetMoveProbs = async () => { asked.push(e.lcSelectedRating); return games ? { e2e4: 0.6, d2d4: 0.4 } : null; };
  e.preferredOpeningActive = true; e.mainLineActive = true; e.lichessExplorerActive = true;
  e.botMoveHistory = [];
  e.botChatBook = null;
  e.botChatBookTakeOver();
  assert.strictEqual(e.preferredOpeningActive, true, 'no chat book: the bot\'s own openings stand');
  assert.strictEqual(await e.botChatBookProbs('fen'), null);

  e.botChatBook = { depth: 0 };
  e.botChatBookTakeOver();
  assert.deepStrictEqual([e.preferredOpeningActive, e.mainLineActive, e.lichessExplorerActive], [false, false, false],
    'book off: Repertoire, Main Line and explorer all off');
  assert.strictEqual(await e.botChatBookProbs('fen'), null, 'and nothing in their place');

  e.botChatBook = { depth: 2, band: '1800' };
  e.botChatBookTakeOver();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await e.botChatBookProbs('fen'))), { e2e4: 0.6, d2d4: 0.4 });
  assert.deepStrictEqual(asked, ['1800'], 'asked at the band');
  assert.strictEqual(e.lcSelectedRating, '1500', 'and the global put back');
  e.botMoveHistory = ['e2e4', 'e7e5', 'g1f3'];
  assert.ok(await e.botChatBookProbs('fen'), 'move 2 is still within book 2');
  e.botMoveHistory = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
  assert.strictEqual(await e.botChatBookProbs('fen'), null, 'past move 2: the engine');
  e.botMoveHistory = [];
  assert.strictEqual(await e.botChatBookProbs('fen'), null, 'and it stays over for the game');

  e.botChatBookTakeOver();   // a new game
  games = false;
  assert.strictEqual(await e.botChatBookProbs('fen'), null, 'too few games: out of book');
  games = true;
  assert.strictEqual(await e.botChatBookProbs('fen'), null, 'for the rest of the game');
});

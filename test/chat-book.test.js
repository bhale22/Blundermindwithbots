// The opening book a Lichess opponent asks for in the chat (book on / off),
// as the engine plays it (src/40-engines.js, src/50-bot-engine.js): on, a
// Chess960 game plays the Lichess explorer's most common move, which stays in
// book longest, and a standard game each move as often as Lichess players
// chose it, from the Lichess database whatever the Main Line was built with
// (Ben, Nov 22). null is the bot's own book as built. The chat side is in
// lichess-chat-commands.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx() {
  const ctx = {
    console: { log() {}, warn() {} }, window: {}, navigator: {},
    document: { getElementById: () => null },
    performance: { now: () => 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {},
    indActive: () => false,
    LC_RATING_BUCKETS: [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '40-engines.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  // As the app shell declares them.
  Object.assign(ctx, {
    chess960: false, _gameStartFen: null, botActive: true, gameOver: false,
    mainLineActive: false, preferredOpeningActive: false, botOpeningMode: 'none',
    botOpeningConfig: { source: 'masters', since: '2020-01', book960: 'off', maxBookDepth: 20 },
    botBookRatingElo: () => 1500, bookMinGames: () => 4,
  });
  return ctx;
}
const book = (ctx, v) => vm.runInContext('botChatBook = ' + v, ctx);
// Three book moves, 70 / 20 / 10 games.
const MOVES = [
  { uci: 'e2e4', white: 30, draws: 10, black: 30 },
  { uci: 'd2d4', white: 10, draws: 0, black: 10 },
  { uci: 'c2c4', white: 5, draws: 0, black: 5 },
];

test('Chess960: the chat\'s book is the most common move; off is no book; null is the bot\'s own row', () => {
  const c = makeCtx();
  c.chess960 = true;
  c.botOpeningConfig.book960 = 'sample';
  book(c, 'true');
  assert.strictEqual(c.botBook960Mode(), 'top');
  book(c, 'false');
  assert.strictEqual(c.botBook960Mode(), 'off');
  book(c, 'null');
  assert.strictEqual(c.botBook960Mode(), 'sample', 'as built');
  c.chess960 = false;
  book(c, 'true');
  assert.strictEqual(c.botBook960Mode(), 'off', 'a standard game has no Chess960 book');
});

test('standard: the chat\'s book asks the Lichess database, all years, whatever the Main Line was built with', () => {
  const c = makeCtx();
  book(c, 'null');
  let q = c._openingBookQuery();
  assert.strictEqual(q.src, 'masters');
  assert.strictEqual(q.since, '2020-01');
  book(c, 'true');
  q = c._openingBookQuery();
  assert.strictEqual(q.src, 'lichess');
  assert.strictEqual(q.since, null);
  assert.strictEqual(q.variant, 'standard');
  assert.ok(c.openingCacheKey([]).startsWith('standard|lichess||'), 'cached apart from the built book');
});

test('the move: sampled in standard, the most common in Chess960, the most common as built', async () => {
  const c = makeCtx();
  c.openingExplorerFetch = async () => ({ moves: MOVES.map(m => Object.assign({}, m)) });
  const pick = async (r) => { c.Math.random = () => r; return c.botGetOpeningMove([]); };
  vm.runInContext('Math = Object.create(Math)', c);
  book(c, 'true');
  assert.strictEqual(await pick(0.5), 'e2e4');
  assert.strictEqual(await pick(0.75), 'd2d4', 'past 70% of the games: the second move');
  assert.strictEqual(await pick(0.95), 'c2c4');
  c.chess960 = true;
  assert.strictEqual(await pick(0.95), 'e2e4', 'Chess960: the most common, whatever the roll');
  c.chess960 = false;
  book(c, 'null');
  assert.strictEqual(await pick(0.95), 'e2e4', 'the built Main Line: the most popular move');
});

test('a choice made mid-game takes effect from the next move; nothing when the bot plays its own', () => {
  const c = makeCtx();
  book(c, 'true');
  c.botApplyChatBookNow();
  assert.strictEqual(c.mainLineActive, true);
  assert.strictEqual(c.botOpeningMode, 'mainline');
  book(c, 'false');
  c.botApplyChatBookNow();
  assert.strictEqual(c.mainLineActive, false);
  assert.strictEqual(c.botOpeningMode, 'none');
  c.chess960 = true;
  book(c, 'true');
  c.botApplyChatBookNow();
  assert.strictEqual(c.mainLineActive, true, 'Chess960 too');
  c.mainLineActive = 'untouched';
  book(c, 'null');
  c.botApplyChatBookNow();
  assert.strictEqual(c.mainLineActive, 'untouched');
  book(c, 'true');
  c.gameOver = true;
  c.botApplyChatBookNow();
  assert.strictEqual(c.mainLineActive, 'untouched', 'not after the game');
});

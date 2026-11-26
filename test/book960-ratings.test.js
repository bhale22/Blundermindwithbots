// The Chess960 book's Ratings (Nov 26 2026, a tester: at one rating group the
// 960 book ran out within a move or two). The builder's 960 row sets a band
// of the Lichess explorer's rating groups, each end a group or the engine's
// own group (null); lcRatingBandParam (src/40-engines.js) turns it into the
// explorer's `ratings`. A fixed end is always kept, and the engine's end
// stretches to meet it. Both null is the one group the book always asked for.
// Standard games are untouched.

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
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '40-engines.js'), 'utf8'), ctx);
  Object.assign(ctx, {
    chess960: false, _gameStartFen: null, botChatBook: null,
    botOpeningConfig: { source: 'lichess', book960: 'top', book960From: null, book960To: null, maxBookDepth: 20 },
    botBookRatingElo: () => 1500, bookMinGames: () => 4,
  });
  return ctx;
}
const band = (c, elo, from, to) => c.lcRatingBandParam(elo, from, to);

test('no Ratings set: the one group the engine is in, exactly as before', () => {
  const c = makeCtx();
  for (const elo of [600, 999, 1000, 1487, 1599, 1600, 2199, 2200, 2400, 2600]) {
    assert.strictEqual(band(c, elo, null, null), c.lcRatingParam(elo), 'at ' + elo);
  }
  assert.strictEqual(band(c, 2300, null, null), '2200,2500', '2200+ is still 2200 and 2500');
});

test('both ends set: that band, whatever the engine plays at', () => {
  const c = makeCtx();
  assert.strictEqual(band(c, 1500, 1000, 1800), '1000,1200,1400,1600,1800');
  assert.strictEqual(band(c, 2600, 1000, 1800), '1000,1200,1400,1600,1800');
  assert.strictEqual(band(c, 600, 0, 2500), '0,1000,1200,1400,1600,1800,2000,2200,2500', 'every rating');
  assert.strictEqual(band(c, 1500, 1800, 1000), '1000,1200,1400,1600,1800', 'ends the wrong way round: swapped');
  assert.strictEqual(band(c, 1500, 2000, 2000), '2000');
});

test('one end set: the engine\'s group stretches to meet it', () => {
  const c = makeCtx();
  assert.strictEqual(band(c, 1500, null, 2500), '1400,1600,1800,2000,2200,2500', 'the engine\'s group and up');
  assert.strictEqual(band(c, 1500, 1000, null), '1000,1200,1400', 'down to 1000');
  assert.strictEqual(band(c, 1500, 1800, null), '1800', 'a lowest end above the engine: that end is kept');
  assert.strictEqual(band(c, 1500, null, 1200), '1200', 'a highest end below the engine: that end is kept');
  assert.strictEqual(band(c, 2300, 1800, null), '1800,2000,2200,2500', 'up to the top of 2200+');
  assert.strictEqual(band(c, 2300, null, 2200), '2200', 'a highest end of 2200 leaves 2500 out');
});

test('an end that is not a Lichess group counts as the engine\'s', () => {
  const c = makeCtx();
  assert.strictEqual(band(c, 1500, 1500, null), '1400');
  assert.strictEqual(band(c, 1500, '', '1800'), '1400,1600,1800', 'a string from the builder\'s list reads');
  assert.strictEqual(band(c, 1500, undefined, 'x'), '1400');
});

test('the 960 book asks for the band; a standard game\'s book never does', () => {
  const c = makeCtx();
  c.botOpeningConfig.book960From = 1000;
  c.botOpeningConfig.book960To = 2500;
  c.chess960 = true;
  let q = c._openingBookQuery();
  assert.strictEqual(q.variant, 'chess960');
  assert.strictEqual(q.ratings, '1000,1200,1400,1600,1800,2000,2200,2500');
  assert.ok(c.openingCacheKey([]).includes('|1000,1200,1400,1600,1800,2000,2200,2500|'), 'cached by the band');
  c.chess960 = false;
  q = c._openingBookQuery();
  assert.strictEqual(q.ratings, '1400', 'standard: the engine\'s group, as always');
});

test('a matching Lichess bot: a set end stays put, the engine\'s end moves with each challenger', () => {
  const c = makeCtx();
  c.chess960 = true;
  c.botOpeningConfig.book960To = 2500;
  c.botBookRatingElo = () => 1100;
  assert.strictEqual(c._openingBookQuery().ratings, '1000,1200,1400,1600,1800,2000,2200,2500');
  c.botBookRatingElo = () => 2100;
  assert.strictEqual(c._openingBookQuery().ratings, '2000,2200,2500');
});

// Premoving against a bot, at speed-chess timings.
//
// The bug this guards: premove composition used to be gated on `botThinking`,
// which is only true while the engine is actually computing. The bot's TURN is
// wider than that — botPostMoveHook schedules botMakeMove on a 100 ms timer,
// and the book/bot-premove paths clear the flag before executeMove. With think
// time set to "instant" the inference can be shorter than the 100 ms gap in
// front of it, so most of the bot's turn silently refused premoves, the moment
// right after the player released their own move very much included.
//
// The decisive assertions are synchronous: run in the same tick as the human's
// move, before any timer can fire. That is the worst case, and the one a speed
// player hits every single move.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('premove during the bot\'s turn', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  // A genuinely fresh game. The saved-session restore is per-origin and would
  // otherwise hand the next test the previous one's position, mid-game.
  async function startInstantBotGame() {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2500);
    await H.dismissLanding(page);
    await page.evaluate(() => {
      botSetPlayerColor('white');
      botSetTC('blitz3');
      maia3SetRating(1700);
      botSetTab('maia3');
      botSetTimeBehavior('instant');
      botStart();
    });
    await page.waitForTimeout(1500);
    assert.ok(await page.evaluate(() => botActive), 'bot game should be active');
    assert.deepStrictEqual(await page.evaluate(() => gameMovesAlgebraic.slice()), [],
      'game should start empty');
  }

  test('the bot owns the move the instant the human move lands', async () => {
    await startInstantBotGame();
    // Same tick as executeMove: botMakeMove has not run, so botThinking is
    // still false. The board must nonetheless treat this as the bot's turn.
    const s = await page.evaluate(() => {
      executeMove(52, 36); // e4
      return { thinking: botThinking, turn, waiting: isWaitingTurn(), onMove: botOnMove() };
    });
    assert.strictEqual(s.turn, 'b', 'turn should have flipped to the bot');
    assert.strictEqual(s.thinking, false, 'botThinking is not set yet — that is the point');
    assert.strictEqual(s.onMove, true, 'botOnMove() should be true');
    assert.strictEqual(s.waiting, true, 'isWaitingTurn() must be true in the scheduling gap');
  });

  test('a premove queues in that gap and plays on the bot\'s reply', async () => {
    await startInstantBotGame();
    // Queue and read back in one tick — with an instant bot the queue drains
    // within ~200 ms, so a second round trip would race the reply.
    const q = await page.evaluate(() => {
      executeMove(52, 36);                  // e4
      const ok = tryCommit(62, 45);         // Nf3, premoved in the same tick
      return { ok, queue: premoveQueue.slice() };
    });
    assert.strictEqual(q.ok, true, 'tryCommit should queue the premove');
    assert.deepStrictEqual(q.queue, [{ from: 62, to: 45, promo: null }],
      'the premove should be sitting in the queue');

    await page.waitForTimeout(6000);
    const moves = await page.evaluate(() => gameMovesAlgebraic.slice());
    assert.ok(moves.length >= 3, 'bot replied and the premove fired: ' + moves.join(' '));
    assert.strictEqual(moves[0], 'e4');
    assert.strictEqual(moves[2], 'Nf3', 'the premove should be move 3: ' + moves.join(' '));
    assert.deepStrictEqual(await page.evaluate(() => premoveQueue.slice()), [],
      'queue should be drained');
  });

  test('a premove queues through the real drag path during the bot\'s turn', async () => {
    await startInstantBotGame();
    const mouse = H.mouseDriver(page);
    // A drag takes longer than an instant bot's whole turn, so hold the bot on
    // move for the duration — otherwise the drop lands on our own turn again
    // and the test would be exercising an ordinary move.
    await page.evaluate(() => {
      window.__realSetTimeout = window.setTimeout;
      window.setTimeout = function (fn) {
        if (fn === botMakeMove) return 0; // never let the bot think
        return window.__realSetTimeout.apply(window, arguments);
      };
      executeMove(52, 36); // e4
    });
    await mouse.drag(await H.squareCentre(page, 6, 1), await H.squareCentre(page, 5, 3));
    const after = await page.evaluate(() => ({
      queue: premoveQueue.slice(), moves: gameMovesAlgebraic.slice(),
    }));
    await page.evaluate(() => { window.setTimeout = window.__realSetTimeout; });

    assert.deepStrictEqual(after.moves, ['e4'], 'the bot must still be on move');
    assert.deepStrictEqual(after.queue, [{ from: 62, to: 45, promo: null }],
      'dragging g1->f3 during the bot\'s turn should queue a premove');
  });

  test('a drop that is illegal on the live board is refused, not played', async () => {
    // A piece picked up during the bot's turn carries the optimistic
    // premoveDests set. If the bot replies mid-drag the turn is ours again and
    // that set is wrong — executeMove validates nothing, so tryCommit must.
    await startInstantBotGame();
    const res = await page.evaluate(() => {
      // Ke1 (60) to e2 (52) is in no legal set — e2 holds our own pawn — but a
      // stale legalMoves offers it. It is our turn, so this is the real-move
      // path, not the premove one.
      legalMoves = [52];
      const before = turn;
      const played = tryCommit(60, 52);
      return { played, before, after: turn,
        moves: gameMovesAlgebraic.slice(), e2: board[52] ? board[52].piece : null };
    });
    assert.strictEqual(res.before, 'w', 'should be the human\'s turn for this case');
    assert.strictEqual(res.played, false, 'illegal move must be refused');
    assert.strictEqual(res.after, 'w', 'the turn must not have flipped');
    assert.deepStrictEqual(res.moves, [], 'nothing should have been played');
    assert.strictEqual(res.e2, 'P', 'the pawn on e2 should be untouched');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

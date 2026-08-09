// A game must survive the phone backgrounding the app.
//
// Android discards a backgrounded WebView under memory pressure — and this app
// is a fat target, with a 44MB Maia net and Stockfish WASM resident. When it
// comes back the page has RELOADED. Before the session snapshot existed, that
// dropped the user on the landing screen with the game gone, because nothing
// about a live game was ever persisted.
//
// The failure was silent, which is what makes this suite worth having: a
// broken snapshot looks like a perfectly healthy game right up until the
// moment someone tries to resume one.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('session restore', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    // One persistent context, so localStorage survives the reload as on a phone.
    ctx = await H.phoneContext(browser);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function load() {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2200);   // let the load-handler restore fire
  }
  // What Android does before discarding the page.
  async function background() {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
  }
  const snapshot = () => page.evaluate(() => localStorage.getItem('bm_liveGame'));
  const fen = () => page.evaluate(() => boardToFen(board, turn, castling, epSq, halfmoveClock, 1));
  const moves = () => page.evaluate(() => gameMovesAlgebraic.slice());

  let beforeFen, beforeMoves;

  test('a snapshot is written after moves, without needing to background', async () => {
    await load();
    await H.dismissLanding(page);
    await page.evaluate(() => {
      executeMove(52, 36);   // e4
      executeMove(12, 28);   // e5
      executeMove(62, 45);   // Nf3
    });
    await page.waitForTimeout(400);

    beforeFen = await fen();
    beforeMoves = await moves();
    assert.strictEqual(beforeMoves.length, 3, 'three moves played: ' + beforeMoves.join(' '));
    assert.ok(await snapshot(), 'snapshot should exist mid-game');
  });

  test('the snapshot survives backgrounding', async () => {
    await background();
    assert.ok(await snapshot());
  });

  test('after the page is discarded and reloaded, the game is restored', async () => {
    await load();
    assert.strictEqual(await H.landingVisible(page), false, 'landing must not be shown');
    assert.strictEqual(await fen(), beforeFen, 'position must be identical');
    assert.deepStrictEqual(await moves(), beforeMoves, 'move list must be identical');
    assert.strictEqual(await page.evaluate(() => turn), 'b', 'correct side still to move');
  });

  test('the resume is announced', async () => {
    assert.strictEqual(await page.locator('#bm-session-toast').count(), 1);
  });

  test('"Start fresh" clears the snapshot and returns to the landing', async () => {
    await page.locator('#bm-session-toast button').click();
    await page.waitForTimeout(600);
    assert.strictEqual(await snapshot(), null, 'snapshot should be cleared');

    await load();
    assert.strictEqual(await H.landingVisible(page), true, 'landing should be shown again');
    assert.strictEqual((await moves()).length, 0, 'board should be back to the start');
  });

  test('a finished game is not left resumable', async () => {
    await H.dismissLanding(page);
    await page.evaluate(() => { executeMove(52, 36); });
    await page.waitForTimeout(300);
    assert.ok(await snapshot(), 'precondition: snapshot exists mid-game');

    await page.evaluate(() => { gameOver = true; gameOverMsg = 'test'; updatePlayerBoxes(); });
    await page.waitForTimeout(300);
    assert.strictEqual(await snapshot(), null, 'snapshot should be cleared once the game ends');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

// Tap the piece, then its square, on a phone, in the default commit mode
// (release). Before Nov 2026 the second tap put the piece down instead: the
// move was only ever set up by the hover preview a mouse makes crossing the
// board, and a finger has no hover. Premoves had the same gap: with one
// queued, a tap on the next premove's square cleared the whole queue.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

const sqOf = (f, r) => (8 - r) * 8 + f;   // file 0-7, rank 1-8 → board index

describe('tap-to-move on touch, release mode (' + H.PHONE_DEVICE + ')', { concurrency: 1 }, () => {
  let server, browser, ctx, page, touch;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await H.phoneContext(browser);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function freshBoard() {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1600);
    await H.dismissLanding(page);
    touch = H.touchDriver(await ctx.newCDPSession(page), page);
    await page.evaluate(() => setCommitMode('release'));
  }
  const tap = async (f, r) => touch.tap(await H.squareCentre(page, f, r));

  test('the default mode is release', async () => {
    await freshBoard();
    assert.strictEqual(await page.evaluate(() => boardCommitMode), 'release');
  });

  test('tap e2, tap e4: the pawn moves', async () => {
    await tap(4, 2); await tap(4, 4);
    assert.strictEqual(await H.pieceAt(page, sqOf(4, 4)), 'wP');
    assert.strictEqual(await H.pieceAt(page, sqOf(4, 2)), null);
    assert.strictEqual(await page.evaluate(() => turn), 'b');
  });

  test('and for Black: tap d7, tap d5', async () => {
    await tap(3, 7); await tap(3, 5);
    assert.strictEqual(await H.pieceAt(page, sqOf(3, 5)), 'bP');
  });

  test('a capture by two taps: exd5', async () => {
    await tap(4, 4); await tap(3, 5);
    assert.strictEqual(await H.pieceAt(page, sqOf(3, 5)), 'wP');
    assert.strictEqual(await H.pieceAt(page, sqOf(4, 4)), null);
  });

  test('a tap on a square the piece cannot reach puts it down, and nothing moves', async () => {
    await tap(3, 8);                         // the black queen
    assert.ok(await page.evaluate(() => selSq >= 0), 'queen picked up');
    await tap(0, 1);                         // a1: not a queen move from d8
    assert.ok(await page.evaluate(() => selSq < 0), 'put down');
    assert.strictEqual(await H.pieceAt(page, sqOf(3, 8)), 'bQ');
    assert.strictEqual(await page.evaluate(() => turn), 'b');
  });

  test('two premoves tapped in during the bot\'s turn both stay queued', async () => {
    await freshBoard();
    await page.evaluate(() => {
      botSetPlayerColor('white');
      botSetTab('sf');
      botStart();
    });
    await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => botActive), 'bot game active');
    // A long think, so the bot is still on move while the premoves go in.
    await page.evaluate(() => { botTimeBehavior = 'fixed'; botFixedDelayMs = 6000; });
    await tap(4, 2); await tap(4, 4);        // 1.e4
    assert.strictEqual(await H.pieceAt(page, sqOf(4, 4)), 'wP', 'e4 played');
    assert.ok(await page.evaluate(() => isWaitingTurn()), 'the bot is on move');
    await tap(6, 1); await tap(5, 3);        // premove Nf3
    assert.strictEqual(await page.evaluate(() => premoveQueue.length), 1, 'first premove queued');
    await tap(1, 1); await tap(2, 3);        // premove Nc3: a second link, not a clear
    assert.strictEqual(await page.evaluate(() => premoveQueue.length), 2, 'second premove added');
    // A tap that adds nothing still clears the queue, as before.
    await tap(7, 5);                         // h5, empty, nothing in hand
    assert.strictEqual(await page.evaluate(() => premoveQueue.length), 0, 'stray tap clears');
    await page.evaluate(() => botStop());
  });

  test('desktop: click e2, click e4 still plays the move (the hover path)', async () => {
    const dctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const dp = await dctx.newPage();
    dp.on('pageerror', (e) => errs.push(e.message));
    await dp.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await dp.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await dp.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#cv');
    await dp.waitForTimeout(1600);
    await H.dismissLanding(dp);
    await dp.evaluate(() => setCommitMode('release'));
    const mouse = H.mouseDriver(dp);
    await mouse.tap(await H.squareCentre(dp, 4, 2));
    await mouse.tap(await H.squareCentre(dp, 4, 4));
    assert.strictEqual(await H.pieceAt(dp, sqOf(4, 4)), 'wP');
    await dctx.close();
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

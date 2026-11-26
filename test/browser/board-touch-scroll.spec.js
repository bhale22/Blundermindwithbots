// Scrolling the page from the board on a phone (Nov 2026).
//
// The board used to take every touch, so on a phone, where it is most of the
// screen, the page could hardly be scrolled. Now the board decides when the
// finger lands: on a piece it would pick up, or with a piece in hand, the
// touch is the board's as before; anywhere else a swipe scrolls the page and
// a tap is still a tap. See the touch listeners in src/30-board-ui.js.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('board touch: drag or scroll (' + H.PHONE_DEVICE + ')', { concurrency: 1 }, () => {
  let server, browser, ctx, page, cdp, touch;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await H.phoneContext(browser);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1600);
    await H.dismissLanding(page);
    cdp = await ctx.newCDPSession(page);
    touch = H.touchDriver(cdp, page);
    await page.evaluate(() => {
      setCommitMode('release');
      // What reaches the board, and what the board's listeners did to each move.
      window._tb = { down: 0, up: 0, moves: 0, cancelledMoves: 0 };
      cv.addEventListener('mousedown', () => _tb.down++);
      cv.addEventListener('mouseup', () => _tb.up++);
      cv.addEventListener('touchmove', (e) => { _tb.moves++; if (e.defaultPrevented) _tb.cancelledMoves++; });
    });
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  const scrollTop = () => page.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop);
  const toTop = async () => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200); };
  const counts = () => page.evaluate(() => Object.assign({}, _tb));
  const zero = () => page.evaluate(() => { _tb.down = _tb.up = _tb.moves = _tb.cancelledMoves = 0; });

  // A finger swipe in small steps, as a thumb moves: dy < 0 is up the screen.
  async function swipe(from, dy) {
    const send = (type, pt) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x: pt.x, y: pt.y }],
    });
    await send('touchStart', from);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await send('touchMove', { x: from.x, y: from.y + dy * i / steps });
      await page.waitForTimeout(16);
    }
    await send('touchEnd', { x: from.x, y: from.y + dy });
    await page.waitForTimeout(500);
  }

  test('the page is taller than the phone, so there is something to scroll', async () => {
    const h = await page.evaluate(() => ({ doc: document.scrollingElement.scrollHeight, win: innerHeight }));
    assert.ok(h.doc > h.win + 100, JSON.stringify(h));
  });

  test('a swipe up from an empty square scrolls the page, and the board sees nothing', async () => {
    await toTop(); await zero();
    await swipe(await H.squareCentre(page, 4, 4), -220);   // e4, empty at the start
    const top = await scrollTop();
    assert.ok(top > 60, 'scrollTop ' + top);
    const c = await counts();
    assert.strictEqual(c.down, 0, 'no mousedown for a scroll');
    assert.strictEqual(c.up, 0, 'no mouseup for a scroll');
  });

  test('dragging a piece still moves it, and the page stays put', async () => {
    await toTop();
    await touch.drag(await H.squareCentre(page, 4, 2), await H.squareCentre(page, 4, 4));
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), 'wP');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), null);
    assert.strictEqual(await scrollTop(), 0);
  });

  test('a swipe from a piece that cannot move now (White\'s, Black to move) scrolls', async () => {
    await toTop(); await zero();
    await swipe(await H.squareCentre(page, 7, 2), -220);   // h2
    assert.ok(await scrollTop() > 60, 'scrollTop ' + await scrollTop());
    assert.strictEqual((await counts()).down, 0);
  });

  test('a tap on an empty square still reaches the board, once', async () => {
    await toTop(); await zero();
    await touch.tap(await H.squareCentre(page, 4, 5));      // e5
    const c = await counts();
    assert.strictEqual(c.down, 1, 'mousedown ' + c.down);
    assert.strictEqual(c.up, 1, 'mouseup ' + c.up);
  });

  // Taps only, in confirm mode (piece, square, square again): every tap after
  // the first lands on an empty square with a piece in hand. Release mode's
  // two taps are tap-move-touch.spec.js.
  test('tap-to-move still works: the piece, its square, and the confirming tap', async () => {
    await page.evaluate(() => setCommitMode('confirm'));
    await touch.tap(await H.squareCentre(page, 3, 7));      // d7
    await touch.tap(await H.squareCentre(page, 3, 5));      // d5: parked
    assert.strictEqual(await page.evaluate(() => awaitingConfirm), true, 'parked on d5');
    await touch.tap(await H.squareCentre(page, 3, 5));      // d5 again: played
    assert.strictEqual(await H.pieceAt(page, 3 * 8 + 3), 'bP', 'pawn on d5');
    assert.strictEqual(await H.pieceAt(page, 1 * 8 + 3), null, 'd7 empty');
    await page.evaluate(() => setCommitMode('release'));
  });

  test('with a piece in hand, a swipe from an empty square is the board\'s, not a scroll', async () => {
    await toTop();
    await touch.tap(await H.squareCentre(page, 6, 1));      // g1 knight (White to move)
    assert.ok(await page.evaluate(() => selSq >= 0), 'knight picked up');
    await swipe(await H.squareCentre(page, 0, 3), -220);    // a3, empty, not a knight move
    assert.strictEqual(await scrollTop(), 0, 'no scroll while a piece is in hand');
    // The board took it as it always did: a touch off the knight's squares puts it down.
    assert.ok(await page.evaluate(() => selSq < 0 && premoveFrom < 0), 'knight put down');
  });

  test('pulling down at the top of the page is stopped (no pull-to-refresh)', async () => {
    await page.evaluate(() => setCommitMode('release'));   // nothing in hand
    await toTop(); await zero();
    await swipe(await H.squareCentre(page, 0, 4), 200);     // a4, empty, downwards
    const c = await counts();
    assert.strictEqual(await scrollTop(), 0);
    assert.ok(c.cancelledMoves > 0, 'the pull was cancelled: ' + JSON.stringify(c));
    assert.strictEqual(c.down, 0, 'and it was not a tap');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

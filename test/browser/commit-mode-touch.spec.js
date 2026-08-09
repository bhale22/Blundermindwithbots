// The same commit mode on an actual touch device, with real touch events.
//
// This is the case the feature exists for, and it is not covered by the mouse
// suite: the canvas has its own touchstart/touchmove/touchend listeners that
// re-dispatch as mouse events, so touch has a genuinely separate code path.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('commit mode (touch, ' + H.PHONE_DEVICE + ')', { concurrency: 1 }, () => {
  let server, browser, ctx, page, touch;
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
    touch = H.touchDriver(await ctx.newCDPSession(page), page);
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  const state = () => page.evaluate(() => ({
    mode: boardCommitMode, awaiting: awaitingConfirm,
    to: premoveTo, preview: !!previewBoard,
  }));

  test('the device really reports touch support', async () => {
    assert.ok(await page.evaluate(() => 'ontouchstart' in window));
  });

  test('lifting the finger parks the piece rather than playing it', async () => {
    await page.evaluate(() => setCommitMode('confirm'));
    const e2 = await H.squareCentre(page, 4, 2);
    const e4 = await H.squareCentre(page, 4, 4);
    await touch.drag(e2, e4);

    const s = await state();
    assert.strictEqual(s.awaiting, true, 'should be parked, not played');
    assert.strictEqual(s.to, H.SQ.e4);
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), 'wP', 'pawn must still be on e2');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), null);
  });

  test('overlays stay live with the finger off the board', async () => {
    assert.strictEqual((await state()).preview, true);
  });

  test('a second tap commits', async () => {
    await touch.tap(await H.squareCentre(page, 4, 4));
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), 'wP');
  });

  test('the chip is on screen and large enough to hit with a thumb', async () => {
    const bb = await page.locator('#commitModeChip').boundingBox();
    assert.ok(bb, 'chip should be visible');
    assert.ok(bb.width >= 44, 'chip width ' + bb.width + ' too small');
    assert.ok(bb.height >= 20, 'chip height ' + bb.height + ' too small');
  });

  test('tapping the chip switches mode', async () => {
    await page.locator('#commitModeChip').tap();
    await page.waitForTimeout(300);
    assert.strictEqual((await state()).mode, 'release');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

// The clock must measure REAL elapsed time, not time the window happened to be
// open. Hiding the tab used to stop the timer AND re-anchor it on the way back,
// which refunded every second spent away: alt-tabbing out of a 1+0 bullet game
// paused your clock. In multiplayer the refunded value was then sent to the
// opponent as the authoritative post-move time.
//
// Timing here is deliberately coarse (whole seconds, generous tolerances) —
// what is being asserted is "the time was charged at all", not millisecond
// accuracy.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('clock charges real time', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    // Simulating "the app was closed for N seconds" cannot be done by editing
    // the snapshot's timestamp: navigating away fires pagehide, which saves a
    // fresh snapshot over it. So push the CLOCK forward on the reloaded page
    // instead, via ?tshift=<ms>. The page being navigated away from has no
    // param and is therefore unaffected, which is exactly what we need.
    await page.addInitScript(() => {
      const m = /[?&]tshift=(\d+)/.exec(location.search);
      if (!m) return;
      const delta = +m[1];
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + delta;
    });
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function freshBotGame(tc) {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2500);
    await H.dismissLanding(page);
    await page.evaluate((t) => {
      botSetPlayerColor('white');
      botSetTC(t);
      maia3SetRating(1700);
      botSetTab('maia3');
      botSetTimeBehavior('instant');
      botStart();
    }, tc);
    await page.waitForTimeout(800);
  }

  test('hiding the tab does not refund the hidden stretch', async () => {
    await freshBotGame('rapid10'); // 10+0, white (human) on move and on the clock
    const start = await page.evaluate(() => clockTimeW);

    // Emulate a real backgrounding: the page reports hidden and fires the event.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const atHide = await page.evaluate(() => ({ w: clockTimeW, interval: clockInterval !== null }));
    assert.strictEqual(atHide.interval, false, 'the repaint timer should be parked while hidden');

    await page.waitForTimeout(4000); // four seconds away

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const back = await page.evaluate(() => clockTimeW);

    const charged = start - back;
    assert.ok(charged >= 3, 'the hidden seconds must be charged, got ' + charged + 's (was ' +
      start + ', now ' + back + ')');
    assert.ok(charged <= 8, 'and not over-charged, got ' + charged + 's');
  });

  test('the clock keeps running after coming back', async () => {
    const a = await page.evaluate(() => clockTimeW);
    await page.waitForTimeout(3000);
    const b = await page.evaluate(() => clockTimeW);
    assert.ok(a - b >= 2, 'clock should still be ticking, went ' + a + ' -> ' + b);
  });

  test('a reload charges the time the app was closed', async () => {
    await freshBotGame('rapid10');
    // Put the game mid-play with the human on move, then snapshot.
    // A snapshot needs at least one played move; wait for the bot's reply so
    // the human is back on move and therefore the one on the clock.
    await page.evaluate(() => { executeMove(52, 36); });
    await page.waitForTimeout(4000);
    assert.strictEqual(await page.evaluate(() => turn), 'w', 'human should be on move');
    await page.evaluate(() => { bmSessionSave(); });
    const snap = await page.evaluate(() => JSON.parse(localStorage.getItem('bm_liveGame')));
    assert.ok(snap && snap.ts, 'snapshot should carry a timestamp');
    assert.match(snap.fen, / w /, 'human (white) should be on move');

    // Reload into a page whose clock reads 40s later: the app was "closed" for
    // that long. The pagehide save that fires on navigation writes an honest
    // timestamp, and the reloaded page is the one that sees it as stale.
    await page.goto(server.baseUrl + '?tshift=40000', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1400); // restore fires ~500ms after load

    const after = await page.evaluate(() => ({ w: clockTimeW, b: clockTimeB, turn }));
    const charged = snap.clock.w - after.w;
    assert.ok(charged >= 38, 'the closed stretch must be charged to white, got ' + charged + 's');
    assert.ok(charged <= 48, 'and not wildly over-charged, got ' + charged + 's');
    assert.strictEqual(after.b, snap.clock.b, 'the player NOT on move is not charged');
  });

  test('coming back to an expired clock loses on time rather than sitting at 0:00', async () => {
    await freshBotGame('bullet'); // 1+0
    // A snapshot needs at least one played move; wait for the bot's reply so
    // the human is back on move and therefore the one on the clock.
    await page.evaluate(() => { executeMove(52, 36); });
    await page.waitForTimeout(4000);
    assert.strictEqual(await page.evaluate(() => turn), 'w', 'human should be on move');
    await page.evaluate(() => { bmSessionSave(); });
    // Ten minutes away from a one-minute game.
    await page.goto(server.baseUrl + '?tshift=600000', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1400);

    const st = await page.evaluate(() => ({ over: gameOver, msg: gameOverMsg, w: clockTimeW }));
    assert.strictEqual(st.w, 0, 'white should be out of time');
    assert.strictEqual(st.over, true, 'the game should be over');
    assert.match(st.msg, /ran out of time/, 'and say so: ' + st.msg);
  });

  test('an untimed game is untouched by any of this', async () => {
    await freshBotGame('untimed');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const st = await page.evaluate(() => ({ over: gameOver, control: clockControl }));
    assert.strictEqual(st.control, 'untimed');
    assert.strictEqual(st.over, false, 'an untimed game must not end on time');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

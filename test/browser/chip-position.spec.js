// The commit-mode chip must hold still.
//
// It originally lived in the Black player box, which moved it twice over:
// updatePlayerBoxes() re-parents the turn pill between rightColW and rightColB
// every turn (shoving the chip around inside the box), and .board-flipped
// swaps the two player boxes top-to-bottom when the human plays Black (moving
// the chip from one clock to the other). Both were visually distracting
// mid-game. It now sits in its own row under the board.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('commit chip position stability', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
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
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  // Measured relative to the board so page scroll cannot confuse the result.
  async function chipOffset() {
    const bb = await page.locator('#commitModeChip').boundingBox();
    const cv = await page.locator('#cv').boundingBox();
    return { dx: Math.round(bb.x - cv.x), dy: Math.round(bb.y - cv.y) };
  }
  const setTurn = (t) => page.evaluate((tt) => { turn = tt; updatePlayerBoxes(); }, t);

  let reference;

  test('the chip lives outside both player boxes', async () => {
    const inABox = await page.evaluate(() => {
      const chip = document.getElementById('commitModeChip');
      return document.getElementById('playerBoxW').contains(chip) ||
             document.getElementById('playerBoxB').contains(chip);
    });
    assert.strictEqual(inABox, false);
    reference = await chipOffset();
    assert.ok(reference.dy > 0, 'chip should sit below the board');
  });

  test('does not move when the turn changes', async () => {
    await setTurn('b');
    await page.waitForTimeout(200);
    // Guard: prove the test is exercising the real path, i.e. the turn pill
    // genuinely re-parented. Without this the assertion could pass vacuously.
    const pillMoved = await page.evaluate(() =>
      document.getElementById('rightColB').contains(document.getElementById('turnPill')));
    assert.ok(pillMoved, 'turn pill should have moved to the Black box');
    assert.deepStrictEqual(await chipOffset(), reference);
  });

  test('does not move when the board flips', async () => {
    await setTurn('w');
    await page.evaluate(() => {
      document.getElementById('board-col').classList.add('board-flipped');
    });
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await chipOffset(), reference);
  });

  test('does not move with flip and turn change combined', async () => {
    await setTurn('b');
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await chipOffset(), reference);
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

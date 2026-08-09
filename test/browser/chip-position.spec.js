// Where the commit chip lives, and what must not move it.
//
// The chip belongs with the player's OWN clock — it is a control for your
// moves, so it sits where your time sits. That target is not fixed: the
// amateur shell's .board-flipped swaps the two player boxes, so "your" box is
// playerBoxB when you play Black.
//
// The hazard this suite exists for is inside the box: updatePlayerBoxes()
// re-parents the turn pill between rightColW and rightColB on EVERY turn. An
// earlier placement put the chip in that same column, so it shuffled sideways
// twice a move — distracting movement right next to the board. The chip now
// sits in its own mount after the column, and the flex mid-col absorbs the
// width change instead.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('commit chip placement', { concurrency: 1 }, () => {
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

  // Measured against the board so page scroll cannot confuse the result.
  async function chipOffset() {
    const bb = await page.locator('#commitModeChip').boundingBox();
    const cv = await page.locator('#cv').boundingBox();
    return { dx: Math.round(bb.x - cv.x), dy: Math.round(bb.y - cv.y) };
  }
  const setTurn = (t) => page.evaluate((tt) => { turn = tt; updatePlayerBoxes(); }, t);
  const inBox = (id) => page.evaluate((boxId) =>
    !!document.getElementById(boxId).contains(document.getElementById('commitModeChip')), id);

  let reference;

  test('the chip sits in the player\'s own clock box', async () => {
    assert.ok(await inBox('playerBoxW'),
      'playing White, the chip belongs in the White box (the bottom one)');
    reference = await chipOffset();
    assert.ok(reference.dy > 0, 'chip should be below the board, inside the clock row');
  });

  test('the retired board row takes no space', async () => {
    const h = await page.evaluate(() => {
      const row = document.getElementById('boardInputRow');
      return row ? row.getBoundingClientRect().height : 0;
    });
    assert.strictEqual(h, 0, 'the old standalone row must not leave a gap under the board');
  });

  test('the turn pill re-parenting does not shuffle the chip', async () => {
    await setTurn('b');
    await page.waitForTimeout(200);
    // Guard: prove the real path is being exercised. Without this the
    // assertion below could pass vacuously.
    assert.ok(await page.evaluate(() =>
      document.getElementById('rightColB').contains(document.getElementById('turnPill'))),
      'turn pill should have moved to the Black box');
    assert.deepStrictEqual(await chipOffset(), reference,
      'chip moved when the turn pill left its box');

    await setTurn('w');
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() =>
      document.getElementById('rightColW').contains(document.getElementById('turnPill'))),
      'turn pill should be back in the White box');
    assert.deepStrictEqual(await chipOffset(), reference,
      'chip moved when the turn pill returned to its box');
  });

  test('the chip follows the board flip to whichever box is yours', async () => {
    await page.evaluate(() => {
      boardFlipped = true;
      document.getElementById('board-col').classList.add('board-flipped');
      updatePlayerBoxes();
    });
    await page.waitForTimeout(300);
    assert.ok(await inBox('playerBoxB'),
      'playing Black, the chip should follow to the Black box (now at the bottom)');

    // Still stable against the pill while flipped.
    const flippedRef = await chipOffset();
    await setTurn('b');
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await chipOffset(), flippedRef,
      'chip moved on a turn change while flipped');

    await page.evaluate(() => {
      boardFlipped = false;
      document.getElementById('board-col').classList.remove('board-flipped');
      turn = 'w';
      updatePlayerBoxes();
    });
    await page.waitForTimeout(300);
    assert.ok(await inBox('playerBoxW'), 'and back to the White box');
    assert.deepStrictEqual(await chipOffset(), reference, 'and back to the same position');
  });

  test('the chip stays inside the fixed-height clock row', async () => {
    const fits = await page.evaluate(() => {
      const chip = document.getElementById('commitModeChip').getBoundingClientRect();
      const box = document.getElementById('playerBoxW').getBoundingClientRect();
      return { chipH: Math.round(chip.height), boxH: Math.round(box.height),
               inside: chip.top >= box.top - 1 && chip.bottom <= box.bottom + 1 };
    });
    assert.ok(fits.inside,
      'chip (' + fits.chipH + 'px) should fit inside the ' + fits.boxH + 'px clock row');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

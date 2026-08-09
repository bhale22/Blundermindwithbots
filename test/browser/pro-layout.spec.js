// The pro shell's clocks must not move while a game is played.
//
// #proSide is a flex column: opponent clock, notation card, your clock. The
// notation card used to grow from 60px to 188px as moves accumulated, walking
// the player clock steadily down the screen — movement right beside the board
// on every move. The material line did the same on a smaller scale by
// collapsing to zero height when empty.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('pro shell layout stability', { concurrency: 1 }, () => {
  let server, browser, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    // Desktop: the pro shell puts the side column beside the board here, which
    // is the layout the clocks are being checked in.
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1800);
    await page.evaluate(() => { if (typeof setShell === 'function') setShell('pro'); });
    await page.waitForTimeout(500);
    await H.dismissLanding(page);
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  const boxOf = (sel) => page.locator(sel).boundingBox();
  // Positions relative to the board, so nothing here depends on page scroll.
  async function layout() {
    const cv = await boxOf('#cv');
    const top = await boxOf('#proPlayerTop');
    const bottom = await boxOf('#proPlayerBottom');
    const notation = await boxOf('#proNotationCard');
    return {
      topY: Math.round(top.y - cv.y),
      bottomY: Math.round(bottom.y - cv.y),
      notationH: Math.round(notation.height),
    };
  }

  test('the pro shell is active with both clocks visible', async () => {
    assert.ok(await page.evaluate(() => document.body.classList.contains('pro-mode')),
      'pro mode should be on');
    assert.ok(await boxOf('#proPlayerTop'), 'opponent clock visible');
    assert.ok(await boxOf('#proPlayerBottom'), 'player clock visible');
  });

  let start;

  test('clocks hold position as moves accumulate', async () => {
    start = await layout();

    // Play well past the point where the old min/max range would have grown:
    // 60px to 188px was roughly the first ten moves.
    const seq = [[52, 36], [12, 28], [62, 45], [1, 18], [61, 34], [5, 26],
                 [59, 45], [3, 21], [60, 62], [6, 21], [51, 35], [11, 27],
                 [34, 27], [21, 27], [45, 35], [27, 35], [45, 35]];
    for (const [from, to] of seq) {
      await page.evaluate(([f, t]) => { executeMove(f, t); }, [from, to]);
      await page.waitForTimeout(120);
      const now = await layout();
      assert.strictEqual(now.topY, start.topY,
        'opponent clock moved after ' + (await page.evaluate(() => gameMovesAlgebraic.length)) + ' plies');
      assert.strictEqual(now.bottomY, start.bottomY,
        'player clock moved after ' + (await page.evaluate(() => gameMovesAlgebraic.length)) + ' plies');
    }

    const played = await page.evaluate(() => gameMovesAlgebraic.length);
    assert.ok(played >= 10, 'enough moves to have triggered the old growth: ' + played);
  });

  test('the notation card is a constant height', async () => {
    const now = await layout();
    assert.strictEqual(now.notationH, start.notationH,
      'notation card height changed: ' + start.notationH + ' → ' + now.notationH);
  });

  test('the move list scrolls rather than growing', async () => {
    const before = await page.evaluate(() => {
      const el = document.getElementById('proMoves');
      return { overflow: getComputedStyle(el).overflowY, h: el.clientHeight };
    });
    assert.strictEqual(before.overflow, 'auto', 'move list should scroll');

    // Pile on far more moves than could ever fit, and confirm the box does not
    // grow to accommodate them.
    await page.evaluate(() => {
      const el = document.getElementById('proMoves');
      let html = '';
      for (let i = 1; i <= 60; i++) {
        html += '<div class="pro-moverow"><span class="pro-mnum">' + i +
                '</span><span class="pro-mw">Nf3</span><span class="pro-mb">Nc6</span></div>';
      }
      el.innerHTML = html;
    });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const el = document.getElementById('proMoves');
      return { h: el.clientHeight, canScroll: el.scrollHeight > el.clientHeight };
    });
    assert.strictEqual(after.h, before.h, 'move list height changed with 60 moves in it');
    assert.ok(after.canScroll, 'a full list should overflow its fixed height, not expand');
  });

  test('a material advantage does not shift the clocks', async () => {
    // Force a material line into both player rows and re-measure.
    await page.evaluate(() => {
      const a = document.getElementById('proMatTop');
      const b = document.getElementById('proMatBottom');
      if (a) a.innerHTML = '<span>♟♟</span>';
      if (b) b.innerHTML = '<span>♞ +3</span>';
    });
    await page.waitForTimeout(200);
    const now = await layout();
    assert.strictEqual(now.topY, start.topY, 'opponent clock moved when material appeared');
    assert.strictEqual(now.bottomY, start.bottomY, 'player clock moved when material appeared');
  });

  test('the game-over result bar does not shift the clocks', async () => {
    await page.evaluate(() => {
      const bar = document.getElementById('proResultBar');
      if (bar) { bar.style.display = 'block'; bar.textContent = '1-0 · White wins'; }
    });
    await page.waitForTimeout(200);
    const now = await layout();
    assert.strictEqual(now.bottomY, start.bottomY, 'player clock moved when the result bar appeared');
  });

  test('a long bot name does not wrap and shift the clock', async () => {
    // Build-A-Bot names can be long ("The Drunken Master Mk II"). A wrapped
    // name would add a line to the player row and push the clock down.
    await page.evaluate(() => {
      const n = document.getElementById('proNameTop');
      const r = document.getElementById('proRatingTop');
      if (n) n.textContent = 'The Drunken Master Mk II, Scourge of the Open File';
      if (r) r.textContent = 'Maia 1700 · aggressive · hustle +4 · budget 175cp';
    });
    await page.waitForTimeout(200);
    const now = await layout();
    assert.strictEqual(now.bottomY, start.bottomY, 'clock moved under a long bot name');
    assert.strictEqual(now.topY, start.topY);
  });

  test('the commit chip sits in the player clock panel in pro mode', async () => {
    const where = await page.evaluate(() => {
      const chip = document.getElementById('commitModeChip');
      return {
        inClockPanel: !!document.getElementById('proPlayerBottom').contains(chip),
        visible: !!(chip && chip.offsetParent !== null),
      };
    });
    assert.ok(where.inClockPanel, 'chip should be mounted in the player clock panel');
    assert.ok(where.visible, 'chip should be visible');
  });

  test('the chip still toggles from its new home', async () => {
    const before = await page.evaluate(() => boardCommitMode);
    await page.locator('#commitModeChip').click();
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => boardCommitMode);
    assert.notStrictEqual(after, before, 'clicking the chip should switch mode');
    // And doing so must not disturb the layout.
    const now = await layout();
    assert.strictEqual(now.bottomY, start.bottomY, 'clock moved when the chip toggled');
  });

  test('switching back to the amateur shell returns the chip under the board', async () => {
    await page.evaluate(() => setShell('amateur'));
    await page.waitForTimeout(500);
    const back = await page.evaluate(() => {
      const chip = document.getElementById('commitModeChip');
      return {
        inBoardRow: !!document.getElementById('boardInputRow').contains(chip),
        visible: !!(chip && chip.offsetParent !== null),
      };
    });
    assert.ok(back.inBoardRow, 'chip should return to the board input row');
    assert.ok(back.visible, 'chip should still be visible in the amateur shell');
    await page.evaluate(() => setShell('pro'));
    await page.waitForTimeout(400);
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

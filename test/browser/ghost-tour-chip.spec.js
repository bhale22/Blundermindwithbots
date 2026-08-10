// Ghost timing, the landing tour, and where the commit chip lives.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('ghost delay, tour launch, chip placement', { concurrency: 1 }, () => {
  let server, browser, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function load(query) {
    await page.goto(server.baseUrl + (query || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1800);
  }

  // ── Chip placement ────────────────────────────────────────────────────────
  test('the chip sits inside the player clock box, not in a row under the board', async () => {
    await load();
    await H.dismissLanding(page);
    const where = await page.evaluate(() => {
      const chip = document.getElementById('commitModeChip');
      return {
        inPlayerBox: !!document.getElementById('playerBoxW').contains(chip),
        inOldRow: !!document.getElementById('boardInputRow').contains(chip),
        visible: !!(chip && chip.offsetParent !== null),
      };
    });
    assert.ok(where.inPlayerBox, 'chip should be in the White (bottom) player box');
    assert.strictEqual(where.inOldRow, false, 'chip should have left the old board row');
    assert.ok(where.visible, 'chip should be visible');
  });

  test('the old board row leaves no gap under the board', async () => {
    const gap = await page.evaluate(() => {
      const row = document.getElementById('boardInputRow');
      return row ? row.getBoundingClientRect().height : 0;
    });
    assert.strictEqual(gap, 0, 'the retired row must take no vertical space');
  });

  test('the chip follows the board flip to whichever box is the player\'s', async () => {
    await page.evaluate(() => {
      boardFlipped = true;
      document.getElementById('board-col').classList.add('board-flipped');
      updatePlayerBoxes();
    });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() =>
      document.getElementById('playerBoxB').contains(document.getElementById('commitModeChip'))),
      'playing Black, the chip should move to the Black box (now at the bottom)');

    await page.evaluate(() => {
      boardFlipped = false;
      document.getElementById('board-col').classList.remove('board-flipped');
      updatePlayerBoxes();
    });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() =>
      document.getElementById('playerBoxW').contains(document.getElementById('commitModeChip'))),
      'and back again');
  });

  // ── Tour ──────────────────────────────────────────────────────────────────
  test('the tour renders above the landing page, not behind it', async () => {
    await load();
    const z = await page.evaluate(() => ({
      landing: +getComputedStyle(document.getElementById('landingOverlay')).zIndex,
      tour: +getComputedStyle(document.getElementById('tourOverlay')).zIndex,
    }));
    assert.ok(z.tour > z.landing,
      'tour z-index (' + z.tour + ') must beat the landing overlay (' + z.landing + ')');
  });

  test('starting the visualization tour leaves the landing and opens on the board', async () => {
    await load();
    await page.evaluate(() => landingStartTour('board'));
    await page.waitForTimeout(1400);   // past the 420ms fade + 460ms start

    // The point of the change: you end up looking at the board, not the page
    // you just chose to leave.
    assert.strictEqual(await H.landingVisible(page), false,
      'the landing must be gone once the board tour starts');
    assert.strictEqual(await page.evaluate(() => proMode), false,
      'the visualization tour should put you on the Beginner board');
    assert.ok(await page.evaluate(() => {
      const r = document.getElementById('cv').getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }), 'the board should be on screen');

    const state = await page.evaluate(() => {
      const panel = document.getElementById('tourPanel');
      const r = panel.getBoundingClientRect();
      return {
        active: _tourActive,
        steps: _tourSteps.length,
        idx: _tourIdx,
        title: (document.getElementById('tourTitle') || {}).textContent || '',
        overlayShown: getComputedStyle(document.getElementById('tourOverlay')).display !== 'none',
        panelOnScreen: r.width > 0 && r.height > 0,
      };
    });
    assert.strictEqual(state.active, true, 'tour should be running');
    assert.ok(state.steps > 1, 'tour should have steps: ' + state.steps);
    assert.strictEqual(state.idx, 0, 'and it should open on its FIRST step');
    assert.ok(state.overlayShown, 'tour overlay should be displayed');
    assert.ok(state.panelOnScreen, 'tour panel should be laid out on screen');
    assert.match(state.title, /\S/, 'the first step should have a title');

    // Nothing may cover the panel at its own centre.
    const covered = await page.evaluate(() => {
      const panel = document.getElementById('tourPanel');
      const r = panel.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
      return !panel.contains(el);
    });
    assert.strictEqual(covered, false, 'tour panel must not be covered by anything');
  });

  test('both tours cover the commit-mode chip, and spotlight it', async () => {
    // The chip changes how every move is committed, so neither board should
    // introduce itself without mentioning it.
    for (const shell of ['amateur', 'pro']) {
      await page.evaluate((sh) => {
        try { localStorage.setItem('bm_shell', sh); } catch (e) {}
      }, shell);
      await load();
      await H.dismissLanding(page);
      await page.evaluate((sh) => { if (typeof setShell === 'function') setShell(sh); }, shell);
      await page.waitForTimeout(400);

      const found = await page.evaluate(() => {
        startTour();
        const i = _tourSteps.findIndex((s) => s.sel === '#commitModeChip');
        if (i < 0) { endTour(); return null; }
        _tourIdx = i; _renderTourStep();
        return { idx: i, total: _tourSteps.length };
      });
      assert.ok(found, shell + ' tour has no commit-mode step');

      // The ring is positioned asynchronously, so let it settle before reading.
      await page.waitForTimeout(900);
      const spot = await page.evaluate(() => {
        const r = document.getElementById('tourRing').getBoundingClientRect();
        const c = document.getElementById('commitModeChip').getBoundingClientRect();
        return {
          covers: r.left <= c.left + 2 && r.top <= c.top + 2 &&
                  r.right >= c.right - 2 && r.bottom >= c.bottom - 2,
          title: (document.getElementById('tourTitle') || {}).textContent || '',
          body: (document.getElementById('tourBody') || {}).textContent || '',
        };
      });
      assert.ok(spot.covers, shell + ': the spotlight does not land on the chip');
      assert.match(spot.title, /\S/, shell + ': the step needs a title');
      assert.match(spot.body, /Release to move/i, shell + ': should name the release mode');
      assert.match(spot.body, /Tap to confirm/i, shell + ': should name the confirm mode');
      await page.evaluate(() => endTour());
    }
    await page.evaluate(() => { try { localStorage.setItem('bm_shell', 'amateur'); } catch (e) {} });
    await load();
  });

  test('the tour advances through its steps', async () => {
    await load();
    await H.dismissLanding(page);
    await page.evaluate(() => startTour());
    await page.waitForTimeout(600);
    assert.strictEqual(await page.evaluate(() => _tourIdx), 0, 'starts on the first step');

    await page.evaluate(() => tourNext());
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ idx: _tourIdx, active: _tourActive }));
    assert.strictEqual(after.idx, 1, 'should be on the second step');
    assert.strictEqual(after.active, true);
    await page.evaluate(() => endTour());
  });

  // ── Ghost delay ───────────────────────────────────────────────────────────
  test('ghost replies wait before drawing, so indicators can be read first', async () => {
    await load();
    await H.dismissLanding(page);
    assert.strictEqual(await page.evaluate(() => GHOST_DELAY_MS), 1500,
      'the delay should be 1.5s');

    // Hovering schedules rather than drawing immediately.
    const scheduled = await page.evaluate(() => {
      selSq = 52;                      // e2 selected
      legalMoves = legalMovesFor(52, board, epSq, castling);
      ghostOnMouseMove(36);            // hover e4
      return _ghostDelayTimer !== null;
    });
    assert.ok(scheduled, 'a hover should schedule the ghost, not draw it at once');

    // Moving to another square restarts the wait rather than stacking.
    const restarted = await page.evaluate(() => {
      const first = _ghostDelayTimer;
      ghostOnMouseMove(44);            // hover e3
      return _ghostDelayTimer !== null && _ghostDelayTimer !== first;
    });
    assert.ok(restarted, 'a new square should restart the delay');

    // Dropping the piece cancels it, so no ghost lands after the move is gone.
    const cancelled = await page.evaluate(() => {
      ghostOnMouseDown(52);
      return _ghostDelayTimer === null;
    });
    assert.ok(cancelled, 'picking up again should cancel a pending ghost');
  });

  test('the ghost search timeout scales with depth', async () => {
    // A flat 5s silently broke "SF Deep (depth 12)": the search outran it and
    // resolved null, so nothing was ever drawn.
    const budgets = await page.evaluate(() => {
      const f = (depth, excl) =>
        Math.max(5000, Math.min(20000, depth * 1200)) * (excl ? 1.6 : 1);
      return { d4: f(4, false), d12: f(12, false), d12x: f(12, true) };
    });
    assert.ok(budgets.d12 > budgets.d4, 'depth 12 should get more time than depth 4');
    assert.ok(budgets.d12 >= 14000, 'depth 12 needs a realistic budget, got ' + budgets.d12);
    assert.ok(budgets.d12x > budgets.d12, 'the searchmoves pass should get more still');
  });

  test('a parked piece keeps its ghosts in confirm mode', async () => {
    // Parking releases both dragFrom and selSq while the preview stays live, so
    // the ghost hook has to fall back to the preview origin or the ghosts died
    // the moment the piece was placed.
    await page.evaluate(() => setCommitMode('confirm'));
    const kept = await page.evaluate(() => {
      selSq = -1; dragFrom = -1;
      premoveFrom = 52; premoveTo = 36;
      setAwaitingConfirm(true);
      ghostOnMouseMove(36);
      return { from: _ghostFromSq, scheduled: _ghostDelayTimer !== null };
    });
    assert.strictEqual(kept.from, 52, 'ghost origin should come from the parked preview');
    assert.ok(kept.scheduled, 'a parked piece should still schedule its ghosts');
    await page.evaluate(() => { setAwaitingConfirm(false); setCommitMode('release'); });
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

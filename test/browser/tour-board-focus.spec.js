// On a phone the board-vision controls live in a drawer below the board, far
// enough away that scrolling a button into view pushes the board off screen.
// The overlay part of the tour describes things DRAWN ON THE BOARD, so without
// care the tour describes something the user cannot see.
//
// That part of the tour is now one interactive step: the visitor presses the
// overlays themselves, in any order. The guarantees below are the same ones
// the old per-indicator steps had, restated for that step —
//
//   1. On a phone the spotlight is on the BOARD, the whole board is in view,
//      and the panel does not cover the thing it is describing.
//   2. The controls come to the panel, because the real grid is off screen —
//      as inert chips carrying no ids and no handlers.
//   3. The panel's own buttons stay reachable, so the step can be left.
//   4. Desktop still points at the real controls, which are on screen there.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('board tour on a phone', { concurrency: 1 }, () => {
  let server, browser;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function openTour(opts = {}) {
    const ctx = opts.phone
      ? await H.phoneContext(browser)
      : await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof startTour === 'function');
    await H.dismissLanding(page);
    await page.evaluate(() => startTour());
    await page.waitForTimeout(800);
    return { ctx, page };
  }

  // Walk to the interactive overlay step by stepping, not by jumping, so the
  // ordinary Next path is what gets exercised.
  async function stepToExplore(page) {
    for (let i = 0; i < 30; i++) {
      const cur = await page.evaluate(() => ({
        explore: !!_tourSteps[_tourIdx].explore,
        idx: _tourIdx,
        last: _tourIdx === _tourSteps.length - 1,
      }));
      if (cur.explore) return cur.idx;
      if (cur.last) break;
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(420);
    }
    throw new Error('never reached the interactive overlay step');
  }

  const geometry = (page) => page.evaluate(() => {
    const ring = document.getElementById('tourRing').getBoundingClientRect();
    const cv = document.getElementById('cv').getBoundingClientRect();
    const panel = document.getElementById('tourPanel').getBoundingClientRect();
    const next = document.getElementById('tourNext').getBoundingClientRect();
    const ov = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      ringOnBoard: Math.abs(ring.top - (cv.top - 6)) < 4 &&
                   Math.abs(ring.left - (cv.left - 6)) < 4,
      boardOnScreen: cv.top > -4 && cv.bottom <= window.innerHeight + 4,
      panelOverBoard: Math.round(ov(panel, cv)),
      nextReachable: next.bottom <= window.innerHeight + 1 && next.top >= 0,
      chips: document.querySelectorAll('.tour-chip').length,
      dimmed: getComputedStyle(document.getElementById('tourRing'))
                .boxShadow.includes('9999'),
    };
  });

  test('the overlay step spotlights the board, not the far-away grid', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const g = await geometry(page);
    assert.strictEqual(g.ringOnBoard, true, 'the spotlight should be on the board');
    assert.strictEqual(g.boardOnScreen, true, 'the whole board should be in view');
    assert.strictEqual(g.panelOverBoard, 0,
      'the panel covers ' + g.panelOverBoard + 'px² of the board it is describing');
    await ctx.close();
  });

  test('the board is never blacked out on a step that is about the board', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const g = await geometry(page);
    // The ring dims by casting a 9999px shadow outward. On a step whose whole
    // point is an overlay drawn on the board, that put the position under 50%
    // black and the pieces read as washed out.
    assert.strictEqual(g.dimmed, false, 'the board must stay lit while it is being demonstrated');
    await ctx.close();
  });

  test('the controls come to the panel, and pressing one lights it', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const before = await geometry(page);
    assert.ok(before.chips >= 10, 'expected a chip per overlay, got ' + before.chips);

    await page.locator('.tour-chip[data-ind="pins"]').click();
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      active: _tourActive,
      title: document.getElementById('tourTitle').textContent,
      lit: Object.keys(IND).filter((k) => IND[k].on),
      chipOn: document.querySelectorAll('.tour-chip.on').length,
      tried: _tourTried ? _tourTried.size : 0,
    }));
    assert.strictEqual(after.active, true, 'pressing a control must not end the tour');
    assert.match(after.title, /pin/i, 'the panel should describe what was pressed');
    assert.deepStrictEqual(after.lit, ['pins'], 'exactly the pressed overlay should be drawn');
    assert.strictEqual(after.chipOn, 1, 'the pressed chip should read as active');
    assert.strictEqual(after.tried, 1);
    await ctx.close();
  });

  test('the chips are inert — no duplicated ids, no handlers', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const bad = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.tour-chip'));
      return {
        withId: chips.filter((n) => n.id).map((n) => n.id),
        withHandler: chips.filter((n) =>
          Array.from(n.attributes).some((a) => /^on/i.test(a.name))).length,
        realStillUnique: document.querySelectorAll('#ib-pins').length,
      };
    });
    assert.deepStrictEqual(bad.withId, [], 'ids must not be duplicated into the document');
    assert.strictEqual(bad.withHandler, 0, 'the chips must carry no inline handlers');
    assert.strictEqual(bad.realStillUnique, 1, 'the real control is still the only #ib-pins');
    await ctx.close();
  });

  test('the step can be left — Next stays reachable however long the help is', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    // "threats" carries one of the longest help bodies, which is what used to
    // push the panel's own buttons off the bottom of the screen.
    await page.evaluate(() => _tourExplorePick('threats'));
    await page.waitForTimeout(500);
    const g = await geometry(page);
    assert.strictEqual(g.nextReachable, true, 'Next must stay on screen');
    assert.strictEqual(g.panelOverBoard, 0, 'and the panel must still clear the board');
    await page.locator('#tourNext').click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.evaluate(() => !!_tourSteps[_tourIdx].explore), false,
      'Next should advance past the interactive step');
    assert.strictEqual(await page.evaluate(() => _tourExploring), false,
      'leaving the step should stop explore mode');
    await ctx.close();
  });

  test('leaving the tour clears the invitation outline', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    assert.ok(await page.evaluate(() => document.querySelectorAll('.ind-grid.tour-invite').length > 0),
      'the grids should be inviting a press during the step');
    await page.evaluate(() => endTour());
    await page.waitForTimeout(400);
    assert.strictEqual(
      await page.evaluate(() => document.querySelectorAll('.ind-grid.tour-invite').length), 0,
      'the outline must not survive the tour');
    await ctx.close();
  });

  test('desktop points at the real controls', async () => {
    const { ctx, page } = await openTour({ phone: false });
    await stepToExplore(page);
    const g = await geometry(page);
    assert.strictEqual(g.ringOnBoard, false,
      'on desktop the real grid is on screen, so that is what to point at');
    const onGrid = await page.evaluate(() => {
      const ring = document.getElementById('tourRing').getBoundingClientRect();
      const grid = document.querySelector('.ind-grid').getBoundingClientRect();
      return Math.abs(ring.top - (grid.top - 6)) < 4 && Math.abs(ring.left - (grid.left - 6)) < 4;
    });
    assert.strictEqual(onGrid, true, 'the ring should sit on the indicator grid');
    // And the real buttons drive the step, not just the chips.
    await page.locator('#ib-unprotected .ib-main').click();
    await page.waitForTimeout(550);
    const after = await page.evaluate(() => ({
      active: _tourActive,
      lit: Object.keys(IND).filter((k) => IND[k].on),
    }));
    assert.strictEqual(after.active, true, 'pressing the real button must not end the tour');
    assert.deepStrictEqual(after.lit, ['unprotected']);
    await ctx.close();
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

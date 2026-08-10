// On a phone the board-vision controls live in a drawer below the board, far
// enough away that scrolling a button into view pushes the board off screen.
// Every tour step from "Check threats" on describes an overlay drawn on the
// board, so the tour was describing something the user could not see.
//
// Those steps now spotlight the board and bring a copy of the control into the
// panel. Desktop is unchanged: there the board and the controls are both on
// screen, and pointing at the real button is better than a picture of it.
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

  // Walk to the first step whose target is the named indicator.
  async function stepTo(page, ind) {
    for (let i = 0; i < 30; i++) {
      const cur = await page.evaluate(() => {
        const s = _tourSteps[_tourIdx];
        return { ind: s.ind || null, idx: _tourIdx, last: _tourIdx === _tourSteps.length - 1 };
      });
      if (cur.ind === ind) return cur.idx;
      if (cur.last) break;
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(450);
    }
    throw new Error('never reached the "' + ind + '" step');
  }

  const geometry = (page) => page.evaluate(() => {
    const ring = document.getElementById('tourRing').getBoundingClientRect();
    const cv = document.getElementById('cv').getBoundingClientRect();
    const panel = document.getElementById('tourPanel').getBoundingClientRect();
    const ov = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      ringOnBoard: Math.abs(ring.top - (cv.top - 6)) < 4 &&
                   Math.abs(ring.left - (cv.left - 6)) < 4,
      boardOnScreen: cv.top > -4 && cv.bottom <= window.innerHeight + 4,
      panelOverBoard: Math.round(ov(panel, cv)),
      replica: !!document.querySelector('#tourBody .tour-replica'),
      replicaText: (document.querySelector('#tourBody .tour-replica') || {}).textContent || '',
    };
  });

  test('an indicator step spotlights the board, not the far-away button', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepTo(page, 'checkthreats');
    const g = await geometry(page);
    assert.strictEqual(g.ringOnBoard, true, 'the spotlight should be on the board');
    assert.strictEqual(g.boardOnScreen, true, 'the whole board should be in view');
    assert.strictEqual(g.panelOverBoard, 0,
      'the panel covers ' + g.panelOverBoard + 'px² of the board it is describing');
    await ctx.close();
  });

  test('the control comes to the panel, showing the state it is being described in', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepTo(page, 'threats');
    const g = await geometry(page);
    assert.strictEqual(g.replica, true, 'a copy of the control should be in the panel');
    assert.match(g.replicaText, /Threats/i, 'it should be the control for this step');
    // Lit, matching the overlay now drawn on the board.
    assert.strictEqual(
      await page.evaluate(() =>
        document.querySelector('#tourBody .tour-replica .ib').classList.contains('on')),
      true, 'the copy should show the control switched on');
    await ctx.close();
  });

  test('the copy is inert — no duplicated ids, no handlers', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepTo(page, 'pins');
    const bad = await page.evaluate(() => {
      const r = document.querySelector('#tourBody .tour-replica');
      const withId = Array.from(r.querySelectorAll('[id]')).map((n) => n.id);
      const withHandler = Array.from(r.querySelectorAll('*')).filter((n) =>
        Array.from(n.attributes).some((a) => /^on/i.test(a.name))).length;
      return { withId, withHandler, rootId: r.querySelector('.ib').id || null };
    });
    assert.deepStrictEqual(bad.withId, [], 'ids must not be duplicated into the document');
    assert.strictEqual(bad.withHandler, 0, 'the copy must carry no event handlers');
    assert.strictEqual(bad.rootId, null);
    // The real control is still the only #ib-pins in the page.
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#ib-pins').length), 1);
    await ctx.close();
  });

  test('every overlay step gets the same treatment, and only those steps', async () => {
    const { ctx, page } = await openTour({ phone: true });
    const seen = [];
    for (let i = 0; i < 30; i++) {
      seen.push(await page.evaluate(() => {
        const s = _tourSteps[_tourIdx];
        return {
          title: s.title, ind: s.ind || null,
          replica: !!document.querySelector('#tourBody .tour-replica'),
        };
      }));
      if (await page.evaluate(() => _tourIdx === _tourSteps.length - 1)) break;
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(400);
    }
    const overlay = seen.filter((s) => s.ind);
    assert.ok(overlay.length >= 10, 'expected the full set of overlay steps, got ' + overlay.length);
    for (const s of overlay) {
      assert.strictEqual(s.replica, true, '"' + s.title + '" should carry a control copy');
    }
    // The steps that introduce the grid itself point at the grid, as before.
    for (const s of seen.filter((x) => !x.ind)) {
      assert.strictEqual(s.replica, false,
        '"' + s.title + '" is not about an overlay and should not show a copy');
    }
    await ctx.close();
  });

  test('desktop still points at the real control', async () => {
    const { ctx, page } = await openTour({ phone: false });
    await stepTo(page, 'checkthreats');
    const g = await geometry(page);
    assert.strictEqual(g.replica, false,
      'on desktop the real button is on screen — a picture of it would be worse');
    assert.strictEqual(g.ringOnBoard, false, 'the spotlight should be on the button');
    const onButton = await page.evaluate(() => {
      const ring = document.getElementById('tourRing').getBoundingClientRect();
      const b = document.getElementById('ib-checkthreats').getBoundingClientRect();
      return Math.abs(ring.top - (b.top - 6)) < 4 && Math.abs(ring.left - (b.left - 6)) < 4;
    });
    assert.strictEqual(onButton, true, 'the ring should sit on #ib-checkthreats');
    await ctx.close();
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

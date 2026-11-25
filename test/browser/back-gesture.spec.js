// The Android back gesture in the installed app.
//
// In a Trusted Web Activity the system back gesture is browser history, and the
// page used to push none — so back from an open panel or the Bot Builder closed
// the whole app. These drive history the way the gesture does (page.goBack())
// and check that back closes the topmost layer, that a layer closed from inside
// gives its history entry back (so the next back leaves rather than doing
// nothing), and that the website's own back behaviour is untouched.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('android back gesture', { concurrency: 1 }, () => {
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

  async function openPage(query) {
    const ctx = await H.phoneContext(browser);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('bm_liveGame');
        // No auto-tours: they are a layer of their own and would sit on top.
        ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach((k) => localStorage.setItem(k, '1'));
      } catch (e) {}
    });
    await page.goto(server.baseUrl + (query || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1200);
    await H.dismissLanding(page);
    return { ctx, page };
  }

  const state = (page) => page.evaluate(() => ({
    armed: _bmBack.armed,
    onEntry: !!(history.state && history.state.bmBack),
    panelOpen: !!document.querySelector('.slide-panel.open'),
    modalOpen: getComputedStyle(document.getElementById('botModal')).display !== 'none',
    landingOpen: _bmShown('landingOverlay') &&
      !document.getElementById('landingOverlay').classList.contains('fade-out'),
    tourOpen: _bmShown('tourOverlay'),
    len: history.length,
  }));

  // Back as the gesture does it. Same-document, so the page survives it.
  async function back(page) {
    await page.goBack({ waitUntil: 'commit' }).catch(() => {});
    await page.waitForTimeout(250);
  }

  test('on the website, opening a panel adds no history', async () => {
    const { ctx, page } = await openPage();
    const len0 = (await state(page)).len;
    await page.evaluate(() => openPanel('helpPanel'));
    await page.waitForTimeout(200);
    const s = await state(page);
    assert.strictEqual(s.panelOpen, true);
    assert.strictEqual(s.len, len0, 'web back behaviour must be unchanged');
    assert.strictEqual(s.armed, false);
    await ctx.close();
  });

  test('in the app, back closes an open panel and stays in the app', async () => {
    const { ctx, page } = await openPage('?app=1');
    const url0 = page.url();
    await page.click('#aboutFeedbackBtn');
    await page.waitForTimeout(200);
    let s = await state(page);
    assert.strictEqual(s.panelOpen, true);
    assert.strictEqual(s.armed, true, 'an open panel should hold one history entry');
    assert.strictEqual(s.onEntry, true);

    await back(page);
    s = await state(page);
    assert.strictEqual(s.panelOpen, false, 'back should close the panel');
    assert.strictEqual(s.armed, false);
    assert.strictEqual(page.url(), url0, 'still on the app page');
    assert.ok(await page.locator('#cv').isVisible(), 'board still there');
    await ctx.close();
  });

  test('a panel closed with its ✕ gives the entry back, so the next back leaves', async () => {
    const { ctx, page } = await openPage('?app=1');
    await page.click('#aboutFeedbackBtn');
    await page.waitForTimeout(200);
    assert.strictEqual((await state(page)).onEntry, true);
    await page.click('#aboutFeedbackPanel .panel-close');
    await page.waitForTimeout(400);
    const s = await state(page);
    assert.strictEqual(s.panelOpen, false);
    assert.strictEqual(s.armed, false);
    assert.strictEqual(s.onEntry, false, 'the extra entry should have been spent');
    // The next back is the app's own first entry going away — in the TWA that
    // closes the app; here it lands on the context's initial about:blank.
    await back(page);
    assert.strictEqual(page.url(), 'about:blank', 'one back should now leave');
    await ctx.close();
  });

  test('stacked layers close one per back, topmost first', async () => {
    const { ctx, page } = await openPage('?app=1');
    await page.evaluate(() => openPanel('helpPanel'));
    await page.waitForTimeout(150);
    await page.evaluate(() => openBotModal());
    await page.waitForTimeout(400);
    let s = await state(page);
    assert.strictEqual(s.panelOpen && s.modalOpen, true, 'both layers open');
    const len = s.len;

    await back(page);
    s = await state(page);
    assert.strictEqual(s.modalOpen, false, 'first back closes the Bot Builder on top');
    assert.strictEqual(s.panelOpen, true, '...and leaves the panel under it');
    assert.strictEqual(s.armed, true, 're-armed for the panel');
    assert.ok(s.len <= len, 'no history pile-up: ' + s.len + ' > ' + len);

    await back(page);
    s = await state(page);
    assert.strictEqual(s.panelOpen, false, 'second back closes the panel');
    assert.strictEqual(s.armed, false);
    assert.ok(await page.locator('#cv').isVisible());
    await ctx.close();
  });

  test('back from Home (the landing) returns to the board', async () => {
    const { ctx, page } = await openPage('?app=1');
    await page.evaluate(() => landingShow());
    await page.waitForTimeout(300);
    assert.strictEqual((await state(page)).landingOpen, true);
    await back(page);
    await page.waitForTimeout(500);
    assert.strictEqual(await H.landingVisible(page), false, 'landing dismissed by back');
    assert.strictEqual((await state(page)).armed, false);
    await ctx.close();
  });

  test('back ends a running tour', async () => {
    const { ctx, page } = await openPage('?app=1');
    await page.evaluate(() => startTour());
    await page.waitForTimeout(500);
    assert.strictEqual((await state(page)).tourOpen, true, 'tour should be up');
    await back(page);
    await page.waitForTimeout(300);
    const s = await state(page);
    assert.strictEqual(s.tourOpen, false, 'back should end the tour');
    assert.ok(await page.locator('#cv').isVisible());
    await ctx.close();
  });

  test('opening and closing repeatedly never strands extra entries', async () => {
    const { ctx, page } = await openPage('?app=1');
    const len0 = (await state(page)).len;
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => openPanel('helpPanel'));
      await page.waitForTimeout(120);
      await page.evaluate(() => closeAllPanels());
      await page.waitForTimeout(250);
    }
    const s = await state(page);
    assert.strictEqual(s.armed, false);
    assert.strictEqual(s.onEntry, false, 'back on the original entry');
    // At most one forward entry left over from the last give-back.
    assert.ok(s.len <= len0 + 1, 'history grew to ' + s.len + ' from ' + len0);
    await ctx.close();
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

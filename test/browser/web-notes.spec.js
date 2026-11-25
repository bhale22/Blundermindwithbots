// The "also on the web" cross-links.
//
// The installed app serves exactly the same HTML as the websites, so the note
// saying "this app is an adaptation of the browser-based version" has to be
// revealed by detecting the app at runtime. Getting that backwards in either
// direction is a visible product bug: missing in the app (the links never
// appear) or present on blundermindchess.com (where it reads as circular
// nonsense, pointing the site at itself).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('web cross-links', { concurrency: 1 }, () => {
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

  async function openPage(opts = {}) {
    const ctx = await H.phoneContext(browser);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
    await page.goto(server.baseUrl + (opts.query || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1600);
    return { ctx, page };
  }

  const noteState = (page, id) => page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return { exists: false };
    return {
      exists: true,
      hidden: el.hidden,
      links: Array.from(el.querySelectorAll('a')).map((a) => a.href),
      text: el.textContent.replace(/\s+/g, ' ').trim(),
    };
  }, id);

  test('both notes exist in the markup', async () => {
    const { ctx, page } = await openPage();
    for (const id of ['landingWebNote', 'aboutWebNote']) {
      const s = await noteState(page, id);
      assert.ok(s.exists, id + ' should be present in the page');
    }
    await ctx.close();
  });

  test('on the web the notes stay hidden', async () => {
    const { ctx, page } = await openPage();
    assert.strictEqual((await noteState(page, 'landingWebNote')).hidden, true,
      'landing note must not show on the website');
    assert.strictEqual((await noteState(page, 'aboutWebNote')).hidden, true,
      'about note must not show on the website');
    assert.strictEqual(await page.evaluate(() => bmIsAppContext()), false);
    await ctx.close();
  });

  test('in app context both notes are revealed', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    assert.strictEqual(await page.evaluate(() => bmIsAppContext()), true);
    for (const id of ['landingWebNote', 'aboutWebNote']) {
      const s = await noteState(page, id);
      assert.strictEqual(s.hidden, false, id + ' should be visible in the app');
    }
    await ctx.close();
  });

  test('both sites are linked, and the copy says what it should', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    for (const id of ['landingWebNote', 'aboutWebNote']) {
      const s = await noteState(page, id);
      assert.ok(s.links.some((h) => /blundermindchess\.com/i.test(h)),
        id + ' should link Blundermindchess.com — got ' + s.links.join(', '));
      assert.ok(s.links.some((h) => /buildabotchess\.com/i.test(h)),
        id + ' should link Buildabotchess.com — got ' + s.links.join(', '));
      assert.match(s.text, /adaptation of the browser-based version/i,
        id + ' should say the app is an adaptation');
      assert.match(s.text, /larger screen/i,
        id + ' should mention the larger screen');
    }
    await ctx.close();
  });

  test('the landing note is actually on screen, not just un-hidden', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    // This note lives inside the landing, which is Home now rather than the
    // entry point — so open it before asking whether the note is laid out.
    // (The same two links are also in the footer on every screen now, which is
    // what a web visitor sees; this covers the in-app surface.)
    await page.evaluate(() => { if (typeof landingShow === 'function') landingShow(); });
    await page.waitForTimeout(300);
    const box = await page.locator('#landingWebNote').boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'landing note should be laid out');
    // It lives inside the landing overlay, so dismissing the landing hides it.
    await H.dismissLanding(page);
    const after = await page.locator('#landingWebNote').isVisible();
    assert.strictEqual(after, false, 'note should go away with the landing overlay');
    await ctx.close();
  });

  test('the about-panel note is reachable once the landing is dismissed', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    await H.dismissLanding(page);
    await page.evaluate(() => openPanel('aboutFeedbackPanel'));
    await page.waitForTimeout(500);
    assert.ok(await page.locator('#aboutWebNote').isVisible(),
      'about note should be visible with the panel open');
    await ctx.close();
  });

  test('links open externally rather than navigating the app away', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    const attrs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.web-note a')).map((a) => ({
        target: a.target, rel: a.rel,
      })));
    assert.ok(attrs.length >= 4, 'expected four cross-links across both notes');
    for (const a of attrs) {
      assert.strictEqual(a.target, '_blank');
      assert.match(a.rel, /noopener/);
    }
    await ctx.close();
  });

  test('the Maia model is NOT prefetched on the open web', async () => {
    // 44MB pushed at every visitor who lands on the page would be rude to them
    // and expensive to serve, and most never open a Maia bot.
    const { ctx, page } = await openPage();
    const r = await page.evaluate(() => {
      let called = false;
      const real = window.maiaInit;
      maiaInit = () => { called = true; };
      maiaMaybePrefetch();
      maiaInit = real;
      return { called, armed: _maiaPrefetchArmed, tried: _maiaPrefetchTried };
    });
    assert.strictEqual(r.called, false, 'must not touch the model on the web');
    assert.strictEqual(r.armed, false);
    await ctx.close();
  });

  // These stub maiaInit, so they null the worker first: 30-board-ui.js starts it
  // 200ms after load for a cache check, and with a worker up the prefetch takes
  // the direct-download path instead (covered further down, and end to end).
  test('in the app the model prefetch arms and starts', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    const r = await page.evaluate(() => {
      let called = false;
      const real = window.maiaInit, realW = _maiaWorker;
      maiaInit = () => { called = true; };
      _maiaWorker = null;
      _maiaPrefetchTried = false;          // reset: the load hook may have run
      maiaMaybePrefetch();
      maiaInit = real; _maiaWorker = realW;
      return { called, armed: _maiaPrefetchArmed };
    });
    assert.strictEqual(r.called, true, 'installing is the commitment — fetch it');
    assert.strictEqual(r.armed, true, 'armed so a no-cache reply starts the download');
    await ctx.close();
  });

  test('the prefetch only ever runs once', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    const calls = await page.evaluate(() => {
      let n = 0;
      const real = window.maiaInit, realW = _maiaWorker;
      maiaInit = () => { n++; };
      _maiaWorker = null;
      _maiaPrefetchTried = false;
      maiaMaybePrefetch();
      maiaMaybePrefetch();
      maiaMaybePrefetch();
      maiaInit = real; _maiaWorker = realW;
      return n;
    });
    assert.strictEqual(calls, 1, 'repeat calls must be no-ops');
    await ctx.close();
  });

  // End to end, no stubs. The stubbed tests above passed for months while the
  // real launch prefetch did nothing: the 200ms cache-check worker answered
  // 'no-cache' before the prefetch armed at load+2.5s, and the prefetch's own
  // maiaInit() then no-oped on the worker that already existed.
  test('the launch prefetch really requests the model — in the app only', async () => {
    const run = async (query, bearer) => {
      const ctx = await H.phoneContext(browser);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errs.push(e.message));
      if (bearer) {
        await page.addInitScript((type) => {
          const t = new EventTarget();
          Object.assign(t, { type, effectiveType: '4g', saveData: false });
          Object.defineProperty(navigator, 'connection', { value: t, configurable: true });
        }, bearer);
      }
      const reqs = [];
      await page.route('**/models/**', (r) => { reqs.push(r.request().url()); r.abort(); });
      await page.goto(server.baseUrl + query, { waitUntil: 'load' });
      await page.waitForTimeout(4500);
      await ctx.close();
      return reqs.length;
    };
    assert.ok((await run('?app=1')) >= 1, 'the app should fetch the model after launch');
    assert.ok((await run('?app=1', 'wifi')) >= 1, '...including on a phone that reports Wi-Fi');
    assert.strictEqual(await run('?app=1', 'cellular'), 0, 'but not on mobile data');
    assert.strictEqual(await run(''), 0, 'the website must not');
  });

  test('the prefetch respects Save-Data', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    const called = await page.evaluate(() => {
      let c = false;
      const real = window.maiaInit;
      maiaInit = () => { c = true; };
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true, effectiveType: '4g' }, configurable: true,
      });
      _maiaPrefetchTried = false;
      maiaMaybePrefetch();
      maiaInit = real;
      return c;
    });
    assert.strictEqual(called, false, 'Save-Data means do not pull 44MB unasked');
    await ctx.close();
  });

  // A fake NetworkInformation that can change: Chrome on Android reports the
  // bearer in `type`, desktop Chromium does not report it at all.
  const fakeConnection = (type) => {
    const t = new EventTarget();
    Object.assign(t, { type, effectiveType: '4g', saveData: false });
    Object.defineProperty(navigator, 'connection', { value: t, configurable: true });
    return t;
  };

  test('on cellular the prefetch waits, and starts once on Wi-Fi', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    const r = await page.evaluate((fakeSrc) => {
      const fake = eval(fakeSrc);
      let n = 0;
      const real = window.maiaInit, realW = _maiaWorker;
      maiaInit = () => { n++; };
      _maiaWorker = null;
      const conn = fake('cellular');          // LTE: effectiveType still says '4g'
      _maiaPrefetchTried = false; _maiaPrefetchWaiting = false;
      maiaMaybePrefetch();
      const onCell = n;
      conn.type = 'none';                      // tunnel: still not a time to fetch
      conn.dispatchEvent(new Event('change'));
      const onNone = n;
      conn.type = 'wifi';
      conn.dispatchEvent(new Event('change'));
      const onWifi = n;
      conn.dispatchEvent(new Event('change')); // a later change must not re-fire
      maiaInit = real; _maiaWorker = realW;
      return { onCell, onNone, onWifi, after: n };
    }, '(' + fakeConnection.toString() + ')');
    assert.strictEqual(r.onCell, 0, 'no 44MB on mobile data');
    assert.strictEqual(r.onNone, 0, 'offline is not Wi-Fi');
    assert.strictEqual(r.onWifi, 1, 'Wi-Fi should start the parked prefetch');
    assert.strictEqual(r.after, 1, 'and only once');
    await ctx.close();
  });

  test('a worker already up from the Bot Builder still gets the download', async () => {
    // Opening the builder starts the worker for a cache check. Its 'no-cache'
    // answer then arrives unarmed, so a prefetch after that must start the
    // download itself rather than calling a maiaInit() that no-ops.
    const { ctx, page } = await openPage({ query: '?app=1' });
    const msgs = await page.evaluate(() => {
      const realW = _maiaWorker, realS = _maiaStatus;
      const sent = [];
      _maiaWorker = { postMessage: (m) => sent.push(m) };
      _maiaStatus = 'no-cache';
      _maiaPrefetchTried = false; _maiaPrefetchWaiting = false;
      try { Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true }); } catch (e) {}
      maiaMaybePrefetch();
      _maiaWorker = realW; _maiaStatus = realS;
      return sent;
    });
    assert.deepStrictEqual(msgs, [{ type: 'download' }]);
    await ctx.close();
  });

  // ── Ko-fi ───────────────────────────────────────────────────────────
  // Play's Payments policy bars steering users to a non-Play payment method
  // from inside the app; the website keeps its Support button.
  const donateState = (page) => page.evaluate(() => ({
    btn: getComputedStyle(document.getElementById('donateBtn')).display,
    panel: getComputedStyle(document.getElementById('donatePanel')).display,
    cls: document.documentElement.classList.contains('bm-app'),
    app: bmIsAppContext(),
  }));

  test('the Ko-fi button stays on the website', async () => {
    const { ctx, page } = await openPage();
    const s = await donateState(page);
    assert.notStrictEqual(s.btn, 'none', 'web keeps Support');
    assert.strictEqual(s.cls, false);
    await ctx.close();
  });

  test('the Ko-fi button and panel are gone in the app', async () => {
    const { ctx, page } = await openPage({ query: '?app=1' });
    await page.evaluate(() => openPanel('donatePanel'));   // even if something opens it
    await page.waitForTimeout(200);
    const s = await donateState(page);
    assert.strictEqual(s.btn, 'none', 'no Support button in the app');
    assert.strictEqual(s.panel, 'none', 'no Ko-fi panel in the app');
    await ctx.close();
  });

  test('the pre-paint .bm-app class agrees with bmIsAppContext()', async () => {
    // Two copies of the same four tests (inline bootstrap, before paint; and
    // the function). This is what keeps them in step.
    for (const query of ['', '?app=1']) {
      const { ctx, page } = await openPage({ query });
      const s = await donateState(page);
      assert.strictEqual(s.cls, s.app, 'class and function disagree for "' + query + '"');
      await ctx.close();
    }
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

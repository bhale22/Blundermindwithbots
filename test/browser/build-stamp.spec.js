// The service worker's cache version must track the assembled page.
//
// It used to be a hardcoded `const VERSION = 'v1'`. The shell cache is keyed on
// it, so no deploy ever rotated it. The navigate handler is network-first and
// refreshes the cached shell on a healthy load — but it falls back to cache
// after a 3 s timeout, and a phone on a slow link fetching a ~1 MB document
// crosses that easily. Once that happened the device could replay the old app
// indefinitely, which is exactly how a shipped fix can appear not to work.
//
// The build id is also stamped into the About panel, because "which build is
// this phone running?" is otherwise unanswerable without devtools.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./_harness');

describe('build stamp and service-worker versioning', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  test('the page carries a build id', async () => {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    const build = await page.evaluate(() => window.__BM_BUILD);
    assert.match(build || '', /^[0-9a-f]{12}$/, 'expected a 12-hex build id, got ' + build);

    const meta = await page.getAttribute('meta[name="bm-build"]', 'content');
    assert.strictEqual(meta, build, 'meta tag and global should agree');
  });

  test('the About panel shows it', async () => {
    await page.waitForTimeout(1200); // the load handler fills it in
    const shown = await page.textContent('#buildStamp');
    const build = await page.evaluate(() => window.__BM_BUILD);
    assert.strictEqual(shown.trim(), build, 'About panel should display the build id');
  });

  test('sw.js is served with the build id as its cache VERSION', async () => {
    const res = await page.request.get(server.baseUrl + 'sw.js');
    assert.strictEqual(res.status(), 200);
    const body = await res.text();
    const build = await page.evaluate(() => window.__BM_BUILD);

    const m = /const VERSION = '([^']*)';/.exec(body);
    assert.ok(m, 'sw.js should still declare a VERSION the server can substitute');
    assert.strictEqual(m[1], build,
      'sw.js VERSION should be the build id, not the placeholder');
    assert.notStrictEqual(m[1], 'v1', 'the placeholder must not reach the browser');
    // Cache names are derived from it, so this is what actually rotates.
    assert.ok(body.includes("'bm-shell-'"), 'shell cache should still be version-keyed');
  });

  test('changing src/ changes both the build id and the worker version', async () => {
    const before = await page.evaluate(() => window.__BM_BUILD);
    const swBefore = await (await page.request.get(server.baseUrl + 'sw.js')).text();

    // Touch a real source file the way a deploy would, then put it back.
    const target = path.join(H.ROOT, 'src', '30-board-ui.js');
    const original = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(target, original + '\n// build-stamp spec touch\n', 'utf8');
      // The page is served with max-age=300, so a plain reload would come from
      // the browser's own HTTP cache and tell us nothing about the server.
      await page.goto(server.baseUrl + '?cb=' + Date.now(), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cv');
      const after = await page.evaluate(() => window.__BM_BUILD);
      const swAfter = await (await page.request.get(server.baseUrl + 'sw.js')).text();

      assert.notStrictEqual(after, before, 'the build id must change when src/ does');
      assert.notStrictEqual(swAfter, swBefore, 'sw.js bytes must change too');
      assert.ok(swAfter.includes("const VERSION = '" + after + "';"),
        'the worker should carry the new build id');
    } finally {
      fs.writeFileSync(target, original, 'utf8');
    }
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

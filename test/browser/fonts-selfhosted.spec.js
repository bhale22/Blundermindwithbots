// Fonts must be served from this origin, never from Google.
//
// The page used to <link> fonts.googleapis.com, which sends every visitor's IP
// address to Google. A Munich court (LG München I, Jan 2022) held that this
// breaches the GDPR without consent, and the site has European users. This
// suite fails if anyone re-adds a Google font request — the regression is
// invisible in the UI (the fonts look identical either way), so it needs a test
// rather than a code review to catch.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

// Parse the hostname rather than pattern-matching the whole URL. An earlier
// version anchored on (^|\.) and tested full URLs, so it never matched
// "https://fonts.googleapis.com/..." at all — a test that passed while the
// request it was guarding against was being made on every page load.
const GOOGLE_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
function isGoogleFont(u) {
  try { return GOOGLE_FONT_HOSTS.has(new URL(u).hostname.toLowerCase()); }
  catch (e) { return false; }
}

describe('self-hosted fonts', { concurrency: 1 }, () => {
  let server, browser, page;
  const requested = [];
  const failed = [];
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('request', (r) => requested.push(r.url()));
    page.on('requestfailed', (r) => failed.push(r.url() + ' — ' + (r.failure() || {}).errorText));
    await page.goto(server.baseUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  test('no request is made to any Google font host', () => {
    const offenders = requested.filter(isGoogleFont);
    assert.deepStrictEqual(offenders, [],
      'these went to Google: ' + offenders.join(', '));
  });

  test('every request stays on this origin (no third party at all)', () => {
    const origin = new URL(server.baseUrl).origin;
    const offsite = requested
      .filter((u) => u.startsWith('http'))
      .filter((u) => new URL(u).origin !== origin);
    assert.deepStrictEqual(offsite, [],
      'unexpected third-party requests: ' + offsite.join(', '));
  });

  test('the local stylesheet is actually fetched and applied', async () => {
    assert.ok(requested.some((u) => u.endsWith('/fonts/fonts.css')),
      'the page should request /fonts/fonts.css');

    const faces = await page.evaluate(() => {
      let n = 0;
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of rules) if (r.constructor.name === 'CSSFontFaceRule') n++;
      }
      return n;
    });
    assert.ok(faces >= 20, 'expected the @font-face rules to be live, saw ' + faces);
  });

  test('the woff2 files are served and none 404', async () => {
    const fontReqs = requested.filter((u) => u.includes('/fonts/') && u.endsWith('.woff2'));
    assert.ok(fontReqs.length > 0, 'the page should pull at least one local woff2');
    const broken = failed.filter((f) => f.includes('/fonts/'));
    assert.deepStrictEqual(broken, [], 'font requests failed: ' + broken.join(', '));

    // And fetch one directly to confirm the route and content-type.
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u);
      return { ok: res.ok, type: res.headers.get('content-type'),
               len: +(res.headers.get('content-length') || 0) };
    }, fontReqs[0]);
    assert.strictEqual(r.ok, true);
    assert.match(r.type, /font\/woff2/);
    assert.ok(r.len > 1000, 'font file looks empty: ' + r.len + ' bytes');
  });

  test('the UI font actually resolves to the self-hosted family', async () => {
    const applied = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
      return { loaded: [...new Set(loaded)] };
    });
    assert.ok(applied.loaded.length > 0, 'no webfont reported as loaded');
    // Chakra Petch is the UI face; if the swap worked it is among them.
    assert.ok(applied.loaded.some((f) => /Chakra/i.test(f)),
      'expected Chakra Petch to load, got: ' + applied.loaded.join(', '));
  });

  test('the service worker no longer special-cases Google font hosts', async () => {
    const sw = await page.evaluate(async (base) => (await fetch(base + 'sw.js')).text(),
      server.baseUrl);
    assert.ok(/const FONT_HOSTS = \[\]/.test(sw),
      'sw.js should no longer list cross-origin font hosts');
    assert.ok(sw.includes("'/fonts/'"),
      'sw.js should cache the local font directory instead');
  });

  test('the bot control panel is also self-hosted', async () => {
    // It is a separate document loaded in an iframe with its own <head>, and it
    // carried its own copy of the Google font link.
    const before = requested.length;
    await page.goto(server.baseUrl + 'bot-control-panel.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const panelReqs = requested.slice(before);
    const offenders = panelReqs.filter(isGoogleFont);
    assert.deepStrictEqual(offenders, [],
      'the bot panel called Google: ' + offenders.join(', '));
    assert.ok(panelReqs.some((u) => u.endsWith('/fonts/fonts.css')),
      'the bot panel should pull the local stylesheet');
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

// Shareable bot links: build a bot, copy a link, open it somewhere else.
//
// This is the path that turns a bot into something you can post rather than
// email, so it is load-bearing for anything that spreads. It also has more
// moving parts than it looks: a codec, a URL contract, a reuse of the iframe's
// own postMessage apply path, and a flag that stops a link starting a game the
// visitor never asked for. None of that is exercised by the other suites.
//
// The regressions guarded here are all ones the feature actually had while it
// was being written:
//   - the config surviving the round trip at all, unicode names included;
//   - the payload staying in the hash, so it never reaches the server;
//   - a link applying the bot but NOT starting a game (it used to start one
//     silently behind the first-visit welcome panel);
//   - the hash being cleared, or a reload would revert edits to the shared bot;
//   - a malformed or foreign payload being ignored rather than half-applied;
//   - the bot being called by its name everywhere, not "Stockfish 10" in the
//     one control you press to play it.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('shareable bot links', { concurrency: 1 }, () => {
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

  // The panel is where a bot is built and where the link is copied from. It is
  // normally an iframe inside the board, but it is a page in its own right and
  // driving it directly keeps these tests about the link rather than about
  // opening a modal.
  async function openPanel() {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push('panel: ' + e.message));
    await page.goto(server.baseUrl + 'bot-control-panel.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#engine-mode-grid');
    await page.waitForTimeout(1200);
    return { ctx, page };
  }

  // A fresh visitor: its own context, so no localStorage from the builder.
  async function openBoard(url) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push('board: ' + e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2600);   // past botCheckShareUrl's 700ms + the toast's 400ms
    return { ctx, page };
  }

  // Build a bot in the panel and return the link its Link button produces.
  async function makeLink({ name, engine }) {
    const { ctx, page } = await openPanel();
    await page.evaluate(([n, e]) => {
      const card = document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]');
      if (card) card.click();
      document.getElementById('bot-save-name').value = n;
    }, [name, engine]);
    await page.waitForTimeout(400);
    await page.evaluate(() => document.getElementById('bot-share-btn').click());
    await page.waitForTimeout(600);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await ctx.close();
    return link;
  }

  test('the Link button produces a hash link on the site origin', async () => {
    const link = await makeLink({ name: 'Test Bot', engine: 'stockfish' });
    // The site's own origin, not the panel's URL: the recipient must land on
    // the board, not on a bare control panel.
    assert.ok(link.startsWith(server.baseUrl + '#bot='),
      'expected a link to the board origin with a #bot= fragment, got: ' + link.slice(0, 80));
    // The payload has to be URL-safe or it will not survive being pasted.
    const payload = link.split('#bot=')[1];
    assert.match(payload, /^[A-Za-z0-9\-_]+$/, 'payload must be base64url');
    assert.ok(payload.length > 100, 'payload looks too short to be a real config');
  });

  test('the config rides in the fragment, so it never reaches the server', async () => {
    const link = await makeLink({ name: 'Test Bot', engine: 'stockfish' });
    // A fragment is not sent in the request line. Asserting on the URL shape is
    // what keeps someone from "simplifying" this to ?bot= later, which would
    // put every shared bot in the server's access logs.
    const url = new URL(link);
    assert.strictEqual(url.search, '', 'no query string — the payload must not be a query param');
    assert.ok(url.hash.startsWith('#bot='), 'payload belongs in the hash');
  });

  test('opening a link applies the bot but does not start a game', async () => {
    const link = await makeLink({ name: 'Test Bot', engine: 'stockfish' });
    const { ctx, page } = await openBoard(link);
    const st = await page.evaluate(() => ({
      applied: !!window._lastAppliedBotConfig,
      appliedName: window._lastAppliedBotConfig && window._lastAppliedBotConfig.botName,
      botActive: typeof botActive !== 'undefined' ? botActive : null,
      toast: !!document.getElementById('bm-sharedbot-toast'),
    }));
    assert.ok(st.applied, 'the shared config should have been applied');
    assert.strictEqual(st.appliedName, 'Test Bot', 'the bot name should survive the link');
    // The regression: a link used to run botStart() immediately, so a game was
    // already ticking behind the welcome panel before the visitor read a word.
    assert.strictEqual(st.botActive, false, 'a link must not start a game on its own');
    assert.ok(st.toast, 'the visitor needs to be told a bot arrived');
    await ctx.close();
  });

  test('the payload is cleared from the address bar once applied', async () => {
    const link = await makeLink({ name: 'Test Bot', engine: 'stockfish' });
    const { ctx, page } = await openBoard(link);
    // Left in place it re-applies on every reload, silently reverting whatever
    // the recipient changed about the bot they were given.
    assert.strictEqual(await page.evaluate(() => location.hash), '',
      'the #bot= payload should be removed after it is applied');
    await ctx.close();
  });

  test('a named bot is called by its name everywhere, not by its engine level', async () => {
    const link = await makeLink({ name: 'Test Bot', engine: 'stockfish' });
    const { ctx, page } = await openBoard(link);
    const labels = await page.evaluate(() => {
      const sel = (id) => {
        const el = document.getElementById(id);
        return el && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : null;
      };
      const t = document.getElementById('bm-sharedbot-toast');
      return {
        toast: t ? t.innerText.split('\n')[0] : null,
        sidebar: sel('quickBotSel'),
        welcome: sel('bmwBotSel'),
      };
    });
    // Plain Stockfish at an expressible level used to win over the name, so the
    // one control you press to play "Test Bot" announced "Stockfish 10".
    assert.match(labels.toast, /Test Bot/, 'the notice should name the bot');
    assert.strictEqual(labels.sidebar, 'Test Bot', 'sidebar selector should name the bot');
    assert.strictEqual(labels.welcome, 'Test Bot', 'welcome panel selector should name the bot');
    await ctx.close();
  });

  test('an unnamed Stockfish pick still reads as its level', async () => {
    // The other half of the rule above: with no name to use, the level is the
    // more informative label and must not be replaced by a generated one.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push('board: ' + e.message));
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1800);
    await page.evaluate(() => quickBotPick('10'));
    await page.waitForTimeout(300);
    const label = await page.evaluate(() => {
      const el = document.getElementById('quickBotSel');
      return el && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : null;
    });
    assert.strictEqual(label, 'Stockfish 10');
    await ctx.close();
  });

  test('a non-ASCII bot name survives the round trip', async () => {
    // btoa is latin-1 only, so the codec goes through UTF-8 bytes. Without that
    // an accented name throws and the whole link fails to build.
    const link = await makeLink({ name: 'Café Entropy', engine: 'stockfish' });
    const { ctx, page } = await openBoard(link);
    const name = await page.evaluate(() =>
      window._lastAppliedBotConfig && window._lastAppliedBotConfig.botName);
    assert.strictEqual(name, 'Café Entropy');
    await ctx.close();
  });

  test('a Maia bot offers the download instead of sending you to the panel', async () => {
    const link = await makeLink({ name: 'Neural Nellie', engine: 'maia3' });
    const { ctx, page } = await openBoard(link);
    const st = await page.evaluate(() => {
      const t = document.getElementById('bm-sharedbot-toast');
      return {
        text: t ? t.innerText : '',
        button: t ? t.querySelector('button').textContent.trim() : null,
        botActive: typeof botActive !== 'undefined' ? botActive : null,
      };
    });
    // Most of what the builder can do needs Maia, so this is the common case for
    // a shared bot — not an edge case. A stranger from a link must not be told
    // to go and find a button somewhere else.
    assert.match(st.text, /Maia 3 model/, 'the notice should say the model is needed');
    assert.match(st.button, /Download/, 'the download must be offered right here');
    assert.strictEqual(st.botActive, false, 'still must not start a game by itself');
    await ctx.close();
  });

  test('a malformed payload is ignored, not half-applied', async () => {
    const { ctx, page } = await openBoard(server.baseUrl + '#bot=!!!not-base64!!!');
    const st = await page.evaluate(() => ({
      boardAlive: !!document.getElementById('cv'),
      applied: !!window._lastAppliedBotConfig,
      toast: !!document.getElementById('bm-sharedbot-toast'),
    }));
    assert.ok(st.boardAlive, 'a bad link must not take the board down with it');
    assert.ok(!st.applied, 'nothing should have been applied');
    assert.ok(!st.toast, 'and nothing should be announced');
    await ctx.close();
  });

  test('a well-formed payload that is not a bot config is ignored', async () => {
    // Decodes cleanly, so only the type tag stands between this and the apply
    // path. Anything reachable by editing a URL should fail closed.
    const payload = Buffer.from(JSON.stringify({ type: 'somethingElse', evil: 1 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const { ctx, page } = await openBoard(server.baseUrl + '#bot=' + payload);
    const st = await page.evaluate(() => ({
      boardAlive: !!document.getElementById('cv'),
      applied: !!window._lastAppliedBotConfig,
      toast: !!document.getElementById('bm-sharedbot-toast'),
    }));
    assert.ok(st.boardAlive);
    assert.ok(!st.applied, 'only a botConfig should be applied');
    assert.ok(!st.toast);
    await ctx.close();
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

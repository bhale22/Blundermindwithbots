// The landing page is the first impression, and two things about it are
// requirements rather than preferences:
//
//   1. It must fit on one screen. Anything below the fold is effectively
//      invisible to a first-time visitor.
//   2. What launches a game must be distinguishable from what is merely a
//      setting. The board-style tiles used to be styled exactly like the launch
//      cards and sat above them, so they read as destinations.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

// Sizes a first-time visitor plausibly arrives at, including the cramped ones.
const VIEWPORTS = [
  ['1280x720 (small laptop)', { width: 1280, height: 720 }],
  ['1366x768 (common laptop)', { width: 1366, height: 768 }],
  ['1440x900 (macbook)', { width: 1440, height: 900 }],
  ['1920x1080 (desktop)', { width: 1920, height: 1080 }],
];

describe('landing page layout', { concurrency: 1 }, () => {
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

  async function open(opts = {}) {
    const ctx = opts.phone
      ? await H.phoneContext(browser)
      : await browser.newContext({ viewport: opts.viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    if (opts.shell) {
      await page.addInitScript((s) => {
        try { localStorage.setItem('bm_shell', s); } catch (e) {}
      }, opts.shell);
    }
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#landingOverlay');
    await page.waitForTimeout(1500);
    return { ctx, page };
  }

  const overflow = (page) => page.evaluate(() => {
    const ov = document.getElementById('landingOverlay');
    return ov.scrollHeight - ov.clientHeight;
  });

  for (const [label, viewport] of VIEWPORTS) {
    test(`fits on one screen at ${label}`, async () => {
      for (const shell of ['amateur', 'pro']) {
        const { ctx, page } = await open({ viewport, shell });
        const over = await overflow(page);
        assert.ok(over <= 1,
          shell + ' shell overflows by ' + over + 'px at ' + label);
        await ctx.close();
      }
    });
  }

  test('fits on one screen on a phone', async () => {
    const { ctx, page } = await open({ phone: true });
    const over = await overflow(page);
    assert.ok(over <= 1, 'phone landing overflows by ' + over + 'px');
    await ctx.close();
  });

  test('the launch actions come before the board-style setting', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const order = await page.evaluate(() => {
      const cards = document.querySelector('.landing-cards').getBoundingClientRect().top;
      const style = document.querySelector('.landing-shell-pick').getBoundingClientRect().top;
      return { cards, style };
    });
    assert.ok(order.cards < order.style,
      'the launch cards must sit above the board-style block');
    await ctx.close();
  });

  // On a phone the card is a grid with a named area per child. The go-text had
  // no area, so it was auto-placed into the 36px icon column and came out one
  // word per line — "Play / a / friend".
  test('the call-to-action sits on one line on a phone', async () => {
    for (const shell of ['amateur', 'pro']) {
      const { ctx, page } = await open({ phone: true, shell });
      const gos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.landing-card .landing-card-go')).map((g) => {
          const cs = getComputedStyle(g);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
          return {
            text: g.textContent.trim(),
            lines: Math.round(g.getBoundingClientRect().height / lh),
            // Must be beside the icon, not inside its 36px gutter.
            width: Math.round(g.getBoundingClientRect().width),
          };
        }));
      assert.strictEqual(gos.length, 3, shell + ': three cards');
      for (const g of gos) {
        assert.ok(g.lines <= 1,
          shell + ': "' + g.text + '" wrapped onto ' + g.lines + ' lines');
        assert.ok(g.width > 40,
          shell + ': "' + g.text + '" is only ' + g.width + 'px wide — squeezed into the icon column');
      }
      await ctx.close();
    }
  });

  // The blurbs restated the button below them, and being static they went stale
  // whenever the board style changed: the Solo one promised hover overlays that
  // Expert deliberately does not draw.
  test('the cards carry no stale blurb', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const descs = await page.evaluate(() =>
      document.querySelectorAll('.landing-card-desc').length);
    assert.strictEqual(descs, 0, 'the per-card descriptions should be gone');
    const titles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.landing-card-title')).map((t) => t.textContent.trim()));
    assert.ok(titles.includes('Bot Builder'),
      'the bot card should be "Bot Builder" — the action underneath already says "Play a bot"; got '
        + JSON.stringify(titles));
    await ctx.close();
  });

  test('every launch card carries an explicit button', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.landing-cards .landing-card')).map((c) => ({
        title: (c.querySelector('.landing-card-title') || {}).textContent || '',
        go: (c.querySelector('.landing-card-go') || {}).textContent || null,
        launches: !!(c.getAttribute('onclick') || '').includes('landingChoose'),
      })));
    assert.strictEqual(cards.length, 3, 'three primary launch cards');
    for (const c of cards) {
      assert.ok(c.go && c.go.trim(), c.title + ' has no call-to-action');
      assert.ok(c.launches, c.title + ' does not launch anything');
    }
    await ctx.close();
  });

  test('the board-style choice is radios, not pressable cards', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const info = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.landing-shell-btn'));
      return btns.map((b) => ({
        role: b.getAttribute('role'),
        checked: b.getAttribute('aria-checked'),
        shell: b.dataset.shell,
        hasDot: !!b.querySelector('.ls-dot'),
        // The thing that used to make these look launchable.
        outlined: getComputedStyle(b).borderColor,
        sel: b.classList.contains('sel'),
      }));
    });
    assert.strictEqual(info.length, 2);
    for (const b of info) {
      assert.strictEqual(b.role, 'radio', b.shell + ' should be a radio');
      assert.ok(b.hasDot, b.shell + ' should have a selection dot');
    }
    assert.ok(await page.evaluate(() =>
      !!document.querySelector('.landing-shell-row[role="radiogroup"]')),
      'the pair should be a radiogroup');
    await ctx.close();
  });

  test('the dot and aria-checked track the active shell', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const read = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('.landing-shell-btn')).map((b) => ({
        shell: b.dataset.shell,
        sel: b.classList.contains('sel'),
        checked: b.getAttribute('aria-checked'),
        // The filled centre only exists on the selected dot.
        filled: getComputedStyle(b.querySelector('.ls-dot'), '::after').content !== 'none',
      })));

    let s = await read();
    assert.deepStrictEqual(s.map((x) => x.sel), [true, false], 'amateur selected by default');
    assert.deepStrictEqual(s.map((x) => x.checked), ['true', 'false']);
    assert.strictEqual(s[0].filled, true, 'the selected dot should be filled');
    assert.strictEqual(s[1].filled, false, 'the unselected dot should be hollow');

    await page.evaluate(() => landingSetShell('pro'));
    await page.waitForTimeout(300);
    s = await read();
    assert.deepStrictEqual(s.map((x) => x.sel), [false, true], 'expert now selected');
    assert.deepStrictEqual(s.map((x) => x.checked), ['false', 'true']);
    assert.strictEqual(s[1].filled, true);
    assert.strictEqual(s[0].filled, false);

    await page.evaluate(() => landingSetShell('amateur'));
    await page.waitForTimeout(300);
    s = await read();
    assert.deepStrictEqual(s.map((x) => x.sel), [true, false], 'and back');
    await ctx.close();
  });

  test('choosing a board style does not launch anything', async () => {
    // The whole complaint: these looked like they should start a game.
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    await page.locator('.landing-shell-btn[data-shell="pro"]').click();
    await page.waitForTimeout(500);
    assert.strictEqual(await H.landingVisible(page), true,
      'picking a board style must leave you on the landing page');
    await ctx.close();
  });

  test('the load buttons are present and wired', async () => {
    const { ctx, page } = await open({ viewport: { width: 1366, height: 768 } });
    const load = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.landing-loadbtn')).map((b) => ({
        text: b.textContent.trim(),
        onclick: b.getAttribute('onclick') || '',
      })));
    assert.strictEqual(load.length, 2);
    assert.ok(load.some((b) => /landingChoose\('pgn'\)/.test(b.onclick)), 'load game wired');
    assert.ok(load.some((b) => /landingBotConfigInput/.test(b.onclick)), 'load bot wired');
    assert.ok(await page.evaluate(() => !!document.getElementById('landingBotConfigInput')),
      'the bot config file input must still exist');
    await ctx.close();
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

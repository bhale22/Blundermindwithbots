// What the in-app feedback box sends.
//
// Testers report from phones with no devtools, so a message on its own rarely
// says which deploy or device it came from. The box attaches a small, fixed set
// of technical fields — and only those: privacy.html lists them, so a field
// added here without updating the policy is a bug this catches.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

const ALLOWED = ['message', '_subject', 'build', 'where', 'shell', 'screen', 'browser', 'device'];

describe('feedback context', { concurrency: 1 }, () => {
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

  async function send(query) {
    const ctx = await H.phoneContext(browser);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.dismiss());
    let body = null;
    await page.route('https://formspree.io/**', async (route) => {
      body = JSON.parse(route.request().postData() || 'null');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(server.baseUrl + (query || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1200);
    await H.dismissLanding(page);
    await page.evaluate(() => openPanel('aboutFeedbackPanel'));
    await page.waitForTimeout(300);
    const noteVisible = await page.locator('#feedbackAttachNote').isVisible();
    await page.fill('#feedbackText', 'the bot froze after castling');
    await page.click('#aboutFeedbackPanel .panel-send-btn');
    await page.waitForFunction(() =>
      getComputedStyle(document.getElementById('feedbackThanks')).display !== 'none', null, { timeout: 5000 });
    const vp = page.viewportSize();
    const build = await page.evaluate(() => window.__BM_BUILD);
    await ctx.close();
    return { body, noteVisible, vp, build };
  }

  test('the message arrives with build, context, board and screen', async () => {
    const { body, vp, build } = await send('?app=1');
    assert.ok(body, 'nothing was posted to Formspree');
    assert.strictEqual(body.message, 'the bot froze after castling');
    assert.strictEqual(body._subject, 'Blundermind Feedback');
    assert.ok(build && body.build === build, 'build should be this deploy: ' + body.build);
    assert.strictEqual(body.where, 'app');
    assert.match(body.shell, /^(visualization|expert)$/);
    assert.ok(body.screen.startsWith(vp.width + 'x' + vp.height + ' @'), 'screen was ' + body.screen);
    assert.ok(body.browser && body.browser.length > 10, 'user agent missing');
    if ('device' in body) assert.strictEqual(typeof body.device, 'string');
  });

  test('on the website it says so', async () => {
    const { body } = await send('');
    assert.strictEqual(body.where, 'web');
  });

  test('nothing beyond the disclosed fields is sent', async () => {
    const { body } = await send('?app=1');
    const extra = Object.keys(body).filter((k) => !ALLOWED.includes(k));
    assert.deepStrictEqual(extra, [], 'undisclosed fields: ' + extra.join(', '));
  });

  test('the panel tells the sender what is attached', async () => {
    const { noteVisible } = await send('?app=1');
    assert.strictEqual(noteVisible, true);
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

// A posted challenge is a commitment, not a passive state.
//
// The bug this guards: post a challenge, go back to the board, start a bot
// game. Nothing stopped you — and the moment anyone accepted the challenge,
// the accept tore down the bot game mid-play. Two games, one board, and the
// one you were actually playing lost.
//
// Also covered here: posting used to be instant, so a wrong time control or
// colour was only discovered once an opponent had already joined.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('posted challenges', { concurrency: 1 }, () => {
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

  // A page with the 2-player panel open and the landing dismissed.
  async function openMp(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof openPanel === 'function');
    await H.dismissLanding(page);
    if (opts.handle !== undefined || opts.rating !== undefined) {
      await page.evaluate(({ handle, rating }) => {
        const n = document.getElementById('mpLobbyName');
        const r = document.getElementById('mpLobbyRating');
        if (n && handle !== undefined) n.value = handle;
        if (r && rating !== undefined) r.value = rating;
      }, opts);
    }
    await page.evaluate(() => openPanel('mpPanel'));
    await page.waitForTimeout(600);
    // openPanel() reloads Your Info from storage; re-apply after it settles.
    if (opts.handle !== undefined || opts.rating !== undefined) {
      await page.evaluate(({ handle, rating }) => {
        const n = document.getElementById('mpLobbyName');
        const r = document.getElementById('mpLobbyRating');
        if (n && handle !== undefined) n.value = handle;
        if (r && rating !== undefined) r.value = rating;
      }, opts);
    }
    return { ctx, page };
  }

  const confirmOpen = (page) => page.evaluate(() =>
    !!document.getElementById('mpPostConfirm')?.classList.contains('open'));

  const mode = (page) => page.evaluate(() => mpMode);

  // ── The review step ───────────────────────────────────────────────────────

  test('posting opens a review of the settings instead of posting immediately', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await page.evaluate(() => {
      mpBaseMin = 15; mpIncSec = 10; mpHostColor = 'black';
      mpRatingRange = 200; mpRatingType = 'Lichess';
    });
    await page.locator('button:has-text("Post Open Challenge")').click();
    await page.waitForTimeout(400);

    assert.strictEqual(await confirmOpen(page), true, 'the review modal should open');
    assert.notStrictEqual(await mode(page), 'lobby-waiting',
      'nothing may be posted before the user confirms');

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mpPostSummary .mp-ps-row')).map((r) => [
        r.querySelector('.mp-ps-k').textContent.trim(),
        r.querySelector('.mp-ps-v').textContent.trim(),
      ]));
    const get = (k) => (rows.find((r) => r[0] === k) || [])[1];

    assert.strictEqual(get('Handle'), 'Ada');
    assert.strictEqual(get('Rating'), '1650 Lichess');
    assert.strictEqual(get('Time'), '15 min + 10 sec');
    assert.ok(/Black/.test(get('You play')), 'colour should be shown, got ' + get('You play'));
    assert.ok(/200/.test(get('Accepts')), 'rating band should be shown, got ' + get('Accepts'));
    await ctx.close();
  });

  test('cancelling the review posts nothing and costs nothing', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await page.locator('button:has-text("Post Open Challenge")').click();
    await page.waitForTimeout(300);
    await page.locator('#mpPostConfirm button:has-text("Cancel")').click();
    await page.waitForTimeout(400);

    assert.strictEqual(await confirmOpen(page), false, 'the modal should close');
    assert.notStrictEqual(await mode(page), 'lobby-waiting', 'must not be posted');
    assert.strictEqual(await page.evaluate(() => !!mpRoomId), false,
      'cancelling must not have created a room');
    await ctx.close();
  });

  test('a blank handle is shown as Anonymous rather than left implicit', async () => {
    const { ctx, page } = await openMp({ handle: '', rating: '' });
    await page.locator('button:has-text("Post Open Challenge")').click();
    await page.waitForTimeout(400);
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mpPostSummary .mp-ps-row')).map((r) => [
        r.querySelector('.mp-ps-k').textContent.trim(),
        r.querySelector('.mp-ps-v').textContent.trim(),
      ]));
    const get = (k) => (rows.find((r) => r[0] === k) || [])[1];
    assert.strictEqual(get('Handle'), 'Anonymous');
    assert.strictEqual(get('Rating'), 'Unrated');
    // A band around no rating would not actually filter anything.
    assert.ok(/Anyone/.test(get('Accepts')), 'got ' + get('Accepts'));
    await ctx.close();
  });

  test('confirming actually posts the challenge', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await page.locator('button:has-text("Post Open Challenge")').click();
    await page.waitForTimeout(300);
    await page.locator('#mpPostConfirm button:has-text("Post Challenge")').click();
    await page.waitForTimeout(1200);
    assert.strictEqual(await mode(page), 'lobby-waiting', 'should be waiting for an opponent');
    assert.ok(await page.evaluate(() => !!mpRoomId), 'a room should exist');
    await ctx.close();
  });

  // ── The commitment ────────────────────────────────────────────────────────

  async function postChallenge(page) {
    await page.locator('button:has-text("Post Open Challenge")').click();
    await page.waitForTimeout(300);
    await page.locator('#mpPostConfirm button:has-text("Post Challenge")').click();
    await page.waitForTimeout(1200);
    assert.strictEqual(await mode(page), 'lobby-waiting', 'setup: challenge should be posted');
  }

  test('a standing challenge counts as a commitment', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);
    const pending = await page.evaluate(() => _isPendingChallenge());
    assert.strictEqual(pending, true);
    // It is not a *live game* — that distinction is what let it slip through.
    assert.strictEqual(await page.evaluate(() => _isLiveGame()), false);
    await ctx.close();
  });

  test('starting a bot game with a challenge posted asks first, and declining keeps both', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);

    let asked = null;
    page.on('dialog', (d) => { asked = d.message(); d.dismiss(); });
    await page.evaluate(() => { closeAllPanels(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => botStart());
    await page.waitForTimeout(1000);

    assert.ok(asked, 'starting a bot game must prompt while a challenge stands');
    assert.ok(/withdraw/i.test(asked), 'the prompt should say the challenge is withdrawn: ' + asked);
    assert.strictEqual(await mode(page), 'lobby-waiting',
      'declining must leave the challenge posted');
    assert.strictEqual(await page.evaluate(() => !!botActive), false,
      'declining must not start the bot game');
    await ctx.close();
  });

  test('accepting withdraws the challenge and then starts the bot game', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);

    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => { closeAllPanels(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => botStart());
    await page.waitForTimeout(1500);

    assert.strictEqual(await page.evaluate(() => !!mpRoomId), false,
      'the challenge must be given up, not left standing');
    assert.notStrictEqual(await mode(page), 'lobby-waiting');
    // mpLeave() calls resetGame() on its way out; the bot game still has to
    // come up on the other side of that.
    await page.waitForFunction(() => !!botActive, null, { timeout: 15000 });
    assert.strictEqual(await page.evaluate(() => !!botActive), true,
      'the bot game the user asked for must actually start');
    await ctx.close();
  });

  // ── The board other people see ────────────────────────────────────────────

  test('a withdrawn challenge leaves the board other players are looking at', async () => {
    const host = await openMp({ handle: 'HostPlayer', rating: '1500' });
    await postChallenge(host.page);

    const watcher = await openMp({ handle: 'Watcher', rating: '1500' });
    await watcher.page.waitForTimeout(1500);

    const seen = () => watcher.page.evaluate(() =>
      Array.from(document.querySelectorAll('.mp-challenge-row')).map((r) => r.textContent));
    const before = await seen();
    assert.ok(before.some((t) => /HostPlayer/.test(t)),
      'the watcher should see the posted challenge, saw: ' + JSON.stringify(before));

    host.page.on('dialog', (d) => d.accept());
    await host.page.evaluate(() => { closeAllPanels(); botStart(); });
    // Server broadcasts on withdrawal; the 2s poll is only a backstop.
    await watcher.page.waitForTimeout(3000);

    const after = await seen();
    assert.ok(!after.some((t) => /HostPlayer/.test(t)),
      'the withdrawn challenge should be gone, still saw: ' + JSON.stringify(after));
    await host.ctx.close();
    await watcher.ctx.close();
  });

  test('a hostile handle cannot inject markup into other players boards', async () => {
    const host = await openMp({ handle: '<img src=x onerror=alert(1)>', rating: '1500' });
    await postChallenge(host.page);

    const watcher = await openMp({ handle: 'Watcher', rating: '1500' });
    await watcher.page.waitForTimeout(1800);

    // Find the row by its content, not by position — other suites' challenges
    // may still be on this server's board.
    const row = await watcher.page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.mp-challenge-row'))
        .find((el) => /onerror/.test(el.textContent) || /<img/i.test(el.innerHTML));
      return r ? { html: r.innerHTML, text: r.textContent } : null;
    });
    assert.ok(row, 'the challenge should be listed');
    assert.ok(!/<img/i.test(row.html),
      'the handle must not become a live element: ' + row.html.slice(0, 200));
    assert.ok(/onerror/.test(row.text),
      'it should still be shown, as inert text');
    await host.ctx.close();
    await watcher.ctx.close();
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

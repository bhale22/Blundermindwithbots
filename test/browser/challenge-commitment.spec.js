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

  // ── The marker on the board ───────────────────────────────────────────────
  // Without it, a posted challenge is invisible the moment you leave the panel.

  const marker = (page) => page.evaluate(() => {
    const el = document.getElementById('mpChallengeMarker');
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { text: el.querySelector('.mcm-txt').textContent.trim(),
             visible: r.width > 0 && r.height > 0, top: Math.round(r.top) };
  });

  test('a standing challenge is marked on the board once the panel closes', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);
    // Redundant while the panel that manages it is open.
    assert.strictEqual(await marker(page), null,
      'the marker should stay hidden behind the open panel');

    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(500);
    const m = await marker(page);
    assert.ok(m, 'the marker should appear once the panel closes');
    assert.strictEqual(m.visible, true, 'and actually occupy space');
    assert.ok(/challenge|invite/i.test(m.text), 'got: ' + m.text);
    await ctx.close();
  });

  test('the marker covers nothing, and stays in view when scrolled', async () => {
    // First attempt was position:fixed, which parked the bar directly on top of
    // the Tour / About / Support row on a phone.
    const ctx = await H.phoneContext(browser);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof openPanel === 'function');
    await H.dismissLanding(page);
    await page.evaluate(() => openPanel('mpPanel'));
    await page.waitForTimeout(600);
    await postChallenge(page);
    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(600);

    const overlap = await page.evaluate(() => {
      const m = document.getElementById('mpChallengeMarker').getBoundingClientRect();
      return ['#headerBtnGroup', '#site-header', '#cv'].map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, over: 0 };
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(m.right, r.right) - Math.max(m.left, r.left));
        const y = Math.max(0, Math.min(m.bottom, r.bottom) - Math.max(m.top, r.top));
        return { sel, over: Math.round(x * y) };
      });
    });
    for (const o of overlap) {
      assert.strictEqual(o.over, 0, 'the marker overlaps ' + o.sel + ' by ' + o.over + 'px²');
    }

    // Sticky, so scrolling down the board does not lose it.
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(400);
    const onScreen = await page.evaluate(() => {
      const r = document.getElementById('mpChallengeMarker').getBoundingClientRect();
      return r.top >= -1 && r.bottom <= window.innerHeight;
    });
    assert.strictEqual(onScreen, true, 'the marker should stay in view when scrolled');
    await ctx.close();
  });

  test('the marker goes away when the challenge does', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);
    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(400);
    assert.ok(await marker(page), 'setup: marker should be showing');

    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => mpWithdrawChallenge());
    await page.waitForTimeout(700);
    assert.strictEqual(await marker(page), null, 'the marker should be gone');
    assert.strictEqual(await page.evaluate(() => !!mpRoomId), false,
      'and the challenge withdrawn');
    await ctx.close();
  });

  test('withdrawing from the marker keeps the position being explored', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);
    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(400);

    // Explore a little, the way someone waiting for an opponent would.
    const mouse = H.mouseDriver(page);
    await mouse.drag(await H.squareCentre(page, 4, 2), await H.squareCentre(page, 4, 4));
    const movesBefore = await page.evaluate(() => gameMovesAlgebraic.length);
    assert.ok(movesBefore > 0, 'setup: a move should have been made');

    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => mpWithdrawChallenge());
    await page.waitForTimeout(700);

    assert.strictEqual(await page.evaluate(() => gameMovesAlgebraic.length), movesBefore,
      'withdrawing an offer must not wipe the board the user was exploring');
    await ctx.close();
  });

  test('declining the withdraw leaves the challenge and the marker up', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    await postChallenge(page);
    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(400);

    page.on('dialog', (d) => d.dismiss());
    await page.evaluate(() => mpWithdrawChallenge());
    await page.waitForTimeout(600);
    assert.ok(await marker(page), 'the marker should still be up');
    assert.strictEqual(await mode(page), 'lobby-waiting', 'challenge still posted');
    await ctx.close();
  });

  // ── Exploring while an offer is out ───────────────────────────────────────

  test('the board is free to explore with either colour while waiting', async () => {
    const { ctx, page } = await openMp({ handle: 'Ada', rating: '1650' });
    // Explicitly host as Black. With the default random colour this was a coin
    // flip, and the black branch is the one that was broken: holding a room
    // flipped the board and locked input to the host's colour before there was
    // any game to have a colour in.
    await page.evaluate(() => { mpHostColor = 'black'; });
    await postChallenge(page);
    assert.strictEqual(await page.evaluate(() => mpRole), 'black', 'setup: hosting as Black');
    assert.strictEqual(await page.evaluate(() => !!boardFlipped), false,
      'an unstarted challenge should not flip the board');
    await page.evaluate(() => closeAllPanels());
    await page.waitForTimeout(400);

    // Both colours, regardless of which one the host was assigned. Holding a
    // room used to lock the board to mpRole even with no opponent in it.
    const mouse = H.mouseDriver(page);
    await mouse.drag(await H.squareCentre(page, 4, 2), await H.squareCentre(page, 4, 4));
    await mouse.drag(await H.squareCentre(page, 4, 7), await H.squareCentre(page, 4, 5));
    assert.strictEqual(await page.evaluate(() => gameMovesAlgebraic.length), 2,
      'both sides of an unstarted position should be movable');
    await ctx.close();
  });

  test('exploring while waiting does not leak into the game that follows', async () => {
    // The corruption path: the room exists from the moment the challenge is
    // posted, so idle exploration was relayed into it and recorded as game
    // history. A reconnect after someone joined would then rebuild the game
    // from the host's shuffling.
    const host = await openMp({ handle: 'HostExplore', rating: '1500' });
    await postChallenge(host.page);
    await host.page.evaluate(() => closeAllPanels());
    await host.page.waitForTimeout(400);

    const mouse = H.mouseDriver(host.page);
    await mouse.drag(await H.squareCentre(host.page, 4, 2), await H.squareCentre(host.page, 4, 4));
    await mouse.drag(await H.squareCentre(host.page, 4, 7), await H.squareCentre(host.page, 4, 5));
    await mouse.drag(await H.squareCentre(host.page, 6, 1), await H.squareCentre(host.page, 5, 3));
    assert.ok(await host.page.evaluate(() => gameMovesAlgebraic.length) > 0,
      'setup: the host should have explored');

    const code = await host.page.evaluate(() => mpRoomId);
    const guest = await openMp({ handle: 'Guest', rating: '1500' });
    await guest.page.evaluate((c) => mpDoAcceptLobby(c), code);
    await guest.page.waitForTimeout(2500);

    assert.strictEqual(await host.page.evaluate(() => mpMode), 'ingame', 'host should be in game');
    assert.strictEqual(await guest.page.evaluate(() => mpMode), 'ingame', 'guest should be in game');
    for (const [who, p] of [['host', host.page], ['guest', guest.page]]) {
      assert.strictEqual(await p.evaluate(() => gameMovesAlgebraic.length), 0,
        who + ' should start the real game from move zero, not from the exploration');
    }
    await host.ctx.close();
    await guest.ctx.close();
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

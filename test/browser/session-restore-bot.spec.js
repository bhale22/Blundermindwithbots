// Restoring a TIMED BOT game — the demanding case.
//
// Beyond the position, this has to bring back the bot's identity (engine tab,
// rating, colour), the burnt-down clocks rather than the time control's
// defaults, and whose turn it is. The hardest sub-case is the phone dying
// while the bot is thinking: on restore the bot has to notice it is on move
// and actually play.
//
// The bot config is persisted through botCollectConfig/botApplyConfig, the
// same pair the Save/Load Config buttons use. That sharing is deliberate, and
// it is why this suite doubles as coverage for those buttons — a stale element
// id in botCollectConfig once broke Save Config and this snapshot together.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('session restore — timed bot game', { concurrency: 1 }, () => {
  let server, browser, ctx, page;
  const errs = [];
  let snap, atRestore;

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    ctx = await H.phoneContext(browser);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  test('botCollectConfig does not throw (guards Save Config too)', async () => {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2200);
    await H.dismissLanding(page);

    const res = await page.evaluate(() => {
      try {
        const c = botCollectConfig('t', '');
        return { ok: true, keys: Object.keys(c) };
      } catch (e) { return { ok: false, err: e.message }; }
    });
    assert.ok(res.ok, 'botCollectConfig threw: ' + res.err);
    assert.ok(res.keys.includes('maia') && res.keys.includes('premove'));
  });

  test('a timed bot game snapshots with the bot to move', async () => {
    await page.evaluate(() => {
      botSetPlayerColor('white');
      botSetTC('rapid10');
      maia3SetRating(1700);
      botSetTab('maia3');
      botStart();
    });
    await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => botActive), 'bot game should be active');
    assert.notStrictEqual(await page.evaluate(() => clockControl), 'untimed');

    // Human plays e4, then wait for the bot's reply so we are back on move.
    await page.evaluate(() => { executeMove(52, 36); });
    await page.waitForTimeout(7000);
    const replied = await page.evaluate(() => gameMovesAlgebraic.slice());
    assert.ok(replied.length >= 2, 'bot should have replied: ' + replied.join(' '));

    // Now play Nf3 and grab the snapshot immediately. It is written
    // synchronously inside executeMove, so it captures the bot to move — the
    // case where the phone dies mid-think.
    await page.evaluate(() => { executeMove(62, 45); });
    snap = await page.evaluate(() => JSON.parse(localStorage.getItem('bm_liveGame') || 'null'));

    assert.ok(snap, 'snapshot should exist');
    assert.match(snap.fen, / b /, 'snapshot should have Black (the bot) to move');
    assert.ok(snap.bot && snap.bot.active && snap.bot.config, 'bot config should be captured');
    assert.strictEqual(snap.bot.config.maia.elo, 1700, 'rating should be captured');
  });

  test('restores with the bot to move, before it plays', async () => {
    // Restore fires ~300ms after load, the bot's resumed move ~1500ms. Read in
    // between so we observe the restored state rather than the bot's move on
    // top of it.
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1000);

    atRestore = await page.evaluate(() => ({
      turn: turn, moves: gameMovesAlgebraic.slice(), active: botActive,
    }));
    assert.strictEqual(atRestore.turn, 'b', 'bot should be on move');
    assert.deepStrictEqual(atRestore.moves, snap.moves, 'move list should match the snapshot');
    assert.strictEqual(atRestore.active, true);
    assert.strictEqual(await H.landingVisible(page), false, 'landing must not be shown');
  });

  test('bot identity and clocks come back', async () => {
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => ({
      playerColor: botPlayerColor, tab: botTab, control: clockControl,
      w: clockTimeW, bl: clockTimeB, rating: maia3SelectedRating,
      sidebar: (document.getElementById('botSidebarBtn') || {}).textContent || 'Bot Active',
    }));

    assert.strictEqual(after.playerColor, 'white', 'human colour');
    assert.strictEqual(after.tab, 'maia3', 'engine tab');
    assert.strictEqual(after.rating, 1700, 'bot rating');
    assert.strictEqual(after.control, snap.clock.control, 'time control');
    assert.match(after.sidebar, /Bot Active/);

    // The clock legitimately keeps ticking once restored, so allow a little
    // drift. What matters is that it is near the burnt-down value and NOT the
    // 600s the time control would reset it to.
    const wDrift = Math.abs(after.w - snap.clock.w);
    const bDrift = Math.abs(after.bl - snap.clock.b);
    assert.ok(wDrift <= 8, 'white clock drift ' + wDrift + ' (was ' + snap.clock.w + ', now ' + after.w + ')');
    assert.ok(bDrift <= 8, 'black clock drift ' + bDrift + ' (was ' + snap.clock.b + ', now ' + after.bl + ')');
  });

  test('the bot personality survives the reload, not just its rating', async () => {
    // botCollectConfig used to capture the rating, tab and colour but none of
    // the Build-A-Bot personality, so a resumed game came back as a generic
    // engine of the same strength — the opposite of the point for a site whose
    // whole premise is the bot you built.
    const p = await page.evaluate(() => ({
      attractors: window._bcpAttractorValues,
      budget: window._bcpCpBudget,
      controls: window._bcpCustomControls,
    }));
    assert.ok(p, 'personality globals should exist after restore');

    // Set a distinctive personality, snapshot it, and reload.
    await page.evaluate(() => {
      window._bcpAttractorValues = { hustle: 4, trade: -3 };
      window._bcpCpBudget = 175;
      window._bcpCpHardFloor = 220;
      window._bcpCustomControls = [{ id: 'x1', name: 'push pawns', metric: 'pawnAdvance', phase: 'all', value: 3 }];
      botMinProbPct = 12;
      botDayLower = 20; botDayUpper = 80;
      bmSessionSave();
    });
    const snap = await page.evaluate(() => JSON.parse(localStorage.getItem('bm_liveGame')));
    assert.ok(snap.bot.config.personality, 'snapshot should carry a personality block');
    assert.strictEqual(snap.bot.config.personality.attractorValues.hustle, 4);

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(2400);

    const after = await page.evaluate(() => ({
      attractors: window._bcpAttractorValues,
      budget: window._bcpCpBudget,
      hardFloor: window._bcpCpHardFloor,
      controls: window._bcpCustomControls,
      minProb: botMinProbPct,
      dayLower: botDayLower, dayUpper: botDayUpper,
    }));
    assert.deepStrictEqual(after.attractors, { hustle: 4, trade: -3 }, 'attractors restored');
    assert.strictEqual(after.budget, 175, 'CP budget restored');
    assert.strictEqual(after.hardFloor, 220, 'hard floor restored');
    assert.strictEqual(after.controls.length, 1, 'custom controls restored');
    assert.strictEqual(after.controls[0].metric, 'pawnAdvance');
    assert.strictEqual(after.minProb, 12, 'probability floor restored');
    assert.strictEqual(after.dayLower, 20, 'move-quality band restored');
    assert.strictEqual(after.dayUpper, 80);
  });

  test('the bot resumes thinking and plays its move', async () => {
    await page.waitForTimeout(11000);
    const now = await page.evaluate(() => gameMovesAlgebraic.slice());
    assert.ok(now.length > snap.moves.length,
      'bot should have moved: ' + snap.moves.join(' ') + ' → ' + now.join(' '));
    assert.deepStrictEqual(now.slice(0, snap.moves.length), snap.moves,
      'restored moves should be a prefix of the continued game');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

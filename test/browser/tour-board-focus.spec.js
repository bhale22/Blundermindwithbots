// On a phone the board-vision controls live in a drawer below the board, far
// enough away that scrolling a button into view pushes the board off screen.
// The overlay part of the tour describes things DRAWN ON THE BOARD, so without
// care the tour describes something the user cannot see.
//
// That part of the tour is now one interactive step: the visitor presses the
// overlays themselves, in any order. The guarantees below are the same ones
// the old per-indicator steps had, restated for that step —
//
//   1. On a phone the spotlight is on the BOARD, the whole board is in view,
//      and the panel does not cover the thing it is describing.
//   2. The controls come to the panel, because the real grid is off screen —
//      as inert chips carrying no ids and no handlers.
//   3. The panel's own buttons stay reachable, so the step can be left.
//   4. Desktop still points at the real controls, which are on screen there.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('board tour on a phone', { concurrency: 1 }, () => {
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

  async function openTour(opts = {}) {
    const ctx = opts.phone
      ? await H.phoneContext(browser)
      : await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof startTour === 'function');
    await H.dismissLanding(page);
    if (opts.before) await opts.before(page);   // e.g. start a game first
    await page.evaluate(() => startTour());
    await page.waitForTimeout(800);
    return { ctx, page };
  }

  // Walk to the interactive overlay step by stepping, not by jumping, so the
  // ordinary Next path is what gets exercised.
  async function stepToExplore(page) {
    for (let i = 0; i < 30; i++) {
      const cur = await page.evaluate(() => ({
        explore: !!_tourSteps[_tourIdx].explore,
        idx: _tourIdx,
        last: _tourIdx === _tourSteps.length - 1,
      }));
      if (cur.explore) return cur.idx;
      if (cur.last) break;
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(420);
    }
    throw new Error('never reached the interactive overlay step');
  }

  const geometry = (page) => page.evaluate(() => {
    const ring = document.getElementById('tourRing').getBoundingClientRect();
    const cv = document.getElementById('cv').getBoundingClientRect();
    const panel = document.getElementById('tourPanel').getBoundingClientRect();
    const next = document.getElementById('tourNext').getBoundingClientRect();
    const ov = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      ringOnBoard: Math.abs(ring.top - (cv.top - 6)) < 4 &&
                   Math.abs(ring.left - (cv.left - 6)) < 4,
      boardOnScreen: cv.top > -4 && cv.bottom <= window.innerHeight + 4,
      panelOverBoard: Math.round(ov(panel, cv)),
      nextReachable: next.bottom <= window.innerHeight + 1 && next.top >= 0,
      chips: document.querySelectorAll('.tour-chip').length,
      dimmed: getComputedStyle(document.getElementById('tourRing'))
                .boxShadow.includes('9999'),
    };
  });

  test('the overlay step spotlights the board, not the far-away grid', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const g = await geometry(page);
    assert.strictEqual(g.ringOnBoard, true, 'the spotlight should be on the board');
    assert.strictEqual(g.boardOnScreen, true, 'the whole board should be in view');
    assert.strictEqual(g.panelOverBoard, 0,
      'the panel covers ' + g.panelOverBoard + 'px² of the board it is describing');
    await ctx.close();
  });

  test('the board is never blacked out on a step that is about the board', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const g = await geometry(page);
    // The ring dims by casting a 9999px shadow outward. On a step whose whole
    // point is an overlay drawn on the board, that put the position under 50%
    // black and the pieces read as washed out.
    assert.strictEqual(g.dimmed, false, 'the board must stay lit while it is being demonstrated');
    await ctx.close();
  });

  test('the controls come to the panel, and pressing one lights it', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const before = await geometry(page);
    assert.ok(before.chips >= 10, 'expected a chip per overlay, got ' + before.chips);

    await page.locator('.tour-chip[data-ind="pins"]').click();
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      active: _tourActive,
      title: document.getElementById('tourTitle').textContent,
      lit: Object.keys(IND).filter((k) => IND[k].on),
      chipOn: document.querySelectorAll('.tour-chip.on').length,
      tried: _tourTried ? _tourTried.size : 0,
    }));
    assert.strictEqual(after.active, true, 'pressing a control must not end the tour');
    assert.match(after.title, /pin/i, 'the panel should describe what was pressed');
    assert.deepStrictEqual(after.lit, ['pins'], 'exactly the pressed overlay should be drawn');
    assert.strictEqual(after.chipOn, 1, 'the pressed chip should read as active');
    assert.strictEqual(after.tried, 1);
    await ctx.close();
  });

  test('the chips are inert — no duplicated ids, no handlers', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    const bad = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.tour-chip'));
      return {
        withId: chips.filter((n) => n.id).map((n) => n.id),
        withHandler: chips.filter((n) =>
          Array.from(n.attributes).some((a) => /^on/i.test(a.name))).length,
        realStillUnique: document.querySelectorAll('#ib-pins').length,
      };
    });
    assert.deepStrictEqual(bad.withId, [], 'ids must not be duplicated into the document');
    assert.strictEqual(bad.withHandler, 0, 'the chips must carry no inline handlers');
    assert.strictEqual(bad.realStillUnique, 1, 'the real control is still the only #ib-pins');
    await ctx.close();
  });

  test('the step can be left — Next stays reachable however long the help is', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    // "threats" carries one of the longest help bodies, which is what used to
    // push the panel's own buttons off the bottom of the screen.
    await page.evaluate(() => _tourExplorePick('threats'));
    await page.waitForTimeout(500);
    const g = await geometry(page);
    assert.strictEqual(g.nextReachable, true, 'Next must stay on screen');
    assert.strictEqual(g.panelOverBoard, 0, 'and the panel must still clear the board');
    await page.locator('#tourNext').click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.evaluate(() => !!_tourSteps[_tourIdx].explore), false,
      'Next should advance past the interactive step');
    assert.strictEqual(await page.evaluate(() => _tourExploring), false,
      'leaving the step should stop explore mode');
    await ctx.close();
  });

  test('leaving the tour clears the invitation outline', async () => {
    const { ctx, page } = await openTour({ phone: true });
    await stepToExplore(page);
    assert.ok(await page.evaluate(() => document.querySelectorAll('.ind-grid.tour-invite').length > 0),
      'the grids should be inviting a press during the step');
    await page.evaluate(() => endTour());
    await page.waitForTimeout(400);
    assert.strictEqual(
      await page.evaluate(() => document.querySelectorAll('.ind-grid.tour-invite').length), 0,
      'the outline must not survive the tour');
    await ctx.close();
  });

  test('desktop points at the real controls', async () => {
    const { ctx, page } = await openTour({ phone: false });
    await stepToExplore(page);
    const g = await geometry(page);
    assert.strictEqual(g.ringOnBoard, false,
      'on desktop the real grid is on screen, so that is what to point at');
    const onGrid = await page.evaluate(() => {
      const ring = document.getElementById('tourRing').getBoundingClientRect();
      const grid = document.querySelector('.ind-grid').getBoundingClientRect();
      return Math.abs(ring.top - (grid.top - 6)) < 4 && Math.abs(ring.left - (grid.left - 6)) < 4;
    });
    assert.strictEqual(onGrid, true, 'the ring should sit on the indicator grid');
    // And the real buttons drive the step, not just the chips.
    await page.locator('#ib-unprotected .ib-main').click();
    await page.waitForTimeout(550);
    const after = await page.evaluate(() => ({
      active: _tourActive,
      lit: Object.keys(IND).filter((k) => IND[k].on),
    }));
    assert.strictEqual(after.active, true, 'pressing the real button must not end the tour');
    assert.deepStrictEqual(after.lit, ['unprotected']);
    await ctx.close();
  });

  // Walk to a step by title, pressing Next as a visitor would.
  async function stepToTitle(page, title) {
    for (let i = 0; i < 30; i++) {
      const cur = await page.evaluate(() => ({
        title: _tourSteps[_tourIdx].title,
        last: _tourIdx === _tourSteps.length - 1,
      }));
      if (cur.title === title) return;
      if (cur.last) break;
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(420);
    }
    throw new Error('never reached the step "' + title + '"');
  }

  const ghostPixels = (page) => page.evaluate(() => {
    const g = document.getElementById('ghostCanvas');
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });

  for (const phone of [true, false]) {
    const where = phone ? 'phone' : 'desktop';

    // A target that is laid out but off screen passes the filter in
    // startTour() and then rings nothing. Ghost moves did that on every screen
    // size, pointing into the Board settings panel while it was closed.
    test('every step points at something on screen (' + where + ')', async () => {
      const { ctx, page } = await openTour({ phone });
      const n = await page.evaluate(() => _tourSteps.length);
      const off = [];
      for (let i = 0; i < n; i++) {
        const s = await page.evaluate(() => {
          const st = _tourSteps[_tourIdx];
          const el = _tourTarget(st);
          const r = el ? el.getBoundingClientRect() : null;
          const x = r ? r.left + r.width / 2 : -1, y = r ? r.top + r.height / 2 : -1;
          return { title: st.title, ok: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight };
        });
        if (!s.ok) off.push(s.title);
        await page.evaluate(() => tourNext());
        await page.waitForTimeout(420);
      }
      assert.deepStrictEqual(off, [], 'these steps point off screen');
      await ctx.close();
    });

    test('the ghost step draws real ghosts and pictures where to turn them on (' + where + ')', async () => {
      const { ctx, page } = await openTour({ phone });
      await stepToTitle(page, 'Ghost moves');
      await page.waitForTimeout(300);
      assert.strictEqual((await geometry(page)).ringOnBoard, true, 'the spotlight should be on the board');
      assert.ok(await ghostPixels(page) > 1000, 'the ghosts should be drawn on the board');
      const s = await page.evaluate(() => {
        const shot = document.querySelector('#tourBody .tour-shot');
        const h3 = previewBoard && previewBoard[5 * 8 + 7];
        return {
          exploring: premoveFrom === 6 * 8 + 7 && premoveTo === 5 * 8 + 7 &&
                     !!(h3 && h3.color === 'w' && h3.piece === 'P'),
          control: !!(shot && shot.querySelector('.ghost-one select')),
          ids: shot ? shot.querySelectorAll('[id]').length : -1,
          handlers: shot ? Array.from(shot.querySelectorAll('*')).filter((n) =>
            Array.from(n.attributes).some((a) => /^on/i.test(a.name))).length : -1,
          realUnique: document.querySelectorAll('#soloGhostDepth').length,
        };
      });
      assert.ok(s.exploring, 'h3 should be shown being explored');
      assert.ok(await page.evaluate(() => !!document.querySelector('#tourBody .tour-demo-note')),
        'the card should say what the board is showing');
      assert.ok(s.control, 'the card should picture the Ghost replies control');
      assert.strictEqual(s.ids, 0, 'ids must not be duplicated into the document');
      assert.strictEqual(s.handlers, 0, 'the picture must carry no handlers');
      assert.strictEqual(s.realUnique, 1, 'the real control is still the only #soloGhostDepth');

      // The picture shows the setting as the player has it, not a fixed image.
      const shown = await page.evaluate(() => {
        const real = document.getElementById('soloGhostDepth');
        real.value = '8';
        ghostSyncUI();
        _renderTourStep();
        const copy = document.querySelector('#tourBody .tour-shot .ghost-one');
        const r = { on: copy.classList.contains('on'), choice: copy.querySelector('select').value };
        real.value = '0';
        ghostSyncUI();
        return r;
      });
      assert.deepStrictEqual(shown, { on: true, choice: '8' });

      // Leaving the step takes the explored move and its ghosts with it.
      await page.evaluate(() => tourNext());
      await page.waitForTimeout(400);
      assert.strictEqual(await ghostPixels(page), 0, 'ghosts must not outlive their step');
      assert.strictEqual(await page.evaluate(() => previewBoard), null, 'nor the explored move');
      await ctx.close();
    });

    // Pressing an empty square PLAYS a move being explored, and on the ghost
    // step the explored move is the tour's: a stray press put h3 into the move
    // list behind the tour.
    test('a stray press on the board during the ghost step plays nothing (' + where + ')', async () => {
      const { ctx, page } = await openTour({ phone });
      await stepToTitle(page, 'Ghost moves');
      await page.waitForTimeout(300);
      const input = phone ? H.touchDriver(await ctx.newCDPSession(page), page) : H.mouseDriver(page);
      await input.tap(await H.squareCentre(page, 4, 3));   // e3, empty
      await assertUntouched(page);
      await ctx.close();
    });

    // A knight only the sample position has, moved in the real move list:
    // the tour then put the old position back under a game that began 1.Nb5.
    test('a piece on the sample position cannot be moved (' + where + ')', async () => {
      const { ctx, page } = await openTour({ phone });
      await stepToTitle(page, 'Board-vision indicators');
      assert.strictEqual(await page.evaluate(() => _tourDidDemo), true,
        'an idle board should get the sample position');
      const input = phone ? H.touchDriver(await ctx.newCDPSession(page), page) : H.mouseDriver(page);
      await input.drag(await H.squareCentre(page, 2, 3), await H.squareCentre(page, 1, 5));   // Nc3-b5
      await assertUntouched(page);
      await ctx.close();
    });
  }

  // No move recorded, and once the tour is gone the board is the one it found.
  async function assertUntouched(page) {
    const mid = await page.evaluate(() => ({ moves: gameMovesAlgebraic.length, turn }));
    assert.strictEqual(mid.moves, 0, 'no move may be played on the sample');
    assert.strictEqual(mid.turn, 'w');
    await page.evaluate(() => { if (_tourActive) endTour(); });
    await page.waitForTimeout(300);
    const end = await page.evaluate(() => ({
      moves: gameMovesAlgebraic.length, exploring: !!previewBoard,
      placement: boardToFen(board, turn, castling, epSq).split(' ')[0],
    }));
    assert.deepStrictEqual(end, {
      moves: 0, exploring: false, placement: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
    });
  }

  // "No moves yet" used to count as safe, so a tour at the start of a game put
  // the sample on the board under a live game: the bot played its first move
  // on the sample (Kh1), the tour restored the old position under it, and the
  // bot never moved again.
  test('a tour at the start of a bot game leaves the game alone', async () => {
    const { ctx, page } = await openTour({ phone: false, before: (p) => p.evaluate(() => {
      quickBotPick('1'); quickBotSetTime('5+0'); botSetPlayerColor('black'); quickBotStart();
    }) });
    await stepToTitle(page, 'Board-vision indicators');
    assert.strictEqual(await page.evaluate(() => _tourDidDemo), false,
      'no sample position under a live game');
    await page.waitForFunction(() => gameMovesAlgebraic.length >= 1, null, { timeout: 20000 });

    // The ghost step has no sample to explore, so it draws nothing and does
    // not describe a demonstration that is not there.
    await stepToTitle(page, 'Ghost moves');
    await page.waitForTimeout(300);
    const g = await page.evaluate(() => ({
      exploring: !!previewBoard,
      note: !!document.querySelector('#tourBody .tour-demo-note'),
      picture: !!document.querySelector('#tourBody .tour-shot'),
    }));
    assert.deepStrictEqual(g, { exploring: false, note: false, picture: true });
    assert.strictEqual(await ghostPixels(page), 0);

    const before = await page.evaluate(() => boardToFen(board, turn, castling, epSq));
    await page.evaluate(() => endTour());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      fen: boardToFen(board, turn, castling, epSq), moves: gameMovesAlgebraic.length,
    }));
    assert.strictEqual(after.fen, before, 'ending the tour must not touch the game');
    assert.ok(after.moves >= 1, 'the bot move stays played');
    assert.notStrictEqual(after.fen.split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      'the bot move is on the real board');
    await ctx.close();
  });

  // A standing challenge or an open room can turn into a game mid-tour, on
  // the other player's click, with no warning here.
  test('an online room keeps the sample off the board', async () => {
    const { ctx, page } = await openTour({ phone: false, before: (p) => p.evaluate(() => {
      mpRoomId = 'test-room'; mpMode = 'lobby-waiting';
    }) });
    await stepToTitle(page, 'Board-vision indicators');
    assert.strictEqual(await page.evaluate(() => _tourDidDemo), false);
    await page.evaluate(() => { endTour(); mpRoomId = null; mpMode = 'idle'; });
    await ctx.close();
  });

  // The phone rework moved the overlay grid off the page into a panel, the
  // steps pointing at it had no box, and the filter in startTour() dropped all
  // five without a word. Every test above then failed only indirectly.
  test('a phone gets every step desktop gets', async () => {
    const titles = async (phone) => {
      const { ctx, page } = await openTour({ phone });
      const t = await page.evaluate(() => _tourSteps.map((s) => s.title));
      await ctx.close();
      return t;
    };
    const desktop = await titles(false);
    const phone = await titles(true);
    assert.deepStrictEqual(phone, desktop);
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

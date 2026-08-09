// Park-then-confirm commit mode, driven with a mouse.
//
// The behaviour under test: in 'confirm' mode, letting go of a piece must NOT
// play the move. It parks the piece on the destination with the preview
// overlays live, and a second tap on that square is what commits. This exists
// because on a phone your finger covers the very overlays you dropped the
// piece to read, and lifting it used to be what played the move.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('commit mode (mouse)', { concurrency: 1 }, () => {
  let server, browser, page, mouse;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => errs.push(e.message));
    // Each phase wants a genuinely fresh board; session restore would otherwise
    // resume the previous phase's game on reload. bmCommitMode is left alone —
    // its persistence is one of the things under test.
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
    mouse = H.mouseDriver(page);
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function load() {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1400);
    await H.dismissLanding(page);
  }
  const state = () => page.evaluate(() => ({
    mode: boardCommitMode, awaiting: awaitingConfirm,
    from: premoveFrom, to: premoveTo, preview: !!previewBoard,
  }));
  const setMode = (m) => page.evaluate((mm) => setCommitMode(mm), m);
  const centre = (f, r) => H.squareCentre(page, f, r);

  test('defaults to release mode', async () => {
    await load();
    assert.strictEqual((await state()).mode, 'release');
  });

  test('release mode plays the move on drop (regression guard)', async () => {
    await load();
    await setMode('release');
    await mouse.drag(await centre(4, 2), await centre(4, 4));
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), 'wP', 'pawn should have moved to e4');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), null);
  });

  test('confirm mode parks on release instead of playing', async () => {
    await load();
    await setMode('confirm');
    await mouse.drag(await centre(4, 2), await centre(4, 4));

    const s = await state();
    assert.strictEqual(s.awaiting, true, 'should be awaiting confirmation');
    assert.strictEqual(s.to, H.SQ.e4, 'parked on e4');
    assert.strictEqual(s.preview, true, 'preview overlays stay live while parked');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), 'wP', 'pawn must still be on e2');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), null, 'move must not have been played');
  });

  test('the chip label reflects the active mode', async () => {
    await load();
    await setMode('confirm');
    assert.match(await page.locator('#commitModeChip').innerText(), /confirm/i);
    await setMode('release');
    assert.match(await page.locator('#commitModeChip').innerText(), /release/i);
  });

  test('tapping another legal square re-parks rather than playing', async () => {
    await load();
    await setMode('confirm');
    await mouse.drag(await centre(4, 2), await centre(4, 4));
    await mouse.tap(await centre(4, 3));   // e3, also legal for the e2 pawn

    const s = await state();
    assert.strictEqual(s.awaiting, true);
    assert.strictEqual(s.to, H.SQ.e3, 're-parked on e3');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), 'wP', 'still not played');
  });

  test('Escape cancels a parked piece', async () => {
    await load();
    await setMode('confirm');
    await mouse.drag(await centre(4, 2), await centre(4, 4));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const s = await state();
    assert.strictEqual(s.awaiting, false);
    assert.strictEqual(s.preview, false);
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), 'wP');
  });

  test('a second tap on the parked square plays the move', async () => {
    await load();
    await setMode('confirm');
    await mouse.drag(await centre(4, 2), await centre(4, 4));
    assert.strictEqual((await state()).awaiting, true, 'precondition: parked');

    await mouse.tap(await centre(4, 4));
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), 'wP', 'move should now be played');
    assert.strictEqual((await state()).awaiting, false);
  });

  test('tap-select then tap-destination parks, and a third tap plays it', async () => {
    // The pure tap route, with no dragging at all. On desktop the hover-move
    // clears selSq before mousedown, so the park has to take its origin from
    // the live preview — this is the case that regressed once already.
    await load();
    await setMode('confirm');
    await mouse.tap(await centre(4, 2));   // select
    await mouse.tap(await centre(4, 4));   // park

    assert.strictEqual((await state()).awaiting, true, 'second tap should park');
    assert.strictEqual(await H.pieceAt(page, H.SQ.e2), 'wP', 'must not play on the second tap');

    await mouse.tap(await centre(4, 4));   // confirm
    assert.strictEqual(await H.pieceAt(page, H.SQ.e4), 'wP');
  });

  test('the mode survives a reload', async () => {
    await load();
    await setMode('confirm');
    await load();
    assert.strictEqual((await state()).mode, 'confirm');
  });

  test('no page errors were raised throughout', () => {
    assert.deepStrictEqual(errs, []);
  });
});

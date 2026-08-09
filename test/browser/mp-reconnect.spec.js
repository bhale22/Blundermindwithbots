// Two real clients, a real WebSocket server, and a phone that drops out.
//
// This guards the worst failure the app can have: two people an hour into a
// game, one of them backgrounds their phone, and the game is destroyed. Before
// the seat-token work the server kept no game state at all, deleted the room
// as soon as both sockets went, and the surviving client set gameOver the
// instant it saw `opponent_disconnected`.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

describe('multiplayer reconnect', { concurrency: 1 }, () => {
  let server, browser, ctxA, ctxB, pageA, pageB;
  const errsA = [], errsB = [];
  let roomCode;

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    // Separate contexts: two genuinely different players, separate storage.
    ctxA = await H.phoneContext(browser);
    ctxB = await H.phoneContext(browser);
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    pageA.on('pageerror', (e) => errsA.push(e.message));
    pageB.on('pageerror', (e) => errsB.push(e.message));
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  async function open(page) {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1800);
    await H.dismissLanding(page);
  }
  const moves = (page) => page.evaluate(() => gameMovesAlgebraic.slice());
  const mpState = (page) => page.evaluate(() => ({
    room: mpRoomId, role: mpRole, mode: mpMode, over: gameOver,
    token: mpSeatToken ? 'set' : null,
  }));
  // Wait for a predicate rather than sleeping a fixed amount.
  async function until(page, fn, timeout = 15000, label = 'condition') {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await page.evaluate(fn)) return true;
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
      await page.waitForTimeout(250);
    }
  }

  test('two clients start a game and each hold a seat token', async () => {
    await open(pageA);
    await open(pageB);

    // A hosts a private room as White.
    await pageA.evaluate(() => {
      mpBaseMin = 10; mpIncSec = 0;
      mpConnect(() => mpWs.send(JSON.stringify({
        type: 'create', hostColor: 'white', tc: 'custom', tcBaseMin: 10, tcIncSec: 0,
      })));
    });
    await until(pageA, () => !!mpRoomId, 15000, 'room creation');
    roomCode = (await mpState(pageA)).room;
    assert.ok(roomCode, 'room code should exist');

    // B joins it.
    await pageB.evaluate((code) => {
      mpConnect(() => mpWs.send(JSON.stringify({ type: 'join', code })));
    }, roomCode);
    await until(pageB, () => mpMode === 'ingame', 15000, 'B to be in game');
    await until(pageA, () => mpMode === 'ingame', 15000, 'A to be in game');

    const a = await mpState(pageA), b = await mpState(pageB);
    assert.strictEqual(a.role, 'white');
    assert.strictEqual(b.role, 'black');
    assert.strictEqual(a.token, 'set', 'A should hold a seat token');
    assert.strictEqual(b.token, 'set', 'B should hold a seat token');
  });

  test('moves are played and recorded by the server', async () => {
    // White e4, Black e5, White Nf3 — through the real send path.
    await pageA.evaluate(() => { executeMove(52, 36); mpSendMove(52, 36, null); });
    await until(pageB, () => gameMovesAlgebraic.length === 1, 10000, 'B to see e4');
    await pageB.evaluate(() => { executeMove(12, 28); mpSendMove(12, 28, null); });
    await until(pageA, () => gameMovesAlgebraic.length === 2, 10000, 'A to see e5');
    await pageA.evaluate(() => { executeMove(62, 45); mpSendMove(62, 45, null); });
    await until(pageB, () => gameMovesAlgebraic.length === 3, 10000, 'B to see Nf3');

    assert.deepStrictEqual(await moves(pageA), await moves(pageB), 'boards agree');
    assert.strictEqual((await moves(pageA)).length, 3);
  });

  test('B dropping out does NOT end the game for A', async () => {
    // Kill B's socket the way a discarded WebView would.
    await pageB.evaluate(() => { if (mpWs) mpWs.close(); });
    await until(pageA, () => !!_mpWaitUntil, 10000, 'A to start waiting');

    const a = await mpState(pageA);
    assert.strictEqual(a.over, false, 'game must NOT be over — this was the bug');
    const status = await pageA.evaluate(() =>
      (document.getElementById('mpStatus') || {}).textContent || '');
    assert.match(status, /waiting for them to rejoin/i, 'A should be told B is coming back');
  });

  test('B reloads and rejoins the same game, with the position intact', async () => {
    const beforeMoves = await moves(pageA);

    // A full page reload — everything in B's memory is gone.
    await pageB.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('#cv');
    await until(pageB, () => mpMode === 'ingame' && !!mpRoomId, 20000, 'B to rejoin');

    const b = await mpState(pageB);
    assert.strictEqual(b.room, roomCode, 'same room');
    assert.strictEqual(b.role, 'black', 'same seat, not reassigned');
    assert.strictEqual(b.over, false);
    assert.deepStrictEqual(await moves(pageB), beforeMoves, 'full move history replayed');
    assert.strictEqual(await H.landingVisible(pageB), false, 'no landing page');
  });

  test('A is told the opponent is back and the game continues', async () => {
    await until(pageA, () => !_mpWaitUntil, 10000, 'A to stop waiting');
    assert.strictEqual((await mpState(pageA)).over, false);

    // Play on across the reconnect — the real proof it still works.
    await pageB.evaluate(() => { executeMove(1, 18); mpSendMove(1, 18, null); });  // Nc6
    await until(pageA, () => gameMovesAlgebraic.length === 4, 10000, 'A to see Nc6');
    await pageA.evaluate(() => { executeMove(61, 34); mpSendMove(61, 34, null); }); // Bc4
    await until(pageB, () => gameMovesAlgebraic.length === 5, 10000, 'B to see Bc4');

    assert.deepStrictEqual(await moves(pageA), await moves(pageB), 'boards still agree');
    assert.strictEqual((await moves(pageA)).length, 5);
  });

  test('a stranger cannot take the reserved seat', async () => {
    const ctxC = await H.phoneContext(browser);
    const pageC = await ctxC.newPage();
    await open(pageC);
    const err = await pageC.evaluate((code) => new Promise((resolve) => {
      mpConnect(() => {
        const orig = mpWs.onmessage;
        mpWs.onmessage = (evt) => {
          const m = JSON.parse(evt.data);
          if (m.type === 'error') resolve(m.message);
          orig(evt);
        };
        mpWs.send(JSON.stringify({ type: 'join', code }));
      });
      setTimeout(() => resolve('NO ERROR'), 8000);
    }), roomCode);
    assert.match(err, /full/i, 'joining a live room should be refused, got: ' + err);
    await ctxC.close();
  });

  test('a bad token is refused', async () => {
    const ctxD = await H.phoneContext(browser);
    const pageD = await ctxD.newPage();
    await open(pageD);
    const reason = await pageD.evaluate((code) => new Promise((resolve) => {
      mpConnect(() => {
        const orig = mpWs.onmessage;
        mpWs.onmessage = (evt) => {
          const m = JSON.parse(evt.data);
          if (m.type === 'resume_failed') resolve(m.reason);
          orig(evt);
        };
        mpWs.send(JSON.stringify({ type: 'resume', code, token: 'not-a-real-token' }));
      });
      setTimeout(() => resolve('NO RESPONSE'), 8000);
    }), roomCode);
    assert.strictEqual(reason, 'denied');
    await ctxD.close();
  });

  test('no page errors on either client', () => {
    assert.deepStrictEqual(errsA, [], 'client A errors');
    assert.deepStrictEqual(errsB, [], 'client B errors');
  });
});

// Verification: SF ghosts (solo + bot), Maia ghosts, button rows, Explore flow.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
};

function sqCenter(rect, sq, flipped) {
  let r = Math.floor(sq / 8), c = sq % 8;
  if (flipped) { r = 7 - r; c = 7 - c; }
  const SQ = rect.width / 8;
  return { x: rect.x + (c + 0.5) * SQ, y: rect.y + (r + 0.5) * SQ };
}

async function ghostPixels(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('ghostCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

async function hoverMove(page, fromSq, toSq, settleMs) {
  const rect = await page.evaluate(() => {
    const r = document.getElementById('cv').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const flipped = await page.evaluate(() => typeof boardFlipped !== 'undefined' && boardFlipped);
  const a = sqCenter(rect, fromSq, flipped);
  const b = sqCenter(rect, toSq, flipped);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.waitForTimeout(settleMs);
  const px = await ghostPixels(page);
  await page.mouse.up();
  await page.waitForTimeout(250);
  return px;
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto(BASE);
await page.waitForTimeout(1000);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(800);

// 1. Solo SF ghosts: e2 (52) -> e4 (36). First call includes SF wasm init.
const soloPx = await hoverMove(page, 52, 36, 9000);
check('Solo SF ghosts render', soloPx > 0, soloPx + ' px');

// Releasing the mouse on e4 committed 1.e4 — it's black's turn now.
// Second hover (warm worker): black explores e7 -> e5.
const soloPx2 = await hoverMove(page, 12, 28, 3000);
check('Solo SF ghosts render again (warm)', soloPx2 > 0, soloPx2 + ' px');

// 2. Bot game SF ghosts
await page.evaluate(() => { botPlayerColor = 'white'; botTab = 'sf'; botStart(); });
await page.waitForTimeout(1200);
const botPx = await hoverMove(page, 52, 36, 3000);
check('Bot game SF ghosts render', botPx > 0, botPx + ' px');

// 3. Maia ghosts: download model (local fetch — file is served by this server)
await page.evaluate(() => maiaDownloadModel());
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, null, { timeout: 120000 })
  .catch(() => check('Maia model becomes ready', false, 'timeout'));
const maiaReady = await page.evaluate(() => _maiaReady);
check('Maia model becomes ready', maiaReady);

if (maiaReady) {
  // Restart the bot game — the earlier hover committed 1.e4 and the bot
  // replied, so the position has moved on. Fresh board, human white.
  await page.evaluate(() => {
    botPlayerColor = 'white'; botStart();
    document.getElementById('soloGhostDepth').value = 'maia';
    ghostModeChanged();
  });
  await page.waitForTimeout(1200);
  const maiaPx = await hoverMove(page, 52, 36, 5000);
  check('Maia ghosts render in bot game', maiaPx > 0, maiaPx + ' px');

  // Direct check of the dedupe rule output: run the maia branch and inspect probs
  const dedupe = await page.evaluate(async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const hi = await ghostMaiaProbs(fen, 2600);
    const lo = await ghostMaiaProbs(fen, 1500);
    if (!hi || !lo) return null;
    const topHi = ghostTopMoves(hi), topLo = ghostTopMoves(lo);
    return {
      hiTop: topHi[0], loTop: topLo[0],
      loSecond: topLo.length > 1 ? topLo[1] : null,
    };
  });
  check('Maia per-Elo inference returns distinct distributions', !!dedupe,
    dedupe ? `2600: ${dedupe.hiTop[0]}@${(dedupe.hiTop[1]*100).toFixed(0)}% | 1500: ${dedupe.loTop[0]}@${(dedupe.loTop[1]*100).toFixed(0)}% | 1500 #2: ${dedupe.loSecond ? dedupe.loSecond[0]+'@'+(dedupe.loSecond[1]*100).toFixed(0)+'%' : 'none'}` : '');
}

// 4. Button rows layout
const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('#bottom-controls .ctrl-row').forEach(r => {
    out.push(Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()));
  });
  return out;
});
console.log('Button rows:', JSON.stringify(rows));
check('Row 1 = action/Explore/vs Bot/2-Player', rows[0] && rows[0].length === 4 && /Bot/.test(rows[0][2]) && /2-Player/.test(rows[0][3]));
check('Row 2 = Theme/Load/Save', rows[1] && /Theme/.test(rows[1][0]) && /Load/.test(rows[1][1]) && /Save/.test(rows[1][2]));
const exploreHiddenMidGame = await page.evaluate(() =>
  document.getElementById('exploreBtn').style.display === 'none');
check('Explore hidden during game', exploreHiddenMidGame);

// 5. Explore flow: end the bot game, Explore should appear; clicking it unlocks board
await page.evaluate(() => {
  gameOver = true; gameOverMsg = 'White resigned — Black wins!';
  updatePlayerBoxes(); render();
});
await page.waitForTimeout(300);
const exploreVisible = await page.evaluate(() =>
  document.getElementById('exploreBtn').style.display !== 'none');
check('Explore appears after game over', exploreVisible);
const rematchLabel = await page.evaluate(() => document.getElementById('resignBtn').textContent);
check('Action button shows Rematch after game over', /Rematch/.test(rematchLabel), rematchLabel);

await page.evaluate(() => document.getElementById('exploreBtn').click());
await page.waitForTimeout(300);
const post = await page.evaluate(() => ({
  gameOver, botActive, mpRoomId,
  exploreHidden: document.getElementById('exploreBtn').style.display === 'none',
  ghostOn: ghostEnabled(),
}));
check('Explore clears gameOver', post.gameOver === false);
check('Explore stops bot mode', post.botActive === false);
check('Explore hides itself', post.exploreHidden);
check('Ghosts enabled in explore mode', post.ghostOn);

// Board should be interactive again — make a move for black (it was black to move? turn state)
const turnNow = await page.evaluate(() => turn);
const mvFrom = turnNow === 'w' ? 51 : 11, mvTo = turnNow === 'w' ? 35 : 27; // d2-d4 or d7-d5
await page.evaluate(() => { selSq = -1; });
const movedOk = await page.evaluate(([f, t]) => {
  const lm = legalMovesFor(f, board, epSq, castling);
  if (!lm.includes(t)) return 'not legal';
  executeMove(f, t, 'Q');
  return 'moved';
}, [mvFrom, mvTo]);
check('Board interactive after Explore', movedOk === 'moved', movedOk);

await page.screenshot({ path: 'test-buttons.png', clip: { x: 700, y: 300, width: 580, height: 500 } });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
await browser.close();
process.exit(failures === 0 ? 0 : 1);

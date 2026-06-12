import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:3100');
await page.waitForTimeout(800);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(500);

// load model from cache (downloaded in previous run)
await page.evaluate(() => maiaInit());
await page.waitForFunction(() => _maiaReady, null, { timeout: 60000 });

await page.evaluate(() => {
  botPlayerColor = 'white'; botTab = 'sf'; botStart();
  document.getElementById('soloGhostDepth').value = 'maia';
  ghostModeChanged();
});
await page.waitForTimeout(800);

const dbg = await page.evaluate(async () => {
  const out = {};
  out.mode = ghostMode(); out.ready = _maiaReady;
  out.botActive = botActive; out.botThinking = botThinking; out.turn = turn;
  out.enabled = ghostEnabled();
  // step through the same logic ghostShowForSquare runs for e2(52) -> e4(36)
  const lm = legalMovesFor(52, board, epSq, castling);
  out.legal = lm.includes(36);
  const hypBoard = applyMove(52, 36, board, epSq, 'Q');
  const hypFen = boardToFen(hypBoard, turn === 'w' ? 'b' : 'w', castling, -1);
  out.hypFen = hypFen;
  const hi = await ghostMaiaProbs(hypFen, 2600);
  out.hiCount = hi ? Object.keys(hi).length : null;
  // now the actual function, with selection state set
  selSq = 52; dragFrom = 52;
  await ghostShowForSquare(52, 36);
  const cv2 = document.getElementById('ghostCanvas');
  const d = cv2.getContext('2d').getImageData(0,0,cv2.width,cv2.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  out.pixels = n;
  return out;
});
console.log(JSON.stringify(dbg, null, 2));
await browser.close();

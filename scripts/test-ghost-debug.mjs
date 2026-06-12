import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:3100');
await page.waitForTimeout(800);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(500);

const out = await page.evaluate(async () => {
  const log = [];
  log.push('ghostEnabled=' + ghostEnabled() + ' depth=' + ghostDepth());
  try { await sfGhostInit(); log.push('init ok'); } catch(e) { log.push('init fail ' + e); }
  // direct engine call on position after 1.e4
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const u1 = await sfGhostGetMove(fen, 8);
  log.push('uci1=' + u1);
  // now the full path: simulate selection of e2 (sq 52) and call ghostShowForSquare
  selSq = 52; dragFrom = 52;
  await ghostShowForSquare(52, 36);
  const cv2 = document.getElementById('ghostCanvas');
  const d = cv2.getContext('2d').getImageData(0,0,cv2.width,cv2.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  log.push('pixels after ghostShowForSquare=' + n);
  return log;
});
console.log(out.join('\n'));
await browser.close();

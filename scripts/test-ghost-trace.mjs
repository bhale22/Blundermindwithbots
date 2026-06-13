import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:3100');
await page.waitForTimeout(800);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(500);

await page.evaluate(() => {
  const origShow = ghostShowForSquare;
  window.ghostShowForSquare = async function(f, t) {
    console.log('GSFS called from=' + f + ' to=' + t + ' reqId=' + _ghostRequestId);
    return origShow.apply(this, arguments);
  };
  const origDraw = _drawGhost;
  window._drawGhost = function(bd, f, t, a, c) {
    console.log('DRAW from=' + f + ' to=' + t);
    return origDraw.apply(this, arguments);
  };
  const origClear = clearGhostPieces;
  window.clearGhostPieces = function() {
    console.log('CLEAR ghost');
    return origClear.apply(this, arguments);
  };
  const origGet = sfGhostGetMove;
  window.sfGhostGetMove = async function(fen, d, ex) {
    const r = await origGet.apply(this, arguments);
    console.log('SFGET ex=' + (ex||'') + ' -> ' + r);
    return r;
  };
  const origMM = ghostOnMouseMove;
  window.ghostOnMouseMove = function(sq) {
    console.log('MM sq=' + sq + ' dragFrom=' + dragFrom + ' selSq=' + selSq);
    return origMM.apply(this, arguments);
  };
});

const rect = await page.evaluate(() => {
  const r = document.getElementById('cv').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width };
});
const SQ = rect.width / 8;
const px = (sq) => ({ x: rect.x + ((sq % 8) + 0.5) * SQ, y: rect.y + (Math.floor(sq / 8) + 0.5) * SQ });

const a = px(52), b = px(36);
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
await page.mouse.move(b.x, b.y, { steps: 4 });
await page.waitForTimeout(9000);
const n = await page.evaluate(() => {
  const cv2 = document.getElementById('ghostCanvas');
  const d = cv2.getContext('2d').getImageData(0,0,cv2.width,cv2.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
console.log('final pixels:', n);
await browser.close();

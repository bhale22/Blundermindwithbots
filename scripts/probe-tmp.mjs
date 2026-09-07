import { chromium } from 'playwright';
const BASE = 'http://localhost:3100';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
await ctx.addInitScript(() => {
  try { ['bm_bottour','bm_tour_pro','bm_tour_amateur'].forEach(k => localStorage.setItem(k,'1')); } catch(e){}
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERR', String(e)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { if(!document.getElementById('bmWelcome').hidden) bmWelcomeChoose('solo'); } catch(e){} });
await page.waitForTimeout(700);
await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
await page.waitForTimeout(2500);

console.log(JSON.stringify(await page.evaluate(() => ({
  botActive: typeof botActive !== 'undefined' && botActive,
  gameOver,
  moves: gameMovesAlgebraic.length,
  mpRoomId: typeof mpRoomId !== 'undefined' ? mpRoomId : 'undef',
  mpMode: typeof mpMode !== 'undefined' ? mpMode : 'undef',
  _gameInProgress: _gameInProgress(),
  _isLiveGame: _isLiveGame(),
  quickBotInline: document.getElementById('quickBot').style.display,
  drawBtnInline: document.querySelector('#gameActions .draw-btn').style.display,
  pbResignInline: document.getElementById('pbResign').style.display,
})), null, 2));

// Now call the syncs by hand and see whether they fix it.
console.log('after manual sync:', JSON.stringify(await page.evaluate(() => {
  updateGameStartBtns(); syncActionRow();
  return {
    quickBot: document.getElementById('quickBot').style.display,
    pbResign: document.getElementById('pbResign').style.display,
    pbDraw: document.getElementById('pbDraw').style.display,
  };
})));

await browser.close();

// Screenshots of the phone tray at each snap position, plus a live bot game.
// node scripts/shot-tray.mjs <outdir>
import { chromium } from 'playwright';
const BASE = 'http://localhost:3100';
const OUT = process.argv[2] || '.';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true,
});
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { if (!document.getElementById('bmWelcome').hidden) bmWelcomeChoose('solo'); } catch (e) {} });
await page.waitForTimeout(700);

// Pin a couple so the strip has something in it, and switch an overlay on so
// the closed strip has something to report.
await page.evaluate(() => {
  pinToggleKey('threats'); pinToggleKey('checkthreats'); pinToggleKey('forksw');
  IND.threats.on = true; IND.threats.pre = true; ibUpdateUI('threats'); indApply(); render();
});
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '/1-closed.png' });

// ── A real drag on the grip, not a function call ──
const box = await page.evaluate(() => {
  const r = document.getElementById('bvtHandle').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + 14 };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(box.x, box.y - i * 30, { steps: 1 });
await page.mouse.up();
await page.waitForTimeout(500);
const dragged = await page.evaluate(() => document.getElementById('sidebar').dataset.bvt);
console.log('drag up →', dragged);
await page.screenshot({ path: OUT + '/2-dragged.png' });

await page.evaluate(() => bvTraySet('full'));
await page.waitForTimeout(450);
await page.screenshot({ path: OUT + '/3-full.png' });

// Scrolled to the bottom of the sheet.
await page.evaluate(() => { const s = document.getElementById('sidebar'); s.scrollTop = s.scrollHeight; });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/4-full-bottom.png' });

// The picker.
await page.evaluate(() => { bvTraySet('closed'); pinPickerOpen(); });
await page.waitForTimeout(450);
await page.screenshot({ path: OUT + '/5-picker.png' });
await page.evaluate(() => pinPickerClose());

// ── A live bot game: the quick-start block must be gone. ──
await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
await page.waitForTimeout(2500);
const live = await page.evaluate(() => ({
  quickBot: getComputedStyle(document.getElementById('quickBot')).display,
  resign: getComputedStyle(document.getElementById('pbResign')).display,
  draw: getComputedStyle(document.getElementById('pbDraw')).display,
  chat: getComputedStyle(document.getElementById('pbChat')).display,
  botActive: typeof botActive !== 'undefined' && botActive,
  trayTop: document.getElementById('sidebar').getBoundingClientRect().top,
  barBottom: document.getElementById('phoneBar').getBoundingClientRect().bottom,
}));
console.log('live game:', JSON.stringify(live));
await page.screenshot({ path: OUT + '/6-ingame.png' });

await page.evaluate(() => bvTraySet('full'));
await page.waitForTimeout(450);
await page.screenshot({ path: OUT + '/7-ingame-full.png' });

console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
await browser.close();

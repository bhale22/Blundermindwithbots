// The pro column must settle when a game STARTS, not one move into it, and the
// 2-player invite row must no longer offer Discord.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-prostart.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const browser = await chromium.launch();
const errors = [];

const proPage = async (w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate(() => landingChoose('solo'));
  await page.waitForTimeout(400);
  await page.evaluate(() => setShell('pro'));
  await page.waitForTimeout(500);
  return page;
};

// Everything that can move: the board itself, and the side column's contents.
const geom = (page) => page.evaluate(() => {
  const g = (id) => {
    const e = document.getElementById(id);
    if (!e || !e.getClientRects().length) return null;
    const r = e.getBoundingClientRect();
    return [+r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)];
  };
  return {
    cv: g('cv'), idle: g('proIdleActions'), resign: g('proResignBtn'),
    draw: g('proDrawBtn'), chat: g('proChatMount'), note: g('proNotationCard'),
    scrollH: document.body.scrollHeight, viewH: window.innerHeight,
  };
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('bot game — the column settles at start, not on move 1:');
for (const [w, h] of [[1440, 900], [1280, 560], [1366, 768]]) {
  const page = await proPage(w, h);
  await page.evaluate(() => { botPlayerColor = 'white'; botTab = 'sf'; botStart(); });
  await page.waitForTimeout(1400);
  const atStart = await geom(page);

  ok(atStart.idle === null,
     `${w}x${h}: idle actions are already gone once the game starts`);
  ok(atStart.resign !== null && atStart.draw !== null,
     `${w}x${h}: Resign/Draw are already showing`);

  await page.evaluate(() => { executeMove(fileRankToSq('e2'), fileRankToSq('e4')); });
  await page.waitForTimeout(1500);
  const afterMove = await geom(page);

  ok(same(atStart.cv, afterMove.cv),
     `${w}x${h}: the board does not move on the first move ` +
     `(${atStart.cv} → ${afterMove.cv})`);
  ok(same(atStart.chat, afterMove.chat) && same(atStart.note, afterMove.note),
     `${w}x${h}: the side column does not reflow either`);
  await page.close();
}

console.log('\nstopping restores the idle row immediately:');
{
  const page = await proPage(1440, 900);
  await page.evaluate(() => { botPlayerColor = 'white'; botTab = 'sf'; botStart(); });
  await page.waitForTimeout(1200);
  ok((await geom(page)).idle === null, 'idle row hidden during the game');
  await page.evaluate(() => botStop());
  await page.waitForTimeout(500);
  const stopped = await geom(page);
  ok(stopped.idle !== null, 'idle row is back as soon as the game stops');
  ok(stopped.resign === null && stopped.draw === null, 'Resign/Draw are gone with it');
  await page.close();
}

console.log('\n2-player invite row:');
{
  const page = await proPage(1280, 900);
  const share = await page.evaluate(() => ({
    discordFns:  typeof window.mpShareDiscord,
    discordHtml: /discord/i.test(document.body.innerHTML),
    shareBtn:    !!document.querySelector('button[onclick="mpShareText()"]'),
    copyBtn:     !!document.getElementById('mpCopyLinkBtn'),
  }));
  ok(share.discordFns === 'undefined', 'mpShareDiscord is gone from the app');
  ok(!share.discordHtml, 'no Discord button left in the markup');
  ok(share.shareBtn, 'the Share button survives');
  ok(share.copyBtn, 'and so does Copy link');
  await page.close();
}

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

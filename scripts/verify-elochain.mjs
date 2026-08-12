// Headless verification of the LC+Maia ELO chain link.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-elochain.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

// The chain lives inside the LC+Maia sub-panel, which only exists on screen once
// that engine is picked — so open the Engine section and select it, the way a
// user reaching this control would.
const openLcMaia = async () => {
  await page.evaluate(() => {
    const sec = document.getElementById('sec-engine');
    if (sec && !sec.classList.contains('open')) toggleSec('engine');
    if (sec) sec.classList.remove('eng-collapsed');
    const card = document.querySelector('#engine-mode-grid .mcard[data-engine="lcmaia"]');
    if (card) selEngineCard(card);
  });
  await page.waitForTimeout(350);
};

await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openLcMaia();
ok(await page.locator('#lcmaia-chain').isVisible(), 'the chain button is visible in the LC+Maia panel');

const state = () => page.evaluate(() => ({
  lc:     +document.getElementById('lcmaia-lc-elo').value,
  maia:   +document.getElementById('lcmaia-maia-elo').value,
  gauge:  currentElo,
  linked: lcMaiaEloLinked,
  cls:    document.getElementById('lcmaia-chain').classList.contains('linked'),
  aria:   document.getElementById('lcmaia-chain').getAttribute('aria-pressed'),
}));
// Type into a box the way a user does, so the oninput handler actually runs.
const type = (id, v) => page.evaluate(([i, val]) => {
  const el = document.getElementById(i);
  el.value = val;
  el.dispatchEvent(new Event('input'));
}, [id, v]);

console.log('default:');
let s = await state();
ok(s.linked === true, 'chain starts connected');
ok(s.cls && s.aria === 'true', 'the button renders its linked state');
ok(s.lc === s.maia && s.maia === s.gauge,
   `all three start in step (lc ${s.lc} · maia ${s.maia} · gauge ${s.gauge})`);

console.log('\nlinked — one edit moves everything:');
await type('lcmaia-lc-elo', '1800');
s = await state();
ok(s.maia === 1800, 'editing Lichess ELO pulls Maia ELO with it');
ok(s.gauge === 1800, 'and moves the Elometer (' + s.gauge + ')');

await type('lcmaia-maia-elo', '1200');
s = await state();
ok(s.lc === 1200, 'editing Maia ELO pulls Lichess ELO with it');
ok(s.gauge === 1200, 'and moves the Elometer (' + s.gauge + ')');

await page.evaluate(() => setElo(2200));
s = await state();
ok(s.maia === 2200 && s.lc === 2200, 'moving the Elometer drives both boxes');

console.log('\nbroken:');
await page.click('#lcmaia-chain');
s = await state();
ok(s.linked === false, 'clicking the chain breaks it');
ok(!s.cls && s.aria === 'false', 'the button renders its broken state');

await type('lcmaia-lc-elo', '2500');
s = await state();
ok(s.lc === 2500, 'Lichess ELO takes its own value');
ok(s.maia === 2200, 'Maia ELO stays put (' + s.maia + ')');
ok(s.gauge === 2200, 'and the Elometer is not dragged along (' + s.gauge + ')');

// Maia's box IS the Elometer, so those two stay welded even when unlinked.
await type('lcmaia-maia-elo', '900');
s = await state();
ok(s.gauge === 900, 'Maia ELO still moves the Elometer while unlinked');
ok(s.lc === 2500, 'without disturbing the Lichess ELO (' + s.lc + ')');
await page.evaluate(() => setElo(1600));
s = await state();
ok(s.maia === 1600, 'and the Elometer still drives Maia ELO');
ok(s.lc === 2500, 'still leaving the book alone (' + s.lc + ')');

console.log('\nre-joining:');
await page.click('#lcmaia-chain');
s = await state();
ok(s.linked === true, 'clicking again re-joins');
ok(s.lc === 1600 && s.maia === 1600,
   'the book adopts Maia\'s value rather than dragging the gauge (' + s.lc + ')');

console.log('\npersistence + config round-trip:');
await page.click('#lcmaia-chain');           // break it
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openLcMaia();
s = await state();
ok(s.linked === false, 'broken state survives a reload');
await page.click('#lcmaia-chain');           // re-join
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openLcMaia();
s = await state();
ok(s.linked === true, 'and so does the joined state');

const trip = await page.evaluate(() => {
  document.getElementById('lcmaia-chain').click();          // unlink
  const set = (i, v) => { const e = document.getElementById(i); e.value = v; e.dispatchEvent(new Event('input')); };
  set('lcmaia-lc-elo', 2400);
  set('lcmaia-maia-elo', 1100);
  const saved = getBotConfig();
  // Scramble, then restore
  document.getElementById('lcmaia-chain').click();          // re-link (forces equality)
  set('lcmaia-lc-elo', 1500);
  applyBotConfig(saved);
  return {
    savedFlag: saved.lcMaiaEloLinked, savedLc: saved.lcMaiaLcElo, savedMaia: saved.lcMaiaMaiaElo,
    linked: lcMaiaEloLinked,
    lc: +document.getElementById('lcmaia-lc-elo').value,
    maia: +document.getElementById('lcmaia-maia-elo').value,
  };
});
ok(trip.savedFlag === false, 'config carries lcMaiaEloLinked');
ok(trip.savedLc === 2400 && trip.savedMaia === 1100,
   'config carries both ELOs independently (' + trip.savedLc + '/' + trip.savedMaia + ')');
ok(trip.linked === false, 'save→load restores the broken chain');
ok(trip.lc === 2400 && trip.maia === 1100,
   'save→load restores both values unreconciled (' + trip.lc + '/' + trip.maia + ')');

// A bot saved before the chain existed carries no flag — infer it, so the
// switch never contradicts the numbers underneath it.
const legacy = await page.evaluate(() => {
  const out = {};
  applyBotConfig({ engine: 'lcmaia', elo: 1500, lcMaiaLcElo: 2000, lcMaiaMaiaElo: 1200 });
  out.differing = lcMaiaEloLinked;
  applyBotConfig({ engine: 'lcmaia', elo: 1500, lcMaiaLcElo: 1700, lcMaiaMaiaElo: 1700 });
  out.equal = lcMaiaEloLinked;
  return out;
});
ok(legacy.differing === false, 'legacy bot with differing ELOs loads unlinked');
ok(legacy.equal === true, 'legacy bot with equal ELOs loads linked');

// ── App side: what a typed ELO actually asks Lichess for ────────────────────
// The chain decides the number; _snapToLcBand picks the band button and
// lcRatingParam turns that into the wire filter. Both halves must floor into
// the band that CONTAINS the rating, or the panel promises a strength the
// explorer never answers with.
console.log('\nELO → band → wire parameter:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(500);

const band = (elo) => page.evaluate((e) => ({
  button: _snapToLcBand(e),
  wire:   lcRatingParam(_snapToLcBand(e)),
}), elo);

for (const [elo, wantBtn, wantWire, note] of [
  [1550, '1400', '1400',      'the case that was rounding UP out of its own band'],
  [1400, '1400', '1400',      'exactly on a boundary'],
  [1599, '1400', '1400',      'top of the band'],
  [1600, '1600', '1600',      'first rating of the next band'],
  [1999, '1800', '1800',      'just under the boundary'],
  [ 900, '400',  '0',         'below 1000 falls in the bottom band'],
  [ 600, '400',  '0',         'the Elo floor'],
  [2600, '2200', '2200,2500', 'the ceiling reaches the open-ended top band'],
  [2200, '2200', '2200,2500', '"2200+" really means 2200 and above'],
]) {
  const got = await band(elo);
  ok(got.button === wantBtn && got.wire === wantWire,
     `${elo} → band ${got.button} → ratings=${got.wire}  · ${note}`);
}

// Every band button must survive the round trip to itself, or loading a bot
// would quietly shift the band it was saved with.
const stable = await page.evaluate(() =>
  [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200]
    .filter((b) => _snapToLcBand(b) !== String(b)));
ok(stable.length === 0, 'every band button maps to itself (' + (stable.join(',') || 'all stable') + ')');

// And nothing may reach the wire off the enum.
const legal = new Set(['0','1000','1200','1400','1600','1800','2000','2200','2500']);
const offEnum = await page.evaluate(() => {
  const bad = [];
  for (let e = 600; e <= 2600; e += 1) {
    const w = lcRatingParam(_snapToLcBand(e));
    for (const part of w.split(',')) bad.push([e, part]);
  }
  return bad.filter(([, p]) => !['0','1000','1200','1400','1600','1800','2000','2200','2500'].includes(p));
});
ok(offEnum.length === 0,
   'sweep 600-2600: every wire value is on the Lichess enum' +
   (offEnum.length ? ' — got ' + JSON.stringify(offEnum.slice(0, 3)) : ''));

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

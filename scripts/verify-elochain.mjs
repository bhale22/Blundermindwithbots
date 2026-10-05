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

// The book's rating and its PIN. This used to be a chain button between two
// ELO boxes in an "LC+Maia" sub-panel; that panel is gone. Five engine cards
// were never five engines, and the book was never an engine at all — it is a
// layer in front of whichever engine is chosen, so it now has one rating box
// and a pin, in the engine section's book row. Same question as before: is the
// book's rating welded to the engine's, or its own?
const openBook = async () => {
  await page.evaluate(() => {
    const sec = document.getElementById('sec-engine');
    if (sec && !sec.classList.contains('open')) toggleSec('engine');
    const card = document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]');
    if (card) selEngineCard(card);
    setEngineBook('on');
  });
  await page.waitForTimeout(350);
};

await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openBook();
ok(await page.locator('#book-elo-pin').isVisible(), 'the pin is visible in the book row');

const state = () => page.evaluate(() => ({
  book:   +document.getElementById('book-elo').value,
  gauge:  currentElo,
  linked: bookEloLinked,
  cls:    document.getElementById('book-elo-pin').classList.contains('linked'),
  aria:   document.getElementById('book-elo-pin').getAttribute('aria-pressed'),
  ro:     document.getElementById('book-elo').disabled,
}));
// Type into the box the way a user does, so the oninput handler actually runs.
const type = (id, v) => page.evaluate(([i, val]) => {
  const el = document.getElementById(i);
  el.value = val;
  el.dispatchEvent(new Event('input'));
}, [id, v]);

console.log('default:');
let s = await state();
ok(s.linked === true, 'the book starts pinned to the engine');
ok(s.cls && s.aria === 'true', 'the pin renders its linked state');
ok(s.book === s.gauge, `book and engine start in step (book ${s.book} · gauge ${s.gauge})`);
// Pinned means ONE rating. It used to follow that the box was read-only, but
// then the one place a visitor looks for the book's rating could not be typed
// in (Ben, Oct 2026). Now it is a second handle on the same number: typing
// there moves the Elometer too.
ok(s.ro === false, 'the box can be typed in while pinned');
await type('book-elo', '1900');
s = await state();
ok(s.gauge === 1900 && s.book === 1900, 'typing in the pinned box moves the Elometer too (gauge ' + s.gauge + ')');

console.log('\npinned — the engine drives the book:');
await page.evaluate(() => setElo(2200));
s = await state();
ok(s.book === 2200, 'moving the Elometer moves the book with it (' + s.book + ')');

console.log('\nunpinned:');
await page.click('#book-elo-pin');
s = await state();
ok(s.linked === false, 'clicking the pin releases it');
ok(!s.cls && s.aria === 'false', 'the pin renders its released state');
ok(s.ro === false, 'and the box becomes editable');

await type('book-elo', '2500');
s = await state();
ok(s.book === 2500, 'the book takes its own value');
ok(s.gauge === 2200, 'without dragging the Elometer (' + s.gauge + ')');

await page.evaluate(() => setElo(1600));
s = await state();
ok(s.gauge === 1600, 'and the Elometer still moves on its own');
ok(s.book === 2500, 'leaving the book alone (' + s.book + ')');

console.log('\nre-pinning:');
await page.click('#book-elo-pin');
s = await state();
ok(s.linked === true, 'clicking again re-pins');
ok(s.book === 1600,
   "the book adopts the ENGINE's value rather than dragging the gauge (" + s.book + ')');

console.log('\npersistence + config round-trip:');
await page.click('#book-elo-pin');            // release it
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openBook();
s = await state();
ok(s.linked === false, 'the released state survives a reload');
await page.click('#book-elo-pin');            // re-pin
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await openBook();
s = await state();
ok(s.linked === true, 'and so does the pinned state');

const trip = await page.evaluate(() => {
  document.getElementById('book-elo-pin').click();   // unpin
  setElo(1100);
  const e = document.getElementById('book-elo');
  e.value = 2400; e.dispatchEvent(new Event('input'));
  const saved = getBotConfig();
  // Scramble, then restore
  document.getElementById('book-elo-pin').click();   // re-pin (forces equality)
  setElo(1500);
  applyBotConfig(saved);
  return {
    savedFlag: saved.lcMaiaEloLinked, savedLc: saved.lcMaiaLcElo, savedMaia: saved.lcMaiaMaiaElo,
    linked: bookEloLinked,
    book: +document.getElementById('book-elo').value,
    gauge: currentElo,
  };
});
ok(trip.savedFlag === false, 'config carries the pin state');
ok(trip.savedLc === 2400 && trip.savedMaia === 1100,
   'config carries book and engine ELOs independently (' + trip.savedLc + '/' + trip.savedMaia + ')');
ok(trip.linked === false, 'save→load restores the released pin');
ok(trip.book === 2400 && trip.gauge === 1100,
   'save→load restores both values unreconciled (' + trip.book + '/' + trip.gauge + ')');

// A bot saved before the pin existed carries no flag — infer it, so the pin
// never contradicts the numbers underneath it.
const legacy = await page.evaluate(() => {
  const out = {};
  applyBotConfig({ engine: 'lcmaia', elo: 1500, lcMaiaLcElo: 2000, lcMaiaMaiaElo: 1200 });
  out.differing = bookEloLinked;
  applyBotConfig({ engine: 'lcmaia', elo: 1700, lcMaiaLcElo: 1700, lcMaiaMaiaElo: 1700 });
  out.equal = bookEloLinked;
  return out;
});
ok(legacy.differing === false, 'legacy bot with differing ELOs loads unpinned');
ok(legacy.equal === true, 'legacy bot with equal ELOs loads pinned');

// A blend has no single engine rating to pin to, so the pin goes away and the
// book keeps a rating of its own.
const blend = await page.evaluate(() => {
  const card = document.querySelector('#engine-mode-grid .mcard[data-engine="hybrid"]');
  if (card) selEngineCard(card);
  const btn = document.getElementById('book-elo-pin');
  return { hidden: getComputedStyle(btn).display === 'none',
           editable: !document.getElementById('book-elo').disabled };
});
ok(blend.hidden, 'a blend hides the pin — there is no one rating to pin to');
ok(blend.editable, 'and leaves the book its own rating');

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

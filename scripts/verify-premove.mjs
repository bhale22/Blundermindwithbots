// Headless verification of the bot premove feature — the parts the unit tests
// in test/bot-premove.test.js cannot reach: real DOM wiring in the control
// panel, the postMessage config bridge into the app, and the live stats badge.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-premove.mjs
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

// ── Control panel UI ─────────────────────────────────────────────────────────
console.log('panel:');
await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// The real checkbox is visually replaced by a styled track, and it lives in a
// collapsible section — so drive it the way the UI does (set + fire onchange)
// rather than clicking the hidden input.
const setTog = (id, on) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (!el) return false;
  el.checked = v;
  el.dispatchEvent(new Event('change'));
  return true;
}, [id, on]);

ok(await page.locator('#cb-premove').count() === 1, 'premove master toggle exists');
ok(await page.evaluate(() => document.getElementById('premove-sub').style.display === 'none'),
   'controls hidden until enabled');

await setTog('cb-premove', true);
await page.waitForTimeout(150);
ok(await page.evaluate(() => document.getElementById('premove-sub').style.display !== 'none'),
   'enabling reveals the controls');

// Slider ↔ number-box mirroring, both directions
const setRange = (id, v) => page.evaluate(([i, val]) => {
  const el = document.getElementById(i);
  el.value = val;
  el.dispatchEvent(new Event('input'));
}, [id, v]);

await setRange('r-premove-rate', '35');
await page.waitForTimeout(80);
ok(await page.locator('#n-premove-rate').inputValue() === '35', 'rate slider mirrors to number box');

await setRange('n-premove-conf', '70');
await page.waitForTimeout(80);
ok(await page.locator('#r-premove-conf').inputValue() === '70', 'confidence number box mirrors to slider');

// Low-clock sub-gate
ok(await page.evaluate(() => document.getElementById('premove-clock-ctrl').style.display === 'none'),
   'clock threshold hidden until gate is on');
await setTog('cb-premove-clock', true);
await page.waitForTimeout(120);
ok(await page.evaluate(() => document.getElementById('premove-clock-ctrl').style.display !== 'none'),
   'enabling low-clock reveals the threshold');

// Config emitted to the parent app
const cfg = await page.evaluate(() => getBotConfig());
ok(cfg.premoveEnabled === true, 'config carries premoveEnabled');
ok(cfg.premoveRatePct === 35, 'config carries the rate (' + cfg.premoveRatePct + ')');
ok(cfg.premoveMinPct === 70, 'config carries min confidence (' + cfg.premoveMinPct + ')');
ok(cfg.premoveOnlyLowClock === true, 'config carries the low-clock gate');

// Round-trip: a saved config must restore into the same UI state
const roundTrip = await page.evaluate(() => {
  const saved = getBotConfig();
  // Wipe the controls, then re-apply the saved config
  document.getElementById('cb-premove').checked = false;
  showPremove(false, null);
  document.getElementById('r-premove-rate').value = 70;
  applyBotConfig(saved);
  return {
    enabled: document.getElementById('cb-premove').checked,
    rate:    document.getElementById('r-premove-rate').value,
    conf:    document.getElementById('r-premove-conf').value,
    visible: document.getElementById('premove-sub').style.display !== 'none',
  };
});
ok(roundTrip.enabled === true,  'save→load restores the premove toggle');
ok(roundTrip.rate === '35',     'save→load restores the rate (' + roundTrip.rate + ')');
ok(roundTrip.conf === '70',     'save→load restores min confidence (' + roundTrip.conf + ')');
ok(roundTrip.visible === true,  'save→load reopens the sub-panel');

// Persistence across a reload
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
ok(await page.locator('#cb-premove').isChecked(), 'premove toggle persists across reload');
ok(await page.locator('#premove-sub').isVisible(), 'sub-panel restored open on reload');
ok(await page.locator('#r-premove-rate').inputValue() === '35', 'rate persists across reload');

// Live stats badge responds to the app's telemetry message
await page.evaluate(() => window.postMessage(
  { type: 'premoveStats', armed: 4, fired: 3, busted: 1, pending: false }, location.origin));
await page.waitForTimeout(150);
const badge = await page.locator('#premove-stats').textContent();
ok(/3 fired/.test(badge) && /1 busted/.test(badge), 'stats badge renders live counts: "' + badge + '"');

// ── Premove trap illustration ────────────────────────────────────────────────
console.log('trap illustration:');
await page.evaluate(() => pmtOpen());
await page.waitForTimeout(350);

// Board geometry: every square must be identical. Rows holding no pieces used
// to collapse because grid-template-rows was unset — guard against a repeat.
const geo = await page.evaluate(() => {
  const s = [...document.querySelectorAll('#pmt-board .pmt-sq')];
  const h = [...new Set(s.map(x => Math.round(x.getBoundingClientRect().height)))];
  const w = [...new Set(s.map(x => Math.round(x.getBoundingClientRect().width)))];
  return { count: s.length, h, w };
});
ok(geo.count === 64, 'board renders 64 squares');
ok(geo.h.length === 1, 'every row is the same height ' + JSON.stringify(geo.h));
ok(geo.w.length === 1, 'every column is the same width ' + JSON.stringify(geo.w));
ok(geo.h[0] === geo.w[0], 'squares are square (' + geo.h[0] + 'px)');

// Both intentions must be visible before the user acts: the bot's committed
// premove and the move they're being asked to play.
const tabs = await page.locator('#pmt-tabs .pmt-tab').count();
ok(tabs >= 3, 'scenario tabs render (' + tabs + ')');
for (let i = 0; i < tabs; i++) {
  await page.evaluate((j) => pmtSelect(j), i);
  await page.waitForTimeout(220);
  const lines = await page.locator('#pmt-arrows line').count();
  const picks = await page.locator('#pmt-board .pmt-sq.pick').count();
  ok(lines >= 2, 'scenario ' + i + ' shows both arrows up front (' + lines + ' lines)');
  ok(picks === 1, 'scenario ' + i + ' offers exactly one clickable target');
}
ok(await page.locator('.pmt-legend').isVisible(), 'arrow legend is visible');

// Play the firing scenario end to end
await page.evaluate(() => pmtSelect(0));
await page.waitForTimeout(220);
await page.locator('#pmt-board .pmt-sq.pick').click();
await page.waitForTimeout(3200);
ok(/punish/i.test(await page.locator('#pmt-step').textContent()),
   'firing scenario reaches the punishment');
ok(await page.locator('#pmt-outcome').isVisible(), 'outcome panel shown');

// And a busted one
await page.evaluate(() => pmtSelect(1));
await page.waitForTimeout(220);
await page.locator('#pmt-board .pmt-sq.pick').click();
await page.waitForTimeout(1600);
ok(/busted/i.test(await page.locator('#pmt-step').textContent()),
   'busted scenario reports the bust');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok(!(await page.locator('#pmt-overlay').evaluate(e => e.classList.contains('open'))),
   'Escape closes the illustration');

// ── Main app: config bridge lands on the engine globals ──────────────────────
console.log('app:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const globalsExist = await page.evaluate(() => ({
  arm:   typeof botPremoveArm      === 'function',
  fire:  typeof botPremoveTryFire  === 'function',
  reset: typeof botPremoveReset    === 'function',
  flag:  typeof botPremoveEnabled  !== 'undefined',
}));
ok(globalsExist.arm,   'botPremoveArm is defined in the app');
ok(globalsExist.fire,  'botPremoveTryFire is defined in the app');
ok(globalsExist.reset, 'botPremoveReset is defined in the app');
ok(globalsExist.flag,  'botPremoveEnabled global exists');

// Feed a bot config through the same postMessage path the panel uses
const applied = await page.evaluate(async () => {
  window.postMessage({
    type: 'botConfig', engine: 'maia3', color: 'white',
    premoveEnabled: true, premoveRatePct: 42, premoveMinPct: 55,
    premoveOnlyLowClock: true, premoveClockSecs: 20,
  }, location.origin);
  await new Promise(r => setTimeout(r, 250));
  return {
    enabled: botPremoveEnabled, rate: botPremoveRatePct, min: botPremoveMinPct,
    lowClock: botPremoveOnlyLowClock, secs: botPremoveClockSecs,
  };
});
ok(applied.enabled === true, 'bridge sets botPremoveEnabled');
ok(applied.rate === 42,      'bridge sets rate (' + applied.rate + ')');
ok(applied.min === 55,       'bridge sets min confidence (' + applied.min + ')');
ok(applied.lowClock === true, 'bridge sets the low-clock gate');
ok(applied.secs === 20,      'bridge sets the clock threshold (' + applied.secs + ')');

// Without the Maia model loaded, arming must be a safe no-op (not a crash)
const safeNoop = await page.evaluate(async () => {
  botActive = true; gameOver = false; botPlayerColor = 'white';
  botPremoveEnabled = true; botPremoveRatePct = 100;
  try { await botPremoveArm(); return { threw: false, armed: botActivePremove }; }
  catch (e) { return { threw: true, msg: e.message }; }
});
ok(!safeNoop.threw, 'arming without the Maia model does not throw');
ok(safeNoop.armed === null, 'arming without the Maia model arms nothing');

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

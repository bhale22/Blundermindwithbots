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
// Persisted settings would mask the shipped defaults — clear them and reload so
// the checks below see what a genuinely first-time visitor sees.
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
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

// Shipped defaults a first-time visitor sees. Tuned to mirror human play:
// people premove on near-forced replies, not coin flips.
const defs = await page.evaluate(() => ({
  rate:    document.getElementById('r-premove-rate').value,
  conf:    document.getElementById('r-premove-conf').value,
  bust:    document.getElementById('r-premove-bust').value,
  opp:     document.getElementById('r-premove-oppsecs').value,
  own:     document.getElementById('r-premove-secs').value,
  enabled: document.getElementById('cb-premove').checked,
  lowClk:  document.getElementById('cb-premove-clock').checked,
}));
ok(defs.rate === '80',    'default premove rate is 80% (' + defs.rate + ')');
ok(defs.conf === '85',    'default min confidence is 85% (' + defs.conf + ')');
ok(defs.bust === '2',     'default bust delay is 2s (' + defs.bust + ')');
ok(defs.opp  === '30',    'default opponent-clock threshold is 30s');
ok(defs.own  === '30',    'default bot-clock threshold is 30s');
ok(defs.enabled === false, 'premoving is OFF by default (opt-in)');
ok(defs.lowClk  === false, 'low-clock gate is OFF by default');

// Collapsed Move Timing header always reports premove state
const stOff = await page.locator('#st-timing').textContent();
ok(/premoves off/i.test(stOff), 'collapsed header shows "Premoves off": "' + stOff + '"');
await page.evaluate(() => {
  const e = document.getElementById('cb-premove'); e.checked = true; e.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const stOn = await page.locator('#st-timing').textContent();
ok(/premoves on/i.test(stOn), 'header updates to "Premoves on": "' + stOn + '"');
ok(/fixed interval/i.test(stOn), 'header still names the timing mode');
await page.evaluate(() => {
  const e = document.getElementById('cb-premove'); e.checked = false; e.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);

// Move Timing two-column layout: modes stacked, each owning its control drawer
const layout = await page.evaluate(() => {
  const stack = document.querySelector('#timing-mode-grid');
  const blocks = [...document.querySelectorAll('.mode-block')];
  const cards = [...document.querySelectorAll('[data-g="timing"]')];
  return {
    isStack: !!stack && getComputedStyle(stack).flexDirection === 'column',
    blocks: blocks.length,
    order: cards.map(c => c.dataset.v),
    drawers: blocks.filter(b => b.querySelector('.mode-ctrl')).length,
  };
});
ok(layout.isStack, 'timing modes are stacked vertically');
ok(layout.blocks === 4, 'four mode blocks (' + layout.blocks + ')');
ok(layout.drawers === 4, 'every mode owns a control drawer (' + layout.drawers + ')');
ok(layout.order.join('|') === 'Instantaneous|Fixed interval|Mirror user|Complexity-scaled',
   'order is Instantaneous → Fixed → Mirror → Complexity: ' + layout.order.join(' → '));

// Selecting a mode opens exactly one drawer
for (const [v, id] of [['Complexity-scaled','tb-complexity'], ['Instantaneous','tb-instant'],
                       ['Mirror user','tb-mirror'], ['Fixed interval','tb-fixed']]) {
  await page.evaluate((val) => {
    document.querySelector(`[data-v="${val}"]`).click();
  }, v);
  await page.waitForTimeout(120);
  const open = await page.evaluate(() => [...document.querySelectorAll('.mode-block.open')].map(b => b.id));
  ok(open.length === 1 && open[0] === id, v + ' opens only its own drawer (' + open.join(',') + ')');
}

ok(await page.locator('#btn-reset-panel').count() === 1, 'whole-panel reset button exists');

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

// Both clock triggers exist, and the sub-panel is ordered:
// low-clock toggle → opponent clock → bot clock → the remaining controls.
ok(await page.locator('#r-premove-oppsecs').count() === 1, 'opponent-clock trigger exists');
const order = await page.evaluate(() => {
  const sub = document.getElementById('premove-sub');
  const ids = ['cb-premove-clock','r-premove-oppsecs','r-premove-secs','r-premove-rate',
               'r-premove-conf','r-premove-bust'];
  const all = [...sub.querySelectorAll('*')];
  return ids.map((id) => all.indexOf(document.getElementById(id)));
});
ok(order.every((v, i) => i === 0 || v > order[i - 1]),
   'sub-panel order: low-clock toggle → opponent clock → bot clock → rate → confidence → bust');

// Either threshold accepts 0 to switch that trigger off
await setRange('r-premove-oppsecs', '0');
await page.waitForTimeout(80);
ok(await page.locator('#n-premove-oppsecs').inputValue() === '0',
   'opponent-clock trigger can be set to 0 (off)');
await setRange('r-premove-oppsecs', '25');
await page.waitForTimeout(80);

// Config emitted to the parent app
const cfg = await page.evaluate(() => getBotConfig());
ok(cfg.premoveEnabled === true, 'config carries premoveEnabled');
ok(cfg.premoveRatePct === 35, 'config carries the rate (' + cfg.premoveRatePct + ')');
ok(cfg.premoveMinPct === 70, 'config carries min confidence (' + cfg.premoveMinPct + ')');
ok(cfg.premoveOnlyLowClock === true, 'config carries the low-clock gate');
ok(cfg.premoveOppClockSecs === 25, 'config carries the opponent-clock threshold (' + cfg.premoveOppClockSecs + ')');

// Busted-premove delay: seconds in the UI, milliseconds in the config
await setRange('r-premove-bust', '3.5');
await page.waitForTimeout(80);
ok(await page.locator('#n-premove-bust').inputValue() === '3.5', 'bust delay mirrors to number box');
const cfg2 = await page.evaluate(() => getBotConfig());
ok(cfg2.premoveBustDelayMs === 3500,
   'bust delay converts 3.5 s → 3500 ms (' + cfg2.premoveBustDelayMs + ')');
await setRange('r-premove-bust', '0');
await page.waitForTimeout(80);
const cfg3 = await page.evaluate(() => getBotConfig());
ok(cfg3.premoveBustDelayMs === 0, 'bust delay supports 0 (no penalty)');
await setRange('r-premove-bust', '2');
await page.waitForTimeout(80);

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

// Number boxes must not render amber-on-white. .ctrl-val is shared with plain
// <span> readouts, so applying it to an <input type=number> used to inherit the
// browser's white field and drop contrast to ~1.7:1.
const contrast = await page.evaluate(() => {
  const lum = (c) => {
    const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const out = {};
  document.querySelectorAll('input.ctrl-val[type=number]').forEach((el) => {
    const cs = getComputedStyle(el);
    const l1 = lum(cs.color), l2 = lum(cs.backgroundColor);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    out[el.id] = Math.round(ratio * 100) / 100;
  });
  return out;
});
const ids = Object.keys(contrast);
ok(ids.length > 0, 'found number inputs to check (' + ids.length + ')');
const worst = ids.reduce((w, id) => (contrast[id] < contrast[w] ? id : w), ids[0]);
ok(contrast[worst] >= 4.5,
   'every number box meets 4.5:1 contrast — worst is ' + worst + ' at ' + contrast[worst] + ':1');

// Explainer popup — prose only, no diagram
ok(await page.locator('.pmt-help-btn').count() === 1, 'explainer button exists');
ok(!(await page.locator('#pmt-overlay').evaluate(e => e.classList.contains('open'))),
   'explainer starts closed');
await page.evaluate(() => pmtOpen());
await page.waitForTimeout(200);
ok(await page.locator('#pmt-overlay').evaluate(e => e.classList.contains('open')),
   'button opens the explainer');

const note = await page.locator('.pmt-body').textContent();
ok(/what's a premove\?/i.test(note),      'explains what a premove is first');
ok(/what's a premove trap\?/i.test(note), 'then explains what a trap is');
ok(note.search(/what's a premove\?/i) < note.search(/what's a premove trap\?/i),
   'premove is defined before premove trap');
ok(/free material|untouched/i.test(note), 'covers the still-legal case (bot plays on past free material)');
ok(/illegal/i.test(note),              'covers the busted case');
ok(/busted-premove delay/i.test(note), 'names the delay setting rather than saying "above"');
ok(/premove rate/i.test(note) && /min confidence/i.test(note),
   'points at the panel controls by name');
ok(await page.locator('#pmt-board').count() === 0, 'no diagram board — prose only');

// Outbound reading links: must open in a new tab and carry noopener
const links = await page.evaluate(() => [...document.querySelectorAll('.pmt-links a')]
  .map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
ok(links.length >= 3, 'explainer links to further reading (' + links.length + ')');
ok(links.every((l) => /^https:/.test(l.href)), 'all reading links are https');
ok(links.every((l) => l.target === '_blank'), 'reading links open in a new tab');
ok(links.every((l) => /noopener/.test(l.rel)), 'reading links carry rel=noopener');

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok(!(await page.locator('#pmt-overlay').evaluate(e => e.classList.contains('open'))),
   'Escape closes the explainer');

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
    premoveOnlyLowClock: true, premoveClockSecs: 20, premoveBustDelayMs: 3500,
    premoveOppClockSecs: 15,
  }, location.origin);
  await new Promise(r => setTimeout(r, 250));
  return {
    enabled: botPremoveEnabled, rate: botPremoveRatePct, min: botPremoveMinPct,
    lowClock: botPremoveOnlyLowClock, secs: botPremoveClockSecs,
    bust: botPremoveBustDelayMs, oppSecs: botPremoveOppClockSecs,
  };
});
ok(applied.enabled === true, 'bridge sets botPremoveEnabled');
ok(applied.rate === 42,      'bridge sets rate (' + applied.rate + ')');
ok(applied.min === 55,       'bridge sets min confidence (' + applied.min + ')');
ok(applied.lowClock === true, 'bridge sets the low-clock gate');
ok(applied.secs === 20,      'bridge sets the clock threshold (' + applied.secs + ')');
ok(applied.bust === 3500,    'bridge sets the bust delay (' + applied.bust + ' ms)');
ok(applied.oppSecs === 15,   'bridge sets the opponent-clock threshold (' + applied.oppSecs + ')');

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

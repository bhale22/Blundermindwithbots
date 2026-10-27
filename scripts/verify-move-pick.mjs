// Headless verification of the two move-pick controls — Conviction (the share
// of moves that play the top of the shaped distribution) and "Never play better
// than the most popular move" — plus the bot they exist for: Maia sampled
// unaltered, Mirror-user timing with both time-pressure curves off.
// test/move-pick.test.js covers the engine; this covers the builder's DOM, its
// save/load, the chart, the gating, and the config reaching the app.
// Needs the server running (PORT=3100 node server.js). From repo root:
//   node scripts/verify-move-pick.mjs [--shots dir]      (BASE=http://... to override)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3100';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

// ── Builder: the controls and their defaults ─────────────────────────────────
console.log('builder:');
await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const dom = await page.evaluate(() => {
  const sl = document.getElementById('r-conviction');
  const chart = document.getElementById('temp-dist-chart');
  const nu = document.getElementById('cb-no-upgrade');
  const floor = document.getElementById('hard-floor-row');
  return {
    slider: !!sl, value: sl && sl.value, label: document.getElementById('v-conviction')?.textContent,
    inTempCol: !!(sl && sl.closest('#engine-temp-col')),
    underChart: !!(sl && chart && (chart.compareDocumentPosition(sl) & Node.DOCUMENT_POSITION_FOLLOWING)),
    sw: !!nu, checked: nu && nu.checked,
    afterFloor: !!(nu && floor && (floor.compareDocumentPosition(nu) & Node.DOCUMENT_POSITION_FOLLOWING)),
    cfg: (() => { const c = getBotConfig(); return { conv: c.convictionPct, nu: c.noUpgradeGuard }; })(),
  };
});
ok(dom.slider && dom.inTempCol, 'Conviction slider is in the Engine section\'s temperature column');
ok(dom.underChart, 'Conviction slider sits under the distribution chart');
ok(dom.value === '0' && dom.label === '0%', 'Conviction defaults to 0% (' + dom.value + ', "' + dom.label + '")');
ok(dom.sw && dom.afterFloor, '"Never play better…" switch sits under the Hard Floor');
ok(dom.checked === false, 'the switch is OFF by default');
ok(dom.cfg.conv === 0 && dom.cfg.nu === false, 'getBotConfig writes convictionPct 0, noUpgradeGuard false');

// ── The chart draws the mix ───────────────────────────────────────────────────
console.log('chart:');
const mix = await page.evaluate(() => {
  const P = [0.42, 0.30, 0.18, 0.07, 0.03];
  return { c0: _convictionMix(P, 1.0, 0), c30: _convictionMix(P, 1.0, 30), c100: _convictionMix(P, 1.0, 100) };
});
ok(mix.c0.every((v, i) => near(v, [0.42, 0.30, 0.18, 0.07, 0.03][i])), 'Conviction 0% at T 1.0 draws Maia\'s odds unaltered');
ok(near(mix.c30[0], 0.3 + 0.7 * 0.42) && near(mix.c30[1], 0.7 * 0.30), 'Conviction 30% draws top = 0.3 + 0.7 × p (' + mix.c30[0].toFixed(3) + ')');
ok(near(mix.c100[0], 1) && near(mix.c100[1], 0), 'Conviction 100% draws only the top move');
ok(near(mix.c30.reduce((a, b) => a + b, 0), 1), 'the Played bar still sums to 100%');
const redraw = await page.evaluate(() => {
  try { onConvictionSlider(0); onConvictionSlider(100); onConvictionSlider(30); return true; }
  catch (e) { return e.message; }
});
ok(redraw === true, 'moving the slider redraws the chart without error');
const label = await page.evaluate(() => { onConvictionSlider(45); return document.getElementById('v-conviction').textContent; });
ok(label === '45%', 'the readout follows the slider (' + label + ')');

// ── Save / load ───────────────────────────────────────────────────────────────
console.log('save/load:');
const rt = await page.evaluate(() => {
  onConvictionSlider(0);
  document.getElementById('cb-no-upgrade').checked = true;
  const saved = getBotConfig();
  onConvictionSlider(70);
  document.getElementById('cb-no-upgrade').checked = false;
  applyBotConfig(saved);
  const back = { conv: document.getElementById('r-conviction').value, nu: document.getElementById('cb-no-upgrade').checked };
  const legacy = Object.assign({}, saved); delete legacy.convictionPct; delete legacy.noUpgradeGuard;
  applyBotConfig(legacy);
  const old = { conv: document.getElementById('r-conviction').value, nu: document.getElementById('cb-no-upgrade').checked };
  return { savedConv: saved.convictionPct, savedNu: saved.noUpgradeGuard, back, old };
});
ok(rt.savedConv === 0 && rt.savedNu === true, 'getBotConfig reads both controls (0%, on)');
ok(rt.back.conv === '0' && rt.back.nu === true, 'applyBotConfig restores both');
ok(rt.old.conv === '30' && rt.old.nu === true, 'a bot saved before the controls opens as it played: 30%, switch on');

// ── Bad Day preset switches the check on ─────────────────────────────────────
const bd = await page.evaluate(() => {
  document.getElementById('cb-no-upgrade').checked = false;
  _applyPersonality('badday');
  return document.getElementById('cb-no-upgrade').checked;
});
ok(bd === true, 'Grandmaster Bad Day turns "Never play better…" on');

// ── Greyed for Flounder-only bots ─────────────────────────────────────────────
console.log('gating:');
const gate = await page.evaluate(() => {
  const pick = (e) => selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
  setEngineBook('off');
  pick('stockfish');
  syncControlGating();
  const tog = document.getElementById('cb-no-upgrade').closest('.tog-row');
  const fl = { conv: document.getElementById('conviction-row').classList.contains('inert'),
               convInput: document.getElementById('r-conviction').inert,
               sw: tog.classList.contains('inert') };
  setEngineBook('on');
  syncControlGating();
  const book = { conv: document.getElementById('conviction-row').classList.contains('inert'), sw: tog.classList.contains('inert') };
  setEngineBook('off');
  pick('maia3');
  syncControlGating();
  const ma = { conv: document.getElementById('conviction-row').classList.contains('inert'), sw: tog.classList.contains('inert') };
  return { fl, book, ma };
});
ok(gate.fl.conv && gate.fl.convInput && gate.fl.sw, 'Flounder-only: both controls greyed and inoperable');
ok(!gate.book.conv && !gate.book.sw, 'Flounder + book: both live (they act on book moves)');
ok(!gate.ma.conv && !gate.ma.sw, 'Maia 3: both live');

// ── Mirror user with both time-pressure curves off ───────────────────────────
console.log('mirror, curves off:');
const mir = await page.evaluate(() => {
  const card = document.querySelector('#timing-mode-grid .mcard[data-v="Mirror user"]');
  if (card) card.click();
  syncControlGating();
  const a = document.getElementById('pressure-off-a'), b = document.getElementById('pressure-off-b');
  const operable = (el) => !!el && !el.closest('.inert') && !el.closest('[inert]');
  const before = { a: operable(a), b: operable(b) };
  a.checked = false; a.onchange && a.onchange();
  b.checked = false; b.onchange && b.onchange();
  const c = getBotConfig();
  return { before, mode: c.timingMode, offA: c.pressureOffA, offB: c.pressureOffB, tc: c.tcTime };
});
ok(mir.mode === 'mirror', 'timing is Mirror user (' + mir.mode + ')');
ok(mir.before.a && mir.before.b, 'both curve switches are operable under Mirror');
ok(mir.offA === true && mir.offB === true, 'config carries both curves off');

if (SHOTS) {
  await page.evaluate(() => { onConvictionSlider(30); });
  await page.evaluate(() => { const s = document.getElementById('sec-engine'); if (s && !s.classList.contains('open')) toggleSec('engine'); });
  await page.waitForTimeout(500);
  await page.locator('#engine-temp-col').screenshot({ path: SHOTS + '/conviction-desktop.png' });
  await page.evaluate(() => { const s = document.getElementById('sec-attract'); if (s && !s.classList.contains('open')) toggleSec('attract'); switchItab('attract', 'quality'); });
  await page.waitForTimeout(500);
  await page.locator('#hard-floor-row').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.locator('.gauge-section').first().screenshot({ path: SHOTS + '/no-upgrade-desktop.png' }).catch(() => {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  // Opening Personality folded the Engine section; reopen it for the chart.
  await page.evaluate(() => { const s = document.getElementById('sec-engine'); if (s && !s.classList.contains('open')) toggleSec('engine'); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { onTempSlider(_currentTempValue); document.getElementById('conviction-row').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300);
  await page.locator('#engine-temp-col').screenshot({ path: SHOTS + '/conviction-phone.png' }).catch(() => {});
  await page.setViewportSize({ width: 1366, height: 900 });
}

// ── The app: the builder's config lands on the engine ────────────────────────
console.log('app:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const appDefaults = await page.evaluate(() => ({ conv: botConvictionPct, nu: botNoUpgradeGuard }));
ok(appDefaults.conv === 0 && appDefaults.nu === false, 'app defaults: Conviction 0%, check off');

// End to end: the real builder in its iframe, posting its own getBotConfig.
await page.evaluate(() => openBotModal());
const frameEl = await page.waitForSelector('#botModalFrame');
const frame = await frameEl.contentFrame();
await frame.waitForFunction(() => typeof getBotConfig === 'function' && typeof onConvictionSlider === 'function');
await frame.waitForTimeout(300);
await frame.evaluate(() => {
  selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
  setElo(1500);
  onTempSlider(1.0);
  onConvictionSlider(0);
  document.getElementById('cb-no-upgrade').checked = false;
  _setHardFloorValue(1000, false);
  document.querySelector('#timing-mode-grid .mcard[data-v="Mirror user"]').click();
  const a = document.getElementById('pressure-off-a'), b = document.getElementById('pressure-off-b');
  a.checked = false; a.onchange && a.onchange();
  b.checked = false; b.onchange && b.onchange();
  parent.postMessage(Object.assign(getBotConfig(), { _applyOnly: true }), location.origin);
});
await page.waitForTimeout(400);
const live = await page.evaluate(() => ({
  conv: botConvictionPct, nu: botNoUpgradeGuard, floor: window._bcpCpHardFloor,
  timing: botTimeBehavior, curveA: botPressureCurveA, curveB: botPressureCurveB,
  elo: maia3SelectedRating,
  eloAt1s: pressureEffectiveMaiaEloByThink(1), tempAt1s: timePressureTempByThink(1.0, 1),
}));
ok(live.conv === 0 && live.nu === false, 'builder → app: Conviction 0%, check off');
ok(live.floor >= 1000, 'builder → app: Hard Floor Off (' + live.floor + ')');
ok(live.timing === 'mirror', 'builder → app: Mirror user timing');
ok(live.curveA === null && live.curveB === null, 'builder → app: no time-pressure curves');
ok(+live.eloAt1s === +live.elo && live.tempAt1s === 1.0,
   'a 1-second think plays at the bot\'s own rating and T (' + live.eloAt1s + ', ' + live.tempAt1s + ')');

const legacyApp = await page.evaluate(async () => {
  window.postMessage({ type: 'botConfig', engine: 'maia3', color: 'white', _applyOnly: true }, location.origin);
  await new Promise(r => setTimeout(r, 250));
  return { conv: botConvictionPct, nu: botNoUpgradeGuard };
});
ok(legacyApp.conv === 30 && legacyApp.nu === true, 'app reads an old config as it played: 30%, check on');

// ── The Lichess page still comes up ──────────────────────────────────────────
console.log('lichess page:');
await page.goto(BASE + '/?lichess', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
ok(await page.evaluate(() => !!document.getElementById('lbPanel')), '?lichess shows the bridge panel');

const real = errors.filter(e => !/Failed to load resource|ERR_|net::/.test(e));
ok(real.length === 0, 'no page errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));
if (errors.length > real.length) console.log('  (network noise ignored: ' + (errors.length - real.length) + ')');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

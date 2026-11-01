// Headless verification of how a move is picked from the shaped distribution —
// Conviction (the share of moves that play its top outright: two linked
// sliders, 0% with no personality, 100% once one is chosen) and the degradation
// check (no switch: it runs under Bad Day and time pressure only) — plus the
// bot they exist for: Maia sampled unaltered, Mirror-user timing with both
// time-pressure curves off.
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
  const cfg = getBotConfig();
  return {
    slider: !!sl, value: sl && sl.value, label: document.getElementById('v-conviction')?.textContent,
    inTempCol: !!(sl && sl.closest('#engine-temp-col')),
    underChart: !!(sl && chart && (chart.compareDocumentPosition(sl) & Node.DOCUMENT_POSITION_FOLLOWING)),
    ends: [...(sl?.closest('.slider-scale-wrap')?.querySelectorAll('.slider-scale > span') || [])].map(s => s.textContent),
    switchGone: !document.getElementById('cb-no-upgrade') && !/Never play better/i.test(document.body.textContent),
    conv: cfg.convictionPct, cfgHasNu: 'noUpgradeGuard' in cfg,
  };
});
ok(dom.slider && dom.inTempCol, 'Conviction slider is in the Engine section\'s temperature column');
ok(dom.underChart, 'Conviction slider sits under the distribution chart');
ok(dom.value === '0' && dom.label === '0%', 'Conviction defaults to 0% (' + dom.value + ', "' + dom.label + '")');
ok(dom.ends.length === 2 && /Maia distribution/.test(dom.ends[0]) && /favorite move/.test(dom.ends[1]),
   'Conviction ends are labelled (' + dom.ends.join(' | ') + ')');
ok(dom.switchGone, 'the "Never play better than the most popular move" switch is gone');
ok(dom.conv === 0 && !dom.cfgHasNu, 'getBotConfig writes convictionPct 0 and no noUpgradeGuard');

// ── Its twin under the Centipawmeter's Budget ────────────────────────────────
const twin = await page.evaluate(() => {
  const m = document.getElementById('r-conviction-mirror');
  const budget = document.getElementById('r-style'), floor = document.getElementById('hard-floor-row');
  const after = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  const val = () => ({ main: document.getElementById('r-conviction').value, mirror: m.value,
                       mainOut: document.getElementById('v-conviction').textContent,
                       mirrorOut: document.getElementById('v-conviction-mirror').textContent,
                       cfg: getBotConfig().convictionPct });
  const start = val();
  m.value = 65; m.dispatchEvent(new Event('input'));
  const fromMirror = val();
  onConvictionSlider(20);
  const fromMain = val();
  onConvictionSlider(0);
  return {
    exists: !!m, inGauge: !!(m && m.closest('.gauge-section')),
    order: after(budget, m) && after(m, floor),
    ends: [...(m?.closest('.slider-scale-wrap')?.querySelectorAll('.slider-scale > span') || [])].map(s => s.textContent),
    start, fromMirror, fromMain,
  };
});
ok(twin.exists && twin.inGauge && twin.order, 'a second Conviction slider sits in the Centipawmeter box, under Budget and above Hard Floor');
ok(twin.ends.length === 2 && /Maia distribution/.test(twin.ends[0]) && /favorite move/.test(twin.ends[1]), 'its ends carry the same labels');
ok(twin.start.mirror === '0' && twin.start.mirrorOut === '0%', 'it starts at 0% too');
ok(twin.fromMirror.main === '65' && twin.fromMirror.mainOut === '65%' && twin.fromMirror.mirrorOut === '65%' && twin.fromMirror.cfg === 65,
   'moving the Budget-side slider moves the Engine one and the config (65%)');
ok(twin.fromMain.mirror === '20' && twin.fromMain.mirrorOut === '20%', 'and the other way round (20%)');

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
  onConvictionSlider(15);
  const saved = getBotConfig();
  onConvictionSlider(70);
  applyBotConfig(saved);
  const back = document.getElementById('r-conviction').value;
  // A bot saved before Conviction was a control — and with the old switch on.
  const legacy = Object.assign({}, saved, { noUpgradeGuard: true }); delete legacy.convictionPct;
  let err = null;
  try { applyBotConfig(legacy); } catch (e) { err = e.message; }
  const old = document.getElementById('r-conviction').value;
  return { savedConv: saved.convictionPct, back, old, err, nuOut: 'noUpgradeGuard' in getBotConfig() };
});
ok(rt.savedConv === 15 && rt.back === '15', 'Conviction saves and restores (15%)');
ok(rt.old === '30' && rt.err === null && !rt.nuOut,
   'a bot saved before the controls opens at 30%; its old switch setting loads without error and is dropped');

// ── Bad Day still promises the check, with nothing to switch on ──────────────
const bd = await page.evaluate(() => {
  selPersonality('badday');
  const items = [...document.querySelectorAll('#bdconfirm-list li')].map(li => li.textContent);
  _bdApply();
  return { evalChecked: items.some(t => /Eval-checked/.test(t)), cfgBadDay: getBotConfig().badDayMode };
});
ok(bd.evalChecked && bd.cfgBadDay === true, 'Grandmaster Bad Day still lists "Eval-checked" and saves as Bad Day');

// ── Choosing a personality takes Conviction to 100%, with a note ─────────────
console.log('personality → conviction:');
const pers = await page.evaluate(() => {
  const conv = () => document.getElementById('r-conviction').value;
  const shown = () => document.getElementById('conv-toast').classList.contains('show');
  onConvictionSlider(0); hideConvToast();
  selPersonality('attacky');
  const a = { conv: conv(), toast: shown(), cfg: getBotConfig().convictionPct };
  hideConvToast();
  onConvictionSlider(40);
  selPersonality('pawnchain');
  const b = { conv: conv(), toast: shown() };
  hideConvToast();
  selPersonality('norm');
  const c = { conv: conv(), toast: shown() };
  // A preset that confirms first lists it in its modal, and shows no note.
  onConvictionSlider(0);
  selPersonality('drawmeister');
  const listed = [...document.querySelectorAll('#bdconfirm-list li')].some(li => /Conviction → 100%/.test(li.textContent));
  const before = conv();
  _bdApply();
  const d = { listed, before, conv: conv(), toast: shown() };
  // Loading a saved bot keeps its own Conviction and shows nothing.
  const saved = getBotConfig(); saved.convictionPct = 25;
  applyBotConfig(saved);
  const e = { conv: conv(), toast: shown(), pid: selectedPersonality };
  // Editing an attractor after a preset leaves Conviction where it is.
  onConvictionSlider(100);
  onAttractorChange('chaos', 2);
  const f = { conv: conv(), pid: selectedPersonality };
  return { a, b, c, d, e, f };
});
ok(pers.a.conv === '100' && pers.a.toast && pers.a.cfg === 100, 'choosing a personality from 0% sets 100% and shows the note');
ok(pers.b.conv === '100' && pers.b.toast, 'from a lowered value (40%) too');
ok(pers.c.conv === '100' && !pers.c.toast, 'already at 100%: no note');
ok(pers.d.listed && pers.d.before === '0' && pers.d.conv === '100' && !pers.d.toast,
   'a confirm-first preset lists Conviction → 100% in its modal, sets it on apply, no extra note');
ok(pers.e.conv === '25' && !pers.e.toast && pers.e.pid === 'drawmeister', 'loading a saved bot keeps its Conviction (25%), no note');
ok(pers.f.conv === '100' && pers.f.pid === null, 'a manual attractor edit leaves Conviction alone');

const toast = await page.evaluate(() => {
  onConvictionSlider(0);
  document.querySelectorAll('.section.open').forEach(s => toggleSec(s.id.replace('sec-', '')));
  window.scrollTo(0, 0);
  selPersonality('attacky');
  const r = document.getElementById('conv-toast').getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight,
           bar: document.querySelector('.quickstart').getBoundingClientRect().bottom,
           text: document.getElementById('conv-toast').textContent.replace(/\s+/g, ' ').trim() };
});
ok(toast.top >= 0 && toast.bottom <= toast.vh && toast.left >= 0 && toast.right <= toast.vw, 'the note is on screen (desktop)');
ok(toast.top >= toast.bar, 'the note sits below the quick-start bar, not over it (' + Math.round(toast.top) + ' ≥ ' + Math.round(toast.bar) + ')');
await page.waitForTimeout(300);
ok(/100%/.test(toast.text) && /favorite move/.test(toast.text) && /adjust/i.test(toast.text), 'the note says 100%, favorite move, adjustable');
if (SHOTS) await page.screenshot({ path: SHOTS + '/conv-toast-desktop.png' });
await page.click('#conv-toast .bdbtns button:first-child');   // Adjust — a real click, so nothing covers it
await page.waitForTimeout(1200);
const adj = await page.evaluate(() => {
  const r = document.getElementById('conviction-row-mirror').getBoundingClientRect();
  return { open: document.getElementById('sec-attract').classList.contains('open'),
           tab: document.getElementById('itab-attract-quality').classList.contains('active'),
           inView: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
           toast: document.getElementById('conv-toast').classList.contains('show') };
});
ok(adj.open && adj.tab && adj.inView && !adj.toast, 'Adjust closes the note and brings the Conviction slider under the Budget into view');
// The pointer is still where Adjust was, and hovering holds the note; move it off.
await page.mouse.move(5, 880);
await page.evaluate(() => { onConvictionSlider(0); selPersonality('attacky'); });
await page.waitForTimeout(9400);
ok(await page.evaluate(() => !document.getElementById('conv-toast').classList.contains('show')), 'the note leaves on its own after ~9 s');

// ── Greyed for Flounder-only bots ─────────────────────────────────────────────
console.log('gating:');
const gate = await page.evaluate(() => {
  const pick = (e) => selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
  const inert = () => document.getElementById('conviction-row').classList.contains('inert')
                   && document.getElementById('conviction-row-mirror').classList.contains('inert');
  setEngineBook('off');
  pick('stockfish');
  syncControlGating();
  const fl = { conv: inert(),
               convInput: document.getElementById('r-conviction').inert && document.getElementById('r-conviction-mirror').inert };
  setEngineBook('on');
  syncControlGating();
  const book = inert();
  setEngineBook('off');
  pick('maia3');
  syncControlGating();
  const ma = inert();
  return { fl, book, ma };
});
ok(gate.fl.conv && gate.fl.convInput, 'Flounder-only: both Conviction sliders greyed and inoperable');
ok(!gate.book, 'Flounder + book: live (they act on book moves)');
ok(!gate.ma, 'Maia 3: live');

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
  await page.locator('.gauge-section').first().screenshot({ path: SHOTS + '/gauge-desktop.png' }).catch(() => {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  // Opening Personality folded the Engine section; reopen it for the chart.
  await page.evaluate(() => { const s = document.getElementById('sec-engine'); if (s && !s.classList.contains('open')) toggleSec('engine'); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { onTempSlider(_currentTempValue); document.getElementById('conviction-row').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300);
  await page.locator('#engine-temp-col').screenshot({ path: SHOTS + '/conviction-phone.png' }).catch(() => {});
  await page.evaluate(() => { onConvictionSlider(0); selPersonality('attacky'); window.scrollTo(0, 0); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + '/conv-toast-phone.png' });
  await page.evaluate(() => hideConvToast());
  await page.evaluate(() => { qsOpenSection('attract', 'quality'); });
  await page.waitForTimeout(600);
  await page.locator('#conviction-row-mirror').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/conviction-mirror-phone.png' });
  await page.setViewportSize({ width: 1366, height: 900 });
}

// ── The app: the builder's config lands on the engine ────────────────────────
console.log('app:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const appDefaults = await page.evaluate(() => ({ conv: botConvictionPct, nu: typeof botNoUpgradeGuard }));
ok(appDefaults.conv === 0 && appDefaults.nu === 'undefined', 'app defaults: Conviction 0%, no switch variable');

// The check itself, in the real bundle: Bad Day swaps a better move back;
// an ordinary pick is played as sampled, without asking the engine.
const guard = await page.evaluate(async () => {
  const keep = { probe: sfEvalMoves, ready: sfReady, bad: botBadDayMode };
  let probes = 0;
  sfEvalMoves = async (fen, moves) => { probes++; return Object.fromEntries(moves.map(m => [m, m === 'c2c4' ? 150 : 0])); };
  sfReady = true;
  const P = { e2e4: 0.5, d2d4: 0.3, c2c4: 0.2 };
  const out = {};
  try {
    botBadDayMode = false;
    out.plain = await applyDegradationEvalGuard('fen', 'c2c4', P);
    out.plainProbes = probes;
    botBadDayMode = true;
    out.badDay = await applyDegradationEvalGuard('fen', 'c2c4', P);
  } finally {
    sfEvalMoves = keep.probe; sfReady = keep.ready; botBadDayMode = keep.bad;
  }
  return out;
});
ok(guard.plain === 'c2c4' && guard.plainProbes === 0, 'app: an ordinary pick that beats the popular move stands, unprobed');
ok(guard.badDay === 'e2e4', 'app: under Bad Day the same pick is swapped back to the popular move');

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
  _setHardFloorValue(1000, false);
  document.querySelector('#timing-mode-grid .mcard[data-v="Mirror user"]').click();
  const a = document.getElementById('pressure-off-a'), b = document.getElementById('pressure-off-b');
  a.checked = false; a.onchange && a.onchange();
  b.checked = false; b.onchange && b.onchange();
  parent.postMessage(Object.assign(getBotConfig(), { _applyOnly: true }), location.origin);
});
await page.waitForTimeout(400);
const live = await page.evaluate(() => ({
  conv: botConvictionPct, floor: window._bcpCpHardFloor,
  timing: botTimeBehavior, curveA: botPressureCurveA, curveB: botPressureCurveB,
  elo: maia3SelectedRating,
  eloAt1s: pressureEffectiveMaiaEloByThink(1), tempAt1s: timePressureTempByThink(1.0, 1),
}));
ok(live.conv === 0, 'builder → app: Conviction 0%');
ok(live.floor >= 1000, 'builder → app: Hard Floor Off (' + live.floor + ')');
ok(live.timing === 'mirror', 'builder → app: Mirror user timing');
ok(live.curveA === null && live.curveB === null, 'builder → app: no time-pressure curves');
ok(+live.eloAt1s === +live.elo && live.tempAt1s === 1.0,
   'a 1-second think plays at the bot\'s own rating and T (' + live.eloAt1s + ', ' + live.tempAt1s + ')');

const legacyApp = await page.evaluate(async () => {
  window.postMessage({ type: 'botConfig', engine: 'maia3', color: 'white', noUpgradeGuard: true, _applyOnly: true }, location.origin);
  await new Promise(r => setTimeout(r, 250));
  return { conv: botConvictionPct, nu: typeof botNoUpgradeGuard };
});
ok(legacyApp.conv === 30 && legacyApp.nu === 'undefined', 'app reads an old config as it played (30%) and ignores its switch');

// ── The Lichess page still comes up ──────────────────────────────────────────
console.log('lichess page:');
await page.goto(BASE + '/?lichess', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
ok(await page.evaluate(() => typeof lichessBuilderState === 'function' && !document.getElementById('lbPanel') &&
  !/(^|[?&])lichess(&|$)/.test(location.search)), '?lichess with no saved token: no bridge panel, and no host mark');

const real = errors.filter(e => !/Failed to load resource|ERR_|net::/.test(e));
ok(real.length === 0, 'no page errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));
if (errors.length > real.length) console.log('  (network noise ignored: ' + (errors.length - real.length) + ')');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

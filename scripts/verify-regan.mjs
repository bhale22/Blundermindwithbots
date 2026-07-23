// Headless verification of the Regan closed-form Curve A (elo-degradation-brief.md).
// Needs the server running on :3100 (PORT=3100 node server.js). Run from repo root:
//   node scripts/verify-regan.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

// Reference D(s) for cross-checking page math
const D = (s) => 339 - 1442 * Math.pow(Math.max(0.05, s), -0.283);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// ── Panel ────────────────────────────────────────────────────────────────────
console.log('panel:');
await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

ok(await page.evaluate(() => curveAMode) === 'regan', 'default Curve A mode is regan');
ok(await page.evaluate(() => document.getElementById('cvA-mode-regan').classList.contains('active')), 'Regan button active');
ok(await page.evaluate(() => document.getElementById('ctrl-drop').style.pointerEvents) === 'none', 'Max ELO drop slider inert in Regan mode');
ok(await page.evaluate(() => document.getElementById('legA-dragItem').style.display) === 'none', 'drag-handle legend hidden in Regan mode');

// Default TC is 30+0 → anchor 30
ok(await page.evaluate(() => reganAnchorSec()) === 30, 'anchorSec = 30 for default 30+0');
const cfg0 = await page.evaluate(() => getBotConfig());
ok(cfg0.curveAMode === 'regan', 'config exports curveAMode regan');
ok(cfg0.reganA && cfg0.reganA.c === 339 && cfg0.reganA.k === 1442 && cfg0.reganA.alpha === 0.283 && cfg0.reganA.anchorSec === 30,
  'config exports reganA params + anchor');
ok(Array.isArray(cfg0.ctrlA) && cfg0.ctrlA.length >= 25, `ctrlA dense fallback sample (${cfg0.ctrlA.length} pts)`);

// Page math matches the reference formula (anchor 30, ELO 1500 default)
const elo1500 = await page.evaluate(() => [currentElo, reganEloA(30), reganEloA(5), reganEloA(1)]);
ok(elo1500[0] === 1500 && elo1500[1] === 1500, 'curve passes through E0 at anchor');
ok(elo1500[2] === Math.round(1500 + D(5) - D(30)), 'reganEloA(5) matches formula');
ok(elo1500[3] === Math.max(600, Math.round(1500 + D(1) - D(30))), 'reganEloA(1) matches formula');

// Time-control re-anchor
await page.evaluate(() => { tcTime = 15; tcInc = 0; initPtsA(); });
ok(await page.evaluate(() => reganAnchorSec()) === 15, 're-anchor: 15+0 → 15 s');
ok((await page.evaluate(() => getBotConfig())).reganA.anchorSec === 15, 'config anchor follows TC');
await page.evaluate(() => { tcTime = 5; tcInc = 3; });
ok(await page.evaluate(() => reganAnchorSec()) === 8, 're-anchor: 5+3 → 8 s (increment included)');
await page.evaluate(() => { tcTime = 0; tcInc = 0; });
ok(await page.evaluate(() => reganAnchorSec()) === 0, 'untimed → anchor 0');
ok((await page.evaluate(() => getBotConfig())).reganA.anchorSec === 0, 'untimed config anchor 0');
ok(await page.evaluate(() => reganEloA(1)) === 1500, 'untimed → flat at E0');
await page.evaluate(() => { tcTime = 30; tcInc = 0; initPtsA(); drawA(); });

// Custom mode restores the legacy spline
await page.evaluate(() => setCurveAMode('custom'));
ok(await page.evaluate(() => ctrlA.length) === 8, 'custom mode: 8 draggable points');
ok(await page.evaluate(() => document.getElementById('ctrl-drop').style.pointerEvents) === '', 'drop slider live in custom mode');
const cfgC = await page.evaluate(() => getBotConfig());
ok(cfgC.curveAMode === 'custom' && cfgC.reganA === null, 'custom config: no reganA');

// Round-trip: regan config restores regan mode; legacy config (ctrlA only) loads custom
await page.evaluate((c) => applyBotConfig(c), cfg0);
ok(await page.evaluate(() => curveAMode) === 'regan', 'round-trip restores regan mode');
ok(await page.evaluate(() => reganAnchorSec()) === 30, 'round-trip restores TC anchor');
await page.evaluate(() => applyBotConfig({ ctrlA: [{ x: 1, y: 900 }, { x: 1000, y: 1500 }], ctrlB: [] }));
ok(await page.evaluate(() => curveAMode) === 'custom', 'legacy config (spline, no mode field) loads as custom');
ok(await page.evaluate(() => ctrlA.length === 2 && ctrlA[0].y === 900), 'legacy spline points restored');

// ── Main app engine wiring ───────────────────────────────────────────────────
console.log('app:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const eng = await page.evaluate(() => {
  const out = {};
  botPressureReganA = { c: 339, k: 1442, alpha: 0.283, anchorSec: 15 };
  botPressureCurveA = [{ x: 0.1, y: 1500 }, { x: 1000, y: 1500 }]; // decoy — must be ignored
  const savedRating = maia3SelectedRating;
  maia3SelectedRating = 1500;
  out.atAnchor = pressureEffectiveMaiaEloByThink(15);
  out.at5 = pressureEffectiveMaiaEloByThink(5);
  out.at01 = pressureEffectiveMaiaEloByThink(0.1);
  out.slotHi = pressureSlotEloByThink(2400, 5);
  out.slotLo = pressureSlotEloByThink(1800, 5);
  botPressureReganA = null; botPressureCurveA = null;
  maia3SelectedRating = savedRating;
  return out;
});
ok(eng.atAnchor === 1500, 'engine: E0 at anchor');
ok(eng.at5 === 1256, 'engine: 1256 at 5 s (§4 vector)');
ok(eng.at01 === 600, 'engine: clamps to 600 floor at 0.1 s');
ok((2400 - eng.slotHi) === (1800 - eng.slotLo) && eng.slotHi < 2400, 'engine: identical slot drops');

// The app consumes configs via its window 'message' handler (type: 'botConfig')
const postCfg = async (extra) => {
  await page.evaluate((x) => {
    window.postMessage(Object.assign({ type: 'botConfig', engine: 'maia3', elo: 1500,
      ctrlA: [{ x: 1, y: 900 }, { x: 1000, y: 1500 }] }, x), location.origin);
  }, extra);
  await page.waitForTimeout(150);
  return page.evaluate(() => ({ regan: !!botPressureReganA, spline: !!botPressureCurveA }));
};
const r1 = await postCfg({ curveAMode: 'regan', reganA: { c: 339, k: 1442, alpha: 0.283, anchorSec: 15 }, pressureOffA: false });
const r2 = await postCfg({ curveAMode: 'regan', reganA: { c: 339, k: 1442, alpha: 0.283, anchorSec: 0 }, pressureOffA: false });
const r3 = await postCfg({ curveAMode: 'regan', reganA: { c: 339, k: 1442, alpha: 0.283, anchorSec: 15 }, pressureOffA: true });
const r4 = await postCfg({ pressureOffA: false });   // legacy config: spline only
await page.evaluate(() => { botPressureReganA = null; botPressureCurveA = null; });
const applied = { r1, r2, r3, r4 };
ok(applied.r1.regan === true && applied.r1.spline === false, 'botConfig msg: regan set, ctrlA fallback not shadowing');
ok(applied.r2.regan === false && applied.r2.spline === false, 'botConfig msg: untimed regan → no ELO degradation');
ok(applied.r3.regan === false, 'botConfig msg: pressureOffA disables regan');
ok(applied.r4.regan === false && applied.r4.spline === true, 'botConfig msg: legacy spline config still honoured');

ok(errors.length === 0, 'no console/page errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

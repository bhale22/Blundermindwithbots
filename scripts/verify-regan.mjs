// Headless verification of Curve A: draggable spline seeded on the Regan
// time–rating model, with Android-style on/off toggles (no mode buttons).
// Needs the server running on :3100 (PORT=3100 node server.js). Run from repo root:
//   node scripts/verify-regan.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

// Reference model for cross-checking seeded values
const D = (s) => 339 - 1442 * Math.pow(Math.max(0.05, s), -0.283);
const model = (e0, anchor, t) => Math.max(600, Math.min(e0, Math.round(e0 + D(t) - D(anchor))));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

// ── Panel ────────────────────────────────────────────────────────────────────
console.log('panel:');
await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

ok(await page.evaluate(() => document.getElementById('cvA-mode-regan') === null &&
  document.getElementById('r-drop') === null), 'mode buttons and Max ELO drop slider are gone');
ok(await page.evaluate(() => {
  const a = document.getElementById('pressure-off-a'), b = document.getElementById('pressure-off-b');
  return a && b && a.type === 'checkbox' && b.type === 'checkbox' && a.checked && b.checked &&
    a.closest('label')?.classList.contains('tog') && b.closest('label')?.classList.contains('tog');
}), 'on/off controls are .tog switches, both ON by default');

// Seeding: default TC 30+0 → anchor 30; knot exactly at the anchor, all on model
const seed = await page.evaluate(() => ({ anchor: reganAnchorSec(), elo: currentElo,
  pts: ctrlA.map(p => ({ x: p.x, y: p.y })) }));
ok(seed.anchor === 30, 'anchorSec = 30 for default 30+0');
ok(seed.pts.length === 8, '8 draggable knots');
ok(seed.pts.some(p => Math.abs(p.x - 30) < 0.01), 'one knot sits exactly at the anchor');
ok(seed.pts.every(p => Math.abs(p.y - model(seed.elo, seed.anchor, p.x)) <= 1), 'every knot lies on the Regan curve');
ok(seed.pts.filter(p => p.x >= seed.anchor).every(p => p.y === seed.elo), 'flat at E0 above the anchor');
// Fastest knot is the 1 s chart edge; with a 30 s anchor the model there is ~609
// (the 600 floor is only reached below the chart's right edge — expected).
ok(seed.pts.some(p => p.x === 1 && p.y < 650), 'curve dives toward the floor at the fast (1 s) edge');

// TC re-anchor: 5+3 → 8 s
await page.evaluate(() => { tcTime = 5; tcInc = 3; initPtsA(); });
ok(await page.evaluate(() => ctrlA.some(p => Math.abs(p.x - 8) < 0.01)), 're-anchor: 5+3 puts a knot at 8 s');
await page.evaluate(() => { tcTime = 0; tcInc = 0; initPtsA(); });
ok(await page.evaluate(() => ctrlA.every(p => p.y === Math.min(currentElo, 2600))), 'untimed → flat at E0');
await page.evaluate(() => { tcTime = 30; tcInc = 0; initPtsA(); drawA(); });

// Toggle behaviour: the .tog switch drives _setPressureOffA (its onchange).
// Switching A off flattens + dims; back on re-seeds. Also confirm the visible
// track/thumb reflect the checkbox state (Android-style switch).
await page.evaluate(() => toggleSec('pressure'));
await page.waitForTimeout(700);
await page.evaluate(() => { const cb = document.getElementById('pressure-off-a'); cb.checked = false; cb.onchange(); });
await page.waitForTimeout(150);
const offState = await page.evaluate(() => ({
  off: pressureOffA, checked: document.getElementById('pressure-off-a').checked,
  flat: ctrlA.every(p => p.y === Math.min(currentElo, 2600)),
  dim: document.querySelector('#tp-col-a .chart-box').style.opacity === '0.45',
  chip: document.getElementById('st-pressure').textContent,
  // In CSS the track goes amber and the thumb slides right only when :checked
  trackChecked: getComputedStyle(document.querySelector('#pressure-off-a ~ .tog-track')).borderColor,
}));
ok(offState.off && !offState.checked, 'switch off → pressureOffA true, thumb left');
ok(offState.flat, 'off → curve flat at E0');
ok(offState.dim, 'off → chart dimmed');
ok(offState.chip === 'Dist only', 'status chip: Dist only');
await page.evaluate(() => { const cb = document.getElementById('pressure-off-a'); cb.checked = true; cb.onchange(); });
await page.waitForTimeout(150);
ok(await page.evaluate(() => !pressureOffA && ctrlA.some(p => p.x === 1 && p.y < 650)), 'switch on → Regan seed restored');

// Real mouse drag on cvA (no lock anymore): drag a mid-dive knot downward.
// Pick a knot below the anchor so it has headroom to move (the anchor knot is
// pinned at E0's top). Compute pixel coords the same way setupDrag's nearest()
// does, so the hit test lands on the knot.
await page.evaluate(() => document.getElementById('cvA').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(150);
const dragged = await page.evaluate(() => {
  const cv = document.getElementById('cvA');
  const r = cv.getBoundingClientRect();
  const w = cv.clientWidth;
  const xp = makeXp(scaleA, w);
  const i = ctrlA.findIndex(p => p.x > 3 && p.x < 12); // a knot in the dive
  const mn = 540, mx = currentElo + 50;
  const PAD_T = 14, CH = 150, PAD_B = 44;
  const py = PAD_T + (mx - ctrlA[i].y) / (mx - mn) * (CH - PAD_T - PAD_B);
  return { idx: i, sx: r.left + xp(ctrlA[i].x), sy: r.top + py, yBefore: ctrlA[i].y };
});
await page.mouse.move(dragged.sx, dragged.sy);
await page.mouse.down();
await page.mouse.move(dragged.sx, dragged.sy + 20, { steps: 5 });
await page.mouse.up();
const yAfter = await page.evaluate((i) => ctrlA[i].y, dragged.idx);
ok(yAfter < dragged.yBefore, `knots are draggable (y ${dragged.yBefore} → ${yAfter})`);

// Config: ctrlA + curve-implied max drop; no closed-form fields
const cfg = await page.evaluate(() => getBotConfig());
ok(cfg.curveAMode === undefined && cfg.reganA === undefined, 'closed-form config fields removed');
ok(cfg.ctrlA.length === 8, 'config carries the 8 spline points');
const minY = Math.min(...cfg.ctrlA.map(p => p.y));
ok(cfg.timePressureMaxDrop === Math.max(0, Math.round(cfg.elo - minY)), 'timePressureMaxDrop = E0 − curve minimum');

// Round-trip: dragged curve survives save/load
await page.evaluate((c) => applyBotConfig(c), cfg);
const rt = await page.evaluate((i) => ctrlA[i].y, dragged.idx);
ok(rt === yAfter, 'round-trip restores the dragged curve');

// ── Main app engine wiring (spline authoritative) ────────────────────────────
console.log('app:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const postCfg = async (extra) => {
  await page.evaluate((x) => {
    window.postMessage(Object.assign({ type: 'botConfig', engine: 'maia3', elo: 1500 }, x), location.origin);
  }, extra);
  await page.waitForTimeout(150);
};
const seedPts = [];
{ // mirror the panel seeding for 1500 @ 15+0
  const anchor = 15, steps = 5, r = Math.pow(1 / anchor, 1 / (steps + 1));
  const xs = [1000, anchor];
  for (let k = 1; k <= steps; k++) xs.push(anchor * Math.pow(r, k));
  xs.push(1);
  for (const x of xs) seedPts.push({ x: +x.toFixed(3), y: model(1500, 15, x) });
}
await postCfg({ ctrlA: seedPts, pressureOffA: false });
const eng = await page.evaluate(() => {
  const saved = maia3SelectedRating; maia3SelectedRating = 1500;
  const out = {
    atAnchor: pressureEffectiveMaiaEloByThink(15),
    at5: pressureEffectiveMaiaEloByThink(5),
    at1: pressureEffectiveMaiaEloByThink(1),
    slotHi: pressureSlotEloByThink(2400, 5),
    slotLo: pressureSlotEloByThink(1800, 5),
  };
  maia3SelectedRating = saved;
  return out;
});
ok(eng.atAnchor === 1500, 'engine: E0 at the anchor knot');
ok(Math.abs(eng.at5 - model(1500, 15, 5)) <= 6, `engine: ≈model at 5 s (${eng.at5})`);
ok(Math.abs(eng.at1 - model(1500, 15, 1)) <= 6, `engine: ≈model at 1 s (${eng.at1})`);
ok((2400 - eng.slotHi) === (1800 - eng.slotLo) && eng.slotHi < 2400, 'engine: identical slot drops');

await postCfg({ ctrlA: seedPts, pressureOffA: true });
ok(await page.evaluate(() => botPressureCurveA === null), 'pressureOffA → no ELO degradation curve');

ok(errors.length === 0, 'no console/page errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

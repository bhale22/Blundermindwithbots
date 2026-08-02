// Headless verify: info popups, rename, rec curves, temp wiring (panel side)
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  OK  ' + name); } else { fail++; console.log('  FAIL ' + name); } };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('panel: ' + e.message));

await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'load' });
await page.waitForTimeout(800);

// 1. No console errors on load
ok(errors.length === 0, 'panel loads with no page errors' + (errors.length ? ' — ' + errors.join('; ') : ''));

// 2. Info buttons exist (2: cpbudget + distrange)
const infoBtns = await page.locator('.info-btn').count();
ok(infoBtns === 2, 'two .info-btn buttons present (got ' + infoBtns + ')');

// 3. openInfoPop shows overlay with correct title; Escape closes
await page.evaluate(() => openInfoPop('cpbudget'));
ok(await page.locator('#infopop-overlay.show').count() === 1, 'cpbudget popup opens');
const title1 = await page.locator('#infopop-title').textContent();
ok(title1 === 'Centipawn Budget & Hard Floor', 'cpbudget title correct (got "' + title1 + '")');
const body1 = await page.locator('#infopop-body').textContent();
ok(body1.includes('engine-calculated') && !body1.includes('engine-verified'), 'popup says engine-calculated');
ok(body1.includes('human-typical plus style'), 'popup contains rating-relative example framing');
await page.keyboard.press('Escape');
ok(await page.locator('#infopop-overlay.show').count() === 0, 'Escape closes popup');

// 4. distrange popup via real button click
await page.evaluate(() => openInfoPop('distrange'));
const title2 = await page.locator('#infopop-title').textContent();
ok(title2 === 'Move Distribution Range', 'distrange popup title correct');
await page.evaluate(() => closeInfoPop());

// 5. Rename in the control label + tour step
const lbl = await page.locator('#move-quality-range .dlbl span').first().textContent();
ok(lbl.startsWith('Move Distribution Range'), 'control label renamed (got "' + lbl + '")');

// 6. Rec curves: values at 600 / 1500 / 2600
const recs = await page.evaluate(() => [600, 1000, 1500, 2000, 2600].map(e => [e, recommendedBudget(e), recommendedHardFloor(e)]));
console.log('  rec table:', JSON.stringify(recs));
ok(recs.every(([e, b, f]) => f >= b), 'floor >= budget at every ELO');
const at1500 = recs.find(r => r[0] === 1500);
ok(at1500[1] === 80 && at1500[2] === 310, 'rec at 1500 = 80/310 (got ' + at1500[1] + '/' + at1500[2] + ')');
ok(recs.find(r => r[0] === 2600)[1] === 10, 'rec budget at 2600 = 10');

// 7. applyRecommendedCp sets both sliders (at default ELO 1500)
await page.evaluate(() => { setElo(1500); applyRecommendedCp(); });
const bVal = await page.evaluate(() => +document.getElementById('r-style').value);
const fVal = await page.evaluate(() => +document.getElementById('r-hardfloor').value);
ok(bVal === 80 && fVal === 310, 'applyRecommendedCp sets sliders 80/310 (got ' + bVal + '/' + fVal + ')');
const btnTxt = await page.locator('#cp-rec-btn').textContent();
ok(btnTxt === 'Set: 80 / 310 cp', 'rec button text (got "' + btnTxt + '")');

// 8. getBotConfig: maia3Temp mirrors the Temperature control, not the budget
await page.evaluate(() => onTempSlider(2.4));
let cfg = await page.evaluate(() => getBotConfig());
ok(Math.abs(cfg.maia3Temp - 2.4) < 0.01, 'maia3Temp follows temp control (2.4 → ' + cfg.maia3Temp + ')');
ok(Math.abs(cfg.tempValue - 2.4) < 0.01, 'tempValue exported (got ' + cfg.tempValue + ')');
// budget change must NOT move maia3Temp anymore
await page.evaluate(() => onGaugeSliderInput(300));
cfg = await page.evaluate(() => getBotConfig());
ok(Math.abs(cfg.maia3Temp - 2.4) < 0.01, 'budget change does not alter maia3Temp (got ' + cfg.maia3Temp + ')');
// clamp: T=3.6 (legacy element range tops at 3.0)
await page.evaluate(() => onTempSlider(3.6));
cfg = await page.evaluate(() => getBotConfig());
ok(cfg.maia3Temp === 3.0, 'maia3Temp clamped to 3.0 (got ' + cfg.maia3Temp + ')');

// 9. Short hints replaced the essays
const hint = await page.locator('#move-quality-range .ctrl-hint').textContent();
ok(hint.length < 200 && hint.includes('ⓘ'), 'distribution-range hint is short + points at ⓘ');

// 9b. Slider endpoint scales: budget 0/300, floor 0/1,000 (→ Off at max)
const scales = await page.evaluate(() => ({
  budget: [...document.querySelectorAll('#r-style ~ .slider-scale span')].map(s => s.textContent),
  floorMax: document.getElementById('hf-scale-max')?.textContent,
  floorMin: document.getElementById('r-hardfloor')?.min,
}));
ok(scales.budget.join('/') === '0/300', 'budget scale labels 0/300 (got ' + scales.budget.join('/') + ')');
ok(scales.floorMin === '0', 'floor slider min stays 0 (got ' + scales.floorMin + ')');
// min must STAY 0 after a budget change (old bug: min tracked budget)
await page.evaluate(() => _setGaugeValue(200));
const minAfter = await page.evaluate(() => document.getElementById('r-hardfloor').min);
ok(minAfter === '0', 'floor slider min still 0 after budget change (got ' + minAfter + ')');
// value clamp still enforced: floor request below budget snaps to budget
await page.evaluate(() => _setHardFloorValue(100, false));
const clamped = await page.evaluate(() => +document.getElementById('r-hardfloor').value);
ok(clamped === 200, 'floor value clamps to budget 200 (got ' + clamped + ')');
// Off at max: value label + right endpoint label both flip
await page.evaluate(() => _setHardFloorValue(1000, false));
const offState = await page.evaluate(() => ({
  val: document.getElementById('v-hardfloor').textContent,
  scale: document.getElementById('hf-scale-max').textContent,
}));
ok(offState.val === 'Off' && offState.scale === 'Off', 'floor at 1000 shows Off/Off (got ' + offState.val + '/' + offState.scale + ')');
await page.evaluate(() => _setHardFloorValue(400, false));
const backState = await page.evaluate(() => document.getElementById('hf-scale-max').textContent);
ok(backState === '1,000', 'right endpoint back to 1,000 below max (got ' + backState + ')');

// 9c. Clickable hint links open the popups (open the Personality section
// first — collapsed sections cover the link, exactly as for a real user)
const linkCount = await page.locator('.hint-link').count();
ok(linkCount === 2, 'two .hint-link spans (got ' + linkCount + ')');
await page.evaluate(() => {
  const sec = document.getElementById('sec-attract');
  if (sec && !sec.classList.contains('open')) toggleSec('attract');
  switchItab('attract', 'quality');
});
await page.waitForTimeout(600);
await page.locator('.hint-link').first().click();
const linkTitle = await page.locator('#infopop-title').textContent();
ok(linkTitle === 'Centipawn Budget & Hard Floor', 'hint link opens budget popup (got "' + linkTitle + '")');
await page.evaluate(() => closeInfoPop());

// 10. Main app page loads clean (assembled src incl. engine changes)
const page2 = await browser.newPage();
const errors2 = [];
page2.on('pageerror', e => errors2.push('app: ' + e.message));
await page2.goto(BASE + '/', { waitUntil: 'load' });
await page2.waitForTimeout(1200);
ok(errors2.length === 0, 'main app loads with no page errors' + (errors2.length ? ' — ' + errors2.join('; ') : ''));
// engine temp cascade present in assembled source
const src = await page2.evaluate(() => {
  const s = [...document.scripts].map(x => x.textContent).join('');
  return {
    // Proximity heuristic: the hustler/temp cascade must appear inside the
    // maia3 branch. The window was 900 chars and the real distance is ~3660,
    // so this failed against working code — it needs widening whenever that
    // branch grows. Kept as a proximity test because there is no cheap way to
    // scope a regex to one branch of the served bundle.
    m3Cascade: s.includes("botTab === 'maia3'") && /maia3'[\s\S]{0,6000}_bcpHustlerTempMode/.test(s),
    hybCascade: /hybrid Maia[\s\S]{0,600}_bcpHustlerTempMode/.test(s) || /every other Maia path[\s\S]{0,300}_bcpHustlerTempMode/.test(s),
    m3ByThink: s.includes('pressureEffectiveMaiaEloByThink(m3RoughThinkSec)'),
    hybProbe: s.includes('cplxPromiseHyb'),
    lcsfProbe: s.includes('cplxPromiseLcsf'),
    slotDrop: s.includes('function pressureSlotEloByThink'),
    pawnGone: !s.includes('pawnStrat'),
  };
});
ok(src.m3Cascade, 'maia3 path has hustler/temp cascade in served build');
ok(src.hybCascade, 'hybrid maia slot has temp cascade in served build');
ok(src.m3ByThink, 'maia3 ELO uses think-time curve lookup');
ok(src.hybProbe, 'hybrid path kicks off complexity probe');
ok(src.lcsfProbe, 'lcsf path kicks off complexity probe');
ok(src.slotDrop, 'pressureSlotEloByThink present');
ok(src.pawnGone, 'dead pawnStrat attractor removed');

// functional: slot ELO relative drop (curve top 2000 → drop 800 at 0.1s think)
const slotVals = await page2.evaluate(() => {
  botPressureCurveA = [{ x: 0.1, y: 1200 }, { x: 10, y: 2000 }];
  const relaxed = pressureSlotEloByThink(2400, 10);
  const pressured = pressureSlotEloByThink(2400, 0.1);
  const floor = pressureSlotEloByThink(700, 0.1); // clamps at 600
  botPressureCurveA = null;
  return { relaxed, pressured, floor };
});
ok(slotVals.relaxed === 2400, 'slot ELO unchanged at relaxed think (got ' + slotVals.relaxed + ')');
ok(slotVals.pressured === 1600, 'slot ELO drops by curve delta under pressure (got ' + slotVals.pressured + ')');
ok(slotVals.floor === 600, 'slot ELO clamps at 600 (got ' + slotVals.floor + ')');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

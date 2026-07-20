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
    m3Cascade: s.includes("botTab === 'maia3'") && /maia3'[\s\S]{0,900}_bcpHustlerTempMode/.test(s),
    hybCascade: /hybrid Maia[\s\S]{0,600}_bcpHustlerTempMode/.test(s) || /every other Maia path[\s\S]{0,300}_bcpHustlerTempMode/.test(s),
  };
});
ok(src.m3Cascade, 'maia3 path has hustler/temp cascade in served build');
ok(src.hybCascade, 'hybrid maia slot has temp cascade in served build');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

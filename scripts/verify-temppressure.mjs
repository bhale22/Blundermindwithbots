// Time-pressure sampling-temperature controls. Server on :3100, run from the
// repo root:  node scripts/verify-temppressure.mjs
//
//  1 Max temp slider is 0–8 in 0.1 steps (0 reachable; T 0.8 selectable)
//  2 the y-axis lands on 3–5 labelled gridlines instead of one
//  3 the game-start temperature is marked on the slider, in the right place
//  4 taking the ceiling below base temp is safe — no zero-height y-range,
//    no NaN, and the hint says escalation is off
//  5 old bots saved on the 1–15 slider still load
// plus a phone block: the mark tracks the larger phone thumb and stays visible.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

async function panel(width, height, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const o = document.getElementById('botTourOverlay'); if (o) o.style.display = 'none';
    const el = document.getElementById('sec-pressure');
    if (el && !el.classList.contains('open')) toggleSec('pressure');
  });
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}

// Mirrors drawCurve's label loop so the assertion is about what gets drawn.
const labelCount = (page, yMin, yMax) => page.evaluate(([mn, mx]) => {
  const step = _niceStep(mx - mn, 4);
  const start = Math.ceil(mn / step) * step;
  let n = 0;
  for (let i = 0; start + i * step <= mx + 1e-9; i++) n++;
  return n;
}, [yMin, yMax]);

console.log('\nDesktop — 1440x900');
{
  const { ctx, page, errs } = await panel(1440, 900, false);

  const r = await page.evaluate(() => {
    const i = document.getElementById('r-maxtemp');
    return i ? { min: i.min, max: i.max, step: i.step, val: i.value } : null;
  });
  ok('Max temp slider exists', !!r);
  ok('min is 0', r && r.min === '0', r && r.min);
  ok('max is 8', r && r.max === '8', r && r.max);
  ok('step 0.1 makes T 0.8 selectable', r && r.step === '0.1', r && r.step);

  // 2 — y-axis density across the ranges these charts actually produce.
  const spans = [
    ['temp, default ceiling 8', 0.5, 8.5],
    ['temp, low ceiling 2',     0.5, 2.5],
    ['temp, ceiling under t0',  0.5, 1.5],
    ['ELO, full 2000 drop',     540, 2650],
    ['ELO, no drop',            1440, 1550],
  ];
  for (const [name, mn, mx] of spans) {
    const n = await labelCount(page, mn, mx);
    ok(`${name}: ${n} gridlines (3–5)`, n >= 3 && n <= 5, String(n));
  }

  // 3 — the mark sits at the game-start temperature.
  await page.evaluate(() => onTempSlider(2.0));
  await page.waitForTimeout(250);
  const mk = await page.evaluate(() => {
    const t = document.getElementById('maxtemp-track');
    const m = document.querySelector('#maxtemp-track .rng-mark');
    const i = document.getElementById('r-maxtemp');
    const tb = t.getBoundingClientRect(), mb = m.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(t).getPropertyValue('--thumb-w'));
    const frac = (2.0 - +i.min) / (+i.max - +i.min);
    return {
      cssFrac: parseFloat(getComputedStyle(t).getPropertyValue('--mk')),
      expectFrac: frac,
      markCx: mb.left + mb.width / 2,
      expectCx: tb.left + thumb / 2 + frac * (tb.width - thumb),
      visible: mb.width > 0 && mb.height > 0,
      title: t.title,
    };
  });
  ok('--mk matches the base temperature', Math.abs(mk.cssFrac - mk.expectFrac) < 0.001,
     `${mk.cssFrac} vs ${mk.expectFrac}`);
  ok('mark is rendered', mk.visible);
  ok('mark is drawn at the right pixel (thumb inset accounted for)',
     Math.abs(mk.markCx - mk.expectCx) < 1.5,
     `${mk.markCx.toFixed(1)} vs ${mk.expectCx.toFixed(1)}`);
  ok('mark carries the value in its tooltip', /T 2\.0/.test(mk.title), mk.title);

  // 4 — ceiling below base temp must not produce a degenerate range.
  await page.evaluate(() => { const i = document.getElementById('r-maxtemp');
    i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(300);
  const low = await page.evaluate(() => {
    const t0 = Math.max(0.1, +_currentTempValue || 1.0);
    const yMax = effTempCeiling() + 0.5, yMin = Math.max(0, t0 - 0.5);
    const cv = document.getElementById('cvB');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
    return { yMin, yMax, span: yMax - yMin, lit,
             hint: document.getElementById('maxtemp-hint').textContent,
             readout: document.getElementById('v-maxtemp').textContent };
  });
  ok('y-range stays positive with ceiling 0', low.span > 0, 'span ' + low.span);
  ok('y-range is finite', Number.isFinite(low.span) && Number.isFinite(low.yMin));
  ok('curve B still renders pixels', low.lit > 500, 'lit ' + low.lit);
  ok('readout shows T 0.0', /T 0\.0/.test(low.readout), low.readout);
  ok('hint explains escalation is off', /effectively off/i.test(low.hint), low.hint);

  // T 0.8 is the value the old 0.5 step could not express.
  await page.evaluate(() => { const i = document.getElementById('r-maxtemp');
    i.value = '0.8'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  ok('T 0.8 is settable',
     await page.evaluate(() => document.getElementById('r-maxtemp').value === '0.8'));

  // 5 — a bot saved on the old 1–15 slider.
  const legacy = await page.evaluate(() => {
    _setRange('r-maxtemp', Math.max(0, Math.min(8, 15)));
    return document.getElementById('r-maxtemp').value;
  });
  ok('legacy maxTemp 15 clamps to 8', legacy === '8', legacy);

  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nPhone — 390x844');
{
  const { ctx, page, errs } = await panel(390, 844, true);
  await page.evaluate(() => onTempSlider(1.5));
  await page.waitForTimeout(300);
  const p = await page.evaluate(() => {
    const t = document.getElementById('maxtemp-track');
    const m = document.querySelector('#maxtemp-track .rng-mark');
    const i = document.getElementById('r-maxtemp');
    const tb = t.getBoundingClientRect(), mb = m.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(t).getPropertyValue('--thumb-w'));
    const frac = (1.5 - +i.min) / (+i.max - +i.min);
    return { thumb, markH: mb.height,
             markCx: mb.left + mb.width / 2,
             expectCx: tb.left + thumb / 2 + frac * (tb.width - thumb),
             inputH: i.getBoundingClientRect().height,
             hintPx: parseFloat(getComputedStyle(document.getElementById('maxtemp-hint')).fontSize) };
  });
  ok('--thumb-w tracks the 17px phone thumb', p.thumb === 17, String(p.thumb));
  ok('mark is drawn at the right pixel on phone', Math.abs(p.markCx - p.expectCx) < 1.5,
     `${p.markCx.toFixed(1)} vs ${p.expectCx.toFixed(1)}`);
  ok('mark is tall enough to see over the track', p.markH >= 20, String(p.markH));
  ok('slider is still a 44px target', p.inputH >= 42, String(p.inputH));
  ok('hint respects the 11px type floor', p.hintPx >= 11, String(p.hintPx));
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

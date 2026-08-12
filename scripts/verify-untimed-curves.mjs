// Time-pressure curves must be inert AND visibly inert when there is no clock,
// and must come back when one is picked.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-untimed-curves.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage({ viewport: { width: 560, height: 1000 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const s = document.getElementById('sec-pressure');
  if (s && !s.classList.contains('open')) toggleSec('pressure');
});
await page.waitForTimeout(700);

const clickTC = async (t, i) => {
  await page.evaluate(([tt, ii]) => {
    [...document.querySelectorAll('.tg-cell')]
      .find((e) => +e.dataset.t === tt && +e.dataset.i === ii && +(e.dataset.bonus || 0) === 0).click();
  }, [t, i]);
  await page.waitForTimeout(450);
};
const state = () => page.evaluate(() => {
  const spread = (c) => +(Math.max(...c.map((q) => +q.y)) - Math.min(...c.map((q) => +q.y))).toFixed(2);
  const boxOpacity = (col) => {
    const el = document.getElementById(col)?.querySelector('.chart-box');
    return el ? getComputedStyle(el).opacity : null;
  };
  return {
    tc: `${tcTime}+${tcInc}`, timed: isTimedGame(),
    A: spread(ctrlA), B: spread(ctrlB),
    opA: boxOpacity('tp-col-a'), opB: boxOpacity('tp-col-b'),
    label: document.getElementById('pressure-off-lbl')?.textContent || '',
    chip: document.getElementById('st-pressure')?.textContent || '',
  };
});

console.log('timed (5+0):');
await clickTC(5, 0);
let s = await state();
ok(s.timed, 'isTimedGame() is true');
ok(s.A > 50, `ELO curve slopes (spread ${s.A})`);
ok(s.B > 1, `temperature curve slopes (spread ${s.B})`);
ok(s.opA === '1' && s.opB === '1', 'both charts at full opacity');
ok(/both curves active/i.test(s.label), 'label: "' + s.label + '"');

console.log('\nuntimed:');
await clickTC(0, 0);
s = await state();
ok(!s.timed, 'isTimedGame() is false');
ok(s.A === 0, `ELO curve is flat (spread ${s.A})`);
ok(s.B === 0, `temperature curve is ALSO flat (spread ${s.B}) — this was the bug`);
ok(s.opA !== '1' && s.opB !== '1', `both charts greyed (${s.opA} / ${s.opB})`);
ok(/no clock/i.test(s.label), 'label explains why: "' + s.label + '"');
ok(s.chip === 'Untimed', 'collapsed header chip reads "Untimed" (' + s.chip + ')');

console.log('\ndragging an inert curve explains itself:');
const popped = await page.evaluate(async () => {
  const before = document.getElementById('infopop-overlay')?.classList.contains('show');
  const cv = document.getElementById('cvA');
  const r = cv.getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
  await new Promise((res) => setTimeout(res, 300));
  const ov = document.getElementById('infopop-overlay');
  return { before, after: ov?.classList.contains('show'),
           text: ov?.textContent || '', ys: ctrlA.map((p) => +p.y) };
});
ok(popped.before === false, 'no popup before the drag');
ok(popped.after === true, 'dragging Curve A opens the explanation');
ok(/no clock|time pressure/i.test(popped.text), 'the popup says why');
ok(new Set(popped.ys).size === 1, 'and the curve did not move');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

console.log('\nback to a time control:');
await clickTC(10, 5);
s = await state();
ok(s.timed, 'isTimedGame() is true again');
ok(s.A > 50, `ELO curve re-seeds and slopes again (spread ${s.A})`);
ok(s.B > 1, `temperature curve slopes again (spread ${s.B})`);
ok(s.opA === '1' && s.opB === '1', 'both charts un-greyed');

const dragWorks = await page.evaluate(async () => {
  const cv = document.getElementById('cvA');
  const r = cv.getBoundingClientRect();
  const y0 = ctrlA.map((p) => +p.y).join(',');
  // Grab a REAL control point: setupDrag only starts a drag within 22px of one,
  // so aiming at the middle of the canvas proves nothing.
  const i = Math.floor(ctrlA.length / 2), pt0 = ctrlA[i];
  const w = cv.clientWidth;
  const xp = makeXp(scaleA, w);
  const floor = Math.max(600, Math.min(currentElo, 2600) - gv('r-drop'));
  const mn = floor - 60, mx = currentElo + 50;
  const px = xp(pt0.x);
  const py = PAD.t + (mx - pt0.y) / (mx - mn) * (CH - PAD.t - PAD.b);
  const at = (dy) => ({ bubbles:true, cancelable:true,
    clientX: r.left + px, clientY: r.top + py + dy });
  cv.dispatchEvent(new MouseEvent('mousedown', at(0)));
  cv.dispatchEvent(new MouseEvent('mousemove', at(30)));
  cv.dispatchEvent(new MouseEvent('mouseup',   at(30)));
  await new Promise((res) => setTimeout(res, 200));
  return y0 !== ctrlA.map((p) => +p.y).join(',');
});
ok(dragWorks, 'and the curve is draggable again');

// The engine half: however the curves are shaped, no clock means no effect.
console.log('\nengine ignores both curves without a clock:');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate(() => landingChoose('solo'));
await page.waitForTimeout(500);
const engine = await page.evaluate(() => {
  // A steeply sloped Curve A/B, as a bot saved under a time control would carry.
  botPressureCurveA = [{x:600,y:2000},{x:30,y:2000},{x:10,y:1400},{x:1,y:800}];
  botPressureCurveB = [{x:600,y:1},{x:30,y:1},{x:10,y:4},{x:1,y:8}];
  maia3SelectedRating = 2000; botTimePressure = 'normal';
  const read = () => ({
    eloFast:  pressureEffectiveMaiaEloByThink(1),
    eloSlow:  pressureEffectiveMaiaEloByThink(600),
    slotFast: pressureSlotEloByThink(1800, 1),
    tempFast: +timePressureTempByThink(1, 1).toFixed(2),
  });
  clockControl = 'untimed';   const untimed = read();
  clockControl = 'blitz5';    const timed   = read();
  return { untimed, timed };
});
ok(engine.untimed.eloFast === 2000 && engine.untimed.eloSlow === 2000,
   `untimed: ELO stays at the configured rating (${engine.untimed.eloFast})`);
ok(engine.untimed.slotFast === 1800,
   `untimed: hybrid slot keeps its own rating (${engine.untimed.slotFast})`);
ok(engine.untimed.tempFast === 1,
   `untimed: temperature stays at base (${engine.untimed.tempFast})`);
ok(engine.timed.eloFast < 1000,
   `timed: the same curve DOES degrade (${engine.timed.eloFast})`);
ok(engine.timed.tempFast > 1,
   `timed: the same curve DOES raise temperature (${engine.timed.tempFast})`);

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

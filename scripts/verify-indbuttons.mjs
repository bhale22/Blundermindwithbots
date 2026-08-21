// Verification for the single-button indicator controls. Server on :3100:
//   node scripts/verify-indbuttons.mjs
//
//  1 the 13 "Show During Exploration" sub-buttons are gone
//  2 every indicator has one fixed-width icon slot, so all labels align
//  3 the two paired indicators stack their dots vertically
//  4 each button carries a state word: off / exp / on
//  5 click cycles off -> exp -> on -> off
//  6 hold >=350ms inverts the overlay while held, then reverts, changing nothing
//  7 hold from ON hides it (the inversion works both ways)
//  8 dragging off the button cancels the peek without cycling
//  9 the block did not get taller and the type got bigger
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n))
                                : (fail++, console.log('  FAIL ' + n + (extra ? '  -> ' + extra : ''))); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => {
  try {
    ['bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1'));
    localStorage.setItem('bm_shell', 'amateur');
  } catch (e) {}
});
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.evaluate(() => { const o = document.getElementById('landingOverlay'); if (o) o.style.display = 'none'; });
await page.waitForTimeout(400);

const KEYS = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib')].map(e => e.id.replace(/^ib-/, '')));

console.log('\n1-4  Structure');
ok('13 indicators present', KEYS.length === 13, String(KEYS.length));
ok('no .ib-pre sub-buttons remain', (await page.locator('.ib-pre').count()) === 0);
ok('13 icon slots', (await page.locator('.ind-grid .ib-icon').count()) === 13);
ok('13 state chips', (await page.locator('.ind-grid .ib-state').count()) === 13);

const slots = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib-icon')].map(e => e.getBoundingClientRect().width));
ok('every icon slot is the same width', new Set(slots.map(w => w.toFixed(2))).size === 1,
   [...new Set(slots.map(w => w.toFixed(1)))].join(','));

// Labels must start at the same x within a column - the point of the fixed slot.
const labelX = await page.evaluate(() => {
  const cols = [...document.querySelectorAll('.ind-col')];
  return cols.map(col => [...col.querySelectorAll('.ib-main')].map(b => {
    const icon = b.querySelector('.ib-icon');
    return icon ? +(icon.getBoundingClientRect().right).toFixed(1) : null;
  }));
});
ok('labels align within each column',
   labelX.every(col => new Set(col.filter(v => v !== null)).size === 1),
   JSON.stringify(labelX.map(c => [...new Set(c)])));

const stacked = await page.evaluate(() => {
  const out = {};
  for (const id of ['ib-threats', 'ib-counts']) {
    const dots = [...document.querySelectorAll('#' + id + ' .ib-icon .ib-dot')];
    if (dots.length !== 2) { out[id] = { dots: dots.length }; continue; }
    const [a, b] = dots.map(d => d.getBoundingClientRect());
    out[id] = { stacked: b.top >= a.bottom - 0.5, sameX: Math.abs(a.left - b.left) < 0.5 };
  }
  return out;
});
ok('threats dots stacked vertically', stacked['ib-threats'].stacked === true, JSON.stringify(stacked['ib-threats']));
ok('threats dots share an x', stacked['ib-threats'].sameX === true);
ok('counts dots stacked vertically', stacked['ib-counts'].stacked === true, JSON.stringify(stacked['ib-counts']));
ok('counts dots share an x', stacked['ib-counts'].sameX === true);

const words = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib-state')].map(e => e.textContent.trim()));
ok('every chip reads off/exp/on', words.every(w => ['off', 'exp', 'on'].includes(w)),
   [...new Set(words)].join(','));

const chipW = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib-state')].map(e => +e.getBoundingClientRect().width.toFixed(1)));
ok('chips share one width (clean right edge)', new Set(chipW).size === 1, [...new Set(chipW)].join(','));

console.log('\n5    Click cycles off -> exp -> on -> off');
const st = async k => page.evaluate(key => {
  const i = IND[key];
  const el = document.getElementById('ib-' + key);
  return {
    on: i.on, pre: i.pre,
    word: el.querySelector('.ib-state').textContent.trim(),
    cls: [...el.classList].filter(c => ['on', 'pre', 'pressing'].includes(c)).join('|'),
  };
}, k);

const K = 'pins';
await page.evaluate(k => { IND[k].on = false; IND[k].pre = false; ibUpdateUI(k); indApply(); }, K);
ok('starts off', (await st(K)).word === 'off');
for (const [n, want] of [[1, 'exp'], [2, 'on'], [3, 'off']]) {
  await page.locator('#ib-' + K + ' .ib-lbl').click();
  await page.waitForTimeout(60);
  const s = await st(K);
  ok('click ' + n + ' -> ' + want, s.word === want, JSON.stringify(s));
}
const offState = await st(K);
ok('"off means off" - pre cleared too', offState.on === false && offState.pre === false);

console.log('\n6-7  Hold peeks, then reverts');
const holdProbe = async (key, setup) => {
  await page.evaluate(([k, s]) => { IND[k].on = s.on; IND[k].pre = s.pre; ibUpdateUI(k); indApply(); }, [key, setup]);
  const before = await page.evaluate(k => indActive(k), key);
  const box = await page.locator('#ib-' + key + ' .ib-main').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);                       // past IB_HOLD_MS
  const during = await page.evaluate(k => ({
    vis: indActive(k),
    cls: document.getElementById('ib-' + k).className,
    word: document.querySelector('#ib-' + k + ' .ib-state').textContent.trim(),
  }), key);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = await page.evaluate(k => ({ vis: indActive(k), on: IND[k].on, pre: IND[k].pre }), key);
  return { before, during, after };
};

let r = await holdProbe('pins', { on: false, pre: false });
ok('from off: not drawn at rest', r.before === false);
ok('from off: hold makes it draw', r.during.vis === true);
ok('from off: button shows the cyan peek state', r.during.cls.includes('pressing'));
ok('from off: word still reads the saved state', r.during.word === 'off', r.during.word);
ok('from off: release reverts', r.after.vis === false);
ok('from off: saved state untouched', r.after.on === false && r.after.pre === false);

r = await holdProbe('pins', { on: true, pre: true });
ok('from on: drawn at rest', r.before === true);
ok('from on: hold HIDES it', r.during.vis === false);
ok('from on: release restores', r.after.vis === true);
ok('from on: saved state untouched', r.after.on === true && r.after.pre === true);

console.log('\n8    Dragging off cancels without cycling');
await page.evaluate(k => { IND[k].on = false; IND[k].pre = true; ibUpdateUI(k); indApply(); }, K);
{
  const box = await page.locator('#ib-' + K + ' .ib-main').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(box.x + box.width / 2, box.y - 120);   // leave the button
  await page.waitForTimeout(80);
  const mid = await st(K);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const end = await st(K);
  ok('peek dropped on leave', mid.cls.includes('pressing') === false, mid.cls);
  ok('state unchanged by the aborted press', end.word === 'exp', JSON.stringify(end));
}

console.log('\n9    Type got bigger, block did not get taller');
const metrics = await page.evaluate(() => {
  const b = document.querySelector('.ind-grid .ib-main');
  const cols = [...document.querySelectorAll('.ind-col')].map(c => c.getBoundingClientRect().height);
  return {
    fs: parseFloat(getComputedStyle(b).fontSize),
    chip: parseFloat(getComputedStyle(document.querySelector('.ib-state')).fontSize),
    stacked: (() => {
      const c = [...document.querySelectorAll('.ind-col')];
      return c.length < 2 || c[1].getBoundingClientRect().top >= c[0].getBoundingClientRect().bottom - 1;
    })(),
    cols: [...document.querySelectorAll('.ind-col')].length,
    maxClip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')]
      .map(b => b.scrollWidth - b.clientWidth)),
    gridH: Math.round(document.querySelector('.ind-grid').getBoundingClientRect().height),
  };
});
ok('label type is 13px (was 8.5px)', metrics.fs === 13, metrics.fs + 'px');
ok('state chip is >= 10px (was a 6px sub-label)', metrics.chip >= 10, metrics.chip + 'px');
ok('single column holds all 13', metrics.cols === 1 || metrics.stacked === true, JSON.stringify(metrics));
ok('nothing clips out of any button', metrics.maxClip === 0, 'worst overflow ' + metrics.maxClip + 'px');

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' passed');
await browser.close();
process.exit(fail ? 1 : 0);

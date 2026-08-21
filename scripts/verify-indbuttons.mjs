// Verification for the regrouped indicator controls. Server on :3100:
//   node scripts/verify-indbuttons.mjs
//
//  1 the 13 "Show During Exploration" sub-buttons are gone
//  2 every indicator has one fixed-width icon slot, so all labels align
//  3 the two paired indicators stack their dots vertically
//  4 state is carried by font weight, not a word chip: on/exp bold, off regular
//  5 click cycles off -> exp -> on -> off
//  6 hold >=350ms inverts the overlay while held, then reverts, changing nothing
//  7 hold from ON hides it (the inversion works both ways)
//  8 dragging off the button cancels the peek without cycling
//  9 grouping: four core overlays always out, nine folded, settings in a panel
// 10 game-start buttons hide while a game is live
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

const CORE = ['threats', 'counts', 'unprotected', 'pins'];
const FOLDED = ['checkthreats', 'discoveredself', 'discoveredopp', 'forksw',
                'forksb', 'weakb', 'weakw', 'xray', 'overloaded'];

const KEYS = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib')].map(e => e.id.replace(/^ib-/, '')));

// Read the default fold state before anything touches it, then open the fold so
// the folded nine have real geometry - a display:none element measures zero.
const foldClosedOnLoad = await page.evaluate(() =>
  !document.getElementById('vz-more').classList.contains('open'));
const sidebarClosedH = await page.evaluate(() =>
  Math.round(document.getElementById('sidebar').getBoundingClientRect().height));
await page.evaluate(() => document.getElementById('vz-more').classList.add('open'));
await page.waitForTimeout(150);

console.log('\n1-4  Structure');
ok('13 indicators present', KEYS.length === 13, String(KEYS.length));
ok('no .ib-pre sub-buttons remain', (await page.locator('.ib-pre').count()) === 0);
ok('13 icon slots', (await page.locator('.ind-grid .ib-icon').count()) === 13);
ok('no state chips remain', (await page.locator('.ib-state').count()) === 0);

const slots = await page.evaluate(() =>
  [...document.querySelectorAll('.ind-grid .ib-icon')].map(e => e.getBoundingClientRect().width));
ok('every icon slot is the same width', new Set(slots.map(w => w.toFixed(2))).size === 1,
   [...new Set(slots.map(w => w.toFixed(1)))].join(','));

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

// Weight is what replaced the word chip, so it has to actually differ.
const weights = await page.evaluate(() => {
  const out = {};
  for (const k of ['threats', 'counts', 'pins']) {
    const set = (on, pre) => { IND[k].on = on; IND[k].pre = pre; ibUpdateUI(k); };
    const read = () => parseInt(getComputedStyle(document.querySelector('#ib-' + k + ' .ib-main')).fontWeight, 10);
    set(false, false); const off = read();
    set(false, true);  const exp = read();
    set(true, true);   const on  = read();
    out[k] = { off, exp, on };
  }
  return out;
});
ok('off is regular weight', Object.values(weights).every(w => w.off <= 500), JSON.stringify(weights));
ok('exp is bold', Object.values(weights).every(w => w.exp >= 700));
ok('on is bold', Object.values(weights).every(w => w.on >= 700));
ok('active states are heavier than off', Object.values(weights).every(w => w.exp > w.off && w.on > w.off));

// on and exp share a weight, so hue has to carry the difference between them.
// .ib-main transitions colour, and getComputedStyle mid-transition reports the
// value being animated FROM - so suppress the transition for the read.
const hues = await page.evaluate(() => {
  const k = 'threats', el = () => document.querySelector('#ib-' + k + ' .ib-main');
  el().style.transition = 'none';
  const grab = () => getComputedStyle(el()).color + '|' + getComputedStyle(el()).backgroundColor;
  const set = (on, pre) => { IND[k].on = on; IND[k].pre = pre; ibUpdateUI(k); void el().offsetWidth; };
  set(false, false); const off = grab();
  set(false, true);  const exp = grab();
  set(true, true);   const on  = grab();
  el().style.transition = '';
  return { off, exp, on };
});
ok('on / exp / off are three distinct colourings',
   new Set([hues.off, hues.exp, hues.on]).size === 3, JSON.stringify(hues));

console.log('\n5    Click cycles off -> exp -> on -> off');
const st = async k => page.evaluate(key => {
  const i = IND[key];
  const el = document.getElementById('ib-' + key);
  return {
    on: i.on, pre: i.pre,
    cls: [...el.classList].filter(c => ['on', 'pre', 'pressing'].includes(c)).join('|'),
  };
}, k);

const K = 'pins';
const mode = s => (s.on ? 'on' : s.pre ? 'exp' : 'off');
await page.evaluate(k => { IND[k].on = false; IND[k].pre = false; ibUpdateUI(k); indApply(); }, K);
ok('starts off', mode(await st(K)) === 'off');
for (const [n, want] of [[1, 'exp'], [2, 'on'], [3, 'off']]) {
  await page.locator('#ib-' + K + ' .ib-lbl').click();
  await page.waitForTimeout(60);
  const s = await st(K);
  ok('click ' + n + ' -> ' + want, mode(s) === want, JSON.stringify(s));
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
    weight: parseInt(getComputedStyle(document.querySelector('#ib-' + k + ' .ib-main')).fontWeight, 10),
  }), key);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = await page.evaluate(k => ({ vis: indActive(k), on: IND[k].on, pre: IND[k].pre }), key);
  return { before, during, after };
};

let r = await holdProbe('pins', { on: false, pre: false });
ok('from off: not drawn at rest', r.before === false);
ok('from off: hold makes it draw', r.during.vis === true);
ok('from off: button shows the peek state', r.during.cls.includes('pressing'));
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
  await page.mouse.move(box.x + box.width / 2, box.y - 160);   // leave the button
  await page.waitForTimeout(80);
  const mid = await st(K);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const end = await st(K);
  ok('peek dropped on leave', mid.cls.includes('pressing') === false, mid.cls);
  ok('state unchanged by the aborted press', mode(end) === 'exp', JSON.stringify(end));
}

console.log('\n9    Grouping');
const grouping = await page.evaluate(([core, folded]) => {
  const fold = document.getElementById('vz-more');
  return {
    coreOutside: core.every(k => !fold.contains(document.getElementById('ib-' + k))),
    foldedInside: folded.every(k => fold.contains(document.getElementById('ib-' + k))),
    ghostFolded: fold.contains(document.getElementById('ghostRow')),
    settingsInPanel: ['cbSound', 'cbLegalToggle', 'cbInfluenceToggle', 'cbBattery', 'cbQPins']
      .every(id => document.getElementById('boardSettingsPanel').contains(document.getElementById(id))),
    cols: getComputedStyle(document.querySelector('.ind-grid')).gridTemplateColumns.split(' ').length,
  };
}, [CORE, FOLDED]);

ok('the four core overlays are always out', grouping.coreOutside);
ok('the other nine are inside the fold', grouping.foldedInside);
ok('the fold is closed on a first visit', foldClosedOnLoad);
ok('ghost responses sits in the fold', grouping.ghostFolded);
ok('all five settings moved into the panel', grouping.settingsInPanel);
ok('two columns', grouping.cols === 2, grouping.cols + ' cols');
ok('default sidebar under 400px', sidebarClosedH < 400, sidebarClosedH + 'px');

// Pairs must sit side by side - the point of a row-major grid.
const pairs = await page.evaluate(() => {
  const t = id => document.getElementById(id).getBoundingClientRect();
  const same = (a, b) => Math.abs(t(a).top - t(b).top) < 2 && t(a).left !== t(b).left;
  return {
    disc:  same('ib-discoveredself', 'ib-discoveredopp'),
    forks: same('ib-forksw', 'ib-forksb'),
    weak:  same('ib-weakb', 'ib-weakw'),
    xray:  same('ib-xray', 'ib-overloaded'),
    checkSpans: t('ib-checkthreats').width > t('ib-forksw').width * 1.8,
    maxClip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')]
      .map(b => b.scrollWidth - b.clientWidth)),
  };
});
ok('My/Opp discovered sit side by side', pairs.disc);
ok('forks pair side by side', pairs.forks);
ok('weak squares pair side by side', pairs.weak);
ok('x-ray / overloaded pair side by side', pairs.xray);
ok('check threats spans the full width', pairs.checkSpans);
ok('nothing clips out of any button', pairs.maxClip === 0, 'worst ' + pairs.maxClip + 'px');

// The real toggle (not the class poke above) must persist the choice.
await page.evaluate(() => document.getElementById('vz-more').classList.remove('open'));
await page.click('#vz-toggle');
await page.waitForTimeout(200);
ok('opening the fold is remembered', await page.evaluate(() => {
  try { return localStorage.getItem('bm_vzOpen') === '1'; } catch (e) { return false; }
}));
await page.click('#vz-toggle');
await page.waitForTimeout(200);
ok('closing it again is remembered', await page.evaluate(() => {
  try { return localStorage.getItem('bm_vzOpen') === '0'; } catch (e) { return false; }
}));

console.log('\n10   Game-start buttons hide during a live game');
const live = await page.evaluate(() => {
  const vis = () => ['botSidebarBtn', 'mpSidebarBtn', 'btnLoadPgn']
    .map(id => { const e = document.getElementById(id); return e ? e.style.display !== 'none' : null; });
  const before = vis();
  botActive = true; gameOver = false; updateActionBtn();
  const during = vis();
  botActive = false; updateActionBtn();
  const after = vis();
  return { before, during, after };
});
ok('all three show when idle', live.before.every(v => v === true), JSON.stringify(live.before));
ok('all three hide during a live game', live.during.every(v => v === false), JSON.stringify(live.during));
ok('all three come back when it ends', live.after.every(v => v === true), JSON.stringify(live.after));

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' passed');
await browser.close();
process.exit(fail ? 1 : 0);

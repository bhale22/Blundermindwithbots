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

// There is no fold any more, so nothing has to be opened for the nine to have
// geometry. What matters instead is that the column still fits one screen and
// that the floor stays put, which is what the checks below measure.
const contentBottom = await page.evaluate(() =>
  Math.round(document.querySelector('.hold-note').getBoundingClientRect().bottom));
const pageScrolls = await page.evaluate(() =>
  document.documentElement.scrollHeight > window.innerHeight + 2);

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

// State used to be carried partly by font weight, which re-measured the label
// and could rewrap it - "My disc. attacks" went from one line to two the moment
// it was selected, and the button grew under the cursor. Weight is gone; what
// has to hold now is that NOTHING about the box or the label moves between the
// three states.
const geom = await page.evaluate(() => {
  const out = {};
  for (const k of ['threats', 'counts', 'pins', 'discoveredself', 'weakb']) {
    const btn = document.querySelector('#ib-' + k + ' .ib-main');
    const lbl = document.querySelector('#ib-' + k + ' .ib-lbl');
    const set = (on, pre) => { IND[k].on = on; IND[k].pre = pre; ibUpdateUI(k); };
    const read = () => {
      const r = btn.getBoundingClientRect(), l = lbl.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height),
              Math.round(l.top - r.top), Math.round(l.height),
              getComputedStyle(lbl).fontWeight].join('/');
    };
    set(false, false); const off = read();
    set(false, true);  const exp = read();
    set(true, true);   const on  = read();
    set(false, true);
    out[k] = { off, exp, on, stable: off === exp && exp === on };
  }
  return out;
});
ok('button geometry is identical in all three states',
   Object.values(geom).every(g => g.stable), JSON.stringify(geom));
ok('weight never changes with state',
   Object.values(geom).every(g => g.off.split('/')[4] === g.on.split('/')[4]));

// Every label must sit on ONE line and must not be clipped, or the panel is
// back to reflowing the moment a name gets long.
const oneLine = await page.evaluate(() => {
  const bad = [];
  document.querySelectorAll('.ind-grid .ib-lbl, .ghost-row .ib-lbl').forEach(l => {
    const lh = parseFloat(getComputedStyle(l).lineHeight);
    const lines = Math.round(l.getBoundingClientRect().height / lh);
    if (lines > 1 || l.scrollWidth > l.clientWidth + 1)
      bad.push(l.textContent.trim() + ' (' + lines + ' lines' +
               (l.scrollWidth > l.clientWidth + 1 ? ', clipped' : '') + ')');
  });
  return bad;
});
ok('every label fits one line without clipping', oneLine.length === 0, oneLine.join('; '));

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
const grouping = await page.evaluate(([core, extra]) => {
  const grids = [...document.querySelectorAll('.ind-grid')];
  const heads = [...document.querySelectorAll('.bv-head')].map(e => e.textContent.trim());
  const inGrid = (g, k) => g.contains(document.getElementById('ib-' + k));
  return {
    heads,
    coreInFirst:  grids[0] && core.every(k => inGrid(grids[0], k)),
    extraInSecond: grids[1] && extra.every(k => inGrid(grids[1], k)),
    noFold: !document.getElementById('vz-more') && !document.getElementById('vz-toggle'),
    // Ghost is an overlay-shaped toggle now, paired with its depth selector.
    ghostBtn: !!document.querySelector('#ib-ghost .ib-main'),
    ghostSel: !!document.getElementById('soloGhostDepth'),
    ghostOutsideGrid: !!document.getElementById('ib-ghost') &&
      !document.querySelector('.ind-grid').contains(document.getElementById('ib-ghost')),
    // The state key replaces the word chip that used to name each state.
    keyChips: [...document.querySelectorAll('.ind-key-row span')].map(e => e.textContent.trim()),
    // Settings sits BETWEEN the two groups, not above them.
    settingsBetween: (() => {
      const bs = document.getElementById('bs-open');
      if (!bs || grids.length < 2) return false;
      const y = bs.getBoundingClientRect().top;
      return y > grids[0].getBoundingClientRect().top &&
             y < grids[1].getBoundingClientRect().top;
    })(),
    settingsCaption: (document.querySelector('#bs-open .bs-t2') || {}).textContent || '',
    settingsInPanel: ['cbSound', 'cbLegalToggle', 'cbInfluenceToggle', 'cbBattery', 'cbQPins']
      .every(id => document.getElementById('boardSettingsPanel').contains(document.getElementById(id))),
    cols: getComputedStyle(document.querySelector('.ind-grid')).gridTemplateColumns.split(' ').length,
  };
}, [CORE, FOLDED]);

ok('the four core overlays are in the first group', grouping.coreInFirst);
ok('the other nine are in the second group', grouping.extraInSecond);
ok('both groups are named', grouping.heads.length === 2, grouping.heads.join(' | '));
ok('the disclosure is gone entirely', grouping.noFold);
ok('every overlay is visible without opening anything', KEYS.length === 13, String(KEYS.length));
ok('ghost replies is a button', grouping.ghostBtn);
ok('ghost keeps its depth selector', grouping.ghostSel);
ok('ghost sits outside the overlay grid', grouping.ghostOutsideGrid);
ok('the state key names all three states', grouping.keyChips.length === 3,
   grouping.keyChips.join(' / '));
ok('board settings sits between the two groups', grouping.settingsBetween);
ok('the settings button says what is inside', /[Ss]ound/.test(grouping.settingsCaption),
   grouping.settingsCaption);
ok('all five settings stayed in the panel', grouping.settingsInPanel);
ok('two columns', grouping.cols === 2, grouping.cols + ' cols');
ok('everything fits one screen without scrolling', !pageScrolls);
ok('controls end above the fold line', contentBottom < 700, contentBottom + 'px');

// Pairs must sit side by side - the point of a row-major grid. Mine is always
// the left of a pair now; weak squares used to be the one exception.
const pairs = await page.evaluate(() => {
  const t = id => document.getElementById(id).getBoundingClientRect();
  const same = (a, b) => Math.abs(t(a).top - t(b).top) < 2 && t(a).left !== t(b).left;
  const mineLeft = (mine, theirs) => t(mine).left < t(theirs).left;
  return {
    disc:  same('ib-discoveredself', 'ib-discoveredopp'),
    forks: same('ib-forksw', 'ib-forksb'),
    weak:  same('ib-weakw', 'ib-weakb'),
    xray:  same('ib-xray', 'ib-overloaded'),
    mineLeftDisc:  mineLeft('ib-discoveredself', 'ib-discoveredopp'),
    mineLeftForks: mineLeft('ib-forksw', 'ib-forksb'),
    mineLeftWeak:  mineLeft('ib-weakb', 'ib-weakw'),
    // Forks come before discovered attacks; weak squares come last.
    forksAboveDisc: t('ib-forksw').top < t('ib-discoveredself').top,
    weakBelowXray:  t('ib-weakb').top > t('ib-xray').top,
    checkSpans: t('ib-checkthreats').width > t('ib-forksw').width * 1.8,
    // The two weak-square chips used to be the same colour, which said the two
    // overlays were the same thing.
    weakChips: [getComputedStyle(document.querySelector('#ib-weakb .ib-sq')).backgroundColor,
                getComputedStyle(document.querySelector('#ib-weakw .ib-sq')).backgroundColor],
    maxClip: Math.max(...[...document.querySelectorAll('.ind-grid .ib-main')]
      .map(b => b.scrollWidth - b.clientWidth)),
  };
});
ok('My/Opp discovered sit side by side', pairs.disc);
ok('forks pair side by side', pairs.forks);
ok('weak squares pair side by side', pairs.weak);
ok('x-ray / overloaded pair side by side', pairs.xray);
ok('mine is on the left of every pair',
   pairs.mineLeftDisc && pairs.mineLeftForks && pairs.mineLeftWeak);
ok('discovered attacks sit below forks/skewers', pairs.forksAboveDisc);
ok('weak squares sit below x-ray/overloaded', pairs.weakBelowXray);
ok('check threats spans the full width', pairs.checkSpans);
ok('the two weak-square chips differ', pairs.weakChips[0] !== pairs.weakChips[1],
   pairs.weakChips.join(' vs '));
ok('nothing clips out of any button', pairs.maxClip === 0, 'worst ' + pairs.maxClip + 'px');

console.log('\n9b   Ghost button and selector are one value');
const gs = async () => page.evaluate(() => ({
  sel: document.getElementById('soloGhostDepth').value,
  on: document.getElementById('ib-ghost').classList.contains('on'),
  disabled: document.getElementById('soloGhostDepth').disabled,
}));
const g0 = await gs();
await page.click('#ib-ghost .ib-main'); await page.waitForTimeout(150);
const g1 = await gs();
await page.click('#ib-ghost .ib-main'); await page.waitForTimeout(150);
const g2 = await gs();
ok('button starts on with a depth chosen', g0.on && g0.sel !== '0', JSON.stringify(g0));
ok('turning it off drops the selector to Off', !g1.on && g1.sel === '0', JSON.stringify(g1));
ok('the selector greys out while off', g1.disabled);
ok('turning it back on restores the depth', g2.on && g2.sel === g0.sel, JSON.stringify(g2));

console.log('\n9c   Show all actually shows');
const showAll = await page.evaluate(() => {
  showAllDown(null);
  const keys = Object.keys(IND);
  // `influence` needs an in-progress exploration, so it can never be active on
  // a static board - every other indicator must be.
  const dead = keys.filter(k => k !== 'influence' && !indActive(k));
  showAllUp();
  return dead;
});
ok('holding Show all activates every overlay', showAll.length === 0, showAll.join(','));

console.log('\n9d   The floor does not move');
const floor = await page.evaluate(() => {
  const y = () => Math.round(document.querySelector('.secondary-row').getBoundingClientRect().top);
  const before = y();
  const real = _isLiveGame;
  _isLiveGame = () => true; updateGameStartBtns();
  const during = y();
  _isLiveGame = real; updateGameStartBtns();
  return { before, during, delta: Math.abs(during - before) };
});
ok('starting a game does not shift the floor', floor.delta === 0, floor.delta + 'px');

console.log('\n9e   It fits a real laptop screen');
// A 1366x768 laptop is ~600px of page once the browser's chrome is gone. That
// is the case that has to fit, and the one that was failing.
for (const [vw, vh] of [[1440, 900], [1366, 660], [1366, 600], [1280, 560]]) {
  await page.setViewportSize({ width: vw, height: vh });
  await page.waitForTimeout(350);
  const fit = await page.evaluate(() => {
    const last = document.querySelector('.secondary-row').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      offscreen: Math.round(last.bottom - window.innerHeight),
    };
  });
  ok(vw + 'x' + vh + ': no page scroll', fit.overflow <= 0, fit.overflow + 'px over');
  ok(vw + 'x' + vh + ': last row on screen', fit.offscreen <= 0, fit.offscreen + 'px below');
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);

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

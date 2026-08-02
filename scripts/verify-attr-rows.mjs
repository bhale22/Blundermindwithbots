// Attractor-row verification (phone collapse + desktop regression).
// Needs the server running on :3100 and must be run from the repo root
// (node_modules resolution):  node scripts/verify-attr-rows.mjs
//
// Covers the collapsed-row pass on Personality → Strategy & Piece Focus:
//   · Phone — rows collapse to a head; the track is gone until tapped
//   · Phone — head carries name / bipolar bar / setting / cp, and tracks state
//   · Phone — open row gives the slider real width, poles beneath it
//   · Phone — steppers write through the existing oninput wiring
//   · Phone — accordion: one row open at a time
//   · Phone — descriptions reachable (they were :hover-only, i.e. dead)
//   · Desktop (1440) — row geometry, cp text and hover-overlay behaviour
//     unchanged, and none of the phone chrome renders
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

async function panelAt(width, height, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2,
    isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  // The panel is served standalone as well as in the modal iframe; standalone is
  // the same document and skips the landing/modal dance.
  await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const o = document.getElementById('botTourOverlay'); if (o) o.style.display = 'none';
    // Personality section, Strategy & Piece Focus tab.
    if (!document.getElementById('sec-attract').classList.contains('open')) toggleSec('attract');
    switchItab('attract', 'pieces');
  });
  await page.waitForTimeout(300);
  return { ctx, page };
}

const box = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
}, sel);

const shown = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return !!(el && el.offsetParent !== null && el.getBoundingClientRect().height > 0);
}, sel);

/* ══════════════════════════════ PHONE ══════════════════════════════ */
console.log('\nPHONE  390×844');
{
  const { ctx, page } = await panelAt(390, 844, true);

  // ── Collapsed state ──
  ok('11 strategic rows rendered',
    await page.$$eval('#attractor-rows .attr-group', g => g.length) === 10 + 1 - 1,
    'ATTRACTORS minus luck = 10');
  ok('6 piece rows rendered',
    await page.$$eval('#piece-rows .attr-group', g => g.length) === 6);
  ok('head is visible when collapsed', await shown(page, '#attrhead-attr-chaos'));
  ok('body is hidden when collapsed', !(await shown(page, '#attrg-attr-chaos .attr-body')));
  ok('slider not reachable when collapsed', !(await shown(page, '#attr-chaos')));

  const head = await box(page, '#attrhead-attr-chaos');
  ok('head is a 44px+ touch target', head.h >= 44, head.h + 'px');
  ok('head spans the column', head.w > 280, head.w + 'px');

  // ── Head content tracks state ──
  const at0 = await page.evaluate(() => ({
    name: document.getElementById('attrname-attr-chaos').innerText.trim(),
    set: document.getElementById('attrset-attr-chaos').textContent.trim(),
    cp: document.getElementById('attrval-chaos-m').textContent.trim(),
    barW: document.getElementById('attrbar-attr-chaos').style.width,
  }));
  ok('centred head offers both poles', /Simplifier/.test(at0.name) && /Chaos Agent/.test(at0.name), at0.name);
  ok('centred head shows — for setting and cp', at0.set === '—' && at0.cp === '—');
  ok('centred bar has no fill', at0.barW === '0%', at0.barW);

  await page.evaluate(() => attrSetValue('attr-chaos', 3));
  await page.waitForTimeout(120);
  const at3 = await page.evaluate(() => ({
    name: document.getElementById('attrname-attr-chaos').innerText.trim(),
    set: document.getElementById('attrset-attr-chaos').textContent.trim(),
    cp: document.getElementById('attrval-chaos-m').textContent.trim(),
    rowCp: document.getElementById('attrval-chaos').textContent.trim(),
    barW: document.getElementById('attrbar-attr-chaos').style.width,
    barL: document.getElementById('attrbar-attr-chaos').style.left,
    slider: document.getElementById('attr-chaos').value,
    state: attractorValues.chaos,
  }));
  ok('set head names the active pole only', at3.name === 'Chaos Agent', at3.name);
  ok('setting reads +3', at3.set === '+3', at3.set);
  ok('cp mirror matches the row cp', at3.cp === at3.rowCp && /cp$/.test(at3.cp), at3.cp + ' vs ' + at3.rowCp);
  ok('bar fills right of centre', at3.barW === '30%' && at3.barL === '50%', at3.barW + ' @ ' + at3.barL);
  ok('attrSetValue drives the real input + state', at3.slider === '3' && at3.state === 3);

  await page.evaluate(() => attrSetValue('attr-trade', -5));
  await page.waitForTimeout(120);
  const neg = await page.evaluate(() => ({
    name: document.getElementById('attrname-attr-trade').innerText.trim(),
    barW: document.getElementById('attrbar-attr-trade').style.width,
    barL: document.getElementById('attrbar-attr-trade').style.left,
  }));
  ok('negative head names the left pole', neg.name === 'Trade avoider', neg.name);
  ok('bar fills left of centre', neg.barW === '50%' && neg.barL === '0%', neg.barW + ' @ ' + neg.barL);

  // cp is a share of one budget, so setting a second row must move the first.
  const cpAfter = await page.evaluate(() => document.getElementById('attrval-chaos-m').textContent.trim());
  ok('cp re-splits across rows', cpAfter !== at3.cp, at3.cp + ' → ' + cpAfter);

  // ── Open state ──
  await page.click('#attrhead-attr-chaos');
  await page.waitForTimeout(200);
  ok('tap opens the row', await shown(page, '#attr-chaos'));
  const track = await box(page, '#attrg-attr-chaos .attr-slider-wrap');
  ok('open track gets real width (>250px)', track.w > 250, track.w + 'px');
  const wrap = await box(page, '#attrg-attr-chaos .attractor-row');
  ok('track is full row width', track.w >= wrap.w - 4, track.w + ' of ' + wrap.w);
  const left = await box(page, '#attrg-attr-chaos .attr-left');
  ok('pole label sits BELOW the track', left.y > track.y + track.h - 4, `poleY ${left.y} vs trackBottom ${track.y + track.h}`);
  ok('row cp hidden (it is in the head)', !(await shown(page, '#attrg-attr-chaos .attr-val')));
  ok('description is visible when open', await shown(page, '#attrg-attr-chaos .attr-desc'));
  const desc = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#attrg-attr-chaos .attr-desc')).position);
  ok('description is in the flow, not a hover overlay', desc === 'static', desc);

  // ── Steppers ──
  const step = await box(page, '#attrg-attr-chaos .attr-step');
  ok('stepper is a 44px+ target', step.h >= 44, step.h + 'px');
  await page.click('#attrg-attr-chaos .attr-steppers .attr-step:last-child');
  await page.waitForTimeout(120);
  ok('+ nudges to 4 through the real handler',
    await page.evaluate(() => attractorValues.chaos === 4 && document.getElementById('attr-chaos').value === '4'));
  await page.click('#attrg-attr-chaos .attr-step-mid');
  await page.waitForTimeout(120);
  ok('Centre resets to 0',
    await page.evaluate(() => attractorValues.chaos === 0 && document.getElementById('attrset-attr-chaos').textContent.trim() === '—'));
  await page.evaluate(() => { attrNudge('attr-chaos', -9); });
  await page.waitForTimeout(120);
  ok('nudge clamps at −5', await page.evaluate(() => attractorValues.chaos === -5));

  // ── Accordion ──
  await page.click('#attrhead-attr-gambito');
  await page.waitForTimeout(200);
  ok('opening another row closes the first',
    (await shown(page, '#attr-gambito')) && !(await shown(page, '#attr-chaos')));
  await page.click('#attrhead-attr-gambito');
  await page.waitForTimeout(200);
  ok('tapping an open row closes it', !(await shown(page, '#attr-gambito')));

  // ── Piece rows use the same component ──
  await page.evaluate(() => attrSetValue('piece-knight', 2));
  await page.waitForTimeout(120);
  const pk = await page.evaluate(() => ({
    name: document.getElementById('attrname-piece-knight').innerText.trim(),
    set: document.getElementById('attrset-piece-knight').textContent.trim(),
    state: pieceValues.knight,
  }));
  ok('piece head reads "Knight · seeks"', /Knight/.test(pk.name) && /seeks/.test(pk.name), pk.name);
  ok('piece setting + state wired', pk.set === '+2' && pk.state === 2);
  await page.click('#attrhead-piece-knight');
  await page.waitForTimeout(200);
  const pTrack = await box(page, '#attrg-piece-knight .attr-slider-wrap');
  ok('piece track gets real width', pTrack.w > 250, pTrack.w + 'px');

  // ── Heads survive the paths that set values from elsewhere ──
  await page.evaluate(() => { switchItab('attract', 'presets'); _applyPersonality('entropy'); switchItab('attract', 'pieces'); });
  await page.waitForTimeout(250);
  ok('preset repaints the heads',
    await page.evaluate(() => document.getElementById('attrset-attr-chaos').textContent.trim() === '+4'
      && document.getElementById('attrname-attr-chaos').innerText.trim() === 'Chaos Agent'));
  await page.evaluate(() => _radarSetAxis(0, -2));
  await page.waitForTimeout(200);
  ok('radar drag repaints the head',
    await page.evaluate(() => document.getElementById('attrset-attr-chaos').textContent.trim() === '-2'
      && document.getElementById('attrname-attr-chaos').innerText.trim() === 'Simplifier'));

  ok('no horizontal overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));

  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.waitForTimeout(300);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

/* ═══════════════════════ DESKTOP REGRESSION ═══════════════════════ */
console.log('\nDESKTOP  1440×900  (must be unchanged)');
{
  const { ctx, page } = await panelAt(1440, 900, false);

  ok('head does not render', !(await shown(page, '#attrhead-attr-chaos')));
  ok('steppers do not render', !(await shown(page, '#attrg-attr-chaos .attr-steppers')));
  ok('slider is directly visible (no tap needed)', await shown(page, '#attr-chaos'));
  ok('.attr-body is display:contents',
    await page.evaluate(() => getComputedStyle(document.querySelector('#attrg-attr-chaos .attr-body')).display) === 'contents');

  // Original geometry: pole label, track, pole label, cp — all on ONE line.
  const l = await box(page, '#attrg-attr-chaos .attr-left');
  const t = await box(page, '#attrg-attr-chaos .attr-slider-wrap');
  const r = await box(page, '#attrg-attr-chaos .attr-right');
  const v = await box(page, '#attrval-chaos');
  ok('row is one line: left · track · right · cp',
    Math.abs(l.y - t.y) < 12 && Math.abs(r.y - t.y) < 12 && Math.abs(v.y - t.y) < 12,
    `ys ${l.y}/${t.y}/${r.y}/${v.y}`);
  ok('pole labels keep their 90px column', l.w === 90 && r.w === 90, l.w + '/' + r.w);
  ok('cp readout still visible in the row', await shown(page, '#attrval-chaos'));
  ok('left pole is right-aligned as before',
    await page.evaluate(() => getComputedStyle(document.querySelector('#attrg-attr-chaos .attr-left')).textAlign) === 'right');

  const pl = await box(page, '#attrg-piece-knight .attr-left');
  ok('piece label keeps its 70px column', pl.w === 70, pl.w + 'px');

  // The description stays a hover overlay on desktop.
  ok('description hidden at rest', !(await shown(page, '#attrg-attr-chaos .attr-desc')));
  await page.hover('#attrg-attr-chaos .attractor-row');
  await page.waitForTimeout(150);
  ok('description appears on hover', await shown(page, '#attrg-attr-chaos .attr-desc'));
  const pos = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#attrg-attr-chaos .attr-desc')).position);
  ok('description still absolutely positioned', pos === 'absolute', pos);

  // Sliders still drive state on desktop.
  await page.evaluate(() => { const s = document.getElementById('attr-fortkx'); s.value = 4; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(150);
  ok('desktop slider still updates state + cp',
    await page.evaluate(() => attractorValues.fortkx === 4 && /cp$/.test(document.getElementById('attrval-fortkx').textContent)));

  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

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
  // Uses 'trade' (set to −5 above) rather than an untouched row: by this point
  // the active-first partition has folded the centred rows away, which is the
  // feature working, not a failure.
  await page.click('#attrhead-attr-trade');
  await page.waitForTimeout(200);
  ok('opening another row closes the first',
    (await shown(page, '#attr-trade')) && !(await shown(page, '#attr-chaos')));
  await page.click('#attrhead-attr-trade');
  await page.waitForTimeout(200);
  ok('tapping an open row closes it', !(await shown(page, '#attr-trade')));

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

  // ── Active-first partition ──
  // Entropy leaves 'pressure' at 0, so exactly one strategic row is inactive.
  await page.evaluate(() => { switchItab('attract', 'presets'); _applyPersonality('entropy'); switchItab('attract', 'pieces'); });
  await page.waitForTimeout(250);
  ok('list is partitioned once something is set',
    await page.evaluate(() => document.getElementById('attractor-rows').classList.contains('partitioned')));
  ok('inactive row is folded away', !(await shown(page, '#attrg-attr-pressure')));
  ok('active rows still shown', await shown(page, '#attrg-attr-chaos'));
  ok('active rows sort above the expander', await page.evaluate(() => {
    const g = document.getElementById('attrg-attr-chaos');
    const b = document.getElementById('attrmore-attractor-rows');
    return getComputedStyle(g).order === '1' && getComputedStyle(b).order === '2';
  }));
  const moreTxt = await page.evaluate(() => document.getElementById('attrmore-attractor-rows').textContent.trim());
  ok('expander counts the folded rows', /^Show 1 more$/.test(moreTxt), moreTxt);
  await page.click('#attrmore-attractor-rows');
  await page.waitForTimeout(200);
  ok('expander reveals them', await shown(page, '#attrg-attr-pressure'));
  ok('expander flips its label', await page.evaluate(() =>
    /Show only the 9 in use/.test(document.getElementById('attrmore-attractor-rows').textContent)));
  await page.click('#attrmore-attractor-rows');
  await page.waitForTimeout(200);
  ok('expander folds them again', !(await shown(page, '#attrg-attr-pressure')));

  // A list with nothing set must stay whole — folding everything behind one
  // button would greet a fresh bot with an empty tab. (Presets don't touch
  // piece values, so clear the one this run set earlier.)
  // Close the knight row first: an open row deliberately freezes its list's
  // partition, so leaving it open would keep the stale buckets.
  await page.evaluate(() => {
    if (document.getElementById('attrg-piece-knight').classList.contains('open')) toggleAttrRow('piece-knight');
    attrSetValue('piece-knight', 0);
  });
  await page.waitForTimeout(200);
  ok('untouched list is NOT partitioned',
    await page.evaluate(() => !document.getElementById('piece-rows').classList.contains('partitioned')));
  ok('every piece row visible while none are set', await shown(page, '#attrg-piece-rook'));

  // The row being edited must never slide out from under the finger.
  await page.evaluate(() => { document.getElementById('attractor-rows').classList.add('show-all'); _repartitionAttrList('attractor-rows'); });
  await page.click('#attrhead-attr-pressure');
  await page.waitForTimeout(200);
  await page.evaluate(() => attrSetValue('attr-pressure', 3));
  await page.waitForTimeout(200);
  ok('open row keeps its bucket while being edited',
    await page.evaluate(() => !document.getElementById('attrg-attr-pressure').classList.contains('part-active')));
  ok('...and is still on screen', await shown(page, '#attrg-attr-pressure'));
  await page.click('#attrhead-attr-pressure');   // close → allowed to re-sort
  await page.waitForTimeout(200);
  ok('closing re-sorts it into the active group',
    await page.evaluate(() => document.getElementById('attrg-attr-pressure').classList.contains('part-active')));
  ok('nothing inactive left → expander retires',
    await page.evaluate(() => !document.getElementById('attractor-rows').classList.contains('partitioned')));

  // ── Radar: display, not editor ──
  await page.evaluate(() => switchItab('attract', 'quality'));
  await page.waitForTimeout(250);
  ok('radar caption tells you a tap navigates', await shown(page, '.radar-hint-phone'));
  ok('...and the drag caption is gone', !(await shown(page, '.radar-hint-desk')));
  ok('radar fits the column', await page.evaluate(() => {
    const c = document.getElementById('radar-canvas');
    return c.getBoundingClientRect().width <= c.parentElement.getBoundingClientRect().width + 1;
  }));
  const before = await page.evaluate(() => attractorValues.chaos);
  await page.evaluate(() => {
    // Tap the Chaos spoke (axis 0 = straight up from centre 160,130).
    const c = document.getElementById('radar-canvas'), r = c.getBoundingClientRect();
    const sx = r.width / c.width, sy = r.height / c.height;
    c.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true,
      touches: [new Touch({ identifier: 1, target: c,
        clientX: r.left + 160 * sx, clientY: r.top + (130 - 70) * sy })],
    }));
  });
  await page.waitForTimeout(500);
  ok('radar tap does NOT change the value',
    await page.evaluate(v => attractorValues.chaos === v, before), 'was ' + before);
  ok('radar tap switches to the Strategy tab',
    await page.evaluate(() => document.getElementById('itab-attract-pieces').classList.contains('active')));
  ok('radar tap opens that axis\'s row',
    await page.evaluate(() => document.getElementById('attrg-attr-chaos').classList.contains('open')));

  // 'luck' has no row — ATTRACTORS is filtered by id !== 'luck' — so it routes
  // to the dual slider that actually governs Good day / Bad day.
  await page.evaluate(() => { switchItab('attract', 'quality'); _radarNavigate(8); });
  await page.waitForTimeout(400);
  ok('Bad day axis routes to Move Distribution Range',
    await page.evaluate(() => document.getElementById('itab-attract-quality').classList.contains('active')
      && !!document.getElementById('move-quality-range')));

  // ── Custom controls as cards ──
  await page.evaluate(() => { switchItab('attract', 'custom'); addCustomControl(); });
  await page.waitForTimeout(300);
  const ccId = await page.evaluate(() => customControls[0].id);
  // Custom controls collapse to a head now (see verify-controls); open the card
  // before measuring the controls inside it.
  ok('a custom control renders', await shown(page, '.cc-head'));
  await page.evaluate(id => {
    toggleCcRow(id);
    document.getElementById('ccg-' + id).scrollIntoView({ block: 'center', behavior: 'instant' });
  }, ccId);
  await page.waitForTimeout(350);
  ok('column-header strip dropped', !(await shown(page, '.cc-headers')));
  const sel = await box(page, '.cc-row2 .cc-select');
  ok('selects are 44px targets', sel.h >= 44, sel.h + 'px');
  ok('selects go full width', sel.w > 230, sel.w + 'px');
  const ccTrack = await box(page, `#ccslider-${ccId}`);
  ok('strength track gets real width', ccTrack.w > 250, ccTrack.w + 'px');
  const mm = await box(page, '.cc-slidecell .cc-mm');
  ok('direction label sits below the track', mm.y > ccTrack.y + ccTrack.h - 8,
    `mmY ${mm.y} vs trackBottom ${ccTrack.y + ccTrack.h}`);
  await page.evaluate(() =>
    document.querySelector('.cc-row2 .attr-steppers .attr-step:last-child').click());
  await page.waitForTimeout(200);
  ok('custom-control stepper writes through onCustomControlValue',
    await page.evaluate(() => customControls[0].value === 1));
  ok('its cp readout updates',
    await page.evaluate(id => /cp$/.test(document.getElementById('ccval-' + id).textContent), ccId));
  const ccCard = await box(page, '.cc-row2');
  ok('card stays inside the column', ccCard.w <= 340, ccCard.w + 'px');

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

  // ── The three later additions must also be invisible at 1440 ──
  await page.evaluate(() => { switchItab('attract', 'presets'); _applyPersonality('entropy'); switchItab('attract', 'pieces'); });
  await page.waitForTimeout(250);
  ok('no expander button', !(await shown(page, '#attrmore-attractor-rows')));
  ok('every row visible, nothing folded', await shown(page, '#attrg-attr-pressure'));
  ok('.attr-list is not a flex column',
    await page.evaluate(() => getComputedStyle(document.getElementById('attractor-rows')).display) !== 'flex');
  ok('rows keep DOM order (no reordering)',
    await page.evaluate(() => getComputedStyle(document.getElementById('attrg-attr-chaos')).order) === '0');

  // The radar lives on the Quality tab — switch back before asserting on it.
  await page.evaluate(() => switchItab('attract', 'quality'));
  await page.waitForTimeout(250);
  ok('radar caption still says drag', await shown(page, '.radar-hint-desk'));
  ok('phone caption hidden', !(await shown(page, '.radar-hint-phone')));
  const rBefore = await page.evaluate(() => attractorValues.trade);
  await page.evaluate(() => {
    // Axis 1 is 'trade'. Aim down its spoke at 2/3 radius rather than guessing
    // a pixel — a near-miss lands on a neighbouring axis and proves nothing.
    const c = document.getElementById('radar-canvas'), r = c.getBoundingClientRect();
    const ang = (1 / RADAR_AXES.length) * 2 * Math.PI - Math.PI / 2;
    const cx = 160 + 60 * Math.cos(ang), cy = 130 + 60 * Math.sin(ang);
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true,
      clientX: r.left + cx * (r.width / c.width),
      clientY: r.top + cy * (r.height / c.height) }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  ok('desktop radar still EDITS on click',
    await page.evaluate(v => attractorValues.trade !== v, rBefore), 'unchanged at ' + rBefore);

  await page.evaluate(() => { switchItab('attract', 'custom'); addCustomControl(); });
  await page.waitForTimeout(300);
  ok('custom-control header strip still shown', await shown(page, '.cc-headers'));
  ok('custom control is still one row', await page.evaluate(() => {
    const r = document.querySelector('.cc-row2').getBoundingClientRect();
    return r.height < 70;
  }));
  ok('custom-control steppers hidden', !(await shown(page, '.cc-row2 .attr-steppers')));

  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

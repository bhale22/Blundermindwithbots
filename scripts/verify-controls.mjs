// Verification for the eight control fixes. Server on :3100, run from the repo
// root:  node scripts/verify-controls.mjs
//
//  1 Personality chip reports what drives the bot + its cp budget
//  2 Custom Controls collapse to a head, tap to open
//  3 Move Timing folds into groups
//  4 Maia 3 is marked recommended
//  5 Maia sub-panel opens under its own card, other engines below; tap folds
//  6 the selected engine's blurb moves below its controls
//  7 the temperature setting is stated prominently
//  8 slider thumbs are smaller but the control is still a 44px target
// plus a desktop block asserting none of it reaches 1440.
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
  await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const o = document.getElementById('botTourOverlay'); if (o) o.style.display = 'none';
    ['engine', 'attract', 'timing'].forEach(s => {
      const el = document.getElementById('sec-' + s);
      if (el && !el.classList.contains('open')) toggleSec(s);
    });
  });
  await page.waitForTimeout(600);
  return { ctx, page };
}

// .panel-shell animates max-height over 0.45s, so a click fired straight after
// a section opens can land on a box that is still collapsed behind the header.
async function ensureOpen(page, ids) {
  await page.evaluate(list => list.forEach(s => {
    const el = document.getElementById('sec-' + s);
    if (el && !el.classList.contains('open')) toggleSec(s);
  }), ids);
  await page.waitForTimeout(700);
}

// Playwright scrolls a target the minimum amount, which on a page this long can
// leave it under the fixed Start bar. Centre it ourselves, then tap.
async function tap(page, sel) {
  await page.evaluate(s => document.querySelector(s)
    ?.scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
  await page.waitForTimeout(250);
  await page.click(sel);
  await page.waitForTimeout(300);
}

const shown = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return !!(el && el.offsetParent !== null && el.getBoundingClientRect().height > 0);
}, sel);
const order = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s); return el ? getComputedStyle(el).order : null;
}, sel);

/* ══════════════════════════════ PHONE ══════════════════════════════ */
console.log('\nPHONE  390×844');
{
  const { ctx, page } = await panel(390, 844, true);

  // ── 1. Personality chip ──
  const chip = () => page.evaluate(() => document.getElementById('st-attract').textContent.trim());
  ok('chip reads Neutral when nothing is set', (await chip()) === 'Neutral', await chip());

  // The old averaging bug: one attractor at ±5, everything else centred.
  await page.evaluate(() => { attrSetValue('attr-chaos', 5); });
  await page.waitForTimeout(200);
  const one = await chip();
  ok('a single maxed attractor is NOT "Neutral"', !/Neutral/.test(one), one);
  ok('chip names the control count and budget', /^1 control · \d+ cp$/.test(one), one);

  await page.evaluate(() => { const s = document.getElementById('r-style'); s.value = 250; onGaugeSliderInput(250); });
  await page.waitForTimeout(250);
  ok('chip tracks the cp budget', /250 cp/.test(await chip()), await chip());

  await page.evaluate(() => { switchItab('attract', 'presets'); _applyPersonality('badday'); });
  await page.waitForTimeout(300);
  const bd = await chip();
  ok('preset name replaces the count', /^Grandmaster Bad Day · \d+ cp$/.test(bd), bd);
  // Bad Day averages 0.64 across 11 attractors — the old code called it "Light bias".
  ok('...and is no longer reported as Light bias', !/Light bias/.test(bd), bd);

  // ── 4/5/6. Engine picker ──
  // Bad Day reconfigures the engine for you (Maia 2400), which reopens the
  // Engine section — wait out the 0.45s panel-shell transition or clicks land
  // on a card whose box is still collapsed under the section header.
  await ensureOpen(page, ['engine']);
  ok('Maia 3 is marked recommended', await page.evaluate(() =>
    /recommend/i.test(document.querySelector('.mcard[data-engine="maia3"] .mrec')?.textContent || '')));
  ok('selected card sorts above its sub-panel', await order(page, '#sec-engine .mcard.sel') === '1');
  ok('sub-panel sorts above the other engines', await order(page, '#engine-sub-maia3') === '2');
  ok('temperature + histogram sit right under the Elometer',
    await order(page, '#engine-temp-col') === '3');
  ok('description tail sits after the temperature control',
    await order(page, '#engine-desc-tail') === '4');
  ok('rejected engines sort below all of it', await order(page, '#sec-engine .mcard:not(.sel)') === '5');

  const tail = await page.evaluate(() => document.getElementById('engine-desc-tail').textContent.trim());
  ok('tail carries the selected engine\'s blurb', /Human-like neural net/.test(tail), tail.slice(0, 40));
  ok('the card no longer shows it twice', !(await shown(page, '#sec-engine .mcard.sel .mdesc')));
  // The maiachess.com credit sat at the bottom of the sub-panel, i.e. between
  // the Elometer and the temperature controls. It belongs after them.
  ok('engine credit moved out of the sub-panel',
    !(await shown(page, '#engine-sub-maia3 .engine-credit'))); 
  ok('...and into the tail, link intact', await page.evaluate(() => {
    const a = document.querySelector('#engine-desc-tail a[href*="maiachess"]');
    return !!a && a.offsetParent !== null;
  }));

  // Everything that configures the chosen engine must physically precede the
  // engines you didn't choose — the whole point of the reorder.
  const geom = await page.evaluate(() => {
    const y = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    return { sub: y('#engine-sub-maia3'), temp: y('#engine-temp-col'),
             tail: y('#engine-desc-tail'), other: y('#sec-engine .mcard:not(.sel)') };
  });
  ok('Maia controls come before the other engine cards', geom.sub < geom.other,
    `sub@${geom.sub} vs other@${geom.other}`);
  ok('temperature follows the Elometer, not the rejected engines',
    geom.temp > geom.sub && geom.temp < geom.other, `temp@${geom.temp}`);
  ok('Maia blurb lands below the temperature control',
    geom.tail > geom.temp, `tail@${geom.tail} vs temp@${geom.temp}`);

  // Tap the selected card again → fold.
  await tap(page, '#sec-engine .mcard.sel');
  ok('tapping the selected engine folds its controls', !(await shown(page, '#engine-sub-maia3')));
  ok('...and the other engines are still there', await shown(page, '#sec-engine .mcard:not(.sel)'));
  await tap(page, '#sec-engine .mcard.sel');
  ok('tapping again reopens', await shown(page, '#engine-sub-maia3'));

  // Selecting a different engine swaps the sub-panel and never leaves it folded.
  await tap(page, '#sec-engine .mcard[data-engine="stockfish"]');
  ok('switching engine shows the new sub-panel', await shown(page, '#engine-sub-stockfish'));
  ok('an engine with no temperature column leaves no gap', await page.evaluate(() =>
    getComputedStyle(document.getElementById('engine-temp-col')).display === 'none'));
  ok('...and its blurb follows it', await page.evaluate(() =>
    /Classical engine/.test(document.getElementById('engine-desc-tail').textContent)));
  await tap(page, '#sec-engine .mcard[data-engine="maia3"]');

  // ── 7. Temperature ──
  ok('temperature states its setting prominently', await shown(page, '.temp-head'));
  const th = await page.evaluate(() => ({
    name: document.getElementById('temp-head-name').textContent.trim(),
    t: document.getElementById('temp-head-t').textContent.trim(),
    size: parseFloat(getComputedStyle(document.getElementById('temp-head-name')).fontSize),
    lit: document.querySelectorAll('.tt.tt-on').length,
  }));
  ok('badge names the preset', th.name.length > 2, th.name);
  ok('badge shows T', /^T = \d/.test(th.t), th.t);
  ok('badge is the biggest thing in the control', th.size >= 14, th.size + 'px');
  ok('the active zone caption is lit', th.lit === 1, th.lit + ' lit');
  await page.evaluate(() => { const s = document.getElementById('temp-t-slider'); s.value = 3.0; onTempSlider(3.0); });
  await page.waitForTimeout(200);
  ok('badge follows the slider', await page.evaluate(() =>
    document.getElementById('temp-head-name').textContent.trim() === 'Wild'
    && document.getElementById('temp-head-t').textContent.includes('3.00')));

  // ── 8. Thumbs ──
  await page.evaluate(() => switchItab('attract', 'quality'));
  await page.waitForTimeout(300);
  const thumb = await page.evaluate(() => ({
    h: Math.round(document.getElementById('r-style').getBoundingClientRect().height),
  }));
  ok('range control is still a 44px target', thumb.h >= 44, thumb.h + 'px');
  const thumbCss = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && r.conditionText && r.conditionText.includes('760')) {
          for (const sub of r.cssRules || []) {
            if (sub.selectorText && sub.selectorText.includes('-webkit-slider-thumb')
                && !sub.selectorText.includes('dual') && !sub.selectorText.includes('#r-')) {
              const w = parseFloat(sub.style.width);
              if (w) return w;
            }
          }
        }
      }
    }
    return null;
  });
  ok('drawn thumb is smaller than the old 26px', thumbCss !== null && thumbCss < 22, thumbCss + 'px');

  // ── 2. Custom controls ──
  // Engine selection re-runs updatePersonalityGating, which can leave the
  // Personality section mid-transition; settle it before tapping into it.
  await ensureOpen(page, ['attract']);
  await page.evaluate(() => {
    switchItab('attract', 'custom');
    while (customControls.length < 3) addCustomControl();
  });
  await page.waitForTimeout(400);
  ok('3 custom controls render as cards', await page.$$eval('.cc-card', c => c.length) === 3);
  ok('their controls are collapsed', !(await shown(page, '.cc-row2')));

  // The + button is a single gesture: add, open the card, raise the metric list.
  // Two buttons share this class — the Quality tab's shortcut and the one in
  // the Custom Controls pane. Target the pane's.
  await tap(page, '.cc-wrap .cc-add-btn');
  const added = await page.evaluate(() => {
    const c = customControls[customControls.length - 1];
    const grp = document.getElementById('ccg-' + c.id);
    return { n: customControls.length, open: grp.classList.contains('open'),
             focused: document.activeElement === grp.querySelector('.cc-select') };
  });
  ok('+ Add adds a control', added.n === 4, 'got ' + added.n);
  ok('+ Add opens its card in the same tap', added.open);
  ok('+ Add puts the metric list under the finger', added.focused);
  await page.evaluate(() => { const c = customControls.pop(); renderCustomControls(); });
  await page.waitForTimeout(200);
  ok('their heads are tappable', await shown(page, '.cc-head'));
  const ccH = await page.evaluate(() => Math.round(document.querySelector('.cc-wrap').scrollHeight));
  ok('3 collapsed controls fit on one screen', ccH < 844, ccH + 'px');
  const ccId = await page.evaluate(() => customControls[0].id);
  await tap(page, `#cchead-${ccId}`);
  ok('tapping a head opens that card', await shown(page, `#ccg-${ccId} .cc-row2`));
  await page.evaluate(id => attrSetValue('ccslider-' + id, -4), ccId);
  await page.waitForTimeout(250);
  const ccHead = await page.evaluate(id => ({
    set: document.querySelector(`#cchead-${id} .attr-head-set`).textContent.trim(),
    name: document.querySelector(`#cchead-${id} .attr-head-name`).textContent.trim(),
    cp: document.getElementById('ccval-' + id + '-m').textContent.trim(),
  }), ccId);
  ok('head tracks the value live', ccHead.set === '-4', ccHead.set);
  ok('head names the direction', /Avoid|Hold|Few|Allow|Trade|Simplify|Stop|Ease|Ignore|Cede|Cramped|Loose|No |On the|Sacrifice|Rooks|Stay|King safe|Make peace|Fewer|Keep/i.test(ccHead.name), ccHead.name);
  ok('head shows its cp share', /cp$/.test(ccHead.cp), ccHead.cp);
  await page.evaluate(id => onCustomControlPhase(id, 'endgame'), ccId);
  await page.waitForTimeout(250);
  ok('head shows the gate once set', await page.evaluate(id =>
    /Endgame/.test(document.querySelector(`#cchead-${id} .attr-head-name`).textContent), ccId));

  // ── 3. Move Timing ──
  await ensureOpen(page, ['timing']);
  ok('timing headings became folds', await page.$$eval('#sec-timing .tm-group', g => g.length) >= 4);
  ok('a closed fold hides its controls',
    !(await shown(page, '#sec-timing .tm-group:not(.open) .tm-body')));
  ok('one fold starts open', await shown(page, '#sec-timing .tm-group.open .tm-body'));
  await tap(page, '#sec-timing .tm-group:not(.open) > .dlbl');
  ok('tapping a heading opens it', await page.evaluate(() =>
    document.querySelectorAll('#sec-timing .tm-group.open').length >= 3));
  // The Premove heading's help button must still open the help, not toggle.
  const pmOpen = await page.evaluate(() => {
    const g = [...document.querySelectorAll('#sec-timing .tm-group')]
      .find(x => /Premove/.test(x.querySelector('.dlbl')?.textContent || ''));
    if (!g) return 'no premove group';
    const before = g.classList.contains('open');
    g.querySelector('.pmt-help-btn')?.click();
    return before === g.classList.contains('open') ? 'ok' : 'toggled';
  });
  ok('the help button inside a heading does not toggle the fold', pmOpen === 'ok', pmOpen);
  await page.evaluate(() => { const m = document.getElementById('pmt-modal'); if (m) m.style.display = 'none'; });

  ok('no horizontal overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.waitForTimeout(300);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

/* ═══════════════════════ DESKTOP REGRESSION ═══════════════════════ */
console.log('\nDESKTOP  1440×900');
{
  const { ctx, page } = await panel(1440, 900, false);

  ok('engine cards stay in one row above the sub-panels', await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#engine-mode-grid .mcard')];
    const ys = cards.map(c => Math.round(c.getBoundingClientRect().top));
    return new Set(ys).size === 1;
  }));
  ok('mode grid is still a grid, not display:contents',
    await page.evaluate(() => getComputedStyle(document.getElementById('engine-mode-grid')).display) === 'grid');
  ok('sub-panel is beside the cards, not between them', await page.evaluate(() => {
    const sub = document.getElementById('engine-sub-maia3').getBoundingClientRect();
    const card = document.querySelector('#engine-mode-grid .mcard').getBoundingClientRect();
    return sub.top > card.bottom;
  }));
  ok('card keeps its own description', await shown(page, '#sec-engine .mcard.sel .mdesc'));
  ok('description tail is hidden', !(await shown(page, '#engine-desc-tail')));
  ok('"recommended" badge still shows', await shown(page, '.mrec'));

  ok('temperature badge is phone-only', !(await shown(page, '.temp-head')));

  await page.evaluate(() => { switchItab('attract', 'custom'); if (!customControls.length) addCustomControl(); });
  await page.waitForTimeout(400);
  ok('custom controls stay expanded', await shown(page, '.cc-row2'));
  ok('their collapse heads are hidden', !(await shown(page, '.cc-head')));
  ok('custom control is still one row', await page.evaluate(() =>
    document.querySelector('.cc-row2').getBoundingClientRect().height < 70));

  ok('timing folds are inert — all controls visible', await page.evaluate(() =>
    [...document.querySelectorAll('#sec-timing .tm-body')].every(b => b.offsetParent !== null)));

  // The chip still works on desktop, just isn't a phone concern.
  await page.evaluate(() => { switchItab('attract', 'presets'); _applyPersonality('entropy'); });
  await page.waitForTimeout(300);
  ok('chip reports preset + budget on desktop', await page.evaluate(() =>
    /^Captain Entropy · \d+ cp$/.test(document.getElementById('st-attract').textContent.trim())),
    await page.evaluate(() => document.getElementById('st-attract').textContent));

  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.waitForTimeout(200);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

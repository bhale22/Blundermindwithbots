// Phone type-floor verification. Needs the server on :3100, run from the repo
// root (node_modules resolution):  node scripts/verify-typefloor.mjs
//
// Asserts the P1 sweep: on a phone, nothing in the Bot Builder renders text
// below 11px, no input is under 44px, and the bump broke nothing —
//   · no horizontal overflow, no element wider than its section panel
//   · no SVG chart label overlaps another after being scaled up
//   · desktop (1440) type is untouched, i.e. still dense on purpose
//
// Every section is opened and every inner tab is force-shown, so hidden panes
// are measured too — the whole point is to catch the labels earlier passes
// missed because they were behind a collapsed section.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '\n      → ' + extra : ''))); };

const browser = await chromium.launch();

async function openAll(width, height, mobile) {
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
    document.querySelectorAll('.section').forEach(s => {
      if (!s.classList.contains('open')) toggleSec(s.id.replace('sec-', ''));
    });
    // A custom control so the Custom Controls pane isn't measured empty.
    if (typeof customControls !== 'undefined' && !customControls.length) addCustomControl();
  });
  await page.waitForTimeout(700);
  // Force every inner tab pane visible so collapsed panes are measured too.
  await page.evaluate(() => document.querySelectorAll('.itab-pane').forEach(x => x.classList.add('active')));
  await page.waitForTimeout(500);
  return { ctx, page };
}

// Text nodes only — an element whose text lives in a child is measured at the
// child, so this reports the size the reader actually sees.
const textUnder = (page, floor) => page.evaluate(f => {
  const out = [];
  document.querySelectorAll('.section .panel *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (el.offsetParent === null || r.width === 0 || r.height === 0) return;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) return;
    // <sup>/<sub> render at 0.83em by definition. Forcing an exponent to the
    // same size as its base would be typographically wrong, and the 11pt floor
    // is about body text, not mathematical notation — so they are exempt.
    if (el.tagName === 'SUP' || el.tagName === 'SUB') return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < f) out.push(fs + 'px  ' + (el.id || el.className || el.tagName).toString().slice(0, 30)
      + '  :: ' + el.textContent.trim().slice(0, 28));
  });
  return [...new Set(out)];
}, floor);

// SVG <text> is measured in rendered pixels: user units × (width ÷ viewBox).
const svgUnder = (page, floor) => page.evaluate(f => {
  const out = [];
  document.querySelectorAll('.panel svg').forEach(svg => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vb = svg.getAttribute('viewBox');
    const scale = vb ? rect.width / parseFloat(vb.split(/[\s,]+/)[2]) : 1;
    svg.querySelectorAll('text').forEach(t => {
      if (!t.textContent.trim()) return;
      const rendered = parseFloat(getComputedStyle(t).fontSize) * scale;
      if (rendered < f) out.push(rendered.toFixed(1) + 'px  ' + (svg.id || '?') + ' :: ' + t.textContent.trim().slice(0, 18));
    });
  });
  return [...new Set(out)];
}, floor);

/* ══════════════════════════════ PHONE ══════════════════════════════ */
console.log('\nPHONE  390×844  — 11px floor');
{
  const { ctx, page } = await openAll(390, 844, true);

  const under = await textUnder(page, 11);
  ok('no HTML text under 11px', under.length === 0, under.slice(0, 12).join('\n      → '));

  const svg = await svgUnder(page, 11);
  ok('no SVG chart label under 11px rendered', svg.length === 0, svg.slice(0, 10).join('\n      → '));

  // Spot-checks on the named offenders from the audit, so a regression names
  // itself rather than showing up as an anonymous count.
  const spot = await page.evaluate(() => {
    const g = s => { const el = document.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    return {
      cpgLbl: g('.cpg-lbl'), cpgBtn: g('.cpg-btn'), tt: g('.tt'), dialZone: g('.dial-zone'),
      gaugeTitle: g('.gauge-title'), segBtn: g('.seg-btn'), itab: g('.itab'),
      sliderScale: g('.slider-scale span'), ccAdd: g('.cc-add-btn'), inlineDiv: g('[style*="font-size:8px"]'),
    };
  });
  Object.entries(spot).forEach(([k, v]) =>
    ok(`${k} ≥ 11px`, v !== null && v >= 11, 'got ' + v));

  // ── The bump must not have broken layout ──
  ok('no horizontal page overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));

  const wide = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.section .panel').forEach(panel => {
      const pw = panel.getBoundingClientRect().width;
      panel.querySelectorAll('*').forEach(el => {
        if (el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        if (r.width > pw + 2) out.push((el.id || el.className || el.tagName).toString().slice(0, 34)
          + ' ' + Math.round(r.width) + ' > ' + Math.round(pw));
      });
    });
    return [...new Set(out)];
  });
  ok('nothing wider than its panel', wide.length === 0, wide.slice(0, 8).join('\n      → '));

  // Raised chart labels must not have collided.
  const hits = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.panel svg').forEach(svg => {
      if (!svg.getBoundingClientRect().width) return;
      const ts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim());
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
        const a = ts[i].getBoundingClientRect(), b = ts[j].getBoundingClientRect();
        if (!a.width || !b.width) continue;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // >2px on both axes is a real visual collision, not a touching edge.
        if (ox > 2 && oy > 2) out.push((svg.id || '?') + ': "' + ts[i].textContent.trim().slice(0, 12)
          + '" ∩ "' + ts[j].textContent.trim().slice(0, 12) + '"');
      }
    });
    return [...new Set(out)];
  });
  ok('no chart labels overlap after the bump', hits.length === 0, hits.slice(0, 8).join('\n      → '));

  // ── Remaining P1 target sizes ──
  const small = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.section .panel input[type=text],.section .panel input[type=number],.section .panel select')
      .forEach(el => {
        if (el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        if (r.height < 44) out.push((el.id || el.className).toString().slice(0, 30) + ' h=' + Math.round(r.height));
      });
    return out;
  });
  ok('every text/number input and select is ≥44px tall', small.length === 0, small.join('\n      → '));

  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.waitForTimeout(300);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

/* ═══════════════════════ DESKTOP REGRESSION ═══════════════════════ */
console.log('\nDESKTOP  1440×900  — density preserved on purpose');
{
  const { ctx, page } = await openAll(1440, 900, false);

  const spot = await page.evaluate(() => {
    const g = s => { const el = document.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    return { cpgLbl: g('.cpg-lbl'), tt: g('.tt'), dialZone: g('.dial-zone'),
             segBtn: g('.seg-btn'), itab: g('.itab'), gaugeTitle: g('.gauge-title') };
  });
  ok('.cpg-lbl still 7px', spot.cpgLbl === 7, 'got ' + spot.cpgLbl);
  ok('.tt still 7px', spot.tt === 7, 'got ' + spot.tt);
  ok('.dial-zone still 7px', spot.dialZone === 7, 'got ' + spot.dialZone);
  ok('.seg-btn still 9px', spot.segBtn === 9, 'got ' + spot.segBtn);
  ok('.itab still 10px', spot.itab === 10, 'got ' + spot.itab);
  ok('.gauge-title still 9.5px', spot.gaugeTitle === 9.5, 'got ' + spot.gaugeTitle);

  // The default readability mode is High-vis, which ALREADY rewrites inline
  // sizes on every width (body.rs-highvis [style*="font-size:8px"] → 12px).
  // Switch to Stylized, where no readability override applies, so this asserts
  // the phone sweep and nothing else.
  await page.evaluate(() => setReadability('default'));
  await page.waitForTimeout(200);
  const inline = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('[style*="font-size:8px"]')).fontSize));
  ok('inline 8px text untouched on desktop', inline === 8, 'got ' + inline);

  const svgSpec = await page.evaluate(() => {
    const t = document.querySelector('.panel svg text[font-size="7"]');
    return t ? parseFloat(getComputedStyle(t).fontSize) : null;
  });
  ok('SVG 7-unit labels untouched on desktop', svgSpec === 7, 'got ' + svgSpec);

  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

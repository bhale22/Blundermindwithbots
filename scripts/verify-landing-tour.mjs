// Landing knight watermark + the two guided tours. Server on :3100, run from
// the repo root:  node scripts/verify-landing-tour.mjs
//
//  1 Build-A-Bot landing shows the knight, and the scanning eye is on the
//    watermark only — never on the title glyph as well
//  2 Blundermind landing is untouched: pawn title, no watermark
//  3 the landing copy is short enough to leave the watermark room
//  4 "Overview" opens a page describing both boards, with the way into
//    Blundermind and the Bot Builder (never the bare pro board) and a tour of
//    each board; every one of them starts from it
//  5 finishing the board tour offers the bot tour (and vice versa), while
//    skipping just closes
//  6 the cross-frame handshake: panel -> parent -> board tour
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();

async function landing(shell, width = 1440, height = 900, mobile = false) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
  });
  await ctx.addInitScript(([s]) => {
    try {
      localStorage.setItem('bm_shell', s);
      ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  }, [shell]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errs };
}

console.log('\nBuild-A-Bot landing — knight + watermark');
{
  const { ctx, page, errs } = await landing('pro');

  const t = await page.evaluate(() => {
    const bab = document.querySelector('.lt-bab');
    const mark = document.querySelector('.bab-mark');
    const cs = mark ? getComputedStyle(mark) : null;
    const glint = document.querySelector('.bab-mark .bab-glint');
    return {
      titleText: (bab.textContent || '').trim(),
      titleHasKnight: /♞/.test(bab.textContent || ''),
      titleHasDot: !!bab.querySelector('.cylon-dot'),
      anyTitleDot: !!document.querySelector('.landing-title .cylon-dot'),
      markShown: cs && cs.display !== 'none',
      markW: mark ? Math.round(mark.getBoundingClientRect().width) : 0,
      glintAnim: glint ? getComputedStyle(glint).animationName : '',
      ground: getComputedStyle(document.getElementById('landingOverlay')).backgroundImage,
    };
  });
  ok('title carries the knight', t.titleHasKnight, t.titleText);
  ok('title has NO scanning dot', !t.titleHasDot && !t.anyTitleDot);
  ok('watermark is shown', t.markShown && t.markW > 200, 'width ' + t.markW);
  ok('watermark eye is animating', /babVisorSweep/.test(t.glintAnim), t.glintAnim);
  ok('ground uses the radial lift', /radial-gradient/.test(t.ground), t.ground.slice(0, 60));

  // 3 — copy length. The point of trimming was to leave the watermark room.
  // Own text nodes only: on localhost the multiplayer card nests a "requires
  // the deployed server" note inside its blurb, which production never renders
  // and which would otherwise count against the authored copy.
  const copy = await page.evaluate(() =>
    [...document.querySelectorAll('.landing-card-desc')].map(e =>
      [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().length));
  ok('every card blurb is under 90 chars', copy.every(n => n < 90), JSON.stringify(copy));

  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nBlundermind landing — unchanged');
{
  const { ctx, page } = await landing('amateur');
  const t = await page.evaluate(() => ({
    pawn: /♟/.test(document.querySelector('.lt-bm').textContent || ''),
    markHidden: getComputedStyle(document.querySelector('.bab-mark')).display === 'none',
    ground: getComputedStyle(document.getElementById('landingOverlay')).backgroundImage,
  }));
  ok('title keeps the pawn', t.pawn);
  ok('watermark stays hidden', t.markHidden);
  ok('ground is not the Build-A-Bot lift', !/radial-gradient/.test(t.ground));
  await ctx.close();
}

console.log('\nOverview on the landing');
{
  // The landing overlay is the PRO front door. The two products get different
  // first impressions (00-head.html): buildabotchess/pro opens the full landing,
  // blundermind/amateur opens the live board with #bmWelcome over it, because
  // there the board IS the pitch. So the tour button this section clicks only
  // ever renders on 'pro' — asking for it on 'amateur' waited 30s for a button
  // inside an overlay that is display:none by design, and took the rest of the
  // file down with it.
  const { ctx, page, errs } = await landing('pro');
  ok('the Overview starts hidden',
     await page.evaluate(() => document.getElementById('bmOverview').hidden));
  await page.click('.landing-overview-btn');
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => {
    const el = document.getElementById('bmOverview');
    const txt = n => n.textContent.replace(/\s+/g, ' ').trim();
    return { open: !el.hidden,
             gos: [...el.querySelectorAll('.bmo-go')].map(txt),
             tours: [...el.querySelectorAll('.bmo-tour')].map(txt) };
  });
  ok('the Overview line opens the Overview', shown.open);
  // Build-A-Bot has no Go button onto the bare pro board: it goes into the
  // builder, which runs its own tour the first time it opens.
  ok('it offers Blundermind and the Bot Builder', shown.gos.length === 2 &&
     /Blundermind for visualization training/.test(shown.gos[0]) &&
     /Go to the Bot Builder/.test(shown.gos[1]),
     JSON.stringify(shown.gos));
  ok('and nothing onto the bare pro board', !shown.gos.some(g => /Go to Build-A-Bot pro board/.test(g)),
     JSON.stringify(shown.gos));
  ok('and a tour of each board', shown.tours.length === 2 &&
     /tour of Blundermind visualizations/i.test(shown.tours[0]) && /tour of the pro board/i.test(shown.tours[1]),
     JSON.stringify(shown.tours));

  await page.click('.bmo-back');
  await page.waitForTimeout(150);
  ok('Back closes it and leaves the landing up',
     await page.evaluate(() => document.getElementById('bmOverview').hidden &&
       getComputedStyle(document.getElementById('landingOverlay')).display !== 'none'));

  // Board tour from the Overview.
  await page.click('.landing-overview-btn');
  await page.waitForTimeout(150);
  await page.click(`button[onclick="bmOverviewGo('tour-board')"]`);
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => ({
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
    landing: getComputedStyle(document.getElementById('landingOverlay')).display,
    count: document.getElementById('tourCount').textContent,
    title: document.getElementById('tourTitle').textContent,
    body: document.getElementById('tourBody').textContent,
    hasLandingStep: _tourSteps.some(st => st.landing),
    ringOnStep: (() => {
      const step = _tourSteps[0];
      const el = step && step.sel && document.querySelector(step.sel);
      if (!el) return null;
      const r = document.getElementById('tourRing').getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(r.top - (b.top - 5)) < 3 && Math.abs(r.left - (b.left - 5)) < 3;
    })(),
  }));
  ok('board tour starts', t.overlay === 'block', t.overlay);
  // These five used to assert the opposite: that the tour opened ON the landing
  // with a first step explaining the board choice, ring on the shell picker.
  // landingStartTour changed that deliberately, and says why — staying on the
  // landing after pressing "tour of the visualization board" reads as the tour
  // having failed to start, because the landing is still what fills the screen.
  // It now sets the shell, dismisses the landing, and opens on the board.
  ok('it leaves the landing rather than opening on top of it', t.landing === 'none', t.landing);
  ok('first step is step 1', /^1\s*\/\s*\d+/.test(t.count.trim()), t.count);
  ok('the landing-only step is not in the running order', t.hasLandingStep === false);
  ok('the first step is about the board', !!t.title.trim(), t.title);
  ok("the ring points at that step's own target", t.ringOnStep === true, String(t.ringOnStep));

  const landingGone = () => page.evaluate(() =>
    getComputedStyle(document.getElementById('landingOverlay')).display === 'none');
  await page.evaluate(() => tourNext());
  await page.waitForTimeout(900);
  ok('the landing stays gone as you move on', await landingGone());
  await page.evaluate(() => tourPrev());
  await page.waitForTimeout(800);
  ok('and stepping back does not resurrect it', await landingGone());
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nOverview → the pro board tour, and the Bot Builder');
{
  // From the Visualization board's door (the welcome), so the tour has to
  // switch shells itself: TOURS.pro points at chrome only the pro board has.
  let { ctx, page, errs } = await landing('amateur');
  await page.click('#bmWelcome .bmw-ov');
  await page.waitForTimeout(200);
  await page.click(`button[onclick="bmOverviewGo('tour-pro')"]`);
  await page.waitForTimeout(1100);
  const t = await page.evaluate(() => ({
    pro: proMode, shell: _tourShell, n: _tourSteps.length,
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
    welcome: document.getElementById('bmWelcome').hidden,
  }));
  ok('the pro board tour switches to the pro board', t.pro === true);
  ok('and runs all four of its steps', t.overlay === 'block' && t.shell === 'pro' && t.n === 4, JSON.stringify(t));
  ok('with the welcome gone', t.welcome === true);
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();

  ({ ctx, page, errs } = await landing('pro'));
  await page.click('.landing-overview-btn');
  await page.waitForTimeout(200);
  await page.click(`button[onclick="bmOverviewGo('builder')"]`);
  await page.waitForTimeout(1600);
  const b = await page.evaluate(() => ({
    pro: proMode,
    modal: getComputedStyle(document.getElementById('botModal')).display,
    landing: getComputedStyle(document.getElementById('landingOverlay')).display,
  }));
  ok('Go to the Bot Builder opens the builder', b.modal === 'block', b.modal);
  ok('over the pro board, with the landing gone', b.pro === true && b.landing === 'none', JSON.stringify(b));
  const f = page.frames().find(x => x.url().includes('bot-control-panel'));
  if (f) {
    await page.waitForTimeout(900);
    ok('and the builder runs its own tour on a first visit',
       await f.evaluate(() => getComputedStyle(document.getElementById('botTourOverlay')).display === 'block'));
  } else ok('the panel iframe is present', false);
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nBoard tour outro → offers the bot tour');
{
  const { ctx, page, errs } = await landing('amateur');
  await page.evaluate(() => { landingDismiss(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => startTour());
  await page.waitForTimeout(500);

  // Skipping must NOT offer anything.
  await page.evaluate(() => endTour());
  await page.waitForTimeout(250);
  ok('skipping just closes — no outro',
     await page.evaluate(() => getComputedStyle(document.getElementById('tourOutro')).display === 'none'
                            && getComputedStyle(document.getElementById('tourOverlay')).display === 'none'));

  // Walk to the end.
  await page.evaluate(() => startTour());
  await page.waitForTimeout(400);
  const steps = await page.evaluate(() => _tourSteps.length);
  for (let i = 0; i < steps; i++) { await page.evaluate(() => tourNext()); await page.waitForTimeout(90); }
  await page.waitForTimeout(300);
  const o = await page.evaluate(() => ({
    outro: getComputedStyle(document.getElementById('tourOutro')).display,
    panel: getComputedStyle(document.getElementById('tourPanel')).display,
    board: document.getElementById('tourOutroBoard').textContent,
    bot: document.getElementById('tourOutroBot').textContent,
  }));
  ok('finishing shows the outro', o.outro === 'block', o.outro);
  ok('step panel is swapped out', o.panel === 'none', o.panel);
  ok('it offers the bot builder', /bot builder/i.test(o.bot), o.bot);
  // Finished the Visualization tour, so the board on offer is the Expert one.
  ok('it also offers the OTHER board', /expert board/i.test(o.board), o.board);

  // Restarting must restore the step panel, not leave the outro up.
  await page.evaluate(() => startTour());
  await page.waitForTimeout(300);
  ok('a second run restores the step panel',
     await page.evaluate(() => getComputedStyle(document.getElementById('tourPanel')).display !== 'none'
                            && getComputedStyle(document.getElementById('tourOutro')).display === 'none'));
  await page.evaluate(() => endTour());

  // The handoff itself.
  await page.evaluate(() => startTour());
  await page.waitForTimeout(300);
  for (let i = 0; i < steps; i++) { await page.evaluate(() => tourNext()); await page.waitForTimeout(90); }
  await page.waitForTimeout(250);
  await page.click('#tourOutroBot');
  await page.waitForTimeout(1800);
  const bot = await page.evaluate(() => ({
    modal: getComputedStyle(document.getElementById('botModal')).display,
    outro: getComputedStyle(document.getElementById('tourOutro')).display,
  }));
  ok('handoff opens the bot panel', bot.modal === 'block', bot.modal);
  ok('outro is dismissed on handoff', bot.outro === 'none', bot.outro);

  const f = page.frames().find(x => x.url().includes('bot-control-panel'));
  ok('the panel iframe is present', !!f);
  if (f) {
    await page.waitForTimeout(900);
    ok('the bot tour is running inside it',
       await f.evaluate(() => getComputedStyle(document.getElementById('botTourOverlay')).display === 'block'));
  }
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nBot tour outro → hands back across the frame');
{
  const { ctx, page, errs } = await landing('amateur');
  await page.evaluate(() => { landingDismiss(); openBotModal(); startBotTour(); });
  await page.waitForTimeout(2200);
  const f = page.frames().find(x => x.url().includes('bot-control-panel'));
  ok('bot tour started from the landing path', !!f && await f.evaluate(() =>
     getComputedStyle(document.getElementById('botTourOverlay')).display === 'block'));

  const n = await f.evaluate(() => _bt.length);
  for (let i = 0; i < n; i++) { await f.evaluate(() => tourNext()); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
  const o = await f.evaluate(() => ({
    outro: getComputedStyle(document.getElementById('btOutro')).display,
    panel: getComputedStyle(document.getElementById('btPanel')).display,
    ctas: [...document.querySelectorAll('#btOutro .bt-next')].map(b => b.textContent.trim()),
  }));
  ok('finishing the bot tour shows its outro', o.outro === 'block', o.outro);
  ok('its step panel is swapped out', o.panel === 'none', o.panel);
  ok('it offers BOTH boards', o.ctas.length === 2, JSON.stringify(o.ctas));
  ok('one is Visualization', /visualization/i.test(o.ctas.join(' ')), JSON.stringify(o.ctas));
  ok('one is Expert', /expert/i.test(o.ctas.join(' ')), JSON.stringify(o.ctas));

  // Take the Expert one — it has to switch shells, or its steps get filtered out.
  await f.click('#btOutro .bt-next:nth-of-type(2)');
  await page.waitForTimeout(1600);
  const back = await page.evaluate(() => ({
    modal: getComputedStyle(document.getElementById('botModal')).display,
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
    pro: !!(typeof proMode !== 'undefined' && proMode),
    steps: (typeof _tourSteps !== 'undefined') ? _tourSteps.length : 0,
  }));
  ok('the panel closes', back.modal === 'none', back.modal);
  ok('the board tour takes over', back.overlay === 'block', back.overlay);
  ok('it switched to the Expert shell', back.pro, String(back.pro));
  ok('the Expert tour kept its steps', back.steps > 0, String(back.steps));
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nBot-tour panel must not cover what it describes');
{
  for (const [label, w, h, mob, limit] of [['phone', 390, 844, true, 25], ['desktop', 1440, 900, false, 10]]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mob, hasTouch: mob,
    });
    await ctx.addInitScript(() => { try { localStorage.removeItem('bm_bottour'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const o = document.getElementById('botTourOverlay'); if (o) o.style.display = 'none';
      startTour();
    });
    await page.waitForTimeout(700);
    const n = await page.evaluate(() => _bt.length);
    const bad = [];
    // Wait for the panel to STOP MOVING rather than sleeping a fixed 950ms and
    // hoping. Each step scrolls its target into view and then repositions the
    // panel; measuring mid-flight caught it over the target it was still moving
    // away from, so this assertion failed on roughly every other run — at a
    // different step each time, which is the signature of a race, not a layout
    // bug. (It only started showing up because the file used to die before
    // reaching this section at all.)
    // Two matching reads is not enough: the panel sits still for a moment BEFORE
    // its step transition starts, so a naive stability check returns during that
    // lull and measures the OLD position — which made this worse, not better.
    // Require the position to hold across several consecutive samples, after
    // giving the transition time to begin. Verified against a deliberately
    // generous 3s-per-step run, where no step exceeds its limit at all: the
    // overlaps this used to report were never a layout fault.
    const STILL_FOR = 4;      // consecutive identical samples
    const settle = async () => {
      await page.waitForTimeout(320);   // let the transition actually start
      let last = null, same = 0;
      for (let tries = 0; tries < 60; tries++) {
        const now = await page.evaluate(() => {
          const b = document.getElementById('btPanel').getBoundingClientRect();
          return [Math.round(b.top), Math.round(b.left), Math.round(b.height), Math.round(window.scrollY)].join(',');
        });
        same = (now === last) ? same + 1 : 0;
        if (same >= STILL_FOR) return;
        last = now;
        await page.waitForTimeout(90);
      }
    };
    for (let i = 0; i < n; i++) {
      await settle();
      const r = await page.evaluate(() => {
        const s = _bt[_btIdx];
        const el = s.sel ? document.querySelector(s.sel) : null;
        if (!el) return { i: _btIdx, sel: '(none)', ov: 0, tall: false };
        const p = document.getElementById('btPanel').getBoundingClientRect();
        const t = el.getBoundingClientRect();
        const ox = Math.max(0, Math.min(p.right, t.right) - Math.max(p.left, t.left));
        const oy = Math.max(0, Math.min(p.bottom, t.bottom) - Math.max(p.top, t.top));
        return { i: _btIdx, sel: s.sel, tall: t.height > window.innerHeight - p.height - 40,
                 ov: Math.round(ox * oy / Math.max(1, t.width * t.height) * 100) };
      });
      // A target taller than the free band cannot be cleared by any placement;
      // what matters there is that its heading stays visible, not the percentage.
      if (r.ov > limit && !r.tall) bad.push(`${r.i}:${r.sel} ${r.ov}%`);
      await page.evaluate(() => { if (_btIdx < _bt.length - 1) tourNext(); });
    }
    ok(`${label}: no step is covered by its own description`, bad.length === 0, bad.join(' | '));
    await ctx.close();
  }
}

console.log('\nPhone — 390x844');
{
  const { ctx, page, errs } = await landing('pro', 390, 844, true);
  const p = await page.evaluate(() => {
    const b = document.querySelector('.landing-overview-btn');
    const mark = document.querySelector('.bab-mark');
    return {
      btnH: Math.round(b.getBoundingClientRect().height),
      btnFs: parseFloat(getComputedStyle(b).fontSize),
      markScaled: getComputedStyle(mark).transform,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  ok('Overview line is a 44px target', p.btnH >= 44, String(p.btnH));
  ok('its label clears the 11px floor', p.btnFs >= 11, String(p.btnFs));
  ok('watermark is scaled down', p.markScaled !== 'none', p.markScaled);
  ok('no horizontal overflow', !p.overflow);

  await page.click('.landing-overview-btn');
  await page.waitForTimeout(250);
  const opts = await page.evaluate(() => ({
    hs: [...document.querySelectorAll('#bmOverview .bmo-go, #bmOverview .bmo-tour')].map(o => Math.round(o.getBoundingClientRect().height)),
    over: document.getElementById('bmOverview').scrollWidth > window.innerWidth }));
  ok('every Overview action is a 44px target', opts.hs.length === 4 && opts.hs.every(h => h >= 44), JSON.stringify(opts.hs));
  ok('the Overview has no horizontal overflow', !opts.over);
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

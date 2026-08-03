// Landing knight watermark + the two guided tours. Server on :3100, run from
// the repo root:  node scripts/verify-landing-tour.mjs
//
//  1 Build-A-Bot landing shows the knight, and the scanning eye is on the
//    watermark only — never on the title glyph as well
//  2 Blundermind landing is untouched: pawn title, no watermark
//  3 the landing copy is short enough to leave the watermark room
//  4 "Take a guided tour" asks which one, and both options start a tour
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

console.log('\nTour picker on the landing');
{
  const { ctx, page, errs } = await landing('amateur');
  ok('picker starts hidden',
     await page.evaluate(() => document.getElementById('landingTourPick').hasAttribute('hidden')));
  await page.click('.landing-tour-btn');
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => {
    const el = document.getElementById('landingTourPick');
    return { open: !el.hasAttribute('hidden'),
             opts: [...el.querySelectorAll('.ltp-opt')].map(o => o.textContent.replace(/\s+/g, ' ').trim()) };
  });
  ok('tapping the tour line opens the picker', shown.open);
  ok('it offers exactly two tours', shown.opts.length === 2, JSON.stringify(shown.opts));
  ok('one is the board', /visualization/i.test(shown.opts.join(' ')));
  ok('one is the bot builder', /bot-building/i.test(shown.opts.join(' ')));

  await page.click('.ltp-cancel');
  await page.waitForTimeout(150);
  ok('"Not now" closes it',
     await page.evaluate(() => document.getElementById('landingTourPick').hasAttribute('hidden')));

  // Board tour from the picker.
  await page.click('.landing-tour-btn');
  await page.waitForTimeout(150);
  await page.evaluate(() => landingStartTour('board'));
  await page.waitForTimeout(1400);
  const t = await page.evaluate(() => ({
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
    landing: getComputedStyle(document.getElementById('landingOverlay')).display,
    count: document.getElementById('tourCount').textContent,
  }));
  ok('board tour starts', t.overlay === 'block', t.overlay);
  ok('landing is dismissed', t.landing === 'none', t.landing);
  ok('it is on a real step', /\d+\s*\/\s*\d+/.test(t.count), t.count);
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
    cta: (document.querySelector('#tourOutro .tour-next') || {}).textContent || '',
  }));
  ok('finishing shows the outro', o.outro === 'block', o.outro);
  ok('step panel is swapped out', o.panel === 'none', o.panel);
  ok('it offers the bot builder', /bot builder/i.test(o.cta), o.cta);

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
  await page.click('#tourOutro .tour-next');
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
    cta: (document.querySelector('#btOutro .bt-next') || {}).textContent || '',
  }));
  ok('finishing the bot tour shows its outro', o.outro === 'block', o.outro);
  ok('its step panel is swapped out', o.panel === 'none', o.panel);
  ok('it offers the board', /board/i.test(o.cta), o.cta);

  await f.click('#btOutro .bt-next');
  await page.waitForTimeout(1200);
  const back = await page.evaluate(() => ({
    modal: getComputedStyle(document.getElementById('botModal')).display,
    overlay: getComputedStyle(document.getElementById('tourOverlay')).display,
  }));
  ok('the panel closes', back.modal === 'none', back.modal);
  ok('the board tour takes over', back.overlay === 'block', back.overlay);
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nPhone — 390x844');
{
  const { ctx, page, errs } = await landing('pro', 390, 844, true);
  const p = await page.evaluate(() => {
    const b = document.querySelector('.landing-tour-btn');
    const mark = document.querySelector('.bab-mark');
    return {
      btnH: Math.round(b.getBoundingClientRect().height),
      btnFs: parseFloat(getComputedStyle(b).fontSize),
      markScaled: getComputedStyle(mark).transform,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  ok('tour line is a 44px target', p.btnH >= 44, String(p.btnH));
  ok('its label clears the 11px floor', p.btnFs >= 11, String(p.btnFs));
  ok('watermark is scaled down', p.markScaled !== 'none', p.markScaled);
  ok('no horizontal overflow', !p.overflow);

  await page.click('.landing-tour-btn');
  await page.waitForTimeout(250);
  const opts = await page.evaluate(() =>
    [...document.querySelectorAll('.ltp-opt')].map(o => Math.round(o.getBoundingClientRect().height)));
  ok('both tour options are 44px targets', opts.length === 2 && opts.every(h => h >= 44), JSON.stringify(opts));
  ok('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

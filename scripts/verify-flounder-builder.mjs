// The builder, after Flounder replaced the Stockfish bots.
//
// Five engine cards were never five engines: they were two engines, each with
// or without an opening book, plus a blend. This checks that the three cards
// and the book toggle reach every one of the five modes the app still speaks,
// that the shared Elometer re-brands and re-ranges with the engine, and that a
// bot saved under the old shape still opens at the strength it played at.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch();
let PANEL_C = null;   // the panel's T -> c map, checked against the engine's below

// ── The panel on its own ────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:3100/bot-control-panel.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  console.log('\n1   Three cards and a toggle, not five cards');
  {
    const r = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('#engine-mode-grid .mcard')].map(c => c.dataset.engine),
      names: [...document.querySelectorAll('#engine-mode-grid .mname')].map(c => c.textContent.trim()),
      book: !!document.getElementById('engine-book-cb'),
    }));
    ok('exactly three engine cards', r.cards.length === 3, r.cards.join(','));
    ok('and they are Maia, Flounder, Hybrid',
      r.cards.join(',') === 'maia3,stockfish,hybrid', r.cards.join(','));
    ok('the Stockfish card is called Flounder',
      r.names.some(n => /^Flounder/.test(n)), r.names.join(' | '));
    ok('the opening book is its own control', r.book);
    // It was a full-width segmented bar, which at that width read as a heading
    // with two words in it rather than as something you could press. It is set
    // at the same weight as the engine names because it decides where the moves
    // come from for the whole first phase of the game.
    ok('and is weighted like an engine name, not a caption',
      await page.evaluate(() =>
        getComputedStyle(document.querySelector('.ob-lbl')).fontSize ===
        getComputedStyle(document.querySelector('#engine-mode-grid .mname')).fontSize),
      await page.evaluate(() => getComputedStyle(document.querySelector('.ob-lbl')).fontSize));
  }

  console.log('\n2   The three controls reach all five engine modes');
  {
    const r = await page.evaluate(() => {
      const pick = e => {
        const c = document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]');
        selEngineMode(c);
      };
      const out = {};
      pick('maia3');     setEngineBook('off'); out.maia3 = currentEngine;
      /* book on */      setEngineBook('on');  out.lcmaia = currentEngine;
      pick('stockfish'); setEngineBook('off'); out.stockfish = currentEngine;
      /* book on */      setEngineBook('on');  out.lcsf = currentEngine;
      pick('hybrid');                          out.hybrid = currentEngine;
      out.bookRowShown = getComputedStyle(document.getElementById('engine-book-row')).display !== 'none';
      return out;
    });
    ok('Maia, book off  -> maia3',     r.maia3 === 'maia3', r.maia3);
    ok('Maia, book on   -> lcmaia',    r.lcmaia === 'lcmaia', r.lcmaia);
    ok('Flounder, off   -> stockfish', r.stockfish === 'stockfish', r.stockfish);
    ok('Flounder, on    -> lcsf',      r.lcsf === 'lcsf', r.lcsf);
    ok('Hybrid          -> hybrid',    r.hybrid === 'hybrid', r.hybrid);
    // The book is not an engine — it sits in front of whichever one the blend
    // draws — so there was never a reason a mixed bot could not have one.
    ok('and a blend is offered the book too', r.bookRowShown);
  }

  const ENGINE_RANGE = await page.evaluate(() => {
  selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
  return engineEloRange();
});

console.log('\n3   One Elometer, wearing the selected engine');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      const read = () => ({
        brand: document.getElementById('speedo-brand').textContent,
        lbl: document.getElementById('eng-elo-lbl').textContent,
        min: SPEEDO.min, max: SPEEDO.max,
        inpMin: +document.getElementById('elo-input').min,
        inpMax: +document.getElementById('elo-input').max,
        maiaCredit: getComputedStyle(document.getElementById('eng-credit-maia')).display !== 'none',
        flCredit: getComputedStyle(document.getElementById('eng-credit-flounder')).display !== 'none',
      });
      pick('maia3');     const m = read();
      pick('stockfish'); const f = read();
      return { m, f };
    });
    ok('Maia brands it Maia', /Maia/.test(r.m.brand), r.m.brand);
    ok('Flounder brands it Flounder', /Flounder/.test(r.f.brand), r.f.brand);
    // The FACE is identical on both, so a rating sits at the same place on the
    // arc whichever engine is selected — they are the same quantity and should
    // not look like two different ones. Only the reachable span differs.
    ok('the markings never move', r.m.min === 600 && r.m.max === 2600 &&
      r.f.min === 600 && r.f.max === 2600,
      r.m.min + '-' + r.m.max + ' / ' + r.f.min + '-' + r.f.max);
    ok('the typed input follows the engine reach',
      r.f.inpMin === ENGINE_RANGE.lo && r.f.inpMax === ENGINE_RANGE.hi,
      r.f.inpMin + '-' + r.f.inpMax);
    ok('Maia carries the maiachess credit', r.m.maiaCredit && !r.m.flCredit);
    ok('Flounder carries the Stockfish credit', r.f.flCredit && !r.f.maiaCredit);
  }

  console.log('\n4   A rating outside the reachable span is pulled in, not kept');
  {
    const r = await page.evaluate(() => {
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      setElo(2600);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      const high = currentElo;
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      setElo(600);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      const low = currentElo;
      const lockHi = getComputedStyle(document.getElementById('speedo-locked-hi')).display !== 'none';
      const lockLo = getComputedStyle(document.getElementById('speedo-locked-lo')).display !== 'none';
      return { high, low, lockHi, lockLo };
    });
    ok('a rating above the reach comes back to the top of it',
      r.high === ENGINE_RANGE.hi, String(r.high));
    ok('and one below it, to the bottom', r.low === ENGINE_RANGE.lo, String(r.low));
    ok('the unreachable span is drawn rather than silently absent',
      (ENGINE_RANGE.hi < 2600) === r.lockHi && (ENGINE_RANGE.lo > 600) === r.lockLo,
      'hi:' + r.lockHi + ' lo:' + r.lockLo);
  }

  console.log('\n5   The download overlay belongs to Maia, not to the dial');
  {
    const r = await page.evaluate(() => {
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      bcpMaiaSetStatus('no-cache', false);   // a private window, or a first visit
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      const onMaia = shown('bcp-speedo-overlay');
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      const onFlounder = shown('bcp-speedo-overlay');
      // The overlay's PARENT carries .overlay-on, and that class hides the dial
      // itself. Hiding only the overlay element left an empty box where the
      // Elometer should be — invisible on any machine with Maia already cached,
      // which is why it shipped.
      const dialUp = shown('speedo-svg');
      const wrapCls = document.getElementById('bcp-speedo-overlay').parentElement.className;
      return { onMaia, onFlounder, dialUp, wrapCls };
    });
    ok('with no model, Maia asks for the download', r.onMaia);
    ok('but Flounder never does — it has nothing to download', !r.onFlounder);
    ok('and the Elometer is actually on screen for it', r.dialUp, r.wrapCls);
  }

  console.log('\n6   Save and load survive the new shape');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      // Flounder + book, at a rating
      pick('stockfish'); setEngineBook('on'); setElo(1725);
      const saved = getBotConfig();
      // Scramble, then load it back
      pick('maia3'); setEngineBook('off'); setElo(900);
      applyBotConfig(saved);
      const back = { engine: currentEngine, base: baseEngine, book: engineBook, elo: currentElo };
      // A bot saved before the dial existed: level only, no flounderElo
      applyBotConfig({ engine: 'stockfish', sfLevel: 5, elo: 1500 });
      const legacy = { base: baseEngine, elo: currentElo };
      return { saved, back, legacy };
    });
    ok('a Flounder bot emits its rating', r.saved.flounderElo === 1725, String(r.saved.flounderElo));
    ok('and emits the mode the app speaks', r.saved.engine === 'lcsf', r.saved.engine);
    ok('loading it restores the engine', r.back.engine === 'lcsf', r.back.engine);
    ok('...as the card plus the toggle', r.back.base === 'stockfish' && r.back.book === 'on',
      r.back.base + '/' + r.back.book);
    ok('...at the rating it was saved with', r.back.elo === 1725, String(r.back.elo));
    ok('a pre-dial bot opens at the strength it played at',
      r.legacy.base === 'stockfish' && r.legacy.elo === 1575,
      r.legacy.base + ' @ ' + r.legacy.elo);
  }

  console.log('\n6b  The temperature control names c on Flounder, at both ends');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      const read = () => ({
        lo: document.getElementById('temp-end-lo').textContent,
        hi: document.getElementById('temp-end-hi').textContent,
        bTitle: document.getElementById('tp-b-title').textContent,
        axis1: _curveBFmt()(1.0), axis3: _curveBFmt()(3.0),
        mark: document.getElementById('maxtemp-track').title,
      });
      pick('stockfish'); setElo(1600); onTempSlider(1.0);
      const fl = read();
      pick('maia3'); onTempSlider(1.0);
      const ma = read();
      // Both documents carry their own copy of the T -> c map. If they ever
      // drift, the panel draws a bot that is not the one that plays.
      const panelC = [0.3, 1.0, 2.0, 3.0].map(t => +_panelFlounderC(t).toFixed(6));
      return { fl, ma, panelC, elo: 1600 };
    });
    PANEL_C = r.panelC;
    ok('the low end names the tail, not the slider', /Tighter tail/.test(r.fl.lo), r.fl.lo);
    ok('and so does the high end', /Thicker tail/.test(r.fl.hi), r.fl.hi);
    ok('Maia keeps its own ends', r.ma.lo === '\u25b2 Top move' && r.ma.hi === '4.0 \u25b2',
      r.ma.lo + ' | ' + r.ma.hi);
    ok('the degradation curve is titled in c', /Error shape/.test(r.fl.bTitle), r.fl.bTitle);
    ok('its axis reads c, and falls as the tail thickens',
      +r.fl.axis3 < +r.fl.axis1 && +r.fl.axis1 < 1, r.fl.axis1 + ' -> ' + r.fl.axis3);
    ok('Maia keeps T on the same axis', r.ma.axis1 === '1.0', r.ma.axis1);
    ok('the game-start marker names c too', /c 0\./.test(r.fl.mark), r.fl.mark);
  }

  console.log('\n6c  A blend shows the picture of what is actually in its slots');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      pick('hybrid');
      const out = {};
      hybridSlots = [{type:'maia',elo:1500,pct:50},{type:'sf',flounderElo:1200,pct:50}];
      out.mixed = _chartEngine();
      hybridSlots = [{type:'sf',flounderElo:1400,pct:60},{type:'sf',flounderElo:2000,pct:40}];
      out.allFlounder = _chartEngine();
      out.blendElo = _chartFlounderElo();
      hybridSlots = [{type:'maia',elo:1500,pct:100}];
      out.allMaia = _chartEngine();
      hybridSlots = [{type:'maia',elo:1500,pct:50},{type:'sf',flounderElo:1600,pct:50}];
      out.lead = _tempLabel(1.0).lead;
      // hybrid + book has to survive a save and load, because 'hybrid' cannot
      // encode the book in the engine mode the way lcsf and lcmaia do.
      setEngineBook('on');
      const saved = getBotConfig();
      setEngineBook('off'); pick('maia3');
      applyBotConfig(saved);
      out.restored = { base: baseEngine, book: engineBook, emitted: saved.openingBook };
      return out;
    });
    ok('a mixed blend draws the Maia picture', r.mixed === 'maia', r.mixed);
    ok('an all-Flounder blend draws the Flounder one', r.allFlounder === 'flounder', r.allFlounder);
    ok('an all-Maia blend draws Maia', r.allMaia === 'maia', r.allMaia);
    ok('at the blend of its own slot ratings', r.blendElo === 1640, String(r.blendElo));
    ok('and the readout names both parameters', /T\s*=\s*[\d.]+[\s\S]*c\s*=\s*[\d.]+/.test(r.lead), r.lead);
    ok('hybrid + book survives save and load',
      r.restored.base === 'hybrid' && r.restored.book === 'on' && r.restored.emitted === true,
      JSON.stringify(r.restored));
  }

  console.log('\n6d  The start bar does not move when the engine does');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      const zone = () => +document.querySelector('.qs-engine-zone')
        .getBoundingClientRect().width.toFixed(1);
      const seen = [];
      pick('maia3');     setEngineBook('off'); setElo(1500); seen.push(zone());
      pick('stockfish'); setEngineBook('on');  setElo(2400); seen.push(zone());
      pick('hybrid');                                        seen.push(zone());
      const pill = document.getElementById('qs-engine-pill');
      return { seen, clipped: pill.scrollWidth > pill.clientWidth + 1 };
    });
    ok('the engine zone is the same width whatever is selected',
      r.seen.every(w => w === r.seen[0]), r.seen.join(' / '));
    ok('and the longest label still fits inside it', !r.clipped);
  }

  console.log('\n7   Personality is no longer switched off by the engine');
  {
    const r = await page.evaluate(() => {
      const pick = e => selEngineMode(
        document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
      pick('stockfish'); setEngineBook('off');
      return { fl: personalityEngineState() };
    });
    ok('Flounder reports personality active', r.fl === 'full', r.fl);
  }

  ok('no page errors in the panel', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

// ── Panel to app ────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

  console.log('\n8   A Flounder bot built in the panel arrives at its rating');
  {
    const r = await page.evaluate(async () => {
      window.postMessage({ type: 'botConfig', engine: 'stockfish', flounderElo: 1725,
                           elo: 1725, sfLevel: 5, color: 'white', _applyOnly: true },
                         location.origin);
      await new Promise(r => setTimeout(r, 400));
      return { tab: botTab, dial: flounderSliderElo(), eff: botEffectiveElo(),
               shown: document.getElementById('flounderEloVal').textContent };
    });
    ok('the Flounder tab is selected', r.tab === 'sf', r.tab);
    ok('the dial holds the rating', r.dial === 1725, String(r.dial));
    ok('the bot plays at it', r.eff === 1725, String(r.eff));
    ok('and the panel reads it back', r.shown === '1725', r.shown);
  }

  console.log('\n8b  The panel and the engine agree on the T -> c map');
  {
    const engineC = await page.evaluate(() =>
      [0.3, 1.0, 2.0, 3.0].map(t => +flounderTempAdjustedC(
        Math.max(0.28, Math.min(0.55, 0.436 + (1600 - 1600) * 0.00007)), t).toFixed(6)));
    ok('the two copies of the map match', PANEL_C &&
      engineC.every((v, i) => Math.abs(v - PANEL_C[i]) < 1e-6),
      JSON.stringify(PANEL_C) + ' vs ' + JSON.stringify(engineC));
  }

  console.log('\n9   An old share link still lands somewhere sane');
  {
    const r = await page.evaluate(async () => {
      window.postMessage({ type: 'botConfig', engine: 'stockfish', sfLevel: 5,
                           elo: 1500, color: 'white', _applyOnly: true }, location.origin);
      await new Promise(r => setTimeout(r, 400));
      return { tab: botTab, dial: flounderSliderElo() };
    });
    ok('a level-only config converts rather than defaulting',
      r.tab === 'sf' && r.dial === 1575, r.tab + ' @ ' + r.dial);
  }

  ok('no page errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

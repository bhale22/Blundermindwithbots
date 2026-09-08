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
      book: !!document.getElementById('engine-book-seg'),
    }));
    ok('exactly three engine cards', r.cards.length === 3, r.cards.join(','));
    ok('and they are Maia, Flounder, Hybrid',
      r.cards.join(',') === 'maia3,stockfish,hybrid', r.cards.join(','));
    ok('the Stockfish card is called Flounder',
      r.names.some(n => /^Flounder/.test(n)), r.names.join(' | '));
    ok('the opening book is its own control', r.book);
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
      out.bookRowHidden = getComputedStyle(document.getElementById('engine-book-row')).display === 'none';
      return out;
    });
    ok('Maia, book off  -> maia3',     r.maia3 === 'maia3', r.maia3);
    ok('Maia, book on   -> lcmaia',    r.lcmaia === 'lcmaia', r.lcmaia);
    ok('Flounder, off   -> stockfish', r.stockfish === 'stockfish', r.stockfish);
    ok('Flounder, on    -> lcsf',      r.lcsf === 'lcsf', r.lcsf);
    ok('Hybrid          -> hybrid',    r.hybrid === 'hybrid', r.hybrid);
    ok('and a blend has no book toggle to get wrong', r.bookRowHidden);
  }

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
    ok('and spans the range the network was conditioned over',
      r.m.min === 600 && r.m.max === 2600, r.m.min + '-' + r.m.max);
    ok('Flounder brands it Flounder', /Flounder/.test(r.f.brand), r.f.brand);
    ok('and stops at the measured range',
      r.f.min === 750 && r.f.max === 2400, r.f.min + '-' + r.f.max);
    ok('the typed input agrees with the dial',
      r.f.inpMin === 750 && r.f.inpMax === 2400, r.f.inpMin + '-' + r.f.inpMax);
    ok('Maia carries the maiachess credit', r.m.maiaCredit && !r.m.flCredit);
    ok('Flounder carries the Stockfish credit', r.f.flCredit && !r.f.maiaCredit);
  }

  console.log('\n4   A rating outside the new range is pulled in, not kept');
  {
    const r = await page.evaluate(() => {
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      setElo(2600);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      const high = currentElo;
      setElo(750);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      setElo(600);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      return { high, low: currentElo };
    });
    ok('Maia 2600 becomes Flounder 2400', r.high === 2400, String(r.high));
    ok('Maia 600 becomes Flounder 750', r.low === 750, String(r.low));
  }

  console.log('\n5   The download overlay belongs to Maia, not to the dial');
  {
    const r = await page.evaluate(() => {
      bcpMaiaSetStatus('no-cache', false);
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
      const onMaia = getComputedStyle(document.getElementById('bcp-speedo-overlay')).display !== 'none';
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
      const onFlounder = getComputedStyle(document.getElementById('bcp-speedo-overlay')).display !== 'none';
      return { onMaia, onFlounder };
    });
    ok('with no model, Maia asks for the download', r.onMaia);
    ok('but Flounder never does — it has nothing to download', !r.onFlounder);
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

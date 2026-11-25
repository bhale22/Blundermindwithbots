// Confounder / Simplifier and Sharp / Drawish (Nov 2026), in the browser with
// the real Maia 3 model: the builder's rows, the batched Maia look at the
// positions the candidates leave (maia3ChildStats), the scoring on what it
// returns, and live games on Maia and on Flounder with the traits on.
//
// Run with the dev server up on :3100:
//   node scripts/verify-maia-child-traits.mjs
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

console.log('\n1   The builder');
{
  const panel = await ctx.newPage();
  const errs = [];
  panel.on('pageerror', e => errs.push(e.message));
  await panel.goto('http://localhost:3100/bot-control-panel.html', { waitUntil: 'networkidle' });
  await panel.waitForTimeout(600);
  const r = await panel.evaluate(() => {
    const txt = (document.getElementById('attractor-rows') || document.body).textContent;
    onAttractorChange('entropy', 3);
    onAttractorChange('sharpness', -2);
    const cfg = getBotConfig();
    return {
      rows: ['Confounder', 'Simplifier', 'Sharp', 'Drawish'].filter(w => txt.includes(w)),
      av: { entropy: cfg.attractorValues.entropy, sharpness: cfg.attractorValues.sharpness },
      desc: typeof ATTRACTOR_DESCS !== 'undefined' && !!ATTRACTOR_DESCS.entropy && !!ATTRACTOR_DESCS.sharpness,
      budgetless: BUDGETLESS_ATTRACTORS.includes('entropy') || BUDGETLESS_ATTRACTORS.includes('sharpness'),
    };
  });
  ok('the builder has Confounder · Simplifier and Sharp · Drawish rows', r.rows.length === 4, r.rows);
  ok('their values are saved with the bot', r.av.entropy === 3 && r.av.sharpness === -2, r.av);
  ok('each has its description', r.desc);
  ok('both take a share of the CP Budget (they score moves)', !r.budgetless);
  ok('no page errors in the builder', errs.length === 0, errs);
  await panel.close();
}

const page = await ctx.newPage();
const errs = [], logs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (/Confounder\/Sharp/.test(m.text())) logs.push(m.text()); });
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => { if (!sfReady) await sfInit(); if (!_maiaReady) await maiaDownloadModel(); });
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, { timeout: 900000 });

console.log('\n2   Maia after each candidate, and the scoring on it');
{
  const FEN = 'r1bq1rk1/pp3ppp/2nbpn2/3p4/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 8';
  const r = await page.evaluate(async (fen) => {
    lcSelectedRating = '1500';
    const probs = await maia3GetMoveProbs(fen, 1500);
    board = parseFen(fen);
    botPlayerColor = 'black';
    window._bcpPieceValues = {}; window._bcpCustomControls = []; window._bcpCpBudget = 150;
    botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
    const out = {};
    for (const [name, av] of [['conf', { entropy: 5 }], ['simp', { entropy: -5 }], ['sharp', { sharpness: 5 }], ['drawish', { sharpness: -5 }]]) {
      window._bcpAttractorValues = av;
      _maiaChild = null;
      const order = _maiaChildOrder(probs);
      await botMaiaChildProbe(fen, order, 1500);
      const st = _maiaChildNow();
      const shaped = applyMoveAttractors(Object.assign({}, probs));
      const tilt = m => shaped[m] / probs[m];
      const probed = order.filter(m => st && st[m] && !st[m].terminal);
      const byTilt = [...probed].sort((a, b) => tilt(b) - tilt(a));
      out[name] = { n: probed.length, top: byTilt[0], bottom: byTilt[byTilt.length - 1],
        stats: st ? Object.fromEntries(probed.map(m => [m, { h: +st[m].h.toFixed(2), d: +st[m].draw.toFixed(4) }])) : null };
    }
    return out;
  }, FEN);
  const argmax = (st, f) => Object.keys(st).sort((a, b) => f(st[b]) - f(st[a]))[0];
  const argmin = (st, f) => Object.keys(st).sort((a, b) => f(st[a]) - f(st[b]))[0];
  ok('Maia was read after ' + r.conf.n + ' candidates (most popular, to 90% or 8)', r.conf.n >= 2 && r.conf.n <= 8, r.conf.n);
  ok('Confounder tilts most toward the move leaving the opponent the most entropy (' + r.conf.top + ')',
    r.conf.top === argmax(r.conf.stats, s => s.h), r.conf.stats);
  ok('Simplifier toward the one leaving the least (' + r.simp.top + ')', r.simp.top === argmin(r.simp.stats, s => s.h));
  ok('Sharp toward the lowest draw chance (' + r.sharp.top + ')', r.sharp.top === argmin(r.sharp.stats, s => s.d), r.sharp.stats);
  ok('Drawish toward the highest (' + r.drawish.top + ')', r.drawish.top === argmax(r.drawish.stats, s => s.d));
  ok('the probe says what it did in the console', logs.some(l => /Maia read \d+ positions after the candidates in \d+ ms/.test(l)), logs.slice(-2));
}

// A short game against random replies, the bot on the given engine with the
// traits on. Returns the moves played and the probe's log lines.
async function playGame(engineCfg, plies) {
  logs.length = 0;
  return page.evaluate(async ([engineCfg, plies]) => {
    const cfg = Object.assign({
      timingMode: 'instant', color: 'black', tcTime: 0, tcInc: 0, cpBudget: 150, convictionPct: 100,
      attractorValues: { entropy: 5, sharpness: 3 }, pieceValues: {},
    }, engineCfg);
    botApplyPanelConfig(cfg, true);
    botColorPref = 'white';   // the human plays White
    botSelectedTC = 'untimed';
    botStart();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const t0 = Date.now();
    while (gameMovesAlgebraic.length < plies && !gameOver && Date.now() - t0 < 120000) {
      if (turn === 'w' && !botThinking) {
        const all = allLegalMoves(board, turn, epSq, castling);
        if (!all.length) break;
        const mv = all[Math.floor(Math.random() * all.length)];
        executeMove(mv.from, mv.to, null);   // a promotion piece only for a promotion: 'Q' on a plain move records c2c4q
      }
      await sleep(150);
    }
    return { plies: gameMovesAlgebraic.length, engine: botTab, av: window._bcpAttractorValues };
  }, [engineCfg, plies]);
}

console.log('\n3   A game on Maia with Confounder +5 and Sharp +3');
{
  const g = await playGame({ engine: 'maia3', elo: 1500 }, 12);
  const reads = logs.filter(l => /Maia read/.test(l)).length;
  ok('the bot played its moves (' + g.plies + ' plies on ' + g.engine + ')', g.plies >= 12, g);
  ok('Maia was read after the candidates on its turns (' + reads + ' times)', reads >= 4, logs.slice(0, 3));
}

console.log('\n4   A game on Flounder with the same traits');
{
  const g = await playGame({ engine: 'stockfish', flounderElo: 1500 }, 12);
  const reads = logs.filter(l => /Maia read/.test(l)).length;
  ok('the bot played its moves (' + g.plies + ' plies on ' + g.engine + ')', g.plies >= 12, g);
  ok('Maia was read on Flounder\'s turns too (' + reads + ' times)', reads >= 3, logs.slice(0, 3));
}

ok('no page errors', errs.length === 0, errs);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

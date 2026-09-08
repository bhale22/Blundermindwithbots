// Does our implementation of the Regan curve reproduce the paper's numbers?
//
// Regan & Haworth report, for an agent fitted at each Elo, the rate at which
// it plays the engine's top move ("move match"). If our sfReganProbs assigns
// the top move roughly that much probability, the curve, the scaling and the
// (s, c) interpolation are all wired up right. If it does not, one of them is
// wrong and the model is decoration.
//
// Paper, 2006-2009 table (mma column): 2700 56.3%, 2400 51.8%, 2000 46.1%,
// 1800 45.4%, 1600 42.9%.
//
// Positions are sampled the way the paper sampled them: past the opening
// (turns 1-8 skipped) and excluding positions more than 3 pawns lopsided.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const ELOS = [2700, 2400, 2000, 1800, 1600];
const PAPER = { 2700: 56.3, 2400: 51.8, 2000: 46.1, 1800: 45.4, 1600: 42.9 };
const NPOS = Number(process.argv[2] || 24);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => {
  if (typeof sfInit === 'function' && !sfReady) { try { await sfInit(); } catch (e) {} }
});
await page.waitForFunction(() => typeof sfReady !== 'undefined' && sfReady, { timeout: 60000 });

// Build a pool of middlegame positions.
process.stdout.write(`Collecting ${NPOS} middlegame positions... `);
const fens = await page.evaluate(async (NPOS) => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
  const mat = (b, c) => { let m = 0; for (let s = 0; s < 64; s++) { const p = b[s]; if (p && p.color === c) m += VAL[p.piece] || 0; } return m; };
  const out = [];
  let guard = 0;
  while (out.length < NPOS && guard++ < 12) {
    let bd = parseFen(START), tn = 'w', ep = -1;
    let cst = { wK: true, wQ: true, bK: true, bQ: true };
    for (let i = 0; i < 46 && out.length < NPOS; i++) {
      const opts = [];
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq]; if (!p || p.color !== tn) continue;
        for (const d of legalMovesFor(sq, bd, ep, cst)) opts.push([sq, d]);
      }
      if (!opts.length) break;
      // Mostly engine moves so positions are sane; some noise so games differ.
      let f, t;
      if (Math.random() < 0.25) { [f, t] = opts[Math.floor(Math.random() * opts.length)]; }
      else {
        const uci = await sfGetMove(boardToFen(bd, tn, cst, ep), 6);
        if (!uci || uci === '(none)') break;
        f = fileRankToSq(uci.slice(0, 2)); t = fileRankToSq(uci.slice(2, 4));
        if (!bd[f]) break;
      }
      const ne = computeEP(f, t, bd);
      cst = updateCastling(f, t, bd[f], cst);
      bd = applyMove(f, t, bd, ep, 'Q'); ep = ne; tn = tn === 'w' ? 'b' : 'w';
      // The paper's sampling rules: past turn 8, not already lopsided.
      if (i >= 16 && Math.abs(mat(bd, 'w') - mat(bd, 'b')) <= 3) {
        out.push(boardToFen(bd, tn, cst, ep));
      }
    }
  }
  return out;
}, NPOS);
console.log(fens.length + ' collected.\n');

console.log('Elo  |  top-move prob   paper   diff  |  mean legal  probe ms');
console.log('-----+--------------------------------+---------------------');

let worst = 0;
for (const elo of ELOS) {
  const r = await page.evaluate(async ({ elo, fens }) => {
    let sum = 0, n = 0, moves = 0, ms = 0, fails = 0;
    for (const fen of fens) {
      const t0 = Date.now();
      const probs = await sfReganProbs(fen, elo);
      ms += Date.now() - t0;
      if (!probs) { fails++; continue; }
      const vals = Object.values(probs);
      sum += Math.max(...vals);
      moves += vals.length;
      n++;
    }
    return { top: n ? 100 * sum / n : 0, n, moves: n ? moves / n : 0, ms: n ? ms / n : 0, fails };
  }, { elo, fens });

  const diff = r.top - PAPER[elo];
  worst = Math.max(worst, Math.abs(diff));
  console.log(
    String(elo).padStart(4) + ' |' +
    (r.top.toFixed(1) + '%').padStart(15) +
    (PAPER[elo].toFixed(1) + '%').padStart(9) +
    ((diff >= 0 ? '+' : '') + diff.toFixed(1)).padStart(7) + '  |' +
    r.moves.toFixed(1).padStart(11) + r.ms.toFixed(0).padStart(10) +
    (r.fails ? '   (' + r.fails + ' probe failures)' : '')
  );
}

console.log('\nWorst deviation from the published figures: ' + worst.toFixed(1) + ' points');
console.log(worst <= 6
  ? 'PASS — the curve, the log scaling and the (s,c) table are wired up correctly.'
  : 'FAIL — something in the chain is wrong; the model is not reproducing the paper.');

// Beginner ratings: extrapolated past the paper's data, so just report shape.
console.log('\nExtrapolated below the paper\'s range (no published figure to check):');
for (const elo of [1200, 800, 600]) {
  const r = await page.evaluate(async ({ elo, fens }) => {
    let sum = 0, n = 0, bigLoss = 0;
    const { s, c } = reganParams(elo);
    for (const fen of fens.slice(0, 12)) {
      const probs = await sfReganProbs(fen, elo);
      if (!probs) continue;
      sum += Math.max(...Object.values(probs));
      // Chance this agent plays something at least 200cp worse than best.
      const ev = _lastReganEvals || null;
      n++;
    }
    return { top: n ? 100 * sum / n : 0, s, c, n };
  }, { elo, fens });
  console.log('  ' + String(elo).padStart(4) + ':  plays top move ' + r.top.toFixed(1) +
              '%   (s=' + r.s.toFixed(3) + ', c=' + r.c.toFixed(3) + ')');
}

console.log('\npage errors:', errs.length ? errs.slice(0, 3).join(' | ') : 'none');
await browser.close();

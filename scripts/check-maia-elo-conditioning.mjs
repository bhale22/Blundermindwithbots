// Does Maia's Elo conditioning actually change its play?
//
// Three bracket pairs in the calibration have come back compressed or inverted
// (700 v 900: 42%/40%; 1900 v 2100: 46%/43%; 2300 v 2500: 43%/54%). Every one is
// consistent with Maia's rating labels being closer together in practice than in
// name — which would mean our anchor scale has no gradations and every rung is
// measured against the same opponent wearing different numbers.
//
// This asks the model directly. Same position, several ratings, and we measure
// how far the returned distributions actually move: total variation distance,
// whether the top move even changes, and the expected centipawn loss of each
// rating's distribution scored by Stockfish.
//
// Expected if conditioning works: expected loss should fall monotonically with
// rating, and by a lot — a 600 and a 2600 should not agree.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const RATINGS = [600, 900, 1200, 1500, 1800, 2100, 2400, 2600];
const NPOS = Number(process.argv[2] || 12);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => { if (!sfReady) await sfInit(); });
await page.waitForFunction(() => sfReady, { timeout: 60000 });
process.stdout.write('Maia3 model... ');
await page.evaluate(async () => { if (!_maiaReady) await maiaDownloadModel(); });
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, { timeout: 900000 });
console.log('ready.\n');

const out = await page.evaluate(async ({ RATINGS, NPOS }) => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Collect middlegame positions.
  const fens = [];
  let bd = parseFen(START), tn = 'w', ep = -1, cst = { wK:true,wQ:true,bK:true,bQ:true };
  for (let i = 0; i < 16 + NPOS * 2 && fens.length < NPOS; i++) {
    const uci = await sfGetMove(boardToFen(bd, tn, cst, ep), 6);
    if (!uci || uci === '(none)') break;
    const f = fileRankToSq(uci.slice(0,2)), t = fileRankToSq(uci.slice(2,4));
    if (!bd[f]) break;
    const ne = computeEP(f,t,bd); cst = updateCastling(f,t,bd[f],cst);
    bd = applyMove(f,t,bd,ep,'Q'); ep = ne; tn = tn === 'w' ? 'b' : 'w';
    if (i >= 16) fens.push(boardToFen(bd, tn, cst, ep));
  }

  const g = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  const rows = {};
  for (const r of RATINGS) rows[r] = { eLoss: 0, eScaled: 0, n: 0, top: [] };
  const tvd = [];       // total variation distance between 600 and 2600
  const perPos = [];

  for (const fen of fens) {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) continue;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) continue;
    let best = -Infinity;
    for (const m of moves) if (evals[m] != null && evals[m] > best) best = evals[m];

    const dists = {};
    for (const r of RATINGS) {
      const saved = lcSelectedRating;
      lcSelectedRating = String(r);
      let p = null;
      try { p = await maia3GetMoveProbs(fen); } catch (e) {}
      lcSelectedRating = saved;
      if (!p) continue;
      dists[r] = p;
      let el = 0, es = 0, tot = 0, topM = null, topP = -1;
      for (const m in p) {
        if (evals[m] == null) continue;
        el += p[m] * (best - evals[m]);
        es += p[m] * (g(best) - g(evals[m]));
        tot += p[m];
        if (p[m] > topP) { topP = p[m]; topM = m; }
      }
      if (tot > 0) {
        rows[r].eLoss += el / tot; rows[r].eScaled += es / tot; rows[r].n++;
        rows[r].top.push(topM);
      }
    }
    // How far apart are the extremes on this position?
    if (dists[600] && dists[2600]) {
      const keys = new Set([...Object.keys(dists[600]), ...Object.keys(dists[2600])]);
      let d = 0;
      for (const k of keys) d += Math.abs((dists[600][k]||0) - (dists[2600][k]||0));
      tvd.push(d / 2);
      perPos.push({ same: dists[600] && dists[2600] &&
        Object.entries(dists[600]).sort((a,b)=>b[1]-a[1])[0][0] ===
        Object.entries(dists[2600]).sort((a,b)=>b[1]-a[1])[0][0] });
    }
  }
  return { rows, tvd, perPos, nfens: fens.length };
}, { RATINGS, NPOS });

console.log('  rating   expected loss of Maia\'s own distribution');
console.log('  ---------------------------------------------------');
let prev = null, monotone = true;
for (const r of RATINGS) {
  const x = out.rows[r];
  if (!x || !x.n) { console.log('  ' + r + '   (no data)'); continue; }
  const el = x.eLoss / x.n;
  if (prev !== null && el > prev + 3) monotone = false;
  prev = el;
  console.log('  ' + String(r).padEnd(9) + el.toFixed(1).padStart(6) + ' cp');
}
const meanTvd = out.tvd.reduce((a,b)=>a+b,0) / (out.tvd.length || 1);
const sameTop = out.perPos.filter(p=>p.same).length;
console.log('\n  positions tested: ' + out.nfens);
console.log('  600 vs 2600 total-variation distance: ' + meanTvd.toFixed(3) +
  '   (0 = identical, 1 = disjoint)');
console.log('  they pick the SAME top move in ' + sameTop + ' of ' + out.perPos.length + ' positions');
console.log('\n  expected-loss trend is ' + (monotone ? 'monotone (conditioning works)'
  : 'NOT monotone (conditioning is weak or broken)'));
await browser.close();

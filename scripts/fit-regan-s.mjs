// Refit Regan's s-values against OUR engine.
//
// Regan fitted (s, c) to RYBKA 3 at 13 ply. Stockfish 18 NNUE spreads its
// evaluations differently, so the paper's s does not transfer: left unchanged
// the model plays ~20 points below every published move-match rate, and no
// single scale factor fixes it (the rating→match slope is wrong, not just its
// level).
//
// So we repeat the paper's own procedure on our engine: hold c fixed at the
// published values (that is the SHAPE — the heavy tail, the exponent near
// one-half), and do a one-dimensional fit of s at each rating so the agent
// reproduces the paper's published move-match column.
//
// Evaluations are probed once per position and cached, so the fit itself is
// pure arithmetic over the cached deltas.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const PAPER = [
  [2700, 0.513, 56.3], [2600, 0.506, 54.2], [2500, 0.499, 53.1],
  [2400, 0.492, 51.8], [2300, 0.485, 50.3], [2200, 0.478, 48.3],
  [2100, 0.471, 47.7], [2000, 0.464, 46.1], [1900, 0.457, 45.0],
  [1800, 0.450, 45.4], [1700, 0.443, 44.5], [1600, 0.436, 42.9],
];
const NPOS = Number(process.argv[2] || 60);

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

process.stdout.write(`Collecting ${NPOS} positions and probing each once... `);
const deltas = await page.evaluate(async (NPOS) => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const VAL = { P:1, N:3, B:3, R:5, Q:9, K:0 };
  const mat = (b,c) => { let m=0; for (let s=0;s<64;s++){const p=b[s]; if(p&&p.color===c)m+=VAL[p.piece]||0;} return m; };
  const fens = [];
  for (let g = 0; g < 20 && fens.length < NPOS; g++) {
    let bd = parseFen(START), tn = 'w', ep = -1;
    let cst = { wK:true, wQ:true, bK:true, bQ:true };
    for (let i = 0; i < 50 && fens.length < NPOS; i++) {
      let f, t;
      if (Math.random() < 0.18) {
        const opts = [];
        for (let sq=0; sq<64; sq++){const p=bd[sq]; if(!p||p.color!==tn)continue;
          for (const d of legalMovesFor(sq,bd,ep,cst)) opts.push([sq,d]);}
        if (!opts.length) break;
        [f,t] = opts[Math.floor(Math.random()*opts.length)];
      } else {
        const uci = await sfGetMove(boardToFen(bd,tn,cst,ep), 8);
        if (!uci || uci === '(none)') break;
        f = fileRankToSq(uci.slice(0,2)); t = fileRankToSq(uci.slice(2,4));
        if (!bd[f]) break;
      }
      const ne = computeEP(f,t,bd);
      cst = updateCastling(f,t,bd[f],cst);
      bd = applyMove(f,t,bd,ep,'Q'); ep = ne; tn = tn==='w'?'b':'w';
      // The paper's sampling: past the opening, not already lopsided.
      if (i >= 16 && Math.abs(mat(bd,'w')-mat(bd,'b')) <= 3) fens.push(boardToFen(bd,tn,cst,ep));
    }
  }
  // One probe per position; keep only the scaled deltas the curve needs.
  const out = [];
  for (const fen of fens) {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) continue;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) continue;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) continue;
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    out.push(scored.map(m => _reganScale(best - evals[m])));
  }
  return out;
}, NPOS);
console.log(deltas.length + ' usable.\n');

// Mean probability the agent gives the top move, over the cached positions.
const meanTop = (s, c) => {
  let sum = 0;
  for (const ds of deltas) {
    let tot = 0, top = 0;
    for (const d of ds) {
      const y = d <= 0 ? 1 : Math.exp(-Math.pow(d / s, c));
      tot += y;
      if (y > top) top = y;
    }
    sum += top / tot;
  }
  return 100 * sum / deltas.length;
};

console.log('Elo   c(paper)  s(paper)  s(refit)  | match: ours   paper');
console.log('------------------------------------+---------------------');
const refit = [];
for (const [elo, c, target] of PAPER) {
  // meanTop decreases monotonically in s: bigger s = more tolerance = lower
  // probability on the top move. Bisect.
  let lo = 0.005, hi = 2.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (meanTop(mid, c) > target) lo = mid; else hi = mid;
  }
  const s = (lo + hi) / 2;
  refit.push([elo, +s.toFixed(4), c]);
  const got = meanTop(s, c);
  const paperS = { 2700:0.080,2600:0.089,2500:0.093,2400:0.100,2300:0.111,2200:0.120,
                   2100:0.130,2000:0.143,1900:0.153,1800:0.149,1700:0.155,1600:0.168 }[elo];
  console.log(String(elo).padStart(4) + '   ' + c.toFixed(3).padStart(6) +
    paperS.toFixed(3).padStart(10) + s.toFixed(4).padStart(10) + '  |' +
    (got.toFixed(1)+'%').padStart(9) + (target.toFixed(1)+'%').padStart(8));
}

console.log('\nRefitted table, paste into REGAN_FIT:\n');
const rows = refit.map(([e, s, c]) => `  [${e}, ${s.toFixed(4)}, ${c.toFixed(3)}],`);
for (let i = 0; i < rows.length; i += 3) console.log(rows.slice(i, i + 3).join(''));

// What the extrapolation gives at beginner ratings, using the refitted slope.
const last = refit[refit.length - 1], prev = refit[refit.length - 2];
const dS = (last[1] - prev[1]) / (last[0] - prev[0]);
const dC = (last[2] - prev[2]) / (last[0] - prev[0]);
console.log('\nExtrapolated below the paper\'s range:');
for (const elo of [1400, 1200, 1000, 800, 600]) {
  const s = Math.max(0.02, last[1] + (elo - last[0]) * dS);
  const c = Math.max(0.15, last[2] + (elo - last[0]) * dC);
  console.log('  ' + String(elo).padStart(4) + ':  s=' + s.toFixed(4) + '  c=' + c.toFixed(3) +
              '   plays top move ' + meanTop(s, c).toFixed(1) + '%');
}
await browser.close();

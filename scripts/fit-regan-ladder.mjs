// Calibrate the Regan s-ladder to Elo by ROUND-ROBIN + maximum likelihood.
//
// The first calibration chained adjacent rungs and accumulated the implied Elo.
// That over-counts badly: adjacent rungs score 80-90%, where implied Elo is
// hypersensitive to a game or two, and eight such gaps compound. It claimed
// 1851 Elo of total spread while a direct match across the same span measured
// 338.
//
// This plays every pair and fits all ratings jointly, which is what the score
// data actually supports.
//
// Run with the dev server up on :3100.
//   node scripts/fit-regan-ladder.mjs [gamesPerPairPerColour]
import { chromium } from 'playwright';

const S_RUNGS = [0.012, 0.03, 0.07, 0.15, 0.35, 0.8, 2.0];
const C = 0.45;
const GAMES = Number(process.argv[2] || 5);   // per colour
const PLIES = 90;
const TOP_ELO = 2600;                          // anchor, by convention

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

await page.evaluate(() => {
  window.probsAtS = async (fen, s, c) => {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) return null;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) return null;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) return null;
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const p = {}; let tot = 0;
    for (const m of scored) {
      const d = _reganScale(best - evals[m]);
      const y = d <= 0 ? 1 : Math.exp(-Math.pow(d / s, c));
      p[m] = y; tot += y;
    }
    for (const m in p) p[m] /= tot;
    return p;
  };
  window.playPair = async (sA, sB, c, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat = (b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let ptsA = 0, n = 0;
    for (let g = 0; g < games * 2; g++) {
      const aWhite = g % 2 === 0;
      let bd = parseFen(START), tn='w', ep=-1, cst={wK:true,wQ:true,bK:true,bQ:true};
      for (let k = 0; k < Math.floor(g / 2); k++) {
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const d of legalMovesFor(sq,bd,ep,cst))opts.push([sq,d]);}
        if(!opts.length)break;
        const [f,t]=opts[Math.floor(Math.random()*opts.length)];
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      let res = null;
      for (let i = 0; i < plies; i++) {
        if(!anyLegal(bd,tn,ep,cst)){res=inCheck(bd,tn)?(tn==='w'?'b':'w'):'draw';break;}
        const s = ((tn==='w')===aWhite) ? sA : sB;
        const probs = await window.probsAtS(boardToFen(bd,tn,cst,ep), s, c);
        const uci = probs ? sampleFromProbs(probs, 1.0) : null;
        if(!uci||uci==='(none)')break;
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f])break;
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      const aCol = aWhite?'w':'b', bCol = aWhite?'b':'w';
      let p;
      if (res === 'draw') p = 0.5;
      else if (res === aCol) p = 1;
      else if (res === bCol) p = 0;
      else { const md = mat(bd,aCol)-mat(bd,bCol); p = md > 1 ? 1 : md < -1 ? 0 : 0.5; }
      ptsA += p; n++;
    }
    return { score: ptsA / n, n };
  };
});

const N = S_RUNGS.length;
const results = [];   // {i, j, scoreI, games}
console.log(`\nRound robin: ${N} rungs, ${N * (N - 1) / 2} pairs, ${GAMES * 2} games each.\n`);
console.log('  pair                | score for the stronger s');
console.log('----------------------+-------------------------');
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const r = await page.evaluate(
      ({ a, b, C, GAMES, PLIES }) => window.playPair(a, b, C, GAMES, PLIES),
      { a: S_RUNGS[i], b: S_RUNGS[j], C, GAMES, PLIES });
    results.push({ i, j, scoreI: r.score, games: r.n });
    console.log(('  s=' + S_RUNGS[i] + ' v s=' + S_RUNGS[j]).padEnd(22) + '|' +
                ((100 * r.score).toFixed(0) + '%').padStart(10));
  }
}

// ── Maximum-likelihood Elo fit over every pairing ────────────────────────
// Iterative: nudge each rating toward the score its games actually produced.
// Using ALL pairs jointly is the point — it is what stops one lucky adjacent
// match from displacing the whole ladder below it.
// A pairing that goes 100% carries no information about HOW much stronger the
// winner is, and unregularised maximum likelihood answers "infinitely" — the
// 1-game pre-flight duly produced a rating of -361. PRIOR_GAMES adds a virtual
// drawn game to every pairing, which is the standard BayesElo smoothing: it
// costs almost nothing where there is real data and keeps undefeated pairs
// finite.
const PRIOR_GAMES = 2;
const R = new Array(N).fill(1500);
const exp_ = d => 1 / (1 + Math.pow(10, -d / 400));
for (let iter = 0; iter < 20000; iter++) {
  const grad = new Array(N).fill(0);
  for (const { i, j, scoreI, games } of results) {
    // Blend the observed score toward 0.5 by the prior's weight.
    const wt = games + PRIOR_GAMES;
    const obs = (scoreI * games + 0.5 * PRIOR_GAMES) / wt;
    const e = exp_(R[i] - R[j]);
    const g = wt * (obs - e);
    grad[i] += g; grad[j] -= g;
  }
  for (let k = 0; k < N; k++) R[k] += 0.25 * grad[k];
}
// Anchor: strongest rung at TOP_ELO.
const top = Math.max(...R);
const shift = TOP_ELO - top;
const elos = R.map(r => Math.round(r + shift));

console.log('\n  s        fitted Elo');
console.log('-------------------');
const rows = S_RUNGS.map((s, k) => [elos[k], s]).sort((a, b) => b[0] - a[0]);
for (const [e, s] of rows) console.log('  ' + String(s).padEnd(9) + e);

console.log('\nPaste into REGAN_ELO_S:\n');
console.log('const REGAN_ELO_S = [');
console.log('  ' + rows.map(([e, s]) => `[${e}, ${s}]`).join(', ') + ',');
console.log('];');

// Sanity: what the fit predicts for the pairs we measured.
console.log('\n  check: predicted vs measured score');
for (const { i, j, scoreI } of results.slice(0, 6)) {
  const pred = exp_(R[i] - R[j]);
  console.log('  s=' + String(S_RUNGS[i]).padEnd(6) + 'v s=' + String(S_RUNGS[j]).padEnd(6) +
              ' predicted ' + (100 * pred).toFixed(0) + '%   measured ' + (100 * scoreI).toFixed(0) + '%');
}
await browser.close();

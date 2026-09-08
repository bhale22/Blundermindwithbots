// Calibrate Flounder against Maia, which is rating-anchored by construction.
//
// Self-play only ever measured Flounder against itself, so the absolute scale
// stayed a convention — we could say rung A beats rung B, never what either one
// is worth. Maia is different: Maia-1200 was trained to predict the moves of
// 1200-rated humans, so its label is grounded in real human play.
//
// Structure: a round robin where the MAIA ratings are FIXED at their labels and
// only the Flounder rungs are free parameters. That is what turns relative
// measurements into absolute ones.
//
// Run with the dev server up on :3100.
//   node scripts/fit-flounder-vs-maia.mjs [gamesPerPairPerColour] [plies]
import { chromium } from 'playwright';

const S_RUNGS   = [0.02, 0.06, 0.15, 0.40, 1.0];
const MAIA_ANCH = [800, 1100, 1400];
const C = 0.45;
const GAMES = Number(process.argv[2] || 3);
const PLIES = Number(process.argv[3] || 80);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => { if (!sfReady) await sfInit(); });
await page.waitForFunction(() => sfReady, { timeout: 60000 });

process.stdout.write('Downloading Maia3 (~44 MB, once per browser profile)... ');
await page.evaluate(async () => { if (!_maiaReady) await maiaDownloadModel(); });
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady,
  { timeout: 600000 });
console.log('ready.\n');

await page.evaluate(() => {
  window.flounderMove = async (fen, s, c) => {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) return moves[0] || null;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) return null;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) return scored[0] || null;
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const p = {}; let tot = 0;
    for (const m of scored) {
      const d = _reganScale(best - evals[m]);
      const y = d <= 0 ? 1 : Math.exp(-Math.pow(d / s, c));
      p[m] = y; tot += y;
    }
    for (const m in p) p[m] /= tot;
    return sampleFromProbs(p, 1.0);
  };
  window.maiaMove = async (fen, elo) => {
    const saved = lcSelectedRating;
    lcSelectedRating = String(elo);
    let probs = null;
    try { probs = await maia3GetMoveProbs(fen); } catch (e) {}
    lcSelectedRating = saved;
    if (!probs || !Object.keys(probs).length) return null;
    return sampleFromProbs(probs, 1.0);
  };
  // One game. side 'A' is Flounder, 'B' is Maia.
  window.playFvM = async (s, c, elo, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat = (b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let ptsF = 0, n = 0, aborted = 0;
    for (let g = 0; g < games * 2; g++) {
      const fWhite = g % 2 === 0;
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
      let res = null, bad = false;
      for (let i = 0; i < plies; i++) {
        if(!anyLegal(bd,tn,ep,cst)){res=inCheck(bd,tn)?(tn==='w'?'b':'w'):'draw';break;}
        const fen = boardToFen(bd,tn,cst,ep);
        const isF = ((tn==='w') === fWhite);
        const uci = isF ? await window.flounderMove(fen, s, c)
                        : await window.maiaMove(fen, elo);
        if(!uci||uci==='(none)'){ bad = true; break; }
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f]){ bad = true; break; }
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      if (bad) { aborted++; continue; }
      const fCol=fWhite?'w':'b', mCol=fWhite?'b':'w';
      let p;
      if(res==='draw')p=0.5; else if(res===fCol)p=1; else if(res===mCol)p=0;
      else { const md=mat(bd,fCol)-mat(bd,mCol); p = md>1?1:md<-1?0:0.5; }
      ptsF += p; n++;
    }
    return { score: n ? ptsF/n : null, n, aborted };
  };
});

console.log(`Flounder rungs x Maia anchors, ${GAMES * 2} games each, ${PLIES} plies max.\n`);
console.log('  Flounder s  vs Maia | Flounder scores');
console.log('----------------------+----------------');
const obs = [];
for (let i = 0; i < S_RUNGS.length; i++) {
  for (const elo of MAIA_ANCH) {
    const r = await page.evaluate(
      ({ s, C, elo, GAMES, PLIES }) => window.playFvM(s, C, elo, GAMES, PLIES),
      { s: S_RUNGS[i], C, elo, GAMES, PLIES });
    if (r.score === null) { console.log('  s=' + S_RUNGS[i] + ' v ' + elo + ' — all games aborted'); continue; }
    obs.push({ i, elo, score: r.score, games: r.n });
    console.log(('  s=' + S_RUNGS[i] + '  v  Maia ' + elo).padEnd(22) + '|' +
      ((100 * r.score).toFixed(0) + '%').padStart(9) +
      (r.aborted ? '   (' + r.aborted + ' aborted)' : ''));
  }
}

// ── Fit: Maia ratings FIXED, Flounder rungs free ─────────────────────
const PRIOR = 2;
const R = new Array(S_RUNGS.length).fill(1200);
const exp_ = d => 1 / (1 + Math.pow(10, -d / 400));
for (let it = 0; it < 40000; it++) {
  const grad = new Array(S_RUNGS.length).fill(0);
  for (const { i, elo, score, games } of obs) {
    const wt = games + PRIOR;
    const sc = (score * games + 0.5 * PRIOR) / wt;
    grad[i] += wt * (sc - exp_(R[i] - elo));
  }
  for (let k = 0; k < S_RUNGS.length; k++) R[k] += 0.25 * grad[k];
}

console.log('\n  s        Flounder Elo   (anchored on Maia, not on a convention)');
console.log('--------------------------');
const rows = S_RUNGS.map((s, k) => [Math.round(R[k]), s]).sort((a, b) => b[0] - a[0]);
for (const [e, s] of rows) console.log('  ' + String(s).padEnd(9) + e);

console.log('\nPaste into REGAN_ELO_S:\n');
console.log('const REGAN_ELO_S = [');
console.log('  ' + rows.map(([e, s]) => `[${e}, ${s}]`).join(', ') + ',');
console.log('];');

console.log('\n  fit quality — predicted vs measured');
let mae = 0;
for (const { i, elo, score } of obs) {
  const pred = exp_(R[i] - elo);
  mae += Math.abs(pred - score);
  console.log('  s=' + String(S_RUNGS[i]).padEnd(6) + 'v ' + elo +
    '   predicted ' + (100 * pred).toFixed(0) + '%   measured ' + (100 * score).toFixed(0) + '%');
}
console.log('\n  mean abs error: ' + (100 * mae / obs.length).toFixed(1) + ' points');
console.log('  page errors:', errs.length ? errs.slice(0, 3).join(' | ') : 'none');
await browser.close();

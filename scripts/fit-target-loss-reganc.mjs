// Target-loss selection with REGAN'S RATING-VARYING c.
//
// Everything measured so far pinned c at 0.45. Regan fits it as a function of
// rating — 0.513 at 2700 falling to 0.436 at 1600 — and in this formulation c
// is the Weibull SHAPE, so it controls how heavy the tail of per-move cost is.
// Falling c means weaker players suffer relatively more catastrophes, which is
// the "three good moves then a hung rook" pattern that a fixed c cannot produce.
//
// CONTROLLED COMPARISON. Lowering c also inflates the distribution's mean
// (mean = s·Γ(1+1/c)), so simply swapping c in would change cost and shape at
// once and the result would be uninterpretable. Instead s is rescaled at each
// rating to hold the MEAN TARGET equal to the c=0.45 baseline. Any difference
// measured here is therefore attributable to SHAPE alone.
//
// Baseline to compare against (c=0.45, same harness, 6 games/pairing):
//   s=0.08 → 1950   ACPL  34cp    2% of moves over 300cp
//   s=0.15 → 1046   ACPL 208cp   10%
//   s=0.25 →  841   ACPL 268cp   14%
//   s=0.60 →  374   ACPL 839cp   24%
//
// Run with the dev server up on :3100.
//   node scripts/fit-target-loss-reganc.mjs [gamesPerColour] [plies]
import { chromium } from 'playwright';

// Intended rating → the s that produced it at c=0.45, interpolated from the
// baseline run above (log-linear in s).
const AGENTS = [
  { elo: 2000, sBase: 0.078 },
  { elo: 1600, sBase: 0.102 },
  { elo: 1200, sBase: 0.135 },
  { elo: 1000, sBase: 0.168 },
  { elo:  800, sBase: 0.270 },
];
const ANCHORS = [600, 800, 1000, 1200, 1400, 1700, 2000];
const GAMES = Number(process.argv[2] || 3);
const PLIES = Number(process.argv[3] || 70);
const LO = 0.18, HI = 0.82;

// Regan's cfit column, linear in Elo (0.436 at 1600, 0.513 at 2700 → 0.00007
// per point). Below 1600 this is extrapolation past his data.
const reganC = elo => Math.max(0.28, Math.min(0.55, 0.436 + (elo - 1600) * 0.00007));

// Lanczos gamma — needed to hold the mean fixed while c moves.
function gamma(z){
  const g = 7, p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}
const meanFactor = c => gamma(1 + 1 / c);
const BASE_C = 0.45, BASE_F = meanFactor(BASE_C);

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

process.stdout.write('Maia3 model... ');
await page.evaluate(async () => { if (!_maiaReady) await maiaDownloadModel(); });
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, { timeout: 600000 });
console.log('ready.\n');

await page.evaluate(() => {
  window.gScale = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  window.weibull = (s, c) => s * Math.pow(-Math.log(1 - Math.random()), 1 / c);
  window.targetLossMove = async (fen, s, c) => {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) return { uci: moves[0] || null };
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) return { uci: null };
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) return { uci: scored[0] || null };
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const gB = window.gScale(best);
    const d = scored.map(m => gB - window.gScale(evals[m]));
    const tau = window.weibull(s, c);
    let k = 0, gap = Infinity;
    for (let i = 0; i < scored.length; i++) {
      const gg = Math.abs(d[i] - tau);
      if (gg < gap) { gap = gg; k = i; }
    }
    return { uci: scored[k], cp: best - evals[scored[k]] };
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
  window.playTvM = async (s, c, elo, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat = (b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let pts=0,n=0,cpSum=0,cpN=0,big=0,huge=0,clean=0;
    for (let g=0; g<games*2; g++){
      const fW = g%2===0;
      let bd=parseFen(START),tn='w',ep=-1,cst={wK:true,wQ:true,bK:true,bQ:true};
      for(let k=0;k<Math.floor(g/2);k++){
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const dd of legalMovesFor(sq,bd,ep,cst))opts.push([sq,dd]);}
        if(!opts.length)break;
        const [f,t]=opts[Math.floor(Math.random()*opts.length)];
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      let res=null,bad=false;
      for(let i=0;i<plies;i++){
        if(!anyLegal(bd,tn,ep,cst)){res=inCheck(bd,tn)?(tn==='w'?'b':'w'):'draw';break;}
        const fen=boardToFen(bd,tn,cst,ep);
        let uci;
        if((tn==='w')===fW){
          const r=await window.targetLossMove(fen,s,c);
          uci=r.uci;
          if(r.cp!=null){cpSum+=r.cp;cpN++;if(r.cp>300)big++;if(r.cp>800)huge++;if(r.cp<=20)clean++;}
        } else uci=await window.maiaMove(fen,elo);
        if(!uci||uci==='(none)'){bad=true;break;}
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f]){bad=true;break;}
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      if(bad) continue;
      const fC=fW?'w':'b', mC=fW?'b':'w';
      let p;
      if(res==='draw')p=0.5; else if(res===fC)p=1; else if(res===mC)p=0;
      else {const md=mat(bd,fC)-mat(bd,mC);p=md>1?1:md<-1?0:0.5;}
      pts+=p;n++;
    }
    return { score:n?pts/n:null, n, acpl:cpN?cpSum/cpN:null,
             big:cpN?big/cpN:null, huge:cpN?huge/cpN:null, clean:cpN?clean/cpN:null };
  };
});

console.log('  intended   c (Regan)   s (mean held)   mean target @ equal');
console.log('---------------------------------------------------------');
for (const a of AGENTS) {
  a.c = reganC(a.elo);
  a.s = a.sBase * BASE_F / meanFactor(a.c);
  const meanTau = a.s * meanFactor(a.c);
  console.log('  ' + String(a.elo).padEnd(11) + a.c.toFixed(3).padEnd(12) +
    a.s.toFixed(4).padEnd(16) + Math.round(100*(Math.exp(meanTau)-1)) + 'cp');
}
console.log();

const obs = [];
const play = async (a, elo) => {
  const r = await page.evaluate(({s,c,elo,GAMES,PLIES}) => window.playTvM(s,c,elo,GAMES,PLIES),
    { s:a.s, c:a.c, elo, GAMES, PLIES });
  if (r.score === null) return null;
  obs.push({ elo:a.elo, anchor:elo, score:r.score, games:r.n,
             acpl:r.acpl, big:r.big, huge:r.huge, clean:r.clean });
  console.log(('    ' + a.elo + '-agent  v  Maia ' + elo).padEnd(30) + '|' +
    ((100*r.score).toFixed(0)+'%').padStart(6) +
    '   ACPL ' + String(Math.round(r.acpl)).padStart(4) + 'cp' +
    '   clean ' + (100*r.clean).toFixed(0) + '%' +
    '   >300 ' + (100*r.big).toFixed(0) + '%' +
    '   >800 ' + (100*r.huge).toFixed(0) + '%');
  return r.score;
};

let idx = ANCHORS.length - 1;
for (const a of AGENTS) {
  console.log('  agent intended ' + a.elo + '  (c=' + a.c.toFixed(3) + ', s=' + a.s.toFixed(4) + ')');
  let guard = 0;
  while (guard++ < ANCHORS.length) {
    const sc = await play(a, ANCHORS[idx]);
    if (sc === null) break;
    if (sc > HI && idx < ANCHORS.length-1) { idx++; continue; }
    if (sc < LO && idx > 0) { idx--; continue; }
    break;
  }
}

// Fit each agent's Elo with the Maia anchors held fixed.
const uniq = [...new Set(obs.map(o=>o.elo))];
const R = uniq.map(e=>e);
const exp_ = d => 1/(1+Math.pow(10,-d/400));
const PRIOR = 1;
for (let it=0; it<40000; it++){
  const g = new Array(uniq.length).fill(0);
  for (const o of obs){
    const k = uniq.indexOf(o.elo);
    const wt = o.games + PRIOR;
    const sc = (o.score*o.games + 0.5*PRIOR)/wt;
    g[k] += wt*(sc - exp_(R[k]-o.anchor));
  }
  for (let k=0;k<uniq.length;k++) R[k] += 0.25*g[k];
}

console.log('\n  intended   measured   error    ACPL    clean   >300cp   >800cp');
console.log('-----------------------------------------------------------------');
for (let k=0;k<uniq.length;k++){
  const mine = obs.filter(o=>o.elo===uniq[k]);
  const avg = f => mine.reduce((a,o)=>a+o[f],0)/mine.length;
  console.log('  ' + String(uniq[k]).padEnd(11) + String(Math.round(R[k])).padEnd(11) +
    (Math.round(R[k]-uniq[k])>=0?'+':'') + String(Math.round(R[k]-uniq[k])).padEnd(9) +
    (Math.round(avg('acpl'))+'cp').padEnd(8) +
    ((100*avg('clean')).toFixed(0)+'%').padEnd(8) +
    ((100*avg('big')).toFixed(0)+'%').padEnd(9) +
    (100*avg('huge')).toFixed(0)+'%');
}
console.log('\n  total games: ' + obs.reduce((a,o)=>a+o.games,0));
console.log('  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

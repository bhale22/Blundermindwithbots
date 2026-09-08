// TARGET-LOSS selection — Ben's method — measured against Maia.
//
// The shipped approach samples a MOVE from a distribution over moves. This one
// inverts that: sample a TARGET COST for the turn, then play whichever legal
// move sits closest to it.
//
//   1. one MultiPV probe scores every legal move
//   2. each eval is put on Regan's perceptual scale, g(v) = sign(v)·ln(1+|v|/100),
//      so a 100cp error costs less when the game is already lopsided — this is
//      the winning/losing/equal conditioning, and it falls straight out of the
//      scale rather than needing a special case
//   3. δ'ᵢ = g(best) − g(moveᵢ)
//   4. sample a target τ ~ Weibull(shape c, scale s). Regan's exp(−(δ/s)^c) IS a
//      Weibull survival function, so this is his model as a continuous law over
//      cost rather than a discrete law over moves
//   5. play argmin |δ'ᵢ − τ|
//
// What it should buy: a control knob that is roughly LINEAR in typical loss
// (mean τ = s·Γ(1+1/c) ≈ 2.48s at c=0.45) instead of the violently steep s of
// the move-sampling method, where 0.06→0.10 was worth ~1000 Elo.
//
// What it gives up: move-level shape. Where several moves are near-equal the
// move-sampling method spreads across them naturally; this one snaps to whichever
// is nearest the target and ignores how crowded that region is.
//
// Run with the dev server up on :3100.
//   node scripts/fit-target-loss.mjs [gamesPerColour] [plies]
import { chromium } from 'playwright';

const S_RUNGS = [0.04, 0.08, 0.15, 0.25, 0.40, 0.60];
const ANCHORS = [600, 800, 1000, 1200, 1400, 1700, 2000];
const C = 0.45;
const GAMES = Number(process.argv[2] || 3);
const PLIES = Number(process.argv[3] || 70);
const LO = 0.18, HI = 0.82;

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
  // Regan's perceptual scale, applied to the EVAL itself (signed), so that
  // differencing two scaled evals automatically discounts errors made in
  // already-decided positions.
  window.gScale = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);

  // Weibull(shape c, scale s). Regan's curve is this distribution's survival
  // function, so the heavy tail comes for free — occasional enormous targets,
  // which is what produces the occasional real blunder.
  window.weibull = (s, c) => s * Math.pow(-Math.log(1 - Math.random()), 1 / c);

  window.targetLossMove = async (fen, s, c, report) => {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) return { uci: moves[0] || null };
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) return { uci: null };
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) return { uci: scored[0] || null };
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const gBest = window.gScale(best);
    const d = scored.map(m => gBest - window.gScale(evals[m]));
    const tau = window.weibull(s, c);
    let k = 0, bestGap = Infinity;
    for (let i = 0; i < scored.length; i++) {
      const gap = Math.abs(d[i] - tau);
      if (gap < bestGap) { bestGap = gap; k = i; }
    }
    const out = { uci: scored[k] };
    if (report) { out.tau = tau; out.got = d[k]; out.cp = best - evals[scored[k]]; }
    return out;
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
    let ptsF=0, n=0, cpSum=0, cpN=0, big=0;
    for (let g = 0; g < games*2; g++) {
      const fWhite = g % 2 === 0;
      let bd=parseFen(START), tn='w', ep=-1, cst={wK:true,wQ:true,bK:true,bQ:true};
      for (let k=0;k<Math.floor(g/2);k++){
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const dd of legalMovesFor(sq,bd,ep,cst))opts.push([sq,dd]);}
        if(!opts.length)break;
        const [f,t]=opts[Math.floor(Math.random()*opts.length)];
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      let res=null, bad=false;
      for (let i=0;i<plies;i++){
        if(!anyLegal(bd,tn,ep,cst)){res=inCheck(bd,tn)?(tn==='w'?'b':'w'):'draw';break;}
        const fen=boardToFen(bd,tn,cst,ep);
        let uci;
        if(((tn==='w')===fWhite)){
          const r = await window.targetLossMove(fen, s, c, true);
          uci = r.uci;
          if (r.cp != null) { cpSum += r.cp; cpN++; if (r.cp > 300) big++; }
        } else {
          uci = await window.maiaMove(fen, elo);
        }
        if(!uci||uci==='(none)'){bad=true;break;}
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f]){bad=true;break;}
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      if(bad) continue;
      const fCol=fWhite?'w':'b', mCol=fWhite?'b':'w';
      let p;
      if(res==='draw')p=0.5; else if(res===fCol)p=1; else if(res===mCol)p=0;
      else { const md=mat(bd,fCol)-mat(bd,mCol); p=md>1?1:md<-1?0:0.5; }
      ptsF+=p; n++;
    }
    return { score: n?ptsF/n:null, n, acpl: cpN?cpSum/cpN:null, bigRate: cpN?big/cpN:null };
  };
});

const obs = [];
const play = async (s, elo) => {
  const r = await page.evaluate(({s,C,elo,GAMES,PLIES}) => window.playTvM(s,C,elo,GAMES,PLIES),
    { s, C, elo, GAMES, PLIES });
  if (r.score === null) return null;
  obs.push({ s, elo, score: r.score, games: r.n, acpl: r.acpl, bigRate: r.bigRate });
  console.log(('    s=' + s + '  v  Maia ' + elo).padEnd(26) + '|' +
    ((100*r.score).toFixed(0)+'%').padStart(7) +
    '   realised ACPL ' + Math.round(r.acpl) + 'cp' +
    '   >300cp on ' + (100*r.bigRate).toFixed(0) + '% of moves');
  return r.score;
};

console.log(`Target-loss selection. ${GAMES*2} games per pairing, ${PLIES} plies max.`);
console.log(`Mean target = s x G(1+1/c) ~ ${(2.48).toFixed(2)}s in scaled units.\n`);
let idx = ANCHORS.length - 1;
for (const s of S_RUNGS) {
  console.log('  rung s=' + s + '   (mean target ~ ' +
    Math.round(100*(Math.exp(2.48*s)-1)) + 'cp at an equal position)');
  let guard = 0;
  while (guard++ < ANCHORS.length) {
    const sc = await play(s, ANCHORS[idx]);
    if (sc === null) break;
    if (sc > HI && idx < ANCHORS.length-1) { idx++; continue; }
    if (sc < LO && idx > 0) { idx--; continue; }
    break;
  }
}

const uniq = [...new Set(obs.map(o=>o.s))];
const R = new Array(uniq.length).fill(1000);
const exp_ = d => 1/(1+Math.pow(10,-d/400));
const PRIOR = 1;
for (let it=0; it<40000; it++){
  const g = new Array(uniq.length).fill(0);
  for (const o of obs){
    const k = uniq.indexOf(o.s);
    const wt = o.games + PRIOR;
    const sc = (o.score*o.games + 0.5*PRIOR)/wt;
    g[k] += wt*(sc - exp_(R[k]-o.elo));
  }
  for (let k=0;k<uniq.length;k++) R[k] += 0.25*g[k];
}

console.log('\n  s       Elo    realised ACPL   >300cp rate   evidence');
console.log('------------------------------------------------------');
const rows = uniq.map((s,k)=>[Math.round(R[k]),s]).sort((a,b)=>b[0]-a[0]);
for (const [e,s] of rows){
  const mine = obs.filter(o=>o.s===s);
  const solid = mine.some(o=>o.score>0.1 && o.score<0.9);
  const acpl = mine.reduce((a,o)=>a+o.acpl,0)/mine.length;
  const bigR = mine.reduce((a,o)=>a+o.bigRate,0)/mine.length;
  console.log('  ' + String(s).padEnd(8) + String(e).padEnd(7) +
    (Math.round(acpl)+'cp').padEnd(16) + ((100*bigR).toFixed(0)+'%').padEnd(14) +
    (solid ? 'measured' : 'bound only'));
}
console.log('\n  total games: ' + obs.reduce((a,o)=>a+o.games,0));
console.log('  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

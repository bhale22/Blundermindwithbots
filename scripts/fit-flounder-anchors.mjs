// The production calibration: nine anchors across 600-2600, then interpolate.
//
// Not 41 root-finds at 50-Elo steps. Each measurement carries roughly +/-100 Elo
// of noise, so 41 of them would produce a BUMPIER table than a smooth fit through
// nine good ones. c needs no games at all — it is Regan's closed form. Only s is
// measured.
//
// Each anchor is calibrated against MAIA AT THE SAME RATING, searching s for a
// 50% score. One well-posed root-find per anchor; nothing is chained, so nothing
// accumulates error. That structure is what fixed this after two failed attempts.
//
// Fixes the systematic undershoot of the previous run (every rung landed 35-147
// Elo weak) by adding a correction round: if the confirm lands off target, step s
// once more and re-confirm, rather than trusting a noisy probe.
//
// Run with the dev server up on :3100.
//   node scripts/fit-flounder-anchors.mjs [probeGames] [iters] [confirmGames] [plies]
import { chromium } from 'playwright';

const TARGETS = [2600, 2350, 2100, 1850, 1600, 1350, 1100, 850, 600];
const PROBE   = Number(process.argv[2] || 3);   // per colour
const ITERS   = Number(process.argv[3] || 4);
const CONFIRM = Number(process.argv[4] || 6);   // per colour
const PLIES   = Number(process.argv[5] || 70);

const reganC = elo => Math.max(0.28, Math.min(0.55, 0.436 + (elo - 1600) * 0.00007));
const impliedElo = sc => {
  const s = Math.min(0.96, Math.max(0.04, sc));
  return -400 * Math.log10(1 / s - 1);
};
// Seeded from the four measured points of the two-parameter run:
//   1765→0.0961  1292→0.1018  992→0.1236  653→0.1340
const seedS = elo => Math.exp(-2.010 + (elo - 653) * -0.0002986);

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
  window.probe = async (s, c, elo, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat=(b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let pts=0,n=0,cpSum=0,cpN=0,big=0,huge=0,clean=0;
    for(let g=0; g<games*2; g++){
      const fW=g%2===0;
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
          const r=await window.targetLossMove(fen,s,c); uci=r.uci;
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

const out = [];
for (const R of TARGETS) {
  const c = reganC(R);
  console.log('== ' + R + '  c=' + c.toFixed(3) + ' ==');
  let lnS = Math.log(seedS(R));
  let slope = 2800, prev = null, best = null;

  for (let it = 0; it < ITERS; it++) {
    const s = Math.exp(lnS);
    const r = await page.evaluate(({s,c,R,PROBE,PLIES}) => window.probe(s,c,R,PROBE,PLIES),
      { s, c, R, PROBE, PLIES });
    if (r.score === null) { console.log('   probe failed'); break; }
    const gap = impliedElo(r.score);
    console.log('   s=' + s.toFixed(4) + '  ' + (100*r.score).toFixed(0) + '%  ' +
      (gap>=0?'+':'') + Math.round(gap) + ' Elo');
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { s, gap, lnS };
    if (Math.abs(gap) < 70) break;
    if (prev && Math.abs(lnS - prev.lnS) > 1e-6) {
      const est = (prev.gap - gap) / (lnS - prev.lnS);
      if (est > 300 && est < 12000) slope = 0.5*slope + 0.5*est;
    }
    prev = { lnS, gap };
    lnS += Math.max(-0.4, Math.min(0.4, gap / slope));
  }

  // Confirm, then ONE correction round — this is what the last run lacked, and
  // why every rung there came in 35-147 Elo weak.
  let s = best ? best.s : Math.exp(lnS);
  let conf = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
    { s, c, R, CONFIRM, PLIES });
  let gap = conf.score === null ? 0 : impliedElo(conf.score);
  console.log('   confirm s=' + s.toFixed(4) + '  ' + (100*conf.score).toFixed(0) +
    '%  → ' + Math.round(R + gap));
  if (Math.abs(gap) > 70) {
    const s2 = Math.exp(Math.log(s) + Math.max(-0.35, Math.min(0.35, gap / slope)));
    const c2 = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
      { s: s2, c, R, CONFIRM, PLIES });
    const g2 = c2.score === null ? 0 : impliedElo(c2.score);
    console.log('   correct s=' + s2.toFixed(4) + '  ' + (100*c2.score).toFixed(0) +
      '%  → ' + Math.round(R + g2));
    if (Math.abs(g2) < Math.abs(gap)) { s = s2; conf = c2; gap = g2; }
  }
  out.push({ R, c, s, measured: Math.round(R + gap), score: conf.score,
             acpl: conf.acpl, clean: conf.clean, big: conf.big, huge: conf.huge });
  console.log();
}

console.log('  target   c       s        measured  err    ACPL   clean  >300  >800');
console.log('---------------------------------------------------------------------');
for (const r of out) {
  console.log('  ' + String(r.R).padEnd(9) + r.c.toFixed(3).padEnd(8) + r.s.toFixed(4).padEnd(9) +
    String(r.measured).padEnd(10) + ((r.measured-r.R>=0?'+':'')+(r.measured-r.R)).padEnd(7) +
    (Math.round(r.acpl)+'cp').padEnd(7) + ((100*r.clean).toFixed(0)+'%').padEnd(7) +
    ((100*r.big).toFixed(0)+'%').padEnd(6) + (100*r.huge).toFixed(0)+'%');
}

// Monotone fit on ln(s) vs measured Elo, then 50-Elo steps.
const pts = out.map(r => [r.measured, Math.log(r.s)]).sort((a,b)=>a[0]-b[0]);
for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[i-1][1]) pts[i][1] = pts[i-1][1] - 1e-4;
const lnSAt = elo => {
  if (elo <= pts[0][0]) return pts[0][1];
  if (elo >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i = 0; i < pts.length-1; i++)
    if (elo >= pts[i][0] && elo <= pts[i+1][0]) {
      const t = (elo - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
    }
  return pts[pts.length-1][1];
};
console.log('\n// Interpolated, 50-Elo steps. c is Regan closed-form; s from the anchors.');
console.log('const FLOUNDER_LADDER = [');
for (let e = 600; e <= 2600; e += 50)
  console.log(`  { elo: ${e}, s: ${Math.exp(lnSAt(e)).toFixed(4)}, c: ${reganC(e).toFixed(3)} },`);
console.log('];');
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

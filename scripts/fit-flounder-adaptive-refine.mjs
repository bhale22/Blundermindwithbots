// Adaptive refinement of the Elo→s curve.
//
// Ben's idea, and the right one: don't space anchors evenly, put them where the
// curve bends. The precise analogue is adaptive subdivision with a local error
// estimate (as in adaptive quadrature), not Runge-Kutta — but the principle is
// identical: estimate local error, refine where it is large, leave straight
// stretches alone.
//
// The trick that makes it cheap: EVERY TEST IS ALSO A MEASUREMENT. We predict a
// midpoint's s by interpolation, play it, and record (s, measured Elo). If the
// prediction was good the interval is done; if it was bad we have already
// collected exactly the point needed to fix it. Nothing is wasted and no
// root-finding is needed after the seeds.
//
// PRECISION. Every point is measured BRACKETED — half its games against Maia
// 100 below the target, half against Maia 100 above. That pins the rating from
// both sides instead of relying on the steepest part of the Elo curve, and it
// measurably beat single-anchor probes (+/-48 vs +/-78 for comparable compute).
// 84 games gives +/-75 at 95%, which is the floor for a 75-Elo tolerance: below
// that we would be refining on noise rather than on curvature.
//
// Run with the dev server up on :3100.
//   node scripts/fit-flounder-adaptive-refine.mjs [gamesPerPoint] [tolerance] [maxPoints]
import { chromium } from 'playwright';

const GAMES_PER_POINT = Number(process.argv[2] || 84);
const TOL   = Number(process.argv[3] || 75);
const MAX_POINTS = Number(process.argv[4] || 10);
const PLIES = 70;
const SPREAD = 100;                       // bracket opponents at target +/- this
const LO_ELO = 600, HI_ELO = 2600;

const reganC = e => Math.max(0.28, Math.min(0.55, 0.436 + (e - 1600) * 0.00007));

// SEED ONLY — not calibration data.
//
// Weighted (1/ci^2) log-linear fit through all 15 measurements taken so far. It
// costs zero games and makes the first probes land near their targets instead of
// wandering, which is the whole value of the earlier work.
//
// It is NOT used as anchor data, because those 15 points are BIASED. Each one's s
// was chosen by taking whichever probe scored closest to target — selection on
// noise, which systematically favours the sample that got lucky. Their chi2/dof
// against any smooth curve is 3.54, i.e. the scatter is ~3.5x what their stated
// error bars allow, so the honest interval on them is nearer +/-300 than +/-150.
//
// Every point this script measures is unbiased by construction: it plays a
// PREDICTED s and records whatever comes out. Nothing is selected.
const seedS = e => Math.exp(-1.92970 + -3.0963e-4 * e);

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
    let pts=0,n=0,cpSum=0,cpN=0,big=0,clean=0;
    for(let g=0; g<games; g++){
      const fW=g%2===0;
      let bd=parseFen(START),tn='w',ep=-1,cst={wK:true,wQ:true,bK:true,bQ:true};
      for(let k=0;k<Math.floor(g/2)%9;k++){
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
          if(r.cp!=null){cpSum+=r.cp;cpN++;if(r.cp>300)big++;if(r.cp<=20)clean++;}
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
             big:cpN?big/cpN:null, clean:cpN?clean/cpN:null };
  };
});

const points = [];                        // {s, elo, ci}
const lnSAt = e => {                      // interpolate ln(s) over measured Elo
  const P = [...points].sort((a,b)=>a.elo-b.elo);
  // Until two measured points bracket this rating, trust the seed fit — it is
  // built on far more data than one or two fresh points.
  if (P.length < 2) return Math.log(seedS(e));
  if (e < P[0].elo || e > P[P.length-1].elo) return Math.log(seedS(e));
  for (let i=0;i<P.length-1;i++) if (e>=P[i].elo && e<=P[i+1].elo){
    const t=(e-P[i].elo)/(P[i+1].elo-P[i].elo);
    return Math.log(P[i].s)+t*(Math.log(P[i+1].s)-Math.log(P[i].s));
  }
  return Math.log(P[P.length-1].s);
};

// Bracketed measurement: half the games against each side.
async function measure(s, target) {
  const c = reganC(target);
  const half = Math.round(GAMES_PER_POINT / 2);
  const out = [];
  for (const opp of [target - SPREAD, target + SPREAD]) {
    const r = await page.evaluate(({s,c,opp,half,PLIES}) => window.probe(s,c,opp,half,PLIES),
      { s, c, opp, half, PLIES });
    if (r.score === null) return null;
    out.push({ opp, ...r });
  }
  let R = target, tot = out.reduce((a,o)=>a+o.n,0);
  for (let it=0; it<60000; it++){
    let g=0;
    for (const o of out) g += o.n*(o.score - 1/(1+Math.pow(10,-(R-o.opp)/400)));
    R += 0.05*g;
  }
  const sigma = 694.9*Math.sqrt(0.25/tot);
  const agg = f => out.reduce((a,o)=>a+o[f]*o.n,0)/tot;
  return { elo: Math.round(R), ci: Math.round(1.96*sigma), games: tot,
           scores: out.map(o=>({opp:o.opp, pct:Math.round(100*o.score)})),
           clean: agg('clean'), big: agg('big') };
}

console.log(`Adaptive refinement. ${GAMES_PER_POINT} games/point (bracketed +/-${SPREAD}), ` +
            `tolerance ${TOL} Elo, budget ${MAX_POINTS} points.\n`);

// ── Phase 1: a coarse grid, measured fresh ───────────────────────────
// Predictions come from the seed fit; results are unbiased measurements.
const GRID = [800, 1200, 1600, 2000, 2400];
for (const t of GRID) {
  if (points.length >= MAX_POINTS) break;
  const s = Math.exp(lnSAt(t));
  const m = await measure(s, t);
  if (!m) { console.log('  grid ' + t + ' failed'); continue; }
  points.push({ s, elo: m.elo, ci: m.ci });
  const err = m.elo - t;
  console.log('  grid  target ' + String(t).padEnd(5) + ' s=' + s.toFixed(4) +
    '  → ' + String(m.elo).padEnd(5) + ' +/-' + String(m.ci).padEnd(4) +
    ' err ' + (err>=0?'+':'') + String(err).padEnd(5) +
    '  [' + m.scores.map(x=>x.pct+'% v '+x.opp).join(', ') + ']');
}

// ── Refine where interpolation disagrees with measurement ─────────────
let queue = [];
{
  const P = [...points].sort((a,b)=>a.elo-b.elo);
  for (let i=0;i<P.length-1;i++) queue.push([P[i].elo, P[i+1].elo]);
}
console.log();
while (queue.length && points.length < MAX_POINTS) {
  // Widest interval first — that is where interpolation error is likeliest.
  queue.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));
  const [lo,hi] = queue.shift();
  if (hi - lo < 220) { console.log('  [' + lo + ',' + hi + '] too narrow to split'); continue; }
  const mid = Math.round((lo+hi)/2);
  const s = Math.exp(lnSAt(mid));
  const m = await measure(s, mid);
  if (!m) { console.log('  test ' + mid + ' failed'); continue; }
  const err = m.elo - mid;
  const verdict = Math.abs(err) <= TOL ? 'OK — interval is straight enough'
                                       : 'BEND — subdividing';
  console.log('  test  mid ' + String(mid).padEnd(5) + ' s=' + s.toFixed(4) +
    '  predicted ' + mid + '  → ' + m.elo + ' +/-' + m.ci +
    '  err ' + (err>=0?'+':'') + err + '   ' + verdict);
  points.push({ s, elo: m.elo, ci: m.ci });
  if (Math.abs(err) > TOL) { queue.push([lo, mid]); queue.push([mid, hi]); }
}

const P = [...points].sort((a,b)=>a.elo-b.elo);
console.log('\n  MEASURED CURVE  (' + P.length + ' points, ' +
  P.reduce((a,p)=>a+GAMES_PER_POINT,0) + ' games)');
console.log('  elo     s        +/-');
for (const p of P) console.log('  ' + String(p.elo).padEnd(8) + p.s.toFixed(4) + '   ' + p.ci);

console.log('\n// Lookup table, 50-Elo steps. c is Regan closed form.');
console.log('// s inside the measured range is interpolated between measured points;');
console.log('// outside it, the seed fit is used and the value is provisional.');
console.log('const FLOUNDER_LADDER = [');
for (let e=600; e<=2600; e+=50)
  console.log(`  { elo: ${e}, s: ${Math.exp(lnSAt(e)).toFixed(4)}, c: ${reganC(e).toFixed(3)} },`);
console.log('];');
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

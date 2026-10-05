// Two jobs, one run.
//
// A. RE-MEASURE the three anchors that sat off any smooth trend — 600, 1350 and
//    2100 — at roughly double the games. A straight-line fit through the nine
//    anchors left an RMS residual of ~0.114 in ln(s), and these three carried it.
//    Either they were noisy (the 1350 search wandered 0.109 → 0.080 before
//    landing, which is what a bad probe chain looks like) or the s→Elo relation
//    is genuinely bumpy once c moves with it. This tells us which.
//
// B. SPOT-CHECK two INTERPOLATED rungs — 1450 and 1950 — that no anchor measured.
//    The table's actual claim is about the points BETWEEN anchors, and nothing
//    has tested that claim. No search here: take s straight from the table and
//    measure what it plays at.
//
// Run with the dev server up on :3100.
//   node scripts/verify-flounder-ladder.mjs [probeGames] [confirmGames] [plies]
import { chromium } from 'playwright';

const REMEASURE = [2100, 1350, 600];
const SPOTCHECK = [1950, 1450];
const PROBE   = Number(process.argv[2] || 4);    // per colour
const CONFIRM = Number(process.argv[3] || 10);   // per colour
const PLIES   = Number(process.argv[4] || 70);
const ITERS   = 4;

// The nine anchors as measured, piecewise-linear in ln(s) — the table under test.
const ANCHORS = [[600,0.1438],[792,0.1089],[1129,0.1112],[1321,0.0767],[1600,0.0923],
                 [1821,0.0823],[2129,0.0870],[2292,0.0773],[2720,0.0615]];
const reganC = e => Math.max(0.28, Math.min(0.55, 0.436 + (e - 1600) * 0.00007));
const tableS = e => {
  if (e <= ANCHORS[0][0]) return ANCHORS[0][1];
  if (e >= ANCHORS[ANCHORS.length-1][0]) return ANCHORS[ANCHORS.length-1][1];
  for (let i = 0; i < ANCHORS.length-1; i++)
    if (e >= ANCHORS[i][0] && e <= ANCHORS[i+1][0]) {
      const t = (e - ANCHORS[i][0]) / (ANCHORS[i+1][0] - ANCHORS[i][0]);
      return Math.exp(Math.log(ANCHORS[i][1]) + t*(Math.log(ANCHORS[i+1][1]) - Math.log(ANCHORS[i][1])));
    }
  return ANCHORS[ANCHORS.length-1][1];
};
const impliedElo = sc => { const s = Math.min(0.96, Math.max(0.04, sc)); return -400*Math.log10(1/s - 1); };

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

// ── B first: it is the cheaper half and the more important claim ──────
console.log('B. INTERPOLATED RUNGS — no search, table values played as-is\n');
const spot = [];
for (const R of SPOTCHECK) {
  const s = tableS(R), c = reganC(R);
  const r = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
    { s, c, R, CONFIRM, PLIES });
  const gap = r.score === null ? 0 : impliedElo(r.score);
  const meas = Math.round(R + gap);
  spot.push({ R, s, c, meas, r });
  console.log('  ' + R + '  s=' + s.toFixed(4) + ' c=' + c.toFixed(3) + '   ' +
    (100*r.score).toFixed(0) + '% over ' + r.n + ' games  → ' + meas +
    '   (' + (meas-R>=0?'+':'') + (meas-R) + ')' +
    '   clean ' + (100*r.clean).toFixed(0) + '%  >300 ' + (100*r.big).toFixed(0) + '%');
}

// ── A: re-measure the off-trend anchors ───────────────────────────────
console.log('\nA. RE-MEASURED ANCHORS — double games\n');
const redo = [];
for (const R of REMEASURE) {
  const c = reganC(R);
  const was = tableS(R);
  console.log('  == ' + R + '  (previously s=' + was.toFixed(4) + ') ==');
  let lnS = Math.log(was), slope = 3200, prev = null, best = null;
  for (let it = 0; it < ITERS; it++) {
    const s = Math.exp(lnS);
    const r = await page.evaluate(({s,c,R,PROBE,PLIES}) => window.probe(s,c,R,PROBE,PLIES),
      { s, c, R, PROBE, PLIES });
    if (r.score === null) break;
    const gap = impliedElo(r.score);
    console.log('     s=' + s.toFixed(4) + '  ' + (100*r.score).toFixed(0) + '%  ' +
      (gap>=0?'+':'') + Math.round(gap));
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { s, gap, lnS };
    if (Math.abs(gap) < 60) break;
    if (prev && Math.abs(lnS - prev.lnS) > 1e-6) {
      const est = (prev.gap - gap) / (lnS - prev.lnS);
      if (est > 300 && est < 12000) slope = 0.5*slope + 0.5*est;
    }
    prev = { lnS, gap };
    lnS += Math.max(-0.35, Math.min(0.35, gap / slope));
  }
  let s = best ? best.s : Math.exp(lnS);
  let conf = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
    { s, c, R, CONFIRM, PLIES });
  let gap = conf.score === null ? 0 : impliedElo(conf.score);
  if (Math.abs(gap) > 60) {
    const s2 = Math.exp(Math.log(s) + Math.max(-0.3, Math.min(0.3, gap/slope)));
    const c2 = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
      { s: s2, c, R, CONFIRM, PLIES });
    const g2 = c2.score === null ? 0 : impliedElo(c2.score);
    console.log('     correct s=' + s2.toFixed(4) + '  ' + (100*c2.score).toFixed(0) + '%  → ' + Math.round(R+g2));
    if (Math.abs(g2) < Math.abs(gap)) { s = s2; conf = c2; gap = g2; }
  }
  console.log('     final s=' + s.toFixed(4) + '  → ' + Math.round(R+gap) +
    '   was ' + was.toFixed(4) + '   change ' + ((s/was-1)*100).toFixed(0) + '%\n');
  redo.push({ R, c, sOld: was, sNew: s, meas: Math.round(R+gap), r: conf });
}

console.log('  SUMMARY');
console.log('  interpolated   claimed   measured   error');
for (const x of spot)
  console.log('  ' + String(x.R).padEnd(15) + String(x.R).padEnd(10) +
    String(x.meas).padEnd(11) + (x.meas-x.R>=0?'+':'') + (x.meas-x.R));
console.log('\n  anchor   s(old)   s(new)   change   measured');
for (const x of redo)
  console.log('  ' + String(x.R).padEnd(9) + x.sOld.toFixed(4).padEnd(9) +
    x.sNew.toFixed(4).padEnd(9) + ((x.sNew/x.sOld-1)*100).toFixed(0).padStart(4) + '%    ' + x.meas);
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

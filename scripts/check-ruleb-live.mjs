// Smoke test: does the overshoot cap change the measured rating?
//
// Run at the LOWEST MEASURED anchor (732, s=0.1133) rather than at 600, because
// 600 is below the measured range and its s is extrapolated — comparing there
// would mix two unknowns. At 732 we have a clean reference: 732 +/-74 with the
// rule off.
//
// 20 games gives +/-304 at 95%. That cannot resolve the predicted +7 Elo; it is
// a check that nothing is badly wrong, not a measurement.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const TARGET = 732, S = 0.1133;
const C = Math.max(0.28, Math.min(0.55, 0.436 + (TARGET - 1600) * 0.00007));
const MARGIN = 0.5;
const PER_OPP = Number(process.argv[2] || 5);   // per colour, per opponent → 20 total
const PLIES = 70;

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
await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, { timeout: 900000 });
console.log('ready.\n');

await page.evaluate(() => {
  window.gScale = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  window.weibull = (s, c) => s * Math.pow(-Math.log(1 - Math.random()), 1 / c);
  // Target-loss selection WITH the overshoot cap.
  window.moveRuleB = async (fen, s, c, margin) => {
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
    // Nearest to the target AMONG moves no worse than target + margin.
    // delta = 0 always qualifies, so this can never come up empty.
    let k = -1, gap = Infinity;
    for (let i = 0; i < scored.length; i++) {
      if (d[i] > tau + margin) continue;
      const gg = Math.abs(d[i] - tau);
      if (gg < gap) { gap = gg; k = i; }
    }
    if (k < 0) { let lo = Infinity; for (let i=0;i<d.length;i++) if (d[i]<lo){lo=d[i];k=i;} }
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
  window.play = async (s, c, margin, opp, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat=(b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let pts=0,n=0,w=0,dr=0,l=0,cpSum=0,cpN=0,big=0,clean=0;
    for(let gm=0; gm<games*2; gm++){
      const fW=gm%2===0;
      let bd=parseFen(START),tn='w',ep=-1,cst={wK:true,wQ:true,bK:true,bQ:true};
      for(let k=0;k<Math.floor(gm/2);k++){
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
          const r=await window.moveRuleB(fen,s,c,margin); uci=r.uci;
          if(r.cp!=null){cpSum+=r.cp;cpN++;if(r.cp>300)big++;if(r.cp<=20)clean++;}
        } else uci=await window.maiaMove(fen,opp);
        if(!uci||uci==='(none)'){bad=true;break;}
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f]){bad=true;break;}
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      if(bad) continue;
      const fC=fW?'w':'b', mC=fW?'b':'w';
      let p;
      if(res==='draw'){p=0.5;dr++;} else if(res===fC){p=1;w++;} else if(res===mC){p=0;l++;}
      else {const md=mat(bd,fC)-mat(bd,mC);p=md>1?1:md<-1?0:0.5; if(p===1)w++;else if(p===0)l++;else dr++;}
      pts+=p;n++;
    }
    return { score:n?pts/n:null, n, w, d:dr, l, acpl:cpN?cpSum/cpN:null,
             big:cpN?big/cpN:null, clean:cpN?clean/cpN:null };
  };
});

console.log('  rule B live   s=' + S + '  c=' + C.toFixed(3) + '  margin ' + MARGIN);
console.log('  reference: same s measured 732 +/-74 with the rule OFF\n');
const res = [];
for (const opp of [TARGET - 100, TARGET + 100]) {
  const r = await page.evaluate(({S,C,MARGIN,opp,PER_OPP,PLIES}) =>
    window.play(S,C,MARGIN,opp,PER_OPP,PLIES), { S, C, MARGIN, opp, PER_OPP, PLIES });
  res.push({ opp, ...r });
  console.log('  v Maia ' + opp + '   ' + (100*r.score).toFixed(0) + '%  (' +
    r.w + 'W ' + r.d + 'D ' + r.l + 'L)   ACPL ' + Math.round(r.acpl) +
    'cp  clean ' + (100*r.clean).toFixed(0) + '%  >300 ' + (100*r.big).toFixed(0) + '%');
}
let R = TARGET, tot = res.reduce((a,x)=>a+x.n,0);
for (let it=0; it<60000; it++){
  let g=0;
  for (const x of res) g += x.n*(x.score - 1/(1+Math.pow(10,-(R-x.opp)/400)));
  R += 0.05*g;
}
const sigma = 694.9*Math.sqrt(0.25/tot);
console.log('\n  measured: ' + Math.round(R) + '   (reference 732, difference ' +
  (Math.round(R-732)>=0?'+':'') + Math.round(R-732) + ')');
console.log('  95% interval ' + Math.round(R-1.96*sigma) + ' to ' + Math.round(R+1.96*sigma) +
  '   over ' + tot + ' games');
console.log('  predicted effect of the rule: +7 Elo — far below what ' + tot + ' games can resolve.');
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

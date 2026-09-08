// One interpolated rung, bracketed from both sides.
//
// Under test: elo 1450 from the SMOOTH FIT — s = exp(-1.9157 - 3.117e-4*1450).
// Not the piecewise table's 0.0836, which already measured 1597 (+147); the fit
// pulls this point to 0.0937, and the question is whether that correction is real.
//
// Bracketing beats a single 50% target. If the agent truly is 1450 it should
// score ~64% against Maia 1350 and ~36% against Maia 1550. Two independent
// 26-game samples combine to about +/-49 Elo (1 sigma), against +/-78 for one
// 20-game sample at a single anchor.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const ELO = 1450;
const S = Math.exp(-1.9157 + -3.117e-4 * ELO);
const C = Math.max(0.28, Math.min(0.55, 0.436 + (ELO - 1600) * 0.00007));
const OPPONENTS = [1350, 1550];
const GAMES = Number(process.argv[2] || 13);   // per colour → 26 per opponent
const PLIES = Number(process.argv[3] || 70);

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
    let pts=0,n=0,cpSum=0,cpN=0,big=0,huge=0,clean=0,w=0,d=0,l=0;
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
      if(res==='draw'){p=0.5;d++;} else if(res===fC){p=1;w++;} else if(res===mC){p=0;l++;}
      else {const md=mat(bd,fC)-mat(bd,mC); p=md>1?1:md<-1?0:0.5; if(p===1)w++;else if(p===0)l++;else d++;}
      pts+=p;n++;
    }
    return { score:n?pts/n:null, n, w, d, l, acpl:cpN?cpSum/cpN:null,
             big:cpN?big/cpN:null, huge:cpN?huge/cpN:null, clean:cpN?clean/cpN:null };
  };
});

console.log('  under test:  elo ' + ELO + '   s = ' + S.toFixed(4) + '   c = ' + C.toFixed(3));
console.log('  (piecewise table said s = 0.0836 and it measured 1597)\n');

const res = [];
for (const opp of OPPONENTS) {
  const r = await page.evaluate(({S,C,opp,GAMES,PLIES}) => window.probe(S,C,opp,GAMES,PLIES),
    { S, C, opp, GAMES, PLIES });
  const expect = 1 / (1 + Math.pow(10, -(ELO - opp) / 400));
  res.push({ opp, ...r });
  console.log('  v Maia ' + opp + '   ' + (100*r.score).toFixed(1) + '%  (' +
    r.w + 'W ' + r.d + 'D ' + r.l + 'L of ' + r.n + ')   expected ' +
    (100*expect).toFixed(0) + '%   clean ' + (100*r.clean).toFixed(0) +
    '%  >300 ' + (100*r.big).toFixed(0) + '%');
}

// Maximum likelihood over BOTH results, opponents fixed at their labels.
let R = ELO;
for (let it = 0; it < 60000; it++) {
  let g = 0;
  for (const r of res) g += r.n * (r.score - 1/(1+Math.pow(10,-(R-r.opp)/400)));
  R += 0.05 * g;
}
// Standard error from the combined sample.
const varSum = res.reduce((a,r) => a + r.n, 0);
const sigma = 694.9 * Math.sqrt(0.25 / varSum);

console.log('\n  combined estimate: ' + Math.round(R) + '   (label ' + ELO + ', error ' +
  (Math.round(R-ELO)>=0?'+':'') + Math.round(R-ELO) + ')');
console.log('  1 sigma +/-' + Math.round(sigma) + '   95% interval ' +
  Math.round(R-1.96*sigma) + ' to ' + Math.round(R+1.96*sigma));
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

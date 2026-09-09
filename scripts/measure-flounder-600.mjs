// Can Flounder actually play at 600, and what s does it take?
//
// The shipped ladder's lowest MEASURED rung is 732. Below that flounderParams
// extrapolates on the end slope, which gives s ~ 0.120 at 600 — a SMALLER s
// than the earlier nine-anchor run measured there (0.1438), and smaller s means
// stronger play. If the extrapolation is wrong in that direction then the dial
// cannot honestly offer 600 at all, because the bot standing there would be
// playing well above it.
//
// This settles it by measurement: play each candidate s against Maia 600 and
// see which one scores even. Same rule the ladder was measured on — the shipped
// target-loss selection, including the overshoot cap the production calibrator
// predates.
//
// Run with the dev server up on :3100.
//   node scripts/measure-flounder-600.mjs [gamesPerPoint] [plies]
import { chromium } from 'playwright';

const GAMES = Number(process.argv[2] || 40);
const PLIES = Number(process.argv[3] || 70);
const TARGET = 600;
const C = Math.max(0.28, Math.min(0.55, 0.436 + (TARGET - 1600) * 0.00007)); // 0.366

// The extrapolated value, the earlier measured value, and one between them.
const CANDIDATES = [0.1196, 0.1320, 0.1438, 0.1600];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
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
  window.gScale  = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  window.weibull = (s, c) => s * Math.pow(-Math.log(1 - Math.random()), 1 / c);

  // The SHIPPED rule, cap included. fit-flounder-adaptive-refine predates the
  // cap, so its version could answer "throw away 40cp" by hanging a rook.
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
    let k = -1, gap = Infinity;
    for (let i = 0; i < scored.length; i++) {
      if (d[i] > tau + FLOUNDER_OVERSHOOT_MARGIN) continue;
      const gg = Math.abs(d[i] - tau);
      if (gg < gap) { gap = gg; k = i; }
    }
    if (k < 0) { let lo = Infinity; for (let i = 0; i < d.length; i++) if (d[i] < lo) { lo = d[i]; k = i; } }
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

const implied = sc => {
  const p = Math.max(0.02, Math.min(0.98, sc));
  return -400 * Math.log10(1 / p - 1);
};

console.log(`Flounder vs Maia ${TARGET}, c = ${C.toFixed(3)}, ${GAMES} games each, ${PLIES} plies.`);
console.log('A score near 50% means the candidate really is a ' + TARGET + '.\n');
console.log('     s      score    implied      ACPL   clean   >300cp');
console.log('  --------------------------------------------------------');
const rows = [];
for (const s of CANDIDATES) {
  const r = await page.evaluate(({ s, c, elo, games, plies }) =>
    window.probe(s, c, elo, games, plies),
    { s, c: C, elo: TARGET, games: GAMES, plies: PLIES });
  if (r.score === null) { console.log('  s=' + s + '  all games aborted'); continue; }
  const el = TARGET + implied(r.score);
  rows.push({ s, score: r.score, elo: el });
  console.log('  ' + s.toFixed(4).padStart(6) +
    ('  ' + (100 * r.score).toFixed(0) + '%').padStart(9) +
    ('  ' + Math.round(el)).padStart(10) +
    ('  ' + (r.acpl != null ? Math.round(r.acpl) + 'cp' : '-')).padStart(10) +
    ('  ' + (r.clean != null ? Math.round(100 * r.clean) + '%' : '-')).padStart(8) +
    ('  ' + (r.big != null ? Math.round(100 * r.big) + '%' : '-')).padStart(9));
}

console.log('\n  ' + GAMES + ' games gives roughly +/-' + Math.round(400 / Math.sqrt(GAMES)) +
  ' Elo, so read the ORDERING, not the individual numbers.');
const best = rows.slice().sort((a, b) => Math.abs(a.score - 0.5) - Math.abs(b.score - 0.5))[0];
if (best) console.log('  Closest to even: s = ' + best.s.toFixed(4) +
  ' at ' + (100 * best.score).toFixed(0) + '%');

await browser.close();

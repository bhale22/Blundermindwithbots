// Two-parameter calibration: Regan's c per rating, s MEASURED at each one.
//
// Why not derived: holding the distribution's mean fixed while taking c from
// Regan collapsed four ratings onto the same ~2000 agent. Lower c concentrates
// mass near zero, so the median error shrinks and the bot plays near-best moves
// almost always — the rare catastrophe is not frequent enough to cost it games.
// Strength is not mean-driven, so s cannot be derived from the mean.
//
// So each rating gets its own search. The trick that makes it affordable: to
// calibrate an R-agent, play it against MAIA AT R. A 50% score means it is
// playing at R — no ladder, no anchor chain, no accumulated error. One
// well-posed root-find per rating.
//
// Search is damped secant on ln(s), not bisection: the score already tells us
// HOW far off we are (via the Elo curve), so we can step proportionally and
// re-estimate the local slope as we go. That matters because the slope varies
// enormously — roughly 1400 Elo per ln-unit of s at the strong end and 3500 at
// the weak end.
//
// Run with the dev server up on :3100.
//   node scripts/fit-flounder-two-param.mjs [gamesPerProbe] [iterations] [plies]
import { chromium } from 'playwright';

const TARGETS = [1800, 1400, 1100, 800];
const GAMES  = Number(process.argv[2] || 3);   // per colour, per probe
const ITERS  = Number(process.argv[3] || 5);
const PLIES  = Number(process.argv[4] || 70);
const CONFIRM = 5;                              // per colour, final check

const reganC = elo => Math.max(0.28, Math.min(0.55, 0.436 + (elo - 1600) * 0.00007));
const impliedElo = sc => {
  const s = Math.min(0.96, Math.max(0.04, sc));
  return -400 * Math.log10(1 / s - 1);
};

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

const results = [];
for (const R of TARGETS) {
  const c = reganC(R);
  console.log('══ target ' + R + '   c = ' + c.toFixed(3) + ' ══');
  // Seed from the one calibrated point we have: s=0.174 at c=0.380 measured 716.
  // Stronger targets need smaller s.
  let lnS = Math.log(0.174) - (R - 716) / 2500;
  let slope = 2500;                    // Elo lost per unit increase in ln(s)
  let prev = null, best = null;

  for (let it = 0; it < ITERS; it++) {
    const s = Math.exp(lnS);
    const r = await page.evaluate(({s,c,R,GAMES,PLIES}) => window.probe(s,c,R,GAMES,PLIES),
      { s, c, R, GAMES, PLIES });
    if (r.score === null) { console.log('    probe failed'); break; }
    const gap = impliedElo(r.score);           // + means the agent is too strong
    console.log('    s=' + s.toFixed(4) + '  scored ' + (100*r.score).toFixed(0) +
      '%  → ' + (gap>=0?'+':'') + Math.round(gap) + ' Elo   ' +
      'ACPL ' + Math.round(r.acpl) + 'cp  clean ' + (100*r.clean).toFixed(0) +
      '%  >300 ' + (100*r.big).toFixed(0) + '%');
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { s, gap, r };
    if (Math.abs(gap) < 60) { console.log('    converged'); break; }
    // Re-estimate the local slope from the last two probes.
    if (prev && Math.abs(lnS - prev.lnS) > 1e-6) {
      const est = (prev.gap - gap) / (lnS - prev.lnS);
      if (est > 300 && est < 12000) slope = 0.5 * slope + 0.5 * est;
    }
    prev = { lnS, gap };
    let step = gap / slope;
    step = Math.max(-0.45, Math.min(0.45, step));   // damp wild jumps
    lnS += step;
  }

  // Confirm the best s with a larger sample.
  const s = best ? best.s : Math.exp(lnS);
  const conf = await page.evaluate(({s,c,R,CONFIRM,PLIES}) => window.probe(s,c,R,CONFIRM,PLIES),
    { s, c, R, CONFIRM, PLIES });
  const gap = conf.score === null ? null : impliedElo(conf.score);
  console.log('    confirm: s=' + s.toFixed(4) + '  ' + (100*conf.score).toFixed(0) +
    '% over ' + conf.n + ' games  → measured ' + Math.round(R + gap) + '\n');
  results.push({ R, c, s, measured: Math.round(R + gap), score: conf.score,
                 acpl: conf.acpl, clean: conf.clean, big: conf.big, huge: conf.huge });
}

console.log('  target    c       s        measured   ACPL    clean   >300cp   >800cp');
console.log('-------------------------------------------------------------------------');
for (const r of results) {
  console.log('  ' + String(r.R).padEnd(10) + r.c.toFixed(3).padEnd(8) +
    r.s.toFixed(4).padEnd(9) + String(r.measured).padEnd(11) +
    (Math.round(r.acpl)+'cp').padEnd(8) + ((100*r.clean).toFixed(0)+'%').padEnd(8) +
    ((100*r.big).toFixed(0)+'%').padEnd(9) + (100*r.huge).toFixed(0)+'%');
}
console.log('\nconst FLOUNDER_LADDER = [');
for (const r of results) console.log(`  { elo: ${r.R}, s: ${r.s.toFixed(4)}, c: ${r.c.toFixed(3)} },`);
console.log('];');
console.log('\n  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

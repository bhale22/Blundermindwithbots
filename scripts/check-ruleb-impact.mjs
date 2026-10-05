// Where does the overshoot cap actually fire, and would those moves have mattered?
//
// Mean centipawn loss is the wrong metric for this question — rule B removes the
// LARGEST overshoots, which are exactly the game-losing ones, so a 3cp change in
// the mean can hide a real shift in results.
//
// Worst case is bounded: the rule fires on ~0.1% of moves, so ~3.4% of games
// contain one, and if EVERY such move would have lost the game outright that is
// +18 Elo. Measuring a shift that small head-to-head would take ~1160 games.
//
// So instead of measuring the effect, tighten the bound. For every firing we
// record the position's evaluation BEFORE the move and what the prevented move
// would have done to it. A move that turns +400 into +100 costs nothing; a move
// that turns +50 into -600 loses the game. Counting which is which converts the
// "if 100% mattered" worst case into a real number.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const RATINGS = [600, 1200, 1600, 2000];
const NPOS = Number(process.argv[2] || 60);
const DRAWS = 600;
const MARGIN = 0.5;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => { if (!sfReady) await sfInit(); });
await page.waitForFunction(() => sfReady, { timeout: 60000 });

const out = await page.evaluate(async ({ RATINGS, NPOS, DRAWS, MARGIN }) => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const g = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  const reganC = e => Math.max(0.28, Math.min(0.55, 0.436 + (e - 1600) * 0.00007));
  const LAD = [[732,0.1133],[884,0.1065],[1118,0.1001],[1289,0.0941],[1559,0.0885],
               [1696,0.0832],[1959,0.0782],[2204,0.0735],[2387,0.0691]];
  const sAt = e => {
    if (e <= LAD[0][0]) return LAD[0][1];
    if (e >= LAD[LAD.length-1][0]) return LAD[LAD.length-1][1];
    for (let i=0;i<LAD.length-1;i++) if (e>=LAD[i][0] && e<=LAD[i+1][0]){
      const t=(e-LAD[i][0])/(LAD[i+1][0]-LAD[i][0]);
      return Math.exp(Math.log(LAD[i][1])+t*(Math.log(LAD[i+1][1])-Math.log(LAD[i][1])));
    }
    return LAD[LAD.length-1][1];
  };

  const fens = [];
  for (let game=0; game<12 && fens.length<NPOS; game++){
    let bd=parseFen(START),tn='w',ep=-1,cst={wK:true,wQ:true,bK:true,bQ:true};
    for (let i=0;i<46 && fens.length<NPOS;i++){
      let f,t;
      if (Math.random()<0.3){
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const d of legalMovesFor(sq,bd,ep,cst))opts.push([sq,d]);}
        if(!opts.length)break;
        [f,t]=opts[Math.floor(Math.random()*opts.length)];
      } else {
        const uci=await sfGetMove(boardToFen(bd,tn,cst,ep),6);
        if(!uci||uci==='(none)')break;
        f=fileRankToSq(uci.slice(0,2)); t=fileRankToSq(uci.slice(2,4));
        if(!bd[f])break;
      }
      const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
      bd=applyMove(f,t,bd,ep,'Q');ep=ne;tn=tn==='w'?'b':'w';
      if(i>=6) fens.push(boardToFen(bd,tn,cst,ep));
    }
  }

  const res = {};
  for (const r of RATINGS) res[r] = { draws:0, fired:0, decisive:0, alreadyLost:0,
                                      alreadyWon:0, cushioned:0, evals:[] };
  for (const fen of fens) {
    const moves=_fenLegalUcis(fen);
    if (moves.length<3) continue;
    const evals=await sfEvalMoves(fen,moves,REGAN_PROBE_DEPTH);
    if(!evals) continue;
    const scored=moves.filter(m=>evals[m]!=null);
    if(scored.length<3) continue;
    let best=-Infinity; for(const m of scored) if(evals[m]>best) best=evals[m];
    const cpLoss=scored.map(m=>best-evals[m]);
    const d=scored.map(m=>g(best)-g(evals[m]));
    const posEval=best;                       // eval if it plays well, mover's POV

    for (const r of RATINGS) {
      const s=sAt(r), c=reganC(r), st=res[r];
      for (let k=0;k<DRAWS;k++){
        st.draws++;
        const tau=s*Math.pow(-Math.log(1-Math.random()),1/c);
        let i0=0,bg=Infinity;
        for(let i=0;i<d.length;i++){const gg=Math.abs(d[i]-tau); if(gg<bg){bg=gg;i0=i;}}
        let iB=-1,bb=Infinity;
        for(let i=0;i<d.length;i++){
          if(d[i]>tau+MARGIN) continue;
          const gg=Math.abs(d[i]-tau); if(gg<bb){bb=gg;iB=i;}
        }
        if(iB<0) iB=cpLoss.indexOf(Math.min(...cpLoss));
        if(iB===i0) continue;
        st.fired++;
        // What would the prevented move have done?
        const after = posEval - cpLoss[i0];    // eval after the blunder
        if (posEval < -400) st.alreadyLost++;         // game already gone
        else if (after > 400) st.alreadyWon++;        // still winning afterwards
        else if (posEval > -100 && after < -300) st.decisive++;  // live → losing
        else st.cushioned++;
        st.evals.push([Math.round(posEval), Math.round(after)]);
      }
    }
  }
  return { res, RATINGS, nfens: fens.length };
}, { RATINGS, NPOS, DRAWS, MARGIN });

console.log('\n  positions: ' + out.nfens + '   margin ' + MARGIN + '\n');
console.log('  rating   fires    of those:  turns a live position into a loss   already lost   still winning   cushioned');
for (const r of out.RATINGS) {
  const st = out.res[r];
  const pct = x => st.fired ? (100*x/st.fired).toFixed(0)+'%' : '—';
  console.log('  ' + String(r).padEnd(9) + (100*st.fired/st.draws).toFixed(2) + '%' +
    '                     ' + pct(st.decisive).padEnd(8) +
    '                  ' + pct(st.alreadyLost).padEnd(14) + pct(st.alreadyWon).padEnd(16) + pct(st.cushioned));
}
console.log('\n  revised Elo bound (only the "live → loss" share can cost a game):');
for (const r of out.RATINGS) {
  const st = out.res[r];
  if (!st.fired) { console.log('  ' + r + '   no firings'); continue; }
  const fire = st.fired/st.draws, frac = st.decisive/st.fired;
  const pGame = 1-Math.pow(1-fire, 35);
  const dScore = pGame*frac*0.75;
  const elo = 400*Math.log10((0.5+dScore)/(0.5-dScore));
  console.log('  ' + String(r).padEnd(9) + '+' + elo.toFixed(1) + ' Elo   (was +18 worst case)');
}
await browser.close();

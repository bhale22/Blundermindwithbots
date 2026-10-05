// How often would a forced-move guard actually change Flounder's choice?
//
// Two candidate rules:
//   A. FORCED-MOVE  — if the 2nd-best move is >250cp below the best, play best.
//      Simple and explainable. Handles "recapture or lose the queen".
//      Misses "best 0, second -50, third -900": the gap to 2nd is small, so the
//      rule stays quiet while a large target can still select the -900 move.
//   B. OVERSHOOT CAP — choose the move nearest the target among those no worse
//      than (target + margin). Subsumes A: in a genuinely forced position the
//      only candidate left IS the good move.
//
// This spends no games. It replays the sampler over real positions and counts
// how often each rule would have changed the move, which is what decides whether
// the ladder we just measured survives the change or has to be refitted.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const RATINGS = [600, 1200, 1600, 2000];
const NPOS = Number(process.argv[2] || 40);
const DRAWS = 400;                 // target samples per position per rating
const FORCED_CP = 250;             // rule A threshold
const MARGINS = [0.25, 0.5, 1.0];  // rule B margins, in Regan's scaled units

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

const out = await page.evaluate(async ({ RATINGS, NPOS, DRAWS, FORCED_CP, MARGINS }) => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const g = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  const reganC = e => Math.max(0.28, Math.min(0.55, 0.436 + (e - 1600) * 0.00007));
  // s from the freshly measured ladder.
  const LAD = [[732,0.1133],[884,0.1065],[1118,0.1001],[1289,0.0941],[1559,0.0885],
               [1696,0.0832],[1959,0.0782],[2204,0.0735],[2387,0.0691]];
  const sAt = e => {
    if (e <= LAD[0][0]) return LAD[0][1];
    if (e >= LAD[LAD.length-1][0]) return LAD[LAD.length-1][1];
    for (let i=0;i<LAD.length-1;i++) if (e>=LAD[i][0] && e<=LAD[i+1][0]) {
      const t=(e-LAD[i][0])/(LAD[i+1][0]-LAD[i][0]);
      return Math.exp(Math.log(LAD[i][1])+t*(Math.log(LAD[i+1][1])-Math.log(LAD[i][1])));
    }
    return LAD[LAD.length-1][1];
  };

  // Collect varied positions across several short games.
  const fens = [];
  for (let game = 0; game < 8 && fens.length < NPOS; game++) {
    let bd = parseFen(START), tn='w', ep=-1, cst={wK:true,wQ:true,bK:true,bQ:true};
    for (let i = 0; i < 44 && fens.length < NPOS; i++) {
      let f, t;
      if (Math.random() < 0.25) {
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const d of legalMovesFor(sq,bd,ep,cst))opts.push([sq,d]);}
        if(!opts.length) break;
        [f,t]=opts[Math.floor(Math.random()*opts.length)];
      } else {
        const uci = await sfGetMove(boardToFen(bd,tn,cst,ep), 6);
        if (!uci || uci==='(none)') break;
        f=fileRankToSq(uci.slice(0,2)); t=fileRankToSq(uci.slice(2,4));
        if (!bd[f]) break;
      }
      const ne=computeEP(f,t,bd); cst=updateCastling(f,t,bd[f],cst);
      bd=applyMove(f,t,bd,ep,'Q'); ep=ne; tn=tn==='w'?'b':'w';
      if (i >= 6) fens.push(boardToFen(bd,tn,cst,ep));
    }
  }

  const stats = {};
  for (const r of RATINGS) {
    stats[r] = { n:0, forcedPos:0, ruleA:0, ruleB:{}, lossNow:0, lossA:0, lossB:{} };
    for (const m of MARGINS) { stats[r].ruleB[m]=0; stats[r].lossB[m]=0; }
  }
  let posWithCliff = 0, totalPos = 0;

  for (const fen of fens) {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 3) continue;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) continue;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 3) continue;
    let best=-Infinity; for (const m of scored) if (evals[m]>best) best=evals[m];
    const cpLoss = scored.map(m => best - evals[m]);
    const d = scored.map(m => g(best) - g(evals[m]));
    const sorted = [...cpLoss].sort((a,b)=>a-b);
    const gapTo2nd = sorted[1];
    totalPos++;
    if (gapTo2nd > FORCED_CP) posWithCliff++;

    for (const r of RATINGS) {
      const s = sAt(r), c = reganC(r);
      const st = stats[r];
      if (gapTo2nd > FORCED_CP) st.forcedPos += DRAWS;
      for (let k = 0; k < DRAWS; k++) {
        const tau = s * Math.pow(-Math.log(1-Math.random()), 1/c);
        // current behaviour: nearest in absolute distance
        let i0=0, bg=Infinity;
        for (let i=0;i<d.length;i++){const gg=Math.abs(d[i]-tau); if(gg<bg){bg=gg;i0=i;}}
        st.n++; st.lossNow += cpLoss[i0];
        // rule A
        const iA = (gapTo2nd > FORCED_CP) ? cpLoss.indexOf(0) : i0;
        if (iA !== i0) st.ruleA++;
        st.lossA += cpLoss[iA < 0 ? i0 : iA];
        // rule B, per margin
        for (const mg of MARGINS) {
          let iB=-1, bb=Infinity;
          for (let i=0;i<d.length;i++){
            if (d[i] > tau + mg) continue;
            const gg=Math.abs(d[i]-tau); if(gg<bb){bb=gg;iB=i;}
          }
          if (iB < 0) iB = cpLoss.indexOf(Math.min(...cpLoss));
          if (iB !== i0) st.ruleB[mg]++;
          st.lossB[mg] += cpLoss[iB];
        }
      }
    }
  }
  return { stats, totalPos, posWithCliff, RATINGS, MARGINS };
}, { RATINGS, NPOS, DRAWS, FORCED_CP, MARGINS });

console.log('\n  positions sampled: ' + out.totalPos +
  '   of which "forced" (2nd best >' + FORCED_CP + 'cp worse): ' + out.posWithCliff +
  '  (' + (100*out.posWithCliff/out.totalPos).toFixed(0) + '%)\n');
console.log('  rating   rule A fires   rule B fires (margin 0.25 / 0.5 / 1.0)');
console.log('  ------------------------------------------------------------');
for (const r of out.RATINGS) {
  const st = out.stats[r];
  const bs = out.MARGINS.map(m => (100*st.ruleB[m]/st.n).toFixed(1)+'%').join('  ');
  console.log('  ' + String(r).padEnd(9) + (100*st.ruleA/st.n).toFixed(1).padStart(6) + '%' +
    '        ' + bs);
}
console.log('\n  mean cp given away per move (calibration impact)');
console.log('  rating   now     rule A   rule B 0.25 / 0.5 / 1.0');
for (const r of out.RATINGS) {
  const st = out.stats[r];
  const bs = out.MARGINS.map(m => Math.round(st.lossB[m]/st.n)).join('    ');
  console.log('  ' + String(r).padEnd(9) + Math.round(st.lossNow/st.n).toString().padEnd(8) +
    Math.round(st.lossA/st.n).toString().padEnd(9) + bs);
}
await browser.close();

// Flounder vs Maia, with the opponent chosen adaptively.
//
// The first anchored run spent most of its games on pairings that carried no
// information — rungs that lost every game to every anchor, and one rung that
// won every game against all of them. A pairing only tells you something when
// the score lands away from 0% and 100%.
//
// So this walks the ladder: for each s, start near where the previous (stronger)
// rung landed, and step the Maia anchor down until the score falls in a band
// that actually constrains the rating. Rungs are monotonic in s, so the walk
// only ever moves one way.
//
// Run with the dev server up on :3100.
//   node scripts/fit-flounder-adaptive.mjs [gamesPerColour] [plies]
import { chromium } from 'playwright';

const S_RUNGS = [0.005, 0.01, 0.02, 0.035, 0.06, 0.10, 0.15, 0.22];
const ANCHORS = [600, 800, 1000, 1200, 1400, 1700, 2000];
const C = 0.45;
const GAMES = Number(process.argv[2] || 4);   // per colour
const PLIES = Number(process.argv[3] || 70);
const LO = 0.18, HI = 0.82;                    // informative score band

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
  window.flounderMove = async (fen, s, c) => {
    const moves = _fenLegalUcis(fen);
    if (moves.length < 2) return moves[0] || null;
    const evals = await sfEvalMoves(fen, moves, REGAN_PROBE_DEPTH);
    if (!evals) return null;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 2) return scored[0] || null;
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const p = {}; let tot = 0;
    for (const m of scored) {
      const d = _reganScale(best - evals[m]);
      const y = d <= 0 ? 1 : Math.exp(-Math.pow(d / s, c));
      p[m] = y; tot += y;
    }
    for (const m in p) p[m] /= tot;
    return sampleFromProbs(p, 1.0);
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
  window.playFvM = async (s, c, elo, games, plies) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
    const mat = (b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
    const anyLegal=(b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
      if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
    let ptsF = 0, n = 0;
    for (let g = 0; g < games * 2; g++) {
      const fWhite = g % 2 === 0;
      let bd = parseFen(START), tn='w', ep=-1, cst={wK:true,wQ:true,bK:true,bQ:true};
      for (let k = 0; k < Math.floor(g / 2); k++) {
        const opts=[];
        for(let sq=0;sq<64;sq++){const p=bd[sq];if(!p||p.color!==tn)continue;
          for(const d of legalMovesFor(sq,bd,ep,cst))opts.push([sq,d]);}
        if(!opts.length)break;
        const [f,t]=opts[Math.floor(Math.random()*opts.length)];
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      let res = null, bad = false;
      for (let i = 0; i < plies; i++) {
        if(!anyLegal(bd,tn,ep,cst)){res=inCheck(bd,tn)?(tn==='w'?'b':'w'):'draw';break;}
        const fen = boardToFen(bd,tn,cst,ep);
        const uci = ((tn==='w')===fWhite) ? await window.flounderMove(fen,s,c)
                                          : await window.maiaMove(fen,elo);
        if(!uci||uci==='(none)'){ bad=true; break; }
        const f=fileRankToSq(uci.slice(0,2)),t=fileRankToSq(uci.slice(2,4));
        if(!bd[f]){ bad=true; break; }
        const ne=computeEP(f,t,bd);cst=updateCastling(f,t,bd[f],cst);
        bd=applyMove(f,t,bd,ep,uci[4]?uci[4].toUpperCase():'Q');ep=ne;tn=tn==='w'?'b':'w';
      }
      if (bad) continue;
      const fCol=fWhite?'w':'b', mCol=fWhite?'b':'w';
      let p;
      if(res==='draw')p=0.5; else if(res===fCol)p=1; else if(res===mCol)p=0;
      else { const md=mat(bd,fCol)-mat(bd,mCol); p = md>1?1:md<-1?0:0.5; }
      ptsF += p; n++;
    }
    return { score: n ? ptsF/n : null, n };
  };
});

const obs = [];
const play = async (s, elo) => {
  const r = await page.evaluate(({s,C,elo,GAMES,PLIES}) => window.playFvM(s,C,elo,GAMES,PLIES),
    { s, C, elo, GAMES, PLIES });
  if (r.score === null) return null;
  obs.push({ s, elo, score: r.score, games: r.n });
  console.log(('    s=' + s + '  v  Maia ' + elo).padEnd(26) + '|' +
    ((100*r.score).toFixed(0)+'%').padStart(7) + '  (' + r.n + ' games)');
  return r.score;
};

console.log(`Adaptive walk. ${GAMES*2} games per pairing, ${PLIES} plies max.\n`);
let idx = ANCHORS.length - 1;   // start at the strongest anchor
for (const s of S_RUNGS) {
  console.log('  rung s=' + s);
  let guard = 0;
  while (guard++ < ANCHORS.length) {
    const sc = await play(s, ANCHORS[idx]);
    if (sc === null) break;
    if (sc > HI && idx < ANCHORS.length - 1) { idx++; continue; }   // too easy, go stronger
    if (sc < LO && idx > 0) { idx--; continue; }                     // too hard, go weaker
    break;                                                           // informative, or at an end
  }
}

// ── Fit: Maia fixed, Flounder free ───────────────────────────────────
const uniq = [...new Set(obs.map(o => o.s))];
const R = new Array(uniq.length).fill(1000);
const exp_ = d => 1 / (1 + Math.pow(10, -d/400));
const PRIOR = 1;   // lighter than before: the walk avoids saturated pairs, so
                   // there is less need to rescue undefeated ones, and a heavy
                   // prior visibly dragged the last fit toward the middle.
for (let it = 0; it < 40000; it++) {
  const g = new Array(uniq.length).fill(0);
  for (const o of obs) {
    const k = uniq.indexOf(o.s);
    const wt = o.games + PRIOR;
    const sc = (o.score * o.games + 0.5 * PRIOR) / wt;
    g[k] += wt * (sc - exp_(R[k] - o.elo));
  }
  for (let k = 0; k < uniq.length; k++) R[k] += 0.25 * g[k];
}

console.log('\n  s        Flounder Elo   pairings   evidence');
console.log('---------------------------------------------');
const rows = uniq.map((s,k)=>[Math.round(R[k]), s]).sort((a,b)=>b[0]-a[0]);
for (const [e,s] of rows) {
  const mine = obs.filter(o => o.s === s);
  const solid = mine.some(o => o.score > 0.1 && o.score < 0.9);
  console.log('  ' + String(s).padEnd(9) + String(e).padEnd(15) +
    String(mine.length).padEnd(11) + (solid ? 'measured' : 'BOUND ONLY'));
}

console.log('\nPaste into REGAN_ELO_S (measured rungs only):\n');
const good = rows.filter(([e,s]) => obs.some(o => o.s===s && o.score>0.1 && o.score<0.9));
console.log('const REGAN_ELO_S = [');
console.log('  ' + good.map(([e,s])=>`[${e}, ${s}]`).join(', ') + ',');
console.log('];');

console.log('\n  fit check');
let mae = 0;
for (const o of obs) {
  const pred = exp_(R[uniq.indexOf(o.s)] - o.elo);
  mae += Math.abs(pred - o.score);
  console.log('  s=' + String(o.s).padEnd(7) + 'v ' + String(o.elo).padEnd(6) +
    ' predicted ' + (100*pred).toFixed(0) + '%   measured ' + (100*o.score).toFixed(0) + '%');
}
console.log('\n  mean abs error: ' + (100*mae/obs.length).toFixed(1) + ' points');
console.log('  total games: ' + obs.reduce((a,o)=>a+o.games,0));
console.log('  page errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await browser.close();

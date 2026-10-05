// Do the rating LABELS mean anything?
//
// Move-match is calibrated (fit-regan-s.mjs), but matching one statistic does
// not prove the agent plays at that strength — the tail matters more than the
// mode. This plays Regan agents against each other and checks the score
// against the Elo expectation: a 400-point gap should score ~91%, 200 ~76%.
//
// If the implied gaps come out far smaller than the labelled ones, the model's
// rating axis is compressed and the labels are decoration.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const PAIRS = [[600, 1000], [1000, 1400], [1400, 1800], [1800, 2200], [600, 1400]];
const GAMES = Number(process.argv[2] || 8);   // per colour, so double this
const PLIES = Number(process.argv[3] || 90);

const expected = d => 1 / (1 + Math.pow(10, -d / 400));
const impliedElo = sc => {
  const s = Math.min(0.995, Math.max(0.005, sc));
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

console.log(`\n${GAMES * 2} games per pair, ${PLIES} plies max.\n`);
console.log('  matchup      | stronger scores | labelled gap  implied gap');
console.log('---------------+-----------------+--------------------------');

for (const [lo, hi] of PAIRS) {
  const r = await page.evaluate(async ({ lo, hi, GAMES, PLIES }) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P:1, N:3, B:3, R:5, Q:9, K:0 };
    const mat = (b,c) => { let m=0; for (let s=0;s<64;s++){const p=b[s]; if(p&&p.color===c)m+=VAL[p.piece]||0;} return m; };
    const anyLegal = (b,col,ep,cst) => {
      for (let sq=0; sq<64; sq++){const p=b[sq]; if(!p||p.color!==col)continue;
        if (legalMovesFor(sq,b,ep,cst).length) return true;} return false;
    };
    let hiPts = 0, n = 0, decisive = 0;
    for (let g = 0; g < GAMES * 2; g++) {
      const hiIsWhite = g % 2 === 0;
      let bd = parseFen(START), tn = 'w', ep = -1;
      let cst = { wK:true, wQ:true, bK:true, bQ:true };
      // Diverge openings.
      for (let k = 0; k < Math.floor(g / 2); k++) {
        const opts = [];
        for (let sq=0; sq<64; sq++){const p=bd[sq]; if(!p||p.color!==tn)continue;
          for (const d of legalMovesFor(sq,bd,ep,cst)) opts.push([sq,d]);}
        if (!opts.length) break;
        const [f,t] = opts[Math.floor(Math.random()*opts.length)];
        const ne = computeEP(f,t,bd); cst = updateCastling(f,t,bd[f],cst);
        bd = applyMove(f,t,bd,ep,'Q'); ep = ne; tn = tn==='w'?'b':'w';
      }
      let result = null;
      for (let i = 0; i < PLIES; i++) {
        if (!anyLegal(bd, tn, ep, cst)) {
          result = inCheck(bd, tn) ? (tn === 'w' ? 'b' : 'w') : 'draw';
          break;
        }
        const elo = ((tn === 'w') === hiIsWhite) ? hi : lo;
        const fen = boardToFen(bd, tn, cst, ep);
        const probs = await sfReganProbs(fen, elo);
        let uci = probs ? sampleFromProbs(probs, 1.0) : await sfGetMove(fen, 3);
        if (!uci || uci === '(none)') break;
        const f = fileRankToSq(uci.slice(0,2)), t = fileRankToSq(uci.slice(2,4));
        if (!bd[f]) break;
        const ne = computeEP(f,t,bd); cst = updateCastling(f,t,bd[f],cst);
        bd = applyMove(f,t,bd,ep, uci[4] ? uci[4].toUpperCase() : 'Q');
        ep = ne; tn = tn==='w'?'b':'w';
      }
      const hiCol = hiIsWhite ? 'w' : 'b', loCol = hiIsWhite ? 'b' : 'w';
      let pts;
      if (result === 'draw') pts = 0.5;
      else if (result === hiCol) { pts = 1; decisive++; }
      else if (result === loCol) { pts = 0; decisive++; }
      else {
        const md = mat(bd, hiCol) - mat(bd, loCol);
        pts = md > 1 ? 1 : md < -1 ? 0 : 0.5;   // adjudicate on material
      }
      hiPts += pts; n++;
    }
    return { score: hiPts / n, n, decisive };
  }, { lo, hi, GAMES, PLIES });

  const gap = hi - lo;
  const imp = impliedElo(r.score);
  console.log(
    ('  ' + lo + ' v ' + hi).padEnd(15) + '|' +
    ((100 * r.score).toFixed(0) + '%').padStart(10) + ' (exp ' +
    (100 * expected(gap)).toFixed(0) + '%)'.padEnd(2) + '|' +
    String(gap).padStart(9) + String(Math.round(imp)).padStart(13)
  );
}

console.log('\npage errors:', errs.length ? errs.slice(0, 3).join(' | ') : 'none');
await browser.close();

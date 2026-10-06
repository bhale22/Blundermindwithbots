// Where does each Stockfish Skill Level sit on the human scale?
//
// Stockfish's own strength numbers (UCI_Elo, and the ~1320 its docs give Skill
// Level 0) are COMPUTER ratings, anchored to engine-vs-engine lists. They are
// not on the scale a 1200 human plays at, so they cannot label a dial that
// also carries Maia and Flounder. This puts each level on that scale the same
// way the Flounder ladder was put there: play it against Maia, which is
// rating-grounded by construction, and find the Maia rating it scores 50%
// against. Same rules as that ladder (random opening plies, 70-ply horizon,
// material adjudication), so the two sets of numbers are comparable.
//
// Stockfish moves come from the app's own sfGetMove, so the level is measured
// at exactly the depth the app would play it at (<=4 -> depth 5, <=10 -> 8,
// else 12). Change that mapping and this has to be re-run.
//
// Method per level: play GAMES at a Maia rating, move the rating by the score's
// implied Elo difference, repeat ITERS times, then fit ONE rating to every game
// played (maximum likelihood over all the rounds, not just the last).
//
// Run with the dev server up on :3100.
//   node scripts/measure-sf-vs-maia.mjs --levels 0,2,4 --games 10 --iters 3 --workers 3
import { chromium } from 'playwright';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const LEVELS  = String(arg('levels', '0,2,4,6,8,11,15,20')).split(',').map(Number);
const GAMES   = Number(arg('games', 10));
const ITERS   = Number(arg('iters', 3));
const WORKERS = Number(arg('workers', 3));
const PLIES   = Number(arg('plies', 70));
const START   = Number(arg('start', 1600));
const LO = 600, HI = 2600;

const implied = sc => -400 * Math.log10(1 / Math.max(0.02, Math.min(0.98, sc)) - 1);
const expect  = (r, m) => 1 / (1 + Math.pow(10, (m - r) / 400));
const snap    = v => Math.max(LO, Math.min(HI, Math.round(v / 25) * 25));

// One rating fitted to every round: solve sum n_i (s_i - E(R - m_i)) = 0.
function fit(rounds) {
  let lo = -1000, hi = 4500;
  const f = r => rounds.reduce((a, x) => a + x.n * (x.score - expect(r, x.maia)), 0);
  if (f(lo) < 0) return { r: lo, se: null };
  if (f(hi) > 0) return { r: hi, se: null };
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  const r = (lo + hi) / 2;
  const info = rounds.reduce((a, x) => { const e = expect(r, x.maia); return a + x.n * e * (1 - e); }, 0);
  return { r, se: info > 0 ? (400 / Math.LN10) / Math.sqrt(info) : null };
}

const browser = await chromium.launch();

async function makeWorker(id) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('bm_welcomed', '1'); localStorage.setItem('bm_landingSeen', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { if (!sfReady) await sfInit(); });
  await page.waitForFunction(() => sfReady, { timeout: 60000 });
  await page.evaluate(async () => { if (!_maiaReady) await maiaDownloadModel(); });
  await page.waitForFunction(() => typeof _maiaReady !== 'undefined' && _maiaReady, { timeout: 900000 });
  await page.evaluate(() => {
    window.sfMove = async (fen, level) => {
      const u = await sfGetMove(fen, level);
      return u && u !== '(none)' ? u : null;
    };
    window.maiaMove = async (fen, elo) => {
      let probs = null;
      try { probs = await maia3GetMoveProbs(fen, elo); } catch (e) {}
      if (!probs || !Object.keys(probs).length) return null;
      return sampleFromProbs(probs, 1.0);
    };
    window.play = async (level, elo, games, plies) => {
      const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const VAL = { P:1,N:3,B:3,R:5,Q:9,K:0 };
      const mat = (b,col)=>{let m=0;for(let i=0;i<64;i++){const p=b[i];if(p&&p.color===col)m+=VAL[p.piece]||0;}return m;};
      const anyLegal = (b,col,ep,cst)=>{for(let sq=0;sq<64;sq++){const p=b[sq];if(!p||p.color!==col)continue;
        if(legalMovesFor(sq,b,ep,cst).length)return true;}return false;};
      let pts = 0, n = 0, w = 0, d = 0, l = 0, adj = 0, aborted = 0, ms = 0;
      for (let g = 0; g < games; g++) {
        const t0 = performance.now();
        const sfW = g % 2 === 0;
        sfWorker.postMessage('ucinewgame');
        let bd = parseFen(START), tn = 'w', ep = -1, cst = { wK:true, wQ:true, bK:true, bQ:true };
        for (let k = 0; k < Math.floor(g / 2) % 9; k++) {
          const opts = [];
          for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (!p || p.color !== tn) continue;
            for (const dd of legalMovesFor(sq, bd, ep, cst)) opts.push([sq, dd]); }
          if (!opts.length) break;
          const [f, t] = opts[Math.floor(Math.random() * opts.length)];
          const ne = computeEP(f, t, bd); cst = updateCastling(f, t, bd[f], cst);
          bd = applyMove(f, t, bd, ep, 'Q'); ep = ne; tn = tn === 'w' ? 'b' : 'w';
        }
        let res = null, bad = false;
        for (let i = 0; i < plies; i++) {
          if (!anyLegal(bd, tn, ep, cst)) { res = inCheck(bd, tn) ? (tn === 'w' ? 'b' : 'w') : 'draw'; break; }
          const fen = boardToFen(bd, tn, cst, ep);
          const uci = ((tn === 'w') === sfW) ? await window.sfMove(fen, level) : await window.maiaMove(fen, elo);
          if (!uci) { bad = true; break; }
          const f = fileRankToSq(uci.slice(0, 2)), t = fileRankToSq(uci.slice(2, 4));
          if (!bd[f]) { bad = true; break; }
          const ne = computeEP(f, t, bd); cst = updateCastling(f, t, bd[f], cst);
          bd = applyMove(f, t, bd, ep, uci[4] ? uci[4].toUpperCase() : 'Q'); ep = ne; tn = tn === 'w' ? 'b' : 'w';
        }
        if (bad) { aborted++; continue; }
        const sC = sfW ? 'w' : 'b', mC = sfW ? 'b' : 'w';
        let p;
        if (res === 'draw') p = 0.5; else if (res === sC) p = 1; else if (res === mC) p = 0;
        else { adj++; const md = mat(bd, sC) - mat(bd, mC); p = md > 1 ? 1 : md < -1 ? 0 : 0.5; }
        pts += p; n++; if (p === 1) w++; else if (p === 0) l++; else d++;
        ms += performance.now() - t0;
      }
      return { score: n ? pts / n : null, n, w, d, l, adj, aborted, secPerGame: n ? ms / n / 1000 : null };
    };
  });
  return { id, page, ctx };
}

process.stdout.write(`Starting ${WORKERS} worker(s) (Stockfish + Maia each)... `);
const workers = await Promise.all(Array.from({ length: WORKERS }, (_, i) => makeWorker(i)));
console.log('ready.');
console.log(`Levels ${LEVELS.join(', ')} · ${GAMES} games x ${ITERS} rounds each · ${PLIES} plies · Maia ${LO}-${HI}\n`);

const results = {};
const queue = LEVELS.slice();
const t0 = Date.now();

async function runWorker(wk) {
  while (queue.length) {
    const level = queue.shift();
    const rounds = [];
    let maia = START;
    for (let it = 0; it < ITERS; it++) {
      const r = await wk.page.evaluate(({ level, maia, games, plies }) => window.play(level, maia, games, plies),
        { level, maia, games: GAMES, plies: PLIES });
      if (!r.n) { console.log(`  L${level} @ Maia ${maia}: every game aborted (${r.aborted})`); break; }
      rounds.push({ maia, n: r.n, score: r.score });
      console.log(`  L${String(level).padStart(2)} @ Maia ${maia}: ${(100 * r.score).toFixed(0).padStart(3)}%` +
        `  +${r.w} =${r.d} -${r.l}  (adjudicated ${r.adj}, aborted ${r.aborted}, ${r.secPerGame.toFixed(1)}s/game)`);
      // Pinned at an end of the scale: going further would leave Maia's range.
      if ((maia === HI && r.score > 0.75) || (maia === LO && r.score < 0.25)) break;
      maia = snap(fit(rounds).r);
    }
    results[level] = { rounds, ...fit(rounds) };
  }
}
await Promise.all(workers.map(runWorker));

console.log(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min.\n`);
console.log('level   rating   ±1 SE   games   rounds (Maia rating: score)');
for (const level of LEVELS) {
  const r = results[level]; if (!r) continue;
  const n = r.rounds.reduce((a, x) => a + x.n, 0);
  const pinned = r.r > HI + 150 ? `> ${HI}` : r.r < LO - 150 ? `< ${LO}` : String(Math.round(r.r));
  console.log(`  ${String(level).padStart(2)}    ${pinned.padStart(6)}   ${r.se ? ('±' + Math.round(r.se)).padStart(5) : '    -'}   ${String(n).padStart(4)}    ` +
    r.rounds.map(x => `${x.maia}: ${(100 * x.score).toFixed(0)}%`).join(' · '));
}
await browser.close();

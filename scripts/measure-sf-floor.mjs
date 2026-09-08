// How beatable is each rung of the Stockfish ladder?
//
// The metric is the app's OWN definition of danger: after a side moves, how
// many of its pieces does getCaptureColor() mark red (hanging, or takeable by
// something cheaper)? Those are exactly the pieces the training overlays light
// up for the player. A bot a beginner can beat is one that leaves them there.
//
// Also measured: when the OPPONENT leaves free material, does this rung take
// it? A bot that hangs pieces but punishes yours instantly is still no fun.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const RUNGS = [-3, -2, -1, 0, 1, 2, 3, 5, 8];
const PLIES = Number(process.argv[2] || 60);
const GAMES = Number(process.argv[3] || 1);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

// Stockfish loads lazily; make sure the worker is up before timing anything.
await page.evaluate(async () => {
  if (typeof sfInit === 'function' && !sfReady) { try { await sfInit(); } catch (e) {} }
});
await page.waitForFunction(() => typeof sfReady !== 'undefined' && sfReady, { timeout: 60000 });

console.log(`\nSelf-play, ${GAMES} game(s) x ${PLIES} plies per rung. "hanging" = the app's own red/saw circle.\n`);
console.log('rung  skill depth |  plies with a       avg hanging  | free material');
console.log('                  |  hanging piece      per position | offered  taken');
console.log('------------------+----------------------------------+----------------');

const rows = [];
for (const rung of RUNGS) {
  const r = await page.evaluate(async ({ rung, PLIES, GAMES }) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    let bd = parseFen(START);
    let tn = 'w', ep = -1;
    let cst = { wK: true, wQ: true, bK: true, bQ: true };

    // A piece the overlays would ring red or saw-toothed: takeable material.
    const hangingFor = (b, color) => {
      const atk = buildAtk(b);
      let n = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = b[sq];
        if (!p || p.color !== color || p.piece === 'K') continue;
        const c = getCaptureColor(sq, p.color, b, atk);
        if (c === 'red' || c === 'saw') n++;
      }
      return n;
    };
    // Squares holding enemy material this side could legally capture, and that
    // the overlays already flag as loose.
    const freeGrabs = (b, color, epSq, castl) => {
      const opp = color === 'w' ? 'b' : 'w';
      const loose = new Set();
      const atk = buildAtk(b);
      for (let sq = 0; sq < 64; sq++) {
        const p = b[sq];
        if (!p || p.color !== opp || p.piece === 'K') continue;
        const c = getCaptureColor(sq, p.color, b, atk);
        if (c === 'red' || c === 'saw') loose.add(sq);
      }
      const grabbable = new Set();
      for (let sq = 0; sq < 64; sq++) {
        const p = b[sq];
        if (!p || p.color !== color) continue;
        for (const d of legalMovesFor(sq, b, epSq, castl)) if (loose.has(d)) grabbable.add(d);
      }
      return grabbable;
    };

    let hangPlies = 0, hangTotal = 0, plies = 0;
    let offered = 0, taken = 0;

    for (let g = 0; g < GAMES; g++) {
    bd = parseFen(START); tn = 'w'; ep = -1;
    cst = { wK:true, wQ:true, bK:true, bQ:true };
    // Random legal first move, so repeated games diverge immediately instead of
    // re-running the same position with a fresh noise seed.
    if (g > 0) {
      const opts = [];
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq]; if (!p || p.color !== 'w') continue;
        for (const d of legalMovesFor(sq, bd, ep, cst)) opts.push([sq, d]);
      }
      const [f, t] = opts[Math.floor(Math.random() * opts.length)];
      const nep0 = computeEP(f, t, bd);
      cst = updateCastling(f, t, bd[f], cst);
      bd = applyMove(f, t, bd, ep, 'Q'); ep = nep0; tn = 'b';
    }
    for (let i = 0; i < PLIES; i++) {
      const fen = boardToFen(bd, tn, cst, ep);
      const grabs = freeGrabs(bd, tn, ep, cst);
      const uci = await sfGetMove(fen, rung);
      if (!uci || uci === '(none)') break;
      const from = fileRankToSq(uci.slice(0, 2));
      const to   = fileRankToSq(uci.slice(2, 4));
      if (!bd[from]) break;
      if (grabs.size) { offered++; if (grabs.has(to)) taken++; }
      const mover = tn;
      const nep = computeEP(from, to, bd);
      cst = updateCastling(from, to, bd[from], cst);
      bd = applyMove(from, to, bd, ep, uci[4] ? uci[4].toUpperCase() : 'Q');
      ep = nep;
      tn = tn === 'w' ? 'b' : 'w';
      plies++;
      const h = hangingFor(bd, mover);
      hangTotal += h;
      if (h > 0) hangPlies++;
    }
    }
    const skill = Math.max(0, Math.min(20, rung));
    const depth = rung <= 0 ? Math.max(1, 4 + rung) : rung <= 4 ? 5 : rung <= 10 ? 8 : 12;
    return { rung, skill, depth, plies, hangPlies, hangTotal, offered, taken };
  }, { rung, PLIES, GAMES });

  rows.push(r);
  const pct = r.plies ? (100 * r.hangPlies / r.plies) : 0;
  const avg = r.plies ? (r.hangTotal / r.plies) : 0;
  const grab = r.offered ? (100 * r.taken / r.offered) : 0;
  console.log(
    String(r.rung).padStart(4) + '  ' +
    String(r.skill).padStart(5) + ' ' + String(r.depth).padStart(5) + ' |' +
    (pct.toFixed(0) + '%').padStart(12) + ' ' + String(r.plies).padStart(4) + ' plies' +
    avg.toFixed(2).padStart(13) + '  |' +
    String(r.offered).padStart(8) + (r.offered ? (' ' + grab.toFixed(0) + '%').padStart(7) : '      -')
  );
}

console.log('\npage errors:', errs.length ? errs.slice(0, 3).join(' | ') : 'none');
await browser.close();

// Head-to-head: how much material does each rung lose to a common reference?
//
// The self-play hanging-piece metric turned out flat across the whole ladder,
// because when both sides are equally weak the positions stay equally messy —
// it measured the position type, not the player. This measures strength
// directly: every rung plays a gauntlet against ONE fixed opponent, both
// colours, and we score the material it ends up down.
//
// Run with the dev server up on :3100.
//   node scripts/measure-sf-gauntlet.mjs [plies] [gamesPerColour] [referenceRung]
import { chromium } from 'playwright';

const RUNGS = [-3, -2, -1, 0, 1, 2, 3, 5];
const PLIES = Number(process.argv[2] || 80);
const GAMES = Number(process.argv[3] || 3);
const REF   = Number(process.argv[4] || 6);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
await page.evaluate(async () => {
  if (typeof sfInit === 'function' && !sfReady) { try { await sfInit(); } catch (e) {} }
});
await page.waitForFunction(() => typeof sfReady !== 'undefined' && sfReady, { timeout: 60000 });

console.log(`\nGauntlet vs rung ${REF}. ${GAMES} game(s) per colour, ${PLIES} plies max.`);
console.log('Material = the rung\'s own material minus the reference\'s, at the end.');
console.log('More negative = weaker = easier for a beginner to beat.\n');
console.log('rung  skill depth |  material vs ref  |  W   D   L   | mated');
console.log('------------------+-------------------+--------------+------');

for (const rung of RUNGS) {
  const r = await page.evaluate(async ({ rung, PLIES, GAMES, REF }) => {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
    const material = (b, col) => {
      let m = 0;
      for (let sq = 0; sq < 64; sq++) { const p = b[sq]; if (p && p.color === col) m += VAL[p.piece] || 0; }
      return m;
    };
    const anyLegal = (b, col, ep, cst) => {
      for (let sq = 0; sq < 64; sq++) {
        const p = b[sq]; if (!p || p.color !== col) continue;
        if (legalMovesFor(sq, b, ep, cst).length) return true;
      }
      return false;
    };

    let diffSum = 0, games = 0, w = 0, d = 0, l = 0, mated = 0;

    for (let g = 0; g < GAMES * 2; g++) {
      const rungIsWhite = g % 2 === 0;
      let bd = parseFen(START), tn = 'w', ep = -1;
      let cst = { wK: true, wQ: true, bK: true, bQ: true };
      // Diverge the openings so repeated games are not the same game.
      const opening = Math.floor(g / 2);
      for (let k = 0; k < opening; k++) {
        const opts = [];
        for (let sq = 0; sq < 64; sq++) {
          const p = bd[sq]; if (!p || p.color !== tn) continue;
          for (const dd of legalMovesFor(sq, bd, ep, cst)) opts.push([sq, dd]);
        }
        if (!opts.length) break;
        const [f, t] = opts[Math.floor(Math.random() * opts.length)];
        const ne = computeEP(f, t, bd);
        cst = updateCastling(f, t, bd[f], cst);
        bd = applyMove(f, t, bd, ep, 'Q'); ep = ne; tn = tn === 'w' ? 'b' : 'w';
      }

      let decided = null;
      for (let i = 0; i < PLIES; i++) {
        if (!anyLegal(bd, tn, ep, cst)) {
          decided = inCheck(bd, tn) ? (tn === 'w' ? 'b' : 'w') : 'draw';
          break;
        }
        const level = ((tn === 'w') === rungIsWhite) ? rung : REF;
        const uci = await sfGetMove(boardToFen(bd, tn, cst, ep), level);
        if (!uci || uci === '(none)') break;
        const from = fileRankToSq(uci.slice(0, 2));
        const to   = fileRankToSq(uci.slice(2, 4));
        if (!bd[from]) break;
        const ne = computeEP(from, to, bd);
        cst = updateCastling(from, to, bd[from], cst);
        bd = applyMove(from, to, bd, ep, uci[4] ? uci[4].toUpperCase() : 'Q');
        ep = ne; tn = tn === 'w' ? 'b' : 'w';
      }

      const rungCol = rungIsWhite ? 'w' : 'b';
      const refCol  = rungIsWhite ? 'b' : 'w';
      diffSum += material(bd, rungCol) - material(bd, refCol);
      games++;
      if (decided === 'draw') d++;
      else if (decided === rungCol) w++;
      else if (decided === refCol) { l++; mated++; }
      else {
        // Ran out of plies: score it on material.
        const md = material(bd, rungCol) - material(bd, refCol);
        if (md > 1) w++; else if (md < -1) l++; else d++;
      }
    }
    const skill = Math.max(0, Math.min(20, rung));
    const depth = rung <= 0 ? Math.max(1, 4 + rung) : rung <= 4 ? 5 : rung <= 10 ? 8 : 12;
    return { rung, skill, depth, avg: diffSum / games, games, w, d, l, mated };
  }, { rung, PLIES, GAMES, REF });

  console.log(
    String(r.rung).padStart(4) + '  ' +
    String(r.skill).padStart(5) + ' ' + String(r.depth).padStart(5) + ' |' +
    (r.avg >= 0 ? '+' : '') + r.avg.toFixed(1).padStart(r.avg >= 0 ? 8 : 9) + ' pawns'.padEnd(9) + '|' +
    String(r.w).padStart(4) + String(r.d).padStart(4) + String(r.l).padStart(4) + '   |' +
    String(r.mated).padStart(5)
  );
}

console.log('\npage errors:', errs.length ? errs.slice(0, 3).join(' | ') : 'none');
await browser.close();

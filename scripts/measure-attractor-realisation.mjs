// How much of its NOMINAL push does an attractor actually deliver?
//
// The documented magnitude is exp(budget / 150) on the move a maxed attractor
// most wants — 7.4x at Budget 300. Each attractor then multiplies that by
// tanh(<its own metric>), which is what grades one move against another, and
// that factor is well below 1 in real positions. The engine therefore under-
// delivered its own spec for a long time: a maxed trait at full budget moved
// its favourite move from 10% to 18%, where the spec says 49%.
//
// ATTRACTOR_REALISATION in src/50-bot-engine.js compensates for exactly that,
// and it is a measurement rather than a taste knob. This is the measurement.
//
// A ratio of 1.00 means the compensation is correct. Anything else: multiply
// the current ATTRACTOR_REALISATION by the ratio printed and re-run. Re-run it
// after changing ANY attractor's metric — the Attacker fix (absolute count to a
// delta) moved its own figure from 0.57 to 1.24 on its own.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

const FENS = [
  'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5',
  '2rq1rk1/pb1nbppp/1p2pn2/8/2BP4/2N1PN2/PP2QPPP/R1B2RK1 w - - 2 12',
  'r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 b - - 4 9',
];
const ATTRACTORS = ['attacker', 'fortkx', 'trade', 'spacecadet', 'gambito', 'structure',
                    'grabber', 'kingsafety', 'prophylaxis', 'chaos'];
const BUDGET = 300;

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

const r = await page.evaluate(async ({ fens, attractors, budget }) => {
  if (!sfReady) await sfInit();
  botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
  window._bcpCustomControls = []; window._bcpPieceValues = {};
  const out = {};
  for (const attr of attractors) {
    const maxes = [];
    for (const fen of fens) {
      const bd = parseFen(fen);
      const t = turn, ep = epSq, cst = castling;
      botPlayerColor = (t === 'w') ? 'black' : 'white';
      const moves = _fenLegalUcis(fen);
      window._bcpCpBudget = budget;
      window._bcpAttractorValues = { [attr]: 5 };
      const uni = {};
      moves.forEach(m => uni[m] = 1 / moves.length);
      const shaped = _botWithPosition(bd, t, ep, cst,
        () => applyMoveAttractors(uni, { rawWeights: true }));
      // The input is uniform at 1/n and applyMoveAttractors does not
      // renormalise, so w_i = (1/n)*exp(logBoost_i) and the boost comes back
      // exactly. Measuring log(w_i / mean(w)) instead looks reasonable and is
      // NOT linear in the scale — exp is convex, so the mean is dragged around
      // by the largest weight and the reading shrinks as the boosts grow.
      const n = moves.length;
      const logs = moves.map(m => Math.log(Math.max(1e-12, shaped[m] || 0) * n));
      // ABSOLUTE deflection. Some attractors steer by rewarding their favourite
      // and some by penalising everything else — Structure, on a position whose
      // formation is already tight, can only push moves DOWN, so its best score
      // is 0 and its steering lives entirely in the negative tail. Reading the
      // signed maximum called that attractor dead when it was working fine.
      maxes.push(Math.max(...logs.map(Math.abs)));
    }
    out[attr] = maxes.reduce((a, x) => a + x, 0) / maxes.length;
  }
  return out;
}, { fens: FENS, attractors: ATTRACTORS, budget: BUDGET });

const nominal = BUDGET / 150;   // one maxed attractor takes the whole budget
console.log('\nRealised log-boost on the favourite move, Budget ' + BUDGET +
  ' (nominal ' + nominal.toFixed(2) + ')\n');
let sum = 0;
for (const a of ATTRACTORS) {
  const v = r[a];
  sum += v;
  console.log('  ' + a.padEnd(12) + v.toFixed(3).padStart(7) +
    '   ' + (v / nominal).toFixed(3) + ' of nominal');
}
const ratio = (sum / ATTRACTORS.length) / nominal;
console.log('\n  mean: ' + ratio.toFixed(3) + ' of nominal');
console.log('\n  This is the number CHART_PREF_GAIN in bot-control-panel.html must');
console.log('  carry, so the illustrated personality is exactly as strong as a real');
console.log('  one at full tilt. Update it whenever this moves.\n');
await browser.close();

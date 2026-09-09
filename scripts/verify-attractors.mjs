// The personality controls, after the review.
//
// Each of these guards something that would fail silently. A control whose
// before/after measurements disagree about what they are counting produces a
// large, confident, wrong number; a control that takes budget without using it
// weakens every other control with no visible cause; and a control with a
// missing branch simply never fires, which looks exactly like a quiet setting.
//
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const FENS = [
  'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5',
  '2rq1rk1/pb1nbppp/1p2pn2/8/2BP4/2N1PN2/PP2QPPP/R1B2RK1 w - - 2 12',
];

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

// Max absolute log-boost each control puts on any move, across the positions.
const strength = await page.evaluate(async ({ fens, attrs }) => {
  if (!sfReady) await sfInit();
  botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
  window._bcpCustomControls = []; window._bcpPieceValues = {};
  const out = {};
  for (const attr of attrs) {
    let best = 0;
    for (const fen of fens) {
      const bd = parseFen(fen);
      const t = turn, ep = epSq, cst = castling;
      botPlayerColor = (t === 'w') ? 'black' : 'white';
      const moves = _fenLegalUcis(fen);
      window._bcpCpBudget = 300;
      window._bcpAttractorValues = { [attr]: 5 };
      const uni = {}; moves.forEach(m => uni[m] = 1 / moves.length);
      const shaped = _botWithPosition(bd, t, ep, cst,
        () => applyMoveAttractors(uni, { rawWeights: true }));
      const n = moves.length;
      for (const m of moves) {
        const lb = Math.abs(Math.log(Math.max(1e-12, shaped[m] || 0) * n));
        if (lb > best) best = lb;
      }
    }
    out[attr] = +best.toFixed(3);
  }
  return out;
}, { fens: FENS, attrs: ['attacker','fortkx','trade','spacecadet','gambito','structure',
                         'grabber','kingsafety','prophylaxis'] });

console.log('\n1   Every position control actually moves a move');
{
  // 2.00 is the nominal push for one maxed control at Budget 300. Anything
  // under a tenth of that is a control that is on but not working — which is
  // exactly what Structure looked like before its metric was fixed (0.006).
  for (const [k, v] of Object.entries(strength)) {
    ok(k.padEnd(12) + ' steers (' + v.toFixed(2) + ' of 2.00)', v > 0.2, String(v));
  }
}

console.log('\n2   Panicky takes no share of the centipawn budget');
{
  const r = await page.evaluate(() => {
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9';
    const bd = parseFen(fen);
    const t = turn, ep = epSq, cst = castling;
    botPlayerColor = 'black';
    const moves = _fenLegalUcis(fen);
    botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
    window._bcpCustomControls = []; window._bcpPieceValues = {};
    const probe = (vals) => {
      window._bcpCpBudget = 300; window._bcpAttractorValues = vals;
      const uni = {}; moves.forEach(m => uni[m] = 1 / moves.length);
      const shaped = _botWithPosition(bd, t, ep, cst,
        () => applyMoveAttractors(uni, { rawWeights: true }));
      const n = moves.length;
      return Math.max(...moves.map(m => Math.abs(Math.log(Math.max(1e-12, shaped[m] || 0) * n))));
    };
    return { alone: probe({ attacker: 5 }), withPressure: probe({ attacker: 5, pressure: 5 }) };
  });
  ok('adding a maxed Panicky does not weaken Attacker',
    Math.abs(r.alone - r.withPressure) < 1e-6,
    r.alone.toFixed(3) + ' vs ' + r.withPressure.toFixed(3));
}

console.log('\n3   Front-runner / Swindler acts in both directions');
{
  const r = await page.evaluate(() => {
    window._bcpAttractorValues = { compwin: 5 };
    sfCplxScore = 0.9;                       // a sharp position
    const base = 1.0;
    sfCplxEval = 200;  const winning = complexityAdjustedTemp(base);
    sfCplxEval = -200; const losing  = complexityAdjustedTemp(base);
    sfCplxEval = 0;    const level   = complexityAdjustedTemp(base);
    sfCplxScore = null; sfCplxEval = null;
    return { winning, losing, level };
  });
  ok('winning raises temperature for a front-runner', r.winning > 1.0, r.winning.toFixed(3));
  ok('losing lowers it — the branch that never existed', r.losing < 1.0, r.losing.toFixed(3));
  ok('and it is silent while the game is level', Math.abs(r.level - 1) < 1e-9, r.level.toFixed(3));
}

console.log('\n4   Space Cadet counts the same squares before and after');
{
  // The baseline loop and the per-candidate loop are separate pieces of code
  // over the same square set. If they ever disagree the delta is nonsense and
  // nothing else in the system would notice.
  const r = await page.evaluate(() => {
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9';
    const bd = parseFen(fen);
    const t = turn, ep = epSq, cst = castling;
    botPlayerColor = 'black';
    const moves = _fenLegalUcis(fen);
    botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
    window._bcpCustomControls = []; window._bcpPieceValues = {};
    window._bcpCpBudget = 300; window._bcpAttractorValues = { spacecadet: 5 };
    const uni = {}; moves.forEach(m => uni[m] = 1 / moves.length);
    const shaped = _botWithPosition(bd, t, ep, cst,
      () => applyMoveAttractors(uni, { rawWeights: true }));
    const n = moves.length;
    const boosts = moves.map(m => Math.log(Math.max(1e-12, shaped[m] || 0) * n));
    return { max: Math.max(...boosts), min: Math.min(...boosts) };
  });
  // A quiet move changes the weak-square count by one or two, not by thirty.
  // A mismatched square set showed up as every move pinned at full deflection.
  ok('no move is pinned at full deflection', r.max < 1.95, r.max.toFixed(3));
  ok('and the spread is a real gradient, not all-or-nothing',
    (r.max - r.min) > 0.05, (r.max - r.min).toFixed(3));
}

console.log('\n5   Responses scale with the material left on the board');
{
  const r = await page.evaluate(() => {
    const probe = (fen) => {
      const bd = parseFen(fen);
      const t = turn, ep = epSq, cst = castling;
      botPlayerColor = (t === 'w') ? 'black' : 'white';
      const moves = _fenLegalUcis(fen);
      botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;
      window._bcpCustomControls = []; window._bcpPieceValues = {};
      window._bcpCpBudget = 300; window._bcpAttractorValues = { attacker: 5 };
      const uni = {}; moves.forEach(m => uni[m] = 1 / moves.length);
      const shaped = _botWithPosition(bd, t, ep, cst,
        () => applyMoveAttractors(uni, { rawWeights: true }));
      const n = moves.length;
      return Math.max(...moves.map(m => Math.log(Math.max(1e-12, shaped[m] || 0) * n)));
    };
    // Same idea, two amounts of material: a full middlegame and a bare ending.
    const full = probe('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9');
    const thin = probe('8/5pk1/6p1/8/8/1R4P1/5PKP/8 w - - 0 40');
    return { full, thin };
  });
  ok('a control still speaks in a thin endgame', r.thin > 0.2,
    'full ' + r.full.toFixed(2) + ' / thin ' + r.thin.toFixed(2));
}

ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

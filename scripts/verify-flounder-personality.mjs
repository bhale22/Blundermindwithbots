// Does personality reach Flounder, and does it stay honest about the ladder?
//
// The 756-game ladder was measured on ONE selection rule: play the move nearest
// the sampled target that does not overshoot it. The band selector has to
// reduce to exactly that rule whenever no personality is configured, or every
// rating label on the dial stops describing the bot that ships.
//
// Everything here drives the real flounderApplyPersonality against real
// Stockfish evaluations on real positions, with the target held FIXED so the
// comparison is deterministic — the randomness normally lives in the target
// draw, and sampling it here would only add noise to the thing under test.
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
  'r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 b - - 4 9',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5',
  '2rq1rk1/pb1nbppp/1p2pn2/8/2BP4/2N1PN2/PP2QPPP/R1B2RK1 w - - 2 12',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

// One shared probe per position, reused by every case below.
const probe = await page.evaluate(async (fens) => {
  if (!sfReady) await sfInit();
  const g = v => Math.sign(v) * Math.log(1 + Math.abs(v) / 100);
  const out = [];
  for (const fen of fens) {
    const moves = _fenLegalUcis(fen);
    const evals = await sfEvalMoves(fen, moves, 8);
    if (!evals) continue;
    const scored = moves.filter(m => evals[m] != null);
    if (scored.length < 3) continue;
    let best = -Infinity;
    for (const m of scored) if (evals[m] > best) best = evals[m];
    const gBest = g(best);
    out.push({ fen, moves: scored, d: scored.map(m => gBest - g(evals[m])) });
  }
  return out;
}, FENS);

console.log('\n1   The hook is installed on both sides');
{
  const r = await page.evaluate(() => ({
    hook: typeof flounderApplyPersonality === 'function',
    raw: applyMoveAttractors.length >= 2,
  }));
  ok('flounderApplyPersonality exists', r.hook);
  ok('applyMoveAttractors takes the rawWeights option', r.raw);
  ok('the probe returned usable positions', probe.length >= 3, probe.length + ' positions');
}

// Drive the selector over a grid of fixed targets, under a given personality.
// Returns one row per (position, tau): the neutral choice and the actual one.
const run = (cfg) => page.evaluate(([probe, cfg]) => {
  const MARGIN = FLOUNDER_OVERSHOOT_MARGIN;
  window._bcpCpBudget = cfg.budget;
  window._bcpAttractorValues = cfg.attractors || {};
  window._bcpPieceValues = cfg.pieces || {};
  window._bcpCustomControls = [];
  botMinProbPct = 0; botBadDayMode = false; botDayLower = 0; botDayUpper = 100;

  const rows = [];
  for (const pos of probe) {
    const bd = parseFen(pos.fen);          // also sets turn/castling/epSq
    const t = turn, ep = epSq, cst = castling;
    botPlayerColor = (t === 'w') ? 'black' : 'white';   // bot is the side to move
    for (let step = 0; step <= 24; step++) {
      const tau = step * 0.05;
      let k0 = -1, gap = Infinity;
      for (let i = 0; i < pos.d.length; i++) {
        if (pos.d[i] > tau + MARGIN) continue;
        const gg = Math.abs(pos.d[i] - tau);
        if (gg < gap) { gap = gg; k0 = i; }
      }
      if (k0 < 0) continue;
      const k = _botWithPosition(bd, t, ep, cst,
        () => flounderApplyPersonality(pos.moves, pos.d, tau, k0, MARGIN));
      rows.push({ tau, k0, k, d0: pos.d[k0], dk: pos.d[k], cap: tau + MARGIN });
    }
  }
  return rows;
}, [probe, cfg]);

console.log('\n2   With no personality it is the old rule, exactly');
{
  const rows = await run({ budget: 200 });
  ok('every target still picks the nearest move', rows.every(r => r.k === r.k0),
    rows.filter(r => r.k !== r.k0).length + ' of ' + rows.length + ' diverged');
  ok('the sample is big enough to mean something', rows.length >= 80, String(rows.length));
}

console.log('\n3   A zero budget is off, whatever the attractors say');
{
  const rows = await run({ budget: 0, attractors: { attacker: 5 }, pieces: { knight: 5 } });
  ok('no deviation at budget 0', rows.every(r => r.k === r.k0),
    rows.filter(r => r.k !== r.k0).length + ' diverged');
}

console.log('\n4   A real personality moves the choice, both ways');
{
  const a = await run({ budget: 250, attractors: { attacker: 5 }, pieces: { knight: 5 } });
  const b = await run({ budget: 250, attractors: { attacker: -5 }, pieces: { knight: -5 } });
  const rows = a.concat(b);
  const moved = rows.filter(r => r.k !== r.k0);
  const better = moved.filter(r => r.dk < r.d0 - 1e-12).length;
  const worse  = moved.filter(r => r.dk > r.d0 + 1e-12).length;
  ok('the personality actually changes picks', moved.length > 0,
    moved.length + ' of ' + rows.length);
  ok('some picks cost LESS than the rating asked for', better > 0, String(better));
  ok('some picks cost MORE', worse > 0, String(worse));
  ok('so the band is two-sided, not a handicap',
    better > 0 && worse > 0, better + ' better / ' + worse + ' worse');
}

console.log('\n5   The overshoot cap still binds under personality');
{
  const rows = await run({ budget: 400, attractors: { attacker: 5 }, pieces: { knight: 5, queen: 5 } });
  ok('no pick overshoots its own target past the margin',
    rows.every(r => r.dk <= r.cap + 1e-9),
    String(rows.filter(r => r.dk > r.cap + 1e-9).length) + ' over the cap');
}

console.log('\n6   Selection given a target is deterministic');
{
  const cfg = { budget: 250, attractors: { attacker: 5 }, pieces: { knight: 5 } };
  const a = await run(cfg), b = await run(cfg);
  ok('the same target gives the same move twice',
    a.length === b.length && a.every((r, i) => r.k === b[i].k));
}

console.log('\n7   A bot with a personality still plays');
{
  await page.evaluate(() => {
    botSetTab('sf');
    const el = document.getElementById('flounderElo');
    if (el) el.value = 1600;
    window._bcpCpBudget = 250;
    window._bcpAttractorValues = { attacker: 5 };
    window._bcpPieceValues = { knight: 5 };
    botSetPlayerColor('white');
    quickBotStart();
  });
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => gameMovesAlgebraic.length);
  await page.evaluate(() => {
    const sq = fileRankToSq('e2'), dst = fileRankToSq('e4');
    if (legalMovesFor(sq, board, epSq, castling).includes(dst)) executeMove(sq, dst);
  });
  // Poll rather than sleep: think time is deliberately variable (the
  // "reconsider" habit multiplies it by 1.5-2.5x on about one move in seven),
  // so any fixed budget turns this into a coin flip.
  let after = before;
  for (let waited = 0; waited < 20000 && after < before + 2; waited += 250) {
    await page.waitForTimeout(250);
    after = await page.evaluate(() => gameMovesAlgebraic.length);
  }
  ok('the bot answered with a personality attached', after >= before + 2,
    before + ' -> ' + after);
  ok('and it is still Flounder playing',
    await page.evaluate(() => lastBotMoveSource) === 'Flounder');
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

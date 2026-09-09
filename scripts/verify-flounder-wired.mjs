// Does Flounder actually run inside the app, not just in a harness?
//
// Everything measured so far went through scripts that reimplemented the
// selector. This checks the real path: botMakeMove -> flounderChooseMove, at a
// level the slider can reach, in a live game.
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

console.log('\n1   The ladder and selector exist');
{
  const r = await page.evaluate(() => ({
    ladder: typeof FLOUNDER_LADDER !== 'undefined' && FLOUNDER_LADDER.length,
    chooser: typeof flounderChooseMove === 'function',
    params: typeof flounderParams === 'function',
    margin: typeof FLOUNDER_OVERSHOOT_MARGIN !== 'undefined' ? FLOUNDER_OVERSHOOT_MARGIN : null,
    gone: typeof sfReganProbs === 'undefined',
  }));
  // Nine from the 756-game adaptive run, plus 600 measured afterwards.
  ok('ten measured points are present', r.ladder === 10, String(r.ladder));
  ok('the selector is defined', r.chooser);
  ok('flounderParams is defined', r.params);
  ok('the overshoot cap is set', r.margin === 0.5, String(r.margin));
  ok('the old move-sampling entry point is gone', r.gone);
}

console.log('\n2   Parameters track the measured ladder');
{
  const r = await page.evaluate(() => {
    const out = {};
    for (const e of [600, 732, 1118, 1559, 2387, 2600]) out[e] = flounderParams(e);
    return out;
  });
  ok('732 reproduces its measured s exactly',
    Math.abs(r[732].s - 0.1133) < 1e-6, r[732].s.toFixed(5));
  // 600 is the rung the product is really about: the opponent a beginner can
  // beat with nothing to download. Measured separately at 40 games (implied
  // 626) after the main run, so it gets checked by name.
  ok('600 reproduces its measured s exactly',
    Math.abs(r[600].s - 0.1196) < 1e-6, r[600].s.toFixed(5));
  ok('1118 reproduces its measured s exactly',
    Math.abs(r[1118].s - 0.1001) < 1e-6, r[1118].s.toFixed(5));
  const eloOrder = [600, 732, 1118, 1559, 2387, 2600];
  let mono = true;
  for (let i = 1; i < eloOrder.length; i++)
    if (r[eloOrder[i]].s >= r[eloOrder[i-1]].s) mono = false;
  ok('s falls monotonically as rating rises', mono,
    eloOrder.map(e => r[e].s.toFixed(4)).join(' > '));
  ok('c follows Regan and rises with rating',
    Math.abs(r[1559].c - (0.436 + (1559-1600)*0.00007)) < 1e-9 && r[2600].c > r[600].c,
    r[600].c.toFixed(3) + ' -> ' + r[2600].c.toFixed(3));
}

console.log('\n2b  Temperature moves c, and nothing on this path uses T directly');
{
  const r = await page.evaluate(() => {
    const c0 = flounderTempAdjustedC(0.436, 1.0);
    return {
      neutral: c0,
      hot: flounderTempAdjustedC(0.436, 3.0),
      cold: flounderTempAdjustedC(0.436, 0.3),
      // flounderChooseMove must ACCEPT the effective temperature rather than
      // reaching for botMaiaBaseTemp() itself — that got the base only, so
      // curve B and the complexity dial were inert on this engine.
      takesTemp: flounderChooseMove.length >= 4,
      searchTakesThink: flounderMoveOrSearch.length >= 3,
      // and the closeness kernel must be built from the ADJUSTED c, not the
      // calibrated one, or temperature would move the sampling and leave the
      // personality band behind.
      kernelHot: flounderTargetMean(0.0885, flounderTempAdjustedC(0.436, 3.0)),
      kernelCold: flounderTargetMean(0.0885, flounderTempAdjustedC(0.436, 0.3)),
    };
  });
  ok('T = 1 leaves the measured shape alone', Math.abs(r.neutral - 0.436) < 1e-9,
    String(r.neutral));
  ok('a hotter setting thins c (thicker tail)', r.hot < r.neutral,
    r.hot.toFixed(4) + ' < ' + r.neutral.toFixed(4));
  ok('a colder setting raises it', r.cold > r.neutral,
    r.cold.toFixed(4) + ' > ' + r.neutral.toFixed(4));
  ok('the selector takes an effective temperature', r.takesTemp);
  ok('and the fallback path takes a think time to derive one', r.searchTakesThink);
  ok('the personality kernel follows the adjusted c', r.kernelHot > r.kernelCold,
    r.kernelHot.toFixed(4) + ' vs ' + r.kernelCold.toFixed(4));
}

console.log(String.fromCharCode(10) + '2c  Flounder 600 is reachable, not clamped away');
{
  const r = await page.evaluate(() => {
    botSetTab('sf');
    const el = document.getElementById('flounderElo');
    if (el) el.value = 600;
    return { min: FLOUNDER_ELO_MIN, sliderMin: el ? +el.min : null,
             eff: botEffectiveElo(), quickLo: QUICK_FLOUNDER_ELOS[0] };
  });
  ok('the floor is 600', r.min === 600, String(r.min));
  ok('the slider reaches it', r.sliderMin === 600, String(r.sliderMin));
  ok('and the bot actually plays at it', r.eff === 600, String(r.eff));
  ok('the quick picker offers it', r.quickLo === 600, String(r.quickLo));
}

console.log(String.fromCharCode(10) + '3   It picks moves, and respects the overshoot cap');
{
  const r = await page.evaluate(async () => {
    if (!sfReady) await sfInit();
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9';
    const legal = new Set(_fenLegalUcis(fen));
    const picks = [];
    for (let i = 0; i < 12; i++) picks.push(await flounderChooseMove(fen, 800));
    const good = picks.filter(p => p && p.uci && legal.has(p.uci));
    // Every pick must sit within the cap of its own sampled target.
    const capped = picks.every(p => !p || p.cp == null || p.tau == null ||
      Math.log(1 + Math.max(0, p.cp) / 100) <= p.tau + 0.5 + 1e-9);
    return { n: picks.length, good: good.length, capped,
             spread: new Set(good.map(p => p.uci)).size,
             worst: Math.max(...good.map(p => p.cp)) };
  });
  ok('every pick is a legal move', r.good === r.n, r.good + '/' + r.n);
  ok('no pick overshoots its target past the margin', r.capped);
  ok('it does not always play the same move', r.spread > 1, r.spread + ' distinct');
  ok('and it does give material away sometimes', r.worst > 0, r.worst + 'cp worst');
}

console.log('\n4   A real game runs through botMakeMove');
{
  const r = await page.evaluate(async () => {
    botSetTab('sf');
    const el = document.getElementById('flounderElo');
    if (el) el.value = 1000;              // the dial is a rating now, not a level
    botSetPlayerColor('white');
    quickBotStart();
    return { elo: botEffectiveElo() };
  });
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    active: typeof botActive !== 'undefined' && botActive,
    src: lastBotMoveSource,
    tab: botTab,
  }));
  ok('a bot game started on the Flounder tab', state.active && state.tab === 'sf',
    JSON.stringify(state));
  ok('botEffectiveElo reads the rating dial directly', r.elo === 1000, String(r.elo));

  // Play a few human moves and let the bot answer each one.
  const moves = [['e2','e4'], ['g1','f3'], ['f1','c4']];
  let replied = 0, attempted = 0;
  for (const [from, to] of moves) {
    const before = await page.evaluate(() => gameMovesAlgebraic.length);
    // The bot's replies vary, so a scripted human move can be illegal in the
    // position that actually arose. Skip those rather than counting them as a
    // failure to reply — executeMove does not check legality itself.
    const played = await page.evaluate(([f, t]) => {
      const sq = fileRankToSq(f), dst = fileRankToSq(t);
      if (!legalMovesFor(sq, board, epSq, castling).includes(dst)) return false;
      executeMove(sq, dst);
      return true;
    }, [from, to]);
    if (!played) continue;
    attempted++;
    // Wait for the reply rather than sleeping a fixed amount. Think time is
    // deliberately variable — the "reconsider" habit multiplies it by 1.5-2.5x
    // on about one move in seven — so any fixed budget is a coin flip, and this
    // test was failing roughly one run in three for that reason alone.
    let after = before;
    for (let waited = 0; waited < 20000 && after < before + 2; waited += 250) {
      await page.waitForTimeout(250);
      after = await page.evaluate(() => gameMovesAlgebraic.length);
    }
    if (after >= before + 2) replied++;
  }
  ok('the bot replied to each move', attempted > 0 && replied === attempted,
    replied + '/' + attempted);
  ok('moves are attributed to Flounder',
    await page.evaluate(() => lastBotMoveSource) === 'Flounder',
    await page.evaluate(() => String(lastBotMoveSource)));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

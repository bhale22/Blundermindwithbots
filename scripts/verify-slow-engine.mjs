// Does a bot still move on a device too slow (or too old) for the engine?
//
// Reported from an old Android phone: a Flounder bot played its book moves,
// then never moved again, locally and on Lichess. Every Stockfish search there
// outlasted its safety timeout, each timeout resolved null, and botMakeMove had
// nothing to fall back on, so the turn was simply dropped.
//
// A slow CPU can't be emulated here: CDP throttling slows the page's main thread,
// not the engine's Web Worker. So the worker is wrapped instead and its output
// held back — paced per line, or withheld — which is what a slow engine looks
// like from the page. A 'stop' drops the backlog, as a real engine stops
// promptly (measured: bestmove ~40 ms after stop on the vendored build).
//
// Needs the dev server on :3100 (or BM_URL). PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

// sim: { lineMs } paces every engine line after readyok by lineMs;
//      { dead: true } delivers nothing after readyok;
//      { noSimd: true } makes the browser report no WebAssembly SIMD.
async function openPage(sim) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript((sim) => {
    if (sim.noSimd) {
      const v = WebAssembly.validate.bind(WebAssembly);
      // Only the 31-byte SIMD probe fails; everything else validates as normal.
      WebAssembly.validate = (b) => (b && b.length === 31) ? false : v(b);
    }
    if (!sim.lineMs && !sim.dead) return;
    const W = window.Worker;
    window.Worker = function (url, o) {
      const w = new W(url, o);
      if (!/stockfish/.test(String(url))) return w;
      let handler = null, ready = false, q = [], timer = null;
      const pump = () => {
        timer = null;
        const e = q.shift();
        if (e && handler) handler(e);
        if (q.length) timer = setTimeout(pump, sim.lineMs);
      };
      w.addEventListener('message', (e) => {
        if (!ready) { if (e.data === 'readyok') ready = true; if (handler) handler(e); return; }
        if (sim.dead) return;
        q.push(e);
        if (!timer) timer = setTimeout(pump, sim.lineMs);
      });
      const post = w.postMessage.bind(w);
      // A stop ends the search quickly on a real engine: drop its queued info
      // lines but keep its bestmove, which the page's accounting expects.
      w.postMessage = (m) => {
        if (m === 'stop') q = q.filter(e => typeof e.data === 'string' && e.data.startsWith('bestmove'));
        post(m);
      };
      Object.defineProperty(w, 'onmessage', { set(f) { handler = f; }, get() { return handler; } });
      return w;
    };
  }, sim);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  return { page, ctx, errs };
}

// Play `n` human moves against a Flounder bot; report each reply's source.
async function playFlounder(page, n, waitMs) {
  await page.evaluate(() => {
    botSetTab('sf');
    const el = document.getElementById('flounderElo');
    if (el) el.value = 1200;
    botSetPlayerColor('white');
    quickBotStart();
  });
  await page.waitForTimeout(1500);
  const out = [];
  const script = [['e2','e4'], ['g1','f3'], ['b1','c3'], ['d2','d4'], ['f1','e2']];
  for (let i = 0; i < n; i++) {
    const before = await page.evaluate(() => gameMovesAlgebraic.length);
    const played = await page.evaluate(([f, t]) => {
      if (gameOver) return false;
      let s = fileRankToSq(f), d = fileRankToSq(t);
      if (!legalMovesFor(s, board, epSq, castling).includes(d)) {
        // The scripted move was made illegal by the bot's reply; any legal one will do.
        for (s = 0; s < 64; s++) {
          const p = board[s];
          if (p && p.color === 'w') { const l = legalMovesFor(s, board, epSq, castling); if (l.length) { d = l[0]; break; } }
        }
      }
      executeMove(s, d);
      return true;
    }, script[i % script.length]);
    if (!played) break;
    let after = before, t = 0;
    for (; t < waitMs && after < before + 2; t += 250) {
      await page.waitForTimeout(250);
      after = await page.evaluate(() => gameMovesAlgebraic.length);
    }
    out.push({ replied: after >= before + 2, ms: t,
               src: await page.evaluate(() => String(lastBotMoveSource)),
               depth: await page.evaluate(() => typeof sfLastProbeDepth === 'undefined' ? null : sfLastProbeDepth) });
  }
  return out;
}
const fmt = r => r.map(x => (x.replied ? x.src : 'NONE') + (x.depth ? '@d' + x.depth : '') + ' ' + x.ms + 'ms').join(', ');

console.log('\n1   Normal speed: nothing changes');
{
  const { page, ctx, errs } = await openPage({});
  const r = await playFlounder(page, 3, 20000);
  console.log('       ' + fmt(r));
  ok('the bot replied every move', r.every(x => x.replied), fmt(r));
  ok('every move is Flounder at full depth', r.every(x => x.src === 'Flounder' && x.depth === null), fmt(r));
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\n2   A slow engine: the probe runs out of time, Flounder plays from a shallower depth');
{
  // At 25 ms a line the full depth-8 probe of an opening position takes 4-6 s:
  // inside the old 7 s cap (the code before this fix coped, slowly), but past
  // the turn's think time, which is now where the probe is cut.
  const { page, ctx, errs } = await openPage({ lineMs: 25 });
  const r = await playFlounder(page, 3, 30000);
  console.log('       ' + fmt(r));
  ok('the bot replied every move', r.every(x => x.replied), fmt(r));
  ok('the moves are still Flounder\'s, from a partial probe', r.every(x => x.replied && x.src === 'Flounder' && x.depth >= 1 && x.depth < 8), fmt(r));
  ok('and fit inside the probe deadline plus think time', r.every(x => x.ms < 12000), fmt(r));
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\n3   A very slow engine: no probe depth completes, the backup search\'s best line plays');
{
  const { page, ctx, errs } = await openPage({ lineMs: 900 });
  const r = await playFlounder(page, 2, 40000);
  console.log('       ' + fmt(r));
  ok('the bot replied every move', r.every(x => x.replied), fmt(r));
  // x.replied as well: the old code labelled the turn 'SF' and then dropped it.
  ok('each from the backup search, cut off with its best line so far', r.every(x => x.replied && x.src === 'SF'), fmt(r));
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\n4   An engine that answers nothing: a last-resort move, and a warning');
{
  const { page, ctx, errs } = await openPage({ dead: true });
  const r = await playFlounder(page, 2, 40000);
  console.log('       ' + fmt(r));
  ok('the bot replied every move', r.every(x => x.replied), fmt(r));
  ok('with the last-resort move', r.every(x => x.replied && x.src === 'Fallback'), fmt(r));
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\n5   A browser without WebAssembly SIMD: said so, and the bot still moves');
{
  const { page, ctx, errs } = await openPage({ noSimd: true });
  const sup = await page.evaluate(() => typeof sfBrowserSupport === 'function' ? sfBrowserSupport() : 'no detection');
  ok('the missing feature is detected', sup === 'simd', String(sup));
  const r = await playFlounder(page, 2, 20000);
  console.log('       ' + fmt(r));
  ok('the bot replied every move', r.every(x => x.replied), fmt(r));
  ok('with the last-resort move', r.every(x => x.replied && x.src === 'Fallback'), fmt(r));
  const banner = await page.evaluate(() => { const d = document.getElementById('bm-engine-warn'); return d ? d.textContent : null; });
  ok('a warning names the problem', /SIMD/.test(String(banner)), String(banner));
  const lb = await page.evaluate(async () => {
    lichessDisconnect();
    lbSettings.token = 'lip_test';
    await lichessConnect({ confirmed: true });
    return { state: lbState, note: lbStateNote, wants: lbWantConnected };
  });
  ok('Lichess hosting refuses to connect, with the reason', lb.state === 'error' && /SIMD/.test(lb.note) && !lb.wants,
    JSON.stringify(lb));
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\n6   The partial-result parser');
{
  const { page, ctx } = await openPage({});
  const r = await page.evaluate(() => {
    const L = (d, pv, cp) => 'info depth ' + d + ' seldepth ' + d + ' multipv 1 score cp ' + cp + ' nodes 1 pv ' + pv;
    const lines = [L(1,'e2e4',30), L(1,'d2d4',25), L(1,'g1f3',20), L(2,'e2e4',35), L(2,'d2d4',28)];
    return {
      complete: _parseEvalMovesPartial(lines, ['e2e4','d2d4','g1f3']),
      none: _parseEvalMovesPartial([L(1,'e2e4',30)], ['e2e4','d2d4']),
      ignoresOthers: _parseEvalMovesPartial([L(1,'e2e4',30), L(1,'a2a3',5), L(1,'d2d4',1)], ['e2e4','d2d4']),
    };
  });
  ok('it takes the deepest depth that scored every move, not a mix',
    r.complete && r.complete.depth === 1 && r.complete.evals.e2e4 === 30 && r.complete.evals.g1f3 === 20,
    JSON.stringify(r.complete));
  ok('it returns nothing when no depth is complete', r.none === null, JSON.stringify(r.none));
  ok('it ignores moves outside the candidate list', r.ignoresOthers && !('a2a3' in r.ignoresOthers.evals),
    JSON.stringify(r.ignoresOthers));
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

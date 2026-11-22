// The engine's speed on this device, and what follows from it (Nov 2026).
//
// A tester on a slow computer found the engine's 5 s limits too short, and a
// personality bot unplayable there. The page now measures the engine's speed
// (sfSpeed: a start-up search, then every search it finishes), stretches its
// time limits to suit (sfLimitMs: half as much again as the slowdown, at most
// 10x, and in a timed game never past a tenth of the clock plus the
// increment), notes each personality check's cost against what this device
// was expected to take (the move's log line), recommends how many moves a
// turn this device can check, and lets that be set, for this device only, in
// the builder (Personality: "Moves checked per turn").
//
// A slow CPU can't be emulated with CDP throttling (it leaves Web Workers
// alone), so the engine's output is held back instead: each line arrives k
// times as long after its search began as it really took, which is what a k
// times slower engine looks like from the page. A 'stop' brings the rest
// forward, as a real engine stops promptly.
//
// Needs the dev server on :3100 (or BM_URL), with the Maia model.
// PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
};

// A Maia bot with a personality that checks its moves: Blind Conviction (every
// move the Range lets through) and the complexity control (Maia's top 10).
const CFG = {
  type: 'botConfig', engine: 'maia3', elo: 1800, maia3Temp: 1, tempValue: 1,
  cpBudget: 150, hardFloorCp: 250, convictionPct: 85, blindConviction: true, blindChoicePcts: [60, 20, 15, 5],
  dayLower: 1, dayUpper: 100, minProbPct: 1,
  attractorValues: { complexity: 3, attacker: 4, tension: 2 }, pieceValues: { knight: 2 }, customControls: [],
  openingBook: false, openingRepWhite: false, openingRepBlack: false,
  openingMainLineWhite: false, openingMainLineBlack: false,
  timingMode: 'fixed', fixedDelayMs: 50, color: 'white', premoveEnabled: false,
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
// k: how many times slower the engine appears. cap: "Moves checked per turn".
async function openPage(k, cap) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(({ k, cap }) => {
    try {
      ['bm_welcomed', 'bm_landingSeen', 'bm_bottour'].forEach(x => localStorage.setItem(x, '1'));
      if (cap) localStorage.setItem('bm_checkCap', String(cap)); else localStorage.removeItem('bm_checkCap');
    } catch (e) {}
    if (k <= 1 || window.top !== window) return;
    const W = window.Worker;
    window.Worker = function (url, o) {
      const w = new W(url, o);
      if (!/stockfish/.test(String(url))) return w;
      let handler = null, goAt = null, stopped = false, last = 0, q = [], timer = null;
      const arm = () => { if (!timer && q.length) timer = setTimeout(flush, Math.max(0, q[0].at - performance.now())); };
      const flush = () => {
        timer = null;
        const now = performance.now();
        while (q.length && q[0].at <= now + 1) { const e = q.shift(); if (handler) handler(e.ev); }
        arm();
      };
      w.addEventListener('message', (ev) => {
        const now = performance.now();
        let at = (goAt != null && !stopped) ? goAt + (now - goAt) * k : now;
        at = Math.max(at, last); last = at;
        if (typeof ev.data === 'string' && ev.data.startsWith('bestmove')) goAt = null;
        q.push({ at, ev }); arm();
      });
      const post = w.postMessage.bind(w);
      w.postMessage = (m) => {
        if (typeof m === 'string' && m.startsWith('go')) { goAt = performance.now(); stopped = false; }
        if (m === 'stop') {
          stopped = true;
          const now = performance.now();
          q = q.filter(e => !(typeof e.ev.data === 'string' && e.ev.data.startsWith('info') && e.at > now));
          for (const e of q) e.at = Math.min(e.at, now + 40);
          last = Math.min(last, now + 40);
          if (timer) { clearTimeout(timer); timer = null; }
          arm();
        }
        post(m);
      };
      Object.defineProperty(w, 'onmessage', { set(f) { handler = f; }, get() { return handler; } });
      return w;
    };
  }, { k, cap: cap || 0 });
  const page = await ctx.newPage();
  page._errors = [];
  page.on('pageerror', e => page._errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sfSpeedReport === 'function' && typeof botStart === 'function');
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  return { page, ctx };
}
async function withMaia(page) {
  await page.evaluate(() => maiaDownloadModel());
  await page.waitForFunction(() => _maiaReady, null, { timeout: 180000 });
  await page.evaluate(() => sfInit());
}
// Play `n` random human moves; each bot reply's log detail and engine checks.
async function play(page, n, tc) {
  await page.evaluate(({ CFG, tc }) => {
    botApplyPanelConfig(CFG, true, { keepModal: true });
    botColorPref = 'white';
    botSelectedTC = tc || 'untimed';
    botStart();
  }, { CFG, tc });
  await page.waitForTimeout(400);
  const out = [];
  for (let i = 0; i < n; i++) {
    const n0 = await page.evaluate(() => {
      if (gameOver) return -1;
      const moves = [];
      for (let s = 0; s < 64; s++) {
        const p = board[s];
        if (p && p.color === 'w') for (const d of legalMovesFor(s, board, epSq, castling)) moves.push([s, d]);
      }
      if (!moves.length) return -1;
      const [s, d] = moves[Math.floor(Math.random() * moves.length)];
      const n = gameMovesAlgebraic.length;
      executeMove(s, d, (board[s].piece === 'P' && (d < 8 || d >= 56)) ? 'Q' : undefined);
      return n;
    });
    if (n0 < 0) break;
    const t0 = Date.now();
    try {
      await page.waitForFunction((n) => gameOver || (gameMovesAlgebraic.length >= n + 2 && !botThinking), n0, { timeout: 120000 });
    } catch (e) { out.push({ replied: false }); break; }
    out.push(Object.assign({ replied: true, ms: Date.now() - t0 }, await page.evaluate(() => ({
      detail: lastBotMoveDetail,
      over: gameOver ? gameOverMsg || 'over' : '',
      last: gameMovesAlgebraic.slice(-2).join(' '),
      clockMs: typeof clockTimeB === 'number' ? clockTimeB * 1000 : null,
      checks: sfTurnChecks.map(c => ({ n: c.n, ms: Math.round(c.ms), exp: c.expectedMs == null ? null : Math.round(c.expectedMs), limit: c.limitMs, cut: c.cut })),
    }))));
    if (await page.evaluate(() => gameOver)) break;
  }
  return out;
}
const line = r => r.map(x => x.replied ? (x.ms / 1000).toFixed(1) + 's [' + x.checks.map(c => c.n + (c.cut ? '!' : '')).join('+') + ']' : 'NONE').join(' ');

console.log('\n1. Normal speed: about a desktop\'s, nothing stretched, every check reported');
{
  const { page, ctx } = await openPage(1);
  await withMaia(page);
  const rep = await page.evaluate(() => sfSpeedReport());
  console.log('       ' + rep.text);
  ok('measured at start-up', rep.measured && /Engine speed/.test(rep.text), rep.text);
  ok('reads as a desktop: no stretch, nothing recommended against', rep.slowdown < 1.4 && rep.stretch < 1.2 && rep.recommended === 0, rep);
  const r = await play(page, 6);
  console.log('       ' + line(r));
  ok('the bot replied every move', r.length && r.every(x => x.replied), line(r));
  const withChecks = r.filter(x => x.checks.length);
  ok('its personality checks its moves', withChecks.length >= r.length - 2, line(r));
  // A move that ends the game is the exception: the review then opens, and
  // botStop clears the detail (the Lichess log has its line by then).
  ok('each one on the move\'s log line: moves, time, expected', withChecks.filter(x => !x.over).every(x => /checked \d+( \+ \d+)* moves in [\d.]+ m?s \(expected [\d.]+ m?s\)/.test(x.detail)), withChecks.map(x => [x.detail, x.over, x.last]));
  ok('none stopped at a limit', r.every(x => x.checks.every(c => !c.cut)), line(r));
  ok('no page errors', !page._errors.length, page._errors.slice(0, 2));
  await ctx.close();
}

console.log('\n2. An engine 20x slower, untimed: measured, limits stretched, checks finish');
{
  const { page, ctx } = await openPage(20);
  await withMaia(page);
  const rep = await page.evaluate(() => sfSpeedReport());
  const log = await page.evaluate(() => sfSpeedLogLine());
  console.log('       ' + log);
  ok('measured as many times slower than a desktop', rep.slowdown >= 12, rep.text);
  ok('time limits stretched as far as they go (10x)', rep.stretch === 10, rep.stretch);
  ok('fewer moves a turn recommended', rep.recommended >= 4 && rep.recommended <= 16, rep.recommended);
  ok('the log line says so, and where to set it', /Moves checked a turn: all \(recommended: at most \d+, in the builder's Personality\)$/.test(log), log);
  const r = await play(page, 4);
  console.log('       ' + line(r));
  ok('the bot replied every move', r.length && r.every(x => x.replied), line(r));
  ok('every check finished: none stopped at its (stretched) limit', r.every(x => x.checks.every(c => !c.cut)), r.map(x => x.checks));
  ok('limits well past the desktop\'s 7 s at most', r.some(x => x.checks.some(c => c.limit > 7000)), r.map(x => x.checks));
  ok('no page errors', !page._errors.length, page._errors.slice(0, 2));
  await ctx.close();
}

console.log('\n3. The same engine on a 1+0 clock: the stretch stops at a tenth of the clock');
{
  const { page, ctx } = await openPage(20);
  await withMaia(page);
  const r = await play(page, 5, 'bullet');
  console.log('       ' + line(r) + '  |  clock left ' + Math.round((r[r.length - 1] || {}).clockMs / 1000) + ' s');
  ok('the bot replied every move', r.length && r.every(x => x.replied), line(r));
  // A check's limit: the desktop's (2 s + 0.15 s a move, at most 7 s), or a
  // tenth of the clock as the move began, whichever is longer.
  const over = [];
  let clk = 60000;
  for (const x of r) {
    for (const c of x.checks) if (c.limit > Math.max(Math.min(7000, 2000 + 150 * c.n), clk / 10) + 50) over.push({ c, clk });
    clk = x.clockMs;
  }
  ok('no check was given longer than that', !over.length, over);
  ok('no page errors', !page._errors.length, page._errors.slice(0, 2));
  await ctx.close();
}

console.log('\n4. Moves checked per turn set to 4 on this device');
{
  const { page, ctx } = await openPage(20, 4);
  await withMaia(page);
  const r = await play(page, 4);
  console.log('       ' + line(r));
  ok('the bot replied every move', r.length && r.every(x => x.replied), line(r));
  ok('no check scored more than 4 moves', r.every(x => x.checks.every(c => c.n <= 4)), r.map(x => x.checks));
  ok('the log line says what is set', /Moves checked a turn: at most 4/.test(await page.evaluate(() => sfSpeedLogLine())));
  ok('no page errors', !page._errors.length, page._errors.slice(0, 2));
  await ctx.close();
}

console.log('\n5. The builder\'s row (an engine 30x slower)');
{
  const { page, ctx } = await openPage(30);
  await page.evaluate(() => openBotModal());
  await page.waitForTimeout(1500);
  const frame = page.frames().find(f => /bot-control-panel/.test(f.url()));
  ok('the builder is open', !!frame);
  await frame.evaluate(() => {
    if (!document.getElementById('sec-attract').classList.contains('open')) toggleSec('attract');
    try { switchItab('attract', 'quality'); } catch (e) {}
    document.getElementById('check-cap-wrap').scrollIntoView({ block: 'center' });
  });
  // Seeing the row starts the engine if no game has, so its speed is known.
  await frame.waitForFunction(() => /Engine speed/.test(document.getElementById('check-cap-speed').textContent), null, { timeout: 60000 }).catch(() => {});
  const st = await frame.evaluate(() => ({
    speed: document.getElementById('check-cap-speed').textContent,
    sel: document.getElementById('sel-check-cap').value,
    btn: document.getElementById('btn-check-cap-rec').style.display !== 'none' ? document.getElementById('btn-check-cap-rec').textContent : null,
  }));
  console.log('       ' + st.speed);
  ok('it shows the speed, what a check costs here, and the recommendation', /slower than a desktop: time limits ×/.test(st.speed) && /A check here takes about/.test(st.speed) && /Recommended: at most \d+/.test(st.speed), st.speed);
  ok('all candidates until set, with a button for the recommendation', st.sel === '0' && /^Use recommended: at most \d+$/.test(st.btn || ''), st);
  await frame.click('#btn-check-cap-rec');
  await frame.waitForTimeout(300);
  const set = await page.evaluate(() => ({ cap: sfCheckCap(), rec: sfRecommendedCheckCap(), stored: localStorage.getItem('bm_checkCap') }));
  const sel = await frame.evaluate(() => document.getElementById('sel-check-cap').value);
  ok('the button sets it, on this device', set.cap > 0 && set.cap === set.rec && set.stored === String(set.rec) && +sel === set.cap, { set, sel });
  await frame.selectOption('#sel-check-cap', '0');
  await frame.waitForTimeout(200);
  ok('"All candidates" clears it', await page.evaluate(() => sfCheckCap() === 0 && localStorage.getItem('bm_checkCap') === null));
  ok('a saved bot carries no part of it', !JSON.stringify(await frame.evaluate(() => getBotConfig())).includes('heckCap'));
  ok('no page errors', !page._errors.length, page._errors.slice(0, 2));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

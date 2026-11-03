// Headless verification of Premove Puzzles (src/68-premove-puzzles.js):
// arming the game's real premove, the three verdicts and their popups, the
// restarts they offer, playing on, and giving the player's own bot back.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-premove-puzzles.mjs
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
const shot = name => path.join(os.tmpdir(), 'pz-' + name + '.png');

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();

async function open(viewport, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(() => {
    try {
      ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1'));
      localStorage.setItem('bm_shell', 'amateur');
      localStorage.setItem('bm_welcomed', '1');
      localStorage.removeItem('bm_pzIndex');
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}

// Play a move as the human, through the same commit the board's clicks use.
const play = (page, uci) => page.evaluate(u => {
  const m = uciToSq(u);
  return tryCommit(m.from, m.to, m.promo || null);
}, uci);
const popup = page => page.evaluate(() => {
  const el = document.getElementById('pzPop');
  return el && !el.hidden
    ? { title: el.querySelector('h3').textContent, text: el.textContent,
        acts: [...el.querySelectorAll('.pz-btn')].map(b => b.textContent) }
    : null;
});
const waitPopup = async (page, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const p = await popup(page); if (p) return p; await sleep(150); }
  return null;
};
const startAt = (page, i, show) => page.evaluate(([i, s]) => pzLoad().then(() => { pzStart(i, s); }), [i, show || null]);
const act = (page, a) => page.evaluate(a => document.querySelector('#pzPop [data-act="' + a + '"]').click(), a);

// Pick, from the data, a puzzle and a move of each kind for it.
const pick = (page) => page.evaluate(() => pzLoad().then(list => {
  const out = {};
  for (let i = 0; i < list.length && !(out.better && out.busted); i++) {
    const p = list[i];
    let best = 0; for (const k in p.moves) best = Math.max(best, p.moves[k][0]);
    if (!out.better) {
      const w = Object.keys(p.moves).find(u => p.moves[u][0] < best - 25 && p.accept.indexOf(u) < 0 && p.moves[u][0] !== p.moves[u][1]);
      if (w) out.better = { i, uci: w };
    }
    if (!out.busted) {
      // A legal move missing from the table busts the premove.
      const b = parseFen(p.fen);
      const col = p.solver;
      for (let sq = 0; sq < 64 && !out.busted; sq++) {
        if (!b[sq] || b[sq].color !== col) continue;
        for (const to of legalMovesFor(sq, b, epSq, castling)) {
          const u = sqToUci(sq, to, (b[sq].piece === 'P' && (to < 8 || to >= 56)) ? 'q' : null);
          if (!(u in p.moves)) { out.busted = { i, uci: u }; break; }
        }
      }
    }
  }
  out.stalemate = list.findIndex(p => p.stalemate);
  out.count = list.length;
  return out;
}));

// ── Desktop ──────────────────────────────────────────────────────────────────
console.log('\n1  Entering puzzles borrows the bot and arms the game’s premove');
const { ctx, page, errors } = await open({ width: 1280, height: 900 });
// A distinctive bot of the player's own, to check it comes back untouched.
await page.evaluate(() => {
  botSetTab('sf'); botSetPlayerColor('white');
  window._bcpAttractorValues = { chaos: 3 }; botMaiaTempValue = 1.7; botPremoveEnabled = true;
});
const lastBotBefore = await page.evaluate(() => localStorage.getItem('bm_lastBot'));
const sel = await pick(page);
ok(sel.count > 400, `puzzle data loaded (${sel.count})`);
await page.click('#pzSidebarBtn');
await page.waitForTimeout(600);
const s1 = await page.evaluate(() => ({
  active: pzActive, on: document.getElementById('pzCard').classList.contains('on'),
  fenOk: _gameStartFen === pzCur.fen, armed: botActivePremove && botActivePremove.uci,
  premove: pzCur.premove, tab: botTab, elo: maia3SelectedRating, rating: pzCur.premoverRating,
  human: botPlayerColor, solver: pzCur.solver, tc: botSelectedTC,
  name: document.querySelector(pzCur.solver === 'w' ? '#playerBoxB .player-name' : '#playerBoxW .player-name').textContent,
  personality: Object.keys(window._bcpAttractorValues).length, temp: botMaiaTempValue, ownPremoves: botPremoveEnabled,
}));
ok(s1.active && s1.on, 'puzzle mode is on and the card is showing');
ok(await page.evaluate(() => {
  const c = document.getElementById('pzCard').getBoundingClientRect();
  return document.getElementById('pzCard').parentNode.id === 'sidebar' && c.bottom <= innerHeight;
}), 'on a wide screen the card heads the side column, in view without scrolling');
ok(s1.fenOk, 'the board starts from the puzzle position');
ok(s1.armed === s1.premove, `the bot is armed with the game’s premove (${s1.armed})`);
ok(s1.tab === 'maia3' && s1.elo === Math.max(600, Math.min(2600, s1.rating)), `opponent is Maia at the premover’s rating (${s1.elo})`);
ok(s1.human === (s1.solver === 'w' ? 'white' : 'black'), 'you play the side that faced the premove');
ok(s1.tc === 'untimed', 'puzzles are untimed');
ok(/^Maia \d+$/.test(s1.name), `opponent box names it (${s1.name})`);
ok(s1.personality === 0 && s1.temp === 1 && !s1.ownPremoves, 'plain Maia: no personality, T=1, no premoves of its own');

console.log('\n2  The right answer fires the premove and says Correct');
{
  // Drag the piece with the mouse, the way a player would.
  const ans = await page.evaluate(() => pzCur.answer);
  const pts = await page.evaluate(u => {
    const m = uciToSq(u), r = document.getElementById('cv').getBoundingClientRect(), s = r.width / 8;
    const at = sq => { const c = sqCanvas(sq); return { x: r.left + c.c * s + s / 2, y: r.top + c.r * s + s / 2 }; };
    return [at(m.from), at(m.to)];
  }, ans);
  await page.mouse.move(pts[0].x, pts[0].y); await page.mouse.down();
  await page.mouse.move((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, { steps: 4 });
  await page.mouse.move(pts[1].x, pts[1].y, { steps: 4 }); await page.mouse.up();
  const p = await waitPopup(page, 4000);
  const st = await page.evaluate(() => ({ hist: botMoveHistory.slice(), premove: pzCur.premove, src: lastBotMoveSource }));
  ok(st.hist[0] === ans, `dragging the piece plays the answer (${st.hist[0]})`);
  ok(st.hist[1] === st.premove && st.src === 'PREMOVE', 'the premove fires instantly');
  ok(p && p.title === 'Correct!', 'popup says Correct!');
  ok(p && p.acts.join('|') === 'Reset|Next puzzle|Play it out', `offers ${p && p.acts.join(' · ')}`);
  await page.screenshot({ path: shot('correct') });
  await act(page, 'play');
  await page.waitForTimeout(200);
  const free = await page.evaluate(() => ({ phase: pzPhase, hidden: document.getElementById('pzPop').hidden, turn, human: botPlayerColor }));
  ok(free.phase === 'free' && free.hidden, 'Play it out closes the popup and keeps the game');
  // Keep playing: any legal move gets a Maia reply.
  const n0 = await page.evaluate(() => gameMovesAlgebraic.length);
  await page.evaluate(() => { const c = turn; const ms = allLegalMoves(board, c, epSq, castling); const m = ms[0]; tryCommit(m.from, m.to, null); });
  await page.waitForFunction(n => gameMovesAlgebraic.length >= n + 2 || gameOver, n0, { timeout: 20000 }).catch(() => {});
  ok(await page.evaluate(n => gameMovesAlgebraic.length >= n + 2 || gameOver, n0), 'the opponent keeps answering after Play it out');
}

console.log('\n3  A move that lets the premove fire but wastes it');
{
  await startAt(page, sel.better.i);
  await page.waitForTimeout(300);
  await play(page, sel.better.uci);
  const p = await waitPopup(page, 4000);
  ok(p && p.title === 'Better exploit available', `popup says Better exploit available (${sel.better.uci})`);
  ok(p && p.acts.join('|') === 'Try again|Show answer|Play it out', `offers ${p && p.acts.join(' · ')}`);
  await act(page, 'answer');
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({
    reset: _gameStartFen === pzCur.fen && gameMovesAlgebraic.length === 0,
    arrows: pzMarks && pzMarks.arrows.map(a => a.kind).join(','), note: document.querySelector('#pzCard .pz-note').textContent,
    answerSan: pzCur.answerSan, armed: !!botActivePremove,
  }));
  ok(s.reset && s.armed, 'Show answer restarts the puzzle with the premove armed again');
  ok(s.arrows === 'premove,answer', 'and draws the answer beside the premove');
  ok(s.note.indexOf(s.answerSan) >= 0, `and says what to play: “${s.note}”`);
}

console.log('\n4  A move that busts the premove');
{
  await startAt(page, sel.busted.i);
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await play(page, sel.busted.uci);
  await page.waitForFunction(() => gameMovesAlgebraic.length >= 2 || gameOver, null, { timeout: 20000 }).catch(() => {});
  const replyMs = Date.now() - t0;
  const p = await waitPopup(page, 4000);
  const st = await page.evaluate(() => ({ src: lastBotMoveSource, busted: botPremoveStats.busted, reason: pzVerdict && pzVerdict.reason && pzVerdict.reason.text }));
  ok(st.busted === 1 && st.src !== 'PREMOVE', `the premove is cancelled and the bot thinks instead (${st.src})`);
  ok(replyMs >= 1200, `the bot stalls before answering (${replyMs} ms)`);
  ok(p && p.title === 'Premove busted', `popup says Premove busted (${sel.busted.uci})`);
  ok(p && p.acts.join('|') === 'Try again|Show the bust', `offers ${p && p.acts.join(' · ')}`);
  console.log('     reason:', (st.reason || '').replace(/<[^>]+>/g, ''));
  await page.screenshot({ path: shot('busted') });
  await act(page, 'bust');
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({
    reset: gameMovesAlgebraic.length === 0, arrows: pzMarks && pzMarks.arrows.map(a => a.kind).join(','),
    rings: pzMarks && pzMarks.rings.length, note: document.querySelector('#pzCard .pz-note').textContent,
  }));
  ok(s.reset && s.arrows === 'premove,attempt' && s.rings === 1, 'Show the bust restarts with the premove, your try and the culprit marked');
  ok(s.note.length > 30, `and explains it: “${s.note}”`);
  await page.screenshot({ path: shot('showbust') });
}

console.log('\n5  Stalemate puzzle (the Rosen trap)');
if (sel.stalemate >= 0) {
  await startAt(page, sel.stalemate);
  await page.waitForTimeout(300);
  await play(page, await page.evaluate(() => pzCur.answer));
  const p = await waitPopup(page, 4000);
  const st = await page.evaluate(() => ({ over: gameOver, msg: gameOverMsg }));
  ok(st.over && /Stalemate/.test(st.msg), `the premove stalemates (${st.msg})`);
  ok(p && p.title === 'Correct!' && /stalemate/.test(p.text), 'popup says Correct! and names the stalemate');
} else ok(false, 'no stalemate puzzle in the data');

console.log('\n6  Next, restarts, and leaving');
{
  await startAt(page, 0);
  await page.waitForTimeout(200);
  await page.click('#pzCard [data-act="next"]');
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => pzIdx === 1 && _gameStartFen === pzCur.fen), 'Next moves to the next puzzle');
  await play(page, await page.evaluate(() => pzCur.answer));
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => localStorage.getItem('bm_liveGame') === null), 'a puzzle game is never saved as the live game');
  await page.click('#pzCard [data-act="toggle"]');
  ok(await page.evaluate(() => !pzShowPremove && localStorage.getItem('bm_pzShowPremove') === '0'), 'Show their premove can be switched off (and is remembered)');
  await page.click('#pzCard [data-act="toggle"]');
  await act(page, 'reset').catch(() => {});
  await page.click('#pzCard [data-act="exit"]');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    active: pzActive, card: document.getElementById('pzCard').classList.contains('on'),
    tab: botTab, color: botColorPref, chaos: window._bcpAttractorValues && window._bcpAttractorValues.chaos,
    temp: botMaiaTempValue, premoves: botPremoveEnabled, bot: botActive, start: _gameStartFen,
  }));
  ok(!back.active && !back.card, 'Exit closes puzzles');
  ok(back.tab === 'sf' && back.color === 'white' && back.chaos === 3 && back.temp === 1.7 && back.premoves === true,
     'the player’s own bot is back exactly as it was');
  ok(!back.bot && !back.start, 'and the board is back to a fresh game');
  ok(await page.evaluate(() => localStorage.getItem('bm_lastBot')) === lastBotBefore, 'the saved “last bot” was never touched');
}

console.log('\n7  Starting your own game from puzzles gives the bot back first');
{
  await startAt(page, 0);
  await page.waitForTimeout(200);
  await page.evaluate(() => { resign(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => quickBotStart());
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => ({ active: pzActive, tab: botTab, start: _gameStartFen, color: botPlayerColor }));
  ok(!s.active && s.tab === 'sf' && !s.start && s.color === 'white', 'Quick Start plays your own bot from the start position');
}
ok(errors.length === 0, 'no page errors (desktop)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await ctx.close();

// ── Phone ────────────────────────────────────────────────────────────────────
console.log('\n8  Phone');
{
  const { ctx, page, errors } = await open({ width: 412, height: 915 }, true);
  const sel2 = await pick(page);
  await page.evaluate(() => document.getElementById('pzSidebarBtn').scrollIntoView());
  await page.tap('#pzSidebarBtn');
  await page.waitForTimeout(600);
  const lay = await page.evaluate(() => {
    const b = document.getElementById('cv').getBoundingClientRect();
    const c = document.getElementById('pzCard').getBoundingClientRect();
    return { below: c.top >= b.bottom - 1, width: c.width, over: document.documentElement.scrollWidth - innerWidth };
  });
  ok(lay.below && lay.over <= 0, `card sits under the board, no sideways scroll (${Math.round(lay.width)}px wide)`);
  await startAt(page, sel2.busted.i);
  await page.waitForTimeout(300);
  await play(page, sel2.busted.uci);
  const p = await waitPopup(page, 20000);
  const fit = await page.evaluate(() => {
    const b = document.getElementById('cv').getBoundingClientRect(), q = document.getElementById('pzPop').getBoundingClientRect();
    return q.left >= b.left - 1 && q.right <= b.right + 1 && q.top >= b.top - 1 && q.bottom <= b.bottom + 1;
  });
  ok(p && fit, 'the popup fits over the board');
  await page.screenshot({ path: shot('phone') });
  ok(errors.length === 0, 'no page errors (phone)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

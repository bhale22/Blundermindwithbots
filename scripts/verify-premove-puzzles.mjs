// Headless verification of Premove Puzzles (src/68-premove-puzzles.js):
// arming the game's real premove, the two-move solve (the move that lets the
// premove fire, then the one that cashes in), every verdict and the restarts
// it offers, holding the bot while a verdict is up, the eval bar, the share
// link, and giving the player's own bot back.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-premove-puzzles.mjs
// Headless has no Maia model, so the opponent here is Flounder — which is the
// point of the fallback: nothing needs downloading to play.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const shot = name => path.join(os.tmpdir(), 'pz-' + name + '.png');

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
// Every kind of puzzle the code handles, whichever ones the shipped set keeps:
// the whole mined set from before the Maia filter, when it is here.
const FULL_SET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'premove-puzzles', 'puzzles.json');
const HAVE_FULL = fs.existsSync(FULL_SET);
const newContext = browser.newContext.bind(browser);
browser.newContext = async o => {
  const c = await newContext(o);
  if (HAVE_FULL) await c.route('**/data/premove-puzzles.json', r => r.fulfill({ path: FULL_SET, contentType: 'application/json' }));
  return c;
};

async function open(viewport, mobile = false, url = BASE, init = true) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  if (init) await ctx.addInitScript(() => {
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
  await page.goto(url, { waitUntil: 'networkidle' });
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
const bestOf = t => Object.keys(t).reduce((b, k) => (b === null || t[k] > t[b] ? k : b), null);

// Pick, from the data, a puzzle and a move of each kind for it.
const pick = (page) => page.evaluate(() => pzLoad().then(list => {
  const out = {};
  for (let i = 0; i < list.length && !(out.better && out.busted && out.wrongFollow); i++) {
    const p = list[i];
    let best = 0; for (const k in p.moves) best = Math.max(best, p.moves[k][0]);
    if (!out.better) {
      const w = Object.keys(p.moves).find(u => p.moves[u][0] < best - 25 && p.accept.indexOf(u) < 0 && p.moves[u][0] !== p.moves[u][1]);
      if (w) out.better = { i, uci: w };
    }
    const sec = p.second && p.second[p.answer];
    if (!out.wrongFollow && sec) {
      let b2 = 0; for (const k in sec) b2 = Math.max(b2, sec[k]);
      const w = Object.keys(sec).find(u => sec[u] < b2 - 25);
      if (w) out.wrongFollow = { i, uci: w };
    }
    if (!out.busted) {
      const b = parseFen(p.fen);
      for (let sq = 0; sq < 64 && !out.busted; sq++) {
        if (!b[sq] || b[sq].color !== p.solver) continue;
        for (const to of legalMovesFor(sq, b, epSq, castling)) {
          const u = sqToUci(sq, to, (b[sq].piece === 'P' && (to < 8 || to >= 56)) ? 'q' : null);
          if (!(u in p.moves)) { out.busted = { i, uci: u }; break; }
        }
      }
    }
  }
  out.stalemate = list.findIndex(p => p.stalemate);
  out.count = list.length;
  out.ranked = list.every((p, i) => i === 0 || p.maia1500 <= list[i - 1].maia1500);
  return out;
}));

// ── Desktop ──────────────────────────────────────────────────────────────────
console.log('\n1  Entering puzzles borrows the bot and arms the game’s premove');
const { ctx, page, errors } = await open({ width: 1280, height: 900 });
// A distinctive bot of the player's own, to check it comes back untouched.
await page.evaluate(() => {
  botSetTab('maia3'); botSetPlayerColor('white');
  window._bcpAttractorValues = { chaos: 3 }; botMaiaTempValue = 1.7; botPremoveEnabled = true;
  botSfVar1 = 20; document.getElementById('flounderElo').value = 900;
});
const lastBotBefore = await page.evaluate(() => localStorage.getItem('bm_lastBot'));
const sel = await pick(page);
ok(sel.count > (HAVE_FULL ? 400 : 0), `puzzle data loaded (${sel.count}${HAVE_FULL ? ', the full mined set' : ''})`);
ok(sel.ranked, 'puzzles run from easiest to hardest (Maia 1500 probability, descending)');
// No button leads here while puzzles are a work in progress: only the link.
const rows = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#bottom-controls .secondary-row')].map(row =>
    [...row.querySelectorAll('button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.id));
  const gear = document.querySelector('#proLiveActions [title="Board settings"]');
  const toPz = [...document.querySelectorAll('[onclick]')].filter(el => /pzOpen/.test(el.getAttribute('onclick'))).length;
  return { rows: r, proNext: gear && gear.nextElementSibling ? gear.nextElementSibling.id || 'unnamed' : null, toPz };
});
ok(JSON.stringify(rows.rows) === JSON.stringify([['btnTips', 'btnLoadPgn', 'btnSavePgn']]),
   'floor: Training Tips · Load · Save, the one row it has on main');
ok(rows.proNext === null && rows.toPz === 0, 'no Premove Puzzles button on either board');
await page.evaluate(() => pzOpen());
await page.waitForTimeout(600);
const s1 = await page.evaluate(() => ({
  active: pzActive, on: document.getElementById('pzCard').classList.contains('on'),
  green: getComputedStyle(document.getElementById('pzCard')).borderTopColor,
  fenOk: _gameStartFen === pzCur.fen, armed: botActivePremove && botActivePremove.uci,
  premove: pzCur.premove, tab: botTab, elo: flounderSliderElo(), rating: pzCur.premoverRating,
  human: botPlayerColor, solver: pzCur.solver, tc: botSelectedTC,
  name: document.querySelector(pzCur.solver === 'w' ? '#playerBoxB .player-name' : '#playerBoxW .player-name').textContent,
  personality: Object.keys(window._bcpAttractorValues).length, variety: botSfVar1, ownPremoves: botPremoveEnabled,
  card: (() => { const c = document.getElementById('pzCard'); const r = c.getBoundingClientRect(); return c.parentNode.id === 'sidebar' && r.bottom <= innerHeight; })(),
}));
ok(s1.active && s1.on, 'puzzle mode is on and the card is showing');
ok(s1.green === 'rgb(74, 171, 116)', `the card is the green of the quick start (${s1.green})`);
ok(s1.card, 'on a wide screen the card heads the side column, in view without scrolling');
ok(s1.fenOk, 'the board starts from the puzzle position');
ok(s1.armed === s1.premove, `the bot is armed with the game’s premove (${s1.armed})`);
// Flounder's dial moves in steps of 50, so 1741 plays as 1750.
ok(s1.tab === 'sf' && Math.abs(s1.elo - Math.max(600, Math.min(2400, s1.rating))) <= 25,
   `no Maia on this device, so Flounder at the premover’s rating (${s1.rating} → ${s1.elo})`);
ok(/^Flounder \d+$/.test(s1.name), `opponent box names it (${s1.name})`);
ok(s1.human === (s1.solver === 'w' ? 'white' : 'black'), 'you play the side that faced the premove');
ok(s1.tc === 'untimed', 'puzzles are untimed');
ok(s1.personality === 0 && s1.variety === 0 && !s1.ownPremoves, 'plain engine: no personality, no Variety, no premoves of its own');

console.log('\n2  Eval bar');
{
  await page.waitForFunction(() => document.getElementById('pzEvalLbl').textContent !== '', null, { timeout: 15000 }).catch(() => {});
  const e = await page.evaluate(() => {
    const b = document.getElementById('pzEval').getBoundingClientRect(), c = document.getElementById('cv').getBoundingClientRect(),
          s = document.getElementById('sidebar').getBoundingClientRect();
    return { on: document.body.classList.contains('pz-eval-on'), shown: getComputedStyle(document.getElementById('pzEval')).display,
             lbl: document.getElementById('pzEvalLbl').textContent, between: b.left >= c.right && b.right <= s.left,
             tall: Math.abs(b.height - c.height) < 2 };
  });
  ok(e.on && e.shown === 'block', 'the eval bar shows during a puzzle game');
  ok(e.between && e.tall, 'it stands between the board and the side column, the board’s full height');
  ok(e.lbl.length > 0, `and reads the position (${e.lbl})`);
}

console.log('\n3  The right first move fires the premove, and the follow-up is yours');
{
  // Drag the piece with the mouse, the way a player would.
  const ans = await page.evaluate(() => pzCur.answer);
  const fill0 = await page.evaluate(() => parseFloat(document.getElementById('pzEvalFill').style.height));
  const pts = await page.evaluate(u => {
    const m = uciToSq(u), r = document.getElementById('cv').getBoundingClientRect(), s = r.width / 8;
    const at = sq => { const c = sqCanvas(sq); return { x: r.left + c.c * s + s / 2, y: r.top + c.r * s + s / 2 }; };
    return [at(m.from), at(m.to)];
  }, ans);
  await page.mouse.move(pts[0].x, pts[0].y); await page.mouse.down();
  await page.mouse.move((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, { steps: 4 });
  await page.mouse.move(pts[1].x, pts[1].y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(900);
  const st = await page.evaluate(() => ({ hist: botMoveHistory.slice(), premove: pzCur.premove, src: lastBotMoveSource,
    phase: pzPhase, prompt: document.querySelector('#pzCard .pz-prompt').textContent, pop: !document.getElementById('pzPop').hidden }));
  ok(st.hist[0] === ans, `dragging the piece plays the first move (${st.hist[0]})`);
  ok(st.hist[1] === st.premove && st.src === 'PREMOVE', 'the premove fires instantly');
  ok(st.phase === 'followup' && !st.pop, 'no popup yet: the puzzle waits for the follow-up');
  ok(/Now cash in/.test(st.prompt), `the card says so: “${st.prompt}”`);
  await page.waitForTimeout(2600);
  const fill1 = await page.evaluate(() => parseFloat(document.getElementById('pzEvalFill').style.height));
  ok(fill1 > fill0 + 10, `the eval bar jumps your way when the premove lands (${Math.round(fill0)}% → ${Math.round(fill1)}%)`);
  const follow = await page.evaluate(() => {
    const t = pzCur.second[pzFirst.uci]; return Object.keys(t).reduce((b, k) => (b === null || t[k] > t[b] ? k : b), null);
  });
  await play(page, follow);
  const p = await waitPopup(page, 4000);
  ok(p && p.title === 'Correct!', `the follow-up (${follow}) solves it: Correct!`);
  ok(p && p.acts.join('|') === 'Reset|Next puzzle|Play it out', `offers ${p && p.acts.join(' · ')}`);
  await page.screenshot({ path: shot('correct') });
  const n = await page.evaluate(() => gameMovesAlgebraic.length);
  await page.waitForTimeout(2500);
  ok(await page.evaluate(n => gameMovesAlgebraic.length === n && !botThinking, n), 'the bot waits while the verdict is up');
  await act(page, 'play');
  await page.waitForFunction(n => gameMovesAlgebraic.length > n || gameOver, n, { timeout: 20000 }).catch(() => {});
  ok(await page.evaluate(n => (gameMovesAlgebraic.length > n || gameOver) && pzPhase === 'free' && document.getElementById('pzPop').hidden, n),
     'Play it out closes the popup and the bot answers');
}

console.log('\n4  The right first move, then the wrong follow-up');
if (sel.wrongFollow) {
  await startAt(page, sel.wrongFollow.i);
  await page.waitForTimeout(300);
  await play(page, await page.evaluate(() => pzCur.answer));
  await page.waitForTimeout(700);
  await play(page, sel.wrongFollow.uci);
  const p = await waitPopup(page, 4000);
  ok(p && p.title === 'Stronger follow-up available', `a weak follow-up says so (${sel.wrongFollow.uci})`);
  ok(p && p.acts.join('|') === 'Try again|Show follow-up|Play it out', `offers ${p && p.acts.join(' · ')}`);
  await act(page, 'retryFollow');
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => ({ plies: gameMovesAlgebraic.length, phase: pzPhase, turn, solver: pzCur.solver, armed: !!botActivePremove, start: _gameStartFen === pzMid.fen }));
  ok(s.plies === 2 && s.phase === 'followup' && s.turn === s.solver && !s.armed && s.start,
     'Try again goes back to just after the premove, your move');
  const best = await page.evaluate(() => { const t = pzCur.second[pzFirst.uci]; return Object.keys(t).reduce((b, k) => (b === null || t[k] > t[b] ? k : b), null); });
  // The popup is gone after Try again; Show follow-up is offered by the next
  // weak attempt, so go through the same action directly.
  await page.evaluate(() => pzAct('followAnswer'));
  await page.waitForTimeout(300);
  const a = await page.evaluate(() => ({ arrows: pzMarks && pzMarks.arrows.map(x => x.kind + ':' + sqToUci(x.from, x.to)).join(','), note: document.querySelector('#pzCard .pz-note').textContent }));
  ok(a.arrows === 'answer:' + best.slice(0, 4), `Show follow-up draws it (${a.arrows})`);
  await play(page, best);
  const p2 = await waitPopup(page, 4000);
  ok(p2 && p2.title === 'Correct!', 'and playing it from there solves the puzzle');
} else ok(false, 'no puzzle with a weak follow-up found');

console.log('\n5  A first move that lets the premove fire but wastes it');
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
    answerSan: pzCur.answerSan, armed: !!botActivePremove, follow: pzCur.follow,
  }));
  ok(s.reset && s.armed, 'Show answer restarts the puzzle with the premove armed again');
  ok(s.arrows === 'premove,answer', 'and draws the first move beside the premove');
  ok(s.note.indexOf(s.answerSan) >= 0 && !(s.follow[0] && s.note.indexOf(s.follow[0]) >= 0),
     `and names the first move without giving away the follow-up: “${s.note}”`);
}

console.log('\n6  A move that busts the premove');
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
  ok(p && p.title === 'Premove busted' && /Flounder had to stop/.test(p.text), `popup says Premove busted, naming the bot (${sel.busted.uci})`);
  ok(p && p.acts.join('|') === 'Try again|Show the bust', `offers ${p && p.acts.join(' · ')}`);
  console.log('     reason:', (st.reason || '').replace(/<[^>]+>/g, ''));
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

console.log('\n7  Stalemate puzzle (the Rosen trap): the premove is the end');
if (sel.stalemate >= 0) {
  await startAt(page, sel.stalemate);
  await page.waitForTimeout(300);
  await play(page, await page.evaluate(() => pzCur.answer));
  const p = await waitPopup(page, 4000);
  const st = await page.evaluate(() => ({ over: gameOver, msg: gameOverMsg }));
  ok(st.over && /Stalemate/.test(st.msg), `the premove stalemates (${st.msg})`);
  ok(p && p.title === 'Correct!' && /stalemate/.test(p.text), 'popup says Correct! and names the stalemate');
} else ok(false, 'no stalemate puzzle in the data');

console.log('\n8  Next, restarts, and leaving');
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
  await page.click('#pzCard [data-act="exit"]');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    active: pzActive, card: document.getElementById('pzCard').classList.contains('on'), evalOn: document.body.classList.contains('pz-eval-on'),
    tab: botTab, color: botColorPref, chaos: window._bcpAttractorValues && window._bcpAttractorValues.chaos,
    temp: botMaiaTempValue, premoves: botPremoveEnabled, variety: botSfVar1, felo: document.getElementById('flounderElo').value,
    bot: botActive, start: _gameStartFen,
  }));
  ok(!back.active && !back.card, 'Exit closes puzzles');
  ok(!back.evalOn, 'and the eval bar goes with them');
  ok(back.tab === 'maia3' && back.color === 'white' && back.chaos === 3 && back.temp === 1.7 && back.premoves === true &&
     back.variety === 20 && back.felo === '900', 'the player’s own bot is back exactly as it was');
  ok(!back.bot && !back.start, 'and the board is back to a fresh game');
  ok(await page.evaluate(() => localStorage.getItem('bm_lastBot')) === lastBotBefore, 'the saved “last bot” was never touched');
}

console.log('\n9  Starting your own game from puzzles gives the bot back first');
{
  await startAt(page, 0);
  await page.waitForTimeout(200);
  await page.evaluate(() => { resign(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => quickBotStart());
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => ({ active: pzActive, tab: botTab, start: _gameStartFen, color: botPlayerColor, evalOn: document.body.classList.contains('pz-eval-on') }));
  ok(!s.active && s.tab === 'maia3' && !s.start && s.color === 'white' && !s.evalOn, 'Quick Start plays your own bot from the start position, no eval bar');
}
ok(errors.length === 0, 'no page errors (desktop)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await ctx.close();

// ── The share link ───────────────────────────────────────────────────────────
console.log('\n10 blundermindchess.com/PremovePuzzles');
{
  // A first-time visitor: nothing in storage at all.
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, false, BASE + '/PremovePuzzles', false);
  await page.waitForFunction(() => pzActive, null, { timeout: 15000 }).catch(() => {});
  const s = await page.evaluate(() => ({ active: pzActive, pro: document.body.classList.contains('pro-mode'),
    welcome: !document.getElementById('bmWelcome').hidden, veil: !document.getElementById('bmWelcomeVeil').hidden }));
  ok(s.active && !s.pro && !s.welcome && !s.veil, 'opens straight into puzzles on the Visualization board, no welcome in front');
  await page.click('#pzCard [data-act="exit"]');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => location.pathname === '/'), 'leaving puzzles puts the address back to /, so a reload doesn’t reopen them');
  ok(errors.length === 0, 'no page errors (link)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
  // A returning Expert-board player keeps their board for next time.
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await c2.addInitScript(() => { localStorage.setItem('bm_shell', 'pro'); localStorage.setItem('bm_landingSeen', '1'); });
  const p2 = await c2.newPage();
  await p2.goto(BASE + '/premovepuzzles/', { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => pzActive, null, { timeout: 15000 }).catch(() => {});
  const s2 = await p2.evaluate(() => ({ active: pzActive, pro: document.body.classList.contains('pro-mode'), stored: localStorage.getItem('bm_shell'), path: location.pathname }));
  ok(s2.active && !s2.pro && s2.stored === 'pro', 'an Expert player gets puzzles on the Visualization board, and keeps Expert for next time');
  ok(s2.path === '/PremovePuzzles', 'the trailing-slash spelling lands on /PremovePuzzles');
  await c2.close();
}

// ── The last move, and finding your place ────────────────────────────────────
console.log('\n12 The last move, and finding your place');
{
  const { ctx, page, errors } = await open({ width: 1280, height: 900 });
  await page.evaluate(() => pzLoad().then(() => pzStart(4)));
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => {
    const l = pzCur.lastUci && uciToSq(pzCur.lastUci);
    return { hl: !!l && lastMoveFrom === l.from && lastMoveTo === l.to, last: pzCur.last,
      prompt: document.querySelector('#pzCard .pz-prompt').textContent, num: document.querySelector('#pzCard .pz-jump').value };
  });
  ok(s.hl, 'the board highlights their last move from the game');
  ok(s.prompt.includes('just played') && s.prompt.includes(s.last), `and the card names it: “${s.prompt}”`);
  ok(s.num === '5', 'the card’s corner shows the puzzle number');
  await page.click('#pzCard [data-act="prev"]');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => pzIdx) === 3, '← Prev goes back one');
  const n = await page.evaluate(() => pzList.length);
  const target = Math.min(151, n);
  await page.fill('#pzCard .pz-jump', String(target));
  await page.press('#pzCard .pz-jump', 'Enter');
  await page.waitForTimeout(300);
  const j = await page.evaluate(() => ({ idx: pzIdx, fen: _gameStartFen === pzCur.fen, num: document.querySelector('#pzCard .pz-jump').value }));
  ok(j.idx === target - 1 && j.fen && j.num === String(target), `typing ${target} in the corner goes straight to puzzle ${target}`);
  await page.fill('#pzCard .pz-jump', String(n + 50));
  await page.press('#pzCard .pz-jump', 'Enter');
  await page.waitForTimeout(200);
  const k = await page.evaluate(() => ({ idx: pzIdx, num: document.querySelector('#pzCard .pz-jump').value }));
  ok(k.idx === target - 1 && k.num === String(target), 'a number past the end stays put');
  // Back another day: the same puzzle, found by its id, not its place in the set.
  const id = await page.evaluate(() => pzCur.id);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.evaluate(() => pzOpen());
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => pzCur && pzCur.id) === id, 'reopening puzzles picks up at that puzzle');
  ok(errors.length === 0, 'no page errors (navigation)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

// ── Phone ────────────────────────────────────────────────────────────────────
console.log('\n11 Phone');
{
  const { ctx, page, errors } = await open({ width: 412, height: 915 }, true);
  const sel2 = await pick(page);
  await page.evaluate(() => pzOpen());
  await page.waitForTimeout(600);
  await page.waitForFunction(() => document.getElementById('pzEvalLbl').textContent !== '', null, { timeout: 15000 }).catch(() => {});
  const lay = await page.evaluate(() => {
    const b = document.getElementById('cv').getBoundingClientRect();
    const c = document.getElementById('pzCard').getBoundingClientRect();
    const e = document.getElementById('pzEval').getBoundingClientRect();
    const nx = document.getElementById(pzCur.solver === 'w' ? 'playerBoxW' : 'playerBoxB').getBoundingClientRect();
    return { below: c.top >= b.bottom - 1, over: document.documentElement.scrollWidth - innerWidth,
             evalUnder: e.top >= b.bottom && e.bottom <= nx.top + 1 && Math.abs(e.width - b.width) < 2 };
  });
  ok(lay.below && lay.over <= 0, 'card sits under the board, no sideways scroll');
  ok(lay.evalUnder, 'the eval bar runs under the board, clear of the clock below');
  await page.screenshot({ path: shot('phone') });
  await startAt(page, sel2.busted.i);
  await page.waitForTimeout(300);
  await play(page, sel2.busted.uci);
  const p = await waitPopup(page, 20000);
  const fit = await page.evaluate(() => {
    const b = document.getElementById('cv').getBoundingClientRect(), q = document.getElementById('pzPop').getBoundingClientRect();
    return q.left >= b.left - 1 && q.right <= b.right + 1 && q.top >= b.top - 1 && q.bottom <= b.bottom + 1;
  });
  ok(p && fit, 'the popup fits over the board');
  ok(errors.length === 0, 'no page errors (phone)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

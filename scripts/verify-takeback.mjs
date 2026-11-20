// Takebacks in bot games (Nov 2026). Needs the server on :3100, run from the
// repo root:  node scripts/verify-takeback.mjs
//
// "Take back" sits with Offer draw and Resign. With the bot's reply on the
// board it takes back two plies (the player is on move again); while the bot
// is still thinking, one, and the bot's move in flight is dropped. The bot
// accepts as many a game as its builder setting says: every one by default,
// none (no button), or the first N. The clocks are not rewound and never stop.
// Later Nov 18 (Ben): the button is the player's choice, off until "Take-back
// button" is turned on in Board settings, and never in a 2-player game.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
});
// No explorer locally: answer every book question with nothing.
await ctx.route(/\/api\/(masters|lichess)\?/, route =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ moves: [] }) }));

const errs = [];
const panel = await ctx.newPage();
panel.on('pageerror', e => errs.push('panel: ' + e.message));
await panel.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
await panel.waitForTimeout(600);

const app = await ctx.newPage();
app.on('pageerror', e => errs.push('app: ' + e.message));
app.on('dialog', d => d.accept());
await app.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await app.waitForTimeout(1600);
await app.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });

console.log('\n1   Builder: Personality → Draws & Takebacks');
{
  const b = await panel.evaluate(() => {
    const out = {};
    out.tab = [...document.querySelectorAll('.itab')].some(t => /Draws & Takebacks/.test(t.textContent));
    out.def = getBotConfig().takebackLimit;
    out.defSel = document.querySelector('#tb-seg .seg-btn.sel')?.textContent;
    document.querySelector('#tb-seg .seg-btn[data-tb="3"]').click();
    out.three = getBotConfig().takebackLimit;
    const cfg = getBotConfig();
    applyBotConfig(Object.assign({}, cfg, { takebackLimit: 0 }));
    out.never = [getBotConfig().takebackLimit, document.querySelector('#tb-seg .seg-btn.sel')?.textContent];
    const old = Object.assign({}, cfg); delete old.takebackLimit;
    applyBotConfig(old);
    out.old = getBotConfig().takebackLimit;
    applyBotConfig(Object.assign({}, cfg, { takebackLimit: 4 }));
    out.four = [getBotConfig().takebackLimit, document.querySelector('#tb-seg .seg-btn.sel')?.textContent];
    applyBotConfig(Object.assign({}, cfg, { takebackLimit: -1 }));
    return out;
  });
  ok('the tab is "Draws & Takebacks"', b.tab);
  ok('default: accepts every one (-1)', b.def === -1 && b.defSel === 'Every one', JSON.stringify([b.def, b.defSel]));
  ok('picking 3 sets 3', b.three === 3, String(b.three));
  ok('a loaded bot\'s 0 shows Never', b.never[0] === 0 && b.never[1] === 'Never', JSON.stringify(b.never));
  ok('a bot saved before the setting accepts every one', b.old === -1, String(b.old));
  ok('a number not on the row (4) shows as its own button', b.four[0] === 4 && b.four[1] === '4', JSON.stringify(b.four));
}

// A Flounder bot that replies at once; the human plays White, timed or not.
const startGame = async (o) => {
  const cfg = await panel.evaluate((o) => {
    const card = document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]');
    if (card) selEngineMode(card);
    setEngineBook('off');
    repSlots.white.length = 0; repSlots.black.length = 0;
    (o.blackLines || []).forEach(p => { const r = ECO_DATA.find(x => x.path === p); repToggleRow(null, 'black', r.i, true); });
    setOpStage('white', 'rep', false); setOpStage('white', 'ml', false);
    setOpStage('black', 'rep', !!(o.blackLines && o.blackLines.length)); setOpStage('black', 'ml', false);
    setTakebackLimit(o.limit);
    const cfg = getBotConfig();
    cfg.color = 'white';
    cfg.tcTime = o.tc || 0; cfg.tcInc = 0;
    cfg.timingMode = o.slow ? 'fixed' : 'instant';
    cfg.fixedDelayMs = 4000;
    return cfg;
  }, o);
  await app.evaluate((cfg) => { window.postMessage(cfg, location.origin); }, cfg);
  await app.waitForFunction(() => botActive && !gameOver, null, { timeout: 15000 });
  await app.waitForTimeout(300);
};
const human = (uci) => app.evaluate((u) => { const mv = uciToSq(u); executeMove(mv.from, mv.to, null); }, uci);
const waitBot = (plies) => app.waitForFunction((n) => gameMovesAlgebraic.length >= n && !botThinking, plies, { timeout: 45000 });
const state = () => app.evaluate(() => {
  const btn = document.getElementById('takebackBtn');
  return {
    moves: gameMovesAlgebraic.slice(), turn, botMoves: botMoveHistory.length, used: botTakebacksUsed,
    shown: !!btn && btn.style.display !== 'none', disabled: !!btn && btn.disabled, label: btn ? btn.textContent : '',
    title: btn ? btn.title : '', fen: boardToFen(board, turn, castling, epSq), hm: halfmoveClock,
    counts: Object.values(positionCounts).reduce((a, b) => a + b, 0), lastFrom: lastMoveFrom, status: (document.getElementById('botStatus') || {}).textContent,
    w: clockTimeW, b: clockTimeB, clockOn: clockActive,
  };
});
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

console.log('\n1b  Board settings: off until the player turns it on, never in a 2-player game');
{
  await startGame({ limit: -1 });
  await human('e2e4'); await waitBot(2);
  const off = await app.evaluate(() => ({
    box: document.getElementById('cbTakeback').checked, stored: localStorage.getItem('bm_takeback'),
    shown: ['takebackBtn', 'pbTakeback', 'proTakebackBtn'].filter(id => document.getElementById(id).style.display !== 'none'),
    asked: botRequestTakeback(), moves: gameMovesAlgebraic.length,
  }));
  ok('off by default: no button on any board, and asking takes nothing back',
    !off.box && off.stored === null && !off.shown.length && off.asked === false && off.moves === 2, JSON.stringify(off));
  const on = await app.evaluate(() => {
    const cb = document.getElementById('cbTakeback');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const btn = document.getElementById('takebackBtn');
    return { stored: localStorage.getItem('bm_takeback'), shown: btn.style.display !== 'none', disabled: btn.disabled };
  });
  ok('turned on in Board settings, mid-game: the button is there at once, and remembered',
    on.stored === '1' && on.shown && !on.disabled, JSON.stringify(on));
  const mp = await app.evaluate(() => {
    const was = mpRoomId; mpRoomId = 'TEST';
    const ui = botTakebackUi(); syncTakebackBtns();
    const shown = document.getElementById('takebackBtn').style.display !== 'none';
    mpRoomId = was; syncTakebackBtns();
    return { show: ui.show, shown };
  });
  ok('in a 2-player room it is never offered, whatever the setting', !mp.show && !mp.shown, JSON.stringify(mp));
  const loaded = await app.evaluate(() => { const cb = document.getElementById('cbTakeback'); cb.checked = false; loadTakebackPref(); return cb.checked; });
  ok('the saved choice is read back on the next visit', loaded === true);
}

console.log('\n2   Every takeback accepted (the default)');
{
  await startGame({ limit: -1 });
  let s = await state();
  ok('the button is there from the start, greyed until there is a move to take back',
    s.shown && s.disabled && /No move of yours/.test(s.title), JSON.stringify([s.shown, s.disabled, s.title]));
  await human('e2e4');
  await waitBot(2);
  s = await state();
  ok('after the bot\'s reply it is live', s.shown && !s.disabled && s.label === '↶ Take back', JSON.stringify(s));
  await app.click('#takebackBtn', { force: true }).catch(async () => { await app.evaluate(() => botRequestTakeback()); });
  await app.waitForTimeout(200);
  s = await state();
  ok('it takes back both moves: the start position, White to move', s.moves.length === 0 && s.fen.startsWith(START) && s.turn === 'w',
    JSON.stringify([s.moves, s.fen]));
  ok('the bot\'s history goes with them', s.botMoves === 0, String(s.botMoves));
  ok('the draw-rule counts are rebuilt (one position, seen once)', s.counts === 1 && s.hm === 0, JSON.stringify([s.counts, s.hm]));
  ok('no last-move highlight left behind', s.lastFrom === -1, String(s.lastFrom));
  ok('the status line says so', /Took back your move and the bot/.test(s.status), s.status);
  ok('and the button is greyed again (nothing left to take back)', s.disabled, JSON.stringify([s.disabled, s.title]));
  await human('d2d4');
  await waitBot(2);
  s = await state();
  ok('the game goes on: 1.d4 and a reply', s.moves.length === 2 && s.moves[0] === 'd4', JSON.stringify(s.moves));
}

console.log('\n3   While the bot is thinking: one ply, and its move is dropped');
{
  await startGame({ limit: -1, slow: true });
  await human('e2e4');
  await app.waitForTimeout(400);
  let s = await state();
  ok('the bot is on move (Fixed 4 s)', s.turn === 'b' && s.moves.length === 1, JSON.stringify(s.moves));
  ok('the button is live', s.shown && !s.disabled);
  await app.evaluate(() => botRequestTakeback());
  s = await state();
  ok('one ply back: the start position', s.moves.length === 0 && s.turn === 'w', JSON.stringify(s.moves));
  ok('the status says only your move went', /Took back your move$/.test(s.status) || /Took back your move ·/.test(s.status), s.status);
  await app.waitForTimeout(5000);
  s = await state();
  ok('the reply that was on its way never lands', s.moves.length === 0 && s.turn === 'w', JSON.stringify(s.moves));
  await human('e2e4');
  await waitBot(2);
  s = await state();
  ok('and the bot answers the next move as usual', s.moves.length === 2, JSON.stringify(s.moves));
}

console.log('\n4   A limit of 1');
{
  await startGame({ limit: 1 });
  await human('e2e4'); await waitBot(2);
  let s = await state();
  ok('the button shows how many are left', s.label === '↶ Take back (1)', s.label);
  await app.evaluate(() => botRequestTakeback());
  s = await state();
  ok('the first is accepted', s.moves.length === 0 && s.used === 1, JSON.stringify([s.moves, s.used]));
  ok('the status says it was the last', /that was the last one/.test(s.status), s.status);
  await human('e2e4'); await waitBot(2);
  s = await state();
  ok('then greyed, saying they are used up', s.shown && s.disabled && /used up/.test(s.title) && s.label === '↶ Take back (0)',
    JSON.stringify([s.disabled, s.title, s.label]));
  const r = await app.evaluate(() => botRequestTakeback());
  s = await state();
  ok('and a second request changes nothing', r === false && s.moves.length === 2, JSON.stringify([r, s.moves]));
  const sess = await app.evaluate(() => { bmSessionSave(); return JSON.parse(localStorage.getItem(BM_SESSION_KEY)).bot.takebacksUsed; });
  ok('the saved session keeps the count', sess === 1, String(sess));
}

console.log('\n5   Never');
{
  await startGame({ limit: 0 });
  await human('e2e4'); await waitBot(2);
  const s = await state();
  const pb = await app.evaluate(() => document.getElementById('pbTakeback').style.display);
  ok('no button at all', !s.shown && pb === 'none', JSON.stringify([s.shown, pb]));
  const r = await app.evaluate(() => botRequestTakeback());
  ok('and nothing taken back if asked anyway', r === false && (await state()).moves.length === 2);
}

console.log('\n6   The clocks run on');
{
  await startGame({ limit: -1, tc: 5 });   // 5 minutes (tcTime is in minutes)
  await human('e2e4'); await waitBot(2);
  await app.waitForTimeout(2300);
  const before = await state();
  await app.evaluate(() => botRequestTakeback());
  const after = await state();
  ok('no time given back: White\'s clock is charged up to the takeback', after.w <= before.w && after.w < 300, JSON.stringify([before.w, after.w]));
  ok('the clock is still running', after.clockOn);
  await app.waitForTimeout(2200);
  const later = await state();
  ok('and White\'s time keeps going down after it', later.w < after.w, JSON.stringify([after.w, later.w]));
}

console.log('\n7   The repertoire comes back with the position');
{
  // Bot is Black with the French. 1.d4 leaves it; take back; 1.e4 is on the lines again.
  await startGame({ limit: -1, blackLines: ['e4 e6 d4 d5 Nc3 Bb4'] });
  await human('d2d4'); await waitBot(2);
  let st = await app.evaluate(() => ({ mode: botRepState.mode, src: lastBotMoveSource }));
  ok('1.d4: off the French lines, the engine replies', st.mode === 'off' && st.src !== 'ECO', JSON.stringify(st));
  await app.evaluate(() => botRequestTakeback());
  st = await app.evaluate(() => ({ mode: botRepState.mode, active: preferredOpeningActive }));
  ok('taken back: the repertoire is on its lines again', st.mode === 'line' && st.active, JSON.stringify(st));
  await human('e2e4'); await waitBot(2);
  const s = await state();
  const src = await app.evaluate(() => lastBotMoveSource);
  ok('1.e4 e6 from the repertoire', s.moves[1] === 'e6' && src === 'ECO', JSON.stringify([s.moves, src]));
}

console.log('\n8   Phone bar and Expert board');
{
  await app.setViewportSize({ width: 390, height: 844 });
  await app.waitForTimeout(300);
  const ph = await app.evaluate(() => {
    syncActionRow();
    const b = document.getElementById('pbTakeback');
    const r = b.getBoundingClientRect();
    const l = b.querySelector('.pb-l');
    return { shown: getComputedStyle(b).display !== 'none' && r.width > 0, label: l.textContent, cut: l.scrollWidth > l.clientWidth + 1,
             overflow: document.documentElement.scrollWidth - window.innerWidth,
             barOverflow: (() => { const bar = document.getElementById('phoneBar'); return bar.scrollWidth - bar.clientWidth; })() };
  });
  ok('phone: Undo (take back) is on the game bar, label not cut off', ph.shown && ph.label === 'Undo' && !ph.cut, JSON.stringify(ph));
  ok('phone: nothing spills sideways', ph.overflow <= 0 && ph.barOverflow <= 0, JSON.stringify(ph));
  await app.setViewportSize({ width: 1440, height: 900 });
  const pro = await app.evaluate(() => {
    setShell('pro');
    proSync(); syncActionRow();
    const b = document.getElementById('proTakebackBtn');
    const out = { shown: getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0, text: b.textContent };
    setShell('amateur');
    return out;
  });
  ok('Expert board: Take back with Resign and Draw', pro.shown && /Take back/.test(pro.text), JSON.stringify(pro));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

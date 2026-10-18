// End-to-end check of the Lichess bot bridge (src/65-lichess-bridge.js)
// against a stand-in Lichess: a local server that speaks the parts of the Bot
// API the bridge uses (account, event stream, challenges, game stream, moves,
// draws, takebacks, resign/abort/claim-victory) and plays a random-move
// opponent that misbehaves on cue — draw offers, a refused move, a dropped
// stream, a flag, walking away, and a page reload mid-game.
//
// The page reaches it through ?lichessApi=, which the bridge honours on a
// localhost page only.
//
// Run with the dev server up on :3100:
//   node scripts/verify-lichess-bridge.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'http://localhost:3100/';
const MOCK_PORT = 3199;
const TOKEN = 'lip_test';
const BOT = { id: 'bmtestbot', name: 'BMTestBot', title: 'BOT', rating: 1500 };
const HUMAN = { id: 'testhuman', name: 'TestHuman', rating: 1600 };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// --shots <dir>: save screenshots of the panel mid-game (desktop and phone)
const SHOTS = (i => i > 0 ? process.argv[i + 1] : null)(process.argv.indexOf('--shots'));

let pass = 0, fail = 0;
function check(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(150); }
  if (label) console.log('    (timed out waiting for ' + label + ')');
  return false;
}

// ── Chess rules for the stand-in: the app's own core, run in a vm ──────────
const core = { document: { getElementById: () => null }, indActive: () => false, console };
vm.createContext(core);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', '20-chess-core.js'), 'utf8'), core);
const sqOf = s => core.fileRankToSq(s);
const nameOf = i => core.sqName(i);
function placement(bd) { let s = ''; for (let i = 0; i < 64; i++) s += bd[i] ? bd[i].color + bd[i].piece : '..'; return s; }

// ── The stand-in Lichess ────────────────────────────────────────────────────
const M = {
  eventStreams: new Set(),
  challenges: {},   // id → { c, opts, declined, accepted }
  games: {},        // id → game
  posts: [],        // every POST path, in order
};
let seq = 0;

function cors(res, code, type) {
  res.writeHead(code, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': type || 'application/json',
  });
}
function json(res, code, obj) { cors(res, code); res.end(JSON.stringify(obj)); }
function line(res, obj) { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} }
function sendEvent(ev) { for (const r of M.eventStreams) line(r, ev); }

function newChallenge(o) {
  const id = 'ch' + (++seq);
  const c = {
    id, url: 'http://localhost/' + id, status: 'created', direction: 'in',
    challenger: o.challenger || HUMAN, destUser: BOT,
    variant: { key: o.variant || 'standard' }, rated: !!o.rated, speed: o.speed || 'blitz',
    timeControl: o.tc || { type: 'clock', limit: 180, increment: 2 },
    color: o.color || 'random',
  };
  M.challenges[id] = { c, opts: o.opts || {}, declined: null, accepted: false };
  sendEvent({ type: 'challenge', challenge: c });
  return id;
}

function newGame(ch) {
  const id = ('gm' + (++seq) + 'abcdefgh').slice(0, 8);
  const bd = core.parseFen(START);
  const botWhite = ch.c.color === 'black' ? true : ch.c.color === 'white' ? false : Math.random() < 0.5;
  const tc = ch.c.timeControl;
  const g = {
    id, botWhite, rated: ch.c.rated, speed: ch.c.speed, opts: ch.opts,
    clock: { initial: tc.limit * 1000, increment: tc.increment * 1000 },
    wtime: tc.limit * 1000, btime: tc.limit * 1000, lastAt: Date.now(),
    bd, turn: 'w', cst: { wK: true, wQ: true, bK: true, bQ: true }, ep: -1,
    moves: [], status: 'started', winner: null,
    wdraw: false, bdraw: false, wtakeback: false, btakeback: false,
    streams: new Set(), oppBusy: false, rejected: false, dropped: false,
    botPosts: [], refused: [], draws: [], takebacks: 0, claims: 0, drawOffersByBot: 0,
  };
  M.games[id] = g;
  return g;
}
const botLetter = g => g.botWhite ? 'w' : 'b';
function state(g) {
  const st = { type: 'gameState', moves: g.moves.join(' '), wtime: Math.round(g.wtime), btime: Math.round(g.btime),
    winc: g.clock.increment, binc: g.clock.increment, status: g.status,
    wdraw: g.wdraw, bdraw: g.bdraw, wtakeback: g.wtakeback, btakeback: g.btakeback };
  if (g.winner) st.winner = g.winner;
  return st;
}
function full(g) {
  return { type: 'gameFull', id: g.id, variant: { key: 'standard' }, speed: g.speed, rated: g.rated,
    white: g.botWhite ? BOT : HUMAN, black: g.botWhite ? HUMAN : BOT,
    initialFen: 'startpos', clock: g.clock, state: state(g) };
}
function broadcast(g) {
  const st = state(g);
  for (const r of g.streams) line(r, st);
  if (g.status !== 'started') {
    for (const r of g.streams) { try { r.end(); } catch (e) {} }
    g.streams.clear();
    sendEvent({ type: 'gameFinish', game: { gameId: g.id, id: g.id } });
  }
}
function finish(g, status, winner) {
  if (g.status !== 'started') return;
  g.status = status; g.winner = winner || null;
  broadcast(g);
}

// Apply a UCI move to the stand-in's position; returns false if illegal.
function play(g, uci) {
  const from = sqOf(uci.slice(0, 2)), to = sqOf(uci.slice(2, 4));
  const p = g.bd[from];
  if (!p || p.color !== g.turn) return false;
  if (!core.legalMovesFor(from, g.bd, g.ep, g.cst).includes(to)) return false;
  const now = Date.now();
  if (g.moves.length >= 2) {
    const used = now - g.lastAt;
    if (g.turn === 'w') g.wtime -= used; else g.btime -= used;
  }
  if (g.turn === 'w') g.wtime += g.clock.increment; else g.btime += g.clock.increment;
  g.lastAt = now;
  const ne = core.computeEP(from, to, g.bd);
  g.cst = core.updateCastling(from, to, p, g.cst);
  g.bd = core.applyMove(from, to, g.bd, g.ep, uci[4] ? uci[4].toUpperCase() : 'Q');
  g.ep = ne;
  g.turn = g.turn === 'w' ? 'b' : 'w';
  g.moves.push(uci);
  g.wdraw = g.bdraw = false;
  const next = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
  if (!next.length) {
    if (core.inCheck(g.bd, g.turn)) { g.status = 'mate'; g.winner = g.turn === 'w' ? 'black' : 'white'; }
    else g.status = 'stalemate';
  }
  return true;
}

// The opponent's turn, with whatever trouble this game's opts ask for. The
// draw offer comes last on purpose: the bot may take it, and that ends the game.
function opponentTurn(g) {
  if (g.oppBusy || g.status !== 'started' || g.turn === botLetter(g)) return;
  g.oppBusy = true;
  const ply = g.moves.length, o = g.opts, oc = g.botWhite ? 'b' : 'w';
  setTimeout(async () => {
    try {
      if (g.status !== 'started') return;
      if (o.resignAtPly != null && ply >= o.resignAtPly) { finish(g, 'resign', g.botWhite ? 'white' : 'black'); return; }
      if (o.flagAtPly != null && ply >= o.flagAtPly) {
        // Our clock is nearly gone and we never move: Lichess flags us.
        if (oc === 'w') g.wtime = 400; else g.btime = 400;
        g.lastAt = Date.now();
        broadcast(g);
        setTimeout(() => finish(g, 'outoftime', g.botWhite ? 'white' : 'black'), o.flagAfterMs || 3000);
        return;
      }
      if (o.goneAtPly != null && ply >= o.goneAtPly) {
        for (const r of g.streams) line(r, { type: 'opponentGone', gone: true, claimWinInSeconds: 1 });
        return;   // never moves again; the bot should claim
      }
      if (o.dropStreamAtPly != null && ply >= o.dropStreamAtPly && !g.dropped) {
        g.dropped = true;
        for (const r of g.streams) { try { r.destroy(); } catch (e) {} }
        g.streams.clear();
        await sleep(400);
      }
      if (o.drawOfferAtPly != null && ply === o.drawOfferAtPly) {
        if (oc === 'w') g.wdraw = true; else g.bdraw = true;
        broadcast(g);
        await sleep(2500);   // give the bot time to answer before moving on
        if (g.status !== 'started') return;
      }
      if (o.takebackAtPly != null && ply === o.takebackAtPly) {
        if (oc === 'w') g.wtakeback = true; else g.btakeback = true;
        broadcast(g);
        await sleep(600);
        g.wtakeback = g.btakeback = false;
      }
      const all = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
      if (!all.length) return;
      const mv = all[Math.floor(Math.random() * all.length)];
      const p = g.bd[mv.from];
      const promo = p.piece === 'P' && (mv.to < 8 || mv.to >= 56) ? 'q' : '';
      play(g, nameOf(mv.from) + nameOf(mv.to) + promo);
      broadcast(g);
    } finally {
      g.oppBusy = false;
    }
  }, o.oppDelayMs || 350);
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res, 204); res.end(); return; }
  if (req.headers.authorization !== 'Bearer ' + TOKEN) { json(res, 401, { error: 'No such token' }); return; }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  let m;
  if (req.method === 'POST') M.posts.push(p + u.search);

  if (req.method === 'GET' && p === '/api/account') { json(res, 200, { id: BOT.id, username: BOT.name, title: 'BOT' }); return; }

  if (req.method === 'GET' && p === '/api/stream/event') {
    cors(res, 200, 'application/x-ndjson');
    M.eventStreams.add(res);
    const ka = setInterval(() => { try { res.write('\n'); } catch (e) {} }, 3000);
    req.on('close', () => { clearInterval(ka); M.eventStreams.delete(res); });
    // Like Lichess: open games and pending challenges are sent on open.
    for (const g of Object.values(M.games)) if (g.status === 'started')
      line(res, { type: 'gameStart', game: { gameId: g.id, id: g.id, color: g.botWhite ? 'white' : 'black' } });
    for (const ch of Object.values(M.challenges)) if (!ch.declined && !ch.accepted)
      line(res, { type: 'challenge', challenge: ch.c });
    return;
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/challenge\/(\w+)\/(accept|decline)$/))) {
    const ch = M.challenges[m[1]];
    if (!ch) { json(res, 404, { error: 'Not found' }); return; }
    if (m[2] === 'decline') {
      const body = await readBody(req);
      ch.declined = new URLSearchParams(body).get('reason') || 'generic';
      json(res, 200, { ok: true });
      return;
    }
    ch.accepted = true;
    const g = newGame(ch);
    ch.gameId = g.id;
    json(res, 200, { ok: true });
    setTimeout(() => sendEvent({ type: 'gameStart', game: { gameId: g.id, id: g.id, color: g.botWhite ? 'white' : 'black' } }), 100);
    return;
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/bot\/game\/stream\/(\w+)$/))) {
    const g = M.games[m[1]];
    if (!g) { json(res, 404, { error: 'Not found' }); return; }
    cors(res, 200, 'application/x-ndjson');
    line(res, full(g));
    if (g.status !== 'started') { res.end(); return; }
    g.streams.add(res);
    const ka = setInterval(() => { try { res.write('\n'); } catch (e) {} }, 3000);
    req.on('close', () => { clearInterval(ka); g.streams.delete(res); });
    opponentTurn(g);
    return;
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/bot\/game\/(\w+)\/(.+)$/))) {
    const g = M.games[m[1]];
    if (!g) { json(res, 404, { error: 'Not found' }); return; }
    const act = m[2];
    if ((m = act.match(/^move\/(\w+)$/))) {
      const uci = m[1];
      g.botPosts.push(uci);
      if (g.status !== 'started' || g.turn !== botLetter(g)) { g.refused.push(uci); json(res, 400, { error: 'Not your turn, or game already over' }); return; }
      if (g.opts.rejectAtPly != null && g.moves.length >= g.opts.rejectAtPly && !g.rejected) {
        g.rejected = true; g.refused.push(uci);
        json(res, 400, { error: 'Simulated refusal' });
        return;
      }
      if (!play(g, uci)) { g.refused.push(uci); json(res, 400, { error: 'Illegal move ' + uci }); return; }
      json(res, 200, { ok: true });
      broadcast(g);
      opponentTurn(g);
      return;
    }
    if ((m = act.match(/^draw\/(yes|no)$/))) {
      g.draws.push(m[1]);
      const oppOffer = g.botWhite ? g.bdraw : g.wdraw;
      if (m[1] === 'yes' && oppOffer) { json(res, 200, { ok: true }); finish(g, 'draw'); return; }
      if (m[1] === 'yes') g.drawOffersByBot++;
      g.wdraw = g.bdraw = false;
      json(res, 200, { ok: true });
      broadcast(g);
      return;
    }
    if (act === 'takeback/no') { g.takebacks++; json(res, 200, { ok: true }); return; }
    if (act === 'resign') { json(res, 200, { ok: true }); finish(g, 'resign', g.botWhite ? 'black' : 'white'); return; }
    if (act === 'abort') {
      if (g.moves.length >= 2) { json(res, 400, { error: 'Too late to abort' }); return; }
      json(res, 200, { ok: true }); finish(g, 'aborted'); return;
    }
    if (act === 'claim-victory') { g.claims++; json(res, 200, { ok: true }); finish(g, 'timeout', g.botWhite ? 'white' : 'black'); return; }
    json(res, 404, { error: 'Unknown ' + act });
    return;
  }
  json(res, 404, { error: 'Not found ' + p });
});
await new Promise(r => server.listen(MOCK_PORT, r));

// ── The page ────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('bm_welcomed', '1'); localStorage.setItem('bm_landingSeen', '1'); } catch (e) {}
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', d => d.accept());
const URL_ = APP + '?lichess&lichessApi=http://localhost:' + MOCK_PORT;
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof quickBotPick === 'function' && document.getElementById('lbPanel'));
await page.waitForTimeout(1200);
// A fast, Stockfish-only bot keeps the run short.
await page.evaluate(() => { quickBotPick('1200'); });
const lastBotBefore = await page.evaluate(() => localStorage.getItem('bm_lastBot'));

const pageBoard = () => page.evaluate(() => { let s = ''; for (let i = 0; i < 64; i++) s += board[i] ? board[i].color + board[i].piece : '..'; return s; });
const lbState = () => page.evaluate(() => lbState);

console.log('\n1. Connecting');
check(await page.evaluate(() => !!document.getElementById('lbPanel')), 'panel shows on a ?lichess page');
await page.fill('#lbToken', 'lip_wrong');
await page.click('#lbConnect');
await until(async () => (await lbState()) === 'error', 5000);
check((await page.textContent('#lbStatus')).includes('rejected'), 'a bad token is reported', await page.textContent('#lbStatus'));
check(await page.isVisible('#lbToken'), 'a rejected token is dropped and the field comes back');
await page.fill('#lbToken', TOKEN);
await page.click('#lbConnect');
await until(async () => (await lbState()) === 'waiting' && M.eventStreams.size === 1, 10000, 'waiting');
check(await lbState() === 'waiting', 'connected and waiting');
check((await page.textContent('#lbAcct')).includes('@BMTestBot'), 'shows the bot account', await page.textContent('#lbAcct'));
check(!(await page.evaluate(() => localStorage.getItem('bm_lichessBot') || '')).includes('lip_wrong'), 'the rejected token is not kept');
await until(() => page.evaluate(() => sfReady), 30000, 'Stockfish');

console.log('\n2. Declining what the filters exclude');
const cases = [
  [{ variant: 'chess960' }, 'variant'],
  [{ variant: 'fromPosition' }, 'standard'],
  [{ speed: 'correspondence', tc: { type: 'correspondence', daysPerTurn: 3 } }, 'timeControl'],
  [{ rated: true }, 'casual'],
  [{ challenger: { id: 'somebot', name: 'SomeBot', title: 'BOT', rating: 2000 } }, 'noBot'],
  [{ speed: 'bullet', tc: { type: 'clock', limit: 60, increment: 0 } }, 'tooFast'],
];
for (const [o, want] of cases) {
  const id = newChallenge(o);
  await until(() => M.challenges[id].declined, 5000);
  check(M.challenges[id].declined === want, 'declined ' + JSON.stringify(o).slice(0, 60) + ' as ' + want, M.challenges[id].declined);
}

console.log('\n3. Game 1: bot is Black — draw offer, takeback, refused move, dropped stream, resignation');
const c1 = newChallenge({ color: 'white', opts: { takebackAtPly: 4, rejectAtPly: 7, dropStreamAtPly: 10, drawOfferAtPly: 14, resignAtPly: 22 } });
await until(() => M.challenges[c1].gameId, 5000);
check(!!M.challenges[c1].gameId, 'accepted a casual blitz challenge');
const g1 = M.games[M.challenges[c1].gameId];
await until(async () => (await lbState()) === 'playing', 5000);
check(await lbState() === 'playing', 'panel says playing');
await until(() => g1.moves.length >= 4, 60000, 'four plies');
const busy = newChallenge({});
await until(() => M.challenges[busy].declined, 5000);
check(M.challenges[busy].declined === 'later', 'a second challenge mid-game is declined "later"', M.challenges[busy].declined);
check((await page.evaluate(() => [document.querySelector('#playerBoxW .player-name').textContent, document.querySelector('#playerBoxB .player-name').textContent])).join('|').includes('TestHuman'),
  'the opponent\'s Lichess name is in the human\'s seat');
// The board does not take clicks: both sides' moves come from elsewhere.
await page.evaluate(() => {
  const cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
  for (const [x, y] of [[0.55, 0.85], [0.55, 0.6]]) {
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true }));
    cv.dispatchEvent(new MouseEvent('mouseup', { clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true }));
  }
});
check(await page.evaluate(() => selSq) === -1, 'clicks on the board select nothing');
const clockGap = await page.evaluate(() => [clockTimeW, clockTimeB]);
check(Math.abs(clockGap[0] * 1000 - g1.wtime) < 4000 && Math.abs(clockGap[1] * 1000 - g1.btime) < 4000,
  'page clocks follow the server\'s', { page: clockGap, server: [g1.wtime, g1.btime] });
if (SHOTS) {
  await page.screenshot({ path: path.join(SHOTS, 'lb-playing-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  await page.screenshot({ path: path.join(SHOTS, 'lb-playing-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
}
const genBefore = await page.evaluate(() => _botGameGen);
await page.evaluate(() => { quickBotStart(); });
check(await page.evaluate(() => _botGameGen) === genBefore && await lbState() === 'playing', 'Start Game is refused while hosting');
await until(() => g1.status !== 'started', 240000, 'game 1 to finish');
await sleep(800);
check(g1.takebacks === 1, 'takeback request declined', g1.takebacks);
check(g1.draws.length >= 1 && ['yes', 'no'].includes(g1.draws[0]), 'answered the draw offer (' + g1.draws.join(',') + ')', g1.draws);
check(g1.rejected && g1.refused.length >= 1, 'the refused move happened', g1.refused);
check(g1.dropped, 'the dropped game stream was survived', { dropped: g1.dropped, plies: g1.moves.length });
check(g1.refused.length === 1, 'nothing but the simulated refusal was refused', g1.refused);
const pb1 = await pageBoard();
check(pb1 === placement(g1.bd), 'board matches the server at the end (' + g1.moves.length + ' plies)');
check(await page.evaluate(() => gameOver), 'page game is over');
console.log('    result: ' + g1.status + ' · page says: ' + await page.evaluate(() => gameOverMsg));
if (g1.status === 'resign') check((await page.evaluate(() => gameOverMsg)).includes('resigned'), 'page shows the resignation');
await until(async () => (await lbState()) === 'waiting', 5000);
check(await lbState() === 'waiting', 'back to waiting');

console.log('\n4. Game 2: bot is White — first move, and no local flag');
const c2 = newChallenge({ color: 'black', tc: { type: 'clock', limit: 120, increment: 1 }, opts: { flagAtPly: 7, flagAfterMs: 3500 } });
await until(() => M.challenges[c2].gameId, 5000);
const g2 = M.games[M.challenges[c2].gameId];
await until(() => g2.moves.length >= 1, 30000, 'first move');
check(g2.moves.length >= 1 && g2.botPosts[0] === g2.moves[0], 'bot made the first move', g2.moves);
await until(() => g2.status !== 'started' || (g2.moves.length >= 7 && g2.turn !== botLetter(g2)), 90000);
await sleep(2000);   // the opponent's clock has run out on the page; the server has not ruled yet
if (g2.status === 'started') check(await page.evaluate(() => !gameOver), 'the page does not flag the opponent itself');
await until(() => g2.status !== 'started', 10000);
await sleep(600);
if (g2.status === 'outoftime') check((await page.evaluate(() => gameOverMsg)).includes('ran out of time'), 'the server\'s flag ends the game on the page', await page.evaluate(() => gameOverMsg));
else console.log('    (game 2 ended early: ' + g2.status + ')');
check(await pageBoard() === placement(g2.bd), 'board matches the server');

console.log('\n5. Game 3: opponent walks away — claim victory');
const c3 = newChallenge({ color: 'white', opts: { goneAtPly: 4 } });
await until(() => M.challenges[c3].gameId, 5000);
const g3 = M.games[M.challenges[c3].gameId];
await until(() => g3.status !== 'started', 90000, 'claim');
check(g3.claims === 1 && g3.status === 'timeout', 'claimed the win', { claims: g3.claims, status: g3.status });

console.log('\n6. Game 4: page reloads mid-game and picks it back up');
const c4 = newChallenge({ color: 'random', opts: { resignAtPly: 16 } });
await until(() => M.challenges[c4].gameId, 5000);
const g4 = M.games[M.challenges[c4].gameId];
await until(() => g4.moves.length >= 6, 90000, 'six plies');
const pliesAtReload = g4.moves.length;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof quickBotPick === 'function');
await page.waitForTimeout(800);
await page.evaluate(() => { quickBotPick('1200'); });
await until(() => g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 90000, 'play after reload');
check(g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 'reconnected and kept playing (' + pliesAtReload + ' → ' + g4.moves.length + ' plies)');
await until(() => g4.status !== 'started', 120000, 'game 4 to finish');
await sleep(800);
check(await pageBoard() === placement(g4.bd), 'board matches the server after the reload');
check(g4.refused.length === 0, 'no move refused after the reload', g4.refused);

console.log('\n7. Leaving no trace');
check(await page.evaluate(() => localStorage.getItem('bm_lastBot')) === lastBotBefore, 'the user\'s remembered bot is untouched');
check(M.posts.filter(p => p.includes('/move/')).every(p => /\/move\/[a-h][1-8][a-h][1-8][qrbn]?$/.test(p)), 'every move post is plain UCI');
await page.click('#lbDisconnect');
await until(() => M.eventStreams.size === 0, 5000);
check(M.eventStreams.size === 0 && await lbState() === 'off', 'disconnect closes the event stream');
await page.click('#lbForget');
check(await page.isVisible('#lbToken') && !(await page.evaluate(() => localStorage.getItem('bm_lichessBot') || '')).includes(TOKEN),
  'forget token clears it from storage and brings the field back');
check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 5));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

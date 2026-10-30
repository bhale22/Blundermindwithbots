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
      // An offer that travels with the move: the same gameState carries both.
      if (o.drawWithMoveAtPly != null && ply === o.drawWithMoveAtPly) {
        if (oc === 'w') g.wdraw = true; else g.bdraw = true;
        g.offered = true;
      }
      broadcast(g);
      // An offer made just after moving, while the bot is thinking.
      if (o.drawMidThinkAtPly != null && ply === o.drawMidThinkAtPly) {
        await sleep(o.midThinkDelayMs || 400);
        if (g.status === 'started' && g.turn === botLetter(g)) {
          if (oc === 'w') g.wdraw = true; else g.bdraw = true;
          g.offered = true;
          broadcast(g);
        }
      }
    } finally {
      g.oppBusy = false;
    }
  }, o.oppDelayMs || 350);
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
}

// Three accounts for the Bot Builder's connect flow (section 8): the bot
// account; a fresh one, never played, that can be upgraded (it IS the bot
// account once it has been, so its games play as BOT); and one that has
// played games, which Lichess refuses to upgrade.
const FRESH = 'lip_fresh', PLAYED = 'lip_played';
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res, 204); res.end(); return; }
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (![TOKEN, FRESH, PLAYED].includes(tok)) { json(res, 401, { error: 'No such token' }); return; }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  let m;
  if (req.method === 'POST') M.posts.push(p + u.search);

  if (req.method === 'GET' && p === '/api/account') {
    if (tok === PLAYED) { json(res, 200, { id: 'playedhuman', username: 'PlayedHuman', count: { all: 12 } }); return; }
    if (tok === FRESH && !M.freshUpgraded) { json(res, 200, { id: BOT.id, username: BOT.name, count: { all: 0 } }); return; }
    json(res, 200, { id: BOT.id, username: BOT.name, title: 'BOT', count: { all: 0 } });
    return;
  }
  if (req.method === 'POST' && p === '/api/bot/account/upgrade') {
    if (tok === FRESH && !M.freshUpgraded) { M.freshUpgraded = true; json(res, 200, { ok: true }); return; }
    json(res, 400, { error: tok === PLAYED ? 'This account has played games' : 'Already a bot account' });
    return;
  }

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
      // On Lichess this move would decline a standing offer from the opponent.
      if (g.botWhite ? g.bdraw : g.wdraw) g.movedOverOffer = (g.movedOverOffer || 0) + 1;
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
  try { localStorage.setItem('bm_welcomed', '1'); localStorage.setItem('bm_landingSeen', '1'); localStorage.setItem('bm_bottour', '1'); } catch (e) {}
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', d => d.accept());
const URL_ = APP + '?lichess&lichessApi=http://localhost:' + MOCK_PORT;
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof quickBotPick === 'function' && typeof lichessBuilderState === 'function');
await page.waitForTimeout(1200);
// A fast, Stockfish-only bot keeps the run short.
await page.evaluate(() => { quickBotPick('1200'); });
let lastBotBefore = null;   // read once connected: connecting saves the bot it hosts

const pageBoard = () => page.evaluate(() => { let s = ''; for (let i = 0; i < 64; i++) s += board[i] ? board[i].color + board[i].piece : '..'; return s; });
const lbState = () => page.evaluate(() => lbState);

console.log('\n1. Connecting');
const panelShown = p => p.evaluate(() => { const el = document.getElementById('lbPanel'); return !!el && el.style.display !== 'none'; });
// No saved token: nothing to reconnect, so no panel and no host mark.
check(!(await panelShown(page)), 'no token saved: a ?lichess page shows no Lichess panel');
check(await page.evaluate(() => !/(^|[?&])lichess(&|$)/.test(location.search)), 'and the address stops marking a host');
// Connecting starts in the Bot Builder: its green pill, between the
// quick-start bar and the first section.
const openPopup = async () => {
  await page.evaluate(() => openBotModal());
  const f = await (await page.waitForSelector('#botModalFrame')).contentFrame();
  await f.waitForFunction(() => typeof lbcOpen === 'function' && !document.getElementById('qs-lichess-row').hidden, null, { timeout: 10000 });
  await f.waitForTimeout(300);
  const at = await f.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const bar = r('.quickstart'), eng = r('#sec-engine'), el = document.getElementById('qs-lichess-btn'), p = el.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.qs-bar > *')], last = cells[cells.length - 1].getBoundingClientRect();
    return { between: p.top >= bar.bottom && p.bottom <= eng.top, lined: Math.abs(p.left - eng.left) <= 1,
      barW: Math.round(bar.width), engW: Math.round(eng.width), barL: Math.round(bar.left), engL: Math.round(eng.left),
      lastId: cells[cells.length - 1].id, lastEnd: Math.round(bar.right - last.right),
      startH: Math.round(r('.start-btn').height), colour: getComputedStyle(el).backgroundColor, text: el.textContent.trim() };
  });
  await f.click('#qs-lichess-btn');
  await f.waitForFunction(() => document.getElementById('lbc-overlay')?.classList.contains('show'), null, { timeout: 10000 });
  f.at = at;
  return f;
};
let bf = await openPopup();
const pillAt = bf.at;
check(pillAt.between && pillAt.lined && pillAt.colour === 'rgb(47, 163, 90)' && pillAt.text === 'Set up bot to play on Lichess',
  'the builder\'s green Lichess pill sits between the quick-start bar and the Engine section', pillAt);
check(pillAt.barW === pillAt.engW && pillAt.barL === pillAt.engL && pillAt.lastId === 'qs-bots-wrap' && Math.abs(pillAt.lastEnd) <= 1 &&
  pillAt.startH === 52, 'the quick-start bar is as wide as the sections, ends on My Bots, Start full height', pillAt);
const fromBoard = await bf.evaluate(() => {
  const guide = document.querySelector('#lbc-body > .lbc-guide');
  const folded = !!guide && !guide.open;
  guide.querySelector('summary').click();   // opens only when asked
  const step5 = document.querySelectorAll('.lbc-steps > li')[4];
  return { folded, opened: guide.open,
    steps: document.querySelectorAll('.lbc-steps > li').length, token: !!document.getElementById('lbc-token'),
    step5: step5?.querySelector(':scope > b')?.textContent || '', diy: !!step5?.querySelector(':scope > details.lbc-sub'),
    link: document.querySelector('.lbc-steps a[href*="oauth/token/create"]')?.getAttribute('href') || '' };
});
check(fromBoard.token && fromBoard.steps === 6, 'it opens the Play on Lichess popup, with the 6-step guide', fromBoard);
check(fromBoard.folded && fromBoard.opened, 'the guide starts folded and opens when pressed', fromBoard);
check(/^Upgrade to a bot account: paste the token below and press Connect/.test(fromBoard.step5) && fromBoard.diy,
  'step 5 is the upgrade, with the do-it-yourself commands inside it', fromBoard.step5);
check(/scopes\[\]=bot:play/.test(fromBoard.link), 'the token link pre-ticks bot:play', fromBoard.link);
await bf.evaluate(() => [...document.querySelectorAll('#lbc-btns button')].find(b => /Cancel/.test(b.textContent)).click());
await page.waitForTimeout(300);
check(await bf.evaluate(() => !document.getElementById('lbc-overlay').classList.contains('show')) &&
  await page.evaluate(() => document.getElementById('botModal').style.display !== 'none') && !(await panelShown(page)),
  'Cancel closes the popup and leaves the builder open — still no panel on the board');
await page.evaluate(() => closeBotModal());
bf = await openPopup();
await bf.fill('#lbc-token', 'lip_wrong');
await bf.click('#lbc-connect-btn');
await until(() => bf.evaluate(() => /rejected/.test(document.getElementById('lbc-status').textContent)), 5000);
check(await bf.evaluate(() => /rejected/.test(document.getElementById('lbc-status').textContent)) && !(await panelShown(page)),
  'a bad token is reported in the popup (not the board)');
await bf.fill('#lbc-token', TOKEN);
await bf.click('#lbc-connect-btn');
await until(async () => (await lbState()) === 'waiting' && M.eventStreams.size === 1, 10000, 'waiting');
check(await lbState() === 'waiting', 'connected and waiting');
check(await page.evaluate(() => document.getElementById('botModal').style.display === 'none') && await panelShown(page),
  'and back on the board, its Lichess panel showing');
// The quick pick the run uses — a fast Stockfish-only bot.
await page.evaluate(() => { quickBotPick('1200'); });
lastBotBefore = await page.evaluate(() => localStorage.getItem('bm_lastBot'));
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
check(await page.evaluate(() => lbState === 'connecting') && await panelShown(page), 'the reloaded host shows its panel at once, reconnecting');
await page.waitForTimeout(800);
await page.evaluate(() => { quickBotPick('1200'); });
await until(() => g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 90000, 'play after reload');
check(g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 'reconnected and kept playing (' + pliesAtReload + ' → ' + g4.moves.length + ' plies)');
await until(() => g4.status !== 'started', 120000, 'game 4 to finish');
await sleep(800);
check(await pageBoard() === placement(g4.bd), 'board matches the server after the reload');
check(g4.refused.length === 0, 'no move refused after the reload', g4.refused);

console.log('\n6b. Draw offers the bot must answer before it moves');
// The bot is told it is lost, so yes is always the right answer. What is
// checked is WHEN it answers: before its own move goes out, because on Lichess
// that move would decline the offer unread.
await page.evaluate(() => { window._keepAdv = botPerceivedAdvantageCp; window.botPerceivedAdvantageCp = async () => -900; });
const c5 = newChallenge({ color: 'white', opts: { drawWithMoveAtPly: 4 } });
await until(() => M.challenges[c5].gameId, 5000);
const g5 = M.games[M.challenges[c5].gameId];
await until(() => g5.status !== 'started', 90000, 'game 5 to finish');
await sleep(600);
check(g5.offered && g5.status === 'draw' && g5.draws.includes('yes'),
  'an offer that comes with the opponent\'s move: the lost bot takes it', { status: g5.status, draws: g5.draws, offered: !!g5.offered });
check(!g5.movedOverOffer, 'its move never went out over the offer', g5.movedOverOffer);

// Slow the bot down so the offer lands while it is thinking.
await page.evaluate(() => { botTimeBehavior = 'fixed'; botFixedDelayMs = 2500; });
const c6 = newChallenge({ color: 'white', opts: { drawMidThinkAtPly: 4, midThinkDelayMs: 600 } });
await until(() => M.challenges[c6].gameId, 5000);
const g6 = M.games[M.challenges[c6].gameId];
await until(() => g6.status !== 'started', 90000, 'game 6 to finish');
await sleep(600);
check(g6.offered && g6.status === 'draw' && g6.draws.includes('yes'),
  'an offer made while the bot is thinking: answered before its move', { status: g6.status, draws: g6.draws, offered: !!g6.offered });
check(!g6.movedOverOffer, 'no move went out over that offer either', g6.movedOverOffer);
await page.evaluate(() => { window.botPerceivedAdvantageCp = window._keepAdv; quickBotPick('1200'); });

console.log('\n7. Leaving no trace');
check(await page.evaluate(() => localStorage.getItem('bm_lastBot')) === lastBotBefore, 'the user\'s remembered bot is untouched');
check(M.posts.filter(p => p.includes('/move/')).every(p => /\/move\/[a-h][1-8][a-h][1-8][qrbn]?$/.test(p)), 'every move post is plain UCI');
// This bot does not offer draws: any yes it sent was an answer to an open offer.
check(Object.values(M.games).every(g => !g.drawOffersByBot), 'the bot never offered a draw of its own',
  Object.values(M.games).map(g => g.drawOffersByBot || 0));
await page.click('#lbDisconnect');
await until(() => M.eventStreams.size === 0, 5000);
check(M.eventStreams.size === 0 && await lbState() === 'off', 'disconnect closes the event stream');
check(!(await panelShown(page)), 'and the board\'s Lichess panel goes away');
// The token is forgotten in the builder's popup now.
bf = await openPopup();
const forgot = await bf.evaluate(() => {
  [...document.querySelectorAll('#lbc-body .lbc-link')].find(b => /Forget/.test(b.textContent)).click();
  return !!document.getElementById('lbc-token');
});
check(!(await page.evaluate(() => localStorage.getItem('bm_lichessBot') || '')).includes(TOKEN) && forgot,
  'the popup\'s Forget it clears the token from storage and asks for one again');
await bf.evaluate(() => lbcClose());
await page.evaluate(() => closeBotModal());
check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 5));

// ── 8. Connecting from the Bot Builder ──────────────────────────────────────
// A fresh browser (no token, no bot) on an ordinary page: the builder's
// Lichess pill opens the popup, which checks the token, upgrades a fresh
// account, hands the bot over, and lands on the board, connected.
console.log('\n8. Connecting from the Bot Builder');
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx2.addInitScript(() => {
  try { localStorage.setItem('bm_welcomed', '1'); localStorage.setItem('bm_landingSeen', '1'); localStorage.setItem('bm_bottour', '1'); } catch (e) {}
});
const p2 = await ctx2.newPage();
const errs2 = [];
p2.on('pageerror', e => errs2.push(e.message));
p2.on('dialog', d => d.accept());
await p2.goto(APP + '?lichessApi=http://localhost:' + MOCK_PORT, { waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => typeof openBotModal === 'function' && typeof lichessBuilderState === 'function');
await p2.waitForTimeout(800);
check(!(await p2.evaluate(() => document.getElementById('lbPanel'))), 'an ordinary page has no Lichess panel and does not connect');
await p2.evaluate(() => openBotModal());
const fr = await (await p2.waitForSelector('#botModalFrame')).contentFrame();
await fr.waitForFunction(() => typeof lbcOpen === 'function' && typeof getBotConfig === 'function');
await fr.waitForTimeout(400);
// A fast Flounder bot, so no model download is needed.
await fr.evaluate(() => { selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]')); setElo(1200); });
const pill = await fr.evaluate(() => ({ shown: document.getElementById('qs-lichess-btn').offsetParent !== null,
  text: document.getElementById('qs-lichess-value').textContent, start: document.querySelector('.start-btn').textContent }));
check(pill.shown && /Set up bot to play on Lichess/.test(pill.text) && /Start/.test(pill.start), 'the builder shows a Lichess pill; Start is Start', pill);
await fr.click('#qs-lichess-btn');
const pop = await fr.evaluate(() => ({ open: document.getElementById('lbc-overlay').classList.contains('show'),
  sum: document.querySelector('.lbc-sum')?.textContent || '', token: !!document.getElementById('lbc-token'),
  casual: document.getElementById('lbc-casual')?.checked, rated: document.getElementById('lbc-rated')?.checked }));
check(pop.open && /Flounder/.test(pop.sum) && /Conviction/.test(pop.sum) && /Draws/.test(pop.sum), 'the popup summarises the bot', pop.sum.slice(0, 120));
check(pop.token && pop.casual === true && pop.rated === false, 'it asks for a token; casual on, rated off by default', pop);
// The summary: CP Budget, not Hard Floor; and under clock-driven timing,
// whether the time-pressure curves are on.
const tpRows = await fr.evaluate(() => {
  const sum = () => document.querySelector('.lbc-sum').textContent;
  const reopen = () => { lbcClose(); lbcOpen(); };
  const out = { fixed: sum() };
  document.querySelector('#timing-mode-grid .mcard[data-v="Complexity-scaled"]').click();
  reopen(); out.both = sum();
  const a = document.getElementById('pressure-off-a'), b = document.getElementById('pressure-off-b');
  a.checked = false; a.onchange && a.onchange();
  reopen(); out.bOnly = sum();
  b.checked = false; b.onchange && b.onchange();
  reopen(); out.none = sum();
  a.checked = true; a.onchange && a.onchange();
  b.checked = true; b.onchange && b.onchange();
  document.querySelector('#timing-mode-grid .mcard[data-v="Fixed interval"]').click();
  reopen();
  return out;
});
check(/CP Budget/.test(tpRows.fixed) && !/Hard Floor/.test(tpRows.fixed) && !/Time pressure/.test(tpRows.fixed),
  'the summary shows CP Budget (no Hard Floor), and no time-pressure line on a fixed pace', tpRows.fixed.slice(0, 160));
check(/Time pressure\s*on.*rating drops, choices widen/.test(tpRows.both) && /Time pressure\s*on.*\(choices widen\)/.test(tpRows.bOnly)
  && /Time pressure\s*off/.test(tpRows.none), 'complexity timing: the time-pressure line says on (and which) or off',
  { both: tpRows.both.slice(-120), bOnly: tpRows.bOnly.slice(-120), none: tpRows.none.slice(-120) });

await fr.fill('#lbc-token', 'lip_wrong');
await fr.click('#lbc-connect-btn');
await until(() => fr.evaluate(() => /rejected/.test(document.getElementById('lbc-status').textContent)), 5000);
check(await fr.evaluate(() => /rejected/.test(document.getElementById('lbc-status').textContent)), 'a bad token is reported in the popup');

await fr.fill('#lbc-token', PLAYED);
await fr.click('#lbc-connect-btn');
await until(() => fr.evaluate(() => /played 12 games/.test(document.getElementById('lbc-body').textContent)), 5000);
check(await fr.evaluate(() => /played 12 games/.test(document.getElementById('lbc-body').textContent) && !document.getElementById('lbc-upgrade-btn')),
  'an account that has played games: told why it cannot be upgraded, no upgrade button');
await fr.evaluate(() => document.querySelector('#lbc-btns button').click());   // Back

await fr.fill('#lbc-token', FRESH);
await fr.click('#lbc-connect-btn');
await until(() => fr.evaluate(() => !!document.getElementById('lbc-upgrade-btn')), 5000);
const up = await fr.evaluate(() => ({ disabled: document.getElementById('lbc-upgrade-btn').disabled,
  text: document.getElementById('lbc-body').textContent }));
check(up.disabled && /permanent/.test(up.text) && /never played/.test(up.text), 'a fresh account: the upgrade is explained and needs a tick first', up.text.slice(0, 80));
check(!M.freshUpgraded, 'nothing is upgraded before the tick and the click');
await fr.check('#lbc-understand');
await fr.click('#lbc-upgrade-btn');
await until(() => p2.evaluate(() => lbState === 'waiting'), 10000, 'connected from the builder');
const after = await p2.evaluate(() => ({ state: lbState, modal: document.getElementById('botModal').style.display,
  url: location.search, panel: !!document.getElementById('lbPanel') && document.getElementById('lbPanel').style.display !== 'none', applied: window._lastAppliedBotConfig && window._lastAppliedBotConfig.elo,
  saved: (JSON.parse(localStorage.getItem('bm_lastBot') || 'null') || {}).cfg?.elo }));
check(M.freshUpgraded, 'the account was upgraded');
check(after.state === 'waiting' && after.modal === 'none' && after.panel, 'connected, the builder closed, the board and its Lichess panel showing', after);
check(/(^|[?&])lichess(&|$)/.test(after.url), 'the address marks the tab as the host (a reload reconnects it)', after.url);
check(after.applied === 1200 && after.saved === 1200, 'the builder\'s bot is the page\'s bot, and remembered', after);

// Back in the builder: it knows, and Start now updates the Lichess bot.
await p2.evaluate(() => openBotModal());
await fr.waitForTimeout(500);
const conn = await fr.evaluate(() => ({ text: document.getElementById('qs-lichess-value').textContent,
  start: document.querySelector('.start-btn').textContent }));
check(/@BMTestBot/.test(conn.text) && /Update Lichess bot/.test(conn.start), 'the builder shows the connection; Start reads Update Lichess bot', conn);

// An update mid-game plays from the next game.
const c8 = newChallenge({ color: 'white', opts: { resignAtPly: 10 } });
await until(() => M.challenges[c8].gameId, 5000);
const g8 = M.games[M.challenges[c8].gameId];
await until(() => g8.moves.length >= 2, 30000, 'game under way');
await fr.evaluate(() => { setElo(1500); startGame(); });
await p2.waitForTimeout(400);
const mid = await p2.evaluate(() => ({ next: lichessBuilderState().nextPending, applied: window._lastAppliedBotConfig.elo,
  plays: document.getElementById('lbBot').textContent, modal: document.getElementById('botModal').style.display }));
check(mid.next && mid.applied === 1200 && /next game/.test(mid.plays) && mid.modal === 'none',
  'an update during a game waits for the next one (the board says so)', mid);
await until(() => g8.status !== 'started', 90000, 'game 8 to finish');
const c9 = newChallenge({ color: 'black', opts: { resignAtPly: 4 } });
await until(() => M.challenges[c9].gameId, 5000);
await until(() => p2.evaluate(() => window._lastAppliedBotConfig.elo === 1500), 10000);
check(await p2.evaluate(() => window._lastAppliedBotConfig.elo === 1500 && !lichessBuilderState().nextPending),
  'the next game plays with the update');
await until(() => M.games[M.challenges[c9].gameId].status !== 'started', 90000, 'game 9 to finish');

// Disconnect from the builder's popup.
await p2.evaluate(() => openBotModal());
await fr.waitForTimeout(400);
await fr.click('#qs-lichess-btn');
check(await fr.evaluate(() => /connected/i.test(document.getElementById('lbc-title').textContent)), 'connected, the pill opens a status popup');
await fr.evaluate(() => [...document.querySelectorAll('#lbc-btns button')].find(b => /Disconnect/.test(b.textContent)).click());
await until(() => p2.evaluate(() => lbState === 'off'), 5000);
const off = await p2.evaluate(() => ({ state: lbState, url: location.search }));
await fr.waitForTimeout(300);
const offB = await fr.evaluate(() => ({ text: document.getElementById('qs-lichess-value').textContent, start: document.querySelector('.start-btn').textContent }));
check(off.state === 'off' && !/(^|[?&])lichess(&|$)/.test(off.url) && !(await panelShown(p2)),
  'disconnected; the address no longer marks a host, and the board\'s panel is gone', off);
check(/Set up bot to play on Lichess/.test(offB.text) && /Start/.test(offB.start) && !/Update/.test(offB.start), 'the builder is back to Start', offB);
check(errs2.length === 0, 'no page errors (builder flow)', errs2.slice(0, 5));

// ── 9. A host tab that can't reconnect ──────────────────────────────────────
// The panel shows why, offers Connect… (the builder's popup) and Close, and
// Close leaves an ordinary tab.
console.log('\n9. A host tab that cannot reconnect');
const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx3.addInitScript(() => {
  try {
    localStorage.setItem('bm_welcomed', '1'); localStorage.setItem('bm_landingSeen', '1'); localStorage.setItem('bm_bottour', '1');
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('bm_lichessBot', JSON.stringify({ token: 'lip_revoked', auto: true }));
      sessionStorage.setItem('seeded', '1');
    }
  } catch (e) {}
});
const p3 = await ctx3.newPage();
const errs3 = [];
p3.on('pageerror', e => errs3.push(e.message));
await p3.goto(URL_, { waitUntil: 'domcontentloaded' });
await until(() => p3.evaluate(() => lbState === 'error'), 10000, 'the refused reconnect');
const failed = await p3.evaluate(() => ({ shown: document.getElementById('lbPanel').style.display !== 'none',
  status: document.getElementById('lbStatus').textContent,
  connect: document.getElementById('lbConnect').style.display !== 'none', close: document.getElementById('lbClose').style.display !== 'none' }));
check(failed.shown && /rejected/.test(failed.status) && failed.connect && failed.close,
  'the panel says why, with Connect… and Close', failed);
await p3.click('#lbClose');
check(!(await panelShown(p3)) && await p3.evaluate(() => !/(^|[?&])lichess(&|$)/.test(location.search)),
  'Close puts it away, and the tab is an ordinary one');
check(errs3.length === 0, 'no page errors (failed reconnect)', errs3.slice(0, 5));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

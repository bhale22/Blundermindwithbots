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
// The core's rules are global (standard or Chess960, and which rooks castle):
// set them for a game before working on its position.
function useRules(g) {
  core.setChess960(!!g.chess960);
  if (g.chess960) core.parseFen(g.startFen);
}

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
  // A Chess960 challenge is dealt its position here, as Lichess does.
  const is960 = ch.c.variant && ch.c.variant.key === 'chess960';
  const startFen = is960 ? core.chess960StartFen(ch.opts.sp != null ? ch.opts.sp : Math.floor(Math.random() * 960)) : START;
  useRules({ chess960: is960, startFen });
  const bd = core.parseFen(startFen);
  const botWhite = ch.c.color === 'black' ? true : ch.c.color === 'white' ? false : Math.random() < 0.5;
  const tc = ch.c.timeControl;
  const g = {
    id, botWhite, rated: ch.c.rated, speed: ch.c.speed, opts: ch.opts, opp: ch.c.challenger || HUMAN,
    clock: { initial: tc.limit * 1000, increment: tc.increment * 1000 },
    wtime: tc.limit * 1000, btime: tc.limit * 1000, lastAt: Date.now(),
    bd, turn: 'w', cst: { wK: true, wQ: true, bK: true, bQ: true }, ep: -1,
    chess960: is960, startFen, castles: [],
    moves: [], status: 'started', winner: null,
    wdraw: false, bdraw: false, wtakeback: false, btakeback: false,
    streams: new Set(), oppBusy: false, rejected: false, dropped: false,
    botPosts: [], refused: [], draws: [], takebacks: 0, claims: 0, drawOffersByBot: 0,
    tbAnswers: [], tbTaken: 0, tbAsked: 0,   // takeback answers ('yes'/'no'), ones carried out, requests made
    chat: [], spect: [], chatPosts: 0,   // chat: the player room; spect: the spectator room
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
  return { type: 'gameFull', id: g.id, variant: { key: g.chess960 ? 'chess960' : 'standard' }, speed: g.speed, rated: g.rated,
    white: g.botWhite ? BOT : g.opp, black: g.botWhite ? g.opp : BOT,
    initialFen: g.chess960 ? g.startFen : 'startpos', clock: g.clock, state: state(g) };
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
  useRules(g);
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
  if (core.isCastleMove(g.bd, from, to)) g.castles.push(g.turn + ':' + uci);
  g.cst = core.updateCastling(from, to, p, g.cst);
  g.bd = core.applyMove(from, to, g.bd, g.ep, uci[4] ? uci[4].toUpperCase() : 'Q');
  g.ep = ne;
  g.turn = g.turn === 'w' ? 'b' : 'w';
  g.moves.push(uci);
  g.wdraw = g.bdraw = false;
  g.wtakeback = g.btakeback = false;   // on Lichess a move clears a takeback request too
  const next = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
  if (!next.length) {
    if (core.inCheck(g.bd, g.turn)) { g.status = 'mate'; g.winner = g.turn === 'w' ? 'black' : 'white'; }
    else g.status = 'stalemate';
  }
  return true;
}

// Take moves back: the position again from the start through `keep`. The
// clocks are left as they are, as on Lichess.
function rebuildTo(g, keep) {
  const wt = g.wtime, bt = g.btime, last = g.lastAt;
  useRules(g);
  g.bd = core.parseFen(g.startFen || START); g.turn = 'w'; g.cst = { ...core.castling }; g.ep = -1; g.moves = [];
  for (const u of keep) {
    const from = sqOf(u.slice(0, 2)), to = sqOf(u.slice(2, 4)), p = g.bd[from];
    const ne = core.computeEP(from, to, g.bd);
    g.cst = core.updateCastling(from, to, p, g.cst);
    g.bd = core.applyMove(from, to, g.bd, g.ep, u[4] ? u[4].toUpperCase() : 'Q');
    g.ep = ne; g.turn = g.turn === 'w' ? 'b' : 'w'; g.moves.push(u);
  }
  g.wtime = wt; g.btime = bt; g.lastAt = last;
}

// Would the side to move, playing `mv`, leave the other side a mate in one?
function allowsMateInOne(g, mv) {
  const me = g.turn, them = me === 'w' ? 'b' : 'w';
  const p = g.bd[mv.from];
  const bd = core.applyMove(mv.from, mv.to, g.bd, g.ep, 'Q');
  const ep = core.computeEP(mv.from, mv.to, g.bd), cst = core.updateCastling(mv.from, mv.to, p, g.cst);
  for (const r of core.allLegalMoves(bd, them, ep, cst)) {
    const rp = bd[r.from];
    const bd2 = core.applyMove(r.from, r.to, bd, ep, 'Q');
    if (core.inCheck(bd2, me) && !core.allLegalMoves(bd2, me, core.computeEP(r.from, r.to, bd), core.updateCastling(r.from, r.to, rp, cst)).length) return true;
  }
  return false;
}

// A move for the bot's side made by someone else: the bot account playing in
// another browser. Returns the move, or null.
function playForBot(g) {
  if (g.status !== 'started' || g.turn !== botLetter(g)) return null;
  useRules(g);
  const all = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
  if (!all.length) return null;
  const mv = all[Math.floor(Math.random() * all.length)];
  const p = g.bd[mv.from];
  const uci = nameOf(mv.from) + nameOf(mv.to) + (p.piece === 'P' && (mv.to < 8 || mv.to >= 56) ? 'q' : '');
  play(g, uci);
  return uci;
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
      if (o.takebackAtPly != null && ply === o.takebackAtPly && g.tbAsked < (o.takebackTimes || 1)) {
        g.tbAsked++;
        if (oc === 'w') g.wtakeback = true; else g.btakeback = true;
        broadcast(g);
        await sleep(o.takebackWaitMs || 600);
        g.wtakeback = g.btakeback = false;
        if (g.status !== 'started' || g.turn === botLetter(g)) return;
      }
      useRules(g);
      const all = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
      if (!all.length) return;
      // A game kept open for chat checks: never a move that allows mate in one.
      const safe = o.avoidMateInOne ? all.filter(m => !allowsMateInOne(g, m)) : all;
      // A Chess960 game: castle whenever it can, to put castles through the bridge.
      const castles = o.preferCastle ? safe.filter(m => core.isCastleMove(g.bd, m.from, m.to)) : [];
      const pool = castles.length ? castles : safe.length ? safe : all;
      const mv = pool[Math.floor(Math.random() * pool.length)];
      const p = g.bd[mv.from];
      const promo = p.piece === 'P' && (mv.to < 8 || mv.to >= 56) ? 'q' : '';
      play(g, nameOf(mv.from) + nameOf(mv.to) + promo);
      // An offer that travels with the move: the same gameState carries both.
      if (o.drawWithMoveAtPly != null && ply === o.drawWithMoveAtPly) {
        if (oc === 'w') g.wdraw = true; else g.bdraw = true;
        g.offered = true;
      }
      broadcast(g);
      // The bot's move played elsewhere while the bot is thinking about it.
      if (o.playForBotAtPly != null && g.moves.length >= o.playForBotAtPly && !g.playedForBot) {
        const at = g.moves.length;
        await sleep(o.playForBotDelayMs || 300);
        if (g.moves.length === at && (g.playedForBot = playForBot(g))) {
          g.playedForBotPly = at;
          broadcast(g);
          setTimeout(() => opponentTurn(g), 0);   // after this turn's finally
        }
      }
      // A takeback asked just after moving, while the bot is thinking: on
      // Lichess that takes back the opponent's own move only.
      if (o.takebackMidThinkAt != null && g.moves.length === o.takebackMidThinkAt && !g.tbMidAsked) {
        g.tbMidAsked = true;
        await sleep(o.midThinkDelayMs || 400);
        if (g.status === 'started' && g.turn === botLetter(g)) {
          g.tbAsked++;
          if (oc === 'w') g.wtakeback = true; else g.btakeback = true;
          broadcast(g);
          await sleep(1500);
          g.wtakeback = g.btakeback = false;
        }
      }
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

// A line in the game chat, as the game stream delivers it.
function chatLine(g, username, text, room) {
  for (const r of g.streams) line(r, { type: 'chatLine', room: room || 'player', username, text });
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
      // The race: another move was played for the bot elsewhere just before
      // this one reached the server. The bot has already played its own on its
      // board. raceRefuseFirst: the refusal reaches the bot before the state.
      if (g.opts.raceForBotAtPly != null && g.moves.length >= g.opts.raceForBotAtPly && !g.raced) {
        g.raced = playForBot(g);
        g.racedPly = g.moves.length - 1;
        g.refused.push(uci);
        if (g.opts.raceRefuseFirst) {
          g.refusedAt = Date.now();
          json(res, 400, { error: 'Not your turn, or game already over' });
          setTimeout(() => { broadcast(g); opponentTurn(g); }, 150);
        } else {
          broadcast(g);
          opponentTurn(g);
          setTimeout(() => json(res, 400, { error: 'Not your turn, or game already over' }), 60);
        }
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
    if (act === 'chat') {
      const b = new URLSearchParams(await readBody(req));
      g.chatPosts++;
      if (M.chat429) { json(res, 429, { error: 'Too many requests' }); return; }
      (b.get('room') === 'spectator' ? g.spect : g.chat).push({ room: b.get('room'), text: b.get('text') });
      json(res, 200, { ok: true });
      // Like Lichess: the bot's own line comes back down its game stream.
      chatLine(g, BOT.name, b.get('text'), b.get('room'));
      return;
    }
    if (act === 'takeback/no') { g.takebacks++; g.tbAnswers.push('no'); g.wtakeback = g.btakeback = false; json(res, 200, { ok: true }); broadcast(g); return; }
    if (act === 'takeback/yes') {
      g.tbAnswers.push('yes');
      const oc = g.botWhite ? 'b' : 'w';
      if (g.status !== 'started' || !(oc === 'w' ? g.wtakeback : g.btakeback)) { json(res, 400, { error: 'No takeback request' }); return; }
      // Lichess: the requester's last move, and the reply to it if there is one.
      const k = g.turn === oc ? 2 : 1;
      rebuildTo(g, g.moves.slice(0, Math.max(0, g.moves.length - k)));
      g.wtakeback = g.btakeback = false;
      g.tbTaken++;
      json(res, 200, { ok: true });
      broadcast(g);
      // The opponent is on move again: it moves once its current turn is done.
      const nudge = () => { if (g.oppBusy) setTimeout(nudge, 100); else opponentTurn(g); };
      setTimeout(nudge, 0);
      return;
    }
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
// Accepted, but kept: a headless host (bot-runner) has nobody to answer one.
const dialogs = [];
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
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
  await f.waitForFunction(() => typeof lbcOpen === 'function' && !document.getElementById('qs-lichess-btn').hidden, null, { timeout: 10000 });
  await f.waitForTimeout(300);
  const at = await f.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const bar = r('.quickstart'), eng = r('#sec-engine'), el = document.getElementById('qs-lichess-btn'), p = el.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.qs-bar > *')], last = cells[cells.length - 1].getBoundingClientRect();
    // The row of green pills starts at the sections' edge; Preset Personalities comes first.
    return { between: p.top >= bar.bottom && p.bottom <= eng.top, lined: Math.abs(r('#qs-presets-btn').left - eng.left) <= 1,
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
const layout = await bf.evaluate(() => {
  const body = document.getElementById('lbc-body');
  const guide = body.querySelector(':scope > .lbc-guide'), token = document.getElementById('lbc-token');
  const help = document.getElementById('lbc-match-help'), btn = document.getElementById('lbc-match-help-btn');
  const out = { after: !!(guide && token && (guide.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING)),
    label: document.querySelector('label[for="lbc-token"]')?.textContent || '',
    helpHidden: !!help && help.hidden && help.offsetHeight === 0, btn: btn?.textContent,
    strength: !!document.getElementById('lbc-strength') && /Measured strength/.test(document.querySelector('label[for="lbc-strength"]')?.textContent || '') };
  btn.click();
  out.helpShown = !help.hidden && help.offsetHeight > 0 && btn.getAttribute('aria-expanded') === 'true' &&
    /plus the offset/.test(help.textContent) && /ELO1500/.test(help.textContent) && /ELO1500 cp100/.test(help.textContent) && /Measured strength/.test(help.textContent);
  btn.click();
  out.helpFolds = help.hidden;
  // The smallest type in the popup's text, and its body text.
  const sizes = [...document.querySelectorAll('#lbc-box *')]
    .filter(n => n.childNodes.length && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && n.offsetParent)
    .map(n => parseFloat(getComputedStyle(n).fontSize));
  out.minFont = Math.min(...sizes);
  out.bodyFont = parseFloat(getComputedStyle(body).fontSize);
  return out;
});
check(layout.after && /token/i.test(layout.label), 'the token box comes after the steps that end in it, with a label', layout);
check(layout.btn === '?' && layout.helpHidden && layout.helpShown && layout.helpFolds,
  'matching\'s explanation is behind a "?": folded, opens and folds again', layout);
check(layout.strength, 'the Measured strength field, with its label', layout);
check(layout.minFont >= 12 && layout.bodyFont >= 15, 'type no smaller than 12px, body text 15px (' + layout.minFont + ', ' + layout.bodyFont + ')', layout);
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
// Casual-only is not a setting: one saved before it (rated on, casual off)
// is dropped on load, and a rated challenge is declined whatever is set.
const oldSet = await page.evaluate(() => {
  const raw = localStorage.getItem('bm_lichessBot');
  localStorage.setItem('bm_lichessBot', JSON.stringify(Object.assign(JSON.parse(raw), { rated: true, casual: false })));
  const s = _lbLoadSettings();
  localStorage.setItem('bm_lichessBot', raw);
  lbSettings.rated = true;
  return { rated: 'rated' in s, casual: 'casual' in s };
});
check(!oldSet.rated && !oldSet.casual, 'an old saved rated/casual setting is dropped on load', oldSet);
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
// Engines still loading: Lichess hears "later", and the panel and log say why.
// Pretending keeps the real engine alive, so the rest of the run needs no reload.
const lbStatusText = () => page.textContent('#lbStatus');
await page.evaluate(() => { window._keepWarm = _lbWarmEngines; _lbWarmEngines = () => {}; sfReady = false; lbRender(); });
check(/challenges are declined until they are ready/.test(await lbStatusText()), 'while the engines load, the panel says challenges are declined', await lbStatusText());
const whileLoading = newChallenge({});
await until(() => M.challenges[whileLoading].declined, 5000);
check(M.challenges[whileLoading].declined === 'later', 'a challenge then is declined "later"', M.challenges[whileLoading].declined);
const loadingLog = await page.evaluate(() => lbLogLines[lbLogLines.length - 1]);
check(/: engines still loading$/.test(loadingLog), 'and the log says the engines are loading, not that the bot is busy', loadingLog);
await page.evaluate(() => { _lbWarmEngines = window._keepWarm; sfReady = true; });
await until(async () => /^Waiting for challenges/.test(await lbStatusText()), 3000);
check(/^Waiting for challenges/.test(await lbStatusText()), 'when they finish, the panel updates by itself', await lbStatusText());

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
check(g1.tbTaken === 1 && g1.tbAnswers.join() === 'yes', 'takeback request accepted (every one, the default)', g1.tbAnswers);
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
check(await page.evaluate(() => !localStorage.getItem('bm_liveGame')), 'a Lichess game writes no resume-a-local-game snapshot');
const dialogsAtReload = dialogs.length;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof quickBotPick === 'function');
check(await page.evaluate(() => lbState === 'connecting') && await panelShown(page), 'the reloaded host shows its panel at once, reconnecting');
await page.waitForTimeout(800);
await page.evaluate(() => { quickBotPick('1200'); });
await until(() => g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 90000, 'play after reload');
check(g4.moves.length >= pliesAtReload + 4 || g4.status !== 'started', 'reconnected and kept playing (' + pliesAtReload + ' → ' + g4.moves.length + ' plies)');
check(dialogs.length === dialogsAtReload, 'and reconnecting asked nothing (no "forfeit your bot game?")', dialogs.slice(dialogsAtReload));
await until(() => g4.status !== 'started', 120000, 'game 4 to finish');
await sleep(800);
check(await pageBoard() === placement(g4.bd), 'board matches the server after the reload');
check(g4.refused.length === 0, 'no move refused after the reload', g4.refused);

console.log('\n6c. Chess960: accepted only when ticked; Lichess\'s position, castles both ways');
{
  // Off (the default), section 2 saw it declined as a variant. Ticked:
  await page.evaluate(() => lichessSetOpt('chess960', true));
  check(/Chess960 too/.test(await page.textContent('#lbRules')), 'the panel\'s accept rules name Chess960', await page.textContent('#lbRules'));
  // Position 3, BQNNRKRB: king f1, rook g1, so O-O is legal at once and is the
  // king and rook trading squares (f1g1: king takes rook). The opponent castles
  // whenever it can.
  const c = newChallenge({ variant: 'chess960', color: 'white', opts: { sp: 3, preferCastle: true, resignAtPly: 24 } });
  await until(() => M.challenges[c].gameId || M.challenges[c].declined, 5000);
  check(!!M.challenges[c].gameId, 'a Chess960 challenge is accepted once ticked', M.challenges[c].declined);
  const g = M.games[M.challenges[c].gameId];
  await until(() => g && g.moves.length >= 2, 30000, 'two plies');
  const p960 = await page.evaluate(() => ({ on: chess960, start: _gameStartFen, tag: (document.getElementById('variantTag') || {}).textContent }));
  check(p960.on && p960.start === g.startFen, 'the page plays Chess960 from Lichess\'s position', p960);
  check(p960.tag === 'Chess960 · #3', 'and names it on the board', p960.tag);
  check(g.castles[0] === 'w:f1g1', 'the opponent castled at once, king takes rook (f1g1)', g.castles);
  await until(() => g.status !== 'started', 180000, 'the Chess960 game to finish');
  await sleep(800);
  check(await pageBoard() === placement(g.bd), 'board matches the server at the end (' + g.moves.length + ' plies, castles ' + g.castles.join(' ') + ')');
  check(g.refused.length === 0, 'no move of the bot\'s refused', g.refused);
  const pgn = await page.evaluate(() => buildPgnText().pgn);
  check(/\[Variant "Chess960"\]/.test(pgn) && pgn.includes('[FEN "' + g.startFen + '"]'), 'its PGN says Chess960 and gives the start', pgn.slice(0, 300));
  check(/\bO-O\b/.test(pgn), 'the castle reads O-O in the PGN', pgn.split('\n\n')[1]);
  await page.evaluate(() => lichessSetOpt('chess960', false));
  await until(async () => (await lbState()) === 'waiting', 5000);
  // The next game is standard again: section 6t's games check the board against the server.
}

console.log('\n6t. Takebacks: the builder\'s limit answers the opponent');
{
  const tbLog = id => page.evaluate(id => { const i = lbLogLines.findIndex(l => l.includes(id)); return i < 0 ? [] : lbLogLines.slice(i); }, id);
  const keep = await page.evaluate(() => ({ tb: botTimeBehavior, ms: botFixedDelayMs, limit: botTakebackLimit }));
  const playTb = async (limit, opts, fixedMs) => {
    await page.evaluate(([l, ms]) => { botTakebackLimit = l; if (ms) { botTimeBehavior = 'fixed'; botFixedDelayMs = ms; } }, [limit, fixedMs || 0]);
    const c = newChallenge({ color: 'white', opts });
    await until(() => M.challenges[c].gameId, 5000);
    const g = M.games[M.challenges[c].gameId];
    await until(() => g.status !== 'started', 180000, 'takeback game to finish');
    await sleep(800);
    return g;
  };

  // Every one: after the bot's reply (two plies), and twice; then while it thinks (one ply).
  const ta = await playTb(-1, { takebackAtPly: 4, takebackTimes: 2, takebackMidThinkAt: 9, midThinkDelayMs: 500, resignAtPly: 16 }, 2500);
  const la = await tbLog(ta.id);
  check(ta.tbTaken === 3 && ta.tbAnswers.every(a => a === 'yes'), 'every one: all three requests accepted', ta.tbAnswers);
  check(la.filter(l => /Took back 2 moves/.test(l)).length === 2 && la.some(l => /Took back 1 move$/.test(l)),
    'two plies after the bot\'s reply, one while it was thinking', la.filter(l => /Took back|Takeback/.test(l)));
  check(ta.refused.length === 0 && !la.some(l => /rebuilding/.test(l)), 'no move refused, no rebuild: the board rewound in place',
    { refused: ta.refused, log: la.filter(l => /rebuild|refused/i.test(l)) });
  check(await pageBoard() === placement(ta.bd), 'board matches the server at the end (' + ta.moves.length + ' plies)');

  // A limit of 1: the second request is declined, and the bot says why, once.
  const tl = await playTb(1, { takebackAtPly: 4, takebackTimes: 2, takebackMidThinkAt: 7, midThinkDelayMs: 500, resignAtPly: 12 });
  const ll = await tbLog(tl.id);
  check(tl.tbAnswers.join() === 'yes,no,no' && tl.tbTaken === 1, 'limit 1: the first accepted, the rest declined', tl.tbAnswers);
  check(tl.chat.filter(c => /No more takebacks this game: I allow 1\./.test(c.text)).length === 1,
    'and the chat says so once', tl.chat.map(c => c.text));
  check(ll.some(l => /Takeback request declined \(all 1 used\)/.test(l)), 'the log says why', ll.filter(l => /Takeback/.test(l)));
  check(await pageBoard() === placement(tl.bd), 'board matches the server');

  // Never.
  const tn = await playTb(0, { takebackAtPly: 4, resignAtPly: 10 });
  check(tn.tbAnswers.join() === 'no' && tn.tbTaken === 0, 'never: declined', tn.tbAnswers);
  check(tn.chat.some(c => /I don’t take moves back/.test(c.text)), 'with a word in the chat', tn.chat.map(c => c.text));
  await page.evaluate(k => { botTimeBehavior = k.tb; botFixedDelayMs = k.ms; botTakebackLimit = k.limit; }, keep);
}

console.log('\n6a. A move played for the bot elsewhere, and the race with its own (resync)');
// Counted on the page: whole-game rebuilds, and for each replay of the server's
// moves the sounds it played and the times it drew the board.
await page.evaluate(() => {
  const rb = window._rb = { begins: [], replays: [], sounds: 0, draws: 0 };
  const wrap = (name, before) => { const f = window[name]; window[name] = function () { before(arguments); return f.apply(this, arguments); }; };
  wrap('playMoveSound', () => { rb.sounds++; });
  wrap('render', () => { rb.draws++; });
  if (typeof indApply === 'function') wrap('indApply', () => { rb.draws++; });
  wrap('_lbBeginLocalGame', a => { rb.begins.push({ at: Date.now(), id: a[0] && a[0].id, moves: a[1].length }); });
  const replay = _lbReplay;
  window._lbReplay = function (g, moves) {
    const s0 = rb.sounds, d0 = rb.draws;
    const r = replay.apply(this, arguments);
    rb.replays.push({ id: g.id, moves: moves.length, sounds: rb.sounds - s0, draws: rb.draws - d0 });
    return r;
  };
  window._rbKeep = { tb: botTimeBehavior, ms: botFixedDelayMs, pm: botPremoveEnabled };
});
const rbOf = id => page.evaluate(id => ({ begins: _rb.begins.filter(b => b.id === id), replays: _rb.replays.filter(r => r.id === id) }), id);
const logOf = id => page.evaluate(id => { const i = lbLogLines.findIndex(l => l.includes(id)); return i < 0 ? [] : lbLogLines.slice(i); }, id);
const pace = (ms, premove) => page.evaluate(([ms, premove]) => { botTimeBehavior = 'fixed'; botFixedDelayMs = ms; botPremoveEnabled = premove; }, [ms, premove]);

// The tester's case: thinking 3 s a move, the bot has its move played for it
// from another browser 0.4 s into its think.
await pace(3000, false);
const cElse = newChallenge({ color: 'white', opts: { playForBotAtPly: 5, playForBotDelayMs: 400, resignAtPly: 14 } });
await until(() => M.challenges[cElse].gameId, 5000);
const gElse = M.games[M.challenges[cElse].gameId];
await until(() => gElse.status !== 'started', 120000, 'game 6a to finish');
await sleep(800);
const rbElse = await rbOf(gElse.id), logElse = await logOf(gElse.id);
check(!!gElse.playedForBot, 'the stand-in played ' + gElse.playedForBot + ' for the bot, mid-think');
check(logElse.some(l => l.includes(' played for the bot elsewhere')), 'the host took it as the bot\'s move, and says so',
  logElse.filter(l => /elsewhere|rebuild|refused/i.test(l)));
check(rbElse.begins.length === 1 && !logElse.some(l => /rebuilding/.test(l)), 'with no rebuild (the game was set up once)', rbElse.begins);
check(gElse.refused.length === 0, 'the bot stopped thinking: it sent nothing for that turn, so nothing was refused', gElse.refused);
check(gElse.moves.length > gElse.playedForBotPly + 2 && gElse.botPosts.length >= 2, 'and played on after it', { plies: gElse.moves.length, posts: gElse.botPosts });
check(await pageBoard() === placement(gElse.bd), 'board matches the server');

// The race, state first: the bot has played and sent its own move when the
// server's arrives. One rebuild, silent, and the refusal adds nothing to it.
await pace(300, false);
const cRace = newChallenge({ color: 'white', opts: { raceForBotAtPly: 5, resignAtPly: 14 } });
await until(() => M.challenges[cRace].gameId, 5000);
const gRace = M.games[M.challenges[cRace].gameId];
await until(() => gRace.status !== 'started', 120000, 'game 6a race to finish');
await sleep(800);
const rbRace = await rbOf(gRace.id), logRace = await logOf(gRace.id);
const reRace = rbRace.replays[rbRace.replays.length - 1] || {};
check(!!gRace.raced, 'the stand-in played ' + gRace.raced + ' for the bot just before its own move arrived');
check(rbRace.begins.length === 2, 'one rebuild (after the setup), not two', rbRace.begins);
check(logRace.some(l => /refused .*the board already follows the server/.test(l)) && !logRace.some(l => /resyncing/.test(l)),
  'the refusal needed no resync of its own', logRace.filter(l => /rebuild|refused|resync/i.test(l)));
check(reRace.moves >= 6 && reRace.sounds === 0 && reRace.draws <= 2,
  'the replay of ' + reRace.moves + ' moves was silent and drew the board ' + reRace.draws + ' time(s)', reRace);
check(gRace.refused.length === 1 && await pageBoard() === placement(gRace.bd), 'board matches the server; only the raced move was refused', gRace.refused);

// The race, refusal first: the resync reopens the stream at once, and the
// state that follows joins its rebuild.
const cRace2 = newChallenge({ color: 'white', opts: { raceForBotAtPly: 5, raceRefuseFirst: true, resignAtPly: 14 } });
await until(() => M.challenges[cRace2].gameId, 5000);
const gRace2 = M.games[M.challenges[cRace2].gameId];
await until(() => gRace2.status !== 'started', 120000, 'game 6a refusal-first race to finish');
await sleep(800);
const rbRace2 = await rbOf(gRace2.id), logRace2 = await logOf(gRace2.id);
const refusedAtRace2 = gRace2.refusedAt;
check(!!gRace2.raced && logRace2.some(l => /refused .*resyncing/.test(l)), 'refused before the server\'s move arrived: it resyncs', logRace2.filter(l => /rebuild|refused|resync/i.test(l)));
check(rbRace2.begins.length === 2, 'one rebuild, not two', rbRace2.begins);
check(refusedAtRace2 && rbRace2.begins[1] && rbRace2.begins[1].at - refusedAtRace2 < 900,
  'within ' + (rbRace2.begins[1] ? rbRace2.begins[1].at - refusedAtRace2 : '?') + ' ms of the refusal (the stream reopens at once, not after a second)');
check(await pageBoard() === placement(gRace2.bd), 'board matches the server');
await page.evaluate(() => { botTimeBehavior = _rbKeep.tb; botFixedDelayMs = _rbKeep.ms; botPremoveEnabled = _rbKeep.pm; });

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
  ratedBox: !!document.getElementById('lbc-rated') || !!document.getElementById('lbc-casual'),
  casualNote: /Casual games only/.test(document.getElementById('lbc-overlay').textContent) }));
check(pop.open && /Flounder/.test(pop.sum) && /Conviction/.test(pop.sum) && /Draws/.test(pop.sum), 'the popup summarises the bot', pop.sum.slice(0, 120));
check(pop.token && !pop.ratedBox && pop.casualNote, 'it asks for a token; casual only, with no rated option', pop);
check(await fr.evaluate(() => !!document.getElementById('lbc-match') && !document.getElementById('lbc-match').checked),
  'it offers matching the challenger\'s rating, off');
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

// An update mid-game plays from the next game. This browser is new, so its
// Stockfish can still be loading, and until it's ready the bridge declines
// challenges ("later").
await until(() => p2.evaluate(() => _lbEnginesReady()), 30000, 'the engines');
const c8 = newChallenge({ color: 'white', opts: { resignAtPly: 10 } });
await until(() => M.challenges[c8].gameId, 5000);
const g8 = M.games[M.challenges[c8].gameId];
check(g8, 'the challenge is accepted once the engines are ready', { declined: M.challenges[c8].declined });
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

// Matching the challenger's rating: a tick in the popup, carried by the bot's
// config, worked out afresh each game.
await until(() => p2.evaluate(() => lbState === 'waiting'), 10000, 'back to waiting');
await p2.evaluate(() => openBotModal());
await fr.waitForTimeout(400);
await fr.click('#qs-lichess-btn');
const matchOff = await fr.evaluate(() => ({ on: document.getElementById('lbc-match')?.checked, cfg: getBotConfig().lichessMatchRating }));
check(matchOff.on === false && matchOff.cfg === false, 'matching is off until asked for, connected too', matchOff);
await fr.check('#lbc-match');
await fr.fill('#lbc-match-offset', '-200');
const matchCfg = await fr.evaluate(() => { const c = getBotConfig(); return { on: c.lichessMatchRating, off: c.lichessMatchOffset, row: _lbcSummary() }; });
check(matchCfg.on === true && matchCfg.off === -200 && /matches each challenger −200 · 1500 if they have none/.test(matchCfg.row),
  'ticking it puts it in the bot config, and the summary says so', matchCfg);
// The chat commands it takes besides the rating are ticks: cp, think and temp
// to start (as every bot took before there was a choice), degrade not.
const cmdsCfg = await fr.evaluate(() => {
  const box = k => document.querySelector('#lbc-cmds input[data-cmd="' + k + '"]');
  const boxes = [...document.querySelectorAll('#lbc-cmds input[data-cmd]')].map(b => b.dataset.cmd + (b.checked ? '+' : '-'));
  const before = getBotConfig().lichessCommands.join();
  box('degrade').click(); box('cp').click();
  const ticked = getBotConfig().lichessCommands.join(), row = _lbcSummary();
  box('degrade').click(); box('cp').click();
  return { boxes: boxes.join(' '), before, ticked, row, after: getBotConfig().lichessCommands.join() };
});
check(cmdsCfg.boxes === 'cp+ think+ temp+ degrade-' && cmdsCfg.before === 'cp,think,temp' && cmdsCfg.ticked === 'think,temp,degrade' &&
  /Chat commands<\/dt><dd>ELO, think, temp, degrade</.test(cmdsCfg.row) && cmdsCfg.after === 'cp,think,temp',
  'the chat commands it takes are ticks in the popup (cp, think and temp to start), and the config and summary follow them', cmdsCfg);
// Takebacks: 10 a game is one of the builder's own buttons (Blundermind-M3's).
const tb10 = await fr.evaluate(() => {
  const was = getBotConfig().takebackLimit;
  document.querySelector('#tb-seg .seg-btn[data-tb="10"]').click();
  const got = { cfg: getBotConfig().takebackLimit, sel: document.querySelector('#tb-seg .seg-btn.sel')?.textContent,
    extra: document.querySelectorAll('#tb-seg .tb-extra').length };
  setTakebackLimit(was);
  return Object.assign(got, { back: getBotConfig().takebackLimit === was });
});
check(tb10.cfg === 10 && tb10.sel === '10' && tb10.extra === 0 && tb10.back, 'takebacks: 10 a game is a button of its own', tb10);
await fr.fill('#lbc-strength', '2000=1775, 600=850, 2600=2025');
const strCfg = await fr.evaluate(() => ({ t: getBotConfig().lichessStrength, row: _lbcSummary(), note: document.getElementById('lbc-strength-note').textContent }));
check(JSON.stringify(strCfg.t) === '[[600,850],[2000,1775],[2600,2025]]' && /Strength.*measured/.test(strCfg.row) && /Plays like about 850/.test(strCfg.note),
  'a measured table goes in the config in order, and the summary and note read it back', strCfg);
await fr.fill('#lbc-strength', '600=850, 2000=700');
const badCfg = await fr.evaluate(() => ({ t: getBotConfig().lichessStrength, note: document.getElementById('lbc-strength-note').textContent }));
check(badCfg.t === null && /isn’t used/.test(badCfg.note), 'one that doesn\'t rise is not used, and the note says so', badCfg);
// Rows measured at another Budget carry it, and can share a setting: this
// Flounder dial stops at 2400, so its top is inside the last pair.
await fr.fill('#lbc-strength', '2600 cp50=2775, 600=850, 600 CP300 = 600, 2600=2025');
const cpRows = await fr.evaluate(() => ({ t: getBotConfig().lichessStrength, row: _lbcSummary(), note: document.getElementById('lbc-strength-note').textContent }));
check(JSON.stringify(cpRows.t) === '[[600,600,300],[600,850],[2600,2025],[2600,2775,50]]' &&
  /plays like 600 \(Flounder 600, CP Budget 300\) to 1908 \(Flounder 2400\)/.test(cpRows.row) && /moves the CP Budget/.test(cpRows.note),
  'rows measured at another Budget (2600 cp50=2775) go in the config with it, by strength, and each end says what runs there', cpRows);
await fr.fill('#lbc-strength', '600=850, 600=900');
check(await fr.evaluate(() => getBotConfig().lichessStrength) === null, 'two rows at the builder\'s own Budget can\'t share a setting');
await fr.fill('#lbc-strength', '2600 cp400=2900');
check(await fr.evaluate(() => getBotConfig().lichessStrength) === null, 'nor can a row\'s Budget pass the slider\'s 300');
await fr.fill('#lbc-strength', '');
await fr.evaluate(() => { lbcClose(); startGame(); });
await until(() => p2.evaluate(() => window._lastAppliedBotConfig.lichessMatchRating === true), 5000, 'the update');
const playMatched = async (challenger, seenAt) => {
  const id = newChallenge({ color: 'black', challenger, opts: { resignAtPly: 4 } });
  await until(() => M.challenges[id].gameId, 5000, 'the challenge accepted');
  const g = M.games[M.challenges[id].gameId];
  await until(() => g.moves.length >= 1, 60000, 'the bot\'s first move');
  const seen = await p2.evaluate(() => ({ flounder: flounderSliderElo(), maia: maia3SelectedRating, name: botGenerateName(),
    panel: document.getElementById('lbBot').textContent, log: lbLogLines.slice(-20).join(' | '),
    applied: window._lastAppliedBotConfig.elo, saved: JSON.parse(localStorage.getItem('bm_lastBot')).cfg.elo }));
  await until(() => g.status !== 'started', 90000, 'the game to finish');
  await until(() => p2.evaluate(() => lbState === 'waiting'), 10000, 'back to waiting');
  seen.chat = g.chat.map(l => l.text);
  seen.spect = g.spect.map(l => l.text);
  return seen;
};
// What the bot says: always a playing strength, with thousands commas, then
// what runs (the engine setting and the CP Budget), and the ranges as the
// commands are typed.
const elo = n => n.toLocaleString('en-US');
// The greeting, three lines (Ben's wording, Nov 16 and 20) for a bot that
// takes cp, think and temp: everything it is set to, what can be typed, and
// the ranges. The spectators get the first line only. Think time and Temp
// read "auto" when nobody has asked for one, but Temp reads 10 for a Blind
// Conviction bot (`blind`), which is what it plays — and on a Maia bot with
// no personality temp is Maia's own temperature, at the one it was built with
// (SAYS.maiaTemp, read from the page as each bot is applied).
const SAYS = { maiaTemp: null };
const readSays = async () => Object.assign(SAYS, await p2.evaluate(() => ({
  maiaTemp: botWeighsMoves() ? null : Math.round(botMaiaTempValue * 10) / 10 })));
const MAIA_TEMP_RANGE = "temp 0-2: 0 = Maia's top move, 1 = matches Maia's odds, 2 = wild";
const stated = (est, runs, cp, edge, think, temp, blind) => {
  const maiaTemp = !runs.startsWith('Flounder') && !blind && SAYS.maiaTemp != null;
  return `ELO set to ${elo(est)} (${edge ? `its ${edge}, ` : ''}using ${runs}), CP budget ${cp}, ` +
    `think ${think != null ? (typeof think === 'number' ? think + 's' : think) : 'auto'}, ` +
    `temp ${temp != null ? temp : blind ? 10 : maiaTemp ? SAYS.maiaTemp : 'auto'}`;
};
const GREET_LINES = 3;
const greeting = (est, runs, cp, lo, hi, edge, think, temp, blind) => {
  const flounder = runs.startsWith('Flounder');
  const maiaTemp = !flounder && !blind && SAYS.maiaTemp != null;
  return [
    stated(est, runs, cp, edge, think, temp, blind),
    `Type in chat to change strength (ELO), centipawn budget (cp), Move timing (think), ${flounder ? 'Flounder' : 'Maia'} temperature (temp).`,
    `ELO ${lo}-${hi}, cp 0-300, think 0-60s or auto or mirror, ` +
      (maiaTemp ? MAIA_TEMP_RANGE : `Temp 0 (${flounder ? "Flounder's" : "Maia's"} top move) - 10 (personality driven)`),
  ].join('\n');
};
// The player chat's first lines, as the greeting reads (seen.chat holds strings, a game's chat objects).
const greetOf = g => (g.chat || []).slice(0, GREET_LINES).map(l => typeof l === 'string' ? l : l.text).join('\n');
// It comes LB_GREET_DELAY_MS after the game starts.
const greeted = g => until(() => g.chat.length >= GREET_LINES, 8000, 'the greeting');
const lastSpect = g => g.spect.length ? g.spect[g.spect.length - 1].text : null;
const perf = (est, edge, runs, cp, cpEdge) => `Performance set to ${elo(est)}` + (edge ? ` (its ${edge})` : '') +
  `: ${runs}, CP budget ${cp}` + (cpEdge ? ` (its ${cpEdge})` : '');
const builtCp = () => p2.evaluate(() => window._lastAppliedBotConfig.cpBudget);
let B = await builtCp();
// A game that stays open until endGame, with a slow opponent so the chat checks
// finish well before the game can.
// The opponent never allows mate in one, so a chat game lasts its checks out:
// a random mover was sometimes mated mid-way (Maia 2600 after ELO4000).
const openGame = async (challenger, oppDelayMs = 1500) => {
  const id = newChallenge({ color: 'black', challenger, opts: { oppDelayMs, avoidMateInOne: true } });
  await until(() => M.challenges[id].gameId, 5000, 'the challenge accepted');
  const g = M.games[M.challenges[id].gameId];
  await until(() => g.moves.length >= 1, 60000, 'the bot\'s first move');
  return g;
};
const endGame = async g => {
  finish(g, 'resign', g.botWhite ? 'white' : 'black');
  await until(() => p2.evaluate(() => lbState === 'waiting'), 10000, 'back to waiting');
};
const lastSaid = g => g.chat.length ? g.chat[g.chat.length - 1].text : null;
// The opponent types a command and the bot answers.
const command = async (g, text) => {
  const n = g.chat.length;
  chatLine(g, g.opp.name, text);
  await until(() => g.chat.length > n, 5000, 'the bot to answer ' + text);
};
const pastCooldown = () => sleep(3200);
const m1 = await playMatched(undefined);   // TestHuman, 1600
check(m1.flounder === 1400 && /Flounder 1400/.test(m1.name) && /Playing at Flounder 1400: TestHuman is rated 1600, offset -200/.test(m1.log),
  'a 1600 challenger, offset -200: plays at 1400, and says so', m1);
check(/matches each challenger/.test(m1.panel), 'the board\'s Lichess panel says it is matching', m1.panel);
check(m1.applied === 1500 && m1.saved === 1500, 'the saved bot keeps its own rating', m1);
const m2 = await playMatched({ id: 'newcomer', name: 'Newcomer', rating: 1833, provisional: true });
check(m2.flounder === 1625 && /Newcomer is rated 1833\?/.test(m2.log),
  'the next challenger sets it afresh (Flounder\'s dial holds 25s); a provisional rating is marked', m2);
const m3 = await playMatched({ id: 'magnus', name: 'Magnus', rating: 3000 });
check(m3.flounder === 2400, 'a rating past the engine\'s range stops at its top', m3);
const m4 = await playMatched({ id: 'anon', name: 'Anon' });
check(m4.flounder === 1500 && /Anon has no rating to match: playing at Flounder 1500/.test(m4.log),
  'no rating: plays at the builder\'s rating', m4);
check(m1.chat.length === GREET_LINES && greetOf(m1) === greeting(1400, 'Flounder 1400', B, 600, 2400),
  'the bot says what it is doing, once, with the range this engine really has, and how to change each thing', m1.chat);
check(m1.spect.length === 1 && m1.spect[0] === stated(1400, 'Flounder 1400', B),
  'and tells the spectators what it plays at, without the instructions', m1.spect);
check(greetOf(m4) === greeting(1500, 'Flounder 1500', B, 600, 2400), 'with no rating to match, it gives the builder\'s rating', m4.chat);

// The chat command on Flounder: its dial holds 25s and stops at 2400.
const fg = await openGame({ id: 'flounderuser', name: 'FlounderUser', rating: 1600 });
await greeted(fg);   // so the greeting can't land in place of the reply
await command(fg, '1530ELO');
check(lastSaid(fg) === perf(1525, null, 'Flounder 1525', B) && await p2.evaluate(() => flounderSliderElo()) === 1525,
  'Flounder: the reply gives the rating it can really play', lastSaid(fg));
await pastCooldown();
await command(fg, '3000ELO');
check(lastSaid(fg) === perf(2400, 'highest', 'Flounder 2400', B) && await p2.evaluate(() => flounderSliderElo()) === 2400,
  'Flounder: past its top, it says where it stopped', lastSaid(fg));
await endGame(fg);

// A blend has no single rating to move, so the popup doesn't offer it.
const hyb = await fr.evaluate(() => {
  selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="hybrid"]'));
  lbcOpen();
  const r = { disabled: document.getElementById('lbc-match').disabled, row: _lbcSummary(), text: document.getElementById('lbc-body').textContent };
  lbcClose();
  return r;
});
check(hyb.disabled && /no single rating/.test(hyb.text) && !/matches each challenger/.test(hyb.row), 'a blend: the option is greyed, and says why', hyb.disabled);

// The real thing on Maia, with Curve A on: it holds absolute ratings, so unless
// it moves too, the old rating would go on playing whatever the dial said.
await p2.evaluate(() => { if (!_maiaReady) maiaDownloadModel(); });
await until(() => p2.evaluate(() => _maiaReady), 180000, 'Maia to load');
await fr.evaluate(() => {
  selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
  setElo(2200);
  document.querySelector('#timing-mode-grid .mcard[data-v="Complexity-scaled"]').click();
  startGame();
});
await until(() => p2.evaluate(() => window._lastAppliedBotConfig.elo === 2200 && _lbEnginesReady()), 60000, 'the Maia update');
B = await builtCp();
await readSays();
check(SAYS.maiaTemp != null, 'this Maia bot has no personality, so its temp is Maia\'s own temperature', SAYS);
const curveOn = await p2.evaluate(() => {
  window._maiaAsked = [];
  const real = maia3GetMoveProbs;
  maia3GetMoveProbs = function (fen, elo) { window._maiaAsked.push(+(elo != null ? elo : lcSelectedRating)); return real.apply(this, arguments); };
  return !!botPressureCurveA;
});
check(curveOn, 'this Maia bot has its rating curve on');
const m5 = await playMatched({ id: 'maiauser', name: 'MaiaUser', rating: 1700 });
const asked = await p2.evaluate(() => window._maiaAsked);
check(m5.maia === 1500 && /Maia 1500/.test(m5.name) && m5.applied === 2200 && m5.saved === 2200,
  'a Maia 2200 bot against a 1700 challenger, offset -200: rated 1500, saved bot still 2200', m5);
// Curve A is the Regan model for this game's 3+2 clock: 1500 at its average
// pace (3 + 2 = 5 s a move) and slower, Regan's loss below that.
const reganD = s => 339 - 1442 * Math.pow(Math.max(0.05, s), -0.283);
const curveNow = () => p2.evaluate(() => botPressureCurveA.map(p => ({ x: p.x, y: p.y })));
const rc5 = await curveNow();
const at1 = rc5.find(p => p.x === 1), at200 = rc5.find(p => p.x === 200), atAnchor = rc5.find(p => Math.abs(p.x - 5) < 0.01);
check(at200?.y === 1500 && atAnchor?.y === 1500 && at1?.y === Math.round(1500 + reganD(1) - reganD(5)),
  'Curve A is rebuilt on the Regan model for the game\'s clock (full at 5 s a move, ' + Math.round(1500 + reganD(1) - reganD(5)) + ' at 1 s)', rc5);
const curveLow = Math.min(...rc5.map(p => p.y));
check(asked.length > 0 && asked.every(r => r >= curveLow && r <= 1500), 'and Maia itself is asked for that rating, curve and all', asked);

// The game chat: what the bot says, the command, and who can give it.
const curveTop = () => p2.evaluate(() => Math.max(...botPressureCurveA.map(p => p.y)));
const maiaNow = () => p2.evaluate(() => maia3SelectedRating);
const chatUser = { id: 'chatuser', name: 'ChatUser', rating: 1900 };
// A random mover is mated quickly, so a slow one keeps this game open through every check.
// At 3 s a move it was still mated now and then (Maia 2600 after ELO4000) before the last.
const cg = await openGame(chatUser, 6000);
await greeted(cg);
check(cg.chat.length === GREET_LINES && cg.chat.every(l => l.room === 'player') && greetOf(cg) === greeting(1700, 'Maia 1700', B, 600, 2600),
  'at the start, in the player chat: it matches, at what rating, and how to change it', cg.chat);
check(cg.spect.length === 1 && cg.spect[0].text === stated(1700, 'Maia 1700', B),
  'and in the spectator chat, what it plays at', cg.spect);
chatLine(cg, 'ChatUser', 'I am 1500 elo lol');
chatLine(cg, 'Spectator', '1200ELO', 'spectator');
chatLine(cg, 'SomeoneElse', '1200ELO');
await sleep(800);
check(await maiaNow() === 1700 && cg.chat.length === GREET_LINES, 'chatter, spectators and third parties change nothing, and get no reply', cg.chat);
await command(cg, '1500ELO');
check(lastSaid(cg) === perf(1500, null, 'Maia 1500', B) && await maiaNow() === 1500 && await curveTop() === 1500,
  '1500ELO: the exact reply, and the rating and its curve both move', { said: lastSaid(cg) });
check(lastSpect(cg) === perf(1500, null, 'Maia 1500', B), 'the spectators are told the change too', cg.spect);
check(await p2.evaluate(() => /Maia 1500/.test(botGenerateName())), 'the board\'s name for the bot moves too');
await p2.evaluate(() => { window._maiaAsked = []; });
const postsAtChange = cg.botPosts.length;
await until(() => cg.botPosts.length >= postsAtChange + 2, 60000, 'two more bot moves');
const askedAfter = await p2.evaluate(() => window._maiaAsked);
check(askedAfter.length > 0 && askedAfter.every(r => r >= curveLow && r <= 1500), 'the bot\'s next moves are played at it, mid-game', askedAfter);
await pastCooldown();
await command(cg, ' 1600 elo ');
check(lastSaid(cg) === perf(1600, null, 'Maia 1600', B) && await maiaNow() === 1600, 'spaces and lower case are fine', lastSaid(cg));
// Two more inside the 3 s cooldown: held, not dropped. The last one asked is
// answered once the cooldown ends, and only once.
const heldAt = cg.chat.length;
chatLine(cg, 'ChatUser', '2000ELO');
chatLine(cg, 'ChatUser', '1700ELO');
await sleep(800);
check(cg.chat.length === heldAt && await maiaNow() === 1600, 'commands inside the cooldown wait for it', cg.chat.slice(heldAt));
await until(() => cg.chat.length > heldAt, 5000, 'the held command answered');
await sleep(1000);
check(cg.chat.length === heldAt + 1 && lastSaid(cg) === perf(1700, null, 'Maia 1700', B) && await maiaNow() === 1700,
  'then the latest is answered, once, so nothing that arrives goes unanswered', cg.chat.slice(heldAt));
await pastCooldown();
await command(cg, '4000ELO');
check(lastSaid(cg) === perf(2600, 'highest', 'Maia 2600', B) && await maiaNow() === 2600, 'above the range: stops at the top and says so', lastSaid(cg));
await pastCooldown();
await command(cg, '100ELO');
check(lastSaid(cg) === perf(600, 'lowest', 'Maia 600', B) && await maiaNow() === 600, 'below the range: stops at the bottom and says so', lastSaid(cg));
await pastCooldown();
await command(cg, 'ELO1700');
check(lastSaid(cg) === perf(1700, null, 'Maia 1700', B) && await maiaNow() === 1700, 'ELO first works too (ELO1700)', lastSaid(cg));
// The think time: the builder's Fixed timing at that many seconds a move.
const timing = () => p2.evaluate(() => ({ mode: botTimeBehavior, ms: botFixedDelayMs }));
const builtTiming = await timing();
await pastCooldown();
await command(cg, 'think 15 s');
check(lastSaid(cg) === 'Think time set to 15 s a move' && lastSpect(cg) === 'Think time set to 15 s a move' &&
  JSON.stringify(await timing()) === JSON.stringify({ mode: 'fixed', ms: 15000 }),
  'think 15 s: Fixed timing at 15 s a move, said in both chats', { said: lastSaid(cg), t: await timing() });
await pastCooldown();
await command(cg, 'think99');
check(lastSaid(cg) === 'Think time set to 60 s a move (its longest)' && (await timing()).ms === 60000,
  'think99: stops at 60 s and says so', lastSaid(cg));
await pastCooldown();
await command(cg, 'ELO1700 think2.5s');
check(lastSaid(cg) === perf(1700, null, 'Maia 1700', B) + ', think time 2.5 s a move' && (await timing()).ms === 2500,
  'with a rating: one answer with both', lastSaid(cg));
await pastCooldown();
await command(cg, 'think auto');
check(lastSaid(cg) === 'Think time back to human-like timing' &&JSON.stringify(await timing()) === JSON.stringify(builtTiming),
  'think auto: back to the timing it was built with', { said: lastSaid(cg), t: await timing(), builtTiming });
await pastCooldown();
await command(cg, '1500ELO');
// A rebuild from the server, the bot not being mid-move.
await until(() => cg.status !== 'started' || cg.turn !== (cg.botWhite ? 'w' : 'b'), 60000, 'the opponent\'s turn');
const saidBefore = cg.chat.length;
if (cg.status !== 'started') console.log('    (the chat game ended early: ' + cg.status + ' at ply ' + cg.moves.length + ')');
await p2.evaluate(() => _lbBeginLocalGame(lbGame, lbGame.local.slice()));
await sleep(400);
check(await maiaNow() === 1500 && await curveTop() === 1500 && cg.chat.length === saidBefore,
  'a rebuild from the server keeps the choice and doesn\'t greet again', { maia: await maiaNow(), said: cg.chat.length });
// Every POST shares one queue and a 429 sleeps a minute in it, so a chat line
// that retried would sit in front of the bot's next move.
await pastCooldown();
M.chat429 = true;
const chatPosts0 = cg.chatPosts, movePosts0 = cg.botPosts.length, t429 = Date.now();
chatLine(cg, 'ChatUser', '1500ELO');
await until(() => cg.chatPosts > chatPosts0, 5000, 'the refused chat line');
await until(() => cg.botPosts.length > movePosts0, 30000, 'the bot\'s next move');
const moved429 = cg.botPosts.length > movePosts0, took429 = Date.now() - t429;
M.chat429 = false;
await sleep(300);
// The reply goes to both chats, player and spectator: one try each.
check(moved429 && took429 < 30000 && cg.chatPosts === chatPosts0 + 2,
  'a rate-limited chat line is dropped once in each chat, and the bot\'s moves don\'t wait behind it', { moved429, took429, posts: cg.chatPosts - chatPosts0 });
check(await p2.evaluate(() => lbLogLines.some(l => /Chat line not sent/.test(l))), 'and the host\'s log says it wasn\'t sent');
check(cg.status === 'started', 'the chat game was still going throughout', cg.status);
await endGame(cg);
const cg2 = await openGame(chatUser);
await greeted(cg2);
check(await maiaNow() === 1500 && greetOf(cg2) === greeting(1500, 'Maia 1500', B, 600, 2600),
  'a rematch keeps their choice', cg2.chat);
await endGame(cg2);
const cg3 = await openGame({ id: 'nextuser', name: 'NextUser', rating: 1300 });
await greeted(cg3);
check(await maiaNow() === 1100 && greetOf(cg3) === greeting(1100, 'Maia 1100', B, 600, 2600), 'the next player gets their own rating, not the last one\'s choice', cg3.chat);
await endGame(cg3);
// Temp: 0 plays Maia's top move, 10 the personality's pick, between blends.
// A game of its own, so the chat game above lasts no longer than it did.
const tempNow = () => p2.evaluate(() => botBlendTemp);
const tempUser = { id: 'tempuser', name: 'TempUser', rating: 1900 };
// Temp's blend needs a personality to blend with (with none, temp is Maia's
// own temperature: the M3 games below). A knight lover, for these games.
const builtPieces = await p2.evaluate(() => { const v = window._bcpPieceValues; window._bcpPieceValues = { knight: 1 }; return v; });
const builtMaiaTemp = SAYS.maiaTemp;
SAYS.maiaTemp = null;
const tg = await openGame(tempUser, 3000);
await greeted(tg);
check(await tempNow() === null && greetOf(tg) === greeting(1700, 'Maia 1700', B, 600, 2600), 'before any temp command the bot picks as it was built', { t: await tempNow(), chat: tg.chat });
await command(tg, 'temp0');
check(lastSaid(tg) === "Temp set to 0 (Maia's top move, no personality)" && lastSpect(tg) === lastSaid(tg) && await tempNow() === 0,
  'temp0: Maia\'s top move, said in both chats', { said: lastSaid(tg), t: await tempNow() });
await pastCooldown();
await command(tg, 'temp 2.5');
check(lastSaid(tg) === 'Temp set to 2.5' && await tempNow() === 2.5, 'temp 2.5: in between, just the number', lastSaid(tg));
await pastCooldown();
await command(tg, 'temp 9.9');
check(lastSaid(tg) === 'Temp set to 9.9' && await tempNow() === 9.9, 'temp 9.9: the top of the blend, still a number', lastSaid(tg));
await pastCooldown();
await command(tg, 'temp50');
check(lastSaid(tg) === "Temp set to 10 (personality's pick)" && await tempNow() === 10,
  "temp50: stops at 10, the personality's pick", lastSaid(tg));
await pastCooldown();
await command(tg, 'ELO1700 temp.5');
check(lastSaid(tg) === perf(1700, null, 'Maia 1700', B) + ', temp 0.5' && await tempNow() === 0.5,
  'with a rating: one answer with both (and .5 for 0.5)', lastSaid(tg));
await pastCooldown();
await command(tg, 'temp auto');
check(lastSaid(tg) === "Temp back to the bot's own pick" && await tempNow() === null,
  'temp auto: back to the pick it was built with', lastSaid(tg));
check(await p2.evaluate(() => lbLogLines.some(l => /asked for temp 50 in the chat: Temp 10/.test(l))), 'the host\'s log has what was asked and what it set');
await pastCooldown();
await command(tg, 'temp2');
check(tg.status === 'started', 'the temp game was still going throughout', tg.status);
await endGame(tg);
const tg2 = await openGame(tempUser);
await greeted(tg2);
check(await tempNow() === 2 && greetOf(tg2) === greeting(1700, 'Maia 1700', B, 600, 2600, null, null, 2) &&
  tg2.spect[0]?.text === stated(1700, 'Maia 1700', B, null, null, 2),
  'a rematch keeps their temp, and the greeting gives it', { t: await tempNow(), chat: tg2.chat, spect: tg2.spect });
await endGame(tg2);
const tg3 = await openGame({ id: 'tempnext', name: 'TempNext', rating: 1300 });
await greeted(tg3);
check(await tempNow() === null && greetOf(tg3) === greeting(1100, 'Maia 1100', B, 600, 2600), 'the next player doesn\'t get the last one\'s temp', { t: await tempNow(), chat: tg3.chat });
await endGame(tg3);
await p2.evaluate(v => { window._bcpPieceValues = v; }, builtPieces);
SAYS.maiaTemp = builtMaiaTemp;
const cpNow = () => p2.evaluate(() => ({ budget: window._bcpCpBudget, floor: window._bcpCpHardFloor,
  built: window._lastAppliedBotConfig.cpBudget, builtFloor: window._lastAppliedBotConfig.hardFloorCp }));
// A bot not set to match keeps its rating and says so.
await p2.evaluate(() => { window._lastAppliedBotConfig.lichessMatchRating = false; });
const fixedElo = await maiaNow();
const cg4 = await openGame({ id: 'fixeduser', name: 'FixedUser', rating: 1800 });
await sleep(2600);   // longer than the greeting's wait
const fixedGreeted = cg4.chat.length;
await command(cg4, '1500ELO');
check(fixedGreeted === 0 && lastSaid(cg4) === 'This bot\'s rating can\'t be changed.' && await maiaNow() === fixedElo,
  'a bot not set to match: no greeting, and it says the rating can\'t change', { fixedGreeted, said: lastSaid(cg4) });
await pastCooldown();
const fixedCp = (await cpNow()).budget;
await command(cg4, 'cp50');
check(lastSaid(cg4) === 'This bot\'s CP budget can\'t be changed.' && (await cpNow()).budget === fixedCp,
  'nor its CP budget', lastSaid(cg4));
await pastCooldown();
await command(cg4, 'temp0');
check(lastSaid(cg4) === 'This bot\'s temp can\'t be changed.' && await tempNow() === null, 'nor its temp', lastSaid(cg4));
await endGame(cg4);
await p2.evaluate(() => { window._lastAppliedBotConfig.lichessMatchRating = true; });

// The CP Budget from the chat: cp100 alone, or beside the rating. Its own game,
// with a slower opponent, so the game outlasts the cooldowns.
const cpUser = { id: 'cpuser', name: 'CpUser', rating: 1900 };
const pg = await openGame(cpUser, 3000);
await greeted(pg);   // so the greeting can't land in place of the reply
const cp0 = await cpNow();
check(cp0.budget === cp0.built && await maiaNow() === 1700, 'before any cp command it plays the builder\'s Budget (' + cp0.built + ')', cp0);
await command(pg, 'cp40');
const cp1 = await cpNow();
check(lastSaid(pg) === 'CP budget set to 40' && cp1.budget === 40 && cp1.floor === cp0.builtFloor && await maiaNow() === 1700,
  'cp40: the Budget moves, the Floor and rating stay', { said: lastSaid(pg), cp1 });
await pastCooldown();
await command(pg, 'ELO1600 cp75');
const cp2 = await cpNow();
check(lastSaid(pg) === perf(1600, null, 'Maia 1600', 75) && cp2.budget === 75 && await maiaNow() === 1600,
  'ELO1600 cp75: both in one line, one reply', lastSaid(pg));
await pastCooldown();
await command(pg, '400cp');
const cp3 = await cpNow();
check(lastSaid(pg) === 'CP budget set to 300 (its highest)' && cp3.budget === 300 && cp3.floor === Math.max(cp0.builtFloor, 300),
  'past the top (and number first): stops at 300, says so, and the Floor is never under it', { said: lastSaid(pg), cp3 });
// Two inside the cooldown, each naming one thing: both are kept, one answer.
await pastCooldown();
const heldCp = pg.chat.length;
await command(pg, 'cp60');
chatLine(pg, 'CpUser', 'ELO1650');
chatLine(pg, 'CpUser', 'CP 75');
await until(() => pg.chat.length > heldCp + 1, 5000, 'the held commands answered');
await sleep(1000);
check(pg.chat.length === heldCp + 2 && lastSaid(pg) === perf(1650, null, 'Maia 1650', 75) && (await cpNow()).budget === 75 && await maiaNow() === 1650,
  'a rating then a Budget inside the cooldown: one answer, with both', pg.chat.slice(heldCp));
check(await p2.evaluate(() => lbLogLines.some(l => /asked for cp75 in the chat: CP budget 75, Hard Floor/.test(l))), 'the host\'s log has the Budget and Floor');
chatLine(pg, 'CpUser', 'cp 50 please');
await sleep(800);
check((await cpNow()).budget === 75 && pg.chat.length === heldCp + 2, 'a line that is more than the command changes nothing');
check(pg.status === 'started', 'the cp game was still going throughout', pg.status);
await endGame(pg);
const pg2 = await openGame(cpUser);
check((await cpNow()).budget === 75 && await maiaNow() === 1650, 'a rematch keeps their CP budget (and rating)', await cpNow());
await endGame(pg2);
const pg3 = await openGame({ id: 'cpnext', name: 'CpNext', rating: 1300 });
const cpNext = await cpNow();
check(cpNext.budget === cpNext.built && cpNext.floor === cpNext.builtFloor, 'the next player gets the builder\'s Budget and Floor', cpNext);
await endGame(pg3);

// ── Blundermind-M3 (Nov 20): plain Maia, taking only its own commands ───────
// think, temp and degrade, not cp. Temp is Maia's own temperature; think
// mirror is their pace; blink goes with its own timing only; degrade moves
// the rating alone (Curve A on the Regan model), and never with a fixed time.
const builtM3 = await p2.evaluate(() => {
  const c = window._lastAppliedBotConfig;
  const was = { cmds: c.lichessCommands, offA: c.pressureOffA, blink: c.behavBlink };
  c.lichessCommands = ['think', 'temp', 'degrade'];
  c.pressureOffA = true;
  c.behavBlink = true;
  return was;
});
const knobs = () => p2.evaluate(() => ({ chatTemp: botChatMaiaTemp, blend: botBlendTemp, base: botMaiaBaseTemp(),
  mode: botTimeBehavior, ms: botFixedDelayMs, blink: botBehavBlink, b: !!botPressureCurveB, budget: window._bcpCpBudget,
  a: botPressureCurveA ? botPressureCurveA.map(p => ({ x: p.x, y: p.y })) : null }));
const curveBBuilt = (await knobs()).b;
const m3Greet = (est, think, temp, deg) => [
  `ELO set to ${elo(est)} (using Maia ${est}), think ${think}, temp ${temp}, degrade ${deg}`,
  'Type in chat to change strength (ELO), Move timing (think), Maia temperature (temp), time-pressure degradation (degrade).',
  'ELO 600-2600, think 0-60s or auto or mirror, degrade on/off, ' + MAIA_TEMP_RANGE,
].join('\n');
const m3User = { id: 'm3user', name: 'M3User', rating: 1900 };
const ug = await openGame(m3User, 6000);
await greeted(ug);
let kn = await knobs();
check(greetOf(ug) === m3Greet(1700, 'auto', SAYS.maiaTemp, 'off') && ug.spect[0]?.text === greetOf(ug).split('\n')[0],
  'M3: the greeting names only what it takes, temp as Maia\'s temperature, degrade off as built', ug.chat);
check(kn.a === null && kn.blink === true && kn.mode === 'complexity', 'as built: no rating curve, its own Complexity timing, with blink', kn);
await command(ug, 'temp0');
kn = await knobs();
check(lastSaid(ug) === "Temp set to 0 (Maia's top move)" && kn.chatTemp === 0 && kn.blend === null,
  'temp0: Maia\'s top move, and no blend', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'temp1');
kn = await knobs();
check(lastSaid(ug) === "Temp set to 1 (matches Maia's odds)" && kn.chatTemp === 1 && kn.base === 1, 'temp1: Maia\'s own odds', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'temp 9');
check(lastSaid(ug) === 'Temp set to 2 (wild)' && (await knobs()).chatTemp === 2, 'temp 9: stops at 2, wild', lastSaid(ug));
await pastCooldown();
await command(ug, 'think mirror');
kn = await knobs();
check(lastSaid(ug) === 'Think time set to mirror (your pace)' && kn.mode === 'mirror' && kn.blink === false,
  'think mirror: their pace, without blink', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'degrade on');
kn = await knobs();
const ua1 = kn.a && kn.a.find(p => p.x === 1), ua200 = kn.a && kn.a.find(p => p.x === 200);
check(lastSaid(ug) === 'Time-pressure degradation on' && ua200?.y === 1700 && ua1?.y === Math.round(1700 + reganD(1) - reganD(5)) &&
  kn.b === curveBBuilt, 'degrade on: the rating curve, on the Regan model for the 3+2 clock; the temperature curve untouched', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'think 5s');
kn = await knobs();
check(lastSaid(ug) === 'Think time set to 5 s a move' && kn.mode === 'fixed' && kn.ms === 5000 && kn.blink === false,
  'think 5s: exactly that, without blink', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'degrade on');
check(lastSaid(ug) === 'Time-pressure degradation on (not with a fixed think time)', 'degrade on with a fixed time: it says it can\'t run then', lastSaid(ug));
await pastCooldown();
await command(ug, 'think auto');
kn = await knobs();
check(lastSaid(ug) === 'Think time back to human-like timing' && kn.mode === 'complexity' && kn.blink === true,
  'think auto: its own timing again, blink and all', { said: lastSaid(ug), kn });
await pastCooldown();
await command(ug, 'cp50');
check(lastSaid(ug) === "This bot's CP budget can't be changed." && (await knobs()).budget === kn.budget, 'cp50: not one it takes, and it says so', lastSaid(ug));
await pastCooldown();
await command(ug, 'ELO1800 cp50');
check(lastSaid(ug) === "Performance set to 1,800: Maia 1800. This bot's CP budget can't be changed." && await maiaNow() === 1800,
  'ELO1800 cp50: the rating, no Budget, and why', lastSaid(ug));
await pastCooldown();
await command(ug, 'degrade off');
check(lastSaid(ug) === 'Time-pressure degradation off' && (await knobs()).a === null, 'degrade off: no rating curve', lastSaid(ug));
check(ug.status === 'started', 'the M3 game was still going throughout', ug.status);
await endGame(ug);
const ug2 = await openGame(m3User);
await greeted(ug2);
check(greetOf(ug2).split('\n')[0] === 'ELO set to 1,800 (using Maia 1800), think auto, temp 2, degrade off' && (await knobs()).chatTemp === 2,
  'a rematch keeps their choices, and the greeting gives them', ug2.chat);
await endGame(ug2);
const ug3 = await openGame({ id: 'm3next', name: 'M3Next', rating: 1300 });
await greeted(ug3);
kn = await knobs();
check(greetOf(ug3) === m3Greet(1100, 'auto', SAYS.maiaTemp, 'off') && kn.chatTemp === null && kn.a === null &&
  kn.mode === 'complexity' && kn.blink === true, 'the next player gets M3 as built', { chat: ug3.chat, kn });
await endGame(ug3);
await p2.evaluate(w => { const c = window._lastAppliedBotConfig;
  c.lichessCommands = w.cmds; c.pressureOffA = w.offA; c.behavBlink = w.blink; }, builtM3);

// A bot measured to play away from its setting (Blundermind-01, the Blind
// Conviction bot, measured Nov 11): the rating wanted is a playing strength,
// it is set to whatever plays at it, and all it says is that strength.
await p2.evaluate(() => { window._lastAppliedBotConfig.lichessStrength = [[600, 850], [1000, 1125], [1500, 1500], [2000, 1775], [2600, 2025]]; });
// The builder's offset is still -200: 1975 asks for 1775, 2300 for 2100.
const mg = await openGame({ id: 'measureduser', name: 'MeasuredUser', rating: 1975 });
await greeted(mg);
check(await maiaNow() === 2000 && greetOf(mg) === greeting(1775, 'Maia 2000', B, 850, 2025),
  'measured: asked for 1775 (a 1975 challenger, offset -200), it plays Maia 2000, and the greeting gives the range it really plays', mg.chat);
check(await p2.evaluate(() => lbLogLines.some(l => /Playing at Maia 2000 \(plays like 1775\): MeasuredUser is rated 1975/.test(l))),
  'the host\'s log gives the setting beside the strength');
const mc = await curveNow();
// 1775 less Regan's loss at 1 s, back through the table: 1000 + (strength - 1125) x 500/375.
const mWant1 = 1775 + reganD(1) - reganD(5);
check(mc.find(p => p.x === 200)?.y === 2000 && mc.find(p => p.x === 1)?.y === Math.round(1000 + (mWant1 - 1125) * 500 / 375),
  'its curve loses Regan\'s strength, not Regan\'s setting', mc);
await command(mg, 'ELO600');
check(lastSaid(mg) === perf(850, 'lowest', 'Maia 600', B) && await maiaNow() === 600, 'ELO600: the lowest setting, and the strength it plays at', lastSaid(mg));
await pastCooldown();
await command(mg, 'ELO1775');
check(lastSaid(mg) === perf(1775, null, 'Maia 2000', B) && await maiaNow() === 2000, 'ELO1775: performance 1,775, which is Maia 2000', lastSaid(mg));
await pastCooldown();
await command(mg, 'elo 1,600');
check(lastSaid(mg) === perf(1600, null, 'Maia 1682', B) && await maiaNow() === 1682, 'in between (and typed with a comma): the setting that plays at it', lastSaid(mg));
await pastCooldown();
await command(mg, 'ELO2600');
check(lastSaid(mg) === perf(2025, 'highest', 'Maia 2600', B) && await maiaNow() === 2600, 'ELO2600: the highest setting, and the strength it plays at', lastSaid(mg));
await endGame(mg);
const hg = await openGame({ id: 'stronguser', name: 'StrongUser', rating: 2300 });
await greeted(hg);
check(await maiaNow() === 2600 && greetOf(hg) === greeting(2025, 'Maia 2600', B, 850, 2025, 'highest'),
  'a challenger past its range: it says it is at its top', hg.chat);
await endGame(hg);

// Its whole table (Nov 15): past Maia 600 and 2600 the Budget moves instead,
// cp300 to 600 at the bottom and cp50 to 2775 at the top, and it says so.
await p2.evaluate(() => { window._lastAppliedBotConfig.lichessStrength =
  [[600, 600, 300], [600, 850], [1000, 1125], [1500, 1500], [2000, 1775], [2600, 2025], [2600, 2350, 100], [2600, 2550, 75], [2600, 2775, 50]]; });
// 2900 less the offset asks for 2700: 2550 → 2775 runs cp75 → cp50, so cp58.
const xg = await openGame({ id: 'budgetuser', name: 'BudgetUser', rating: 2900 }, 3000);
await greeted(xg);
const x0 = await cpNow();
check(await maiaNow() === 2600 && x0.budget === 58 && x0.floor === Math.max(x0.builtFloor, 58) &&
  greetOf(xg) === greeting(2700, 'Maia 2600', 58, 600, 2775),
  'past Maia 2600: asked for 2700, it plays Maia 2600 at CP budget 58, and the greeting says so, with the range the Budget rows give', { x0, chat: xg.chat });
check(await p2.evaluate(() => lbLogLines.some(l => /Playing at Maia 2600, CP budget 58 \(plays like 2700\): BudgetUser is rated 2900/.test(l))),
  'the host\'s log gives the Budget beside the setting when it isn\'t the builder\'s');
check([greeting(2775, 'Flounder 2400', 300, 600, 2775, 'highest', 15.5, 9.9),
  greeting(2775, 'Maia 2600', 300, 600, 2775, 'highest', 'mirror', 4)].every(gr => gr.split('\n').every(l => l.length <= 140)),
  'every line of the longest greetings fits a Lichess chat line (140)');
// Time pressure moves the setting, not the Budget: Maia 2600 plays 2025 at the
// builder's Budget, so 1 s a move is Regan's loss from there, at cp58 still.
const xc = await curveNow();
const xWant1 = 2025 + reganD(1) - reganD(5);
check(xc.find(p => p.x === 200)?.y === 2600 && xc.find(p => p.x === 1)?.y === Math.round(1000 + (xWant1 - 1125) * 500 / 375),
  'its curve still loses Regan\'s strength there, through the setting', xc);
// 700 is 100 of the 250 from cp300 (600) to the builder's Budget (850).
await command(xg, 'ELO700');
const x1 = await cpNow(), cp700 = Math.round(300 + (B - 300) * 100 / 250);
check(lastSaid(xg) === perf(700, null, 'Maia 600', cp700) && await maiaNow() === 600 && x1.budget === cp700 &&
  x1.floor === Math.max(x1.builtFloor, cp700),
  'ELO700: below Maia 600\'s own 850, the Budget rises instead (cp' + cp700 + '), and the Floor with it', { said: lastSaid(xg), x1 });
await pastCooldown();
await command(xg, 'ELO3000');
check(lastSaid(xg) === perf(2775, 'highest', 'Maia 2600', 50) && (await cpNow()).budget === 50,
  'ELO3000: stops at 2775, Maia 2600 at cp50, and says so', lastSaid(xg));
await pastCooldown();
await command(xg, 'ELO100');
check(lastSaid(xg) === perf(600, 'lowest', 'Maia 600', 300) && (await cpNow()).budget === 300,
  'ELO100: stops at 600, Maia 600 at cp300, and says so', lastSaid(xg));
await pastCooldown();
await command(xg, 'cp120');
check(lastSaid(xg) === 'CP budget set to 120' && (await cpNow()).budget === 120 && await maiaNow() === 600,
  'a Budget they ask for replaces the table\'s', lastSaid(xg));
await pastCooldown();
await command(xg, 'ELO1500');
check(lastSaid(xg) === perf(1500, null, 'Maia 1500', B) && (await cpNow()).budget === B && await maiaNow() === 1500,
  'a rating on its own brings back the Budget that goes with it', lastSaid(xg));
check(xg.status === 'started', 'the Budget-row game was still going throughout', xg.status);
await endGame(xg);
// Its ratings were measured picking as it was built; under a temp they are
// not what it plays at, and the reply says so. A game of its own, so the one
// above lasts no longer than it did.
// Built with Blind Conviction, as Blundermind-01 is: its default is temp 10.
const builtBlind = await p2.evaluate(() => { const b = botBlindConviction; botBlindConviction = true; return b; });
const vg = await openGame({ id: 'caveatuser', name: 'CaveatUser', rating: 1700 }, 3000);
await greeted(vg);
check(greetOf(vg).split('\n')[0].endsWith(', think auto, temp 10') && (vg.spect[0] || {}).text === greetOf(vg).split('\n')[0],
  'a Blind Conviction bot: temp 10 is its default, and the greeting says so (to the spectators too)', vg.chat[0]);
await command(vg, 'temp0');
check(lastSaid(vg) === "Temp set to 0 (Maia's top move, no personality). Its ELO was measured at temp 10.",
  'a measured bot under a temp: the reply says where its ELO was measured', lastSaid(vg));
await pastCooldown();
await command(vg, 'ELO1500');
check(lastSaid(vg) === perf(1500, null, 'Maia 1500', B) + '. Its ELO was measured at temp 10.',
  'and so does a rating asked for under it', lastSaid(vg));
await pastCooldown();
await command(vg, 'temp10');
check(lastSaid(vg) === "Temp set to 10 (personality's pick)" && await tempNow() === 10,
  'temp10: where it was measured, nothing to add', lastSaid(vg));
await pastCooldown();
await command(vg, 'temp auto');
check(lastSaid(vg) === "Temp back to the bot's own pick" && await tempNow() === null, 'temp auto: as built', lastSaid(vg));
await endGame(vg);
await p2.evaluate(b => { botBlindConviction = b; }, builtBlind);
await p2.evaluate(() => { window._lastAppliedBotConfig.lichessStrength = null; });

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
const afterOff = await p2.evaluate(() => ({ maia: maia3SelectedRating, top: Math.max(...botPressureCurveA.map(p => p.y)),
  budget: window._bcpCpBudget, built: window._lastAppliedBotConfig.cpBudget, temp: botBlendTemp, chatTemp: botChatMaiaTemp }));
check(afterOff.maia === 2200 && afterOff.top === 2200 && afterOff.budget === afterOff.built && afterOff.temp === null &&
  afterOff.chatTemp === null,
  'and local games play the bot as built, not at the last challenger\'s rating or Budget', afterOff);
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

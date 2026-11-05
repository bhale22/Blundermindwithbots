// End-to-end check of the bot runner (bot-runner/runner.mjs) against a
// stand-in Lichess: setup mode saves a bot file from the Bot Builder's own
// connect flow, then the runner hosts that bot headless — connects, plays a
// game, restarts a browser that dies, and tries again after Lichess turns it
// away. The bridge itself is checked by verify-lichess-bridge.mjs; this is
// about what keeps a page alive around it.
//
// Run with the dev server up on :3100 (takes about three minutes):
//   node scripts/verify-bot-runner.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 3198;
const TOKEN = 'lip_runner_test';
const BOT = { id: 'bmrunnerbot', name: 'BMRunnerBot', title: 'BOT', rating: 1500 };
const HUMAN = { id: 'testhuman', name: 'TestHuman', rating: 1600 };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let pass = 0, fail = 0;
function check(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(250); }
  if (label) console.log('    (timed out waiting for ' + label + ')');
  return false;
}

// The runner's log, read back by some checks.
const logged = [];
const realLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); realLog(...a); };

// ── The runner, pointed at this machine ─────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-runner-test-'));
process.env.BM_SITE = 'http://localhost:3100';
process.env.BM_LICHESS_API = 'http://localhost:' + MOCK_PORT;
process.env.BM_BOTS_DIR = path.join(TMP, 'bots');
process.env.BM_PROFILES_DIR = path.join(TMP, 'profiles');
// Setup's window is headless here: this script is the one at the keyboard.
const realLaunch = chromium.launchPersistentContext.bind(chromium);
let setupCtx = null, setupDir = null;
chromium.launchPersistentContext = async (dir, o) => {
  const ctx = await realLaunch(dir, Object.assign({}, o, { headless: true, viewport: { width: 1280, height: 800 } }));
  if (o && o.headless === false) { setupCtx = ctx; setupDir = dir; }
  return ctx;
};
const { Host, readBots, setup, envName, envValue } = await import('../bot-runner/runner.mjs');

// ── Chess rules for the stand-in: the app's own core, run in a vm ──────────
const core = { document: { getElementById: () => null }, indActive: () => false, console };
vm.createContext(core);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', '20-chess-core.js'), 'utf8'), core);
const sqOf = s => core.fileRankToSq(s);
const nameOf = i => core.sqName(i);

// ── The stand-in Lichess: what a hosted bot touches, and a random opponent ──
const M = { eventStreams: new Set(), challenges: {}, games: {}, accountFails: 0 };
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
    id, status: 'created', direction: 'in', challenger: HUMAN, destUser: BOT,
    variant: { key: 'standard' }, rated: false, speed: 'blitz',
    timeControl: { type: 'clock', limit: 180, increment: 2 }, color: o.color || 'random',
  };
  M.challenges[id] = { c, opts: o.opts || {}, declined: null, accepted: false };
  sendEvent({ type: 'challenge', challenge: c });
  return id;
}
function newGame(ch) {
  const id = ('gm' + (++seq) + 'abcdefgh').slice(0, 8);
  const tc = ch.c.timeControl;
  const g = {
    id, botWhite: ch.c.color === 'black', opts: ch.opts,
    clock: { initial: tc.limit * 1000, increment: tc.increment * 1000 },
    wtime: tc.limit * 1000, btime: tc.limit * 1000,
    bd: core.parseFen(START), turn: 'w', cst: { wK: true, wQ: true, bK: true, bQ: true }, ep: -1,
    moves: [], status: 'started', winner: null, streams: new Set(), botPosts: [], refused: [], oppBusy: false,
  };
  M.games[id] = g;
  return g;
}
const botLetter = g => g.botWhite ? 'w' : 'b';
function state(g) {
  const st = { type: 'gameState', moves: g.moves.join(' '), wtime: g.wtime, btime: g.btime,
    winc: g.clock.increment, binc: g.clock.increment, status: g.status, wdraw: false, bdraw: false };
  if (g.winner) st.winner = g.winner;
  return st;
}
function full(g) {
  return { type: 'gameFull', id: g.id, variant: { key: 'standard' }, speed: 'blitz', rated: false,
    white: g.botWhite ? BOT : HUMAN, black: g.botWhite ? HUMAN : BOT,
    initialFen: 'startpos', clock: g.clock, state: state(g) };
}
function broadcast(g) {
  const st = state(g);
  for (const r of g.streams) line(r, st);
  if (g.status !== 'started') {
    for (const r of g.streams) { try { r.end(); } catch (e) {} }
    g.streams.clear();
  }
}
function finish(g, status, winner) {
  if (g.status !== 'started') return;
  g.status = status; g.winner = winner || null;
  broadcast(g);
}
function play(g, uci) {
  const from = sqOf(uci.slice(0, 2)), to = sqOf(uci.slice(2, 4));
  const p = g.bd[from];
  if (!p || p.color !== g.turn || !core.legalMovesFor(from, g.bd, g.ep, g.cst).includes(to)) return false;
  const ne = core.computeEP(from, to, g.bd);
  g.cst = core.updateCastling(from, to, p, g.cst);
  g.bd = core.applyMove(from, to, g.bd, g.ep, uci[4] ? uci[4].toUpperCase() : 'Q');
  g.ep = ne;
  g.turn = g.turn === 'w' ? 'b' : 'w';
  g.moves.push(uci);
  if (!core.allLegalMoves(g.bd, g.turn, g.ep, g.cst).length) {
    if (core.inCheck(g.bd, g.turn)) { g.status = 'mate'; g.winner = g.turn === 'w' ? 'black' : 'white'; }
    else g.status = 'stalemate';
  }
  return true;
}
function opponentTurn(g) {
  if (g.oppBusy || g.status !== 'started' || g.turn === botLetter(g)) return;
  g.oppBusy = true;
  setTimeout(() => {
    g.oppBusy = false;
    if (g.status !== 'started' || g.turn === botLetter(g)) return;
    if (g.opts.resignAtPly != null && g.moves.length >= g.opts.resignAtPly) { finish(g, 'resign', g.botWhite ? 'white' : 'black'); return; }
    const all = core.allLegalMoves(g.bd, g.turn, g.ep, g.cst);
    const mv = all[Math.floor(Math.random() * all.length)];
    const p = g.bd[mv.from];
    play(g, nameOf(mv.from) + nameOf(mv.to) + (p.piece === 'P' && (mv.to < 8 || mv.to >= 56) ? 'q' : ''));
    broadcast(g);
  }, 300);
}
function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res, 204); res.end(); return; }
  if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) { json(res, 401, { error: 'No such token' }); return; }
  const p = new URL(req.url, 'http://x').pathname;
  let m;
  if (req.method === 'GET' && p === '/api/account') {
    if (M.accountFails > 0) { M.accountFails--; json(res, 500, { error: 'Stand-in outage' }); return; }
    json(res, 200, { id: BOT.id, username: BOT.name, title: 'BOT', count: { all: 0 } });
    return;
  }
  if (req.method === 'GET' && p === '/api/stream/event') {
    cors(res, 200, 'application/x-ndjson');
    M.eventStreams.add(res);
    const ka = setInterval(() => { try { res.write('\n'); } catch (e) {} }, 3000);
    req.on('close', () => { clearInterval(ka); M.eventStreams.delete(res); });
    for (const g of Object.values(M.games)) if (g.status === 'started')
      line(res, { type: 'gameStart', game: { gameId: g.id, id: g.id } });
    return;
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/challenge\/(\w+)\/(accept|decline)$/))) {
    const ch = M.challenges[m[1]];
    if (!ch) { json(res, 404, { error: 'Not found' }); return; }
    if (m[2] === 'decline') { ch.declined = new URLSearchParams(await readBody(req)).get('reason') || 'generic'; json(res, 200, { ok: true }); return; }
    ch.accepted = true;
    const g = newGame(ch);
    ch.gameId = g.id;
    json(res, 200, { ok: true });
    setTimeout(() => sendEvent({ type: 'gameStart', game: { gameId: g.id, id: g.id } }), 100);
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
    const mv = m[2].match(/^move\/(\w+)$/);
    if (mv) {
      g.botPosts.push(mv[1]);
      if (g.status !== 'started' || g.turn !== botLetter(g) || !play(g, mv[1])) { g.refused.push(mv[1]); json(res, 400, { error: 'Refused' }); return; }
      json(res, 200, { ok: true });
      broadcast(g);
      opponentTurn(g);
      return;
    }
    json(res, 200, { ok: true });   // draw answers, takebacks, claims: not exercised here
    return;
  }
  json(res, 404, { error: 'Not found ' + p });
});
await new Promise(r => server.listen(MOCK_PORT, r));

let host = null, hostRun = null;
try {
  // ── 1. Setup mode ─────────────────────────────────────────────────────────
  console.log('\n1. Setting a bot up');
  const setupDone = setup('testbot');
  await until(() => setupCtx && setupCtx.pages().length, 30000, 'the setup window');
  const sp = setupCtx.pages()[0];
  const f = await (await sp.waitForSelector('#botModalFrame', { timeout: 60000 })).contentFrame();
  await f.waitForFunction(() => typeof lbcOpen === 'function' && !document.getElementById('qs-lichess-row').hidden, null, { timeout: 60000 });
  check(await sp.evaluate(() => document.getElementById('botModal').style.display !== 'none'), 'the window opens on the Bot Builder');
  await f.click('#qs-lichess-btn');
  await f.waitForFunction(() => document.getElementById('lbc-overlay')?.classList.contains('show'), null, { timeout: 10000 });
  await f.fill('#lbc-token', TOKEN);
  await f.click('#lbc-connect-btn');
  const file = path.join(TMP, 'bots', 'testbot.json');
  await until(() => fs.existsSync(file), 30000, 'the bot file');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const pageBot = await sp.evaluate(() => botGenerateName());
  check(saved.account === BOT.name && saved.lichess && saved.lichess.token === TOKEN,
    'connecting from the builder saves the account and its token', { account: saved.account });
  check(saved.lastBot && saved.lastBot.cfg && saved.lastBot.cfg.type === 'botConfig' && saved.bot === pageBot,
    'and the bot the page plays, whole (' + pageBot + ')', { bot: saved.bot });
  check(!('auto' in saved.lichess) && saved.site === process.env.BM_SITE, 'and the site it was set up on', saved.site);
  await sp.close();
  const code = await Promise.race([setupDone, sleep(15000).then(() => 'hung')]);
  check(code === 0, 'closing the window ends setup', code);
  check(setupDir && !fs.existsSync(setupDir), 'and its throwaway browser profile is deleted');
  await until(() => M.eventStreams.size === 0, 5000);
  check(M.eventStreams.size === 0, 'the closed window is no longer connected');

  // ── 1b. As a variable ─────────────────────────────────────────────────────
  // How Railway hands the runner a bot: the same file, in BM_BOT_<NAME>.
  console.log('\n1b. The bot file as a variable');
  const v = envValue(saved);
  check(envName('pre-move90') === 'BM_BOT_PRE_MOVE90' && /^[A-Za-z0-9+/=]+$/.test(v),
    'env makes BM_BOT_<NAME> with a base64 value, nothing in it to quote', envName('pre-move90'));
  process.env.BM_BOT_FROMENV = v;
  process.env.BM_BOT_RAWJSON = JSON.stringify(saved);
  process.env.BM_BOT_BROKEN = 'not a bot';
  process.env.BM_BOT_TESTBOT = envValue(Object.assign({}, saved, { bot: 'from the variable' }));
  const fromEnv = readBots();
  const byName = Object.fromEntries(fromEnv.map(b => [b.name, b]));
  check(byName.fromenv && byName.fromenv.lichess.token === TOKEN && JSON.stringify(byName.fromenv.lastBot) === JSON.stringify(saved.lastBot),
    'the runner reads it back whole, named after the variable', Object.keys(byName));
  check(byName.rawjson && byName.rawjson.lichess.token === TOKEN, 'and takes plain JSON too');
  check(!byName.broken && logged.some(l => /Skipping BM_BOT_BROKEN: not a bot file, 9 characters/.test(l)), 'and skips one that is not a bot, saying so');
  check(fromEnv.length === 3 && byName.testbot.bot === 'from the variable' && logged.some(l => /\[testbot\] BM_BOT_TESTBOT replaces bots\/testbot\.json/.test(l)),
    'a variable stands in for a file of the same name', fromEnv.map(b => b.name));
  for (const k of ['BM_BOT_FROMENV', 'BM_BOT_RAWJSON', 'BM_BOT_BROKEN', 'BM_BOT_TESTBOT']) delete process.env[k];

  // ── 2. Hosting ────────────────────────────────────────────────────────────
  console.log('\n2. Hosting it');
  const bots = readBots();
  check(bots.length === 1 && bots[0].name === 'testbot', 'the runner finds the bot file', bots.map(b => b.name));
  host = new Host(bots[0]);
  hostRun = host.run();
  const hostState = () => host.page ? host.page.evaluate(() => typeof lbState === 'undefined' ? null : lbState) : null;
  await until(async () => (await hostState()) === 'waiting', 60000, 'waiting');
  check(await hostState() === 'waiting' && M.eventStreams.size === 1, 'the headless page connects by itself and waits for challenges');
  check(await host.page.evaluate(() => botGenerateName()) === saved.bot, 'it plays the saved bot, not the site\'s default',
    await host.page.evaluate(() => botGenerateName()));
  check(await host.page.evaluate(() => /(^|[?&])lichess(&|$)/.test(location.search) && document.getElementById('lbPanel').style.display !== 'none'),
    'on a ?lichess host page, its Lichess panel showing');
  await until(() => host.page.evaluate(() => _lbEnginesReady()), 180000, 'engines');
  // Its own look at the page, every 15 s, says what it found.
  await until(() => logged.some(l => /Engines ready/.test(l)), 40000, 'the runner\'s report');
  check(logged.some(l => l.includes('[testbot] Plays as ' + saved.bot + ' on @' + BOT.name)) && logged.some(l => /\[testbot\] Engines ready/.test(l)),
    'the runner\'s log names the bot and the account, and says when the engines are ready');
  const ch1 =newChallenge({ color: 'white', opts: { resignAtPly: 10 } });
  await until(() => M.challenges[ch1].gameId, 10000, 'accept');
  const g1 = M.games[M.challenges[ch1].gameId];
  check(!!g1, 'it accepts a challenge');
  await until(() => g1 && g1.status !== 'started', 180000, 'game 1 to finish');
  check(g1 && g1.status === 'resign' && g1.botPosts.length >= 4 && !g1.refused.length,
    'and plays the game out (' + (g1 ? g1.moves.length : 0) + ' plies)', g1 && { status: g1.status, refused: g1.refused });

  // ── 3. A browser that dies ────────────────────────────────────────────────
  console.log('\n3. Its browser dies');
  const firstCtx = host.ctx;
  await firstCtx.close();   // as if Chromium had crashed or been killed
  await until(async () => host.ctx && host.ctx !== firstCtx && (await hostState()) === 'waiting', 90000, 'a new browser');
  check(host.ctx !== firstCtx && await hostState() === 'waiting', 'the runner starts a new browser, connected again');
  check(fs.existsSync(path.join(TMP, 'profiles', 'testbot')), 'in the same browser profile');

  // ── 3b. A Maia bot ────────────────────────────────────────────────────────
  // The same file with a Maia pick on top, the way the page itself records a
  // quick-start pick made over a builder config.
  console.log('\n3b. A Maia bot downloads the model once');
  fs.writeFileSync(path.join(TMP, 'bots', 'maiabot.json'),
    JSON.stringify(Object.assign({}, saved, { lastBot: Object.assign({}, saved.lastBot, { pick: 'maia:1500' }) })));
  const downloads = async () => { const s = await (await fetch('http://localhost:3100/api/model-stats')).json(); return s.completed + s.partial; };
  const dl0 = await downloads();
  const mh = new Host(readBots().find(b => b.name === 'maiabot'));
  const mRun = mh.run();
  const maiaReady = () => mh.page && mh.page.evaluate(() => lbState === 'waiting' && _lbNeedsMaia() && _lbEnginesReady());
  await until(maiaReady, 240000, 'Maia');
  check(await maiaReady(), 'a Maia bot fetches the model and gets ready (' + await mh.page.evaluate(() => botGenerateName()) + ')');
  check(await downloads() === dl0 + 1, 'one download of it', (await downloads()) - dl0);
  const mCtx = mh.ctx;
  await mCtx.close();
  await until(async () => mh.ctx && mh.ctx !== mCtx && await maiaReady(), 120000, 'Maia after the restart');
  check(mh.ctx !== mCtx && await maiaReady(), 'after a restart it is ready again');
  check(await downloads() === dl0 + 1, 'without downloading the model again', (await downloads()) - dl0);
  mh.stopping = true;
  await mh.close();
  await mRun;

  // ── 4. Lichess turns it away ──────────────────────────────────────────────
  console.log('\n4. Lichess turns it away, then comes back');
  M.accountFails = 1;
  const loadedBefore = host.loadedAt;
  await host.page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => (await hostState()) === 'error', 20000, 'the error');
  check(await hostState() === 'error', 'the bridge gives up after a failed connect (it does not retry by itself)');
  await until(() => logged.some(l => /\[testbot\] Not connected \(Lichess answered 500/.test(l)), 30000, 'the runner\'s note');
  check(logged.some(l => /\[testbot\] Not connected \(Lichess answered 500.*trying again in 1 min/.test(l)), 'the runner logs why, and when it tries again');
  await until(async () => host.loadedAt !== loadedBefore && (await hostState()) === 'waiting', 120000, 'the retry');
  check(host.loadedAt !== loadedBefore && await hostState() === 'waiting', 'the runner opens the page again a minute later, and it connects');

  // ── 5. Stopping ───────────────────────────────────────────────────────────
  console.log('\n5. Stopping');
  host.stopping = true;
  await host.close();
  const ended = await Promise.race([hostRun.then(() => true), sleep(30000).then(() => false)]);
  await until(() => M.eventStreams.size === 0, 5000);
  check(ended && M.eventStreams.size === 0, 'it stops, and its connection to Lichess closes');
  host = null;
} catch (e) {
  fail++;
  console.log('  ✗ threw: ' + (e && e.stack || e));
} finally {
  if (host) { host.stopping = true; await host.close(); }
  if (setupCtx) { try { await setupCtx.close(); } catch (e) {} }
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

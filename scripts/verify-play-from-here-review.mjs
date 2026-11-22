// "Play from here", then review: does the review replay the whole game?
//
// A game played on from a reviewed position keeps the moves before that point
// (_gameStartSans), and its review replays them all. It used to replay them
// from the position AFTER them (_gameStartFen), so the review broke at the
// first move. And when the reviewed game had itself begun from a set position
// or a Chess960 deal, the saved PGN was written from move 1 of a normal game
// and would not load. The moves' own start now travels with them
// (_gameStartBase; _pgnSetupFen reads it), through bot games, puzzles and
// 2-player rooms (the server relays it as startBase).
//
// Needs the dev server on :3100 (or BM_URL), running this server.js for the
// 2-player part. PW_CHROMIUM=<path> to use a system Chromium.
import { chromium } from 'playwright';
const BASE = process.env.BM_URL || 'http://localhost:3100/';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); }
  throw new Error('timed out: ' + (what || 'condition'));
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    try { ['bm_welcomed', 'bm_landingSeen', 'bm_bottour'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  page._errors = [];
  page.on('pageerror', e => page._errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof parsePgnAndStartReplay === 'function' && typeof botStart === 'function');
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  return page;
}
const fen4 = 'boardToFen(board, turn, castling, epSq).split(" ").slice(0, 4).join(" ")';

// Load `pgn`, review to ply k, "Play from here" against a bot, play `extra`
// (UCI, both sides: the bot is kept from moving), end the game, review it.
const page = await newPage();
const viaBot = (pgn, k, extra) => page.evaluate(async ({ pgn, k, extra, fen4 }) => {
  const f4 = () => eval(fen4);
  parsePgnAndStartReplay(pgn);
  rebuildToReplayIdx(k);
  const at = f4();
  window._pendingStartPos = _replayCurrentPos();
  const sp = window._pendingStartPos;
  _exitReplayKeepBoard();
  botSetTab('sf');
  botColorPref = 'white';
  botSelectedTC = 'untimed';
  const mk = botMakeMove;
  window.botMakeMove = async () => {};
  botStart();
  const startOk = _gameStartFen === sp.fen;
  for (const u of extra) { const m = uciToSq(u); executeMove(m.from, m.to, m.promo || null); }
  const live = f4();
  const pgnOut = buildPgnText().pgn;
  gameOver = true; gameOverMsg = 'White resigns';
  window.botMakeMove = mk;
  startReplayOfCurrentGame();
  const opened = inReplay;
  replayGo(-1);
  const rev = f4(), revMoves = replayMoves.slice(), base = replayBaseFen;
  rebuildToReplayIdx(k);
  const revAtK = f4();
  parsePgnAndStartReplay(pgnOut);
  replayGo(-1);
  const reload = f4();
  _exitReplayKeepBoard();
  return { opened, at, sp, startOk, live, rev, revMoves, base, revAtK, pgnOut, reload, c960: chess960 };
}, { pgn, k, extra, fen4 });

console.log('\n1. A normal game, played on from move 3 against a bot (the bug as reported)');
{
  const r = await viaBot('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *', 5, ['a7a6', 'b5a4']);
  ok('the bot game starts from the reviewed position', r.startOk, r.sp);
  ok('its review opens', r.opened);
  ok('and replays every move, to the game\'s last position', r.rev === r.live && r.revMoves.length === 7, { rev: r.rev, live: r.live, moves: r.revMoves });
  ok('from the standard start', r.base === null, r.base);
  ok('passing through the position it was played on from', r.revAtK === r.at, { revAtK: r.revAtK, at: r.at });
  ok('the saved PGN loads back to the same position', r.reload === r.live, { reload: r.reload });
}

console.log('\n2. A set position (move 30, Black to move), played on after two moves');
{
  const SET = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 30';
  const r = await viaBot('[SetUp "1"]\n[FEN "' + SET + '"]\n\n30... h6 31. g3 Kh7 32. Kg2 *\n', 2, ['g8h7', 'g1g2', 'g7g6']);
  ok('the position played on from carries the move number on: 31', / 31$/.test(r.sp.fen) && r.sp.base === SET, r.sp);
  ok('the review replays every move from the set position', r.opened && r.rev === r.live && r.base === SET, { rev: r.rev, live: r.live, base: r.base });
  ok('the PGN names the set position and counts from move 30', r.pgnOut.includes('[FEN "' + SET + '"]') && /\n30\.\.\. h6 31\. g3 Kh7 32\. Kg2 g6/.test(r.pgnOut), r.pgnOut);
  ok('and loads back to the same position', r.reload === r.live, { reload: r.reload });
}

console.log('\n3. A Chess960 game, played on from move 2');
{
  const DEAL = await page.evaluate(() => chess960StartFen(418));
  const r = await viaBot('[Variant "Chess960"]\n[SetUp "1"]\n[FEN "' + DEAL + '"]\n\n1. e4 e5 2. d4 *\n', 2, ['d2d4', 'e5d4']);
  ok('Chess960 stays on', r.c960 === true);
  ok('the review replays from the deal', r.opened && r.rev === r.live && r.base === DEAL, { rev: r.rev, live: r.live, base: r.base });
  ok('the PGN gives the deal and the variant', r.pgnOut.includes('[FEN "' + DEAL + '"]') && r.pgnOut.includes('[Variant "Chess960"]'), r.pgnOut);
  ok('and loads back to the same position', r.reload === r.live, { reload: r.reload });
}

console.log('\n4. Played on from the very start: nothing before it');
{
  const r = await viaBot('1. e4 e5 2. Nf3 *', 0, ['e2e4', 'e7e5']);
  ok('the review replays the game', r.opened && r.rev === r.live && r.revMoves.join(' ') === 'e4 e5', { rev: r.rev, moves: r.revMoves });
}
ok('no page errors', !page._errors.length, page._errors.slice(0, 3));

console.log('\n5. 2-player: a friend invited to play on from a set position');
{
  const SET = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 30';
  const host = await newPage(), guest = await newPage();
  await host.evaluate(({ SET }) => {
    parsePgnAndStartReplay('[SetUp "1"]\n[FEN "' + SET + '"]\n\n30... h6 31. g3 Kh7 *\n');
    rebuildToReplayIdx(2);
    playFromHereInvite();
    mpSetHostColor('black');
    mpCreatePrivate();
  }, { SET });
  await until(() => host.evaluate(() => !!mpRoomId), 8000, 'the room');
  const code = await host.evaluate(() => mpRoomId);
  await guest.evaluate(code => { document.getElementById('mpJoinCode').value = code; mpJoinRoom(); }, code);
  await until(async () => (await guest.evaluate(() => mpMode === 'ingame')) && (await host.evaluate(() => mpMode === 'ingame')), 8000, 'both in the game');
  await sleep(500);
  const st = p => p.evaluate(() => ({ start: _gameStartFen, sans: _gameStartSans.join(' '), base: _gameStartBase, role: mpRole }));
  const hs = await st(host), gs = await st(guest);
  ok('both sides start from the same position, with the moves before it and where they began',
    hs.start === gs.start && hs.sans === 'h6 g3' && gs.sans === 'h6 g3' && hs.base === SET && gs.base === SET, { hs, gs });
  // Black (the host) to move: Kh7, Kg2, g6.
  const sides = { white: hs.role === 'white' ? host : guest, black: hs.role === 'white' ? guest : host };
  const plays = [['black', 'g8', 'h7'], ['white', 'g1', 'g2'], ['black', 'g7', 'g6']];
  for (let i = 0; i < plays.length; i++) {
    const [who, f, t] = plays[i];
    await sides[who].evaluate(([f, t]) => tryCommit(fileRankToSq(f), fileRankToSq(t), null), [f, t]);
    const other = sides[who] === host ? guest : host;
    await until(() => other.evaluate(n => gameMovesAlgebraic.length === n, 2 + i + 1), 5000, 'move ' + (i + 1) + ' across');
  }
  for (const p of [host, guest]) {
    const r = await p.evaluate(({ fen4 }) => {
      const f4 = () => eval(fen4);
      const live = f4(), pgn = buildPgnText().pgn;
      gameOver = true; gameOverMsg = 'Draw agreed';
      startReplayOfCurrentGame();
      const opened = inReplay;
      replayGo(-1);
      return { opened, live, rev: f4(), base: replayBaseFen, pgn };
    }, { fen4 });
    const who = p === host ? 'host' : 'guest';
    ok('the ' + who + '\'s review replays every move from the set position', r.opened && r.rev === r.live && r.base === SET, r);
    ok('and the ' + who + '\'s PGN gives it', r.pgn.includes('[FEN "' + SET + '"]') && /30\.\.\. h6 31\. g3 Kh7 32\. Kg2 g6/.test(r.pgn), r.pgn);
  }
  ok('no page errors in the 2-player pages', [host, guest].every(p => !p._errors.length), [host, guest].map(p => p._errors.slice(0, 2)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);

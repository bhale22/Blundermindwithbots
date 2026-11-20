// Chess960 on the site, end to end in a real browser:
//   1. Quick start dealt a Chess960 game against a Flounder (Stockfish) bot,
//      played out with the player castling whenever it can; the game's PGN is
//      then checked move by move by python-chess, which knows Chess960.
//   2. Castling by hand: click the king then its rook, and drag the king onto
//      it, from positions where the castle is legal on move 1 (the king and rook
//      trading squares, and the king moving one square).
//   3. A takeback over a castle, and a page reload in the middle of a game.
//   4. PGN in and out, and review.
//   5. Maia's castle: asked under the standard spelling, answered as king takes
//      rook (the model itself is not needed for this).
//   6. The builder's Play as picker carries the variant.
//   7. 2-player: a private room and an open challenge, both clients on the same
//      dealt position, moves (a castle among them) arriving on the other board.
//   8. A standard game afterwards is standard again, Stockfish included.
//
// No network or Maia download needed. Needs the dev server on :3100 (or BM_URL),
// and python with python-chess for the PGN check (skipped, and said so, without).
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = process.env.BM_URL || 'http://localhost:3100/';
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(150); }
  if (label) console.log('    (timed out waiting for ' + label + ')');
  return false;
}

// python-chess, if there is one: the independent judge of a Chess960 PGN.
function pyCheckPgn(pgn) {
  const f = path.join(os.tmpdir(), 'bm960-' + process.pid + '-' + Date.now() + '.pgn');
  fs.writeFileSync(f, pgn);
  const code = [
    'import sys, chess.pgn',
    'g = chess.pgn.read_game(open(sys.argv[1]))',
    'b = g.board()',
    'n = 0',
    'for m in g.mainline_moves():',
    '    assert b.is_legal(m), (n, m.uci())',
    '    b.push(m); n += 1',
    'print(n, "1" if b.chess960 else "0", b.board_fen(), len(g.errors))',
  ].join('\n');
  try {
    const out = execFileSync('python', ['-c', code, f], { encoding: 'utf8' }).trim().split(' ');
    return { plies: +out[0], is960: out[1] === '1', boardFen: out[2], errors: +out[3] };
  } catch (e) {
    return { error: String(e.stderr || e.message).trim().split('\n').pop() };
  } finally { try { fs.unlinkSync(f); } catch (e) {} }
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    try {
      ['bm_welcomed', 'bm_landingSeen', 'bm_bottour', 'bm_tour_pro', 'bm_tour_amateur']
        .forEach(k => localStorage.setItem(k, '1'));
    } catch (e) {}
  });
  const page = await ctx.newPage();
  page._errors = [];
  page.on('pageerror', e => page._errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof quickBotPick === 'function' && typeof setChess960 === 'function');
  await page.waitForTimeout(800);
  return page;
}

// The centre of a square on screen, whichever way round the board is drawn.
const sqPoint = (page, name) => page.evaluate(name => {
  const sq = fileRankToSq(name), cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
  const fl = boardViewFlipped(), c = sq % 8, row = Math.floor(sq / 8);
  const dc = fl ? 7 - c : c, dr = fl ? 7 - row : row;
  return { x: r.left + (dc + 0.5) * r.width / 8, y: r.top + (dr + 0.5) * r.height / 8 };
}, name);
async function clickSq(page, name) { const p = await sqPoint(page, name); await page.mouse.click(p.x, p.y); await sleep(120); }
async function dragSq(page, a, b) {
  const p = await sqPoint(page, a), q = await sqPoint(page, b);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); await sleep(150);
}
const pieceAt = (page, name) => page.evaluate(n => { const p = board[fileRankToSq(n)]; return p ? p.color + p.piece : null; }, name);

// A quick, Stockfish-only bot that answers at once.
async function fastBot(page) {
  await page.evaluate(() => {
    quickBotPick('1200');
    quickBotSetTime('0+0');
    botTimeBehavior = 'fixed'; botFixedDelayMs = 150;
  });
}
// Start a bot game from a given Chess960 position, the player White.
async function startFrom960(page, n) {
  await page.evaluate(n => {
    window._pendingStartPos = { fen: chess960StartFen(n), sans: [], chess960: true };
    botSetPlayerColor('white');
    botStart();
    botTimeBehavior = 'fixed'; botFixedDelayMs = 150;
  }, n);
  await until(() => page.evaluate(() => botActive && turn === 'w'), 5000);
}

// ── 1. Quick start, played out ─────────────────────────────────────────────
console.log('\n1. Quick start: a Chess960 game against Flounder, played out');
const page = await newPage();
await fastBot(page);
await page.selectOption('#quickBotVariant', 'chess960');
ok('the quick start shows the variant', await page.evaluate(() => botVariantPref) === 'chess960');
await page.click('#quickStartBtn');
await until(() => page.evaluate(() => botActive), 5000);
const g1 = await page.evaluate(() => ({ on: chess960, start: _gameStartFen, n: chess960NumberOf(_gameStartFen),
  tag: document.getElementById('variantTag').textContent, tagShown: document.getElementById('variantTag').style.display !== 'none',
  me: botPlayerColor }));
ok('the game is Chess960, from a dealt position', g1.on && g1.n >= 0, g1);
ok('the board names it: ' + g1.tag, g1.tagShown && g1.tag === 'Chess960 · #' + g1.n, g1.tag);
// Play the human side: castle whenever possible, else a random legal move.
const myLetter = g1.me === 'white' ? 'w' : 'b';
let humanCastles = 0, plies = 0;
for (let i = 0; i < 80; i++) {
  // A finished bot game opens its review at once (and review clears gameOver).
  const done = await until(() => page.evaluate(l => gameOver || inReplay || (turn === l && !botThinking), myLetter), 30000);
  if (!done || await page.evaluate(() => gameOver || inReplay)) break;
  const r = await page.evaluate(() => {
    const all = allLegalMoves(board, turn, epSq, castling);
    const cs = all.filter(m => isCastleMove(board, m.from, m.to));
    const m = cs.length ? cs[0] : all[Math.floor(Math.random() * all.length)];
    return { castle: cs.length > 0, ok: tryCommit(m.from, m.to, board[m.from].piece === 'P' && (m.to < 8 || m.to >= 56) ? 'Q' : null) };
  });
  if (r.castle) humanCastles++;
  plies = await page.evaluate(() => gameMovesAlgebraic.length);
  if (plies >= 60) break;
}
// The bot's last move can end the game after the player's last turn.
plies = await page.evaluate(() => gameMovesAlgebraic.length);
const ended1 = await page.evaluate(() => inReplay ? 'ended, review open' : gameOver ? gameOverMsg : 'still on');
// A random-moving player can be mated early; that is a game played out too.
ok('the game ran (' + plies + ' plies, ' + humanCastles + ' castle by the player; ' + ended1 + ')', plies >= 20 || ended1 !== 'still on', plies);
ok('Stockfish was told it is playing Chess960', await page.evaluate(() => sfWorker && sfWorker._bm960 === true));
const pgn1 = await page.evaluate(() => buildPgnText().pgn);
ok('the PGN says Chess960 and gives the start position', /\[Variant "Chess960"\]/.test(pgn1) && pgn1.includes('[FEN "' + g1.start + '"]'));
const py1 = pyCheckPgn(pgn1);
if (py1.error && /No module|not found|not recognized/i.test(py1.error)) console.log('  (python-chess not available: PGN check skipped)');
else {
  const boardFen1 = await page.evaluate(() => boardToFen(board, turn, castling, epSq).split(' ')[0]);
  ok('python-chess finds every move legal (' + py1.plies + ' plies) and reads it as Chess960', !py1.error && py1.is960 && py1.plies === plies && py1.errors === 0, py1);
  ok('and ends on the same board as the page', py1.boardFen === boardFen1, { py: py1.boardFen, page: boardFen1 });
}
const sans1 = await page.evaluate(() => gameMovesAlgebraic.slice());
// Every castle the player made is written O-O or O-O-O, at the player's plies.
const myCastleSans = sans1.filter((s, i) => /^O-O/.test(s) && (i % 2 === 0) === (myLetter === 'w'));
ok('castles are written O-O / O-O-O (' + sans1.filter(s => /^O-O/.test(s)).length + ' in this game)',
  humanCastles === myCastleSans.length, { humanCastles, sans: sans1.filter(s => /^O-O/.test(s)) });
ok('no page errors', page._errors.length === 0, page._errors.slice(0, 3));

// ── 2. Castling by hand ────────────────────────────────────────────────────
console.log('\n2. Castling by hand');
await page.evaluate(() => { if (botActive) botStop(); });
// Position 3, BQNNRKRB: king f1, rook g1. O-O swaps them.
await startFrom960(page, 3);
ok('position 3 is on the board (king f1, rook g1)', await pieceAt(page, 'f1') === 'wK' && await pieceAt(page, 'g1') === 'wR');
await clickSq(page, 'g1');
ok('clicking the rook first just picks the rook up', await page.evaluate(() => selSq === fileRankToSq('g1') || premoveFrom === fileRankToSq('g1')));
await clickSq(page, 'g1');   // put it down
await clickSq(page, 'f1');
ok('the king picked up offers its rook\'s square', await page.evaluate(() => legalMoves.includes(fileRankToSq('g1'))));
await clickSq(page, 'g1');
const c1 = await page.evaluate(() => ({ san: gameMovesAlgebraic[0], cst: { ...castling } }));
ok('clicking the rook castles: king g1, rook f1, written O-O', await pieceAt(page, 'g1') === 'wK' && await pieceAt(page, 'f1') === 'wR' && c1.san === 'O-O', c1);
ok('and White\'s castling rights are gone', !c1.cst.wK && !c1.cst.wQ, c1.cst);
// Takeback over the castle: the rights come back, and the castle is legal again.
await until(() => page.evaluate(() => turn === 'w' && !botThinking), 15000);
await page.evaluate(() => gameRewindPlies(2));
const tb = await page.evaluate(() => ({ cst: { ...castling }, n: gameMovesAlgebraic.length, legal: legalMovesFor(fileRankToSq('f1'), board, epSq, castling).includes(fileRankToSq('g1')) }));
ok('a takeback over it restores the board, the rights and the castle', tb.n === 0 && tb.cst.wK && tb.legal && await pieceAt(page, 'f1') === 'wK', tb);
// Position 74, NNRKBBQR: king d1, rook c1. O-O-O swaps them; this time by drag.
await page.evaluate(() => botStop());
await startFrom960(page, 74);
await dragSq(page, 'd1', 'c1');
ok('dragging the king onto its rook castles long: king c1, rook d1, O-O-O',
  await pieceAt(page, 'c1') === 'wK' && await pieceAt(page, 'd1') === 'wR' && await page.evaluate(() => gameMovesAlgebraic[0]) === 'O-O-O');
ok('the castle made no capture sound or capture count (fifty-move count 1)', await page.evaluate(() => halfmoveClock) === 1);

// ── 3. Reload in the middle of a game ──────────────────────────────────────
console.log('\n3. A reload in the middle of a Chess960 game');
await until(() => page.evaluate(() => turn === 'w' && !botThinking), 15000);
await page.evaluate(() => { const all = allLegalMoves(board, 'w', epSq, castling); tryCommit(all[0].from, all[0].to, null); });
await until(() => page.evaluate(() => turn === 'w' && !botThinking), 15000);
const before = await page.evaluate(() => ({ fen: boardToFen(board, turn, castling, epSq), start: _gameStartFen, files: { ...castleFiles } }));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof setChess960 === 'function');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => ({ on: chess960, fen: boardToFen(board, turn, castling, epSq), start: _gameStartFen, files: { ...castleFiles }, active: botActive,
  tag: document.getElementById('variantTag').textContent }));
ok('the game comes back as Chess960, same position, same start', after.on && after.active && after.fen === before.fen && after.start === before.start, { before, after });
ok('with the same castling rooks', JSON.stringify(after.files) === JSON.stringify(before.files), { before: before.files, after: after.files });
ok('and still names it: ' + after.tag, after.tag === 'Chess960 · #74');

// ── 4. PGN in and out, and review ──────────────────────────────────────────
console.log('\n4. PGN in, review');
const pgn = await page.evaluate(() => buildPgnText().pgn);
await page.evaluate(() => { botStop(); resetGame(); });
ok('a reset is standard chess again', await page.evaluate(() => !chess960));
await page.evaluate(p => parsePgnAndStartReplay(p), pgn);
await page.evaluate(() => rebuildToReplayIdx(replayMoves.length));
const rv = await page.evaluate(() => ({ on: chess960, inReplay, fen: boardToFen(board, turn, castling, epSq), tag: document.getElementById('variantTag').textContent, d1: board[fileRankToSq('d1')] }));
ok('a Chess960 PGN loads into review as Chess960', rv.on && rv.inReplay && rv.tag === 'Chess960 · #74', rv);
ok('and replays to the same position (castle included)', rv.fen.split(' ')[0] === before.fen.split(' ')[0], { review: rv.fen, game: before.fen });
await page.evaluate(() => exitReplay());
ok('leaving review: standard chess again', await page.evaluate(() => !chess960));

// ── 5. Maia's castle ───────────────────────────────────────────────────────
console.log('\n5. Maia: a Chess960 castle asked under the standard spelling');
const mm = await page.evaluate(async () => {
  await _maiaLoadMappings();
  const out = {};
  setChess960(true);
  // King e1 between rooks a1 and h1, nothing in the way (position 518, cleared):
  // the castles are e1h1 / e1a1 here, asked of Maia as e1g1 / e1c1.
  const f1 = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  parseFen(f1);
  const m1 = _maiaLegalMask(f1);
  out.map1 = m1.castleMap;
  const logits = new Float32Array(4352);
  out.probs1 = Object.keys(_maiaProcess(f1, logits, null, m1)).sort();
  // King f1, rook g1 (position 3): the castle would be asked as f1g1, which IS
  // the castle here — no other move is f1g1 — so it is asked as itself.
  const f2 = chess960StartFen(3);
  parseFen(f2);
  const m2 = _maiaLegalMask(f2);
  out.map2 = m2.castleMap;
  out.has2 = Object.keys(_maiaProcess(f2, logits, null, m2)).includes('f1g1');
  // Black to move, position 74 (king d8, rook c8): the mirrored lookup.
  const f3 = chess960StartFen(74).replace(' w ', ' b ');
  parseFen(f3);
  const m3 = _maiaLegalMask(f3);
  out.map3 = m3.castleMap;
  out.has3 = Object.keys(_maiaProcess(f3, logits, null, m3)).includes('d8c8');
  setChess960(false);
  return out;
});
ok('e1g1 and e1c1 stand for e1h1 and e1a1', mm.map1['e1g1'] === 'e1h1' && mm.map1['e1c1'] === 'e1a1', mm.map1);
ok('so Maia\'s answer lists the castles as the board plays them, and no e1g1',
  mm.probs1.includes('e1h1') && mm.probs1.includes('e1a1') && !mm.probs1.includes('e1g1') && !mm.probs1.includes('e1c1'), mm.probs1);
ok('a king one step from its castled square is asked as king takes rook (f1g1)', mm.has2 && Object.keys(mm.map2).length === 0, mm.map2);
ok('Black\'s castle too (d8c8)', mm.has3, mm.map3);

// ── 6. The builder ─────────────────────────────────────────────────────────
console.log('\n6. The builder\'s Play as picker');
await page.evaluate(() => { quickBotPick('1200'); botSetVariant('standard'); openBotModal(); });
const f = await (await page.waitForSelector('#botModalFrame')).contentFrame();
await f.waitForFunction(() => typeof selVariant === 'function');
await f.evaluate(() => toggleQsDropdown('color'));
await f.click('.pa-btn[data-variant="chess960"]');
const bcp = await f.evaluate(() => ({ pill: document.getElementById('qs-color-value').textContent, v: getBotConfig().variant, color: getBotConfig().color }));
ok('picking Chess960 shows on the pill ("' + bcp.pill + '") and goes in the config', bcp.pill.endsWith('· 960') && bcp.v === 'chess960' && bcp.color === 'random', bcp);
await f.evaluate(() => { toggleQsDropdown('color'); selColor(document.querySelector('.pa-btn[data-color="white"]')); });
ok('the colour can still be picked beside it', await f.evaluate(() => getBotConfig().color === 'white' && getBotConfig().variant === 'chess960'));
await f.evaluate(() => startGame());
await until(() => page.evaluate(() => botActive), 8000);
const bs = await page.evaluate(() => ({ pref: botVariantPref, on: chess960, sel: document.getElementById('quickBotVariant').value, me: botPlayerColor }));
ok('Start plays it: a Chess960 game, and the quick start now says so too', bs.pref === 'chess960' && bs.on && bs.sel === 'chess960' && bs.me === 'white', bs);

// ── 7. 2-player ────────────────────────────────────────────────────────────
console.log('\n7. 2-player: private room and open challenge');
await page.evaluate(() => botStop());
const host = await newPage(), guest = await newPage();
// The deal is pinned to position 3 (king f1, rook g1; the same for Black), so
// both sides can castle at once and the castles cross the wire.
await host.evaluate(() => { mpSetVariant('chess960'); mpSetHostColor('white'); chess960RandomNumber = () => 3; });
ok('the Variant pill reads Chess960', (await host.textContent('#mpQsVariantVal')) === 'Chess960');
await host.evaluate(() => mpCreatePrivate());
await until(() => host.evaluate(() => !!mpRoomId), 8000);
const code = await host.evaluate(() => mpRoomId);
await guest.evaluate(code => { document.getElementById('mpJoinCode').value = code; mpJoinRoom(); }, code);
await until(() => guest.evaluate(() => mpMode === 'ingame') && host.evaluate(() => mpMode === 'ingame'), 8000);
await sleep(500);
const hs = await host.evaluate(() => ({ on: chess960, start: _gameStartFen, role: mpRole }));
const gs = await guest.evaluate(() => ({ on: chess960, start: _gameStartFen, role: mpRole }));
ok('both play Chess960 from the same dealt position', hs.on && gs.on && hs.start && hs.start === gs.start && chess960NumberOfLocal(hs.start), { hs, gs });
function chess960NumberOfLocal(fen) { const r = fen.split(' ')[0].split('/'); return r[1] === 'pppppppp' && r[0] === r[7].toLowerCase(); }
// Moves both ways; each side castles as soon as it can.
const sides = { white: hs.role === 'white' ? host : guest, black: hs.role === 'white' ? guest : host };
let mpCastles = 0;
for (let i = 0; i < 24; i++) {
  const who = i % 2 ? sides.black : sides.white;
  const r = await who.evaluate(() => {
    const all = allLegalMoves(board, turn, epSq, castling);
    if (!all.length) return null;
    const cs = all.filter(m => isCastleMove(board, m.from, m.to));
    const m = cs.length ? cs[0] : all[Math.floor(Math.random() * all.length)];
    return { castle: cs.length > 0, ok: tryCommit(m.from, m.to, board[m.from].piece === 'P' && (m.to < 8 || m.to >= 56) ? 'Q' : null) };
  });
  if (!r) break;
  if (r.castle) mpCastles++;
  const other = who === host ? guest : host;
  await until(() => other.evaluate(n => gameMovesAlgebraic.length === n, i + 1), 5000);
}
const hb = await host.evaluate(() => boardToFen(board, turn, castling, epSq));
const gb = await guest.evaluate(() => boardToFen(board, turn, castling, epSq));
ok('the two boards agree after ' + (await host.evaluate(() => gameMovesAlgebraic.length)) + ' plies, ' + mpCastles + ' of them castles', hb === gb && mpCastles >= 2, { hb, gb, mpCastles });
ok('and both wrote the castles O-O', JSON.stringify(await host.evaluate(() => gameMovesAlgebraic.slice(0, 2))) === '["O-O","O-O"]' &&
  JSON.stringify(await guest.evaluate(() => gameMovesAlgebraic.slice(0, 2))) === '["O-O","O-O"]');
// Open challenge: the lobby list says Chess960, and joining it plays the posted position.
const poster = await newPage(), joiner = await newPage();
await poster.evaluate(() => { mpSetVariant('chess960'); mpPostChallenge(); });
await until(() => poster.evaluate(() => !!mpRoomId), 8000);
const pcode = await poster.evaluate(() => mpRoomId);
await joiner.evaluate(() => mpRefreshLobby());
await until(() => joiner.evaluate(() => /Chess960/.test(document.getElementById('mpLobbyList').textContent)), 8000);
ok('the open challenge is listed as Chess960', /Chess960/.test(await joiner.textContent('#mpLobbyList')));
await joiner.evaluate(c => { mpDoAcceptLobby(c); }, pcode);
await until(() => joiner.evaluate(() => mpMode === 'ingame') && poster.evaluate(() => mpMode === 'ingame'), 8000);
await sleep(500);
const ps = await poster.evaluate(() => ({ on: chess960, start: _gameStartFen }));
const js = await joiner.evaluate(() => ({ on: chess960, start: _gameStartFen }));
ok('joining it plays Chess960 from the posted position', ps.on && js.on && ps.start && ps.start === js.start, { ps, js });
ok('no page errors in the 2-player pages', [host, guest, poster, joiner].every(p => !p._errors.length), [host, guest, poster, joiner].map(p => p._errors.slice(0, 2)));

// ── 8. Standard again ──────────────────────────────────────────────────────
console.log('\n8. A standard game afterwards');
await fastBot(page);
// (The quick start block is put away while a stopped game is on the board.)
await page.evaluate(() => { botSetVariant('standard'); botSetPlayerColor('black'); quickBotStart(); });   // the bot moves first, with Stockfish
await until(() => page.evaluate(() => botActive && gameMovesAlgebraic.length >= 1), 15000);
const st = await page.evaluate(() => ({ on: chess960, start: _gameStartFen, tag: document.getElementById('variantTag').style.display,
  files: { ...castleFiles }, sf: sfWorker && sfWorker._bm960 }));
ok('standard chess: no Chess960, the usual start, no tag', !st.on && !st.start && st.tag === 'none', st);
ok('Stockfish was switched back out of Chess960', st.sf === false, st.sf);
const e1 = await page.evaluate(() => {
  setChess960(false);
  const bd = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const to = legalMovesFor(fileRankToSq('e1'), bd, -1, castling).map(sqName).sort();
  return to;
});
ok('and castles king-two-squares, as before', e1.includes('g1') && e1.includes('c1') && !e1.includes('h1'), e1);
ok('no page errors', page._errors.length === 0, page._errors.slice(0, 3));

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

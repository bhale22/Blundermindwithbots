
// ═══════════════════════════════════════════════════════════════════════════
// PREMOVE PUZZLES
// ═══════════════════════════════════════════════════════════════════════════
// Each puzzle is a position from a real Lichess 1+0 game in which the
// opponent's reply was a premove (it used 0.00 s of clock, which Lichess only
// records for premoves). A different move would have kept that premove legal
// and turned it into a blunder. tools/premove-puzzles/ builds the data.
//
// The puzzle is played as an ordinary bot game from the position: the bot is
// Maia at the premover's own rating, armed with the exact premove from the
// game through the bot's own premove slot (botActivePremove). So the same
// machinery that fires a bot premove in any game fires this one, and a busted
// premove gets the same stall-then-think the bot always takes. The puzzle only
// adds the judging, the popups and the arrows.
//
// No engine runs to judge an attempt. The data scores every legal reply ahead
// of time: moves[uci] = [win% if the premove fires, win% if they answer it
// normally]. A reply missing from that table is one that busts the premove.
//
// The puzzle borrows the bot's settings (engine, rating, colour, clock and
// personality) for as long as puzzles are open, and puts the player's own bot
// back on the way out. Nothing about a puzzle is written to the saved bot or
// to the live-game snapshot.

const PZ_DATA_URL = '/data/premove-puzzles.json';
const PZ_POS_KEY = 'bm_pzIndex';
const PZ_SHOW_KEY = 'bm_pzShowPremove';
const PZ_BUST_PAUSE_MS = 1200;   // the stall before Maia answers a busted premove
const PZ_REPLY_MS = 700;         // Maia's think time for every other move
const PZ_SLACK = 8;              // win% points short of the best reply that still solve it
const PZ_RISK_NOTE = 30;         // risk worth a warning in the Correct popup
const PZ_POPUP_DELAY_MS = 450;   // long enough to see the premove land before the verdict

const PZ_COLORS = {
  premove: 'rgba(200,146,42,0.95)',   // amber: what the opponent can do
  answer:  'rgba(34,168,90,0.95)',
  attempt: 'rgba(120,120,120,0.85)',
};
const PZ_PIECE = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

// `var`, not `let`: render() and updatePlayerBoxes() call into this file from
// the start-up blocks of earlier parts, before these lines have run. A `let`
// read then throws (temporal dead zone), and an uncaught throw at top level
// abandons every part after it. A `var` reads as undefined, which is "off".
var pzList = null;        // the puzzles, once loaded
var pzLoading = null;     // the fetch in flight
var pzIdx = 0;
var pzActive = false;     // puzzle mode is open (the bot's settings are borrowed)
var pzCur = null;
var pzGen = -1;           // _botGameGen of the puzzle game on the board
var pzPhase = 'idle';     // 'solve' → 'judged' → 'free' (playing it out)
var pzVerdict = null;     // { kind: 'correct' | 'better' | 'busted', ... }
var pzMarks = null;       // { ply, arrows: [{kind, from, to}], rings: [sq] }
var pzNote = '';          // HTML for the card's second line
var pzSaved = null;       // the player's own bot settings, restored on the way out
var pzShowPremove = true;
try { pzShowPremove = localStorage.getItem(PZ_SHOW_KEY) !== '0'; } catch (e) {}

function pzGameOnBoard() {
  return pzActive && botActive && pzGen === _botGameGen;
}

function pzLoad() {
  if (pzList) return Promise.resolve(pzList);
  if (!pzLoading) {
    pzLoading = fetch(PZ_DATA_URL)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { pzList = d.puzzles || []; return pzList; })
      .catch(function (e) { pzLoading = null; throw e; });
  }
  return pzLoading;
}

// The entry point: the Premove Puzzles buttons.
function pzOpen() {
  pzLoad().then(function () {
    if (!pzList.length) return;
    let i = 0;
    try { i = parseInt(localStorage.getItem(PZ_POS_KEY) || '0', 10) || 0; } catch (e) {}
    pzStart(i);
  }).catch(function (e) {
    console.warn('Premove puzzles failed to load:', e);
    if (typeof showEngineWarning === 'function') showEngineWarning('⚠ The premove puzzles could not be loaded. Check the connection and try again.');
  });
}

// ── Borrowing the bot ───────────────────────────────────────────────────────
// Exactly the settings a puzzle changes, so restoring them is exact too.
function pzSaveBot() {
  return {
    tab: botTab, maiaElo: maia3SelectedRating,
    colorPref: botColorPref, playerColor: botPlayerColor, tc: botSelectedTC,
    timeBehavior: botTimeBehavior, fixedDelayMs: botFixedDelayMs,
    premoveEnabled: botPremoveEnabled, bustDelayMs: botPremoveBustDelayMs,
    engineBook: botEngineBook, maiaTemp: botMaiaTempValue,
    blink: botBehavBlink, reconsider: botBehavReconsider,
    badDay: botBadDayMode, blind: botBlindConviction, conviction: botConvictionPct,
    minProb: botMinProbPct, offerDraws: botOfferDraws, staleSeek: botStaleSeek,
    attractors: window._bcpAttractorValues, pieces: window._bcpPieceValues,
    custom: window._bcpCustomControls, hustler: window._bcpHustlerTempMode,
    budget: window._bcpCpBudget, floor: window._bcpCpHardFloor,
  };
}

// Plain Maia at the premover's rating: no personality, no book, no guards,
// sampling at Maia's own temperature, untimed, at a steady pace. The puzzle
// arms its one premove itself, so the bot's own premoving stays off.
function pzApplyBot(p) {
  const solverColor = p.solver === 'w' ? 'white' : 'black';
  botSetTab('maia3');
  maia3SetRating(Math.max(600, Math.min(2600, p.premoverRating)));
  botColorPref = solverColor;
  botPlayerColor = solverColor;
  botSelectedTC = 'untimed';
  botTimeBehavior = 'fixed';
  botFixedDelayMs = PZ_REPLY_MS;
  botPremoveEnabled = false;
  botPremoveBustDelayMs = PZ_BUST_PAUSE_MS;
  botEngineBook = false;
  botMaiaTempValue = 1.0;
  botBehavBlink = false;
  botBehavReconsider = false;
  botBadDayMode = false;
  botBlindConviction = false;
  botConvictionPct = 0;
  botMinProbPct = 0;
  botOfferDraws = false;
  botStaleSeek = false;
  window._bcpAttractorValues = {};
  window._bcpPieceValues = {};
  window._bcpCustomControls = [];
  window._bcpHustlerTempMode = false;
  window._bcpCpBudget = 0;
  window._bcpCpHardFloor = HARD_FLOOR_OFF_CP;
}

function pzRestoreBot(s) {
  if (!s) return;
  botSetTab(s.tab);
  maia3SetRating(s.maiaElo);
  botSetPlayerColor(s.colorPref);
  botPlayerColor = s.playerColor;
  botSelectedTC = s.tc;
  botTimeBehavior = s.timeBehavior;
  botFixedDelayMs = s.fixedDelayMs;
  botPremoveEnabled = s.premoveEnabled;
  botPremoveBustDelayMs = s.bustDelayMs;
  botEngineBook = s.engineBook;
  botMaiaTempValue = s.maiaTemp;
  botBehavBlink = s.blink;
  botBehavReconsider = s.reconsider;
  botBadDayMode = s.badDay;
  botBlindConviction = s.blind;
  botConvictionPct = s.conviction;
  botMinProbPct = s.minProb;
  botOfferDraws = s.offerDraws;
  botStaleSeek = s.staleSeek;
  window._bcpAttractorValues = s.attractors;
  window._bcpPieceValues = s.pieces;
  window._bcpCustomControls = s.custom;
  window._bcpHustlerTempMode = s.hustler;
  window._bcpCpBudget = s.budget;
  window._bcpCpHardFloor = s.floor;
}

// ── Starting and leaving ────────────────────────────────────────────────────
// `show` restarts the same puzzle with something drawn on it:
//   { mode: 'answer' }                          the recommended move
//   { mode: 'bust', attempt: uci, reason: {} }  why the last try busted it
function pzStart(i, show) {
  if (!pzList || !pzList.length) return;
  const wasActive = pzActive;
  if (!pzActive) pzSaved = pzSaveBot();
  pzActive = true;
  pzIdx = ((i % pzList.length) + pzList.length) % pzList.length;
  pzCur = pzList[pzIdx];
  try { localStorage.setItem(PZ_POS_KEY, String(pzIdx)); } catch (e) {}
  pzHidePopup();
  pzApplyBot(pzCur);

  window._pendingStartPos = { fen: pzCur.fen, sans: [] };
  window._pzStarting = true;
  try { botStart(); } finally { window._pzStarting = false; }
  // botStart can decline — a tab hosting the Lichess bot never starts games
  // of its own. Give the settings back if this was the way in.
  if (!botActive || _gameStartFen !== pzCur.fen) {
    window._pendingStartPos = null;
    if (!wasActive) { pzActive = false; pzRestoreBot(pzSaved); pzSaved = null; pzCur = null; }
    pzRenderCard();
    return;
  }
  // The explorer would answer from its book wherever the position has one,
  // and the puzzle's opponent is Maia at a rating, nothing else.
  preferredOpeningActive = false;
  mainLineActive = false;
  lichessExplorerActive = false;
  pzGen = _botGameGen;

  const m = uciToSq(pzCur.premove);
  botActivePremove = {
    uci: pzCur.premove, from: m.from, to: m.to, promo: m.promo,
    predictedUci: pzCur.playedUci, confidence: 1
  };
  botPremoveStats.armed = 1;
  botPremoveUpdateBadge();

  pzPhase = 'solve';
  pzVerdict = null;
  const pre = { kind: 'premove', from: m.from, to: m.to };
  pzMarks = { ply: gameMovesAlgebraic.length, arrows: [pre], rings: [], always: false };
  pzNote = '';
  if (show && show.mode === 'answer') {
    const a = uciToSq(pzCur.answer);
    pzMarks.arrows = [pre, { kind: 'answer', from: a.from, to: a.to }];
    pzMarks.always = true;
    pzNote = 'Play <span class="pz-mv ans">' + pzCur.answerSan + '</span>. Their premove <span class="pz-mv pre">' +
      pzCur.premoveSanVsAnswer + '</span> still fires' +
      (pzCur.stalemate ? ', and it is stalemate.'
        : pzCur.follow.length ? ', then <span class="pz-mv ans">' + pzCur.follow.join(' ') + '</span>.' : '.');
  } else if (show && show.mode === 'bust') {
    const t = uciToSq(show.attempt);
    pzMarks.arrows = [pre, { kind: 'attempt', from: t.from, to: t.to }];
    pzMarks.rings = show.reason.mark != null ? [show.reason.mark] : [];
    pzMarks.always = true;
    pzNote = show.reason.text + ' Find a move that keeps it legal.';
  }
  botUpdatePlayerNames(botPlayerColor);
  pzRenderCard();
  render();
}

// Close puzzle mode and give the player's own bot back. keepBoard: the caller
// (botStart, starting the player's own game) replaces the board itself.
function pzLeave(keepBoard) {
  if (!pzActive) return;
  const onBoard = pzGameOnBoard();
  pzActive = false;
  pzPhase = 'idle';
  pzVerdict = null;
  pzMarks = null;
  pzHidePopup();
  pzRestoreBot(pzSaved);
  pzSaved = null;
  pzCur = null;
  pzGen = -1;
  if (onBoard && !keepBoard) { botStop(); resetGame(); }
  pzRenderCard();
  if (typeof quickBotSync === 'function') quickBotSync();
  render();
}

// The puzzle game was replaced by something else (a loaded game, a replay, a
// 2-player game): leave quietly, without touching the new board.
function pzSync() {
  if (window._pzStarting) return;
  if (pzActive && !pzGameOnBoard()) pzLeave(true);
}

// Rematch on a puzzle game restarts the puzzle.
function pzRematch() {
  if (!pzGameOnBoard()) return false;
  pzStart(pzIdx);
  return true;
}

function pzBotName() {
  return pzGameOnBoard() ? 'Maia ' + maia3SelectedRating : null;
}

// ── Judging ─────────────────────────────────────────────────────────────────
// From botPremoveTryFire, once the player has moved: the premove either fired
// or was busted. The board is the one after the player's move.
function pzOnPremove(pre, fired) {
  if (!pzGameOnBoard() || pzPhase !== 'solve') return;
  const uci = botMoveHistory[botMoveHistory.length - 1];
  const san = gameMovesAlgebraic[gameMovesAlgebraic.length - 1];
  pzPhase = 'judged';
  pzVerdict = fired
    ? pzJudge(uci, san)
    : { kind: 'busted', uci: uci, san: san, reason: pzBustReason(pre, uci, san) };
}

// From botPostMoveHook after every move that hands the turn back (or ends the
// game). Shows the verdict once the opponent's reply has landed.
function pzAfterMove() {
  if (!pzGameOnBoard()) return;
  if (pzPhase === 'solve' && gameOver) {
    // The player's own move ended the game, so the premove never came up.
    const uci = botMoveHistory[botMoveHistory.length - 1];
    const san = gameMovesAlgebraic[gameMovesAlgebraic.length - 1];
    pzPhase = 'judged';
    pzVerdict = pzJudge(uci, san);
    pzVerdict.ended = true;
  }
  if (pzVerdict && !pzVerdict.shown) {
    pzVerdict.shown = true;
    setTimeout(pzShowPopup, PZ_POPUP_DELAY_MS);
  }
  pzRenderCard();
}

function pzJudge(uci, san) {
  const t = pzCur.moves;
  let best = 0;
  for (const k in t) best = Math.max(best, t[k][0]);
  const row = t[uci];
  const v = {
    uci: uci, san: san, best: best,
    game: t[pzCur.playedUci] ? t[pzCur.playedUci][0] : null,
    wp: row ? row[0] : null, noPremove: row ? row[1] : null,
    exact: uci === pzCur.answer,
  };
  v.kind = (pzCur.accept.indexOf(uci) >= 0 || (row && row[0] >= best - PZ_SLACK)) ? 'correct' : 'better';
  return v;
}

// Why the player's move made the premove illegal, worked out on the board
// after that move. `mark` is the square to ring when the bust is shown.
function pzBustReason(pre, uci, san) {
  const premover = pzCur.solver === 'w' ? 'b' : 'w';
  const preSan = '<span class="pz-mv pre">' + pzCur.premoveSan + '</span>';
  const yours = '<span class="pz-mv">' + san + '</span>';
  const um = uciToSq(uci);
  const start = parseFenBoard(pzCur.fen);
  const moved = board[um.to];
  const p = board[pre.from];
  if (!p || p.color !== premover) {
    return { mark: pre.from,
      text: yours + ' captured the ' + PZ_PIECE[start[pre.from].piece] + ' on ' + sqName(pre.from) +
            ', the piece their premove ' + preSan + ' was going to move.' };
  }
  if (pseudoMoves(pre.from, board, epSq, castling).indexOf(pre.to) < 0) {
    // The commonest bust: the premove was a recapture, queued for the capture
    // the game went on to make. No capture, nothing to take back.
    const own = board[pre.to];
    if (own && own.color === premover) {
      return { mark: pre.to,
        text: 'Their premove ' + preSan + ' was a recapture, queued for you taking on ' + sqName(pre.to) +
              '. After ' + yours + ' their own ' + PZ_PIECE[own.piece] + ' is still standing there.' };
    }
    if (p.piece === 'P' && pre.from % 8 !== pre.to % 8) {
      return { mark: pre.to,
        text: 'Their premove ' + preSan + ' was a pawn capture on ' + sqName(pre.to) + '. ' + yours +
              ' left that square empty, and a pawn can’t move diagonally onto an empty square.' };
    }
    if (p.piece === 'P') {
      return { mark: um.to,
        text: yours + ' put your ' + PZ_PIECE[moved.piece] + ' in front of the pawn, so ' + preSan + ' can’t be played.' };
    }
    if (p.piece === 'K' && Math.abs(pre.from % 8 - pre.to % 8) === 2) {
      return { mark: um.to, text: 'Their premove was castling, and after ' + yours + ' castling isn’t allowed.' };
    }
    if ('QRB'.indexOf(p.piece) >= 0 && pzBetween(pre.from, pre.to).indexOf(um.to) >= 0) {
      return { mark: um.to,
        text: yours + ' put your ' + PZ_PIECE[moved.piece] + ' on ' + sqName(um.to) + ', in the way of the ' +
              PZ_PIECE[p.piece] + ' going from ' + sqName(pre.from) + ' to ' + sqName(pre.to) + '.' };
    }
    return { mark: um.to, text: 'After ' + yours + ', ' + preSan + ' isn’t a legal move.' };
  }
  // The move exists but would leave their king in check.
  if (inCheck(board, premover)) {
    return { mark: um.to,
      text: yours + ' gives check. A premove only plays if it is legal, and ' + preSan + ' doesn’t get out of check.' };
  }
  if (p.piece === 'K') {
    const without = Object.assign({}, board);
    delete without[pre.from];
    const a = currentAttackersOf(pre.to, pzCur.solver, without)[0];
    if (a) {
      return { mark: a.sq,
        text: preSan + ' would put their king on ' + sqName(pre.to) + ', and your ' + PZ_PIECE[board[a.sq].piece] +
              ' on ' + sqName(a.sq) + ' covers that square after ' + yours + '.' };
    }
  }
  return { mark: um.to,
    text: yours + ' pins the ' + PZ_PIECE[p.piece] + ' on ' + sqName(pre.from) + ' to their king, so ' + preSan + ' can’t be played.' };
}

// Squares strictly between two squares on one rank, file or diagonal.
function pzBetween(a, b) {
  const ar = Math.floor(a / 8), ac = a % 8, br = Math.floor(b / 8), bc = b % 8;
  const dr = Math.sign(br - ar), dc = Math.sign(bc - ac);
  if (!(ar === br || ac === bc || Math.abs(br - ar) === Math.abs(bc - ac))) return [];
  const out = [];
  for (let r = ar + dr, c = ac + dc; r !== br || c !== bc; r += dr, c += dc) out.push(r * 8 + c);
  return out;
}

// parseFen also sets the live turn/castling/ep globals; this reads the
// placement only, without touching the game.
function parseFenBoard(fen) {
  const b = {};
  fen.split(' ')[0].split('/').forEach(function (row, r) {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { c += +ch; continue; }
      b[r * 8 + c] = { piece: ch.toUpperCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
      c++;
    }
  });
  return b;
}

// ── Popup ───────────────────────────────────────────────────────────────────
function pzShowPopup() {
  const v = pzVerdict, el = document.getElementById('pzPop');
  if (!el || !v || !pzGameOnBoard()) return;
  const mv = function (s, cls) { return '<span class="pz-mv' + (cls ? ' ' + cls : '') + '">' + s + '</span>'; };
  const pct = function (x) { return Math.round(x) + '%'; };
  // The premove as the game record wrote it, with the check mark it earns
  // now that it has landed after the player's move.
  let firedSan = pzCur.premoveSan.replace(/[+#]$/, '');
  if (v.kind !== 'busted' && !v.ended && inCheck(board, pzCur.solver)) firedSan += gameOver ? '#' : '+';
  let title, body, wpLine = '', acts;
  if (v.kind === 'busted') {
    title = 'Premove busted';
    body = mv(v.san) + ' made their premove ' + mv(pzCur.premoveSan, 'pre') + ' illegal, so it was cancelled and ' +
           (_maiaReady ? 'Maia' : 'the bot') + ' had to stop and think.';
    acts = [['retry', 'Try again', true], ['bust', 'Show the bust']];
  } else if (v.kind === 'correct') {
    title = 'Correct!';
    if (v.ended) {
      body = mv(v.san, 'ans') + (v.wp === 100 ? ' is mate.' : ' ends the game.') + ' The premove never got to play.';
    } else {
      body = (v.exact ? '' : mv(v.san, 'ans') + ' works. ') + 'Their premove ' + mv(firedSan, 'pre') + ' fired into it' +
             (v.exact && pzCur.stalemate ? ', and it is stalemate.'
               : v.exact && pzCur.follow.length ? '. Next: ' + mv(pzCur.follow.join(' '), 'ans') + '.' : '.');
    }
    if (v.game != null && v.wp != null) wpLine = 'Your win chance: ' + pct(v.game) + ' in the game → ' + pct(v.wp);
    if (v.noPremove != null && pzCur.wpRoot - v.noPremove > PZ_RISK_NOTE) {
      body += ' Risky, though: if they hadn’t premoved, you’d be at ' + pct(v.noPremove) + '.';
    }
    acts = [['reset', 'Reset'], ['next', 'Next puzzle', true], ['play', 'Play it out']];
  } else {
    title = 'Better exploit available';
    if (v.ended) {
      body = mv(v.san) + ' ends the game, but there’s a move that does more with their premove.';
    } else if (v.wp != null && v.game != null && v.wp <= v.game + 5) {
      body = 'Their premove ' + mv(firedSan, 'pre') + ' fired after ' + mv(v.san) +
             ', but it didn’t cost them anything. One move makes it a real blunder.';
    } else {
      body = 'Their premove ' + mv(firedSan, 'pre') + ' fired after ' + mv(v.san) +
             (v.wp != null ? ' and took you to ' + pct(v.wp) : '') + '. There’s a stronger way to punish it.';
    }
    if (v.wp != null) wpLine = 'Your win chance: ' + pct(v.wp) + ' · best: ' + pct(v.best);
    acts = [['retry', 'Try again', true], ['answer', 'Show answer'], ['play', 'Play it out']];
  }
  el.className = v.kind === 'correct' ? 'good' : v.kind === 'busted' ? 'bust' : '';
  el.innerHTML =
    '<button type="button" class="pz-x" data-act="play" aria-label="Close and play on">×</button>' +
    '<h3>' + title + '</h3><p>' + body + '</p>' +
    (wpLine ? '<p class="pz-wp">' + wpLine + '</p>' : '') +
    '<div class="pz-row">' + acts.map(function (a) {
      return '<button type="button" class="pz-btn' + (a[2] ? ' primary' : '') + '" data-act="' + a[0] + '">' + a[1] + '</button>';
    }).join('') + '</div>';
  el.hidden = false;
  const first = el.querySelector('.pz-btn.primary') || el.querySelector('.pz-btn');
  if (first) first.focus({ preventScroll: true });
}

function pzHidePopup() {
  const el = document.getElementById('pzPop');
  if (el) el.hidden = true;
}

function pzAct(act) {
  const v = pzVerdict;
  if (act === 'retry' || act === 'reset') pzStart(pzIdx);
  else if (act === 'next') pzStart(pzIdx + 1);
  else if (act === 'answer') pzStart(pzIdx, { mode: 'answer' });
  else if (act === 'bust' && v && v.reason) pzStart(pzIdx, { mode: 'bust', attempt: v.uci, reason: v.reason });
  else if (act === 'play') { pzHidePopup(); pzPhase = 'free'; pzMarks = null; pzRenderCard(); render(); }
  else if (act === 'exit') pzLeave();
  else if (act === 'toggle') {
    pzShowPremove = !pzShowPremove;
    try { localStorage.setItem(PZ_SHOW_KEY, pzShowPremove ? '1' : '0'); } catch (e) {}
    pzRenderCard(); render();
  } else if (act === 'maia' && typeof maiaDownloadModel === 'function') maiaDownloadModel();
}

document.addEventListener('click', function (e) {
  const b = e.target.closest && e.target.closest('#pzPop [data-act], #pzCard [data-act]');
  if (b) { e.preventDefault(); pzAct(b.dataset.act); }
});
document.addEventListener('keydown', function (e) {
  const el = document.getElementById('pzPop');
  if (e.key === 'Escape' && el && !el.hidden) pzAct('play');
});

// ── The card ────────────────────────────────────────────────────────────────
// Under the board on a phone. On a wide screen the board is tall enough to
// push anything under it out of view, so the card heads the side column, the
// way the Maia odds panel does during a review (distPlace).
function pzPlaceCard() {
  const el = document.getElementById('pzCard'), home = document.getElementById('pzCardHome');
  if (!el || !home) return;
  const wide = !window.matchMedia('(max-width:760px)').matches;
  const side = document.getElementById(document.body.classList.contains('pro-mode') ? 'proSide' : 'sidebar');
  if (wide && side) {
    if (el.parentNode !== side || side.firstElementChild !== el) side.insertBefore(el, side.firstChild);
  } else if (el.nextElementSibling !== home) {
    home.parentNode.insertBefore(el, home);
  }
}
window.addEventListener('resize', pzPlaceCard);

function pzRenderCard() {
  const el = document.getElementById('pzCard');
  if (!el) return;
  pzPlaceCard();
  el.classList.toggle('on', pzActive && !!pzCur);
  if (!pzActive || !pzCur) { el.innerHTML = ''; return; }
  const p = pzCur;
  const side = p.solver === 'w' ? 'White' : 'Black';
  const opp = 'Maia ' + maia3SelectedRating;
  const hidden = !pzShowPremove && !(pzMarks && pzMarks.always);
  let prompt;
  if (pzPhase === 'free') prompt = 'Playing it out against ' + opp + '.';
  else if (hidden) prompt = 'You’re ' + side + '. ' + opp + ' has a premove queued. Work out what it is, then make it backfire.';
  else prompt = 'You’re ' + side + '. ' + opp + ' premoved <span class="pz-mv pre">' + p.premoveSan + '</span>. Make it backfire.';
  let maia = '';
  if (typeof _maiaReady !== 'undefined' && !_maiaReady) {
    maia = _maiaStatus === 'downloading'
      ? '<p class="pz-meta">Maia is downloading. Until it’s ready, Flounder answers instead.</p>'
      : '<p class="pz-meta">Maia isn’t on this device yet, so Flounder answers instead. ' +
        '<button type="button" class="pz-btn" data-act="maia">Download Maia · 44 MB</button></p>';
  }
  el.innerHTML =
    '<div class="pz-head"><span>⚡ Premove puzzle</span><span class="pz-count">' + (pzIdx + 1) + ' / ' + pzList.length + '</span></div>' +
    '<p class="pz-prompt">' + prompt + '</p>' +
    '<p class="pz-note">' + pzNote + '</p>' + maia +
    '<div class="pz-row">' +
      '<label class="pz-toggle"><input type="checkbox" data-act="toggle"' + (pzShowPremove ? ' checked' : '') + '> Show their premove</label>' +
      '<button type="button" class="pz-btn" data-act="reset">Reset</button>' +
      '<button type="button" class="pz-btn" data-act="next">Next →</button>' +
      '<button type="button" class="pz-btn" data-act="exit">Exit</button>' +
    '</div>' +
    '<p class="pz-meta">From a Lichess 1+0 game, ' + p.solverRating + ' vs ' + p.premoverRating + ' · ' +
      '<a href="https://lichess.org/' + p.id + '/' + (p.solver === 'w' ? 'white' : 'black') + '#' + p.ply +
      '" target="_blank" rel="noopener">see the game</a></p>';
}

// ── Arrows on the board ─────────────────────────────────────────────────────
// Drawn by render() on top of everything else, only while the board still
// shows the position they belong to.
function pzDrawOverlay(ctx) {
  if (!pzMarks || !pzGameOnBoard() || gameMovesAlgebraic.length !== pzMarks.ply) return;
  for (const a of pzMarks.arrows) {
    if (a.kind === 'premove' && !pzShowPremove && !pzMarks.always) continue;
    drawForkArrow(ctx, a.from, a.to, SQ, PZ_COLORS[a.kind], a.kind === 'premove');
  }
  for (const sq of pzMarks.rings) {
    const { r, c } = sqCanvas(sq);
    ctx.save();
    ctx.strokeStyle = PZ_COLORS.premove;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(c * SQ + SQ / 2, r * SQ + SQ / 2, SQ * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

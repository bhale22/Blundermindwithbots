
// ═══════════════════════════════════════════════════════════════════════════
// PREMOVE PUZZLES
// ═══════════════════════════════════════════════════════════════════════════
// Each puzzle is a position from a real Lichess 1+0 game in which the
// opponent's reply was a premove (it used 0.00 s of clock, which Lichess only
// records for premoves). A different move would have kept that premove legal
// and turned it into a blunder. tools/premove-puzzles/ builds the data, and
// scripts/rank-premove-puzzles.mjs orders it from easy to hard.
//
// Solving takes two moves: the one that lets the premove fire into trouble,
// then the one that cashes in on it — the capture or the mate is the player's
// to make.
//
// The puzzle is played as an ordinary bot game from the position, against the
// premover's own rating: Maia when the model is already on this device,
// Flounder when it isn't, so nothing has to be downloaded to play. The game's
// exact premove is armed through the bot's own premove slot
// (botActivePremove), so the machinery that fires a bot premove in any game
// fires this one, and a busted premove gets the same stall-then-think the bot
// always takes. The puzzle adds the judging, the popups, the arrows and an
// eval bar that only exists during puzzle games.
//
// No engine runs to judge an attempt. The data scores every legal reply ahead
// of time:
//   moves[uci]          = [win% if the premove fires, win% if they answer normally]
//   second[first][uci]  = win% after the follow-up, for each first move that solves it
// A first move missing from `moves` is one that busts the premove.
//
// The puzzle borrows the bot's settings (engine, rating, colour, clock and
// personality) for as long as puzzles are open, and puts the player's own bot
// back on the way out. Nothing about a puzzle is written to the saved bot or
// to the live-game snapshot.

const PZ_DATA_URL = '/data/premove-puzzles.json';
const PZ_LINK_RE = /^\/premovepuzzles\/?$/i;   // blundermindchess.com/PremovePuzzles
const PZ_POS_KEY = 'bm_pzIndex';
const PZ_ID_KEY = 'bm_pzId';     // where to pick up again, by puzzle: the set's order can change
const PZ_SHOW_KEY = 'bm_pzShowPremove';
const PZ_BUST_PAUSE_MS = 1200;   // the stall before the bot answers a busted premove
const PZ_REPLY_MS = 700;         // the bot's think time for every other move
const PZ_SLACK = 8;              // win% points short of the best that still solve it (SLACK in build_data.py)
const PZ_RISK_NOTE = 30;         // risk worth a warning in the Correct popup
const PZ_POPUP_DELAY_MS = 450;   // long enough to see a move land before the verdict
const PZ_EVAL_MS = 2500;         // eval bar search per position

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
var pzList = null;        // the puzzles, easiest first, once loaded
var pzLoading = null;     // the fetch in flight
var pzIdx = 0;
var pzActive = false;     // puzzle mode is open (the bot's settings are borrowed)
var pzCur = null;
var pzGen = -1;           // _botGameGen of the puzzle game on the board
// 'solve'    waiting for the first move
// 'followup' the premove fired into it; waiting for the move that cashes in
// 'judged'   a verdict is up and the game runs on (busted, or a weaker first move)
// 'held'     a verdict is up on the follow-up; the bot waits for the player
// 'free'     playing it out
var pzPhase = 'idle';
var pzVerdict = null;     // { kind: 'correct' | 'better' | 'busted' | 'followup', ... }
var pzFirst = null;       // the first move that solved it: { uci, san, wp, game }
var pzMid = null;         // the position the follow-up is played from: { fen, sans }
var pzMarks = null;       // { ply, arrows: [{kind, from, to}], rings: [sq], always }
var pzNote = '';          // HTML for the card's second line
var pzFlash = false;      // pulse the card once (the premove just fired)
var pzSaved = null;       // the player's own bot settings, restored on the way out
var pzShowPremove = true;
try { pzShowPremove = localStorage.getItem(PZ_SHOW_KEY) !== '0'; } catch (e) {}

function pzGameOnBoard() {
  return pzActive && botActive && pzGen === _botGameGen;
}

function pzSolverColor() { return pzCur ? pzCur.solver : null; }

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

// The entry point. For now only the share link calls it: the puzzles have no
// button while they are a work in progress (see the floor in 00-head.html).
function pzOpen() {
  // Load Maia if it is already on this device (a cache check, never a
  // download) so it can take over from Flounder as soon as it is ready.
  if (typeof _maiaWorker !== 'undefined' && !_maiaWorker && typeof maiaInit === 'function') {
    maiaInit();
    if (typeof _maiaLoadMappings === 'function') _maiaLoadMappings();
  }
  pzLoad().then(function () {
    if (!pzList.length) return;
    // Back to the puzzle they were on, wherever it now sits in the set.
    let i = 0;
    try {
      const id = localStorage.getItem(PZ_ID_KEY);
      const at = id ? pzList.findIndex(function (p) { return p.id === id; }) : -1;
      if (at >= 0) i = at;
      else if (!id) i = parseInt(localStorage.getItem(PZ_POS_KEY) || '0', 10) || 0;
    } catch (e) {}
    pzStart(i >= 0 && i < pzList.length ? i : 0);
  }).catch(function (e) {
    console.warn('Premove puzzles failed to load:', e);
    if (typeof showEngineWarning === 'function') showEngineWarning('⚠ The premove puzzles could not be loaded. Check the connection and try again.');
  });
}

// blundermindchess.com/PremovePuzzles opens straight into them. The inline
// bootstrap in 00-head.html has already skipped the welcome and put this
// visit on the Visualization board.
document.addEventListener('DOMContentLoaded', function () {
  if (PZ_LINK_RE.test(location.pathname)) setTimeout(pzOpen, 300);
});

// ── Borrowing the bot ───────────────────────────────────────────────────────
// Exactly the settings a puzzle changes, so restoring them is exact too.
function pzSaveBot() {
  const fe = document.getElementById('flounderElo');
  return {
    tab: botTab, maiaElo: maia3SelectedRating, flounderElo: fe ? fe.value : null,
    sfVar1: botSfVar1, sfVar2: botSfVar2,
    colorPref: botColorPref, playerColor: botPlayerColor, tc: botSelectedTC,
    timeBehavior: botTimeBehavior, fixedDelayMs: botFixedDelayMs,
    premoveEnabled: botPremoveEnabled, bustDelayMs: botPremoveBustDelayMs,
    engineBook: botEngineBook, maiaTemp: botMaiaTempValue,
    blink: botBehavBlink, reconsider: botBehavReconsider,
    badDay: botBadDayMode, blind: botBlindConviction, conviction: botConvictionPct,
    minProb: botMinProbPct, offerDraws: botOfferDraws, staleSeek: botStaleSeek,
    attractors: window._bcpAttractorValues, pieces: window._bcpPieceValues,
    custom: window._bcpCustomControls, hustler: window._bcpHustlerTempMode,
    presetName: window._bcpPresetName,
    budget: window._bcpCpBudget, floor: window._bcpCpHardFloor,
  };
}

// A plain engine at the premover's rating: no personality, no book, no
// guards, no Variety, sampling at Maia's own temperature, untimed, at a steady
// pace. The puzzle arms its one premove itself, so the bot's own premoving
// stays off.
function pzApplyBot(p) {
  const solverColor = p.solver === 'w' ? 'white' : 'black';
  pzPickEngine();
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
  botSfVar1 = 0;
  botSfVar2 = 0;
  window._bcpAttractorValues = {};
  window._bcpPieceValues = {};
  window._bcpCustomControls = [];
  window._bcpHustlerTempMode = false;
  window._bcpPresetName = '';
  window._bcpCpBudget = 0;
  window._bcpCpHardFloor = HARD_FLOOR_OFF_CP;
}

// Maia if the model is ready on this device, Flounder if not — at the
// premover's rating either way. Asked again before every bot reply, so a Maia
// that finishes loading mid-puzzle takes over from the next move.
function pzPickEngine() {
  if (!pzCur) return;
  if (typeof _maiaReady !== 'undefined' && _maiaReady) {
    if (botTab !== 'maia3') botSetTab('maia3');
    maia3SetRating(Math.max(600, Math.min(2600, pzCur.premoverRating)));
  } else {
    if (botTab !== 'sf') botSetTab('sf');
    const elo = Math.max(FLOUNDER_ELO_MIN, Math.min(FLOUNDER_ELO_MAX, pzCur.premoverRating));
    const fe = document.getElementById('flounderElo'), fv = document.getElementById('flounderEloVal');
    if (fe) fe.value = elo;
    if (fv) fv.textContent = elo;
  }
  if (pzGameOnBoard()) botUpdatePlayerNames(botPlayerColor);
}

function pzRestoreBot(s) {
  if (!s) return;
  botSetTab(s.tab);
  maia3SetRating(s.maiaElo);
  const fe = document.getElementById('flounderElo'), fv = document.getElementById('flounderEloVal');
  if (fe && s.flounderElo != null) fe.value = s.flounderElo;
  if (fv && s.flounderElo != null) fv.textContent = s.flounderElo;
  botSfVar1 = s.sfVar1;
  botSfVar2 = s.sfVar2;
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
  window._bcpPresetName = s.presetName;
  window._bcpCpBudget = s.budget;
  window._bcpCpHardFloor = s.floor;
}

function pzOppName() {
  return botTab === 'maia3' ? 'Maia ' + maia3SelectedRating : 'Flounder ' + flounderSliderElo();
}

// ── Starting and leaving ────────────────────────────────────────────────────
// `show` restarts the same puzzle with something drawn on it:
//   { mode: 'answer' }                          the recommended first move
//   { mode: 'bust', attempt: uci, reason: {} }  why the last try busted it
//   { mode: 'followup' }                        back to just after the premove
//   { mode: 'followupAnswer' }                  ...with the follow-up drawn
function pzStart(i, show) {
  if (!pzList || !pzList.length) return;
  const wasActive = pzActive;
  if (!pzActive) pzSaved = pzSaveBot();
  pzActive = true;
  const same = pzCur && i === pzIdx;
  pzIdx = ((i % pzList.length) + pzList.length) % pzList.length;
  pzCur = pzList[pzIdx];
  try { localStorage.setItem(PZ_POS_KEY, String(pzIdx)); localStorage.setItem(PZ_ID_KEY, pzCur.id); } catch (e) {}
  pzHidePopup();
  pzApplyBot(pzCur);

  const fromMid = same && pzMid && show && (show.mode === 'followup' || show.mode === 'followupAnswer');
  if (!fromMid) { pzFirst = null; pzMid = null; }
  const startFen = fromMid ? pzMid.fen : pzCur.fen;
  window._pendingStartPos = { fen: startFen, sans: fromMid ? pzMid.sans.slice() : [] };
  window._pzStarting = true;
  try { botStart(); } finally { window._pzStarting = false; }
  // botStart can decline — a tab hosting the Lichess bot never starts games
  // of its own. Give the settings back if this was the way in.
  if (!botActive || _gameStartFen !== startFen) {
    window._pendingStartPos = null;
    if (!wasActive) { pzActive = false; pzRestoreBot(pzSaved); pzSaved = null; pzCur = null; }
    pzRenderCard();
    return;
  }
  // The explorer would answer from its book wherever the position has one,
  // and the puzzle's opponent is an engine at a rating, nothing else.
  preferredOpeningActive = false;
  mainLineActive = false;
  lichessExplorerActive = false;
  pzGen = _botGameGen;
  pzVerdict = null;
  pzNote = '';
  pzFlash = false;
  const ply = gameMovesAlgebraic.length;
  // Highlight the move that led here, as a game would: their last move from
  // the game, or the premove that just fired when starting from after it.
  const lastUci = fromMid ? pzCur.premove : pzCur.lastUci;
  if (lastUci) { const l = uciToSq(lastUci); lastMoveFrom = l.from; lastMoveTo = l.to; }

  if (fromMid) {
    // The premove has already played; the follow-up is all that is left.
    pzPhase = 'followup';
    pzMarks = { ply: ply, arrows: [], rings: [], always: true };
    if (show.mode === 'followupAnswer') {
      const best = pzBestFollow();
      if (best) {
        const m = uciToSq(best);
        pzMarks.arrows = [{ kind: 'answer', from: m.from, to: m.to }];
        pzNote = 'Play <span class="pz-mv ans">' + moveToSAN(m.from, m.to, m.promo, board, epSq, castling) + '</span>.';
      }
    }
  } else {
    const m = uciToSq(pzCur.premove);
    botActivePremove = {
      uci: pzCur.premove, from: m.from, to: m.to, promo: m.promo,
      predictedUci: pzCur.playedUci, confidence: 1
    };
    botPremoveStats.armed = 1;
    botPremoveUpdateBadge();
    pzPhase = 'solve';
    const pre = { kind: 'premove', from: m.from, to: m.to };
    pzMarks = { ply: ply, arrows: [pre], rings: [], always: false };
    if (show && show.mode === 'answer') {
      const a = uciToSq(pzCur.answer);
      pzMarks.arrows = [pre, { kind: 'answer', from: a.from, to: a.to }];
      pzMarks.always = true;
      pzNote = 'Play <span class="pz-mv ans">' + pzCur.answerSan + '</span>. Their premove <span class="pz-mv pre">' +
        pzCur.premoveSanVsAnswer + '</span> still fires' + (pzCur.stalemate ? ', and it is stalemate.' : ' into it.');
    } else if (show && show.mode === 'bust') {
      const t = uciToSq(show.attempt);
      pzMarks.arrows = [pre, { kind: 'attempt', from: t.from, to: t.to }];
      pzMarks.rings = show.reason.mark != null ? [show.reason.mark] : [];
      pzMarks.always = true;
      pzNote = show.reason.text + ' Find a move that keeps it legal.';
    }
  }
  botUpdatePlayerNames(botPlayerColor);
  pzRenderCard();
  pzEvalSync();
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
  pzFirst = null;
  pzMid = null;
  pzHidePopup();
  pzRestoreBot(pzSaved);
  pzSaved = null;
  pzCur = null;
  pzGen = -1;
  if (onBoard && !keepBoard) { botStop(); resetGame(); }
  pzRenderCard();
  pzEvalSync();
  // A reload should not drop the player back into puzzles they have left.
  if (PZ_LINK_RE.test(location.pathname)) {
    try { history.replaceState(null, '', '/'); } catch (e) {}
  }
  if (typeof quickBotSync === 'function') quickBotSync();
  render();
}

// After every move and reset (from updatePlayerBoxes): keep the eval bar on
// the position, and leave quietly if something else has taken the board — a
// loaded game, a replay, a 2-player game.
function pzSync() {
  if (window._pzStarting) return;
  if (pzActive && !pzGameOnBoard()) pzLeave(true);
  pzEvalSync();
}

// Rematch on a puzzle game restarts the puzzle.
function pzRematch() {
  if (!pzGameOnBoard()) return false;
  pzStart(pzIdx);
  return true;
}

function pzBotName() {
  return pzGameOnBoard() ? pzOppName() : null;
}

// ── Judging ─────────────────────────────────────────────────────────────────
// From botPremoveTryFire, once the player's first move is on the board: the
// premove either fired or was busted.
function pzOnPremove(pre, fired) {
  if (!pzGameOnBoard() || pzPhase !== 'solve') return;
  const uci = botMoveHistory[botMoveHistory.length - 1];
  const san = gameMovesAlgebraic[gameMovesAlgebraic.length - 1];
  if (!fired) {
    pzPhase = 'judged';
    pzVerdict = { kind: 'busted', uci: uci, san: san, reason: pzBustReason(pre, uci, san) };
    pzPickEngine();          // the bot is about to think: Maia if it has arrived
    return;
  }
  const v = pzJudge(uci, san);
  if (v.kind === 'correct') {
    // Right first move. No popup: the premove lands, and the capture or mate
    // it hands over is the player's to find.
    pzFirst = v;
    pzPhase = 'followup';
    pzFlash = true;
    pzMid = null;
  } else {
    pzPhase = 'judged';
    pzVerdict = v;
  }
}

// From botPostMoveHook after every move that hands the turn back, and after
// any move that ends the game.
function pzAfterMove() {
  if (!pzGameOnBoard()) return;
  const humanMoved = turn !== pzSolverColor();
  if (gameOver && !pzVerdict) {
    const uci = botMoveHistory[botMoveHistory.length - 1];
    const san = gameMovesAlgebraic[gameMovesAlgebraic.length - 1];
    if (pzPhase === 'solve' && humanMoved) {
      // The first move ended the game, so the premove never came up.
      pzVerdict = pzJudge(uci, san);
      pzVerdict.ended = true;
      pzPhase = 'judged';
    } else if (pzPhase === 'followup' && humanMoved) {
      pzVerdict = pzJudgeFollow(uci, san);
      pzPhase = 'judged';
    } else if (pzPhase === 'followup') {
      // The premove itself ended it: the stalemate trick.
      pzVerdict = { kind: 'correct', stalemate: true, wp: 50, game: pzFirst.game };
      pzPhase = 'judged';
    }
  }
  // The position the follow-up is played from, for Try again.
  if (pzPhase === 'followup' && !pzMid && !humanMoved && !gameOver) {
    pzMid = { fen: pzFen(), sans: gameMovesAlgebraic.slice() };
  }
  if (pzVerdict && !pzVerdict.shown) {
    pzVerdict.shown = true;
    setTimeout(pzShowPopup, PZ_POPUP_DELAY_MS);
  }
  pzRenderCard();
}

// From botPostMoveHook, when the bot is about to answer the player's move:
// true holds it. The follow-up is judged here, and the bot waits while the
// verdict is up, so nothing moves on the board behind the popup.
function pzHoldBot() {
  if (!pzGameOnBoard()) return false;
  if (pzPhase === 'followup') {
    const uci = botMoveHistory[botMoveHistory.length - 1];
    const san = gameMovesAlgebraic[gameMovesAlgebraic.length - 1];
    pzVerdict = pzJudgeFollow(uci, san);
    pzVerdict.shown = true;
    pzPhase = 'held';
    setTimeout(pzShowPopup, PZ_POPUP_DELAY_MS);
    pzRenderCard();
    return true;
  }
  return pzPhase === 'held';
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

function pzBestFollow() {
  const t = pzCur && pzFirst && pzCur.second && pzCur.second[pzFirst.uci];
  if (!t) return null;
  let bu = null;
  for (const k in t) if (bu === null || t[k] > t[bu]) bu = k;
  return bu;
}

function pzJudgeFollow(uci, san) {
  const t = pzCur.second && pzCur.second[pzFirst.uci];
  const v = { uci: uci, san: san, first: pzFirst, game: pzFirst.game, noPremove: pzFirst.noPremove };
  if (!t) { v.kind = 'correct'; return v; }     // no table: the first move was the whole puzzle
  let best = 0;
  for (const k in t) best = Math.max(best, t[k]);
  v.wp = t[uci] != null ? t[uci] : null;
  v.best = best;
  v.kind = (v.wp != null && v.wp >= best - PZ_SLACK) ? 'correct' : 'followup';
  v.followup = true;
  return v;
}

// The live position as a FEN, with a fullmove number counted on from the
// position the game started at (gameMovesAlgebraic can carry a prefix).
function pzFen() {
  const f = (_gameStartFen || pzCur.fen).split(' ');
  const played = gameMovesAlgebraic.length - (_gameStartSans ? _gameStartSans.length : 0);
  const full = (parseInt(f[5], 10) || 1) + Math.floor((played + (f[1] === 'b' ? 1 : 0)) / 2);
  return boardToFen(board, turn, castling, epSq, halfmoveClock, full);
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
  // The premove as the game record wrote it. The board's own notation is not
  // used here: moveToSAN disambiguates by rank where SAN wants the file.
  const preSan = pzFirst && pzFirst.exact ? pzCur.premoveSanVsAnswer : pzCur.premoveSan;
  let title, body, wpLine = '', acts;
  if (v.kind === 'busted') {
    title = 'Premove busted';
    body = mv(v.san) + ' made their premove ' + mv(pzCur.premoveSan, 'pre') + ' illegal, so it was cancelled and ' +
           pzOppName().split(' ')[0] + ' had to stop and think.';
    acts = [['retry', 'Try again', true], ['bust', 'Show the bust']];
  } else if (v.kind === 'correct') {
    title = 'Correct!';
    if (v.ended) {
      body = mv(v.san, 'ans') + (v.wp === 100 ? ' is mate.' : ' ends the game.') + ' The premove never got to play.';
    } else if (v.stalemate) {
      body = mv(pzFirst.san, 'ans') + ', and their premove ' + mv(preSan, 'pre') + ' is stalemate.';
    } else {
      body = mv(pzFirst.san, 'ans') + ', their premove ' + mv(preSan, 'pre') + ', then ' + mv(v.san, 'ans') + '.';
    }
    const now = v.wp != null ? v.wp : v.stalemate ? 50 : null;
    if (v.game != null && now != null) wpLine = 'Your win chance: ' + pct(v.game) + ' in the game → ' + pct(now);
    if (v.noPremove != null && pzCur.wpRoot - v.noPremove > PZ_RISK_NOTE) {
      body += ' Risky, though: if they hadn’t premoved, you’d be at ' + pct(v.noPremove) + '.';
    }
    acts = [['reset', 'Reset'], ['next', 'Next puzzle', true], ['play', 'Play it out']];
  } else if (v.kind === 'followup') {
    title = 'Stronger follow-up available';
    body = 'Your first move was right: their premove ' + mv(preSan, 'pre') + ' fired into it. ' + mv(v.san) +
           ' doesn’t make them pay for it.';
    if (v.wp != null) wpLine = 'Your win chance: ' + pct(v.wp) + ' · best: ' + pct(v.best);
    acts = [['retryFollow', 'Try again', true], ['followAnswer', 'Show follow-up'], ['play', 'Play it out']];
  } else {
    title = 'Better exploit available';
    if (v.ended) {
      body = mv(v.san) + ' ends the game, but there’s a move that does more with their premove.';
    } else if (v.wp != null && v.game != null && v.wp <= v.game + 5) {
      body = 'Their premove ' + mv(pzCur.premoveSan, 'pre') + ' fired after ' + mv(v.san) +
             ', but it didn’t cost them anything. One move makes it a real blunder.';
    } else {
      body = 'Their premove ' + mv(pzCur.premoveSan, 'pre') + ' fired after ' + mv(v.san) +
             (v.wp != null ? ' and took you to ' + pct(v.wp) : '') + '. There’s a stronger way to punish it.';
    }
    if (v.wp != null) wpLine = 'Your win chance: ' + pct(v.wp) + ' · best: ' + pct(v.best);
    acts = [['retry', 'Try again', true], ['answer', 'Show answer'], ['play', 'Play it out']];
  }
  el.className = v.kind === 'correct' ? 'good' : '';
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
  else if (act === 'prev') pzStart(pzIdx - 1);
  else if (act === 'answer') pzStart(pzIdx, { mode: 'answer' });
  else if (act === 'bust' && v && v.reason) pzStart(pzIdx, { mode: 'bust', attempt: v.uci, reason: v.reason });
  else if (act === 'retryFollow') pzStart(pzIdx, { mode: 'followup' });
  else if (act === 'followAnswer') pzStart(pzIdx, { mode: 'followupAnswer' });
  else if (act === 'play') {
    const held = pzPhase === 'held';
    pzHidePopup();
    pzPhase = 'free';
    pzMarks = null;
    pzRenderCard();
    render();
    // Let the bot answer the follow-up it was holding back.
    if (held && botActive && !gameOver && !botThinking && turn !== pzSolverColor()) {
      pzPickEngine();
      setTimeout(botMakeMove, 100);
    }
  }
  else if (act === 'exit') pzLeave();
  else if (act === 'toggle') {
    pzShowPremove = !pzShowPremove;
    try { localStorage.setItem(PZ_SHOW_KEY, pzShowPremove ? '1' : '0'); } catch (e) {}
    pzRenderCard(); render();
  }
}

document.addEventListener('click', function (e) {
  const b = e.target.closest && e.target.closest('#pzPop [data-act], #pzCard [data-act]');
  if (b) { e.preventDefault(); pzAct(b.dataset.act); }
});
document.addEventListener('keydown', function (e) {
  const el = document.getElementById('pzPop');
  if (e.key === 'Escape' && el && !el.hidden) pzAct('play');
});
// The number in the card's corner: type one (or step it) to go straight there.
document.addEventListener('change', function (e) {
  if (!e.target.classList || !e.target.classList.contains('pz-jump') || !pzList) return;
  const n = parseInt(e.target.value, 10);
  if (n >= 1 && n <= pzList.length && n - 1 !== pzIdx) pzStart(n - 1);
  else e.target.value = pzIdx + 1;
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
  const opp = pzOppName();
  const hidden = !pzShowPremove && !(pzMarks && pzMarks.always);
  const preSan = pzFirst && pzFirst.exact ? p.premoveSanVsAnswer : p.premoveSan;
  // Their move that led here, numbered as the game numbered it.
  let last = '';
  if (p.last) {
    const full = parseInt(p.fen.split(' ')[5], 10) || 1;
    last = '<span class="pz-mv">' + (p.solver === 'w' ? (full - 1) + '…' : full + '. ') + p.last + '</span>';
  }
  const theyDid = opp + (last ? ' just played ' + last + ' and' : '');
  let prompt;
  if (pzPhase === 'free') prompt = 'Playing it out against ' + opp + '.';
  else if (pzPhase === 'followup' || (pzPhase === 'held' && pzFirst)) {
    prompt = 'Their premove <span class="pz-mv pre">' + preSan + '</span> fired. Now cash in.';
  }
  else if (hidden) prompt = 'You’re ' + side + '. ' + theyDid + ' has a premove queued. Work out what it is, then make it backfire.';
  else prompt = 'You’re ' + side + '. ' + theyDid + ' premoved <span class="pz-mv pre">' + p.premoveSan + '</span>. Make it backfire.';
  // Typing a puzzle number survives the card redrawing under it (a move lands).
  const jump = el.querySelector('.pz-jump');
  const typing = jump && document.activeElement === jump ? jump.value : null;
  el.innerHTML =
    '<div class="pz-head"><span>⚡ Premove puzzle</span><label class="pz-count">' +
      '<input class="pz-jump" type="number" inputmode="numeric" min="1" max="' + pzList.length + '" value="' + (pzIdx + 1) +
      '" aria-label="Go to puzzle number"> / ' + pzList.length + '</label></div>' +
    '<p class="pz-prompt">' + prompt + '</p>' +
    '<p class="pz-note">' + pzNote + '</p>' +
    '<label class="pz-toggle"><input type="checkbox" data-act="toggle"' + (pzShowPremove ? ' checked' : '') + '> Show their premove</label>' +
    '<div class="pz-row">' +
      '<button type="button" class="pz-btn" data-act="prev">← Prev</button>' +
      '<button type="button" class="pz-btn" data-act="next">Next →</button>' +
      '<button type="button" class="pz-btn" data-act="reset">Reset</button>' +
      '<button type="button" class="pz-btn" data-act="exit">Exit</button>' +
    '</div>' +
    '<p class="pz-meta">From a Lichess 1+0 game, ' + p.solverRating + ' vs ' + p.premoverRating +
      (p.maia1500 != null ? ' · Maia 1500 finds the first move ' + Math.round(p.maia1500 * 100) + '% of the time' : '') +
      ' · <a href="https://lichess.org/' + p.id + '/' + (p.solver === 'w' ? 'white' : 'black') + '#' + p.ply +
      '" target="_blank" rel="noopener">see the game</a></p>';
  if (typing !== null) {
    const j = el.querySelector('.pz-jump');
    j.value = typing;
    j.focus({ preventScroll: true });
  }
  if (pzFlash) {
    pzFlash = false;
    el.classList.remove('pz-flash');
    void el.offsetWidth;          // restart the animation
    el.classList.add('pz-flash');
  }
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

// ── Eval bar ────────────────────────────────────────────────────────────────
// Puzzle games only: the jump when the premove fires, and how two candidate
// exploits compare, are the things worth seeing. Its own Stockfish worker, so
// it never competes with the bot's engine for a search; closed with the
// puzzles. The player's colour fills from their end of the bar, and the
// number sits at the end of whoever is ahead.
var pzEvalWorker = null, pzEvalReady = false, pzEvalBusy = false, pzEvalStopping = false;
var pzEvalFen = null;          // the position on the board
var pzEvalSearchFen = null;    // the position being searched
var pzEvalTurn = 'w';

function pzEvalSync() {
  const on = pzGameOnBoard();
  document.body.classList.toggle('pz-eval-on', on);
  if (!on) {
    if (pzEvalWorker) { try { pzEvalWorker.terminate(); } catch (e) {} }
    pzEvalWorker = null; pzEvalReady = false; pzEvalBusy = false; pzEvalStopping = false;
    pzEvalFen = null; pzEvalSearchFen = null;
    return;
  }
  const fen = pzFen();
  if (fen === pzEvalFen) return;
  pzEvalFen = fen;
  if (gameOver) {
    // Nothing to search: the result is the evaluation.
    const mated = allLegalMoves(board, turn, epSq, castling).length === 0 && inCheck(board, turn);
    pzEvalShow(mated ? { mate: 0, side: turn } : { cp: 0, side: 'w' });
    return;
  }
  pzEvalGo();
}

function pzEvalGo() {
  if (!pzEvalWorker) {
    try {
      pzEvalWorker = new Worker(SF_LOCAL);
      pzEvalWorker.onmessage = pzEvalOnLine;
      pzEvalWorker.postMessage('uci');
    } catch (e) { pzEvalWorker = null; }
    return;                     // readyok starts the search
  }
  if (!pzEvalReady || !pzEvalFen) return;
  if (pzEvalBusy) {
    // Never hand the engine a new position while it is searching: the
    // single-threaded wasm build traps ("unreachable") when the board changes
    // under a running search. Stop it, and start again on its bestmove.
    if (!pzEvalStopping) { pzEvalStopping = true; pzEvalWorker.postMessage('stop'); }
    return;
  }
  pzEvalBusy = true;
  pzEvalSearchFen = pzEvalFen;
  pzEvalTurn = pzEvalFen.split(' ')[1];
  pzEvalWorker.postMessage('position fen ' + pzEvalFen);
  pzEvalWorker.postMessage('go depth 18 movetime ' + PZ_EVAL_MS);
}

function pzEvalOnLine(e) {
  const line = e.data;
  if (line === 'uciok') { pzEvalWorker.postMessage('isready'); return; }
  if (line === 'readyok') { pzEvalReady = true; pzEvalGo(); return; }
  if (line.startsWith('bestmove')) {
    pzEvalBusy = false;
    pzEvalStopping = false;
    if (pzEvalFen && pzEvalFen !== pzEvalSearchFen) pzEvalGo();
    return;
  }
  // Lines from a search being stopped belong to an older position.
  if (pzEvalStopping || pzEvalSearchFen !== pzEvalFen) return;
  if (!line.startsWith('info ') || line.indexOf(' score ') < 0) return;
  if (/ (lowerbound|upperbound)/.test(line)) return;
  const m = / score (cp|mate) (-?\d+)/.exec(line);
  if (!m) return;
  pzEvalShow(m[1] === 'cp' ? { cp: +m[2], side: pzEvalTurn } : { mate: +m[2], side: pzEvalTurn });
}

// `s` is from the side to move: { cp, side } or { mate, side } (mate 0 = that
// side is mated).
function pzEvalShow(s) {
  const bar = document.getElementById('pzEval'), fill = document.getElementById('pzEvalFill'),
        lbl = document.getElementById('pzEvalLbl');
  if (!bar || !fill || !lbl || !pzCur) return;
  const me = pzSolverColor(), mine = s.side === me ? 1 : -1;
  let wp, text;
  if (s.mate != null) {
    const winning = s.mate > 0 ? mine : -mine;     // mate 0: the side to move is mated
    wp = winning > 0 ? 100 : 0;
    text = s.mate === 0 ? '#' : 'M' + Math.abs(s.mate);
  } else {
    const cp = s.cp * mine;
    wp = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    text = Math.abs(cp) >= 1000 ? String(Math.round(Math.abs(cp) / 100)) : (Math.abs(cp) / 100).toFixed(1);
  }
  const wide = !window.matchMedia('(max-width:760px)').matches;
  const meLight = me === 'w';
  bar.style.background = meLight ? '#3b3b3b' : '#f2f2f2';
  fill.style.background = meLight ? '#f2f2f2' : '#3b3b3b';
  fill.style.height = wide ? wp + '%' : '';
  fill.style.width = wide ? '' : wp + '%';
  const ahead = wp >= 50;                         // label at the end of whoever is ahead
  lbl.textContent = text;
  lbl.className = (ahead ? 'me' : 'them') + (ahead === meLight ? ' on-light' : ' on-dark');
  bar.setAttribute('aria-label', 'Evaluation: ' + (ahead ? 'you' : 'they') + ' are ahead by ' + text);
}

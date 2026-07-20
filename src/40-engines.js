function sfInit() {
  // Return same in-flight promise while init is running, so concurrent callers
  // all wait for the same worker rather than each creating their own.
  // On failure the promise is cleared so the next call retries from scratch
  // (same pattern as sfGhostInit — fixes the "worker dead but sfWorker non-null" bug).
  if (_sfInitPromise) return _sfInitPromise;
  if (sfWorker && sfReady) return Promise.resolve();
  // Terminate any stale/errored worker before creating a fresh one
  if (sfWorker) { try { sfWorker.terminate(); } catch(e) {} sfWorker = null; sfReady = false; }
  _sfInitPromise = new Promise(function(resolve, reject) {
    try {
      sfWorker = new Worker(SF_LOCAL);
      sfWorker.onmessage = function(e) {
        var line = e.data;
        if (line === 'uciok')   sfWorker.postMessage('isready');
        if (line === 'readyok') { sfReady = true; resolve(); }
        // Collect MultiPV info lines for the complexity probe.
        // Skip while bestmoves are owed — those info lines belong to a search
        // we already abandoned, not to the current probe.
        if (sfCplxActive && sfBestmovesOwed === 0 && line.startsWith('info') && line.includes('multipv')) {
          sfCplxInfoLines.push(line);
        }
        if (line.startsWith('bestmove')) {
          // Bestmove from an abandoned search — discard it. Without this, a
          // stopped/timed-out search's result resolves the NEXT request with a
          // move computed for a different position.
          if (sfBestmovesOwed > 0) { sfBestmovesOwed--; return; }
          if (sfCplxActive) {
            // This bestmove closes a probe (complexity or eval-moves), not a
            // normal move request
            sfCplxActive = false;
            sfWorker.postMessage('setoption name MultiPV value 1');
            sfCurrentSkillLevel = -1;
            var probeResult;
            if (sfProbeMode === 'evalmoves') {
              probeResult = _parseEvalMovesScores(sfCplxInfoLines);
            } else {
              var result = _computeCplxScore(sfCplxInfoLines);
              sfCplxScore = result ? result.cplx : null;
              sfCplxEval  = result ? result.eval  : null;
              probeResult = result;
            }
            sfProbeMode = 'cplx';
            var cplxRes = sfCplxPending;
            sfCplxPending = null;
            if (cplxRes) cplxRes(probeResult);
          } else if (sfPendingResolve) {
            var parts = line.split(' ');
            var move  = parts[1];
            var res   = sfPendingResolve;
            sfPendingResolve = null;
            res(move && move !== '(none)' ? move : null);
          }
        }
      };
      sfWorker.onerror = function(e) { console.warn('Bot SF error:', e); reject(e); };
      sfWorker.postMessage('uci');
      setTimeout(function() { if (!sfReady) reject(new Error('SF timeout')); }, 15000);
    } catch(e) { reject(e); }
  });
  // On failure: clear promise and worker so the next call can retry
  _sfInitPromise.catch(function() {
    _sfInitPromise = null;
    if (sfWorker) { try { sfWorker.terminate(); } catch(e) {} }
    sfWorker = null; sfReady = false;
  });
  return _sfInitPromise;
}

// ── Ghost-only Stockfish worker (completely separate — never shared with bot) ─
var _sfGhostInitPromise = null;
function sfGhostInit() {
  // Return the SAME pending promise while init is in flight — returning a
  // resolved promise just because the worker object exists made every hover
  // during the multi-second wasm load see sfGhostReady=false and draw nothing.
  if (_sfGhostInitPromise) return _sfGhostInitPromise;
  _sfGhostInitPromise = new Promise(function(resolve, reject) {
    try {
      sfGhostWorker = new Worker(SF_LOCAL);
      sfGhostWorker.onmessage = function(e) {
        var line = e.data;
        if (line === 'uciok')   sfGhostWorker.postMessage('isready');
        if (line === 'readyok') { sfGhostReady = true; resolve(); }
        if (line.startsWith('bestmove')) {
          // Discard bestmoves from abandoned searches (see sfBestmovesOwed)
          if (sfGhostBestmovesOwed > 0) { sfGhostBestmovesOwed--; return; }
          if (sfGhostPending) {
            var parts = line.split(' ');
            var move  = parts[1];
            var res   = sfGhostPending;
            sfGhostPending = null;
            res(move && move !== '(none)' ? move : null);
          }
        }
      };
      sfGhostWorker.onerror = function(e) { console.warn('Ghost SF error:', e); reject(e); };
      sfGhostWorker.postMessage('uci');
      setTimeout(function() { if (!sfGhostReady) reject(new Error('Ghost SF timeout')); }, 15000);
    } catch(e) { reject(e); }
  });
  // On failure, allow a future call to retry from scratch
  _sfGhostInitPromise.catch(function() {
    _sfGhostInitPromise = null;
    if (sfGhostWorker) { try { sfGhostWorker.terminate(); } catch(e) {} }
    sfGhostWorker = null; sfGhostReady = false;
  });
  return _sfGhostInitPromise;
}

// Convert from/to square indices to UCI move string (e.g. "e2e4")
function sqToUci(from, to, promo) {
  var files = 'abcdefgh';
  var fromStr = files[from % 8] + (8 - Math.floor(from / 8));
  var toStr   = files[to   % 8] + (8 - Math.floor(to   / 8));
  return fromStr + toStr + (promo || '');
}

function sfGhostGetMove(fen, depth, excludeUci, hypBoard, hypTurn, hypEp, hypCast) {
  return new Promise((resolve) => {
    if (!sfGhostWorker || !sfGhostReady) { resolve(null); return; }
    // Cancel any pending ghost search — its bestmove is still coming; discard it
    if (sfGhostPending) { sfGhostPending(null); sfGhostPending = null; sfGhostBestmovesOwed++; }
    sfGhostWorker.postMessage('stop');
    sfGhostPending = resolve;
    sfGhostWorker.postMessage('position fen ' + fen);

    var goCmd = 'go depth ' + Math.max(4, Math.min(12, depth));

    // If excluding a move, build searchmoves list of all legal moves EXCEPT excludeUci
    if (excludeUci && hypBoard && hypTurn != null) {
      var allUcis = [];
      for (var sq = 0; sq < 64; sq++) {
        var p = hypBoard[sq];
        if (!p || p.color !== hypTurn) continue;
        var moves = legalMovesFor(sq, hypBoard, hypEp != null ? hypEp : -1, hypCast || {wK:false,wQ:false,bK:false,bQ:false});
        for (var mi = 0; mi < moves.length; mi++) {
          var uci = sqToUci(sq, moves[mi]);
          // Handle pawn promotion
          var toR = Math.floor(moves[mi] / 8);
          if (p.piece === 'P' && (toR === 0 || toR === 7)) {
            // Add all four promotion options but only keep non-excluded
            ['q','r','b','n'].forEach(function(pr) {
              var u = sqToUci(sq, moves[mi], pr);
              if (u !== excludeUci) allUcis.push(u);
            });
            continue;
          }
          if (uci !== excludeUci) allUcis.push(uci);
        }
      }
      if (allUcis.length > 0) {
        goCmd = 'go depth ' + Math.max(4, Math.min(12, depth)) + ' searchmoves ' + allUcis.join(' ');
      }
    }

    sfGhostWorker.postMessage(goCmd);
    // 5s timeout (slightly longer since searchmoves can be slower)
    setTimeout(() => {
      if (sfGhostPending === resolve) {
        sfGhostPending = null;
        sfGhostBestmovesOwed++; // engine still owes this search's bestmove
        resolve(null);
      }
    }, 5000);
  });
}

function sfGetMove(fen, levelOrDepth, isDepth=false) {
  return new Promise((resolve) => {
    if (!sfWorker || !sfReady) { resolve(null); return; }
    // Cancel any pending request — its search is still running, so the engine
    // still owes us a bestmove for it; mark it for discard.
    if (sfPendingResolve) {
      const old = sfPendingResolve;
      sfPendingResolve = null;
      sfBestmovesOwed++;
      old(null);
    }
    sfPendingResolve = resolve;
    sfWorker.postMessage('stop'); // cancel any in-progress search
    // ucinewgame is sent once per game in botStart — not here, as clearing the TT
    // every move would throw away the positional knowledge SF just built up.
    // Only update Skill Level when it actually changes.
    if (!isDepth) {
      const clampedLevel = Math.max(0, Math.min(20, levelOrDepth));
      if (clampedLevel !== sfCurrentSkillLevel) {
        sfWorker.postMessage('setoption name Skill Level value ' + clampedLevel);
        sfCurrentSkillLevel = clampedLevel;
      }
    }
    sfWorker.postMessage('position fen ' + fen);
    const depth = isDepth ? levelOrDepth : (levelOrDepth <= 4 ? 5 : levelOrDepth <= 10 ? 8 : 12);
    sfWorker.postMessage('go depth ' + depth);
    // Safety timeout — resolve null after 5s to prevent hangs
    setTimeout(() => {
      if (sfPendingResolve === resolve) {
        sfPendingResolve = null;
        sfBestmovesOwed++; // the engine will still emit a bestmove — discard it
        resolve(null);
      }
    }, 5000);
  });
}

// ── MultiPV complexity probe ──────────────────────────────────────────────────
// Runs a depth-12 MultiPV=2 search on sfWorker concurrently with Maia inference.
// Returns Promise<{cplx:0..1, eval:cp}|null>. One-move cache on sfCplxFen.
function sfGetComplexity(fen) {
  return new Promise((resolve) => {
    if (!sfWorker || !sfReady) { resolve(null); return; }
    // Return cached result if position hasn't changed
    if (sfCplxFen === fen && sfCplxScore !== null) {
      resolve({ cplx: sfCplxScore, eval: sfCplxEval }); return;
    }
    // Cannot run while a move request is in flight — skip and return null
    if (sfPendingResolve) { resolve(null); return; }
    sfCplxActive   = true;
    sfCplxPending  = resolve;
    sfCplxInfoLines = [];
    sfCplxFen      = fen;
    sfWorker.postMessage('stop');
    if (sfCurrentSkillLevel !== 20) {
      sfWorker.postMessage('setoption name Skill Level value 20');
      sfCurrentSkillLevel = 20;
    }
    sfWorker.postMessage('setoption name MultiPV value 2');
    sfWorker.postMessage('position fen ' + fen);
    sfWorker.postMessage('go depth 12');
    // 3 s safety timeout — avoids indefinite wait if SF is stalled
    setTimeout(() => {
      if (sfCplxPending === resolve) {
        sfCplxActive  = false;
        sfCplxPending = null;
        sfBestmovesOwed++; // probe's bestmove will still arrive — discard it
        sfWorker.postMessage('setoption name MultiPV value 1');
        sfCurrentSkillLevel = -1;
        resolve(null);
      }
    }, 3000);
  });
}

// ── Two-move eval probe (degradation guard) ───────────────────────────────────
// Evaluates exactly the given candidate moves (searchmoves + MultiPV) and
// returns Promise<{uci: cp}|null>, scores from the side-to-move's perspective.
// Shares the probe plumbing with sfGetComplexity (sfCplxActive/sfCplxPending);
// only one probe runs at a time, and probes never run while a move request is
// in flight.
var sfProbeMode = 'cplx'; // 'cplx' | 'evalmoves' — how to parse the probe result
function sfEvalMoves(fen, moves, depth) {
  return new Promise((resolve) => {
    if (!sfWorker || !sfReady || !moves || moves.length < 2) { resolve(null); return; }
    if (sfPendingResolve || sfCplxActive) { resolve(null); return; }
    sfCplxActive    = true;
    sfProbeMode     = 'evalmoves';
    sfCplxPending   = resolve;
    sfCplxInfoLines = [];
    sfCplxFen       = null; // never serve this probe's residue as a cached complexity result
    sfWorker.postMessage('stop');
    if (sfCurrentSkillLevel !== 20) {
      sfWorker.postMessage('setoption name Skill Level value 20');
      sfCurrentSkillLevel = 20;
    }
    sfWorker.postMessage('setoption name MultiPV value ' + moves.length);
    sfWorker.postMessage('position fen ' + fen);
    sfWorker.postMessage('go depth ' + (depth || 10) + ' searchmoves ' + moves.join(' '));
    // Safety timeout — the guard must not stall the bot's move. Scales with
    // candidate count since a wider MultiPV probe (CP-budget acceptance can
    // send well over a dozen moves) genuinely takes longer than the 2-move
    // degradation-guard probe; capped so a large list still fails open promptly.
    const timeoutMs = Math.min(4500, 2000 + moves.length * 150);
    setTimeout(() => {
      if (sfCplxPending === resolve) {
        sfCplxActive  = false;
        sfProbeMode   = 'cplx';
        sfCplxPending = null;
        sfBestmovesOwed++; // probe's bestmove will still arrive — discard it
        sfWorker.postMessage('setoption name MultiPV value 1');
        sfCurrentSkillLevel = -1;
        resolve(null);
      }
    }, timeoutMs);
  });
}

// Parse MultiPV info lines into {uci: cp} using the deepest score seen for the
// first move of each pv. Mate scores map to ±(10000 − plies) so nearer mates
// compare higher.
function _parseEvalMovesScores(lines) {
  var best = {}; // uci → {depth, cp}
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var dm  = line.match(/\bdepth (\d+)/);
    var pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
    var cm  = line.match(/\bscore cp (-?\d+)/);
    var mm  = line.match(/\bscore mate (-?\d+)/);
    if (!dm || !pvm) continue;
    var cp = cm ? +cm[1] : mm ? (+mm[1] > 0 ? 10000 - +mm[1] : -10000 - +mm[1]) : null;
    if (cp === null) continue;
    var uci = pvm[1], d = +dm[1];
    if (!best[uci] || d >= best[uci].depth) best[uci] = { depth: d, cp: cp };
  }
  var out = {}, n = 0;
  for (var k in best) { out[k] = best[k].cp; n++; }
  return n ? out : null;
}

function _computeCplxScore(lines) {
  const byDepth = {};
  for (const line of lines) {
    const dm = line.match(/\bdepth (\d+)/);
    const pm = line.match(/\bmultipv (\d+)/);
    const cm = line.match(/\bscore cp (-?\d+)/);
    const mm = line.match(/\bscore mate (-?\d+)/);
    if (!dm || !pm) continue;
    const d = +dm[1], pv = +pm[1];
    const score = cm ? +cm[1] : mm ? (+mm[1] > 0 ? 3000 : -3000) : null;
    if (score === null) continue;
    if (!byDepth[d]) byDepth[d] = {};
    if (pv === 1) byDepth[d].pv1 = score;
    if (pv === 2) byDepth[d].pv2 = score;
  }
  const depths = Object.keys(byDepth).map(Number).filter(d => byDepth[d].pv1 != null);
  if (depths.length < 2) return { cplx: 0.5, eval: null };
  const pv1s   = depths.map(d => byDepth[d].pv1);
  const mean   = pv1s.reduce((a, b) => a + b, 0) / pv1s.length;
  const stdDev = Math.sqrt(pv1s.reduce((a, v) => a + (v - mean) ** 2, 0) / pv1s.length);
  const normStdDev = Math.min(1, stdDev / 100);
  const maxD   = Math.max(...depths);
  const gap    = byDepth[maxD].pv2 != null
    ? Math.abs(byDepth[maxD].pv1 - byDepth[maxD].pv2)
    : 200;
  const normGap = Math.max(0, 1 - Math.min(gap, 300) / 300);
  return { cplx: Math.min(1, normStdDev * 0.6 + normGap * 0.4), eval: byDepth[maxD].pv1 };
}

// Returns true if the complexity probe is worth running this move
function _needsComplexity() {
  const av = window._bcpAttractorValues || {};
  if ((av['chaos'] || 0) !== 0 || (av['compwin'] || 0) !== 0 || botTimeBehavior === 'complexity') {
    return true;
  }
  // Stalemate seeking needs the eval to know when desperation kicks in
  if (typeof botStaleSeek !== 'undefined' && botStaleSeek) return true;
  // A custom control with a winning/losing/equal condition needs the eval probe.
  const cc = window._bcpCustomControls || [];
  return cc.some(c => c && c.value && c.result && c.result !== 'any');
}

// Scales base Maia temperature up/down based on position complexity + attractor values
function complexityAdjustedTemp(baseTemp) {
  const av = window._bcpAttractorValues || {};
  const chaosV   = av['chaos']   || 0;
  const compwinV = av['compwin'] || 0;
  if ((chaosV === 0 && compwinV === 0) || sfCplxScore === null) return baseTemp;
  let temp = baseTemp;
  if (chaosV !== 0) {
    // Seek complexity when chaos>0, simplicity when chaos<0
    const cplxSignal = Math.tanh((sfCplxScore - 0.5) * 4);
    temp *= Math.exp(chaosV * 0.08 * cplxSignal);
  }
  if (compwinV !== 0 && sfCplxEval !== null && sfCplxEval > 50) {
    // When winning (+50cp+), seek complexity to complicate; avoid when losing
    const cplxSignal = Math.tanh((sfCplxScore - 0.5) * 4);
    temp *= Math.exp(compwinV * 0.08 * cplxSignal);
  }
  return Math.max(0.1, Math.min(5.0, temp));
}

// ── Board state to FEN ───────────────────────────────────────────────────────
function boardToFen(bd, turnColor, cst, ep, halfmove = 0, fullmove = 1) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '', empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = bd[rcSq(r, c)];
      if (!p) { empty++; }
      else {
        if (empty) { row += empty; empty = 0; }
        const ch = p.piece === 'N' ? 'n' : p.piece.toLowerCase();
        row += p.color === 'w' ? ch.toUpperCase() : ch;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  let castStr = '';
  if (cst.wK) castStr += 'K'; if (cst.wQ) castStr += 'Q';
  if (cst.bK) castStr += 'k'; if (cst.bQ) castStr += 'q';
  if (!castStr) castStr = '-';
  const epStr = ep >= 0 ? (String.fromCharCode(97 + ep % 8) + (8 - Math.floor(ep / 8))) : '-';
  return rows.join('/') + ' ' + turnColor + ' ' + castStr + ' ' + epStr + ' ' + halfmove + ' ' + fullmove;
}

// ── UCI move to from/to squares ──────────────────────────────────────────────
function uciToSq(uci) {
  if (!uci || uci.length < 4) return null;
  const fc = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1]);
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3]);
  const promo = uci.length === 5 ? uci[4].toUpperCase() : null;
  return { from: rcSq(fr, fc), to: rcSq(tr, tc), promo };
}

// ── Maia-2 via Lichess API ───────────────────────────────────────────────────
// Uses Lichess cloud eval as a proxy — returns top moves with probabilities
// ── Maia3 ONNX Engine ────────────────────────────────────────────────────────
// Runs real Maia3 inference in-browser via Web Worker + ONNX Runtime Web.
// Falls back to Lichess Explorer API if model not loaded.

var _maiaWorker = null;
var _maiaReady = false;
var _maiaStatus = 'idle'; // idle | loading | downloading | ready | error
var _maiaPendingInferences = new Map();
var _maiaNextId = 0;
var _maiaProgress = 0;

// Move mapping: loaded from /data/all_moves_maia3.json
var _maia3MoveIndex = null;       // { "e2e4": 1234, ... }
var _maia3MoveReversed = null;    // { "1234": "e2e4", ... }

// Mirror helpers (from tensor.ts)
function _maiaSquare(sq) {
  return sq[0] + (9 - parseInt(sq[1]));
}
function _maiaMove(uci) {
  var from = _maiaSquare(uci.slice(0,2));
  var to   = _maiaSquare(uci.slice(2,4));
  return from + to + (uci.length > 4 ? uci[4] : '');
}
function _maiaSwapRank(rank) {
  var out = '';
  for (var i = 0; i < rank.length; i++) {
    var c = rank[i];
    if (c >= 'A' && c <= 'Z') out += c.toLowerCase();
    else if (c >= 'a' && c <= 'z') out += c.toUpperCase();
    else out += c;
  }
  return out;
}
function _maiaSwapCastling(c) {
  if (c === '-') return '-';
  var r = new Set(c.split(''));
  var s = new Set();
  if (r.has('K')) s.add('k'); if (r.has('Q')) s.add('q');
  if (r.has('k')) s.add('K'); if (r.has('q')) s.add('Q');
  var out = '';
  if (s.has('K')) out += 'K'; if (s.has('Q')) out += 'Q';
  if (s.has('k')) out += 'k'; if (s.has('q')) out += 'q';
  return out || '-';
}
function _maiaFlipFen(fen) {
  var parts = fen.split(' ');
  var ranks = parts[0].split('/');
  var flipped = ranks.slice().reverse().map(_maiaSwapRank).join('/');
  var activeColor = parts[1] === 'w' ? 'b' : 'w';
  var castling = _maiaSwapCastling(parts[2]);
  var ep = parts[3] !== '-' ? _maiaSquare(parts[3]) : '-';
  return flipped + ' ' + activeColor + ' ' + castling + ' ' + ep + ' ' + parts[4] + ' ' + parts[5];
}

// Encode FEN into Maia3 (64×12) board token tensor
function _maiaEncode(fen) {
  // Mirror if black to move — Maia3 always sees board from white's perspective
  var workFen = fen.split(' ')[1] === 'b' ? _maiaFlipFen(fen) : fen;
  var tokens = new Float32Array(64 * 12);
  var pieceTypes = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  var rows = workFen.split(' ')[0].split('/');
  for (var rank = 0; rank < 8; rank++) {
    var row = 7 - rank;
    var file = 0;
    for (var ci = 0; ci < rows[rank].length; ci++) {
      var ch = rows[rank][ci];
      var n = parseInt(ch);
      if (isNaN(n)) {
        var pi = pieceTypes.indexOf(ch);
        if (pi >= 0) tokens[(row * 8 + file) * 12 + pi] = 1.0;
        file++;
      } else {
        file += n;
      }
    }
  }
  return { tokens: tokens, workFen: workFen };
}

// Build legal moves mask (4352 entries) — always in model's coordinate space
function _maiaLegalMask(fen) {
  if (!_maia3MoveIndex) return null;

  var parts = fen.split(' ');
  var sideToMove = parts[1];
  var isBlack = sideToMove === 'b';
  var castlingStr = parts[2];
  var epStr = parts[3];

  // Build board directly from original FEN (no flipping)
  var tmpBoard = new Array(64).fill(null);
  var pieceMap = {
    'P':{color:'w',piece:'P'},'N':{color:'w',piece:'N'},'B':{color:'w',piece:'B'},
    'R':{color:'w',piece:'R'},'Q':{color:'w',piece:'Q'},'K':{color:'w',piece:'K'},
    'p':{color:'b',piece:'P'},'n':{color:'b',piece:'N'},'b':{color:'b',piece:'B'},
    'r':{color:'b',piece:'R'},'q':{color:'b',piece:'Q'},'k':{color:'b',piece:'K'},
  };
  var rows = parts[0].split('/');
  for (var rank = 0; rank < 8; rank++) {
    // FEN rank0 = rank8 = Blundermind row=0
    var file = 0;
    for (var ci = 0; ci < rows[rank].length; ci++) {
      var ch = rows[rank][ci];
      var n = parseInt(ch);
      if (isNaN(n)) { tmpBoard[rank * 8 + file] = pieceMap[ch] || null; file++; }
      else file += n;
    }
  }

  var cst = { wK: castlingStr.includes('K'), wQ: castlingStr.includes('Q'),
               bK: castlingStr.includes('k'), bQ: castlingStr.includes('q') };
  var epSqTmp = -1;
  if (epStr !== '-') {
    var ef = epStr.charCodeAt(0) - 'a'.charCodeAt(0);
    var er = 8 - parseInt(epStr[1]); // rank -> Blundermind row
    epSqTmp = er * 8 + ef;
  }

  var mask = new Float32Array(4352);
  var files = 'abcdefgh';

  function sqToUci(sq) {
    return files[sq % 8] + (8 - Math.floor(sq / 8));
  }

  // Mirror a UCI move string into model coordinate space (flip ranks 1<->8, 2<->7, etc.)
  function toModelSpace(uci) {
    var fromFile = uci[0], fromRank = String(9 - parseInt(uci[1]));
    var toFile   = uci[2], toRank   = String(9 - parseInt(uci[3]));
    var promo = uci.length > 4 ? uci[4] : '';
    return fromFile + fromRank + toFile + toRank + promo;
  }

  for (var sq = 0; sq < 64; sq++) {
    var p = tmpBoard[sq];
    if (!p || p.color !== sideToMove) continue;
    var moves = legalMovesFor(sq, tmpBoard, epSqTmp, cst);
    for (var mi = 0; mi < moves.length; mi++) {
      var fromStr = sqToUci(sq);
      var toStr   = sqToUci(moves[mi]);
      var isPromo = p.piece === 'P' && (
        (sideToMove === 'w' && Math.floor(moves[mi] / 8) === 0) ||
        (sideToMove === 'b' && Math.floor(moves[mi] / 8) === 7)
      );
      if (isPromo) {
        ['q','r','b','n'].forEach(function(pr) {
          var uci = fromStr + toStr + pr;
          var modelUci = isBlack ? toModelSpace(uci) : uci;
          var idx = _maia3MoveIndex[modelUci];
          if (idx !== undefined) mask[idx] = 1.0;
        });
      } else {
        var uci = fromStr + toStr;
        var modelUci = isBlack ? toModelSpace(uci) : uci;
        var idx = _maia3MoveIndex[modelUci];
        if (idx !== undefined) mask[idx] = 1.0;
      }
    }
  }
  return mask;
}

// Process Maia3 outputs into move probability dict
function _maiaProcess(fen, logitsMove, logitsValue, legalMask) {
  var isBlack = fen.split(' ')[1] === 'b';

  // Get legal move indices (these are already in model coordinate space)
  var legalIdx = [];
  for (var i = 0; i < legalMask.length; i++) {
    if (legalMask[i] > 0) legalIdx.push(i);
  }
  if (!legalIdx.length) return null;

  // Softmax over legal logits only
  var legalLogits = legalIdx.map(function(i) { return logitsMove[i]; });
  var maxL = Math.max.apply(null, legalLogits);
  var expL = legalLogits.map(function(l) { return Math.exp(l - maxL); });
  var sumE = expL.reduce(function(a,b) { return a+b; }, 0);

  var probs = {};
  for (var j = 0; j < legalIdx.length; j++) {
    var moveStr = _maia3MoveReversed[String(legalIdx[j])];
    if (!moveStr) continue;

    // If Black, mirror the model-space move back to real board coordinates
    if (isBlack) {
      var fromFile = moveStr[0], fromRank = String(9 - parseInt(moveStr[1]));
      var toFile   = moveStr[2], toRank   = String(9 - parseInt(moveStr[3]));
      var promo = moveStr.length > 4 ? moveStr[4] : '';
      moveStr = fromFile + fromRank + toFile + toRank + promo;
    }

    probs[moveStr] = expL[j] / sumE;
  }
  return probs;
}

// ELO conditioning test — runs same position at 600 and 2600, logs differences
async function maiaEloTest() {
  if (!_maiaReady) { console.log('[ELO TEST] Model not ready'); return; }
  if (!_maia3MoveIndex) await _maiaLoadMappings();

  // The key test: do different ELOs produce meaningfully different move probabilities?
  // We test the SAME position at 600 vs 2600.
  // If the model's ELO embedding is collapsed (1 row), all ELOs give identical output.
  // If working, probabilities should differ significantly.

  var testFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  var legalMask = _maiaLegalMask(testFen);

  console.log('[ELO TEST] Running 600 vs 2600 comparison...');
  var results = {};
  for (var elo of [600, 2600]) {
    var id = _maiaNextId++;
    var tokens = _maiaEncode(testFen).tokens;
    var result = await new Promise(function(resolve, reject) {
      _maiaPendingInferences.set(id, { resolve, reject });
      _maiaWorker.postMessage({
        type: 'inference', id,
        tokens: tokens.buffer,
        eloSelfs: Float32Array.from([elo]).buffer,
        eloOppos: Float32Array.from([elo]).buffer,
        batchSize: 1
      }, [tokens.buffer]);
    });
    results[elo] = Array.from(result.logitsMove);
  }

  // Compare raw logits between 600 and 2600
  var logits600  = results[600];
  var logits2600 = results[2600];
  var maxDiff = 0, sumDiff = 0;
  for (var i = 0; i < logits600.length; i++) {
    var diff = Math.abs(logits600[i] - logits2600[i]);
    maxDiff = Math.max(maxDiff, diff);
    sumDiff += diff;
  }
  var avgDiff = sumDiff / logits600.length;

  console.log('[ELO TEST] Logit comparison 600 vs 2600:');
  console.log('  Max difference:', maxDiff.toFixed(6));
  console.log('  Avg difference:', avgDiff.toFixed(6));
  if (maxDiff < 0.001) {
    console.log('  *** IDENTICAL LOGITS — ELO embedding is collapsed (1-row table) ***');
    console.log('  *** The model file needs to be replaced with the full version ***');
  } else if (maxDiff < 0.1) {
    console.log('  *** VERY SMALL DIFFERENCES — ELO conditioning is very weak ***');
  } else {
    console.log('  *** SIGNIFICANT DIFFERENCES — ELO conditioning is working ***');
  }
}

// Initialize the Maia worker
function maiaInit() {
  if (_maiaWorker) return;
  try {
    _maiaWorker = new Worker('/maia-worker.js');
    _maiaWorker.onmessage = function(e) {
      var msg = e.data;
      if (msg.type === 'status') {
        _maiaStatus = msg.status;
        // Set the ready flag BEFORE pushing status to the UI/iframe — the push
        // includes `ready: _maiaReady`, and sending {status:'ready', ready:false}
        // left the panel's download overlay stuck on top of the Elometer until
        // some later push happened to correct it.
        _maiaReady = (msg.status === 'ready');
        _maiaUpdateStatusUI();
        if (msg.status === 'ready') {
          // After a successful download (not just a cache hit on reload) request
          // persistent storage so the browser won't evict the 87 MB model.
          // Only call persist() once — it's a no-op if already granted.
          if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(function(){});
          }
        }
      } else if (msg.type === 'progress') {
        _maiaProgress = msg.progress;
        _maiaUpdateStatusUI();
      } else if (msg.type === 'inference-result') {
        var pending = _maiaPendingInferences.get(msg.id);
        if (pending) {
          pending.resolve({
            logitsMove: new Float32Array(msg.logitsMove),
            logitsValue: new Float32Array(msg.logitsValue)
          });
          _maiaPendingInferences.delete(msg.id);
        }
      } else if (msg.type === 'error') {
        console.warn('Maia worker error:', msg.message);
        if (msg.id !== undefined) {
          var p = _maiaPendingInferences.get(msg.id);
          if (p) { p.reject(new Error(msg.message)); _maiaPendingInferences.delete(msg.id); }
        }
      }
    };
    _maiaWorker.onerror = function(err) {
      console.warn('Maia worker crashed:', err);
      _maiaStatus = 'error'; _maiaReady = false;
      _maiaUpdateStatusUI();
    };
    _maiaWorker.postMessage({ type: 'init', modelUrl: '/models/maia3_simplified.onnx', modelVersion: '3' });
  } catch(err) {
    console.warn('Could not start Maia worker:', err);
    _maiaStatus = 'error';
  }
}

// Load move mapping JSONs (fetched once, cached)
async function _maiaLoadMappings() {
  if (_maia3MoveIndex && _maia3MoveReversed) return true;
  try {
    var [r1, r2] = await Promise.all([
      fetch('/data/all_moves_maia3.json'),
      fetch('/data/all_moves_maia3_reversed.json')
    ]);
    _maia3MoveIndex    = await r1.json();
    _maia3MoveReversed = await r2.json();
    return true;
  } catch(e) {
    console.warn('Could not load Maia3 move mappings:', e);
    return false;
  }
}

// Download model on user request
async function maiaDownloadModel() {
  var btn = document.getElementById('maiaDownloadBtn');
  if (btn) btn.disabled = true;
  if (!_maiaWorker) maiaInit();
  await _maiaLoadMappings();
  if (_maiaWorker) _maiaWorker.postMessage({ type: 'download' });
}

// Update download button / status display
function _maiaUpdateStatusUI() {
  // Ghost "model missing" hint clears itself the moment the model is ready
  if (_maiaStatus === 'ready') {
    var _gh = document.getElementById('ghostMaiaHint');
    if (_gh) _gh.style.display = 'none';
  }
  // Update both the maia tab and maia3 tab status elements
  var statusEl  = document.getElementById('maiaStatusText');
  var statusEl3 = document.getElementById('maia3StatusText');
  var btn   = document.getElementById('maiaDownloadBtn');
  var btn3  = document.getElementById('maia3DownloadBtn');
  var labels = {
    'idle': 'Not loaded', 'loading': 'Loading from cache…',
    'no-cache': 'Not downloaded', 'downloading': 'Downloading… ' + _maiaProgress + '%',
    'ready': '✓ Ready', 'error': '✗ Error loading model'
  };
  var txt = labels[_maiaStatus] || _maiaStatus;
  var clr = _maiaStatus === 'ready' ? '#5ad490' : _maiaStatus === 'error' ? '#e04040' : 'var(--text-dim)';
  if (statusEl)  { statusEl.textContent  = txt; statusEl.style.color  = clr; }
  if (statusEl3) { statusEl3.textContent = txt; statusEl3.style.color = clr; }
  var disabled = (_maiaStatus === 'downloading' || _maiaStatus === 'ready');
  var btnTxt = _maiaStatus === 'ready' ? '✓ Model ready' : 'Download Maia3 (~87MB)';
  if (btn)  { btn.disabled  = disabled; btn.textContent  = btnTxt; }
  if (btn3) { btn3.disabled = disabled; btn3.textContent = btnTxt; }
  // Enable/dim Maia row tabs based on model readiness
  var maiaTabsReady = (_maiaStatus === 'ready');
  ['btab-maia3','btab-maia'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.style.opacity = maiaTabsReady ? '1' : '0.5';
      el.title = maiaTabsReady ? '' : 'Download Maia3 model to enable';
    }
  });
  // Push live status to new bot control panel iframe
  try {
    var _bcpIframe = document.getElementById('botModalFrame');
    if (_bcpIframe && _bcpIframe.contentWindow) {
      _bcpIframe.contentWindow.postMessage({
        type: 'maiaStatus', status: _maiaStatus, ready: _maiaReady, progress: _maiaProgress
      }, location.origin);
    }
  } catch(e) {}
  return; // skip old code below
}

// Main Maia3 inference — returns move probs dict or null
async function maia3GetMoveProbs(fen) {
  if (!_maiaReady || !_maiaWorker) return null;
  if (!_maia3MoveIndex) {
    var ok = await _maiaLoadMappings();
    if (!ok) return null;
  }
  try {
    var eloSelf = parseInt(lcSelectedRating) || 1200;
    var eloOppo = eloSelf;

    var encoded = _maiaEncode(fen);
    var tokens = encoded.tokens;
    var workFen = encoded.workFen;

    var legalMask = _maiaLegalMask(fen);  // use original FEN — real board coords
    if (!legalMask) return null;

    var id = _maiaNextId++;
    var t0 = Date.now();
    var result = await new Promise(function(resolve, reject) {
      _maiaPendingInferences.set(id, { resolve, reject });
      _maiaWorker.postMessage({
        type: 'inference', id,
        tokens: tokens.buffer, eloSelfs: Float32Array.from([eloSelf]).buffer,
        eloOppos: Float32Array.from([eloOppo]).buffer, batchSize: 1
      }, [tokens.buffer]);
    });

    return _maiaProcess(fen, result.logitsMove, result.logitsValue, legalMask);
  } catch(e) {
    console.warn('Maia3 inference error:', e);
    return null;
  }
}

// ── Lichess Explorer API (was "Maia") ────────────────────────────────────────
let lcSelectedRating = '1200'; // default rating band

// Default SF fallback levels for each LC rating band
var LC_FALLBACK_MAP = {
  '400':  1, '1000': 2, '1200': 2,
  '1400': 3, '1600': 4, '1800': 4,
  '2000': 5, '2200': 6
};

// Separate rating state for each LC mode
var lcsfSelectedRating = '1200';  // LC+SF tab
// lcSelectedRating already declared above — used for LC+Maia tab

function lcSetRating(rating) {
  lcSelectedRating = rating;
  document.querySelectorAll('[id^="lcr-"]').forEach(function(b) {
    b.classList.toggle('tc-active', b.id === 'lcr-' + rating);
  });
}

function lcsfSetRating(rating) {
  lcsfSelectedRating = rating;
  document.querySelectorAll('[id^="lcsf-"]').forEach(function(b) {
    b.classList.toggle('tc-active', b.id === 'lcsf-' + rating);
  });
  // Auto-set SF fallback level
  var defaultLevel = LC_FALLBACK_MAP[rating] || 5;
  var slider = document.getElementById('lcsfFallbackLevel');
  var display = document.getElementById('lcsfFallbackVal');
  if (slider) slider.value = defaultLevel;
  if (display) display.textContent = defaultLevel;
}

// Maia3-only tab rating
var maia3SelectedRating = 1200;

function maia3SetRating(rating) {
  maia3SelectedRating = rating;
  document.querySelectorAll('[id^="m3r-"]').forEach(function(b) {
    b.classList.toggle('tc-active', b.id === 'm3r-' + rating);
  });
  // Refresh clock panel name if a bot game is active
  if (typeof botActive !== 'undefined' && botActive &&
      typeof botUpdatePlayerNames === 'function' &&
      typeof botPlayerColor !== 'undefined') {
    botUpdatePlayerNames(botPlayerColor);
  }
}

function lcsfFallbackLevel() {
  var el = document.getElementById('lcsfFallbackLevel');
  return el ? parseInt(el.value) || 5 : 5;
}

function lcFallbackLevel() {
  var el = document.getElementById('lcFallbackLevel');
  return el ? parseInt(el.value) || 5 : 5;
}

async function maiaGetMoveProbs(fen) {
  try {
    // Use the selected rating band only — filter to just those games for more authentic play
    var rating = lcSelectedRating || '1200';
    var url = 'https://explorer.lichess.ovh/lichess?fen=' + encodeURIComponent(fen) +
              '&ratings=' + rating + '&speeds=blitz,rapid,classical&moves=15';
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Lichess API error ' + resp.status);
    var data = await resp.json();
    var moves = data.moves || [];
    if (!moves.length) return null;
    var total = moves.reduce(function(s, m) { return s + m.white + m.draws + m.black; }, 0) || 1;
    var probs = {};
    moves.forEach(function(m) { probs[m.uci] = (m.white + m.draws + m.black) / total; });
    return probs;
  } catch(e) {
    console.warn('Lichess Explorer fallback:', e);
    return null;
  }
}

// ── Phase 2: Opening book ─────────────────────────────────────────────────────

// ECO opening library — nested by family → variation.
// Each entry: { prefix, color, eco }
// 'prefix' is matched against data.opening.eco using startsWith().
// 'color' is which side the bot plays this opening as.
const ECO_LIBRARY = {
  "e4 Openings": {
    "Sicilian Defense": {
      "Sicilian (General)":      { eco: "B20", prefix: "B2",  color: "black" },
      "Najdorf":                 { eco: "B90", prefix: "B9",  color: "black" },
      "Dragon":                  { eco: "B70", prefix: "B7",  color: "black" },
      "Scheveningen":            { eco: "B80", prefix: "B8",  color: "black" },
      "Classical":               { eco: "B58", prefix: "B5",  color: "black" },
      "Kan / Taimanov":          { eco: "B40", prefix: "B4",  color: "black" },
      "Alapin (2.c3)":           { eco: "B22", prefix: "B22", color: "white" },
      "Grand Prix Attack":       { eco: "B23", prefix: "B23", color: "white" },
    },
    "French Defense": {
      "French (General)":        { eco: "C00", prefix: "C0",  color: "black" },
      "Winawer":                 { eco: "C15", prefix: "C15", color: "black" },
      "Classical":               { eco: "C14", prefix: "C14", color: "black" },
      "Tarrasch":                { eco: "C03", prefix: "C03", color: "black" },
      "Advance":                 { eco: "C02", prefix: "C02", color: "black" },
    },
    "Caro-Kann Defense": {
      "Caro-Kann (General)":     { eco: "B10", prefix: "B1",  color: "black" },
      "Classical":               { eco: "B18", prefix: "B18", color: "black" },
      "Advance":                 { eco: "B12", prefix: "B12", color: "black" },
      "Panov Attack":            { eco: "B13", prefix: "B13", color: "black" },
    },
    "Ruy Lopez": {
      "Ruy Lopez (General)":     { eco: "C60", prefix: "C6",  color: "white" },
      "Berlin Defense":          { eco: "C65", prefix: "C65", color: "black" },
      "Marshall Attack":         { eco: "C89", prefix: "C89", color: "black" },
      "Closed":                  { eco: "C84", prefix: "C84", color: "white" },
      "Exchange Variation":      { eco: "C68", prefix: "C68", color: "white" },
    },
    "Italian Game": {
      "Italian (General)":       { eco: "C50", prefix: "C5",  color: "white" },
      "Giuoco Piano":            { eco: "C53", prefix: "C53", color: "white" },
      "Evans Gambit":            { eco: "C51", prefix: "C51", color: "white" },
      "Two Knights":             { eco: "C55", prefix: "C55", color: "black" },
    },
    "Pirc / Modern": {
      "Pirc Defense":            { eco: "B07", prefix: "B07", color: "black" },
      "Modern Defense":          { eco: "B06", prefix: "B06", color: "black" },
    },
    "Scandinavian": {
      "Scandinavian (General)":  { eco: "B01", prefix: "B01", color: "black" },
    },
    "King's Gambit": {
      "King's Gambit (General)": { eco: "C30", prefix: "C3",  color: "white" },
      "King's Gambit Accepted":  { eco: "C34", prefix: "C34", color: "black" },
      "King's Gambit Declined":  { eco: "C30", prefix: "C30", color: "black" },
    },
    "Alekhine's Defense": {
      "Alekhine (General)":      { eco: "B02", prefix: "B02", color: "black" },
    },
  },
  "d4 Openings": {
    "Queen's Gambit": {
      "QGD (General)":           { eco: "D30", prefix: "D3",  color: "white" },
      "Queen's Gambit Accepted": { eco: "D20", prefix: "D2",  color: "black" },
      "Orthodox Defense":        { eco: "D60", prefix: "D6",  color: "black" },
      "Tarrasch Defense":        { eco: "D32", prefix: "D32", color: "black" },
      "Exchange Variation":      { eco: "D35", prefix: "D35", color: "white" },
      "Semi-Slav":               { eco: "D43", prefix: "D43", color: "black" },
      "Slav Defense":            { eco: "D10", prefix: "D1",  color: "black" },
    },
    "King's Indian": {
      "King's Indian (General)": { eco: "E60", prefix: "E6",  color: "black" },
      "Classical Variation":     { eco: "E91", prefix: "E91", color: "black" },
      "Sämisch":                 { eco: "E80", prefix: "E8",  color: "black" },
      "Four Pawns Attack":       { eco: "E76", prefix: "E76", color: "black" },
      "Averbakh":                { eco: "E73", prefix: "E73", color: "black" },
    },
    "Nimzo-Indian": {
      "Nimzo-Indian (General)":  { eco: "E20", prefix: "E2",  color: "black" },
      "Classical":               { eco: "E32", prefix: "E32", color: "black" },
      "Rubinstein":              { eco: "E40", prefix: "E4",  color: "black" },
    },
    "Queen's Indian": {
      "Queen's Indian (General)":{ eco: "E12", prefix: "E12", color: "black" },
      "Petrosian System":        { eco: "E12", prefix: "E12", color: "black" },
    },
    "Grünfeld Defense": {
      "Grünfeld (General)":      { eco: "D80", prefix: "D8",  color: "black" },
      "Exchange Variation":      { eco: "D85", prefix: "D85", color: "black" },
      "Russian System":          { eco: "D97", prefix: "D97", color: "black" },
    },
    "Benoni": {
      "Modern Benoni":           { eco: "A60", prefix: "A6",  color: "black" },
      "Old Benoni":              { eco: "A43", prefix: "A43", color: "black" },
    },
    "Dutch Defense": {
      "Dutch (General)":         { eco: "A80", prefix: "A8",  color: "black" },
      "Leningrad Dutch":         { eco: "A87", prefix: "A87", color: "black" },
      "Stonewall Dutch":         { eco: "A90", prefix: "A9",  color: "black" },
    },
    "London System": {
      "London System":           { eco: "D02", prefix: "D02", color: "white" },
    },
    "Torre / Colle": {
      "Torre Attack":            { eco: "D03", prefix: "D03", color: "white" },
      "Colle System":            { eco: "D04", prefix: "D04", color: "white" },
    },
  },
  "Other First Moves": {
    "English Opening": {
      "English (General)":       { eco: "A10", prefix: "A1",  color: "white" },
      "Symmetrical":             { eco: "A30", prefix: "A3",  color: "white" },
      "Reversed Sicilian":       { eco: "A20", prefix: "A2",  color: "white" },
    },
    "Réti / KIA": {
      "Réti Opening":            { eco: "A04", prefix: "A04", color: "white" },
      "King's Indian Attack":    { eco: "A07", prefix: "A07", color: "white" },
    },
    "Bird's Opening": {
      "Bird's Opening":          { eco: "A02", prefix: "A02", color: "white" },
    },
    "Larsen's Opening": {
      "Larsen's (1.b3)":         { eco: "A01", prefix: "A01", color: "white" },
    },
  },
};

// Flat lookup by display name for save/load and loyalty matching
const ECO_PRESETS = (() => {
  const flat = {};
  for (const family of Object.values(ECO_LIBRARY)) {
    for (const variations of Object.values(family)) {
      for (const [name, data] of Object.entries(variations)) {
        flat[name] = data;
      }
    }
  }
  return flat;
})();

// Fetch from opening explorer.
// Tries the masters DB via our server-side proxy first (no CORS issues),
// falls back to the Lichess games DB if masters returns no moves.
// Returns { moves: [{uci, white, draws, black}], opening: {eco, name} } or null.
async function openingExplorerFetch(moveHistory) {
  const cacheKey = moveHistory.join(',');
  if (_openingCache.has(cacheKey)) return _openingCache.get(cacheKey);

  async function fetchMasters() {
    const play = moveHistory.join(',');
    const url = '/api/masters?play=' + encodeURIComponent(play) + '&moves=10';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('masters proxy ' + resp.status);
    return resp.json();
  }

  async function fetchLichess() {
    const play = moveHistory.join(',');
    const url = 'https://explorer.lichess.ovh/lichess' +
                '?play=' + encodeURIComponent(play) +
                '&speeds=blitz,rapid,classical&ratings=1200,1400,1600,1800&moves=10&topGames=0';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('lichess explorer ' + resp.status);
    return resp.json();
  }

  try {
    // Try masters first; fall back to lichess if empty or error
    let data = null;
    try {
      data = await fetchMasters();
    } catch(e) {
      console.warn('Masters proxy unavailable, falling back to Lichess DB:', e.message);
    }
    if (!data || !data.moves || !data.moves.length) {
      data = await fetchLichess();
    }
    if (!data || !data.moves || !data.moves.length) {
      _openingCache.set(cacheKey, null);
      return null;
    }
    data.moves.sort((a, b) =>
      (b.white + b.draws + b.black) - (a.white + a.draws + a.black)
    );
    _openingCache.set(cacheKey, data);
    return data;
  } catch(e) {
    console.warn('Opening explorer fetch failed:', e);
    _openingCache.set(cacheKey, null);
    return null;
  }
}

// Main opening book entry point — called at the top of botMakeMove().
// Returns a UCI string if the book has a move, or null to fall through to engine.
async function botGetOpeningMove(moveHistory) {
  const maxDepth = botOpeningConfig.maxBookDepth || 20;
  if (botOpeningMode === 'none') return null;
  if (moveHistory.length >= maxDepth) return null;

  const data = await openingExplorerFetch(moveHistory);
  if (!data || !data.moves || !data.moves.length) return null;

  // ── Mainline: always play moves[0] (highest game count) ──────────────
  if (botOpeningMode === 'mainline') {
    return data.moves[0].uci;
  }

  // ── Preferred: unified loyalty + repertoire mode ──────────────────────────
  // botPlayerColor is the HUMAN's color, so the bot's color is the opposite.
  // ECO matching: we check EACH candidate move's resulting ECO (via its UCI
  // prefix) against the slot prefixes — not the current position ECO — because
  // the opening name only appears in the resulting position after the move.
  // This is what allows Black to correctly steer toward the Sicilian on move 1:
  // e4 is the current position (B00), but the move c7c5 produces a B2x ECO.
  if (botOpeningMode === 'preferred') {
    // Bot is the opposite color from the human player
    const botColor = botPlayerColor === 'white' ? 'black' : 'white';
    const slots = (botOpeningConfig[botColor] || []).filter(s => s.familyPrefix || s.eco);

    // No slots configured — fall through (engine will play)
    if (!slots.length) return null;

    // currentEco = the opening name of the CURRENT position (before bot's move)
    const currentEco = (data.opening && data.opening.eco) || '';

    // Helper: best match tier for a given ECO string against our slot list
    // Returns: 2 = exact match, 1 = family match, 0 = no match
    function matchTier(ecoStr) {
      let best = 0;
      for (const slot of slots) {
        const exact  = slot.exactEco     || null;
        const family = slot.familyPrefix || (slot.eco ? slot.eco.slice(0,2) : null);
        if (exact  && ecoStr.startsWith(exact))  { best = Math.max(best, 2); }
        if (family && ecoStr.startsWith(family)) { best = Math.max(best, 1); }
      }
      return best;
    }

    // Score a candidate move. We use the CURRENT position ECO because we don't
    // know the resulting ECO per-move from the explorer API. However: in early
    // moves (depth < 3) the position ECO may not yet reflect the opening, so we
    // also give credit to moves that match our preferred family by their UCI move
    // string heuristic (e.g. c7c5 is always the Sicilian regardless of ECO label).
    const EARLY_MOVE_DEPTH = maxDepth; // always use ECO-line scanning (position-ECO prefix only covers B20-B29 for Sicilian, missing B30-B99)
    const isEarly = moveHistory.length < EARLY_MOVE_DEPTH;
    const currentTier = matchTier(currentEco);

    // Preferred family prefixes for early-move heuristic
    const prefFamilies = slots.map(s => s.familyPrefix || (s.eco ? s.eco.slice(0,2) : '')).filter(Boolean);

    // ── Early moves: use ECO PGN sequences to find preferred next moves ─────
    // botSanHistory tracks SAN moves played so far this game.
    // We scan _ecoData for lines matching the moves played so far AND a preferred
    // slot ECO, then extract what move comes next in those lines.
    if (isEarly && _ecoData) {
      const preferredUci = obPreferredNextMoves(
        botSanHistory, slots, board, turn, epSq, castling
      );

      if (preferredUci.size) {
        // Score candidates: preferred moves get a strong bonus, others get frequency only
        const total = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0) || 1;
        let bestMove = null, bestScore = -1;
        for (const m of data.moves) {
          const freq = (m.white + m.draws + m.black) / total;
          const prefScore = preferredUci.has(m.uci)
            ? (preferredUci[m.uci] || 1.0)  // slot-weighted score piggy-backed on Set
            : 0;
          // Strong preference signal: preferred moves score 10× their frequency bonus
          const score = prefScore > 0 ? freq * (1 + prefScore * 10) : freq * 0.1;
          if (score > bestScore) { bestScore = score; bestMove = m.uci; }
        }
        if (bestMove) return bestMove;
      }
      // No preferred move found in ECO lines — fall through to frequency
      return data.moves[0].uci;
    }

    // ── Established position: score by slot match against current ECO ─────────
    function positionSlotScore() {
      if (currentTier === 0) return 0.05;
      const totalPct = slots.reduce((s2, sl) => s2 + (sl.weight || 0), 0) || 1;
      const EXACT_BONUS = 3.0;
      let best = 0.05;
      for (const slot of slots) {
        const exact  = slot.exactEco     || null;
        const family = slot.familyPrefix || (slot.eco ? slot.eco.slice(0,2) : null);
        let tier = 0;
        if (exact  && currentEco.startsWith(exact))  tier = 2;
        else if (family && currentEco.startsWith(family)) tier = 1;
        if (tier > 0) {
          const normW = (slot.weight || 0) / totalPct;
          const sc = (tier === 2 ? EXACT_BONUS : 1.0) * normW;
          if (sc > best) best = sc;
        }
      }
      return best;
    }

    const pw = positionSlotScore();
    const total = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0) || 1;
    const strictness = botOpeningConfig.strictness !== undefined
                       ? botOpeningConfig.strictness : 0.8;

    // Single slot — loyalty: if established and off-book, apply deviation response
    if (slots.length === 1 && currentTier === 0) {
      return botOpeningConfig.deviationResponse === 'mainline'
        ? data.moves[0].uci : null;
    }

    let bestMove = null, bestScore = -1;
    for (const m of data.moves) {
      const freq  = (m.white + m.draws + m.black) / total;
      const score = (1 - strictness) * freq + strictness * pw * freq;
      if (score > bestScore) { bestScore = score; bestMove = m.uci; }
    }
    return bestMove;
  }

  return null;
}

// Update botStatus while in opening
function botOpeningStatusText(data) {
  if (!data || !data.opening) return '📖 Book';
  return '📖 Book: ' + data.opening.name + ' (' + data.opening.eco + ') — move ' + (botMoveHistory.length + 1);
}

// ── Temperature sampling ─────────────────────────────────────────────────────
// ── Time pressure curve evaluator ────────────────────────────────────────────
// ctrlPts: [{x,y}] where x = think-time per move (s), y = ELO or confidence %.
// Interpolates linearly in log-x space (matching the panel's log-time axis).
// Returns null if ctrlPts is empty or has fewer than 2 points.

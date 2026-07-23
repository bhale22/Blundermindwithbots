// ── bot-engine.js ─────────────────────────────────────────────────────────────
// Two-stage move selection pipeline, personality attractor system,
// and unified time-pressure ELO reduction.
//
// Depends on chess-core.js (legalMovesFor, allLegalMoves, applyMove,
//   boardToFen, sqToUci, uciToSq, inCheck, computeMaterial, PIECE_VAL)
// Depends on globals: board, turn, castling, epSq, botActive, botPlayerColor,
//   botMoveHistory, botSanHistory, botStartClockMs, botOppClockMs,
//   clockControl, clockTimeW, clockTimeB, sfWorker, sfReady, _maiaWorker,
//   _maiaReady, _maia3MoveIndex, _maia3MoveReversed, _maiaLegalMask,
//   _maiaProcess, _maiaEncode, executeMove, render, updatePlayerBoxes
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONALITY ATTRACTOR SYSTEM
// Each attractor runs -5 to +5 with 0 = neutral.
// ═══════════════════════════════════════════════════════════════════════════════

const BotPersonality = {
  // Default — all attractors at neutral
  defaults: {
    chaos:          0,   // -5=Simplifier  ↔ +5=Chaos Agent
    complicateWin:  0,   // -5=Simplify when winning  ↔ +5=Complicate when winning
    pawnPush:       0,   // -5=Pawn avoider  ↔ +5=Pawn pusher
    tradeSeek:      0,   // -5=Trade avoider  ↔ +5=Trade seeker
    pawnStructure:  0,   // -5=Loose pawn structure  ↔ +5=Rigid pawn structure
    hustler:        0,   // -5=Coffeehouse hustler  ↔ +5=Grinder
    goodDay:        0,   // -5=Bad day  ↔ +5=Good day (threshold for move selection)
    calm:           0,   // -5=Panicky  ↔ +5=Calm under pressure
  },

  // Piece-level attractors: -5 (avoid/sac) to +5 (move/protect)
  pieceDefaults: {
    P: { move: 0, sac: 0 },
    N: { move: 0, sac: 0 },
    B: { move: 0, sac: 0 },
    R: { move: 0, sac: 0 },
    Q: { move: 0, sac: 0 },
    K: { move: 0, sac: 0 },
  },

  // Preset personality catalog — slider positions and impulsivity for each named bot
  presets: {
    'Captain Entropy':    { chaos:5, complicateWin:4, impulsivity:80 },
    'Norm':               { chaos:-5, complicateWin:-4, impulsivity:60 },
    'Attacky McTackerson':{ tradeSeek:5, impulsivity:100, pieceP:{N:{sac:3},B:{sac:3}} },
    'Overendower':        { tradeSeek:-5, impulsivity:50 },
    'Pawn Pusher':        { pawnPush:5, impulsivity:70 },
    'Grandmaster Bad Day':{ goodDay:-5, impulsivity:20 },
    'Coffeehouse Hustler':{ hustler:-5, chaos:3, impulsivity:120 },
    'Tilt Mode':          { _tiltMode:true, impulsivity:150 },
    'Spite Check':        { _spiteCheck:true, impulsivity:100 },
    'Space Cadet':        { _spaceControl:true, impulsivity:80 },
    'Fort Knox':          { _minExposure:true, impulsivity:40 },
    'Groomer':            { _groomer:true, impulsivity:60 },
    'Pawn Chain Gang':    { pawnStructure:5, pawnPush:3, impulsivity:70 },
    'Passer Chaser':      { pawnPush:4, impulsivity:80 },
    'Wrecker':            { pawnStructure:-5, impulsivity:90 },
    'The Hoarder':        { tradeSeek:-5, pieceP:{Q:{sac:-5},R:{sac:-4},N:{sac:-3},B:{sac:-3}}, impulsivity:30 },
    'Gambito':            { tradeSeek:5, impulsivity:200 },
    'Clock Watcher':      { calm:3, _clockWatcher:true, impulsivity:60 },
    'King March':         { pieceP:{K:{move:5}}, impulsivity:150 },
    'Time Weaponizer':    { _timeWeaponizer:true, calm:-3, impulsivity:80 },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-PRESSURE ELO REDUCTION
// Unified sigmoid curve used for both defensive (own clock) and
// offensive (Time Weaponizer) modes.
// ═══════════════════════════════════════════════════════════════════════════════

// Sigmoid-based ELO reduction.
// pressure: 0 = no pressure, 1 = maximum pressure
// calmLevel: -5 to +5. +5 = calm (minimal drop), -5 = panicky (sharp drop)
// maxDrop: maximum ELO reduction at full pressure
function eloDropSigmoid(pressure, calmLevel, maxDrop) {
  if (pressure <= 0) return 0;
  // k controls steepness: panicky bots drop faster
  const k = 8 + (calmLevel * -1.2); // k=8 at calm=0, higher for panicky
  // Sigmoid shifted so degradation starts after ~40% pressure
  const raw = 1 / (1 + Math.exp(-k * (pressure - 0.45)));
  // Normalize so output=0 at pressure=0 and output≈1 at pressure=1
  const baseline = 1 / (1 + Math.exp(-k * (0 - 0.45)));
  const normalized = (raw - baseline) / (1 - baseline);
  return Math.round(normalized * maxDrop);
}

// Compute effective Maia3 ELO given time pressure.
// baseElo: configured starting ELO
// personality: attractor object with calm (-5..+5)
// clockState: { botRemainingMs, startMs, increment, estimatedMovesLeft }
function computeEffectiveElo(baseElo, personality, clockState) {
  const { botRemainingMs, startMs, increment, estimatedMovesLeft } = clockState;
  if (!botRemainingMs || !startMs) return baseElo;

  // Effective remaining = clock + increments for remaining moves
  const effectiveRemaining = botRemainingMs + (increment || 0) * (estimatedMovesLeft || 20) * 1000;
  const effectiveStart = startMs + (increment || 0) * 40 * 1000; // est. 40 moves total
  const pressure = 1 - Math.min(1, effectiveRemaining / effectiveStart);

  const calmLevel = (personality && personality.calm) || 0;
  const maxDrop = 300 + (calmLevel * -30); // panicky bots can drop up to 450 ELO, calm ones 150
  const drop = eloDropSigmoid(pressure, calmLevel, maxDrop);

  return Math.max(600, Math.min(2600, baseElo - drop));
}

// ── Time Weaponizer ELO reduction (offensive mode) ───────────────────────────
// Activates when bot has clock advantage over opponent.
// threshold: ratio of bot_remaining/opp_remaining that triggers offensive mode (default 1.5)
function computeWeaponizerElo(baseElo, personality, clockState) {
  const { botRemainingMs, oppRemainingMs, positionCp } = clockState;
  if (!botRemainingMs || !oppRemainingMs) return { elo: baseElo, active: false };

  const settings = (personality && personality._timeWeaponizerSettings) || {};
  const threshold = settings.threshold || 1.5;
  const posGate   = settings.posGate !== undefined ? settings.posGate : -150; // don't weaponize when losing by >150cp

  // Gate: don't activate if we're losing
  if (positionCp !== undefined && positionCp < posGate) return { elo: baseElo, active: false };

  const ratio = botRemainingMs / Math.max(1, oppRemainingMs);
  if (ratio < threshold) return { elo: baseElo, active: false };

  // Map ratio → pressure (0 at threshold, 1 at 3x threshold)
  const pressure = Math.min(1, (ratio - threshold) / (3 * threshold - threshold));
  const drop = eloDropSigmoid(pressure, -3, 400); // always "panicky" in offensive mode

  return { elo: Math.max(600, baseElo - drop), active: true, pressure };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOVE SCORING — Personality attractors applied to candidate moves
// ═══════════════════════════════════════════════════════════════════════════════

// Score a candidate move against the personality attractors.
// Returns a score (higher = more personality-preferred).
// bd: board before the move, color: side to move ('w'|'b')
function scoreMove(uci, probability, bd, color, ep, cst, personality, positionCp) {
  const move = uciToSq(uci);
  if (!move) return probability;

  const { from, to, promo } = move;
  const piece = bd[from];
  if (!piece) return probability;

  const opp = color === 'w' ? 'b' : 'w';
  const bd2 = applyMove(from, to, bd, ep, promo || 'Q');
  let score = probability; // base: Maia probability

  const p = personality || {};
  const pieceAttr = (p.pieceAttractors || {})[piece.piece] || { move: 0, sac: 0 };
  const isCapture = !!bd[to] || (piece.piece === 'P' && (to % 8) !== (from % 8));
  const isPawnMove = piece.piece === 'P';

  // ── Piece movement preference ─────────────────────────────────────────────
  if (pieceAttr.move !== 0) score += pieceAttr.move * 0.015;

  // ── Pawn push attractor ───────────────────────────────────────────────────
  if (isPawnMove && p.pawnPush) score += p.pawnPush * 0.012;

  // ── Trade seeker / avoider ────────────────────────────────────────────────
  if (isCapture && p.tradeSeek) score += p.tradeSeek * 0.01;

  // ── Chaos attractor — prefer moves that maximize opponent legal moves ─────
  if (p.chaos) {
    const oppMoves = allLegalMoves(bd2, opp, computeEP(from, to, bd), cst).length;
    const normalizedComplexity = Math.min(1, oppMoves / 30);
    score += p.chaos * normalizedComplexity * 0.02;
  }

  // ── Good day / Bad day — shifts the probability threshold ─────────────────
  // goodDay +5 = always picks highest probability move (conservative)
  // goodDay -5 = picks lower probability moves (creative/bad)
  if (p.goodDay !== undefined && p.goodDay !== 0) {
    // Boost low-prob moves on bad day, boost high-prob moves on good day
    const probRank = probability; // will be used relative to top move
    score += p.goodDay * probRank * 0.01;
  }

  // ── Piece safety preference ───────────────────────────────────────────────
  // sac > 0 = willing to sacrifice; sac < 0 = protective
  if (isCapture && pieceAttr.sac) {
    const seeScore = seeLandingScore(to, piece.piece, color, bd);
    if (seeScore < 0 && pieceAttr.sac < 0) score -= Math.abs(pieceAttr.sac) * 0.02; // avoid bad captures
    if (seeScore > 0 && pieceAttr.sac > 0) score += pieceAttr.sac * 0.02; // bonus for winning captures
  }

  // ── Spite check ──────────────────────────────────────────────────────────
  if (p._spiteCheck && inCheck(bd2, opp)) score += 0.3;

  // ── King March: bonus for king advancing ─────────────────────────────────
  if (p.pieceAttractors && p.pieceAttractors.K && p.pieceAttractors.K.move > 0 && piece.piece === 'K') {
    const fromRow = Math.floor(from / 8), toRow = Math.floor(to / 8);
    const advancing = color === 'w' ? (toRow < fromRow) : (toRow > fromRow);
    if (advancing) score += p.pieceAttractors.K.move * 0.025;
  }

  // ── Tilt mode: escalate risk after material loss ─────────────────────────
  if (p._tiltMode && positionCp !== undefined && positionCp < -100) {
    // In losing position, prefer chaotic captures
    if (isCapture) score += 0.15;
  }

  return score;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TWO-STAGE PIPELINE
// Stage 1: Maia gives candidate moves with probabilities; filter below minProb
// Stage 2: Score candidates with personality; Stockfish verifies if needed
// ═══════════════════════════════════════════════════════════════════════════════

// Minimum probability a candidate move must have to enter Stage 2.
// Default 5% per the brief.
const DEFAULT_MIN_PROB = 0.05;

// Stage 1: Build candidate pool from Maia move probabilities.
// moveProbs: { uci: probability } from Maia inference
// minProb: filter threshold (default 0.05)
// Returns sorted array of { uci, prob } descending by probability
function stage1Filter(moveProbs, minProb) {
  const thresh = minProb !== undefined ? minProb : DEFAULT_MIN_PROB;
  return Object.entries(moveProbs)
    .filter(([, p]) => p >= thresh)
    .sort((a, b) => b[1] - a[1])
    .map(([uci, prob]) => ({ uci, prob }));
}

// Stage 2: Score candidates against personality, select best.
// candidates: output of stage1Filter
// bd, color, ep, cst: board state
// personality: attractor object
// impulsivityCp: master CP ceiling (how far from engine-best we'll deviate)
// sfGetCpAsync: async function(fen) => centipawn eval of current position
// Returns: { uci, source } where source is 'maia' | 'personality' | 'stockfish-verified'
async function stage2Select(candidates, bd, color, ep, cst, personality, impulsivityCp, sfGetCpAsync) {
  if (!candidates.length) return null;

  const topMaiaMove = candidates[0];

  // If no personality preference (impulsivity=0), play top Maia move immediately
  if (!impulsivityCp || impulsivityCp === 0) {
    return { uci: topMaiaMove.uci, source: 'maia' };
  }

  // Score all candidates
  const fen = boardToFen(bd, color, cst, ep);
  let positionCp = null;
  const scored = candidates.map(({ uci, prob }) => ({
    uci, prob,
    score: scoreMove(uci, prob, bd, color, ep, cst, personality, positionCp)
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];

  // If personality's top pick == Maia's top pick, play immediately (no SF call)
  if (best.uci === topMaiaMove.uci) {
    return { uci: best.uci, source: 'maia' };
  }

  // Check if the score difference is significant (if not, just play top Maia)
  const scoreDiff = best.score - topMaiaMove.score;
  if (scoreDiff < 0.02) {
    return { uci: topMaiaMove.uci, source: 'maia' };
  }

  // Personality move diverges — call Stockfish to verify CP cost is within ceiling
  if (!sfGetCpAsync) {
    // No SF available — play personality move anyway
    return { uci: best.uci, source: 'personality' };
  }

  // Get baseline eval (top Maia move applied)
  const topMove = uciToSq(topMaiaMove.uci);
  const bdAfterTop = topMove ? applyMove(topMove.from, topMove.to, bd, ep, topMove.promo || 'Q') : bd;
  const nextColor = color === 'w' ? 'b' : 'w';
  const fenAfterTop = boardToFen(bdAfterTop, nextColor, cst, computeEP(topMove ? topMove.from : 0, topMove ? topMove.to : 0, bd));
  const cpAfterTop = await sfGetCpAsync(fenAfterTop);

  // Try personality candidates in order until one is within impulsivity ceiling
  for (const candidate of scored) {
    if (candidate.uci === topMaiaMove.uci) {
      return { uci: topMaiaMove.uci, source: 'maia' };
    }
    const mv = uciToSq(candidate.uci);
    if (!mv) continue;
    const bdAfter = applyMove(mv.from, mv.to, bd, ep, mv.promo || 'Q');
    const fenAfter = boardToFen(bdAfter, nextColor, cst, computeEP(mv.from, mv.to, bd));
    const cpAfter = await sfGetCpAsync(fenAfter);

    if (cpAfterTop !== null && cpAfter !== null) {
      const cpLoss = (color === 'w' ? cpAfterTop - cpAfter : cpAfter - cpAfterTop);
      if (cpLoss <= impulsivityCp) {
        return { uci: candidate.uci, source: 'stockfish-verified' };
      }
    } else {
      // Can't verify — play it if it's the personality top pick
      if (candidate.uci === best.uci) {
        return { uci: candidate.uci, source: 'personality' };
      }
    }
  }

  // Nothing within ceiling — fall back to top Maia move
  return { uci: topMaiaMove.uci, source: 'maia-fallback' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THINK TIME
// Entropy-based with time-pressure correction, including increment accounting.
// ═══════════════════════════════════════════════════════════════════════════════

// Estimate remaining moves in the game (simple formula)
function estimateRemainingMoves(moveNumber) {
  return Math.max(10, 40 - Math.floor(moveNumber / 2));
}

// Compute per-move time budget accounting for increment (Dr. Regan's approach).
// clockMs: remaining clock in ms
// startClockMs: starting clock in ms
// incrementMs: increment per move in ms
// moveNumber: current move number (half-moves played)
function computeTimeBudget(clockMs, startClockMs, incrementMs, moveNumber) {
  const incMs = incrementMs || 0;
  const remaining = estimateRemainingMoves(moveNumber);
  // Effective remaining = clock + all future increments
  const effectiveRemaining = clockMs + incMs * remaining;
  const perMove = effectiveRemaining / remaining;
  return { perMove, effectiveRemaining, remaining };
}

// Think time in ms: complexity-scaled, pressure-corrected
function computeThinkTime(moveProbs, clockMs, startClockMs, incrementMs, moveNumber, personality) {
  const budget = computeTimeBudget(clockMs || startClockMs || 300000, startClockMs || 300000, incrementMs || 0, moveNumber || 1);

  // Position complexity from move probability distribution
  let entropy = 2; // default moderate complexity
  if (moveProbs && Object.keys(moveProbs).length) {
    entropy = 0;
    for (const p of Object.values(moveProbs)) { if (p > 0) entropy -= p * Math.log2(p); }
  }
  const complexityFactor = Math.min(2.5, 1 + entropy * 0.35);

  // Base think time = 40% of per-move budget (don't use it all)
  let thinkMs = budget.perMove * 0.4 * complexityFactor;

  // Hustler/Grinder attractor: hustler plays faster
  const hustler = (personality && personality.hustler) || 0;
  if (hustler < 0) thinkMs *= (1 + hustler * 0.1); // hustler speeds up
  if (hustler > 0) thinkMs *= (1 + hustler * 0.08); // grinder slows down

  // Randomize ±20%
  thinkMs *= 0.8 + Math.random() * 0.4;

  // Hard floor/ceiling
  return Math.max(150, Math.min(8000, thinkMs));
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORING (for Captain Entropy / Norm / Time Weaponizer)
// Local computation only — no engine calls.
// ═══════════════════════════════════════════════════════════════════════════════

// Count legal moves available to a side (proxy for position complexity)
function legalMoveCount(bd, color, ep, cst) {
  return allLegalMoves(bd, color, ep, cst).length;
}

// Number of hanging pieces (undefended and attacked)
function hangingPieceCount(bd, color, atkMap) {
  if (!atkMap) return 0;
  let count = 0;
  for (let s = 0; s < 64; s++) {
    const p = bd[s];
    if (!p || p.piece === 'K') continue;
    const opp = p.color === 'w' ? 'b' : 'w';
    const defended = atkMap[s] && atkMap[s][p.color] && atkMap[s][p.color].length > 0;
    const attacked  = atkMap[s] && atkMap[s][opp]    && atkMap[s][opp].length > 0;
    if (attacked && !defended) count++;
  }
  return count;
}

// Complexity delta: how many more legal moves does the opponent get after this move?
function complexityDelta(uci, bd, color, ep, cst) {
  const mv = uciToSq(uci);
  if (!mv) return 0;
  const opp = color === 'w' ? 'b' : 'w';
  const before = legalMoveCount(bd, opp, ep, cst);
  const bd2 = applyMove(mv.from, mv.to, bd, ep, mv.promo || 'Q');
  const newEp = computeEP(mv.from, mv.to, bd);
  const after = legalMoveCount(bd2, opp, newEp, cst);
  return after - before;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT CONFIG STATE
// Current active personality and engine settings.
// ═══════════════════════════════════════════════════════════════════════════════

var _activeBotConfig = {
  name:         'Custom',
  engine:       'maia3',     // 'maia3' | 'stockfish' | 'hybrid' | 'lcsf'
  eloBase:      1500,
  impulsivity:  50,           // CP ceiling
  minProb:      0.05,
  temperature:  1.0,
  attractors: { ...BotPersonality.defaults },
  pieceAttractors: JSON.parse(JSON.stringify(BotPersonality.pieceDefaults)),
  timeControls: {
    eloUnderPressure: true,
    timeWeaponizer:   false,
    weaponizerThreshold: 1.5,
    weaponizerPosGate:  -150,
    weaponizerComplexity: false,
    calm: 0,                 // redundant with attractors.calm — kept for time system
    playSpeedMode: 'scaled', // 'fixed' | 'scaled' | 'clock'
    fixedMs: 2000,
  },
};

// Load a preset bot by name
function botLoadPreset(name) {
  const preset = BotPersonality.presets[name];
  if (!preset) return;
  _activeBotConfig.name = name;
  _activeBotConfig.attractors = { ...BotPersonality.defaults };
  _activeBotConfig.pieceAttractors = JSON.parse(JSON.stringify(BotPersonality.pieceDefaults));
  // Apply preset attractor overrides
  for (const [k, v] of Object.entries(preset)) {
    if (k === 'impulsivity') { _activeBotConfig.impulsivity = v; continue; }
    if (k === 'pieceP') {
      for (const [pc, pv] of Object.entries(v)) {
        _activeBotConfig.pieceAttractors[pc] = { ..._activeBotConfig.pieceAttractors[pc], ...pv };
      }
      continue;
    }
    if (k.startsWith('_')) {
      _activeBotConfig.attractors[k] = v; continue;
    }
    _activeBotConfig.attractors[k] = v;
  }
}

// Serialize bot config to JSON (for save/load)
function botConfigToJson() {
  return JSON.stringify(_activeBotConfig, null, 2);
}

function botConfigFromJson(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    Object.assign(_activeBotConfig, parsed);
    return true;
  } catch(e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RADAR CHART DATA
// Maps attractor values to a normalized polygon for the personality fingerprint.
// ═══════════════════════════════════════════════════════════════════════════════

// Returns array of { axis, value (0-1) } for radar chart rendering
function botRadarData(attractors) {
  const axes = [
    { key:'chaos',         label:'Chaos' },
    { key:'pawnPush',      label:'Pawns' },
    { key:'tradeSeek',     label:'Trades' },
    { key:'hustler',       label:'Hustle' },
    { key:'goodDay',       label:'Day' },
    { key:'calm',          label:'Calm' },
    { key:'complicateWin', label:'Complicate' },
    { key:'pawnStructure', label:'Structure' },
  ];
  return axes.map(({ key, label }) => ({
    axis: label,
    value: ((attractors[key] || 0) + 5) / 10, // normalize -5..+5 to 0..1
  }));
}

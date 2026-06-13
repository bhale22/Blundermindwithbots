function evalPressureCurve(ctrlPts, xSec) {
  if (!ctrlPts || ctrlPts.length < 2) return null;
  // Clamp x ≥ 0.01: log-space interpolation below needs x > 0, and a loaded
  // config file could contain bad points even though the panel can't make them.
  const pts = ctrlPts.map(p => ({ x: Math.max(0.01, +p.x || 0.01), y: +p.y }))
    .sort((a, b) => a.x - b.x);
  xSec = Math.max(0.01, xSec);
  if (xSec <= pts[0].x) return pts[0].y;
  if (xSec >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    if (xSec >= pts[i].x && xSec <= pts[i + 1].x) {
      // Interpolate in log-x space (matches the panel's log-time axis)
      const t = (Math.log(xSec) - Math.log(pts[i].x)) /
                (Math.log(pts[i + 1].x) - Math.log(pts[i].x));
      return pts[i].y + t * (pts[i + 1].y - pts[i].y);
    }
  }
  return pts[pts.length - 1].y;
}

// ── Pressure-adjusted Maia ELO ────────────────────────────────────────────────
// Reads ctrlA curve and returns the effective Maia ELO for the current clock.
// Falls back to maia3SelectedRating when no curve is set or clockMs is null.
function pressureEffectiveMaiaElo(clockMs) {
  if (!botPressureCurveA || botPressureCurveA.length < 2 || clockMs === null) return maia3SelectedRating;
  const thinkSec = (clockMs / 1000) / botRemainingMovesEstimate();
  const curveElo = evalPressureCurve(botPressureCurveA, thinkSec);
  if (curveElo === null) return maia3SelectedRating;
  return Math.max(600, Math.min(2600, Math.round(curveElo)));
}

// ── Pressure-adjusted distribution upper cutoff ───────────────────────────────
// Reads ctrlB curve; returns effective day-upper % for the current clock.
// Falls back to botDayUpper when no curve is set or clockMs is null.
function pressureEffectiveDayUpper(clockMs) {
  if (!botPressureCurveB || botPressureCurveB.length < 2 || clockMs === null) return botDayUpper;
  const thinkSec = (clockMs / 1000) / botRemainingMovesEstimate();
  const curvePct = evalPressureCurve(botPressureCurveB, thinkSec);
  if (curvePct === null) return botDayUpper;
  return Math.max(0, Math.min(botDayUpper, curvePct));
}

// ── Pressure functions keyed on actual think time (seconds) ──────────────────
// These replace the clock-based variants in the move generation path so that
// the degradation curves respond to how long the bot *actually* thinks, not to
// a clock/remaining-moves average.  A hustler taking 0.3 s sees heavy curve
// degradation; a grinder taking 15 s sees little.
function pressureEffectiveMaiaEloByThink(thinkSec) {
  if (!botPressureCurveA || botPressureCurveA.length < 2) return maia3SelectedRating;
  const curveElo = evalPressureCurve(botPressureCurveA, thinkSec);
  if (curveElo === null) return maia3SelectedRating;
  return Math.max(600, Math.min(2600, Math.round(curveElo)));
}

function pressureEffectiveDayUpperByThink(thinkSec) {
  if (!botPressureCurveB || botPressureCurveB.length < 2) return botDayUpper;
  const curvePct = evalPressureCurve(botPressureCurveB, thinkSec);
  if (curvePct === null) return botDayUpper;
  return Math.max(0, Math.min(botDayUpper, curvePct));
}

function timePressureTempByThink(baseTemp, thinkSec) {
  const boost = { steady: 0.0, normal: 1.0, panicky: 2.5 }[botTimePressure] || 0;
  if (boost === 0) return baseTemp;
  if (botPressureCurveB && botPressureCurveB.length >= 2) {
    const distPct = evalPressureCurve(botPressureCurveB, thinkSec);
    if (distPct !== null) {
      const fraction = Math.max(0, Math.min(1, 1 - distPct / 100));
      return baseTemp + fraction * boost;
    }
  }
  // Linear fallback: full boost at 0 s, zero boost at 30 s
  const fraction = Math.max(0, 1 - thinkSec / 30);
  return baseTemp + fraction * boost;
}

// clock ms at the time of the current move — set before applyMoveAttractors
let _botMoveClockMs = null;
// actual think time in seconds for this move — drives pressure curve lookup
let _botMoveThinkSec = null;

// ── Estimated remaining moves (Fischer formula ≈ 40 per game) ────────────────
function botRemainingMovesEstimate() {
  return Math.max(5, 40 - Math.floor(botMoveHistory.length / 2));
}

// ── Move attractor filtering — applied before sampleFromProbs ─────────────────
// Implements: move quality range (percentile band), luck attractor (band shift),
// piece attractors (×6), pawn strategic, trade, spacecadet, fortkx, gambito,
// structure (pawn islands/doubled/isolated delta).
//
// CP budget integration:
//   The style-gauge CP budget (0–300) controls attractor MAGNITUDE, exactly
//   mirroring the panel's own display formula:
//     alloc_cp(v) = round(budget × |v| / Σ|all v|)
//     logBoost    = v × (budget / (totalAbs × CP_PER_LOG_UNIT))
//   where CP_PER_LOG_UNIT = 150 → 150 cp of budget on one attractor ≈ exp(1) ≈ 2.7× boost.
//   At budget = 0, all attractor effects are zero regardless of slider positions.
//
// Board piece format: board[sq] = {piece:'P'|'N'|..., color:'w'|'b'} or undefined.
// atkMap[sq] = {w:[attacker-sqs], b:[attacker-sqs]} — global, pre-computed for current board.
//
// Sign convention (matches UI labels):
//   Sliders go left (negative) → right (positive).
//   Left label = negative value = that behaviour boosted when value < 0.
//   Trade seeker is on the LEFT (negative) → captures boosted by -tradeVal * scale.
//   All other attractors: positive value → boost the right-label behaviour.
function applyMoveAttractors(moveProbs) {
  if (!moveProbs || !Object.keys(moveProbs).length) return moveProbs;

  const attrVals  = window._bcpAttractorValues || {};
  const pieceVals = window._bcpPieceValues     || {};
  const cpBudget  = window._bcpCpBudget != null ? window._bcpCpBudget : 100;

  const luckVal       = attrVals['luck']       || 0;
  const tradeVal      = attrVals['trade']      || 0;
  const pawnStrat     = attrVals['pawn']       || 0;
  const spaceCadetVal = attrVals['spacecadet'] || 0;
  const fortKxVal     = attrVals['fortkx']     || 0;
  const gambitoVal    = attrVals['gambito']    || 0;
  const attackerVal   = attrVals['attacker']   || 0;
  const structureVal  = attrVals['structure']  || 0;
  const hasPiece   = Object.values(pieceVals).some(v => v !== 0);
  const hasTrade   = tradeVal      !== 0;
  const hasPawnS   = pawnStrat     !== 0;
  const hasSpace   = spaceCadetVal !== 0;
  const hasFortkx  = fortKxVal     !== 0;
  const hasGambito = gambitoVal    !== 0;
  const hasAttacker = attackerVal  !== 0;
  const hasStructure = structureVal !== 0;

  // ── Min-probability + blunder-limit filter (Maia3 / LC modes) ────────────
  if (botMinProbPct > 0 || botBlunderLimitCp < 400) {
    const entries  = Object.entries(moveProbs).sort((a, b) => b[1] - a[1]);
    const bestProb = entries.length ? entries[0][1] : 0;
    if (bestProb > 0) {
      const absFloor  = botMinProbPct / 100;
      const relFloor  = bestProb * Math.exp(-botBlunderLimitCp / 100);
      const threshold = Math.max(absFloor, relFloor);
      const passed    = entries.filter(([, p]) => p >= threshold);
      moveProbs = Object.fromEntries(passed.length ? passed : [entries[0]]);
    }
  }

  // ── CP budget → per-unit scale ────────────────────────────────────────────
  // Attractors without per-move logic (luck, hustle, pressure) still count
  // toward totalAbs so the panel's cp allocation display stays accurate.
  const CP_PER_LOG_UNIT = 150;
  const allVals  = [...Object.values(attrVals), ...Object.values(pieceVals)];
  const totalAbs = allVals.reduce((s, v) => s + Math.abs(v || 0), 0);
  const scale = (cpBudget > 0 && totalAbs > 0)
    ? cpBudget / (totalAbs * CP_PER_LOG_UNIT)
    : 0;

  // ── Quality range + luck shift ────────────────────────────────────────────
  // Use actual think time for pressure if available; fall back to clock-based estimate.
  const _pressureUpper = _botMoveThinkSec !== null
    ? pressureEffectiveDayUpperByThink(_botMoveThinkSec)
    : pressureEffectiveDayUpper(_botMoveClockMs);
  let lo = Math.max(0, Math.min(95, botDayLower - luckVal * 4));
  let hi = Math.max(lo + 5, Math.min(100, _pressureUpper - luckVal * 4));
  let filtered = moveProbs;
  if (lo > 0 || hi < 100) {
    const sorted = Object.entries(moveProbs).sort((a, b) => b[1] - a[1]);
    const total  = sorted.reduce((s, [, p]) => s + p, 0);
    if (total > 0) {
      const band = { lo: (lo / 100) * total, hi: (hi / 100) * total };
      let cum = 0, band_probs = {};
      for (const [m, p] of sorted) {
        const end = cum + p;
        if (end > band.lo && cum < band.hi) band_probs[m] = p;
        cum = end;
      }
      if (Object.keys(band_probs).length) filtered = band_probs;
    }
  }

  // ── Per-move reweighting ──────────────────────────────────────────────────
  const needsPerMove = scale > 0 &&
    (hasPiece || hasTrade || hasPawnS || hasSpace || hasFortkx || hasGambito || hasAttacker || hasStructure);
  if (!needsPerMove) return filtered;

  const PIECE_MAP   = { p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king' };
  const botIsBlack  = (botPlayerColor === 'white'); // bot is black when human plays white
  const botColorStr = botIsBlack ? 'b' : 'w';
  const oppColorStr = botIsBlack ? 'w' : 'b';
  // Opening phase check: gambits and space control matter most early
  const isOpeningPhase = gameMovesAlgebraic.length < 20; // first 10 full moves
  // Shared empty Set for buildDirectAtk — pin-free is fine for a heuristic
  const _EMPTY = new Set();

  // ── Fort Knox: baseline defender count from current atkMap ───────────────
  // atkMap[sq].w / .b = squares of pieces of that color attacking sq.
  // Summing over all bot pieces gives total "protection coverage" before the move.
  let currentTotalDefs = 0;
  if (hasFortkx && atkMap) {
    for (let sq = 0; sq < 64; sq++) {
      if (board[sq] && board[sq].color === botColorStr && atkMap[sq]) {
        currentTotalDefs += (atkMap[sq][botColorStr] || []).length;
      }
    }
  }

  // ── Space Cadet: baseline weak-square count for the bot ─────────────────────
  // Weak square = empty square with zero bot attackers (atkMap[sq][botColorStr].length === 0).
  // Matches the overlay definition so the attractor and the visual are consistent.
  let currentBotWeakCount = 0;
  if (hasSpace && atkMap) {
    for (let sq = 0; sq < 64; sq++) {
      if (!board[sq] && atkMap[sq] && (atkMap[sq][botColorStr] || []).length === 0) {
        currentBotWeakCount++;
      }
    }
  }

  // ── Structure: baseline pawn-structure penalty for the bot's pawns ────────
  // Penalty = islands + doubled + isolated (lower = tighter). Positive slider
  // (Rigid) boosts moves that reduce the penalty; negative (Loose) boosts
  // moves that open the structure. Only own pawn moves can change it, so the
  // per-move check below is gated on pieceLetter === 'p'.
  let currentStructPenalty = 0;
  if (hasStructure) currentStructPenalty = _pawnStructurePenalty(board, botColorStr);

  // ── Gambito: ECO gambit continuation UCIs (computed once per bot turn) ────
  // Scan ECO entries whose name contains 'gambit' and whose move prefix matches
  // the current game history. Collect the "next move" in each matching line.
  // Falls back to structural pawn-sacrifice detection when ECO data isn't loaded.
  let gambitoPreferredUci = null; // Set<uciString> | null (null = ECO unavailable)
  if (hasGambito && isOpeningPhase) {
    if (_ecoData && _ecoData.length) {
      gambitoPreferredUci = new Set();
      const hist      = gameMovesAlgebraic;
      const firstMove = hist.length > 0 ? hist[0] : null;
      const candidates = (_ecoIndex && firstMove)
        ? (_ecoIndex.get(firstMove) || [])
        : _ecoData;
      for (const entry of candidates) {
        if (!entry.name.toLowerCase().includes('gambit')) continue;
        if (entry.sanMoves.length <= hist.length) continue;
        let ok = true;
        for (let i = 0; i < hist.length; i++) {
          if (entry.sanMoves[i] !== hist[i]) { ok = false; break; }
        }
        if (!ok) continue;
        const nextSan = entry.sanMoves[hist.length];
        try {
          const nextMv = algebraicToMove(nextSan, board, turn, epSq, castling);
          if (nextMv) {
            gambitoPreferredUci.add(
              sqToUci(nextMv.from, nextMv.to, nextMv.promo ? nextMv.promo.toLowerCase() : null)
            );
          }
        } catch(e) { /* skip malformed ECO entries */ }
      }
    }
    // If _ecoData is null/empty, gambitoPreferredUci stays null → structural fallback used below
  }

  const result = {};
  for (const [uciMove, prob] of Object.entries(filtered)) {
    const mv = uciToSq(uciMove);
    if (!mv) { result[uciMove] = prob; continue; }

    const fromPiece = board[mv.from]; // {piece:'P'|..., color:'w'|'b'}
    if (!fromPiece) { result[uciMove] = prob; continue; }

    const pieceLetter = fromPiece.piece.toLowerCase(); // 'p','n','b','r','q','k'
    const pieceType   = PIECE_MAP[pieceLetter];

    // ── Lazy simulated board + cached destination-attacks ─────────────────
    // simBd: piece moved from origin to destination (shared by space/fortkx/gambito/trade).
    // simToAtk: rawAttacks from destination square — used by space + trade threat check.
    let _simBd = null, _simToAtk = null;
    const getSimBd = () => {
      if (!_simBd) {
        _simBd = Object.assign({}, board);
        delete _simBd[mv.from];
        _simBd[mv.to] = fromPiece;
      }
      return _simBd;
    };
    const getSimToAtk = () => {
      if (!_simToAtk) _simToAtk = rawAttacks(mv.to, getSimBd());
      return _simToAtk;
    };

    let logBoost = 0;

    // ── Piece attractors ──────────────────────────────────────────────────────
    // Positive value (right) = boost moves by that piece type.
    if (hasPiece && pieceType) logBoost += (pieceVals[pieceType] || 0) * scale;

    // ── Pawn strategic ────────────────────────────────────────────────────────
    // Positive (right, Pawn pusher) boosts pawn advances.
    if (hasPawnS && pieceLetter === 'p') logBoost += pawnStrat * scale;

    // ── Trade: captures + threat creation ────────────────────────────────────
    // Right (positive) = Trade seeker → boosts captures and threats.
    if (hasTrade) {
      const toPiece   = board[mv.to];
      const isCapture = toPiece
        ? toPiece.color === oppColorStr
        : (pieceLetter === 'p' && uciMove[0] !== uciMove[2]); // en passant
      if (isCapture) {
        logBoost += tradeVal * scale;
      } else {
        // Non-capture: score by how many opponent pieces the piece now threatens
        const newThreats = getSimToAtk()
          .filter(sq => { const p = getSimBd()[sq]; return p && p.color === oppColorStr; }).length;
        if (newThreats > 0) logBoost += tradeVal * scale * Math.tanh(newThreats / 2);
      }
    }

    // ── Space Cadet: minimize bot's weak squares ─────────────────────────────
    // Builds a full attack map on the simulated board so discovered attacks and
    // blocking moves are correctly counted. delta > 0 = fewer weak squares = good.
    // tanh(delta/5): reducing weak squares by 5 → 0.76; by 10 → 0.96.
    if (hasSpace) {
      const simBd_   = getSimBd();
      const simAtk   = buildDirectAtk(simBd_, _EMPTY, _EMPTY, _EMPTY, _EMPTY);
      let simBotWeakCount = 0;
      for (let sq = 0; sq < 64; sq++) {
        if (!simBd_[sq] && simAtk[sq] && (simAtk[sq][botColorStr] || []).length === 0) {
          simBotWeakCount++;
        }
      }
      const delta = currentBotWeakCount - simBotWeakCount; // positive = fewer weak squares
      if (delta !== 0) logBoost += spaceCadetVal * scale * Math.tanh(delta / 5);
    }

    // ── Fort Knox: total friendly defender count delta ────────────────────────
    // buildDirectAtk without pins is fast and sufficient for a positional heuristic.
    // tanh((postDefs - preDefs) / 3) maps the delta to a smooth −1..+1 signal.
    if (hasFortkx) {
      const simBd_  = getSimBd();
      const simAtk  = buildDirectAtk(simBd_, _EMPTY, _EMPTY, _EMPTY, _EMPTY);
      let totalDefs = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = simBd_[sq];
        if (p && p.color === botColorStr && simAtk[sq]) {
          totalDefs += (simAtk[sq][botColorStr] || []).length;
        }
      }
      logBoost += fortKxVal * scale * Math.tanh((totalDefs - currentTotalDefs) / 3);
    }

    // ── Gambito: ECO gambit continuation / structural fallback ───────────────
    // Primary: if an ECO gambit line matches, boost/suppress the specific next moves.
    // Fallback (ECO not loaded): boost pawn advances to opponent-attacked, undefended squares.
    if (hasGambito && isOpeningPhase) {
      if (gambitoPreferredUci !== null) {
        // ECO path: only act when the current move is (or isn't) an ECO gambit continuation
        if (gambitoPreferredUci.size > 0 && gambitoPreferredUci.has(uciMove)) {
          logBoost += gambitoVal * scale;
        }
        // If size === 0 the position has left all known gambit lines — no effect
      } else if (pieceLetter === 'p') {
        // Structural fallback when ECO data isn't loaded yet
        const s = getSimBd();
        const attackedByOpp = getSimToAtk().some(sq => { const p = s[sq]; return p && p.color === oppColorStr; });
        const defendedByBot = getSimToAtk().some(sq => { const p = s[sq]; return p && p.color === botColorStr; });
        if (attackedByOpp && !defendedByBot) logBoost += gambitoVal * scale;
      }
    }

    // ── Attacker / Peacemaker: total opponent pieces under threat after move ─────
    // Sums bot-piece attack counts on every opponent piece on the sim board.
    // buildDirectAtk is called lazily — only when this attractor is active.
    if (hasAttacker) {
      const simBd_ = getSimBd();
      const simAtk = buildDirectAtk(simBd_, _EMPTY, _EMPTY, _EMPTY, _EMPTY);
      let totalOppThreats = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = simBd_[sq];
        if (p && p.color === oppColorStr && simAtk[sq]) {
          totalOppThreats += (simAtk[sq][botColorStr] || []).length;
        }
      }
      logBoost += attackerVal * scale * Math.tanh(totalOppThreats / 6);
    }

    // ── Structure: pawn-structure penalty delta (own pawn moves only) ────────
    // delta > 0 = move tightens the structure (fewer islands/doubled/isolated).
    // Positive (Rigid) boosts tightening moves; negative (Loose) boosts
    // structure-opening moves.
    if (hasStructure && pieceLetter === 'p') {
      const simPenalty = _pawnStructurePenalty(getSimBd(), botColorStr);
      const delta = currentStructPenalty - simPenalty;
      if (delta !== 0) logBoost += structureVal * scale * Math.tanh(delta);
    }

    result[uciMove] = logBoost !== 0 ? prob * Math.exp(logBoost) : prob;
  }
  return Object.keys(result).length ? result
       : Object.keys(filtered).length ? filtered
       : moveProbs;
}

// ── Pawn-structure penalty: islands + doubled + isolated (lower = tighter) ──
// Cheap stand-in for the brief's "SF pawn eval delta" — same direction, no
// engine call needed per candidate move.
function _pawnStructurePenalty(bd, colorStr) {
  const files = [0,0,0,0,0,0,0,0];
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (p && p.piece === 'P' && p.color === colorStr) files[sq % 8]++;
  }
  let islands = 0, doubled = 0, isolated = 0, inIsland = false;
  for (let f = 0; f < 8; f++) {
    if (files[f] > 0) {
      if (!inIsland) { islands++; inIsland = true; }
      doubled += files[f] - 1;
      if ((f === 0 || files[f-1] === 0) && (f === 7 || files[f+1] === 0)) isolated += files[f];
    } else {
      inIsland = false;
    }
  }
  return islands + doubled + isolated;
}

function sampleFromProbs(moveProbs, temperature) {
  const entries = Object.entries(moveProbs);
  if (!entries.length) return null;
  const temp = Math.max(0.1, temperature);
  const scaled = entries.map(([m, p]) => [m, Math.pow(p, 1 / temp)]);
  const total = scaled.reduce((s, [, p]) => s + p, 0);
  if (!total) return entries[0][0];
  let r = Math.random() * total;
  for (const [m, p] of scaled) { r -= p; if (r <= 0) return m; }
  return scaled[scaled.length - 1][0];
}

// ── Position entropy (complexity) ────────────────────────────────────────────
function positionEntropy(moveProbs) {
  let e = 0;
  for (const p of Object.values(moveProbs)) {
    if (p > 0) e -= p * Math.log2(p);
  }
  return e;
}

// ── SF level picker — applies temperature weighting around target level ────────
// Vary the Stockfish skill level around the target using the panel's ±1/±2 sliders.
// botSfVar1 = % of calls at ±1 level (split evenly +1/-1), range 0–50.
// botSfVar2 = % of calls at ±2 level (split evenly +2/-2), range 0–20.
// The remaining (100 - var1 - var2)% use the exact target level.
// Falls back to the legacy botSfTempLevel tiers when both sliders are 0.
function sfPickLevel(targetLevel) {
  const var1 = Math.max(0, Math.min(50, botSfVar1)) / 100;
  const var2 = Math.max(0, Math.min(20, botSfVar2)) / 100;

  if (var1 > 0 || var2 > 0) {
    // Slider-driven path: symmetric distribution around target level
    // p(-2)=var2/2, p(-1)=var1/2, p(0)=1-var1-var2, p(+1)=var1/2, p(+2)=var2/2
    const h1 = var1 / 2, h2 = var2 / 2;
    const r  = Math.random();
    const off = r < h2            ? -2
              : r < h2 + h1       ? -1
              : r < 1 - h1 - h2   ?  0
              : r < 1 - h2        ?  1
              :                      2;
    return Math.max(1, Math.min(20, targetLevel + off));
  }

  // Legacy path: use botSfTempLevel tiers (set by old save/load configs)
  if (botSfTempLevel === 0) return targetLevel;
  const tables = [
    null,
    [0.80, 0.90, 1.00,  0,    0  ],  // Focused
    [0.50, 0.70, 0.90, 0.95,  1.0],  // Neutral
    [0.35, 0.57, 0.79, 0.90,  1.0],  // Varied
    [0.20, 0.40, 0.65, 0.83,  1.0],  // Wild
  ];
  const t   = tables[Math.min(4, Math.max(1, botSfTempLevel))];
  const r   = Math.random();
  const off = r < t[0] ?  0
            : r < t[1] ?  1
            : r < t[2] ? -1
            : r < t[3] ?  2
            :            -2;
  return Math.max(1, Math.min(20, targetLevel + off));
}

// ── Effective Stockfish level (degrades under time pressure) ─────────────────
// Priority order for floor calculation:
//   1. blunderLimitCp  → quality guarantee (lower limit = higher floor)
//   2. botTimePressureMaxDrop / sfPressureLevel → time-pressure floor
//   The effective floor is max(blunderFloor, pressureFloor) — most conservative wins.
// Time degradation sources (highest priority first):
//   1. Weaponizer active (ahead on clock) → use floor immediately
//   2. cvA pressure curve → spline interpolation in log-time space
//   3. Linear fallback    → original 0–30 s linear ramp
function sfEffectiveLevel(clockMs) {
  const startLevel = parseInt(document.getElementById('sfLevel').value) || 8;

  // ── Blunder limit floor (quality guarantee) ───────────────────────────────
  // botBlunderLimitCp 50 → floor ≈ startLevel-1; 400 → floor → 1
  const blunderFloor = Math.max(1, Math.round(startLevel * (1 - botBlunderLimitCp / 400)));

  // ── Time-pressure floor (from r-drop or DOM slider) ───────────────────────
  let pressureFloor;
  if (botTimePressureMaxDrop !== null) {
    pressureFloor = Math.max(1, startLevel - Math.round(botTimePressureMaxDrop / 50));
  } else {
    pressureFloor = parseInt(document.getElementById('sfPressureLevel').value) || 4;
  }

  // Effective floor: more conservative (higher) of the two
  const floorLevel = Math.max(blunderFloor, pressureFloor);

  if (clockMs === null) return startLevel;

  // ── Weaponizer: bot is ahead on clock → play at floor for flagging pressure ─
  if (botWeaponizerEnabled && botOppClockMs !== null &&
      (clockMs - botOppClockMs) > botWeaponizerLeadMs) {
    return floorLevel;
  }

  // ── cvA curve: spline-based ELO degradation ───────────────────────────────
  if (botPressureCurveA && botPressureCurveA.length >= 2) {
    const thinkSec = (clockMs / 1000) / botRemainingMovesEstimate();
    const curveElo = evalPressureCurve(botPressureCurveA, thinkSec);
    if (curveElo !== null) {
      const baseElo  = maia3SelectedRating || 1500;
      const maxDrop  = botTimePressureMaxDrop != null ? botTimePressureMaxDrop : 300;
      const floorElo = Math.max(0, baseElo - maxDrop);
      const t = (baseElo - floorElo) > 0
        ? Math.max(0, Math.min(1, (curveElo - floorElo) / (baseElo - floorElo)))
        : 1;
      return Math.max(floorLevel, Math.min(startLevel,
        Math.round(floorLevel + (startLevel - floorLevel) * t)));
    }
  }

  // ── Linear fallback: full strength above 30 s, ramps to floor at 0 s ──────
  if (clockMs > 30000) return startLevel;
  const fraction = clockMs / 30000;
  return Math.round(floorLevel + (startLevel - floorLevel) * fraction);
}

// ── Get current clock remaining for bot's color (returns ms) ─────────────────
function botClockMs() {
  try {
    if (typeof clockTimeW === 'undefined' || clockControl === 'untimed') return null;
    const botColor = botPlayerColor === 'white' ? 'black' : 'white';
    const secs = botColor === 'white' ? clockTimeW : clockTimeB;
    return secs * 1000; // clockTimeW/B are in seconds, convert to ms
  } catch(e) { return null; }
}

// ── Phase 1: Clock fraction & move recording helpers ─────────────────────────

// Returns a 0–1 value: 1.0 = full time remaining, 0.0 = flagging.
// Used by every degradation formula (sigmoid input).
function botFracRemaining() {
  if (!botStartClockMs || botStartClockMs <= 0) return 1;
  const current = botClockMs();
  if (current === null) return 1;
  return Math.max(0, Math.min(1, current / botStartClockMs));
}

// Snapshot opponent clock. Called after each move so diffModifier has fresh data.
// Opponent is whichever color the bot is NOT playing.
function botSnapOppClock() {
  try {
    if (typeof clockTimeW === 'undefined' || clockControl === 'untimed') { botOppClockMs = null; return; }
    const playerIsWhite = botPlayerColor === 'white';
    // Player's clock (not bot's)
    const secs = playerIsWhite ? clockTimeW : clockTimeB;
    botOppClockMs = secs * 1000;
  } catch(e) { botOppClockMs = null; }
}

// Record one move into botMoveHistory (UCI) and botSanHistory (SAN).
// sanMove is optional — pass null if unknown.
function botRecordMove(uciMove, sanMove) {
  if (uciMove && typeof uciMove === 'string' && uciMove.length >= 4) {
    botMoveHistory.push(uciMove);
    // Derive SAN from the board *before* move was applied — already done if sanMove passed.
    // If not passed, try to reconstruct from the move and pre-move board state.
    botSanHistory.push(sanMove || uciMove); // fallback to UCI if SAN unknown
  }
}

// ── Think time: returns target delay in ms ────────────────────────────────────
// Modes (botTimeBehavior):
//   'instant'    — 0 ms
//   'fixed'      — botFixedDelayMs
//   'mirror'     — rolling avg of human times × (1 + botMirrorOffsetPct/100)
//   'complexity' — botCplxBase × lerp(botCplxMin, botCplxMax, entropy/4)
//   'pace'       — original botPace slider entropy calculation
// Human behaviour flags applied to complexity/pace/mirror paths:
//   botBehavBlink       — near-instant for forced moves (entropy < 0.5, Maia3 only)
//   botBehavReconsider  — 15% chance of 1.5-2.5× pause (hesitation)
//   botBehavClockMirror — halve delay when opponent clock < 60% of bot's
//   botCanFlag          — if false, always keep ≥3 s on clock
// Hustle attractor (window._bcpAttractorValues.hustle, −5..+5) scales think time.
// Upper bound on simulated think time, scaled to the time control: 6 s for
// blitz-and-faster, growing to 45 s for long classical. A 6 s ceiling in a
// 90-minute game made every bot feel like a speed player.
function botThinkCapMs() {
  if (!botStartClockMs) return 6000; // untimed / unknown
  return Math.max(6000, Math.min(45000, botStartClockMs * 0.02));
}

function botThinkTime(moveProbs, clockMs) {
  const entropy = moveProbs ? positionEntropy(moveProbs) : 2;

  // ── Instant ──────────────────────────────────────────────────────────────
  if (botTimeBehavior === 'instant') return 0;

  // ── Weaponizer: ahead on clock → play instantly to maximise time pressure ─
  if (botWeaponizerEnabled && botOppClockMs !== null && clockMs !== null &&
      (clockMs - botOppClockMs) > botWeaponizerLeadMs) {
    return 0;
  }

  // ── Move blink: near-instant for forced/obvious positions (Maia3 only) ───
  if (botBehavBlink && moveProbs && entropy < 0.5) {
    return 200 + Math.random() * 300;
  }

  // ── Fixed ────────────────────────────────────────────────────────────────
  if (botTimeBehavior === 'fixed') {
    let ms = botFixedDelayMs;
    if (clockMs !== null && clockMs < 30000) ms = Math.min(ms, clockMs * 0.08);
    if (!botCanFlag && clockMs !== null) ms = Math.min(ms, Math.max(200, clockMs - 3000));
    return Math.max(200, ms);
  }

  // ── Mirror ───────────────────────────────────────────────────────────────
  if (botTimeBehavior === 'mirror') {
    if (botUserMoveTimestamps.length > 0) {
      const avg = botUserMoveTimestamps.reduce((a, b) => a + b, 0) / botUserMoveTimestamps.length;
      const jitter = 0.8 + Math.random() * 0.4;
      const offsetMul = 1 + (botMirrorOffsetPct / 100);
      let mirrorMs = avg * jitter * offsetMul;
      if (clockMs !== null && clockMs < 30000) mirrorMs = Math.min(mirrorMs, clockMs * 0.08);
      if (!botCanFlag && clockMs !== null) mirrorMs = Math.min(mirrorMs, Math.max(200, clockMs - 3000));
      return Math.max(200, Math.min(botThinkCapMs(), mirrorMs));
    }
    // No human moves yet — fall through to complexity/pace
  }

  // ── Complexity: explicit base/min/max from new panel ─────────────────────
  let thinkMs;
  if (botTimeBehavior === 'complexity') {
    // Prefer sfCplxScore (MultiPV probe) over entropy fallback when available
    const cplx = (sfCplxScore !== null) ? sfCplxScore : Math.min(1, entropy / 4.0);
    const mult = botCplxMin + cplx * (botCplxMax - botCplxMin);
    thinkMs = botCplxBase * mult * 1000;
  } else {
    // ── Pace (default): original entropy-based delay ──────────────────────
    const pace = parseInt(document.getElementById('botPace').value) || 40;
    const baseSec = (5 * 60) / pace;
    const complexity = Math.min(1 + entropy * 0.35, 2.5);
    thinkMs = baseSec * complexity * 1000;
  }

  // ── Clock-pressure mirroring: speed up when opponent is low on time ──────
  if (botBehavClockMirror && botOppClockMs !== null && clockMs !== null &&
      botOppClockMs < clockMs * 0.6) {
    thinkMs *= 0.5;
  }

  // ── Hustle attractor: +5 (faster hustler) … −5 (slower grinder) ────────────
  const hustle = (window._bcpAttractorValues && window._bcpAttractorValues['hustle']) || 0;
  if (hustle !== 0) thinkMs *= (1 - hustle * 0.15);

  // ── Reconsideration pause: occasional extended hesitation ────────────────
  if (botBehavReconsider && Math.random() < 0.15) {
    thinkMs *= 1.5 + Math.random();
  }

  // ── Base ±20% jitter ─────────────────────────────────────────────────────
  thinkMs *= 0.8 + Math.random() * 0.4;

  // ── Clock pressure caps ───────────────────────────────────────────────────
  if (clockMs !== null && clockMs < 30000) thinkMs = Math.min(thinkMs, clockMs * 0.08);
  if (!botCanFlag && clockMs !== null) thinkMs = Math.min(thinkMs, Math.max(200, clockMs - 3000));

  return Math.max(200, Math.min(botThinkCapMs(), thinkMs));
}
// Hustler personality: T=5 in the opening, fades to T=0.6 in the endgame.
// Phase is tracked by counting non-pawn, non-king pieces still on the board:
//   14 pieces (full material) → opening → T=5
//   ≤4 pieces remaining      → endgame → T=0.6
function hustlerPhaseTemp() {
  const piecesLeft = (typeof board !== 'undefined')
    ? board.filter(p => p !== 0 && Math.abs(p) !== 1 && Math.abs(p) !== 6).length
    : 14;
  // fraction 0=opening (14 pieces), 1=endgame (≤4 pieces)
  const fraction = Math.max(0, Math.min(1, 1 - (piecesLeft - 4) / 10));
  return 5.0 + fraction * (0.6 - 5.0); // 5.0 → 0.6
}

function timePressureTemp(baseTemp, clockMs) {
  // null/undefined = untimed; 0 is a real (maximally pressured) clock value
  if (clockMs === null || clockMs === undefined) return baseTemp;
  const boost = { steady: 0.0, normal: 1.0, panicky: 2.5 }[botTimePressure] || 0;
  if (boost === 0) return baseTemp;

  // cvB curve: available distribution % (100% at game start → floor at 1s)
  // fraction → 0 at 100% (no pressure), 1 at 0% (max pressure)
  if (botPressureCurveB && botPressureCurveB.length >= 2) {
    const thinkSec = (clockMs / 1000) / botRemainingMovesEstimate();
    const distPct = evalPressureCurve(botPressureCurveB, thinkSec); // 0–100 %
    if (distPct !== null) {
      const fraction = Math.max(0, Math.min(1, 1 - distPct / 100));
      return baseTemp + fraction * boost;
    }
  }

  // Linear fallback: ramps from 0 at 30 s to full boost at 0 s
  if (clockMs > 30000) return baseTemp;
  const fraction = Math.max(0, 1 - clockMs / 30000);
  return baseTemp + fraction * boost;
}

// ── Main bot move trigger ────────────────────────────────────────────────────
async function botMakeMove() {
  if (!botActive || botThinking || gameOver) return;
  const botColor = botPlayerColor === 'white' ? 'b' : 'w';
  if (turn !== botColor) return; // not bot's turn

  botThinking = true;
  document.getElementById('botStatus').textContent = '🤔 Thinking...';

  const _botMoveStartMs = Date.now(); // for inference-time accounting
  const fen = boardToFen(board, turn, castling, epSq);
  const clockMs = botClockMs();
  let uciMove = null;

  try {
    // ── Phase 2: Opening book layer ───────────────────────────────────────
    // Two independent fast-path flags — both reset each new game:
    //   preferredOpeningActive  — ECO table lookup, no network, preferred mode only
    //   lichessExplorerActive   — Lichess/Masters API, mainline + preferred fallback
    // Each flag flips to false permanently the first time it can't find a move.

    if (preferredOpeningActive && botOpeningMode === 'preferred') {
      // ── Preferred mode: pure in-memory ECO table lookup ─────────────────
      const botCol = botPlayerColor === 'white' ? 'black' : 'white';
      const slots  = (botOpeningConfig[botCol] || []).filter(s => s.name);
      if (!slots.length) {
        preferredOpeningActive = false;
      } else if (!_ecoData || !_ecoData.length) {
        // ECO data may still be loading — await it rather than permanently deactivating
        try { await obLoadEcoData(); } catch(e) {}
        if (!_ecoData || !_ecoData.length) { preferredOpeningActive = false; }
        // Release the thinking lock BEFORE re-entering — botMakeMove bails on
        // botThinking, so returning without this leaves the bot frozen forever.
        // Re-enter unconditionally: if the ECO load failed, the next call falls
        // through to the engine path instead of never moving.
        botThinking = false;
        document.getElementById('botStatus').textContent = '';
        if (botActive && !gameOver) setTimeout(botMakeMove, 50);
        return;
      } else if (botSanHistory.length >= (botOpeningConfig.maxBookDepth || 20)) {
        preferredOpeningActive = false;
      } else {
        const preferredUci = obPreferredNextMoves(
          botSanHistory, slots, board, turn, epSq, castling
        );
        if (preferredUci.size) {
          // Pick the highest-scored preferred move
          let bestUci = null, bestScore = -1;
          preferredUci.forEach(u => {
            const sc = preferredUci[u] || 1.0;
            if (sc > bestScore) { bestScore = sc; bestUci = u; }
          });
          if (bestUci) {
            uciMove = bestUci;
            lastBotMoveSource = 'ECO';
            const matchedEntry = _ecoData.find(e =>
              e.sanMoves.length > botSanHistory.length &&
              botSanHistory.every((m, i) => e.sanMoves[i] === m) &&
              slots.some(sl => {
                const ex = sl.exactEco || null;
                const fam = sl.familyPrefix || (sl.eco ? sl.eco.slice(0,2) : null);
                return (ex && e.eco.startsWith(ex)) || (fam && e.eco.startsWith(fam));
              })
            );
            const label = matchedEntry
              ? '♟ ' + matchedEntry.name + ' (' + matchedEntry.eco + ')'
              : '♟ Preferred Opening';
            document.getElementById('botStatus').textContent = label;
            const bookDelay = 400 + Math.random() * 800;
            await new Promise(r => setTimeout(r, bookDelay));
            botThinking = false;
            document.getElementById('botStatus').textContent = '';
            if (uciMove && botActive) {
              const mv = uciToSq(uciMove);
              if (mv) {
                const lm = legalMovesFor(mv.from, board, epSq, castling);
                if (lm.includes(mv.to)) {
                  clearGhostPieces();
                  executeMove(mv.from, mv.to, mv.promo || 'Q');
                  const _botSan = gameMovesAlgebraic[gameMovesAlgebraic.length - 1] || null;
                  botRecordMove(uciMove, _botSan);
                  updatePlayerBoxes();
                  const nextMoves = allLegalMoves(board, turn, epSq, castling);
                  if (!nextMoves.length) {
                    gameOverMsg = inCheck(board, turn)
                      ? (turn === 'w' ? 'Black' : 'White') + ' wins by checkmate'
                      : 'Stalemate — draw';
                    gameOver = true;
                    updatePlayerBoxes(); render();
                  }
                }
              }
            }
            return;
          }
        }
        // No preferred continuation — deactivate for rest of this game
        preferredOpeningActive = false;
      }
      // Preferred path ended (deactivated or no move) — fall through to engine

    } else if (botOpeningMode === 'mainline' && lichessExplorerActive) {
      // ── Mainline mode: Lichess/Masters explorer ──────────────────────────
      const openingMove = await botGetOpeningMove(botMoveHistory);
      if (openingMove) {
        uciMove = openingMove;
        lastBotMoveSource = 'Book';
        const _od = await openingExplorerFetch(botMoveHistory);
        document.getElementById('botStatus').textContent = botOpeningStatusText(_od);
        const bookDelay = 400 + Math.random() * 800;
        await new Promise(r => setTimeout(r, bookDelay));
        botThinking = false;
        document.getElementById('botStatus').textContent = '';
        if (uciMove && botActive) {
          const mv = uciToSq(uciMove);
          if (mv) {
            const lm = legalMovesFor(mv.from, board, epSq, castling);
            if (lm.includes(mv.to)) {
              clearGhostPieces();
              executeMove(mv.from, mv.to, mv.promo || 'Q');
              const _botSan = gameMovesAlgebraic[gameMovesAlgebraic.length - 1] || null;
              botRecordMove(uciMove, _botSan);
              updatePlayerBoxes();
              const nextMoves = allLegalMoves(board, turn, epSq, castling);
              if (!nextMoves.length) {
                gameOverMsg = inCheck(board, turn)
                  ? (turn === 'w' ? 'Black' : 'White') + ' wins by checkmate'
                  : 'Stalemate — draw';
                gameOver = true;
                updatePlayerBoxes(); render();
              }
            }
          }
        }
        return;
      } else {
        // Explorer returned nothing — off-book, don't call it again this game
        lichessExplorerActive = false;
      }
    }
    // ── End opening book layer ────────────────────────────────────────────

    if (botTab === 'sf') {
      const level = sfPickLevel(sfEffectiveLevel(clockMs));
      await sfInit();
      uciMove = await sfGetMove(fen, level);
      lastBotMoveSource = 'SF';
      // Simulate think time. Pass null, NOT a fake single-move distribution:
      // a one-entry distribution has entropy 0, which made the "blink" branch
      // treat every SF move as forced and play it near-instantly.
      const delay = botThinkTime(null, clockMs);
      await new Promise(r => setTimeout(r, delay));

    } else if (botTab === 'maia3') {
      // Pure Maia3 — no LC fallback, SF only if model not downloaded
      const m3Temp = parseFloat(document.getElementById('maia3Temp')?.value || '1.0');
      const m3EffTemp = timePressureTemp(m3Temp, clockMs);
      let m3Probs = null;
      // Kick off SF complexity probe in parallel with Maia inference (separate workers)
      if (_needsComplexity() && !sfReady) sfInit().catch(() => {}); // warm up SF for next move
      const cplxPromise = (_needsComplexity() && sfReady) ? sfGetComplexity(fen) : null;
      if (_maiaReady) {
        const savedRating = lcSelectedRating;
        lcSelectedRating = String(pressureEffectiveMaiaElo(clockMs)); // ELO degradation via ctrlA curve
        m3Probs = await maia3GetMoveProbs(fen);
        lcSelectedRating = savedRating;
        if (m3Probs) lastBotMoveSource = 'Maia3';
      }
      // Collect complexity result — likely already done while Maia was running
      if (cplxPromise) {
        const cr = await cplxPromise;
        sfCplxScore = cr ? cr.cplx : null;
        sfCplxEval  = cr ? cr.eval  : null;
      } else if (!_needsComplexity()) {
        sfCplxScore = sfCplxEval = null;
      }
      if (m3Probs && Object.keys(m3Probs).length) {
        const effElo = pressureEffectiveMaiaElo(clockMs);
        const allMoves = Object.entries(m3Probs).sort((a,b)=>b[1]-a[1]);
        console.log('[Maia3 FULL] elo:', effElo, 'fen:', fen, 'cplx:', sfCplxScore);
        console.log('[Maia3 FULL] all probs:', allMoves.map(([m,p])=>m+'='+p.toFixed(4)).join(' '));
        const targetDelay = botThinkTime(m3Probs, clockMs);
        const inferenceMs = Date.now() - _botMoveStartMs;
        const delay = Math.max(0, targetDelay - inferenceMs);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        _botMoveClockMs = clockMs; // for applyMoveAttractors distribution cutoff (ctrlB)
        const adjTemp = complexityAdjustedTemp(m3EffTemp);
        uciMove = sampleFromProbs(applyMoveAttractors(m3Probs), adjTemp);
        console.log('[Maia3 FULL] chose:', uciMove, '| temp:', adjTemp.toFixed(2), '(base:', m3EffTemp.toFixed(2), ')| inf:', inferenceMs, 'ms | extra wait:', delay, 'ms');
      } else {
        // Maia3 not downloaded — fall back to SF
        await sfInit();
        const fbLevel = Math.round(maia3SelectedRating / 200); // rough mapping
        uciMove = await sfGetMove(fen, Math.max(1, Math.min(20, fbLevel)));
        lastBotMoveSource = 'SF';
      }

    } else if (botTab === 'maia') {
      // LC Explorer with Maia3 fallback.
      // Skip LC call entirely if we already know we're off-book this game.
      const baseTemp = window._bcpHustlerTempMode
        ? hustlerPhaseTemp()
        : (typeof botMaiaTempValue !== 'undefined' && botMaiaTempValue > 0)
          ? botMaiaTempValue
          : (parseFloat(document.getElementById('maiaTemp')?.value) || 1.0);

      // Step 1: rough think estimate (no probs yet, entropy defaults to 2) so
      // the ELO degradation curve uses actual move pace, not clock/40 average.
      const roughThinkSec = botThinkTime(null, clockMs) / 1000;

      let probs = null;
      // Start complexity probe before LC/Maia calls — runs in parallel on sfWorker
      if (_needsComplexity() && !sfReady) sfInit().catch(() => {});
      const cplxPromiseMaia = (_needsComplexity() && sfReady) ? sfGetComplexity(fen) : null;
      if (lichessExplorerActive) {
        probs = await maiaGetMoveProbs(fen);
        if (probs && Object.keys(probs).length) {
          lastBotMoveSource = 'LC Explorer';
        } else {
          lichessExplorerActive = false; // off-book — don't call again this game
          probs = null;
        }
      }
      if (!probs && _maiaReady) {
        // Step 2: query Maia at ELO degraded by the rough think time
        const savedRatingM = lcSelectedRating;
        lcSelectedRating = String(pressureEffectiveMaiaEloByThink(roughThinkSec));
        probs = await maia3GetMoveProbs(fen);
        lcSelectedRating = savedRatingM;
        if (probs) lastBotMoveSource = 'Maia3';
      }
      // Collect complexity result — should be done by now
      if (cplxPromiseMaia) {
        const cr = await cplxPromiseMaia;
        sfCplxScore = cr ? cr.cplx : null;
        sfCplxEval  = cr ? cr.eval  : null;
      } else if (!_needsComplexity()) {
        sfCplxScore = sfCplxEval = null;
      }
      if (probs && Object.keys(probs).length) {
        // Step 3: precise think time now that we have entropy from real probs
        const targetDelay = botThinkTime(probs, clockMs);
        const preciseThinkSec = targetDelay / 1000;
        // Step 4: pressure curves keyed on actual think time, not clock average
        const effectiveTemp = timePressureTempByThink(baseTemp, preciseThinkSec);
        const inferenceMs = Date.now() - _botMoveStartMs;
        const delay = Math.max(0, targetDelay - inferenceMs);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        _botMoveClockMs = clockMs;
        _botMoveThinkSec = preciseThinkSec;
        uciMove = sampleFromProbs(applyMoveAttractors(probs), complexityAdjustedTemp(effectiveTemp));
        _botMoveThinkSec = null;
      } else {
        await sfInit();
        uciMove = await sfGetMove(fen, lcFallbackLevel());
        lastBotMoveSource = 'SF';
      }

    } else if (botTab === 'lcsf') {
      // LC Explorer with Stockfish fallback.
      // Skip LC call entirely if we already know we're off-book this game.
      const lcsfTemp = window._bcpHustlerTempMode
        ? hustlerPhaseTemp()
        : (typeof botMaiaTempValue !== 'undefined' && botMaiaTempValue > 0)
          ? botMaiaTempValue
          : (parseFloat(document.getElementById('maiaTemp')?.value) || 1.0);
      const roughThinkSecLcsf = botThinkTime(null, clockMs) / 1000;
      let lcsfProbs = null;
      if (lichessExplorerActive) {
        const savedRating = lcSelectedRating;
        lcSelectedRating = lcsfSelectedRating;
        lcsfProbs = await maiaGetMoveProbs(fen);
        lcSelectedRating = savedRating;
        if (lcsfProbs && Object.keys(lcsfProbs).length) {
          lastBotMoveSource = 'LC Explorer';
        } else {
          lichessExplorerActive = false; // off-book — don't call again this game
          lcsfProbs = null;
        }
      }
      if (lcsfProbs && Object.keys(lcsfProbs).length) {
        const targetDelay = botThinkTime(lcsfProbs, clockMs);
        const preciseThinkSecLcsf = targetDelay / 1000;
        const lcsfEffTemp = timePressureTempByThink(lcsfTemp, preciseThinkSecLcsf);
        const inferenceMs = Date.now() - _botMoveStartMs;
        const delay = Math.max(0, targetDelay - inferenceMs);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        _botMoveClockMs = clockMs;
        _botMoveThinkSec = preciseThinkSecLcsf;
        uciMove = sampleFromProbs(applyMoveAttractors(lcsfProbs), lcsfEffTemp);
        _botMoveThinkSec = null;
      } else {
        await sfInit();
        uciMove = await sfGetMove(fen, lcsfFallbackLevel());
        lastBotMoveSource = 'SF';
      }

    } else if (botTab === 'hybrid') {
      const slots = botHybridSlots.filter(s => s.weight > 0);
      if (slots.length) {
        const total = slots.reduce((s, sl) => s + sl.weight, 0);
        let r2 = Math.random() * total;
        let chosen = slots[slots.length - 1];
        for (const sl of slots) { r2 -= sl.weight; if (r2 <= 0) { chosen = sl; break; } }
        await sfInit(); // always init SF in case maia fails
        if (chosen.type === 'maia') {
          // Maia slot = the Maia3 neural model at the slot's own ELO.
          // (Previously this called the Lichess explorer and fell back to
          // Stockfish, so "hybrid Maia" never actually used Maia3.)
          const m3Temp = parseFloat(document.getElementById('maia3Temp')?.value || '1.0');
          const effectiveTemp = timePressureTemp(m3Temp, clockMs);
          const slotElo = chosen.elo || (chosen.level ? chosen.level * 200 : maia3SelectedRating);
          let probs = null;
          if (_maiaReady) {
            const savedRating = lcSelectedRating;
            lcSelectedRating = String(Math.max(600, Math.min(2600, slotElo)));
            try { probs = await maia3GetMoveProbs(fen); } catch(e) {}
            lcSelectedRating = savedRating;
            if (probs && Object.keys(probs).length) lastBotMoveSource = 'Maia3';
          }
          if (probs && Object.keys(probs).length) {
            const targetDelay = botThinkTime(probs, clockMs);
            const inferenceMs = Date.now() - _botMoveStartMs;
            const delay = Math.max(0, targetDelay - inferenceMs);
            if (delay > 0) await new Promise(res => setTimeout(res, delay));
            _botMoveClockMs = clockMs;
            uciMove = sampleFromProbs(applyMoveAttractors(probs), effectiveTemp);
          } else {
            // Maia3 not downloaded/failed — SF at a level matching the slot ELO
            const fbLevel = Math.max(1, Math.min(20, Math.round(slotElo / 200)));
            uciMove = await sfGetMove(fen, fbLevel);
            lastBotMoveSource = 'SF';
          }
        } else {
          const effectiveLevel = (chosen.level !== undefined && chosen.level > 0) ? chosen.level : sfEffectiveLevel(clockMs);
          const delay = botThinkTime(null, clockMs);
          await new Promise(res => setTimeout(res, delay));
          uciMove = await sfGetMove(fen, effectiveLevel);
        }
      }
    }
  } catch(e) {
    console.warn('Bot move error:', e);
  }

  botThinking = false;
  document.getElementById('botStatus').textContent = '';

  if (uciMove && botActive) {
    const mv = uciToSq(uciMove);
    if (mv) {
      const lm = legalMovesFor(mv.from, board, epSq, castling);
      if (lm.includes(mv.to)) {
        clearGhostPieces();
        executeMove(mv.from, mv.to, mv.promo || 'Q');
        // botRecordMove(uciMove); // Phase 1: track bot's move
        botRecordMove(uciMove, gameMovesAlgebraic[gameMovesAlgebraic.length - 1] || null); // Phase 1: track bot's move
        updatePlayerBoxes();
        // Check for game over
        const nextMoves = allLegalMoves(board, turn, epSq, castling);
        if (!nextMoves.length) {
          if (inCheck(board, turn)) {
            gameOverMsg = (turn === 'w' ? 'Black' : 'White') + ' wins by checkmate';
          } else {
            gameOverMsg = 'Stalemate — draw';
          }
          gameOver = true;
          updatePlayerBoxes(); render();
        }
      }
    }
  }
}

// ── Ghost piece rendering ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// GHOST PIECE SYSTEM — clean minimal rewrite
// One sfGhostWorker call per hover square. No caching. No Maia. No shared state.
// ═══════════════════════════════════════════════════════════════════════════

function clearGhostPieces() {
  if (ghostCtx && ghostCv) ghostCtx.clearRect(0, 0, ghostCv.width, ghostCv.height);
}

// Ghost is enabled when the soloGhostDepth dropdown is not "Off"
function ghostEnabled() {
  // Not during a LIVE 2-player game: engine-suggested replies would undercut
  // the "shared vision, own calculation" premise of human-vs-human play.
  // Only the in-progress game is gated — merely holding a room code (waiting
  // in the lobby, or exploring after the game ends) must not disable ghosts.
  if (typeof mpRoomId !== 'undefined' && mpRoomId &&
      typeof mpMode !== 'undefined' && mpMode === 'ingame' && !gameOver) return false;
  var sel = document.getElementById('soloGhostDepth');
  if (!sel) return true; // default on if no selector
  return sel.value === 'maia' || parseInt(sel.value) > 0;
}

// 'maia' (Maia3 2600 + 1500) or 'sf' (Stockfish at ghostDepth())
function ghostMode() {
  var sel = document.getElementById('soloGhostDepth');
  return (sel && sel.value === 'maia') ? 'maia' : 'sf';
}

function ghostDepth() {
  var sel = document.getElementById('soloGhostDepth');
  return sel ? Math.max(4, Math.min(12, parseInt(sel.value) || 8)) : 8;
}

// Run Maia3 inference at a specific Elo. lcSelectedRating is the global the
// inference reads its conditioning from — save/restore around the call.
async function ghostMaiaProbs(fen, elo) {
  var saved = lcSelectedRating;
  lcSelectedRating = String(elo);
  try { return await maia3GetMoveProbs(fen); }
  catch(e) { return null; }
  finally { lcSelectedRating = saved; }
}

// Top-N moves from a probs dict, sorted descending: [[uci, prob], ...]
function ghostTopMoves(probs) {
  return Object.entries(probs).sort(function(a, b) { return b[1] - a[1]; });
}

// Dropdown onchange — when Maia is picked, start the worker (cache check only;
// the 87MB download stays an explicit user action in the bot panel) and show
// a hint if the model isn't available yet.
function ghostModeChanged() {
  clearGhostPieces();
  var hint = document.getElementById('ghostMaiaHint');
  if (ghostMode() !== 'maia') {
    if (hint) hint.style.display = 'none';
    return;
  }
  if (typeof maiaInit === 'function') maiaInit();
  // Give the cache check a moment before declaring the model missing
  setTimeout(function() {
    if (!hint || ghostMode() !== 'maia') return;
    var ready = typeof _maiaReady !== 'undefined' && _maiaReady;
    hint.style.display = ready ? 'none' : '';
  }, 1500);
}

// The one active ghost request — cancel previous if hovering a new square
var _ghostRequestId = 0;
var _ghostFromSq = -1;

async function ghostShowForSquare(fromSq, toSq) {
  // Only show ghosts when human's turn
  if (botActive && botThinking) return;
  if (botActive) {
    var bc = botPlayerColor === 'white' ? 'b' : 'w';
    if (turn === bc) return;
  }

  // Warn if the selected ghost engine isn't loaded
  var _gm = ghostMode();
  if (_gm === 'maia') {
    var _ms = (typeof _maiaStatus !== 'undefined') ? _maiaStatus : 'idle';
    if (!(typeof _maiaReady !== 'undefined' && _maiaReady)) {
      if (_ms === 'no-cache' || _ms === 'idle') {
        if (typeof showEngineWarning === 'function')
          showEngineWarning('⚠ Maia 3 model not downloaded. Open the bot panel to download it.');
      }
      return; // nothing to show
    }
  } else if (_gm === 'sf') {
    if (!sfGhostReady) {
      // sfGhostInit will be called below; just make sure we don't warn every frame
      // Only warn if the worker hasn't been created yet
      if (!sfGhostWorker && typeof showEngineWarning === 'function') {
        showEngineWarning('⚠ Stockfish ghost engine is loading…');
      }
    }
  }

  clearGhostPieces();

  // Validate it's a legal move — always use real board/epSq, never preview state
  var realBoard = board; // board is always the real position
  if (toSq !== fromSq) {
    var lm = legalMovesFor(fromSq, realBoard, epSq, castling);
    if (!lm.includes(toSq)) return;
  }

  // Build position after hypothetical move (Q for pawn promotion — only for FEN)
  var hypBoard = (toSq === fromSq) ? realBoard : applyMove(fromSq, toSq, realBoard, epSq, 'Q');
  var hypTurn  = turn === 'w' ? 'b' : 'w';
  var hypFen   = boardToFen(hypBoard, hypTurn, castling, -1);

  // Tag this request so stale responses don't draw
  var myId = ++_ghostRequestId;

  // ── Maia mode: one inference at 2600 (blue), one at 1500 (purple) ─────────
  // Falls back to Stockfish below if the model isn't downloaded/ready.
  if (ghostMode() === 'maia' && typeof _maiaReady !== 'undefined' && _maiaReady) {
    var probsHi = await ghostMaiaProbs(hypFen, 2600);
    if (myId !== _ghostRequestId) return;
    var probsLo = await ghostMaiaProbs(hypFen, 1500);
    if (myId !== _ghostRequestId) return;
    if (!probsHi || !probsLo) return;

    var topHi = ghostTopMoves(probsHi);
    var topLo = ghostTopMoves(probsLo);
    if (!topHi.length) return;

    var uciHi = topHi[0][0];
    var mvHi = uciToSq(uciHi);
    if (!mvHi || mvHi.from == null || mvHi.to == null) return;
    _drawGhost(hypBoard, mvHi.from, mvHi.to, 0.50, 'rgba(74,159,212,0.90)');

    // Second ghost: 1500's top move; when both Elos agree, fall back to
    // 1500's runner-up — but only if it's plausible (>10%). When the top
    // move is near-forced, one ghost is the honest display.
    var uciLo = topLo.length ? topLo[0][0] : null;
    if (uciLo === uciHi) {
      uciLo = (topLo.length > 1 && topLo[1][1] > 0.10) ? topLo[1][0] : null;
    }
    if (uciLo) {
      var mvLo = uciToSq(uciLo);
      if (mvLo && mvLo.from != null && mvLo.to != null &&
          !(mvLo.from === mvHi.from && mvLo.to === mvHi.to)) {
        _drawGhost(hypBoard, mvLo.from, mvLo.to, 0.25, 'rgba(180,140,255,0.60)');
      }
    }
    return;
  }
  // Maia selected but model not ready — start loading it (no-op if cached or
  // already in flight) and use Stockfish for this hover.
  if (ghostMode() === 'maia' && typeof maiaInit === 'function') maiaInit();

  // ── Stockfish mode ─────────────────────────────────────────────────────────
  // Init ghost SF worker if needed (fetch once, reuse)
  try {
    await sfGhostInit();
  } catch(e) {
    console.warn('Ghost SF init failed:', e);
    return;
  }

  if (myId !== _ghostRequestId) return; // superseded

  var uci1 = await sfGhostGetMove(hypFen, ghostDepth());

  if (myId !== _ghostRequestId) return;
  if (!uci1) return;

  var mv1 = uciToSq(uci1);
  if (!mv1 || mv1.from == null || mv1.to == null) return;

  // Draw first response (more opaque — primary suggestion)
  _drawGhost(hypBoard, mv1.from, mv1.to, 0.50, 'rgba(74,159,212,0.90)');

  // Fetch second response, explicitly excluding first move via UCI searchmoves
  var uci2 = await sfGhostGetMove(hypFen, ghostDepth(), uci1, hypBoard, hypTurn, -1, castling);

  if (myId !== _ghostRequestId) return;

  if (uci2 && uci2 !== uci1) {
    var mv2 = uciToSq(uci2);
    if (mv2 && mv2.from != null && mv2.to != null &&
        !(mv2.from === mv1.from && mv2.to === mv1.to)) {
      // Draw second response (more transparent — secondary suggestion)
      _drawGhost(hypBoard, mv2.from, mv2.to, 0.25, 'rgba(180,140,255,0.60)');
    }
  }
}

function _drawGhost(bd, fromSq, toSq, alpha, outlineColor) {
  if (!ghostCtx || !ghostCv) return;
  var piece = bd[fromSq];
  if (!piece) return;

  var setKey = (currentPieceSet === 'unicode' ? 'staunton' : currentPieceSet);
  var img = pieceImgCache[setKey + piece.color + piece.piece];
  if (!img || !img.complete) return;

  var destAlpha = alpha || 0.45;
  var origAlpha = destAlpha * 0.4;
  var outline   = outlineColor || 'rgba(74,159,212,0.85)';

  var SQ  = ghostCv.width / 8;

  function sqXY(sq) {
    var r = Math.floor(sq / 8), c = sq % 8;
    if (boardFlipped) { r = 7 - r; c = 7 - c; }
    return { x: c * SQ, y: r * SQ };
  }

  // Destination: ghost with colored outline
  var dest = sqXY(toSq);
  ghostCtx.save();
  ghostCtx.globalAlpha = destAlpha;
  ghostCtx.drawImage(img, dest.x, dest.y, SQ, SQ);
  ghostCtx.restore();
  ghostCtx.save();
  ghostCtx.strokeStyle = outline;
  ghostCtx.lineWidth = 2.5;
  ghostCtx.strokeRect(dest.x + 1, dest.y + 1, SQ - 2, SQ - 2);
  ghostCtx.restore();

  // Origin: faint ghost (piece is leaving)
  var orig = sqXY(fromSq);
  ghostCtx.save();
  ghostCtx.globalAlpha = origAlpha;
  ghostCtx.drawImage(img, orig.x, orig.y, SQ, SQ);
  ghostCtx.restore();
}

// Called from existing canvas mousemove handler
function ghostOnMouseMove(hSq) {
  if (!ghostEnabled()) { clearGhostPieces(); return; }
  // Square-change gating is handled at the call site (inside sq!==hoverSq/dragOver gates)
  // so this function is only called once per new square.
  var fromSq = (dragFrom >= 0) ? dragFrom : selSq;
  if (fromSq < 0) { clearGhostPieces(); return; }
  // Skip if bot's turn
  if (botActive) {
    var bc = botPlayerColor === 'white' ? 'b' : 'w';
    if (turn === bc) { clearGhostPieces(); return; }
  }
  botLastHoverSq = hSq;
  _ghostFromSq = fromSq;
  ghostShowForSquare(fromSq, hSq);
}

// Called from existing canvas mousedown handler
function ghostOnMouseDown(sq) {
  if (!ghostEnabled()) return;
  _ghostFromSq = sq; // set immediately (before 15ms delay fires)
  _ghostRequestId++; // cancel any in-flight request
  botLastHoverSq = -1; // reset so first hover fires
  clearGhostPieces();
}

// Called from existing canvas mouseup handler  
function ghostOnMouseUp() {
  _ghostRequestId++; // cancel any in-flight request
  botLastHoverSq = -1; // reset hover tracking
  setTimeout(function() { if (selSq < 0 && dragFrom < 0) { _ghostFromSq = -1; clearGhostPieces(); } }, 80);
}

// Legacy alias kept so botPostMoveHook still compiles
function ghostIsEnabled() { return ghostEnabled(); }
function ghostSoloDepth() { return ghostDepth(); }

// // We register a callback rather than monkey-patching to avoid hoisting issues
function botPostMoveHook() {
  clearGhostPieces();
  botGhostResponses = {};
  botLastHoverSq = -1;
  _ghostFromSq = -1; // reset so ghost re-arms on next piece selection
  // Refresh player name to show live engine indicator
  if (botActive) botUpdatePlayerNames(botPlayerColor);

  // Phase 1: record human move and snap opponent clock.
  // lastMoveFrom/lastMoveTo are set by executeMove before this hook fires.
  if (botActive && typeof lastMoveFrom !== 'undefined' && lastMoveFrom >= 0) {
    // Determine if it was the human's move: turn has already flipped, so
    // if it is now the bot's turn, the move that just happened was the human's.
    const botColorLetter = botPlayerColor === 'white' ? 'b' : 'w';
    if (turn === botColorLetter) {
      // ── Mirror mode: record how long the human took on this move ───────────
      // botUserTurnStartMs was set when the previous bot move completed (or game start).
      if (botTimeBehavior === 'mirror' && botUserTurnStartMs !== null) {
        const humanMoveMs = Date.now() - botUserTurnStartMs;
        // Only count plausible move times (200 ms – 5 min) to exclude tab-away gaps
        if (humanMoveMs >= 200 && humanMoveMs <= 300000) {
          botUserMoveTimestamps.push(humanMoveMs);
          if (botUserMoveTimestamps.length > BOT_MIRROR_WINDOW) {
            botUserMoveTimestamps.shift(); // keep rolling window
          }
        }
        botUserTurnStartMs = null; // reset — will be re-armed when bot move finishes
      }

      // Derive UCI from the squares recorded by executeMove.
      // lastMovePromo is not stored globally, so we check the board for a
      // promotion piece: if the arriving square has a non-pawn piece of the
      // mover's color AND the piece left from rank 1/8, it was a promotion.
      let promo = null;
      const arrivedPiece = board[lastMoveTo];
      const fromRank = Math.floor(lastMoveFrom / 8);
      if (arrivedPiece && arrivedPiece.piece !== 'P' &&
          (fromRank === 1 || fromRank === 6) &&
          ['Q','R','B','N'].includes(arrivedPiece.piece)) {
        promo = arrivedPiece.piece.toLowerCase();
      }
      const humanUci = sqToUci(lastMoveFrom, lastMoveTo, promo);
      // Only record if not already pushed (bot move path already called botRecordMove)
      const last = botMoveHistory[botMoveHistory.length - 1];
      if (last !== humanUci) {
        // gameMovesAlgebraic has the SAN for every move including this one
        const humanSan = gameMovesAlgebraic[gameMovesAlgebraic.length - 1] || null;
        botRecordMove(humanUci, humanSan);
      }
    }
    botSnapOppClock();
  }

  if (botActive && !botThinking && !gameOver) {
    const botColor = botPlayerColor === 'white' ? 'b' : 'w';
    if (turn === botColor) {
      setTimeout(botMakeMove, 100);
    } else {
      // Player's turn — fire queued premove if any; also arm mirror timer
      botUserTurnStartMs = Date.now(); // start timing the human's current turn
      if(activePremove) setTimeout(tryFirePremove, 50);
    }
  }
}

// ── Bot UI controls ──────────────────────────────────────────────────────────

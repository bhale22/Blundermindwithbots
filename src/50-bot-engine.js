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
// Curve A for hybrid Maia slots. The curve's absolute ELO is anchored to the
// panel's main Elometer, which a hybrid bot doesn't use — each slot has its
// own rating. So the slot takes the curve's RELATIVE drop: (curve's relaxed
// top) − (curve at this think time), subtracted from the slot's own ELO.
// Relaxed think → drop ≈ 0 → the slot plays at exactly its configured rating;
// under pressure every slot degrades by the same amount, preserving the
// slots' identity gap (e.g. Drunken Master stays "sharp half / wobbly half").
function pressureSlotEloByThink(slotElo, thinkSec) {
  const clamped = Math.max(600, Math.min(2600, slotElo));
  if (!botPressureCurveA || botPressureCurveA.length < 2) return clamped;
  const atThink = evalPressureCurve(botPressureCurveA, thinkSec);
  if (atThink === null) return clamped;
  let top = -Infinity;
  for (const p of botPressureCurveA) { if (p.y > top) top = p.y; }
  const drop = Math.max(0, top - atThink);
  return Math.max(600, Math.min(2600, Math.round(clamped - drop)));
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

// ── Draw behaviour ────────────────────────────────────────────────────────────
// Current position's engine eval from the BOT's perspective (cp), or null.
// One shallow probe via the complexity machinery (cached per FEN).
async function botEvalAdvantageCp() {
  if (!sfReady) { try { await sfInit(); } catch (e) { return null; } }
  const fullmove = Math.floor(gameMovesAlgebraic.length / 2) + 1;
  const fen = boardToFen(board, turn, castling, epSq, halfmoveClock, fullmove);
  const res = await sfGetComplexity(fen);
  if (!res || res.eval == null) return null;
  // res.eval is from the side-to-move's perspective; bot plays the color the
  // human doesn't (botPlayerColor is the HUMAN's color)
  const botColor = (botPlayerColor === 'white') ? 'b' : 'w';
  return turn === botColor ? res.eval : -res.eval;
}

// ── ELO-scaled position judgment ─────────────────────────────────────────────
// Humans don't assess positions at Stockfish accuracy. The bot's PERCEPTION
// of its advantage = true eval + rating-scaled noise (σ ≈ 225 cp at 600 ELO
// shrinking to ~20 cp at 2600) plus a mild self-optimism bias — so a novice
// can genuinely believe a lost position is fine, and vice versa. Draw
// decisions use the perception, not the raw eval.
function _eloEvalNoiseSigma(elo) {
  return 15 + 700 * Math.exp(-(elo || 1500) / 500);
}
function _gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
async function botPerceivedAdvantageCp() {
  const adv = await botEvalAdvantageCp();
  if (adv === null) return null;
  const elo = Math.max(600, Math.min(2600,
    (typeof botEffectiveElo === 'function') ? botEffectiveElo() : 1500));
  const sigma = _eloEvalNoiseSigma(elo);
  return Math.round(adv + _gaussRand() * sigma + 0.25 * sigma);
}

// Small transient toast for bot draw messages (Accept/Decline when offering)
function _botDrawToast(html, buttons) {
  const old = document.getElementById('bm-bot-draw'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'bm-bot-draw';
  d.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:#14161a;border:0.5px solid rgba(200,146,42,0.5);border-radius:6px;' +
    'color:#e8e6e0;font-family:system-ui,sans-serif;font-size:12px;padding:10px 14px;' +
    'z-index:9999;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.6);';
  d.innerHTML = '<span>' + html + '</span>';
  (buttons || []).forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.style.cssText = 'background:rgba(200,146,42,0.15);border:0.5px solid rgba(200,146,42,0.5);' +
      'border-radius:4px;color:#e8aa40;font-family:inherit;font-size:11px;padding:4px 10px;cursor:pointer;';
    btn.onclick = () => { d.remove(); b.fn(); };
    d.appendChild(btn);
  });
  document.body.appendChild(d);
  setTimeout(() => { if (d.parentNode) d.remove(); }, buttons && buttons.length ? 25000 : 6000);
  return d;
}

function _botAgreeDraw() {
  gameOver = true;
  gameOverMsg = 'Draw by agreement ½-½';
  if (typeof clockStop === 'function') clockStop();
  updatePlayerBoxes(); render(); showRematchBtn(true);
}

// ── Clock context for draw decisions ─────────────────────────────────────────
// With a healthy increment nobody flags, so time pressure is a non-factor.
function _botDrawClockState() {
  if (typeof clockControl === 'undefined' || clockControl === 'untimed') return null;
  if (typeof clockTimeW !== 'number' || typeof clockTimeB !== 'number') return null;
  const humanSecs = (botPlayerColor === 'white') ? clockTimeW : clockTimeB;
  const botSecs   = (botPlayerColor === 'white') ? clockTimeB : clockTimeW;
  const inc = (typeof clockInc === 'number') ? clockInc : 0;
  return { humanSecs, botSecs, flaggable: inc < 10 };
}
// Opponent about to flag while the bot is comfortable → play for the clock,
// never agree to a draw (a full point is coming on time).
function _botExpectsToFlagOpponent() {
  const cs = _botDrawClockState();
  return !!(cs && cs.flaggable && cs.humanSecs < 20 &&
            cs.botSecs > Math.max(45, cs.humanSecs * 2.5));
}
// Bot itself about to flag while the human is comfortable → a human in that
// spot grabs the half point even from a better position.
function _botDesperateForDraw() {
  const cs = _botDrawClockState();
  return !!(cs && cs.flaggable && cs.botSecs < 20 &&
            cs.humanSecs > Math.max(45, cs.botSecs * 2.5));
}

// Human offered a draw (½ button during a bot game): the bot judges the
// position AT ITS OWN STRENGTH (perceived eval, not raw Stockfish) and
// accepts if its perceived advantage is at most the configured margin.
// Clock-aware: it never accepts when the human is about to flag, and gets
// far more agreeable when it is the one about to flag.
// Declines are human: no eval talk — a person just shakes their head,
// even when they know they're worse and are only hoping for a blunder.
const _BOT_DECLINE_LINES = [
  '🤖 The bot declines and plays on.',
  '🤖 No thanks — the bot wants to keep playing.',
  '🤖 The bot shakes its head. Play on.',
];
let _botDrawConsidering = false;
async function botConsiderDrawOffer() {
  if (_botDrawConsidering || gameOver || !botActive) return;
  const decline = () => _botDrawToast(
    _BOT_DECLINE_LINES[Math.floor(Math.random() * _BOT_DECLINE_LINES.length)]);
  if (!botAcceptDraws) { decline(); return; }
  // Opponent is about to flag: instant decline, no thought required — the
  // bot is playing for the win on time.
  if (_botExpectsToFlagOpponent()) { decline(); return; }
  // Mid-think: try again once the bot's move (and its probes) are done
  if (botThinking) { setTimeout(botConsiderDrawOffer, 1500); return; }
  _botDrawConsidering = true;
  try {
    _botDrawToast('🤖 The bot is considering your draw offer…');
    const adv = await botPerceivedAdvantageCp();
    if (gameOver || !botActive) return;
    // About to flag itself → takes the half point from far better positions
    const margin = botDrawAcceptMargin + (_botDesperateForDraw() ? 200 : 0);
    if (adv !== null && adv <= margin) {
      _botDrawToast('🤖 Draw accepted. ½-½');
      _botAgreeDraw();
    } else {
      decline();
    }
  } finally {
    _botDrawConsidering = false;
  }
}

// After its move, a draw-offering bot checks whether the position FEELS level
// (perceived eval at its own strength — a novice may offer from a lost
// position it believes is fine) and occasionally offers — from the configured
// move number, never twice within a dozen plies, with human-ish irregularity.
async function botMaybeOfferDraw() {
  if (!botOfferDraws || gameOver || !botActive || botThinking) return;
  // Never offer while the opponent is about to flag — the point is coming
  if (_botExpectsToFlagOpponent()) return;
  const ply = gameMovesAlgebraic.length;
  if (Math.floor(ply / 2) + 1 < botOfferDrawMove) return;
  if (ply - _botLastDrawOfferPly < 12) return;
  if (Math.random() > 0.5) return;
  const adv = await botPerceivedAdvantageCp();
  if (adv === null || gameOver || !botActive) return;
  // About to flag itself → offers from a much wider band, hoping you take it
  const band = botOfferDrawThresh + (_botDesperateForDraw() ? 150 : 0);
  if (Math.abs(adv) > band) return;
  _botLastDrawOfferPly = ply;
  _botDrawToast('🤖 The bot offers a draw.', [
    { label: 'Accept ½-½', fn: _botAgreeDraw },
    { label: 'Decline', fn: () => {} },
  ]);
}

// ── Stalemate seeking (desperation mode) ─────────────────────────────────────
// When hopelessly lost (from move X, eval worse than −Y cp), a stalemate
// seeker boosts moves that reduce its OWN future mobility and moves that dump
// material (desperado offers) — the classic human swindle recipe. Heuristic:
// it steers toward stalemate-shaped positions rather than calculating one.
let _staleSeekThisMove = false; // set per move; exempts the pick from the CP budget

function _staleSeekActiveNow() {
  // typeof guards: this file also runs in the unit-test VM without app-shell globals
  if (typeof botStaleSeek === 'undefined' || !botStaleSeek) return false;
  const fromMove = (typeof botStaleSeekMove !== 'undefined') ? botStaleSeekMove : 30;
  const threshCp = (typeof botStaleSeekCp   !== 'undefined') ? botStaleSeekCp   : 500;
  if (Math.floor(gameMovesAlgebraic.length / 2) + 1 < fromMove) return false;
  // sfCplxEval = this move's probe eval from the bot's (side-to-move) view
  return typeof sfCplxEval === 'number' && sfCplxEval !== null &&
         sfCplxEval <= -threshCp;
}

function _maybeStaleSeek(moveProbs) {
  _staleSeekThisMove = false;
  if (!_staleSeekActiveNow() || !moveProbs) return moveProbs;
  const keys = Object.keys(moveProbs);
  if (keys.length < 2) return moveProbs;
  _staleSeekThisMove = true;
  const botIsBlack  = (botPlayerColor === 'white');
  const botColorStr = botIsBlack ? 'b' : 'w';
  const oppColorStr = botIsBlack ? 'w' : 'b';
  const _E = new Set();
  const out = {};
  for (const uci of keys) {
    const from = fileRankToSq(uci.slice(0, 2));
    const to   = fileRankToSq(uci.slice(2, 4));
    let boost = 0;
    try {
      const moved = board[from];
      const nb = applyMove(from, to, board, epSq, 'Q');
      // (a) fewer own legal replies afterwards → closer to stalemate shape
      let mob = 0;
      for (let sq = 0; sq < 64 && mob < 24; sq++) {
        const pc = nb[sq];
        if (pc && pc.color === botColorStr) mob += legalMovesFor(sq, nb, -1, castling).length;
      }
      boost += Math.max(0, 24 - mob) * 0.05;
      // (b) desperado: the arrived piece (not the king) is offered — boost by
      // its value, more when undefended. Dumping the queen is the point.
      if (moved && moved.piece !== 'K') {
        const nAtk = buildDirectAtk(nb, _E, _E, _E, _E);
        const attackers = nAtk[to] ? (nAtk[to][oppColorStr] || []).length : 0;
        if (attackers > 0) {
          const val = { P:1, N:3, B:3, R:5, Q:9 }[moved.piece] || 1;
          const defenders = nAtk[to] ? (nAtk[to][botColorStr] || []).length : 0;
          boost += Math.min(1.3, (defenders === 0 ? 0.25 : 0.08) * val);
        }
      }
    } catch (e) { /* keep original weight */ }
    out[uci] = moveProbs[uci] * Math.exp(boost);
  }
  return out;
}

// ── CP-budget acceptance (engine-verified centipawmeter) ─────────────────────
// Maia probability is popularity, not quality — at low ratings the correlation
// between the two is weak (popular trap-falls, unseen strong moves), so the
// centipawn ceiling is enforced with REAL Stockfish evals, not a probability
// heuristic. When the personality reweighting produced a pick that differs
// from the most-popular move, the pick, the most-popular move, and a wide
// slice of the personality's preference order are evaluated together in one
// shallow searchmoves probe (single MultiPV search, not one call per move —
// this is what lets a large candidate set stay cheap). The pick is accepted
// only if it loses ≤ the effective ceiling versus the most-popular move;
// otherwise we walk down the personality's preference order and, if nothing
// fits, fall back to the most-popular move itself (0 cp by definition).
//
// Budget vs. Hard Floor: the Budget (window._bcpCpBudget) is the
// personality's allowance — it scales how hard the attractors push (the
// reweighting `scale` factor in applyMoveAttractors) AND is enforced here as
// the real, engine-verified cp ceiling on the personality's pick. One dial,
// one honest claim: "willing to lose up to Budget cp to express its style."
// The Hard Floor (window._bcpCpHardFloor, always ≥ Budget; slider top = Off)
// is a separate, looser backstop applied in applyHardFloorBackstop to picks
// from ANY mechanism — temperature, Luck, Bad Day, curve-B, plain sampling
// variance — bounding how bad any played move can be vs the popular move.
let _attrReweightApplied = false; // set by applyMoveAttractors each call

// Floor values at/above this mean "Off" (the panel slider's top position).
const HARD_FLOOR_OFF_CP = 1000;

// Set when the budget probe verified this move's pick (≤ Budget ≤ Floor, so
// the backstop can skip its own probe). Reset at the top of each acceptance
// call — acceptance always runs before the backstop in the move flow.
let _cpBudgetVerifiedThisMove = false;
// Last shallow probe result ({fen, evals}) — lets the backstop reuse the
// degradation guard's probe instead of paying for a second one.
let _lastEvalProbe = null;

// How many of the personality's next-favourite moves ride along in the probe
// beyond the chosen pick and the most-popular move. Wider = more of Maia's
// tail gets a real shot at passing the floor instead of being silently
// skipped just because it wasn't in a short shortlist. MultiPV cost scales
// with this number, so it's a probe-depth/latency tradeoff, not free.
const CP_BUDGET_WALK_SIZE = 15;

async function applyCpBudgetAcceptance(fen, chosenUci, rawProbs, shapedProbs) {
  _cpBudgetVerifiedThisMove = false; // reset per move, before any early return
  try {
    if (!chosenUci || !rawProbs || !_attrReweightApplied) return chosenUci;
    // Stalemate-seeking moves deliberately throw material — exempt from budget
    if (_staleSeekThisMove) return chosenUci;
    // The Budget is the personality's engine-verified allowance: its pick may
    // lose at most this many cp vs the most-popular move.
    const budget = window._bcpCpBudget != null ? +window._bcpCpBudget : 0;
    if (!(budget >= 0)) return chosenUci;
    let topMove = null, topP = -1;
    for (const m in rawProbs) { if (rawProbs[m] > topP) { topP = rawProbs[m]; topMove = m; } }
    if (!topMove || topMove === chosenUci) return chosenUci;
    // Personality preference order = reweighted probability, descending
    const order = Object.entries(shapedProbs || {}).sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const walk = [chosenUci, ...order.filter(m => m !== chosenUci && m !== topMove)]
      .slice(0, CP_BUDGET_WALK_SIZE);
    if (!sfReady) { try { await sfInit(); } catch (e) { return chosenUci; } }
    const evals = await sfEvalMoves(fen, [topMove, ...walk], 10);
    if (!evals || evals[topMove] == null) return chosenUci; // fail-open on probe failure
    _lastEvalProbe = { fen: fen, evals: evals };
    let accepted = topMove;
    for (const m of walk) {
      if (evals[m] == null) continue;
      if (evals[topMove] - evals[m] <= budget) { accepted = m; break; }
    }
    if (accepted !== chosenUci) {
      const loss = evals[chosenUci] != null ? Math.round(evals[topMove] - evals[chosenUci]) : '?';
      console.log('[CpBudget] pick', chosenUci, '(' + loss + 'cp vs most-popular) exceeds budget',
        budget, '— playing', accepted, 'instead');
    }
    _cpBudgetVerifiedThisMove = true; // accepted move is ≤ Budget (≤ Floor)
    return accepted;
  } catch (e) {
    return chosenUci;
  }
}

// ── Degradation eval guard ────────────────────────────────────────────────────
// Bad Day and the time-pressure distribution restriction steer the bot's pick
// by PROBABILITY, which is popularity at the rating, not quality — so the
// steered pick is occasionally an objectively strong move few players see.
// Degradation must never upgrade play: when a degradation mechanism is active
// and the pick differs from the top-probability move, evaluate both with one
// shallow searchmoves probe and play whichever scores WORSE.
async function applyDegradationEvalGuard(fen, chosenUci, rawProbs) {
  try {
    if (!chosenUci || !rawProbs) return chosenUci;
    let topMove = null, topP = -1;
    for (const m in rawProbs) { if (rawProbs[m] > topP) { topP = rawProbs[m]; topMove = m; } }
    if (!topMove || topMove === chosenUci) return chosenUci;
    // Is the TP distribution restriction actually narrowing the window right
    // now? 1-point tolerance so a near-flat curve doesn't probe every move.
    const tpRestricting = botPressureCurveB && botPressureCurveB.length >= 2 &&
      (_botMoveThinkSec !== null
        ? pressureEffectiveDayUpperByThink(_botMoveThinkSec) < botDayUpper - 1
        : _botMoveClockMs !== null && pressureEffectiveDayUpper(_botMoveClockMs) < botDayUpper - 1);
    if (!botBadDayMode && !tpRestricting) return chosenUci;
    if (!sfReady) { try { await sfInit(); } catch (e) { return chosenUci; } }
    const evals = await sfEvalMoves(fen, [chosenUci, topMove]);
    if (!evals || evals[chosenUci] == null || evals[topMove] == null) return chosenUci;
    _lastEvalProbe = { fen: fen, evals: evals };
    if (evals[chosenUci] > evals[topMove]) {
      console.log('[DegradeGuard] pick', chosenUci, '(' + evals[chosenUci] + 'cp) beats top-prob',
        topMove, '(' + evals[topMove] + 'cp) — playing the top-probability move instead');
      return topMove;
    }
    return chosenUci;
  } catch (e) {
    return chosenUci;
  }
}

// ── Hard Floor backstop (absolute quality bound) ─────────────────────────────
// Bounds how far below Maia's most-popular move ANY final pick may fall —
// whatever produced it: temperature sampling, the Luck window shift, Bad Day,
// curve-B time-pressure restriction, or plain sampling variance. Runs last in
// the pick flow. Skips: picks already engine-verified within the Budget
// (Budget ≤ Floor by invariant), stalemate-seeking picks (throwing material
// is the point), and Floor = Off. Reuses the degradation guard's probe when
// one was taken for the same position; otherwise pays for one shallow probe.
// Fail-open like every other probe — a timeout never stalls the bot's move.
async function applyHardFloorBackstop(fen, chosenUci, rawProbs) {
  try {
    if (!chosenUci || !rawProbs) return chosenUci;
    if (_staleSeekThisMove) return chosenUci;
    if (_cpBudgetVerifiedThisMove) return chosenUci; // already ≤ Budget ≤ Floor
    const floor = window._bcpCpHardFloor != null ? +window._bcpCpHardFloor
                : window._bcpCpBudget    != null ? +window._bcpCpBudget : null;
    if (floor === null || !(floor >= 0) || floor >= HARD_FLOOR_OFF_CP) return chosenUci;
    let topMove = null, topP = -1;
    for (const m in rawProbs) { if (rawProbs[m] > topP) { topP = rawProbs[m]; topMove = m; } }
    if (!topMove || topMove === chosenUci) return chosenUci;
    // Reuse the guard's probe if it covered this position and both moves
    let evals = null;
    if (_lastEvalProbe && _lastEvalProbe.fen === fen &&
        _lastEvalProbe.evals[chosenUci] != null && _lastEvalProbe.evals[topMove] != null) {
      evals = _lastEvalProbe.evals;
    } else {
      if (!sfReady) { try { await sfInit(); } catch (e) { return chosenUci; } }
      evals = await sfEvalMoves(fen, [chosenUci, topMove]);
      if (!evals || evals[chosenUci] == null || evals[topMove] == null) return chosenUci;
    }
    if (evals[topMove] - evals[chosenUci] > floor) {
      console.log('[HardFloor] pick', chosenUci, 'loses',
        Math.round(evals[topMove] - evals[chosenUci]), 'cp vs most-popular — over the',
        floor, 'cp floor; playing', topMove, 'instead');
      return topMove;
    }
    return chosenUci;
  } catch (e) {
    return chosenUci;
  }
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
// ── Custom controls: user-defined attractors ─────────────────────────────────
// A custom control is { id, name, metric, phase, value(-5..+5) }. It reuses the
// exact attractor mechanism: count a board feature before and after a candidate
// move, squash the delta through tanh, and add value×scale×tanh(delta/k) to the
// move's logBoost. The sign of `value` is the direction (right/+ = maximize the
// metric, left/- = minimize it). Each control also counts toward the CP budget's
// totalAbs so the panel's cp-allocation display stays accurate.
//
//   metricFn(bd, ctx) → number   ctx = { me, opp, atk }
//     me / opp  'w'|'b' colour strings for the bot and its opponent
//     atk       attack map for bd (atk[sq]={w:[...],b:[...]}); only supplied when
//               the metric sets needsAtk:true, else null.
// Higher return = "more of this feature for the bot"; k scales the tanh response.
const _CC_PIECEVAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const _ccMetrics = {
  passedPawns: {
    label: 'Passed pawns', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp;
      const oppPawns = [];
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.piece === 'P' && p.color === opp) oppPawns.push(sq);
      }
      let count = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.piece !== 'P' || p.color !== me) continue;
        const f = sq % 8, r = (sq / 8) | 0;
        let passed = true;
        for (const o of oppPawns) {
          const f2 = o % 8, r2 = (o / 8) | 0;
          if (Math.abs(f2 - f) > 1) continue;
          // r decreases as White advances (r=0 is the 8th rank); an opponent pawn
          // ahead of ours on this/adjacent file blocks the passer.
          if (me === 'w' ? (r2 < r) : (r2 > r)) { passed = false; break; }
        }
        if (passed) count++;
      }
      return count;
    }
  },
  pawnAdvance: {
    label: 'Pawn advancement', needsAtk: false, k: 4,
    fn(bd, ctx) {
      const me = ctx.me;
      let s = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.piece !== 'P' || p.color !== me) continue;
        const r = (sq / 8) | 0;
        s += me === 'w' ? (6 - r) : (r - 1); // ranks advanced from the pawn's start
      }
      return s;
    }
  },
  kingZoneAttackers: {
    label: 'King-zone pressure', needsAtk: true, k: 3,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let ksq = -1;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.piece === 'K' && p.color === opp) { ksq = sq; break; }
      }
      if (ksq < 0) return 0;
      const kf = ksq % 8, kr = (ksq / 8) | 0;
      let cnt = 0;
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          const f = kf + df, r = kr + dr;
          if (f < 0 || f > 7 || r < 0 || r > 7) continue;
          const sq = r * 8 + f;
          if (atk[sq]) cnt += (atk[sq][me] || []).length;
        }
      }
      return cnt;
    }
  },
  attackedPieces: {
    label: 'Enemy pieces attacked', needsAtk: true, k: 2,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let cnt = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.color === opp && atk[sq] && (atk[sq][me] || []).length > 0) cnt++;
      }
      return cnt;
    }
  },
  weakSquares: {
    label: 'My weak squares', needsAtk: true, k: 5,
    fn(bd, ctx) {
      const me = ctx.me, atk = ctx.atk;
      if (!atk) return 0;
      let cnt = 0;
      for (let sq = 0; sq < 64; sq++) {
        if (!bd[sq] && atk[sq] && (atk[sq][me] || []).length === 0) cnt++;
      }
      return cnt;
    }
  },
  hangingPieces: {
    label: 'My hanging pieces', needsAtk: true, k: 2,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let cnt = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.color !== me || p.piece === 'K' || !atk[sq]) continue;
        const att = (atk[sq][opp] || []).length;
        const def = (atk[sq][me]  || []).length;
        if (att > 0 && def === 0) cnt++;
      }
      return cnt;
    }
  },
  centralization: {
    label: 'Piece centralization', needsAtk: false, k: 3,
    fn(bd, ctx) {
      const me = ctx.me;
      let s = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.color !== me || p.piece === 'P' || p.piece === 'K') continue;
        const f = sq % 8, r = (sq / 8) | 0;
        // Closeness to the central 4×4 (max at the d/e, 4/5 squares).
        s += (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 3.5));
      }
      return s;
    }
  },
  outpost: {
    label: 'Knight/bishop outposts', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp;
      const fwd = me === 'w' ? -1 : 1; // Δr the bot's pawns advance (r=0 is rank 8)
      let count = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.color !== me || (p.piece !== 'N' && p.piece !== 'B')) continue;
        const f = sq % 8, r = (sq / 8) | 0;
        // Must be advanced past the middle into enemy territory.
        if (me === 'w' ? (r > 4) : (r < 3)) continue;
        // Supported by a friendly pawn one rank behind, diagonally.
        const br = r - fwd;
        let supported = false;
        for (const df of [-1, 1]) {
          const bf = f + df;
          if (bf < 0 || bf > 7 || br < 0 || br > 7) continue;
          const q = bd[br * 8 + bf];
          if (q && q.piece === 'P' && q.color === me) { supported = true; break; }
        }
        if (!supported) continue;
        // No enemy pawn on an adjacent file can ever advance to challenge it.
        let challengeable = false;
        for (let s2 = 0; s2 < 64 && !challengeable; s2++) {
          const q = bd[s2];
          if (!q || q.piece !== 'P' || q.color !== opp) continue;
          const f2 = s2 % 8, r2 = (s2 / 8) | 0;
          if (Math.abs(f2 - f) !== 1) continue;
          if (me === 'w' ? (r2 < r) : (r2 > r)) challengeable = true;
        }
        if (!challengeable) count++;
      }
      return count;
    }
  },

  // ── Material & trades ──────────────────────────────────────────────────────
  material: {
    label: 'Material balance', needsAtk: false, k: 3,
    fn(bd, ctx) {
      const me = ctx.me;
      let s = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p) continue;
        const v = _CC_PIECEVAL[p.piece] || 0;
        s += p.color === me ? v : -v;
      }
      return s;
    }
  },
  pieceCount: {
    label: 'Total pieces on board', needsAtk: false, k: 3,
    fn(bd) { let n = 0; for (let sq = 0; sq < 64; sq++) if (bd[sq]) n++; return n; }
  },
  queens: {
    label: 'Queens on board', needsAtk: false, k: 1,
    fn(bd) { let n = 0; for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'Q') n++; } return n; }
  },

  // ── King attack & safety ───────────────────────────────────────────────────
  kingDanger: {
    label: 'Enemy pressure on my king', needsAtk: true, k: 3,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let ksq = -1;
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'K' && p.color === me) { ksq = sq; break; } }
      if (ksq < 0) return 0;
      const kf = ksq % 8, kr = (ksq / 8) | 0;
      let c = 0;
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        const f = kf + df, r = kr + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const s = r * 8 + f;
        if (atk[s]) c += (atk[s][opp] || []).length;
      }
      return c;
    }
  },
  kingShield: {
    label: 'Pawn shield on my king', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, fwd = me === 'w' ? -1 : 1;
      let ksq = -1;
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'K' && p.color === me) { ksq = sq; break; } }
      if (ksq < 0) return 0;
      const kf = ksq % 8, kr = (ksq / 8) | 0;
      let c = 0;
      for (let df = -1; df <= 1; df++) for (let dd = 1; dd <= 2; dd++) {
        const f = kf + df, r = kr + fwd * dd;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const p = bd[r * 8 + f];
        if (p && p.piece === 'P' && p.color === me) c++;
      }
      return c;
    }
  },
  givesCheck: {
    label: 'Gives check', needsAtk: false, k: 1,
    fn(bd, ctx) { return (typeof inCheck === 'function' && inCheck(bd, ctx.opp)) ? 1 : 0; }
  },

  // ── Pawn structure ─────────────────────────────────────────────────────────
  doubledPawns: {
    label: 'My doubled pawns', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, files = [0,0,0,0,0,0,0,0];
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'P' && p.color === me) files[sq % 8]++; }
      let d = 0; for (let f = 0; f < 8; f++) if (files[f] > 1) d += files[f] - 1; return d;
    }
  },
  isolatedPawns: {
    label: 'My isolated pawns', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, files = [0,0,0,0,0,0,0,0];
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'P' && p.color === me) files[sq % 8]++; }
      let iso = 0;
      for (let f = 0; f < 8; f++) if (files[f] > 0 && (f === 0 || files[f-1] === 0) && (f === 7 || files[f+1] === 0)) iso += files[f];
      return iso;
    }
  },
  pawnIslands: {
    label: 'My pawn islands', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, files = [0,0,0,0,0,0,0,0];
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'P' && p.color === me) files[sq % 8]++; }
      let isl = 0, inIsl = false;
      for (let f = 0; f < 8; f++) { if (files[f] > 0) { if (!inIsl) { isl++; inIsl = true; } } else inIsl = false; }
      return isl;
    }
  },
  connectedPawns: {
    label: 'My connected pawns', needsAtk: false, k: 2,
    fn(bd, ctx) {
      const me = ctx.me;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.piece !== 'P' || p.color !== me) continue;
        const f = sq % 8, r = (sq / 8) | 0;
        let conn = false;
        for (const df of [-1, 1]) {
          const af = f + df; if (af < 0 || af > 7) continue;
          for (let ar = r - 1; ar <= r + 1; ar++) {
            if (ar < 0 || ar > 7) continue;
            const q = bd[ar * 8 + af];
            if (q && q.piece === 'P' && q.color === me) { conn = true; break; }
          }
          if (conn) break;
        }
        if (conn) c++;
      }
      return c;
    }
  },

  // ── Piece placement & activity ─────────────────────────────────────────────
  mobility: {
    label: 'My piece mobility', needsAtk: false, k: 8,
    fn(bd, ctx) {
      const me = ctx.me;
      let m = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.color === me) { const a = rawAttacks(sq, bd); m += a ? a.length : 0; }
      }
      return m;
    }
  },
  bishopPair: {
    label: 'Bishop pair', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me; let b = 0;
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'B' && p.color === me) b++; }
      return b >= 2 ? 1 : 0;
    }
  },
  rooksOpenFiles: {
    label: 'Rooks on open files', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, pawnFiles = [0,0,0,0,0,0,0,0];
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'P') pawnFiles[sq % 8]++; }
      let c = 0;
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'R' && p.color === me && pawnFiles[sq % 8] === 0) c++; }
      return c;
    }
  },
  rooksSeventh: {
    label: 'Rooks on the 7th rank', needsAtk: false, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, target = me === 'w' ? 1 : 6; // the enemy's 2nd rank
      let c = 0;
      for (let sq = 0; sq < 64; sq++) { const p = bd[sq]; if (p && p.piece === 'R' && p.color === me && ((sq / 8) | 0) === target) c++; }
      return c;
    }
  },
  developedPieces: {
    label: 'Developed minor pieces', needsAtk: false, k: 2,
    fn(bd, ctx) {
      const me = ctx.me, back = me === 'w' ? 7 : 0;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.color === me && (p.piece === 'N' || p.piece === 'B') && ((sq / 8) | 0) !== back) c++;
      }
      return c;
    }
  },

  // ── Threats & square control ───────────────────────────────────────────────
  enemyHanging: {
    label: 'Loose enemy pieces', needsAtk: true, k: 1,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.color !== opp || p.piece === 'K' || !atk[sq]) continue;
        if ((atk[sq][me] || []).length > 0 && (atk[sq][opp] || []).length === 0) c++;
      }
      return c;
    }
  },
  defendedPieces: {
    label: 'My defended pieces', needsAtk: true, k: 3,
    fn(bd, ctx) {
      const me = ctx.me, atk = ctx.atk;
      if (!atk) return 0;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (!p || p.color !== me || p.piece === 'K' || !atk[sq]) continue;
        if ((atk[sq][me] || []).length > 0) c++;
      }
      return c;
    }
  },
  enemyWeakSquares: {
    label: 'Holes in enemy camp', needsAtk: true, k: 5,
    fn(bd, ctx) {
      const me = ctx.me, opp = ctx.opp, atk = ctx.atk;
      if (!atk) return 0;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        if (bd[sq]) continue;
        const r = (sq / 8) | 0;
        const inEnemyHalf = me === 'w' ? (r <= 3) : (r >= 4);
        if (inEnemyHalf && atk[sq] && (atk[sq][opp] || []).length === 0) c++;
      }
      return c;
    }
  },
  centerControl: {
    label: 'Central square control', needsAtk: true, k: 3,
    fn(bd, ctx) {
      const me = ctx.me, atk = ctx.atk;
      if (!atk) return 0;
      let c = 0;
      for (const s of [27, 28, 35, 36]) if (atk[s]) c += (atk[s][me] || []).length; // d5 e5 d4 e4
      return c;
    }
  },
  spaceControl: {
    label: 'Space in enemy half', needsAtk: true, k: 5,
    fn(bd, ctx) {
      const me = ctx.me, atk = ctx.atk;
      if (!atk) return 0;
      let c = 0;
      for (let sq = 0; sq < 64; sq++) {
        if (bd[sq]) continue;
        const r = (sq / 8) | 0;
        const inEnemyHalf = me === 'w' ? (r <= 3) : (r >= 4);
        if (inEnemyHalf && atk[sq] && (atk[sq][me] || []).length > 0) c++;
      }
      return c;
    }
  },

  // ── Mirrors of the built-in attractors (so they can be phase/result-gated) ──
  // Fort Knox: total friendly defender coverage over all of the bot's pieces.
  pieceDefense: {
    label: 'Piece defense (Fort Knox)', needsAtk: true, k: 3,
    fn(bd, ctx) {
      const me = ctx.me, atk = ctx.atk;
      if (!atk) return 0;
      let total = 0;
      for (let sq = 0; sq < 64; sq++) {
        const p = bd[sq];
        if (p && p.color === me && atk[sq]) total += (atk[sq][me] || []).length;
      }
      return total;
    }
  },
  // Structure: negative of (islands + doubled + isolated) — higher = tighter.
  pawnStructure: {
    label: 'Pawn structure health', needsAtk: false, k: 1,
    fn(bd, ctx) { return -_pawnStructurePenalty(bd, ctx.me); }
  }
};

// Current game phase from material + ply. Mirrors the opening gate used elsewhere
// (gameMovesAlgebraic.length < 20) and an endgame material heuristic (≤6 non-king,
// non-pawn pieces left on the board, both colours).
function _botGamePhase() {
  let majMin = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p || p.piece === 'K' || p.piece === 'P') continue;
    majMin++;
  }
  if (majMin <= 6) return 'endgame';
  const ply = (typeof gameMovesAlgebraic !== 'undefined') ? gameMovesAlgebraic.length : 0;
  if (ply < 20) return 'opening';
  return 'middlegame';
}

function _ccPhaseMatch(phase, current) {
  return !phase || phase === 'all' || phase === current;
}

// Optional game-state gate keyed on the Stockfish complexity-probe eval (cp, from
// the bot's perspective; null when no probe ran this move). ±50 cp = "equal".
function _ccResultMatch(result, evalCp) {
  if (!result || result === 'any') return true;
  if (evalCp === null || evalCp === undefined) return false; // no eval → don't fire
  if (result === 'winning') return evalCp >  50;
  if (result === 'losing')  return evalCp < -50;
  if (result === 'equal')   return evalCp >= -50 && evalCp <= 50;
  return true;
}

// "Under time pressure" = a side's clock has entered the scramble zone: below
// 30 s, or below 15% of its starting time (covers blitz through classical).
// null / untimed clocks are never under pressure.
function _ccUnderPressure(clockMs) {
  if (clockMs === null || clockMs === undefined) return false;
  if (clockMs < 30000) return true;
  return (typeof botStartClockMs === 'number' && botStartClockMs > 0) && clockMs < botStartClockMs * 0.15;
}
function _ccPressureMatch(cond, botClock, oppClock) {
  if (!cond || cond === 'any') return true;
  const meP  = _ccUnderPressure(botClock);
  const oppP = _ccUnderPressure(oppClock);
  if (cond === 'self')   return meP;
  if (cond === 'opp')    return oppP;
  if (cond === 'either') return meP || oppP;
  return true;
}

function applyMoveAttractors(moveProbs) {
  _attrReweightApplied = false;
  if (!moveProbs || !Object.keys(moveProbs).length) return moveProbs;

  const attrVals  = window._bcpAttractorValues || {};
  const pieceVals = window._bcpPieceValues     || {};
  const cpBudget  = window._bcpCpBudget != null ? window._bcpCpBudget : 100;

  // Custom controls (user-defined attractors): keep ones with a non-zero value
  // and a known metric, then gate by current game phase. Phase depends only on
  // the board, so it can be resolved here before colour strings are set up.
  const customControls = (window._bcpCustomControls || [])
    .filter(c => c && c.value && _ccMetrics[c.metric]);
  const _ccPhase  = customControls.length ? _botGamePhase() : null;
  const _ccEval   = (typeof sfCplxEval !== 'undefined') ? sfCplxEval : null;
  const _ccBotClk = (typeof botClockMs === 'function') ? botClockMs() : null;
  const _ccOppClk = (typeof botOppClockMs !== 'undefined') ? botOppClockMs : null;
  const activeCC  = customControls.filter(c =>
    _ccPhaseMatch(c.phase, _ccPhase) &&
    _ccResultMatch(c.result, _ccEval) &&
    _ccPressureMatch(c.pressure, _ccBotClk, _ccOppClk));
  const hasCustom = activeCC.length > 0;

  const luckVal       = attrVals['luck']       || 0;
  const tradeVal      = attrVals['trade']      || 0;
  const spaceCadetVal = attrVals['spacecadet'] || 0;
  const fortKxVal     = attrVals['fortkx']     || 0;
  const gambitoVal    = attrVals['gambito']    || 0;
  const attackerVal   = attrVals['attacker']   || 0;
  const structureVal  = attrVals['structure']  || 0;
  const hasPiece   = Object.values(pieceVals).some(v => v !== 0);
  const hasTrade   = tradeVal      !== 0;
  const hasSpace   = spaceCadetVal !== 0;
  const hasFortkx  = fortKxVal     !== 0;
  const hasGambito = gambitoVal    !== 0;
  const hasAttacker = attackerVal  !== 0;
  const hasStructure = structureVal !== 0;

  // ── Min-probability filter (Maia3 / LC modes) ─────────────────────────────
  // Absolute popularity floor — an honest distribution control. The old
  // relative "blunder limit" cutoff (e^(−cp/100) of the top move) pretended
  // probability ratios were centipawns; real centipawn enforcement now
  // happens post-pick in applyCpBudgetAcceptance (Stockfish-verified).
  if (botMinProbPct > 0) {
    const entries  = Object.entries(moveProbs).sort((a, b) => b[1] - a[1]);
    const absFloor = botMinProbPct / 100;
    const passed   = entries.filter(([, p]) => p >= absFloor);
    moveProbs = Object.fromEntries(passed.length ? passed : (entries.length ? [entries[0]] : []));
  }

  // ── CP budget → per-unit scale ────────────────────────────────────────────
  // The budget is re-divided among whatever is actually exerting an opinion this
  // move: the always-on built-in attractors plus only the custom controls whose
  // conditions (phase / advantage / time-pressure) currently match (activeCC).
  // So a control that's the only active one in its phase gets the full budget —
  // the bot's "personality strength" stays at the set budget in every phase
  // where at least one control is active. (Attractors without per-move logic —
  // luck, hustle, pressure — still count so they keep their budget share.)
  const CP_PER_LOG_UNIT = 150;
  const allVals  = [...Object.values(attrVals), ...Object.values(pieceVals)];
  const ccAbs    = activeCC.reduce((s, c) => s + Math.abs(c.value || 0), 0);
  const totalAbs = allVals.reduce((s, v) => s + Math.abs(v || 0), 0) + ccAbs;
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

  // ── Bad Day mode: pick lowest-probability plausible move ─────────────────
  // Grandmaster Bad Day: sort by probability ascending, return the first move
  // that meets the minProbPct threshold (lowest prob still considered plausible).
  // No implicit floor beyond the user's own min-probability slider (default 0)
  // — the whole point of this mode is the tail, so it shouldn't be fenced off
  // by a hardcoded guard the user never asked for. Note: probability = how
  // often players at this rating choose the move, not engine quality — this
  // can land on a strong move few players see; the post-pick
  // applyDegradationEvalGuard swaps those back to the top choice.
  if (botBadDayMode) {
    const _floor = botMinProbPct / 100;
    const _asc = Object.entries(filtered).sort((a, b) => a[1] - b[1]);
    const _worst = _asc.find(([, p]) => p >= _floor);
    if (_worst) filtered = { [_worst[0]]: _worst[1] };
  }

  // ── Per-move reweighting ──────────────────────────────────────────────────
  const needsPerMove = scale > 0 &&
    (hasPiece || hasTrade || hasSpace || hasFortkx || hasGambito || hasAttacker || hasStructure || hasCustom);
  if (!needsPerMove) return _maybeStaleSeek(filtered);

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

  // ── Custom controls: per-turn baselines on the current board ──────────────
  // The global atkMap is the attack map for the current position (the same one
  // the space/fortkx baselines above read), so metric baselines can reuse it.
  const ccNeedsAtk = hasCustom && activeCC.some(c => _ccMetrics[c.metric].needsAtk);
  if (hasCustom) {
    // atkMap is the current position's map; build one if it isn't available so
    // the metric baseline matches what getSimAtkCC computes for candidates.
    const baseAtk = ccNeedsAtk
      ? (atkMap || buildDirectAtk(board, _EMPTY, _EMPTY, _EMPTY, _EMPTY))
      : null;
    const baseCtx = { me: botColorStr, opp: oppColorStr, atk: baseAtk };
    for (const c of activeCC) c._ccBefore = _ccMetrics[c.metric].fn(board, baseCtx);
  }

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
    // Full attack map on the simulated board — shared by every custom-control
    // metric that sets needsAtk, built once per candidate.
    let _simAtkCC = null;
    const getSimAtkCC = () => {
      if (!_simAtkCC) _simAtkCC = buildDirectAtk(getSimBd(), _EMPTY, _EMPTY, _EMPTY, _EMPTY);
      return _simAtkCC;
    };

    let logBoost = 0;

    // ── Piece attractors ──────────────────────────────────────────────────────
    // Positive value (right) = boost moves by that piece type.
    if (hasPiece && pieceType) logBoost += (pieceVals[pieceType] || 0) * scale;

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

    // ── Custom controls: metric delta on the simulated board ──────────────────
    // Build the sim attack map once (if any active metric needs it) and reuse it
    // across every control. delta = metric(after) − metric(before); value sign is
    // the direction (right/+ maximizes the metric, left/− minimizes it).
    if (hasCustom) {
      const ccAtk = ccNeedsAtk ? getSimAtkCC() : null;
      for (const c of activeCC) {
        const m = _ccMetrics[c.metric];
        const after = m.fn(getSimBd(), { me: botColorStr, opp: oppColorStr, atk: m.needsAtk ? ccAtk : null });
        const delta = after - c._ccBefore;
        if (delta !== 0) logBoost += c.value * scale * Math.tanh(delta / m.k);
      }
    }

    result[uciMove] = logBoost !== 0 ? prob * Math.exp(logBoost) : prob;
  }
  _attrReweightApplied = true; // personality actually reshaped the distribution
  return _maybeStaleSeek(
    Object.keys(result).length ? result
      : Object.keys(filtered).length ? filtered
      : moveProbs);
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

// ── Conviction pick: 30% argmax / 70% temperature sample ─────────────────────
// A bot with strong opinions shouldn't be a pure dice-roll, but pure argmax
// is exploitably deterministic. Middle ground: 30% of moves it simply plays
// the move its personality ranked highest (argmax over the reweighted
// distribution); the other 70% it temperature-samples for human variety.
// Whichever pick emerges, the Budget acceptance then verifies its real price.
const ARGMAX_PICK_RATE = 0.30;
function pickFromProbs(moveProbs, temperature) {
  const entries = Object.entries(moveProbs);
  if (!entries.length) return null;
  if (Math.random() < ARGMAX_PICK_RATE) {
    let best = entries[0][0], bp = -Infinity;
    for (const [m, p] of entries) { if (p > bp) { bp = p; best = m; } }
    return best;
  }
  return sampleFromProbs(moveProbs, temperature);
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
// Floor = time-pressure floor (botTimePressureMaxDrop / sfPressureLevel).
// (The old blunderLimitCp-derived quality floor is gone — the blunder-limit
// control was removed in favour of the engine-verified CP budget.)
// Time degradation sources (highest priority first):
//   1. Weaponizer active (ahead on clock) → use floor immediately
//   2. cvA pressure curve → spline interpolation in log-time space
//   3. Linear fallback    → original 0–30 s linear ramp
function sfEffectiveLevel(clockMs) {
  const startLevel = parseInt(document.getElementById('sfLevel').value) || 8;

  // ── Time-pressure floor (from r-drop or DOM slider) ───────────────────────
  let floorLevel;
  if (botTimePressureMaxDrop !== null) {
    floorLevel = Math.max(1, startLevel - Math.round(botTimePressureMaxDrop / 50));
  } else {
    floorLevel = parseInt(document.getElementById('sfPressureLevel').value) || 4;
  }

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
// ── Opening familiarity decay ─────────────────────────────────────────────────
// Models the real pattern where players spend less time in familiar opening
// territory and slow down as positions become unfamiliar or recall gets harder.
//
// Returns a familiarity score 0–1 (1 = "know this by heart", 0 = fully on own).
// Applied in botThinkTime() as a think-time multiplier: at peak familiarity the
// bot plays at ~15% of its normal pace; at zero familiarity it's unchanged.
//
// Two sigmoid parameters scale with ELO:
//   threshold — ply depth at which familiarity starts dropping
//               (600→8 plies / ~4 moves, 2600→44 plies / ~22 moves)
//   slope k   — steepness of drop (600→sharp cliff, 2600→gentle slope)
//
// A per-game threshold jitter (sampled once at game start, stored in
// _bookFamiliarityJitter) reflects that lower-rated players have uneven
// book knowledge — they may know one line deeply but nothing else.
let _bookFamiliarityJitter   = 0;    // reset at each new bot game
let _explorerConfidence     = null; // 0-1 when known; null = no data yet this game
let _explorerSurpriseBoost  = 0;    // 0-1; consumed by next botThinkTime() call

// Compute a 0-1 confidence score from an explorer response.
// Uses log10 of total game count: 100 games→0.33, 1K→0.50, 10K→0.67, 1M→1.00.
// A high-confidence position (deeply charted theory) extends the familiarity
// threshold; a low-confidence or off-book position compresses it.
function explorerConfidenceFromData(data) {
  if (!data || !data.moves || !data.moves.length) return 0;
  const totalGames = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
  if (totalGames < 10) return 0;
  return Math.min(1, Math.log10(totalGames) / 6);
}

function botEffectiveElo() {
  // Unified ELO across engine tabs. Maia3/LC modes use maia3SelectedRating
  // directly. SF uses a 1-20 level slider mapped to ~650-2600 ELO.
  if (typeof botTab !== 'undefined' && botTab === 'sf') {
    const lvl = parseInt(document.getElementById('sfLevel')?.value) || 8;
    return Math.round(650 + (lvl - 1) / 19 * 1950); // 1→650, 20→2600
  }
  return (typeof maia3SelectedRating !== 'undefined' && maia3SelectedRating)
    ? maia3SelectedRating : 1500;
}

function openingFamiliarity(plies) {
  const elo = Math.max(600, Math.min(2600, botEffectiveElo()));
  const t   = (elo - 600) / 2000; // 0 at 600, 1 at 2600

  // Threshold: 600→8 plies, 2600→44 plies (linear)
  const baseThreshold = 8 + t * 36;

  // Explorer confidence shifts the threshold: high-confidence deeply-charted
  // theory extends it (+6 plies at conf=1.0); off-book compresses it (-2 plies
  // at conf=0); null (no data yet) leaves it unchanged.
  const confExtension = _explorerConfidence !== null ? _explorerConfidence * 8 - 2 : 0;

  const threshold = baseThreshold + _bookFamiliarityJitter + confExtension;

  // Slope: 600→0.85 (sharp), 2600→0.22 (gentle) (linear)
  const k = 0.85 - t * 0.63;

  return 1 / (1 + Math.exp(k * (plies - threshold)));
}

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

  // ── Opening familiarity decay ─────────────────────────────────────────────
  // botMoveHistory tracks all plies (both sides). Familiarity is highest early
  // in a game when the bot is in known territory, and decays sigmoidally as
  // the position leaves familiar lines. The decay rate and depth both scale
  // with ELO: a 600-rated bot knows ~4 moves; a 2600 bot knows ~22.
  // Explorer confidence extends or compresses the familiarity zone.
  // Multiplier: familiarity=1 → 15% of normal pace; familiarity=0 → unchanged.
  const _fam = openingFamiliarity(botMoveHistory.length);
  if (_fam > 0.02) thinkMs *= (0.15 + 0.85 * (1 - _fam));

  // ── Novelty pause ────────────────────────────────────────────────────────
  // If the human just played a low-frequency move (set by botPostMoveHook after
  // checking the explorer cache), slow down to model the "wait, I didn't expect
  // that" recalibration — even in otherwise-familiar opening territory.
  // Applied after familiarity so it partially overrides the speed savings.
  // _explorerSurpriseBoost is consumed here (fires on this move only).
  if (_explorerSurpriseBoost > 0) {
    thinkMs *= (1 + _explorerSurpriseBoost * 1.5);
    _explorerSurpriseBoost = 0;
  }

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
  // Real move counters, not the frozen "0 1": halfmoveClock is maintained by
  // executeMove; fullmove = played-plies/2 + 1. Maia ignores these, but Stockfish
  // uses the halfmove clock for 50-move awareness and any exported FEN needs them.
  const _fullmove = Math.floor((typeof gameMovesAlgebraic !== 'undefined' ? gameMovesAlgebraic.length : 0) / 2) + 1;
  const fen = boardToFen(board, turn, castling, epSq, halfmoveClock, _fullmove);
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
                  executeMove(mv.from, mv.to, mv.promo || null);
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
        _explorerConfidence = explorerConfidenceFromData(_od);
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
              executeMove(mv.from, mv.to, mv.promo || null);
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
        _explorerConfidence = 0;
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
      // Pure Maia3 — no LC fallback, SF only if model not downloaded.
      // Temperature cascade matches the LC paths, so the panel's Temperature
      // control (and the Hustler phase override) governs every Maia path —
      // previously this read only #maia3Temp, which the old panel derived
      // from the CP Budget, leaving the visible Temperature slider dead here.
      const m3Temp = window._bcpHustlerTempMode
        ? hustlerPhaseTemp()
        : (typeof botMaiaTempValue !== 'undefined' && botMaiaTempValue > 0)
          ? botMaiaTempValue
          : parseFloat(document.getElementById('maia3Temp')?.value || '1.0');
      // Rough think estimate BEFORE inference so the ELO degradation curve
      // uses actual move pace (weaponizer/hustle/fixed included), not the
      // clock/remaining-moves average — same plumbing as the LC paths.
      const m3RoughThinkSec = botThinkTime(null, clockMs) / 1000;
      let m3Probs = null;
      // Kick off SF complexity probe in parallel with Maia inference (separate workers)
      if (_needsComplexity() && !sfReady) sfInit().catch(() => {}); // warm up SF for next move
      const cplxPromise = (_needsComplexity() && sfReady) ? sfGetComplexity(fen) : null;
      if (_maiaReady) {
        const savedRating = lcSelectedRating;
        lcSelectedRating = String(pressureEffectiveMaiaEloByThink(m3RoughThinkSec)); // ELO degradation via ctrlA curve
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
        const effElo = pressureEffectiveMaiaEloByThink(m3RoughThinkSec);
        const allMoves = Object.entries(m3Probs).sort((a,b)=>b[1]-a[1]);
        console.log('[Maia3 FULL] elo:', effElo, 'fen:', fen, 'cplx:', sfCplxScore);
        console.log('[Maia3 FULL] all probs:', allMoves.map(([m,p])=>m+'='+p.toFixed(4)).join(' '));
        const targetDelay = botThinkTime(m3Probs, clockMs);
        const preciseThinkSecM3 = targetDelay / 1000;
        const m3EffTemp = timePressureTempByThink(m3Temp, preciseThinkSecM3);
        const inferenceMs = Date.now() - _botMoveStartMs;
        const delay = Math.max(0, targetDelay - inferenceMs);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        _botMoveClockMs = clockMs; // clock fallback for the ctrlB cutoff
        _botMoveThinkSec = preciseThinkSecM3; // actual think drives curve B
        const adjTemp = complexityAdjustedTemp(m3EffTemp);
        const m3Shaped = applyMoveAttractors(m3Probs);
        uciMove = pickFromProbs(m3Shaped, adjTemp);
        uciMove = await applyCpBudgetAcceptance(fen, uciMove, m3Probs, m3Shaped);
        uciMove = await applyDegradationEvalGuard(fen, uciMove, m3Probs);
        uciMove = await applyHardFloorBackstop(fen, uciMove, m3Probs);
        _botMoveThinkSec = null;
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
          _explorerConfidence = 0;
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
        const maiaShaped = applyMoveAttractors(probs);
        uciMove = pickFromProbs(maiaShaped, complexityAdjustedTemp(effectiveTemp));
        uciMove = await applyCpBudgetAcceptance(fen, uciMove, probs, maiaShaped);
        uciMove = await applyDegradationEvalGuard(fen, uciMove, probs);
        uciMove = await applyHardFloorBackstop(fen, uciMove, probs);
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
      // SF probe in parallel with the explorer fetch — needed here for
      // stalemate-seek and complexity-scaled timing (both live outside the
      // personality section, which is greyed for LC+SF).
      if (_needsComplexity() && !sfReady) sfInit().catch(() => {});
      const cplxPromiseLcsf = (_needsComplexity() && sfReady) ? sfGetComplexity(fen) : null;
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
          _explorerConfidence = 0;
          lcsfProbs = null;
        }
      }
      if (cplxPromiseLcsf) {
        const cr = await cplxPromiseLcsf;
        sfCplxScore = cr ? cr.cplx : null;
        sfCplxEval  = cr ? cr.eval  : null;
      } else if (!_needsComplexity()) {
        sfCplxScore = sfCplxEval = null;
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
        const lcsfShaped = applyMoveAttractors(lcsfProbs);
        uciMove = pickFromProbs(lcsfShaped, lcsfEffTemp);
        uciMove = await applyCpBudgetAcceptance(fen, uciMove, lcsfProbs, lcsfShaped);
        uciMove = await applyDegradationEvalGuard(fen, uciMove, lcsfProbs);
        uciMove = await applyHardFloorBackstop(fen, uciMove, lcsfProbs);
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
          // Same temperature cascade as every other Maia path — the panel
          // promises "the Temperature setting applies to every Maia slot".
          const m3Temp = window._bcpHustlerTempMode
            ? hustlerPhaseTemp()
            : (typeof botMaiaTempValue !== 'undefined' && botMaiaTempValue > 0)
              ? botMaiaTempValue
              : parseFloat(document.getElementById('maia3Temp')?.value || '1.0');
          const slotElo = chosen.elo || (chosen.level ? chosen.level * 200 : maia3SelectedRating);
          // Same think-time plumbing as the other Maia paths: rough estimate
          // drives the slot's curve-A drop; the SF probe (chaos/compwin temp,
          // stalemate-seek, result-gated custom controls, complexity timing)
          // runs in parallel with the inference. sfInit() ran just above.
          const hybRoughThinkSec = botThinkTime(null, clockMs) / 1000;
          const cplxPromiseHyb = (_needsComplexity() && sfReady) ? sfGetComplexity(fen) : null;
          let probs = null;
          if (_maiaReady) {
            const savedRating = lcSelectedRating;
            lcSelectedRating = String(pressureSlotEloByThink(slotElo, hybRoughThinkSec));
            try { probs = await maia3GetMoveProbs(fen); } catch(e) {}
            lcSelectedRating = savedRating;
            if (probs && Object.keys(probs).length) lastBotMoveSource = 'Maia3';
          }
          if (cplxPromiseHyb) {
            const cr = await cplxPromiseHyb;
            sfCplxScore = cr ? cr.cplx : null;
            sfCplxEval  = cr ? cr.eval  : null;
          } else if (!_needsComplexity()) {
            sfCplxScore = sfCplxEval = null;
          }
          if (probs && Object.keys(probs).length) {
            const targetDelay = botThinkTime(probs, clockMs);
            const preciseThinkSecHyb = targetDelay / 1000;
            const effectiveTemp = complexityAdjustedTemp(
              timePressureTempByThink(m3Temp, preciseThinkSecHyb));
            const inferenceMs = Date.now() - _botMoveStartMs;
            const delay = Math.max(0, targetDelay - inferenceMs);
            if (delay > 0) await new Promise(res => setTimeout(res, delay));
            _botMoveClockMs = clockMs;
            _botMoveThinkSec = preciseThinkSecHyb;
            const hybShaped = applyMoveAttractors(probs);
            uciMove = pickFromProbs(hybShaped, effectiveTemp);
            uciMove = await applyCpBudgetAcceptance(fen, uciMove, probs, hybShaped);
            uciMove = await applyDegradationEvalGuard(fen, uciMove, probs);
            uciMove = await applyHardFloorBackstop(fen, uciMove, probs);
            _botMoveThinkSec = null;
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
        executeMove(mv.from, mv.to, mv.promo || null);
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
        } else if (botOfferDraws) {
          // A draw-offering personality checks the position after its move
          setTimeout(botMaybeOfferDraw, 700);
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
        // Explorer surprise detection: was this human move expected?
        // Cache key is botMoveHistory BEFORE the human's move is pushed — this is
        // the exact position the bot last fetched from the explorer (mainline mode).
        // Surprise fires only when the explorer is still active and cache has data.
        if (lichessExplorerActive && botMoveHistory.length > 0) {
          const _preKey = botMoveHistory.join(',');
          const _ed = _openingCache.get(_preKey);
          if (_ed && _ed.moves && _ed.moves.length) {
            const _total = _ed.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
            const _entry = _ed.moves.find(m => m.uci === humanUci);
            const _freq  = _entry && _total > 0
              ? (_entry.white + _entry.draws + _entry.black) / _total : 0;
            // <5%: full surprise; 5-15%: partial; ≥15%: expected (no boost)
            _explorerSurpriseBoost = _freq < 0.05 ? 1.0
              : _freq < 0.15 ? (0.15 - _freq) / 0.10
              : 0;
          }
        }
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

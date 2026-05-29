/**
 * bot-config-panel.js  —  Shared Bot Configuration Module
 * =========================================================
 * Drop this script into blundermind.html (and later buildabot.html) via:
 *   <script src="/bot-config-panel.js"></script>
 *
 * ASSUMPTIONS
 * -----------
 * 1. Host page exposes these globals (already declared in blundermind.html):
 *      botTab, botTimePressure, botPlayerColor, botActive, botThinking,
 *      botHybridSlots, botStartClockMs, maia3SelectedRating, lcSelectedRating,
 *      botMoveHistory, botSanHistory, gameOver, turn,
 *      clockTimeW, clockTimeB, clockControl, botSelectedTC,
 *      openPanel, closeAllPanels, botStart, botStop, botLoadConfig, botSaveConfig,
 *      botSetTab, botSetPlayerColor, botSetBaseMin, botSetIncSec, botSetTC,
 *      botAddHybridSlot, botUpdateHybridTotal, botRenderHybridSlots,
 *      maiaDownloadModel, maiaEloTest, botSetOpeningMode, botSetDeviationResponse,
 *      obPrefSetColor
 * 2. Fonts loaded by host page (or inherited):
 *      Cormorant Garamond, DM Mono, Chakra Petch  (bot_config_ui_3 design language)
 * 3. Host page must call BotConfigPanel.init() after DOM ready.
 * 4. Host page botMakeMove() calls BotConfigPanel.effectiveElo(fracRemaining)
 *    and BotConfigPanel.effectiveTempBoost(fracRemaining) at the top of each move.
 * 5. Host page botThinkTime() calls BotConfigPanel.thinkTimeMs(clockMs, moveProbs).
 * 6. CSS variables from host page (:root) are respected where possible;
 *    panel-internal variables shadow them only inside #botPanel.
 *
 * COORDINATE SYSTEMS
 * ------------------
 * - X axis: think time per move in seconds.
 *     Left edge = startX() = (gameMin*60 + 40*incSec)/40  (Lichess formula)
 *     Right edge = floorX() = max(1, incSec * 0.9) ≥ 1.0
 *   Increasing time → LEFT; decreasing time → RIGHT (matches bot_config_ui_3)
 * - Curve A (Elo): Y domain [baseElo - maxDrop - 50 .. baseElo + 50]
 * - Curve B (Confidence floor): Y domain [minFloor - 1 .. 52]
 * - fracRemaining: 0.0 (clock empty) → 1.0 (full time)
 *   Mapping: fracRemaining = (currentClock - floorX) / (startX - floorX)
 *            clamped to [0, 1]
 *
 * PUBLIC API
 * ----------
 *   BotConfigPanel.init()           — inject HTML+CSS, wire events
 *   BotConfigPanel.effectiveElo(frac)        → number   (Elo to use this move)
 *   BotConfigPanel.effectiveTempBoost(frac)  → number   (extra temperature to add)
 *   BotConfigPanel.thinkTimeMs(clockMs, probs) → number (ms to wait before playing)
 *   BotConfigPanel.getConfig()      → plain object (for save/load)
 *   BotConfigPanel.applyConfig(obj) — restore from saved object
 *   BotConfigPanel.onEngineTabChange(tab) — call when botTab changes externally
 */

const BotConfigPanel = (() => {
  'use strict';

  // ── Panel-internal config constants ─────────────────────────────────────────
  const PAD = { l: 46, r: 12, t: 10, b: 34 };
  const CHART_H = 160; // canvas height px
  const CTRL_POINT_COUNT = 7;
  // Snap Elo curve to nearest 25; floor curve to nearest 1
  const SNAP_ELO = 25;

  // ── Panel state (isolated from host page globals) ────────────────────────────
  // curve control points: [{x: seconds, y: value}] sorted high-to-low x
  let ctrlA = []; // Elo curve
  let ctrlB = []; // Confidence floor curve
  let _curveDirty = false;
  let _dragA = null, _dragB = null;
  let _drawScheduled = false;
  let _resizeTimer = null;

  // Timing mode: 'complexity' | 'steady' | 'timetrouble'
  let timingMode = 'complexity';
  // Can flag toggle
  let canFlag = true;
  // Aware of opponent clock
  let awareOppClock = true;
  // Maia2 mode
  let maia2Mode = false;
  // Tilt mode
  let tiltMode = false;
  // Flagging shuffle strategy
  let flaggingStrategy = false;
  // Selected personality
  let activePersona = null;

  // ── Hybrid engine state ──────────────────────────────────────────────────────
  // Each slot: { id, engineType, rating, sfLevel, weight }
  // engineType: 'maia3' | 'stockfish' | 'lcsf' | 'lcmaia'
  let hybridEngines = [];
  let hybridNextId = 0;

  // ── Engine selector state ────────────────────────────────────────────────────
  // Which top-level engine family is active
  let activeEngine = 'maia3'; // 'maia3'|'stockfish'|'lcsf'|'lcmaia'|'hybrid'

  // ── Personality data ─────────────────────────────────────────────────────────
  const PERSONAS = {
    executioner: {
      name: 'The Executioner',
      icon: '†',
      trait: 'Converts advantages clinically. Plays fast and ruthlessly when winning.',
      tag: 'Pressure',
      curvePreset: 'flat',       // barely degrades
      timingPreset: 'steady',
    },
    clockpsy: {
      name: 'Clock Psychologist',
      icon: '⧗',
      trait: 'Uses time as a weapon. Plays instantly when you are low on clock.',
      tag: 'Clock',
      curvePreset: 'late',       // steep drop only at very end
      timingPreset: 'steady',
    },
    berserker: {
      name: 'The Berserker',
      icon: '⚡',
      trait: 'Sacrifices accuracy for tempo. Always plays fast.',
      tag: 'Aggressive',
      curvePreset: 'early',      // degrades quickly
      timingPreset: 'steady',
    },
    grinder: {
      name: 'Positional Grinder',
      icon: '◈',
      trait: 'Deliberate in complexity. Quick in clear positions.',
      tag: 'Methodical',
      curvePreset: 'sigmoid',    // default sigmoid
      timingPreset: 'complexity',
    },
    blunderer: {
      name: 'The Blunderer',
      icon: '∿',
      trait: 'Plays well then cracks unexpectedly under pressure.',
      tag: 'Human',
      curvePreset: 'cliff',      // fine then sudden drop
      timingPreset: 'timetrouble',
    },
    custom: {
      name: 'Custom',
      icon: '∴',
      trait: 'Build your own curve and timing profile.',
      tag: 'Advanced',
      curvePreset: null,
      timingPreset: null,
    }
  };

  // ── Curve presets ─────────────────────────────────────────────────────────────
  // Returns normalized [0..1] y values for 7 control points (left→right = high→low time)
  function curvePresetY(preset) {
    switch (preset) {
      case 'flat':       return [1.0, 0.98, 0.96, 0.94, 0.92, 0.90, 0.88];
      case 'late':       return [1.0, 1.0,  0.99, 0.97, 0.85, 0.60, 0.30];
      case 'early':      return [0.85, 0.70, 0.55, 0.42, 0.32, 0.24, 0.18];
      case 'cliff':      return [1.0, 1.0,  0.99, 0.95, 0.60, 0.25, 0.10];
      case 'sigmoid':
      default:           return [1.0, 0.98, 0.93, 0.72, 0.28, 0.07, 0.02];
    }
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────────
  function startX() {
    const min = parseFloat(document.getElementById('bcp-gametime')?.value || 5);
    const inc = parseFloat(document.getElementById('bcp-increment')?.value || 0);
    return +((min * 60 + 40 * inc) / 40).toFixed(2);
  }
  function floorX() {
    const inc = parseFloat(document.getElementById('bcp-increment')?.value || 0);
    return Math.max(1.0, inc * 0.9);
  }
  function baseElo() {
    return parseFloat(document.getElementById('bcp-baseelo')?.value || 1500);
  }
  function maxDrop() {
    return parseFloat(document.getElementById('bcp-maxdrop')?.value || 300);
  }
  function minFloor() {
    return parseFloat(document.getElementById('bcp-floor')?.value || 5);
  }

  // Build 71 evenly spaced x values from startX → floorX (high time left → low)
  function buildXs() {
    const tMax = startX(), tMin = floorX();
    const xs = [];
    for (let i = 0; i <= 70; i++) xs.push(+(tMax - (tMax - tMin) * (i / 70)).toFixed(3));
    return xs;
  }

  // ── Sigmoid baseline ─────────────────────────────────────────────────────────
  // frac = (t - tMin) / (tMax - tMin)  [0=no time, 1=full time]
  function sigA(t) {
    const tMax = startX(), tMin = floorX();
    const frac = (t - tMin) / Math.max(0.001, tMax - tMin);
    const drop = maxDrop(), elo = baseElo();
    return Math.round(elo - drop / (1 + Math.exp(10 * (frac - 0.15))));
  }
  function sigB(t) {
    const tMax = startX(), tMin = floorX();
    const frac = (t - tMin) / Math.max(0.001, tMax - tMin);
    const mf = minFloor();
    return Math.round(50 - (50 - mf) / (1 + Math.exp(10 * (frac - 0.15))));
  }

  // ── Hermite (smoothstep) interpolation between control points ────────────────
  // xs: array of x values to evaluate; ctrl: [{x, y}] sorted descending by x
  function hermite(xs, ctrl) {
    const cp = [...ctrl].sort((a, b) => b.x - a.x);
    return xs.map(x => {
      let lo = cp[cp.length - 1], hi = cp[0];
      for (let i = 0; i < cp.length - 1; i++) {
        if (x <= cp[i].x && x >= cp[i + 1].x) { hi = cp[i]; lo = cp[i + 1]; break; }
      }
      if (Math.abs(hi.x - lo.x) < 0.001) return lo.y;
      const t = (x - lo.x) / (hi.x - lo.x);
      const s = t * t * (3 - 2 * t); // smoothstep
      return Math.round(lo.y + s * (hi.y - lo.y));
    });
  }

  // ── Init control points from sigmoid or preset ────────────────────────────────
  function initPts(presetName) {
    const xs = buildXs();
    const idxs = [0, 10, 20, 30, 42, 56, 70];
    if (presetName && presetName !== 'sigmoid') {
      const fracY = curvePresetY(presetName);
      const elo = baseElo(), drop = maxDrop();
      const mf = minFloor();
      ctrlA = idxs.map((idx, i) => ({
        x: xs[Math.min(idx, 70)],
        y: Math.round(elo - drop * (1 - fracY[i]))
      }));
      ctrlB = idxs.map((idx, i) => ({
        x: xs[Math.min(idx, 70)],
        y: Math.round(mf + (50 - mf) * fracY[i])
      }));
    } else {
      // Default sigmoid
      ctrlA = idxs.map(idx => ({ x: xs[Math.min(idx, 70)], y: sigA(xs[Math.min(idx, 70)]) }));
      ctrlB = idxs.map(idx => ({ x: xs[Math.min(idx, 70)], y: sigB(xs[Math.min(idx, 70)]) }));
    }
    _curveDirty = false;
  }

  // ── PUBLIC: Effective Elo for current move ────────────────────────────────────
  // frac: 0.0 (flagging) → 1.0 (full time). Returns Elo to pass to Maia.
  function effectiveElo(frac) {
    if (!ctrlA.length) return baseElo();
    const xs = buildXs();
    const tMax = startX(), tMin = floorX();
    // Convert frac → seconds
    const t = tMin + frac * (tMax - tMin);
    const vals = hermite([t], ctrlA);
    return Math.max(600, Math.min(2600, vals[0]));
  }

  // ── PUBLIC: Confidence floor boost ───────────────────────────────────────────
  // Returns extra temperature to add (0 at full time, larger when low on clock)
  // Confidence floor = minimum probability mass given to lower-ranked moves.
  // We map floor% → temperature boost: floor 5% → +0, floor 50% → +2.0
  function effectiveTempBoost(frac) {
    if (!ctrlB.length) return 0;
    const xs = buildXs();
    const tMax = startX(), tMin = floorX();
    const t = tMin + frac * (tMax - tMin);
    const floorPct = hermite([t], ctrlB)[0]; // 5..50
    // Normalize: 5% floor → 0 boost; 50% floor → 2.0 boost
    return Math.max(0, (floorPct - minFloor()) / (50 - minFloor()) * 2.0);
  }

  // ── PUBLIC: Think time computation (replaces botThinkTime) ───────────────────
  // Returns milliseconds to wait before playing the move.
  // Dependencies: timingMode, canFlag, fracRemaining, positionEntropy
  function thinkTimeMs(clockMs, moveProbs) {
    const gameMins = parseFloat(document.getElementById('bcp-gametime')?.value || 5);
    const incSec   = parseFloat(document.getElementById('bcp-increment')?.value || 0);
    const estMovesLeft = 40; // standard estimate
    const totalSec = gameMins * 60;

    // Base think time: clock / estimated_moves_left + increment  (Lichess formula)
    let baseSec;
    if (clockMs !== null && clockMs > 0) {
      baseSec = (clockMs / 1000) / estMovesLeft + incSec;
    } else {
      baseSec = totalSec / estMovesLeft + incSec;
    }
    baseSec = Math.max(0.5, Math.min(baseSec, 15));

    let thinkMs;

    if (timingMode === 'steady') {
      // Robotic: near-constant, very low variance
      thinkMs = baseSec * 1000 * (0.9 + Math.random() * 0.2);

    } else if (timingMode === 'complexity') {
      // Scale with position entropy
      const entropy = moveProbs ? positionEntropy(moveProbs) : 2;
      const complexity = Math.min(1 + entropy * 0.35, 2.5); // 1.0 → 2.5×
      thinkMs = baseSec * complexity * 1000 * (0.8 + Math.random() * 0.4);

    } else if (timingMode === 'timetrouble') {
      // Spend extra early, scramble late
      if (clockMs !== null && clockMs < 20000) {
        // Panic: use at most 5% of remaining
        thinkMs = Math.min(baseSec * 500, clockMs * 0.05);
      } else {
        // Early game: think 1.5× longer
        const entropy = moveProbs ? positionEntropy(moveProbs) : 2;
        const complexity = Math.min(1 + entropy * 0.35, 2.5);
        thinkMs = baseSec * complexity * 1.5 * 1000 * (0.8 + Math.random() * 0.4);
      }
    } else {
      thinkMs = baseSec * 1000;
    }

    // Hard cap: never spend more than 12% of remaining clock
    if (clockMs !== null && clockMs > 0) {
      thinkMs = Math.min(thinkMs, clockMs * 0.12);
    }

    // canFlag floor: if can't flag, always leave at least 0.1s on clock
    if (!canFlag && clockMs !== null && clockMs > 100) {
      thinkMs = Math.min(thinkMs, clockMs - 100);
    }

    return Math.max(150, Math.min(8000, thinkMs));
  }

  // ── Entropy helper (mirrors host page positionEntropy) ───────────────────────
  function positionEntropy(moveProbs) {
    let e = 0;
    for (const p of Object.values(moveProbs)) {
      if (p > 0) e -= p * Math.log2(p);
    }
    return e;
  }

  // ── PUBLIC: getConfig / applyConfig ─────────────────────────────────────────
  function getConfig() {
    return {
      version: 2,
      engine: activeEngine,
      baseElo: baseElo(),
      maxDrop: maxDrop(),
      minFloor: minFloor(),
      gameMins: parseFloat(document.getElementById('bcp-gametime')?.value || 5),
      incSec: parseFloat(document.getElementById('bcp-increment')?.value || 0),
      ctrlA: ctrlA.map(p => ({ x: p.x, y: p.y })),
      ctrlB: ctrlB.map(p => ({ x: p.x, y: p.y })),
      timingMode,
      canFlag,
      awareOppClock,
      maia2Mode,
      tiltMode,
      flaggingStrategy,
      persona: activePersona,
      hybridEngines: hybridEngines.map(e => ({ ...e })),
      sfLevel: parseInt(document.getElementById('sfLevel')?.value || 8),
      sfPressureLevel: parseInt(document.getElementById('sfPressureLevel')?.value || 4),
      maia3Rating: typeof maia3SelectedRating !== 'undefined' ? maia3SelectedRating : 1200,
    };
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    if (cfg.baseElo && document.getElementById('bcp-baseelo')) {
      document.getElementById('bcp-baseelo').value = cfg.baseElo;
      document.getElementById('bcp-baseelo-val').textContent = cfg.baseElo;
    }
    if (cfg.maxDrop && document.getElementById('bcp-maxdrop')) {
      document.getElementById('bcp-maxdrop').value = cfg.maxDrop;
      document.getElementById('bcp-maxdrop-val').textContent = cfg.maxDrop + ' Elo';
    }
    if (cfg.gameMins && document.getElementById('bcp-gametime')) {
      document.getElementById('bcp-gametime').value = cfg.gameMins;
      document.getElementById('bcp-gametime-val').textContent = cfg.gameMins + ' min';
    }
    if (cfg.incSec !== undefined && document.getElementById('bcp-increment')) {
      document.getElementById('bcp-increment').value = cfg.incSec;
      document.getElementById('bcp-increment-val').textContent = cfg.incSec + 's';
    }
    if (cfg.ctrlA && cfg.ctrlA.length) { ctrlA = cfg.ctrlA; ctrlB = cfg.ctrlB || ctrlB; }
    else { initPts(); }
    if (cfg.timingMode) { timingMode = cfg.timingMode; _selectTimingMode(cfg.timingMode); }
    if (cfg.canFlag !== undefined) { canFlag = cfg.canFlag; _syncToggle('bcp-toggle-canflag', canFlag); }
    if (cfg.awareOppClock !== undefined) { awareOppClock = cfg.awareOppClock; _syncToggle('bcp-toggle-oppclock', awareOppClock); }
    if (cfg.tiltMode !== undefined) { tiltMode = cfg.tiltMode; _syncToggle('bcp-toggle-tilt', tiltMode); }
    if (cfg.hybridEngines && cfg.hybridEngines.length) {
      hybridEngines = cfg.hybridEngines;
      _renderHybridEngines();
    }
    scheduleDraw();
  }

  function _syncToggle(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  }

  // ── HTML injection ────────────────────────────────────────────────────────────
  function _buildHTML() {
    return `
<!-- BCP: Bot Config Panel v2 — injected by bot-config-panel.js -->
<style id="bcp-styles">
/* Scoped inside #botPanel to avoid leaking into host page */
#botPanel {
  --bcp-bg: var(--bg-panel, #1c1f24);
  --bcp-bg2: var(--bg-panel2, #22262d);
  --bcp-bg3: #14161a;
  --bcp-amber: #c8922a;
  --bcp-amber-b: #e8aa40;
  --bcp-amber-dim: #8a6420;
  --bcp-amber-glow: rgba(200,146,42,0.12);
  --bcp-amber-glow-s: rgba(200,146,42,0.22);
  --bcp-border: rgba(255,255,255,0.06);
  --bcp-border-a: rgba(200,146,42,0.3);
  --bcp-steel: #4a5568;
  --bcp-steel-l: #6b7a94;
  --bcp-text: var(--text-primary, #e8e6e0);
  --bcp-text2: var(--text-secondary, #8a8f9a);
  --bcp-text3: var(--text-dim, #4a5060);
  --bcp-r: 3px;
  --bcp-font-d: 'Cormorant Garamond', Georgia, serif;
  --bcp-font-m: 'DM Mono', 'Courier New', monospace;
  --bcp-font-u: 'Chakra Petch', system-ui, sans-serif;
}

/* ── Panel body overrides ── */
#botPanel .panel-body { padding: 0; font-family: var(--bcp-font-u); }

/* ── Start strip ── */
#bcp-start-strip {
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--bcp-border-a);
  display: flex; gap: 8px; align-items: center;
  background: var(--bcp-bg3);
  position: sticky; top: 0; z-index: 10;
}
#bcp-start-btn {
  flex: 1; padding: 9px 14px;
  font-family: var(--bcp-font-u); font-size: 11px; font-weight: 500;
  letter-spacing: 0.1em; text-transform: uppercase;
  background: linear-gradient(135deg, rgba(200,146,42,0.18), rgba(200,146,42,0.08));
  border: 0.5px solid var(--bcp-amber); border-radius: var(--bcp-r);
  color: var(--bcp-amber-b); cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
  position: relative; overflow: hidden;
}
#bcp-start-btn::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(200,146,42,0.12), transparent);
  opacity: 0; transition: opacity 0.2s;
}
#bcp-start-btn:hover::before { opacity: 1; }
#bcp-start-btn:hover { box-shadow: 0 0 16px rgba(200,146,42,0.25); }
#bcp-stop-btn {
  padding: 9px 12px;
  font-family: var(--bcp-font-u); font-size: 10px;
  background: rgba(200,40,40,0.08); border: 0.5px solid rgba(200,40,40,0.3);
  border-radius: var(--bcp-r); color: #c84040; cursor: pointer;
  display: none; letter-spacing: 0.06em;
  transition: background 0.2s;
}
#bcp-stop-btn:hover { background: rgba(200,40,40,0.15); }
#bcp-status {
  font-family: var(--bcp-font-m); font-size: 9px;
  color: var(--bcp-amber); letter-spacing: 0.08em;
  min-height: 12px; text-align: center;
  padding: 0 16px 8px;
}

/* ── Engine selector header pill ── */
#bcp-engine-pill {
  margin: 14px 16px 0;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); cursor: pointer;
  transition: border-color 0.2s;
  position: relative;
}
#bcp-engine-pill:hover { border-color: var(--bcp-border-a); }
#bcp-engine-pill-label {
  font-family: var(--bcp-font-m); font-size: 9px;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bcp-text3);
}
#bcp-engine-pill-name {
  font-family: var(--bcp-font-u); font-size: 11px; font-weight: 500;
  letter-spacing: 0.07em; color: var(--bcp-text); flex: 1;
}
#bcp-engine-pill-badge {
  font-family: var(--bcp-font-m); font-size: 9px;
  color: var(--bcp-amber); padding: 2px 7px;
  border: 0.5px solid var(--bcp-border-a); border-radius: 2px;
  background: var(--bcp-amber-glow); white-space: nowrap;
}
#bcp-engine-pill-chevron {
  width: 12px; height: 12px; flex-shrink: 0;
  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
}
#bcp-engine-pill-chevron path {
  stroke: var(--bcp-steel-l); fill: none;
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
}
#bcp-engine-pill.open #bcp-engine-pill-chevron { transform: rotate(180deg); }

/* ── Engine drawer ── */
#bcp-engine-drawer {
  max-height: 0; overflow: hidden;
  transition: max-height 0.4s cubic-bezier(0.4,0,0.2,1);
  margin: 0 16px;
}
#bcp-engine-drawer.open { max-height: 800px; }
#bcp-engine-drawer-inner {
  padding: 14px 14px 10px;
  background: var(--bcp-bg3); border: 0.5px solid var(--bcp-border-a);
  border-top: none; border-radius: 0 0 var(--bcp-r) var(--bcp-r);
}

/* Engine cards grid */
.bcp-eng-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
  margin-bottom: 10px;
}
.bcp-eng-card {
  padding: 10px 11px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.bcp-eng-card:hover { border-color: var(--bcp-border-a); }
.bcp-eng-card.sel {
  border-color: var(--bcp-amber);
  background: rgba(200,146,42,0.07);
}
.bcp-eng-dot {
  width: 5px; height: 5px; border-radius: 50%;
  border: 1px solid var(--bcp-steel); margin-bottom: 6px;
  transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
}
.bcp-eng-card.sel .bcp-eng-dot {
  background: var(--bcp-amber); border-color: var(--bcp-amber);
  box-shadow: 0 0 6px var(--bcp-amber-glow-s);
}
.bcp-eng-name {
  font-family: var(--bcp-font-u); font-size: 9px; font-weight: 500;
  letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--bcp-text2); transition: color 0.2s; line-height: 1.4;
}
.bcp-eng-card.sel .bcp-eng-name { color: var(--bcp-text); }
.bcp-eng-desc {
  font-family: var(--bcp-font-m); font-size: 8px;
  color: var(--bcp-text3); margin-top: 2px; line-height: 1.5;
}

/* Engine sub-settings (appear below cards when engine selected) */
#bcp-eng-subsettings {
  border-top: 0.5px solid var(--bcp-border);
  padding-top: 10px; margin-top: 4px;
}
.bcp-eng-sub { display: none; }
.bcp-eng-sub.active { display: block; }

/* Rating chips */
.bcp-rating-chips {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;
}
.bcp-rating-chip {
  font-family: var(--bcp-font-m); font-size: 9px;
  padding: 3px 7px; border-radius: 2px;
  border: 0.5px solid var(--bcp-border); background: var(--bcp-bg2);
  color: var(--bcp-text3); cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.bcp-rating-chip.sel {
  border-color: var(--bcp-amber); color: var(--bcp-amber-b);
  background: var(--bcp-amber-glow);
}
.bcp-rating-chip:hover { border-color: var(--bcp-border-a); color: var(--bcp-text2); }

/* Maia download box */
.bcp-download-box {
  margin-top: 10px; padding: 10px 12px;
  background: rgba(90,212,144,0.05); border: 0.5px solid rgba(90,212,144,0.18);
  border-radius: var(--bcp-r);
}
.bcp-download-box p {
  font-family: var(--bcp-font-m); font-size: 8.5px;
  color: var(--bcp-text2); line-height: 1.7; margin-bottom: 8px;
}
.bcp-download-btn {
  width: 100%; padding: 7px;
  font-family: var(--bcp-font-u); font-size: 9px; font-weight: 500;
  letter-spacing: 0.08em;
  background: rgba(90,212,144,0.1); border: 0.5px solid #22a85a;
  border-radius: var(--bcp-r); color: #5ad490; cursor: pointer;
  transition: background 0.2s;
}
.bcp-download-btn:hover { background: rgba(90,212,144,0.18); }
#bcp-maia-status-text, #bcp-maia-status-text2 {
  font-family: var(--bcp-font-m); font-size: 8px;
  color: var(--bcp-text3); margin-top: 4px;
}

/* SF level display */
.bcp-sf-display {
  margin-top: 8px; padding: 8px 10px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r);
  font-family: var(--bcp-font-m); font-size: 9px; color: var(--bcp-text3);
}
.bcp-sf-level-big {
  font-size: 28px; font-family: var(--bcp-font-d); font-style: italic;
  color: var(--bcp-amber-b); line-height: 1; display: block; margin-bottom: 2px;
}

/* Hybrid engines */
#bcp-hybrid-list { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.bcp-hybrid-row {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r);
}
.bcp-hybrid-type {
  font-family: var(--bcp-font-u); font-size: 9px; letter-spacing: 0.06em;
  color: var(--bcp-amber); flex-shrink: 0; min-width: 52px;
}
.bcp-hybrid-pct {
  font-family: var(--bcp-font-m); font-size: 12px; font-weight: 500;
  color: var(--bcp-amber-b); min-width: 36px; text-align: right; flex-shrink: 0;
}
.bcp-hybrid-slider {
  flex: 1;
}
.bcp-hybrid-rm {
  font-family: var(--bcp-font-m); font-size: 10px;
  background: none; border: none; color: var(--bcp-text3);
  cursor: pointer; padding: 0 4px; flex-shrink: 0;
  transition: color 0.15s;
}
.bcp-hybrid-rm:hover { color: #c84040; }
.bcp-hybrid-total {
  font-family: var(--bcp-font-m); font-size: 9px;
  color: var(--bcp-text3); text-align: right; margin-top: 6px;
  letter-spacing: 0.08em;
}
.bcp-add-engine-btn {
  width: 100%; margin-top: 6px; padding: 7px;
  font-family: var(--bcp-font-m); font-size: 9px; letter-spacing: 0.08em;
  background: rgba(74,159,212,0.06); border: 0.5px dashed rgba(74,159,212,0.35);
  border-radius: var(--bcp-r); color: #4a9fd4; cursor: pointer;
  transition: background 0.2s;
}
.bcp-add-engine-btn:hover { background: rgba(74,159,212,0.12); }

/* ── Accordion sections ── */
.bcp-section {
  margin: 8px 16px 0;
  opacity: 0; animation: bcpFadeUp 0.4s ease forwards;
}
.bcp-section:nth-child(1) { animation-delay: 0.05s; }
.bcp-section:nth-child(2) { animation-delay: 0.12s; }
.bcp-section:nth-child(3) { animation-delay: 0.19s; }
.bcp-section:nth-child(4) { animation-delay: 0.26s; }

.bcp-sec-trigger {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); cursor: pointer; user-select: none;
  transition: border-color 0.2s, background 0.2s;
  position: relative; overflow: hidden;
}
.bcp-sec-trigger::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--bcp-amber); transform: scaleY(0); transform-origin: bottom;
  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
}
.bcp-sec-trigger:hover { border-color: var(--bcp-border-a); }
.bcp-sec-trigger:hover::before,
.bcp-section.open .bcp-sec-trigger::before { transform: scaleY(1); }
.bcp-section.open .bcp-sec-trigger {
  border-color: var(--bcp-border-a); background: var(--bcp-bg3);
  border-radius: var(--bcp-r) var(--bcp-r) 0 0;
}

.bcp-sec-icon {
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bcp-bg3); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); flex-shrink: 0;
}
.bcp-sec-icon svg { width: 13px; height: 13px; stroke: var(--bcp-amber); fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.bcp-sec-labels { flex: 1; }
.bcp-sec-label { font-family: var(--bcp-font-u); font-size: 10px; font-weight: 500; letter-spacing: 0.09em; text-transform: uppercase; }
.bcp-sec-sub { font-family: var(--bcp-font-m); font-size: 9px; color: var(--bcp-text2); margin-top: 1px; }
.bcp-sec-status { font-family: var(--bcp-font-m); font-size: 9px; color: var(--bcp-amber); letter-spacing: 0.05em; padding: 2px 7px; border: 0.5px solid var(--bcp-border-a); border-radius: 2px; background: var(--bcp-amber-glow); white-space: nowrap; }
.bcp-chevron { width: 12px; height: 12px; flex-shrink: 0; transition: transform 0.3s cubic-bezier(0.4,0,0.2,1); }
.bcp-chevron path { stroke: var(--bcp-steel-l); fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.bcp-section.open .bcp-chevron { transform: rotate(180deg); }

/* Panel shell */
.bcp-panel-shell { max-height: 0; overflow: hidden; transition: max-height 0.45s cubic-bezier(0.4,0,0.2,1); }
.bcp-section.open .bcp-panel-shell { max-height: 2000px; }
.bcp-panel {
  background: var(--bcp-bg3); border: 0.5px solid var(--bcp-border-a);
  border-top: none; border-radius: 0 0 var(--bcp-r) var(--bcp-r);
  padding: 16px 16px 20px;
}

/* Staggered row fade */
.bcp-pr { opacity: 0; transform: translateY(4px); transition: opacity 0.25s ease, transform 0.25s ease; }
.bcp-section.open .bcp-pr:nth-child(1) { opacity:1; transform:none; transition-delay:0.08s; }
.bcp-section.open .bcp-pr:nth-child(2) { opacity:1; transform:none; transition-delay:0.14s; }
.bcp-section.open .bcp-pr:nth-child(3) { opacity:1; transform:none; transition-delay:0.20s; }
.bcp-section.open .bcp-pr:nth-child(4) { opacity:1; transform:none; transition-delay:0.26s; }
.bcp-section.open .bcp-pr:nth-child(5) { opacity:1; transform:none; transition-delay:0.32s; }
.bcp-section.open .bcp-pr:nth-child(6) { opacity:1; transform:none; transition-delay:0.38s; }

/* Controls */
.bcp-dlbl {
  display: flex; align-items: center; gap: 8px;
  margin: 14px 0 10px;
}
.bcp-dlbl span {
  font-family: var(--bcp-font-m); font-size: 8px;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bcp-text3); white-space: nowrap;
}
.bcp-dlbl::before, .bcp-dlbl::after { content: ''; flex: 1; height: 0.5px; background: var(--bcp-border); }

.bcp-ctrl { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.bcp-ctrl-lbl { font-family: var(--bcp-font-m); font-size: 9px; letter-spacing: 0.05em; color: var(--bcp-text2); min-width: 86px; text-transform: uppercase; }
.bcp-ctrl-val { font-family: var(--bcp-font-m); font-size: 10px; color: var(--bcp-amber-b); min-width: 44px; text-align: right; }

/* Sliders */
#botPanel input[type=range] {
  -webkit-appearance: none; appearance: none;
  flex: 1; height: 2px; background: var(--bcp-bg); border-radius: 1px;
  outline: none; cursor: pointer;
  background: linear-gradient(to right, var(--bcp-amber-dim) 0%, var(--bcp-amber-dim) var(--bcp-fill, 0%), var(--bcp-bg2) var(--bcp-fill, 0%), var(--bcp-bg2) 100%);
}
#botPanel input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
  background: var(--bcp-bg3); border: 1.5px solid var(--bcp-amber);
  box-shadow: 0 0 6px var(--bcp-amber-glow-s); cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
#botPanel input[type=range]::-webkit-slider-thumb:hover {
  border-color: var(--bcp-amber-b); box-shadow: 0 0 12px rgba(232,170,64,0.4);
  transform: scale(1.15);
}
#botPanel input[type=range]::-webkit-slider-thumb:active { cursor: grabbing; }

/* Mode cards */
.bcp-mode-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; margin-bottom: 2px; }
.bcp-mode-grid-2 { grid-template-columns: 1fr 1fr; }
.bcp-mcard {
  padding: 9px 10px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.bcp-mcard:hover { border-color: var(--bcp-border-a); }
.bcp-mcard.sel { border-color: var(--bcp-amber); background: rgba(200,146,42,0.07); }
.bcp-mdot { width: 5px; height: 5px; border-radius: 50%; border: 1px solid var(--bcp-steel); margin-bottom: 5px; transition: background 0.2s, border-color 0.2s, box-shadow 0.2s; }
.bcp-mcard.sel .bcp-mdot { background: var(--bcp-amber); border-color: var(--bcp-amber); box-shadow: 0 0 5px var(--bcp-amber-glow-s); }
.bcp-mname { font-family: var(--bcp-font-u); font-size: 9px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--bcp-text2); transition: color 0.2s; line-height: 1.3; }
.bcp-mcard.sel .bcp-mname { color: var(--bcp-text); }
.bcp-mdesc { font-family: var(--bcp-font-m); font-size: 8px; color: var(--bcp-text3); margin-top: 2px; line-height: 1.5; }

/* Toggles */
.bcp-tog-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; border-bottom: 0.5px solid var(--bcp-border);
}
.bcp-tog-row:last-child { border-bottom: none; }
.bcp-tog-lbl { font-family: var(--bcp-font-m); font-size: 9px; letter-spacing: 0.05em; color: var(--bcp-text2); text-transform: uppercase; }
.bcp-tog-desc { font-family: var(--bcp-font-m); font-size: 8px; color: var(--bcp-text3); margin-top: 1px; }
.bcp-tog { position: relative; width: 32px; height: 17px; flex-shrink: 0; }
.bcp-tog input { opacity: 0; width: 0; height: 0; }
.bcp-tog-track {
  position: absolute; inset: 0;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-steel);
  border-radius: 8px; cursor: pointer;
  transition: background 0.25s, border-color 0.25s;
}
.bcp-tog input:checked ~ .bcp-tog-track { background: var(--bcp-amber-dim); border-color: var(--bcp-amber); }
.bcp-tog-thumb {
  position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
  background: var(--bcp-steel); border-radius: 50%; pointer-events: none;
  transition: transform 0.25s cubic-bezier(0.4,0,0.2,1), background 0.25s, box-shadow 0.25s;
}
.bcp-tog input:checked ~ .bcp-tog-track .bcp-tog-thumb {
  transform: translateX(15px); background: var(--bcp-amber-b);
  box-shadow: 0 0 6px rgba(232,170,64,0.5);
}

/* Chart */
.bcp-chart-box {
  margin-top: 2px; padding: 12px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); position: relative;
}
.bcp-chart-title {
  font-family: var(--bcp-font-m); font-size: 8px;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--bcp-text3); margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
.bcp-chart-title::after { content: ''; flex: 1; height: 0.5px; background: var(--bcp-border); }
#bcp-cvA, #bcp-cvB { display: block; background: transparent; cursor: ns-resize; }
.bcp-ctip {
  position: absolute; background: var(--bcp-bg3);
  border: 0.5px solid var(--bcp-border-a); border-radius: 2px;
  padding: 2px 7px; font-family: var(--bcp-font-m); font-size: 9px;
  color: var(--bcp-amber-b); pointer-events: none; display: none;
  white-space: nowrap; z-index: 10;
}

/* Stats strip */
.bcp-stats { display: flex; gap: 1px; margin-top: 8px; }
.bcp-stat {
  flex: 1; background: var(--bcp-bg2); padding: 6px 8px;
  border: 0.5px solid var(--bcp-border);
}
.bcp-stat:first-child { border-radius: var(--bcp-r) 0 0 var(--bcp-r); }
.bcp-stat:last-child { border-radius: 0 var(--bcp-r) var(--bcp-r) 0; }
.bcp-stat-l { font-family: var(--bcp-font-m); font-size: 8px; color: var(--bcp-text3); letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 1px; }
.bcp-stat-v { font-family: var(--bcp-font-m); font-size: 12px; color: var(--bcp-amber-b); }

/* Persona grid */
.bcp-persona-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
.bcp-pcard {
  padding: 11px 10px; background: var(--bcp-bg2);
  border: 0.5px solid var(--bcp-border); border-radius: var(--bcp-r);
  cursor: pointer; transition: border-color 0.2s, background 0.2s;
}
.bcp-pcard:hover { border-color: var(--bcp-border-a); }
.bcp-pcard.sel { border-color: var(--bcp-amber); background: rgba(200,146,42,0.07); }
.bcp-picon { font-family: var(--bcp-font-d); font-size: 18px; font-weight: 300; font-style: italic; color: var(--bcp-amber-dim); margin-bottom: 5px; transition: color 0.2s; }
.bcp-pcard.sel .bcp-picon { color: var(--bcp-amber-b); }
.bcp-pname { font-family: var(--bcp-font-u); font-size: 8.5px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--bcp-text2); margin-bottom: 2px; transition: color 0.2s; }
.bcp-pcard.sel .bcp-pname { color: var(--bcp-text); }
.bcp-ptrait { font-family: var(--bcp-font-m); font-size: 8px; color: var(--bcp-text3); line-height: 1.5; }
.bcp-ptag { display: inline-block; margin-top: 5px; font-family: var(--bcp-font-m); font-size: 7px; letter-spacing: 0.09em; text-transform: uppercase; padding: 2px 5px; border-radius: 2px; border: 0.5px solid var(--bcp-border); color: var(--bcp-text3); }
.bcp-pcard.sel .bcp-ptag { border-color: var(--bcp-border-a); color: var(--bcp-amber); background: var(--bcp-amber-glow); }

/* Persona detail sub-panel */
.bcp-sub-panel {
  margin-top: 10px; padding: 12px 13px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-left: 2px solid var(--bcp-amber-dim); border-radius: var(--bcp-r);
  display: none;
}
.bcp-sub-panel.vis { display: block; }
.bcp-sub-title { font-family: var(--bcp-font-m); font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--bcp-amber-dim); margin-bottom: 7px; }
.bcp-sub-body { font-family: var(--bcp-font-m); font-size: 9px; color: var(--bcp-text2); line-height: 1.9; white-space: pre-line; }

/* Bottom strip */
#bcp-bottom-strip {
  margin: 10px 16px 16px;
  padding-top: 10px; border-top: 0.5px solid var(--bcp-border);
  display: flex; flex-direction: column; gap: 6px;
}
.bcp-bottom-row { display: flex; gap: 6px; }
.bcp-util-btn {
  flex: 1; padding: 7px; text-align: center;
  font-family: var(--bcp-font-u); font-size: 8.5px; font-weight: 500;
  letter-spacing: 0.08em; text-transform: uppercase;
  border-radius: var(--bcp-r); cursor: pointer;
  transition: background 0.2s;
}
.bcp-save-btn { background: rgba(200,146,42,0.08); border: 0.5px solid rgba(200,146,42,0.3); color: var(--bcp-amber); }
.bcp-save-btn:hover { background: rgba(200,146,42,0.15); }
.bcp-load-btn { background: rgba(74,159,212,0.08); border: 0.5px solid rgba(74,159,212,0.3); color: #4a9fd4; }
.bcp-load-btn:hover { background: rgba(74,159,212,0.15); }
.bcp-name-input {
  width: 100%; padding: 6px 10px;
  font-family: var(--bcp-font-m); font-size: 9px;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); color: var(--bcp-text);
  letter-spacing: 0.04em; box-sizing: border-box;
  transition: border-color 0.15s;
}
.bcp-name-input:focus { outline: none; border-color: var(--bcp-border-a); }
.bcp-name-input::placeholder { color: var(--bcp-text3); }

/* Ghost pieces row */
.bcp-ghost-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0;
}
.bcp-ghost-lbl { font-family: var(--bcp-font-m); font-size: 9px; color: var(--bcp-text2); letter-spacing: 0.05em; text-transform: uppercase; }

/* Player color & TC rows */
.bcp-color-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; margin-bottom: 8px; }
.bcp-color-btn, .bcp-tc-btn {
  padding: 6px; text-align: center;
  font-family: var(--bcp-font-m); font-size: 9px; letter-spacing: 0.05em;
  background: var(--bcp-bg2); border: 0.5px solid var(--bcp-border);
  border-radius: var(--bcp-r); cursor: pointer; color: var(--bcp-text2);
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.bcp-color-btn:hover, .bcp-tc-btn:hover { border-color: var(--bcp-border-a); }
.bcp-color-btn.sel, .bcp-tc-btn.sel {
  border-color: var(--bcp-amber); color: var(--bcp-amber-b);
  background: var(--bcp-amber-glow);
}
.bcp-tc-chips { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px; }

/* TC + Opening in bottom accordion */
.bcp-small-section { margin-bottom: 6px; }
.bcp-small-label { font-family: var(--bcp-font-m); font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--bcp-text3); margin-bottom: 5px; }

@keyframes bcpFadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Scrollbar inside panel */
#botPanel .panel-body::-webkit-scrollbar { width: 3px; }
#botPanel .panel-body::-webkit-scrollbar-track { background: transparent; }
#botPanel .panel-body::-webkit-scrollbar-thumb { background: var(--bcp-border-a); border-radius: 2px; }
</style>

<!-- BCP Panel Body -->
<!-- ── Start strip ── -->
<div id="bcp-start-strip">
  <button id="bcp-start-btn" onclick="botStart()">▶ Start Game vs Bot</button>
  <button id="bcp-stop-btn" onclick="botStop()">✕ Stop</button>
</div>
<div id="bcp-status"></div>

<!-- ── Engine selector pill ── -->
<div id="bcp-engine-pill" onclick="bcpToggleEngineDrawer()" class="">
  <div style="display:flex;flex-direction:column;gap:1px;flex:1;">
    <div id="bcp-engine-pill-label">Engine</div>
    <div id="bcp-engine-pill-name">Maia3</div>
  </div>
  <div id="bcp-engine-pill-badge">Elo 1200</div>
  <svg id="bcp-engine-pill-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
</div>

<!-- ── Engine drawer ── -->
<div id="bcp-engine-drawer">
  <div id="bcp-engine-drawer-inner">
    <div class="bcp-eng-grid">
      <div class="bcp-eng-card sel" data-eng="maia3" onclick="bcpSelectEngine('maia3',this)">
        <div class="bcp-eng-dot"></div>
        <div class="bcp-eng-name">Maia3</div>
        <div class="bcp-eng-desc">Neural net — human-like moves, 600–2600 Elo</div>
      </div>
      <div class="bcp-eng-card" data-eng="stockfish" onclick="bcpSelectEngine('stockfish',this)">
        <div class="bcp-eng-dot"></div>
        <div class="bcp-eng-name">Stockfish</div>
        <div class="bcp-eng-desc">Classic engine — levels 1–20</div>
      </div>
      <div class="bcp-eng-card" data-eng="lcsf" onclick="bcpSelectEngine('lcsf',this)">
        <div class="bcp-eng-dot"></div>
        <div class="bcp-eng-name">LC + SF</div>
        <div class="bcp-eng-desc">Lichess DB openings, SF fallback</div>
      </div>
      <div class="bcp-eng-card" data-eng="lcmaia" onclick="bcpSelectEngine('lcmaia',this)">
        <div class="bcp-eng-dot"></div>
        <div class="bcp-eng-name">LC + Maia</div>
        <div class="bcp-eng-desc">Lichess openings, Maia3 midgame</div>
      </div>
    </div>
    <!-- Hybrid is below the 2×2 grid as its own full-width card -->
    <div class="bcp-eng-card" data-eng="hybrid" onclick="bcpSelectEngine('hybrid',this)" style="margin-bottom:10px;">
      <div class="bcp-eng-dot"></div>
      <div class="bcp-eng-name">Hybrid</div>
      <div class="bcp-eng-desc">Blend multiple engines by percentage — each move picks one weighted by its share</div>
    </div>

    <!-- Engine sub-settings -->
    <div id="bcp-eng-subsettings">
      <!-- Maia3 -->
      <div id="bcp-sub-maia3" class="bcp-eng-sub active">
        <div class="bcp-small-label">Rating to emulate</div>
        <div class="bcp-rating-chips" id="bcp-maia3-chips">
          <!-- injected by JS -->
        </div>
        <div class="bcp-download-box" style="margin-top:8px;">
          <p>🧠 <strong>Maia3</strong> — runs in-browser (~87MB download). Falls back to Stockfish if not loaded.</p>
          <button class="bcp-download-btn" onclick="maiaDownloadModel()">Download Maia3 (~87MB)</button>
          <div id="bcp-maia-status-text">Not loaded</div>
        </div>
      </div>
      <!-- Stockfish -->
      <div id="bcp-sub-stockfish" class="bcp-eng-sub">
        <div class="bcp-small-label">Skill level</div>
        <div class="bcp-ctrl">
          <input type="range" id="sfLevel" min="1" max="20" value="8" style="flex:1;" oninput="bcpSfSync()">
          <span class="bcp-ctrl-val" id="bcp-sf-level-val">8</span>
        </div>
        <div class="bcp-sf-display">
          <span class="bcp-sf-level-big" id="bcp-sf-big">8</span>
          <span style="font-family:var(--bcp-font-m);font-size:8px;color:var(--bcp-text3);">≈ <span id="bcp-sf-elo-approx">900 Elo</span></span>
        </div>
        <div class="bcp-small-label" style="margin-top:10px;">Variety (move variation)</div>
        <div class="bcp-ctrl">
          <span style="font-family:var(--bcp-font-m);font-size:8px;color:var(--bcp-text3);">None</span>
          <input type="range" id="sfTemperature" min="0" max="1" step="1" value="0" style="flex:1;" oninput="document.getElementById('sfTempDesc').textContent=this.value==='0'?'Always plays at selected level':'Varies ±1–2 levels each move'">
          <span style="font-family:var(--bcp-font-m);font-size:8px;color:var(--bcp-text3);">High</span>
        </div>
        <div id="sfTempDesc" style="font-family:var(--bcp-font-m);font-size:8px;color:var(--bcp-text3);">Always plays at selected level</div>
      </div>
      <!-- LC + SF -->
      <div id="bcp-sub-lcsf" class="bcp-eng-sub">
        <div class="bcp-small-label">Lichess rating range</div>
        <div class="bcp-rating-chips" id="bcp-lcsf-chips"></div>
        <div class="bcp-ctrl" style="margin-top:8px;">
          <span class="bcp-ctrl-lbl">SF fallback</span>
          <input type="range" id="lcsfFallbackLevel" min="1" max="20" value="5" style="flex:1;" oninput="document.getElementById('lcsfFallbackVal').textContent=this.value">
          <span class="bcp-ctrl-val" id="lcsfFallbackVal">5</span>
        </div>
        <div style="font-family:var(--bcp-font-m);font-size:8px;color:var(--bcp-text3);">Used when position not in Lichess database</div>
      </div>
      <!-- LC + Maia -->
      <div id="bcp-sub-lcmaia" class="bcp-eng-sub">
        <div class="bcp-small-label">Rating range</div>
        <div class="bcp-rating-chips" id="bcp-lcmaia-chips"></div>
        <div class="bcp-download-box" style="margin-top:8px;">
          <p>Lichess openings + Maia3 for midgame positions. Download Maia3 for best results.</p>
          <button class="bcp-download-btn" onclick="maiaDownloadModel()">Download Maia3 (~87MB)</button>
          <div id="bcp-maia-status-text2">Not loaded</div>
        </div>
      </div>
      <!-- Hybrid -->
      <div id="bcp-sub-hybrid" class="bcp-eng-sub">
        <div style="font-family:var(--bcp-font-m);font-size:8.5px;color:var(--bcp-text2);line-height:1.7;margin-bottom:6px;">
          Blend engines by weight. Each move, one engine is chosen randomly, weighted by its share. Changing one weight scales others proportionally.
        </div>
        <div id="bcp-hybrid-list"></div>
        <button class="bcp-add-engine-btn" onclick="bcpAddHybridEngine()">+ Add engine</button>
        <div class="bcp-hybrid-total">Total: <span id="bcp-hybrid-total">0</span>%</div>
      </div>
    </div>
  </div>
</div>

<!-- ── Accordion sections ── -->

<!-- § Time Pressure Response -->
<div class="bcp-section" id="bcp-sec-pressure">
  <div class="bcp-sec-trigger" onclick="bcpToggleSec('pressure')">
    <div class="bcp-sec-icon">
      <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    </div>
    <div class="bcp-sec-labels">
      <div class="bcp-sec-label">Time Pressure</div>
      <div class="bcp-sec-sub">Elo & confidence degrade as clock runs down</div>
    </div>
    <div class="bcp-sec-status" id="bcp-st-pressure">Dual curve</div>
    <svg class="bcp-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
  </div>
  <div class="bcp-panel-shell">
    <div class="bcp-panel">
      <div class="bcp-pr">
        <div class="bcp-ctrl">
          <span class="bcp-ctrl-lbl">Base Elo</span>
          <input type="range" id="bcp-baseelo" min="600" max="2600" step="100" value="1200"
            oninput="document.getElementById('bcp-baseelo-val').textContent=this.value;bcpReDrawAll()">
          <span class="bcp-ctrl-val" id="bcp-baseelo-val">1200</span>
        </div>
        <div class="bcp-ctrl">
          <span class="bcp-ctrl-lbl">Game time</span>
          <input type="range" id="bcp-gametime" min="1" max="30" step="1" value="5"
            oninput="document.getElementById('bcp-gametime-val').textContent=this.value+' min';bcpReDrawAll()">
          <span class="bcp-ctrl-val" id="bcp-gametime-val">5 min</span>
        </div>
        <div class="bcp-ctrl">
          <span class="bcp-ctrl-lbl">Increment</span>
          <input type="range" id="bcp-increment" min="0" max="30" step="1" value="0"
            oninput="document.getElementById('bcp-increment-val').textContent=this.value+'s';bcpReDrawAll()">
          <span class="bcp-ctrl-val" id="bcp-increment-val">0s</span>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Elo degradation curve — drag points</span></div>
        <div class="bcp-ctrl">
          <span class="bcp-ctrl-lbl">Max Elo drop</span>
          <input type="range" id="bcp-maxdrop" min="0" max="600" step="25" value="300"
            oninput="document.getElementById('bcp-maxdrop-val').textContent=this.value+' Elo';bcpInitPts();bcpDrawA()">
          <span class="bcp-ctrl-val" id="bcp-maxdrop-val">300 Elo</span>
        </div>
        <div class="bcp-chart-box">
          <div class="bcp-chart-title">Effective Elo vs think time</div>
          <canvas id="bcp-cvA" style="width:100%;cursor:ns-resize;"></canvas>
          <div class="bcp-ctip" id="bcp-tipA"></div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Confidence floor — drag points</span></div>
        <div class="bcp-ctrl">
          <span class="bcp-ctrl-lbl">Min floor</span>
          <input type="range" id="bcp-floor" min="1" max="40" step="1" value="5"
            oninput="document.getElementById('bcp-floor-val').textContent=this.value+'%';bcpInitPts();bcpDrawB()">
          <span class="bcp-ctrl-val" id="bcp-floor-val">5%</span>
        </div>
        <div class="bcp-chart-box">
          <div class="bcp-chart-title">Confidence floor % vs think time</div>
          <canvas id="bcp-cvB" style="width:100%;cursor:ns-resize;"></canvas>
          <div class="bcp-ctip" id="bcp-tipB"></div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-stats">
          <div class="bcp-stat"><div class="bcp-stat-l">Start Elo</div><div class="bcp-stat-v" id="bcp-sS0">—</div></div>
          <div class="bcp-stat"><div class="bcp-stat-l">Elo @ 3s</div><div class="bcp-stat-v" id="bcp-sS3">—</div></div>
          <div class="bcp-stat"><div class="bcp-stat-l">Elo @ min</div><div class="bcp-stat-v" id="bcp-sS1">—</div></div>
          <div class="bcp-stat"><div class="bcp-stat-l">Floor @ min</div><div class="bcp-stat-v" id="bcp-sSF">5%</div></div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Options</span></div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Can flag</div>
            <div class="bcp-tog-desc">Allow bot to run out of time completely</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="bcp-toggle-canflag" checked onchange="canFlag=this.checked">
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Aware of opponent's clock</div>
            <div class="bcp-tog-desc">Speeds up when you're in time trouble</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="bcp-toggle-oppclock" checked onchange="awareOppClock=this.checked">
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Maia-2 mode</div>
            <div class="bcp-tog-desc">Use unified model for smoother Elo transitions</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="bcp-toggle-maia2" onchange="maia2Mode=this.checked">
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- § Move Timing -->
<div class="bcp-section" id="bcp-sec-timing">
  <div class="bcp-sec-trigger" onclick="bcpToggleSec('timing')">
    <div class="bcp-sec-icon">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
    </div>
    <div class="bcp-sec-labels">
      <div class="bcp-sec-label">Move Timing</div>
      <div class="bcp-sec-sub">How the bot allocates time per move</div>
    </div>
    <div class="bcp-sec-status" id="bcp-st-timing">Complexity</div>
    <svg class="bcp-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
  </div>
  <div class="bcp-panel-shell">
    <div class="bcp-panel">
      <div class="bcp-pr">
        <div class="bcp-mode-grid">
          <div class="bcp-mcard" data-tm="steady" onclick="bcpSetTimingMode('steady',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Steady</div>
            <div class="bcp-mdesc">Near-constant pace, low variance</div>
          </div>
          <div class="bcp-mcard sel" data-tm="complexity" onclick="bcpSetTimingMode('complexity',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Complexity</div>
            <div class="bcp-mdesc">Think longer in complex positions</div>
          </div>
          <div class="bcp-mcard" data-tm="timetrouble" onclick="bcpSetTimingMode('timetrouble',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Time Trouble</div>
            <div class="bcp-mdesc">Overspends early, scrambles late</div>
          </div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Human behaviour modifiers</span></div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Reconsideration pauses</div>
            <div class="bcp-tog-desc">Occasionally hesitates then takes longer</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" checked>
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Instant on forced moves</div>
            <div class="bcp-tog-desc">Plays recaptures and forced replies instantly</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" checked>
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- § Personality -->
<div class="bcp-section" id="bcp-sec-persona">
  <div class="bcp-sec-trigger" onclick="bcpToggleSec('persona')">
    <div class="bcp-sec-icon">
      <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    </div>
    <div class="bcp-sec-labels">
      <div class="bcp-sec-label">Personality</div>
      <div class="bcp-sec-sub">Strategic character and behaviour patterns</div>
    </div>
    <div class="bcp-sec-status" id="bcp-st-persona">None</div>
    <svg class="bcp-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
  </div>
  <div class="bcp-panel-shell">
    <div class="bcp-panel">
      <div class="bcp-pr">
        <div class="bcp-persona-grid" id="bcp-persona-grid">
          <!-- injected by JS -->
        </div>
        <div class="bcp-sub-panel" id="bcp-persona-detail">
          <div class="bcp-sub-title" id="bcp-pd-title">Active triggers</div>
          <div class="bcp-sub-body" id="bcp-pd-body"></div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Tilt response</span></div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Tilt mode</div>
            <div class="bcp-tog-desc">After material loss — plays faster for 3–4 moves</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="bcp-toggle-tilt" onchange="tiltMode=this.checked">
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
        <div class="bcp-tog-row">
          <div>
            <div class="bcp-tog-lbl">Flagging shuffle</div>
            <div class="bcp-tog-desc">Plays shuffling moves when opponent is nearly out of time</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="bcp-toggle-flag-strat" onchange="flaggingStrategy=this.checked">
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- § Setup (TC, color, opening, ghost) -->
<div class="bcp-section" id="bcp-sec-setup">
  <div class="bcp-sec-trigger" onclick="bcpToggleSec('setup')">
    <div class="bcp-sec-icon">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
    </div>
    <div class="bcp-sec-labels">
      <div class="bcp-sec-label">Game Setup</div>
      <div class="bcp-sec-sub">Time control, color, openings, extras</div>
    </div>
    <div class="bcp-sec-status" id="bcp-st-setup">Untimed · White</div>
    <svg class="bcp-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
  </div>
  <div class="bcp-panel-shell">
    <div class="bcp-panel">
      <div class="bcp-pr">
        <div class="bcp-small-label">You play as</div>
        <div class="bcp-color-row" style="margin-bottom:10px;">
          <button class="bcp-color-btn sel" data-col="white" onclick="bcpSetColor('white',this)">♔ White</button>
          <button class="bcp-color-btn" data-col="black" onclick="bcpSetColor('black',this)">♚ Black</button>
          <button class="bcp-color-btn" data-col="random" onclick="bcpSetColor('random',this)">🎲 Random</button>
        </div>
        <div class="bcp-small-label">Time control</div>
        <div class="bcp-tc-chips" style="margin-bottom:3px;">
          <button class="bcp-tc-btn sel" data-tcm="0" onclick="bcpSetBaseMin(0,this)">∞</button>
          <button class="bcp-tc-btn" data-tcm="1" onclick="bcpSetBaseMin(1,this)">1</button>
          <button class="bcp-tc-btn" data-tcm="2" onclick="bcpSetBaseMin(2,this)">2</button>
          <button class="bcp-tc-btn" data-tcm="3" onclick="bcpSetBaseMin(3,this)">3</button>
          <button class="bcp-tc-btn" data-tcm="5" onclick="bcpSetBaseMin(5,this)">5</button>
          <button class="bcp-tc-btn" data-tcm="10" onclick="bcpSetBaseMin(10,this)">10</button>
          <button class="bcp-tc-btn" data-tcm="15" onclick="bcpSetBaseMin(15,this)">15</button>
          <button class="bcp-tc-btn" data-tcm="30" onclick="bcpSetBaseMin(30,this)">30</button>
        </div>
        <div class="bcp-small-label">+ Increment (sec)</div>
        <div class="bcp-tc-chips">
          <button class="bcp-tc-btn sel" data-tci="0" onclick="bcpSetIncSec(0,this)">0</button>
          <button class="bcp-tc-btn" data-tci="1" onclick="bcpSetIncSec(1,this)">1</button>
          <button class="bcp-tc-btn" data-tci="2" onclick="bcpSetIncSec(2,this)">2</button>
          <button class="bcp-tc-btn" data-tci="3" onclick="bcpSetIncSec(3,this)">3</button>
          <button class="bcp-tc-btn" data-tci="5" onclick="bcpSetIncSec(5,this)">5</button>
          <button class="bcp-tc-btn" data-tci="10" onclick="bcpSetIncSec(10,this)">10</button>
        </div>
        <div id="bcp-tc-display" style="font-family:var(--bcp-font-m);font-size:9px;color:var(--bcp-text3);margin-top:5px;text-align:center;letter-spacing:0.06em;">Untimed</div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Opening behavior</span></div>
        <div class="bcp-mode-grid bcp-mode-grid-2" style="margin-bottom:8px;">
          <div class="bcp-mcard" data-ob="none" onclick="bcpSetOpeningMode('none',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Off</div>
            <div class="bcp-mdesc">Engine from move 1</div>
          </div>
          <div class="bcp-mcard sel" data-ob="mainline" onclick="bcpSetOpeningMode('mainline',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Main Line</div>
            <div class="bcp-mdesc">Popular master-level moves</div>
          </div>
          <div class="bcp-mcard" data-ob="preferred" onclick="bcpSetOpeningMode('preferred',this)">
            <div class="bcp-mdot"></div>
            <div class="bcp-mname">Preferred</div>
            <div class="bcp-mdesc">Choose openings per color</div>
          </div>
        </div>
        <!-- Mainline options (hidden unless mainline selected) -->
        <div id="bcp-ob-mainline" style="display:none;margin-bottom:6px;">
          <div class="bcp-ctrl">
            <span class="bcp-ctrl-lbl">Book depth</span>
            <input type="range" id="obDepth" min="4" max="40" value="20" style="flex:1;"
              oninput="botOpeningConfig.maxBookDepth=parseInt(this.value);document.getElementById('bcp-ob-depth-val').textContent=this.value">
            <span class="bcp-ctrl-val" id="bcp-ob-depth-val">20</span>
          </div>
        </div>
        <!-- Preferred color selector -->
        <div id="bcp-ob-preferred" style="display:none;margin-bottom:6px;">
          <div style="display:flex;gap:4px;margin-bottom:6px;">
            <button class="bcp-tc-btn sel" id="obpref-white" onclick="obPrefSetColor('white')">♔ White</button>
            <button class="bcp-tc-btn" id="obpref-black" onclick="obPrefSetColor('black')">♚ Black</button>
          </div>
          <div id="obPrefWhite"></div>
          <div id="obPrefBlack" style="display:none;"></div>
        </div>
      </div>
      <div class="bcp-pr">
        <div class="bcp-dlbl"><span>Extras</span></div>
        <div class="bcp-ghost-row">
          <div>
            <div class="bcp-tog-lbl">👻 Ghost response preview</div>
          </div>
          <label class="bcp-tog">
            <input type="checkbox" id="cbGhostPieces" checked>
            <div class="bcp-tog-track"><div class="bcp-tog-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ── Bottom strip ── -->
<div id="bcp-bottom-strip">
  <input type="text" class="bcp-name-input" id="botNameInput" placeholder="Name this bot (optional)…">
  <div class="bcp-bottom-row">
    <button class="bcp-util-btn bcp-save-btn" onclick="botSaveConfig()">↓ Save config</button>
    <button class="bcp-util-btn bcp-load-btn" onclick="document.getElementById('botConfigInput').click()">↑ Load config</button>
    <input type="file" id="botConfigInput" accept=".json" style="display:none" onchange="botLoadConfig(event)">
  </div>
</div>

<!-- Hidden legacy inputs that host page JS references by ID -->
<input type="hidden" id="sfPressureLevel" value="4">
<input type="hidden" id="botPace" value="40">
<input type="hidden" id="botPaceVal" value="40">
<input type="hidden" id="maiaTemp" value="1.0">
<input type="hidden" id="maia3Temp" value="1.0">
<input type="hidden" id="maiaElo" value="1200">
<input type="hidden" id="lcsfFallbackVal" value="5">
<!-- Legacy status elements still referenced in host JS -->
<div id="botStatus" style="display:none;"></div>
<div id="maia3StatusText" style="display:none;"></div>
<div id="maiaStatusText" style="display:none;"></div>
<div id="hybridSlots" style="display:none;"></div>
`;
  }

  // ── Rating chips data ─────────────────────────────────────────────────────────
  const MAIA3_RATINGS = [600,800,1000,1200,1400,1600,1800,2000,2200,2400,2600];
  const LC_RATINGS = ['400','1000','1200','1400','1600','1800','2000','2200+'];
  const SF_ELO = {1:400,2:500,3:600,4:700,5:800,6:900,7:1000,8:1100,9:1200,10:1350,
                  11:1500,12:1650,13:1800,14:1950,15:2100,16:2250,17:2400,18:2550,19:2700,20:2800};

  let _selectedMaia3Rating = 1200;
  let _selectedLcsfRating = '1200';
  let _selectedLcmaiaRating = '1200';

  function _buildRatingChips(containerId, ratings, selectedVal, onSelect) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = ratings.map(r => `
      <div class="bcp-rating-chip${String(r) === String(selectedVal) ? ' sel' : ''}"
           onclick="(${onSelect.toString()})(${JSON.stringify(r)},this,'${containerId}')">
        ${r}
      </div>
    `).join('');
  }

  function _selectChip(container, val) {
    document.querySelectorAll(`#${container} .bcp-rating-chip`).forEach(c => {
      c.classList.toggle('sel', c.textContent.trim() === String(val));
    });
  }

  // ── SF level → approx Elo ────────────────────────────────────────────────────
  function bcpSfSync() {
    const lvl = parseInt(document.getElementById('sfLevel')?.value || 8);
    const approx = SF_ELO[lvl] || '?';
    const big = document.getElementById('bcp-sf-big');
    const approxEl = document.getElementById('bcp-sf-elo-approx');
    const val = document.getElementById('bcp-sf-level-val');
    if (big) big.textContent = lvl;
    if (approxEl) approxEl.textContent = approx + ' Elo';
    if (val) val.textContent = lvl;
    // Sync legacy sfPressureLevel to half of sfLevel (rough approximation)
    const pl = document.getElementById('sfPressureLevel');
    if (pl) pl.value = Math.max(1, Math.floor(lvl / 2));
    // Update engine pill badge
    _updateEnginePillBadge();
  }

  // ── Engine drawer toggle ─────────────────────────────────────────────────────
  function bcpToggleEngineDrawer() {
    const pill = document.getElementById('bcp-engine-pill');
    const drawer = document.getElementById('bcp-engine-drawer');
    const isOpen = drawer.classList.contains('open');
    drawer.classList.toggle('open', !isOpen);
    pill.classList.toggle('open', !isOpen);
  }

  function bcpSelectEngine(eng, card) {
    activeEngine = eng;
    // Visual: update cards
    document.querySelectorAll('.bcp-eng-card').forEach(c => c.classList.remove('sel'));
    if (card) card.classList.add('sel');
    // Show correct sub-settings
    document.querySelectorAll('.bcp-eng-sub').forEach(s => s.classList.remove('active'));
    const sub = document.getElementById('bcp-sub-' + eng);
    if (sub) sub.classList.add('active');
    // Sync to host page botTab
    const tabMap = { maia3:'maia3', stockfish:'sf', lcsf:'lcsf', lcmaia:'maia', hybrid:'hybrid' };
    if (typeof botSetTab === 'function') botSetTab(tabMap[eng] || eng);
    _updateEnginePillBadge();
  }

  function _updateEnginePillBadge() {
    const nameEl = document.getElementById('bcp-engine-pill-name');
    const badgeEl = document.getElementById('bcp-engine-pill-badge');
    const names = { maia3:'Maia3', stockfish:'Stockfish', lcsf:'LC + SF', lcmaia:'LC + Maia', hybrid:'Hybrid' };
    if (nameEl) nameEl.textContent = names[activeEngine] || activeEngine;
    if (badgeEl) {
      if (activeEngine === 'maia3') {
        badgeEl.textContent = 'Elo ' + _selectedMaia3Rating;
      } else if (activeEngine === 'stockfish') {
        const lvl = parseInt(document.getElementById('sfLevel')?.value || 8);
        badgeEl.textContent = 'Level ' + lvl;
      } else if (activeEngine === 'lcsf') {
        badgeEl.textContent = _selectedLcsfRating;
      } else if (activeEngine === 'lcmaia') {
        badgeEl.textContent = _selectedLcmaiaRating;
      } else if (activeEngine === 'hybrid') {
        badgeEl.textContent = hybridEngines.length + ' engines';
      }
    }
  }

  // ── Section accordion ────────────────────────────────────────────────────────
  function bcpToggleSec(key) {
    const el = document.getElementById('bcp-sec-' + key);
    if (!el) return;
    const opening = !el.classList.contains('open');
    el.classList.toggle('open', opening);
    if (opening && key === 'pressure') bcpScheduleDraw();
  }

  // ── Timing mode ──────────────────────────────────────────────────────────────
  function bcpSetTimingMode(mode, card) {
    timingMode = mode;
    document.querySelectorAll('[data-tm]').forEach(c => c.classList.remove('sel'));
    if (card) card.classList.add('sel');
    const labels = { steady: 'Steady', complexity: 'Complexity', timetrouble: 'Time Trouble' };
    const st = document.getElementById('bcp-st-timing');
    if (st) st.textContent = labels[mode] || mode;
  }

  function _selectTimingMode(mode) {
    const card = document.querySelector(`[data-tm="${mode}"]`);
    bcpSetTimingMode(mode, card);
  }

  // ── Color / TC ───────────────────────────────────────────────────────────────
  function bcpSetColor(col, btn) {
    document.querySelectorAll('[data-col]').forEach(b => b.classList.remove('sel'));
    if (btn) btn.classList.add('sel');
    if (typeof botSetPlayerColor === 'function') botSetPlayerColor(col);
    _updateSetupStatus();
  }

  let _tcBaseMin = 0, _tcIncSec = 0;

  function bcpSetBaseMin(min, btn) {
    _tcBaseMin = min;
    document.querySelectorAll('[data-tcm]').forEach(b => b.classList.remove('sel'));
    if (btn) btn.classList.add('sel');
    if (typeof botSetBaseMin === 'function') botSetBaseMin(min);
    _updateTcDisplay();
    _updateSetupStatus();
    // Sync Time Pressure section sliders
    const gtel = document.getElementById('bcp-gametime');
    if (gtel && min > 0) { gtel.value = min; document.getElementById('bcp-gametime-val').textContent = min + ' min'; bcpReDrawAll(); }
  }

  function bcpSetIncSec(inc, btn) {
    _tcIncSec = inc;
    document.querySelectorAll('[data-tci]').forEach(b => b.classList.remove('sel'));
    if (btn) btn.classList.add('sel');
    if (typeof botSetIncSec === 'function') botSetIncSec(inc);
    _updateTcDisplay();
    const iel = document.getElementById('bcp-increment');
    if (iel) { iel.value = inc; document.getElementById('bcp-increment-val').textContent = inc + 's'; bcpReDrawAll(); }
  }

  function _updateTcDisplay() {
    const el = document.getElementById('bcp-tc-display');
    if (!el) return;
    if (_tcBaseMin === 0) { el.textContent = 'Untimed'; return; }
    el.textContent = _tcBaseMin + (_tcIncSec > 0 ? ' + ' + _tcIncSec + ' sec' : ' min');
  }

  function _updateSetupStatus() {
    const st = document.getElementById('bcp-st-setup');
    if (!st) return;
    const tc = _tcBaseMin === 0 ? 'Untimed' : _tcBaseMin + (_tcIncSec ? '+' + _tcIncSec : '') + ' min';
    const col = document.querySelector('[data-col].sel')?.dataset.col || 'white';
    const colLabel = col === 'white' ? 'White' : col === 'black' ? 'Black' : 'Random';
    st.textContent = tc + ' · ' + colLabel;
  }

  // ── Opening mode ─────────────────────────────────────────────────────────────
  function bcpSetOpeningMode(mode, card) {
    document.querySelectorAll('[data-ob]').forEach(c => c.classList.remove('sel'));
    if (card) card.classList.add('sel');
    document.getElementById('bcp-ob-mainline').style.display = mode === 'mainline' ? '' : 'none';
    document.getElementById('bcp-ob-preferred').style.display = mode === 'preferred' ? '' : 'none';
    if (typeof botSetOpeningMode === 'function') botSetOpeningMode(mode);
  }

  // ── Persona ──────────────────────────────────────────────────────────────────
  function _buildPersonaGrid() {
    const grid = document.getElementById('bcp-persona-grid');
    if (!grid) return;
    grid.innerHTML = Object.entries(PERSONAS).map(([key, p]) => `
      <div class="bcp-pcard" data-persona="${key}" onclick="bcpSelectPersona('${key}',this)">
        <div class="bcp-picon">${p.icon}</div>
        <div class="bcp-pname">${p.name}</div>
        <div class="bcp-ptrait">${p.trait}</div>
        <div class="bcp-ptag">${p.tag}</div>
      </div>
    `).join('');
  }

  function bcpSelectPersona(key, card) {
    activePersona = key;
    document.querySelectorAll('.bcp-pcard').forEach(c => c.classList.remove('sel'));
    if (card) card.classList.add('sel');
    const p = PERSONAS[key];
    document.getElementById('bcp-st-persona').textContent = p.name;
    // Apply curve preset
    if (p.curvePreset) { initPts(p.curvePreset); bcpDrawA(); bcpDrawB(); }
    if (p.timingPreset) { _selectTimingMode(p.timingPreset); }
    // Show detail
    const detail = document.getElementById('bcp-persona-detail');
    const pdTitle = document.getElementById('bcp-pd-title');
    const pdBody = document.getElementById('bcp-pd-body');
    if (detail && p.trait) {
      pdTitle.textContent = p.name + ' — profile';
      pdBody.textContent = p.trait;
      detail.classList.add('vis');
    }
  }

  // ── Hybrid engines ────────────────────────────────────────────────────────────
  function bcpAddHybridEngine() {
    const id = hybridNextId++;
    hybridEngines.push({ id, engineType: 'maia3', rating: 1200, sfLevel: 8, weight: 0 });
    _renderHybridEngines();
    _normalizeHybridWeights(id);
  }

  function _renderHybridEngines() {
    const list = document.getElementById('bcp-hybrid-list');
    if (!list) return;
    list.innerHTML = '';
    if (!hybridEngines.length) {
      list.innerHTML = '<div style="font-family:var(--bcp-font-m);font-size:8.5px;color:var(--bcp-text3);text-align:center;padding:8px 0;">No engines added. Click + Add engine.</div>';
      _updateHybridTotal();
      return;
    }
    hybridEngines.forEach(eng => {
      const pct = Math.round(eng.weight);
      const row = document.createElement('div');
      row.className = 'bcp-hybrid-row';
      row.dataset.engId = eng.id;
      row.innerHTML = `
        <select class="bcp-hybrid-type-sel" style="font-family:var(--bcp-font-u);font-size:8px;background:var(--bcp-bg3);border:0.5px solid var(--bcp-border);border-radius:2px;color:var(--bcp-amber);padding:2px 4px;cursor:pointer;flex-shrink:0;">
          <option value="maia3" ${eng.engineType==='maia3'?'selected':''}>Maia3</option>
          <option value="stockfish" ${eng.engineType==='stockfish'?'selected':''}>Stockfish</option>
          <option value="lcsf" ${eng.engineType==='lcsf'?'selected':''}>LC+SF</option>
          <option value="lcmaia" ${eng.engineType==='lcmaia'?'selected':''}>LC+Maia</option>
        </select>
        <input type="range" class="bcp-hybrid-slider" min="0" max="100" value="${pct}" style="flex:1;">
        <span class="bcp-hybrid-pct">${pct}%</span>
        <button class="bcp-hybrid-rm" title="Remove">✕</button>
      `;
      // Wire events
      const sel = row.querySelector('.bcp-hybrid-type-sel');
      sel.onchange = () => { eng.engineType = sel.value; _updateEnginePillBadge(); };
      const slider = row.querySelector('.bcp-hybrid-slider');
      slider.oninput = () => { eng.weight = parseInt(slider.value); _normalizeHybridWeights(eng.id); };
      const rm = row.querySelector('.bcp-hybrid-rm');
      rm.onclick = () => { hybridEngines = hybridEngines.filter(e => e.id !== eng.id); _renderHybridEngines(); };
      list.appendChild(row);
    });
    _updateHybridTotal();
    _updateEnginePillBadge();
    // Sync to host page botHybridSlots
    _syncHybridToHost();
  }

  // Normalize weights so changed engine keeps its value and others scale proportionally
  function _normalizeHybridWeights(changedId) {
    if (!hybridEngines.length) return;
    const changed = hybridEngines.find(e => e.id === changedId);
    if (!changed) return;
    const changedW = changed.weight;
    const othersTotal = hybridEngines.filter(e => e.id !== changedId).reduce((s, e) => s + e.weight, 0);
    const remaining = Math.max(0, 100 - changedW);
    if (othersTotal > 0) {
      hybridEngines.forEach(e => {
        if (e.id !== changedId) e.weight = Math.round((e.weight / othersTotal) * remaining);
      });
    } else if (hybridEngines.length > 1) {
      const perOther = Math.round(remaining / (hybridEngines.length - 1));
      hybridEngines.forEach(e => { if (e.id !== changedId) e.weight = perOther; });
    }
    _renderHybridEngines();
  }

  function _updateHybridTotal() {
    const total = hybridEngines.reduce((s, e) => s + (e.weight || 0), 0);
    const el = document.getElementById('bcp-hybrid-total');
    if (el) { el.textContent = total; el.style.color = total === 100 ? 'var(--bcp-amber-b)' : 'var(--bcp-text3)'; }
  }

  function _syncHybridToHost() {
    // Map bcp hybrid engines to the format botHybridSlots expects
    if (typeof botHybridSlots !== 'undefined') {
      botHybridSlots.length = 0;
      hybridEngines.forEach(e => {
        botHybridSlots.push({
          type: e.engineType === 'stockfish' ? 'sf' : 'maia',
          level: e.sfLevel || 8,
          rating: e.rating || 1200,
          weight: e.weight
        });
      });
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────
  function _getCanvasW(cvId) {
    const cv = document.getElementById(cvId);
    if (!cv) return 0;
    const box = cv.closest('.bcp-chart-box');
    let w = box ? box.offsetWidth - 24 : 0;
    if (w < 80) w = document.getElementById('botPanel')?.offsetWidth - 40 || 260;
    return Math.floor(w);
  }

  function _drawCurve(cvId, ctrl, sigFn, yMin, yMax, yFmt, lineColor, fillColor, tipId) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    const w = _getCanvasW(cvId);
    if (w < 80) return;
    cv.width = w; cv.height = CHART_H;
    cv.style.width = w + 'px'; cv.style.height = CHART_H + 'px';
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, CHART_H);

    const xs = buildXs();
    const sigY = xs.map(t => sigFn(t));
    const cusY = hermite(xs, ctrl);
    const tMax = startX(), tMin = floorX();

    function xp(t) { return PAD.l + (tMax - t) / (tMax - tMin) * (w - PAD.l - PAD.r); }
    function yp(v) { return PAD.t + (yMax - v) / (yMax - yMin) * (CHART_H - PAD.t - PAD.b); }

    // Background
    ctx.fillStyle = '#0e0f11'; ctx.fillRect(PAD.l, PAD.t, w - PAD.l - PAD.r, CHART_H - PAD.t - PAD.b);

    // Y grid + labels
    const yRange = yMax - yMin;
    const yStep = yRange > 400 ? 200 : yRange > 200 ? 100 : yRange > 50 ? 25 : 10;
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      const y = yp(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
      ctx.fillStyle = '#3a4050'; ctx.font = '8px "DM Mono",monospace'; ctx.textAlign = 'right';
      ctx.fillText(yFmt(v), PAD.l - 3, y + 3);
    }

    // X grid + labels
    const range = tMax - tMin;
    const xStep = range > 15 ? 5 : range > 8 ? 2 : range > 4 ? 1 : 0.5;
    for (let t = +(Math.ceil(tMin / xStep) * xStep).toFixed(2); t <= tMax + 0.01; t = +(t + xStep).toFixed(2)) {
      const x = xp(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, CHART_H - PAD.b); ctx.stroke();
      ctx.fillStyle = '#3a4050'; ctx.font = '8px "DM Mono",monospace'; ctx.textAlign = 'center';
      ctx.fillText((Number.isInteger(t) ? t : t.toFixed(1)) + 's', x, CHART_H - PAD.b + 11);
    }

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.5;
    ctx.strokeRect(PAD.l, PAD.t, w - PAD.l - PAD.r, CHART_H - PAD.t - PAD.b);

    // X axis label
    ctx.fillStyle = '#2a3040'; ctx.font = '7px "DM Mono",monospace'; ctx.textAlign = 'center';
    ctx.fillText('think time per move  longer → shorter', w / 2, CHART_H - 2);

    // Flag zone: if canFlag, shade right 15% red
    if (canFlag) {
      const fzX = xp(tMin + (tMax - tMin) * 0.08);
      ctx.fillStyle = 'rgba(200,40,40,0.06)';
      ctx.fillRect(fzX, PAD.t, (w - PAD.r) - fzX, CHART_H - PAD.t - PAD.b);
    }

    // Baseline sigmoid (dashed steel)
    ctx.beginPath(); ctx.strokeStyle = 'rgba(74,85,104,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    xs.forEach((t, i) => { const px = xp(t), py = yp(sigY[i]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
    ctx.stroke(); ctx.setLineDash([]);

    // Fill under custom curve
    ctx.beginPath();
    xs.forEach((t, i) => { const px = xp(t), py = yp(cusY[i]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
    ctx.lineTo(xp(xs[xs.length - 1]), CHART_H - PAD.b);
    ctx.lineTo(xp(xs[0]), CHART_H - PAD.b);
    ctx.closePath();
    ctx.fillStyle = fillColor; ctx.fill();

    // Custom curve line
    ctx.beginPath(); ctx.strokeStyle = lineColor; ctx.lineWidth = 1.8; ctx.setLineDash([]);
    xs.forEach((t, i) => { const px = xp(t), py = yp(cusY[i]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
    ctx.stroke();

    // Control points
    ctrl.forEach(p => {
      const px = xp(p.x), py = yp(p.y);
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#0e0f11'; ctx.fill();
      ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = lineColor; ctx.fill();
    });

    _updateStats(xs, hermite(xs, ctrlA), hermite(xs, ctrlB));
  }

  function bcpDrawA() {
    const yMin = Math.max(400, baseElo() - maxDrop() - 60);
    const yMax = baseElo() + 60;
    _drawCurve('bcp-cvA', ctrlA, sigA, yMin, yMax, v => v, '#c8922a', 'rgba(200,146,42,0.07)', 'bcp-tipA');
  }
  function bcpDrawB() {
    const yMin = minFloor() - 2;
    const yMax = 54;
    _drawCurve('bcp-cvB', ctrlB, sigB, yMin, yMax, v => v + '%', '#5dade2', 'rgba(41,128,185,0.07)', 'bcp-tipB');
  }

  function bcpInitPts(preset) { initPts(preset); }
  function bcpReDrawAll() { initPts(); bcpDrawA(); bcpDrawB(); }

  function _updateStats(xs, cA, cB) {
    const s0 = document.getElementById('bcp-sS0');
    const s3 = document.getElementById('bcp-sS3');
    const s1 = document.getElementById('bcp-sS1');
    const sf = document.getElementById('bcp-sSF');
    if (s0) s0.textContent = cA[0];
    if (s3) {
      const i3 = xs.findIndex(x => x <= 3.05);
      s3.textContent = i3 >= 0 ? cA[i3] : '—';
    }
    if (s1) s1.textContent = cA[cA.length - 1];
    if (sf) sf.textContent = cB[cB.length - 1] + '%';
  }

  // Schedule draw after section opens (waits for CSS transition)
  function bcpScheduleDraw() {
    if (_drawScheduled) return;
    _drawScheduled = true;
    initPts();
    [60, 250, 500].forEach(ms => setTimeout(() => { bcpDrawA(); bcpDrawB(); }, ms));
    setTimeout(() => { _drawScheduled = false; }, 600);
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────────
  function _setupDrag(cvId, ctrl, sigFn, isElo, tipId) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    let drag = null;

    function pt(e) {
      const r = cv.getBoundingClientRect();
      return {
        cx: (e.touches ? e.touches[0].clientX : e.clientX) - r.left,
        cy: (e.touches ? e.touches[0].clientY : e.clientY) - r.top
      };
    }
    function xp(t, w) { const tM = startX(), tm = floorX(); return PAD.l + (tM - t) / (tM - tm) * (w - PAD.l - PAD.r); }
    function pxToV(py, yMin, yMax) { return yMax - (py - PAD.t) / (CHART_H - PAD.t - PAD.b) * (yMax - yMin); }
    function getRng() { return isElo ? { mn: Math.max(400, baseElo() - maxDrop() - 60), mx: baseElo() + 60 } : { mn: minFloor() - 2, mx: 54 }; }
    function snap(v) { return isElo ? Math.round(v / SNAP_ELO) * SNAP_ELO : Math.round(v); }

    function nearest(cx, cy) {
      const w = cv.offsetWidth || _getCanvasW(cvId);
      let best = null, bd = 999;
      const { mn, mx } = getRng();
      ctrl.forEach((p, i) => {
        const py = PAD.t + (mx - p.y) / (mx - mn) * (CHART_H - PAD.t - PAD.b);
        const d = Math.hypot(xp(p.x, w) - cx, py - cy);
        if (d < bd) { bd = d; best = i; }
      });
      return bd < 22 ? best : null;
    }

    function doMove(cx, cy) {
      if (drag === null) return;
      const { mn, mx } = getRng();
      let v = snap(pxToV(cy, mn, mx));
      v = Math.max(mn + 1, Math.min(mx - 1, v));
      ctrl[drag].y = v;
      const tip = document.getElementById(tipId);
      if (tip) {
        tip.style.display = 'block';
        tip.style.left = (cx + 10) + 'px';
        tip.style.top = Math.max(0, cy - 18) + 'px';
        tip.textContent = ctrl[drag].x.toFixed(1) + 's → ' + (isElo ? 'Elo ' + v : v + '%');
      }
      isElo ? bcpDrawA() : bcpDrawB();
      _curveDirty = true;
    }

    cv.addEventListener('mousedown', e => { const { cx, cy } = pt(e); drag = nearest(cx, cy); if (drag !== null) e.preventDefault(); });
    cv.addEventListener('mousemove', e => {
      const { cx, cy } = pt(e);
      if (drag !== null) { e.preventDefault(); doMove(cx, cy); }
      else { cv.style.cursor = nearest(cx, cy) !== null ? 'ns-resize' : 'crosshair'; }
    });
    function up() { drag = null; const tip = document.getElementById(tipId); if (tip) tip.style.display = 'none'; }
    cv.addEventListener('mouseup', up);
    cv.addEventListener('mouseleave', up);
    cv.addEventListener('touchstart', e => { const { cx, cy } = pt(e); drag = nearest(cx, cy); if (drag !== null) e.preventDefault(); }, { passive: false });
    cv.addEventListener('touchmove', e => { if (drag === null) return; e.preventDefault(); const { cx, cy } = pt(e); doMove(cx, cy); }, { passive: false });
    cv.addEventListener('touchend', up);
  }

  // ── Public API: onEngineTabChange ─────────────────────────────────────────────
  function onEngineTabChange(tab) {
    const revMap = { sf:'stockfish', maia3:'maia3', lcsf:'lcsf', maia:'lcmaia', hybrid:'hybrid' };
    const eng = revMap[tab] || tab;
    activeEngine = eng;
    const card = document.querySelector(`[data-eng="${eng}"]`);
    if (card) {
      document.querySelectorAll('.bcp-eng-card').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
    }
    document.querySelectorAll('.bcp-eng-sub').forEach(s => s.classList.remove('active'));
    const sub = document.getElementById('bcp-sub-' + eng);
    if (sub) sub.classList.add('active');
    _updateEnginePillBadge();
  }

  // ── init() — inject HTML and wire everything up ───────────────────────────────
  function init() {
    // Load fonts if not already present
    if (!document.getElementById('bcp-fonts')) {
      const link = document.createElement('link');
      link.id = 'bcp-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300&family=Chakra+Petch:wght@300;400;500;600&display=swap';
      document.head.appendChild(link);
    }

    // Replace botPanel body
    const panelBody = document.querySelector('#botPanel .panel-body');
    if (!panelBody) { console.warn('BotConfigPanel: #botPanel .panel-body not found'); return; }
    panelBody.innerHTML = _buildHTML();

    // Restyle panel header title
    const panelTitle = document.querySelector('#botPanel .panel-title');
    if (panelTitle) panelTitle.innerHTML = '<span style="font-family:var(--bcp-font-d,\'Cormorant Garamond\',serif);font-style:italic;font-weight:300;font-size:15px;letter-spacing:0.02em;">Opponent Profile</span>';

    // Widen the slide panel for this richer UI
    const panel = document.getElementById('botPanel');
    if (panel) {
      panel.style.width = '340px';
      panel.style.right = '-360px';
    }

    // Build dynamic chip rows
    _buildRatingChips('bcp-maia3-chips', MAIA3_RATINGS, 1200, (r, el, cid) => {
      _selectedMaia3Rating = r;
      if (typeof maia3SetRating === 'function') maia3SetRating(r);
      _selectChip(cid, r);
      _updateEnginePillBadge();
    });
    _buildRatingChips('bcp-lcsf-chips', LC_RATINGS, '1200', (r, el, cid) => {
      _selectedLcsfRating = r;
      if (typeof lcsfSetRating === 'function') lcsfSetRating(r);
      _selectChip(cid, r);
      _updateEnginePillBadge();
    });
    _buildRatingChips('bcp-lcmaia-chips', LC_RATINGS, '1200', (r, el, cid) => {
      _selectedLcmaiaRating = r;
      if (typeof lcSetRating === 'function') lcSetRating(r);
      _selectChip(cid, r);
      _updateEnginePillBadge();
    });

    // Build persona grid
    _buildPersonaGrid();

    // Init hybrid with default slots
    hybridEngines = [
      { id: hybridNextId++, engineType: 'maia3', rating: 1200, sfLevel: 8, weight: 60 },
      { id: hybridNextId++, engineType: 'stockfish', rating: null, sfLevel: 8, weight: 40 },
    ];
    _renderHybridEngines();

    // Init curve points
    initPts();

    // Setup drag after a short delay (DOM must be painted)
    setTimeout(() => {
      _setupDrag('bcp-cvA', ctrlA, sigA, true, 'bcp-tipA');
      _setupDrag('bcp-cvB', ctrlB, sigB, false, 'bcp-tipB');
    }, 100);

    // SF sync
    bcpSfSync();
    document.getElementById('sfLevel')?.addEventListener('input', bcpSfSync);

    // Maia status text sync — watch for changes in the legacy hidden elements
    const maiaObserver = new MutationObserver(() => {
      const src1 = document.getElementById('maia3StatusText')?.textContent || '';
      const src2 = document.getElementById('maiaStatusText')?.textContent || '';
      const status = src1 || src2;
      const t1 = document.getElementById('bcp-maia-status-text');
      const t2 = document.getElementById('bcp-maia-status-text2');
      if (t1) t1.textContent = status;
      if (t2) t2.textContent = status;
    });
    ['maia3StatusText', 'maiaStatusText'].forEach(id => {
      const el = document.getElementById(id);
      if (el) maiaObserver.observe(el, { childList: true, characterData: true, subtree: true });
    });

    // Resize redraw
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        if (document.getElementById('bcp-sec-pressure')?.classList.contains('open')) {
          bcpDrawA(); bcpDrawB();
        }
      }, 150);
    });

    // Sync stop button visibility from host
    const obs2 = new MutationObserver(() => {
      const stopSrc = document.getElementById('botStatus');
      const stopBtn = document.getElementById('bcp-stop-btn');
      const startBtn = document.getElementById('bcp-start-btn');
      if (!stopSrc || !stopBtn) return;
      // Detect if bot is active by watching botSidebarBtn text (set in botStart/botStop)
      const sideBtn = document.getElementById('botSidebarBtn');
      const active = sideBtn?.textContent?.includes('Active');
      if (stopBtn) stopBtn.style.display = active ? '' : 'none';
      if (startBtn) startBtn.textContent = active ? '↺ Restart Bot Game' : '▶ Start Game vs Bot';
      // Mirror status text
      const bcpSt = document.getElementById('bcp-status');
      if (bcpSt) bcpSt.textContent = stopSrc.textContent;
    });
    const statusEl = document.getElementById('botStatus');
    if (statusEl) obs2.observe(statusEl, { childList: true, characterData: true, subtree: true });

    console.log('[BotConfigPanel] init complete');
  }

  // ── Expose global functions needed by inline onclick handlers ─────────────────
  // These must be on window because they're called from injected HTML
  window.bcpToggleEngineDrawer = bcpToggleEngineDrawer;
  window.bcpSelectEngine = bcpSelectEngine;
  window.bcpToggleSec = bcpToggleSec;
  window.bcpSetTimingMode = bcpSetTimingMode;
  window.bcpSetColor = bcpSetColor;
  window.bcpSetBaseMin = bcpSetBaseMin;
  window.bcpSetIncSec = bcpSetIncSec;
  window.bcpSetOpeningMode = bcpSetOpeningMode;
  window.bcpSelectPersona = bcpSelectPersona;
  window.bcpAddHybridEngine = bcpAddHybridEngine;
  window.bcpSfSync = bcpSfSync;
  window.bcpInitPts = bcpInitPts;
  window.bcpDrawA = bcpDrawA;
  window.bcpDrawB = bcpDrawB;
  window.bcpReDrawAll = bcpReDrawAll;
  window.bcpScheduleDraw = bcpScheduleDraw;
  // Make canFlag, awareOppClock, etc. writable from inline onchange
  // (They're already in module scope; assigning to window aliases ensures
  //  host page botMakeMove() can read them via BotConfigPanel.getConfig())

  return {
    init,
    effectiveElo,
    effectiveTempBoost,
    thinkTimeMs,
    getConfig,
    applyConfig,
    onEngineTabChange,
    // Expose for host page save/load
    get ctrlA() { return ctrlA; },
    get ctrlB() { return ctrlB; },
    get timingMode() { return timingMode; },
    get canFlag() { return canFlag; },
    get awareOppClock() { return awareOppClock; },
    get hybridEngines() { return hybridEngines; },
  };
})();

// ── Auto-init after DOM ready ─────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BotConfigPanel.init());
} else {
  // Already loaded (script injected after DOMContentLoaded)
  BotConfigPanel.init();
}

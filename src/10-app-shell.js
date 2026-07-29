// ── Last-move tracking — declared early to avoid TDZ ────────────────────────
let lastMoveFrom = -1; // square the last-moved piece came FROM
let lastMoveTo   = -1; // square the last-moved piece went TO
// ── Custom start positions (replay "play from here" / loaded PGN with FEN) ──
let replayBaseFen   = null; // FEN the current replay starts from (null = standard start)
let _replayHalfmove = 0;    // halfmove clock reconstructed at the current replay position
let _gameStartFen   = null; // custom starting FEN of the live game (null = standard)
let _gameStartSans  = [];   // SAN move prefix that led to _gameStartFen (for full-PGN saves)
let mpStartFen      = null; // agreed custom start position for the current MP room
let mpStartSans     = [];

// ── Bot & SF state — declared first to avoid TDZ errors ─────────────────────
// These let variables must be declared before loadPos()/render() runs at startup.
let botActive = false;
let botPlayerColor = 'white';
let botTab = 'sf';
let botTimePressure = 'steady';
let botSelectedTC = 'untimed';
let botHybridSlots = [];
let sfWorker = null;
let sfReady = false;
let _sfInitPromise = null;
let botMaiaTempValue = 1.0; // raw T from bot panel slider; used by Maia sampling
let sfPendingResolve = null;
let sfBestmovesOwed = 0;  // bestmoves still owed by abandoned (stopped/timed-out) searches —
                          // they must be discarded or they resolve the WRONG request
let sfCurrentSkillLevel = -1; // tracks last set skill level — avoids redundant setoption calls
// ── MultiPV complexity probe state ───────────────────────────────────────────
let sfCplxActive    = false;  // true while a MultiPV depth-12 probe is running
let sfCplxPending   = null;   // resolve callback for sfGetComplexity()
let sfCplxInfoLines = [];     // info lines collected during the probe
let sfCplxScore     = null;   // last computed complexity 0..1 (null = unavailable)
let sfCplxEval      = null;   // last computed eval cp from probe (+= current player)
let sfCplxFen       = null;   // FEN of the cached position (one-move cache)
let sfGhostWorker = null;
let sfGhostReady = false;
let sfGhostPending = null;
let sfGhostBestmovesOwed = 0; // same discard accounting as sfBestmovesOwed, for the ghost worker
let botThinking = false;
let botLastHoverSq = -1;
let botGhostResponses = {};
let botPrecomputePending = false;
let lastBotMoveSource = ''; // 'LC', 'SF', etc.

// ── Phase 1: Move history & clock fraction tracking ──────────────────────────
// botMoveHistory: ordered list of every UCI move played this game (both sides).
// Used by: opening book (play= param), degradation logic (move number), post-game logging.
let botMoveHistory = [];  // UCI move list, e.g. ["e2e4","c7c5",...]
let botSanHistory  = [];  // SAN move list, e.g. ["e4","c5",...] — for ECO PGN matching

// ── Phase 2: Opening book state ───────────────────────────────────────────────
// 'none' | 'mainline' | 'loyalty' | 'repertoire'
let botOpeningMode = 'none';
// preferredOpeningActive: true from game-start until the played moves no longer
// match any preferred ECO line. Once false it stays false for that game —
// the bot falls through to the normal engine path immediately with no network call.
let preferredOpeningActive = false;
// lichessExplorerActive: true from game-start until the Lichess/Masters explorer
// returns empty moves (position is off-book). Once false for this game, we skip
// all explorer network calls and go straight to the engine fallback.
let lichessExplorerActive = false;
let botOpeningConfig = {
  source: 'masters',       // 'masters' | 'lichess'
  maxBookDepth: 20,        // stop using book after this many half-moves
  fallbackToEngine: true,
  // loyalty-specific
  ecoPrefix: '',
  openingName: '',
  deviationResponse: 'engine',
  // repertoire-specific (arrays per color)
  white: [],
  black: [],
  // per-color opening mode (new panel): 'off' | 'mainline' | 'repertoire'
  modeWhite: 'off',
  modeBlack: 'off',
  strictness: 0.8,
};
// 0–100: percentage of games where the bot follows its preferred opening.
// Roll happens in botStart; if skipped, preferredOpeningActive stays false.
let botOpeningFrequencyPct = 100;
// In-memory cache: move-history key → explorer result. No TTL needed.
const _openingCache = new Map();
// Starting clock in ms — captured when botStart() initialises the clock.
// Needed to compute fracRemaining = current / start.
let botStartClockMs = null;
// Last known opponent clock in ms — updated after each move, used by diffModifier.
let botOppClockMs = null;

// ── Bot time behavior ─────────────────────────────────────────────────────────
// 'pace'    — existing behavior: entropy-based delay derived from botPace slider
// 'instant' — no artificial delay (engine still runs, result played immediately)
// 'mirror'  — bot wait time ≈ rolling average of human's recent move times (±20% jitter)
let botTimeBehavior = 'pace'; // 'pace' | 'instant' | 'mirror' | 'fixed'
let botFixedDelayMs = 5000;        // ms for 'fixed' timing mode (default 5 s)
let botMirrorOffsetPct = 0;        // % speed offset for 'mirror' mode (-100..+100)
let botCplxBase = 3;               // complexity mode: base think time (s)
let botCplxMin  = 0.4;             // complexity mode: min multiplier (simple moves)
let botCplxMax  = 2.5;             // complexity mode: max multiplier (complex moves)
let botBehavReconsider  = true;    // human behaviour: reconsideration pauses
let botBehavBlink       = true;    // human behaviour: instant play on forced moves
let botBehavClockMirror = true;    // human behaviour: speed up when opponent is low
let botCanFlag   = true;           // whether bot is allowed to flag (run clock to 0)
let botDayLower  = 0;              // probability-band range: lower percentile (0 = highest-probability end)
let botDayUpper  = 100;            // probability-band range: upper percentile (100 = all)
let botSfTempLevel = 2;            // temperature tier 0-4 (legacy; superseded by botSfVar1/2)
let botSfVar1 = 0;                 // % of SF calls at ±1 level (0–50)
let botSfVar2 = 0;                 // % of SF calls at ±2 level (0–20)
let botTimePressureMaxDrop = null; // max ELO drop from r-drop; null = use DOM slider
let botMinProbPct       = 0;      // min absolute probability % — 0 = off (default); set by panel
let botBadDayMode       = false;  // Grandmaster Bad Day: pick lowest-probability move above minProbPct threshold
let botPressureCurveA   = null;   // ctrlA points [{x,y}] — ELO degradation vs think-time (s); seeded on the Regan model by the panel
let _botGameGen         = 0;      // bumped by botStart/botStop — in-flight botMakeMove awaits compare against it and discard stale engine replies
let botPressureCurveB   = null;   // ctrlB points [{x,y}] — confidence floor % vs think-time (s)
let botWeaponizerEnabled = false; // weaponizer: fast play when opponent is low on clock
let botWeaponizerTriggerMs = 15000; // activate once the opponent's clock is at or below this (ms)
let botWeaponizerMinMs   = 0;     // floor (ms) on weaponizer move time; 0 = instant, as if pre-moved
// ── Draw behaviour ───────────────────────────────────────────────────────────
let botAcceptDraws      = false;  // bot accepts draw offers when not clearly ahead
let botDrawAcceptMargin = 50;     // accept if bot's advantage ≤ this many cp (engine eval)
let botOfferDraws       = false;  // bot proactively offers draws in level positions
let botOfferDrawThresh  = 50;     // |advantage| ≤ this cp → position counts as level
let botOfferDrawMove    = 20;     // no offers before this full-move number
let _botLastDrawOfferPly = -99;   // ply of the bot's last draw offer (anti-spam)
// ── Stalemate seeking (desperation) ──────────────────────────────────────────
let botStaleSeek     = false;     // seek stalemate when losing badly
let botStaleSeekMove = 30;        // active from this full-move number
let botStaleSeekCp   = 500;       // and only when the bot is worse than −this cp

// Rolling window of the human player's move durations (ms), capped at N=6.
// x domain: 0–∞ ms (practically 200–30000 ms for most games)
// Reset each botStart(); mutated by botPostMoveHook() on human turns only.
const BOT_MIRROR_WINDOW = 6;   // how many recent human moves to average
let botUserMoveTimestamps = []; // circular buffer of human move durations (ms)
let botUserTurnStartMs   = null; // wall-clock ms when the human's current turn began



// ── Board sizing ──────────────────────────────────────────────────────
function resizeBoard() {
  const pageWrap = document.getElementById('page-wrap');
  const wrapW = pageWrap ? pageWrap.clientWidth : (window.innerWidth - 40);

  // Below the breakpoint the sidebar sits BELOW the board rather than beside
  // it, so its width is no longer competing for horizontal space — subtracting
  // it (as the desktop path does) yields a negative budget and pins the board
  // at its 280px floor. On phones the board gets the full column width, and
  // only the viewport height limits it.
  const stacked = window.matchMedia('(max-width:760px)').matches;
  const sidebar = document.getElementById('sidebar');
  const sidebarW = sidebar ? sidebar.offsetWidth : 240;
  // clientWidth includes padding, so subtract it — otherwise the board is sized
  // wider than the column that holds it. Stacked, that made the canvas render
  // non-square (CSS capped the width, the inline height kept the un-capped
  // value); side-by-side, it pushed #app past the viewport on narrow desktops
  // and tablets (~820px portrait), which is where the horizontal scroll there
  // came from.
  let padX = 0;
  if (pageWrap) {
    const cs = getComputedStyle(pageWrap);
    padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  }
  const avail = wrapW - padX;
  // 24 (not the gap's 12) leaves room for the canvas border and sub-pixel
  // rounding — at exactly 768px the old reserve overflowed the page by 4px.
  const maxFromWidth = stacked ? avail : (avail - sidebarW - 24);

  // Vertical space: measure header, use fixed estimates for player/footer
  const headerEl = document.getElementById('site-header');
  const topH     = (headerEl && headerEl.offsetHeight > 0 ? headerEl.offsetHeight : 40) + 8;
  const playerH  = 44 * 2 + 8; // two player boxes, fixed height
  const footerH  = 30;
  // Stacked layout scrolls, so the board may exceed the fold — reserve room for
  // the clocks and the settings toggle, but don't shrink it to fit everything.
  const maxFromHeight = stacked
    ? window.innerHeight - topH - playerH - 8
    : window.innerHeight - topH - playerH - footerH - 12;
  const boardPx = Math.max(280, Math.min(maxFromWidth, maxFromHeight, 900));
  const bpx = boardPx + 'px';
  const cv = document.getElementById('cv');
  if (cv) { cv.style.width = bpx; cv.style.height = bpx; }
  // Ghost canvas must match exactly
  const ghostEl = document.getElementById('ghostCanvas');
  if (ghostEl) { ghostEl.style.width = bpx; ghostEl.style.height = bpx; }
  // Player boxes must match exactly — use same value, no rounding difference
  ['playerBoxW','playerBoxB'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.width = bpx; el.style.maxWidth = bpx; }
  });
  document.documentElement.style.setProperty('--board-size', bpx);

}
window.addEventListener('resize', resizeBoard);

// ═══════════════════════════════════════════════════════════════════
// BLUNDERMIND — Complete chess engine + UI
// © 2026 Blundermind. All rights reserved.
// ═══════════════════════════════════════════════════════════════════

// ── Piece set data ──────────────────────────────────────────────────
// Staunton chess pieces (react-chess-pieces package, ISC license)
// ISC = MIT equivalent — safe for commercial use and donations
const PIECES_STAUNTON = {
  'wK': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0iZmlsbDogbm9uZTsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAyMi41LDI1IEMgMjIuNSwyNSAyNywxNy41IDI1LjUsMTQuNSBDIDI1LjUsMTQuNSAyNC41LDEyIDIyLjUsMTIgQyAyMC41LDEyIDE5LjUsMTQuNSAxOS41LDE0LjUgQyAxOCwxNy41IDIyLjUsMjUgMjIuNSwyNSIKICAgICAgICBzdHlsZT0iZmlsbDogI2ZmZmZmZjsgc3Ryb2tlOiAjMDAwMDAwOyBzdHJva2UtbGluZWNhcDogYnV0dDsgc3Ryb2tlLWxpbmVqb2luOiBtaXRlciIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMS41LDM3IEMgMTcsNDAuNSAyNyw0MC41IDMyLjUsMzcgTCAzMi41LDMwIEMgMzIuNSwzMCA0MS41LDI1LjUgMzguNSwxOS41IEMgMzQuNSwxMyAyNSwxNiAyMi41LDIzLjUgTCAyMi41LDI3IEwgMjIuNSwyMy41IEMgMTksMTYgOS41LDEzIDYuNSwxOS41IEMgMy41LDI1LjUgMTEuNSwyOS41IDExLjUsMjkuNSBMIDExLjUsMzcgeiAiCiAgICAgICAgc3R5bGU9ImZpbGw6ICNmZmZmZmY7IHN0cm9rZTogIzAwMDAwMCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMS41LDMwIEMgMTcsMjcgMjcsMjcgMzIuNSwzMCIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDExLjUsMzMuNSBDIDE3LDMwLjUgMjcsMzAuNSAzMi41LDMzLjUiCiAgICAgICAgc3R5bGU9ImZpbGw6IG5vbmU7IHN0cm9rZTogIzAwMDAwMCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMS41LDM3IEMgMTcsMzQgMjcsMzQgMzIuNSwzNyIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGggZD0iTSAyNSA4IEEgMi41IDIuNSAwIDEgMSAgMjAsOCBBIDIuNSAyLjUgMCAxIDEgIDI1IDggeiIgc3R5bGU9ImZpbGw6IG5vbmU7IHN0cm9rZTogIzAwMDAwMCIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  'wQ': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgIGZpbGw6ICNmZmZmZmY7IGZpbGwtb3BhY2l0eTogMTsgZmlsbC1ydWxlOiBldmVub2RkOyBzdHJva2U6ICMwMDAwMDA7IHN0cm9rZS13aWR0aDogMS41OyBzdHJva2UtbGluZWNhcDogcm91bmQ7IHN0cm9rZS1saW5lam9pbjogcm91bmQ7IHN0cm9rZS1taXRlcmxpbWl0OiA0OyBzdHJva2UtZGFzaGFycmF5OiBub25lOyBzdHJva2VPcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSA5IDEzIEEgMiAyIDAgMSAxICA1LDEzIEEgMiAyIDAgMSAxICA5IDEzIHoiCiAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTEsLTEpIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDkgMTMgQSAyIDIgMCAxIDEgIDUsMTMgQSAyIDIgMCAxIDEgIDkgMTMgeiIKICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNS41LC01LjUpIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDkgMTMgQSAyIDIgMCAxIDEgIDUsMTMgQSAyIDIgMCAxIDEgIDkgMTMgeiIKICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMiwtMSkiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gOSAxMyBBIDIgMiAwIDEgMSAgNSwxMyBBIDIgMiAwIDEgMSAgOSAxMyB6IgogICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDcsLTQuNSkiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gOSAxMyBBIDIgMiAwIDEgMSAgNSwxMyBBIDIgMiAwIDEgMSAgOSAxMyB6IgogICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDI0LC00KSIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSA5LDI2IEMgMTcuNSwyNC41IDMwLDI0LjUgMzYsMjYgTCAzOCwxNCBMIDMxLDI1IEwgMzEsMTEgTCAyNS41LDI0LjUgTCAyMi41LDkuNSBMIDE5LjUsMjQuNSBMIDE0LDEwLjUgTCAxNCwyNSBMIDcsMTQgTCA5LDI2IHogIgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSA5LDI2IEMgOSwyOCAxMC41LDI4IDExLjUsMzAgQyAxMi41LDMxLjUgMTIuNSwzMSAxMiwzMy41IEMgMTAuNSwzNC41IDEwLjUsMzYgMTAuNSwzNiBDIDksMzcuNSAxMSwzOC41IDExLDM4LjUgQyAxNy41LDM5LjUgMjcuNSwzOS41IDM0LDM4LjUgQyAzNCwzOC41IDM1LjUsMzcuNSAzNCwzNiBDIDM0LDM2IDM0LjUsMzQuNSAzMywzMy41IEMgMzIuNSwzMSAzMi41LDMxLjUgMzMuNSwzMCBDIDM0LjUsMjggMzYsMjggMzYsMjYgQyAyNy41LDI0LjUgMTcuNSwyNC41IDksMjYgeiAiCiAgICAgICAgc3R5bGU9InN0cm9rZS1saW5lY2FwOiBidXR0IiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDExLjUsMzAgQyAxNSwyOSAzMCwyOSAzMy41LDMwIgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDEyLDMzLjUgQyAxOCwzMi41IDI3LDMyLjUgMzMsMzMuNSIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZSIvPgogIDwvZz4KPC9zdmc+Cg==',
  'wR': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogI2ZmZmZmZjsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSA5LDM5IEwgMzYsMzkgTCAzNiwzNiBMIDksMzYgTCA5LDM5IHogIgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMiwzNiBMIDEyLDMyIEwgMzMsMzIgTCAzMywzNiBMIDEyLDM2IHogIgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMSwxNCBMIDExLDkgTCAxNSw5IEwgMTUsMTEgTCAyMCwxMSBMIDIwLDkgTCAyNSw5IEwgMjUsMTEgTCAzMCwxMSBMIDMwLDkgTCAzNCw5IEwgMzQsMTQiCiAgICAgICAgc3R5bGU9InN0cm9rZS1saW5lY2FwOiBidXR0IiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDM0LDE0IEwgMzEsMTcgTCAxNCwxNyBMIDExLDE0IiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDMxLDE3IEwgMzEsMjkuNSBMIDE0LDI5LjUgTCAxNCwxNyIKICAgICAgICBzdHlsZT0ic3Ryb2tlTC1saW5lY2FwOiBidXR0OyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDMxLDI5LjUgTCAzMi41LDMyIEwgMTIuNSwzMiBMIDE0LDI5LjUiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTEsMTQgTCAzNCwxNCIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjMDAwMDAwOyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogIDwvZz4KPC9zdmc+Cg==',
  'wB': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogbm9uZTsgZmlsbC1ydWxlOiBldmVub2RkOyBmaWxsLW9wYWNpdHk6IDE7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxnIHN0eWxlPSJmaWxsOiAjZmZmZmZmOyBzdHJva2U6ICMwMDAwMDA7IHN0cm9rZS1saW5lY2FwOiBidXR0Ij4gCiAgICAgIDxwYXRoIGQ9Ik0gOSwzNiBDIDEyLjM5LDM1LjAzIDE5LjExLDM2LjQzIDIyLjUsMzQgQyAyNS44OSwzNi40MyAzMi42MSwzNS4wMyAzNiwzNiBDIDM2LDM2IDM3LjY1LDM2LjU0IDM5LDM4IEMgMzguMzIsMzguOTcgMzcuMzUsMzguOTkgMzYsMzguNSBDIDMyLjYxLDM3LjUzIDI1Ljg5LDM4Ljk2IDIyLjUsMzcuNSBDIDE5LjExLDM4Ljk2IDEyLjM5LDM3LjUzIDksMzguNSBDIDcuNjQ2LDM4Ljk5IDYuNjc3LDM4Ljk3IDYsMzggQyA3LjM1NCwzNi4wNiA5LDM2IDksMzYgeiIvPgogICAgICA8cGF0aCBkPSJNIDE1LDMyIEMgMTcuNSwzNC41IDI3LjUsMzQuNSAzMCwzMiBDIDMwLjUsMzAuNSAzMCwzMCAzMCwzMCBDIDMwLDI3LjUgMjcuNSwyNiAyNy41LDI2IEMgMzMsMjQuNSAzMy41LDE0LjUgMjIuNSwxMC41IEMgMTEuNSwxNC41IDEyLDI0LjUgMTcuNSwyNiBDIDE3LjUsMjYgMTUsMjcuNSAxNSwzMCBDIDE1LDMwIDE0LjUsMzAuNSAxNSwzMiB6Ii8+CiAgICAgIDxwYXRoIGQ9Ik0gMjUgOCBBIDIuNSAyLjUgMCAxIDEgIDIwLDggQSAyLjUgMi41IDAgMSAxICAyNSA4IHoiLz4KICAgIDwvZz4KICAgIDxwYXRoIGQ9Ik0gMTcuNSwyNiBMIDI3LjUsMjYgTSAxNSwzMCBMIDMwLDMwIE0gMjUgMTYgQSAyLjUgMi41IDAgMSAxICAyMCwxNiBBIDIuNSAyLjUgMCAxIDEgIDI1IDE2IHoiIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICMwMDAwMDA7IHN0cm9rZS1saW5lam9pbjogbWl0ZXIiLz4KICA8L2c+Cjwvc3ZnPgo=',
  'wN': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogbm9uZTsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAyMiwxMCBDIDMyLjUsMTEgMzguNSwxOCAzOCwzOSBMIDE1LDM5IEMgMTUsMzAgMjUsMzIuNSAyMywxOCIKICAgICAgICBzdHlsZT0iZmlsbDogI2ZmZmZmZjsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDI0LDE4IEMgMjQuMzgsMjAuOTEgMTguNDUsMjUuMzcgMTYsMjcgQyAxMywyOSAxMy4xOCwzMS4zNCAxMSwzMSBDIDkuOTU4LDMwLjA2IDEyLjQxLDI3Ljk2IDExLDI4IEMgMTAsMjggMTEuMTksMjkuMjMgMTAsMzAgQyA5LDMwIDUuOTk3LDMxIDYsMjYgQyA2LDI0IDEyLDE0IDEyLDE0IEMgMTIsMTQgMTMuODksMTIuMSAxNCwxMC41IEMgMTMuMjcsOS41MDYgMTMuNSw4LjUgMTMuNSw3LjUgQyAxNC41LDYuNSAxNi41LDEwIDE2LjUsMTAgTCAxOC41LDEwIEMgMTguNSwxMCAxOS4yOCw4LjAwOCAyMSw3IEMgMjIsNyAyMiwxMCAyMiwxMCIKICAgICAgICBzdHlsZT0iZmlsbDogI2ZmZmZmZjsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDkuNSAyNS41IEEgMC41IDAuNSAwIDEgMSA4LjUsMjUuNSBBIDAuNSAwLjUgMCAxIDEgOS41IDI1LjUgeiIKICAgICAgICBzdHlsZT0iZmlsbDogIzAwMDAwMDsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDE1IDE1LjUgQSAwLjUgMS41IDAgMSAxICAxNCwxNS41IEEgMC41IDEuNSAwIDEgMSAgMTUgMTUuNSB6IgogICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuODY2LDAuNSwtMC41LDAuODY2LDkuNjkzLC01LjE3MykiCiAgICAgICAgc3R5bGU9ImZpbGw6ICMwMDAwMDA7IHN0cm9rZTogIzAwMDAwMCIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  'wP': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8Zz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAyMiw5IEMgMTkuNzksOSAxOCwxMC43OSAxOCwxMyBDIDE4LDEzLjg5IDE4LjI5LDE0LjcxIDE4Ljc4LDE1LjM4IEMgMTYuODMsMTYuNSAxNS41LDE4LjU5IDE1LjUsMjEgQyAxNS41LDIzLjAzIDE2LjQ0LDI0Ljg0IDE3LjkxLDI2LjAzIEMgMTQuOTEsMjcuMDkgMTAuNSwzMS41OCAxMC41LDM5LjUgTCAzMy41LDM5LjUgQyAzMy41LDMxLjU4IDI5LjA5LDI3LjA5IDI2LjA5LDI2LjAzIEMgMjcuNTYsMjQuODQgMjguNSwyMy4wMyAyOC41LDIxIEMgMjguNSwxOC41OSAyNy4xNywxNi41IDI1LjIyLDE1LjM4IEMgMjUuNzEsMTQuNzEgMjYsMTMuODkgMjYsMTMgQyAyNiwxMC43OSAyNC4yMSw5IDIyLDkgeiAiCiAgICAgICAgc3R5bGU9Im9wYWNpdHk6IDE7IGZpbGw6ICNmZmZmZmY7IGZpbGwtb3BhY2l0eTogMTsgZmlsbC1ydWxlOiBub256ZXJvOyBzdHJva2U6ICMwMDAwMDA7IHN0cm9rZS13aWR0aDogMS41OyBzdHJva2UtbGluZWNhcDogcm91bmQ7IHN0cm9rZS1saW5lam9pbjogbWl0ZXI7IHN0cm9rZS1taXRlcmxpbWl0OiA0OyBzdHJva2UtZGFzaGFycmF5OiBub25lOyBzdHJva2Utb3BhY2l0eTogMSIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  'bK': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0iZmlsbDogbm9uZTsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoIGQ9Ik0gMjIuNSwyNSBDIDIyLjUsMjUgMjcsMTcuNSAyNS41LDE0LjUgQyAyNS41LDE0LjUgMjQuNSwxMiAyMi41LDEyIEMgMjAuNSwxMiAxOS41LDE0LjUgMTkuNSwxNC41IEMgMTgsMTcuNSAyMi41LDI1IDIyLjUsMjUiIHN0eWxlPSJmaWxsOiAjMDAwMDAwLCBmaWxsLW9wYWNpdHk6IDEsIHN0cm9rZS1saW5lY2FwOiBidXR0LCBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogICAgPHBhdGggZD0iTSAxMS41LDM3IEMgMTcsNDAuNSAyNyw0MC41IDMyLjUsMzcgTCAzMi41LDMwIEMgMzIuNSwzMCA0MS41LDI1LjUgMzguNSwxOS41IEMgMzQuNSwxMyAyNSwxNiAyMi41LDIzLjUgTCAyMi41LDI3IEwgMjIuNSwyMy41IEMgMTksMTYgOS41LDEzIDYuNSwxOS41IEMgMy41LDI1LjUgMTEuNSwyOS41IDExLjUsMjkuNSBMIDExLjUsMzcgeiAiIHN0eWxlPSJmaWxsOiAjMDAwMDAwOyBzdHJva2U6ICMwMDAwMDAiLz4KICAgIDxwYXRoIGQ9Ik0gMzIsMjkuNSBDIDMyLDI5LjUgNDAuNSwyNS41IDM4LjAzLDE5Ljg1IEMgMzQuMTUsMTQgMjUsMTggMjIuNSwyNC41IEwgMjIuNTEsMjYuNiBMIDIyLjUsMjQuNSBDIDIwLDE4IDkuOTA2LDE0IDYuOTk3LDE5Ljg1IEMgNC41LDI1LjUgMTEuODUsMjguODUgMTEuODUsMjguODUiIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmYiIC8+CiAgICA8cGF0aCBkPSJNIDExLjUsMzAgQyAxNywyNyAyNywyNyAzMi41LDMwIE0gMTEuNSwzMy41IEMgMTcsMzAuNSAyNywzMC41IDMyLjUsMzMuNSBNIDExLjUsMzcgQyAxNywzNCAyNywzNCAzMi41LDM3IiBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjZmZmZmZmIiAvPgogICAgPHBhdGggZD0iTSAyNSA4IEEgMi41IDIuNSAwIDEgMSAgMjAsOCBBIDIuNSAyLjUgMCAxIDEgIDI1IDggeiIgc3R5bGU9ImZpbGw6ICNmZmZmZmY7IHN0cm9rZTogIzAwMDAwMCIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  'bQ': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogIzAwMDAwMDsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxnIHN0eWxlPSJmaWxsOiAjMDAwMDAwOyBzdHJva2U6IG5vbmUiPgogICAgICA8Y2lyY2xlIGN4PSI2IiAgICBjeT0iMTIiIHI9IjIuNzUiIC8+CiAgICAgIDxjaXJjbGUgY3g9IjE0IiAgIGN5PSI5IiAgcj0iMi43NSIgLz4KICAgICAgPGNpcmNsZSBjeD0iMjIuNSIgY3k9IjgiICByPSIyLjc1IiAvPgogICAgICA8Y2lyY2xlIGN4PSIzMSIgICBjeT0iOSIgIHI9IjIuNzUiIC8+CiAgICAgIDxjaXJjbGUgY3g9IjM5IiAgIGN5PSIxMiIgcj0iMi43NSIgLz4KICAgIDwvZz4KICAgIDxwYXRoIGQ9Ik0gOSwyNiBDIDE3LjUsMjQuNSAzMCwyNC41IDM2LDI2IEwgMzguNSwxMy41IEwgMzEsMjUgTCAzMC43LDEwLjkgTCAyNS41LDI0LjUgTCAyMi41LDEwIEwgMTkuNSwyNC41IEwgMTQuMywxMC45IEwgMTQsMjUgTCA2LjUsMTMuNSBMIDksMjYgeiIKICAgICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dDsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDksMjYgQyA5LDI4IDEwLjUsMjggMTEuNSwzMCBDIDEyLjUsMzEuNSAxMi41LDMxIDEyLDMzLjUgQyAxMC41LDM0LjUgMTAuNSwzNiAxMC41LDM2IEMgOSwzNy41IDExLDM4LjUgMTEsMzguNSBDIDE3LjUsMzkuNSAyNy41LDM5LjUgMzQsMzguNSBDIDM0LDM4LjUgMzUuNSwzNy41IDM0LDM2IEMgMzQsMzYgMzQuNSwzNC41IDMzLDMzLjUgQyAzMi41LDMxIDMyLjUsMzEuNSAzMy41LDMwIEMgMzQuNSwyOCAzNiwyOCAzNiwyNiBDIDI3LjUsMjQuNSAxNy41LDI0LjUgOSwyNiB6IgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMSwzOC41IEEgMzUsMzUgMSAwIDAgMzQsMzguNSIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjMDAwMDAwOyBzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMSwyOSBBIDM1LDM1IDEgMCAxIDM0LDI5IgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmYiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTIuNSwzMS41IEwgMzIuNSwzMS41IgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmYiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTEuNSwzNC41IEEgMzUsMzUgMSAwIDAgMzMuNSwzNC41IgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmYiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTAuNSwzNy41IEEgMzUsMzUgMSAwIDAgMzQuNSwzNy41IgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmYiIC8+CiAgPC9nPgo8L3N2Zz4K',
  'bR': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogIzAwMDAwMDsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSA5LDM5IEwgMzYsMzkgTCAzNiwzNiBMIDksMzYgTCA5LDM5IHogIgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMi41LDMyIEwgMTQsMjkuNSBMIDMxLDI5LjUgTCAzMi41LDMyIEwgMTIuNSwzMiB6ICIKICAgICAgICBzdHlsZT0ic3Ryb2tlLWxpbmVjYXA6IGJ1dHQiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTIsMzYgTCAxMiwzMiBMIDMzLDMyIEwgMzMsMzYgTCAxMiwzNiB6ICIKICAgICAgICBzdHlsZT0ic3Ryb2tlLWxpbmVjYXA6IGJ1dHQiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTQsMjkuNSBMIDE0LDE2LjUgTCAzMSwxNi41IEwgMzEsMjkuNSBMIDE0LDI5LjUgeiAiCiAgICAgICAgc3R5bGU9InN0cm9rZS1saW5lY2FwOiBidXR0OyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDE0LDE2LjUgTCAxMSwxNCBMIDM0LDE0IEwgMzEsMTYuNSBMIDE0LDE2LjUgeiAiCiAgICAgICAgc3R5bGU9InN0cm9rZS1saW5lY2FwOiBidXR0IiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDExLDE0IEwgMTEsOSBMIDE1LDkgTCAxNSwxMSBMIDIwLDExIEwgMjAsOSBMIDI1LDkgTCAyNSwxMSBMIDMwLDExIEwgMzAsOSBMIDM0LDkgTCAzNCwxNCBMIDExLDE0IHogIgogICAgICAgIHN0eWxlPSJzdHJva2UtbGluZWNhcDogYnV0dCIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxMiwzNS41IEwgMzMsMzUuNSBMIDMzLDM1LjUiCiAgICAgICAgc3R5bGU9ImZpbGw6IG5vbmU7IHN0cm9rZTogI2ZmZmZmZjsgc3Ryb2tlLXdpZHRoOiAxOyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDEzLDMxLjUgTCAzMiwzMS41IgogICAgICAgIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmY7IHN0cm9rZS13aWR0aDogMTsgc3Ryb2tlLWxpbmVqb2luOiBtaXRlciIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAxNCwyOS41IEwgMzEsMjkuNSIKICAgICAgICBzdHlsZT0iZmlsbDogbm9uZTsgc3Ryb2tlOiAjZmZmZmZmOyBzdHJva2Utd2lkdGg6IDE7IHN0cm9rZS1saW5lam9pbjogbWl0ZXIiIC8+CiAgICA8cGF0aAogICAgICAgIGQ9Ik0gMTQsMTYuNSBMIDMxLDE2LjUiCiAgICAgICAgc3R5bGU9ImZpbGw6IG5vbmU7IHN0cm9rZTogI2ZmZmZmZjsgc3Ryb2tlLXdpZHRoOiAxOyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDExLDE0IEwgMzQsMTQiCiAgICAgICAgc3R5bGU9ImZpbGw6IG5vbmU7IHN0cm9rZTogI2ZmZmZmZjsgc3Ryb2tlLXdpZHRoOiAxOyBzdHJva2UtbGluZWpvaW46IG1pdGVyIiAvPgogIDwvZz4KPC9zdmc+Cg==',
  'bB': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogbm9uZTsgZmlsbC1ydWxlOiBldmVub2RkOyBmaWxsLW9wYWNpdHk6IDE7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxnIHN0eWxlPSJmaWxsOiAjMDAwMDAwOyBzdHJva2U6ICMwMDAwMDA7IHN0cm9rZS1saW5lY2FwOiBidXR0Ij4gCiAgICAgIDxwYXRoIGQ9Ik0gOSwzNiBDIDEyLjM5LDM1LjAzIDE5LjExLDM2LjQzIDIyLjUsMzQgQyAyNS44OSwzNi40MyAzMi42MSwzNS4wMyAzNiwzNiBDIDM2LDM2IDM3LjY1LDM2LjU0IDM5LDM4IEMgMzguMzIsMzguOTcgMzcuMzUsMzguOTkgMzYsMzguNSBDIDMyLjYxLDM3LjUzIDI1Ljg5LDM4Ljk2IDIyLjUsMzcuNSBDIDE5LjExLDM4Ljk2IDEyLjM5LDM3LjUzIDksMzguNSBDIDcuNjQ2LDM4Ljk5IDYuNjc3LDM4Ljk3IDYsMzggQyA3LjM1NCwzNi4wNiA5LDM2IDksMzYgeiIvPgogICAgICA8cGF0aCBkPSJNIDE1LDMyIEMgMTcuNSwzNC41IDI3LjUsMzQuNSAzMCwzMiBDIDMwLjUsMzAuNSAzMCwzMCAzMCwzMCBDIDMwLDI3LjUgMjcuNSwyNiAyNy41LDI2IEMgMzMsMjQuNSAzMy41LDE0LjUgMjIuNSwxMC41IEMgMTEuNSwxNC41IDEyLDI0LjUgMTcuNSwyNiBDIDE3LjUsMjYgMTUsMjcuNSAxNSwzMCBDIDE1LDMwIDE0LjUsMzAuNSAxNSwzMiB6Ii8+CiAgICAgIDxwYXRoIGQ9Ik0gMjUgOCBBIDIuNSAyLjUgMCAxIDEgIDIwLDggQSAyLjUgMi41IDAgMSAxICAyNSA4IHoiLz4KICAgIDwvZz4KICAgIDxwYXRoIGQ9Ik0gMTcuNSwyNiBMIDI3LjUsMjYgTSAxNSwzMCBMIDMwLDMwIE0gMjUgMTYgQSAyLjUgMi41IDAgMSAxICAyMCwxNiBBIDIuNSAyLjUgMCAxIDEgIDI1IDE2IHoiIHN0eWxlPSJmaWxsOiBub25lOyBzdHJva2U6ICNmZmZmZmY7IHN0cm9rZS1saW5lam9pbjogbWl0ZXIiLz4KICA8L2c+Cjwvc3ZnPgo=',
  'bN': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8ZyBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogbm9uZTsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IGV2ZW5vZGQ7IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiByb3VuZDsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIj4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAyMiwxMCBDIDMyLjUsMTEgMzguNSwxOCAzOCwzOSBMIDE1LDM5IEMgMTUsMzAgMjUsMzIuNSAyMywxOCIKICAgICAgICBzdHlsZT0iZmlsbDogIzAwMDAwMDsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDI0LDE4IEMgMjQuMzgsMjAuOTEgMTguNDUsMjUuMzcgMTYsMjcgQyAxMywyOSAxMy4xOCwzMS4zNCAxMSwzMSBDIDkuOTU4LDMwLjA2IDEyLjQxLDI3Ljk2IDExLDI4IEMgMTAsMjggMTEuMTksMjkuMjMgMTAsMzAgQyA5LDMwIDUuOTk3LDMxIDYsMjYgQyA2LDI0IDEyLDE0IDEyLDE0IEMgMTIsMTQgMTMuODksMTIuMSAxNCwxMC41IEMgMTMuMjcsOS41MDYgMTMuNSw4LjUgMTMuNSw3LjUgQyAxNC41LDYuNSAxNi41LDEwIDE2LjUsMTAgTCAxOC41LDEwIEMgMTguNSwxMCAxOS4yOCw4LjAwOCAyMSw3IEMgMjIsNyAyMiwxMCAyMiwxMCIKICAgICAgICBzdHlsZT0iZmlsbDogIzAwMDAwMDsgc3Ryb2tlOiAjMDAwMDAwIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDkuNSAyNS41IEEgMC41IDAuNSAwIDEgMSA4LjUsMjUuNSBBIDAuNSAwLjUgMCAxIDEgOS41IDI1LjUgeiIKICAgICAgICBzdHlsZT0iZmlsbDogI2ZmZmZmZjsgc3Ryb2tlOiAjZmZmZmZmIiAvPgogICAgPHBhdGgKICAgICAgICBkPSJNIDE1IDE1LjUgQSAwLjUgMS41IDAgMSAxICAxNCwxNS41IEEgMC41IDEuNSAwIDEgMSAgMTUgMTUuNSB6IgogICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuODY2LDAuNSwtMC41LDAuODY2LDkuNjkzLC01LjE3MykiCiAgICAgICAgc3R5bGU9ImZpbGw6ICNmZmZmZmY7IHN0cm9rZTogI2ZmZmZmZiIgLz4KICAgIDxwYXRoCiAgICAgICAgZD0iTSAyNC41NSwxMC40IEwgMjQuMSwxMS44NSBMIDI0LjYsMTIgQyAyNy43NSwxMyAzMC4yNSwxNC40OSAzMi41LDE4Ljc1IEMgMzQuNzUsMjMuMDEgMzUuNzUsMjkuMDYgMzUuMjUsMzkgTCAzNS4yLDM5LjUgTCAzNy40NSwzOS41IEwgMzcuNSwzOSBDIDM4LDI4Ljk0IDM2LjYyLDIyLjE1IDM0LjI1LDE3LjY2IEMgMzEuODgsMTMuMTcgMjguNDYsMTEuMDIgMjUuMDYsMTAuNSBMIDI0LjU1LDEwLjQgeiAiCiAgICAgICAgc3R5bGU9ImZpbGw6ICNmZmZmZmY7IHN0cm9rZTogbm9uZSIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  'bP': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NSA0NSIgd2lkdGg9IjQ1IiBoZWlnaHQ9IjQ1Ij4KICA8Zz4KICAgIDxwYXRoIGQ9Ik0gMjIsOSBDIDE5Ljc5LDkgMTgsMTAuNzkgMTgsMTMgQyAxOCwxMy44OSAxOC4yOSwxNC43MSAxOC43OCwxNS4zOCBDIDE2LjgzLDE2LjUgMTUuNSwxOC41OSAxNS41LDIxIEMgMTUuNSwyMy4wMyAxNi40NCwyNC44NCAxNy45MSwyNi4wMyBDIDE0LjkxLDI3LjA5IDEwLjUsMzEuNTggMTAuNSwzOS41IEwgMzMuNSwzOS41IEMgMzMuNSwzMS41OCAyOS4wOSwyNy4wOSAyNi4wOSwyNi4wMyBDIDI3LjU2LDI0Ljg0IDI4LjUsMjMuMDMgMjguNSwyMSBDIDI4LjUsMTguNTkgMjcuMTcsMTYuNSAyNS4yMiwxNS4zOCBDIDI1LjcxLDE0LjcxIDI2LDEzLjg5IDI2LDEzIEMgMjYsMTAuNzkgMjQuMjEsOSAyMiw5IHogIiBzdHlsZT0ib3BhY2l0eTogMTsgZmlsbDogIzAwMDAwMDsgZmlsbC1vcGFjaXR5OiAxOyBmaWxsLXJ1bGU6IG5vbnplcm87IHN0cm9rZTogIzAwMDAwMDsgc3Ryb2tlLXdpZHRoOiAxLjU7IHN0cm9rZS1saW5lY2FwOiByb3VuZDsgc3Ryb2tlLWxpbmVqb2luOiBtaXRlcjsgc3Ryb2tlLW1pdGVybGltaXQ6IDQ7IHN0cm9rZS1kYXNoYXJyYXk6IG5vbmU7IHN0cm9rZS1vcGFjaXR5OiAxIi8+CiAgPC9nPgo8L3N2Zz4K',
};






// RhosGFX Vector Chess Pieces — CC0 Public Domain
// https://creativecommons.org/publicdomain/zero/1.0/
// Credits appreciated: RhosGFX (@RhosGFX on Twitter)
// Four piece styles: Solid, Outline, Wood, Flat
// Three board styles: Blue, Brown, Green

const PIECES_RHOSGFX_SOLID = {
  'wK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iUm91Z2giPgogICAgPGc+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMyIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxnPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTMzLjkzLDguNWg0LjEzYzEuMSwwLDIsLjksMiwyVjI3LjgyaC04LjEzVjEwLjVjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzYsMjcuMTZjLTcuMjgsMC0xMy44LDEuMzItMTguMjYsMy40Mi0xLjI3LC42LTEuOTMsMi4wMi0xLjU4LDMuMzhsNS4zLDIwLjY4aDI5LjA3bDUuMy0yMC42OGMuMzUtMS4zNi0uMzEtMi43OC0xLjU4LTMuMzgtNC40NS0yLjEtMTAuOTgtMy40Mi0xOC4yNi0zLjQyWiIvPgogICAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMzEuOTMiIHk9IjkuMjYiIHdpZHRoPSI4LjEzIiBoZWlnaHQ9IjE5LjMyIiByeD0iMiIgcnk9IjIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDU0LjkzIC0xNy4wNykgcm90YXRlKDkwKSIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM2LDQ5LjM1Yy02LjE2LDAtMTEuOTQtMS41My0xNi45Ny00LjIxbDIuNDQsOS41MWgyOS4wN2wyLjQ0LTkuNTFjLTUuMDMsMi42OC0xMC44MSw0LjIxLTE2Ljk3LDQuMjFaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny43OGwtMy4yNy0zLjE0SDIxLjQ3bC0zLjI3LDMuMTRjLS4wNSwuMDUtLjA5LC4xMS0uMTMsLjE2SDUzLjk0Yy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0xNy40Nyw2Mi4zM2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE4LjA2Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iUm91Z2giPgogICAgPGc+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMyIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxnPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTQ4Ljc5LDI3LjcxYzAsNy4wNi01LjczLDEyLjc5LTEyLjc5LDEyLjc5cy0xMi43OS01LjczLTEyLjc5LTEyLjc5LDUuNzMtOS44NSwxMi43OS05Ljg1LDEyLjc5LDIuNzksMTIuNzksOS44NVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01OC44NSwyNy42N2MtMi45Mi0yLjg3LTEwLjgyLTcuNjctMjIuODUsNy4wMi0xMi4wMy0xNC42OS0xOS45Mi05Ljg5LTIyLjg1LTcuMDItLjgyLC44LTEuMDcsMi4wMi0uNjYsMy4xbDguOTcsMjMuODhoMjkuMDdsOC45Ny0yMy44OGMuNC0xLjA3LC4xNi0yLjI5LS42Ni0zLjFaIi8+CiAgICAgICAgPGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIzNiIgY3k9IjE0LjM5IiByPSI1Ljg5Ii8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzYsNDkuMzVjLTYuNzUsMC0xMy4wNi0xLjg0LTE4LjQxLTUuMDJsMy44OCwxMC4zMWgyOS4wN2wzLjg4LTEwLjMxYy01LjM1LDMuMTgtMTEuNjYsNS4wMi0xOC40MSw1LjAyWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTUzLjgsNTcuNzhsLTMuMjctMy4xNEgyMS40N2wtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1My45NGMtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDgsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS41Ny0uMjItMS4xMS0uNTktMS41NEgxOC4wNmMtLjM3LC40My0uNTksLjk3LS41OSwxLjU0djIuODVaIi8+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'wR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iUm91Z2giPgogICAgPGc+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMyIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxnPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTUzLjgsNTcuNjJsLTMuMjctMy4xNEgyMS40NmwtMy4yNywzLjE0Yy0uMTEsLjExLS4yMSwuMjItLjI5LC4zNEg1NC4wOWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDcsNjIuMTdjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjEuNDYiIHk9IjMzLjc0IiB3aWR0aD0iMjkuMDciIGhlaWdodD0iMjAuNzQiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMS40NiwzMy43NGwtMy40OC00LjM2Yy0uMzMtLjQyLS41MS0uOTMtLjUxLTEuNDZ2LTcuMTRINTQuNTN2Ny4xNGMwLC41My0uMTgsMS4wNS0uNTEsMS40NmwtMy40OCw0LjM2SDIxLjQ2WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE5LjQ3LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00Ny44OCwxNS41Nmg0LjY1YzEuMSwwLDIsLjksMiwydjMuMjJoLTguNjV2LTMuMjJjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzMuNjcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTU0LjUzLDI3LjkySDE3LjQ3YzAsLjUzLC4xOCwxLjA1LC41MSwxLjQ2bDMuNDgsNC4zNmgyOS4wN2wzLjQ4LTQuMzZjLjMzLS40MiwuNTEtLjkzLC41MS0xLjQ2WiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQgewogICAgICAgIGZpbGw6ICM5NmRiZmY7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTkuNjgsNDEuNGMwLDkuMDEsNy4zMSwxNi4zMiwxNi4zMiwxNi4zMnMxNi4zMi03LjMxLDE2LjMyLTE2LjMyUzM2LDE0LjM5LDM2LDE0LjM5YzAsMC0xNi4zMiwxOC0xNi4zMiwyNy4wMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny43OGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFIMjMuMzVjLTEuMjEsMC0yLjM4LC40Ny0zLjI1LDEuMzFsLTEuOTEsMS44M2MtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzRINTQuMWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDcsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNCIgZD0iTTM2LDM0Ljk0YzMuODgsMCw3LjQ4LDEuMzIsMTAuNDksMy42LC45LC42OCwyLjExLS4zNCwxLjYxLTEuMzUtMi45Ny02LjAzLTcuMjktOS44My0xMi4xLTkuODNzLTkuMTMsMy44LTEyLjEsOS44M2MtLjUsMS4wMSwuNzEsMi4wMywxLjYxLDEuMzUsMy4wMS0yLjI3LDYuNjEtMy42LDEwLjQ5LTMuNloiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQgewogICAgICAgIGZpbGw6ICM5NmRiZmY7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTguOSw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE5LjQ5Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00Ni43NCwxNy4zOWMtNS40Ny00LjYyLTEzLjktMy44NC0xOS4yLS40MmgwYy0yLjk3LDEuOTMtMy41OSw1LjA5LTMuNTksNS4wOWwtMS4zMiw0LjI5Yy0uMzMsMS4wNi0uOSwyLjAyLTEuNjcsMi44MWwtMy44NSwzLjkzYy0xLjY3LDEuNzEtMS4zMiw0LjUyLC43MSw1Ljc3bC43OCwuNDJjMS41NiwuODYsMy40NiwuODMsNS0uMDYsLjgxLS41NSwxLjgyLS42NywyLjc2LS4zOSw1LjI3LDEuNTYsOS41Mi0yLjY3LDkuNTItMi42Ny0uNDUsNC43Ni0yLjk0LDYuMDUtNC44Myw3LjA0LTguMjksNC4zMi04LjE1LDExLjI5LTguMTUsMTEuMjloMjkuMDdjNi4xLTIxLjE5LDEuMDUtMzEuOC01LjIzLTM3LjA5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNCIgZD0iTTMzLjc0LDIzLjk4Yy0uMDQtLjUzLS40Ny0uOTYtMS0xLTEuMDQtLjA5LTIuMTUsLjI5LTIuOTksMS4xMy0uODQsLjg0LTEuMjIsMS45NC0xLjEzLDIuOTksLjA0LC41MywuNDcsLjk2LDEsMSwxLjA0LC4wOSwyLjE1LS4yOSwyLjk5LTEuMTMsLjg0LS44NCwxLjIyLTEuOTQsMS4xMy0yLjk5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM3LjQzLDUwLjgxYy00LjM3LDAtOC40Ni0xLjExLTExLjk3LTMuMDQtMi42MywzLjQ1LTIuNTcsNi43Mi0yLjU3LDYuNzJoMjkuMDdjMS4wNy0zLjcyLDEuNzktNy4xMiwyLjIzLTEwLjIxLTQuMjcsNC4wMy0xMC4yLDYuNTQtMTYuNzcsNi41NFoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iUm91Z2giPgogICAgPGc+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMyIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxnPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTQ5LjY5LDU3LjMzbC05LjEzLTE0LjQyaC05LjExbC05LjEzLDE0LjQyYy0uMTIsLjItLjIzLC40LS4zMiwuNjFoMjguMDFjLS4wOS0uMjEtLjE5LS40Mi0uMzItLjYxWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTIxLjU4LDU5Ljg0djIuNDljMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3aDI2LjQ4Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi40OWMwLS4xMi0uMDItLjI0LS4wMy0uMzYtLjA0LS41My0uMTctMS4wNS0uMzgtMS41NEgyMS45OWMtLjIxLC40OS0uMzQsMS4wMS0uMzgsMS41NCwwLC4xMi0uMDMsLjI0LS4wMywuMzZaIi8+CiAgICAgICAgPGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIzNiIgY3k9IjMyLjM0IiByPSIxMC40NCIvPgogICAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjYuOTUiIHk9IjQwLjUiIHdpZHRoPSIxOC4xMSIgaGVpZ2h0PSI2LjA1IiByeD0iMiIgcnk9IjIiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzMuOTMsOC41aDQuMTNjMS4xLDAsMiwuOSwyLDJWMjcuODJoLTguMTNWMTAuNWMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0zNiwyNy4xNmMtNy4yOCwwLTEzLjgsMS4zMi0xOC4yNiwzLjQyLTEuMjcsLjYtMS45MywyLjAyLTEuNTgsMy4zOGw1LjMsMjAuNjhoMjkuMDdsNS4zLTIwLjY4Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOC00LjQ1LTIuMS0xMC45OC0zLjQyLTE4LjI2LTMuNDJaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzMS45MyIgeT0iOS4yNiIgd2lkdGg9IjguMTMiIGhlaWdodD0iMTkuMzIiIHJ4PSIyIiByeT0iMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNTQuOTMgLTE3LjA3KSByb3RhdGUoOTApIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzYsNDkuMzVjLTYuMTYsMC0xMS45NC0xLjUzLTE2Ljk3LTQuMjFsMi40NCw5LjUxaDI5LjA3bDIuNDQtOS41MWMtNS4wMywyLjY4LTEwLjgxLDQuMjEtMTYuOTcsNC4yMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3Ljc4bC0zLjI3LTMuMTRIMjEuNDdsLTMuMjcsMy4xNGMtLjA1LC4wNS0uMDksLjExLS4xMywuMTZINTMuOTRjLS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTE3LjQ3LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTguMDZjLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNDguNzksMjcuNzFjMCw3LjA2LTUuNzMsMTIuNzktMTIuNzksMTIuNzlzLTEyLjc5LTUuNzMtMTIuNzktMTIuNzksNS43My05Ljg1LDEyLjc5LTkuODUsMTIuNzksMi43OSwxMi43OSw5Ljg1WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTU4Ljg1LDI3LjY3Yy0yLjkyLTIuODctMTAuODItNy42Ny0yMi44NSw3LjAyLTEyLjAzLTE0LjY5LTE5LjkyLTkuODktMjIuODUtNy4wMi0uODIsLjgtMS4wNywyLjAyLS42NiwzLjFsOC45NywyMy44OGgyOS4wN2w4Ljk3LTIzLjg4Yy40LTEuMDcsLjE2LTIuMjktLjY2LTMuMVoiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMSIgY3g9IjM2IiBjeT0iMTQuMzkiIHI9IjUuODkiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0zNiw0OS4zNWMtNi43NSwwLTEzLjA2LTEuODQtMTguNDEtNS4wMmwzLjg4LDEwLjMxaDI5LjA3bDMuODgtMTAuMzFjLTUuMzUsMy4xOC0xMS42Niw1LjAyLTE4LjQxLDUuMDJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny43OGwtMy4yNy0zLjE0SDIxLjQ3bC0zLjI3LDMuMTRjLS4wNSwuMDUtLjA5LC4xMS0uMTMsLjE2SDUzLjk0Yy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0xNy40OCw2Mi4zM2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE4LjA2Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny42MmwtMy4yNy0zLjE0SDIxLjQ2bC0zLjI3LDMuMTRjLS4xMSwuMTEtLjIxLC4yMi0uMjksLjM0SDU0LjA5Yy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNFoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0xNy40Nyw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjQ5LS4xNS0uOTYtLjQzLTEuMzVIMTcuOWMtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyMS40NiIgeT0iMzMuNzQiIHdpZHRoPSIyOS4wNyIgaGVpZ2h0PSIyMC43NCIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIxLjQ2LDMzLjc0bC0zLjQ4LTQuMzZjLS4zMy0uNDItLjUxLS45My0uNTEtMS40NnYtNy4xNEg1NC41M3Y3LjE0YzAsLjUzLS4xOCwxLjA1LS41MSwxLjQ2bC0zLjQ4LDQuMzZIMjEuNDZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTkuNDcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTQ3Ljg4LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0zMy42NywxNS41Nmg0LjY1YzEuMSwwLDIsLjksMiwydjMuMjJoLTguNjV2LTMuMjJjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTQuNTMsMjcuOTJIMTcuNDdjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2aDI5LjA3bDMuNDgtNC4zNmMuMzMtLjQyLC41MS0uOTMsLjUxLTEuNDZaIi8+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'bB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTkuNjgsNDEuNGMwLDkuMDEsNy4zMSwxNi4zMiwxNi4zMiwxNi4zMnMxNi4zMi03LjMxLDE2LjMyLTE2LjMyUzM2LDE0LjM5LDM2LDE0LjM5YzAsMC0xNi4zMiwxOC0xNi4zMiwyNy4wMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny43OGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFIMjMuMzVjLTEuMjEsMC0yLjM4LC40Ny0zLjI1LDEuMzFsLTEuOTEsMS44M2MtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzRINTQuMWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTcuNDcsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTM2LDM0Ljk0YzMuODgsMCw3LjQ4LDEuMzIsMTAuNDksMy42LC45LC42OCwyLjExLS4zNCwxLjYxLTEuMzUtMi45Ny02LjAzLTcuMjktOS44My0xMi4xLTkuODNzLTkuMTMsMy44LTEyLjEsOS44M2MtLjUsMS4wMSwuNzEsMi4wMywxLjYxLDEuMzUsMy4wMS0yLjI3LDYuNjEtMy42LDEwLjQ5LTMuNloiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTguOSw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE5LjQ5Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00Ni43NCwxNy4zOWMtNS40Ny00LjYyLTEzLjktMy44NC0xOS4yLS40MmgwYy0yLjk3LDEuOTMtMy41OSw1LjA5LTMuNTksNS4wOWwtMS4zMiw0LjI5Yy0uMzMsMS4wNi0uOSwyLjAyLTEuNjcsMi44MWwtMy44NSwzLjkzYy0xLjY3LDEuNzEtMS4zMiw0LjUyLC43MSw1Ljc3bC43OCwuNDJjMS41NiwuODYsMy40NiwuODMsNS0uMDYsLjgxLS41NSwxLjgyLS42NywyLjc2LS4zOSw1LjI3LDEuNTYsOS41Mi0yLjY3LDkuNTItMi42Ny0uNDUsNC43Ni0yLjk0LDYuMDUtNC44Myw3LjA0LTguMjksNC4zMi04LjE1LDExLjI5LTguMTUsMTEuMjloMjkuMDdjNi4xLTIxLjE5LDEuMDUtMzEuOC01LjIzLTM3LjA5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTMzLjc0LDIzLjk4Yy0uMDQtLjUzLS40Ny0uOTYtMS0xLTEuMDQtLjA5LTIuMTUsLjI5LTIuOTksMS4xMy0uODQsLjg0LTEuMjIsMS45NC0xLjEzLDIuOTksLjA0LC41MywuNDcsLjk2LDEsMSwxLjA0LC4wOSwyLjE1LS4yOSwyLjk5LTEuMTMsLjg0LS44NCwxLjIyLTEuOTQsMS4xMy0yLjk5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM3LjQzLDUwLjgxYy00LjM3LDAtOC40Ni0xLjExLTExLjk3LTMuMDQtMi42MywzLjQ1LTIuNTcsNi43Mi0yLjU3LDYuNzJoMjkuMDdjMS4wNy0zLjcyLDEuNzktNy4xMiwyLjIzLTEwLjIxLTQuMjcsNC4wMy0xMC4yLDYuNTQtMTYuNzcsNi41NFoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDkuNjksNTcuMzNsLTkuMTMtMTQuNDJoLTkuMTFsLTkuMTMsMTQuNDJjLS4xMiwuMi0uMjMsLjQtLjMyLC42MWgyOC4wMWMtLjA5LS4yMS0uMTktLjQyLS4zMi0uNjFaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMjEuNTgsNTkuODR2Mi40OWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdoMjYuNDhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjQ5YzAtLjEyLS4wMi0uMjQtLjAzLS4zNi0uMDQtLjUzLS4xNy0xLjA1LS4zOC0xLjU0SDIxLjk5Yy0uMjEsLjQ5LS4zNCwxLjAxLS4zOCwxLjU0LDAsLjEyLS4wMywuMjQtLjAzLC4zNloiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMSIgY3g9IjM2IiBjeT0iMzIuMzQiIHI9IjEwLjQ0Ii8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyNi45NSIgeT0iNDAuNSIgd2lkdGg9IjE4LjExIiBoZWlnaHQ9IjYuMDUiIHJ4PSIyIiByeT0iMiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
};

const PIECES_RHOSGFX_OUTLINE = {
  'wK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy00IiBkPSJNNTUuOTYsMjYuOTZjLTIuMTctMS4wMi00LjY3LTEuODUtNy40My0yLjQ3LC43MS0uOTksMS4xMy0yLjIsMS4xMy0zLjV2LTQuMTNjMC0zLjE3LTIuNDgtNS43OC01LjYtNS45OXYtLjM3YzAtMy4zMS0yLjY5LTYtNi02aC00LjEzYy0zLjMxLDAtNiwyLjY5LTYsNnYuMzdjLTMuMTIsLjIxLTUuNiwyLjgxLTUuNiw1Ljk5djQuMTNjMCwxLjMxLC40MiwyLjUyLDEuMTMsMy41LTIuNzYsLjYyLTUuMjYsMS40NS03LjQzLDIuNDctMywxLjQxLTQuNTgsNC43OC0zLjc2LDhsNC43MiwxOC40Mi0xLjU4LDEuNTJjLS4xNiwuMTUtLjMsLjMxLS40NCwuNDgtLjk4LDEuMTUtMS41MSwyLjYtMS41MSw0LjF2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1My4zNWMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuNDktLjU0LTIuOTQtMS41MS00LjEtLjE0LS4xOC0uMjktLjM1LS40NC0uNDhsLTEuNTgtMS41Miw0LjcyLTE4LjQyYy44My0zLjIyLS43NS02LjU4LTMuNzUtNy45OVoiLz4KICAgICAgICA8Zz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTMzLjkzLDguNWg0LjEzYzEuMSwwLDIsLjksMiwyVjI3LjgyaC04LjEzVjEwLjVjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0zNiwyNy4xNmMtNy4yOCwwLTEzLjgsMS4zMi0xOC4yNiwzLjQyLTEuMjcsLjYtMS45MywyLjAyLTEuNTgsMy4zOGw1LjMsMjAuNjhoMjkuMDdsNS4zLTIwLjY4Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOC00LjQ1LTIuMS0xMC45OC0zLjQyLTE4LjI2LTMuNDJaIi8+CiAgICAgICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjMxLjkzIiB5PSI5LjI2IiB3aWR0aD0iOC4xMyIgaGVpZ2h0PSIxOS4zMiIgcng9IjIiIHJ5PSIyIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg1NC45MyAtMTcuMDcpIHJvdGF0ZSg5MCkiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM2LDQ5LjM1Yy02LjE2LDAtMTEuOTQtMS41My0xNi45Ny00LjIxbDIuNDQsOS41MWgyOS4wN2wyLjQ0LTkuNTFjLTUuMDMsMi42OC0xMC44MSw0LjIxLTE2Ljk3LDQuMjFaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3Ljc4bC0zLjI3LTMuMTRIMjEuNDdsLTMuMjcsMy4xNGMtLjA1LC4wNS0uMDksLjExLS4xMywuMTZINTMuOTRjLS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDcsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS41Ny0uMjItMS4xMS0uNTktMS41NEgxOC4wNmMtLjM3LC40My0uNTksLjk3LS41OSwxLjU0djIuODVaIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy00IiBkPSJNNTEuNTgsMjAuNTdjLS4yMywwLS40NiwwLS42OSwuMDItMS4xOS0xLjk1LTIuOTMtMy41Mi01LjEzLTQuNjUsLjA4LS41MSwuMTItMS4wMywuMTItMS41NSwwLTUuNDUtNC40My05Ljg5LTkuODktOS44OXMtOS44OSw0LjQzLTkuODksOS44OWMwLC41MiwuMDQsMS4wNCwuMTIsMS41NS0yLjIsMS4xMy0zLjk0LDIuNy01LjEzLDQuNjUtLjIzLS4wMS0uNDYtLjAyLS42OS0uMDItMy43LDAtNy4yOCwxLjUxLTEwLjA3LDQuMjUtMS45NCwxLjktMi41Nyw0Ljc5LTEuNiw3LjM2bDguMDUsMjEuNDEtMS4zNywxLjMxYy0uMTUsLjE1LS4yOSwuMy0uNDMsLjQ3LS45OCwxLjE2LTEuNTIsMi42MS0xLjUyLDQuMTF2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1My4zNWMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuNS0uNTQtMi45Ni0xLjUzLTQuMTEtLjEzLS4xNi0uMjctLjMyLS40My0uNDdsLTEuMzctMS4zMSw4LjA0LTIxLjQxYy45Ni0yLjU3LC4zMy01LjQ2LTEuNi03LjM2LTIuNzktMi43NC02LjM2LTQuMjUtMTAuMDctNC4yNVoiLz4KICAgICAgICA8Zz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTQ4Ljc5LDI3LjcxYzAsNy4wNi01LjczLDEyLjc5LTEyLjc5LDEyLjc5cy0xMi43OS01LjczLTEyLjc5LTEyLjc5LDUuNzMtOS44NSwxMi43OS05Ljg1LDEyLjc5LDIuNzksMTIuNzksOS44NVoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTU4Ljg1LDI3LjY3Yy0yLjkyLTIuODctMTAuODItNy42Ny0yMi44NSw3LjAyLTEyLjAzLTE0LjY5LTE5LjkyLTkuODktMjIuODUtNy4wMi0uODIsLjgtMS4wNywyLjAyLS42NiwzLjFsOC45NywyMy44OGgyOS4wN2w4Ljk3LTIzLjg4Yy40LTEuMDcsLjE2LTIuMjktLjY2LTMuMVoiLz4KICAgICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzYsNDkuMzVjLTYuNzUsMC0xMy4wNi0xLjg0LTE4LjQxLTUuMDJsMy44OCwxMC4zMWgyOS4wN2wzLjg4LTEwLjMxYy01LjM1LDMuMTgtMTEuNjYsNS4wMi0xOC40MSw1LjAyWiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTMuOCw1Ny43OGwtMy4yNy0zLjE0SDIxLjQ3bC0zLjI3LDMuMTRjLS4wNSwuMDUtLjA5LC4xMS0uMTMsLjE2SDUzLjk0Yy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE3LjQ4LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTguMDZjLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy00IiBkPSJNNTIuNTMsMTEuNTZoLTQuNjVjLTEuOTUsMC0zLjY4LC45My00Ljc4LDIuMzctMS4xLTEuNDQtMi44My0yLjM3LTQuNzgtMi4zN2gtNC42NWMtMS45NSwwLTMuNjgsLjkzLTQuNzgsMi4zNy0xLjEtMS40NC0yLjgzLTIuMzctNC43OC0yLjM3aC00LjY1Yy0zLjMxLDAtNiwyLjY5LTYsNnYxMC4zNWMwLDEuNDMsLjQ5LDIuODMsMS4zOCwzLjk2bDIuNjEsMy4yN3YxNy42NGwtMi4wMywxLjk1Yy0uMjksLjI4LS41NiwuNTktLjgsLjk0LS43NiwxLjA4LTEuMTYsMi4zNC0xLjE2LDMuNjV2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1My4zNWMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuMzEtLjQtMi41OC0xLjE2LTMuNjUtLjI1LS4zNS0uNTItLjY3LS43OS0uOTNsLTIuMDQtMS45NnYtMTcuNjRsMi42LTMuMjdjLjg5LTEuMTIsMS4zOS0yLjUzLDEuMzktMy45NnYtMTAuMzVjMC0zLjMxLTIuNjktNi02LTZaIi8+CiAgICAgICAgPGc+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3LjYybC0zLjI3LTMuMTRIMjEuNDZsLTMuMjcsMy4xNGMtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzRINTQuMDljLS4wOS0uMTItLjE4LS4yNC0uMjktLjM0WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDcsNjIuMTdjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyMS40NiIgeT0iMzMuNzQiIHdpZHRoPSIyOS4wNyIgaGVpZ2h0PSIyMC43NCIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjEuNDYsMzMuNzRsLTMuNDgtNC4zNmMtLjMzLS40Mi0uNTEtLjkzLS41MS0xLjQ2di03LjE0SDU0LjUzdjcuMTRjMCwuNTMtLjE4LDEuMDUtLjUxLDEuNDZsLTMuNDgsNC4zNkgyMS40NloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE5LjQ3LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTQ3Ljg4LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMzLjY3LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTU0LjUzLDI3LjkySDE3LjQ3YzAsLjUzLC4xOCwxLjA1LC41MSwxLjQ2bDMuNDgsNC4zNmgyOS4wN2wzLjQ4LTQuMzZjLjMzLS40MiwuNTEtLjkzLC41MS0xLjQ2WiIvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KCiAgICAgIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzk2ZGJmZjsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTMiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTQiIGQ9Ik01Ni41Nyw1NC45bC0xLjkxLTEuODNjLS40Mi0uNC0uODctLjc2LTEuMzUtMS4wNiwxLjk0LTMuMTYsMy4wMS02LjgyLDMuMDEtMTAuNiwwLTUuMjYtMy44Ni0xMi44Ny0xMS40Ny0yMi42MiwuNjctMS4zNSwxLjAzLTIuODUsMS4wMy00LjM5LDAtNS40NS00LjQzLTkuODktOS44OC05Ljg5cy05Ljg5LDQuNDMtOS44OSw5Ljg5YzAsMS41NCwuMzYsMy4wNCwxLjAzLDQuMzktNy42MSw5Ljc2LTExLjQ3LDE3LjM2LTExLjQ3LDIyLjYyLDAsMy43OCwxLjA3LDcuNDUsMy4wMSwxMC42LS40OCwuMzEtLjkzLC42Ni0xLjM1LDEuMDdsLTEuODgsMS44MWMtLjMsLjI4LS41NywuNi0uODIsLjk1LS43NiwxLjA4LTEuMTYsMi4zNC0xLjE2LDMuNjV2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1My4zNWMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuMzEtLjQtMi41Ny0xLjE3LTMuNjctLjI0LS4zNC0uNS0uNjQtLjc4LS45MVoiLz4KICAgICAgICA8Zz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE5LjY4LDQxLjRjMCw5LjAxLDcuMzEsMTYuMzIsMTYuMzIsMTYuMzJzMTYuMzItNy4zMSwxNi4zMi0xNi4zMlMzNiwxNC4zOSwzNiwxNC4zOWMwLDAtMTYuMzIsMTgtMTYuMzIsMjcuMDFaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3Ljc4bC0xLjkxLTEuODNjLS44Ny0uODQtMi4wNC0xLjMxLTMuMjUtMS4zMUgyMy4zNWMtMS4yMSwwLTIuMzgsLjQ3LTMuMjUsMS4zMWwtMS45MSwxLjgzYy0uMTEsLjExLS4yMSwuMjItLjI5LC4zNEg1NC4xYy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNFoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE3LjQ3LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNDktLjE1LS45Ni0uNDMtMS4zNUgxNy45Yy0uMjgsLjM5LS40MywuODYtLjQzLDEuMzV2Mi44NVoiLz4KICAgICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy01IiBkPSJNMzYsMzQuOTRjMy44OCwwLDcuNDgsMS4zMiwxMC40OSwzLjYsLjksLjY4LDIuMTEtLjM0LDEuNjEtMS4zNS0yLjk3LTYuMDMtNy4yOS05LjgzLTEyLjEtOS44M3MtOS4xMywzLjgtMTIuMSw5LjgzYy0uNSwxLjAxLC43MSwyLjAzLDEuNjEsMS4zNSwzLjAxLTIuMjcsNi42MS0zLjYsMTAuNDktMy42WiIvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KCiAgICAgIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzk2ZGJmZjsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTMiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTQiIGQ9Ik01OCw1NC43NGwtMS41NS0xLjQ5YzUuNzYtMjIuMjItLjYxLTMzLjQxLTcuMTMtMzguOTEtMy4wMy0yLjU2LTYuODgtMy45OC0xMS4xOC00LjE1bC0yLjI4LTMuMmMtMS4wNC0xLjQ2LTIuNzQtMi4zMy00LjUzLTIuMzMtMS41NywwLTMuMDcsLjY3LTQuMTIsMS44My0yLjAzLDIuMjQtMy4wMiw1LjAxLTIuOSw3Ljg5LTMsMi40NC0zLjk4LDUuNjMtNC4yMyw2LjY0bC0xLjI4LDQuMTVjLS4xNCwuNDUtLjM4LC44Ni0uNzEsMS4xOWwtMy44NCwzLjkzYy0xLjY1LDEuNjktMi40Myw0LTIuMTQsNi4zNCwuMjksMi4zNCwxLjYxLDQuNCwzLjYyLDUuNjMsLjA2LC4wNCwuMTEsLjA3LC4xNywuMWwuNzcsLjQyYzEuMzMsLjczLDIuODQsMS4xMiw0LjM3LDEuMTJoMGMuOTksMCwxLjk3LS4xNiwyLjktLjQ4LTMuMzYsMy4zNC00LjQ4LDYuOTgtNC44NSw5LjE1bC0yLjIzLDIuMTRjLS4xNiwuMTUtLjMsLjMxLS40NCwuNDgtLjk4LDEuMTUtMS41MSwyLjYtMS41MSw0LjF2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1NC43OGMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuNDktLjU0LTIuOTQtMS41MS00LjA5LS4xNC0uMTctLjI4LS4zMy0uNDQtLjQ4WiIvPgogICAgICAgIDxnPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0xOC45LDYyLjE3YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1NC43OGMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTkuNDljLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDYuNzQsMTcuMzljLTUuNDctNC42Mi0xMy45LTMuODQtMTkuMi0uNDJoMGMtMi45NywxLjkzLTMuNTksNS4wOS0zLjU5LDUuMDlsLTEuMzIsNC4yOWMtLjMzLDEuMDYtLjksMi4wMi0xLjY3LDIuODFsLTMuODUsMy45M2MtMS42NywxLjcxLTEuMzIsNC41MiwuNzEsNS43N2wuNzgsLjQyYzEuNTYsLjg2LDMuNDYsLjgzLDUtLjA2LC44MS0uNTUsMS44Mi0uNjcsMi43Ni0uMzksNS4yNywxLjU2LDkuNTItMi42Nyw5LjUyLTIuNjctLjQ1LDQuNzYtMi45NCw2LjA1LTQuODMsNy4wNC04LjI5LDQuMzItOC4xNSwxMS4yOS04LjE1LDExLjI5aDI5LjA3YzYuMS0yMS4xOSwxLjA1LTMxLjgtNS4yMy0zNy4wOVoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy01IiBkPSJNMzMuNzQsMjMuOThjLS4wNC0uNTMtLjQ3LS45Ni0xLTEtMS4wNC0uMDktMi4xNSwuMjktMi45OSwxLjEzLS44NCwuODQtMS4yMiwxLjk0LTEuMTMsMi45OSwuMDQsLjUzLC40NywuOTYsMSwxLDEuMDQsLjA5LDIuMTUtLjI5LDIuOTktMS4xMywuODQtLjg0LDEuMjItMS45NCwxLjEzLTIuOTlaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0zNy40Myw1MC44MWMtNC4zNywwLTguNDYtMS4xMS0xMS45Ny0zLjA0LTIuNjMsMy40NS0yLjU3LDYuNzItMi41Nyw2LjcyaDI5LjA3YzEuMDctMy43MiwxLjc5LTcuMTIsMi4yMy0xMC4yMS00LjI3LDQuMDMtMTAuMiw2LjU0LTE2Ljc3LDYuNTRaIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNjZWY7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQoKICAgICAgLmNscy0zLCAuY2xzLTQgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0zIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy00IiBkPSJNNTQuMzgsNTkuMTdjLS4wOC0uOTctLjMxLTEuOTItLjctMi44Mi0uMTktLjQzLS4zOC0uODEtLjYxLTEuMTdsLTQuODMtNy42MmMuNTItLjg5LC44MS0xLjkyLC44MS0zLjAydi0yLjA1YzAtLjk5LS4yNC0xLjkyLS42Ni0yLjc0LDEuMzMtMi4yMSwyLjA1LTQuNzYsMi4wNS03LjQyLDAtNy45Ni02LjQ4LTE0LjQ0LTE0LjQ0LTE0LjQ0cy0xNC40NCw2LjQ4LTE0LjQ0LDE0LjQ0YzAsMi42NiwuNzIsNS4yMSwyLjA1LDcuNDItLjQyLC44Mi0uNjYsMS43NS0uNjYsMi43NHYyLjA1YzAsMS4xLC4zLDIuMTMsLjgyLDMuMDJsLTQuODMsNy42M2MtLjIyLC4zNS0uNDIsLjczLS42LDEuMTUtLjM5LC45LS42MywxLjg1LS43MSwyLjg2LS4wMiwuMjEtLjAzLC40Mi0uMDMsLjY0djIuNDljMCwyLjg1LDIuMzIsNS4xNyw1LjE3LDUuMTdoMjYuNDhjMi44NSwwLDUuMTctMi4zMiw1LjE3LTUuMTd2LTIuNDljMC0uMjEtLjAxLS40MS0uMDQtLjY3WiIvPgogICAgICAgIDxnPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDkuNjksNTcuMzNsLTkuMTMtMTQuNDJoLTkuMTFsLTkuMTMsMTQuNDJjLS4xMiwuMi0uMjMsLjQtLjMyLC42MWgyOC4wMWMtLjA5LS4yMS0uMTktLjQyLS4zMi0uNjFaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0yMS41OCw1OS44NHYyLjQ5YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN2gyNi40OGMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuNDljMC0uMTItLjAyLS4yNC0uMDMtLjM2LS4wNC0uNTMtLjE3LTEuMDUtLjM4LTEuNTRIMjEuOTljLS4yMSwuNDktLjM0LDEuMDEtLjM4LDEuNTQsMCwuMTItLjAzLC4yNC0uMDMsLjM2WiIvPgogICAgICAgICAgPGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIzNiIgY3k9IjMyLjM0IiByPSIxMC40NCIvPgogICAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyNi45NSIgeT0iNDAuNSIgd2lkdGg9IjE4LjExIiBoZWlnaHQ9IjYuMDUiIHJ4PSIyIiByeT0iMiIvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01NS45NiwyNi45NmMtMi4xNy0xLjAyLTQuNjctMS44NS03LjQzLTIuNDcsLjcxLS45OSwxLjEzLTIuMiwxLjEzLTMuNXYtNC4xM2MwLTMuMTctMi40OC01Ljc4LTUuNi01Ljk5di0uMzdjMC0zLjMxLTIuNjktNi02LTZoLTQuMTNjLTMuMzEsMC02LDIuNjktNiw2di4zN2MtMy4xMiwuMjEtNS42LDIuODEtNS42LDUuOTl2NC4xM2MwLDEuMzEsLjQyLDIuNTIsMS4xMywzLjUtMi43NiwuNjItNS4yNiwxLjQ1LTcuNDMsMi40Ny0zLDEuNDEtNC41OCw0Ljc4LTMuNzYsOGw0LjcyLDE4LjQyLTEuNTgsMS41MmMtLjE2LC4xNS0uMywuMzEtLjQ0LC40OC0uOTgsMS4xNS0xLjUxLDIuNi0xLjUxLDQuMXYyLjg1YzAsMi44NSwyLjMyLDUuMTcsNS4xNyw1LjE3SDUzLjM1YzIuODUsMCw1LjE3LTIuMzIsNS4xNy01LjE3di0yLjg1YzAtMS40OS0uNTQtMi45NC0xLjUxLTQuMS0uMTQtLjE4LS4yOS0uMzUtLjQ0LS40OGwtMS41OC0xLjUyLDQuNzItMTguNDJjLjgzLTMuMjItLjc1LTYuNTgtMy43NS03Ljk5WiIvPgogICAgICAgIDxnPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzMuOTMsOC41aDQuMTNjMS4xLDAsMiwuOSwyLDJWMjcuODJoLTguMTNWMTAuNWMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTM2LDI3LjE2Yy03LjI4LDAtMTMuOCwxLjMyLTE4LjI2LDMuNDItMS4yNywuNi0xLjkzLDIuMDItMS41OCwzLjM4bDUuMywyMC42OGgyOS4wN2w1LjMtMjAuNjhjLjM1LTEuMzYtLjMxLTIuNzgtMS41OC0zLjM4LTQuNDUtMi4xLTEwLjk4LTMuNDItMTguMjYtMy40MloiLz4KICAgICAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMzEuOTMiIHk9IjkuMjYiIHdpZHRoPSI4LjEzIiBoZWlnaHQ9IjE5LjMyIiByeD0iMiIgcnk9IjIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDU0LjkzIC0xNy4wNykgcm90YXRlKDkwKSIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzYsNDkuMzVjLTYuMTYsMC0xMS45NC0xLjUzLTE2Ljk3LTQuMjFsMi40NCw5LjUxaDI5LjA3bDIuNDQtOS41MWMtNS4wMywyLjY4LTEwLjgxLDQuMjEtMTYuOTcsNC4yMVoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTUzLjgsNTcuNzhsLTMuMjctMy4xNEgyMS40N2wtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1My45NGMtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0xNy40Nyw2Mi4zM2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE4LjA2Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgICA8L2c+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'bQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01MS41OCwyMC41N2MtLjIzLDAtLjQ2LDAtLjY5LC4wMi0xLjE5LTEuOTUtMi45My0zLjUyLTUuMTMtNC42NSwuMDgtLjUxLC4xMi0xLjAzLC4xMi0xLjU1LDAtNS40NS00LjQzLTkuODktOS44OS05Ljg5cy05Ljg5LDQuNDMtOS44OSw5Ljg5YzAsLjUyLC4wNCwxLjA0LC4xMiwxLjU1LTIuMiwxLjEzLTMuOTQsMi43LTUuMTMsNC42NS0uMjMtLjAxLS40Ni0uMDItLjY5LS4wMi0zLjcsMC03LjI4LDEuNTEtMTAuMDcsNC4yNS0xLjk0LDEuOS0yLjU3LDQuNzktMS42LDcuMzZsOC4wNSwyMS40MS0xLjM3LDEuMzFjLS4xNSwuMTUtLjI5LC4zLS40MywuNDctLjk4LDEuMTYtMS41MiwyLjYxLTEuNTIsNC4xMXYyLjg1YzAsMi44NSwyLjMyLDUuMTcsNS4xNyw1LjE3SDUzLjM1YzIuODUsMCw1LjE3LTIuMzIsNS4xNy01LjE3di0yLjg1YzAtMS41LS41NC0yLjk2LTEuNTMtNC4xMS0uMTMtLjE2LS4yNy0uMzItLjQzLS40N2wtMS4zNy0xLjMxLDguMDQtMjEuNDFjLjk2LTIuNTcsLjMzLTUuNDYtMS42LTcuMzYtMi43OS0yLjc0LTYuMzYtNC4yNS0xMC4wNy00LjI1WiIvPgogICAgICAgIDxnPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNDguNzksMjcuNzFjMCw3LjA2LTUuNzMsMTIuNzktMTIuNzksMTIuNzlzLTEyLjc5LTUuNzMtMTIuNzktMTIuNzksNS43My05Ljg1LDEyLjc5LTkuODUsMTIuNzksMi43OSwxMi43OSw5Ljg1WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTguODUsMjcuNjdjLTIuOTItMi44Ny0xMC44Mi03LjY3LTIyLjg1LDcuMDItMTIuMDMtMTQuNjktMTkuOTItOS44OS0yMi44NS03LjAyLS44MiwuOC0xLjA3LDIuMDItLjY2LDMuMWw4Ljk3LDIzLjg4aDI5LjA3bDguOTctMjMuODhjLjQtMS4wNywuMTYtMi4yOS0uNjYtMy4xWiIvPgogICAgICAgICAgPGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIzNiIgY3k9IjE0LjM5IiByPSI1Ljg5Ii8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0zNiw0OS4zNWMtNi43NSwwLTEzLjA2LTEuODQtMTguNDEtNS4wMmwzLjg4LDEwLjMxaDI5LjA3bDMuODgtMTAuMzFjLTUuMzUsMy4xOC0xMS42Niw1LjAyLTE4LjQxLDUuMDJaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3Ljc4bC0zLjI3LTMuMTRIMjEuNDdsLTMuMjcsMy4xNGMtLjA1LC4wNS0uMDksLjExLS4xMywuMTZINTMuOTRjLS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTcuNDgsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS41Ny0uMjItMS4xMS0uNTktMS41NEgxOC4wNmMtLjM3LC40My0uNTksLjk3LS41OSwxLjU0djIuODVaIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01Mi41MywxMS41NmgtNC42NWMtMS45NSwwLTMuNjgsLjkzLTQuNzgsMi4zNy0xLjEtMS40NC0yLjgzLTIuMzctNC43OC0yLjM3aC00LjY1Yy0xLjk1LDAtMy42OCwuOTMtNC43OCwyLjM3LTEuMS0xLjQ0LTIuODMtMi4zNy00Ljc4LTIuMzdoLTQuNjVjLTMuMzEsMC02LDIuNjktNiw2djEwLjM1YzAsMS40MywuNDksMi44MywxLjM4LDMuOTZsMi42MSwzLjI3djE3LjY0bC0yLjAzLDEuOTVjLS4yOSwuMjgtLjU2LC41OS0uOCwuOTQtLjc2LDEuMDgtMS4xNiwyLjM0LTEuMTYsMy42NXYyLjg1YzAsMi44NSwyLjMyLDUuMTcsNS4xNyw1LjE3SDUzLjM1YzIuODUsMCw1LjE3LTIuMzIsNS4xNy01LjE3di0yLjg1YzAtMS4zMS0uNC0yLjU4LTEuMTYtMy42NS0uMjUtLjM1LS41Mi0uNjctLjc5LS45M2wtMi4wNC0xLjk2di0xNy42NGwyLjYtMy4yN2MuODktMS4xMiwxLjM5LTIuNTMsMS4zOS0zLjk2di0xMC4zNWMwLTMuMzEtMi42OS02LTYtNloiLz4KICAgICAgICA8Zz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTUzLjgsNTcuNjJsLTMuMjctMy4xNEgyMS40NmwtMy4yNywzLjE0Yy0uMTEsLjExLS4yMSwuMjItLjI5LC4zNEg1NC4wOWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0xNy40Nyw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjQ5LS4xNS0uOTYtLjQzLTEuMzVIMTcuOWMtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVaIi8+CiAgICAgICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxLjQ2IiB5PSIzMy43NCIgd2lkdGg9IjI5LjA3IiBoZWlnaHQ9IjIwLjc0Ii8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMS40NiwzMy43NGwtMy40OC00LjM2Yy0uMzMtLjQyLS41MS0uOTMtLjUxLTEuNDZ2LTcuMTRINTQuNTN2Ny4xNGMwLC41My0uMTgsMS4wNS0uNTEsMS40NmwtMy40OCw0LjM2SDIxLjQ2WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTkuNDcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDcuODgsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzMuNjcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTQuNTMsMjcuOTJIMTcuNDdjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2aDI5LjA3bDMuNDgtNC4zNmMuMzMtLjQyLC41MS0uOTMsLjUxLTEuNDZaIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01Ni41Nyw1NC45bC0xLjkxLTEuODNjLS40Mi0uNC0uODctLjc2LTEuMzUtMS4wNiwxLjk0LTMuMTYsMy4wMS02LjgyLDMuMDEtMTAuNiwwLTUuMjYtMy44Ni0xMi44Ny0xMS40Ny0yMi42MiwuNjctMS4zNSwxLjAzLTIuODUsMS4wMy00LjM5LDAtNS40NS00LjQzLTkuODktOS44OC05Ljg5cy05Ljg5LDQuNDMtOS44OSw5Ljg5YzAsMS41NCwuMzYsMy4wNCwxLjAzLDQuMzktNy42MSw5Ljc2LTExLjQ3LDE3LjM2LTExLjQ3LDIyLjYyLDAsMy43OCwxLjA3LDcuNDUsMy4wMSwxMC42LS40OCwuMzEtLjkzLC42Ni0xLjM1LDEuMDdsLTEuODgsMS44MWMtLjMsLjI4LS41NywuNi0uODIsLjk1LS43NiwxLjA4LTEuMTYsMi4zNC0xLjE2LDMuNjV2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1My4zNWMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuMzEtLjQtMi41Ny0xLjE3LTMuNjctLjI0LS4zNC0uNS0uNjQtLjc4LS45MVoiLz4KICAgICAgICA8Zz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE5LjY4LDQxLjRjMCw5LjAxLDcuMzEsMTYuMzIsMTYuMzIsMTYuMzJzMTYuMzItNy4zMSwxNi4zMi0xNi4zMlMzNiwxNC4zOSwzNiwxNC4zOWMwLDAtMTYuMzIsMTgtMTYuMzIsMjcuMDFaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My44LDU3Ljc4bC0xLjkxLTEuODNjLS44Ny0uODQtMi4wNC0xLjMxLTMuMjUtMS4zMUgyMy4zNWMtMS4yMSwwLTIuMzgsLjQ3LTMuMjUsMS4zMWwtMS45MSwxLjgzYy0uMTEsLjExLS4yMSwuMjItLjI5LC4zNEg1NC4xYy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNFoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTE3LjQ3LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNDktLjE1LS45Ni0uNDMtMS4zNUgxNy45Yy0uMjgsLjM5LS40MywuODYtLjQzLDEuMzV2Mi44NVoiLz4KICAgICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMzYsMzQuOTRjMy44OCwwLDcuNDgsMS4zMiwxMC40OSwzLjYsLjksLjY4LDIuMTEtLjM0LDEuNjEtMS4zNS0yLjk3LTYuMDMtNy4yOS05LjgzLTEyLjEtOS44M3MtOS4xMywzLjgtMTIuMSw5LjgzYy0uNSwxLjAxLC43MSwyLjAzLDEuNjEsMS4zNSwzLjAxLTIuMjcsNi42MS0zLjYsMTAuNDktMy42WiIvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01OCw1NC43NGwtMS41NS0xLjQ5YzUuNzYtMjIuMjItLjYxLTMzLjQxLTcuMTMtMzguOTEtMy4wMy0yLjU2LTYuODgtMy45OC0xMS4xOC00LjE1bC0yLjI4LTMuMmMtMS4wNC0xLjQ2LTIuNzQtMi4zMy00LjUzLTIuMzMtMS41NywwLTMuMDcsLjY3LTQuMTIsMS44My0yLjAzLDIuMjQtMy4wMiw1LjAxLTIuOSw3Ljg5LTMsMi40NC0zLjk4LDUuNjMtNC4yMyw2LjY0bC0xLjI4LDQuMTVjLS4xNCwuNDUtLjM4LC44Ni0uNzEsMS4xOWwtMy44NCwzLjkzYy0xLjY1LDEuNjktMi40Myw0LTIuMTQsNi4zNCwuMjksMi4zNCwxLjYxLDQuNCwzLjYyLDUuNjMsLjA2LC4wNCwuMTEsLjA3LC4xNywuMWwuNzcsLjQyYzEuMzMsLjczLDIuODQsMS4xMiw0LjM3LDEuMTJoMGMuOTksMCwxLjk3LS4xNiwyLjktLjQ4LTMuMzYsMy4zNC00LjQ4LDYuOTgtNC44NSw5LjE1bC0yLjIzLDIuMTRjLS4xNiwuMTUtLjMsLjMxLS40NCwuNDgtLjk4LDEuMTUtMS41MSwyLjYtMS41MSw0LjF2Mi44NWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN0g1NC43OGMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi44NWMwLTEuNDktLjU0LTIuOTQtMS41MS00LjA5LS4xNC0uMTctLjI4LS4zMy0uNDQtLjQ4WiIvPgogICAgICAgIDxnPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0xOC45LDYyLjE3YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1NC43OGMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTkuNDljLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDYuNzQsMTcuMzljLTUuNDctNC42Mi0xMy45LTMuODQtMTkuMi0uNDJoMGMtMi45NywxLjkzLTMuNTksNS4wOS0zLjU5LDUuMDlsLTEuMzIsNC4yOWMtLjMzLDEuMDYtLjksMi4wMi0xLjY3LDIuODFsLTMuODUsMy45M2MtMS42NywxLjcxLTEuMzIsNC41MiwuNzEsNS43N2wuNzgsLjQyYzEuNTYsLjg2LDMuNDYsLjgzLDUtLjA2LC44MS0uNTUsMS44Mi0uNjcsMi43Ni0uMzksNS4yNywxLjU2LDkuNTItMi42Nyw5LjUyLTIuNjctLjQ1LDQuNzYtMi45NCw2LjA1LTQuODMsNy4wNC04LjI5LDQuMzItOC4xNSwxMS4yOS04LjE1LDExLjI5aDI5LjA3YzYuMS0yMS4xOSwxLjA1LTMxLjgtNS4yMy0zNy4wOVoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMzMuNzQsMjMuOThjLS4wNC0uNTMtLjQ3LS45Ni0xLTEtMS4wNC0uMDktMi4xNSwuMjktMi45OSwxLjEzLS44NCwuODQtMS4yMiwxLjk0LTEuMTMsMi45OSwuMDQsLjUzLC40NywuOTYsMSwxLDEuMDQsLjA5LDIuMTUtLjI5LDIuOTktMS4xMywuODQtLjg0LDEuMjItMS45NCwxLjEzLTIuOTlaIi8+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0zNy40Myw1MC44MWMtNC4zNywwLTguNDYtMS4xMS0xMS45Ny0zLjA0LTIuNjMsMy40NS0yLjU3LDYuNzItMi41Nyw2LjcyaDI5LjA3YzEuMDctMy43MiwxLjc5LTcuMTIsMi4yMy0xMC4yMS00LjI3LDQuMDMtMTAuMiw2LjU0LTE2Ljc3LDYuNTRaIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjNWQ3YzhjOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICM0NzY0NzU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogIzMyNDY1MjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTQsIC5jbHMtNSB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8Zz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTUiIGQ9Ik01NC4zOCw1OS4xN2MtLjA4LS45Ny0uMzEtMS45Mi0uNy0yLjgyLS4xOS0uNDMtLjM4LS44MS0uNjEtMS4xN2wtNC44My03LjYyYy41Mi0uODksLjgxLTEuOTIsLjgxLTMuMDJ2LTIuMDVjMC0uOTktLjI0LTEuOTItLjY2LTIuNzQsMS4zMy0yLjIxLDIuMDUtNC43NiwyLjA1LTcuNDIsMC03Ljk2LTYuNDgtMTQuNDQtMTQuNDQtMTQuNDRzLTE0LjQ0LDYuNDgtMTQuNDQsMTQuNDRjMCwyLjY2LC43Miw1LjIxLDIuMDUsNy40Mi0uNDIsLjgyLS42NiwxLjc1LS42NiwyLjc0djIuMDVjMCwxLjEsLjMsMi4xMywuODIsMy4wMmwtNC44Myw3LjYzYy0uMjIsLjM1LS40MiwuNzMtLjYsMS4xNS0uMzksLjktLjYzLDEuODUtLjcxLDIuODYtLjAyLC4yMS0uMDMsLjQyLS4wMywuNjR2Mi40OWMwLDIuODUsMi4zMiw1LjE3LDUuMTcsNS4xN2gyNi40OGMyLjg1LDAsNS4xNy0yLjMyLDUuMTctNS4xN3YtMi40OWMwLS4yMS0uMDEtLjQxLS4wNC0uNjdaIi8+CiAgICAgICAgPGc+CiAgICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00OS42OSw1Ny4zM2wtOS4xMy0xNC40MmgtOS4xMWwtOS4xMywxNC40MmMtLjEyLC4yLS4yMywuNC0uMzIsLjYxaDI4LjAxYy0uMDktLjIxLS4xOS0uNDItLjMyLS42MVoiLz4KICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTIxLjU4LDU5Ljg0djIuNDljMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3aDI2LjQ4Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi40OWMwLS4xMi0uMDItLjI0LS4wMy0uMzYtLjA0LS41My0uMTctMS4wNS0uMzgtMS41NEgyMS45OWMtLjIxLC40OS0uMzQsMS4wMS0uMzgsMS41NCwwLC4xMi0uMDMsLjI0LS4wMywuMzZaIi8+CiAgICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMSIgY3g9IjM2IiBjeT0iMzIuMzQiIHI9IjEwLjQ0Ii8+CiAgICAgICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjI2Ljk1IiB5PSI0MC41IiB3aWR0aD0iMTguMTEiIGhlaWdodD0iNi4wNSIgcng9IjIiIHJ5PSIyIi8+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
};

const PIECES_RHOSGFX_WOOD = {
  'wK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzMuOTMsOC41aDQuMTNjMS4xLDAsMiwuOSwyLDJWMjcuODJoLTguMTNWMTAuNWMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0zNiwyNy4xNmMtNy4yOCwwLTEzLjgsMS4zMi0xOC4yNiwzLjQyLTEuMjcsLjYtMS45MywyLjAyLTEuNTgsMy4zOGw1LjMsMjAuNjhoMjkuMDdsNS4zLTIwLjY4Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOC00LjQ1LTIuMS0xMC45OC0zLjQyLTE4LjI2LTMuNDJaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzMS45MyIgeT0iOS4yNiIgd2lkdGg9IjguMTMiIGhlaWdodD0iMTkuMzIiIHJ4PSIyIiByeT0iMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNTQuOTMgLTE3LjA3KSByb3RhdGUoOTApIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzYsNDkuMzVjLTYuMTYsMC0xMS45NC0xLjUzLTE2Ljk3LTQuMjFsMi40NCw5LjUxaDI5LjA3bDIuNDQtOS41MWMtNS4wMywyLjY4LTEwLjgxLDQuMjEtMTYuOTcsNC4yMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik01My44LDU3Ljc4bC0zLjI3LTMuMTRIMjEuNDdsLTMuMjcsMy4xNGMtLjA1LC4wNS0uMDksLjExLS4xMywuMTZINTMuOTRjLS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE3LjQ3LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTguMDZjLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNNDguNzksMjcuNzFjMCw3LjA2LTUuNzMsMTIuNzktMTIuNzksMTIuNzlzLTEyLjc5LTUuNzMtMTIuNzktMTIuNzksNS43My05Ljg1LDEyLjc5LTkuODUsMTIuNzksMi43OSwxMi43OSw5Ljg1WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTU4Ljg1LDI3LjY3Yy0yLjkyLTIuODctMTAuODItNy42Ny0yMi44NSw3LjAyLTEyLjAzLTE0LjY5LTE5LjkyLTkuODktMjIuODUtNy4wMi0uODIsLjgtMS4wNywyLjAyLS42NiwzLjFsOC45NywyMy44OGgyOS4wN2w4Ljk3LTIzLjg4Yy40LTEuMDcsLjE2LTIuMjktLjY2LTMuMVoiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMyIgY3g9IjM2IiBjeT0iMTQuMzkiIHI9IjUuODkiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0zNiw0OS4zNWMtNi43NSwwLTEzLjA2LTEuODQtMTguNDEtNS4wMmwzLjg4LDEwLjMxaDI5LjA3bDMuODgtMTAuMzFjLTUuMzUsMy4xOC0xMS42Niw1LjAyLTE4LjQxLDUuMDJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny43OGwtMy4yNy0zLjE0SDIxLjQ3bC0zLjI3LDMuMTRjLS4wNSwuMDUtLjA5LC4xMS0uMTMsLjE2SDUzLjk0Yy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0xNy40OCw2Mi4zM2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE4LjA2Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny42MmwtMy4yNy0zLjE0SDIxLjQ2bC0zLjI3LDMuMTRjLS4xMSwuMTEtLjIxLC4yMi0uMjksLjM0SDU0LjA5Yy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNFoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0xNy40Nyw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjQ5LS4xNS0uOTYtLjQzLTEuMzVIMTcuOWMtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyMS40NiIgeT0iMzMuNzQiIHdpZHRoPSIyOS4wNyIgaGVpZ2h0PSIyMC43NCIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTIxLjQ2LDMzLjc0bC0zLjQ4LTQuMzZjLS4zMy0uNDItLjUxLS45My0uNTEtMS40NnYtNy4xNEg1NC41M3Y3LjE0YzAsLjUzLS4xOCwxLjA1LS41MSwxLjQ2bC0zLjQ4LDQuMzZIMjEuNDZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTkuNDcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTQ3Ljg4LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0zMy42NywxNS41Nmg0LjY1YzEuMSwwLDIsLjksMiwydjMuMjJoLTguNjV2LTMuMjJjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNNTQuNTMsMjcuOTJIMTcuNDdjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2aDI5LjA3bDMuNDgtNC4zNmMuMzMtLjQyLC41MS0uOTMsLjUxLTEuNDZaIi8+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'wB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTkuNjgsNDEuNGMwLDkuMDEsNy4zMSwxNi4zMiwxNi4zMiwxNi4zMnMxNi4zMi03LjMxLDE2LjMyLTE2LjMyUzM2LDE0LjM5LDM2LDE0LjM5YzAsMC0xNi4zMiwxOC0xNi4zMiwyNy4wMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny43OGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFIMjMuMzVjLTEuMjEsMC0yLjM4LC40Ny0zLjI1LDEuMzFsLTEuOTEsMS44M2MtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzRINTQuMWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTcuNDcsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0zIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM2LDM0Ljk0YzMuODgsMCw3LjQ4LDEuMzIsMTAuNDksMy42LC45LC42OCwyLjExLS4zNCwxLjYxLTEuMzUtMi45Ny02LjAzLTcuMjktOS44My0xMi4xLTkuODNzLTkuMTMsMy44LTEyLjEsOS44M2MtLjUsMS4wMSwuNzEsMi4wMywxLjYxLDEuMzUsMy4wMS0yLjI3LDYuNjEtMy42LDEwLjQ5LTMuNloiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTguOSw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE5LjQ5Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik00Ni43NCwxNy4zOWMtNS40Ny00LjYyLTEzLjktMy44NC0xOS4yLS40MmgwYy0yLjk3LDEuOTMtMy41OSw1LjA5LTMuNTksNS4wOWwtMS4zMiw0LjI5Yy0uMzMsMS4wNi0uOSwyLjAyLTEuNjcsMi44MWwtMy44NSwzLjkzYy0xLjY3LDEuNzEtMS4zMiw0LjUyLC43MSw1Ljc3bC43OCwuNDJjMS41NiwuODYsMy40NiwuODMsNS0uMDYsLjgxLS41NSwxLjgyLS42NywyLjc2LS4zOSw1LjI3LDEuNTYsOS41Mi0yLjY3LDkuNTItMi42Ny0uNDUsNC43Ni0yLjk0LDYuMDUtNC44Myw3LjA0LTguMjksNC4zMi04LjE1LDExLjI5LTguMTUsMTEuMjloMjkuMDdjNi4xLTIxLjE5LDEuMDUtMzEuOC01LjIzLTM3LjA5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTMzLjc0LDIzLjk4Yy0uMDQtLjUzLS40Ny0uOTYtMS0xLTEuMDQtLjA5LTIuMTUsLjI5LTIuOTksMS4xMy0uODQsLjg0LTEuMjIsMS45NC0xLjEzLDIuOTksLjA0LC41MywuNDcsLjk2LDEsMSwxLjA0LC4wOSwyLjE1LS4yOSwyLjk5LTEuMTMsLjg0LS44NCwxLjIyLTEuOTQsMS4xMy0yLjk5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTM3LjQzLDUwLjgxYy00LjM3LDAtOC40Ni0xLjExLTExLjk3LTMuMDQtMi42MywzLjQ1LTIuNTcsNi43Mi0yLjU3LDYuNzJoMjkuMDdjMS4wNy0zLjcyLDEuNzktNy4xMiwyLjIzLTEwLjIxLTQuMjcsNC4wMy0xMC4yLDYuNTQtMTYuNzcsNi41NFoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZkZmI1OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNmNGMzOGU7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2ZmZjJkNDsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNDkuNjksNTcuMzNsLTkuMTMtMTQuNDJoLTkuMTFsLTkuMTMsMTQuNDJjLS4xMiwuMi0uMjMsLjQtLjMyLC42MWgyOC4wMWMtLjA5LS4yMS0uMTktLjQyLS4zMi0uNjFaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMjEuNTgsNTkuODR2Mi40OWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdoMjYuNDhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjQ5YzAtLjEyLS4wMi0uMjQtLjAzLS4zNi0uMDQtLjUzLS4xNy0xLjA1LS4zOC0xLjU0SDIxLjk5Yy0uMjEsLjQ5LS4zNCwxLjAxLS4zOCwxLjU0LDAsLjEyLS4wMywuMjQtLjAzLC4zNloiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMyIgY3g9IjM2IiBjeT0iMzIuMzQiIHI9IjEwLjQ0Ii8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyNi45NSIgeT0iNDAuNSIgd2lkdGg9IjE4LjExIiBoZWlnaHQ9IjYuMDUiIHJ4PSIyIiByeT0iMiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzMuOTMsOC41aDQuMTNjMS4xLDAsMiwuOSwyLDJWMjcuODJoLTguMTNWMTAuNWMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0zNiwyNy4xNmMtNy4yOCwwLTEzLjgsMS4zMi0xOC4yNiwzLjQyLTEuMjcsLjYtMS45MywyLjAyLTEuNTgsMy4zOGw1LjMsMjAuNjhoMjkuMDdsNS4zLTIwLjY4Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOC00LjQ1LTIuMS0xMC45OC0zLjQyLTE4LjI2LTMuNDJaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzMS45MyIgeT0iOS4yNiIgd2lkdGg9IjguMTMiIGhlaWdodD0iMTkuMzIiIHJ4PSIyIiByeT0iMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNTQuOTMgLTE3LjA3KSByb3RhdGUoOTApIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMzYsNDkuMzVjLTYuMTYsMC0xMS45NC0xLjUzLTE2Ljk3LTQuMjFsMi40NCw5LjUxaDI5LjA3bDIuNDQtOS41MWMtNS4wMywyLjY4LTEwLjgxLDQuMjEtMTYuOTcsNC4yMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik01My44LDU3Ljc4bC0zLjI3LTMuMTRIMjEuNDdsLTMuMjcsMy4xNGMtLjA1LC4wNS0uMDksLjExLS4xMywuMTZINTMuOTRjLS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3LjQ3LDYyLjMzYzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNTctLjIyLTEuMTEtLjU5LTEuNTRIMTguMDZjLS4zNywuNDMtLjU5LC45Ny0uNTksMS41NHYyLjg1WiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDguNzksMjcuNzFjMCw3LjA2LTUuNzMsMTIuNzktMTIuNzksMTIuNzlzLTEyLjc5LTUuNzMtMTIuNzktMTIuNzksNS43My05Ljg1LDEyLjc5LTkuODUsMTIuNzksMi43OSwxMi43OSw5Ljg1WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTU4Ljg1LDI3LjY3Yy0yLjkyLTIuODctMTAuODItNy42Ny0yMi44NSw3LjAyLTEyLjAzLTE0LjY5LTE5LjkyLTkuODktMjIuODUtNy4wMi0uODIsLjgtMS4wNywyLjAyLS42NiwzLjFsOC45NywyMy44OGgyOS4wN2w4Ljk3LTIzLjg4Yy40LTEuMDcsLjE2LTIuMjktLjY2LTMuMVoiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMyIgY3g9IjM2IiBjeT0iMTQuMzkiIHI9IjUuODkiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0zNiw0OS4zNWMtNi43NSwwLTEzLjA2LTEuODQtMTguNDEtNS4wMmwzLjg4LDEwLjMxaDI5LjA3bDMuODgtMTAuMzFjLTUuMzUsMy4xOC0xMS42Niw1LjAyLTE4LjQxLDUuMDJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny43OGwtMy4yNy0zLjE0SDIxLjQ3bC0zLjI3LDMuMTRjLS4wNSwuMDUtLjA5LC4xMS0uMTMsLjE2SDUzLjk0Yy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNy40OCw2Mi4zM2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE4LjA2Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny42MmwtMy4yNy0zLjE0SDIxLjQ2bC0zLjI3LDMuMTRjLS4xMSwuMTEtLjIxLC4yMi0uMjksLjM0SDU0LjA5Yy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNFoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNy40Nyw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjQ5LS4xNS0uOTYtLjQzLTEuMzVIMTcuOWMtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVaIi8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyMS40NiIgeT0iMzMuNzQiIHdpZHRoPSIyOS4wNyIgaGVpZ2h0PSIyMC43NCIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTIxLjQ2LDMzLjc0bC0zLjQ4LTQuMzZjLS4zMy0uNDItLjUxLS45My0uNTEtMS40NnYtNy4xNEg1NC41M3Y3LjE0YzAsLjUzLS4xOCwxLjA1LS41MSwxLjQ2bC0zLjQ4LDQuMzZIMjEuNDZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTkuNDcsMTUuNTZoNC42NWMxLjEsMCwyLC45LDIsMnYzLjIyaC04LjY1di0zLjIyYzAtMS4xLC45LTIsMi0yWiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTQ3Ljg4LDE1LjU2aDQuNjVjMS4xLDAsMiwuOSwyLDJ2My4yMmgtOC42NXYtMy4yMmMwLTEuMSwuOS0yLDItMloiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik0zMy42NywxNS41Nmg0LjY1YzEuMSwwLDIsLjksMiwydjMuMjJoLTguNjV2LTMuMjJjMC0xLjEsLjktMiwyLTJaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTQuNTMsMjcuOTJIMTcuNDdjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2aDI5LjA3bDMuNDgtNC4zNmMuMzMtLjQyLC41MS0uOTMsLjUxLTEuNDZaIi8+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'bB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNMTkuNjgsNDEuNGMwLDkuMDEsNy4zMSwxNi4zMiwxNi4zMiwxNi4zMnMxNi4zMi03LjMxLDE2LjMyLTE2LjMyUzM2LDE0LjM5LDM2LDE0LjM5YzAsMC0xNi4zMiwxOC0xNi4zMiwyNy4wMVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MS44MSwzOC4yN2MtMS40Nyw2Ljk0LTcuOTksMTIuMTctMTUuODEsMTIuMTdzLTE0LjM0LTUuMjMtMTUuODEtMTIuMTdjLS4zMywxLjEyLS41MiwyLjE4LS41MiwzLjEzLDAsOS4wMSw3LjMxLDE2LjMyLDE2LjMyLDE2LjMyczE2LjMyLTcuMzEsMTYuMzItMTYuMzJjMC0uOTUtLjE5LTIuMDEtLjUyLTMuMTNaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTMuOCw1Ny43OGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFIMjMuMzVjLTEuMjEsMC0yLjM4LC40Ny0zLjI1LDEuMzFsLTEuOTEsMS44M2MtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzRINTQuMWMtLjA5LS4xMi0uMTgtLjI0LS4yOS0uMzRaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTcuNDcsNjIuMzNjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1SDE3LjljLS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1WiIvPgogICAgICAgIDxjaXJjbGUgY2xhc3M9ImNscy0zIiBjeD0iMzYiIGN5PSIxNC4zOSIgcj0iNS44OSIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTM2LDM0Ljk0YzMuODgsMCw3LjQ4LDEuMzIsMTAuNDksMy42LC45LC42OCwyLjExLS4zNCwxLjYxLTEuMzUtMi45Ny02LjAzLTcuMjktOS44My0xMi4xLTkuODNzLTkuMTMsMy44LTEyLjEsOS44M2MtLjUsMS4wMSwuNzEsMi4wMywxLjYxLDEuMzUsMy4wMS0yLjI3LDYuNjEtMy42LDEwLjQ5LTMuNloiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNTUuMjMsNTcuNjJsLTMuMjctMy4xNEgyMi44OWwtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNkg1NS4zN2MtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTguOSw2Mi4xN2MwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0SDE5LjQ5Yy0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NVoiLz4KICAgICAgICA8cGF0aCBjbGFzcz0iY2xzLTMiIGQ9Ik00Ni43NCwxNy4zOWMtNS40Ny00LjYyLTEzLjktMy44NC0xOS4yLS40MmgwYy0yLjk3LDEuOTMtMy41OSw1LjA5LTMuNTksNS4wOWwtMS4zMiw0LjI5Yy0uMzMsMS4wNi0uOSwyLjAyLTEuNjcsMi44MWwtMy44NSwzLjkzYy0xLjY3LDEuNzEtMS4zMiw0LjUyLC43MSw1Ljc3bC43OCwuNDJjMS41NiwuODYsMy40NiwuODMsNS0uMDYsLjgxLS41NSwxLjgyLS42NywyLjc2LS4zOSw1LjI3LDEuNTYsOS41Mi0yLjY3LDkuNTItMi42Ny0uNDUsNC43Ni0yLjk0LDYuMDUtNC44Myw3LjA0LTguMjksNC4zMi04LjE1LDExLjI5LTguMTUsMTEuMjloMjkuMDdjNi4xLTIxLjE5LDEuMDUtMzEuOC01LjIzLTM3LjA5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTMyLjYsOS4zMmMtLjU4LS44MS0xLjc2LS44OS0yLjQzLS4xNC0xLjM2LDEuNTEtMi45Myw0LjM1LS45Niw4LjQ1bDguOC0uNzItNS40MS03LjU4WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTMzLjc0LDIzLjk4Yy0uMDQtLjUzLS40Ny0uOTYtMS0xLTEuMDQtLjA5LTIuMTUsLjI5LTIuOTksMS4xMy0uODQsLjg0LTEuMjIsMS45NC0xLjEzLDIuOTksLjA0LC41MywuNDcsLjk2LDEsMSwxLjA0LC4wOSwyLjE1LS4yOSwyLjk5LTEuMTMsLjg0LS44NCwxLjIyLTEuOTQsMS4xMy0yLjk5WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTM3LjQzLDUwLjgxYy00LjM3LDAtOC40Ni0xLjExLTExLjk3LTMuMDQtMi42MywzLjQ1LTIuNTcsNi43Mi0yLjU3LDYuNzJoMjkuMDdjMS4wNy0zLjcyLDEuNzktNy4xMiwyLjIzLTEwLjIxLTQuMjcsNC4wMy0xMC4yLDYuNTQtMTYuNzcsNi41NFoiLz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjOWMzZDI5OwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICNiYjU5Mzg7CiAgICAgIH0KCiAgICAgIC5jbHMtMyB7CiAgICAgICAgZmlsbDogI2QxNzc0YjsKICAgICAgfQoKICAgICAgLmNscy00IHsKICAgICAgICBmaWxsOiAjMWExYTFhOwogICAgICAgIG9wYWNpdHk6IDA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJSb3VnaCI+CiAgICA8Zz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy00IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0zIiBkPSJNNDkuNjksNTcuMzNsLTkuMTMtMTQuNDJoLTkuMTFsLTkuMTMsMTQuNDJjLS4xMiwuMi0uMjMsLjQtLjMyLC42MWgyOC4wMWMtLjA5LS4yMS0uMTktLjQyLS4zMi0uNjFaIi8+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjEuNTgsNTkuODR2Mi40OWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdoMjYuNDhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjQ5YzAtLjEyLS4wMi0uMjQtLjAzLS4zNi0uMDQtLjUzLS4xNy0xLjA1LS4zOC0xLjU0SDIxLjk5Yy0uMjEsLjQ5LS4zNCwxLjAxLS4zOCwxLjU0LDAsLjEyLS4wMywuMjQtLjAzLC4zNloiLz4KICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtMyIgY3g9IjM2IiBjeT0iMzIuMzQiIHI9IjEwLjQ0Ii8+CiAgICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyNi45NSIgeT0iNDAuNSIgd2lkdGg9IjE4LjExIiBoZWlnaHQ9IjYuMDUiIHJ4PSIyIiByeT0iMiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
};

const PIECES_RHOSGFX_FLAT = {
  'wK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01NC4yNiwzMC41OGMtMy42LTEuNy04LjU3LTIuODctMTQuMTktMy4yNnYtNC4zM2gzLjZjMS4xLDAsMi0uOSwyLTJ2LTQuMTNjMC0xLjEtLjktMi0yLTJoLTMuNnYtNC4zNmMwLTEuMS0uOS0yLTItMmgtNC4xM2MtMS4xLDAtMiwuOS0yLDJ2NC4zNmgtMy42Yy0xLjEsMC0yLC45LTIsMnY0LjEzYzAsMS4xLC45LDIsMiwyaDMuNnY0LjMzYy01LjYyLC4zOS0xMC41OSwxLjU3LTE0LjE5LDMuMjYtMS4yNywuNi0xLjkzLDIuMDItMS41OCwzLjM4bDUuMywyMC42OGgwcy0zLjI3LDMuMTQtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNi0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0LS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2bC0zLjI2LTMuMTYsNS4zLTIwLjY2Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOFoiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'wQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01OC44NSwyNy42N2MtMS43NS0xLjcyLTUuMjctNC4xMi0xMC4zOC0yLjY0LS45Ni0zLjgtNC4wNC01LjkxLTguMDYtNi43NCwuOTItMS4wNCwxLjQ4LTIuNCwxLjQ4LTMuOSwwLTMuMjUtMi42My01Ljg5LTUuODktNS44OXMtNS44OSwyLjYzLTUuODksNS44OWMwLDEuNSwuNTYsMi44NiwxLjQ4LDMuOS00LjAyLC44My03LjEsMi45NS04LjA2LDYuNzQtNS4xMi0xLjQ3LTguNjQsLjkzLTEwLjM4LDIuNjQtLjgyLC44LTEuMDcsMi4wMi0uNjYsMy4xbDguOTcsMjMuODhoMGwtMy4yNywzLjE0cy0uMDksLjExLS4xMywuMTZoMGMtLjM3LC40My0uNTksLjk3LS41OSwxLjU0djIuODVjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS41Ny0uMjItMS4xMS0uNTktMS41NGgwYy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNmwtMy4yNy0zLjE0aDBsOC45Ny0yMy44OGMuNC0xLjA3LC4xNi0yLjI5LS42Ni0zLjFaIi8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01Mi41MywxNS41NmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2My4yMmgtNS41NXYtMy4yMmMwLTEuMS0uOS0yLTItMmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2My4yMmgtNS41NXYtMy4yMmMwLTEuMS0uOS0yLTItMmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2MTAuMzVjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2djIwLjc0aDBsLTMuMjcsMy4xNGMtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzQtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1LS4wOS0uMTItLjE4LS4yNC0uMjktLjM0bC0zLjI3LTMuMTRoMHYtMjAuNzRoMGwzLjQ4LTQuMzZjLjMzLS40MiwuNTEtLjkzLC41MS0xLjQ2di0xMC4zNWMwLTEuMS0uOS0yLTItMloiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'wB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01NC4xLDU4LjEzYy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFoLTMuMTNjNC4xMi0yLjk2LDYuODEtNy43OSw2LjgxLTEzLjI1LDAtNi4xOS03LjY5LTE2LjYxLTEyLjUxLTIyLjUzLDEuMjctMS4wOCwyLjA3LTIuNjgsMi4wNy00LjQ4LDAtMy4yNS0yLjYzLTUuODktNS44OS01Ljg5cy01Ljg5LDIuNjMtNS44OSw1Ljg5YzAsMS44LC44MSwzLjQsMi4wNyw0LjQ4LTQuODIsNS45My0xMi41MSwxNi4zNS0xMi41MSwyMi41MywwLDUuNDYsMi42OSwxMC4yOCw2LjgxLDEzLjI1aC0zLjEzYy0xLjIxLDAtMi4zOCwuNDctMy4yNSwxLjMxbC0xLjkxLDEuODNjLS4xMSwuMTEtLjIxLC4yMi0uMjksLjM0LS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNDktLjE1LS45Ni0uNDMtMS4zNVptLTE4LjEtMjIuNjRjLTMuMzIsMC02LjQsMS4xMy04Ljk4LDMuMDgtLjc3LC41OC0xLjgtLjI5LTEuMzgtMS4xNiwyLjU0LTUuMTYsNi4yNC04LjQxLDEwLjM2LTguNDFzNy44MiwzLjI1LDEwLjM2LDguNDFjLjQyLC44Ni0uNjEsMS43NC0xLjM4LDEuMTYtMi41OC0xLjk1LTUuNjYtMy4wOC04Ljk4LTMuMDhaIi8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'wN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01NS4zNyw1Ny43OGMtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZsLTMuMjYtMy4xNmM2LjA5LTIxLjE4LDEuMDQtMzEuNzctNS4yMy0zNy4wNy0yLjk5LTIuNTMtNi44Ny0zLjQzLTEwLjY0LTMuMThsLTMuNDktNC45Yy0uNTgtLjgxLTEuNzYtLjg5LTIuNDMtLjE0LTEuMjEsMS4zNC0yLjU4LDMuNzQtMS40OSw3LjEzLS40LC4yMS0uNzgsLjQzLTEuMTUsLjY3aDBjLTIuOTcsMS45My0zLjU5LDUuMDktMy41OSw1LjA5bC0xLjMyLDQuMjljLS4zMywxLjA2LS45LDIuMDItMS42NywyLjgxbC0zLjg1LDMuOTNjLTEuNjcsMS43MS0xLjMyLDQuNTIsLjcxLDUuNzdsLjc4LC40MmMxLjU2LC44NiwzLjQ2LC44Myw1LS4wNiwuODEtLjU1LDEuODItLjY3LDIuNzYtLjM5LDUuMjcsMS41Niw5LjUyLTIuNjcsOS41Mi0yLjY3LS40NSw0Ljc2LTIuOTQsNi4wNS00LjgzLDcuMDQtOC4yOSw0LjMyLTguMTUsMTEuMjktOC4xNSwxMS4yOWgwcy0zLjI3LDMuMTQtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNi0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0Wm0tMjIuNzUtMzAuODJjLS44NCwuODQtMS45NCwxLjIyLTIuOTksMS4xMy0uNTMtLjA0LS45Ni0uNDctMS0xLS4wOS0xLjA0LC4yOS0yLjE1LDEuMTMtMi45OXMxLjk0LTEuMjIsMi45OS0xLjEzYy41MywuMDQsLjk2LC40NywxLDEsLjA5LDEuMDQtLjI5LDIuMTUtMS4xMywyLjk5WiIvPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'wP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6ICMxYTFhMWE7CiAgICAgICAgb3BhY2l0eTogMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01MC4zOSw1OS40OGMtLjA0LS41My0uMTctMS4wNS0uMzgtMS41NC0uMDktLjIxLS4xOS0uNDItLjMyLS42MWwtNi44My0xMC43OGguMTljMS4xLDAsMi0uOSwyLTJ2LTIuMDVjMC0xLjEtLjktMi0yLTJoLS41NWMyLjQtMS45MSwzLjk0LTQuODUsMy45NC04LjE2LDAtNS43Ny00LjY3LTEwLjQ0LTEwLjQ0LTEwLjQ0cy0xMC40NCw0LjY3LTEwLjQ0LDEwLjQ0YzAsMy4zLDEuNTQsNi4yNSwzLjk0LDguMTZoLS41NWMtMS4xLDAtMiwuOS0yLDJ2Mi4wNWMwLDEuMSwuOSwyLDIsMmguMTlsLTYuODMsMTAuNzhjLS4xMiwuMi0uMjMsLjQtLjMyLC42MS0uMjEsLjQ5LS4zNCwxLjAxLS4zOCwxLjU0LDAsLjEyLS4wMywuMjQtLjAzLC4zNnYyLjQ5YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN2gyNi40OGMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuNDljMC0uMTItLjAyLS4yNC0uMDMtLjM2WiIvPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bK': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01NC4yNiwzMC41OGMtMy42LTEuNy04LjU3LTIuODctMTQuMTktMy4yNnYtNC4zM2gzLjZjMS4xLDAsMi0uOSwyLTJ2LTQuMTNjMC0xLjEtLjktMi0yLTJoLTMuNnYtNC4zNmMwLTEuMS0uOS0yLTItMmgtNC4xM2MtMS4xLDAtMiwuOS0yLDJ2NC4zNmgtMy42Yy0xLjEsMC0yLC45LTIsMnY0LjEzYzAsMS4xLC45LDIsMiwyaDMuNnY0LjMzYy01LjYyLC4zOS0xMC41OSwxLjU3LTE0LjE5LDMuMjYtMS4yNywuNi0xLjkzLDIuMDItMS41OCwzLjM4bDUuMywyMC42OGgwcy0zLjI3LDMuMTQtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNi0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTMuMzVjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0LS4wNS0uMDUtLjA4LS4xMS0uMTMtLjE2bC0zLjI2LTMuMTYsNS4zLTIwLjY2Yy4zNS0xLjM2LS4zMS0yLjc4LTEuNTgtMy4zOFoiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'bQ': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01OC44NSwyNy42N2MtMS43NS0xLjcyLTUuMjctNC4xMi0xMC4zOC0yLjY0LS45Ni0zLjgtNC4wNC01LjkxLTguMDYtNi43NCwuOTItMS4wNCwxLjQ4LTIuNCwxLjQ4LTMuOSwwLTMuMjUtMi42My01Ljg5LTUuODktNS44OXMtNS44OSwyLjYzLTUuODksNS44OWMwLDEuNSwuNTYsMi44NiwxLjQ4LDMuOS00LjAyLC44My03LjEsMi45NS04LjA2LDYuNzQtNS4xMi0xLjQ3LTguNjQsLjkzLTEwLjM4LDIuNjQtLjgyLC44LTEuMDcsMi4wMi0uNjYsMy4xbDguOTcsMjMuODhoMGwtMy4yNywzLjE0cy0uMDksLjExLS4xMywuMTZoMGMtLjM3LC40My0uNTksLjk3LS41OSwxLjU0djIuODVjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS41Ny0uMjItMS4xMS0uNTktMS41NGgwYy0uMDUtLjA1LS4wOC0uMTEtLjEzLS4xNmwtMy4yNy0zLjE0aDBsOC45Ny0yMy44OGMuNC0xLjA3LC4xNi0yLjI5LS42Ni0zLjFaIi8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bR': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01Mi41MywxNS41NmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2My4yMmgtNS41NXYtMy4yMmMwLTEuMS0uOS0yLTItMmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2My4yMmgtNS41NXYtMy4yMmMwLTEuMS0uOS0yLTItMmgtNC42NWMtMS4xLDAtMiwuOS0yLDJ2MTAuMzVjMCwuNTMsLjE4LDEuMDUsLjUxLDEuNDZsMy40OCw0LjM2djIwLjc0aDBsLTMuMjcsMy4xNGMtLjExLC4xMS0uMjEsLjIyLS4yOSwuMzQtLjI4LC4zOS0uNDMsLjg2LS40MywxLjM1djIuODVjMCwuNjUsLjUzLDEuMTcsMS4xNywxLjE3SDUzLjM1Yy42NSwwLDEuMTctLjUzLDEuMTctMS4xN3YtMi44NWMwLS40OS0uMTUtLjk2LS40My0xLjM1LS4wOS0uMTItLjE4LS4yNC0uMjktLjM0bC0zLjI3LTMuMTRoMHYtMjAuNzRoMGwzLjQ4LTQuMzZjLjMzLS40MiwuNTEtLjkzLC41MS0xLjQ2di0xMC4zNWMwLTEuMS0uOS0yLTItMloiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'bB': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01NC4xLDU4LjEzYy0uMDktLjEyLS4xOC0uMjQtLjI5LS4zNGwtMS45MS0xLjgzYy0uODctLjg0LTIuMDQtMS4zMS0zLjI1LTEuMzFoLTMuMTNjNC4xMi0yLjk2LDYuODEtNy43OSw2LjgxLTEzLjI1LDAtNi4xOS03LjY5LTE2LjYxLTEyLjUxLTIyLjUzLDEuMjctMS4wOCwyLjA3LTIuNjgsMi4wNy00LjQ4LDAtMy4yNS0yLjYzLTUuODktNS44OS01Ljg5cy01Ljg5LDIuNjMtNS44OSw1Ljg5YzAsMS44LC44MSwzLjQsMi4wNyw0LjQ4LTQuODIsNS45My0xMi41MSwxNi4zNS0xMi41MSwyMi41MywwLDUuNDYsMi42OSwxMC4yOCw2LjgxLDEzLjI1aC0zLjEzYy0xLjIxLDAtMi4zOCwuNDctMy4yNSwxLjMxbC0xLjkxLDEuODNjLS4xMSwuMTEtLjIxLC4yMi0uMjksLjM0LS4yOCwuMzktLjQzLC44Ni0uNDMsMS4zNXYyLjg1YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN0g1My4zNWMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuODVjMC0uNDktLjE1LS45Ni0uNDMtMS4zNVptLTE4LjEtMjIuNjRjLTMuMzIsMC02LjQsMS4xMy04Ljk4LDMuMDgtLjc3LC41OC0xLjgtLjI5LTEuMzgtMS4xNiwyLjU0LTUuMTYsNi4yNC04LjQxLDEwLjM2LTguNDFzNy44MiwzLjI1LDEwLjM2LDguNDFjLjQyLC44Ni0uNjEsMS43NC0xLjM4LDEuMTYtMi41OC0xLjk1LTUuNjYtMy4wOC04Ljk4LTMuMDhaIi8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'bN': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01NS4zNyw1Ny43OGMtLjA1LS4wNS0uMDgtLjExLS4xMy0uMTZsLTMuMjYtMy4xNmM2LjA5LTIxLjE4LDEuMDQtMzEuNzctNS4yMy0zNy4wNy0yLjk5LTIuNTMtNi44Ny0zLjQzLTEwLjY0LTMuMThsLTMuNDktNC45Yy0uNTgtLjgxLTEuNzYtLjg5LTIuNDMtLjE0LTEuMjEsMS4zNC0yLjU4LDMuNzQtMS40OSw3LjEzLS40LC4yMS0uNzgsLjQzLTEuMTUsLjY3aDBjLTIuOTcsMS45My0zLjU5LDUuMDktMy41OSw1LjA5bC0xLjMyLDQuMjljLS4zMywxLjA2LS45LDIuMDItMS42NywyLjgxbC0zLjg1LDMuOTNjLTEuNjcsMS43MS0xLjMyLDQuNTIsLjcxLDUuNzdsLjc4LC40MmMxLjU2LC44NiwzLjQ2LC44Myw1LS4wNiwuODEtLjU1LDEuODItLjY3LDIuNzYtLjM5LDUuMjcsMS41Niw5LjUyLTIuNjcsOS41Mi0yLjY3LS40NSw0Ljc2LTIuOTQsNi4wNS00LjgzLDcuMDQtOC4yOSw0LjMyLTguMTUsMTEuMjktOC4xNSwxMS4yOWgwcy0zLjI3LDMuMTQtMy4yNywzLjE0Yy0uMDUsLjA1LS4wOSwuMTEtLjEzLC4xNi0uMzcsLjQzLS41OSwuOTctLjU5LDEuNTR2Mi44NWMwLC42NSwuNTMsMS4xNywxLjE3LDEuMTdINTQuNzhjLjY1LDAsMS4xNy0uNTMsMS4xNy0xLjE3di0yLjg1YzAtLjU3LS4yMi0xLjExLS41OS0xLjU0Wm0tMjIuNzUtMzAuODJjLS44NCwuODQtMS45NCwxLjIyLTIuOTksMS4xMy0uNTMtLjA0LS45Ni0uNDctMS0xLS4wOS0xLjA0LC4yOS0yLjE1LDEuMTMtMi45OXMxLjk0LTEuMjIsMi45OS0xLjEzYy41MywuMDQsLjk2LC40NywxLDEsLjA5LDEuMDQtLjI5LDIuMTUtMS4xMywyLjk5WiIvPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
  'bP': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3MiA3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIj4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBvcGFjaXR5OiAwOwogICAgICB9CgogICAgICAuY2xzLTEsIC5jbHMtMiB7CiAgICAgICAgZmlsbDogIzFhMWExYTsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGcgaWQ9IlJvdWdoIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik01MC4zOSw1OS40OGMtLjA0LS41My0uMTctMS4wNS0uMzgtMS41NC0uMDktLjIxLS4xOS0uNDItLjMyLS42MWwtNi44My0xMC43OGguMTljMS4xLDAsMi0uOSwyLTJ2LTIuMDVjMC0xLjEtLjktMi0yLTJoLS41NWMyLjQtMS45MSwzLjk0LTQuODUsMy45NC04LjE2LDAtNS43Ny00LjY3LTEwLjQ0LTEwLjQ0LTEwLjQ0cy0xMC40NCw0LjY3LTEwLjQ0LDEwLjQ0YzAsMy4zLDEuNTQsNi4yNSwzLjk0LDguMTZoLS41NWMtMS4xLDAtMiwuOS0yLDJ2Mi4wNWMwLDEuMSwuOSwyLDIsMmguMTlsLTYuODMsMTAuNzhjLS4xMiwuMi0uMjMsLjQtLjMyLC42MS0uMjEsLjQ5LS4zNCwxLjAxLS4zOCwxLjU0LDAsLjEyLS4wMywuMjQtLjAzLC4zNnYyLjQ5YzAsLjY1LC41MywxLjE3LDEuMTcsMS4xN2gyNi40OGMuNjUsMCwxLjE3LS41MywxLjE3LTEuMTd2LTIuNDljMC0uMTItLjAyLS4yNC0uMDMtLjM2WiIvPgogICAgPC9nPgogIDwvZz4KPC9zdmc+',
};

const BOARDS_RHOSGFX = {
  'blue': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1NzYgNTc2IiB3aWR0aD0iNTc2IiBoZWlnaHQ9IjU3NiI+CiAgPGRlZnM+CiAgICA8c3R5bGU+CiAgICAgIC5jbHMtMSB7CiAgICAgICAgZmlsbDogI2ZmZjsKICAgICAgfQoKICAgICAgLmNscy0yIHsKICAgICAgICBmaWxsOiAjOTZkYmZmOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iQm9hcmRzIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNzIiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjE0NCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjE2IiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyODgiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjM2MCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI3MiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI3MiIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMTQ0IiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyMTYiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB5PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjI4OCIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMzYwIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNDMyIiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI1MDQiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI0MzIiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNDMyIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjUwNCIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI1MDQiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjE0NCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjE2IiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyODgiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjM2MCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjE0NCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjE2IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyODgiIHk9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjM2MCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNDMyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjQzMiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI1MDQiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNTA0IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjQzMiIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI0MzIiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNTA0IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjUwNCIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'brown': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1NzYgNTc2IiB3aWR0aD0iNTc2IiBoZWlnaHQ9IjU3NiI+CiAgPGRlZnM+CiAgICA8c3R5bGU+CiAgICAgIC5jbHMtMSB7CiAgICAgICAgZmlsbDogI2RlOTI1YTsKICAgICAgfQoKICAgICAgLmNscy0yIHsKICAgICAgICBmaWxsOiAjZmZmMmQ0OwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iQm9hcmRzIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNzIiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjE0NCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjE2IiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyODgiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjM2MCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjAiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI3MiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI3MiIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMTQ0IiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyMTYiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB5PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjI4OCIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMzYwIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNDMyIiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI1MDQiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI0MzIiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNDMyIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjUwNCIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI1MDQiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjE0NCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjE2IiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyODgiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjM2MCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjE0NCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjE2IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyODgiIHk9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjM2MCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNDMyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjQzMiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI1MDQiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNTA0IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjQzMiIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI0MzIiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNTA0IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjUwNCIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
  'green': 'data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1NzYgNTc2IiB3aWR0aD0iNTc2IiBoZWlnaHQ9IjU3NiI+CiAgPGRlZnM+CiAgICA8c3R5bGU+CiAgICAgIC5jbHMtMSB7CiAgICAgICAgZmlsbDogIzhjYzkzNjsKICAgICAgfQoKICAgICAgLmNscy0yIHsKICAgICAgICBmaWxsOiAjZmZmMmQ0OwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8ZyBpZD0iQm9hcmRzIj4KICAgIDxnPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNzIiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjE0NCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjE2IiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyODgiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjM2MCIgeT0iNzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjAiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI3MiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI3MiIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIxNDQiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMTQ0IiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjIxNiIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyMTYiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMjg4IiB5PSIxNDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjI4OCIgeT0iMjE2IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIzNjAiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMzYwIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNDMyIiB5PSI3MiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI1MDQiIHk9IjcyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI0MzIiIHk9IjE0NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNDMyIiB5PSIyMTYiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjUwNCIgeT0iMTQ0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSI1MDQiIHk9IjIxNiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjE0NCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjE2IiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyODgiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjM2MCIgeT0iMjg4IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHk9IjM2MCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjcyIiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjcyIiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjE0NCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDQiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjE2IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjIxNiIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIyODgiIHk9IjQzMiIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iMjg4IiB5PSI1MDQiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjM2MCIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0yIiB4PSIzNjAiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNDMyIiB5PSIyODgiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTEiIHg9IjQzMiIgeT0iMzYwIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI1MDQiIHk9IjI4OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iNTA0IiB5PSIzNjAiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjQzMiIgeT0iNDMyIiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgICAgPHJlY3QgY2xhc3M9ImNscy0xIiB4PSI0MzIiIHk9IjUwNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIi8+CiAgICAgIDxyZWN0IGNsYXNzPSJjbHMtMSIgeD0iNTA0IiB5PSI0MzIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIvPgogICAgICA8cmVjdCBjbGFzcz0iY2xzLTIiIHg9IjUwNCIgeT0iNTA0IiB3aWR0aD0iNzIiIGhlaWdodD0iNzIiLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==',
};

// ── Current piece set ────────────────────────────────────────────────
let currentPieceSet = 'staunton';

function getPieceImg(color, piece) {
  const key = color + piece;
  switch(currentPieceSet) {
    case 'staunton':        return PIECES_STAUNTON[key];
    case 'rhosgfx_solid':  return PIECES_RHOSGFX_SOLID[key];
    case 'rhosgfx_outline':return PIECES_RHOSGFX_OUTLINE[key];
    case 'rhosgfx_wood':   return PIECES_RHOSGFX_WOOD[key];
    case 'rhosgfx_flat':   return PIECES_RHOSGFX_FLAT[key];
    default: return null;
  }
}

// Preloaded Image cache for drawImage
const pieceImgCache = {};
function preloadPieceImages(setName) {
  const sets = {
    staunton: PIECES_STAUNTON,
    rhosgfx_solid: PIECES_RHOSGFX_SOLID,
    rhosgfx_outline: PIECES_RHOSGFX_OUTLINE,
    rhosgfx_wood: PIECES_RHOSGFX_WOOD,
    rhosgfx_flat: PIECES_RHOSGFX_FLAT,
  };
  const setData = sets[setName];
  if (!setData) return Promise.resolve();
  const promises = [];
  for (const key of ['wK','wQ','wR','wB','wN','wP','bK','bQ','bR','bB','bN','bP']) {
    const cacheKey = setName+key;
    if (!pieceImgCache[cacheKey]) {
      const img = new Image();
      // Use decode() for more reliable SVG loading
      const p = new Promise(res => {
        img.onload = () => { img.decode ? img.decode().then(res).catch(res) : res(); };
        img.onerror = res;
      });
      img.src = setData[key];
      pieceImgCache[cacheKey] = img;
      promises.push(p);
    }
  }
  // Re-render once all loaded
  return Promise.all(promises).then(() => {
    if(typeof render === 'function') render();
  });
}

function setPieceSet(name) {
  currentPieceSet = name;
  const sel = document.getElementById('pieceSetSelect');
  if (sel) sel.value = name;
  if (name !== 'unicode') {
    preloadPieceImages(name).then(() => render());
  } else { render(); }
  document.querySelectorAll('.piece-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.set === name));
  localStorage.setItem('bm_pieceSet', name);
  // Keep the bot panel's Appearance popover in sync (guarded: defined below)
  if (typeof _syncPanelTheme === 'function' && typeof BG_THEMES !== 'undefined') {
    _syncPanelTheme(BG_THEMES[currentBgTheme] || BG_THEMES.navy);
  }
}

// ── Theme system ─────────────────────────────────────────────────────
const BOARD_THEMES = {
  classic:      {light:'#f0d9b5', dark:'#b58863', name:'Classic',     texture:false},
  blue:         {light:'#dee3e6', dark:'#8ca2ad', name:'Blue',        texture:false},
  green:        {light:'#ffffdd', dark:'#86a666', name:'Green',       texture:false},
  walnut:       {light:'#f0e9d0', dark:'#7a5c3a', name:'Walnut',      texture:true},
  purple:       {light:'#e8d8f0', dark:'#7050a0', name:'Purple',      texture:false},
  brick:        {light:'#f5f0eb', dark:'#c4785a', name:'Brick',       texture:true},
  rose:         {light:'#f8eded', dark:'#c47070', name:'Rose',        texture:true},
  slate:        {light:'#e8edf2', dark:'#6a8aaa', name:'Slate',       texture:false},
  highcontrast: {light:'#ffffff', dark:'#404040', name:'Hi-contrast', texture:false},
};
const BG_THEMES = {
  light:      {bg:'#f0ede8', panel:'#e8e4de', panel2:'#dedad4', border:'#c8c4bc', border2:'#d8d4cc', text:'#1a1a1a', textDim:'#706860', textSec:'#504840', name:'Warm white'},
  lightblue:  {bg:'#e8eef4', panel:'#dde4ec', panel2:'#d0dae4', border:'#b8c8d8', border2:'#cad4e0', text:'#1a2530', textDim:'#506070', textSec:'#405060', name:'Cool blue'},
  lightgreen: {bg:'#e8f0e8', panel:'#dce8dc', panel2:'#d0e0d0', border:'#b0c8b0', border2:'#c4d8c4', text:'#1a2a1a', textDim:'#507050', textSec:'#406040', name:'Sage'},
  lighttan:   {bg:'#f4efe0', panel:'#ece7d8', panel2:'#e4dece', border:'#d0c8b0', border2:'#dcd4c0', text:'#2a2010', textDim:'#706040', textSec:'#584830', name:'Parchment'},
  lightgray:  {bg:'#f0f0f0', panel:'#e8e8e8', panel2:'#e0e0e0', border:'#c8c8c8', border2:'#d4d4d4', text:'#1a1a1a', textDim:'#606060', textSec:'#484848', name:'Silver'},
  // The "Field Journal" paper palette from bot_config_restyle_brief.md as a
  // regular background theme, with its terracotta accent carried alongside so
  // the bot panel picks it up (themes without `accent` use the amber default).
  clay:       {bg:'#f2e3d3', panel:'#f8eee1', panel2:'#e9d7c1', border:'#d3bfa4', border2:'#e0cfb8', text:'#3d2a22', textDim:'#6b5646', textSec:'#4a3226', name:'Clay',
               accent:{main:'#b3644f', bright:'#c97a63', dim:'#8a4a3a', glow:'rgba(179,100,79,0.1)', glowS:'rgba(179,100,79,0.22)', border:'rgba(179,100,79,0.4)'}},
  navy:       {bg:'#1a1a2e', panel:'#0d1b2a', panel2:'#060f18', border:'#2a3a4a', border2:'#1a2a3a', text:'#c8d8e8', textDim:'#506070', textSec:'#8090a0', name:'Navy'},
  green:      {bg:'#0d1a0d', panel:'#0a1a0a', panel2:'#060e06', border:'#1a3a1a', border2:'#0f220f', text:'#c0dcc0', textDim:'#4a6a4a', textSec:'#70a070', name:'Forest'},
  charcoal:   {bg:'#1a1a1a', panel:'#111111', panel2:'#080808', border:'#333333', border2:'#222222', text:'#d0d0d0', textDim:'#505050', textSec:'#909090', name:'Charcoal'},
  burgundy:   {bg:'#1f0d0d', panel:'#150808', panel2:'#0a0404', border:'#3a1a1a', border2:'#220d0d', text:'#dcc0c0', textDim:'#6a4040', textSec:'#a07070', name:'Burgundy'},
  slate:      {bg:'#0d1520', panel:'#0a1018', panel2:'#060a10', border:'#1a2a3a', border2:'#101820', text:'#c0ccd8', textDim:'#405060', textSec:'#708090', name:'Slate'},
};
let currentBoardTheme = 'blue';
let currentBgTheme = 'lightblue';

function applyBoardTheme(name) {
  currentBoardTheme = name;
  document.querySelectorAll('#boardSwatches .swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.theme === name));
  localStorage.setItem('bm_boardTheme', name);
  render();
  // Keep the bot panel's Appearance popover in sync with the new selection
  _syncPanelTheme(BG_THEMES[currentBgTheme] || BG_THEMES.navy);
}
function applyBgTheme(name) {
  const t = BG_THEMES[name] || BG_THEMES.navy;
  currentBgTheme = name;
  const root = document.documentElement;
  root.style.setProperty('--bg-page',   t.bg);
  root.style.setProperty('--bg-panel',  t.panel);
  root.style.setProperty('--bg-panel2', t.panel2);
  root.style.setProperty('--border',    t.border);
  root.style.setProperty('--border2',   t.border2);
  root.style.setProperty('--text-primary',   t.text);
  root.style.setProperty('--text-secondary', t.textSec);
  root.style.setProperty('--text-dim',       t.textDim);
  document.querySelectorAll('#bgSwatches .swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.theme === name));
  localStorage.setItem('bm_bgTheme', name);
  _syncPanelTheme(t);
}
function _isLightTheme(t) {
  const m = (t.text || '').match(/#([0-9a-f]{2})/i);
  return m ? parseInt(m[1], 16) < 128 : false;
}
function _syncPanelTheme(t) {
  if (!t) return;
  const light = _isLightTheme(t);
  // Accent family: themes may carry their own (e.g. Clay's terracotta);
  // everything else uses the amber pair tuned for light/dark surfaces.
  const ac = t.accent || (light
    ? {main:'#9a6820', bright:'#c8922a', dim:'#6a4a10', glow:'rgba(154,104,32,0.14)', glowS:'rgba(154,104,32,0.26)', border:'rgba(154,104,32,0.40)'}
    : {main:'#c8922a', bright:'#e8aa40', dim:'#8a6420', glow:'rgba(200,146,42,0.12)', glowS:'rgba(200,146,42,0.22)', border:'rgba(200,146,42,0.30)'});
  const vars = {
    '--carbon':         t.bg,
    '--carbon-mid':     t.panel,
    '--carbon-light':   t.panel,
    '--carbon-surface': t.panel2,
    '--carbon-raise':   light ? t.border : t.panel2,
    '--text-primary':   t.text,
    '--text-secondary': t.textSec,
    // For dark themes textDim is darker than the panel — invisible. Use textSec
    // (a readable mid-tone) as the dim color inside the bot panel instead.
    '--text-dim':       light ? t.textDim : t.textSec,
    '--border':         t.border,
    '--amber':          ac.main,
    '--amber-bright':   ac.bright,
    '--amber-dim':      ac.dim,
    '--amber-glow':     ac.glow,
    '--amber-glow-s':   ac.glowS,
    '--border-amber':   ac.border,
    '--radar-ring':     light ? 'rgba(0,0,0,0.10)'       : 'rgba(255,255,255,0.06)',
    '--radar-axis':     light ? 'rgba(0,0,0,0.10)'       : 'rgba(255,255,255,0.07)',
    '--radar-node-inactive': light ? '#708090' : '#4a5060',
    '--radar-node-fill':     light ? ac.main   : ac.bright,
    '--radar-node-active':   light ? ac.bright : '#ffcc55',
    '--radar-label-badge':   light ? ac.dim    : '#ffcc55',
    // Theme-aware fixes for two inline-styled elements in the panel: the
    // Maia-model veil over the Elometer and the green download button.
    '--overlay-veil': light ? 'rgba(248,244,238,0.93)' : 'rgba(14,15,17,0.90)',
    '--dl-green':     light ? '#2e7d4f' : '#5ad490',
    '--dl-green-bg':  light ? 'rgba(46,125,79,0.10)' : 'rgba(90,212,144,0.12)',
    '--dl-green-bd':  light ? 'rgba(46,125,79,0.50)' : 'rgba(90,212,144,0.40)',
  };
  try { localStorage.setItem('bm_panelTheme', JSON.stringify(vars)); } catch(e) {}
  try {
    const frame = document.getElementById('botModalFrame');
    if (frame && frame.contentWindow) {
      // Include the current selection names so the panel's Appearance popover
      // can highlight what's active.
      frame.contentWindow.postMessage({
        type: 'setTheme', vars,
        bg: currentBgTheme, board: currentBoardTheme, pieces: currentPieceSet,
        shell: (typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur'
      }, location.origin);
    }
  } catch(e) {}
}

// ── Format: Carbon (dark dashboard type) vs Journal (editorial serif) ────────
// App-wide setting shared with the bot panel (same localStorage key + a live
// postMessage push). Format controls typography/texture; COLOR stays with the
// background theme — so "Journal + Cool Blue" or "Journal + Clay" both work.
let currentFormat = 'carbon';
function applyFormat(f, fromPanel) {
  currentFormat = (f === 'journal') ? 'journal' : 'carbon';
  document.body.classList.toggle('journal', currentFormat === 'journal');
  try { localStorage.setItem('bm_format', currentFormat); } catch(e) {}
  document.querySelectorAll('[data-format]').forEach(b =>
    b.classList.toggle('active', b.dataset.format === currentFormat));
  if (!fromPanel) {
    try {
      const frame = document.getElementById('botModalFrame');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'setFormat', format: currentFormat }, location.origin);
      }
    } catch(e) {}
  }
}

// ── Panel system ─────────────────────────────────────────────────────
function openPanel(id) {
  closeAllPanels();
  document.getElementById(id).classList.add('open');
  document.getElementById('panelOverlay').classList.add('open');
  // Refresh lobby list whenever the 2-player panel opens, then auto-refresh every 5s
  if (id === 'mpPanel') {
    mpLoadInfo();           // restore last-entered handle / rating / range / TC
    mpHideAnonPrompt();
    if (typeof _mpRefreshStartPosBanner === 'function') _mpRefreshStartPosBanner();
    if (!mpRoomId) mpSetMode('idle');  // default view unless mid-game / waiting
    mpBuildTimeGrid();      // prebuild the matrix (reflects current selection)
    if (typeof mpQsCloseAll === 'function') mpQsCloseAll();  // pills closed, values fresh
    mpRefreshLobby();
    clearInterval(mpLobbyRefreshTimer);
    mpLobbyRefreshTimer = setInterval(mpRefreshLobby, 5000);
  }
}
function closeAllPanels() {
  document.querySelectorAll('.slide-panel').forEach(p => p.classList.remove('open'));
  document.getElementById('panelOverlay').classList.remove('open');
  clearInterval(mpLobbyRefreshTimer); // stop polling when panel closes
}

// ── Help content ──────────────────────────────────────────────────────
const PIN_SVG_PURPLE = '<svg width="48" height="16" style="vertical-align:middle"><ellipse cx="9" cy="7" rx="8" ry="6" fill="#9b59b6"/><ellipse cx="7" cy="5" rx="3" ry="2" fill="rgba(255,255,255,0.3)"/><line x1="17" y1="7" x2="40" y2="7" stroke="#7d3db3" stroke-width="2" stroke-linecap="round"/><polygon points="40,5 40,9 48,7" fill="#5a2a8a"/></svg>';
const PIN_SVG_BLUE    = '<svg width="48" height="16" style="vertical-align:middle"><ellipse cx="9" cy="7" rx="8" ry="6" fill="#3578e0"/><ellipse cx="7" cy="5" rx="3" ry="2" fill="rgba(255,255,255,0.3)"/><line x1="17" y1="7" x2="40" y2="7" stroke="#1a5ab8" stroke-width="2" stroke-linecap="round"/><polygon points="40,5 40,9 48,7" fill="#0a3a90"/></svg>';

const HELP = {
  checkthreats:{title:'Check Threats',body:`<p>Highlights squares where a piece could move to give check — shown for <strong>both sides</strong>.</p>
<p><span style="color:#ff8c00">■</span> <strong>Orange</strong> — squares where White can move a piece to put the Black king in check.</p>
<p><span style="color:#b428dc">■</span> <strong>Purple</strong> — squares where Black can move a piece to put the White king in check.</p>
<p>Useful for spotting forcing moves, escape routes, and tactical sequences involving check. Not shown when a king is already in check.</p>`},
  threats:{title:'Threats',body:`<p>Shows the status of your own pieces using colored circles — letting you see at a glance which are in danger:</p>
<p><span style="color:#d02828">●</span> <strong>Red</strong> — undefended, or can be captured by a less valuable piece. Immediate danger.</p>
<p><span style="color:#1eb446">●</span> <strong>Green</strong> — overprotected and cannot be taken profitably. Safe.</p>
<p><span style="color:#8888a0">●</span> <strong>Grey</strong> — equal attackers and defenders, no cheap capture available. Contested.</p>
<p>No circle = piece is not currently under attack.</p>`},
  captures:{title:'Captures',body:`<p>Shows the status of opponent pieces using colored circles — telling you how safe each capture would be:</p>
<p><span style="color:#d02828">●</span> <strong>Red</strong> — the opponent piece is undefended or can be taken by a less valuable piece. A safe or winning capture.</p>
<p><span style="color:#1eb446">●</span> <strong>Green</strong> — the opponent piece is overprotected. Capturing it likely loses material.</p>
<p><span style="color:#8888a0">●</span> <strong>Grey</strong> — equal attackers and defenders. Exchange may be even — evaluate carefully.</p>
<p>No circle means you cannot currently capture that piece.</p>`},
  unprotected:{title:'Unprotected Pieces',body:`<p>An <strong>unprotected piece</strong> has no friendly defender.</p><p>🎯 <strong>Bullseye</strong> — unprotected, not currently attacked (quietly vulnerable)<br>🔴 <strong>Red ring</strong> — unprotected AND under attack (immediate danger)</p><p>Good habit: keep all pieces protected.</p>`},
  pins:{title:'Pins',body:`<p>A piece is <strong>"pinned"</strong> if moving it would expose a more valuable friendly piece behind it to capture.</p><hr><h3>${PIN_SVG_PURPLE} Absolute pin — to the king</h3><p>The piece <strong>cannot legally move</strong>. Always excluded from threat and defense counts.</p><p><em>Exception: it can capture the pinner — that resolves the pin.</em></p><hr><h3>${PIN_SVG_BLUE} Relative pin — to the queen</h3><p>The piece <strong>can legally move</strong> but doing so loses the queen.</p><p>When Queen Pins is enabled, these pieces are also excluded from counts — a defender pinned to the queen doesn't actually defend.</p>`},
  ghostresponses:{title:'Ghost Responses',body:`<p>After you hover or drag a piece to a candidate square, Stockfish calculates up to two likely opponent responses and shows them as semi-transparent <strong>ghost pieces</strong> on the board.</p><p>This lets you see the position one move deeper without committing — useful for spotting immediate threats or refutations you might otherwise miss.</p><hr><p><strong>Depth settings</strong></p><ul><li><strong>Off</strong> — no ghost responses shown.</li><li><strong>Fast (depth 4)</strong> — near-instant, good for quick checks.</li><li><strong>Medium (depth 8)</strong> — recommended balance of speed and quality.</li><li><strong>Deep (depth 12)</strong> — stronger analysis, slightly slower response.</li></ul><p><em>Stockfish runs locally in your browser. Higher depths use more CPU.</em></p><hr><p>⚔ <strong>Not available in 2-player online games</strong> — engine hints would undercut human-vs-human play. The control is disabled while an online game is live.</p>`},
  batteriessetting:{title:'Batteries in Threat Counts',body:`<p>A <strong>battery</strong> is two or more sliding pieces (rooks, bishops, or the queen) lined up on the same rank, file, or diagonal so they reinforce each other's attacks.</p><p>When this setting is <strong>on</strong>, the threat and defense counts shown on pieces use Static Exchange Evaluation (SEE) — the full sequence of captures is simulated, so a rook behind another rook counts as a second attacker on the same square.</p><p>When <strong>off</strong>, only direct attackers are counted (faster, simpler, but undercounts battery strength).</p><p><em>Also controlled by the Battery Counts indicator button in the indicator grid.</em></p>`},
  queenpinssetting:{title:'Include Queen Pins',body:`<p>A piece is <strong>relatively pinned to the queen</strong> if moving it would expose the queen to capture. The piece can legally move, but doing so loses the queen.</p><p>When this setting is <strong>on</strong>, pieces pinned to the queen are treated as non-defenders — they are excluded from threat and defense counts, because a piece that would cost you your queen to move isn't truly defending anything.</p><p>When <strong>off</strong>, only absolute pins to the king are excluded from counts; queen-pinned pieces are counted as normal defenders.</p><p><em>See the Pins indicator for a visual display of all pinned pieces.</em></p>`},
    forksw:{title:"My Forks & Skewers",body:`<h3>Forks &amp; skewers — what are they?</h3>
<p>A <strong>fork</strong> is a single move that simultaneously attacks two or more enemy pieces, forcing the opponent to abandon one. Knights are especially dangerous forkers because their L-shaped move is hard to see in advance.</p>
<p>A <strong>skewer</strong> is the reverse of a pin — a high-value piece is attacked directly, and when it moves to safety it exposes a less valuable piece behind it to capture.</p>
<hr><h3>How this button works</h3><p>Showing fork opportunities can feel like move suggestion — crossing from "see the board" into "here's your strategy." Use it as a double-check after you've done your own calculation, not as a first-look shortcut.</p><p><strong>Single click</strong> — momentary peek. <strong>Double-click</strong> — toggles the indicator permanently on or off.</p><p><em>Opponent forks (Black's Forks) work the same way — those are danger warnings for you.</em></p><hr><table class="help-table"><tr><th>Color</th><th>Meaning</th></tr><tr><td style="color:#28c850">■ Green</td><td>Safe fork opportunity (landing square not losing)</td></tr><tr><td style="color:#3578e0">■ Blue</td><td>Contested fork (evaluate carefully)</td></tr><tr><td>⬛ Not shown</td><td>Fork where landing loses more than gained</td></tr></table><p><em>Not shown ≠ bad move. Positional factors may still make it excellent.</em></p>`},
  forksb:{title:"Fork &amp; Skewer Threats",body:`<h3>What is a fork or skewer?</h3><p>A <strong>fork</strong> simultaneously attacks two or more enemy pieces — the opponent can only save one. A <strong>skewer</strong> forces a high-value piece to move, exposing a lesser piece behind it.</p><hr><p>Shows opponent fork and skewer threats — danger warnings for you.</p><table class="help-table"><tr><th>Color</th><th>Meaning</th></tr><tr><td style="color:#dc3232">■ Red</td><td>Black has a safe fork/skewer threat</td></tr><tr><td style="color:#dc50b4">■ Pink</td><td>Contested fork (opponent must evaluate)</td></tr></table><p>During move exploration, a target symbol appears on your destination square if moving there creates fork danger.</p>`},
  discoveredopp:{title:'Opponent Discovered Attack Threats',body:`<p>Shows potential discovered attacks the opponent can make — warning you of hidden threats.</p>
<p><span style="color:#dc8200">●</span> <strong>Amber</strong> — moving the marked opponent piece would reveal a slider attack on your pieces.</p>
<p>A dashed ring marks the piece that opens the discovery. A solid ring marks the revealed attacker. A target marks the threatened piece.</p>
<p>Can be kept always-on for passive threat awareness — similar to Check threats.</p>`},
discoveredself:{title:'My Discovered Attacks',body:`<p>Shows discovered attack opportunities available to you.</p>
<p><span style="color:#a050dc">●</span> <strong>Purple</strong> — moving the marked piece would reveal a slider attacking an opponent piece behind it.</p>
<p>Use this as a double-check after your own calculation rather than a first-look prompt, so that spotting the discovery stays your own work.</p><p><strong>Single click</strong> — momentary peek. <strong>Double-click</strong> — toggles permanently on or off.</p>`},
  xray:{title:'X-ray Pressure &amp; Threats',body:`<p>Shows all cases where a sliding piece's attack passes through a friendly blocker to a piece behind it — "hidden pressure" whether or not the blocker can legally move.</p>
<p><span style="color:#000">■</span> <strong>Black</strong> — your own x-ray pressure on opponent pieces (opportunity).</p>
<p><span style="color:#c87800">■</span> <strong>Amber</strong> — opponent x-ray pressure on your pieces (threat/warning).</p>
<p>A dashed ring marks the slider, a dashed ring marks the blocker, a target marks the x-rayed piece. Unlike Discovered Attacks, this includes cases where the blocker cannot legally move off the ray.</p>`},
  overloaded:{title:'Overloaded Pieces',body:`<p>An overloaded piece is the <em>sole</em> defender of two or more pieces. If the opponent attacks both, it can only save one.</p><p>🟡 <strong>Gold ring + number</strong> — overloaded; number = dependent pieces<br>🟡 <strong>Gold dashed ring</strong> — depends on an overloaded defender<br>🟡 <strong>Dashed lines</strong> — connecting to each dependent piece</p>`},
  weakw:{title:'My Weak Squares',body:`<p>Empty squares not controlled by any of your pieces — the opponent could safely place a piece there.</p><p>Weak squares near your king are entry points for attack. Weak squares in enemy territory are outpost opportunities for them.</p>`},
  weakb:{title:"Opponent's Weak Squares",body:`<p>Empty squares the opponent doesn't control — squares you could safely occupy.</p><p>These are your outpost opportunities.</p>`},
  rings:{title:'Threat/Defense Halos',body:`<p>Stacked arc halos drawn around each piece show defender and attacker counts at a glance.</p>
<p>🟢 <strong>Green arcs above</strong> — each arc represents one friendly defender</p>
<p>🔴 <strong>Red arcs below</strong> — each arc represents one enemy attacker</p>
<p>More red than green means the piece is outnumbered. Use alongside Threat/Defense Counts for exact numbers.</p>
<p><em>Note: Pieces pinned to the king are never included in counts as they cannot legally move to defend. See the Pins indicator for details.</em></p>`},
  counts:{title:'Threat/Defense Counts',body:`<p>Numbers on each piece show exact defender and attacker counts.</p>
<p>🟢 <strong>Top number (green)</strong> — friendly defenders<br>🔴 <strong>Bottom number (red)</strong> — enemy attackers</p>
<p><strong>What's included in counts:</strong></p>
<p>• <strong>King pins</strong> (absolute): Never included — pinned pieces cannot legally move to attack or defend.</p>
<p>• <strong>Queen pins</strong> (relative): Included when "Include Queen Pins" is <em>off</em>. Excluded when it is <em>on</em> — because a piece pinned to the queen doesn't truly defend if capturing would cost the queen.</p>
<p>• Pieces pinned to a rook, bishop, or knight are always included (they can still legally move to defend in most cases).</p>`},
  influence:{title:'Piece Influence',body:`<p>Every square each piece controls — not just squares with enemy pieces.</p><p>🔵 Blue — white controls · 🟠 Orange — black controls</p><p>Most useful during move exploration to understand positional consequences. Pawns show diagonal attack squares only.</p>`},
  battery:{title:'Battery Counts',body:`<p>A battery is two or more sliding pieces lined up so they support each other's attacks — two rooks on a file, or queen+bishop on a diagonal.</p><p>With batteries enabled, counts include all pieces in the line. Uses Static Exchange Evaluation (SEE).</p>`},
  legal:{title:'Show Legal Moves',body:`<p>Highlights all legal destination squares when a piece is selected.</p><p>Respects pins, check, castling, and en passant.</p><p><em>Tip: Turn this off to practice visualizing legal moves yourself — a key skill in real games.</em></p>`},
  howto:{title:'Training Tips — Decide First, Then Look',body:`
<p>The overlays never tell you what to play. They show you what is <em>true</em> on the board — who attacks what, what's defended, what's hanging — and leave the judgment to you. To turn that into lasting chess strength, use this loop:</p>
<p><strong>1. Calculate first.</strong> Look at the position and choose your move entirely in your head. No hovering, no exploring.</p>
<p><strong>2. Commit.</strong> Settle on it: <em>"I'm playing Nf5."</em></p>
<p><strong>3. Then explore that one move.</strong> Pick the piece up and set it on your square. Now let the board talk — the rings, counts, and fork markers show the interactions you spotted, and the ones you missed. The ghost piece shows what your opponent might do about it.</p>
<p><strong>4. Recalculate.</strong> Saw something new? Put the piece back and start again from step 1 with better eyes.</p>
<p>The overlays work best as a <em>check on calculation you already did</em> — not a substitute for it. Decide first, then look. Over time, the things the board has to show you will be things you already saw.</p>`},
};

function openHelp(key, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const h = HELP[key];
  if (!h) return;
  document.getElementById('helpPanelTitle').textContent = h.title;
  document.getElementById('helpPanelBody').innerHTML = h.body;
  openPanel('helpPanel');
}

// ── IND system ────────────────────────────────────────────────────────
const PIECE_VALUE = {K:0,Q:9,R:5,B:3,N:3,P:1};

const IND = {
  // Indicators INITIALIZE to preview-on (`pre:true`) so a first-time user sees
  // them in action while exploring a move and learns how they work. Nothing is
  // always-on (`on:false`). ibRefreshAll() syncs every button's highlight to
  // these flags, so what the buttons show always matches what actually renders —
  // and the user can switch any of them off. A few overlays init off because
  // they're noisier or gated by their own checkbox (xray/weak*/battery).
  checkthreats:  {on:false,pre:true, pressing:false},
  threats:       {on:false,pre:true, pressing:false},
  // captures merged into threats button
  unprotected:   {on:false,pre:true, pressing:false},
  pins:          {on:false,pre:true, pressing:false},
  forksw:        {on:false,pre:true, pressing:false},
  forksb:        {on:false,pre:true, pressing:false},
  discoveredopp: {on:false,pre:true, pressing:false},
  discoveredself:{on:false,pre:true, pressing:false},
  xray:          {on:false,pre:false,pressing:false},
  overloaded:    {on:false,pre:false,pressing:false},
  weakw:         {on:false,pre:false,pressing:false},
  weakb:         {on:false,pre:false,pressing:false},
  rings:         {on:false,pre:true, pressing:false},
  counts:        {on:false,pre:true, pressing:false},
  influence:     {on:false,pre:true, pressing:false},
  battery:       {on:false,pre:false,pressing:false},
  legal:         {on:false,pre:true, pressing:false},
};

function indActive(key) {
  // Pro shell: no board-vision indicators at all (pieces + last move only)
  if (typeof proMode !== 'undefined' && proMode) return false;
  if (typeof IND==='undefined') return false;
  const ind=IND[key]; if(!ind) return false;
  if(key==='legal'){const el=document.getElementById('cbLegalToggle');return el?el.checked:true;}
  if(key==='battery'){const el=document.getElementById('cbBattery');return el?el.checked:false;}
  if(key==='influence'){
    const el=document.getElementById('cbInfluenceToggle');
    if(el&&!el.checked) return false;
    return !!previewBoard||currentlyPreviewing;
  }
  if(ind.pressing) return true;
  if(ind.on) return true;
  // "Show During Exploration" (pre) indicators stay active for the whole
  // exploration, INCLUDING while the piece is dragged off its origin square.
  // That is the point of beginner/visualization mode: the overlays are
  // computed on previewBoard (piece placed on its destination), so a threat
  // circle appears on the destination square — e.g. a queen dragged to a
  // square where it hangs shows the threat ring BEFORE the move is committed.
  // The dragged piece itself is drawn as a separate translucent glyph
  // following the cursor, so the circle sits on the board, not on the
  // carried piece.
  if(ind.pre&&(!!previewBoard||currentlyPreviewing)) return true;
  return false;
}

function ibPress(key,e){
  if(e) e.preventDefault();
  if(!IND[key]) return;
  // forksw allowed during exploration
  IND[key].pressing=true;
  ibUpdateUI(key);
  indApply();
}
function ibRelease(key){
  if(!IND[key]) return;
  IND[key].pressing=false;
  ibUpdateUI(key);
  indApply();
}
function ibTogglePre(key){
  IND[key].pre=!IND[key].pre;
  ibUpdateUI(key);
  indApply();
}
function ibUpdateUI(key){
  const ind=IND[key]; if(!ind) return;
  // Keep the "Show During Exploration" (pre) button highlight in sync with the
  // variable first, so it always matches even if the main button is absent.
  const preBtn=document.getElementById('pre-'+key);
  if(preBtn) preBtn.classList.toggle('active',ind.pre);
  const el=document.getElementById('ib-'+key); if(!el) return;
  el.classList.remove('on','pre','pressing');
  if(ind.pressing) el.classList.add('pressing');
  else if(ind.on) el.classList.add('on');  // always-on: full green
  else if(ind.pre) el.classList.add('pre'); // preview mode: persistent subtle highlight + status dot
}
function ibRefreshAll(){Object.keys(IND).forEach(k=>ibUpdateUI(k));}

// Aliases so indApply and newer code can call these by either name
function indUpdateUI(key){ ibUpdateUI(key); }
function indRefreshPremoveUI(){ ibRefreshAll(); }
function indInitAll(){ ibRefreshAll(); }
function indMode(key, mode, e){
  if(e){ e.stopPropagation(); e.preventDefault(); }
  if(!IND[key]) return;
  // forksw mode changes allowed
  // Map new mode names to on/pre flags
  IND[key].on  = (mode === 'always');
  IND[key].pre = (mode === 'premove' || mode === 'always');
  ibUpdateUI(key);
  indApply();
}

// Main button click handler (toggle on/off)
// Attached via onclick on ib-main elements — but we need to avoid
// firing during hold. Use a threshold: < 200ms = click, >= 200ms = hold
const ibPressTime = {};
const ibLastClick = {};
function ibMainDown(key,e){
  if(e) e.preventDefault();
  // If hide is locked, any IND button press releases it and restores state
  if(typeof hideShowLocked!=='undefined'&&hideShowLocked&&!hideShowPeeking){
    hideShowLocked=false;
    hideShowRestore();
    updateHideShowBtn();
  }
  ibPressTime[key] = Date.now();
  ibPress(key,e);
}
function ibMainUp(key){
  const dt = Date.now() - (ibPressTime[key]||0);
  ibRelease(key);
  if(dt < 250) {
    const now = Date.now();
    const sinceLastClick = now - (ibLastClick[key]||0);
    if(sinceLastClick < 400) {
      // Double click cycles: off(pre-only) → always-on → truly-off → off(pre-only)…
      // Key invariant: once a user explicitly turns an indicator OFF, it is
      // completely off (pre=false too). "Off means off."
      if(!IND[key].on && IND[key].pre){
        // preview-only → always-on
        IND[key].on = true; IND[key].pre = true;
      } else if(IND[key].on){
        // always-on → truly off
        IND[key].on = false; IND[key].pre = false;
      } else {
        // truly-off → preview-only (re-enable preview without always-on)
        IND[key].on = false; IND[key].pre = true;
      }
      ibLastClick[key] = 0; // reset so next click starts fresh
    } else {
      // Single click = just a peek (press/release already handled)
      ibLastClick[key] = now;
    }
    ibUpdateUI(key);
    indApply();
  }
}

// ── Board square color helper ─────────────────────────────────────────
function sqColor(r,c){
  const t=BOARD_THEMES[currentBoardTheme]||BOARD_THEMES.classic;
  return (r+c)%2===0?t.light:t.dark;
}

// ── State vars ────────────────────────────────────────────────────────
let replayMoves=[],replayIdx=0,inReplay=false;
let cleanMode=false;
let gameMovesAlgebraic=[];


// ── Chat system ───────────────────────────────────────────────────────────────
let chatExpanded = false;

function chatShow(visible){
  const box = document.getElementById('chatBox');
  if(box) box.style.display = visible ? 'flex' : 'none';
  if(visible){
    // Always start collapsed when a game begins
    chatExpanded = false;
    const body = document.getElementById('chatBody');
    if(body) body.style.display = 'none';
    const chev = document.getElementById('chatChevron');
    if(chev) chev.style.transform = '';   // ▼ = collapsed, no rotation
  }
  if(!visible) chatClearUnread();
}

function chatToggleExpand(noFocus){
  chatExpanded = !chatExpanded;
  const body = document.getElementById('chatBody');
  const chev = document.getElementById('chatChevron');
  if(body) body.style.display = chatExpanded ? 'flex' : 'none';
  // ▼ rotated 180° = ▲ when expanded
  if(chev) chev.style.transform = chatExpanded ? 'rotate(180deg)' : '';
  if(chatExpanded){
    chatClearUnread();
    const msgs = document.getElementById('chatMessages');
    if(msgs) msgs.scrollTop = msgs.scrollHeight;
    // Focus the input so the user can type immediately — but NOT when the
    // expand was triggered by an incoming message (stealing focus mid-game,
    // or popping the mobile keyboard, would be worse than the message).
    if(!noFocus){
      const inp = document.getElementById('chatInput');
      if(inp) inp.focus();
    }
  }
}

function chatSend(){
  const input = document.getElementById('chatInput');
  if(!input) return;
  const text = input.value.trim();
  if(!text) return;
  if(!mpWs || mpWs.readyState !== WebSocket.OPEN) return;
  mpWs.send(JSON.stringify({type:'chat', text}));
  chatAppend('You', text, true);
  input.value = '';
}

function chatAppend(from, text, isMe){
  const msgs = document.getElementById('chatMessages');
  if(!msgs) return;
  const safe = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const line = document.createElement('div');
  line.className = 'chat-msg ' + (isMe ? 'mine' : 'theirs');
  line.innerHTML = '<span class="chat-sender">' + (isMe ? 'You' : from) + ':</span> ' + safe;
  msgs.appendChild(line);
  msgs.scrollTop = msgs.scrollHeight;
  // Auto-expand chat on an incoming message so it's immediately visible —
  // no unread dot to click. Expand without stealing keyboard focus.
  if(!isMe && !chatExpanded) chatToggleExpand(true);
}

// ══════════════════════════════════════════════════════════════════════════
// PRO SHELL — in-app switchable mode. Reuses the live board/engine/game state;
// only the surrounding chrome changes. Additive: amateur shell is untouched
// unless proMode is on.
// ══════════════════════════════════════════════════════════════════════════
let proMode = false;
let _proSaved = null;   // amateur board settings, restored on exit

function setShell(mode){
  const toPro = (mode === 'pro');
  if(toPro === proMode) return;
  proMode = toPro;
  document.body.classList.toggle('pro-mode', proMode);
  try{ localStorage.setItem('bm_shell', proMode ? 'pro' : 'amateur'); }catch(e){}
  if(proMode){
    proMountChat();
    proApplyBoardClean();   // slate board + indicators off (minimal look)
    proSync();
  } else {
    const gm = document.getElementById('proGearMenu'); if(gm) gm.style.display = 'none';
    proUnmountChat();
    proRestoreBoard();
  }
  if(typeof render === 'function') render();
  if(typeof distUpdateVisibility === 'function') distUpdateVisibility();
  // Board experience lives in the style palettes now — sync their buttons and
  // let the bot panel's Appearance popover know.
  document.querySelectorAll('[data-shell-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.shellBtn === (proMode ? 'pro' : 'amateur')));
  if (typeof _syncPanelTheme === 'function' && typeof BG_THEMES !== 'undefined') {
    _syncPanelTheme(BG_THEMES[currentBgTheme] || BG_THEMES.navy);
  }
}
function toggleShell(){ setShell(proMode ? 'amateur' : 'pro'); }

function proToggleGear(){
  const m = document.getElementById('proGearMenu');
  if(m) m.style.display = (m.style.display === 'none' || !m.style.display) ? 'flex' : 'none';
}

function proFlipBoard(){
  if(typeof boardFlipped !== 'undefined') boardFlipped = !boardFlipped;
  if(typeof render === 'function') render();
  proSync();
}

// Minimal board: slate squares, no legal dots, no ghosts, no indicator overlays
function proApplyBoardClean(){
  _proSaved = {
    boardTheme: (typeof currentBoardTheme !== 'undefined') ? currentBoardTheme : null,
    legal: document.getElementById('cbLegalToggle') ? document.getElementById('cbLegalToggle').checked : null,
    ghost: document.getElementById('soloGhostDepth') ? document.getElementById('soloGhostDepth').value : null,
  };
  if(typeof applyBoardTheme === 'function') applyBoardTheme('slate');
  const lg = document.getElementById('cbLegalToggle'); if(lg) lg.checked = false;
  const gh = document.getElementById('soloGhostDepth');
  if(gh){ gh.value = '0'; if(typeof ghostModeChanged === 'function') ghostModeChanged(); }
  if(typeof clearAllSelections === 'function') clearAllSelections();
  if(typeof indApply === 'function') indApply();   // recompute → all showing* flags off
}
function proRestoreBoard(){
  if(!_proSaved) return;
  if(_proSaved.boardTheme && typeof applyBoardTheme === 'function') applyBoardTheme(_proSaved.boardTheme);
  const lg = document.getElementById('cbLegalToggle'); if(lg && _proSaved.legal != null){ lg.checked = _proSaved.legal; }
  const gh = document.getElementById('soloGhostDepth');
  if(gh && _proSaved.ghost != null){ gh.value = _proSaved.ghost; if(typeof ghostModeChanged === 'function') ghostModeChanged(); }
  _proSaved = null;
  if(typeof indApply === 'function') indApply();   // recompute the amateur indicators
}

function proMountChat(){
  const chat = document.getElementById('chatBox');
  const mount = document.getElementById('proChatMount');
  if(chat && mount && chat.parentNode !== mount) mount.appendChild(chat);
}
function proUnmountChat(){
  const chat = document.getElementById('chatBox');
  const col = document.getElementById('board-col');
  if(chat && col && chat.parentNode !== col){
    const pw = document.getElementById('playerBoxW');
    if(pw && pw.nextSibling) col.insertBefore(chat, pw.nextSibling);
    else col.appendChild(chat);
  }
}

function proRenderNotation(){
  const el = document.getElementById('proMoves');
  if(!el || typeof gameMovesAlgebraic === 'undefined') return;
  if(!gameMovesAlgebraic.length){ el.innerHTML = '<div class="pro-moves-empty">No moves yet</div>'; return; }
  // During replay, highlight the move at the current replay position.
  const hiIdx = (typeof inReplay !== 'undefined' && inReplay && typeof replayIdx !== 'undefined')
    ? replayIdx - 1 : -1;
  // Outside live play, moves are clickable — jump the board to that position
  const clickable = typeof _isLiveGame === 'function' && !_isLiveGame();
  const attrs = i => clickable ? ' pro-mclick" onclick="proMoveClick(' + i + ')"' : '"';
  let html = '';
  for(let i=0;i<gameMovesAlgebraic.length;i+=2){
    const n = i/2 + 1;
    const w = gameMovesAlgebraic[i] || '';
    const b = gameMovesAlgebraic[i+1] || '';
    const wHi = i === hiIdx ? ' pro-mhi' : '';
    const bHi = i+1 === hiIdx ? ' pro-mhi' : '';
    html += '<div class="pro-moverow"><span class="pro-mnum">' + n + '.</span>' +
            '<span class="pro-mw' + wHi + attrs(i) + '>' + w + '</span>' +
            (b ? '<span class="pro-mb' + bHi + attrs(i+1) + '>' + b + '</span>'
               : '<span class="pro-mb"></span>') + '</div>';
  }
  el.innerHTML = html;
  // Keep the highlighted move in view during replay; otherwise stick to the end
  const hi = el.querySelector('.pro-mhi');
  if(hi && typeof hi.scrollIntoView === 'function') hi.scrollIntoView({ block:'nearest' });
  else el.scrollTop = el.scrollHeight;
}

// Mirror live game state into the pro side column (clocks, names, turn, moves)
function proSync(){
  if(!proMode) return;
  proRenderNotation();
  const flipped = (typeof boardFlipped !== 'undefined') && boardFlipped;
  const topIsWhite = flipped;             // top strip = side at top of the board
  const tTime = document.getElementById(topIsWhite ? 'timeW' : 'timeB');
  const bTime = document.getElementById(topIsWhite ? 'timeB' : 'timeW');
  const ct = document.getElementById('proClockTop'), cb = document.getElementById('proClockBottom');
  if(ct && tTime) ct.textContent = tTime.textContent;
  if(cb && bTime) cb.textContent = bTime.textContent;
  const whiteToMove = (typeof turn !== 'undefined') && (turn === 'w');
  const over = (typeof gameOver !== 'undefined') && gameOver;
  const topActive = topIsWhite ? whiteToMove : !whiteToMove;
  const pt = document.getElementById('proPlayerTop'), pb = document.getElementById('proPlayerBottom');
  if(pt) pt.classList.toggle('active', topActive && !over);
  if(pb) pb.classList.toggle('active', !topActive && !over);
  const pnW = document.querySelector('#playerBoxW .player-name');
  const pnB = document.querySelector('#playerBoxB .player-name');
  const wName = pnW ? pnW.textContent : 'White';
  const bName = pnB ? pnB.textContent : 'Black';
  const nt = document.getElementById('proNameTop'), nb = document.getElementById('proNameBottom');
  const at = document.getElementById('proAvatarTop'), ab = document.getElementById('proAvatarBottom');
  if(nt) nt.textContent = topIsWhite ? wName : bName;
  if(nb) nb.textContent = topIsWhite ? bName : wName;
  if(at) at.textContent = topIsWhite ? '♔' : '♚';
  if(ab) ab.textContent = topIsWhite ? '♚' : '♔';
  // Material advantage
  if(typeof computeMaterial === 'function' && typeof board !== 'undefined'){
    const mat = computeMaterial(board);
    const diff = mat.w - mat.b;
    const topMat  = document.getElementById('proMatTop');
    const botMat  = document.getElementById('proMatBottom');
    if(topMat)  topMat.innerHTML  = (topIsWhite  ? diff  > 0 : diff  < 0) && typeof matAdvString==='function'
      ? matAdvString(Math.abs(diff), topIsWhite ? mat.wPieces : mat.bPieces, topIsWhite ? mat.bPieces : mat.wPieces) : '';
    if(botMat)  botMat.innerHTML  = (!topIsWhite ? diff  > 0 : diff  < 0) && typeof matAdvString==='function'
      ? matAdvString(Math.abs(diff), !topIsWhite ? mat.wPieces : mat.bPieces, !topIsWhite ? mat.bPieces : mat.wPieces) : '';
  }
  // Result bar and button state
  const resultBar = document.getElementById('proResultBar');
  if(resultBar){
    resultBar.style.display = over ? 'block' : 'none';
    if(over){
      const msg = (typeof gameOverMsg !== 'undefined' && gameOverMsg) ? gameOverMsg : 'Game over';
      resultBar.textContent = msg;
    }
  }
  // Resign/Draw only exist while a game is actually live; otherwise the side
  // column shows the idle actions (Rematch after a finish, start a bot or
  // 2-player game, save/load, save the current bot).
  const liveGame = !over && (
    (typeof botActive !== 'undefined' && botActive) ||
    (typeof mpRoomId !== 'undefined' && mpRoomId &&
     typeof mpMode !== 'undefined' && mpMode === 'ingame'));
  const resignBtn = document.getElementById('proResignBtn');
  const drawBtn   = document.getElementById('proDrawBtn');
  if(resignBtn) resignBtn.style.display = liveGame ? '' : 'none';
  if(drawBtn)   drawBtn.style.display   = liveGame ? '' : 'none';
  const idleRow = document.getElementById('proIdleActions');
  if(idleRow) idleRow.style.display = liveGame ? 'none' : 'flex';
  const rematchBtn = document.getElementById('proRematchBtn');
  if(rematchBtn) rematchBtn.style.display = over ? '' : 'none';
  // Review is available whenever there are moves and no live game (finished
  // games, but also explore mode after the fact)
  const reviewBtn = document.getElementById('proReviewBtn');
  if(reviewBtn) reviewBtn.style.display =
    (!liveGame && !inReplay && typeof gameMovesAlgebraic !== 'undefined' &&
     gameMovesAlgebraic.length > 0) ? '' : 'none';
  const saveBotBtn = document.getElementById('proSaveBotBtn');
  if(saveBotBtn) saveBotBtn.style.display = window._lastAppliedBotConfig ? '' : 'none';
}

// Rematch from the pro idle row — same dispatch as the amateur action button.
function proRematch(){
  if (typeof mpRoomId !== 'undefined' && mpRoomId) mpOfferRematch();
  else if (typeof botActive !== 'undefined' && botActive) botStart();
  else resetGame();
}

// Download the last bot config that was actually started, as a shareable file
// the panel's "Load bot" understands. No config yet → open the Bot Builder.
function proSaveCurrentBot(){
  const cfg = window._lastAppliedBotConfig;
  if(!cfg){ if(typeof openBotModal === 'function') openBotModal(); return; }
  const suggested = (cfg.engine || 'bot') + (cfg.elo ? '-' + cfg.elo : '');
  const name = prompt('Name this bot:', suggested);
  if(!name) return;
  const clean = Object.assign({}, cfg); delete clean.type;
  const payload = JSON.stringify({ name: name, config: clean, savedAt: Date.now() }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = name.replace(/[^a-z0-9_\-]/gi, '_') + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Restore the saved shell on load. window.__bmShell is resolved by the inline
// script next to the landing markup: the stored choice if there is one, else
// the first-visit default for this domain (Expert on buildabotchess.com).
// Falling back to localStorage keeps this working if that script didn't run.
document.addEventListener('DOMContentLoaded', () => {
  try{
    const want = window.__bmShell || localStorage.getItem('bm_shell');
    if(want === 'pro') setShell('pro');
  }catch(e){}
});

// ══════════════════════════════════════════════════════════════════════════
// GUIDED TOUR — spotlight overlay with per-shell step sequences. The overlay
// is click-through (pointer-events:none) so users can jump straight into an
// action; clicking anything outside the tour panel ends the tour.
// ══════════════════════════════════════════════════════════════════════════
const TOURS = {
  amateur: [
    { sel:'#bottom-controls', title:'Start playing',
      body:'Play a bot, challenge a friend online, or just explore. You can click any button here right now — or keep touring.' },
    { sel:'#botSidebarBtn', title:'Play vs Bots',
      body:'Build a custom opponent: pick an engine and rating, give it a personality, custom controls, an opening repertoire, and time-pressure behaviour.' },
    { sel:'.ind-grid', title:'Board-vision indicators', indSection:true,
      body:'These overlays draw what a stronger player sees — threats, pins, forks and more. We’ll light each one up on a sample position so you can see exactly what it does.' },
    { sel:'#ib-threats', title:'Three ways to show an indicator', indSection:true, modes:'threats',
      body:'Watch this button cycle through its three modes — <b>Off</b> (grey) → <b>Show during exploration</b> (only while you drag a piece) → <b>Always-on</b> (green). Single-click any indicator to peek, double-click to keep it on.' },
    { sel:'.ind-grid', title:'How to train with these', indSection:true,
      body:'Best habit: <b>look first and try to spot it yourself</b> — plan your move and picture the threats and replies in your head. <i>Then</i> switch an indicator on as instant feedback to catch anything you missed.' },
    { sel:'#ib-checkthreats', title:'Check threats', indSection:true, ind:'checkthreats',
      body:'Squares where a check could be delivered next move — and the pieces that could give it. Spot perpetuals and king-hunt ideas.' },
    { sel:'#ib-threats', title:'Threats & captures', indSection:true, ind:'threats',
      body:'Red rings mark your pieces that are attacked. It flags hanging pieces and what can be captured right now — the #1 way to stop getting blundermined.' },
    { sel:'#ib-counts', title:'Threat / defender counts', indSection:true, ind:'counts',
      body:'For each piece, how many attackers vs defenders it has. When attackers outnumber defenders, something’s about to fall.' },
    { sel:'#ib-unprotected', title:'Unprotected pieces', indSection:true, ind:'unprotected',
      body:'Pieces with no defender at all — loose pieces that drop to a single tactic.' },
    { sel:'#ib-pins', title:'Pins', indSection:true, ind:'pins',
      body:'Pieces pinned to a more valuable piece (or the king) behind them — they can’t safely move off the line.' },
    { sel:'#ib-forksw', title:'My forks & skewers', indSection:true, ind:'forksw',
      body:'Squares where one of your pieces could fork or skewer two enemy pieces at once.' },
    { sel:'#ib-forksb', title:'Fork & skewer threats', indSection:true, ind:'forksb',
      body:'The same, but against you — where the opponent could fork or skewer your pieces.' },
    { sel:'#ib-overloaded', title:'Overloaded defenders', indSection:true, ind:'overloaded',
      body:'A piece doing too many defensive jobs at once. Remove or distract it and one of its charges falls.' },
    { sel:'#ib-discoveredopp', title:'Opponent discovered threats', indSection:true, ind:'discoveredopp',
      body:'Moves that would unveil an attack from a piece hiding behind the one that moves — easy to miss.' },
    { sel:'#ib-discoveredself', title:'My discovered attacks', indSection:true, ind:'discoveredself',
      body:'Your own discovered-attack chances — move the front piece and the one behind springs to life.' },
    { sel:'#ib-weakw', title:'My weak squares', indSection:true, ind:'weakw',
      body:'Holes in your own camp that no pawn can defend — squares the opponent would love to plant a piece on.' },
    { sel:'#ib-weakb', title:'Opponent weak squares', indSection:true, ind:'weakb',
      body:'Holes in their camp — outpost squares where your knight or bishop can sit untouchable.' },
    { sel:'#ib-xray', title:'X-ray pressure', indSection:true, ind:'xray',
      body:'Pressure or defence acting through another piece on the same line — the lines that matter once a blocker moves.' },
    { sel:'#soloGhostDepth', title:'Ghost moves',
      body:'Hover a destination square and the bot shows the most likely replies as faint “ghost” pieces — handy for training your calculation.' },
    { sel:'#btnTheme', title:'Style & board experience',
      body:'Colors, pieces, Carbon vs Journal format — and the board experience itself: switch between this Training board and the clean Expert board here, anytime.' },
    { sel:'#site-name', title:'Home',
      body:'Click the Blundermind logo anytime to return Home and switch between the Beginner and Expert boards.' },
  ],
  pro: [
    { sel:'#proSide', title:'The Expert board',
      body:'A clean tournament view — minimal chrome, live notation, and no coaching overlays.' },
    { sel:'.pro-actions', title:'Board controls',
      body:'Resign, offer a draw, flip the board, or open the 🎨 style palette — where you can also switch back to the Training board. The ⚙ menu has more: a bot game, 2-player, save/load.' },
    { sel:'#proMoves', title:'Move list',
      body:'Your game notation updates here live as you play.' },
  ],
};

let _tourSteps = [], _tourIdx = 0, _tourActive = false, _tourShell = 'amateur';

// ── Indicator demo: light each overlay on a sample position during the tour ──
// A tactic-rich position so threats/pins/counts/weak-squares actually appear.
const _TOUR_DEMO_FEN = 'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 1';
let _tourSavedInd = null, _tourSavedFen = null, _tourDidDemo = false, _tourModeTimer = null;

function _tourSafeToDemo(){
  // Never disturb a live game — only swap in the demo position from a fresh/idle board.
  return (typeof gameMovesAlgebraic === 'undefined' || !gameMovesAlgebraic.length ||
          (typeof gameOver !== 'undefined' && gameOver));
}
function _tourSnapshotInd(){
  if(typeof IND === 'undefined'){ _tourSavedInd = null; return; }
  _tourSavedInd = {};
  Object.keys(IND).forEach(k => { _tourSavedInd[k] = { on:IND[k].on, pre:IND[k].pre, pressing:IND[k].pressing }; });
}
function _tourLoadFen(fen){
  try{
    board = parseFen(fen);
    if(typeof buildAtk === 'function') atkMap = buildAtk(board);
    if(typeof computePins === 'function'){ const p = computePins(board); pinnedWSquares = p.w; pinnedBSquares = p.b; }
    if(typeof indApply === 'function') indApply();
    if(typeof render === 'function') render();
  }catch(e){}
}
function _tourEnsureDemo(){
  if(_tourDidDemo || !_tourSafeToDemo()) return;
  try{ _tourSavedFen = boardToFen(board, turn, castling, epSq); }catch(e){ _tourSavedFen = null; }
  _tourLoadFen(_TOUR_DEMO_FEN);
  _tourDidDemo = true;
}
function _tourShowIndicator(key){
  if(typeof IND === 'undefined') return;
  Object.keys(IND).forEach(k => { IND[k].on = false; IND[k].pressing = false; });
  if(key && IND[key]) IND[key].on = true;   // always-on so the overlay shows now
  if(typeof ibRefreshAll === 'function') ibRefreshAll();
  if(typeof indApply === 'function') indApply();
  if(typeof render === 'function') render();
}
function _tourCycleModes(key){
  if(typeof IND === 'undefined' || !IND[key]) return;
  const seq = [ {on:false,pre:false}, {on:false,pre:true}, {on:true,pre:false} ]; // off → premove → always-on
  let i = 0;
  const apply = () => {
    IND[key].on = seq[i].on; IND[key].pre = seq[i].pre; IND[key].pressing = false;
    if(typeof ibUpdateUI === 'function') ibUpdateUI(key);
    if(typeof indApply === 'function') indApply();
    if(typeof render === 'function') render();
    i = (i + 1) % seq.length;
  };
  apply();
  _tourModeTimer = setInterval(apply, 1100);
}
function _tourRestoreBoard(){
  if(_tourModeTimer){ clearInterval(_tourModeTimer); _tourModeTimer = null; }
  if(_tourSavedInd && typeof IND !== 'undefined'){
    Object.keys(_tourSavedInd).forEach(k => { if(IND[k]){ IND[k].on=_tourSavedInd[k].on; IND[k].pre=_tourSavedInd[k].pre; IND[k].pressing=_tourSavedInd[k].pressing; } });
  }
  if(_tourDidDemo && _tourSavedFen) _tourLoadFen(_tourSavedFen);
  _tourDidDemo = false;
  if(typeof ibRefreshAll === 'function') ibRefreshAll();
  if(typeof indApply === 'function') indApply();
  if(typeof render === 'function') render();
}

// On phones the board-vision settings live in a collapsed drawer, so their
// elements have zero width — and the filter below would drop every indicator
// step, cutting the tour from 21 steps to 4 and losing the part that actually
// teaches the product. Open the drawer for the duration of the tour and put it
// back afterwards.
let _tourOpenedBv = false;
function _tourOpenBoardSettings(){
  const box = document.getElementById('board-settings');
  const btn = document.getElementById('bv-toggle');
  if(!box || !btn) return;
  if(getComputedStyle(btn).display === 'none') return;   // desktop: always open
  if(!box.classList.contains('open')){
    box.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    _tourOpenedBv = true;
  }
}
function _tourRestoreBoardSettings(){
  if(!_tourOpenedBv) return;
  _tourOpenedBv = false;
  const box = document.getElementById('board-settings');
  const btn = document.getElementById('bv-toggle');
  if(box) box.classList.remove('open');
  if(btn) btn.setAttribute('aria-expanded', 'false');
}

function startTour(){
  _tourShell = (typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur';
  _tourDidDemo = false; _tourSavedFen = null;
  if(_tourShell === 'amateur') _tourSnapshotInd();
  _tourOpenBoardSettings();   // must run BEFORE the visibility filter below
  const all = TOURS[_tourShell] || [];
  // Keep only steps whose target is present and visible (drops hidden chrome).
  _tourSteps = all.filter(s => {
    if(!s.sel) return true;
    const el = document.querySelector(s.sel);
    return el && el.getBoundingClientRect().width > 0;
  });
  if(!_tourSteps.length) return;
  _tourIdx = 0; _tourActive = true;
  const ov = document.getElementById('tourOverlay'); if(ov) ov.style.display = 'block';
  _renderTourStep();
}
function endTour(){
  _tourActive = false;
  const ov = document.getElementById('tourOverlay'); if(ov) ov.style.display = 'none';
  if(_tourShell === 'amateur') _tourRestoreBoard();
  _tourRestoreBoardSettings();
  try{ localStorage.setItem('bm_tour_' + _tourShell, '1'); }catch(e){}
}
function tourNext(){ if(_tourIdx < _tourSteps.length - 1){ _tourIdx++; _renderTourStep(); } else endTour(); }
function tourPrev(){ if(_tourIdx > 0){ _tourIdx--; _renderTourStep(); } }

function _renderTourStep(){
  const step = _tourSteps[_tourIdx];
  const ring = document.getElementById('tourRing');
  const back = document.getElementById('tourBackdrop');
  if(!step || !ring) return;
  // Indicator demo (Beginner shell): show each overlay on a sample position.
  if(_tourModeTimer){ clearInterval(_tourModeTimer); _tourModeTimer = null; }
  if(_tourShell === 'amateur'){
    if(step.indSection){
      _tourEnsureDemo();
      if(step.modes) _tourCycleModes(step.modes);
      else _tourShowIndicator(step.ind || null);
    } else if(_tourDidDemo){
      _tourRestoreBoard();         // left the indicator section — restore the board
    } else {
      _tourShowIndicator(null);    // earlier steps: keep the board free of overlays
    }
  }
  const el = step.sel ? document.querySelector(step.sel) : null;
  let rect = null;
  if(el){ try{ el.scrollIntoView({block:'nearest'}); }catch(e){} rect = el.getBoundingClientRect(); }
  if(rect && rect.width > 0){
    ring.style.display = 'block';
    ring.style.top = (rect.top - 6) + 'px';
    ring.style.left = (rect.left - 6) + 'px';
    ring.style.width = (rect.width + 12) + 'px';
    ring.style.height = (rect.height + 12) + 'px';
    if(back) back.style.display = 'none';
  } else {
    ring.style.display = 'none';
    if(back) back.style.display = 'block';
  }
  const cEl = document.getElementById('tourCount'); if(cEl) cEl.textContent = (_tourIdx + 1) + ' / ' + _tourSteps.length;
  const tEl = document.getElementById('tourTitle'); if(tEl) tEl.textContent = step.title;
  const bEl = document.getElementById('tourBody'); if(bEl) bEl.innerHTML = step.body;
  const pv = document.getElementById('tourPrev'); if(pv) pv.style.visibility = _tourIdx === 0 ? 'hidden' : 'visible';
  const nx = document.getElementById('tourNext'); if(nx) nx.textContent = (_tourIdx === _tourSteps.length - 1) ? 'Done ✓' : 'Next →';
  _positionTourPanel(rect);
}

function _positionTourPanel(rect){
  const panel = document.getElementById('tourPanel');
  if(!panel) return;
  const pw = panel.offsetWidth || 288, ph = panel.offsetHeight || 170;
  const vw = window.innerWidth, vh = window.innerHeight, gap = 14;
  if(!(rect && rect.width > 0)){
    panel.style.top = Math.max(gap, (vh - ph) / 2) + 'px';
    panel.style.left = Math.max(gap, (vw - pw) / 2) + 'px';
    return;
  }
  const clampL = x => Math.max(gap, Math.min(vw - pw - gap, x));
  const clampT = y => Math.max(gap, Math.min(vh - ph - gap, y));
  const cx = clampL(rect.left + rect.width / 2 - pw / 2);
  const cy = clampT(rect.top + rect.height / 2 - ph / 2);
  let top, left;

  // ── Narrow screens ──
  // The panel is nearly as wide as the viewport, so the beside-the-target
  // cases can never fit and the below/above cases rarely do — the old logic
  // fell through to the corner case and landed on top of the very control it
  // was describing. Put it in whichever half the target is NOT in, which
  // guarantees they never overlap.
  if(vw <= 760){
    // A target taller than the leftover space can't be cleared by any
    // placement. Dock to the bottom there so the top of the highlighted block
    // stays visible — least-bad, and better than hiding the card.
    if(rect.height > vh - ph - gap * 3){
      panel.style.top = (vh - ph - gap) + 'px';
      panel.style.left = '';
      return;
    }
    const targetMid = rect.top + rect.height / 2;
    if(targetMid < vh / 2){
      top = Math.max(rect.bottom + gap, vh - ph - gap);   // target up top → panel low
    } else {
      top = Math.min(rect.top - gap - ph, gap);           // target down low → panel high
    }
    panel.style.top = Math.max(gap, Math.min(vh - ph - gap, top)) + 'px';
    panel.style.left = '';   // CSS pins left/right on mobile
    return;
  }
  if(rect.bottom + gap + ph <= vh){            // below
    top = rect.bottom + gap; left = cx;
  } else if(rect.top - gap - ph >= 0){          // above
    top = rect.top - gap - ph; left = cx;
  } else if(rect.right + gap + pw <= vw){       // right
    left = rect.right + gap; top = cy;
  } else if(rect.left - gap - pw >= 0){          // left
    left = rect.left - gap - pw; top = cy;
  } else {                                       // opposite corner (least overlap)
    const tcx = rect.left + rect.width / 2, tcy = rect.top + rect.height / 2;
    left = (tcx < vw / 2) ? (vw - pw - gap) : gap;
    top  = (tcy < vh / 2) ? (vh - ph - gap) : gap;
  }
  panel.style.top = clampT(top) + 'px';
  panel.style.left = clampL(left) + 'px';
}

// Start the tour automatically the first time per shell (called after the user
// lands on the board from the landing page).
function maybeAutoTour(){
  const shell = (typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur';
  let seen = null; try{ seen = localStorage.getItem('bm_tour_' + shell); }catch(e){}
  if(!seen) startTour();
}

// Click outside the tour panel ends the tour (capture phase, before the click
// reaches the app, so e.g. the welcome step's buttons still fire).
document.addEventListener('click', function(e){
  if(!_tourActive) return;
  if(e.target.closest && e.target.closest('#tourPanel')) return;
  endTour();
}, true);
window.addEventListener('resize', function(){ if(_tourActive) _renderTourStep(); });

// ── Ghost availability indicator (amateur shell) ────────────────────────────
// Ghost responses are gated off during a LIVE 2-player game (see ghostEnabled()
// in 50-bot-engine.js). Reflect that in the settings UI: disable the depth
// selector and surface a note so the player knows it's intentional.
function mpUpdateGhostAvailability(){
  const live = (typeof mpRoomId !== 'undefined' && mpRoomId &&
                typeof mpMode   !== 'undefined' && mpMode === 'ingame' &&
                typeof gameOver  !== 'undefined' && !gameOver);
  const sel  = document.getElementById('soloGhostDepth');
  const note = document.getElementById('ghostMpNote');
  const row  = document.getElementById('ghostRow');
  if(sel)  sel.disabled = live;
  if(note) note.style.display = live ? '' : 'none';
  if(row)  row.style.opacity  = live ? '0.5' : '';
}

function chatShowUnread(){
  const dot = document.getElementById('chatUnread');
  // Only show dot if chat is collapsed
  if(dot && !chatExpanded) dot.style.display = '';
}
function chatClearUnread(){
  const dot = document.getElementById('chatUnread');
  if(dot) dot.style.display = 'none';
}

// Clear unread when user focuses the chat input
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('chatInput');
  if(inp) inp.addEventListener('focus', chatClearUnread);
});


// ══════════════════════════════════════════════════════════════════════════════
// CHESS CLOCK — Fischer increment support
// ══════════════════════════════════════════════════════════════════════════════
const TIME_CONTROLS = {
  untimed:    {label:'Untimed',        time:0,    inc:0},
  bullet:     {label:'Bullet 1+0',     time:60,   inc:0},
  blitz3:     {label:'Blitz 3+2',      time:180,  inc:2},
  blitz5:     {label:'Blitz 5+0',      time:300,  inc:0},
  rapid10:    {label:'Rapid 10+0',     time:600,  inc:0},
  rapid15:    {label:'Rapid 15+10',    time:900,  inc:10},
  tournament:    {label:'Tournament 30+0',  time:1800, inc:0},
  classical90:   {label:'Classical 90+0',  time:5400, inc:0},
  classical90_30:{label:'Classical 90+30', time:5400, inc:30},
  // Custom: built dynamically from base+increment selectors
  custom:        {label:'Custom',          time:0,    inc:0},
};

let clockActive = false;
let clockInterval = null;
let clockTimeW = 0;   // seconds remaining for white
let clockTimeB = 0;   // seconds remaining for black
let clockInc = 0;     // increment in seconds
let clockBonusApplied = false; // true once the mid-game bonus time has been awarded
let clockControl = 'untimed';
let _clockAnchorMs  = 0;  // Date.now() when the current player's turn began
let _clockAnchorSec = 0;  // seconds that player had at that moment

function clockInit(controlKey) {
  clockStop();
  clockControl = controlKey || 'untimed';
  const tc = TIME_CONTROLS[clockControl] || TIME_CONTROLS.untimed;
  clockTimeW = tc.time;
  clockTimeB = tc.time;
  clockInc = tc.inc;
  clockBonusApplied = false;
  clockActive = false;
  clockUpdateDisplay();
}

function clockStart() {
  if(!clockActive && clockTimeW > 0 && clockTimeB > 0 && !gameOver) {
    clockActive = true;
    clockTick();
  }
}

function clockStop() {
  if(clockInterval){ clearInterval(clockInterval); clockInterval=null; }
  clockActive = false;
}

function clockTick() {
  if(clockInterval) clearInterval(clockInterval);
  // Anchor to absolute wall-clock time so the clock stays accurate even if the
  // tab is hidden (browsers throttle setInterval when a tab is not visible).
  _clockAnchorMs  = Date.now();
  _clockAnchorSec = turn === 'w' ? clockTimeW : clockTimeB;
  clockInterval = setInterval(()=>{
    if(!clockActive || gameOver) { clockStop(); return; }
    const elapsed    = Math.floor((Date.now() - _clockAnchorMs) / 1000);
    const remaining  = Math.max(0, _clockAnchorSec - elapsed);
    if(turn === 'w') clockTimeW = remaining;
    else             clockTimeB = remaining;
    if(remaining === 0) { clockStop(); clockTimeout(turn); return; }
    clockUpdateDisplay();
  }, 250);
}

function clockAfterMove() {
  const tc = TIME_CONTROLS[clockControl] || {};
  const movesSoFar = (typeof gameMovesAlgebraic !== 'undefined') ? gameMovesAlgebraic.length : 0;
  const fullMoveNum = Math.ceil(movesSoFar / 2);

  // Snap: record the just-moved player's exact remaining time from the wall clock
  // before applying increment (turn has already switched at this point).
  const justMoved = turn === 'w' ? 'b' : 'w';
  if (clockActive && _clockAnchorMs) {
    const elapsed   = Math.floor((Date.now() - _clockAnchorMs) / 1000);
    const remaining = Math.max(0, _clockAnchorSec - elapsed);
    if (justMoved === 'w') clockTimeW = remaining;
    else                   clockTimeB = remaining;
  }

  // Mid-game bonus time (e.g. +30 min after move 40 in 90+30 format)
  if (tc.bonusSecs && tc.bonusAtMove && !clockBonusApplied && fullMoveNum >= tc.bonusAtMove) {
    clockTimeW = Math.min(clockTimeW + tc.bonusSecs, 59940);
    clockTimeB = Math.min(clockTimeB + tc.bonusSecs, 59940);
    clockBonusApplied = true;
  }

  // Increment — only applied starting from incFromMove (default: move 1)
  const incFromMove = tc.incFromMove || 1;
  if (clockInc > 0 && fullMoveNum >= incFromMove) {
    if (justMoved === 'w') clockTimeW = Math.min(clockTimeW + clockInc, 59940);
    else clockTimeB = Math.min(clockTimeB + clockInc, 59940);
  }

  // Reset anchor for the new active player so their clock counts from now
  if (clockActive) {
    _clockAnchorMs  = Date.now();
    _clockAnchorSec = turn === 'w' ? clockTimeW : clockTimeB;
  }

  if(!clockActive && clockControl !== 'untimed' && !gameOver) clockStart();
  clockUpdateDisplay();
}

function clockTimeout(color) {
  gameOver = true;
  gameOverMsg = color==='w' ? 'White ran out of time — Black wins! ⏰' : 'Black ran out of time — White wins! ⏰';
  updatePlayerBoxes();
  render();
  showRematchBtn(true);
  // Notify multiplayer opponent
  if (typeof mpRoomId !== 'undefined' && mpRoomId && typeof mpWs !== 'undefined' && mpWs) {
    try { mpWs.send(JSON.stringify({ type: 'timeout', color })); } catch(e) {}
  }
}

function clockFmtTime(secs) {
  if(secs <= 0) return '0:00';
  const m = Math.floor(secs/60);
  const s = Math.floor(secs%60);
  return m + ':' + (s<10?'0':'') + s;
}

function clockUpdateDisplay() {
  const tc = TIME_CONTROLS[clockControl];
  const isUntimed = !tc || tc.time===0;
  const twEl = document.getElementById('timeW');
  const tbEl = document.getElementById('timeB');
  if(twEl){
    twEl.textContent = isUntimed ? '—' : clockFmtTime(clockTimeW);
    twEl.className = 'player-time' + (turn==='w'&&clockActive&&!isUntimed?' active':isUntimed?' solo':'');
    if(clockTimeW < 30 && clockActive && turn==='w' && !isUntimed)
      twEl.style.color='#e03535'; else twEl.style.color='';
  }
  if(tbEl){
    tbEl.textContent = isUntimed ? '—' : clockFmtTime(clockTimeB);
    tbEl.className = 'player-time' + (turn==='b'&&clockActive&&!isUntimed?' active':isUntimed?' solo':'');
    if(clockTimeB < 30 && clockActive && turn==='b' && !isUntimed)
      tbEl.style.color='#e03535'; else tbEl.style.color='';
  }
  // Keep pro-mode clock column in sync without waiting for a move
  if(typeof proMode !== 'undefined' && proMode && !isUntimed){
    const _fl = typeof boardFlipped !== 'undefined' && boardFlipped;
    const ct = document.getElementById('proClockTop');
    const cb = document.getElementById('proClockBottom');
    if(ct){ ct.textContent = clockFmtTime(_fl ? clockTimeW : clockTimeB);
            ct.style.color = (_fl ? (turn==='w'&&clockTimeW<30) : (turn==='b'&&clockTimeB<30)) ? '#e03535' : ''; }
    if(cb){ cb.textContent = clockFmtTime(_fl ? clockTimeB : clockTimeW);
            cb.style.color = (_fl ? (turn==='b'&&clockTimeB<30) : (turn==='w'&&clockTimeW<30)) ? '#e03535' : ''; }
  }
}

function clockSetControl(key) {
  clockControl = key;
  clockInit(key);
  // Close the clock panel
  const panel = document.getElementById('clockPanel');
  if(panel) panel.style.display='none';
}


// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// MULTIPLAYER — WebSocket room system (Lobby + Private + Code join)
// ══════════════════════════════════════════════════════════════════════════════
let mpRoomId = null, mpRole = null, mpWs = null;
let mpConnected = false;
let mpOriginalRole = null;  // role as assigned by server (never changes per session)
let mpCurrentTab = 'lobby';
let mpLobbyRefreshTimer = null;

// ── Presence / heartbeat ─────────────────────────────────────────────────────
let _mpPingTimer       = null;  // interval sending our ping to the server
let _mpPresenceTimer   = null;  // interval checking opponent last-seen time
let _mpLastOpponentPing = 0;    // Date.now() of last opponent_ping received

// Warn browser-close/navigate while in a live game
window.addEventListener('beforeunload', e => {
  if (typeof mpRoomId !== 'undefined' && mpRoomId &&
      typeof gameOver !== 'undefined' && !gameOver) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Panel flow helpers — replace old tab system ──────────────────────────────
// "mode" is 'idle' | 'private-waiting' | 'join' | 'lobby-waiting' | 'ingame'
let mpGameCount = 0;        // counts games played; used for color alternation
let mpMode = 'idle';

function mpSetMode(mode) {
  mpMode = mode;
  const mainView  = document.getElementById('mpMainView');
  const joinBlock = document.getElementById('mpJoinBlock');
  const inviteRow = document.getElementById('mpInviteRow');
  const leaveRow  = document.getElementById('mpLeaveRow');
  // Hide all conditional regions first
  if (mainView)  mainView.style.display  = 'none';
  if (joinBlock) joinBlock.style.display = 'none';
  if (inviteRow) inviteRow.style.display = 'none';
  if (leaveRow)  leaveRow.style.display  = 'none';

  if (mode === 'idle') {
    if (mainView) mainView.style.display = '';
  } else if (mode === 'join') {
    if (joinBlock) joinBlock.style.display = '';
    if (leaveRow)  leaveRow.style.display  = '';   // doubles as Cancel/Back
  } else if (mode === 'private-waiting' || mode === 'lobby-waiting') {
    if (inviteRow) inviteRow.style.display = '';
    if (leaveRow)  leaveRow.style.display  = '';
  } else if (mode === 'ingame') {
    if (leaveRow) leaveRow.style.display = '';
  }
}

/* ── Quick-setup pill bar ────────────────────────────────────────────────────
   Handle / Rating / Opponent / Time each show their current value in a
   stationary pill; clicking a pill opens just that editor beneath the row
   (bot-panel quickstart pattern). The action buttons act immediately using
   whatever the pills show — no confirm/review step.
──────────────────────────────────────────────────────────────────────────────*/
const MP_QS_KEYS = ['handle', 'rating', 'range', 'time', 'color'];

function mpQsToggle(key) {
  const opening = !document.getElementById('mpQsEd-' + key).classList.contains('open');
  MP_QS_KEYS.forEach(k => {
    const ed   = document.getElementById('mpQsEd-' + k);
    const pill = document.getElementById('mpQsPill-' + k);
    const on   = opening && k === key;
    if (ed)   ed.classList.toggle('open', on);
    if (pill) pill.classList.toggle('active', on);
  });
  if (opening && key === 'time')   mpBuildTimeGrid();   // reflect current selection
  if (opening && key === 'handle') setTimeout(() => document.getElementById('mpLobbyName')?.focus(), 80);
  if (opening && key === 'rating') setTimeout(() => document.getElementById('mpLobbyRating')?.focus(), 80);
  if (!opening) mpQsRefresh();      // closing an editor commits its value to the pill
}

function mpQsCloseAll() {
  MP_QS_KEYS.forEach(k => {
    document.getElementById('mpQsEd-' + k)?.classList.remove('open');
    document.getElementById('mpQsPill-' + k)?.classList.remove('active');
  });
  mpQsRefresh();
}

// Sync every pill's value text with the underlying state
function mpQsRefresh() {
  const name   = document.getElementById('mpLobbyName')?.value.trim();
  const rating = document.getElementById('mpLobbyRating')?.value.trim();
  const hv = document.getElementById('mpQsHandleVal');
  const rv = document.getElementById('mpQsRatingVal');
  const gv = document.getElementById('mpQsRangeVal');
  if (hv) hv.textContent = name || 'Anonymous';
  if (rv) rv.textContent = rating ? rating + ' ' + mpRatingType : '—';
  if (gv) gv.textContent = mpRatingRange >= 9999 ? 'Any' : '±' + mpRatingRange;
  const cv = document.getElementById('mpQsColorVal');
  if (cv) cv.textContent = mpHostColor === 'white' ? 'White ♔'
                         : mpHostColor === 'black' ? 'Black ♚' : 'Random';
  mpUpdateTCDisplay();   // time pill (#mpTCDisplay)
}

// Action buttons act immediately with the current pill settings.
// Each confirms first if a game is in progress — starting a new online game
// forfeits whatever is being played.
function mpStartPost() {
  if (!confirmAbandonLiveGame('Post an open challenge')) return;
  abandonLiveGameContexts();
  mpQsCloseAll(); mpPostChallenge();
}
function mpStartPrivateGame() {
  if (!confirmAbandonLiveGame('Start a private game')) return;
  abandonLiveGameContexts();
  mpQsCloseAll(); mpCreatePrivate();
}

function mpStartJoinFlow() {
  mpQsCloseAll();
  mpSetMode('join');
  mpShowStatus('Enter the code your friend shared with you.');
  mpRefreshLobby();
}

// Legacy aliases — keep older call sites (deep links, landing page) working
function mpStartPrivateFlow() { mpStartPrivateGame(); }
function mpStartLobbyFlow()   { mpStartPost(); }
function mpSwitchTab() {}

// ── WebSocket connection ─────────────────────────────────────────────────────
function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}

function mpConnect(onOpen) {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) { onOpen(); return; }
  if (mpWs) { try { mpWs.close(); } catch(e){} mpWs = null; }
  mpShowStatus('Connecting…');
  try { mpWs = new WebSocket(getWsUrl()); }
  catch(e) {
    mpShowStatus('⚠ Cannot connect — requires the deployed server.', true);
    return;
  }
  mpWs.onopen  = () => { mpConnected = true; onOpen(); };
  mpWs.onclose = () => {
    mpConnected = false;
    clearInterval(mpLobbyRefreshTimer);
    if (mpRoomId) mpShowStatus('Connection lost. Reload to reconnect.', true);
    else mpShowStatus('⚠ Server not reachable — multiplayer needs the deployed server.', true);
  };
  mpWs.onerror = () => mpShowStatus('⚠ Connection error.', true);
  mpWs.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    mpHandleMessage(msg);
  };
}

// ── Message handler ──────────────────────────────────────────────────────────
function mpHandleMessage(msg) {
  switch (msg.type) {

    case 'created':
      mpRoomId = msg.code; mpRole = msg.role;
      // Build and show invite link
      const inviteUrl = location.origin + location.pathname + '?join=' + msg.code;
      const linkEl = document.getElementById('mpInviteLink');
      if (linkEl) linkEl.value = inviteUrl;
      document.getElementById('mpRoomCode').textContent = msg.code;
      mpSetMode(msg.lobby ? 'lobby-waiting' : 'private-waiting');
      mpShowStatus(msg.lobby
        ? '⏳ Challenge posted! Waiting for someone to accept…'
        : '⏳ Private room ready — share the link or code with your opponent…');
      break;

    case 'joined':
      mpRoomId = msg.code; mpRole = msg.role;
      mpGameCount = 0;
      mpOriginalRole = msg.role;
      // Apply host's time control so clocks match
      if (msg.tcBaseMin !== undefined) {
        mpBaseMin = msg.tcBaseMin;
        mpIncSec  = msg.tcIncSec || 0;
        mpUpdateTCDisplay();   // updates mpSelectedTC and TIME_CONTROLS.custom
      }
      // Custom start position from the host (a "play from here" invite)
      mpStartFen  = (typeof msg.startFen === 'string' && msg.startFen) ? msg.startFen : null;
      mpStartSans = Array.isArray(msg.startSans) ? msg.startSans : [];
      mpSetMode('ingame');
      mpShowStatus('✓ Joined as ' + (msg.role === 'white' ? 'White ♔' : 'Black ♚') + '. Starting…');
      mpStartGame(mpSelectedTC);
      break;

    case 'opponent_joined':
      mpGameCount = 0;
      mpOriginalRole = mpRole;
      // Server echoes TC back to confirm — re-apply to ensure consistency
      if (msg.tcBaseMin !== undefined) {
        mpBaseMin = msg.tcBaseMin;
        mpIncSec  = msg.tcIncSec || 0;
        mpUpdateTCDisplay();
      }
      // Server echo of the start position is authoritative for both sides
      if (typeof msg.startFen === 'string' && msg.startFen) {
        mpStartFen  = msg.startFen;
        mpStartSans = Array.isArray(msg.startSans) ? msg.startSans : [];
      }
      mpSetMode('ingame');
      mpShowStatus('✓ Opponent joined! You are ' + (mpRole === 'white' ? 'White ♔' : 'Black ♚'));
      mpStartGame(mpSelectedTC);
      break;

    case 'lobby_list':
      mpRenderLobby(msg.challenges || []);
      break;

    case 'move':
      mpReceiveMove(msg.move, msg.timeW, msg.timeB);
      break;

    case 'chat':
      chatAppend('Opponent', msg.text || '', false);
      break;

    case 'resign':
      gameOver = true;
      gameOverMsg = 'Opponent resigned — You win! 🏆';
      updatePlayerBoxes(); render(); showRematchBtn(true);
      break;

    case 'timeout': {
      // Both clients tick both clocks, so both detect the same flag and both
      // send 'timeout'. If our local clock already ended the game, keep that
      // (correct) result — don't let the echo overwrite it with the wrong winner.
      if (gameOver) break;
      gameOver = true;
      // Trust the color in the message; fall back to "sender flagged" only
      // for old servers that strip it.
      const flagged = (msg.color === 'w' || msg.color === 'b')
        ? msg.color
        : (mpRole === 'white' ? 'b' : 'w');
      gameOverMsg = flagged === 'w' ? 'White ran out of time — Black wins! ⏰' : 'Black ran out of time — White wins! ⏰';
      updatePlayerBoxes(); render(); showRematchBtn(true);
      break;
    }

    case 'rematch_offer':
      const status = document.getElementById('mpStatus');
      if (status) {
        status.innerHTML = 'Opponent wants a rematch! &nbsp;' +
          '<button onclick="mpAcceptRematch()" style="padding:2px 8px;font-size:9px;background:rgba(34,168,90,0.15);border:0.5px solid #22a85a;border-radius:3px;color:#5ad490;cursor:pointer;margin-right:4px;">Accept</button>' +
          '<button onclick="mpDeclineRematch()" style="padding:2px 8px;font-size:9px;background:rgba(200,40,40,0.08);border:0.5px solid rgba(200,40,40,0.3);border-radius:3px;color:#c84040;cursor:pointer;">Decline</button>';
      }
      break;

    case 'rematch':
      // Restore original server-assigned role; mpStartGame will apply the alternating swap
      mpRole = mpOriginalRole || mpRole;
      mpStartGame(mpSelectedTC);
      mpShowStatus('Rematch! ' + (mpRole === 'white' ? 'You are White ♔' : 'You are Black ♚'));
      break;

    case 'rematch_declined':
      mpShowStatus('Rematch declined. Thanks for playing!');
      break;

    case 'draw_offer': {
      const status = document.getElementById('mpStatus');
      if (status) {
        status.innerHTML = 'Opponent offers a draw! &nbsp;' +
          '<button onclick="mpAcceptDraw()" style="padding:2px 8px;font-size:9px;background:rgba(34,168,90,0.15);border:0.5px solid #22a85a;border-radius:3px;color:#5ad490;cursor:pointer;margin-right:4px;">Accept</button>' +
          '<button onclick="mpDeclineDraw()" style="padding:2px 8px;font-size:9px;background:rgba(200,40,40,0.08);border:0.5px solid rgba(200,40,40,0.3);border-radius:3px;color:#c84040;cursor:pointer;">Decline</button>';
      }
      break;
    }

    case 'draw_accept':
      gameOver = true;
      gameOverMsg = 'Draw by agreement ½-½';
      updatePlayerBoxes(); render(); showRematchBtn(true);
      break;

    case 'draw_decline':
      mpShowStatus('Draw offer declined.');
      // Re-enable the draw button
      const drawBtn = document.querySelector('#gameActions .draw-btn');
      if (drawBtn) drawBtn.disabled = false;
      break;

    case 'opponent_ping':
      _mpLastOpponentPing = Date.now();
      mpSetPresenceDot('green');
      break;

    case 'opponent_disconnected':
      mpSetPresenceDot('red');
      mpShowStatus('Opponent disconnected.', true);
      gameOver = true; updatePlayerBoxes();
      break;

    case 'error':
      mpShowStatus(msg.message, true);
      break;
  }
}

// ── Lobby ────────────────────────────────────────────────────────────────────
function mpRefreshLobby() {
  // Connect silently just to fetch the current open challenges
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN)
      mpWs.send(JSON.stringify({ type: 'lobby_list' }));
  });
}

function mpPostChallenge() {
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  const name     = (nameEl && nameEl.value.trim()) || 'Anonymous';
  const rating   = (ratingEl && ratingEl.value.trim()) ? parseInt(ratingEl.value) : null;
  const tcLabel  = mpBaseMin === 0 ? 'Untimed' : mpBaseMin + '+' + mpIncSec;
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN) {
      mpWs.send(JSON.stringify({
        type: 'create', lobby: true,
        tc: mpSelectedTC, tcLabel,
        tcBaseMin: mpBaseMin, tcIncSec: mpIncSec,
        name, rating,
        ratingType: rating != null ? mpRatingType : null,
        ratingRange: mpRatingRange,
        hostColor: mpHostColor
      }));
    } else {
      mpShowStatus('Connection failed — try again', true);
    }
  });
}

function mpRenderLobby(challenges) {
  const list  = document.getElementById('mpLobbyList');
  const empty = document.getElementById('mpLobbyEmpty');
  const count = document.getElementById('mpLobbyCount');
  if (!list) return;
  Array.from(list.querySelectorAll('.mp-challenge-row')).forEach(el => el.remove());
  if (challenges.length === 0) {
    if (empty) empty.style.display = '';
    if (count) count.textContent = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (count) count.textContent = '(' + challenges.length + ')';
  challenges.forEach(ch => {
    const tcLabel = ch.tcLabel || (ch.tc && TIME_CONTROLS[ch.tc] ? TIME_CONTROLS[ch.tc].label : 'Untimed');
    const nameStr = ch.name || 'Anonymous';
    const ratingStr = ch.rating ? (' · ' + ch.rating + (ch.ratingType ? ' ' + ch.ratingType : '')) : '';
    const rangeStr = ch.ratingRange && ch.ratingRange < 9999 ? (' ±' + ch.ratingRange) : '';
    const row = document.createElement('div');
    row.className = 'mp-challenge-row';
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 9px;background:var(--mp-carbon-surface);border:0.5px solid var(--mp-border);border-radius:4px;';
    row.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-family:var(--mp-font-u);font-size:9.5px;font-weight:500;color:var(--mp-text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          nameStr + ratingStr + rangeStr +
        '</div>' +
        '<div style="font-family:var(--mp-font-m);font-size:8px;color:var(--mp-text-dim);margin-top:1px;">⏱ ' + tcLabel + '</div>' +
      '</div>' +
      '<button onclick="mpAcceptLobbyChallenge(\'' + ch.code + '\')" ' +
      'style="padding:5px 14px;font-family:var(--mp-font-u);font-size:9px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;background:rgba(50,160,100,0.14);' +
      'border:0.5px solid rgba(50,160,100,0.5);border-radius:3px;color:#60c880;cursor:pointer;flex-shrink:0;">Join</button>';
    list.appendChild(row);
  });
}

function mpAcceptLobbyChallenge(code) {
  // If the user hasn't entered a handle OR a rating, prompt before joining
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  const hasName   = nameEl   && nameEl.value.trim();
  const hasRating = ratingEl && ratingEl.value.trim();
  if (!hasName && !hasRating) {
    mpShowAnonPrompt(code);
    return;
  }
  mpDoAcceptLobby(code);
}

function mpDoAcceptLobby(code) {
  if (!confirmAbandonLiveGame('Join this game')) return;
  abandonLiveGameContexts();
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN)
      mpWs.send(JSON.stringify({ type: 'join', code }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

// ── Anonymous-join confirm prompt ───────────────────────────────────────────
let mpAnonPendingCode = null;
function mpShowAnonPrompt(code) {
  mpAnonPendingCode = code;
  // Prefill the inline fields from Your Info so anything already typed carries over
  const an = document.getElementById('mpAnonName');
  const ar = document.getElementById('mpAnonRating');
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  if (an && nameEl)   an.value = nameEl.value;
  if (ar && ratingEl) ar.value = ratingEl.value;
  const el = document.getElementById('mpAnonPrompt');
  if (el) el.classList.add('open');
  if (an) setTimeout(() => an.focus(), 150);
}
function mpHideAnonPrompt() {
  const el = document.getElementById('mpAnonPrompt');
  if (el) el.classList.remove('open');
}
function mpAnonJoinAnon() {
  const code = mpAnonPendingCode;
  mpAnonPendingCode = null;
  mpHideAnonPrompt();
  if (code) mpDoAcceptLobby(code);
}
// Save the inline handle/rating into Your Info, then join the pending challenge
// directly — the user never has to go back and find the room again.
function mpAnonSaveJoin() {
  const an = document.getElementById('mpAnonName');
  const ar = document.getElementById('mpAnonRating');
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  if (an && nameEl)   nameEl.value   = an.value.trim();
  if (ar && ratingEl) ratingEl.value = ar.value.trim();
  mpSaveInfo();
  const code = mpAnonPendingCode;
  mpAnonPendingCode = null;
  mpHideAnonPrompt();
  if (code) mpDoAcceptLobby(code);
}

// ── Private game ─────────────────────────────────────────────────────────────
function mpCreatePrivate() {
  const tcLabel = mpBaseMin === 0 ? 'Untimed' : mpBaseMin + '+' + mpIncSec;
  // "Play from here": a pending start position rides along on room creation.
  // The server stores it and hands it to the joiner, so both clients start
  // the game from the same position. Never posted to the open-challenge board.
  const sp = window._pendingStartPos || null;
  window._pendingStartPos = null;
  if (typeof _mpRefreshStartPosBanner === 'function') _mpRefreshStartPosBanner();
  mpStartFen  = sp && sp.fen ? sp.fen : null;
  mpStartSans = sp && sp.sans ? sp.sans.slice() : [];
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN) {
      const payload = {
        type: 'create', lobby: false,
        tc: mpSelectedTC, tcLabel,
        tcBaseMin: mpBaseMin, tcIncSec: mpIncSec,
        hostColor: mpHostColor
      };
      if (mpStartFen) { payload.startFen = mpStartFen; payload.startSans = mpStartSans; }
      mpWs.send(JSON.stringify(payload));
    }
    else mpShowStatus('Connection failed — try again', true);
  });
}

// ── Link sharing helpers ──────────────────────────────────────────────────────
function mpCopyLink() {
  const link = document.getElementById('mpInviteLink');
  if (!link) return;
  navigator.clipboard.writeText(link.value).then(() => {
    const btn = document.getElementById('mpCopyLinkBtn');
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
  }).catch(() => { link.select(); document.execCommand('copy'); });
}

function mpShareDiscord() {
  const link = document.getElementById('mpInviteLink');
  if (!link) return;
  const text = '♟ Join my Blundermind game: ' + link.value;
  navigator.clipboard.writeText(text).then(() => mpShowStatus('Discord message copied — paste it in a DM!'));
}

function mpShareText() {
  const link = document.getElementById('mpInviteLink');
  if (!link) return;
  if (navigator.share) {
    navigator.share({ title: 'Blundermind chess', text: '♟ Join my game:', url: link.value });
  } else {
    navigator.clipboard.writeText(link.value).then(() => mpShowStatus('Link copied — paste it in a message!'));
  }
}

// ── Check URL for ?join= on load ──────────────────────────────────────────────
function mpCheckInviteUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (!code) return;
  // Clean the URL without reloading
  history.replaceState({}, '', location.pathname);
  // Dismiss landing overlay immediately
  landingDismiss();
  // Open the mp panel, show join block with pre-filled code, then connect and join
  setTimeout(() => {
    openPanel('mpPanel');
    mpSetMode('join');
    const joinEl = document.getElementById('mpJoinCode');
    if (joinEl) joinEl.value = code.toUpperCase();
    mpShowStatus('Joining from invite link…');
    // Join directly via connect callback — don't rely on mpJoinRoom reading the input
    mpConnect(() => {
      if (mpWs && mpWs.readyState === WebSocket.OPEN)
        mpWs.send(JSON.stringify({ type: 'join', code: code.toUpperCase() }));
      else mpShowStatus('Connection failed — try again', true);
    });
  }, 350);
}

// ── Core join / leave ────────────────────────────────────────────────────────
function mpJoinRoom() {
  const code = document.getElementById('mpJoinCode').value.trim().toUpperCase();
  if (!code) { mpShowStatus('Enter a room code', true); return; }
  if (!confirmAbandonLiveGame('Join this game')) return;
  abandonLiveGameContexts();
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN)
      mpWs.send(JSON.stringify({ type: 'join', code }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

// Keep mpCreateRoom as alias for backward compat with landing page
function mpCreateRoom() { mpCreatePrivate(); }

function mpSetPresenceDot(color) {
  // color: 'green' | 'amber' | 'red' | 'off'
  ['mpPresenceDotW','mpPresenceDotB'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (color === 'off') { el.style.display = 'none'; return; }
    el.style.display = 'inline-block';
    el.style.background = color === 'green' ? '#22c55e'
                        : color === 'amber' ? '#f59e0b'
                        : '#ef4444';
    el.title = color === 'green' ? 'Opponent is online'
             : color === 'amber' ? 'Opponent may have left'
             : 'Opponent disconnected';
  });
  // Only show on the opponent's box
  if (mpRole) {
    const ownBox = mpRole === 'white' ? 'mpPresenceDotW' : 'mpPresenceDotB';
    const el = document.getElementById(ownBox);
    if (el) el.style.display = 'none'; // never show dot on own box
  }
}

function _mpStartPresence() {
  _mpLastOpponentPing = Date.now(); // assume online at game start
  clearInterval(_mpPingTimer);
  clearInterval(_mpPresenceTimer);
  _mpPingTimer = setInterval(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN && mpRoomId) {
      try { mpWs.send(JSON.stringify({ type: 'ping' })); } catch(e) {}
    }
  }, 12000);
  _mpPresenceTimer = setInterval(() => {
    if (!mpRoomId || (typeof gameOver !== 'undefined' && gameOver)) return;
    const ago = Date.now() - _mpLastOpponentPing;
    if (ago < 20000)      mpSetPresenceDot('green');
    else if (ago < 45000) mpSetPresenceDot('amber');
    else                  mpSetPresenceDot('red');
  }, 3000);
}

function _mpStopPresence() {
  clearInterval(_mpPingTimer);
  clearInterval(_mpPresenceTimer);
  _mpPingTimer = null;
  _mpPresenceTimer = null;
  mpSetPresenceDot('off');
}

function mpMaybeLeave() {
  if (mpRoomId && !(typeof gameOver !== 'undefined' && gameOver)) {
    if (!confirm('Leave this game? You will forfeit to your opponent.')) return;
    // Send forfeit so opponent sees the result immediately
    if (mpWs && mpWs.readyState === WebSocket.OPEN) {
      try { mpWs.send(JSON.stringify({ type: 'resign' })); } catch(e) {}
    }
  }
  mpLeave();
}

function mpLeave() {
  _mpStopPresence();
  if (mpWs) { mpWs.close(); mpWs = null; }
  mpRoomId = null; mpRole = null; mpConnected = false;
  mpOriginalRole = null; mpGameCount = 0;
  mpStartFen = null; mpStartSans = [];   // don't leak a from-position start into the next room
  clearInterval(mpLobbyRefreshTimer);
  chatShow(false);
  const cm = document.getElementById('chatMessages'); if (cm) cm.innerHTML = '';
  const boardCol = document.getElementById('board-col');
  if (boardCol) boardCol.classList.remove('board-flipped');
  document.getElementById('mpRoomCode').textContent = '';
  const jc = document.getElementById('mpJoinCode'); if (jc) jc.value = '';
  mpShowStatus('');
  mpQsCloseAll();
  mpHideAnonPrompt();
  mpSetMode('idle');
  const ga = document.getElementById('gameActions');
  if (ga) ga.style.display = 'none';
  resetGame();
}

// ── Game flow ────────────────────────────────────────────────────────────────
function mpStartGame(tcKey) {
  mpGameCount++;
  // On odd game counts (2nd, 4th…) swap roles from the original
  const originalRole = mpRole;  // 'white' or 'black' as assigned by server
  // Swap on every even-numbered game (game 2, 4, 6…)
  const swap = (mpGameCount % 2 === 0);
  const effectiveRole = swap
    ? (originalRole === 'white' ? 'black' : 'white')
    : originalRole;
  mpRole = effectiveRole;

  resetGame();
  // Use tc key if provided (for Black who receives it from server)
  const tc = tcKey || mpSelectedTC || 'untimed';
  clockInit(tc);
  // From-position room: both clients set up the agreed position (rematches
  // restart from the same position too, with colors swapped as usual)
  if (mpStartFen) applyStartPosition(mpStartFen, mpStartSans);
  chatShow(true);
  boardFlipped = (mpRole === 'black');
  const _bcEl = document.getElementById('board-col');
  if (_bcEl) _bcEl.classList.toggle('board-flipped', boardFlipped);
  render();
  if (tc !== 'untimed') clockStart();
  updatePlayerBoxes();
  mpUpdateTurnIndicator();
  // Show draw/resign buttons while game is active
  const ga = document.getElementById('gameActions');
  if (ga) ga.style.display = 'flex';
  closeAllPanels();
  _mpStartPresence();
}

function mpUpdateTurnIndicator() {
  if (!mpRoomId) return;
  const myTurn = (turn === 'w' && mpRole === 'white') || (turn === 'b' && mpRole === 'black');
  mpShowStatus(myTurn ? '▶ Your turn' : "⏳ Opponent's turn…");
  updatePlayerBoxes();
}

function mpSendMove(from, to, promo) {
  if (!mpWs || mpWs.readyState !== WebSocket.OPEN) return;
  // Include post-move clock state so receiver uses our values as ground truth
  mpWs.send(JSON.stringify({ type: 'move', move: { from, to, promo }, timeW: clockTimeW, timeB: clockTimeB }));
}

function mpReceiveMove(move, syncTimeW, syncTimeB) {
  if (promotionPending) { setTimeout(() => mpReceiveMove(move, syncTimeW, syncTimeB), 300); return; }
  // Never trust the wire: verify shape, turn, ownership, and legality before
  // executing. A malformed or malicious message must not corrupt the board.
  if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) ||
      move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) {
    mpShowStatus('⚠ Ignored malformed move from opponent', true); return;
  }
  if (gameOver) return;
  if (mpIsMyTurn()) {
    mpShowStatus('⚠ Desync: opponent moved out of turn', true); return;
  }
  const oppColor = mpRole === 'white' ? 'b' : 'w';
  const p = board[move.from];
  if (!p || p.color !== oppColor) {
    mpShowStatus('⚠ Desync: opponent move references wrong piece', true); return;
  }
  if (!legalMovesFor(move.from, board, epSq, castling).includes(move.to)) {
    mpShowStatus('⚠ Desync: opponent sent an illegal move', true); return;
  }
  const promo = ['Q','R','B','N'].includes(move.promo) ? move.promo : null;
  executeMove(move.from, move.to, promo);
  // Overwrite local clock state with sender's authoritative post-move values.
  // This eliminates accumulated drift from anchor-reset timing differences.
  if (typeof syncTimeW === 'number' && typeof syncTimeB === 'number' && !gameOver) {
    clockTimeW = syncTimeW;
    clockTimeB = syncTimeB;
    if (clockActive) {
      _clockAnchorMs  = Date.now();
      _clockAnchorSec = turn === 'w' ? clockTimeW : clockTimeB;
    }
    clockUpdateDisplay();
  }
  mpUpdateTurnIndicator();
  // Fire queued premove if any
  if(activePremove) setTimeout(tryFirePremove, 50);
}

function mpIsMyTurn() {
  if (!mpRoomId) return true;
  return (turn === 'w' && mpRole === 'white') || (turn === 'b' && mpRole === 'black');
}

function mpShowStatus(msg, isError) {
  const el = document.getElementById('mpStatus');
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? '#c03030' : 'var(--text-secondary)';
  }
}

// ── Time control — two-row base + increment selectors ───────────────────────
let mpSelectedTC = 'custom';
let mpBaseMin = 0;   // 0 = untimed
let mpIncSec  = 0;

function mpSetBase(min) {
  mpBaseMin = min;
  document.querySelectorAll('[id^="mpbase-"]').forEach(b => b.classList.remove('tc-active'));
  const btn = document.getElementById('mpbase-' + min); if (btn) btn.classList.add('tc-active');
  mpUpdateTCDisplay();
}

function mpSetInc(sec) {
  mpIncSec = sec;
  document.querySelectorAll('[id^="mpinc-"]').forEach(b => b.classList.remove('tc-active'));
  const btn = document.getElementById('mpinc-' + sec); if (btn) btn.classList.add('tc-active');
  mpUpdateTCDisplay();
}

function mpUpdateTCDisplay() {
  const disp = document.getElementById('mpTCDisplay');
  // Build a custom TC object and register it (independent of the DOM)
  TIME_CONTROLS.custom = {
    label: mpBaseMin === 0 ? 'Untimed' : mpBaseMin + '+' + mpIncSec,
    time:  mpBaseMin * 60,
    inc:   mpIncSec
  };
  mpSelectedTC = mpBaseMin === 0 ? 'untimed' : 'custom';
  if (!disp) return;
  disp.textContent = mpBaseMin === 0
    ? 'Untimed'
    : mpBaseMin + ' min + ' + mpIncSec + 's · ' + mpTcCategory(mpBaseMin, mpIncSec).n;
}

/* ══════════════════════════════════════════════════════════════════════════
   TIME-CONTROL GRID — 2D matrix (increment × base time), ported from the
   bot-control-panel design. A single click sets both base + increment.
   ══════════════════════════════════════════════════════════════════════════ */
const MP_TC_TIMES   = [1, 2, 3, 5, 10, 15, 20, 30, 60, 90, 0];
const MP_TC_LABELS  = ['1', '2', '3', '5', '10', '15', '20', '30', '60', '90', '∞'];
const MP_TC_INCS    = [0, 1, 2, 3, 5, 10, 20, 30];
// "Famous" presets get a rounded card + category badge; everything else is a plain cell
const MP_TC_PRESETS = new Set([
  '1-0', '2-1', '3-0', '3-2', '5-0', '5-3',
  '10-0', '10-5', '15-0', '15-10', '20-0', '30-0', '30-20',
  '60-0', '90-0', '90-30', '0-0'
]);

function mpTcCategory(t, i) {
  if (t === 0) return { n: 'Untimed', c: 'rapid' };
  const total = t + i * 0.5;
  if (total < 3)  return { n: 'Bullet',    c: 'bullet'  };
  if (total < 8)  return { n: 'Blitz',     c: 'blitz'   };
  if (total < 25) return { n: 'Rapid',     c: 'rapid'   };
  return             { n: 'Classical', c: 'classic' };
}

function mpBuildTimeGrid() {
  const panel = document.getElementById('mpTgPanel');
  if (!panel) return;

  let thead = '<thead><tr><th style="width:0;padding:0;border:none;"></th>';
  MP_TC_LABELS.forEach(l => { thead += '<th>' + l + '</th>'; });
  thead += '</tr></thead>';

  let tbody = '<tbody>';
  MP_TC_INCS.forEach(inc => {
    tbody += '<tr><td class="mp-tg-inclbl">' + (inc === 0 ? '0s' : inc + 's') + '</td>';
    MP_TC_TIMES.forEach(t => {
      const key        = t + '-' + inc;
      const isPreset   = MP_TC_PRESETS.has(key);
      const isSelected = t === mpBaseMin && inc === mpIncSec;
      const cat        = mpTcCategory(t, inc);
      const cls        = 'mp-tg-cell ' + (isPreset ? 'preset' : 'custom') + (isSelected ? ' selected' : '');
      const lbl        = t === 0 ? '∞' : (t + (inc > 0 ? '+' + inc : ''));
      const inner      = isPreset
        ? '<span class="mp-tg-cname">' + lbl + '</span>' +
          '<span class="mp-tg-cbadge badge-' + cat.c + '">' + cat.n + '</span>'
        : '<span class="mp-tg-cval">' + lbl + '</span>';
      tbody += '<td><div class="' + cls + '" data-t="' + t + '" data-i="' + inc +
               '" onclick="mpSelectTC(' + t + ',' + inc + ',this)">' + inner + '</div></td>';
    });
    tbody += '</tr>';
  });
  tbody += '</tbody>';

  panel.innerHTML =
    '<div class="mp-tg-wrap">' +
      '<div class="mp-tg-yaxis">Increment</div>' +
      '<div class="mp-tg-cols">' +
        '<div class="mp-tg-xaxis">Minutes</div>' +
        '<table class="mp-tg">' + thead + tbody + '</table>' +
      '</div>' +
    '</div>';
}

function mpSelectTC(t, inc, cell) {
  mpBaseMin = t;
  mpIncSec  = inc;
  document.querySelectorAll('#mpPanel .mp-tg-cell').forEach(c => c.classList.remove('selected'));
  if (cell) cell.classList.add('selected');
  mpUpdateTCDisplay();
  // Remember the choice — next session's 2-player games start from it
  try {
    localStorage.setItem('bm_mpTcBase', String(t));
    localStorage.setItem('bm_mpTcInc',  String(inc));
  } catch (e) {}
  // Grid has done its job — close the editor after a beat so the selection
  // highlight registers, leaving the pill row showing the new time.
  setTimeout(() => {
    const ed = document.getElementById('mpQsEd-time');
    if (ed && ed.classList.contains('open')) mpQsToggle('time');
  }, 280);
}

// Legacy alias kept for any old calls
function mpSetTC(key) {
  // Map old preset keys to base+inc
  const map = { untimed:{min:0,inc:0}, bullet:{min:1,inc:0}, blitz3:{min:3,inc:2},
                blitz5:{min:5,inc:0}, rapid10:{min:10,inc:0}, rapid15:{min:15,inc:10},
                tournament:{min:30,inc:0} };
  const m = map[key] || {min:0, inc:0};
  mpSetBase(m.min);
  mpSetInc(m.inc);
}

// ── Rating range ─────────────────────────────────────────────────────────────
// Range buttons exist in two places (Your Info card + game-setup overlay), so
// selection toggles every button carrying data-mprange, keeping both sets live.
let mpRatingRange = 9999;
function mpSetRatingRange(r) {
  mpRatingRange = r;
  document.querySelectorAll('[data-mprange]').forEach(b =>
    b.classList.toggle('tc-active', parseInt(b.dataset.mprange) === r));
  try { localStorage.setItem('bm_mpRange', String(r)); } catch (e) {}
  if (typeof mpQsRefresh === 'function') mpQsRefresh();
}

// ── Rating type (Lichess default — Maia is trained on Lichess games) ─────────
let mpRatingType = 'Lichess';
function mpSetRatingType(t) {
  if (!['Lichess', 'Chess.com', 'FIDE'].includes(t)) t = 'Lichess';
  mpRatingType = t;
  document.querySelectorAll('[data-mprt]').forEach(b =>
    b.classList.toggle('tc-active', b.dataset.mprt === t));
  try { localStorage.setItem('bm_mpRatingType', t); } catch (e) {}
  if (typeof mpQsRefresh === 'function') mpQsRefresh();
}

// ── Host colour: the game creator picks White / Black / Random ───────────────
// The server resolves 'random' and assigns roles authoritatively. Matters most
// for from-position games, where you may want to replay a position as either
// side — but applies to any private game or open challenge you create.
let mpHostColor = 'random';
function mpSetHostColor(c) {
  if (!['white', 'black', 'random'].includes(c)) c = 'random';
  mpHostColor = c;
  document.querySelectorAll('[data-mpcolor]').forEach(b =>
    b.classList.toggle('tc-active', b.dataset.mpcolor === c));
  try { localStorage.setItem('bm_mpHostColor', c); } catch (e) {}
  if (typeof mpQsRefresh === 'function') mpQsRefresh();
}

// ── Persist "Your Info" (handle / rating / range) across sessions ────────────
function mpSaveInfo() {
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  try {
    if (nameEl)   localStorage.setItem('bm_mpHandle', nameEl.value || '');
    if (ratingEl) localStorage.setItem('bm_mpRating', ratingEl.value || '');
  } catch (e) {}
  if (typeof mpQsRefresh === 'function') mpQsRefresh();  // live pill update while typing
}
function mpLoadInfo() {
  const nameEl   = document.getElementById('mpLobbyName');
  const ratingEl = document.getElementById('mpLobbyRating');
  try {
    const h = localStorage.getItem('bm_mpHandle'); if (nameEl   && h != null) nameEl.value   = h;
    const r = localStorage.getItem('bm_mpRating'); if (ratingEl && r != null) ratingEl.value = r;
    const rng = parseInt(localStorage.getItem('bm_mpRange'));
    if (!isNaN(rng)) mpSetRatingRange(rng);
    const rt = localStorage.getItem('bm_mpRatingType');
    if (rt) mpSetRatingType(rt);
    const hc = localStorage.getItem('bm_mpHostColor');
    if (hc) mpSetHostColor(hc);
    // Last-used time control ("Untimed" the very first time)
    const tb = parseInt(localStorage.getItem('bm_mpTcBase'));
    const ti = parseInt(localStorage.getItem('bm_mpTcInc'));
    if (!isNaN(tb) && !isNaN(ti)) { mpBaseMin = tb; mpIncSec = ti; }
  } catch (e) {}
  if (typeof mpQsRefresh === 'function') mpQsRefresh();
}

// ── Hide/Show toggle ─────────────────────────────────────────────────────────
// Saves IND on+pre states, sets all to false (hiding), restores on release.
// Hold = peek opposite state. Double-click = lock toggle.
let hideShowLocked = false;   // true = locked into hidden state
let hideShowPeeking = false;  // true = currently peeking (button held)
let hideShowPressTime = 0;
let hideShowLastClick = 0;
let hideShowSavedStates = {}; // saved IND on+pre when hiding

function hideShowSave(){
  hideShowSavedStates = {};
  Object.keys(IND).forEach(k=>{
    hideShowSavedStates[k] = {on:IND[k].on, pre:IND[k].pre};
  });
}
function hideShowApplyOff(){
  Object.keys(IND).forEach(k=>{
    IND[k].on = false;
    IND[k].pre = false;
    IND[k].pressing = false;
  });
  ibRefreshAll();
  indApply();
}
function hideShowRestore(){
  Object.keys(hideShowSavedStates).forEach(k=>{
    if(IND[k]){
      IND[k].on  = hideShowSavedStates[k].on;
      IND[k].pre = hideShowSavedStates[k].pre;
    }
  });
  ibRefreshAll();
  indApply();
}
function hideShowDown(e){
  if(e) e.preventDefault();
  hideShowPressTime = Date.now();
  hideShowPeeking = true;
  if(!hideShowLocked){
    // Currently showing — peek by hiding
    hideShowSave();
    hideShowApplyOff();
  } else {
    // Currently hidden — peek by restoring
    hideShowRestore();
  }
  updateHideShowBtn();
}
function hideShowUp(){
  if(!hideShowPeeking) return;
  const dt = Date.now() - hideShowPressTime;
  hideShowPeeking = false;
  if(dt < 250){
    // Short press — check for double-click to lock toggle
    const now = Date.now();
    if(now - hideShowLastClick < 400){
      // Double-click: lock the current peek state
      hideShowLocked = !hideShowLocked;
      hideShowLastClick = 0;
      // State is already applied from mousedown peek, just keep it
      updateHideShowBtn();
      return;
    } else {
      hideShowLastClick = now;
    }
  }
  // Single press released — revert peek back to locked state
  if(!hideShowLocked){
    // Was showing (peek hid) — restore
    hideShowRestore();
  } else {
    // Was hidden (peek showed) — hide again
    hideShowSave();
    hideShowApplyOff();
  }
  updateHideShowBtn();
}
// ── Peek button — hold to show all exploration indicators ────────────────────
let peekSavedStates = {};
let peekActive = false;

function peekDown(e){
  if(e) e.preventDefault();
  if(peekActive) return;
  peekActive = true;
  // Save current IND states
  peekSavedStates = {};
  Object.keys(IND).forEach(k=>{
    peekSavedStates[k] = {on:IND[k].on, pre:IND[k].pre};
  });
  // Only activate indicators that the user has already enabled (on:true or pre:true)
  // Peek shows those indicators fully ON — not ones the user hasn't selected at all
  Object.keys(IND).forEach(k=>{
    if(IND[k].on || IND[k].pre){
      IND[k].on = true; // fully activate so they show on live board too
    }
    // forksw stays hold-only regardless
  });
  const btn=document.getElementById('btnPeek');
  if(btn){btn.style.borderColor='var(--accent)';btn.style.color='var(--accent)';}
  ibRefreshAll(); indApply();
}

function peekUp(){
  if(!peekActive) return;
  peekActive = false;
  // Restore saved states
  Object.keys(peekSavedStates).forEach(k=>{
    if(IND[k]){IND[k].on=peekSavedStates[k].on;IND[k].pre=peekSavedStates[k].pre;}
  });
  const btn=document.getElementById('btnPeek');
  if(btn){btn.style.borderColor='';btn.style.color='';}
  ibRefreshAll(); indApply();
}

// ── Show All button — hold to see board with every indicator active ──────────
let showAllActive = false;
let showAllSavedStates = {};

function showAllDown(e){
  if(e) e.preventDefault();
  if(showAllActive) return;
  showAllActive = true;
  // Save current IND states
  showAllSavedStates = {};
  Object.keys(IND).forEach(k=>{
    showAllSavedStates[k] = {on:IND[k].on, pre:IND[k].pre, pressing:IND[k].pressing};
  });
  // Set ALL indicators fully on — pressing:true forces fork/discovered renders
  Object.keys(IND).forEach(k=>{
    IND[k].on = true;
    IND[k].pre = true;
    IND[k].pressing = true;
  });
  // Also turn on all checkboxes (battery, queen pins, etc.)
  ['cbBattery','cbQPins','cbEnPassant','cbInfluenceToggle'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.checked=true;
  });
  const btn=document.getElementById('btnShowAll');
  if(btn){btn.style.borderColor='var(--accent)';btn.style.color='var(--accent)';}
  ibRefreshAll(); indApply();
}

function showAllUp(){
  if(!showAllActive) return;
  showAllActive = false;
  // Restore saved states
  Object.keys(showAllSavedStates).forEach(k=>{
    if(IND[k]){
      IND[k].on = showAllSavedStates[k].on;
      IND[k].pre = showAllSavedStates[k].pre;
      IND[k].pressing = showAllSavedStates[k].pressing;
    }
  });
  const btn=document.getElementById('btnShowAll');
  if(btn){btn.style.borderColor='';btn.style.color='';}
  ibRefreshAll(); indApply();
}

function toggleClockPanel(){
  const p=document.getElementById('clockPanel');
  if(p) p.style.display=(p.style.display==='none'?'block':'none');
  // Highlight active time control
  Object.keys(TIME_CONTROLS).forEach(k=>{
    const btn=document.getElementById('tc-'+k);
    if(btn) btn.classList.toggle('active',k===clockControl);
  });
}

function updateHideShowBtn(){
  const btn = document.getElementById('btnHideShow');
  if(!btn) return;
  const currentlyHidden = hideShowLocked !== hideShowPeeking;
  btn.textContent = currentlyHidden ? '👁 Show' : '👁 Hide';
  btn.title = 'Hold to peek · Double-click to lock Hide/Show';
  btn.style.borderColor = hideShowLocked ? 'rgba(74,159,212,0.5)' : '';
  btn.style.color       = hideShowLocked ? 'var(--accent)' : '';
}

// ── Clear all selections (all IND on+pre → false) ────────────────────────────
function clearAllSelections(){
  // Also reset hide/show state so newly cleared state is the baseline
  hideShowLocked = false;
  hideShowPeeking = false;
  hideShowSavedStates = {};
  Object.keys(IND).forEach(k=>{
    IND[k].on=false;
    IND[k].pre=false;
    IND[k].pressing=false;
  });
  updateHideShowBtn();
  ibRefreshAll();
  indApply();
}

// ── Multiplayer actions ────────────────────────────────────────────────
function resign() {
  if (typeof gameOver !== 'undefined' && gameOver) return;
  // Works vs a bot as well as online — confirmResign() only notifies the server
  // when actually in a room, so this is safe for solo bot games too.
  if (mpRoomId || (typeof botActive !== 'undefined' && botActive)) showResignConfirm();
}

function offerDraw() {
  // Vs a bot: the bot decides based on its draw-behaviour settings
  if (typeof botActive !== 'undefined' && botActive && !gameOver) {
    if (typeof botConsiderDrawOffer === 'function') botConsiderDrawOffer();
    return;
  }
  if (!mpRoomId || !mpWs || mpWs.readyState !== WebSocket.OPEN) return;
  mpWs.send(JSON.stringify({ type: 'draw_offer' }));
  mpShowStatus('Draw offered — waiting for response…');
  // Disable the button for 10 s to prevent spamming
  const btn = document.querySelector('#gameActions .draw-btn');
  if (btn) { btn.disabled = true; setTimeout(() => { if (btn) btn.disabled = false; }, 10000); }
}

function mpAcceptDraw() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN)
    mpWs.send(JSON.stringify({ type: 'draw_accept' }));
  gameOver = true;
  gameOverMsg = 'Draw by agreement ½-½';
  updatePlayerBoxes(); render(); showRematchBtn(true);
}

function mpDeclineDraw() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN)
    mpWs.send(JSON.stringify({ type: 'draw_decline' }));
  mpShowStatus('Draw offer declined.');
}

// ── Feedback ──────────────────────────────────────────────────────────
function sendFeedback(){
  const text=document.getElementById('feedbackText').value.trim();
  if(!text) return;
  const ACTION_URL='https://formspree.io/f/mojrdakw';
  fetch(ACTION_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({message:text,_subject:'Blundermind Feedback'})})
    .then(r=>{
      if(r.ok){
        document.getElementById('feedbackText').value='';
        document.getElementById('feedbackThanks').style.display='block';
        setTimeout(()=>{
          document.getElementById('feedbackThanks').style.display='none';
        }, 4000);
      } else { alert('Could not send right now — please try again later.'); }
    }).catch(()=>alert('Could not send right now — please try again later.'));
}

// ── Theme panel setup ─────────────────────────────────────────────────
function setupThemePanel(){
  const bsw=document.getElementById('boardSwatches');
  if(bsw&&!bsw.children.length){
    for(const[key,t] of Object.entries(BOARD_THEMES)){
      const wrap=document.createElement('div');wrap.className='swatch-wrap';
      const sw=document.createElement('div');
      sw.className='swatch'+(key===currentBoardTheme?' active':'');
      sw.dataset.theme=key;
      sw.style.background='linear-gradient(135deg,'+t.light+' 50%,'+t.dark+' 50%)';
      sw.onclick=()=>applyBoardTheme(key);
      const lbl=document.createElement('div');lbl.className='swatch-label';lbl.textContent=t.name;
      wrap.appendChild(sw);wrap.appendChild(lbl);bsw.appendChild(wrap);
    }
  }
  const bgsw=document.getElementById('bgSwatches');
  if(bgsw&&!bgsw.children.length){
    for(const[key,t] of Object.entries(BG_THEMES)){
      const wrap=document.createElement('div');wrap.className='swatch-wrap';
      const sw=document.createElement('div');
      sw.className='swatch'+(key===currentBgTheme?' active':'');
      sw.dataset.theme=key;sw.style.background=t.bg;
      if(key==='light')sw.style.border='2px solid #ccc';
      sw.onclick=()=>applyBgTheme(key);
      const lbl=document.createElement('div');lbl.className='swatch-label';lbl.textContent=t.name;
      wrap.appendChild(sw);wrap.appendChild(lbl);bgsw.appendChild(wrap);
    }
  }
  const pb=document.getElementById('pieceBtns');
  if(pb&&!pb.children.length){
    [['unicode','Unicode'],['staunton','Staunton'],['rhosgfx_solid','RhosGFX Solid'],
     ['rhosgfx_outline','RhosGFX Outline'],['rhosgfx_wood','RhosGFX Wood'],['rhosgfx_flat','RhosGFX Flat']
    ].forEach(([key,name])=>{
      const btn=document.createElement('button');
      btn.className='piece-btn'+(key===currentPieceSet?' active':'');
      btn.dataset.set=key;btn.textContent=name;
      btn.onclick=()=>setPieceSet(key);
      pb.appendChild(btn);
    });
  }
}
// Setup theme panel when opened
document.getElementById('themePanel').addEventListener('transitionend',()=>{
  if(document.getElementById('themePanel').classList.contains('open')) setupThemePanel();
});

// ── PGN Export ────────────────────────────────────────────────────────
// ── PGN build + save (auto-save to history · prompt to save-as a file) ───────
let _gameAutoSaved = false;   // guards one auto-save per finished game

function _pgnResultToken(){
  const m = (typeof gameOverMsg !== 'undefined' ? gameOverMsg : '') || '';
  if(/1-0|white wins/i.test(m)) return '1-0';
  if(/0-1|black wins/i.test(m)) return '0-1';
  if(/draw|½-½|1\/2|stalemate|insufficient|repetition|fifty/i.test(m)) return '1/2-1/2';
  // Multiplayer "Opponent resigned — You win!" — derive from whose turn it is
  // (the winner just moved, so turn is now the loser's color).
  if(/you win|opponent resigned/i.test(m)){
    return (typeof turn !== 'undefined' && turn === 'w') ? '0-1' : '1-0';
  }
  return '*';
}

function buildPgnText(){
  // PGN standard requires YYYY.MM.DD — dashes cause Lichess import to fail.
  const isoDate = new Date().toISOString().split('T')[0];
  const date    = isoDate.replace(/-/g, '.');
  const result  = _pgnResultToken();
  let pgn = '[Event "Blundermind Game"]\n[Site "Blundermindchess.com"]\n[Date "' + date +
            '"]\n[White "White"]\n[Black "Black"]\n[Result "' + result + '"]\n';
  // Games started from a bare position (no SAN prefix) need SetUp/FEN tags so
  // the PGN reloads correctly; games with a SAN prefix are complete from move 1.
  if(typeof _gameStartFen!=='undefined' && _gameStartFen &&
     (!_gameStartSans || !_gameStartSans.length)){
    pgn += '[SetUp "1"]\n[FEN "' + _gameStartFen + '"]\n';
  }
  pgn += '\n';
  if(gameMovesAlgebraic.length === 0){ pgn += result + '\n'; }
  else{
    let line = '';
    for(let i=0;i<gameMovesAlgebraic.length;i++){
      const token = (i%2===0 ? (Math.floor(i/2)+1) + '. ' : '') + gameMovesAlgebraic[i];
      if(line && line.length + 1 + token.length > 79){ pgn += line + '\n'; line = ''; }
      line += (line ? ' ' : '') + token;
    }
    if(line) pgn += line + '\n';
    pgn += result + '\n';
  }
  return { pgn, date: isoDate, result };
}

function downloadPgn(pgn, filename){
  const blob = new Blob([pgn], {type:'application/x-chess-pgn'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Prompt the user for a filename, then download — "save as a specific file"
function savePgnAs(){
  const { pgn, date } = buildPgnText();
  const def = 'blundermind_' + date + '.pgn';
  let name = prompt('Save game as:', def);
  if(name === null) return;              // cancelled
  name = name.trim() || def;
  if(!/\.pgn$/i.test(name)) name += '.pgn';
  downloadPgn(pgn, name);
}
// Existing "Save game" button entry point
function savePgn(){ savePgnAs(); }

// Silent auto-save of every finished game to a rolling local history
function autoSaveGame(){
  if(!gameMovesAlgebraic.length) return;
  const { pgn, date, result } = buildPgnText();
  try{
    const hist = JSON.parse(localStorage.getItem('bm_gameHistory') || '[]');
    hist.push({ date, ts: Date.now(), result, moves: gameMovesAlgebraic.length, pgn });
    while(hist.length > 50) hist.shift();   // keep the last 50 games
    localStorage.setItem('bm_gameHistory', JSON.stringify(hist));
  }catch(e){}
}

// Called from updatePlayerBoxes() — fires once when a game ends
function maybeAutoSaveGame(){
  if(typeof gameOver === 'undefined') return;
  if(gameOver && !_gameAutoSaved && gameMovesAlgebraic.length > 0){
    _gameAutoSaved = true;
    autoSaveGame();
    showSaveGameToast();
  } else if(!gameOver){
    _gameAutoSaved = false;               // a new game is in progress
  }
}

// Non-blocking offer to also download the finished game as a file
function showSaveGameToast(){
  const old = document.getElementById('bm-save-toast'); if(old) old.remove();
  const d = document.createElement('div');
  d.id = 'bm-save-toast';
  d.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:#14161a;border:0.5px solid rgba(200,146,42,0.5);border-radius:6px;' +
    'color:#e8e6e0;font-family:system-ui,sans-serif;font-size:12px;padding:10px 14px;' +
    'z-index:9999;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.6);';
  d.innerHTML = '<span>💾 Game auto-saved.</span>';
  const btn = document.createElement('button');
  btn.textContent = 'Download .pgn';
  btn.style.cssText = 'background:rgba(200,146,42,0.15);border:0.5px solid rgba(200,146,42,0.5);' +
    'border-radius:4px;color:#e8aa40;font-family:inherit;font-size:11px;padding:4px 10px;cursor:pointer;';
  btn.onclick = () => savePgnAs();
  d.appendChild(btn);
  const x = document.createElement('button');
  x.textContent = '✕';
  x.style.cssText = 'background:none;border:none;color:#717a8a;cursor:pointer;font-size:12px;line-height:1;';
  x.onclick = () => d.remove();
  d.appendChild(x);
  document.body.appendChild(d);
  setTimeout(() => { if(d.parentNode) d.remove(); }, 12000);
}

// ── PGN Import & Replay ───────────────────────────────────────────────
function loadPgnFile(event){
  const file=event.target.files[0];if(!file)return;
  // Loading a game ends whatever is being played — confirm first
  if(!confirmAbandonLiveGame('Load this game')){ event.target.value=''; return; }
  const reader=new FileReader();
  reader.onload=e=>parsePgnAndStartReplay(e.target.result);
  reader.readAsText(file);
  event.target.value='';
}
function parsePgnAndStartReplay(pgnText){
  // Safety net: never run a replay on top of a live game (the bot would keep
  // moving on the replay board). Normal entry paths confirm before this.
  if(typeof _isLiveGame==='function'&&_isLiveGame()) abandonLiveGameContexts();
  // A [FEN "..."] header means the game starts from a set-up position
  const fenTag=pgnText.match(/\[FEN\s+"([^"]+)"\]/);
  // Strip header tags ([...]) and comments ({...}) line by line
  let moves=pgnText.split('\n')
    .filter(l=>!l.trim().startsWith('['))
    .join(' ');
  // Remove inline comments
  moves=moves.replace(/{[^}]*}/g,'');
  // Remove move numbers, result tokens
  moves=moves.replace(/\d+\.{1,3}/g,'');
  moves=moves.replace(/1-0|0-1|1\/2-1\/2|\*/g,'');
  const tokens=moves.trim().split(/\s+/).filter(t=>t&&t.length>0&&!t.match(/^\d+\.?$/));
  if(!tokens.length&&!fenTag){alert('No moves found in PGN.');return;}
  replayBaseFen=fenTag?fenTag[1]:null;
  gameMovesAlgebraic=[];gameOverMsg='';gameOver=false;
  selSq=-1;legalMoves=[];clearPreview();
  replayMoves=tokens;inReplay=true;
  const rc=document.getElementById('replayControls');
  if(rc) rc.style.display='block';
  // Position-only PGNs open at the position itself; games open at move 0
  rebuildToReplayIdx(tokens.length?0:0);
  updatePlayerBoxes();
}
function replayStep(delta){
  if(!inReplay)return;
  rebuildToReplayIdx(Math.max(0,Math.min(replayMoves.length,replayIdx+delta)));
}
function replayGo(idx){
  if(!inReplay)return;
  rebuildToReplayIdx(idx<0?replayMoves.length:idx);
}
function rebuildToReplayIdx(targetIdx){
  // Show all moves in the notation panel; highlight the current position.
  gameMovesAlgebraic=replayMoves.slice();
  // Reconstruct from the replay's base position (custom FEN or standard start).
  // parseFen sets turn/castling/epSq globals as side effects — capture them.
  const baseFen=replayBaseFen||FENS[0];
  let _bd=parseFen(baseFen);
  let _turn=turn,_cst={...castling},_ep=epSq;
  let _hm=parseInt(baseFen.split(' ')[4])||0;
  let _lastFrom=-1,_lastTo=-1;
  for(let i=0;i<targetIdx&&i<replayMoves.length;i++){
    const mv=algebraicToMove(replayMoves[i],_bd,_turn,_ep,_cst);
    if(!mv){break;}
    const prevBoard=_bd;
    _bd=applyMove(mv.from,mv.to,_bd,_ep,mv.promo||'Q');
    const movedPiece=prevBoard[mv.from];
    // Halfmove clock: reset on pawn moves and captures, else increment
    _hm=(movedPiece&&movedPiece.piece==='P')||prevBoard[mv.to]?0:_hm+1;
    _cst=updateCastling(mv.from,mv.to,movedPiece,_cst);
    _ep=computeEP(mv.from,mv.to,prevBoard);
    _turn=_turn==='w'?'b':'w';
    _lastFrom=mv.from;_lastTo=mv.to;
  }
  board=_bd;turn=_turn;castling=_cst;epSq=_ep;
  _replayHalfmove=_hm;
  lastMoveFrom=_lastFrom;lastMoveTo=_lastTo; // last-move highlight, as in live play
  replayIdx=targetIdx;
  atkMap=buildAtk(board);
  const pins=computePins(board);
  pinnedWSquares=pins.w;pinnedBSquares=pins.b;
  updateReplayInfo();indApply();
  if(typeof render==='function') render();
  if(typeof proSync==='function') proSync();
}
function updateReplayInfo(){
  document.getElementById('replayInfo').textContent='Move '+replayIdx+' / '+replayMoves.length;
}
function exitReplay(){
  inReplay=false;replayMoves=[];replayIdx=0;replayBaseFen=null;
  document.getElementById('replayControls').style.display='none';
  resetGame();
}

// Leave replay mode without touching the board (used by "play from here")
function _exitReplayKeepBoard(){
  inReplay=false;replayMoves=[];replayIdx=0;replayBaseFen=null;
  const rc=document.getElementById('replayControls');
  if(rc) rc.style.display='none';
}

// ── Live-game abandonment guard ──────────────────────────────────────────────
// Any control that would end a game in progress must confirm first. Returns
// true when it is safe to proceed (no live game, or the user confirmed).
function confirmAbandonLiveGame(actionLabel){
  if(typeof _isLiveGame!=='function'||!_isLiveGame()) return true;
  const isMp=typeof mpRoomId!=='undefined'&&mpRoomId;
  if(!isMp){
    // A bot game with nothing actually played yet (beyond a continuation
    // prefix) loses nothing — don't nag while the user is still configuring.
    const played=(typeof gameMovesAlgebraic!=='undefined'?gameMovesAlgebraic.length:0)
      -(typeof _gameStartSans!=='undefined'&&_gameStartSans?_gameStartSans.length:0);
    if(played<=0) return true;
  }
  const what=isMp?'your online game':'your bot game';
  return confirm((actionLabel||'Continue')+'? This will forfeit '+what+' in progress.');
}

// Tear down whatever live game is running (resign online / stop the bot) so a
// new game, replay, or loaded PGN starts from a clean slate. Call only after
// confirmAbandonLiveGame() returned true.
function abandonLiveGameContexts(){
  if(typeof mpRoomId!=='undefined'&&mpRoomId){
    if(typeof gameOver!=='undefined'&&!gameOver&&
       typeof mpWs!=='undefined'&&mpWs&&mpWs.readyState===WebSocket.OPEN){
      try{ mpWs.send(JSON.stringify({type:'resign'})); }catch(e){}
    }
    if(typeof mpLeave==='function') mpLeave();
  }
  if(typeof botActive!=='undefined'&&botActive&&typeof botStop==='function') botStop();
}

// ── Review the game that just ended ──────────────────────────────────────────
// Drops the bot/2-player context (like explore mode) but keeps the move list,
// entering replay at the final position so the user can step back anywhere and
// restart play from there.
function startReplayOfCurrentGame(){
  if(typeof gameMovesAlgebraic==='undefined'||!gameMovesAlgebraic.length) return;
  const liveBot=(typeof botActive!=='undefined'&&botActive&&!gameOver);
  const liveMp=(typeof mpRoomId!=='undefined'&&mpRoomId&&typeof mpMode!=='undefined'&&mpMode==='ingame'&&!gameOver);
  if(liveBot||liveMp) return;              // only once the game is over
  const moves=gameMovesAlgebraic.slice();
  const baseFen=_gameStartFen||null;       // from-position games replay from their FEN
  if(typeof botActive!=='undefined'&&botActive&&typeof botStop==='function') botStop();
  if(typeof mpRoomId!=='undefined'&&mpRoomId){
    if(mpWs){try{mpWs.close();}catch(e){} mpWs=null;}
    mpRoomId=null;mpRole=null;mpConnected=false;
    mpOriginalRole=null;mpGameCount=0;
    const rc=document.getElementById('mpRoomCode');if(rc)rc.textContent='';
    if(typeof chatShow==='function')chatShow(false);
    const cm=document.getElementById('chatMessages');if(cm)cm.innerHTML='';
    const ga=document.getElementById('gameActions');if(ga)ga.style.display='none';
    if(typeof mpSetMode==='function')mpSetMode('idle');
  }
  if(typeof clockStop==='function') clockStop();
  gameOver=false;gameOverMsg='';
  selSq=-1;legalMoves=[];clearPreview();
  replayBaseFen=baseFen;
  replayMoves=moves;inReplay=true;
  const rc=document.getElementById('replayControls');
  if(rc) rc.style.display='block';
  rebuildToReplayIdx(moves.length);
  updatePlayerBoxes();
}

// ── Apply a custom starting position to the live game ────────────────────────
// Shared by bot games and MP games started "from here". Sets the board, the
// SAN prefix (so notation shows the loaded game so far), and records the
// start FEN for PGN saves and post-game review.
function applyStartPosition(fen, sans){
  try{
    board=parseFen(fen);                 // sets turn/castling/epSq globals
    halfmoveClock=parseInt(fen.split(' ')[4])||0;
    gameMovesAlgebraic=(sans||[]).slice();
    _gameStartFen=fen;
    _gameStartSans=gameMovesAlgebraic.slice();
    lastMoveFrom=-1;lastMoveTo=-1;
    selSq=-1;legalMoves=[];clearPreview();
    atkMap=buildAtk(board);
    const _p=computePins(board);pinnedWSquares=_p.w;pinnedBSquares=_p.b;
    if(typeof render==='function') render();
    if(typeof updatePlayerBoxes==='function') updatePlayerBoxes();
    return true;
  }catch(e){
    console.warn('applyStartPosition failed:',e);
    return false;
  }
}

// ── Play from the current replay position ────────────────────────────────────
function _replayCurrentPos(){
  const fullmove=Math.floor(replayIdx/2)+1;
  return {
    fen: boardToFen(board,turn,castling,epSq,_replayHalfmove,fullmove),
    sans: replayMoves.slice(0,replayIdx)
  };
}

// Start a bot game from the current replay position: stash the position and
// open the Bot Builder — botStart() consumes the pending position.
function playFromHereBot(){
  if(!inReplay) return;
  window._pendingStartPos=_replayCurrentPos();
  _exitReplayKeepBoard();
  if(typeof openBotModal==='function') openBotModal();
}

// Invite a friend to play from the current replay position. Opens the
// 2-player panel with the position staged (banner shown) rather than creating
// the room immediately — so the initiator can pick their colour (White /
// Black / Random) first, regardless of whose move it is or how the board is
// oriented. From-position games are private-invite only, never posted to the
// open-challenge board.
function playFromHereInvite(){
  if(!inReplay) return;
  window._pendingStartPos=_replayCurrentPos();
  _exitReplayKeepBoard();
  openPanel('mpPanel');
  _mpRefreshStartPosBanner();
  mpShowStatus('Pick your colour, then Start Private Game — it will begin from the selected position.');
}

// Banner above the 2-player action buttons while a start position is staged
function _mpRefreshStartPosBanner(){
  const b=document.getElementById('mpStartPosBanner');
  if(!b) return;
  const sp=window._pendingStartPos;
  if(sp&&sp.fen){
    const t=document.getElementById('mpStartPosText');
    const n=(sp.sans||[]).length;
    if(t) t.textContent='♟ Start Private Game will begin from the selected position'+
      (n?' (after move '+Math.ceil(n/2)+')':'');
    b.style.display='flex';
  } else {
    b.style.display='none';
  }
}
function mpClearStartPos(){
  window._pendingStartPos=null;
  _mpRefreshStartPosBanner();
}

// Expert-board notation click → jump the replay to that position. Enters
// review mode first if the (finished) game isn't in replay yet.
function proMoveClick(i){
  if(_isLiveGame()) return;
  if(!inReplay){
    startReplayOfCurrentGame();
    if(!inReplay) return; // still live or no moves
  }
  rebuildToReplayIdx(i+1);
}

// Shared "a game is actually being played right now" test
function _isLiveGame(){
  const over=(typeof gameOver!=='undefined')&&gameOver;
  return !over&&(
    (typeof botActive!=='undefined'&&botActive)||
    (typeof mpRoomId!=='undefined'&&mpRoomId&&
     typeof mpMode!=='undefined'&&mpMode==='ingame'));
}

// Simple SAN parser
function algebraicToMove(san,bd,color,ep,castl){
  if(san==='O-O'||san==='0-0'){const r=color==='w'?7:0;return{from:rcSq(r,4),to:rcSq(r,6)};}
  if(san==='O-O-O'||san==='0-0-0'){const r=color==='w'?7:0;return{from:rcSq(r,4),to:rcSq(r,2)};}
  san=san.replace(/[+#!?]/g,'');
  let promo=null;
  if(san.includes('=')){promo=san.split('=')[1][0];san=san.replace(/=.*$/,'');}
  const pieceChars='KQRBN';
  let piece='P';let s=san.replace('x','');
  if(pieceChars.includes(s[0])){piece=s[0];s=s.slice(1);}
  const toFile=s.charCodeAt(s.length-2)-97;
  const toRank=8-parseInt(s[s.length-1]);
  const to=rcSq(toRank,toFile);
  let dfFile=null,dfRank=null;
  if(s.length>2){
    const d=s.slice(0,s.length-2);
    if(/^[a-h]$/.test(d))dfFile=d.charCodeAt(0)-97;
    else if(/^[1-8]$/.test(d))dfRank=8-parseInt(d);
    else if(d.length===2){dfFile=d.charCodeAt(0)-97;dfRank=8-parseInt(d[1]);}
  }
  for(let sq=0;sq<64;sq++){
    const p=bd[sq];
    if(!p||p.color!==color||p.piece!==piece)continue;
    if(dfFile!==null&&sqRC(sq).c!==dfFile)continue;
    if(dfRank!==null&&sqRC(sq).r!==dfRank)continue;
    if(legalMovesFor(sq,bd,ep,castl).includes(to))return{from:sq,to,promo};
  }
  return null;
}
function updateCastlingRights(from,to){
  if(from===rcSq(7,4)||to===rcSq(7,4)){castling.wK=false;castling.wQ=false;}
  if(from===rcSq(0,4)||to===rcSq(0,4)){castling.bK=false;castling.bQ=false;}
  if(from===rcSq(7,7)||to===rcSq(7,7))castling.wK=false;
  if(from===rcSq(7,0)||to===rcSq(7,0))castling.wQ=false;
  if(from===rcSq(0,7)||to===rcSq(0,7))castling.bK=false;
  if(from===rcSq(0,0)||to===rcSq(0,0))castling.bQ=false;
}

// ── Persistence ───────────────────────────────────────────────────────
function savePrefs(){
  localStorage.setItem('bm_boardTheme',currentBoardTheme);
  localStorage.setItem('bm_bgTheme',currentBgTheme);
  localStorage.setItem('bm_pieceSet',currentPieceSet);
  const st={};Object.keys(IND).forEach(k=>{st[k]={on:IND[k].on,pre:IND[k].pre};});
  localStorage.setItem('bm_ind',JSON.stringify(st));
}
function loadPrefs(){
  const bt=localStorage.getItem('bm_boardTheme');if(bt&&BOARD_THEMES[bt])applyBoardTheme(bt);
  const bg=localStorage.getItem('bm_bgTheme');applyBgTheme(bg&&BG_THEMES[bg]?bg:'lightblue');
  const ps=localStorage.getItem('bm_pieceSet');if(ps)setPieceSet(ps);
  // Format (Carbon/Journal). Migrate the old panel-only key on first run so a
  // user who chose Journal for the bot panel keeps that choice app-wide.
  try{
    const fmt = localStorage.getItem('bm_format') || localStorage.getItem('bm_panelStyle') || 'journal';
    applyFormat(fmt === 'fj' ? 'journal' : fmt);
  }catch(e){ applyFormat('journal'); }
  try{
    const ind=JSON.parse(localStorage.getItem('bm_ind')||'{}');
    Object.keys(ind).forEach(k=>{if(IND[k]){IND[k].on=ind[k].on||false;IND[k].pre=ind[k].pre||false;}});
    ibRefreshAll();
  }catch(e){}
}
window.addEventListener('beforeunload',savePrefs);
document.addEventListener('keydown',e=>{
  if(inReplay){
    if(e.key==='ArrowLeft')replayStep(-1);
    if(e.key==='ArrowRight')replayStep(1);
    if(e.key==='Escape')exitReplay();
  }else{
    if(e.key==='Escape'){clearPreview();selSq=-1;render();}
  }
  if(e.key==='Escape')closeAllPanels();
});



// indActive defined in UI layer

// toggleSetting handled by UI


const FENS=[
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "r1bq1rk1/pp2ppbp/2np1np1/2p5/4P3/2NP1NP1/PPP2PBP/R1BQ1RK1 w - - 0 9",
  "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
];
const UNI={wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙',bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟'};
const SQ=60;
const cv=document.getElementById('cv');
const ctx=cv.getContext('2d');

let board={},turn='w',castling={wK:true,wQ:true,bK:true,bQ:true},epSq=-1;
// mpRoomId declared in UI layer
let showingCheckThreats=false, checkThreatSquaresW=new Set(), checkThreatSquaresB=new Set();
let checkThreatPiecesW=new Set(), checkThreatPiecesB=new Set();
let pinnedWSquares=new Set(), pinnedBSquares=new Set();
let previewPinsW=new Set(), previewPinsB=new Set();
let currentlyPreviewing=false; // set by render() before draw calls
let showingWeakSquares=false, weakSquaresW=new Set(), weakSquaresB=new Set();
let showingOverloaded=false;
// overloadedData: { overloaded: Map<sq, Set<sq>>, dependent: Map<sq, sq> }
// overloaded[sq] = set of piece squares it alone defends
// dependent[sq]  = the sole-defender square it relies on
let overloadedData=null;
let selSq=-1,legalMoves=[];
let dragFrom=-1,dragStartPos=null,dragMoved=false,dragOver=-1,mousePos={x:0,y:0};
const DRAG_THRESHOLD=6;
let atkMap={};
let promotionPending=null,gameOver=false;
let previewBoard=null,previewAtk=null,previewEpSq=-1,previewCastling=null,premoveFrom=-1,premoveTo=-1;
let hoverSq=-1;
let lastClickSq=-1,lastClickTime=0;
// ── Premove state ────────────────────────────────────────────
let activePremove=null; // {from,to,promo} or null

// ---- FEN ----

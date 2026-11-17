
// ══════════════════════════════════════════════════════════════════════════════
// LICHESS BOT BRIDGE — this tab plays on Lichess as a BOT account
// ══════════════════════════════════════════════════════════════════════════════
// Lichess is the transport; Blundermind is the player. The bridge listens for
// challenges to the bot account, accepts the ones its filters allow, and plays
// each game ON THIS BOARD with whatever bot this page is set to. The opponent's
// moves arrive from Lichess and go through executeMove() as if the human had
// played them; the bot answers through its own botMakeMove(), and executeMove()
// hands every move back here (lichessOnLocalMove) so the bot's are posted.
//
// Lichess owns the game: its clock and its result. The page's clock is reset
// from the server's on every update, and the page never ends a Lichess game on
// its own — no local flag, no automatic repetition or fifty-move draw. It
// claims those and waits for the server to say the game is over.
//
// One game at a time: the page has one board. Challenges that arrive while a
// game is on are declined with "later".
//
// Casual games only, and not a setting. A bot's strength can be changed
// between games, so a rated bot could be raised to 2600 at full strength,
// then dialled down and farmed by its owner for rating.
//
// The token belongs to the bot account. It lives in this browser's
// localStorage and is sent to lichess.org only — a stand-in test server is
// honoured on a localhost page and nowhere else, so no link can ever point a
// stored token at another host.
//
// A bot is connected from the Bot Builder. The board's panel shows only while
// this tab hosts one — connecting, connected, or stopped by an error — so a
// player who never uses Lichess never sees it. Only a page opened with
// ?lichess reconnects by itself, so an ordinary Blundermind tab never turns
// into a bot host.

const LB_KEY = 'bm_lichessBot';
const LB_DEFAULTS = {
  token: '', auto: true, bots: false,
  speeds: { bullet: false, blitz: true, rapid: true, classical: true },
};
// Lichess's own order, fastest first — a refusal says which way a speed missed.
const LB_SPEED_ORDER = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const LB_REASON_TEXT = {
  later: 'busy — one game at a time', loading: 'engines still loading',
  tooFast: 'too fast', tooSlow: 'too slow',
  timeControl: 'needs a clock', casual: 'casual games only',
  standard: 'standard start position only', variant: 'standard chess only',
  noBot: 'not playing bots', generic: 'declined',
};
const LB_STATUS_TEXT = {
  off: 'Not connected', connecting: 'Connecting to Lichess…',
  waiting: 'Waiting for challenges', playing: 'Playing', error: 'Error',
};

let lbSettings = null;        // the persisted settings above
let lbAccount = null;         // { id, username } of the connected bot account
let lbState = 'off';          // off | connecting | waiting | playing | error
let lbStateNote = '';         // detail for the error state
let lbWantConnected = false;  // the user asked to be connected (streams reopen)
let lbEventAbort = null;      // aborts the event stream
let lbGame = null;            // the game this tab is playing, see _lbNewGame
// Opponent id → the rating they asked for in the game chat. Kept for their
// rematches; goes when this page reloads.
const lbRatingChoices = new Map();
// Opponent id → the CP Budget they asked for (cp100), kept the same way. Its
// range is the builder's Budget slider.
const lbBudgetChoices = new Map();
const LB_CP_MIN = 0, LB_CP_MAX = 300;
// Opponent id → the think time they asked for (think15s), in seconds, kept the
// same way. It runs the builder's Fixed timing at that many seconds a move
// (still capped by the bot's clock, so a short game cannot flag it); "think
// auto" gives the bot its own timing back.
const lbThinkChoices = new Map();
const LB_THINK_MAX_S = 60;
// Opponent id → the Temp they asked for (temp2, temp 0.5), kept the same way:
// 0 plays the most popular move every time, 10 lets the personality choose
// (Blind Conviction), and between them it blends the two (botBlendTemp,
// src/50-bot-engine.js). The CP Budget still decides which moves may be
// played. "temp auto" gives the bot its own pick back: for a Blind Conviction
// bot that is temp 10, which is why the greeting calls 10 the default.
const lbTempChoices = new Map();
const LB_CHAT_COOLDOWN_MS = 3000;
let lbAccepting = null;       // challenge id accepted, its gameStart not yet here
let lbStarting = false;       // botStart() is running on Lichess's behalf
let lbReplaying = false;      // rebuilding a game from the server's move list
let lbLogLines = [];
// Long enough for a whole game: every bot move is a line (what made it — see
// lastBotMoveDetail), alongside the game's events.
const LB_LOG_MAX = 400;
let lbQuickCloses = 0;        // event streams that closed right after opening
let lbLoadingWatch = null;    // redraws the panel once the engines are ready
let _lbQueue = Promise.resolve();

// ── Hooks the rest of the page calls (all guarded with typeof) ─────────────
// A Lichess game is on this board right now.
function lichessGameLive() {
  return !!(lbGame && lbGame.boardReady && !lbGame.ended);
}
// The tab belongs to the bot: local games, resigning and draw offers are off.
function lichessHosting() {
  return lbWantConnected || lichessGameLive();
}
// Hosting, or reconnecting as a host tab that has just (re)loaded. Its board
// belongs to Lichess, so the page's resume-a-live-game snapshot is neither
// written nor restored here: restored, it was a local game in progress, and
// Connect stopped to ask whether to forfeit it — a question a headless host
// never answers. A reload rebuilds from the server's move list instead.
function lichessHostTab() {
  return lichessHosting() || lbState === 'connecting';
}
function lichessStartingGame() { return lbStarting; }
function lichessBoardLocked() { return lichessHosting(); }
// Shown in the human's seat while a Lichess game is on the board.
function lichessOpponentName() {
  const g = lbGame;
  if (!g || !g.boardReady || !g.opponent) return null;
  return _lbWho(g.opponent);
}
function lichessExplainLock() {
  if (typeof showEngineWarning === 'function')
    showEngineWarning('This tab is hosting your Lichess bot. Disconnect it in the Lichess panel to play here.');
}

// Every move made on the board passes through here, called by executeMove()
// after the board, the counters and the end-of-game test are updated.
function lichessOnLocalMove(from, to, promo, piece) {
  const g = lbGame;
  if (!g || !g.boardReady || g.ended) return;
  const isPromo = !!piece && piece.piece === 'P' && (to < 8 || to >= 56);
  const uci = sqToUci(from, to, isPromo ? String(promo || 'Q').toLowerCase() : '');
  g.local.push(uci);
  if (lbReplaying) return;
  // The opponent's moves came from the server; only the bot's go back, and not
  // one the server sent (played for the bot elsewhere: _lbApplyServerBotMove).
  const botMoved = !!piece && piece.color === g.colorLetter;
  if (botMoved && !g.fromServer) {
    _lbSendMove(g, uci);
    // What made the move: "27... Rg8  Flounder 1825, depth 8".
    const ply = g.local.length;
    const san = (typeof gameMovesAlgebraic !== 'undefined' && gameMovesAlgebraic[gameMovesAlgebraic.length - 1]) || uci;
    const how = (typeof lastBotMoveDetail !== 'undefined' && lastBotMoveDetail) ||
                (typeof lastBotMoveSource !== 'undefined' && lastBotMoveSource) || '';
    lbLog(Math.ceil(ply / 2) + (ply % 2 ? '. ' : '... ') + san + (how ? '  ' + how : ''));
  }
  _lbCheckClaims(g, botMoved);
}

// The bot's answer to the opponent's standing draw offer, with the reason for
// the log (the host's log — the opponent on Lichess never sees it). An answer
// reached after the offer has gone is dropped: a yes posted then is an OFFER of
// the bot's own, the opposite of what it decided. Returns whether it was sent.
// On a yes the server ends the game; the board waits for it.
function lichessAnswerDraw(yes, why) {
  const g = lbGame;
  if (!g || g.ended) return false;
  if (!g.oppDrawOpen) {
    lbLog('The draw offer was gone before the bot answered' + (why ? ' (it would have ' + (yes ? 'accepted' : 'declined') + ': ' + why + ')' : ''));
    return false;
  }
  g.drawAnswered = true;
  g.drawAccepted = !!yes;
  lbLog((yes ? 'The bot accepts the draw' : 'The bot declines the draw') + (why ? ': ' + why : ''));
  _lbPost('/api/bot/game/' + g.id + '/draw/' + (yes ? 'yes' : 'no')).then(r => {
    if (!r.ok && lbGame === g && !g.ended) lbLog('Lichess refused the bot\'s draw answer: ' + _lbErr(r));
  });
  return true;
}
// The bot's own offer (botMaybeOfferDraw).
function lichessOfferDraw() {
  const g = lbGame;
  if (!g || g.ended) return;
  lbLog('The bot offers a draw');
  _lbPost('/api/bot/game/' + g.id + '/draw/yes');
}
// The opponent's offer is standing and the bot has not answered it. Its move
// would decline it unread, so the engine answers first (_botAnswerDrawFirst)
// and a premove stands aside (botPremoveTryFire).
function lichessDrawAwaitingAnswer() {
  const g = lbGame;
  return !!(g && g.boardReady && !g.ended && g.oppDrawOpen && !g.drawAnswered);
}
// The bot said yes and the server has yet to end the game: no move now.
function lichessDrawAccepted() {
  const g = lbGame;
  return !!(g && !g.ended && g.drawAccepted);
}
// Read from each gameState BEFORE the opponent's move goes onto the board:
// that move can fire the bot's premove or start it thinking.
function _lbNoteDrawOffer(g, st) {
  const open = !!(g.colorLetter === 'w' ? st.bdraw : st.wdraw);
  if (open && !g.oppDrawOpen) { g.drawAnswered = false; g.drawAccepted = false; }   // a new offer
  g.oppDrawOpen = open;
}

// ── Settings and log ────────────────────────────────────────────────────────
function _lbLoadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LB_KEY) || 'null'); } catch (e) { s = null; }
  s = Object.assign({}, LB_DEFAULTS, s || {});
  s.speeds = Object.assign({}, LB_DEFAULTS.speeds, (s && s.speeds) || {});
  // Saved before casual-only: dropped so they are not saved back.
  delete s.casual; delete s.rated;
  return s;
}
function _lbSaveSettings() {
  try { localStorage.setItem(LB_KEY, JSON.stringify(lbSettings)); } catch (e) {}
}

function lbLog(text) {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  lbLogLines.push(hh + ':' + mm + '  ' + text);
  if (lbLogLines.length > LB_LOG_MAX) lbLogLines.shift();
  console.log('[lichess]', text);
  lbRender();
}

function _lbSetState(state, note) {
  lbState = state;
  lbStateNote = note || '';
  lbRender();
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function _lbApiBase() {
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    const q = new URLSearchParams(location.search).get('lichessApi');
    if (q) return q.replace(/\/+$/, '');
  }
  return 'https://lichess.org';
}
function _lbHeaders(extra) {
  return Object.assign({ Authorization: 'Bearer ' + (lbSettings.token || '') }, extra || {});
}
function _lbSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lichess asks for one request at a time, and a minute's pause after a 429.
// Every POST goes through this queue, in order — a move always reaches the
// server before the draw claim that follows it. `once` is for what can be lost
// (chat): one try and no waiting, because whatever is queued behind it waits too.
function _lbPost(path, body, once) {
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(_lbApiBase() + path, {
          method: 'POST',
          headers: _lbHeaders(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : null),
          body: body || undefined,
        });
      } catch (e) {
        if (once) break;
        await _lbSleep(1000);
        continue;
      }
      if (res.status === 429) {
        if (once) return { ok: false, status: 429, data: { error: 'rate limited' } };
        lbLog('Lichess asked for a pause (429) — waiting a minute');
        await _lbSleep(60000);
        continue;
      }
      let data = null;
      try { data = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, data };
    }
    return { ok: false, status: 0, data: { error: 'network error' } };
  };
  const p = _lbQueue.then(run, run);
  _lbQueue = p.catch(() => {});
  return p;
}
function _lbErr(r) {
  return (r && r.data && r.data.error) || ('HTTP ' + (r ? r.status : '?'));
}

// Read an ndjson stream line by line. Lichess sends an empty line every few
// seconds to keep it open; silence longer than watchdogMs means the
// connection died quietly, so it is cut and the caller reopens it.
async function _lbStream(path, signal, onMsg, watchdogMs) {
  const res = await fetch(_lbApiBase() + path, {
    headers: _lbHeaders({ Accept: 'application/x-ndjson' }), signal,
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', last = Date.now();
  const dog = setInterval(() => {
    if (Date.now() - last > watchdogMs) { try { reader.cancel(); } catch (e) {} }
  }, 5000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      last = Date.now();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        try { onMsg(msg); } catch (e) { console.warn('[lichess] handler error:', e); }
      }
    }
  } finally {
    clearInterval(dog);
  }
}

// ── Connecting ──────────────────────────────────────────────────────────────
// opts.confirmed: the builder's popup already said a game in progress ends.
async function lichessConnect(opts) {
  if (lbWantConnected) return;
  const inp = document.getElementById('lbToken');
  const tok = ((inp && inp.value) || lbSettings.token || '').trim();
  if (!tok) { _lbSetState('error', 'Paste the bot account\'s token first.'); return; }
  // Without the engine this tab would sit "Waiting for challenges" and decline
  // every one (_lbDeclineReason waits for sfReady), never saying why.
  if (typeof sfBrowserSupport === 'function' && sfBrowserSupport()) {
    _lbSetState('error', sfUnsupportedText());
    return;
  }
  // Connecting hands the board to Lichess, so a game in progress here ends.
  if (typeof _isLiveGame === 'function' && _isLiveGame()) {
    if (!(opts && opts.confirmed) &&
        typeof confirmAbandonLiveGame === 'function' && !confirmAbandonLiveGame('Connect as a Lichess bot')) return;
    gameOver = true;
  }
  lbSettings.token = tok;
  _lbSaveSettings();
  if (inp) inp.value = '';
  _lbSetState('connecting');
  let acct = null;
  try {
    const r = await fetch(_lbApiBase() + '/api/account', { headers: _lbHeaders() });
    if (r.status === 401) { _lbDropToken(); _lbSetState('error', 'Lichess rejected this token. Make a new one on the bot account.'); return; }
    if (!r.ok) { _lbSetState('error', 'Lichess answered ' + r.status + ' — try again shortly.'); return; }
    acct = await r.json();
  } catch (e) {
    _lbSetState('error', 'Could not reach Lichess.');
    return;
  }
  if (!acct || acct.title !== 'BOT') {
    _lbSetState('error', '@' + (acct && acct.username) + ' is not a bot account yet. Upgrade it first — it must never have played a game.');
    return;
  }
  lbAccount = { id: acct.id, username: acct.username };
  lbWantConnected = true;
  lbLog('Connected as @' + acct.username);
  _lbWarmEngines();
  _lbEventLoop();
}

function lichessDisconnect() {
  if (lichessGameLive() &&
      !confirm('A Lichess game is in progress. Disconnecting stops the bot from playing it, so it will lose on time. Disconnect anyway?')) return;
  lbWantConnected = false;
  if (lbEventAbort) { try { lbEventAbort.abort(); } catch (e) {} }
  if (lbGame) {
    lbGame.ended = true;
    if (lbGame.abort) { try { lbGame.abort.abort(); } catch (e) {} }
    clearTimeout(lbGame.goneTimer);
    lbGame = null;
  }
  lbAccepting = null;
  // An update waiting for the next game is the page's bot now.
  if (lbNextConfig) { botApplyPanelConfig(lbNextConfig, true, { keepModal: true }); lbNextConfig = null; }
  // Local games play the bot as built, not at the last challenger's rating.
  _lbApplyMatchedRating(null);
  // A reload no longer reconnects this tab.
  _lbMarkHostTab(false);
  lbLog('Disconnected');
  _lbSetState('off');
}

function lichessForgetToken() {
  if (lbWantConnected) return;
  _lbDropToken();
  _lbSetState('off');
}
// A token Lichess refuses is never retried; the field comes back for a new one.
function _lbDropToken() {
  lbSettings.token = '';
  _lbSaveSettings();
  lbAccount = null;
}

async function _lbEventLoop() {
  let backoff = 1000;
  while (lbWantConnected) {
    const ctl = new AbortController();
    lbEventAbort = ctl;
    const opened = Date.now();
    try {
      _lbSetState(lbGame ? 'playing' : 'waiting');
      await _lbStream('/api/stream/event', ctl.signal, _lbOnEvent, 25000);
      // Lichess keeps ONE event stream per token and closes the older one, so
      // two tabs on the same bot kick each other off over and over.
      lbQuickCloses = (Date.now() - opened < 10000) ? lbQuickCloses + 1 : 0;
      if (lbQuickCloses >= 2) lbLog('The event stream keeps closing. Is another tab or program connected with this token?');
      backoff = 1000;
    } catch (e) {
      if (!lbWantConnected) break;
      if (e.status === 401) {
        lbWantConnected = false;
        _lbDropToken();
        _lbSetState('error', 'Lichess rejected the token (401). Paste a new one.');
        break;
      }
      if (e.name !== 'AbortError') lbLog('Event stream lost (' + (e.message || e) + ') — reconnecting');
    }
    if (!lbWantConnected) break;
    _lbSetState('connecting');
    await _lbSleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}

// ── Engines ─────────────────────────────────────────────────────────────────
// Stockfish always; Maia when the configured bot plays through it.
function _lbNeedsMaia() {
  return ['maia3', 'maia', 'lcmaia', 'hybrid'].includes(botTab);
}
function _lbEnginesReady() {
  return !!sfReady && (!_lbNeedsMaia() || !!_maiaReady);
}
function _lbWarmEngines() {
  try { if (!sfReady) sfInit().catch(() => {}); } catch (e) {}
  if (_lbNeedsMaia() && !_maiaReady && _maiaStatus !== 'downloading' && _maiaStatus !== 'loading') {
    try { maiaDownloadModel(); } catch (e) {}
  }
}

// ── Challenges ──────────────────────────────────────────────────────────────
function _lbOnEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'challenge') _lbOnChallenge(ev.challenge);
  else if (ev.type === 'gameStart') _lbOnGameStart(ev.game || {});
  else if (ev.type === 'challengeCanceled' && ev.challenge) lbLog('Challenge from ' + _lbWho(ev.challenge.challenger) + ' withdrawn');
  // gameFinish: the game stream reports the result itself.
}

function _lbDeclineReason(c) {
  const s = lbSettings;
  if (lbGame || lbAccepting || lbStarting) return 'later';
  if (!_lbEnginesReady()) { _lbWarmEngines(); return 'loading'; }
  const v = c.variant && c.variant.key;
  if (v === 'fromPosition') return 'standard';
  if (v !== 'standard') return 'variant';
  if (!c.timeControl || c.timeControl.type !== 'clock') return 'timeControl';
  if (c.speed === 'ultraBullet') return 'tooFast';
  if (!s.speeds[c.speed]) {
    const i = LB_SPEED_ORDER.indexOf(c.speed);
    const ok = Object.keys(s.speeds).filter(k => s.speeds[k]).map(k => LB_SPEED_ORDER.indexOf(k));
    if (!ok.length) return 'timeControl';
    return i < Math.min(...ok) ? 'tooFast' : i > Math.max(...ok) ? 'tooSlow' : 'timeControl';
  }
  if (c.rated) return 'casual';
  if (c.challenger && c.challenger.title === 'BOT' && !s.bots) return 'noBot';
  return null;
}

async function _lbOnChallenge(c) {
  if (!c || !c.id) return;
  // Our own outgoing challenges come down the same stream.
  if (c.direction === 'out' || (lbAccount && c.challenger && c.challenger.id === lbAccount.id)) return;
  const what = _lbWho(c.challenger) + ' (' + _lbChallengeTc(c) + ', ' + (c.rated ? 'rated' : 'casual') + ')';
  const reason = _lbDeclineReason(c);
  if (reason) {
    lbLog('Declined ' + what + ': ' + (LB_REASON_TEXT[reason] || reason));
    // Lichess has no "still loading" reason; "later" is the true answer to them.
    await _lbPost('/api/challenge/' + c.id + '/decline', 'reason=' + (reason === 'loading' ? 'later' : reason));
    return;
  }
  lbAccepting = c.id;
  lbLog('Accepting ' + what);
  const r = await _lbPost('/api/challenge/' + c.id + '/accept');
  if (!r.ok) {
    lbLog('Accept failed: ' + _lbErr(r));
    if (lbAccepting === c.id) lbAccepting = null;
    return;
  }
  // The game arrives as a gameStart event. If it never does, stop waiting.
  setTimeout(() => { if (lbAccepting === c.id) lbAccepting = null; }, 20000);
}

// ── Games ───────────────────────────────────────────────────────────────────
function _lbOnGameStart(g) {
  const id = g.gameId || g.id;
  if (!id) return;
  if (lbGame && lbGame.id === id) return;   // the event stream reopened mid-game
  if (lbGame) {
    lbLog('Game ' + id + ' started while ' + lbGame.id + ' is on — this tab plays one at a time, aborting it');
    _lbPost('/api/bot/game/' + id + '/abort');
    return;
  }
  lbAccepting = null;
  // A bot updated from the builder during the last game plays from this one.
  if (lbNextConfig) {
    const c = lbNextConfig;
    lbNextConfig = null;
    botApplyPanelConfig(c, true, { keepModal: true });
    _lbWarmEngines();
    lbLog('Playing with the updated bot');
  }
  lbGame = _lbNewGame(id);
  _lbSetState('playing');
  lbLog('Game started: ' + _lbApiBase() + '/' + id);
  _lbGameLoop(lbGame);
}

function _lbNewGame(id) {
  return {
    id,
    color: null, colorLetter: null, opponent: null, rated: false, speed: '', clock: null,
    boardReady: false,  // the local game is set up; moves flow both ways
    ended: false,
    local: [],          // UCI moves on this board, in order
    abort: null,        // aborts the game stream (a resync reopens it)
    drawPly: -1, takebackPly: -1, claimPly: -1,
    claimPending: -1, claimRule: '',   // a draw claim waiting on the bot's turn (_lbCheckClaims)
    oppDrawOpen: false, // the opponent's draw offer is standing
    drawAnswered: false, drawAccepted: false,   // the bot's answer to it
    greeted: false, chatAt: 0,   // the opening line is said; when the last command was answered
    chatHeld: null, chatTimer: null,   // a command that came inside the cooldown, and its timer
    goneTimer: null,
    rebuild: null,      // a rebuild waiting to run: { moves, st, timer } (_lbRequestRebuild)
    resyncNow: false,   // the stream was closed to resync: reopen it at once
    fromServer: false,  // the bot's move being played is the server's, not to be sent back
  };
}

async function _lbGameLoop(g) {
  let backoff = 1000;
  while (lbGame === g && !g.ended && lbWantConnected) {
    const ctl = new AbortController();
    g.abort = ctl;
    try {
      await _lbStream('/api/bot/game/stream/' + g.id, ctl.signal, m => _lbOnGameMsg(g, m), 60000);
      backoff = 1000;
    } catch (e) {
      if (g.ended || lbGame !== g) break;
      if (e.status === 404) { lbLog('Game ' + g.id + ' no longer exists'); _lbFinishGame(g, null); break; }
      if (e.name !== 'AbortError') lbLog('Game stream lost (' + (e.message || e) + ') — reconnecting');
    }
    if (g.ended || lbGame !== g || !lbWantConnected) break;
    // Closed on purpose to resync (_lbResync): reopen at once. It used to wait
    // the back-off's second like a lost stream, with the bot's clock running.
    if (g.resyncNow) { g.resyncNow = false; continue; }
    await _lbSleep(backoff);
    backoff = Math.min(backoff * 2, 15000);
  }
}

function _lbOnGameMsg(g, m) {
  if (lbGame !== g || g.ended) return;
  if (m.type === 'gameFull') _lbOnGameFull(g, m);
  else if (m.type === 'gameState') _lbOnGameState(g, m);
  else if (m.type === 'opponentGone') _lbOnOpponentGone(g, m);
  else if (m.type === 'chatLine') _lbOnChatLine(g, m);
}

function _lbMoves(st) {
  return st && st.moves ? st.moves.split(' ').filter(Boolean) : [];
}

// The first line of every game stream — including each reopened one, which is
// what makes a resync: if the server's moves are not the board's, rebuild.
function _lbOnGameFull(g, full) {
  const meWhite = !!(lbAccount && full.white && full.white.id === lbAccount.id);
  g.color = meWhite ? 'white' : 'black';
  g.colorLetter = meWhite ? 'w' : 'b';
  const o = (meWhite ? full.black : full.white) || {};
  g.opponent = {
    id: o.id || '',
    name: o.name || o.id || (o.aiLevel ? 'Lichess AI level ' + o.aiLevel : 'Anonymous'),
    title: o.title || '', rating: o.rating || null, provisional: !!o.provisional,
  };
  g.rated = !!full.rated;
  g.speed = full.speed || '';
  g.clock = full.clock || null;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  if (full.initialFen && full.initialFen !== 'startpos' && full.initialFen !== START) {
    lbLog('This game starts from a set position, which the bridge does not play — aborting');
    _lbPost('/api/bot/game/' + g.id + '/abort');
    return;
  }
  const moves = _lbMoves(full.state), st = full.state || {};
  // The game's first line on this page: set the board up now.
  if (!g.boardReady) _lbBeginLocalGame(g, moves);
  // A reopened stream: one rebuild, joined with any already waiting.
  else if (g.rebuild || !_lbSameMoves(g.local, moves)) {
    _lbRequestRebuild(g, moves, st, 'Board out of step with Lichess — rebuilding from the server');
    return;
  }
  _lbAfterState(g, st);
}

function _lbSameMoves(a, b) {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

// Is the page's bot one that moves its rating for each opponent? A quick pick
// on top of the builder's bot replaced it. A blend has no one rating to move:
// each slot has its own.
function _lbMatching() {
  const cfg = window._lastAppliedBotConfig;
  return !!(cfg && cfg.lichessMatchRating && !window._quickBotLastPick && botTab !== 'hybrid');
}

function _lbEloRange() {
  const flounder = botTab === 'sf' || botTab === 'lcsf';
  return { flounder, min: flounder ? FLOUNDER_ELO_MIN : 600, max: flounder ? FLOUNDER_ELO_MAX : 2600 };
}

// ── Measured strength ───────────────────────────────────────────────────────
// A bot's engine setting is not always how strong it plays: Blind Conviction,
// the guards and the personality all move it. cfg.lichessStrength, filled in the
// builder's Lichess popup, holds what was measured as [setting, plays like]
// rows, or [setting, plays like, cp] for a row measured at another CP Budget
// than the builder's. A matching bot works backwards from it to the setting,
// and the Budget, that play at the rating wanted, so every rating it talks
// about (the greeting, the range, the chat reply) is a playing strength. With
// none, the setting is the strength.
//
// Rows run in rising strength, settings never falling. Two rows can share a
// setting when a Budget is what moves between them: Blundermind-01 runs out of
// Maia at 600 and 2600, and goes on past them by Budget alone (Maia 600 at
// cp300 plays like 600, at its own 150 like 850; Maia 2600 at 150 plays like
// 2025, at cp50 like 2775). Between two rows it reads a straight line in both
// the setting and the Budget; past the ends, the same gap as the nearest row,
// at that row's Budget.
function _lbStrengthTable() {
  const t = (window._lastAppliedBotConfig || {}).lichessStrength;
  if (!Array.isArray(t) || !t.length) return null;
  const rows = t.map(p => Array.isArray(p) && p.length >= 2 ? [+p[0], +p[1], p[2] == null ? null : +p[2]] : null);
  const ok = rows.every((r, i) => r && Number.isFinite(r[0]) && Number.isFinite(r[1]) &&
    (r[2] == null || Number.isFinite(r[2])) &&
    (i === 0 || (r[1] > rows[i - 1][1] && (r[0] > rows[i - 1][0] ||
      (r[0] === rows[i - 1][0] && (r[2] != null || rows[i - 1][2] != null))))));
  return ok ? rows : null;
}
// The rows measured at the builder's Budget, as [setting, plays like]: what a
// setting plays like when nothing else moves (the bot with no rating to
// match, Flounder's dial steps, the time-pressure curve).
function _lbPlainRows(t) {
  const p = t ? t.filter(r => r[2] == null).map(r => [r[0], r[1]]) : [];
  return p.length ? p : null;
}
// Over [setting, plays like] pairs: col 0 → col 1 reads setting → strength;
// col 1 → col 0, strength → setting.
function _lbStrengthMap(v, t, from) {
  if (!t) return v;
  const to = 1 - from, n = t.length - 1;
  if (v <= t[0][from]) return v - t[0][from] + t[0][to];
  if (v >= t[n][from]) return v - t[n][from] + t[n][to];
  let i = 0;
  while (v > t[i + 1][from]) i++;
  return t[i][to] + (v - t[i][from]) * (t[i + 1][to] - t[i][to]) / (t[i + 1][from] - t[i][from]);
}
const _lbPlaysLike = (setting, t) => Math.round(_lbStrengthMap(setting, _lbPlainRows(t), 0));

// The setting and the Budget (cp0, the builder's, for a row without one) that
// play at strength v.
function _lbRowFor(v, t, cp0) {
  const n = t.length - 1, cp = r => r[2] != null ? r[2] : cp0;
  if (v <= t[0][1]) return { setting: v - t[0][1] + t[0][0], cp: cp(t[0]) };
  if (v >= t[n][1]) return { setting: v - t[n][1] + t[n][0], cp: cp(t[n]) };
  let i = 0;
  while (v > t[i + 1][1]) i++;
  const f = (v - t[i][1]) / (t[i + 1][1] - t[i][1]);
  return { setting: t[i][0] + f * (t[i + 1][0] - t[i][0]), cp: cp(t[i]) + f * (cp(t[i + 1]) - cp(t[i])) };
}
// The strength at which the setting reaches x: the first one (lowest) or the
// last (highest), since a run of rows can hold one setting.
function _lbStrengthOf(x, t, last) {
  const n = t.length - 1;
  if (x < t[0][0] || (!last && x === t[0][0])) return x - t[0][0] + t[0][1];
  if (x > t[n][0] || (last && x === t[n][0])) return x - t[n][0] + t[n][1];
  let i;
  if (last) { i = n; while (t[i - 1][0] > x) i--; i--; }
  else { i = 0; while (t[i + 1][0] < x) i++; }
  return t[i][1] + (x - t[i][0]) * (t[i + 1][1] - t[i][1]) / (t[i + 1][0] - t[i][0]);
}

// The setting and the Budget that play at `wanted`, within what this engine
// can be set to: { setting, cp, est (what it plays like), edge ('low' |
// 'high' | null) }. Inside the range est is the strength asked for: Maia takes
// any setting, so it lands on it. At an end it is the end; on Flounder's
// 25-point dial, what that step plays like.
function _lbSettingFor(wanted, t, cp0) {
  const { flounder, min, max } = _lbEloRange(), { lo, hi } = _lbPerfRange();
  const edge = wanted <= lo ? 'low' : wanted >= hi ? 'high' : null;
  const v = Math.max(lo, Math.min(hi, wanted));
  const row = t ? _lbRowFor(v, t, cp0) : { setting: v, cp: cp0 };
  let setting = Math.max(min, Math.min(max, Math.round(row.setting)));
  // Flounder's dial only holds whole steps; Maia takes any rating.
  if (flounder) setting = Math.round(setting / FLOUNDER_ELO_STEP) * FLOUNDER_ELO_STEP;
  const est = flounder ? _lbPlaysLike(setting, t) : Math.round(v);
  return { setting, cp: row.cp != null ? Math.round(row.cp) : row.cp, est, edge };
}

// ── Curve A on the Regan model, for this game's clock ───────────────────────
// The builder's fit (REGAN in bot-control-panel.html): rating lost at s seconds
// per move, D(s) = 339 − 1442·s^−0.283, anchored at the clock's average pace,
// base/60 + increment. Full strength at the anchor and slower, Regan's loss
// below it. The loss is taken off the playing strength, and each point turned
// back into the setting that plays at it, so a measured bot's curve lands on
// the strength it says too. Knots where the builder seeds them. Only the
// setting moves with the clock, never the Budget, so the loss is read off the
// rows at the builder's Budget, starting from what this setting plays like
// there: Maia 2600 at cp50 (2775) loses Regan's points from Maia 2600's 2025,
// down to a lower Maia still at cp50.
const LB_REGAN = { C: 339, K: 1442, ALPHA: 0.283, SMIN: 0.05, EXPECTED_MOVES: 60, X_MIN: 1, X_MAX: 200 };
const _lbReganD = s => LB_REGAN.C - LB_REGAN.K * Math.pow(Math.max(LB_REGAN.SMIN, s), -LB_REGAN.ALPHA);
function _lbReganCurveA(clock, setting, t) {
  const { min, max } = _lbEloRange();
  t = _lbPlainRows(t);
  const est = _lbStrengthMap(setting, t, 0);
  const raw = clock.initial / 1000 / LB_REGAN.EXPECTED_MOVES + clock.increment / 1000;
  const anchor = Math.max(1.001, Math.min(LB_REGAN.X_MAX / 2, Math.max(0.5, raw)));
  const xs = [LB_REGAN.X_MAX, anchor], steps = 5, r = Math.pow(LB_REGAN.X_MIN / anchor, 1 / (steps + 1));
  for (let k = 1; k <= steps; k++) xs.push(anchor * Math.pow(r, k));
  xs.push(LB_REGAN.X_MIN);
  return xs.map(x => {
    const strength = est + Math.min(0, _lbReganD(x) - _lbReganD(anchor));
    return { x: +x.toFixed(3), y: Math.max(min, Math.min(max, Math.round(_lbStrengthMap(strength, t, 1)))) };
  });
}

// A bot set to match (the builder's Lichess popup) plays each game at the
// challenger's Lichess rating for that speed, plus the bot's offset, unless they
// have asked for a rating in the chat. With no rating to go on, or no game (g
// null, on disconnecting), it plays at the rating it was built with. Always
// worked out from the saved config, never from the last game's numbers, so a
// resync can't stack it up, and the saved bot keeps its own rating. The rating
// wanted is a playing strength: a bot with a measured table is set to whatever
// plays at it. Curve A moves too, since it holds absolute ratings and on Maia
// the curve is what runs: in a game with a clock it is rebuilt on the Regan
// model for that clock; with none, the builder's curve is shifted. Returns
// { setting, cp, est, edge }, or null for a bot that doesn't match.
function _lbApplyMatchedRating(g) {
  // A bot that doesn't match takes no chat commands, Temp among them.
  if (!_lbMatching()) { botBlendTemp = null; return null; }
  const cfg = window._lastAppliedBotConfig;
  const { flounder } = _lbEloRange();
  const t = _lbStrengthTable();
  const base = +(flounder && cfg.flounderElo != null ? cfg.flounderElo : cfg.elo) || 1500;
  const offset = +cfg.lichessMatchOffset || 0;
  const opp = g && g.opponent;
  const chosen = opp && opp.id ? lbRatingChoices.get(opp.id) : undefined;
  const wanted = chosen != null ? chosen : opp && opp.rating ? opp.rating + offset : null;
  const at = wanted != null ? _lbSettingFor(wanted, t, cfg.cpBudget)
    : { setting: base, cp: cfg.cpBudget, est: _lbPlaysLike(base, t), edge: null };
  const elo = at.setting;
  if (flounder) {
    const dial = document.getElementById('flounderElo'), out = document.getElementById('flounderEloVal');
    if (dial) dial.value = elo;
    if (out) out.textContent = elo;
  } else {
    maia3SetRating(elo);
  }
  if (botPressureCurveA && cfg.ctrlA) {
    botPressureCurveA = g && g.clock
      ? _lbReganCurveA(g.clock, elo, t)
      : cfg.ctrlA.map(p => ({ x: p.x, y: +p.y + elo - base }));
  }
  _quickBotSyncBookRating(elo);
  // The CP Budget: the one the measured table gives for this rating (the
  // builder's, but for a row measured at another), unless they asked for one
  // in the chat. The Hard Floor is never under the Budget (the builder's own
  // rule), so a Budget above the bot's Floor lifts the Floor with it. A Budget
  // they ask for leaves the rating where it was: a smaller Budget plays
  // stronger than it says, and that is the opponent's choice.
  const asked = opp && opp.id ? lbBudgetChoices.get(opp.id) : undefined;
  const cp = asked != null ? asked : at.cp;
  const floor = cfg.hardFloorCp != null ? cfg.hardFloorCp : cfg.cpBudget;
  window._bcpCpBudget = cp;
  window._bcpCpHardFloor = cp != null && floor != null ? Math.max(+floor, cp) : floor;
  at.cp = cp;
  at.think = _lbApplyThinkChoice(opp);
  at.temp = _lbApplyTempChoice(opp);
  if (opp && !g.matchLogged) {
    g.matchLogged = true;
    if (at.think != null) lbLog('Think time ' + _lbThinkText(at.think) + ': ' + opp.name + ' asked for it in the chat');
    if (at.temp != null) lbLog('Temp ' + at.temp + ': ' + opp.name + ' asked for it in the chat');
    const plays = (flounder ? 'Flounder ' : 'Maia ') + elo + (cp !== cfg.cpBudget ? ', CP budget ' + cp : '') +
      (t ? ' (plays like ' + at.est + ')' : '');
    if (asked != null) lbLog('CP budget ' + asked + ': ' + opp.name + ' asked for it in the chat (built with ' + cfg.cpBudget + ')');
    lbLog(chosen != null
      ? 'Playing at ' + plays + ': ' + opp.name + ' asked for ' + chosen + ' in the chat'
      : opp.rating
      ? 'Playing at ' + plays + ': ' + opp.name + ' is rated ' + opp.rating + (opp.provisional ? '?' : '') +
        (offset ? ', offset ' + (offset > 0 ? '+' : '') + offset : '')
      : opp.name + ' has no rating to match: playing at ' + plays);
  }
  return at;
}

// The think time this opponent asked for, put into effect: the builder's Fixed
// timing at that many seconds a move, or, with none (or no game), the timing
// the bot was built with. Returns the seconds, or undefined.
function _lbApplyThinkChoice(opp) {
  const cfg = window._lastAppliedBotConfig || {};
  const secs = opp && opp.id ? lbThinkChoices.get(opp.id) : undefined;
  if (secs != null) {
    botTimeBehavior = 'fixed';
    botFixedDelayMs = Math.round(secs * 1000);
  } else {
    // As the builder's config applies it (applyBotConfig).
    const modes = { complexity: 'complexity', instant: 'instant', fixed: 'fixed', mirror: 'mirror' };
    botTimeBehavior = modes[cfg.timingMode] || 'pace';
    botFixedDelayMs = cfg.fixedDelayMs || 5000;
  }
  return secs;
}
const _lbThinkText = s => (Number.isInteger(s) ? s : s.toFixed(1)) + ' s a move';

// The Temp this opponent asked for, put into effect, or none (the bot picks as
// built). Returns it, or undefined.
function _lbApplyTempChoice(opp) {
  const t = opp && opp.id ? lbTempChoices.get(opp.id) : undefined;
  botBlendTemp = t != null ? t : null;
  return t;
}
// Whose distribution popularity comes from: Maia's, or Flounder's own.
const _lbTempEngine = () => _lbEloRange().flounder ? 'Flounder\'s' : 'Maia\'s';
// What the ends of the dial do, beside the number in a reply.
function _lbTempText(t) {
  return 'Temp ' + t + (t <= 0 ? ' (' + _lbTempEngine() + ' top move, no personality)'
    : t >= BLEND_TEMP_MAX ? ' (personality\'s pick)' : '');
}
// A measured bot's ratings were measured picking as it was built. Under a
// Temp they are not what it plays at, and the reply says so when there is room:
// Temp 0, Maia's top move, is likely the strongest it gets.
function _lbTempCaveat(text) {
  if (botBlendTemp == null || !_lbStrengthTable()) return text;
  if (botBlindConviction && botBlendTemp >= BLEND_TEMP_MAX) return text;
  const more = '. Its ELO was measured at ' + (botBlindConviction ? 'temp ' + BLEND_TEMP_MAX : 'temp auto') + '.';
  return text.length + more.length <= LB_CHAT_MAX ? text + more : text;
}
// Lichess cuts a chat line at this many characters.
const LB_CHAT_MAX = 140;

// A chat line matters less than a move, and every POST shares one queue, so a
// line Lichess won't take at once is dropped rather than held in front of the
// bot's next move. `room`: 'player' (the opponent's chat, the default) or
// 'spectator' (the public one, which anyone watching or replaying sees).
function _lbSay(g, text, room) {
  room = room || 'player';
  _lbPost('/api/bot/game/' + g.id + '/chat', new URLSearchParams({ room, text }).toString(), true)
    .then(r => { if (!r.ok) lbLog('Chat line not sent (' + _lbErr(r) + (room === 'spectator' ? ', spectators' : '') + '): ' + text); });
}
// Said in both chats: what the bot plays at is for anyone watching the game,
// during it and after, not only the opponent (a tester's request, Nov 2026).
function _lbTell(g, text) {
  _lbSay(g, text, 'player');
  _lbSay(g, text, 'spectator');
}

// Every rating the bot says is a playing strength (the measured table's right
// hand column). Beside it goes what runs to play at it, the engine setting
// and the CP Budget, since they can type a Budget too.
const _lbElo = n => Math.round(n).toLocaleString('en-US');
const _lbEdgeText = edge => edge ? ' (its ' + (edge === 'low' ? 'lowest' : 'highest') + ')' : '';
const _lbRunsText = at => (_lbEloRange().flounder ? 'Flounder ' : 'Maia ') + at.setting +
  (at.cp != null ? ', CP budget ' + at.cp : '');
// The range they can type, in the same playing strength: where the setting
// reaches the engine's ends, which a row at another Budget can carry past
// what the setting alone would.
function _lbPerfRange() {
  const { min, max } = _lbEloRange(), t = _lbStrengthTable();
  return t ? { lo: Math.round(_lbStrengthOf(min, t, false)), hi: Math.round(_lbStrengthOf(max, t, true)) }
    : { lo: min, hi: max };
}

// Once a game, at its start, three lines (Ben's wording, Nov 16): everything
// it is set to, what can be typed, and the ranges, e.g.
//   ELO set to 1,025 (using Maia 855), CP budget 150, think auto, temp 10
//   Type in chat to change strength (ELO), centipawn budget (cp), Move timing (think), Maia temperature (temp).
//   ELO 600-2775, cp 0-300, think 0-60s, Temp 0 (Maia's top move) - 10 (personality driven)
// Lichess cuts a chat line at 140 characters; the longest here is the second,
// 111 (a Flounder bot). The spectators get the first line — what it plays at — without the
// instructions, which only the opponent can use.
//
// Sent LB_GREET_DELAY_MS after the game starts (see _lbBeginLocalGame).
function _lbGreet(g, at) {
  const { lo, hi } = _lbPerfRange();
  const engine = _lbEloRange().flounder ? 'Flounder' : 'Maia';
  const state = _lbStateLine(at);
  _lbSay(g, state);
  _lbSay(g, 'Type in chat to change strength (ELO), centipawn budget (cp), Move timing (think), ' + engine + ' temperature (temp).');
  _lbSay(g, 'ELO ' + lo + '-' + hi + ', cp ' + LB_CP_MIN + '-' + LB_CP_MAX + ', think 0-' + LB_THINK_MAX_S + 's, Temp 0 (' +
    _lbTempEngine() + ' top move) - ' + BLEND_TEMP_MAX + ' (personality driven)');
  _lbSay(g, state, 'spectator');
}
// Everything the bot is set to, in one line: the strength it plays at (and
// where that is the end of its range), the engine setting that plays at it,
// the CP Budget, the think time and Temp. With no think time asked for it is
// "auto"; with no Temp, a Blind Conviction bot is at 10 (that is what it
// plays) and any other bot is "auto", its own pick.
function _lbStateLine(at) {
  const edge = at.edge ? 'its ' + (at.edge === 'low' ? 'lowest' : 'highest') + ', ' : '';
  const think = at.think != null ? (Number.isInteger(at.think) ? at.think : at.think.toFixed(1)) + 's' : 'auto';
  const temp = at.temp != null ? at.temp : botBlindConviction ? BLEND_TEMP_MAX : 'auto';
  return 'ELO set to ' + _lbElo(at.est) + ' (' + edge + 'using ' + (_lbEloRange().flounder ? 'Flounder ' : 'Maia ') + at.setting + ')' +
    (at.cp != null ? ', CP budget ' + at.cp : '') + ', think ' + think + ', temp ' + temp;
}
// Posted the instant Lichess started the game, the greeting's first line could
// land before the opponent's game page had joined the chat: saved, but never
// shown to them live (seen on Blundermind-01, Nov 16).
const LB_GREET_DELAY_MS = 2000;

// The opponent sets the rating from the player chat with a message that is only
// that: ELO1500, or 1500ELO (spaces, lower case and 1,500 are fine). It is the
// playing strength they want; the reply says the strength it is set to, and
// the engine setting that plays at it goes to the host's log. The bot reads its
// rating fresh for each move, so this lands on its next one. Lichess sends the
// bot's own lines back down this stream too. Any number is taken (ELO0 to
// ELO99999); one past the range stops at its end, and the reply says so.
//
// The CP Budget the same way: cp100 or 100cp, alone or beside the rating
// (ELO2000 cp100, either order, a space or comma between). It runs 0 to 300,
// the builder's Budget slider. A Budget they ask for doesn't move the rating
// the bot gives, and stays until they ask for a rating on its own, which
// brings back the Budget that goes with that rating (the measured table's).
//
// The think time too: think15s, think 15 s, think2, think 2.5 seconds — a fixed
// time a move, 0 to 60 s — or think auto for the bot's own timing again. It
// combines with the others (ELO2000 think5s) and is kept until they change it.
//
// And Temp: temp2, temp 0.5, temp10 — 0 to 10, how far the personality
// rather than popularity picks among the moves the Budget allows (see
// botBlendTemp) — or temp auto for the bot's own pick again. Combines and is
// kept the same way.
//
// What never gets here: Lichess's flood filter (lila Flood.scala) drops a
// player's line within one character of either of their last two in the past
// minute, so ELO2200 straight after ELO2100 never reaches the bot. Bots are
// exempt, so the replies themselves always go out.
function _lbParseCommand(text) {
  const num = '(\\d{1,2},\\d{3}|\\d{1,5})';
  const part = new RegExp('^(?:elo\\s*' + num + '|' + num + '\\s*elo|cp\\s*(\\d{1,5})|(\\d{1,5})\\s*cp' +
    '|think\\s*(\\d{1,5}(?:\\.\\d+)?)\\s*(?:seconds?|secs?|s)?|think\\s*(auto)' +
    '|temp\\s*(\\d{1,5}(?:\\.\\d+)?|\\.\\d+)|temp\\s*(auto))(?:[\\s,]+|$|(?=[a-z]))', 'i');
  // The greeting shows each command in quotes ("ELOXXXX"), so quotes typed
  // around one are dropped rather than making it unreadable.
  let rest = String(text || '').replace(/["'“”‘’]/g, '').trim();
  const cmd = {};
  while (rest) {
    const m = part.exec(rest);
    if (!m) return null;
    if (m[1] || m[2]) {
      if (cmd.elo != null) return null;
      cmd.elo = +String(m[1] || m[2]).replace(',', '');
    } else if (m[3] != null || m[4] != null) {
      if (cmd.cp != null) return null;
      cmd.cp = +(m[3] || m[4]);
    } else if (m[5] != null || m[6] != null) {
      if (cmd.think != null) return null;
      cmd.think = m[6] ? 'auto' : +m[5];
    } else {
      if (cmd.temp != null) return null;
      cmd.temp = m[8] ? 'auto' : +m[7];
    }
    rest = rest.slice(m[0].length);
  }
  return cmd.elo != null || cmd.cp != null || cmd.think != null || cmd.temp != null ? cmd : null;
}
function _lbOnChatLine(g, m) {
  const opp = g.opponent;
  if (!g.boardReady || m.room !== 'player' || !opp || !opp.id || String(m.username).toLowerCase() !== opp.id) return;
  const cmd = _lbParseCommand(m.text);
  if (!cmd) return;
  // Too soon after the last one: held, and answered when the cooldown ends.
  // A newer command replaces what it names in a held one (ELO2000, then cp100,
  // holds both), so a burst gets one answer, to the last thing asked of each,
  // and nothing that arrives goes unanswered.
  const wait = g.chatAt + LB_CHAT_COOLDOWN_MS - Date.now();
  if (wait > 0) {
    const held = g.chatHeld || {};
    g.chatHeld = { elo: cmd.elo != null ? cmd.elo : held.elo, cp: cmd.cp != null ? cmd.cp : held.cp,
                   think: cmd.think != null ? cmd.think : held.think,
                   temp: cmd.temp != null ? cmd.temp : held.temp };
    if (!g.chatTimer) g.chatTimer = setTimeout(() => {
      const w = g.chatHeld;
      g.chatTimer = null; g.chatHeld = null;
      if (w && lbGame === g && !g.ended && g.boardReady) _lbChatCommand(g, w);
    }, wait);
    return;
  }
  _lbChatCommand(g, cmd);
}
function _lbChatCommand(g, cmd) {
  const opp = g.opponent;
  g.chatAt = Date.now();
  if (!_lbMatching()) {
    _lbSay(g, cmd.elo != null ? 'This bot\'s rating can\'t be changed.'
      : cmd.cp != null ? 'This bot\'s CP budget can\'t be changed.'
      : cmd.think != null ? 'This bot\'s think time can\'t be changed.' : 'This bot\'s temp can\'t be changed.');
    return;
  }
  let think = null;
  if (cmd.think === 'auto') lbThinkChoices.delete(opp.id);
  else if (cmd.think != null) {
    think = Math.round(Math.max(0, Math.min(LB_THINK_MAX_S, cmd.think)) * 10) / 10;
    lbThinkChoices.set(opp.id, think);
  }
  let temp = null;
  if (cmd.temp === 'auto') lbTempChoices.delete(opp.id);
  else if (cmd.temp != null) {
    temp = Math.round(Math.max(0, Math.min(BLEND_TEMP_MAX, cmd.temp)) * 10) / 10;
    lbTempChoices.set(opp.id, temp);
  }
  let cp = null, cpEdge = null;
  if (cmd.elo != null) {
    lbRatingChoices.set(opp.id, cmd.elo);
    // A rating on its own comes with its own Budget.
    if (cmd.cp == null) lbBudgetChoices.delete(opp.id);
  }
  if (cmd.cp != null) {
    cp = Math.max(LB_CP_MIN, Math.min(LB_CP_MAX, cmd.cp));
    cpEdge = cp <= LB_CP_MIN ? 'low' : cp >= LB_CP_MAX ? 'high' : null;
    lbBudgetChoices.set(opp.id, cp);
  }
  const at = _lbApplyMatchedRating(g);
  let said;
  if (cmd.elo != null) {
    const engine = _lbEloRange().flounder ? 'Flounder' : 'Maia3';
    lbLog(_lbWho(opp) + ' asked for ' + cmd.elo + ' in the chat: ' + engine + ' set to ' + at.setting +
      ', CP budget ' + at.cp + ', plays like ' + at.est);
    said = 'Performance set to ' + _lbElo(at.est) + _lbEdgeText(at.edge) + ': ' + _lbRunsText(at) + _lbEdgeText(cpEdge);
  } else if (cmd.cp != null) {
    said = 'CP budget set to ' + cp + _lbEdgeText(cpEdge);
  }
  if (cp != null) lbLog(_lbWho(opp) + ' asked for cp' + cmd.cp + ' in the chat: CP budget ' + cp + ', Hard Floor ' + window._bcpCpHardFloor);
  if (cmd.think != null) {
    const longest = think != null && think >= LB_THINK_MAX_S ? ' (its longest)' : '';
    lbLog(_lbWho(opp) + ' asked for think ' + (think != null ? cmd.think + ' s' : 'auto') + ' in the chat: ' +
      (think != null ? 'Fixed timing, ' + _lbThinkText(think) : 'back to the bot\'s own timing'));
    const t = think != null ? _lbThinkText(think) + longest : null;
    said = said ? said + (t ? ', think time ' + t : ', think time back to human-like timing')
                : (t ? 'Think time set to ' + t : 'Think time back to human-like timing');
  }
  if (cmd.temp != null) {
    lbLog(_lbWho(opp) + ' asked for temp ' + cmd.temp + ' in the chat: ' +
      (temp != null ? 'Temp ' + temp : 'back to the bot\'s own pick'));
    // Alone, the ends say what they do; beside other replies, just the number.
    said = said ? said + (temp != null ? ', temp ' + temp : ', temp back to its own')
                : (temp != null ? _lbTempText(temp).replace('Temp', 'Temp set to') : 'Temp back to the bot\'s own pick');
  }
  // Both chats: what the bot plays at is for spectators too. A reply that
  // gives a rating or a Temp says when the rating wasn't measured at this Temp.
  _lbTell(g, cmd.elo != null || cmd.temp != null ? _lbTempCaveat(said) : said);
  if (typeof botUpdatePlayerNames === 'function') botUpdatePlayerNames(botPlayerColor);
  lbRender();
}

// Set the board up for this game with the page's bot, then replay whatever
// has already been played (a reopened stream, or a resync). The user's own
// colour and clock choices are borrowed for botStart() and put back after.
function _lbBeginLocalGame(g, moves) {
  const humanColor = g.color === 'white' ? 'black' : 'white';
  const savedPref = botColorPref, savedTC = botSelectedTC;
  if (g.clock) {
    const t = g.clock.initial / 1000, inc = g.clock.increment / 1000;
    TIME_CONTROLS.lichess = { label: _lbTcText(t, inc), time: t, inc: inc };
  }
  // Whatever the board held is finished: Lichess decides what is on it now.
  if (botActive && !gameOver) gameOver = true;
  g.boardReady = false;
  const matched = _lbApplyMatchedRating(g);
  // Once a game, and not on coming back to one already under way.
  // Held LB_GREET_DELAY_MS so the opponent's page is in the chat to see it,
  // and read afresh then, in case a command has already changed something.
  if (matched && !g.greeted && moves.length < 2) {
    setTimeout(() => {
      if (lbGame !== g || g.ended || !g.boardReady) return;
      const at = _lbApplyMatchedRating(g);
      if (at) _lbGreet(g, at);
    }, LB_GREET_DELAY_MS);
  }
  g.greeted = true;
  lbStarting = true;
  try {
    botColorPref = humanColor;
    botSelectedTC = g.clock ? 'lichess' : 'untimed';
    botStart();
  } finally {
    lbStarting = false;
    botColorPref = savedPref;
    botSelectedTC = savedTC;
  }
  g.local = [];
  g.boardReady = true;
  if (moves.length) _lbReplay(g, moves);
  if (typeof botUpdatePlayerNames === 'function') botUpdatePlayerNames(botPlayerColor);
  const st = document.getElementById('botStatus');
  if (st) st.textContent = 'Lichess · vs ' + _lbWho(g.opponent);
  lbRender();
}

// Play the server's moves onto the board without the bot answering them:
// quietly (no sound, no drawing per move: quietMoves in 30-board-ui.js), then
// drawn once.
function _lbReplay(g, moves) {
  const wasActive = botActive;
  botActive = false;
  lbReplaying = true;
  quietMoves = true;
  try {
    for (const u of moves) {
      const mv = uciToSq(u);
      if (!mv || !board[mv.from]) { lbLog('Could not replay ' + u); break; }
      executeMove(mv.from, mv.to, mv.promo);
    }
  } finally {
    quietMoves = false;
    lbReplaying = false;
    botActive = wasActive;
  }
  quietMovesDone();
  // The bot's memory of the game (opening book, explorer) is the move list.
  botMoveHistory = g.local.slice();
  botSanHistory  = gameMovesAlgebraic.slice();
  if (!gameOver) {
    if (turn === g.colorLetter) setTimeout(botMakeMove, 100);
    else botUserTurnStartMs = Date.now();
  }
}

function _lbOnGameState(g, st) {
  if (!g.boardReady) return;
  _lbNoteDrawOffer(g, st);
  const moves = _lbMoves(st), local = g.local;
  // A rebuild is waiting: it will take these moves instead of the ones it has.
  if (g.rebuild) { _lbRequestRebuild(g, moves, st); return; }
  // The server may trail the board by the bot's move in flight, never lead
  // it by more than the opponent's one reply, and must agree on the rest.
  const n = Math.min(moves.length, local.length);
  let agree = true;
  for (let i = 0; i < n; i++) if (moves[i] !== local[i]) { agree = false; break; }
  const fresh = moves.length - local.length;
  if (!agree || fresh > 1) {
    _lbRequestRebuild(g, moves, st, 'Board out of step with Lichess — rebuilding from the server');
    return;
  }
  if (fresh === 1) {
    const u = moves[moves.length - 1];
    const mv = uciToSq(u);
    const p = mv && board[mv.from];
    if (!p || gameOver || p.color !== turn ||
        !legalMovesFor(mv.from, board, epSq, castling).includes(mv.to)) {
      _lbRequestRebuild(g, moves, st, 'Unexpected move ' + u + ' from Lichess — rebuilding');
      return;
    }
    if (p.color === g.colorLetter) _lbApplyServerBotMove(g, u, mv);
    // → botPostMoveHook → the bot replies (or its premove fires)
    else executeMove(mv.from, mv.to, mv.promo);
  }
  _lbAfterState(g, st);
}

// The bot's own move, made somewhere else: the bot account playing in another
// browser, as a tester did to finish a won game by hand (Nov 2026). It used to
// read as "unexpected", and the whole game was rebuilt, while the bot went on
// thinking about a move already played: its move was refused, and the refusal
// rebuilt the game again. Now the bot stops thinking, and the move goes on the
// board as if the bot had played it — with nothing sent back.
function _lbApplyServerBotMove(g, u, mv) {
  _lbCancelBotTurn();
  g.fromServer = true;
  try {
    if (typeof clearGhostPieces === 'function') clearGhostPieces();
    executeMove(mv.from, mv.to, mv.promo);
  } finally {
    g.fromServer = false;
  }
  // As botMakeMove records its own.
  const san = (typeof gameMovesAlgebraic !== 'undefined' && gameMovesAlgebraic[gameMovesAlgebraic.length - 1]) || u;
  if (typeof botRecordMove === 'function') botRecordMove(u, san);
  const ply = g.local.length;
  lbLog(Math.ceil(ply / 2) + (ply % 2 ? '. ' : '... ') + san + '  played for the bot elsewhere');
}

// Stop the bot's work on a turn it will not play. botMakeMove checks
// _botGameGen after every engine wait, so the reply still on its way is
// dropped when it lands; a premove being worked out is dropped the same way.
// The premove's tally for the game is kept (botPremoveReset would clear it).
function _lbCancelBotTurn() {
  _botGameGen++;
  botThinking = false;
  if (typeof botActivePremove !== 'undefined') botActivePremove = null;
  if (typeof _botPremoveGen !== 'undefined') _botPremoveGen++;
  if (typeof botPremoveUpdateBadge === 'function') botPremoveUpdateBadge();
  const s = document.getElementById('botStatus');
  if (s && /Thinking/.test(s.textContent)) s.textContent = '';
}

// Rebuilds come in bursts: the server's move and the refusal of the bot's own
// arrive together, and a stream reopens a moment after a state. Each used to
// rebuild the whole game by itself. Now the first waits LB_REBUILD_SETTLE_MS,
// the bot stops meanwhile (a move it made would be made on the wrong board),
// and the rest only bring it the newest moves: one rebuild, from the latest.
// A game the server says is over is rebuilt at once, for the final position.
const LB_REBUILD_SETTLE_MS = 250;
function _lbRequestRebuild(g, moves, st, why) {
  if (g.rebuild) {
    g.rebuild.moves = moves;
    if (st) g.rebuild.st = st;
  } else {
    if (why) lbLog(why);
    _lbCancelBotTurn();
    g.rebuild = { moves, st: st || null, timer: setTimeout(() => _lbFlushRebuild(g), LB_REBUILD_SETTLE_MS) };
  }
  if (st && st.status && st.status !== 'started' && st.status !== 'created') _lbFlushRebuild(g);
}
function _lbFlushRebuild(g) {
  const r = g.rebuild;
  if (!r) return;
  clearTimeout(r.timer);
  g.rebuild = null;
  if (lbGame !== g || g.ended) return;
  if (!_lbSameMoves(g.local, r.moves)) _lbBeginLocalGame(g, r.moves);
  // Nothing to rebuild after all: the bot was stopped, so it starts again.
  else if (!gameOver && turn === g.colorLetter) setTimeout(botMakeMove, 100);
  if (r.st) _lbAfterState(g, r.st);
}

function _lbAfterState(g, st) {
  if (lbGame !== g || g.ended) return;
  _lbSyncClock(st);
  const ply = _lbMoves(st).length;
  const wasAccepted = g.drawAccepted;
  _lbNoteDrawOffer(g, st);
  if (g.oppDrawOpen && g.drawPly !== ply && !gameOver && typeof botConsiderDrawOffer === 'function') {
    g.drawPly = ply;
    lbLog(_lbWho(g.opponent) + ' offers a draw');
    // Answers through lichessAnswerDraw — now if the bot is free, else just
    // before its move goes out.
    if (!g.drawAnswered) botConsiderDrawOffer();
  }
  // The bot took a draw that the server then did not end the game on (the
  // offer was withdrawn first): it held its move for nothing, so it moves now.
  if (wasAccepted && !g.oppDrawOpen && (!st.status || st.status === 'started')) {
    g.drawAccepted = false;
    if (turn === g.colorLetter && !botThinking && !gameOver) setTimeout(botMakeMove, 100);
  }
  const oppTakeback = g.colorLetter === 'w' ? st.btakeback : st.wtakeback;
  if (oppTakeback && g.takebackPly !== ply) {
    g.takebackPly = ply;
    lbLog('Takeback request declined');
    _lbPost('/api/bot/game/' + g.id + '/takeback/no');
  }
  if (st.status && st.status !== 'started' && st.status !== 'created') _lbFinishGame(g, st);
  else lbRender();
}

// The server's clock is the clock. Its times are as of the last move, so the
// side to move is re-anchored to "now".
function _lbSyncClock(st) {
  if (clockControl !== 'lichess' || typeof st.wtime !== 'number' || typeof st.btime !== 'number') return;
  clockTimeW = Math.max(0, st.wtime / 1000);
  clockTimeB = Math.max(0, st.btime / 1000);
  if (typeof st.winc === 'number') clockInc = st.winc / 1000;
  if (!gameOver) {
    if (clockActive) {
      _clockAnchorMs  = Date.now();
      _clockAnchorSec = turn === 'w' ? clockTimeW : clockTimeB;
    } else if (clockTimeW > 0 && clockTimeB > 0) {
      clockStart();
    }
  }
  clockUpdateDisplay();
  if (typeof botSnapOppClock === 'function') botSnapOppClock();
}

function _lbSendMove(g, uci) {
  const ply = g.local.length - 1;   // where the move stands in the game
  _lbPost('/api/bot/game/' + g.id + '/move/' + uci).then(r => {
    if (r.ok || lbGame !== g || g.ended) return;
    // The server's own move at that ply has already replaced it (another move
    // was played for the bot meanwhile): a rebuild did, or is about to. A
    // resync on top of it was a second rebuild.
    if (g.rebuild || g.local[ply] !== uci) {
      lbLog('Lichess refused ' + uci + ' (' + _lbErr(r) + '): the board already follows the server');
      return;
    }
    lbLog('Lichess refused ' + uci + ' (' + _lbErr(r) + ') — resyncing');
    _lbResync(g);
  });
}

// Reopening the game stream brings a fresh gameFull, which rebuilds the
// board if it disagrees with the server. Reopened at once (_lbGameLoop).
function _lbResync(g) {
  g.resyncNow = true;
  if (g.abort) { try { g.abort.abort(); } catch (e) {} }
}

// Blundermind ends a game on threefold repetition and the fifty-move rule by
// itself; Lichess waits for a claim. Saying yes to a draw is the claim.
//
// The bot claims on the same terms it takes a draw offer (botDecideClaim: the
// Draws setting, its margin, the clock). It used to claim every time, so a bot
// 8 pawns up against a shuffling opponent drew the won game itself (a tester's
// game, Nov 2026). Not claiming costs nothing: the opponent can still claim.
//
// After the bot's own move the opponent is to move, so it decides at once.
// After the opponent's, the bot is about to think; the decision waits for the
// end of that thinking (lichessClaimFirst, from _botAnswerDrawFirst), as the
// answer to a draw offer does, so its look at the position never takes
// Stockfish away from the bot's move. A premove stands aside for it.
function _lbCheckClaims(g, botMoved) {
  if (gameOver) return;
  const ply = g.local.length;
  const rep = (positionCounts[positionKey(board, turn, castling, epSq)] || 0) >= 3;
  const fifty = halfmoveClock >= 100;
  if (!(rep || fifty) || g.claimPly === ply) return;
  g.claimPly = ply;
  g.claimRule = rep ? 'threefold repetition' : 'fifty-move rule';
  // Once this move has been recorded (botRecordMove runs just after), so the
  // look at the position is made with the game's moves.
  if (botMoved) setTimeout(() => { _lbDecideClaim(g, ply); }, 0);
  else g.claimPending = ply;
}

// Decide, and claim if the bot wants the draw. Resolves whether a claim went
// to Lichess. Dropped if the game moved on while the bot was deciding: a yes
// then would be a draw OFFER, not a claim.
async function _lbDecideClaim(g, ply) {
  const rule = g.claimRule || 'repetition';
  let v = { yes: true, why: '' };
  if (typeof botDecideClaim === 'function') {
    try { v = await botDecideClaim(); } catch (e) { v = { yes: true, why: '' }; }
  }
  if (lbGame !== g || g.ended) return false;
  if (g.local.length !== ply) {
    if (v.yes) lbLog('A draw by ' + rule + ' was there to claim, but the game moved on before the bot decided');
    return false;
  }
  if (!v.yes) { lbLog('Not claiming the draw by ' + rule + (v.why ? ': ' + v.why : '')); return false; }
  lbLog('Claiming a draw (' + rule + ')' + (v.why ? ': ' + v.why : ''));
  let r = null;
  try { r = await _lbPost('/api/bot/game/' + g.id + '/draw/yes'); } catch (e) { r = null; }
  if (!r || !r.ok) {
    if (lbGame === g && !g.ended) lbLog('Lichess refused the claim' + (r ? ': ' + _lbErr(r) : ''));
    return false;
  }
  return true;
}

// A claim is waiting on the bot's turn (the opponent's move made it possible).
function lichessClaimAwaiting() {
  const g = lbGame;
  return !!(g && g.boardReady && !g.ended && g.claimPending === g.local.length);
}
// Just before the bot's move goes out: decide a waiting claim. True when the
// game is over and the move must not be played. A valid claim ends the game
// at once; if Lichess does not end it (it did not see the repetition the board
// did), the yes stands as an offer and the bot plays on.
async function lichessClaimFirst() {
  const g = lbGame;
  if (!lichessClaimAwaiting()) return false;
  const ply = g.claimPending;
  g.claimPending = -1;
  if (!(await _lbDecideClaim(g, ply))) return false;
  for (let i = 0; i < 30 && lbGame === g && !g.ended; i++) await _lbSleep(100);
  return lbGame !== g || g.ended;
}

function _lbOnOpponentGone(g, m) {
  clearTimeout(g.goneTimer);
  if (!m.gone) { lbLog(_lbWho(g.opponent) + ' is back'); return; }
  const secs = typeof m.claimWinInSeconds === 'number' ? m.claimWinInSeconds : null;
  if (secs === null) return;
  lbLog(_lbWho(g.opponent) + ' left the game — claiming the win in ' + secs + ' s unless they return');
  g.goneTimer = setTimeout(() => {
    if (lbGame === g && !g.ended) _lbPost('/api/bot/game/' + g.id + '/claim-victory');
  }, secs * 1000 + 500);
}

function _lbFinishGame(g, st) {
  if (g.ended) return;
  g.ended = true;
  clearTimeout(g.goneTimer);
  const msg = _lbResultText(g, st);
  if (g.boardReady) {
    gameOver = true;
    gameOverMsg = msg;
    clockStop();
    updatePlayerBoxes();
    render();
    if (typeof updateActionBtn === 'function') updateActionBtn();
  }
  lbLog('Game over: ' + msg);
  if (g.chatTimer) { clearTimeout(g.chatTimer); g.chatTimer = null; g.chatHeld = null; }
  if (g.abort) { try { g.abort.abort(); } catch (e) {} }
  if (lbGame === g) lbGame = null;
  if (lbWantConnected) _lbSetState('waiting');
  else lbRender();
}

function _lbResultText(g, st) {
  const status = st && st.status, winner = st && st.winner;
  const W = c => c === 'white' ? 'White' : 'Black';
  const loser = winner === 'white' ? 'black' : 'white';
  switch (status) {
    case 'mate':      return W(winner) + ' wins by checkmate';
    case 'resign':    return W(loser) + ' resigned — ' + W(winner) + ' wins';
    case 'stalemate': return 'Stalemate — draw ½-½';
    case 'timeout':   return W(loser) + ' left the game — ' + W(winner) + ' wins';
    case 'outoftime': return winner ? W(loser) + ' ran out of time — ' + W(winner) + ' wins'
                                    : 'Out of time — draw ½-½';
    case 'draw':      return 'Draw ½-½';
    case 'insufficientMaterialClaim': return 'Draw — insufficient material ½-½';
    case 'aborted':   return 'Game aborted';
    case 'noStart':   return 'Game aborted — no first move';
    default:          return status ? 'Game over (' + status + ')' : 'Game over';
  }
}

// ── Text helpers ────────────────────────────────────────────────────────────
function _lbWho(u) {
  if (!u) return 'someone';
  const name = u.name || u.username || u.id || 'someone';
  return (u.title ? u.title + ' ' : '') + name + (u.rating ? ' (' + u.rating + ')' : '');
}
function _lbTcText(secs, inc) {
  const m = secs / 60;
  const base = m >= 1 && Number.isInteger(m) ? String(m)
             : m === 0.25 ? '¼' : m === 0.5 ? '½' : m === 0.75 ? '¾' : (Math.round(m * 10) / 10).toString();
  return base + '+' + inc;
}
function _lbChallengeTc(c) {
  const tc = c.timeControl || {};
  if (tc.type === 'clock') return _lbTcText(tc.limit, tc.increment);
  if (tc.type === 'correspondence') return tc.daysPerTurn + ' days/move';
  return 'no clock';
}

// ── Panel ───────────────────────────────────────────────────────────────────
// Shows what runs: which account, which bot (the one this page is set to),
// what it accepts, the game on the board, and what has happened. It sits over
// the sidebar's game buttons, which are locked while the tab hosts anyway,
// and starts folded on a phone so the board stays in view. It is there only
// while the tab hosts a bot (_lbPanelShown); connecting starts in the builder.
function _lbPanelShown() {
  return lbWantConnected || lichessGameLive() || lbState === 'connecting' || lbState === 'error';
}
function _lbBuildPanel() {
  if (document.getElementById('lbPanel')) return;
  const css = document.createElement('style');
  css.textContent = `
#lbPanel{position:fixed;right:16px;bottom:16px;z-index:5000;width:290px;max-width:calc(100vw - 32px);
  background:var(--bg-panel);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;
  box-shadow:0 6px 24px rgba(0,0,0,0.25);font-size:12px;line-height:1.45;}
#lbPanel .lb-head{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;}
#lbPanel .lb-title{font-weight:700;white-space:nowrap;}
#lbPanel .lb-acct{color:var(--text-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#lbPanel .lb-chev{color:var(--text-dim);font-size:10px;}
#lbPanel .lb-dot{width:9px;height:9px;border-radius:50%;background:#9a948c;flex-shrink:0;}
#lbPanel .lb-dot.connecting{background:#d8a030;} #lbPanel .lb-dot.waiting{background:#2fa35a;}
#lbPanel .lb-dot.playing{background:#4a9fd4;} #lbPanel .lb-dot.error{background:#c03030;}
#lbPanel .lb-body{padding:0 10px 9px;display:flex;flex-direction:column;gap:6px;}
#lbPanel.lb-min .lb-body{display:none;}
#lbPanel .lb-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
#lbPanel .lb-k{color:var(--text-dim);min-width:52px;}
#lbPanel .lb-set{display:none;flex-direction:column;gap:6px;padding:6px 0;border-top:1px solid var(--border2);border-bottom:1px solid var(--border2);}
#lbPanel.lb-edit .lb-set{display:flex;}
#lbPanel input[type=password]{flex:1;min-width:0;font:inherit;padding:4px 6px;border:1px solid var(--border);
  border-radius:4px;background:var(--bg-page);color:var(--text-primary);}
#lbPanel button{font:inherit;padding:3px 9px;border-radius:4px;border:1px solid var(--border);
  background:var(--bg-panel2);color:var(--text-primary);cursor:pointer;}
#lbPanel button.lb-go{background:#2fa35a;border-color:#2fa35a;color:#fff;}
#lbPanel button.lb-stop{background:#c03030;border-color:#c03030;color:#fff;}
#lbPanel label{display:inline-flex;align-items:center;gap:3px;cursor:pointer;}
#lbPanel .lb-note{color:var(--text-secondary);}
#lbPanel .lb-err{color:#c03030;}
#lbPanel .lb-log{font-family:'Courier New',monospace;font-size:10.5px;color:var(--text-secondary);
  max-height:140px;overflow:auto;white-space:pre-wrap;border-top:1px solid var(--border2);padding-top:5px;}
#lbPanel a{color:var(--accent);white-space:nowrap;}
#lbPanel .lb-link{background:none;border:none;padding:0;color:var(--accent);text-decoration:underline;}`;
  document.head.appendChild(css);

  const p = document.createElement('div');
  p.id = 'lbPanel';
  if (window.innerWidth < 700) p.classList.add('lb-min');
  p.innerHTML = `
<div class="lb-head" onclick="lichessToggleMin()">
  <span class="lb-dot" id="lbDot"></span><span class="lb-title">Lichess bot</span>
  <span class="lb-acct" id="lbAcct"></span><span class="lb-chev" id="lbChev"></span>
</div>
<div class="lb-body">
  <div class="lb-row" id="lbStatus"></div>
  <div class="lb-row" id="lbGameRow" style="display:none"></div>
  <div class="lb-row"><span class="lb-k">Plays as</span><span id="lbBot"></span>
    <button class="lb-link" onclick="if(typeof openBotModal==='function')openBotModal()">change</button></div>
  <div class="lb-row"><span class="lb-k">Accepts</span><span id="lbRules"></span>
    <button class="lb-link" id="lbEditBtn" onclick="lichessToggleEdit()">edit</button></div>
  <div class="lb-set">
    <div class="lb-row">
      <label><input type="checkbox" id="lbBots" onchange="lichessSetOpt('bots',this.checked)">Bots</label></div>
    <div class="lb-row">
      <label><input type="checkbox" id="lbSp-bullet" onchange="lichessSetSpeed('bullet',this.checked)">Bullet</label>
      <label><input type="checkbox" id="lbSp-blitz" onchange="lichessSetSpeed('blitz',this.checked)">Blitz</label>
      <label><input type="checkbox" id="lbSp-rapid" onchange="lichessSetSpeed('rapid',this.checked)">Rapid</label>
      <label><input type="checkbox" id="lbSp-classical" onchange="lichessSetSpeed('classical',this.checked)">Classical</label></div>
    <div class="lb-row"><label><input type="checkbox" id="lbAuto" onchange="lichessSetOpt('auto',this.checked)">Reconnect when this page opens</label></div>
  </div>
  <div class="lb-log" id="lbLog"></div>
  <div class="lb-row">
    <button class="lb-go" id="lbConnect" onclick="lichessOpenSetup()">Connect…</button>
    <button id="lbClose" onclick="lichessClosePanel()">Close</button>
    <button class="lb-stop" id="lbDisconnect" onclick="lichessDisconnect()" style="display:none">Disconnect</button>
    <span id="lbGameBtns" style="display:none">
      <button onclick="lichessResignGame()">Resign</button>
      <button onclick="lichessAbortGame()">Abort</button>
    </span>
    <button class="lb-link" id="lbForget" onclick="lichessForgetToken()">forget token</button>
  </div>
</div>`;
  document.body.appendChild(p);
}

// The accept rules in one line, as the challenger would meet them.
function _lbRulesText() {
  const s = lbSettings;
  const speeds = ['bullet', 'blitz', 'rapid', 'classical'].filter(k => s.speeds[k]);
  if (!speeds.length) return 'nothing — every challenge is declined';
  return 'casual only · ' + speeds.join(', ') + (s.bots ? ' · bots too' : ' · no bots');
}

function lbRender() {
  _lbPushState();
  const p = document.getElementById('lbPanel');
  if (!p || !lbSettings) return;
  p.style.display = _lbPanelShown() ? '' : 'none';
  const $ = id => document.getElementById(id);
  const on = lbWantConnected;
  const g = lbGame && lbGame.boardReady ? lbGame : null;
  $('lbDot').className = 'lb-dot ' + lbState;
  $('lbAcct').textContent = lbAccount ? '@' + lbAccount.username
    : (lbSettings.token ? 'token saved' : '');
  $('lbChev').textContent = p.classList.contains('lb-min') ? '▲' : '▼';
  let status = LB_STATUS_TEXT[lbState] || lbState;
  if (lbState === 'waiting' && !_lbEnginesReady()) {
    status = 'Loading engines — challenges are declined until they are ready';
    // Nothing else redraws the panel when they finish, so watch for it. One
    // redraw only: each one also rebuilds the builder's popup, if it's open.
    if (!lbLoadingWatch) lbLoadingWatch = setInterval(() => {
      if (!_lbEnginesReady()) return;
      clearInterval(lbLoadingWatch);
      lbLoadingWatch = null;
      lbRender();
    }, 1000);
  }
  if (g && g.opponent && !g.ended) status = 'Playing ' + _lbWho(g.opponent);
  $('lbStatus').innerHTML = '';
  const s = document.createElement('span');
  s.className = lbState === 'error' ? 'lb-err' : 'lb-note';
  s.textContent = lbState === 'error' ? lbStateNote : status;
  $('lbStatus').appendChild(s);
  const gr = $('lbGameRow');
  if (g) {
    gr.style.display = '';
    gr.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = (g.clock ? _lbTcText(g.clock.initial / 1000, g.clock.increment / 1000) + ' ' : '') +
      (g.rated ? 'rated' : 'casual') + ' · bot is ' + g.color;
    const a = document.createElement('a');
    a.href = _lbApiBase() + '/' + g.id; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'watch on Lichess ↗';
    gr.append(t, a);
  } else {
    gr.style.display = 'none';
  }
  $('lbBot').textContent = ((typeof botGenerateName === 'function') ? botGenerateName() : 'this page\'s bot') +
    (_lbMatching() ? ' · matches each challenger’s rating' : '') +
    (lbNextConfig ? ' — your update plays from the next game' : '');
  $('lbRules').textContent = _lbRulesText();
  // The accept rules fold behind "edit" — connecting sets them in the popup.
  p.classList.toggle('lb-edit', p.dataset.edit === '1');
  $('lbEditBtn').textContent = p.dataset.edit === '1' ? 'done' : 'edit';
  $('lbBots').checked = !!lbSettings.bots;
  $('lbAuto').checked = !!lbSettings.auto;
  ['bullet', 'blitz', 'rapid', 'classical'].forEach(k => { $('lbSp-' + k).checked = !!lbSettings.speeds[k]; });
  // Not connected, the panel is only up to show why connecting failed: try
  // again (the builder's popup) or close it.
  $('lbConnect').style.display = on ? 'none' : '';
  $('lbClose').style.display = on ? 'none' : '';
  $('lbDisconnect').style.display = on ? '' : 'none';
  $('lbForget').style.display = (!on && lbSettings.token) ? '' : 'none';
  $('lbGameBtns').style.display = g && !g.ended ? '' : 'none';
  // The whole log, scrollable. It follows new lines only while it is scrolled
  // to the bottom, so scrolling back to read a move is not yanked away by the
  // next one.
  const logEl = $('lbLog');
  const atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.textContent = lbLogLines.join('\n');
  if (atEnd) logEl.scrollTop = 1e6;
}

function lichessSetOpt(key, val) { lbSettings[key] = !!val; _lbSaveSettings(); lbRender(); }
function lichessSetSpeed(key, val) { lbSettings.speeds[key] = !!val; _lbSaveSettings(); lbRender(); }
function lichessToggleMin() {
  const p = document.getElementById('lbPanel');
  if (p) { p.classList.toggle('lb-min'); lbRender(); }
}
// A failed connect, put away: the tab is an ordinary one again.
function lichessClosePanel() {
  if (lbWantConnected) return;
  _lbMarkHostTab(false);
  _lbSetState('off');
}
function lichessToggleEdit() {
  const p = document.getElementById('lbPanel');
  if (p) { p.dataset.edit = p.dataset.edit === '1' ? '' : '1'; lbRender(); }
}
function lichessResignGame() {
  const g = lbGame;
  if (!g || g.ended || !confirm('Resign this game on Lichess?')) return;
  lbLog('Resigning on Lichess');
  _lbPost('/api/bot/game/' + g.id + '/resign');
}
function lichessAbortGame() {
  const g = lbGame;
  if (!g || g.ended) return;
  lbLog('Asking Lichess to abort (only possible before both sides have moved)');
  _lbPost('/api/bot/game/' + g.id + '/abort').then(r => { if (!r.ok) lbLog('Abort refused: ' + _lbErr(r)); });
}

// ── The Bot Builder's side ──────────────────────────────────────────────────
// The builder (bot-control-panel.html, a same-origin iframe) is where a bot is
// set up, so it is also where a tab becomes that bot's Lichess host: its popup
// checks the token here — and can upgrade a fresh account to a bot account —
// then hands over the bot, the token and the accept rules in one step. While
// the tab hosts, the builder's Start becomes "Update Lichess bot", and the bot
// it sends plays from the NEXT game: a game in progress finishes with the bot
// it started with.
let lbNextConfig = null;      // the builder's update, waiting for the next game

function lichessBuilderState() {
  const s = lbSettings || _lbLoadSettings();
  const g = lbGame && lbGame.boardReady && !lbGame.ended ? lbGame : null;
  return {
    connected: lbWantConnected, state: lbState, note: lbStateNote,
    account: lbAccount ? lbAccount.username : null,
    tokenSaved: !!s.token,
    playing: !!g, opponent: g && g.opponent ? _lbWho(g.opponent) : null,
    nextPending: !!lbNextConfig,
    localGame: !lbWantConnected && typeof _isLiveGame === 'function' && _isLiveGame(),
    settings: { bots: !!s.bots, speeds: Object.assign({}, s.speeds) },
  };
}
// Tell an open builder, so its Lichess pill and Start button say what is true.
function _lbPushState() {
  try {
    const f = document.getElementById('botModalFrame');
    if (f && f.contentWindow) {
      f.contentWindow.postMessage(Object.assign({ type: 'lichessState' }, lichessBuilderState()), location.origin);
    }
  } catch (e) {}
}

// Whose token this is, and whether that account is a bot already or could
// become one — Lichess only upgrades an account that has never played.
// No token given: the one saved in this browser.
async function lichessCheckToken(tok) {
  tok = String(tok || (lbSettings && lbSettings.token) || '').trim();
  if (!tok) return { ok: false, reason: 'empty' };
  let r;
  try { r = await fetch(_lbApiBase() + '/api/account', { headers: { Authorization: 'Bearer ' + tok } }); }
  catch (e) { return { ok: false, reason: 'unreachable' }; }
  if (r.status === 401) return { ok: false, reason: 'badToken' };
  let a = null;
  try { a = await r.json(); } catch (e) {}
  if (!r.ok || !a || !a.id) return { ok: false, reason: 'http', status: r.status };
  const games = a.count && typeof a.count.all === 'number' ? a.count.all : null;
  return { ok: true, username: a.username || a.id, bot: a.title === 'BOT', games };
}

// Permanent, and Lichess's own rules apply (no games played). The builder
// asks twice before calling this.
async function lichessUpgradeAccount(tok) {
  tok = String(tok || (lbSettings && lbSettings.token) || '').trim();
  let r;
  try {
    r = await fetch(_lbApiBase() + '/api/bot/account/upgrade', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok },
    });
  } catch (e) { return { ok: false, error: 'Could not reach Lichess.' }; }
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return r.ok ? { ok: true } : { ok: false, error: (d && d.error) || ('Lichess answered ' + r.status) };
}

// The board panel's Connect opens the same popup the builder's Lichess pill
// does — one place that shows the bot, the account steps and the rules. The
// builder opens only to hold it; Cancel there comes straight back here.
function lichessOpenSetup() {
  if (typeof openBotModal !== 'function') return;
  openBotModal();
  const f = document.getElementById('botModalFrame');
  let tries = 0;
  const go = () => {
    try {
      if (f && f.contentWindow && typeof f.contentWindow.lbcOpen === 'function') {
        f.contentWindow.lbcOpen({ fromBoard: true });
        return;
      }
    } catch (e) {}
    if (++tries < 40) setTimeout(go, 150);
  };
  go();
}

// The builder's Connect: this bot, this token, these rules — then the board.
function lichessConnectFromBuilder(o) {
  o = o || {};
  if (!lbSettings) lbSettings = _lbLoadSettings();
  const st = o.settings || {};
  if ('bots' in st) lbSettings.bots = !!st.bots;
  if (st.speeds) Object.keys(lbSettings.speeds).forEach(k => { if (k in st.speeds) lbSettings.speeds[k] = !!st.speeds[k]; });
  if (o.token) lbSettings.token = String(o.token).trim();
  _lbSaveSettings();
  // The bot the tab hosts, applied and remembered as the page's bot — what
  // Start does, without starting a local game. (Closes the builder.)
  if (o.config) {
    lbNextConfig = null;
    botApplyPanelConfig(Object.assign({}, o.config), true);
    if (typeof bmLastBotSave === 'function') bmLastBotSave();
  }
  _lbMarkHostTab(true);
  lichessOpenPanel();
  if (typeof closeBotModal === 'function') closeBotModal();
  lichessConnect({ confirmed: true });
}

// The builder's "Update Lichess bot" (and its Start, while the tab hosts).
function lichessUpdateBot(cfg) {
  const c = Object.assign({}, cfg);
  delete c._applyOnly;
  // Remembered at once, so a reload hosts the updated bot.
  if (typeof bmLastBotSave === 'function') bmLastBotSave(c);
  if (lichessGameLive()) {
    lbNextConfig = c;
    if (typeof closeBotModal === 'function') closeBotModal();
    lbLog('Bot updated — it plays from the next game');
  } else {
    lbNextConfig = null;
    botApplyPanelConfig(c, true);   // closes the builder
    _lbWarmEngines();
    lbLog('Bot updated');
  }
}

// The address says what the tab is: a reload of a host tab reconnects it
// (start-up, below), and no other Blundermind tab ever does.
function _lbMarkHostTab(on) {
  try {
    const u = new URL(location.href);
    if (on === u.searchParams.has('lichess')) return;
    if (on) u.searchParams.set('lichess', ''); else u.searchParams.delete('lichess');
    const q = u.search.replace(/([?&])lichess=(?=&|$)/, '$1lichess');
    history.replaceState(history.state, '', u.pathname + q + u.hash);
  } catch (e) {}
}

// ── Start-up ────────────────────────────────────────────────────────────────
function lichessOpenPanel() {
  _lbBuildPanel();
  lbRender();
}

document.addEventListener('DOMContentLoaded', () => {
  lbSettings = _lbLoadSettings();
  if (!new URLSearchParams(location.search).has('lichess')) return;
  // A host that reloads (or a headless one starting up) picks up where it was.
  // With nothing to reconnect with, the tab is an ordinary one.
  if (!(lbSettings.auto && lbSettings.token)) { _lbMarkHostTab(false); return; }
  lichessOpenPanel();
  _lbSetState('connecting');
  setTimeout(lichessConnect, 1500);
});

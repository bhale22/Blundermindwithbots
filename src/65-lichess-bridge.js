
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
// The token belongs to the bot account. It lives in this browser's
// localStorage and is sent to lichess.org only — a stand-in test server is
// honoured on a localhost page and nowhere else, so no link can ever point a
// stored token at another host.
//
// Only a page opened with ?lichess shows the panel or connects, so an ordinary
// Blundermind tab never turns into a bot host by itself.

const LB_KEY = 'bm_lichessBot';
const LB_DEFAULTS = {
  token: '', auto: true,
  casual: true, rated: false, bots: false,
  speeds: { bullet: false, blitz: true, rapid: true, classical: true },
};
// Lichess's own order, fastest first — a refusal says which way a speed missed.
const LB_SPEED_ORDER = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const LB_REASON_TEXT = {
  later: 'busy — one game at a time', tooFast: 'too fast', tooSlow: 'too slow',
  timeControl: 'needs a clock', rated: 'only playing rated', casual: 'only playing casual',
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
let lbAccepting = null;       // challenge id accepted, its gameStart not yet here
let lbStarting = false;       // botStart() is running on Lichess's behalf
let lbReplaying = false;      // rebuilding a game from the server's move list
let lbLogLines = [];
let lbQuickCloses = 0;        // event streams that closed right after opening
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
  // The opponent's moves came from the server; only the bot's go back.
  if (piece && piece.color === g.colorLetter) _lbSendMove(g, uci);
  _lbCheckClaims(g);
}

// The bot's answer to a draw offer, or its own offer. On Lichess the server
// ends the game; the board waits for it.
function lichessSendDraw(yes) {
  const g = lbGame;
  if (!g || g.ended) return;
  lbLog(!yes ? 'The bot declines the draw' : g.oppDrawOpen ? 'The bot accepts the draw' : 'The bot offers a draw');
  if (g.oppDrawOpen) { g.drawAnswered = true; g.drawAccepted = !!yes; }
  _lbPost('/api/bot/game/' + g.id + '/draw/' + (yes ? 'yes' : 'no'));
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
  return s;
}
function _lbSaveSettings() {
  try { localStorage.setItem(LB_KEY, JSON.stringify(lbSettings)); } catch (e) {}
}

function lbLog(text) {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  lbLogLines.push(hh + ':' + mm + '  ' + text);
  if (lbLogLines.length > 40) lbLogLines.shift();
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
// server before the draw claim that follows it.
function _lbPost(path, body) {
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
        await _lbSleep(1000);
        continue;
      }
      if (res.status === 429) {
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
  if (!_lbEnginesReady()) { _lbWarmEngines(); return 'later'; }
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
  if (c.rated && !s.rated) return 'casual';
  if (!c.rated && !s.casual) return 'rated';
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
    await _lbPost('/api/challenge/' + c.id + '/decline', 'reason=' + reason);
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
    oppDrawOpen: false, // the opponent's draw offer is standing
    drawAnswered: false, drawAccepted: false,   // the bot's answer to it
    goneTimer: null,
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
    await _lbSleep(backoff);
    backoff = Math.min(backoff * 2, 15000);
  }
}

function _lbOnGameMsg(g, m) {
  if (lbGame !== g || g.ended) return;
  if (m.type === 'gameFull') _lbOnGameFull(g, m);
  else if (m.type === 'gameState') _lbOnGameState(g, m);
  else if (m.type === 'opponentGone') _lbOnOpponentGone(g, m);
  // chatLine: not read.
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
    name: o.name || o.id || (o.aiLevel ? 'Lichess AI level ' + o.aiLevel : 'Anonymous'),
    title: o.title || '', rating: o.rating || null,
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
  const moves = _lbMoves(full.state);
  if (!g.boardReady || !_lbSameMoves(g.local, moves)) _lbBeginLocalGame(g, moves);
  _lbAfterState(g, full.state || {});
}

function _lbSameMoves(a, b) {
  return a.length === b.length && a.every((u, i) => u === b[i]);
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

// Play the server's moves onto the board without the bot answering them.
function _lbReplay(g, moves) {
  const wasActive = botActive;
  botActive = false;
  lbReplaying = true;
  try {
    for (const u of moves) {
      const mv = uciToSq(u);
      if (!mv || !board[mv.from]) { lbLog('Could not replay ' + u); break; }
      executeMove(mv.from, mv.to, mv.promo);
    }
  } finally {
    lbReplaying = false;
    botActive = wasActive;
  }
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
  // The server may trail the board by the bot's move in flight, never lead
  // it by more than the opponent's one reply, and must agree on the rest.
  const n = Math.min(moves.length, local.length);
  let agree = true;
  for (let i = 0; i < n; i++) if (moves[i] !== local[i]) { agree = false; break; }
  const fresh = moves.length - local.length;
  if (!agree || fresh > 1) {
    lbLog('Board out of step with Lichess — rebuilding from the server');
    _lbBeginLocalGame(g, moves);
  } else if (fresh === 1) {
    const u = moves[moves.length - 1];
    const mv = uciToSq(u);
    const p = mv && board[mv.from];
    if (!p || p.color === g.colorLetter || gameOver ||
        !legalMovesFor(mv.from, board, epSq, castling).includes(mv.to)) {
      lbLog('Unexpected move ' + u + ' from Lichess — rebuilding');
      _lbBeginLocalGame(g, moves);
    } else {
      // → botPostMoveHook → the bot replies (or its premove fires)
      executeMove(mv.from, mv.to, mv.promo);
    }
  }
  _lbAfterState(g, st);
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
    // Answers through lichessSendDraw — now if the bot is free, else just
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
  _lbPost('/api/bot/game/' + g.id + '/move/' + uci).then(r => {
    if (r.ok || lbGame !== g || g.ended) return;
    lbLog('Lichess refused ' + uci + ' (' + _lbErr(r) + ') — resyncing');
    _lbResync(g);
  });
}

// Reopening the game stream brings a fresh gameFull, which rebuilds the
// board if it disagrees with the server.
function _lbResync(g) {
  if (g.abort) { try { g.abort.abort(); } catch (e) {} }
}

// Blundermind ends a game on threefold repetition and the fifty-move rule by
// itself; Lichess waits for a claim. Saying yes to a draw is the claim.
function _lbCheckClaims(g) {
  if (gameOver) return;
  const ply = g.local.length;
  const rep = (positionCounts[positionKey(board, turn, castling, epSq)] || 0) >= 3;
  const fifty = halfmoveClock >= 100;
  if ((rep || fifty) && g.claimPly !== ply) {
    g.claimPly = ply;
    lbLog('Claiming a draw (' + (rep ? 'threefold repetition' : 'fifty-move rule') + ')');
    _lbPost('/api/bot/game/' + g.id + '/draw/yes');
  }
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
// and starts folded on a phone so the board stays in view.
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
  max-height:62px;overflow:auto;white-space:pre-wrap;border-top:1px solid var(--border2);padding-top:5px;}
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
      <label><input type="checkbox" id="lbCasual" onchange="lichessSetOpt('casual',this.checked)">Casual</label>
      <label><input type="checkbox" id="lbRated" onchange="lichessSetOpt('rated',this.checked)">Rated</label>
      <label><input type="checkbox" id="lbBots" onchange="lichessSetOpt('bots',this.checked)">Bots</label></div>
    <div class="lb-row">
      <label><input type="checkbox" id="lbSp-bullet" onchange="lichessSetSpeed('bullet',this.checked)">Bullet</label>
      <label><input type="checkbox" id="lbSp-blitz" onchange="lichessSetSpeed('blitz',this.checked)">Blitz</label>
      <label><input type="checkbox" id="lbSp-rapid" onchange="lichessSetSpeed('rapid',this.checked)">Rapid</label>
      <label><input type="checkbox" id="lbSp-classical" onchange="lichessSetSpeed('classical',this.checked)">Classical</label></div>
    <div class="lb-row"><label><input type="checkbox" id="lbAuto" onchange="lichessSetOpt('auto',this.checked)">Reconnect when this page opens</label></div>
  </div>
  <div class="lb-row" id="lbTokenRow">
    <input type="password" id="lbToken" autocomplete="off" spellcheck="false" placeholder="Bot account token (lip_…)">
  </div>
  <div class="lb-log" id="lbLog"></div>
  <div class="lb-row">
    <button class="lb-go" id="lbConnect" onclick="lichessConnect()">Connect</button>
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
  const kinds = [s.casual && 'casual', s.rated && 'rated'].filter(Boolean);
  const speeds = ['bullet', 'blitz', 'rapid', 'classical'].filter(k => s.speeds[k]);
  if (!kinds.length || !speeds.length) return 'nothing — every challenge is declined';
  return kinds.join(' + ') + ' · ' + speeds.join(', ') + (s.bots ? ' · bots too' : ' · no bots');
}

function lbRender() {
  _lbPushState();
  const p = document.getElementById('lbPanel');
  if (!p || !lbSettings) return;
  const $ = id => document.getElementById(id);
  const on = lbWantConnected;
  const g = lbGame && lbGame.boardReady ? lbGame : null;
  $('lbDot').className = 'lb-dot ' + lbState;
  $('lbAcct').textContent = lbAccount ? '@' + lbAccount.username
    : (lbSettings.token ? 'token saved' : '');
  $('lbChev').textContent = p.classList.contains('lb-min') ? '▲' : '▼';
  let status = LB_STATUS_TEXT[lbState] || lbState;
  if (lbState === 'waiting' && !_lbEnginesReady()) status = 'Loading engines — challenges wait until they are ready';
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
    (lbNextConfig ? ' — your update plays from the next game' : '');
  $('lbRules').textContent = _lbRulesText();
  // Disconnected, the settings are what there is to do; connected, they fold.
  p.classList.toggle('lb-edit', !on || p.dataset.edit === '1');
  $('lbEditBtn').style.display = on ? '' : 'none';
  $('lbEditBtn').textContent = p.dataset.edit === '1' ? 'done' : 'edit';
  $('lbCasual').checked = !!lbSettings.casual;
  $('lbRated').checked = !!lbSettings.rated;
  $('lbBots').checked = !!lbSettings.bots;
  $('lbAuto').checked = !!lbSettings.auto;
  ['bullet', 'blitz', 'rapid', 'classical'].forEach(k => { $('lbSp-' + k).checked = !!lbSettings.speeds[k]; });
  $('lbTokenRow').style.display = (!on && !lbSettings.token) ? '' : 'none';
  $('lbConnect').style.display = on ? 'none' : '';
  $('lbDisconnect').style.display = on ? '' : 'none';
  $('lbForget').style.display = (!on && lbSettings.token) ? '' : 'none';
  $('lbGameBtns').style.display = g && !g.ended ? '' : 'none';
  $('lbLog').textContent = lbLogLines.slice(-12).join('\n');
  $('lbLog').scrollTop = 1e6;
}

function lichessSetOpt(key, val) { lbSettings[key] = !!val; _lbSaveSettings(); lbRender(); }
function lichessSetSpeed(key, val) { lbSettings.speeds[key] = !!val; _lbSaveSettings(); lbRender(); }
function lichessToggleMin() {
  const p = document.getElementById('lbPanel');
  if (p) { p.classList.toggle('lb-min'); lbRender(); }
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
    settings: { casual: !!s.casual, rated: !!s.rated, bots: !!s.bots, speeds: Object.assign({}, s.speeds) },
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

// The builder's Connect: this bot, this token, these rules — then the board.
function lichessConnectFromBuilder(o) {
  o = o || {};
  if (!lbSettings) lbSettings = _lbLoadSettings();
  const st = o.settings || {};
  ['casual', 'rated', 'bots'].forEach(k => { if (k in st) lbSettings[k] = !!st[k]; });
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
  lichessOpenPanel();
  // A host that reloads (or a headless one starting up) picks up where it was.
  if (lbSettings.auto && lbSettings.token) setTimeout(lichessConnect, 1500);
});

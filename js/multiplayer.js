// ── multiplayer.js ────────────────────────────────────────────────────────────
// WebSocket room system: lobby, private rooms, game flow, time controls.
// Reads/writes globals: mpRoomId, mpRole, mpWs, mpConnected, mpOriginalRole,
//   mpGameCount, mpMode, mpSelectedTC, mpBaseMin, mpIncSec, mpRatingRange,
//   gameOver, gameOverMsg, turn, boardFlipped, activePremove.
// Calls globals: render, updatePlayerBoxes, resetGame, clockInit, clockStart,
//   chatShow, chatAppend, openPanel, closeAllPanels, landingDismiss,
//   executeMove, tryFirePremove, showRematchBtn, promotionPending.
// ─────────────────────────────────────────────────────────────────────────────

// ── Panel flow helpers ────────────────────────────────────────────────────────
function mpSetMode(mode) {
  mpMode = mode;
  const lobbyInfo  = document.getElementById('mpLobbyInfoBlock');
  const joinBlock  = document.getElementById('mpJoinBlock');
  const inviteRow  = document.getElementById('mpInviteRow');
  const actionBtns = document.getElementById('mpActionBtns');
  const leaveRow   = document.getElementById('mpLeaveRow');
  if (lobbyInfo)  lobbyInfo.style.display  = 'none';
  if (joinBlock)  joinBlock.style.display  = 'none';
  if (inviteRow)  inviteRow.style.display  = 'none';
  if (actionBtns) actionBtns.style.display = '';
  if (leaveRow)   leaveRow.style.display   = 'none';
  if (mode === 'lobby-form') {
    if (lobbyInfo) lobbyInfo.style.display = '';
  } else if (mode === 'join') {
    if (joinBlock) joinBlock.style.display = '';
  } else if (mode === 'private-waiting' || mode === 'lobby-waiting') {
    if (inviteRow)  inviteRow.style.display  = '';
    if (actionBtns) actionBtns.style.display = 'none';
    if (leaveRow)   leaveRow.style.display   = '';
  } else if (mode === 'ingame') {
    if (actionBtns) actionBtns.style.display = 'none';
    if (leaveRow)   leaveRow.style.display   = '';
  }
}

function mpStartPrivateFlow() { mpCreatePrivate(); }

function mpStartJoinFlow() {
  mpSetMode('join');
  mpShowStatus('Enter the code your friend shared with you.');
  mpRefreshLobby();
}

function mpStartLobbyFlow() {
  if (mpMode === 'lobby-form') {
    mpPostChallenge();
  } else {
    mpSetMode('lobby-form');
    mpShowStatus('Fill in your info below (optional), then click Post again to go live.');
    const btns = document.querySelectorAll('#mpActionBtns .mp-action-btn');
    if (btns[2]) btns[2].textContent = '✓ Confirm & Post Challenge';
    mpRefreshLobby();
  }
}

function mpSwitchTab() {}

// ── WebSocket connection ──────────────────────────────────────────────────────
function getWsUrl() {
  return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
}

function mpConnect(onOpen) {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) { onOpen(); return; }
  if (mpWs) { try { mpWs.close(); } catch(e){} mpWs = null; }
  mpShowStatus('Connecting…');
  try { mpWs = new WebSocket(getWsUrl()); }
  catch(e) { mpShowStatus('⚠ Cannot connect — requires the deployed server.', true); return; }
  mpWs.onopen  = () => { mpConnected = true; onOpen(); };
  mpWs.onclose = () => {
    mpConnected = false;
    clearInterval(mpLobbyRefreshTimer);
    mpShowStatus(mpRoomId ? 'Connection lost. Reload to reconnect.' : '⚠ Server not reachable — multiplayer needs the deployed server.', true);
  };
  mpWs.onerror = () => mpShowStatus('⚠ Connection error.', true);
  mpWs.onmessage = evt => { let msg; try { msg = JSON.parse(evt.data); } catch { return; } mpHandleMessage(msg); };
}

// ── Message handler ───────────────────────────────────────────────────────────
function mpHandleMessage(msg) {
  switch (msg.type) {
    case 'created':
      mpRoomId = msg.code; mpRole = msg.role;
      const inviteUrl = location.origin + location.pathname + '?join=' + msg.code;
      const linkEl = document.getElementById('mpInviteLink');
      if (linkEl) linkEl.value = inviteUrl;
      document.getElementById('mpRoomCode').textContent = msg.code;
      mpSetMode(msg.lobby ? 'lobby-waiting' : 'private-waiting');
      mpShowStatus(msg.lobby ? '⏳ Challenge posted! Waiting for someone to accept…' : '⏳ Private room ready — share the link or code with your opponent…');
      break;

    case 'joined':
      mpRoomId = msg.code; mpRole = msg.role;
      mpGameCount = 0; mpOriginalRole = msg.role;
      if (msg.tcBaseMin !== undefined) { mpBaseMin = msg.tcBaseMin; mpIncSec = msg.tcIncSec || 0; mpUpdateTCDisplay(); }
      mpSetMode('ingame');
      mpShowStatus('✓ Joined as Black. Starting…');
      mpStartGame(mpSelectedTC);
      break;

    case 'opponent_joined':
      mpGameCount = 0; mpOriginalRole = mpRole;
      if (msg.tcBaseMin !== undefined) { mpBaseMin = msg.tcBaseMin; mpIncSec = msg.tcIncSec || 0; mpUpdateTCDisplay(); }
      mpSetMode('ingame');
      mpShowStatus('✓ Opponent joined! You are White ♔');
      mpStartGame(mpSelectedTC);
      break;

    case 'lobby_list': mpRenderLobby(msg.challenges || []); break;
    case 'move':       mpReceiveMove(msg.move); break;
    case 'chat':       chatAppend('Opponent', msg.text || '', false); break;

    case 'resign':
      gameOver = true; gameOverMsg = 'Opponent resigned — You win! 🏆';
      updatePlayerBoxes(); render(); showRematchBtn(true);
      break;

    case 'timeout':
      gameOver = true;
      const oppColor = mpRole === 'white' ? 'b' : 'w';
      gameOverMsg = oppColor === 'w' ? 'White ran out of time — Black wins! ⏰' : 'Black ran out of time — White wins! ⏰';
      updatePlayerBoxes(); render(); showRematchBtn(true);
      break;

    case 'rematch_offer':
      const status = document.getElementById('mpStatus');
      if (status) {
        status.innerHTML = 'Opponent wants a rematch! &nbsp;' +
          '<button onclick="mpAcceptRematch()" style="padding:2px 8px;font-size:9px;background:rgba(34,168,90,0.15);border:0.5px solid #22a85a;border-radius:3px;color:#5ad490;cursor:pointer;margin-right:4px;">Accept</button>' +
          '<button onclick="mpDeclineRematch()" style="padding:2px 8px;font-size:9px;background:rgba(200,40,40,0.08);border:0.5px solid rgba(200,40,40,0.3);border-radius:3px;color:#c84040;cursor:pointer;">Decline</button>';
      }
      break;

    case 'rematch':
      mpRole = mpOriginalRole || mpRole;
      mpStartGame(mpSelectedTC);
      mpShowStatus('Rematch! ' + (mpRole === 'white' ? 'You are White ♔' : 'You are Black ♚'));
      break;

    case 'rematch_declined': mpShowStatus('Rematch declined. Thanks for playing!'); break;
    case 'opponent_disconnected': mpShowStatus('Opponent disconnected.', true); gameOver = true; updatePlayerBoxes(); break;
    case 'error': mpShowStatus(msg.message, true); break;
  }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function mpRefreshLobby() {
  mpConnect(() => { if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type: 'lobby_list' })); });
}

function mpPostChallenge() {
  const nameEl = document.getElementById('mpLobbyName'), ratingEl = document.getElementById('mpLobbyRating');
  const name = (nameEl && nameEl.value.trim()) || 'Anonymous';
  const rating = (ratingEl && ratingEl.value.trim()) ? parseInt(ratingEl.value) : null;
  const tcLabel = mpBaseMin === 0 ? 'Untimed' : mpBaseMin + '+' + mpIncSec;
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN)
      mpWs.send(JSON.stringify({ type:'create', lobby:true, tc:mpSelectedTC, tcLabel, tcBaseMin:mpBaseMin, tcIncSec:mpIncSec, name, rating, ratingRange:mpRatingRange }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

function mpRenderLobby(challenges) {
  const list = document.getElementById('mpLobbyList'), empty = document.getElementById('mpLobbyEmpty'), count = document.getElementById('mpLobbyCount');
  if (!list) return;
  Array.from(list.querySelectorAll('.mp-challenge-row')).forEach(el => el.remove());
  if (challenges.length === 0) { if (empty) empty.style.display=''; if (count) count.textContent=''; return; }
  if (empty) empty.style.display = 'none';
  if (count) count.textContent = '(' + challenges.length + ')';
  challenges.forEach(ch => {
    const tcLabel = ch.tcLabel || (ch.tc && TIME_CONTROLS[ch.tc] ? TIME_CONTROLS[ch.tc].label : 'Untimed');
    const row = document.createElement('div');
    row.className = 'mp-challenge-row';
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-panel2);border:0.5px solid var(--border2);border-radius:5px;';
    row.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:9px;font-weight:600;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          (ch.name||'Anonymous') + (ch.rating?' · '+ch.rating:'') + (ch.ratingRange&&ch.ratingRange<9999?' ±'+ch.ratingRange:'') +
        '</div><div style="font-size:8px;color:var(--text-dim);">⏱ ' + tcLabel + '</div></div>' +
      '<button onclick="mpAcceptLobbyChallenge(\'' + ch.code + '\')" style="padding:4px 12px;font-size:9px;font-weight:700;background:rgba(34,168,90,0.15);border:0.5px solid #22a85a;border-radius:4px;color:#5ad490;cursor:pointer;flex-shrink:0;">Join</button>';
    list.appendChild(row);
  });
}

function mpAcceptLobbyChallenge(code) {
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'join', code }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

// ── Private game ──────────────────────────────────────────────────────────────
function mpCreatePrivate() {
  const tcLabel = mpBaseMin === 0 ? 'Untimed' : mpBaseMin + '+' + mpIncSec;
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN)
      mpWs.send(JSON.stringify({ type:'create', lobby:false, tc:mpSelectedTC, tcLabel, tcBaseMin:mpBaseMin, tcIncSec:mpIncSec }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

function mpCopyLink() {
  const link = document.getElementById('mpInviteLink'); if (!link) return;
  navigator.clipboard.writeText(link.value).then(() => {
    const btn = document.getElementById('mpCopyLinkBtn');
    if (btn) { btn.textContent='✓ Copied!'; setTimeout(()=>btn.textContent='Copy',2000); }
  }).catch(() => { link.select(); document.execCommand('copy'); });
}

function mpShareDiscord() {
  const link = document.getElementById('mpInviteLink'); if (!link) return;
  navigator.clipboard.writeText('♟ Join my Blundermind game: ' + link.value).then(() => mpShowStatus('Discord message copied — paste it in a DM!'));
}

function mpShareText() {
  const link = document.getElementById('mpInviteLink'); if (!link) return;
  if (navigator.share) navigator.share({ title:'Blundermind chess', text:'♟ Join my game:', url:link.value });
  else navigator.clipboard.writeText(link.value).then(() => mpShowStatus('Link copied — paste it in a message!'));
}

function mpCheckInviteUrl() {
  const code = new URLSearchParams(location.search).get('join');
  if (!code) return;
  history.replaceState({}, '', location.pathname);
  landingDismiss();
  setTimeout(() => {
    openPanel('mpPanel');
    mpSetMode('join');
    const joinEl = document.getElementById('mpJoinCode');
    if (joinEl) joinEl.value = code.toUpperCase();
    mpShowStatus('Joining from invite link…');
    mpConnect(() => {
      if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'join', code:code.toUpperCase() }));
      else mpShowStatus('Connection failed — try again', true);
    });
  }, 350);
}

// ── Core join / leave ─────────────────────────────────────────────────────────
function mpJoinRoom() {
  const code = document.getElementById('mpJoinCode').value.trim().toUpperCase();
  if (!code) { mpShowStatus('Enter a room code', true); return; }
  mpConnect(() => {
    if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'join', code }));
    else mpShowStatus('Connection failed — try again', true);
  });
}

function mpCreateRoom() { mpCreatePrivate(); }

function mpLeave() {
  if (mpWs) { mpWs.close(); mpWs = null; }
  mpRoomId=null; mpRole=null; mpConnected=false; mpOriginalRole=null; mpGameCount=0;
  clearInterval(mpLobbyRefreshTimer);
  chatShow(false);
  const cm = document.getElementById('chatMessages'); if (cm) cm.innerHTML='';
  const boardCol = document.querySelector('.board-col') || document.getElementById('boardCol');
  if (boardCol) boardCol.classList.remove('board-flipped');
  document.getElementById('mpRoomCode').textContent='';
  const jc = document.getElementById('mpJoinCode'); if (jc) jc.value='';
  mpShowStatus('');
  mpSetMode('idle');
  const btns = document.querySelectorAll('#mpActionBtns .mp-action-btn');
  if (btns[2]) btns[2].textContent='🌐 Post Open Challenge to Lobby';
  resetGame();
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function mpStartGame(tcKey) {
  mpGameCount++;
  const swap = (mpGameCount % 2 === 0);
  mpRole = swap ? (mpRole==='white'?'black':'white') : mpRole;
  resetGame();
  const tc = tcKey || mpSelectedTC || 'untimed';
  clockInit(tc);
  chatShow(true);
  boardFlipped = (mpRole === 'black');
  render();
  if (tc !== 'untimed') clockStart();
  updatePlayerBoxes();
  mpUpdateTurnIndicator();
  closeAllPanels();
}

function mpUpdateTurnIndicator() {
  if (!mpRoomId) return;
  const myTurn = (turn==='w'&&mpRole==='white') || (turn==='b'&&mpRole==='black');
  mpShowStatus(myTurn ? '▶ Your turn' : "⏳ Opponent's turn…");
  updatePlayerBoxes();
}

function mpSendMove(from, to, promo) {
  if (!mpWs || mpWs.readyState !== WebSocket.OPEN) return;
  mpWs.send(JSON.stringify({ type:'move', move:{from,to,promo} }));
}

function mpReceiveMove(move) {
  if (promotionPending) { setTimeout(()=>mpReceiveMove(move), 300); return; }
  executeMove(move.from, move.to, move.promo||null);
  mpUpdateTurnIndicator();
  if (activePremove) setTimeout(tryFirePremove, 50);
}

function mpIsMyTurn() {
  if (!mpRoomId) return true;
  return (turn==='w'&&mpRole==='white') || (turn==='b'&&mpRole==='black');
}

function mpShowStatus(msg, isError) {
  const el = document.getElementById('mpStatus');
  if (el) { el.textContent=msg; el.style.color=isError?'#c03030':'var(--text-secondary)'; }
}

// ── Time control selectors ────────────────────────────────────────────────────
function mpSetBase(min) {
  mpBaseMin = min;
  document.querySelectorAll('[id^="mpbase-"]').forEach(b=>b.classList.remove('tc-active'));
  const btn = document.getElementById('mpbase-'+min); if (btn) btn.classList.add('tc-active');
  mpUpdateTCDisplay();
}

function mpSetInc(sec) {
  mpIncSec = sec;
  document.querySelectorAll('[id^="mpinc-"]').forEach(b=>b.classList.remove('tc-active'));
  const btn = document.getElementById('mpinc-'+sec); if (btn) btn.classList.add('tc-active');
  mpUpdateTCDisplay();
}

function mpUpdateTCDisplay() {
  const disp = document.getElementById('mpTCDisplay');
  if (disp) disp.textContent = mpBaseMin===0 ? 'Untimed' : mpBaseMin+' min + '+mpIncSec+' sec';
  TIME_CONTROLS.custom = { label:mpBaseMin===0?'Untimed':mpBaseMin+'+'+mpIncSec, time:mpBaseMin*60, inc:mpIncSec };
  mpSelectedTC = mpBaseMin===0 ? 'untimed' : 'custom';
}

function mpSetTC(key) {
  const map = {untimed:{min:0,inc:0},bullet:{min:1,inc:0},blitz3:{min:3,inc:2},blitz5:{min:5,inc:0},rapid10:{min:10,inc:0},rapid15:{min:15,inc:10},tournament:{min:30,inc:0}};
  const m = map[key]||{min:0,inc:0}; mpSetBase(m.min); mpSetInc(m.inc);
}

function mpSetRatingRange(r) {
  mpRatingRange = r;
  document.querySelectorAll('[id^="mprange-"]').forEach(b=>b.classList.remove('tc-active'));
  const btn = document.getElementById('mprange-'+r); if (btn) btn.classList.add('tc-active');
}

// ── Rematch ───────────────────────────────────────────────────────────────────
function mpAcceptRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'rematch' }));
}

function mpDeclineRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'rematch_declined' }));
  mpShowStatus('Rematch declined.');
}

function mpOfferRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) mpWs.send(JSON.stringify({ type:'rematch_offer' }));
  mpShowStatus('Rematch offer sent…');
}

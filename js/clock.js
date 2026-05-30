// ── clock.js ──────────────────────────────────────────────────────────────────
// Clock/timer system. Reads/writes globals: clockActive, clockTimeW, clockTimeB,
// clockInc, clockControl, clockInterval, gameOver, gameOverMsg, turn.
// Calls globals: render, updatePlayerBoxes, showRematchBtn.
// ─────────────────────────────────────────────────────────────────────────────

function clockInit(controlKey) {
  clockStop();
  clockControl = controlKey || 'untimed';
  const tc = TIME_CONTROLS[clockControl] || TIME_CONTROLS.untimed;
  clockTimeW = tc.time;
  clockTimeB = tc.time;
  clockInc   = tc.inc;
  clockActive = false;
  clockUpdateDisplay();
}

function clockStart() {
  if (!clockActive && clockTimeW > 0 && clockTimeB > 0 && !gameOver) {
    clockActive = true;
    clockTick();
  }
}

function clockStop() {
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  clockActive = false;
}

function clockTick() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    if (!clockActive || gameOver) { clockStop(); return; }
    if (turn === 'w') {
      clockTimeW = Math.max(0, clockTimeW - 1);
      if (clockTimeW === 0) { clockStop(); clockTimeout('w'); return; }
    } else {
      clockTimeB = Math.max(0, clockTimeB - 1);
      if (clockTimeB === 0) { clockStop(); clockTimeout('b'); return; }
    }
    clockUpdateDisplay();
  }, 1000);
}

function clockAfterMove() {
  // Add increment to the player who just moved (turn has already switched)
  const justMoved = turn === 'w' ? 'b' : 'w';
  if (clockInc > 0) {
    if (justMoved === 'w') clockTimeW = Math.min(clockTimeW + clockInc, 9999);
    else                   clockTimeB = Math.min(clockTimeB + clockInc, 9999);
  }
  if (!clockActive && clockControl !== 'untimed' && !gameOver) clockStart();
  clockUpdateDisplay();
}

function clockTimeout(color) {
  gameOver = true;
  gameOverMsg = color === 'w'
    ? 'White ran out of time — Black wins! ⏰'
    : 'Black ran out of time — White wins! ⏰';
  updatePlayerBoxes();
  render();
  showRematchBtn(true);
  if (typeof mpRoomId !== 'undefined' && mpRoomId && typeof mpWs !== 'undefined' && mpWs) {
    try { mpWs.send(JSON.stringify({ type: 'timeout', color })); } catch(e) {}
  }
}

function clockFmtTime(secs) {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function clockUpdateDisplay() {
  const tc = TIME_CONTROLS[clockControl];
  const isUntimed = !tc || tc.time === 0;
  const twEl = document.getElementById('timeW');
  const tbEl = document.getElementById('timeB');
  if (twEl) {
    twEl.textContent = isUntimed ? '—' : clockFmtTime(clockTimeW);
    twEl.className = 'player-time' + (turn==='w'&&clockActive&&!isUntimed?' active':isUntimed?' solo':'');
    twEl.style.color = (clockTimeW < 30 && clockActive && turn==='w' && !isUntimed) ? '#e03535' : '';
  }
  if (tbEl) {
    tbEl.textContent = isUntimed ? '—' : clockFmtTime(clockTimeB);
    tbEl.className = 'player-time' + (turn==='b'&&clockActive&&!isUntimed?' active':isUntimed?' solo':'');
    tbEl.style.color = (clockTimeB < 30 && clockActive && turn==='b' && !isUntimed) ? '#e03535' : '';
  }
}

function clockSetControl(key) {
  clockControl = key;
  clockInit(key);
  const panel = document.getElementById('clockPanel');
  if (panel) panel.style.display = 'none';
}

function toggleClockPanel() {
  const p = document.getElementById('clockPanel');
  if (p) p.style.display = (p.style.display === 'none' ? 'block' : 'none');
  Object.keys(TIME_CONTROLS).forEach(k => {
    const btn = document.getElementById('tc-' + k);
    if (btn) btn.classList.toggle('active', k === clockControl);
  });
}

// Returns remaining clock in milliseconds for the bot's color
function botClockMs() {
  if (clockControl === 'untimed') return null;
  const color = (typeof botPlayerColor !== 'undefined') ? botPlayerColor : 'white';
  return (color === 'white' ? clockTimeW : clockTimeB) * 1000;
}

// Fraction of clock remaining (1.0 = full, 0.0 = flagged)
function botFracRemaining() {
  const ms = botClockMs();
  if (ms === null || !botStartClockMs) return 1.0;
  return Math.max(0, Math.min(1, ms / botStartClockMs));
}

// Snapshot the opponent's clock in ms (called after each move)
function botSnapOppClock() {
  if (clockControl === 'untimed') { botOppClockMs = null; return; }
  const color = (typeof botPlayerColor !== 'undefined') ? botPlayerColor : 'white';
  const oppSecs = color === 'white' ? clockTimeB : clockTimeW;
  botOppClockMs = oppSecs * 1000;
}

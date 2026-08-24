let _audioCtx=null;
function _getAudioCtx(){if(!_audioCtx)_audioCtx=new(window.AudioContext||window.webkitAudioContext)();return _audioCtx;}
function playMoveSound(isCapture){
  const el=document.getElementById('cbSound');if(!el||!el.checked)return;
  try{
    const ctx=_getAudioCtx();const t=ctx.currentTime;
    const osc=ctx.createOscillator();const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    if(isCapture){
      // Capture: two quick descending tones
      osc.type='sine';
      osc.frequency.setValueAtTime(520,t);
      osc.frequency.exponentialRampToValueAtTime(260,t+0.12);
      gain.gain.setValueAtTime(0.18,t);
      gain.gain.exponentialRampToValueAtTime(0.001,t+0.18);
      osc.start(t);osc.stop(t+0.18);
    } else {
      // Normal move: soft click
      osc.type='sine';
      osc.frequency.setValueAtTime(440,t);
      osc.frequency.exponentialRampToValueAtTime(300,t+0.08);
      gain.gain.setValueAtTime(0.12,t);
      gain.gain.exponentialRampToValueAtTime(0.001,t+0.1);
      osc.start(t);osc.stop(t+0.1);
    }
  }catch(e){}
}
function saveSoundPref(){const el=document.getElementById('cbSound');if(el)localStorage.setItem('bm_sound',el.checked?'1':'0');}
function loadSoundPref(){const v=localStorage.getItem('bm_sound');const el=document.getElementById('cbSound');if(el&&v!==null)el.checked=(v==='1');}

// ── Board-vision settings drawer (phones only) ──────────────────────────────
// These controls sit between the board and the game buttons. At desktop widths
// that's a sidebar; stacked on a phone it's ~450px of configuration pushing the
// board off screen, so there it collapses behind a toggle. The wrapper is
// display:contents above the breakpoint, so this only ever does anything on
// narrow viewports. Choice is remembered — someone who opens it to set up
// their indicators shouldn't have to reopen it every move.
function toggleBoardSettings(){
  const box = document.getElementById('board-settings');
  const btn = document.getElementById('bv-toggle');
  if(!box || !btn) return;
  const open = !box.classList.contains('open');
  box.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  try{ localStorage.setItem('bm_bvOpen', open ? '1' : '0'); }catch(e){}
}
// The nine secondary overlays used to live behind a disclosure here. They are
// shown outright now: the sidebar had ~500px of unused height on a laptop, so
// the fold saved nothing, and opening it shifted every control below it by
// 237px. toggleMoreVis()/loadMoreVisPref() went with it.

function loadBoardSettingsPref(){
  const box = document.getElementById('board-settings');
  const btn = document.getElementById('bv-toggle');
  if(!box || !btn) return;
  let open = false;
  try{ open = localStorage.getItem('bm_bvOpen') === '1'; }catch(e){}
  box.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ── Draw-rule tracking (threefold repetition + fifty-move rule) ──────────────
let positionCounts = {};   // positionKey → times this position has occurred
let halfmoveClock  = 0;    // plies since the last pawn move or capture

function executeMove(from,to,promo){
  const p=board[from];if(!p)return;
  // Snapshot the pre-move position for the Maia move-distribution panel.
  if(typeof distCapturePreMove==='function') distCapturePreMove(from,to,promo);
  // Detect capture before board is modified (includes en passant)
  const isCapture=!!(board[to]||(p.piece==='P'&&to===epSq));
  const isPawnMove=p.piece==='P';
  // Record move in algebraic notation before applying
  try{ gameMovesAlgebraic.push(moveToSAN(from,to,promo,board,epSq,castling)); }catch(e){}
  const newEP=computeEP(from,to,board);
  board=applyMove(from,to,board,epSq,promo||'Q');
  castling=updateCastling(from,to,p,castling);
  epSq=newEP;turn=turn==='w'?'b':'w';
  atkMap=buildAtk(board);
  // Recompute pinned squares for rendering
  const _pins=computePins(board);pinnedWSquares=_pins.w;pinnedBSquares=_pins.b;
  lastMoveFrom=from; lastMoveTo=to; // record for last-move highlight
  playMoveSound(isCapture);
  // ── Input state ───────────────────────────────────────────────────────────
  // The OPPONENT moving must not tear a piece out of the player's hand.
  //
  // This line used to clear selSq/legalMoves/dragFrom/dragMoved for every move,
  // the opponent's included. Composing a premove means holding a piece during
  // the opponent's turn, so the bot's reply landing mid-compose wiped the drag:
  // the drop then arrived with dragFrom = -1 and legalMoves = [], every branch
  // of mouseup missed, and the piece snapped home — discarding a move that was
  // legal in the position that had just arrived. A short think time makes the
  // reply land inside the compose window nearly every time, which is why this
  // read as "Maia at 1 s won't let me select" while Stockfish (which replies
  // before the second interaction even starts) looked fine.
  const _heldSq = dragFrom>=0 ? dragFrom : selSq;
  const _ourMove = (typeof playerColor!=='function') || p.color===playerColor();
  // Keep it only if the same piece is still ours and still standing there —
  // the opponent may have just captured it or moved onto its square.
  const _keepHeld = !_ourMove && _heldSq>=0 && board[_heldSq]
                 && board[_heldSq].color===playerColor();
  if(_keepHeld){
    const _wasDrag=dragFrom>=0, _wasMoved=dragMoved;
    // The set it was picked up with was premoveDests — speculative by design.
    // The position it guessed at now exists, so re-derive it for real.
    clearPreview();
    legalMoves=legalMovesFor(_heldSq,board,epSq,castling);
    startPreview(_heldSq,_heldSq);   // clears selSq; restored just below
    selSq=_heldSq;
    dragFrom=_wasDrag?_heldSq:-1;
    dragMoved=_wasMoved;
  }else{
    selSq=-1;legalMoves=[];clearPreview();hoverSq=-1;dragFrom=-1;dragMoved=false;
  }
  // Draw-rule bookkeeping
  halfmoveClock=(isCapture||isPawnMove)?0:halfmoveClock+1;
  const _pk=positionKey(board,turn,castling,epSq);
  positionCounts[_pk]=(positionCounts[_pk]||0)+1;
  const allMoves=allLegalMoves(board,turn,epSq,castling);
  if(allMoves.length===0){
    const chk=inCheck(board,turn);
    gameOver=true;
    gameOverMsg=chk?
      (turn==='w'?'Checkmate — Black wins! ♛':'Checkmate — White wins! ♔'):
      'Stalemate — Draw! ½-½';
    // Show rematch button
    showRematchBtn(true);
  } else if(positionCounts[_pk]>=3){
    gameOver=true;gameOverMsg='Draw by threefold repetition ½-½';showRematchBtn(true);
  } else if(halfmoveClock>=100){
    gameOver=true;gameOverMsg='Draw by fifty-move rule ½-½';showRematchBtn(true);
  } else if(isInsufficientMaterial(board)){
    gameOver=true;gameOverMsg='Draw — insufficient material ½-½';showRematchBtn(true);
  }
  updatePlayerBoxes();
  if(typeof clockAfterMove==='function') clockAfterMove();
  if(typeof IND!=='undefined'&&typeof indApply==='function')indApply();
  else render();
  // Bot post-move hook (safe — function defined later in script)
  if(typeof botPostMoveHook==='function') botPostMoveHook();
  // Refresh the Maia move-distribution panel (if open) for the move just played.
  if(typeof distOnMoveComplete==='function') distOnMoveComplete();
}

// ── Premove helpers ─────────────────────────────────────────────────────
function hasPremove(){return premoveQueue.length>0;}

// The board as it will stand once every queued premove has played — the
// position the NEXT premove is composed against. Only our own moves are
// applied; the opponent's replies are unknown, so their pieces stay put.
// Passing ep = -1 is deliberate: an en-passant right created by one of our own
// queued moves cannot survive the opponent's reply in between.
function premoveSpecState(){
  let bd=board,cst=castling;
  for(const pm of premoveQueue){
    const p=bd[pm.from];
    if(!p)break;                     // chain already broken; stop where it does
    cst=updateCastling(pm.from,pm.to,p,cst);
    bd=applyMove(pm.from,pm.to,bd,-1,pm.promo||'Q');
  }
  return{board:bd,castling:cst};
}

// Squares touched by the queue → how to paint them, and which link they are.
function premoveSquareMap(){
  const m=new Map();
  premoveQueue.forEach((pm,i)=>{
    if(!m.has(pm.from))m.set(pm.from,{kind:'from',n:i+1});
    m.set(pm.to,{kind:'to',n:i+1});
  });
  return m;
}

function queuePremove(from,to,promo){
  if(premoveQueue.length>=PREMOVE_MAX)return false;
  premoveQueue.push({from,to,promo:promo||null});
  selSq=-1;legalMoves=[];dragFrom=-1;dragMoved=false;
  setAwaitingConfirm(false);clearPreview();
  atkMap=buildAtk(board);render();
  return true;
}

// Clearing is all-or-nothing. A chain is planned as a whole: the moves after a
// discarded link were composed against a board that will never exist, so
// keeping them would play something the user never actually intended.
function cancelPremove(){
  if(!premoveQueue.length)return;
  premoveQueue=[];
  selSq=-1;legalMoves=[];dragFrom=-1;dragMoved=false;setAwaitingConfirm(false);
  clearPreview();atkMap=buildAtk(board);render();
}

// Fires exactly ONE link per opponent reply, then leaves the rest queued.
function tryFirePremove(){
  if(!premoveQueue.length)return;
  const{from,to,promo}=premoveQueue.shift();
  const abort=()=>{
    premoveQueue=[];
    selSq=-1;legalMoves=[];clearPreview();atkMap=buildAtk(board);render();
  };
  // Now the position exists, so validate for real — against the true board,
  // never the speculative one it was composed on.
  const p=board[from];
  if(!p||p.color!==playerColor())return abort();
  if(!legalMovesFor(from,board,epSq,castling).includes(to))return abort();
  // Pawn reaching back rank with no promo choice: auto-queen
  const resolvedPromo=promo||(p.piece==='P'&&(Math.floor(to/8)===0||Math.floor(to/8)===7)?'Q':null);
  executeMove(from,to,resolvedPromo);
  // Send after execute so clock state is current post-increment.
  // Only inside a real game. A posted-but-unaccepted challenge also has a room,
  // and relaying idle exploration into it corrupts the history the server keeps
  // for reconnects.
  if(typeof mpSendMove==='function'&&typeof mpInGame==='function'&&mpInGame()){
    mpSendMove(from,to,resolvedPromo||null);
  }
  if(typeof mpUpdateTurnIndicator==='function'&&typeof mpInGame==='function'&&mpInGame()) mpUpdateTurnIndicator();
  render();
}

function tryCommit(from,to,promo){
  if(from<0||to<0)return false;
  // If it is not our turn (multiplayer waiting, or bot thinking), queue a premove.
  // This branch is checked BEFORE legalMoves, because a premove is deliberately
  // allowed to be illegal in the current position — see premoveDests.
  const notMyTurn=(typeof mpIsMyTurn==='function'&&!mpIsMyTurn());
  if(notMyTurn||botOnMove()){
    const st=premoveSpecState();
    const p2=st.board[from];if(!p2)return false;
    // Only allow premove for the player's own pieces
    if(p2.color!==playerColor())return false;
    if(!premoveDests(from,st.board,st.castling).includes(to))return false;
    return queuePremove(from,to,promo);
  }
  // Past this point it IS our turn, so the move plays for real — and it must be
  // legal in the position as it stands NOW. `legalMoves` cannot be trusted for
  // that: a piece picked up during the opponent's turn carries the optimistic
  // premoveDests set, and the turn can flip back to us mid-drag when the bot
  // replies. executeMove validates nothing, so check against the live board.
  const p=board[from];if(!p||p.color!==turn)return false;
  if(!legalMovesFor(from,board,epSq,castling).includes(to))return false;
  if(p.piece==='P'&&(Math.floor(to/8)===0||Math.floor(to/8)===7)&&!promo){
    promotionPending={from,to,color:p.color};clearPreview();render();return true;
  }
  executeMove(from,to,promo||null);
  // Send after execute so clock state (clockTimeW/B) is current post-increment
  if(typeof mpSendMove==='function'&&typeof mpInGame==='function'&&mpInGame()){
    mpSendMove(from,to,promo||null);
  }
  if(typeof mpUpdateTurnIndicator==='function'&&typeof mpInGame==='function'&&mpInGame()) mpUpdateTurnIndicator();
  return true;
}

function startPreview(from,to){
  if(from<0||to<0)return;
  // Exploration overlays describe the REAL position. A premove destination that
  // is not legal YET — a pawn's diagonal onto an empty square, a slide through
  // an enemy piece, a piece an earlier premove has already moved — would have us
  // render consequences on a board that does not exist. Preview the identity
  // board instead, so the overlays stay honest about what is actually there.
  //
  // What we must NOT do is rewrite `to` itself. premoveFrom/premoveTo are not
  // only the preview anchor: confirm mode parks a piece on them and matches the
  // confirming tap against premoveTo. Collapsing it to the origin made every
  // not-yet-legal premove unconfirmable — the tap never matched, so it re-parked
  // forever. That is precisely the pawn recapture a bullet player premoves.
  const collapsed = (to!==from&&isWaitingTurn()&&
    (!board[from]||!legalMovesFor(from,board,epSq,castling).includes(to)));
  // Skip if same square as last preview — no need to recompute
  if(from===premoveFrom&&to===premoveTo&&previewBoard&&collapsed===previewCollapsed) {
    render(); return;
  }
  let bd2;
  if(collapsed||to===from){
    // Identity preview: piece held over its own square. Evaluate the board
    // exactly as it stands so the exploration overlays stay on until the
    // piece is committed back (click / drop on origin).
    bd2={...board};
    previewEpSq=epSq;
    previewCastling=castling;
  } else {
    bd2=applyMove(from,to,board,epSq,'Q');
    const movingPiece=board[from];
    previewEpSq = (movingPiece&&movingPiece.piece==='P'&&Math.abs(to-from)===16)
      ? (from+to)>>1 : -1;
    previewCastling = updateCastling(from,to,movingPiece,castling);
  }
  previewBoard=bd2;previewAtk=buildAtk(bd2);previewCollapsed=collapsed;
  const pp=computePins(bd2);previewPinsW=pp.w;previewPinsB=pp.b;
  premoveFrom=from;premoveTo=to;selSq=-1;
  if(typeof indRefreshPremoveUI==='function') indRefreshPremoveUI();
  // Cancel any pending computation and schedule fresh one
  if(window._indApplyFrame) cancelAnimationFrame(window._indApplyFrame);
  window._indApplyFrame = requestAnimationFrame(() => {
    window._indApplyFrame = null;
    try {
      if(typeof indApply==='function') indApply();
    } catch(e) {
      console.warn('startPreview indApply error:',e);
      render();
    }
  });
}
function clearPreview(){
  previewBoard=null;previewAtk=null;premoveFrom=-1;premoveTo=-1;previewCollapsed=false;
  previewPinsW=new Set();previewPinsB=new Set();
  previewEpSq=-1;previewCastling=null;
  currentlyPreviewing=false;
  if(typeof ibRefreshAll==='function') ibRefreshAll();
  if(typeof indApply==='function') indApply();
}
function showRemovalAtk(sq){
  const bd2={...board};delete bd2[sq];
  previewBoard=null;previewAtk=buildAtk(bd2);
  const pp=computePins(bd2);previewPinsW=pp.w;previewPinsB=pp.b;
}

// ── Move commit mode ─────────────────────────────────────────────────────────
// 'release' — dropping a piece on a legal square plays the move (default; the
//             behaviour this board has always had).
// 'confirm' — dropping PARKS the piece on the destination and leaves the
//             preview overlays live. A second tap commits. Exists because on a
//             phone the finger covers the very overlays you dropped the piece
//             to read, and lifting it used to be what played the move.
// Persisted so the choice survives a reload, and switchable mid-game from the
// chip above the board.
let boardCommitMode = 'release';
try { const _cm = localStorage.getItem('bmCommitMode'); if (_cm === 'confirm' || _cm === 'release') boardCommitMode = _cm; } catch(e){}

// True once a piece has been parked on its destination and is waiting for the
// confirming tap. Only ever set in 'confirm' mode.
let awaitingConfirm = false;

function isConfirmMode(){ return boardCommitMode === 'confirm'; }

// The parked/not-parked hint lives in updatePlayerBoxes(), which the board's
// own render() does not call — so route every change through here rather than
// assigning the flag directly, or the hint goes stale.
function setAwaitingConfirm(v){
  v = !!v;
  if (awaitingConfirm === v) return;
  awaitingConfirm = v;
  if (typeof updatePlayerBoxes === 'function') updatePlayerBoxes();
}

function setCommitMode(mode){
  boardCommitMode = (mode === 'confirm') ? 'confirm' : 'release';
  try { localStorage.setItem('bmCommitMode', boardCommitMode); } catch(e){}
  // Drop any half-finished interaction so the modes never hand state to each other.
  setAwaitingConfirm(false);
  clearPreview();selSq=-1;legalMoves=[];hoverSq=-1;dragFrom=-1;dragMoved=false;
  atkMap=buildAtk(board);
  updateCommitModeChip();
  render();
}

function toggleCommitMode(){ setCommitMode(isConfirmMode() ? 'release' : 'confirm'); }

// The board markup is emitted before this script, so the chip is already in the
// DOM — sync it to the persisted mode straight away.
updateCommitModeChip();

function updateCommitModeChip(){
  const el = document.getElementById('commitModeChip');
  if(!el) return;
  const confirming = isConfirmMode();
  el.textContent = confirming ? '👆 Tap to confirm' : '✋ Release to move';
  el.classList.toggle('on', confirming);
  el.title = confirming
    ? 'Drag a piece, let go to park it and read the overlays, then tap again to play the move. Tap to switch to release-to-move.'
    : 'Letting go of a piece plays the move. Tap to switch to park-then-confirm.';
}

function getEvtPos(e){const rect=cv.getBoundingClientRect();const cl=e.touches?e.touches[0]:e;return{x:cl.clientX-rect.left,y:cl.clientY-rect.top};}
function getSq(pos){
  const scale=480/cv.getBoundingClientRect().width;
  let c=Math.floor(pos.x*scale/SQ),r=Math.floor(pos.y*scale/SQ);
  // Flip for both multiplayer-black and bot-game-black (boardFlipped)
  const shouldFlip = (typeof boardFlipped!=='undefined'&&boardFlipped) ||
                     (typeof mpRole!=='undefined'&&mpRole==='black'&&typeof mpInGame==='function'&&mpInGame());
  if(shouldFlip){c=7-c;r=7-r;}
  if(c>=0&&c<8&&r>=0&&r<8)return rcSq(r,c);return -1;
}
function canvasToBoard(pos){
  const rect=cv.getBoundingClientRect();
  const scale=480/rect.width;
  const px=(pos.x)*scale;
  const py=(pos.y)*scale;
  let col=Math.max(0,Math.min(7,Math.floor(px/SQ)));
  let row=Math.max(0,Math.min(7,Math.floor(py/SQ)));
  // Flip for both multiplayer-black and bot-game-black (boardFlipped)
  const shouldFlip = (typeof boardFlipped!=='undefined'&&boardFlipped) ||
                     (typeof mpRole!=='undefined'&&mpRole==='black'&&typeof mpInGame==='function'&&mpInGame());
  if(shouldFlip){col=7-col;row=7-row;}
  return rcSq(row,col);
}
function getPromoChoice(pos){
  const scale=480/cv.getBoundingClientRect().width;const px=pos.x*scale,py=pos.y*scale;
  const bw=220,bh=72,bx=(480-bw)/2,by=(480-bh)/2;
  if(py<by+22||py>by+bh)return null;
  const pieces=['Q','R','B','N'];for(let i=0;i<4;i++){if(Math.abs(px-(bx+28+i*52))<24)return pieces[i];}return null;
}

// ── Helper: returns the human player's color ('w' or 'b') regardless of whose turn it is.
// In multiplayer, determined by mpRole. In bot games, determined by botPlayerColor.
// In solo mode, returns the current turn (so any piece can be explored).
function playerColor(){
  // Gated on being in a game, not on holding a room: while a challenge is only
  // posted, the board is the host's to explore with either colour.
  if(typeof mpInGame==='function'&&mpInGame()&&typeof mpRole!=='undefined'&&mpRole)
    return mpRole==='white'?'w':'b';
  if(typeof botActive!=='undefined'&&botActive&&typeof botPlayerColor!=='undefined')
    return botPlayerColor==='white'?'w':'b';
  return turn; // solo: always matches current turn
}

// ── Helper: true when we should allow selecting the player's own pieces even if
// it's not their turn (for exploration and premove queuing).
function isWaitingTurn(){
  if(typeof mpIsMyTurn==='function'&&typeof mpRoomId!=='undefined'&&mpRoomId) return !mpIsMyTurn();
  return botOnMove();
}

// True for the WHOLE of the bot's turn — keyed on whose move it is, never on
// botThinking. The bot's turn is wider than its inference at both ends:
// botPostMoveHook schedules botMakeMove on a 100 ms timer, the book and
// bot-premove paths clear botThinking before they call executeMove, and
// botStart waits 800 ms before the opening move. At an "instant" think time
// the inference can be shorter than the 100 ms gap sitting in front of it, so
// gating on botThinking refused a premove for most of the bot's turn —
// including the instant right after the player releases their own move, which
// is exactly when a speed player premoves.
function botOnMove(){
  if(typeof botActive==='undefined'||!botActive)return false;
  if(typeof gameOver!=='undefined'&&gameOver)return false;
  if(typeof botPlayerColor==='undefined')return false;
  return turn===(botPlayerColor==='white'?'b':'w');
}

cv.addEventListener('mousedown',e=>{
  e.preventDefault();
  if(promotionPending){const ch=getPromoChoice(getEvtPos(e));if(ch){executeMove(promotionPending.from,promotionPending.to,ch);promotionPending=null;}return;}
  if(gameOver)return;
  const pos=getEvtPos(e);const sq=getSq(pos);if(sq<0)return;
  // Ghost precompute hook
  if (typeof ghostOnMouseDown === 'function') setTimeout(()=>ghostOnMouseDown(sq), 15);

  const waiting=isWaitingTurn();
  const myCol=playerColor();
  // While waiting, the player composes against the speculative board, so a
  // piece is picked up from wherever its earlier premoves will have left it.
  const spec=waiting?premoveSpecState():null;
  const inpBoard=spec?spec.board:board;
  // A square is selectable as "own" if it's our color (current-turn OR our color while waiting)
  const isOwnPiece=inpBoard[sq]&&(inpBoard[sq].color===turn||(waiting&&inpBoard[sq].color===myCol));
  // Picking up one of our own pieces extends the chain; ANY other click clears
  // it (as does right-click — see the contextmenu handler). Adding a link is the
  // only thing that leaves the queue intact, so it cannot grow by accident.
  if(hasPremove()&&!(waiting&&inpBoard[sq]&&inpBoard[sq].color===myCol)){cancelPremove();return;}
  // While waiting for opponent: clicking own pieces shows legal moves for preview/premove.
  // Clicking opponent pieces still shows exploration (opponent-move preview) as before.
  // Committing a move from own piece during opponent's turn will queue a premove.

    // ── Confirm mode: a piece is parked and waiting for its second tap ───────
  // Tapping the parked square plays the move; tapping a different legal
  // square re-parks there (change your mind without starting over); anything
  // else puts the piece back and clears the preview.
  // Piece is selected but not yet parked, and a legal square was tapped:
  // park it there rather than playing it. This is the tap-only route to the
  // same place dragging reaches on release.
  // The origin can come from either selSq or the live preview: on desktop a
  // hover over a legal square already started a preview and cleared selSq,
  // so selSq alone would miss the mouse case entirely.
  if(isConfirmMode()&&!awaitingConfirm){
    const _origin=(selSq>=0)?selSq:premoveFrom;
    if(_origin>=0&&sq!==_origin&&legalMoves.includes(sq)){
      startPreview(_origin,sq);
      setAwaitingConfirm(true);
      render();return;
    }
  }
  if(isConfirmMode()&&awaitingConfirm&&premoveFrom>=0&&premoveTo>=0){
    if(sq===premoveTo){
      const f=premoveFrom,t=premoveTo;
      setAwaitingConfirm(false);
      // A parked piece can sit for a while, and the position can change
      // underneath it — the opponent replies in multiplayer, the bot replies
      // here. So legality is re-derived rather than trusting the list captured
      // when the piece was picked up; tryCommit does exactly that, against the
      // live board for a real move and against the speculative one for a
      // premove. Checking strict legality HERE instead threw away every premove
      // that is not legal yet, which is most of the ones worth making.
      if(!tryCommit(f,t)){selSq=-1;legalMoves=[];clearPreview();atkMap=buildAtk(board);render();}
      return;
    }
    if(sq!==premoveFrom&&legalMoves.includes(sq)){
      startPreview(premoveFrom,sq);
      setAwaitingConfirm(true); // startPreview does not touch the flag; keep it explicit
      render();return;
    }
    // Cancelled — put it back.
    setAwaitingConfirm(false);
    selSq=-1;legalMoves=[];clearPreview();atkMap=buildAtk(board);
    dragFrom=-1;dragMoved=false;render();
    if(!isOwnPiece)return; // tapped empty space: just cancel
    // Tapped another piece: fall through and select it below.
  }
  if(isOwnPiece){
    if(selSq===sq){selSq=-1;legalMoves=[];clearPreview();atkMap=buildAtk(board);dragFrom=-1;dragMoved=false;render();}
    else{
      dragFrom=sq;dragStartPos=pos;dragMoved=false;mousePos=pos;
      // Composing a premove gets the optimistic destination set; a real move
      // gets the strictly legal one.
      legalMoves=(spec&&inpBoard[sq].color===myCol)
        ? premoveDests(sq,spec.board,spec.castling)
        : legalMovesFor(sq,board,epSq,castling);
      // Identity preview at selection time: overlays appear immediately and stay on.
      startPreview(sq,sq);
      selSq=sq; // startPreview clears selSq; restore it so hover exploration works
    }
  }else{
    // Confirm mode never commits from here — only the tap on the parked
    // square does, and that is handled above. Anything else clears.
    if(!isConfirmMode()&&previewBoard&&premoveFrom>=0&&premoveTo>=0){tryCommit(premoveFrom,premoveTo);}
    else{selSq=-1;legalMoves=[];clearPreview();atkMap=buildAtk(board);dragFrom=-1;dragMoved=false;render();}
  }
});

cv.addEventListener('mousemove',e=>{
  e.preventDefault();const pos=getEvtPos(e);mousePos=pos;const sq=getSq(pos);
  // Ghost call is inside the square-change gates below (not here) to avoid
  // firing on every pixel of mouse movement
    if(dragFrom>=0&&!dragMoved){const dx=pos.x-dragStartPos.x,dy=pos.y-dragStartPos.y;if(Math.sqrt(dx*dx+dy*dy)>DRAG_THRESHOLD)dragMoved=true;}
  if(selSq>=0){
    if(sq!==hoverSq){ // only recompute when square changes
      hoverSq=sq;
      if (typeof ghostOnMouseMove === 'function') ghostOnMouseMove(sq);
      if(sq>=0&&sq!==selSq&&legalMoves.includes(sq)){
        // Legal destination — preview the move.
        startPreview(selSq,sq);
      } else {
        // Origin square, non-legal square, or off-board — hold identity preview
        // (piece on its original square) so overlays stay steady. They only
        // change when the cursor enters a legal destination square.
        const _orig=selSq;
        startPreview(_orig,_orig);
        selSq=_orig; // startPreview clears selSq; restore so hover continues
      }
    }
    render();
  }else if(dragFrom>=0&&dragMoved){
    if(sq!==dragOver){ // only process when square changes
      dragOver=sq;
      if (typeof ghostOnMouseMove === 'function') ghostOnMouseMove(sq);
      if(sq>=0&&(sq===dragFrom||legalMoves.includes(sq))){
        // Legal square → preview the move; origin square → identity preview
        // (overlays stay on, evaluating the unchanged board).
        startPreview(dragFrom,sq);
      } else {
        // Non-legal square while dragging — hold identity preview so overlays stay on.
        startPreview(dragFrom,dragFrom);
      }
    }
    render();
  }
});

cv.addEventListener('mouseup',e=>{
  e.preventDefault();if(promotionPending)return;
  if (typeof ghostOnMouseUp === 'function') ghostOnMouseUp();
  const pos=getEvtPos(e);const sq=canvasToBoard(pos);
    // Confirm mode: releasing parks the piece instead of playing it. The preview
  // stays live so the overlays can be read with the finger off the board; the
  // next tap (handled in mousedown) is what commits.
  if(isConfirmMode()){
    if(dragFrom>=0&&dragMoved){
      const dest=(premoveTo>=0&&premoveTo!==dragFrom&&legalMoves.includes(premoveTo))?premoveTo
                :(sq>=0&&sq!==dragFrom&&legalMoves.includes(sq))?sq:-1;
      if(dest>=0){
        // Park it: legalMoves is kept so the confirming tap can still validate,
        // and so dragging on to a different legal square re-parks there.
        const f=dragFrom;
        dragFrom=-1;dragMoved=false;selSq=-1;
        startPreview(f,dest);
        setAwaitingConfirm(true);
        render();return;
      }
      // Dragged somewhere illegal — put the piece back but keep it selected,
      // so the next tap on a legal square can park it without re-picking up.
      const o=dragFrom;
      dragFrom=-1;dragMoved=false;dragOver=-1;
      startPreview(o,o);selSq=o;
      render();return;
    }
    // Plain tap, nothing parked: hold the identity preview so the piece stays
    // selected with its overlays live. The tap that lands it is what parks.
    const o=(selSq>=0)?selSq:dragFrom;
    dragMoved=false;dragFrom=-1;dragOver=-1;
    if(!awaitingConfirm){
      if(o>=0&&board[o]){startPreview(o,o);selSq=o;}
      else clearPreview();
    }
    render();return;
  }
  if(dragFrom>=0){
    if(dragMoved){
      if(premoveTo>=0&&premoveTo!==dragFrom&&legalMoves.includes(premoveTo)){const f=dragFrom,t=premoveTo;dragFrom=-1;dragMoved=false;selSq=-1;tryCommit(f,t);return;}
      if(sq>=0&&sq!==dragFrom&&legalMoves.includes(sq)){const f=dragFrom,t=sq;dragFrom=-1;dragMoved=false;selSq=-1;tryCommit(f,t);return;}
    }
    dragMoved=false;
  }
  if(!dragMoved&&premoveTo>=0&&premoveTo!==selSq&&legalMoves.includes(premoveTo)&&selSq<0){const f=premoveFrom,t=premoveTo;tryCommit(f,t);return;}
  dragMoved=false;clearPreview();render();
});

cv.addEventListener('mouseleave',()=>{
  hoverSq=-1;
  // A parked piece survives the cursor leaving the board — that is the whole
  // point of the mode, and on desktop the pointer often exits while reading.
  if(isConfirmMode()&&awaitingConfirm){render();return;}
  if(selSq>=0){const _orig=selSq;startPreview(_orig,_orig);selSq=_orig;}
  else if(dragFrom>=0&&dragMoved){startPreview(dragFrom,dragFrom);}
  dragMoved=false;
  render();
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){setAwaitingConfirm(false);cancelPremove();clearPreview();selSq=-1;legalMoves=[];hoverSq=-1;dragFrom=-1;dragMoved=false;atkMap=buildAtk(board);render();}});
// Right-click clears the whole queue — the Chess.com gesture, and the only way
// to abandon a chain without also picking a piece up. Touch has no equivalent,
// which is why any non-composing tap clears it too (see mousedown).
cv.addEventListener('contextmenu',e=>{
  if(!hasPremove())return;
  e.preventDefault();
  cancelPremove();
});

cv.addEventListener('touchstart',e=>{e.preventDefault();const t=e.touches[0];cv.dispatchEvent(new MouseEvent('mousedown',{clientX:t.clientX,clientY:t.clientY,bubbles:true}));},{passive:false});
cv.addEventListener('touchmove',e=>{e.preventDefault();const t=e.touches[0];cv.dispatchEvent(new MouseEvent('mousemove',{clientX:t.clientX,clientY:t.clientY,bubbles:true}));},{passive:false});
cv.addEventListener('touchend',e=>{e.preventDefault();const t=e.changedTouches[0];cv.dispatchEvent(new MouseEvent('mouseup',{clientX:t.clientX,clientY:t.clientY,bubbles:true}));},{passive:false});

// ---- Rendering ----

// ── Color palette system ────────────────────────────────────────────────
// Each palette defines colors for: hanging ring, outnumbered ring,
// contested ring, def ring, att ring, pin, bullseye
const PALETTES={
  default:{
    hanging:'rgba(220,0,0,1.0)', hangingFill:'rgba(255,0,0,0.18)',
    outnumbered:'rgba(200,0,0,0.92)', outnumberedFill:'rgba(200,0,0,0.12)',
    contested:'rgba(100,130,180,0.75)',
    defRing:'rgba(34,168,90,1)', attRing:'rgba(224,53,53,1)',
    pin:'rgba(180,0,180,0.92)',
    bull1:'rgba(0,0,0,0.72)', bull2:'rgba(0,0,0,0.36)',
    checkFill:'rgba(230,60,0,0.42)', checkStroke:'rgba(255,100,0,0.95)',
    weakMineFill:'rgba(168,28,48,0.30)',   weakMineStroke:'rgba(140,18,38,0.95)',
    weakTheirsFill:'rgba(20,125,140,0.28)',weakTheirsStroke:'rgba(12,100,115,0.95)',
    weakBothFill:'rgba(120,60,150,0.30)',  weakBothStroke:'rgba(100,45,130,0.95)',
  },
  highcontrast:{
    hanging:'rgba(255,0,0,1)', hangingFill:'rgba(255,0,0,0.25)',
    outnumbered:'rgba(220,0,0,1)', outnumberedFill:'rgba(220,0,0,0.18)',
    contested:'rgba(0,80,200,0.9)',
    defRing:'rgba(0,200,0,1)', attRing:'rgba(255,0,0,1)',
    pin:'rgba(200,0,200,1)',
    bull1:'rgba(0,0,0,0.9)', bull2:'rgba(0,0,0,0.5)',
    checkFill:'rgba(255,50,0,0.55)', checkStroke:'rgba(255,100,0,1)',
    weakMineFill:'rgba(190,0,30,0.42)',    weakMineStroke:'rgba(150,0,20,1)',
    weakTheirsFill:'rgba(0,120,150,0.40)', weakTheirsStroke:'rgba(0,90,120,1)',
    weakBothFill:'rgba(120,0,160,0.40)',   weakBothStroke:'rgba(90,0,130,1)',
  },
  colorblind:{
    // Deuteranopia-friendly: blues/oranges instead of red/green
    hanging:'rgba(213,94,0,1)', hangingFill:'rgba(213,94,0,0.22)',
    outnumbered:'rgba(180,70,0,0.95)', outnumberedFill:'rgba(180,70,0,0.15)',
    contested:'rgba(0,114,178,0.8)',
    defRing:'rgba(0,114,178,1)', attRing:'rgba(213,94,0,1)',
    pin:'rgba(204,121,167,1)',
    bull1:'rgba(0,0,0,0.75)', bull2:'rgba(0,0,0,0.38)',
    checkFill:'rgba(230,159,0,0.45)', checkStroke:'rgba(230,159,0,0.95)',
    weakMineFill:'rgba(213,94,0,0.30)',    weakMineStroke:'rgba(170,70,0,0.95)',
    weakTheirsFill:'rgba(0,114,178,0.28)', weakTheirsStroke:'rgba(0,90,145,0.95)',
    weakBothFill:'rgba(120,60,150,0.30)',  weakBothStroke:'rgba(100,45,130,0.95)',
  },
  pastel:{
    hanging:'rgba(220,80,80,0.9)', hangingFill:'rgba(255,150,150,0.2)',
    outnumbered:'rgba(200,100,100,0.85)', outnumberedFill:'rgba(220,150,150,0.15)',
    contested:'rgba(120,150,220,0.7)',
    defRing:'rgba(80,200,120,0.9)', attRing:'rgba(220,100,100,0.9)',
    pin:'rgba(200,100,200,0.85)',
    bull1:'rgba(60,60,60,0.65)', bull2:'rgba(60,60,60,0.32)',
    checkFill:'rgba(255,160,80,0.4)', checkStroke:'rgba(255,130,50,0.9)',
    weakMineFill:'rgba(200,90,105,0.28)',  weakMineStroke:'rgba(175,65,80,0.88)',
    weakTheirsFill:'rgba(90,165,180,0.26)',weakTheirsStroke:'rgba(60,135,150,0.88)',
    weakBothFill:'rgba(160,110,185,0.28)', weakBothStroke:'rgba(130,85,155,0.88)',
  },
};
let currentPalette=PALETTES.default;


// Determine threat circle color for a piece on sq of given color
// Returns: 'red' (danger), 'green' (safe), 'grey' (contested), 'none' (no attackers)
function getCaptureColor(sq, color, bd, atk){
  const opp = color==='w'?'b':'w';
  const p = bd[sq]; if(!p) return 'none';
  const myVal = PIECE_VALUE[p.piece] || 0;
  const def = atk[sq][color] ? atk[sq][color].length : 0;
  const att = atk[sq][opp]  ? atk[sq][opp].length  : 0;
  if(att === 0) return 'none'; // not under attack
  // Check for cheap attacker (attacker less valuable than this piece)
  let hasCheapAttacker = false;
  if(atk[sq][opp]){
    for(const aSq of atk[sq][opp]){
      const ap = bd[aSq];
      if(ap && (PIECE_VALUE[ap.piece]||0) < myVal){ hasCheapAttacker = true; break; }
    }
  }
  if(def === 0 || hasCheapAttacker) return 'red';   // hanging or cheap capture
  if(att > def)  return 'red';                       // outnumbered — more attackers than defenders
  if(def > att)  return 'green';                     // overprotected
  return 'grey';                                      // equal count — contested
}

// Draw a threat circle around a piece square
function drawThreatCircle(sq, color){
  const {r,c} = sqCanvas(sq);
  const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
  ctx.save();
  ctx.beginPath(); ctx.arc(x,y,SQ*0.42,0,Math.PI*2);
  if(color==='red'){
    ctx.strokeStyle='rgba(210,40,40,0.95)'; ctx.lineWidth=1.8;
  } else if(color==='green'){
    ctx.strokeStyle='rgba(30,180,70,0.92)'; ctx.lineWidth=1.8;
  } else {
    ctx.strokeStyle='rgba(140,140,160,0.80)'; ctx.lineWidth=1.8;
  }
  ctx.stroke();
  ctx.restore();
}

// ── Sawtooth danger ring ─────────────────────────────────────────────────────
// Drawn around the explored piece when it would be HANGING on its destination
// (attacked, zero defenders). Deliberately louder than the passive overlays:
// "the move you are about to make" earns more alarm than ambient board state.
// Pure fact, no evaluation — it never says whether the move is good.
// Drawn statically (no animation loop): render() already runs on every
// hover change, and an advancing pulse phase made the ring look glitchy.
function drawJaggedRing(ctx2, sq, color){
  const {r,c} = sqCanvas(sq);
  const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
  const rOut = SQ*0.47, rIn = SQ*0.37;
  const teeth = 14;
  ctx2.save();
  ctx2.beginPath();
  for(let i=0;i<teeth*2;i++){
    const a = (i/(teeth*2))*Math.PI*2 - Math.PI/2;
    const rad = i%2===0 ? rOut : rIn;
    const px = x+rad*Math.cos(a), py = y+rad*Math.sin(a);
    if(i===0) ctx2.moveTo(px,py); else ctx2.lineTo(px,py);
  }
  ctx2.closePath();
  ctx2.strokeStyle = color || 'rgba(220,40,40,0.95)';
  ctx2.lineWidth = 2.2; ctx2.lineJoin = 'miter';
  ctx2.stroke();
  ctx2.fillStyle = 'rgba(220,40,40,0.10)';
  ctx2.fill();
  ctx2.restore();
}

// ── Ghost canvas — declared before render() to avoid TDZ ────────────────────
const ghostCv = document.getElementById('ghostCanvas');
const ghostCtx = ghostCv ? ghostCv.getContext('2d') : null;
let boardFlipped = false; // real variable; bot sets this when human plays black
// Cheap-attacker alert data — set once per render() frame so drawPieceUnder
// doesn't rebuild a full attack map per piece, and always matches the
// DISPLAYED board (real or preview), never stale real-board state.
let _alertBoard = null;
let _alertDirectAtk = null;

function syncGhostCanvas() {
  const mainCv = document.getElementById('cv');
  if (!ghostCv || !mainCv) return;
  // IMPORTANT: assigning to canvas.width/height clears it even if value unchanged.
  // Only resize when dimensions actually differ.
  if (ghostCv.width  !== mainCv.width)  ghostCv.width  = mainCv.width;
  if (ghostCv.height !== mainCv.height) ghostCv.height = mainCv.height;
  const wStr = mainCv.style.width  || mainCv.width  + 'px';
  const hStr = mainCv.style.height || mainCv.height + 'px';
  if (ghostCv.style.width  !== wStr) ghostCv.style.width  = wStr;
  if (ghostCv.style.height !== hStr) ghostCv.style.height = hStr;
}
window.addEventListener('resize', syncGhostCanvas);

function render(){
  syncGhostCanvas();
  const showLayers=indActive('rings');
  const showNums=indActive('counts');
  const showBull=indActive('unprotected');
  const showLegal=indActive('legal');
  const showInfluence=indActive('influence');
  const dispBoard=previewBoard||board;
  const dispAtk=previewAtk||atkMap;
  const isPreviewing=!!previewBoard;
  const isDragging=dragFrom>=0&&dragMoved;
  const _pmMap=premoveQueue.length?premoveSquareMap():null;
  // Squares the queue empties out. The origin ghost below is drawn at low alpha
  // to say "this piece is leaving", but that only reads if the real piece is not
  // still sitting underneath it at full opacity — otherwise a chain shows the
  // same queen on two squares and neither looks provisional.
  let _pmVacated=null;
  if(_pmMap&&!isPreviewing){
    const _sb=premoveSpecState().board;
    _pmVacated=new Set();
    for(const pm of premoveQueue) if(board[pm.from]&&!_sb[pm.from])_pmVacated.add(pm.from);
  }

  ctx.clearRect(0,0,480,480);
  ctx.setLineDash([]); ctx.globalAlpha=1; ctx.shadowBlur=0; ctx.lineWidth=1; // reset state
  const _boardFlipped = boardFlipped || (typeof mpRole!=='undefined'&&mpRole==='black'&&typeof mpInGame==='function'&&mpInGame());

  for(let r=0;r<8;r++)for(let c=0;c<8;c++){
    // For black: display row r,c → board square at mirrored position
    const sq=_boardFlipped?rcSq(7-r,7-c):rcSq(r,c);const light=(r+c)%2===0;
    let fill=sqColor(r,c);
    // Last-move highlight: standard yellow-green tint (Lichess/Chess.com style)
    if(!isPreviewing && (sq===lastMoveFrom||sq===lastMoveTo)){
      fill=light?'#cdd16e':'#aaa23a';
    }
    if(_pmMap&&_pmMap.has(sq)){
      fill=_pmMap.get(sq).kind==='from'?(light?'#a8c8f8':'#6090d0'):(light?'#90b8f0':'#4878c0');
    }
    // A parked piece is still being composed, so its destination uses the
    // SELECTION yellow, not the preview green. Green here read as "this move
    // was played" — it is adjacent to the yellow-green last-move highlight —
    // when the whole point is that it has not been played yet.
    else if(isPreviewing&&awaitingConfirm&&sq===premoveTo)fill=light?'#f6f669':'#baca2b';
    // Preview destination is the selection yellow, not green. Green read as
    // "this move was played" by association with the yellow-green last-move
    // highlight, when a preview is the opposite: nothing has happened yet.
    // Origin stays the darker olive, so the two ends stay distinguishable.
    // (Last-move highlighting is suppressed while previewing — see above — so
    // these two yellows are never on the board at the same time.)
    else if(isPreviewing){if(sq===premoveFrom)fill=light?'#d8d860':'#b0b020';else if(sq===premoveTo)fill=light?'#f6f669':'#baca2b';}
    else{if(sq===selSq)fill=light?'#f6f669':'#baca2b';else if(sq===dragFrom&&isDragging)fill=light?'#d0d0d0':'#aaa';}
    ctx.fillStyle=fill;ctx.fillRect(c*SQ,r*SQ,SQ,SQ);
    // Subtle texture — stable per-square grain
    const theme=BOARD_THEMES[currentBoardTheme]||BOARD_THEMES.classic;
    if(theme.texture){
      ctx.save();
      ctx.globalAlpha=light?0.04:0.06;
      ctx.fillStyle=light?'#000':'#fff';
      // Deterministic grain: 8 small marks per square using r,c as seed
      const seed=(r*8+c)*2654435761;
      for(let i=0;i<8;i++){
        const h=(((seed*(i+1)*1234567)>>>0)%SQ);
        const v=(((seed*(i+1)*7654321)>>>0)%SQ);
        const w=1+(((seed*(i+1)*999983)>>>0)%3);
        const ht=1+(((seed*(i+1)*314159)>>>0)%2);
        ctx.fillRect(c*SQ+h,r*SQ+v,w,ht);
      }
      ctx.globalAlpha=1;
      ctx.restore();
    }
  }

  if(showInfluence){
    const iSq=isPreviewing?premoveTo:(selSq>=0?selSq:-1);
    const iBoard=isPreviewing?previewBoard:board;
    if(iSq>=0&&iBoard&&iBoard[iSq]){
      const infl=influenceSquares(iSq,iBoard);const pc=iBoard[iSq];
      for(const tsq of infl){
        if(iBoard[tsq])continue;
        const{r,c}=sqCanvas(tsq);
        ctx.fillStyle=pc.color==='w'?'rgba(100,180,255,0.22)':'rgba(255,140,60,0.22)';ctx.fillRect(c*SQ,r*SQ,SQ,SQ);
        ctx.beginPath();ctx.arc(c*SQ+SQ/2,r*SQ+SQ/2,4,0,Math.PI*2);
        ctx.fillStyle=pc.color==='w'?'rgba(60,130,220,0.55)':'rgba(220,100,20,0.55)';ctx.fill();
      }
    }
  }

  if(showLegal&&selSq>=0&&!isPreviewing){
    for(const t of legalMoves){
      const{r,c}=sqCanvas(t);const x=c*SQ+SQ/2,y=r*SQ+SQ/2;
      if(board[t]){
        ctx.fillStyle='rgba(0,150,0,0.32)';
        [[0,0],[SQ,0],[0,SQ],[SQ,SQ]].forEach(([ox,oy])=>{ctx.beginPath();ctx.moveTo(c*SQ+ox,r*SQ+oy);ctx.lineTo(c*SQ+ox+(ox?-14:14),r*SQ+oy);ctx.lineTo(c*SQ+ox,r*SQ+oy+(oy?-14:14));ctx.closePath();ctx.fill();});
      }else{ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.fillStyle='rgba(0,140,0,0.28)';ctx.fill();}
    }
  }



  // Check threat highlights — orange for white's threats, purple for black's
  // Belt-and-suspenders proMode guard: indApply is async (RAF) so stale state
  // could render for one frame before it fires; skip unconditionally in pro mode.
  if(showingCheckThreats && !(typeof proMode!=='undefined'&&proMode)){
    // Highlight DESTINATION squares (where check would occur)
    checkThreatSquaresW.forEach(sq=>{
      const{r,c}=sqCanvas(sq);
      const x=c*SQ, y=r*SQ;
      ctx.fillStyle='rgba(255,140,0,0.18)';ctx.fillRect(x,y,SQ,SQ);
      ctx.strokeStyle='rgba(255,140,0,0.90)';ctx.lineWidth=3;
      ctx.strokeRect(x+1.5,y+1.5,SQ-3,SQ-3);
      ctx.strokeStyle='rgba(255,220,50,0.5)';ctx.lineWidth=1;
      ctx.strokeRect(x+4,y+4,SQ-8,SQ-8);
    });
    checkThreatSquaresB.forEach(sq=>{
      const{r,c}=sqCanvas(sq);
      const x=c*SQ, y=r*SQ;
      ctx.fillStyle='rgba(180,40,220,0.15)';ctx.fillRect(x,y,SQ,SQ);
      ctx.strokeStyle='rgba(180,40,220,0.85)';ctx.lineWidth=3;
      ctx.strokeRect(x+1.5,y+1.5,SQ-3,SQ-3);
      ctx.strokeStyle='rgba(220,150,255,0.5)';ctx.lineWidth=1;
      ctx.strokeRect(x+4,y+4,SQ-8,SQ-8);
    });
    // Highlight PIECE squares (the pieces that can deliver check) with a glow ring
    checkThreatPiecesW.forEach(sq=>{
      const{r,c}=sqCanvas(sq);
      const x=c*SQ+SQ/2, y=r*SQ+SQ/2;
      ctx.save();
      ctx.beginPath();ctx.arc(x,y,SQ*0.44,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,160,0,0.85)';ctx.lineWidth=3;ctx.stroke();
      ctx.beginPath();ctx.arc(x,y,SQ*0.38,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,220,80,0.45)';ctx.lineWidth=2;ctx.stroke();
      ctx.restore();
    });
    checkThreatPiecesB.forEach(sq=>{
      const{r,c}=sqCanvas(sq);
      const x=c*SQ+SQ/2, y=r*SQ+SQ/2;
      ctx.save();
      ctx.beginPath();ctx.arc(x,y,SQ*0.44,0,Math.PI*2);
      ctx.strokeStyle='rgba(180,40,220,0.85)';ctx.lineWidth=3;ctx.stroke();
      ctx.beginPath();ctx.arc(x,y,SQ*0.38,0,Math.PI*2);
      ctx.strokeStyle='rgba(220,150,255,0.45)';ctx.lineWidth=2;ctx.stroke();
      ctx.restore();
    });
  }

  // Captures: now handled by circle system above

  // Weak square highlights (hold button)
  // weakSquaresW = empty squares black has no attackers on = safe for white
  // weakSquaresB = empty squares white has no attackers on = safe for black
  if(showingWeakSquares){
    // A weak square is territory, not a piece in trouble, and it used to be
    // painted in the colours that mean "hanging" and "contested" — a 15% wash
    // that vanished on the brown squares and collided with the threat
    // vocabulary on the light ones. Three things changed:
    //   1. the palette is actually read (every PALETTE defined weakFill and
    //      weakStroke, and this block ignored all of them — the colourblind
    //      palette did nothing here at all);
    //   2. the wash is deep enough to darken #b58863, not just tint it;
    //   3. direction carries the side — hatched down-right for yours, up-right
    //      for theirs, crossed where both are weak — so hue is no longer the
    //      only channel and the overlay survives colour-blind vision.
    const P = currentPalette;
    const bothWeak = new Set([...weakSquaresW].filter(sq=>weakSquaresB.has(sq)));
    const paint = (sq, fill, stroke, dirs) => {
      const{r,c}=sqCanvas(sq);const x=c*SQ,y=r*SQ;
      ctx.fillStyle=fill;ctx.fillRect(x,y,SQ,SQ);
      ctx.save();
      ctx.beginPath();ctx.rect(x,y,SQ,SQ);ctx.clip();
      ctx.strokeStyle=stroke;ctx.lineWidth=1.5;ctx.globalAlpha=0.55;
      const step=Math.max(6,Math.round(SQ/7));
      dirs.forEach(d=>{
        // d=1 draws down-right, d=-1 up-right. Sweeping the offset over twice
        // the square width is what keeps both diagonals covering the corners.
        for(let o=-SQ;o<=SQ*2;o+=step){
          ctx.beginPath();
          if(d===1){ ctx.moveTo(x+o,y); ctx.lineTo(x+o-SQ,y+SQ); }
          else     { ctx.moveTo(x+o,y); ctx.lineTo(x+o+SQ,y+SQ); }
          ctx.stroke();
        }
      });
      ctx.restore();
      ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.strokeRect(x+1,y+1,SQ-2,SQ-2);
    };
    // Which set is "mine" was reported the wrong way round on the board, so
    // the pair is swapped here to match the buttons: ib-weakb is the one
    // labelled "My weak sq." and it draws in the mine colour, hatched down-
    // right; ib-weakw is "Opp. weak sq." and draws teal, hatched up-right.
    // NOTE: neither set consults which colour the human is playing, so this
    // reads correctly for a player of White. Following the seat is a separate
    // change and wants its own look.
    weakSquaresB.forEach(sq=>{
      if(bothWeak.has(sq)) paint(sq,P.weakBothFill,P.weakBothStroke,[1,-1]);
      else                 paint(sq,P.weakMineFill,P.weakMineStroke,[1]);
    });
    weakSquaresW.forEach(sq=>{
      if(bothWeak.has(sq)) return;
      paint(sq,P.weakTheirsFill,P.weakTheirsStroke,[-1]);
    });
  }

  // ── Overloaded piece overlay ────────────────────────────────────────────
  if (showingOverloaded && overloadedData) {
    const { overloaded, dependent } = overloadedData;

    // 1. Gold pulsing ring on overloaded pieces
    overloaded.forEach((deps, defSq) => {
      const {r,c} = sqCanvas(defSq);
      const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
      // Outer glow
      ctx.beginPath(); ctx.arc(x,y,30,0,Math.PI*2);
      ctx.strokeStyle='rgba(240,192,0,0.4)'; ctx.lineWidth=4; ctx.stroke();
      // Main ring
      ctx.beginPath(); ctx.arc(x,y,27,0,Math.PI*2);
      ctx.strokeStyle='rgba(240,192,0,0.92)'; ctx.lineWidth=2.5; ctx.stroke();
      // Badge: number of pieces it solely defends
      ctx.beginPath(); ctx.arc(x-15,y-15,8,0,Math.PI*2);
      ctx.fillStyle='rgba(240,192,0,0.95)'; ctx.fill();
      ctx.font='bold 10px sans-serif'; ctx.textAlign='center';
      ctx.textBaseline='middle'; ctx.fillStyle='#111';
      ctx.fillText(deps.size, x-15, y-15);
    });

    // 2. Gold dashed outline on dependent pieces
    dependent.forEach((defSq, depSq) => {
      const {r,c} = sqCanvas(depSq);
      const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
      ctx.save();
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.arc(x,y,26,0,Math.PI*2);
      ctx.strokeStyle='rgba(240,192,0,0.75)'; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
    });

    // 3. Connecting lines from overloaded piece to each dependent
    ctx.save();
    ctx.setLineDash([5,4]);
    ctx.lineWidth=1.5;
    overloaded.forEach((deps, defSq) => {
      const {r:dr,c:dc} = sqCanvas(defSq);
      const x1 = dc*SQ+SQ/2, y1 = dr*SQ+SQ/2;
      deps.forEach(depSq => {
        const {r:pr,c:pc} = sqCanvas(depSq);
        const x2 = pc*SQ+SQ/2, y2 = pr*SQ+SQ/2;
        // Draw line with gradient from gold to gold-transparent
        const grad = ctx.createLinearGradient(x1,y1,x2,y2);
        grad.addColorStop(0,'rgba(240,192,0,0.85)');
        grad.addColorStop(1,'rgba(240,192,0,0.4)');
        ctx.strokeStyle = grad;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
        // Arrow head at dependent end
        const angle = Math.atan2(y2-y1, x2-x1);
        const al=10, aw=0.35;
        ctx.save(); ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x2-al*Math.cos(angle-aw), y2-al*Math.sin(angle-aw));
        ctx.lineTo(x2-6*Math.cos(angle), y2-6*Math.sin(angle));
        ctx.lineTo(x2-al*Math.cos(angle+aw), y2-al*Math.sin(angle+aw));
        ctx.strokeStyle='rgba(240,192,0,0.85)'; ctx.lineWidth=1.5; ctx.stroke();
        ctx.restore();
      });
    });
    ctx.restore();
  }

  // ── Fork & Skewer BACKGROUND rendering (before pieces) ───────────────────
  // Draws: landing squares, arrows, rings on forking pieces
  // Bullseyes drawn AFTER pieces in foreground pass below
  function renderForkBg(forkData, skewerData, safeColor, contColor) {
    if (!forkData) return;
    forkData.current.forEach(({sq}) => {
      const {r,c}=sqCanvas(sq); const x=c*SQ+SQ/2, y=r*SQ+SQ/2;
      ctx.beginPath(); ctx.arc(x,y,30,0,Math.PI*2);
      ctx.strokeStyle=safeColor.replace(/[0-9.]+\)$/,'0.18)');
      ctx.lineWidth=6; ctx.stroke();
      ctx.beginPath(); ctx.arc(x,y,27,0,Math.PI*2);
      ctx.strokeStyle=safeColor; ctx.lineWidth=3; ctx.stroke();
    });
    forkData.safe.forEach(({from,to}) => {
      drawForkSymbol(ctx,to,SQ,safeColor,1.0);   // fork symbol on landing square
      drawForkArrow(ctx,from,to,SQ,safeColor);
      const {r:fr,c:fc}=sqCanvas(from);
      ctx.save(); ctx.setLineDash([5,3]);
      ctx.beginPath(); ctx.arc(fc*SQ+SQ/2,fr*SQ+SQ/2,26,0,Math.PI*2);
      ctx.strokeStyle=safeColor; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
    });
    forkData.contested.forEach(({from,to}) => {
      drawForkSymbol(ctx,to,SQ,contColor,0.7); // dimmer fork symbol
      drawForkArrow(ctx,from,to,SQ,contColor,true);
      const {r:fr,c:fc}=sqCanvas(from);
      ctx.save(); ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.arc(fc*SQ+SQ/2,fr*SQ+SQ/2,26,0,Math.PI*2);
      ctx.strokeStyle=contColor; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
    });
    if (skewerData) skewerData.forEach(({attackerSq,frontSq}) => {
      const {r:ar,c:ac}=sqCanvas(attackerSq);
      const {r:fr,c:fc}=sqCanvas(frontSq);
      ctx.beginPath(); ctx.arc(ac*SQ+SQ/2,ar*SQ+SQ/2,27,0,Math.PI*2);
      ctx.strokeStyle=safeColor; ctx.lineWidth=2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(fc*SQ+SQ/2,fr*SQ+SQ/2,27,0,Math.PI*2);
      ctx.strokeStyle=safeColor; ctx.lineWidth=2; ctx.stroke();
    });
  }
  // Colors: active player = green(safe)/blue(contested), opponent = amber(safe)/
  // light-amber(contested). Amber = "warning about what they can do", matching
  // the discovered-attack threat color. Red is reserved for pieces that are
  // themselves in danger — a red ring on the opponent's FORKING piece made it
  // look threatened rather than threatening.
  const wSafe = turn==='w' ? 'rgba(40,200,80,0.92)'  : 'rgba(235,140,0,0.92)';
  const wCont = turn==='w' ? 'rgba(53,120,224,0.85)' : 'rgba(235,170,60,0.78)';
  const bSafe = turn==='b' ? 'rgba(40,200,80,0.92)'  : 'rgba(235,140,0,0.92)';
  const bCont = turn==='b' ? 'rgba(53,120,224,0.85)' : 'rgba(235,170,60,0.78)';
  try { // BG indicators
  try { // BG indicator rendering
  // ── King in check during exploration — highlight orange ───────────────────
  if(previewBoard){
    const oppColor = turn==='w'?'b':'w';
    if(inCheck(previewBoard, oppColor)){
      const kSq = kingSquare(previewBoard, oppColor);
      if(kSq>=0){
        const{r:kr,c:kc}=sqCanvas(kSq);
        ctx.save();
        ctx.beginPath(); ctx.arc(kc*SQ+SQ/2, kr*SQ+SQ/2, SQ*0.46, 0, Math.PI*2);
        ctx.strokeStyle='rgba(255,120,0,0.95)'; ctx.lineWidth=3.5; ctx.stroke();
        ctx.fillStyle='rgba(255,120,0,0.18)'; ctx.fill();
        ctx.restore();
      }
    }
  }
  if (showingForksW) renderForkBg(forkDataW,skewerDataW,wSafe,wCont);
  if (showingForksB) renderForkBg(forkDataB,skewerDataB,bSafe,bCont);

  // ── Discovered attack rendering ───────────────────────────────────────────
  if (showingDiscovered && discoveredData && discoveredData.length > 0) {
    discoveredData.forEach(({movingPieceSq, revealedAttackerSq, threatenedSqs, isDiscoveredCheck, side}) => {
      const {r:mr,c:mc} = sqCanvas(movingPieceSq);
      const {r:rr,c:rc2} = sqCanvas(revealedAttackerSq);
      const mx = mc*SQ+SQ/2, my = mr*SQ+SQ/2;
      const rx = rc2*SQ+SQ/2, ry = rr*SQ+SQ/2;
      // Own discovered: purple (opportunity). Opponent discovered: amber (threat/warning).
      const isOpp = side==='opp';
      const discColor = isOpp
        ? (isDiscoveredCheck ? 'rgba(255,160,20,0.95)' : 'rgba(220,130,0,0.85)')
        : (isDiscoveredCheck ? 'rgba(220,180,255,0.9)' : 'rgba(160,80,220,0.85)');
      // Dashed purple line: revealed attacker → target (passes through board naturally)
      ctx.save();
      ctx.setLineDash([5,3]);
      ctx.strokeStyle = discColor; ctx.lineWidth = 1.8;
      threatenedSqs.forEach(t => {
        const {r:tr,c:tc} = sqCanvas(t);
        const tx2 = tc*SQ+SQ/2, ty2 = tr*SQ+SQ/2;
        // Line from revealed attacker to target
        ctx.beginPath(); ctx.moveTo(rx,ry); ctx.lineTo(tx2,ty2); ctx.stroke();
      });
      if(!threatenedSqs.length){
        ctx.beginPath(); ctx.moveTo(rx,ry); ctx.lineTo(mx,my); ctx.stroke();
      }
      ctx.restore();
      // Dashed purple ring on moving piece
      ctx.save(); ctx.setLineDash([5,3]);
      ctx.beginPath(); ctx.arc(mx,my,26,0,Math.PI*2);
      ctx.strokeStyle=discColor; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
      // Solid purple ring on revealed attacker
      ctx.beginPath(); ctx.arc(rx,ry,25,0,Math.PI*2);
      ctx.strokeStyle=discColor; ctx.lineWidth=1.8; ctx.stroke();
    });
  }

  // ── Threats & Captures: circles on all pieces showing capture safety ─────────
  if(indActive('threats')){
    const tBd = previewBoard||board;
    const tAtk = previewAtk||atkMap;
    const opp = turn==='w'?'b':'w';
    for(let sq=0;sq<64;sq++){
      const p=tBd[sq]; if(!p||p.piece==='K') continue;
      const col=getCaptureColor(sq,p.color,tBd,tAtk);
      if(col!=='none') drawThreatCircle(sq,col);
    }
  }

  // ── X-ray pressure rendering ──────────────────────────────────────────────
  if (showingXray && xrayData && xrayData.length > 0) {
    xrayData.forEach(({sliderSq, blockerSq, targetSq, side}) => {
      const {r:sr,c:sc} = sqCanvas(sliderSq);
      const {r:tr,c:tc} = sqCanvas(targetSq);
      const {r:br,c:bc} = sqCanvas(blockerSq);
      // Own x-ray (opportunity): black. Opponent x-ray (threat): amber.
      const isOpp = side==='opp';
      const col = isOpp ? 'rgba(200,120,0,0.85)' : 'rgba(0,0,0,0.65)';
      const colDim = isOpp ? 'rgba(200,120,0,0.4)' : 'rgba(0,0,0,0.35)';
      ctx.save(); ctx.setLineDash([4,3]);
      ctx.beginPath();
      ctx.moveTo(sc*SQ+SQ/2, sr*SQ+SQ/2);
      ctx.lineTo(tc*SQ+SQ/2, tr*SQ+SQ/2);
      ctx.strokeStyle=col; ctx.lineWidth=1.8; ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.arc(sc*SQ+SQ/2, sr*SQ+SQ/2, 26,0,Math.PI*2);
      ctx.strokeStyle=col; ctx.lineWidth=2; ctx.stroke();
      ctx.save(); ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.arc(bc*SQ+SQ/2, br*SQ+SQ/2, 24,0,Math.PI*2);
      ctx.strokeStyle=colDim; ctx.lineWidth=1.5; ctx.stroke();
      ctx.restore();
    });
  }

  currentlyPreviewing=isPreviewing; // expose to drawPieceUnder
  } catch(e){ console.warn('BG render err:',e); }
  } catch(e){ console.warn('BG indicator error:',e); }
  // Guarantee clean canvas state before drawing pieces
  ctx.setLineDash([]); ctx.globalAlpha=1; ctx.shadowBlur=0; ctx.save(); ctx.restore();
  // Cheap-attacker alert data for this frame. In direct mode dispAtk already
  // holds real attacker squares; battery mode stores synthetic arrays, so we
  // build one direct map for the displayed board (once, not per piece).
  _alertBoard = dispBoard;
  try {
    _alertDirectAtk = indActive('battery') ? buildDirectAtk(dispBoard) : dispAtk;
  } catch(e) { _alertDirectAtk = dispAtk; }
  // A piece parked awaiting confirmation is drawn semi-transparent — the
  // "not placed yet" convention. It reads as provisional without motion, which
  // a pulse would not: the board already carries a lot of overlay detail and an
  // animating piece competes with it on every move.
  const _ghostSq = (isPreviewing && awaitingConfirm) ? premoveTo : -1;
  const PARKED_ALPHA = 0.45;

  // Draw pieces — per-square try/catch prevents one crash from blanking the board
  for(let sq=0;sq<64;sq++){
    try{
      const p=dispBoard[sq];
      if(!p||(sq===dragFrom&&isDragging))continue;
      if(_pmVacated&&_pmVacated.has(sq))continue; // a queued premove takes it away
      if(sq===_ghostSq){ctx.save();ctx.globalAlpha=PARKED_ALPHA;}
      drawPieceUnder(sq,p,dispAtk,showLayers,showBull);
      if(sq===_ghostSq){ctx.restore();}
    }catch(e){console.warn('drawPieceUnder sq='+sq,e);}
  }
  for(let sq=0;sq<64;sq++){
    try{
      const p=dispBoard[sq];
      if(!p||(sq===dragFrom&&isDragging))continue;
      if(_pmVacated&&_pmVacated.has(sq))continue; // a queued premove takes it away
      if(sq===_ghostSq){ctx.save();ctx.globalAlpha=PARKED_ALPHA;}
      drawPieceGlyph(sq,p,dispAtk,showNums);
      if(sq===_ghostSq){ctx.restore();}
    }catch(e){console.warn('drawPieceGlyph sq='+sq,e);}
  }

  // Dashed outline on the parked square. Translucency alone is easy to miss on
  // a phone, and a dashed edge is a static "provisional" cue — no animation.
  if(_ghostSq>=0){
    try{
      const {r:_pr,c:_pc}=sqCanvas(_ghostSq);
      ctx.save();
      ctx.strokeStyle='rgba(40,40,40,0.75)';
      ctx.lineWidth=1.6;
      ctx.setLineDash([5,3.5]);
      ctx.strokeRect(_pc*SQ+1.6,_pr*SQ+1.6,SQ-3.2,SQ-3.2);
      ctx.restore();
    }catch(e){console.warn('parked outline',e);}
  }

  try{
  // ── Fork/Skewer/Discovered/X-ray FOREGROUND (bullseyes on top of pieces) ──
  function renderForkFg(forkData, skewerData, safeColor, contColor) {
    if (!forkData) return;
    // Draw dashed lines from forker to each attacked piece
    function drawForkLines(items, col){
      ctx.save(); ctx.setLineDash([4,3]);
      ctx.strokeStyle=col; ctx.lineWidth=1.3; ctx.globalAlpha=0.55;
      items.forEach(({sq, targets})=>{
        if(!sq||!targets) return;
        const{r:fr,c:fc}=sqCanvas(sq);
        const fx=fc*SQ+SQ/2, fy=fr*SQ+SQ/2;
        targets.forEach(t=>{
          const{r:tr,c:tc}=sqCanvas(t);
          ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(tc*SQ+SQ/2,tr*SQ+SQ/2); ctx.stroke();
        });
      });
      ctx.restore();
    }
    drawForkLines(forkData.current, safeColor);
    drawForkLines(forkData.safe, safeColor);
    drawForkLines(forkData.contested, contColor);
    forkData.current.forEach(({targets}) =>
      targets.forEach(t => drawYBBullseye(ctx,t,SQ,1.0,safeColor)));
    forkData.safe.forEach(({targets}) =>
      targets.forEach(t => drawYBBullseye(ctx,t,SQ,0.6,safeColor)));
    forkData.contested.forEach(({targets}) =>
      targets.forEach(t => drawYBBullseye(ctx,t,SQ,0.35,contColor)));
    if (skewerData) skewerData.forEach(({attackerSq,frontSq,backSq}) => {
      // Skewer ray on top of pieces
      const {r:ar,c:ac}=sqCanvas(attackerSq);
      const {r:br,c:bc}=sqCanvas(backSq);
      ctx.save(); ctx.setLineDash([6,3]);
      ctx.beginPath();
      ctx.moveTo(ac*SQ+SQ/2,ar*SQ+SQ/2);
      ctx.lineTo(bc*SQ+SQ/2,br*SQ+SQ/2);
      ctx.strokeStyle=safeColor; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
      drawYBBullseye(ctx,backSq,SQ,0.85,safeColor);
    });
  }
  if (showingForksW) renderForkFg(forkDataW,skewerDataW,wSafe,wCont);
  if (showingForksB) renderForkFg(forkDataB,skewerDataB,bSafe,bCont);

  // ── Premove fork danger: target on piece being premoved if it could be forked ──
  // Checks both CURRENT opponent forks (already forking the destination square)
  // AND NEXT-MOVE opponent forks (opponent can move somewhere to fork premoveTo next turn)
  // Both cases are already in oppForkData since it's computed on previewBoard
  // previewCollapsed means the piece is NOT on premoveTo in previewBoard — the
  // premove is not legal yet — so the fork data says nothing about landing there.
  if (previewBoard && premoveTo >= 0 && !previewCollapsed) {
    const oppForkData = (turn === 'w') ? forkDataB : forkDataW;
    // Opponent's forks are always "danger" colors for the active player
    const oppAccent   = 'rgba(220,50,50,0.92)'; // red = opponent safe fork danger
    if (oppForkData) {
      // Current forks hitting premoveTo = immediate fork danger
      const inCurrentFork = (oppForkData.current||[])
        .some(f => f.targets && f.targets.includes(premoveTo));
      // Next-move safe forks hitting premoveTo = opponent can fork next move safely  
      const inSafeFork = (oppForkData.safe||[])
        .some(f => f.targets && f.targets.includes(premoveTo));
      // Contested next-move forks (opponent must sacrifice to fork — less urgent)
      const inContestedFork = (oppForkData.contested||[])
        .some(f => f.targets && f.targets.includes(premoveTo));

      if (inCurrentFork || inSafeFork) {
        // Full-opacity bullseye in opponent's accent color — clear danger
        drawYBBullseye(ctx, premoveTo, SQ, 1.0, oppAccent);
      } else if (inContestedFork) {
        // Dimmer bullseye — opponent can fork but has to sacrifice to do it
        drawYBBullseye(ctx, premoveTo, SQ, 0.5, oppAccent);
      }
    }
  }

  // ── Sawtooth alert: the explored piece would HANG on its destination ──────
  // (attacked, zero defenders on the previewed board — fact, not judgment)
  // Only shown when threat/capture indicators are active (respects pro mode and button state)
  if (isPreviewing && premoveTo >= 0 && dispBoard[premoveTo] && dispBoard[premoveTo].piece !== 'K'
      && (indActive('threats') || indActive('captures'))) {
    const _hp = dispBoard[premoveTo];
    const _hA = dispAtk[premoveTo] || {w:[],b:[]};
    const _hAtt = (_hA[_hp.color==='w'?'b':'w'] || []).length;
    const _hDef = (_hA[_hp.color] || []).length;
    if (_hAtt > 0 && _hDef === 0) drawJaggedRing(ctx, premoveTo);
  }

  // Discovered attack targets on top of pieces — purple only
  if (showingDiscovered && discoveredData) {
    discoveredData.forEach(({threatenedSqs, isDiscoveredCheck}) => {
      const tc = isDiscoveredCheck ? 'rgba(220,180,255,0.9)' : 'rgba(160,80,220,0.85)';
      threatenedSqs.forEach(t => drawPurpleTarget(ctx,t,SQ,tc));
    });
  }
  // X-ray targets on top of pieces — own=black, opp=amber
  if (showingXray && xrayData) {
    xrayData.forEach(({targetSq, side}) => {
      const {r,c} = sqCanvas(targetSq);
      const x=c*SQ+SQ/2, y=r*SQ+SQ/2;
      const R1=13, R2=8, R3=4;
      const isOpp = side==='opp';
      const col     = isOpp ? 'rgba(200,120,0,0.85)' : 'rgba(0,0,0,0.75)';
      const colFill = isOpp ? 'rgba(200,120,0,0.55)' : 'rgba(0,0,0,0.60)';
      ctx.save();
      ctx.strokeStyle=col; ctx.fillStyle=colFill;
      ctx.beginPath(); ctx.arc(x,y,R1,0,Math.PI*2); ctx.lineWidth=2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x,y,R2,0,Math.PI*2); ctx.lineWidth=1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(x,y,R3,0,Math.PI*2); ctx.globalAlpha=0.6; ctx.fill(); ctx.globalAlpha=1;
      ctx.strokeStyle=col; ctx.lineWidth=0.8; ctx.globalAlpha=0.5;
      ctx.beginPath(); ctx.moveTo(x-R1-2,y); ctx.lineTo(x+R1+2,y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x,y-R1-2); ctx.lineTo(x,y+R1+2); ctx.stroke();
      ctx.globalAlpha=1;
      ctx.restore();
    });
  }

  // Skip the dim origin ghost during identity preview (piece is on its own
  // square — the real piece is already drawn there)
  if(isPreviewing&&premoveFrom>=0&&premoveFrom!==premoveTo&&board[premoveFrom]){
    const{r,c}=sqCanvas(premoveFrom);
    const _gp=board[premoveFrom];
    ctx.save(); ctx.globalAlpha=0.32;
    const _gi = currentPieceSet!=='unicode' ? pieceImgCache[currentPieceSet+_gp.color+_gp.piece] : null;
    if(_gi && _gi.complete && _gi.naturalWidth>0){
      ctx.drawImage(_gi, c*SQ+3, r*SQ+3, SQ-6, SQ-6);
    } else {
      // Fallback: unicode with dark shadow for visibility on any background
      ctx.shadowColor='rgba(0,0,0,0.9)'; ctx.shadowBlur=5;
      ctx.font=`${SQ-8}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=_gp.color==='w'?'rgba(240,240,240,0.95)':'rgba(30,30,30,0.95)';
      ctx.fillText(UNI[_gp.color+_gp.piece], c*SQ+SQ/2, r*SQ+SQ/2+1);
      ctx.shadowBlur=0;
    }
    ctx.restore();
  }
  // Draw the queued chain: each link is a dimmed ghost on its origin and a
  // blue-tinted one on its destination. Walk the speculative board as we go, so
  // link 2 is drawn from wherever link 1 will have left the piece.
  if(premoveQueue.length){
    let _pb=board;
    const _multi=premoveQueue.length>1;
    premoveQueue.forEach((_pm,_i)=>{
      const _pp=_pb[_pm.from];
      if(!_pp)return;   // chain broke earlier; nothing sensible left to draw
      const _pi=currentPieceSet!=='unicode'?pieceImgCache[currentPieceSet+_pp.color+_pp.piece]:null;
      // Origin: dimmed piece
      const{r:_fr,c:_fc}=sqCanvas(_pm.from);
      ctx.save();ctx.globalAlpha=0.28;
      if(_pi&&_pi.complete&&_pi.naturalWidth>0){ctx.drawImage(_pi,_fc*SQ+3,_fr*SQ+3,SQ-6,SQ-6);}
      else{ctx.font=`${SQ-8}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=_pp.color==='w'?'rgba(240,240,240,0.9)':'rgba(30,30,30,0.9)';ctx.fillText(UNI[_pp.color+_pp.piece],_fc*SQ+SQ/2,_fr*SQ+SQ/2+1);}
      ctx.restore();
      // Destination: blue-tinted piece
      const{r:_tr,c:_tc}=sqCanvas(_pm.to);
      ctx.save();ctx.globalAlpha=0.72;
      if(_pi&&_pi.complete&&_pi.naturalWidth>0){
        ctx.drawImage(_pi,_tc*SQ+3,_tr*SQ+3,SQ-6,SQ-6);
        ctx.fillStyle='rgba(60,120,220,0.30)';ctx.fillRect(_tc*SQ+3,_tr*SQ+3,SQ-6,SQ-6);
      }else{ctx.font=`${SQ-8}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='rgba(60,120,220,0.85)';ctx.fillText(UNI[_pp.color+_pp.piece],_tc*SQ+SQ/2,_tr*SQ+SQ/2+1);}
      // Order badge — only once there is an order to be confused about.
      if(_multi){
        const _bx=_tc*SQ+SQ-11,_by=_tr*SQ+11;
        ctx.beginPath();ctx.arc(_bx,_by,8,0,Math.PI*2);
        ctx.fillStyle='rgba(30,70,150,0.92)';ctx.fill();
        ctx.font='bold 11px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle='#fff';ctx.fillText(String(_i+1),_bx,_by+0.5);
      }
      ctx.restore();
      _pb=applyMove(_pm.from,_pm.to,_pb,-1,_pm.promo||'Q');
    });
  }
    if(isDragging&&dragFrom>=0){
    const p=board[dragFrom];if(p){
      const rect=cv.getBoundingClientRect();const scale=480/rect.width;
      const gx=mousePos.x*scale, gy=mousePos.y*scale;
      ctx.save(); ctx.globalAlpha=0.45;
      const _di=currentPieceSet!=='unicode'
        ? pieceImgCache[currentPieceSet+p.color+p.piece] : null;
      if(_di&&_di.complete&&_di.naturalWidth>0){
        const gs=SQ*0.9;
        ctx.shadowColor='rgba(0,0,0,0.5)';ctx.shadowBlur=6;
        ctx.drawImage(_di,gx-gs/2,gy-gs/2,gs,gs);
      } else {
        ctx.font=`${SQ+4}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.shadowColor='rgba(0,0,0,0.7)';ctx.shadowBlur=6;
        ctx.fillStyle=p.color==='w'?'rgba(240,240,240,0.9)':'rgba(20,20,20,0.9)';
        ctx.fillText(UNI[p.color+p.piece],gx,gy);
      }
      ctx.restore(); // single restore matching single save
    }
  }

  // exploration banner removed
  } catch(e){ console.warn('Indicator render error:',e); }
  // (no canvas flip to restore)
  // Draw rank/file labels in screen coords (after restore so not flipped)
  ctx.font='9px sans-serif';ctx.fillStyle='rgba(0,0,0,0.3)';
  for(let i=0;i<8;i++){
    if(_boardFlipped){
      ctx.fillText(String.fromCharCode(97+7-i),(480-((i+1)*SQ))+3,7*SQ+SQ-3);
      ctx.fillText(i+1,480-SQ+3,i*SQ+11);
    } else {
      ctx.fillText(String.fromCharCode(97+i),i*SQ+3,7*SQ+SQ-3);
      ctx.fillText(8-i,3,i*SQ+11);
    }
  }
  if(promotionPending)drawPromoModal();
}

function drawPieceUnder(sq,p,atk,showLayers,showBull){
  const{r:_r,c:_c}=sqCanvas(sq);const x=_c*SQ+SQ/2,y=_r*SQ+SQ/2+4;
  const opp=p.color==='w'?'b':'w';
  // Safe access — atk[sq] might not have entries during exploration
  const _sqAtk=atk[sq]||{w:[],b:[]};
  // Cap at 9 to prevent runaway loops if atk data is corrupt
  const def=Math.min(9,(_sqAtk[p.color]||[]).length);
  const att=Math.min(9,(_sqAtk[opp]||[]).length);
  const isHanging=p.piece!=='K'&&att>0&&def===0;
  const isUnprotected=p.piece!=='K'&&def===0&&att===0;
  const isOutnumbered=att>def&&att>0&&!isHanging;
  const isOverprotected=att>0&&def>att;
  const isEqual=att>0&&def===att;
  // Check if any attacker is cheaper than this piece (tactical alert)
  const PVALS={P:1,N:3,B:3,R:5,Q:9,K:100};
  const myVal=PVALS[p.piece]||0;
  const opp2=p.color==='w'?'b':'w';
  // We need actual attacker squares for value comparison — use the per-frame
  // direct map render() prepared for the displayed board (_alertDirectAtk).
  let cheapAttacker=false;
  if(att>0){
    const directAtk=_alertDirectAtk||atk;
    const alertBd=_alertBoard||board;
    const attackerSqs=(directAtk[sq]&&directAtk[sq][opp2])||[];
    for(const aSq of attackerSqs){
      const ap=alertBd[aSq];
      if(ap&&(PVALS[ap.piece]||0)<myVal){cheapAttacker=true;break;}
    }
  }
  const isRedAlert=isHanging||isOutnumbered||cheapAttacker;
  const isContested=att>0&&att<=def;
  // showStatusRings removed — rings now purely halos
  // King in check: highlight with check-threat colors
  if(p.piece==='K'&&inCheck(board,p.color)){
    ctx.beginPath();ctx.arc(x,y,27,0,Math.PI*2);
    ctx.strokeStyle=currentPalette.checkStroke;ctx.lineWidth=4;ctx.stroke();
    ctx.beginPath();ctx.arc(x,y,31,0,Math.PI*2);
    ctx.strokeStyle=currentPalette.checkStroke;ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.arc(x,y,23,0,Math.PI*2);
    ctx.fillStyle=currentPalette.checkFill;ctx.fill();
  }
  // Status rings removed — Threats/Captures buttons now handle circles
  // Halos disabled

  if(showBull){
    if(def===0&&p.piece!=='K'){  // All unprotected pieces (whether attacked or not)
      ctx.save();const lightSq=(_r+_c)%2===0;
      const c1=lightSq?currentPalette.bull1:'rgba(255,255,255,0.78)',c2=lightSq?currentPalette.bull2:'rgba(255,255,255,0.38)';
      const radii=[8,14,20,26];
      for(let i=0;i<radii.length;i++){ctx.beginPath();ctx.arc(x,y,radii[i],0,Math.PI*2);ctx.strokeStyle=i%2===0?c1:c2;ctx.lineWidth=i===0?1.8:1.2;ctx.stroke();}
      ctx.strokeStyle=c2;ctx.lineWidth=0.7;ctx.beginPath();ctx.moveTo(x-29,y);ctx.lineTo(x+29,y);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y-29);ctx.lineTo(x,y+29);ctx.stroke();ctx.restore();
    }
  }
  // Pin overlay — use preview pins if previewing, else board pins
  if(indActive('pins')){
    const dispPW=currentlyPreviewing?previewPinsW:pinnedWSquares;
    const dispPB=currentlyPreviewing?previewPinsB:pinnedBSquares;
    const isPinned=(p.color==='w'?dispPW:dispPB).has(sq);
    if(isPinned){
      ctx.save();
      // Draw a pin — vertical line with a circle head
      const pinColor=currentPalette.pin;
      // Pin shaft
      ctx.strokeStyle=pinColor;ctx.lineWidth=2.5;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(x,y-26);ctx.lineTo(x,y+20);ctx.stroke();
      // Pin head (circle)
      ctx.beginPath();ctx.arc(x,y-26,5,0,Math.PI*2);
      ctx.fillStyle=pinColor;ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=1;ctx.stroke();
      // Pin point (small triangle at bottom)
      ctx.fillStyle=pinColor;
      ctx.beginPath();ctx.moveTo(x-3,y+18);ctx.lineTo(x+3,y+18);ctx.lineTo(x,y+24);ctx.closePath();ctx.fill();
      ctx.restore();
    }
  }
}

// Solid filled glyph variants — black unicode glyphs are fully filled shapes
const UNI_SOLID={wK:'♚',wQ:'♛',wR:'♜',wB:'♝',wN:'♞',wP:'♟',bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟'};

function drawPieceGlyph(sq,p,atk,showNums){
  const{r,c}=sqCanvas(sq);const x=c*SQ+SQ/2,y=r*SQ+SQ/2+4;
  const opp=p.color==='w'?'b':'w';
  const _sqAtk2=atk[sq]||{w:[],b:[]};
  const def=Math.min(9,(_sqAtk2[p.color]||[]).length);
  const att=Math.min(9,(_sqAtk2[opp]||[]).length);

  // Use image piece set if available
  if(typeof currentPieceSet!=='undefined'&&currentPieceSet!=='unicode'){
    const img=pieceImgCache[currentPieceSet+p.color+p.piece];
    if(img&&img.src){
      const pad=3;
      ctx.drawImage(img,c*SQ+pad,r*SQ+pad,SQ-pad*2,SQ-pad*2);
      if(showNums&&(def>0||att>0)){
        // White numbers on filled green/red circles — both on right side
        const nr=7;
        const ncx=c*SQ+SQ-nr-3; // right side x
        const ncy_def=r*SQ+nr+3; // top-right for defenders
        const ncy_att=r*SQ+SQ-nr-3; // bottom-right for attackers
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font=`bold ${Math.round(nr*1.3)}px sans-serif`;
        if(def>0){
          ctx.beginPath();ctx.arc(ncx,ncy_def,nr,0,Math.PI*2);
          ctx.fillStyle='rgba(20,180,60,0.92)';ctx.fill();
          ctx.fillStyle='#fff';ctx.fillText(def,ncx,ncy_def);
        }
        if(att>0){
          ctx.beginPath();ctx.arc(ncx,ncy_att,nr,0,Math.PI*2);
          ctx.fillStyle='rgba(210,40,40,0.92)';ctx.fill();
          ctx.fillStyle='#fff';ctx.fillText(att,ncx,ncy_att);
        }
      }
      return;
    }
  }

  const isHanging=p.piece!=='K'&&att>0&&def===0;
  const isOutnumbered=att>def&&att>0&&!isHanging;
  const glyph=UNI_SOLID[p.color+p.piece];
  ctx.font=`${SQ-8}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  if(p.color==='w'){
    // Solid white fill using filled glyph — square color shows through cutouts naturally
    ctx.fillStyle='#ffffff';
    ctx.fillText(glyph,x,y+1);
    // Thin black stroke on top for definition on light squares
    ctx.strokeStyle='rgba(0,0,0,0.75)';
    ctx.lineWidth=1.4;ctx.lineJoin='round';
    ctx.strokeText(glyph,x,y+1);
  }else{
    ctx.fillStyle='#111111';
    ctx.fillText(glyph,x,y+1);
  }
  if(showNums){
    if(def>0){ctx.beginPath();ctx.arc(x+15,y-15,7,0,Math.PI*2);ctx.fillStyle='#22a85a';ctx.fill();ctx.font='bold 9px sans-serif';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(def,x+15,y-15);}
    if(att>0){ctx.beginPath();ctx.arc(x+15,y+15,7,0,Math.PI*2);ctx.fillStyle=isHanging?'#ff5500':isOutnumbered?'#cc1100':'#e03535';ctx.fill();ctx.font='bold 9px sans-serif';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(att,x+15,y+15);}
  }
}

function drawPromoModal(){
  const col=promotionPending.color;const pieces=['Q','R','B','N'];
  const bw=220,bh=72,bx=(480-bw)/2,by=(480-bh)/2;
  ctx.fillStyle='rgba(0,0,0,0.6)';ctx.fillRect(0,0,480,480);
  ctx.fillStyle='#f5f5f5';ctx.strokeStyle='#888';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.roundRect(bx,by,bw,bh,8);ctx.fill();ctx.stroke();
  ctx.font='11px sans-serif';ctx.fillStyle='#444';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText('Choose promotion piece:',240,by+7);
  for(let i=0;i<4;i++){ctx.font='28px serif';ctx.fillStyle=col==='w'?'#fff':'#111';ctx.shadowColor='rgba(0,0,0,0.5)';ctx.shadowBlur=2;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(UNI[col+pieces[i]],bx+28+i*52,by+44);ctx.shadowBlur=0;}
}

function loadPos(idx){
  gameOver=false;promotionPending=null;premoveQueue=[];selSq=-1;legalMoves=[];dragFrom=-1;dragMoved=false;hoverSq=-1;clearPreview();
  gameMovesAlgebraic=[];gameOverMsg="";
  board=parseFen(FENS[idx]);atkMap=buildAtk(board);
  // Reset draw tracking; the starting position counts as its first occurrence
  positionCounts={};halfmoveClock=0;
  try{ positionCounts[positionKey(board,turn,castling,epSq)]=1; }catch(e){}
  const _lp=computePins(board);pinnedWSquares=_lp.w;pinnedBSquares=_lp.b;
  if(typeof indInitAll==='function'){indInitAll();indApply();}
  updatePlayerBoxes();render();
}

// ── Resign / new game ─────────────────────────────────────────────────────────
function resignOrReset(){
  if(gameOver){ resetGame(); return; }
  showResignConfirm();
}
function showResignConfirm(){
  let o=document.getElementById('resignOverlay');
  if(!o){
    o=document.createElement('div');
    o.id='resignOverlay';
    o.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.72);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;border-radius:4px;z-index:50;';
    o.innerHTML='<div style="color:#f0ede8;font-size:13px;font-weight:600;">Resign this game?</div>'
      +'<div style="display:flex;gap:10px;">'
      +'<button onclick="confirmResign()" style="padding:6px 18px;background:#c03030;border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer;font-weight:600;">Yes, resign</button>'
      +'<button onclick="cancelResign()" style="padding:6px 18px;background:rgba(255,255,255,0.12);border:0.5px solid rgba(255,255,255,0.3);border-radius:5px;color:#f0ede8;font-size:11px;cursor:pointer;">Cancel</button>'
      +'</div>';
    const cv=document.getElementById('cv');
    if(cv&&cv.parentElement){cv.parentElement.style.position='relative';cv.parentElement.appendChild(o);}
  }
  o.style.display='flex';
}
function cancelResign(){
  const o=document.getElementById('resignOverlay');
  if(o) o.style.display='none';
}
function confirmResign(){
  cancelResign();
  // Notify opponent if playing online
  if (mpRoomId && mpWs && mpWs.readyState === WebSocket.OPEN)
    mpWs.send(JSON.stringify({ type: 'resign' }));
  // Who resigned? Online/solo uses side-to-move; vs a bot it's always the human
  // (botPlayerColor is the human's colour), regardless of whose turn it is.
  let loser = turn;
  if (typeof botActive !== 'undefined' && botActive && typeof botPlayerColor !== 'undefined')
    loser = (botPlayerColor === 'white') ? 'w' : 'b';
  gameOver=true;
  gameOverMsg=(loser==='w'?'White resigned — Black wins!':'Black resigned — White wins!');
  updatePlayerBoxes();
  showRematchBtn(true);
}
function mpAcceptRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) {
    mpWs.send(JSON.stringify({ type: 'rematch' }));
  }
  mpRole = mpOriginalRole || mpRole;
  mpStartGame(mpSelectedTC);
  mpShowStatus('Rematch! ' + (mpRole === 'white' ? 'You are White ♔' : 'You are Black ♚'));
}

function mpDeclineRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) {
    mpWs.send(JSON.stringify({ type: 'rematch_declined' }));
  }
  mpShowStatus('Rematch declined.');
}

function mpOfferRematch() {
  if (mpWs && mpWs.readyState === WebSocket.OPEN) {
    mpWs.send(JSON.stringify({ type: 'rematch_offer' }));
    mpShowStatus('Rematch offered — waiting for opponent…');
  } else {
    // Solo / no connection — just reset
    showRematchBtn(false); resetGame();
  }
}

// ── Dynamic action button (first slot of the bottom controls) ───────────────
// Game in progress → Resign · game just ended → Rematch? · idle → Training Tips
function _gameInProgress() {
  if (gameOver) return false;
  if (typeof botActive !== 'undefined' && botActive) return true;
  if (typeof mpRoomId !== 'undefined' && mpRoomId &&
      typeof mpMode !== 'undefined' && mpMode === 'ingame') return true;
  return gameMovesAlgebraic.length > 0;
}

// The Draw/Resign row is shown for bot and 2-player games and hidden the rest
// of the time. Read what is actually on screen rather than re-deriving the
// condition, so the two can't drift apart again.
function _resignRowVisible() {
  const ga = document.getElementById('gameActions');
  return !!(ga && ga.offsetParent !== null);
}

// Buttons that start or replace a game have no business being on screen while
// one is running: "vs Bot" restarts, "2-Player" abandons, "Load game" throws the
// position away, and each is one mis-tap from losing a game in progress. They
// come straight back the moment it ends, which is when they are wanted again.
function updateGameStartBtns() {
  const live = (typeof _isLiveGame === 'function') ? _isLiveGame() : false;
  ['botSidebarBtn', 'mpSidebarBtn', 'btnLoadPgn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = live ? 'none' : '';
  });
}

// One row, five buttons. While a game is live it carries Offer draw and
// Resign; the moment the game ends the SAME row carries Rematch and Review,
// because that is where the player's eyes already are. Nothing moves — only
// which of the five is on screen changes.
//
// Training Tips used to share this slot and is now a permanent button on the
// floor, so this control has one job and can simply hide when idle.
function syncActionRow() {
  const ga      = document.getElementById('gameActions');
  const drawBtn = document.querySelector('#gameActions .draw-btn');
  const resBtn  = document.querySelector('#gameActions .resign-btn');
  const btn     = document.getElementById('resignBtn');
  const review  = document.getElementById('reviewBtn');
  const explore = document.getElementById('exploreBtn');
  if (!ga || !btn) return;

  const inGame  = _gameInProgress();
  const isSolo  = !(typeof botActive !== 'undefined' && botActive) &&
                  !(typeof mpRoomId !== 'undefined' && mpRoomId &&
                    typeof mpMode !== 'undefined' && mpMode === 'ingame');
  const canReview = gameOver && typeof gameMovesAlgebraic !== 'undefined' &&
                    gameMovesAlgebraic.length > 0 && !inReplay;

  const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

  if (gameOver) {
    show(drawBtn, false); show(resBtn, false);
    btn.textContent = '\u21ba Rematch?';
    btn.className = 'gbtn rematch-btn';
    btn.onclick = () => {
      if (typeof mpRoomId !== 'undefined' && mpRoomId) mpOfferRematch();
      else if (typeof botActive !== 'undefined' && botActive) botStart();
      else resetGame();
    };
    show(btn, true);
    show(review, canReview);
    show(explore, true);
  } else if (inGame && isSolo) {
    // Solo exploration: nothing to resign, but a reset is worth reaching for.
    show(drawBtn, false); show(resBtn, false);
    btn.textContent = '\u21ba Reset';
    btn.className = 'gbtn';
    btn.onclick = resetGame;
    show(btn, true);
    show(review, false); show(explore, false);
  } else if (inGame) {
    // Bot or online game running: Draw and Resign own the row.
    show(drawBtn, true); show(resBtn, true);
    show(btn, false); show(review, false); show(explore, false);
  } else {
    // Idle. Draw and Resign have to be hidden explicitly: something upstream
    // sets the row to display:flex on load, and leaving these two alone meant
    // an empty board offered you a resignation.
    show(drawBtn, false); show(resBtn, false);
    show(btn, false); show(review, false); show(explore, false);
  }

  // The row exists only when it has something in it. Any visible child keeps
  // it up; none, and it collapses so the floor does not carry a dead gap.
  const any = [drawBtn, resBtn, btn, review, explore]
    .some(el => el && el.style.display !== 'none');
  ga.style.display = any ? 'flex' : 'none';
}

function updateActionBtn() {
  updateGameStartBtns();
  syncActionRow();
  // The quick-start block names the bot it will start, so it has to follow any
  // change the builder made while this was last off screen.
  if (typeof quickBotSync === 'function') quickBotSync();
}

// Legacy entry point — many callers still announce game end through this.
// The button is fully state-driven now, so just refresh it.
function showRematchBtn(show) { updateActionBtn(); }

// ── Post-game explore mode ───────────────────────────────────────────────────
// Keeps the final position on the board but drops the bot/2-player context,
// so the game becomes a solo exploration (either side movable, ghosts allowed).
function enterExploreMode() {
  const keepFlip = (typeof boardFlipped !== 'undefined') && boardFlipped;
  if (typeof botActive !== 'undefined' && botActive && typeof botStop === 'function') {
    botStop(); // clears bot state; does not touch the board
  }
  if (typeof mpRoomId !== 'undefined' && mpRoomId) {
    // mpLeave() resets the board — dismantle the room state by hand instead
    if (mpWs) { try { mpWs.close(); } catch(e) {} mpWs = null; }
    mpRoomId = null; mpRole = null; mpConnected = false;
    mpOriginalRole = null; mpGameCount = 0;
    const rc = document.getElementById('mpRoomCode'); if (rc) rc.textContent = '';
    if (typeof chatShow === 'function') chatShow(false);
    const cm = document.getElementById('chatMessages'); if (cm) cm.innerHTML = '';
    const ga = document.getElementById('gameActions'); if (ga) ga.style.display = 'none';
    if (typeof mpSetMode === 'function') mpSetMode('idle');
  }
  // Keep the orientation the game was played at (botStop/teardown unflips)
  boardFlipped = keepFlip;
  const bc = document.getElementById('board-col');
  if (bc) bc.classList.toggle('board-flipped', keepFlip);
  if (typeof clockStop === 'function') clockStop();
  gameOver = false;
  gameOverMsg = '';
  selSq = -1; legalMoves = []; clearPreview();
  // Reset to starting position so exploration begins from the opening,
  // not from the final (often chaotic) position of the finished game.
  loadPos(0);
  atkMap = buildAtk(board);
  if (typeof updatePlayerBoxes === 'function') updatePlayerBoxes();
  updateActionBtn();
  render();
}

function resetGame(){
  // Drop the previous game's snapshot immediately. Waiting for the first move
  // of the new game to overwrite it would let a reload before that move
  // restore the game the user just abandoned.
  if(typeof bmSessionClear==='function') bmSessionClear();
  cancelResign();showRematchBtn(false);clockStop();clockInit(clockControl);
  lastMoveFrom=-1;lastMoveTo=-1;_gameStartFen=null;_gameStartSans=[];
  // Every game start funnels through here: kill any lingering replay/review
  // state so the old game's move selector can't hijack the new game's board.
  // (Continuations re-apply their FEN + SAN prefix AFTER this reset.)
  if(typeof _exitReplayKeepBoard==='function') _exitReplayKeepBoard();
  // Clear a stale bot draw-offer toast from the previous game
  const _dt=document.getElementById('bm-bot-draw');if(_dt)_dt.remove();
  const sg=document.getElementById("saveGameBtn");if(sg)sg.remove();
  loadPos(0);
  if(typeof distReset==='function')distReset();
}
function setPalette(name){currentPalette=PALETTES[name]||PALETTES.default;render();}

let _savedMarkings=null;
function clearAllMarkings(){
  const OVERLAY_CBS=['cbLayers','cbNums','cbBull','cbStatusRings','cbInfluence','cbPins','cbQPins'];
  const btn=document.getElementById('btnClearAll');
  if(_savedMarkings===null){
    // Save current state and clear
    _savedMarkings={};
    OVERLAY_CBS.forEach(id=>{
      const el=document.getElementById(id);
      if(el){_savedMarkings[id]=el.checked;el.checked=false;}
    });
    if(btn) btn.textContent='Restore markings';
  } else {
    // Restore saved state
    OVERLAY_CBS.forEach(id=>{
      const el=document.getElementById(id);
      if(el&&_savedMarkings[id]!==undefined) el.checked=_savedMarkings[id];
    });
    _savedMarkings=null;
    if(btn) btn.textContent='Clear all markings';
  }
  rebuildAtk();
}

// ── Overloaded piece detection ───────────────────────────────────────────────
// A piece is "overloaded" (overworked) if it is the SOLE defender of 2+ other pieces.
// Returns:
//   overloaded: Map<sq, Set<sq>>  — overloaded piece sq -> set of dependent piece sqs
//   dependent:  Map<sq, sq>       — dependent piece sq -> its sole defender sq
function computeOverloaded(bd, atk) {
  // For each piece, find which pieces it solely defends
  // "solely defends" means: defender count for that piece is exactly 1,
  //  and this piece is that one defender.
  const overloaded = new Map(); // defender sq -> Set of dependent sqs
  const dependent  = new Map(); // dependent sq -> defender sq

  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.piece === 'K') continue;
    const opp = p.color === 'w' ? 'b' : 'w';
    const defenders = atk[sq][p.color];

    // Only interested in pieces with exactly 1 defender
    if (defenders.length !== 1) continue;
    // And that defender must be under some attack pressure
    // (an overloaded piece must actually be needed for defense)
    const defSq = defenders[0];
    const defP  = bd[defSq];
    if (!defP) continue;

    // This piece (sq) is solely defended by defSq
    // Add to dependent map
    dependent.set(sq, defSq);

    // Add to overloaded map
    if (!overloaded.has(defSq)) overloaded.set(defSq, new Set());
    overloaded.get(defSq).add(sq);
  }

  // Filter: only keep defenders that solely defend 2+ pieces
  for (const [defSq, deps] of overloaded) {
    if (deps.size < 2) {
      overloaded.delete(defSq);
      // Remove from dependent too
      for (const depSq of deps) dependent.delete(depSq);
    }
  }

  return { overloaded, dependent };
}

function startOverloaded(e) {
  if (e && e.preventDefault) e.preventDefault();
  showingOverloaded = true;
  const dispAtk = previewAtk || atkMap;
  const dispBoard = previewBoard || board;
  overloadedData = computeOverloaded(dispBoard, dispAtk);
  render();
}
function stopOverloaded() {
  showingOverloaded = false;
  overloadedData = null;
  render();
}

// ── Material advantage ───────────────────────────────────────────────────────
const PIECE_VALS={P:1,N:3,B:3,R:5,Q:9};
const PIECE_GLYPHS={P:'♙',N:'♘',B:'♗',R:'♖',Q:'♕'};

function computeMaterial(bd){
  let w=0,b=0,wPieces={},bPieces={};
  for(let s=0;s<64;s++){
    const p=bd[s];if(!p||p.piece==='K')continue;
    const v=PIECE_VALS[p.piece]||0;
    if(p.color==='w'){w+=v;wPieces[p.piece]=(wPieces[p.piece]||0)+1;}
    else{b+=v;bPieces[p.piece]=(bPieces[p.piece]||0)+1;}
  }
  return{w,b,wPieces,bPieces};
}

// Glyphs for the piece TYPES this side has more of, plus the numeric lead when
// `lead > 0`. Pass lead = 0 to show glyphs without a number.
//
// Both sides get glyphs; only the side that is actually ahead gets the "+N".
// This used to render glyphs for the leading side only, which silently
// overstated the lead after any uneven trade: the surplus is computed per piece
// type and never accounted for the types that side was BEHIND on. Queen traded
// for two rooks showed "♖♖ +1" — indistinguishable at a glance from being up
// two whole rooks. A promoted queen while a pawn down showed "♕♙ +5", claiming
// a pawn the player did not have. Showing the other side's surplus too makes
// the trade legible: ♕ against ♖♖, with the +1 on whoever it belongs to.
function matAdvString(lead, pieces, oppPieces){
  const surplus=[];
  for(const [pc,cnt] of Object.entries(pieces)){
    const extra=cnt-(oppPieces[pc]||0);
    for(let i=0;i<extra;i++) surplus.push(pc);
  }
  if(!surplus.length && lead<=0) return '';
  surplus.sort((a,b)=>(PIECE_VALS[b]||0)-(PIECE_VALS[a]||0));
  const glyphs=surplus.map(p=>PIECE_GLYPHS[p]||'').join('');
  return `<span style="font-size:13px;color:var(--text-primary);">${glyphs}</span>`
       + (lead>0
           ? `<span style="font-size:9px;color:var(--text-secondary);margin-left:3px;">+${lead}</span>`
           : '');
}

function updatePlayerBoxes(){
  const mat = computeMaterial(board);
  const diff = mat.w - mat.b;
  const inChk = inCheck(board, turn);
  const isWhiteTurn = turn === 'w';

  // ── Material bars ────────────────────────────────────────────────
  const matW = document.getElementById('matW');
  const matB = document.getElementById('matB');
  // Both sides show what they are up in piece types; only the side actually
  // ahead gets the numeric lead. See matAdvString for why showing one side
  // alone misrepresented uneven trades.
  if(matW) matW.innerHTML = matAdvString(diff > 0 ?  diff : 0, mat.wPieces, mat.bPieces);
  if(matB) matB.innerHTML = matAdvString(diff < 0 ? -diff : 0, mat.bPieces, mat.wPieces);

  // ── Player names in multiplayer ──────────────────────────────────────────────
  const pNameW = document.querySelector('#playerBoxW .player-name');
  const pNameB = document.querySelector('#playerBoxB .player-name');
  if(typeof mpRoomId!=='undefined' && mpRoomId && mpRole){
    if(pNameW) pNameW.textContent = mpRole==='white' ? 'You (White)' : 'Opponent (White)';
    if(pNameB) pNameB.textContent = mpRole==='black' ? 'You (Black)' : 'Opponent (Black)';
  } else if (botActive) {
    // Bot game — names set by botUpdatePlayerNames, don't overwrite
  } else {
    if(pNameW) pNameW.textContent = 'White';
    if(pNameB) pNameB.textContent = 'Black';
  }

  // ── Turn pill — move to active box ───────────────────────────────
  const turnPill = document.getElementById('turnPill');
  const boxW = document.getElementById('playerBoxW');
  const boxB = document.getElementById('playerBoxB');
  if(turnPill){
    turnPill.textContent = inChk ? '⚠ Check!' : '▶ to move';
    turnPill.className = inChk ? 'turn-pill check-pill' : 'turn-pill';
    const activeRight   = document.getElementById(isWhiteTurn ? 'rightColW' : 'rightColB');
    const inactiveRight = document.getElementById(isWhiteTurn ? 'rightColB' : 'rightColW');
    if(activeRight   && !activeRight.contains(turnPill))   activeRight.appendChild(turnPill);
    if(inactiveRight &&  inactiveRight.contains(turnPill)) inactiveRight.removeChild(turnPill);
  }

  // ── Hint text ────────────────────────────────────────────────────
  const hint = document.getElementById('hintText');
  if(hint){
    if(gameOver){
      hint.textContent = gameOverMsg;
      hint.className = 'hint-text check';
      // Also put message in black's box
      const matBEl = document.getElementById('matB');
      if(matBEl) matBEl.innerHTML = '<span style="font-size:10px;font-weight:600;color:#c03030;">' + gameOverMsg + '</span>';
    } else if(inChk){
      hint.textContent = 'King must move, block, or capture';
      hint.className = 'hint-text check';
    } else if(awaitingConfirm){
      hint.textContent = 'Move not played yet — tap the outlined square to confirm';
      hint.className = 'hint-text';
    } else if(isWhiteTurn){
      hint.textContent = isConfirmMode()
        ? 'Drag a piece · let go to park it · tap again to play'
        : 'Click a piece · hover to explore · click again to commit';
      hint.className = 'hint-text';
    } else {
      hint.textContent = "Black to move";
      hint.className = 'hint-text';
    }
  }

  // ── Box border highlight ─────────────────────────────────────────
  const activeColor  = inChk ? 'rgba(180,40,40,0.5)' : 'rgba(74,159,212,0.35)';
  const inactiveColor = 'var(--border)';
  if(boxW) boxW.style.borderColor = isWhiteTurn  ? activeColor : inactiveColor;
  if(boxB) boxB.style.borderColor = !isWhiteTurn ? activeColor : inactiveColor;

  // ── Clock ────────────────────────────────────────────────────────
  const timeW = document.getElementById('timeW');
  const timeB = document.getElementById('timeB');
  // Only show '—' if clock is untimed; otherwise let clockUpdateDisplay handle it
  const _clockActive = typeof clockControl!=='undefined' && clockControl!=='untimed';
  if(timeW && !mpRoomId){
    if(!_clockActive) timeW.textContent = '—';
    timeW.className = 'player-time' + (isWhiteTurn ? ' active' : ' solo');
  }
  if(timeB && !mpRoomId){
    if(!_clockActive) timeB.textContent = '—';
    timeB.className = 'player-time' + (!isWhiteTurn ? ' active' : ' solo');
  }
  // Refresh clock display when timed
  if(_clockActive && typeof clockUpdateDisplay==='function') clockUpdateDisplay();
  // Keep the dynamic action button (Resign / Rematch? / Training Tips) in sync
  if(typeof updateActionBtn==='function') updateActionBtn();
  // Reflect ghost-availability (off during live 2-player games)
  if(typeof mpUpdateGhostAvailability==='function') mpUpdateGhostAvailability();
  // Auto-save the game once it ends (and offer a save-as download)
  // Keep the commit chip in the player's own clock box: which box that is
  // changes with the board flip, and this is the one function that already
  // runs after every move and turn change.
  if(typeof syncCommitChipMount==='function') syncCommitChipMount();
  if(typeof maybeAutoSaveGame==='function') maybeAutoSaveGame();
  // A finished multiplayer game has nothing to rejoin — drop the seat token so
  // a later reload does not try to resume a game that is already over.
  if(gameOver && typeof mpSessionClear==='function') mpSessionClear();
  // Snapshot the live game so a backgrounded phone can come back to it. Sits
  // here because this is the one function that already runs after every move.
  if(typeof maybeSessionSave==='function') maybeSessionSave();
  // Keep the pro side column (clocks, names, notation, turn) in sync
  if(typeof proMode!=='undefined' && proMode && typeof proSync==='function') proSync();
}

function stopCheckThreats(){showingCheckThreats=false;checkThreatSquaresW=new Set();checkThreatSquaresB=new Set();render();}

// ── Static Exchange Evaluation for fork landing squares ─────────────────────
// Returns net material score for `color` if their piece of type `pieceType`
// moves to `toSq` on board `bd`. Positive = profitable, negative = losing.
// Static Exchange Evaluation for landing a piece of `pieceType`/`color` on
// `toSq`. Returns the net material the mover comes out ahead (positive = good
// for the mover) assuming both sides capture optimally with the cheapest piece
// available at each step. Standard swap-off algorithm with negamax fold-back:
// each side may "stand pat" rather than recapture if capturing would lose.
//
// This is the gate the next-move fork filter uses to decide whether a forking
// landing square is safe. It MUST account for defended recaptures — e.g. a
// knight jumping to a square guarded by the enemy queen but defended by our
// bishop is perfectly safe (they never take, and if they did we win the queen),
// so the SEE there is >= 0, not "-knight".
function seeLandingScore(toSq, pieceType, color, bd) {
  const opp = color === 'w' ? 'b' : 'w';
  // Piece currently standing on toSq (if any) is the first thing we win.
  const gains = [ bd[toSq] ? (PIECE_VAL[bd[toSq].piece] || 0) : 0 ];

  // Working board: our piece now sits on toSq (whatever it captured is gone).
  let b2 = {...bd};
  b2[toSq] = { piece: pieceType, color };

  let side = opp;                 // opponent moves next (the recapture)
  let onSquareVal = PIECE_VAL[pieceType] || 0; // value of the piece now on toSq
  let depth = 0;

  // Build the raw gain sequence: at each ply the side-to-move captures the
  // piece on toSq with its cheapest attacker; that attacker now sits on toSq.
  while (true) {
    const atks = currentAttackersOf(toSq, side, b2);
    if (!atks.length) break;
    const { sq: aSq, val: aVal } = atks[0]; // cheapest attacker (val from core)
    // This side gains the value of the piece it captures off toSq.
    gains[++depth] = onSquareVal - gains[depth - 1];
    onSquareVal = aVal;           // the capturing piece now occupies toSq
    const nb = {...b2};
    nb[toSq] = nb[aSq]; delete nb[aSq];
    b2 = nb;
    side = side === 'w' ? 'b' : 'w';
    if (depth > 31) break;        // safety
  }

  // Negamax fold-back: from the deepest capture upward, the side to move takes
  // the better of "don't recapture" (keep prior gain) vs "recapture" (this gain).
  for (let i = depth - 1; i >= 0; i--) {
    gains[i] = -Math.max(-gains[i], gains[i + 1]);
  }
  return gains[0];
}

// ── Fork & Skewer detection ──────────────────────────────────────────────────
const PIECE_VAL = {P:1, N:3, B:3, R:5, Q:9, K:100};

// Draw color-matched bullseye — rings match the fork accent color
// accentColor: rgba string matching the fork's arrows/rings
// alpha: 1.0 for current fork, 0.55 for potential fork targets
function drawYBBullseye(ctx, sq, SQ, alpha=1.0, accentColor='rgba(240,192,0,0.95)') {
  const {r,c} = sqCanvas(sq);
  const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Outer accent ring
  ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI*2);
  ctx.fillStyle = accentColor; ctx.fill();
  ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.lineWidth=1; ctx.stroke();
  // Black middle ring
  ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI*2);
  ctx.fillStyle = '#111111'; ctx.fill();
  // Inner accent ring
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2);
  ctx.fillStyle = accentColor; ctx.fill();
  // Centre black dot
  ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2);
  ctx.fillStyle = '#111111'; ctx.fill();
  // Crosshair in accent color
  ctx.strokeStyle = accentColor; ctx.lineWidth=0.8; ctx.globalAlpha=alpha*0.6;
  ctx.beginPath(); ctx.moveTo(x-18,y); ctx.lineTo(x+18,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,y-18); ctx.lineTo(x,y+18); ctx.stroke();
  ctx.restore();
}

// Draw an arrow from center of fromSq to center of toSq
function drawForkArrow(ctx, fromSq, toSq, SQ, color='rgba(240,192,0,0.85)', dashed=false) {
  const {r:fr,c:fc} = sqCanvas(fromSq);
  const {r:tr,c:tc} = sqCanvas(toSq);
  const x1 = fc*SQ+SQ/2, y1 = fr*SQ+SQ/2;
  const x2 = tc*SQ+SQ/2, y2 = tr*SQ+SQ/2;
  const angle = Math.atan2(y2-y1, x2-x1);
  const headLen = 12, headWid = 0.4;
  // Shorten end to not overlap bullseye
  const dist = Math.sqrt((x2-x1)**2+(y2-y1)**2);
  const shorten = 16;
  const ex = x2 - Math.cos(angle)*shorten;
  const ey = y2 - Math.sin(angle)*shorten;

  ctx.save();
  if (dashed) ctx.setLineDash([6,3]);
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(ex,ey); ctx.stroke();
  // Arrowhead
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ex,ey);
  ctx.lineTo(ex - headLen*Math.cos(angle-headWid), ey - headLen*Math.sin(angle-headWid));
  ctx.lineTo(ex - headLen*Math.cos(angle+headWid), ey - headLen*Math.sin(angle+headWid));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Draw a glowing square highlight on a landing square
function drawLandingSquare(ctx, sq, SQ, color='rgba(240,192,0,0.45)', borderColor='rgba(240,192,0,0.9)') {
  const {r,c} = sqCanvas(sq);
  ctx.fillStyle = color;
  ctx.fillRect(c*SQ, r*SQ, SQ, SQ);
  ctx.strokeStyle = borderColor; ctx.lineWidth = 2.5;
  ctx.strokeRect(c*SQ+1, r*SQ+1, SQ-2, SQ-2);
}

// Draw a dinner fork symbol on a square
// Proportions: handle ~60%, shoulder curves between outermost tines, four tines 30%
function drawForkSymbol(ctx, sq, SQ, color='rgba(240,192,0,0.92)', alpha=1.0) {
  const {r,c} = sqCanvas(sq);
  const cx = c*SQ + SQ/2;
  const cy = r*SQ + SQ/2;
  const h = SQ * 0.72;
  const tineTop = cy - h*0.48;
  const shoulderY = tineTop + h*0.30;  // where tines meet handle
  const botY = cy + h*0.48;
  // Tine positions — 4 tines, tight spacing
  const tineOffsets = [-1.5, -0.5, 0.5, 1.5];
  const tineSpread = SQ * 0.09;        // spacing between adjacent tines
  const outerTineX = tineSpread * 1.5; // x of outermost tines from center
  const sw = SQ * 0.052;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── Handle ─────────────────────────────────────────────────────
  ctx.lineWidth = sw * 1.35;
  ctx.beginPath();
  ctx.moveTo(cx, botY);
  ctx.lineTo(cx, shoulderY);
  ctx.stroke();

  // ── Shoulder — only spans between outermost tines, NOT beyond ──
  ctx.lineWidth = sw * 0.9;
  ctx.beginPath();
  ctx.moveTo(cx - outerTineX, shoulderY);
  ctx.quadraticCurveTo(cx, shoulderY - SQ*0.055, cx + outerTineX, shoulderY);
  ctx.stroke();

  // ── Four tines ─────────────────────────────────────────────────
  ctx.lineWidth = sw;
  tineOffsets.forEach(off => {
    const tx = cx + tineSpread * off;
    ctx.beginPath();
    ctx.moveTo(tx, shoulderY);
    ctx.bezierCurveTo(tx, shoulderY - h*0.07, tx, tineTop + h*0.03, tx, tineTop);
    ctx.stroke();
  });

  ctx.restore();
}

// Draw a purple-only target symbol for discovered attacks
function drawPurpleTarget(ctx, sq, SQ, color='rgba(160,80,220,0.85)') {
  const {r,c} = sqCanvas(sq);
  const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
  const R1=13, R2=8, R3=4;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x,y,R1,0,Math.PI*2);
  ctx.lineWidth=2; ctx.stroke();
  ctx.beginPath(); ctx.arc(x,y,R2,0,Math.PI*2);
  ctx.lineWidth=1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x,y,R3,0,Math.PI*2);
  ctx.globalAlpha=0.7; ctx.fill(); ctx.globalAlpha=1;
  ctx.lineWidth=0.8; ctx.globalAlpha=0.4;
  ctx.beginPath(); ctx.moveTo(x-R1-2,y); ctx.lineTo(x+R1+2,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,y-R1-2); ctx.lineTo(x,y+R1+2); ctx.stroke();
  ctx.globalAlpha=1;
  ctx.restore();
}

// Draw a red+blue target/bullseye symbol on the centre of a square
// Used to mark X-ray targets and discovered attack targets
function drawTargetSymbol(ctx, sq, SQ) {
  const {r,c} = sqCanvas(sq);
  const x = c*SQ+SQ/2, y = r*SQ+SQ/2;
  const R1=14, R2=9, R3=4;
  ctx.save();
  // Outer red ring
  ctx.beginPath(); ctx.arc(x,y,R1,0,Math.PI*2);
  ctx.strokeStyle='rgba(220,40,40,0.9)'; ctx.lineWidth=2.5; ctx.stroke();
  // Middle blue ring
  ctx.beginPath(); ctx.arc(x,y,R2,0,Math.PI*2);
  ctx.strokeStyle='rgba(40,80,220,0.9)'; ctx.lineWidth=2; ctx.stroke();
  // Centre red dot
  ctx.beginPath(); ctx.arc(x,y,R3,0,Math.PI*2);
  ctx.fillStyle='rgba(220,40,40,0.85)'; ctx.fill();
  // Crosshair lines
  ctx.strokeStyle='rgba(220,40,40,0.5)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(x-R1-3,y); ctx.lineTo(x+R1+3,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,y-R1-3); ctx.lineTo(x,y+R1+3); ctx.stroke();
  ctx.restore();
}

// Get all squares a piece on `sq` attacks (raw, ignoring pins)
// Returns array of squares
function getAttackSquares(sq, bd) {
  return rawAttacks(sq, bd);
}

// Compute fork data for the current board
// Returns { current: [{sq, targets:[sq]}], safe: [{from, to, targets:[sq]}], contested: [{from,to,targets:[sq]}] }
function computeForkData(bd, color, pinnedSqs) {
  const opp = color === 'w' ? 'b' : 'w';
  const result = { current:[], safe:[], contested:[] };
  const directAtk = buildDirectAtk(bd);

  // ── Current forks ────────────────────────────────────────────────────────
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.color !== color) continue;
    if (pinnedSqs && pinnedSqs.has(sq)) continue; // pinned — can't fork
    const attacks = getAttackSquares(sq, bd);
    // Find attacked opponent pieces
    const targets = attacks.filter(t => bd[t] && bd[t].color === opp);
    if (targets.length < 2) continue;

    // Filter: only show if profitable
    // Either: any target is undefended, OR combined value > forking piece value
    const myVal = PIECE_VAL[p.piece] || 0;
    // "Undefended" = no defender of the target's OWN colour (the opponent).
    // Must be [opp], not [color]: directAtk[t][color] lists the forker's own
    // attackers of t (and always includes the forking piece itself), so it is
    // never empty — using it here silently suppressed every fork whose targets'
    // combined value didn't exceed the forker (e.g. a knight forking two pawns).
    const anyUndefended = targets.some(t => directAtk[t][opp].length === 0);
    const combinedVal = targets.reduce((sum,t) => sum + (PIECE_VAL[bd[t].piece]||0), 0);
    if (anyUndefended || combinedVal > myVal) {
      result.current.push({ sq, targets });
    }
  }

  // ── Next-move forks ───────────────────────────────────────────────────────
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.color !== color) continue;
    if (pinnedSqs && pinnedSqs.has(sq)) continue;
    const myVal = PIECE_VAL[p.piece] || 0;
    const moves = legalMovesFor(sq, bd, epSq, castling);
    for (const toSq of moves) {
      const bd2 = {...bd};
      delete bd2[sq];
      bd2[toSq] = p;
      const atk2 = buildDirectAtk(bd2);
      const attacks2 = getAttackSquares(toSq, bd2);
      const targets = attacks2.filter(t => bd2[t] && bd2[t].color === opp);
      if (targets.length < 2) continue;

      // Profitable fork filter. "Undefended" = no defender of the target's own
      // colour ([opp]); [color] would count the forker's own attackers (never
      // empty) and wrongly suppress low-combined-value forks.
      const anyUndefended = targets.some(t => atk2[t][opp].length === 0);
      const combinedVal = targets.reduce((sum,t) => sum + (PIECE_VAL[bd2[t].piece]||0), 0);
      if (!anyUndefended && combinedVal <= myVal) continue;

      // ── SEE filter: skip if landing square loses more than cheapest fork target ──
      // e.g. queen moving to pawn-defended square = SEE heavily negative → not shown
      const seeScore = seeLandingScore(toSq, p.piece, color, bd);
      const cheapestTarget = targets.reduce(
        (min,t) => Math.min(min, PIECE_VAL[bd2[t].piece]||0), 999);
      if (seeScore < -cheapestTarget) continue; // catastrophic loss — skip entirely

      // Classify by SEE result:
      // SEE >= 0: landing square safe (or we gain material there) → gold fork symbol
      // SEE < 0 but fork still worthwhile: contested → blue fork symbol
      if (seeScore >= 0) {
        result.safe.push({ from:sq, to:toSq, targets });
      } else {
        result.contested.push({ from:sq, to:toSq, targets });
      }
    }
  }

  return result;
}

// ── Skewer detection ─────────────────────────────────────────────────────────
// A skewer: sliding piece attacks high-value piece, behind it on same ray is a
// less-valuable piece (backVal < frontVal — otherwise it's not a skewer, just
// two pieces stacked on a ray). Also excluded: skewers where the skewering
// piece is itself currently attacked and undefended — these are static,
// present-tense facts (who attacks/defends this square right now), not a
// simulated exchange, consistent with forks/pins/threats elsewhere on this
// board: overlays show relations, not resolutions.
function computeSkewerData(bd, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const skewers = []; // {attackerSq, frontSq, backSq}
  const SLIDERS = {Q:true, R:true, B:true};
  const DIRS = [
    [-1,0],[1,0],[0,-1],[0,1],   // rook/queen
    [-1,-1],[-1,1],[1,-1],[1,1]  // bishop/queen
  ];
  const directAtk = buildDirectAtk(bd);

  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.color !== color) continue;
    if (!SLIDERS[p.piece]) continue;

    const {r,c} = sqRC(sq);
    for (const [dr,dc] of DIRS) {
      // Check direction is valid for piece type
      const isDiag = dr !== 0 && dc !== 0;
      if (p.piece === 'R' && isDiag) continue;
      if (p.piece === 'B' && !isDiag) continue;

      let r1=r+dr, c1=c+dc, frontSq=-1;
      // Walk ray looking for first piece
      while (r1>=0&&r1<8&&c1>=0&&c1<8) {
        const s1 = rcSq(r1,c1);
        if (bd[s1]) {
          if (bd[s1].color !== opp) break; // own piece blocks
          frontSq = s1;
          break;
        }
        r1+=dr; c1+=dc;
      }
      if (frontSq < 0) continue;
      if (!bd[frontSq]) continue;

      // Skewering piece hanging to some OTHER piece (attacked, no defender of
      // its own) — skip this ray rather than showing a "skewer" from a piece
      // that's simply about to be captured for free. The front piece itself is
      // excluded from the attacker check: it inherently attacks back down the
      // same ray it's being skewered on, which is normal for the tactic, not
      // a sign the attacker is hanging to a third party.
      const otherAttackers = directAtk[sq][opp].filter(s => s !== frontSq);
      const isHanging = otherAttackers.length > 0 && directAtk[sq][color].length === 0;
      if (isHanging) continue;

      const frontVal = PIECE_VAL[bd[frontSq].piece] || 0;
      const myVal = PIECE_VAL[p.piece] || 0;
      // Front piece must be more valuable than attacker for it to be forced to move
      if (frontVal <= myVal) continue;

      // Look for piece behind front piece on same ray
      let r2=r1+dr, c2=c1+dc, backSq=-1;
      while (r2>=0&&r2<8&&c2>=0&&c2<8) {
        const s2 = rcSq(r2,c2);
        if (bd[s2]) {
          if (bd[s2].color === opp) backSq = s2;
          break;
        }
        r2+=dr; c2+=dc;
      }
      if (backSq < 0) continue;
      // Definitional: the back piece must be less valuable than the front
      // piece, or this is just two stacked pieces, not a skewer.
      const backVal = PIECE_VAL[bd[backSq].piece] || 0;
      if (backVal >= frontVal) continue;

      skewers.push({ attackerSq:sq, frontSq, backSq });
    }
  }
  return skewers;
}

// ── Discovered attack detection ──────────────────────────────────────────────
// Only shows pieces where the intervening piece has at least one legal move
// that takes it OFF the ray — truly opening the discovered attack.
// (Pure X-ray with no legal move off-ray is shown by the X-ray indicator instead)
function computeDiscoveredData(bd, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const discovered = [];
  const SLIDERS = {Q:true, R:true, B:true};
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

  // For each friendly piece, check if it sits between a friendly slider and an enemy piece
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.color !== color || p.piece === 'K') continue;
    const {r, c} = sqRC(sq);

    for (const [dr, dc] of DIRS) {
      const isDiag = dr !== 0 && dc !== 0;

      // Walk TOWARD friendly slider (opposite direction of [dr,dc])
      let rb = r - dr, cb = c - dc;
      let sliderSq = -1;
      while (rb >= 0 && rb < 8 && cb >= 0 && cb < 8) {
        const bs = rcSq(rb, cb);
        if (bd[bs]) {
          if (bd[bs].color === color && SLIDERS[bd[bs].piece]) {
            const sl = bd[bs];
            if (sl.piece === 'R' && isDiag) break;  // rook can't attack diagonally
            if (sl.piece === 'B' && !isDiag) break; // bishop can't attack straight
            sliderSq = bs;
          }
          break; // blocked by something — stop looking
        }
        rb -= dr; cb -= dc;
      }
      if (sliderSq < 0) continue;

      // Check if this piece has at least one legal move that leaves this ray
      // (i.e. actually opens the discovered attack)
      const lms = legalMovesFor(sq, bd, epSq, castling);
      const hasOffRayMove = lms.some(toSq => {
        const {r: tr, c: tc} = sqRC(toSq);
        // A move stays on-ray if it stays on the same rank/file/diagonal
        // in the direction dr,dc from sq
        const onRank = (dr === 0 && tr === r);
        const onFile = (dc === 0 && tc === c);
        const onDiag = (isDiag && Math.abs(tr - r) === Math.abs(tc - c));
        return !(onRank || onFile || onDiag); // true if move goes OFF the ray
      });
      if (!hasOffRayMove) continue; // pinned or otherwise can't leave ray

      // Walk AWAY from slider (direction [dr,dc]) to find what the slider would hit
      const threatened = [];
      let rf = r + dr, cf = c + dc;
      while (rf >= 0 && rf < 8 && cf >= 0 && cf < 8) {
        const fs = rcSq(rf, cf);
        if (bd[fs]) {
          if (bd[fs].color === opp) threatened.push(fs);
          break;
        }
        rf += dr; cf += dc;
      }

      // Also check if slider would give discovered check
      const kSq = kingSquare(bd, opp);
      const isDiscoveredCheck = threatened.includes(kSq) ||
        (() => {
          let rk = r + dr, ck = c + dc;
          while (rk >= 0 && rk < 8 && ck >= 0 && ck < 8) {
            const ks = rcSq(rk, ck);
            if (ks === kSq) return true;
            if (bd[ks] && ks !== sq) break;
            rk += dr; ck += dc;
          }
          return false;
        })();

      if (threatened.length > 0 || isDiscoveredCheck) {
        discovered.push({
          movingPieceSq: sq,
          revealedAttackerSq: sliderSq,
          threatenedSqs: threatened,
          isDiscoveredCheck,
          side: 'own' // caller tags this
        });
      }
    }
  }

  // Deduplicate — prefer discovered checks
  const seen = new Map();
  for (const d of discovered) {
    const key = d.movingPieceSq;
    if (!seen.has(key) || d.isDiscoveredCheck) seen.set(key, d);
  }
  return [...seen.values()];
}

// ── X-ray pressure detection ──────────────────────────────────────────────────
// Shows ALL cases where a friendly slider's attack is blocked by a friendly piece —
// "hidden pressure" regardless of whether the blocker can legally move off the ray.
// This includes discovered attack candidates AND positions where the blocker is pinned.
function computeXrayData(bd, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const xrays = []; // {sliderSq, blockerSq, targetSq}
  const SLIDERS = {Q:true, R:true, B:true};
  const DIRS = [
    [-1,0],[1,0],[0,-1],[0,1],
    [-1,-1],[-1,1],[1,-1],[1,1]
  ];

  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || p.color !== color || !SLIDERS[p.piece]) continue;

    const {r,c} = sqRC(sq);
    for (const [dr,dc] of DIRS) {
      const isDiag = dr!==0&&dc!==0;
      if (p.piece==='R'&&isDiag) continue;
      if (p.piece==='B'&&!isDiag) continue;

      let rf=r+dr, cf=c+dc, blockerSq=-1;
      // Walk ray — find first piece
      while (rf>=0&&rf<8&&cf>=0&&cf<8) {
        const s = rcSq(rf,cf);
        if (bd[s]) {
          if (bd[s].color === color) {
            // Friendly piece blocking — this is the blocker
            blockerSq = s;
          }
          break;
        }
        rf+=dr; cf+=dc;
      }
      if (blockerSq < 0) continue;

      // Continue ray past blocker looking for target
      let r2=rf+dr, c2=cf+dc;
      while (r2>=0&&r2<8&&c2>=0&&c2<8) {
        const s2 = rcSq(r2,c2);
        if (bd[s2]) {
          if (bd[s2].color === opp) {
            xrays.push({ sliderSq:sq, blockerSq, targetSq:s2 });
          }
          break;
        }
        r2+=dr; c2+=dc;
      }
    }
  }
  return xrays;
}

// State vars
let showingForksW = false, showingForksB = false;
let forkDataW = null, forkDataB = null, skewerDataW = null, skewerDataB = null;
let showingDiscovered = false, discoveredData = null;
let showingXray = false, xrayData = null;




// Captures state
let showingCaptures = false;

// Memoization guard for the position-analysis layer below.
// indApply() recomputes check-threats, weak squares, forks, discovered
// attacks and x-ray — all pure functions of the DISPLAYED position
// (previewBoard||board) plus which indicators are active and the queen-pins
// math toggle. It is called from ~25 sites, many of which leave the position
// unchanged (indicator toggles, square selection, replay landing on a repeated
// position). When the signature is identical to the last successful run we skip
// the recompute and only render() — the interaction layer (selection, hover,
// premove arrows, last-move highlight) is drawn by render(), not here, so it
// stays fully live. Exploration is unaffected: a preview is a different board,
// hence a different signature, hence a recompute.
let _indLastSig = null;
function indSignature() {
  const pb  = previewBoard;
  const bd  = pb || board;
  const ep  = pb ? previewEpSq : epSq;
  const cst = pb ? (previewCastling || castling) : castling;
  // positionKey encodes placement + side-to-move + castling + ep.
  let sig = positionKey(bd, turn, cst, ep) + (pb ? '|P' : '|L') +
            (currentlyPreviewing ? '1' : '0');
  // Active-indicator set — which overlays indApply branches on. indActive()
  // already folds in pressing/on/pre state and the preview flag.
  if (typeof IND !== 'undefined') for (const k in IND) sig += indActive(k) ? '1' : '0';
  // Queen-pins isn't an IND key but changes computePins() (forks) and the
  // attack map used by the overloaded overlay.
  const qp = document.getElementById('cbQPins');
  sig += (qp && qp.checked) ? 'Q' : 'q';
  return sig;
}

function indApply() {
  let _sig;
  try { _sig = indSignature(); } catch(e) { _sig = null; }
  // Skip the recompute only when the signature is valid and unchanged; still
  // render() so selection/hover/arrow changes (not part of the signature) paint.
  if (_sig !== null && _sig === _indLastSig) {
    if (typeof render === 'function') render();
    return;
  }
  const _indStart = Date.now();
  try {
  const isPre = !!previewBoard || currentlyPreviewing;

  // Check threats — use preview board during move exploration
  if(indActive('checkthreats')) {
    checkThreatSquaresW = new Set(); checkThreatSquaresB = new Set();
    checkThreatPiecesW  = new Set(); checkThreatPiecesB  = new Set();
    const ctBd   = previewBoard || board;
    const ctEp   = previewBoard ? previewEpSq : epSq;
    const ctCast = previewBoard ? (previewCastling||castling) : castling;
    if(!inCheck(ctBd,'w') && !inCheck(ctBd,'b') && (Date.now()-_indStart)<200) {
      try {
        const rW = getCheckThreats(ctBd,'w',ctEp,ctCast);
        rW.destSquares.forEach(s=>checkThreatSquaresW.add(s));
        rW.pieceSquares.forEach(s=>checkThreatPiecesW.add(s));
        const rB = getCheckThreats(ctBd,'b',ctEp,ctCast);
        rB.destSquares.forEach(s=>checkThreatSquaresB.add(s));
        rB.pieceSquares.forEach(s=>checkThreatPiecesB.add(s));
      } catch(e) { console.warn('ct err:',e); }
    }
    showingCheckThreats = true;
  } else { showingCheckThreats=false; checkThreatSquaresW=new Set(); checkThreatSquaresB=new Set(); checkThreatPiecesW=new Set(); checkThreatPiecesB=new Set(); }

  // Captures possible
  showingCaptures = indActive('captures');

  // Overloaded
  if(indActive('overloaded')) {
    const dispAtk=previewAtk||atkMap;
    const dispBoard=previewBoard||board;
    overloadedData=computeOverloaded(dispBoard,dispAtk);
    showingOverloaded=true;
  } else { showingOverloaded=false; overloadedData=null; }

  // Weak squares
  showingWeakSquares=false;
  weakSquaresW=new Set(); weakSquaresB=new Set();
  const atk=buildDirectAtk(previewBoard||board);
  if(indActive('weakw')) {
    showingWeakSquares=true;
    for(let s=0;s<64;s++){if((previewBoard||board)[s])continue;if(atk[s].w.length===0)weakSquaresW.add(s);}
  }
  if(indActive('weakb')) {
    showingWeakSquares=true;
    for(let s=0;s<64;s++){if((previewBoard||board)[s])continue;if(atk[s].b.length===0)weakSquaresB.add(s);}
  }

  // Battery handled by IND object

  // Pins state handled by IND object directly

  // Forks & Skewers — separate for white and black
  const dispBd2 = previewBoard || board;
  const pins2 = computePins(dispBd2);
  const isPremoveExploring = !!previewBoard;
  // Color system: active player = green(safe)/blue(contested), opponent = red(safe)/pink(contested)
  const wSafe = turn==='w'?'rgba(40,200,80,0.92)':'rgba(220,50,50,0.92)';
  const wCont = turn==='w'?'rgba(53,120,224,0.85)':'rgba(220,80,180,0.85)';
  const bSafe = turn==='b'?'rgba(40,200,80,0.92)':'rgba(220,50,50,0.92)';
  const bCont = turn==='b'?'rgba(53,120,224,0.85)':'rgba(220,80,180,0.85)';

  // Skip fork computation if preview board has a king in check (checkmate position)
  const skipForks = isPremoveExploring && (inCheck(dispBd2,'w') || inCheck(dispBd2,'b'));
  if (indActive('forksw') && !skipForks) {
    try { forkDataW = computeForkData(dispBd2, 'w', pins2.w); } catch(e){ forkDataW=null; }
    try { skewerDataW = computeSkewerData(dispBd2, 'w'); } catch(e){ skewerDataW=null; }
    showingForksW = true;
  } else { showingForksW = false; forkDataW = null; skewerDataW = null; }

  if (indActive('forksb') && !skipForks) {
    try { forkDataB = computeForkData(dispBd2, 'b', pins2.b); } catch(e){ forkDataB=null; }
    try { skewerDataB = computeSkewerData(dispBd2, 'b'); } catch(e){ skewerDataB=null; }
    showingForksB = !(isPremoveExploring && turn === 'b');
  } else { showingForksB = false; forkDataB = null; skewerDataB = null; }

  // Discovered attacks
  if (indActive('discoveredopp') || indActive('discoveredself')) {
    const dispBd = previewBoard || board;
    const skipDisc = previewBoard && (inCheck(dispBd,'w')||inCheck(dispBd,'b'));
    if(!skipDisc){
      try {
        const opp = turn==='w'?'b':'w';
        const ownDisc = indActive('discoveredself')
          ? computeDiscoveredData(dispBd, turn).map(d=>({...d,side:'own'})) : [];
        const oppDisc = indActive('discoveredopp')
          ? computeDiscoveredData(dispBd, opp).map(d=>({...d,side:'opp'}))  : [];
        discoveredData = [...ownDisc, ...oppDisc];
      } catch(e) { discoveredData = []; }
    } else { discoveredData = []; }
    showingDiscovered = true;
  } else { showingDiscovered = false; discoveredData = null; }

  // X-ray pressure
  if (indActive('xray')) {
    const dispBd = previewBoard || board;
    const skipXray = previewBoard && (inCheck(dispBd,'w')||inCheck(dispBd,'b'));
    if(!skipXray){
      try {
        const opp = turn==='w'?'b':'w';
        const ownXray = computeXrayData(dispBd, turn).map(d=>({...d,side:'own'}));
        const oppXray = computeXrayData(dispBd, opp).map(d=>({...d,side:'opp'}));
        xrayData = [...ownXray, ...oppXray];
      } catch(e) { xrayData = []; }
    } else { xrayData = []; }
    showingXray = true;
  } else { showingXray = false; xrayData = null; }

  indRefreshPremoveUI();
  render();
  _indLastSig = _sig; // mark this signature done — subsequent identical calls skip
  } catch(e){ _indLastSig = null; console.warn('indApply error:',e); if(typeof render==='function') setTimeout(render,0); }
}
// (checkbox shim removed — direct indActive() calls used instead)

// ── Dynamic board sizing is defined earlier in the script ────────────────────
window.addEventListener('resize', resizeBoard);

loadPos(0);
resizeBoard();



// ── Startup ───────────────────────────────────────────────────────────
// Preload all piece sets eagerly at startup
const ALL_SETS = ['staunton','rhosgfx_solid','rhosgfx_outline','rhosgfx_wood','rhosgfx_flat'];
ALL_SETS.forEach(s => preloadPieceImages(s));
// Apply defaults BEFORE loadPrefs so saved prefs override them
if (!localStorage.getItem('bm_boardTheme')) applyBoardTheme('blue');
if (!localStorage.getItem('bm_bgTheme')) applyBgTheme('lightblue'); // Cool blue is the first-run look
if (!localStorage.getItem('bm_pieceSet')) { currentPieceSet = 'staunton'; }
loadPrefs();
loadSoundPref();
loadBoardSettingsPref();
if(typeof ghostSyncUI === "function") ghostSyncUI();
// Stockfish 1 is where a first visit should start: the quick block applies it
// rather than inheriting the builder's own default of 8.
if(typeof quickBotPick === "function") quickBotPick(String(QUICK_SF_DEFAULT));
loadPos(0);
resizeBoard();

// Start the Maia worker shortly after page load so it can detect any cached
// model in IndexedDB and update the status UI before the user opens the bot
// panel.  200 ms keeps it out of the critical render path while still giving
// a near-instant cache check result; maiaInit() is a no-op if the worker is
// already running.
setTimeout(function() {
  if (!_maiaWorker) { maiaInit(); _maiaLoadMappings(); }
}, 200);

// Keep the clock counting against real elapsed wall-clock time across tab
// hide/show (including OS sleep). A hidden tab's setInterval is throttled to
// roughly once a minute, so the repaint timer is worth stopping — but the
// ANCHOR must survive, because the player is still on move and still on the
// clock the whole time they are away.
//
// This used to call clockStop() on hide and clockStart() on show. clockStart()
// re-anchors, which silently refunded every second spent hidden: alt-tabbing
// out of a 1+0 bullet game paused your clock, and in multiplayer the refunded
// value was then sent to the opponent as authoritative.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Charge up to this instant so the saved snapshot and the display are
    // right, then park the timer. _clockAnchorMs deliberately stays put.
    if (typeof clockActive !== 'undefined' && clockActive) {
      const elapsed   = Math.floor((Date.now() - _clockAnchorMs) / 1000);
      const remaining = Math.max(0, _clockAnchorSec - elapsed);
      if (turn === 'w') clockTimeW = remaining; else clockTimeB = remaining;
      if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
      if (remaining === 0) { clockStop(); clockTimeout(turn); }
      else clockUpdateDisplay();
    }
  } else {
    if (typeof clockResume === 'function') clockResume();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BOT ENGINE SYSTEM — Stockfish + Maia-2 + Hybrid + Ghost Pieces
// ═══════════════════════════════════════════════════════════════════════════

// (bot state vars moved to top of script)

// ── Stockfish workers — loaded from same-origin /stockfish.js ────────────────
// Server.js fetches SF from CDN at startup and serves it locally, avoiding
// the SecurityError that occurs when constructing Workers from blob: URLs.
const SF_LOCAL = '/stockfish.js';


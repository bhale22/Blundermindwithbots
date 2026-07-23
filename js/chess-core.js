// ── chess-core.js ────────────────────────────────────────────────────────────
// Pure chess logic: no DOM access, no global state mutation.
// Every function takes its inputs as parameters and returns results.
// Safe to import in any context (browser, worker, future Node test runner).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const PIECE_VALUE  = { K:0, Q:9, R:5, B:3, N:3, P:1 };
const PIECE_VALS   = { P:1, N:3, B:3, R:5, Q:9 };         // excludes king
const PIECE_VAL    = { P:1, N:3, B:3, R:5, Q:9, K:100 };  // SEE
const VALS         = { P:1, N:3, B:3, R:5, Q:9, K:100 };  // battery/exchange
const PIECE_GLYPHS = { P:'♙', N:'♘', B:'♗', R:'♖', Q:'♕' };
const UNI = { wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙',
              bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟' };

// ── Coordinate helpers ────────────────────────────────────────────────────────
function fileRankToSq(s) {
  if (!s || s.length < 2) return -1;
  return (8 - parseInt(s[1])) * 8 + (s.charCodeAt(0) - 97);
}
function sqName(sq)  { return String.fromCharCode(97 + sq % 8) + (8 - Math.floor(sq / 8)); }
function sqRC(sq)    { return { r: Math.floor(sq / 8), c: sq % 8 }; }
function rcSq(r, c)  { return r * 8 + c; }
function valid(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// ── Raw attack squares (ignores legality / pins) ──────────────────────────────
function rawAttacks(sq, bd) {
  const p = bd[sq]; if (!p) return [];
  const { r, c } = sqRC(sq); const out = [];
  const slide = (dr, dc) => {
    let nr = r + dr, nc = c + dc;
    while (valid(nr, nc)) { out.push(rcSq(nr, nc)); if (bd[rcSq(nr, nc)]) break; nr += dr; nc += dc; }
  };
  if (p.piece === 'R' || p.piece === 'Q') { slide(0,1); slide(0,-1); slide(1,0); slide(-1,0); }
  if (p.piece === 'B' || p.piece === 'Q') { slide(1,1); slide(1,-1); slide(-1,1); slide(-1,-1); }
  if (p.piece === 'N') { for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) if (valid(r+dr,c+dc)) out.push(rcSq(r+dr,c+dc)); }
  if (p.piece === 'K') { for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) if (valid(r+dr,c+dc)) out.push(rcSq(r+dr,c+dc)); }
  if (p.piece === 'P') { const d = p.color==='w'?-1:1; if (valid(r+d,c-1)) out.push(rcSq(r+d,c-1)); if (valid(r+d,c+1)) out.push(rcSq(r+d,c+1)); }
  return out;
}

// All squares a piece influences (same as rawAttacks for most purposes)
function influenceSquares(sq, bd) {
  const p = bd[sq]; if (!p) return [];
  const { r, c } = sqRC(sq); const out = new Set();
  const slideAll = (dr, dc) => { let nr=r+dr,nc=c+dc; while(valid(nr,nc)){out.add(rcSq(nr,nc));if(bd[rcSq(nr,nc)])break;nr+=dr;nc+=dc;} };
  if (p.piece==='R'||p.piece==='Q') { slideAll(0,1);slideAll(0,-1);slideAll(1,0);slideAll(-1,0); }
  if (p.piece==='B'||p.piece==='Q') { slideAll(1,1);slideAll(1,-1);slideAll(-1,1);slideAll(-1,-1); }
  if (p.piece==='N') { for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(valid(r+dr,c+dc))out.add(rcSq(r+dr,c+dc)); }
  if (p.piece==='K') { for(const[dr,dc]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])if(valid(r+dr,c+dc))out.add(rcSq(r+dr,c+dc)); }
  if (p.piece==='P') { const d=p.color==='w'?-1:1; if(valid(r+d,c-1))out.add(rcSq(r+d,c-1)); if(valid(r+d,c+1))out.add(rcSq(r+d,c+1)); }
  return [...out];
}

// ── Piece & check helpers ─────────────────────────────────────────────────────
function kingSquare(bd, color) {
  for (let s = 0; s < 64; s++) if (bd[s] && bd[s].piece === 'K' && bd[s].color === color) return s;
  return -1;
}
function isAttackedBy(sq, byColor, bd) {
  for (let s = 0; s < 64; s++) { if (!bd[s] || bd[s].color !== byColor) continue; if (rawAttacks(s, bd).includes(sq)) return true; }
  return false;
}
function inCheck(bd, color) { return isAttackedBy(kingSquare(bd, color), color === 'w' ? 'b' : 'w', bd); }

// ── Pin detection ─────────────────────────────────────────────────────────────
function getPinnedSquares(bd, color) {
  const pinned = new Set();
  const kSq = kingSquare(bd, color);
  if (kSq < 0) return pinned;
  if (inCheck(bd, color)) return pinned;
  for (let s = 0; s < 64; s++) {
    const p = bd[s];
    if (!p || p.color !== color || p.piece === 'K') continue;
    const bd2 = { ...bd }; delete bd2[s];
    if (inCheck(bd2, color)) pinned.add(s);
  }
  return pinned;
}

function getQueenPinnedSquares(bd, color) {
  const pinned = new Set();
  const opp = color === 'w' ? 'b' : 'w';
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  for (let q = 0; q < 64; q++) {
    const qp = bd[q];
    if (!qp || qp.color !== color || qp.piece !== 'Q') continue;
    if (isAttackedBy(q, opp, bd)) continue;
    const { r:qr, c:qc } = sqRC(q);
    for (const [dr,dc] of DIRS) {
      let r = qr+dr, c = qc+dc, firstFriendly = -1;
      while (r>=0&&r<8&&c>=0&&c<8) {
        const s = rcSq(r,c), p = bd[s];
        if (p) {
          if (p.color === color) {
            if (firstFriendly < 0) { firstFriendly = s; } else { break; }
          } else {
            if (firstFriendly >= 0) {
              const canSlide = (dr===0||dc===0) ? (p.piece==='R'||p.piece==='Q') : (p.piece==='B'||p.piece==='Q');
              if (canSlide) pinned.add(firstFriendly);
            }
            break;
          }
        }
        r+=dr; c+=dc;
      }
    }
  }
  return pinned;
}

function getPinRaySquares(bd, pieceSq, color) {
  const kSq = kingSquare(bd, color);
  if (kSq < 0) return new Set();
  const { r:kr, c:kc } = sqRC(kSq), { r:pr, c:pc } = sqRC(pieceSq);
  const dr = Math.sign(kr-pr), dc = Math.sign(kc-pc);
  if (dr===0&&dc===0) return new Set();
  if (dr!==0&&dc!==0&&Math.abs(kr-pr)!==Math.abs(kc-pc)) return new Set();
  if (dr===0&&kr!==pr) return new Set();
  if (dc===0&&kc!==pc) return new Set();
  const ray = new Set();
  let r = pr-dr, c = pc-dc;
  while (r>=0&&r<8&&c>=0&&c<8) { const sq=rcSq(r,c); ray.add(sq); if (bd[sq]) break; r-=dr; c-=dc; }
  return ray;
}

function getQueenPinRaySquares(bd, pieceSq, color) {
  const opp = color==='w'?'b':'w';
  const { r:pr, c:pc } = sqRC(pieceSq);
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr,dc] of DIRS) {
    let r=pr+dr, c=pc+dc;
    while (r>=0&&r<8&&c>=0&&c<8) {
      const sq=rcSq(r,c);
      if (bd[sq]) {
        if (bd[sq].color===opp&&(bd[sq].piece==='Q'||bd[sq].piece==='R'||bd[sq].piece==='B')) {
          const ray = new Set(); ray.add(sq); return ray;
        }
        break;
      }
      r+=dr; c+=dc;
    }
  }
  return new Set();
}

// ── Check threat detection ────────────────────────────────────────────────────
// Returns { destSquares, pieceSquares } — squares a side can move to to give check
function getCheckThreats(bd, color, ep, cst) {
  const destSquares = new Set(), pieceSquares = new Set();
  const opp = color === 'w' ? 'b' : 'w';
  if (inCheck(bd, color) || inCheck(bd, opp)) return { destSquares, pieceSquares };
  const kSq = kingSquare(bd, opp);
  if (kSq < 0) return { destSquares, pieceSquares };
  for (let s = 0; s < 64; s++) {
    const p = bd[s];
    if (!p || p.color !== color) continue;
    for (const to of legalMovesFor(s, bd, ep, cst)) {
      const bd2 = applyMove(s, to, bd, ep, 'Q');
      if (inCheck(bd2, opp)) { destSquares.add(to); pieceSquares.add(s); break; }
    }
  }
  return { destSquares, pieceSquares };
}

// ── Attack map builders ───────────────────────────────────────────────────────
function buildDirectAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB) {
  const a = {}; for (let s=0;s<64;s++) a[s]={w:[],b:[]};
  for (let s = 0; s < 64; s++) {
    if (!bd[s]) continue;
    const col = bd[s].color;
    const isKingPinned = (col==='w'&&pinnedW&&pinnedW.has(s)&&!(queenPinnedW&&queenPinnedW.has(s)))||
                         (col==='b'&&pinnedB&&pinnedB.has(s)&&!(queenPinnedB&&queenPinnedB.has(s)));
    const isQueenPinned = (col==='w'&&queenPinnedW&&queenPinnedW.has(s))||
                          (col==='b'&&queenPinnedB&&queenPinnedB.has(s));
    if (isKingPinned) {
      const ray = getPinRaySquares(bd, s, col);
      for (const t of rawAttacks(s, bd)) if (ray.has(t)) a[t][col].push(s);
    } else if (isQueenPinned) {
      const ray = getQueenPinRaySquares(bd, s, col);
      for (const t of rawAttacks(s, bd)) if (ray.has(t)) a[t][col].push(s);
    } else {
      for (const t of rawAttacks(s, bd)) a[t][col].push(s);
    }
  }
  return a;
}

function currentAttackersOf(tgtSq, color, brd) {
  const out = [];
  for (let s = 0; s < 64; s++) {
    const p = brd[s]; if (!p || p.color !== color) continue;
    if (rawAttacks(s, brd).includes(tgtSq)) out.push({ sq:s, val:VALS[p.piece]||0 });
  }
  out.sort((a, b) => a.val - b.val);
  return out;
}

function runExchange(tgtSq, startSide, brd) {
  let b = { ...brd }, side = startSide, wC = 0, bC = 0;
  for (let i = 0; i < 32; i++) {
    const atks = currentAttackersOf(tgtSq, side, b);
    if (!atks.length) break;
    const { sq:atkSq } = atks[0];
    const nb = { ...b }; nb[tgtSq] = nb[atkSq]; delete nb[atkSq];
    b = nb;
    if (side === 'w') wC++; else bC++;
    side = side === 'w' ? 'b' : 'w';
  }
  return { w:wC, b:bC };
}

function buildBatteryAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB) {
  const direct = buildDirectAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB);
  const a = {};
  for (let s = 0; s < 64; s++) {
    const dw = direct[s].w.length, db = direct[s].b.length;
    if (dw === 0 && db === 0) { a[s] = {w:[],b:[]}; continue; }
    const occ = bd[s];
    let wCount = dw, bCount = db;
    if (occ) {
      const attackerColor = occ.color==='w'?'b':'w', defenderColor = occ.color;
      const fAtk = runExchange(s, attackerColor, bd);
      const fDef = runExchange(s, defenderColor, bd);
      const atkCount = attackerColor==='w'?fAtk.w:fAtk.b, defCount = defenderColor==='w'?fAtk.w:fAtk.b;
      const atkCount2 = attackerColor==='w'?fDef.w:fDef.b, defCount2 = defenderColor==='w'?fDef.w:fDef.b;
      if (occ.color === 'w') { wCount=Math.max(dw,defCount,defCount2); bCount=Math.max(db,atkCount,atkCount2); }
      else { bCount=Math.max(db,defCount,defCount2); wCount=Math.max(dw,atkCount,atkCount2); }
    } else {
      const fw=runExchange(s,'w',bd), fb=runExchange(s,'b',bd);
      wCount=Math.max(dw,fw.w,fb.w); bCount=Math.max(db,fw.b,fb.b);
    }
    a[s] = { w:Array(wCount).fill(s), b:Array(bCount).fill(s) };
  }
  return a;
}

// ── Legality ──────────────────────────────────────────────────────────────────
function castlingLegal(bd, color, side) {
  const opp = color==='w'?'b':'w', r = color==='w'?7:0, kSq = rcSq(r,4);
  if (!bd[kSq]||bd[kSq].piece!=='K'||bd[kSq].color!==color) return false;
  if (inCheck(bd, color)) return false;
  if (side === 'K') {
    const rSq=rcSq(r,7); if(!bd[rSq]||bd[rSq].piece!=='R'||bd[rSq].color!==color) return false;
    if (bd[rcSq(r,5)]||bd[rcSq(r,6)]) return false;
    if (isAttackedBy(rcSq(r,5),opp,bd)||isAttackedBy(rcSq(r,6),opp,bd)) return false;
  } else {
    const rSq=rcSq(r,0); if(!bd[rSq]||bd[rSq].piece!=='R'||bd[rSq].color!==color) return false;
    if (bd[rcSq(r,3)]||bd[rcSq(r,2)]||bd[rcSq(r,1)]) return false;
    if (isAttackedBy(rcSq(r,3),opp,bd)||isAttackedBy(rcSq(r,2),opp,bd)) return false;
  }
  return true;
}

function pseudoMoves(sq, bd, ep, cst) {
  const p = bd[sq]; if (!p) return [];
  const { r, c } = sqRC(sq); const col = p.color, opp = col==='w'?'b':'w'; const moves = [];
  const addIfNotOwn = tsq => { if (!bd[tsq] || bd[tsq].color !== col) moves.push(tsq); };
  if (p.piece === 'P') {
    const d=col==='w'?-1:1, start=col==='w'?6:1;
    if (valid(r+d,c)&&!bd[rcSq(r+d,c)]) { moves.push(rcSq(r+d,c)); if (r===start&&!bd[rcSq(r+2*d,c)]) moves.push(rcSq(r+2*d,c)); }
    for (const dc of [-1,1]) { if (valid(r+d,c+dc)) { const tsq=rcSq(r+d,c+dc); if ((bd[tsq]&&bd[tsq].color===opp)||tsq===ep) moves.push(tsq); } }
  } else if (p.piece === 'K') {
    for (const [dr,dc2] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) if (valid(r+dr,c+dc2)) addIfNotOwn(rcSq(r+dr,c+dc2));
    if (c === 4) {
      if (col==='w'&&cst.wK&&castlingLegal(bd,col,'K')) moves.push(rcSq(r,6));
      if (col==='w'&&cst.wQ&&castlingLegal(bd,col,'Q')) moves.push(rcSq(r,2));
      if (col==='b'&&cst.bK&&castlingLegal(bd,col,'K')) moves.push(rcSq(r,6));
      if (col==='b'&&cst.bQ&&castlingLegal(bd,col,'Q')) moves.push(rcSq(r,2));
    }
  } else { for (const t of rawAttacks(sq, bd)) addIfNotOwn(t); }
  return moves;
}

function legalMovesFor(sq, bd, ep, cst) {
  const p = bd[sq]; if (!p) return [];
  return pseudoMoves(sq, bd, ep, cst).filter(to => { const bd2 = applyMove(sq, to, bd, ep, 'Q'); return !inCheck(bd2, p.color); });
}

function allLegalMoves(bd, col, ep, cst) {
  const all = [];
  for (let s = 0; s < 64; s++) if (bd[s] && bd[s].color === col) for (const t of legalMovesFor(s, bd, ep, cst)) all.push({ from:s, to:t });
  return all;
}

// ── Move application ──────────────────────────────────────────────────────────
function applyMove(from, to, bd, ep, promo) {
  const bd2 = { ...bd }, p = bd2[from]; bd2[to] = p; delete bd2[from];
  if (p.piece==='P'&&to===ep) delete bd2[rcSq(Math.floor(from/8), to%8)];
  if (p.piece==='K') {
    const { r, c:fc } = sqRC(from), { c:tc } = sqRC(to);
    if (Math.abs(tc-fc) === 2) {
      if (tc===6) { bd2[rcSq(r,5)]=bd2[rcSq(r,7)]; delete bd2[rcSq(r,7)]; }
      if (tc===2) { bd2[rcSq(r,3)]=bd2[rcSq(r,0)]; delete bd2[rcSq(r,0)]; }
    }
  }
  if (p.piece==='P'&&(Math.floor(to/8)===0||Math.floor(to/8)===7)) bd2[to]={ piece:promo||'Q', color:p.color };
  return bd2;
}

function computeEP(from, to, bd) {
  const p = bd[from];
  if (p&&p.piece==='P'&&Math.abs(Math.floor(from/8)-Math.floor(to/8))===2) return rcSq((Math.floor(from/8)+Math.floor(to/8))/2, from%8);
  return -1;
}

// Returns new castling object (does not mutate)
function updateCastling(from, to, p, cst) {
  const c2 = { ...cst };
  if (p.piece==='K') { if (p.color==='w'){c2.wK=false;c2.wQ=false;} else {c2.bK=false;c2.bQ=false;} }
  if (from===rcSq(7,0)||to===rcSq(7,0)) c2.wQ=false;
  if (from===rcSq(7,7)||to===rcSq(7,7)) c2.wK=false;
  if (from===rcSq(0,0)||to===rcSq(0,0)) c2.bQ=false;
  if (from===rcSq(0,7)||to===rcSq(0,7)) c2.bK=false;
  return c2;
}

// ── Algebraic notation ────────────────────────────────────────────────────────
function moveToSAN(from, to, promo, bd, ep, cst) {
  const p = bd[from]; if (!p) return '?';
  const { r:fr, c:fc } = sqRC(from), { r:tr, c:tc } = sqRC(to);
  const toFile = String.fromCharCode(97+tc), toRank = String(8-tr);
  const capture = !!bd[to] || (p.piece==='P' && tc!==fc);
  if (p.piece==='K'&&Math.abs(tc-fc)===2) return tc>fc ? 'O-O' : 'O-O-O';
  let san = '';
  if (p.piece !== 'P') {
    san += p.piece;
    let ambigFile=false, ambigRank=false;
    for (let s=0;s<64;s++) {
      if (s===from) continue;
      const q=bd[s];
      if (!q||q.color!==p.color||q.piece!==p.piece) continue;
      if (legalMovesFor(s,bd,ep,cst).includes(to)) {
        const{r:sr,c:sc}=sqRC(s);
        if (sc===fc) ambigRank=true; else ambigFile=true;
      }
    }
    if (ambigFile||ambigRank) {
      if (!ambigFile) san += String.fromCharCode(97+fc);
      else if (!ambigRank) san += String(8-fr);
      else san += String.fromCharCode(97+fc)+String(8-fr);
    }
  } else if (capture) { san += String.fromCharCode(97+fc); }
  if (capture) san += 'x';
  san += toFile + toRank;
  if (promo) san += '=' + (promo||'Q');
  const bd2 = applyMove(from,to,bd,ep,promo||'Q');
  const nextTurn = p.color==='w'?'b':'w';
  const nextEp = computeEP(from,to,bd);
  const nextMoves = allLegalMoves(bd2,nextTurn,nextEp,cst);
  if (inCheck(bd2,nextTurn)) san += nextMoves.length===0 ? '#' : '+';
  return san;
}

// Converts SAN token back to {from, to, promo} given current board state
function algebraicToMove(san, bd, color, ep, castl) {
  if (san==='O-O'||san==='0-0')     { const r=color==='w'?7:0; return{from:rcSq(r,4),to:rcSq(r,6)}; }
  if (san==='O-O-O'||san==='0-0-0') { const r=color==='w'?7:0; return{from:rcSq(r,4),to:rcSq(r,2)}; }
  san = san.replace(/[+#!?]/g,'');
  let promo = null;
  if (san.includes('=')) { promo=san.split('=')[1][0]; san=san.replace(/=.*$/,''); }
  let piece='P', s=san.replace('x','');
  if ('KQRBN'.includes(s[0])) { piece=s[0]; s=s.slice(1); }
  const toFile=s.charCodeAt(s.length-2)-97, toRank=8-parseInt(s[s.length-1]), to=rcSq(toRank,toFile);
  let dfFile=null, dfRank=null;
  if (s.length>2) {
    const d=s.slice(0,s.length-2);
    if (/^[a-h]$/.test(d)) dfFile=d.charCodeAt(0)-97;
    else if (/^[1-8]$/.test(d)) dfRank=8-parseInt(d);
    else if (d.length===2) { dfFile=d.charCodeAt(0)-97; dfRank=8-parseInt(d[1]); }
  }
  for (let sq=0;sq<64;sq++) {
    const p=bd[sq];
    if (!p||p.color!==color||p.piece!==piece) continue;
    if (dfFile!==null&&sqRC(sq).c!==dfFile) continue;
    if (dfRank!==null&&sqRC(sq).r!==dfRank) continue;
    if (legalMovesFor(sq,bd,ep,castl).includes(to)) return{from:sq,to,promo};
  }
  return null;
}

// ── FEN / UCI conversion ──────────────────────────────────────────────────────
function boardToFen(bd, turnColor, cst, ep) {
  const rows = [];
  for (let r=0;r<8;r++) {
    let row='', empty=0;
    for (let c=0;c<8;c++) {
      const p=bd[rcSq(r,c)];
      if (!p) { empty++; }
      else { if(empty){row+=empty;empty=0;} const ch=p.piece==='N'?'n':p.piece.toLowerCase(); row+=p.color==='w'?ch.toUpperCase():ch; }
    }
    if (empty) row+=empty;
    rows.push(row);
  }
  let castStr='';
  if (cst.wK) castStr+='K'; if (cst.wQ) castStr+='Q';
  if (cst.bK) castStr+='k'; if (cst.bQ) castStr+='q';
  if (!castStr) castStr='-';
  const epStr = ep>=0 ? (String.fromCharCode(97+ep%8)+(8-Math.floor(ep/8))) : '-';
  return rows.join('/') + ' ' + turnColor + ' ' + castStr + ' ' + epStr + ' 0 1';
}

function sqToUci(from, to, promo) {
  const files = 'abcdefgh';
  return files[from%8]+(8-Math.floor(from/8))+files[to%8]+(8-Math.floor(to/8))+(promo||'');
}

function uciToSq(uci) {
  if (!uci||uci.length<4) return null;
  return { from:rcSq(8-parseInt(uci[1]),uci.charCodeAt(0)-97), to:rcSq(8-parseInt(uci[3]),uci.charCodeAt(2)-97), promo:uci.length===5?uci[4].toUpperCase():null };
}

// ── Material ──────────────────────────────────────────────────────────────────
function computeMaterial(bd) {
  let w=0, b=0, wPieces={}, bPieces={};
  for (let s=0;s<64;s++) {
    const p=bd[s]; if(!p||p.piece==='K') continue;
    const v=PIECE_VALS[p.piece]||0;
    if (p.color==='w') { w+=v; wPieces[p.piece]=(wPieces[p.piece]||0)+1; }
    else               { b+=v; bPieces[p.piece]=(bPieces[p.piece]||0)+1; }
  }
  return { w, b, wPieces, bPieces };
}

function matAdvString(diff, pieces, oppPieces) {
  if (diff===0) return '';
  const surplus=[];
  for (const [pc,cnt] of Object.entries(pieces)) { const extra=cnt-(oppPieces[pc]||0); for(let i=0;i<extra;i++) surplus.push(pc); }
  surplus.sort((a,b)=>(PIECE_VALS[b]||0)-(PIECE_VALS[a]||0));
  const glyphs=surplus.map(p=>PIECE_GLYPHS[p]||'').join('');
  return `<span style="font-size:13px;color:var(--text-primary);">${glyphs}</span>`
       + `<span style="font-size:9px;color:var(--text-secondary);margin-left:3px;">+${diff}</span>`;
}

// SEE-style landing score: net material gained by capturing on toSq with piece from fromSq
function seeLandingScore(toSq, pieceType, color, bd) {
  const cap = bd[toSq];
  if (!cap) return 0;
  const gain = PIECE_VAL[cap.piece] || 0;
  const bd2 = { ...bd };
  bd2[toSq] = { piece:pieceType, color };
  const opp = color==='w'?'b':'w';
  const oppAtks = currentAttackersOf(toSq, opp, bd2);
  if (!oppAtks.length) return gain;
  const { sq:oppSq } = oppAtks[0];
  return gain - seeLandingScore(toSq, bd2[oppSq].piece, opp, bd2);
}

// ── Maia3 tensor helpers (pure transforms) ────────────────────────────────────
function _maiaSquare(sq)       { return sq[0] + (9 - parseInt(sq[1])); }
function _maiaMove(uci)        { return _maiaSquare(uci.slice(0,2)) + _maiaSquare(uci.slice(2,4)) + (uci.length>4?uci[4]:''); }
function _maiaSwapRank(rank)   { return rank.split('').map(c=>c>='A'&&c<='Z'?c.toLowerCase():c>='a'&&c<='z'?c.toUpperCase():c).join(''); }
function _maiaSwapCastling(c) {
  if (c==='-') return '-';
  const r=new Set(c.split('')), s=new Set();
  if(r.has('K'))s.add('k');if(r.has('Q'))s.add('q');if(r.has('k'))s.add('K');if(r.has('q'))s.add('Q');
  return (['K','Q','k','q'].filter(x=>s.has(x)).join(''))||'-';
}
function _maiaFlipFen(fen) {
  const parts=fen.split(' ');
  const flipped=parts[0].split('/').slice().reverse().map(_maiaSwapRank).join('/');
  const ep = parts[3]!=='-' ? _maiaSquare(parts[3]) : '-';
  return flipped+' '+(parts[1]==='w'?'b':'w')+' '+_maiaSwapCastling(parts[2])+' '+ep+' '+parts[4]+' '+parts[5];
}
function _maiaEncode(fen) {
  const workFen = fen.split(' ')[1]==='b' ? _maiaFlipFen(fen) : fen;
  const tokens = new Float32Array(64*12);
  const pieceTypes = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  const rows = workFen.split(' ')[0].split('/');
  for (let rank=0;rank<8;rank++) {
    const row=7-rank; let file=0;
    for (let ci=0;ci<rows[rank].length;ci++) {
      const ch=rows[rank][ci], n=parseInt(ch);
      if (isNaN(n)) { const pi=pieceTypes.indexOf(ch); if(pi>=0) tokens[(row*8+file)*12+pi]=1.0; file++; }
      else { file+=n; }
    }
  }
  return { tokens, workFen };
}

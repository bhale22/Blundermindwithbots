function parseFen(fen){
  const parts=fen.split(' '),b={};
  const rows=parts[0].split('/');
  for(let r=0;r<8;r++){let c=0;for(const ch of rows[r]){if('12345678'.includes(ch)){c+=+ch;}else{b[r*8+c]={piece:ch.toUpperCase(),color:ch===ch.toUpperCase()?'w':'b'};c++;}}}
  turn=parts[1]||'w';
  const cs=parts[2]||'-';
  castling={wK:cs.includes('K'),wQ:cs.includes('Q'),bK:cs.includes('k'),bQ:cs.includes('q')};
  epSq=parts[3]&&parts[3]!=='-'?fileRankToSq(parts[3]):-1;
  return b;
}
function fileRankToSq(s){if(!s||s.length<2)return -1;const c=s.charCodeAt(0)-97,r=8-parseInt(s[1]);return r*8+c;}
function sqName(sq){return String.fromCharCode(97+sq%8)+(8-Math.floor(sq/8));}
function sqRC(sq){return{r:Math.floor(sq/8),c:sq%8};}
// For rendering — pixel center of square, accounting for board flip
function sqXY(sq){
  const {r,c}=sqRC(sq);
  // Flip for boardFlipped (bot game as black) OR multiplayer black role
  const _fl=(typeof boardFlipped!=='undefined'&&boardFlipped)||
            (typeof mpRole!=='undefined'&&mpRole==='black');
  const dc=_fl?7-c:c;
  const dr=_fl?7-r:r;
  return {x:dc*SQ+SQ/2, y:dr*SQ+SQ/2};
}
// Row/col on canvas for a given square (for fillRect etc)
function sqCanvas(sq){
  const {r,c}=sqRC(sq);
  // Flip for boardFlipped (bot game as black) OR multiplayer black role
  const _fl=(typeof boardFlipped!=='undefined'&&boardFlipped)||
            (typeof mpRole!=='undefined'&&mpRole==='black'&&
             typeof mpRoomId!=='undefined'&&mpRoomId!==null);
  return {r:_fl?7-r:r, c:_fl?7-c:c};
}
function rcSq(r,c){return r*8+c;}
function valid(r,c){return r>=0&&r<8&&c>=0&&c<8;}

// ---- Attack helpers ----
function rawAttacks(sq,bd){
  const p=bd[sq];if(!p)return[];
  const{r,c}=sqRC(sq);const out=[];
  const slide=(dr,dc)=>{let nr=r+dr,nc=c+dc;while(valid(nr,nc)){out.push(rcSq(nr,nc));if(bd[rcSq(nr,nc)])break;nr+=dr;nc+=dc;}};
  if(p.piece==='R'||p.piece==='Q'){slide(0,1);slide(0,-1);slide(1,0);slide(-1,0);}
  if(p.piece==='B'||p.piece==='Q'){slide(1,1);slide(1,-1);slide(-1,1);slide(-1,-1);}
  if(p.piece==='N'){for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(valid(r+dr,c+dc))out.push(rcSq(r+dr,c+dc));}
  if(p.piece==='K'){for(const[dr,dc]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])if(valid(r+dr,c+dc))out.push(rcSq(r+dr,c+dc));}
  if(p.piece==='P'){const d=p.color==='w'?-1:1;if(valid(r+d,c-1))out.push(rcSq(r+d,c-1));if(valid(r+d,c+1))out.push(rcSq(r+d,c+1));}
  return out;
}

function influenceSquares(sq,bd){
  const p=bd[sq];if(!p)return[];
  const{r,c}=sqRC(sq);const out=new Set();
  const slideAll=(dr,dc)=>{let nr=r+dr,nc=c+dc;while(valid(nr,nc)){out.add(rcSq(nr,nc));if(bd[rcSq(nr,nc)])break;nr+=dr;nc+=dc;}};
  if(p.piece==='R'||p.piece==='Q'){slideAll(0,1);slideAll(0,-1);slideAll(1,0);slideAll(-1,0);}
  if(p.piece==='B'||p.piece==='Q'){slideAll(1,1);slideAll(1,-1);slideAll(-1,1);slideAll(-1,-1);}
  if(p.piece==='N'){for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(valid(r+dr,c+dc))out.add(rcSq(r+dr,c+dc));}
  if(p.piece==='K'){for(const[dr,dc]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])if(valid(r+dr,c+dc))out.add(rcSq(r+dr,c+dc));}
  if(p.piece==='P'){
    const d=p.color==='w'?-1:1;
    if(valid(r+d,c-1))out.add(rcSq(r+d,c-1));
    if(valid(r+d,c+1))out.add(rcSq(r+d,c+1));
  }
  return[...out];
}

// Direct attack map
// ── Pin detection ──────────────────────────────────────────────────────────
// Returns set of squares whose pieces are absolutely pinned to their king
function getPinnedSquares(bd, color) {
  const pinned = new Set();
  const kSq = kingSquare(bd, color);
  if(kSq < 0) return pinned;
  // If king is already in check, don't compute pins —
  // pieces blocking check are not classically "pinned"
  if(inCheck(bd, color)) return pinned;
  for(let s = 0; s < 64; s++) {
    const p = bd[s];
    if(!p || p.color !== color || p.piece === 'K') continue;
    const bd2 = {...bd}; delete bd2[s];
    if(inCheck(bd2, color)) pinned.add(s);
  }
  return pinned;
}

// Returns set of squares pinned to the queen (moving exposes queen to attack)
function getQueenPinnedSquares(bd, color) {
  const pinned = new Set();
  const opp = color === 'w' ? 'b' : 'w';
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  // Find own queen(s)
  for(let q = 0; q < 64; q++) {
    const qp = bd[q];
    if(!qp || qp.color !== color || qp.piece !== 'Q') continue;
    // If queen is already under attack, skip — pieces aren't classically pinned
    if(isAttackedBy(q, opp, bd)) continue;
    const {r:qr, c:qc} = sqRC(q);
    // Trace rays outward from queen in 8 directions
    for(const [dr,dc] of DIRS) {
      let r = qr+dr, c = qc+dc;
      let firstFriendly = -1;
      while(r>=0&&r<8&&c>=0&&c<8) {
        const s = rcSq(r,c);
        const p = bd[s];
        if(p) {
          if(p.color === color) {
            if(firstFriendly < 0) {
              firstFriendly = s; // potential pinner candidate
            } else {
              break; // second friendly blocks the ray
            }
          } else {
            // enemy piece
            if(firstFriendly >= 0) {
              // Check if this enemy slider attacks along this ray direction
              const canSlide = (
                (dr===0||dc===0) ? (p.piece==='R'||p.piece==='Q') // rank/file
                                 : (p.piece==='B'||p.piece==='Q') // diagonal
              );
              if(canSlide) pinned.add(firstFriendly);
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

// ── Check threat detection ──────────────────────────────────────────────────
// Returns { destSquares, pieceSquares }
// destSquares: squares a piece CAN MOVE TO to give check (highlighted on board)
// pieceSquares: the current squares of those threatening pieces (piece glow)
function getCheckThreats(bd, color, ep, cst) {
  const destSquares  = new Set();
  const pieceSquares = new Set();
  const opp = color === 'w' ? 'b' : 'w';
  if(inCheck(bd, color) || inCheck(bd, opp)) return { destSquares, pieceSquares };
  const kSq = kingSquare(bd, opp);
  if(kSq < 0) return { destSquares, pieceSquares };
  for(let s = 0; s < 64; s++) {
    const p = bd[s];
    if(!p || p.color !== color) continue;
    const moves = legalMovesFor(s, bd, ep, cst);
    for(const to of moves) {
      const bd2 = applyMove(s, to, bd, ep, 'Q');
      if(inCheck(bd2, opp)) {
        destSquares.add(to);
        pieceSquares.add(s);
        break; // one checking move is enough to flag this piece
      }
    }
  }
  return { destSquares, pieceSquares };
}

// Get the king square for a color
function getPinRaySquares(bd, pieceSq, color){
  // Returns squares a pinned piece can still threaten:
  // all squares along the pin ray away from king, INCLUDING the pinner.
  // A pinned piece CAN legally capture the pinner (that resolves the pin).
  const kSq=kingSquare(bd,color);
  if(kSq<0) return new Set();
  const{r:kr,c:kc}=sqRC(kSq);
  const{r:pr,c:pc}=sqRC(pieceSq);
  const dr=Math.sign(kr-pr), dc=Math.sign(kc-pc);
  if(dr===0&&dc===0) return new Set();
  // Must be on same rank, file or diagonal
  if(dr!==0&&dc!==0&&Math.abs(kr-pr)!==Math.abs(kc-pc)) return new Set();
  if(dr===0&&kr!==pr) return new Set();
  if(dc===0&&kc!==pc) return new Set();
  // Walk AWAY from king — collect squares up to and including the pinner
  const ray=new Set();
  let r=pr-dr, c=pc-dc;
  while(r>=0&&r<8&&c>=0&&c<8){
    const sq=rcSq(r,c);
    ray.add(sq); // include this square
    if(bd[sq]) break; // pinner found — stop here (but include it, so piece can capture it)
    r-=dr; c-=dc;
  }
  // Also include squares between piece and king (for blocking purposes — 
  // but pinned piece generally can't go toward king, only rawAttacks handles that)
  return ray;
}

// Get allowed attack squares for a queen-pinned piece:
// it can only capture the piece pinning it to the queen (that removes the pin)
// Uses queen's position as the ray anchor instead of king's
function getQueenPinRaySquares(bd, pieceSq, color) {
  // Find which queen is doing the pinning
  const opp = color==='w'?'b':'w';
  const {r:pr,c:pc} = sqRC(pieceSq);
  const DIRS=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  for(const [dr,dc] of DIRS){
    // Walk away from piece looking for the pinning slider
    let r=pr+dr,c=pc+dc;
    while(r>=0&&r<8&&c>=0&&c<8){
      const sq=rcSq(r,c);
      if(bd[sq]){
        if(bd[sq].color===opp&&(bd[sq].piece==='Q'||bd[sq].piece==='R'||bd[sq].piece==='B')){
          // Found potential pinner — verify it actually attacks back through pieceSq
          // toward our queen
          const ray=new Set();
          ray.add(sq); // can capture the pinner
          return ray;
        }
        break; // blocked by something else
      }
      r+=dr;c+=dc;
    }
  }
  return new Set();
}

function buildDirectAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB){
  const a={};for(let s=0;s<64;s++)a[s]={w:[],b:[]};
  for(let s=0;s<64;s++){
    if(!bd[s])continue;
    const col=bd[s].color;
    const opp=col==='w'?'b':'w';
    const isKingPinned=(col==='w'&&pinnedW&&pinnedW.has(s)&&!(queenPinnedW&&queenPinnedW.has(s)))||
                       (col==='b'&&pinnedB&&pinnedB.has(s)&&!(queenPinnedB&&queenPinnedB.has(s)));
    const isQueenPinned=(col==='w'&&queenPinnedW&&queenPinnedW.has(s))||
                        (col==='b'&&queenPinnedB&&queenPinnedB.has(s));
    if(isKingPinned){
      // King-pinned: can only attack along ray toward king (including pinner)
      const ray=getPinRaySquares(bd,s,col);
      for(const t of rawAttacks(s,bd)){
        if(ray.has(t)) a[t][col].push(s);
      }
    } else if(isQueenPinned){
      // Queen-pinned: can only capture the piece pinning it to the queen
      // (that removes the pin without exposing the queen)
      const ray=getQueenPinRaySquares(bd,s,col);
      for(const t of rawAttacks(s,bd)){
        if(ray.has(t)) a[t][col].push(s);
      }
    } else {
      for(const t of rawAttacks(s,bd))a[t][col].push(s);
    }
  }
  return a;
}

// Battery: SEE-style — simulate full capture sequence from both sides, take max participation
const VALS={P:1,N:3,B:3,R:5,Q:9,K:100};

function currentAttackersOf(tgtSq,color,brd){
  const out=[];
  for(let s=0;s<64;s++){
    const p=brd[s];if(!p||p.color!==color)continue;
    if(rawAttacks(s,brd).includes(tgtSq))out.push({sq:s,val:VALS[p.piece]||0});
  }
  out.sort((a,b)=>a.val-b.val);
  return out;
}

function runExchange(tgtSq,startSide,brd){
  let b={...brd},side=startSide,wC=0,bC=0;
  for(let i=0;i<32;i++){
    const atks=currentAttackersOf(tgtSq,side,b);
    if(!atks.length)break;
    const{sq:atkSq}=atks[0];
    const nb={...b};nb[tgtSq]=nb[atkSq];delete nb[atkSq];
    b=nb;
    if(side==='w')wC++;else bC++;
    side=side==='w'?'b':'w';
  }
  return{w:wC,b:bC};
}

function buildBatteryAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB){
  const direct=buildDirectAtk(bd, pinnedW, pinnedB, queenPinnedW, queenPinnedB);
  const a={};
  for(let s=0;s<64;s++){
    const dw=direct[s].w.length, db=direct[s].b.length;
    if(dw===0&&db===0){a[s]={w:[],b:[]};continue;}
    // For a square occupied by a piece, simulate the full exchange:
    // attacker goes first (the side that would capture the piece on s),
    // then defenders recapture. This correctly counts both batteries.
    // If square is empty, we still count all attackers from both sides.
    const occ=bd[s];
    let wCount=dw, bCount=db;
    if(occ){
      // Attacker is the opponent of the piece on the square
      const attackerColor=occ.color==='w'?'b':'w';
      const defenderColor=occ.color;
      // Run exchange starting with attacker (they capture first)
      const fAtk=runExchange(s,attackerColor,bd);
      // Attacker count: how many attackers participate
      // Defender count: how many defenders recapture
      const atkCount = attackerColor==='w' ? fAtk.w : fAtk.b;
      const defCount = defenderColor==='w' ? fAtk.w : fAtk.b;
      // Also run from defender side (if they could initiate — unusual but covers edge cases)
      const fDef=runExchange(s,defenderColor,bd);
      const atkCount2 = attackerColor==='w' ? fDef.w : fDef.b;
      const defCount2 = defenderColor==='w' ? fDef.w : fDef.b;
      if(occ.color==='w'){
        wCount=Math.max(dw, defCount, defCount2);
        bCount=Math.max(db, atkCount, atkCount2);
      } else {
        bCount=Math.max(db, defCount, defCount2);
        wCount=Math.max(dw, atkCount, atkCount2);
      }
    } else {
      // Empty square — count all who can come in from each side
      const fw=runExchange(s,'w',bd);
      const fb=runExchange(s,'b',bd);
      wCount=Math.max(dw,fw.w,fb.w);
      bCount=Math.max(db,fw.b,fb.b);
    }
    a[s]={w:Array(wCount).fill(s),b:Array(bCount).fill(s)};
  }
  return a;
}

// Compute absolute pins (to king) and optionally queen pins for a board.
// Absolute pins are ALWAYS computed: a piece pinned to its king cannot
// legally recapture, so counting it as a defender would be a factual error
// in the attacker/defender numbers — regardless of whether the pin overlay
// is displayed. Queen pins are a softer fact (the piece CAN move, at a
// price), so including them in the counts is the user's choice via the
// checkbox. The Pins indicator button only controls drawing the markers.
function computePins(bd){
  const qpEl = document.getElementById('cbQPins');
  const useQPins = qpEl ? qpEl.checked : false;
  const pW=getPinnedSquares(bd,'w');
  const pB=getPinnedSquares(bd,'b');
  let qpW=new Set(), qpB=new Set();
  if(useQPins){
    qpW=getQueenPinnedSquares(bd,'w');
    qpB=getQueenPinnedSquares(bd,'b');
    // Merge queen pins into main pin sets (counts + rendering)
    qpW.forEach(s=>pW.add(s));
    qpB.forEach(s=>pB.add(s));
  }
  return{w:pW, b:pB, qw:qpW, qb:qpB};
}

function buildAtk(bd){
  const pins=computePins(bd);
  if(indActive('battery')) return buildBatteryAtk(bd,pins.w,pins.b,pins.qw,pins.qb);
  return buildDirectAtk(bd,pins.w,pins.b,pins.qw,pins.qb);
}

function rebuildAtk(){
  atkMap=buildAtk(board);
  const p=computePins(board);
  pinnedWSquares=p.w;pinnedBSquares=p.b;
  if(previewBoard){
    previewAtk=buildAtk(previewBoard);
    const pp=computePins(previewBoard);
    previewPinsW=pp.w;previewPinsB=pp.b;
  }
  render();
}

// ---- Check / legal ----
function kingSquare(bd,color){for(let s=0;s<64;s++)if(bd[s]&&bd[s].piece==='K'&&bd[s].color===color)return s;return -1;}
function isAttackedBy(sq,byColor,bd){for(let s=0;s<64;s++){if(!bd[s]||bd[s].color!==byColor)continue;if(rawAttacks(s,bd).includes(sq))return true;}return false;}
function inCheck(bd,color){return isAttackedBy(kingSquare(bd,color),color==='w'?'b':'w',bd);}

function castlingLegal(bd,color,side){
  const opp=color==='w'?'b':'w',r=color==='w'?7:0,kSq=rcSq(r,4);
  if(!bd[kSq]||bd[kSq].piece!=='K'||bd[kSq].color!==color)return false;
  if(inCheck(bd,color))return false;
  if(side==='K'){
    const rSq=rcSq(r,7);if(!bd[rSq]||bd[rSq].piece!=='R'||bd[rSq].color!==color)return false;
    if(bd[rcSq(r,5)]||bd[rcSq(r,6)])return false;
    if(isAttackedBy(rcSq(r,5),opp,bd)||isAttackedBy(rcSq(r,6),opp,bd))return false;
  }else{
    const rSq=rcSq(r,0);if(!bd[rSq]||bd[rSq].piece!=='R'||bd[rSq].color!==color)return false;
    if(bd[rcSq(r,3)]||bd[rcSq(r,2)]||bd[rcSq(r,1)])return false;
    if(isAttackedBy(rcSq(r,3),opp,bd)||isAttackedBy(rcSq(r,2),opp,bd))return false;
  }
  return true;
}

function pseudoMoves(sq,bd,ep,cst){
  const p=bd[sq];if(!p)return[];
  const{r,c}=sqRC(sq);const col=p.color,opp=col==='w'?'b':'w';const moves=[];
  const addIfNotOwn=(tsq)=>{if(!bd[tsq]||bd[tsq].color!==col)moves.push(tsq);};
  if(p.piece==='P'){
    const d=col==='w'?-1:1,start=col==='w'?6:1;
    if(valid(r+d,c)&&!bd[rcSq(r+d,c)]){moves.push(rcSq(r+d,c));if(r===start&&!bd[rcSq(r+2*d,c)])moves.push(rcSq(r+2*d,c));}
    for(const dc of[-1,1]){if(valid(r+d,c+dc)){const tsq=rcSq(r+d,c+dc);if(bd[tsq]&&bd[tsq].color===opp)moves.push(tsq);if(tsq===ep)moves.push(tsq);}}
  }else if(p.piece==='K'){
    for(const[dr,dc2]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])if(valid(r+dr,c+dc2))addIfNotOwn(rcSq(r+dr,c+dc2));
    if(c===4){
      if(col==='w'&&cst.wK&&castlingLegal(bd,col,'K'))moves.push(rcSq(r,6));
      if(col==='w'&&cst.wQ&&castlingLegal(bd,col,'Q'))moves.push(rcSq(r,2));
      if(col==='b'&&cst.bK&&castlingLegal(bd,col,'K'))moves.push(rcSq(r,6));
      if(col==='b'&&cst.bQ&&castlingLegal(bd,col,'Q'))moves.push(rcSq(r,2));
    }
  }else{for(const t of rawAttacks(sq,bd))addIfNotOwn(t);}
  return moves;
}

function legalMovesFor(sq,bd,ep,cst){
  const p=bd[sq];if(!p)return[];
  return pseudoMoves(sq,bd,ep,cst).filter(to=>{const bd2=applyMove(sq,to,bd,ep,'Q');return!inCheck(bd2,p.color);});
}
function allLegalMoves(bd,col,ep,cst){const all=[];for(let s=0;s<64;s++)if(bd[s]&&bd[s].color===col)for(const t of legalMovesFor(s,bd,ep,cst))all.push({from:s,to:t});return all;}

function applyMove(from,to,bd,ep,promo){
  const bd2={...bd},p=bd2[from];bd2[to]=p;delete bd2[from];
  if(p.piece==='P'&&to===ep)delete bd2[rcSq(Math.floor(from/8),to%8)];
  if(p.piece==='K'){const{r,c:fc}=sqRC(from);const{c:tc}=sqRC(to);if(Math.abs(tc-fc)===2){if(tc===6){bd2[rcSq(r,5)]=bd2[rcSq(r,7)];delete bd2[rcSq(r,7)];}if(tc===2){bd2[rcSq(r,3)]=bd2[rcSq(r,0)];delete bd2[rcSq(r,0)];}}}
  if(p.piece==='P'&&(Math.floor(to/8)===0||Math.floor(to/8)===7))bd2[to]={piece:promo||'Q',color:p.color};
  return bd2;
}
function computeEP(from,to,bd){const p=bd[from];if(p&&p.piece==='P'&&Math.abs(Math.floor(from/8)-Math.floor(to/8))===2)return rcSq((Math.floor(from/8)+Math.floor(to/8))/2,from%8);return -1;}
function updateCastling(from,to,p,cst){
  const c2={...cst};
  if(p.piece==='K'){if(p.color==='w'){c2.wK=false;c2.wQ=false;}else{c2.bK=false;c2.bQ=false;}}
  if(from===rcSq(7,0)||to===rcSq(7,0))c2.wQ=false;if(from===rcSq(7,7)||to===rcSq(7,7))c2.wK=false;
  if(from===rcSq(0,0)||to===rcSq(0,0))c2.bQ=false;if(from===rcSq(0,7)||to===rcSq(0,7))c2.bK=false;
  return c2;
}

// Convert a move to Standard Algebraic Notation
function moveToSAN(from, to, promo, bd, ep, cst) {
  const p = bd[from];
  if(!p) return '?';
  const {r:fr,c:fc} = sqRC(from);
  const {r:tr,c:tc} = sqRC(to);
  const toFile = String.fromCharCode(97+tc);
  const toRank = String(8-tr);
  const capture = !!bd[to] || (p.piece==='P' && tc!==fc); // en passant
  // Castling
  if(p.piece==='K' && Math.abs(tc-fc)===2){
    return tc>fc ? 'O-O' : 'O-O-O';
  }
  let san = '';
  if(p.piece !== 'P'){
    san += p.piece;
    // Disambiguation: find other pieces of same type that can also go to 'to'
    let ambigFile=false, ambigRank=false;
    for(let s=0;s<64;s++){
      if(s===from) continue;
      const q=bd[s];
      if(!q||q.color!==p.color||q.piece!==p.piece) continue;
      if(legalMovesFor(s,bd,ep,cst).includes(to)){
        const {r:sr,c:sc}=sqRC(s);
        if(sc===fc) ambigRank=true; else ambigFile=true;
      }
    }
    if(ambigFile||ambigRank){
      if(!ambigFile) san += String.fromCharCode(97+fc);
      else if(!ambigRank) san += String(8-fr);
      else san += String.fromCharCode(97+fc)+String(8-fr);
    }
  } else if(capture){
    san += String.fromCharCode(97+fc);
  }
  if(capture) san += 'x';
  san += toFile + toRank;
  if(promo) san += '=' + (promo||'Q');
  // Check/checkmate
  const bd2 = applyMove(from,to,bd,ep,promo||'Q');
  const nextTurn = p.color==='w'?'b':'w';
  const nextEp = computeEP(from,to,bd);
  const nextMoves = allLegalMoves(bd2,nextTurn,nextEp,cst);
  if(inCheck(bd2,nextTurn)){
    san += nextMoves.length===0 ? '#' : '+';
  }
  return san;
}

// ── Move sounds ───────────────────────────────────────────────────────

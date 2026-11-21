// ── Chess960 ────────────────────────────────────────────────────────────────
// A Chess960 game starts from one of 960 back ranks: the king somewhere between
// its two rooks, the bishops on opposite colours. Castling ends exactly as in
// standard chess (O-O: king g-file, rook f-file; O-O-O: king c-file, rook
// d-file), but the king and rook can start almost anywhere, so "the king moves
// two squares" no longer identifies it: the king may move one square, or none,
// and a one-square castle looks just like an ordinary king step.
//
// So in a Chess960 game a castle is written KING TAKES ITS OWN ROOK (e1h1, b1a1),
// the way Lichess and Stockfish (UCI_Chess960) write it. A king can never
// otherwise land on its own piece, so the move cannot be mistaken for anything
// else. Standard games keep king-two-squares (e1g1), which everything else in the
// app (Maia, the opening explorer, the book) speaks; nothing changes for them.
//
// chess960 says which game this is, and castleFiles which rook each castling
// right belongs to. Both are fixed for a game: a right is lost for good when its
// rook leaves home. setChess960() sets them at the start of every game;
// parseFen() reads the rook files from a FEN while chess960 is on.
var chess960 = false;
var castleFiles = { wK: 7, wQ: 0, bK: 7, bQ: 0 };
function setChess960(on){
  chess960 = !!on;
  castleFiles = { wK: 7, wQ: 0, bK: 7, bQ: 0 };
}
// The square of the rook a castling right belongs to. side: 'K' | 'Q'.
function castleRookSq(color, side){
  return rcSq(color==='w'?7:0, castleFiles[color+side]);
}
// The file of the outermost rook on one side of the king on its home rank, or
// -1. That is what K/Q/k/q name in a Chess960 FEN (X-FEN).
function _outerRookFile(bd, color, side){
  const r=color==='w'?7:0;
  let kf=-1;
  for(let c=0;c<8;c++){const p=bd[rcSq(r,c)];if(p&&p.piece==='K'&&p.color===color){kf=c;break;}}
  if(kf<0)return -1;
  const isRook=(c)=>{const p=bd[rcSq(r,c)];return !!p&&p.piece==='R'&&p.color===color;};
  if(side==='K'){for(let c=7;c>kf;c--)if(isRook(c))return c;}
  else{for(let c=0;c<kf;c++)if(isRook(c))return c;}
  return -1;
}
// A FEN castling field -> { cst, files }. Reads KQkq and Shredder/X-FEN file
// letters (HAha, or a mix). files has a rook file for each right present: the
// letter's file, or for K/Q the outermost rook on that side (the corner rook in
// standard chess). Pure.
function parseCastlingField(cs, bd){
  const cst={wK:false,wQ:false,bK:false,bQ:false}, files={wK:7,wQ:0,bK:7,bQ:0};
  if(!cs||cs==='-')return{cst,files};
  for(const ch of cs){
    const col=ch===ch.toUpperCase()?'w':'b', up=ch.toUpperCase();
    if(up==='K'||up==='Q'){
      cst[col+up]=true;
      const f=_outerRookFile(bd,col,up);
      if(f>=0)files[col+up]=f;
    }else if(up>='A'&&up<='H'){
      const f=up.charCodeAt(0)-65;
      const r=col==='w'?7:0;
      let kf=4;
      for(let c=0;c<8;c++){const p=bd[rcSq(r,c)];if(p&&p.piece==='K'&&p.color===col){kf=c;break;}}
      const side=f>kf?'K':'Q';
      cst[col+side]=true;files[col+side]=f;
    }
  }
  return{cst,files};
}
// The castling field for a FEN. Standard: KQkq. Chess960: X-FEN — K/Q/k/q when
// the right's rook is the outermost one on that side (always so at the start),
// its file letter otherwise — which Stockfish and Lichess both read.
function castlingFieldFor(bd, cst){
  let s='';
  for(const[col,side,ch]of[['w','K','K'],['w','Q','Q'],['b','K','k'],['b','Q','q']]){
    if(!cst||!cst[col+side])continue;
    if(!chess960){s+=ch;continue;}
    const f=castleFiles[col+side];
    s+=(_outerRookFile(bd,col,side)===f)?ch:String.fromCharCode((col==='w'?65:97)+f);
  }
  return s||'-';
}
// The back rank of Chess960 position n (0-959), in the standard numbering
// (Scharnagl's, as Lichess and FIDE use): 518 is the standard RNBQKBNR.
function chess960BackRank(n){
  n=((Math.floor(+n)%960)+960)%960;
  const rank=Array(8).fill(null);
  rank[2*(n%4)+1]='B'; n=Math.floor(n/4);          // light-squared bishop: b, d, f, h
  rank[2*(n%4)]='B';   n=Math.floor(n/4);          // dark-squared bishop: a, c, e, g
  const empty=()=>rank.map((p,i)=>p?-1:i).filter(i=>i>=0);
  rank[empty()[n%6]]='Q'; n=Math.floor(n/6);
  const KN=[[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]][n];
  const e=empty();
  rank[e[KN[0]]]='N';rank[e[KN[1]]]='N';
  const rest=empty();
  rank[rest[0]]='R';rank[rest[1]]='K';rank[rest[2]]='R';
  return rank.join('');
}
function chess960StartFen(n){
  const br=chess960BackRank(n);
  return br.toLowerCase()+'/pppppppp/8/8/8/8/PPPPPPPP/'+br+' w KQkq - 0 1';
}
function chess960RandomNumber(){ return Math.floor(Math.random()*960); }
// Which Chess960 position a FEN's back ranks are, or -1 (not a start position).
function chess960NumberOf(fen){
  const rows=String(fen||'').split(' ')[0].split('/');
  if(rows.length!==8||rows[1]!=='pppppppp'||rows[6]!=='PPPPPPPP')return -1;
  if(rows[0]!==rows[7].toLowerCase())return -1;
  for(let n=0;n<960;n++)if(chess960BackRank(n)===rows[7])return n;
  return -1;
}
// Is from->to a castle on this board? Either form: king takes own rook
// (Chess960), or king two squares along its rank (standard).
function isCastleMove(bd, from, to){
  const p=bd[from];if(!p||p.piece!=='K')return false;
  const t=bd[to];
  if(t&&t.color===p.color&&t.piece==='R')return true;
  return Math.floor(from/8)===Math.floor(to/8)&&Math.abs(to%8-from%8)===2;
}
// Does from->to take a piece? A Chess960 castle lands on the king's own rook,
// which is not a capture.
function moveCaptures(bd, from, to, ep){
  const p=bd[from];if(!p)return false;
  const t=bd[to];
  if(t)return t.color!==p.color;
  return p.piece==='P'&&to===ep;
}
// A king move as an engine or a player may write it in a Chess960 game, as the
// move this board plays: king onto the castling destination (e1g1, the standard
// spelling) becomes king takes rook (e1h1) when that is a legal castle and the
// destination is not a legal king step of its own. Everything else as given.
function chess960CastleAlias(bd, from, to, ep, cst){
  if(!chess960)return to;
  const p=bd[from];if(!p||p.piece!=='K')return to;
  const r=Math.floor(from/8);
  if(r!==(p.color==='w'?7:0)||Math.floor(to/8)!==r)return to;
  const side=to%8===6?'K':to%8===2?'Q':null;
  if(!side||!cst||!cst[p.color+side])return to;
  const legal=legalMovesFor(from,bd,ep,cst);
  if(legal.includes(to))return to;
  const rk=castleRookSq(p.color,side);
  return legal.includes(rk)?rk:to;
}

function parseFen(fen){
  const parts=fen.split(' '),b={};
  const rows=parts[0].split('/');
  for(let r=0;r<8;r++){let c=0;for(const ch of rows[r]){if('12345678'.includes(ch)){c+=+ch;}else{b[r*8+c]={piece:ch.toUpperCase(),color:ch===ch.toUpperCase()?'w':'b'};c++;}}}
  turn=parts[1]||'w';
  const cs=parts[2]||'-';
  const pc=parseCastlingField(cs,b);
  castling=pc.cst;
  // The rook files only mean something in a Chess960 game; in a standard one
  // the rights belong to the corner rooks, whatever the FEN.
  if(chess960){
    for(const k of['wK','wQ','bK','bQ'])if(pc.cst[k])castleFiles[k]=pc.files[k];
  }
  epSq=parts[3]&&parts[3]!=='-'?fileRankToSq(parts[3]):-1;
  return b;
}
function fileRankToSq(s){if(!s||s.length<2)return -1;const c=s.charCodeAt(0)-97,r=8-parseInt(s[1]);return r*8+c;}
function sqName(sq){return String.fromCharCode(97+sq%8)+(8-Math.floor(sq/8));}
function sqRC(sq){return{r:Math.floor(sq/8),c:sq%8};}
// ── Where a square lands on the canvas ──────────────────────────────────────
// Both of these ask boardViewFlipped() rather than reading boardFlipped, and
// that is the whole point. There used to be four hand-rolled copies of the
// flip rule — here, in sqCanvas below, in render() and in the ghost layer —
// and no two of them agreed: one tested `mpRole==='black'`, one added
// `mpRoomId!==null`, one was a bare `boardFlipped`. render()'s copy drew the
// squares, the last-move highlight and the coordinates; these two placed the
// pieces and every overlay on top of them. So a view flip turned the board
// underneath and left the pieces where they were.
//
// boardViewFlipped() is the single answer to "which way round is this board
// drawn", seat and user flip together. Do not inline it again.
function sqXY(sq){
  const {r,c}=sqRC(sq);
  const _fl=boardViewFlipped();
  const dc=_fl?7-c:c;
  const dr=_fl?7-r:r;
  return {x:dc*SQ+SQ/2, y:dr*SQ+SQ/2};
}
// Row/col on canvas for a given square (for fillRect etc)
function sqCanvas(sq){
  const {r,c}=sqRC(sq);
  const _fl=boardViewFlipped();
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

// The parts of a castle that do not depend on attacks: the king on its home
// rank (on the e-file in standard chess), the right's rook at home on the
// correct side of it, and every square either piece crosses or lands on empty
// but for the two of them. Returns the king and rook squares and the king's
// destination file, or null. In standard chess this is exactly the old test:
// f and g empty for O-O; b, c and d for O-O-O.
function _castleGeometry(bd,color,side){
  const r=color==='w'?7:0;
  const kSq=kingSquare(bd,color);
  if(kSq<0||Math.floor(kSq/8)!==r)return null;
  const kf=kSq%8;
  if(!chess960&&kf!==4)return null;
  const rf=castleFiles[color+side];
  const rSq=rcSq(r,rf);
  const rp=bd[rSq];
  if(!rp||rp.piece!=='R'||rp.color!==color)return null;
  if(side==='K'?rf<=kf:rf>=kf)return null;
  const kTo=side==='K'?6:2, rTo=side==='K'?5:3;
  // The two paths together always make one unbroken stretch of the rank.
  const lo=Math.min(kf,kTo,rf,rTo), hi=Math.max(kf,kTo,rf,rTo);
  for(let c=lo;c<=hi;c++){const s=rcSq(r,c);if(s!==kSq&&s!==rSq&&bd[s])return null;}
  return{kSq,rSq,kf,kTo,r};
}
function castlingLegal(bd,color,side){
  const g=_castleGeometry(bd,color,side);
  if(!g)return false;
  if(inCheck(bd,color))return false;
  // The king may not cross or land on an attacked square. A castle that only
  // uncovers an attack once the rook has moved is caught by legalMovesFor,
  // which plays the move and looks for check.
  const opp=color==='w'?'b':'w';
  if(g.kf!==g.kTo){
    const step=g.kTo>g.kf?1:-1;
    for(let c=g.kf+step;c!==g.kTo+step;c+=step)
      if(isAttackedBy(rcSq(g.r,c),opp,bd))return false;
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
    // Castling: to the destination square in standard chess, onto the rook in
    // Chess960 (see castleRookSq).
    if(cst&&r===(col==='w'?7:0)){
      for(const side of['K','Q']){
        if(cst[col+side]&&castlingLegal(bd,col,side))
          moves.push(chess960?castleRookSq(col,side):rcSq(r,side==='K'?6:2));
      }
    }
  }else{for(const t of rawAttacks(sq,bd))addIfNotOwn(t);}
  return moves;
}

function legalMovesFor(sq,bd,ep,cst){
  const p=bd[sq];if(!p)return[];
  return pseudoMoves(sq,bd,ep,cst).filter(to=>{const bd2=applyMove(sq,to,bd,ep,'Q');return!inCheck(bd2,p.color);});
}
function allLegalMoves(bd,col,ep,cst){const all=[];for(let s=0;s<64;s++)if(bd[s]&&bd[s].color===col)for(const t of legalMovesFor(s,bd,ep,cst))all.push({from:s,to:t});return all;}

// ── Premove destinations ────────────────────────────────────────────────────
// A premove is committed before the opponent has replied, so it CANNOT be
// checked for legality: the position it will land in does not exist yet.
// Chess.com and Lichess both resolve this optimistically — offer the squares a
// piece could plausibly reach, then validate for real at fire time and discard
// whatever failed. This generates that optimistic set.
//
// "Plausible" differs from "legal" in three ways, and each one is a move people
// genuinely want to queue:
//   • Enemy pieces are not blockers. They may move, so we slide THROUGH them
//     and may land on them — that is the capture that isn't available yet.
//   • Pawns may step diagonally onto an empty square. That is the recapture
//     you are pre-committing to.
//   • Check is not evaluated at all. Whether we end up in check depends on the
//     opponent's move, which hasn't happened.
// Own pieces ARE blockers: nothing can move them aside first, because any
// earlier premove in the chain is already applied to the board passed in here.
function premoveDests(sq,bd,cst){
  const p=bd[sq];if(!p)return[];
  const{r,c}=sqRC(sq);const col=p.color;const out=new Set();
  const mine=(t)=>bd[t]&&bd[t].color===col;
  const add=(rr,cc)=>{if(valid(rr,cc)){const t=rcSq(rr,cc);if(!mine(t))out.add(t);}};
  const ray=(dr,dc)=>{
    for(let rr=r+dr,cc=c+dc;valid(rr,cc);rr+=dr,cc+=dc){
      const t=rcSq(rr,cc);
      if(mine(t))break;   // our own piece stops the ray; an enemy one does not
      out.add(t);
    }
  };
  if(p.piece==='P'){
    const d=col==='w'?-1:1,start=col==='w'?6:1;
    add(r+d,c);
    if(r===start&&valid(r+d,c)&&!mine(rcSq(r+d,c)))add(r+2*d,c);
    add(r+d,c-1);add(r+d,c+1);
  }else if(p.piece==='N'){
    for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])add(r+dr,c+dc);
  }else if(p.piece==='K'){
    for(const[dr,dc]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])add(r+dr,c+dc);
    // Castling rights and an empty path are knowable now; passing through check
    // is not, so that part is left to fire-time validation. In Chess960 the
    // castle is the king onto its own rook, so that square is offered too.
    if(cst&&r===(col==='w'?7:0)){
      for(const side of['K','Q']){
        if(cst[col+side]&&_castleGeometry(bd,col,side))
          out.add(chess960?castleRookSq(col,side):rcSq(r,side==='K'?6:2));
      }
    }
  }else{
    const dirs=p.piece==='R'?[[-1,0],[1,0],[0,-1],[0,1]]
              :p.piece==='B'?[[-1,-1],[-1,1],[1,-1],[1,1]]
              :[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    for(const[dr,dc]of dirs)ray(dr,dc);
  }
  out.delete(sq);
  return[...out];
}

function applyMove(from,to,bd,ep,promo){
  const bd2={...bd},p=bd2[from];
  // Chess960 castle, written king takes own rook: both land on the standard
  // castled squares (O-O: Kg Rf; O-O-O: Kc Rd), whichever they started on.
  if(p&&p.piece==='K'&&bd2[to]&&bd2[to].color===p.color&&bd2[to].piece==='R'){
    const rook=bd2[to],r=Math.floor(from/8),ks=to>from;
    delete bd2[from];delete bd2[to];
    bd2[rcSq(r,ks?6:2)]=p;bd2[rcSq(r,ks?5:3)]=rook;
    return bd2;
  }
  bd2[to]=p;delete bd2[from];
  if(p.piece==='P'&&to===ep)delete bd2[rcSq(Math.floor(from/8),to%8)];
  if(p.piece==='K'){const{r,c:fc}=sqRC(from);const{c:tc}=sqRC(to);if(Math.abs(tc-fc)===2){if(tc===6){bd2[rcSq(r,5)]=bd2[rcSq(r,7)];delete bd2[rcSq(r,7)];}if(tc===2){bd2[rcSq(r,3)]=bd2[rcSq(r,0)];delete bd2[rcSq(r,0)];}}}
  if(p.piece==='P'&&(Math.floor(to/8)===0||Math.floor(to/8)===7))bd2[to]={piece:promo||'Q',color:p.color};
  return bd2;
}
function computeEP(from,to,bd){const p=bd[from];if(p&&p.piece==='P'&&Math.abs(Math.floor(from/8)-Math.floor(to/8))===2)return rcSq((Math.floor(from/8)+Math.floor(to/8))/2,from%8);return -1;}
function updateCastling(from,to,p,cst){
  const c2={...cst};
  if(p.piece==='K'){if(p.color==='w'){c2.wK=false;c2.wQ=false;}else{c2.bK=false;c2.bQ=false;}}
  // A right goes when its rook leaves home or is taken there. The corner rooks
  // in standard chess; in Chess960 wherever the game's rooks started.
  for(const k of['wK','wQ','bK','bQ']){
    const s=rcSq(k[0]==='w'?7:0,castleFiles[k]);
    if(from===s||to===s)c2[k]=false;
  }
  return c2;
}

// Simple SAN parser: the move a SAN names in this position, or null when no
// legal move matches. Pure (moved here from the app shell so the repertoire
// engine can use it under the unit tests).
function algebraicToMove(san,bd,color,ep,castl){
  const _c=String(san).replace(/[+#!?]/g,'');
  if(chess960&&(_c==='O-O'||_c==='0-0'||_c==='O-O-O'||_c==='0-0-0')){
    // Chess960: the king onto the right's rook, wherever the two started.
    const side=(_c.length>3)?'Q':'K', k=kingSquare(bd,color), to=castleRookSq(color,side);
    return (k>=0&&legalMovesFor(k,bd,ep,castl).includes(to))?{from:k,to}:null;
  }
  if(_c==='O-O'||_c==='0-0'){const r=color==='w'?7:0;return{from:rcSq(r,4),to:rcSq(r,6)};}
  if(_c==='O-O-O'||_c==='0-0-0'){const r=color==='w'?7:0;return{from:rcSq(r,4),to:rcSq(r,2)};}
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

// Convert a move to Standard Algebraic Notation
function moveToSAN(from, to, promo, bd, ep, cst) {
  const p = bd[from];
  if(!p) return '?';
  const {r:fr,c:fc} = sqRC(from);
  const {r:tr,c:tc} = sqRC(to);
  const toFile = String.fromCharCode(97+tc);
  const toRank = String(8-tr);
  const capture = !!bd[to] || (p.piece==='P' && tc!==fc); // en passant
  // Castling: king two squares (standard) or king onto its own rook (Chess960).
  if(p.piece==='K' && (Math.abs(tc-fc)===2 || (bd[to] && bd[to].color===p.color))){
    return tc>fc ? 'O-O' : 'O-O-O';
  }
  let san = '';
  if(p.piece !== 'P'){
    san += p.piece;
    // Disambiguation, when another piece of the same kind can also go to 'to':
    // the file if none of them shares this piece's file, else the rank if none
    // shares its rank, else both. (It used to swap the two: rooks on a1 and f1
    // wrote Rf1-d1 as "R1d1", which names neither, and the SAN parser then
    // moved the a1 rook in review and takebacks.)
    let conflict=false, sameFile=false, sameRank=false;
    for(let s=0;s<64;s++){
      if(s===from) continue;
      const q=bd[s];
      if(!q||q.color!==p.color||q.piece!==p.piece) continue;
      if(legalMovesFor(s,bd,ep,cst).includes(to)){
        const {r:sr,c:sc}=sqRC(s);
        conflict=true;
        if(sc===fc) sameFile=true;
        if(sr===fr) sameRank=true;
      }
    }
    if(conflict){
      if(!sameFile) san += String.fromCharCode(97+fc);
      else if(!sameRank) san += String(8-fr);
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

// ── Draw-rule helpers (pure) ──────────────────────────────────────────────────

// Position key for threefold repetition: placement + side to move + castling
// rights + en-passant square. Including the raw epSq is slightly stricter than
// FIDE (which only distinguishes positions where an en-passant CAPTURE is
// actually possible): in the rare ep-set-but-uncapturable case we count two
// equal positions as different, delaying a repetition claim by a cycle —
// never declaring one falsely.
function positionKey(bd, turnColor, cst, ep){
  let s = turnColor +
    (cst.wK?'K':'') + (cst.wQ?'Q':'') + (cst.bK?'k':'') + (cst.bQ?'q':'') +
    '/' + ep + '/';
  for(let sq=0; sq<64; sq++){
    const p = bd[sq];
    s += p ? (p.color==='w' ? p.piece : p.piece.toLowerCase()) : '.';
  }
  return s;
}

// True when neither side can checkmate by ANY series of legal moves:
// K vs K, K+minor vs K, and K+B vs K+B with both bishops on the same color
// complex. (K+N vs K+N is NOT included — a helpmate is constructible.)
function isInsufficientMaterial(bd){
  const minors = [];
  for(let sq=0; sq<64; sq++){
    const p = bd[sq];
    if(!p || p.piece==='K') continue;
    if(p.piece==='P' || p.piece==='R' || p.piece==='Q') return false;
    minors.push({ piece: p.piece, light: (Math.floor(sq/8) + sq%8) % 2 === 0 });
  }
  if(minors.length === 0) return true;   // K vs K
  if(minors.length === 1) return true;   // K+B or K+N vs bare K
  return minors.length === 2 &&
         minors[0].piece === 'B' && minors[1].piece === 'B' &&
         minors[0].light === minors[1].light; // same-color bishops
}

// ── Move sounds ───────────────────────────────────────────────────────

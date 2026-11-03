"""Mine premove-punish opportunities from Lichess games with centisecond clocks.

A move that used exactly 0 cs of clock is a premove (Lichess charges premoves nothing).
For premove R at ply j by player P, the solver O is the side that moved at ply j-1
(played F). Premoves are stored as orig->dest and fire if still legal, so for every
alternative A in the pre-F position where R stays legal, compare what O gets after
A,R against what O got after F,R.

Per candidate A:
  gain     = wp(A,R) - wp(F,R)    what exploiting the premove earns vs what happened
  backfire = wp(A,R) - wp(A,pass) how much worse R is than P doing nothing; high means the
                                  premove itself is the blunder, low means R merely ignored
                                  a threat (a free tempo)
  risk     = wp(root) - wp(A,best) what A costs if P had not premoved
"""
import json, math, sys, multiprocessing as mp
import chess, chess.engine

SF = sys.argv[3] if len(sys.argv) > 3 else 'stockfish.exe'
QUICK = chess.engine.Limit(depth=10)
DEEP = chess.engine.Limit(depth=18)
QUICK_GAIN = 25      # win% points A,R must beat F,R by at quick depth
FINAL_GAIN = 30      # ... and at deep depth


def wp(score):
    """Lichess win% for the side to move, from a PovScore-relative Score."""
    if score.is_mate():
        return 100.0 if score.mate() > 0 else 0.0
    cp = score.score()
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def wp_after(eng, board, solver, limit):
    """Win% for `solver` in `board` (any side to move); handles game-over boards."""
    if board.is_checkmate():
        return 0.0 if board.turn == solver else 100.0
    if board.is_stalemate() or board.is_insufficient_material():
        return 50.0
    info = eng.analyse(board, limit)
    w = wp(info['score'].relative)
    pv = info.get('pv') or []
    return (w if board.turn == solver else 100 - w), (pv[0] if pv else None)


def wpv(eng, board, solver, limit):
    r = wp_after(eng, board, solver, limit)
    return r if isinstance(r, tuple) else (r, None)


_eng = None


def init():
    global _eng
    _eng = chess.engine.SimpleEngine.popen_uci(SF)
    _eng.configure({'Threads': 1, 'Hash': 32})


def premove_plies(g):
    c = g.get('clocks')
    if not c or 'clock' not in g:
        return []
    inc = g['clock']['increment'] * 100
    return [i for i in range(2, len(c)) if c[i - 2] - c[i] + inc == 0]


def analyse_game(line):
    g = json.loads(line)
    sans = g.get('moves', '').split()
    pre = set(premove_plies(g))
    if not pre:
        return []
    board = chess.Board()
    boards, moves = [], []
    for san in sans:
        boards.append(board.copy())
        mv = board.parse_san(san)
        moves.append(mv)
        board.push(mv)
    out = []
    for j in sorted(pre):
        if j < 1 or j >= len(moves):
            continue
        pos0 = boards[j - 1]
        solver = pos0.turn
        F, R = moves[j - 1], moves[j]
        after_F = pos0.copy(); after_F.push(F)
        after_FR = after_F.copy(); after_FR.push(R)
        base, _ = wpv(_eng, after_FR, solver, QUICK)
        f_best_q, _ = wpv(_eng, after_F, solver, QUICK)
        punished = base - f_best_q >= 30    # the move actually played already sprang the trap
        if base > 75 and not punished:      # solver already winning comfortably; nothing to swindle
            continue
        hits = []
        for A in pos0.legal_moves:
            if A == F:
                continue
            b = pos0.copy(); b.push(A)
            if b.is_game_over():
                continue
            Rm = chess.Move(R.from_square, R.to_square, R.promotion)
            if not b.is_legal(Rm):
                continue
            b.push(Rm)
            w, _ = wpv(_eng, b, solver, QUICK)
            if w - base >= QUICK_GAIN:
                hits.append((w, A))
        if not hits and not punished:
            continue
        # deep confirm the best few
        base_d, _ = wpv(_eng, after_FR, solver, DEEP)
        root_d, root_best = wpv(_eng, pos0, solver, DEEP)
        f_sound, _ = wpv(_eng, after_F, solver, DEEP)
        cands = []
        for _, A in sorted(hits, key=lambda h: -h[0])[:4]:
            bA = pos0.copy(); bA.push(A)
            a_sound, p_best = wpv(_eng, bA, solver, DEEP)     # P replies best, not the premove
            bAR = bA.copy(); bAR.push(chess.Move(R.from_square, R.to_square, R.promotion))
            a_trap, _ = wpv(_eng, bAR, solver, DEEP)
            if a_trap - base_d < FINAL_GAIN:
                continue
            a_pass = None
            if not bA.is_check():
                bP = bA.copy(); bP.push(chess.Move.null())
                a_pass, _ = wpv(_eng, bP, solver, DEEP)
            cands.append({
                'A': pos0.san(A), 'A_uci': A.uci(),
                'wp_A_R': round(a_trap, 1), 'wp_A_best': round(a_sound, 1),
                'wp_A_pass': None if a_pass is None else round(a_pass, 1),
                'gain': round(a_trap - base_d, 1),
                'backfire': None if a_pass is None else round(a_trap - a_pass, 1),
                'risk': round(root_d - a_sound, 1),
                'P_best_vs_A': bA.san(p_best) if p_best else None,
                'check': bA.is_check(),
                'stalemate': bAR.is_stalemate(),
                'mate_after': bAR.is_checkmate(),
            })
        punished = base_d - f_sound >= 30
        if not cands and not punished:
            continue
        cands.sort(key=lambda c: -c['wp_A_R'])
        out.append({
            'id': g['id'], 'ply': j - 1,
            'white': g['players']['white'].get('rating'), 'black': g['players']['black'].get('rating'),
            'solver': 'white' if solver else 'black',
            'fen': pos0.fen(), 'F': pos0.san(F), 'R': after_F.san(R), 'R_uci': R.uci(),
            'wp_F_R': round(base_d, 1), 'wp_F_best': round(f_sound, 1), 'wp_root': round(root_d, 1),
            'root_best': pos0.san(root_best) if root_best else None,
            'punished_in_game': punished,
            'solver_clock_cs': g['clocks'][j - 1], 'premover_clock_cs': g['clocks'][j],
            'cands': cands,
        })
    return out


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding='utf-8').read().splitlines()
    done = 0
    with mp.Pool(6, initializer=init) as pool, open(dst, 'w', encoding='utf-8') as f:
        for res in pool.imap_unordered(analyse_game, lines, chunksize=2):
            for r in res:
                f.write(json.dumps(r) + '\n'); f.flush()
            done += 1
            if done % 50 == 0:
                print(f'{done}/{len(lines)}', flush=True)

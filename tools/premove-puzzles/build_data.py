"""Build data/premove-puzzles.json from mined hits.

usage: python build_data.py <stockfish> <out.json> <hits.jsonl>[,<hits.jsonl>...]

Keeps the puzzles worth playing: the premove itself becomes the blunder
(backfire >= 25, or stalemate) and the answer risks little if they had not
premoved (risk <= 30), at most two per game. Then every legal reply is scored
so the app can judge any attempt without running an engine:

  moves[uci] = [win% if the premove fires, win% if they answer it normally]

Win% is the solver's, by the Lichess conversion. A move after which the
premove is illegal (busted) is left out of the table. A move that ends the
game stores its result twice: the premove never gets to play.

The solve takes two moves: the one that lets the premove fire, then the one
that cashes in on it. For every first move that solves the puzzle, the
position after it and the premove has every reply scored too:

  second[first uci][reply uci] = win% after that reply
"""
import json, math, sys, multiprocessing as mp
import chess, chess.engine

DEPTH = 14
FOLLOW_DEPTH = 16
PER_GAME = 2
MAX_RISK = 30
BACKFIRE_MIN = 25
SLACK = 8          # win% points short of the best that still solve it (PZ_SLACK in the app)

SF = sys.argv[1]


def wp(score):
    if score.is_mate():
        return 100.0 if score.mate() > 0 else 0.0
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * score.score())) - 1)


def wp_for(eng, board, solver, depth=DEPTH):
    """Solver's win% in `board`, whoever is to move."""
    if board.is_checkmate():
        return 0.0 if board.turn == solver else 100.0
    if board.is_stalemate() or board.is_insufficient_material():
        return 50.0
    w = wp(eng.analyse(board, chess.engine.Limit(depth=depth))['score'].relative)
    return w if board.turn == solver else 100 - w


def kind(c):
    if c['stalemate']:
        return 'stalemate'
    if c['backfire'] is None:          # the answer gives check; nothing to compare a pass with
        return 'backfire'
    return 'backfire' if c['backfire'] >= BACKFIRE_MIN else 'ignored'


def score(c):
    return c['gain'] + (c['backfire'] or 0) - c['risk']


def select(rows):
    picked, per_game = [], {}
    for r in rows:
        if not r['cands']:
            continue
        best = max(r['cands'], key=score)
        if kind(best) == 'ignored' or best['risk'] > MAX_RISK:
            continue
        top = best['wp_A_R']
        accept = sorted({c['A_uci'] for c in r['cands']
                         if c['wp_A_R'] >= top - 8 and kind(c) == kind(best)} | {best['A_uci']})
        picked.append((score(best), r, best, accept))
    picked.sort(key=lambda x: -x[0])
    out = []
    for s, r, c, accept in picked:
        if per_game.get(r['id'], 0) >= PER_GAME:
            continue
        per_game[r['id']] = per_game.get(r['id'], 0) + 1
        out.append((r, c, accept))
    return out


_eng = None


def init():
    global _eng
    _eng = chess.engine.SimpleEngine.popen_uci(SF)
    _eng.configure({'Threads': 1, 'Hash': 32})


def build(item):
    r, c, accept = item
    b0 = chess.Board(r['fen'])
    solver = b0.turn
    R = chess.Move.from_uci(r['R_uci'])
    R = chess.Move(R.from_square, R.to_square, R.promotion)
    moves = {}
    for A in b0.legal_moves:
        b = b0.copy(); b.push(A)
        if b.is_game_over():
            w = round(wp_for(_eng, b, solver), 1)
            moves[A.uci()] = [w, w]
            continue
        if not b.is_legal(R):
            continue
        no_premove = wp_for(_eng, b, solver)
        b.push(R)
        moves[A.uci()] = [round(wp_for(_eng, b, solver), 1), round(no_premove, 1)]

    best = max(v[0] for v in moves.values())
    second = {}
    for u, v in moves.items():
        if u not in accept and v[0] < best - SLACK:
            continue
        b = b0.copy(); b.push(chess.Move.from_uci(u))
        if b.is_game_over():
            continue
        b.push(R)
        if b.is_game_over():            # the premove itself ended it (the stalemate trick)
            continue
        replies = {}
        for M in b.legal_moves:
            bm = b.copy(); bm.push(M)
            replies[M.uci()] = round(wp_for(_eng, bm, solver), 1)
        second[u] = replies

    A = chess.Move.from_uci(c['A_uci'])
    bA = b0.copy(); bA.push(A)
    bAR = bA.copy(); bAR.push(R)
    follow = []
    if not bAR.is_game_over():
        pv = (_eng.analyse(bAR, chess.engine.Limit(depth=FOLLOW_DEPTH)).get('pv') or [])[:3]
        tmp = bAR.copy()
        for m in pv:
            follow.append(tmp.san(m)); tmp.push(m)

    F = b0.parse_san(r['F'])
    bF = b0.copy(); bF.push(F)
    solver_rating = r['white'] if solver == chess.WHITE else r['black']
    premover_rating = r['black'] if solver == chess.WHITE else r['white']
    return {
        'id': r['id'], 'ply': r['ply'], 'fen': r['fen'],
        'solver': 'w' if solver == chess.WHITE else 'b',
        'solverRating': solver_rating, 'premoverRating': premover_rating,
        'played': r['F'], 'playedUci': F.uci(),
        'premove': R.uci(), 'premoveSan': bF.san(R), 'premoveSanVsAnswer': bA.san(R),
        'answer': A.uci(), 'answerSan': b0.san(A), 'accept': accept,
        'follow': follow, 'stalemate': bAR.is_stalemate(),
        'wpRoot': round(wp_for(_eng, b0, solver), 1),
        'moves': moves,
        'second': second,
    }


if __name__ == '__main__':
    out_path, hit_files = sys.argv[2], sys.argv[3].split(',')
    rows = [json.loads(l) for f in hit_files for l in open(f, encoding='utf-8')]
    items = select(rows)
    if len(sys.argv) > 4:                     # optional cap, for a quick test run
        items = items[:int(sys.argv[4])]
    print(f'{len(items)} puzzles selected', flush=True)
    puzzles = []
    with mp.Pool(6, initializer=init) as pool:
        for i, p in enumerate(pool.imap(build, items, chunksize=2)):
            puzzles.append(p)
            if (i + 1) % 50 == 0:
                print(f'{i + 1}/{len(items)}', flush=True)
    doc = {
        'v': 1,
        'source': 'Lichess open database (CC0), rated 1+0 games, October 2026',
        'scoring': f'Stockfish depth {DEPTH}, Lichess win% for the side solving',
        'puzzles': puzzles,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(f'wrote {out_path}: {len(puzzles)} puzzles')

"""Turn the games picked by measure-maia-960-opening.mjs into scored positions.

    python -E -P scripts/maia-opening-positions.py <dir>

Reads <dir>/960.pgn and <dir>/std.pgn, writes <dir>/positions.json: for each of
the first 20 full moves of every game, the position before the move (FEN), the
move played in UCI (a Chess960 castle written king takes rook, as the site and
Lichess write it), the mover's and the opponent's rating, and the mover's clock
before the move. Positions where the mover had under 30 s are marked dropped,
as Maia 3's training data dropped them. Needs python-chess.
"""
import json
import os
import sys

import chess
import chess.pgn

MOVES = 20


def positions(pgn_path, set_name):
    out = []
    with open(pgn_path, encoding="utf-8") as fh:
        gi = 0
        while True:
            game = chess.pgn.read_game(fh)
            if game is None:
                break
            h = game.headers
            base, inc = (int(x) for x in h["TimeControl"].split("+"))
            elo = {chess.WHITE: int(h["WhiteElo"]), chess.BLACK: int(h["BlackElo"])}
            board = game.board()  # chess960=True when [Variant "Chess960"]
            if set_name == "960":
                assert board.chess960, "960 game parsed as standard"
            clock = {chess.WHITE: float(base), chess.BLACK: float(base)}
            for ply, node in enumerate(game.mainline()):
                if ply >= 2 * MOVES:
                    break
                mover = board.turn
                out.append({
                    "set": set_name, "game": gi, "ply": ply, "move_no": ply // 2 + 1,
                    "color": "w" if mover == chess.WHITE else "b",
                    "fen": board.fen(), "uci": board.uci(node.move),
                    "elo_self": elo[mover], "elo_oppo": elo[not mover],
                    "clk_before": clock[mover], "dropped": clock[mover] < 30,
                })
                if node.clock() is not None:
                    clock[mover] = node.clock()
                board.push(node.move)
            gi += 1
    return out, gi


def main():
    d = sys.argv[1]
    allpos = []
    for name, f in (("960", "960.pgn"), ("std", "std.pgn")):
        pos, n = positions(os.path.join(d, f), name)
        print(f"{name}: {n} games, {len(pos)} positions, {sum(p['dropped'] for p in pos)} under 30 s")
        allpos += pos
    with open(os.path.join(d, "positions.json"), "w", encoding="utf-8") as fh:
        json.dump(allpos, fh)


if __name__ == "__main__":
    main()

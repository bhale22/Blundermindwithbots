# Premove puzzles: data pipeline

Builds `data/premove-puzzles.json`, the puzzle set behind the board's **Premove Puzzles** mode
(`src/68-premove-puzzles.js`). Each puzzle is a real Lichess bullet position where the opponent's
reply was a premove, and a different move would have kept that premove legal while turning it into
a blunder.

**How a premove is detected:** Lichess charges a premove no clock time, so a move whose clock
reading didn't change (`clocks[i-2] - clocks[i] + increment == 0`, in centiseconds) is a premove.
In 1+0 games that is about 12% of moves. Almost no moves land between 0.01 s and 0.07 s, so the two
don't blur.

Needs Python 3.14+ (for `compression.zstd`), `pip install chess`, and a Stockfish binary.

```sh
# 1. Game IDs from the head of a monthly database file (40 MB is ~30k 1+0 games)
python fetch_ids.py https://database.lichess.org/standard/lichess_db_standard_rated_2026-10.pgn.zst 40 ids.txt

# 2. Those games with centisecond clocks (20 games/s anonymous; appends)
python fetch_games.py ids.txt games.ndjson 2000

# 3. Every premove, every alternative to the move actually played (~2.4 s/game on 6 cores)
python mine.py games.ndjson hits.jsonl path/to/stockfish

# 4. Select the good ones and score every legal reply (~10 min for 500 puzzles)
python build_data.py path/to/stockfish ../../data/premove-puzzles.json hits.jsonl
```

`mine.py` scores each candidate three ways (the solver's win%, Lichess conversion):

- **gain**: what the move earns against the premove compared with the move actually played
- **backfire**: how much worse the premove is than the premover doing nothing (a null move). High
  means the premove itself is the blunder; low means it only ignored a threat.
- **risk**: what the move costs if they hadn't premoved

`build_data.py` keeps backfire (≥ 25) and stalemate tricks with risk ≤ 30, at most two per game.
For each one it stores `moves[uci] = [win% if the premove fires, win% if they answer normally]`
for every legal reply that leaves the premove legal. The app judges any attempt from that table
without running an engine, and treats a move missing from the table as having busted the premove.

The October 2026 run: 1,968 games, 15,704 premoves, 491 puzzles from 420 games.

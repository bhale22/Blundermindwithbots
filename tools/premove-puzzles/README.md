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

# 4. Select the good ones and score every legal reply, and every follow-up (~40 min for 500 puzzles)
python build_data.py path/to/stockfish puzzles.json hits.jsonl

# 5. Keep the fair ones and order them easy to hard, with the app's own Maia
#    (server on :3100; from the repo root)
node scripts/rank-premove-puzzles.mjs tools/premove-puzzles/puzzles.json data/premove-puzzles.json
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

A puzzle takes two moves to solve: the one that lets the premove fire into trouble, then the one
that cashes in. So for every first move that solves it (an accepted answer, or within 8 win% points
of the best), `second[first][reply]` scores every follow-up from the position after the premove.

`rank-premove-puzzles.mjs` keeps a puzzle only if the player could have seen it coming. Maia at
the solver's rating must play one move at least 80% of the time (the move the opponent was
premoving against), and Maia at the premover's rating must answer that move with the game's
premove at least 80% of the time. Then you know they are likely to premove, and what. It also drops
a puzzle where the best honest move does nearly as well as the trap (within 20 win% points), such
as one with a mate on the board. The thresholds are constants at the top of the script. It records
`expected`, `expectedP` and `premoveP`, adds `maia1500` (Maia 1500's probability of a solving first
move), and sorts by that: the most forced-looking first move is the easiest puzzle.

`mine.py` also records the premover's previous move (`last`, `lastUci`), which the board highlights.

The October 2026 run: 1,968 games, 15,704 premoves, 491 puzzles from 420 games before the Maia
filter, 4 after it. Only about 1 puzzle in 120 passes both 80% tests, so a useful set needs far
more games.

## Measuring the candidates

`scripts/premove-puzzle-stats.mjs` runs the same Maia as the rank script but drops nothing. For
every candidate it records the rank gate's numbers, `q` (the chance the premover would answer
*whatever* the solver plays with this premove, summed over every solver move), uniqueness gaps,
risk in centipawns as well as win%, the game clocks and premove streak, and how often the same
position and premove recur. `stats.json` is the October run. To reproduce it (server on :3100):

```sh
python fetch_games.py ids.txt games.ndjson 1000      # ids.txt: the puzzles' game IDs, one per line
node scripts/premove-puzzle-stats.mjs tools/premove-puzzles/puzzles.json tools/premove-puzzles/stats.json games.ndjson
node scripts/premove-puzzle-stats.mjs --summary tools/premove-puzzles/stats.json   # reprint, no Maia
```

About 3 s a puzzle. Of the 491, the rank gate rejects 422 on its first test (one solver move
≥ 80%); only 69 candidates have such a move at all. `q ≥ 0.64` (the same joint level as 80% × 80%)
keeps 24 with the trap beating the best honest move by 20 win% points, against the gate's 4.

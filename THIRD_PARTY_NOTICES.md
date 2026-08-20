# Third-party notices

Blundermind's own code is licensed under GPL-3.0-or-later (see [LICENSE](LICENSE)).
This file records every third-party component the site and the Android app
distribute or depend on, with provenance. The human-readable version is served
at `/credits`.

## Shipped to the browser / bundled in the app

| Component | Files | Version / detail | Licence | Upstream |
|---|---|---|---|---|
| Stockfish.js | `vendor/stockfish-18-lite-single.{js,wasm}` | Stockfish.js 18, single-threaded lite WASM build | GPL-3.0 | https://github.com/nmrugg/stockfish.js (port of https://github.com/official-stockfish/Stockfish) |
| Stockfish NNUE network | embedded in the WASM build | `nn-9067e33176e` by Linmiao Xu (linrock) | GPL-3.0 (part of Stockfish) | https://tests.stockfishchess.org/nns?network_name=nn-9067e33176e |
| Maia 3 network | `models/maia3_simplified.onnx`, `data/all_moves_maia3*.json` | CSSLab Maia 3 checkpoint, exported to ONNX (PyTorch 2.11) and run through onnx-simplifier | AGPL-3.0 | https://github.com/CSSLab/maia3 · https://www.maiachess.com/ |
| ONNX Runtime Web | `ort/` | 1.23.0 | MIT | https://github.com/microsoft/onnxruntime |
| Opening names | `data/eco.tsv` | tsv of ECO code / name / PGN | CC0-1.0 | https://github.com/lichess-org/chess-openings |
| Staunton piece set | inlined SVG in `src/10-app-shell.js` | from the `react-chess-pieces` package, by nikfrank | ISC | https://github.com/nikfrank/react-chess-pieces/tree/master/src · https://www.npmjs.com/package/react-chess-pieces |
| Alternative piece set | inlined SVG | by RhosGFX | CC0-1.0 | https://rhosgfx.itch.io/ |
| Fonts | `fonts/` | Chakra Petch, Cormorant Garamond, DM Mono, Fraunces, Spectral | SIL OFL 1.1 (`fonts/OFL.txt`) | https://fonts.google.com/ |

## Server-side dependencies (not distributed to users)

| Component | Licence | Upstream |
|---|---|---|
| Express | MIT | https://www.npmjs.com/package/express |
| ws | MIT | https://www.npmjs.com/package/ws |
| Playwright (dev/test only) | Apache-2.0 | https://playwright.dev/ |

## Data services

- **Lichess opening explorer** — opening statistics are fetched live through a
  server-side proxy (`server.js`), authenticated with a personal access token and
  identified with a descriptive User-Agent, per Lichess API guidance. Lichess is
  credited by text link only; no Lichess logo or wordmark is used.

## Licence-compatibility note

The combined work distributes GPL-3.0 (Stockfish) and AGPL-3.0 (Maia 3) components
alongside Blundermind's own GPL-3.0-or-later code. GPLv3 §13 and AGPLv3 §13
expressly permit this combination; each part remains under its own licence, and
the corresponding source for all of it is this repository plus the linked
upstreams.

## Research credited (no code distributed)

- Monroe, Eilender, Chalmers, Tang & Anderson — *Chessformer: A Unified
  Architecture for Chess Modeling*, ICLR 2026 (Maia 3).
- McIlroy-Young, Sen, Kleinberg & Anderson — *Aligning Superhuman AI with Human
  Behavior: Chess as a Model System*, KDD 2020 (original Maia).
- Regan & Haworth — *Intrinsic Chess Ratings*, AAAI 2011; the time-pressure
  degradation curve is seeded on a fit of Prof. Kenneth Regan's published
  rating-loss-vs-time-control data.
- The phrase "getting a grip on the board" is Chess Dojo's
  (https://www.chessdojo.club/), quoted with attribution in the app.

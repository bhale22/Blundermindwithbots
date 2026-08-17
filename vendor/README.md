# vendor/

Third-party binaries served directly by `server.js`. Do not edit; replace whole
files when upgrading and update `THIRD_PARTY_NOTICES.md` + `/credits`.

- `stockfish-18-lite-single.js` / `.wasm` — **Stockfish.js 18**, single-threaded
  lite WASM build, from https://github.com/nmrugg/stockfish.js (GPL-3.0).
  Based on official Stockfish (https://github.com/official-stockfish/Stockfish);
  NNUE network `nn-9067e33176e` by Linmiao Xu. Vendored 2026-06 after jsDelivr
  began refusing the stockfish npm package (served error text as engine script).

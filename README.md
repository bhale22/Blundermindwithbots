# Blundermind

**Board vision training for novice chess players — and a workshop for building bots that blunder like people do.**

Live at **[blundermindchess.com](https://blundermindchess.com)**. Also on Google Play as a Trusted Web Activity.

Most chess engines are either perfect or randomly bad. Blundermind is built around
a third option: bots whose mistakes have a *shape*. A configurable personality
decides how far a bot will stray from the best move, how it behaves under time
pressure, and which kinds of positions tempt it — so losing to one teaches you
something.

Alongside the bots, the board itself is instrumented: threats, pins, forks,
unprotected pieces and check threats can all be surfaced as overlays, which is
the "board vision" half of the name.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Node 18+. There is **no build step** — `server.js` assembles the page from
[`src/`](src/) in memory on every request, so you edit a part and refresh.

### Environment variables

All optional; the app runs without any of them, with the noted degradation.

| Variable | Purpose | Without it |
|---|---|---|
| `PORT` | HTTP port | defaults to `3000` |
| `LICHESS_TOKEN` | Personal access token for the Lichess opening explorer proxy | Opening statistics fail — Lichess now rejects unauthenticated explorer calls |
| `EXPLORER_HOST` | Override the explorer upstream | defaults to `https://explorer.lichess.org` |
| `TWA_PACKAGE_NAME` | Android package name for `/.well-known/assetlinks.json` | assetlinks 404s; the Android app shows a URL bar |
| `TWA_CERT_FINGERPRINTS` | SHA-256 signing fingerprints, comma-separated | as above |

No secrets are committed. See [`ANDROID.md`](ANDROID.md) for why the TWA needs
*two* fingerprints.

### Tests

```bash
npm test           # unit tests (node:test)
npm run test:browser   # Playwright end-to-end specs
npm run test:all
```

## Layout

| Path | What it is |
|---|---|
| [`src/`](src/) | The game page in eight ordered parts — one continuous JS scope. See [`src/README.md`](src/README.md) |
| [`server.js`](server.js) | Express + `ws`: page assembly, Lichess explorer proxy, multiplayer rooms |
| [`maia-worker.js`](maia-worker.js) | Web Worker running the Maia 3 network via ONNX Runtime |
| [`vendor/`](vendor/) | Stockfish 18 WASM, served directly |
| [`models/`](models/) | The ~44 MB Maia 3 ONNX network, fetched on demand and cached client-side |
| [`android/`](android/) | Bubblewrap TWA wrapper. Not deployed — see [`ANDROID.md`](ANDROID.md) |
| [`test/`](test/) | Unit tests and Playwright browser specs |

## Licence

Blundermind's own code is **GPL-3.0-or-later** — see [`LICENSE`](LICENSE).

This is not a free choice. Blundermind ships **Stockfish** (GPL-3.0) to the
browser and serves the **Maia 3** network (AGPL-3.0), so the combined work is
copyleft and this repository is the corresponding source that both licences
require. Every third-party component, its licence, and its upstream are recorded
in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and served in readable
form at [`/credits`](https://blundermindchess.com/credits).

You are free to fork, modify and run your own instance, commercially or
otherwise, provided you pass on the same freedoms and publish your source.

**Trademark.** The licence covers the code, not the identity. The *Blundermind*
name, the logo and icons in [`icons/`](icons/), and the Google Play listing are
not licensed for use in derivative works. Please run your fork under its own
name so users can tell the two apart.

## Security

Found a vulnerability? Please **don't** open a public issue —
see [`SECURITY.md`](SECURITY.md).

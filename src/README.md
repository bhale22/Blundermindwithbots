# src/ — the Blundermind page, in parts

The game page is the **simple concatenation** of the files in this folder, in
the order listed in [`build.js`](../build.js). `server.js` assembles them in
memory on every request (cached by mtime), so during development you just
edit a part and refresh the browser — **no build step**.

| File | Contents |
|---|---|
| `00-head.html` | `<!DOCTYPE>`, all CSS, the board/panel markup, opening `<script>` tag |
| `10-app-shell.js` | shared state, slide panels, help text, chat, clock, multiplayer |
| `20-chess-core.js` | FEN, attack maps, pins, legality, SAN — pure chess facts, no DOM |
| `30-board-ui.js` | sounds, move execution, premoves, preview, `render()`, overlays |
| `40-engines.js` | Stockfish workers, Maia3, Lichess explorer, ECO library, opening book |
| `50-bot-engine.js` | pressure curves, attractors, think time, `botMakeMove()`, ghost pieces |
| `60-bot-ui.js` | bot panel UI, opening preferences, save/load, config bridge |
| `90-tail.html` | closing `</script>`, bot modal markup, `</body></html>` |

Rules:

- **Everything between `00` and `90` is one continuous JavaScript scope** —
  exactly like the old single-file `blundermind.html`. Order matters; don't
  reorder the parts or introduce per-file `<script>` tags.
- `blundermind.html` in the repo root is a **build artifact** (git-ignored).
  Regenerate it with `node build.js` if you need a standalone single file.
- `bot-control-panel.html` is separate and self-contained (loaded in an
  iframe); it is not part of this assembly.

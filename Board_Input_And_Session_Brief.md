# Blundermind — Board Input & Session Persistence
*Design brief and implementation reference*

---

## Part 1 — Move commit modes

### Motivation

Blundermind's whole premise is that the board tells you things: attacker counts, hanging rings, pins, forks. The preview system leans on that — pick a piece up, move it over a square, and every overlay recomputes for the position *as if you had played it*. On a desktop that works beautifully.

On a phone it collapsed, for a reason that has nothing to do with the code: **your finger is on top of the square you are trying to read.** You cannot evaluate the overlays without lifting it, and lifting it played the move. The one gesture that let you see the answer was also the gesture that committed you to it.

### The two modes

A visible chip, switchable mid-game, selects between them. The choice persists in `localStorage` under `bmCommitMode`.

| Mode | Behaviour |
|---|---|
| **Release to move** (`'release'`, default) | Letting go of a piece on a legal square plays the move. The behaviour the board has always had; unchanged. |
| **Tap to confirm** (`'confirm'`) | Letting go **parks** the piece on the destination with the preview overlays live. A second tap on that square plays it. |

Both the drag route and the pure tap route reach the same place:

- **Drag:** pick up → drag → release *parks* → tap the parked square to commit.
- **Tap only:** tap the piece → tap the destination *parks* → tap again to commit.

While a move is parked: tapping a **different legal square** re-parks there (change your mind without starting over); tapping the origin or empty space cancels; `Escape` cancels.

### Visual language

A parked piece has to read as *not played yet*, and the first attempt got this wrong by using green — which sits right next to the yellow-green last-move highlight and therefore read as "this move happened."

The parked state now uses:

- the **selection yellow** (`#f6f669` / `#baca2b`), the same family as the origin square, saying "still choosing"
- a **dashed outline** on the destination square
- the piece drawn at **45% opacity**

Deliberately **no animation.** A pulse would be harder to miss, but the board already carries a lot of live overlay detail and all of it is information — an animating piece would be the only moving thing on screen and would pull the eye away from the very overlays the mode exists to let you read.

### Implementation notes

*Code: `src/30-board-ui.js`.*

`awaitingConfirm` is the parked flag. Every change goes through `setAwaitingConfirm()` rather than direct assignment, because the hint text lives in `updatePlayerBoxes()` — which `render()` does not call, so a direct assignment leaves the hint stale.

Two non-obvious cases the implementation has to handle, both of which regressed once:

1. **Desktop hover clears `selSq`.** A mouse moving over a legal square starts a preview, and `startPreview()` sets `selSq = -1`. So the tap-to-park check cannot key on `selSq` alone; it falls back to `premoveFrom` from the live preview.
2. **A parked piece can sit for a long time.** In multiplayer the position can change underneath it, so the confirming tap re-derives legality from the live board rather than trusting the `legalMoves` list captured when the piece was picked up.

### Chip placement

The chip is **not** in a player box. Two things move those: `updatePlayerBoxes()` re-parents the turn pill between `rightColW` and `rightColB` every turn, and `.board-flipped` swaps the two boxes top-to-bottom when the human plays Black. A chip in either box jumps on every turn and moves between clocks depending on colour.

- **Amateur shell:** `#boardInputRow`, a plain order-0 child directly under the board — stable in both orientations.
- **Pro shell:** relocated into the player's own clock panel (`#proChipMount`, inside `#proPlayerBottom`) by `proMountChip()`, using the same relocate-on-shell-switch pattern as the chat box. `#boardInputRow` is hidden in pro mode.

### When a premove is accepted

`isWaitingTurn()` decides whether a piece can be picked up and composed against the speculative board, and `tryCommit()` uses the same rule to decide whether a drop queues a premove or plays a move. Against a bot that rule is `botOnMove()` — **whose turn it is**, not whether the engine is mid-inference.

The distinction is the whole feature. `botThinking` is only true while `botMakeMove()` is actually computing, and the bot's turn is wider than that at both ends:

- `botPostMoveHook()` schedules `botMakeMove` on a **100 ms timer**, so the flag is false for the first tenth of a second of every bot turn — precisely when a speed player, having just released their own move, reaches for the next one.
- The opening-book and bot-premove paths clear the flag *before* calling `executeMove`.
- `botStart()` waits 800 ms before the bot's opening move.

With think time set to **instant** the inference is often shorter than the 100 ms gap sitting in front of it, so gating on `botThinking` refused the premove for most of the bot's turn and accepted it only in a window of a few tens of milliseconds. It read as premove being broken rather than as a timing bug, because the successful case was rare enough to look like luck.

One consequence to keep in mind: a piece picked up during the bot's turn carries the **optimistic** `premoveDests()` set, and the bot can reply while it is still held. `tryCommit()` therefore re-derives legality from the live board on the real-move path rather than trusting the captured `legalMoves` — `executeMove()` validates nothing, so a stale set would otherwise play an illegal move. This is the same reasoning as the parked-piece case in the notes above.

### The opponent must not empty your hand

*Code: the input-state block in `executeMove()`, `src/30-board-ui.js`.*

Composing a premove means **holding a piece during the opponent's turn**, so the opponent's reply routinely lands while that piece is still in the air. `executeMove()` ended with a single unconditional line clearing `selSq`, `legalMoves`, `dragFrom`, `dragMoved` and the preview — for *every* move, the opponent's included.

The drop then arrived with `dragFrom = -1` and `legalMoves = []`, every branch of the `mouseup` handler missed, and the piece snapped back to its origin — discarding a move that was **legal in the position that had just arrived**.

Two things made this read as an engine problem rather than an input one:

- **Think time sets how often it fires.** At a 1-second think time the reply lands inside the compose window nearly every time. Stockfish replies before the player's second interaction has even started, so the interaction happens on their own turn and never touches this path at all — hence "works with Stockfish, broken with Maia 3", which points at the wrong layer entirely.
- **It also looks like a failure to *select*.** Tap a piece during the bot's turn, the bot replies a moment later, the selection is wiped — indistinguishable from the tap never having registered.

`executeMove()` now keeps the held piece when the move being applied is not the player's own, and **re-derives `legalMoves` against the position that just arrived** — the set it was picked up with was `premoveDests()`, speculative by design, and the position it was guessing at now exists. The piece is released only when it is genuinely gone: captured, or the square taken. Solo play is unaffected, because `playerColor()` returns `turn` there and every move is the player's own.

### Premoves that are not legal yet

The point of a premove is committing to a move the position does not allow *yet* — 1.e4 and then `exd5` parked while d5 is still empty. `premoveDests()` exists for exactly this, and two places used to throw those moves away:

1. **`startPreview()` rewrote the destination.** When the move was not currently legal it set `to = from`, so the overlays would not describe a board that does not exist. But `premoveFrom`/`premoveTo` are not only the preview anchor — **confirm mode parks a piece on them and matches the confirming tap against `premoveTo`**. Collapsing it to the origin made every not-yet-legal premove unconfirmable: the tap never matched, so the piece silently re-parked, forever. The squares are now kept truthful and a separate `previewCollapsed` flag carries the "the piece is not really there" fact to the one overlay that reasons about the destination.
2. **The confirming tap re-derived strict legality** with `legalMovesFor()` before committing, and discarded anything that failed. It now hands the decision to `tryCommit()`, which validates a real move against the live board and a premove against the speculative one — the right test in both cases.

---

## Part 2 — Session persistence

### Motivation

Android discards a backgrounded WebView under memory pressure, and this app is an unusually fat target: a 44MB Maia net plus Stockfish WASM resident. When the user came back, the page had **reloaded** — and because nothing about a live game was ever persisted, they landed on the home screen with the game gone.

`beforeunload` does not fire on an OS kill, so the snapshot is written **eagerly** — after every move and on `visibilitychange` — rather than on the way out.

### Single-player snapshot

*Code: `src/60-bot-ui.js`, key `bm_liveGame`, max age 24h.*

Written from `updatePlayerBoxes()` via `maybeSessionSave()`, the one function that already runs after every move. Captures position (FEN), move list, clocks, board orientation, and for bot games the full bot config through `botCollectConfig()`.

On load, `bmSessionRestore()` rebuilds the game, dismisses the landing overlay, and resumes the bot's turn if it was thinking when the page died. A "Game resumed / Start fresh" toast makes it recoverable.

Cleared on game over, on `resetGame()`, and by "Start fresh".

**The snapshot must carry the personality, not just the rating.** `botCollectConfig()` originally captured rating, engine tab and colour but none of the Build-A-Bot state — attractors, CP budget, hard floor, custom controls, probability floor, move-quality band. A restored game therefore came back as a generic engine of the same strength, which is the opposite of the point on a site whose premise is the bot you built. The `personality` block now carries all of it.

> Because `botCollectConfig` / `botApplyConfig` are shared with the **Save/Load Config** buttons, that gap meant saving a personality to a file never worked either. One stale element id in the same function (`#maiaElo`, replaced by the `maia3RatingBtns` row) had also been throwing, which took out Save Config entirely. Both are fixed; every DOM read there is now guarded.

### Multiplayer resume

*Code: `server.js` and `src/10-app-shell.js`, key `bm_mpSession`.*

Multiplayer is deliberately **excluded** from the local snapshot: the server owns the game, and a client restoring its own idea of the position would be reasoning about something the server disagrees with. It gets a separate, authoritative path.

Three things were wrong, and all three had to be fixed together:

1. **The server kept no game state.** Rooms held two sockets, a time control and an optional start FEN; moves were relayed and forgotten. Rooms now carry the authoritative move list and clocks.
2. **Seats were freed on disconnect,** so a stranger could take a reconnecting player's chair, and the room was deleted outright once both sides dropped. Each player now holds a **seat token**; seats are *reserved* rather than freed once a game has started, and a started, unfinished game survives `MP_RESUME_GRACE_MS` (15 minutes) with nobody connected.
3. **`opponent_disconnected` set `gameOver = true` immediately.** This is the one that destroyed long games: an opponent's phone locking for five seconds ended the match. A disconnect is no longer a result — the waiting player sees a countdown while the opponent has the same grace window, and the game only resolves as a win if they genuinely never return.

The protocol additions (`resume`, `resumed`, `resume_failed`, `opponent_reconnected`, and the `token` field on `created`/`joined`) are all **additive**, so a client sitting on an already-loaded page keeps working across a deploy.

A `resume` presents `{code, token}`. The server matches the token to a seat, evicts any zombie socket still holding it, re-binds, and replays the full game state. A bad token is refused with `resume_failed: 'denied'`; a collected room with `'gone'`.

### Restore ordering

Multiplayer takes precedence. `mpTryResume()` runs on `load` from `10-app-shell.js` (registered first, so it runs first) and sets `_mpResumePending`; the single-player restore in `60-bot-ui.js` stands down if that flag is set or `mpRoomId` is already populated.

### The clock measures real time, not window time

*Code: `src/10-app-shell.js` (`_clockStep`, `clockTick`, `clockResume`), the `visibilitychange` handler in `src/30-board-ui.js`, and the deduction in `bmSessionRestore()`.*

A clock that stops when you look away is not a clock. Three separate paths had to agree on that, and two of them were refunding time:

- **Ticking.** `_clockAnchorMs`/`_clockAnchorSec` are the source of truth — remaining time is always `anchorSec − (now − anchorMs)`, never a decrement of the last displayed value. A late or throttled timer therefore self-corrects instead of losing the difference.
- **Hide/show.** The handler used to call `clockStop()` on hide and `clockStart()` on show, and **`clockStart()` re-anchors** — which silently refunded the whole hidden stretch. Alt-tabbing out of a 1+0 bullet game paused your clock. It now parks only the repaint interval and leaves the anchor alone; `clockResume()` picks the interval back up *without* re-anchoring and charges the gap on its first step. Re-anchoring means "a new turn starts now", so only `clockTick()` may do it.
- **Reload / app closed.** The snapshot already carried `ts`. `bmSessionRestore()` now subtracts the elapsed wall time from whoever is on move. A game left long enough comes back **already lost on time** rather than paused, which is why the restore declares the timeout instead of leaving a playable board at 0:00.

> **Multiplayer inherits the hide/show fix and needs it most.** Each client sends its own post-move clock values and the receiver overwrites its local state with them (`src/10-app-shell.js`, `server.js:902`), so a refunded clock was not just a local display error — it was sent to the opponent as authoritative, and backgrounding the tab was a way to stop your own clock.
>
> **Still open: the multiplayer *rejoin* path.** `room.timeW`/`room.timeB` are written only when a move message arrives and the server never ticks, so `roomStatePayload()` hands a returning client its clock as of the last move — refunding whatever it had spent thinking before it dropped. Closing that needs the server to record when the current turn began and the client to charge it on resume; the single-player snapshot does not cover multiplayer, so nothing else compensates.

---

## Testing

These behaviours are invisible to the `vm`-based engine tests — they live in input handling, rendering and page lifecycle. They are covered by browser-level suites in `test/browser/`, run with `npm run test:browser` (not part of `npm test`, which stays fast and Playwright-free).

| Suite | Covers |
|---|---|
| `commit-mode.spec.js` | Park/commit/re-park/cancel with a mouse, plus a regression guard that release mode still plays on drop |
| `commit-mode-touch.spec.js` | The same on an emulated phone with real CDP touch events — the case the feature exists for |
| `premove-bot-turn.spec.js` | A premove queues for the whole of the bot's turn, including the 100 ms scheduling gap an instant think time hides in; not-yet-legal premoves (the pawn recapture) work in both commit modes; the bot replying mid-drag leaves the piece in hand with a re-derived destination set, but a captured piece is released; a stale destination set cannot play an illegal move |
| `clock-realtime.spec.js` | Hiding the tab does not refund the hidden stretch, a reload charges the time the app was closed, and a clock that expired while away loses on time |
| `chip-position.spec.js` | The chip does not move on turn change, board flip, or both |
| `pro-layout.spec.js` | Pro-shell clocks hold position across moves, material, long bot names and the result bar |
| `session-restore.spec.js` | Snapshot, background, reload, resume; "Start fresh"; finished games not resumable |
| `session-restore-bot.spec.js` | Timed bot game: identity, personality, clocks, and the bot resuming its turn |
| `mp-reconnect.spec.js` | Two real clients: a drop does not end the game, the dropped player rejoins the same seat with full history, strangers and bad tokens are refused |

> **Device descriptors.** Playwright's device list changes between releases and an unknown name yields `undefined`, which spread into `newContext()` silently produces a **desktop** context with no touch support — a touch suite would pass while testing nothing of the sort. `_harness.js` centralises the choice and throws at load if the descriptor is missing.

---

*Last updated: August 2026 (premove window keyed on the bot's turn; clock charges real elapsed time). Code reference: `src/30-board-ui.js` (commit modes, parked rendering, `isWaitingTurn`, `botOnMove`, `tryCommit`, `startPreview`, the `visibilitychange` clock handler), `src/10-app-shell.js` (clock anchor/`clockResume`, mp session, resume, opponent-away grace, pro mounts), `src/60-bot-ui.js` (single-player snapshot and its elapsed-time deduction, config bridge), `server.js` (room state, seat tokens, resume protocol).*

*Note on the build: `blundermind.html` is a generated artifact assembled from `src/` by `build.js`, and `server.js` performs the same assembly in memory per request. Always edit `src/` — a hand-edited `blundermind.html` is overwritten on the next build and is not tracked by git.*

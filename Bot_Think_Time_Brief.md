# Blundermind — Bot Think Time System
*Design brief and implementation reference*

---

## Motivation

The single most important cue that a chess opponent feels human is **time**. Move quality matters, but players are surprisingly good at detecting the *pattern of delays* as unnatural — a bot that always plays in 2.3 seconds feels mechanical even if the moves are excellent. The goal of the think-time system is not to slow the bot down arbitrarily, but to reproduce the **structure of a real player's time use** across a game:

- Fast in the opening when the position is familiar territory
- Slower as the position becomes novel or complex
- Near-instant for obvious forced moves (the "blink" a human has on simple recaptures)
- Occasionally hesitates longer, as if reconsidering
- Speeds up sharply when the clock is low — and when trying to flag the opponent
- Mirrors or responds to the human's own pace in some modes
- Has a personality dimension: hustlers play fast throughout; grinders think long even in simple positions

All of this is built as a pipeline inside `botThinkTime()` in `src/50-bot-engine.js`. The function returns a millisecond delay the calling code waits before executing the bot's chosen move.

---

## Architecture: the pipeline

`botThinkTime(moveProbs, clockMs)` takes the Maia3 move-probability distribution for the current position (used to measure position entropy) and the bot's current clock in milliseconds. It returns a target delay in ms.

The pipeline runs as a series of stages. Early stages can short-circuit (return immediately); later stages apply successive multipliers to a base `thinkMs` value.

### Stage 0 — Early exits (short-circuit)

**Instant mode** (`botTimeBehavior === 'instant'`): returns 0. Used for testing, the Weaponizer's flagging path, and any personality that wants purely reactive play.

**Weaponizer** (`botWeaponizerEnabled`): if the bot is ahead on the clock by more than `botWeaponizerLeadMs` (default 30 s), returns 0. The bot plays instantly to maximize time pressure and increase flagging risk. This is a personality-level feature (the Time Weaponizer preset) with its own toggle and lead-threshold slider.

**Move blink** (`botBehavBlink`, Maia3 paths only): if position entropy is below 0.5 (a near-forced position — only one or two moves have significant probability), plays in 200–500 ms. This models the human reflex of instantly recapturing or making an obvious reply. Disabled when Maia3 move probabilities are unavailable (SF path).

**Fixed mode** (`botTimeBehavior === 'fixed'`): returns a user-set constant (`botFixedDelayMs`, default 5 s), subject to clock-pressure caps.

**Mirror mode** (`botTimeBehavior === 'mirror'`): uses a rolling window (`BOT_MIRROR_WINDOW` moves) of the human's actual move durations (`botUserMoveTimestamps`), takes the average, applies a ±20% jitter and a configurable offset percentage (`botMirrorOffsetPct`). If no human moves have been recorded yet, falls through to complexity/pace.

### Stage 1 — Base think time

If none of the early exits fired, one of two base-time strategies computes `thinkMs`:

**Complexity mode** (`botTimeBehavior === 'complexity'`): uses a configurable three-parameter model — base time (`botCplxBase`, seconds), minimum multiplier (`botCplxMin`), maximum multiplier (`botCplxMax`). Complexity is measured preferentially by Stockfish's MultiPV probe score (`sfCplxScore`, 0–1), falling back to normalized Shannon entropy from Maia3 probabilities when the SF probe is unavailable.

```
thinkMs = botCplxBase × lerp(botCplxMin, botCplxMax, complexity) × 1000
```

**Pace mode** (default, `botTimeBehavior === 'pace'`): the original entropy-based model. A `botPace` slider (moves per 5-minute game equivalent) sets a base seconds-per-move, which is then multiplied by a complexity factor derived from entropy (1.0 to 2.5×).

```
baseSec  = 300 / pace
thinkMs  = baseSec × min(1 + entropy × 0.35, 2.5) × 1000
```

### Stage 2 — Successive multipliers

Applied in order after `thinkMs` is set. Each multiplier is independent.

**Clock-pressure mirroring** (`botBehavClockMirror`): if the human's clock is below 60% of the bot's, halves think time. Models the human tendency to play faster when their opponent is low on time — defensive aggression.

**Hustle attractor** (`_bcpAttractorValues.hustle`, −5 to +5): scales think time by `(1 − hustle × 0.15)`. +5 (hustler) → 25% faster; −5 (grinder) → 25% slower. Part of the personality attractor system.

**Opening familiarity decay** *(added June 2026)*: computes a familiarity score (0–1) from a sigmoid function of current ply depth, adjusted by explorer confidence (see below). Familiarity of 1.0 means the bot knows this position by heart; 0.0 means fully on its own. Applied as:

```
thinkMs × (0.15 + 0.85 × (1 − familiarity))
```

At peak familiarity the bot plays at ~15% of its normal pace (brief but not robotic). At zero familiarity the multiplier is 1.0 (unchanged). See *Opening Familiarity* section below for full detail.

**Novelty pause** *(added June 2026)*: when the human plays a low-frequency move (< 5% in explorer games), multiplies think time by up to 2.5× on the bot's next reply only. Partially overrides the familiarity speed savings so the bot visibly hesitates even in otherwise-familiar territory. The surprise factor is computed in `botPostMoveHook()` from the explorer cache and consumed (zeroed) in the following `botThinkTime()` call. Only fires when the Lichess explorer was active and had data for the pre-move position (mainline mode).

**Reconsideration pause** (`botBehavReconsider`): with 15% probability, multiplies by 1.5–2.5×. Models the human habit of second-guessing — a visible hesitation that communicates uncertainty or caution. Intentionally random.

**Base jitter** (always on): multiplies by a uniform random value in [0.8, 1.2]. Prevents mechanical regularity in any mode.

### Stage 3 — Clock-pressure caps (always applied last)

- If clock < 30 s: caps think time at 8% of remaining clock (`clockMs × 0.08`)
- If `botCanFlag` is false: caps at `max(200, clockMs − 3000)` to guarantee the bot never flags itself
- Hard floor: 200 ms (no move is played in less than 200 ms regardless of mode)
- Hard ceiling: `botThinkCapMs()` — 2% of starting clock, clamped between 6 s and 45 s. Prevents a 90-minute classical game from having a 6-second-max bot.

---

## Opening familiarity decay

### Motivation

Real players spend less time in opening territory they know well. This manifests as:
- Very fast play in the first several moves (especially for experienced players on familiar lines)
- A gradual slowdown as the position becomes novel or recall gets harder
- Different players having different book depths — a 600-rated player may know 4 moves, a 2400 player may know 20+ moves of a main line
- Uneven knowledge within a rating band — a 1000-rated player might know one line very deeply and be lost in everything else

The previous system had a binary switch: in-book moves played in a fixed 400–1200 ms window; out-of-book moves immediately used full think time with no transition. This created a noticeable "cliff" where the bot suddenly switched from rapid-fire to slow deliberation at the moment it left the opening book.

### Implementation

`openingFamiliarity(plies)` returns a value in [0, 1]:

```
familiarity = 1 / (1 + exp(k × (plies − threshold)))
```

Both parameters scale linearly with `botEffectiveElo()`:

| Parameter | 600 ELO | 2600 ELO | Interpretation |
|---|---|---|---|
| threshold | 8 plies (~4 moves) | 44 plies (~22 moves) | How deep book knowledge extends |
| slope k | 0.85 (sharp) | 0.22 (gentle) | How abrupt the loss of familiarity is |

**Per-game threshold jitter** (`_bookFamiliarityJitter`): sampled once at game start. Lower-rated bots have wider variance (±3 plies at 600 ELO, ±1 ply at 2600 ELO), reflecting that weaker players have uneven book knowledge — they may know one specific line very well and be immediately lost in others.

**Effective ELO source** (`botEffectiveElo()`): for Maia3/LC tabs uses `maia3SelectedRating` directly. For the Stockfish tab, maps the 1–20 skill slider to approximately 650–2600 ELO.

**Explorer-confidence extension** *(added June 2026)*: when the Lichess explorer returns data, `_explorerConfidence` (0–1) is computed from `log10(totalGames) / 6`. This shifts the familiarity threshold via `confExtension = confidence × 8 − 2`: at conf=1.0 (≥1M games of deeply-charted theory) the threshold extends by +6 plies; at conf=0 (off-book) it compresses by −2 plies, accelerating the decay toward normal think time. While `_explorerConfidence` is null (no data yet this game), no extension is applied. The confidence is updated whenever `openingExplorerFetch()` returns a result (mainline path) and reset to 0 whenever `lichessExplorerActive` goes false.

### Resulting feel

| ELO | Plays fast through... | Starting to think by... | Full pace by... |
|---|---|---|---|
| 600 | moves 1–3 | move 4–5 | move 6 |
| 1000 | moves 1–6 | move 8–9 | move 11 |
| 1400 | moves 1–9 | move 11–13 | move 15 |
| 1800 | moves 1–12 | move 15–17 | move 20 |
| 2200 | moves 1–16 | move 19–21 | move 25 |
| 2600 | still at 57% familiarity at move 22; gentle slope continues well into the middlegame |

---

## Book-move timing (separate from botThinkTime)

Book moves (in-book on the mainline or preferred opening paths) bypass `botThinkTime()` entirely and use a dedicated delay of **400–1200 ms** before executing. This is intentionally faster than out-of-book play but not instant — playing a book move in 0 ms would feel suspicious.

The opening familiarity decay in `botThinkTime()` is additive to this: it affects non-book out-of-engine moves in the early game (e.g. if the bot leaves book on move 6 but the position is still familiar, it plays faster than it would in a genuinely novel middlegame position).

---

## State variables (src/10-app-shell.js)

| Variable | Default | Purpose |
|---|---|---|
| `botTimeBehavior` | `'pace'` | Active mode: `'pace'`, `'instant'`, `'mirror'`, `'fixed'`, `'complexity'` |
| `botFixedDelayMs` | 5000 | Fixed mode: constant delay in ms |
| `botMirrorOffsetPct` | 0 | Mirror mode: speed offset (−100 to +100%) |
| `botCplxBase` | 3 | Complexity mode: base time in seconds |
| `botCplxMin` | 0.4 | Complexity mode: minimum multiplier |
| `botCplxMax` | 2.5 | Complexity mode: maximum multiplier |
| `botBehavBlink` | true | Enable near-instant forced-move detection |
| `botBehavReconsider` | true | Enable random reconsideration pauses |
| `botBehavClockMirror` | true | Speed up when opponent clock is low |
| `botCanFlag` | true | Whether bot is allowed to run clock to zero |
| `botWeaponizerEnabled` | false | Enable instant play when ahead on clock |
| `botWeaponizerLeadMs` | 30000 | Clock lead required to activate weaponizer |
| `botUserMoveTimestamps` | `[]` | Rolling window of human move durations |
| `botStartClockMs` | null | Captured at game start; used for `botThinkCapMs()` |
| `sfCplxScore` | null | SF MultiPV complexity score 0–1; null when unavailable |
| `_bookFamiliarityJitter` | 0 | Per-game threshold offset for familiarity curve |
| `_explorerConfidence` | null | 0-1 from log10(games); null until first explorer response; 0 when off-book |
| `_explorerSurpriseBoost` | 0 | 0-1; set in botPostMoveHook on low-freq human move; consumed in next botThinkTime() |

---

## Future directions

These are gaps or extensions worth considering, roughly in priority order.

**1. Premove simulation** *(was #3)*
Real bullet/blitz players premove in sequences when forcing a trade or responding to a check. The bot currently has no premove concept — it always waits the full think time. A premove mode would: detect that only one legal move exists (or that the best move is clearly forced by a check), and play it in 50–150 ms regardless of the think-time mode. The blink mode is a partial approximation, but genuine one-legal-move detection would be cleaner and more reliable.

**2. Time-mode interaction with opening familiarity**
The familiarity multiplier currently applies to the `complexity` and `pace` paths but not to `mirror` mode (which short-circuits before reaching it). This is arguably correct — if the bot is mirroring the human's pace, it doesn't matter whether the position is familiar. But an argument exists for applying a floor: even in mirror mode, a bot in deep familiar opening territory should play faster than the human if the human is slow, because a real player in that situation *would* play faster regardless of what their opponent just did. Whether to implement this depends on whether the mirror mode use case warrants it.

**3. Endgame acceleration / simplification recognition**
The hustle attractor already scales think time globally, and the Hustler personality uses piece count to modulate temperature across game phases. But there's no specific model of the well-known human pattern of playing faster in simplified endgames with limited material. A piece-count-based familiarity curve (analogous to the opening depth curve but on the other end of the game) could model this: as material drops below ~8 pieces, bots above ~1600 ELO start to "know the theory" again and play faster K+R vs K endgames, pawn races, etc.

**4. Time control awareness in complexity base**
`botThinkCapMs()` already scales the upper bound to the time control. But the base pace (`botPace` slider) is set manually and doesn't know whether it's a 1-minute bullet or a 30-minute rapid. A bullet bot should default to much faster base pace than a rapid bot even before any other modifiers. Consider auto-initializing `botCplxBase` (or the effective pace) from the time control when a game starts.

---

*Last updated: June 2026. Code reference: `src/50-bot-engine.js` (`botThinkTime`, `openingFamiliarity`, `botEffectiveElo`, `botThinkCapMs`, `explorerConfidenceFromData`, `botPostMoveHook`), `src/10-app-shell.js` (state variables), `src/60-bot-ui.js` (game-start resets).*

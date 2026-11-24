// Think-time behaviour under time pressure.
//
// The property that matters is that the bot's SPEED responds to its clock the
// way a person's does. Before this model it did not: between the start of the
// game and a hard 30-second threshold the bot's own clock had no influence at
// all, then a cap slammed on. 30 s also meant opposite things in bullet and in
// classical, increment was ignored outright, and the only clock comparison
// fired when the OPPONENT was low — never when the bot itself was behind.
//
// Same vm approach as the other engine tests: load the pure chess layer plus
// the bot engine into one scope and stub the few DOM touchpoints think time
// reads.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx(overrides = {}) {
  const ctx = {
    console,
    window: {},
    document: {
      // botPace is the only slider think time reads directly.
      getElementById: (id) => (id === 'botPace' ? { value: '40' } : null),
    },
    setTimeout: (fn) => fn(),
    Math: Object.create(Math),

    // Timing state, at documented defaults.
    botTimeBehavior: 'complexity',
    botCplxBase: 3, botThinkPace: 0,
    botFixedDelayMs: 5000, botMirrorOffsetPct: 0, botUserMoveTimestamps: [],
    botBehavBlink: false,        // off: we are testing clock response, not blink
    botBehavReconsider: false,   // off: random 1.5-2.5x would swamp the signal
    botBehavClockMirror: true,
    botCanFlag: true,
    botPressureDepth: 0.85,
    botDeficitWeight: 0.5,
    botWeaponizerEnabled: false, botWeaponizerTriggerMs: 15000, botWeaponizerMinMs: 0,
    botOppClockMs: null,
    botStartClockMs: 600 * 1000,
    clockInc: 0,
    sfCplxScore: 0.5,
    botMoveHistory: [],
    botSanHistory: [],
    maia3SelectedRating: 1500,
    botTab: 'maia3',
    botPressureCurveA: null,
    botPremoveBustDelayMs: 2000,
    botOpeningConfig: {},
  };
  Object.assign(ctx, overrides);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  // Freeze the two random sources so a single call is deterministic. 0.5 makes
  // the ±20% jitter exactly 1.0 and keeps the reconsider roll above its 0.15
  // threshold even if it were enabled.
  ctx.Math.random = () => 0.5;
  // Familiarity would otherwise make early-game moves fast for unrelated
  // reasons; push past the opening so the clock is what is being measured.
  ctx.botMoveHistory = new Array(60).fill('e2e4');
  return ctx;
}

const think = (ctx, clockMs) => ctx.botThinkTime(null, clockMs);

test('budget: increment is counted, so a healthy increment is not time pressure', () => {
  const noInc = makeCtx({ clockInc: 0, botStartClockMs: 900000 });
  const inc10 = makeCtx({ clockInc: 10, botStartClockMs: 900000 });
  // 60 plies played, so botRemainingMovesEstimate() = max(5, 40-30) = 10.
  const movesLeft = noInc.botRemainingMovesEstimate();
  assert.strictEqual(movesLeft, 10, 'precondition: expected moves remaining');

  const a = noInc.botTimeBudgetSec(60000);
  const b = inc10.botTimeBudgetSec(60000);
  assert.ok(b > a, 'increment must raise the budget: ' + a + ' vs ' + b);
  // 60s / 10 = 6s without increment; with +10s per move it is (60+100)/10 = 16s.
  assert.ok(Math.abs(a - 6) < 0.01, 'no-inc budget ' + a);
  assert.ok(Math.abs(b - 16) < 0.01, 'inc budget ' + b);
});

test('budget: null clock (untimed) yields no budget and no pressure', () => {
  const ctx = makeCtx();
  assert.strictEqual(ctx.botTimeBudgetSec(null), null);
  assert.strictEqual(ctx.botBudgetPressure(null, 5000), 0);
});

test('think time falls monotonically as the clock drains', () => {
  const ctx = makeCtx({ botStartClockMs: 600000 });
  const clocks = [600000, 300000, 120000, 60000, 30000, 10000, 5000];
  const times = clocks.map((c) => think(ctx, c));
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] <= times[i - 1] + 1,
      'think time must not rise as the clock drains: ' +
      clocks.map((c, j) => (c / 1000) + 's→' + Math.round(times[j])).join(', '));
  }
  assert.ok(times[times.length - 1] < times[0],
    'a nearly-flagging bot must be faster than a fresh one');
});

test('no cliff: think time is continuous across the old 30-second threshold', () => {
  const ctx = makeCtx({ botStartClockMs: 600000 });
  // The old code capped at 8% of clock the moment it crossed 30 s, so 30.1 s
  // and 29.9 s could differ by several seconds. Nothing may jump like that now.
  const a = think(ctx, 30100);
  const b = think(ctx, 29900);
  assert.ok(Math.abs(a - b) < 250,
    'discontinuity across 30 s: ' + Math.round(a) + 'ms vs ' + Math.round(b) + 'ms');
});

test('pressure is relative to the time control, not a fixed 30 seconds', () => {
  // 30 s in a 1-minute bullet game is half the clock: normal, not an emergency.
  // 30 s in a 90-minute game is genuine panic. The same absolute clock must
  // therefore produce very different urgency.
  const bullet = makeCtx({ botStartClockMs: 60000 });
  const classical = makeCtx({ botStartClockMs: 90 * 60 * 1000 });
  const pBullet = bullet.botBudgetPressure(30000, 3000);
  const pClassical = classical.botBudgetPressure(30000, 3000);
  // Budget depends only on clock and moves left, so these are equal — the
  // difference must come from the emergency backstop being relative.
  // Entropy scaled plans a different typical think for each time control (fitted
  // to people's own), so urgency is each game's think at 30 s as a share of its
  // think on a full clock.
  const tBullet = think(bullet, 30000) / think(bullet, 60000);
  const tClassical = think(classical, 30000) / think(classical, 90 * 60 * 1000);
  assert.ok(tClassical <= tBullet + 1e-9,
    'classical at 30 s should be at least as urgent as bullet at 30 s: ' +
    tBullet.toFixed(3) + ' vs ' + tClassical.toFixed(3) + ' of the calm pace');
  assert.ok(pBullet >= 0 && pClassical >= 0);
});

test('being behind on the clock makes the bot hurry', () => {
  const behind = makeCtx({ botOppClockMs: 480000, botBehavClockMirror: false });
  const level  = makeCtx({ botOppClockMs: 120000, botBehavClockMirror: false });
  const t1 = think(behind, 120000);   // 2:00 vs 8:00
  const t2 = think(level, 120000);    // 2:00 vs 2:00
  assert.ok(t1 < t2,
    'a bot behind on the clock must move faster than a level one: ' +
    Math.round(t1) + ' vs ' + Math.round(t2));
});

test('being ahead on the clock does not slow the bot down', () => {
  const ahead = makeCtx({ botOppClockMs: 60000, botBehavClockMirror: false });
  const level = makeCtx({ botOppClockMs: 120000, botBehavClockMirror: false });
  assert.strictEqual(ahead.botClockDeficit(120000), 0, 'no deficit when ahead');
  assert.ok(think(ahead, 120000) <= think(level, 120000) + 1);
});

test('clock mirroring waits for real time trouble, not a clock lead', () => {
  const at = (opp, inc, ours = 300000) => {
    const ctx = makeCtx({ botBehavClockMirror: true, botDeficitWeight: 0, clockInc: inc, botOppClockMs: opp });
    return { t: think(ctx, ours), trouble: ctx.botOppInTimeTrouble(ours) };
  };
  const calm = at(null, 0).t;
  // 5+3, Nov 2026: the opponent at 3 minutes against the bot's 5 had it moving
  // at a third of its pace. Behind is not trouble. (Compared with the same
  // increment: Entropy scaled's typical think depends on the time control.)
  assert.strictEqual(at(180000, 3).trouble, false, '3:00 against 5:00 is not trouble');
  assert.strictEqual(at(180000, 3).t, at(null, 3).t, 'and the bot keeps its pace');
  // No increment: trouble under 30 s. With one: under 15 s.
  assert.strictEqual(at(31000, 0).trouble, false, '31 s, no increment');
  assert.strictEqual(at(29000, 0).trouble, true, '29 s, no increment');
  assert.strictEqual(at(20000, 3).trouble, false, '20 s with +3 is not trouble');
  assert.strictEqual(at(14000, 3).trouble, true, '14 s with +3 is');
  const fast = at(10000, 0).t;
  assert.ok(Math.abs(fast - calm * 0.3) < 2, 'in trouble it plays at 0.3x: ' + Math.round(calm) + ' -> ' + Math.round(fast));
  // Not pressing when the bot has even less time than they do.
  assert.strictEqual(at(10000, 0, 8000).trouble, false, 'the bot lower still: no');
  // Untimed: no opponent clock, never trouble.
  assert.strictEqual(makeCtx().botOppInTimeTrouble(null), false);
});

test('the flag ceiling: a tenth of the clock plus the increment, never half the clock', () => {
  // Math.random is 0.5, so the ±20% factor is exactly 1.
  const c = (inc) => makeCtx({ clockInc: inc });
  assert.strictEqual(c(3).botFlagCeilingMs(60000), 9000, '5+3 on 1:00: 6 s + 3 s');
  assert.strictEqual(c(0).botFlagCeilingMs(100000), 10000, 'no increment, 100 s: 10 s');
  assert.strictEqual(c(3).botFlagCeilingMs(3000), 1500, '3 s on the clock with +3: half the clock, not 3.3 s');
  const r = makeCtx({ clockInc: 3 });
  r.Math.random = () => 0; const lo = r.botFlagCeilingMs(60000);
  r.Math.random = () => 0.999999; const hi = r.botFlagCeilingMs(60000);
  assert.ok(Math.abs(lo - 7200) < 1 && Math.abs(hi - 10800) < 1, 'give or take a fifth: ' + lo + '–' + hi);
  // It caps a long think whatever the mode.
  const fixed = makeCtx({ botTimeBehavior: 'fixed', botFixedDelayMs: 20000, clockInc: 3 });
  assert.strictEqual(think(fixed, 60000), 9000, 'Fixed 20 s on a 1:00 clock with +3');
});

test('the bot never plans to spend more than its per-move budget', () => {
  const ctx = makeCtx({ botStartClockMs: 60000, botCplxBase: 30 });  // absurdly slow base
  const clockMs = 20000;
  const budgetMs = ctx.botTimeBudgetSec(clockMs) * 1000;
  assert.ok(think(ctx, clockMs) <= budgetMs + 1,
    'think time must respect the budget ceiling');
});

test('the 200ms floor and the anti-flag guard still hold', () => {
  const ctx = makeCtx({ botStartClockMs: 60000 });
  assert.ok(think(ctx, 1000) >= 200, 'hard floor');
  const noFlag = makeCtx({ botCanFlag: false, botStartClockMs: 600000 });
  // With 4 s left and flagging disallowed it must keep at least 3 s back.
  assert.ok(think(noFlag, 4000) <= 1000 + 1, 'must not think into a self-flag');
});

test('untimed games are unaffected by any of the pressure machinery', () => {
  const ctx = makeCtx();
  const t = think(ctx, null);
  assert.ok(t >= 200, 'still returns a sane delay');
  assert.strictEqual(ctx.botClockDeficit(null), 0);
  assert.strictEqual(ctx.botOppInTimeTrouble(null), false);
});

test('pressureDepth 0 restores clock-insensitive pacing below the ceilings', () => {
  const off = makeCtx({ botPressureDepth: 0, botDeficitWeight: 0, botStartClockMs: 3600000 });
  // Deep into a long game, well above the emergency backstop and under budget,
  // the multiplier stage should leave think time alone.
  const a = think(off, 600000);
  const b = think(off, 300000);
  assert.ok(Math.abs(a - b) < 1, 'with depth 0 the clock should not shape pacing here');
});

test('fixed and mirror modes obey the same ceilings as the main path', () => {
  const fixed = makeCtx({ botTimeBehavior: 'fixed', botFixedDelayMs: 60000, botStartClockMs: 60000 });
  const clockMs = 20000;
  const budgetMs = fixed.botTimeBudgetSec(clockMs) * 1000;
  assert.ok(think(fixed, clockMs) <= budgetMs + 1, 'fixed mode must respect the budget');

  const mirror = makeCtx({
    botTimeBehavior: 'mirror',
    botUserMoveTimestamps: [60000, 60000],
    botStartClockMs: 60000,
  });
  assert.ok(think(mirror, clockMs) <= budgetMs + 1, 'mirror mode must respect the budget');
});

// ── Mirror user: the median, at most the game's time ÷ 60 ────────────────────
// The average let one long break drag the bot's pace out for the next six
// moves, and the general 45 s cap made a 90-minute game play like rapid.
const mirrorCtx = (times, extra) => makeCtx(Object.assign({
  botTimeBehavior: 'mirror', botUserMoveTimestamps: times, botStartClockMs: 90 * 60000, clockInc: 0,
  botBehavClockMirror: false, botDeficitWeight: 0,
}, extra));

test('mirror: the median of recent moves, so two hours away changes nothing', () => {
  const away = mirrorCtx([2000, 2000, 2000, 2000, 2000, 2 * 3600 * 1000]);
  assert.strictEqual(think(away, 90 * 60000), 2000);
  const even = mirrorCtx([7000, 1000, 5000, 3000]);
  assert.strictEqual(think(even, 90 * 60000), 4000, 'an even count takes halfway between the middle two');
});

test('mirror: never based on more than the game time ÷ 60', () => {
  const slow = [300000, 300000, 300000];
  assert.strictEqual(think(mirrorCtx(slow), 90 * 60000), 90000, '90 min: 90 s, past the old 45 s cap');
  assert.strictEqual(think(mirrorCtx(slow, { botStartClockMs: 180000, clockInc: 2 }), 180000), 5000,
    '3+2: (180 + 60 × 2) ÷ 60 = 5 s');
  assert.strictEqual(think(mirrorCtx(slow, { botMirrorOffsetPct: 50 }), 90 * 60000), 135000,
    'the offset applies on top of the capped baseline');
  assert.strictEqual(think(mirrorCtx([3000, 3000]), 90 * 60000), 3000, 'under the cap, it is the user\'s own pace');
  const bonus = mirrorCtx(slow, { clockControl: 'c90', TIME_CONTROLS: { c90: { time: 5400, inc: 0, bonusSecs: 1800, bonusAtMove: 40 } } });
  assert.strictEqual(think(bonus, 90 * 60000), 120000, 'a mid-game bonus is game time too: (5400 + 1800) ÷ 60');
});

test('mirror: with no clock the 6 s ceiling stays', () => {
  assert.strictEqual(think(mirrorCtx([20000, 20000], { botStartClockMs: null }), null), 6000);
});

// ── Which timing modes feel time pressure ────────────────────────────────────
// A pace the user set outright (Fixed, Instantaneous) is not time pressure;
// Mirror plays at the human's pace and cracks when they do; Complexity budgets
// from the clock.
test('time pressure applies to Complexity and Mirror, not to a Fixed or Instant pace', () => {
  const on  = m => makeCtx({ botTimeBehavior: m, clockControl: 'custom' })._timePressureApplies();
  assert.strictEqual(on('complexity'), true);
  assert.strictEqual(on('mirror'),     true, 'Mirror should degrade as the human speeds up');
  assert.strictEqual(on('fixed'),      false);
  assert.strictEqual(on('instant'),    false);
  assert.strictEqual(makeCtx({ botTimeBehavior: 'complexity', clockControl: 'untimed' })._timePressureApplies(),
    false, 'no clock, no time pressure');
});

// ── The clock-based plan ─────────────────────────────────────────────────────
test('the clock plan: (time left + increment to come) ÷ moves left, 60 moves from 10 minutes up', () => {
  // Game size = base + 40 × increment: 60 moves from 10 minutes, 40 below.
  const n = (min, inc) => makeCtx({ botStartClockMs: min * 60000, clockInc: inc }).botPlanGameMoves();
  assert.strictEqual(n(5, 3), 40, '5+3 = 7 min');
  assert.strictEqual(n(3, 2), 40, '3+2');
  assert.strictEqual(n(8, 2), 40, '8+2 = 9:20');
  assert.strictEqual(n(10, 0), 60, '10+0, exactly 10 min');
  assert.strictEqual(n(7, 5), 60, '7+5 = 10:20');
  assert.strictEqual(n(15, 10), 60, '15+10');
  // The time control decides, not the clock as it stands (a mid-game rebuild).
  const tc = makeCtx({ botStartClockMs: 60000, clockInc: 0, clockControl: 'x', TIME_CONTROLS: { x: { time: 900, inc: 0 } } });
  assert.strictEqual(tc.botPlanGameMoves(), 60, 'from TIME_CONTROLS when it has one');

  const ctx = makeCtx({ botCplxBaseMode: 'clock', botStartClockMs: 15 * 60000, clockInc: 2,
                        gameMovesAlgebraic: new Array(16).fill('e4') });   // 15+2, 8 moves in book
  // 24:00 left, +2 s: 52 moves left, (1440 + 52 × 2) / 52
  assert.ok(Math.abs(ctx.botClockPlanSec(24 * 60000) - 1544 / 52) < 1e-9);
  // At the first move it is the game's time ÷ N: 5+3 → 420 / 40.
  const first = makeCtx({ botCplxBaseMode: 'clock', botStartClockMs: 300000, clockInc: 3, gameMovesAlgebraic: [] });
  assert.ok(Math.abs(first.botClockPlanSec(300000) - 10.5) < 1e-9, '5+3: 10.5 s');
  // Past move N − 10 it keeps ten moves in hand.
  const late = makeCtx({ botCplxBaseMode: 'clock', botStartClockMs: 300000, clockInc: 0, gameMovesAlgebraic: new Array(90).fill('e4') });
  assert.ok(Math.abs(late.botClockPlanSec(60000) - 6) < 1e-9, '1:00 at move 45: 6 s');
  ctx.botCplxBaseMode = 'fixed';
  assert.strictEqual(ctx.botClockPlanSec(24 * 60000), null, 'Fixed seconds uses the Base time instead');
});

// ── Book moves follow the time control on the clock plan ─────────────────────
test('book moves: fast in bullet and blitz, 5–15 s from twenty minutes up', () => {
  const range = (minutes, inc, extra) => [...makeCtx(Object.assign({
    botCplxBaseMode: 'clock', botStartClockMs: minutes * 60000, clockInc: inc }, extra)).botBookMoveRangeMs()];   // spread: a test-realm array
  assert.deepStrictEqual(range(1, 0),  [400, 1200], 'bullet');
  assert.deepStrictEqual(range(5, 3),  [400, 1200], 'blitz');
  for (const m of [20, 30, 40, 60]) assert.deepStrictEqual(range(m, 0), [5000, 15000], m + ' min');
  const rapid = range(10, 0);
  assert.ok(rapid[0] > 400 && rapid[0] < 5000 && rapid[1] > 1200 && rapid[1] < 15000,
    'rapid scales between the two: ' + rapid.join('–'));
  // Every other timing mode keeps the flat book time — the default Fixed 2 s
  // should play like an ordinary bot.
  assert.deepStrictEqual(range(30, 0, { botTimeBehavior: 'fixed' }), [400, 1200], 'Fixed interval');
  assert.deepStrictEqual(range(30, 0, { botTimeBehavior: 'mirror' }), [400, 1200], 'Mirror user');
  assert.deepStrictEqual(range(30, 0, { botCplxBaseMode: 'fixed' }), [400, 1200], 'Fixed seconds');
});

test('a slow book move still respects the clock', () => {
  const ctx = makeCtx({ botCplxBaseMode: 'clock', botStartClockMs: 30 * 60000, clockInc: 0 });
  const t = ctx.botBookMoveDelayMs(10000);   // 10 s left on a 30-minute clock
  assert.ok(t <= 1000 + 1, 'emergency rule caps it at 10% of the clock: ' + Math.round(t));
});

// ── Novelty pause: the human played a move the book rarely sees ──────────────
const surprise = (ctx, boost) => vm.runInContext('_explorerSurpriseBoost = ' + boost, ctx);
const boostLeft = ctx => vm.runInContext('_explorerSurpriseBoost', ctx);

test('novelty pause: scales the real think time, once', () => {
  const ctx = makeCtx();
  const plain = think(ctx, 600000);
  // Equal to the last rounding: the measured spread is a multiplier like any other.
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg + ': ' + a + ' vs ' + b);
  surprise(ctx, 1);
  near(think(ctx, 600000), plain * 2.5, 'full boost');
  assert.strictEqual(boostLeft(ctx), 0, 'spent');
  assert.strictEqual(think(ctx, 600000), plain, 'and gone on the next move');
  surprise(ctx, 0.5);
  near(think(ctx, 600000), plain * 1.75, 'partial boost');
});

test('novelty pause: the rough estimate neither spends it nor reads it', () => {
  const ctx = makeCtx();
  const plain = ctx.botThinkTime(null, 600000, { rough: true });
  surprise(ctx, 1);
  assert.strictEqual(ctx.botThinkTime(null, 600000, { rough: true }), plain, 'the estimate is unchanged');
  assert.strictEqual(boostLeft(ctx), 1, 'still there for the real delay');
});

test('novelty pause: not where something else sets the pace, and never left pending', () => {
  for (const mode of ['instant', 'fixed', 'mirror']) {
    const ctx = makeCtx({ botTimeBehavior: mode, botUserMoveTimestamps: [4000] });
    const plain = think(ctx, 600000);
    surprise(ctx, 1);
    assert.strictEqual(think(ctx, 600000), plain, mode + ' is unchanged');
    assert.strictEqual(boostLeft(ctx), 0, mode + ' spends it');
    surprise(ctx, 1);
    assert.strictEqual(ctx.botSurpriseMult(), 1, mode + ' gives a book move no pause');
  }
  const ctx = makeCtx({ botWeaponizerEnabled: true, botOppClockMs: 10000 });
  surprise(ctx, 1);
  assert.strictEqual(ctx.botSurpriseMult(), 1, 'Weaponizer pressing');
  assert.strictEqual(boostLeft(ctx), 0, 'Weaponizer spends it');
});

test('novelty pause: book moves take it too, inside the clock caps', () => {
  const ctx = makeCtx({ botCplxBaseMode: 'clock', botStartClockMs: 30 * 60000, clockInc: 0, botBehavClockMirror: false });
  const plain = ctx.botBookMoveDelayMs(null);
  assert.strictEqual(ctx.botBookMoveDelayMs(null, 2.5), plain * 2.5, 'a plain book move');
  assert.ok(ctx.botBookMoveDelayMs(10000, 2.5) <= 1000 + 1, 'the pause cannot flag the bot');
  surprise(ctx, 1);
  assert.strictEqual(ctx.botThinkTime(null, 1800000, { book: true }), ctx.botBookMoveDelayMs(1800000, 2.5),
    'the clock plan\'s book path');
  assert.strictEqual(boostLeft(ctx), 0, 'and it is spent');
});


// ── Entropy scaled (the builder's name for 'complexity') ──────────────────────
// Fitted to people's own think times: Lichess blitz 3+0 to 5+3, Lichess rapid
// 10+0 to 15+10 and league games at 30+30 and 45+45 (BOT_ENTROPY_FIT). On the
// clock, at plies = 28 (move 15).
const uniform = (n) => { const p = {}; for (let i = 0; i < n; i++) p['m' + i] = 1 / n; return p; };
function entropyCtx(o = {}) {
  const ctx = makeCtx(Object.assign({ botCplxBaseMode: 'clock' }, o));
  ctx.gameMovesAlgebraic = new Array(o.plies != null ? o.plies : 28).fill('e4');
  return ctx;
}

test('entropy scaled: a typical move matches what people take (move 15, full clock)', () => {
  // The studies' medians at moves 11-20: about 3-4 s at 3+0, 6.9 s at 10+0,
  // 16.6 s at 15+10, about 80 s at 45+45 (with the clock no longer full).
  // An average position is 1.39 nats, which is what no distribution stands for.
  const at = (base, inc) => entropyCtx({ botStartClockMs: base * 1000, clockInc: inc })
    .botEntropyTypicalMs(1.39, base * 1000) / 1000;
  const b = at(180, 0), r10 = at(600, 0), r15 = at(900, 10), l = at(2700, 45);
  assert.ok(b > 3 && b < 5, '3+0 typical ' + b.toFixed(2) + ' s');
  assert.ok(r10 > 6 && r10 < 9, '10+0 typical ' + r10.toFixed(2) + ' s');
  assert.ok(r15 > 14 && r15 < 20, '15+10 typical ' + r15.toFixed(2) + ' s');
  assert.ok(l > 65 && l < 95, '45+45 typical ' + l.toFixed(1) + ' s');
});

test('entropy scaled: more playable moves, a longer think', () => {
  const ctx = entropyCtx({ botStartClockMs: 180000 });
  const few = ctx.botThinkTime(uniform(2), 170000);
  const many = ctx.botThinkTime(uniform(12), 170000);
  assert.ok(many > few, few + ' vs ' + many);
  // blitz: e^(0.331 × (ln 12 − ln 2)) = 1.81
  assert.ok(Math.abs(many / few - Math.exp(0.331 * Math.log(6))) < 0.01, 'ratio ' + (many / few).toFixed(3));
});

test('entropy scaled: the game stage — most around moves 15-25, less and less after 30', () => {
  const ctx = entropyCtx();
  for (const fit of ['blitz', 'rapid10', 'rapid15', 'league']) {
    const st = vm.runInContext('BOT_ENTROPY_FIT', ctx)[fit].stage;   // a const, not a global property
    const at = m => ctx._entropyStageAt(st, m);
    assert.ok(at(18) > at(13) && at(18) > at(30) && at(30) > at(40) && at(40) > at(55) && at(55) > at(70),
      fit + ': ' + [13, 18, 30, 40, 55, 70].map(m => at(m).toFixed(2)).join(' '));
    assert.strictEqual(at(5), at(13), fit + ': flat before move 13');
    assert.strictEqual(at(90), at(70), fit + ': flat after move 70');
  }
});

test('entropy scaled: each fit on the controls it was measured on, neighbours blended between', () => {
  // Weights per fit: blitz, rapid 10+0/10+5, rapid 15+10, league.
  const w = (base, inc) => [...entropyCtx({ botStartClockMs: base * 1000, clockInc: inc }).botEntropyWeights()];
  const alone = (base, inc, i, label) => {
    const v = w(base, inc);
    assert.deepStrictEqual(v, [0, 1, 2, 3].map(j => j === i ? 1 : 0), label + ': ' + v.join(' '));
  };
  alone(60, 0, 0, 'bullet uses blitz'); alone(180, 0, 0, '3+0'); alone(300, 3, 0, '5+3'); alone(420, 0, 0, '7+0');
  alone(600, 0, 1, '10+0'); alone(600, 5, 1, '10+5');
  alone(900, 10, 2, '15+10');
  alone(1800, 30, 3, '30+30'); alone(2700, 45, 3, '45+45'); alone(5400, 30, 3, '90+30');
  assert.deepStrictEqual([...entropyCtx({ botStartClockMs: null }).botEntropyWeights()], [0, 0, 0, 1], 'untimed uses league');
  // Between, on a log scale of base + 40 × increment, and always summing to 1.
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, label + ': ' + a + ' vs ' + b);
  near(w(480, 0)[1], Math.log(480 / 420) / Math.log(600 / 420), '8+0, blitz to rapid');
  near(w(720, 5)[2], Math.log(920 / 800) / Math.log(1300 / 800), '12+5, rapid to 15+10');
  near(w(1200, 10)[3], Math.log(1600 / 1300) / Math.log(3000 / 1300), '20+10, 15+10 to league');
  for (const [b, i] of [[480, 0], [720, 5], [900, 0], [1200, 10], [1800, 0]]) {
    const v = w(b, i);
    near(v.reduce((s, x) => s + x, 0), 1, b + '+' + i + ' sums to 1');
    assert.ok(v.filter(x => x > 0).length <= 2, 'at most two fits at once');
  }
});

test('entropy scaled: the level is set to what people showed at each control (the fits, the Nov 23 bullet check)', () => {
  const lv = (base, inc) => entropyCtx({ botStartClockMs: base * 1000, clockInc: inc }).botEntropyLevel();
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, label + ': ' + a + ' vs ' + b);
  // The measured points, without and with an increment.
  near(lv(60, 0), 1.67, '1+0'); near(lv(180, 0), 0.94, '3+0'); near(lv(300, 0), 0.78, '5+0'); near(lv(600, 0), 0.93, '10+0');
  near(lv(120, 1), 1.24, '2+1'); near(lv(180, 2), 1.03, '3+2'); near(lv(300, 3), 0.90, '5+3'); near(lv(600, 5), 0.94, '10+5');
  near(lv(900, 10), 0.99, '15+10'); near(lv(1800, 30), 1.08, '30+30'); near(lv(2700, 45), 1.14, '45+45');
  // Between points, a straight line on a log scale of base + 40 × increment:
  // 3+1 (220 s) lies between 2+1 (160) and 3+2 (260).
  const f = Math.log(220 / 160) / Math.log(260 / 160);
  near(lv(180, 1), 1.24 + f * (1.03 - 1.24), '3+1');
  // Below 1+0 (not measured) phased out by ½+0, where 1.67 flagged the bot.
  near(lv(30, 0), 1, '½+0'); near(lv(15, 0), 1, '¼+0');
  near(lv(45, 0), 1 + Math.log(45 / 30) / Math.log(2) * 0.67, '¾+0');
  // Held past the other ends; none with no clock.
  near(lv(1800, 0), 0.93, '30+0'); near(lv(5400, 60), 1.14, '90+60');
  assert.strictEqual(entropyCtx({ botStartClockMs: null }).botEntropyLevel(), 1, 'untimed');
  // The typical think carries it on the clock; Fixed seconds sets its own.
  const typ = (o, flat) => {
    const ctx = entropyCtx(o);
    if (flat) vm.runInContext('BOT_ENTROPY_FIT.level.noInc = [[60, 1]]', ctx);
    return ctx.botEntropyTypicalMs(1.39, o.botStartClockMs);
  };
  const clock10 = { botStartClockMs: 600000, clockInc: 0 };
  near(typ(clock10) / typ(clock10, true), 0.93, '10+0 typical ÷ uncorrected');
  const fixed10 = { botStartClockMs: 600000, clockInc: 0, botCplxBaseMode: 'fixed', botCplxBase: 5 };
  near(typ(fixed10) / typ(fixed10, true), 1, 'Fixed seconds: no level');
});

test('entropy scaled: the measured spread — centred, as wide as people, held at the 1st and 99th percentiles', () => {
  const blitz = entropyCtx({ botStartClockMs: 180000 });
  const rapid10 = entropyCtx({ botStartClockMs: 600000, clockInc: 5 });
  const rapid15 = entropyCtx({ botStartClockMs: 900000, clockInc: 10 });
  const league = entropyCtx({ botStartClockMs: 2700000, clockInc: 45 });
  for (const [ctx, sd, mean] of [[blitz, 0.71, 1.30], [rapid10, 0.87, 1.48], [rapid15, 0.92, 1.52], [league, 1.09, 1.79]]) {
    assert.ok(Math.abs(Math.log(ctx.botEntropySpreadMult(0.5))) < 0.05, 'median about 1');
    assert.strictEqual(ctx.botEntropySpreadMult(0.001), ctx.botEntropySpreadMult(0.01), 'held at 1%');
    assert.strictEqual(ctx.botEntropySpreadMult(0.999), ctx.botEntropySpreadMult(0.99), 'held at 99%');
    let prev = 0, sum = 0, sum2 = 0, n = 0;
    for (let u = 0.0005; u < 1; u += 0.001) {
      const m = ctx.botEntropySpreadMult(u);
      assert.ok(m >= prev, 'rises with u'); prev = m;
      sum += m; sum2 += Math.log(m) ** 2; n++;
    }
    assert.ok(Math.abs(Math.sqrt(sum2 / n) - sd) < 0.08, 'spread SD ' + Math.sqrt(sum2 / n).toFixed(2) + ' vs ' + sd);
    assert.ok(Math.abs(sum / n - mean) < 0.12, 'mean ' + (sum / n).toFixed(2) + ' vs ' + mean);
  }
});

test('entropy scaled: Slower-Faster runs from twice a typical think to half', () => {
  const at = (pace) => entropyCtx({ botStartClockMs: 900000, botThinkPace: pace }).botThinkTime(uniform(5), 800000);
  const typical = at(0);
  assert.ok(Math.abs(at(-1) / typical - 2) < 1e-9, 'slowest x2: ' + (at(-1) / typical));
  assert.ok(Math.abs(at(1) / typical - 0.5) < 1e-9, 'fastest x1/2: ' + (at(1) / typical));
  assert.ok(Math.abs(at(-0.5) / typical - Math.SQRT2) < 1e-9, 'halfway: x1.41');
});

test('entropy scaled: a less likely move takes longer, once it is chosen', () => {
  const ctx = entropyCtx({ botStartClockMs: 900000 });
  const probs = { a: 0.7, b: 0.2, c: 0.1 };
  const base = ctx.botThinkTime(probs, 800000);
  const likely = ctx.botEntropyMoveThinkMs(base, probs, 'a', 800000);
  ctx.botThinkTime(probs, 800000);
  const unlikely = ctx.botEntropyMoveThinkMs(base, probs, 'c', 800000);
  assert.ok(likely < base && unlikely > base, likely + ' < ' + base + ' < ' + unlikely);
  assert.strictEqual(ctx.botEntropyMoveThinkMs(base, probs, 'c', 800000), base, 'one-shot');
  // Not for a book move, the rough estimate, or another timing mode.
  const book = ctx.botThinkTime(probs, 800000, { book: true });
  assert.strictEqual(ctx.botEntropyMoveThinkMs(book, probs, 'c', 800000), book, 'book');
  const rough = ctx.botThinkTime(probs, 800000, { rough: true });
  assert.strictEqual(ctx.botEntropyMoveThinkMs(rough, probs, 'c', 800000), rough, 'rough');
  const fixed = makeCtx({ botTimeBehavior: 'fixed' });
  const f = fixed.botThinkTime(probs, 800000);
  assert.strictEqual(fixed.botEntropyMoveThinkMs(f, probs, 'c', 800000), f, 'fixed');
});

test('entropy scaled: reconsideration pauses are not added (the spread has them)', () => {
  const at = (rec) => {
    const ctx = entropyCtx({ botStartClockMs: 900000, botBehavReconsider: rec });
    ctx.Math.random = () => 0.1;   // would trigger a reconsideration pause
    return ctx.botThinkTime(uniform(5), 800000);
  };
  assert.strictEqual(at(true), at(false));
});

test('entropy scaled: no plan ceiling — a long think can run past 2.5x the plan, never past the flag ceiling', () => {
  const ctx = entropyCtx({ botStartClockMs: 180000 });
  ctx.Math.random = () => 0.995;                 // the top of the spread
  const clock = 170000;
  const t = ctx.botThinkTime(uniform(40), clock); // many playable moves
  const plan = ctx.botClockPlanSec(clock) * 1000;
  assert.ok(t > 2.5 * plan, t + ' vs plan ' + plan);
  assert.ok(t <= (clock / 10) * 1.2 + 1 && t <= clock / 2, 'flag ceiling: ' + t);
});


test('entropy scaled: opening familiarity only before move 11 (the stage curve has it after)', () => {
  // A 2600 bot is "in its book" to about move 22; a 600 bot to about move 4.
  const at = (elo, plies) => {
    const ctx = entropyCtx({ botStartClockMs: 900000, maia3SelectedRating: elo, plies });
    ctx.botMoveHistory = new Array(plies).fill('e2e4');
    return ctx.botThinkTime(uniform(5), 850000);
  };
  assert.strictEqual(at(2600, 24), at(600, 24), 'move 13: rating does not change the think');
  assert.ok(at(2600, 12) < at(600, 12), 'move 7: the stronger bot still plays what it knows faster');
});

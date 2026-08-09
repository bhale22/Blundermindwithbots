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
    botCplxBase: 3, botCplxMin: 0.4, botCplxMax: 2.5,
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
  const tBullet = think(bullet, 30000);
  const tClassical = think(classical, 30000);
  assert.ok(tClassical <= tBullet + 1,
    'classical at 30 s should be at least as urgent as bullet at 30 s: ' +
    Math.round(tBullet) + ' vs ' + Math.round(tClassical));
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

test('clock mirroring is graduated, not a step at exactly 60%', () => {
  const ctx = makeCtx({ botBehavClockMirror: true, botDeficitWeight: 0 });
  // Opponent sinking from level to nearly flagged, our clock fixed.
  const ours = 120000;
  const ratios = [1.0, 0.8, 0.6, 0.4, 0.2];
  const times = ratios.map((r) => {
    ctx.botOppClockMs = ours * r;
    return think(ctx, ours);
  });
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] <= times[i - 1] + 1, 'must decrease as the opponent sinks');
  }
  // The old code did nothing at 0.61 and halved at 0.59. Adjacent samples
  // either side of 0.6 must now be close together.
  ctx.botOppClockMs = ours * 0.61; const justAbove = think(ctx, ours);
  ctx.botOppClockMs = ours * 0.59; const justBelow = think(ctx, ours);
  assert.ok(Math.abs(justAbove - justBelow) < 200,
    'step at the 60% boundary: ' + Math.round(justAbove) + ' vs ' + Math.round(justBelow));
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
  assert.strictEqual(ctx.botOppClockDeficit(null), 0);
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

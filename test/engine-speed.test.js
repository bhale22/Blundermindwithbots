// How fast this device runs the engine, and what follows from it
// (src/40-engines.js): the start-up measurement, the readings taken from every
// search, the stretched time limits (capped by the clock in a timed game), what
// a check of n moves is expected to cost, the recommended "Moves checked per
// turn", and the cap itself as the personality's checks apply it
// (src/50-bot-engine.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MIDDLE = 'r4rk1/pp2bppp/2n1pn2/3p4/3P4/2N1PN2/PP3PPP/R4RK1 w - - 0 14';      // 25 pieces
const ENDING = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 30';                             // 9 pieces

function makeEngineCtx(opts = {}) {
  let now = 0;
  const store = {};
  const timers = [];
  const ctx = {
    console: { log() {}, warn() {} },
    window: {},
    document: { getElementById: () => null },
    navigator: {},
    performance: { now: () => now },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    // The app shell's engine globals.
    sfWorker: null, sfReady: false, sfBestmovesOwed: 0, sfCurrentSkillLevel: -1,
    botActive: false, clockInc: 0,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '40-engines.js'), 'utf8'), ctx);
  ctx.advance = (ms) => {
    now += ms;
    for (const t of timers) if (t.fn && t.at <= now) { const f = t.fn; t.fn = null; f(); }
  };
  ctx.store = store;
  ctx.get = (expr) => vm.runInContext(expr, ctx);
  return ctx;
}
// Speed readings, positions a second.
function readings(ctx, ...nps) {
  ctx.get('sfSpeed.samples.length = 0');
  for (const v of nps) ctx._sfSpeedPush(v);
}

// ── What a check costs ────────────────────────────────────────────────────────

test('the probe table: measured points exactly, straight lines between', () => {
  const ctx = makeEngineCtx();
  assert.equal(ctx.sfProbeNodes(16, 10), 158000);
  assert.equal(ctx.sfProbeNodes(2, 10), 21000);
  assert.equal(ctx.sfProbeNodes(6, 10), (46000 + 82000) / 2);
  assert.ok(ctx.sfProbeNodes(40, 10) > ctx.sfProbeNodes(32, 10), 'carried on past the table');
  assert.equal(ctx.sfProbeNodes(16, 8), 158000 / 4, 'two plies shallower: a quarter');
  assert.equal(ctx.sfProbeNodes(16, 12), 158000 * 4);
});

test('the position matters: an opening costs most, an ending least', () => {
  const ctx = makeEngineCtx();
  const o = ctx.sfProbeNodes(16, 10, START), m = ctx.sfProbeNodes(16, 10, MIDDLE), e = ctx.sfProbeNodes(16, 10, ENDING);
  assert.ok(o > m && m > e, JSON.stringify({ o, m, e }));
  assert.ok(Math.abs(o / 158000 - 1.85) < 0.06, 'a full board: 1.85x the table');
  assert.ok(Math.abs(e / 158000 - 0.35) < 0.01, 'an ending: 0.35x');
});

test('expected time: positions at this device\'s speed; nothing before it is measured', () => {
  const ctx = makeEngineCtx();
  assert.equal(ctx.sfExpectedProbeMs(16, 10), null);
  readings(ctx, 1e6);
  assert.ok(Math.abs(ctx.sfExpectedProbeMs(16, 10) - 160) < 1, 'a desktop: ~160 ms for 16 moves');
  readings(ctx, 50000);
  assert.ok(Math.abs(ctx.sfExpectedProbeMs(16, 10) - 3162) < 1, '20x slower: ~3.2 s');
});

// ── Speed, slowdown, stretch ──────────────────────────────────────────────────

test('the speed planned on is a slow one of the last readings, not their average', () => {
  const ctx = makeEngineCtx();
  readings(ctx, 900000, 1000000, 950000, 400000, 980000, 1010000, 990000, 970000, 960000);
  assert.equal(ctx.sfDeviceNps(), 950000, 'the 25th percentile');
  for (let i = 0; i < 12; i++) ctx._sfSpeedPush(300000);
  assert.equal(ctx.sfDeviceNps(), 300000, 'a dozen slow readings later, it is the slow speed');
  assert.equal(ctx.get('sfSpeed.samples.length'), 12, 'only the last dozen are kept');
});

test('the stretch: none at a desktop\'s speed, half as much again as a slowdown, at most 10x', () => {
  const ctx = makeEngineCtx();
  readings(ctx, 900000);
  assert.equal(ctx.sfTimeStretch(), 1);
  readings(ctx, 1800000);
  assert.equal(ctx.sfTimeStretch(), 1, 'a faster device keeps the desktop\'s limits');
  readings(ctx, 450000);
  assert.equal(ctx.sfTimeStretch(), 2.5);
  readings(ctx, 225000);
  assert.equal(ctx.sfTimeStretch(), 5.5);
  readings(ctx, 9000);
  assert.equal(ctx.sfTimeStretch(), 10);
});

test('a limit stretches with the device, and in a timed bot game stops at the flag ceiling', () => {
  const ctx = makeEngineCtx();
  readings(ctx, 900000);
  assert.equal(ctx.sfLimitMs(5000), 5000, 'a desktop: unchanged');
  readings(ctx, 225000);                       // 4x slower: 5.5x
  assert.equal(ctx.sfLimitMs(5000), 27500, 'untimed: the whole stretch');
  ctx.botActive = true;
  ctx.botClockMs = () => 120000;               // 2 minutes, +2
  ctx.clockInc = 2;
  assert.equal(ctx.sfLimitMs(5000), 14000, 'a tenth of the clock plus the increment');
  ctx.botClockMs = () => 20000;
  ctx.clockInc = 0;
  assert.equal(ctx.sfLimitMs(5000), 5000, 'never below the desktop\'s own limit');
});

test('the checks\' own limit: the desktop\'s 2 s + 0.15 s a move, at most 7 s', () => {
  const ctx = makeEngineCtx();
  assert.equal(ctx.sfProbeBaseLimitMs(16), 4400);
  assert.equal(ctx.sfProbeBaseLimitMs(40), 7000);
});

// ── The recommendation and the cap ────────────────────────────────────────────

test('the recommendation: all on a desktop, fewer the slower the device', () => {
  const ctx = makeEngineCtx();
  assert.equal(ctx.sfRecommendedCheckCap(), null, 'nothing before it is measured');
  readings(ctx, 900000);
  assert.equal(ctx.sfRecommendedCheckCap(), 0);
  readings(ctx, 50000);                        // ~20x slower
  assert.equal(ctx.sfRecommendedCheckCap(), 12);
  readings(ctx, 30000);                        // 30x
  assert.equal(ctx.sfRecommendedCheckCap(), 4);
  readings(ctx, 5000);
  assert.equal(ctx.sfRecommendedCheckCap(), 2, 'never fewer than the popular move and the pick');
  // Each recommendation fits: expected x 1.5 within the desktop's limit.
  readings(ctx, 50000);
  assert.ok(ctx.sfExpectedProbeMs(12, 10) * 1.5 <= ctx.sfProbeBaseLimitMs(12));
  assert.ok(ctx.sfExpectedProbeMs(16, 10) * 1.5 > ctx.sfProbeBaseLimitMs(16));
});

test('the cap is this device\'s: kept in its storage, the first moves kept', () => {
  const ctx = makeEngineCtx();
  const list = ['top', 'pick', 'a', 'b', 'c', 'd'];
  assert.equal(ctx.sfCheckCap(), 0);
  assert.deepEqual(ctx.sfCapCandidates(list), list, 'all of them by default');
  ctx.sfSetCheckCap(4);
  assert.equal(ctx.store.bm_checkCap, '4');
  assert.deepEqual(ctx.sfCapCandidates(list), ['top', 'pick', 'a', 'b']);
  ctx.sfSetCheckCap(0);
  assert.equal(ctx.store.bm_checkCap, undefined, 'all of them again: nothing stored');
  assert.deepEqual(ctx.sfCapCandidates(list), list);
});

// ── The log line ──────────────────────────────────────────────────────────────

test('the turn\'s checks on its log line: one count per check, total time, expected, the limit if hit', () => {
  const ctx = makeEngineCtx();
  ctx.get('sfTurnChecks = []');
  assert.equal(ctx.sfTurnChecksText(), '');
  ctx.get('sfTurnChecks = [{ n: 10, ms: 400, expectedMs: 500, limitMs: 9000, cut: false },' +
          ' { n: 12, ms: 1900, expectedMs: 1600, limitMs: 9000, cut: false }]');
  assert.equal(ctx.sfTurnChecksText(), 'checked 10 + 12 moves in 2.3 s (expected 2.1 s)');
  ctx.get('sfTurnChecks = [{ n: 16, ms: 4400, expectedMs: 3100, limitMs: 4400, cut: true }]');
  assert.equal(ctx.sfTurnChecksText(), 'checked 16 moves in 4.4 s (expected 3.1 s), stopped at its 4.4 s limit');
});

test('the speed in words', () => {
  const ctx = makeEngineCtx();
  assert.equal(ctx.sfSpeedText(), 'Engine speed not measured yet');
  readings(ctx, 880000);
  assert.equal(ctx.sfSpeedText(), 'Engine speed 0.88 M positions/s, about a desktop\'s');
  readings(ctx, 45000);
  assert.equal(ctx.sfSpeedText(), 'Engine speed 45k positions/s, 20.0× slower than a desktop: time limits ×10.0');
  assert.match(ctx.sfSpeedLogLine(), /Checking 4 \/ 8 \/ 16 \/ 32 moves ≈ 1\.0 \/ 1\.8 \/ 3\.5 \/ 6\.8 s here\. /);
  assert.match(ctx.sfSpeedLogLine(), /Moves checked a turn: all \(recommended: at most 8, in the builder's Personality\)$/);
  ctx.sfSetCheckCap(8);
  assert.match(ctx.sfSpeedLogLine(), /Moves checked a turn: at most 8$/, 'the recommendation, once taken, goes unsaid');
});

// ── The start-up measurement ──────────────────────────────────────────────────

// A stand-in engine: answers isready, and each search with its node count
// after `msPerRun` (an array: one per run), or never (null).
function fakeEngine(ctx, msPerRun, opts = {}) {
  const posted = [];
  let run = 0;
  ctx.sfWorker = {
    postMessage(m) {
      posted.push(m);
      if (m === 'isready' && !opts.silent) ctx.setTimeout(() => ctx._sfBenchLine('readyok'), 1);
      if (/^go /.test(m) && !opts.silent) {
        const ms = msPerRun[run++];
        if (ms == null) return;
        ctx.setTimeout(() => { ctx._sfBenchLine('info depth 10 nodes 19971 nps 1'); ctx._sfBenchLine('bestmove e2e4'); }, ms);
      }
      if (m === 'stop' && opts.answersStop) ctx.setTimeout(() => { ctx._sfBenchLine('info depth 7 nodes 5000'); ctx._sfBenchLine('bestmove e2e4'); }, 1);
    },
  };
  return posted;
}
function runBench(ctx, steps) {
  let ready = false;
  ctx._sfBenchStart(() => { ready = true; });
  for (let i = 0; i < steps && !ready; i++) ctx.advance(10);
  return ready;
}

test('start-up: a warm-up run, then two timed runs, the faster kept', () => {
  const ctx = makeEngineCtx();
  const posted = fakeEngine(ctx, [40, 30, 20]);
  assert.ok(runBench(ctx, 100), 'the engine is handed over');
  assert.equal(posted.filter(m => /^go depth 10$/.test(m)).length, 3);
  assert.equal(ctx.get('sfSpeed.benchNodes'), 19971);
  assert.ok(Math.abs(ctx.get('sfSpeed.benchMs') - 20) < 11, 'the faster timed run (the clock ticks in 10s here)');
  assert.equal(ctx.get('sfSpeed.samples.length'), 1, 'one reading');
  assert.equal(posted.filter(m => m === 'ucinewgame').length, 3, 'each run on an empty hash, none after');
});

test('start-up on a very slow engine: the warm-up is the reading', () => {
  const ctx = makeEngineCtx();
  const posted = fakeEngine(ctx, [2000]);
  assert.ok(runBench(ctx, 400));
  assert.equal(posted.filter(m => /^go /.test(m)).length, 1, 'no second run: that much is already known');
  assert.ok(ctx.sfDeviceNps() < 11000);
});

test('start-up: an engine that never searches is handed over unmeasured, its bestmove owed', () => {
  const ctx = makeEngineCtx();
  fakeEngine(ctx, [null]);
  assert.ok(runBench(ctx, 1000), 'handed over');
  assert.equal(ctx.sfDeviceNps(), null, 'no reading');
  assert.equal(ctx.sfBestmovesOwed, 1, 'its bestmove, should it come, is discarded');
  assert.equal(ctx.sfLimitMs(5000), 5000, 'and the limits stay the desktop\'s');
});

test('start-up: a search stopped at the deadline still gives its reading', () => {
  const ctx = makeEngineCtx();
  fakeEngine(ctx, [null], { answersStop: true });
  assert.ok(runBench(ctx, 1000));
  assert.ok(ctx.sfDeviceNps() > 0 && ctx.sfDeviceNps() < 2000, String(ctx.sfDeviceNps()));
  assert.equal(ctx.sfBestmovesOwed, 0);
});

// ── The cap in the personality's checks (50-bot-engine) ──────────────────────

function makeBotCtx(cap) {
  const ctx = {
    console: { log() {}, warn() {} }, window: {}, document: { getElementById: () => null },
    indActive: () => false, setTimeout: (fn) => fn(),
  };
  ctx.uciToSq = (uci) => (!uci || uci.length < 4) ? null
    : { from: ctx.fileRankToSq(uci.slice(0, 2)), to: ctx.fileRankToSq(uci.slice(2, 4)), promo: uci[4] || null };
  ctx.sqToUci = (from, to, promo) => ctx.sqName(from) + ctx.sqName(to) + (promo || '');
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  Object.assign(ctx, { botMinProbPct: 0, botDayLower: 0, botDayUpper: 100, botBadDayMode: false });
  ctx.window._bcpAttractorValues = {}; ctx.window._bcpPieceValues = {}; ctx.window._bcpCustomControls = [];
  ctx.window._bcpCpBudget = 100;
  ctx.sfReady = true;
  ctx.sent = [];
  ctx.opts = [];
  ctx.sfEvalMoves = async (fen, moves, depth, opts) => { ctx.sent.push(moves.slice()); ctx.opts.push(opts); return Object.fromEntries(moves.map(m => [m, -500])); };
  ctx.sfCapCandidates = list => cap && list.length > cap ? list.slice(0, cap) : list;
  return ctx;
}

test('the Budget check sends at most the cap: the popular move and the pick first', async () => {
  const ctx = makeBotCtx(3);
  vm.runInContext('_attrReweightApplied = true', ctx);
  const raw = { e2e4: 0.4, d2d4: 0.2, c2c4: 0.15, g1f3: 0.1, b2b3: 0.1, g2g3: 0.05 };
  const shaped = { g2g3: 0.5, b2b3: 0.2, c2c4: 0.1, e2e4: 0.1, d2d4: 0.05, g1f3: 0.05 };
  await ctx.applyCpBudgetAcceptance('fen', 'g2g3', raw, shaped);
  assert.deepEqual(ctx.sent[0], ['e2e4', 'g2g3', 'b2b3']);
});

test('Blind Conviction sends at most the cap, the popular move first', async () => {
  const ctx = makeBotCtx(2);
  vm.runInContext('botBlendTemp = null', ctx);
  const raw = { e2e4: 0.4, d2d4: 0.3, c2c4: 0.2, g1f3: 0.1 };
  await ctx.blindConvictionPick('fen', raw, ['g1f3', 'c2c4', 'e2e4', 'd2d4'], false);
  assert.deepEqual(ctx.sent[0], ['e2e4', 'g1f3']);
});

test('with no engine file loaded the checks are not capped', async () => {
  const ctx = makeBotCtx(0);
  delete ctx.sfCapCandidates;
  vm.runInContext('_attrReweightApplied = true', ctx);
  const raw = { e2e4: 0.4, d2d4: 0.3, c2c4: 0.2, g1f3: 0.1 };
  await ctx.applyCpBudgetAcceptance('fen', 'g1f3', raw, { g1f3: 0.7, c2c4: 0.2, d2d4: 0.05, e2e4: 0.05 });
  assert.deepEqual(ctx.sent[0], ['e2e4', 'g1f3', 'c2c4', 'd2d4']);
});

test("a premove's checks keep the desktop's limit; the bot's own move's are left to stretch", async () => {
  const ctx = makeBotCtx(0);
  vm.runInContext('_attrReweightApplied = true', ctx);
  const raw = { e2e4: 0.4, d2d4: 0.3, c2c4: 0.2, g1f3: 0.1 };
  const shaped = { g1f3: 0.7, c2c4: 0.2, d2d4: 0.05, e2e4: 0.05 };
  await ctx.applyCpBudgetAcceptance('fen', 'g1f3', raw, shaped, true);
  assert.deepEqual(ctx.opts[0], { timeoutMs: 2000 + 150 * 4 }, 'strict: the desktop limit for 4 moves');
  await ctx.applyCpBudgetAcceptance('fen', 'g1f3', raw, shaped);
  assert.equal(ctx.opts[1], undefined, "the bot's move: sfEvalMoves stretches its own limit");
  await ctx.blindConvictionPick('fen', raw, ['g1f3', 'c2c4', 'e2e4', 'd2d4'], true);
  assert.deepEqual(ctx.opts[2], { timeoutMs: 2000 + 150 * 4 });
});

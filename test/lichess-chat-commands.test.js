// Tests for the Lichess game chat's commands (src/65-lichess-bridge.js) and
// the engine state they set (src/50-bot-engine.js), as Blundermind-M3 uses
// them (Nov 2026): plain Maia that a Lichess opponent can adjust.
//
//   - Which commands a bot takes is its own (the builder's Lichess popup,
//     cfg.lichessCommands). A bot saved before that takes cp, think and temp,
//     so Blundermind-01 is as it was.
//   - think mirror plays at the opponent's pace. Blink on forced moves goes
//     with the bot's own timing only: a fixed time or mirror asked for in the
//     chat turns it off.
//   - degrade on / off switches Curve A only, the rating Maia is called with,
//     on the Regan model for the game's clock. It never runs with a fixed time.
//   - temp on a Maia bot with no personality is Maia's own temperature, 0 to 4
//     (0 = her top move, 1 = her own odds), not Temp's blend.
//
// The parser and the greeting are pure; the rest runs in a vm with the engine
// and the bridge loaded together. The whole flow, against a stand-in Lichess,
// is in scripts/verify-lichess-bridge.mjs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function makeCtx() {
  const ctx = {
    console: { log() {}, warn() {}, error: console.error },
    window: {},
    document: { getElementById: () => null, addEventListener() {}, querySelector: () => null },
    location: { search: '', hostname: 'localhost' },
    indActive: () => false,
    setTimeout: (fn) => fn(),
    LC_RATING_BUCKETS: [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '20-chess-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '50-bot-engine.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, '65-lichess-bridge.js'), 'utf8'), ctx);
  // As 10-app-shell.js declares them, for a Maia bot.
  Object.assign(ctx, {
    botTab: 'maia3', botMaiaTempValue: 1, botBlindConviction: false, botConvictionPct: 0,
    botTimeBehavior: 'complexity', botFixedDelayMs: 2000, botBehavBlink: true,
    botPressureCurveA: null, botPressureCurveB: null, clockControl: 'lichess',
    FLOUNDER_ELO_MIN: 600, FLOUNDER_ELO_MAX: 2400, FLOUNDER_ELO_STEP: 25,
  });
  ctx.window._bcpAttractorValues = {};
  ctx.window._bcpPieceValues = {};
  ctx.window._bcpCustomControls = [];
  return ctx;
}

// Blundermind-M3 as built: plain Maia 1500, Complexity timing with blink, no
// premoves, both curves off, matching, and the chat commands it takes.
const M3 = {
  engine: 'maia3', elo: 1500, cpBudget: 100, hardFloorCp: 1000, maia3Temp: 1,
  timingMode: 'complexity', cplxBaseMode: 'clock', behavBlink: true, fixedDelayMs: 2000,
  premoveEnabled: false, pressureOffA: true, pressureOffB: true,
  lichessMatchRating: true, lichessMatchOffset: 0, lichessCommands: ['think', 'temp', 'degrade'],
};

const parse = (ctx, s) => {
  const c = ctx._lbParseCommand(s);
  return c && JSON.parse(JSON.stringify(c));
};

test('think: seconds, auto and mirror', () => {
  const c = makeCtx();
  assert.deepStrictEqual(parse(c, 'think 15 s'), { think: 15 });
  assert.deepStrictEqual(parse(c, 'think auto'), { think: 'auto' });
  assert.deepStrictEqual(parse(c, 'Think Mirror'), { think: 'mirror' });
  assert.deepStrictEqual(parse(c, '"think mirror"'), { think: 'mirror' });
  assert.strictEqual(parse(c, 'think mirrors please'), null);
});

test('degrade on / off / auto, alone or with the rest', () => {
  const c = makeCtx();
  assert.deepStrictEqual(parse(c, 'degrade on'), { degrade: 'on' });
  assert.deepStrictEqual(parse(c, 'Degrade OFF'), { degrade: 'off' });
  assert.deepStrictEqual(parse(c, 'degrade auto'), { degrade: 'auto' });
  assert.strictEqual(parse(c, 'degrade'), null);
  assert.strictEqual(parse(c, 'degrade maybe'), null);
  assert.deepStrictEqual(parse(c, 'ELO1800 temp0 think mirror degrade on'),
    { elo: 1800, temp: 0, think: 'mirror', degrade: 'on' });
  assert.strictEqual(parse(c, 'degrade on degrade off'), null, 'one of each per line');
});

test('the commands a bot takes: its own list, or cp, think and temp for a bot saved before there was one', () => {
  const c = makeCtx();
  c.window._lastAppliedBotConfig = { lichessMatchRating: true };
  assert.deepStrictEqual([...c._lbCommands()], ['cp', 'think', 'temp']);
  c.window._lastAppliedBotConfig = { lichessMatchRating: true, lichessCommands: ['degrade', 'bogus', 'think', 'temp'] };
  assert.deepStrictEqual([...c._lbCommands()], ['think', 'temp', 'degrade'], 'known names only, in their own order');
  c.window._lastAppliedBotConfig = { lichessMatchRating: true, lichessCommands: [] };
  assert.deepStrictEqual([...c._lbCommands()], [], 'an empty list: the rating only');
  assert.strictEqual(vm.runInContext("_lbOffers('cp')", c), false);
});

test('botWeighsMoves: only a personality that scores moves', () => {
  const c = makeCtx();
  assert.strictEqual(c.botWeighsMoves(), false, 'nothing set');
  c.window._bcpAttractorValues = { pressure: 3, hustle: -2, luck: 1, compwin: 2, tension: 0 };
  assert.strictEqual(c.botWeighsMoves(), false, 'the four traits that never score a move');
  c.window._bcpAttractorValues = { tension: 2 };
  assert.strictEqual(c.botWeighsMoves(), true, 'a trait that scores moves');
  c.window._bcpAttractorValues = {};
  c.window._bcpPieceValues = { knight: 1 };
  assert.strictEqual(c.botWeighsMoves(), true, 'a piece value');
  c.window._bcpPieceValues = {};
  c.window._bcpCustomControls = [{ value: 0 }, { value: 2 }];
  assert.strictEqual(c.botWeighsMoves(), true, 'a custom control');
  c.window._bcpCustomControls = [];
  c.botBlindConviction = true;
  assert.strictEqual(c.botWeighsMoves(), true, 'Blind Conviction');
});

test('Maia\'s temperature from the chat: 0 is her top move, 1 her own odds, on every Maia path', () => {
  const c = makeCtx();
  c.botMaiaTempValue = 1.3;
  assert.strictEqual(c.botMaiaBaseTemp(), 1.3, 'as built');
  c.botChatMaiaTemp = 2.5;
  assert.strictEqual(c.botMaiaBaseTemp(), 2.5, 'the chat\'s comes first');
  c.window._bcpHustlerTempMode = true;
  assert.strictEqual(c.botMaiaBaseTemp(), 2.5, 'ahead of the Hustler\'s phases too');
  c.window._bcpHustlerTempMode = false;
  c.botChatMaiaTemp = 0;
  const probs = { e2e4: 0.2, d2d4: 0.5, g1f3: 0.3 };
  for (let i = 0; i < 50; i++) assert.strictEqual(c.pickFromProbs(probs, 1), 'd2d4', 'temp 0 plays the top move every time');
  c.botChatMaiaTemp = null;
  assert.strictEqual(c.botMaiaBaseTemp(), 1.3, 'none: the bot\'s own again');
});

test('temp is Maia\'s temperature only on a Maia bot without a personality', () => {
  const c = makeCtx();
  c.window._lastAppliedBotConfig = M3;
  const isMaia = () => vm.runInContext('_lbTempIsMaia()', c);
  assert.strictEqual(isMaia(), true);
  c.window._bcpPieceValues = { knight: 1 };
  assert.strictEqual(isMaia(), false, 'a personality: Temp\'s blend');
  c.window._bcpPieceValues = {};
  c.botTab = 'sf';
  assert.strictEqual(isMaia(), false, 'Flounder: its own blend');
});

test('think: blink goes with the bot\'s own timing only', () => {
  const c = makeCtx();
  c.window._lastAppliedBotConfig = M3;
  const opp = { id: 'someone' };
  const run = choice => {
    vm.runInContext(choice == null ? 'lbThinkChoices.clear()' : 'lbThinkChoices.set("someone", ' + JSON.stringify(choice) + ')', c);
    const ch = c._lbApplyThinkChoice(opp);
    return { ch, mode: c.botTimeBehavior, ms: c.botFixedDelayMs, blink: c.botBehavBlink };
  };
  assert.deepStrictEqual(run(null), { ch: undefined, mode: 'complexity', ms: 2000, blink: true }, 'as built: Complexity, with blink');
  assert.deepStrictEqual(run(5), { ch: 5, mode: 'fixed', ms: 5000, blink: false }, 'a fixed time: exactly that, no blink');
  assert.deepStrictEqual(run('mirror'), { ch: 'mirror', mode: 'mirror', ms: 2000, blink: false }, 'mirror: their pace, no blink');
  assert.deepStrictEqual(run(null), { ch: undefined, mode: 'complexity', ms: 2000, blink: true }, 'and back');
  // A bot that doesn't take think ignores a choice left from before.
  c.window._lastAppliedBotConfig = Object.assign({}, M3, { lichessCommands: ['temp'] });
  assert.deepStrictEqual(run(5), { ch: undefined, mode: 'complexity', ms: 2000, blink: true });
});

test('degrade: Curve A only, as built unless the opponent asked, and only for a bot that takes it', () => {
  const c = makeCtx();
  const want = (cfg, choice) => {
    c.window._lastAppliedBotConfig = cfg;
    vm.runInContext(choice == null ? 'lbDegradeChoices.clear()' : 'lbDegradeChoices.set("someone", ' + choice + ')', c);
    return c._lbCurveAWanted({ id: 'someone' });
  };
  assert.strictEqual(want(M3, null), false, 'M3 is built with it off');
  assert.strictEqual(want(M3, true), true, 'degrade on');
  const builtOn = Object.assign({}, M3, { pressureOffA: false, ctrlA: [{ x: 200, y: 1500 }, { x: 1, y: 1300 }] });
  assert.strictEqual(want(builtOn, null), true, 'a bot built with Curve A on');
  assert.strictEqual(want(builtOn, false), false, 'degrade off');
  const noDegrade = Object.assign({}, builtOn, { lichessCommands: ['think', 'temp'] });
  assert.strictEqual(want(noDegrade, false), true, 'a bot that doesn\'t take degrade keeps its own');
});

// The greeting, as Ben worded it (Nov 20). Spectators get the first line.
const greet = (c, cfg, at) => {
  c.window._lastAppliedBotConfig = cfg;
  return [...c._lbGreetLines(at)];
};

test('Blundermind-M3\'s greeting: what it is set to, what can be typed, and what temp does', () => {
  const c = makeCtx();
  const lines = greet(c, M3, { setting: 1500, cp: 100, est: 1500, edge: null });
  assert.deepStrictEqual(lines, [
    'ELO set to 1,500 (using Maia 1500), think auto, temp 1, degrade off',
    'Type in chat to change strength (ELO), Move timing (think), Maia temperature (temp), time-pressure degradation (degrade).',
    "ELO 600-2600, think 0-60s or auto or mirror, degrade on/off, temp 0-4: 0 = Maia's top move, 1 = matches Maia's odds, 4 = wild",
  ]);
  for (const l of lines) assert.ok(l.length <= 140, l.length + ': ' + l);
});

test('M3\'s state line says what runs: degrade is off with a fixed time, whatever was asked', () => {
  const c = makeCtx();
  c.window._lastAppliedBotConfig = M3;
  const at = { setting: 1800, cp: 100, est: 1800, edge: null, think: 'mirror', temp: 0 };
  c.botPressureCurveA = [{ x: 200, y: 1800 }, { x: 1, y: 1600 }];
  c.botTimeBehavior = 'mirror';
  assert.strictEqual(c._lbStateLine(at), 'ELO set to 1,800 (using Maia 1800), think mirror, temp 0, degrade on');
  c.botTimeBehavior = 'fixed';
  assert.strictEqual(c._lbStateLine(Object.assign({}, at, { think: 5 })),
    'ELO set to 1,800 (using Maia 1800), think 5s, temp 0, degrade off');
});

test('a bot saved before the command list greets as it did, with mirror beside think', () => {
  const c = makeCtx();
  c.botBlindConviction = true;
  const cfg = { engine: 'maia3', elo: 2000, cpBudget: 150, lichessMatchRating: true };
  assert.deepStrictEqual(greet(c, cfg, { setting: 2000, cp: 150, est: 2000, edge: null }), [
    'ELO set to 2,000 (using Maia 2000), CP budget 150, think auto, temp 10',
    'Type in chat to change strength (ELO), centipawn budget (cp), Move timing (think), Maia temperature (temp).',
    "ELO 600-2600, cp 0-300, think 0-60s or auto or mirror, Temp 0 (Maia's top move) - 10 (personality driven)",
  ]);
});

test('every greeting fits Lichess\'s 140-character chat line, whatever the bot takes', () => {
  const c = makeCtx();
  const names = ['cp', 'think', 'temp', 'degrade'];
  const kinds = [
    { botTab: 'maia3', personality: false },
    { botTab: 'maia3', personality: true },
    { botTab: 'sf', personality: true },
  ];
  const long = { setting: 2400, cp: 300, est: 2775, edge: 'high', think: 15.5, temp: 9.9 };
  let seen = 0;
  for (let mask = 0; mask < 16; mask++) {
    const cmds = names.filter((_, i) => mask & (1 << i));
    for (const k of kinds) {
      c.botTab = k.botTab;
      c.window._bcpPieceValues = k.personality ? { knight: 1 } : {};
      c.botPressureCurveA = [{ x: 1, y: 600 }, { x: 200, y: 2400 }];
      const cfg = { engine: k.botTab, elo: 2400, cpBudget: 300, lichessMatchRating: true, lichessCommands: cmds,
        lichessStrength: [[600, 600, 300], [600, 850], [2600, 2025], [2600, 2775, 50]] };
      for (const l of greet(c, cfg, long)) { seen++; assert.ok(l.length <= 140, l.length + ': ' + l); }
    }
  }
  assert.ok(seen > 100);
});

// The name on the board during a game: the engine and the rating it plays at,
// with "Custom" in front when a personality is active, or the preset's own name
// when one is selected. Built through the real builder and handed to the app the
// way Start does it, because the first bug here lived in that handoff: a book
// snaps its rating down to a Lichess band, and the name reported the band instead
// of the engine's rating.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-bot-name.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => {
  try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach((k) => localStorage.setItem(k, '1')); } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.accept(); });
await page.goto(BASE + '/blundermind.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const panel = page.frames().find((f) => /bot-control-panel/.test(f.url()));
await panel.waitForFunction(() => typeof getBotConfig === 'function' && typeof setElo === 'function');

// Set the engine up, hand the config over, read back what the app now believes.
// selEngineMode, not the card's click: the popup it opens is verify-maia-gate's.
async function build({ engine, elo, book, bookRating } = {}) {
  const cfg = await panel.evaluate(({ engine, elo, book, bookRating }) => {
    if (engine) {
      selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="' + engine + '"]'));
      setElo(elo);
      setEngineBook(book ? 'on' : 'off');
    }
    // The book's rating is pinned to the engine's by default, so giving it a
    // rating of its own means unpinning first, as the pin button does. Pin it
    // back afterwards: the next scenario expects the default.
    if (bookRating != null) {
      if (bookEloLinked) toggleBookEloPin();
      const el = document.getElementById('book-elo');
      el.value = bookRating;
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    }
    const c = getBotConfig();
    if (bookRating != null) toggleBookEloPin();
    return c;
  }, { engine, elo, book, bookRating });
  const app = await page.evaluate((c) => {
    botApplyPanelConfig(c, true);
    botUpdatePlayerNames('white');
    return {
      sent: { engine: c.engine, elo: c.elo, book: c.lcMaiaLcElo, maia: c.lcMaiaMaiaElo },
      name: botGenerateName(),
      board: document.querySelector('#playerBoxB .player-name').textContent,
      maiaPlaysAt: maia3SelectedRating,
      bookBand: lcRatingParam(lcSelectedRating),
      readout: _quickBotPersonaInfo().has,
    };
  }, cfg);
  app.pill = await panel.evaluate(() => { updateQsPersonality(); return document.getElementById('qs-pers-value').textContent; });
  return app;
}

const clearPersonality = () => panel.evaluate(() => {
  selectedPersonality = null;
  document.querySelectorAll('.pcard').forEach((c) => c.classList.remove('sel'));
  ATTRACTORS.forEach((a) => {
    attractorValues[a.id] = 0;
    const s = document.getElementById('attr-' + a.id);
    if (s) s.value = 0;
  });
  PIECE_TYPES.forEach((p) => {
    pieceValues[p.id] = 0;
    const s = document.getElementById('piece-' + p.id);
    if (s) s.value = 0;
  });
  customControls = [];
  renderCustomControls();
  updateAttrCpDisplays();
  updateQsPersonality();
});

// The name, the readout under the picker and the builder's pill must tell one story.
const agree = (r, custom, label) => {
  ok(r.readout === custom, label + ': the readout under the picker agrees', r);
  ok(custom ? r.pill !== 'None' : r.pill === 'None', label + ': the Personality pill agrees', r.pill);
};

console.log('Maia 1950 with a Lichess book at 1950 (the first report):');
let r = await build({ engine: 'maia3', elo: 1950, book: true });
console.log('    ', JSON.stringify(r));
ok(r.sent.engine === 'lcmaia' && r.sent.maia === 1950 && r.sent.book === 1950, 'the builder sends what was set', r.sent);
ok(r.maiaPlaysAt === 1950, 'Maia plays at 1950', r.maiaPlaysAt);
ok(r.bookBand === '1800', 'the book asks the 1800 band, the one holding 1950', r.bookBand);
ok(r.name === 'Maia 1950', 'the name is exactly Maia 1950', r.name);
ok(/^Maia 1950 ‹/.test(r.board), 'the board shows it, with the engine tag', r.board);
agree(r, false, 'no personality');

console.log('book rating unpinned from the engine:');
r = await build({ engine: 'maia3', elo: 1950, book: true, bookRating: 2300 });
ok(r.sent.book === 2300 && r.sent.maia === 1950, 'the two ratings really are apart', r.sent);
ok(r.bookBand === '2200,2500', 'the book asks its own band', r.bookBand);
ok(r.maiaPlaysAt === 1950, 'Maia still plays at 1950', r.maiaPlaysAt);
ok(r.name === 'Maia 1950', 'the name follows the engine, not the book', r.name);

console.log('no personality, every engine:');
const plainCases = [
  [{ engine: 'maia3', elo: 1950, book: false }, 'Maia 1950'],
  [{ engine: 'stockfish', elo: 1650, book: false }, 'Flounder 1650'],
  [{ engine: 'stockfish', elo: 1650, book: true }, 'Flounder 1650'],
  [{ engine: 'hybrid', elo: 1650, book: false }, 'Hybrid Bot'],
];
for (const [setup, want] of plainCases) {
  r = await build(setup);
  ok(r.name === want, want + (setup.book ? ' (with a book)' : ''), r.name);
}

console.log('the temperament word is gone:');
await build({ engine: 'maia3', elo: 1950, book: false });
for (const [v, label] of [[0, 'middle'], [5, 'fully Panicky'], [-5, 'fully Calm']]) {
  await panel.evaluate((x) => onCalmPanickyChange(x), v);
  r = await build();
  ok(!/Normal|Steady|Calm|Panicky/.test(r.name), label + ' adds no word', r.name);
  ok(r.name === (v === 0 ? 'Maia 1950' : 'Custom Maia 1950'), label + ' reads ' + (v === 0 ? 'plain' : 'Custom') + ', like any other slider', r.name);
  agree(r, v !== 0, label);
}
await clearPersonality();

console.log('each kind of personality control turns on Custom:');
const controls = [
  ['a Strategic slider', () => attrSetValue('attr-complexity', 3)],
  ['a Piece slider', () => attrSetValue('piece-knight', 2)],
  ['Bad Day, which has no slider of its own', () => onAttractorChange('luck', 3)],
  ['a Custom control set off 0', () => {
    customControls = [{ id: 'ccT', name: 'T', metric: CUSTOM_METRICS[0].id, phase: 'all', result: 'any', pressure: 'any', value: 2 }];
    renderCustomControls();
  }],
];
for (const [label, fn] of controls) {
  await panel.evaluate(fn);
  r = await build();
  ok(r.name === 'Custom Maia 1950', label, r.name);
  agree(r, true, label);
  await clearPersonality();
  r = await build();
  ok(r.name === 'Maia 1950', '...and back to plain once cleared', r.name);
}
await panel.evaluate(() => {
  customControls = [{ id: 'ccT', name: 'T', metric: CUSTOM_METRICS[0].id, phase: 'all', result: 'any', pressure: 'any', value: 0 }];
  renderCustomControls();
});
r = await build();
ok(r.name === 'Maia 1950', 'a Custom control left at 0 does nothing, so it is not Custom', r.name);
agree(r, false, 'a Custom control at 0');
await clearPersonality();

console.log('Custom on every engine:');
await panel.evaluate(() => attrSetValue('attr-complexity', 3));
const customCases = [
  [{ engine: 'maia3', elo: 1950, book: true }, 'Custom Maia 1950'],
  [{ engine: 'stockfish', elo: 1650, book: false }, 'Custom Flounder 1650'],
  [{ engine: 'stockfish', elo: 1650, book: true }, 'Custom Flounder 1650'],
  [{ engine: 'hybrid', elo: 1650, book: false }, 'Custom Hybrid Bot'],
];
for (const [setup, want] of customCases) {
  r = await build(setup);
  ok(r.name === want, want + (setup.book ? ' (with a book)' : ''), r.name);
}
await clearPersonality();

console.log('the rest of the Personality section is not "personality" here (the pill says None for these too):');
await build({ engine: 'maia3', elo: 1950, book: false });
const notCustom = [
  ['the CP Budget', () => onGaugeSliderInput(300)],
  ['Conviction', () => onConvictionSlider(100)],
  ['the Hard Floor', () => onHardFloorSliderInput(500)],
  ['the Move Distribution Range', () => { document.getElementById('day-lower').value = 10; onDaySlider(); }],
];
for (const [label, fn] of notCustom) {
  await panel.evaluate(fn);
  r = await build();
  ok(r.name === 'Maia 1950', label + ' alone stays plain', r.name);
  agree(r, false, label);
}

const pickPreset = async (id, engine = 'maia3') => {
  await clearPersonality();
  await panel.evaluate(({ id, engine }) => {
    selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="' + engine + '"]'));
    _applyPersonality(id, true);
  }, { id, engine });
  await panel.waitForTimeout(50);
};

console.log('every preset goes by its own name:');
const presets = await panel.evaluate(() => PERSONALITIES.map((p) => ({ id: p.id, name: p.name })));
ok(presets.length === 13, 'all 13 of them', presets.length);
for (const { id, name } of presets) {
  await pickPreset(id);
  r = await build();
  ok(r.name === name, id + ' reads ' + name, r.name);
  ok(r.board.startsWith(name + ' ‹'), '...on the board, with the engine tag', r.board);
  ok(r.pill === name, '...and the Personality pill says the same', r.pill);
  ok(r.readout === true, '...and the readout under the picker knows it has one', r);
}

console.log('on every engine, and whatever the rating:');
for (const [engine, elo, book, tag] of [
  ['maia3', 1950, true, '‹LC+Maia›'],
  ['stockfish', 1650, false, '‹Flounder›'],
  ['stockfish', 1650, true, '‹Book+Flounder›'],
  ['hybrid', 1650, false, '‹Hybrid›'],
]) {
  await pickPreset('entropy', engine);
  r = await build({ engine, elo, book });
  ok(r.board === 'Captain Entropy ' + tag, engine + (book ? ' with a book' : '') + ' reads ' + r.board, r);
}
await pickPreset('entropy');
// The picker's list of Maia ratings needs the model, which this browser lacks.
const picked = await page.evaluate(() => {
  const was = [_maiaStatus, _maiaReady];
  _maiaStatus = 'ready'; _maiaReady = true;
  quickBotPick('maia:1000');
  const atListed = document.getElementById('quickBotSel').value;
  const got = { name: botGenerateName(), rating: maia3SelectedRating, atListed };
  maia3SetRating(1950);
  quickBotSync();
  const sel = document.getElementById('quickBotSel');
  got.offList = sel.value;
  got.offListLabel = sel.options[sel.selectedIndex].textContent;
  [_maiaStatus, _maiaReady] = was;
  quickBotSync();
  return got;
});
ok(picked.rating === 1000 && picked.name === 'Captain Entropy', 'a pick on the board changes the rating and keeps the name', picked);
ok(picked.atListed === 'maia:1000', 'the picker still shows the rating it was just given', picked);
ok(picked.offList === '__current' && picked.offListLabel === 'Captain Entropy', 'at a rating it does not list, it names the bot', picked);

console.log('the name lasts only while the preset is selected:');
await pickPreset('entropy');
await panel.evaluate(() => setElo(1950));
r = await build();
ok(r.name === 'Captain Entropy', 'selected', r.name);
await panel.evaluate(() => attrSetValue('attr-complexity', 1));
r = await build();
ok(r.name === 'Custom Maia 1950', 'moving a Strategic slider deselects it', r.name);
ok(r.pill === 'Custom', '...as the pill says', r.pill);
await pickPreset('entropy');
await panel.evaluate(() => onAttractorChange('luck', 3));
r = await build();
ok(r.name === 'Custom Maia 1950', 'so does the Bad Day radar axis', r.name);
await pickPreset('entropy');
await panel.evaluate(() => {
  customControls = [{ id: 'ccT', name: 'T', metric: CUSTOM_METRICS[0].id, phase: 'all', result: 'any', pressure: 'any', value: 2 }];
  renderCustomControls();
  _ccDirty();
});
r = await build();
ok(r.name === 'Custom Maia 1950', 'so does editing a Custom control', r.name);
await pickPreset('entropy');
await panel.evaluate(() => attrSetValue('piece-knight', 2));
r = await build();
ok(r.pill === 'Captain Entropy' && r.name === 'Captain Entropy', 'a Piece slider leaves the preset selected, and the name follows the pill', r);
await pickPreset('entropy');
await panel.evaluate(() => onGaugeSliderInput(300));
r = await build();
ok(r.name === 'Captain Entropy', 'so does the CP Budget', r.name);
await clearPersonality();
r = await build();
ok(r.name === 'Maia 1950', 'cleared, the next bot is not called by the old name', r.name);

console.log('a loaded bot is not its preset:');
await pickPreset('entropy');
await panel.evaluate(() => setElo(1950));
const store = await panel.evaluate(() => {
  const s = _loadBotStore();
  s['My Entropy'] = { savedAt: Date.now(), config: getBotConfig() };
  _saveBotStore(s);
  loadSavedBot('My Entropy');
  return { pill: (updateQsPersonality(), document.getElementById('qs-pers-value').textContent) };
});
r = await build();
ok(store.pill === 'My Entropy', 'the pill has its saved name', store.pill);
ok(r.name === 'Custom Maia 1950', 'the board does not call it Captain Entropy', r.name);
await panel.evaluate(() => {
  const s = _loadBotStore();
  delete s['My Entropy'];
  _saveBotStore(s);
  _activeBotName = null;
});
await clearPersonality();

console.log('a bot saved before presets had names here:');
const older = await page.evaluate(() => {
  const c = Object.assign({}, window._lastAppliedBotConfig, { personalityId: 'entropy', attractorValues: { complexity: 4 } });
  delete c.personalityName;
  botApplyPanelConfig(c, true);
  return botGenerateName();
});
ok(/^Custom /.test(older), 'still reads Custom, which is still true', older);
await clearPersonality();
r = await build();

console.log('the preset name survives the other routes back to a bot:');
await pickPreset('entropy');
await panel.evaluate(() => setElo(1950));
await build();
const carried = await page.evaluate(() => {
  const snap = JSON.parse(JSON.stringify(botCollectConfig('session', '')));
  window._bcpPresetName = '';
  const cleared = botGenerateName();
  botApplyConfig(snap);
  const back = botGenerateName();
  // Puzzles borrow the bot as a plain engine, then hand it back.
  const s = pzSaveBot();
  pzApplyBot({ solver: 'w' });
  const during = botGenerateName();
  pzRestoreBot(s);
  return { cleared, back, during, after: botGenerateName() };
});
ok(carried.back === 'Captain Entropy', 'a saved session snapshot brings it back', carried);
ok(!/Captain/.test(carried.during) && carried.after === 'Captain Entropy', 'a puzzle takes it away and returns it', carried);
await page.evaluate(() => bmLastBotSave());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const afterReload = await page.evaluate(() => botGenerateName());
ok(afterReload === 'Captain Entropy', 'a reload, as the last bot played, keeps it', afterReload);
const panel2 = page.frames().find((f) => /bot-control-panel/.test(f.url()));
await panel2.waitForFunction(() => typeof getBotConfig === 'function');
await panel2.waitForFunction(() => selectedPersonality === 'entropy', null, { timeout: 5000 });
const reCfg = await panel2.evaluate(() => getBotConfig().personalityName);
ok(reCfg === 'Captain Entropy', 'and the builder, shown the same bot, sends the same name', reCfg);
await page.evaluate(() => localStorage.removeItem('bm_lastBot'));

console.log('a name the user typed:');
const typed = await page.evaluate(() => {
  const el = document.getElementById('botNameInput');
  const was = el.value;
  el.value = 'Café Entropy';
  const n = botGenerateName();
  el.value = was;
  return n;
});
ok(typed === 'Café Entropy', 'wins over a preset too', typed);
await panel2.evaluate(() => {
  selectedPersonality = null;
  ATTRACTORS.forEach((a) => { attractorValues[a.id] = 0; });
  attractorValues.complexity = 3;
});
const typedCustom = await page.evaluate(async () => {
  const frame = document.getElementById('botModalFrame').contentWindow;
  botApplyPanelConfig(frame.getBotConfig(), true);
  const el = document.getElementById('botNameInput');
  const was = el.value;
  el.value = 'Café Entropy';
  const n = botGenerateName();
  el.value = was;
  return { typed: n, plain: botGenerateName() };
});
ok(typedCustom.typed === 'Café Entropy', '...and over Custom', typedCustom);
ok(/^Custom /.test(typedCustom.plain), 'and the generated name returns once it is cleared', typedCustom);

ok(errors.length === 0, 'no page errors or native dialogs', errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

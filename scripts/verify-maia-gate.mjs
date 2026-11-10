// A bot with no Maia: picking Flounder says what that costs, the greyed premove
// row explains itself, and nothing keeps saying "Premoves on" for a bot that can
// never premove.
// Real mouse clicks wherever where the click lands is the point: the premove
// switch is `inert` while greyed, and the popup has to sit over an open picker.
// Needs the server running on :3100 (PORT=3100 node server.js). From repo root:
//   node scripts/verify-maia-gate.mjs
// Set SHOT_DIR to keep screenshots of the popup.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.accept(); });
};
const shot = (page, name) =>
  process.env.SHOT_DIR ? page.screenshot({ path: process.env.SHOT_DIR + '/' + name + '.png' }) : null;

async function open(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach((k) => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
  // Stand in for the app's "model is ready" push: the panel alone has no model,
  // which greys premove for a different reason.
  await page.evaluate(() => { bcpMaiaSetStatus('ready', true); qsOpenSection('timing'); });
  await page.waitForTimeout(500);
  return page;
}

const state = (page) => page.evaluate(() => {
  const cb = document.getElementById('cb-premove');
  const st = document.getElementById('st-timing');
  const ov = document.getElementById('mg-overlay');
  return {
    checked: cb.checked,
    greyed: document.getElementById('premove-row').classList.contains('inert'),
    header: st.textContent,
    warn: st.classList.contains('st-warn'),
    sub: document.getElementById('premove-sub').style.display !== 'none',
    cfg: getBotConfig().premoveEnabled,
    stored: localStorage.getItem('bm_premoveOn'),
    popup: ov.classList.contains('open'),
    title: document.getElementById('mg-title').textContent,
    msg: document.getElementById('mg-body').textContent,
    items: [...document.querySelectorAll('#mg-body li strong')].map((x) => x.textContent),
    elo: currentElo,
  };
});
// What the controls themselves are showing, to hold the list up against.
const gates = (page) => page.evaluate(() => ({
  range: document.getElementById('move-quality-range').style.visibility === 'hidden',
  badDay: !!_radarAxisWhy('luck'),
  conviction: document.getElementById('conviction-row').classList.contains('inert'),
  floor: document.getElementById('hard-floor-row').classList.contains('inert'),
}));

// The user's pick, leaving any popup it opened on screen.
const pick = (page, id) => page.evaluate((e) => {
  selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="' + e + '"]'));
}, id).then(() => page.waitForTimeout(150));
const dismiss = (page) => page.evaluate(() => mgClose());
// A pick as a step on the way to something else.
const engine = async (page, id) => {
  await pick(page, id);
  await dismiss(page);
  await page.evaluate(() => qsOpenSection('timing'));
  await page.waitForTimeout(250);
};
const clickSwitch = async (page) => {
  await page.locator('#premove-row').scrollIntoViewIfNeeded();
  const b = await page.locator('#premove-row label.tog').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(120);
};
const clickLabel = async (page) => {
  await page.locator('#premove-row').scrollIntoViewIfNeeded();
  const b = await page.locator('#premove-row .tog-lbl').boundingBox();
  await page.mouse.click(b.x + 10, b.y + b.height / 2);
  await page.waitForTimeout(120);
};

const ALL = ['Premove', 'Move Distribution Range', 'Bad Day', 'Conviction', 'Hard Floor'];

console.log('Maia to Flounder, on the engine card:');
{
  const page = await open();
  await page.evaluate(() => qsOpenSection('engine'));
  await page.waitForTimeout(500);
  const card = page.locator('#engine-mode-grid .mcard[data-engine="stockfish"]');
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForTimeout(200);
  const s = await state(page);
  ok(s.popup, 'a real click on Flounder opens the popup');
  ok(s.title === 'Not available without Maia', 'its title', s.title);
  ok(same(s.items, ALL), 'it lists all five', s.items);
  const g = await gates(page);
  ok(g.range && g.badDay && g.conviction && g.floor, 'and each of the four really did go grey', g);
  ok(/settings are kept/.test(s.msg), 'it says the settings are kept');
  ok(!/opening book/.test(s.msg) && !/stop at/.test(s.msg), 'no book or rating note when neither applies', s.msg);
  await shot(page, 'switch-desktop');
  await page.locator('#mg-overlay .tp-gate-go').click();
  ok(!(await state(page)).popup, 'OK closes it');
  await page.context().close();
}

console.log('Maia to Flounder, on the quick picker:');
{
  const page = await open();
  await page.evaluate(() => { window.scrollTo(0, 0); toggleQsDropdown('engine'); });
  await page.waitForTimeout(250);
  await page.locator('#qs-drop-engine .qsd-opt[data-eng="stockfish"]').click();
  await page.waitForTimeout(200);
  ok((await state(page)).popup, 'picking Flounder there opens it too');
  const onTop = await page.evaluate(() => {
    const b = document.querySelector('#mg-overlay .tp-gate-go');
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
  });
  ok(onTop, 'and sits on top of the open picker');
  await page.locator('#mg-overlay .tp-gate-go').click();
  await page.waitForTimeout(100);
  const s = await state(page);
  ok(!s.popup && (await page.evaluate(() => baseEngine)) === 'stockfish', 'closes, and the engine stayed Flounder');
  await page.context().close();
}

console.log('the list follows the gates:');
{
  let page = await open();
  await page.evaluate(() => setEngineBook('on'));
  await pick(page, 'stockfish');
  let s = await state(page);
  let g = await gates(page);
  ok(same(s.items, ['Premove']), 'with a book on, only Premove is lost outright', s.items);
  ok(!g.range && !g.badDay && !g.conviction && !g.floor, '...because the other four stay live', g);
  ok(/still apply to book moves/.test(s.msg), 'and it says they still reach book moves', s.msg);
  await page.context().close();

  page = await open();
  await page.evaluate(() => setBlindConviction(true));
  await pick(page, 'stockfish');
  s = await state(page);
  g = await gates(page);
  ok(same(s.items, ['Premove', 'Bad Day', 'Hard Floor']), 'Blind Conviction keeps the Range, and greyed Conviction first', s.items);
  ok(!g.range && g.conviction, '...which the controls agree with', g);
  await dismiss(page);
  await page.context().close();

  page = await open();
  await page.evaluate(() => { setBlindConviction(true); setEngineBook('on'); });
  await pick(page, 'stockfish');
  s = await state(page);
  ok(/still apply/.test(s.msg) && !/Conviction/.test(s.msg), 'Blind plus a book leaves Conviction out of the note too', s.msg);
  await page.context().close();
}

console.log('when it stays quiet:');
{
  const page = await open();
  const quiet = async (name, fn, arg) => {
    await page.evaluate(fn, arg);
    await page.waitForTimeout(150);
    const s = await state(page);
    ok(!s.popup, name, s.title);
    await dismiss(page);
  };

  await quiet('Maia to Maia', () => selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]')));
  await quiet('Maia to a Hybrid with a Maia slot', () => selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="hybrid"]')));
  await pick(page, 'stockfish');
  ok((await state(page)).popup, 'that Hybrid to Flounder does speak: Maia is lost');
  await dismiss(page);
  await quiet('Flounder to Flounder', () => selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]')));
  await quiet('Flounder to Maia', () => selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]')));
  await quiet('the board\'s quick picker pushing Flounder in', () =>
    window.postMessage({ type: 'quickPick', engine: 'stockfish', elo: 1500 }, location.origin));
  ok((await page.evaluate(() => baseEngine)) === 'stockfish', '...which did take effect');
  await page.evaluate(() => selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]')));
  const maiaCfg = await page.evaluate(() => getBotConfig());
  await quiet('loading a Flounder bot', (c) => applyBotConfig({ ...c, engine: 'stockfish' }), maiaCfg);
  await page.evaluate(() => selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="hybrid"]')));
  await page.evaluate(() => { hybridSlots.forEach((x) => { if (x.type === 'maia') x.pct = 0; }); updateHybridTotal(); });
  ok(!(await state(page)).popup, 'dragging a Maia slot to 0 (a slider, not a pick)');
  await quiet('a Hybrid with no Maia to Flounder: nothing was lost', () =>
    selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]')));
  await page.context().close();
}

console.log('the rating, the one thing that does not come back:');
{
  const page = await open();
  await page.evaluate(() => setElo(2500));
  await pick(page, 'stockfish');
  let s = await state(page);
  ok(/from 2500 to 2400/.test(s.msg), 'a 2500 bot is told it went to 2400', s.msg);
  await dismiss(page);
  await engine(page, 'maia3');
  s = await state(page);
  ok(s.elo === 2400, 'and it does stay there on the way back, as the popup says', s.elo);
  await page.context().close();
}

console.log('"their settings are kept" is true:');
{
  const page = await open();
  await clickSwitch(page);
  const read = () => page.evaluate(() => ({
    premove: document.getElementById('cb-premove').checked,
    conviction: _convictionPct(),
    floor: document.getElementById('r-hardfloor').value,
    lower: document.getElementById('day-lower').value,
    badDay: attractorValues.luck,
  }));
  await page.evaluate(() => {
    onConvictionSlider(60);
    onHardFloorSliderInput(400);
    document.getElementById('day-lower').value = 10;
    onDaySlider();
    onAttractorChange('luck', 3);
  });
  const before = await read();
  ok(before.premove && before.conviction === 60 && before.badDay === 3, 'set up on Maia', before);
  await engine(page, 'stockfish');
  await engine(page, 'maia3');
  const after = await read();
  ok(same(before, after), 'all five read the same after Flounder and back', { before, after });
  await page.context().close();
}

console.log('premove on, then Flounder:');
{
  const page = await open();
  let s = await state(page);
  ok(!s.greyed && !s.checked, 'starts live and off on Maia', s);

  await clickSwitch(page);
  s = await state(page);
  ok(s.checked && !s.popup, 'a live switch just toggles, no popup', s);
  ok(/Premoves on/.test(s.header) && s.warn, 'header says on', s.header);
  ok(s.cfg === true, 'config says on');

  await engine(page, 'stockfish');
  s = await state(page);
  ok(s.greyed, 'Flounder greys the row');
  ok(!s.checked, 'the switch reads off, not on', s);
  ok(/Premoves off/.test(s.header) && !s.warn, 'header says off', s.header);
  ok(!s.sub, 'the premove controls fold away');
  ok(s.cfg === false, 'a game started now is told off');
  ok(s.stored === '1', 'the stored preference is untouched', s.stored);

  await clickSwitch(page);
  s = await state(page);
  ok(s.popup, 'tapping the greyed switch opens the popup');
  ok(!s.checked, '...and does not turn it on');
  ok(s.title === 'Premove not available without Maia', 'with its own title, not the switch popup\'s', s.title);
  ok(s.items.length === 0, 'and no list', s.items);
  ok(/Flounder/.test(s.msg) && /switch the engine to Maia 3/.test(s.msg), 'it says why and what to do', s.msg);

  await page.locator('#mg-overlay .tp-gate-go').click();
  ok(!(await state(page)).popup, 'OK closes it');

  await clickLabel(page);
  ok((await state(page)).popup, 'the label text opens it too');
  await page.keyboard.press('Escape');
  ok(!(await state(page)).popup, 'Escape closes it');

  await clickSwitch(page);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(80);
  ok(!(await state(page)).popup, 'clicking the backdrop closes it');

  await engine(page, 'maia3');
  s = await state(page);
  ok(s.checked && !s.greyed && s.sub, 'back on Maia the "on" returns with its controls', s);
  ok(/Premoves on/.test(s.header) && s.warn, 'header says on again', s.header);
  ok(s.cfg === true, 'config says on again');
  await page.context().close();
}

console.log('premove off, then Flounder and back:');
{
  const page = await open();
  await engine(page, 'stockfish');
  await engine(page, 'maia3');
  const s = await state(page);
  ok(!s.checked && /Premoves off/.test(s.header), 'stays off: nothing was parked', s);
  await page.context().close();
}

console.log('hybrid:');
{
  const page = await open();
  await clickSwitch(page);
  await engine(page, 'hybrid');
  let s = await state(page);
  ok(s.checked && !s.greyed, 'a blend with a Maia slot keeps premove on', s);
  await clickSwitch(page);
  s = await state(page);
  ok(!s.popup && !s.checked, 'its switch is live, no popup', s);
  await clickSwitch(page);

  const setMaia = (pct) => page.evaluate((p) => {
    hybridSlots.forEach((x) => { if (x.type === 'maia') x.pct = p; });
    updateHybridTotal();
  }, pct);
  await setMaia(0);
  await page.waitForTimeout(100);
  s = await state(page);
  ok(s.greyed && !s.checked && /Premoves off/.test(s.header), 'Maia weight 0 parks it', s);
  await clickSwitch(page);
  ok((await state(page)).popup, 'and the row explains');
  await page.keyboard.press('Escape');
  await setMaia(50);
  await page.waitForTimeout(100);
  s = await state(page);
  ok(s.checked && !s.greyed && /Premoves on/.test(s.header), 'weight back brings it back', s);
  await page.context().close();
}

console.log('loading bots:');
{
  const page = await open();
  await clickSwitch(page);
  const maiaOn = await page.evaluate(() => getBotConfig());

  await page.evaluate((c) => applyBotConfig({ ...c, engine: 'stockfish', premoveEnabled: true }), maiaOn);
  await page.waitForTimeout(150);
  let s = await state(page);
  ok(!s.checked && s.greyed && /Premoves off/.test(s.header), 'a Flounder bot saved "on" loads reading off', s);
  ok(s.cfg === false, '...and is not sent to a game as on');

  await page.evaluate((c) => applyBotConfig({ ...c, engine: 'stockfish', premoveEnabled: false }), maiaOn);
  await engine(page, 'maia3');
  s = await state(page);
  ok(!s.checked, 'a bot saved "off" clears anything parked before it', s);

  await page.evaluate((c) => { applyBotConfig({ ...c, engine: 'stockfish' }); applyBotConfig(c); }, maiaOn);
  await page.waitForTimeout(150);
  s = await state(page);
  ok(s.checked && !s.greyed && /Premoves on/.test(s.header), 'a Maia bot saved "on" loads on', s);
  await page.context().close();
}

console.log('model not downloaded (Maia selected):');
{
  const page = await open();
  await clickSwitch(page);
  await page.evaluate(() => bcpMaiaSetStatus('no-cache', false));
  await page.waitForTimeout(100);
  let s = await state(page);
  ok(s.greyed && s.checked && s.cfg === true, 'greyed but the setting is kept: it works once the model arrives', s);
  await clickSwitch(page);
  s = await state(page);
  ok(s.popup && /download it in the Engine section/.test(s.msg) && !/Flounder/.test(s.msg),
     'the row gives the model reason, not the Flounder one', s.msg);
  await page.keyboard.press('Escape');
  await page.context().close();
}

console.log('reload:');
{
  const page = await open();
  await clickSwitch(page);
  await page.locator('#cb-premove').evaluate(() => {
    const c = document.getElementById('cb-premove-clock');
    c.checked = true; c.dispatchEvent(new Event('change'));
  });
  await engine(page, 'stockfish');
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => bcpMaiaSetStatus('ready', true));
  await page.waitForTimeout(300);
  const s = await state(page);
  ok(s.stored === '1', 'a reload during Flounder still remembers the preference', s);
  ok(await page.evaluate(() => document.getElementById('cb-premove-clock').checked),
     'the prefs after it in the boot order still load');
  await page.context().close();
}

console.log('phone:');
{
  const page = await open({ width: 390, height: 780 });
  await page.evaluate(() => { setElo(2500); setEngineBook('off'); });
  await pick(page, 'stockfish');
  const fit = await page.evaluate(() => {
    const m = document.querySelector('#mg-overlay .mg-modal').getBoundingClientRect();
    return { open: document.getElementById('mg-overlay').classList.contains('open'),
             inside: m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight,
             height: Math.round(m.height),
             scroll: document.documentElement.scrollWidth <= innerWidth };
  });
  ok(fit.open, 'the longest version opens');
  ok(fit.inside, 'and fits the screen', fit);
  ok(fit.scroll, 'no sideways scroll', fit);
  await shot(page, 'switch-phone');
  await page.context().close();
}

console.log('inside the app, where the panel is an iframe:');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach((k) => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE + '/blundermind.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const frame = page.frames().find((f) => /bot-control-panel/.test(f.url()));
  await frame.waitForFunction(() => typeof selEngineCard === 'function' && document.getElementById('mg-overlay'));
  const isOpen = () => frame.evaluate(() => document.getElementById('mg-overlay').classList.contains('open'));

  // The board's own picker changes engine while the builder is shut. A popup
  // here would sit waiting in the hidden iframe and greet the next visit.
  await page.evaluate(() => { quickBotPick('maia:1500', true); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { quickBotPick('1500'); });
  await page.waitForTimeout(300);
  ok((await frame.evaluate(() => baseEngine)) === 'stockfish', 'the board\'s picker moved the builder to Flounder');
  await page.evaluate(() => openBotModal());
  await page.waitForTimeout(600);
  ok(!(await isOpen()), 'and no popup was left waiting when the builder opened');

  await frame.evaluate(() => {
    selEngineMode(document.querySelector('#engine-mode-grid .mcard[data-engine="maia3"]'));
    selEngineCard(document.querySelector('#engine-mode-grid .mcard[data-engine="stockfish"]'));
  });
  await page.waitForTimeout(200);
  ok(await isOpen(), 'picking Flounder inside the builder does open it');
  await shot(page, 'switch-in-app');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors or native dialogs', errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

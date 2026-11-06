// The Preset Personalities pill + grid, and the Personality pill's popup.
// Needs the server on :3100 (or BASE), run from the repo root:
//   node scripts/verify-preset-popup.mjs [screenshot-dir]
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3100';
const SHOTS = process.argv[2] || null;
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const browser = await chromium.launch();
const errs = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  await ctx.addInitScript(() => {
    try { ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1')); } catch (e) {}
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page };
}
async function hostedBuilder(opts) {
  const { ctx, page } = await newPage(opts);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} openBotModal(); });
  const f = await (await page.waitForSelector('#botModalFrame')).contentFrame();
  await f.waitForFunction(() => typeof ppOpen === 'function' && !document.getElementById('qs-lichess-btn').hidden, null, { timeout: 15000 });
  await f.waitForTimeout(500);
  return { ctx, page, f };
}
async function standaloneBuilder(opts) {
  const { ctx, page } = await newPage(opts);
  await page.goto(BASE + '/bot-control-panel.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { ctx, page, f: page };
}
// The dim area around a popup: a corner of the builder's frame, in page coordinates.
const clickOutside = async page => {
  const b = await (await page.$('#botModalFrame')).boundingBox();
  await page.mouse.click(b.x + 5, b.y + 5);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '.png' }); };
const shown = (f, id) => f.evaluate(id => document.getElementById(id).classList.contains('show'), id);

// Moves one of the popup's sliders as a drag would.
const slide = (f, rowLabel, v) => f.evaluate(([rowLabel, v]) => {
  const row = [...document.querySelectorAll('#pers-rows .pers-row')]
    .find(r => r.querySelector('input').getAttribute('aria-label') === rowLabel);
  if (!row) throw new Error('no row ' + rowLabel);
  const inp = row.querySelector('input');
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}, [rowLabel, v]);
const rows = f => f.evaluate(() => [...document.querySelectorAll('#pers-rows .pers-row')].map(r => ({
  aria: r.querySelector('input').getAttribute('aria-label'),
  label: r.querySelector('.pers-lbl').textContent.trim(),
  value: r.querySelector('.pers-val').textContent.trim(),
  slider: +r.querySelector('input').value,
  inert: r.classList.contains('inert'),
  inputInert: r.querySelector('input').inert,
  why: r.querySelector('.inert-why')?.textContent || '',
})));
const row = async (f, aria) => (await rows(f)).find(r => r.aria === aria);
const heads = f => f.evaluate(() => [...document.querySelectorAll('#pers-rows .lbc-h')].map(h => h.textContent));
const lines = f => f.evaluate(() => [...document.querySelectorAll('#pers-rows .pers-line')].map(l => l.textContent));

console.log('\n1   The green pill, inside Blundermind');
{
  const { ctx, page, f } = await hostedBuilder();
  const look = await f.evaluate(() => {
    const css = id => { const e = document.getElementById(id), c = getComputedStyle(e), b = e.getBoundingClientRect();
      return { bg: c.backgroundColor, color: c.color, radius: c.borderRadius, font: c.fontSize, weight: c.fontWeight,
               family: c.fontFamily, h: Math.round(b.height), pad: c.padding, top: b.top, left: b.left, right: b.right, bottom: b.bottom }; };
    const r = s => document.querySelector(s).getBoundingClientRect();
    return { p: css('qs-presets-btn'), l: css('qs-lichess-btn'), bar: r('.quickstart').bottom, eng: r('#sec-engine'),
      text: document.getElementById('qs-presets-btn').textContent.trim() };
  });
  ok('it says Preset Personalities', look.text === 'Preset Personalities', look.text);
  for (const k of ['bg', 'color', 'radius', 'font', 'weight', 'family', 'h', 'pad'])
    ok('same ' + k + ' as the Lichess pill', look.p[k] === look.l[k], [look.p[k], look.l[k]]);
  ok('it is the Lichess pill\'s green', look.p.bg === 'rgb(47, 163, 90)', look.p.bg);
  ok('side by side on one row, presets first', look.p.top === look.l.top && look.p.right < look.l.left, [look.p, look.l]);
  ok('between the bar and the Engine section', look.p.top >= look.bar && look.p.bottom <= look.eng.top);
  ok('lined up with the sections\' edge', Math.abs(look.p.left - look.eng.left) <= 1, [look.p.left, look.eng.left]);
  await shot(page, 'builder-pills');

  console.log('\n2   The grid');
  await f.click('#qs-presets-btn');
  ok('the pill opens the popup', await shown(f, 'pp-overlay'));
  const grid = await f.evaluate(() => {
    const cells = [...document.querySelectorAll('#pp-grid .pp-cell')];
    const box = document.getElementById('pp-box');
    return {
      count: cells.length, want: PERSONALITIES.length,
      names: cells.every((c, i) => c.querySelector('.pp-name').textContent === PERSONALITIES[i].name),
      icons: cells.every((c, i) => c.querySelector('.pp-icon').textContent === PERSONALITIES[i].icon),
      descHidden: cells.every(c => getComputedStyle(c.querySelector('.pp-desc')).display === 'none'),
      cols: getComputedStyle(document.getElementById('pp-grid')).gridTemplateColumns.split(' ').length,
      scrolls: box.scrollHeight > box.clientHeight + 1,
      tipHidden: getComputedStyle(document.getElementById('pp-tip')).display === 'none',
      // Longest name fits inside its cell.
      fits: cells.every(c => c.scrollWidth <= c.clientWidth + 1),
    };
  });
  ok('every preset has a cell', grid.count === grid.want && grid.count === 13, grid);
  ok('each with its name and small graphic', grid.names && grid.icons, grid);
  ok('no description until asked for', grid.descHidden && grid.tipHidden, grid);
  ok('a grid, not a list', grid.cols >= 3, grid.cols);
  ok('it fits without scrolling on a desktop window', !grid.scrolls, grid);
  ok('no name overflows its cell', grid.fits, grid);
  await shot(page, 'grid');

  console.log('\n3   Hover');
  const cell = id => '#pp-grid .pp-cell[data-pid="' + id + '"]';
  await f.hover(cell('drunken'));
  const tip = await f.evaluate(() => {
    const t = document.getElementById('pp-tip'), b = t.getBoundingClientRect();
    const c = document.querySelector('#pp-grid .pp-cell[data-pid="drunken"]').getBoundingClientRect();
    return { on: getComputedStyle(t).display !== 'none', text: t.textContent,
      want: PERSONALITIES.find(p => p.id === 'drunken').desc,
      inside: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
      clear: b.top >= c.bottom || b.bottom <= c.top };
  });
  ok('hovering shows its description', tip.on && tip.text === tip.want, tip);
  ok('on screen, and not covering the name being read', tip.inside && tip.clear, tip);
  await shot(page, 'grid-hover');
  await f.hover(cell('hoarder'));
  const tip2 = await f.evaluate(() => document.getElementById('pp-tip').textContent);
  ok('moving to another cell follows', /Never sacrifices/.test(tip2), tip2);
  // Bottom row, right end: the tip must still land on screen.
  const lastCells = await f.$$('#pp-grid .pp-cell');
  await lastCells[lastCells.length - 1].hover();
  const tip3 = await f.evaluate(() => { const b = document.getElementById('pp-tip').getBoundingClientRect();
    return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
  ok('the last cell\'s tip is on screen too', tip3);
  await f.hover('#pp-title');
  ok('leaving hides it', await f.evaluate(() => getComputedStyle(document.getElementById('pp-tip')).display === 'none'));

  console.log('\n4   Choosing');
  await f.click(cell('attacky'));
  const picked = await f.evaluate(() => ({ sel: selectedPersonality, pill: document.getElementById('qs-pers-value').textContent,
    atk: attractorValues.attacker, card: document.querySelector('#persona-grid .pcard.sel')?.dataset.pid,
    tip: getComputedStyle(document.getElementById('pp-tip')).display }));
  ok('a click closes the popup', !(await shown(f, 'pp-overlay')));
  ok('and chooses it', picked.sel === 'attacky' && picked.pill === 'Attacky McTackerson' && picked.atk === 5, picked);
  ok('the section\'s own card follows', picked.card === 'attacky', picked.card);
  ok('the tooltip goes with it', picked.tip === 'none');
  await f.evaluate(() => hideConvToast());
  await f.click('#qs-presets-btn');
  const marked = await f.evaluate(() => [...document.querySelectorAll('#pp-grid .pp-cell.sel')].map(c => c.dataset.pid));
  ok('reopened, the current one is marked', marked.length === 1 && marked[0] === 'attacky', marked);
  await page.keyboard.press('Escape');
  ok('Escape closes', !(await shown(f, 'pp-overlay')));
  await f.click('#qs-presets-btn');
  await clickOutside(page);
  ok('a click outside closes', !(await shown(f, 'pp-overlay')));
  ok('without changing the choice', await f.evaluate(() => selectedPersonality === 'attacky'));
  await f.click('#qs-presets-btn');
  await f.click('#pp-box .bdbtns .preset-btn');
  ok('Close closes', !(await shown(f, 'pp-overlay')));

  console.log('\n5   A preset that changes the engine still asks');
  await f.click('#qs-presets-btn');
  await f.click(cell('badday'));
  const asks = await f.evaluate(() => ({
    grid: document.getElementById('pp-overlay').classList.contains('show'),
    confirm: document.getElementById('bdconfirm-overlay').classList.contains('show'),
    title: document.getElementById('bdconfirm-title').textContent, sel: selectedPersonality }));
  ok('the grid closes and the confirm opens', !asks.grid && asks.confirm && /Bad Day/.test(asks.title), asks);
  ok('nothing applied yet', asks.sel === 'attacky', asks.sel);
  await f.evaluate(() => _bdCancel());
  ok('cancel keeps what was there', await f.evaluate(() => selectedPersonality === 'attacky'));

  console.log('\n6   The Personality square');
  await f.click('#qs-pers-btn');
  ok('the square opens a popup', await shown(f, 'pers-overlay'));
  ok('no old picker left behind', await f.evaluate(() => !document.getElementById('qs-drop-pers')));
  let hdr = await f.evaluate(() => ({ name: document.getElementById('pers-name').textContent,
    desc: document.getElementById('pers-desc').textContent, want: PERSONALITIES.find(p => p.id === 'attacky').desc }));
  ok('names the personality and describes it', hdr.name === 'Attacky McTackerson' && hdr.desc === hdr.want, hdr);
  let rs = await rows(f);
  const wantActive = await f.evaluate(() => ATTRACTORS.filter(a => attractorValues[a.id]).length);
  ok('a slider for every active control, plus Budget, Conviction, Floor', rs.length === wantActive + 3, rs.map(r => r.label));
  ok('headed as in the section', JSON.stringify(await heads(f)) === JSON.stringify(['Move quality', 'Strategic preferences']), await heads(f));
  ok('sliders sit at the real values', (await row(f, 'Peacemaker to Attacker')).slider === 5 && (await row(f, 'Trade avoider to Trade seeker')).slider === 3, rs);
  ok('the row names the pole, strength and cp share', (await row(f, 'Peacemaker to Attacker')).label === 'Attacker'
    && /^\+5 · \d+ cp$/.test((await row(f, 'Peacemaker to Attacker')).value), await row(f, 'Peacemaker to Attacker'));
  ok('no slider for anything centred', !rs.some(r => r.aria === 'Clarity to Chaos agent'), rs.map(r => r.aria));
  ok('Conviction says 100% (a preset took it there)', (await row(f, 'Conviction')).value === '100%');
  const flounderWhy = await row(f, 'Hard Floor');
  ok('on Flounder the Floor is greyed, with the reason from the section', flounderWhy.inert && flounderWhy.inputInert && /Flounder picks each move/.test(flounderWhy.why), flounderWhy);
  await shot(page, 'personality-attacky');

  console.log('\n7   The sliders are the real controls');
  await slide(f, 'Peacemaker to Attacker', 2);
  let st = await f.evaluate(() => ({ real: +document.getElementById('attr-attacker').value, state: attractorValues.attacker,
    pill: document.getElementById('qs-pers-value').textContent, name: document.getElementById('pers-name').textContent,
    sel: selectedPersonality, desc: document.getElementById('pers-desc').textContent,
    cp: document.getElementById('attrval-attacker').textContent }));
  ok('moving one moves the section\'s slider and the bot', st.real === 2 && st.state === 2, st);
  ok('and it is no longer the preset, here and on the pill', st.sel === null && st.pill === 'Custom' && st.name === 'Custom' && st.desc === '', st);
  ok('its cp share is the section\'s figure', (await row(f, 'Peacemaker to Attacker')).value === '+2 · ' + st.cp, await row(f, 'Peacemaker to Attacker'));
  await slide(f, 'Peacemaker to Attacker', -3);
  ok('past the centre it names the other pole', (await row(f, 'Peacemaker to Attacker')).label === 'Peacemaker', await row(f, 'Peacemaker to Attacker'));
  await slide(f, 'Peacemaker to Attacker', 0);
  const zero = await row(f, 'Peacemaker to Attacker');
  ok('at 0 the row stays put and offers both poles', zero && zero.value === '—' && /Peacemaker.*Attacker/.test(zero.label), zero);
  await slide(f, 'Peacemaker to Attacker', 4);

  await slide(f, 'Budget', 300);
  st = await f.evaluate(() => ({ style: +document.getElementById('r-style').value, pill: document.getElementById('qs-cpb-value').textContent,
    floor: +document.getElementById('r-hardfloor').value }));
  ok('Budget drives the section\'s and the CP Budget pill', st.style === 300 && /300/.test(st.pill), st);
  ok('raising it past the Floor drags the Floor, and the popup shows it',
    st.floor >= 300 && (await row(f, 'Hard Floor')).slider === st.floor, [st, await row(f, 'Hard Floor')]);
  await slide(f, 'Hard Floor', 50);
  ok('the Floor will not go under the Budget', (await row(f, 'Hard Floor')).slider === 300, await row(f, 'Hard Floor'));
  await slide(f, 'Hard Floor', 1000);
  ok('the Floor at the top reads Off', (await row(f, 'Hard Floor')).value === 'Off');
  await slide(f, 'Hard Floor', 300);
  await slide(f, 'Budget', 0);
  ok('a Budget of 0 says what it does', /do nothing/.test((await row(f, 'Budget')).why), await row(f, 'Budget'));
  ok('but stays operable', !(await row(f, 'Budget')).inputInert);
  await slide(f, 'Budget', 100);
  ok('and the note clears', (await row(f, 'Budget')).why === '', await row(f, 'Budget'));
  await slide(f, 'Conviction', 40);
  st = await f.evaluate(() => [+document.getElementById('r-conviction').value, +document.getElementById('r-conviction-mirror').value]);
  ok('Conviction drives both of the section\'s sliders', st[0] === 40 && st[1] === 40, st);

  console.log('\n8   What the bot will not consult is greyed, with the section\'s reason');
  await f.evaluate(() => { persClose(); qsTimingPick('fixed'); selPersonality('hustler'); hideConvToast(); });
  await f.click('#qs-pers-btn');
  let hustle = await row(f, 'Overthinker to Coffeehouse hustler');
  const sectionWhy = await f.evaluate(() => document.querySelector('#attrg-attr-hustle .inert-why').textContent);
  ok('Hustle under Fixed interval is greyed and disabled', hustle.inert && hustle.inputInert, hustle);
  ok('with the section\'s own reason', hustle.why === sectionWhy && /Fixed interval/.test(hustle.why), [hustle.why, sectionWhy]);
  ok('it spends no Budget, and says so', /no cp$/.test(hustle.value), hustle.value);
  await shot(page, 'personality-hustler-fixed');
  await f.evaluate(() => { persClose(); qsTimingPick('complexity'); });
  await f.click('#qs-pers-btn');
  hustle = await row(f, 'Overthinker to Coffeehouse hustler');
  ok('under Complexity it is live', !hustle.inert && !hustle.inputInert && hustle.why === '', hustle);
  await f.evaluate(() => { persClose(); setBlindConviction(true); });
  await f.click('#qs-pers-btn');
  let conv = await row(f, 'Conviction');
  ok('Blind conviction greys Conviction and says why', conv.inert && conv.inputInert && /Blind conviction is on/.test(conv.why), conv);
  await f.evaluate(() => { persClose(); setBlindConviction(false); });

  console.log('\n9   Every kind of selection');
  await f.evaluate(() => {
    selPersonality('blunderer'); hideConvToast();
    attrSetValue('piece-knight', 3);
    addCustomControl();
    const c = customControls[customControls.length - 1];
    c.metric = 'passedPawns'; c.phase = 'endgame'; c.result = 'winning'; c.value = -2;
    renderCustomControls();
    // A centred custom control is not active.
    addCustomControl();
    showWeaponizer(true); document.getElementById('weaponizer-toggle').checked = true;
    syncClockMirror(false);
    document.getElementById('day-lower').value = 4; onDaySlider();
    document.getElementById('cb-draw-offer').checked = true; showDrawOffer(true);
    document.getElementById('cb-stale-seek').checked = true; showStaleSeek(true);
    document.getElementById('r-draw-margin').value = 300;
  });
  await f.click('#qs-pers-btn');
  ok('all the headings', JSON.stringify(await heads(f)) === JSON.stringify(['Move quality', 'Strategic preferences', 'Piece focus', 'Custom controls', 'Clock tactics', 'Draws & desperation']), await heads(f));
  const knight = await row(f, 'Knight');
  ok('piece focus: name, direction, value', /Knight · seeks/.test(knight.label) && /^\+3 · \d+ cp$/.test(knight.value), knight);
  rs = await rows(f);
  const cc = rs.find(r => /Passed pawns/i.test(r.aria));
  ok('custom control: direction and its gates', cc && /Avoid passers/.test(cc.label) && /Endgame/.test(cc.label) && /When winning/.test(cc.label), cc);
  ok('a centred custom control is left out', rs.filter(r => /^Custom/.test(r.aria) || r.aria === 'Passed pawns').length === 1, rs.map(r => r.aria));
  await slide(f, cc.aria, 1);
  const ccNow = await f.evaluate(() => customControls[customControls.length - 2].value);
  ok('custom slider drives the control', ccNow === 1, ccNow);
  ok('and flips its label', /Push passers/.test((await rows(f)).find(r => /Passed pawns/i.test(r.aria)).label));
  await slide(f, 'Knight', -2);
  ok('piece slider drives the section', await f.evaluate(() => +document.getElementById('piece-knight').value === -2 && pieceValues.knight === -2));
  ok('and flips its label', /avoids/.test((await row(f, 'Knight')).label));
  // Bad day has no slider of its own in the section: it is a radar axis.
  const luck = await row(f, 'Good day to Bad day');
  ok('Bad day is shown', luck && luck.label === 'Bad day' && /no cp$/.test(luck.value), luck);
  await slide(f, 'Good day to Bad day', 1);
  ok('and its slider reaches the bot', await f.evaluate(() => attractorValues.luck === 1));
  const ls = await lines(f);
  ok('the Range is left out on Flounder, as in the section', !ls.some(l => /Move Distribution Range/.test(l)), ls);
  ok('Time Weaponizer reported', ls.some(l => /^Time Weaponizer/.test(l)), ls);
  ok('clock mirroring off reported', ls.some(l => /mirroring off/.test(l)), ls);
  ok('draw acceptance off its default reported', ls.some(l => /Accepts draws unless more than 300 cp/.test(l)), ls);
  ok('draw offers reported', ls.some(l => /Offers draws when level within ±50 cp, from move 20/.test(l)), ls);
  ok('stalemate seeking reported', ls.some(l => /Seeks stalemate from move 30, when behind by 500 cp/.test(l)), ls);
  await shot(page, 'personality-everything');

  console.log('\n10  The way on, and a saved bot');
  await f.click('#pers-box .bdbtns .preset-btn:first-child');
  ok('Preset Personalities swaps popups', !(await shown(f, 'pers-overlay')) && await shown(f, 'pp-overlay'));
  await page.keyboard.press('Escape');
  await f.click('#qs-pers-btn');
  await f.click('#pers-box .bdbtns .preset-btn:nth-child(2)');
  await f.waitForTimeout(300);
  const sec = await f.evaluate(() => ({ popup: document.getElementById('pers-overlay').classList.contains('show'),
    open: document.getElementById('sec-attract').classList.contains('open'),
    tab: document.getElementById('itab-attract-pieces').classList.contains('active') }));
  ok('the panel button goes to the section\'s sliders', !sec.popup && sec.open && sec.tab, sec);
  await f.evaluate(() => { _activeBotName = 'My Gremlin'; updateQsPersonality(); });
  await f.click('#qs-pers-btn');
  hdr = await f.evaluate(() => ({ name: document.getElementById('pers-name').textContent, desc: document.getElementById('pers-desc').textContent }));
  ok('a saved bot goes by its name', hdr.name === 'My Gremlin' && hdr.desc === '', hdr);
  await clickOutside(page);
  ok('a click outside closes this one too', !(await shown(f, 'pers-overlay')));
  await ctx.close();
}

console.log('\n11  With nothing set');
{
  const { ctx, page, f } = await hostedBuilder();
  await f.click('#qs-ttime-btn');
  await f.click('#qs-pers-btn');
  ok('another pill\'s picker closes behind it', await f.evaluate(() => _openDrop === null));
  const hdr = await f.evaluate(() => ({ name: document.getElementById('pers-name').textContent, desc: document.getElementById('pers-desc').textContent }));
  ok('None, and what that means', hdr.name === 'None' && /No personality is set/.test(hdr.desc), hdr);
  ok('just the settings that still act', JSON.stringify((await rows(f)).map(r => r.aria)) === JSON.stringify(['Budget', 'Conviction', 'Hard Floor']), await rows(f));
  ok('Budget says it has nothing to spend it on', /Nothing set here spends/.test((await row(f, 'Budget')).why), await row(f, 'Budget'));
  ok('no other group', JSON.stringify(await heads(f)) === JSON.stringify(['Move quality']), await heads(f));
  await shot(page, 'personality-none');
  await f.evaluate(() => { persClose(); selPersonality('blunderer'); hideConvToast(); });
  await f.click('#qs-pers-btn');
  ok('controls that take no Budget do not count as spending it', /Nothing set here spends/.test((await row(f, 'Budget')).why), await row(f, 'Budget'));
  await ctx.close();
}

console.log('\n12  The builder on its own, outside Blundermind');
{
  const { ctx, f } = await standaloneBuilder();
  const on = await f.evaluate(() => {
    const e = id => document.getElementById(id), r = s => document.querySelector(s).getBoundingClientRect();
    return { lichess: e('qs-lichess-btn').offsetParent !== null, presets: e('qs-presets-btn').offsetParent !== null,
      left: e('qs-presets-btn').getBoundingClientRect().left, sec: r('#sec-engine').left };
  });
  ok('no Lichess pill, as before', !on.lichess, on);
  ok('Preset Personalities is still there, on the edge', on.presets && Math.abs(on.left - on.sec) <= 1, on);
  await f.click('#qs-presets-btn');
  await f.click('#pp-grid .pp-cell[data-pid="norm"]');
  ok('and works', await f.evaluate(() => selectedPersonality === 'norm' && !document.getElementById('pp-overlay').classList.contains('show')));
  await f.evaluate(() => hideConvToast());
  await f.evaluate(() => { document.getElementById('day-lower').value = 4; document.getElementById('day-upper').value = 80; onDaySlider(); });
  await f.click('#qs-pers-btn');
  let ls = await lines(f);
  ok('on Maia the Range is reported, both handles', ls.some(l => /Move Distribution Range: exclude lowest 4%, exclude moves above 80%/.test(l)), ls);
  const live = await row(f, 'Hard Floor');
  ok('and the Floor is live', !live.inert && !live.inputInert && live.why === '', live);
  await ctx.close();
}

console.log('\n13  Phone');
{
  const { ctx, page, f } = await standaloneBuilder({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pill = await f.evaluate(() => { const b = document.getElementById('qs-presets-btn').getBoundingClientRect();
    return { h: b.height, w: b.width, vw: innerWidth }; });
  ok('the pill is at a thumb\'s height, across the column', pill.h >= 36 && pill.w > pill.vw - 40, pill);
  await f.tap('#qs-presets-btn');
  const list = await f.evaluate(() => {
    const box = document.getElementById('pp-box');
    const cells = [...document.querySelectorAll('#pp-grid .pp-cell')];
    return {
      descs: cells.every(c => { const d = c.querySelector('.pp-desc'); return getComputedStyle(d).display !== 'none' && d.textContent.length > 0; }),
      over: box.scrollWidth > box.clientWidth + 1,
      tall: cells.every(c => c.getBoundingClientRect().height >= 44),
      small: [...box.querySelectorAll('.pp-name,.pp-desc,.bdtitle,.preset-btn')].filter(e => parseFloat(getComputedStyle(e).fontSize) < 11).map(e => e.className),
      inView: box.getBoundingClientRect().bottom <= innerHeight && box.getBoundingClientRect().top >= 0,
    };
  });
  ok('no hover here, so the descriptions are on the rows', list.descs, list);
  ok('no sideways scroll', !list.over, list);
  ok('type holds the phone floor', list.small.length === 0, list.small);
  ok('rows a finger can hit', list.tall, list);
  ok('the popup is on screen', list.inView, list);
  await shot(page, 'phone-grid');
  await f.tap('#pp-grid .pp-cell[data-pid="attacky"]');
  ok('a tap chooses and closes', await f.evaluate(() => selectedPersonality === 'attacky' && !document.getElementById('pp-overlay').classList.contains('show')));
  await f.evaluate(() => hideConvToast());
  await f.tap('#qs-pers-btn');
  const pers = await f.evaluate(() => {
    const box = document.getElementById('pers-box');
    const row = document.querySelector('#pers-rows .pers-row');
    const inp = row.querySelector('input').getBoundingClientRect(), r = row.getBoundingClientRect();
    return {
      over: box.scrollWidth > box.clientWidth + 1,
      small: [...box.querySelectorAll('.pers-lbl,.pers-val,.pers-line,.pers-desc,.lbc-h,.bdtitle,.inert-why,.preset-btn')]
        .filter(e => parseFloat(getComputedStyle(e).fontSize) < 11).map(e => e.className),
      sliderH: inp.height, fullWidth: inp.width > r.width - 4,
      btnH: [...box.querySelectorAll('.preset-btn')].map(b => b.getBoundingClientRect().height),
      inView: box.getBoundingClientRect().bottom <= innerHeight,
    };
  });
  ok('Personality popup: no sideways scroll', !pers.over, pers);
  ok('type holds the phone floor', pers.small.length === 0, pers.small);
  ok('sliders full width at thumb height', pers.sliderH >= 44 && pers.fullWidth, pers);
  ok('buttons a finger can hit', pers.btnH.every(h => h >= 44), pers.btnH);
  ok('on screen', pers.inView, pers);
  await shot(page, 'phone-personality');
  await ctx.close();
}

ok('no page errors anywhere', errs.length === 0, errs);
await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

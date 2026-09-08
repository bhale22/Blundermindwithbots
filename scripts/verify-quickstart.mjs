// Quick-start block: opponent (Stockfish levels + Maia ratings), colour, clock.
// Run with the dev server up on :3100.
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch();

async function open(w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  await page.waitForTimeout(200);
  return { ctx, page, errs };
}

console.log('\n1   The block offers all three choices');
{
  const { ctx, page, errs } = await open();
  const shape = await page.evaluate(() => ({
    opp:   !!document.getElementById('quickBotSel'),
    col:   !!document.getElementById('quickBotColor'),
    time:  !!document.getElementById('quickBotTime'),
    mirrorOpp:  !!document.getElementById('bmwBotSel'),
    mirrorCol:  !!document.getElementById('bmwBotColor'),
    mirrorTime: !!document.getElementById('bmwBotTime'),
    times: [...document.getElementById('quickBotTime').options].map(o => o.value),
    colours: [...document.getElementById('quickBotColor').options].map(o => o.value),
  }));
  ok('opponent, colour and clock are all present', shape.opp && shape.col && shape.time);
  ok('and mirrored in the welcome panel',
    shape.mirrorOpp && shape.mirrorCol && shape.mirrorTime, JSON.stringify(shape));
  ok('colour offers white, black and random',
    JSON.stringify(shape.colours) === '["random","white","black"]', JSON.stringify(shape.colours));
  ok('the clock offers untimed plus real controls',
    shape.times.includes('0+0') && shape.times.includes('5+0') &&
    shape.times.includes('10+0') && shape.times.includes('15+10'), JSON.stringify(shape.times));
  ok('and rests on untimed by default',
    await page.evaluate(() => document.getElementById('quickBotTime').value) === '0+0');
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n2   Choosing a clock actually starts a timed game');
{
  const { ctx, page, errs } = await open();
  const set = await page.evaluate(() => {
    quickBotSetTime('5+0');
    return { base: _botBaseMin, inc: _botIncSec, tc: botSelectedTC,
             custom: JSON.parse(JSON.stringify(TIME_CONTROLS.custom)),
             mirror: document.getElementById('bmwBotTime').value,
             display: (document.getElementById('tcDisplay') || {}).textContent };
  });
  ok('the builder base/increment move with it', set.base === 5 && set.inc === 0,
    JSON.stringify(set));
  ok('and it becomes the selected time control', set.tc === 'custom' && set.custom.time === 300,
    JSON.stringify(set.custom));
  ok('the welcome-panel clock mirrors it', set.mirror === '5+0', set.mirror);
  ok('the builder readout agrees', /5 min/.test(set.display || ''), set.display);

  await page.evaluate(() => { quickBotPick('1'); botSetPlayerColor('white'); quickBotStart(); });
  await page.waitForTimeout(2000);
  const live = await page.evaluate(() => ({
    control: clockControl, w: clockTimeW, b: clockTimeB, inc: clockInc, active: clockActive,
  }));
  ok('the game starts on that clock, not untimed', live.control !== 'untimed', live.control);
  ok('with five minutes a side', live.w > 280 && live.w <= 300 && live.b > 280 && live.b <= 300,
    live.w + ' / ' + live.b);
  ok('and the clock is running', live.active === true);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n3   An increment control carries its increment');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => { quickBotSetTime('15+10'); quickBotPick('1'); quickBotStart(); });
  await page.waitForTimeout(1800);
  const live = await page.evaluate(() => ({ w: clockTimeW, inc: clockInc }));
  ok('fifteen minutes on the clock', live.w > 880 && live.w <= 900, String(live.w));
  ok('and a ten second increment', live.inc === 10, String(live.inc));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n4   Colour choice reaches the game');
{
  const { ctx, page, errs } = await open();
  for (const col of ['white', 'black']) {
    await page.evaluate(c => { botSetPlayerColor(c); quickBotPick('1'); quickBotStart(); }, col);
    await page.waitForTimeout(1800);
    const got = await page.evaluate(() => ({ pref: botColorPref, actual: botPlayerColor }));
    ok('choosing ' + col + ' plays ' + col, got.actual === col, JSON.stringify(got));
    await page.evaluate(() => { try { botStop(); } catch (e) {} });
    await page.waitForTimeout(300);
  }
  const rand = await page.evaluate(() => {
    botSetPlayerColor('random');
    return { pref: botColorPref, sel: document.getElementById('quickBotColor').value };
  });
  ok('random is a real option the select holds', rand.pref === 'random' && rand.sel === 'random',
    JSON.stringify(rand));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n5   Maia is offered only when the model is here');
{
  const { ctx, page, errs } = await open();
  const cold = await page.evaluate(() => ({
    status: _maiaStatus,
    opts: [...document.getElementById('quickBotMaia').children].map(o => o.value),
    text: [...document.getElementById('quickBotMaia').children].map(o => o.textContent),
  }));
  ok('with no model, the group offers a download rather than a rating',
    cold.opts.length === 1 && cold.opts[0] === 'maia-get', JSON.stringify(cold.opts));
  ok('and says what it costs', /44 MB/.test(cold.text[0]), cold.text[0]);

  // Pretend the model arrived; the ratings must appear off the status alone.
  const warm = await page.evaluate(() => {
    _maiaStatus = 'ready'; _maiaReady = true;
    quickBotSync();
    return [...document.getElementById('quickBotMaia').children].map(o => o.value);
  });
  ok('once ready the five ratings appear',
    JSON.stringify(warm) === '["maia:600","maia:800","maia:1000","maia:1200","maia:1400"]',
    JSON.stringify(warm));
  const mirror = await page.evaluate(() =>
    [...document.getElementById('bmwBotMaia').children].map(o => o.value));
  ok('and in the welcome panel too', JSON.stringify(mirror) === JSON.stringify(warm),
    JSON.stringify(mirror));

  const busy = await page.evaluate(() => {
    _maiaStatus = 'downloading'; _maiaProgress = 42;
    quickBotSync();
    return [...document.getElementById('quickBotMaia').children].map(o => o.textContent);
  });
  ok('while downloading it reports progress in the same slot',
    busy.length === 1 && /42%/.test(busy[0]), JSON.stringify(busy));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n6   Picking a Maia rating configures Maia, at temperature 1');
{
  const { ctx, page, errs } = await open();
  const got = await page.evaluate(() => {
    _maiaStatus = 'ready'; _maiaReady = true;
    quickBotSync();
    // Dirty the config the way a builder session would.
    window._bcpAttractorValues = { chaos: 5, attacker: 4 };
    window._bcpPieceValues = { knight_move: 3 };
    botBadDayMode = true;
    botPressureCurveA = [{ x: 1, y: 600 }, { x: 60, y: 1500 }];
    botPressureCurveB = [{ x: 1, y: 5 }, { x: 60, y: 40 }];
    document.getElementById('botNameInput').value = 'Captain Entropy';
    quickBotPick('maia:1000');
    return {
      tab: botTab, rating: maia3SelectedRating,
      temp: botMaiaTempValue,
      slider: parseFloat(document.getElementById('maia3Temp').value),
      readout: document.getElementById('maia3TempVal').textContent,
      attrs: Object.keys(window._bcpAttractorValues).length,
      pieces: Object.keys(window._bcpPieceValues).length,
      badDay: botBadDayMode,
      curveA: botPressureCurveA, curveB: botPressureCurveB,
      name: document.getElementById('botNameInput').value,
    };
  });
  ok('the Maia3 engine is selected', got.tab === 'maia3', got.tab);
  ok('at the rating that was picked', got.rating === 1000, String(got.rating));
  ok('temperature is Maia own default 1.0', got.temp === 1.0, String(got.temp));
  ok('and the builder slider shows it', got.slider === 1.0 && got.readout === '1.0',
    got.slider + ' / ' + got.readout);
  ok('leftover personality attractors are cleared', got.attrs === 0 && got.pieces === 0,
    got.attrs + ' / ' + got.pieces);
  ok('the bad-day flag is cleared', got.badDay === false);
  ok('and the time-pressure curves with it',
    got.curveA === null && got.curveB === null, JSON.stringify([got.curveA, got.curveB]));
  ok('a leftover bot name does not survive', got.name === '', got.name);

  const painted = await page.evaluate(() => ({
    sel: document.getElementById('quickBotSel').value,
    mirror: document.getElementById('bmwBotSel').value,
  }));
  ok('and the picker rests on that Maia rating',
    painted.sel === 'maia:1000' && painted.mirror === 'maia:1000', JSON.stringify(painted));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n7   A stale Maia pick cannot start Stockfish under a Maia label');
{
  const { ctx, page, errs } = await open();
  const got = await page.evaluate(() => {
    _maiaStatus = 'ready'; quickBotSync();      // ratings exist
    _maiaStatus = 'no-cache';                    // ...then the model is gone
    quickBotPick('maia:1200');
    return { tab: botTab, sel: document.getElementById('quickBotSel').value };
  });
  ok('the pick is refused rather than silently downgraded', got.tab !== 'maia3', got.tab);
  ok('and the picker does not claim Maia', got.sel !== 'maia:1200', got.sel);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n8   Flounder picks still work, and are plain');
{
  const { ctx, page, errs } = await open();
  const got = await page.evaluate(() => {
    window._bcpAttractorValues = { chaos: 5 };
    botPressureCurveA = [{ x: 1, y: 600 }, { x: 60, y: 1500 }];
    quickBotPick('1400');
    return {
      tab: botTab, elo: parseInt(document.getElementById('flounderElo').value, 10),
      sel: document.getElementById('quickBotSel').value,
      attrs: Object.keys(window._bcpAttractorValues).length,
      curveA: botPressureCurveA,
      draws: [botAcceptDraws, botDrawAcceptMargin],
    };
  });
  ok('Flounder 1400 selects Flounder 1400', got.tab === 'sf' && got.elo === 1400,
    JSON.stringify(got));
  ok('the picker rests on it', got.sel === '1400', got.sel);
  ok('with no leftover attractors', got.attrs === 0, String(got.attrs));
  ok('and no leftover pressure curve floor on its rating', got.curveA === null);
  ok('casual draw behaviour is kept', got.draws[0] === true && got.draws[1] === 400,
    JSON.stringify(got.draws));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n9   A clock built in the builder is shown, not misreported');
{
  const { ctx, page, errs } = await open();
  const got = await page.evaluate(() => {
    botSetBaseMin(7); botSetIncSec(5);   // not one of the quick presets
    quickBotSync();
    const sel = document.getElementById('quickBotTime');
    return { value: sel.value, text: sel.options[sel.selectedIndex].textContent };
  });
  ok('an unlisted control gets its own entry', got.value === '__curtime', got.value);
  ok('naming the actual clock', /7 min/.test(got.text) && /5s/.test(got.text), got.text);
  const back = await page.evaluate(() => {
    quickBotSetTime('10+0');
    return { base: _botBaseMin, inc: _botIncSec,
             stale: !!document.querySelector('#quickBotTime option[value="__curtime"]') };
  });
  ok('picking a listed one takes over', back.base === 10 && back.inc === 0, JSON.stringify(back));
  ok('and the custom entry is dropped', back.stale === false);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n10  Nothing overflows the sidebar column');
{
  for (const [w, h] of [[1440, 900], [412, 915]]) {
    const { ctx, page, errs } = await open(w, h);
    await page.evaluate(() => { _maiaStatus = 'ready'; quickBotSync(); });
    const m = await page.evaluate(() => {
      const ids = ['quickBotSel', 'quickBotColor', 'quickBotTime'];
      const box = document.getElementById('quickBot').getBoundingClientRect();
      return ids.map(id => {
        const e = document.getElementById(id);
        const r = e.getBoundingClientRect();
        return { id, w: Math.round(r.width), over: r.right > box.right + 1 || r.left < box.left - 1 };
      });
    });
    ok(w + ': every select fits its block', m.every(x => !x.over), JSON.stringify(m));
    ok(w + ': the opponent select has room to name a bot',
      m[0].w >= 110, JSON.stringify(m[0]));
    ok(w + ': no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }
}

console.log('\n11  A rated Maia on a clock stays at its rating');
{
  const { ctx, page, errs } = await open();
  const got = await page.evaluate(() => {
    _maiaStatus = 'ready'; _maiaReady = true; quickBotSync();
    quickBotPick('maia:1000');
    quickBotSetTime('3+2');
    // The two engine entry points that decide how strong Maia plays this move.
    // With no pressure curve they must both hand back the rating on the label.
    const atLeisure = pressureEffectiveMaiaEloByThink(30);
    const inTrouble = pressureEffectiveMaiaEloByThink(0.4);
    return { rating: maia3SelectedRating, atLeisure, inTrouble,
             curveA: botPressureCurveA, effective: botEffectiveElo() };
  });
  ok('with time to spare it plays 1000', got.atLeisure === 1000, String(got.atLeisure));
  ok('and in time trouble it still plays 1000, not a collapsed rating',
    got.inTrouble === 1000, String(got.inTrouble));
  ok('because no leftover degradation curve is attached', got.curveA === null);
  ok('and the rating the rest of the app reads agrees',
    got.effective === 1000, String(got.effective));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

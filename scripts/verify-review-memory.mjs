// Board switch, sidebar order, ghost replies, the remembered bot, and review.
// Needs the server running on :3100 and must be run from the repo root
// (node_modules resolution):
//   node scripts/verify-review-memory.mjs
//
//   1  the board switch is in the header on both boards, and switches them
//   2  the overlay controls are one block; Board settings comes after them
//   3  ghost replies are on screen (desktop) and a panel row + chip (phone),
//      and are remembered across visits
//   4  the last bot played comes back on the next visit — a quick pick, a
//      builder config, and a quick pick on top of a builder config — and the
//      builder iframe shows the same bot
//   5  a finished game can be reviewed on a phone (it could not be at all)
//   6  a desktop review opens Maia's odds where they can be read
//   7  an Expert-board game can be reviewed on the Visualization board
//
// Sections 5-7 play a real game against Flounder 600 (one human move, then
// resign), so they need Stockfish, which loads from the CDN.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

const browser = await chromium.launch();
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';

// One context per scenario. `keep` is localStorage carried in from a previous
// visit — how "the next visit" is simulated without sharing a profile.
async function open({ width = 1440, height = 900, phone = false, shell = 'amateur', keep = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1,
    isMobile: phone, hasTouch: phone, userAgent: phone ? PHONE_UA : undefined,
  });
  await ctx.addInitScript(([shell, keep]) => {
    try {
      if (sessionStorage.getItem('__seeded')) return;   // only before the first load
      sessionStorage.setItem('__seeded', '1');
      localStorage.clear();
      if (keep) Object.keys(keep).forEach(k => localStorage.setItem(k, keep[k]));
      ['bm_bottour', 'bm_tour_pro', 'bm_tour_amateur'].forEach(k => localStorage.setItem(k, '1'));
      localStorage.setItem('bm_shell', shell);
      localStorage.setItem('bm_welcomed', '1');
      localStorage.setItem('bm_landingSeen', '1');
    } catch (e) {}
  }, [shell, keep]);
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

const storage = page => page.evaluate(() => {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
  return o;
});

// A real finished game: Flounder 600, the human as White, one move each, resign.
async function finishGame(page) {
  await page.evaluate(() => { quickBotPick('600'); botSetPlayerColor('white'); botStart(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const m = uciToSq('e2e4'); executeMove(m.from, m.to, null); });
  await page.waitForFunction(() => gameMovesAlgebraic.length >= 2, null, { timeout: 60000 });
  await page.evaluate(() => { resign(); confirmResign(); });
  await page.waitForTimeout(300);
}

console.log('\n1    The board switch is in the header, on both boards');
{
  const { ctx, page, errors } = await open();
  const a = await page.evaluate(() => {
    const t = document.getElementById('shellToggle');
    // The lit half is the bold, filled one.
    const lit = () => [...t.querySelectorAll('.st-seg')]
      .filter(s => +getComputedStyle(s).fontWeight >= 600).map(s => s.textContent.trim());
    const r = { inHeader: !!t.closest('#site-header'), visible: !!t.offsetParent,
                litVis: lit(), pressedVis: t.getAttribute('aria-pressed') };
    t.click();
    r.pro = document.body.classList.contains('pro-mode');
    r.visibleOnPro = !!t.offsetParent;
    r.litPro = lit();
    r.pressedPro = t.getAttribute('aria-pressed');
    r.saved = localStorage.getItem('bm_shell');
    t.click();
    r.back = !document.body.classList.contains('pro-mode');
    return r;
  });
  ok('the switch sits in the site header', a.inHeader);
  ok('it is on screen on the Visualization board', a.visible);
  ok('the lit half names the board you are on', a.litVis.length === 1 && /Visualization/.test(a.litVis[0]),
     JSON.stringify(a.litVis));
  ok('one click goes to the Expert board', a.pro);
  ok('and it is still on screen there', a.visibleOnPro);
  ok('where the lit half says Expert', a.litPro.length === 1 && /Expert/.test(a.litPro[0]), JSON.stringify(a.litPro));
  ok('aria-pressed follows the board', a.pressedVis === 'false' && a.pressedPro === 'true');
  ok('the choice is remembered', a.saved === 'pro');
  ok('and a second click comes back', a.back);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();

  for (const w of [360, 412]) {
    const { ctx, page } = await open({ width: w, height: 800, phone: true });
    const p = await page.evaluate(() => {
      const t = document.getElementById('shellToggle').getBoundingClientRect();
      const tour = document.getElementById('tourBtn').getBoundingClientRect();
      return { right: Math.round(t.right), left: Math.round(t.left), w: innerWidth,
               ownRow: t.top >= tour.bottom - 1, scroll: document.documentElement.scrollWidth };
    });
    ok('phone ' + w + 'px: the switch fits on screen', p.left >= 0 && p.right <= p.w, p.left + '..' + p.right);
    ok('phone ' + w + 'px: it takes its own row under the other three', p.ownRow);
    ok('phone ' + w + 'px: no sideways scroll', p.scroll <= p.w, p.scroll + ' > ' + p.w);
    await ctx.close();
  }
}

console.log('\n2    The overlays are one block; Board settings comes after them');
{
  // Tall: the ghosts stacked over Board settings, with a heading and caption.
  // 900px and under: the two share one row.
  const order = (page) => page.evaluate(() => {
    const top = el => el.getBoundingClientRect().top;
    const grids = [...document.querySelectorAll('#sidebar .ind-grid')];
    const between = (el) => top(el) > top(grids[0]) && top(el) < top(grids[1]);
    const bs = document.getElementById('bs-open');
    const key = document.querySelector('#sidebar .ind-key');
    const ghost = document.getElementById('ib-ghost');
    const utils = document.querySelector('.ind-utils');
    const g = ghost.getBoundingClientRect(), b = bs.getBoundingClientRect();
    const cap = document.querySelector('.ghost-cap');
    return {
      grids: grids.length,
      bsBetween: between(bs), keyBetween: between(key),
      keyAfter: top(key) > top(grids[1]),
      ghostShown: !!ghost.offsetParent && g.bottom <= innerHeight && g.width > 100,
      ghostAfterUtils: top(ghost) > top(utils),
      stacked: b.top >= g.bottom - 1,
      sideBySide: Math.abs(b.top - g.top) < 6 && b.left >= g.right - 1,
      label: ghost.querySelector('.ib-lbl').textContent.trim(),
      labelFits: (() => { const l = ghost.querySelector('.ib-lbl'); return l.scrollWidth <= l.clientWidth + 1; })(),
      depthShown: !!document.getElementById('soloGhostDepth').offsetParent,
      caption: cap && cap.offsetParent ? cap.textContent : '',
      ghostLeftPanel: !document.getElementById('boardSettingsPanel').contains(document.getElementById('soloGhostDepth')),
    };
  });
  const { ctx, page, errors } = await open({ width: 1440, height: 960 });
  const s = await order(page);
  ok('two overlay grids', s.grids === 2, String(s.grids));
  ok('Board settings no longer sits between them', !s.bsBetween);
  ok('nor does the state key', !s.keyBetween);
  ok('the state key follows both grids', s.keyAfter);
  ok('ghost replies are on screen without opening anything', s.ghostShown);
  ok('under the overlay utilities', s.ghostAfterUtils);
  ok('tall screen: with a line saying what they do', /repl/i.test(s.caption), s.caption);
  ok('tall screen: Board settings under them', s.stacked);
  ok('the ghost control has left the Board settings panel', s.ghostLeftPanel);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();

  for (const [w, h] of [[1440, 820], [1366, 657], [1280, 600]]) {
    const { ctx, page } = await open({ width: w, height: h });
    const t = await order(page);
    const fit = await page.evaluate(() => ({ over: document.documentElement.scrollHeight - innerHeight }));
    ok(w + 'x' + h + ': ghosts and Board settings share a row', t.sideBySide);
    ok(w + 'x' + h + ': the ghosts keep their full name, unclipped', t.label === '👻 Ghost replies' && t.labelFits,
       t.label);
    ok(w + 'x' + h + ': and their depth picker', t.depthShown);
    ok(w + 'x' + h + ': the page does not scroll', fit.over <= 0, 'over by ' + fit.over);
    await ctx.close();
  }
}

console.log('\n3    Ghost replies: desktop control, phone row and chip, remembered');
{
  // Desktop: switch on at a depth, come back, still on.
  const { ctx, page } = await open();
  await page.evaluate(() => { ghostToggle(); const s = document.getElementById('soloGhostDepth'); s.value = '12'; ghostDepthChanged(); });
  const keep = await storage(page);
  await ctx.close();
  const { ctx: c2, page: p2 } = await open({ keep });
  const back = await p2.evaluate(() => ({ v: document.getElementById('soloGhostDepth').value,
    on: document.getElementById('ib-ghost').classList.contains('on') }));
  ok('desktop: ghosts stay on at the chosen depth across a visit', back.v === '12' && back.on, JSON.stringify(back));
  await p2.evaluate(() => ghostToggle());
  const keepOff = await storage(p2);
  await c2.close();
  const { ctx: c3, page: p3 } = await open({ keep: keepOff });
  ok('desktop: and stay off once switched off',
     await p3.evaluate(() => document.getElementById('soloGhostDepth').value === '0'));
  await c3.close();

  // Phone: the panel row cycles off → beside board → exploring → off.
  const { ctx: c4, page: p4, errors } = await open({ width: 412, height: 915, phone: true });
  const cyc = await p4.evaluate(() => {
    visPanelOpen();
    const row = () => document.querySelector('#vis-ghost .vis-row');
    const chip = () => document.getElementById('pin-ghost');
    const snap = () => ({ st: visState('ghost'), chip: !!chip(), on: ghostIsOn(),
                          chipCls: chip() ? chip().className : '', word: row().querySelector('.vis-st').textContent });
    const out = [snap()];
    row().click(); out.push(snap());
    row().click(); out.push(snap());
    row().click(); out.push(snap());
    return out;
  });
  ok('phone: the ghost row is in the board-vision panel', await p4.evaluate(() => !!document.getElementById('vis-ghost')));
  ok('phone: starts off, no chip', cyc[0].st === 0 && !cyc[0].chip && !cyc[0].on, JSON.stringify(cyc[0]));
  ok('phone: one tap puts a chip beside the board, ghosts still off',
     cyc[1].st === 1 && cyc[1].chip && !cyc[1].on && /beside/.test(cyc[1].word), JSON.stringify(cyc[1]));
  ok('phone: a second tap switches them on (chip half-filled)',
     cyc[2].st === 2 && cyc[2].on && /\bpre\b/.test(cyc[2].chipCls) && /explor/.test(cyc[2].word), JSON.stringify(cyc[2]));
  ok('phone: a third tap takes them off the board entirely', cyc[3].st === 0 && !cyc[3].chip && !cyc[3].on,
     JSON.stringify(cyc[3]));
  const chipTap = await p4.evaluate(() => {
    const row = document.querySelector('#vis-ghost .vis-row');
    row.click(); row.click();                     // on, with a chip
    visPanelClose();
    document.getElementById('pin-ghost').click();  // chip: off, chip stays
    const a = { on: ghostIsOn(), chip: !!document.getElementById('pin-ghost') };
    document.getElementById('pin-ghost').click();  // and on again
    a.onAgain = ghostIsOn();
    // The panel's picker chooses the depth.
    visPanelOpen();
    const sel = document.querySelector('#vis-ghost select');
    sel.value = 'maia'; sel.dispatchEvent(new Event('change'));
    a.depth = document.getElementById('soloGhostDepth').value;
    a.hasOff = [...sel.options].some(o => o.value === '0');
    visPanelClose();
    return a;
  });
  ok('phone: the chip switches ghosts off and stays beside the board', !chipTap.on && chipTap.chip, JSON.stringify(chipTap));
  ok('phone: and on again', chipTap.onAgain);
  ok('phone: the panel picker sets the engine and depth', chipTap.depth === 'maia', chipTap.depth);
  ok('phone: the picker carries depths only (on/off is the row)', !chipTap.hasOff);
  const keepPhone = await storage(p4);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await c4.close();
  const { ctx: c5, page: p5 } = await open({ width: 412, height: 915, phone: true, keep: keepPhone });
  const after = await p5.evaluate(() => ({ chip: !!document.getElementById('pin-ghost'), on: ghostIsOn(),
    depth: document.getElementById('soloGhostDepth').value }));
  ok('phone: chip and ghosts come back on the next visit', after.chip && after.on && after.depth === 'maia',
     JSON.stringify(after));
  const cleared = await p5.evaluate(() => { visClearAll(); return { chip: !!document.getElementById('pin-ghost'), on: ghostIsOn() }; });
  ok('phone: Clear all takes the ghosts off too', !cleared.chip && !cleared.on, JSON.stringify(cleared));
  await c5.close();
}

console.log('\n4    The last bot played comes back on the next visit');
{
  // A quick pick, a colour and a clock.
  const { ctx, page, errors } = await open();
  ok('a first visit starts on Flounder 600',
     await page.evaluate(() => document.getElementById('quickBotSel').value === '600'));
  await page.evaluate(() => {
    quickBotPick('1200'); botSetPlayerColor('black'); quickBotSetTime('5+0'); botStart();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { botStop(); });
  const keep = await storage(page);
  ok('starting a game records the bot', !!keep.bm_lastBot);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
  const { ctx: c2, page: p2, errors: e2 } = await open({ keep });
  const q = await p2.evaluate(() => ({
    sel: document.getElementById('quickBotSel').value, elo: flounderSliderElo(), tab: botTab,
    color: document.getElementById('quickBotColor').value, time: document.getElementById('quickBotTime').value,
    tc: botSelectedTC, secs: TIME_CONTROLS[botSelectedTC] && TIME_CONTROLS[botSelectedTC].time,
  }));
  ok('the opponent is Flounder 1200 again, not 600', q.sel === '1200' && q.elo === 1200 && q.tab === 'sf', JSON.stringify(q));
  ok('playing as Black again', q.color === 'black', q.color);
  ok('at 5 minutes again', q.time === '5+0' && q.tc === 'custom' && q.secs === 300, JSON.stringify(q));
  ok('no page errors', e2.length === 0, e2.join('; '));

  // A builder config: the builder's own format, from the builder's own code.
  const built = await p2.evaluate(async () => {
    const f = document.getElementById('botModalFrame');
    for (let i = 0; i < 40 && typeof f.contentWindow.getBotConfig !== 'function'; i++) await new Promise(r => setTimeout(r, 100));
    const cfg = f.contentWindow.getBotConfig();
    cfg.engine = 'stockfish'; cfg.elo = 1700; cfg.flounderElo = 1700;
    cfg.cpBudget = 150; cfg.attractorValues = { attacker: 4 };
    cfg.botName = 'Memory Test';
    botApplyPanelConfig(cfg, true);
    botStart();
    return { elo: flounderSliderElo(), budget: window._bcpCpBudget };
  });
  await p2.waitForTimeout(300);
  await p2.evaluate(() => botStop());
  const keep2 = await storage(p2);
  await c2.close();
  const { ctx: c3, page: p3, errors: e3 } = await open({ keep: keep2 });
  const b = await p3.evaluate(() => ({
    elo: flounderSliderElo(), tab: botTab, budget: window._bcpCpBudget,
    attacker: (window._bcpAttractorValues || {}).attacker,
    name: document.getElementById('botNameInput').value,
    label: document.getElementById('quickBotSel').selectedOptions[0].textContent,
    hasCfg: !!window._lastAppliedBotConfig,
  }));
  ok('the builder bot is back: Flounder 1700', b.elo === 1700 && b.tab === 'sf', JSON.stringify(b));
  ok('with its personality', b.budget === 150 && b.attacker === 4, JSON.stringify(b));
  ok('and its name, which the picker shows', b.name === 'Memory Test' && b.label === 'Memory Test', JSON.stringify(b));
  ok('as the applied builder config (so Save bot still works)', b.hasCfg);
  // The builder shows the same bot when it is opened.
  await p3.evaluate(() => openBotModal());
  await p3.waitForTimeout(700);
  const panel = await p3.evaluate(() => {
    const c = document.getElementById('botModalFrame').contentWindow.getBotConfig();
    return { elo: c.flounderElo != null ? c.flounderElo : c.elo, engine: c.engine, budget: c.cpBudget };
  });
  ok('the builder opens on that bot, not on Flounder 600',
     panel.elo === 1700 && /stockfish|lcsf/.test(panel.engine), JSON.stringify(panel));
  ok('with its budget', panel.budget === 150, JSON.stringify(panel));
  await p3.evaluate(() => closeBotModal());
  // A quick pick on top of the builder bot keeps the personality and the pick.
  await p3.evaluate(() => { quickBotPick('800'); botStart(); });
  await p3.waitForTimeout(300);
  await p3.evaluate(() => botStop());
  const keep3 = await storage(p3);
  ok('no page errors', e3.length === 0, e3.join('; '));
  await c3.close();
  const { ctx: c4, page: p4 } = await open({ keep: keep3 });
  const c = await p4.evaluate(() => ({ elo: flounderSliderElo(), budget: window._bcpCpBudget }));
  ok('a quick pick on top of a builder bot: the new rating, the same personality',
     c.elo === 800 && c.budget === 150, JSON.stringify(c));
  await c4.close();
}

console.log('\n5    A finished game can be reviewed on a phone');
{
  const { ctx, page, errors } = await open({ width: 412, height: 915, phone: true });
  ok('no Review on the bar before a game', await page.evaluate(() =>
    getComputedStyle(document.getElementById('pbReview')).display === 'none'));
  await finishGame(page);
  const over = await page.evaluate(() => {
    const vis = id => { const el = document.getElementById(id); return !!el.offsetParent && getComputedStyle(el).display !== 'none'; };
    return { review: vis('pbReview'), rematch: vis('pbRematch'), resign: vis('pbResign') };
  });
  ok('the game bar carries Review once the game is over', over.review);
  ok('and Rematch', over.rematch);
  ok('in place of Resign', !over.resign);
  await page.evaluate(() => document.getElementById('pbReview').click());
  await page.waitForTimeout(400);
  const rv = await page.evaluate(() => ({
    inReplay, expanded: _distExpanded,
    under: document.getElementById('distPanel').parentNode.id,
    reviewGone: getComputedStyle(document.getElementById('pbReview')).display === 'none',
    controls: getComputedStyle(document.getElementById('replayControls')).display !== 'none',
  }));
  ok('Review steps into the game', rv.inReplay && rv.controls);
  ok('with Maia’s odds opened', rv.expanded);
  ok('which stay under the board on a phone', rv.under === 'board-col', rv.under);
  ok('and Review leaves the bar while reviewing', rv.reviewGone);
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n6    A desktop review opens the odds where they can be read');
{
  const { ctx, page, errors } = await open();
  await finishGame(page);
  const btn = await page.evaluate(() => {
    const b = document.getElementById('reviewBtn');
    return { shown: !!b.offsetParent, size: parseFloat(getComputedStyle(b).fontSize) };
  });
  ok('Review is on screen after the game', btn.shown);
  ok('at a readable size (it was 9px)', btn.size >= 11, btn.size + 'px');
  ok('the odds start closed', await page.evaluate(() => !_distExpanded));
  await page.evaluate(() => document.getElementById('reviewBtn').click());
  await page.waitForTimeout(400);
  const rv = await page.evaluate(() => {
    const p = document.getElementById('distPanel');
    const body = document.getElementById('distBody').getBoundingClientRect();
    return { inReplay, expanded: _distExpanded, parent: p.parentNode.id, first: p.parentNode.firstElementChild === p,
             bodyTop: Math.round(body.top), bodyBottom: Math.round(body.bottom), vh: innerHeight,
             width: Math.round(p.getBoundingClientRect().width),
             side: Math.round(document.getElementById('sidebar').getBoundingClientRect().width) };
  });
  ok('Review steps into the game', rv.inReplay);
  ok('and opens Maia’s odds', rv.expanded);
  ok('at the top of the side column', rv.parent === 'sidebar' && rv.first, rv.parent);
  ok('the full width of it', Math.abs(rv.width - rv.side) <= 2, rv.width + ' vs ' + rv.side);
  ok('above the fold', rv.bodyBottom <= rv.vh, rv.bodyTop + '..' + rv.bodyBottom + ' of ' + rv.vh);
  const room = await page.evaluate(() => ({ over: document.documentElement.scrollHeight - innerHeight,
    qb: getComputedStyle(document.getElementById('quickBot')).display }));
  ok('in the quick-start block’s place, so the page does not scroll', room.qb === 'none' && room.over <= 0,
     JSON.stringify(room));
  await page.evaluate(() => exitReplay());
  await page.waitForTimeout(200);
  const ex = await page.evaluate(() => ({ parent: document.getElementById('distPanel').parentNode.id,
    expanded: _distExpanded, next: (document.getElementById('distPanel').nextElementSibling || {}).id }));
  ok('leaving the review puts the panel back under the board', ex.parent === 'board-col' && ex.next === 'distHome',
     JSON.stringify(ex));
  ok('closed again, as it was before', !ex.expanded);
  ok('and the quick-start block is back',
     await page.evaluate(() => getComputedStyle(document.getElementById('quickBot')).display !== 'none'));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n7    An Expert-board game, reviewed on the Visualization board');
{
  const { ctx, page, errors } = await open({ shell: 'pro' });
  await finishGame(page);
  const b = await page.evaluate(() => {
    const el = document.getElementById('proReviewVisBtn');
    return { shown: !!el.offsetParent, text: el.textContent };
  });
  ok('the Expert board offers a review with the odds', b.shown && /Maia/.test(b.text), b.text);
  ok('the Expert board shows no odds itself', await page.evaluate(() =>
    getComputedStyle(document.getElementById('distPanel')).display === 'none'));
  await page.evaluate(() => document.getElementById('proReviewVisBtn').click());
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({
    pro: document.body.classList.contains('pro-mode'), inReplay, expanded: _distExpanded,
    parent: document.getElementById('distPanel').parentNode.id,
    human: _distReviewCtx && _distReviewCtx.human, atEnd: replayIdx === replayMoves.length,
  }));
  ok('it switches to the Visualization board', !r.pro);
  ok('in review, at the final position', r.inReplay && r.atEnd, JSON.stringify(r));
  ok('with the odds open in the side column', r.expanded && r.parent === 'sidebar', JSON.stringify(r));
  ok('knowing which side the reviewer played', r.human === 'w', String(r.human));
  ok('with the Visualization board’s overlays back on (the Expert board used to wipe them)',
     await page.evaluate(() => IND.threats.pre && IND.counts.pre && IND.unprotected.pre));
  await ctx.close();

  // Reviewing on the Expert board first, then flipping the header switch,
  // carries the review across and opens the odds there too.
  const { ctx: c2, page: p2 } = await open({ shell: 'pro' });
  await finishGame(p2);
  await p2.evaluate(() => { startReplayOfCurrentGame(); rebuildToReplayIdx(1); });
  await p2.evaluate(() => document.getElementById('shellToggle').click());
  await p2.waitForTimeout(400);
  const f = await p2.evaluate(() => ({ inReplay, idx: replayIdx, expanded: _distExpanded,
    snap: !!_distPreMove, parent: document.getElementById('distPanel').parentNode.id }));
  ok('the header switch carries an Expert-board review across, at the same move',
     f.inReplay && f.idx === 1, JSON.stringify(f));
  ok('and the odds have the position to read', f.snap && f.expanded && f.parent === 'sidebar', JSON.stringify(f));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await c2.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

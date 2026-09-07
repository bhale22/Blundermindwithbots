// "My" vs "Opponent's" overlays must follow the SEAT, not the side to move and
// not a hardcoded white. Run with the dev server up on :3100.
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const browser = await chromium.launch();

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { bmWelcomeDismiss(); } catch (e) {} });
  await page.waitForTimeout(250);
  // Instrument the per-colour computations so we can read back WHICH colour
  // each button actually asked for.
  await page.evaluate(() => {
    window.__seen = { fork: [], disc: [], xray: [] };
    const wrap = (name, bucket) => {
      const orig = window[name];
      window[name] = function (bd, col) { window.__seen[bucket].push(col); return orig.apply(this, arguments); };
    };
    wrap('computeForkData', 'fork');
    wrap('computeDiscoveredData', 'disc');
    wrap('computeXrayData', 'xray');
    // The fork COLOURS cannot be instrumented this way: renderForkBg is nested
    // inside render(), so it is not reachable as a global. Section 5 samples
    // the canvas instead.
  });
  return { ctx, page, errs };
}

// Put the app in a bot game with a chosen seat and a chosen side to move,
// turn on exactly the requested overlays, and recompute.
async function scene(page, { seat, toMove, on }) {
  return page.evaluate(({ seat, toMove, on }) => {
    botActive = true;
    botPlayerColor = seat;              // botPlayerColor is the HUMAN's colour
    gameOver = false;
    turn = toMove;
    for (const k in IND) { IND[k].on = false; IND[k].pre = false; IND[k].pressing = false; }
    for (const k of on) IND[k].on = true;
    window.__seen = { fork: [], disc: [], xray: [] };
    _indLastSig = null;
    indApply();
    return {
      me: playerColor(),
      fork: window.__seen.fork.slice(),
      disc: window.__seen.disc.slice(),
      xray: window.__seen.xray.slice(),

      showW: showingForksW, showB: showingForksB,
      fdW: forkDataW !== null, fdB: forkDataB !== null,
      weakW: weakSquaresW.size, weakB: weakSquaresB.size,
    };
  }, { seat, toMove, on });
}

const GREEN = 'rgba(40,200,80,0.92)';   // something I can do
const AMBER = 'rgba(235,140,0,0.92)';   // something they can do

console.log('\n1   "My forks" means my forks, from either seat');
{
  const { ctx, page, errs } = await open();
  for (const seat of ['white', 'black']) {
    const mine = seat === 'white' ? 'w' : 'b';
    const theirs = mine === 'w' ? 'b' : 'w';
    for (const toMove of ['w', 'b']) {
      const r = await scene(page, { seat, toMove, on: ['forksw'] });
      ok(`${seat} seat, ${toMove} to move: "My forks" computes ${mine}`,
        r.fork.length === 1 && r.fork[0] === mine, JSON.stringify(r.fork));
    }
    const r = await scene(page, { seat, toMove: mine, on: ['forksb'] });
    ok(`${seat} seat: "Opponent's forks" computes ${theirs}`,
      r.fork.length === 1 && r.fork[0] === theirs, JSON.stringify(r.fork));
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n2   "My weak squares" means mine, from either seat');
{
  const { ctx, page, errs } = await open();
  for (const seat of ['white', 'black']) {
    const mine = seat === 'white' ? 'w' : 'b';
    const r = await scene(page, { seat, toMove: mine, on: ['weakw'] });
    const gotMine = mine === 'w' ? r.weakW : r.weakB;
    const gotOther = mine === 'w' ? r.weakB : r.weakW;
    ok(`${seat} seat: "My weak squares" fills the ${mine} set`,
      gotMine > 0 && gotOther === 0, `w=${r.weakW} b=${r.weakB}`);
    const o = await scene(page, { seat, toMove: mine, on: ['weakb'] });
    const oppSet = mine === 'w' ? o.weakB : o.weakW;
    const mySet = mine === 'w' ? o.weakW : o.weakB;
    ok(`${seat} seat: "Opponent's weak squares" fills the other set`,
      oppSet > 0 && mySet === 0, `w=${o.weakW} b=${o.weakB}`);
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n3   Discovered attacks do not swap sides every ply');
{
  const { ctx, page, errs } = await open();
  for (const seat of ['white', 'black']) {
    const mine = seat === 'white' ? 'w' : 'b';
    const seenMine = [];
    for (const toMove of ['w', 'b']) {
      const r = await scene(page, { seat, toMove, on: ['discoveredself'] });
      seenMine.push(r.disc.join(','));
    }
    ok(`${seat} seat: "My discovered attacks" is ${mine} on both turns`,
      seenMine.every(x => x === mine), JSON.stringify(seenMine));
    const r = await scene(page, { seat, toMove: mine, on: ['discoveredopp'] });
    ok(`${seat} seat: "Opponent's discovered attacks" is the other colour`,
      r.disc.length === 1 && r.disc[0] !== mine, JSON.stringify(r.disc));
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n4   X-ray own/opponent follows the seat');
{
  const { ctx, page, errs } = await open();
  for (const seat of ['white', 'black']) {
    const mine = seat === 'white' ? 'w' : 'b';
    for (const toMove of ['w', 'b']) {
      const r = await scene(page, { seat, toMove, on: ['xray'] });
      // own is computed first, opponent second
      ok(`${seat} seat, ${toMove} to move: own x-ray is ${mine}`,
        r.xray.length === 2 && r.xray[0] === mine && r.xray[1] !== mine,
        JSON.stringify(r.xray));
    }
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n5   Green means mine and amber means theirs, all game long');
{
  const { ctx, page, errs } = await open();
  // A real white knight fork: Nc7 hits the rook on a8 and the king on e8.
  // renderForkBg is nested inside render(), so the only honest way to read the
  // colour it chose is to look at what landed on the canvas.
  const FEN = 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1';
  for (const seat of ['white', 'black']) {
    for (const toMove of ['w', 'b']) {
      const hue = await page.evaluate(({ seat, toMove, FEN }) => {
        board = parseFen(FEN);
        turn = toMove;
        atkMap = buildAtk(board);
        botActive = true; botPlayerColor = seat; gameOver = false;
        previewBoard = null; currentlyPreviewing = false;
        for (const k in IND) { IND[k].on = false; IND[k].pre = false; IND[k].pressing = false; }
        // Whichever button means "white's forks" from this seat.
        IND[seat === 'white' ? 'forksw' : 'forksb'].on = true;
        _indLastSig = null;
        indApply();
        const cv = document.getElementById('cv');
        const c2 = cv.getContext('2d');
        const d = c2.getImageData(0, 0, cv.width, cv.height).data;
        // Count pixels near the two accents. Green (40,200,80) and amber
        // (235,140,0) are far apart in every channel, so a loose match is safe.
        let green = 0, amber = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.abs(r - 40) < 45 && Math.abs(g - 200) < 45 && Math.abs(b - 80) < 45) green++;
          if (Math.abs(r - 235) < 45 && Math.abs(g - 140) < 45 && b < 60) amber++;
        }
        return { green, amber };
      }, { seat, toMove, FEN });
      const mine = seat === 'white';
      ok(`${seat} seat, ${toMove} to move: the white fork paints ` + (mine ? 'green (mine)' : 'amber (theirs)'),
        mine ? (hue.green > 50 && hue.amber < hue.green)
             : (hue.amber > 50 && hue.green < hue.amber),
        JSON.stringify(hue));
    }
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n6   Solo (no game) still lets either side be explored');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    botActive = false;
    turn = 'w';
    for (const k in IND) { IND[k].on = false; IND[k].pre = false; IND[k].pressing = false; }
    IND.forksw.on = true;
    window.__seen = { fork: [], disc: [], xray: [] };
    _indLastSig = null; indApply();
    const asWhite = window.__seen.fork.slice();
    turn = 'b';
    window.__seen = { fork: [], disc: [], xray: [] };
    _indLastSig = null; indApply();
    return { asWhite, asBlack: window.__seen.fork.slice() };
  });
  ok('with no game, "my forks" follows the side to move',
    r.asWhite[0] === 'w' && r.asBlack[0] === 'b',
    JSON.stringify(r));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n7   A view flip does not change who "my" is');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    botActive = true; botPlayerColor = 'black'; gameOver = false; turn = 'b';
    for (const k in IND) { IND[k].on = false; IND[k].pre = false; IND[k].pressing = false; }
    IND.forksw.on = true;
    const before = playerColor();
    flipPerspective();
    window.__seen = { fork: [], disc: [], xray: [] };
    _indLastSig = null; indApply();
    const after = { me: playerColor(), fork: window.__seen.fork.slice(),
                    flipped: boardViewFlipped() };
    flipPerspective();
    return { before, after };
  });
  ok('the seat survives a flip', r.before === 'b' && r.after.me === 'b', JSON.stringify(r));
  ok('and "my forks" is still black after flipping',
    r.after.fork.length === 1 && r.after.fork[0] === 'b', JSON.stringify(r.after.fork));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

console.log('\n8   Weak squares are PAINTED as mine, not just computed as mine');
{
  const { ctx, page, errs } = await open();
  // Two channels carry "whose": the fill colour and the hatch direction. Both
  // were hardwired to White. Only the fill is sampleable, so that is what is
  // checked - the direction is set in the same call.
  for (const seat of ['white', 'black']) {
    const hue = await page.evaluate((seat) => {
      botActive = true; botPlayerColor = seat; gameOver = false;
      turn = seat === 'white' ? 'w' : 'b';
      previewBoard = null; currentlyPreviewing = false;
      for (const k in IND) { IND[k].on = false; IND[k].pre = false; IND[k].pressing = false; }
      IND.weakw.on = true;                       // "My weak squares"
      _indLastSig = null;
      indApply();
      const rgb = (c) => {
        const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c || '');
        return m ? [ +m[1], +m[2], +m[3] ] : null;
      };
      const mine   = rgb(currentPalette.weakMineStroke);
      const theirs = rgb(currentPalette.weakTheirsStroke);
      const cv = document.getElementById('cv');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const near = (r, g, b, t) => t && Math.abs(r - t[0]) < 30 &&
                                        Math.abs(g - t[1]) < 30 && Math.abs(b - t[2]) < 30;
      let m = 0, o = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (near(d[i], d[i+1], d[i+2], mine))   m++;
        if (near(d[i], d[i+1], d[i+2], theirs)) o++;
      }
      return { mine: m, theirs: o, mineCol: currentPalette.weakMineStroke,
               theirsCol: currentPalette.weakTheirsStroke };
    }, seat);
    ok(`${seat} seat: "My weak squares" paints in the MINE colour`,
      hue.mine > 0, JSON.stringify(hue));
    ok(`${seat} seat: and not in the opponent's colour`,
      hue.theirs === 0, JSON.stringify(hue));
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

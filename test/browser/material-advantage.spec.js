// The material-advantage indicator must not lie about the size of a lead.
//
// It used to. matAdvString computed the surplus PER PIECE TYPE and showed it
// for the leading side only, never accounting for types that side was BEHIND
// on. After any uneven trade the glyphs overstated the position:
//
//   queen traded for two rooks  ->  "♖♖ +1"   (looks like up two rooks)
//   promoted queen, a pawn down ->  "♕♙ +5"   (claims a pawn it does not have)
//   bishop for knight, uneven   ->  "♘♘ +3"   (the missing bishop invisible)
//
// Both sides now show their surplus and only the leader carries the number, so
// the invariant below holds: white's glyph value minus black's equals the
// numeric difference. That is the property worth testing — it catches any
// future change that makes the picture and the number disagree.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const H = require('./_harness');

const VAL = { '♙': 1, '♘': 3, '♗': 3, '♖': 5, '♕': 9 };
const glyphValue = (s) => (String(s).match(/[♙♘♗♖♕]/gu) || [])
  .reduce((a, g) => a + (VAL[g] || 0), 0);

// Hand-picked positions, each chosen because it broke the old implementation
// or guards a case that could regress.
const CASES = [
  ['opening position, dead even',   'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 0],
  ['white up a pawn',               'rnbqkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 1],
  ['black up a pawn',               'rnbqkbnr/pppppppp/8/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1', -1],
  ['white up a pawn and a rook',    'rnbqkbn1/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1', 6],
  ['white up a knight',             'r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 3],
  ['white queen vs black two rooks','r3kr2/pppppppp/8/8/8/8/PPPPPPPP/3QK3 w q - 0 1', -1],
  ['white two rooks vs black queen','3qk3/pppppppp/8/8/8/8/PPPPPPPP/R3KR2 w Q - 0 1', 1],
  ['white promoted, but a pawn down','rnbqkbnr/ppppppp1/8/8/8/8/PPPPPPPP/RNBQKBNQ w KQkq - 0 1', 5],
  ['white up bishop, black up knight','r1bqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQK1NR w KQkq - 0 1', 3],
  ['bare kings',                    '4k3/8/8/8/8/8/8/4K3 w - - 0 1', 0],
  ['white up three pawns',          'rnbqkbnr/ppppp3/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 3],
];

describe('material advantage indicator', { concurrency: 1 }, () => {
  let server, browser, page;
  const errs = [];

  before(async () => {
    server = await H.startServer();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.removeItem('bm_liveGame'); } catch (e) {}
    });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(1700);
    await H.dismissLanding(page);
  });

  after(async () => {
    if (browser) await browser.close();
    H.stopServer(server);
  });

  // Set a position and read back what the indicators actually render.
  const show = (fen) => page.evaluate((f) => {
    board = parseFen(f);
    updatePlayerBoxes();
    const strip = (h) => (h || '').replace(/<[^>]*>/g, '');
    const mat = computeMaterial(board);
    return {
      diff: mat.w - mat.b,
      w: strip(document.getElementById('matW').innerHTML),
      b: strip(document.getElementById('matB').innerHTML),
    };
  }, fen);

  test('computeMaterial reports the expected difference', async () => {
    for (const [name, fen, expected] of CASES) {
      const r = await show(fen);
      assert.strictEqual(r.diff, expected, name + ': expected diff ' + expected + ', got ' + r.diff);
    }
  });

  test('the glyphs shown always net out to the numeric difference', async () => {
    for (const [name, fen] of CASES) {
      const r = await show(fen);
      const net = glyphValue(r.w) - glyphValue(r.b);
      assert.strictEqual(net, r.diff,
        name + ': glyphs net to ' + net + ' but the position is ' + r.diff +
        '  [W "' + r.w + '"  B "' + r.b + '"]');
    }
  });

  test('only the side that is actually ahead shows a number', async () => {
    for (const [name, fen] of CASES) {
      const r = await show(fen);
      const wNum = /\+\d/.test(r.w), bNum = /\+\d/.test(r.b);
      if (r.diff > 0) {
        assert.ok(wNum && !bNum, name + ': white leads, only white should carry +N');
      } else if (r.diff < 0) {
        assert.ok(bNum && !wNum, name + ': black leads, only black should carry +N');
      } else {
        assert.ok(!wNum && !bNum, name + ': level, neither side should carry +N');
      }
    }
  });

  test('the number matches the size of the lead', async () => {
    for (const [name, fen] of CASES) {
      const r = await show(fen);
      if (r.diff === 0) continue;
      const shown = r.diff > 0 ? r.w : r.b;
      const n = +(shown.match(/\+(\d+)/) || [])[1];
      assert.strictEqual(n, Math.abs(r.diff), name + ': shows +' + n + ' for a ' + r.diff + ' lead');
    }
  });

  test('an uneven trade shows both sides, not just the leader', async () => {
    // The case that motivated the fix: a queen for two rooks is +1, and the
    // old display rendered it as "♖♖ +1" with nothing opposite.
    const r = await show('3qk3/pppppppp/8/8/8/8/PPPPPPPP/R3KR2 w Q - 0 1');
    assert.strictEqual(r.diff, 1);
    assert.match(r.w, /♖♖/, 'white should show the two rooks it is up');
    assert.match(r.b, /♕/, 'black should show the queen it is up — this was missing');
    assert.match(r.w, /\+1/, 'and the lead is only one point');
  });

  test('random legal-ish positions never contradict themselves', async () => {
    // Sweep: place a random selection of pieces and confirm the invariant holds
    // everywhere, not only on the positions someone thought to write down.
    const bad = await page.evaluate(() => {
      const VALS = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
      const GL = { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕' };
      const gv = (s) => (String(s).match(/[♙♘♗♖♕]/gu) || [])
        .reduce((a, g) => a + (Object.entries(GL).find(([, x]) => x === g)
          ? VALS[Object.entries(GL).find(([, x]) => x === g)[0]] : 0), 0);
      const strip = (h) => (h || '').replace(/<[^>]*>/g, '');
      const types = ['P', 'N', 'B', 'R', 'Q'];
      const failures = [];

      for (let iter = 0; iter < 300; iter++) {
        const bd = {};
        bd[4] = { piece: 'K', color: 'b' };
        bd[60] = { piece: 'K', color: 'w' };
        const used = new Set([4, 60]);
        const n = 2 + Math.floor(Math.random() * 20);
        for (let i = 0; i < n; i++) {
          let sq;
          do { sq = Math.floor(Math.random() * 64); } while (used.has(sq));
          used.add(sq);
          bd[sq] = {
            piece: types[Math.floor(Math.random() * types.length)],
            color: Math.random() < 0.5 ? 'w' : 'b',
          };
        }
        board = bd;
        updatePlayerBoxes();
        const mat = computeMaterial(board);
        const diff = mat.w - mat.b;
        const w = strip(document.getElementById('matW').innerHTML);
        const b = strip(document.getElementById('matB').innerHTML);
        const net = gv(w) - gv(b);
        if (net !== diff) failures.push({ diff, net, w, b });
        if (failures.length > 3) break;
      }
      return failures;
    });
    assert.deepStrictEqual(bad, [],
      'positions where the glyphs contradict the number: ' + JSON.stringify(bad));
  });

  test('no page errors were raised', () => {
    assert.deepStrictEqual(errs, []);
  });
});

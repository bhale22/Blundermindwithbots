// Verifies the playable premove-trap illustration in bot-control-panel.html.
//
// The modal teaches chess, so every claim it makes must be true. These tests
// scrape the PMT_SCENARIOS table straight out of the panel and re-derive each
// claim from the real engine (src/20-chess-core.js):
//   • the position parses and the scripted moves are legal,
//   • a scenario claiming fires:true really does stay legal after the user's
//     move — and a scenario claiming fires:false really does become illegal,
//   • the "punish" move really wins the piece the modal says it wins.
//
// If a diagram is ever edited into something untrue, this fails.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ── Load the chess engine ────────────────────────────────────────────────────
const ctx = { console, window: {}, document: { getElementById: () => null }, indActive: () => false };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', '20-chess-core.js'), 'utf8'), ctx);

// ── Scrape PMT_SCENARIOS out of the panel ────────────────────────────────────
const panel = fs.readFileSync(path.join(ROOT, 'bot-control-panel.html'), 'utf8');
const m = panel.match(/const PMT_SCENARIOS = (\[[\s\S]*?\n\]);/);
assert.ok(m, 'PMT_SCENARIOS table not found in bot-control-panel.html');
const SCENARIOS = vm.runInNewContext('(' + m[1] + ')');

const sq = (n) => ctx.fileRankToSq(n);
const nm = (s) => ctx.sqName(s);

// The modal stores board-only FENs; the engine wants a full one. Every
// scenario is White to move (the user is White).
function fullFen(boardFen) { return boardFen + ' w KQkq - 0 1'; }

function load(scn) {
  const bd = ctx.parseFen(fullFen(scn.fen));
  return { bd, castling: ctx.castling, epSq: ctx.epSq };
}

test('the illustration defines scenarios and they are well-formed', () => {
  assert.ok(SCENARIOS.length >= 3, 'expected several scenarios');
  for (const s of SCENARIOS) {
    assert.ok(s.id && s.tab && s.fen, s.id + ': missing id/tab/fen');
    assert.ok(s.userMove && s.userMove.from && s.userMove.to, s.id + ': missing userMove');
    assert.ok(s.premove && s.premove.from && s.premove.to, s.id + ': missing premove');
    assert.equal(typeof s.fires, 'boolean', s.id + ': fires must be explicit');
    assert.ok(s.outcome && s.lesson, s.id + ': missing teaching text');
  }
});

test('every scenario position parses and has both kings', () => {
  for (const s of SCENARIOS) {
    const { bd } = load(s);
    const kings = { w: 0, b: 0 };
    for (let i = 0; i < 64; i++) if (bd[i] && bd[i].piece === 'K') kings[bd[i].color]++;
    assert.equal(kings.w, 1, s.id + ': needs exactly one white king');
    assert.equal(kings.b, 1, s.id + ': needs exactly one black king');
  }
});

test("the user's trap move is legal in every scenario", () => {
  for (const s of SCENARIOS) {
    const { bd, castling, epSq } = load(s);
    const from = sq(s.userMove.from), to = sq(s.userMove.to);
    const p = bd[from];
    assert.ok(p, s.id + ': no piece on ' + s.userMove.from);
    assert.equal(p.color, 'w', s.id + ': the user plays White, but ' + s.userMove.from + ' holds a black piece');
    const legal = ctx.legalMovesFor(from, bd, epSq, castling);
    assert.ok(legal.includes(to),
      s.id + ': user move ' + s.userMove.san + ' is not legal (legal: ' + legal.map(nm).join(',') + ')');
  }
});

test("the bot's premove is legal BEFORE the user moves — otherwise it would never have been committed", () => {
  for (const s of SCENARIOS) {
    const { bd, castling, epSq } = load(s);
    const from = sq(s.premove.from), to = sq(s.premove.to);
    const p = bd[from];
    assert.ok(p, s.id + ': no piece on ' + s.premove.from);
    assert.equal(p.color, 'b', s.id + ': the bot plays Black, but ' + s.premove.from + ' holds a white piece');
    // Legality for Black is evaluated with Black to move.
    const bFen = fullFen(s.fen).replace(' w ', ' b ');
    const bd2 = ctx.parseFen(bFen);
    const legal = ctx.legalMovesFor(from, bd2, ctx.epSq, ctx.castling);
    assert.ok(legal.includes(to),
      s.id + ': premove ' + s.premove.san + ' is not legal in the starting position, so the bot could not have queued it');
  }
});

test('the fires/busted claim matches what the engine says after the user moves', () => {
  for (const s of SCENARIOS) {
    const { bd, castling, epSq } = load(s);
    const uf = sq(s.userMove.from), ut = sq(s.userMove.to);
    const after   = ctx.applyMove(uf, ut, bd, epSq, 'Q');
    const afterEp = ctx.computeEP(uf, ut, bd);
    const afterCs = ctx.updateCastling(uf, ut, bd[uf], castling);

    const pf = sq(s.premove.from), pt = sq(s.premove.to);
    const piece = after[pf];
    const stillLegal = piece
      ? ctx.legalMovesFor(pf, after, afterEp, afterCs).includes(pt)
      : false;

    assert.equal(stillLegal, s.fires,
      s.id + ': modal claims fires=' + s.fires + ' but the engine says the premove ' +
      s.premove.san + ' is ' + (stillLegal ? 'still legal' : 'illegal') + ' after ' + s.userMove.san);
  }
});

test('busted scenarios highlight a square that explains the bust', () => {
  for (const s of SCENARIOS.filter(x => !x.fires)) {
    assert.ok(s.doomSq, s.id + ': a busted scenario must mark the square that explains it');
    // The marked square is either where the stranded piece sits, or the
    // target it can no longer reach.
    assert.ok([s.premove.from, s.premove.to].includes(s.doomSq),
      s.id + ': doomSq ' + s.doomSq + ' should be the premove from- or to-square');
  }
});

test('the firing scenario really does lose material to the punish move', () => {
  const firing = SCENARIOS.filter(s => s.fires);
  assert.ok(firing.length >= 1, 'at least one scenario should demonstrate a premove firing into a loss');

  for (const s of firing) {
    assert.ok(s.punish, s.id + ': a firing scenario must show how it is punished');
    const { bd, castling, epSq } = load(s);

    // 1. user plays the trap move
    const uf = sq(s.userMove.from), ut = sq(s.userMove.to);
    let cur   = ctx.applyMove(uf, ut, bd, epSq, 'Q');
    let curEp = ctx.computeEP(uf, ut, bd);
    let curCs = ctx.updateCastling(uf, ut, bd[uf], castling);

    // 2. the committed premove fires
    const pf = sq(s.premove.from), pt = sq(s.premove.to);
    const premovedPiece = cur[pf];
    assert.ok(premovedPiece, s.id + ': premoved piece vanished');
    const prev = cur;
    cur   = ctx.applyMove(pf, pt, cur, curEp, 'Q');
    curEp = ctx.computeEP(pf, pt, prev);
    curCs = ctx.updateCastling(pf, pt, premovedPiece, curCs);

    // 3. the punish move must be legal and must capture the premoved piece
    const kf = sq(s.punish.from), kt = sq(s.punish.to);
    const punisher = cur[kf];
    assert.ok(punisher, s.id + ': no piece on ' + s.punish.from + ' to punish with');
    assert.equal(punisher.color, 'w', s.id + ': the punish move must be White\'s');
    const legal = ctx.legalMovesFor(kf, cur, curEp, curCs);
    assert.ok(legal.includes(kt),
      s.id + ': punish ' + s.punish.san + ' is not legal (legal: ' + legal.map(nm).join(',') + ')');

    const victim = cur[kt];
    assert.ok(victim, s.id + ': punish move captures nothing');
    assert.equal(victim.color, 'b', s.id + ': punish must capture a black piece');
    assert.equal(kt, pt, s.id + ': punish should capture the piece that just premoved onto ' + nm(pt));

    // 4. and it must be a real win — the captured piece must outvalue whatever
    //    the premove took, otherwise the "trap" is not a trap at all.
    const VAL = { P:1, N:3, B:3, R:5, Q:9, K:0 };
    const taken = prev[pt]; // what the premove captured, if anything
    const gain  = VAL[victim.piece] - (taken ? VAL[taken.piece] : 0);
    assert.ok(gain > 0,
      s.id + ': the punish nets ' + gain + ' — the premove must lose material for this to teach a trap');
  }
});

test('the doom square marked on the firing scenario is where the piece is lost', () => {
  for (const s of SCENARIOS.filter(x => x.fires && x.punish)) {
    assert.equal(s.doomSq, s.premove.to,
      s.id + ': the doom highlight should sit on the square the premove walked into');
  }
});

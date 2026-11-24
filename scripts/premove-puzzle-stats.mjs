// Measure every candidate premove puzzle, dropping none, so the filter in
// rank-premove-puzzles.mjs can be set from the data rather than guessed.
//
// For each puzzle in the build_data.py output this records:
//
// Predictability (the app's own Maia, as rank-premove-puzzles.mjs runs it)
//   expected, expectedP  Maia's top move at the solver's rating, and its probability
//   premoveP             P(premove | expected) at the premover's rating (the rank gate)
//   playedP, premovePlayed   the same two for the move actually played
//   q                    sum over every solver move F of P(F) * P(premove | F), where
//                        the premove is still legal after F: the chance a player at
//                        the premover's rating would answer whatever the solver plays
//                        with this premove. Robust premoves score here; the rank gate
//                        only sees one F.
//   qTop                 the largest single term of q (how much one F carries)
//   legalMass            P(F) summed over the F that leave the premove legal
//   oldGate              what rank-premove-puzzles.mjs would do: kept | forced | premove | exploit
//
// Exploit quality (from the stored tables; no engine)
//   best, exploit        best win% if the premove fires; best minus wpRoot (rank's EXPLOIT_MIN)
//   nSolve, nKeep, nLegal    first moves that solve it / keep the premove legal / are legal
//   gapNext              best minus the second-best first move (any move)
//   gapOut               best minus the best first move that does NOT solve it
//   gap2                 for the answer: best follow-up minus the second-best (cash-in clarity)
//   riskWp, riskCp       wpRoot minus the answer's win% if they reply normally, in win% and in
//                        centipawns. Win% flattens near 0 and 100, so riskWp understates the
//                        cost of a bad move in a lost position; riskCp does not.
//   cpRoot               wpRoot as centipawns
//   maia1500             as in the rank script
//
// Clocks (only with the games file: fetch_games.py output for the puzzles' game IDs)
//   solverClock, premoverClock   centiseconds on each clock when the position arose
//   solverThink          centiseconds the solver spent on the move actually played
//   playedWasPremove     the solver's own move was a premove too
//   streak               premoves the premover made in a row, up to and including the move
//                        before the puzzle
//   recentRate           share of the premover's last 5 moves (first move excluded) premoved
//   clockCheck           the puzzle's premove really took 0 cs (sanity check of the ply index)
//
// Needs the server on :3100 (PORT=3100 node server.js). From the repo root:
//   node scripts/premove-puzzle-stats.mjs <puzzles.json> <out.json> [games.ndjson]
// Prints a summary at the end. `--summary <out.json>` reprints it without Maia.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3100';
const SLACK = 8;            // PZ_SLACK in src/68-premove-puzzles.js
const BATCH = 48;           // positions per Maia inference
const K = 0.00368208;       // Lichess win% <-> centipawns
const cp = wp => { const w = Math.min(99.5, Math.max(0.5, wp)); return Math.round(-Math.log(100 / w - 1) / K); };

const args = process.argv.slice(2);
if (args[0] === '--summary') { summarize(JSON.parse(fs.readFileSync(args[1], 'utf8')).puzzles); process.exit(0); }
const [inPath, outPath, gamesPath] = args;
if (!inPath || !outPath) {
  console.error('usage: node scripts/premove-puzzle-stats.mjs <puzzles.json> <out.json> [games.ndjson]\n' +
                '       node scripts/premove-puzzle-stats.mjs --summary <out.json>');
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const games = new Map();
if (gamesPath) {
  for (const line of fs.readFileSync(gamesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    games.set(g.id, g);
  }
}

// ── Clocks ────────────────────────────────────────────────────────────────
// clocks[i] is the mover's time left after ply i. A ply that cost nothing was
// a premove (mine.py). Each side's first move is never charged, so plies 0
// and 1 can't be classed either way.
function clockStats(p) {
  const g = games.get(p.id);
  if (!g || !g.clocks || !g.clock) return null;
  const c = g.clocks, inc = g.clock.increment * 100, init = g.clock.initial * 100;
  const pre = k => (k >= 2 && k < c.length ? c[k - 2] - c[k] + inc === 0 : null);
  const ply = p.ply;                       // index of the move the solver actually played
  let streak = 0;
  for (let k = ply - 1; k >= 2 && pre(k); k -= 2) streak++;
  const recent = [];
  for (let k = ply - 1; k >= 2 && recent.length < 5; k -= 2) recent.push(pre(k));
  return {
    solverClock: ply >= 2 ? c[ply - 2] : init,
    premoverClock: ply >= 1 ? c[ply - 1] : init,
    solverThink: ply >= 2 ? c[ply - 2] - c[ply] + inc : null,
    playedWasPremove: pre(ply),
    streak,
    recentRate: recent.length ? Math.round(recent.filter(Boolean).length / recent.length * 100) / 100 : null,
    clockCheck: pre(ply + 1),
  };
}

// ── Exploit quality, from the stored tables ───────────────────────────────
function tableStats(p, nLegal) {
  const first = Object.entries(p.moves).map(([u, v]) => [u, v[0]]).sort((a, b) => b[1] - a[1]);
  const best = first[0][1];
  const solve = new Set([...p.accept, ...first.filter(([, w]) => w >= best - SLACK).map(([u]) => u)]);
  const out = first.filter(([u]) => !solve.has(u));
  const sec = p.second && p.second[p.answer] ? Object.values(p.second[p.answer]).sort((a, b) => b - a) : [];
  const ans = p.moves[p.answer];
  return {
    solving: [...solve],
    best, exploit: Math.round((best - p.wpRoot) * 10) / 10,
    nSolve: solve.size, nKeep: first.length, nLegal,
    gapNext: first.length > 1 ? Math.round((best - first[1][1]) * 10) / 10 : null,
    gapOut: out.length ? Math.round((best - out[0][1]) * 10) / 10 : null,
    gap2: sec.length > 1 ? Math.round((sec[0] - sec[1]) * 10) / 10 : null,
    riskWp: ans ? Math.round((p.wpRoot - ans[1]) * 10) / 10 : null,
    riskCp: ans ? cp(p.wpRoot) - cp(ans[1]) : null,
    cpRoot: cp(p.wpRoot),
  };
}

// ── Maia ──────────────────────────────────────────────────────────────────
async function maiaStats(page, p) {
  return page.evaluate(async ([p, BATCH]) => {
    const clamp = r => Math.max(600, Math.min(2600, r || 1500));
    const alias = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
    // One inference for many positions; each entry is [fen, selfElo, oppoElo].
    async function probsMany(list) {
      const out = [];
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH), n = chunk.length;
        const tokens = new Float32Array(n * 768);
        chunk.forEach(([fen], j) => tokens.set(_maiaEncode(fen).tokens, j * 768));
        const id = _maiaNextId++;
        const res = await new Promise((resolve, reject) => {
          _maiaPendingInferences.set(id, { resolve, reject });
          _maiaWorker.postMessage({
            type: 'inference', id, tokens: tokens.buffer, batchSize: n,
            eloSelfs: Float32Array.from(chunk.map(c => clamp(c[1]))).buffer,
            eloOppos: Float32Array.from(chunk.map(c => clamp(c[2]))).buffer,
          }, [tokens.buffer]);
        });
        const lm = res.logitsMove.length / n, lv = res.logitsValue.length / n;
        chunk.forEach(([fen], j) => {
          const raw = _maiaProcess(fen, res.logitsMove.subarray(j * lm, (j + 1) * lm),
            res.logitsValue.subarray(j * lv, (j + 1) * lv), _maiaLegalMask(fen)) || {};
          const norm = {};
          for (const [u, pr] of Object.entries(raw)) norm[alias[u] || u] = (norm[alias[u] || u] || 0) + pr;
          out.push(norm);
        });
      }
      return out;
    }
    // The position after one move, with the app's own rules (as rank-premove-puzzles.mjs).
    function after(fen, uci) {
      const f = fen.split(' ');
      const bd = parseFenBoard(fen);
      const cst = { wK: f[2].includes('K'), wQ: f[2].includes('Q'), bK: f[2].includes('k'), bQ: f[2].includes('q') };
      const ep = f[3] && f[3] !== '-' ? fileRankToSq(f[3]) : -1;
      const m = uciToSq(uci), pc = bd[m.from];
      return boardToFen(applyMove(m.from, m.to, bd, ep, m.promo), f[1] === 'w' ? 'b' : 'w',
        updateCastling(m.from, m.to, pc, cst), computeEP(m.from, m.to, bd),
        pc.piece === 'P' || bd[m.to] ? 0 : (+f[4] || 0) + 1, (+f[5] || 1) + (f[1] === 'b' ? 1 : 0));
    }
    const R = p.premove.slice(0, 4);
    const pR = probs => Object.entries(probs).filter(([u]) => u.slice(0, 4) === R).reduce((s, [, x]) => s + x, 0);

    const [mine, m1500] = await probsMany([[p.fen, p.solverRating, p.premoverRating], [p.fen, 1500, 1500]]);
    const legal = _fenLegalUcis(p.fen);
    const kids = [];
    for (const F of legal) {
      const fen = after(p.fen, F);
      if (_fenLegalUcis(fen).some(u => u.slice(0, 4) === R)) kids.push({ F, fen });
    }
    const theirs = await probsMany(kids.map(k => [k.fen, p.premoverRating, p.solverRating]));
    const pRgiven = {};
    kids.forEach((k, i) => { pRgiven[k.F] = pR(theirs[i]); });

    const [expected, expectedP] = Object.entries(mine).sort((a, b) => b[1] - a[1])[0];
    let q = 0, qTop = 0, legalMass = 0;
    for (const k of kids) {
      const t = (mine[k.F] || 0) * pRgiven[k.F];
      q += t; qTop = Math.max(qTop, t); legalMass += mine[k.F] || 0;
    }
    return {
      nLegal: legal.length, expected, expectedP,
      premoveP: pRgiven[expected] || 0,
      playedP: mine[p.playedUci] || 0, premovePlayed: pRgiven[p.playedUci] || 0,
      q, qTop, legalMass, m1500,
    };
  }, [p, BATCH]);
}

const r3 = x => Math.round(x * 1000) / 1000;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => { localStorage.setItem('bm_welcomed', '1'); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  if (!_maiaWorker) { maiaInit(); _maiaLoadMappings(); }
  setTimeout(() => { if (!_maiaReady) maiaDownloadModel(); }, 1500);
});
await page.waitForFunction(() => _maiaReady === true, null, { timeout: 300000, polling: 500 });
await page.evaluate(() => _maiaLoadMappings());
console.log('Maia ready');

const rows = [];
const t0 = Date.now();
for (let i = 0; i < doc.puzzles.length; i++) {
  const p = doc.puzzles[i];
  const m = await maiaStats(page, p);
  const t = tableStats(p, m.nLegal);
  const maia1500 = t.solving.reduce((s, u) => s + (m.m1500[u] || 0), 0);
  // rank-premove-puzzles.mjs, step for step
  const oldGate = m.expectedP < 0.8 ? 'forced' : m.premoveP < 0.8 ? 'premove' : t.exploit < 20 ? 'exploit' : 'kept';
  const { solving, ...tRest } = t;
  rows.push({
    id: p.id, ply: p.ply, solver: p.solver, solverRating: p.solverRating, premoverRating: p.premoverRating,
    fen: p.fen, played: p.played, premove: p.premoveSan, answer: p.answerSan, wpRoot: p.wpRoot, stalemate: p.stalemate,
    expected: m.expected, expectedP: r3(m.expectedP), premoveP: r3(m.premoveP),
    playedP: r3(m.playedP), premovePlayed: r3(m.premovePlayed),
    q: r3(m.q), qTop: r3(m.qTop), legalMass: r3(m.legalMass), oldGate,
    ...tRest, maia1500: r3(maia1500),
    ...(clockStats(p) || {}),
  });
  if ((i + 1) % 25 === 0) console.log(`${i + 1}/${doc.puzzles.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
await browser.close();

// The same position and premove from different games.
const key = r => r.fen.split(' ').slice(0, 4).join(' ') + ' ' + r.premove;
const seen = {};
for (const r of rows) seen[key(r)] = (seen[key(r)] || 0) + 1;
for (const r of rows) r.recur = seen[key(r)];

fs.writeFileSync(outPath, JSON.stringify({
  source: inPath, games: gamesPath || null, made: new Date().toISOString(), puzzles: rows,
}, null, 0));
console.log(`wrote ${outPath}: ${rows.length} puzzles`);
summarize(rows);

// ── Summary ───────────────────────────────────────────────────────────────
function summarize(rows) {
  const q = (xs, f) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : '-'; };
  const line = (name, xs) => console.log(name.padEnd(16) + [0.1, 0.25, 0.5, 0.75, 0.9].map(f => String(q(xs, f)).padStart(8)).join(''));
  const col = k => rows.map(r => r[k]);
  console.log(`\n${rows.length} puzzles. Quantiles:` + '\n' + ''.padEnd(16) + ['p10', 'p25', 'p50', 'p75', 'p90'].map(s => s.padStart(8)).join(''));
  for (const k of ['expectedP', 'premoveP', 'playedP', 'premovePlayed', 'q', 'qTop', 'legalMass',
    'exploit', 'nSolve', 'gapNext', 'gapOut', 'gap2', 'riskWp', 'riskCp', 'maia1500',
    'premoverClock', 'solverClock', 'solverThink', 'streak', 'recentRate']) line(k, col(k));
  const gates = {};
  for (const r of rows) gates[r.oldGate] = (gates[r.oldGate] || 0) + 1;
  console.log('\nrank-premove-puzzles.mjs as it stands:', JSON.stringify(gates));
  console.log('\nKept with exploit >= 20 and q >= ...');
  const ok = rows.filter(r => r.exploit >= 20);
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.64]) {
    const k = ok.filter(r => r.q >= t);
    const lost = k.filter(r => r.wpRoot < 25).length;
    console.log(`  q >= ${String(t).padEnd(5)} ${String(k.length).padStart(4)}   (${lost} from a lost position, wpRoot < 25)`);
  }
}

// Where in a Chess960 game does Maia 3 start predicting human moves as well as
// it does in standard chess?
//
// Maia 3 was trained on standard blitz games only, so the opening of a 960 game
// is new to it. This scores the shipped model (models/maia3_simplified.onnx,
// through the same encoding, legal mask and 960 castle mapping the site uses,
// copied out of src/40-engines.js) on the first 20 moves of human blitz games:
// N Chess960 games and N standard games as the control, the control matched to
// the 960 set game for game by average rating. Per move number it reports how
// often Maia's top move is the move actually played, how often it is in Maia's
// top 3, and the mean probability Maia gave the played move.
//
// Three steps, data in a directory you choose (keep the downloads OUT of the repo):
//   node scripts/measure-maia-960-opening.mjs select <standard.pgn.zst> <chess960.pgn.zst> <dir> [N=500] [seed=960]
//   python -E -P scripts/maia-opening-positions.py <dir>
//   node scripts/measure-maia-960-opening.mjs eval <dir>
//
// The .pgn.zst files are Lichess database months (database.lichess.org). A
// truncated download (curl -r 0-79999999) is fine: the files are pzstd-framed,
// so every whole frame decodes on its own and a cut-off last frame is skipped.
// Use a month after July 2025 so no game was in Maia 3's training data.
//
// Ratings: the model is given the mover's Lichess rating as elo_self and the
// opponent's as elo_oppo (what it was trained on). The site itself sends
// elo_oppo = elo_self; this measures the model, not that choice.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import vm from 'vm';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MOVES = 20;            // full moves scored per game (40 plies)

// ── select ──────────────────────────────────────────────────────────────────

function* pzstdGames(file) {
  // Each zstd frame is preceded by a 12-byte skippable frame whose payload is
  // the next frame's compressed size. Node's streaming decoder rejects the
  // skippable frames, so walk them by hand and decode frame by frame.
  const b = fs.readFileSync(file);
  let p = 0, rest = '';
  while (p + 12 <= b.length) {
    if ((b.readUInt32LE(p) & 0xFFFFFFF0) !== 0x184D2A50) break;
    const skip = b.readUInt32LE(p + 4), size = b.readUInt32LE(p + 8);
    p += 8 + skip;
    if (p + size > b.length) break;                 // truncated last frame
    const text = rest + zlib.zstdDecompressSync(b.subarray(p, p + size),
      { params: { [zlib.constants.ZSTD_d_windowLogMax]: 31 } }).toString('utf8');
    p += size;
    const parts = text.split(/\n\n(?=\[Event )/);
    rest = parts.pop();                              // may continue in the next frame
    for (const g of parts) yield g;
  }
}

function header(g, tag) {
  const m = g.match(new RegExp('^\\[' + tag + ' "([^"]*)"\\]', 'm'));
  return m ? m[1] : null;
}

function eligible(g, want960) {
  const tc = header(g, 'TimeControl');
  if (!tc || tc === '-') return null;
  const [base, inc] = tc.split('+').map(Number);
  const est = base + 40 * inc;
  if (!(est >= 180 && est < 480)) return null;                       // Lichess blitz
  if (header(g, 'WhiteTitle') === 'BOT' || header(g, 'BlackTitle') === 'BOT') return null;
  const we = Number(header(g, 'WhiteElo')), be = Number(header(g, 'BlackElo'));
  if (!(we >= 600 && we <= 2700 && be >= 600 && be <= 2700)) return null;
  if (!g.includes('[%clk') || !new RegExp('\\b' + MOVES + '\\.\\.\\. ').test(g)) return null;  // has clocks, lasts 20 moves
  const is960 = header(g, 'Variant') === 'Chess960';
  if (is960 !== want960) return null;
  if (is960) { const fen = header(g, 'FEN'); if (!fen || fen === STANDARD_START) return null; }
  return { g, bin: Math.floor((we + be) / 2 / 100) };
}

function rng(seed) {                                   // mulberry32
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function select(stdFile, f960File, dir, n = 500, seed = 960) {
  fs.mkdirSync(dir, { recursive: true });
  const r = rng(seed);
  const pool960 = [], poolStd = [];
  for (const g of pzstdGames(f960File)) { const e = eligible(g, true); if (e) pool960.push(e); }
  for (const g of pzstdGames(stdFile)) { const e = eligible(g, false); if (e) poolStd.push(e); }
  console.log(`eligible: 960 ${pool960.length}, standard ${poolStd.length}`);
  if (pool960.length < n) throw new Error('not enough 960 games');
  const pick960 = shuffle(pool960, r).slice(0, n);
  const byBin = {};
  for (const e of shuffle(poolStd, r)) (byBin[e.bin] ||= []).push(e);
  const pickStd = [];
  for (const e of pick960) {                       // same rating bin, else the nearest one left
    let d = 0, got = null;
    while (!got && d < 30) { for (const b of [e.bin - d, e.bin + d]) if (!got && byBin[b] && byBin[b].length) got = byBin[b].pop(); d++; }
    if (!got) throw new Error('control pool ran out');
    pickStd.push(got);
  }
  fs.writeFileSync(path.join(dir, '960.pgn'), pick960.map(e => e.g).join('\n\n') + '\n');
  fs.writeFileSync(path.join(dir, 'std.pgn'), pickStd.map(e => e.g).join('\n\n') + '\n');
  const avg = a => (a.reduce((s, e) => s + e.bin, 0) / a.length * 100 + 50).toFixed(0);
  console.log(`wrote ${n} + ${n} games; mean average rating 960 ${avg(pick960)}, standard ${avg(pickStd)}`);
}

// ── eval ────────────────────────────────────────────────────────────────────

function extractFunction(src, name) {
  const start = src.search(new RegExp('^(async )?function ' + name + '\\(', 'm'));
  if (start < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}

function loadSiteMaia() {
  const ctx = { document: { getElementById: () => null }, indActive: () => false, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', '20-chess-core.js'), 'utf8'), ctx);
  const eng = fs.readFileSync(path.join(ROOT, 'src', '40-engines.js'), 'utf8');
  const fns = ['_maiaSquare', '_maiaMove', '_maiaSwapRank', '_maiaSwapCastling', '_maiaFlipFen', '_maiaEncode', '_maiaLegalMask', '_maiaProcess']
    .map(n => extractFunction(eng, n)).join('\n\n');
  ctx._maia3MoveIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'all_moves_maia3.json'), 'utf8'));
  ctx._maia3MoveReversed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'all_moves_maia3_reversed.json'), 'utf8'));
  vm.runInContext('var _maia3MoveIndex = this._maia3MoveIndex, _maia3MoveReversed = this._maia3MoveReversed;\n' + fns, ctx);
  return ctx;
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

async function evaluate(dir) {
  const positions = JSON.parse(fs.readFileSync(path.join(dir, 'positions.json'), 'utf8'));
  const ctx = loadSiteMaia();
  const ORT = require(path.join(ROOT, 'ort', 'ort.wasm.min.js'));
  ORT.env.wasm.wasmPaths = { mjs: pathToFileURL(path.join(ROOT, 'ort', 'ort-wasm-simd-threaded.mjs')).href };
  ORT.env.wasm.wasmBinary = fs.readFileSync(path.join(ROOT, 'ort', 'ort-wasm-simd-threaded.wasm'));
  ORT.env.wasm.numThreads = 1;              // the threaded path fetches its worker script, which Node's fetch cannot do from disk
  const session = await ORT.InferenceSession.create(fs.readFileSync(path.join(ROOT, 'models', 'maia3_simplified.onnx')));

  const B = 64, t0 = Date.now();
  let missing = 0;
  for (let s = 0; s < positions.length; s += B) {
    const batch = positions.slice(s, s + B);
    const tokens = new Float32Array(batch.length * 64 * 12), masks = [];
    batch.forEach((q, i) => {
      ctx.setChess960(q.set === '960');
      ctx.parseFen(q.fen);                       // sets the 960 rook files the legal mask castles with
      tokens.set(ctx._maiaEncode(q.fen).tokens, i * 768);
      masks.push(ctx._maiaLegalMask(q.fen));
    });
    const out = await session.run({
      tokens: new ORT.Tensor('float32', tokens, [batch.length, 64, 12]),
      elo_self: new ORT.Tensor('float32', Float32Array.from(batch.map(q => q.elo_self)), [batch.length]),
      elo_oppo: new ORT.Tensor('float32', Float32Array.from(batch.map(q => q.elo_oppo)), [batch.length]),
    });
    const L = out.logits_move.data, V = L.length / batch.length;
    batch.forEach((q, i) => {
      const probs = ctx._maiaProcess(q.fen, L.subarray(i * V, (i + 1) * V), null, masks[i]);
      const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]).map(e => e[0]);
      const rank = ranked.indexOf(q.uci);
      if (rank < 0) missing++;
      q.p = probs[q.uci] || 0; q.top1 = rank === 0; q.top3 = rank >= 0 && rank < 3;
    });
    if (s === 0 || (s / B) % 100 === 0) process.stdout.write(`\r${s + batch.length}/${positions.length} positions, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.log(`\rscored ${positions.length} positions in ${((Date.now() - t0) / 1000).toFixed(0)} s; played move missing from Maia's legal list: ${missing}`);

  const rows = [];
  for (let m = 1; m <= MOVES; m++) {
    const row = { move: m };
    for (const set of ['960', 'std']) {
      const qs = positions.filter(q => q.set === set && q.move_no === m && !q.dropped);
      const k = qs.filter(q => q.top1).length;
      row[set] = { n: qs.length, top1: k / qs.length, ci: wilson(k, qs.length),
        top3: qs.filter(q => q.top3).length / qs.length, p: qs.reduce((a, q) => a + q.p, 0) / qs.length };
    }
    rows.push(row);
  }
  const dropped = positions.filter(q => q.dropped).length;
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ rows, dropped, missing, n: positions.length }, null, 1));
  const pc = x => (100 * x).toFixed(1).padStart(5);
  console.log(`positions dropped (mover under 30 s, as in Maia 3 training): ${dropped}\n`);
  console.log('move |  960 top1 [95% CI]   top3  p(played) |  std top1 [95% CI]   top3  p(played) | gap top1');
  for (const r of rows) {
    const a = r['960'], b = r.std;
    console.log(`${String(r.move).padStart(4)} | ${pc(a.top1)} [${pc(a.ci[0])},${pc(a.ci[1])}] ${pc(a.top3)}  ${pc(a.p)}    | ${pc(b.top1)} [${pc(b.ci[0])},${pc(b.ci[1])}] ${pc(b.top3)}  ${pc(b.p)}    | ${pc(a.top1 - b.top1)}`);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'select') select(args[0], args[1], args[2], Number(args[3] || 500), Number(args[4] || 960));
else if (cmd === 'eval') await evaluate(args[0]);
else console.log('usage: select <standard.pgn.zst> <chess960.pgn.zst> <dir> [N] [seed]  |  eval <dir>');

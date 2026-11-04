// Order the premove puzzles from easy to hard, by how often a 1500 player would
// find the first move: Maia 1500's probability for the moves that solve it
// (the accepted answers, plus any reply scoring within 8 win% points of the
// best). The most "forced-looking" first move is the easiest puzzle.
//
// Runs the app's own Maia in a headless browser, so the numbers are the ones
// the board would give. Needs the server running on :3100
// (PORT=3100 node server.js). From repo root:
//   node scripts/rank-premove-puzzles.mjs <in.json> [out.json]
// out defaults to data/premove-puzzles.json. Adds `maia1500` to each puzzle.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3100';
const SLACK = 8;      // PZ_SLACK in src/68-premove-puzzles.js
const [inPath, outPath = 'data/premove-puzzles.json'] = process.argv.slice(2);
if (!inPath) { console.error('usage: node scripts/rank-premove-puzzles.mjs <in.json> [out.json]'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => { localStorage.setItem('bm_welcomed', '1'); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  if (!_maiaWorker) { maiaInit(); _maiaLoadMappings(); }
  setTimeout(() => { if (!_maiaReady) maiaDownloadModel(); }, 1500);
});
await page.waitForFunction(() => _maiaReady === true, null, { timeout: 300000, polling: 500 });
console.log('Maia ready');

const solving = p => {
  let best = 0;
  for (const k in p.moves) best = Math.max(best, p.moves[k][0]);
  return [...new Set([...p.accept, ...Object.keys(p.moves).filter(u => p.moves[u][0] >= best - SLACK)])];
};

for (let i = 0; i < doc.puzzles.length; i++) {
  const p = doc.puzzles[i];
  const probs = await page.evaluate(fen => maia3GetMoveProbs(fen, 1500), p.fen);
  if (!probs) throw new Error('Maia returned nothing for ' + p.id);
  // Maia names castling king-to-rook in some mappings; count either spelling.
  const alias = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
  const norm = {};
  for (const [u, pr] of Object.entries(probs)) norm[alias[u] || u] = (norm[alias[u] || u] || 0) + pr;
  p.maia1500 = Math.round(solving(p).reduce((s, u) => s + (norm[u] || 0), 0) * 1000) / 1000;
  if ((i + 1) % 100 === 0) console.log(`${i + 1}/${doc.puzzles.length}`);
}
await browser.close();

// Stable: equal probabilities keep the mining order (biggest swing first).
doc.puzzles = doc.puzzles.map((p, i) => [p, i]).sort((a, b) => b[0].maia1500 - a[0].maia1500 || a[1] - b[1]).map(x => x[0]);
doc.order = 'easiest first: Maia 1500 probability of a solving first move';
fs.writeFileSync(outPath, JSON.stringify(doc));
const q = doc.puzzles.map(p => p.maia1500);
console.log(`wrote ${outPath}: ${q.length} puzzles, easiest ${q[0]}, median ${q[Math.floor(q.length / 2)]}, hardest ${q[q.length - 1]}`);

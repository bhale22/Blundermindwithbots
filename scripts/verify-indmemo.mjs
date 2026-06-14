// Verification for the indApply() memoization guard (item 3).
// Proves: (1) a true-duplicate call SKIPS the heavy recompute,
//         (2) toggling an indicator FORCES a recompute (no false skip),
//         (3) exploration (preview board) FORCES a recompute.
// Method: checkThreatSquaresW is reassigned on every full indApply() body run,
// so we plant a sentinel value and see whether the body overwrote it.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800); // let startup (loadPos/indApply) settle

// Sanity: the symbols we drive must be reachable in page scope.
const env = await page.evaluate(() => ({
  hasIndApply: typeof indApply === 'function',
  hasSig: typeof indSignature === 'function',
  hasCT: typeof checkThreatSquaresW !== 'undefined',
  hasIND: typeof IND !== 'undefined',
}));
check('page exposes indApply/indSignature/state', env.hasIndApply && env.hasSig && env.hasCT && env.hasIND, JSON.stringify(env));

// (1) duplicate call skips; (2) stored signature is stable across duplicates.
const r1 = await page.evaluate(() => {
  if (typeof clearPreview === 'function') clearPreview();
  indApply();                              // full run at live position
  const sigA = _indLastSig;
  checkThreatSquaresW = new Set([999]);    // sentinel
  indApply();                              // identical call → expect SKIP
  const skipped = checkThreatSquaresW.has(999);
  return { sigA, sigB: _indLastSig, skipped };
});
check('duplicate call skips recompute (sentinel survives)', r1.skipped === true);
check('signature stable across duplicate calls', r1.sigA === r1.sigB);

// (3) toggling an indicator changes the signature and forces a recompute.
const r2 = await page.evaluate(() => {
  checkThreatSquaresW = new Set([999]);
  const before = _indLastSig;
  IND.forksw.on = !IND.forksw.on;          // change the active-indicator set
  indApply();
  const out = { changed: before !== _indLastSig, recomputed: !checkThreatSquaresW.has(999) };
  IND.forksw.on = !IND.forksw.on; indApply(); // restore
  return out;
});
check('toggling indicator changes signature', r2.changed === true);
check('toggling indicator forces recompute (no false skip)', r2.recomputed === true);

// (4) queen-pins math toggle forces a recompute even at the same position.
const r3 = await page.evaluate(() => {
  const qp = document.getElementById('cbQPins');
  if (!qp) return { skip: true };
  checkThreatSquaresW = new Set([999]);
  const was = qp.checked;
  qp.checked = !was;
  indApply();
  const recomputed = !checkThreatSquaresW.has(999);
  qp.checked = was; indApply();            // restore
  return { recomputed };
});
check('queen-pins toggle forces recompute', r3.skip || r3.recomputed === true, r3.skip ? 'no cbQPins element' : '');

// (5) exploration (preview board) forces a recompute — the critical property.
const r4 = await page.evaluate(() => {
  const from = 52, to = 36;                // e2 -> e4 (sq = r*8+c, a8=0)
  previewBoard    = applyMove(from, to, board, epSq, 'Q');
  previewEpSq     = computeEP(from, to, board);
  previewCastling = updateCastling(from, to, board[from], castling);
  previewAtk      = buildAtk(previewBoard);
  checkThreatSquaresW = new Set([999]);
  indApply();                              // different position → expect recompute
  const recomputed = !checkThreatSquaresW.has(999);
  if (typeof clearPreview === 'function') clearPreview();
  indApply();
  return { recomputed };
});
check('exploration (preview) forces recompute', r4.recomputed === true);

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

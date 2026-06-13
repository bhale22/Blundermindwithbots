#!/usr/bin/env node
/**
 * build.js — assemble blundermind.html from the src/ parts.
 *
 * The served page is the simple concatenation of the files listed below,
 * in order. server.js does the same assembly in memory at request time,
 * so running this script is OPTIONAL — use it only when you want a
 * standalone single-file blundermind.html (e.g. to share or deploy
 * statically without the Node server).
 *
 *   node build.js            → writes blundermind.html
 *   node build.js --check    → assembles and prints the byte count only
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');

// Concatenated in this exact order. 00/90 carry the markup + <script> tags;
// everything between is one continuous JavaScript scope (same as the
// original monolith — load order matters, do not reorder).
const SRC_PARTS = [
  '00-head.html',     // <!DOCTYPE> … CSS … board markup … opening <script>
  '10-app-shell.js',  // shared state, panels, chat, clock, multiplayer, prefs, replay
  '20-chess-core.js', // FEN, attacks, pins, legality, SAN — pure chess facts
  '30-board-ui.js',   // sounds, moves/premoves, preview, render, overlays, indicators
  '40-engines.js',    // Stockfish workers, Maia3, Lichess explorer, ECO, opening book
  '50-bot-engine.js', // pressure curves, attractors, think time, botMakeMove, ghost
  '60-bot-ui.js',     // bot panel UI, opening prefs, save/load, config bridge
  '90-tail.html',     // closing </script>, bot modal markup, </body></html>
];

function assemble() {
  return Buffer.concat(
    SRC_PARTS.map(f => fs.readFileSync(path.join(SRC_DIR, f)))
  );
}

if (require.main === module) {
  const out = assemble();
  if (process.argv.includes('--check')) {
    console.log('Assembled', out.length, 'bytes from', SRC_PARTS.length, 'parts');
  } else {
    fs.writeFileSync(path.join(__dirname, 'blundermind.html'), out);
    console.log('Wrote blundermind.html (' + out.length + ' bytes)');
  }
}

module.exports = { assemble, SRC_PARTS, SRC_DIR };

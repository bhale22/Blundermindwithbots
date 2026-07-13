const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Stockfish: vendored in repo (vendor/), cached in memory, served locally ──
// Previously fetched from jsDelivr at startup, but jsDelivr refuses the
// stockfish npm package ("Package size exceeded the configured limit of 150 MB")
// and the error text was being served — and parsed — as the engine script.
let sfScript = null, sfEtag = null;
let sfWasm = null, sfWasmEtag = null;
try {
  sfScript = fs.readFileSync(path.join(__dirname, 'vendor', 'stockfish-18-lite-single.js'));
  sfWasm   = fs.readFileSync(path.join(__dirname, 'vendor', 'stockfish-18-lite-single.wasm'));
  sfEtag     = '"' + crypto.createHash('md5').update(sfScript).digest('hex') + '"';
  sfWasmEtag = '"' + crypto.createHash('md5').update(sfWasm).digest('hex') + '"';
  console.log(`Stockfish loaded (js ${(sfScript.length/1024).toFixed(0)} KB, wasm ${(sfWasm.length/1048576).toFixed(1)} MB)`);
} catch (e) {
  console.warn('Stockfish vendor files missing — ghost/bot will not work:', e.message);
}

// ── Cache the assembled page in memory with ETag so repeat visitors get 304 ──
// The page is assembled by concatenating the src/ parts (see build.js for the
// list and order) — the result is identical to the old single-file
// blundermind.html. Falls back to a prebuilt blundermind.html if src/ is
// missing (e.g. a deployment that only ships the built artifact).
const { assemble, SRC_PARTS, SRC_DIR } = require('./build.js');

let htmlCache = null;
let htmlEtag  = null;
let htmlStamp = null;

function loadHtml() {
  let stamp, read;
  if (fs.existsSync(SRC_DIR)) {
    stamp = SRC_PARTS.map(f => fs.statSync(path.join(SRC_DIR, f)).mtimeMs).join(',');
    read = assemble;
  } else {
    const filePath = path.join(__dirname, 'blundermind.html');
    stamp = String(fs.statSync(filePath).mtimeMs);
    read = () => fs.readFileSync(filePath);
  }
  if (htmlStamp === stamp) return; // unchanged
  htmlCache = read();
  htmlStamp = stamp;
  htmlEtag  = '"'  + crypto.createHash('md5').update(htmlCache).digest('hex') + '"';
  console.log('HTML cached', (htmlCache.length/1024).toFixed(0), 'KB, ETag:', htmlEtag);
}
loadHtml();

// Serve Maia3 model and support files
app.get('/models/:file', (req, res) => {
  const file = req.params.file;
  if (!/^maia3[a-z0-9_\-.]*\.onnx$/.test(file)) { res.status(404).end(); return; }
  const p = path.join(__dirname, 'models', file);
  if (!require('fs').existsSync(p)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
  res.sendFile(p);
});

app.get('/ort/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[\w.\-]+$/.test(file)) { res.status(404).end(); return; }
  const p = path.join(__dirname, 'ort', file);
  if (!require('fs').existsSync(p)) { res.status(404).end(); return; }
  const ct = file.endsWith('.wasm') ? 'application/wasm'
           : file.endsWith('.mjs')  ? 'application/javascript'
           : 'application/javascript';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'public, max-age=2592000');
  res.sendFile(p);
});

app.get('/data/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[\w.\-]+\.(json|tsv)$/.test(file)) { res.status(404).end(); return; }
  const contentType = file.endsWith('.tsv') ? 'text/tab-separated-values' : 'application/json';
  const p = path.join(__dirname, 'data', file);
  if (!require('fs').existsSync(p)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
  res.sendFile(p);
});

// ── Lichess Masters explorer proxy ───────────────────────────────────────────
// The masters endpoint blocks browser-origin requests. We proxy it server-side
// so there's no Origin header. Responses are cached in-process for 24h.
const _mastersCache = new Map();
const MASTERS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.get('/api/masters', (req, res) => {
  const play  = (req.query.play  || '').replace(/[^a-zA-Z0-9,]/g, '');
  const moves = Math.min(parseInt(req.query.moves) || 10, 20);
  const cacheKey = play + ':' + moves;

  const cached = _mastersCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MASTERS_CACHE_TTL) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cached.body);
  }

  const upstream = 'https://explorer.lichess.ovh/masters' +
    '?play=' + encodeURIComponent(play) +
    '&moves=' + moves +
    '&topGames=0&recentGames=0';

  https.get(upstream, { headers: { 'User-Agent': 'Blundermind/1.0' } }, (upstream_res) => {
    const chunks = [];
    upstream_res.on('data', c => chunks.push(c));
    upstream_res.on('end', () => {
      const body = Buffer.concat(chunks);
      if (upstream_res.statusCode === 200) {
        _mastersCache.set(cacheKey, { body, ts: Date.now() });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Cache', 'MISS');
        res.send(body);
      } else {
        console.warn('Masters proxy upstream error:', upstream_res.statusCode);
        res.status(upstream_res.statusCode).send(body);
      }
    });
  }).on('error', e => {
    console.error('Masters proxy fetch error:', e.message);
    res.status(502).json({ error: 'Masters proxy error', detail: e.message });
  });
});

app.get('/maia-worker.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'maia-worker.js'));
});

app.get('/bot-control-panel.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'bot-control-panel.html'));
});

app.get('/Bot_Controls_Technical_Brief.pdf', (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Bot_Controls_Technical_Brief.pdf"');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'Bot_Controls_Technical_Brief.pdf'));
});

// Serve Stockfish — long cache (content never changes for this version)
app.get('/stockfish.js', (req, res) => {
  if (!sfScript) { res.status(503).send('// Stockfish not yet loaded'); return; }
  if (req.headers['if-none-match'] === sfEtag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  res.setHeader('ETag', sfEtag);
  res.send(sfScript);
});

// The loader derives its wasm path from its own URL: /stockfish.js → /stockfish.wasm
app.get('/stockfish.wasm', (req, res) => {
  if (!sfWasm) { res.status(503).end(); return; }
  if (req.headers['if-none-match'] === sfWasmEtag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/wasm');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  res.setHeader('ETag', sfWasmEtag);
  res.send(sfWasm);
});

// Serve HTML — short cache with ETag so deploys propagate quickly
function serveHtml(req, res) {
  loadHtml(); // re-check if file changed (cheap stat call)
  if (req.headers['if-none-match'] === htmlEtag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
  res.setHeader('ETag', htmlEtag);
  res.send(htmlCache);
}
app.get('/', serveHtml);
app.get('/blundermind.html', serveHtml);

// ── Multiplayer room system ───────────────────────────────────────────────────
const rooms = {};
// Open lobby challenges: code → { code, name, rating, ratingRange, tc, tcLabel, tcBaseMin, tcIncSec }
const lobbyChallenges = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms[code]); // regenerate on (rare) collision with a live room
  return code;
}

// Detach a socket from whatever room it's in (used when it creates a new one
// without leaving — otherwise the old room leaks with a stale reference).
function leaveCurrentRoom(ws) {
  const room = ws.roomCode && rooms[ws.roomCode];
  if (!room) return;
  const opponent = ws.role === 'white' ? room.black : room.white;
  if (opponent && opponent.readyState === 1) {
    opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
  }
  if (ws.role === 'white' && lobbyChallenges[ws.roomCode]) {
    delete lobbyChallenges[ws.roomCode];
    broadcastLobbyList();
  }
  if (ws.role === 'white') room.white = null; else room.black = null;
  if (!room.white && !room.black) delete rooms[ws.roomCode];
  ws.roomCode = null;
  ws.role = null;
}

function broadcastLobbyList() {
  const challenges = Object.values(lobbyChallenges);
  const payload = JSON.stringify({ type: 'lobby_list', challenges });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Clean up stale rooms every 10 minutes
setInterval(() => {
  for (const code in rooms) {
    const room = rooms[code];
    const wDead = !room.white || room.white.readyState > 1;
    const bDead = !room.black || room.black.readyState > 1;
    if (wDead && bDead) {
      delete rooms[code];
      const wasLobby = delete lobbyChallenges[code];
      console.log('Cleaned stale room', code, wasLobby ? '(lobby)' : '');
    }
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'create') {
      leaveCurrentRoom(ws); // creating again replaces any room this socket holds
      const code = generateRoomCode();
      const isLobby = !!msg.lobby;
      rooms[code] = {
        white: ws, black: null, created: Date.now(),
        lobby: isLobby,
        tc: msg.tc || 'untimed',
        tcBaseMin: msg.tcBaseMin || 0,
        tcIncSec:  msg.tcIncSec  || 0,
      };
      ws.roomCode = code;
      ws.role = 'white';
      ws.send(JSON.stringify({ type: 'created', code, role: 'white', lobby: isLobby }));
      if (isLobby) {
        lobbyChallenges[code] = {
          code,
          name:        String(msg.name || 'Anonymous').slice(0, 40),
          rating:      msg.rating || null,
          ratingType:  ['Lichess', 'Chess.com', 'FIDE'].includes(msg.ratingType) ? msg.ratingType : null,
          ratingRange: msg.ratingRange || 9999,
          tc:          msg.tc || 'untimed',
          tcLabel:     msg.tcLabel || 'Untimed',
          tcBaseMin:   msg.tcBaseMin || 0,
          tcIncSec:    msg.tcIncSec  || 0,
        };
        broadcastLobbyList();
      }

    } else if (msg.type === 'join') {
      const code = msg.code?.toUpperCase();
      const room = rooms[code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
      if (room.black) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full' })); return; }
      room.black = ws;
      ws.roomCode = code;
      ws.role = 'black';
      // Remove from lobby challenges — it's now a live game
      if (lobbyChallenges[code]) {
        delete lobbyChallenges[code];
        broadcastLobbyList();
      }
      ws.send(JSON.stringify({ type: 'joined', code, role: 'black',
        tc: room.tc, tcBaseMin: room.tcBaseMin, tcIncSec: room.tcIncSec }));
      if (room.white && room.white.readyState === 1) {
        room.white.send(JSON.stringify({ type: 'opponent_joined',
          tc: room.tc, tcBaseMin: room.tcBaseMin, tcIncSec: room.tcIncSec }));
      }

    } else if (msg.type === 'lobby_list') {
      ws.send(JSON.stringify({ type: 'lobby_list', challenges: Object.values(lobbyChallenges) }));

    } else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const opponent = ws.role === 'white' ? room.black : room.white;
      if (opponent && opponent.readyState === 1) {
        const relay = { type: 'move', move: msg.move };
        if (typeof msg.timeW === 'number') relay.timeW = msg.timeW;
        if (typeof msg.timeB === 'number') relay.timeB = msg.timeB;
        opponent.send(JSON.stringify(relay));
      }

    } else if (msg.type === 'ping') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const opponent = ws.role === 'white' ? room.black : room.white;
      if (opponent && opponent.readyState === 1) {
        opponent.send(JSON.stringify({ type: 'opponent_ping' }));
      }

    } else if (['resign','rematch','rematch_offer','rematch_declined','timeout','chat','draw_offer','draw_accept','draw_decline'].includes(msg.type)) {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const opponent = ws.role === 'white' ? room.black : room.white;
      if (opponent && opponent.readyState === 1) {
        if (msg.type === 'chat') {
          const text = String(msg.text || '').slice(0, 200);
          opponent.send(JSON.stringify({ type: 'chat', text }));
        } else if (msg.type === 'timeout') {
          // Preserve which color flagged — the receiver must not assume it
          // was the sender (both clients detect the same flag locally).
          const color = msg.color === 'w' || msg.color === 'b' ? msg.color : null;
          opponent.send(JSON.stringify({ type: 'timeout', color }));
        } else {
          opponent.send(JSON.stringify({ type: msg.type }));
        }
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if (!room) return;
    const opponent = ws.role === 'white' ? room.black : room.white;
    if (opponent && opponent.readyState === 1) {
      opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
    // If lobby host disconnects, remove the open challenge
    if (ws.role === 'white' && lobbyChallenges[ws.roomCode]) {
      delete lobbyChallenges[ws.roomCode];
      broadcastLobbyList();
    }
    if (ws.role === 'white') room.white = null;
    else room.black = null;
    if (!room.white && !room.black) delete rooms[ws.roomCode];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blundermind running on port ${PORT}`);
});

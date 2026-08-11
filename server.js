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
const MASTERS_CACHE_MAX = 5000; // ~a few MB; Map keeps insertion order → drop oldest

// Light per-IP rate limit so one client can't use us as an open Lichess proxy
// (and get our server IP throttled upstream, breaking openings for everyone).
// 60 upstream-bound requests/min is far above real gameplay; cache hits are free.
// Shared by BOTH explorer proxies below — one budget per IP, not one each.
const _explorerRate = new Map(); // ip → { count, windowStart }
const EXPLORER_RATE_LIMIT = 60, EXPLORER_RATE_WINDOW = 60 * 1000;
function explorerRateOk(ip) {
  const now = Date.now();
  let r = _explorerRate.get(ip);
  if (!r || now - r.windowStart > EXPLORER_RATE_WINDOW) {
    r = { count: 0, windowStart: now };
    _explorerRate.set(ip, r);
  }
  if (_explorerRate.size > 10000) { // prune stale windows
    for (const [k, v] of _explorerRate) {
      if (now - v.windowStart > EXPLORER_RATE_WINDOW) _explorerRate.delete(k);
    }
  }
  return ++r.count <= EXPLORER_RATE_LIMIT;
}

const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';

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

  // Only misses (which hit the upstream) count against the rate limit
  if (!explorerRateOk(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limited — try again in a minute' });
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
        if (_mastersCache.size >= MASTERS_CACHE_MAX) {
          _mastersCache.delete(_mastersCache.keys().next().value); // evict oldest
        }
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

// ── Lichess player-games explorer proxy ──────────────────────────────────────
// Unlike /masters, this endpoint DOES accept browser requests — which is how
// the client came to call it directly, and why the privacy policy's promise
// that "your IP address and identity are never shared with Lichess" had
// quietly stopped being true. It goes through here for that reason alone.
// Do not reintroduce a direct explorer.lichess.ovh call from the client.
//
// Queried two ways: by `fen` (a single position) and by `play` (a move list).
const _lichessCache = new Map();
const LICHESS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6h — live stats drift, slowly
const LICHESS_CACHE_MAX = 5000;

app.get('/api/lichess', (req, res) => {
  // FEN keeps letters/digits plus the '/', ' ' and '-' its fields are made of.
  const fen     = (req.query.fen     || '').replace(/[^a-zA-Z0-9/ -]/g, '').slice(0, 100);
  const play    = (req.query.play    || '').replace(/[^a-zA-Z0-9,]/g, '');
  const ratings = (req.query.ratings || '').replace(/[^0-9,]/g, '');
  const speeds  = (req.query.speeds  || '').replace(/[^a-z,]/g,  '');
  const moves   = Math.min(parseInt(req.query.moves) || 10, 20);
  if (!fen && !play) return res.status(400).json({ error: 'need fen or play' });

  const cacheKey = [fen, play, ratings, speeds, moves].join('|');
  const cached = _lichessCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LICHESS_CACHE_TTL) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cached.body);
  }

  if (!explorerRateOk(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limited — try again in a minute' });
  }

  const upstream = 'https://explorer.lichess.ovh/lichess?' +
    (fen ? 'fen=' + encodeURIComponent(fen) : 'play=' + encodeURIComponent(play)) +
    (ratings ? '&ratings=' + encodeURIComponent(ratings) : '') +
    (speeds  ? '&speeds='  + encodeURIComponent(speeds)  : '') +
    '&moves=' + moves + '&topGames=0&recentGames=0';

  https.get(upstream, { headers: { 'User-Agent': 'Blundermind/1.0' } }, (upstream_res) => {
    const chunks = [];
    upstream_res.on('data', c => chunks.push(c));
    upstream_res.on('end', () => {
      const body = Buffer.concat(chunks);
      if (upstream_res.statusCode === 200) {
        if (_lichessCache.size >= LICHESS_CACHE_MAX) {
          _lichessCache.delete(_lichessCache.keys().next().value); // evict oldest
        }
        _lichessCache.set(cacheKey, { body, ts: Date.now() });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=21600');
        res.setHeader('X-Cache', 'MISS');
        res.send(body);
      } else {
        console.warn('Lichess proxy upstream error:', upstream_res.statusCode);
        res.status(upstream_res.statusCode).send(body);
      }
    });
  }).on('error', e => {
    console.error('Lichess proxy fetch error:', e.message);
    res.status(502).json({ error: 'Lichess proxy error', detail: e.message });
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

// ── Briefs ──────────────────────────────────────────────────────────────────
// These are HTML, not PDF: they read properly on a phone (a letter-size PDF
// means pinch-zooming every paragraph), they carry print CSS so the browser's
// Save-as-PDF still produces a clean document, and they're editable without
// regenerating anything. The old PDF route is kept below so existing links and
// bookmarks don't 404 — nothing in the app points at it any more.
['Blundermind_Bot_Controls_Reference.html',
 'Blundermind_Bot_Controls_Technical.html'].forEach((file) => {
  app.get('/' + file, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(__dirname, file));
  });
});

// Legacy: superseded by the HTML briefs above. Retained for old links only.
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

// ── PWA: manifest, service worker, icons ────────────────────────────────────
// The manifest is generated rather than a static file because the two domains
// are two products: buildabotchess.com opens the Expert board, everything else
// is Blundermind (same split 00-head.html makes client-side). Installing from
// either should give you that one, named correctly, with its own start URL.
app.get('/manifest.webmanifest', (req, res) => {
  const isBab = /(^|\.)buildabotchess\.com$/i.test(req.hostname || '');
  const name = isBab ? 'Build-A-Bot Chess' : 'Blundermind';
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    name,
    short_name: name,
    description: isBab
      ? 'Build a chess bot with a personality, then play it.'
      : 'Stop getting blundermined. Board vision training for novice chess players.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0e0f11',
    theme_color: '#0e0f11',
    categories: ['games', 'education'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// ── Privacy policy ──────────────────────────────────────────────────────────
// Play requires a publicly reachable privacy policy URL, with no login, before
// an app can be published; the Data safety form links to it. Served from here
// rather than a third-party host so it shares the domain the app is verified
// against, and so it can't quietly 404 from somewhere we don't control.
//
// /privacy is the canonical URL. /privacy.html is accepted because that is what
// people type — a redirect keeps one URL in Play's console and in the listing.
app.get('/privacy.html', (req, res) => res.redirect(301, '/privacy'));
app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short cache: a policy needs to be correctable quickly, and it is 5 KB.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// ── Digital Asset Links — proves this domain and the Android app are ours ───
// A Trusted Web Activity is the site running full-screen inside Chrome. Chrome
// only drops the address bar if it can verify that whoever signed the Android
// app also controls this domain, and this file is that proof: the app's
// package name plus the SHA-256 fingerprint(s) of the signing key.
//
// Configured by environment, not committed, so the same code serves staging
// and production and the fingerprint can be set once the key exists:
//   TWA_PACKAGE_NAME       com.example.app
//   TWA_CERT_FINGERPRINTS  AA:BB:…  (comma-separated for more than one)
//
// TWO fingerprints are normal. With Play App Signing, Google re-signs the app
// with a key it holds, so the fingerprint users actually get is Google's — the
// one shown in Play Console under "App signing key certificate". Listing only
// your local upload key is the usual reason a TWA ships with a visible URL
// bar. List both and either path verifies.
const TWA_FP_RE = /^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/i;
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = (process.env.TWA_PACKAGE_NAME || '').trim();
  const fingerprints = (process.env.TWA_CERT_FINGERPRINTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Not configured yet: 404 rather than an empty-but-valid file. A served-but-
  // failing assetlinks is indistinguishable from a wrong one when debugging.
  if (!pkg || !fingerprints.length) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'assetlinks not configured',
      hint: 'set TWA_PACKAGE_NAME and TWA_CERT_FINGERPRINTS' });
    return;
  }
  const bad = fingerprints.filter((f) => !TWA_FP_RE.test(f));
  if (bad.length) {
    // Loud rather than silently unverifiable — this only shows up otherwise as
    // an address bar in the shipped app.
    console.error('[twa] ignoring malformed SHA-256 fingerprint(s):', bad.join(' '));
  }
  const good = fingerprints.filter((f) => TWA_FP_RE.test(f));
  if (!good.length) { res.setHeader('Cache-Control', 'no-store'); res.status(500).json({ error: 'no valid fingerprints' }); return; }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Short: Chrome caches its verification result anyway, and a long TTL means
  // living with a wrong fingerprint for as long as it takes to expire.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: pkg,
      sha256_cert_fingerprints: good.map((f) => f.toUpperCase()),
    },
  }]);
});

// Must be served from the root for its scope to cover the whole app, and must
// never be cached hard or a bad worker becomes very hard to replace.
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// Browsers request /favicon.ico by default whether or not it is declared, so
// serving one avoids a 404 on every cold load — and a 404 is part of why some
// browsers kept showing a stale cached icon.
app.get('/favicon.ico', (req, res) => {
  const p = path.join(__dirname, 'favicon.ico');
  if (!fs.existsSync(p)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'image/x-icon');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  res.sendFile(p);
});

// Self-hosted fonts. These used to come from fonts.gstatic.com, which sent
// every visitor's IP to Google — see fonts/README.md. Immutable content, so a
// long cache is safe and keeps repeat loads free.
app.get('/fonts/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[\w.\-]+\.(woff2|css)$/.test(file)) { res.status(404).end(); return; }
  const p = path.join(__dirname, 'fonts', file);
  if (!fs.existsSync(p)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'font/woff2');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(p);
});

app.get('/icons/:file', (req, res) => {
  if (!/^[\w.-]+\.png$/.test(req.params.file)) { res.status(404).end(); return; }
  const p = path.join(__dirname, 'icons', req.params.file);
  if (!fs.existsSync(p)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  res.sendFile(p);
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

// Serve beautifulblundermind.html with same caching strategy
let prettyHtmlCache = null, prettyHtmlEtag = null, prettyHtmlMtime = null;
function loadPrettyHtml() {
  const filePath = path.join(__dirname, 'beautifulblundermind.html');
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (prettyHtmlMtime && stat.mtimeMs === prettyHtmlMtime) return;
  prettyHtmlCache = fs.readFileSync(filePath);
  prettyHtmlMtime = stat.mtimeMs;
  prettyHtmlEtag  = '"' + crypto.createHash('md5').update(prettyHtmlCache).digest('hex') + '"';
  console.log('Beautiful HTML cached', (prettyHtmlCache.length/1024).toFixed(0), 'KB');
}
loadPrettyHtml();
app.get('/beautifulblundermind.html', (req, res) => {
  loadPrettyHtml();
  if (!prettyHtmlCache) { res.status(404).send('Not found'); return; }
  if (req.headers['if-none-match'] === prettyHtmlEtag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', prettyHtmlEtag);
  res.send(prettyHtmlCache);
});

// ── Multiplayer room system ───────────────────────────────────────────────────
//
// Rooms used to hold nothing but two sockets: moves were relayed and forgotten.
// That made a dropped connection unrecoverable — a phone backgrounding the tab
// for a moment lost a game both players might have spent hours on, because
// there was no state anywhere to come back to.
//
// A room now also carries the authoritative move list and clocks, and each
// player holds a token identifying their seat. A returning client presents the
// token and gets the game replayed to it. Seats are RESERVED rather than freed
// on disconnect (once the game has started), so a stranger cannot take the
// place of someone who is mid-reconnect.
//
// The protocol additions are all additive: a client that never sends `resume`
// behaves exactly as before, which keeps players on an already-loaded page
// working across a deploy.
const rooms = {};

// How long a started game survives with nobody connected. Long enough for a
// phone to be locked, a tab to be discarded, or a train to go through a tunnel;
// short enough that abandoned games do not accumulate.
const MP_RESUME_GRACE_MS = 15 * 60 * 1000;

function mpToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// A seat is claimed once someone has occupied it, whether or not they are
// currently connected. Used instead of `!room.white` so a reconnecting player's
// seat is not handed to a stranger.
function seatClaimed(room, role) {
  return !!(room.tokens && room.tokens[role]);
}

// Everything a returning client needs to rebuild the game exactly.
function roomStatePayload(room, role) {
  return {
    role,
    tc: room.tc,
    tcBaseMin: room.tcBaseMin,
    tcIncSec: room.tcIncSec,
    startFen: room.startFen || undefined,
    startSans: room.startSans || undefined,
    moves: room.moves || [],
    timeW: (typeof room.timeW === 'number') ? room.timeW : undefined,
    timeB: (typeof room.timeB === 'number') ? room.timeB : undefined,
    over: !!room.over,
  };
}
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
  // Any socket in a room that still has a lobby entry IS the host (a join
  // deletes the entry immediately) — hosts can be black since host-colour
  // choice, so don't gate this on role or the challenge ghosts for 10 min.
  if (lobbyChallenges[ws.roomCode]) {
    delete lobbyChallenges[ws.roomCode];
    broadcastLobbyList();
  }
  // A deliberate leave gives up the seat for good, so clear the token too —
  // otherwise the room would linger for the full resume grace period.
  if (room.tokens) room.tokens[ws.role] = null;
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

// Clean up stale rooms. Runs every minute rather than every ten so the resume
// grace window is honoured with reasonable precision.
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const room = rooms[code];
    const wDead = !room.white || room.white.readyState > 1;
    const bDead = !room.black || room.black.readyState > 1;
    if (!(wDead && bDead)) continue;
    // A started, unfinished game is held for the grace window so a player whose
    // phone dropped the connection can still come back to it.
    const resumable = room.started && !room.over &&
                      (seatClaimed(room, 'white') || seatClaimed(room, 'black'));
    const emptySince = room.emptySince || now;
    if (resumable && (now - emptySince) < MP_RESUME_GRACE_MS) continue;
    delete rooms[code];
    const wasLobby = delete lobbyChallenges[code];
    console.log('Cleaned stale room', code, wasLobby ? '(lobby)' : '');
  }
}, 60 * 1000);

// Protocol-level heartbeat. Without one, a client that vanishes without a
// clean close — a phone going to sleep, a tunnel dropping — leaves a half-open
// socket that 'close' does not fire for until the OS TCP timeout, which can be
// many minutes. For a lobby host that means a withdrawn-in-practice challenge
// stays on everyone's board, and whoever clicks Join lands in a dead room.
// Terminating the socket runs the normal close handler, which drops the
// challenge and re-broadcasts the list.
//
// This does not shorten the resume grace for a game in progress: close() keeps
// a started, unfinished room alive for MP_RESUME_GRACE_MS either way. It only
// makes the disconnect *noticed* within ~60s instead of whenever TCP gives up.
const WS_HEARTBEAT_MS = 30 * 1000;
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, WS_HEARTBEAT_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    if (msg.type === 'create') {
      leaveCurrentRoom(ws); // creating again replaces any room this socket holds
      const code = generateRoomCode();
      const isLobby = !!msg.lobby;
      // Optional custom start position ("play from here" invites, private only):
      // sanitized, stored on the room, handed to the joiner. Clients validate
      // the FEN themselves; the server just relays a bounded string.
      const startFen = (!isLobby && typeof msg.startFen === 'string' &&
                        msg.startFen.length <= 120 && /^[\w\/\- ]+$/.test(msg.startFen))
        ? msg.startFen : null;
      const startSans = (startFen && Array.isArray(msg.startSans))
        ? msg.startSans.slice(0, 600).map(s => String(s).slice(0, 12))
        : null;
      // Host colour preference: white / black / random (resolved here so the
      // assignment is authoritative for both clients).
      const hostRole = msg.hostColor === 'black' ? 'black'
                     : msg.hostColor === 'white' ? 'white'
                     : (Math.random() < 0.5 ? 'white' : 'black');
      // Bounded numeric/string helpers — these values get broadcast to every
      // connected client via the lobby list, so clamp them to sane ranges
      // rather than trusting the client (garbage in would otherwise fan out
      // site-wide as-is).
      const boundedNum = (v, def, min, max) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
      };
      const tcBaseMin = boundedNum(msg.tcBaseMin, 0, 0, 180);
      const tcIncSec  = boundedNum(msg.tcIncSec, 0, 0, 60);
      rooms[code] = {
        white: null, black: null, created: Date.now(),
        lobby: isLobby,
        tc: msg.tc || 'untimed',
        tcBaseMin, tcIncSec,
        startFen, startSans,
        // Authoritative game state, so a reconnecting client can be rebuilt.
        moves: [], timeW: null, timeB: null,
        started: false, over: false,
        tokens: { white: null, black: null },
        emptySince: null,
      };
      rooms[code][hostRole] = ws;
      ws.roomCode = code;
      ws.role = hostRole;
      const hostToken = mpToken();
      rooms[code].tokens[hostRole] = hostToken;
      ws.seatToken = hostToken;
      ws.send(JSON.stringify({ type: 'created', code, role: hostRole, lobby: isLobby, token: hostToken }));
      if (isLobby) {
        lobbyChallenges[code] = {
          code,
          name:        String(msg.name || 'Anonymous').slice(0, 40),
          rating:      boundedNum(msg.rating, null, 0, 4000),
          ratingType:  ['Lichess', 'Chess.com', 'FIDE'].includes(msg.ratingType) ? msg.ratingType : null,
          ratingRange: boundedNum(msg.ratingRange, 9999, 0, 9999),
          tc:          String(msg.tc || 'untimed').slice(0, 20),
          tcLabel:     String(msg.tcLabel || 'Untimed').slice(0, 20),
          tcBaseMin, tcIncSec,
        };
        broadcastLobbyList();
      }

    } else if (msg.type === 'join') {
      const code = msg.code?.toUpperCase();
      const room = rooms[code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
      // The joiner takes whichever colour the host didn't pick. Keyed on the
      // seat token rather than the live socket: a seat whose player is
      // mid-reconnect is still theirs, and must not be handed to a stranger.
      const openRole = !seatClaimed(room, 'white') ? 'white'
                     : (!seatClaimed(room, 'black') ? 'black' : null);
      if (!openRole) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full' })); return; }
      room[openRole] = ws;
      ws.roomCode = code;
      ws.role = openRole;
      const joinToken = mpToken();
      room.tokens[openRole] = joinToken;
      ws.seatToken = joinToken;
      room.started = true;      // both seats taken — the game is live
      room.emptySince = null;
      const host = openRole === 'white' ? room.black : room.white;
      // Remove from lobby challenges — it's now a live game
      if (lobbyChallenges[code]) {
        delete lobbyChallenges[code];
        broadcastLobbyList();
      }
      ws.send(JSON.stringify({ type: 'joined', code, role: openRole, token: joinToken,
        tc: room.tc, tcBaseMin: room.tcBaseMin, tcIncSec: room.tcIncSec,
        startFen: room.startFen || undefined, startSans: room.startSans || undefined }));
      if (host && host.readyState === 1) {
        host.send(JSON.stringify({ type: 'opponent_joined',
          tc: room.tc, tcBaseMin: room.tcBaseMin, tcIncSec: room.tcIncSec,
          startFen: room.startFen || undefined, startSans: room.startSans || undefined }));
      }

    } else if (msg.type === 'resume') {
      // A client coming back after its page was reloaded or discarded. The
      // token proves which seat is theirs; without it we would have no way to
      // tell them from someone guessing a room code.
      const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
      const room = rooms[code];
      if (!room) {
        ws.send(JSON.stringify({ type: 'resume_failed', reason: 'gone' })); return;
      }
      const token = typeof msg.token === 'string' ? msg.token : '';
      const role = (token && room.tokens.white === token) ? 'white'
                 : (token && room.tokens.black === token) ? 'black' : null;
      if (!role) {
        ws.send(JSON.stringify({ type: 'resume_failed', reason: 'denied' })); return;
      }
      // Drop any socket still sitting in this seat (a zombie from the old page)
      // before taking it over, so the room never holds two sockets for one seat.
      const stale = room[role];
      if (stale && stale !== ws) {
        stale.roomCode = null; stale.role = null;
        try { stale.close(); } catch (e) {}
      }
      leaveCurrentRoom(ws);
      room[role] = ws;
      ws.roomCode = code;
      ws.role = role;
      ws.seatToken = token;
      room.emptySince = null;
      ws.send(JSON.stringify(Object.assign({ type: 'resumed', code }, roomStatePayload(room, role))));
      const other = role === 'white' ? room.black : room.white;
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: 'opponent_reconnected' }));
      }

    } else if (msg.type === 'lobby_list') {
      ws.send(JSON.stringify({ type: 'lobby_list', challenges: Object.values(lobbyChallenges) }));

    } else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      // Nothing counts before both seats are taken. A room exists from the
      // moment a challenge is posted, and its host is free to explore the board
      // while waiting — those moves must not enter the game history, or the
      // first reconnect after someone joins would rebuild the game from the
      // host's idle shuffling.
      if (!room.started) return;
      // Record before relaying. The clients still validate each other's moves;
      // this list exists so a reconnecting player can be rebuilt, and is only
      // ever replayed through the same legality checks on the client.
      const mv = msg.move;
      if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to) &&
          mv.from >= 0 && mv.from <= 63 && mv.to >= 0 && mv.to <= 63) {
        const promo = ['Q', 'R', 'B', 'N'].includes(mv.promo) ? mv.promo : null;
        room.moves.push({ from: mv.from, to: mv.to, promo });
        // Bound the history so a pathological client cannot grow it forever.
        if (room.moves.length > 800) room.moves.shift();
      }
      if (typeof msg.timeW === 'number') room.timeW = msg.timeW;
      if (typeof msg.timeB === 'number') room.timeB = msg.timeB;

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
      // Track terminal and restart events so the room knows whether it still
      // holds a game worth resuming.
      if (msg.type === 'resign' || msg.type === 'timeout' || msg.type === 'draw_accept') {
        room.over = true;
      } else if (msg.type === 'rematch') {
        room.moves = []; room.timeW = null; room.timeB = null; room.over = false;
      }
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
    // A resume already re-bound this seat to a newer socket — this close is the
    // old zombie going away, and must not disturb the live game.
    if (room[ws.role] && room[ws.role] !== ws) return;

    const opponent = ws.role === 'white' ? room.black : room.white;
    if (opponent && opponent.readyState === 1) {
      opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
    // If the lobby host disconnects, remove the open challenge. The host can
    // be either colour (host-colour choice), so no role check — any occupant
    // of a room that still has a lobby entry is its host.
    if (lobbyChallenges[ws.roomCode]) {
      delete lobbyChallenges[ws.roomCode];
      broadcastLobbyList();
    }
    if (ws.role === 'white') room.white = null;
    else room.black = null;

    if (!room.white && !room.black) {
      // A started, unfinished game is kept alive for the resume grace window
      // instead of being deleted the instant both sides drop. This is the
      // whole point: two people an hour into a game should not lose it because
      // a phone locked. The sweeper collects it once the window expires.
      if (room.started && !room.over &&
          (seatClaimed(room, 'white') || seatClaimed(room, 'black'))) {
        room.emptySince = Date.now();
      } else {
        delete rooms[ws.roomCode];
      }
    }
  });
});

// Defense-in-depth: this is a single process serving every concurrent game,
// so an unexpected error in any handler should never take the whole server
// down. Individual handlers should still catch what they can; these are a
// last-resort backstop.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept alive):', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blundermind running on port ${PORT}`);
});

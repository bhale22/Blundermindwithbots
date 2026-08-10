/* Blundermind service worker.
   ───────────────────────────────────────────────────────────────────────────
   Goal: the app opens and plays with no network. Everything needed for that is
   already local — Maia runs in a worker, Stockfish is WASM — so the only thing
   missing was keeping the files around.

   Three deliberate decisions:

   1. /models/ IS NEVER TOUCHED HERE. maia-worker.js already stores the 44MB
      Maia net in the Cache API under 'maia-model-<version>' and reads it back
      itself. Caching it again here would double it to 88MB on disk and the two
      copies would expire independently. If you ever change the model caching,
      change it there, not here.

   2. The shell precache is deliberately small (HTML + manifest + icons). The
      heavy static assets — ORT is 12MB, Stockfish 7MB — are cached on FIRST
      USE instead, so installing the app doesn't mean a 20MB download before
      anything renders. Play one game and you are offline-capable.

   3. /api/ is never cached. Those are the Lichess and masters-database
      proxies: opening-book data that is meaningless stale, and useless
      offline. They fail, and the app already falls back to engine play.
*/

const VERSION = 'v1';
const SHELL   = 'bm-shell-'   + VERSION;
const RUNTIME = 'bm-runtime-' + VERSION;
const KEEP    = [SHELL, RUNTIME];

// Small, and needed before anything can render.
const SHELL_URLS = [
  '/',
  '/blundermind.html',
  '/bot-control-panel.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Immutable-ish assets, cached the first time they're requested.
const RUNTIME_PATHS = [
  '/ort/', '/vendor/', '/data/', '/icons/', '/fonts/',
  '/stockfish.js', '/stockfish.wasm', '/maia-worker.js',
];
// Fonts are served from this origin now (see fonts/README.md), so they are
// covered by RUNTIME_PATHS above and no cross-origin font host is contacted.
const FONT_HOSTS = [];

const isRuntimeAsset = (url) =>
  RUNTIME_PATHS.some((p) => p.endsWith('/') ? url.pathname.startsWith(p) : url.pathname === p);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll() is atomic — one 404 and nothing is cached, which would leave the
    // app permanently un-installable. Add individually and tolerate misses.
    await Promise.all(SHELL_URLS.map((u) =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      // Only ever drop OUR old versions. 'maia-model-*' belongs to the worker.
      if (n.startsWith('bm-') && !KEEP.includes(n)) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Hands off: the worker owns the model cache; the proxies must stay live.
  if (sameOrigin && (url.pathname.startsWith('/models/') || url.pathname.startsWith('/api/'))) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback
  // so the app still opens on a plane.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        return (await caches.match(req))
            || (await caches.match('/blundermind.html'))
            || (await caches.match('/'))
            || Response.error();
      }
    })());
    return;
  }

  const cacheable = (sameOrigin && isRuntimeAsset(url)) || FONT_HOSTS.includes(url.hostname);
  if (!cacheable) return;

  // Cache first: these are versioned or effectively immutable, and they are the
  // slow ones (12MB of ORT, 7MB of Stockfish).
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      // Opaque responses (cross-origin fonts) are cached too — they replay
      // fine, and losing the typeface offline is a visible downgrade.
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        const cache = await caches.open(RUNTIME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      return Response.error();
    }
  })());
});

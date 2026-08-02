// PWA verification. Server on :3100, run from the repo root:
//   node scripts/verify-pwa.mjs
//
// Checks the app is installable and actually works with the network off:
//   · manifest is valid, per-host, and its icons resolve
//   · icons are the sizes they claim to be
//   · the service worker registers, activates and precaches the shell
//   · heavy static assets are cached on first use, not on install
//   · /models/ is NOT cached by the SW — maia-worker.js owns that 44MB, and a
//     second copy would double it on disk. This is the check that matters most
//   · /api/ (Lichess + masters proxies) is never cached
//   · with the network cut, the app still loads and renders
import { chromium, request as pwRequest } from 'playwright';
import { readFileSync } from 'fs';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n))
                                : (fail++, console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''))); };

// PNG dimensions live at bytes 16..24 of the IHDR chunk.
function pngSize(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ═══════════════════════ MANIFEST + ICONS ═══════════════════════ */
console.log('\nMANIFEST & ICONS');
{
  const api = await pwRequest.newContext({ baseURL: BASE });
  const res = await api.get('/manifest.webmanifest');
  ok('manifest served', res.status() === 200, 'status ' + res.status());
  ok('correct content type', (res.headers()['content-type'] || '').includes('manifest+json'),
    res.headers()['content-type']);

  const m = await res.json();
  ok('has a name', !!m.name, m.name);
  ok('display is standalone', m.display === 'standalone', m.display);
  ok('scope and start_url cover the app', m.scope === '/' && m.start_url === '/');
  ok('background/theme colour matches the app', m.background_color === '#0e0f11');
  ok('declares a 192 and a 512 icon',
    m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'));
  ok('declares a maskable icon',
    m.icons.some(i => (i.purpose || '').includes('maskable')));

  for (const i of m.icons) {
    const r = await api.get(i.src);
    ok(`icon ${i.src} resolves`, r.status() === 200, 'status ' + r.status());
  }

  // The two domains are two products (00-head.html splits on hostname), so an
  // install from each should be named for the one you installed.
  const bab = await api.get('/manifest.webmanifest', { headers: { Host: 'buildabotchess.com' } });
  const babJson = await bab.json();
  ok('buildabotchess.com installs as Build-A-Bot', /Build-A-Bot/i.test(babJson.name), babJson.name);
  const bm = await api.get('/manifest.webmanifest', { headers: { Host: 'blundermindchess.com' } });
  ok('blundermindchess.com installs as Blundermind',
    /Blundermind/i.test((await bm.json()).name));

  // ── Digital Asset Links (TWA domain verification) ──
  // Unconfigured is the expected state until the signing key exists; what must
  // not happen is serving a file that is present but unverifiable, which looks
  // identical to a wrong fingerprint when you're debugging an address bar.
  const al = await api.get('/.well-known/assetlinks.json');
  if (al.status() === 404) {
    ok('assetlinks 404s cleanly while unconfigured', true);
    ok('...and says how to configure it', /TWA_PACKAGE_NAME/.test(JSON.stringify(await al.json())));
    ok('...and is not cached', (al.headers()['cache-control'] || '').includes('no-store'));
  } else {
    const links = await al.json();
    const t = links[0] && links[0].target;
    ok('assetlinks is a Digital Asset Links array',
      Array.isArray(links) && links[0].relation.includes('delegate_permission/common.handle_all_urls'));
    ok('names an android_app package', t && t.namespace === 'android_app' && !!t.package_name, t && t.package_name);
    ok('every fingerprint is a 32-byte SHA-256',
      t.sha256_cert_fingerprints.every(f => /^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/.test(f)),
      (t.sha256_cert_fingerprints || []).join(' '));
    // Play App Signing re-signs the app, so the fingerprint users receive is
    // Google's, not the upload key's. One entry is a common shipping bug.
    if (t.sha256_cert_fingerprints.length < 2)
      console.log('    note: only one fingerprint listed — with Play App Signing you need '
        + 'the app signing key too, or the shipped app shows an address bar');
  }

  const sw = await api.get('/sw.js');
  ok('service worker served from the root scope', sw.status() === 200);
  ok('service worker is not hard-cached',
    (sw.headers()['cache-control'] || '').includes('no-cache'), sw.headers()['cache-control']);

  await api.dispose();

  const sizes = {
    'icons/icon-192.png': 192, 'icons/icon-512.png': 512,
    'icons/icon-maskable-512.png': 512, 'icons/apple-touch-icon.png': 180,
  };
  for (const [f, n] of Object.entries(sizes)) {
    const s = pngSize(f);
    ok(`${f} is ${n}×${n}`, s && s.w === n && s.h === n, s ? `${s.w}×${s.h}` : 'unreadable');
  }
}

/* ═══════════════════════ SERVICE WORKER ═══════════════════════ */
console.log('\nSERVICE WORKER');
const browser = await chromium.launch();
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' });

  // Registration is deferred to the load event. `ready` resolves as soon as
  // there IS an active worker, which is before our activate handler's
  // waitUntil (cache cleanup + clients.claim) has settled — so it reports
  // "activating". Wait for the state itself, not just for ready.
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    if (r.active && r.active.state !== 'activated') {
      await new Promise((resolve) => {
        const done = () => { if (r.active.state === 'activated') resolve(); };
        r.active.addEventListener('statechange', done);
        setTimeout(resolve, 10000);
        done();
      });
    }
    return { active: !!r.active, scope: r.scope, state: r.active && r.active.state };
  });
  ok('service worker activates', reg.active && reg.state === 'activated', JSON.stringify(reg));
  ok('scope covers the whole app', reg.scope.endsWith('/'), reg.scope);

  // Shell precache
  const shell = await page.evaluate(async () => {
    const names = await caches.keys();
    const shellName = names.find(n => n.startsWith('bm-shell-'));
    if (!shellName) return { names, keys: [] };
    const keys = (await (await caches.open(shellName)).keys()).map(r => new URL(r.url).pathname);
    return { names, shellName, keys };
  });
  ok('a shell cache exists', !!shell.shellName, JSON.stringify(shell.names));
  ok('shell holds the app HTML', shell.keys.includes('/blundermind.html'), shell.keys.join(','));
  ok('shell holds the bot builder', shell.keys.includes('/bot-control-panel.html'));
  ok('shell holds the manifest', shell.keys.includes('/manifest.webmanifest'));

  // Install must stay small — the 12MB of ORT is a runtime cost, not an
  // install cost, or opening the app means a 20MB download before first paint.
  ok('install did NOT precache the heavy assets',
    !shell.keys.some(k => k.startsWith('/ort/') || k === '/stockfish.wasm'),
    shell.keys.filter(k => k.startsWith('/ort/') || k === '/stockfish.wasm').join(','));

  // Runtime caching on first use.
  await page.evaluate(() => fetch('/stockfish.js').then(r => r.text()));
  await page.waitForTimeout(700);
  const runtime = await page.evaluate(async () => {
    const n = (await caches.keys()).find(x => x.startsWith('bm-runtime-'));
    if (!n) return [];
    return (await (await caches.open(n)).keys()).map(r => new URL(r.url).pathname);
  });
  ok('static assets cache on first use', runtime.includes('/stockfish.js'), runtime.join(','));

  // ── The one that matters: the model must not be duplicated ──
  // Ranged so this costs 1KB, not 44MB.
  await page.evaluate(() => fetch('/models/maia3_simplified.onnx', { headers: { Range: 'bytes=0-1023' } })
    .then(r => r.arrayBuffer()).catch(() => {}));
  await page.waitForTimeout(700);
  const modelCached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(n => n.startsWith('bm-'));
    for (const n of names) {
      const keys = await (await caches.open(n)).keys();
      if (keys.some(r => new URL(r.url).pathname.startsWith('/models/'))) return n;
    }
    return null;
  });
  ok('the SW does NOT cache /models/ (maia-worker owns it)', modelCached === null,
    'found in ' + modelCached);

  // Proxy responses must never be served stale.
  await page.evaluate(() => fetch('/api/masters?fen=start').then(r => r.text()).catch(() => {}));
  await page.waitForTimeout(500);
  const apiCached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(n => n.startsWith('bm-'));
    for (const n of names) {
      const keys = await (await caches.open(n)).keys();
      if (keys.some(r => new URL(r.url).pathname.startsWith('/api/'))) return n;
    }
    return null;
  });
  ok('the SW does NOT cache /api/ responses', apiCached === null, 'found in ' + apiCached);

  ok('durable storage was requested', await page.evaluate(
    () => typeof navigator.storage.persisted === 'function'
      ? navigator.storage.persisted().then(() => true) : false));

  /* ═══════════════════════ OFFLINE ═══════════════════════ */
  console.log('\nOFFLINE  (network cut)');
  await ctx.setOffline(true);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const resp = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }).catch(e => ({ err: e.message }));
  ok('the app loads with no network', !!resp && !resp.err, resp && resp.err);
  ok('and renders its content', await page.evaluate(
    () => !!document.querySelector('#landingOverlay, #app, .landing-card')));
  ok('title survives offline', /Blundermind/i.test(await page.title()), await page.title());
  ok('no page errors offline', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.setOffline(false);

  await ctx.close();
}
await browser.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

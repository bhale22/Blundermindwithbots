// Shared setup for the browser-level tests.
//
// These differ from the other tests in test/: those load src/ into a `vm` and
// exercise pure functions, which is the right tool for the engine but cannot
// see anything about input handling, rendering or page lifecycle. The suites
// here drive the real assembled page in a real browser, because the bugs they
// guard against — a move committing on touch-release, a chip that moves when
// the turn changes, a game that vanishes when the phone backgrounds the tab —
// only exist at that level.
//
// They are NOT part of `npm test`. They need Playwright and a server, and take
// tens of seconds. Run them with `npm run test:browser`.
//
// Every file gets its own server on its own port, because node --test runs
// each file in a separate process and a shared fixed port would collide.
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const { devices } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

// Phone emulation, in one place and asserted at load.
// Playwright's device list changes between releases, and an unknown name
// yields `undefined` — which spread into newContext() silently produces a
// DESKTOP context with no touch support. A touch suite would then pass while
// testing nothing of the sort, so fail loudly instead.
const PHONE_DEVICE = 'Pixel 7';
if (!devices[PHONE_DEVICE]) {
  throw new Error(
    'Playwright has no device descriptor "' + PHONE_DEVICE + '". Available Pixels: ' +
    Object.keys(devices).filter((k) => /^Pixel/.test(k)).join(', '));
}

// A phone context. Always use this rather than spreading `devices[...]` inline.
function phoneContext(browser, extra) {
  return browser.newContext(Object.assign({}, devices[PHONE_DEVICE], extra || {}));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = 'http://127.0.0.1:' + port + '/';
  // Poll until it answers rather than sleeping a fixed amount.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('server did not start within 30s');
    }
    try {
      const res = await fetch(baseUrl, { method: 'GET' });
      if (res.ok) break;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { proc, baseUrl, port };
}

function stopServer(server) {
  if (server && server.proc && !server.proc.killed) server.proc.kill();
}

// ── Page helpers ────────────────────────────────────────────────────────────

// The landing overlay covers the board on a fresh load.
async function dismissLanding(page) {
  await page.evaluate(() => {
    if (typeof landingDismiss === 'function') landingDismiss();
  });
  await page.waitForTimeout(600);
}

async function landingVisible(page) {
  return page.evaluate(() => {
    const lo = document.getElementById('landingOverlay');
    if (!lo) return false;
    return getComputedStyle(lo).display !== 'none' && !lo.classList.contains('fade-out');
  });
}

// Board geometry. file a-h = 0-7, rank 1-8. Honours board flip.
async function squareCentre(page, file, rank) {
  const box = await page.locator('#cv').boundingBox();
  const flipped = await page.evaluate(() => !!boardFlipped);
  let c = file, r = 7 - (rank - 1);
  if (flipped) { c = 7 - c; r = 7 - r; }
  return { x: box.x + (c + 0.5) * box.width / 8, y: box.y + (r + 0.5) * box.height / 8 };
}

const pieceAt = (page, sq) => page.evaluate((s) => {
  const p = board[s];
  return p ? p.color + p.piece : null;
}, sq);

// Square indices used across the suites (r*8+c, r=0 is rank 8).
const SQ = {
  e2: 6 * 8 + 4, e3: 5 * 8 + 4, e4: 4 * 8 + 4,
  d2: 6 * 8 + 3, d4: 4 * 8 + 3,
  g1: 7 * 8 + 6, f3: 5 * 8 + 5,
};

// Real touch events via CDP. Playwright's tap() synthesises differently, and
// the canvas listens for touchstart/touchmove/touchend specifically.
function touchDriver(cdp, page) {
  async function send(type, pt) {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: pt.x, y: pt.y }],
    });
    await page.waitForTimeout(120);
  }
  return {
    async drag(from, to) {
      await send('touchStart', from);
      await send('touchMove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
      await send('touchMove', to);
      await send('touchEnd', to);
      await page.waitForTimeout(250);
    },
    async tap(pt) {
      await send('touchStart', pt);
      await send('touchEnd', pt);
      await page.waitForTimeout(250);
    },
  };
}

// Mouse equivalents, so the desktop suite reads the same way.
function mouseDriver(page) {
  return {
    async drag(from, to) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(250);
    },
    async tap(pt) {
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(250);
    },
  };
}

module.exports = {
  ROOT, startServer, stopServer, phoneContext, PHONE_DEVICE,
  dismissLanding, landingVisible, squareCentre, pieceAt, SQ,
  touchDriver, mouseDriver,
};

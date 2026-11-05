// Hosts Blundermind's Lichess bots on a server. Each bot gets its own headless
// Chromium on the site's ?lichess page, holding that bot's token and Bot
// Builder config — the same page and the same bridge (src/65-lichess-bridge.js)
// as a host tab in a desktop browser, so what plays is exactly what the
// builder showed. This only keeps the pages alive: it starts them, watches
// them, and reloads or restarts one that stops.
//
//   node bot-runner/runner.mjs                host every bot in bot-runner/bots/,
//                                             and every BM_BOT_<NAME> variable
//   node bot-runner/runner.mjs setup <name>   open a window to set a bot up and
//                                             connect it; saves bots/<name>.json
//   node bot-runner/runner.mjs env <name>     that file as a BM_BOT_<NAME>
//                                             variable, for Railway
//
// A bot file holds the bot account's token. bots/ and profiles/ are
// git-ignored, and must stay so: the repo is public.
//
// Environment: BM_SITE (default https://blundermindchess.com), BM_BOTS_DIR and
// BM_PROFILES_DIR (default bot-runner/bots and bot-runner/profiles), and for
// tests BM_LICHESS_API, a stand-in Lichess the bridge honours on a localhost
// page and nowhere else.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOTS_DIR = path.resolve(process.env.BM_BOTS_DIR || path.join(HERE, 'bots'));
const PROFILES_DIR = path.resolve(process.env.BM_PROFILES_DIR || path.join(HERE, 'profiles'));
const SITE = (process.env.BM_SITE || 'https://blundermindchess.com').replace(/\/+$/, '');
const ORIGIN = new URL(SITE).origin;
const LICHESS_API = process.env.BM_LICHESS_API || '';
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

const TICK_MS = 15000;                   // how often each page is looked at
const PROBE_TIMEOUT_MS = 20000;
const MAX_MISSES = 4;                    // unanswered looks before a restart
const LOAD_LIMIT_MS = 3 * 60000;         // page never got as far as the bridge
const CONNECTING_LIMIT_MS = 5 * 60000;   // the bridge retries itself until then
const RETRY_FIRST_MS = 60000;            // after an error: 1 min, doubling…
const RETRY_MAX_MS = 30 * 60000;         // …to 30 min
const REFRESH_MS = 24 * 3600000;         // fresh page once a day, between games
// Bots start one after another, but close together: after a restart, a bot
// in the middle of a game is losing clock time until its page is back.
const STAGGER_MS = 5000;

// Seen already, so no welcome, landing or tour sits over the board.
const SEEN = { bm_welcomed: '1', bm_landingSeen: '1', bm_bottour: '1' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(who, text) { console.log(stamp() + '  ' + (who ? '[' + who + '] ' : '') + text); }
function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timed out')), ms); })])
    .finally(() => clearTimeout(t));
}
function mins(ms) { return Math.round(ms / 60000) + ' min'; }
function pageUrl(hosting) {
  const q = [];
  if (hosting) q.push('lichess');
  if (LICHESS_API) q.push('lichessApi=' + encodeURIComponent(LICHESS_API));
  return SITE + '/' + (q.length ? '?' + q.join('&') : '');
}

// Runs in the page before any of its own scripts, on every load. The file is
// the bot: whatever the page did to its storage last time is put back.
function seed(s) {
  if (location.origin !== s.origin) return;
  try { for (const k of Object.keys(s.items)) localStorage.setItem(k, s.items[k]); } catch (e) {}
}

// What the page says about itself. Null until the bridge has loaded.
function probe() {
  if (typeof lbState === 'undefined' || typeof lichessGameLive !== 'function') return null;
  return {
    state: lbState, note: lbStateNote,
    account: lbAccount ? lbAccount.username : null,
    live: lichessGameLive(),
    ready: _lbEnginesReady(),
    bot: typeof botGenerateName === 'function' ? botGenerateName() : '',
  };
}

// ── Bot files ───────────────────────────────────────────────────────────────
// { account, bot, saved, site, lichess: { token, bots, speeds }, lastBot }
// lastBot is the page's own record of the bot it plays (bm_lastBot), copied
// whole, so it restores the way a reload of a desktop host tab does.
//
// A host with no disk to put files on (Railway) takes the same file as a
// variable, BM_BOT_<NAME>. Its value is the file in base64, so no variable
// editor trips over the quotes in it; plain JSON is taken too.
const ENV_RE = /^BM_BOT_([A-Za-z0-9_]{1,40})$/;
function envName(name) { return 'BM_BOT_' + name.toUpperCase().replace(/-/g, '_'); }
function envValue(d) { return Buffer.from(JSON.stringify(d)).toString('base64'); }

function checkBot(name, d) {
  if (!d.lichess || !d.lichess.token) throw new Error('no token in it');
  if (!d.lastBot || !d.lastBot.cfg) throw new Error('no bot config in it');
  if (d.site && d.site !== SITE) log(name, 'Set up on ' + d.site + ', hosted from ' + SITE);
  return Object.assign({ name }, d);
}

function readBots() {
  const found = new Map();
  if (fs.existsSync(BOTS_DIR)) {
    for (const f of fs.readdirSync(BOTS_DIR).filter(f => f.endsWith('.json')).sort()) {
      const name = f.slice(0, -5);
      try {
        if (!NAME_RE.test(name)) throw new Error('file names are letters, digits, - and _ only');
        found.set(name, checkBot(name, JSON.parse(fs.readFileSync(path.join(BOTS_DIR, f), 'utf8'))));
      } catch (e) {
        log(null, 'Skipping bots/' + f + ': ' + e.message);
      }
    }
  }
  for (const k of Object.keys(process.env).sort()) {
    const m = ENV_RE.exec(k);
    if (!m) continue;
    const name = m[1].toLowerCase();
    try {
      const v = process.env[k].trim();
      let d;
      try { d = JSON.parse(v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8')); }
      // Its length is the one clue a sealed value gives away: env prints the
      // length it should be.
      catch (e) { throw new Error('not a bot file, ' + v.length + ' characters (make one with: node bot-runner/runner.mjs env <name>)'); }
      if (found.has(name)) log(name, k + ' replaces bots/' + name + '.json');
      found.set(name, checkBot(name, d));
    } catch (e) {
      log(null, 'Skipping ' + k + ': ' + e.message);
    }
  }
  return [...found.values()];
}

function hostItems(bot) {
  const lichess = Object.assign({}, bot.lichess, { auto: true });
  return Object.assign({}, SEEN, {
    bm_lichessBot: JSON.stringify(lichess),
    bm_lastBot: JSON.stringify(bot.lastBot),
  });
}

// ── One hosted bot ──────────────────────────────────────────────────────────
class Host {
  constructor(bot) {
    this.bot = bot;
    this.name = bot.name;
    this.ctx = null;
    this.page = null;
    this.stopping = false;
    this.dead = null;            // why the browser has to be restarted
    this.restartDelay = 5000;
  }
  log(text) { log(this.name, text); }

  async run() {
    while (!this.stopping) {
      try {
        await this.launch();
        await this.watch();
      } catch (e) {
        if (!this.stopping) this.log('Error: ' + (e.message || e));
      }
      await this.close();
      if (this.stopping) break;
      this.log('Restarting the browser in ' + Math.round(this.restartDelay / 1000) + ' s');
      await sleep(this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 5 * 60000);
    }
  }

  async launch() {
    this.dead = null;
    const dir = path.join(PROFILES_DIR, this.name);   // keeps Maia's 44 MB download
    fs.mkdirSync(dir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless: true, viewport: { width: 1280, height: 800 },
    });
    this.ctx.on('close', () => { this.dead = this.dead || 'the browser closed'; });
    await this.ctx.addInitScript(seed, { origin: ORIGIN, items: hostItems(this.bot) });
    const page = this.ctx.pages()[0] || await this.ctx.newPage();
    this.page = page;
    page.on('console', m => {
      const t = m.text();
      if (t.startsWith('[lichess] ')) this.log(t.slice(10));
      else if (m.type() === 'error') this.log('console error: ' + t.slice(0, 300));
    });
    page.on('pageerror', e => this.log('page error: ' + String(e.message || e).slice(0, 300)));
    // Nobody is here to answer one. The page asks only before giving up a
    // game, and the only game a host tab has is the one Lichess runs.
    page.on('dialog', d => { this.log('Dialog (accepted): ' + d.message()); d.accept().catch(() => {}); });
    page.on('crash', () => { this.dead = 'the page crashed'; });
    await this.open('Opening ' + pageUrl(true));
  }

  async open(why) {
    this.log(why);
    this.loadedAt = Date.now();
    this.state = null;
    this.stateSince = Date.now();
    this.saidBot = false;
    this.saidNote = '';
    await this.page.goto(pageUrl(true), { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  // Returns when the browser has to be restarted.
  async watch() {
    let misses = 0;
    let retryMs = RETRY_FIRST_MS;
    let ready = null;
    while (!this.stopping) {
      await sleep(TICK_MS);
      if (this.stopping) return;
      if (this.dead) { this.log('Stopped: ' + this.dead); return; }
      let s;
      try {
        s = await withTimeout(this.page.evaluate(probe), PROBE_TIMEOUT_MS);
        misses = 0;
      } catch (e) {
        if (this.dead) continue;
        if (++misses >= MAX_MISSES) { this.log('The page has stopped answering'); return; }
        continue;
      }
      const now = Date.now();
      if (!s) {
        if (now - this.loadedAt > LOAD_LIMIT_MS) await this.open('The page never finished loading — opening it again');
        continue;
      }
      if (s.state !== this.state) {
        this.state = s.state;
        this.stateSince = now;
      }
      const inState = now - this.stateSince;
      if (s.state === 'waiting' || s.state === 'playing') {
        retryMs = RETRY_FIRST_MS;
        this.restartDelay = 5000;
        if (!this.saidBot) { this.saidBot = true; this.log('Plays as ' + (s.bot || '?') + (s.account ? ' on @' + s.account : '')); }
        if (ready !== s.ready) {
          ready = s.ready;
          this.log(s.ready ? 'Engines ready — accepting challenges' : 'Loading engines — challenges are declined "later" until they are ready');
        }
        if (s.state === 'waiting' && !s.live && now - this.loadedAt > REFRESH_MS) {
          await this.open('Daily refresh between games');
        }
        continue;
      }
      if (s.live) continue;   // a game on the board is the bridge's to recover
      if (s.state === 'connecting' && inState < CONNECTING_LIMIT_MS) continue;
      // error (the bridge gave up), off (it let go), or connecting too long.
      const why = s.state === 'error' ? (s.note || 'error').replace(/\.$/, '') : s.state === 'off' ? 'the page let go' : 'still connecting';
      if (why !== this.saidNote) { this.saidNote = why; this.log('Not connected (' + why + ') — trying again in ' + mins(retryMs)); }
      if (inState >= retryMs) {
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        await this.open('Trying again');
      }
    }
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    if (ctx) { try { await ctx.close(); } catch (e) {} }
  }
}

async function host() {
  const bots = readBots();
  if (!bots.length) {
    log(null, 'No bots to host: put a bot file in ' + BOTS_DIR + ' or a BM_BOT_<NAME> variable in the environment'
      + ' (made with: node bot-runner/runner.mjs setup <name>, then env <name>)');
    return 1;
  }
  log(null, 'Hosting ' + bots.map(b => b.name + (b.account ? ' (@' + b.account + ')' : '')).join(', ') + ' from ' + SITE);
  const hosts = bots.map(b => new Host(b));
  let stopping = false;
  const stop = async sig => {
    if (stopping) return;
    stopping = true;
    log(null, sig + ': closing ' + hosts.length + ' browser(s)');
    for (const h of hosts) h.stopping = true;
    await Promise.all(hosts.map(h => h.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  const runs = [];
  for (let i = 0; i < hosts.length && !stopping; i++) {
    if (i) await sleep(STAGGER_MS);
    runs.push(hosts[i].run());
  }
  await Promise.all(runs);
  return 0;
}

// ── Setting a bot up ────────────────────────────────────────────────────────
// A window on the site with the Bot Builder open: build the bot, connect it
// to its Lichess account from the builder's green pill, and the page's own
// record of the token and the bot is copied into bots/<name>.json — again on
// every change while the window is open.
function snapshot() {
  return {
    account: typeof lbAccount !== 'undefined' && lbAccount ? lbAccount.username : null,
    lichess: localStorage.getItem('bm_lichessBot'),
    lastBot: localStorage.getItem('bm_lastBot'),
    bot: typeof botGenerateName === 'function' ? botGenerateName() : '',
  };
}

async function setup(name) {
  if (!name || !NAME_RE.test(name)) {
    console.log('Usage: node bot-runner/runner.mjs setup <name>   (letters, digits, - and _)');
    return 1;
  }
  const file = path.join(BOTS_DIR, name + '.json');
  let rel = path.relative(process.cwd(), file);
  if (rel.startsWith('..')) rel = file;
  if (fs.existsSync(file)) log(null, rel + ' exists — it is replaced once this bot connects');
  // A fresh browser each time, so no other bot's token is lying in it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-setup-'));
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, viewport: null });
  await ctx.addInitScript(seed, { origin: ORIGIN, items: SEEN });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (t.startsWith('[lichess] ')) log(name, t.slice(10)); });
  // Playwright's windows never show a dialog, so it is answered here: yes,
  // since every one this page asks follows a click of the user's own.
  page.on('dialog', d => {
    log(name, 'Dialog (accepted): ' + d.message());
    d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined).catch(() => {});
  });
  let closed = false;
  page.on('close', () => { closed = true; });
  ctx.on('close', () => { closed = true; });
  process.once('SIGINT', () => { closed = true; });

  await page.goto(pageUrl(false), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => typeof openBotModal === 'function', null, { timeout: 120000 });
  await page.evaluate(() => openBotModal());
  console.log([
    '',
    'In the window:',
    '  1. Build the bot in the Bot Builder (or paste a share link to it into the address bar).',
    '  2. Press the green "Set up bot to play on Lichess", paste the bot account\'s token, Connect.',
    '     Make the token in your usual browser, signed in as the bot account.',
    '  3. When the board\'s Lichess panel says "Waiting for challenges", close the window.',
    'While connected, this window IS the bot — close it before the server hosts it.',
    '',
  ].join('\n'));

  let savedKey = null;
  while (!closed) {
    await sleep(1000);
    if (closed) break;
    let s;
    try { s = await page.evaluate(snapshot); } catch (e) { continue; }
    if (!s || !s.account || !s.lichess || !s.lastBot) continue;
    let lichess, lastBot;
    try { lichess = JSON.parse(s.lichess); lastBot = JSON.parse(s.lastBot); } catch (e) { continue; }
    if (!lichess || !lichess.token || !lastBot || !lastBot.cfg) continue;
    const out = {
      account: s.account, bot: s.bot, saved: new Date().toISOString(), site: SITE,
      lichess: { token: lichess.token, bots: !!lichess.bots, speeds: lichess.speeds || {} },
      lastBot,
    };
    const key = JSON.stringify([out.account, out.lichess, out.lastBot]);
    if (key === savedKey) continue;
    fs.mkdirSync(BOTS_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    log(name, (savedKey ? 'Updated ' : 'Saved ') + rel + ': @' + out.account + ' plays as ' + (out.bot || '?'));
    savedKey = key;
  }
  try { await ctx.close(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (!savedKey) log(name, 'Nothing saved: the bot never connected.');
  else log(name, 'To host it on Railway: node bot-runner/runner.mjs env ' + name);
  return savedKey ? 0 : 1;
}

// ── A bot file as a variable ────────────────────────────────────────────────
// Copied to the clipboard rather than shown, since it holds the token.
function env(name) {
  const file = path.join(BOTS_DIR, (name || '') + '.json');
  if (!name || !NAME_RE.test(name) || !fs.existsSync(file)) {
    console.log('Usage: node bot-runner/runner.mjs env <name>   (a bot saved by: setup <name>)');
    return 1;
  }
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); checkBot(name, d); }
  catch (e) { console.log('bots/' + name + '.json: ' + e.message); return 1; }
  const value = envValue(d);
  const clip = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : null;
  const copied = !!clip && spawnSync(clip, { input: value }).status === 0;
  console.log([
    '',
    'For Railway: the bot service → Variables → New Variable',
    '  Name:   ' + envName(name) + (copied ? '   (type it in: copying it from here replaces the value on the clipboard)' : ''),
    '  Value:  ' + (copied ? 'on the clipboard — paste it (' + value.length + ' characters)' : value),
    'It holds @' + d.account + '\'s token. Once it is added, seal it (the variable\'s ⋮ menu → Seal).',
    '',
  ].join('\n'));
  return 0;
}

export { Host, readBots, setup, envName, envValue };

// Run as a program; imported (scripts/verify-bot-runner.mjs), it only exports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'setup') process.exit(await setup(arg));
  else if (cmd === 'env') process.exit(env(arg));
  else if (!cmd) process.exit(await host());
  else { console.log('Usage: node bot-runner/runner.mjs [setup <name> | env <name>]'); process.exit(1); }
}

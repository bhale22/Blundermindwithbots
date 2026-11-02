# Bot runner

Hosts Blundermind bots on Lichess from a server, around the clock. Each bot
gets its own headless Chromium on `blundermindchess.com/?lichess`, holding
that bot's token and Bot Builder config. It is the same page and bridge as a
host tab in your own browser, so the bot that plays is the one the builder
showed. The runner only keeps the pages alive: it reconnects a page that
loses Lichess, restarts a browser that dies, and refreshes each page once a
day between games.

It runs on Railway (section 2) or on an Ubuntu 24.04 server of your own
(section 3). Budget about 1 GB of memory per bot.

> A bot file holds that bot account's Lichess token, and so does its Railway
> variable. `bot-runner/bots/` and `bot-runner/profiles/` are git-ignored, and
> this repo is public: never move a bot file anywhere git would pick it up.

## 1. Set a bot up (on your PC)

From the repo folder:

```
node bot-runner/runner.mjs setup premove90
```

A browser window opens on the Bot Builder.

1. Build the bot. To carry over a bot you already have, open the builder where
   it lives, press **My Bots → 🔗 Link**, and paste the link into this
   window's address bar.
2. Press the green **Set up bot to play on Lichess**, paste the bot account's
   token, and press **Connect**. Make the token in your usual browser, signed
   in as the bot account. The popup also upgrades a fresh account to a bot
   account.
3. When the board's Lichess panel says *Waiting for challenges*, close the
   window.

That writes `bot-runner/bots/premove90.json`, and writes it again on every
change while the window is open. The name is yours to choose (letters, digits,
`-` and `_`). It names the file, the browser profile, and the bot in the logs.

While it is connected, the setup window *is* the bot. Lichess keeps one
connection per token, so a bot hosted in two places at once keeps knocking
itself offline. Close the window, and any host tab in your own browser,
before the server hosts that bot.

## 2. Host on Railway

Give the bots a Railway project of their own, apart from the site's. That
way they never turn up in the site's staging or PR environments, where a
second copy of a bot would knock the first offline.

1. **New Project → Empty Project**, then **+ Create → Empty Service**. Name
   it `bots`.
2. Before it builds anything, open its **Variables** and add:
   - `RAILWAY_DOCKERFILE_PATH` = `/bot-runner/Dockerfile`
   - one variable per bot. On your PC, from the repo folder, run
     `node bot-runner/runner.mjs env premove90`. It prints the variable's
     name (`BM_BOT_PREMOVE90`) and puts its value on the clipboard. Paste
     both in, then **seal** the variable (its ⋮ menu → **Seal**). Railway
     never shows a sealed value again, to anyone.
3. In **Settings**:
   - **Source → Connect Repo**: `bhale22/Blundermindwithbots`, branch `main`.
   - **Watch Paths**: `/bot-runner/**`. A push that only changes the site
     then leaves the bots alone; they pick up the new site at their daily
     refresh.
   - **Restart Policy**: Always.
   - **Region**: EU West, the nearest to Lichess's servers in France.
   - Leave **Serverless** off: a sleeping bot is an offline bot.
4. **+ Create → Volume**, attached to `bots`, mount path `/data`. It keeps
   Maia's download from one deploy to the next. It also makes Railway stop
   the old deploy before it starts the new one, so a bot is never connected
   twice.
5. Press **Deploy**. Its **Deploy Logs** should show `Hosting premove90
   (@…)`, then `Plays as … on @…` and `Engines ready — accepting
   challenges`. The first build takes a few minutes. Then challenge the bot
   from your own account (casual; it declines rated games).

| To | Do |
| --- | --- |
| Watch the logs | The service's **Deploy Logs** |
| Add a bot | Run setup and `env` for it on your PC, add its variable, seal it, then **Deploy** |
| Change a bot | Run setup and `env` again, paste the new value over the old (the variable's ⋮ menu → Edit), then **Deploy**. While the setup window is connected, the Railway copy is knocked offline |
| Take a bot offline | Delete its variable, then **Deploy** |
| Update the runner | Push a change under `bot-runner/`; Railway rebuilds and restarts |
| See the cost | The project's **Usage**. Memory is most of it: about $8–9 a month per bot |

## 3. Or a server of your own, once

```
sudo apt update
sudo apt install -y nodejs npm git
git clone --depth 1 https://github.com/bhale22/Blundermindwithbots.git
cd Blundermindwithbots
npm ci
npx playwright install --with-deps chromium
mkdir -m 700 -p bot-runner/bots
```

Copy each bot file up from your PC (PowerShell, from the repo folder):

```
scp -i $HOME\.ssh\oracle_bm bot-runner\bots\premove90.json ubuntu@<server IP>:Blundermindwithbots/bot-runner/bots/
```

Then on the server, `chmod 600 bot-runner/bots/*.json`.

Try it in the foreground first:

```
node bot-runner/runner.mjs
```

Wait for `Plays as … on @…` and `Engines ready — accepting challenges`. The
first start of a Maia bot downloads the 44 MB model, which takes a minute.
Then challenge the bot from your own account (casual; it declines rated
games). Press Ctrl+C to stop.

To run it as a service, which starts on boot and restarts if it stops:

```
sudo cp bot-runner/blundermind-bots.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blundermind-bots
```

The unit assumes the user `ubuntu` and the repo in its home folder. Edit
`User` and `WorkingDirectory` if yours differ.

Day to day on that server:

| To | Do |
| --- | --- |
| Watch the logs | `journalctl -u blundermind-bots -f` |
| Add or change a bot | Run setup on your PC, `scp` the file up, then `sudo systemctl restart blundermind-bots` |
| Take a bot offline | Move its file out of `bots/`, then restart |
| Update the runner | `git pull`, then `npm ci` and restart |
| Check memory | `free -h` |

## Either way

- **The bots run whatever the site serves.** A deploy to blundermindchess.com
  reaches them the next time their pages load: the daily refresh, or a
  restart.
- **A restart mid-game costs the bot clock time.** The page picks the game
  back up from Lichess, but the bot's clock runs for the half minute or so
  that takes. Restart between games when you can.
- **Revoking a token:** do it at lichess.org/account/oauth/token while signed
  in as the bot, then set the bot up again with a new one. The runner logs
  *Lichess rejected this token* and keeps retrying, at most every 30 min,
  until its file or variable has a good one.
- **Oracle reclaims idle free VMs.** It counts a VM as idle when CPU, network
  *and* memory all stay under 20% for a week. Bots barely use CPU, so the
  memory they hold is what keeps the VM from looking idle.

## How it works

`runner.mjs` hosts every file in `bots/` and every `BM_BOT_<NAME>` variable
(the same file, in base64). It launches one persistent Chromium profile per
bot under `profiles/<name>` (`/data/profiles` in the Dockerfile), so Maia's
download survives restarts. Before the page's own scripts run, it writes the
bot file into the page's storage: `bm_lichessBot`
(token and accept rules) and `bm_lastBot` (the page's own record of the bot it
plays). It then opens the site with `?lichess`, and the bridge reconnects by
itself. Every 15 s the runner reads the bridge's state. If the bridge gave up
(it does not retry a failed connect), it opens the page again after 1 min,
then 2, 4… up to 30 min. A browser that closes, crashes or stops answering
gets restarted.

`scripts/verify-bot-runner.mjs` checks all of this against a stand-in Lichess
(dev server on :3100).

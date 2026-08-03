# Blundermind — Android (Trusted Web Activity)

The Android wrapper for **blundermindchess.com**. It contains no app logic: it
runs the live site full-screen in Chrome. The product code is the repo this
folder sits in, which also serves the web app manifest, the service worker and
the domain-verification file — see [`../ANDROID.md`](../ANDROID.md) for the web
side and the release runbook.

Nothing here is deployed. Railway ignores this folder (see `../.railwayignore`);
`bubblewrap build` produces an `.aab` locally that you upload to Google Play.

    package  com.blundermindchess.app     ← permanent once published to Play
    target   https://blundermindchess.com

## Status

**Done — the PWA is live and TWA-ready.** Merged in PR #24 and deployed. Checked
against the live site:

    name / short_name / start_url        OK
    display: standalone                  OK
    512px icon + maskable icon           OK
    theme_color / background_color       OK
    all 3 icons 200 and correctly sized  OK

**Done — toolchain configured.** `@bubblewrap/cli` is installed globally and
`~/.bubblewrap/config.json` is seeded with verified paths, so `init` will not
ask about the JDK or SDK:

    JDK 17        C:/Users/bbrow/.bubblewrap/jdk-17.0.20+8   (Temurin — see below)
    Android SDK   C:/Users/bbrow/AppData/Local/Android/sdk   (build-tools 36.1.0)

**Done — the apex serves HTTPS.** Fixed Aug 3: the leftover Namecheap parking A
record was replaced with an `ALIAS @ → 9v820w00.up.railway.app`, and the domain
was added as a custom domain in Railway (which needed a `_railway-verify` TXT
record). Railway then issued the certificate:

    Subject  CN=blundermindchess.com
    Issuer   Let's Encrypt
    Valid    2026-08-03 → 2026-11-01

Checked against the apex — the host this app binds to:

    apex HTTPS + valid cert              OK
    manifest / sw.js / all 3 icons  200  OK
    name, short_name, start_url          OK
    display standalone                   OK
    512px icon + maskable icon           OK
    theme_color, background_color        OK
    assetlinks 404 (no key yet)          expected

**Nothing is blocking `bubblewrap init`.**

Loose end, unrelated to the app: the Namecheap zone still has a wildcard
`URL Redirect Record * → https://www.blundermind.com` — note the missing
"chess". That target does not resolve. It only affects subdomains with no
explicit record, so `@` and `www` are unaffected, but it should be corrected or
removed.

## Local toolchain — three fixes that were needed

`bubblewrap doctor` now reports both paths valid. Getting there took three
things that are not obvious, recorded here because a fresh machine will hit all
three:

**1. Bubblewrap can't find a modern Android SDK.** It looks for `sdkmanager` at
`<sdk>/tools/bin` or `<sdk>/bin`, but an Android Studio SDK puts it at
`<sdk>/cmdline-tools/latest/bin`. Fixed with a directory junction, so nothing
moves and Android Studio is unaffected:

    New-Item -ItemType Junction `
      -Path   "$env:LOCALAPPDATA\Android\sdk\bin" `
      -Target "$env:LOCALAPPDATA\Android\sdk\cmdline-tools\latest\bin"

**2. Bubblewrap 1.25 requires JDK 17 exactly.** It reads `<jdk>/release` and
insists on `JAVA_VERSION="17.0`; Android Studio ships JDK 21, which it rejects.
Temurin 17 is installed at `C:/Users/bbrow/.bubblewrap/jdk-17.0.20+8`.

**3. It wants build-tools `36.1.0`**, which wasn't installed (35.0.0 and 36.0.0
were). Pre-installed so `build` doesn't stop to run `sdkmanager` interactively.

`~/.bubblewrap/config.json` — note **forward slashes**, backslashes are invalid
JSON escapes:

    {
      "jdkPath": "C:/Users/bbrow/.bubblewrap/jdk-17.0.20+8",
      "androidSdkPath": "C:/Users/bbrow/AppData/Local/Android/sdk"
    }

## Two decisions, both settled

Both were resolved before any release, then applied with `bubblewrap update`.

**`packageId` is `com.blundermindchess.app`.** `init` had defaulted it to
`com.blundermindchess.twa`. Functionally the two are identical — Android and
Chrome treat the string as an arbitrary label — but `.twa` names the
*implementation*, and implementations get replaced. If this ever becomes a
native app, or Google retires Trusted Web Activities, the package would still
say "twa". `.app` describes the product and survives that.

This mattered because the packageId is **permanent**. There is no rename on
Play: republishing under a different one creates an unrelated listing with a new
URL, no reviews, no install count, and no update path for existing users.

**`enableNotifications` is `false`,** which drops `POST_NOTIFICATIONS` from the
generated manifest. The app sends no notifications, so requesting it invited
review questions and an odd line on the store listing. `DelegationService` is
still generated and registered — that is standard TWA scaffolding, and without
the permission it cannot post anything.

If either ever needs to change, edit `twa-manifest.json` and re-run
`bubblewrap update`; it rewrites `build.gradle`, the manifest, and the Java
package directory, and removes the old one.

## Generate

`twa-manifest.json` is pre-filled with the right package, host, colours and icon
URLs, so `init` has nothing to guess.

Already done — `init` has run and `android.keystore` exists (untracked). Kept
for reference:

    bubblewrap init --manifest https://blundermindchess.com/manifest.webmanifest

To change a setting, edit `twa-manifest.json` and run `bubblewrap update` from
this directory; it rewrites `build.gradle`, `AndroidManifest.xml` and the Java
package directory.

`build` **needs an interactive terminal** — it prompts for the signing keystore
passwords, which is the one part that shouldn't be automated. Run it in a normal
PowerShell window in this directory.

## Signing — enrol in Play App Signing

Google re-signs the app with a key it holds. That means:

- Losing `android.keystore` is **recoverable** (an upload key can be reset).
  Without Play App Signing, losing it ends your ability to update the app.
- The fingerprint end users receive is **Google's**, not your upload key's.

So `/.well-known/assetlinks.json` must list **both**. Get them from:

    keytool -list -v -keystore android.keystore -alias android   # upload key
    Play Console → Setup → App integrity → App signing key certificate

Then set on Railway, in the web app's environment (comma-separated, no spaces):

    TWA_PACKAGE_NAME       com.blundermindchess.app
    TWA_CERT_FINGERPRINTS  <upload SHA-256>,<Play app signing SHA-256>

Listing only the upload key is the usual reason a shipped TWA displays an
address bar.

## Build and check on a device

    bubblewrap build

Install the APK on a real phone and verify:

- [ ] **no address bar** — that is domain verification passing
- [ ] airplane mode → the app still opens and plays a game
- [ ] the 44MB Maia model survives a force-quit and relaunch
- [ ] back gesture behaves (leaves the app at the start URL, doesn't strand you)

## Notes

- **buildabotchess.com is a separate product** and would be a separate listing
  with its own package name and its own fingerprint entry. The web app already
  serves it a manifest under its own name. Not required for a first release.
- **Play's "minimum functionality" policy** rejects thin website wrappers. This
  one qualifies — it runs a neural net and a chess engine on-device and works
  offline — and the store listing should say so.
- The keystore is gitignored. Back it up somewhere that is not this repo.

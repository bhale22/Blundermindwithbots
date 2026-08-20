# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately by email to **blundermindchess@gmail.com**, with "security"
in the subject. Include what you found, roughly how to reproduce it, and what an
attacker could do with it. A proof-of-concept helps but is not required.

Blundermind is maintained by one person, so response times are best-effort
rather than contractual. Expect an acknowledgement within about a week. You will
be credited in the fix unless you would rather not be.

## Scope

Blundermind has **no user accounts, no passwords, and no payment data**. It
stores no personal information server-side; game and bot configuration live in
your own browser. That bounds what a vulnerability can reach, and it means the
things worth reporting are mostly these:

**In scope**

- Anything letting one player read or control another player's game — in
  particular seat-token prediction or hijacking in the multiplayer resume flow.
- Using the server's Lichess explorer proxy as an open relay, or otherwise
  burning the server's upstream rate budget.
- Denial of service against the WebSocket layer: room exhaustion, unbounded
  memory growth, or crashing the process with a malformed frame.
- Cross-site scripting, especially by way of chat, player names, or lobby
  challenge fields, which are broadcast to other clients.
- Anything that would let a third party serve content from the domain, or defeat
  the Android app's `assetlinks.json` domain verification.

**Out of scope**

- Cheating in games — using an engine against a bot or another player. It is a
  real problem, but it is a product problem, not a vulnerability.
- Missing hardening headers or "best practice" scanner output with no
  demonstrated impact.
- Vulnerabilities in Stockfish, Maia, or ONNX Runtime themselves. Report those
  upstream; tell us if Blundermind's usage makes one exploitable here.
- Denial of service by raw traffic volume.

## Handling

Fixes land on `dev`, are checked against staging, then merged to `main`, which
deploys to production. Because the site is a progressive web app with a service
worker, clients pick up a fix on their next load rather than instantly.

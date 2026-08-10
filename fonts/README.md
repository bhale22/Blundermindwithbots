# fonts/ — self-hosted web fonts

The page used to pull these from `fonts.googleapis.com` / `fonts.gstatic.com`.
That sends **every visitor's IP address to Google**, which a Munich court
(LG München I, 20 Jan 2022) held to breach the GDPR when done without consent —
and it set off a wave of warning letters in Germany specifically. The site has
European users, so the request is now gone entirely: no third party is contacted
to render the page, and no consent banner is required for fonts.

A second benefit: the app renders correctly offline. Previously the service
worker had to cache Google's responses as a workaround, and a cold offline start
fell back to system fonts.

## What's here

| Family | Used for |
|---|---|
| Chakra Petch | UI text (`--font-u`) |
| DM Mono | clocks, notation, engine readouts (`--pfm`) |
| Cormorant Garamond | display / journal theme |
| Fraunces | Build-A-Bot expert-shell headings (`--pfd`) |
| Spectral | italic accents |

All five are licensed under the **SIL Open Font License 1.1**, which explicitly
permits redistribution. The license text is in `OFL.txt`.

Only the **latin** and **latin-ext** subsets are included — 30 files, ~640KB.
Google also serves cyrillic, cyrillic-ext, greek, thai and vietnamese subsets;
those are dropped to keep the download small. Text in those scripts falls back
to a system font, which is ordinary browser behaviour for an unsupported glyph
and only affects multiplayer chat in practice.

## Regenerating

If the family list in `src/00-head.html` changes, re-run:

```
node scripts/fetch-fonts.mjs
```

That refetches Google's stylesheet with a modern browser user-agent (needed to
get `woff2` rather than the legacy formats Google serves to old UAs), keeps the
latin subsets, downloads each file here, and rewrites `fonts.css` to point at
local paths. Then update the `<link>` in `src/00-head.html` if the filename
changed — it should not.

**Do not** re-add a `<link>` to `fonts.googleapis.com`. That is the thing this
directory exists to avoid.

# Harvesting, scouting and scrubbing

## Harvesting (the scraping half)

Some data has no API at all, so Humbler collects it from the pages it
visits. Choice is the main case. Because Humble keeps redesigning, the
harvester (`src/main/lib/harvest.ts`) doesn't depend on one page layout. It reads
three sources:

1. JSON responses the page fetched, recorded by the scouting script below
2. JSON embedded in the page (including Next.js `__NEXT_DATA__`)
3. Humble Librarian's DOM selectors for the old layout (they do nothing on
   pages that no longer have that layout)

It searches the JSON by shape (Choice data holding a game list), not by
exact path. Every harvest, raw sources included, is kept in
`data/harvest/choice/` (newest 200). If a page isn't recognised, the log
says so. Send the scout summary of that page and the extractor can be fixed
from real data.

## Scouting (when Humble changes something)

A script is injected into
every Humble page before Humble's own code runs (via CDP
`Page.addScriptToEvaluateOnNewDocument`; see `src/main/lib/inject-capture.ts`). It
records every JSON response the page receives through `fetch` or XHR. A CDP
Network log also keeps metadata for every request.

**Humble's 2026 site is a Next.js App Router app.** Most page data is no
longer JSON. It travels as React Server Components payloads
(`text/x-component`):

- client-side navigation fetches `?_rsc=…` URLs
- mutations are **server actions**: a POST with a `Next-Action` header
- the first page load embeds its data in `self.__next_f.push(…)` script tags

Humbler captures all three and decodes them to JSON (`src/main/lib/rsc.ts`). Scouting,
the live catalog and the Choice harvester all search this data alongside
plain JSON.

### Live scouting (continuous, on by default)

While you browse Humble on the right, every JSON and RSC response from
Humble's own domains is pushed to Humbler as it arrives, through a CDP
binding, so navigating away loses nothing. Third-party analytics and
Humble's error-monitoring endpoint are ignored. Everything goes into a
running, scrubbed catalog in `data/recon/live/`:

- `endpoints.json`: every endpoint seen, with hit counts, statuses, the
  pages that call it, and first/last seen. Ids in paths collapse to `:id`,
  and per-product RSC pages to `:slug`, so `/store/<anything>` is a single
  entry.
- `samples/`: for JSON, one sample per distinct response **shape**
  (structure, not data). When Humble changes a response format, a new shape
  appears and the log says "response shape changed". For RSC, one latest
  decoded sample per endpoint, refreshed every 10 minutes.
- **New server actions are logged prominently.** They're how the new site
  makes changes. If key reveal stops working, reveal one key on Humble's own
  keys page and the log will name the action that did it.

Toggle it with **Live scouting** on the Scout & Log tab. Disk use is
bounded: at most 20 shapes per endpoint.

### Manual scout (full snapshot of one page)

Browse to any page on the right, such as your library, your keys, or a
Choice month. Then go to **Scout & Log** and click **Scout this page**.
"Reload first" is on by default, so the page's data requests fire while
Humbler is listening. The dump goes to `data/recon/<timestamp>-<page>/` and
contains:

- `0001.json …`: each JSON response (method, URL, status, body)
- `_summary.txt`: responses grouped by endpoint, so the important calls are
  easy to spot (also printed to the log)
- `_network.json`: every request the page made, JSON or not
- `_embedded.json`: JSON Humble embedded directly in the HTML
- `_next-data.json`: the page's embedded Next.js (RSC) data, decoded to JSON rows
- `_page.html`: the rendered page

### Scrubbing

Scout dumps and raw harvests (`data/harvest/`) are scrubbed before they're
written (`src/main/lib/scrub.ts`). They should never contain a real key, so they can
be shared for debugging:

- **Known keys:** every key value in your synced orders, the new-site
  library cache (`library-v2.json`) and `revealed-keys.jsonl` is replaced
  with `[REDACTED]` wherever it appears. That includes HTML, JSON escaped
  inside scripts, and gift links.
- **Sensitive fields:** `redeemed_key_val`, `keyFormatted`, the reveal
  response's `key` (any single-token value, e.g. `HUMBLE_…`), gift
  links, and CSRF/session/token fields are redacted by name. This covers
  JSON, JSON inside page scripts (including escaped Next.js data), and HTML
  `<input>`/`<meta>` tags.
- **Key-shaped text:** anything shaped like a key (`XXXXX-XXXXX-XXXXX` and
  similar) is redacted even if Humbler has never seen it.
- **Gamekeys:** order IDs can open an order via `/downloads?key=`. They're
  replaced with a stable alias (`gamekey#3792b1b327`), so you can still tell
  which requests belong to the same order. Signed download URL tokens are
  redacted.
- **Final check:** every file is checked for any known key just before it's
  written. If one is found, the file isn't written and the scout is aborted.

The log shows what each scout removed. To re-scrub dumps made before
scrubbing existed, or after a sync taught Humbler new keys, run
`npm run scrub-data`. It's safe to run repeatedly, and it deletes any file
it can't fully clean.

Request bodies are never recorded, because the login form posts your
password. Scrubbing targets secrets; dumps still contain ordinary account
data such as your email and product names.

Login changed in late 2026: Humble now redirects to an Ory login service at
`auth.humblebundle.com`. Humbler checks for either the old
`_simpleauth_sess` cookie or an Ory session cookie, and trusts what the API
actually says once you've synced.


# Humbler

A local client for your Humble Bundle library. It lets you see every key you
own, reveal and export keys in bulk, and download your files in bulk with
resume and checksum checks. You don't have to fight the website to do any of it.

It's an Electron app laid out the same way as pinterinter. The Humbler UI is
on the left, and the real humblebundle.com runs on the right, where you log in
normally. Humbler then loads your library the way Humble's own pages do,
from inside your logged-in session, so it only ever sees your own account.

## Setup

```
npm install
cp .env.example .env   # optional; defaults are fine
npm start              # dev mode, with HMR
```

Electron 44, built with electron-vite (Vite 8), React 19 and TypeScript 7.
All npm scripts go through `scripts/run.js`, which clears
`ELECTRON_RUN_AS_NODE` first. Some shells (VS Code integrated terminals, some
tooling) set that variable, and when it's set Electron quietly runs as plain
Node and no window opens.

| Command | What |
|---|---|
| `npm start` (or `npm run dev`) | Development: **HMR** for the UI (React Fast Refresh, so edits apply while you keep your place, filters and typed text). Changes to the main process or preload restart the app. DevTools opens for the UI. |
| `npm run prod` | Build, then run the built app (no watching, no DevTools). |
| `npm run build` | Build to `out/` only. |
| `npm run typecheck` | Type-check everything (`tsc -b`, strict). |
| `npm run scrub-data` | Re-scrub existing scout dumps (see Scrubbing). |

The dev server binds to `127.0.0.1` and picks a free port at startup
(15173 first). Windows reserves shifting blocks of ports (Hyper-V, WSL), and
Vite's default 5173 is often inside one.

### Code layout

| Path | What |
|---|---|
| `src/main/index.ts` | Main process: window, Sync, keys, downloads, scouting/harvesting, IPC handlers |
| `src/main/lib/` | The pieces: Humble API clients, RSC decoder, scrubber, downloader, library/orders/Choice parsing, settings and data paths |
| `src/preload/index.ts` | Exposes the IPC API to the UI as `window.humbler` |
| `src/renderer/` | React UI: `tabs/` (Keys, Bundles, Choice, Downloads, Library, Scout & Log), `components/`, `store.tsx` (app state fed by IPC) |
| `src/shared/` | Types shared by both sides: the library data and **the whole IPC API** (`api.ts`). Main and UI can't drift apart. |

## Usage

1. **Log in** in the right-hand pane. Use email and password; Google/Facebook
   sign-in pop-ups generally refuse to run inside embedded browsers. The pill
   at the top turns green once you're logged in.
2. **Sync** pages through your library on the new site, newest first, and
   stops once it reaches items it already has. **Full refresh** re-fetches
   everything. (See "How it talks to Humble". The first sync of a large
   library takes a minute or two, with polite pauses between pages.)
3. **Keys tab**, laid out like the old humblebundle.com keys page. It shows
   every key by default (50 per page, newest first); filter by status to
   narrow it down.
   - Each key has a status: unrevealed ("Reveal your Steam key" box),
     revealed, **gifted**, redeem link, expired, or sold out. Keys that
     expire within 30 days are flagged, and "Expiring soon" filters to them.
     Redemption instructions show under the key, and their links (e.g.
     Humble's support articles) open in your browser, never in Humbler.
   - **Revealing a new-site key**: "Reveal your … key" opens the item on
     Humble (right). Reveal it there and **it appears in Humbler within a
     second or two, no Sync needed**. Humbler watches the responses the
     site gets for key changes (reveals, gifting), and re-checks an item
     you opened after the site acts on it. Every key picked up this way is
     written to `data/revealed-keys.jsonl` straight away.
   - **Redeem** opens the store in your browser: Steam's activation page
     with the key already filled in, GOG's redeem page with the key in the
     link, or Epic's redeem page. When you come back to Humbler it asks
     **"Did you redeem it?"** and remembers your answer
     (`data/redeemed.json`). The key then shows "✓ Redeemed on Steam", with
     undo, and **Revealed, not redeemed** filters to what's left. You can
     also mark a key yourself.
   - **Reveal** asks for two clicks, and that is deliberate: revealing claims
     the key to your account and removes the option to gift it. Select several
     and use **Reveal selected** to do them in a throttled batch.
   - **Copy revealed** copies `Game: KEY` lines for the current view.
     **Export…** writes the current view to CSV or JSON.
4. **Downloads tab** lists every file across every bundle. Filter by bundle,
   platform (windows / mac / linux / ebook / audio / …), or format
   (PDF / EPUB / MOBI / …), then **Download selected** or **Download all shown**.
   - Files go to `<download folder>/<bundle>/<product>/<file>`. Change the
     folder with **Change…**. The naming dropdown switches between Humble's
     own file names (`thegreatbook_v2.pdf`) and readable ones
     (`The Great Book - Publisher.pdf`, as Humble Bundle Downloader does).
     Files you already downloaded under the other scheme still count as
     downloaded.
   - Resumable: cancel or quit at any point, and the `.part` file continues
     from where it stopped next time (HTTP Range).
   - Verified: every file is checked against Humble's MD5/SHA-1 before it's
     kept. A mismatch deletes the partial file and reports a failure.
   - **Hide duplicates** hides files whose checksum matches a file in an
     older bundle, so a book you got in three bundles is downloaded once.
   - Humble's download links are signed and expire. If an order's cached
     links are older than `URL_MAX_AGE_MINUTES`, or the CDN says 403/404,
     Humbler re-fetches that order for fresh links and retries once.
5. **Library tab** lists everything you own, the same list Humble Librarian
   built. It covers every product in every order, including "links only"
   items that have no file and no key (redeem codes, external sites,
   instructions). Each entry shows publisher, icon, bundle, purchase date and
   amount paid, plus links to Steam, the product's site, any redeem links, and
   the order on Humble.
   - **Mark owned on Humble pages** highlights, in green, things you already
     own on Humble's store, bundle and Choice pages in the right-hand pane. It
     matches titles rather than one page layout, so it keeps working through
     redesigns.
6. **Bundles tab**: every bundle you own, as a list. Each row shows the
   bundle's icon, its counts, when you bought it and what you paid, and a
   **deadline**: the soonest "redeem by" date among keys you haven't
   revealed yet, red within 30 days. You can search; sort by most recent,
   A–Z, most unrevealed keys, or **deadline soonest**; and filter to bundles
   with unrevealed keys, with a redeem deadline, with downloads, Choice
   months, or everything but Choice. Opening one shows a **bundle page**
   like the old `/downloads?key=` page: the bundle's keys, then its
   downloads, with platform tabs (Windows / Mac / Linux / eBook …), a
   "Download all" button, and a button per format with its size (✓ once
   downloaded; click to show the file).
   - **Icons, purchase dates and prices** come from your orders. **Sync**
     fetches them from Humble's Purchases page after the library, page by
     page from inside your logged-in session. Humbler also picks them up
     passively as you browse. Only those fields are kept
     (`data/orders-v2.json`), never your email, address or payment details.
     Orders from before Humble's new store may not be listed; those bundles
     keep placeholder tiles. Key deadlines come from the keys themselves,
     so they work for every bundle.
   - You never need to page through the library or Purchases by hand.
     Sync does both.
7. **Choice tab**: Humble's 2026 redesign removed the Choice pages, so
   Humbler rebuilds them.
   - **Month index**: every Choice month in your library (bundles named
     "&lt;Month&gt; Humble Choice"), the empty month groups Humble lists, and the
     current month as shown on your library page.
   - **Month page**: the old game grid. Each game shows its key (reveal,
     redeem, redeemed state) and downloads. Games of the current month that
     aren't in your library yet are marked "Not in your library yet", with a
     link to claim them. The library page only provides images for the
     current month; other games get placeholder tiles.
8. **Back and forward** work like a browser: your **mouse's back/forward
   buttons** (or Alt+← / Alt+→) step through tabs, bundle pages and Choice
   months you've visited. Each tab keeps its filters and scroll position.
9. **Dark mode** is the default everywhere. The ☀ button in the top bar
   switches to light mode (☾ switches back), and the choice is remembered.
10. Anything else Humbler doesn't handle, such as gifting, still works in the
   right-hand pane. **Hide browser** gives the UI the full window.

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

This works the same way as pinterinter's recon. A script is injected into
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

- **Known keys:** every key value in your synced orders and
  `revealed-keys.jsonl` is replaced with `[REDACTED]` wherever it appears.
  That includes HTML, JSON escaped inside scripts, and gift links.
- **Sensitive fields:** `redeemed_key_val`, the reveal response's `key`, gift
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

## Staying logged in

Your login lives in `data/electron-userdata/`. Two things keep it there
across restarts:

- Logins often use *session cookies* (no expiry), and Chromium discards
  those when the app closes. Humbler gives Humble's session cookies a 30-day
  expiry (`SESSION_COOKIE_DAYS` in `.env`; set it to `0` to turn this off).
  Logging out on the site still deletes them.
- Cookies are written to disk about a second after any login change, and
  again on quit, so a crash or forced close can't lose a fresh login.

If you're still logged out after a restart, open the Scout & Log tab. Any
"Could not persist cookie" line there names the cookie involved.

To run a separate profile, or tests, without touching your real login, keys
or downloads, set `HUMBLER_DATA_DIR` to another folder before `npm start`.

## Data

Everything lives in `data/`, which is gitignored:

| Path | What |
|---|---|
| `data/electron-userdata/` | Your Humble login session. Never share it. |
| `data/orders/<gamekey>.json` | Raw order JSON straight from Humble. This is the source of truth for the UI, and it **includes revealed keys**. |
| `data/revealed-keys.jsonl` | Append-only record of every key Humbler revealed, written the moment it comes back. A revealed key can't be lost to a crash. |
| `data/downloaded.jsonl` | Files Humbler has completed. |
| `data/settings.json` | Download folder, file naming, and owned-marking setting. |
| `data/choice.json` | Harvested Choice months: games, claimed or not. A game marked claimed never reverts to unclaimed. |
| `data/harvest/` | Raw page harvests behind `choice.json`. |
| `data/humbler.log` | Everything shown in the Log tab. |
| `data/recon/` | Scout dumps (see above). |
| `data/downloads/` | Default download folder. |

## How it talks to Humble

### 2026 site (current)

Humble's redesign **removed the old `/api/v1` API**. It now returns the
site's "page not found" page. Sync now uses the same server action the
library page uses (`src/main/lib/library-v2.ts`), run from inside your logged-in page:

| Purpose | Request |
|---|---|
| Library, paged | `POST /home/library` with header `Next-Action: <id>`, form fields `_1_query`, `_1_sort=mostRecent`, `_1_cursor`, `_1_page`, `_1_limit`, `_1_hideRevealed`, `_1_hideExpired`, `_1_dateExpires`, `_1_requestId`, and `0` = `[prevState, "$K1"]`. The reply is an RSC payload with `{ results, pagination: { page, totalPages, totalDocs } }` |

- **The action id is a build hash that changes with every Humble deploy.**
  Humbler never hardcodes it. `src/main/lib/actions.ts` records every action the site
  calls, keyed by its argument names, and Sync uses the newest action that
  takes `limit`/`page`/`sort`/`query`. If Sync says it hasn't seen the
  action, open your library on the right once.
- Sync asks for 100 items per page, falls back if Humble caps the size, and
  stops with an error if paging repeats items. Plain **Sync** stops once it
  reaches items already synced (newest first). **Full refresh** fetches
  everything.
- Items come with keys (status, gift status, expiry, instructions) and
  downloads (MD5/SHA-1/size). **Download links aren't included**: the site
  issues them on demand, and Humbler doesn't know that request yet. The
  same goes for **revealing** new-site keys. For both, Humbler opens the
  item on Humble's page instead.
- The library cache is `data/library-v2.json`. It **includes revealed key
  values**, like the old order cache.

### Legacy (before the redesign)

`src/main/lib/humble-api.ts` still holds the old `/api/v1` client. It's used only
for order caches synced before the redesign, and for refreshing their
download links.

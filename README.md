# Humbler

A local client for your Humble Bundle library. It lets you see every key you
own, reveal and export keys in bulk, and download your files in bulk with
resume and checksum checks. You don't have to fight the website to do any of it.

It's an Electron app laid out the same way as pinterinter. The Humbler UI is
on the left, and the real humblebundle.com runs on the right, where you log in
normally. Humbler then uses the same JSON endpoints Humble's own library and
keys pages use. It runs inside your logged-in session, so it only ever sees
your own account.

## Setup

```
npm install
cp .env.example .env   # optional; defaults are fine
npm start
```

Electron 44. `npm start` runs `scripts/start.js`, which clears
`ELECTRON_RUN_AS_NODE` first. Some shells (VS Code integrated terminals, some
tooling) set that variable, and when it's set Electron quietly runs as plain
Node and no window opens.

## Usage

1. **Log in** in the right-hand pane. Use email and password; Google/Facebook
   sign-in pop-ups generally refuse to run inside embedded browsers. The pill
   at the top turns green once you're logged in.
2. **Sync** fetches the order list and then every order you haven't cached yet
   (40 per request, with polite pauses). **Full refresh** re-fetches every
   order, which picks up changes to bundles you already synced.
3. **Keys tab** lists all keys. The default filter shows only unrevealed keys.
   - Each key has a status: unrevealed, revealed, **gifted** (the gift link is
     shown and can be copied), redeem link, expired, or sold out. Keys that
     expire within 30 days are flagged, and "Expiring soon" filters to them.
     Keys with special redeem instructions get a **how to redeem** tag; hover
     over it to read them. Steam keys get a Steam store link.
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
6. **Choice tab** tracks unclaimed Humble Choice games, as Librarian did.
   - Opening any Choice month on the right harvests it automatically.
     **Scan unseen months** walks every month since December 2019 that hasn't
     been harvested, slowly (`CHOICE_SCAN_DELAY_*`). **Rescan all** revisits
     every month.
   - A game counts as claimed if the page says so, or if it's already in your
     synced library. Months with no order on your account are marked "not
     subscribed?" and left out of the unclaimed count.
   - Click a game to open it on the right and claim it there.
7. Anything else Humbler doesn't handle, such as gifting, still works in the
   right-hand pane. **Hide browser** gives the UI the full window.

## Harvesting (the scraping half)

Some data has no API at all, so Humbler collects it from the pages it
visits. Choice is the main case. Because Humble keeps redesigning, the
harvester (`lib/harvest.js`) doesn't depend on one page layout. It reads
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
`Page.addScriptToEvaluateOnNewDocument`; see `lib/inject-capture.js`). It
records every JSON response the page receives through `fetch` or XHR. A CDP
Network log also keeps metadata for every request.

To use it, browse to any page on the right, such as your library, your keys,
or a Choice month. Then go to **Scout & Log** and click **Scout this page**.
"Reload first" is on by default, so the page's data requests fire while
Humbler is listening. The dump goes to `data/recon/<timestamp>-<page>/` and
contains:

- `0001.json …`: each JSON response (method, URL, status, body)
- `_summary.txt`: responses grouped by endpoint, so the important calls are
  easy to spot (also printed to the log)
- `_network.json`: every request the page made, JSON or not
- `_embedded.json`: JSON Humble embedded directly in the HTML
- `_page.html`: the rendered page

Request bodies are never recorded, because the login form posts your
password. Response bodies are recorded, so treat recon dumps as private.

Login changed in late 2026: Humble now redirects to an Ory login service at
`auth.humblebundle.com`. Humbler checks for either the old
`_simpleauth_sess` cookie or an Ory session cookie, and trusts what the API
actually says once you've synced.

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

All of this is in `lib/humble-api.js` (reads) and `revealOne()` in `main.js`
(key reveal). If Humble changes its site again, those are the places to fix.

| Purpose | Request |
|---|---|
| List orders | `GET /api/v1/user/order` |
| Orders, bulk | `GET /api/v1/orders?all_tpkds=true&gamekeys=…` (×40) |
| One order | `GET /api/v1/order/<gamekey>?all_tpkds=true` |
| Reveal key | `POST /humbler/redeemkey` (`keytype`, `key`, `keyindex`), sent from inside the real page with the `csrf_cookie` value as `CSRF-Prevention-Token` |

Reads go through Electron's `net` module on the `persist:humble` session, with
the same cookies and user agent as the visible pane ("Electron/x" is removed
from the UA). Key reveals run inside the Humble page itself, so the request
matches the site's own request exactly.

If the bulk endpoint ever fails, sync falls back to fetching orders one by one
and logs why.

# Using Humbler

1. **Log in** in the right-hand pane. Use email and password; Google/Facebook
   sign-in pop-ups generally refuse to run inside embedded browsers. The pill
   at the top turns green once you're logged in.
2. **Sync** pages through your library on the new site, newest first, and
   stops once it reaches items it already has. If a bundle page or Choice
   month is open, Sync re-reads that purchase first, so keys you revealed
   on Humble's site for it show up even though it isn't new. **Full
   refresh** re-fetches everything. (See [How Humbler talks to Humble](humble-api.md). The first sync of a large
   library takes a minute or two, with polite pauses between pages.)
3. **Keys tab**, laid out like the old humblebundle.com keys page. It shows
   every key by default (50 per page, newest first); filter by status to
   narrow it down.
   - Each key has a status: unrevealed ("Reveal your Steam key" box),
     revealed, **gifted**, redeem link, expired, or **sold out** (Humble ran
     out of keys before you revealed it). Sold-out keys get their own filter,
     a ⚠ count in the summary, a warning on the key with a link to Humble
     support, and a badge on their bundle and Choice month. Keys that
     expire within 30 days are flagged, and "Expiring soon" filters to them.
   - Keys **Humble redeems to your account itself** (keyless Epic, GOG and
     Battle.net items, Ubisoft direct activations) show as "✓ Redeemed to
     your Epic Games Store account" and count as redeemed on that platform
     automatically. The code Humble returns when you redeem one is kept
     (shown small, with Copy) and logged like any revealed key.
   - Every key, download and product has a **Humble page** link that opens
     it on Humble (right): the item's own page for new-site items, the
     purchase for older ones.
     Redemption instructions show under the key, and their links (e.g.
     Humble's support articles) open in your browser, never in Humbler.
   - **Revealing a new-site key**: "Reveal your … key" (two clicks) or
     **Reveal selected** reveals it through the same request Humble's own
     Reveal button sends. You can also reveal it on Humble (right), and
     **it appears in Humbler within a second or two, no Sync needed**. Humbler watches the responses the
     site gets: the reveal action's own reply (`{success, key}`, matched to
     the item by the id it was sent with), any key data the site loads
     (reveals, gifting), and a re-check of an item you opened after the
     site acts on it. This works however you got to the item. Every key picked up
     this way is written to `data/revealed-keys.jsonl` straight away, and a
     key in that log always shows as revealed, whatever the cache says.
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
   - Humble's 2026 library listing doesn't include files, so Sync fetches
     each item's download links the way the site's Download button does.
     The first Sync does this for every item with downloads, which takes a
     while; after that only new items are fetched. Links expire, so
     Humbler gets a fresh one per file when you download it. Sizes show
     as "-" until a file is downloaded.
   - **Download folders** (☰ menu): list every folder that holds Humble
     downloads, and pick the default one new downloads go to. Humbler scans
     them (names only, 3 levels into each bundle folder; ~1s for 100k
     files) and works out what you already have:
     - bundle folders are matched to bundles by name, loosely ("Cyberpunk"
       = "Humble RPG Book Bundle: Cyberpunk by R. Talsorian"); folders it
       can't place are listed so you can link them to a bundle by hand (or
       mark them "not a bundle");
     - files are found by Humble's file name, by the Humble Bundle
       Downloader extension's `Title - Publisher.ext` naming
       (`HumbleBundle/<Bundle>/<format>/…`), or as an extracted folder named
       after the archive or product; a same-named file of a different size
       is flagged;
     - files found count as downloaded; bundles show "N of M files on disk"
     - a complete file of another size is an "older version" (Humble updated
       it since); in folders the downloader extension made, leftover files
       are paired with the bundle's renamed items by title. An incomplete
       zip shows "size differs" (likely an unfinished download)
       with their folders, and Bundles can filter to "With a folder on disk"
       or "Missing files";
     - new downloads for a bundle that already has a folder go into that
       folder; otherwise into the default folder.
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
   A-Z, most unrevealed keys, or **deadline soonest**; and filter to bundles
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
     current month as shown on your library page. Search by month or game
     title (matching games are listed on the card); sort by most recent,
     oldest, most unrevealed keys or deadline soonest; filter to months with
     unrevealed keys, a deadline, sold-out keys, games not in your library,
     or downloads.
   - **Month page**: the old game grid. Each game shows its key (reveal,
     redeem, redeemed state) and downloads. Games of the current month that
     aren't in your library yet are marked "Not in your library yet", with a
     link to claim them. The library page only provides images for the
     current month; other games get placeholder tiles.
8. **Back and forward** work like a browser: your **mouse's back/forward
   buttons** (or Alt+← / Alt+→) step through tabs, bundle pages and Choice
   months you've visited. Every list remembers its search, sort, filters
   and page (and the Bundles and Choice lists their scroll position): open
   a bundle, go back, and the list is as you left it, even after a restart.
   The **↺ Reset** button next to the filters puts them back to the
   defaults.
9. **Dark mode** is the default everywhere. The ☀ button in the top bar
   switches to light mode (☾ switches back), and the choice is remembered.
   **Settings** (☰ menu) gathers the options: theme, tab counts, whether
   changing pages scrolls the list back to the top (on by default),
   download folder and file naming, marking owned items on Humble's pages,
   and live scouting.
10. Anything else Humbler doesn't handle, such as gifting, still works in the
   right-hand pane. **Hide browser** gives the UI the full window.

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


# How Humbler talks to Humble


## 2026 site (current)

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
- The library cache is `data/library-v2.json`. It includes revealed key
  values, encrypted (see [data.md](data.md)).

## Legacy (before the redesign)

`src/main/lib/humble-api.ts` still holds the old `/api/v1` client. It's used only
for order caches synced before the redesign, and for refreshing their
download links.

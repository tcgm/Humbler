# Your data

When running from source, everything lives in `data/` (gitignored). An
installed Humbler uses the same layout in `%APPDATA%\Humbler` on Windows,
`~/Library/Application Support/Humbler` on macOS, or `~/.config/Humbler` on
Linux. Set `HUMBLER_DATA_DIR` to use another folder.


| Path | What |
|---|---|
| `data/electron-userdata/` | Your Humble login session. Never share it. Also holds the encryption key for stored keys (`Local State`): deleting this folder makes them unreadable (a Full refresh fetches them again from Humble). |
| `data/library-v2.json` | The 2026 library as fetched from Humble: items, keys, downloads. Key values are **encrypted** (see [Keys are encrypted at rest](#keys-are-encrypted-at-rest)). |
| `data/orders/<gamekey>.json` | Raw order JSON straight from Humble. This is the source of truth for the UI, and it **includes revealed keys**. |
| `data/revealed-keys.jsonl` | Append-only record of every key Humbler revealed, written the moment it comes back. A revealed key can't be lost to a crash. Key values are **encrypted**. |
| `data/downloaded.jsonl` | Files Humbler has completed. |
| `data/wishlists.json` | Steam profiles you compare wishlists with (SteamID, name, avatar), their wishlisted app ids, and cached game names and art. |
| `data/steam-account.json` | Your own Steam account (My Steam): SteamID, name, avatar, the app ids of the games and DLC on it and on your wishlist, and cached names. The Steam sign-in itself is a cookie in `electron-userdata/`, encrypted like your Humble login. |
| `data/store-bundles.json` | The bundles Humble is selling now (On Sale): titles, tiers and prices, and each bundle's items, from Humble's public pages; the bundles you watch (and which ending notifications went out); the games you starred (and the bundles each was already announced in); every bundle seen so far (so a new one is announced once). |
| `data/settings.json` | Download folder, file naming, and owned-marking setting. |
| `data/choice.json` | Harvested Choice months: games, claimed or not. A game marked claimed never reverts to unclaimed. |
| `data/harvest/` | Raw page harvests behind `choice.json`. |
| `data/humbler.log` | Everything shown in the Log tab. |
| `data/recon/` | Scout dumps (see [scouting.md](scouting.md)). |
| `data/downloads/` | Default download folder. |

## Keys are encrypted at rest

Key values in `library-v2.json` and `revealed-keys.jsonl`, and the order
gamekeys Humble includes in `library-v2.json` (`keys[].gameKey`, which
Humbler doesn't use), are stored as `sealed1:…`, encrypted with Electron `safeStorage` (on Windows: a key in
`electron-userdata/Local State`, itself protected by DPAPI under your
Windows account). Only Humbler, running as you, can read them; a copy of
`data/` (a backup, a sync folder, another account) shows no keys. The rest
of each file stays plain JSON. Files from before this are encrypted on the
next start. If keys can't be decrypted (another PC or account, or
`electron-userdata` was deleted), the log says so and ☰ → Full refresh
fetches them again from Humble. Legacy `data/orders/` caches (pre-2026
site) are not encrypted.

Your login (the cookie store in `data/electron-userdata/`) is encrypted
the same way: `scripts/fuses.mjs` turns on Electron's EnableCookieEncryption
fuse in `node_modules/electron` before each launch (reinstalling Electron
resets it). It can only be switched while Humbler is closed; on the launch
that switches it, the app re-saves its existing cookies so they're stored
encrypted too. One-way: turning the fuse off again would mean logging in
again.


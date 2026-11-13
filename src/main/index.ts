// Humbler main process: the window (Humbler UI + the real humblebundle.com),
// sync, keys, downloads, scouting/harvesting, and the IPC API the UI uses
// (typed in src/shared/api.ts).
import "dotenv/config";
import { app, BaseWindow, WebContentsView, ipcMain, session, dialog, shell, clipboard, type Session, type WebContents } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { InvokeChannels } from "../shared/api";
import type { Busy, KeyEntry, LibraryIndex, RevealResult, SettingsPatch } from "../shared/types";
import { USERDATA_DIR, LOG_PATH, RECON_DIR } from "./lib/paths";
import { INJECT_SOURCE } from "./lib/inject-capture";
import * as harvest from "./lib/harvest";
import { ownedMarkerSource } from "./lib/owned-marker";
import { makeScrubber } from "./lib/scrub";
import { LiveScout, LIVE_DIR, endpointOf } from "./lib/live-scout";
import { ActionRegistry } from "./lib/actions";
import * as libraryV2 from "./lib/library-v2";
import * as redeemedStore from "./lib/redeemed";
import * as ordersV2 from "./lib/orders-v2";
import { flightData, resolvedFlightData, flightFromHtml, PAGE_FLIGHT_SCRIPT } from "./lib/rsc";
import * as settingsStore from "./lib/settings";
import * as lib from "./lib/library";
import { HumbleApi, NotLoggedInError, BASE } from "./lib/humble-api";
import { Downloader, type DownloadItem } from "./lib/downloader";
import { politeDelay } from "./lib/throttle";
import { applyKeyUpdates } from "./lib/key-updates";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const API_DELAY: [number, number] = [env("API_DELAY_MIN_MS", 700), env("API_DELAY_MAX_MS", 1800)];
const REVEAL_DELAY: [number, number] = [env("REVEAL_DELAY_MIN_MS", 1200), env("REVEAL_DELAY_MAX_MS", 2500)];
const URL_MAX_AGE_MS = env("URL_MAX_AGE_MINUTES", 20) * 60_000;

const PARTITION = "persist:humble";
const SIDEBAR_WIDTH = 680;
// electron-vite dev serves the UI from Vite (with React Fast Refresh).
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Keep the Humble login local to this project, not in the system-wide
// Electron userData location.
app.setPath("userData", USERDATA_DIR);

let win: BaseWindow | null = null; // hosts two views side by side
let uiView: WebContentsView | null = null; // the Humbler UI
let humbleView: WebContentsView | null = null; // real humblebundle.com, for logging in and anything Humbler can't do
let browserVisible = true;
let settings = settingsStore.load();
let index: LibraryIndex = { bundles: [], keys: [], files: [], products: [], choiceGroups: [] };
let busy: Busy = null; // "sync" | "reveal" while one of those is running

const humbleSession = (): Session => session.fromPartition(PARTITION);
/** The Humble pane's webContents (it exists once the window is created). */
const hv = (): WebContents => {
  if (!humbleView) throw new Error("the Humble pane isn't open");
  return humbleView.webContents;
};

const api = new HumbleApi(humbleSession, { pageFetch: (url: string) => pageFetch(url), log: (m: string) => log(m) });

// fetch() run inside the logged-in Humble page: same cookies and origin as
// the site's own code.
async function pageFetch(url: string) {
  await ensureHumblePageLoaded();
  const at = hv().getURL();
  if (!at.startsWith(`${BASE}/`)) {
    // Opening the library bounced us to the login site: genuinely logged out.
    throw new NotLoggedInError(`the Humble pane was sent to ${new URL(at).host}`);
  }
  return hv().executeJavaScript(`
    (async () => {
      const r = await fetch(${JSON.stringify(url)}, {
        credentials: "include",
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      });
      return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text(), finalUrl: r.url };
    })()
  `);
}

// ---- logging / UI messaging -------------------------------------------

function send(channel: string, payload?: unknown) {
  if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send(channel, payload);
}

const logHistory: string[] = []; // so the UI can show lines logged before it loaded

function log(message: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(line);
  logHistory.push(line);
  if (logHistory.length > 2000) logHistory.shift();
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break the app
  }
  send("log", line);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function rebuildIndex() {
  // The 2026 site's library (Sync v2) when synced; otherwise any legacy
  // /api/v1 order cache from before the redesign.
  const v2 = libraryV2.loadCache();
  const built = v2?.items?.length
    ? libraryV2.buildIndexV2(v2.items, { downloadDir: settings.downloadDir, naming: settings.naming })
    : lib.buildIndex(lib.loadAllOrders(), { downloadDir: settings.downloadDir, naming: settings.naming });
  index = { ...built, choiceGroups: built.choiceGroups || [] } as LibraryIndex;
  // Your own record of which keys you've activated on Steam/GOG/...
  const redeemedMap = redeemedStore.load();
  for (const k of index.keys) k.platformRedeemed = redeemedMap[k.id] || null;
  ownedTitles = null;
  liveScrubber = null; // new keys may be known now (sync / reveal)
  send("library-updated");
}

// Continuous scouting shares one scrubber, rebuilt whenever the set of
// known keys can have changed (every rebuildIndex).
let liveScrubber: ReturnType<typeof makeScrubber> | null = null;
const getLiveScrubber = () => (liveScrubber ||= makeScrubber());
const liveScout = new LiveScout({ log: (m: string) => log(m), getScrubber: getLiveScrubber });
// Which server action does what (ids change on every Humble deploy).
const actionRegistry = new ActionRegistry();
actionRegistry.seedFromCatalog(liveScout.catalog);

let ownedTitles: string[] | null = null; // normalized titles of everything you own (lazy)
function getOwnedTitles(): string[] {
  if (!ownedTitles) {
    const set = new Set<string>();
    for (const k of index.keys) set.add(lib.normTitle(k.name));
    for (const p of index.products) set.add(lib.normTitle(p.title));
    set.delete("");
    ownedTitles = [...set];
  }
  return ownedTitles;
}

// ---- login state ------------------------------------------------------

// Humble moved login to Ory (auth.humblebundle.com, late 2026), so there are
// two signals. First, what the API itself last told us (most reliable).
// Second, a cookie guess covering both the legacy session cookie and Ory's.
// The API signal is cleared whenever you pass through the auth pages, i.e.
// on log in or log out.
let apiLoginState: boolean | null = null;
const SESSION_COOKIE = /^(_simpleauth_sess|ory_session_.*|ory_kratos_session)$/;

async function isLoggedIn() {
  if (apiLoginState !== null) return apiLoginState;
  const cookies = await humbleSession().cookies.get({ domain: "humblebundle.com" });
  return cookies.some((c) => SESSION_COOKIE.test(c.name));
}

function noteApiLogin(ok: boolean) {
  apiLoginState = ok;
  void pushStatus();
}

async function pushStatus() {
  send("status", {
    loggedIn: await isLoggedIn(),
    browserVisible,
    downloadDir: settings.downloadDir,
    naming: settings.naming,
    markOwned: settings.markOwned,
    liveScout: settings.liveScout,
    theme: settings.theme,
    live: liveScout.summary(),
    busy,
    queue: downloader.summary(),
  });
}

// ---- sync, 2026 site (library server action) ----------------------------

const V2_LIMITS = [100, 50, 20, 5]; // page sizes to try; the site itself uses 5
const V2_CACHE_FORMAT = 2; // 2 = RSC references resolved (download details present)

// Raw Humble library items (external data, untyped).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawItem = any;

// How the downloads came through: enough to tell whether files and signed
// links were found, plus field names (never values) if they weren't.
function logDownloadDiagnostics(items: RawItem[]) {
  const ents = items.flatMap((it) => it.entitlements?.downloads || []);
  if (!ents.length) return;
  const withLinks = index.files.filter((f) => f.downloadable).length;
  log(`  Downloads: ${ents.length} download entitlements → ${index.files.length} files, ${withLinks} with download links.`);
  if (!index.files.length || withLinks < index.files.length) {
    const sample = ents.find((e: RawItem) => e.downloads && typeof e.downloads === "object") || ents[0];
    log(`  Download data shape (field names only): ${JSON.stringify(libraryV2.shapeOnly(sample)).slice(0, 1500)}`);
  }
}

// A queued download: the downloader basics plus what refreshing a link needs.
interface QueueItem extends DownloadItem {
  id: string;
  gamekey: string;
  url: string | null;
  rel: string;
  abs: string;
  size: number;
  md5: string | null;
  sha1: string | null;
  label: string;
  v2: boolean;
  itemId?: string;
  product: string;
}

// A signed download link expired: search the library for the item to get
// fresh links.
async function refreshV2File(item: QueueItem): Promise<string> {
  const action = actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
  if (!action) throw new Error("can't refresh the download link: library action unknown (open your library once)");
  await ensureHumblePageLoaded();
  const r = await hv().executeJavaScript(
    libraryV2.actionCallScript(action.id, action.page || "/home/library", libraryV2.libraryFields({ page: 1, limit: 20, requestId: Date.now() % 100000, query: item.product })),
  );
  const data = libraryV2.parseLibraryResponse(r.text);
  const it = data?.results?.find((x: RawItem) => x.id === item.itemId);
  if (!it) throw new Error("couldn't find this item again to refresh its download link");
  const fresh = libraryV2.buildIndexV2([it], { downloadDir: settings.downloadDir, naming: settings.naming }).files.find((f) => f.id === item.id);
  if (!fresh?.url) throw new Error("Humble returned no download link for this file on refresh");
  return fresh.url;
}

type Action = NonNullable<ReturnType<ActionRegistry["find"]>>;

async function callLibraryAction(action: Action, page: number, limit: number, requestId: number) {
  const r = await hv().executeJavaScript(libraryV2.actionCallScript(action.id, action.page || "/home/library", libraryV2.libraryFields({ page, limit, requestId })));
  const data = /x-component/i.test(r.contentType) ? libraryV2.parseLibraryResponse(r.text) : null;
  if (!data) {
    const snippet = String(r.text || "")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .replace(/[A-Za-z0-9]{12,}/g, "…");
    throw new Error(`library action gave HTTP ${r.status}, ${r.contentType || "no content-type"}: ${JSON.stringify(snippet)}`);
  }
  if (data.success === false) throw new Error(`library action reported failure: ${JSON.stringify(data.error ?? null).slice(0, 200)}`);
  return data;
}

async function syncLibrary({ full }: { full: boolean }): Promise<InvokeChannels["library:sync"][1]> {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  const action = actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
  if (!action) {
    log("Sync: Humbler hasn't yet seen how Humble's new library page loads your items.");
    log("  Open your library on the right (Humble library link above), let it load, then Sync again.");
    return { ok: false, reason: "action-unknown" };
  }
  busy = "sync";
  void pushStatus();
  try {
    await ensureHumblePageLoaded();
    if (!hv().getURL().startsWith(`${BASE}/`)) {
      noteApiLogin(false);
      log("Not logged in. Log in on the right, then sync again.");
      return { ok: false, reason: "not-logged-in" };
    }
    const cache = libraryV2.loadCache();
    const known = new Map<string, RawItem>((cache?.items || []).map((it: RawItem) => [it.id, it]));
    // Caches from before RSC references were resolved hold "$…" stubs where
    // download details belong. Incremental sync would keep those, so
    // re-fetch everything once.
    const staleFormat = known.size > 0 && cache?.format !== V2_CACHE_FORMAT;
    if (staleFormat && !full) log("  Library data format changed since your last sync; fetching everything once.");
    const incremental = !full && !staleFormat && known.size > 0;
    log(`${incremental ? "Syncing new items" : "Syncing your whole library"} via the new site (action ${action.id.slice(0, 10)}…)`);

    // Page size: ask big; if Humble caps it, use what it actually gives.
    let requestId = 1;
    let limit: number | null = null;
    let first: RawItem = null;
    for (const L of V2_LIMITS) {
      try {
        first = await callLibraryAction(action, 1, L, requestId++);
      } catch (err) {
        log(`  page size ${L}: ${errMsg(err)}`);
        continue;
      }
      const total = first.pagination?.totalDocs ?? 0;
      if (first.results.length === 0 && total > 0) continue;
      const chosen: number = first.results.length < L && first.results.length < total ? first.results.length : L;
      limit = chosen;
      if (chosen !== L) first = await callLibraryAction(action, 1, chosen, requestId++);
      break;
    }
    if (!first || limit == null) throw new Error("the library action didn't return items at any page size");
    const pageSize: number = limit; // fixed from here on
    noteApiLogin(true);
    const totalDocs: number = first.pagination?.totalDocs ?? first.results.length;
    const totalPages: number = first.pagination?.totalPages ?? 1;
    log(`  ${totalDocs} items in your library; fetching ${limit} per page (${totalPages} pages${incremental ? ", stopping at already-synced items" : ""})`);

    const fetched = new Map<string, RawItem>();
    const take = (results: RawItem[]) => {
      let fresh = 0;
      for (const it of results) {
        if (!fetched.has(it.id)) fresh += 1;
        fetched.set(it.id, it);
      }
      return fresh;
    };
    take(first.results);
    let stoppedEarly = false;
    for (let page = 2; page <= totalPages; page++) {
      if (incremental && [...fetched.keys()].slice(-pageSize).every((id) => known.has(id))) {
        stoppedEarly = true;
        break;
      }
      await politeDelay(...API_DELAY);
      const data = await callLibraryAction(action, page, pageSize, requestId++);
      if (take(data.results) === 0 && data.results.length) {
        throw new Error(`page ${page} returned only items already seen; paging isn't advancing (send me the log)`);
      }
      if (page % 10 === 0 || page === totalPages) log(`  page ${page}/${totalPages} (${fetched.size} items)`);
    }

    // Incremental: new/updated items first, then everything cached we didn't refetch.
    const items = [...fetched.values()];
    if (incremental) for (const [id, it] of known) if (!fetched.has(id)) items.push(it);
    libraryV2.saveCache({ format: V2_CACHE_FORMAT, fetchedAt: new Date().toISOString(), actionId: action.id, totalDocs, items });
    liveCache = null; // live key updates reload the fresh cache
    rebuildIndex();
    if (!incremental && items.length < totalDocs) log(`  Warning: got ${items.length} of ${totalDocs} items.`);
    log(
      `Sync done: ${stoppedEarly ? `${fetched.size} recent items checked` : `${fetched.size} items fetched`}. ` +
        `Library: ${index.products.length} items, ${index.keys.length} keys, ${index.files.length} files, ${index.bundles.length} bundles.`,
    );
    logDownloadDiagnostics(items);
    // Purchases (bundle icons, purchase dates, prices, key deadlines). A
    // failure here doesn't fail the library sync.
    await syncPurchases().catch((err) => log(`Purchases: ${errMsg(err)}`));
    return { ok: true, fetched: fetched.size };
  } catch (err) {
    log(`Sync failed: ${errMsg(err)}`);
    return { ok: false, reason: errMsg(err) };
  } finally {
    busy = null;
    void pushStatus();
  }
}

// ---- key reveal -------------------------------------------------------

// In-page requests need the pane on www.humblebundle.com. If it's elsewhere
// (the login page, an external site), open the library, which exists on
// the 2026 site; /home/keys may not.
async function ensureHumblePageLoaded() {
  const wc = hv();
  if (wc.getURL().startsWith(`${BASE}/`) && !wc.isLoading()) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 30000);
    wc.once("did-finish-load", () => {
      clearTimeout(t);
      resolve();
    });
    void wc.loadURL(`${BASE}/home/library`);
  });
}

// Runs the exact request Humble's own keys page made, from inside the real
// page, so it carries the same origin, cookies and CSRF token. (Legacy keys
// only: the 2026 site reveals through a mechanism not captured yet.)
async function revealOne(key: KeyEntry): Promise<string> {
  const csrf = (await humbleSession().cookies.get({ url: BASE, name: "csrf_cookie" }))[0]?.value || "";
  const payload = JSON.stringify({ keytype: key.machineName, key: key.gamekey, keyindex: String(key.keyindex), csrf });
  const result = await hv().executeJavaScript(`
    (async () => {
      const p = ${payload};
      const r = await fetch("/humbler/redeemkey", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "CSRF-Prevention-Token": p.csrf,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ keytype: p.keytype, key: p.key, keyindex: p.keyindex }),
      });
      return { status: r.status, text: await r.text() };
    })()
  `);
  let json: RawItem;
  try {
    json = JSON.parse(result.text);
  } catch {
    throw new Error(`HTTP ${result.status}, non-JSON reply`);
  }
  if (!json.success || !json.key) {
    const why = json.error_msg || (Array.isArray(json.errors) ? json.errors.join(", ") : "");
    throw new Error(why || `HTTP ${result.status}: ${result.text.slice(0, 160)}`);
  }
  return json.key;
}

async function revealKeys(ids: string[]): Promise<RevealResult> {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  busy = "reveal";
  void pushStatus();
  const results: NonNullable<RevealResult["results"]> = [];
  try {
    await ensureHumblePageLoaded();
    const wanted = new Set(ids);
    // New-site keys can't be revealed through the old endpoint; open them
    // on Humble's page instead (until the new reveal action is known).
    const v2Targets = index.keys.filter((k) => wanted.has(k.id) && k.status === "unused" && k.v2);
    if (v2Targets.length) {
      log("Revealing new-site keys from Humbler isn't supported yet. Opening the item on Humble so you can reveal it there.");
      openKeyOnHumble(v2Targets[0].id); // watched: picked up as soon as you reveal it
      return { ok: false, reason: "v2-reveal-unsupported", results };
    }
    const targets = index.keys.filter((k) => wanted.has(k.id) && k.status === "unused");
    log(`Revealing ${targets.length} key(s)…`);
    for (const [n, key] of targets.entries()) {
      try {
        const value = await revealOne(key);
        // Write it down before anything else can go wrong.
        lib.recordRevealedKey({ id: key.id, gamekey: key.gamekey, name: key.name, bundle: key.bundle, keyType: key.keyType, key: value, revealedAt: new Date().toISOString() });
        const order = lib.loadOrder(key.gamekey);
        const tpk = order?.tpkd_dict?.all_tpks?.find((t: RawItem) => lib.keyId(key.gamekey, t) === key.id);
        if (tpk) {
          tpk.redeemed_key_val = value;
          lib.saveOrder(order);
        }
        key.key = value;
        results.push({ id: key.id, ok: true });
        log(`  ${key.name}: revealed`);
      } catch (err) {
        results.push({ id: key.id, ok: false, error: errMsg(err) });
        log(`  ${key.name}: FAILED — ${errMsg(err)}`);
      }
      send("key-updated", { id: key.id, key: key.key });
      if (n < targets.length - 1) await politeDelay(...REVEAL_DELAY);
    }
    rebuildIndex();
    return { ok: true, results };
  } catch (err) {
    log(`Reveal failed: ${errMsg(err)}`);
    return { ok: false, reason: errMsg(err), results };
  } finally {
    busy = null;
    void pushStatus();
  }
}

// ---- downloads --------------------------------------------------------

const orderRefreshes = new Map<string, Promise<RawItem>>(); // gamekey -> in-flight promise
const refreshedAt = new Map<string, number>(); // gamekey -> ms

function refreshOrder(gamekey: string): Promise<RawItem> {
  let p = orderRefreshes.get(gamekey);
  if (!p) {
    p = api
      .fetchOrder(gamekey)
      .then((order: RawItem) => {
        lib.saveOrder(order);
        refreshedAt.set(gamekey, Date.now());
        return order;
      })
      .finally(() => orderRefreshes.delete(gamekey));
    orderRefreshes.set(gamekey, p);
  }
  return p;
}

async function resolveUrl(item: QueueItem, { force }: { force: boolean }): Promise<string> {
  if (item.v2) {
    // New-site files: use the signed link from sync; on 401/403/404/410
    // (force), fetch a fresh one.
    if (!force && item.url) return item.url;
    item.url = await refreshV2File(item);
    return item.url;
  }
  const age = Math.min(lib.orderAgeMs(item.gamekey), Date.now() - (refreshedAt.get(item.gamekey) || 0));
  if (!force && item.url && age < URL_MAX_AGE_MS) return item.url;
  const order = await refreshOrder(item.gamekey);
  const fresh = lib.buildIndex([order], { downloadDir: settings.downloadDir, naming: settings.naming }).files.find((f) => f.id === item.id);
  if (!fresh?.url) throw new Error("file no longer offered by Humble (no download URL after refresh)");
  item.url = fresh.url;
  return fresh.url;
}

const downloader = new Downloader<QueueItem>({
  getSession: humbleSession,
  resolveUrl,
  concurrency: env("DOWNLOAD_CONCURRENCY", 2),
  delayMin: env("DOWNLOAD_DELAY_MIN_MS", 500),
  delayMax: env("DOWNLOAD_DELAY_MAX_MS", 1500),
});

downloader.on("progress", (p) => send("download-progress", p));
downloader.on("completed", (item: QueueItem, { skipped }: { skipped: boolean }) => {
  lib.recordDownloaded({ id: item.id, rel: item.rel, size: item.size, md5: item.md5, at: new Date().toISOString() });
  const f = index.files.find((x) => x.id === item.id);
  if (f) f.downloaded = true;
  log(`  ${skipped ? "already had" : "downloaded"}: ${item.label}`);
  void pushStatus();
});
downloader.on("failed", (item: QueueItem, err: Error) => {
  log(`  download FAILED: ${item.label} — ${err.message}`);
  void pushStatus();
});
downloader.on("idle", () => {
  log("Download queue finished.");
  void pushStatus();
});

function enqueueDownloads(ids: string[]) {
  const wanted = new Set(ids);
  const items: QueueItem[] = index.files
    .filter((f) => wanted.has(f.id) && f.downloadable && !f.downloaded)
    .map((f) => ({
      id: f.id,
      gamekey: f.gamekey,
      url: f.url,
      rel: f.rel,
      abs: path.join(settings.downloadDir, f.rel),
      size: f.size,
      md5: f.md5,
      sha1: f.sha1,
      label: `${f.product} [${f.format || f.platform}] ${f.filename}`,
      v2: !!f.v2,
      itemId: f.itemId,
      product: f.product,
    }));
  const added = downloader.enqueue(items);
  log(`Queued ${added} file(s) → ${settings.downloadDir}`);
  void pushStatus();
  return { ok: true, added };
}

// ---- exports ----------------------------------------------------------

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportKeys(ids: string[] | null) {
  const wanted = ids ? new Set(ids) : null;
  const rows = index.keys.filter((k) => !wanted || wanted.has(k.id));
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export keys",
    defaultPath: `humble-keys-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });
  if (canceled || !filePath) return { ok: false, reason: "cancelled" };
  const fields = ["name", "keyType", "status", "key", "bundle", "created", "expiry", "daysLeft", "instructions", "steamAppId", "gamekey"] as const;
  const out = filePath.toLowerCase().endsWith(".json")
    ? JSON.stringify(rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))), null, 2)
    : [fields.join(","), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(","))].join("\r\n");
  fs.writeFileSync(filePath, out);
  log(`Exported ${rows.length} key(s) to ${filePath}`);
  return { ok: true, count: rows.length, filePath };
}

// ---- scouting (recon) -------------------------------------------------
// Same idea as pinterinter. The injected script (lib/inject-capture)
// records every JSON/RSC response the Humble page receives. A CDP Network
// log keeps metadata for *every* request. "Scout this page" dumps both,
// plus any data embedded in the page, to data/recon/<timestamp>-<page>/.

interface NetEntry {
  id: string;
  at: string;
  type: string;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
}

const NETWORK_LOG_MAX = 3000;
let networkLog: NetEntry[] = [];

function attachScout(wc: WebContents) {
  const dbg = wc.debugger;
  try {
    dbg.attach("1.3");
  } catch (err) {
    log(`Scouting unavailable (debugger attach failed: ${errMsg(err)})`);
    return;
  }
  dbg.sendCommand("Network.enable").catch(() => {});
  dbg.sendCommand("Page.enable").catch(() => {});
  // The binding the injected script pushes each response through. It's
  // installed in every current and future page context.
  dbg.sendCommand("Runtime.enable").catch(() => {});
  dbg.sendCommand("Runtime.addBinding", { name: "__humblerEmit" }).catch((err) => log(`Live scouting unavailable (binding failed: ${errMsg(err)})`));
  dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SOURCE }).catch((err) => log(`Scouting: script injection failed (${errMsg(err)})`));
  let livePushes = 0;
  dbg.on("message", (_event, method: string, params: RawItem) => {
    if (method === "Runtime.bindingCalled" && params.name === "__humblerEmit") {
      let entry: RawItem;
      try {
        entry = JSON.parse(params.payload);
      } catch {
        return;
      }
      // Always learn action ids (Sync depends on them), even with live
      // scouting off. Only names are kept, never values.
      actionRegistry.note(entry, wc.getURL());
      harvestOrders(entry); // purchases: icons, dates, prices, key deadlines
      applyLiveKeyUpdates(entry); // keys revealed/gifted on the site, right away
      if (entry.action && watchedItems.size) refreshWatchedSoon(); // a site action (e.g. a reveal) on an item you opened
      if (!settings.liveScout) return;
      try {
        liveScout.record(entry, wc.getURL());
        if (++livePushes % 25 === 0) void pushStatus(); // keep the UI's live counts fresh without spamming
      } catch (err) {
        log(`Live scout: could not record a response (${errMsg(err)})`);
      }
      return;
    }
    if (method === "Network.requestWillBeSent") {
      networkLog.push({ id: params.requestId, at: new Date().toISOString(), type: params.type, method: params.request.method, url: params.request.url });
      if (networkLog.length > NETWORK_LOG_MAX) networkLog.splice(0, networkLog.length - NETWORK_LOG_MAX);
    } else if (method === "Network.responseReceived") {
      const entry = networkLog.findLast((e) => e.id === params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.mimeType = params.response.mimeType || "";
      }
    }
  });
  dbg.on("detach", (_e, reason) => log(`Scouting detached (${reason}). Restart Humbler to re-enable it.`));
  // Each full page load starts a fresh capture in the page, so reset the
  // network log to match.
  wc.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) networkLog = [];
  });
}

function slugifyUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      (u.pathname + u.search)
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "home"
    );
  } catch {
    return "page";
  }
}

async function scoutPage({ reload }: { reload: boolean }): Promise<InvokeChannels["scout:page"][1]> {
  if (!humbleView) return { ok: false, reason: "no-window" };
  const wc = humbleView.webContents;
  if (reload) {
    log("Scouting: reloading so the page's data requests fire while we listen…");
    await new Promise<void>((resolve) => {
      wc.once("did-finish-load", () => resolve());
      wc.reload();
    });
    await politeDelay(2500, 3500); // let late XHRs land
  }

  // Everything below is scrubbed before it touches disk: no key values, no
  // raw gamekeys, no signed-URL tokens (see lib/scrub).
  const scrub = makeScrubber();
  const url = scrub.scrubText(wc.getURL());
  const raw = await collectPageData(wc);
  const captured: RawItem[] = scrub.scrubValue(raw.captured);
  const embedded: RawItem[] = scrub.scrubValue(raw.embedded);
  const flightRows = flightData(raw.flight);
  const html: string = await wc.executeJavaScript("document.documentElement.outerHTML").catch(() => "");

  const dir = path.join(RECON_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugifyUrl(url)}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    captured.forEach((entry, i) => scrub.writeScrubbed(path.join(dir, `${String(i + 1).padStart(4, "0")}.json`), entry));
    scrub.writeScrubbed(path.join(dir, "_network.json"), networkLog);
    if (embedded.length) scrub.writeScrubbed(path.join(dir, "_embedded.json"), embedded);
    // The page's embedded Next.js data, decoded from RSC rows to JSON.
    if (flightRows.length) scrub.writeScrubbed(path.join(dir, "_next-data.json"), flightRows);
    if (html) scrub.writeScrubbed(path.join(dir, "_page.html"), html);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`Scout aborted and its dump deleted: ${errMsg(err)}`);
    return { ok: false, reason: errMsg(err) };
  }

  // Summary of what the page talks to, so the interesting endpoints jump out.
  const counts = new Map<string, number>();
  for (const c of captured) {
    const k = `${c.action ? `ACTION ${c.action}` : c.method} ${endpointOf(c.url)}${c.kind === "rsc" ? " [rsc]" : ""} → ${c.status}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const s = scrub.stats;
  log(`  Scrubbed: ${s.keys} known key(s), ${s.fields} secret field(s), ${s.patterns} key-shaped string(s), ${s.gamekeys} gamekey(s) aliased, ${s.tokens} URL token(s)`);
  scrub.writeScrubbed(
    path.join(dir, "_summary.txt"),
    `Scouted: ${url}\n\nJSON responses by endpoint:\n` +
      summary.map(([k, n]) => `  ${String(n).padStart(4)}×  ${k}`).join("\n") +
      `\n\nEmbedded JSON blocks: ${embedded.map((e) => e.id || e.type).join(", ") || "none"}\n`,
  );

  log(`Scouted ${url}`);
  const rscCount = captured.filter((c) => c.kind === "rsc").length;
  log(
    `  ${captured.length - rscCount} JSON + ${rscCount} RSC response(s), ${networkLog.length} request(s) total, ` +
      `${embedded.length} embedded JSON block(s), ${flightRows.length} embedded Next.js data row(s)`,
  );
  for (const [k, n] of summary.slice(0, 15)) log(`    ${n}× ${k}`);
  if (summary.length > 15) log(`    …and ${summary.length - 15} more in _summary.txt`);
  log(`  Saved to ${dir}`);
  return { ok: true, dir, responses: captured.length };
}

interface PageData {
  captured: RawItem[];
  embedded: RawItem[];
  flight: string;
}

// Everything JSON-shaped the current Humble page knows: responses captured by
// the injected script, JSON embedded in <script> tags, and the embedded
// Next.js RSC payload.
async function collectPageData(wc: WebContents): Promise<PageData> {
  const grab = <T,>(expr: string, fallback: T): Promise<T> => wc.executeJavaScript(expr).catch(() => fallback);
  const captured = await grab<RawItem[]>("window.__humbler ? window.__humbler.captured : []", []);
  const embedded = await grab<RawItem[]>(
    `Array.from(document.querySelectorAll("script:not([src])"))
      .map((s) => {
        const text = s.textContent.trim();
        if (!/json/i.test(s.type || "") && !/json|data/i.test(s.id || "") && !/^[\\[{]/.test(text)) return null;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!parsed && !/json/i.test(s.type || "")) return null;
        return { id: s.id || null, type: s.type || null, json: parsed, text: parsed ? undefined : text.slice(0, 200000) };
      })
      .filter(Boolean)`,
    [],
  );
  const flight = await grab<string>(PAGE_FLIGHT_SCRIPT, "");
  return { captured, embedded, flight };
}

// Every JSON value a page holds, wherever it came from.
function pageJsonRoots({ captured, embedded, flight }: PageData): RawItem[] {
  return [
    ...captured.filter((c) => c.kind !== "rsc").map((c) => c.body),
    ...captured.filter((c) => c.kind === "rsc").flatMap((c) => flightData(c.text)),
    ...embedded.map((e) => e.json).filter(Boolean),
    ...flightData(flight),
  ].filter((v) => v && typeof v === "object");
}

// ---- harvesting (Choice) + owned marking ------------------------------

// Since the 2026 redesign there are no Choice month pages: the library
// page carries the current month (currentChoiceProductInfo).
const isMembershipPage = (url: string) => /^https:\/\/www\.humblebundle\.com\/membership(\/|$)/.test(url);
const isLibraryPage = (url: string) => /^https:\/\/www\.humblebundle\.com\/home\/library(\/|$|\?)/.test(url);
const isMarkablePage = (url: string) => /^https:\/\/www\.humblebundle\.com\//.test(url) && !/^https:\/\/www\.humblebundle\.com\/(home|downloads|login)/.test(url);
const LIBRARY_HARVEST_EVERY_MS = 5 * 60 * 1000; // library pages are opened constantly; Choice data changes monthly
let lastLibraryHarvest = 0;

async function harvestChoicePage(wc: WebContents) {
  const url = wc.getURL();
  const fromLibrary = isLibraryPage(url);
  if (fromLibrary) {
    if (Date.now() - lastLibraryHarvest < LIBRARY_HARVEST_EVERY_MS) return 0;
    lastLibraryHarvest = Date.now();
  }
  const pageData = await collectPageData(wc);
  const { captured, embedded, flight } = pageData;
  const dom = await wc.executeJavaScript(harvest.DOM_CHOICE_SCRIPT).catch(() => []);
  const roots = pageJsonRoots(pageData);
  const found = [...harvest.extractChoiceFromJson(roots, url), ...harvest.extractChoiceFromDom(dom, url)];
  // Raw harvests are large, so keep them only when they're informative.
  if (found.length || !fromLibrary) {
    try {
      harvest.saveRawHarvest("choice", url, { captured, embedded, flight: flightData(flight), dom, extracted: found }, makeScrubber());
    } catch (err) {
      log(`Choice: raw harvest not saved (${errMsg(err)})`);
    }
  }

  // Months with an order on your account are ones you were subscribed for.
  const orderMonths = new Map<string, string>();
  for (const b of index.bundles) {
    if (!/choice|monthly/i.test(`${b.machineName} ${b.name}`)) continue;
    const m = harvest.monthFromText(b.machineName) || harvest.monthFromText(b.name);
    if (m) orderMonths.set(m, b.gamekey);
  }
  for (const f of found) f.gamekey ||= orderMonths.get(f.month) || null;

  if (!found.length) {
    if (!fromLibrary) log(`Choice: nothing recognisable on ${url} (raw harvest saved under data/harvest/choice).`);
    return 0;
  }
  harvest.saveChoice(harvest.mergeChoice(harvest.loadChoice(), found));
  for (const f of found) {
    const games = Object.values(f.games) as { claimed: boolean }[];
    log(`Choice ${f.month}: ${games.length} games, ${games.filter((g) => g.claimed).length} claimed (from ${f.source})`);
  }
  send("choice-updated");
  return found.length;
}

async function markOwnedOnPage(wc: WebContents) {
  if (!settings.markOwned || !index.products.length) return;
  const n = await wc.executeJavaScript(ownedMarkerSource(getOwnedTitles())).catch(() => 0);
  if (n) log(`Marked ${n} owned item(s) on this page.`);
}

// Harvested months only, newest first.
function choiceView(): InvokeChannels["choice:get"][1] {
  const store = harvest.loadChoice();
  return Object.keys(store.months)
    .sort()
    .reverse()
    .map((m) => ({
      ...store.months[m],
      month: m,
      seen: true,
      url: store.months[m].source === "library" ? "https://www.humblebundle.com/home/library" : harvest.choiceMonthUrl(m),
    }));
}

// ---- live key updates (no full Sync needed) -------------------------------
// Keys you reveal (or gift...) on Humble's site are picked up as they happen:
// any response carrying a known key object updates the cache (see
// lib/key-updates). Keys opened from Humbler are also "watched": after the
// site's next server action on them, Humbler re-fetches just that item, in
// case the reveal reply itself doesn't carry the key.

let liveCache: ReturnType<typeof libraryV2.loadCache> | null = null; // the library cache, kept in memory
const getLiveCache = () => (liveCache ||= libraryV2.loadCache());

function commitKeyUpdates(r: ReturnType<typeof applyKeyUpdates>, cache: NonNullable<typeof liveCache>) {
  if (!r.changed) return;
  libraryV2.saveCache(cache);
  for (const k of r.revealed) {
    // Write it down before anything else can go wrong, like reveals made in Humbler.
    lib.recordRevealedKey({ id: `v2|${k.keyId}`, gamekey: k.bundleId, name: k.title, bundle: k.bundle, keyType: k.keyType, key: k.key, revealedAt: new Date().toISOString() });
    log(`Key revealed on Humble: ${k.title} (picked up live, no Sync needed)`);
    for (const [itemId] of watchedItems) if (itemId === k.itemId) watchedItems.delete(itemId);
  }
  rebuildIndex();
}

function applyLiveKeyUpdates(entry: RawItem) {
  try {
    const raw = entry.kind === "rsc" ? entry.text : entry.body;
    if (!raw || !(typeof raw === "string" ? raw : JSON.stringify(raw)).includes("redemptionData")) return; // cheap pre-check
    const cache = getLiveCache();
    if (!cache?.items?.length) return;
    commitKeyUpdates(applyKeyUpdates(cache.items, entry.kind === "rsc" ? resolvedFlightData(entry.text) : entry.body), cache);
  } catch (err) {
    log(`Live key update failed: ${errMsg(err)}`);
  }
}

const WATCH_MS = 15 * 60 * 1000;
const watchedItems = new Map<string, { title: string; until: number }>(); // item id -> what to search for
let watchTimer: ReturnType<typeof setTimeout> | undefined;

function refreshWatchedSoon() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => void refreshWatched(), 1500); // let the site finish its own update first
}

async function refreshWatched() {
  const action = actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
  const cache = getLiveCache();
  if (!action || !cache?.items?.length) return;
  for (const [itemId, w] of [...watchedItems]) {
    if (Date.now() > w.until) {
      watchedItems.delete(itemId);
      continue;
    }
    try {
      const r = await hv().executeJavaScript(
        libraryV2.actionCallScript(action.id, action.page || "/home/library", libraryV2.libraryFields({ page: 1, limit: 20, requestId: Date.now() % 100000, query: w.title })),
      );
      const data = libraryV2.parseLibraryResponse(r.text);
      if (data) commitKeyUpdates(applyKeyUpdates(cache.items, data), cache);
    } catch (err) {
      log(`Couldn't re-check "${w.title}": ${errMsg(err)}`);
    }
  }
}

/** Open a new-site key's item on Humble (to reveal it there) and watch it. */
function openKeyOnHumble(id: string) {
  const key = index.keys.find((k) => k.id === id);
  if (!key?.contentUrl) return;
  if (key.itemId) watchedItems.set(key.itemId, { title: key.name, until: Date.now() + WATCH_MS });
  setBrowserVisible(true);
  void hv().loadURL(key.contentUrl);
}

// ---- purchases (orders) ----------------------------------------------------

// Fetch one Purchases page from inside the logged-in Humble page and pull
// out its orders: its RSC data first, then the full HTML's embedded data.
async function fetchPurchasesPage(url: string) {
  const get = (rsc: boolean): Promise<{ status: number; contentType: string; text: string }> =>
    hv().executeJavaScript(`
      (async () => {
        const r = await fetch(${JSON.stringify(url)}, { credentials: "include", headers: ${rsc ? '{ RSC: "1" }' : "{}"} });
        return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
      })()
    `);
  for (const rsc of [true, false]) {
    const r = await get(rsc);
    if (r.status >= 400) throw new Error(`${url} gave HTTP ${r.status}`);
    const flight = /x-component/i.test(r.contentType) ? r.text : flightFromHtml(r.text);
    const found = ordersV2.extractOrders(resolvedFlightData(flight));
    if (found.orders.length) return found;
  }
  return null;
}

// All your orders, page by page. The paging parameter isn't known for sure,
// so candidates are tried and one is accepted only if page 2 really
// returns different orders.
async function syncPurchases() {
  await ensureHumblePageLoaded();
  if (!hv().getURL().startsWith(`${BASE}/`)) return;
  const first = await fetchPurchasesPage(`${BASE}/home/purchases`);
  if (!first) {
    log("Purchases: couldn't find your order list on the Purchases page. Open Purchases on the right and click to page 2 once, so scouting can learn how it loads.");
    return;
  }
  ordersV2.merge(first);
  const total = first.totalDocs ?? first.orders.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, first.orders.length)));
  const seen = new Set(first.orders.map((o) => o.id));
  if (pages > 1) {
    let param: string | null = null;
    for (const p of ["page", "p", "pageNumber"]) {
      await politeDelay(...API_DELAY);
      const second = await fetchPurchasesPage(`${BASE}/home/purchases?${p}=2`).catch(() => null);
      if (second?.orders.some((o) => !seen.has(o.id))) {
        param = p;
        ordersV2.merge(second);
        second.orders.forEach((o) => seen.add(o.id));
        break;
      }
    }
    if (!param) {
      log(`Purchases: got page 1 of ${pages}, but couldn't work out how Humble pages the list. Open Purchases on the right and click to page 2 once, then Sync again.`);
    } else {
      for (let n = 3; n <= pages; n++) {
        await politeDelay(...API_DELAY);
        const page = await fetchPurchasesPage(`${BASE}/home/purchases?${param}=${n}`);
        if (!page) break;
        ordersV2.merge(page);
        page.orders.forEach((o) => seen.add(o.id));
      }
    }
  }
  const known = Object.keys(ordersV2.load().orders).length;
  log(`Purchases: ${known} of ${total} orders known (icons, purchase dates, prices, key deadlines).`);
  send("orders-updated");
}

// Harvested passively from any page reply that carries your order list
// (see lib/orders-v2; only non-personal fields are kept).
function harvestOrders(entry: RawItem) {
  try {
    const raw = entry.kind === "rsc" ? entry.text : entry.body;
    if (!raw || !(typeof raw === "string" ? raw : JSON.stringify(raw)).includes("lineItems")) return; // cheap pre-check
    const found = ordersV2.extractOrders(entry.kind === "rsc" ? resolvedFlightData(entry.text) : entry.body);
    const added = ordersV2.merge(found);
    if (added) {
      const store = ordersV2.load();
      const have = Object.keys(store.orders).length;
      log(`Purchases: ${added} new order(s); ${have}${store.totalDocs ? ` of ${store.totalDocs}` : ""} known. Bundle icons and deadlines updated.`);
      send("orders-updated");
    }
  } catch (err) {
    log(`Purchases: couldn't read order data (${errMsg(err)})`);
  }
}

// First run: pick up orders already sitting in scout dumps (they're scrubbed,
// but the fields we keep survive scrubbing).
function seedOrdersFromRecon() {
  if (Object.keys(ordersV2.load().orders || {}).length) return;
  let files = 0;
  try {
    for (const dir of fs.readdirSync(RECON_DIR)) {
      const full = path.join(RECON_DIR, dir);
      if (dir === "live" || !fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!/^\d+\.json$/.test(f)) continue;
        const text = fs.readFileSync(path.join(full, f), "utf8");
        if (!text.includes("lineItems")) continue;
        harvestOrders(JSON.parse(text));
        files += 1;
      }
    }
  } catch {
    // no recon yet
  }
  if (files) log(`Purchases: read orders from ${files} earlier scout file(s).`);
}

// ---- window -----------------------------------------------------------

function layout() {
  if (!win || !uiView || !humbleView) return;
  const { width, height } = win.getContentBounds();
  const uiWidth = browserVisible ? Math.min(SIDEBAR_WIDTH, width) : width;
  uiView.setBounds({ x: 0, y: 0, width: uiWidth, height });
  humbleView.setBounds({ x: uiWidth, y: 0, width: Math.max(0, width - uiWidth), height });
  humbleView.setVisible(browserVisible);
}

// ---- keeping the login across restarts --------------------------------
// Chromium drops cookies that have no expiry ("session cookies") when the
// app closes, and logins often use them, so you'd be logged out on every
// restart. Give Humble's session cookies a 30-day expiry instead. A cookie
// Humble deletes (logout) stays deleted, because only newly set cookies are
// touched. Cookies are also flushed to disk shortly after any change and on
// quit, so a crash or forced close can't lose a fresh login.
const SESSION_COOKIE_DAYS = env("SESSION_COOKIE_DAYS", 30);
const HUMBLE_COOKIE_DOMAIN = /(^|\.)humblebundle\.com$/i;

function keepLoginAcrossRestarts(ses: Session) {
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushSoon = () => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => ses.cookies.flushStore().catch(() => {}), 1000);
  };
  ses.cookies.on("changed", (_e, cookie, _cause, removed) => {
    const domain = (cookie.domain || "").replace(/^\./, "");
    if (!HUMBLE_COOKIE_DOMAIN.test(domain)) return;
    flushSoon();
    if (removed || cookie.expirationDate || !SESSION_COOKIE_DAYS) return; // already persistent, or being deleted
    const details: Electron.CookiesSetDetails = {
      url: `https://${domain}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Date.now() / 1000 + SESSION_COOKIE_DAYS * 86400,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain; // keep host-only cookies host-only (__Host- rules)
    ses.cookies.set(details).catch((err) => log(`Could not persist cookie ${cookie.name}: ${errMsg(err)}`));
  });
}

function setBrowserVisible(visible: boolean) {
  browserVisible = visible;
  layout();
  void pushStatus();
}

function createWindow() {
  // Drop "Electron/x.y" from the UA so Humble (and Cloudflare in front of
  // it) sees what a regular Chrome would.
  const ses = humbleSession();
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|humbler)\/\S+/gi, ""));
  keepLoginAcrossRestarts(ses);

  win = new BaseWindow({ width: 1600, height: 960, title: "Humbler", backgroundColor: "#16171b" });
  win.setMenuBarVisibility(false);

  uiView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: true },
  });
  humbleView = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true } });
  win.contentView.addChildView(uiView);
  win.contentView.addChildView(humbleView);
  layout();

  if (DEV_URL) {
    void uiView.webContents.loadURL(DEV_URL);
    uiView.webContents.openDevTools({ mode: "detach" });
  } else {
    void uiView.webContents.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  attachScout(humbleView.webContents); // before the first load, so it's injected from the start
  void humbleView.webContents.loadURL(`${BASE}/home/library`);

  // Pop-up links from Humble's site stay in the pane (or go to your real browser).
  humbleView.webContents.setWindowOpenHandler(({ url }) => {
    if (PANE_URL.test(url)) void hv().loadURL(url);
    else if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  uiView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Surface UI script errors in the Humbler log instead of losing them.
  uiView.webContents.on("console-message", (e: RawItem, legacyLevel?: RawItem, legacyMessage?: RawItem) => {
    const level = e?.level ?? legacyLevel;
    if (level === "error" || level === 3) log(`[ui error] ${e?.message ?? legacyMessage}`);
  });

  const onNav = (_e: unknown, url: string) => {
    // Passing through the auth pages means login state is about to change.
    if (/^https:\/\/auth\.humblebundle\.com\//.test(url) || /\/logout/.test(url)) apiLoginState = null;
    void pushStatus();
  };
  humbleView.webContents.on("did-navigate", onNav);
  humbleView.webContents.on("did-navigate-in-page", onNav);

  // Harvest Choice data and orders as you browse, and highlight owned items
  // on store/bundle pages.
  const afterLoad = async (fullLoad: boolean) => {
    const wc = humbleView?.webContents;
    if (!wc) return;
    const url = wc.getURL();
    await politeDelay(2000, 2500);
    if (!humbleView || wc.getURL() !== url) return; // navigated away meanwhile
    // Full loads only: __next_f isn't updated by client-side navigation,
    // whose data arrives as RSC fetches that are captured anyway.
    if (fullLoad && /^https:\/\/www\.humblebundle\.com\//.test(url)) {
      const flight: string = await wc.executeJavaScript(PAGE_FLIGHT_SCRIPT).catch(() => "");
      if (flight) {
        harvestOrders({ kind: "rsc", text: flight }); // orders embedded in the first load
        if (settings.liveScout) liveScout.record({ kind: "rsc", method: "PAGE", url, status: 200, text: flight }, url);
      }
    }
    if (isMembershipPage(url) || isLibraryPage(url)) {
      await harvestChoicePage(wc).catch((err) => log(`Choice harvest failed: ${errMsg(err)}`));
    }
    if (isMarkablePage(url)) await markOwnedOnPage(wc);
  };
  humbleView.webContents.on("did-finish-load", () => void afterLoad(true));
  humbleView.webContents.on("did-navigate-in-page", () => void afterLoad(false));

  win.on("resize", layout);
  // Coming back to Humbler (e.g. from Steam's redeem page in your browser):
  // the UI uses this to ask whether you redeemed the key.
  win.on("focus", () => send("app-focus"));
  win.on("closed", () => {
    downloader.cancelAll();
    win = uiView = humbleView = null;
    // Quit explicitly: a detached DevTools window (dev) would otherwise keep
    // the app alive with no main window.
    app.quit();
  });
}

// ---- IPC (typed against src/shared/api.ts) -----------------------------

function handle<K extends keyof InvokeChannels>(
  channel: K,
  fn: (...args: InvokeChannels[K][0]) => InvokeChannels[K][1] | Promise<InvokeChannels[K][1]>,
) {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeChannels[K][0])));
}

const idList = (ids: unknown): string[] => (Array.isArray(ids) ? ids.map(String) : []);

handle("library:get", () => index);
handle("log:history", () => logHistory);
handle("choice:get", () => choiceView());
// Only the Humble site itself (www + login) opens in the pane. Everything
// else, including Humble's support/help pages, goes to your real browser.
const PANE_URL = /^https:\/\/(www|auth)\.humblebundle\.com\//;
handle("browser:open", (url) => {
  if (typeof url !== "string") return;
  if (PANE_URL.test(url)) {
    setBrowserVisible(true);
    void hv().loadURL(url);
  } else if (/^https?:\/\//.test(url)) {
    void shell.openExternal(url);
  }
});
handle("browser:external", (url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
});
handle("keys:open-on-humble", (id) => openKeyOnHumble(String(id)));
handle("settings:set", (patch: SettingsPatch) => {
  const next = { ...settings };
  if (patch?.naming && settingsStore.NAMING.includes(patch.naming)) next.naming = patch.naming;
  if (typeof patch?.markOwned === "boolean") next.markOwned = patch.markOwned;
  if (patch?.theme === "dark" || patch?.theme === "light") next.theme = patch.theme;
  if (typeof patch?.liveScout === "boolean") {
    next.liveScout = patch.liveScout;
    if (patch.liveScout !== settings.liveScout) log(`Live scouting ${patch.liveScout ? "on" : "off"}.`);
  }
  const namingChanged = next.naming !== settings.naming;
  settings = next;
  settingsStore.save(settings);
  if (namingChanged) {
    log(`File naming: ${settings.naming === "title" ? "<Product> - <Publisher>.<ext>" : "Humble's original file names"}`);
    rebuildIndex();
  }
  void pushStatus();
});
handle("scout:page", (opts) => scoutPage({ reload: !!opts?.reload }));
handle("scout:open-live", () => {
  liveScout.saveNow();
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  return shell.openPath(LIVE_DIR);
});
handle("scout:open-folder", () => {
  fs.mkdirSync(RECON_DIR, { recursive: true });
  return shell.openPath(RECON_DIR);
});
handle("status:get", () => pushStatus());
handle("library:sync", (opts) => syncLibrary({ full: !!opts?.full }));
handle("keys:reveal", (ids) => revealKeys(idList(ids)));
handle("keys:export", (ids) => exportKeys(Array.isArray(ids) ? idList(ids) : null));
handle("downloads:enqueue", (ids) => enqueueDownloads(idList(ids)));
handle("downloads:cancel", () => {
  downloader.cancelAll();
  log("Cancelled download queue (partial files are kept and will resume).");
  void pushStatus();
});
handle("downloads:open-folder", () => {
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  return shell.openPath(settings.downloadDir);
});
handle("downloads:reveal-file", (id) => {
  const f = index.files.find((x) => x.id === id);
  if (f) shell.showItemInFolder(path.join(settings.downloadDir, f.rel));
});
handle("settings:choose-download-dir", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Download folder",
    defaultPath: settings.downloadDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return;
  settings = { ...settings, downloadDir: filePaths[0] };
  settingsStore.save(settings);
  log(`Download folder: ${settings.downloadDir}`);
  rebuildIndex();
  void pushStatus();
});
handle("browser:toggle", () => setBrowserVisible(!browserVisible));
handle("browser:go", (where) => {
  const routes: Record<string, string> = {
    library: "/home/library",
    keys: "/home/keys",
    purchases: "/home/purchases",
    login: "/login",
    choice: "/membership/home",
  };
  setBrowserVisible(true);
  void hv().loadURL(BASE + (routes[where] || "/home/library"));
});
handle("clipboard:write", (text) => clipboard.writeText(String(text ?? "")));
handle("orders:get", () => {
  const store = ordersV2.load();
  return { orders: Object.values(store.orders || {}), totalDocs: store.totalDocs ?? null };
});
handle("redeem:mark", ({ id, redeemed, platform }) => {
  const key = index.keys.find((k) => k.id === id);
  if (!key) return null;
  key.platformRedeemed = redeemedStore.mark(id, { redeemed: !!redeemed, platform: platform ?? null });
  log(`${key.name}: ${redeemed ? `marked as redeemed on ${platform || "its platform"}` : "marked as not redeemed"}.`);
  return key.platformRedeemed;
});

// ---- lifecycle ----------------------------------------------------------

void app.whenReady().then(() => {
  seedOrdersFromRecon();
  rebuildIndex();
  createWindow();
  log(`Loaded ${index.bundles.length} cached orders, ${index.keys.length} keys, ${index.files.length} files.`);
});

// Write cookies (your login) to disk before exiting. Quitting waits for the
// flush, but only briefly.
let flushedOnQuit = false;
app.on("before-quit", (e) => {
  liveScout.saveNow();
  if (flushedOnQuit) return;
  e.preventDefault();
  flushedOnQuit = true;
  Promise.race([humbleSession().cookies.flushStore(), new Promise((r) => setTimeout(r, 2000))])
    .catch(() => {})
    .finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());

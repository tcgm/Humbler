// Humbler main process: the window (Humbler UI + the real humblebundle.com),
// sync, keys, downloads, scouting/harvesting, and the IPC API the UI uses
// (typed in src/shared/api.ts).
import dotenv from "dotenv";
import { app, BaseWindow, WebContentsView, ipcMain, session, dialog, shell, clipboard, safeStorage, type Session, type WebContents } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { InvokeChannels } from "../shared/api";
import type { Busy, FolderInspect, FoldersInfo, KeyEntry, LibraryIndex, RevealResult, SettingsPatch } from "../shared/types";
import { USERDATA_DIR, LOG_PATH, RECON_DIR } from "./lib/paths";
import { checkForUpdate, type UpdateInfo } from "./lib/updates";

// .env tuning (DOWNLOAD_CONCURRENCY etc.) is for running from source; an
// installed app ignores any .env in whatever folder it was started from.
if (!app.isPackaged) dotenv.config();
import { INJECT_SOURCE } from "./lib/inject-capture";
import * as harvest from "./lib/harvest";
import { ownedMarkerSource } from "./lib/owned-marker";
import { makeScrubber } from "./lib/scrub";
import { LiveScout, LIVE_DIR, endpointOf } from "./lib/live-scout";
import { ActionRegistry, SCAN_ACTIONS_SCRIPT, argNames, scanActionsOfPageScript, StaleActionError, isStaleActionReply } from "./lib/actions";
import * as libraryV2 from "./lib/library-v2";
import * as secrets from "./lib/secret-store";
import * as redeemedStore from "./lib/redeemed";
import * as ordersV2 from "./lib/orders-v2";
import { flightData, resolvedFlightData, flightFromHtml, PAGE_FLIGHT_SCRIPT } from "./lib/rsc";
import * as settingsStore from "./lib/settings";
import { Wishlists } from "./lib/steam-wishlists";
import * as lib from "./lib/library";
import { HumbleApi, NotLoggedInError, BASE } from "./lib/humble-api";
import { Downloader, type DownloadItem } from "./lib/downloader";
import { politeDelay, sleep } from "./lib/throttle";
import { applyKeyUpdates, applyRevealReply } from "./lib/key-updates";
import { matchBundleDirs, matchFiles, nameScore, scanFolders, SKIP_NAME, type DiskScan } from "./lib/disk-scan";

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
  // ...or, for keys Humble redeemed to your account itself, that.
  for (const k of index.keys) k.platformRedeemed = redeemedMap[k.id] || k.autoRedeemed || null;
  applyDiskScan();
  ownedTitles = null;
  liveScrubber = null; // new keys may be known now (sync / reveal)
  send("library-updated");
}

// ---- download folders: what's already on disk ------------------------------
// Every folder in settings (plus the default download folder) is scanned for
// bundle folders and files (names only), matched to the library, and the
// result applied to the index: files found count as downloaded, bundles
// know their folders, and new downloads for a bundle that already has a
// folder go into that folder.

let diskScan: DiskScan | null = null;
let scanning = false;
let bundleDirMatch = new Map<string, string[]>(); // gamekey -> folders

const scanRoots = () => [settings.downloadDir, ...settings.folders.filter((f) => path.resolve(f) !== path.resolve(settings.downloadDir))];

function applyDiskScan() {
  bundleDirMatch = diskScan ? matchBundleDirs(index.bundles, diskScan.bundleDirs, settings.folderLinks) : new Map();
  const found = diskScan
    ? matchFiles(
        index.files.map((f) => ({ id: f.id, gamekey: f.gamekey, filename: f.filename, product: f.product, publisher: f.publisher, size: f.size, machineName: f.machineName || f.productMachine })),
        diskScan,
        bundleDirMatch,
      )
    : new Map();
  const onDiskPer = new Map<string, number>();
  const olderPer = new Map<string, number>();
  for (const f of index.files) {
    const hit = found.get(f.id) || null;
    f.onDisk = hit;
    if (hit && hit.how !== "size-differs" && hit.how !== "older-version") {
      f.downloaded = true;
      onDiskPer.set(f.gamekey, (onDiskPer.get(f.gamekey) || 0) + 1);
    }
    if (hit?.how === "older-version") olderPer.set(f.gamekey, (olderPer.get(f.gamekey) || 0) + 1);
    const home = bundleDirMatch.get(f.gamekey)?.[0];
    f.dest = hit?.how === "file" ? hit.path : home ? path.join(home, f.filename) : path.join(settings.downloadDir, f.rel);
  }
  for (const b of index.bundles) {
    b.diskDirs = bundleDirMatch.get(b.gamekey) || [];
    b.filesOnDisk = onDiskPer.get(b.gamekey) || 0;
    b.olderOnDisk = olderPer.get(b.gamekey) || 0;
  }
}

async function rescanFolders(reason: string) {
  if (scanning) return;
  scanning = true;
  send("folders-updated");
  try {
    const roots = scanRoots();
    diskScan = await scanFolders(roots);
    rebuildIndex();
    const filesFound = index.files.filter((f) => f.onDisk && f.onDisk.how !== "size-differs" && f.onDisk.how !== "older-version").length;
    log(
      `Folders (${reason}): ${diskScan.files} files and ${diskScan.dirs} folders in ${roots.length} location(s), ${(diskScan.ms / 1000).toFixed(1)}s. ` +
        `${[...bundleDirMatch.keys()].length} bundles have a folder; ${filesFound} of ${index.files.length} files found on disk.` +
        (diskScan.missingRoots.length ? ` Not found: ${diskScan.missingRoots.join(", ")}.` : "") +
        (diskScan.truncated ? " (Stopped early: too many files.)" : ""),
    );
  } catch (err) {
    log(`Folder scan failed: ${errMsg(err)}`);
  } finally {
    scanning = false;
    send("folders-updated");
  }
}

function foldersInfo(): FoldersInfo {
  const byDir = new Map<string, string[]>();
  for (const [gk, dirs] of bundleDirMatch) for (const d of dirs) byDir.set(d, [...(byDir.get(d) || []), gk]);
  // what each bundle folder holds (as far as the scan reads)
  const counts = new Map<string, { files: number; folders: number }>();
  for (const list of diskScan?.byName.values() || [])
    for (const e of list) {
      if (!e.bundleDir || e.path === e.bundleDir) continue;
      const c = counts.get(e.bundleDir) || { files: 0, folders: 0 };
      if (e.dir) c.folders += 1;
      else c.files += 1;
      counts.set(e.bundleDir, c);
    }
  return {
    downloadDir: settings.downloadDir,
    folders: settings.folders.filter((f) => path.resolve(f) !== path.resolve(settings.downloadDir)),
    scanning,
    scan: diskScan ? { at: diskScan.at, files: diskScan.files, dirs: diskScan.dirs, ms: diskScan.ms, missing: diskScan.missingRoots, truncated: diskScan.truncated } : null,
    bundleDirs: (diskScan?.bundleDirs || []).map((d) => ({ path: d.path, name: d.name, root: d.root, gamekeys: byDir.get(d.path) || [], linked: d.path in settings.folderLinks, ...(counts.get(d.path) || { files: 0, folders: 0 }) })),
  };
}

function saveFolders(patch: Partial<Pick<typeof settings, "downloadDir" | "folders" | "folderLinks">>) {
  settings = { ...settings, ...patch };
  settingsStore.save(settings);
  void pushStatus();
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
    busyDetail,
    queue: downloader.summary(),
    version: app.getVersion(),
    update: updateAvailable,
  });
}

// ---- new-version notice (notify only; nothing is downloaded) --------------
let updateAvailable: UpdateInfo | null = null;
async function updateCheck() {
  try {
    const u = await checkForUpdate(app.getVersion());
    if (u && u.version !== updateAvailable?.version) log(`Humbler ${u.version} is available (you have ${app.getVersion()}): ${u.url}`);
    updateAvailable = u;
    void pushStatus();
  } catch {
    // offline, or no release yet: try again later
  }
}
function startUpdateChecks() {
  // installed builds only (or HUMBLER_CHECK_UPDATES=1 to try it from source)
  if (!app.isPackaged && process.env.HUMBLER_CHECK_UPDATES !== "1") return;
  setTimeout(() => void updateCheck(), 15_000);
  setInterval(() => void updateCheck(), 12 * 60 * 60 * 1000);
}
let busyDetail: string | null = null;

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
  entitlementId?: string;
  urlExpiresAt?: string | null;
  product: string;
}

// A signed download link expired: search the library for the item to get
// fresh links.
async function refreshV2File(item: QueueItem): Promise<string> {
  if (item.entitlementId) {
    // Fresh signed links for just this entitlement (what the site's Download button does).
    const cache = getLiveCache();
    const it = cache?.items?.find((x: RawItem) => x.id === item.itemId);
    const ent = it?.entitlements?.downloads?.find((e: RawItem) => e.id === item.entitlementId);
    if (it && ent) {
      await fetchDownloadLinks(ent);
      libraryV2.saveCache(cache);
      const fresh = libraryV2.buildIndexV2([it], { downloadDir: settings.downloadDir, naming: settings.naming }).files.find((f) => f.id === item.id);
      if (fresh?.url) {
        item.urlExpiresAt = fresh.urlExpiresAt;
        return fresh.url;
      }
    }
  }
  await ensureHumblePageLoaded();
  const data = await withLibraryAction((a) => callLibraryAction(a, 1, 20, Date.now() % 100000, item.product));
  const it = data?.results?.find((x: RawItem) => x.id === item.itemId);
  if (!it) throw new Error("couldn't find this item again to refresh its download link");
  const fresh = libraryV2.buildIndexV2([it], { downloadDir: settings.downloadDir, naming: settings.naming }).files.find((f) => f.id === item.id);
  if (!fresh?.url) throw new Error("Humble returned no download link for this file on refresh");
  return fresh.url;
}

type Action = NonNullable<ReturnType<ActionRegistry["find"]>>;

async function callLibraryAction(action: Action, page: number, limit: number, requestId: number, query = "") {
  const r = await hv().executeJavaScript(libraryV2.actionCallScript(action.id, ActionRegistry.postPath(action), libraryV2.libraryFields({ page, limit, requestId, query })));
  const data = /x-component/i.test(r.contentType) ? libraryV2.parseLibraryResponse(r.text) : null;
  if (!data && isStaleActionReply(r.status, r.text)) throw new StaleActionError(`library action ${action.id.slice(0, 10)}… is gone (HTTP ${r.status}): Humble has updated its site`);
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

// Humble deployed a new build and the library action's id changed. Find the
// new one: wait briefly in case the library page calls it itself, then scan
// the page's scripts for server actions and try the ones named like a
// library listing (only those: other actions may change things).
const LIBRARY_ACTION_FN = "filterUserLibrary"; // its function name in the site's code (stable across deploys)
const LIBRARY_ACTION_NAME = /librar|search|list|filter|query/i;
const MUTATION_NAME = /pay|redeem|record|gift|claim|purchase|cancel|delete|remove|update|^set|create|refresh|save|submit|send|subscribe|reveal|action$/i;

async function relearnLibraryAction(staleId: string | null): Promise<Action | null> {
  if (staleId) actionRegistry.forget(staleId);
  log("  Humble has updated its site; looking up the library action's new id…");
  const wc = hv();
  if (!new URL(wc.getURL() || "about:blank").pathname.startsWith("/home/library") || wc.isLoading()) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30000);
      wc.once("did-finish-load", () => {
        clearTimeout(t);
        resolve();
      });
      void wc.loadURL(`${BASE}/home/library`);
    });
  }
  const fresh = () => actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
  for (let i = 0; i < 6 && !fresh(); i++) await new Promise((r) => setTimeout(r, 500));
  if (fresh()) return fresh();

  let found: { id: string; name: string | null }[] = [];
  try {
    found = await wc.executeJavaScript(SCAN_ACTIONS_SCRIPT);
  } catch (err) {
    log(`  Couldn't scan the site's scripts: ${errMsg(err)}`);
  }
  const named = found.filter((a) => a.name);
  log(`  Site scripts reference ${found.length} server actions${named.length ? ` (${named.map((a) => a.name).join(", ").slice(0, 300)})` : ""}.`);
  const rank = (n: string) => (n === LIBRARY_ACTION_FN ? 0 : /librar/i.test(n) ? 1 : 2);
  const tryOrder = named
    .filter((a) => a.name === LIBRARY_ACTION_FN || (LIBRARY_ACTION_NAME.test(a.name!) && !MUTATION_NAME.test(a.name!)))
    .sort((a, b) => rank(a.name!) - rank(b.name!))
    .slice(0, 6);
  for (const c of tryOrder) {
    const candidate: Action = { id: c.id, args: libraryV2.LIBRARY_ACTION_ARGS, page: "/home/library", firstSeen: "", lastSeen: "" };
    try {
      const data = await callLibraryAction(candidate, 1, 5, 1);
      if (Array.isArray(data?.results)) {
        actionRegistry.learn(c.id, ["cursor", "dateExpires", "hideExpired", "hideRevealed", "limit", "page", "query", "requestId", "sort"], "/home/library", c.name);
        log(`  Found it: ${c.name} (${c.id.slice(0, 10)}…).`);
        return fresh();
      }
    } catch {
      // not this one
    }
  }
  log("  Couldn't identify the new library action automatically. On the right, go to page 2 of your library (or search it) once, then Sync again.");
  return null;
}

// ---- download links (getSignedUrlsForEntitlements) -------------------------

/** Find a server action by its function name: from the registry, else by
 *  scanning the scripts of a page that uses it (opened in the pane). */
async function actionByName(name: string, pageUrl: string | null, staleId?: string): Promise<Action | null> {
  if (staleId) actionRegistry.forget(staleId);
  const known = actionRegistry.findByName(name);
  if (known) return known;
  // Never navigate the pane (that's yours): scan the scripts of the page
  // that uses the action by fetching it in the background, plus whatever the
  // pane has loaded already.
  await ensureHumblePageLoaded();
  const wc = hv();
  let found: { id: string; name: string | null }[] = [];
  try {
    found = [...(pageUrl ? await wc.executeJavaScript(scanActionsOfPageScript(pageUrl)) : []), ...(await wc.executeJavaScript(SCAN_ACTIONS_SCRIPT))];
  } catch (err) {
    log(`  Couldn't scan the site's scripts: ${errMsg(err)}`);
  }
  // Learn every named action seen (names and ids only), for next time.
  for (const a of found) {
    if (!a.name) continue;
    const known = actionRegistry.data.actions[a.id];
    if (!known) actionRegistry.learn(a.id, [], pageUrl ? new URL(pageUrl).pathname : new URL(wc.getURL()).pathname, a.name);
    else if (!known.name) {
      known.name = a.name;
      actionRegistry.save();
    }
  }
  return actionRegistry.findByName(name);
}

/** Fetch one download entitlement's signed links into the entitlement (in place). */
async function fetchDownloadLinks(ent: RawItem, pageUrl?: string): Promise<boolean> {
  let action = await actionByName(libraryV2.SIGNED_URLS_ACTION, pageUrl || null);
  if (!action) throw new Error(`couldn't find Humble's ${libraryV2.SIGNED_URLS_ACTION} action`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const postTo = ActionRegistry.postPath(action, pageUrl ? new URL(pageUrl).pathname : "/home/library");
    const r = await hv().executeJavaScript(libraryV2.jsonActionCallScript(action.id, postTo, [[ent.id]]));
    if (isStaleActionReply(r.status, r.text) && attempt === 0) {
      action = await actionByName(libraryV2.SIGNED_URLS_ACTION, pageUrl || null, action.id);
      if (!action) throw new Error(`Humble updated its site and ${libraryV2.SIGNED_URLS_ACTION} wasn't found again`);
      continue;
    }
    const reply = /x-component/i.test(r.contentType) ? libraryV2.parseSignedUrlsReply(r.text) : null;
    if (!reply) {
      const snippet = String(r.text || "").replace(/\s+/g, " ").slice(0, 120).replace(/[A-Za-z0-9]{12,}/g, "…");
      throw new Error(`download links: HTTP ${r.status}, ${r.contentType || "no content-type"}: ${JSON.stringify(snippet)}`);
    }
    ent.signedUrlsFetchedAt = new Date().toISOString();
    ent.signedUrls = reply.ok ? reply.signedUrls : null;
    ent.signedUrlsExpiresAt = reply.expiresAt;
    return reply.ok;
  }
  return false;
}

// ---- file lists (purchase pages) ------------------------------------------
// A purchase page (/home/library/<productEntitlementId>) carries the full
// file list of every item in it: names, sizes, md5/sha1, web/torrent file
// names. One background request per purchase (the pane isn't touched).

function getPurchasePage(peId: string, rsc: boolean): Promise<{ status: number; type: string; text: string }> {
  const url = `/home/library/${encodeURIComponent(peId)}`;
  return hv().executeJavaScript(`
    (async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: "include", headers: ${rsc ? '{ RSC: "1" }' : "{}"} });
      return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
    })()
  `);
}

async function fetchPurchaseFileLists(peId: string): Promise<Map<string, RawItem[]>> {
  let r = await getPurchasePage(peId, true);
  let lists = /x-component/i.test(r.type) ? libraryV2.extractDownloadLists(resolvedFlightData(r.text)) : new Map<string, RawItem[]>();
  if (!lists.size) {
    r = await getPurchasePage(peId, false); // the full page, with its data embedded
    lists = libraryV2.extractDownloadLists(resolvedFlightData(flightFromHtml(r.text)));
  }
  if (!lists.size && r.status >= 400) throw new Error(`purchase page ${peId.slice(0, 8)}…: HTTP ${r.status}`);
  return lists;
}

// ---- focused refresh: the bundle you're looking at, first -------------------
// Sync's incremental pass only re-reads recently added items, so a key you
// revealed on Humble for an older purchase wouldn't show up. Sync first
// re-reads the purchase page of whatever bundle (or Choice month) is open in
// Humbler: every key's current state, plus its file lists.

async function refreshPurchases(peIds: string[]) {
  const cache = getLiveCache();
  if (!cache?.items?.length || !peIds.length) return;
  const known = new Set(cache.items.map((it: RawItem) => String(it.productEntitlementId || it.id)));
  const todo = peIds.filter((id) => known.has(id)); // 2026-site purchases only (not legacy gamekeys)
  for (const pe of todo) {
    const name = cache.items.find((it: RawItem) => String(it.productEntitlementId || it.id) === pe)?.subTitle || pe.slice(0, 8);
    try {
      let r = await getPurchasePage(pe, true);
      let value = /x-component/i.test(r.type) ? resolvedFlightData(r.text) : [];
      let keys = applyKeyUpdates(cache.items, value);
      let lists = libraryV2.extractDownloadLists(value);
      if (!lists.size && !keys.changed) {
        r = await getPurchasePage(pe, false); // the full page, with its data embedded
        value = resolvedFlightData(flightFromHtml(r.text));
        keys = applyKeyUpdates(cache.items, value);
        lists = libraryV2.extractDownloadLists(value);
      }
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      let files = 0;
      for (const it of cache.items) {
        if (String(it.productEntitlementId || it.id) !== pe) continue;
        for (const ent of it.entitlements?.downloads || []) {
          const list = lists.get(ent.id);
          if (!list) continue;
          ent.downloads = list;
          ent.downloadsFetchedAt = new Date().toISOString();
          files += 1;
        }
      }
      if (files && !keys.changed) libraryV2.saveCache(cache);
      commitKeyUpdates(keys, cache); // saves, logs reveals, rebuilds the index
      if (files && !keys.changed) rebuildIndex();
      log(`Refreshed "${name}" first: ${keys.revealed.length ? `${keys.revealed.length} newly revealed key(s)` : keys.changed ? "key states updated" : "keys unchanged"}${files ? `, ${files} file list(s)` : ""}.`);
    } catch (err) {
      log(`Couldn't refresh "${name}" first: ${errMsg(err)}`);
    }
  }
}

async function syncFileLists({ full }: { full: boolean }) {
  const cache = getLiveCache();
  if (!cache?.items?.length) return;
  // purchases with download items that have no file list yet
  const byPurchase = new Map<string, RawItem[]>();
  for (const it of cache.items) {
    for (const ent of it.entitlements?.downloads || []) {
      if (!full && Array.isArray(ent.downloads) && ent.downloadsFetchedAt) continue;
      const pe = it.productEntitlementId || it.id;
      byPurchase.set(pe, [...(byPurchase.get(pe) || []), ent]);
    }
  }
  if (!byPurchase.size) return;
  const todo = [...byPurchase.entries()];
  const total = todo.reduce((n, [, e]) => n + e.length, 0);
  log(`File lists: reading ${todo.length} purchase page(s) for ${total} download item(s)…`);
  await ensureHumblePageLoaded();
  let pages = 0;
  let got = 0;
  let failed = 0;
  let next = 0;
  let lastLog = Date.now();
  const worker = async () => {
    while (next < todo.length && failed < 10) {
      const [pe, ents] = todo[next++];
      try {
        const lists = await fetchPurchaseFileLists(pe);
        for (const ent of ents) {
          const list = lists.get(ent.id);
          if (!list) continue;
          ent.downloads = list;
          ent.downloadsFetchedAt = new Date().toISOString();
          got += 1;
        }
      } catch (err) {
        failed += 1;
        log(`  ${errMsg(err)}`);
      }
      pages += 1;
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        busyDetail = `file lists ${pages}/${todo.length}`;
        void pushStatus();
        log(`  file lists: ${pages}/${todo.length} purchases · ${got} items with files`);
      }
      await politeDelay(200, 500);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  busyDetail = null;
  libraryV2.saveCache(cache);
  rebuildIndex();
  log(
    `File lists: ${got} of ${total} download item(s) from ${pages} purchase page(s)${failed ? `, ${failed} failed${failed >= 10 ? " (stopped)" : ""}` : ""}. ` +
      `${index.files.length} files (${index.files.filter((f) => f.size > 0).length} with sizes, ${index.files.filter((f) => f.downloadable).length} downloadable).`,
  );
}

async function syncDownloadLinks({ full }: { full: boolean }) {
  // Share the in-memory cache with live key updates, so neither saves over the other.
  const cache = getLiveCache();
  if (!cache?.items?.length) return;
  const todo: { it: RawItem; ent: RawItem }[] = [];
  for (const it of cache.items) for (const ent of it.entitlements?.downloads || []) if (!ent.downloads && (full || !ent.signedUrlsFetchedAt)) todo.push({ it, ent });
  if (!todo.length) return;
  log(`Downloads: fetching download links for ${todo.length} item(s)${todo.length > 200 ? " (the first time takes a while; later Syncs only fetch new ones)" : ""}…`);
  // The action's code loads on item pages: open one to find it.
  const pageUrl = `${BASE}/home/library/content/${todo[0].it.id}`;
  let ok = 0;
  let none = 0;
  let failed = 0;
  let filesSeen = 0;
  let shapeLogged = false;
  let next = 0;
  const t0 = Date.now();
  let lastLog = t0;
  let lastSave = 0;
  const progress = (final = false) => {
    const done = ok + none + failed;
    const rate = done / Math.max(1, (Date.now() - t0) / 1000);
    const left = rate > 0 ? Math.round((todo.length - done) / rate) : 0;
    busyDetail = `download links ${done}/${todo.length}`;
    void pushStatus();
    if (!final) log(`  download links: ${done}/${todo.length} · ${filesSeen} files so far · ~${left >= 120 ? `${Math.round(left / 60)} min` : `${left}s`} left`);
  };
  const worker = async () => {
    while (next < todo.length && failed < 10) {
      const { ent } = todo[next++];
      try {
        if (await fetchDownloadLinks(ent, pageUrl)) ok += 1;
        else none += 1;
        filesSeen += libraryV2.structsFromSignedUrls(ent.signedUrls).length;
        // (the first reply with files in it: some items have none, e.g. coupons)
        if (!shapeLogged && ent.signedUrls && libraryV2.structsFromSignedUrls(ent.signedUrls).length) {
          shapeLogged = true;
          log(`  Download links reply (field names only): ${JSON.stringify(libraryV2.shapeOnly(ent.signedUrls)).slice(0, 400)}`);
        }
      } catch (err) {
        failed += 1;
        log(`  ${errMsg(err)}`);
      }
      const done = ok + none + failed;
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        progress();
      }
      // save and show what's found so far, every 250 items
      if (done - lastSave >= 250) {
        lastSave = done;
        libraryV2.saveCache(cache);
        rebuildIndex();
      }
      await politeDelay(150, 400);
    }
  };
  // Find the action once before the workers start.
  await actionByName(libraryV2.SIGNED_URLS_ACTION, pageUrl);
  await Promise.all([worker(), worker(), worker()]);
  busyDetail = null;
  void pushStatus();
  libraryV2.saveCache(cache);
  rebuildIndex();
  log(
    `Downloads: links for ${ok} of ${todo.length} item(s)${none ? `, ${none} with none` : ""}${failed ? `, ${failed} failed${failed >= 10 ? " (stopped)" : ""}` : ""}. ` +
      `${index.files.length} files, ${index.files.filter((f) => f.downloadable).length} downloadable.`,
  );
}

/** Run `fn` with the library action, relearning it once if Humble redeployed. */
async function withLibraryAction<T>(fn: (a: Action) => Promise<T>): Promise<T> {
  const action = actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
  if (!action) throw new Error("library action unknown (open your library once)");
  try {
    return await fn(action);
  } catch (err) {
    if (!(err instanceof StaleActionError)) throw err;
    const next = await relearnLibraryAction(action.id);
    if (!next) throw err;
    return fn(next);
  }
}

async function syncLibrary({ full, focus }: { full: boolean; focus?: string[] }): Promise<InvokeChannels["library:sync"][1]> {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  let action = actionRegistry.find(libraryV2.LIBRARY_ACTION_ARGS, /^\/home\/library/);
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
    // What you're looking at first (before the cache below is read, so the pass keeps it).
    if (focus?.length) await refreshPurchases(focus);
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
    let relearned = false;
    for (let li = 0; li < V2_LIMITS.length; li++) {
      const L = V2_LIMITS[li];
      try {
        first = await callLibraryAction(action, 1, L, requestId++);
      } catch (err) {
        if (err instanceof StaleActionError && !relearned) {
          relearned = true;
          log(`  ${errMsg(err)}`);
          const next = await relearnLibraryAction(action.id);
          if (!next) return { ok: false, reason: "action-unknown" };
          action = next;
          li -= 1; // same page size again, with the new id
          continue;
        }
        if (err instanceof StaleActionError) throw err;
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
    libraryV2.carryOverDownloadLinks(items, known); // the listing has no download links; keep the ones fetched before
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
    // Download links: the listing doesn't include them, so fetch each
    // download entitlement's (new ones only after the first time).
    await syncFileLists({ full }).catch((err) => log(`File lists: ${errMsg(err)}`));
    await syncDownloadLinks({ full }).catch((err) => log(`Downloads: ${errMsg(err)}`));
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

// 2026-site keys: the request Humble's own Reveal button sends, from inside
// the real page. It's the server action redeemEntitlementAction with
// [key id, key type, undefined] (seen in the live catalog; a key's id is its
// item's id), replying {success, key}. Humble redeems keyless keys (e.g.
// epic_keyless) to your linked account the same way its button does.
const REVEAL_ACTION = "redeemEntitlementAction";

/** stop revealing the rest: they'd fail the same way */
class RevealStopError extends Error {}

async function revealOneV2(key: KeyEntry): Promise<void> {
  const rawId = key.id.replace(/^v2\|/, "");
  const pagePath = key.contentUrl ? new URL(key.contentUrl, BASE).pathname : `/home/library/content/${key.itemId || rawId}`;
  let action = await actionByName(REVEAL_ACTION, `${BASE}${pagePath}`);
  if (!action) throw new RevealStopError(`Humble's reveal action isn't known yet: reveal one key on Humble (right) and try again`);
  const args = [rawId, key.keyType, "$undefined"]; // exactly as the site sends it
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await hv().executeJavaScript(libraryV2.jsonActionCallScript(action.id, pagePath, args));
    if (isStaleActionReply(r.status, r.text)) {
      if (attempt === 0) {
        action = await actionByName(REVEAL_ACTION, `${BASE}${pagePath}`, action.id);
        if (action) continue;
      }
      throw new RevealStopError(`Humble updated its site and its reveal action wasn't found again`);
    }
    const value = /x-component/i.test(r.contentType) ? resolvedFlightData(r.text) : null;
    const reply = value?.find((v: RawItem) => v && typeof v === "object" && "success" in v);
    if (!reply) throw new Error(`unexpected reply (HTTP ${r.status}, ${r.contentType || "no content-type"})`);
    if (reply.success !== true) throw new Error(`Humble said no: ${JSON.stringify(reply.error ?? reply.message ?? null).slice(0, 200)}`);
    // Into the cache (and the revealed-keys safety log) the same way a reveal on the site is picked up.
    const cache = getLiveCache();
    if (cache?.items?.length) {
      const res = applyRevealReply(cache.items, args, value);
      if (res.changed) commitKeyUpdates(res, cache);
    }
    if (typeof reply.key !== "string" || !reply.key.trim() || reply.key === "$undefined") log(`  ${key.name}: Humble confirmed it, without a key in the reply (keyless, or a Sync will show it)`);
    send("key-updated", { id: key.id, key: typeof reply.key === "string" ? reply.key : null });
    return;
  }
}

// Runs the exact request Humble's own keys page made, from inside the real
// page, so it carries the same origin, cookies and CSRF token. (Legacy keys
// only; 2026-site keys go through revealOneV2.)
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
    // New-site keys: Humble's own Reveal button (a server action), one at a time.
    const v2Targets = index.keys.filter((k) => wanted.has(k.id) && k.status === "unused" && k.v2);
    if (v2Targets.length) {
      log(`Revealing ${v2Targets.length} key(s) on Humble…`);
      for (const [n, key] of v2Targets.entries()) {
        try {
          await revealOneV2(key);
          results.push({ id: key.id, ok: true });
          log(`  ${key.name}: revealed`);
        } catch (err) {
          results.push({ id: key.id, ok: false, error: errMsg(err) });
          log(`  ${key.name}: FAILED: ${errMsg(err)}`);
          if (err instanceof RevealStopError) break; // the action is gone or not known: the rest would fail the same way
        }
        busyDetail = `revealing ${n + 1}/${v2Targets.length}`;
        void pushStatus();
        if (n < v2Targets.length - 1) await politeDelay(...REVEAL_DELAY);
      }
      busyDetail = null;
    }
    const targets = index.keys.filter((k) => wanted.has(k.id) && k.status === "unused" && !k.v2);
    if (!targets.length) return { ok: results.some((r) => r.ok) || !results.length, results };
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
        log(`  ${key.name}: FAILED: ${errMsg(err)}`);
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
    const expired = item.urlExpiresAt ? Date.parse(item.urlExpiresAt) < Date.now() + 5 * 60 * 1000 : false;
    if (!force && item.url && !expired) return item.url;
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
downloader.on("kept-older", (item: QueueItem, aside: string) => log(`Kept the older ${item.filename} on disk as ${path.basename(aside)}`));
downloader.on("completed", (item: QueueItem, { skipped }: { skipped: boolean }) => {
  lib.recordDownloaded({ id: item.id, rel: item.rel, size: item.size, md5: item.md5, at: new Date().toISOString() });
  const f = index.files.find((x) => x.id === item.id);
  if (f) f.downloaded = true;
  log(`  ${skipped ? "already had" : "downloaded"}: ${item.label}`);
  void pushStatus();
});
downloader.on("failed", (item: QueueItem, err: Error) => {
  log(`  download FAILED: ${item.label}: ${err.message}`);
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
      abs: f.dest || path.join(settings.downloadDir, f.rel),
      size: f.size,
      md5: f.md5,
      sha1: f.sha1,
      label: `${f.product} [${f.format || f.platform}] ${f.filename}`,
      v2: !!f.v2,
      itemId: f.itemId,
      entitlementId: f.entitlementId,
      urlExpiresAt: f.urlExpiresAt,
      product: f.product,
    }));
  const added = downloader.enqueue(items);
  log(`Queued ${added} file(s) → ${settings.downloadDir}`);
  void pushStatus();
  return { ok: true, added };
}

// ---- exports ----------------------------------------------------------
// The Export window builds the text (keys, CSV, JSON) itself; this only
// asks where to put it and writes it.

const SAVE_TYPES: Record<string, string> = { csv: "CSV", json: "JSON", txt: "Text" };

async function saveTextFile(name: string, text: string) {
  const ext = (path.extname(name).slice(1) || "txt").toLowerCase();
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save export",
    defaultPath: path.basename(name),
    filters: [{ name: SAVE_TYPES[ext] || ext.toUpperCase(), extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, reason: "cancelled" };
  fs.writeFileSync(filePath, text);
  log(`Exported to ${filePath}`);
  return { ok: true, filePath };
}

// ---- scouting (recon) -------------------------------------------------
// The injected script (lib/inject-capture)
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

let quitting = false; // set on quit: detaches are expected then
app.on("before-quit", () => {
  quitting = true;
});

// Attach the debugger and set up capture (again after a detach).
function attachDebugger(wc: WebContents): boolean {
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (err) {
    log(`Scouting unavailable (debugger attach failed: ${errMsg(err)})`);
    return false;
  }
  dbg.sendCommand("Network.enable").catch(() => {});
  dbg.sendCommand("Page.enable").catch(() => {});
  // The binding the injected script pushes each response through. It's
  // installed in every current and future page context.
  dbg.sendCommand("Runtime.enable").catch(() => {});
  dbg.sendCommand("Runtime.addBinding", { name: "__humblerEmit" }).catch((err) => log(`Live scouting unavailable (binding failed: ${errMsg(err)})`));
  dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SOURCE }).catch((err) => log(`Scouting: script injection failed (${errMsg(err)})`));
  return true;
}

function attachScout(wc: WebContents) {
  const dbg = wc.debugger;
  if (!attachDebugger(wc)) return;
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
      // A site action (e.g. a reveal) on an item you opened. Not the library
      // listing itself: Humbler's own re-check calls that, which would loop.
      if (entry.action && watchedItems.size && !libraryV2.LIBRARY_ACTION_ARGS.every((a) => argNames(entry.requestBody).includes(a))) refreshWatchedSoon();
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
  // Detached while running (a renderer swap, DevTools taking over...):
  // re-attach, so live capture (key reveals, action ids) keeps working.
  // The page's capture script returns on its next load.
  let reattaches = 0;
  dbg.on("detach", (_e, reason) => {
    if (quitting || wc.isDestroyed()) return;
    if (++reattaches > 20) {
      log(`Scouting detached (${reason}) too often; restart Humbler to re-enable it.`);
      return;
    }
    setTimeout(() => {
      if (quitting || wc.isDestroyed() || dbg.isAttached()) return;
      if (attachDebugger(wc)) log(`Scouting re-attached (it was detached: ${reason}).`);
    }, 1000);
  });
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
  if (r.revealed.length) liveScrubber = null; // so recon scrubbing knows the new keys
  for (const k of r.revealed) {
    // Write it down before anything else can go wrong, like reveals made in Humbler.
    lib.recordRevealedKey({ id: `v2|${k.keyId}`, gamekey: k.bundleId, name: k.title, bundle: k.bundle, keyType: k.keyType, key: k.key, revealedAt: new Date().toISOString() });
    if (/_keyless$/i.test(k.keyType)) log(`${k.title}: redeemed to your account by Humble (picked up live, no Sync needed; Humble's redemption code kept)`);
    else log(`Key revealed on Humble: ${k.title} (picked up live, no Sync needed)`);
    for (const [itemId] of watchedItems) if (itemId === k.itemId) watchedItems.delete(itemId);
  }
  rebuildIndex();
}

function applyLiveKeyUpdates(entry: RawItem) {
  try {
    const raw = entry.kind === "rsc" ? entry.text : entry.body;
    if (!raw) return;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const isReply = !!entry.action && /"key"\s*:/.test(text); // maybe the reveal action's {success, key}
    if (!isReply && !text.includes("redemptionData")) return; // cheap pre-check
    const cache = getLiveCache();
    if (!cache?.items?.length) return;
    const value = entry.kind === "rsc" ? resolvedFlightData(entry.text) : entry.body;
    if (isReply) {
      let args: unknown = entry.requestBody;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }
      const r = applyRevealReply(cache.items, args, value);
      if (r.changed) return commitKeyUpdates(r, cache);
    }
    commitKeyUpdates(applyKeyUpdates(cache.items, value), cache);
  } catch (err) {
    log(`Live key update failed: ${errMsg(err)}`);
  }
}

const WATCH_MS = 15 * 60 * 1000;
const watchedItems = new Map<string, { title: string; until: number; checks?: number }>(); // item id -> what to search for
const WATCH_MAX_CHECKS = 5; // re-checks per opened item, then just the passive matching
let watchTimer: ReturnType<typeof setTimeout> | undefined;

function refreshWatchedSoon() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => void refreshWatched(), 1500); // let the site finish its own update first
}

async function refreshWatched() {
  const cache = getLiveCache();
  if (!cache?.items?.length) return;
  for (const [itemId, w] of [...watchedItems]) {
    w.checks = (w.checks || 0) + 1;
    if (Date.now() > w.until || w.checks > WATCH_MAX_CHECKS) {
      watchedItems.delete(itemId);
      continue;
    }
    try {
      const data = await withLibraryAction((a) => callLibraryAction(a, 1, 20, Date.now() % 100000, w.title));
      const r2 = data ? applyKeyUpdates(cache.items, data) : null;
      if (r2?.changed) commitKeyUpdates(r2, cache);
      else log(`Re-checked "${w.title}" on Humble: ${data ? "no change yet" : "unexpected reply"}`);
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
  void openInPane(key.contentUrl);
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

  win = new BaseWindow({
    width: 1600,
    height: 960,
    title: "Humbler",
    backgroundColor: "#16171b",
    icon: path.join(__dirname, "../../resources", process.platform === "win32" ? "icon.ico" : "icon.png"),
  });
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
        applyLiveKeyUpdates({ kind: "rsc", text: flight }); // keys, e.g. a purchase page showing keys revealed elsewhere
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
// Opening a Humble page from Humbler. Some item/purchase pages answer
// "The page you requested cannot be found" when opened directly; when that
// happens, say so (with the URL, so links can be fixed) and fall back to the
// item's purchase page, then to Purchases.
const NOT_FOUND_SCRIPT = `/page you requested cannot be found/i.test(document.body ? document.body.innerText.slice(0, 4000) : "")`;

function fallbacksFor(url: string): string[] {
  const out: string[] = [];
  const m = /\/home\/library\/content\/([^/?#]+)/.exec(url);
  if (m) {
    const it = getLiveCache()?.items?.find((x: RawItem) => x.id === m[1] || (x.entitlements?.keys || []).some((k: RawItem) => k.id === m[1]));
    if (it?.productEntitlementId) out.push(`${BASE}/home/library/${it.productEntitlementId}`);
  }
  out.push(`${BASE}/home/purchases`);
  return out.filter((u) => u !== url);
}

async function openInPane(url: string, fallbacks = fallbacksFor(url)) {
  setBrowserVisible(true);
  const wc = hv();
  try {
    await wc.loadURL(url);
  } catch {
    // aborted by a redirect or a newer navigation; checked below anyway
  }
  await sleep(1200); // the not-found message is rendered client-side
  if (wc.getURL().split("#")[0] !== url.split("#")[0] && !wc.getURL().startsWith(url)) return; // navigated elsewhere meanwhile
  let missing = false;
  try {
    missing = await wc.executeJavaScript(NOT_FOUND_SCRIPT);
  } catch {
    return;
  }
  if (!missing) return;
  const next = fallbacks[0];
  log(`Humble says this page doesn't exist: ${url.replace(BASE, "")}${next ? `; opening ${next.replace(BASE, "")} instead` : ""}`);
  if (next) void openInPane(next, fallbacks.slice(1));
}

handle("browser:open", (url) => {
  if (typeof url !== "string") return;
  if (PANE_URL.test(url)) {
    void openInPane(url);
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
handle("library:sync", (opts) => syncLibrary({ full: !!opts?.full, focus: Array.isArray(opts?.focus) ? opts.focus.filter((x: unknown): x is string => typeof x === "string").slice(0, 20) : undefined }));
handle("keys:reveal", (ids) => revealKeys(idList(ids)));
handle("file:save-text", (opts) => saveTextFile(String(opts?.name || "export.txt"), String(opts?.text ?? "")));
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
  if (f) shell.showItemInFolder(f.onDisk?.path || f.dest || path.join(settings.downloadDir, f.rel));
});
handle("settings:choose-download-dir", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Download folder",
    defaultPath: settings.downloadDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return;
  setDefaultFolder(filePaths[0]);
});

function setDefaultFolder(dir: string) {
  const prev = settings.downloadDir;
  const folders = [...new Set([...settings.folders, prev].map((f) => path.resolve(f)))].filter((f) => f !== path.resolve(dir));
  saveFolders({ downloadDir: path.resolve(dir), folders });
  log(`Default download folder: ${settings.downloadDir} (the previous one is still scanned)`);
  void rescanFolders("default folder changed");
}

handle("folders:get", () => foldersInfo());
handle("folders:add", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title: "Add a folder with Humble downloads", properties: ["openDirectory", "multiSelections"] });
  if (canceled || !filePaths.length) return;
  saveFolders({ folders: [...new Set([...settings.folders, ...filePaths.map((f) => path.resolve(f))])] });
  void rescanFolders("folder added");
});
handle("folders:remove", (dir) => {
  saveFolders({ folders: settings.folders.filter((f) => path.resolve(f) !== path.resolve(dir)) });
  void rescanFolders("folder removed");
});
handle("folders:set-default", (dir) => setDefaultFolder(dir));
handle("folders:rescan", () => void rescanFolders("rescan"));
handle("folders:link", ({ path: dir, gamekey }) => {
  const links = { ...settings.folderLinks };
  if (gamekey === undefined) delete links[dir];
  else links[dir] = gamekey;
  saveFolders({ folderLinks: links });
  rebuildIndex(); // matching only, no rescan needed
  send("folders-updated");
});
handle("folders:inspect", async (dir): Promise<FolderInspect> => {
  let dirents: fs.Dirent[] = [];
  try {
    dirents = (await fs.promises.readdir(dir, { withFileTypes: true })).filter((d) => !SKIP_NAME.test(d.name));
  } catch {
    // gone
  }
  dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  // every name the scan saw inside this folder
  const names = new Set<string>();
  for (const list of diskScan?.byName.values() || []) for (const e of list) if (e.bundleDir === dir && e.path !== dir) names.add(e.lower);
  const hits = new Map<string, number>();
  for (const f of index.files) {
    const lower = f.filename.toLowerCase();
    if (names.has(lower) || names.has(path.basename(lower, path.extname(lower)))) hits.set(f.gamekey, (hits.get(f.gamekey) || 0) + 1);
  }
  const base = path.basename(dir);
  const suggestions = index.bundles
    .map((b) => ({ gamekey: b.gamekey, nameScore: nameScore(base, b.name), fileHits: hits.get(b.gamekey) || 0 }))
    .filter((s) => s.fileHits > 0 || s.nameScore >= 0.3)
    .sort((a, b) => b.fileHits - a.fileHits || b.nameScore - a.nameScore)
    .slice(0, 12);
  return {
    path: dir,
    entries: dirents.slice(0, 300).map((d) => ({ name: d.name, dir: d.isDirectory() || d.isSymbolicLink() })),
    total: dirents.length,
    suggestions,
    names: [...names].slice(0, 20000),
  };
});
handle("folders:open", async (dir) => {
  // The default download folder may not exist until the first download.
  if (path.resolve(dir) === path.resolve(settings.downloadDir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir)) {
    log(`Can't open ${dir}: it doesn't exist (moved, renamed, or a drive that isn't connected?)`);
    return;
  }
  const err = await shell.openPath(dir);
  if (err) log(`Couldn't open ${dir}: ${err}`);
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
// Steam wishlists (yours or friends'), compared with your library in the UI
const wishlists = new Wishlists({ log: (m) => log(m), onChange: () => send("wishlists-updated") });
handle("wishlists:get", () => wishlists.view());
handle("wishlists:add", (input) => wishlists.add(String(input ?? "").slice(0, 300)));
handle("wishlists:remove", (steamId) => wishlists.remove(String(steamId)));
handle("wishlists:refresh", (steamId) => wishlists.refresh(typeof steamId === "string" ? steamId : null));
handle("redeem:mark", ({ id, redeemed, platform }) => {
  const key = index.keys.find((k) => k.id === id);
  if (!key) return null;
  key.platformRedeemed = redeemedStore.mark(id, { redeemed: !!redeemed, platform: platform ?? null }) || key.autoRedeemed || null;
  log(`${key.name}: ${redeemed ? `marked as redeemed on ${platform || "its platform"}` : "marked as not redeemed"}.`);
  return key.platformRedeemed;
});

// ---- lifecycle ----------------------------------------------------------

if (process.platform === "win32") app.setAppUserModelId("Humbler"); // its own taskbar entry and icon, not Electron's
// Key values on disk are sealed with the OS's per-user encryption (see
// secret-store). Set up first, before anything reads or writes them.
function setUpKeySealing() {
  if (!safeStorage.isEncryptionAvailable()) {
    log("Warning: the OS's encryption isn't available, so keys are stored unencrypted.");
    return;
  }
  secrets.setCipher({ encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) });
  // files from before sealing existed
  try {
    let sealed = lib.sealRevealedLog();
    const plain = libraryV2.cachePlainSecrets();
    if (plain) {
      const cache = libraryV2.loadCache();
      if (cache) {
        libraryV2.saveCache(cache);
        sealed += plain;
      }
    }
    if (sealed) log(`Encrypted ${sealed} stored key value(s) and gamekey(s) on disk (readable only by Humbler under your Windows account).`);
  } catch (err) {
    log(`Couldn't encrypt stored keys: ${errMsg(err)}`);
  }
}

// The launcher just turned on cookie encryption (scripts/fuses.mjs): cookies
// already on disk stay plain until rewritten, so re-save each one now, with
// all its attributes, which stores it encrypted.
async function resealCookies() {
  if (process.env.HUMBLER_RESEAL_COOKIES !== "1") return;
  delete process.env.HUMBLER_RESEAL_COOKIES;
  const s = session.fromPartition(PARTITION);
  let n = 0;
  let failed = 0;
  for (const c of await s.cookies.get({})) {
    if (c.session) continue; // never written to disk
    const host = (c.domain || "").replace(/^\./, "");
    try {
      await s.cookies.set({
        url: `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        ...(c.sameSite && c.sameSite !== "unspecified" ? { sameSite: c.sameSite } : {}),
      });
      n += 1;
    } catch {
      failed += 1;
    }
  }
  await s.cookies.flushStore();
  log(`Cookie encryption is on: re-saved ${n} stored cookie(s) encrypted${failed ? ` (${failed} couldn't be; they're encrypted when Humble next updates them)` : ""}.`);
}

void app.whenReady().then(async () => {
  setUpKeySealing();
  await resealCookies().catch((err) => log(`Couldn't re-save cookies encrypted: ${errMsg(err)}`));
  seedOrdersFromRecon();
  rebuildIndex();
  createWindow();
  log(`Loaded ${index.bundles.length} cached orders, ${index.keys.length} keys, ${index.files.length} files.`);
  const unopenable = secrets.takeUnopenable();
  if (unopenable)
    log(`${unopenable} stored key(s) couldn't be decrypted (saved under another Windows account or PC). ☰ → Full refresh fetches them again from Humble.`);
  void rescanFolders("startup"); // what's already on disk
  startUpdateChecks();
  void wishlists.refresh(null, { staleOnly: true }); // wishlists not fetched in the last 12 hours
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
    .finally(() => (devRestartNow ? app.exit(DEV_RESTART_CODE) : app.quit()));
});
app.on("window-all-closed", () => app.quit());

// ---- dev mode: restart for new main-process code, but only when idle ------
// scripts/dev.mjs asks (over the IPC channel) after a rebuild. Quitting
// normally (above) flushes your login; exit code DEV_RESTART_CODE tells the
// runner to start the app again. A Sync, reveal or download batch in
// progress is allowed to finish first.
const DEV_RESTART_CODE = 75; // must match scripts/dev.mjs
let devRestartNow = false;
let devRestartTimer: ReturnType<typeof setInterval> | undefined;
const appIdle = () => !busy && downloader.summary().active === 0 && downloader.summary().queued === 0;
function devRestartWhenIdle() {
  if (devRestartNow) return;
  if (appIdle()) {
    clearInterval(devRestartTimer);
    devRestartNow = true;
    log("Main-process code updated; restarting.");
    app.quit();
    return;
  }
  if (!devRestartTimer) {
    log(`Main-process code updated; restarting once the current ${busy || "downloads"} finish${busy ? "es" : ""}.`);
    devRestartTimer = setInterval(devRestartWhenIdle, 1000);
  }
}
if (process.send) process.on("message", (m: { type?: string } | null) => m?.type === "humbler:dev-restart" && devRestartWhenIdle());

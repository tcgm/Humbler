require("dotenv/config");
const { app, BaseWindow, WebContentsView, ipcMain, session, dialog, shell, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { USERDATA_DIR, LOG_PATH, RECON_DIR } = require("./lib/paths");
const { INJECT_SOURCE } = require("./lib/inject-capture");
const harvest = require("./lib/harvest");
const { ownedMarkerSource } = require("./lib/owned-marker");
const { makeScrubber, alias: gamekeyAlias } = require("./lib/scrub");
const settingsStore = require("./lib/settings");
const lib = require("./lib/library");
const { HumbleApi, NotLoggedInError, BASE, BULK_CHUNK } = require("./lib/humble-api");
const { Downloader } = require("./lib/downloader");
const { politeDelay } = require("./lib/throttle");

const env = (name, fallback) => Number(process.env[name] ?? fallback);
const API_DELAY = [env("API_DELAY_MIN_MS", 700), env("API_DELAY_MAX_MS", 1800)];
const REVEAL_DELAY = [env("REVEAL_DELAY_MIN_MS", 1200), env("REVEAL_DELAY_MAX_MS", 2500)];
const CHOICE_SCAN_DELAY = [env("CHOICE_SCAN_DELAY_MIN_MS", 3000), env("CHOICE_SCAN_DELAY_MAX_MS", 6000)];
const URL_MAX_AGE_MS = env("URL_MAX_AGE_MINUTES", 20) * 60_000;

const PARTITION = "persist:humble";
const SIDEBAR_WIDTH = 680;

// Keep the Humble login local to this project, not in the system-wide
// Electron userData location.
app.setPath("userData", USERDATA_DIR);

let win; // BaseWindow hosting two views side by side
let uiView; // the Humbler app UI (renderer/)
let humbleView; // real humblebundle.com, for logging in and anything Humbler can't do
let browserVisible = true;
let settings = settingsStore.load();
let index = { bundles: [], keys: [], files: [], products: [] };
let busy = null; // "sync" | "reveal" | "choice-scan" while one of those is running

const humbleSession = () => session.fromPartition(PARTITION);
const api = new HumbleApi(humbleSession);

// ---- logging / UI messaging -------------------------------------------

function send(channel, payload) {
  if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send(channel, payload);
}

const logHistory = []; // so the UI can show lines logged before it loaded

function log(message) {
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

function rebuildIndex() {
  index = lib.buildIndex(lib.loadAllOrders(), { downloadDir: settings.downloadDir, naming: settings.naming });
  ownedTitles = null;
  send("library-updated");
}

let ownedTitles = null; // normalized titles of everything you own (lazy)
function getOwnedTitles() {
  if (!ownedTitles) {
    const set = new Set();
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
let apiLoginState = null; // true | false | null (unknown)
const SESSION_COOKIE = /^(_simpleauth_sess|ory_session_.*|ory_kratos_session)$/;

async function isLoggedIn() {
  if (apiLoginState !== null) return apiLoginState;
  const cookies = await humbleSession().cookies.get({ domain: "humblebundle.com" });
  return cookies.some((c) => SESSION_COOKIE.test(c.name));
}

function noteApiLogin(ok) {
  apiLoginState = ok;
  pushStatus();
}

async function pushStatus() {
  send("status", {
    loggedIn: await isLoggedIn(),
    browserVisible,
    downloadDir: settings.downloadDir,
    naming: settings.naming,
    markOwned: settings.markOwned,
    busy,
    queue: downloader.summary(),
  });
}

// ---- sync -------------------------------------------------------------

async function syncLibrary({ full }) {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  busy = "sync";
  pushStatus();
  try {
    log(full ? "Full refresh: re-fetching every order…" : "Syncing library…");
    const gamekeys = await api.listGamekeys();
    noteApiLogin(true);
    const cached = lib.cachedGamekeys();
    const toFetch = full ? gamekeys : gamekeys.filter((k) => !cached.has(k));
    log(`${gamekeys.length} orders on your account, ${toFetch.length} to fetch.`);

    let fetched = 0;
    let failed = 0;
    for (let i = 0; i < toFetch.length; i += BULK_CHUNK) {
      const chunk = toFetch.slice(i, i + BULK_CHUNK);
      let orders = null;
      try {
        orders = await api.fetchOrdersBulk(chunk);
      } catch (err) {
        if (err instanceof NotLoggedInError) throw err;
        log(`  bulk fetch failed (${err.message}); falling back to one-by-one`);
      }
      if (orders) {
        orders.forEach((o) => lib.saveOrder(o));
        fetched += orders.length;
        failed += chunk.length - orders.length;
      } else {
        for (const key of chunk) {
          try {
            lib.saveOrder(await api.fetchOrder(key));
            fetched += 1;
          } catch (err) {
            if (err instanceof NotLoggedInError) throw err;
            failed += 1;
            log(`  order ${gamekeyAlias(key)} failed: ${err.message}`);
          }
          await politeDelay(...API_DELAY);
        }
      }
      log(`  ${Math.min(i + BULK_CHUNK, toFetch.length)}/${toFetch.length} orders processed`);
      if (i + BULK_CHUNK < toFetch.length) await politeDelay(...API_DELAY);
    }

    rebuildIndex();
    log(
      `Sync done: ${fetched} fetched${failed ? `, ${failed} failed` : ""}. ` +
        `Library: ${index.bundles.length} orders, ${index.keys.length} keys, ${index.files.length} files.`,
    );
    return { ok: true, fetched, failed };
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      noteApiLogin(false);
      log("Not logged in — log in on the right, then sync again.");
      setBrowserVisible(true);
      humbleView.webContents.loadURL(`${BASE}/login?goto=%2Fhome%2Flibrary`);
      return { ok: false, reason: "not-logged-in" };
    }
    log(`Sync failed: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    busy = null;
    pushStatus();
  }
}

// ---- key reveal -------------------------------------------------------

async function ensureHumblePageLoaded() {
  const wc = humbleView.webContents;
  if (wc.getURL().startsWith(BASE) && !wc.isLoading()) return;
  await new Promise((resolve) => {
    wc.once("did-finish-load", resolve);
    wc.loadURL(`${BASE}/home/keys`);
  });
}

// Runs the exact request Humble's own keys page makes, from inside the real
// page, so it carries the same origin, cookies and CSRF token.
async function revealOne(key) {
  const csrf = (await humbleSession().cookies.get({ url: BASE, name: "csrf_cookie" }))[0]?.value || "";
  const payload = JSON.stringify({
    keytype: key.machineName,
    key: key.gamekey,
    keyindex: String(key.keyindex),
    csrf,
  });
  const result = await humbleView.webContents.executeJavaScript(`
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
  let json;
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

async function revealKeys(ids) {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  busy = "reveal";
  pushStatus();
  const results = [];
  try {
    await ensureHumblePageLoaded();
    const wanted = new Set(ids);
    const targets = index.keys.filter((k) => wanted.has(k.id) && k.status === "unused");
    log(`Revealing ${targets.length} key(s)…`);
    for (const [n, key] of targets.entries()) {
      try {
        const value = await revealOne(key);
        // Write it down before anything else can go wrong.
        lib.recordRevealedKey({
          id: key.id,
          gamekey: key.gamekey,
          name: key.name,
          bundle: key.bundle,
          keyType: key.keyType,
          key: value,
          revealedAt: new Date().toISOString(),
        });
        const order = lib.loadOrder(key.gamekey);
        const tpk = order?.tpkd_dict?.all_tpks?.find((t) => lib.keyId(key.gamekey, t) === key.id);
        if (tpk) {
          tpk.redeemed_key_val = value;
          lib.saveOrder(order);
        }
        key.key = value;
        results.push({ id: key.id, ok: true });
        log(`  ${key.name}: revealed`);
      } catch (err) {
        results.push({ id: key.id, ok: false, error: err.message });
        log(`  ${key.name}: FAILED — ${err.message}`);
      }
      send("key-updated", { id: key.id, key: key.key });
      if (n < targets.length - 1) await politeDelay(...REVEAL_DELAY);
    }
    rebuildIndex();
    return { ok: true, results };
  } catch (err) {
    log(`Reveal failed: ${err.message}`);
    return { ok: false, reason: err.message, results };
  } finally {
    busy = null;
    pushStatus();
  }
}

// ---- downloads --------------------------------------------------------

const orderRefreshes = new Map(); // gamekey -> in-flight promise
const refreshedAt = new Map(); // gamekey -> ms

function refreshOrder(gamekey) {
  if (!orderRefreshes.has(gamekey)) {
    const p = api
      .fetchOrder(gamekey)
      .then((order) => {
        lib.saveOrder(order);
        refreshedAt.set(gamekey, Date.now());
        return order;
      })
      .finally(() => orderRefreshes.delete(gamekey));
    orderRefreshes.set(gamekey, p);
  }
  return orderRefreshes.get(gamekey);
}

async function resolveUrl(item, { force }) {
  const age = Math.min(lib.orderAgeMs(item.gamekey), Date.now() - (refreshedAt.get(item.gamekey) || 0));
  if (!force && item.url && age < URL_MAX_AGE_MS) return item.url;
  const order = await refreshOrder(item.gamekey);
  const fresh = lib
    .buildIndex([order], { downloadDir: settings.downloadDir, naming: settings.naming })
    .files.find((f) => f.id === item.id);
  if (!fresh?.url) throw new Error("file no longer offered by Humble (no download URL after refresh)");
  item.url = fresh.url;
  return fresh.url;
}

const downloader = new Downloader({
  getSession: humbleSession,
  resolveUrl,
  concurrency: env("DOWNLOAD_CONCURRENCY", 2),
  delayMin: env("DOWNLOAD_DELAY_MIN_MS", 500),
  delayMax: env("DOWNLOAD_DELAY_MAX_MS", 1500),
});

downloader.on("progress", (p) => send("download-progress", p));
downloader.on("completed", (item, { skipped }) => {
  lib.recordDownloaded({ id: item.id, rel: item.rel, size: item.size, md5: item.md5, at: new Date().toISOString() });
  const f = index.files.find((x) => x.id === item.id);
  if (f) f.downloaded = true;
  log(`  ${skipped ? "already had" : "downloaded"}: ${item.label}`);
  pushStatus();
});
downloader.on("failed", (item, err) => {
  log(`  download FAILED: ${item.label} — ${err.message}`);
  pushStatus();
});
downloader.on("idle", () => {
  log("Download queue finished.");
  pushStatus();
});

function enqueueDownloads(ids) {
  const wanted = new Set(ids);
  const items = index.files
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
    }));
  const added = downloader.enqueue(items);
  log(`Queued ${added} file(s) → ${settings.downloadDir}`);
  pushStatus();
  return { ok: true, added };
}

// ---- exports ----------------------------------------------------------

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportKeys(ids) {
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
  const fields = ["name", "keyType", "status", "key", "bundle", "created", "expiry", "daysLeft", "instructions", "steamAppId", "gamekey"];
  const out = filePath.toLowerCase().endsWith(".json")
    ? JSON.stringify(rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))), null, 2)
    : [fields.join(","), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(","))].join("\r\n");
  fs.writeFileSync(filePath, out);
  log(`Exported ${rows.length} key(s) to ${filePath}`);
  return { ok: true, count: rows.length, filePath };
}

// ---- scouting (recon) -------------------------------------------------
// Same idea as pinterinter. The injected script (lib/inject-capture.js)
// records every JSON response the Humble page receives. A CDP Network log
// keeps metadata for *every* request, JSON or not. "Scout this page" dumps
// both, plus any JSON Humble embedded in the page's HTML, to
// data/recon/<timestamp>-<page>/ so you can see what the site really calls.

const NETWORK_LOG_MAX = 3000;
let networkLog = [];

function attachScout(wc) {
  const dbg = wc.debugger;
  try {
    dbg.attach("1.3");
  } catch (err) {
    log(`Scouting unavailable (debugger attach failed: ${err.message})`);
    return;
  }
  dbg.sendCommand("Network.enable").catch(() => {});
  dbg.sendCommand("Page.enable").catch(() => {});
  dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SOURCE }).catch((err) =>
    log(`Scouting: script injection failed (${err.message})`),
  );
  dbg.on("message", (_event, method, params) => {
    if (method === "Network.requestWillBeSent") {
      networkLog.push({
        id: params.requestId,
        at: new Date().toISOString(),
        type: params.type,
        method: params.request.method,
        url: params.request.url,
      });
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

function slugifyUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "home";
  } catch {
    return "page";
  }
}

// Collapse ids in paths, so /api/v1/order/AbC123xyz groups with the others.
function endpointOf(url) {
  try {
    const u = new URL(url);
    const p = u.pathname
      .split("/")
      .map((seg) => (/^[A-Za-z0-9_-]{12,}$/.test(seg) && /\d/.test(seg) ? ":id" : seg))
      .join("/");
    return `${u.host}${p}`;
  } catch {
    return url;
  }
}

async function scoutPage({ reload }) {
  if (!humbleView) return { ok: false, reason: "no-window" };
  const wc = humbleView.webContents;
  if (reload) {
    log("Scouting: reloading so the page's data requests fire while we listen…");
    await new Promise((resolve) => {
      wc.once("did-finish-load", resolve);
      wc.reload();
    });
    await politeDelay(2500, 3500); // let late XHRs land
  }

  // Everything below is scrubbed before it touches disk: no key values, no
  // raw gamekeys, no signed-URL tokens (see lib/scrub.js).
  const scrub = makeScrubber();
  const url = scrub.scrubText(wc.getURL());
  const raw = await collectPageData(wc);
  const captured = scrub.scrubValue(raw.captured);
  const embedded = scrub.scrubValue(raw.embedded);
  const html = await wc.executeJavaScript("document.documentElement.outerHTML").catch(() => "");

  const dir = path.join(RECON_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugifyUrl(url)}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    captured.forEach((entry, i) => scrub.writeScrubbed(path.join(dir, `${String(i + 1).padStart(4, "0")}.json`), entry));
    scrub.writeScrubbed(path.join(dir, "_network.json"), networkLog);
    if (embedded.length) scrub.writeScrubbed(path.join(dir, "_embedded.json"), embedded);
    if (html) scrub.writeScrubbed(path.join(dir, "_page.html"), html);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`Scout aborted and its dump deleted: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  // Summary of what the page talks to, so the interesting endpoints jump out.
  const counts = new Map();
  for (const c of captured) {
    const k = `${c.method} ${endpointOf(c.url)} → ${c.status}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const s = scrub.stats;
  log(
    `  Scrubbed: ${s.keys} known key(s), ${s.fields} secret field(s), ${s.patterns} key-shaped string(s), ` +
      `${s.gamekeys} gamekey(s) aliased, ${s.tokens} URL token(s)`,
  );
  scrub.writeScrubbed(
    path.join(dir, "_summary.txt"),
    `Scouted: ${url}\n\nJSON responses by endpoint:\n` +
      summary.map(([k, n]) => `  ${String(n).padStart(4)}×  ${k}`).join("\n") +
      `\n\nEmbedded JSON blocks: ${embedded.map((e) => e.id || e.type).join(", ") || "none"}\n`,
  );

  log(`Scouted ${url}`);
  log(`  ${captured.length} JSON response(s), ${networkLog.length} request(s) total, ${embedded.length} embedded JSON block(s)`);
  for (const [k, n] of summary.slice(0, 15)) log(`    ${n}× ${k}`);
  if (summary.length > 15) log(`    …and ${summary.length - 15} more in _summary.txt`);
  log(`  Saved to ${dir}`);
  return { ok: true, dir, responses: captured.length };
}

// Everything JSON-shaped the current Humble page knows: responses captured by
// the injected script, and JSON embedded in <script> tags. That includes
// Next.js's __NEXT_DATA__ and other non-JSON-typed scripts that parse as JSON.
async function collectPageData(wc) {
  const grab = (expr, fallback) => wc.executeJavaScript(expr).catch(() => fallback);
  const captured = await grab("window.__humbler ? window.__humbler.captured : []", []);
  const embedded = await grab(
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
  return { captured, embedded };
}

// ---- harvesting (Choice) + owned marking ------------------------------

const isMembershipPage = (url) => /^https:\/\/www\.humblebundle\.com\/membership(\/|$)/.test(url);
const isMarkablePage = (url) =>
  /^https:\/\/www\.humblebundle\.com\//.test(url) && !/^https:\/\/www\.humblebundle\.com\/(home|downloads|login)/.test(url);

async function harvestChoicePage(wc) {
  const url = wc.getURL();
  const { captured, embedded } = await collectPageData(wc);
  const dom = await wc.executeJavaScript(harvest.DOM_CHOICE_SCRIPT).catch(() => []);
  const roots = [...captured.map((c) => c.body), ...embedded.map((e) => e.json).filter(Boolean)];
  const found = [...harvest.extractChoiceFromJson(roots, url), ...harvest.extractChoiceFromDom(dom, url)];
  try {
    harvest.saveRawHarvest("choice", url, { captured, embedded, dom, extracted: found }, makeScrubber());
  } catch (err) {
    log(`Choice: raw harvest not saved (${err.message})`);
  }

  // Months with an order on your account are ones you were subscribed for.
  const orderMonths = new Map();
  for (const b of index.bundles) {
    if (!/choice|monthly/i.test(`${b.machineName} ${b.name}`)) continue;
    const m = harvest.monthFromText(b.machineName) || harvest.monthFromText(b.name);
    if (m) orderMonths.set(m, b.gamekey);
  }
  for (const f of found) f.gamekey ||= orderMonths.get(f.month) || null;

  if (!found.length) {
    log(`Choice: nothing recognisable on ${url} (raw harvest saved under data/harvest/choice — scout it and send me the summary).`);
    return 0;
  }
  const store = harvest.mergeChoice(harvest.loadChoice(), found);
  harvest.saveChoice(store);
  for (const f of found) {
    const games = Object.values(f.games);
    log(`Choice ${f.month}: ${games.length} games, ${games.filter((g) => g.claimed).length} claimed (from ${f.source})`);
  }
  send("choice-updated");
  return found.length;
}

async function markOwnedOnPage(wc) {
  if (!settings.markOwned || !index.products.length) return;
  const n = await wc.executeJavaScript(ownedMarkerSource(getOwnedTitles())).catch(() => 0);
  if (n) log(`Marked ${n} owned item(s) on this page.`);
}

let choiceScanStop = false;

async function scanChoice({ all }) {
  if (busy) return { ok: false, reason: `busy (${busy})` };
  busy = "choice-scan";
  choiceScanStop = false;
  pushStatus();
  try {
    const store = harvest.loadChoice();
    const months = harvest.allChoiceMonths().filter((m) => all || !store.months[m]);
    log(`Choice scan: visiting ${months.length} month page(s), politely…`);
    setBrowserVisible(true);
    const wc = humbleView.webContents;
    let done = 0;
    for (const m of months) {
      if (choiceScanStop) {
        log("Choice scan stopped.");
        break;
      }
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(t);
          wc.removeListener("did-finish-load", finish);
          resolve();
        };
        const t = setTimeout(finish, 30000);
        wc.once("did-finish-load", finish);
        wc.loadURL(harvest.choiceMonthUrl(m)).catch(finish);
      });
      if (/auth\.humblebundle\.com/.test(wc.getURL())) {
        log("Choice scan: Humble wants you to log in — stopping.");
        noteApiLogin(false);
        break;
      }
      await politeDelay(2500, 3500); // let the page's own data requests land
      await harvestChoicePage(wc);
      done += 1;
      send("choice-scan-progress", { done, total: months.length, month: m });
      await politeDelay(...CHOICE_SCAN_DELAY);
    }
    log(`Choice scan finished: ${done}/${months.length} month(s) visited.`);
    return { ok: true, done };
  } finally {
    busy = null;
    pushStatus();
  }
}

function choiceView() {
  const store = harvest.loadChoice();
  return harvest.allChoiceMonths().map((m) => ({
    month: m,
    url: harvest.choiceMonthUrl(m),
    seen: !!store.months[m],
    ...(store.months[m] || {}),
  }));
}

// ---- window -----------------------------------------------------------

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const uiWidth = browserVisible ? Math.min(SIDEBAR_WIDTH, width) : width;
  uiView.setBounds({ x: 0, y: 0, width: uiWidth, height });
  humbleView.setBounds({ x: uiWidth, y: 0, width: Math.max(0, width - uiWidth), height });
  humbleView.setVisible(browserVisible);
}

function setBrowserVisible(visible) {
  browserVisible = visible;
  layout();
  pushStatus();
}

function createWindow() {
  // Drop "Electron/x.y" from the UA so Humble (and Cloudflare in front of
  // it) sees what a regular Chrome would.
  const ses = humbleSession();
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|humbler)\/\S+/gi, ""));

  win = new BaseWindow({ width: 1600, height: 960, title: "Humbler", backgroundColor: "#16171b" });
  win.setMenuBarVisibility(false);

  uiView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  humbleView = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true } });
  win.contentView.addChildView(uiView);
  win.contentView.addChildView(humbleView);
  layout();

  uiView.webContents.loadFile(path.join(__dirname, "renderer", "index.html"));
  attachScout(humbleView.webContents); // before the first load, so it's injected from the start
  humbleView.webContents.loadURL(`${BASE}/home/library`);

  // Pop-up links from Humble's site stay in the pane (or go to your real browser).
  humbleView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)*humblebundle\.com\//.test(url)) humbleView.webContents.loadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  uiView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Surface UI script errors in the Humbler log instead of losing them.
  uiView.webContents.on("console-message", (e, legacyLevel, legacyMessage) => {
    const level = e.level ?? legacyLevel;
    if (level === "error" || level === 3) log(`[ui error] ${e.message ?? legacyMessage}`);
  });

  const onNav = (_e, url) => {
    // Passing through the auth pages means login state is about to change.
    if (/^https:\/\/auth\.humblebundle\.com\//.test(url) || /\/logout/.test(url)) apiLoginState = null;
    pushStatus();
  };
  humbleView.webContents.on("did-navigate", onNav);
  humbleView.webContents.on("did-navigate-in-page", onNav);

  // Auto-harvest Choice pages as you browse them (the scan harvests its own
  // pages), and highlight owned items on store/bundle/Choice pages.
  const afterLoad = async () => {
    const wc = humbleView?.webContents;
    if (!wc) return;
    const url = wc.getURL();
    await politeDelay(2000, 2500);
    if (!humbleView || wc.getURL() !== url) return; // navigated away meanwhile
    if (isMembershipPage(url) && busy !== "choice-scan") {
      await harvestChoicePage(wc).catch((err) => log(`Choice harvest failed: ${err.message}`));
    }
    if (isMarkablePage(url)) await markOwnedOnPage(wc);
  };
  humbleView.webContents.on("did-finish-load", afterLoad);
  humbleView.webContents.on("did-navigate-in-page", afterLoad);

  win.on("resize", layout);
  win.on("closed", () => {
    downloader.cancelAll();
    win = uiView = humbleView = null;
  });
}

// ---- IPC --------------------------------------------------------------

const idList = (ids) => (Array.isArray(ids) ? ids.map(String) : []);

ipcMain.handle("library:get", () => index);
ipcMain.handle("log:history", () => logHistory);
ipcMain.handle("choice:get", () => choiceView());
ipcMain.handle("choice:scan", (_e, opts) => scanChoice({ all: !!opts?.all }));
ipcMain.handle("choice:stop", () => {
  choiceScanStop = true;
});
ipcMain.handle("browser:open", (_e, url) => {
  // Only Humble pages open in the pane; everything else goes to your real browser.
  if (typeof url !== "string") return;
  if (/^https:\/\/([a-z0-9-]+\.)*humblebundle\.com\//.test(url)) {
    setBrowserVisible(true);
    humbleView.webContents.loadURL(url);
  } else if (/^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});
ipcMain.handle("settings:set", (_e, patch) => {
  const next = { ...settings };
  if (patch && settingsStore.NAMING.includes(patch.naming)) next.naming = patch.naming;
  if (patch && typeof patch.markOwned === "boolean") next.markOwned = patch.markOwned;
  const namingChanged = next.naming !== settings.naming;
  settings = next;
  settingsStore.save(settings);
  if (namingChanged) {
    log(`File naming: ${settings.naming === "title" ? "<Product> - <Publisher>.<ext>" : "Humble's original file names"}`);
    rebuildIndex();
  }
  pushStatus();
});
ipcMain.handle("scout:page",(_e, opts) => scoutPage({ reload: !!opts?.reload }));
ipcMain.handle("scout:open-folder", () => {
  fs.mkdirSync(RECON_DIR, { recursive: true });
  return shell.openPath(RECON_DIR);
});
ipcMain.handle("status:get", () => pushStatus());
ipcMain.handle("library:sync", (_e, opts) => syncLibrary({ full: !!opts?.full }));
ipcMain.handle("keys:reveal", (_e, ids) => revealKeys(idList(ids)));
ipcMain.handle("keys:export", (_e, ids) => exportKeys(Array.isArray(ids) ? idList(ids) : null));
ipcMain.handle("downloads:enqueue", (_e, ids) => enqueueDownloads(idList(ids)));
ipcMain.handle("downloads:cancel", () => {
  downloader.cancelAll();
  log("Cancelled download queue (partial files are kept and will resume).");
  pushStatus();
});
ipcMain.handle("downloads:open-folder", () => {
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  return shell.openPath(settings.downloadDir);
});
ipcMain.handle("downloads:reveal-file", (_e, id) => {
  const f = index.files.find((x) => x.id === id);
  if (f) shell.showItemInFolder(path.join(settings.downloadDir, f.rel));
});
ipcMain.handle("settings:choose-download-dir", async () => {
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
  pushStatus();
});
ipcMain.handle("browser:toggle", () => setBrowserVisible(!browserVisible));
ipcMain.handle("browser:go", (_e, where) => {
  const routes = {
    library: "/home/library",
    keys: "/home/keys",
    purchases: "/home/purchases",
    login: "/login",
    choice: "/membership/home",
  };
  setBrowserVisible(true);
  humbleView.webContents.loadURL(BASE + (routes[where] || "/home/library"));
});
ipcMain.handle("clipboard:write", (_e, text) => clipboard.writeText(String(text ?? "")));

app.whenReady().then(() => {
  rebuildIndex();
  createWindow();
  log(`Loaded ${index.bundles.length} cached orders, ${index.keys.length} keys, ${index.files.length} files.`);
});

app.on("window-all-closed", () => app.quit());

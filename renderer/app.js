/* global humbler */
"use strict";

const $ = (id) => document.getElementById(id);
const ROW_LIMIT = 1500;

const state = {
  lib: { bundles: [], keys: [], files: [] },
  selKeys: new Set(),
  selFiles: new Set(),
  progress: new Map(), // file id -> { state, received, total, error }
  shownKeys: [],
  shownFiles: [],
  busy: null,
};

// ---- helpers ------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function fmtBytes(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fillSelect(select, allLabel, values, labelOf = (v) => v) {
  const prev = select.value;
  select.replaceChildren(el("option", { value: "", textContent: allLabel }));
  for (const v of values) select.append(el("option", { value: v, textContent: labelOf(v) }));
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}

const uniqSorted = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Same normalisation as lib/library.js normTitle, for matching titles across sources.
const normTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();

const steamUrl = (title, appId) =>
  appId ? `https://store.steampowered.com/app/${appId}` : `https://store.steampowered.com/search/?term=${encodeURIComponent(title)}`;

// A small link that opens Humble URLs in the pane and anything else in your browser.
function extLink(text, url, title) {
  const a = el("a", { class: "ext", textContent: text, title: title || url });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    humbler.openUrl(url);
  });
  return a;
}

// Destructive buttons need two clicks: the first arms, the second fires.
function armable(button, armedText, fire) {
  let timer = null;
  const original = () => button.dataset.label || button.textContent;
  button.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!button.classList.contains("armed")) {
      button.dataset.label = original();
      button.classList.add("armed");
      button.textContent = typeof armedText === "function" ? armedText() : armedText;
      timer = setTimeout(() => disarm(), 4000);
      return;
    }
    disarm();
    await fire();
  });
  function disarm() {
    clearTimeout(timer);
    button.classList.remove("armed");
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
}

// ---- tabs ---------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    for (const name of ["keys", "bundles", "choice", "files", "library", "log"]) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
  }),
);
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => humbler.go(b.dataset.go)));

// ---- status -------------------------------------------------------------

humbler.onStatus((s) => {
  const pill = $("loginStatus");
  pill.textContent = s.loggedIn ? "logged in" : "not logged in";
  pill.className = `pill ${s.loggedIn ? "ok" : "bad"}`;
  state.busy = s.busy;
  const q = s.queue || { queued: 0, active: 0 };
  const parts = [];
  if (s.busy === "sync") parts.push("syncing…");
  if (s.busy === "reveal") parts.push("revealing keys…");
  $("naming").value = s.naming;
  $("markOwned").checked = !!s.markOwned;
  $("liveScout").checked = !!s.liveScout;
  applyTheme(s.theme);
  $("liveSummary").textContent = s.live ? `${s.live.endpoints} endpoints · ${s.live.samples} response shapes` : "";
  if (q.active || q.queued) parts.push(`downloading ${q.active} · ${q.queued} queued`);
  $("busy").hidden = !parts.length;
  $("busy").textContent = parts.join(" · ");
  $("syncBtn").disabled = $("fullBtn").disabled = !!s.busy;
  $("browserBtn").textContent = s.browserVisible ? "Hide browser" : "Show browser";
  $("dlDir").textContent = s.downloadDir;
  $("dlDir").title = s.downloadDir;
  updateKeyButtons();
});

$("syncBtn").addEventListener("click", () => humbler.sync(false));
$("fullBtn").addEventListener("click", () => humbler.sync(true));
$("browserBtn").addEventListener("click", () => humbler.toggleBrowser());

// ---- log ----------------------------------------------------------------

function appendLog(line) {
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(el("div", { textContent: line }));
  while (log.childNodes.length > 3000) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// Subscribe first, then backfill, so nothing falls in the gap.
const earlyLines = [];
let backfilled = false;
humbler.onLog((line) => (backfilled ? appendLog(line) : earlyLines.push(line)));
humbler.getLogHistory().then((history) => {
  const seen = new Set(history);
  history.forEach(appendLog);
  earlyLines.filter((l) => !seen.has(l)).forEach(appendLog);
  backfilled = true;
});

// ---- library ------------------------------------------------------------

async function loadLibrary() {
  state.lib = await humbler.getLibrary();
  const { bundles, keys, files } = state.lib;
  const bundleLabel = new Map(bundles.map((b) => [b.gamekey, `${b.name}${b.created ? ` (${b.created.slice(0, 10)})` : ""}`]));

  const keyBundles = bundles.filter((b) => b.keyCount).map((b) => b.gamekey);
  const fileBundles = bundles.filter((b) => b.fileCount).map((b) => b.gamekey);
  fillSelect($("keyBundle"), `All bundles (${keyBundles.length})`, keyBundles, (g) => bundleLabel.get(g));
  fillSelect($("fileBundle"), `All bundles (${fileBundles.length})`, fileBundles, (g) => bundleLabel.get(g));
  fillSelect($("keyType"), "All key types", uniqSorted(keys.map((k) => k.keyType)));
  fillSelect($("filePlatform"), "All platforms", uniqSorted(files.map((f) => f.platform)));
  fillSelect($("fileFormat"), "All formats", uniqSorted(files.map((f) => f.format)));

  fillSelect($("libBundle"), `All bundles (${bundles.length})`, bundles.map((b) => b.gamekey), (g) => bundleLabel.get(g));
  state.owned = new Set([...keys.map((k) => normTitle(k.name)), ...(state.lib.products || []).map((p) => normTitle(p.title))]);
  $("libCount").textContent = state.lib.products?.length ? String(state.lib.products.length) : "";

  const unrevealed = keys.filter((k) => k.status === "unused").length;
  $("keysCount").textContent = keys.length ? `${unrevealed} unrevealed / ${keys.length}` : "";
  const pending = files.filter((f) => f.downloadable && !f.downloaded && !f.duplicateOf).length;
  $("filesCount").textContent = files.length ? `${pending} to get / ${files.length}` : "";

  // Drop selections that no longer exist.
  const keyIds = new Set(keys.map((k) => k.id));
  for (const id of state.selKeys) if (!keyIds.has(id)) state.selKeys.delete(id);
  const fileIds = new Set(files.map((f) => f.id));
  for (const id of state.selFiles) if (!fileIds.has(id)) state.selFiles.delete(id);

  renderKeys();
  renderFiles();
  renderLibrary();
  if (typeof renderHbPages === "function") renderHbPages(); // Bundles + Choice pages (pages.js)
}

humbler.onLibraryUpdated(loadLibrary);

// ---- keys ---------------------------------------------------------------

const EXPIRING_DAYS = 30;
const isExpiring = (k) => k.status === "unused" && k.daysLeft != null && k.daysLeft <= EXPIRING_DAYS;

// ignoreState: everything matching bundle/type/search, whatever its status
// (used by the summary to explain what the status filter is hiding).
function filteredKeys({ ignoreState = false } = {}) {
  const q = $("keySearch").value.trim().toLowerCase();
  const bundle = $("keyBundle").value;
  const st = ignoreState ? "all" : $("keyState").value;
  const type = $("keyType").value;
  return state.lib.keys.filter((k) => {
    if (bundle && k.gamekey !== bundle) return false;
    if (type && k.keyType !== type) return false;
    if (st === "unused" && k.status !== "unused") return false;
    if (st === "revealed" && k.status !== "revealed") return false;
    if (st === "notredeemed" && !(k.status === "revealed" && !k.platformRedeemed)) return false;
    if (st === "platformredeemed" && !k.platformRedeemed) return false;
    if (st === "gifted" && !(k.status === "gifted" || k.status === "link")) return false;
    if (st === "expiring" && !isExpiring(k)) return false;
    if (st === "expired" && !(k.status === "expired" || k.status === "sold-out")) return false;
    if (q && !`${k.name} ${k.bundle} ${k.key || ""} ${k.keyType}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function copyButton(text, label = "Copy") {
  const b = el("button", { class: "hb-btn ghost small", textContent: label });
  b.addEventListener("click", () => {
    humbler.copy(text);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

// ---- platform presentation (old-HB-style rows) ---------------------------

// Normalise Humble's key types to a platform: name for "Reveal your X key",
// a badge, and the store's redeem link where one exists.
function platformOf(k) {
  const t = `${k.keyType || ""}`.toLowerCase();
  if (/steam/.test(t)) return { id: "steam", name: "Steam", badge: "Steam", redeem: (key) => `https://store.steampowered.com/account/registerkey?key=${encodeURIComponent(key)}` };
  if (/epic/.test(t)) return { id: "epic", name: "Epic Games Store", badge: "Epic", redeem: () => "https://store.epicgames.com/redeem" };
  if (/gog/.test(t)) return { id: "gog", name: "GOG.com", badge: "GOG", redeem: (key) => `https://www.gog.com/redeem/${encodeURIComponent(key)}` };
  if (/origin|^ea\b|ea_app/.test(t)) return { id: "origin", name: "EA app", badge: "EA" };
  if (/uplay|ubisoft/.test(t)) return { id: "uplay", name: "Ubisoft Connect", badge: "Ubi" };
  if (/blizzard|battle/.test(t)) return { id: "blizzard", name: "Battle.net", badge: "B.net" };
  if (/external/.test(t)) return { id: "external", name: "", badge: "Key" };
  return { id: "other", name: "", badge: "Key" };
}

function formatDate(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : iso;
}

// The keyfield: the big grey box, plus whatever goes beside it.
function keyField(k) {
  const p = platformOf(k);
  const row = el("div", { class: "keyrow" });
  switch (k.status) {
    case "revealed": {
      row.append(el("div", { class: "keyfield redeemed", title: "Click the key to select it" }, el("span", { class: "keyfield-value", textContent: k.key || "" })));
      if (p.redeem && k.key) {
        const redeem = el("button", {
          class: `hb-btn small${k.platformRedeemed ? " ghost" : ""}`,
          textContent: k.platformRedeemed ? "Redeem again" : "Redeem",
          title: `Redeem on ${p.name}: opens in your browser${p.id === "steam" ? " with the key filled in" : ""}`,
        });
        redeem.addEventListener("click", () => beginRedeem(k, p.name, p.redeem(k.key)));
        row.append(redeem);
      }
      if (k.key) row.append(copyButton(k.key));
      break;
    }
    case "gifted":
    case "link":
      row.append(el("div", { class: "keyfield gifted", textContent: k.status === "gifted" ? "Gifted" : "Redeem link" }));
      if (k.key) row.append(copyButton(k.key, "Copy link"));
      break;
    case "expired":
      row.append(el("div", { class: "keyfield expired", textContent: "This key has expired" }));
      break;
    case "sold-out":
      row.append(el("div", { class: "keyfield expired", textContent: "Sold out" }));
      break;
    default: {
      const label = `Reveal your ${p.name ? `${p.name} ` : ""}key`;
      if (k.v2) {
        // New-site keys: reveal on Humble's own page until Humbler knows the new reveal action.
        const open = el("button", { class: "keyfield", textContent: label, title: "Opens this item on Humble (right) so you can reveal it there" });
        open.addEventListener("click", () => humbler.openUrl(k.contentUrl));
        row.append(open);
      } else {
        const reveal = el("button", { class: "keyfield", textContent: label });
        armable(reveal, "Click again to reveal. It can't be gifted afterwards", () => humbler.revealKeys([k.id]));
        reveal.disabled = !!state.busy;
        row.append(reveal);
      }
    }
  }

  const meta = el("div", { class: "keymeta" });
  // Your own redeemed-on-platform record (revealed keys only).
  if (k.status === "revealed") {
    if (k.platformRedeemed) {
      const undo = el("a", { textContent: "undo", title: "Mark as not redeemed" });
      undo.addEventListener("click", () => setRedeemed(k.id, false));
      meta.append(
        el(
          "span",
          { class: "redeemed-ok" },
          `✓ Redeemed${k.platformRedeemed.platform ? ` on ${k.platformRedeemed.platform}` : ""} · ${formatDate(k.platformRedeemed.at)} `,
          undo,
        ),
      );
    } else {
      const mark = el("a", { textContent: "Mark as redeemed", title: "Record that you've activated this key yourself" });
      mark.addEventListener("click", () => setRedeemed(k.id, true, p.name || null));
      meta.append(el("span", {}, mark));
    }
  }
  if (k.status === "unused" && k.expiry) {
    meta.append(
      el("span", {
        class: isExpiring(k) ? "soon" : "",
        textContent: `Must be redeemed by ${formatDate(k.expiry)}${k.daysLeft != null ? ` (${k.daysLeft} day${k.daysLeft === 1 ? "" : "s"} left)` : ""}`,
      }),
    );
  }
  if (k.instructions) meta.append(el("details", {}, el("summary", { textContent: "Redemption instructions" }), el("p", { textContent: k.instructions })));
  return meta.childNodes.length ? el("div", {}, row, meta) : row;
}

// ---- keys table + pager ---------------------------------------------------

const KEYS_PER_PAGE = 50;
state.keyPage = 1;

function pagerButtons(page, pages, go) {
  const box = $("keyPager");
  box.replaceChildren();
  if (pages <= 1) return;
  const btn = (label, target, opts = {}) => {
    const b = el("button", { textContent: label, disabled: !!opts.disabled, class: opts.current ? "current" : "" });
    b.addEventListener("click", () => go(target));
    return b;
  };
  box.append(btn("‹ Prev", page - 1, { disabled: page === 1 }));
  const shown = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  let last = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - last > 1) box.append(el("span", { class: "gap", textContent: "…" }));
    box.append(btn(String(n), n, { current: n === page }));
    last = n;
  }
  box.append(btn("Next ›", page + 1, { disabled: page === pages }));
}

function renderKeys() {
  const rows = filteredKeys();
  state.shownKeys = rows;
  const pages = Math.max(1, Math.ceil(rows.length / KEYS_PER_PAGE));
  state.keyPage = Math.min(Math.max(1, state.keyPage), pages);
  const pageRows = rows.slice((state.keyPage - 1) * KEYS_PER_PAGE, state.keyPage * KEYS_PER_PAGE);

  const frag = document.createDocumentFragment();
  for (const k of pageRows) {
    const p = platformOf(k);
    const chk = el("input", { type: "checkbox", checked: state.selKeys.has(k.id) });
    chk.addEventListener("change", () => {
      if (chk.checked) state.selKeys.add(k.id);
      else state.selKeys.delete(k.id);
      updateKeyButtons();
    });
    const steam = p.id === "steam" || k.steamAppId ? extLink("View on Steam", steamUrl(k.name, k.steamAppId)) : null;
    frag.append(
      el(
        "tr",
        { dataset: { id: k.id } },
        el("td", { class: "chk" }, chk),
        el("td", { class: "platform" }, el("span", { class: `plat ${p.id}`, textContent: p.badge, title: p.name || k.keyType || "Key" })),
        el("td", { class: "hb-game" }, el("h4", { textContent: k.name, title: k.name }), el("p", { textContent: k.bundle, title: k.bundle }), steam),
        el("td", {}, keyField(k)),
      ),
    );
  }
  $("keyRows").replaceChildren(frag);
  $("keyEmpty").hidden = rows.length > 0;
  $("keyEmpty").textContent = state.lib.keys.length ? "No keys match these filters." : "No keys yet. Click Sync.";
  pagerButtons(state.keyPage, pages, (n) => {
    state.keyPage = n;
    renderKeys();
    $("keyRows").closest(".hb-tablewrap").scrollTop = 0;
  });
  $("keyAll").checked = rows.length > 0 && rows.every((k) => state.selKeys.has(k.id));
  $("hideRedeemed").checked = $("keyState").value === "unused";

  // Summarise the current bundle/type/search, so an empty view explains
  // itself ("0 shown of 37 (37 revealed)").
  const base = filteredKeys({ ignoreState: true });
  const byStatus = {};
  for (const k of base) byStatus[k.status] = (byStatus[k.status] || 0) + 1;
  const labels = { unused: "unrevealed", revealed: "revealed", gifted: "gifted", link: "redeem links", expired: "expired", "sold-out": "sold out" };
  const breakdown = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${labels[s] || s}`)
    .join(", ");
  const expiring = base.filter(isExpiring).length;
  const hidden = base.length - rows.length;
  const from = rows.length ? (state.keyPage - 1) * KEYS_PER_PAGE + 1 : 0;
  $("keySummary").textContent =
    `${rows.length ? `${from}–${from + pageRows.length - 1} of ` : ""}${rows.length} key${rows.length === 1 ? "" : "s"}` +
    (hidden ? ` (${hidden} more hidden by the status filter; ${breakdown})` : base.length ? ` (${breakdown})` : "") +
    (expiring ? ` · ⚠ ${expiring} expiring within ${EXPIRING_DAYS} days` : "");
  updateKeyButtons();
}

function selectedRevealable() {
  return state.lib.keys.filter((k) => state.selKeys.has(k.id) && k.status === "unused" && !k.v2);
}

function updateKeyButtons() {
  const n = selectedRevealable().length;
  const btn = $("revealSelBtn");
  if (!btn.classList.contains("armed")) btn.textContent = `Reveal selected${n ? ` (${n})` : ""}`;
  btn.disabled = !n || !!state.busy;
}

// Any filter change starts again at page 1.
["keySearch", "keyBundle", "keyState", "keyType"].forEach((id) =>
  $(id).addEventListener("input", () => {
    state.keyPage = 1;
    renderKeys();
  }),
);
// "Hide redeemed keys & entitlements" is a shortcut for the Unrevealed filter.
$("hideRedeemed").addEventListener("change", (e) => {
  $("keyState").value = e.target.checked ? "unused" : "all";
  state.keyPage = 1;
  renderKeys();
});

$("keyAll").addEventListener("change", (e) => {
  for (const k of state.shownKeys) {
    if (e.target.checked) state.selKeys.add(k.id);
    else state.selKeys.delete(k.id);
  }
  renderKeys();
});

armable(
  $("revealSelBtn"),
  () => `Reveal ${selectedRevealable().length} key(s)? Click again`,
  async () => {
    const ids = selectedRevealable().map((k) => k.id);
    const res = await humbler.revealKeys(ids);
    if (res?.results) for (const r of res.results) if (r.ok) state.selKeys.delete(r.id);
    updateKeyButtons();
  },
);

$("copyKeysBtn").addEventListener("click", () => {
  const lines = state.shownKeys.filter((k) => k.status === "revealed").map((k) => `${k.name}: ${k.key}`);
  humbler.copy(lines.join("\n"));
  $("copyKeysBtn").textContent = `Copied ${lines.length}`;
  setTimeout(() => ($("copyKeysBtn").textContent = "Copy revealed"), 1500);
});

$("exportKeysBtn").addEventListener("click", () => humbler.exportKeys(state.shownKeys.map((k) => k.id)));

humbler.onKeyUpdated(({ id, key }) => {
  const k = state.lib.keys.find((x) => x.id === id);
  if (k && key) {
    k.key = key;
    k.status = "revealed";
  }
});

// ---- downloads ----------------------------------------------------------

function filteredFiles() {
  const q = $("fileSearch").value.trim().toLowerCase();
  const bundle = $("fileBundle").value;
  const platform = $("filePlatform").value;
  const format = $("fileFormat").value;
  const hideDone = $("hideDone").checked;
  const hideDupes = $("hideDupes").checked;
  return state.lib.files.filter((f) => {
    if (bundle && f.gamekey !== bundle) return false;
    if (platform && f.platform !== platform) return false;
    if (format && f.format !== format) return false;
    if (hideDone && f.downloaded && !state.progress.has(f.id)) return false;
    if (hideDupes && f.duplicateOf) return false;
    if (q && !`${f.product} ${f.bundle} ${f.filename}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function statusNode(f) {
  const p = state.progress.get(f.id);
  if (p?.state === "downloading") {
    const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
    return el(
      "div",
      {},
      el("span", { class: "tag", textContent: p.total ? `${pct}% · ${fmtBytes(p.received)}` : fmtBytes(p.received) }),
      el("div", { class: "bar" }, el("i", { style: `width:${pct}%` })),
    );
  }
  if (p?.state === "queued") return el("span", { class: "tag", textContent: "queued" });
  if (p?.state === "error") return el("span", { class: "tag bad", textContent: "failed", title: p.error || "" });
  if (p?.state === "cancelled") return el("span", { class: "tag warn", textContent: "cancelled" });
  if (f.downloaded || p?.state === "done") {
    const b = el("button", { class: "small", textContent: "Show" });
    b.addEventListener("click", () => humbler.showFile(f.id));
    return el("span", { class: "keycell" }, el("span", { class: "tag ok", textContent: "downloaded" }), b);
  }
  if (!f.downloadable) {
    const tag = el("span", { class: "tag", textContent: "no direct file", title: f.notDownloadableReason || "Humble offers this only as an external link or in-browser" });
    return f.contentUrl ? el("span", { class: "keycell" }, tag, extLink("Open", f.contentUrl, "Download it on Humble (opens on the right)")) : tag;
  }
  if (f.duplicateOf) return el("span", { class: "tag", textContent: "duplicate", title: "Same file (by checksum) exists in an older bundle" });
  return null;
}

function renderFiles() {
  const rows = filteredFiles();
  state.shownFiles = rows;
  const frag = document.createDocumentFragment();
  for (const f of rows.slice(0, ROW_LIMIT)) {
    const chk = el("input", { type: "checkbox", checked: state.selFiles.has(f.id), disabled: !f.downloadable });
    chk.addEventListener("change", () => {
      if (chk.checked) state.selFiles.add(f.id);
      else state.selFiles.delete(f.id);
      updateFileButtons();
    });
    frag.append(
      el(
        "tr",
        { dataset: { id: f.id } },
        el("td", { class: "chk" }, chk),
        el(
          "td",
          { title: `${f.product}\n${f.bundle}\n${f.filename}` },
          f.product,
          el("span", { class: "sub", textContent: `${f.bundle} · ${f.filename}` }),
        ),
        el("td", {}, f.platform),
        el("td", { title: f.format }, f.format),
        el("td", { class: "num", textContent: f.humanSize || fmtBytes(f.size) }),
        el("td", { class: "status" }, statusNode(f)),
      ),
    );
  }
  $("fileRows").replaceChildren(frag);
  $("fileMore").hidden = rows.length <= ROW_LIMIT;
  $("fileMore").textContent = `Showing ${ROW_LIMIT} of ${rows.length} — narrow the filters to see the rest.`;
  $("fileAll").checked = rows.length > 0 && rows.every((f) => !f.downloadable || state.selFiles.has(f.id));
  const total = rows.reduce((s, f) => s + (f.downloaded ? 0 : f.size || 0), 0);
  $("fileSummary").textContent = `${rows.length} shown · ${fmtBytes(total) || "0 B"} not yet downloaded`;
  updateFileButtons();
}

function updateFileButtons() {
  const n = [...state.selFiles].length;
  $("queueSelBtn").textContent = `Download selected${n ? ` (${n})` : ""}`;
  $("queueSelBtn").disabled = !n;
}

["fileSearch", "fileBundle", "filePlatform", "fileFormat", "hideDone", "hideDupes"].forEach((id) =>
  $(id).addEventListener("input", renderFiles),
);

$("fileAll").addEventListener("change", (e) => {
  for (const f of state.shownFiles) {
    if (!f.downloadable) continue;
    if (e.target.checked) state.selFiles.add(f.id);
    else state.selFiles.delete(f.id);
  }
  renderFiles();
});

$("queueSelBtn").addEventListener("click", async () => {
  await humbler.enqueueDownloads([...state.selFiles]);
  state.selFiles.clear();
  renderFiles();
});
$("queueAllBtn").addEventListener("click", () =>
  humbler.enqueueDownloads(state.shownFiles.filter((f) => f.downloadable && !f.downloaded).map((f) => f.id)),
);
$("cancelBtn").addEventListener("click", () => humbler.cancelDownloads());
$("openDirBtn").addEventListener("click", () => humbler.openDownloadFolder());
$("chooseDirBtn").addEventListener("click", () => humbler.chooseDownloadDir());

humbler.onDownloadProgress((p) => {
  state.progress.set(p.id, p);
  const f = state.lib.files.find((x) => x.id === p.id);
  if (f && p.state === "done") f.downloaded = true;
  const cell = document.querySelector(`#fileRows tr[data-id="${CSS.escape(p.id)}"] td.status`);
  if (cell && f) cell.replaceChildren(statusNode(f) || "");
});

$("naming").addEventListener("change", (e) => humbler.setSettings({ naming: e.target.value }));

// ---- library (everything you own, like Humble Librarian's list) ----------

function filteredProducts() {
  const q = $("libSearch").value.trim().toLowerCase();
  const bundle = $("libBundle").value;
  const kind = $("libKind").value;
  return (state.lib.products || []).filter((p) => {
    if (bundle && p.gamekey !== bundle) return false;
    if (kind === "files" && !p.fileCount) return false;
    if (kind === "keys" && !p.keyCount) return false;
    if (kind === "links" && (p.fileCount || p.keyCount)) return false;
    if (q && !`${p.title} ${p.publisher || ""} ${p.bundle}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderLibrary() {
  const rows = filteredProducts().sort((a, b) => a.title.localeCompare(b.title));
  const bundleOf = new Map(state.lib.bundles.map((b) => [b.gamekey, b]));
  const frag = document.createDocumentFragment();
  for (const p of rows.slice(0, ROW_LIMIT)) {
    const b = bundleOf.get(p.gamekey) || {};
    const icon = p.icon ? el("img", { class: "icon", src: p.icon, loading: "lazy", alt: "" }) : el("div", { class: "icon" });
    const has = el("div", { class: "tags" });
    if (p.fileCount) has.append(el("span", { class: "tag", textContent: `${p.fileCount} file${p.fileCount > 1 ? "s" : ""}`, title: p.platforms.join(", ") }));
    if (p.keyCount) has.append(el("span", { class: "tag", textContent: `${p.keyCount} key${p.keyCount > 1 ? "s" : ""}` }));
    if (p.links.length || p.linksText) has.append(el("span", { class: "tag warn", textContent: "links", title: p.linksText || p.links.join("\n") }));
    if (!has.childNodes.length) has.append(el("span", { class: "tag", textContent: "—" }));
    const actions = el("td", { class: "actcol" });
    if (p.keyCount || p.steamAppId) actions.append(extLink("Steam", steamUrl(p.title, p.steamAppId)));
    if (p.url) actions.append(extLink(p.v2 ? "Item" : "Site", p.url));
    for (const [i, u] of p.links.slice(0, 3).entries()) actions.append(extLink(p.links.length > 1 ? `Link ${i + 1}` : "Link", u));
    actions.append(
      p.v2
        ? extLink("Bundle", `https://www.humblebundle.com/home/library/${encodeURIComponent(p.gamekey)}`, "Open this purchase on Humble")
        : extLink("Order", `https://www.humblebundle.com/downloads?key=${encodeURIComponent(p.gamekey)}`, "Open this order on Humble"),
    );
    const when = b.created ? b.created.slice(0, 10) : "";
    const paid = b.amount != null && b.amount !== "" ? ` · ${b.amount}${b.currency ? ` ${b.currency}` : ""}` : "";
    frag.append(
      el(
        "tr",
        {},
        el("td", { class: "iconcol" }, icon),
        el("td", { title: p.title }, p.title, el("span", { class: "sub", textContent: p.publisher || "" })),
        el("td", { title: p.bundle }, p.bundle, el("span", { class: "sub", textContent: `${when}${paid}` })),
        el("td", { class: "whatcol" }, has),
        actions,
      ),
    );
  }
  $("libRows").replaceChildren(frag);
  $("libMore").hidden = rows.length <= ROW_LIMIT;
  $("libMore").textContent = `Showing ${ROW_LIMIT} of ${rows.length} — narrow the filters to see the rest.`;
  const linksOnly = rows.filter((p) => !p.fileCount && !p.keyCount).length;
  $("libSummary").textContent = `${rows.length} item(s)${linksOnly ? ` · ${linksOnly} links/instructions only` : ""}`;
}

["libSearch", "libBundle", "libKind"].forEach((id) => $(id).addEventListener("input", renderLibrary));
$("markOwned").addEventListener("change", (e) => humbler.setSettings({ markOwned: e.target.checked }));

// ---- theme (dark by default) ----------------------------------------------

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  $("themeBtn").textContent = t === "dark" ? "☀" : "☾";
  $("themeBtn").title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
$("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next); // immediately, then persist
  humbler.setSettings({ theme: next });
});

// ---- redeem tracking --------------------------------------------------------
// Humble only knows a key was revealed. Whether you then activated it on
// Steam/GOG/Epic only you know, so after a Redeem link sends you to your
// browser, Humbler asks when you come back.

let pendingRedeem = null; // { id, name, platform, at }

function beginRedeem(k, platformName, url) {
  pendingRedeem = { id: k.id, name: k.name, platform: platformName, at: Date.now() };
  humbler.openUrl(url);
}

function askAboutRedeem() {
  if (!pendingRedeem || Date.now() - pendingRedeem.at < 1500) return; // focus flicker while the browser opens
  $("redeemAskText").textContent = `Did you redeem "${pendingRedeem.name}" on ${pendingRedeem.platform}?`;
  $("redeemAsk").hidden = false;
  $("redeemYes").focus();
}

async function answerRedeem(redeemed) {
  const p = pendingRedeem;
  pendingRedeem = null;
  $("redeemAsk").hidden = true;
  if (p && redeemed) await setRedeemed(p.id, true, p.platform);
}

async function setRedeemed(id, redeemed, platformName) {
  const rec = await humbler.markRedeemed(id, redeemed, platformName);
  const k = state.lib.keys.find((x) => x.id === id);
  if (k) k.platformRedeemed = redeemed ? rec : null;
  renderKeys();
  if (typeof renderHbPages === "function") renderHbPages({ keepView: true });
}

humbler.onAppFocus(askAboutRedeem);
$("redeemYes").addEventListener("click", () => answerRedeem(true));
$("redeemNo").addEventListener("click", () => answerRedeem(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("redeemAsk").hidden) answerRedeem(false);
});

// ---- scouting -----------------------------------------------------------

$("scoutBtn").addEventListener("click", async () => {
  const btn = $("scoutBtn");
  btn.disabled = true;
  btn.textContent = "Scouting…";
  try {
    const res = await humbler.scoutPage($("scoutReload").checked);
    if (!res?.ok) appendLog(`Scout did not run (${res?.reason || "unknown"}).`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Scout this page";
  }
});
$("reconDirBtn").addEventListener("click", () => humbler.openReconFolder());
$("liveDirBtn").addEventListener("click", () => humbler.openLiveCatalog());
$("liveScout").addEventListener("change", (e) => humbler.setSettings({ liveScout: e.target.checked }));

// ---- boot ---------------------------------------------------------------

loadLibrary();
humbler.requestStatus();

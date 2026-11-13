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
    for (const name of ["keys", "files", "library", "choice", "log"]) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
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
  renderChoice();
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
    if (st === "gifted" && !(k.status === "gifted" || k.status === "link")) return false;
    if (st === "expiring" && !isExpiring(k)) return false;
    if (st === "expired" && !(k.status === "expired" || k.status === "sold-out")) return false;
    if (q && !`${k.name} ${k.bundle} ${k.key || ""} ${k.keyType}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function copyButton(text, label = "Copy") {
  const b = el("button", { class: "small", textContent: label });
  b.addEventListener("click", () => {
    humbler.copy(text);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

function keyCell(k) {
  const cell = el("div", { class: "keycell" });
  switch (k.status) {
    case "revealed":
      cell.append(el("span", { class: "key", textContent: k.key, title: k.key }), copyButton(k.key));
      break;
    case "gifted":
    case "link":
      cell.append(el("span", { class: `tag ${k.status === "gifted" ? "ok" : ""}`, textContent: k.status === "gifted" ? "gifted" : "redeem link" }));
      if (k.key) cell.append(el("span", { class: "key", textContent: k.key, title: k.key }), copyButton(k.key, "Copy link"));
      break;
    case "expired":
      cell.append(el("span", { class: "tag bad", textContent: "expired" }));
      break;
    case "sold-out":
      cell.append(el("span", { class: "tag bad", textContent: "sold out" }));
      break;
    default: {
      cell.append(el("span", { class: "tag warn", textContent: "hidden" }));
      if (k.v2) {
        // New-site keys: reveal on Humble's own page until Humbler knows the new reveal action.
        const open = el("button", { class: "small", textContent: "Open on Humble", title: "Reveal this key on Humble (opens it on the right)" });
        open.addEventListener("click", () => humbler.openUrl(k.contentUrl));
        cell.append(open);
      } else {
        const reveal = el("button", { class: "small danger", textContent: "Reveal" });
        armable(reveal, "Sure? click again", () => humbler.revealKeys([k.id]));
        reveal.disabled = !!state.busy;
        cell.append(reveal);
      }
    }
  }
  if (isExpiring(k)) cell.append(el("span", { class: "tag bad", textContent: `expires in ${k.daysLeft}d`, title: k.expiry || "" }));
  else if (k.expiry && k.status === "unused") cell.append(el("span", { class: "tag", textContent: "expires", title: k.expiry }));
  if (k.instructions) cell.append(el("span", { class: "tag", textContent: "how to redeem", title: k.instructions }));
  return cell;
}

function renderKeys() {
  const rows = filteredKeys();
  state.shownKeys = rows;
  const body = $("keyRows");
  const frag = document.createDocumentFragment();
  for (const k of rows.slice(0, ROW_LIMIT)) {
    const chk = el("input", { type: "checkbox", checked: state.selKeys.has(k.id) });
    chk.addEventListener("change", () => {
      if (chk.checked) state.selKeys.add(k.id);
      else state.selKeys.delete(k.id);
      updateKeyButtons();
    });
    frag.append(
      el(
        "tr",
        { dataset: { id: k.id } },
        el("td", { class: "chk" }, chk),
        el(
          "td",
          { title: k.name },
          k.name,
          /steam/i.test(k.keyType) || k.steamAppId ? extLink("Steam", steamUrl(k.name, k.steamAppId)) : null,
        ),
        el("td", { title: k.keyType }, k.keyType),
        el("td", { title: k.bundle }, k.bundle),
        el("td", {}, keyCell(k)),
      ),
    );
  }
  body.replaceChildren(frag);
  $("keyMore").hidden = rows.length <= ROW_LIMIT;
  $("keyMore").textContent = `Showing ${ROW_LIMIT} of ${rows.length} — narrow the filters to see the rest.`;
  $("keyAll").checked = rows.length > 0 && rows.every((k) => state.selKeys.has(k.id));
  // Summarise the current bundle/type/search, so an empty view explains
  // itself ("0 shown of 37: 37 revealed").
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
  $("keySummary").textContent =
    `${rows.length} shown` +
    (hidden ? ` of ${base.length} (${breakdown}). Change the status filter to see the rest` : base.length ? ` (${breakdown})` : "") +
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

["keySearch", "keyBundle", "keyState", "keyType"].forEach((id) => $(id).addEventListener("input", renderKeys));

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

// ---- choice ---------------------------------------------------------------

async function renderChoice() {
  const months = await humbler.getChoice();
  const q = $("choiceSearch").value.trim().toLowerCase();
  const mode = $("choiceStatus").value;
  const owned = state.owned || new Set();
  let totalUnclaimed = 0;
  const frag = document.createDocumentFragment();

  for (const m of months) {
    const games = Object.entries(m.games || {}).map(([id, g]) => ({ id, ...g, owned: owned.has(normTitle(g.title)) }));
    const unclaimed = games.filter((g) => !g.claimed && !g.owned);
    // Only count months you were (probably) subscribed for: an order exists, or the page said you're a member.
    const entitled = !!m.gamekey || m.canClaim === true;
    if (entitled) totalUnclaimed += unclaimed.length;

    if (mode === "unclaimed" && !(entitled && unclaimed.length)) continue;
    const shown = games.filter((g) => !q || g.title.toLowerCase().includes(q));
    if (q && !shown.length) continue;

    const head = el(
      "h3",
      {},
      m.title || m.month,
      extLink("open", m.url, m.source === "library" ? "Open your library on Humble (redeem Choice games there)" : "Open this month on Humble"),
      el("span", {
        class: `tag ${entitled ? (unclaimed.length ? "warn" : "ok") : ""}`,
        textContent: entitled ? `${unclaimed.length} not in library / ${games.length}` : `${games.length} games · not subscribed?`,
        title: "Games count as yours once they show up in your synced library",
      }),
    );
    const grid = el("div", { class: "games" });
    for (const g of shown) {
      const card = el(
        "div",
        {
          class: `game${g.claimed ? " claimed" : ""}${g.owned ? " owned" : ""}`,
          title: `${g.title}${g.type ? `\n${g.type}` : ""}${g.claimed ? "\nclaimed" : ""}${g.owned ? "\nin your library" : ""}`,
        },
        g.image ? el("img", { src: g.image, loading: "lazy", alt: "" }) : null,
        el("span", { class: "t", textContent: g.title }),
      );
      // Old-site months linked to per-game pages; the new site only has the library.
      card.addEventListener("click", () => humbler.openUrl(m.source === "library" ? m.url : `${m.url}/${encodeURIComponent(g.id)}`));
      grid.append(card);
    }
    frag.append(el("div", { class: "month" }, head, games.length ? grid : null));
  }
  if (!frag.childNodes.length) {
    const text = !months.length
      ? "No Choice months yet. Open your library on the right and Humbler will pick up the current month."
      : mode === "unclaimed"
        ? "Every Choice game Humbler has seen is in your library."
        : "Nothing to show.";
    frag.append(el("div", { class: "more", textContent: text }));
  }
  $("choiceList").replaceChildren(frag);
  $("choiceCount").textContent = months.length ? `${totalUnclaimed} not in library` : "";
}

["choiceSearch", "choiceStatus"].forEach((id) => $(id).addEventListener("input", renderChoice));
$("choiceLibraryBtn").addEventListener("click", () => humbler.go("library"));
humbler.onChoiceUpdated(renderChoice);

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

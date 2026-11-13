/* global humbler, $, el, state, fmtBytes, normTitle, extLink, keyField, platformOf, formatDate */
"use strict";
// Bundles and Choice, recreated from the old humblebundle.com pages using
// the data Humbler has synced:
//   Bundles tab: all your bundles -> a bundle page modelled on the old
//                /downloads?key=... page (keys, then downloads per platform)
//   Choice tab:  every Choice month -> a month page modelled on the old
//                /membership/<month> page (the game grid)
// Shares app.js helpers (el, keyField, ...). Loaded after app.js.

const SITE = "https://www.humblebundle.com";
const BUNDLES_PER_PAGE = 60;
const PLATFORM_LABELS = { windows: "Windows", mac: "Mac", linux: "Linux", android: "Android", ebook: "eBook", audio: "Audio", video: "Video", other: "Other" };

const view = {
  bundles: { mode: "list", id: null, q: "", sort: "recent", filter: "all", page: 1, platform: "" },
  choice: { mode: "list", month: null },
};

// ---- small shared bits ---------------------------------------------------------

// Placeholder art: the library data has no images, so tiles get a stable
// colour from the title and its initials.
function tile(title, size = "md", image = null) {
  if (image) return el("img", { class: `tile ${size}`, src: image, alt: "", loading: "lazy" });
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const words = String(title).replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const initials = (words[0]?.[0] || "?") + (words[1]?.[0] || "");
  const t = el("div", { class: `tile ${size}`, textContent: initials.toUpperCase() });
  t.style.background = `hsl(${h % 360} 38% 34%)`;
  return t;
}

function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function backLink(text, onClick) {
  const a = el("a", { class: "hb-back", textContent: `‹ ${text}` });
  a.addEventListener("click", onClick);
  return a;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A row in old-HB keys style: platform badge, title (+ subtitle), keyfield.
function keyRow(k, subtitle) {
  const p = platformOf(k);
  return el(
    "div",
    { class: "hb-keyline" },
    el("span", { class: `plat ${p.id}`, textContent: p.badge, title: p.name || k.keyType || "Key" }),
    el("div", { class: "hb-keyline-title" }, el("h4", { textContent: k.name }), subtitle ? el("p", { textContent: subtitle }) : null),
    el("div", { class: "hb-keyline-field" }, keyField(k)),
  );
}

function scrollTop(id) {
  const page = $(id);
  if (page) page.scrollTop = 0;
}

function showTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`)?.click();
}

// ---- bundles: list ---------------------------------------------------------------

function bundleStats(b) {
  return [plural(b.itemCount ?? 0, "item"), b.keyCount ? plural(b.keyCount, "key") : null, b.fileCount ? plural(b.fileCount, "file") : null]
    .filter(Boolean)
    .join(" · ");
}

function renderBundleList() {
  const v = view.bundles;
  const page = $("bundlesPage");
  const q = v.q.trim().toLowerCase();
  let list = (state.lib.bundles || []).filter((b) => {
    if (q && !b.name.toLowerCase().includes(q)) return false;
    if (v.filter === "unrevealed" && !b.unrevealed) return false;
    if (v.filter === "files" && !b.fileCount) return false;
    if (v.filter === "choice" && !b.choiceMonth) return false;
    if (v.filter === "nochoice" && b.choiceMonth) return false;
    return true;
  });
  if (v.sort === "az") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (v.sort === "unrevealed") list = [...list].sort((a, b) => (b.unrevealed || 0) - (a.unrevealed || 0) || (a.order ?? 0) - (b.order ?? 0));
  else list = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const pages = Math.max(1, Math.ceil(list.length / BUNDLES_PER_PAGE));
  v.page = Math.min(Math.max(1, v.page), pages);
  const shown = list.slice((v.page - 1) * BUNDLES_PER_PAGE, v.page * BUNDLES_PER_PAGE);

  const search = el("input", { class: "hb-search", type: "search", placeholder: "Search bundles", value: v.q });
  search.addEventListener("input", () => {
    v.q = search.value;
    v.page = 1;
    renderBundleList();
    const again = $("bundlesPage").querySelector(".hb-search");
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
  const sort = el(
    "select",
    { title: "Sort" },
    el("option", { value: "recent", textContent: "Most recent" }),
    el("option", { value: "az", textContent: "A – Z" }),
    el("option", { value: "unrevealed", textContent: "Most unrevealed keys" }),
  );
  sort.value = v.sort;
  sort.addEventListener("input", () => {
    v.sort = sort.value;
    v.page = 1;
    renderBundleList();
  });
  const filter = el(
    "select",
    { title: "Show" },
    el("option", { value: "all", textContent: "All bundles" }),
    el("option", { value: "unrevealed", textContent: "With unrevealed keys" }),
    el("option", { value: "files", textContent: "With downloads" }),
    el("option", { value: "choice", textContent: "Humble Choice months" }),
    el("option", { value: "nochoice", textContent: "Everything but Choice" }),
  );
  filter.value = v.filter;
  filter.addEventListener("input", () => {
    v.filter = filter.value;
    v.page = 1;
    renderBundleList();
  });

  const grid = el("div", { class: "hb-cards" });
  for (const b of shown) {
    const card = el(
      "button",
      { class: "hb-card", title: b.name },
      tile(b.name),
      el(
        "div",
        { class: "hb-card-body" },
        el("h4", { textContent: b.name }),
        el("p", { textContent: bundleStats(b) }),
        b.unrevealed ? el("span", { class: "hb-flag", textContent: `${b.unrevealed} unrevealed` }) : null,
      ),
    );
    card.addEventListener("click", () => openBundle(b.gamekey));
    grid.append(card);
  }

  const pager = el("div", { class: "hb-pager" });
  if (pages > 1) {
    const btn = (label, n, opts = {}) => {
      const x = el("button", { textContent: label, disabled: !!opts.disabled, class: opts.current ? "current" : "" });
      x.addEventListener("click", () => {
        v.page = n;
        renderBundleList();
        scrollTop("bundlesPage");
      });
      return x;
    };
    pager.append(btn("‹ Prev", v.page - 1, { disabled: v.page === 1 }));
    for (let n = 1; n <= pages; n++) {
      if (n === 1 || n === pages || Math.abs(n - v.page) <= 2) pager.append(btn(String(n), n, { current: n === v.page }));
      else if (Math.abs(n - v.page) === 3) pager.append(el("span", { class: "gap", textContent: "…" }));
    }
    pager.append(btn("Next ›", v.page + 1, { disabled: v.page === pages }));
  }

  page.replaceChildren(
    el(
      "div",
      { class: "hb-head" },
      el("h2", { textContent: "Your Bundles" }),
      el("div", { class: "hb-controls" }, search, sort, filter),
    ),
    el("div", { class: "hb-summary", textContent: `${plural(list.length, "bundle")}${q || v.filter !== "all" ? ` of ${(state.lib.bundles || []).length}` : ""}` }),
    list.length ? grid : el("div", { class: "hb-empty", textContent: (state.lib.bundles || []).length ? "No bundles match." : "No bundles yet. Click Sync." }),
    pager,
  );
}

// ---- bundles: one bundle (old /downloads?key= page) --------------------------

function openBundle(id) {
  view.bundles.mode = "bundle";
  view.bundles.id = id;
  view.bundles.platform = "";
  showTab("bundles");
  renderBundlePage();
  scrollTop("bundlesPage");
}

function renderBundlePage() {
  const v = view.bundles;
  const b = (state.lib.bundles || []).find((x) => x.gamekey === v.id);
  const page = $("bundlesPage");
  if (!b) {
    v.mode = "list";
    renderBundleList();
    return;
  }
  const keys = state.lib.keys.filter((k) => k.gamekey === b.gamekey);
  const files = state.lib.files.filter((f) => f.gamekey === b.gamekey);
  const products = (state.lib.products || []).filter((p) => p.gamekey === b.gamekey);

  const head = el(
    "div",
    { class: "hb-bundle-head" },
    tile(b.name, "lg"),
    el(
      "div",
      {},
      el("h2", { textContent: b.name }),
      el("p", { class: "hb-summary", textContent: bundleStats(b) + (b.unrevealed ? ` · ${b.unrevealed} unrevealed` : "") }),
      el(
        "div",
        { class: "hb-links" },
        extLink("Open on Humble", `${SITE}/home/library/${encodeURIComponent(b.gamekey)}`, "Open this purchase on Humble (right)"),
        b.choiceMonth ? choiceLink(b.choiceMonth) : null,
      ),
    ),
  );

  const sections = [];

  if (keys.length) {
    sections.push(
      el("section", { class: "hb-section" }, el("h3", { textContent: "Keys & Entitlements" }), el("div", { class: "hb-panel" }, ...keys.map((k) => keyRow(k)))),
    );
  }

  if (files.length) {
    const platforms = [...new Set(files.map((f) => f.platform))];
    if (v.platform && !platforms.includes(v.platform)) v.platform = "";
    const tabs = el("div", { class: "plat-tabs" });
    for (const pl of ["", ...platforms]) {
      const t = el("button", { class: pl === v.platform ? "active" : "", textContent: pl ? PLATFORM_LABELS[pl] || pl : "All platforms" });
      t.addEventListener("click", () => {
        v.platform = pl;
        renderBundlePage();
      });
      tabs.append(t);
    }
    const visible = files.filter((f) => !v.platform || f.platform === v.platform);
    const fetchable = visible.filter((f) => f.downloadable && !f.downloaded);
    const all = el("button", {
      class: "hb-btn",
      textContent: fetchable.length ? `Download all ${v.platform ? PLATFORM_LABELS[v.platform] || v.platform : ""} (${fetchable.length})`.replace("  ", " ") : "Everything here is downloaded",
      disabled: !fetchable.length,
      title: fetchable.length ? `${fmtBytes(fetchable.reduce((s, f) => s + (f.size || 0), 0))} to Humbler's download folder` : "",
    });
    all.addEventListener("click", () => humbler.enqueueDownloads(fetchable.map((f) => f.id)));

    const byProduct = new Map();
    for (const f of visible) {
      if (!byProduct.has(f.product)) byProduct.set(f.product, []);
      byProduct.get(f.product).push(f);
    }
    const rows = [...byProduct.entries()].map(([title, fs]) =>
      el(
        "div",
        { class: "hb-dlrow" },
        tile(title, "sm"),
        el("div", { class: "hb-dlrow-title" }, el("h4", { textContent: title }), el("p", { textContent: [...new Set(fs.map((f) => PLATFORM_LABELS[f.platform] || f.platform))].join(" · ") })),
        // with "All platforms" showing, say which platform each file is for
        el("div", { class: "hb-dlrow-files" }, ...fs.map((f) => fileButton(f, { showPlatform: !v.platform && new Set(fs.map((x) => x.platform)).size > 1 }))),
      ),
    );
    sections.push(
      el(
        "section",
        { class: "hb-section" },
        el("div", { class: "hb-section-head" }, el("h3", { textContent: "Downloads" }), all),
        tabs,
        el("div", { class: "hb-panel" }, ...rows),
      ),
    );
  }

  const linkOnly = products.filter((p) => !p.keyCount && !p.fileCount);
  if (linkOnly.length) {
    sections.push(
      el(
        "section",
        { class: "hb-section" },
        el("h3", { textContent: "Other items" }),
        el(
          "div",
          { class: "hb-panel" },
          ...linkOnly.map((p) =>
            el("div", { class: "hb-dlrow" }, tile(p.title, "sm"), el("div", { class: "hb-dlrow-title" }, el("h4", { textContent: p.title }), el("p", { textContent: "No key or download in the library data" })), el("div", {}, p.url ? extLink("Open on Humble", p.url) : null)),
          ),
        ),
      ),
    );
  }

  page.replaceChildren(
    backLink("All bundles", () => {
      v.mode = "list";
      renderBundleList();
    }),
    head,
    ...sections,
  );
}

// One download "button" per file, like the old page: format + size; state.
function fileButton(f, { showPlatform = false } = {}) {
  const prog = state.progress.get(f.id);
  const label = `${showPlatform ? `${PLATFORM_LABELS[f.platform] || f.platform} · ` : ""}${f.format || "Download"}${f.humanSize || f.size ? ` · ${f.humanSize || fmtBytes(f.size)}` : ""}`;
  let stateText = "";
  let cls = "file-btn";
  if (f.downloaded || prog?.state === "done") {
    stateText = "✓ Downloaded";
    cls += " done";
  } else if (prog?.state === "downloading") stateText = prog.total ? `${Math.floor((prog.received / prog.total) * 100)}%` : "downloading…";
  else if (prog?.state === "queued") stateText = "queued";
  else if (prog?.state === "error") {
    stateText = "failed";
    cls += " failed";
  } else if (!f.downloadable) {
    stateText = "no link";
    cls += " nolink";
  }
  const b = el(
    "button",
    {
      class: cls,
      title: [f.filename, f.md5 ? `MD5 ${f.md5}` : "", f.notDownloadableReason || "", prog?.error || ""].filter(Boolean).join("\n"),
      disabled: !f.downloadable && !f.downloaded,
    },
    el("span", { textContent: label }),
    stateText ? el("small", { textContent: stateText }) : null,
  );
  b.addEventListener("click", () => {
    if (f.downloaded) humbler.showFile(f.id);
    else if (f.downloadable) humbler.enqueueDownloads([f.id]);
  });
  return b;
}

// ---- choice: months ------------------------------------------------------------------

// Every Choice month Humbler knows about: from your library (bundles named
// "<Month> Humble Choice"), Humble's empty month groups, and the current
// month harvested from the library page (with images).
async function choiceMonths() {
  const months = new Map();
  const get = (m) => {
    if (!months.has(m)) months.set(m, { month: m, bundles: [], games: [], harvested: null, group: false });
    return months.get(m);
  };
  for (const b of state.lib.bundles || []) if (b.choiceMonth) get(b.choiceMonth).bundles.push(b);
  for (const g of state.lib.choiceGroups || []) get(g.month).group = true;
  let harvested = [];
  try {
    harvested = await humbler.getChoice();
  } catch {
    // no harvested months yet
  }
  for (const h of harvested) get(h.month).harvested = h;
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}

// The games of one month: library items (with their keys), plus harvested
// games that aren't in your library yet.
function monthGames(m) {
  const ids = new Set(m.bundles.map((b) => b.gamekey));
  const products = (state.lib.products || []).filter((p) => ids.has(p.gamekey));
  const images = new Map(Object.values(m.harvested?.games || {}).map((g) => [normTitle(g.title), g.image]));
  const games = products.map((p) => ({
    title: p.title,
    image: images.get(normTitle(p.title)) || null,
    // match by item id (new-site data), else by title (legacy order data)
    keys: state.lib.keys.filter((k) => (k.itemId ? k.itemId === p.id : k.gamekey === p.gamekey && normTitle(k.name) === normTitle(p.title))),
    files: state.lib.files.filter((f) => (f.itemId ? f.itemId === p.id : f.gamekey === p.gamekey && f.product === p.title)),
    url: p.url,
    inLibrary: true,
  }));
  const have = new Set(games.map((g) => normTitle(g.title)));
  for (const g of Object.values(m.harvested?.games || {})) {
    if (!have.has(normTitle(g.title))) games.push({ title: g.title, image: g.image, keys: [], files: [], type: g.type, inLibrary: false });
  }
  return games;
}

function choiceLink(month) {
  const a = el("a", { class: "ext", textContent: `${monthLabel(month)} Choice page`, title: "Open this month's Choice page in Humbler" });
  a.addEventListener("click", () => openChoiceMonth(month));
  return a;
}

async function renderChoiceIndex() {
  const page = $("choicePage");
  const months = await choiceMonths();
  $("choiceCount").textContent = months.length ? String(months.length) : "";
  const grid = el("div", { class: "hb-cards months" });
  for (const m of months) {
    const games = monthGames(m);
    const unrevealed = games.reduce((n, g) => n + g.keys.filter((k) => k.status === "unused").length, 0);
    const notInLib = games.filter((g) => !g.inLibrary).length;
    const strip = el("div", { class: "month-strip" }, ...games.slice(0, 4).map((g) => tile(g.title, "xs", g.image)));
    const card = el(
      "button",
      { class: "hb-card month-card" },
      el(
        "div",
        { class: "hb-card-body" },
        el("h4", { textContent: monthLabel(m.month) }),
        el("p", { textContent: games.length ? plural(games.length, "game") : m.group ? "No games from this month in your library" : "No games yet" }),
        unrevealed || notInLib
          ? el(
              "div",
              { class: "hb-flags" },
              unrevealed ? el("span", { class: "hb-flag", textContent: `${unrevealed} unrevealed` }) : null,
              notInLib ? el("span", { class: "hb-flag amber", textContent: `${notInLib} not in library` }) : null,
            )
          : null,
      ),
      games.length ? strip : null,
    );
    card.addEventListener("click", () => openChoiceMonth(m.month));
    grid.append(card);
  }
  page.replaceChildren(
    el("div", { class: "hb-head" }, el("h2", { textContent: "Humble Choice" })),
    el("p", {
      class: "hb-summary",
      textContent:
        "Humble no longer serves its Choice pages. These are rebuilt from your library (each month's games, keys and downloads) and from the current month as listed on your library page.",
    }),
    months.length ? grid : el("div", { class: "hb-empty", textContent: "No Choice months yet. Sync your library, or open it on the right." }),
  );
}

function openChoiceMonth(month) {
  view.choice.mode = "month";
  view.choice.month = month;
  showTab("choice");
  renderChoiceMonth();
  scrollTop("choicePage");
}

async function renderChoiceMonth() {
  const months = await choiceMonths();
  const m = months.find((x) => x.month === view.choice.month);
  const page = $("choicePage");
  if (!m) {
    view.choice.mode = "list";
    return renderChoiceIndex();
  }
  const games = monthGames(m);
  const cards = games.map((g) => {
    const keyBits = g.keys.map((k) => el("div", { class: "choice-key" }, keyField(k)));
    const status = !g.inLibrary
      ? el("div", { class: "choice-missing" }, "Not in your library yet. ", extLink("Claim it in your library", `${SITE}/home/library`))
      : !g.keys.length && !g.files.length
        ? el("p", { class: "muted-line", textContent: "No key or download listed" })
        : null;
    const filesLine = g.files.length
      ? el("div", { class: "choice-files" }, ...g.files.map((f) => fileButton(f)))
      : null;
    return el(
      "div",
      { class: `choice-card${g.inLibrary ? "" : " missing"}` },
      g.image ? el("img", { class: "choice-art", src: g.image, alt: "", loading: "lazy" }) : tile(g.title, "art"),
      el("div", { class: "choice-body" }, el("h4", { textContent: g.title }), ...keyBits, filesLine, status),
    );
  });
  const bundleLinks = m.bundles.map((b) => {
    const a = el("a", { class: "ext", textContent: "Bundle page", title: b.name });
    a.addEventListener("click", () => openBundle(b.gamekey));
    return a;
  });
  page.replaceChildren(
    backLink("All Choice months", () => {
      view.choice.mode = "list";
      renderChoiceIndex();
    }),
    el(
      "div",
      { class: "hb-head" },
      el("h2", { textContent: `${monthLabel(m.month)} Humble Choice` }),
      el("div", { class: "hb-links" }, ...bundleLinks, extLink("Open your library on Humble", `${SITE}/home/library`)),
    ),
    el("p", { class: "hb-summary", textContent: games.length ? plural(games.length, "game") : "No games from this month in your library." }),
    el("div", { class: "choice-grid" }, ...cards),
  );
}

// ---- entry point (called by app.js whenever the library changes) ----------------

function renderHbPages({ keepView = true } = {}) {
  $("bundlesCount").textContent = state.lib.bundles?.length ? String(state.lib.bundles.length) : "";
  if (!keepView) {
    view.bundles.mode = "list";
    view.choice.mode = "list";
  }
  if (view.bundles.mode === "bundle") renderBundlePage();
  else renderBundleList();
  if (view.choice.mode === "month") renderChoiceMonth();
  else renderChoiceIndex();
}

// Live download progress: refresh the open bundle/Choice page (cheap enough
// at these sizes), at most a few times a second.
let progressTimer = null;
humbler.onDownloadProgress(() => {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    if (!$("tab-bundles").hidden && view.bundles.mode === "bundle") renderBundlePage();
    if (!$("tab-choice").hidden && view.choice.mode === "month") renderChoiceMonth();
  }, 400);
});
humbler.onChoiceUpdated(() => (view.choice.mode === "month" ? renderChoiceMonth() : renderChoiceIndex()));

// The library may already have loaded before this script ran.
if (state.lib?.bundles) renderHbPages();

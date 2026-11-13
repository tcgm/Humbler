// Page harvesting: the "scraping" half of Humbler. This is for data Humble
// only puts in its pages and has no API for, chiefly Humble Choice (which
// months exist, which games each month offered, which you've claimed). It's
// the same data Humble Librarian collected.
//
// The site has been redesigned, so nothing here relies on one exact layout.
// Each page visit is harvested from three sources:
//   1. JSON responses captured by the injected script (lib/inject-capture.js)
//   2. JSON embedded in <script> tags
//   3. Librarian's DOM selectors (old layout; harmless if they find nothing)
// The JSON is searched by shape rather than by path. Raw harvests are saved
// to data/harvest/, so a missed case can be fixed from real data later.
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./paths");

const HARVEST_DIR = path.join(DATA_DIR, "harvest");
const CHOICE_PATH = path.join(DATA_DIR, "choice.json");
const CHOICE_FIRST_MONTH = "2019-12"; // Humble Choice launched December 2019

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// ---- month ids ("2026-11") <-> Humble slugs ("november-2026") -------------

function monthFromText(s) {
  if (!s) return null;
  const str = String(s).toLowerCase();
  let m = /(january|february|march|april|may|june|july|august|september|october|november|december)[\s_-]+(\d{4})/.exec(str);
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}`;
  m = /(\d{4})[\s_-]+(january|february|march|april|may|june|july|august|september|october|november|december)/.exec(str);
  if (m) return `${m[1]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, "0")}`;
  return null;
}

function monthSlug(id) {
  const [y, m] = id.split("-").map(Number);
  return `${MONTHS[m - 1]}-${y}`;
}

function choiceMonthUrl(id) {
  return `https://www.humblebundle.com/membership/${monthSlug(id)}`;
}

function allChoiceMonths(now = new Date()) {
  const out = [];
  let [y, m] = CHOICE_FIRST_MONTH.split("-").map(Number);
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out.reverse(); // newest first
}

// ---- JSON shape search ----------------------------------------------------

function walk(node, visit, depth = 0, seen = new Set(), parent = null) {
  if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return;
  seen.add(node);
  visit(node, parent);
  for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, visit, depth + 1, seen, node);
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// The largest object-of-objects inside `root` whose entries have titles,
// which is what Choice game lists have always looked like.
function findGameMap(root) {
  let best = null;
  walk(root, (o) => {
    if (Array.isArray(o)) {
      const games = o.filter((g) => g && typeof g === "object" && str(g.title || g.human_name));
      if (games.length >= 2 && (!best || games.length > best.length)) {
        best = games.map((g, i) => [str(g.machine_name || g.id || g.display_item_machine_name) || `item${i}`, g]);
      }
      return;
    }
    const entries = Object.entries(o).filter(([, g]) => g && typeof g === "object" && !Array.isArray(g) && str(g.title || g.human_name));
    if (entries.length >= 2 && (!best || entries.length > best.length)) best = entries;
  });
  return best || [];
}

function collectChoicesMade(root) {
  const made = new Set();
  walk(root, (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (/choices?_made|claimed(_choices)?$|chosen/i.test(k) && Array.isArray(v)) {
        for (const x of v) if (typeof x === "string") made.add(x);
      }
    }
  });
  return made;
}

function gameImage(g) {
  for (const k of ["image", "tile_image", "large_capsule", "featured_image", "image_url", "thumbnail"]) {
    const v = g[k];
    if (str(v)) return v;
    if (v && typeof v === "object" && str(v.url)) return v.url;
  }
  return null;
}

function gameType(g) {
  const dm = g.delivery_methods || g.platforms;
  if (Array.isArray(dm)) return dm.filter((x) => typeof x === "string").join(" ") || null;
  return str(g.type) || null;
}

// Find every Choice month described in `roots` (JSON values).
function extractChoiceFromJson(roots, pageUrl) {
  const found = [];
  const handled = new WeakSet();
  const urlMonth = monthFromText(pageUrl);
  for (const root of roots) {
    walk(root, (o) => {
      if (handled.has(o)) return;
      // Classic shape: { contentChoiceOptions: {...}, contentChoicesMade: {...} }
      // Also accept any object holding a contentChoiceData block.
      const opts = o.contentChoiceOptions && typeof o.contentChoiceOptions === "object" ? o.contentChoiceOptions : o.contentChoiceData ? o : null;
      if (!opts) return;
      handled.add(opts);
      const data = opts.contentChoiceData || opts;
      const games = findGameMap(data);
      if (!games.length) return;
      const made = collectChoicesMade(o.contentChoicesMade || opts.contentChoicesMade || o);
      const month =
        monthFromText(opts.productUrlPath) ||
        monthFromText(opts.productMachineName || opts.machine_name) ||
        monthFromText(opts.title) ||
        urlMonth;
      if (!month) return;
      found.push({
        month,
        title: str(opts.title) || null,
        gamekey: str(opts.gamekey) || null,
        source: "json",
        games: Object.fromEntries(
          games.map(([id, g]) => [
            id,
            {
              title: str(g.title || g.human_name),
              image: gameImage(g),
              type: gameType(g),
              claimed: made.has(id) || g.is_claimed === true || g.claimed === true,
              steamAppId: g.steam_app_id || null,
            },
          ]),
        ),
      });
    });
  }
  // The same month can turn up in several sources (embedded + an API
  // response); combine them into one entry.
  const byMonth = new Map();
  for (const f of found) {
    const prev = byMonth.get(f.month);
    if (!prev) {
      byMonth.set(f.month, f);
      continue;
    }
    prev.title ||= f.title;
    prev.gamekey ||= f.gamekey;
    for (const [id, g] of Object.entries(f.games)) {
      const p = prev.games[id];
      prev.games[id] = p ? { ...g, ...p, claimed: p.claimed || g.claimed } : g;
    }
  }
  return [...byMonth.values()];
}

// Runs inside the Humble page; Librarian's selectors for the old Choice layout.
const DOM_CHOICE_SCRIPT = `
(() => {
  const out = [];
  for (const bundle of document.querySelectorAll(".js-content-choices")) {
    const titleEl = bundle.querySelector(".content-choices-title span");
    const machine = titleEl && titleEl.getAttribute("data-machine-name");
    const canClaim = !!bundle.querySelector(".js-initialize-multiselect");
    const games = {};
    for (const e of bundle.querySelectorAll(".content-choice")) {
      const img = e.querySelector(".choice-image-container");
      const id = (img && img.getAttribute("data-machine-name")) || (e.querySelector(".content-choice-title") || {}).textContent;
      if (!id) continue;
      games[id] = {
        title: ((e.querySelector(".content-choice-title") || {}).textContent || "").trim(),
        image: (e.querySelector("img") || {}).src || null,
        type: Array.from(e.querySelectorAll(".delivery-methods i")).map((i) => i.getAttribute("aria-label")).join(" ") || null,
        claimed: e.classList.contains("claimed"),
      };
    }
    out.push({ machine, title: titleEl ? titleEl.textContent.trim() : null, canClaim, games });
  }
  return out;
})()
`;

function extractChoiceFromDom(domResults, pageUrl) {
  return (domResults || [])
    .map((b) => ({
      month: monthFromText(b.machine) || monthFromText(b.title) || monthFromText(pageUrl),
      title: b.title,
      gamekey: null,
      source: "dom",
      canClaim: b.canClaim,
      games: b.games,
    }))
    .filter((b) => b.month && Object.keys(b.games).length);
}

// ---- choice store --------------------------------------------------------

function loadChoice() {
  try {
    return JSON.parse(fs.readFileSync(CHOICE_PATH, "utf8"));
  } catch {
    return { months: {} };
  }
}

function saveChoice(store) {
  fs.mkdirSync(path.dirname(CHOICE_PATH), { recursive: true });
  fs.writeFileSync(CHOICE_PATH, JSON.stringify(store, null, 2));
}

// Merge freshly harvested months into the store. A fresh harvest replaces
// that month's game list, but "claimed" never flips back to false. Claims
// are permanent, so a page that doesn't show claim state can't un-claim
// something.
function mergeChoice(store, harvested) {
  const now = new Date().toISOString();
  for (const h of harvested) {
    const prev = store.months[h.month] || {};
    const games = {};
    for (const [id, g] of Object.entries(h.games)) {
      games[id] = { ...g, claimed: !!(g.claimed || prev.games?.[id]?.claimed) };
    }
    store.months[h.month] = {
      month: h.month,
      title: h.title || prev.title || null,
      gamekey: h.gamekey || prev.gamekey || null,
      canClaim: h.canClaim ?? prev.canClaim ?? null,
      source: h.source,
      seenAt: now,
      games,
    };
  }
  return store;
}

function saveRawHarvest(kind, pageUrl, payload) {
  const dir = path.join(HARVEST_DIR, kind);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${(monthFromText(pageUrl) || "page").replace(/[^a-z0-9-]/gi, "")}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ url: pageUrl, ...payload }, null, 2));
  // keep the newest 200 per kind
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 200))) fs.rmSync(path.join(dir, f), { force: true });
}

module.exports = {
  HARVEST_DIR,
  allChoiceMonths,
  choiceMonthUrl,
  monthFromText,
  monthSlug,
  extractChoiceFromJson,
  extractChoiceFromDom,
  DOM_CHOICE_SCRIPT,
  loadChoice,
  saveChoice,
  mergeChoice,
  saveRawHarvest,
};

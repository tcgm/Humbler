// The 2026 site's library. Humble removed /api/v1. The library page now
// pages through your entitlements with a Next.js server action that takes
// form fields:
//   _1_requestId, _1_query, _1_sort ("mostRecent"), _1_cursor, _1_page,
//   _1_limit, _1_hideRevealed, _1_hideExpired, _1_dateExpires
// plus "0" = JSON [previousState, "$K1"] (useActionState: state + form data)
// and replies with an RSC payload whose data row is
//   { results: [...items], pagination: { page, totalPages, totalDocs }, success }
//
// Each item (a "content entitlement"):
//   { id, title, subTitle (bundle name), itemType, type, contentId,
//     productEntitlementId (the purchase/bundle), deliveryMethods,
//     choiceDate, releaseDate,
//     entitlements: { keys: [...], downloads: [...] } }
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DATA_DIR } = require("./paths");
const { resolvedFlightData } = require("./rsc");
const lib = require("./library");

const CACHE_PATH = path.join(DATA_DIR, "library-v2.json");
const SITE = "https://www.humblebundle.com";
// Argument names that identify the library-listing action in the registry.
const LIBRARY_ACTION_ARGS = ["limit", "page", "sort", "query"];

const und = (v) => (v === "$undefined" || v === undefined ? null : v);
const shortHash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// ---- cache ------------------------------------------------------------------

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_PATH);
}

// ---- calling the action -----------------------------------------------------

// Form fields for one page; values mirror what the site itself sends.
function libraryFields({ page, limit, requestId, query = "" }) {
  return [
    ["_1_requestId", String(requestId)],
    ["_1_query", query],
    ["_1_sort", "mostRecent"],
    ["_1_cursor", String(page * limit)],
    ["_1_page", String(page)],
    ["_1_limit", String(limit)],
    ["_1_hideRevealed", "false"],
    ["_1_hideExpired", "false"],
    ["_1_dateExpires", ""],
  ];
}

// Source for executeJavaScript: POST the action from inside the page.
function actionCallScript(actionId, pagePath, fields) {
  const prevState = { results: [], pagination: { page: 1, totalPages: 1, totalDocs: 0 }, success: true };
  return `
    (async () => {
      const fd = new FormData();
      for (const [k, v] of ${JSON.stringify(fields)}) fd.append(k, v);
      fd.append("0", ${JSON.stringify(JSON.stringify([prevState, "$K1"]))});
      const r = await fetch(${JSON.stringify(pagePath)}, {
        method: "POST",
        credentials: "include",
        headers: { "Next-Action": ${JSON.stringify(actionId)}, Accept: "text/x-component" },
        body: fd,
      });
      return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
    })()
  `;
}

// Find the { results, pagination } row in an RSC reply.
// The reply's data row, with RSC references resolved, so download details
// and signed URLs held in separate rows are filled in.
function parseLibraryResponse(text) {
  return resolvedFlightData(text).find((v) => v && Array.isArray(v.results) && v.pagination) || null;
}

// ---- items -> Humbler's index ------------------------------------------------

// A download entitlement's file list, whatever shape it takes once RSC
// references are resolved. As seen on item pages it's
// [{ platform, downloadStruct: [{ id, name, md5, sha1, fileSize, size, url: { web } }] }];
// also accept a bare struct list or an object keyed by platform.
function downloadStructs(ent) {
  let groups = ent.downloads;
  if (groups && !Array.isArray(groups) && typeof groups === "object") groups = Object.values(groups);
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    if (Array.isArray(g.downloadStruct)) for (const st of g.downloadStruct) out.push({ d: g, st });
    else if (g.url || g.md5) out.push({ d: { platform: g.platform || ent.platform }, st: g });
  }
  return out;
}

// Map of every absolute URL inside a signedUrls value, keyed every way a
// file might be matched: property name, its parent's id/name, and the
// URL's file name.
function signedUrlLookup(su) {
  const map = new Map();
  const visit = (v, key, parent) => {
    if (typeof v === "string") {
      if (!/^https?:\/\//.test(v)) return;
      if (key != null) map.set(String(key), v);
      for (const f of ["id", "name", "md5", "key"]) if (parent?.[f] != null && !map.has(String(parent[f]))) map.set(String(parent[f]), v);
      try {
        const base = decodeURIComponent(path.posix.basename(new URL(v).pathname));
        if (base && !map.has(base)) map.set(base, v);
      } catch {
        // not a URL after all
      }
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, Array.isArray(x) && typeof x[0] === "string" ? x[0] : i, v));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k, v);
  };
  visit(su, null, null);
  return map;
}

// Field names and types only, never values: for logging an unexpected shape.
function shapeOnly(v, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? [shapeOnly(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).slice(0, 25).map((k) => [k, shapeOnly(v[k], depth + 1)]));
  return v === null ? "null" : typeof v;
}

function keyStatus(k) {
  const revealed = !!(und(k.redemptionData?.keyFormatted) || und(k.redeemedAt));
  if (k.giftStatus && k.giftStatus !== "unassigned") return "gifted";
  if (revealed) return "revealed";
  if (k.expired) return "expired";
  if (k.outOfStock) return "sold-out";
  return "unused";
}

function daysUntil(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
}

function buildIndexV2(items, { downloadDir, naming = "original" }) {
  const downloaded = new Set();
  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, "downloaded.jsonl"), "utf8").split("\n")) {
      try {
        downloaded.add(JSON.parse(line).id);
      } catch {
        // skip
      }
    }
  } catch {
    // none yet
  }

  const bundles = new Map();
  const keys = [];
  const files = [];
  const products = [];
  const usedDest = new Set();
  const firstByHash = new Map();

  // Items come newest first ("mostRecent"); walk oldest first so duplicates
  // point at the earliest copy, like the legacy index.
  const ordered = [...items].reverse();
  ordered.forEach((it, i) => {
    const bundleId = it.productEntitlementId || it.id;
    const bundleName = und(it.subTitle) || it.title;
    const order = ordered.length - i; // recency rank, newest = 1
    if (!bundles.has(bundleId)) {
      bundles.set(bundleId, { gamekey: bundleId, name: bundleName, machineName: "", created: null, amount: null, currency: null, keyCount: 0, fileCount: 0, order });
    }
    const b = bundles.get(bundleId);
    b.order = Math.min(b.order, order);
    const choiceMonth = und(it.choiceDate) ? String(it.choiceDate).replace(/^\$D/, "").slice(0, 7) : null;

    const product = {
      id: it.id,
      gamekey: bundleId,
      bundle: bundleName,
      created: null,
      title: it.title,
      machineName: it.contentId || it.id,
      publisher: null,
      icon: null,
      url: `${SITE}/home/library/content/${it.id}`,
      platforms: [...new Set((it.entitlements?.downloads || []).map((d) => d.platform).filter(Boolean))],
      fileCount: 0,
      keyCount: 0,
      links: [],
      linksText: null,
      steamAppId: null,
      choiceMonth,
      v2: true,
    };
    products.push(product);

    for (const k of it.entitlements?.keys || []) {
      const status = keyStatus(k);
      const expiry = und(k.unavailableAfter) || und(k.redemptionExpiryDate);
      keys.push({
        id: `v2|${k.id}`,
        gamekey: bundleId,
        bundle: bundleName,
        created: und(k.redeemedAt),
        name: k.title || it.title,
        machineName: it.contentId || it.id,
        keyindex: 0,
        keyType: k.keyIntegrationId || k.type || "",
        key: status === "revealed" ? und(k.redemptionData?.keyFormatted) : null,
        status,
        expired: status === "expired",
        soldOut: status === "sold-out",
        gift: k.giftStatus && k.giftStatus !== "unassigned",
        steamAppId: null,
        instructions: lib.htmlToText ? lib.htmlToText(k.instructionsHtml) : null,
        expiry,
        daysLeft: status === "unused" ? daysUntil(expiry) : null,
        notGiftable: !!k.notGiftable,
        contentUrl: product.url,
        v2: true,
      });
      product.keyCount += 1;
      b.keyCount += 1;
    }

    for (const ent of it.entitlements?.downloads || []) {
      const signed = signedUrlLookup(ent.signedUrls);
      for (const { d, st } of downloadStructs(ent)) {
        const web = st.url?.web || "";
        const webName = web ? decodeURIComponent(path.posix.basename(web.split("?")[0])) : "";
        const fname = lib.safeName(webName || `${it.contentId || it.id}-${st.name || d.platform}`, 120);
        let rel = path.join(lib.safeName(bundleName), lib.safeName(it.title), naming === "title" ? lib.safeName(`${it.title}${path.extname(fname)}`, 120) : fname);
        if (usedDest.has(rel.toLowerCase())) rel = path.join(path.dirname(rel), lib.safeName(d.platform || "other"), path.basename(rel));
        usedDest.add(rel.toLowerCase());
        const id = shortHash(`v2|${it.id}|${d.platform}|${st.id || st.name}|${fname}`);
        // The signed (ready-to-download) link: matched by struct id, file
        // name or checksum; or the web url itself if it's already absolute.
        const url =
          signed.get(String(st.id)) || signed.get(webName) || (st.md5 && signed.get(st.md5)) || (/^https?:\/\//.test(web) ? web : null);
        const hash = st.md5 || st.sha1 || null;
        const duplicateOf = hash && firstByHash.has(hash) ? firstByHash.get(hash) : null;
        if (hash && !duplicateOf) firstByHash.set(hash, id);
        let onDisk = -1;
        try {
          onDisk = fs.statSync(path.join(downloadDir, rel)).size;
        } catch {
          // not downloaded
        }
        files.push({
          id,
          gamekey: bundleId,
          bundle: bundleName,
          product: it.title,
          productMachine: it.contentId || it.id,
          publisher: null,
          platform: d.platform || "other",
          format: st.name || "",
          filename: path.basename(rel),
          rel,
          url,
          size: st.fileSize || 0,
          humanSize: st.size || "",
          md5: st.md5 || null,
          sha1: st.md5 ? null : st.sha1 || null,
          downloadable: !!url,
          notDownloadableReason: url ? null : "Humble didn't include a download link for this file in the library data",
          duplicateOf,
          downloaded: onDisk >= 0 && (downloaded.has(id) || (st.fileSize ? onDisk === st.fileSize : false)),
          contentUrl: product.url,
          itemId: it.id, // for refreshing an expired signed link
          v2: true,
        });
        product.fileCount += 1;
        b.fileCount += 1;
      }
    }
  });

  const bundleList = [...bundles.values()].sort((a, b) => a.order - b.order);
  return { bundles: bundleList, keys, files, products, source: "v2" };
}

module.exports = {
  LIBRARY_ACTION_ARGS,
  loadCache,
  saveCache,
  libraryFields,
  actionCallScript,
  parseLibraryResponse,
  buildIndexV2,
  downloadStructs,
  shapeOnly,
};

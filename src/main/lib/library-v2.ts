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
//
// Items, keys and download entitlements are untyped external data (decoded
// RSC rows), so they are `any` throughout.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths";
import { resolvedFlightData } from "./rsc";
import * as lib from "./library";
import { monthFromText } from "./harvest";
import type { Bundle, ChoiceGroup, FileEntry, KeyEntry, KeyStatus, LibraryIndex, Naming, Product } from "../../shared/types";

const CACHE_PATH = path.join(DATA_DIR, "library-v2.json");
const SITE = "https://www.humblebundle.com";
// Argument names that identify the library-listing action in the registry.
export const LIBRARY_ACTION_ARGS = ["limit", "page", "sort", "query"];

const und = (v: any): any => (v === "$undefined" || v === undefined ? null : v);
const shortHash = (s: string): string => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// ---- cache ------------------------------------------------------------------

// The cache file's contents are whatever the caller saved (untyped here).
export function loadCache(): any {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function saveCache(cache: unknown): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_PATH);
}

// ---- calling the action -----------------------------------------------------

// Form fields for one page; values mirror what the site itself sends.
export function libraryFields({ page, limit, requestId, query = "" }: { page: number; limit: number; requestId: string | number; query?: string }): [string, string][] {
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
export function actionCallScript(actionId: string, pagePath: string, fields: [string, string][]): string {
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
export function parseLibraryResponse(text: unknown): any {
  return resolvedFlightData(text).find((v) => v && Array.isArray(v.results) && v.pagination) || null;
}

// ---- items -> Humbler's index ------------------------------------------------

// A download entitlement's file list, whatever shape it takes once RSC
// references are resolved. As seen on item pages it's
// [{ platform, downloadStruct: [{ id, name, md5, sha1, fileSize, size, url: { web } }] }];
// also accept a bare struct list or an object keyed by platform.
export function downloadStructs(ent: any): { d: any; st: any }[] {
  let groups = ent.downloads;
  if (!groups && ent.signedUrls) return structsFromSignedUrls(ent.signedUrls);
  if (groups && !Array.isArray(groups) && typeof groups === "object") groups = Object.values(groups);
  if (!Array.isArray(groups)) return [];
  const out: { d: any; st: any }[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    if (Array.isArray(g.downloadStruct)) for (const st of g.downloadStruct) out.push({ d: g, st });
    else if (g.url || g.md5) out.push({ d: { platform: g.platform || ent.platform }, st: g });
  }
  return out;
}

// ---- download links (getSignedUrlsForEntitlements) -------------------------
//
// The 2026 library listing leaves `downloads` and `signedUrls` null; the
// site's Download button calls the getSignedUrlsForEntitlements action with
// [entitlementId] and gets { ok, data: { signedUrls, expiresAt } }, where
// signedUrls[productMachineName][downloadKey][fileName] = a signed URL.
// Sync fetches that for each download entitlement and stores it on the
// entitlement; the file list is built from it.

export const SIGNED_URLS_ACTION = "getSignedUrlsForEntitlements";

const platformOfKey = (k: string): string => {
  const s = k.toLowerCase();
  if (/win/.test(s)) return "windows";
  if (/mac|osx/.test(s)) return "mac";
  if (/linux|deb|rpm/.test(s)) return "linux";
  if (/android|apk/.test(s)) return "android";
  if (/ebook|pdf|epub|mobi|cbz|book/.test(s)) return "ebook";
  if (/audio|mp3|flac|wav|ogg|soundtrack/.test(s)) return "audio";
  if (/video|mp4|mkv/.test(s)) return "video";
  return s || "other";
};
const formatOfName = (name: string): string => (path.extname(name).slice(1) || "file").toUpperCase();

/** Files described by a signedUrls value: [product][downloadKey][fileName] -> url. */
export function structsFromSignedUrls(su: any): { d: any; st: any }[] {
  const out: { d: any; st: any }[] = [];
  if (!su || typeof su !== "object") return out;
  const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);
  const nameOf = (u: string): string => {
    try {
      return decodeURIComponent(path.posix.basename(new URL(u).pathname));
    } catch {
      return "";
    }
  };
  for (const [machine, byKey] of Object.entries<any>(su)) {
    if (!byKey || typeof byKey !== "object") continue;
    for (const [dkey, byName] of Object.entries<any>(byKey)) {
      const entries: [string, string][] = isUrl(byName)
        ? [[nameOf(byName), byName]]
        : byName && typeof byName === "object"
          ? Object.entries<any>(byName).filter((e): e is [string, string] => isUrl(e[1]))
          : [];
      for (const [fileName, url] of entries) {
        out.push({
          d: { platform: platformOfKey(dkey) },
          st: { id: `${machine}/${dkey}/${fileName}`, name: formatOfName(fileName), fileName, url: { web: url } },
        });
      }
    }
  }
  return out;
}

/** Source for executeJavaScript: call a server action with JSON arguments (as the site does). */
export function jsonActionCallScript(actionId: string, pagePath: string, args: unknown[]): string {
  return `
    (async () => {
      const r = await fetch(${JSON.stringify(pagePath)}, {
        method: "POST",
        credentials: "include",
        headers: { "Next-Action": ${JSON.stringify(actionId)}, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" },
        body: ${JSON.stringify(JSON.stringify(args))},
      });
      return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
    })()
  `;
}

/** The getSignedUrlsForEntitlements reply: { ok, data: { signedUrls, expiresAt } }. */
export function parseSignedUrlsReply(text: unknown): { ok: boolean; signedUrls: any; expiresAt: string | null } | null {
  const v = resolvedFlightData(text).find((x) => x && typeof x === "object" && "ok" in x && ("data" in x || "error" in x));
  if (!v) return null;
  return { ok: !!v.ok, signedUrls: v.data?.signedUrls ?? null, expiresAt: und(v.data?.expiresAt) ?? null };
}

/** Keep download links already fetched for entitlements of re-synced items. */
export function carryOverDownloadLinks(fresh: any[], known: Map<string, any>): void {
  for (const it of fresh) {
    const old = known.get(it.id);
    if (!old) continue;
    const oldEnts = new Map<string, any>((old.entitlements?.downloads || []).map((e: any) => [e.id, e]));
    for (const ent of it.entitlements?.downloads || []) {
      const o = oldEnts.get(ent.id);
      if (!o?.signedUrlsFetchedAt || ent.signedUrls) continue;
      ent.signedUrls = o.signedUrls;
      ent.signedUrlsExpiresAt = o.signedUrlsExpiresAt;
      ent.signedUrlsFetchedAt = o.signedUrlsFetchedAt;
    }
  }
}

// Map of every absolute URL inside a signedUrls value, keyed every way a
// file might be matched: property name, its parent's id/name, and the
// URL's file name.
function signedUrlLookup(su: any): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (v: any, key: string | number | null, parent: any): void => {
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
export function shapeOnly(v: any, depth = 0): any {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? [shapeOnly(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).slice(0, 25).map((k) => [k, shapeOnly(v[k], depth + 1)]));
  return v === null ? "null" : typeof v;
}

const PLATFORM_NAMES: [RegExp, string][] = [
  [/epic/, "Epic Games Store"],
  [/gog/, "GOG.com"],
  [/blizzard|battle/, "Battle.net"],
  [/uplay|ubisoft/, "Ubisoft Connect"],
  [/origin|ea_app/, "EA app"],
  [/steam/, "Steam"],
];
const platformName = (type: string): string | null => PLATFORM_NAMES.find(([re]) => re.test(type))?.[1] || null;

/**
 * Keys Humble redeems to your account itself, so there's nothing for you to
 * activate: "keyless" Epic/GOG/Battle.net items (their "key" is Humble's
 * redemption code, or a sentence like "Redeemed to Epic Games Account …"),
 * Ubisoft direct redeems, and anything claimed with no key at all.
 */
function autoRedeemed(k: any): { at: string; platform: string | null; auto: true; account: string | null } | null {
  const type = String(k.keyIntegrationId || k.type || "").toLowerCase();
  const value = und(k.redemptionData?.keyFormatted);
  const at = und(k.redeemedAt);
  const account = und(k.redemptionData?.externalAccountName) || null;
  const completed = und(k.redemptionData?.externalOrderStatus) === "completed";
  if (k.giftStatus && k.giftStatus !== "unassigned") return null;
  const keyless = /_keyless$/.test(type);
  if ((keyless && (value || at || completed || account)) || (k.directRedeem === true && at) || (at && !value)) {
    return { at: at || "", platform: platformName(type), auto: true, account };
  }
  return null;
}

function keyStatus(k: any): KeyStatus {
  const revealed = !!(und(k.redemptionData?.keyFormatted) || und(k.redeemedAt));
  if (k.giftStatus && k.giftStatus !== "unassigned") return "gifted";
  if (revealed) return "revealed";
  if (k.expired) return "expired";
  if (k.outOfStock) return "sold-out";
  return "unused";
}

function daysUntil(iso: string | null | undefined): number | null {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
}

export function buildIndexV2(items: any[], { downloadDir, naming = "original" }: { downloadDir: string; naming?: Naming }): LibraryIndex {
  const downloaded = new Set<string>();
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

  const revealedLog = lib.loadRevealedOverlay();
  const bundles = new Map<string, Bundle & { itemCount: number; unrevealed: number; order: number }>();
  const keys: KeyEntry[] = [];
  const files: FileEntry[] = [];
  const products: Product[] = [];
  const usedDest = new Set<string>();
  const firstByHash = new Map<string, string>();

  // Items come newest first ("mostRecent"); walk oldest first so duplicates
  // point at the earliest copy, like the legacy index.
  const ordered = [...items].reverse();
  const choiceGroups: ChoiceGroup[] = [];
  ordered.forEach((it, i) => {
    // "entitlement-group" items are containers with no content of their own
    // (seen: "January 2022 Humble Choice" ... with empty entitlements). Keep
    // them as Choice months, not as library items.
    if (it.itemType === "entitlement-group") {
      const month = monthFromText(it.title);
      if (month) choiceGroups.push({ id: it.id, title: it.title, month });
      return;
    }
    const bundleId = it.productEntitlementId || it.id;
    const bundleName = und(it.subTitle) || it.title;
    const order = ordered.length - i; // recency rank, newest = 1
    // Choice/Monthly games: their bundle is named "<Month Year> Humble Choice".
    const choiceMonth: string | null =
      (und(it.choiceDate) ? String(it.choiceDate).replace(/^\$D/, "").slice(0, 7) : null) ||
      (/humble (choice|monthly)/i.test(bundleName) ? monthFromText(bundleName) : null);
    if (!bundles.has(bundleId)) {
      bundles.set(bundleId, {
        gamekey: bundleId,
        name: bundleName,
        machineName: "",
        created: null,
        amount: null,
        currency: null,
        keyCount: 0,
        fileCount: 0,
        itemCount: 0,
        unrevealed: 0,
        choiceMonth,
        order,
      });
    }
    const b = bundles.get(bundleId)!;
    b.order = Math.min(b.order, order);
    b.itemCount += 1;

    const product: Product & { url: string } = {
      id: it.id,
      gamekey: bundleId,
      bundle: bundleName,
      created: null,
      title: it.title,
      machineName: it.contentId || it.id,
      publisher: null,
      icon: null,
      // Items with nothing left to act on (every key expired unrevealed,
      // gifted or sold out: redeemable false; no downloads) have no item
      // page ("The page you requested cannot be found"); their purchase does.
      url:
        (it.entitlements?.keys || []).length && (it.entitlements?.keys || []).every((k: any) => k.redeemable === false) && !(it.entitlements?.downloads || []).length
          ? `${SITE}/home/library/${bundleId}`
          : `${SITE}/home/library/content/${it.id}`,
      platforms: [...new Set<string>((it.entitlements?.downloads || []).flatMap((e: any) => downloadStructs(e).map(({ d }) => d.platform)).filter(Boolean))],
      fileCount: 0,
      keyCount: 0,
      links: [],
      linksText: null,
      steamAppId: null,
      choiceMonth,
      v2: true,
    };
    products.push(product);

    for (const raw of it.entitlements?.keys || []) {
      // A key in revealed-keys.jsonl is revealed, whatever the cache says
      // (e.g. picked up live and then overwritten by an older Sync page).
      const logged = revealedLog.get(`v2|${raw.id}`);
      const k = logged && !und(raw.redemptionData?.keyFormatted) ? { ...raw, redemptionData: { ...(raw.redemptionData || {}), keyFormatted: logged } } : raw;
      const status = keyStatus(k);
      const auto = status === "revealed" ? autoRedeemed(k) : null;
      // "Redeemed to Epic Games Account …" is a message, not a code
      const rawKey = status === "revealed" ? und(k.redemptionData?.keyFormatted) : null;
      const keyValue = auto && rawKey && /\s/.test(rawKey) ? null : rawKey;
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
        key: keyValue,
        autoRedeemed: auto,
        status,
        expired: status === "expired",
        soldOut: status === "sold-out",
        gift: !!(k.giftStatus && k.giftStatus !== "unassigned"),
        steamAppId: null,
        // NOTE(port): the original guarded this with `lib.htmlToText ? ... : null`;
        // htmlToText is always exported, so the guard was always true and is dropped.
        instructions: lib.htmlToText(k.instructionsHtml),
        instructionLinks: lib.linksIn(k.instructionsHtml), // opened in your browser
        expiry,
        daysLeft: status === "unused" ? daysUntil(expiry) : null,
        notGiftable: !!k.notGiftable,
        contentUrl: product.url,
        choiceMonth,
        itemId: it.id,
        v2: true,
      });
      product.keyCount += 1;
      b.keyCount += 1;
      if (status === "unused") b.unrevealed += 1;
    }

    for (const ent of it.entitlements?.downloads || []) {
      const signed = signedUrlLookup(ent.signedUrls);
      for (const { d, st } of downloadStructs(ent)) {
        const web: string = st.url?.web || "";
        const webName = st.fileName || (web ? decodeURIComponent(path.posix.basename(web.split("?")[0])) : "");
        const fname = lib.safeName(webName || `${it.contentId || it.id}-${st.name || d.platform}`, 120);
        let rel = path.join(lib.safeName(bundleName), lib.safeName(it.title), naming === "title" ? lib.safeName(`${it.title}${path.extname(fname)}`, 120) : fname);
        if (usedDest.has(rel.toLowerCase())) rel = path.join(path.dirname(rel), lib.safeName(d.platform || "other"), path.basename(rel));
        usedDest.add(rel.toLowerCase());
        const id = shortHash(`v2|${it.id}|${d.platform}|${st.id || st.name}|${fname}`);
        // The signed (ready-to-download) link: matched by struct id, file
        // name or checksum; or the web url itself if it's already absolute.
        const url =
          signed.get(String(st.id)) || signed.get(webName) || (st.md5 && signed.get(st.md5)) || (/^https?:\/\//.test(web) ? web : null);
        const hash: string | null = st.md5 || st.sha1 || null;
        const duplicateOf = hash && firstByHash.has(hash) ? (firstByHash.get(hash) as string) : null;
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
          choiceMonth,
          itemId: it.id, // for refreshing an expired signed link
          entitlementId: ent.id,
          urlExpiresAt: und(ent.signedUrlsExpiresAt) ?? null,
          machineName: typeof st.id === "string" && st.id.includes("/") ? st.id.split("/")[0] : null,
          v2: true,
        });
        product.fileCount += 1;
        b.fileCount += 1;
      }
    }
  });

  const bundleList = [...bundles.values()].sort((a, b) => a.order - b.order);
  // Built oldest-first (so duplicates point at the earliest copy); present
  // newest-first, like Humble's own keys page.
  keys.reverse();
  files.reverse();
  choiceGroups.sort((a, b) => b.month.localeCompare(a.month));
  return { bundles: bundleList, keys, files, products, choiceGroups, source: "v2" };
}

// Local cache of raw order JSON (data/orders/<gamekey>.json) and the flat
// key / file / product index the UI works from. The raw orders are the source
// of truth; the index is rebuilt from them whenever anything changes.
//
// The index covers what Humble Librarian collected: every owned product
// (including "links-only" items with no file or key), publisher, icon,
// key status (unused / revealed / gifted / expired), redeem instructions,
// expiry, and purchase date/total.
//
// Raw orders (legacy /api/v1 order JSON) are untyped external data, so they
// are `any` throughout.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ORDERS_DIR, REVEALED_LOG, DOWNLOADED_INDEX } from "./paths";
import * as secrets from "./secret-store";
import type { Bundle, ChoiceGroup, FileEntry, KeyEntry, KeyStatus, LibraryIndex, Naming, Product } from "../../shared/types";

/**
 * The legacy index. It has never carried choiceGroups (only the 2026-site
 * index does), so that field is optional here rather than an empty array.
 */
export type LegacyLibraryIndex = Omit<LibraryIndex, "choiceGroups"> & { choiceGroups?: ChoiceGroup[] };

// ---- filesystem-safe names (Windows rules are the strictest) ------------

export function safeName(input: unknown, max = 80): string {
  let s = String(input || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max).trim();
  s = s.replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s || "untitled";
}

function splitExt(name: string): [string, string] {
  const m = /(\.tar\.(?:gz|bz2|xz)|\.[A-Za-z0-9]{1,6})$/.exec(name);
  return m ? [name.slice(0, -m[1].length), m[1]] : [name, ""];
}

function safeFilename(name: string, max = 120): string {
  const [stem, ext] = splitExt(name);
  return safeName(stem, max - ext.length) + ext.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function filenameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const base = path.posix.basename(new URL(url).pathname);
    return base ? safeFilename(decodeURIComponent(base)) : null;
  } catch {
    return null;
  }
}

const shortHash = (s: string): string => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export function htmlToText(html: unknown): string | null {
  if (!html || typeof html !== "string") return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** The links in a bit of HTML (e.g. redeem instructions), with their text. */
export function linksIn(html: unknown): { href: string; text: string }[] {
  if (!html || typeof html !== "string") return [];
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .filter((m) => /^https?:/i.test(m[1]))
    .map((m) => ({ href: m[1], text: htmlToText(m[2]) || m[1] }));
}

function hrefsIn(html: string | null): string[] {
  if (!html || typeof html !== "string") return [];
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter((u) => /^https?:/i.test(u));
}

// First non-empty string field whose name matches `re` (field names vary
// between Humble API generations, so match loosely).
function fieldLike(obj: any, re: RegExp): string | null {
  for (const [k, v] of Object.entries(obj || {})) if (re.test(k) && typeof v === "string" && v.trim()) return v;
  return null;
}

// "Title Of Thing™: Deluxe" -> "title of thing deluxe", for matching titles across sources.
export function normTitle(s: unknown): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();
}

// ---- order cache ---------------------------------------------------------

function orderPath(gamekey: string): string {
  return path.join(ORDERS_DIR, `${safeName(gamekey, 100)}.json`);
}

export function saveOrder(order: any): void {
  fs.mkdirSync(ORDERS_DIR, { recursive: true });
  const tmp = orderPath(order.gamekey) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(order, null, 2));
  fs.renameSync(tmp, orderPath(order.gamekey));
}

export function loadOrder(gamekey: string): any {
  try {
    return JSON.parse(fs.readFileSync(orderPath(gamekey), "utf8"));
  } catch {
    return null;
  }
}

export function orderAgeMs(gamekey: string): number {
  try {
    return Date.now() - fs.statSync(orderPath(gamekey)).mtimeMs;
  } catch {
    return Infinity;
  }
}

export function loadAllOrders(): any[] {
  if (!fs.existsSync(ORDERS_DIR)) return [];
  const orders: any[] = [];
  for (const f of fs.readdirSync(ORDERS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      orders.push(JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), "utf8")));
    } catch {
      // skip corrupt cache file; next full refresh replaces it
    }
  }
  return orders;
}

export function cachedGamekeys(): Set<string> {
  if (!fs.existsSync(ORDERS_DIR)) return new Set();
  return new Set(
    fs
      .readdirSync(ORDERS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5)),
  );
}

// ---- jsonl records -------------------------------------------------------

function appendJsonl(file: string, entry: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// The key value is sealed on disk (see secret-store).
export const recordRevealedKey = (entry: Record<string, unknown>): void =>
  appendJsonl(REVEALED_LOG, typeof entry.key === "string" ? { ...entry, key: secrets.seal(entry.key) } : entry);

/** Seal any plain key values left in the revealed-keys log (from before
 *  sealing existed). Returns how many were sealed. */
export function sealRevealedLog(): number {
  if (!secrets.canSeal() || !fs.existsSync(REVEALED_LOG)) return 0;
  let n = 0;
  const lines = fs.readFileSync(REVEALED_LOG, "utf8").split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      const e = JSON.parse(line);
      if (typeof e.key !== "string" || secrets.isSealed(e.key)) return line;
      n += 1;
      return JSON.stringify({ ...e, key: secrets.seal(e.key) });
    } catch {
      return line;
    }
  });
  if (n) {
    fs.writeFileSync(`${REVEALED_LOG}.tmp`, lines.join("\n"));
    fs.renameSync(`${REVEALED_LOG}.tmp`, REVEALED_LOG);
  }
  return n;
}
export const recordDownloaded = (entry: Record<string, unknown>): void => appendJsonl(DOWNLOADED_INDEX, entry);

/** id -> the size it actually had when downloaded (Humble's listing can be
 *  out of date: a file updated on the CDN without its listed size changing). */
export function downloadedSizes(): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of readJsonl(DOWNLOADED_INDEX)) if (e.id && typeof e.size === "number" && e.size > 0) map.set(e.id, e.size);
  return map;
}

// id -> relative path it was saved under (naming scheme may have changed since)
function loadDownloaded(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const e of readJsonl(DOWNLOADED_INDEX)) if (e.id) map.set(e.id, e.rel || null);
  return map;
}

// Keys revealed by Humbler whose order cache hasn't been refreshed since:
// overlay them so a revealed key can never "disappear" from the UI.
export function loadRevealedOverlay(): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of readJsonl(REVEALED_LOG)) {
    const key = secrets.open(e.key);
    if (e.id && typeof key === "string" && key) map.set(e.id, key);
  }
  return map;
}

// ---- keys ----------------------------------------------------------------

export const keyId = (gamekey: string, tpk: any): string => `${gamekey}|${tpk.machine_name}|${tpk.keyindex ?? 0}`;

// unused | revealed | gifted | link | expired | sold-out
function keyStatus(tpk: any, value: any): KeyStatus {
  const isUrl = typeof value === "string" && /^https?:\/\//i.test(value.trim());
  if (value && !isUrl) return "revealed";
  if (isUrl) return tpk.is_gift || /gift/i.test(value) ? "gifted" : "link";
  if (tpk.is_gift) return "gifted";
  if (tpk.is_expired) return "expired";
  if (tpk.sold_out) return "sold-out";
  return "unused";
}

// ---- downloads naming ----------------------------------------------------

// "original": <bundle>/<product>/<Humble's file name>
// "title":    <bundle>/<product>/<Product> - <Publisher>.<ext>  (like Humble Bundle Downloader)
function fileRelPath({ naming, bundleDir, sp, dl, st, cdnName }: { naming: Naming; bundleDir: string; sp: any; dl: any; st: any; cdnName: string }): string {
  const productDir = safeName(sp.human_name || sp.machine_name);
  if (naming !== "title") return path.join(bundleDir, productDir, cdnName);
  const [, ext] = splitExt(cdnName);
  const publisher = sp.payee?.human_name;
  const base = publisher && publisher !== sp.human_name ? `${sp.human_name} - ${publisher}` : sp.human_name || sp.machine_name;
  return path.join(bundleDir, productDir, safeFilename(`${base}${ext}`));
}

// ---- the flat index ------------------------------------------------------

export function buildIndex(orders: any[], { downloadDir, naming = "original" }: { downloadDir: string; naming?: Naming }): LegacyLibraryIndex {
  const downloaded = loadDownloaded();
  const revealed = loadRevealedOverlay();
  const bundles: Bundle[] = [];
  const keys: KeyEntry[] = [];
  const files: FileEntry[] = [];
  const products: Product[] = [];
  const usedDest = new Set<string>();
  const firstByHash = new Map<string, string>();

  const exists = (rel: string): number => {
    try {
      return fs.statSync(path.join(downloadDir, rel)).size;
    } catch {
      return -1;
    }
  };

  // Oldest first, so a file that appears in several bundles is "owned" by
  // the first bundle you got it in and the later copies are the duplicates.
  const sorted = [...orders].sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));

  for (const order of sorted) {
    const gamekey = order.gamekey;
    const bundleName = order.product?.human_name || gamekey;
    const bundleMachine = order.product?.machine_name || "";
    const bundleDir = safeName(bundleName);
    const created = order.created || null;
    let keyCount = 0;
    let fileCount = 0;
    const tpks = order.tpkd_dict?.all_tpks || [];
    const productByTitle = new Map<string, Product>();

    for (const sp of order.subproducts || []) {
      const title = sp.human_name || sp.machine_name;
      const linksHtml = fieldLike(sp, /custom.*html|html.*box/i);
      const product: Product = {
        id: `${gamekey}|${sp.machine_name}`,
        gamekey,
        bundle: bundleName,
        created,
        title,
        machineName: sp.machine_name,
        publisher: sp.payee?.human_name || null,
        icon: sp.icon || null,
        url: sp.url || null,
        platforms: [...new Set<string>((sp.downloads || []).map((d: any) => d.platform).filter(Boolean))],
        fileCount: 0,
        keyCount: 0,
        links: hrefsIn(linksHtml),
        linksText: htmlToText(linksHtml),
        steamAppId: null,
      };
      products.push(product);
      productByTitle.set(normTitle(title), product);

      for (const dl of sp.downloads || []) {
        for (const st of dl.download_struct || []) {
          const url: string | null = st.url?.web || null;
          const cdnName = filenameFromUrl(url) || safeFilename(`${sp.machine_name}-${st.name || dl.platform}`);
          let rel = fileRelPath({ naming, bundleDir, sp, dl, st, cdnName });
          if (usedDest.has(rel.toLowerCase())) {
            const [stem, ext] = splitExt(path.basename(rel));
            rel = path.join(path.dirname(rel), safeFilename(`${stem} (${dl.platform}${st.name ? `, ${st.name}` : ""})${ext}`));
          }
          if (usedDest.has(rel.toLowerCase())) rel = path.join(path.dirname(rel), safeName(dl.platform || "other"), cdnName);
          usedDest.add(rel.toLowerCase());

          const id = shortHash(`${gamekey}|${sp.machine_name}|${dl.platform}|${st.name}|${cdnName}`);
          const hash: string | null = st.md5 || st.sha1 || null;
          const duplicateOf = hash && firstByHash.has(hash) ? (firstByHash.get(hash) as string) : null;
          if (hash && !duplicateOf) firstByHash.set(hash, id);

          const size = exists(rel);
          const prevRel = downloaded.get(id);
          const isDownloaded =
            (size >= 0 && (downloaded.has(id) || (st.file_size ? size === st.file_size : false))) ||
            (prevRel && prevRel !== rel && exists(prevRel) >= 0);

          files.push({
            id,
            gamekey,
            bundle: bundleName,
            product: title,
            productMachine: sp.machine_name,
            publisher: product.publisher,
            platform: dl.platform || "other",
            format: st.name || "",
            filename: path.basename(rel),
            rel: isDownloaded && prevRel && exists(rel) < 0 ? prevRel : rel,
            url,
            size: st.file_size || 0,
            humanSize: st.human_size || "",
            md5: st.md5 || null,
            sha1: st.md5 ? null : st.sha1 || null,
            downloadable: !!url,
            duplicateOf,
            downloaded: !!isDownloaded,
          });
          product.fileCount += 1;
          fileCount += 1;
        }
      }
    }

    for (const tpk of tpks) {
      const id = keyId(gamekey, tpk);
      const value = tpk.redeemed_key_val || revealed.get(id) || null;
      const name = tpk.human_name || tpk.machine_name;
      const status = keyStatus(tpk, value);
      const instructionsHtml = fieldLike(tpk, /instruction/i);
      const instructions = htmlToText(instructionsHtml);
      const expiry = tpk.expiry_date || tpk.expiration_date || fieldLike(tpk, /expir/i) || null;
      const daysLeft = typeof tpk.num_days_until_expired === "number" ? tpk.num_days_until_expired : null;
      keys.push({
        id,
        gamekey,
        bundle: bundleName,
        created,
        name,
        machineName: tpk.machine_name,
        keyindex: tpk.keyindex ?? 0,
        keyType: tpk.key_type_human_name || tpk.key_type || "",
        key: value,
        status,
        expired: status === "expired",
        soldOut: status === "sold-out",
        gift: !!tpk.is_gift,
        steamAppId: tpk.steam_app_id || null,
        instructions,
        instructionLinks: linksIn(instructionsHtml),
        expiry,
        daysLeft,
      });
      keyCount += 1;

      // Attach the key to its product; keys with no matching subproduct
      // become products of their own, so the Library tab lists everything.
      const product = productByTitle.get(normTitle(name));
      if (product) {
        product.keyCount += 1;
        product.steamAppId ||= tpk.steam_app_id || null;
      } else {
        const p: Product = {
          id: `${gamekey}|key|${tpk.machine_name}`,
          gamekey,
          bundle: bundleName,
          created,
          title: name,
          machineName: tpk.machine_name,
          publisher: null,
          icon: null,
          url: null,
          platforms: [],
          fileCount: 0,
          keyCount: 1,
          links: [],
          linksText: null,
          steamAppId: tpk.steam_app_id || null,
        };
        products.push(p);
        productByTitle.set(normTitle(name), p);
      }
    }

    bundles.push({
      gamekey,
      name: bundleName,
      machineName: bundleMachine,
      created,
      amount: order.amount_spent ?? order.total ?? null,
      currency: order.currency || null,
      keyCount,
      fileCount,
    });
  }

  bundles.reverse(); // newest first for the UI
  return { bundles, keys, files, products };
}

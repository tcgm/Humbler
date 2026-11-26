// What Humble is selling right now: every bundle on humblebundle.com/bundles
// and what's in each tier, so the UI can show what you already have (Humble
// library, Steam account), what's on wishlists, and what's new to you.
//
// Both are public pages (no login needed), fetched with the pane's session so
// they look like the browser to Cloudflare. The data is the RSC flight the
// 2026 site embeds:
//   /bundles:              feedItems[] { id, slug, url, title, category, thumbnail, endDate, displayPrice, itemsCount, ... }
//                          (includedItemTitles stops at 11, so it isn't the whole bundle)
//   /games|books|software/<slug>: bundlePage { tiers[] { price, totalMsrpValue, redeemableItems[] { sku, outOfKeys },
//                          bundleItems[] { id, title, deliveryMethods, platforms, msrp, thumbnailImageUrl, steamRating, tpkdSkus } } }
//                          A tier lists only what it adds: items from lower tiers are null there.
//
// data/store-bundles.json: { fetchedAt, error, bundles: StoreBundle[], known: [bundle id...],
//   watched: { "<bundle id>": { title, url, endDate, addedAt, notified: ["24h", ...] } } }
//   watchedGames: { "<exact title>": { title, addedAt, seenIn: [bundle id...] } } }
// `known` is every bundle seen so far (so a new one can be announced once);
// `watchedGames` are games you starred: `seenIn` the bundles already announced for each;
// `watched` outlives the bundle's sale, so its notifications aren't repeated.
import fs from "node:fs";
import path from "node:path";
import type { Session } from "electron";
import { fetchText } from "./http";
import { DATA_DIR } from "./paths";
import { flightFromHtml, resolvedFlightData } from "./rsc";
import { politeDelay } from "./throttle";
import { exactTitle, looseTitle } from "../../shared/titles";
import type { OkResult, StoreBundle, StoreInfo, StoreItem, StoreTier } from "../../shared/types";

const STORE_PATH = path.join(DATA_DIR, "store-bundles.json");
const BASE = "https://www.humblebundle.com";
const PAGE_MAX_AGE_MS = 24 * 3600_000; // tiers and sold-out keys can change during a bundle
const STALE_MS = 12 * 3600_000; // refreshed at startup when older than this

export interface WatchEntry {
  title: string;
  url: string;
  endDate: string | null;
  addedAt: string;
  /** ending notifications already sent ("24h", "1h", "10m") */
  notified: string[];
}

export interface WatchedGame {
  title: string;
  addedAt: string;
  /** bundles it was already found in (announced once each) */
  seenIn: string[];
}

interface StoreFile {
  watchedGames: Record<string, WatchedGame>;
  fetchedAt: string | null;
  error: string | null;
  bundles: StoreBundle[];
  known: string[];
  watched: Record<string, WatchEntry>;
}

/** What changed in a refresh: bundles new since the last one, and items added to watched bundles. */
export interface StoreChanges {
  added: StoreBundle[];
  grew: { bundle: StoreBundle; items: string[] }[];
}

function loadFile(): StoreFile {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      fetchedAt: d.fetchedAt ?? null,
      error: d.error ?? null,
      bundles: Array.isArray(d.bundles) ? d.bundles : [],
      // first run with this field: what's on sale now isn't "new"
      known: Array.isArray(d.known) ? d.known : Array.isArray(d.bundles) ? d.bundles.map((b: StoreBundle) => b.id) : [],
      watched: d.watched && typeof d.watched === "object" ? d.watched : {},
      watchedGames: d.watchedGames && typeof d.watchedGames === "object" ? d.watchedGames : {},
    };
  } catch {
    return { fetchedAt: null, error: null, bundles: [], known: [], watched: {}, watchedGames: {} };
  }
}

function saveFile(d: StoreFile): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, STORE_PATH);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Every object in a page's flight data that `pick` accepts. */
function findAll(html: string, pick: (o: any) => boolean): any[] {
  const out: any[] = [];
  const seen = new Set<unknown>();
  const walk = (o: any) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && pick(o)) out.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  resolvedFlightData(flightFromHtml(html)).forEach(walk);
  return out;
}

/** The bundles on /bundles (without their contents). */
export function parseFeed(html: string): StoreBundle[] {
  const byId = new Map<string, StoreBundle>();
  for (const f of findAll(html, (o) => typeof o.productKey === "string" && typeof o.url === "string" && "includedItemTitles" in o)) {
    if (!str(f.id) || byId.has(f.id)) continue;
    const cur = f.displayPrice?.currentPrice;
    byId.set(f.id, {
      id: f.id,
      slug: str(f.slug) || f.id,
      url: f.url.startsWith("http") ? f.url : BASE + f.url,
      title: str(f.title) || f.slug || f.id,
      category: str(f.category) || "other",
      image: str(f.thumbnail),
      endDate: str(f.endDate),
      startDate: null,
      price: cur && num(cur.centAmount) != null ? { amount: cur.centAmount / 10 ** (num(cur.fractionDigits) ?? 2), currency: str(cur.currencyCode) } : null,
      itemsCount: num(f.itemsCount),
      keyExpiration: null,
      preview: strs(f.includedItemTitles),
      tiers: [],
      items: null,
      fetchedAt: null,
      error: null,
    });
  }
  return [...byId.values()];
}

/** A bundle page's tiers and items. */
export function parseBundlePage(html: string): Pick<StoreBundle, "tiers" | "items" | "startDate" | "keyExpiration"> | null {
  const bp = findAll(html, (o) => o.bundlePage && Array.isArray(o.bundlePage.tiers))[0]?.bundlePage;
  if (!bp) return null;
  const tiers: StoreTier[] = [];
  const items: StoreItem[] = [];
  const seen = new Set<string>();
  bp.tiers.forEach((t: any, ti: number) => {
    tiers.push({ price: num(t?.price?.amount), currency: str(t?.price?.currencyCode), msrpTotal: num(t?.totalMsrpValue?.amount) });
    const out = new Set((Array.isArray(t?.redeemableItems) ? t.redeemableItems : []).filter((r: any) => r?.outOfKeys).map((r: any) => r.sku));
    for (const it of Array.isArray(t?.bundleItems) ? t.bundleItems : []) {
      if (!it || !str(it.title)) continue; // null: an item from a lower tier
      const id = str(it.id) || it.title;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        title: it.title.trim(),
        tier: ti,
        delivery: strs(it.deliveryMethods),
        platforms: strs(it.platforms),
        msrp: num(it?.msrp?.amount),
        image: str(it.thumbnailImageUrl),
        steamRating: num(it.steamRating),
        outOfKeys: strs(it.tpkdSkus).some((s) => out.has(s)) || undefined,
      });
    }
  });
  return { tiers, items, startDate: str(bp.startDate), keyExpiration: str(bp.keyExpirationDate) };
}

export class StoreBundles {
  private data = loadFile();
  private progress: { done: number; total: number } | null = null;

  constructor(private opts: { session: () => Session; log: (m: string) => void; onChange: () => void; onChanges?: (c: StoreChanges) => void }) {}

  view(): StoreInfo {
    return {
      fetchedAt: this.data.fetchedAt,
      error: this.data.error,
      refreshing: this.progress,
      bundles: this.data.bundles,
      watched: Object.keys(this.data.watched),
      watchedGames: Object.values(this.data.watchedGames).map((g) => ({ title: g.title, addedAt: g.addedAt })),
    };
  }

  /** Bundles on sale with this game (exact title, or but for edition words). */
  bundlesWith(title: string): StoreBundle[] {
    const e = exactTitle(title);
    const l = looseTitle(title);
    return this.data.bundles.filter((b) => (b.items ? b.items.map((i) => i.title) : b.preview).some((t) => exactTitle(t) === e || (!!l && looseTitle(t) === l)));
  }

  /** Star a game (notified when it's in a bundle on sale) or unstar it. */
  watchGame(title: string, on: boolean): void {
    const key = exactTitle(title);
    if (!key) return;
    if (on && !this.data.watchedGames[key]) {
      // bundles that have it now aren't news: only ones it turns up in later
      this.data.watchedGames[key] = { title, addedAt: new Date().toISOString(), seenIn: this.bundlesWith(title).map((b) => b.id) };
      this.opts.log(`On sale: starred ${title}.`);
    } else if (!on && this.data.watchedGames[key]) {
      delete this.data.watchedGames[key];
      this.opts.log(`On sale: unstarred ${title}.`);
    } else return;
    this.save();
  }

  /** Starred games found in a bundle not announced for them yet (and records them as announced). */
  takeGameFinds(): { game: string; bundle: StoreBundle }[] {
    const out: { game: string; bundle: StoreBundle }[] = [];
    for (const g of Object.values(this.data.watchedGames)) {
      for (const b of this.bundlesWith(g.title)) {
        if (g.seenIn.includes(b.id)) continue;
        g.seenIn.push(b.id);
        out.push({ game: g.title, bundle: b });
      }
    }
    if (out.length) saveFile(this.data);
    return out;
  }

  bundles(): StoreBundle[] {
    return this.data.bundles;
  }

  watchedEntries(): Record<string, WatchEntry> {
    return this.data.watched;
  }

  /** Watch a bundle (notifications as its end nears, and when it adds items) or stop. */
  watch(id: string, on: boolean): void {
    const b = this.data.bundles.find((x) => x.id === id);
    if (on && b && !this.data.watched[id]) {
      this.data.watched[id] = { title: b.title, url: b.url, endDate: b.endDate, addedAt: new Date().toISOString(), notified: [] };
      this.opts.log(`On sale: watching ${b.title}.`);
    } else if (!on && this.data.watched[id]) {
      this.opts.log(`On sale: stopped watching ${this.data.watched[id].title}.`);
      delete this.data.watched[id];
    } else return;
    this.save();
  }

  /** Record that a watched bundle's ending notification went out. */
  markNotified(id: string, what: string): void {
    const w = this.data.watched[id];
    if (!w || w.notified.includes(what)) return;
    w.notified.push(what);
    saveFile(this.data);
  }

  private save() {
    saveFile(this.data);
    this.opts.onChange();
  }

  private async get(url: string): Promise<string> {
    const r = await fetchText(this.opts.session(), { url, headers: { Accept: "text/html" } });
    if (r.status !== 200) throw new Error(`Humble answered HTTP ${r.status}`);
    return r.text;
  }

  /** The bundle list, then the contents of each bundle not fetched in the last day (`full`: every one). */
  async refresh({ full = false } = {}): Promise<OkResult> {
    if (this.progress) return { ok: true };
    this.progress = { done: 0, total: 0 };
    this.opts.onChange();
    try {
      const feed = parseFeed(await this.get(`${BASE}/bundles`));
      if (!feed.length) throw new Error("no bundles found on humblebundle.com/bundles (the page may have changed)");
      const old = new Map(this.data.bundles.map((b) => [b.id, b]));
      const firstRun = !this.data.known.length && !this.data.bundles.length;
      const known = new Set(this.data.known);
      // keep what's known about each bundle's contents; bundles that ended drop out
      this.data.bundles = feed.map((f) => {
        const o = old.get(f.id);
        return o ? { ...f, tiers: o.tiers, items: o.items, fetchedAt: o.fetchedAt, error: o.error, startDate: o.startDate, keyExpiration: o.keyExpiration } : f;
      });
      this.data.fetchedAt = new Date().toISOString();
      this.data.error = null;
      const now = Date.now();
      const todo = this.data.bundles.filter((b) => full || !b.items || !b.fetchedAt || now - Date.parse(b.fetchedAt) > PAGE_MAX_AGE_MS);
      this.progress = { done: 0, total: todo.length };
      this.save();
      let failed = 0;
      for (const b of todo) {
        try {
          const page = parseBundlePage(await this.get(b.url));
          if (!page) throw new Error("no bundle data on its page");
          Object.assign(b, page, { fetchedAt: new Date().toISOString(), error: null });
        } catch (err) {
          failed += 1;
          b.error = errMsg(err);
        }
        this.progress = { done: this.progress.done + 1, total: todo.length };
        this.save();
        await politeDelay(800, 1600);
      }
      // what changed, for notifications
      const changes: StoreChanges = { added: [], grew: [] };
      for (const b of this.data.bundles) {
        if (!known.has(b.id) && !firstRun) changes.added.push(b);
        known.add(b.id);
        const w = this.data.watched[b.id];
        if (w) {
          w.endDate = b.endDate; // Humble sometimes extends a bundle
          w.title = b.title;
          const before = old.get(b.id)?.items;
          if (before && b.items) {
            const had = new Set(before.map((i) => i.id));
            const added = b.items.filter((i) => !had.has(i.id)).map((i) => i.title);
            if (added.length) changes.grew.push({ bundle: b, items: added });
          }
        }
      }
      this.data.known = [...known].slice(-2000);
      this.save();
      this.opts.onChanges?.(changes); // (starred games are looked for after every refresh)
      this.opts.log(
        `On sale: ${feed.length} bundles on Humble${changes.added.length ? ` (${changes.added.length} new)` : ""}${todo.length ? `, read ${todo.length - failed} bundle page(s)` : ""}${failed ? ` (${failed} failed)` : ""}.`,
      );
      return failed ? { ok: false, reason: `${failed} bundle page(s) couldn't be read` } : { ok: true };
    } catch (err) {
      this.data.error = `Couldn't fetch Humble's bundles: ${errMsg(err)}`;
      this.opts.log(`On sale: ${this.data.error}`);
      return { ok: false, reason: this.data.error };
    } finally {
      this.progress = null;
      this.save();
    }
  }

  async refreshIfStale(): Promise<void> {
    const at = this.data.fetchedAt ? Date.parse(this.data.fetchedAt) : 0;
    if (Date.now() - at > STALE_MS) await this.refresh();
  }
}

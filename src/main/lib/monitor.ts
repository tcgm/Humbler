// Watching Humble: checks the bundles on sale every half hour while Humbler
// runs (in the notification area too, in Monitor Mode), and notifies you:
//   - a new bundle: always, or only when it has a game on a Steam wishlist
//     (yours or a friend's), or never (settings.notifyNew)
//   - a bundle you watch: as its end nears (24 h, 3 h, 1 h and 10 min before
//     its exact end), and when it adds items (settings.notifyWatched)
//   - a game you starred: when it turns up in a bundle on sale, once per
//     bundle (settings.notifyWatched)
// Clicking a notification opens the bundle in Humbler.
import { Notification } from "electron";
import { exactTitle, looseTitle } from "../../shared/titles";
import type { StoreBundle } from "../../shared/types";
import type { StoreBundles, StoreChanges } from "./store-bundles";

const CHECK_EVERY_MS = 30 * 60_000;
const TICK_MS = 15_000;
/** ending notifications for watched bundles, largest first */
export const ENDING = [
  { key: "24h", ms: 24 * 3600_000 },
  { key: "3h", ms: 3 * 3600_000 },
  { key: "1h", ms: 3600_000 },
  { key: "10m", ms: 10 * 60_000 },
];

export type NotifyNew = "off" | "wishlist" | "all";

export interface Wishers {
  /** whose wishlist ("you" for your own) */
  name: string;
  mine: boolean;
  titles: string[];
}

export interface MonitorDeps {
  store: StoreBundles;
  icon: string;
  settings: () => { notifyNew: NotifyNew; notifyWatched: boolean };
  /** titles you have: Humble library and Steam account */
  ownedTitles: () => string[];
  wishlists: () => Wishers[];
  /** show Humbler on this On Sale bundle */
  open: (bundleId: string) => void;
  log: (m: string) => void;
}

/** "in 2 days 4 h", "in 58 min" */
function inText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `in ${Math.floor(h / 24)} days ${h % 24} h`;
}

const exactEnd = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export class Monitor {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // kept referenced, or Windows can drop the click handler with the object
  private shown = new Set<Notification>();

  constructor(private d: MonitorDeps) {}

  start(): void {
    this.checkTimer = setInterval(() => void this.d.store.refresh(), CHECK_EVERY_MS);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** Watch a bundle (or stop); ending notifications already past aren't sent late. */
  watch(id: string, on: boolean): void {
    this.d.store.watch(id, on);
    if (!on) return;
    const w = this.d.store.watchedEntries()[id];
    const left = (Date.parse(w?.endDate || "") || Infinity) - Date.now();
    // already inside a threshold (10 h left skips "24h"): the next one is the first you hear of
    for (const t of ENDING) if (left <= t.ms) this.d.store.markNotified(id, t.key);
  }

  notify(title: string, body: string, bundleId?: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: this.d.icon });
    this.shown.add(n);
    const drop = () => this.shown.delete(n);
    n.on("click", () => {
      drop();
      if (bundleId) this.d.open(bundleId);
    });
    n.on("close", drop);
    n.show();
    this.d.log(`Notification: ${title}`);
  }

  /** What a bundle holds for you: wishlist games, and how much is new. */
  interest(b: StoreBundle): { wished: { title: string; who: string[] }[]; fresh: number; total: number } {
    const owned = new Set<string>();
    const ownedLoose = new Set<string>();
    for (const t of this.d.ownedTitles()) {
      owned.add(exactTitle(t));
      const l = looseTitle(t);
      if (l) ownedLoose.add(l);
    }
    const lists = this.d.wishlists().map((w) => ({ ...w, exact: new Set(w.titles.map(exactTitle)), loose: new Set(w.titles.map(looseTitle).filter(Boolean)) }));
    const titles = b.items ? b.items.map((i) => i.title) : b.preview;
    const wished: { title: string; who: string[] }[] = [];
    let fresh = 0;
    for (const t of titles) {
      const e = exactTitle(t);
      const l = looseTitle(t);
      const have = owned.has(e) || (!!l && ownedLoose.has(l));
      if (!have) fresh += 1;
      const who = lists.filter((w) => w.exact.has(e) || (!!l && w.loose.has(l))).map((w) => w.name);
      if (who.length && !have) wished.push({ title: t, who });
    }
    return { wished, fresh, total: b.items ? b.items.length : (b.itemsCount ?? titles.length) };
  }

  /** After a refresh: new bundles, and watched bundles that added items. */
  onChanges(c: StoreChanges): void {
    const s = this.d.settings();
    if (s.notifyNew !== "off") {
      for (const b of c.added) {
        const i = this.interest(b);
        if (s.notifyNew === "wishlist" && !i.wished.length) continue;
        const wish = i.wished.length
          ? `♥ ${i.wished
              .slice(0, 3)
              .map((w) => `${w.title} (${w.who.join(", ")})`)
              .join(", ")}${i.wished.length > 3 ? ` +${i.wished.length - 3} more` : ""}. `
          : "";
        this.notify(`New on Humble: ${b.title}`, `${wish}${i.fresh} of ${i.total} new to you${b.price ? ` · from ${b.price.amount} ${b.price.currency ?? ""}`.trimEnd() : ""}${b.endDate ? ` · ends ${exactEnd(b.endDate)}` : ""}`, b.id);
      }
    }
    const finds = this.d.store.takeGameFinds(); // recorded even when notifications are off, so turning them on doesn't replay old ones
    if (s.notifyWatched) {
      for (const f of finds) {
        const tier = f.bundle.items?.find((i) => exactTitle(i.title) === exactTitle(f.game) || looseTitle(i.title) === looseTitle(f.game))?.tier;
        const t = tier != null ? f.bundle.tiers[tier] : undefined;
        const price = t?.price != null ? ` (${t.price}${t.currency ? ` ${t.currency}` : ""})` : "";
        this.notify(
          `★ ${f.game} is in a bundle`,
          `${f.bundle.title}${tier != null && f.bundle.tiers.length > 1 ? ` · tier ${tier + 1}${price}` : price}${f.bundle.endDate ? ` · ends ${exactEnd(f.bundle.endDate)}` : ""}`,
          f.bundle.id,
        );
      }
      for (const g of c.grew)
        this.notify(`${g.bundle.title} added ${g.items.length} item${g.items.length === 1 ? "" : "s"}`, `${g.items.slice(0, 4).join(", ")}${g.items.length > 4 ? ` +${g.items.length - 4} more` : ""}`, g.bundle.id);
    }
  }

  /** Ending notifications for watched bundles, as each threshold passes. */
  private tick(): void {
    if (!this.d.settings().notifyWatched) return;
    const now = Date.now();
    const bundles = new Map(this.d.store.bundles().map((b) => [b.id, b]));
    for (const [id, w] of Object.entries(this.d.store.watchedEntries())) {
      const end = Date.parse(w.endDate || "");
      if (!Number.isFinite(end) || end <= now) continue;
      const left = end - now;
      const due = ENDING.filter((t) => left <= t.ms && !w.notified.includes(t.key));
      if (!due.length) continue;
      for (const t of due) this.d.store.markNotified(id, t.key);
      const b = bundles.get(id);
      const i = b ? this.interest(b) : null;
      this.notify(
        `Ends ${inText(left)}: ${w.title}`,
        `Ends ${exactEnd(w.endDate!)}${i ? ` · ${i.fresh} of ${i.total} new to you${i.wished.length ? ` · ♥ ${i.wished.length} wishlisted` : ""}` : ""}`,
        id,
      );
    }
  }
}

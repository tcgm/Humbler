// Small pure helpers shared by the UI.
import type { Bundle, KeyEntry, Money } from "@shared/types";

export const SITE = "https://www.humblebundle.com";
export const EXPIRING_DAYS = 30;

export const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  mac: "Mac",
  linux: "Linux",
  android: "Android",
  ebook: "eBook",
  audio: "Audio",
  video: "Video",
  other: "Other",
};

/** Same normalisation as lib/library normTitle, for matching titles across sources. */
export const normTitle = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatDate(iso: string | null | undefined): string {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : iso || "";
}

export function formatMoney(m: Money | null | undefined): string {
  if (!m || typeof m.amount !== "number") return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency || "USD" }).format(m.amount);
  } catch {
    return `${m.amount} ${m.currency || ""}`.trim();
  }
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const uniqSorted = (arr: (string | null | undefined)[]) =>
  [...new Set(arr.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));

export const steamUrl = (title: string, appId?: string | number | null) =>
  appId ? `https://store.steampowered.com/app/${appId}` : `https://store.steampowered.com/search/?term=${encodeURIComponent(title)}`;

export const isExpiring = (k: KeyEntry) => k.status === "unused" && k.daysLeft != null && k.daysLeft <= EXPIRING_DAYS;

// ---- platforms -------------------------------------------------------------

export interface Platform {
  id: "steam" | "epic" | "gog" | "origin" | "uplay" | "blizzard" | "external" | "other";
  name: string; // for "Reveal your <name> key"; "" when generic
  badge: string;
  redeem?: (key: string) => string; // the store's redeem page for this key
}

/** Normalise Humble's key types to a platform: name, badge and redeem link. */
export function platformOf(k: Pick<KeyEntry, "keyType">): Platform {
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

// ---- deadlines ----------------------------------------------------------------

export interface Deadline {
  t: number;
  date: string;
  count: number;
  days: number;
}

/**
 * The deadline that matters for a set of keys: the soonest redeem-by date among
 * the still-unrevealed ones, else `fallback` (an order's bundle-wide key
 * deadline). Nothing to do once every key is revealed.
 */
export function deadlineOf(keys: KeyEntry[], fallback?: string | null): Deadline | null {
  const pending = keys.filter((k) => k.status === "unused");
  if (!pending.length) return null;
  let best: { t: number; date: string } | null = null;
  for (const k of pending) {
    const t = Date.parse(k.expiry || "");
    if (Number.isFinite(t) && (!best || t < best.t)) best = { t, date: k.expiry as string };
  }
  let count: number;
  if (best) {
    const bt = best.t;
    count = pending.filter((k) => Date.parse(k.expiry || "") === bt).length;
  } else {
    const t = Date.parse(fallback || "");
    if (!Number.isFinite(t)) return null;
    best = { t, date: fallback as string };
    count = pending.length;
  }
  return { ...best, count, days: Math.floor((best.t - Date.now()) / 86400000) };
}

export const bundleUrl = (b: Pick<Bundle, "gamekey">) => `${SITE}/home/library/${encodeURIComponent(b.gamekey)}`;

/** A product's page on Humble: new-site items have their own page; legacy
 *  items (from old order data) open the purchase they came in. Works for
 *  keys, files and products alike. */
export function humblePageOf(x: { v2?: boolean; contentUrl?: string; url?: string | null; gamekey?: string }): string | null {
  if (x.contentUrl) return x.contentUrl;
  if (x.v2 && x.url) return x.url; // Product.url is the item page for new-site items (a developer site for legacy ones)
  return x.gamekey ? bundleUrl({ gamekey: x.gamekey }) : null;
}

/** Stable placeholder colour + initials for items with no art. */
export function tileLook(title: string): { initials: string; hue: number } {
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const words = String(title)
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return { initials: ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase(), hue: h % 360 };
}

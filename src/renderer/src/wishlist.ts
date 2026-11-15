// Matching Steam wishlist games with what you own on Humble.
//
// Humble's 2026 data has no Steam app ids, so most matches are by title, at
// two strengths:
//   exact:  the same title once case, punctuation and ™/®/(tm) are ignored
//   likely: the same once edition words ("Deluxe Edition", "(Steam)",
//           "- Complete Edition", a leading "The"/"A") are dropped too, so
//           "LEGO® DC Super-Villains (DELUXE EDITION)" finds "LEGO DC Super-Villains"
// Keys and products that do carry a Steam app id (older orders) match by id.
import type { KeyEntry, LibraryIndex, Product, WishlistGame, WishlistProfile } from "@shared/types";
import { normTitle } from "./util";

export type MatchHow = "appid" | "exact" | "likely";

/** What a key means for someone who wants the game. */
export type KeyUse = "spare-unrevealed" | "spare-revealed" | "redeemed" | "gone";

export interface OwnedMatch {
  how: MatchHow;
  key?: KeyEntry;
  /** a library item with no key (a DRM-free download, links...) */
  product?: Product;
}

export interface WishRow {
  appid: number;
  name: string;
  /** Steam has no store page for it (no name to match by) */
  unlisted: boolean;
  capsule: string | null;
  /** who wants it, with their rank */
  wantedBy: { profile: WishlistProfile; game: WishlistGame }[];
  matches: OwnedMatch[];
  /** keys you could still give or redeem */
  spare: KeyEntry[];
}

const strip = (s: string) =>
  String(s || "")
    .replace(/\((?:tm|r|c)\)/gi, " ")
    .replace(/\s*[([]\s*steam(?:\s+key)?\s*[)\]]\s*$/i, "")
    .replace(/\s+[-–—:]\s*steam(?:\s+key)?\s*$/i, "");

/** exact-match form */
export const exactTitle = (s: string): string => normTitle(strip(s));

const EDITION_WORD =
  /\s(?:(?:digital\s)?(?:super\s)?deluxe|ultimate|complete|definitive|premium|gold|goty|game of the year|enhanced|special|collectors?|anniversary|standard|legendary|deluxe|awesome|first month|director s cut)(?:\s(?:edition|collection|version|pack))?$/;

/** likely-match form: edition words and leading articles dropped */
export function looseTitle(s: string): string {
  let t = exactTitle(s).replace(/(?:^|\s)(?:the\s)?(?:complete\s)?(?:edition|collection)$/, "").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(EDITION_WORD, "").trim();
  }
  return t.replace(/^(?:the|a)\s/, "");
}

export function keyUse(k: KeyEntry): KeyUse {
  if (k.gift || k.giftState === "gifted" || k.giftState === "claimed" || k.expired || k.soldOut) return "gone";
  if (k.platformRedeemed || k.autoRedeemed) return "redeemed";
  if (k.status === "unused") return k.redeemable === false ? "gone" : "spare-unrevealed";
  if (k.status === "revealed" || k.status === "link") return "spare-revealed";
  return "gone";
}
export const isSpare = (k: KeyEntry) => keyUse(k).startsWith("spare");

interface OwnIndex {
  byAppid: Map<string, OwnedMatch[]>;
  byExact: Map<string, OwnedMatch[]>;
  byLoose: Map<string, OwnedMatch[]>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** Everything you own, by Steam app id and by title. */
export function indexOwned(lib: LibraryIndex): OwnIndex {
  const idx: OwnIndex = { byAppid: new Map(), byExact: new Map(), byLoose: new Map() };
  const add = (title: string, appid: string | number | null | undefined, m: Omit<OwnedMatch, "how">) => {
    if (appid) push(idx.byAppid, String(appid), m as OwnedMatch);
    const e = exactTitle(title);
    if (e) push(idx.byExact, e, m as OwnedMatch);
    const l = looseTitle(title);
    if (l) push(idx.byLoose, l, m as OwnedMatch);
  };
  for (const k of lib.keys) add(k.name, k.steamAppId, { key: k });
  // items without keys (their keys are listed above)
  for (const p of lib.products) if (!p.keyCount) add(p.title, p.steamAppId, { product: p });
  return idx;
}

function matchesFor(idx: OwnIndex, appid: number, name: string | null): OwnedMatch[] {
  const out: OwnedMatch[] = [];
  const seen = new Set<unknown>();
  const take = (list: OwnedMatch[] | undefined, how: MatchHow) => {
    for (const m of list || []) {
      const it = m.key || m.product;
      if (seen.has(it)) continue;
      seen.add(it);
      out.push({ ...m, how });
    }
  };
  take(idx.byAppid.get(String(appid)), "appid");
  if (name) {
    take(idx.byExact.get(exactTitle(name)), "exact");
    const l = looseTitle(name);
    if (l) take(idx.byLoose.get(l), "likely");
  }
  return out;
}

const USE_ORDER: Record<KeyUse, number> = { "spare-unrevealed": 0, "spare-revealed": 1, redeemed: 2, gone: 3 };

/** One row per game on the given wishlists (a game several people want is one row). */
export function wishRows(profiles: WishlistProfile[], idx: OwnIndex): WishRow[] {
  const rows = new Map<number, WishRow>();
  for (const profile of profiles) {
    for (const game of profile.games) {
      let row = rows.get(game.appid);
      if (!row) {
        const matches = matchesFor(idx, game.appid, game.name).sort(
          (a, b) => (a.key ? USE_ORDER[keyUse(a.key)] : 4) - (b.key ? USE_ORDER[keyUse(b.key)] : 4) || (a.how === "likely" ? 1 : 0) - (b.how === "likely" ? 1 : 0),
        );
        row = {
          appid: game.appid,
          name: game.name || `App ${game.appid}`,
          unlisted: !game.name,
          capsule: game.capsule,
          wantedBy: [],
          matches,
          spare: matches.flatMap((m) => (m.key && isSpare(m.key) ? [m.key] : [])),
        };
        rows.set(game.appid, row);
      }
      row.wantedBy.push({ profile, game });
    }
  }
  return [...rows.values()];
}

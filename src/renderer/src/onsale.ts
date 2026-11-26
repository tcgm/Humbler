// What Humble is selling now, next to what you have: for each item in each
// current bundle, whether it's already yours (in your Humble library, or on
// your Steam account), on someone's Steam wishlist, or new to you.
//
// Humble's store data has no Steam app ids, so everything matches by title,
// exactly or likely (edition words dropped), as for wishlists (wishlist.ts).
import type { StoreBundle, StoreItem, WishlistGame, WishlistProfile } from "@shared/types";
import { onAccountByTitle, type OnAccount, type SteamIndex } from "./steam";
import { exactTitle, indexOwned, keyUse, looseTitle, matchesFor, type MatchHow, type OwnedMatch } from "./wishlist";

export interface Wish {
  profile: WishlistProfile;
  game: WishlistGame;
  how: MatchHow;
  /** your own wishlist (the profile is your signed-in Steam account) */
  mine: boolean;
}

export interface WishIndex {
  byAppid: Map<number, { profile: WishlistProfile; game: WishlistGame }[]>;
  byExact: Map<string, { profile: WishlistProfile; game: WishlistGame }[]>;
  byLoose: Map<string, { profile: WishlistProfile; game: WishlistGame }[]>;
}

export interface ItemInfo {
  item: StoreItem;
  /** what you have for it on Humble (keys you still hold, downloads...) */
  humble: OwnedMatch[];
  steam: OnAccount | null;
  wanted: Wish[];
  /** yours already: in your Humble library or on your Steam account */
  owned: boolean;
}

export interface TierInfo {
  index: number;
  price: number | null;
  currency: string | null;
  items: ItemInfo[];
  /** everything up to and including this tier */
  upto: { items: number; owned: number; fresh: number; wanted: number };
}

export interface BundleInfo {
  bundle: StoreBundle;
  /** null until its page has been read (only the preview titles are known) */
  items: ItemInfo[] | null;
  tiers: TierInfo[];
  total: number;
  owned: number;
  /** new to you: not in your library or on your Steam account */
  fresh: number;
  /** on someone's wishlist */
  wanted: number;
  /** on your own wishlist and not yet yours */
  wantedByMe: number;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

export function indexWishlists(profiles: WishlistProfile[]): WishIndex {
  const idx: WishIndex = { byAppid: new Map(), byExact: new Map(), byLoose: new Map() };
  for (const profile of profiles)
    for (const game of profile.games) {
      push(idx.byAppid, game.appid, { profile, game });
      if (!game.name) continue;
      push(idx.byExact, exactTitle(game.name), { profile, game });
      const l = looseTitle(game.name);
      if (l) push(idx.byLoose, l, { profile, game });
    }
  return idx;
}

/** Who has this game on their Steam wishlist (one entry per person, best match first). */
export function wishesFor(title: string, idx: WishIndex, me: string | null, appid?: string | number | null): Wish[] {
  const out = new Map<string, Wish>(); // one per person, best match
  const take = (list: { profile: WishlistProfile; game: WishlistGame }[] | undefined, how: MatchHow) => {
    for (const w of list || []) if (!out.has(w.profile.steamId)) out.set(w.profile.steamId, { ...w, how, mine: !!me && w.profile.steamId === me });
  };
  if (Number(appid)) take(idx.byAppid.get(Number(appid)), "appid");
  take(idx.byExact.get(exactTitle(title)), "exact");
  const l = looseTitle(title);
  if (l) take(idx.byLoose.get(l), "likely");
  return [...out.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || (a.how === "likely" ? 1 : 0) - (b.how === "likely" ? 1 : 0) || a.game.rank - b.game.rank);
}

/** Keys you gave away, or that expired or sold out, don't count as having the game. */
const stillYours = (m: OwnedMatch) => !m.key || keyUse(m.key) !== "gone";

export function itemInfo(item: StoreItem, own: ReturnType<typeof indexOwned>, steam: SteamIndex, wishes: WishIndex, me: string | null): ItemInfo {
  const humble = matchesFor(own, 0, item.title).filter(stillYours);
  const onSteam = onAccountByTitle(item.title, steam);
  return { item, humble, steam: onSteam, wanted: wishesFor(item.title, wishes, me), owned: humble.length > 0 || !!onSteam };
}

export function bundleInfo(b: StoreBundle, own: ReturnType<typeof indexOwned>, steam: SteamIndex, wishes: WishIndex, me: string | null): BundleInfo {
  if (!b.items) {
    // only the first titles are known: count those, so the list isn't empty while pages load
    const preview = b.preview.map((title, i) => itemInfo({ id: `p${i}`, title, tier: 0, delivery: [], platforms: [], msrp: null, image: null, steamRating: null }, own, steam, wishes, me));
    const owned = preview.filter((i) => i.owned).length;
    return {
      bundle: b,
      items: null,
      tiers: [],
      total: b.itemsCount ?? preview.length,
      owned,
      fresh: preview.length - owned,
      wanted: preview.filter((i) => i.wanted.length).length,
      wantedByMe: preview.filter((i) => !i.owned && i.wanted.some((w) => w.mine)).length,
    };
  }
  const items = b.items.map((it) => itemInfo(it, own, steam, wishes, me));
  const tierCount = Math.max(b.tiers.length, ...items.map((i) => i.item.tier + 1), 1);
  const tiers: TierInfo[] = [];
  const acc = { items: 0, owned: 0, fresh: 0, wanted: 0 };
  for (let t = 0; t < tierCount; t++) {
    const its = items.filter((i) => i.item.tier === t);
    acc.items += its.length;
    acc.owned += its.filter((i) => i.owned).length;
    acc.fresh += its.filter((i) => !i.owned).length;
    acc.wanted += its.filter((i) => i.wanted.length).length;
    tiers.push({ index: t, price: b.tiers[t]?.price ?? null, currency: b.tiers[t]?.currency ?? null, items: its, upto: { ...acc } });
  }
  const owned = items.filter((i) => i.owned).length;
  return {
    bundle: b,
    items,
    tiers,
    total: items.length,
    owned,
    fresh: items.length - owned,
    wanted: items.filter((i) => i.wanted.length).length,
    wantedByMe: items.filter((i) => !i.owned && i.wanted.some((w) => w.mine)).length,
  };
}

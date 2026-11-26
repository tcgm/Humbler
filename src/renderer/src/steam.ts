// Your Steam account next to your Humble keys: which Steam keys are for a
// game (or DLC) that's on your account, and how much of each bundle is.
//
// Matching is the wishlist's (wishlist.ts): by Steam app id where the key has
// one (older orders), else by title, exact or likely (edition words dropped).
// "On your account" doesn't prove *this* key put it there (you may have
// bought it on Steam, or redeemed another copy), so a key that's on your
// account but still unrevealed is a spare, not a redeemed key.
import type { Bundle, KeyEntry, SteamAccountInfo } from "@shared/types";
import { platformOf } from "./util";
import { exactTitle, looseTitle, type MatchHow } from "./wishlist";

export interface SteamApp {
  appid: number;
  name: string;
}

export interface SteamIndex {
  byAppid: Map<number, SteamApp>;
  byExact: Map<string, SteamApp>;
  byLoose: Map<string, SteamApp>;
  size: number;
}

export interface OnAccount {
  app: SteamApp;
  how: MatchHow;
}

/**
 * What a Steam key means next to your account:
 *   redeemed:  revealed (or redeemed by Humble) and on your account: almost certainly redeemed
 *   owned:     on your account but this key was never revealed: you have it anyway (unrevealed: a spare)
 *   given:     gifted, and on your account anyway
 *   revealed:  revealed, but not on your account: given away, redeemed elsewhere, or not yet
 *   missing:   unrevealed and not on your account
 *   lost:      expired or sold out before it was revealed, not on your account
 */
export type SteamState = "redeemed" | "owned" | "given" | "revealed" | "missing" | "lost";

export const STATE_TEXT: Record<SteamState, string> = {
  redeemed: "On your account",
  owned: "On your account, but not from this key (never revealed)",
  given: "On your account (this key was gifted)",
  revealed: "Revealed, not on your account",
  missing: "Unrevealed, not on your account",
  lost: "Expired or sold out, not on your account",
};

export const isSteamKey = (k: KeyEntry): boolean => platformOf(k).id === "steam";

export function indexSteam(apps: SteamAccountInfo["apps"] | undefined): SteamIndex {
  const idx: SteamIndex = { byAppid: new Map(), byExact: new Map(), byLoose: new Map(), size: 0 };
  for (const a of apps || []) {
    const app = { appid: a.appid, name: a.name || `App ${a.appid}` };
    idx.byAppid.set(a.appid, app);
    if (!a.name) continue;
    // first one wins: a game and its "Deluxe Edition" upgrade DLC share a loose title
    const e = exactTitle(a.name);
    if (e && !idx.byExact.has(e)) idx.byExact.set(e, app);
    const l = looseTitle(a.name);
    if (l && !idx.byLoose.has(l)) idx.byLoose.set(l, app);
  }
  idx.size = idx.byAppid.size;
  return idx;
}

/** Is this Steam key's game on your account? */
export function onAccount(k: KeyEntry, idx: SteamIndex): OnAccount | null {
  if (!idx.size || !isSteamKey(k)) return null;
  const id = Number(k.steamAppId);
  if (id && idx.byAppid.has(id)) return { app: idx.byAppid.get(id)!, how: "appid" };
  const e = idx.byExact.get(exactTitle(k.name));
  if (e) return { app: e, how: "exact" };
  const l = looseTitle(k.name);
  const m = l ? idx.byLoose.get(l) : undefined;
  return m ? { app: m, how: "likely" } : null;
}

export function steamState(k: KeyEntry, on: OnAccount | null): SteamState {
  const given = k.gift || k.status === "gifted" || k.status === "link" || k.giftState === "gifted" || k.giftState === "claimed";
  if (on) {
    if (given) return "given";
    return k.status === "revealed" || k.autoRedeemed || k.platformRedeemed ? "redeemed" : "owned";
  }
  if (given || k.status === "revealed") return "revealed";
  if (k.status === "expired" || k.status === "sold-out") return "lost";
  return "missing";
}

export interface SteamKey {
  key: KeyEntry;
  on: OnAccount | null;
  state: SteamState;
}

export interface BundleOnSteam {
  bundle: Bundle;
  keys: SteamKey[];
  /** Steam keys whose game is on your account */
  on: number;
  /** of those, matched only by a "likely" title */
  likely: number;
  /** on / keys, 0-100 */
  pct: number;
}

/** Every Steam key, with whether it's on your account (by key id). */
export function steamKeys(keys: KeyEntry[], idx: SteamIndex): Map<string, SteamKey> {
  const out = new Map<string, SteamKey>();
  if (!idx.size) return out;
  for (const k of keys) {
    if (!isSteamKey(k)) continue;
    const on = onAccount(k, idx);
    out.set(k.id, { key: k, on, state: steamState(k, on) });
  }
  return out;
}

/** Bundles with Steam keys, and how many of those are on your account (by gamekey). */
export function bundlesOnSteam(bundles: Bundle[], sk: Map<string, SteamKey>): Map<string, BundleOnSteam> {
  const byBundle = new Map<string, SteamKey[]>();
  for (const s of sk.values()) {
    const list = byBundle.get(s.key.gamekey);
    if (list) list.push(s);
    else byBundle.set(s.key.gamekey, [s]);
  }
  const out = new Map<string, BundleOnSteam>();
  for (const b of bundles) {
    const keys = byBundle.get(b.gamekey);
    if (!keys?.length) continue;
    const onKeys = keys.filter((s) => s.on);
    out.set(b.gamekey, { bundle: b, keys, on: onKeys.length, likely: onKeys.filter((s) => s.on!.how === "likely").length, pct: Math.round((onKeys.length / keys.length) * 100) });
  }
  return out;
}

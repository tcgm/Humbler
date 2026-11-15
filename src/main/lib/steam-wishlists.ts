// Steam wishlists: yours or your friends', to compare with what you own on
// Humble (a spare key someone wants, a game you wishlisted but already have).
//
// Everything comes from Steam's public endpoints, no API key and no login:
//   - steamcommunity.com/{profiles/<id>|id/<name>}?xml=1: a profile's
//     SteamID64, name and avatar (also resolves custom URL names)
//   - IWishlistService/GetWishlist: the app ids on a public wishlist (an empty
//     reply when it's private or empty: Steam doesn't say which)
//   - IStoreBrowseService/GetItems: names and capsule art for app ids
//
// data/wishlists.json: { profiles: [...], apps: { "<appid>": { name, capsule, at } } }
// App names are cached, so a refresh only looks up games it hasn't seen.
import fs from "node:fs";
import path from "node:path";
import { net } from "electron";
import { DATA_DIR } from "./paths";
import { sleep } from "./throttle";
import type { OkResult, WishlistGame, WishlistProfile } from "../../shared/types";

const STORE_PATH = path.join(DATA_DIR, "wishlists.json");
const API = "https://api.steampowered.com";
const ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/";
const STEAMID64_BASE = 76561197960265728n; // SteamID64 of account id 0 (friend codes are account ids)
const APP_BATCH = 100; // app ids per GetItems call
const APP_INFO_MAX_AGE_MS = 30 * 24 * 3600_000; // names and art change rarely
const STALE_MS = 12 * 3600_000; // refreshed at startup when older than this

interface StoredProfile {
  steamId: string;
  name: string;
  avatar: string | null;
  addedAt: string;
  fetchedAt: string | null;
  error: string | null;
  items: { appid: number; priority: number; added: number | null }[];
}

interface AppInfo {
  name: string | null; // null: Steam has no store page for it (removed, unlisted)
  capsule: string | null;
  at: number;
}

interface StoreFile {
  profiles: StoredProfile[];
  apps: Record<string, AppInfo>;
}

function loadFile(): StoreFile {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { profiles: Array.isArray(d.profiles) ? d.profiles : [], apps: d.apps && typeof d.apps === "object" ? d.apps : {} };
  } catch {
    return { profiles: [], apps: {} };
  }
}

function saveFile(d: StoreFile): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

/** What someone typed: a profile or wishlist URL, a SteamID64, a friend code, or a custom URL name. */
export function parseProfileInput(input: string): { id64: string } | { vanity: string } | null {
  const s = input.trim();
  if (!s) return null;
  const byId = /(?:steamcommunity\.com|steampowered\.com\/wishlist)\/profiles\/(\d{17})/i.exec(s);
  if (byId) return { id64: byId[1] };
  const byName = /(?:steamcommunity\.com|steampowered\.com\/wishlist)\/id\/([^/?#\s]+)/i.exec(s);
  if (byName) return { vanity: decodeURIComponent(byName[1]) };
  if (/^\d{17}$/.test(s)) return { id64: s };
  // friend code (the account id Steam shows under "Add a friend")
  if (/^\d{1,10}$/.test(s)) return { id64: String(STEAMID64_BASE + BigInt(s)) };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { vanity: s };
  return null;
}

const cdata = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml);
  const v = m ? (m[1] ?? m[2] ?? "").trim() : "";
  return v || null;
};

async function getText(url: string): Promise<{ status: number; text: string }> {
  const res = await net.fetch(url, { headers: { Accept: "application/json, text/xml;q=0.9, */*;q=0.5" } });
  return { status: res.status, text: await res.text() };
}

async function getJson(url: string): Promise<any> {
  const { status, text } = await getText(url);
  if (status !== 200) throw new Error(`Steam answered HTTP ${status}`);
  return JSON.parse(text);
}

/** A profile's SteamID64, name and avatar. */
async function resolveProfile(input: string): Promise<{ steamId: string; name: string; avatar: string | null }> {
  const who = parseProfileInput(input);
  if (!who) throw new Error("That doesn't look like a Steam profile: paste a profile or wishlist link, a SteamID64, a friend code or a custom URL name.");
  const url = "id64" in who ? `https://steamcommunity.com/profiles/${who.id64}?xml=1` : `https://steamcommunity.com/id/${encodeURIComponent(who.vanity)}?xml=1`;
  const { status, text } = await getText(url);
  if (status !== 200) throw new Error(`Steam answered HTTP ${status} for that profile.`);
  const err = cdata(text, "error");
  if (err) throw new Error(`Steam says: ${err}`);
  const steamId = cdata(text, "steamID64");
  if (!steamId || !/^\d{17}$/.test(steamId)) throw new Error("Steam didn't return a profile for that.");
  return { steamId, name: cdata(text, "steamID") || steamId, avatar: cdata(text, "avatarMedium") || cdata(text, "avatarIcon") };
}

async function fetchWishlist(steamId: string): Promise<StoredProfile["items"]> {
  const d = await getJson(`${API}/IWishlistService/GetWishlist/v1/?steamid=${steamId}`);
  const items: any[] = Array.isArray(d?.response?.items) ? d.response.items : [];
  return items
    .filter((i) => Number.isFinite(Number(i?.appid)))
    .map((i) => ({ appid: Number(i.appid), priority: Number(i.priority) || 0, added: Number(i.date_added) || null }));
}

/** Names and capsule art for app ids (looked up in batches). */
async function fetchAppInfo(appids: number[]): Promise<Map<number, AppInfo>> {
  const out = new Map<number, AppInfo>();
  for (let i = 0; i < appids.length; i += APP_BATCH) {
    const batch = appids.slice(i, i + APP_BATCH);
    const input = {
      ids: batch.map((appid) => ({ appid })),
      context: { language: "english", country_code: "US" },
      data_request: { include_assets: true },
    };
    const d = await getJson(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
    const items: any[] = Array.isArray(d?.response?.store_items) ? d.response.store_items : [];
    const now = Date.now();
    for (const appid of batch) {
      // failed lookups (success != 1: removed or unlisted) come back with appid 0
      const it = items.find((x) => Number(x?.appid) === appid);
      const ok = it && it.success === 1;
      const a = ok ? it.assets : null;
      const file = a?.small_capsule || a?.header;
      out.set(appid, {
        name: ok && typeof it.name === "string" && it.name ? it.name : null,
        capsule: a?.asset_url_format && file ? ASSETS + String(a.asset_url_format).replace("${FILENAME}", file) : null,
        at: now,
      });
    }
    if (i + APP_BATCH < appids.length) await sleep(400);
  }
  return out;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Wishlists {
  private data = loadFile();
  private refreshing = new Set<string>();

  constructor(private opts: { log: (m: string) => void; onChange: () => void }) {}

  view(): WishlistProfile[] {
    return this.data.profiles.map((p) => ({
      steamId: p.steamId,
      name: p.name,
      avatar: p.avatar,
      profileUrl: `https://steamcommunity.com/profiles/${p.steamId}`,
      wishlistUrl: `https://store.steampowered.com/wishlist/profiles/${p.steamId}/`,
      addedAt: p.addedAt,
      fetchedAt: p.fetchedAt,
      error: p.error,
      refreshing: this.refreshing.has(p.steamId),
      games: [...p.items]
        .sort((a, b) => a.priority - b.priority || (a.added ?? 0) - (b.added ?? 0))
        .map(
          (it, i): WishlistGame => ({
            appid: it.appid,
            name: this.data.apps[it.appid]?.name ?? null,
            capsule: this.data.apps[it.appid]?.capsule ?? null,
            rank: i + 1,
            added: it.added ? new Date(it.added * 1000).toISOString() : null,
          }),
        ),
    }));
  }

  private save() {
    saveFile(this.data);
    this.opts.onChange();
  }

  async add(input: string): Promise<OkResult & { steamId?: string }> {
    let who: Awaited<ReturnType<typeof resolveProfile>>;
    try {
      who = await resolveProfile(input);
    } catch (err) {
      return { ok: false, reason: errMsg(err) };
    }
    const existing = this.data.profiles.find((p) => p.steamId === who.steamId);
    if (existing) {
      existing.name = who.name;
      existing.avatar = who.avatar;
    } else {
      this.data.profiles.push({ ...who, addedAt: new Date().toISOString(), fetchedAt: null, error: null, items: [] });
      this.opts.log(`Wishlists: added ${who.name} (${who.steamId}).`);
    }
    this.save();
    const r = await this.refreshOne(who.steamId);
    return { ...r, steamId: who.steamId };
  }

  remove(steamId: string): void {
    const p = this.data.profiles.find((x) => x.steamId === steamId);
    if (!p) return;
    this.data.profiles = this.data.profiles.filter((x) => x !== p);
    this.opts.log(`Wishlists: removed ${p.name}.`);
    this.save();
  }

  /** One profile, or every profile (null); `staleOnly` skips ones fetched recently. */
  async refresh(steamId: string | null, { staleOnly = false } = {}): Promise<OkResult> {
    const now = Date.now();
    const ids = this.data.profiles
      .filter((p) => !steamId || p.steamId === steamId)
      .filter((p) => !staleOnly || !p.fetchedAt || now - Date.parse(p.fetchedAt) > STALE_MS)
      .map((p) => p.steamId);
    const failed: string[] = [];
    for (const id of ids) {
      const r = await this.refreshOne(id);
      if (!r.ok) failed.push(r.reason || id);
    }
    return failed.length ? { ok: false, reason: failed.join("\n") } : { ok: true };
  }

  private async refreshOne(steamId: string): Promise<OkResult> {
    if (this.refreshing.has(steamId)) return { ok: true };
    this.refreshing.add(steamId);
    this.opts.onChange();
    const name = () => this.data.profiles.find((p) => p.steamId === steamId)?.name || steamId;
    try {
      // the profile again too: names and avatars change
      const [items, who] = await Promise.all([fetchWishlist(steamId), resolveProfile(steamId).catch(() => null)]);
      const now = Date.now();
      const need = [...new Set(items.map((i) => i.appid))].filter((a) => {
        const info = this.data.apps[a];
        return !info || now - info.at > APP_INFO_MAX_AGE_MS;
      });
      if (need.length) for (const [appid, info] of await fetchAppInfo(need)) this.data.apps[appid] = info;
      const p = this.data.profiles.find((x) => x.steamId === steamId);
      if (!p) return { ok: true }; // removed meanwhile
      if (who) {
        p.name = who.name;
        p.avatar = who.avatar;
      }
      p.items = items;
      p.fetchedAt = new Date().toISOString();
      p.error = items.length ? null : "No games: the wishlist is empty, or private (on Steam: Edit Profile → Privacy Settings → Game details: Public).";
      this.opts.log(`Wishlists: ${p.name} has ${items.length} game(s) on their wishlist${need.length ? ` (looked up ${need.length} new)` : ""}.`);
      return { ok: true };
    } catch (err) {
      const p = this.data.profiles.find((x) => x.steamId === steamId);
      if (p) p.error = `Couldn't fetch the wishlist: ${errMsg(err)}`;
      this.opts.log(`Wishlists: couldn't fetch ${name()}'s wishlist: ${errMsg(err)}`);
      return { ok: false, reason: `${name()}: ${errMsg(err)}` };
    } finally {
      this.refreshing.delete(steamId);
      this.save();
    }
  }
}

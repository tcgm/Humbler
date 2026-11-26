// Your own Steam account: which games and DLC are on it, to see which Humble
// keys you've redeemed there and how much of each bundle is on your account.
//
// Steam doesn't show anyone's games without signing in (the profile games
// page redirects to the login), so you sign in to Steam once in the side
// pane. Steam's cookies live in the same session partition as Humble's
// (encrypted on disk the same way) and Humbler reads, with them:
//   - the steamLoginSecure cookie: "<SteamID64>||<token>", so which account it is
//   - store.steampowered.com/dynamicstore/userdata: the app ids you own
//     (games and DLC), the same list the store uses to say "In library",
//     and the ones on your wishlist (even when it's private)
//   - store.steampowered.com/api/addtowishlist: adds a game to your wishlist
//     (only when you click "Add to Steam wishlist"; app ids found by title
//     with the public api/storesearch)
// Names come from the public IStoreBrowseService/GetItems (as for wishlists),
// cached, so a refresh only looks up apps it hasn't seen.
//
// data/steam-account.json: { steamId, name, avatar, fetchedAt, error, apps: [appid...], wishlist: [appid...], packages, names: { "<appid>": { name, at } } }
import fs from "node:fs";
import path from "node:path";
import type { Session } from "electron";
import { fetchText } from "./http";
import { DATA_DIR } from "./paths";
import { fetchAppInfo, resolveProfile } from "./steam-wishlists";
import { exactTitle, looseTitle } from "../../shared/titles";
import type { OkResult, SteamAccountInfo } from "../../shared/types";

const STORE_PATH = path.join(DATA_DIR, "steam-account.json");
const STORE = "https://store.steampowered.com";
const LOGIN_COOKIE = "steamLoginSecure";
const NAME_MAX_AGE_MS = 60 * 24 * 3600_000; // names of things you own change rarely
const STALE_MS = 12 * 3600_000; // refreshed at startup when older than this
/** Steam's cookie domains (cleared on sign-out) */
export const STEAM_COOKIE_DOMAIN = /(^|\.)(steampowered\.com|steamcommunity\.com)$/i;

interface StoreFile {
  steamId: string | null;
  name: string | null;
  avatar: string | null;
  fetchedAt: string | null;
  error: string | null;
  apps: number[];
  wishlist: number[];
  packages: number;
  names: Record<string, { name: string | null; at: number }>;
}

const EMPTY: StoreFile = { steamId: null, name: null, avatar: null, fetchedAt: null, error: null, apps: [], wishlist: [], packages: 0, names: {} };

function loadFile(): StoreFile {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      ...EMPTY,
      ...d,
      apps: Array.isArray(d.apps) ? d.apps.filter((a: unknown) => Number.isFinite(a)) : [],
      wishlist: Array.isArray(d.wishlist) ? d.wishlist.filter((a: unknown) => Number.isFinite(a)) : [],
      names: d.names && typeof d.names === "object" ? d.names : {},
    };
  } catch {
    return { ...EMPTY, names: {} };
  }
}

function saveFile(d: StoreFile): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SteamAccount {
  private data = loadFile();
  private refreshing = false;
  private signedIn = false;

  constructor(private opts: { session: () => Session; log: (m: string) => void; onChange: () => void }) {}

  /** The signed-in account's SteamID64, from Steam's login cookie (null: not signed in). */
  private async cookieSteamId(): Promise<string | null> {
    const cookies = await this.opts.session().cookies.get({ url: STORE, name: LOGIN_COOKIE });
    const id = /^(\d{17})(?:\|\||$)/.exec(decodeURIComponent(cookies[0]?.value || ""));
    return id ? id[1] : null;
  }

  /** Call once at startup: notices when you finish signing in (or out) in the pane. */
  watchSignIn(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.opts.session().cookies.on("changed", (_e, cookie) => {
      if (cookie.name !== LOGIN_COOKIE || !STEAM_COOKIE_DOMAIN.test((cookie.domain || "").replace(/^\./, ""))) return;
      clearTimeout(timer);
      timer = setTimeout(() => void this.onCookieChange(), 1500); // Steam sets it on several domains in a row
    });
    void this.cookieSteamId().then((id) => {
      this.signedIn = !!id;
      this.opts.onChange();
    });
  }

  private async onCookieChange() {
    const id = await this.cookieSteamId();
    const was = this.signedIn;
    this.signedIn = !!id;
    this.opts.onChange();
    // a fresh sign-in (or another account): fetch now. A token refresh on the same account doesn't need it.
    if (id && (!was || id !== this.data.steamId || !this.data.fetchedAt)) void this.refresh();
  }

  view(): SteamAccountInfo {
    const d = this.data;
    return {
      signedIn: this.signedIn,
      steamId: d.steamId,
      name: d.name,
      avatar: d.avatar,
      profileUrl: d.steamId ? `https://steamcommunity.com/profiles/${d.steamId}` : null,
      fetchedAt: d.fetchedAt,
      error: d.error,
      refreshing: this.refreshing,
      packages: d.packages,
      apps: d.apps.map((appid) => ({ appid, name: d.names[appid]?.name ?? null })),
      wishlist: d.wishlist.map((appid) => ({ appid, name: d.names[appid]?.name ?? null })),
    };
  }

  private save() {
    saveFile(this.data);
    this.opts.onChange();
  }

  /** Steam's list of what you own (null: Steam doesn't think you're signed in). */
  private async fetchOwned(): Promise<{ apps: number[]; wishlist: number[]; packages: number } | null> {
    const ses = this.opts.session();
    const r = await fetchText(ses, { url: `${STORE}/dynamicstore/userdata/?t=${Date.now()}`, headers: { Accept: "application/json" } });
    if (r.status !== 200) throw new Error(`Steam answered HTTP ${r.status}`);
    const d = JSON.parse(r.text);
    const apps: number[] = (Array.isArray(d?.rgOwnedApps) ? d.rgOwnedApps : []).map(Number).filter(Number.isFinite);
    const packages = Array.isArray(d?.rgOwnedPackages) ? d.rgOwnedPackages.length : 0;
    // signed out (or the sign-in expired): every list comes back empty
    if (!apps.length && !packages) return null;
    // the wishlist, in Steam's order (your ranking)
    const wishlist: number[] = (Array.isArray(d?.rgWishlist) ? d.rgWishlist : []).map(Number).filter(Number.isFinite);
    return { apps: [...new Set(apps)], wishlist: [...new Set(wishlist)], packages };
  }

  async refresh(): Promise<OkResult> {
    if (this.refreshing) return { ok: true };
    this.refreshing = true;
    this.opts.onChange();
    try {
      const steamId = await this.cookieSteamId();
      this.signedIn = !!steamId;
      if (!steamId) {
        this.data.error = "Not signed in to Steam. Sign in (in the pane on the right) and Humbler fetches your games.";
        return { ok: false, reason: this.data.error };
      }
      let owned = await this.fetchOwned();
      if (!owned) {
        // Steam's sign-in token lasts about a day; loading a store page renews it (a redirect via login.steampowered.com)
        await fetchText(this.opts.session(), { url: `${STORE}/account/` }).catch(() => null);
        owned = await this.fetchOwned();
      }
      if (!owned) {
        this.data.error = "Steam says you're not signed in (the sign-in may have expired). Sign in to Steam again.";
        this.opts.log("Steam account: Steam says you're not signed in; sign in again.");
        return { ok: false, reason: this.data.error };
      }
      if (this.data.steamId && this.data.steamId !== steamId) this.data = { ...EMPTY, names: this.data.names }; // another account
      const who = await resolveProfile(steamId).catch(() => null);
      const now = Date.now();
      const need = [...new Set([...owned.apps, ...owned.wishlist])].filter((a) => {
        const n = this.data.names[a];
        return !n || now - n.at > NAME_MAX_AGE_MS;
      });
      if (need.length) for (const [appid, info] of await fetchAppInfo(need)) this.data.names[appid] = { name: info.name, at: info.at };
      Object.assign(this.data, {
        steamId,
        name: who?.name ?? this.data.name ?? steamId,
        avatar: who?.avatar ?? this.data.avatar,
        apps: owned.apps,
        wishlist: owned.wishlist,
        packages: owned.packages,
        fetchedAt: new Date().toISOString(),
        error: null,
      });
      this.opts.log(
        `Steam account: ${this.data.name} has ${owned.apps.length} games and DLC, ${owned.wishlist.length} on the wishlist${need.length ? ` (looked up ${need.length} new names)` : ""}.`,
      );
      return { ok: true };
    } catch (err) {
      this.data.error = `Couldn't fetch your Steam games: ${errMsg(err)}`;
      this.opts.log(`Steam account: ${this.data.error}`);
      return { ok: false, reason: this.data.error };
    } finally {
      this.refreshing = false;
      this.save();
    }
  }

  /**
   * Add a game to your Steam wishlist, found by title (or by app id). Only
   * an app whose title matches (exactly, or but for edition words) is added;
   * anything else is reported, not guessed.
   */
  async addToWishlist(title: string, appid?: number | null): Promise<OkResult & { appid?: number; name?: string }> {
    const ses = this.opts.session();
    const sid = (await ses.cookies.get({ url: STORE, name: "sessionid" }))[0]?.value;
    if (!(await this.cookieSteamId()) || !sid) return { ok: false, reason: "Sign in to Steam first (My Steam tab)." };
    let app: { id: number; name: string } | null = appid ? { id: appid, name: title } : null;
    if (!app) {
      const r = await fetchText(ses, { url: `${STORE}/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`, headers: { Accept: "application/json" } });
      const items: { id: number; name: string; type: string }[] = r.status === 200 ? (JSON.parse(r.text)?.items ?? []) : [];
      const apps = items.filter((i) => i.type === "app" && Number.isFinite(i.id));
      app = apps.find((i) => exactTitle(i.name) === exactTitle(title)) ?? apps.find((i) => looseTitle(i.name) === looseTitle(title)) ?? null;
      if (!app) return { ok: false, reason: `Couldn't find "${title}" on the Steam store${apps.length ? ` (closest: ${apps[0].name})` : ""}.` };
    }
    const r = await fetchText(ses, {
      url: `${STORE}/api/addtowishlist`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Origin: STORE, Referer: `${STORE}/app/${app.id}/`, Accept: "application/json" },
      body: `sessionid=${encodeURIComponent(sid)}&appid=${app.id}`,
    });
    let ok = false;
    try {
      ok = r.status === 200 && JSON.parse(r.text)?.success === true;
    } catch {
      // not JSON: an error page
    }
    if (!ok) {
      this.opts.log(`Steam account: couldn't add ${app.name} (${app.id}) to your wishlist (HTTP ${r.status}).`);
      return { ok: false, reason: "Steam didn't add it: the sign-in may have expired (My Steam → Sign in again)." };
    }
    this.opts.log(`Steam account: added ${app.name} (${app.id}) to your wishlist.`);
    if (!this.data.wishlist.includes(app.id)) this.data.wishlist.push(app.id);
    this.data.names[app.id] = { name: app.name, at: Date.now() };
    this.save();
    return { ok: true, appid: app.id, name: app.name };
  }

  /** At startup: refresh when signed in and not fetched recently. */
  async refreshIfStale(): Promise<void> {
    if (!(await this.cookieSteamId())) return;
    const at = this.data.fetchedAt ? Date.parse(this.data.fetchedAt) : 0;
    if (Date.now() - at > STALE_MS) await this.refresh();
  }

  /** Sign out of Steam in Humbler (its cookies) and forget the account's games. */
  async signOut(): Promise<void> {
    const ses = this.opts.session();
    for (const c of await ses.cookies.get({})) {
      const host = (c.domain || "").replace(/^\./, "");
      if (!STEAM_COOKIE_DOMAIN.test(host)) continue;
      await ses.cookies.remove(`https://${host}${c.path || "/"}`, c.name).catch(() => {});
    }
    await ses.cookies.flushStore().catch(() => {});
    this.opts.log(`Steam account: signed out${this.data.name ? ` of ${this.data.name}` : ""} and forgot its games.`);
    this.data = { ...EMPTY, names: this.data.names };
    this.signedIn = false;
    this.save();
  }
}

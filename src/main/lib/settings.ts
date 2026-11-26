import fs from "node:fs";
import path from "node:path";
import { SETTINGS_PATH, DEFAULT_DOWNLOAD_DIR } from "./paths";
import type { Naming, NotifyNew, Theme } from "../../shared/types";

export const NAMING: Naming[] = ["original", "title"];

export interface Settings {
  downloadDir: string;
  naming: Naming;
  markOwned: boolean;
  liveScout: boolean;
  theme: Theme;
  /** other folders to scan for things you already have (downloadDir is always scanned) */
  folders: string[];
  /** bundle folder -> bundle gamekey (null = not a bundle), set by hand */
  folderLinks: Record<string, string | null>;
  /** access token for a release feed that needs signing in (a private Gitea),
   *  sealed (secret-store); "" = none */
  updateToken: string;
  /** Monitor Mode: closing the window keeps Humbler in the notification area, watching Humble */
  monitorMode: boolean;
  /** start with your computer (hidden in the notification area when Monitor Mode is on) */
  startAtLogin: boolean;
  /** notify about new bundles: all, only with a wishlisted game, or none */
  notifyNew: NotifyNew;
  /** notify as watched bundles near their end, and when they add items */
  notifyWatched: boolean;
}

export function load(): Settings {
  let saved: any = {}; // settings.json as written (untrusted: may be partial or stale)
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    // first run / unreadable: fall back to defaults
  }
  return {
    downloadDir: path.resolve(saved.downloadDir || process.env.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR),
    // "original" = Humble's file names; "title" = "<Product> - <Publisher>.<ext>"
    naming: NAMING.includes(saved.naming) ? saved.naming : "original",
    // highlight things you already own on Humble's store/bundle/Choice pages
    markOwned: saved.markOwned !== false,
    // continuously catalog every endpoint Humble's pages call (data/recon/live)
    liveScout: saved.liveScout !== false,
    // dark by default; "light" for anyone who insists
    theme: saved.theme === "light" ? "light" : "dark",
    folders: Array.isArray(saved.folders) ? saved.folders.filter((f: unknown) => typeof f === "string" && f) : [],
    folderLinks: saved.folderLinks && typeof saved.folderLinks === "object" ? saved.folderLinks : {},
    // stays sealed here: opened only when an update check uses it
    updateToken: typeof saved.updateToken === "string" ? saved.updateToken : "",
    monitorMode: saved.monitorMode === true,
    startAtLogin: saved.startAtLogin === true,
    notifyNew: saved.notifyNew === "all" || saved.notifyNew === "off" ? saved.notifyNew : "wishlist",
    notifyWatched: saved.notifyWatched !== false,
  };
}

export function save(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

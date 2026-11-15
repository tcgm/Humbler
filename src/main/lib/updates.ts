// "A new version is out" check, and installing it.
//
// The check reads the latest release from the release feed: the repository
// the app was built from (GitHub, or a Gitea server), worked out by
// scripts/package.mjs and written into the built app's package.json
// ("humbler.releaseFeed"). Running from source, it's the "origin" git remote.
// HUMBLER_RELEASE_FEED overrides either; "none" turns the check off.
//
// A feed is a "latest release" API URL; GitHub and Gitea answer the same
// shape ({ tag_name, name, html_url, draft, prerelease }):
//   https://api.github.com/repos/<owner>/<repo>/releases/latest
//   https://<gitea>/api/v1/repos/<owner>/<repo>/releases/latest
// Several can be given, separated by spaces or commas; the first that answers
// wins. http is allowed only on your own network (see release-feed.ts).
//
// A feed that needs signing in (a private Gitea) works with an access token
// the user sets in Settings: sent only to the feed's own server, for the
// check and for downloading the release's files.
//
// Installing uses electron-updater on the files of the release the check
// found (its latest.yml / latest-linux.yml, checksummed), from the same
// server: Windows copies installed by either setup, and Linux AppImages.
// Other copies (the Windows zip, the Linux tar.gz, unsigned macOS) can't
// replace themselves, so they get the release page.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { allowedUrl, feedForRepo, releaseDownloads } from "@shared/release-feed";
import { app, net } from "electron";
import { autoUpdater } from "electron-updater";

export interface UpdateInfo {
  version: string;
  url: string;
  name: string;
  /** this copy can download and install it itself */
  installable: boolean;
}

function builtFeed(): string {
  if (!app.isPackaged) {
    try {
      const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: app.getAppPath(), encoding: "utf8", windowsHide: true });
      return feedForRepo(origin) ?? "";
    } catch {
      return "";
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    return typeof pkg?.humbler?.releaseFeed === "string" ? pkg.humbler.releaseFeed : "";
  } catch {
    return "";
  }
}

function authHeaders(url: string, feed: string, token: string | null): Record<string, string> {
  if (!token) return {};
  try {
    if (new URL(url).origin !== new URL(feed).origin) return {}; // never to another server
  } catch {
    return {};
  }
  return { Authorization: `token ${token}` }; // Gitea's form; GitHub accepts it too
}

export function releaseFeeds(): string[] {
  const feed = (process.env.HUMBLER_RELEASE_FEED || builtFeed()).trim();
  if (feed === "none") return [];
  return feed.split(/[\s,]+/).filter(allowedUrl);
}

/** How this copy can update itself, if it can. */
function selfInstall(): "nsis" | "appimage" | null {
  if (!app.isPackaged) return null;
  // both setups leave their uninstaller next to the exe; the zip doesn't
  if (process.platform === "win32") return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)) ? "nsis" : null;
  if (process.platform === "linux") return process.env.APPIMAGE ? "appimage" : null;
  return null; // macOS: needs a signed build
}

// where the files of the release the last check found are (what to install)
let foundAt: string | null = null;
let foundFeed: string | null = null;

/** "v1.2.3" / "1.2.3-beta.1" -> [1, 2, 3]; null if not a version. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The newest release if it's newer than `current`, else null. Throws if no feed answers. */
export async function checkForUpdate(current: string, token: string | null): Promise<UpdateInfo | null> {
  const feeds = releaseFeeds();
  if (!feeds.length) return null;
  let lastErr: unknown = null;
  foundAt = null;
  foundFeed = null;
  for (const feed of feeds) {
    try {
      const r = await net.fetch(feed, {
        headers: { Accept: "application/json", "User-Agent": `Humbler/${current}`, ...authHeaders(feed, feed, token) },
        redirect: "error", // a redirect could carry the token elsewhere
      });
      if (r.status === 401 || r.status === 403) throw new Error(token ? `HTTP ${r.status}: the access token was refused` : `HTTP ${r.status}: the repository needs an access token`);
      if (r.status === 404) throw new Error(token ? "HTTP 404: no release yet, or the token can't read this repository" : "HTTP 404: no release yet, or the repository is private (add an access token)");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rel: any = await r.json(); // release JSON (untyped)
      if (rel?.draft || rel?.prerelease || typeof rel?.tag_name !== "string") return null;
      const version = rel.tag_name.replace(/^v/, "");
      if (!isNewer(version, current)) return null;
      const url = typeof rel.html_url === "string" && allowedUrl(rel.html_url) ? rel.html_url : feed;
      foundAt = releaseDownloads(feed, rel.tag_name);
      foundFeed = feed;
      return { version, url, name: typeof rel.name === "string" && rel.name ? rel.name : `Humbler ${version}`, installable: !!(foundAt && selfInstall()) };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Downloads the update found by the last check (verifying its checksum),
 * then quits, installs it and starts the new version. Resolves just before
 * quitting; throws if it can't.
 */
export async function installUpdate(onProgress: (percent: number) => void, token: string | null): Promise<void> {
  if (!foundAt || !foundFeed || !selfInstall()) throw new Error("this copy can't install updates itself; get it from the release page");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({ provider: "generic", url: foundAt });
  // the token for the feed's own server only (a private Gitea); GitHub serves files without one
  autoUpdater.requestHeaders = authHeaders(foundAt, foundFeed, token);
  const progress = (p: { percent: number }) => onProgress(p.percent);
  autoUpdater.on("download-progress", progress);
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r?.isUpdateAvailable) throw new Error("the release has no installer for this system");
    await autoUpdater.downloadUpdate();
  } finally {
    autoUpdater.off("download-progress", progress);
  }
  // silent install, then start the new version
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

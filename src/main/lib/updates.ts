// "A new version is out" check. Notify only: it reads the latest release
// from the release feeds listed in package.json ("humbler.releaseFeeds") and
// tells the UI, which links to the release page. Nothing is downloaded or
// installed.
//
// A feed is a "latest release" API URL; GitHub and Gitea answer the same
// shape ({ tag_name, name, html_url, draft, prerelease }):
//   https://api.github.com/repos/<owner>/<repo>/releases/latest
//   https://<gitea host>/api/v1/repos/<owner>/<repo>/releases/latest
// The first feed that answers wins. No feeds: no check.
import fs from "node:fs";
import path from "node:path";
import { app, net } from "electron";

export interface UpdateInfo {
  version: string;
  url: string;
  name: string;
}

export function releaseFeeds(): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    const feeds = pkg?.humbler?.releaseFeeds;
    return Array.isArray(feeds) ? feeds.filter((f: unknown): f is string => typeof f === "string" && /^https:\/\//.test(f)) : [];
  } catch {
    return [];
  }
}

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
export async function checkForUpdate(current: string): Promise<UpdateInfo | null> {
  const feeds = releaseFeeds();
  if (!feeds.length) return null;
  let lastErr: unknown = null;
  for (const feed of feeds) {
    try {
      const r = await net.fetch(feed, { headers: { Accept: "application/json", "User-Agent": `Humbler/${current}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rel: any = await r.json(); // release JSON (untyped)
      if (rel?.draft || rel?.prerelease || typeof rel?.tag_name !== "string") return null;
      const version = rel.tag_name.replace(/^v/, "");
      if (!isNewer(version, current)) return null;
      const url = typeof rel.html_url === "string" && /^https:\/\//.test(rel.html_url) ? rel.html_url : feed;
      return { version, url, name: typeof rel.name === "string" && rel.name ? rel.name : `Humbler ${version}` };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

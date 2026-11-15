// Where a build looks for new versions: the "latest release" API of the
// repository it was built from (GitHub, or a Gitea / Forgejo server, which
// answer the same shape), and where that release's files are.
//
// Plain TypeScript with no imports, so scripts/package.mjs can load it too.

// http is only allowed on your own network (a LAN Gitea); anything else needs https
const LOCAL_HOST = /^(localhost|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|\[::1\]|[^.]+|.+\.(local|lan|internal|home\.arpa))$/i;

/** May updates be fetched from this URL? */
export function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOST.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * A repository's web or clone URL (https, http, or ssh like git@host:owner/repo.git)
 * -> its latest-release API URL, or null. Credentials in the URL are dropped.
 */
export function feedForRepo(repoUrl: string): string | null {
  let s = repoUrl.trim();
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/](.+)$/.exec(s);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`; // ssh port isn't the web port: assume https
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const parts = u.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  if (u.hostname === "github.com") return parts.length === 2 ? `https://api.github.com/repos/${owner}/${repo}/releases/latest` : null;
  const prefix = parts.slice(0, -2).map((p) => `/${p}`).join(""); // a Gitea served under a path
  return `${u.origin}${prefix}/api/v1/repos/${owner}/${repo}/releases/latest`;
}

/** Where the files of release `tag` are, for a feed made by feedForRepo; null for other feeds. */
export function releaseDownloads(feed: string, tag: string): string | null {
  const gh = /^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/releases\/latest$/.exec(feed);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/releases/download/${encodeURIComponent(tag)}`;
  const gitea = /^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/api\/v1\/repos\/([\w.-]+)\/([\w.-]+)\/releases\/latest$/.exec(feed);
  if (gitea) return `${gitea[1]}/${gitea[2]}/${gitea[3]}/releases/download/${encodeURIComponent(tag)}`;
  return null;
}

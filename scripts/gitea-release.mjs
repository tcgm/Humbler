// Uploads release files to a Gitea release (creating the release for the tag
// if it doesn't exist yet). Used by .gitea/workflows/release.yml; several
// build jobs can run it for the same tag.
//
//   node scripts/gitea-release.mjs <tag> <file>...
//
// env: GITEA_URL (e.g. https://git.example.com), GITEA_REPO (owner/repo),
//      RELEASE_TOKEN (a token with write access to the repo's releases)
import fs from "node:fs";
import path from "node:path";

const [tag, ...files] = process.argv.slice(2);
const base = (process.env.GITEA_URL || "").replace(/\/+$/, "");
const repo = process.env.GITEA_REPO || "";
const token = process.env.RELEASE_TOKEN || "";
if (!tag || !files.length || !base || !repo || !token) {
  console.error("usage: GITEA_URL=… GITEA_REPO=owner/repo RELEASE_TOKEN=… node scripts/gitea-release.mjs <tag> <file>...");
  process.exit(2);
}
const api = `${base}/api/v1/repos/${repo}`;
const headers = { Authorization: `token ${token}`, Accept: "application/json" };

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body instanceof FormData ? headers : { ...headers, "Content-Type": "application/json" }, body: body instanceof FormData ? body : body && JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, text };
}

async function releaseFor(tag) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await call("GET", `${api}/releases/tags/${encodeURIComponent(tag)}`);
    if (got.status === 200) return got.json;
    const made = await call("POST", `${api}/releases`, {
      tag_name: tag,
      name: `Humbler ${tag.replace(/^v/, "")}`,
      body: `Humbler ${tag.replace(/^v/, "")}. Downloads below; see the README for which file to pick.`,
      draft: false,
      prerelease: tag.includes("-"),
    });
    if (made.status === 201) return made.json;
    // another job created it at the same moment: look again
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`couldn't find or create the release for ${tag}`);
}

const rel = await releaseFor(tag);
const existing = new Map((rel.assets || []).map((a) => [a.name, a.id]));
for (const file of files) {
  const name = path.basename(file);
  if (existing.has(name)) await call("DELETE", `${api}/releases/${rel.id}/assets/${existing.get(name)}`); // replace on re-run
  const form = new FormData();
  form.append("attachment", new Blob([fs.readFileSync(file)]), name);
  const up = await call("POST", `${api}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, form);
  if (up.status !== 201) throw new Error(`upload of ${name} failed: HTTP ${up.status} ${up.text.slice(0, 200)}`);
  console.log(`uploaded ${name} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
}
console.log(`release: ${rel.html_url}`);

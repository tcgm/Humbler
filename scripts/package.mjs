// Builds Humbler's installers and archives into release/<version>/.
//
//   node scripts/package.mjs [win|linux|mac]   (default: this OS)
//
// win    Humbler-Setup-<v>.exe        full setup (choose folder, you or everyone)
//        Humbler-QuickSetup-<v>.exe   one-click setup (installs for you, no questions)
//        Humbler-<v>-win-x64.zip      no installer: unzip and run
// linux  Humbler-<v>-linux-x86_64.AppImage, Humbler-<v>-linux-x64.tar.gz
// mac    Humbler-<v>-mac-{x64,arm64}.dmg and .zip (needs a Mac)
//
// Also latest*.yml and *.blockmap: what installed copies update from.
//
// The release feed (where an installed copy looks for newer versions) is the
// repository being built:
//   on GitHub / Gitea Actions    the repository the workflow runs in
//   otherwise                    the "origin" git remote (GitHub or Gitea)
//   HUMBLER_RELEASE_FEED=<url>   that feed instead (several: spaces or commas),
//                                or "none" for no update check
// It's written into the built app's package.json.
//
// Settings are in electron-builder.yml. Both Windows setups install the same
// app; the one-click one is built from the same unpacked app as the full one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedUrl, feedForRepo, releaseDownloads } from "../src/shared/release-feed.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const OUT = path.join(ROOT, "release", pkg.version);
const target = process.argv[2] || { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
if (!["win", "linux", "mac"].includes(target)) {
  console.error(`usage: node scripts/package.mjs [win|linux|mac]`);
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // some hosts set it; it breaks Electron tooling
// CI passes unset secrets as empty strings; electron-builder treats an empty
// CSC_LINK as a path (the project folder) and fails with "not a file".
for (const k of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
  if (env[k] !== undefined && !env[k].trim()) delete env[k];
// No certificate configured: build unsigned instead of searching the keychain.
if (!env.CSC_LINK && !env.WIN_CSC_LINK) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

function releaseFeed() {
  const set = (env.HUMBLER_RELEASE_FEED || "").trim(); // CI passes an unset variable as ""
  if (set) return set;
  // GitHub's and Gitea's runners both say which server and repository they run for
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY)
    return feedForRepo(`${env.GITHUB_SERVER_URL.replace(/\/$/, "")}/${env.GITHUB_REPOSITORY}`) ?? "none";
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" });
  return (origin.status === 0 && feedForRepo(origin.stdout)) || "none";
}
const feed = releaseFeed();
if (feed !== "none" && !feed.split(/[\s,]+/).every(allowedUrl)) {
  console.error(`The release feed must be https:// URLs (http only on your own network), or "none": ${feed}`);
  process.exit(2);
}
console.log(feed === "none" ? "No release feed: built copies won't check for updates." : `Release feed: ${feed}`);
const feedArgs = [`-c.extraMetadata.humbler.releaseFeed=${feed}`];
// the update files' home: this version's release on the same server
const downloads = feed === "none" ? null : releaseDownloads(feed.split(/[\s,]+/)[0], `v${pkg.version}`);
const publishArgs = downloads ? [`-c.publish.url=${downloads}`] : [];
feedArgs.push(...publishArgs);

const bin = (name) => path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
function run(name, args) {
  console.log(`\n> ${name} ${args.join(" ")}`);
  const r = spawnSync(bin(name), args, { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// its own build folder, so packaging never touches out/ (a running dev session uses it)
run("electron-vite", ["build", "--outDir", "out-release"]);

if (target === "win") {
  run("electron-builder", ["--win", "--publish", "never", ...feedArgs]);
  // latest.yml (what installed copies update from) names the full setup; the
  // one-click build below would replace it with its own
  const latest = path.join(OUT, "latest.yml");
  const keep = fs.readFileSync(latest);
  // the one-click setup, from the app just packaged (same feed: it reuses that app as is)
  run("electron-builder", [
    "--win",
    "nsis",
    "--prepackaged",
    path.join(OUT, "win-unpacked"),
    "--publish",
    "never",
    "-c.nsis.oneClick=true",
    "-c.nsis.allowToChangeInstallationDirectory=false",
    "-c.nsis.artifactName=Humbler-QuickSetup-${version}.${ext}",
    ...publishArgs,
  ]);
  fs.writeFileSync(latest, keep);
} else if (target === "linux") {
  run("electron-builder", ["--linux", "--publish", "never", ...feedArgs]);
} else {
  run("electron-builder", ["--mac", "--publish", "never", ...feedArgs]);
}

// what to publish: installers, archives and the update files (not the unpacked folders or builder metadata)
const files = fs
  .readdirSync(OUT)
  .filter((f) => (/\.(exe|zip|AppImage|tar\.gz|dmg|deb|blockmap)$/.test(f) || /^latest.*\.yml$/.test(f)) && !f.startsWith("__"))
  .sort();
console.log(`\nBuilt in ${path.relative(ROOT, OUT)}:`);
for (const f of files) console.log(`  ${f}  (${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1)} MB)`);

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
// The release feed (where an installed copy looks for newer versions) is never
// stored in the repository; it's written into the built app's package.json:
//   HUMBLER_RELEASE_FEED=<url>   use this feed (empty: none)
//   on GitHub Actions            this repository's GitHub releases
//   otherwise                    none (no update check)
//
// Settings are in electron-builder.yml. Both Windows setups install the same
// app; the one-click one is built from the same unpacked app as the full one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// No certificate configured: build unsigned instead of searching the keychain.
if (!env.CSC_LINK && !env.WIN_CSC_LINK) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

function releaseFeed() {
  if (env.HUMBLER_RELEASE_FEED !== undefined) return env.HUMBLER_RELEASE_FEED.trim();
  // Gitea's runner sets GITHUB_* too, with its own server URL: only github.com counts here
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_SERVER_URL === "https://github.com" && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || ""))
    return `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases/latest`;
  return "";
}
const feed = releaseFeed();
if (feed && !/^https:\/\/\S+$/.test(feed)) {
  console.error(`HUMBLER_RELEASE_FEED must be an https:// URL`);
  process.exit(2);
}
console.log(feed ? `Release feed: ${feed}` : "No release feed: built copies won't check for updates.");
const feedArgs = [`-c.extraMetadata.humbler.releaseFeed=${feed}`];

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
  ]);
} else if (target === "linux") {
  run("electron-builder", ["--linux", "--publish", "never", ...feedArgs]);
} else {
  run("electron-builder", ["--mac", "--publish", "never", ...feedArgs]);
}

// what to publish: installers and archives (not the unpacked folders or builder metadata)
const files = fs
  .readdirSync(OUT)
  .filter((f) => /\.(exe|zip|AppImage|tar\.gz|dmg|deb)$/.test(f) && !f.startsWith("__"))
  .sort();
console.log(`\nBuilt in ${path.relative(ROOT, OUT)}:`);
for (const f of files) console.log(`  ${f}  (${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1)} MB)`);

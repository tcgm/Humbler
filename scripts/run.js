// Runs electron-vite (dev / build / preview) with a clean environment.
// Some hosts (VS Code terminals, tooling) export ELECTRON_RUN_AS_NODE=1,
// which makes Electron behave like plain Node and the app silently never
// opens a window.
//
//   node scripts/run.js dev     -> electron-vite dev (HMR)
//   node scripts/run.js start   -> electron-vite build, then preview
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const bin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron-vite.cmd" : "electron-vite");

const [mode, ...rest] = process.argv.slice(2);
const run = (args, opts = {}) => spawnSync(bin, args, { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32", ...opts });

if (mode === "start") {
  const built = run(["build"]);
  if (built.status !== 0) process.exit(built.status ?? 1);
  const child = spawn(bin, ["preview", ...rest], { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const child = spawn(bin, [mode || "dev", ...rest], { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

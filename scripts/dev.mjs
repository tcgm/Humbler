// Dev mode: like `electron-vite dev --watch`, but main-process rebuilds
// don't hard-kill the app.
//
// electron-vite kills Electron on every main rebuild (on Windows that
// skips before-quit, so cookies aren't flushed) and restarts it once per
// save. Here instead:
//   - rebuilds are batched (restart ~1s after the last one);
//   - the app is *asked* to restart (over the IPC channel). It quits
//     normally right away when idle, or as soon as a Sync / reveal /
//     download batch finishes, so work isn't cut off halfway;
//   - it exits with RESTART_CODE and is started again here.
// Renderer changes are still hot-reloaded (Vite HMR), preload changes still
// reload the window. Closing the app ends dev mode.
import { spawn } from "node:child_process";
import { ensureCookieEncryption } from "./fuses.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer, mergeConfig } from "vite";
import { resolveConfig } from "electron-vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESTART_CODE = 75; // must match src/main (dev restart)
const SETTLE_MS = 1000;
const electronPath = createRequire(import.meta.url)("electron");
const say = (msg) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`);

process.env.NODE_ENV_ELECTRON_VITE = "development";
const { config } = await resolveConfig({ root: ROOT, build: { watch: {} } }, "serve", "development");

// Build `cfg` in watch mode; resolves after the first build, then calls onRebuild.
function watchBuild(cfg, onRebuild) {
  return new Promise((resolve, reject) => {
    let first = true;
    const plugin = {
      name: "humbler:dev-watch",
      closeBundle() {
        if (first) {
          first = false;
          resolve();
        } else onRebuild();
      },
    };
    build(mergeConfig(cfg, { plugins: [plugin], build: { watch: {} } })).catch((e) => (first ? reject(e) : console.error(e)));
  });
}

let app = null; // the running Electron process
let restartTimer = null;
let restartRequested = false;

async function startApp() {
  restartRequested = false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // encrypted cookie store (your login); can only be switched while the app is closed
  if ((await ensureCookieEncryption()) === "flipped") env.HUMBLER_RESEAL_COOKIES = "1";
  app = spawn(electronPath, ["."], { cwd: ROOT, env, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  app.on("exit", (code, signal) => {
    app = null;
    if (code === RESTART_CODE) {
      say("restarting the app with the new main-process code…");
      void startApp();
    } else {
      say(`app closed (${signal || code}); stopping dev mode`);
      process.exit(code ?? 0);
    }
  });
}

function requestRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!app) return;
    if (!app.connected) {
      app.kill();
      return;
    }
    if (!restartRequested) say("main process rebuilt; the app will restart as soon as it's idle");
    restartRequested = true;
    app.send({ type: "humbler:dev-restart" });
  }, SETTLE_MS);
}

let server = null;
await watchBuild(config.main, requestRestart);
say("main built");
await watchBuild(config.preload, () => {
  say("preload rebuilt; reloading the window");
  server?.ws.send({ type: "full-reload" });
});
say("preload built");
server = await createServer(config.renderer);
await server.listen();
const { host, port } = server.config.server;
process.env.ELECTRON_RENDERER_URL = `http://${host || "127.0.0.1"}:${port}`;
server.printUrls();
await startApp();

say('type "rs" + Enter to restart the app (when idle)');
process.stdin.setEncoding("utf8");
process.stdin.on("data", (line) => {
  if (line.trim() === "rs") requestRestart();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (app ? app.kill() : process.exit(0)));

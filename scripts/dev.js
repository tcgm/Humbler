// Dev mode: `npm run dev`.
//   - renderer/ changes  -> reload just the Humbler UI panel (the Humble
//                           pane, its login and running downloads are untouched)
//   - main.js, preload.js, lib/ changes -> restart the app cleanly (a normal
//                           quit, so cookies are flushed first)
//   - DevTools open for the Humbler UI (HUMBLER_DEV=1)
// Closing the window yourself ends dev mode.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const ROOT = path.resolve(__dirname, "..");
const env = { ...process.env, HUMBLER_DEV: "1" };
delete env.ELECTRON_RUN_AS_NODE; // see start.js

let child = null;
let restarting = false;

function start() {
  // 'ipc' lets us ask the app to quit/reload instead of killing it.
  child = spawn(electron, [".", ...process.argv.slice(2)], { cwd: ROOT, env, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  child.on("exit", (code) => {
    child = null;
    if (restarting) {
      restarting = false;
      start();
    } else {
      process.exit(code ?? 0); // window closed by you: dev mode ends too
    }
  });
}

function restart(why) {
  if (restarting || !child) return;
  console.log(`[dev] ${why}: restarting Humbler…`);
  restarting = true;
  const c = child;
  try {
    c.send({ humblerDev: "quit" });
  } catch {
    c.kill();
  }
  // If it hasn't quit (e.g. stuck), stop waiting after 10s.
  setTimeout(() => {
    if (child === c) c.kill();
  }, 10000);
}

function reloadUi(why) {
  if (!child) return;
  console.log(`[dev] ${why}: reloading UI`);
  try {
    child.send({ humblerDev: "reload-ui" });
  } catch {
    restart(why);
  }
}

// Debounced, recursive watchers (fs.watch recursive works on Windows and macOS).
// Windows also reports a file as "changed" when it's merely read (Electron
// loading lib/ on startup), so act only when the modification time or size
// actually changed.
const pending = new Map();
const stamps = new Map();
function reallyChanged(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    st = null; // deleted
  }
  const stamp = st ? `${st.mtimeMs}:${st.size}` : "gone";
  const prev = stamps.get(abs);
  stamps.set(abs, stamp);
  return prev !== undefined && prev !== stamp;
}
function snapshot(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(abs);
    else reallyChanged(abs);
  }
}
function watch(rel, onChange) {
  const dir = path.join(ROOT, rel);
  snapshot(dir);
  fs.watch(dir, { recursive: true }, (_event, file) => {
    if (!file || /(^|[\\/])\.|~$|\.tmp$/.test(file)) return;
    if (!reallyChanged(path.join(dir, file))) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => onChange(path.join(rel, file)), 300));
  });
}

watch("renderer", (f) => reloadUi(`${f} changed`));
watch("lib", (f) => restart(`${f} changed`));
// Single files at the root: watch the root non-recursively and filter.
for (const f of ["main.js", "preload.js"]) reallyChanged(path.join(ROOT, f));
fs.watch(ROOT, (_event, file) => {
  if (file !== "main.js" && file !== "preload.js") return;
  if (!reallyChanged(path.join(ROOT, file))) return;
  clearTimeout(pending.get(file));
  pending.set(file, setTimeout(() => restart(`${file} changed`), 300));
});

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    restarting = false;
    if (!child) process.exit(0);
    try {
      child.send({ humblerDev: "quit" });
    } catch {
      child.kill();
    }
  });
}

console.log("[dev] Humbler dev mode: renderer/ reloads the UI, main.js/preload.js/lib/ restart the app. Close the window to stop.");
start();

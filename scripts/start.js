// Launches Electron with a clean environment. Some hosts (VS Code terminals,
// tooling) export ELECTRON_RUN_AS_NODE=1, which makes Electron behave like
// plain Node and the app silently never opens a window.
const { spawn } = require("node:child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env, cwd: __dirname + "/.." });
child.on("exit", (code) => process.exit(code ?? 0));

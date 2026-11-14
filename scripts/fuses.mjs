// Turns on Electron's cookie encryption for the Electron binary Humbler runs
// on (node_modules/electron/dist). Your Humble login lives in that cookie
// store (data/electron-userdata); by default Chromium stores cookie values
// in plain text there. With the EnableCookieEncryption fuse on, they're
// encrypted with the same OS-protected key as Humbler's stored keys (on
// Windows: DPAPI via electron-userdata/Local State).
//
// One-way: existing cookies stay readable and are encrypted as they're next
// written; turning the fuse off again later would make the cookie store
// unreadable (you'd just log in again).
//
// The fuse is a flag inside electron.exe itself, so reinstalling Electron
// (npm install) resets it; run.js / dev.mjs call this before every launch.
// Humbler must be closed while it's flipped (Windows locks a running exe).
//
//   node scripts/fuses.mjs           check, and turn it on if needed
//   node scripts/fuses.mjs --check   only report
//
// Returns "on" (already), "flipped" (just turned on: the launcher then sets
// HUMBLER_RESEAL_COOKIES=1 so the app re-saves its existing cookies, which
// writes them encrypted), or false.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function ensureCookieEncryption({ checkOnly = false, exe = null } = {}) {
  let fuses;
  try {
    fuses = await import("@electron/fuses");
  } catch {
    console.log("[fuses] @electron/fuses isn't installed; cookies (your login) stay unencrypted. npm install to add it.");
    return false;
  }
  const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } = fuses;
  exe ||= require("electron"); // path to the binary
  const isOn = async () => (await getCurrentFuseWire(exe))[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE;
  if (await isOn()) return "on";
  if (checkOnly) {
    console.log("[fuses] cookie encryption is off");
    return false;
  }
  try {
    await flipFuses(exe, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  } catch (err) {
    console.log(`[fuses] couldn't turn on cookie encryption (${err.code || err.message}); is Humbler still running? It'll be tried again on the next start.`);
    return false;
  }
  const ok = await isOn();
  console.log(ok ? "[fuses] cookie encryption turned on: your Humble login will be stored encrypted." : "[fuses] cookie encryption didn't take effect");
  return ok ? "flipped" : false;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("fuses.mjs")) {
  const state = await ensureCookieEncryption({ checkOnly: process.argv.includes("--check") });
  if (state) console.log("[fuses] cookie encryption: on");
}

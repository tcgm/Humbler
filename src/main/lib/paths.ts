import path from "node:path";
import * as electron from "electron";

// Project root. The bundled main file lives in out/main/, so a
// __dirname-relative path no longer points at the project: inside
// Electron's main process use the app path; anywhere else (plain Node, e.g.
// `tsx scripts/scrub-data.ts`, where the electron package just exports the
// binary's path string) use the working directory.
function projectRoot(): string {
  const app = (electron as any).app as { getAppPath?: () => string } | undefined;
  if (process.versions.electron && typeof app?.getAppPath === "function") return app.getAppPath();
  return process.cwd();
}

export const ROOT = projectRoot();
// HUMBLER_DATA_DIR points a run (tests, a second profile) at a different
// data folder, so it can never touch your real login, keys or downloads.
export const DATA_DIR = process.env.HUMBLER_DATA_DIR ? path.resolve(process.env.HUMBLER_DATA_DIR) : path.join(ROOT, "data");

export const USERDATA_DIR = path.join(DATA_DIR, "electron-userdata");
export const ORDERS_DIR = path.join(DATA_DIR, "orders");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
// Append-only safety record of every key Humbler has revealed. Revealing
// is one-way, so a key must never exist only in memory.
export const REVEALED_LOG = path.join(DATA_DIR, "revealed-keys.jsonl");
export const DOWNLOADED_INDEX = path.join(DATA_DIR, "downloaded.jsonl");
export const LOG_PATH = path.join(DATA_DIR, "humbler.log");
export const RECON_DIR = path.join(DATA_DIR, "recon");
export const DEFAULT_DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");

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

// Where Humbler keeps your data. From source (npm run dev / prod): data/ in
// the project. Installed (a packaged build, whose program folder is
// read-only): the per-user app data folder, i.e. %APPDATA%\Humbler on
// Windows, ~/Library/Application Support/Humbler on macOS, ~/.config/Humbler
// on Linux. HUMBLER_DATA_DIR points a run (tests, a second profile) at a
// different folder, so it can never touch your real login, keys or downloads.
function dataDir(): string {
  if (process.env.HUMBLER_DATA_DIR) return path.resolve(process.env.HUMBLER_DATA_DIR);
  const app = (electron as any).app as { isPackaged?: boolean; getPath?: (name: string) => string } | undefined;
  if (process.versions.electron && app?.isPackaged && app.getPath) return path.join(app.getPath("appData"), "Humbler");
  return path.join(ROOT, "data");
}
export const DATA_DIR = dataDir();

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

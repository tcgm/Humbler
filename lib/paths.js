const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

module.exports = {
  ROOT,
  DATA_DIR,
  USERDATA_DIR: path.join(DATA_DIR, "electron-userdata"),
  ORDERS_DIR: path.join(DATA_DIR, "orders"),
  SETTINGS_PATH: path.join(DATA_DIR, "settings.json"),
  // Append-only safety record of every key Humbler has revealed. Revealing
  // is one-way, so a key must never exist only in memory.
  REVEALED_LOG: path.join(DATA_DIR, "revealed-keys.jsonl"),
  DOWNLOADED_INDEX: path.join(DATA_DIR, "downloaded.jsonl"),
  LOG_PATH: path.join(DATA_DIR, "humbler.log"),
  RECON_DIR: path.join(DATA_DIR, "recon"),
  DEFAULT_DOWNLOAD_DIR: path.join(DATA_DIR, "downloads"),
};

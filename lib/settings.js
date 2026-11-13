const fs = require("node:fs");
const path = require("node:path");
const { SETTINGS_PATH, DEFAULT_DOWNLOAD_DIR } = require("./paths");

const NAMING = ["original", "title"];

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    // first run / unreadable — fall back to defaults
  }
  return {
    downloadDir: path.resolve(saved.downloadDir || process.env.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR),
    // "original" = Humble's file names; "title" = "<Product> - <Publisher>.<ext>"
    naming: NAMING.includes(saved.naming) ? saved.naming : "original",
    // highlight things you already own on Humble's store/bundle/Choice pages
    markOwned: saved.markOwned !== false,
    // continuously catalog every endpoint Humble's pages call (data/recon/live)
    liveScout: saved.liveScout !== false,
  };
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

module.exports = { load, save, NAMING };

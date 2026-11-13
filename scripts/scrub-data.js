// Re-scrubs every existing scout dump and raw harvest in place
// (data/recon/, data/harvest/). Use it on dumps made before scrubbing
// existed, or after syncing new keys, since a sync can make keys "known"
// that an earlier dump only caught by pattern. Safe to run any number of
// times.
//
//   npm run scrub-data
const fs = require("node:fs");
const path = require("node:path");
const { makeScrubber } = require("../lib/scrub");
const { RECON_DIR } = require("../lib/paths");
const { HARVEST_DIR } = require("../lib/harvest");

const scrub = makeScrubber();
let files = 0;
let failed = 0;

function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    let full = path.join(dir, name);
    // Older dump folders were named after the raw page URL, which could
    // include a gamekey (…downloads-key-<gamekey>).
    const cleanName = scrub.scrubText(name);
    if (cleanName !== name) {
      const renamed = path.join(dir, cleanName);
      fs.renameSync(full, renamed);
      full = renamed;
    }
    if (fs.statSync(full).isDirectory()) {
      visit(full);
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    try {
      let data = text;
      if (full.endsWith(".json")) {
        try {
          data = JSON.parse(text);
        } catch {
          // not valid JSON — scrub it as text
        }
      }
      scrub.writeScrubbed(full, data);
      files += 1;
    } catch (err) {
      // A known key survived scrubbing: delete rather than keep a leak.
      fs.rmSync(full, { force: true });
      failed += 1;
      console.error(`DELETED ${full}: ${err.message}`);
    }
  }
}

visit(RECON_DIR);
visit(HARVEST_DIR);
const s = scrub.stats;
console.log(
  `Scrubbed ${files} file(s)${failed ? `, deleted ${failed} that could not be cleaned` : ""}: ` +
    `${s.keys} known key(s), ${s.fields} secret field(s), ${s.patterns} key-shaped string(s), ` +
    `${s.gamekeys} gamekey(s) aliased, ${s.tokens} URL token(s).`,
);

// Re-scrubs every existing scout dump and raw harvest in place
// (data/recon/, data/harvest/). Use it on dumps made before scrubbing
// existed, or after syncing new keys, since a sync can make keys "known"
// that an earlier dump only caught by pattern. Safe to run any number of
// times.
//
//   npm run scrub-data
import fs from "node:fs";
import path from "node:path";
import { makeScrubber } from "../src/main/lib/scrub";
import { DATA_DIR, RECON_DIR } from "../src/main/lib/paths";
import { HARVEST_DIR } from "../src/main/lib/harvest";

const scrub = makeScrubber();
// Stored keys are encrypted (see src/main/lib/secret-store.ts) and only the
// app can open them, so here known keys can't be matched exactly; the
// pattern layers still apply. The app scrubs everything it writes with the
// full list.
try {
  if (fs.readFileSync(path.join(DATA_DIR, "library-v2.json"), "utf8").includes('"sealed1:'))
    console.log("Note: stored keys are encrypted, so this script scrubs by pattern only (the app itself uses the exact keys).");
} catch {
  // no library yet
}
let files = 0;
let failed = 0;

function visit(dir: string): void {
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
      let data: unknown = text;
      if (full.endsWith(".json")) {
        try {
          data = JSON.parse(text);
        } catch {
          // not valid JSON, so scrub it as text
        }
      }
      scrub.writeScrubbed(full, data);
      files += 1;
    } catch (err: any) {
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

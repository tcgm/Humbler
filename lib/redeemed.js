// Which keys you've actually redeemed on their platform (Steam, GOG...).
// Humble only knows a key was *revealed*; whether you then activated it on
// Steam is something only you know. Humbler asks when you come back from
// a Redeem link, and keeps the answer here.
//
// data/redeemed.json: { "<key id>": { at: ISO date, platform: "Steam" } }
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./paths");

const REDEEMED_PATH = path.join(DATA_DIR, "redeemed.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(REDEEMED_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(map) {
  fs.mkdirSync(path.dirname(REDEEMED_PATH), { recursive: true });
  const tmp = `${REDEEMED_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, REDEEMED_PATH);
}

// redeemed = true records it; false removes it (undo / "not yet").
function mark(id, { redeemed, platform }) {
  const map = load();
  if (redeemed) map[id] = { at: new Date().toISOString(), platform: platform || null };
  else delete map[id];
  save(map);
  return map[id] || null;
}

module.exports = { load, mark };

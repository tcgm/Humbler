// Which keys you've actually redeemed on their platform (Steam, GOG...).
// Humble only knows a key was *revealed*; whether you then activated it on
// Steam is something only you know. Humbler asks when you come back from
// a Redeem link, and keeps the answer here.
//
// data/redeemed.json: { "<key id>": { at: ISO date, platform: "Steam" } }
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import type { PlatformRedeemed } from "../../shared/types";

const REDEEMED_PATH = path.join(DATA_DIR, "redeemed.json");

export type RedeemedMap = Record<string, PlatformRedeemed>;

export function load(): RedeemedMap {
  try {
    return JSON.parse(fs.readFileSync(REDEEMED_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(map: RedeemedMap): void {
  fs.mkdirSync(path.dirname(REDEEMED_PATH), { recursive: true });
  const tmp = `${REDEEMED_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, REDEEMED_PATH);
}

// redeemed = true records it; false removes it (undo / "not yet").
export function mark(id: string, { redeemed, platform }: { redeemed: boolean; platform?: string | null }): PlatformRedeemed | null {
  const map = load();
  if (redeemed) map[id] = { at: new Date().toISOString(), platform: platform || null };
  else delete map[id];
  save(map);
  return map[id] || null;
}

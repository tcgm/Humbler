// Title matching, shared by the main process (notifications) and the UI
// (wishlists, My Steam, On Sale). Humble's data rarely has Steam app ids, so
// games are matched by title at two strengths:
//   exact:  the same title once case, punctuation and ™/®/(tm) are ignored
//   likely: the same once edition words ("Deluxe Edition", "(Steam)",
//           "- Complete Edition", a leading "The"/"A") are dropped too, so
//           "LEGO® DC Super-Villains (DELUXE EDITION)" finds "LEGO DC Super-Villains"

/** Lowercase, no ™/®/©, punctuation to single spaces. */
export const normTitle = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();

const strip = (s: string) =>
  String(s || "")
    .replace(/\((?:tm|r|c)\)/gi, " ")
    .replace(/\s*[([]\s*steam(?:\s+key)?\s*[)\]]\s*$/i, "")
    .replace(/\s+[-–—:]\s*steam(?:\s+key)?\s*$/i, "");

/** exact-match form */
export const exactTitle = (s: string): string => normTitle(strip(s));

const EDITION_WORD =
  /\s(?:(?:digital\s)?(?:super\s)?deluxe|ultimate|complete|definitive|premium|gold|goty|game of the year|enhanced|special|collectors?|anniversary|standard|legendary|deluxe|awesome|first month|director s cut)(?:\s(?:edition|collection|version|pack))?$/;

/** likely-match form: edition words and leading articles dropped */
export function looseTitle(s: string): string {
  let t = exactTitle(s).replace(/(?:^|\s)(?:the\s)?(?:complete\s)?(?:edition|collection)$/, "").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(EDITION_WORD, "").trim();
  }
  return t.replace(/^(?:the|a)\s/, "");
}

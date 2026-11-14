// What's already on disk: scans your download folders (names only, no
// contents) and matches them to bundles and files.
//
// Real collections are laid out many ways, and all of these are recognised:
//   <root>/<bundle>/<product>/<file>            Humbler's own layout
//   <root>/HumbleBundle/<Bundle Title>/<label>/<Title - Publisher>.<ext>
//                                               the Humble Bundle Downloader extension
//   <root>/<bundle folder>/<original file>      flat, Humble's file names
//   <root>/<bundle>/<zip name | machine name>/  extracted archives
// Bundle folders are matched to bundles by name, loosely ("BIGGEST GRAPHICS
// EVER Bundle" = "Humble BIGGEST GRAPHICS EVER Bundle"), or by a link you set.
// Only 3 levels inside each bundle folder are read: extracted asset packs can
// hold hundreds of thousands of files, and matching never needs them.
import fs from "node:fs";
import path from "node:path";

const SKIP = /^(__MACOSX|\.DS_Store|\$RECYCLE\.BIN|System Volume Information|desktop\.ini|Thumbs\.db|\..*)$/i;
const MAX_DEPTH = 3; // levels read inside each bundle folder
// ...and inside a HumbleBundle/ folder (the downloader extension's
// HumbleBundle/<bundle title>/<label>/<file>), however deep it sits
const EXTENSION_DEPTH = 3;
const EXTENSION_DIR = /^humble ?bundle$/i;
const MAX_ENTRIES = 3_000_000; // safety stop

export interface DiskEntry {
  path: string;
  lower: string; // file/dir name, lowercased
  dir: boolean;
  bundleDir: string | null; // the top-level bundle folder it's in
}

export interface BundleDir {
  path: string;
  name: string;
  root: string;
}

export interface DiskScan {
  at: string;
  roots: string[];
  missingRoots: string[];
  bundleDirs: BundleDir[];
  byName: Map<string, DiskEntry[]>; // lowercased name -> entries (files and dirs)
  files: number;
  dirs: number;
  ms: number;
  truncated: boolean;
}

function add(map: Map<string, DiskEntry[]>, e: DiskEntry) {
  const list = map.get(e.lower);
  if (list) list.push(e);
  else map.set(e.lower, [e]);
}

async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isDirent = async (full: string, d: fs.Dirent): Promise<boolean> => {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try {
    return (await fs.promises.stat(full)).isDirectory();
  } catch {
    return false;
  }
};

/** Scan `roots` (names only). */
export async function scanFolders(roots: string[]): Promise<DiskScan> {
  const t0 = Date.now();
  const scan: DiskScan = { at: new Date().toISOString(), roots, missingRoots: [], bundleDirs: [], byName: new Map(), files: 0, dirs: 0, ms: 0, truncated: false };
  const seenReal = new Set<string>();

  const walk = async (dir: string, depth: number, bundleDir: string, maxDepth = MAX_DEPTH): Promise<void> => {
    if (depth > maxDepth || scan.truncated) return;
    for (const d of await readDir(dir)) {
      if (SKIP.test(d.name)) continue;
      if (scan.files + scan.dirs > MAX_ENTRIES) {
        scan.truncated = true;
        return;
      }
      const full = path.join(dir, d.name);
      const isDir = await isDirent(full, d);
      add(scan.byName, { path: full, lower: d.name.toLowerCase(), dir: isDir, bundleDir });
      if (isDir) {
        scan.dirs += 1;
        await walk(full, depth + 1, bundleDir, EXTENSION_DIR.test(d.name) ? Math.max(maxDepth, depth + 1 + EXTENSION_DEPTH) : maxDepth);
      } else scan.files += 1;
    }
  };

  const scanRoot = async (root: string, depth = 0): Promise<void> => {
    let real: string;
    try {
      real = await fs.promises.realpath(root);
    } catch {
      scan.missingRoots.push(root);
      return;
    }
    if (seenReal.has(real.toLowerCase())) return; // the same folder listed twice (or via a link)
    seenReal.add(real.toLowerCase());
    for (const d of await readDir(root)) {
      if (SKIP.test(d.name)) continue;
      const full = path.join(root, d.name);
      if (!(await isDirent(full, d))) {
        add(scan.byName, { path: full, lower: d.name.toLowerCase(), dir: false, bundleDir: null });
        scan.files += 1;
        continue;
      }
      // The downloader extension keeps everything under HumbleBundle/.
      if (depth === 0 && EXTENSION_DIR.test(d.name)) {
        await scanRoot(full, 1);
        continue;
      }
      scan.dirs += 1;
      scan.bundleDirs.push({ path: full, name: d.name, root });
      add(scan.byName, { path: full, lower: d.name.toLowerCase(), dir: true, bundleDir: full });
      await walk(full, 1, full);
    }
  };

  for (const r of roots) await scanRoot(r);
  scan.ms = Date.now() - t0;
  return scan;
}

// ---- matching -----------------------------------------------------------------

const STOP = new Set(["humble", "bundle", "the", "a", "an", "and", "of", "for", "by", "pay", "what", "you", "want", "help", "charity", "s"]);

/** Bundle/folder name -> comparable tokens. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\(\d{1,2}_\d{1,2}_\d{2,4}[^)]*\)/g, " ") // "(7_21_2024 12_18_15 AM)" from saved pages
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

const jaccard = (a: string[], b: string[]): number => {
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const t of A) if (B.has(t)) both += 1;
  return both / (A.size + B.size - both || 1);
};

/** The words of a bundle's name that people keep when naming its folder:
 *  without "Humble Book Bundle:"-style prefixes and "by Publisher" suffixes. */
export function bundleNameVariants(name: string): string[][] {
  const core = name
    .replace(/^[^:]*\bbundles?\b[^:]*:\s*/i, "") // "Humble RPG Book Bundle: X", "The Best of Humble Bundle: X"
    .replace(/\s+by\s+[^:]+$/i, ""); // "... by R. Talsorian"
  const variants = [nameTokens(name), nameTokens(core)];
  return variants.filter((v, i) => v.length && (i === 0 || v.join(" ") !== variants[0].join(" ")));
}

/** Which bundle folders belong to which bundle (gamekey -> folder paths). */
export function matchBundleDirs(
  bundles: { gamekey: string; name: string }[],
  dirs: BundleDir[],
  links: Record<string, string | null>, // folder path -> gamekey (null = "not a bundle")
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (gk: string, p: string) => out.set(gk, [...(out.get(gk) || []), p]);
  const cands = bundles.flatMap((b) => bundleNameVariants(b.name).map((t) => ({ gk: b.gamekey, t, key: t.join(" ") })));
  // the same bundle bought more than once: all its copies share a folder
  const sameName = new Map(bundles.map((b) => [b.gamekey, nameTokens(b.name).join(" ")]));
  const byKey = new Map<string, Set<string>>();
  for (const c of cands) byKey.set(c.key, (byKey.get(c.key) || new Set()).add(c.gk));
  for (const d of dirs) {
    if (d.path in links) {
      const gk = links[d.path];
      if (gk) push(gk, d.path);
      continue;
    }
    const t = nameTokens(d.name);
    const key = t.join(" ");
    if (!key) continue;
    // 1. same words
    const exact = byKey.get(key);
    if (exact && new Set([...exact].map((g) => sameName.get(g))).size === 1) {
      for (const gk of exact) push(gk, d.path);
      continue;
    }
    // 2. nearly the same words, or 3. a shortened name: every word of the
    // folder's name is in the bundle's (one long word, or two or more).
    // Only when exactly one bundle fits best; ties are left for you to link.
    const T = new Set(t);
    const distinctive = t.length >= 2 || (t.length === 1 && t[0].length >= 6);
    const scored = new Map<string, number>();
    for (const c of cands) {
      const j = jaccard(t, c.t);
      const covered = distinctive && t.every((x) => c.t.includes(x));
      const s = j >= 0.75 ? 1 + j : covered ? j : 0;
      if (s > (scored.get(c.gk) || 0)) scored.set(c.gk, s);
    }
    const ranked = [...scored].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    if (!ranked.length || !T.size) continue;
    const top = ranked.filter(([, s]) => ranked[0][1] - s < 0.1); // the best, and anything about as good
    if (new Set(top.map(([gk]) => sameName.get(gk))).size === 1) for (const [gk] of top) push(gk, d.path);
  }
  return out;
}

/** How the Humble Bundle Downloader extension names a file: "<Title> - <Publisher>.<ext>". */
export const extensionStyleName = (title: string, publisher: string | null, ext: string): string => {
  const clean = (s: string) => s.trim().replace(/ ?[^a-zA-Z0-9#,&\-+.' ] ?/g, " - ");
  return `${publisher ? `${clean(title)} - ${publisher}` : clean(title)}.${ext}`.toLowerCase();
};

/** Is this a whole zip (its end-of-archive record is there)? null if not a zip. */
function zipComplete(p: string): boolean | null {
  if (!/\.zip$/i.test(p)) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, 65557); // the record is in the last 22 bytes + up to 64k of comment
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** Words of a title, for pairing renamed files. */
const titleWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));

/** A title for loose comparison: letters and digits only. */
const titleKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const GENERIC = /^(readme|license|licence|index|setup|install|manual|cover|thumbs?|preview|changelog)(\.\w+)?$/i;

export interface FileLike {
  id: string;
  gamekey: string;
  filename: string;
  product: string;
  publisher: string | null;
  size: number;
  machineName?: string | null;
}

export interface FileOnDisk {
  path: string;
  how: "file" | "extracted" | "size-differs" | "older-version";
}

/** Find each file on disk: in its bundle's folders first, then anywhere if the name is distinctive. */
export function matchFiles(files: FileLike[], scan: DiskScan, bundleDirs: Map<string, string[]>): Map<string, FileOnDisk> {
  const out = new Map<string, FileOnDisk>();
  const sizes = new Map<string, number>();
  const sizeOf = (p: string): number => {
    let n = sizes.get(p);
    if (n === undefined) {
      try {
        n = fs.statSync(p).size;
      } catch {
        n = -1;
      }
      sizes.set(p, n);
    }
    return n;
  };
  // Files in bundle folders by "<title>" (the extension's "<Title> - <Publisher>.ext",
  // and browser copies "name(1).ext"), for when the publisher isn't known:
  // bundle dir -> ".ext|normalized title" -> entries.
  const byTitle = new Map<string, Map<string, DiskEntry[]>>();
  for (const list of scan.byName.values()) {
    for (const e of list) {
      if (e.dir || !e.bundleDir) continue;
      const ext = path.extname(e.lower);
      const stem = path.basename(e.lower, ext).replace(/\s*\(\d+\)$/, "");
      const keys = new Set([titleKey(stem)]);
      const dash = stem.lastIndexOf(" - ");
      if (dash > 0) keys.add(titleKey(stem.slice(0, dash)));
      let m = byTitle.get(e.bundleDir);
      if (!m) byTitle.set(e.bundleDir, (m = new Map()));
      for (const k of keys) if (k.length >= 3) m.set(`${ext}|${k}`, [...(m.get(`${ext}|${k}`) || []), e]);
    }
  }
  const looseCache = new Map<string, DiskEntry[]>();
  const looseFiles = (bundleDir: string): DiskEntry[] => {
    let l = looseCache.get(bundleDir);
    if (!l) {
      l = [];
      for (const list of scan.byName.values()) for (const e of list) if (!e.dir && e.bundleDir === bundleDir) l.push(e);
      looseCache.set(bundleDir, l);
    }
    return l;
  };
  const bySize: { f: FileLike; e: DiskEntry }[] = [];
  // a product with several files of one type can't be matched by its title
  const perTitle = new Map<string, number>();
  for (const f of files) {
    const k = `${f.gamekey}|${path.extname(f.filename).toLowerCase()}|${titleKey(f.product)}`;
    perTitle.set(k, (perTitle.get(k) || 0) + 1);
  }
  for (const f of files) {
    const ext = path.extname(f.filename).slice(1);
    const stem = path.basename(f.filename, path.extname(f.filename)).toLowerCase();
    const names = [f.filename.toLowerCase(), ext ? extensionStyleName(f.product, f.publisher, ext) : "", ext ? extensionStyleName(f.product, null, ext) : ""].filter(Boolean);
    const dirNames = [stem, (f.machineName || "").toLowerCase()].filter((n) => n.length >= 4);
    const mine = new Set(bundleDirs.get(f.gamekey) || []);
    const pick = (cands: DiskEntry[]): DiskEntry | null => {
      const inBundle = cands.filter((e) => e.bundleDir && mine.has(e.bundleDir));
      if (inBundle.length) return inBundle[0];
      // elsewhere: only distinctive names, and only if there's exactly one
      return cands.length === 1 && !GENERIC.test(cands[0].lower) && cands[0].lower.length >= 8 ? cands[0] : null;
    };
    let hit: FileOnDisk | null = null;
    for (const n of names) {
      const e = pick((scan.byName.get(n) || []).filter((x) => !x.dir));
      if (!e) continue;
      const size = f.size > 0 ? sizeOf(e.path) : -1;
      hit = { path: e.path, how: f.size > 0 && size >= 0 && size !== f.size ? "size-differs" : "file" };
      if (hit.how === "file") break;
    }
    if ((!hit || hit.how === "size-differs") && perTitle.get(`${f.gamekey}|${path.extname(f.filename).toLowerCase()}|${titleKey(f.product)}`) === 1) {
      const key = `${path.extname(f.filename).toLowerCase()}|${titleKey(f.product)}`;
      const cands = [...mine].flatMap((d) => byTitle.get(d)?.get(key) || []);
      // prefer the copy with the right size
      const sized = f.size > 0 ? cands.find((e) => sizeOf(e.path) === f.size) : null;
      const e = sized || cands[0];
      if (sized) hit = { path: sized.path, how: "file" };
      else if (e && !hit) hit = { path: e.path, how: f.size > 0 ? "size-differs" : "file" };
    }
    // still nothing: a file of the same type and exact size in its bundle's
    // folders that nothing else claimed (renamed, or titled differently)
    if (!hit && f.size > 0) {
      const ext = path.extname(f.filename).toLowerCase();
      const same = [...mine].flatMap((d) => looseFiles(d)).filter((e) => path.extname(e.lower) === ext && sizeOf(e.path) === f.size);
      if (same.length === 1) bySize.push({ f, e: same[0] });
    }
    if (!hit || hit.how === "size-differs") {
      for (const n of dirNames) {
        const e = pick((scan.byName.get(n) || []).filter((x) => x.dir && x.path !== x.bundleDir));
        // a same-name file in its own bundle's folder beats an extracted folder elsewhere
        if (e && hit && !(e.bundleDir && mine.has(e.bundleDir))) continue;
        if (e) {
          hit = { path: e.path, how: "extracted" };
          break;
        }
      }
    }
    if (hit) out.set(f.id, hit);
  }
  const claimed = new Set([...out.values()].map((h) => h.path));
  const sizeClaims = new Map<string, number>();
  for (const { e } of bySize) sizeClaims.set(e.path, (sizeClaims.get(e.path) || 0) + 1);
  for (const { f, e } of bySize) {
    if (claimed.has(e.path) || sizeClaims.get(e.path) !== 1) continue;
    out.set(f.id, { path: e.path, how: "file" });
    claimed.add(e.path);
  }

  // Folders the downloader extension made (.../HumbleBundle/<bundle>/...) hold
  // only that bundle's files, so a file there that nothing claimed is one of
  // the bundle's, saved under an older title and size. Pair the leftovers with
  // the bundle's unmatched files of the same type by title words.
  const madeByExtension = (e: DiskEntry): boolean => /[\\/]humble ?bundle[\\/]/i.test(e.path.slice(e.bundleDir?.length || 0));
  const unmatched = new Map<string, FileLike[]>();
  for (const f of files) if (!out.has(f.id)) unmatched.set(f.gamekey, [...(unmatched.get(f.gamekey) || []), f]);
  for (const [gamekey, todo] of unmatched) {
    const left = (bundleDirs.get(gamekey) || []).flatMap((d) => looseFiles(d)).filter((e) => !claimed.has(e.path) && madeByExtension(e));
    if (!left.length) continue;
    // a leftover named exactly after one of the bundle's products is that product's, not a rename
    const titles = new Set(files.filter((f) => f.gamekey === gamekey).map((f) => titleKey(f.product)));
    const pairs: { f: FileLike; e: DiskEntry; score: number }[] = [];
    for (const f of todo) {
      const want = titleWords(f.product);
      if (!want.length) continue;
      const ext = path.extname(f.filename).toLowerCase();
      for (const e of left) {
        if (path.extname(e.lower) !== ext) continue;
        let stem = path.basename(e.lower, ext).replace(/\s*\(\d+\)$/, "");
        const dash = stem.lastIndexOf(" - ");
        if (dash > 0) stem = stem.slice(0, dash); // " - Publisher"
        if (titles.has(titleKey(stem)) && titleKey(stem) !== titleKey(f.product)) continue;
        const have = new Set(titleWords(stem));
        const both = want.filter((w) => have.has(w)).length;
        const score = both / Math.max(want.length, have.size);
        if (both / want.length >= 0.75 && score >= 0.5) pairs.push({ f, e, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedF = new Set<string>();
    for (const { f, e } of pairs) {
      if (usedF.has(f.id) || claimed.has(e.path)) continue;
      usedF.add(f.id);
      claimed.add(e.path);
      out.set(f.id, { path: e.path, how: "older-version" });
    }
  }

  // Same name, other size: an older version if the file is whole, else
  // probably an unfinished download.
  for (const h of out.values()) if (h.how === "size-differs" && zipComplete(h.path) === true) h.how = "older-version";
  return out;
}

/** How well a folder name fits a bundle name, 0..1 (for ranking suggestions). */
export function nameScore(folder: string, bundleName: string): number {
  const t = nameTokens(folder);
  if (!t.length) return 0;
  let best = 0;
  for (const v of bundleNameVariants(bundleName)) {
    const covered = t.filter((x) => v.includes(x)).length / t.length;
    best = Math.max(best, jaccard(t, v), covered * 0.9);
  }
  return best;
}

export const SKIP_NAME = SKIP;

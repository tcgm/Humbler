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

  const walk = async (dir: string, depth: number, bundleDir: string): Promise<void> => {
    if (depth > MAX_DEPTH || scan.truncated) return;
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
        await walk(full, depth + 1, bundleDir);
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
      if (depth === 0 && /^humble ?bundle$/i.test(d.name)) {
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
    .replace(/['’]/g, "")
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
  how: "file" | "extracted" | "size-differs";
}

/** Find each file on disk: in its bundle's folders first, then anywhere if the name is distinctive. */
export function matchFiles(files: FileLike[], scan: DiskScan, bundleDirs: Map<string, string[]>): Map<string, FileOnDisk> {
  const out = new Map<string, FileOnDisk>();
  const sizeOf = (p: string): number => {
    try {
      return fs.statSync(p).size;
    } catch {
      return -1;
    }
  };
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
    if (!hit || hit.how === "size-differs") {
      for (const n of dirNames) {
        const e = pick((scan.byName.get(n) || []).filter((x) => x.dir && x.path !== x.bundleDir));
        if (e) {
          hit = { path: e.path, how: "extracted" };
          break;
        }
      }
    }
    if (hit) out.set(f.id, hit);
  }
  return out;
}

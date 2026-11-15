// Types shared by the main process and the UI: the library index Humbler
// builds, the status it pushes, and the whole IPC API (see api.ts).

export type KeyStatus = "unused" | "revealed" | "gifted" | "link" | "expired" | "sold-out";

/** Your own record that a revealed key was activated on its store. */
export interface PlatformRedeemed {
  at: string;
  platform: string | null;
  /** Humble redeemed it to your linked account itself (keyless Epic/GOG/Battle.net, Ubisoft direct) */
  auto?: boolean;
  account?: string | null; // the linked account's name, when Humble says
}

export interface KeyEntry {
  id: string;
  gamekey: string; // bundle id (legacy gamekey, or 2026-site productEntitlementId)
  bundle: string;
  created: string | null;
  name: string;
  machineName: string;
  keyindex: number;
  keyType: string;
  key: string | null;
  status: KeyStatus;
  expired: boolean;
  soldOut: boolean;
  gift: boolean;
  steamAppId: string | number | null;
  instructions: string | null;
  /** links inside the redeem instructions (always opened in your browser) */
  instructionLinks?: { href: string; text: string }[];
  expiry: string | null;
  daysLeft: number | null;
  platformRedeemed?: PlatformRedeemed | null;
  // 2026-site keys
  v2?: boolean;
  notGiftable?: boolean;
  contentUrl?: string;
  choiceMonth?: string | null;
  itemId?: string;
  /** set when Humble redeemed it to your platform account (the key, if any, is Humble's redemption code) */
  autoRedeemed?: PlatformRedeemed | null;
  // more of what Humble says about the key (2026 site)
  disclaimer?: string | null; // e.g. "Steam will not provide extra giftable copies of games you already own."
  cta?: { label: string; url: string } | null; // Humble's own button ("Steam Instructions" -> support article)
  availableFrom?: string | null; // can't be revealed before this
  preOrdered?: boolean;
  giftState?: string | null; // unassigned | gifted | claimed
  redeemable?: boolean; // false: nothing left to do (expired unrevealed, gifted, sold out)
  releaseDate?: string | null;
  deliveryMethods?: string[];
  /** every field Humble sent for this key and its item (except the key itself), for the Details view */
  details?: Record<string, string | number | boolean | null>;
}

export interface FileEntry {
  id: string;
  gamekey: string;
  bundle: string;
  product: string;
  productMachine: string;
  publisher: string | null;
  platform: string;
  format: string;
  filename: string;
  rel: string;
  url: string | null;
  size: number;
  humanSize: string;
  md5: string | null;
  sha1: string | null;
  downloadable: boolean;
  duplicateOf: string | null;
  downloaded: boolean;
  notDownloadableReason?: string | null;
  contentUrl?: string;
  choiceMonth?: string | null;
  itemId?: string;
  entitlementId?: string; // the download entitlement (for fresh signed links)
  urlExpiresAt?: string | null; // when the signed link stops working
  machineName?: string | null; // the product's machine name (extracted folders are often named after it)
  /** the same file as a .torrent (signed link) */
  torrentUrl?: string | null;
  /** every platform this same file is offered for (when more than one) */
  platforms?: string[];
  /** how many offers of this file were collapsed into this entry */
  variants?: number;
  /** found in one of your download folders */
  onDisk?: FileOnDisk | null;
  /** where it is, or where it'll be downloaded to */
  dest?: string;
  v2?: boolean;
}

export interface Product {
  id: string;
  gamekey: string;
  bundle: string;
  created: string | null;
  title: string;
  machineName: string;
  publisher: string | null;
  icon: string | null;
  url: string | null;
  platforms: string[];
  fileCount: number;
  keyCount: number;
  links: string[];
  linksText: string | null;
  steamAppId: string | number | null;
  choiceMonth?: string | null;
  v2?: boolean;
}

export interface Bundle {
  gamekey: string;
  name: string;
  machineName: string;
  created: string | null;
  amount: number | string | null;
  currency: string | null;
  keyCount: number;
  fileCount: number;
  itemCount?: number;
  unrevealed?: number;
  choiceMonth?: string | null;
  order?: number; // recency rank, 1 = newest
  /** this bundle's folders in your download folders */
  diskDirs?: string[];
  filesOnDisk?: number;
  /** files whose older version is on disk (Humble has updated them since) */
  olderOnDisk?: number;
}

export interface FileOnDisk {
  path: string;
  /** file = the file itself; extracted = a folder of its unpacked contents;
   *  older-version = a complete file of another size (Humble has updated it since);
   *  size-differs = a different size and not a complete archive (likely an unfinished download) */
  how: "file" | "extracted" | "size-differs" | "older-version";
}

/** One bundle folder, looked at closely (for choosing its bundle). */
export interface FolderInspect {
  path: string;
  entries: { name: string; dir: boolean }[]; // its top level (first 300)
  total: number; // top-level entries in all
  /** likely bundles: by name, and by how many of their files are in this folder */
  suggestions: { gamekey: string; nameScore: number; fileHits: number }[];
  /** every file/folder name in it (lowercased, as far as the scan reads), to show which of a bundle's files are here */
  names: string[];
}

/** Your download folders and what the last scan found. */
export interface FoldersInfo {
  downloadDir: string; // the default: new downloads go here (unless the bundle already has a folder)
  folders: string[]; // other folders that are scanned
  scanning: boolean;
  scan: { at: string; files: number; dirs: number; ms: number; missing: string[]; truncated: boolean } | null;
  /** every bundle folder found, and the bundles it's matched to */
  bundleDirs: { path: string; name: string; root: string; gamekeys: string[]; linked: boolean; files: number; folders: number }[];
}

export interface ChoiceGroup {
  id: string;
  title: string;
  month: string; // "YYYY-MM"
}

export interface LibraryIndex {
  bundles: Bundle[];
  keys: KeyEntry[];
  files: FileEntry[];
  products: Product[];
  choiceGroups: ChoiceGroup[];
  source?: "v2";
}

export type Naming = "original" | "title";
export type Theme = "dark" | "light";
export type Busy = "sync" | "reveal" | null;

export interface Status {
  loggedIn: boolean;
  browserVisible: boolean;
  downloadDir: string;
  naming: Naming;
  markOwned: boolean;
  liveScout: boolean;
  theme: Theme;
  live: { endpoints: number; samples: number };
  busy: Busy;
  /** what the busy job is doing right now, e.g. "download links 120/3834" */
  busyDetail?: string | null;
  queue: { queued: number; active: number };
  /** this build's version */
  version?: string;
  /** a newer release, when one is out; installable: this copy can install it itself */
  update?: { version: string; url: string; name: string; installable: boolean } | null;
  /** installing it: download progress, or why it failed */
  updateInstall?: { percent: number } | { error: string } | null;
  /** where updates come from, and how the last check went */
  updateSource?: {
    /** the release feed (null: no update check) */
    feed: string | null;
    /** a token is set for it (the token itself never leaves the main process) */
    hasToken: boolean;
    checking: boolean;
    /** when it last answered (ms), and the last error */
    checkedAt: number | null;
    error: string | null;
  };
}

export interface SettingsPatch {
  /** access token for the release feed; "" removes it */
  updateToken?: string;
  naming?: Naming;
  markOwned?: boolean;
  liveScout?: boolean;
  theme?: Theme;
}

export type DownloadState = "queued" | "downloading" | "done" | "error" | "cancelled";

export interface DownloadProgress {
  id: string;
  state: DownloadState;
  received?: number;
  total?: number;
  error?: string;
  skipped?: boolean;
}

/** A harvested Choice month (data/choice.json), as returned by getChoice(). */
export interface ChoiceGame {
  title: string;
  image: string | null;
  type: string | null;
  claimed: boolean;
  steamAppId?: string | number | null;
  endDate?: string | null;
}

export interface ChoiceMonth {
  month: string;
  title: string | null;
  gamekey: string | null;
  canClaim: boolean | null;
  source: string;
  seenAt: string;
  url: string;
  seen: boolean;
  games: Record<string, ChoiceGame>;
}

export interface Money {
  amount: number;
  currency: string | null;
}

/** One purchase, slimmed to non-personal fields (lib/orders-v2). */
export interface OrderItem {
  name: string | null;
  productKey: string | null;
  sku: string | null;
  thumbnail: string | null;
  logo: string | null;
  saleStart: string | null;
  saleEnd: string | null;
  keyExpiration: string | null;
  price: Money | null;
}

export interface Order {
  id: string;
  number: string | null;
  createdAt: string | null;
  state: string | null;
  total: Money | null;
  items: OrderItem[];
}

/** A game on someone's Steam wishlist. */
export interface WishlistGame {
  appid: number;
  /** null: Steam has no store page for it any more (removed or unlisted) */
  name: string | null;
  capsule: string | null;
  /** their order on the wishlist, 1 = top */
  rank: number;
  added: string | null;
}

/** A Steam profile whose wishlist Humbler compares with your library (lib/steam-wishlists). */
export interface WishlistProfile {
  steamId: string;
  name: string;
  avatar: string | null;
  profileUrl: string;
  wishlistUrl: string;
  addedAt: string;
  fetchedAt: string | null;
  /** why the last fetch found nothing (private, or an error) */
  error: string | null;
  refreshing: boolean;
  games: WishlistGame[];
}

export interface OkResult {
  ok: boolean;
  reason?: string;
}

export interface RevealResult extends OkResult {
  results?: { id: string; ok: boolean; error?: string }[];
}

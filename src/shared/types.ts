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
}

export interface FileOnDisk {
  path: string;
  /** file = the file itself; extracted = a folder of its unpacked contents; size-differs = same name, different size */
  how: "file" | "extracted" | "size-differs";
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
}

export interface SettingsPatch {
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

export interface OkResult {
  ok: boolean;
  reason?: string;
}

export interface RevealResult extends OkResult {
  results?: { id: string; ok: boolean; error?: string }[];
}

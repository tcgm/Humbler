// Types shared by the main process and the UI: the library index Humbler
// builds, the status it pushes, and the whole IPC API (see api.ts).

export type KeyStatus = "unused" | "revealed" | "gifted" | "link" | "expired" | "sold-out";

/** Your own record that a revealed key was activated on its store. */
export interface PlatformRedeemed {
  at: string;
  platform: string | null;
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
  expiry: string | null;
  daysLeft: number | null;
  platformRedeemed?: PlatformRedeemed | null;
  // 2026-site keys
  v2?: boolean;
  notGiftable?: boolean;
  contentUrl?: string;
  choiceMonth?: string | null;
  itemId?: string;
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

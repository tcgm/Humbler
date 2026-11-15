// The IPC API the preload exposes as window.humbler. One definition used by
// preload (to implement it), main (channel names) and the UI (to call it).
import type {
  ChoiceMonth,
  DownloadProgress,
  FolderInspect,
  FoldersInfo,
  LibraryIndex,
  OkResult,
  Order,
  PlatformRedeemed,
  RevealResult,
  SettingsPatch,
  Status,
  WishlistProfile,
} from "./types";

/** invoke channels: name -> [args, result] */
export interface InvokeChannels {
  "library:get": [[], LibraryIndex];
  "log:history": [[], string[]];
  "scout:page": [[{ reload: boolean }], OkResult & { dir?: string; responses?: number }];
  "scout:open-folder": [[], string];
  "scout:open-live": [[], string];
  "status:get": [[], void];
  "library:sync": [[{ full: boolean; focus?: string[] }], OkResult & { fetched?: number }];
  "keys:reveal": [[string[]], RevealResult];
  "file:save-text": [[{ name: string; text: string }], OkResult & { filePath?: string }];
  "downloads:enqueue": [[string[]], OkResult & { added?: number }];
  "downloads:cancel": [[], void];
  "downloads:open-folder": [[], string];
  "downloads:reveal-file": [[string], void];
  "settings:choose-download-dir": [[], void];
  "settings:set": [[SettingsPatch], void];
  "browser:toggle": [[], void];
  "browser:go": [[string], void];
  "browser:open": [[string], void];
  "browser:external": [[string], void];
  "update:install": [[], void];
  "update:check": [[], void];
  "keys:open-on-humble": [[string], void];
  "clipboard:write": [[string], void];
  "redeem:mark": [[{ id: string; redeemed: boolean; platform?: string | null }], PlatformRedeemed | null];
  "orders:get": [[], { orders: Order[]; totalDocs: number | null }];
  "choice:get": [[], ChoiceMonth[]];
  "folders:get": [[], FoldersInfo];
  "folders:add": [[], void];
  "folders:remove": [[string], void];
  "folders:set-default": [[string], void];
  "folders:rescan": [[], void];
  "folders:link": [[{ path: string; gamekey: string | null | undefined }], void];
  "folders:open": [[string], void];
  "folders:inspect": [[string], FolderInspect];
  "wishlists:get": [[], WishlistProfile[]];
  "wishlists:add": [[string], OkResult & { steamId?: string }];
  "wishlists:remove": [[string], void];
  "wishlists:refresh": [[string | null], OkResult];
}

/** main -> UI events: name -> payload */
export interface EventChannels {
  log: string;
  status: Status;
  "library-updated": void;
  "key-updated": { id: string; key: string | null };
  "download-progress": DownloadProgress;
  "choice-updated": void;
  "orders-updated": void;
  "app-focus": void;
  "folders-updated": void;
  "wishlists-updated": void;
}

type Unsubscribe = () => void;
type On<K extends keyof EventChannels> = (cb: (payload: EventChannels[K]) => void) => Unsubscribe;

export interface HumblerApi {
  getLibrary(): Promise<LibraryIndex>;
  getLogHistory(): Promise<string[]>;
  scoutPage(reload: boolean): Promise<InvokeChannels["scout:page"][1]>;
  openReconFolder(): Promise<string>;
  openLiveCatalog(): Promise<string>;
  requestStatus(): Promise<void>;
  /** `focus`: bundle ids (purchases) you're looking at, refreshed first */
  sync(full: boolean, focus?: string[]): Promise<InvokeChannels["library:sync"][1]>;
  revealKeys(ids: string[]): Promise<RevealResult>;
  /** ask where to save `text` (suggesting `name`) and write it */
  saveTextFile(name: string, text: string): Promise<InvokeChannels["file:save-text"][1]>;
  enqueueDownloads(ids: string[]): Promise<InvokeChannels["downloads:enqueue"][1]>;
  cancelDownloads(): Promise<void>;
  openDownloadFolder(): Promise<string>;
  showFile(id: string): Promise<void>;
  chooseDownloadDir(): Promise<void>;
  setSettings(patch: SettingsPatch): Promise<void>;
  toggleBrowser(): Promise<void>;
  go(where: string): Promise<void>;
  /** Humble site pages open in the pane; anything else in your browser. */
  openUrl(url: string): Promise<void>;
  /** Always your default browser (e.g. redeem instructions). */
  openExternal(url: string): Promise<void>;
  /** download the new version, install it and restart */
  installUpdate(): Promise<void>;
  /** look for a new version now */
  checkForUpdate(): Promise<void>;
  /** Open a new-site key on Humble to reveal it there; Humbler watches for the reveal. */
  revealOnHumble(keyId: string): Promise<void>;
  copy(text: string): Promise<void>;
  markRedeemed(id: string, redeemed: boolean, platform?: string | null): Promise<PlatformRedeemed | null>;
  getOrders(): Promise<InvokeChannels["orders:get"][1]>;
  getChoice(): Promise<ChoiceMonth[]>;
  getFolders(): Promise<FoldersInfo>;
  /** pick a folder (dialog) to scan */
  addFolder(): Promise<void>;
  removeFolder(path: string): Promise<void>;
  /** new downloads go here */
  setDefaultFolder(path: string): Promise<void>;
  rescanFolders(): Promise<void>;
  /** link a bundle folder to a bundle (gamekey), mark it "not a bundle" (null), or back to automatic (undefined) */
  linkFolder(path: string, gamekey: string | null | undefined): Promise<void>;
  openFolder(path: string): Promise<void>;
  /** a bundle folder's contents and likely bundles */
  inspectFolder(path: string): Promise<FolderInspect>;
  /** the Steam profiles whose wishlists you compare, with their games */
  getWishlists(): Promise<WishlistProfile[]>;
  /** add a profile (URL, SteamID64, friend code or custom URL name) and fetch its wishlist */
  addWishlist(input: string): Promise<InvokeChannels["wishlists:add"][1]>;
  removeWishlist(steamId: string): Promise<void>;
  /** re-fetch one profile's wishlist, or everyone's (null) */
  refreshWishlists(steamId: string | null): Promise<OkResult>;
  onLog: On<"log">;
  onStatus: On<"status">;
  onLibraryUpdated: On<"library-updated">;
  onKeyUpdated: On<"key-updated">;
  onDownloadProgress: On<"download-progress">;
  onChoiceUpdated: On<"choice-updated">;
  onOrdersUpdated: On<"orders-updated">;
  onAppFocus: On<"app-focus">;
  onFoldersUpdated: On<"folders-updated">;
  onWishlistsUpdated: On<"wishlists-updated">;
}

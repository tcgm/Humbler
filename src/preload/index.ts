// Exposes the typed Humbler API (src/shared/api.ts) to the UI as
// window.humbler. Every call is an IPC invoke; every on*() returns an
// unsubscribe function (so React effects can clean up, including on HMR).
import { contextBridge, ipcRenderer } from "electron";
import type { EventChannels, HumblerApi } from "../shared/api";

function on<K extends keyof EventChannels>(channel: K) {
  return (cb: (payload: EventChannels[K]) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: EventChannels[K]) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api: HumblerApi = {
  getLibrary: () => ipcRenderer.invoke("library:get"),
  getLogHistory: () => ipcRenderer.invoke("log:history"),
  scoutPage: (reload) => ipcRenderer.invoke("scout:page", { reload }),
  openReconFolder: () => ipcRenderer.invoke("scout:open-folder"),
  openLiveCatalog: () => ipcRenderer.invoke("scout:open-live"),
  requestStatus: () => ipcRenderer.invoke("status:get"),
  sync: (full, focus) => ipcRenderer.invoke("library:sync", { full, focus }),
  revealKeys: (ids) => ipcRenderer.invoke("keys:reveal", ids),
  saveTextFile: (name, text) => ipcRenderer.invoke("file:save-text", { name, text }),
  enqueueDownloads: (ids) => ipcRenderer.invoke("downloads:enqueue", ids),
  cancelDownloads: () => ipcRenderer.invoke("downloads:cancel"),
  openDownloadFolder: () => ipcRenderer.invoke("downloads:open-folder"),
  showFile: (id) => ipcRenderer.invoke("downloads:reveal-file", id),
  chooseDownloadDir: () => ipcRenderer.invoke("settings:choose-download-dir"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  toggleBrowser: () => ipcRenderer.invoke("browser:toggle"),
  go: (where) => ipcRenderer.invoke("browser:go", where),
  openUrl: (url) => ipcRenderer.invoke("browser:open", url),
  openExternal: (url) => ipcRenderer.invoke("browser:external", url),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  revealOnHumble: (keyId) => ipcRenderer.invoke("keys:open-on-humble", keyId),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  markRedeemed: (id, redeemed, platform) => ipcRenderer.invoke("redeem:mark", { id, redeemed, platform }),
  getOrders: () => ipcRenderer.invoke("orders:get"),
  getChoice: () => ipcRenderer.invoke("choice:get"),
  getFolders: () => ipcRenderer.invoke("folders:get"),
  addFolder: () => ipcRenderer.invoke("folders:add"),
  removeFolder: (p) => ipcRenderer.invoke("folders:remove", p),
  setDefaultFolder: (p) => ipcRenderer.invoke("folders:set-default", p),
  rescanFolders: () => ipcRenderer.invoke("folders:rescan"),
  linkFolder: (p, gamekey) => ipcRenderer.invoke("folders:link", { path: p, gamekey }),
  openFolder: (p) => ipcRenderer.invoke("folders:open", p),
  inspectFolder: (p) => ipcRenderer.invoke("folders:inspect", p),
  getWishlists: () => ipcRenderer.invoke("wishlists:get"),
  addWishlist: (input) => ipcRenderer.invoke("wishlists:add", input),
  removeWishlist: (steamId) => ipcRenderer.invoke("wishlists:remove", steamId),
  refreshWishlists: (steamId) => ipcRenderer.invoke("wishlists:refresh", steamId),
  getSteamAccount: () => ipcRenderer.invoke("steam:get"),
  signInToSteam: () => ipcRenderer.invoke("steam:sign-in"),
  refreshSteamAccount: () => ipcRenderer.invoke("steam:refresh"),
  signOutOfSteam: () => ipcRenderer.invoke("steam:sign-out"),
  getStore: () => ipcRenderer.invoke("store:get"),
  refreshStore: (full) => ipcRenderer.invoke("store:refresh", { full }),
  watchBundle: (id, on) => ipcRenderer.invoke("store:watch", { id, on }),
  watchGame: (title, on) => ipcRenderer.invoke("store:watch-game", { title, on }),
  addToSteamWishlist: (title, appid) => ipcRenderer.invoke("steam:wishlist-add", { title, appid }),
  testNotification: () => ipcRenderer.invoke("notify:test"),
  onLog: on("log"),
  onStatus: on("status"),
  onLibraryUpdated: on("library-updated"),
  onKeyUpdated: on("key-updated"),
  onDownloadProgress: on("download-progress"),
  onChoiceUpdated: on("choice-updated"),
  onOrdersUpdated: on("orders-updated"),
  onAppFocus: on("app-focus"),
  onFoldersUpdated: on("folders-updated"),
  onWishlistsUpdated: on("wishlists-updated"),
  onSteamUpdated: on("steam-updated"),
  onStoreUpdated: on("store-updated"),
  onOpenSale: on("open-sale"),
};

contextBridge.exposeInMainWorld("humbler", api);

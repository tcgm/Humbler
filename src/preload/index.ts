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
  sync: (full) => ipcRenderer.invoke("library:sync", { full }),
  revealKeys: (ids) => ipcRenderer.invoke("keys:reveal", ids),
  exportKeys: (ids) => ipcRenderer.invoke("keys:export", ids),
  enqueueDownloads: (ids) => ipcRenderer.invoke("downloads:enqueue", ids),
  cancelDownloads: () => ipcRenderer.invoke("downloads:cancel"),
  openDownloadFolder: () => ipcRenderer.invoke("downloads:open-folder"),
  showFile: (id) => ipcRenderer.invoke("downloads:reveal-file", id),
  chooseDownloadDir: () => ipcRenderer.invoke("settings:choose-download-dir"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  toggleBrowser: () => ipcRenderer.invoke("browser:toggle"),
  go: (where) => ipcRenderer.invoke("browser:go", where),
  openUrl: (url) => ipcRenderer.invoke("browser:open", url),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  markRedeemed: (id, redeemed, platform) => ipcRenderer.invoke("redeem:mark", { id, redeemed, platform }),
  getOrders: () => ipcRenderer.invoke("orders:get"),
  getChoice: () => ipcRenderer.invoke("choice:get"),
  onLog: on("log"),
  onStatus: on("status"),
  onLibraryUpdated: on("library-updated"),
  onKeyUpdated: on("key-updated"),
  onDownloadProgress: on("download-progress"),
  onChoiceUpdated: on("choice-updated"),
  onOrdersUpdated: on("orders-updated"),
  onAppFocus: on("app-focus"),
};

contextBridge.exposeInMainWorld("humbler", api);

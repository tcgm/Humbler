import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LuDownload, LuSettings } from "react-icons/lu";
import { FoldersDialog } from "./components/FoldersDialog";
import { Menu } from "./components/Menu";
import { RedeemAsk } from "./components/RedeemAsk";
import { SettingsDialog } from "./components/SettingsDialog";
import { TooltipLayer } from "./components/Tooltips";
import { PREFS, usePref } from "./remember";
import { api, useStore, type TabId } from "./store";
import { BundlesTab } from "./tabs/BundlesTab";
import { ChoiceTab } from "./tabs/ChoiceTab";
import { DownloadsTab } from "./tabs/DownloadsTab";
import { KeysTab } from "./tabs/KeysTab";
import { LibraryTab } from "./tabs/LibraryTab";
import { ScoutTab } from "./tabs/ScoutTab";
import { WishlistsTab } from "./tabs/WishlistsTab";
import { wishRows } from "./wishlist";

export function App() {
  const s = useStore();
  const { lib, status, tab, setTab } = s;
  // Tabs mount on first visit and then stay mounted (hidden), so switching
  // tabs keeps your filters, selection and scroll position.
  // (Tracked from the current tab, so tabs reached with back/forward count too.)
  const [visited, setVisited] = useState<Set<TabId>>(new Set([tab]));
  const [foldersOpen, setFoldersOpen] = useState(false);
  // the counts next to the tab names (off for screenshots, say)
  const [showCounts] = usePref(...PREFS.tabCounts);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);

  const go = (t: TabId) => {
    // Clicking the tab you're on returns Bundles/Choice to their lists.
    if (t === tab && t === "bundles") s.openBundle(null);
    if (t === tab && t === "choice") s.openChoiceMonth(null);
    setTab(t);
  };

  // what you're looking at: Sync refreshes it first
  const focus =
    tab === "bundles" && s.bundleId
      ? [s.bundleId]
      : tab === "choice" && s.choiceMonth
        ? lib.bundles.filter((b) => b.choiceMonth === s.choiceMonth).map((b) => b.gamekey)
        : [];
  const focusName = tab === "bundles" && s.bundleId ? lib.bundles.find((b) => b.gamekey === s.bundleId)?.name : tab === "choice" && s.choiceMonth ? "this Choice month" : null;

  const unrevealed = lib.keys.filter((k) => k.status === "unused").length;
  const pending = lib.files.filter((f) => f.downloadable && !f.downloaded && !f.duplicateOf).length;
  const months = new Set([
    ...lib.bundles.map((b) => b.choiceMonth).filter(Boolean),
    ...(lib.choiceGroups || []).map((g) => g.month),
    ...s.choiceMonths.map((m) => m.month),
  ]).size;

  // wishlist games you hold a spare key for
  const toGive = useMemo(() => wishRows(s.wishlists, s.ownIndex).filter((r) => r.spare.length).length, [s.wishlists, s.ownIndex]);

  const busyParts = [
    status?.busy === "sync" ? `syncing…${status.busyDetail ? ` (${status.busyDetail})` : ""}` : null,
    status?.busy === "reveal" ? "revealing keys…" : null,
    status?.queue && (status.queue.active || status.queue.queued) ? `downloading ${status.queue.active} · ${status.queue.queued} queued` : null,
    status?.updateInstall && "percent" in status.updateInstall ? `updating ${Math.floor(status.updateInstall.percent)}%` : null,
  ].filter(Boolean);

  const tabs: { id: TabId; label: string; count?: string; hb?: boolean; render: () => ReactNode }[] = [
    { id: "keys", label: "Keys", count: lib.keys.length ? `${unrevealed} unrevealed / ${lib.keys.length}` : "", hb: true, render: () => <KeysTab /> },
    { id: "bundles", label: "Bundles", count: lib.bundles.length ? String(lib.bundles.length) : "", hb: true, render: () => <BundlesTab /> },
    { id: "choice", label: "Choice", count: months ? String(months) : "", hb: true, render: () => <ChoiceTab /> },
    { id: "files", label: "Downloads", count: lib.files.length ? `${pending} to get / ${lib.files.length}` : "", render: () => <DownloadsTab /> },
    { id: "library", label: "Library", count: lib.products.length ? String(lib.products.length) : "", render: () => <LibraryTab /> },
    { id: "wishlists", label: "Wishlists", count: s.wishlists.length ? `${toGive} to give` : "", render: () => <WishlistsTab /> },
    { id: "log", label: "Scout & Log", render: () => <ScoutTab /> },
  ];

  const install = status?.updateInstall;
  const installing = install && "percent" in install ? install : null;
  const installError = install && "error" in install ? install.error : null;
  const idle = !s.busy && !status?.queue.active && !status?.queue.queued;

  return (
    <>
      <header className="top">
        <div className="brand">
          <h1>Humbler</h1>
          <span className={`pill ${status ? (status.loggedIn ? "ok" : "bad") : ""}`}>{status ? (status.loggedIn ? "logged in" : "not logged in") : "checking…"}</span>
          {busyParts.length > 0 && <span className="pill busy">{busyParts.join(" · ")}</span>}
        </div>
        <div className="actions">
          <button className="primary" disabled={s.busy} title={`${focusName && focus.length ? `Refresh ${focusName} first, then fetch` : "Fetch"} items added since your last sync`} onClick={() => api.sync(false, focus)}>
            Sync
          </button>
          <button
            className="icon-btn"
            title={s.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle light/dark mode"
            onClick={s.toggleTheme}
          >
            {s.theme === "dark" ? "☀" : "☾"}
          </button>
          {status?.update && (
            <Menu
              className="update-btn"
              icon={
                <>
                  <LuDownload aria-hidden />
                  <span className="update-dot" aria-hidden />
                </>
              }
              title={installing ? `Downloading Humbler ${status.update.version}: ${Math.floor(installing.percent)}%` : `${status.update.name} is out (you have v${status.version})`}
              label={`Update available: v${status.update.version}`}
              items={[
                status.update.installable
                  ? {
                      label: installing
                        ? `Downloading v${status.update.version}… ${Math.floor(installing.percent)}%`
                        : installError
                          ? `Install failed: try again`
                          : `Install v${status.update.version} and restart`,
                      title: installError ?? (idle ? "Downloads the new version, installs it and restarts Humbler" : "Wait for the current sync or downloads to finish first"),
                      disabled: !!installing || !idle,
                      onPick: () => void api.installUpdate(),
                    }
                  : {
                      label: "Install it from the release page",
                      title: "This copy (the zip, the tar.gz or macOS) can't replace itself",
                      disabled: true,
                      onPick: () => {},
                    },
                { label: "Open the release page…", title: status.update.url, onPick: () => void api.openExternal(status.update!.url) },
              ]}
            />
          )}
          <button className="icon-btn" title="Settings: display, downloads and Humble pane options" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <LuSettings aria-hidden />
          </button>
          <Menu
            items={[
              { label: "Full refresh", title: "Re-fetch your whole library (and every download link)", disabled: s.busy, onPick: () => void api.sync(true, focus) },
              { label: status?.browserVisible === false ? "Show browser" : "Hide browser", title: "The Humble pane on the right", onPick: () => void api.toggleBrowser() },
              "-",
              { label: "Download folders…", title: "Where your downloads are, and where new ones go", onPick: () => setFoldersOpen(true) },
              "-",
              status?.update
                ? { label: `Get Humbler ${status.update.version}…`, title: `You have v${status.version}: open the release page`, onPick: () => void api.openExternal(status.update!.url) }
                : { label: `Humbler ${status?.version ? `v${status.version}` : ""}`, title: "You're on the latest version (or no release feed is set)", disabled: true, onPick: () => {} },
            ]}
          />
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => go(t.id)}>
            {t.label} {showCounts && t.count && <span className="count">{t.count}</span>}
          </button>
        ))}
        <span className="spacer" />
        <button className="link" onClick={() => api.go("library")}>
          Humble library
        </button>
      </nav>

      {tabs.map((t) =>
        visited.has(t.id) || tab === t.id ? (
          t.hb ? (
            <section key={t.id} className={`panel hb${t.id === "keys" ? " hbkeys" : ""}`} hidden={tab !== t.id}>
              {t.render()}
            </section>
          ) : (
            <div key={t.id} className="panel-host" hidden={tab !== t.id}>
              {t.render()}
            </div>
          )
        ) : null,
      )}

      <RedeemAsk />
      <TooltipLayer />
      {foldersOpen && <FoldersDialog onClose={() => setFoldersOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onFolders={() => setFoldersOpen(true)} />}
    </>
  );
}

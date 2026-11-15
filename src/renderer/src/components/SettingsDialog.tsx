// ☰ > Settings: Humbler's options in one place. App settings (saved by the
// main process) and display preferences (remembered in this window).
import { useEffect, useRef, useState } from "react";
import { LuX } from "react-icons/lu";
import type { Naming } from "@shared/types";
import { PREFS, usePref } from "../remember";
import { api, useStore } from "../store";

export function SettingsDialog({ onClose, onFolders }: { onClose: () => void; onFolders: () => void }) {
  const { status, theme, toggleTheme } = useStore();
  const [tabCounts, setTabCounts] = usePref(...PREFS.tabCounts);
  const [pageScrollTop, setPageScrollTop] = usePref(...PREFS.pageScrollTop);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const src = status?.updateSource;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  return (
    <div className="ask-backdrop hb" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ask settings" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div className="folders-head">
          <h3 id="settingsTitle">Settings</h3>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <LuX aria-hidden />
          </button>
        </div>

        <h4>Display</h4>
        <label className="settings-row">
          <input type="checkbox" checked={theme === "dark"} onChange={toggleTheme} />
          <span>
            Dark mode
            <small>Also the ☀ / ☾ button at the top.</small>
          </span>
        </label>
        <label className="settings-row">
          <input type="checkbox" checked={tabCounts} onChange={(e) => setTabCounts(e.target.checked)} />
          <span>
            Show counts next to the tab names
            <small>How many keys, bundles, downloads...</small>
          </span>
        </label>
        <label className="settings-row">
          <input type="checkbox" checked={pageScrollTop} onChange={(e) => setPageScrollTop(e.target.checked)} />
          <span>
            Back to the top when changing pages
            <small>Keys and Bundles lists: Next, Prev or a page number scrolls the list to its top.</small>
          </span>
        </label>

        <h4>Downloads</h4>
        <div className="settings-row">
          <span>
            Download folder
            <small className="settings-path" title={status?.downloadDir}>
              {status?.downloadDir || "…"}
            </small>
          </span>
          <div className="settings-actions">
            <button className="hb-btn ghost small" onClick={() => api.chooseDownloadDir()}>
              Change…
            </button>
            <button
              className="hb-btn ghost small"
              onClick={() => {
                onClose();
                onFolders();
              }}
            >
              Other folders…
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span>
            File names
            <small>How downloaded files are named.</small>
          </span>
          <select value={status?.naming ?? "original"} onChange={(e) => api.setSettings({ naming: e.target.value as Naming })}>
            <option value="original">Humble&apos;s file names</option>
            <option value="title">Product - Publisher.ext</option>
          </select>
        </div>

        <h4>Humble pane</h4>
        <label className="settings-row">
          <input type="checkbox" checked={!!status?.markOwned} onChange={(e) => api.setSettings({ markOwned: e.target.checked })} />
          <span>
            Mark owned on Humble pages
            <small>Highlight things you already own on Humble&apos;s store, bundle and Choice pages.</small>
          </span>
        </label>
        <label className="settings-row">
          <input type="checkbox" checked={!!status?.liveScout} onChange={(e) => api.setSettings({ liveScout: e.target.checked })} />
          <span>
            Live scouting
            <small>Record the responses Humble&apos;s pages receive, as you browse, into a scrubbed endpoint catalog (Scout &amp; Log tab).</small>
          </span>
        </label>

        <h4>Updates</h4>
        <div className="settings-row">
          <span>
            Release feed
            <small className="settings-path" title={src?.feed ?? undefined}>
              {src?.feed ?? "None: this build doesn't check for updates."}
            </small>
            {src?.feed && (
              <small>
                {src.checking
                  ? "Checking…"
                  : src.error
                    ? `Last check failed: ${src.error}`
                    : src.checkedAt
                      ? `Checked ${new Date(src.checkedAt).toLocaleString()}: ${status?.update ? `v${status.update.version} is out` : `v${status?.version ?? "?"} is the latest`}`
                      : "Not checked yet."}
              </small>
            )}
          </span>
          {src?.feed && (
            <div className="settings-actions">
              <button className="hb-btn ghost small" disabled={src.checking} onClick={() => void api.checkForUpdate()}>
                Check now
              </button>
            </div>
          )}
        </div>
        {src?.feed && (
          <div className="settings-row">
            <span>
              Access token
              <small>
                Only for a feed that needs signing in, such as a private Gitea repository: a token that can read it
                (Gitea: Settings → Applications, with repository read access). Stored encrypted, and sent only to that server.
              </small>
            </span>
            <form
              className="settings-actions"
              onSubmit={(e) => {
                e.preventDefault();
                if (!token.trim()) return;
                setTokenError(null);
                api.setSettings({ updateToken: token.trim() }).then(
                  () => setToken(""),
                  (err: unknown) => setTokenError(err instanceof Error ? err.message.replace(/^.*Error: /, "") : String(err)),
                );
              }}
            >
              <input
                type="password"
                className="hb-search"
                autoComplete="off"
                spellCheck={false}
                placeholder={src.hasToken ? "•••••• (set)" : "Paste a token"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="hb-btn ghost small" type="submit" disabled={!token.trim()}>
                Save
              </button>
              {src.hasToken && (
                <button className="hb-btn ghost small" type="button" onClick={() => void api.setSettings({ updateToken: "" })}>
                  Remove
                </button>
              )}
            </form>
          </div>
        )}
        {tokenError && <p className="settings-error">{tokenError}</p>}

        <div className="ask-actions">
          <button className="hb-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

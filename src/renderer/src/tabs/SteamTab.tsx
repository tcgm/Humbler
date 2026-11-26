// My Steam: your own Steam account (signed in in the side pane) next to your
// Humble keys. Which Steam keys are redeemed on your account, and which
// bundles you've most likely redeemed all of (how much of each is on it).
import { useMemo } from "react";
import { ExportButton } from "../components/ExportDialog";
import { Marks } from "../components/Marks";
import { byNumber, byText, useTable, type Col } from "../components/Table";
import { ArmButton, BundleIcon, ExtLink, HumbleLink, ResetButton } from "../components/ui";
import { useRemembered } from "../remember";
import { api, useStore } from "../store";
import { STATE_TEXT, type BundleOnSteam, type SteamKey, type SteamState } from "../steam";
import { formatDate, plural } from "../util";

const ROW_LIMIT = 1500;
type View = "bundles" | "keys";

type BundleShow = "full" | "most" | "some" | "none" | "all";
const BUNDLE_SHOW: Record<BundleShow, string> = {
  full: "All of it on your account",
  most: "Most of it (50-99%)",
  some: "Some of it (1-49%)",
  none: "None of it",
  all: "Every bundle with Steam keys",
};
const inShow = (b: BundleOnSteam, s: BundleShow) =>
  s === "all" ? true : s === "full" ? b.pct === 100 : s === "most" ? b.pct >= 50 && b.pct < 100 : s === "some" ? b.on > 0 && b.pct < 50 : b.on === 0;

type KeyShow = SteamState | "on" | "all";
const KEY_SHOW: [KeyShow, string][] = [
  ["redeemed", "Redeemed on your account"],
  ["owned", "On your account, key never revealed"],
  ["revealed", "Revealed or gifted, not on your account"],
  ["missing", "Unrevealed, not on your account"],
  ["on", "Anything on your account"],
  ["all", "Every Steam key"],
];
const keyIn = (k: SteamKey, s: KeyShow) => (s === "all" ? true : s === "on" ? !!k.on : k.state === s);
const STATE_CLASS: Record<SteamState, string> = { redeemed: "ok", owned: "warn", given: "", revealed: "bad", missing: "", lost: "" };

function sinceText(iso: string | null): string {
  if (!iso) return "not fetched yet";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "fetched just now";
  if (mins < 60) return `fetched ${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `fetched ${h} h ago` : `fetched ${formatDate(iso)}`;
}

export function SteamTab() {
  const { steam, lib } = useStore();
  const [view, setView] = useRemembered<View>("steam.view", "bundles");
  const haveGames = !!steam?.apps.length;

  return (
    <section className="panel">
      {steam && (steam.signedIn || steam.steamId) && <AccountBar />}
      {!haveGames ? (
        <div className="wl-empty">
          <h3>See which keys are on your Steam account</h3>
          <p>
            Sign in to Steam in the pane on the right and Humbler reads the games and DLC on your account. It then shows which of your Humble Steam keys you've redeemed, and which
            bundles you've most likely redeemed all of.
          </p>
          <p className="muted">
            Steam only shows what you own to you, signed in (a profile link isn't enough). The sign-in stays in Humbler, kept encrypted like your Humble login; Humbler only reads
            Steam's list of what you own and never changes anything on your account. Matching is by title where Humble doesn't say which Steam app a key is for, so a "~" means
            likely, not certain.
          </p>
          {steam?.error && <p className="tag warn wl-error">{steam.error}</p>}
          <p>
            {steam?.refreshing ? (
              <span className="muted">Fetching your games…</span>
            ) : (
              <button className="primary" onClick={() => void api.signInToSteam()}>
                Sign in to Steam
              </button>
            )}
            {steam?.signedIn && !steam.refreshing && (
              <>
                {" "}
                <button onClick={() => void api.refreshSteamAccount()}>Fetch my games</button>
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="filters">
            <div className="seg" role="tablist">
              <button className={view === "bundles" ? "active" : ""} onClick={() => setView("bundles")}>
                Bundles
              </button>
              <button className={view === "keys" ? "active" : ""} onClick={() => setView("keys")}>
                Keys
              </button>
            </div>
            {lib.keys.length === 0 && <span className="muted">Your Humble library is empty: Sync first</span>}
          </div>
          {view === "bundles" ? <BundlesView /> : <KeysView />}
        </>
      )}
    </section>
  );
}

function AccountBar() {
  const { steam, steamByKey } = useStore();
  if (!steam) return null;
  const redeemed = [...steamByKey.values()].filter((s) => s.state === "redeemed").length;
  return (
    <div className="toolbar steam-acct">
      {steam.avatar && <img src={steam.avatar} alt="" />}
      <span>
        <b>{steam.name || "Your Steam account"}</b>
        <span className="sub">
          {steam.refreshing
            ? "fetching your games…"
            : steam.apps.length
              ? `${plural(steam.apps.length, "game")} and DLC · ${redeemed} of ${steamByKey.size} Steam keys redeemed there · ${sinceText(steam.fetchedAt)}`
              : sinceText(steam.fetchedAt)}
        </span>
      </span>
      {steam.error && <span className="tag warn wl-error">{steam.error}</span>}
      <span className="spacer" />
      {steam.profileUrl && <ExtLink href={steam.profileUrl}>Profile</ExtLink>}
      {(!steam.signedIn || steam.error) && <button onClick={() => void api.signInToSteam()}>Sign in again</button>}
      <button disabled={steam.refreshing || !steam.signedIn} onClick={() => void api.refreshSteamAccount()} title="Fetch the games on your account again">
        {steam.refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <ArmButton className="danger" armedText="Sign out?" title="Sign out of Steam in Humbler and forget your account's games" onFire={() => api.signOutOfSteam()}>
        Sign out
      </ArmButton>
    </div>
  );
}

function BundlesView() {
  const { steamBundles, openBundle } = useStore();
  const [q, setQ] = useRemembered("steam.bundles.q", "");
  const [show, setShow] = useRemembered<BundleShow>("steam.bundles.show", "full");
  const dirty = q !== "" || show !== "full";
  const all = useMemo(() => [...steamBundles.values()], [steamBundles]);
  const counts = useMemo(() => Object.fromEntries((Object.keys(BUNDLE_SHOW) as BundleShow[]).map((s) => [s, all.filter((b) => inShow(b, s)).length])), [all]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((b) => inShow(b, show))
      .filter((b) => !needle || `${b.bundle.name} ${b.keys.map((s) => s.key.name).join(" ")}`.toLowerCase().includes(needle))
      .sort((a, b) => b.pct - a.pct || b.keys.length - a.keys.length || (a.bundle.order ?? 0) - (b.bundle.order ?? 0));
  }, [all, q, show]);

  const cols: Col<BundleOnSteam>[] = [
    { id: "icon", className: "steam-iconcol", fixed: true, label: null },
    { id: "bundle", label: "Bundle", grow: 3, sort: byText((b) => b.bundle.name) },
    { id: "pct", label: "On your account", className: "steam-pctcol", title: "Sort by how much of the bundle is on your account", sort: byNumber((b) => -b.pct) },
    { id: "not", label: "Not on your account", grow: 2, sort: byNumber((b) => b.keys.length - b.on) },
  ];
  const table = useTable("steam.bundles", cols, rows);

  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Search bundle or game…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={show} onChange={(e) => setShow(e.target.value as BundleShow)}>
          {(Object.keys(BUNDLE_SHOW) as BundleShow[]).map((s) => (
            <option key={s} value={s}>
              {BUNDLE_SHOW[s]} ({counts[s]})
            </option>
          ))}
        </select>
        <ResetButton
          dirty={dirty}
          onReset={() => {
            setQ("");
            setShow("full");
          }}
        />
      </div>
      <div className="toolbar">
        <span className="muted">
          {plural(rows.length, "bundle")} · counting each bundle&apos;s Steam keys (games and DLC) that are on your account, whichever copy put them there
        </span>
      </div>
      <div className="tableWrap">
        <table className={`grid ${table.tableClass}`} style={table.tableStyle}>
          <thead>
            <tr>{table.headers}</tr>
          </thead>
          <tbody>
            {table.rows.slice(0, ROW_LIMIT).map((b) => {
              const missing = b.keys.filter((s) => !s.on);
              return (
                <tr key={b.bundle.gamekey} className="steam-click" onClick={() => openBundle(b.bundle.gamekey)} title="Open this bundle">
                  <td className="steam-iconcol">
                    <BundleIcon b={b.bundle} size="xs" />
                  </td>
                  <td className="grow" title={b.bundle.name}>
                    {b.bundle.name}
                    <span className="sub">
                      {b.on} of {plural(b.keys.length, "Steam key")} on your account
                      {b.likely ? ` (${b.likely} matched by a likely title)` : ""}
                    </span>
                  </td>
                  <td className="steam-pctcol">
                    <span className={b.pct === 100 ? "steam-pct ok" : "steam-pct"}>
                      {b.likely && b.pct ? "~" : ""}
                      {b.pct}%
                    </span>
                    <div className="bar">
                      <i style={{ width: `${b.pct}%` }} />
                    </div>
                  </td>
                  <td className="grow" title={missing.map((s) => `${s.key.name} (${STATE_TEXT[s.state].toLowerCase()})`).join("\n")}>
                    {missing.length ? missing.map((s) => s.key.name).join(", ") : <span className="muted">-</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="more">{show === "full" ? "No bundle is all on your account. Try \"Most of it\"." : "Nothing to show."}</div>}
        {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
      </div>
    </>
  );
}

function KeysView() {
  const { steamByKey, openBundle } = useStore();
  const [q, setQ] = useRemembered("steam.keys.q", "");
  const [show, setShow] = useRemembered<KeyShow>("steam.keys.show", "redeemed");
  const dirty = q !== "" || show !== "redeemed";
  const all = useMemo(() => [...steamByKey.values()], [steamByKey]);
  const counts = useMemo(() => Object.fromEntries(KEY_SHOW.map(([s]) => [s, all.filter((k) => keyIn(k, s)).length])), [all]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((k) => keyIn(k, show))
      .filter((k) => !needle || `${k.key.name} ${k.key.bundle} ${k.on?.app.name || ""}`.toLowerCase().includes(needle))
      .sort((a, b) => a.key.name.localeCompare(b.key.name));
  }, [all, q, show]);

  const cols: Col<SteamKey>[] = [
    { id: "game", label: "Key", grow: 3, sort: byText((k) => k.key.name) },
    { id: "app", label: "On your account as", grow: 2, sort: byText((k) => k.on?.app.name) },
    { id: "state", label: "State", grow: 1, sort: byText((k) => STATE_TEXT[k.state]) },
    { id: "act", className: "actcol", fixed: true, label: null },
  ];
  const table = useTable("steam.keys", cols, rows);
  const label = KEY_SHOW.find(([s]) => s === show)?.[1].toLowerCase() || "steam keys";

  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Search game or bundle…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={show} onChange={(e) => setShow(e.target.value as KeyShow)}>
          {KEY_SHOW.map(([s, text]) => (
            <option key={s} value={s}>
              {text} ({counts[s]})
            </option>
          ))}
        </select>
        <ResetButton
          dirty={dirty}
          onReset={() => {
            setQ("");
            setShow("redeemed");
          }}
        />
      </div>
      <div className="toolbar">
        <span className="muted">{plural(rows.length, "key")}</span>
        <span className="spacer" />
        <ExportButton className="" scope={`Steam keys: ${label}${q ? " (matching the search)" : ""}`} keys={rows.map((k) => k.key)} />
      </div>
      <div className="tableWrap">
        <table className={`grid ${table.tableClass}`} style={table.tableStyle}>
          <thead>
            <tr>{table.headers}</tr>
          </thead>
          <tbody>
            {table.rows.slice(0, ROW_LIMIT).map((s) => (
              <tr key={s.key.id}>
                <td className="grow" title={`${s.key.name}\n${s.key.bundle}`}>
                  {s.key.name}
                  <span className="sub">
                    <a onClick={() => openBundle(s.key.gamekey)} title="Open this bundle">
                      {s.key.bundle}
                    </a>
                  </span>
                  <Marks title={s.key.name} appid={s.key.steamAppId} noSteam />
                </td>
                <td className="grow" title={s.on ? `${s.on.app.name} (app ${s.on.app.appid})${s.on.how === "likely" ? "\nLikely the same game: the titles differ only by edition words" : ""}` : ""}>
                  {s.on ? (
                    <>
                      {s.on.how === "likely" ? "~ " : ""}
                      {s.on.app.name}
                    </>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td className="grow">
                  <span className={`tag ${STATE_CLASS[s.state]}`}>{STATE_TEXT[s.state]}</span>
                </td>
                <td className="actcol">
                  {s.on && <ExtLink href={`https://store.steampowered.com/app/${s.on.app.appid}`}>Steam</ExtLink>}
                  <HumbleLink of={s.key} label="Humble" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="more">Nothing to show.</div>}
        {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
      </div>
    </>
  );
}

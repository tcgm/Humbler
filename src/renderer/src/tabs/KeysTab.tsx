// Keys tab, modelled on the old humblebundle.com/home/keys page.
import { useMemo, useRef, useState } from "react";
import type { KeyEntry, KeyStatus } from "@shared/types";
import { ExportButton } from "../components/ExportDialog";
import { KeyField } from "../components/KeyField";
import { RevealSelected } from "../components/KeySelect";
import { byText, useTable, type Col } from "../components/Table";
import { ExtLink, HumbleLink, Pager, PlatformBadge, ResetButton } from "../components/ui";
import { useRemembered } from "../remember";
import { api, useStore } from "../store";
import { EXPIRING_DAYS, isExpiring, platformOf, steamUrl, uniqSorted } from "../util";

const PER_PAGE = 50;
type StateFilter = "all" | "unused" | "revealed" | "notredeemed" | "platformredeemed" | "gifted" | "expiring" | "expired" | "soldout";
const KEY_ORDER: Record<KeyStatus, number> = { unused: 0, revealed: 1, gifted: 2, link: 3, expired: 4, "sold-out": 5 };
const LABELS: Record<KeyStatus, string> = { unused: "unrevealed", revealed: "revealed", gifted: "gifted", link: "redeem links", expired: "expired", "sold-out": "sold out" };

function matchesState(k: KeyEntry, st: StateFilter): boolean {
  switch (st) {
    case "unused":
      return k.status === "unused";
    case "revealed":
      return k.status === "revealed";
    case "notredeemed":
      return k.status === "revealed" && !k.platformRedeemed;
    case "platformredeemed":
      return !!k.platformRedeemed;
    case "gifted":
      return k.status === "gifted" || k.status === "link";
    case "expiring":
      return isExpiring(k);
    case "expired":
      return k.status === "expired";
    case "soldout":
      return k.status === "sold-out";
    default:
      return true;
  }
}

export function KeysTab() {
  const { lib, tab } = useStore();
  const [q, setQ] = useRemembered("keys.q", "");
  const [bundle, setBundle] = useRemembered("keys.bundle", "");
  const [type, setType] = useRemembered("keys.type", "");
  const [st, setSt] = useRemembered<StateFilter>("keys.status", "all");
  const [page, setPage] = useRemembered("keys.page", 1);
  const dirty = q !== "" || bundle !== "" || type !== "" || st !== "all";
  const resetAll = () => {
    setQ("");
    setBundle("");
    setType("");
    setSt("all");
    setPage(1);
  };
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  // Everything matching bundle/type/search, whatever its status: used to
  // explain what the status filter hides ("0 shown of 37 (37 revealed)").
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lib.keys.filter(
      (k) =>
        (!bundle || k.gamekey === bundle) &&
        (!type || k.keyType === type) &&
        (!needle || `${k.name} ${k.bundle} ${k.key || ""} ${k.keyType}`.toLowerCase().includes(needle)),
    );
  }, [lib.keys, q, bundle, type]);
  // A key you're looking at stays in the list when it changes (e.g. you reveal
  // it with "Hide redeemed" on) until you change the filters or leave the tab;
  // only then does the status filter drop it.
  const shown = useRef<{ view: string; ids: Set<string> }>({ view: "", ids: new Set() });
  const view = `${tab === "keys"}|${q}|${bundle}|${type}|${st}`;
  const rows = useMemo(() => {
    if (shown.current.view !== view) shown.current = { view, ids: new Set() };
    const kept = shown.current.ids;
    const out = base.filter((k) => matchesState(k, st) || kept.has(k.id));
    for (const k of out) kept.add(k.id);
    return out;
  }, [base, st, view]);

  const cols: Col<KeyEntry>[] = [
    {
      id: "chk",
      className: "chk",
      fixed: true,
      label: (
        <input
          type="checkbox"
          title="Select every key matching the filters"
          checked={rows.length > 0 && rows.every((k) => sel.has(k.id))}
          onChange={(e) => setSel((s) => (e.target.checked ? new Set([...s, ...rows.map((k) => k.id)]) : new Set([...s].filter((id) => !rows.some((k) => k.id === id)))))}
        />
      ),
    },
    { id: "platform", label: "Platform", className: "platform", sort: byText((k) => platformOf(k).name || platformOf(k).badge) },
    { id: "game", label: "Game", grow: 1, sort: byText((k) => k.name) },
    {
      id: "key",
      label: "Key",
      className: "keycol",
      title: "Sort by state: unrevealed (soonest deadline first), revealed, gifted, expired, sold out",
      sort: (a, b) => KEY_ORDER[a.status] - KEY_ORDER[b.status] || (Date.parse(a.expiry || "") || Infinity) - (Date.parse(b.expiry || "") || Infinity),
    },
  ];
  const table = useTable("keys", cols, rows);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const pageRows = table.rows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);

  const keyBundles = useMemo(() => lib.bundles.filter((b) => b.keyCount), [lib.bundles]);
  const types = useMemo(() => uniqSorted(lib.keys.map((k) => k.keyType)), [lib.keys]);

  const breakdown = Object.entries(
    base.reduce<Record<string, number>>((m, k) => ((m[k.status] = (m[k.status] || 0) + 1), m), {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${LABELS[s as KeyStatus] || s}`)
    .join(", ");
  const expiring = base.filter(isExpiring).length;
  const soldOut = base.filter((k) => k.status === "sold-out").length;
  const hidden = base.length - rows.length;
  const from = rows.length ? (cur - 1) * PER_PAGE + 1 : 0;

  const toggle = (id: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <div className="hb-page">
      <div className="hb-head">
        <h2>Keys &amp; Entitlements</h2>
        <div className="hb-controls">
          <input className="hb-search" type="search" placeholder="Search" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
          <label className="hb-check">
            <input type="checkbox" checked={st === "unused"} onChange={(e) => reset(setSt)(e.target.checked ? "unused" : "all")} /> Hide redeemed keys &amp;
            entitlements
          </label>
        </div>
      </div>
      <div className="hb-subbar">
        <select value={bundle} onChange={(e) => reset(setBundle)(e.target.value)}>
          <option value="">All bundles ({keyBundles.length})</option>
          {keyBundles.map((b) => (
            <option key={b.gamekey} value={b.gamekey}>
              {b.name}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">All key types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={st} title="Show keys by status" onChange={(e) => reset(setSt)(e.target.value as StateFilter)}>
          <option value="all">All keys</option>
          <option value="unused">Unrevealed</option>
          <option value="revealed">Revealed</option>
          <option value="notredeemed">Revealed, not redeemed</option>
          <option value="platformredeemed">Redeemed on platform</option>
          <option value="gifted">Gifted / links</option>
          <option value="expiring">Expiring soon</option>
          <option value="expired">Expired</option>
          <option value="soldout">Sold out</option>
        </select>
        <ResetButton dirty={dirty} onReset={resetAll} />
        <span className="spacer" />
        <button
          className="hb-btn ghost"
          title="Copy 'Game: KEY' lines for revealed keys matching the filters"
          onClick={() => {
            const lines = rows.filter((k) => k.status === "revealed").map((k) => `${k.name}: ${k.key}`);
            void api.copy(lines.join("\n"));
            setCopied(lines.length);
            setTimeout(() => setCopied(null), 1500);
          }}
        >
          {copied != null ? `Copied ${copied}` : "Copy revealed"}
        </button>
        <ExportButton
          scope={`${bundle ? keyBundles.find((b) => b.gamekey === bundle)?.name || "this bundle" : "your keys"}${dirty ? " (matching the Keys tab's filters)" : ""}`}
          keys={rows}
        />
        <RevealSelected keys={lib.keys} sel={[sel, setSel]} selectLinks={false} />
      </div>
      <div className="hb-summary">
        {rows.length ? `${from}-${from + pageRows.length - 1} of ` : ""}
        {rows.length} key{rows.length === 1 ? "" : "s"}
        {hidden ? ` (${hidden} more hidden by the status filter; ${breakdown})` : base.length ? ` (${breakdown})` : ""}
        {expiring ? ` · ⚠ ${expiring} expiring within ${EXPIRING_DAYS} days` : ""}
        {soldOut > 0 && st !== "soldout" && (
          <>
            {" · "}
            <a className="warn-link" title="Show only sold-out keys" onClick={() => reset(setSt)("soldout")}>
              ⚠ {soldOut} sold out
            </a>
          </>
        )}
      </div>
      <div className="hb-tablewrap">
        <table className={`hb-keys ${table.tableClass}`} style={table.tableStyle}>
          <thead>
            <tr>{table.headers}</tr>
          </thead>
          <tbody>
            {pageRows.map((k) => (
              <tr key={k.id}>
                <td className="chk">
                  <input type="checkbox" checked={sel.has(k.id)} onChange={(e) => toggle(k.id, e.target.checked)} />
                </td>
                <td className="platform">
                  <PlatformBadge k={k} />
                </td>
                <td className="hb-game grow">
                  <h4 title={k.name}>{k.name}</h4>
                  <p title={k.bundle}>{k.bundle}</p>
                  <span className="row-links">
                    <HumbleLink of={k} />
                    {(platformOf(k).id === "steam" || k.steamAppId) && <ExtLink href={steamUrl(k.name, k.steamAppId)}>View on Steam</ExtLink>}
                  </span>
                </td>
                <td className="keycol">
                  <KeyField k={k} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="hb-empty">{lib.keys.length ? "No keys match these filters." : "No keys yet. Click Sync."}</div>}
      </div>
      <Pager page={cur} pages={pages} onPage={setPage} />
      <p className="hb-note">Revealing a key claims it to your account, and it can no longer be gifted. Reveal asks you to click twice.</p>
    </div>
  );
}

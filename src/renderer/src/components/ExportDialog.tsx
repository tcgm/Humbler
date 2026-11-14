// Export…: one window for every export, limited to the view it was opened
// from (a bundle, a Choice month, a filtered list).
//
//   Filters (both modes): platforms, key states, search, sort.
//   Key list mode: the keys themselves, joined by any separator (comma-
//     separated by default), each line from a template ("{key}",
//     "{name}: {key}", or your own), optionally grouped by bundle or platform.
//   Data mode: CSV, TSV, Markdown or JSON with the columns you pick, or the
//     full JSON (bundles, purchases, every key with all its data, items, files).
//
// The result is shown right here to Copy or Save to file. Unrevealed keys are
// never revealed for an export (that claims them; do it on purpose, elsewhere).
import { useEffect, useMemo, useRef, useState } from "react";
import { LuX } from "react-icons/lu";
import type { Bundle, KeyEntry, LibraryIndex } from "@shared/types";
import { useRemembered } from "../remember";
import { api, useStore, type OrderInfo } from "../store";
import { formatMoney, isExpiring, normTitle, platformOf, plural } from "../util";
import { CopyButton } from "./ui";

// ---- filters -------------------------------------------------------------------

/** Humble redeemed it to your account itself: its value is Humble's code, not a key to paste anywhere */
const humbleRedeemed = (k: KeyEntry) => !!k.autoRedeemed || /_keyless$/i.test(k.keyType);

const STATES = [
  { id: "ready", label: "Revealed, not redeemed", test: (k: KeyEntry) => k.status === "revealed" && !k.platformRedeemed && !humbleRedeemed(k) },
  { id: "redeemed", label: "Marked redeemed", test: (k: KeyEntry) => k.status === "revealed" && !!k.platformRedeemed && !humbleRedeemed(k) },
  { id: "humble", label: "Redeemed by Humble", test: (k: KeyEntry) => k.status === "revealed" && humbleRedeemed(k) },
  { id: "unused", label: "Unrevealed", test: (k: KeyEntry) => k.status === "unused" },
  { id: "expiring", label: "Expiring soon", test: isExpiring },
  { id: "gifted", label: "Gifted / links", test: (k: KeyEntry) => k.status === "gifted" || k.status === "link" },
  { id: "expired", label: "Expired", test: (k: KeyEntry) => k.status === "expired" },
  { id: "soldout", label: "Sold out", test: (k: KeyEntry) => k.status === "sold-out" },
] as const;
const DEFAULT_STATES = ["ready", "redeemed"]; // the keys you can use

const SORTS = {
  view: { label: "As in the view", cmp: null },
  name: { label: "Name", cmp: (a: KeyEntry, b: KeyEntry) => a.name.localeCompare(b.name) },
  bundle: { label: "Bundle", cmp: (a: KeyEntry, b: KeyEntry) => a.bundle.localeCompare(b.bundle) || a.name.localeCompare(b.name) },
  platform: { label: "Platform", cmp: (a: KeyEntry, b: KeyEntry) => platName(a).localeCompare(platName(b)) || a.name.localeCompare(b.name) },
  expiry: { label: "Expiry, soonest first", cmp: (a: KeyEntry, b: KeyEntry) => (Date.parse(a.expiry || "") || Infinity) - (Date.parse(b.expiry || "") || Infinity) },
  revealed: { label: "Revealed, newest first", cmp: (a: KeyEntry, b: KeyEntry) => (Date.parse(b.created || "") || 0) - (Date.parse(a.created || "") || 0) },
} as const;
type SortId = keyof typeof SORTS;

const platName = (k: KeyEntry) => platformOf(k).name || platformOf(k).badge;

// ---- key list mode ---------------------------------------------------------------

const SEPARATORS = {
  commaSpace: { label: "Comma + space  ( , )", sep: ", " },
  comma: { label: "Comma  (,)", sep: "," },
  newline: { label: "New line", sep: "\n" },
  semicolon: { label: "Semicolon  ( ; )", sep: "; " },
  tab: { label: "Tab", sep: "\t" },
  space: { label: "Space", sep: " " },
  custom: { label: "Custom…", sep: "" },
} as const;
type SepId = keyof typeof SEPARATORS;

const TEMPLATES = [
  { label: "Key", t: "{key}" },
  { label: "Game: KEY", t: "{name}: {key}" },
  { label: "Game - KEY (Platform)", t: "{name} - {key} ({platform})" },
  { label: "Quoted key", t: '"{key}"' },
  { label: "Redeem link", t: "{redeem}" },
];
const TOKENS = ["key", "name", "platform", "bundle", "status", "type", "expiry", "redeem"] as const;

function fillTemplate(t: string, k: KeyEntry): string {
  const p = platformOf(k);
  const v: Record<(typeof TOKENS)[number], string> = {
    key: (k.key || "").trim(),
    name: k.name,
    platform: platName(k),
    bundle: k.bundle,
    status: k.status,
    type: k.keyType,
    expiry: k.expiry ? k.expiry.slice(0, 10) : "",
    redeem: p.redeem && k.key ? p.redeem(k.key.trim()) : "",
  };
  return t.replace(/\{(\w+)\}/g, (m, name: string) => (name in v ? v[name as keyof typeof v] : m));
}

type Group = "none" | "bundle" | "platform";

// ---- data mode ----------------------------------------------------------------------

type DataFormat = "csv" | "tsv" | "md" | "json" | "jsonFull";
const DATA_FORMATS: { id: DataFormat; label: string; ext: string }[] = [
  { id: "csv", label: "CSV", ext: "csv" },
  { id: "tsv", label: "TSV (pastes into spreadsheets)", ext: "tsv" },
  { id: "md", label: "Markdown table", ext: "md" },
  { id: "json", label: "JSON (picked columns)", ext: "json" },
  { id: "jsonFull", label: "JSON, everything (bundles, purchases, keys, items, files)", ext: "json" },
];
const ESSENTIALS = ["name", "platform", "key", "status", "bundle", "expiry"];

/** one key as a flat row: everything Humbler knows, Humble's raw details as details.<field> */
function flatten(k: KeyEntry, orderOf: (gamekey: string) => OrderInfo | null): Record<string, unknown> {
  const { details, platformRedeemed, autoRedeemed, instructionLinks, cta, name, key, status, bundle, expiry, ...rest } = k;
  const order = orderOf(k.gamekey);
  const row: Record<string, unknown> = {
    // the essentials first, then everything else
    name,
    platform: platName(k),
    key,
    status,
    bundle,
    expiry,
    ...rest,
    redeemedOn: platformRedeemed?.platform || autoRedeemed?.platform || null,
    redeemedAt: platformRedeemed?.at || autoRedeemed?.at || null,
    redeemedBy: autoRedeemed ? "Humble" : platformRedeemed ? "you" : null,
    redeemAccount: autoRedeemed?.account || platformRedeemed?.account || null,
    redeemLink: platformOf(k).redeem && k.key ? platformOf(k).redeem!(k.key.trim()) : null,
    instructionLinks: instructionLinks?.map((l) => l.href).join(" ") || null,
    humbleButton: cta ? `${cta.label}: ${cta.url}` : null,
    purchaseDate: order?.createdAt || null,
    purchasePrice: order?.total ? formatMoney(order.total) : null,
    bundleKeyDeadline: order?.keyExpiration || null,
  };
  for (const [f, v] of Object.entries(details || {})) row[`details.${f}`] = v;
  return row;
}

const cellText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const csvCell = (v: unknown) => {
  const s = cellText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function renderData(format: DataFormat, rows: Record<string, unknown>[], cols: string[]): string {
  switch (format) {
    case "csv":
      return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");
    case "tsv": {
      const clean = (v: unknown) => cellText(v).replace(/[\t\r\n]+/g, " ");
      return [cols.join("\t"), ...rows.map((r) => cols.map((c) => clean(r[c])).join("\t"))].join("\n");
    }
    case "md": {
      const cell = (v: unknown) => cellText(v).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
      return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`)].join("\n");
    }
    default:
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))),
        null,
        2,
      );
  }
}

/** everything, grouped by bundle: the bundle and its purchase, every key with all its data, and
 *  (withItems) the bundle's library items and download files */
function renderFull(rows: KeyEntry[], cx: { lib: LibraryIndex; orderOf: (b: Bundle) => OrderInfo | null; scope: string; filters: object; withItems: boolean; version?: string }) {
  const byBundle = new Map<string, KeyEntry[]>();
  for (const k of rows) byBundle.set(k.gamekey, [...(byBundle.get(k.gamekey) || []), k]);
  const bundles = [...byBundle.entries()].map(([gamekey, ks]) => {
    const b = cx.lib.bundles.find((x) => x.gamekey === gamekey);
    return {
      ...(b || { gamekey, name: ks[0].bundle }),
      purchase: b ? cx.orderOf(b) : null,
      keys: ks.map((k) => ({ platform: platName(k), ...k })),
      ...(cx.withItems ? { items: cx.lib.products.filter((p) => p.gamekey === gamekey), files: cx.lib.files.filter((f) => f.gamekey === gamekey) } : {}),
    };
  });
  return JSON.stringify(
    { exportedBy: `Humbler${cx.version ? ` ${cx.version}` : ""}`, exportedAt: new Date().toISOString(), scope: cx.scope, filters: cx.filters, counts: { bundles: bundles.length, keys: rows.length }, bundles },
    null,
    2,
  );
}

// ---- the button and the window --------------------------------------------------------

/** The Export… button: opens the export window for `keys` (whatever the view shows). */
export function ExportButton({ scope, keys, className = "hb-btn ghost" }: { scope: string; keys: KeyEntry[]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={className}
        disabled={!keys.length}
        title={keys.length ? `Export the ${plural(keys.length, "key")} in view: key lists, CSV, JSON...` : "No keys in view"}
        onClick={() => setOpen(true)}
      >
        Export…
      </button>
      {open && <ExportDialog scope={scope} keys={keys} onClose={() => setOpen(false)} />}
    </>
  );
}

type Mode = "list" | "data";

export function ExportDialog({ scope, keys, onClose }: { scope: string; keys: KeyEntry[]; onClose: () => void }) {
  const { lib, orders, status } = useStore();
  // remembered between exports
  const [mode, setMode] = useRemembered<Mode>("export.mode", "list");
  const [plats, setPlats] = useRemembered<string[]>("export.platforms", []);
  const [states, setStates] = useRemembered<string[]>("export.states", DEFAULT_STATES);
  const [sort, setSort] = useRemembered<SortId>("export.sort", "view");
  const [sepId, setSepId] = useRemembered<SepId>("export.sep", "commaSpace");
  const [customSep, setCustomSep] = useRemembered("export.customSep", " | ");
  const [template, setTemplate] = useRemembered("export.template", "{key}");
  const [group, setGroup] = useRemembered<Group>("export.group", "none");
  const [dedupe, setDedupe] = useRemembered("export.dedupe", true);
  const [dataFormat, setDataFormat] = useRemembered<DataFormat>("export.dataFormat", "csv");
  const [cols, setCols] = useRemembered<string[]>("export.columns", ESSENTIALS);
  const [withItems, setWithItems] = useRemembered("export.withItems", true);
  // this time only
  const [q, setQ] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  const orderOfKey = useMemo(() => {
    const byKey = new Map(lib.bundles.map((b) => [b.gamekey, orders.get(normTitle(b.name)) || null]));
    return (gamekey: string) => byKey.get(gamekey) ?? null;
  }, [lib.bundles, orders]);

  // what's in scope, for the chip counts
  const platformCounts = useMemo(() => {
    const n = new Map<string, { name: string; count: number }>();
    for (const k of keys) {
      const p = platformOf(k);
      const cur = n.get(p.id) || { name: platName(k), count: 0 };
      cur.count += 1;
      n.set(p.id, cur);
    }
    return [...n.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [keys]);
  const selPlats = plats.filter((p) => platformCounts.some(([id]) => id === p)); // remembered ones not in scope don't count
  const byPlatform = useMemo(
    () => keys.filter((k) => !selPlats.length || selPlats.includes(platformOf(k).id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, selPlats.join()],
  );
  const stateCount = (id: string) => byPlatform.filter(STATES.find((s) => s.id === id)!.test).length;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const tests = STATES.filter((s) => states.includes(s.id)).map((s) => s.test);
    let out = byPlatform.filter(
      (k) => (!tests.length || tests.some((t) => t(k))) && (!needle || `${k.name} ${k.bundle} ${k.key || ""} ${platName(k)} ${k.keyType}`.toLowerCase().includes(needle)),
    );
    const cmp = SORTS[sort]?.cmp;
    if (cmp) out = [...out].sort(cmp);
    return out;
  }, [byPlatform, states, q, sort]);

  // key list: only keys with something to list
  const listRows = useMemo(() => {
    let out = rows.filter((k) => !!k.key);
    if (dedupe) {
      const seen = new Set<string>();
      out = out.filter((k) => {
        const v = k.key!.trim();
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });
    }
    return out;
  }, [rows, dedupe]);
  const noKey = rows.filter((k) => !k.key).length;
  const dupes = rows.length - noKey - listRows.length;

  // every column any key in scope has (stable while filtering)
  const allCols = useMemo(() => {
    const set: string[] = [];
    for (const k of keys) for (const c of Object.keys(flatten(k, orderOfKey))) if (!set.includes(c)) set.push(c);
    return set;
  }, [keys, orderOfKey]);
  const pickedCols = allCols.filter((c) => cols.includes(c));
  const useCols = pickedCols.length ? pickedCols : ESSENTIALS;

  const sep = sepId === "custom" ? customSep.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : SEPARATORS[sepId]?.sep ?? ", ";
  const text = useMemo(() => {
    if (mode === "list") {
      const join = (ks: KeyEntry[]) => ks.map((k) => fillTemplate(template || "{key}", k)).join(sep);
      if (group === "none") return join(listRows);
      const groups = new Map<string, KeyEntry[]>();
      for (const k of listRows) {
        const g = group === "bundle" ? k.bundle : platName(k);
        groups.set(g, [...(groups.get(g) || []), k]);
      }
      return [...groups.entries()].map(([g, ks]) => `${g}:\n${join(ks)}`).join("\n\n");
    }
    if (dataFormat === "jsonFull") {
      return renderFull(rows, {
        lib,
        orderOf: (b) => orders.get(normTitle(b.name)) || null,
        scope,
        filters: { platforms: selPlats.length ? selPlats : "all", states: states.length ? states : "all", search: q || null },
        withItems,
        version: status?.version,
      });
    }
    return renderData(
      dataFormat,
      rows.map((k) => flatten(k, orderOfKey)),
      useCols,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, listRows, template, sep, group, dataFormat, rows, useCols.join(), withItems, lib, orders, orderOfKey, scope, status?.version]);

  const count = mode === "list" ? listRows.length : rows.length;
  const ext = mode === "list" ? "txt" : DATA_FORMATS.find((f) => f.id === dataFormat)?.ext || "txt";
  const fileName = `humble-keys-${new Date().toISOString().slice(0, 10)}.${ext}`;
  useEffect(() => setSaved(null), [text]);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="ask-backdrop hb" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ask export" role="dialog" aria-modal="true" aria-labelledby="exportTitle">
        <div className="folders-head">
          <h3 id="exportTitle">Export keys</h3>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <LuX aria-hidden />
          </button>
        </div>
        <p className="muted-line">
          From {scope} · {plural(keys.length, "key")}
        </p>

        <div className="export-modes" role="tablist">
          <button role="tab" aria-selected={mode === "list"} className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>
            Key list
            <small>comma-separated, one per line, templates</small>
          </button>
          <button role="tab" aria-selected={mode === "data"} className={mode === "data" ? "active" : ""} onClick={() => setMode("data")}>
            Data
            <small>CSV, TSV, Markdown, JSON</small>
          </button>
        </div>

        <div className="export-body">
          <div className="export-side">
            <h4>
              Platforms
              {selPlats.length > 0 && <a onClick={() => setPlats([])}>all</a>}
            </h4>
            <div className="chips">
              {platformCounts.map(([id, p]) => (
                <button key={id} className={`chip${selPlats.includes(id) ? " on" : ""}`} onClick={() => toggle(selPlats, setPlats, id)}>
                  {p.name} <span>{p.count}</span>
                </button>
              ))}
            </div>

            <h4>
              Keys
              <a onClick={() => setStates(DEFAULT_STATES)} title="Revealed keys you can use">
                usable
              </a>
              <a onClick={() => setStates([])}>all</a>
            </h4>
            <div className="chips">
              {STATES.map((s) => {
                const n = stateCount(s.id);
                return (
                  <button key={s.id} className={`chip${states.includes(s.id) ? " on" : ""}`} disabled={!n && !states.includes(s.id)} onClick={() => toggle(states, setStates, s.id)}>
                    {s.label} <span>{n}</span>
                  </button>
                );
              })}
            </div>

            <h4>Search &amp; sort</h4>
            <input className="hb-search" type="search" placeholder="Name, bundle, key…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={sort} onChange={(e) => setSort(e.target.value as SortId)}>
              {Object.entries(SORTS).map(([id, s]) => (
                <option key={id} value={id}>
                  Sort: {s.label}
                </option>
              ))}
            </select>

            {mode === "list" ? (
              <>
                <h4>Separator</h4>
                <select value={sepId} onChange={(e) => setSepId(e.target.value as SepId)}>
                  {Object.entries(SEPARATORS).map(([id, s]) => (
                    <option key={id} value={id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {sepId === "custom" && <input value={customSep} onChange={(e) => setCustomSep(e.target.value)} placeholder="e.g.  |  (\n = new line, \t = tab)" />}

                <h4>Each entry</h4>
                <select value={TEMPLATES.find((t) => t.t === template)?.t ?? ""} onChange={(e) => e.target.value && setTemplate(e.target.value)}>
                  {!TEMPLATES.some((t) => t.t === template) && <option value="">Custom</option>}
                  {TEMPLATES.map((t) => (
                    <option key={t.t} value={t.t}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input value={template} onChange={(e) => setTemplate(e.target.value)} title={`Placeholders: ${TOKENS.map((t) => `{${t}}`).join(" ")}`} />
                <small className="muted-line">{TOKENS.map((t) => `{${t}}`).join(" ")}</small>

                <h4>Options</h4>
                <select value={group} onChange={(e) => setGroup(e.target.value as Group)}>
                  <option value="none">No grouping</option>
                  <option value="bundle">Grouped by bundle</option>
                  <option value="platform">Grouped by platform</option>
                </select>
                <label className="export-check">
                  <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} /> Skip duplicate keys
                </label>
              </>
            ) : (
              <>
                <h4>Format</h4>
                <select value={dataFormat} onChange={(e) => setDataFormat(e.target.value as DataFormat)}>
                  {DATA_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {dataFormat === "jsonFull" ? (
                  <label className="export-check" title="Each bundle's library items and download files (names, sizes, checksums, what's on disk)">
                    <input type="checkbox" checked={withItems} onChange={(e) => setWithItems(e.target.checked)} /> Include items &amp; downloads
                  </label>
                ) : (
                  <>
                    <h4>
                      Columns ({useCols.length}/{allCols.length})
                      <a onClick={() => setCols(ESSENTIALS)}>essentials</a>
                      <a onClick={() => setCols(allCols)}>all</a>
                    </h4>
                    <div className="export-cols">
                      {allCols.map((c) => (
                        <label key={c} className="export-check" title={c}>
                          <input type="checkbox" checked={useCols.includes(c)} onChange={() => setCols(useCols.includes(c) ? useCols.filter((x) => x !== c) : [...useCols, c])} /> {c}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="export-main">
            <p className="muted-line">
              {plural(count, "key")}
              {mode === "list" && noKey ? ` · ${noKey} without a key value skipped (unrevealed, gifted...)` : ""}
              {mode === "list" && dupes ? ` · ${plural(dupes, "duplicate")} skipped` : ""}
              {mode === "data" && dataFormat === "jsonFull" ? ` from ${plural(new Set(rows.map((k) => k.gamekey)).size, "bundle")}` : ""}
            </p>
            {count ? (
              <textarea className="export-keys-text" readOnly value={text} onFocus={(e) => e.currentTarget.select()} />
            ) : (
              <div className="hb-empty">Nothing matches. Try other platforms or key states.</div>
            )}
          </div>
        </div>

        <div className="ask-actions">
          {saved && (
            <span className="muted-line export-saved" title={saved}>
              {saved}
            </span>
          )}
          {count > 0 && (
            <>
              <CopyButton text={text} label="Copy" className="hb-btn" />
              <button
                className="hb-btn ghost"
                title={`Save this as .${ext} (you pick where)`}
                onClick={async () => {
                  const r = await api.saveTextFile(fileName, text);
                  if (r?.ok) setSaved(`Saved to ${r.filePath}`);
                }}
              >
                Save to file…
              </button>
            </>
          )}
          <button className="hb-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

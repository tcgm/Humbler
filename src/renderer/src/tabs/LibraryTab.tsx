// Library: everything you own (Humble Librarian's list), including
// links-only items.
import { useMemo } from "react";
import { ExportButton } from "../components/ExportDialog";
import { ExtLink, HumbleLink, ResetButton } from "../components/ui";
import { useRemembered } from "../remember";
import { api, useStore } from "../store";
import { normTitle, SITE, steamUrl } from "../util";

const ROW_LIMIT = 1500;
type Kind = "" | "files" | "keys" | "links";

export function LibraryTab() {
  const { lib, status } = useStore();
  const [q, setQ] = useRemembered("library.q", "");
  const [bundle, setBundle] = useRemembered("library.bundle", "");
  const [kind, setKind] = useRemembered<Kind>("library.kind", "");
  const dirty = q !== "" || bundle !== "" || kind !== "";
  const resetAll = () => {
    setQ("");
    setBundle("");
    setKind("");
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lib.products
      .filter((p) => {
        if (bundle && p.gamekey !== bundle) return false;
        if (kind === "files" && !p.fileCount) return false;
        if (kind === "keys" && !p.keyCount) return false;
        if (kind === "links" && (p.fileCount || p.keyCount)) return false;
        if (needle && !`${p.title} ${p.publisher || ""} ${p.bundle}`.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [lib.products, q, bundle, kind]);
  const bundleOf = useMemo(() => new Map(lib.bundles.map((b) => [b.gamekey, b])), [lib.bundles]);
  const linksOnly = rows.filter((p) => !p.fileCount && !p.keyCount).length;
  // the keys of the items shown (by item id; older data by bundle + title, as the Choice pages do)
  const rowKeys = useMemo(() => {
    const ids = new Set(rows.map((p) => p.id));
    const named = new Set(rows.map((p) => `${p.gamekey}|${normTitle(p.title)}`));
    return lib.keys.filter((k) => (k.itemId ? ids.has(k.itemId) : named.has(`${k.gamekey}|${normTitle(k.name)}`)));
  }, [rows, lib.keys]);

  return (
    <section className="panel">
      <div className="filters">
        <input type="search" placeholder="Search title, publisher, bundle…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={bundle} onChange={(e) => setBundle(e.target.value)}>
          <option value="">All bundles ({lib.bundles.length})</option>
          {lib.bundles.map((b) => (
            <option key={b.gamekey} value={b.gamekey}>
              {b.name}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="">Everything</option>
          <option value="files">Has downloads</option>
          <option value="keys">Has keys</option>
          <option value="links">Links / instructions only</option>
        </select>
        <ResetButton dirty={dirty} onReset={resetAll} />
        <label className="check" title="Highlight things you already own on Humble's store, bundle and Choice pages">
          <input type="checkbox" checked={!!status?.markOwned} onChange={(e) => api.setSettings({ markOwned: e.target.checked })} /> Mark owned on Humble pages
        </label>
      </div>
      <div className="toolbar">
        <span className="muted">
          {rows.length} item(s){linksOnly ? ` · ${linksOnly} links/instructions only` : ""}
        </span>
        <span className="spacer" />
        <ExportButton
          className=""
          scope={`${bundle ? bundleOf.get(bundle)?.name || "this bundle" : "your library"}${q || kind ? " (matching the Library tab's filters)" : ""}`}
          keys={rowKeys}
        />
      </div>
      <div className="tableWrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="iconcol" />
              <th>Title</th>
              <th>Bundle</th>
              <th className="whatcol">Has</th>
              <th className="actcol" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_LIMIT).map((p) => {
              const b = bundleOf.get(p.gamekey);
              const when = b?.created ? b.created.slice(0, 10) : "";
              const paid = b?.amount != null && b.amount !== "" ? ` · ${b.amount}${b.currency ? ` ${b.currency}` : ""}` : "";
              const has = [
                p.fileCount ? (
                  <span key="f" className="tag" title={p.platforms.join(", ")}>
                    {p.fileCount} file{p.fileCount > 1 ? "s" : ""}
                  </span>
                ) : null,
                p.keyCount ? (
                  <span key="k" className="tag">
                    {p.keyCount} key{p.keyCount > 1 ? "s" : ""}
                  </span>
                ) : null,
                p.links.length || p.linksText ? (
                  <span key="l" className="tag warn" title={p.linksText || p.links.join("\n")}>
                    links
                  </span>
                ) : null,
              ].filter(Boolean);
              return (
                <tr key={p.id}>
                  <td className="iconcol">{p.icon ? <img className="icon" src={p.icon} loading="lazy" alt="" /> : <div className="icon" />}</td>
                  <td title={p.title}>
                    {p.title}
                    <span className="sub">{p.publisher || ""}</span>
                  </td>
                  <td title={p.bundle}>
                    {p.bundle}
                    <span className="sub">
                      {when}
                      {paid}
                    </span>
                  </td>
                  <td className="whatcol">
                    <div className="tags">{has.length ? has : <span className="tag">-</span>}</div>
                  </td>
                  <td className="actcol">
                    {(p.keyCount > 0 || p.steamAppId) && <ExtLink href={steamUrl(p.title, p.steamAppId)}>Steam</ExtLink>}
                    <HumbleLink of={p} label="Humble" />
                    {!p.v2 && p.url && <ExtLink href={p.url}>Site</ExtLink>}
                    {p.links.slice(0, 3).map((u, i) => (
                      <ExtLink key={u} href={u}>
                        {p.links.length > 1 ? `Link ${i + 1}` : "Link"}
                      </ExtLink>
                    ))}
                    {p.v2 ? (
                      <ExtLink href={`${SITE}/home/library/${encodeURIComponent(p.gamekey)}`} title="Open this purchase on Humble">
                        Bundle
                      </ExtLink>
                    ) : (
                      <ExtLink href={`${SITE}/downloads?key=${encodeURIComponent(p.gamekey)}`} title="Open this order on Humble">
                        Order
                      </ExtLink>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
      </div>
    </section>
  );
}

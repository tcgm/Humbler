// Bundles: your bundles as a list (icon, purchase, deadline), and a bundle
// page modelled on the old humblebundle.com /downloads?key=... page.
import { useMemo } from "react";
import type { Bundle, FileEntry } from "@shared/types";
import { FileButton } from "../components/FileButton";
import { KeyField } from "../components/KeyField";
import { BackLink, BundleIcon, DeadlineBadge, ExtLink, HumbleLink, Pager, PlatformBadge, ResetButton, Tile, useOrderInfo } from "../components/ui";
import { useRemembered, useRememberedScroll } from "../remember";
import { api, useStore } from "../store";
import { bundleUrl, deadlineOf, fmtBytes, formatDate, formatMoney, monthLabel, normTitle, PLATFORM_LABELS, plural } from "../util";

const PER_PAGE = 60;
type Sort = "recent" | "az" | "unrevealed" | "deadline";
type Filter = "all" | "unrevealed" | "deadline" | "soldout" | "files" | "ondisk" | "missing" | "choice" | "nochoice";

const stats = (b: Bundle) =>
  [plural(b.itemCount ?? 0, "item"), b.keyCount ? plural(b.keyCount, "key") : null, b.fileCount ? plural(b.fileCount, "file") : null].filter(Boolean).join(" · ");

export function BundlesTab() {
  const { bundleId } = useStore();
  return bundleId ? <BundlePage id={bundleId} /> : <BundleList />;
}

function BundleList() {
  const { lib, orders, ordersTotal, openBundle } = useStore();
  const [q, setQ] = useRemembered("bundles.q", "");
  const [sort, setSort] = useRemembered<Sort>("bundles.sort", "recent");
  const [filter, setFilter] = useRemembered<Filter>("bundles.filter", "all");
  const [page, setPage] = useRemembered("bundles.page", 1);
  const scrollRef = useRememberedScroll<HTMLDivElement>("bundles");
  const dirty = q !== "" || sort !== "recent" || filter !== "all";
  const resetAll = () => {
    setQ("");
    setSort("recent");
    setFilter("all");
    setPage(1);
  };

  // Deadline per bundle: soonest expiry among its unrevealed keys, else the
  // order's bundle-wide key deadline.
  const deadlines = useMemo(() => {
    const byBundle = new Map<string, typeof lib.keys>();
    for (const k of lib.keys) byBundle.set(k.gamekey, [...(byBundle.get(k.gamekey) || []), k]);
    return new Map(lib.bundles.map((b) => [b.gamekey, deadlineOf(byBundle.get(b.gamekey) || [], orders.get(normTitle(b.name))?.keyExpiration)]));
  }, [lib, orders]);

  // sold-out keys per bundle
  const soldOut = useMemo(() => {
    const n = new Map<string, number>();
    for (const k of lib.keys) if (k.status === "sold-out") n.set(k.gamekey, (n.get(k.gamekey) || 0) + 1);
    return n;
  }, [lib.keys]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = lib.bundles.filter((b) => {
      if (needle && !b.name.toLowerCase().includes(needle)) return false;
      if (filter === "unrevealed" && !b.unrevealed) return false;
      if (filter === "deadline" && !deadlines.get(b.gamekey)) return false;
      if (filter === "soldout" && !soldOut.get(b.gamekey)) return false;
      if (filter === "files" && !b.fileCount) return false;
      if (filter === "ondisk" && !b.diskDirs?.length) return false;
      if (filter === "missing" && !(b.fileCount && (b.filesOnDisk ?? 0) < b.fileCount)) return false;
      if (filter === "choice" && !b.choiceMonth) return false;
      if (filter === "nochoice" && b.choiceMonth) return false;
      return true;
    });
    const recent = (a: Bundle, b: Bundle) => (a.order ?? 0) - (b.order ?? 0);
    if (sort === "az") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "unrevealed") out = [...out].sort((a, b) => (b.unrevealed || 0) - (a.unrevealed || 0) || recent(a, b));
    else if (sort === "deadline") {
      const t = (b: Bundle) => deadlines.get(b.gamekey)?.t ?? Infinity; // bundles without one go last
      out = [...out].sort((a, b) => t(a) - t(b) || recent(a, b));
    } else out = [...out].sort(recent);
    return out;
  }, [lib.bundles, q, sort, filter, deadlines, soldOut]);

  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const shown = list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
  const set = <T,>(f: (v: T) => void) => (v: T) => {
    f(v);
    setPage(1);
  };

  return (
    <div className="hb-page hb-scroll" ref={scrollRef}>
      <div className="hb-head">
        <h2>Your Bundles</h2>
        <div className="hb-controls">
          <input className="hb-search" type="search" placeholder="Search bundles" value={q} onChange={(e) => set(setQ)(e.target.value)} />
          <select title="Sort" value={sort} onChange={(e) => set(setSort)(e.target.value as Sort)}>
            <option value="recent">Most recent</option>
            <option value="az">A – Z</option>
            <option value="unrevealed">Most unrevealed keys</option>
            <option value="deadline">Deadline soonest</option>
          </select>
          <select title="Show" value={filter} onChange={(e) => set(setFilter)(e.target.value as Filter)}>
            <option value="all">All bundles</option>
            <option value="unrevealed">With unrevealed keys</option>
            <option value="deadline">With a redeem deadline</option>
            <option value="soldout">With sold-out keys</option>
            <option value="files">With downloads</option>
            <option value="ondisk">With a folder on disk</option>
            <option value="missing">Missing files (not on disk)</option>
            <option value="choice">Humble Choice months</option>
            <option value="nochoice">Everything but Choice</option>
          </select>
          <ResetButton dirty={dirty} onReset={resetAll} />
        </div>
      </div>
      <div className="hb-summary">
        {plural(list.length, "bundle")}
        {q || filter !== "all" ? ` of ${lib.bundles.length}` : ""}
        {orders.size
          ? ` · purchase details for ${orders.size}${ordersTotal ? ` of ${ordersTotal} orders` : ""}${ordersTotal && orders.size < ordersTotal ? " (Sync fetches the rest)" : ""}`
          : " · Sync to add bundle icons and purchase dates"}
      </div>
      {list.length ? (
        <div className="hb-list">
          {shown.map((b) => (
            <BundleRow key={b.gamekey} b={b} dl={deadlines.get(b.gamekey) ?? null} soldOut={soldOut.get(b.gamekey) || 0} onOpen={() => openBundle(b.gamekey)} />
          ))}
        </div>
      ) : (
        <div className="hb-empty">{lib.bundles.length ? "No bundles match." : "No bundles yet. Click Sync."}</div>
      )}
      <Pager page={cur} pages={pages} onPage={setPage} />
    </div>
  );
}

function BundleRow({ b, dl, soldOut, onOpen }: { b: Bundle; dl: ReturnType<typeof deadlineOf>; soldOut: number; onOpen: () => void }) {
  const info = useOrderInfo(b);
  const bought = info?.createdAt ? `Bought ${formatDate(info.createdAt)}${info.total ? ` · ${formatMoney(info.total)}` : ""}` : null;
  return (
    <button className="hb-row" title={b.name} onClick={onOpen}>
      <BundleIcon b={b} />
      <div className="hb-row-main">
        <h4>{b.name}</h4>
        <p>{[stats(b), bought].filter(Boolean).join(" · ")}</p>
        {!!b.diskDirs?.length && (
          <p className="on-disk" title={b.diskDirs.join("\n")}>
            {b.fileCount ? `${b.filesOnDisk ?? 0} of ${b.fileCount} files on disk${b.olderOnDisk ? ` (+${b.olderOnDisk} older version${b.olderOnDisk === 1 ? "" : "s"})` : ""}` : "Has a folder on disk"}
          </p>
        )}
        {(!!b.unrevealed || soldOut > 0) && (
          <div className="hb-flags">
            {!!b.unrevealed && <span className="hb-flag">{b.unrevealed} unrevealed</span>}
            {soldOut > 0 && <span className="hb-flag red">⚠ {soldOut} sold out</span>}
          </div>
        )}
      </div>
      <DeadlineBadge dl={dl} />
    </button>
  );
}

function BundlePage({ id }: { id: string }) {
  const { lib, openBundle, openChoiceMonth } = useStore();
  const [platform, setPlatform] = useRemembered(`bundle.${id}.platform`, "");
  const b = lib.bundles.find((x) => x.gamekey === id);
  const info = useOrderInfo(b);
  if (!b) {
    return (
      <div className="hb-page hb-scroll">
        <BackLink onClick={() => openBundle(null)}>All bundles</BackLink>
        <div className="hb-empty">This bundle isn't in your library any more.</div>
      </div>
    );
  }
  const keys = lib.keys.filter((k) => k.gamekey === b.gamekey);
  const files = lib.files.filter((f) => f.gamekey === b.gamekey);
  const linkOnly = lib.products.filter((p) => p.gamekey === b.gamekey && !p.keyCount && !p.fileCount);
  const platforms = [...new Set(files.map((f) => f.platform))];
  const pl = platforms.includes(platform) ? platform : "";
  const visible = files.filter((f) => !pl || f.platform === pl);
  const fetchable = visible.filter((f) => f.downloadable && !f.downloaded);
  const byProduct = new Map<string, FileEntry[]>();
  for (const f of visible) byProduct.set(f.product, [...(byProduct.get(f.product) || []), f]);

  return (
    <div className="hb-page hb-scroll">
      <BackLink onClick={() => openBundle(null)}>All bundles</BackLink>
      <div className="hb-bundle-head">
        <BundleIcon b={b} size="lg" />
        <div className="hb-bundle-head-main">
          <h2>{b.name}</h2>
          <p className="hb-summary">
            {[
              stats(b) + (b.unrevealed ? ` · ${b.unrevealed} unrevealed` : ""),
              keys.some((k) => k.status === "sold-out") ? `⚠ ${keys.filter((k) => k.status === "sold-out").length} sold out` : null,
              info?.createdAt ? `Bought ${formatDate(info.createdAt)}${info.total ? ` for ${formatMoney(info.total)}` : ""}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {!!b.diskDirs?.length && (
            <p className="on-disk">
              {b.fileCount ? `${b.filesOnDisk ?? 0} of ${b.fileCount} files on disk${b.olderOnDisk ? ` (+${b.olderOnDisk} older version${b.olderOnDisk === 1 ? "" : "s"})` : ""} in ` : "On disk in "}
              {b.diskDirs.map((d, i) => (
                <span key={d}>
                  {i > 0 && ", "}
                  <a className="ext" title="Open this folder" onClick={() => api.openFolder(d)}>
                    {d}
                  </a>
                </span>
              ))}
            </p>
          )}
          <div className="hb-links">
            <ExtLink href={bundleUrl(b)} title="Open this purchase on Humble (right)">
              Open on Humble
            </ExtLink>
            {b.choiceMonth && (
              <a className="ext" title="Open this month's Choice page in Humbler" onClick={() => openChoiceMonth(b.choiceMonth!)}>
                {monthLabel(b.choiceMonth)} Choice page
              </a>
            )}
          </div>
        </div>
        <DeadlineBadge dl={deadlineOf(keys, info?.keyExpiration)} />
      </div>

      {keys.length > 0 && (
        <section className="hb-section">
          <h3>Keys &amp; Entitlements</h3>
          <div className="hb-panel">
            {keys.map((k) => (
              <div className="hb-keyline" key={k.id}>
                <PlatformBadge k={k} />
                <div className="hb-keyline-title">
                  <h4>{k.name}</h4>
                  <HumbleLink of={k} />
                </div>
                <div className="hb-keyline-field">
                  <KeyField k={k} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section className="hb-section">
          <div className="hb-section-head">
            <h3>Downloads</h3>
            <button
              className="hb-btn"
              disabled={!fetchable.length}
              title={fetchable.length ? `${fmtBytes(fetchable.reduce((s, f) => s + (f.size || 0), 0))} to Humbler's download folder` : ""}
              onClick={() => api.enqueueDownloads(fetchable.map((f) => f.id))}
            >
              {fetchable.length ? `Download all${pl ? ` ${PLATFORM_LABELS[pl] || pl}` : ""} (${fetchable.length})` : "Everything here is downloaded"}
            </button>
          </div>
          <div className="plat-tabs">
            {["", ...platforms].map((p) => (
              <button key={p || "all"} className={p === pl ? "active" : ""} onClick={() => setPlatform(p)}>
                {p ? PLATFORM_LABELS[p] || p : "All platforms"}
              </button>
            ))}
          </div>
          <div className="hb-panel">
            {[...byProduct.entries()].map(([title, fs]) => {
              const multi = new Set(fs.map((f) => f.platform)).size > 1;
              return (
                <div className="hb-dlrow" key={title}>
                  <Tile title={title} size="sm" />
                  <div className="hb-dlrow-title">
                    <h4>{title}</h4>
                    <p>{[...new Set(fs.map((f) => PLATFORM_LABELS[f.platform] || f.platform))].join(" · ")}</p>
                    <HumbleLink of={fs[0]} />
                  </div>
                  <div className="hb-dlrow-files">
                    {fs.map((f) => (
                      // with "All platforms" showing, say which platform each file is for
                      <FileButton key={f.id} f={f} showPlatform={!pl && multi} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {linkOnly.length > 0 && (
        <section className="hb-section">
          <h3>Other items</h3>
          <div className="hb-panel">
            {linkOnly.map((p) => (
              <div className="hb-dlrow" key={p.id}>
                <Tile title={p.title} size="sm" />
                <div className="hb-dlrow-title">
                  <h4>{p.title}</h4>
                  <p>No key or download in the library data</p>
                </div>
                <div>
                  <HumbleLink of={p} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

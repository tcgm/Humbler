// Downloads: every file across every bundle, with filters and a queue.
import { memo, useMemo, useState } from "react";
import type { DownloadProgress, FileEntry, Naming } from "@shared/types";
import { byNumber, byText, useTable, type Col } from "../components/Table";
import { ExtLink, HumbleLink, ResetButton } from "../components/ui";
import { useRemembered } from "../remember";
import { api, useStore } from "../store";
import { fmtBytes, uniqSorted } from "../util";

const ROW_LIMIT = 1500;

export function DownloadsTab() {
  const { lib, progress, status } = useStore();
  const [q, setQ] = useRemembered("downloads.q", "");
  const [bundle, setBundle] = useRemembered("downloads.bundle", "");
  const [platform, setPlatform] = useRemembered("downloads.platform", "");
  const [format, setFormat] = useRemembered("downloads.format", "");
  const [hideDone, setHideDone] = useRemembered("downloads.hideDone", true);
  const [hideDupes, setHideDupes] = useRemembered("downloads.hideDupes", true);
  const dirty = q !== "" || bundle !== "" || platform !== "" || format !== "" || !hideDone || !hideDupes;
  const resetAll = () => {
    setQ("");
    setBundle("");
    setPlatform("");
    setFormat("");
    setHideDone(true);
    setHideDupes(true);
  };
  const [sel, setSel] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lib.files.filter(
      (f) =>
        (!bundle || f.gamekey === bundle) &&
        (!platform || f.platform === platform || !!f.platforms?.includes(platform)) &&
        (!format || f.format === format) &&
        !(hideDone && f.downloaded && !progress[f.id]) &&
        !(hideDupes && f.duplicateOf) &&
        (!needle || `${f.product} ${f.bundle} ${f.filename}`.toLowerCase().includes(needle)),
    );
  }, [lib.files, q, bundle, platform, format, hideDone, hideDupes, progress]);

  // where a file is: downloading first, then queued, failed, to get, not downloadable, done
  const stage = (f: FileEntry) => {
    const p = progress[f.id]?.state;
    return p === "downloading" ? 0 : p === "queued" ? 1 : p === "error" ? 2 : f.downloaded ? 5 : f.downloadable ? (linkState(f) === "ready" ? 3 : 3.5) : 4;
  };
  const allOn = selectableOf(rows).length > 0 && selectableOf(rows).every((f) => sel.has(f.id));
  const cols: Col<FileEntry>[] = [
    {
      id: "chk",
      className: "chk",
      fixed: true,
      label: (
        <input
          type="checkbox"
          title="Select all shown"
          checked={allOn}
          onChange={(e) =>
            setSel((s) => (e.target.checked ? new Set([...s, ...selectableOf(rows).map((f) => f.id)]) : new Set([...s].filter((id) => !selectableOf(rows).some((f) => f.id === id)))))
          }
        />
      ),
    },
    { id: "title", label: "Title", grow: 1, sort: byText((f) => f.product) },
    { id: "platform", label: "Platform", sort: byText((f) => (f.platforms || [f.platform]).join(", ")) },
    { id: "format", label: "Format", sort: byText((f) => f.format) },
    { id: "size", label: "Size", className: "num", sort: byNumber((f) => f.size || null) },
    { id: "status", label: "Status", className: "statcol", sort: (a, b) => stage(a) - stage(b) },
  ];
  const table = useTable("downloads", cols, rows);

  const fileBundles = useMemo(() => lib.bundles.filter((b) => b.fileCount), [lib.bundles]);
  const platforms = useMemo(() => uniqSorted(lib.files.flatMap((f) => f.platforms || [f.platform])), [lib.files]);
  const formats = useMemo(() => uniqSorted(lib.files.map((f) => f.format)), [lib.files]);
  // what Download selected would fetch (already-downloaded files are skipped)
  const selBytes = useMemo(() => {
    if (!sel.size) return 0;
    let n = 0;
    for (const f of lib.files) if (sel.has(f.id) && !f.downloaded) n += f.size || 0;
    return n;
  }, [sel, lib.files]);
  const toGet = rows.reduce((s, f) => s + (f.downloaded ? 0 : f.size || 0), 0);
  const links = useMemo(() => {
    const now = Date.now();
    const c = { ready: 0, expired: 0, none: 0 };
    for (const f of rows) if (f.downloadable && !f.downloaded) c[linkState(f, now)] += 1;
    return c;
  }, [rows]);

  const toggle = (id: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <section className="panel">
      <div className="filters">
        <input type="search" placeholder="Search title, bundle, filename…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={bundle} onChange={(e) => setBundle(e.target.value)}>
          <option value="">All bundles ({fileBundles.length})</option>
          {fileBundles.map((b) => (
            <option key={b.gamekey} value={b.gamekey}>
              {b.name}
            </option>
          ))}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="">All formats</option>
          {formats.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide downloaded
        </label>
        <label className="check">
          <input type="checkbox" checked={hideDupes} onChange={(e) => setHideDupes(e.target.checked)} /> Hide duplicates
        </label>
        <ResetButton dirty={dirty} onReset={resetAll} />
      </div>
      <div className="toolbar">
        <span className="muted">
          {rows.length} shown · {fmtBytes(toGet) || "0 B"} not yet downloaded
        </span>
        {links.ready + links.expired + links.none > 0 && (
          <span className="muted" title="Of the shown files still to download: how many already have a working signed link, and how many get one from Humble when their download starts">
            · links: {links.ready} ready
            {links.expired ? `, ${links.expired} expired` : ""}
            {links.none ? `, ${links.none} to fetch` : ""}
          </span>
        )}
        <span className="spacer" />
        <button
          className="primary"
          disabled={!sel.size}
          onClick={async () => {
            await api.enqueueDownloads([...sel]);
            setSel(new Set());
          }}
        >
          Download selected{sel.size ? ` (${sel.size}${selBytes ? ` · ${fmtBytes(selBytes)}` : ""})` : ""}
        </button>
        <button onClick={() => api.enqueueDownloads(rows.filter((f) => f.downloadable && !f.downloaded).map((f) => f.id))}>Download all shown</button>
        <button onClick={() => api.cancelDownloads()}>Cancel queue</button>
      </div>
      <div className="toolbar">
        <span className="muted">Saving to</span>
        <code className="path" title={status?.downloadDir}>
          {status?.downloadDir}
        </code>
        <span className="spacer" />
        <select title="How downloaded files are named" value={status?.naming ?? "original"} onChange={(e) => api.setSettings({ naming: e.target.value as Naming })}>
          <option value="original">Humble's file names</option>
          <option value="title">Product - Publisher.ext</option>
        </select>
        <button onClick={() => api.openDownloadFolder()}>Open folder</button>
        <button onClick={() => api.chooseDownloadDir()}>Change…</button>
      </div>
      <div className="tableWrap">
        <table className={`grid ${table.tableClass}`} style={table.tableStyle}>
          <thead>
            <tr>{table.headers}</tr>
          </thead>
          <tbody>
            {table.rows.slice(0, ROW_LIMIT).map((f) => (
              <FileRow key={f.id} f={f} p={progress[f.id]} selected={sel.has(f.id)} onSelect={toggle} />
            ))}
          </tbody>
        </table>
        {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
      </div>
    </section>
  );
}

const selectableOf = (rows: FileEntry[]) => rows.filter((f) => f.downloadable);

// Memoised: a progress tick re-renders only the row whose file it's about.
const FileRow = memo(function FileRow({
  f,
  p,
  selected,
  onSelect,
}: {
  f: FileEntry;
  p: DownloadProgress | undefined;
  selected: boolean;
  onSelect: (id: string, on: boolean) => void;
}) {
  return (
    <tr className={p?.state === "downloading" ? "dl-active" : undefined}>
      <td className="chk">
        <input type="checkbox" checked={selected} disabled={!f.downloadable} onChange={(e) => onSelect(f.id, e.target.checked)} />
      </td>
      <td className="grow" title={`${f.product}\n${f.bundle}\n${f.filename}`}>
        {f.product}
        <span className="sub">
          {f.bundle} · {f.filename} · <HumbleLink of={f} />
        </span>
      </td>
      <td title={f.variants ? `Humble offers this same file ${f.variants} ways (${[...(f.platforms || [f.platform]), f.torrentUrl ? "torrent" : null].filter(Boolean).join(", ")}); shown once` : undefined}>
        {(f.platforms || [f.platform]).join(", ")}
        {f.torrentUrl && <span className="tag">+ torrent</span>}
      </td>
      <td title={f.format}>{f.format}</td>
      <td className="num">{f.humanSize || (f.size ? fmtBytes(f.size) : "-")}</td>
      <td className="status">
        <FileStatus f={f} p={p} />
      </td>
    </tr>
  );
});

function FileStatus({ f, p }: { f: FileEntry; p: DownloadProgress | undefined }) {
  if (p?.state === "downloading") return <DownloadingStatus p={p} />;
  if (p?.state === "queued")
    return (
      <span className="tag" title="Waiting for a free download slot (2 files download at a time)">
        queued
      </span>
    );
  if (p?.state === "error")
    return (
      <span className="keycell" title={`Download failed: ${p.error || "unknown error"}
Queue it again to retry (a partial file is resumed).`}>
        <span className="tag bad">failed</span>
        <span className="dl-note">{p.error || ""}</span>
      </span>
    );
  if (p?.state === "cancelled")
    return (
      <span className="keycell">
        <span className="tag warn">cancelled</span>
        <LinkTag f={f} />
      </span>
    );
  if (f.onDisk?.how === "older-version" && p?.state !== "done")
    return (
      <span className="keycell">
        <span className="tag warn" title={`You have an older version of this file (Humble has updated it since; its size differs):\n${f.onDisk.path}`}>
          older version on disk
        </span>
        <button className="small" onClick={() => api.showFile(f.id)}>
          Show
        </button>
      </span>
    );
  if (f.onDisk?.how === "size-differs" && p?.state !== "done")
    return (
      <span className="keycell">
        <span className="tag warn" title={`A file with this name is on disk, but its size differs and it isn't a complete archive (probably an unfinished download):\n${f.onDisk.path}`}>
          on disk, size differs
        </span>
        <button className="small" onClick={() => api.showFile(f.id)}>
          Show
        </button>
      </span>
    );
  if (f.downloaded || p?.state === "done")
    return (
      <span className="keycell">
        <span className="tag ok" title={f.onDisk ? f.onDisk.path : undefined}>
          {f.onDisk?.how === "extracted" ? "extracted" : f.onDisk ? "on disk" : "downloaded"}
        </span>
        <button className="small" onClick={() => api.showFile(f.id)}>
          Show
        </button>
      </span>
    );
  if (!f.downloadable) {
    const tag = (
      <span className="tag" title={f.notDownloadableReason || "Humble offers this only as an external link or in-browser"}>
        no direct file
      </span>
    );
    return f.contentUrl ? (
      <span className="keycell">
        {tag}
        <ExtLink href={f.contentUrl} title="Download it on Humble (opens on the right)">
          Open
        </ExtLink>
      </span>
    ) : (
      tag
    );
  }
  return (
    <span className="keycell">
      <LinkTag f={f} />
      {f.duplicateOf && (
        <span className="tag" title="Same file (by checksum) exists in an older bundle">
          duplicate
        </span>
      )}
    </span>
  );
}

// Whether a file has a working signed download link yet. The downloader treats
// a link expiring within 5 minutes as expired, and so does this.
type LinkState = "ready" | "expired" | "none";
const linkState = (f: FileEntry, now = Date.now()): LinkState =>
  !f.url ? "none" : f.urlExpiresAt && Date.parse(f.urlExpiresAt) < now + 5 * 60 * 1000 ? "expired" : "ready";

const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function LinkTag({ f }: { f: FileEntry }) {
  const st = linkState(f);
  if (st === "ready")
    return (
      <span className="tag ok" title={`Has a signed download link${f.urlExpiresAt ? `, valid until ${new Date(f.urlExpiresAt).toLocaleString()}` : ""}: downloading starts right away.`}>
        link ready{f.urlExpiresAt ? ` · until ${fmtWhen(f.urlExpiresAt)}` : ""}
      </span>
    );
  if (st === "expired")
    return (
      <span className="tag warn" title={`The signed link expired${f.urlExpiresAt ? ` (${new Date(f.urlExpiresAt).toLocaleString()})` : ""}. A fresh one is fetched from Humble when you download it.`}>
        link expired · refetched on download
      </span>
    );
  return (
    <span className="tag" title="Humble's file list names this file but has no download link for it yet. Humbler asks Humble for one when the download starts (a second or two per purchase).">
      no link yet · fetched on download
    </span>
  );
}

const PHASE_TEXT: Record<string, string> = {
  link: "Getting download link…",
  resuming: "Checking the partial file…",
  connecting: "Connecting…",
};

const fmtEta = (s: number): string => {
  if (!isFinite(s) || s <= 0) return "";
  if (s < 60) return `${Math.ceil(s)}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.ceil(s % 60)).padStart(2, "0")}s left`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m left`;
};

// A file being downloaded: spinner, what it's doing, %, bytes, speed, time
// left, and a bar (striped and moving until there's a size to measure against).
function DownloadingStatus({ p }: { p: DownloadProgress }) {
  const receiving = !p.phase || p.phase === "receiving";
  const got = p.received || 0;
  const pct = receiving && p.total ? Math.min(100, Math.floor((got / p.total) * 100)) : null;
  const head = receiving ? (pct !== null ? `${pct}%` : "Downloading…") : PHASE_TEXT[p.phase as string] || "Starting…";
  const detail = receiving
    ? [p.total ? `${fmtBytes(got) || "0 B"} of ${fmtBytes(p.total)}` : fmtBytes(got), p.speed ? `${fmtBytes(p.speed)}/s` : "", p.speed && p.total ? fmtEta((p.total - got) / p.speed) : ""]
        .filter(Boolean)
        .join(" · ")
    : p.phase === "resuming" && got
      ? `${fmtBytes(got)} already here`
      : "";
  return (
    <div className="dlprog" title={detail ? `${head}
${detail}` : head}>
      <div className="dlprog-head">
        <span className="spinner" aria-hidden="true" />
        <b>{head}</b>
        {detail && <span className="dlprog-detail">{detail}</span>}
      </div>
      <div className={`bar${pct === null ? " indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <i style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

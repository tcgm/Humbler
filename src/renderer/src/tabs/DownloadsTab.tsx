// Downloads: every file across every bundle, with filters and a queue.
import { memo, useMemo, useState } from "react";
import type { DownloadProgress, FileEntry, Naming } from "@shared/types";
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
        (!platform || f.platform === platform) &&
        (!format || f.format === format) &&
        !(hideDone && f.downloaded && !progress[f.id]) &&
        !(hideDupes && f.duplicateOf) &&
        (!needle || `${f.product} ${f.bundle} ${f.filename}`.toLowerCase().includes(needle)),
    );
  }, [lib.files, q, bundle, platform, format, hideDone, hideDupes, progress]);

  const fileBundles = useMemo(() => lib.bundles.filter((b) => b.fileCount), [lib.bundles]);
  const platforms = useMemo(() => uniqSorted(lib.files.map((f) => f.platform)), [lib.files]);
  const formats = useMemo(() => uniqSorted(lib.files.map((f) => f.format)), [lib.files]);
  const toGet = rows.reduce((s, f) => s + (f.downloaded ? 0 : f.size || 0), 0);
  const selectable = rows.filter((f) => f.downloadable);

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
        <span className="spacer" />
        <button
          className="primary"
          disabled={!sel.size}
          onClick={async () => {
            await api.enqueueDownloads([...sel]);
            setSel(new Set());
          }}
        >
          Download selected{sel.size ? ` (${sel.size})` : ""}
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
        <table className="grid">
          <thead>
            <tr>
              <th className="chk">
                <input
                  type="checkbox"
                  title="Select all shown"
                  checked={selectable.length > 0 && selectable.every((f) => sel.has(f.id))}
                  onChange={(e) => setSel((s) => (e.target.checked ? new Set([...s, ...selectable.map((f) => f.id)]) : new Set([...s].filter((id) => !selectable.some((f) => f.id === id)))))}
                />
              </th>
              <th>Title</th>
              <th>Platform</th>
              <th>Format</th>
              <th className="num">Size</th>
              <th className="statcol">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_LIMIT).map((f) => (
              <FileRow key={f.id} f={f} p={progress[f.id]} selected={sel.has(f.id)} onSelect={toggle} />
            ))}
          </tbody>
        </table>
        {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
      </div>
    </section>
  );
}

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
    <tr>
      <td className="chk">
        <input type="checkbox" checked={selected} disabled={!f.downloadable} onChange={(e) => onSelect(f.id, e.target.checked)} />
      </td>
      <td title={`${f.product}\n${f.bundle}\n${f.filename}`}>
        {f.product}
        <span className="sub">
          {f.bundle} · {f.filename} · <HumbleLink of={f} />
        </span>
      </td>
      <td>{f.platform}</td>
      <td title={f.format}>{f.format}</td>
      <td className="num">{f.humanSize || (f.size ? fmtBytes(f.size) : "—")}</td>
      <td className="status">
        <FileStatus f={f} p={p} />
      </td>
    </tr>
  );
});

function FileStatus({ f, p }: { f: FileEntry; p: DownloadProgress | undefined }) {
  if (p?.state === "downloading") {
    const pct = p.total ? Math.floor(((p.received || 0) / p.total) * 100) : 0;
    return (
      <div>
        <span className="tag">{p.total ? `${pct}% · ${fmtBytes(p.received)}` : fmtBytes(p.received)}</span>
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (p?.state === "queued") return <span className="tag">queued</span>;
  if (p?.state === "error")
    return (
      <span className="tag bad" title={p.error || ""}>
        failed
      </span>
    );
  if (p?.state === "cancelled") return <span className="tag warn">cancelled</span>;
  if (f.downloaded || p?.state === "done")
    return (
      <span className="keycell">
        <span className="tag ok">downloaded</span>
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
  if (f.duplicateOf)
    return (
      <span className="tag" title="Same file (by checksum) exists in an older bundle">
        duplicate
      </span>
    );
  return null;
}

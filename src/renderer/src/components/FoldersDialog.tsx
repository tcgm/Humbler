// ☰ > Download folders: where your Humble downloads are (scanned for what
// you already have) and where new ones go, plus which bundle each bundle
// folder belongs to (matched by name; link by hand when that fails).
import { useEffect, useMemo, useRef, useState } from "react";
import { LuFolderOpen, LuRotateCcw, LuStar, LuX } from "react-icons/lu";
import type { FoldersInfo } from "@shared/types";
import { api, useStore } from "../store";
import { formatDate } from "../util";
import { BundlePicker } from "./BundlePicker";

export function FoldersDialog({ onClose }: { onClose: () => void }) {
  const { lib, openBundle } = useStore();
  const [info, setInfo] = useState<FoldersInfo | null>(null);
  const [picking, setPicking] = useState<string | null>(null); // folder path being linked
  const [show, setShow] = useState<"unmatched" | "matched">("unmatched");
  const [q, setQ] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    const load = () => void api.getFolders().then((i) => live && setInfo(i));
    load();
    const off = api.onFoldersUpdated(load);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", esc);
    return () => {
      live = false;
      off();
      document.removeEventListener("keydown", esc);
    };
  }, []);

  const nameOf = useMemo(() => new Map(lib.bundles.map((b) => [b.gamekey, b.name])), [lib.bundles]);
  const dirs = (info?.bundleDirs || []).filter((d) => (show === "unmatched" ? !d.gamekeys.length : d.gamekeys.length) && (!q || d.name.toLowerCase().includes(q.toLowerCase())));
  const unmatched = (info?.bundleDirs || []).filter((d) => !d.gamekeys.length).length;
  const roots = info ? [info.downloadDir, ...info.folders] : [];

  return (
    <div className="ask-backdrop hb" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ask folders" role="dialog" aria-modal="true" aria-labelledby="foldersTitle">
        <div className="folders-head">
          <h3 id="foldersTitle">Download folders</h3>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <LuX aria-hidden />
          </button>
        </div>
        <p className="muted-line">
          Humbler looks through these folders for bundles and files you already have (by name; nothing is opened or moved). New downloads go into a bundle&apos;s existing
          folder when it has one, otherwise into the default folder.
        </p>

        <ul className="folder-list">
          {roots.map((r) => {
            const isDefault = r === info?.downloadDir;
            const missing = info?.scan?.missing.includes(r);
            return (
              <li key={r} className={missing ? "missing" : ""}>
                <span className="folder-path" title={r}>
                  {isDefault && <LuStar className="star" aria-label="default" />} {r}
                  {missing && <em> (not found)</em>}
                </span>
                <span className="folder-actions">
                  {isDefault ? (
                    <span className="tag">default</span>
                  ) : (
                    <button className="small" title="New downloads go here" onClick={() => api.setDefaultFolder(r)}>
                      Make default
                    </button>
                  )}
                  <button className="icon-btn" title="Open" aria-label="Open folder" onClick={() => api.openFolder(r)}>
                    <LuFolderOpen aria-hidden />
                  </button>
                  {!isDefault && (
                    <button className="icon-btn" title="Stop scanning this folder" aria-label="Remove" onClick={() => api.removeFolder(r)}>
                      <LuX aria-hidden />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="ask-actions folders-actions">
          <button onClick={() => api.addFolder()}>Add folder…</button>
          <button disabled={info?.scanning} onClick={() => api.rescanFolders()} title="Look through the folders again">
            <LuRotateCcw aria-hidden /> {info?.scanning ? "Scanning…" : "Rescan"}
          </button>
          <span className="muted-line">
            {info?.scan
              ? `Last scan ${formatDate(info.scan.at)}: ${info.scan.files.toLocaleString()} files, ${info.scan.dirs.toLocaleString()} folders, ${(info.scan.ms / 1000).toFixed(1)}s`
              : info?.scanning
                ? "Scanning…"
                : "Not scanned yet"}
          </span>
        </div>

        <h4>
          Bundle folders ({info?.bundleDirs.length ?? 0}) ·{" "}
          <a className={show === "unmatched" ? "active" : ""} onClick={() => setShow("unmatched")}>
            {unmatched} not matched
          </a>{" "}
          ·{" "}
          <a className={show === "matched" ? "active" : ""} onClick={() => setShow("matched")}>
            {(info?.bundleDirs.length ?? 0) - unmatched} matched
          </a>
          <input className="hb-search" type="search" placeholder="Filter folders" value={q} onChange={(e) => setQ(e.target.value)} />
        </h4>
        <div className="folder-dirs">
          {dirs.map((d) => (
            <div className="folder-dir" key={d.path}>
              <div className="folder-info">
                <a className="folder-name" title={`Open ${d.path}`} onClick={() => api.openFolder(d.path)}>
                  {d.name}
                </a>
                <span className="folder-sub" title={d.path}>
                  {d.files.toLocaleString()} file{d.files === 1 ? "" : "s"}
                  {d.folders ? `, ${d.folders.toLocaleString()} folder${d.folders === 1 ? "" : "s"}` : ""} · in {d.root}
                  {d.gamekeys.length > 0 && <> · {d.gamekeys.map((g) => nameOf.get(g) || g).filter((n, i, a) => a.indexOf(n) === i).join(", ")}</>}
                </span>
              </div>
              <button
                className={`folder-pick${d.gamekeys.length ? " matched" : ""}`}
                title={d.gamekeys.length ? `Matched to:\n${d.gamekeys.map((g) => nameOf.get(g)).join("\n")}\n\nClick to change` : "Choose which bundle this folder holds"}
                onClick={() => setPicking(d.path)}
              >
                {d.gamekeys.length
                  ? [...new Set(d.gamekeys.map((g) => nameOf.get(g) || g))].join(", ")
                  : d.linked
                    ? "Not a bundle"
                    : "Choose the bundle…"}
              </button>
              {d.linked && <span className="tag">linked</span>}
            </div>
          ))}
          {!dirs.length && <p className="muted-line">{show === "unmatched" ? "Every bundle folder is matched." : "No matched folders."}</p>}
        </div>
        {picking && info?.bundleDirs.find((d) => d.path === picking) && (
          <BundlePicker
            dir={info.bundleDirs.find((d) => d.path === picking)!}
            onClose={() => setPicking(null)}
            onOpenBundle={(gk) => {
              setPicking(null);
              closeRef.current();
              openBundle(gk);
            }}
          />
        )}
      </div>
    </div>
  );
}

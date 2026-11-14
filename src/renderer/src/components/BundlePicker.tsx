// "Which bundle is this folder?" A proper chooser: the folder's contents,
// suggested bundles (by name, and by how many of their files are in the
// folder), every bundle searchable with icon/date/counts, and a preview of
// the selected one (its items and which of its files are here), with links
// to its page in Humbler and on Humble.
import { useEffect, useMemo, useState } from "react";
import { LuFile, LuFolder, LuFolderOpen, LuX } from "react-icons/lu";
import type { Bundle, FolderInspect, FoldersInfo } from "@shared/types";
import { api, useStore } from "../store";
import { bundleUrl, formatDate, formatMoney, plural } from "../util";
import { BundleIcon, ExtLink, useOrderInfo } from "./ui";

type Dir = FoldersInfo["bundleDirs"][number];

export function BundlePicker({ dir, onClose, onOpenBundle }: { dir: Dir; onClose: () => void; onOpenBundle: (gamekey: string) => void }) {
  const { lib } = useStore();
  const [info, setInfo] = useState<FolderInspect | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(dir.gamekeys[0] || null);

  useEffect(() => {
    let live = true;
    void api.inspectFolder(dir.path).then((i) => {
      if (!live) return;
      setInfo(i);
      setSel((s) => s || i.suggestions[0]?.gamekey || null);
    });
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", esc, true);
    return () => {
      live = false;
      document.removeEventListener("keydown", esc, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir.path]);

  const byKey = useMemo(() => new Map(lib.bundles.map((b) => [b.gamekey, b])), [lib.bundles]);
  const suggested = (info?.suggestions || []).map((s) => ({ ...s, b: byKey.get(s.gamekey) })).filter((s): s is typeof s & { b: Bundle } => !!s.b);
  const all = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...lib.bundles].filter((b) => !needle || b.name.toLowerCase().includes(needle)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [lib.bundles, q]);
  const selected = sel ? byKey.get(sel) || null : null;
  const link = (gamekey: string | null | undefined) => void api.linkFolder(dir.path, gamekey).then(onClose);

  return (
    <div className="ask-backdrop hb picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ask picker" role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
        <div className="folders-head">
          <h3 id="pickerTitle">
            Which bundle is <q>{dir.name}</q>?
          </h3>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <LuX aria-hidden />
          </button>
        </div>
        <p className="muted-line picker-path">
          <a className="ext" title="Open this folder" onClick={() => api.openFolder(dir.path)}>
            <LuFolderOpen aria-hidden /> {dir.path}
          </a>{" "}
          · {plural(dir.files, "file")}
          {dir.folders ? `, ${plural(dir.folders, "folder")}` : ""}
        </p>

        <div className="picker-body">
          {/* left: the folder's contents, suggestions, all bundles */}
          <div className="picker-col">
            <details className="picker-contents" open={!!info && info.total <= 12}>
              <summary>What&apos;s in it ({info ? info.total : "…"})</summary>
              <ul>
                {info?.entries.map((e) => (
                  <li key={e.name} title={e.name}>
                    {e.dir ? <LuFolder aria-hidden /> : <LuFile aria-hidden />} {e.name}
                  </li>
                ))}
                {info && info.total > info.entries.length && <li className="muted-line">…and {info.total - info.entries.length} more</li>}
              </ul>
            </details>

            {suggested.length > 0 && (
              <>
                <h4>Suggested</h4>
                <div className="picker-list">
                  {suggested.map((s) => (
                    <PickRow
                      key={s.gamekey}
                      b={s.b}
                      active={sel === s.gamekey}
                      onPick={() => setSel(s.gamekey)}
                      why={[s.fileHits ? `${plural(s.fileHits, "file")} here` : null, s.nameScore >= 0.3 ? `name ${Math.round(s.nameScore * 100)}%` : null].filter(Boolean).join(" · ")}
                    />
                  ))}
                </div>
              </>
            )}

            <h4>
              All bundles
              <input className="hb-search" type="search" placeholder="Search bundles" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
            </h4>
            <div className="picker-list all">
              {all.map((b) => (
                <PickRow key={b.gamekey} b={b} active={sel === b.gamekey} onPick={() => setSel(b.gamekey)} />
              ))}
              {!all.length && <p className="muted-line">No bundles match.</p>}
            </div>
          </div>

          {/* right: the selected bundle */}
          <div className="picker-col preview">
            {selected ? (
              <Preview b={selected} names={info?.names} dirPath={dir.path} onOpenBundle={onOpenBundle} />
            ) : (
              <p className="muted-line">Pick a bundle on the left to see what&apos;s in it.</p>
            )}
          </div>
        </div>

        <div className="ask-actions picker-actions">
          <button title="This folder isn't a Humble bundle: stop matching it" onClick={() => link(null)}>
            Not a bundle
          </button>
          {dir.linked && (
            <button title="Forget your choice and match this folder by name again" onClick={() => link(undefined)}>
              Match automatically
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!selected} onClick={() => link(sel)}>
            {selected ? `Link to “${selected.name.length > 40 ? `${selected.name.slice(0, 40)}…` : selected.name}”` : "Link"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PickRow({ b, active, onPick, why }: { b: Bundle; active: boolean; onPick: () => void; why?: string }) {
  const info = useOrderInfo(b);
  return (
    <button className={`pick-row${active ? " active" : ""}`} onClick={onPick} title={b.name}>
      <BundleIcon b={b} size="xs" />
      <span className="pick-main">
        <span className="pick-name">{b.name}</span>
        <span className="pick-sub">
          {[info?.createdAt ? formatDate(info.createdAt) : null, b.fileCount ? plural(b.fileCount, "file") : null, b.keyCount ? plural(b.keyCount, "key") : null, why]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {!!b.diskDirs?.length && (
        <span className="tag" title={b.diskDirs.join("\n")}>
          has a folder
        </span>
      )}
    </button>
  );
}

function Preview({ b, names, dirPath, onOpenBundle }: { b: Bundle; names?: string[]; dirPath: string; onOpenBundle: (gamekey: string) => void }) {
  const { lib } = useStore();
  const info = useOrderInfo(b);
  const here = useMemo(() => new Set(names || []), [names]);
  const products = lib.products.filter((p) => p.gamekey === b.gamekey);
  const files = lib.files.filter((f) => f.gamekey === b.gamekey);
  const isHere = (filename: string) => {
    const l = filename.toLowerCase();
    return here.has(l) || here.has(l.replace(/\.[^.]+$/, ""));
  };
  const filesHere = files.filter((f) => isHere(f.filename)).length;
  const otherDirs = (b.diskDirs || []).filter((d) => d !== dirPath);
  return (
    <>
      <div className="preview-head">
        <BundleIcon b={b} size="md" />
        <div>
          <h4>{b.name}</h4>
          <p className="muted-line">
            {[info?.createdAt ? `Bought ${formatDate(info.createdAt)}` : null, info?.total ? formatMoney(info.total) : null, plural(b.itemCount ?? products.length, "item")]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="preview-links">
            <a className="ext" onClick={() => onOpenBundle(b.gamekey)}>
              Open bundle page
            </a>
            <ExtLink href={bundleUrl(b)} title="Open this purchase on Humble (right)">
              Open on Humble
            </ExtLink>
          </p>
        </div>
      </div>
      {files.length > 0 && (
        <p className={filesHere ? "on-disk" : "muted-line"}>
          {filesHere ? `${filesHere} of ${plural(files.length, "file")} found in this folder` : `None of its ${plural(files.length, "file")} are in this folder (by name)`}
        </p>
      )}
      {!files.length && (
        <p className="muted-line">
          {b.keyCount && !products.some((p) => p.platforms.length)
            ? "No downloads in this bundle (keys only)."
            : "Humbler has no file list for this bundle yet: Sync reads it from the purchase page."}
        </p>
      )}
      {otherDirs.length > 0 && <p className="muted-line">Already has: {otherDirs.join(", ")}</p>}
      <ul className="preview-items">
        {products.slice(0, 200).map((p) => {
          const pf = files.filter((f) => f.itemId ? f.itemId === p.id : f.product === p.title);
          const pHere = pf.filter((f) => isHere(f.filename)).length;
          return (
            <li key={p.id}>
              <span className="pick-name">{p.title}</span>
              <span className="pick-sub">
                {[pf.length ? `${pHere}/${pf.length} files here` : null, p.keyCount ? plural(p.keyCount, "key") : null].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
        {products.length > 200 && <li className="muted-line">…and {products.length - 200} more</li>}
      </ul>
    </>
  );
}

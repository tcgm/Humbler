// One download button per file, like the old /downloads page: format + size,
// and its state (queued / % / downloaded, click to show / failed / no link).
import type { FileEntry } from "@shared/types";
import { api, useStore } from "../store";
import { fmtBytes, PLATFORM_LABELS } from "../util";

export function FileButton({ f, showPlatform = false }: { f: FileEntry; showPlatform?: boolean }) {
  const prog = useStore().progress[f.id];
  const label = `${showPlatform ? `${PLATFORM_LABELS[f.platform] || f.platform} · ` : ""}${f.format || "Download"}${
    f.humanSize || f.size ? ` · ${f.humanSize || fmtBytes(f.size)}` : ""
  }`;
  let stateText = "";
  let cls = "file-btn";
  if (f.downloaded || prog?.state === "done") {
    stateText = "✓ Downloaded";
    cls += " done";
  } else if (prog?.state === "downloading") {
    const receiving = !prog.phase || prog.phase === "receiving";
    stateText = !receiving
      ? prog.phase === "link"
        ? "getting link…"
        : prog.phase === "resuming"
          ? "resuming…"
          : "connecting…"
      : prog.total
        ? `${Math.floor(((prog.received || 0) / prog.total) * 100)}%${prog.speed ? ` · ${fmtBytes(prog.speed)}/s` : ""}`
        : "downloading…";
    cls += " busy";
  } else if (prog?.state === "queued") {
    stateText = "queued";
  } else if (prog?.state === "error") {
    stateText = "failed";
    cls += " failed";
  } else if (!f.downloadable) {
    stateText = "no link";
    cls += " nolink";
  }
  return (
    <button
      className={cls}
      disabled={!f.downloadable && !f.downloaded}
      title={[f.filename, f.md5 ? `MD5 ${f.md5}` : "", f.notDownloadableReason || "", prog?.error || ""].filter(Boolean).join("\n")}
      onClick={() => {
        if (f.downloaded || prog?.state === "done") void api.showFile(f.id);
        else if (f.downloadable) void api.enqueueDownloads([f.id]);
      }}
    >
      <span>{label}</span>
      {stateText && (
        <small>
          {prog?.state === "downloading" && <span className="spinner" aria-hidden="true" />} {stateText}
        </small>
      )}
      {prog?.state === "downloading" && (
        <span className={`bar${prog.total && (!prog.phase || prog.phase === "receiving") ? "" : " indeterminate"}`}>
          <i style={prog.total && (!prog.phase || prog.phase === "receiving") ? { width: `${Math.floor(((prog.received || 0) / prog.total) * 100)}%` } : undefined} />
        </span>
      )}
    </button>
  );
}

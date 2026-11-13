// Scout & Log: live scouting toggle, manual page scout, and the log.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, useStore } from "../store";

export function ScoutTab() {
  const { status, logs } = useStore();
  const [reload, setReload] = useState(true);
  const [scouting, setScouting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Follow the log while you're at the bottom; stay put if you scrolled up.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => (atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="panel">
      <div className="toolbar">
        <label className="check" title="Record every JSON response Humble's pages receive, as you browse, into a scrubbed endpoint catalog">
          <input type="checkbox" checked={!!status?.liveScout} onChange={(e) => api.setSettings({ liveScout: e.target.checked })} /> Live scouting
        </label>
        <span className="muted">{status?.live ? `${status.live.endpoints} endpoints · ${status.live.samples} response shapes` : ""}</span>
        <span className="spacer" />
        <button onClick={() => api.openLiveCatalog()}>Open live catalog</button>
      </div>
      <div className="toolbar">
        <button
          className="primary"
          disabled={scouting}
          title="Dump every response the Humble page has received, plus embedded page data, to data/recon/"
          onClick={async () => {
            setScouting(true);
            setNote(null);
            try {
              const res = await api.scoutPage(reload);
              if (!res?.ok) setNote(`Scout did not run (${res?.reason || "unknown"}).`);
            } finally {
              setScouting(false);
            }
          }}
        >
          {scouting ? "Scouting…" : "Scout this page"}
        </button>
        <label className="check">
          <input type="checkbox" checked={reload} onChange={(e) => setReload(e.target.checked)} /> Reload first
        </label>
        {note && <span className="muted">{note}</span>}
        <span className="spacer" />
        <button onClick={() => api.openReconFolder()}>Open recon folder</button>
      </div>
      <p className="muted hint">
        Live scouting runs all the time. Every endpoint Humble's pages call is catalogued as you browse, and the log flags new endpoints and changed response formats. Scout
        this page adds a full snapshot (HTML, every request) of one page. Keys, tokens and gamekeys are scrubbed from everything written.
      </p>
      <div className="log" ref={logRef}>
        {logs.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </section>
  );
}

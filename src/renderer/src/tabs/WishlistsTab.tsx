// Wishlists: Steam wishlists (yours or friends') next to what you own on
// Humble. Which spare keys does a friend want? Which games on your own
// wishlist do you already have, unredeemed, somewhere in a bundle?
import { useMemo, useState } from "react";
import type { KeyEntry, WishlistProfile } from "@shared/types";
import { ExportButton } from "../components/ExportDialog";
import { SteamMark } from "../components/Marks";
import { byNumber, byText, useTable, type Col } from "../components/Table";
import { ArmButton, ExtLink, HumbleLink, PlatformBadge, ResetButton } from "../components/ui";
import { usePref, useRemembered } from "../remember";
import { api, useStore } from "../store";
import { formatDate, plural } from "../util";
import { isSpare, keyUse, wishRows, type OwnedMatch, type WishRow } from "../wishlist";

const ROW_LIMIT = 1500;
type Show = "spare" | "owned" | "all";

const SHOW_LABELS: Record<Show, string> = {
  spare: "Keys you could give or redeem",
  owned: "Anything in your library",
  all: "The whole wishlist",
};

function sinceText(iso: string | null): string {
  if (!iso) return "not fetched yet";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "fetched just now";
  if (mins < 60) return `fetched ${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `fetched ${h} h ago` : `fetched ${formatDate(iso)}`;
}

export function WishlistsTab() {
  const { lib, wishlists, ownIndex, openBundle, steamIdx } = useStore();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // shared, so a key's "Wanted by" link can open this tab on that person and game
  const [who, setWho] = usePref("wishlists.who", ""); // a steamId, or "" = everyone
  const [q, setQ] = usePref("wishlists.q", "");
  const [show, setShow] = useRemembered<Show>("wishlists.show", "spare");
  const dirty = q !== "" || show !== "spare";
  const resetAll = () => {
    setQ("");
    setShow("spare");
  };

  const selected = wishlists.find((p) => p.steamId === who) || null;
  const profiles = useMemo(() => (selected ? [selected] : wishlists), [selected, wishlists]);
  const allRows = useMemo(() => wishRows(profiles, ownIndex), [profiles, ownIndex]);
  const counts = useMemo(
    () => ({ spare: allRows.filter((r) => r.spare.length).length, owned: allRows.filter((r) => r.matches.length).length, all: allRows.length }),
    [allRows],
  );
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allRows
      .filter((r) => (show === "spare" ? r.spare.length > 0 : show === "owned" ? r.matches.length > 0 : true))
      .filter((r) => !needle || `${r.name} ${r.matches.map((m) => (m.key ? `${m.key.name} ${m.key.bundle}` : `${m.product!.title} ${m.product!.bundle}`)).join(" ")}`.toLowerCase().includes(needle))
      .sort((a, b) => b.wantedBy.length - a.wantedBy.length || Math.min(...a.wantedBy.map((w) => w.game.rank)) - Math.min(...b.wantedBy.map((w) => w.game.rank)));
  }, [allRows, q, show]);

  const cols: Col<WishRow>[] = [
    { id: "icon", className: "wl-capcol", fixed: true, label: null },
    { id: "game", label: "Game", grow: 3, sort: byText((r) => r.name) },
    ...(selected
      ? [{ id: "rank", label: "Rank", className: "num", title: "Sort by their order on the wishlist", sort: byNumber((r: WishRow) => r.wantedBy[0]?.game.rank) }]
      : [{ id: "who", label: "Wanted by", grow: 1, title: "Sort by how many people want it", sort: byNumber((r: WishRow) => -r.wantedBy.length) }]),
    { id: "have", label: "You have", grow: 2, title: "Sort by how many spare keys you have", sort: (a, b) => b.spare.length - a.spare.length || b.matches.length - a.matches.length },
    { id: "act", className: "actcol", fixed: true, label: null },
  ];
  const table = useTable(selected ? "wishlists.one" : "wishlists.all", cols, rows);
  const shownKeys = useMemo(() => [...new Set(rows.flatMap((r) => r.spare))], [rows]);

  const add = async () => {
    if (!input.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const r = await api.addWishlist(input);
      if (r.steamId) {
        setInput("");
        setWho(r.steamId);
      }
      if (!r.ok) setAddError(r.reason || "Couldn't add that profile.");
    } finally {
      setAdding(false);
    }
  };

  const anyRefreshing = wishlists.some((p) => p.refreshing);
  const totalGames = new Set(wishlists.flatMap((p) => p.games.map((g) => g.appid))).size;

  return (
    <section className="panel">
      <div className="filters">
        <input
          className="wl-add"
          placeholder="Steam profile or wishlist link, SteamID, friend code or custom URL name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button className="primary" disabled={!input.trim() || adding} onClick={() => void add()} title="Add this Steam profile and fetch its wishlist (it must be public)">
          {adding ? "Adding…" : "Add wishlist"}
        </button>
        {addError && <span className="tag bad wl-error">{addError}</span>}
      </div>

      {wishlists.length > 0 && (
        <div className="wl-people">
          <button className={`wl-person${!selected ? " active" : ""}`} onClick={() => setWho("")} title="Every wishlist together">
            <span className="wl-everyone">★</span>
            <span>
              Everyone
              <small>{plural(totalGames, "game")}</small>
            </span>
          </button>
          {wishlists.map((p) => (
            <Person key={p.steamId} p={p} active={selected?.steamId === p.steamId} onPick={() => setWho(p.steamId)} />
          ))}
        </div>
      )}

      {selected && (
        <div className="toolbar">
          <span className={selected.error ? "tag warn" : "muted"}>{selected.error || `${plural(selected.games.length, "game")} on ${selected.name}'s wishlist · ${sinceText(selected.fetchedAt)}`}</span>
          <ExtLink href={selected.wishlistUrl}>Wishlist on Steam</ExtLink>
          <ExtLink href={selected.profileUrl}>Profile</ExtLink>
          <span className="spacer" />
          <button disabled={selected.refreshing} onClick={() => void api.refreshWishlists(selected.steamId)}>
            {selected.refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <ArmButton className="danger" armedText="Remove?" title="Stop comparing this wishlist (you can add it again)" onFire={() => {
            setWho("");
            return api.removeWishlist(selected.steamId);
          }}>
            Remove
          </ArmButton>
        </div>
      )}

      {wishlists.length === 0 ? (
        <div className="wl-empty">
          <h3>Compare Steam wishlists with your library</h3>
          <p>
            Add your own Steam profile to see games you've wishlisted that you already have a key for, or a friend's to see which of your spare keys they'd want.
          </p>
          <p className="muted">
            Paste a profile link (<code>steamcommunity.com/id/…</code> or <code>/profiles/…</code>), a wishlist link, a SteamID64, a friend code or a custom URL name. The wishlist must be
            public: on Steam, Edit Profile → Privacy Settings → Game details: Public. Humbler asks Steam directly; nothing is sent to Humble.
          </p>
        </div>
      ) : (
        <>
          <div className="filters">
            <input type="search" placeholder="Search game, key or bundle…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
              {(Object.keys(SHOW_LABELS) as Show[]).map((s) => (
                <option key={s} value={s}>
                  {SHOW_LABELS[s]} ({counts[s]})
                </option>
              ))}
            </select>
            <ResetButton dirty={dirty} onReset={resetAll} />
          </div>
          <div className="toolbar">
            <span className="muted">
              {plural(rows.length, "game")}
              {shownKeys.length ? ` · ${plural(shownKeys.length, "spare key")}` : ""}
              {lib.keys.length === 0 ? " · your library is empty: Sync first" : ""}
            </span>
            <span className="spacer" />
            {!selected && (
              <button disabled={anyRefreshing} onClick={() => void api.refreshWishlists(null)} title="Fetch every wishlist again">
                {anyRefreshing ? "Refreshing…" : "Refresh all"}
              </button>
            )}
            <ExportButton className="" scope={`spare keys on ${selected ? `${selected.name}'s wishlist` : "these wishlists"}${q || show !== "spare" ? " (matching the filters)" : ""}`} keys={shownKeys} />
          </div>
          <div className="tableWrap">
            <table className={`grid ${table.tableClass}`} style={table.tableStyle}>
              <thead>
                <tr>{table.headers}</tr>
              </thead>
              <tbody>
                {table.rows.slice(0, ROW_LIMIT).map((r) => (
                  <tr key={r.appid}>
                    <td className="wl-capcol">{r.capsule ? <img className="wl-cap" src={r.capsule} loading="lazy" alt="" /> : <div className="wl-cap" />}</td>
                    <td className="grow" title={r.name}>
                      {r.name}
                      <span className="sub">
                        {r.unlisted
                          ? "No store page on Steam any more: can't be matched by title"
                          : selected
                            ? r.wantedBy[0]?.game.added
                              ? `added ${formatDate(r.wantedBy[0].game.added)}`
                              : ""
                            : r.wantedBy.length > 1
                              ? `on ${r.wantedBy.length} wishlists`
                              : ""}
                      </span>
                    </td>
                    {selected ? (
                      <td className="num">#{r.wantedBy[0]?.game.rank}</td>
                    ) : (
                      <td className="grow" title={r.wantedBy.map((w) => `${w.profile.name} (#${w.game.rank})`).join("\n")}>
                        {r.wantedBy.map((w) => w.profile.name).join(", ")}
                      </td>
                    )}
                    <td className="grow wl-have">
                      <div className="tags">
                        {steamIdx.byAppid.has(r.appid) && <SteamMark on={{ app: steamIdx.byAppid.get(r.appid)!, how: "appid" }} />}
                        {r.matches.length ? r.matches.slice(0, 6).map((m, i) => <MatchTag key={i} m={m} onOpen={openBundle} />) : !steamIdx.byAppid.has(r.appid) && <span className="tag">-</span>}
                        {r.matches.length > 6 && <span className="tag">+{r.matches.length - 6}</span>}
                      </div>
                    </td>
                    <td className="actcol">
                      <ExtLink href={`https://store.steampowered.com/app/${r.appid}`}>Steam</ExtLink>
                      {r.matches[0] && <HumbleLink of={r.matches[0].key || r.matches[0].product} label="Humble" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div className="more">{show === "spare" ? "No spare keys for anything on this wishlist. Try \"Anything in your library\"." : "Nothing to show."}</div>}
            {rows.length > ROW_LIMIT && <div className="more">Showing {ROW_LIMIT} of {rows.length}. Narrow the filters to see the rest.</div>}
          </div>
        </>
      )}
    </section>
  );
}

function Person({ p, active, onPick }: { p: WishlistProfile; active: boolean; onPick: () => void }) {
  const { ownIndex } = useStore();
  const spare = useMemo(() => wishRows([p], ownIndex).filter((r) => r.spare.length).length, [p, ownIndex]);
  return (
    <button className={`wl-person${active ? " active" : ""}`} onClick={onPick} title={p.error || `${p.name}: ${plural(p.games.length, "game")} wishlisted, ${spare} you have a spare key for · ${sinceText(p.fetchedAt)}`}>
      {p.avatar ? <img src={p.avatar} alt="" /> : <span className="wl-everyone">?</span>}
      <span>
        {p.name}
        <small>
          {p.refreshing ? "refreshing…" : p.error && !p.games.length ? "private or empty" : `${p.games.length} · ${spare} to give`}
        </small>
      </span>
    </button>
  );
}

const USE_TEXT: Record<ReturnType<typeof keyUse>, string> = {
  "spare-unrevealed": "unrevealed",
  "spare-revealed": "revealed, not redeemed",
  redeemed: "redeemed",
  gone: "",
};

function goneText(k: KeyEntry): string {
  if (k.gift || k.giftState === "gifted" || k.giftState === "claimed") return "gifted";
  if (k.soldOut) return "sold out";
  if (k.expired) return "expired";
  return "unavailable";
}

function MatchTag({ m, onOpen }: { m: OwnedMatch; onOpen: (gamekey: string) => void }) {
  const how = m.how === "likely" ? "~ " : "";
  const howText = m.how === "likely" ? "Likely the same game (the titles differ only by edition words)" : m.how === "appid" ? "Same Steam app" : "Same title";
  if (m.key) {
    const k = m.key;
    const use = keyUse(k);
    const text = use === "gone" ? goneText(k) : USE_TEXT[use];
    const giftNote = use === "spare-unrevealed" && k.notGiftable ? " · not giftable" : "";
    return (
      <button
        className={`tag wl-tag ${isSpare(k) ? (giftNote ? "warn" : "ok") : ""}`}
        onClick={() => onOpen(k.gamekey)}
        title={`${k.name}\n${k.bundle}\n${howText}${k.notGiftable ? "\nHumble says this key can't be gifted" : ""}\nClick to open the bundle`}
      >
        <PlatformBadge k={k} /> {how}
        {text}
        {giftNote}
      </button>
    );
  }
  const p = m.product!;
  return (
    <button className="tag wl-tag" onClick={() => onOpen(p.gamekey)} title={`${p.title}\n${p.bundle}\n${howText}\nClick to open the bundle`}>
      {how}
      {p.fileCount ? "DRM-free download" : "in your library"}
    </button>
  );
}

// On Sale: the bundles Humble is selling right now, laid out like Humble's
// own /bundles page (Games / Books / Software, a grid of bundle tiles), next
// to what you have. Every item is marked: green when it's already yours
// (Humble library or Steam account), ♥ when it's on a Steam wishlist, "new
// to you" otherwise; each bundle and tier says how much of it is new to you.
// Every bundle counts down to its exact end; watch one (☆) to be notified as
// it nears it, and add a bundle's games to your Steam wishlist.
import { useMemo, useState } from "react";
import { Countdown, exactEnd } from "../components/Countdown";
import { SteamMark } from "../components/Marks";
import { BackLink, ExtLink, ResetButton } from "../components/ui";
import { useRemembered, useRememberedScroll } from "../remember";
import { api, useStore } from "../store";
import { bundleInfo, type BundleInfo, type ItemInfo, type TierInfo } from "../onsale";
import { formatDate, formatMoney, plural, steamUrl } from "../util";
import { exactTitle, looseTitle } from "@shared/titles";
import { keyUse } from "../wishlist";

type Cat = "all" | "games" | "books" | "software" | "watching";
const CATS: { c: Cat; label: string }[] = [
  { c: "all", label: "All" },
  { c: "games", label: "Games" },
  { c: "books", label: "Books" },
  { c: "software", label: "Software" },
  { c: "watching", label: "★ Watching" },
];
type Show = "all" | "fresh" | "wanted" | "mine" | "owned";
const SHOWS: { s: Show; label: string; test: (b: BundleInfo) => boolean }[] = [
  { s: "all", label: "All bundles", test: () => true },
  { s: "fresh", label: "With something new to you", test: (b) => b.fresh > 0 },
  { s: "wanted", label: "With something on a wishlist", test: (b) => b.wanted > 0 },
  { s: "mine", label: "With something on your wishlist", test: (b) => b.wantedByMe > 0 },
  { s: "owned", label: "With something you already have", test: (b) => b.owned > 0 },
];
type Sort = "fresh" | "freshpct" | "ending" | "newest" | "az";

const endsSoon = (iso: string | null) => (Date.parse(iso || "") || Infinity) - Date.now() < 3 * 86400_000;
const money = (amount: number | null, currency: string | null) => (amount == null ? "" : formatMoney({ amount, currency }));

/** Is this title one of your starred games? (exact, or but for edition words) */
function useStarred(): (title: string) => string | null {
  const { storeInfo } = useStore();
  return useMemo(() => {
    const exact = new Map<string, string>();
    const loose = new Map<string, string>();
    for (const g of storeInfo?.watchedGames || []) {
      exact.set(exactTitle(g.title), g.title);
      const l = looseTitle(g.title);
      if (l) loose.set(l, g.title);
    }
    return (title: string) => exact.get(exactTitle(title)) ?? (looseTitle(title) ? loose.get(looseTitle(title)) : undefined) ?? null;
  }, [storeInfo?.watchedGames]);
}

/** Every bundle on sale, matched against what you have. */
function useSale(): BundleInfo[] {
  const { storeInfo, ownIndex, steamIdx, wishIdx, steam } = useStore();
  const me = steam?.steamId ?? null;
  return useMemo(() => (storeInfo?.bundles || []).map((b) => bundleInfo(b, ownIndex, steamIdx, wishIdx, me)), [storeInfo?.bundles, ownIndex, steamIdx, wishIdx, me]);
}

export function OnSaleTab() {
  const { saleId } = useStore();
  const all = useSale();
  const b = saleId ? all.find((x) => x.bundle.id === saleId) : undefined;
  return saleId ? <SalePage b={b} /> : <SaleGrid all={all} />;
}

function Chips({ b, short }: { b: BundleInfo; short?: boolean }) {
  const partial = !b.items;
  const starred = useStarred();
  const stars = (b.items ? b.items.map((i) => i.item.title) : b.bundle.preview).filter((t) => starred(t)).length;
  return (
    <span className="marks">
      {stars > 0 && (
        <span className="mark starred" title="Games you starred">
          ★ {stars}
          {short ? "" : " starred"}
        </span>
      )}
      {b.fresh > 0 && (
        <span className="mark fresh" title={partial ? "Counting the first titles only: the bundle's page hasn't been read yet" : "Not in your Humble library or on your Steam account"}>
          {partial ? "≥" : ""}
          {b.fresh} new{short ? "" : " to you"}
        </span>
      )}
      {b.owned > 0 && (
        <span className="mark owned" title="Already yours: in your Humble library or on your Steam account">
          ✓ {b.owned} yours
        </span>
      )}
      {b.wantedByMe > 0 && <span className="mark wanted">♥ {b.wantedByMe} on your wishlist</span>}
      {b.wanted > b.wantedByMe && (
        <span className="mark wanted soft" title="On someone's Steam wishlist">
          ♥ {b.wanted}
          {short ? "" : " wishlisted"}
        </span>
      )}
    </span>
  );
}

function SaleGrid({ all }: { all: BundleInfo[] }) {
  const { storeInfo, steam, openSale } = useStore();
  const starred = useStarred();
  // watched bundles, and bundles with a starred game
  const watched = useMemo(() => new Set(storeInfo?.watched || []), [storeInfo?.watched]);
  const watching = useMemo(
    () => new Set(all.filter((b) => watched.has(b.bundle.id) || (b.items ? b.items.map((i) => i.item.title) : b.bundle.preview).some((t) => starred(t))).map((b) => b.bundle.id)),
    [all, watched, starred],
  );
  const [q, setQ] = useRemembered("onsale.q", "");
  const [cat, setCat] = useRemembered<Cat>("onsale.cat", "games");
  const [show, setShow] = useRemembered<Show>("onsale.show", "all");
  const [sort, setSort] = useRemembered<Sort>("onsale.sort", "fresh");
  const scrollRef = useRememberedScroll<HTMLDivElement>("onsale");
  const dirty = q !== "" || show !== "all" || sort !== "fresh";
  const me = steam?.steamId ?? null;

  const inCat = useMemo(() => all.filter((b) => cat === "all" || (cat === "watching" ? watching.has(b.bundle.id) : b.bundle.category === cat)), [all, cat, watching]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const test = SHOWS.find((x) => x.s === show)?.test ?? (() => true);
    const ends = (b: BundleInfo) => Date.parse(b.bundle.endDate || "") || Infinity;
    const by: Record<Sort, (a: BundleInfo, b: BundleInfo) => number> = {
      fresh: (a, b) => b.wantedByMe - a.wantedByMe || b.fresh - a.fresh || ends(a) - ends(b),
      freshpct: (a, b) => b.fresh / (b.total || 1) - a.fresh / (a.total || 1) || b.fresh - a.fresh,
      ending: (a, b) => ends(a) - ends(b),
      newest: (a, b) => (Date.parse(b.bundle.startDate || "") || 0) - (Date.parse(a.bundle.startDate || "") || 0),
      az: (a, b) => a.bundle.title.localeCompare(b.bundle.title),
    };
    return inCat
      .filter(test)
      .filter((b) => !needle || `${b.bundle.title} ${(b.items || []).map((i) => i.item.title).join(" ")} ${b.bundle.preview.join(" ")}`.toLowerCase().includes(needle))
      .sort(by[sort]);
  }, [inCat, q, show, sort]);

  const prog = storeInfo?.refreshing;
  const count = (c: Cat) => (c === "all" ? all.length : c === "watching" ? watching.size : all.filter((b) => b.bundle.category === c).length);

  return (
    <div className="hb-page">
      <div className="hb-head">
        <h2>Bundles</h2>
        <div className="hb-controls">
          <input className="hb-search" type="search" placeholder="Search bundles or games" value={q} onChange={(e) => setQ(e.target.value)} />
          <select title="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
            {SHOWS.filter((x) => x.s !== "mine" || me || show === "mine").map(({ s, label, test }) => (
              <option key={s} value={s}>
                {label} ({inCat.filter(test).length})
              </option>
            ))}
          </select>
          <select title="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="fresh">Most new to you</option>
            <option value="freshpct">Most new to you (share)</option>
            <option value="ending">Ending soonest</option>
            <option value="newest">Newest</option>
            <option value="az">A - Z</option>
          </select>
          <ResetButton
            dirty={dirty}
            onReset={() => {
              setQ("");
              setShow("all");
              setSort("fresh");
            }}
          />
          <button className="hb-btn ghost" disabled={!!prog} onClick={() => void api.refreshStore(false)} title="Fetch Humble's bundle list again, and bundles not read in the last day">
            {prog ? `Reading ${prog.done}/${prog.total}…` : "Refresh"}
          </button>
        </div>
      </div>
      <nav className="sale-tabs">
        {CATS.map(({ c, label }) => (
          <button key={c} className={cat === c ? "active" : ""} onClick={() => setCat(c)}>
            {label} <span>{count(c)}</span>
          </button>
        ))}
      </nav>
      <p className="hb-summary">
        {plural(rows.length, "bundle")}
        {storeInfo?.fetchedAt ? ` · from humblebundle.com, ${formatDate(storeInfo.fetchedAt)}` : ""}
        {!steam?.apps.length ? " · sign in on My Steam to count games on your Steam account too" : ""}
        {storeInfo?.error ? ` · ${storeInfo.error}` : ""}
        <span className="marks sale-legend">
          <span className="mark owned">✓ yours</span>
          <span className="mark wanted">♥ wishlisted</span>
          <span className="mark fresh">new to you</span>
        </span>
      </p>
      {prog && prog.total > 0 && (
        <div className="bar">
          <i style={{ width: `${(prog.done / prog.total) * 100}%` }} />
        </div>
      )}
      <div className="hb-scroll" ref={scrollRef}>
        {cat === "watching" && <StarredGames all={all} />}
        {!storeInfo?.bundles.length ? (
          <div className="hb-empty">
            <p>Every bundle Humble is selling now, with what you already have marked: in your Humble library, on your Steam account (My Steam), or on a Steam wishlist.</p>
            {prog ? (
              <p>Fetching the bundle list…</p>
            ) : (
              <button className="hb-btn" onClick={() => void api.refreshStore(false)}>
                Fetch Humble&apos;s bundles
              </button>
            )}
          </div>
        ) : rows.length ? (
          <div className="sale-grid">
            {rows.map((b) => (
              <SaleTile key={b.bundle.id} b={b} watching={watched.has(b.bundle.id)} onOpen={() => openSale(b.bundle.id)} />
            ))}
          </div>
        ) : (
          <div className="hb-empty">{cat === "watching" ? "No watched bundles on sale. Click ☆ on a bundle to be notified as it nears its end, or on a game inside one to be notified when it's in a bundle." : "No bundles match."}</div>
        )}
      </div>
    </div>
  );
}

/** A ☆/★ toggle (a span: it sits inside tile buttons). */
function Star({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={on}
      className={`star${on ? " on" : ""}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      {on ? "★" : "☆"}
    </span>
  );
}

function WatchStar({ id, on }: { id: string; on: boolean }) {
  return (
    <Star
      on={on}
      title={on ? "Watching this bundle: notified 24 h, 3 h, 1 h and 10 min before it ends, and when it adds items. Click to stop." : "Watch this bundle: be notified as it nears its end, and when it adds items"}
      onToggle={() => void api.watchBundle(id, !on)}
    />
  );
}

function GameStar({ title, on }: { title: string; on: boolean }) {
  return (
    <Star
      on={on}
      title={on ? "Starred: you're notified when this game is in a bundle on sale. Click to unstar." : "Star this game: be notified when it's in a bundle on sale (this one doesn't count)"}
      onToggle={() => void api.watchGame(title, !on)}
    />
  );
}

/** Watching tab: your starred games, and the bundles on sale with each. */
function StarredGames({ all }: { all: BundleInfo[] }) {
  const { storeInfo, openSale } = useStore();
  const games = storeInfo?.watchedGames || [];
  if (!games.length) return null;
  const inBundles = (title: string) => {
    const e = exactTitle(title);
    const l = looseTitle(title);
    return all.flatMap((b) => {
      const it = b.items?.find((i) => exactTitle(i.item.title) === e || (!!l && looseTitle(i.item.title) === l));
      if (it) return [{ b, tier: it.item.tier }];
      return !b.items && b.bundle.preview.some((t) => exactTitle(t) === e || (!!l && looseTitle(t) === l)) ? [{ b, tier: null as number | null }] : [];
    });
  };
  return (
    <section className="hb-section starred-games">
      <h3>★ Starred games</h3>
      <div className="hb-panel">
        {games.map((g) => {
          const found = inBundles(g.title);
          return (
            <div key={g.title} className="starred-row">
              <GameStar title={g.title} on />
              <span className="starred-title">{g.title}</span>
              <span className="starred-where">
                {found.length ? (
                  found.map(({ b, tier }) => (
                    <a key={b.bundle.id} onClick={() => openSale(b.bundle.id)} title="Open this bundle">
                      {b.bundle.title}
                      {tier != null && b.bundle.tiers.length > 1 ? ` (tier ${tier + 1}${b.bundle.tiers[tier]?.price != null ? `, ${money(b.bundle.tiers[tier].price, b.bundle.tiers[tier].currency)}` : ""})` : ""}
                    </a>
                  ))
                ) : (
                  <span className="hb-note">Not in a bundle on sale now: you&apos;ll be notified when it is</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SaleTile({ b, watching, onOpen }: { b: BundleInfo; watching: boolean; onOpen: () => void }) {
  const bd = b.bundle;
  const pct = b.total ? Math.round((b.owned / b.total) * 100) : 0;
  return (
    <button className={`sale-tile${pct === 100 ? " all-owned" : ""}`} onClick={onOpen} title={bd.title}>
      <div className="sale-art">
        {bd.image ? <img src={bd.image} loading="lazy" alt="" /> : null}
        {bd.endDate && <Countdown end={bd.endDate} className={`sale-ends${endsSoon(bd.endDate) ? " soon" : ""}`} />}
      </div>
      <div className="sale-body">
        <h4>{bd.title}</h4>
        <p className="sale-line">
          <span>{[bd.price ? `From ${formatMoney(bd.price)}` : "", plural(b.total, "item")].filter(Boolean).join(" · ")}</span>
          <WatchStar id={bd.id} on={watching} />
        </p>
        <Chips b={b} short />
        <div className="bar" title={`${pct}% already yours`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    </button>
  );
}

function SalePage({ b }: { b: BundleInfo | undefined }) {
  const { openSale, storeInfo } = useStore();
  if (!b) {
    return (
      <div className="hb-page">
        <BackLink onClick={() => openSale(null)}>All bundles</BackLink>
        <div className="hb-empty">This bundle isn&apos;t on sale any more.</div>
      </div>
    );
  }
  const bd = b.bundle;
  const pct = b.total ? Math.round((b.owned / b.total) * 100) : 0;
  return (
    <div className="hb-page">
      <BackLink onClick={() => openSale(null)}>All bundles</BackLink>
      <div className="hb-bundle-head sale-head">
        {bd.image ? <img className="sale-head-art" src={bd.image} alt="" /> : null}
        <div className="hb-bundle-head-main">
          <h2>{bd.title}</h2>
          <p className="hb-summary">
            {[bd.category[0].toUpperCase() + bd.category.slice(1), plural(b.total, "item"), bd.price ? `from ${formatMoney(bd.price)}` : "", `${pct}% already yours`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {bd.endDate && (
            <p className="sale-endline">
              Ends {exactEnd(bd.endDate)} · <Countdown end={bd.endDate} className={`sale-left${endsSoon(bd.endDate) ? " soon" : ""}`} />
            </p>
          )}
          <Chips b={b} />
          <div className="hb-links">
            <WatchToggle id={bd.id} on={!!storeInfo?.watched.includes(bd.id)} />
            <ExtLink href={bd.url} title="Open this bundle on Humble (right)">
              Open on Humble
            </ExtLink>
            {bd.keyExpiration && <span className="hb-note">Keys must be redeemed by {formatDate(bd.keyExpiration)}</span>}
          </div>
        </div>
      </div>
      <div className="hb-scroll">
        {b.items ? (
          b.tiers.map((t) => <Tier key={t.index} t={t} count={b.tiers.length} />)
        ) : (
          <section className="hb-section">
            <p className="hb-note">{bd.error ? `Couldn't read this bundle's page (${bd.error}). These are its first titles; Refresh tries again.` : "This bundle's page hasn't been read yet; these are its first titles."}</p>
            <div className="sale-items">
              {bd.preview.map((title) => (
                <div key={title} className="sale-item">
                  <div className="sale-item-body">
                    <h4>{title}</h4>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Tier({ t, count }: { t: TierInfo; count: number }) {
  if (!t.items.length) return null;
  const fresh = t.items.filter((i) => !i.owned).length;
  return (
    <section className="hb-section">
      <div className="hb-section-head">
        <h3>
          {count > 1 ? `Tier ${t.index + 1}` : "In this bundle"}
          {t.price != null ? ` · ${money(t.price, t.currency)}` : ""}
        </h3>
        <span className="hb-summary">
          {plural(t.items.length, "item")}, {fresh} new to you
          {count > 1 && t.index > 0 ? ` · with the tiers below: ${plural(t.upto.items, "item")}, ${t.upto.fresh} new to you` : ""}
        </span>
      </div>
      <div className="sale-items">
        {t.items.map((i) => (
          <Item key={i.item.id} i={i} />
        ))}
      </div>
    </section>
  );
}

function WatchToggle({ id, on }: { id: string; on: boolean }) {
  return (
    <button className={`hb-btn small${on ? "" : " ghost"}`} onClick={() => void api.watchBundle(id, !on)} title={on ? "Stop watching" : "Be notified 24 h, 3 h, 1 h and 10 min before it ends, and when it adds items"}>
      {on ? "★ Watching" : "☆ Watch"}
    </button>
  );
}

/** ♡ Add a game to your Steam wishlist (signed in on My Steam). */
function WishButton({ title }: { title: string }) {
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string }>({});
  if (state.done) return <span className="mark wanted">♥ added to your wishlist</span>;
  return (
    <a
      className={`wish-add${state.error ? " failed" : ""}`}
      title={state.error || "Add this game to your Steam wishlist (found on Steam by its title)"}
      onClick={async () => {
        if (state.busy) return;
        setState({ busy: true });
        const r = await api.addToSteamWishlist(title);
        setState(r.ok ? { done: r.name } : { error: r.reason || "Couldn't add it" });
      }}
    >
      {state.busy ? "Adding…" : state.error ? "♡ Couldn't add: retry" : "♡ Add to Steam wishlist"}
    </a>
  );
}

function Item({ i }: { i: ItemInfo }) {
  const { openBundle, openWishlist, steam } = useStore();
  const it = i.item;
  const canWish = !!steam?.signedIn && it.delivery.includes("steam") && !i.owned && !i.wanted.some((w) => w.mine);
  const starred = useStarred();
  const first = i.humble[0];
  const use = first?.key ? keyUse(first.key) : null;
  const humbleText = first ? `${first.key ? (use === "redeemed" ? "Redeemed key" : use?.startsWith("spare") ? "Spare key" : "Key") : "In your library"}: ${(first.key || first.product)!.bundle}` : "";
  return (
    <div className={`sale-item${i.owned ? " owned" : i.wanted.length ? " wanted" : ""}`}>
      {it.image ? <img className="sale-item-art" src={it.image} loading="lazy" alt="" /> : <div className="sale-item-art" />}
      <div className="sale-item-body">
        <div className="sale-item-title">
          <h4 title={it.title}>{it.title}</h4>
          <GameStar title={it.title} on={!!starred(it.title)} />
        </div>
        <div className="marks">
          {i.steam && <SteamMark on={i.steam} />}
          {first && (
            <a
              className="mark owned"
              title={`${humbleText}${first.how === "likely" ? "\nLikely the same (the titles differ only by edition words)" : ""}${i.humble.length > 1 ? `\n(${i.humble.length} matches in your library)` : ""}\nClick to open that bundle`}
              onClick={() => openBundle((first.key || first.product)!.gamekey)}
            >
              ✓ {first.how === "likely" ? "~" : ""}
              {first.key ? (use === "redeemed" ? "redeemed key" : use?.startsWith("spare") ? "spare key" : "key") : "in your library"}
            </a>
          )}
          {i.wanted.map((w) => (
            <a
              key={w.profile.steamId}
              className="mark wanted"
              title={`#${w.game.rank} on ${w.mine ? "your" : `${w.profile.name}'s`} Steam wishlist${w.how === "likely" ? " (likely the same game)" : ""}\nClick to see it there`}
              onClick={() => openWishlist(w.profile.steamId, it.title)}
            >
              ♥ {w.how === "likely" ? "~" : ""}
              {w.mine ? "your wishlist" : w.profile.name} #{w.game.rank}
            </a>
          ))}
          {!i.owned && <span className="mark fresh">new to you</span>}
          {it.outOfKeys && <span className="mark bad">out of keys</span>}
        </div>
        {canWish && <WishButton title={it.title} />}
        <div className="sale-item-foot">
          {it.delivery.includes("steam") ? <ExtLink href={steamUrl(it.title)}>Steam</ExtLink> : it.delivery[0] ? <span>{it.delivery[0].replace(/_/g, " ")}</span> : null}
          {it.msrp != null && <span>{formatMoney({ amount: it.msrp, currency: "USD" })}</span>}
          {it.steamRating != null && <span title="Steam review score">{it.steamRating}% on Steam</span>}
        </div>
      </div>
    </div>
  );
}

// Humble Choice, rebuilt (Humble no longer serves these pages): an index of
// every month, and a month page modelled on the old /membership/<month> grid.
import { useMemo } from "react";
import type { Bundle, ChoiceMonth, FileEntry, KeyEntry, LibraryIndex, Product } from "@shared/types";
import { ExportButton } from "../components/ExportDialog";
import { FileButton } from "../components/FileButton";
import { KeyField } from "../components/KeyField";
import { KeyCheck, RevealSelected, selectedOr, useKeySelection } from "../components/KeySelect";
import { BackLink, DeadlineBadge, ExtLink, HumbleLink, ResetButton, Tile } from "../components/ui";
import { useRemembered, useRememberedScroll } from "../remember";
import { useStore } from "../store";
import { deadlineOf, monthLabel, normTitle, plural, SITE, type Deadline } from "../util";

type Sort = "recent" | "oldest" | "unrevealed" | "deadline";
type Filter = "all" | "unrevealed" | "deadline" | "soldout" | "expired" | "missing" | "files" | "empty";

interface Month {
  month: string;
  bundles: Bundle[];
  harvested: ChoiceMonth | null;
  group: boolean;
}

interface Game {
  title: string;
  image: string | null;
  keys: KeyEntry[];
  files: FileEntry[];
  inLibrary: boolean;
  product?: Product; // the library item (absent for games not in your library)
}

/** Every Choice month: library bundles "<Month> Humble Choice", Humble's
 *  empty month groups, and harvested months from the library page. */
function useMonths(): Month[] {
  const { lib, choiceMonths } = useStore();
  return useMemo(() => {
    const months = new Map<string, Month>();
    const get = (m: string) => {
      if (!months.has(m)) months.set(m, { month: m, bundles: [], harvested: null, group: false });
      return months.get(m)!;
    };
    for (const b of lib.bundles) if (b.choiceMonth) get(b.choiceMonth).bundles.push(b);
    for (const g of lib.choiceGroups || []) get(g.month).group = true;
    for (const h of choiceMonths) get(h.month).harvested = h;
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  }, [lib, choiceMonths]);
}

/** A month's games: library items with their keys/files, plus harvested
 *  current-month games not in your library yet. */
function useGames(m: Month | undefined): Game[] {
  const { lib } = useStore();
  return useMemo(() => gamesOf(m, lib), [m, lib]);
}

function gamesOf(m: Month | undefined, lib: LibraryIndex): Game[] {
  if (!m) return [];
  {
    const ids = new Set(m.bundles.map((b) => b.gamekey));
    const images = new Map(Object.values(m.harvested?.games || {}).map((g) => [normTitle(g.title), g.image]));
    const games: Game[] = lib.products
      .filter((p) => ids.has(p.gamekey))
      .map((p) => ({
        title: p.title,
        image: images.get(normTitle(p.title)) || null,
        // by item id (new-site data), else by title (legacy order data)
        keys: lib.keys.filter((k) => (k.itemId ? k.itemId === p.id : k.gamekey === p.gamekey && normTitle(k.name) === normTitle(p.title))),
        files: lib.files.filter((f) => (f.itemId ? f.itemId === p.id : f.gamekey === p.gamekey && f.product === p.title)),
        inLibrary: true,
        product: p,
      }));
    const have = new Set(games.map((g) => normTitle(g.title)));
    for (const g of Object.values(m.harvested?.games || {})) {
      if (!have.has(normTitle(g.title))) games.push({ title: g.title, image: g.image, keys: [], files: [], inLibrary: false });
    }
    return games;
  }
}

/** What the index shows (and searches, filters, sorts by) for one month. */
interface MonthSummary {
  m: Month;
  games: Game[];
  unrevealed: number;
  soldOut: number;
  expired: number;
  notInLib: number;
  files: number;
  dl: Deadline | null;
  haystack: string; // month name + game titles, lowercased
}

function summarize(m: Month, lib: LibraryIndex): MonthSummary {
  const games = gamesOf(m, lib);
  const keys = games.flatMap((g) => g.keys);
  return {
    m,
    games,
    unrevealed: keys.filter((k) => k.status === "unused").length,
    soldOut: keys.filter((k) => k.status === "sold-out").length,
    expired: keys.filter((k) => k.status === "expired").length,
    notInLib: games.filter((g) => !g.inLibrary).length,
    files: games.reduce((n, g) => n + g.files.length, 0),
    dl: deadlineOf(keys),
    haystack: `${monthLabel(m.month)} ${m.month} ${games.map((g) => g.title).join(" ")}`.toLowerCase(),
  };
}

export function ChoiceTab() {
  const { choiceMonth } = useStore();
  const months = useMonths();
  const m = months.find((x) => x.month === choiceMonth);
  return m ? <MonthPage m={m} /> : <MonthIndex months={months} />;
}

function MonthIndex({ months }: { months: Month[] }) {
  const { lib } = useStore();
  const [q, setQ] = useRemembered("choice.q", "");
  const [sort, setSort] = useRemembered<Sort>("choice.sort", "recent");
  const [filter, setFilter] = useRemembered<Filter>("choice.filter", "all");
  const scrollRef = useRememberedScroll<HTMLDivElement>("choice");
  const dirty = q !== "" || sort !== "recent" || filter !== "all";
  const resetAll = () => {
    setQ("");
    setSort("recent");
    setFilter("all");
  };
  const all = useMemo(() => months.map((m) => summarize(m, lib)), [months, lib]);
  const needle = q.trim().toLowerCase();

  const list = useMemo(() => {
    let out = all.filter((x) => {
      if (needle && !x.haystack.includes(needle)) return false;
      if (filter === "unrevealed" && !x.unrevealed) return false;
      if (filter === "deadline" && !x.dl) return false;
      if (filter === "soldout" && !x.soldOut) return false;
      if (filter === "expired" && !x.expired) return false;
      if (filter === "missing" && !x.notInLib) return false;
      if (filter === "files" && !x.files) return false;
      if (filter === "empty" && x.games.length) return false;
      return true;
    });
    const recent = (a: MonthSummary, b: MonthSummary) => b.m.month.localeCompare(a.m.month);
    if (sort === "oldest") out = [...out].sort((a, b) => -recent(a, b));
    else if (sort === "unrevealed") out = [...out].sort((a, b) => b.unrevealed - a.unrevealed || recent(a, b));
    else if (sort === "deadline") out = [...out].sort((a, b) => (a.dl?.t ?? Infinity) - (b.dl?.t ?? Infinity) || recent(a, b));
    else out = [...out].sort(recent);
    return out;
  }, [all, needle, sort, filter]);

  // games that matched the search, shown on the card (unless the month name matched)
  const matchesOf = (x: MonthSummary) =>
    needle && !monthLabel(x.m.month).toLowerCase().includes(needle) ? x.games.filter((g) => g.title.toLowerCase().includes(needle)).map((g) => g.title) : [];

  return (
    <div className="hb-page">
      <div className="hb-head">
        <h2>Humble Choice</h2>
        <div className="hb-controls">
          <input className="hb-search" type="search" placeholder="Search months or games" value={q} onChange={(e) => setQ(e.target.value)} />
          <select title="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="recent">Most recent</option>
            <option value="oldest">Oldest first</option>
            <option value="unrevealed">Most unrevealed keys</option>
            <option value="deadline">Deadline soonest</option>
          </select>
          <select title="Show" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">All months</option>
            <option value="unrevealed">With unrevealed keys</option>
            <option value="deadline">With a redeem deadline</option>
            <option value="soldout">With sold-out keys</option>
            <option value="expired">With expired keys</option>
            <option value="missing">With games not in your library</option>
            <option value="files">With downloads</option>
            <option value="empty">No games in your library</option>
          </select>
          <ResetButton dirty={dirty} onReset={resetAll} />
          <ExportButton scope={needle || filter !== "all" ? `the ${plural(list.length, "Choice month")} matching your filters` : "every Choice month"} keys={list.flatMap((x) => x.games.flatMap((g) => g.keys))} />
        </div>
      </div>
      <p className="hb-summary">
        {plural(list.length, "month")}
        {needle || filter !== "all" ? ` of ${all.length}` : ""} · Humble no longer serves its Choice pages. These are rebuilt from your library (each month&apos;s games, keys
        and downloads) and from the current month as listed on your library page.
      </p>
      <div className="hb-scroll" ref={scrollRef}>
        {list.length ? (
          <div className="hb-cards months">
            {list.map((x) => (
              <MonthCard key={x.m.month} s={x} matches={matchesOf(x)} />
            ))}
          </div>
        ) : (
          <div className="hb-empty">{all.length ? "No months match." : "No Choice months yet. Sync your library, or open it on the right."}</div>
        )}
      </div>
    </div>
  );
}

function MonthCard({ s, matches }: { s: MonthSummary; matches: string[] }) {
  const { openChoiceMonth } = useStore();
  const { m, games, unrevealed, soldOut, expired, notInLib, dl } = s;
  return (
    <button className="hb-card month-card" onClick={() => openChoiceMonth(m.month)}>
      <div className="hb-card-body">
        <h4>{monthLabel(m.month)}</h4>
        <p>{games.length ? plural(games.length, "game") : m.group ? "No games from this month in your library" : "No games yet"}</p>
        {matches.length > 0 && <p className="month-matches">{matches.join(" · ")}</p>}
        {(unrevealed > 0 || notInLib > 0 || soldOut > 0 || expired > 0) && (
          <div className="hb-flags">
            {unrevealed > 0 && <span className="hb-flag">{unrevealed} unrevealed</span>}
            {soldOut > 0 && <span className="hb-flag red">⚠ {soldOut} sold out</span>}
            {expired > 0 && <span className="hb-flag muted" title="Expired before they were revealed">{expired} expired</span>}
            {notInLib > 0 && <span className="hb-flag amber">{notInLib} not in library</span>}
          </div>
        )}
      </div>
      {games.length > 0 && (
        <div className="month-strip">
          {games.slice(0, 4).map((g, i) => (
            <Tile key={`${i}|${g.title}`} title={g.title} size="xs" image={g.image} />
          ))}
        </div>
      )}
      {dl && <DeadlineBadge dl={dl} />}
    </button>
  );
}

function MonthPage({ m }: { m: Month }) {
  const { openChoiceMonth, openBundle } = useStore();
  const games = useGames(m);
  const keys = games.flatMap((g) => g.keys);
  const sel = useKeySelection();
  return (
    <div className="hb-page">
      <BackLink onClick={() => openChoiceMonth(null)}>All Choice months</BackLink>
      <div className="hb-head">
        <h2>{monthLabel(m.month)} Humble Choice</h2>
        <div className="hb-links">
          {m.bundles.map((b) => (
            <a key={b.gamekey} className="ext" title={b.name} onClick={() => openBundle(b.gamekey)}>
              Bundle page
            </a>
          ))}
          <ExtLink href={`${SITE}/home/library`}>Open your library on Humble</ExtLink>
        </div>
        <div className="hb-controls">
          <RevealSelected keys={keys} sel={sel} />
          <ExportButton {...selectedOr(keys, sel[0], `${monthLabel(m.month)} Humble Choice`)} />
        </div>
      </div>
      <p className="hb-summary">{games.length ? plural(games.length, "game") : "No games from this month in your library."}</p>
      <div className="hb-scroll">
        <div className="choice-grid">
          {games.map((g, i) => (
            <div key={`${i}|${g.title}`} className={`choice-card${g.inLibrary ? "" : " missing"}`}>
              {g.image ? <img className="choice-art" src={g.image} alt="" loading="lazy" /> : <Tile title={g.title} size="art" />}
              <div className="choice-body">
                <h4>{g.title}</h4>
                {g.product && (
                  <div className="row-links">
                    <HumbleLink of={g.product} />
                  </div>
                )}
                {g.keys.map((k) => (
                  <div className="choice-key selectable" key={k.id}>
                    <KeyCheck k={k} sel={sel} />
                    <KeyField k={k} />
                  </div>
                ))}
                {g.files.length > 0 && (
                  <div className="choice-files">
                    {g.files.map((f) => (
                      <FileButton key={f.id} f={f} />
                    ))}
                  </div>
                )}
                {!g.inLibrary ? (
                  <div className="choice-missing">
                    Not in your library yet. <ExtLink href={`${SITE}/home/library`}>Claim it in your library</ExtLink>
                  </div>
                ) : (
                  !g.keys.length && !g.files.length && <p className="muted-line">No key or download listed</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

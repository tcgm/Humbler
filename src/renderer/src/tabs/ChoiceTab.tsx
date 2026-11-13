// Humble Choice, rebuilt (Humble no longer serves these pages): an index of
// every month, and a month page modelled on the old /membership/<month> grid.
import { useMemo } from "react";
import type { Bundle, ChoiceMonth, FileEntry, KeyEntry } from "@shared/types";
import { FileButton } from "../components/FileButton";
import { KeyField } from "../components/KeyField";
import { BackLink, DeadlineBadge, ExtLink, Tile } from "../components/ui";
import { useStore } from "../store";
import { deadlineOf, monthLabel, normTitle, plural, SITE } from "../util";

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
  return useMemo(() => {
    if (!m) return [];
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
      }));
    const have = new Set(games.map((g) => normTitle(g.title)));
    for (const g of Object.values(m.harvested?.games || {})) {
      if (!have.has(normTitle(g.title))) games.push({ title: g.title, image: g.image, keys: [], files: [], inLibrary: false });
    }
    return games;
  }, [m, lib]);
}

export function ChoiceTab() {
  const { choiceMonth } = useStore();
  const months = useMonths();
  const m = months.find((x) => x.month === choiceMonth);
  return m ? <MonthPage m={m} /> : <MonthIndex months={months} />;
}

function MonthIndex({ months }: { months: Month[] }) {
  return (
    <div className="hb-page hb-scroll">
      <div className="hb-head">
        <h2>Humble Choice</h2>
      </div>
      <p className="hb-summary">
        Humble no longer serves its Choice pages. These are rebuilt from your library (each month's games, keys and downloads) and from the current month as listed on your library
        page.
      </p>
      {months.length ? (
        <div className="hb-cards months">
          {months.map((m) => (
            <MonthCard key={m.month} m={m} />
          ))}
        </div>
      ) : (
        <div className="hb-empty">No Choice months yet. Sync your library, or open it on the right.</div>
      )}
    </div>
  );
}

function MonthCard({ m }: { m: Month }) {
  const { openChoiceMonth } = useStore();
  const games = useGames(m);
  const unrevealed = games.reduce((n, g) => n + g.keys.filter((k) => k.status === "unused").length, 0);
  const notInLib = games.filter((g) => !g.inLibrary).length;
  const dl = deadlineOf(games.flatMap((g) => g.keys));
  return (
    <button className="hb-card month-card" onClick={() => openChoiceMonth(m.month)}>
      <div className="hb-card-body">
        <h4>{monthLabel(m.month)}</h4>
        <p>{games.length ? plural(games.length, "game") : m.group ? "No games from this month in your library" : "No games yet"}</p>
        {(unrevealed > 0 || notInLib > 0) && (
          <div className="hb-flags">
            {unrevealed > 0 && <span className="hb-flag">{unrevealed} unrevealed</span>}
            {notInLib > 0 && <span className="hb-flag amber">{notInLib} not in library</span>}
          </div>
        )}
      </div>
      {games.length > 0 && (
        <div className="month-strip">
          {games.slice(0, 4).map((g) => (
            <Tile key={g.title} title={g.title} size="xs" image={g.image} />
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
  return (
    <div className="hb-page hb-scroll">
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
      </div>
      <p className="hb-summary">{games.length ? plural(games.length, "game") : "No games from this month in your library."}</p>
      <div className="choice-grid">
        {games.map((g) => (
          <div key={g.title} className={`choice-card${g.inLibrary ? "" : " missing"}`}>
            {g.image ? <img className="choice-art" src={g.image} alt="" loading="lazy" /> : <Tile title={g.title} size="art" />}
            <div className="choice-body">
              <h4>{g.title}</h4>
              {g.keys.map((k) => (
                <div className="choice-key" key={k.id}>
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
  );
}

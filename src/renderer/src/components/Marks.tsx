// The same marks everywhere a game shows up (Library, Choice, Wishlists, On
// Sale...): ✓ when it's on your Steam account (My Steam), ♥ for whoever has
// it on their Steam wishlist (click to see it there). Green and pink, as on
// the On Sale tab.
import { useMemo } from "react";
import type { KeyEntry } from "@shared/types";
import { wishesFor, type Wish } from "../onsale";
import { onAccountByTitle, type OnAccount } from "../steam";
import { useStore } from "../store";

export interface TitleMarks {
  steam: OnAccount | null;
  wanted: Wish[];
}

/** Is this title on your Steam account, and on whose wishlists? */
export function useTitleMarks(title: string, appid?: string | number | null): TitleMarks {
  const { steamIdx, wishIdx, steam } = useStore();
  const me = steam?.steamId ?? null;
  return useMemo(() => {
    const id = Number(appid);
    const byId = id && steamIdx.byAppid.get(id);
    return {
      steam: byId ? { app: byId, how: "appid" } : onAccountByTitle(title, steamIdx),
      wanted: wishesFor(title, wishIdx, me, appid),
    };
  }, [title, appid, steamIdx, wishIdx, me]);
}

/**
 * Chips for one game. `noSteam` leaves out the Steam mark, `noWish` the
 * wishlist ones. With `keys` (the game's keys, each showing a KeyField),
 * whatever their key lines already say is left out: "On your Steam account",
 * and "Wanted by" on spare keys.
 */
export function Marks({
  title,
  appid,
  keys,
  noSteam,
  noWish,
  max = 3,
}: {
  title: string;
  appid?: string | number | null;
  keys?: KeyEntry[];
  noSteam?: boolean;
  noWish?: boolean;
  max?: number;
}) {
  const { openWishlist, steamByKey, wanted: wantedKeys } = useStore();
  const m = useTitleMarks(title, appid);
  if (keys?.some((k) => steamByKey.get(k.id)?.on)) noSteam = true;
  if (keys?.some((k) => wantedKeys.get(k.id)?.length)) noWish = true;
  const wanted = noWish ? [] : m.wanted;
  if ((noSteam || !m.steam) && !wanted.length) return null;
  return (
    <span className="marks">
      {!noSteam && m.steam && <SteamMark on={m.steam} />}
      {wanted.slice(0, max).map((w) => (
        <a
          key={w.profile.steamId}
          className="mark wanted"
          title={`#${w.game.rank} on ${w.mine ? "your" : `${w.profile.name}'s`} Steam wishlist${w.how === "likely" ? " (likely the same game: the titles differ only by edition words)" : ""}\nClick to see it there`}
          onClick={(e) => {
            e.stopPropagation();
            openWishlist(w.profile.steamId, title);
          }}
        >
          ♥ {w.how === "likely" ? "~" : ""}
          {w.mine ? "your wishlist" : w.profile.name} #{w.game.rank}
        </a>
      ))}
      {wanted.length > max && (
        <span className="mark wanted soft" title={wanted.slice(max).map((w) => `${w.profile.name} #${w.game.rank}`).join("\n")}>
          ♥ +{wanted.length - max}
        </span>
      )}
    </span>
  );
}

export function SteamMark({ on, text = "on your Steam account" }: { on: OnAccount; text?: string }) {
  return (
    <span className="mark owned" title={`On your Steam account as ${on.app.name}${on.how === "likely" ? "\nLikely the same game (the titles differ only by edition words)" : ""}`}>
      ✓ {on.how === "likely" ? "~" : ""}
      {text}
    </span>
  );
}

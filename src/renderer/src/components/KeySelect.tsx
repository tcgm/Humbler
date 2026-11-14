// Selecting keys and revealing them in bulk, wherever keys are listed (the
// Keys tab, a bundle page, a Choice month). Revealing claims a key to your
// account (it can't be gifted afterwards), so it always takes two clicks.
import { useState, type Dispatch, type SetStateAction } from "react";
import type { KeyEntry } from "@shared/types";
import { useStore } from "../store";
import { ArmButton } from "./ui";

/** can be revealed now: unrevealed, and not before Humble's release date for it */
export const canReveal = (k: KeyEntry) => k.status === "unused" && !(k.availableFrom && Date.parse(k.availableFrom) > Date.now());

export type Selection = [Set<string>, Dispatch<SetStateAction<Set<string>>>];

export function useKeySelection(): Selection {
  return useState<Set<string>>(() => new Set());
}

/** The checkbox on a key's row. */
export function KeyCheck({ k, sel: [sel, setSel], title }: { k: KeyEntry; sel: Selection; title?: string }) {
  return (
    <input
      type="checkbox"
      className="key-check"
      title={title ?? (canReveal(k) ? "Select for Reveal selected" : "Select")}
      checked={sel.has(k.id)}
      onChange={(e) =>
        setSel((s) => {
          const n = new Set(s);
          if (e.target.checked) n.add(k.id);
          else n.delete(k.id);
          return n;
        })
      }
    />
  );
}

/** "Select all · Select unrevealed · Clear" and the two-click Reveal selected (N) button, for `keys` (the ones in view).
 *  The selection also feeds Export (see selectedOr). */
export function RevealSelected({ keys, sel: [sel, setSel], selectLinks = true }: { keys: KeyEntry[]; sel: Selection; selectLinks?: boolean }) {
  const { busy, revealKeys, revealing } = useStore();
  const revealable = keys.filter((k) => sel.has(k.id) && canReveal(k));
  const unrevealed = keys.filter(canReveal);
  const selectedHere = keys.filter((k) => sel.has(k.id)).length;
  const only = (ks: KeyEntry[]) => setSel(new Set(ks.map((k) => k.id)));
  return (
    <span className="reveal-selected">
      {selectLinks && keys.length > 0 && (
        <>
          {selectedHere < keys.length && (
            <a title="Select every key here (for Export, or Reveal selected)" onClick={() => only(keys)}>
              Select all ({keys.length})
            </a>
          )}
          {unrevealed.length > 0 && !(selectedHere === unrevealed.length && unrevealed.every((k) => sel.has(k.id))) && (
            <a title="Select only the keys here that can be revealed" onClick={() => only(unrevealed)}>
              Select unrevealed ({unrevealed.length})
            </a>
          )}
          {selectedHere > 0 && (
            <a title="Unselect everything" onClick={() => setSel(new Set())}>
              Clear ({selectedHere})
            </a>
          )}
        </>
      )}
      <ArmButton
        className="hb-btn"
        disabled={!revealable.length || busy}
        title={
          !unrevealed.length
            ? "Every key here is already revealed (or can't be revealed yet)"
            : !revealable.length
              ? "Tick the unrevealed keys to reveal (or Select unrevealed)"
              : "Reveals the selected keys one at a time. Revealed keys can't be gifted afterwards."
        }
        armedText={`Reveal ${revealable.length} key${revealable.length === 1 ? "" : "s"}? Click again`}
        onFire={async () => {
          const res = await revealKeys(revealable.map((k) => k.id));
          if (res?.results) setSel((s) => new Set([...s].filter((id) => !res.results!.some((r) => r.ok && r.id === id))));
        }}
      >
        {revealing.length ? (
          <>
            <span className="spinner" aria-hidden /> Revealing… ({revealing.length} left)
          </>
        ) : (
          `Reveal selected${revealable.length ? ` (${revealable.length})` : ""}`
        )}
      </ArmButton>
    </span>
  );
}

/** For Export: the selected keys when any are selected, else all of them. */
export function selectedOr(keys: KeyEntry[], sel: Set<string>, scope: string): { keys: KeyEntry[]; scope: string } {
  const picked = keys.filter((k) => sel.has(k.id));
  return picked.length ? { keys: picked, scope: `the ${picked.length} selected key${picked.length === 1 ? "" : "s"} in ${scope}` } : { keys, scope };
}

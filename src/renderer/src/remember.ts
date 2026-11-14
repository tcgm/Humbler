// UI settings that survive navigation and restarts: search text, sort,
// filters, page, scroll position. Opening a bundle and coming back (or
// switching tabs, or restarting) puts every list back how you left it.
//
// Values live in memory (instant, also across hot reloads) and in
// localStorage (across restarts). Storage failures are ignored: worst case,
// settings are remembered only until Humbler closes.
import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

const PREFIX = "humbler.ui.";
const mem: Map<string, unknown> = import.meta.hot?.data.uiMem ?? new Map();
if (import.meta.hot) import.meta.hot.data.uiMem = mem;

function load<T>(key: string, initial: T): T {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) {
      const v = JSON.parse(raw) as T;
      if (typeof v === typeof initial) {
        mem.set(key, v);
        return v;
      }
    }
  } catch {
    // unavailable or corrupt: use the default
  }
  return initial;
}

function store(key: string, value: unknown): void {
  mem.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // memory only
  }
}

/** useState that remembers its value under `key`. */
export function useRemembered<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => load(key, initial));
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        store(key, v);
        return v;
      }),
    [key],
  );
  return [value, set];
}

/** Remembers a scroll container's position under `key` (in memory only). */
export function useRememberedScroll<E extends HTMLElement>(key: string) {
  const ref = useRef<E>(null);
  const k = `scroll:${key}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = mem.get(k);
    if (typeof saved === "number") el.scrollTop = saved;
    const onScroll = () => mem.set(k, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [k]);
  return ref;
}

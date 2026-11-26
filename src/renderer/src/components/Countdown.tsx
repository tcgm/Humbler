// Exact time left until a moment (a bundle's end), ticking every second.
// One shared one-second clock drives every countdown on screen.
import { useEffect, useState } from "react";

const subs = new Set<(t: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** The current time, updated every second while something uses it. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    subs.add(setNow);
    if (!timer) timer = setInterval(() => subs.forEach((f) => f(Date.now())), 1000);
    return () => {
      subs.delete(setNow);
      if (!subs.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "3d 04:12:09", "04:12:09", "12:09"; null once it's passed. */
export function leftText(endMs: number, now: number): string | null {
  const ms = endMs - now;
  if (!(ms > 0)) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = h || d ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  return d ? `${d}d ${hms}` : hms;
}

/** The exact end, in your time zone, to the second. */
export function exactEnd(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
}

/** "2d 04:12:09 left" (or "Ended"), with the exact end on hover. */
export function Countdown({ end, suffix = " left", className }: { end: string | null; suffix?: string; className?: string }) {
  const now = useNow();
  const t = Date.parse(end || "");
  if (!Number.isFinite(t)) return null;
  const left = leftText(t, now);
  return (
    <span className={className} title={`Ends ${exactEnd(end!)}`}>
      {left ? `${left}${suffix}` : "Ended"}
    </span>
  );
}

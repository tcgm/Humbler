// Small shared UI pieces.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LuRotateCcw } from "react-icons/lu";
import type { Bundle, KeyEntry } from "@shared/types";
import { api, useStore, type OrderInfo } from "../store";
import { formatDate, humblePageOf, normTitle, platformOf, plural, tileLook, type Deadline } from "../util";

/** Opens Humble URLs in the pane on the right and anything else in your browser. */
export function ExtLink({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a
      className="ext"
      title={title || href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void api.openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

/** Puts a list's search, sort and filters back to their defaults. Disabled
 *  when they already are. */
export function ResetButton({ dirty, onReset }: { dirty: boolean; onReset: () => void }) {
  return (
    <button
      className="hb-reset"
      disabled={!dirty}
      title={dirty ? "Reset search, sort and filters" : "Search, sort and filters are at their defaults"}
      aria-label="Reset search, sort and filters"
      onClick={onReset}
    >
      <LuRotateCcw aria-hidden />
    </button>
  );
}

/** "Humble page" link for any key, file or product (opens in the pane on the right). */
export function HumbleLink({ of, label = "Humble page" }: { of: Parameters<typeof humblePageOf>[0] | null | undefined; label?: string }) {
  const href = of ? humblePageOf(of) : null;
  if (!href) return null;
  return (
    <ExtLink href={href} title={`Open on Humble (right)\n${href}`}>
      {label}
    </ExtLink>
  );
}

export type TileSize = "xs" | "sm" | "md" | "lg" | "art";

/** Art when there is any, otherwise a stable coloured tile with initials. */
export function Tile({ title, size = "md", image }: { title: string; size?: TileSize; image?: string | null }) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) {
    return <img className={`tile ${size} art-img`} src={image} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  const { initials, hue } = tileLook(title);
  return (
    <div className={`tile ${size}`} style={{ background: `hsl(${hue} 38% 34%)` }}>
      {initials}
    </div>
  );
}

export function PlatformBadge({ k }: { k: Pick<KeyEntry, "keyType"> }) {
  const p = platformOf(k);
  return (
    <span className={`plat ${p.id}`} title={p.name || k.keyType || "Key"}>
      {p.badge}
    </span>
  );
}

/**
 * Two clicks for anything you can't take back: the first arms the button
 * (showing `armedText`) for 4 seconds, the second fires.
 */
export function ArmButton({
  armedText,
  onFire,
  children,
  className = "",
  ...rest
}: { armedText: string; onFire: () => void | Promise<void>; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      {...rest}
      className={`${className}${armed ? " armed" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 4000);
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        setArmed(false);
        void onFire();
      }}
    >
      {armed ? armedText : children}
    </button>
  );
}

export function CopyButton({ text, label = "Copy", className = "hb-btn ghost small" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      onClick={() => {
        void api.copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  if (pages <= 1) return null;
  const shown = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items: ReactNode[] = [];
  let last = 0;
  for (const n of shown) {
    if (n - last > 1) items.push(<span key={`gap${n}`} className="gap">…</span>);
    items.push(
      <button key={n} className={n === page ? "current" : ""} onClick={() => onPage(n)}>
        {n}
      </button>,
    );
    last = n;
  }
  return (
    <div className="hb-pager">
      <button disabled={page === 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      {items}
      <button disabled={page === pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}

export function DeadlineBadge({ dl, keepSpace = true }: { dl: Deadline | null; keepSpace?: boolean }) {
  if (!dl) return keepSpace ? <div className="hb-deadline none" /> : null;
  const cls = dl.days < 0 ? "past" : dl.days <= 30 ? "soon" : "";
  const when = dl.days < 0 ? "Deadline passed" : dl.days === 0 ? "Redeem today" : `Redeem by ${formatDate(dl.date)}`;
  const left = dl.days < 0 ? formatDate(dl.date) : `${dl.days} day${dl.days === 1 ? "" : "s"} left`;
  return (
    <div className={`hb-deadline ${cls}`} title={`${plural(dl.count, "unrevealed key")} must be redeemed by ${formatDate(dl.date)}`}>
      <strong>{when}</strong>
      <small>{left}</small>
    </div>
  );
}

/** A bundle's order info (art, purchase date/price, key deadline), if known. */
export function useOrderInfo(b: Pick<Bundle, "name"> | null | undefined): OrderInfo | null {
  const { orders } = useStore();
  return b ? orders.get(normTitle(b.name)) || null : null;
}

export function BundleIcon({ b, size = "md" }: { b: Bundle; size?: TileSize }) {
  const info = useOrderInfo(b);
  return <Tile title={b.name} size={size} image={info?.thumbnail || info?.logo} />;
}

export function BackLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <a className="hb-back" onClick={onClick}>
      ‹ {children}
    </a>
  );
}

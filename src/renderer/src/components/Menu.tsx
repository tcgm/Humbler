// A menu button in the top bar: the ☰ one (full refresh, the browser pane,
// folders...), and the update one. Closes on a pick, a click elsewhere, or Escape.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuMenu } from "react-icons/lu";

export interface MenuItem {
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  onPick: () => void;
}

export function Menu({
  items,
  icon = <LuMenu aria-hidden />,
  title = "More",
  label = "More actions",
  className = "",
}: {
  items: (MenuItem | "-")[];
  /** the button's face (default ☰) */
  icon?: ReactNode;
  title?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`icon-btn ${className}`.trim()} title={title} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) =>
            it === "-" ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                role="menuitem"
                className="menu-item"
                title={it.title}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onPick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

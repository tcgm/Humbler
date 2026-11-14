// Tooltips for the whole UI, in the style of MUI / Chakra: every `title`
// attribute shows as a styled tooltip instead of the browser's own. Mounted
// once (App); nothing else needs changing: keep writing title="...".
//
// - Shows above the element (below when there's no room), kept inside the
//   window, with an arrow pointing at it; fades and scales in.
// - A short delay before the first one; moving straight to another element
//   shows its tooltip at once. Hides on leave, click, scroll or Escape.
// - Keyboard focus shows it too.
// - The title is moved to data-tip so the browser's own tooltip doesn't
//   also appear; screen readers keep it (aria-label on elements with no
//   text of their own, aria-description otherwise).
// (Disabled buttons get no pointer events in Chromium, so theirs stay native.)
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ENTER_DELAY = 350; // ms before the first tooltip
const INSTANT_WINDOW = 400; // ms after one hides during which the next shows at once
const GAP = 8; // px between the element and the tooltip
const MARGIN = 8; // px from the window edges

type Tip = { el: HTMLElement; text: string };

/** The element's tooltip text, taking over its title attribute. */
function tipOf(el: HTMLElement): string | null {
  const title = el.getAttribute("title");
  if (title != null) {
    el.removeAttribute("title");
    if (title.trim()) {
      el.setAttribute("data-tip", title);
      // keep it for screen readers
      if (!el.getAttribute("aria-label") && !(el.textContent || "").trim()) el.setAttribute("aria-label", title);
      else if (!el.getAttribute("aria-description")) el.setAttribute("aria-description", title);
    } else el.removeAttribute("data-tip");
  }
  const tip = el.getAttribute("data-tip");
  return tip && tip.trim() ? tip : null;
}

/** The nearest element (from `node` up) with a tooltip. */
function findTipTarget(node: EventTarget | null): Tip | null {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && (el.hasAttribute("title") || el.hasAttribute("data-tip"))) {
      const text = tipOf(el);
      if (text) return { el, text };
    }
    el = el.parentElement;
  }
  return null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHidden = useRef(0);
  const current = useRef<Tip | null>(null);
  current.current = tip;

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const hide = () => {
      clear();
      if (current.current) lastHidden.current = Date.now();
      setTip(null);
    };
    const showFor = (t: Tip | null) => {
      clear();
      if (!t) return hide();
      if (current.current?.el === t.el && current.current.text === t.text) return;
      const instant = !!current.current || Date.now() - lastHidden.current < INSTANT_WINDOW;
      if (current.current) setTip(null); // moving between elements: swap
      if (instant) setTip(t);
      else timer.current = setTimeout(() => t.el.isConnected && setTip(t), ENTER_DELAY);
    };

    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      showFor(findTipTarget(e.target));
    };
    const out = (e: PointerEvent) => {
      // left for something outside the tooltip's element: hide (the next "over" may show another)
      const to = e.relatedTarget as Node | null;
      const cur = current.current?.el;
      if (cur && to && cur.contains(to)) return;
      if (!to) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el?.matches?.(":focus-visible")) showFor(findTipTarget(el));
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();

    // React re-sets a title when its text changes (e.g. "Copy" -> "Copied"): take it over again
    // for elements that already had a tooltip, and update the one showing.
    const watch = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (!el.hasAttribute("title") || !el.hasAttribute("data-tip")) continue;
        const text = tipOf(el);
        if (current.current?.el === el) setTip(text ? { el, text } : null);
      }
    });
    watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["title"] });

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      clear();
      watch.disconnect();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // the element went away (re-render, closed dialog): drop its tooltip
  useEffect(() => {
    if (!tip) return;
    const t = setInterval(() => {
      if (!tip.el.isConnected) setTip(null);
    }, 300);
    return () => clearInterval(t);
  }, [tip]);

  return tip ? createPortal(<TipBox tip={tip} />, document.body) : null;
}

function TipBox({ tip }: { tip: Tip }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const r = tip.el.getBoundingClientRect();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const below = r.top - GAP - h < MARGIN && r.bottom + GAP + h <= window.innerHeight - MARGIN;
    const center = r.left + r.width / 2;
    const left = Math.min(Math.max(center - w / 2, MARGIN), vw - w - MARGIN);
    const top = below ? r.bottom + GAP : r.top - GAP - h;
    setPos({ left, top, arrow: Math.min(Math.max(center - left, 10), w - 10), below });
  }, [tip]);

  return (
    <div
      ref={box}
      role="tooltip"
      className={`tooltip${pos ? " show" : ""}${pos?.below ? " below" : ""}`}
      style={pos ? { left: pos.left, top: pos.top, ["--arrow-x" as string]: `${pos.arrow}px` } : { left: -9999, top: -9999 }}
    >
      {tip.text}
    </div>
  );
}

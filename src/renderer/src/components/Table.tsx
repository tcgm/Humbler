// Table headers you can sort by and resize, remembered per table.
//   Click a header: sort by it; again: reverse; a third time: back to the
//   list's own order. Drag a header's right edge to resize its column; the
//   first drag pins every column at its current width, so widening one makes
//   the table wider (it scrolls sideways) instead of squeezing the others.
//   Double-click an edge to go back to the automatic widths.
//
// Automatic widths: every column is as wide as its content needs, and the
// "grow" columns (the names of things) share all the space left over,
// cutting off with "…" only when the window is too narrow.
import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useRemembered } from "../remember";

export interface Col<T> {
  id: string;
  label: ReactNode;
  className?: string;
  title?: string;
  /** makes the column sortable: ascending order */
  sort?: (a: T, b: T) => number;
  /** fixed columns (checkboxes, icons) can't be resized */
  fixed?: boolean;
  /** a names column: shares the space the other columns don't need (weight, e.g. 2 = twice another grow column) */
  grow?: number;
}

type SortState = { col: string; desc: boolean } | null;
const MIN_WIDTH = 40;

/** a comparator for text (natural order: "Vol. 2" before "Vol. 10") */
export const byText = <T,>(get: (x: T) => string | null | undefined) => {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return (a: T, b: T) => coll.compare(get(a) || "", get(b) || "");
};
/** a comparator for numbers; missing values last */
export const byNumber =
  <T,>(get: (x: T) => number | null | undefined) =>
  (a: T, b: T) =>
    (get(a) ?? Infinity) - (get(b) ?? Infinity);

export function useTable<T>(name: string, cols: Col<T>[], rows: T[]) {
  const [sort, setSort] = useRemembered<SortState>(`table.${name}.sort`, null);
  const [widths, setWidths] = useRemembered<Record<string, number>>(`table.${name}.widths`, {});

  const col = sort ? cols.find((c) => c.id === sort.col && c.sort) : undefined;
  const sorted = useMemo(() => {
    if (!col?.sort) return rows;
    const cmp = col.sort;
    const out = [...rows].sort(cmp); // stable: ties keep the list's order
    return sort!.desc ? out.reverse() : out;
  }, [rows, col, sort]);

  const pinned = cols.every((c) => widths[c.id] > 0);
  const growTotal = cols.reduce((s, c) => s + (c.grow || 0), 0) || 1;
  // automatic widths: grow columns split the room by weight; the rest shrink to their content (width 1%)
  const autoWidth = (c: Col<T>): CSSProperties | undefined => (c.grow ? { width: `${(c.grow / growTotal) * 100}%` } : c.fixed ? undefined : { width: "1%" });
  const headers = cols.map((c, i) => (
    <Th
      key={c.id}
      c={c}
      sort={sort?.col === c.id ? sort : null}
      width={pinned ? widths[c.id] : undefined}
      autoStyle={pinned ? undefined : autoWidth(c)}
      onSort={() => setSort(next(sort, c.id))}
      onResizeStart={(row) => {
        // pin every column at its current width first
        if (pinned) return;
        const ths = [...row.children] as HTMLElement[];
        setWidths(Object.fromEntries(cols.map((x, j) => [x.id, Math.round(ths[j]?.getBoundingClientRect().width || 100)])));
      }}
      onWidth={(w) => setWidths((ws) => ({ ...ws, [cols[i].id]: Math.round(w) }))}
      onReset={() => setWidths({})}
    />
  ));
  // pinned: fixed layout, as wide as its columns (at least the window), scrolling sideways when wider;
  // automatic: auto layout (see autoWidth)
  const tableStyle: CSSProperties = pinned ? { width: cols.reduce((s, c) => s + widths[c.id], 0), minWidth: "100%", tableLayout: "fixed" } : { tableLayout: "auto" };
  const tableClass = pinned ? "cols-pinned" : "cols-auto";
  return { rows: sorted, headers, tableStyle, tableClass };
}

function next(cur: SortState, id: string): SortState {
  if (!cur || cur.col !== id) return { col: id, desc: false };
  return cur.desc ? null : { col: id, desc: true };
}

function Th<T>({
  c,
  sort,
  width,
  autoStyle,
  onSort,
  onResizeStart,
  onWidth,
  onReset,
}: {
  c: Col<T>;
  sort: SortState;
  width?: number;
  autoStyle?: CSSProperties;
  onSort: () => void;
  onResizeStart: (row: HTMLElement) => void;
  onWidth: (w: number) => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const style: CSSProperties | undefined = width ? { width, minWidth: width, maxWidth: width } : autoStyle;

  const startResize = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const th = ref.current;
    if (!th) return;
    const x0 = e.clientX;
    const w0 = th.getBoundingClientRect().width;
    if (th.parentElement) onResizeStart(th.parentElement);
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    const move = (ev: PointerEvent) => onWidth(Math.max(MIN_WIDTH, w0 + ev.clientX - x0));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("col-resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <th ref={ref} className={`${c.className || ""}${c.sort ? " sortable" : ""}${c.grow ? " grow" : ""}`} style={style} title={c.title} aria-sort={sort ? (sort.desc ? "descending" : "ascending") : c.sort ? "none" : undefined}>
      {c.sort ? (
        <button type="button" className="th-sort" onClick={onSort} title={c.title || "Sort by this column (click again to reverse, a third time for the default order)"}>
          {c.label}
          <span className="sort-mark" aria-hidden>
            {sort ? (sort.desc ? "▼" : "▲") : "↕"}
          </span>
        </button>
      ) : (
        c.label
      )}
      {!c.fixed && <span className="col-resize" title="Drag to resize; double-click for the automatic widths" onPointerDown={startResize} onDoubleClick={onReset} />}
    </th>
  );
}

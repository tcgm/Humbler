// Decoder for React Server Components "flight" payloads. Humble's 2026 site
// is a Next.js App Router app, so its page data arrives in this format
// rather than JSON:
//   - client navigations fetch `?_rsc=…` URLs (content-type text/x-component)
//   - server actions (mutations) POST with a `Next-Action` header and reply
//     in the same format
//   - the first page load embeds the payload in
//     self.__next_f.push([1, "…"]) script chunks
//
// A payload is a sequence of rows: `<hex id>:<payload>\n`. The payload is
// JSON, an optional tag letter plus JSON (I = module import, HL = hint,
// E = error…), or `T<hex byte length>,<raw text>` (a text chunk with no
// trailing newline). We only need the data, so this returns every row that
// parses as JSON, which is where props, and so page data, live.

function parseFlight(text) {
  if (typeof text !== "string" || !text) return [];
  const buf = Buffer.from(text, "utf8"); // T-row lengths are in bytes
  const rows = [];
  let i = 0;
  while (i < buf.length) {
    // row id: hex digits up to ':'
    let j = i;
    while (j < buf.length && /[0-9a-fA-F]/.test(String.fromCharCode(buf[j]))) j++;
    if (j === i || buf[j] !== 0x3a /* : */) {
      // not a row start: skip to the next line
      const nl = buf.indexOf(0x0a, i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    const id = buf.toString("utf8", i, j);
    let k = j + 1;
    // optional tag letters
    let tag = "";
    while (k < buf.length && /[A-Z]/.test(String.fromCharCode(buf[k]))) tag += String.fromCharCode(buf[k++]);
    if (tag === "T") {
      const comma = buf.indexOf(0x2c /* , */, k);
      const len = parseInt(buf.toString("utf8", k, comma), 16);
      if (comma < 0 || !Number.isFinite(len)) break;
      rows.push({ id, tag, value: buf.toString("utf8", comma + 1, comma + 1 + len) });
      i = comma + 1 + len;
      continue;
    }
    let nl = buf.indexOf(0x0a, k);
    if (nl < 0) nl = buf.length;
    const raw = buf.toString("utf8", k, nl);
    try {
      rows.push({ id, tag, value: JSON.parse(raw) });
    } catch {
      // not JSON (truncated payload, unknown tag): ignore
    }
    i = nl + 1;
  }
  return rows;
}

// Rows reference each other: a value like "$1f" means "the value of row
// 1f", "$1f:a:b" means a path inside it, "$@1f" a promise and "$L1f" a lazy
// chunk for that row. Big payloads (like the library's download details
// and signed URLs) live in their own rows, so without resolving, items
// just contain "$1f" placeholders. This returns every object row with its
// references substituted, following the React Flight client's
// parseModelString rules for the cases that carry data.
function resolvedFlightData(text) {
  const rows = parseFlight(text);
  const byId = new Map(rows.map((r) => [r.id, r.value]));
  const done = new Map(); // row id -> resolved value (also breaks cycles)

  const resolveRow = (id) => {
    if (done.has(id)) return done.get(id);
    if (!byId.has(id)) return null;
    const raw = byId.get(id);
    // Placeholder first, so a cycle resolves to the same (in-progress) object.
    const holder = Array.isArray(raw) ? [] : raw && typeof raw === "object" ? {} : undefined;
    if (holder === undefined) {
      const v = resolveValue(raw, 0);
      done.set(id, v);
      return v;
    }
    done.set(id, holder);
    const v = resolveValue(raw, 0);
    if (Array.isArray(holder)) holder.push(...v);
    else Object.assign(holder, v);
    return holder;
  };

  const resolveString = (s, depth) => {
    if (s[0] !== "$") return s;
    if (s === "$undefined" || s === "$u") return null;
    if (s.startsWith("$$")) return s.slice(1); // escaped literal "$"
    if (s.startsWith("$D")) return s.slice(2); // date (ISO string)
    if (s === "$NaN" || s === "$Infinity" || s === "$-Infinity" || s === "$-0") return s;
    let m = /^\$[@L]?([0-9a-f]+)(?::(.+))?$/.exec(s); // plain / promise / lazy reference, optional path
    if (!m) {
      m = /^\$[QW]([0-9a-f]+)$/.exec(s); // Map / Set: the row holds an entries / values array
      if (m) return resolveRow(m[1]);
      return s; // other tags ($S symbol, $F server ref, $K formdata…) carry no data we need
    }
    let v = resolveRow(m[1]);
    if (m[2]) for (const seg of m[2].split(":")) v = v == null ? null : v[seg];
    return v;
  };

  function resolveValue(v, depth) {
    if (depth > 200) return v;
    if (typeof v === "string") return resolveString(v, depth);
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, depth + 1));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, depth + 1);
      return out;
    }
    return v;
  }

  return rows.map((r) => resolveRow(r.id)).filter((v) => v && typeof v === "object");
}

// Just the JSON data (rows with object/array values), for shape-searching
// harvesters.
function flightData(text) {
  return parseFlight(text)
    .map((r) => r.value)
    .filter((v) => v && typeof v === "object");
}

// Runs in the page; returns the page's embedded flight payload. Next.js
// drains self.__next_f once it hydrates, so the array is usually empty by
// the time we look. The inline <script>self.__next_f.push([1,"…"])</script>
// tags that fed it stay in the DOM, so read those, and fall back to the
// array if it still has entries.
const PAGE_FLIGHT_SCRIPT = `
(() => {
  const parts = [];
  for (const s of document.querySelectorAll("script:not([src])")) {
    const t = s.textContent;
    if (!t.includes("__next_f.push")) continue;
    const m = t.match(/__next_f\\.push\\((\\[[\\s\\S]*\\])\\)\\s*;?\\s*$/);
    if (!m) continue;
    try {
      const c = JSON.parse(m[1]);
      if (c[0] === 1 && typeof c[1] === "string") parts.push(c[1]);
    } catch {}
  }
  if (!parts.length) {
    for (const c of self.__next_f || []) if (Array.isArray(c) && c[0] === 1 && typeof c[1] === "string") parts.push(c[1]);
  }
  return parts.join("");
})()
`;

// The same embedded payload, from a page's raw HTML (for pages fetched
// rather than opened): every self.__next_f.push([1,"…"]) chunk, joined.
function flightFromHtml(html) {
  const parts = [];
  const re = /self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/g;
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      const c = JSON.parse(m[1]);
      if (c[0] === 1 && typeof c[1] === "string") parts.push(c[1]);
    } catch {
      // not a data chunk
    }
  }
  return parts.join("");
}

module.exports = { parseFlight, flightData, resolvedFlightData, flightFromHtml, PAGE_FLIGHT_SCRIPT };

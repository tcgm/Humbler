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

module.exports = { parseFlight, flightData, PAGE_FLIGHT_SCRIPT };

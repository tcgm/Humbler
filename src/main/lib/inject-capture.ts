// Scouting, as in pinterinter. This script is injected into every
// humblebundle.com document via CDP Page.addScriptToEvaluateOnNewDocument, so
// it runs before Humble's own scripts. It records JSON responses made by
// fetch/XHR into a page global, which main.js reads back when you click
// "Scout this page".
//
// Bodies are read in the page, by the same code that made the request. That
// is more reliable than CDP's Network.getResponseBody, which silently misses
// some request types.
//
// Unlike pinterinter, XHR is patched on the prototype, not by replacing the
// constructor, so `instanceof XMLHttpRequest` checks in Humble's code still
// pass. Request bodies are never recorded, because the login form posts your
// password.

export const INJECT_SOURCE = `
(function () {
  if (window.__humbler) return;
  const MAX = 1000;
  const captured = [];
  window.__humbler = { captured };

  const record = (entry) => {
    const full = Object.assign({ at: new Date().toISOString() }, entry);
    if (captured.length >= MAX) captured.shift();
    captured.push(full);
    // Continuous scouting: push each response to Humbler immediately through
    // a CDP binding (Runtime.addBinding), so leaving the page loses nothing.
    if (typeof window.__humblerEmit === "function") {
      try { window.__humblerEmit(JSON.stringify(full)); } catch {}
    }
  };
  const isJson = (ct) => /json/i.test(ct || "");
  // React Server Components payloads: how Humble's Next.js site moves page data
  const isRsc = (ct) => /text\\/x-component/i.test(ct || "");
  const MAX_TEXT = 3 * 1024 * 1024;
  const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const headerOf = (input, init, name) => {
    try {
      const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
      return h.get(name);
    } catch { return null; }
  };

  const describeBody = (b) => {
    try {
      if (b == null) return null;
      if (typeof b === "string") return b.slice(0, 65536);
      if (b instanceof URLSearchParams) return b.toString().slice(0, 65536);
      if (b instanceof FormData) {
        return Array.from(b.entries()).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 65536) : "<file " + (v.name || "blob") + ">"]);
      }
      return "<" + (b.constructor && b.constructor.name) + ">";
    } catch { return null; }
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = absolute(typeof input === "string" ? input : (input && input.url) || "");
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      // Next.js server actions (mutations) carry their action id in this header.
      const action = headerOf(input, init, "Next-Action");
      // For server actions only, keep the request body (the action's
      // arguments, e.g. which library page to fetch) so it can be replayed.
      // Humbler scrubs it before writing. Login is NOT a server action (it
      // posts Ory's own form to auth.humblebundle.com), so no password
      // passes through here.
      const requestBody = action ? describeBody(init && init.body) : undefined;
      return origFetch.apply(this, arguments).then((res) => {
        const ct = res.headers.get("content-type");
        if (isJson(ct)) {
          res.clone().json()
            .then((body) => record({ via: "fetch", kind: "json", method, url, status: res.status, action, requestBody, body }))
            .catch(() => {});
        } else if (isRsc(ct)) {
          res.clone().text()
            .then((text) => record({
              via: "fetch", kind: "rsc", method, url, status: res.status, action, requestBody,
              truncated: text.length > MAX_TEXT, text: text.slice(0, MAX_TEXT),
            }))
            .catch(() => {});
        }
        return res;
      });
    };
  }

  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (method, url) {
    this.__humbler = { method: String(method || "GET").toUpperCase(), url: absolute(url) };
    return origOpen.apply(this, arguments);
  };
  proto.send = function () {
    const meta = this.__humbler;
    if (meta) {
      this.addEventListener("load", () => {
        try {
          if (!isJson(this.getResponseHeader("content-type"))) return;
          const body = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          record({ via: "xhr", method: meta.method, url: meta.url, status: this.status, body });
        } catch {
          // not parseable JSON — skip
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
`;

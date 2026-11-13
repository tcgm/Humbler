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

const INJECT_SOURCE = `
(function () {
  if (window.__humbler) return;
  const MAX = 1000;
  const captured = [];
  window.__humbler = { captured };

  const record = (entry) => {
    if (captured.length >= MAX) captured.shift();
    captured.push(Object.assign({ at: new Date().toISOString() }, entry));
  };
  const isJson = (ct) => /json/i.test(ct || "");
  const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = absolute(typeof input === "string" ? input : (input && input.url) || "");
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      return origFetch.apply(this, arguments).then((res) => {
        if (isJson(res.headers.get("content-type"))) {
          res.clone().json()
            .then((body) => record({ via: "fetch", method, url, status: res.status, body }))
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

module.exports = { INJECT_SOURCE };

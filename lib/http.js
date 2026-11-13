// Thin wrappers over Electron's `net` module, bound to the Humble session
// partition so every request carries your real login cookies and the same
// user agent as the browser pane (which matters for Cloudflare).
const { net } = require("electron");

function header(res, name) {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v || "";
}

// Resolves once response headers arrive; caller consumes `res` (a Readable).
function openRequest(ses, { url, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, session: ses, useSessionCookies: true, redirect: "follow" });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on("response", (res) => resolve({ req, res }));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchText(ses, opts) {
  const { res } = await openRequest(ses, opts);
  const chunks = [];
  await new Promise((resolve, reject) => {
    res.on("data", (c) => chunks.push(c));
    res.on("end", resolve);
    res.on("error", reject);
    res.on("aborted", () => reject(new Error("request aborted")));
  });
  return {
    status: res.statusCode,
    contentType: header(res, "content-type"),
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

module.exports = { openRequest, fetchText, header };

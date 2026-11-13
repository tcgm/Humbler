// Humble Bundle's own JSON endpoints — the same ones its library/keys pages
// call. Not a public, documented API: if Humble changes them, this is the
// one file to fix.
const { fetchText } = require("./http");

const BASE = "https://www.humblebundle.com";
const BULK_CHUNK = 40;

class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in to Humble Bundle (log in using the browser pane).");
    this.name = "NotLoggedInError";
  }
}

class HumbleApi {
  constructor(getSession) {
    this.getSession = getSession;
  }

  async getJson(pathAndQuery) {
    const r = await fetchText(this.getSession(), {
      url: BASE + pathAndQuery,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    if (r.status === 401 || r.status === 403) throw new NotLoggedInError();
    if (!r.contentType.includes("json")) {
      // A redirect to the login page lands here as HTML.
      if (/<html/i.test(r.text)) throw new NotLoggedInError();
      throw new Error(`Unexpected ${r.contentType || "response"} (HTTP ${r.status}) from ${pathAndQuery}`);
    }
    if (r.status >= 400) throw new Error(`HTTP ${r.status} from ${pathAndQuery}: ${r.text.slice(0, 200)}`);
    return JSON.parse(r.text);
  }

  async listGamekeys() {
    const data = await this.getJson("/api/v1/user/order");
    if (!Array.isArray(data)) throw new Error("Order list was not an array — has the API changed?");
    return data.map((o) => o.gamekey).filter(Boolean);
  }

  async fetchOrder(gamekey) {
    return this.getJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`);
  }

  // Up to BULK_CHUNK orders per call. Returns an array of orders.
  async fetchOrdersBulk(gamekeys) {
    const qs = gamekeys.map((k) => `gamekeys=${encodeURIComponent(k)}`).join("&");
    const data = await this.getJson(`/api/v1/orders?all_tpkds=true&${qs}`);
    if (!data || typeof data !== "object") throw new Error("Bulk order response was not an object");
    return Object.values(data).filter((o) => o && o.gamekey);
  }
}

module.exports = { HumbleApi, NotLoggedInError, BASE, BULK_CHUNK };

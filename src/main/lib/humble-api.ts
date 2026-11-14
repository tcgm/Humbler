// Humble Bundle's legacy JSON endpoints (/api/v1/...), the ones the
// pre-2026 library/keys pages called. Not a public, documented API: if
// Humble changes them, this is the one file to fix.
//
// Two transports:
//   "net":  Electron's net module on the Humble session partition (fast, no
//           page needed)
//   "page": fetch() run inside the logged-in Humble page itself, carrying
//           exactly the cookies and origin the site's own code uses
// Humble's 2026 login (Ory, auth.humblebundle.com) may set cookies the net
// transport doesn't carry, so when net says "not logged in", the request is
// retried in-page, and whichever works is used from then on.
import type { Session } from "electron";
import { fetchText } from "./http";

export const BASE = "https://www.humblebundle.com";
export const BULK_CHUNK = 40;

export interface PageFetchResult {
  status: number;
  contentType?: string;
  text?: string;
  finalUrl?: string;
}

export type PageFetch = (url: string) => Promise<PageFetchResult>;

export class NotLoggedInError extends Error {
  detail: string;
  constructor(detail?: string) {
    super(`Not logged in to Humble Bundle${detail ? ` (${detail})` : ""}.`);
    this.name = "NotLoggedInError";
    this.detail = detail || "";
  }
}

export class ApiGoneError extends Error {
  constructor(pathAndQuery: string, detail: string) {
    super(`Humble's ${pathAndQuery.split("?")[0]} endpoint no longer exists (${detail})`);
    this.name = "ApiGoneError";
  }
}

// Describe a response for diagnostics without leaking data: status, type,
// where it ended up (path only), and a short snippet with digits masked.
function describe(r: PageFetchResult, pathAndQuery: string): string {
  let where = "";
  try {
    if (r.finalUrl && !r.finalUrl.endsWith(pathAndQuery)) where = ` → ${new URL(r.finalUrl).host}${new URL(r.finalUrl).pathname}`;
  } catch {
    // ignore
  }
  const snippet = String(r.text || "")
    .replace(/\s+/g, " ")
    .slice(0, 100)
    .replace(/[A-Za-z0-9]{12,}/g, "…");
  return `HTTP ${r.status}, ${r.contentType || "no content-type"}${where}, body starts: ${JSON.stringify(snippet)}`;
}

export class HumbleApi {
  getSession: () => Session;
  pageFetch: PageFetch | undefined;
  log: (msg: string) => void;
  transport: "net" | "page";

  // pageFetch(url) -> { status, contentType, text, finalUrl } run inside the Humble page (optional)
  constructor(getSession: () => Session, { pageFetch, log }: { pageFetch?: PageFetch; log?: (msg: string) => void } = {}) {
    this.getSession = getSession;
    this.pageFetch = pageFetch;
    this.log = log || (() => {});
    this.transport = "net"; // switches to "page" if that's what works
  }

  // Returns Humble's JSON (untyped external data).
  interpret(r: PageFetchResult, pathAndQuery: string): any {
    // 404 is not a login problem: the endpoint itself is gone. (Since the
    // 2026 redesign, /api/v1/... returns the Next.js "page not found" page.)
    if (r.status === 404) throw new ApiGoneError(pathAndQuery, describe(r, pathAndQuery));
    if (r.status === 401 || r.status === 403) throw new NotLoggedInError(describe(r, pathAndQuery));
    if (!/json/i.test(r.contentType || "")) {
      // A redirect to the login page lands here as HTML.
      if (/<html|<!doctype/i.test(r.text || "")) throw new NotLoggedInError(describe(r, pathAndQuery));
      throw new Error(`Unexpected response from ${pathAndQuery}: ${describe(r, pathAndQuery)}`);
    }
    if (r.status >= 400) throw new Error(`Error from ${pathAndQuery}: ${describe(r, pathAndQuery)}`);
    return JSON.parse(r.text as string);
  }

  async viaNet(pathAndQuery: string): Promise<any> {
    const r = await fetchText(this.getSession(), {
      url: BASE + pathAndQuery,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    return this.interpret(r, pathAndQuery);
  }

  async viaPage(pathAndQuery: string): Promise<any> {
    const r = await (this.pageFetch as PageFetch)(BASE + pathAndQuery);
    return this.interpret(r, pathAndQuery);
  }

  async getJson(pathAndQuery: string): Promise<any> {
    if (this.transport === "page" && this.pageFetch) return this.viaPage(pathAndQuery);
    try {
      return await this.viaNet(pathAndQuery);
    } catch (err) {
      if (!(err instanceof NotLoggedInError) || !this.pageFetch) throw err;
      this.log(`  direct request: ${err.detail}`);
      this.log("  retrying from inside the logged-in Humble page…");
      try {
        const data = await this.viaPage(pathAndQuery);
        this.transport = "page";
        this.log("  that worked: syncing through the Humble page from now on.");
        return data;
      } catch (pageErr: any) {
        this.log(`  in-page request: ${pageErr.detail || pageErr.message}`);
        throw pageErr;
      }
    }
  }

  async listGamekeys(): Promise<string[]> {
    const data = await this.getJson("/api/v1/user/order");
    if (!Array.isArray(data)) throw new Error("Order list was not an array. Has the API changed?");
    return data.map((o: any) => o.gamekey).filter(Boolean);
  }

  // Raw order JSON (untyped external data).
  async fetchOrder(gamekey: string): Promise<any> {
    return this.getJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`);
  }

  // Up to BULK_CHUNK orders per call. Returns an array of orders.
  async fetchOrdersBulk(gamekeys: string[]): Promise<any[]> {
    const qs = gamekeys.map((k) => `gamekeys=${encodeURIComponent(k)}`).join("&");
    const data = await this.getJson(`/api/v1/orders?all_tpkds=true&${qs}`);
    if (!data || typeof data !== "object") throw new Error("Bulk order response was not an object");
    return Object.values<any>(data).filter((o) => o && o.gamekey);
  }
}

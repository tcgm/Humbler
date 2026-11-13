// Continuous scouting. Every JSON response a Humble page receives is pushed
// here as it happens (the injected script calls a CDP binding, so a
// navigation can't lose it). It's folded into a running catalog of the
// site's endpoints:
//
//   data/recon/live/endpoints.json   every endpoint seen: counts, statuses,
//                                    pages that call it, first/last seen,
//                                    response shapes
//   data/recon/live/samples/*.json   one scrubbed sample per distinct
//                                    response *shape* per endpoint
//
// Keeping one sample per shape, rather than every response, bounds disk
// use. It also turns the catalog into a change detector: when Humble alters
// a response format, a new shape (and sample) appears and gets logged.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RECON_DIR } from "./paths";
import { flightData } from "./rsc";
import type { Scrubber } from "./scrub";

export const LIVE_DIR = path.join(RECON_DIR, "live");
const SAMPLES_DIR = path.join(LIVE_DIR, "samples");
const CATALOG_PATH = path.join(LIVE_DIR, "endpoints.json");
const MAX_SHAPES_PER_ENDPOINT = 20;
const MAX_PAGES_PER_ENDPOINT = 10;
const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;
const HUMBLE_HOST = /(^|\.)humblebundle\.com$|(^|\.)humble\.com$/i;
// Humble's own telemetry (error-monitoring tunnel): never interesting
const IGNORED_PATH = /^\/(monitoring|cdn-cgi)(\/|$)/;
// RSC page fetches: keep these path segments, collapse anything else after
// the first segment to :slug, so /store/<every product> is one catalog entry.
const KEEP_SEGMENTS = new Set(["home", "library", "keys", "purchases", "downloads", "membership", "subscription", "settings", "account", "gifts", "choice", "store", "books", "games", "software", "bundles"]);
const STALE_SAMPLE_MS = 10 * 60 * 1000;

export interface ShapeRecord {
  hash: string;
  firstSeen: string;
  lastSeen: string;
  sampledAt?: string;
  count: number;
  sample: string;
}

export interface EndpointRecord {
  count: number;
  firstSeen: string;
  lastSeen: string;
  statuses: Record<string, number>;
  pages: string[];
  shapes: ShapeRecord[];
  requestBodies?: unknown[];
}

export interface Catalog {
  endpoints: Record<string, EndpointRecord>;
}

/** A response captured by the injected script (inject-capture). */
export interface CapturedEntry {
  via?: string;
  kind?: string;
  method?: string;
  url: string;
  status: number;
  action?: string | null;
  requestBody?: unknown;
  body?: unknown; // the response JSON (untyped)
  text?: string;
  truncated?: boolean;
  at?: string;
}

function rscEndpointOf(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const p = segs.map((s, i) => (i === 0 || KEEP_SEGMENTS.has(s) ? s : ":slug")).join("/");
    return `${u.host}/${p}`;
  } catch {
    return String(url).split("?")[0];
  }
}

const sha = (s: string): string => crypto.createHash("sha1").update(s).digest("hex");

// Collapse ids in paths, so /api/v1/order/AbC123xyz groups with the others.
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname
      .split("/")
      .map((seg) =>
        /^gamekey#/.test(seg) || (/^[A-Za-z0-9_-]{12,}$/.test(seg) && /\d/.test(seg)) || /^\d+$/.test(seg) ? ":id" : seg,
      )
      .join("/");
    return `${u.host}${p}`;
  } catch {
    return String(url).split("?")[0];
  }
}

const pageOf = (url: string): string => {
  try {
    const u = new URL(url);
    return endpointOf(`${u.origin}${u.pathname}`);
  } catch {
    return "";
  }
};

// Structural signature of a JSON value: field names and types, not data.
// Objects that are really maps (many keys, all values of one kind, such as
// gamekey -> order or machine_name -> game) collapse to {"<map>": shape},
// so the shape doesn't change just because the data did.
// v: arbitrary JSON; the result is JSON too.
export function shapeOf(v: any, depth = 0): any {
  if (depth > 12) return "…";
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return [];
    const shapes = [...new Set(v.slice(0, 5).map((x) => JSON.stringify(shapeOf(x, depth + 1))))];
    return shapes.map((s) => JSON.parse(s));
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    const kinds = new Set(Object.values(v).map((x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x)));
    const idLike = keys.length && keys.filter((k) => /\d/.test(k) || k.length >= 12).length / keys.length > 0.6;
    if ((keys.length > 12 || (idLike && keys.length > 2)) && kinds.size === 1) {
      return { "<map>": shapeOf(v[keys[0]], depth + 1) };
    }
    const out: Record<string, any> = {};
    for (const k of keys.sort()) out[k] = shapeOf(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

export class LiveScout {
  log: (msg: string) => void;
  getScrubber: () => Scrubber;
  catalog: Catalog;
  saveTimer: ReturnType<typeof setTimeout> | null;
  warned: Set<string>;

  constructor({ log, getScrubber }: { log: (msg: string) => void; getScrubber: () => Scrubber }) {
    this.log = log;
    this.getScrubber = getScrubber; // () => scrubber (cached by caller)
    this.catalog = this.load();
    this.saveTimer = null;
    this.warned = new Set();
  }

  load(): Catalog {
    try {
      return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    } catch {
      return { endpoints: {} };
    }
  }

  scheduleSave(): void {
    clearTimeout(this.saveTimer ?? undefined);
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
  }

  saveNow(): void {
    clearTimeout(this.saveTimer ?? undefined);
    try {
      fs.mkdirSync(LIVE_DIR, { recursive: true });
      const tmp = `${CATALOG_PATH}.tmp`;
      // The catalog holds only endpoint patterns and scrubbed page paths,
      // but it goes through the scrubber anyway, like every recon file.
      this.getScrubber().writeScrubbed(tmp, this.catalog);
      fs.renameSync(tmp, CATALOG_PATH);
    } catch (err: any) {
      this.log(`Live scout: catalog not saved (${err.message})`);
    }
  }

  summary(): { endpoints: number; samples: number } {
    const eps = Object.values(this.catalog.endpoints);
    return { endpoints: eps.length, samples: eps.reduce((n, e) => n + (e.shapes?.length || 0), 0) };
  }

  // entry: { via, method, url, status, body, at } from the injected script
  record(entry: CapturedEntry, pageUrl?: string | null): void {
    let u: URL;
    try {
      u = new URL(entry.url);
    } catch {
      return;
    }
    if (!HUMBLE_HOST.test(u.host) || IGNORED_PATH.test(u.pathname)) return; // third-party analytics, telemetry

    const scrub = this.getScrubber();
    const method = String(entry.method || "GET").toUpperCase();
    const isRsc = entry.kind === "rsc";
    // Collapse ids on the raw URL first (a gamekey segment becomes :id), then
    // scrub the result anyway.
    const where = scrub.scrubText(isRsc ? rscEndpointOf(entry.url) : endpointOf(entry.url));
    const id = entry.action
      ? `ACTION ${entry.action} @ ${where}` // Next.js server action: a mutation, identified by its action id
      : `${method} ${where}${isRsc ? " [rsc]" : ""}`;
    const now = new Date().toISOString();
    const page = pageOf(scrub.scrubText(pageUrl || ""));

    // RSC bodies are React trees, so their "shape" varies with page content.
    // Shape-tracking them would just be noise, so they keep a single latest
    // sample (refreshed every 10 min) instead. JSON keeps per-shape samples.
    const data = isRsc ? flightData(entry.text) : entry.body;
    const shape = isRsc ? "rsc" : shapeOf(data);
    const shapeHash = isRsc ? "rsc" : sha(JSON.stringify(shape)).slice(0, 12);

    let ep = this.catalog.endpoints[id];
    const isNew = !ep;
    if (!ep) {
      ep = this.catalog.endpoints[id] = { count: 0, firstSeen: now, lastSeen: now, statuses: {}, pages: [], shapes: [] };
    }
    ep.count += 1;
    ep.lastSeen = now;
    // Server actions: keep the last few (scrubbed) argument payloads, which
    // vary per call (e.g. page number) and are what's needed to replay one.
    if (entry.action && entry.requestBody != null) {
      let rb = scrub.scrubValue(entry.requestBody);
      if (typeof rb === "string" && rb.length > 4000) rb = `${rb.slice(0, 4000)}…`;
      ep.requestBodies = [...(ep.requestBodies || []).filter((x) => JSON.stringify(x) !== JSON.stringify(rb)), rb].slice(-8);
    }
    ep.statuses[entry.status] = (ep.statuses[entry.status] || 0) + 1;
    if (page && !ep.pages.includes(page)) {
      ep.pages.push(page);
      if (ep.pages.length > MAX_PAGES_PER_ENDPOINT) ep.pages.shift();
    }

    const known = ep.shapes.find((s) => s.hash === shapeHash);
    const stale = known && isRsc && Date.now() - Date.parse((known.sampledAt || known.firstSeen) as string) > STALE_SAMPLE_MS;
    if (known && !stale) {
      known.lastSeen = now;
      known.count = (known.count || 1) + 1;
    } else {
      const file = `${sha(id).slice(0, 10)}-${shapeHash}.json`;
      try {
        fs.mkdirSync(SAMPLES_DIR, { recursive: true });
        let body = scrub.scrubValue(data);
        if (JSON.stringify(body).length > MAX_SAMPLE_BYTES) body = { "<omitted>": "response too large; see shape" };
        scrub.writeScrubbed(path.join(SAMPLES_DIR, file), {
          endpoint: id,
          url: entry.url, // scrubbed by writeScrubbed
          status: entry.status,
          page: pageUrl || null,
          seenAt: now,
          ...(isRsc ? { format: "rsc (decoded rows)", truncated: !!entry.truncated } : { shape }),
          ...(entry.action ? { requestBody: entry.requestBody ?? null } : {}),
          body,
        });
        if (known) {
          known.lastSeen = known.sampledAt = now;
          known.count = (known.count || 1) + 1;
        } else {
          ep.shapes.push({ hash: shapeHash, firstSeen: now, lastSeen: now, sampledAt: now, count: 1, sample: `samples/${file}` });
        }
        if (ep.shapes.length > MAX_SHAPES_PER_ENDPOINT) {
          const dropped = ep.shapes.shift() as ShapeRecord;
          fs.rmSync(path.join(LIVE_DIR, dropped.sample), { force: true });
        }
        if (isNew && entry.action) {
          this.log(`Live scout: NEW SERVER ACTION ${entry.action} on ${where} (${entry.status}): a site mutation; check samples/${file}`);
        } else if (isNew) {
          this.log(`Live scout: new endpoint ${id} (${entry.status})`);
        } else if (!known) {
          this.log(`Live scout: response shape changed for ${id}. New sample saved.`);
        }
      } catch (err: any) {
        if (!this.warned.has(id)) {
          this.warned.add(id);
          this.log(`Live scout: sample for ${id} not saved (${err.message})`);
        }
      }
    }
    this.scheduleSave();
  }
}

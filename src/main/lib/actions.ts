// Registry of Next.js server actions seen on Humble's site.
//
// A server action is called by POSTing to a page with a `Next-Action: <id>`
// header. The id is a build hash, so it changes whenever Humble deploys,
// and hardcoding it would break on their next release. Actions are
// therefore identified by *what they take*: the argument names in their
// request body (e.g. the library action takes query/sort/cursor/page/limit/
// hideRevealed/...). Every action call the page makes is noted here, so
// Humbler always knows the current id for each kind of action.
//
// Stored in data/actions.json (ids, argument names, page path; no values).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

const ACTIONS_PATH = path.join(DATA_DIR, "actions.json");

export interface ActionInfo {
  args: string[];
  page: string;
  firstSeen: string;
  lastSeen: string;
  name?: string; // the action's function name, when known from the site's scripts
}

/** The server no longer knows this action id (Humble deployed a new build). */
export class StaleActionError extends Error {}
export const isStaleActionReply = (status: number, text: string): boolean => (status === 404 || status === 409) && /server action/i.test(text || "");

// Page source (for executeJavaScript): every server action referenced by the
// page's loaded scripts, as {id, name}. Next.js client bundles call
// createServerReference("<id>", callServer, void 0, findSourceMapURL, "<name>").
export const SCAN_ACTIONS_SCRIPT = `
  (async () => {
    const srcs = new Set([...document.scripts].map((s) => s.src).filter(Boolean));
    for (const e of performance.getEntriesByType("resource")) if (/\\.js(\\?|$)/.test(e.name)) srcs.add(e.name);
    const out = [];
    const seen = new Set();
    for (const src of srcs) {
      if (!src.startsWith(location.origin + "/_next/")) continue;
      let text = "";
      try { text = await (await fetch(src)).text(); } catch { continue; }
      const re = /createServerReference\\)?\\(\\s*["']([0-9a-f]{40,})["']([^)]{0,300})\\)/g;
      let m;
      while ((m = re.exec(text))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const names = m[2].match(/["']([A-Za-z_$][\\w$]*)["']/g);
        out.push({ id: m[1], name: names ? names[names.length - 1].slice(1, -1) : null });
      }
    }
    return out;
  })()
`;

interface ActionsFile {
  actions: Record<string, ActionInfo>;
}

// FormData arg names look like "_1_limit"; "0" holds the serialized args.
// requestBody is whatever the injected script captured (untyped page data).
export const argNames = (requestBody: unknown): string[] =>
  Array.isArray(requestBody)
    ? [...new Set(requestBody.map((pair) => (Array.isArray(pair) ? String(pair[0]) : "")).filter((k) => k && k !== "0").map((k) => k.replace(/^_\d+_/, "")))].sort()
    : [];

export class ActionRegistry {
  data: ActionsFile;
  timer: ReturnType<typeof setTimeout> | null;

  constructor() {
    this.data = { actions: {} };
    try {
      this.data = JSON.parse(fs.readFileSync(ACTIONS_PATH, "utf8"));
    } catch {
      // first run
    }
    this.timer = null;
  }

  // entry: a captured response from the injected script ({ action, requestBody, url })
  note(entry: any, pageUrl: string | null | undefined, when: string = new Date().toISOString()): void {
    if (!entry?.action) return;
    const args = argNames(entry.requestBody);
    let page = "";
    try {
      page = new URL(entry.url || pageUrl).pathname;
    } catch {
      // ignore
    }
    const prev: Partial<ActionInfo> = this.data.actions[entry.action] || {};
    this.data.actions[entry.action] = {
      args: args.length ? args : prev.args || [],
      page: page || prev.page || "",
      firstSeen: prev.firstSeen || when,
      lastSeen: when > (prev.lastSeen || "") ? when : (prev.lastSeen as string),
    };
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => this.save(), 1000);
  }

  save(): void {
    clearTimeout(this.timer ?? undefined);
    try {
      fs.mkdirSync(path.dirname(ACTIONS_PATH), { recursive: true });
      fs.writeFileSync(ACTIONS_PATH, JSON.stringify(this.data, null, 2));
    } catch {
      // non-fatal; re-learned on next page visit
    }
  }

  // The most recently seen action taking all of `requiredArgs` (optionally
  // on a page matching `pageRe`).
  find(requiredArgs: string[], pageRe?: RegExp | null): (ActionInfo & { id: string }) | null {
    let best: (ActionInfo & { id: string }) | null = null;
    for (const [id, a] of Object.entries(this.data.actions)) {
      if (!requiredArgs.every((r) => a.args.includes(r))) continue;
      if (pageRe && !pageRe.test(a.page)) continue;
      if (!best || a.lastSeen > best.lastSeen) best = { id, ...a };
    }
    return best;
  }

  // An id the server no longer knows (Humble redeployed): drop it.
  forget(id: string): void {
    delete this.data.actions[id];
    this.save();
  }

  // An action found by scanning the site's scripts and verified by calling it.
  learn(id: string, args: string[], page: string, name?: string | null): void {
    const now = new Date().toISOString();
    this.data.actions[id] = { args, page, firstSeen: now, lastSeen: now, ...(name ? { name } : {}) };
    this.save();
  }

  // Seed from the live-scout catalog (endpoints.json), which already holds
  // scrubbed request bodies for actions seen before this registry existed.
  // catalog: endpoints.json contents (untyped JSON)
  seedFromCatalog(catalog: any): void {
    for (const [key, ep] of Object.entries<any>(catalog?.endpoints || {})) {
      const m = /^ACTION (\S+) @ \S+?(\/\S*)$/.exec(key);
      if (!m) continue;
      for (const rb of ep.requestBodies || []) this.note({ action: m[1], requestBody: rb, url: `https://x${m[2]}` }, null, ep.lastSeen);
    }
  }
}

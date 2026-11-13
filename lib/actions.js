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
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./paths");

const ACTIONS_PATH = path.join(DATA_DIR, "actions.json");

// FormData arg names look like "_1_limit"; "0" holds the serialized args.
const argNames = (requestBody) =>
  Array.isArray(requestBody)
    ? [...new Set(requestBody.map((pair) => (Array.isArray(pair) ? String(pair[0]) : "")).filter((k) => k && k !== "0").map((k) => k.replace(/^_\d+_/, "")))].sort()
    : [];

class ActionRegistry {
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
  note(entry, pageUrl, when = new Date().toISOString()) {
    if (!entry?.action) return;
    const args = argNames(entry.requestBody);
    let page = "";
    try {
      page = new URL(entry.url || pageUrl).pathname;
    } catch {
      // ignore
    }
    const prev = this.data.actions[entry.action] || {};
    this.data.actions[entry.action] = {
      args: args.length ? args : prev.args || [],
      page: page || prev.page || "",
      firstSeen: prev.firstSeen || when,
      lastSeen: when > (prev.lastSeen || "") ? when : prev.lastSeen,
    };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 1000);
  }

  save() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(ACTIONS_PATH), { recursive: true });
      fs.writeFileSync(ACTIONS_PATH, JSON.stringify(this.data, null, 2));
    } catch {
      // non-fatal; re-learned on next page visit
    }
  }

  // The most recently seen action taking all of `requiredArgs` (optionally
  // on a page matching `pageRe`).
  find(requiredArgs, pageRe) {
    let best = null;
    for (const [id, a] of Object.entries(this.data.actions)) {
      if (!requiredArgs.every((r) => a.args.includes(r))) continue;
      if (pageRe && !pageRe.test(a.page)) continue;
      if (!best || a.lastSeen > best.lastSeen) best = { id, ...a };
    }
    return best;
  }

  // Seed from the live-scout catalog (endpoints.json), which already holds
  // scrubbed request bodies for actions seen before this registry existed.
  seedFromCatalog(catalog) {
    for (const [key, ep] of Object.entries(catalog?.endpoints || {})) {
      const m = /^ACTION (\S+) @ \S+?(\/\S*)$/.exec(key);
      if (!m) continue;
      for (const rb of ep.requestBodies || []) this.note({ action: m[1], requestBody: rb, url: `https://x${m[2]}` }, null, ep.lastSeen);
    }
  }
}

module.exports = { ActionRegistry, argNames };

// Scrubbing for everything Humbler writes for debugging: scout dumps
// (data/recon/) and raw page harvests (data/harvest/). Those are meant to be
// looked at and shared, so they must never contain a real key.
//
// Layers, strongest first:
//   1. Exact known secrets. Every key value in your synced orders and in
//      revealed-keys.jsonl is replaced wherever it appears, in any form.
//   2. Sensitive fields. redeemed_key_val, redeem-response `key`, gift links,
//      csrf/session/token fields and so on are redacted by field name,
//      anywhere in the JSON.
//   3. Key-shaped strings (XXXXX-XXXXX-XXXXX and similar), for keys Humbler
//      has never seen.
//   4. Gamekeys (order ids, which open the order via /downloads?key=) and
//      signed-URL tokens. Gamekeys become stable aliases (gamekey#ab12…) so
//      dumps stay correlatable; tokens are redacted outright.
// Finally, assertClean() refuses to let a known secret through if any
// layer above missed it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, ORDERS_DIR, REVEALED_LOG } from "./paths";

export const REDACTED = "[REDACTED]";

// Fields whose values are always secret.
const SECRET_FIELD =
  /^(redeemed_key_val|key_val|keyval|keyformatted|key_formatted|redeemed_key|serial(_number)?|license(_key)?|activation(_code)?|redeem(_code)?|cd_?key|product_key|steam_key|gift_(url|link)|giftlink|password|passwd|secret|.*csrf.*|.*_token|token|access_token|refresh_token|session(_id|_token)?|auth(orization)?|cookie|set-cookie)$/i;
// Fields holding gamekeys (pseudonymized rather than removed).
const GAMEKEY_FIELD = /^(gamekey|gamekeys|order_key|orderkey)$/i;
// A plain `key` field is a secret when its value looks like a key (this
// catches the reveal responses, {success: true, key: "…"}, old and new
// site). Any single token of 6+ characters counts: keys come as
// XXXXX-XXXXX, HUMBLE_ABC123, lowercase codes... Over-redacting a debug dump
// is harmless; leaking a key isn't.
const KEYISH_VALUE = /^[A-Za-z0-9][A-Za-z0-9_\-.~+/=:]{5,}$/;

// Key-shaped substrings: 3+ dash-separated groups of 4-6 caps/digits,
// containing at least one digit (to spare things like WINDOWS-LINUX-MAC).
// Must be a whole token, so it can't match the tail of a longer one such as
// an uppercase UUID.
const KEY_PATTERN = /(?<![A-Za-z0-9-])[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,7}(?![A-Za-z0-9-])/g;

// URL query parameters: gamekeys get aliased (skipping ones already
// aliased), tokens redacted.
const QS_GAMEKEY = /([?&](?:key|gamekey|gamekeys)=)(?!gamekey#)([^&"'\s<>#\\]+)/gi;
// (signed download links: CloudFront, S3, GCS and Akamai token styles)
const QS_TOKEN = /([?&](?:t|ttl|token|sig|signature|auth|hash|expires|policy|key-pair-id|hdnts|gdo|x-(?:amz|goog)-[a-z-]+)=)([^&"'\s<>#\\]+)/gi;
const ORDER_PATH = /(\/api\/v1\/order\/)([A-Za-z0-9]{8,})/g;

// Field names inside text, which the JSON walk can't see: JSON in a <script>,
// Next.js flight data (JSON with escaped quotes inside a JS string), and
// HTML form fields / meta tags such as <input name="csrf_token" value="…">.
const TEXT_JSON_FIELD = /("|\\")([A-Za-z0-9_-]{2,40})\1(\s*:\s*)\1((?:(?!\1)[^\\]|\\(?!")[\s\S])*)\1/g;
const HTML_TAG = /<(input|meta)\b[^>]*>/gi;
const HTML_ATTR = (name: string): RegExp => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");

export const alias = (gamekey: unknown): string => `gamekey#${crypto.createHash("sha256").update(String(gamekey)).digest("hex").slice(0, 10)}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface KnownSecrets {
  keys: string[];
  gamekeys: string[];
}

export interface ScrubStats {
  keys: number;
  fields: number;
  patterns: number;
  gamekeys: number;
  tokens: number;
}

export interface Scrubber {
  scrubText: <T>(s: T) => T;
  scrubValue: (v: any, field?: string) => any;
  assertClean: (text: string, label: string) => void;
  writeScrubbed: (file: string, data: unknown) => void;
  stats: ScrubStats;
}

// Every secret Humbler knows: key values and gamekeys from the order cache,
// plus revealed-keys.jsonl (keys revealed before the cache was refreshed).
export function loadKnownSecrets(): KnownSecrets {
  const keys = new Set<string>();
  const gamekeys = new Set<string>();
  if (fs.existsSync(ORDERS_DIR)) {
    for (const f of fs.readdirSync(ORDERS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), "utf8")); // raw order JSON (untyped)
        if (o.gamekey) gamekeys.add(String(o.gamekey));
        for (const t of o.tpkd_dict?.all_tpks || []) {
          if (t.redeemed_key_val) keys.add(String(t.redeemed_key_val));
          if (t.gamekey) gamekeys.add(String(t.gamekey));
        }
      } catch {
        // unreadable cache file; the pattern layers still apply
      }
    }
  }
  // New-site keys: library-v2.json (item.entitlements.keys[].redemptionData.keyFormatted)
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "library-v2.json"), "utf8"));
    for (const it of cache?.items || []) {
      for (const k of it?.entitlements?.keys || []) {
        const v = k?.redemptionData?.keyFormatted;
        if (typeof v === "string" && v !== "$undefined") keys.add(v);
      }
    }
  } catch {
    // no new-site cache yet
  }
  if (fs.existsSync(REVEALED_LOG)) {
    for (const line of fs.readFileSync(REVEALED_LOG, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.key) keys.add(String(e.key));
        if (e.gamekey) gamekeys.add(String(e.gamekey));
      } catch {
        // skip
      }
    }
  }
  return { keys: [...keys].filter((k) => k.trim().length >= 4), gamekeys: [...gamekeys].filter((g) => g.length >= 6) };
}

export function makeScrubber(known: KnownSecrets = loadKnownSecrets()): Scrubber {
  const stats: ScrubStats = { keys: 0, fields: 0, patterns: 0, gamekeys: 0, tokens: 0 };
  // Longest first, so a key containing another is replaced whole. JSON
  // escaping can turn "/" into "\/" inside HTML-embedded JSON, so match both.
  // One combined pattern: there are thousands of keys, so one pass per text.
  const keyAlts = [...new Set(known.keys.flatMap((k) => [k, k.replace(/\//g, "\\/")]))].sort((a, b) => b.length - a.length).map(escapeRe);
  const keyRes = keyAlts.length ? [new RegExp(keyAlts.join("|"), "g")] : [];
  const gamekeyRes: [RegExp, string][] = known.gamekeys.sort((a, b) => b.length - a.length).map((g) => [new RegExp(escapeRe(g), "g"), alias(g)]);

  // value for a named field found in text: redact, alias, or keep
  function fieldReplacement(name: string, value: string | undefined): string | null {
    if (!value || value === REDACTED || /^gamekey#[0-9a-f]{10}$/.test(value)) return null;
    if (SECRET_FIELD.test(name) || (/^key$/i.test(name) && KEYISH_VALUE.test(value))) {
      stats.fields += 1;
      return REDACTED;
    }
    if (GAMEKEY_FIELD.test(name)) {
      stats.gamekeys += 1;
      return alias(value);
    }
    return null;
  }

  // Strings are scrubbed; anything else (or "") is returned as is.
  function scrubText<T>(s: T): T {
    if (typeof s !== "string" || !s) return s;
    let out: string = s;
    out = out.replace(TEXT_JSON_FIELD, (m, q, name, sep, value) => {
      const r = fieldReplacement(name, value);
      return r == null ? m : `${q}${name}${q}${sep}${q}${r}${q}`;
    });
    out = out.replace(HTML_TAG, (tag) => {
      const name = (HTML_ATTR("name").exec(tag) || HTML_ATTR("id").exec(tag) || [])[0];
      if (!name) return tag;
      const fieldName = name.replace(/^[^=]*=\s*["']?|["']$/g, "");
      for (const attr of ["value", "content"]) {
        const m = HTML_ATTR(attr).exec(tag);
        if (!m) continue;
        const r = fieldReplacement(fieldName, m[2] ?? m[3]);
        if (r != null) tag = tag.replace(m[0], `${attr}="${r}"`);
      }
      return tag;
    });
    for (const re of keyRes) {
      out = out.replace(re, () => {
        stats.keys += 1;
        return REDACTED;
      });
    }
    for (const [re, a] of gamekeyRes) {
      out = out.replace(re, () => {
        stats.gamekeys += 1;
        return a;
      });
    }
    out = out.replace(QS_GAMEKEY, (_m, p, v) => {
      stats.gamekeys += 1;
      return p + alias(decodeURIComponent(v));
    });
    out = out.replace(QS_TOKEN, (_m, p) => {
      stats.tokens += 1;
      return p + REDACTED;
    });
    out = out.replace(ORDER_PATH, (_m, p, v) => {
      stats.gamekeys += 1;
      return p + alias(v);
    });
    out = out.replace(KEY_PATTERN, (m) => {
      if (!/\d/.test(m)) return m;
      stats.patterns += 1;
      return REDACTED;
    });
    return out as T;
  }

  // v: arbitrary JSON (page payloads, request bodies)
  function scrubValue(v: any, field: string = ""): any {
    if (v == null) return v;
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v);
      if (s === REDACTED || /^gamekey#[0-9a-f]{10}$/.test(s)) return v; // already scrubbed
      if (SECRET_FIELD.test(field) && s.trim()) {
        stats.fields += 1;
        return REDACTED;
      }
      if (GAMEKEY_FIELD.test(field) && s.trim()) {
        stats.gamekeys += 1;
        return alias(s);
      }
      if (/^key$/i.test(field) && KEYISH_VALUE.test(s.trim())) {
        stats.fields += 1;
        return REDACTED;
      }
      return typeof v === "string" ? scrubText(v) : v;
    }
    if (Array.isArray(v)) return v.map((x) => scrubValue(x, field));
    if (typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[scrubText(k)] = scrubValue(val, k);
      return out;
    }
    return v;
  }

  // Last line of defence: no known key may survive into a written file.
  function assertClean(text: string, label: string): void {
    for (const k of known.keys) {
      if (text.includes(k)) throw new Error(`scrub failed: a known key survived in ${label}; refusing to write it`);
    }
  }

  // Scrub, verify, then write. data is JSON (object) or text (string).
  function writeScrubbed(file: string, data: unknown): void {
    const text = typeof data === "string" ? scrubText(data) : JSON.stringify(scrubValue(data), null, 2);
    assertClean(text, path.basename(file));
    fs.writeFileSync(file, text);
  }

  return { scrubText, scrubValue, assertClean, writeScrubbed, stats };
}

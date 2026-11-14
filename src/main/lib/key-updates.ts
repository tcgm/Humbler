// Live key updates: pick up keys revealed (or gifted, expired...) on
// Humble's site as it happens, without a full Sync.
//
// Any response the Humble pane receives may carry key objects: the reveal
// itself, the library list refreshing, an item page re-rendering. Key
// objects have a stable `id` (the same id the library cache stores under
// item.entitlements.keys[]) and a `redemptionData`. Matching by id, we copy
// the state fields across into the cached item. Nothing else about the
// item is touched, so a differently shaped response can't corrupt the
// cache.

/** Fields of a 2026-site key object that change when you act on it. */
const KEY_STATE_FIELDS = ["redemptionData", "redeemedAt", "giftStatus", "expired", "outOfStock", "unavailableAfter", "redemptionExpiryDate", "redeemable"] as const;

export interface RevealedKey {
  itemId: string;
  bundleId: string; // productEntitlementId (the purchase)
  keyId: string; // raw site id (index id is `v2|${keyId}`)
  title: string;
  bundle: string;
  keyType: string;
  key: string;
}

export interface KeyUpdateResult {
  changed: boolean; // anything in the cache changed
  revealed: RevealedKey[]; // keys that went from hidden to revealed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

const formatted = (k: Raw): string | null => {
  const v = k?.redemptionData?.keyFormatted;
  return typeof v === "string" && v && v !== "$undefined" ? v : null;
};

const revealedEntry = (item: Raw, key: Raw, value: string): RevealedKey => ({
  itemId: String(item.id),
  bundleId: String(item.productEntitlementId || item.id),
  keyId: String(key.id),
  title: key.title || item.title,
  bundle: item.subTitle && item.subTitle !== "$undefined" ? item.subTitle : item.title,
  keyType: key.keyIntegrationId || key.type || "",
  key: value,
});

/**
 * The 2026 site's reveal is a server action whose arguments are
 * `[id, keyType, …]` (id = the item's / key's id) and whose reply is just
 * `{success: true, key: "…"}`: no key object to match. So match the
 * request's id against the cache and store the reply's key on that key.
 */
export function applyRevealReply(items: Raw[], args: unknown, reply: unknown): KeyUpdateResult {
  const result: KeyUpdateResult = { changed: false, revealed: [] };
  if (!Array.isArray(args)) return result;
  const ids = new Set(args.filter((a): a is string => typeof a === "string" && a.length >= 8));
  if (!ids.size) return result;

  // the reply's {success, key}, wherever it sits in the decoded rows
  let value: string | null = null;
  const seen = new Set<unknown>();
  const find = (v: unknown, depth: number) => {
    if (value || !v || typeof v !== "object" || seen.has(v) || depth > 8) return;
    seen.add(v);
    const o = v as Raw;
    if (o.success === true && typeof o.key === "string" && o.key.trim() && o.key !== "$undefined") {
      value = o.key.trim();
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) find(x, depth + 1);
  };
  find(reply, 0);
  if (!value) return result;

  const typeArg = args.find((a) => typeof a === "string" && !ids.has(a)) as string | undefined;
  for (const item of items) {
    const keys: Raw[] = item?.entitlements?.keys || [];
    // the key itself by id; else the item's only key, or its key of the requested type
    const key =
      keys.find((k) => ids.has(String(k?.id))) ||
      (ids.has(String(item?.id)) ? (keys.length === 1 ? keys[0] : keys.find((k) => typeArg && (k.type === typeArg || k.keyIntegrationId === typeArg))) : undefined);
    if (!key) continue;
    if (formatted(key) === value) return result; // already have it
    const had = formatted(key);
    key.redemptionData = { ...(key.redemptionData && typeof key.redemptionData === "object" ? key.redemptionData : {}), keyFormatted: value };
    result.changed = true;
    if (!had) result.revealed.push(revealedEntry(item, key, value));
    return result;
  }
  return result;
}

/**
 * Apply every known key object found anywhere in `value` (a decoded
 * response) to `items` (the library cache), in place.
 */
export function applyKeyUpdates(items: Raw[], value: unknown): KeyUpdateResult {
  // key id -> where it lives in the cache
  const where = new Map<string, { item: Raw; key: Raw }>();
  for (const item of items) for (const key of item?.entitlements?.keys || []) if (key?.id) where.set(String(key.id), { item, key });
  const result: KeyUpdateResult = { changed: false, revealed: [] };
  if (!where.size) return result;

  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 60) return;
    seen.add(v);
    const o = v as Raw;
    const hit = o.id != null && o.redemptionData && typeof o.redemptionData === "object" ? where.get(String(o.id)) : undefined;
    if (hit && hit.key !== o) {
      const before = formatted(hit.key);
      for (const f of KEY_STATE_FIELDS) {
        if (!(f in o) || o[f] === "$undefined") continue;
        if (JSON.stringify(hit.key[f]) !== JSON.stringify(o[f])) {
          hit.key[f] = o[f];
          result.changed = true;
        }
      }
      const after = formatted(hit.key);
      if (!before && after) result.revealed.push(revealedEntry(hit.item, hit.key, after));
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return result;
}

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
      if (!before && after) {
        result.revealed.push({
          itemId: String(hit.item.id),
          bundleId: String(hit.item.productEntitlementId || hit.item.id),
          keyId: String(o.id),
          title: hit.key.title || hit.item.title,
          bundle: hit.item.subTitle && hit.item.subTitle !== "$undefined" ? hit.item.subTitle : hit.item.title,
          keyType: hit.key.keyIntegrationId || hit.key.type || "",
          key: after,
        });
      }
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return result;
}

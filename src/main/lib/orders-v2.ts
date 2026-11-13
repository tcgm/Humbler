// Your purchases (orders) on the 2026 site. Pages in your library embed a
// paged list of your orders ({ results: [order...], pagination }), and the
// Purchases page pages through all of them. Each order has the purchase
// date and price, plus per line item the bundle's thumbnail/logo and its
// key-redemption deadline (keyExpirationDateTime), which the library list
// itself doesn't carry.
//
// Orders also contain your email, billing address and payment details.
// Only the fields below are ever kept.
//
// data/orders-v2.json: { orders: { <id>: order }, totalDocs, updatedAt }
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import type { Money, Order } from "../../shared/types";

const ORDERS_PATH = path.join(DATA_DIR, "orders-v2.json");

export interface OrdersStore {
  orders: Record<string, Order>;
  totalDocs: number | null;
  updatedAt: string | null;
}

export interface FoundOrders {
  orders: Order[];
  totalDocs: number | null;
}

export function load(): OrdersStore {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  } catch {
    return { orders: {}, totalDocs: null, updatedAt: null };
  }
}

function save(store: OrdersStore): void {
  fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
  const tmp = `${ORDERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, ORDERS_PATH);
}

// Inputs below are raw order data from Humble's pages (untyped).
const localized = (v: any): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" ? v.en || Object.values(v).find((x) => typeof x === "string") || null : null;
const str = (v: any): string | null => (typeof v === "string" && v.trim() && v !== "$undefined" ? v : null);
const money = (p: any): Money | null =>
  p && typeof p.centAmount === "number" ? { amount: p.centAmount / 10 ** (p.fractionDigits ?? 2), currency: p.currencyCode || null } : null;

// The useful, non-personal part of one order.
export function slimOrder(o: any): Order {
  return {
    id: o.id,
    number: str(o.orderNumber),
    createdAt: str(o.createdAt),
    state: str(o.orderState),
    total: money(o.totalPrice),
    items: (o.lineItems || []).map((li: any) => {
      const attrs = Object.fromEntries((li.variant?.attributes || []).filter((a: any) => a && a.name).map((a: any) => [a.name, a.value]));
      return {
        name: localized(li.name),
        productKey: str(li.productKey),
        sku: str(li.variant?.sku),
        thumbnail: str(attrs.thumbnailImageUrl),
        logo: str(attrs.logoImageUrl),
        saleStart: str(attrs.startDateTime),
        saleEnd: str(attrs.endDateTime),
        keyExpiration: str(attrs.keyExpirationDateTime),
        price: money(li.totalPrice || li.price?.value),
      };
    }),
  };
}

// Find order containers anywhere in a decoded value.
export function extractOrders(value: unknown): FoundOrders {
  const out: FoundOrders = { orders: [], totalDocs: null };
  const seen = new Set<object>();
  const walk = (v: any): void => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v.results) && v.results.some((r: any) => r && r.type === "Order" && Array.isArray(r.lineItems))) {
      for (const r of v.results) if (r && r.type === "Order" && r.id) out.orders.push(slimOrder(r));
      if (typeof v.pagination?.totalDocs === "number") out.totalDocs = v.pagination.totalDocs;
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(value);
  return out;
}

// Merge newly seen orders; returns how many were new.
export function merge(found: FoundOrders): number {
  if (!found.orders.length) return 0;
  const store = load();
  let added = 0;
  for (const o of found.orders) {
    if (!store.orders[o.id]) added += 1;
    store.orders[o.id] = o;
  }
  if (found.totalDocs != null) store.totalDocs = found.totalDocs;
  store.updatedAt = new Date().toISOString();
  save(store);
  return added;
}

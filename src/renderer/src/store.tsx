// App-wide state, fed by the main process over the typed IPC API.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChoiceMonth, DownloadProgress, KeyEntry, LibraryIndex, Money, OrderItem, Status, Theme } from "@shared/types";
import { normTitle } from "./util";

const api = window.humbler;

export type TabId = "keys" | "bundles" | "choice" | "files" | "library" | "log";

interface Nav {
  tab: TabId;
  bundleId: string | null;
  choiceMonth: string | null;
}

const isNav = (s: unknown): s is Nav => !!s && typeof s === "object" && typeof (s as Nav).tab === "string";

export interface OrderInfo extends OrderItem {
  createdAt: string | null;
  total: Money | null;
}

interface PendingRedeem {
  id: string;
  name: string;
  platform: string;
  at: number;
}

interface Store {
  lib: LibraryIndex;
  status: Status | null;
  progress: Record<string, DownloadProgress>;
  logs: string[];
  orders: Map<string, OrderInfo>; // by normalised bundle name
  ordersTotal: number | null;
  choiceMonths: ChoiceMonth[];
  owned: Set<string>; // normalised titles of everything you own
  busy: boolean;

  tab: TabId;
  setTab(tab: TabId): void;
  openBundle(id: string | null): void;
  bundleId: string | null;
  openChoiceMonth(month: string | null): void;
  choiceMonth: string | null;

  theme: Theme;
  toggleTheme(): void;

  beginRedeem(k: KeyEntry, platformName: string, url: string): void;
  redeemQuestion: PendingRedeem | null;
  answerRedeem(redeemed: boolean): void;
  setRedeemed(id: string, redeemed: boolean, platform?: string | null): Promise<void>;
}

const EMPTY: LibraryIndex = { bundles: [], keys: [], files: [], products: [], choiceGroups: [] };
const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside <StoreProvider>");
  return s;
}

/** Orders keyed by bundle name: thumbnail, purchase date/price, key deadline. */
function indexOrders(orders: Awaited<ReturnType<typeof api.getOrders>>["orders"]): Map<string, OrderInfo> {
  const map = new Map<string, OrderInfo>();
  for (const o of orders) {
    for (const it of o.items || []) {
      if (!it.name) continue;
      const k = normTitle(it.name);
      const prev = map.get(k);
      // What you paid: the order total when the order is just this bundle
      // (the line-item price leaves out part of it), else the line's price.
      const paid = (o.items.length === 1 ? o.total : it.price) || o.total;
      // keep the earliest purchase of a bundle bought more than once
      if (!prev || (o.createdAt && prev.createdAt && o.createdAt < prev.createdAt)) map.set(k, { ...it, createdAt: o.createdAt, total: paid });
    }
  }
  return map;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [lib, setLib] = useState<LibraryIndex>(EMPTY);
  const [status, setStatus] = useState<Status | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [orders, setOrders] = useState<Map<string, OrderInfo>>(new Map());
  const [ordersTotal, setOrdersTotal] = useState<number | null>(null);
  const [choiceMonths, setChoiceMonths] = useState<ChoiceMonth[]>([]);
  // Where you are: tab + open bundle page + open Choice month. Every change
  // is a browser-history entry, so back/forward (mouse buttons 4/5,
  // Alt+←/→) step through it like a website.
  const [nav, setNav] = useState<Nav>(() => (isNav(history.state) ? history.state : { tab: "keys", bundleId: null, choiceMonth: null }));
  const navRef = useRef(nav);
  navRef.current = nav;
  const navigate = useCallback((patch: Partial<Nav>) => {
    const next = { ...navRef.current, ...patch };
    const cur = navRef.current;
    if (next.tab === cur.tab && next.bundleId === cur.bundleId && next.choiceMonth === cur.choiceMonth) return; // no-op: no history entry
    history.pushState(next, "");
    navRef.current = next;
    setNav(next);
  }, []);
  useEffect(() => {
    history.replaceState(navRef.current, ""); // the starting point back can return to
    const onPop = (e: PopStateEvent) => {
      if (isNav(e.state)) setNav(e.state);
    };
    // Mouse buttons 4/5 (back/forward) and Alt+←/→, anywhere in the UI.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        if (e.button === 3) history.back();
        else history.forward();
      }
    };
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault(); // no stray default action on press
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        history.back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        history.forward();
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("mousedown", swallow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("mousedown", swallow);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const { tab, bundleId, choiceMonth } = nav;
  const [theme, setTheme] = useState<Theme>("dark");
  const [redeemQuestion, setRedeemQuestion] = useState<PendingRedeem | null>(null);
  const pendingRedeem = useRef<PendingRedeem | null>(null);

  const loadLibrary = useCallback(async () => setLib(await api.getLibrary()), []);
  const loadOrders = useCallback(async () => {
    const { orders: list, totalDocs } = await api.getOrders();
    setOrders(indexOrders(list));
    setOrdersTotal(totalDocs);
  }, []);
  const loadChoice = useCallback(async () => setChoiceMonths(await api.getChoice()), []);

  useEffect(() => {
    // Download progress arrives fast; batch it into one render per 250 ms.
    let batch: Record<string, DownloadProgress> = {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const b = batch;
      batch = {};
      setProgress((prev) => ({ ...prev, ...b }));
      if (Object.values(b).some((p) => p.state === "done")) {
        setLib((l) => ({ ...l, files: l.files.map((f) => (b[f.id]?.state === "done" ? { ...f, downloaded: true } : f)) }));
      }
    };

    // Log: subscribe first, then backfill, so nothing falls in the gap.
    const early: string[] = [];
    let backfilled = false;
    const unsubs = [
      api.onLog((line) => (backfilled ? setLogs((l) => [...l.slice(-2999), line]) : early.push(line))),
      api.onStatus((s) => {
        setStatus(s);
        setTheme(s.theme === "light" ? "light" : "dark");
      }),
      api.onLibraryUpdated(() => {
        loadLibrary();
        loadOrders();
        loadChoice();
      }),
      api.onKeyUpdated(({ id, key }) => {
        if (!key) return;
        setLib((l) => ({ ...l, keys: l.keys.map((k) => (k.id === id ? { ...k, key, status: "revealed" } : k)) }));
      }),
      api.onDownloadProgress((p) => {
        batch[p.id] = p;
        if (!timer) timer = setTimeout(flush, 250);
      }),
      api.onChoiceUpdated(() => loadChoice()),
      api.onOrdersUpdated(() => loadOrders()),
      // Back from a Redeem link in the browser: ask whether it worked.
      api.onAppFocus(() => {
        const p = pendingRedeem.current;
        if (p && Date.now() - p.at >= 1500) setRedeemQuestion(p); // ignore focus flicker while the browser opens
      }),
    ];
    api.getLogHistory().then((history) => {
      const seen = new Set(history);
      setLogs([...history, ...early.filter((l) => !seen.has(l))].slice(-3000));
      backfilled = true;
    });
    loadLibrary();
    loadOrders();
    loadChoice();
    api.requestStatus();
    return () => {
      unsubs.forEach((u) => u());
      if (timer) clearTimeout(timer);
    };
  }, [loadLibrary, loadOrders, loadChoice]);

  // Dark by default; the html attribute drives every themed colour.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const owned = useMemo(() => new Set([...lib.keys.map((k) => normTitle(k.name)), ...lib.products.map((p) => normTitle(p.title))]), [lib]);

  const store: Store = {
    lib,
    status,
    progress,
    logs,
    orders,
    ordersTotal,
    choiceMonths,
    owned,
    busy: !!status?.busy,
    tab,
    setTab: (t) => navigate({ tab: t }),
    bundleId,
    openBundle: (id) => navigate(id ? { tab: "bundles", bundleId: id } : { bundleId: null }),
    choiceMonth,
    openChoiceMonth: (m) => navigate(m ? { tab: "choice", choiceMonth: m } : { choiceMonth: null }),
    theme,
    toggleTheme: () => {
      const next = theme === "dark" ? "light" : "dark";
      setTheme(next); // immediately, then persist
      api.setSettings({ theme: next });
    },
    beginRedeem: (k, platformName, url) => {
      pendingRedeem.current = { id: k.id, name: k.name, platform: platformName, at: Date.now() };
      api.openUrl(url);
    },
    redeemQuestion,
    answerRedeem: (redeemed) => {
      const p = pendingRedeem.current;
      pendingRedeem.current = null;
      setRedeemQuestion(null);
      if (p && redeemed) void store.setRedeemed(p.id, true, p.platform);
    },
    setRedeemed: async (id, redeemed, platform) => {
      const rec = await api.markRedeemed(id, redeemed, platform);
      setLib((l) => ({ ...l, keys: l.keys.map((k) => (k.id === id ? { ...k, platformRedeemed: redeemed ? rec : null } : k)) }));
    },
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export { api };

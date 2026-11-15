// Download queue: resumable (.part + HTTP Range), hash-verified (md5/sha1
// from Humble's metadata), a little concurrency, and polite pauses between
// files. Humble's download URLs are signed and expire, so URLs come from a
// resolver supplied by main.js that re-fetches the order when needed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ClientRequest, Session } from "electron";
import { openRequest, header } from "./http";
import { politeDelay } from "./throttle";
import { verifyZip } from "./zip-verify";
import type { DownloadPhase, DownloadProgress } from "../../shared/types";

const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);

export interface DownloadItem {
  id: string;
  url?: string | null;
  abs: string;
  size?: number;
  md5?: string | null;
  sha1?: string | null;
  gamekey?: string;
  label?: string;
  [extra: string]: unknown;
}

export type ResolveUrl<T extends DownloadItem = DownloadItem> = (item: T, opts: { force: boolean }) => Promise<string>;

export interface DownloaderOptions<T extends DownloadItem = DownloadItem> {
  getSession: () => Session;
  resolveUrl: ResolveUrl<T>;
  concurrency?: number;
  delayMin?: number;
  delayMax?: number;
}

interface Ctx {
  cancelled: boolean;
  req: ClientRequest | null;
}

function hashFileInto(file: string, hash: crypto.Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", resolve)
      .on("error", reject);
  });
}

class CancelledError extends Error {}

// Generic over the queued item type, so callers can carry their own fields
// (label, ids for refreshing links) through to resolveUrl and the events.
export class Downloader<T extends DownloadItem = DownloadItem> extends EventEmitter {
  getSession: () => Session;
  resolveUrl: ResolveUrl<T>;
  concurrency: number;
  delayMin: number;
  delayMax: number;
  queue: T[];
  active: Map<string, Ctx>;

  constructor({ getSession, resolveUrl, concurrency = 2, delayMin = 500, delayMax = 1500 }: DownloaderOptions<T>) {
    super();
    this.getSession = getSession;
    this.resolveUrl = resolveUrl; // async (item, { force }) => url
    this.concurrency = Math.max(1, concurrency);
    this.delayMin = delayMin;
    this.delayMax = delayMax;
    this.queue = [];
    this.active = new Map(); // id -> ctx
  }

  has(id: string): boolean {
    return this.active.has(id) || this.queue.some((q) => q.id === id);
  }

  // items: { id, url, abs, size, md5, sha1, gamekey, label }
  enqueue(items: T[]): number {
    let added = 0;
    for (const item of items) {
      if (this.has(item.id)) continue;
      this.queue.push(item);
      this.emit("progress", { id: item.id, state: "queued" });
      added += 1;
    }
    this.pump();
    return added;
  }

  cancelAll(): void {
    for (const item of this.queue) this.emit("progress", { id: item.id, state: "cancelled" });
    this.queue = [];
    for (const ctx of this.active.values()) {
      ctx.cancelled = true;
      try {
        ctx.req?.abort();
      } catch {
        // already finished
      }
    }
  }

  summary(): { queued: number; active: number } {
    return { queued: this.queue.length, active: this.active.size };
  }

  pump(): void {
    while (this.active.size < this.concurrency && this.queue.length) {
      const item = this.queue.shift() as T;
      const ctx: Ctx = { cancelled: false, req: null };
      this.active.set(item.id, ctx);
      this.runOne(item, ctx);
    }
    if (!this.active.size && !this.queue.length) this.emit("idle");
  }

  async runOne(item: T, ctx: Ctx): Promise<void> {
    try {
      const skipped = await this.download(item, ctx, false);
      this.emit("progress", { id: item.id, state: "done", skipped, warning: (item as T & { warning?: string }).warning });
      this.emit("completed", item, { skipped });
    } catch (err: any) {
      const cancelled = ctx.cancelled || err instanceof CancelledError;
      this.emit("progress", {
        id: item.id,
        state: cancelled ? "cancelled" : "error",
        error: cancelled ? undefined : err.message,
      });
      if (!cancelled) this.emit("failed", item, err);
    } finally {
      this.active.delete(item.id);
      if (!ctx.cancelled) await politeDelay(this.delayMin, this.delayMax);
      this.pump();
    }
  }

  // Returns true if the file was already complete on disk.
  async download(item: T, ctx: Ctx, retried: boolean): Promise<boolean> {
    const dest = item.abs;
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      if (!item.size || size === item.size) return true;
    }

    const say = (phase: DownloadPhase, more: Partial<DownloadProgress> = {}) =>
      this.emit("progress", { id: item.id, state: "downloading", phase, total: item.size || undefined, ...more });
    say("link");
    const url = await this.resolveUrl(item, { force: retried });
    if (ctx.cancelled) throw new CancelledError();

    let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (item.size && start > item.size) {
      fs.rmSync(part, { force: true });
      start = 0;
    }

    const algo = item.md5 ? "md5" : item.sha1 ? "sha1" : null;
    let expected = (item.md5 || item.sha1 || "").toLowerCase();
    let hash = algo ? crypto.createHash(algo) : null;
    if (hash && start > 0) {
      say("resuming", { received: start });
      await hashFileInto(part, hash);
    }
    say("connecting", { received: start });

    const { req, res } = await openRequest(this.getSession(), {
      url,
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    });
    ctx.req = req;
    // Electron's IncomingMessage is a Node Readable at runtime, but its
    // typings don't declare resume()/pipe(); view it as one.
    const body = res as unknown as Readable;
    if (ctx.cancelled) {
      req.abort();
      throw new CancelledError();
    }

    const status = res.statusCode;
    if (EXPIRED_STATUSES.has(status) && !retried) {
      body.resume();
      return this.download(item, ctx, true); // fresh signed URL, once
    }

    let append = false;
    if (status === 416 && start > 0) {
      // Server says the range is past the end: the .part is already complete.
      body.resume();
      return this.finalize(item, part, dest, hash, expected);
    } else if (status === 206) {
      append = true;
    } else if (status === 200) {
      if (start > 0) {
        start = 0; // server ignored Range, so start over
        hash = algo ? crypto.createHash(algo) : null;
      }
    } else {
      body.resume();
      throw new Error(`HTTP ${status}`);
    }

    const len = Number(header(res, "content-length")) || 0;
    const rangeTotal = Number(/\/(\d+)\s*$/.exec(header(res, "content-range") || "")?.[1]) || 0;
    const total = rangeTotal || (len ? len + start : item.size || 0);
    // Humble sometimes updates a file on its CDN without updating the listed
    // size and checksum: then the listed checksum is for another version and
    // can't be checked against. The file is checked for completeness instead.
    if (item.size && total && total !== item.size) {
      this.emit("listing-stale", item, { listedSize: item.size, servedSize: total });
      expected = "";
    }
    let received = start;
    let lastEmit = 0;
    // speed over a sliding window of the last ~5 s of samples
    const samples: [number, number][] = [[Date.now(), start]];
    say("receiving", { received, total });
    res.on("data", (chunk: Buffer) => {
      hash?.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        samples.push([now, received]);
        while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
        const [t0, r0] = samples[0];
        const speed = now > t0 ? ((received - r0) * 1000) / (now - t0) : undefined;
        say("receiving", { received, total, speed });
      }
    });

    const aborted = new Promise<never>((_, reject) =>
      res.on("aborted", () => reject(ctx.cancelled ? new CancelledError() : new Error("connection aborted"))),
    );
    aborted.catch(() => {});
    await Promise.race([pipeline(body, fs.createWriteStream(part, { flags: append ? "a" : "w" })), aborted]);
    if (ctx.cancelled) throw new CancelledError();

    if (total && received < total) throw new Error(`incomplete: ${received}/${total} bytes (will resume)`);
    return this.finalize(item, part, dest, hash, expected);
  }

  async finalize(item: T, part: string, dest: string, hash: crypto.Hash | null, expected: string): Promise<boolean> {
    const actual = hash ? hash.digest("hex") : null;
    const isZip = /\.zip$/i.test(dest);
    const fail = (why: string): never => {
      fs.rmSync(part, { force: true });
      throw new Error(`${why}; partial file deleted`);
    };
    // Humble's listed checksum is checked first. A mismatch keeps the file
    // with a warning: Humble re-uploads files without updating its listing,
    // so a mismatch usually means a newer file, not a broken one. A zip is
    // then checked entry by entry, and only an archive that is provably
    // broken is deleted (it's useless, and a retry fetches a clean copy).
    if (expected ? actual !== expected : isZip) {
      let zipNote = "";
      if (isZip) {
        this.emit("progress", { id: item.id, state: "downloading", phase: "verifying", received: item.size || undefined, total: item.size || undefined });
        const check = await verifyZip(part);
        if (check.ok === false) fail(`${expected ? `checksum mismatch (expected ${expected}, got ${actual}), and ` : ""}the archive is broken: ${check.problem}`);
        zipNote = check.ok ? `all ${check.entries} entries of the archive check out` : `the archive couldn't be checked (${check.problem})`;
      }
      if (expected) {
        const warning = `Humble lists checksum ${expected}, the file it sent has ${actual}${zipNote ? `; ${zipNote}` : ""}`;
        (item as T & { warning?: string }).warning = warning;
        this.emit("checksum-stale", item, { warning, zipOk: zipNote.startsWith("all") });
      }
    }
    // what was actually saved, for the download record
    const saved = fs.statSync(part).size;
    if (actual) this.emit("saved-as", item, { size: saved, [item.md5 ? "md5" : "sha1"]: actual });
    // A different file already there (an older version, or someone else's
    // copy): never delete it. Move it aside as "<name> (older <date>).<ext>".
    if (fs.existsSync(dest)) {
      const old = fs.statSync(dest);
      const ext = path.extname(dest);
      const stem = dest.slice(0, dest.length - ext.length);
      const day = old.mtime.toISOString().slice(0, 10);
      let aside = `${stem} (older ${day})${ext}`;
      for (let i = 2; fs.existsSync(aside); i++) aside = `${stem} (older ${day}, ${i})${ext}`;
      fs.renameSync(dest, aside);
      this.emit("kept-older", item, aside);
    }
    fs.renameSync(part, dest);
    return false;
  }
}

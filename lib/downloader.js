// Download queue: resumable (.part + HTTP Range), hash-verified (md5/sha1
// from Humble's metadata), a little concurrency, and polite pauses between
// files. Humble's download URLs are signed and expire, so URLs come from a
// resolver supplied by main.js that re-fetches the order when needed.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { EventEmitter } = require("node:events");
const { openRequest, header } = require("./http");
const { politeDelay } = require("./throttle");

const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);

function hashFileInto(file, hash) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", resolve)
      .on("error", reject);
  });
}

class CancelledError extends Error {}

class Downloader extends EventEmitter {
  constructor({ getSession, resolveUrl, concurrency = 2, delayMin = 500, delayMax = 1500 }) {
    super();
    this.getSession = getSession;
    this.resolveUrl = resolveUrl; // async (item, { force }) => url
    this.concurrency = Math.max(1, concurrency);
    this.delayMin = delayMin;
    this.delayMax = delayMax;
    this.queue = [];
    this.active = new Map(); // id -> ctx
  }

  has(id) {
    return this.active.has(id) || this.queue.some((q) => q.id === id);
  }

  // items: { id, url, abs, size, md5, sha1, gamekey, label }
  enqueue(items) {
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

  cancelAll() {
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

  summary() {
    return { queued: this.queue.length, active: this.active.size };
  }

  pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      const ctx = { cancelled: false, req: null };
      this.active.set(item.id, ctx);
      this.runOne(item, ctx);
    }
    if (!this.active.size && !this.queue.length) this.emit("idle");
  }

  async runOne(item, ctx) {
    try {
      const skipped = await this.download(item, ctx, false);
      this.emit("progress", { id: item.id, state: "done", skipped });
      this.emit("completed", item, { skipped });
    } catch (err) {
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
  async download(item, ctx, retried) {
    const dest = item.abs;
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      if (!item.size || size === item.size) return true;
    }

    const url = await this.resolveUrl(item, { force: retried });
    if (ctx.cancelled) throw new CancelledError();

    let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (item.size && start > item.size) {
      fs.rmSync(part, { force: true });
      start = 0;
    }

    const algo = item.md5 ? "md5" : item.sha1 ? "sha1" : null;
    const expected = (item.md5 || item.sha1 || "").toLowerCase();
    let hash = algo ? crypto.createHash(algo) : null;
    if (hash && start > 0) await hashFileInto(part, hash);

    const { req, res } = await openRequest(this.getSession(), {
      url,
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    });
    ctx.req = req;
    if (ctx.cancelled) {
      req.abort();
      throw new CancelledError();
    }

    const status = res.statusCode;
    if (EXPIRED_STATUSES.has(status) && !retried) {
      res.resume();
      return this.download(item, ctx, true); // fresh signed URL, once
    }

    let append = false;
    if (status === 416 && start > 0) {
      // Server says the range is past the end: the .part is already complete.
      res.resume();
      return this.finalize(item, part, dest, hash, expected);
    } else if (status === 206) {
      append = true;
    } else if (status === 200) {
      if (start > 0) {
        start = 0; // server ignored Range — start over
        hash = algo ? crypto.createHash(algo) : null;
      }
    } else {
      res.resume();
      throw new Error(`HTTP ${status}`);
    }

    const len = Number(header(res, "content-length")) || 0;
    const total = len ? len + start : item.size || 0;
    let received = start;
    let lastEmit = 0;
    res.on("data", (chunk) => {
      hash?.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        this.emit("progress", { id: item.id, state: "downloading", received, total });
      }
    });

    const aborted = new Promise((_, reject) =>
      res.on("aborted", () => reject(ctx.cancelled ? new CancelledError() : new Error("connection aborted"))),
    );
    aborted.catch(() => {});
    await Promise.race([pipeline(res, fs.createWriteStream(part, { flags: append ? "a" : "w" })), aborted]);
    if (ctx.cancelled) throw new CancelledError();

    if (total && received < total) throw new Error(`incomplete: ${received}/${total} bytes (will resume)`);
    return this.finalize(item, part, dest, hash, expected);
  }

  finalize(item, part, dest, hash, expected) {
    if (hash) {
      const actual = hash.digest("hex");
      if (actual !== expected) {
        fs.rmSync(part, { force: true });
        throw new Error(`checksum mismatch (expected ${expected}, got ${actual}) — partial file deleted`);
      }
    }
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return false;
  }
}

module.exports = { Downloader };

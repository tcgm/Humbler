// Checks a zip entry by entry: every file in it is decompressed and its CRC-32
// compared with the one the archive stores. Used when Humble's listed
// checksum doesn't match what its server sends (Humble re-uploads files
// without updating the listing): an archive whose every entry checks out is
// whole and uncorrupted, whatever the listing says.

import fs from "node:fs";
import zlib from "node:zlib";

export interface ZipCheck {
  /** true: every entry checks out; false: something is broken; null: can't tell (method not supported, encrypted) */
  ok: boolean | null;
  entries: number;
  problem?: string;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

// zlib.crc32 where Node has it (22.2+), else a table.
const crc32 = (buf: Buffer, prev: number): number => {
  const native = (zlib as unknown as { crc32?: (b: Buffer, v?: number) => number }).crc32;
  if (native) return native(buf, prev);
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

interface Entry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  local: number;
}

function centralDirectory(fd: number, size: number): Entry[] {
  // end of central directory: in the last 64 KB + 22 bytes
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
  if (eocd < 0) throw new Error("no end-of-archive record (incomplete or not a zip)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  // zip64: the locator sits just before the EOCD
  if ((count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const rec = readAt(fd, Number(tail.readBigUInt64LE(eocd - 12)), 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("broken zip64 end-of-archive record");
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOff = Number(rec.readBigUInt64LE(48));
  }
  if (cdOff + cdSize > size) throw new Error("the archive's directory points past the end of the file");
  const cd = readAt(fd, cdOff, cdSize);
  const out: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`broken directory entry #${i + 1}`);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const name = cd.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    // zip64 extra field: the 0xffffffff values, in order
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) (usize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    out.push({ name, method, flags, crc, csize, usize, local });
    p = end + commentLen;
  }
  return out;
}

async function entryCrc(file: string, start: number, e: Entry): Promise<{ crc: number; size: number }> {
  let crc = 0;
  let size = 0;
  if (e.csize === 0) return { crc, size };
  const src = fs.createReadStream(file, { start, end: start + e.csize - 1, highWaterMark: 1 << 20 });
  const stream = e.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
  if (e.method === 8) src.on("error", (err) => stream.destroy(err));
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc: crc >>> 0, size };
}

/** Check every entry of the zip at `file`. */
export async function verifyZip(file: string, onEntry?: (done: number, total: number) => void): Promise<ZipCheck> {
  const fd = fs.openSync(file, "r");
  let entries: Entry[];
  try {
    entries = centralDirectory(fd, fs.fstatSync(fd).size);
  } catch (err) {
    fs.closeSync(fd);
    return { ok: false, entries: 0, problem: (err as Error).message };
  }
  try {
    let i = 0;
    for (const e of entries) {
      onEntry?.(i++, entries.length);
      if (e.name.endsWith("/") && e.usize === 0) continue; // a folder
      if (e.flags & 1) return { ok: null, entries: entries.length, problem: `"${e.name}" is encrypted` };
      if (e.method !== 0 && e.method !== 8) return { ok: null, entries: entries.length, problem: `"${e.name}" uses compression method ${e.method}` };
      const lh = readAt(fd, e.local, 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return { ok: false, entries: entries.length, problem: `"${e.name}": its data isn't where the directory says` };
      const start = e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let got: { crc: number; size: number };
      try {
        got = await entryCrc(file, start, e);
      } catch (err) {
        return { ok: false, entries: entries.length, problem: `"${e.name}": ${(err as Error).message}` };
      }
      if (got.size !== e.usize || got.crc !== e.crc) return { ok: false, entries: entries.length, problem: `"${e.name}" is corrupt (CRC or size doesn't match)` };
    }
    return { ok: true, entries: entries.length };
  } finally {
    fs.closeSync(fd);
  }
}

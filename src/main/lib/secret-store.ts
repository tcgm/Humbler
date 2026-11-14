// Key values at rest are sealed with the operating system's per-user
// encryption (Electron safeStorage: DPAPI on Windows, Keychain on macOS,
// the secret service on Linux). Only Humbler, running as you, can open
// them; a copy of data/ (a backup, a sync folder) shows "sealed1:…" instead
// of keys. Everything else in the files stays plain JSON.
//
// This module has no Electron import: main hands it a cipher at startup
// (setCipher). Without one (tests, scripts) sealed values can't be opened
// and come back as null, and nothing gets sealed.

export const SEALED = "sealed1:";

export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

let cipher: Cipher | null = null;
const openedOf = new Map<string, string>(); // sealed -> plain
const sealedOf = new Map<string, string>(); // plain -> sealed (keeps files stable between saves)
let unopenable = 0;

export function setCipher(c: Cipher | null): void {
  cipher = c;
}

export const canSeal = (): boolean => !!cipher;

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(SEALED);

/** Seal a key value for writing to disk. Markers like "$undefined" and empty values pass through. */
export function seal(v: string): string {
  if (!cipher || !v || v.startsWith(SEALED) || v.startsWith("$")) return v;
  let s = sealedOf.get(v);
  if (!s) {
    s = SEALED + cipher.encrypt(v).toString("base64");
    sealedOf.set(v, s);
    openedOf.set(s, v);
  }
  return s;
}

/** Open a value read from disk. Plain values pass through; a sealed value
 *  that can't be opened (another account or PC, or no cipher) is null. */
export function open<T>(v: T): T | string | null {
  if (!isSealed(v)) return v;
  let o = openedOf.get(v);
  if (o === undefined) {
    if (!cipher) return null;
    try {
      o = cipher.decrypt(Buffer.from(v.slice(SEALED.length), "base64"));
    } catch {
      unopenable += 1;
      return null;
    }
    openedOf.set(v, o);
    sealedOf.set(o, v);
  }
  return o;
}

/** How many sealed values couldn't be opened since the last call. */
export function takeUnopenable(): number {
  const n = unopenable;
  unopenable = 0;
  return n;
}

// Thin wrappers over Electron's `net` module, bound to the Humble session
// partition so every request carries your real login cookies and the same
// user agent as the browser pane (which matters for Cloudflare).
import { net } from "electron";
import type { ClientRequest, IncomingMessage, Session } from "electron";

export interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface TextResponse {
  status: number;
  contentType: string;
  text: string;
}

export function header(res: IncomingMessage, name: string): string {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v || "";
}

// Resolves once response headers arrive; caller consumes `res` (a Readable).
export function openRequest(
  ses: Session,
  { url, method = "GET", headers = {}, body }: RequestOptions = {} as RequestOptions,
): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, session: ses, useSessionCookies: true, redirect: "follow" });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on("response", (res) => resolve({ req, res }));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function fetchText(ses: Session, opts: RequestOptions): Promise<TextResponse> {
  const { res } = await openRequest(ses, opts);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", resolve);
    res.on("error", reject);
    res.on("aborted", () => reject(new Error("request aborted")));
  });
  return {
    status: res.statusCode,
    contentType: header(res, "content-type"),
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Small HTTP helpers shared by the app listeners: responses in the API's error shape, cookie parsing and
 * serialisation, bounded body readers, and the client address recorded on `auth_failure` entries.
 */

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_TYPE, ...headers } });
}

/** `{ error: { code, message } }` — the API's error envelope. */
export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": HTML_TYPE, ...headers } });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

export function notFound(): Response {
  return errorJson(404, "NOT_FOUND", "not found");
}

/** An error a handler can throw to answer with a specific status and error code; the listeners render it. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }

  toResponse(): Response {
    return errorJson(this.status, this.code, this.message);
  }
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** `Cookie` header → name → value (split on `;`, each pair at its first `=`, trimmed; values are not decoded). */
export function parseCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.get("cookie");
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "") out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number; // seconds; 0 clears
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

const COOKIE_NAME = /^[A-Za-z0-9_-]+$/;
const COOKIE_VALUE_FORBIDDEN = /[\x00-\x20\x7f";,\\]/; // RFC 6265 cookie-octet complement

/** A `Set-Cookie` header value. Values must already be cookie-safe (ours are base64url tokens). */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name) || COOKIE_VALUE_FORBIDDEN.test(value)) throw new TypeError("cookie: invalid name or value");
  const parts = [`${name}=${value}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path !== undefined) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

const tooLarge = (maxBytes: number) => new HttpError(413, "TOO_LARGE", `body exceeds ${maxBytes} bytes`);

/** The whole body as text, refusing (413) as soon as it exceeds `maxBytes` — the funnel is a public listener. */
async function readBody(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** JSON body → value; malformed JSON → HttpError 400 VALIDATION; over `maxBytes` → HttpError 413. */
export async function readJson(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const text = await readBody(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "VALIDATION", "body must be valid JSON");
  }
}

/** `application/x-www-form-urlencoded` body → URLSearchParams (Ko-fi webhooks, OAuth forms). */
export async function readForm(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req, maxBytes));
}

/**
 * The client address for audit entries: the LAST `X-Forwarded-For` hop — the one the trusted funnel proxy appended
 * (anything before it is whatever the client chose to send; the TCP peer of both app listeners is always loopback),
 * else `X-Real-IP`, else "unknown". Informational only — roles never key on it.
 */
export function clientIp(req: Request): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter((hop) => hop !== "");
  if (hops.length > 0) return hops[hops.length - 1]!;
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

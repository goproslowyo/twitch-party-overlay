/**
 * Roles, sessions and CSRF. The role is decided by which listener a request arrived on plus the
 * `tpo_session` cookie — never by remote IP (funnel traffic arrives looking like loopback): the streamer listener is
 * Streamer for every request (acting as the linked broadcaster once there is one); the funnel needs a valid signed session. Session and OAuth cookies share one scheme:
 * `base64url(JSON payload) + "." + base64url(HMAC-SHA256(SESSION_SECRET, payloadB64))`, verified in constant time —
 * and one key, so every payload carries the signer's `kind` ("session" | "oauth") and a verifier only accepts its own:
 * an OAuth ticket can never pass as a session, nor a session as a ticket.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Secrets } from "../config/secrets.ts";
import { errorJson, parseCookies, serializeCookie } from "./http-util.ts";

export type AppListener = "streamer" | "funnel";
export type Role = "streamer" | "mod";

export interface Principal {
  role: Role;
  actor: string; // the actor string: "twitch:<login>" (a session, or the streamer listener once the broadcaster is linked), else "streamer@local"
  login: string | null;
}

export interface SessionPayload {
  uid: string; // Twitch user id
  login: string;
  role: Role;
  exp: number; // epoch milliseconds
}

/** Which cookie a signed token belongs to; stamped by `sign`, required by `verify`. */
export type TokenKind = "session" | "oauth";

/** Why a session cookie yields no Principal — "invalid" is a forged or tampered cookie (an `auth_failure`), the others are not. */
export type SessionStatus = "none" | "expired" | "invalid";

type TokenCheck = { status: "ok"; payload: Record<string, unknown> } | { status: "invalid" } | { status: "expired" };

export const SESSION_COOKIE = "tpo_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_SECRET_KEY = "SESSION_SECRET";
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "twitch-party-overlay";
/** Actor on the `auth_failure` entries the login flow and the router append (the funnel's passive tripwire). */
export const AUTH_FAILURE_ACTOR = "system:auth";
/** The actor on the streamer listener before the broadcaster is linked. */
export const LOCAL_STREAMER_ACTOR = "streamer@local";

/** The actor string for a Twitch login — the one form every Twitch-identified Principal uses. */
export const twitchActor = (login: string): string => `twitch:${login}`;

/** The linked broadcaster (`config.channel`): linked once `broadcasterId` is non-empty. */
export interface ChannelIdentity {
  login: string;
  broadcasterId: string;
}

const ROLES: ReadonlySet<string> = new Set<Role>(["streamer", "mod"]);
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_COOKIE_ATTRS = { path: "/", httpOnly: true, secure: true, sameSite: "Lax" } as const;

const mac = (secret: string, payloadB64: string) => createHmac("sha256", secret).update(payloadB64).digest().toString("base64url");

/**
 * `base64url(JSON) "." base64url(HMAC-SHA256)`; the payload should carry a numeric `exp` (epoch ms) for `verify`. The
 * `kind` is stamped over anything the payload says, so a token is only ever what its signer meant it to be.
 */
export function sign(secret: string, kind: TokenKind, payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify({ ...payload, kind })).toString("base64url");
  return `${payloadB64}.${mac(secret, payloadB64)}`;
}

/**
 * Signature (constant-time, canonical encoding only), kind and expiry check for any token from `sign`: the parsed
 * payload (without the `kind` stamp) when it is a live token of `kind`; "expired" when only `exp <= now` stands in the
 * way; "invalid" when it is malformed, forged, of another kind, or lacks a numeric `exp`.
 */
function inspect(secret: string, kind: TokenKind, token: string, now: number): TokenCheck {
  const invalid: TokenCheck = { status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2) return invalid;
  const [payloadB64, sig] = parts as [string, string];
  if (payloadB64 === "" || sig === "") return invalid;
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(secret, payloadB64));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid;
  const { kind: stamped, exp, ...rest } = parsed as Record<string, unknown>;
  if (stamped !== kind || typeof exp !== "number") return invalid;
  if (!(exp > now)) return { status: "expired" };
  return { status: "ok", payload: { ...rest, exp } };
}

/** The payload of a live token of `kind`, or null (malformed, forged, another kind, no numeric `exp`, or `exp <= now`). */
export function verify(secret: string, kind: TokenKind, token: string, now = Date.now()): Record<string, unknown> | null {
  const check = inspect(secret, kind, token, now);
  return check.status === "ok" ? check.payload : null;
}

export function signSession(secret: string, payload: SessionPayload): string {
  return sign(secret, "session", payload);
}

function sessionShape(payload: Record<string, unknown>): SessionPayload | null {
  const { uid, login, role, exp } = payload;
  if (typeof uid !== "string" || typeof login !== "string" || typeof role !== "string" || !ROLES.has(role) || typeof exp !== "number") return null;
  return { uid, login, role: role as Role, exp };
}

export function verifySession(secret: string, cookie: string, now = Date.now()): SessionPayload | null {
  const payload = verify(secret, "session", cookie, now);
  return payload === null ? null : sessionShape(payload);
}

/** `tpo_session=<value>; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax` — only ever set on the funnel listener. */
export function sessionCookie(value: string, opts: { maxAgeSeconds?: number } = {}): string {
  return serializeCookie(SESSION_COOKIE, value, { ...SESSION_COOKIE_ATTRS, maxAge: opts.maxAgeSeconds ?? SESSION_TTL_MS / 1000 });
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
}

/**
 * What the request's `tpo_session` cookie amounts to: the Principal it names, or why not — "none" (no cookie), "expired"
 * (ours, but past its 24 h), or "invalid" (bad signature, another kind, or a shape our signer never produced — the one
 * case the router records as an `auth_failure`).
 */
export function sessionState(req: Request, secret: string, now = Date.now()): Principal | SessionStatus {
  const cookie = parseCookies(req).get(SESSION_COOKIE);
  if (cookie === undefined) return "none";
  const check = inspect(secret, "session", cookie, now);
  if (check.status !== "ok") return check.status;
  const session = sessionShape(check.payload);
  if (session === null) return "invalid";
  return { role: session.role, actor: twitchActor(session.login), login: session.login };
}

/**
 * Who is asking: on the streamer listener always the Streamer (the listener is only reachable via host loopback) — as
 * the linked broadcaster (`twitch:<channel.login>`, the same actor a Twitch login yields) when `channel` is linked, else
 * `streamer@local`; on the funnel the holder of a valid `tpo_session`, else null (the caller answers with the login page
 * or 401).
 */
export function resolvePrincipal(req: Request, listener: AppListener, secret: string, now = Date.now(), channel?: ChannelIdentity): Principal | null {
  if (listener === "streamer") {
    if (channel !== undefined && channel.broadcasterId !== "" && channel.login !== "") return { role: "streamer", actor: twitchActor(channel.login), login: channel.login };
    return { role: "streamer", actor: LOCAL_STREAMER_ACTOR, login: null };
  }
  const state = sessionState(req, secret, now);
  return typeof state === "string" ? null : state;
}

/** Every mutating request (anything but GET/HEAD/OPTIONS) must carry `X-Requested-With: twitch-party-overlay`, else 403. */
export function requireCsrf(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (req.headers.get(CSRF_HEADER) === CSRF_VALUE) return null;
  return errorJson(403, "CSRF", `mutating requests must carry the header ${CSRF_HEADER}: ${CSRF_VALUE}`);
}

/** The names a browser on the same machine addresses the streamer listener by; nothing else ever is. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** `<host>` or `<host>:<port>` — a bracketed IPv6 literal or anything without a colon, then an optional numeric port. */
const HOST_HEADER = /^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/;
const LOCAL_HOST_REFUSAL = "This port only answers requests addressed to localhost.\n";

/** True when a `Host` header names this machine: localhost, 127.0.0.1 or [::1], with or without a port, any case. */
function isLocalHost(hostHeader: string): boolean {
  const m = HOST_HEADER.exec(hostHeader);
  return m !== null && LOCAL_HOSTS.has(m[1]!.toLowerCase());
}

/** True when `origin` is an http(s) origin of one of the local hosts; "null", other schemes, or anything unparsable is not. */
function isLocalOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return false;
  return LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * The streamer listener's DNS-rebinding guard. That listener is the Streamer with no login, so a page a browser
 * on this machine has open could rebind its own name to 127.0.0.1 and call the API as the Streamer — the CSRF header
 * alone does not stop that, because the page is then a same-origin caller. The rule: the request's `Host` must be
 * `localhost`, `127.0.0.1` or `[::1]` (any case, with or without a port), and a mutating request (anything but
 * GET/HEAD/OPTIONS) that carries an `Origin` must carry an http(s) origin of one of those hosts. A missing `Origin` on a
 * mutating request passes (Firebot's `!fire` effect posts with the CSRF header and no Origin). A read with a foreign
 * Origin passes too: its Host already proved it was addressed to this machine, and `requireCsrf` guards writes. The
 * 403 is one fixed plain sentence that repeats nothing from the request, so a rebound page learns nothing from it.
 */
export function requireLocalHost(req: Request): Response | null {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const originOk = SAFE_METHODS.has(req.method.toUpperCase()) || origin === null || isLocalOrigin(origin);
  if (host !== null && isLocalHost(host) && originOk) return null;
  return new Response(LOCAL_HOST_REFUSAL, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The cookie-signing secret: `SESSION_SECRET` from the secrets file, generated (32 random bytes, hex) and stored on first use. */
export function sessionSecret(secrets: Secrets): string {
  const existing = secrets.get(SESSION_SECRET_KEY);
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  secrets.set(SESSION_SECRET_KEY, generated);
  return generated;
}

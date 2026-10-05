import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets } from "../config/secrets.ts";
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  requireCsrf,
  requireLocalHost,
  resolvePrincipal,
  sessionCookie,
  sessionSecret,
  sessionState,
  sign,
  signSession,
  verify,
  verifySession,
  type Principal,
  type SessionPayload,
} from "./auth.ts";

const SECRET = "test-session-secret";
const T0 = Date.parse("2026-09-12T20:00:00.000Z");
const modSession = (): SessionPayload => ({ uid: "200", login: "bob", role: "mod", exp: T0 + SESSION_TTL_MS });
const attrs = (cookie: string) => cookie.split("; ").slice(1);

test("signSession/verifySession round-trip: base64url(JSON payload) + '.' + base64url(HMAC-SHA256)", () => {
  const token = signSession(SECRET, modSession());
  const [payloadB64, sig, ...rest] = token.split(".");
  expect(rest).toHaveLength(0);
  expect(JSON.parse(Buffer.from(payloadB64!, "base64url").toString())).toEqual({ ...modSession(), kind: "session" }); // the kind is the signer's
  expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 HMAC bytes, unpadded base64url
  expect(verifySession(SECRET, token, T0)).toEqual(modSession());
});

test("tampered signature, tampered payload, wrong secret, malformed token, wrong shape → null", () => {
  const token = signSession(SECRET, modSession());
  const [p, s] = token.split(".") as [string, string];
  const flip = (str: string, i: number) => str.slice(0, i) + (str[i] === "A" ? "B" : "A") + str.slice(i + 1);
  expect(verifySession(SECRET, `${p}.${flip(s, 0)}`, T0)).toBeNull();
  expect(verifySession(SECRET, `${p}.${flip(s, 42)}`, T0)).toBeNull();
  const forged = Buffer.from(JSON.stringify({ ...modSession(), role: "streamer" })).toString("base64url");
  expect(verifySession(SECRET, `${forged}.${s}`, T0)).toBeNull();
  expect(verifySession("other-secret", token, T0)).toBeNull();
  expect(verifySession(SECRET, "", T0)).toBeNull();
  expect(verifySession(SECRET, "nodot", T0)).toBeNull();
  expect(verifySession(SECRET, `${p}.`, T0)).toBeNull();
  expect(verifySession(SECRET, `.${s}`, T0)).toBeNull();
  expect(verifySession(SECRET, `${p}.${s}.extra`, T0)).toBeNull();
  expect(verifySession(SECRET, `${p}.${s}x`, T0)).toBeNull();
  // correctly signed, but not a session
  expect(verifySession(SECRET, sign(SECRET, "session", { hello: "world", exp: T0 + 1000 }), T0)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "session", { uid: 200, login: "bob", role: "mod", exp: T0 + 1000 }), T0)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "session", { uid: "200", login: "bob", role: "admin", exp: T0 + 1000 }), T0)).toBeNull();
});

test("kinds are separate domains: an oauth-kind token is never a session (whatever its payload says) and a session is never an oauth ticket", () => {
  const session = signSession(SECRET, modSession());
  expect(verify(SECRET, "session", session, T0)).toEqual({ ...modSession() }); // the kind is checked, then stripped
  expect(verify(SECRET, "oauth", session, T0)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "oauth", modSession()), T0)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "oauth", { ...modSession(), kind: "session" }), T0)).toBeNull(); // a payload cannot smuggle its own kind
  expect(verify(SECRET, "oauth", sign(SECRET, "oauth", { state: "s", exp: T0 + 1000 }), T0)).toEqual({ state: "s", exp: T0 + 1000 });
});

test("expired → null: valid up to (not at) exp; a missing or non-numeric exp is invalid", () => {
  const token = signSession(SECRET, modSession());
  expect(verifySession(SECRET, token, T0 + SESSION_TTL_MS - 1)).not.toBeNull();
  expect(verifySession(SECRET, token, T0 + SESSION_TTL_MS)).toBeNull();
  expect(verifySession(SECRET, token, T0 + SESSION_TTL_MS + 1)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "session", { uid: "200", login: "bob", role: "mod" }), T0)).toBeNull();
  expect(verifySession(SECRET, sign(SECRET, "session", { uid: "200", login: "bob", role: "mod", exp: "later" }), T0)).toBeNull();
});

test("sessionCookie: tpo_session with Secure; HttpOnly; SameSite=Lax; Path=/ and a 24 h Max-Age; clearSessionCookie expires it", () => {
  const c = sessionCookie("abc.def");
  expect(c.startsWith("tpo_session=abc.def;")).toBe(true);
  expect(attrs(c).sort()).toEqual(["HttpOnly", "Max-Age=86400", "Path=/", "SameSite=Lax", "Secure"].sort());

  const cleared = clearSessionCookie();
  expect(cleared.startsWith("tpo_session=;")).toBe(true);
  expect(attrs(cleared).sort()).toEqual(["HttpOnly", "Max-Age=0", "Path=/", "SameSite=Lax", "Secure"].sort());
});

test("resolvePrincipal: the listener decides — streamer listener is always the Streamer (streamer@local until the broadcaster is linked, then twitch:<login>), funnel needs a valid tpo_session", () => {
  const req = (cookie?: string) => new Request("https://laptop.tail1234.ts.net/api/state", { headers: cookie ? { cookie } : {} });
  const valid = signSession(SECRET, modSession());
  const streamerLocal: Principal = { role: "streamer", actor: "streamer@local", login: null };
  const linked = { login: "dj", broadcasterId: "100" };

  expect(resolvePrincipal(req(), "streamer", SECRET, T0)).toEqual(streamerLocal);
  expect(resolvePrincipal(req(`tpo_session=${valid}`), "streamer", SECRET, T0)).toEqual(streamerLocal); // cookie is ignored there
  expect(resolvePrincipal(req(), "streamer", SECRET, T0, { login: "", broadcasterId: "" })).toEqual(streamerLocal); // not linked
  expect(resolvePrincipal(req(), "streamer", SECRET, T0, { login: "dj", broadcasterId: "" })).toEqual(streamerLocal); // a seeded login alone is not a link
  expect(resolvePrincipal(req(), "streamer", SECRET, T0, linked)).toEqual({ role: "streamer", actor: "twitch:dj", login: "dj" }); // linked: the broadcaster
  expect(resolvePrincipal(req(`tpo_session=${valid}`), "streamer", SECRET, T0, linked)).toEqual({ role: "streamer", actor: "twitch:dj", login: "dj" }); // still not the cookie's mod
  expect(resolvePrincipal(req(), "funnel", SECRET, T0, linked)).toBeNull(); // the link means nothing on the funnel

  expect(resolvePrincipal(req(), "funnel", SECRET, T0)).toBeNull();
  expect(resolvePrincipal(req("other=1"), "funnel", SECRET, T0)).toBeNull();
  expect(resolvePrincipal(req(`other=1; tpo_session=${valid}; x=y`), "funnel", SECRET, T0)).toEqual({ role: "mod", actor: "twitch:bob", login: "bob" });

  const asStreamer = signSession(SECRET, { uid: "100", login: "dj", role: "streamer", exp: T0 + 1000 });
  expect(resolvePrincipal(req(`tpo_session=${asStreamer}`), "funnel", SECRET, T0)).toEqual({ role: "streamer", actor: "twitch:dj", login: "dj" });

  expect(resolvePrincipal(req(`tpo_session=${valid}x`), "funnel", SECRET, T0)).toBeNull(); // tampered
  expect(resolvePrincipal(req(`tpo_session=${valid}`), "funnel", SECRET, T0 + SESSION_TTL_MS)).toBeNull(); // expired
  expect(resolvePrincipal(req(`tpo_session=${valid}`), "funnel", "other-secret", T0)).toBeNull();
});

test("requireCsrf: mutating methods without X-Requested-With: twitch-party-overlay → 403 {error:{code:CSRF}}; GET/HEAD pass", async () => {
  const r = (method: string, headers: Record<string, string> = {}) => new Request("http://localhost:8700/api/fire", { method, headers });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = requireCsrf(r(method));
    expect(res?.status).toBe(403);
    expect(res?.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res!.json()).toEqual({ error: { code: "CSRF", message: expect.stringContaining("X-Requested-With") } });
    expect(requireCsrf(r(method, { "X-Requested-With": "twitch-party-overlay" }))).toBeNull();
    expect(requireCsrf(r(method, { "x-requested-with": "twitch-party-overlay" }))).toBeNull();
    expect(requireCsrf(r(method, { "X-Requested-With": "XMLHttpRequest" }))?.status).toBe(403);
    expect(requireCsrf(r(method, { "X-Requested-With": "" }))?.status).toBe(403);
  }
  expect(requireCsrf(r("GET"))).toBeNull();
  expect(requireCsrf(r("HEAD"))).toBeNull();
  expect(requireCsrf(r("OPTIONS"))).toBeNull();
});

test("sessionSecret(secrets): returns SESSION_SECRET, or generates 32 random bytes (hex) once and persists them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-auth-"));
  const preset = new Secrets(path.join(dir, "preset.env"));
  preset.set("SESSION_SECRET", "preset-value");
  expect(sessionSecret(preset)).toBe("preset-value");

  const fresh = new Secrets(path.join(dir, "fresh.env"));
  const generated = sessionSecret(fresh);
  expect(generated).toMatch(/^[0-9a-f]{64}$/);
  expect(sessionSecret(fresh)).toBe(generated);
  expect(new Secrets(path.join(dir, "fresh.env")).get("SESSION_SECRET")).toBe(generated);
  expect(sessionSecret(new Secrets(path.join(dir, "other.env")))).not.toBe(generated);
});

test("sessionState: no cookie → none; well-signed but past exp → expired; bad signature, wrong secret, wrong kind or wrong shape → invalid; else the Principal", () => {
  const req = (cookie?: string) => new Request("https://laptop.tail1234.ts.net/api/state", { headers: cookie ? { cookie } : {} });
  const valid = signSession(SECRET, modSession());
  expect(sessionState(req(), SECRET, T0)).toBe("none");
  expect(sessionState(req("other=1"), SECRET, T0)).toBe("none");
  expect(sessionState(req(`other=1; tpo_session=${valid}; x=y`), SECRET, T0)).toEqual({ role: "mod", actor: "twitch:bob", login: "bob" });
  expect(sessionState(req(`tpo_session=${valid}`), SECRET, T0 + SESSION_TTL_MS - 1)).toEqual({ role: "mod", actor: "twitch:bob", login: "bob" });
  expect(sessionState(req(`tpo_session=${valid}`), SECRET, T0 + SESSION_TTL_MS)).toBe("expired");
  expect(sessionState(req(`tpo_session=${valid}x`), SECRET, T0)).toBe("invalid");
  expect(sessionState(req(`tpo_session=${valid}x`), SECRET, T0 + SESSION_TTL_MS)).toBe("invalid"); // a bad signature is invalid whatever the exp says
  expect(sessionState(req(`tpo_session=${valid}`), "other-secret", T0)).toBe("invalid");
  expect(sessionState(req("tpo_session=forged.token"), SECRET, T0)).toBe("invalid");
  expect(sessionState(req("tpo_session=garbage"), SECRET, T0)).toBe("invalid");
  expect(sessionState(req("tpo_session="), SECRET, T0)).toBe("invalid");
  expect(sessionState(req(`tpo_session=${sign(SECRET, "oauth", modSession())}`), SECRET, T0)).toBe("invalid");
  expect(sessionState(req(`tpo_session=${sign(SECRET, "session", { ...modSession(), role: "admin" })}`), SECRET, T0)).toBe("invalid");
  expect(sessionState(req(`tpo_session=${sign(SECRET, "session", { uid: "200", login: "bob", role: "mod" })}`), SECRET, T0)).toBe("invalid"); // no exp at all
});

test("requireLocalHost: Host must be localhost, 127.0.0.1 or [::1] (any case, with or without a port); anything else or no Host → 403 plain text that echoes nothing", () => {
  const r = (headers: Record<string, string>, method = "GET") => new Request("http://127.0.0.1:8700/api/state", { method, headers });
  for (const host of ["localhost", "localhost:8700", "LOCALHOST:8700", "127.0.0.1", "127.0.0.1:8700", "[::1]", "[::1]:8700", "[::1]:12345"]) {
    expect(requireLocalHost(r({ Host: host }))).toBeNull();
  }
  for (const host of ["evil.example", "evil.example:8700", "localhost.evil.example:8700", "127.0.0.1.evil.example", "127.0.0.2:8700", "[::2]:8700", "192.168.1.20:8700", "localhost:", "localhost:abc", ""]) {
    const res = requireLocalHost(r({ Host: host }));
    expect(res?.status).toBe(403);
  }
  const foreign = requireLocalHost(r({ Host: "evil.example:8700" }))!;
  expect(foreign.headers.get("content-type")).toStartWith("text/plain");
  const missing = requireLocalHost(new Request("http://127.0.0.1:8700/api/state"))!;
  expect(missing.status).toBe(403);
});

test("requireLocalHost: the 403 body is one generic sentence, the same for every rejection, never the Host or Origin it saw", async () => {
  const r = (headers: Record<string, string>, method = "GET") => new Request("http://127.0.0.1:8700/api/state", { method, headers });
  const bodies = await Promise.all([
    requireLocalHost(r({ Host: "evil.example:8700" }))!.text(),
    requireLocalHost(r({ Host: "other.example" }))!.text(),
    requireLocalHost(new Request("http://127.0.0.1:8700/api/state"))!.text(),
    requireLocalHost(r({ Host: "localhost:8700", Origin: "https://evil.example" }, "POST"))!.text(),
  ]);
  expect(new Set(bodies).size).toBe(1);
  expect(bodies[0]).not.toContain("evil");
  expect(bodies[0]).not.toContain("other");
  expect(bodies[0]!.trim().split(/[.!?]\s/)).toHaveLength(1);
});

test("requireLocalHost: a mutating request with an Origin must have an http(s) origin of the same local hosts; no Origin passes (Firebot), GET/HEAD/OPTIONS ignore Origin", () => {
  const r = (method: string, headers: Record<string, string>) => new Request("http://127.0.0.1:8700/api/fire", { method, headers });
  const local = { Host: "localhost:8700" };
  // Firebot's !fire effect: POST with the CSRF header and no Origin
  expect(requireLocalHost(r("POST", { Host: "127.0.0.1:8700", "X-Requested-With": "twitch-party-overlay" }))).toBeNull();
  for (const origin of ["http://localhost:8700", "http://LOCALHOST:8700", "http://127.0.0.1:8700", "http://[::1]:8700", "https://localhost", "http://localhost"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(requireLocalHost(r(method, { ...local, Origin: origin }))).toBeNull();
  }
  for (const origin of ["https://evil.example", "http://evil.example:8700", "http://localhost.evil.example:8700", "null", "", "ftp://localhost", "localhost:8700", "http://127.0.0.2:8700", "http://192.168.1.20:8700"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(requireLocalHost(r(method, { ...local, Origin: origin }))?.status).toBe(403);
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(requireLocalHost(r(method, { ...local, Origin: origin }))).toBeNull();
  }
  // a foreign Host loses even with a local Origin
  expect(requireLocalHost(r("POST", { Host: "evil.example:8700", Origin: "http://localhost:8700" }))?.status).toBe(403);
});

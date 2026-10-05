import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets } from "../config/secrets.ts";
import { defaultConfig, type Config } from "../config/schema.ts";
import { Helix, TOKEN_KEYS } from "../ingest/twitch/helix.ts";
import { Ledger } from "../ledger/ledger.ts";
import { SESSION_COOKIE, SESSION_TTL_MS, sign, signSession, verify, verifySession } from "./auth.ts";
import { BROADCASTER_SCOPES, OAUTH_COOKIE, OAUTH_TTL_MS, OAuth } from "./oauth.ts";

const HELIX = "http://helix.test/helix";
const ID = "http://id.test/oauth2";
const T0 = new Date("2026-09-12T20:00:00.000Z");
const FUNNEL_URL = "https://laptop.tail1234.ts.net";
const STATE = "ab".repeat(32);
const BROADCASTER = { user_id: "100", login: "dj" };
const BOB = { user_id: "200", login: "bob" };
const CAROL = { user_id: "300", login: "carol" };
const MODS = [
  { user_id: "200", user_login: "bob" },
  { user_id: "201", user_login: "dave" },
];

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>; // lower-cased names
  body: string | undefined;
}

interface FixtureOptions {
  user?: { user_id: string; login: string }; // who /validate says the exchanged token belongs to
  moderators?: Array<{ user_id: string; user_login: string }> | "down"; // Helix moderators answer ("down" → 503)
  broadcasterId?: string;
  publicUrl?: string;
  tokenStatus?: number; // non-2xx → the code exchange fails
}

function fixture(opts: FixtureOptions = {}) {
  const user = opts.user ?? BOB;
  const moderators = opts.moderators ?? MODS;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-oauth-"));
  const secrets = new Secrets(path.join(dataDir, "secrets.env"));
  secrets.set("SESSION_SECRET", "session-secret");
  secrets.set(TOKEN_KEYS.access, "old-access");
  secrets.set(TOKEN_KEYS.refresh, "old-refresh");
  secrets.set(TOKEN_KEYS.expiresAt, new Date(T0.getTime() + 3_600_000).toISOString());
  const clock = { now: T0 };
  const now = () => clock.now;
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    if (call.method === "POST" && call.url === `${ID}/token`) {
      if (opts.tokenStatus !== undefined) return new Response("Bad Request", { status: opts.tokenStatus });
      return Response.json({ access_token: "user-token", refresh_token: "user-refresh", expires_in: 14000, scope: [], token_type: "bearer" });
    }
    if (call.url === `${ID}/validate`) {
      if (call.headers.authorization !== "OAuth user-token") return new Response("Unauthorized", { status: 401 });
      return Response.json({ client_id: "cid", login: user.login, user_id: user.user_id, scopes: [], expires_in: 14000 });
    }
    if (call.url.startsWith(`${HELIX}/moderation/moderators`)) {
      if (moderators === "down") return new Response("Service Unavailable", { status: 503 });
      const uid = new URL(call.url).searchParams.get("user_id");
      return Response.json({ data: uid === null ? moderators : moderators.filter((m) => m.user_id === uid), pagination: {} });
    }
    return new Response("not found", { status: 404 });
  };
  const config: Config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: opts.broadcasterId ?? "100", displayName: "DJ" };
  config.funnel.publicUrl = opts.publicUrl ?? FUNNEL_URL;
  const helix = new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl, now, helixUrl: HELIX, idUrl: ID });
  const ledger = new Ledger(":memory:");
  const linked: Array<[string, string]> = [];
  const logs: string[] = [];
  const oauth = new OAuth({
    log: (line) => void logs.push(line),
    clientId: "cid",
    clientSecret: "csecret",
    secrets,
    helix,
    config: () => config,
    onBroadcasterLinked: (id, login) => linked.push([id, login]),
    ledger,
    dataDir,
    fetchImpl,
    random: () => STATE,
    now,
    idUrl: ID,
  });
  return { oauth, secrets, ledger, calls, dataDir, linked, logs, config, clock, secret: "session-secret" };
}

type Listener = "streamer" | "funnel";
const base = (listener: Listener) => (listener === "funnel" ? FUNNEL_URL : "http://localhost:8700");
const startReq = (listener: Listener) => new Request(listener === "funnel" ? `${FUNNEL_URL}/login` : "http://localhost:8700/auth/twitch/broadcaster", { headers: { "x-forwarded-for": "203.0.113.9" } });

function callbackReq(listener: Listener, opts: { code?: string | null; state?: string | null; cookie?: string; ip?: string; extra?: Record<string, string> } = {}): Request {
  const url = new URL(`${base(listener)}/auth/twitch/callback`);
  if (opts.code !== null) url.searchParams.set("code", opts.code ?? "the-code");
  if (opts.state !== null) url.searchParams.set("state", opts.state ?? STATE);
  for (const [k, v] of Object.entries(opts.extra ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.9" };
  if (opts.cookie !== undefined) headers.cookie = `${OAUTH_COOKIE}=${opts.cookie}`;
  return new Request(url, { headers });
}

const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (res: Response, name: string) => setCookie(res, name)!.split(";")[0]!.slice(name.length + 1);
const attrs = (cookie: string) => cookie.split("; ").slice(1);
const summary = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url}`);

/** start() then the value of the tpo_oauth cookie it set. */
function started(f: ReturnType<typeof fixture>, mode: "login" | "broadcaster", listener: Listener): string {
  return cookieValue(f.oauth.start(mode, listener, startReq(listener)), OAUTH_COOKIE);
}

test("start(login, funnel): 302 to /authorize with the funnel redirect_uri, empty scope, hex state; signed 10-minute tpo_oauth cookie", () => {
  const f = fixture();
  const res = f.oauth.start("login", "funnel", startReq("funnel"));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(`${ID}/authorize`);
  expect(Object.fromEntries(loc.searchParams.entries())).toEqual({
    client_id: "cid",
    redirect_uri: `${FUNNEL_URL}/auth/twitch/callback`,
    response_type: "code",
    scope: "",
    state: STATE,
  });
  const cookie = setCookie(res, OAUTH_COOKIE)!;
  expect(attrs(cookie).sort()).toEqual(["HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax", "Secure"].sort());
  expect(verify(f.secret, "oauth", cookieValue(res, OAUTH_COOKIE), T0.getTime())).toEqual({
    state: STATE,
    mode: "login",
    redirectUri: `${FUNNEL_URL}/auth/twitch/callback`,
    exp: T0.getTime() + OAUTH_TTL_MS,
  });
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  expect(f.calls).toHaveLength(0);
});

test("start(broadcaster, streamer): localhost:<streamerPort> redirect_uri, the four broadcaster scopes (chat included), cookie without Secure (plain http://localhost)", () => {
  const f = fixture();
  f.config.listeners.streamerPort = 8765;
  const res = f.oauth.start("broadcaster", "streamer", startReq("streamer"));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(`${ID}/authorize`);
  expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8765/auth/twitch/callback");
  expect(loc.searchParams.get("scope")).toBe(BROADCASTER_SCOPES);
  expect(BROADCASTER_SCOPES).toBe("bits:read channel:read:subscriptions moderation:read user:read:chat");
  expect(loc.searchParams.get("state")).toBe(STATE);
  const cookie = setCookie(res, OAUTH_COOKIE)!;
  expect(attrs(cookie).sort()).toEqual(["HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax"].sort());
  expect(verify(f.secret, "oauth", cookieValue(res, OAUTH_COOKIE), T0.getTime())).toMatchObject({ mode: "broadcaster", redirectUri: "http://localhost:8765/auth/twitch/callback" });
});

test("start: mode and listener are paired — broadcaster on the funnel and login on the streamer listener → 404, no cookie", () => {
  const f = fixture();
  for (const [mode, listener] of [
    ["broadcaster", "funnel"],
    ["login", "streamer"],
  ] as const) {
    const res = f.oauth.start(mode, listener, startReq(listener));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  }
});

test("start(login, funnel) without funnel.publicUrl → 503 (nothing to register a redirect_uri for)", () => {
  const f = fixture({ publicUrl: "" });
  const res = f.oauth.start("login", "funnel", startReq("funnel"));
  expect(res.status).toBe(503);
  expect(res.headers.get("location")).toBeNull();
});

test("callback: mismatched, missing or expired state → 400, no session cookie, no Twitch call, one auth_failure per attempt on the funnel", async () => {
  const f = fixture();
  const cookie = started(f, "login", "funnel");

  const mismatch = await f.oauth.callback("funnel", callbackReq("funnel", { state: "ff".repeat(32), cookie, ip: "203.0.113.9" }));
  expect(mismatch.status).toBe(400);
  expect(setCookie(mismatch, SESSION_COOKIE)).toBeUndefined();
  expect(f.calls).toHaveLength(0);
  expect(f.ledger.all()).toHaveLength(1);
  expect(f.ledger.all()[0]).toMatchObject({
    type: "auth_failure",
    actor: "system:auth",
    payload: { ip: "203.0.113.9", path: "/auth/twitch/callback", reason: expect.stringMatching(/state/i) },
  });

  expect((await f.oauth.callback("funnel", callbackReq("funnel", { state: null, cookie }))).status).toBe(400);
  expect((await f.oauth.callback("funnel", callbackReq("funnel", {}))).status).toBe(400); // no cookie at all
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie: `${cookie}x` }))).status).toBe(400); // tampered cookie

  f.clock.now = new Date(T0.getTime() + OAUTH_TTL_MS + 1);
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie }))).status).toBe(400); // expired

  expect(f.calls).toHaveLength(0);
  expect(f.ledger.all().map((e) => e.type)).toEqual(["auth_failure", "auth_failure", "auth_failure", "auth_failure", "auth_failure"]);
});

test("callback on the streamer listener: a bad state is still 400 but is not an auth_failure (the tripwire is funnel-only)", async () => {
  const f = fixture();
  const cookie = started(f, "broadcaster", "streamer");
  const res = await f.oauth.callback("streamer", callbackReq("streamer", { state: "ff".repeat(32), cookie }));
  expect(res.status).toBe(400);
  expect(f.ledger.all()).toHaveLength(0);
  expect(f.linked).toEqual([]);
});

test("callback: Twitch's own error (user denied) → 400, cookie cleared, nothing exchanged", async () => {
  const f = fixture();
  const cookie = started(f, "login", "funnel");
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { code: null, cookie, extra: { error: "access_denied", error_description: "The user denied you access" } }));
  expect(res.status).toBe(400);
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  expect(attrs(setCookie(res, OAUTH_COOKIE)!)).toContain("Max-Age=0");
  expect(f.calls).toHaveLength(0);
});

test("callback(login, funnel) moderator: code exchange → validate → Helix moderators → tpo_session (role mod), tpo_oauth cleared, user token discarded", async () => {
  const f = fixture();
  const cookie = started(f, "login", "funnel");
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie }));

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  const session = setCookie(res, SESSION_COOKIE)!;
  expect(attrs(session).sort()).toEqual(["HttpOnly", "Max-Age=86400", "Path=/", "SameSite=Lax", "Secure"].sort());
  expect(verifySession(f.secret, cookieValue(res, SESSION_COOKIE), T0.getTime())).toEqual({ uid: "200", login: "bob", role: "mod", exp: T0.getTime() + SESSION_TTL_MS });
  expect(attrs(setCookie(res, OAUTH_COOKIE)!)).toContain("Max-Age=0");

  expect(summary(f.calls)).toEqual([`POST ${ID}/token`, `GET ${ID}/validate`, `GET ${HELIX}/moderation/moderators?broadcaster_id=100&user_id=200`]);
  expect(f.calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body).entries())).toEqual({
    client_id: "cid",
    client_secret: "csecret",
    code: "the-code",
    grant_type: "authorization_code",
    redirect_uri: `${FUNNEL_URL}/auth/twitch/callback`,
  });
  expect(f.calls[1]!.headers.authorization).toBe("OAuth user-token");
  expect(f.calls[2]!.headers.authorization).toBe("Bearer old-access"); // the broadcaster token, not the user's

  expect(f.secrets.get(TOKEN_KEYS.access)).toBe("old-access");
  expect(f.secrets.get(TOKEN_KEYS.refresh)).toBe("old-refresh");
  expect(fs.readFileSync(path.join(f.dataDir, "secrets.env"), "utf8")).not.toContain("user-token");
  expect(f.ledger.all()).toHaveLength(0);
  expect(f.linked).toEqual([]);
});

test("callback(login, funnel) by the broadcaster: user_id === channel.broadcasterId → role streamer without a Helix call; unlinked channel never matches", async () => {
  const f = fixture({ user: BROADCASTER });
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie: started(f, "login", "funnel") }));
  expect(res.status).toBe(302);
  expect(verifySession(f.secret, cookieValue(res, SESSION_COOKIE), T0.getTime())).toEqual({ uid: "100", login: "dj", role: "streamer", exp: T0.getTime() + SESSION_TTL_MS });
  expect(summary(f.calls)).toEqual([`POST ${ID}/token`, `GET ${ID}/validate`]);

  const unlinked = fixture({ user: BROADCASTER, broadcasterId: "", moderators: "down" });
  const denied = await unlinked.oauth.callback("funnel", callbackReq("funnel", { cookie: started(unlinked, "login", "funnel") }));
  expect(denied.status).toBe(403);
  expect(setCookie(denied, SESSION_COOKIE)).toBeUndefined();
});

test("callback(login, funnel) non-moderator: 403 HTML 'Not a moderator of this channel' + exactly one auth_failure {ip, path, reason}", async () => {
  const f = fixture({ user: CAROL });
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie: started(f, "login", "funnel"), ip: "198.51.100.7" }));

  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(await res.text()).toContain("Not a moderator of this channel");
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  expect(attrs(setCookie(res, OAUTH_COOKIE)!)).toContain("Max-Age=0");

  const entries = f.ledger.all();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    type: "auth_failure",
    actor: "system:auth",
    payload: { ip: "198.51.100.7", path: "/auth/twitch/callback", reason: "not a moderator: carol" },
  });
  expect(summary(f.calls)).toEqual([`POST ${ID}/token`, `GET ${ID}/validate`, `GET ${HELIX}/moderation/moderators?broadcaster_id=100&user_id=300`]);
});

test("callback(broadcaster, streamer): stores access/refresh/expiry in Secrets, calls onBroadcasterLinked, redirects to / with no session cookie", async () => {
  const f = fixture({ user: BROADCASTER });
  const res = await f.oauth.callback("streamer", callbackReq("streamer", { cookie: started(f, "broadcaster", "streamer") }));

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  expect(attrs(setCookie(res, OAUTH_COOKIE)!)).toContain("Max-Age=0");

  expect(summary(f.calls)).toEqual([`POST ${ID}/token`, `GET ${ID}/validate`]);
  expect(new URLSearchParams(f.calls[0]!.body).get("redirect_uri")).toBe("http://localhost:8700/auth/twitch/callback");

  const persisted = new Secrets(path.join(f.dataDir, "secrets.env"));
  expect(persisted.get(TOKEN_KEYS.access)).toBe("user-token");
  expect(persisted.get(TOKEN_KEYS.refresh)).toBe("user-refresh");
  expect(persisted.get(TOKEN_KEYS.expiresAt)).toBe(new Date(T0.getTime() + 14000 * 1000).toISOString());
  expect(f.linked).toEqual([["100", "dj"]]);
  expect(f.ledger.all()).toHaveLength(0);
});

test("callback: a broadcaster-mode cookie presented on the funnel → 404 and nothing is stored", async () => {
  const f = fixture({ user: BROADCASTER });
  const cookie = started(f, "broadcaster", "streamer");
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie }));
  expect(res.status).toBe(404);
  expect(f.calls).toHaveLength(0);
  expect(f.secrets.get(TOKEN_KEYS.access)).toBe("old-access");
  expect(f.linked).toEqual([]);
});

test("cookie kinds are separate domains: a tpo_oauth ticket is not a tpo_session, and a session-kind token is not a ticket even with a ticket's shape", async () => {
  const f = fixture();
  const ticket = started(f, "login", "funnel");
  expect(verify(f.secret, "oauth", ticket, T0.getTime())).not.toBeNull();
  expect(verifySession(f.secret, ticket, T0.getTime())).toBeNull(); // presented as tpo_session → no Principal

  const session = signSession(f.secret, { uid: "200", login: "bob", role: "mod", exp: T0.getTime() + SESSION_TTL_MS });
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie: session }))).status).toBe(400);
  const lookalike = sign(f.secret, "session", { state: STATE, mode: "login", redirectUri: `${FUNNEL_URL}/auth/twitch/callback`, exp: T0.getTime() + OAUTH_TTL_MS });
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie: lookalike }))).status).toBe(400);
  expect(f.calls).toHaveLength(0);
  expect(f.ledger.all().map((e) => e.type)).toEqual(["auth_failure", "auth_failure"]);
});

test("callback: Helix is up and says not a moderator → 403 even when a stale mods.json lists the user (the file only speaks when Helix cannot)", async () => {
  const f = fixture({ moderators: [] });
  fs.writeFileSync(path.join(f.dataDir, "mods.json"), JSON.stringify(MODS)); // lists bob
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie: started(f, "login", "funnel") }));
  expect(res.status).toBe(403);
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  expect(summary(f.calls)).toEqual([`POST ${ID}/token`, `GET ${ID}/validate`, `GET ${HELIX}/moderation/moderators?broadcaster_id=100&user_id=200`]);
  expect(f.ledger.all().map((e) => e.type)).toEqual(["auth_failure"]);
  expect(f.ledger.all()[0]!.payload).toMatchObject({ reason: "not a moderator: bob" });
});

test("callback: Helix down → last-known-good mods.json decides; absent file or absent user → 403", async () => {
  const down = fixture({ moderators: "down" });
  fs.writeFileSync(path.join(down.dataDir, "mods.json"), JSON.stringify(MODS));
  const res = await down.oauth.callback("funnel", callbackReq("funnel", { cookie: started(down, "login", "funnel") }));
  expect(res.status).toBe(302);
  expect(verifySession(down.secret, cookieValue(res, SESSION_COOKIE), T0.getTime())).toMatchObject({ uid: "200", login: "bob", role: "mod" });
  expect(down.ledger.all()).toHaveLength(0);

  const stranger = fixture({ moderators: "down", user: CAROL });
  fs.writeFileSync(path.join(stranger.dataDir, "mods.json"), JSON.stringify(MODS));
  const denied = await stranger.oauth.callback("funnel", callbackReq("funnel", { cookie: started(stranger, "login", "funnel") }));
  expect(denied.status).toBe(403);
  expect(stranger.ledger.all().map((e) => e.type)).toEqual(["auth_failure"]);

  const noFile = fixture({ moderators: "down" });
  const denied2 = await noFile.oauth.callback("funnel", callbackReq("funnel", { cookie: started(noFile, "login", "funnel") }));
  expect(denied2.status).toBe(403);
  expect(setCookie(denied2, SESSION_COOKIE)).toBeUndefined();
});

test("refreshMods(): writes the full Helix moderator list to <dataDir>/mods.json; an unlinked channel writes nothing", async () => {
  const f = fixture();
  await f.oauth.refreshMods();
  expect(summary(f.calls)).toEqual([`GET ${HELIX}/moderation/moderators?broadcaster_id=100&first=100`]);
  expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, "mods.json"), "utf8"))).toEqual(MODS);

  const unlinked = fixture({ broadcasterId: "" });
  await unlinked.oauth.refreshMods();
  expect(unlinked.calls).toHaveLength(0);
  expect(fs.existsSync(path.join(unlinked.dataDir, "mods.json"))).toBe(false);

  const down = fixture({ moderators: "down" });
  await expect(down.oauth.refreshMods()).rejects.toThrow(/503/);
  expect(fs.existsSync(path.join(down.dataDir, "mods.json"))).toBe(false);
});

test("callback: a failed code exchange → 502 without a session, one auth_failure on the funnel, and no secret in the page", async () => {
  const f = fixture({ tokenStatus: 400 });
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie: started(f, "login", "funnel") }));
  expect(res.status).toBe(502);
  expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  const body = await res.text();
  expect(body).not.toContain("csecret");
  expect(body).not.toContain("the-code");
  expect(f.ledger.all().map((e) => e.type)).toEqual(["auth_failure"]);
  expect(f.ledger.all()[0]!.payload).toMatchObject({ reason: expect.stringMatching(/exchange/i) });
});

// ---- console lines (follow-up 1): attempts and successes, always on; never a token, code or cookie -------------------

test("log: start() prints the attempt with listener and ip; a mod login prints `login ok` with login, role, listener and ip", async () => {
  const f = fixture();
  const cookie = started(f, "login", "funnel");
  expect(f.logs).toEqual(["login attempt: funnel from 203.0.113.9"]);
  const res = await f.oauth.callback("funnel", callbackReq("funnel", { cookie, ip: "198.51.100.7" }));
  expect(res.status).toBe(302);
  expect(f.logs).toEqual(["login attempt: funnel from 203.0.113.9", "login ok: twitch:bob as mod on funnel from 198.51.100.7"]);
  for (const line of f.logs) {
    expect(line).not.toContain("user-token");
    expect(line).not.toContain("the-code");
    expect(line).not.toContain(cookie);
  }
});

test("log: the broadcaster link prints the attempt and `broadcaster linked` with login and user id; the streamer's own funnel login is `as streamer`", async () => {
  const f = fixture({ user: BROADCASTER });
  const cookie = started(f, "broadcaster", "streamer");
  expect(f.logs).toEqual(["login attempt: streamer from 203.0.113.9 (broadcaster link)"]);
  expect((await f.oauth.callback("streamer", callbackReq("streamer", { cookie }))).status).toBe(302);
  expect(f.logs[1]).toBe("broadcaster linked: twitch:dj (100)");
  const login = started(f, "login", "funnel");
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie: login }))).status).toBe(302);
  expect(f.logs[3]).toBe("login ok: twitch:dj as streamer on funnel from 203.0.113.9");
});

test("log: a refused login prints no `login ok` (the auth_failure entry is its record)", async () => {
  const f = fixture({ user: CAROL });
  const cookie = started(f, "login", "funnel");
  expect((await f.oauth.callback("funnel", callbackReq("funnel", { cookie }))).status).toBe(403);
  expect(f.logs).toEqual(["login attempt: funnel from 203.0.113.9"]);
  expect(f.ledger.all().filter((e) => e.type === "auth_failure")).toHaveLength(1);
});

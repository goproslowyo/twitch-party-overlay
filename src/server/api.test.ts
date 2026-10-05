import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type Config } from "../config/schema.ts";
import { Secrets } from "../config/secrets.ts";
import { ConfigStore } from "../config/store.ts";
import { Engine, type FireResult } from "../engine/engine.ts";
import { Helix } from "../ingest/twitch/helix.ts";
import { FIREBOT_SAYS, Firebot } from "../integrations/firebot.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Entry } from "../ledger/types.ts";
import { SHUTDOWN_DELAY_MS } from "./api.ts";
import { createApp } from "./app.ts";
import { SESSION_TTL_MS, sign, signSession, type AppListener, type Role } from "./auth.ts";
import { Health } from "./health.ts";
import { OAuth } from "./oauth.ts";
import { OverlayHub, moteWireKey, type Chatter, type ChatterSource, type OverlayMessage } from "./overlay.ts";

const SECRET = "session-secret";
const KOFI_TOKEN = "e58df006-d830-4114-96e9-6bbbfcb2b776";
const KOFI_PATH = "k0f1-hook-path";
const T0 = new Date("2026-09-12T20:00:00.000Z");
const FUNNEL_URL = "https://laptop.tail1234.ts.net";
const STREAMER_URL = "http://localhost:8700";
const ID = "http://id.test/oauth2";
const CSRF = { "x-requested-with": "twitch-party-overlay" };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const ipv4 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });
const ipv6 = (address: string): os.NetworkInterfaceInfo => ({ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 });

/** A ChatterSource the tests drive by hand: `fake()` adds a made-up person, `hopRandom()` hops the first one there. */
function fakeChatters(): ChatterSource & { hops: string[] } {
  const items: Chatter[] = [];
  const hops: string[] = [];
  return {
    hops,
    list: () => [...items].reverse(), // most recent first, like the real roster
    count: () => items.length,
    fake: () => {
      const n = items.length + 1;
      const chatter: Chatter = { key: `f${n}`, name: `fake_${n}`, avatarUrl: "https://static-cdn.jtvnw.net/user-default-pictures-uv/default-profile_image-150x150.png", firstSeenMs: T0.getTime() + n, lastSeenMs: T0.getTime() + n };
      items.push(chatter);
      return chatter;
    },
    hopRandom: () => {
      const first = items[0];
      if (first === undefined) return null;
      hops.push(first.key);
      return first;
    },
  };
}

function mk(opts: { config?: (c: Config) => void; rng?: () => number; firebotStatus?: number; networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>; hostLanIp?: string; onShutdownRequest?: (source: string) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-api-"));
  const configPath = path.join(dir, "config.json");
  const seed = defaultConfig();
  seed.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  seed.funnel.publicUrl = FUNNEL_URL;
  seed.firebot.enabled = true;
  seed.ingest.kofi = { enabled: true, webhookPath: KOFI_PATH }; // off by default since the Setup page arrived; these tests exercise the hook
  opts.config?.(seed);
  fs.writeFileSync(configPath, JSON.stringify(seed));
  const config = new ConfigStore(configPath);
  const secrets = new Secrets(path.join(dir, "secrets.env"));
  secrets.set("SESSION_SECRET", SECRET);
  secrets.set("KOFI_VERIFICATION_TOKEN", KOFI_TOKEN);
  secrets.set("TWITCH_CLIENT_ID", "cid"); // a set-up service: without the app keys `/` goes to /setup
  secrets.set("TWITCH_CLIENT_SECRET", "csecret");
  const ledger = new Ledger(":memory:");
  const engine = new Engine(ledger, () => config.get(), { rng: opts.rng ?? (() => 0), now: () => T0 });
  const health = new Health({ now: () => T0 });

  const firebotCalls: Call[] = [];
  const firebotFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    firebotCalls.push(call);
    if (opts.firebotStatus !== undefined) return new Response("nope", { status: opts.firebotStatus });
    if (call.method === "GET" && call.url.endsWith("/api/v1/commands/custom")) return Response.json([{ id: "cmd-1", trigger: "!giveaway" }]);
    return Response.json({ status: "success" });
  };
  const firebot = new Firebot({ config: () => config.get(), fetchImpl: firebotFetch, sleep: async () => {}, onWarn: (text) => health.set("firebot", "warn", text) });

  const hub = new OverlayHub(engine, () => config.get());
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s) => void msgs.push(JSON.parse(s) as OverlayMessage) });

  const noFetch = async (): Promise<Response> => new Response("not found", { status: 404 });
  const helix = new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl: noFetch, now: () => T0 });
  const oauth = new OAuth({ clientId: "cid", clientSecret: "csecret", secrets, helix, config: () => config.get(), onBroadcasterLinked: () => {}, ledger, dataDir: dir, fetchImpl: noFetch, now: () => T0, idUrl: ID, log: () => {} });

  const chatters = fakeChatters();
  const logs: string[] = [];
  const debugLines: string[] = [];
  const app = createApp({
    config,
    secrets,
    ledger,
    engine,
    health,
    firebot,
    oauth,
    hub,
    chatters,
    sessionSecret: SECRET,
    log: (message) => void logs.push(message),
    debug: (line) => void debugLines.push(line),
    now: () => T0,
    networkInterfaces: opts.networkInterfaces ?? (() => ({ lo0: [ipv4("127.0.0.1", true)], en0: [ipv4("192.168.1.20", false), ipv6("fe80::1")], utun3: [ipv4("100.64.0.9", false)] })),
    hostLanIp: opts.hostLanIp,
    ...(opts.onShutdownRequest === undefined ? {} : { onShutdownRequest: opts.onShutdownRequest }),
  });
  return { dir, configPath, config, secrets, ledger, engine, health, firebot, firebotCalls, hub, chatters, msgs, app, logs, debugLines, theme: () => config.get().themes[config.get().overlay.theme]! };
}
type Fixture = ReturnType<typeof mk>;

interface ReqOptions {
  body?: unknown;
  raw?: { body: string; contentType: string };
  cookie?: string;
  csrf?: boolean; // default true for non-GET
  ip?: string;
}

function request(listener: AppListener, method: string, pathname: string, opts: ReqOptions = {}): Request {
  const headers = new Headers({ "x-forwarded-for": opts.ip ?? "203.0.113.9" });
  if (opts.csrf !== false && method !== "GET") headers.set("x-requested-with", CSRF["x-requested-with"]);
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  let body: string | undefined;
  if (opts.raw !== undefined) {
    headers.set("content-type", opts.raw.contentType);
    body = opts.raw.body;
  } else if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(`${listener === "funnel" ? FUNNEL_URL : STREAMER_URL}${pathname}`, { method, headers, body });
}

const call = (f: Fixture, listener: AppListener, method: string, pathname: string, opts: ReqOptions = {}) => f.app.handle(request(listener, method, pathname, opts), listener);
const cookie = (role: Role, login = role === "mod" ? "bob" : "dj") => `tpo_session=${signSession(SECRET, { uid: role === "mod" ? "200" : "100", login, role, exp: T0.getTime() + SESSION_TTL_MS })}`;
const MOD = { cookie: cookie("mod") };
const asJson = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const errorOf = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  const body = await asJson(res);
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  return body.error.message as string;
};
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
/** What the Engine writes into an empty Ledger at boot: the threshold seed (seq 1) + one `stock` seed per Outcome. */
const BOOT_SEEDS = 1 + defaultConfig().outcomes.length;
const written = (f: Fixture) => f.ledger.all().slice(BOOT_SEEDS); // what the requests wrote — after the Engine's boot seeds
const types = (f: Fixture) => written(f).map((e) => e.type);

async function credit(f: Fixture, cents: number, displayName: string | null = "alice", listener: AppListener = "streamer"): Promise<number> {
  const res = await call(f, listener, "POST", "/api/contributions", { body: { face: { kind: "tip", cents }, ...(displayName === null ? {} : { displayName }) }, ...(listener === "funnel" ? MOD : {}) });
  expect(res.status).toBe(200);
  return (await asJson(res)).seq as number;
}

async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error("condition not met in time");
}

/** Ko-fi's official example payload, form-encoded the way Ko-fi posts it. */
function kofiBody(overrides: Record<string, unknown> = {}): ReqOptions["raw"] {
  const data = {
    verification_token: KOFI_TOKEN,
    message_id: "2defe7b3-a0a9-4495-991c-ad08cd0dc51d",
    timestamp: "2024-01-25T15:22:49Z",
    type: "Donation",
    is_public: true,
    from_name: "Jo Example",
    message: "Good luck with the integration!",
    amount: "3.00",
    url: "https://ko-fi.com/Home/CoffeeShop?txid=00000000-1111-2222-3333-444444444444",
    email: "jo.example@example.com",
    currency: "USD",
    is_subscription_payment: false,
    is_first_subscription_payment: false,
    kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
    shop_items: null,
    tier_name: null,
    shipping: null,
    ...overrides,
  };
  return { body: `data=${encodeURIComponent(JSON.stringify(data))}`, contentType: "application/x-www-form-urlencoded" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Auth, CSRF, routing
// ---------------------------------------------------------------------------------------------------------------------

test("/api/* on the funnel needs a valid session (401 JSON without one); the streamer listener acts as the linked broadcaster, streamer@local before the link; GET /api/state shape", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "GET", "/api/state"), 401, "UNAUTHORIZED");
  expect(types(f)).toEqual([]); // no cookie at all is not a credential failure

  const mod = await call(f, "funnel", "GET", "/api/state", MOD);
  expect(mod.status).toBe(200);
  expect(mod.headers.get("content-type")).toContain("application/json");
  const body = await asJson(mod);
  expect(body).toEqual({
    role: "mod",
    actor: "twitch:bob",
    state: f.engine.state,
    health: [],
    overlayUrls: ["http://localhost:8702/overlay"], // OBS on the same computer is the default
    overlays: [],
    giveaway: null,
    giveawaysPending: [],
    chatters: 0,
  });
  expect(body.state.outcomes.find((o: { id: string }) => o.id === "pie-to-the-face").name).toBe("PIE TO THE FACE"); // the Dashboard sees every name

  // the Active Chatter count rides the same poll the Live page's client uses
  f.chatters.fake();
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).chatters).toBe(1);

  // the connected overlays' latest quality reports, one per socket that has sent one
  const overlayWs = { send: () => undefined };
  f.hub.attach(overlayWs);
  f.hub.receive(overlayWs, JSON.stringify({ type: "quality", level: 4, mode: "auto", missRatio: 0.03, webgl: true, stable: true }));
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).overlays).toEqual([{ type: "quality", level: 4, mode: "auto", missRatio: 0.03, webgl: true, stable: true }]);
  f.hub.detach(overlayWs);
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).overlays).toEqual([]);

  const streamer = await call(f, "streamer", "GET", "/api/state");
  expect(await asJson(streamer)).toMatchObject({ role: "streamer", actor: "twitch:dj" }); // linked: the same actor the broadcaster's own login yields
  const unlinked = mk({ config: (c) => (c.channel = { login: "", broadcasterId: "", displayName: "" }) });
  expect(await asJson(await call(unlinked, "streamer", "GET", "/api/state"))).toMatchObject({ role: "streamer", actor: "streamer@local" });
  const idOnly = mk({ config: (c) => (c.channel = { login: "dj", broadcasterId: "", displayName: "" }) }); // a login seeded from Secrets is not a link
  expect(await asJson(await call(idOnly, "streamer", "GET", "/api/state"))).toMatchObject({ role: "streamer", actor: "streamer@local" });
  expect(await asJson(await call(f, "streamer", "GET", "/api/state", { cookie: cookie("mod") }))).toMatchObject({ role: "streamer" }); // cookies are ignored there

  f.health.set("twitch", "warn", "Twitch EventSub: all sessions disconnected");
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).health).toEqual([{ id: "twitch", level: "warn", text: "Twitch EventSub: all sessions disconnected", at: T0.toISOString() }]);
});

test("a tpo_session that fails signature verification on the funnel → auth_failure {ip, path, reason} before the 401 / 302; expired or absent cookies are not recorded; the streamer listener ignores cookies", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "GET", "/api/state", { cookie: "tpo_session=forged.token", ip: "198.51.100.7" }), 401, "UNAUTHORIZED");
  expect(written(f)).toEqual([expect.objectContaining({ type: "auth_failure", actor: "system:auth", payload: { ip: "198.51.100.7", path: "/api/state", reason: "invalid session cookie" } })]);

  await errorOf(await call(f, "funnel", "POST", "/api/fire", { cookie: `${cookie("mod")}x` }), 401, "UNAUTHORIZED"); // tampered
  expect(last(f.ledger.all())).toMatchObject({ type: "auth_failure", payload: { ip: "203.0.113.9", path: "/api/fire", reason: "invalid session cookie" } });

  const ticketAsSession = `tpo_session=${sign(SECRET, "oauth", { uid: "200", login: "bob", role: "mod", exp: T0.getTime() + SESSION_TTL_MS })}`; // right key, wrong kind
  await errorOf(await call(f, "funnel", "GET", "/api/state", { cookie: ticketAsSession }), 401, "UNAUTHORIZED");
  expect(types(f)).toEqual(["auth_failure", "auth_failure", "auth_failure"]);

  const page = await call(f, "funnel", "GET", "/", { cookie: "tpo_session=forged.token" });
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/login");
  expect(last(f.ledger.all())).toMatchObject({ type: "auth_failure", payload: { path: "/", reason: "invalid session cookie" } });
  expect(types(f)).toHaveLength(4);

  // expired is ours, just old — a Dashboard tab left open overnight is not an intruder; no cookie at all is not either
  const expired = `tpo_session=${signSession(SECRET, { uid: "200", login: "bob", role: "mod", exp: T0.getTime() - 1 })}`;
  await errorOf(await call(f, "funnel", "GET", "/api/state", { cookie: expired }), 401, "UNAUTHORIZED");
  expect((await call(f, "funnel", "GET", "/", { cookie: expired })).status).toBe(302);
  await errorOf(await call(f, "funnel", "GET", "/api/state"), 401, "UNAUTHORIZED");
  expect((await call(f, "funnel", "GET", "/")).status).toBe(302);
  expect(types(f)).toHaveLength(4);

  // the streamer listener never reads the cookie: a forged one there is neither an error nor a tripwire hit
  expect((await call(f, "streamer", "GET", "/api/state", { cookie: "tpo_session=forged.token" })).status).toBe(200);
  expect((await call(f, "streamer", "GET", "/", { cookie: "tpo_session=forged.token" })).status).toBe(200);
  expect(types(f)).toHaveLength(4);
  expect(f.logs).toEqual([]);
});

test("mutations without the CSRF header → 403 CSRF on both listeners, before the role or the body is looked at", async () => {
  const f = mk();
  await errorOf(await call(f, "streamer", "POST", "/api/fire", { csrf: false, body: {} }), 403, "CSRF");
  await errorOf(await call(f, "funnel", "POST", "/api/fire", { csrf: false, body: {}, ...MOD }), 403, "CSRF");
  await errorOf(await call(f, "funnel", "POST", "/api/threshold", { csrf: false, body: { cents: 2500 }, ...MOD }), 403, "CSRF");
  await errorOf(await call(f, "streamer", "PUT", "/api/config", { csrf: false, body: "not json" }), 403, "CSRF");
  await errorOf(await call(f, "funnel", "POST", "/api/fire", { csrf: false }), 401, "UNAUTHORIZED"); // no session at all comes first
  expect(types(f)).toEqual([]);
});

test("unknown routes and methods → 404 JSON; /logout clears the session cookie; OAuth routes are mounted per listener", async () => {
  const f = mk();
  await errorOf(await call(f, "streamer", "GET", "/nope"), 404, "NOT_FOUND"); // `/` is the Dashboard's Live page (dashboard.test.ts)
  await errorOf(await call(f, "streamer", "GET", "/api/nope"), 404, "NOT_FOUND");
  await errorOf(await call(f, "streamer", "DELETE", "/api/state"), 404, "NOT_FOUND");
  await errorOf(await call(f, "streamer", "GET", "/api/fire"), 404, "NOT_FOUND");

  const logout = await call(f, "funnel", "GET", "/logout", MOD);
  expect(logout.status).toBe(302);
  expect(logout.headers.get("location")).toBe("/");
  expect(logout.headers.get("set-cookie")).toMatch(/^tpo_session=; Max-Age=0;/);

  const login = await call(f, "funnel", "GET", "/login");
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toStartWith(`${ID}/authorize?`);
  expect((await call(f, "streamer", "GET", "/login")).status).toBe(404);

  const link = await call(f, "streamer", "GET", "/auth/twitch/broadcaster");
  expect(link.status).toBe(302);
  expect(new URL(link.headers.get("location")!).searchParams.get("redirect_uri")).toBe("http://localhost:8700/auth/twitch/callback");
  expect((await call(f, "funnel", "GET", "/auth/twitch/broadcaster")).status).toBe(404);

  const callback = await call(f, "funnel", "GET", "/auth/twitch/callback?code=x&state=y");
  expect(callback.status).toBe(400); // no ticket cookie: the OAuth module answered, so the route is wired
  expect(last(f.ledger.all())).toMatchObject({ type: "auth_failure", actor: "system:auth" });
  expect((await call(f, "funnel", "GET", "/auth/twitch/other")).status).toBe(404);
});

test("unexpected errors → 500 with a generic message; the stack goes to the injected log, never to the client", async () => {
  const f = mk({
    config: (c) => (c.listeners.overlayOnLan = true), // the NICs are only read for the LAN addresses
    networkInterfaces: () => {
      throw new Error("nic-enumeration-exploded");
    },
  });
  const res = await call(f, "funnel", "GET", "/api/state", MOD);
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL", message: expect.any(String) } });
  expect(text).not.toContain("nic-enumeration-exploded");
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain("GET /api/state on funnel");
  expect(f.logs[0]).toContain("nic-enumeration-exploded");
  expect(f.logs[0]).toContain("api.ts"); // the stack, not just the message
});

test("request log lines: the Ko-fi hook path is a secret — every DEBUG request line and the 500 line print /hooks/kofi/<redacted> instead", async () => {
  const f = mk();
  const hook = `/hooks/kofi/${KOFI_PATH}`;
  expect((await call(f, "funnel", "POST", hook, { raw: kofiBody(), csrf: false })).status).toBe(200);
  expect((await call(f, "funnel", "POST", "/hooks/kofi/another-guess", { raw: kofiBody(), csrf: false })).status).toBe(404);
  expect((await call(f, "funnel", "GET", "/api/state", MOD)).status).toBe(200);
  expect(f.debugLines).toEqual([
    expect.stringMatching(/^POST \/hooks\/kofi\/<redacted> on funnel 200 \d+ms$/),
    expect.stringMatching(/^POST \/hooks\/kofi\/<redacted> on funnel 404 \d+ms$/),
    expect.stringMatching(/^GET \/api\/state on funnel 200 \d+ms$/), // other paths print as they are
  ]);

  // A body stream that dies mid-read is not an HttpError: the router's 500 line must mask the path too.
  const exploding = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("body-stream-exploded")) });
  const res = await f.app.handle(new Request(`${FUNNEL_URL}${hook}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: exploding }), "funnel");
  expect(res.status).toBe(500);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain("POST /hooks/kofi/<redacted> on funnel");
  expect(f.logs[0]).toContain("body-stream-exploded");
  expect(last(f.debugLines)).toMatch(/^POST \/hooks\/kofi\/<redacted> on funnel 500 \d+ms$/);
  for (const line of [...f.logs, ...f.debugLines]) {
    expect(line).not.toContain(KOFI_PATH);
    expect(line).not.toContain("another-guess");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Mod routes
// ---------------------------------------------------------------------------------------------------------------------

test("Manual Credit: POST /api/contributions credits a manual contribution and returns the post-state; validation → 400", async () => {
  const f = mk();
  const res = await call(f, "funnel", "POST", "/api/contributions", { body: { face: { kind: "tip", cents: 5000 }, displayName: "  alice ", message: "cash at the door" }, ...MOD });
  expect(res.status).toBe(200);
  const body = await asJson(res);
  expect(body).toEqual({ seq: BOOT_SEEDS + 1, unlocksBanked: 1, tiersOpened: [], state: f.engine.state }); // the first entry after the boot seeds
  expect(body.state).toMatchObject({ progressCents: 0, bankedTotal: 1 });
  const entry = f.ledger.get(BOOT_SEEDS + 1)!;
  expect(entry).toMatchObject({ type: "contribution", actor: "twitch:bob" });
  expect(entry.payload).toMatchObject({ source: "manual", face: { kind: "tip", cents: 5000 }, displayName: "alice", anonymous: false, message: "cash at the door", occurredAt: T0.toISOString(), progressCents: 5000, policyVersion: 1 });
  expect((entry.payload as { sourceId: string }).sourceId).toMatch(/^manual:[0-9a-f-]{36}$/);
  expect(types(f)).toEqual(["contribution", "unlock"]);

  expect((entry.payload as { loginHint?: string }).loginHint).toBe("alice"); // a login-shaped typed name is a Helix login= hint for the Avatar Picture
  expect("twitchUserId" in (entry.payload as object)).toBe(false); // never an id from a typed name

  const anon = await call(f, "streamer", "POST", "/api/contributions", { body: { face: { kind: "gift", tier: "2000", count: 3 } } });
  expect(anon.status).toBe(200);
  const anonSeq = BOOT_SEEDS + 3; // after alice's contribution + its unlock
  expect(f.ledger.get(anonSeq)!).toMatchObject({ actor: "twitch:dj", payload: { displayName: null, anonymous: true, face: { kind: "gift", tier: "2000", count: 3 }, progressCents: 1050 } });
  expect("message" in (f.ledger.get(anonSeq)!.payload as object)).toBe(false);
  expect(last(f.msgs)).toMatchObject({ type: "contribution", displayName: null, anonymous: true, faceValueCents: 3 * 999, progressCents: 1050 });


  for (const body of [
    {},
    { face: { kind: "tip" } },
    { face: { kind: "tip", cents: 12.5 } },
    { face: { kind: "tip", cents: 0 } },
    { face: { kind: "bits", bits: "100" } },
    { face: { kind: "sub", tier: "4000" } },
    { face: { kind: "sub", tier: "1000", months: 0 } },
    { face: { kind: "gift", tier: "prime" } },
    { face: { kind: "wheel" } },
    { face: { kind: "tip", cents: 100 }, displayName: 7 },
    "[]",
    "not json",
  ]) {
    const message = await errorOf(await call(f, "streamer", "POST", "/api/contributions", { body }), 400, "VALIDATION");
    expect(message.length).toBeGreaterThan(0);
  }
  expect(written(f)).toHaveLength(3);

  const sub = await call(f, "streamer", "POST", "/api/contributions", { body: { face: { kind: "sub", tier: "prime", months: 7 }, displayName: "carol" } });
  expect((await asJson(sub)).state.progressCents).toBe(1050 + 200);
});

test("Manual Credit (the Avatar Picture): a free-text typed name carries no login hint and never an id — only a login-shaped name is looked up", async () => {
  const f = mk();
  const freeText = await call(f, "funnel", "POST", "/api/contributions", { body: { face: { kind: "tip", cents: 100 }, displayName: "Emma O'Connell PhD" }, ...MOD });
  expect(freeText.status).toBe(200);
  const payload = last(f.ledger.all()).payload as object;
  expect("loginHint" in payload).toBe(false);
  expect("twitchUserId" in payload).toBe(false);

  const shaped = await call(f, "funnel", "POST", "/api/contributions", { body: { face: { kind: "tip", cents: 100 }, displayName: "Cool_User" }, ...MOD });
  expect(shaped.status).toBe(200);
  expect(last(f.ledger.all()).payload).toMatchObject({ displayName: "Cool_User", loginHint: "cool_user" });
});

test("POST /api/fire → FireResult and a fire message on the overlay; the actor override counts on the streamer listener only; empty queue → 409", async () => {
  const f = mk();
  await credit(f, 5000, "alice");
  await credit(f, 5000, null, "funnel");

  const res = await call(f, "streamer", "POST", "/api/fire", { body: { actor: "  Firebot !fire  " } });
  expect(res.status).toBe(200);
  const fire = (await asJson(res)) as FireResult;
  const [c, u, fireSeq] = [BOOT_SEEDS + 1, BOOT_SEEDS + 2, BOOT_SEEDS + 5]; // alice's contribution + unlock, the funnel credit's pair, then the fire
  expect(fire).toMatchObject({ seq: fireSeq, unlock: { seq: u, contributionSeq: c, solo: true }, outcome: { id: "stickers", left: 4, used: 1 }, contributor: { displayName: "alice", anonymous: false }, drained: false });
  expect(f.ledger.get(fireSeq)).toMatchObject({ type: "fire", actor: "twitch:dj via Firebot !fire", payload: { unlockSeq: u, outcomeId: "stickers", stockAfter: 4 } });
  expect(last(f.msgs)).toEqual({
    type: "fire",
    fireSeq,
    outcomeId: "stickers",
    solo: "alice", // $50 at $0: hers alone — the one case a drop names someone
    group: [{ key: moteWireKey("alice"), name: "alice", avatar: expect.any(String), avatarUrl: null, cents: 5000 }], // and her one Mote rides it
    stockAfter: 4,
    state: expect.objectContaining({ queue: 1, motes: { collecting: [], ready: [[{ key: moteWireKey(`anon:${BOOT_SEEDS + 3}`), name: null, avatar: "", avatarUrl: null, cents: 5000 }]] } }),
  });

  const viaFunnel = await call(f, "funnel", "POST", "/api/fire", { body: { actor: "someone else" }, ...MOD });
  expect(viaFunnel.status).toBe(200);
  expect(f.ledger.get(fireSeq + 1)).toMatchObject({ type: "fire", actor: "twitch:bob" });
  expect((await asJson(viaFunnel)).contributor).toEqual({ displayName: null, anonymous: true });
  expect(last(f.msgs)).toMatchObject({ type: "fire", fireSeq: fireSeq + 1, solo: null }); // a solo Unlock, but anonymous: no name on the wire

  const message = await errorOf(await call(f, "streamer", "POST", "/api/fire", { body: {} }), 409, "NO_UNLOCKS");
  expect(message).not.toStartWith("NO_UNLOCKS");
  expect(written(f)).toHaveLength(6);

  // the override is trimmed and capped at 40 characters; blank means no override; no body at all is fine
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire", { body: { actor: "x".repeat(60) } })).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe(`twitch:dj via ${"x".repeat(40)}`);
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire", { body: { actor: "   " } })).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe("twitch:dj");
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire")).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe("twitch:dj");
  await credit(f, 5000, "dave");
  expect((await f.app.handle(new Request(`${STREAMER_URL}/api/fire`, { method: "POST", headers: { ...CSRF, "content-length": "0" } }), "streamer")).status).toBe(200);
  await errorOf(await call(f, "streamer", "POST", "/api/fire", { body: { actor: 5 } }), 400, "VALIDATION");
  // control characters are stripped (a newline or NUL never reaches the Ledger's actor column) and the cap counts code points, not UTF-16 units
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire", { body: { actor: " Fire\u0000bot\n!fire\u007f\t " } })).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe("twitch:dj via Firebot!fire");
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire", { body: { actor: "🎉".repeat(60) } })).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe(`twitch:dj via ${"🎉".repeat(40)}`); // never a split surrogate pair
  await credit(f, 5000, "dave");
  expect((await call(f, "streamer", "POST", "/api/fire", { body: { actor: "\u0001\u001f" } })).status).toBe(200);
  expect(last(f.ledger.all()).actor).toBe("twitch:dj"); // nothing left after stripping → no override
});

test("locked-tier outcomes reach the overlay masked until their tier opens; the API always sees names", async () => {
  const f = mk();
  const snapshot = f.msgs[0]!;
  if (snapshot.type !== "snapshot") throw new Error(snapshot.type);
  const masked = snapshot.state.outcomes.filter((o) => o.name === null);
  expect(masked.map((o) => o.tier)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  expect(masked.every((o) => o.glyph === "🔒")).toBe(true);
  expect(masked.find((o) => o.id === "genre-roulette")!.nameLength).toBe("GENRE ROULETTE".length);

  const res = await call(f, "streamer", "POST", "/api/contributions", { body: { face: { kind: "bits", bits: 15000 }, displayName: "whale" } }); // $150 → 3 unlocks → tier 1
  expect((await asJson(res)).tiersOpened).toEqual([1]);
  const opened = last(f.msgs);
  if (opened.type !== "contribution") throw new Error(opened.type);
  expect(opened.state.tier).toBe(1);
  expect(opened.state.outcomes.find((o) => o.id === "genre-roulette")).toMatchObject({ name: "GENRE ROULETTE", glyph: "🎲" });
  expect(opened.state.outcomes.find((o) => o.id === "pie-to-the-face")).toMatchObject({ name: null, glyph: "🔒" });
  expect(JSON.stringify(opened)).not.toContain("PIE TO THE FACE");

  const state = (await asJson(await call(f, "funnel", "GET", "/api/state", MOD))).state;
  expect(state.outcomes.find((o: { id: string }) => o.id === "pie-to-the-face").name).toBe("PIE TO THE FACE");
});

test("POST /api/fires/:seq/winner appends a note {text, fireSeq, winner}; 404 unless seq is a fire; validation → 400", async () => {
  const f = mk();
  await credit(f, 5000, "alice");
  await call(f, "streamer", "POST", "/api/fire");
  const fireSeq = last(f.ledger.all()).seq;
  const res = await call(f, "funnel", "POST", `/api/fires/${fireSeq}/winner`, { body: { winner: " carol " }, ...MOD });
  expect(res.status).toBe(200);
  const { entry } = await asJson(res);
  expect(entry).toMatchObject({ seq: fireSeq + 1, type: "note", actor: "twitch:bob", payload: { text: `winner of fire #${fireSeq} (STICKERS): carol`, fireSeq, winner: "carol" } });
  expect(f.ledger.get(entry.seq)).toEqual(entry);
  expect(f.engine.state.lastSeq).toBe(fireSeq); // a note moves nothing

  await errorOf(await call(f, "streamer", "POST", "/api/fires/1/winner", { body: { winner: "carol" } }), 404, "NOT_FOUND"); // seq 1 is the threshold seed, not a fire
  await errorOf(await call(f, "streamer", "POST", "/api/fires/999/winner", { body: { winner: "carol" } }), 404, "NOT_FOUND");
  await errorOf(await call(f, "streamer", "POST", "/api/fires/abc/winner", { body: { winner: "carol" } }), 400, "VALIDATION");
  await errorOf(await call(f, "streamer", "POST", `/api/fires/${fireSeq}/winner`, { body: { winner: "  " } }), 400, "VALIDATION");
  await errorOf(await call(f, "streamer", "POST", `/api/fires/${fireSeq}/winner`, { body: {} }), 400, "VALIDATION");
  expect(types(f).filter((t) => t === "note")).toHaveLength(1);
});

test("GET /api/ledger pages newest first: default limit 50, max 200, before= bounds the page; bad query → 400", async () => {
  const f = mk();
  for (let i = 0; i < 3; i++) await credit(f, 100, `p${i}`);
  const all = await asJson(await call(f, "funnel", "GET", "/api/ledger", MOD));
  const total = BOOT_SEEDS + 3; // 3 credits after the boot seeds
  expect(all.entries.map((e: Entry) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => total - i));
  expect((await asJson(await call(f, "streamer", "GET", "/api/ledger?limit=2"))).entries.map((e: Entry) => e.seq)).toEqual([total, total - 1]);
  expect((await asJson(await call(f, "streamer", "GET", "/api/ledger?limit=2&before=3"))).entries.map((e: Entry) => e.seq)).toEqual([2, 1]);
  expect((await asJson(await call(f, "streamer", "GET", "/api/ledger?limit=999"))).entries).toHaveLength(total);
  for (const q of ["limit=0", "limit=abc", "limit=1.5", "before=x", "before=-1"]) await errorOf(await call(f, "streamer", "GET", `/api/ledger?${q}`), 400, "VALIDATION");
});

test("void, rebank, queue adjust, outcome status/restock and health dismiss route to the engine and health; engine rejections → 409 / 404", async () => {
  const f = mk();
  const seq = await credit(f, 5000, "alice");
  expect((await asJson(await call(f, "funnel", "POST", "/api/queue/adjust", { body: { delta: 2, reason: "raid bonus" }, ...MOD }))).state.queue).toHaveLength(3);
  expect(last(f.msgs)).toMatchObject({ type: "state", reason: "queue_adjust", tiersOpened: [1] });

  expect((await asJson(await call(f, "funnel", "POST", `/api/contributions/${seq}/void`, { body: { reason: "refunded" }, ...MOD }))).state.progressCents).toBe(0);
  expect(last(f.ledger.all())).toMatchObject({ type: "void", actor: "twitch:bob", payload: { contributionSeq: seq, reason: "refunded" } });
  await errorOf(await call(f, "funnel", "POST", `/api/contributions/${seq}/void`, { body: { reason: "again" }, ...MOD }), 409, "INVALID");
  await errorOf(await call(f, "funnel", "POST", "/api/contributions/999/void", { body: { reason: "x" }, ...MOD }), 404, "UNKNOWN_ENTRY");

  await call(f, "streamer", "POST", "/api/fire");
  const fireSeq = last(f.ledger.all()).seq;
  const rebank = await asJson(await call(f, "funnel", "POST", `/api/fires/${fireSeq}/rebank`, { body: { reason: "guest absent" }, ...MOD }));
  expect(rebank.state.queue).toHaveLength(3);
  expect(rebank.state.outcomes.find((o: { id: string }) => o.id === "stickers")).toMatchObject({ left: 5, used: 0 });
  await errorOf(await call(f, "funnel", "POST", `/api/fires/${fireSeq}/rebank`, { body: { reason: "twice" }, ...MOD }), 409, "INVALID");

  expect((await asJson(await call(f, "funnel", "POST", "/api/outcomes/stickers/status", { body: { status: "suspended" }, ...MOD }))).state.outcomes[0].status).toBe("suspended");
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes/stickers/status", { body: { status: "gone" }, ...MOD }), 400, "VALIDATION");
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes/nope/status", { body: { status: "live" }, ...MOD }), 404, "UNKNOWN_OUTCOME");
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes/%E0%A4%A/status", { body: { status: "live" }, ...MOD }), 400, "VALIDATION"); // malformed percent-encoding is a 400, not a 500
  expect(f.logs).toEqual([]);
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes/stickers/restock", { body: { charges: 1 }, ...MOD }), 409, "NOT_RESTOCKABLE");
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes/accent-switch/restock", { body: { charges: 0 }, ...MOD }), 400, "VALIDATION");
  const restocked = await asJson(await call(f, "funnel", "POST", "/api/outcomes/accent-switch/restock", { body: { charges: 2 }, ...MOD }));
  expect(restocked.state.outcomes.find((o: { id: string }) => o.id === "accent-switch")).toMatchObject({ left: 3, used: 0 });

  f.health.set("kofi", "info", "Service (re)started");
  expect(await asJson(await call(f, "funnel", "POST", "/api/health/kofi/dismiss", MOD))).toEqual({ ok: true });
  expect(f.health.list()).toEqual([]);
  expect(await asJson(await call(f, "funnel", "POST", "/api/health/unknown/dismiss", MOD))).toEqual({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Streamer-only routes
// ---------------------------------------------------------------------------------------------------------------------

test("POST /api/threshold: mod → 403; streamer → threshold entry + config file updated, no config_change entry; validation → 400", async () => {
  const f = mk();
  await credit(f, 3700, "alice");
  await errorOf(await call(f, "funnel", "POST", "/api/threshold", { body: { cents: 2500 }, ...MOD }), 403, "FORBIDDEN");
  expect(f.config.get().threshold.cents).toBe(5000);

  const viaFunnel = await call(f, "funnel", "POST", "/api/threshold", { body: { cents: 2500 }, cookie: cookie("streamer") });
  expect(viaFunnel.status).toBe(200);
  expect(await asJson(viaFunnel)).toEqual({ unlocksBanked: 1, state: f.engine.state });
  expect(f.engine.state).toMatchObject({ thresholdCents: 2500, progressCents: 1200 });
  expect(last(f.ledger.all())).toMatchObject({ type: "unlock", actor: "twitch:dj" });
  expect(types(f)).toEqual(["contribution", "threshold", "unlock"]);
  expect(f.config.get().threshold.cents).toBe(2500);
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).threshold.cents).toBe(2500);
  expect(last(f.msgs)).toMatchObject({ type: "state", reason: "threshold", state: { thresholdCents: 2500 } });

  expect((await call(f, "streamer", "POST", "/api/threshold", { body: { cents: 2000 } })).status).toBe(200);
  expect(written(f).filter((e) => e.type === "threshold").map((e) => e.actor)).toEqual(["twitch:dj", "twitch:dj"]); // the broadcaster's funnel session and the streamer listener are the same actor
  for (const cents of [0, -5, 12.5, "2500", null]) await errorOf(await call(f, "streamer", "POST", "/api/threshold", { body: { cents } }), 400, "VALIDATION");
  expect(f.config.get().threshold.cents).toBe(2000);
});

test("GET/PUT /api/config: streamer-only; PUT validates (400 with the ConfigError text), persists, records config_change with the diff, re-skins the overlay", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "GET", "/api/config", MOD), 403, "FORBIDDEN");
  await errorOf(await call(f, "funnel", "PUT", "/api/config", { body: f.config.get(), ...MOD }), 403, "FORBIDDEN");
  expect(await asJson(await call(f, "streamer", "GET", "/api/config"))).toEqual({ config: f.config.get() });

  const next = structuredClone(f.config.get());
  const themeBefore = next.overlay.theme; // the default (chrome-lounge) — the diff reports whatever it was
  next.overlay.theme = "duck-farm";
  next.overlay.brand = "DJ EXAMPLE";
  const res = await call(f, "streamer", "PUT", "/api/config", { body: next });
  expect(res.status).toBe(200);
  const diff = [
    { path: "overlay.brand", from: "", to: "DJ EXAMPLE" },
    { path: "overlay.theme", from: themeBefore, to: "duck-farm" },
  ];
  expect(await asJson(res)).toEqual({ config: next, diff });
  expect(f.config.get()).toEqual(next);
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).overlay.theme).toBe("duck-farm");
  expect(last(f.ledger.all())).toMatchObject({ type: "config_change", actor: "twitch:dj", payload: { diff } });
  expect(last(f.msgs)).toEqual({ type: "skin", skin: { config: next.overlay, theme: next.themes["duck-farm"]!, channelName: "DJ Example", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } } });

  const entries = f.ledger.all().length;
  const messages = f.msgs.length;
  expect((await call(f, "streamer", "PUT", "/api/config", { body: next })).status).toBe(200); // no-op: nothing recorded, nothing re-skinned
  expect(f.ledger.all()).toHaveLength(entries);
  expect(f.msgs).toHaveLength(messages);

  const bad = structuredClone(next);
  bad.tiers.gates = [1, 2];
  const message = await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: bad }), 400, "VALIDATION");
  expect(message).toContain("tiers.gates");
  await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: "[]" }), 400, "VALIDATION");
  expect(f.config.get()).toEqual(next);
  expect(f.ledger.all()).toHaveLength(entries);
});

test("PUT /api/config with edited draw lists: 200, the config holds the new lists, the config_change diff paths start with lists.; emptying a list an Outcome draws from is a 400 naming the Outcome", async () => {
  const f = mk();
  const next = structuredClone(f.config.get());
  next.lists.chatRules = ["SPEAK ONLY IN QUESTIONS", "THIRD-PERSON MODE"];
  next.lists.genreRoulette = [...next.lists.genreRoulette, "AMAPIANO"];
  const res = await call(f, "streamer", "PUT", "/api/config", { body: next });
  expect(res.status).toBe(200);
  expect(f.config.get().lists).toEqual(next.lists);
  const entry = last(f.ledger.all()) as { type: string; payload: { diff: { path: string }[] } };
  expect(entry.type).toBe("config_change");
  expect(entry.payload.diff.length).toBeGreaterThan(0);
  for (const d of entry.payload.diff) expect(d.path).toMatch(/^lists\.(chatRules|genreRoulette)\.\d+$/);
  expect(entry.payload.diff.some((d) => d.path.startsWith("lists.chatRules."))).toBe(true);
  expect(entry.payload.diff.some((d) => d.path === `lists.genreRoulette.${next.lists.genreRoulette.length - 1}`)).toBe(true);

  const bad = structuredClone(f.config.get());
  bad.lists.chatRules = [];
  const message = await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: bad }), 400, "VALIDATION");
  expect(message).toContain("lists.chatRules");
  expect(message).toContain("CHAT-RULE DRAW");
  expect(f.config.get().lists).toEqual(next.lists);

  const dup = structuredClone(f.config.get());
  dup.lists.chatRules.push("THIRD-PERSON MODE");
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: dup }), 400, "VALIDATION")).toContain("lists.chatRules.2");

  // the save path has no mercy for what the load path forgives (a hand-edited file normalises instead — see store.test)
  const long = structuredClone(f.config.get());
  long.lists.chatRules.push("R".repeat(70));
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: long }), 400, "VALIDATION")).toContain("lists.chatRules.2: must be at most 60");
  expect(f.config.get().lists).toEqual(next.lists);
});

test("PUT /api/config with lower-case draw-list items stores them in CAPS — the response, the config and the config_change diff all carry the upper-cased items", async () => {
  const f = mk();
  const next = structuredClone(f.config.get());
  next.lists.chatRules = ["speak only in questions", "Third-Person Mode"];
  const res = await call(f, "streamer", "PUT", "/api/config", { body: next });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { config: Config }).config.lists.chatRules).toEqual(["SPEAK ONLY IN QUESTIONS", "THIRD-PERSON MODE"]);
  expect(f.config.get().lists.chatRules).toEqual(["SPEAK ONLY IN QUESTIONS", "THIRD-PERSON MODE"]);
  const entry = last(f.ledger.all()) as { type: string; payload: { diff: { path: string; to: unknown }[] } };
  expect(entry.type).toBe("config_change");
  const paths = entry.payload.diff.map((d) => d.path);
  expect(paths).toContain("lists.chatRules.0");
  expect(paths.every((p) => p.startsWith("lists.chatRules."))).toBe(true);
  expect(entry.payload.diff.find((d) => d.path === "lists.chatRules.0")!.to).toBe("SPEAK ONLY IN QUESTIONS"); // the diff records what was stored, not what was typed
  // a lower-case repeat of an upper-case item is a duplicate (the Dashboard editors dedupe before the PUT; the JSON editor sees the problem)
  const dup = structuredClone(f.config.get());
  dup.lists.chatRules.push("third-person mode");
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/config", { body: dup }), 400, "VALIDATION")).toContain('lists.chatRules.2: duplicate item "THIRD-PERSON MODE"');
  expect(f.config.get().lists.chatRules).toEqual(["SPEAK ONLY IN QUESTIONS", "THIRD-PERSON MODE"]);
});

test("PUT /api/config with a changed threshold.cents applies it to the Engine too (threshold entry, crossings banked) — not only to the file; an unchanged threshold appends no threshold entry", async () => {
  const f = mk();
  await credit(f, 3700, "alice");
  const next = structuredClone(f.config.get());
  next.overlay.brand = "DJ EXAMPLE";
  expect((await call(f, "streamer", "PUT", "/api/config", { body: next })).status).toBe(200);
  expect(types(f)).toEqual(["contribution", "config_change"]);
  expect(f.engine.state.thresholdCents).toBe(5000);

  next.threshold.cents = 2500;
  const res = await call(f, "funnel", "PUT", "/api/config", { body: next, cookie: cookie("streamer") });
  expect(res.status).toBe(200);
  expect((await asJson(res)).diff).toEqual([{ path: "threshold.cents", from: 5000, to: 2500 }]);
  expect(f.engine.state).toMatchObject({ thresholdCents: 2500, progressCents: 1200, bankedTotal: 1 }); // $37 against $25 → one Unlock, $12 carried
  expect(types(f)).toEqual(["contribution", "config_change", "threshold", "unlock", "config_change"]);
  expect(written(f)[2]).toMatchObject({ type: "threshold", actor: "twitch:dj", payload: { cents: 2500 } });
  expect(f.config.get().threshold.cents).toBe(2500);
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).threshold.cents).toBe(2500);
  expect(f.msgs.slice(-2).map((m) => m.type)).toEqual(["state", "skin"]);
  expect(f.msgs.at(-2)).toMatchObject({ type: "state", reason: "threshold", state: { thresholdCents: 2500 } });

  expect((await call(f, "streamer", "PUT", "/api/config", { body: next })).status).toBe(200); // same config again: no diff, no threshold entry
  expect(types(f)).toHaveLength(5);
  expect(await asJson(await call(f, "streamer", "GET", "/api/state"))).toMatchObject({ state: { thresholdCents: 2500 } });
});

test("PUT /api/config decides a Threshold edit against the Engine, not the file: after drift (file 3500, Engine 5000) a PUT of 3500 and a PUT of 4000 both reach the Engine", async () => {
  const f = mk();
  await credit(f, 3700, "alice");
  const drifted = structuredClone(f.config.get());
  drifted.threshold.cents = 3500;
  f.config.update(drifted); // the file moved under the Engine (a hand edit picked up by the watcher): the Engine still says 5000
  expect(f.config.get().threshold.cents).toBe(3500);
  expect(f.engine.state.thresholdCents).toBe(5000);

  const same = structuredClone(f.config.get()); // the editor saves the file's 3500 unchanged
  expect((await call(f, "streamer", "PUT", "/api/config", { body: same })).status).toBe(200);
  expect(f.engine.state).toMatchObject({ thresholdCents: 3500, progressCents: 200, bankedTotal: 1 }); // $37 against $35 → one Unlock, $2 carried
  expect(types(f)).toEqual(["contribution", "threshold", "unlock"]);
  expect(written(f)[1]).toMatchObject({ type: "threshold", actor: "twitch:dj", payload: { cents: 3500 } });

  const next = structuredClone(f.config.get());
  next.threshold.cents = 4000;
  const res = await call(f, "streamer", "PUT", "/api/config", { body: next });
  expect(res.status).toBe(200);
  expect((await asJson(res)).diff).toEqual([{ path: "threshold.cents", from: 3500, to: 4000 }]);
  expect(f.engine.state).toMatchObject({ thresholdCents: 4000, progressCents: 200 });
  expect(types(f)).toEqual(["contribution", "threshold", "unlock", "threshold", "config_change"]);
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).threshold.cents).toBe(4000);
});

test("POST /api/cue broadcasts to the overlay and never touches the Ledger; streamer-only; validation → 400", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "POST", "/api/cue", { body: { name: "beat" }, ...MOD }), 403, "FORBIDDEN");
  expect(await asJson(await call(f, "streamer", "POST", "/api/cue", { body: { name: "beat", value: 0.8 } }))).toEqual({ ok: true });
  expect(last(f.msgs)).toEqual({ type: "cue", name: "beat", value: 0.8 });
  expect(await asJson(await call(f, "funnel", "POST", "/api/cue", { body: { name: "drop" }, cookie: cookie("streamer") }))).toEqual({ ok: true });
  expect(last(f.msgs)).toEqual({ type: "cue", name: "drop" });
  for (const body of [{}, { name: "" }, { name: 3 }, { name: "beat", value: "high" }, { name: "beat", value: Number.NaN }]) {
    await errorOf(await call(f, "streamer", "POST", "/api/cue", { body }), 400, "VALIDATION");
  }
  expect(written(f)).toEqual([]);
});

test("POST /api/shutdown: streamer-only; needs confirm SHUTDOWN (400 otherwise, hook untouched); 200 + a Ledger note + a log line, and the hook fires only after the response has gone out", async () => {
  const shutdowns: string[] = [];
  const f = mk({ onShutdownRequest: (source) => void shutdowns.push(source) });
  await errorOf(await call(f, "funnel", "POST", "/api/shutdown", { body: { confirm: "SHUTDOWN" }, ...MOD }), 403, "FORBIDDEN");
  // the broadcaster's own phone session is role streamer, but only the streamer listener may stop the show
  await errorOf(await call(f, "funnel", "POST", "/api/shutdown", { body: { confirm: "SHUTDOWN" }, cookie: cookie("streamer") }), 403, "FORBIDDEN");
  expect(shutdowns).toEqual([]);
  await errorOf(await call(f, "streamer", "POST", "/api/shutdown", { csrf: false, body: { confirm: "SHUTDOWN" } }), 403, "CSRF");
  for (const body of [{}, { confirm: "" }, { confirm: "shutdown" }, { confirm: "yes" }, { confirm: true }]) {
    await errorOf(await call(f, "streamer", "POST", "/api/shutdown", { body }), 400, "VALIDATION");
  }
  await errorOf(await call(f, "streamer", "POST", "/api/shutdown", {}), 400, "VALIDATION"); // no body at all
  await Bun.sleep(SHUTDOWN_DELAY_MS + 100);
  expect(shutdowns).toEqual([]);
  expect(written(f)).toEqual([]);

  const res = await call(f, "streamer", "POST", "/api/shutdown", { body: { confirm: "SHUTDOWN" } });
  expect(res.status).toBe(200);
  expect(await asJson(res)).toEqual({ ok: true, inMs: SHUTDOWN_DELAY_MS });
  expect(shutdowns).toEqual([]); // the response first; the process goes down on a timer
  // the fixture's channel is linked, so the streamer listener acts as the broadcaster: the note and the console line name twitch:dj
  expect(written(f)).toEqual([expect.objectContaining({ type: "note", actor: "twitch:dj", payload: { text: "Shut down from the Dashboard by twitch:dj" } })]);
  expect(f.logs).toContain("shutdown requested from the Dashboard by twitch:dj");
  await Bun.sleep(SHUTDOWN_DELAY_MS + 100);
  expect(shutdowns).toEqual(["dashboard"]);
});

test("POST /api/chatters/fake and /hop (Debug): streamer only; a made-up person walks on and can be hopped; nobody there → 409; nothing written, nothing to Firebot", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "POST", "/api/chatters/fake", MOD), 403, "FORBIDDEN");
  await errorOf(await call(f, "funnel", "POST", "/api/chatters/hop", MOD), 403, "FORBIDDEN");
  expect(f.chatters.count()).toBe(0);

  const empty = await errorOf(await call(f, "streamer", "POST", "/api/chatters/hop"), 409, "INVALID");
  expect(empty).toBe("Nobody is on the floor yet");

  const ledgerBefore = f.ledger.all().length;
  const firebotBefore = f.firebotCalls.length;
  const res = await call(f, "streamer", "POST", "/api/chatters/fake");
  expect(res.status).toBe(200);
  expect(await asJson(res)).toEqual({ chatter: { key: "f1", name: "fake_1", avatarUrl: "https://static-cdn.jtvnw.net/user-default-pictures-uv/default-profile_image-150x150.png", firstSeenMs: T0.getTime() + 1, lastSeenMs: T0.getTime() + 1 } });
  expect(f.chatters.count()).toBe(1);
  expect((await asJson(await call(f, "streamer", "POST", "/api/chatters/fake"))).chatter.name).toBe("fake_2"); // repeat presses add more people

  const hop = await call(f, "funnel", "POST", "/api/chatters/hop", { cookie: cookie("streamer") }); // the broadcaster's phone may press it too
  expect(hop.status).toBe(200);
  expect((await asJson(hop)).chatter.key).toBe("f1");
  expect(f.chatters.hops).toEqual(["f1"]);

  expect(f.ledger.all().length).toBe(ledgerBefore); // Presence, never Progress
  expect(f.firebotCalls.length).toBe(firebotBefore); // nothing reaches chat
});

test("POST /api/shutdown without a hook wired (a bare boot, no main) is a 503 and writes nothing", async () => {
  const f = mk();
  await errorOf(await call(f, "streamer", "POST", "/api/shutdown", { body: { confirm: "SHUTDOWN" } }), 503, "UNAVAILABLE");
  expect(written(f)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Outcome editor: definitions in config.json, Left in the Ledger, editor acts as outcome_change
// ---------------------------------------------------------------------------------------------------------------------

const onDisk = (f: Fixture, id: string) => JSON.parse(fs.readFileSync(f.configPath, "utf8")).outcomes.find((o: { id: string }) => o.id === id);
const inEngine = (f: Fixture, id: string) => f.engine.state.outcomes.find((o) => o.id === id);
const VINYL = { name: "Vinyl Only!", glyph: "💿", shape: "challenge", tier: 0, occupancy: "1 transition", description: "  Vinyl only for the next transition. ", restockable: true, left: 2 };
const VINYL_DEF = { id: "vinyl-only", name: "Vinyl Only!", glyph: "💿", shape: "challenge" as const, tier: 0, initialLeft: 2, restockable: true, occupancy: "1 transition", description: "Vinyl only for the next transition." };

test("POST /api/outcomes: streamer-only; the id is slugged from the name (-2 when taken); config gains the def with initialLeft = left; the Ledger gets the stock seed then outcome_change add; the overlay hears; invalid input → 400 and nothing changes", async () => {
  const f = mk();
  const pool = f.config.get().outcomes.length;
  await errorOf(await call(f, "funnel", "POST", "/api/outcomes", { body: VINYL, ...MOD }), 403, "FORBIDDEN");
  await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: VINYL, csrf: false }), 403, "CSRF");
  expect(written(f)).toEqual([]);

  const res = await call(f, "streamer", "POST", "/api/outcomes", { body: VINYL });
  expect(res.status).toBe(201);
  const added = await asJson(res);
  expect(added.outcome).toEqual({ ...VINYL_DEF, status: "live", left: 2, used: 0 });
  expect(added.state).toEqual(f.engine.state);
  expect(last(f.config.get().outcomes)).toEqual(VINYL_DEF);
  expect(onDisk(f, "vinyl-only")).toEqual(VINYL_DEF);
  expect(written(f)).toEqual([
    expect.objectContaining({ type: "stock", actor: "twitch:dj", payload: { outcomeId: "vinyl-only", delta: 2, reason: "initial" } }),
    expect.objectContaining({
      type: "outcome_change",
      actor: "twitch:dj",
      payload: {
        outcomeId: "vinyl-only",
        action: "add",
        changes: { name: { to: "Vinyl Only!" }, glyph: { to: "💿" }, shape: { to: "challenge" }, tier: { to: 0 }, occupancy: { to: "1 transition" }, description: { to: "Vinyl only for the next transition." }, restockable: { to: true }, left: { to: 2 } },
      },
    }),
  ]);
  expect(last(f.msgs)).toMatchObject({ type: "state", reason: "outcomes" });
  expect((last(f.msgs) as { state: { outcomes: unknown[] } }).state.outcomes).toContainEqual(expect.objectContaining({ id: "vinyl-only", name: "Vinyl Only!" }));

  // the same name again: the id gets -2; a giveaway may carry raffle and a mini-draw; the name is trimmed
  const again = await asJson(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, name: "  Vinyl Only ", shape: "giveaway", raffle: true, miniDraw: "genreRoulette", left: 0, description: undefined } }));
  expect(again.outcome).toMatchObject({ id: "vinyl-only-2", name: "Vinyl Only", shape: "giveaway", raffle: true, miniDraw: "genreRoulette", left: 0, used: 0, description: "" }); // no What it is line yet: "" — never missing
  expect(written(f).slice(2)).toEqual([
    expect.objectContaining({ type: "stock", payload: { outcomeId: "vinyl-only-2", delta: 0, reason: "initial" } }),
    expect.objectContaining({ type: "outcome_change", payload: expect.objectContaining({ outcomeId: "vinyl-only-2", action: "add", changes: expect.objectContaining({ raffle: { to: true }, miniDraw: { to: "genreRoulette" }, left: { to: 0 } }) }) }),
  ]);
  expect(f.config.get().outcomes).toHaveLength(pool + 2);

  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, raffle: true } }), 400, "VALIDATION")).toBe("Firebot raffle is for giveaways only");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, tier: 7 } }), 400, "VALIDATION")).toContain("tier: 7 has no gate");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, shape: "prize" } }), 400, "VALIDATION")).toContain("shape");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, restockable: "yes" } }), 400, "VALIDATION")).toContain("restockable");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, description: 5 } }), 400, "VALIDATION")).toContain("description must be a string");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body: { ...VINYL, description: "x".repeat(241) } }), 400, "VALIDATION")).toContain("description: at most 240 characters");
  for (const body of [{ ...VINYL, left: -1 }, { ...VINYL, left: 1.5 }, { ...VINYL, left: undefined }, { ...VINYL, name: "  " }, { ...VINYL, name: 3 }, { ...VINYL, glyph: null }, [], "x"]) {
    await errorOf(await call(f, "streamer", "POST", "/api/outcomes", { body }), 400, "VALIDATION");
  }
  expect(f.config.get().outcomes).toHaveLength(pool + 2);
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).outcomes).toHaveLength(pool + 2);
  expect(written(f)).toHaveLength(4);
  expect(f.logs).toEqual([]);
});

// a config.json that boots always saves. A hand-edited 70-character rule and a 300-character What it is line load
// clamped (store.ts logs it); the strict re-validation behind every PUT then has nothing to refuse.
test("after booting on a hand-edited config (an over-long list item, an over-long description) an Outcome edit and a whole-config PUT both succeed", async () => {
  const f = mk({
    config: (c) => {
      c.lists.chatRules.push("R".repeat(70));
      c.outcomes[7]!.description = "D".repeat(300);
    },
  });
  expect(f.config.get().lists.chatRules.at(-1)).toBe("R".repeat(60));
  expect(f.config.get().outcomes[7]!.description).toBe("D".repeat(240));
  const id = f.config.get().outcomes[7]!.id;
  const res = await call(f, "streamer", "PUT", `/api/outcomes/${id}`, { body: { occupancy: "~5 min" } });
  expect(res.status).toBe(200);
  expect((await asJson(res)).outcome).toMatchObject({ occupancy: "~5 min" });
  const stickers = await call(f, "streamer", "PUT", "/api/outcomes/stickers", { body: { tier: 1 } });
  expect(stickers.status).toBe(200);
  const whole = await call(f, "streamer", "PUT", "/api/config", { body: { ...f.config.get(), threshold: { ...f.config.get().threshold, cents: 4000 } } });
  expect(whole.status).toBe(200);
});

test("PUT /api/outcomes/:id: streamer-only; definition edits → config + outcome_change with only the changed fields; left → one stock entry (left edit); nothing written when nothing changed; raffle off a giveaway → 400; id / initialLeft / used in the body are ignored", async () => {
  const f = mk();
  expect((await call(f, "streamer", "POST", "/api/outcomes", { body: VINYL })).status).toBe(201);
  const before = written(f).length;
  await errorOf(await call(f, "funnel", "PUT", "/api/outcomes/vinyl-only", { body: { tier: 1 }, ...MOD }), 403, "FORBIDDEN");
  await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/nope", { body: { tier: 1 } }), 404, "UNKNOWN_OUTCOME");

  const res = await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { tier: 1, left: 5 } });
  expect(res.status).toBe(200);
  const edited = await asJson(res);
  expect(edited.outcome).toEqual({ ...VINYL_DEF, tier: 1, status: "live", left: 5, used: 0 });
  expect(edited.state).toEqual(f.engine.state);
  expect(written(f).slice(before)).toEqual([
    expect.objectContaining({ type: "outcome_change", actor: "twitch:dj", payload: { outcomeId: "vinyl-only", action: "edit", changes: { tier: { from: 0, to: 1 } } } }),
    expect.objectContaining({ type: "stock", actor: "twitch:dj", payload: { outcomeId: "vinyl-only", delta: 3, reason: "left edit" } }),
  ]);
  expect(onDisk(f, "vinyl-only")).toEqual({ ...VINYL_DEF, tier: 1 }); // initialLeft stays 2: Left lives in the Ledger, not the file
  expect(inEngine(f, "vinyl-only")).toMatchObject({ tier: 1, left: 5 });
  expect(last(f.msgs)).toMatchObject({ type: "state", reason: "stock" });

  // the same edit again, and fields the editor may not set: nothing changes, nothing is written
  const messages = f.msgs.length;
  expect((await asJson(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { tier: 1, left: 5, id: "hijack", initialLeft: 9, used: 3, status: "retired" } }))).outcome).toMatchObject({ id: "vinyl-only", initialLeft: 2, used: 0, status: "live" });
  expect((await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: {} })).status).toBe(200);
  expect(written(f)).toHaveLength(before + 2);
  expect(f.msgs).toHaveLength(messages);
  expect(f.config.get().outcomes.some((o) => o.id === "hijack")).toBe(false);

  // raffle is for giveaways: refused on a challenge, accepted with the shape change in the same save
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { raffle: true } }), 400, "VALIDATION")).toBe("Firebot raffle is for giveaways only");
  expect(written(f)).toHaveLength(before + 2);
  expect((await asJson(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { shape: "giveaway", raffle: true } }))).outcome).toMatchObject({ shape: "giveaway", raffle: true });
  expect(last(written(f))).toMatchObject({ type: "outcome_change", payload: { action: "edit", changes: { shape: { from: "challenge", to: "giveaway" }, raffle: { to: true } } } });
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { shape: "stunt" } }), 400, "VALIDATION")).toBe("Firebot raffle is for giveaways only"); // still a raffle
  expect((await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { shape: "stunt", raffle: false } })).status).toBe(200);
  expect(onDisk(f, "vinyl-only")).toMatchObject({ shape: "stunt", raffle: false });

  // the What it is line: trimmed, its edit lands in outcome_change, "" allowed, 241 characters refused
  expect((await asJson(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { description: "  Wax only — no USBs for one transition.  " } }))).outcome).toMatchObject({ description: "Wax only — no USBs for one transition." });
  expect(last(written(f))).toMatchObject({ type: "outcome_change", payload: { action: "edit", changes: { description: { from: "Vinyl only for the next transition.", to: "Wax only — no USBs for one transition." } } } });
  expect(onDisk(f, "vinyl-only")).toMatchObject({ description: "Wax only — no USBs for one transition." });
  expect((await asJson(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { description: "" } }))).outcome).toMatchObject({ description: "" });
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { description: "x".repeat(241) } }), 400, "VALIDATION")).toContain("description: at most 240 characters");
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { description: null } }), 400, "VALIDATION")).toContain("description must be a string");

  // a mini-draw comes and goes (null clears it and the key leaves the file)
  expect((await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { miniDraw: "genreRoulette" } })).status).toBe(200);
  expect(last(written(f))).toMatchObject({ type: "outcome_change", payload: { changes: { miniDraw: { to: "genreRoulette" } } } });
  expect((await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { miniDraw: null } })).status).toBe(200);
  expect(last(written(f))).toMatchObject({ type: "outcome_change", payload: { changes: { miniDraw: { from: "genreRoulette" } } } });
  expect("miniDraw" in onDisk(f, "vinyl-only")).toBe(false);
  expect(inEngine(f, "vinyl-only")?.miniDraw).toBeUndefined();

  // validation through validateConfig on the candidate; a bad Left never reaches the Ledger
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { tier: 9 } }), 400, "VALIDATION")).toContain("tier: 9 has no gate");
  expect(await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body: { miniDraw: "weather" } }), 400, "VALIDATION")).toContain("miniDraw");
  const entries = written(f).length;
  for (const body of [{ left: 1.5 }, { left: -1 }, { left: "5" }, { name: "" }, { tier: 1, left: -1 }, [], "x"]) await errorOf(await call(f, "streamer", "PUT", "/api/outcomes/vinyl-only", { body }), 400, "VALIDATION");
  expect(written(f)).toHaveLength(entries);
  expect(onDisk(f, "vinyl-only")).toEqual(f.config.get().outcomes.find((o) => o.id === "vinyl-only"));
  expect(f.logs).toEqual([]);
});

test("DELETE /api/outcomes/:id: streamer-only; 409 OUTCOME_USED once it has come up; else Left is zeroed (stock 'deleted') and the definition leaves config; a re-added id is seeded again by the route, not by reproject", async () => {
  const f = mk();
  await errorOf(await call(f, "funnel", "DELETE", "/api/outcomes/stickers", MOD), 403, "FORBIDDEN");
  await errorOf(await call(f, "streamer", "DELETE", "/api/outcomes/stickers", { csrf: false }), 403, "CSRF");
  await errorOf(await call(f, "streamer", "DELETE", "/api/outcomes/nope"), 404, "UNKNOWN_OUTCOME");
  expect(written(f)).toEqual([]);

  await credit(f, 5000, "alice");
  expect((await asJson(await call(f, "streamer", "POST", "/api/fire"))).outcome).toMatchObject({ id: "stickers" });
  expect(await errorOf(await call(f, "streamer", "DELETE", "/api/outcomes/stickers"), 409, "OUTCOME_USED")).toBe("Used 1 — retire it instead");
  expect(onDisk(f, "stickers")).toBeDefined();
  expect(inEngine(f, "stickers")).toMatchObject({ left: 4, used: 1 });
  const before = written(f).length;

  const res = await call(f, "streamer", "DELETE", "/api/outcomes/shirt-t0"); // Left 1, never came up
  expect(res.status).toBe(200);
  expect(await asJson(res)).toEqual({ state: f.engine.state });
  expect(inEngine(f, "shirt-t0")).toBeUndefined();
  expect(f.config.get().outcomes.some((o) => o.id === "shirt-t0")).toBe(false);
  expect(onDisk(f, "shirt-t0")).toBeUndefined();
  expect(written(f).slice(before)).toEqual([
    expect.objectContaining({ type: "stock", actor: "twitch:dj", payload: { outcomeId: "shirt-t0", delta: -1, reason: "deleted" } }),
    expect.objectContaining({ type: "outcome_change", actor: "twitch:dj", payload: { outcomeId: "shirt-t0", action: "delete", changes: expect.objectContaining({ name: { from: "SHIRT" }, tier: { from: 0 }, raffle: { from: true } }) } }),
  ]);
  expect(f.engine.state.records["shirt-t0"]).toMatchObject({ left: 0, used: 0, seeded: true });
  expect(last(f.msgs)).toMatchObject({ type: "state", reason: "outcomes" });
  expect((last(f.msgs) as { state: { outcomes: { id: string }[] } }).state.outcomes.some((o) => o.id === "shirt-t0")).toBe(false);
  await errorOf(await call(f, "streamer", "DELETE", "/api/outcomes/shirt-t0"), 404, "UNKNOWN_OUTCOME");

  // the id comes back — its record is already seeded, so reproject writes nothing; the route sets the asked-for Left itself
  const re = await call(f, "streamer", "POST", "/api/outcomes", { body: { name: "Shirt T0", glyph: "👕", shape: "giveaway", tier: 0, occupancy: "instant", restockable: false, raffle: true, left: 3 } });
  expect(re.status).toBe(201);
  expect((await asJson(re)).outcome).toMatchObject({ id: "shirt-t0", left: 3, used: 0, raffle: true });
  expect(written(f).slice(before + 2)).toEqual([
    expect.objectContaining({ type: "outcome_change", payload: expect.objectContaining({ outcomeId: "shirt-t0", action: "add" }) }),
    expect.objectContaining({ type: "stock", actor: "twitch:dj", payload: { outcomeId: "shirt-t0", delta: 3, reason: "initial" } }),
  ]);
  expect(inEngine(f, "shirt-t0")).toMatchObject({ left: 3, used: 0, initialLeft: 3 });
  expect(onDisk(f, "shirt-t0")).toMatchObject({ initialLeft: 3 });

  // deleting one with Left 0 writes no stock entry — just the outcome_change
  expect((await call(f, "streamer", "PUT", "/api/outcomes/shirt-t0", { body: { left: 0 } })).status).toBe(200);
  const zeroed = written(f).length;
  expect((await call(f, "streamer", "DELETE", "/api/outcomes/shirt-t0")).status).toBe(200);
  expect(written(f).slice(zeroed).map((e) => e.type)).toEqual(["outcome_change"]);
  expect(f.logs).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Firebot raffle
// ---------------------------------------------------------------------------------------------------------------------

test("firing a raffle outcome only queues it — nothing reaches Firebot until Start; Start with the fireSeq opens it (start, then the prize line) and takes it off the queue; then close/draw/reopen/clear each run and leave a note; a non-raffle outcome does none of it", async () => {
  const f = mk();
  await credit(f, 5000, "alice");
  const res = await call(f, "streamer", "POST", "/api/fire");
  const fired = await asJson(res);
  expect(fired.outcome).toMatchObject({ id: "stickers", raffle: true });
  await new Promise((r) => setTimeout(r, 10));
  expect(f.firebotCalls).toEqual([]); // the streamer may not be ready: chat hears nothing yet
  expect(f.health.list()).toEqual([]);
  const st = await asJson(await call(f, "streamer", "GET", "/api/state"));
  expect(st.giveaway).toBeNull();
  expect(st.giveawaysPending).toEqual([{ prize: "STICKERS", fireSeq: fired.seq }]);
  expect(await errorOf(await call(f, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: 999 } }), 404, "NOT_FOUND")).toContain("999");

  const started = await asJson(await call(f, "funnel", "POST", "/api/giveaway/start", { cookie: cookie("mod"), body: { fireSeq: fired.seq } }));
  expect(started.giveawaysPending).toEqual([]);
  expect(started.entry).toMatchObject({ type: "note", actor: "twitch:bob", payload: { text: `giveaway started for fire #${fired.seq} (STICKERS)`, fireSeq: fired.seq } });
  await waitFor(() => f.firebotCalls.length >= 3);
  expect(f.firebotCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://localhost:7472/api/v1/commands/custom",
    "POST http://localhost:7472/api/v1/commands/custom/cmd-1/run",
    "POST http://localhost:7472/api/v1/effects",
  ]); // start (Firebot says how to enter), then our prize line; no close, no draw: a person does that on the Giveaways page
  const announce = (f.firebotCalls[2]!.body as { effects: { list: Array<{ message: string }> } }).effects.list[0]!.message;
  expect(announce).toContain("STICKERS");
  expect(announce).toContain("stay open");
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).giveaway).toEqual({ prize: "STICKERS", fireSeq: fired.seq, openedAt: expect.any(String), phase: "open", draws: 0 });

  const args = (from: number) => f.firebotCalls.slice(from).map((c) => (c.body as { args: string }).args);
  const closed = await asJson(await call(f, "funnel", "POST", "/api/giveaway/close-and-draw", { cookie: cookie("mod") }));
  expect(closed.giveaway).toMatchObject({ phase: "closed", draws: 1 });
  expect(closed.entry).toMatchObject({ type: "note", actor: "twitch:bob", payload: { text: `giveaway closed and drawn for fire #${fired.seq} (STICKERS)`, fireSeq: fired.seq } });
  expect(args(3)).toEqual(["close", "draw"]);

  const again = await asJson(await call(f, "streamer", "POST", "/api/giveaway/draw"));
  expect(again.entry).toMatchObject({ type: "note", payload: { text: `giveaway drawn again for fire #${fired.seq} (STICKERS)` } });
  expect(again.giveaway).toMatchObject({ draws: 2 });
  expect(args(5)).toEqual(["draw"]);

  expect((await asJson(await call(f, "streamer", "POST", "/api/giveaway/reopen"))).giveaway).toMatchObject({ phase: "open" });
  expect((await asJson(await call(f, "streamer", "POST", "/api/giveaway/close"))).giveaway).toMatchObject({ phase: "closed", draws: 2 });
  expect(args(6)).toEqual(["open", "close"]);

  const done = await asJson(await call(f, "streamer", "POST", "/api/giveaway/clear"));
  expect(done.giveaway).toBeNull();
  expect(done.entry).toMatchObject({ type: "note", payload: { text: `giveaway done — entrant list cleared for fire #${fired.seq} (STICKERS)`, fireSeq: fired.seq } });
  expect(args(8)).toEqual(["clear"]);
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).giveaway).toBeNull();

  // nothing tracked: the acts still run (Firebot holds the truth) and the note says so without a Fire
  const stray = await asJson(await call(f, "streamer", "POST", "/api/giveaway/draw"));
  expect(stray.entry).toMatchObject({ type: "note", payload: { text: "giveaway drawn again" } });
  expect(last(written(f)).type).toBe("note");

  const plain = mk({ rng: () => 0.99 }); // 0.99 × 17 tier-0 charges → the last tier-0 outcome, COSTUME · 30 MIN (no raffle)
  await credit(plain, 5000, "alice");
  expect((await asJson(await call(plain, "streamer", "POST", "/api/fire"))).outcome).toMatchObject({ id: "costume-30-min" });
  await new Promise((r) => setTimeout(r, 5));
  expect(plain.firebotCalls).toEqual([]);
});

test("Firebot not responding: the Fire still queues; Start → 502 FIREBOT with the manual fallback !raffle 1 120 and the giveaway stays waiting; close / draw / reopen / clear → 502 too, nothing written", async () => {
  const f = mk({ firebotStatus: 500 });
  await credit(f, 5000, "alice");
  const fired = await asJson(await call(f, "streamer", "POST", "/api/fire"));
  expect(f.firebotCalls).toEqual([]);
  const before = written(f).length;
  expect(await errorOf(await call(f, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: fired.seq } }), 502, "FIREBOT")).toContain("!raffle 1 120");
  expect(f.firebotCalls).toHaveLength(1);
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).giveawaysPending).toEqual([{ prize: "STICKERS", fireSeq: fired.seq }]);
  for (const name of ["close", "close-and-draw", "draw", "reopen", "clear"]) expect(await errorOf(await call(f, "streamer", "POST", `/api/giveaway/${name}`), 502, "FIREBOT")).toContain("!raffle 1 120");
  expect(written(f).length).toBe(before);
  expect(f.logs).toEqual([]);
});

test("Firebot switched off: firing a raffle outcome makes no Firebot call and sets a dismissable info banner pointing at !raffle 1 120; a non-raffle fire sets nothing", async () => {
  const f = mk({ config: (c) => void (c.firebot.enabled = false) });
  await credit(f, 5000, "alice");
  const res = await call(f, "streamer", "POST", "/api/fire");
  expect(res.status).toBe(200);
  expect((await asJson(res)).outcome).toMatchObject({ id: "stickers", raffle: true });
  expect(f.health.list()).toEqual([{ id: "firebot", level: "info", text: "Firebot is off — run !raffle 1 120 in chat for giveaways", at: T0.toISOString() }]);
  expect(f.firebotCalls).toEqual([]);
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).giveawaysPending).toEqual([{ prize: "STICKERS", fireSeq: expect.any(Number) }]); // still waiting: by hand it is
  expect(await asJson(await call(f, "streamer", "POST", "/api/health/firebot/dismiss"))).toEqual({ ok: true });
  expect(f.health.list()).toEqual([]);
  expect(await errorOf(await call(f, "streamer", "POST", "/api/giveaway/close-and-draw"), 502, "FIREBOT")).toBe("Firebot is off — run !raffle 1 120 in chat for giveaways");

  const plain = mk({ config: (c) => void (c.firebot.enabled = false), rng: () => 0.99 }); // COSTUME · 30 MIN: no raffle
  await credit(plain, 5000, "alice");
  expect((await asJson(await call(plain, "streamer", "POST", "/api/fire"))).outcome).toMatchObject({ id: "costume-30-min" });
  await new Promise((r) => setTimeout(r, 5));
  expect(plain.health.list()).toEqual([]);
  expect(f.logs).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Ko-fi webhook through the router
// ---------------------------------------------------------------------------------------------------------------------

test("Ko-fi: funnel POST only; wrong path 404; wrong token 401 + auth_failure (token never echoed); good → 200 + contribution; replay → no double credit; Shop Order → no credit", async () => {
  const f = mk();
  const hook = `/hooks/kofi/${KOFI_PATH}`;
  await errorOf(await call(f, "streamer", "POST", hook, { raw: kofiBody(), csrf: false }), 404, "NOT_FOUND");
  await errorOf(await call(f, "funnel", "GET", hook), 404, "NOT_FOUND");
  await errorOf(await call(f, "funnel", "POST", "/hooks/kofi/wrong", { raw: kofiBody(), csrf: false }), 404, "NOT_FOUND");
  await errorOf(await call(f, "funnel", "POST", "/hooks/kofi/", { raw: kofiBody(), csrf: false }), 404, "NOT_FOUND");
  expect(types(f)).toEqual([]);

  const wrong = await call(f, "funnel", "POST", hook, { raw: kofiBody({ verification_token: "nope-nope-nope" }), csrf: false, ip: "198.51.100.7" });
  expect(wrong.status).toBe(401);
  const wrongText = await wrong.text();
  expect(JSON.parse(wrongText)).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  expect(wrongText).not.toContain(KOFI_TOKEN);
  expect(wrongText).not.toContain("nope-nope-nope");
  expect(written(f)).toEqual([expect.objectContaining({ type: "auth_failure", actor: "system:kofi", payload: { ip: "198.51.100.7", path: "/hooks/kofi/<redacted>", reason: "bad verification token" } })]);
  expect(JSON.stringify(f.ledger.all())).not.toContain(KOFI_PATH); // the path is a secret too: the Ledger page must not leak it
  expect(f.logs).toEqual([]);

  const good = await call(f, "funnel", "POST", hook, { raw: kofiBody(), csrf: false });
  expect(good.status).toBe(200);
  expect(await asJson(good)).toEqual({ ok: true, credited: true });
  const entry = last(f.ledger.all());
  expect(entry).toMatchObject({ type: "contribution", actor: "system:kofi", payload: { source: "kofi", sourceId: "kofi:2defe7b3-a0a9-4495-991c-ad08cd0dc51d", face: { kind: "tip", cents: 300 }, displayName: "Jo Example", anonymous: false, currency: "USD", progressCents: 300 } });
  expect(JSON.stringify(entry)).not.toContain("jo.example@example.com");
  expect(f.engine.state.progressCents).toBe(300);
  expect(last(f.msgs)).toMatchObject({ type: "contribution", displayName: "Jo Example", faceValueCents: 300 });

  const replay = await call(f, "funnel", "POST", hook, { raw: kofiBody(), csrf: false });
  expect(await asJson(replay)).toEqual({ ok: true, duplicate: true });
  expect(f.engine.state.progressCents).toBe(300);
  expect(written(f)).toHaveLength(2);

  const shop = kofiBody({ type: "Shop Order", message_id: "b1b1b1b1-0000-0000-0000-000000000001", shop_items: [{ direct_link_code: "1a2b3c4d", variation_name: "Blue", quantity: 1 }] });
  expect(await asJson(await call(f, "funnel", "POST", hook, { raw: shop, csrf: false }))).toEqual({ ok: true, credited: false });
  expect(await asJson(await call(f, "funnel", "POST", hook, { raw: shop, csrf: false }))).toEqual({ ok: true, duplicate: true });
  expect(f.engine.state.progressCents).toBe(300);
  expect(written(f)).toHaveLength(2);

  const anonymousSub = kofiBody({ type: "Subscription", message_id: "c2c2c2c2-0000-0000-0000-000000000002", is_public: false, is_subscription_payment: true, amount: "4.35", currency: "EUR" });
  expect(await asJson(await call(f, "funnel", "POST", hook, { raw: anonymousSub, csrf: false }))).toEqual({ ok: true, credited: true });
  expect(last(f.ledger.all())).toMatchObject({ type: "contribution", payload: { displayName: null, anonymous: true, face: { kind: "tip", cents: 435 }, currency: "EUR" } });
  expect(f.engine.state.progressCents).toBe(735);
});

test("POST /api/fire with raffle:false fires the Outcome but never calls Firebot (the Debug page's drops: no chat before the night); anything but a boolean → 400", async () => {
  const f = mk();
  await credit(f, 5000, "alice");
  const res = await call(f, "streamer", "POST", "/api/fire", { body: { raffle: false } });
  expect((await asJson(res)).outcome).toMatchObject({ id: "stickers", raffle: true });
  await new Promise((r) => setTimeout(r, 5));
  expect(f.firebotCalls).toEqual([]);
  expect(f.health.list()).toEqual([]);
  await credit(f, 5000, "bob");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/fire", { body: { raffle: "no" } }), 400, "VALIDATION")).toBe("raffle must be a boolean");
});

test("POST /api/giveaway/dry-run (streamer): opens a giveaway that never reaches Firebot — nothing fetched, nothing written; close / draw work with Firebot off and write nothing; refused while a real giveaway is open", async () => {
  const f = mk({ config: (c) => (c.firebot.enabled = false) });
  const before = written(f).length;
  const opened = await asJson(await call(f, "streamer", "POST", "/api/giveaway/dry-run", { body: { prize: "USB STICK" } }));
  expect(opened.giveaway).toMatchObject({ prize: "USB STICK", fireSeq: 0, dry: true, phase: "open", draws: 0, transcript: [`firebot: !giveaway start → ${FIREBOT_SAYS.start}`, "chat (Bot): 🎁 Tonight's prize: USB STICK — entries stay open until we draw!"] });
  expect((await asJson(await call(f, "streamer", "GET", "/api/state"))).giveaway).toMatchObject({ dry: true, prize: "USB STICK" });
  expect((await call(f, "funnel", "POST", "/api/giveaway/dry-run", { cookie: cookie("mod") })).status).toBe(403);

  const drawn = await asJson(await call(f, "funnel", "POST", "/api/giveaway/close-and-draw", { cookie: cookie("mod") }));
  expect(drawn.entry).toBeNull();
  expect(drawn.giveaway).toMatchObject({ phase: "closed", draws: 1 });
  expect((await asJson(await call(f, "streamer", "POST", "/api/giveaway/draw"))).giveaway).toMatchObject({ draws: 2 });
  const done = await asJson(await call(f, "streamer", "POST", "/api/giveaway/clear"));
  expect(done).toMatchObject({ entry: null, giveaway: null });
  expect(done.transcript.slice(2)).toEqual([`firebot: !giveaway close → ${FIREBOT_SAYS.close}`, `firebot: !giveaway draw → ${FIREBOT_SAYS.draw}`, `firebot: !giveaway draw → ${FIREBOT_SAYS.draw}`, `firebot: !giveaway clear → ${FIREBOT_SAYS.clear}`]);
  expect(written(f).length).toBe(before);
  expect(f.firebotCalls).toEqual([]);
  expect(f.health.list()).toEqual([]);

  // no prize in the body: a raffle Outcome's name from the pool
  const random = await asJson(await call(f, "streamer", "POST", "/api/giveaway/dry-run"));
  expect(f.engine.state.outcomes.filter((o) => o.raffle === true).map((o) => o.name)).toContain(random.giveaway.prize);
  await call(f, "streamer", "POST", "/api/giveaway/clear");

  // a real one open → 409, and the real one is untouched
  const live = mk();
  await credit(live, 5000, "alice");
  const lf = await asJson(await call(live, "streamer", "POST", "/api/fire"));
  expect((await call(live, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: lf.seq } })).status).toBe(200);
  expect(await errorOf(await call(live, "streamer", "POST", "/api/giveaway/dry-run"), 409, "GIVEAWAY_OPEN")).toContain("STICKERS");
  expect((await asJson(await call(live, "streamer", "GET", "/api/state"))).giveaway).toMatchObject({ prize: "STICKERS", fireSeq: expect.any(Number) });
});

test("POST /api/giveaway/start (mod): a giveaway by hand — Firebot start then the prize line, a note, tracked with fireSeq 0; needs a prize; 409 while one is still on; 502 with Firebot off", async () => {
  const f = mk();
  const started = await asJson(await call(f, "funnel", "POST", "/api/giveaway/start", { cookie: cookie("mod"), body: { prize: "MYSTERY BOX" } }));
  expect(started.giveaway).toMatchObject({ prize: "MYSTERY BOX", fireSeq: 0, phase: "open", draws: 0 });
  expect(started.entry).toMatchObject({ type: "note", actor: "twitch:bob", payload: { text: "giveaway started by hand (MYSTERY BOX)" } });
  expect(f.firebotCalls.slice(1).map((c) => (c.body as { args?: string; effects?: { list: Array<{ message: string }> } }).args ?? (c.body as { effects: { list: Array<{ message: string }> } }).effects.list[0]!.message)).toEqual(["start", "🎁 Tonight's prize: MYSTERY BOX — entries stay open until we draw!"]);
  expect(await errorOf(await call(f, "streamer", "POST", "/api/giveaway/start", { body: { prize: "AGAIN" } }), 409, "GIVEAWAY_OPEN")).toContain("MYSTERY BOX");
  expect(await errorOf(await call(f, "streamer", "POST", "/api/giveaway/start", { body: {} }), 400, "VALIDATION")).toContain("prize");
  await call(f, "streamer", "POST", "/api/giveaway/clear");
  expect((await asJson(await call(f, "streamer", "POST", "/api/giveaway/start", { body: { prize: "ROUND TWO" } }))).giveaway).toMatchObject({ prize: "ROUND TWO" });

  const off = mk({ config: (c) => (c.firebot.enabled = false) });
  expect(await errorOf(await call(off, "streamer", "POST", "/api/giveaway/start", { body: { prize: "X" } }), 502, "FIREBOT")).toContain("Firebot is off");
});

test("the overlay URL for OBS: localhost first; with OBS on another computer the LAN address follows — in Docker the host's address handed in, because the container's own address reaches nobody", async () => {
  const lan = (c: Config) => (c.listeners.overlayOnLan = true);
  const docker = mk({ config: lan, hostLanIp: "192.168.1.20", networkInterfaces: () => ({ eth0: [ipv4("192.168.97.2", false)] }) });
  expect((await asJson(await call(docker, "streamer", "GET", "/api/state"))).overlayUrls).toEqual(["http://localhost:8702/overlay", "http://192.168.1.20:8702/overlay"]);

  // Nothing handed in (the bare binary on the machine itself): its own addresses are the right answer.
  const bare = mk({ config: lan, networkInterfaces: () => ({ eth0: [ipv4("192.168.97.2", false)] }) });
  expect((await asJson(await call(bare, "streamer", "GET", "/api/state"))).overlayUrls).toEqual(["http://localhost:8702/overlay", "http://192.168.97.2:8702/overlay"]);

  // The box off (the default): the network address stays off the list even when it was handed in.
  const same = mk({ hostLanIp: "192.168.1.20", networkInterfaces: () => ({ eth0: [ipv4("192.168.97.2", false)] }) });
  expect((await asJson(await call(same, "streamer", "GET", "/api/state"))).overlayUrls).toEqual(["http://localhost:8702/overlay"]);
});

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot } from "../../boot.ts";
import { defaultConfig, type Config } from "../../config/schema.ts";
import { Secrets } from "../../config/secrets.ts";
import { ConfigStore } from "../../config/store.ts";
import { Engine } from "../../engine/engine.ts";
import { Helix } from "../../ingest/twitch/helix.ts";
import { Firebot } from "../../integrations/firebot.ts";
import { Ledger } from "../../ledger/ledger.ts";
import { createApp } from "../app.ts";
import { CSRF_HEADER, CSRF_VALUE, SESSION_TTL_MS, signSession, type AppListener, type Role } from "../auth.ts";
import { Health } from "../health.ts";
import { OAuth } from "../oauth.ts";
import { OverlayHub, type ChatterSource } from "../overlay.ts";
import { clientScript } from "./pages.ts";
import { SETUP_PATH, SE_JWT_KEY, TWITCH_APP_KEYS, setupNeeded, type SetupArea } from "./setup.ts";

const SECRET = "session-secret";
const T0 = new Date("2026-09-12T20:00:00.000Z");
const FUNNEL_URL = "https://laptop.tail1234.ts.net";
const STREAMER_URL = "http://localhost:8700";
const TWITCH_APP_HEALTH_ID = "twitch-app";

type Hit = { url: string; init?: RequestInit };

interface MkOptions {
  config?: (c: Config) => void;
  secrets?: Record<string, string>;
  /** What the Check buttons' fetch answers; default: everything 404. */
  fetch?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

function mk(opts: MkOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-setup-"));
  const seed = defaultConfig();
  opts.config?.(seed);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(seed));
  const config = new ConfigStore(path.join(dir, "config.json"));
  const secrets = new Secrets(path.join(dir, "secrets.env"));
  secrets.set("SESSION_SECRET", SECRET);
  for (const [k, v] of Object.entries(opts.secrets ?? {})) secrets.set(k, v);
  const ledger = new Ledger(":memory:");
  const engine = new Engine(ledger, () => config.get(), { rng: () => 0, now: () => T0 });
  const health = new Health({ now: () => T0 });
  health.set(TWITCH_APP_HEALTH_ID, "warn", "Twitch app not set up yet");
  const noFetch = async (): Promise<Response> => new Response("not found", { status: 404 });
  const hits: Hit[] = [];
  const checkFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    hits.push({ url, init });
    return (opts.fetch ?? noFetch)(url, init);
  };
  const firebot = new Firebot({ config: () => config.get(), fetchImpl: noFetch, sleep: async () => {}, now: () => T0 });
  const hub = new OverlayHub(engine, () => config.get());
  const helix = new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl: noFetch, now: () => T0 });
  const oauth = new OAuth({ clientId: "cid", clientSecret: "csecret", secrets, helix, config: () => config.get(), onBroadcasterLinked: () => {}, ledger, dataDir: dir, fetchImpl: noFetch, now: () => T0, log: () => {} });
  const chatters: ChatterSource = { list: () => [], count: () => 0, fake: () => ({ key: "f", name: "f", avatarUrl: "", firstSeenMs: 0, lastSeenMs: 0 }), hopRandom: () => null };
  const changes: SetupArea[] = [];
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
    log: () => {},
    now: () => T0,
    networkInterfaces: () => ({}),
    setup: { fetchImpl: checkFetch, onSetupChange: (area) => void changes.push(area), random: () => "feedfacefeedface" },
  });
  return { dir, config, secrets, ledger, health, app, hits, changes };
}
type Fixture = ReturnType<typeof mk>;

function request(listener: AppListener, method: string, pathname: string, opts: { body?: unknown; cookie?: string; csrf?: boolean } = {}): Request {
  const headers = new Headers();
  if (method !== "GET" && opts.csrf !== false) headers.set(CSRF_HEADER, CSRF_VALUE);
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  return new Request(`${listener === "funnel" ? FUNNEL_URL : STREAMER_URL}${pathname}`, { method, headers, body });
}

const call = (f: Fixture, listener: AppListener, method: string, pathname: string, opts: Parameters<typeof request>[3] = {}) => f.app.handle(request(listener, method, pathname, opts), listener);
const cookie = (role: Role, login = role === "mod" ? "bob" : "dj") => `tpo_session=${signSession(SECRET, { uid: role === "mod" ? "200" : "100", login, role, exp: T0.getTime() + SESSION_TTL_MS })}`;
const post = (f: Fixture, pathname: string, body: unknown) => call(f, "streamer", "POST", pathname, { body });
const page = async (f: Fixture, pathname = SETUP_PATH) => {
  const res = await call(f, "streamer", "GET", pathname);
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
};
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: { message: string } }).error.message;

const LINKED = (c: Config) => void (c.channel = { login: "dj", broadcasterId: "100", displayName: "DJ" });
const APP = { [TWITCH_APP_KEYS.id]: "abc123clientid", [TWITCH_APP_KEYS.secret]: "s3cr3tvalue9876" };

// ---------------------------------------------------------------------------------------------------------------------
// Routing, roles, the first-run redirect
// ---------------------------------------------------------------------------------------------------------------------

test("GET /setup is a Streamer page on the streamer listener only: the funnel answers 404 to a mod and to the broadcaster's own session", async () => {
  const f = mk();
  const { status, text } = await page(f);
  expect(status).toBe(200);
  expect(text).toContain("<h1>Setup</h1>");
  expect(text).toContain("Connect Twitch");
  expect(text).toContain("http://localhost:8700/auth/twitch/callback");
  expect(text).toContain('href="/debug"');
  for (const c of [cookie("mod"), cookie("streamer")]) {
    expect((await call(f, "funnel", "GET", SETUP_PATH, { cookie: c })).status).toBe(404);
  }
  expect((await call(f, "funnel", "GET", SETUP_PATH)).status).toBe(404);
});

test("setupNeeded: true until both Twitch app keys are saved and the broadcaster is linked", () => {
  const f = mk();
  expect(setupNeeded(f.secrets, f.config.get())).toBe(true);
  f.secrets.set(TWITCH_APP_KEYS.id, "abc");
  f.secrets.set(TWITCH_APP_KEYS.secret, "");
  expect(setupNeeded(f.secrets, f.config.get())).toBe(true);
  f.secrets.set(TWITCH_APP_KEYS.secret, "def");
  expect(setupNeeded(f.secrets, f.config.get())).toBe(true); // not linked
  const linked = mk({ config: LINKED, secrets: APP });
  expect(setupNeeded(linked.secrets, linked.config.get())).toBe(false);
});

test("/ on the streamer listener redirects to /setup until Twitch is set up and linked; the funnel never redirects there", async () => {
  const fresh = mk();
  expect(await page(fresh, "/")).toMatchObject({ status: 302, location: SETUP_PATH });
  const keysOnly = mk({ secrets: APP });
  expect(await page(keysOnly, "/")).toMatchObject({ status: 302, location: SETUP_PATH });
  const linkedOnly = mk({ config: LINKED });
  expect(await page(linkedOnly, "/")).toMatchObject({ status: 302, location: SETUP_PATH });
  const done = mk({ config: LINKED, secrets: APP });
  expect((await page(done, "/")).status).toBe(200);
  // other pages are reachable while setup is pending (the nav still works)
  expect((await page(fresh, "/config")).status).toBe(200);
  // a mod on the funnel of a half-set-up service gets the login gate / the Live page, never /setup
  const res = await call(linkedOnly, "funnel", "GET", "/", { cookie: cookie("mod") });
  expect(res.status).toBe(200);
});

test("Config links to Setup on the streamer listener; a mod's view of the Dashboard never mentions it", async () => {
  const f = mk({ config: LINKED, secrets: APP });
  expect((await page(f, "/config")).text).toContain(`href="${SETUP_PATH}"`);
  for (const p of ["/", "/pool", "/help", "/ledger", "/giveaways"]) {
    const res = await call(f, "funnel", "GET", p, { cookie: cookie("mod") });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SETUP_PATH);
  }
});

test("the setup API is Streamer, streamer listener and CSRF only: 403 on the funnel (even the broadcaster's session), 403 without the header, 404 for an unknown route", async () => {
  const f = mk();
  expect((await call(f, "funnel", "POST", "/api/setup/channel", { body: { login: "x" }, cookie: cookie("streamer") })).status).toBe(403);
  expect((await call(f, "funnel", "POST", "/api/setup/channel", { body: { login: "x" }, cookie: cookie("mod") })).status).toBe(403);
  expect((await call(f, "funnel", "POST", "/api/setup/channel", { body: { login: "x" } })).status).toBe(401);
  expect((await call(f, "streamer", "POST", "/api/setup/channel", { body: { login: "x" }, csrf: false })).status).toBe(403);
  expect((await call(f, "streamer", "POST", "/api/setup/nothing", { body: {} })).status).toBe(404);
  expect((await call(f, "streamer", "GET", "/api/setup/channel")).status).toBe(404);
});

// ---------------------------------------------------------------------------------------------------------------------
// Required: channel, Twitch app
// ---------------------------------------------------------------------------------------------------------------------

test("channel: the login is normalized (an @, a twitch.tv address, upper case), saved with a config_change, and shown back; junk is a plain 400", async () => {
  const f = mk();
  const res = await post(f, "/api/setup/channel", { login: " https://www.twitch.tv/@DJ_Example/ " });
  expect(res.status).toBe(200);
  expect(f.config.get().channel.login).toBe("dj_example");
  expect(f.config.get().channel.displayName).toBe("DJ_Example");
  expect(f.ledger.all().filter((e) => e.type === "config_change").length).toBe(1);
  expect((await page(f)).text).toContain('value="dj_example"');
  expect(f.changes).toEqual(["channel"]);

  const bad = await post(f, "/api/setup/channel", { login: "not a name!" });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toMatch(/twitch\.tv address/);
  expect(f.config.get().channel.login).toBe("dj_example");
  // a display name already there is kept
  await post(f, "/api/setup/channel", { login: "other" });
  expect(f.config.get().channel.displayName).toBe("DJ_Example");
});

test("twitch-app: both keys go to Secrets, the banner clears, the adapters hear, and the answer sends the browser to the broadcaster link", async () => {
  const f = mk();
  const res = await post(f, "/api/setup/twitch-app", { clientId: " abc123clientid ", clientSecret: "s3cr3tvalue9876" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, next: "/auth/twitch/broadcaster" });
  expect(f.secrets.get(TWITCH_APP_KEYS.id)).toBe("abc123clientid");
  expect(f.secrets.get(TWITCH_APP_KEYS.secret)).toBe("s3cr3tvalue9876");
  expect(fs.readFileSync(path.join(f.dir, "secrets.env"), "utf8")).toContain("TWITCH_CLIENT_SECRET=s3cr3tvalue9876\n");
  expect(f.health.list().find((b) => b.id === TWITCH_APP_HEALTH_ID)).toBeUndefined();
  expect(f.changes).toEqual(["twitch"]);
});

test("twitch-app: the page shows the Client ID, never the secret, only its last four; an empty secret keeps the saved one; nothing saved means a 400 naming the field", async () => {
  const f = mk({ secrets: APP });
  const { text } = await page(f);
  expect(text).toContain('value="abc123clientid"');
  expect(text).not.toContain("s3cr3tvalue9876");
  expect(text).toContain("saved (ending in …9876)");

  const keep = await post(f, "/api/setup/twitch-app", { clientId: "newclientid000", clientSecret: "" });
  expect(keep.status).toBe(200);
  expect(f.secrets.get(TWITCH_APP_KEYS.id)).toBe("newclientid000");
  expect(f.secrets.get(TWITCH_APP_KEYS.secret)).toBe("s3cr3tvalue9876");

  const fresh = mk();
  const missing = await post(fresh, "/api/setup/twitch-app", { clientId: "abc", clientSecret: "" });
  expect(missing.status).toBe(400);
  expect(await errorOf(missing)).toMatch(/Client Secret/);
  const spaces = await post(fresh, "/api/setup/twitch-app", { clientId: "has space", clientSecret: "x" });
  expect(spaces.status).toBe(400);
  expect(await errorOf(spaces)).toMatch(/Client ID/);
});

test("twitch-app: once the broadcaster is linked the section reads Connected with the login and a save no longer redirects unless asked", async () => {
  const f = mk({ config: LINKED, secrets: APP });
  const { text } = await page(f);
  expect(text).toContain("Connected");
  expect(text).toContain("@dj");
  const res = await post(f, "/api/setup/twitch-app", { clientId: "abc123clientid", clientSecret: "" });
  expect(await res.json()).toEqual({ ok: true });
  const again = await post(f, "/api/setup/twitch-app", { clientId: "abc123clientid", clientSecret: "", connect: true });
  expect(await again.json()).toEqual({ ok: true, next: "/auth/twitch/broadcaster" });
});

test("the progress indicator counts the three required steps", async () => {
  expect((await page(mk())).text).toContain("Step 1 of 3");
  expect((await page(mk({ config: (c) => void (c.channel.login = "dj") }))).text).toContain("Step 2 of 3");
  expect((await page(mk({ config: (c) => void (c.channel.login = "dj"), secrets: APP }))).text).toContain("Step 3 of 3");
  expect((await page(mk({ config: LINKED, secrets: APP }))).text).toContain("All set");
});

// ---------------------------------------------------------------------------------------------------------------------
// Optional: StreamElements, mods + Ko-fi, Firebot. Everything off until switched on.
// ---------------------------------------------------------------------------------------------------------------------

test("defaults: a fresh config.json has every optional extra off; Twitch itself stays on", async () => {
  const d = defaultConfig();
  expect(d.ingest.twitch.enabled).toBe(true);
  expect(d.ingest.streamelements.enabled).toBe(false);
  expect(d.ingest.kofi.enabled).toBe(false);
  expect(d.firebot.enabled).toBe(false);
  expect(d.funnel.publicUrl).toBe("");

  // the real boot path writes the same file
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-setup-boot-"));
  const booted = await boot({ dataDir, ports: { streamer: 0, funnel: 0, overlay: 0 }, log: () => {} });
  try {
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) as Config;
    expect(written.ingest.streamelements.enabled).toBe(false);
    expect(written.ingest.kofi.enabled).toBe(false);
    expect(written.firebot.enabled).toBe(false);
    expect(written.funnel.publicUrl).toBe("");
    // and a first visit lands on Setup
    const res = await fetch(`http://127.0.0.1:${booted.ports.streamer}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SETUP_PATH);
  } finally {
    await booted.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the page shows every optional switch off on a fresh config, each with its what-you-get line", async () => {
  const { text } = await page(mk());
  for (const name of ["streamelements", "modAccess", "kofi", "firebot"]) {
    expect(text).toMatch(new RegExp(`<input type="checkbox" name="${name}"[^>]*>`));
    expect(text).not.toMatch(new RegExp(`<input type="checkbox" name="${name}"[^>]*checked`));
  }
});

test("streamelements: on + a token saves both, the adapter is restarted; the page masks the token; off keeps the token but turns the feed off", async () => {
  const f = mk();
  const on = await post(f, "/api/setup/streamelements", { enabled: true, jwt: "eyJhbGciOiJIUzI1NiJ9.payload.sigABCD" });
  expect(on.status).toBe(200);
  expect(f.config.get().ingest.streamelements.enabled).toBe(true);
  expect(f.secrets.get(SE_JWT_KEY)).toBe("eyJhbGciOiJIUzI1NiJ9.payload.sigABCD");
  expect(f.changes).toEqual(["streamelements"]);
  const { text } = await page(f);
  expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.sigABCD");
  expect(text).toContain("saved (ending in …ABCD)");
  expect(text).toMatch(/name="streamelements"[^>]*checked/);

  const off = await post(f, "/api/setup/streamelements", { enabled: false });
  expect(off.status).toBe(200);
  expect(f.config.get().ingest.streamelements.enabled).toBe(false);
  expect(f.secrets.get(SE_JWT_KEY)).toBe("eyJhbGciOiJIUzI1NiJ9.payload.sigABCD");

  const noToken = await post(mk(), "/api/setup/streamelements", { enabled: true, jwt: "" });
  expect(noToken.status).toBe(400);
  expect(await errorOf(noToken)).toMatch(/JWT Token/);
});

test("streamelements check: GET channels/me with the pasted token (or the saved one) and the username back; a refusal is a plain 502", async () => {
  const f = mk({
    secrets: { [SE_JWT_KEY]: "saved.jwt.token" },
    fetch: (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (!url.endsWith("/channels/me")) return new Response("nope", { status: 404 });
      if (auth === "Bearer good.jwt.token" || auth === "Bearer saved.jwt.token") return Response.json({ _id: "5e1f", username: "djexample" });
      return new Response("", { status: 401 });
    },
  });
  const ok = await post(f, "/api/setup/streamelements/check", { jwt: "good.jwt.token" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, username: "djexample" });
  expect(f.hits[0]!.url).toBe("https://api.streamelements.com/kappa/v2/channels/me");

  const saved = await post(f, "/api/setup/streamelements/check", { jwt: "" });
  expect(await saved.json()).toEqual({ ok: true, username: "djexample" });

  const bad = await post(f, "/api/setup/streamelements/check", { jwt: "wrong" });
  expect(bad.status).toBe(502);
  expect(await errorOf(bad)).toMatch(/did not accept/);

  const none = await post(mk(), "/api/setup/streamelements/check", { jwt: "" });
  expect(none.status).toBe(400);
});

test("public: mod access on stores the address without its trailing slash; the Twitch section then lists the second redirect URL; Ko-fi on makes a webhook path, saves the token, and the page shows the full URL to paste", async () => {
  const f = mk({ secrets: APP });
  const res = await post(f, "/api/setup/public", { modAccess: true, publicUrl: "https://laptop.tail1234.ts.net/", kofi: false });
  expect(res.status).toBe(200);
  expect(f.config.get().funnel.publicUrl).toBe(FUNNEL_URL);
  expect(f.config.get().ingest.kofi.enabled).toBe(false);
  let { text } = await page(f);
  expect(text).toContain(`${FUNNEL_URL}/auth/twitch/callback`);
  expect(text).toMatch(/name="modAccess"[^>]*checked/);

  const kofi = await post(f, "/api/setup/public", { modAccess: true, publicUrl: FUNNEL_URL, kofi: true, kofiToken: "kofi-verif-token-XYZ1" });
  expect(kofi.status).toBe(200);
  expect(f.config.get().ingest.kofi).toEqual({ enabled: true, webhookPath: "feedfacefeedface" });
  expect(f.secrets.get("KOFI_VERIFICATION_TOKEN")).toBe("kofi-verif-token-XYZ1");
  ({ text } = await page(f));
  expect(text).toContain(`${FUNNEL_URL}/hooks/kofi/feedfacefeedface`);
  expect(text).not.toContain("kofi-verif-token-XYZ1");
  expect(text).toContain("saved (ending in …XYZ1)");
  expect(f.changes).toEqual(["public", "public"]);

  // the webhook path, once made, stays
  await post(f, "/api/setup/public", { modAccess: true, publicUrl: FUNNEL_URL, kofi: true, kofiToken: "" });
  expect(f.config.get().ingest.kofi.webhookPath).toBe("feedfacefeedface");
});

test("public: both switches off clears the address and turns Ko-fi off; a missing or http address, or Ko-fi without a token, is a plain 400", async () => {
  const f = mk({ config: (c) => void (c.funnel.publicUrl = FUNNEL_URL) });
  const off = await post(f, "/api/setup/public", { modAccess: false, kofi: false });
  expect(off.status).toBe(200);
  expect(f.config.get().funnel.publicUrl).toBe("");
  expect(f.config.get().ingest.kofi.enabled).toBe(false);

  const noUrl = await post(f, "/api/setup/public", { modAccess: true, publicUrl: "" });
  expect(noUrl.status).toBe(400);
  expect(await errorOf(noUrl)).toMatch(/public address/i);
  const http = await post(f, "/api/setup/public", { modAccess: true, publicUrl: "http://laptop.tail1234.ts.net" });
  expect(http.status).toBe(400);
  expect(await errorOf(http)).toMatch(/https/);
  const withPath = await post(f, "/api/setup/public", { modAccess: true, publicUrl: "https://laptop.tail1234.ts.net/dashboard" });
  expect(withPath.status).toBe(400);
  const noToken = await post(f, "/api/setup/public", { modAccess: false, publicUrl: FUNNEL_URL, kofi: true, kofiToken: "" });
  expect(noToken.status).toBe(400);
  expect(await errorOf(noToken)).toMatch(/Verification Token/);
  expect(f.config.get().funnel.publicUrl).toBe("");
});

test("firebot: on + address saves; the page shows the address; off saves off; a bad address is a 400", async () => {
  const f = mk();
  const on = await post(f, "/api/setup/firebot", { enabled: true, baseUrl: "http://127.0.0.1:7472/" });
  expect(on.status).toBe(200);
  expect(f.config.get().firebot.enabled).toBe(true);
  expect(f.config.get().firebot.baseUrl).toBe("http://127.0.0.1:7472");
  expect((await page(f)).text).toContain('value="http://127.0.0.1:7472"');
  expect(f.changes).toEqual(["firebot"]);
  const off = await post(f, "/api/setup/firebot", { enabled: false, baseUrl: "http://127.0.0.1:7472" });
  expect(off.status).toBe(200);
  expect(f.config.get().firebot.enabled).toBe(false);
  const bad = await post(f, "/api/setup/firebot", { enabled: true, baseUrl: "firebot" });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toMatch(/address/);
});

test("firebot check: asks Firebot for its custom commands; says whether !giveaway is there; a silent Firebot is a plain 502", async () => {
  const f = mk({
    fetch: (url) => {
      if (url === "http://127.0.0.1:7472/api/v1/commands/custom") return Response.json([{ id: "c1", trigger: "!giveaway" }]);
      if (url === "http://127.0.0.1:7473/api/v1/commands/custom") return Response.json([{ id: "c2", trigger: "!hello" }]);
      throw new TypeError("fetch failed");
    },
  });
  const ok = await post(f, "/api/setup/firebot/check", { baseUrl: "http://127.0.0.1:7472" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, command: true });
  const noCmd = await post(f, "/api/setup/firebot/check", { baseUrl: "http://127.0.0.1:7473" });
  expect(await noCmd.json()).toMatchObject({ ok: true, command: false, message: expect.stringMatching(/giveaway\.firebotsetup/) });
  const down = await post(f, "/api/setup/firebot/check", { baseUrl: "http://127.0.0.1:7999" });
  expect(down.status).toBe(502);
  expect(await errorOf(down)).toMatch(/did not answer/);
});

test("client.js carries the Setup block: forms post to /api/setup, the switches reveal their fields, Connect Twitch follows the answer's next", async () => {
  const js = await clientScript().text();
  expect(js).toContain("/api/setup/");
  expect(js).toContain("data-setup");
  expect(js).toContain("data-toggle");
  expect(js).toContain("data-check");
  expect(js).toContain("data-copy");
  expect(js).toContain("data.next");
});

test("every user string on the page is escaped", async () => {
  const f = mk({ config: (c) => void (c.channel.login = "x"), secrets: { [TWITCH_APP_KEYS.id]: '"><script>alert(1)</script>', [TWITCH_APP_KEYS.secret]: "<b>" } });
  const { text } = await page(f);
  expect(text).not.toContain("<script>alert(1)</script>");
  expect(text).toContain("&quot;&gt;&lt;script&gt;");
});

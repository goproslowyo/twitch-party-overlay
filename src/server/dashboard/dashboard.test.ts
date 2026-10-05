import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESCRIPTION_MAX, LIST_ITEM_MAX, defaultConfig, type Config } from "../../config/schema.ts";
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
import { OverlayHub, type Chatter, type ChatterSource } from "../overlay.ts";
import { renderMarkdown } from "./help.ts";
import { LEDGER_PAGE, TIPS, ago } from "./pages.ts";
import { escapeHtml } from "../http-util.ts";

const SECRET = "session-secret";
const T0 = new Date("2026-09-12T20:00:00.000Z");
const FUNNEL_URL = "https://laptop.tail1234.ts.net";
const STREAMER_URL = "http://localhost:8700";
const PAGES = ["/", "/ledger", "/pool", "/giveaways", "/config", "/debug", "/help"] as const;

const ipv4 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });

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

/** `now` is the app's clock (the Dashboard's "came up 2 min ago"); the Ledger stamps entries with the real clock regardless. */
function mk(opts: { config?: (c: Config) => void; rng?: () => number; now?: () => Date; networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>; hostLanIp?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-dashboard-"));
  const configPath = path.join(dir, "config.json");
  const seed = defaultConfig();
  seed.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  seed.funnel.publicUrl = FUNNEL_URL;
  opts.config?.(seed);
  fs.writeFileSync(configPath, JSON.stringify(seed));
  const config = new ConfigStore(configPath);
  const secrets = new Secrets(path.join(dir, "secrets.env"));
  secrets.set("SESSION_SECRET", SECRET);
  secrets.set("TWITCH_CLIENT_ID", "cid"); // a set-up service: without the app keys `/` goes to /setup
  secrets.set("TWITCH_CLIENT_SECRET", "csecret");
  const ledger = new Ledger(":memory:");
  const engine = new Engine(ledger, () => config.get(), { rng: opts.rng ?? (() => 0), now: () => T0 });
  const health = new Health({ now: () => T0 });
  const noFetch = async (): Promise<Response> => new Response("not found", { status: 404 });
  // a Firebot that answers: the !giveaway command exists and every effect / run succeeds (the Giveaways page's open raffle)
  const firebotFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    (init?.method ?? "GET") === "GET" && String(input).endsWith("/api/v1/commands/custom") ? Response.json([{ id: "cmd-1", trigger: "!giveaway" }]) : Response.json({ status: "success" });
  const firebot = new Firebot({ config: () => config.get(), fetchImpl: firebotFetch, sleep: async () => {}, now: () => T0 });
  const hub = new OverlayHub(engine, () => config.get());
  const helix = new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl: noFetch, now: () => T0 });
  const oauth = new OAuth({ clientId: "cid", clientSecret: "csecret", secrets, helix, config: () => config.get(), onBroadcasterLinked: () => {}, ledger, dataDir: dir, fetchImpl: noFetch, now: () => T0, log: () => {} });
  const chatters = fakeChatters();
  const logs: string[] = [];
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
    now: opts.now ?? (() => T0),
    networkInterfaces: opts.networkInterfaces ?? (() => ({ lo0: [ipv4("127.0.0.1", true)], en0: [ipv4("192.168.1.20", false)] })),
    hostLanIp: opts.hostLanIp,
  });
  return { config, ledger, engine, health, hub, chatters, app, logs };
}
type Fixture = ReturnType<typeof mk>;

interface ReqOptions {
  body?: unknown;
  cookie?: string;
}

function request(listener: AppListener, method: string, pathname: string, opts: ReqOptions = {}): Request {
  const headers = new Headers();
  if (method !== "GET") headers.set(CSRF_HEADER, CSRF_VALUE);
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  return new Request(`${listener === "funnel" ? FUNNEL_URL : STREAMER_URL}${pathname}`, { method, headers, body });
}

const call = (f: Fixture, listener: AppListener, method: string, pathname: string, opts: ReqOptions = {}) => f.app.handle(request(listener, method, pathname, opts), listener);
const cookie = (role: Role, login = role === "mod" ? "bob" : "dj") => `tpo_session=${signSession(SECRET, { uid: role === "mod" ? "200" : "100", login, role, exp: T0.getTime() + SESSION_TTL_MS })}`;
const MOD = { cookie: cookie("mod") };

/** GET a page and hand back status, content-type and body text. */
async function page(f: Fixture, listener: AppListener, pathname: string, opts: ReqOptions = {}) {
  const res = await call(f, listener, "GET", pathname, opts);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text(), headers: res.headers };
}

async function credit(f: Fixture, cents: number, displayName: string | null = "alice"): Promise<number> {
  const res = await call(f, "streamer", "POST", "/api/contributions", { body: { face: { kind: "tip", cents }, ...(displayName === null ? {} : { displayName }) } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number }).seq;
}

async function fire(f: Fixture): Promise<number> {
  const res = await call(f, "streamer", "POST", "/api/fire");
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number }).seq;
}

// ---------------------------------------------------------------------------------------------------------------------
// Routing and roles
// ---------------------------------------------------------------------------------------------------------------------

test("every page is 200 HTML on the streamer listener, with the nav and the Streamer badge", async () => {
  const f = mk();
  for (const p of PAGES) {
    const r = await page(f, "streamer", p);
    expect([p, r.status]).toEqual([p, 200]);
    expect(r.type.startsWith("text/html")).toBe(true);
    expect(r.text).toContain("<!doctype html>");
    expect(r.text).toContain('name="viewport"');
    expect(r.text).toContain('src="/dashboard/client.js"');
    for (const link of ['href="/"', 'href="/ledger"', 'href="/pool"', 'href="/giveaways"', 'href="/config"', 'href="/debug"', 'href="/help"']) expect(r.text).toContain(link);
    expect(r.text).toContain("@dj · Streamer"); // linked: the streamer listener acts as the broadcaster
  }
  const unlinked = mk({ config: (c) => (c.channel = { login: "", broadcasterId: "", displayName: "" }) });
  expect(await page(unlinked, "streamer", "/")).toMatchObject({ status: 302 }); // not connected yet: Live goes to Setup
  const u = await page(unlinked, "streamer", "/ledger");
  expect(u.status).toBe(200);
  expect(u.text).toContain("Streamer");
  expect(u.text).not.toContain("@dj");
  expect(u.text).not.toContain("· Streamer");
});

test("the funnel without a cookie: every page → 302 /login; a mod with a session gets the pages and a Mod badge with their login", async () => {
  const f = mk();
  for (const p of PAGES) {
    const res = await call(f, "funnel", "GET", p);
    expect([p, res.status]).toEqual([p, 302]);
    expect(res.headers.get("location")).toBe("/login");
  }
  const live = await page(f, "funnel", "/", MOD);
  expect(live.status).toBe(200);
  expect(live.text).toContain("Mod");
  expect(live.text).toContain("@bob");
  expect(live.text).toContain('href="/logout"');
  expect(live.text).not.toContain('href="/config"'); // Config is Streamer-only; the tab is hidden, the route still 403s
  expect((await page(f, "funnel", "/", { cookie: cookie("streamer") })).text).toContain('href="/config"');
});

test("/config is Streamer only: a mod on the funnel gets a 403 HTML page, the broadcaster's own funnel session gets the page", async () => {
  const f = mk();
  const mod = await page(f, "funnel", "/config", MOD);
  expect(mod.status).toBe(403);
  expect(mod.type.startsWith("text/html")).toBe(true);
  expect(mod.text).toContain("Streamer only");

  const streamer = await page(f, "funnel", "/config", { cookie: cookie("streamer") });
  expect(streamer.status).toBe(200);
  expect(streamer.text).toContain("link from the computer running the overlay"); // the broadcaster link only exists on the streamer listener
  expect(streamer.text).not.toContain('href="/auth/twitch/broadcaster"');
});

test("/logout clears the session cookie and goes home; unknown paths and non-GET page requests stay 404 JSON", async () => {
  const f = mk();
  const out = await call(f, "funnel", "GET", "/logout", MOD);
  expect(out.status).toBe(302);
  expect(out.headers.get("location")).toBe("/");
  expect(out.headers.get("set-cookie")).toMatch(/^tpo_session=; Max-Age=0;/);

  for (const [method, p] of [["GET", "/nope"], ["POST", "/"], ["POST", "/help"], ["GET", "/dashboard/nope.js"]] as const) {
    const res = await call(f, "streamer", method, p);
    expect([method, p, res.status]).toEqual([method, p, 404]);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
  }
});

test("GET /dashboard/client.js is served as JavaScript and carries the CSRF header name and value", async () => {
  const f = mk();
  const res = await call(f, "streamer", "GET", "/dashboard/client.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  const js = await res.text();
  expect(js).toContain(CSRF_HEADER);
  expect(js).toContain(CSRF_VALUE);
  expect(js).toContain("location.reload()");
  expect(js).toContain("Tap again to Fire");
  expect(js).toContain('body.message = "Ko-fi"');
  // Put it back asks its reason in plain words; Draw again arms the one FIRE button rather than firing on its own
  expect(js).toContain('reasonFor("putting #" + d.seq + " back")');
  expect(js).not.toContain("re-banking fire");
  expect(js).toMatch(/case "fire":[^]*?fire\.click\(\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------------------------------------------------

test("Live: one number with a bar under it, two quiet cards, one FIRE, five plain Latest lines, credit behind Add a tip by hand, no overlay URL", async () => {
  const f = mk();
  for (let i = 0; i < 4; i++) expect((await call(f, "streamer", "POST", "/api/threshold", { body: { cents: 5000 } })).status).toBe(200); // four older lines that move nothing; the seeds never count (hidden)
  const seq = await credit(f, 1300);
  const r = await page(f, "streamer", "/");
  // one number first — $13 big, "of $50" small — and a bar whose width is the fraction
  expect(r.text).toMatch(/<div class="big-number">\$13<small> of \$50<\/small><\/div>/);
  expect(r.text).toContain('<div class="bar"><i style="width:26%"></i></div>');
  // two quiet cards: READY N and Tier N with the gate as the subline
  expect(r.text).toContain('<div class="card"><h2>Ready</h2><div class="n">0</div>');
  expect(r.text).toContain('<div class="card"><h2>Tier</h2><div class="n">0</div><p class="sub">3 to Tier 1</p></div>');
  // exactly one FIRE button, and it is the only control painted with --fire
  expect(r.text.match(/id="fire"/g)?.length).toBe(1);
  expect(r.text).toContain(">FIRE<");
  expect(r.text.match(/var\(--fire\)/g)?.length).toBe(2); // the #fire rule's background + border, nothing else
  expect(r.text).toMatch(/#fire\{[^}]*background:var\(--fire\)/);
  expect(r.text).not.toContain('class="primary"'); // no second loud button on Live: the credit form's submit is quiet
  // nothing has come up yet: no "Just came up" and no Draw again / Put it back
  expect(r.text).not.toContain("Just came up");
  expect(r.text).not.toContain('data-action="fire"');
  expect(r.text).not.toContain('data-action="rebank"');
  // Latest: five plain lines, no table, no action buttons; the newest is alice's tip
  expect(r.text).not.toContain("<table");
  expect(r.text.match(/<li class="entry/g)?.length).toBe(5);
  expect(r.text).toContain("@alice tipped $13 (+$13)");
  expect(r.text).not.toContain(`data-action="void" data-seq="${seq}"`);
  expect(r.text).not.toContain("data-action=\"void\"");
  expect(r.text).toContain('href="/ledger"');
  // the overlay URL lives on Config now
  expect(r.text).not.toContain("Overlay URL");
  expect(r.text).not.toContain("192.168.1.20:8702/overlay");
  // manual credit folded behind "Add a tip by hand", the form and its face kinds intact
  expect(r.text).toMatch(/<details[^>]*><summary>Add a tip by hand<\/summary>[^]*?<form id="credit">[^]*?<\/form><\/details>/);
  for (const kind of ["tip", "kofi", "bits", "sub", "gift"]) expect(r.text).toContain(`value="${kind}"`);
  expect(r.text).toContain('name="anonymous"');
  // plain words: the internal names never surface as the page's own copy (Latest lines are describeEntry's, checked elsewhere)
  const own = r.text.replace(/<ul class="latest">[^]*?<\/ul>/, "").replace(/<style>[^]*?<\/style>/, "").replace(/<nav>[^]*?<\/nav>/, "");
  expect(own).not.toMatch(/\bLedger\b/);
  expect(own).not.toMatch(/re-bank/i);
  expect(own).not.toContain("Manual Credit");
  expect(r.text).toContain("No overlay connected");
});

test("Live: one line per connected overlay with its Quality Level, mode, misses and WebGL state; gone with the socket", async () => {
  const f = mk();
  const a = { send: () => undefined };
  const b = { send: () => undefined };
  f.hub.attach(a);
  f.hub.attach(b);
  f.hub.receive(a, JSON.stringify({ type: "quality", level: 4, mode: "auto", missRatio: 0.031, webgl: true, stable: true }));
  f.hub.receive(b, JSON.stringify({ type: "quality", level: 2, mode: "manual", missRatio: 0, webgl: false, stable: true }));
  let r = await page(f, "streamer", "/");
  expect(r.text).toContain("Overlay · Level 4 (auto) · 3 % misses · WebGL on");
  expect(r.text).toContain("Overlay · Level 2 (manual) · 0 % misses · WebGL off");
  expect(r.text).not.toContain("No overlay connected");
  f.hub.detach(a);
  r = await page(f, "streamer", "/");
  expect(r.text).not.toContain("Level 4 (auto)");
  expect(r.text).toContain("Level 2 (manual)");
  r = await page(f, "funnel", "/", MOD); // mods see it too
  expect(r.text).toContain("Level 2 (manual)");
});

test("Live: how many people are chatting, in plain words, under the overlay line and above FIRE, for both roles", async () => {
  const f = mk();
  expect((await page(f, "streamer", "/")).text).toContain('<p class="chatters-line">Nobody chatting yet</p>');
  f.chatters.fake();
  expect((await page(f, "streamer", "/")).text).toContain('<p class="chatters-line">1 person chatting</p>');
  f.chatters.fake();
  f.chatters.fake();
  const r = await page(f, "funnel", "/", MOD); // mods see it too
  expect(r.text).toContain('<p class="chatters-line">3 people chatting</p>');
  expect(r.text.indexOf("overlay-line")).toBeLessThan(r.text.indexOf("chatters-line"));
  expect(r.text.indexOf("chatters-line")).toBeLessThan(r.text.indexOf('id="fire"'));
});

test("Live: after a $50 credit the number is $0 of $50 and READY 1; after a Fire, Just came up names the Outcome with Put it back / Draw again; putting it back clears it", async () => {
  const f = mk({
    config: (c) => {
      c.tiers.gates = [0, 1]; // one banked unlock opens the last tier
      c.outcomes = c.outcomes.filter((o) => o.tier <= 1);
    },
    now: () => new Date(), // the Ledger stamps the fire with the real clock; the same clock here reads "just now"
  });
  await credit(f, 5000);
  let r = await page(f, "streamer", "/");
  expect(r.text).toMatch(/<div class="big-number">\$0<small> of \$50<\/small><\/div>/);
  expect(r.text).toContain('<div class="bar"><i style="width:0%"></i></div>');
  expect(r.text).toContain('<h2>Ready</h2><div class="n">1</div>');
  expect(r.text).toContain('<p class="sub">all tiers open</p>');
  const fireSeq = await fire(f);
  r = await page(f, "streamer", "/");
  const came = /<section class="came-up">([^]*?)<\/section>/.exec(r.text);
  expect(came).not.toBeNull();
  expect(came![1]).toContain("<h2>Just came up</h2>");
  expect(came![1]).toContain("🎟️");
  expect(came![1]).toContain("STICKERS");
  expect(came![1]).toContain("came up just now"); // entry.ts === now (T0)
  expect(came![1]).toContain(`<button type="button" data-action="rebank" data-seq="${fireSeq}">Put it back</button>`);
  expect(came![1]).toContain('<button type="button" data-action="fire">Draw again</button>');
  expect(r.text.match(/id="fire"/g)?.length).toBe(1); // Draw again is not a second FIRE button
  expect(r.text).toContain('<h2>Ready</h2><div class="n">0</div>');
  expect(r.text).toContain("🎟️ STICKERS for @alice (4 left)"); // the Latest line, describeEntry's wording
  // put it back: the fire is re-banked, so nothing "just came up" any more
  expect((await call(f, "streamer", "POST", `/api/fires/${fireSeq}/rebank`, { body: { reason: "guest not up for it" } })).status).toBe(200);
  r = await page(f, "streamer", "/");
  expect(r.text).not.toContain("Just came up");
  expect(r.text).not.toContain('data-action="rebank"');
  expect(r.text).toContain('<h2>Ready</h2><div class="n">1</div>');
});

test("Live: Just came up shows the most recent fire that was not put back, and the bare id when the Outcome left the config", async () => {
  const f = mk();
  await credit(f, 5000);
  const first = await fire(f); // STICKERS (rng 0)
  await credit(f, 5000);
  const second = await fire(f);
  expect((await call(f, "streamer", "POST", `/api/fires/${second}/rebank`, { body: { reason: "again" } })).status).toBe(200);
  let r = await page(f, "streamer", "/");
  expect(r.text).toContain(`data-action="rebank" data-seq="${first}"`);
  expect(r.text).not.toContain(`data-action="rebank" data-seq="${second}"`);
  // the Outcome behind the fire is gone from the config: the bare id stands in for glyph + name
  const cfg = structuredClone(f.config.get());
  cfg.outcomes = cfg.outcomes.filter((o) => o.id !== "stickers");
  expect((await call(f, "streamer", "PUT", "/api/config", { body: cfg })).status).toBe(200);
  r = await page(f, "streamer", "/");
  const came = /<section class="came-up">([^]*?)<\/section>/.exec(r.text);
  expect(came).not.toBeNull();
  expect(came![1]).toContain("stickers");
  expect(came![1]).not.toContain("STICKERS");
});

test("ago(): plain relative time for the Just came up line", () => {
  const now = new Date("2026-09-12T22:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  expect(ago(at(0), now)).toBe("just now");
  expect(ago(at(59_000), now)).toBe("just now");
  expect(ago(at(60_000), now)).toBe("1 min ago");
  expect(ago(at(2 * 60_000 + 5_000), now)).toBe("2 min ago");
  expect(ago(at(59 * 60_000), now)).toBe("59 min ago");
  expect(ago(at(60 * 60_000), now)).toBe("1 hour ago");
  expect(ago(at(3 * 3_600_000 + 40 * 60_000), now)).toBe("3 hours ago");
  expect(ago(at(-5_000), now)).toBe("just now"); // a clock skew never reads as the future
});

test("Ledger: a config change that had to be cut gets a Show all under its summary (a draw-list edit as added / removed, other settings with before → after); a short one does not", async () => {
  const f = mk();
  const cfg = structuredClone(f.config.get()); // a clone: editing the store's own object in place would leave nothing to diff
  cfg.lists.genreRoulette = [...cfg.lists.genreRoulette, "A", "B", "C", "D", "E"];
  expect((await call(f, "streamer", "PUT", "/api/config", { body: cfg })).status).toBe(200);
  const r = await page(f, "streamer", "/ledger");
  expect(r.text).toContain("1 change: genre roulette +5"); // five index lines folded into what was added
  expect(r.text).toContain('<details class="more"><summary>Show all </summary><ul>');
  expect(r.text).toContain("<li>genre roulette: added A, B, C, D, E</li>");
  expect(r.text).not.toContain("lists.genreRoulette.");
  const short = mk();
  expect((await call(short, "streamer", "POST", "/api/threshold", { body: { cents: 2500 } })).status).toBe(200);
  expect((await page(short, "streamer", "/ledger")).text).not.toContain('class="more"');
});

test("the Engine's stock seeds (reason initial) never show on the Ledger page or in Latest — a fresh boot reads as nothing happened yet; a Left edit still shows", async () => {
  const f = mk();
  expect(f.ledger.all().filter((e) => e.type === "stock").length).toBeGreaterThan(0); // the seeds are in the Ledger
  const fresh = await page(f, "streamer", "/ledger");
  expect(fresh.text).toContain("Nothing in the Ledger yet.");
  expect(fresh.text).not.toContain("(initial)");
  expect((await page(f, "streamer", "/")).text).toContain("Nothing yet tonight.");

  await credit(f, 100, "alice");
  expect((await call(f, "streamer", "PUT", "/api/outcomes/stickers", { body: { left: 9 } })).status).toBe(200);
  const after = await page(f, "streamer", "/ledger");
  expect(after.text).toContain("alice");
  expect(after.text).toContain("(left edit)");
  expect(after.text).not.toContain("(initial)");
  const live = await page(f, "streamer", "/");
  expect(live.text).toContain("alice");
  expect(live.text).not.toContain("(initial)");
});

test("Live: every interpolated user string is escaped", async () => {
  const f = mk();
  await credit(f, 100, "<img src=x onerror=alert(1)>");
  f.health.set("kofi", "info", "Service (re)started <b>now</b>");
  const r = await page(f, "streamer", "/");
  expect(r.text).not.toContain("<img src=x");
  expect(r.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(r.text).not.toContain("<b>now</b>");
  expect(r.text).toContain("&lt;b&gt;now&lt;/b&gt;");
});

test("Live: health banners render with a Dismiss button carrying the banner id", async () => {
  const f = mk();
  f.health.set("firebot", "warn", "Firebot didn't respond for STICKERS — type !raffle 1 120 in chat");
  const r = await page(f, "streamer", "/");
  expect(r.text).toContain("Firebot didn&#39;t respond for STICKERS");
  expect(r.text).toContain('data-action="dismiss" data-id="firebot"');
  expect(r.text).toContain("Dismiss");
});

// ---------------------------------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------------------------------

test("Ledger: newest first with seq/time/type/actor/summary, Void on contributions, Re-bank on fires, a Winner form on raffle fires only", async () => {
  const f = mk();
  const seq = await credit(f, 5000, "alice");
  const raffleFire = await fire(f);
  await credit(f, 5000, "carol");
  const r = await page(f, "streamer", "/ledger");
  expect(r.status).toBe(200);
  expect(r.text).toContain("<table");
  expect(r.text).toContain(`data-action="void" data-seq="${seq}"`);
  expect(r.text).toContain(`data-action="rebank" data-seq="${raffleFire}"`);
  expect(r.text).toContain(`data-action="winner" data-seq="${raffleFire}"`);
  expect(r.text).toContain("twitch:dj");
  expect(r.text).toContain("$50");
  // newest first: carol's contribution precedes alice's
  expect(r.text.indexOf("carol")).toBeLessThan(r.text.indexOf("alice"));

  const plain = mk({ rng: () => 0.99 }); // COSTUME · 30 MIN, no raffle
  await credit(plain, 5000);
  const plainFire = await fire(plain);
  const p = await page(plain, "streamer", "/ledger");
  expect(p.text).toContain(`data-action="rebank" data-seq="${plainFire}"`);
  expect(p.text).not.toContain(`data-action="winner"`);
});

test("Ledger: a voided contribution and a re-banked fire lose their buttons; a recorded winner shows on the fire", async () => {
  const f = mk();
  const seq = await credit(f, 5000);
  const fireSeq = await fire(f);
  expect((await call(f, "streamer", "POST", `/api/fires/${fireSeq}/winner`, { body: { winner: "carol" } })).status).toBe(200);
  expect((await call(f, "streamer", "POST", `/api/contributions/${seq}/void`, { body: { reason: "typo" } })).status).toBe(200);
  const r = await page(f, "streamer", "/ledger");
  expect(r.text).not.toContain(`data-action="void" data-seq="${seq}"`);
  expect(r.text).toContain("winner of fire #");
  expect(r.text).toContain("carol");
  expect((await call(f, "streamer", "POST", `/api/fires/${fireSeq}/rebank`, { body: { reason: "guest not up for it" } })).status).toBe(200);
  const after = await page(f, "streamer", "/ledger");
  expect(after.text).not.toContain(`data-action="rebank" data-seq="${fireSeq}"`);
});

test("Ledger: ?before= pages older entries with an Older link; the Giveaways page lists only raffle fires with their winners", async () => {
  const f = mk();
  for (let i = 0; i < 60; i++) await credit(f, 100, `viewer${i}`);
  const first = await page(f, "streamer", "/ledger");
  expect(first.text).toContain("viewer59");
  expect(first.text).not.toMatch(/viewer0\b/); // 60 contributions → the first page (50) stops before the oldest
  const older = /href="\/ledger\?before=(\d+)"/.exec(first.text);
  expect(older).not.toBeNull();
  const second = await page(f, "streamer", `/ledger?before=${older![1]}`);
  expect(second.text).toContain("viewer0");
  expect(second.text).not.toContain("viewer59");
  expect(second.text).not.toContain("/ledger?before="); // the last page has no Older link
  for (const bad of ["99999999999999999999", "1e3", "-5", "abc"]) {
    const r = await page(f, "streamer", `/ledger?before=${bad}`);
    expect([bad, r.status]).toEqual([bad, 200]);
    expect(r.text).toContain("viewer59"); // not a safe integer → the newest page
  }

  await credit(f, 5000, "alice");
  const raffleFire = await fire(f);
  expect((await call(f, "streamer", "POST", `/api/fires/${raffleFire}/winner`, { body: { winner: "carol" } })).status).toBe(200);
  const g = await page(f, "streamer", "/giveaways");
  expect(g.status).toBe(200);
  expect(g.text).toContain("STICKERS");
  expect(g.text).toContain("carol");
  expect(g.text).not.toContain("viewer59");
  expect(g.text).not.toContain("viewer0");
  expect(first.text).toContain('href="/giveaways"');
  expect(first.text).not.toContain("giveaways=1");
});

test("Giveaways page: nothing open → says so, with Close & draw still there for whatever Firebot holds; an open raffle shows the prize, since when and the two buttons; the settings form is streamer-only", async () => {
  const f = mk({ config: (c) => (c.firebot.enabled = true) });
  const idle = await page(f, "funnel", "/giveaways", MOD);
  expect(idle.status).toBe(200);
  expect(idle.text).toContain("Nothing open");
  expect(idle.text).toContain("nothing reaches chat until someone presses Start");
  // every button is always there; the ones that make no sense right now are disabled (the streamer's rule)
  for (const a of ["giveaway-close-and-draw", "giveaway-close", "giveaway-draw", "giveaway-reopen", "giveaway-clear"]) expect(idle.text).toContain(`data-action="${a}" disabled>`);
  expect(idle.text).toContain('<div class="gbtn now"><form id="giveaway-start"'); // nothing on: Start is the one that fits
  expect(idle.text).toContain('<input name="prize" placeholder="Prize" value="" required>');
  expect(idle.text).toContain('id="giveaway-takeover"'); // after a restart Firebot may still hold one: the box turns the others on
  expect(idle.text).not.toContain('id="giveaway-settings"'); // Firebot settings are the streamer's

  // a raffle Fire: waiting, nothing in chat, Start prefilled with its prize and carrying its seq
  await credit(f, 5000, "alice");
  const raffleFire = await fire(f);
  await new Promise((r) => setTimeout(r, 10));
  const waiting = await page(f, "streamer", "/giveaways");
  expect(waiting.text).toContain("Nothing open");
  expect(waiting.text).toContain(`<strong>Waiting to start:</strong> STICKERS <span class="muted">(fire #${raffleFire})</span>`);
  expect(waiting.text).toContain(`<form id="giveaway-start" autocomplete="off" class="row" data-fire-seq="${raffleFire}">`);
  expect(waiting.text).toContain('<input name="prize" placeholder="Prize" value="STICKERS" required>');
  expect(waiting.text).toContain(">Start STICKERS</button>");
  expect(waiting.text).toContain(`Fire #${raffleFire} came up and nothing has reached chat yet.`);

  expect((await call(f, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: raffleFire } })).status).toBe(200);
  const open = await page(f, "streamer", "/giveaways");
  expect(open.text).toContain("Entries open");
  expect(open.text).toContain("STICKERS");
  expect(open.text).toContain(`fire #${raffleFire}`);
  expect(open.text).not.toContain("Waiting to start");
  expect(open.text).toContain('<div class="gbtn now"><button type="button" class="primary" data-action="giveaway-close-and-draw">');
  expect(open.text).toContain('<div class="gbtn now"><button type="button" data-action="giveaway-close">');
  for (const a of ["giveaway-draw", "giveaway-reopen", "giveaway-clear"]) expect(open.text).toContain(`data-action="${a}" disabled>`);
  expect(open.text).toContain('<input name="prize" placeholder="Prize" value="" required disabled>');
  expect(open.text).not.toContain('id="giveaway-takeover"');
  expect(open.text).toContain("&quot;The giveaway is now closed.&quot;");
  expect(open.text).toContain("Congratulations @name! You win the giveaway!");
  expect(open.text).toContain("!giveaway leave");
  expect(open.text).toContain('id="giveaway-settings"');
  expect(open.text).toContain('name="autoClose"');
  expect(open.text).toContain('value="off"'); // autoCloseSeconds 0 → the box says off
  expect(open.text).toContain('name="firebotEnabled" checked');

  // closed with a winner: Draw again, Reopen, Done (with its confirm) — and no way to close again
  expect((await call(f, "streamer", "POST", "/api/giveaway/close-and-draw")).status).toBe(200);
  const closed = await page(f, "streamer", "/giveaways");
  expect(closed.text).toContain("Closed · winner drawn");
  expect(closed.text).toContain(">Draw again<");
  expect(closed.text).toContain('data-action="giveaway-reopen"');
  expect(closed.text).toContain('data-action="giveaway-clear"');
  expect(closed.text).toContain('id="giveaway-clear-confirm"');
  expect(closed.text).toContain("A Draw again is impossible afterwards");
  expect(closed.text).toContain('<div class="gbtn now"><button type="button" class="primary" data-action="giveaway-draw">Draw again</button>');
  for (const a of ["giveaway-close-and-draw", "giveaway-close"]) expect(closed.text).toContain(`data-action="${a}" disabled>`);
  expect(closed.text).toContain("&quot;The giveaway has been reopened.&quot;");
  expect(closed.text).toContain("&quot;The giveaway list has been cleared.&quot;");

  // reopened and closed again: the earlier winner still counts, so it stays "winner drawn"
  expect((await call(f, "streamer", "POST", "/api/giveaway/reopen")).status).toBe(200);
  expect((await page(f, "streamer", "/giveaways")).text).toContain("Entries open");
  expect((await call(f, "streamer", "POST", "/api/giveaway/close")).status).toBe(200);
  expect((await page(f, "streamer", "/giveaways")).text).toContain("Closed · winner drawn");

  // done: back to nothing open
  expect((await call(f, "streamer", "POST", "/api/giveaway/clear")).status).toBe(200);
  expect((await page(f, "streamer", "/giveaways")).text).toContain("Nothing open");

  // a fresh giveaway closed without a draw: the draw button says so
  const g2 = mk({ config: (c) => (c.firebot.enabled = true) });
  await credit(g2, 5000, "alice");
  const f2 = await fire(g2);
  expect((await call(g2, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: f2 } })).status).toBe(200);
  expect((await call(g2, "streamer", "POST", "/api/giveaway/close")).status).toBe(200);
  const closedNoDraw = await page(g2, "streamer", "/giveaways");
  expect(closedNoDraw.text).toContain("Closed · nothing drawn yet");
  expect(closedNoDraw.text).toContain(">Draw a winner<");

  const timed = mk({ config: (c) => ((c.firebot.enabled = true), (c.firebot.autoCloseSeconds = 150)) });
  expect((await page(timed, "streamer", "/giveaways")).text).toContain('value="2m30s"');
  const off = mk();
  expect((await page(off, "streamer", "/giveaways")).text).toContain("Firebot is off");
});

test("Giveaways page: two raffle Fires wait in order; Start takes the oldest; the next is prefilled once the first is Done", async () => {
  const f = mk({ config: (c) => (c.firebot.enabled = true) });
  await credit(f, 5000, "alice");
  const first = await fire(f);
  await credit(f, 5000, "bob");
  const second = await fire(f); // rng 0: stickers again (5 left)
  const both = await page(f, "streamer", "/giveaways");
  expect(both.text).toContain(`(fire #${first})</span> · STICKERS <span class="muted">(fire #${second})</span>`);
  expect(both.text).toContain(`data-fire-seq="${first}"`);
  expect((await call(f, "streamer", "POST", "/api/giveaway/start", { body: { fireSeq: first } })).status).toBe(200);
  const open = await page(f, "streamer", "/giveaways");
  expect(open.text).toContain(`<strong>Waiting to start:</strong> STICKERS <span class="muted">(fire #${second})</span>`);
  expect(open.text).toContain('<input name="prize" placeholder="Prize" value="STICKERS" required disabled>'); // the second waits its turn
  expect((await call(f, "streamer", "POST", "/api/giveaway/close-and-draw")).status).toBe(200);
  expect((await call(f, "streamer", "POST", "/api/giveaway/clear")).status).toBe(200);
  expect((await page(f, "streamer", "/giveaways")).text).toContain(`<form id="giveaway-start" autocomplete="off" class="row" data-fire-seq="${second}">`);
});

test("Debug page: a dry-run giveaway — the button, then the open dry run with its transcript and Close & draw on both Debug and Giveaways (badged: nothing reaches chat)", async () => {
  const f = mk(); // Firebot off: a dry run does not care
  const idle = await page(f, "streamer", "/debug");
  expect(idle.text).toContain('data-action="debug-giveaway"');
  expect((await call(f, "streamer", "POST", "/api/giveaway/dry-run", { body: { prize: "USB STICK" } })).status).toBe(200);
  const open = await page(f, "streamer", "/debug");
  expect(open.text).not.toContain('data-action="debug-giveaway"');
  expect(open.text).toContain("USB STICK");
  expect(open.text).toContain('data-action="giveaway-close-and-draw"');
  expect(open.text).toContain("chat (Bot): 🎁 Tonight&#39;s prize: USB STICK");
  const g = await page(f, "funnel", "/giveaways", MOD);
  expect(g.text).toContain("dry run, nothing reaches chat");
  expect(g.text).toContain("from the Debug page, no Fire");
  expect(g.text).toContain("firebot: !giveaway start → empties the entrant list");
  expect(g.text).not.toContain("Firebot is off"); // the dry run runs regardless; no need to nag

  // closed: the button is back and the transcript stays readable as "Last dry run" until the next giveaway opens
  expect((await call(f, "streamer", "POST", "/api/giveaway/close-and-draw")).status).toBe(200);
  expect((await page(f, "streamer", "/debug")).text).toContain('data-action="giveaway-clear"'); // closed: Done is offered on the Debug page too
  expect((await call(f, "streamer", "POST", "/api/giveaway/clear")).status).toBe(200);
  const after = await page(f, "streamer", "/debug");
  expect(after.text).toContain('data-action="debug-giveaway"');
  expect(after.text).toContain("Last dry run:");
  expect(after.text).toContain("firebot: !giveaway clear");
});

test("Ledger: exactly one page of entries has no Older link; one more entry brings it back", async () => {
  const f = mk();
  const bootSeeds = 1 + defaultConfig().outcomes.length; // the threshold seed + one stock seed per Outcome
  for (let i = 0; i < LEDGER_PAGE - bootSeeds; i++) await credit(f, 50, `viewer${i}`); // + the boot seeds = exactly one page; 50¢ each: no crossing, so no extra `unlock` row
  const full = await page(f, "streamer", "/ledger");
  expect(full.text).toContain("viewer0");
  expect(full.text).not.toContain("/ledger?before=");
  await credit(f, 50, "one-more");
  const more = await page(f, "streamer", "/ledger");
  expect(more.text).toMatch(/href="\/ledger\?before=\d+"/);
  expect(more.text).toMatch(/viewer0\b/);
  expect(more.text).not.toContain("threshold →"); // 51 entries → the newest 50; the oldest (the threshold seed) waits on the next page
});

test("Ledger: a contribution's message shows in its summary (a Ko-fi Manual Credit carries \"Ko-fi\")", async () => {
  const f = mk();
  const res = await call(f, "streamer", "POST", "/api/contributions", { body: { face: { kind: "tip", cents: 1000 }, displayName: "dana", message: "Ko-fi" } });
  expect(res.status).toBe(200);
  const r = await page(f, "streamer", "/ledger");
  expect(r.text).toContain("@dana tipped $10 (+$10) · Ko-fi");
});

// ---------------------------------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------------------------------

test("Pool page: table grouped by Tier, Used / Left columns, streamer rows expand, mod rows do not", async () => {
  const f = mk();
  expect((await call(f, "streamer", "POST", "/api/outcomes/oven-mitts/status", { body: { status: "suspended" } })).status).toBe(200);
  expect((await call(f, "streamer", "POST", "/api/outcomes/shirt-t0/status", { body: { status: "retired" } })).status).toBe(200);
  const s = await page(f, "streamer", "/pool");
  expect(s.status).toBe(200);
  expect(s.text).toContain('<main class="xwide">');
  expect(s.text.match(/<tr class="tier">/g)?.length).toBe(3); // one header per tier present
  expect(s.text).toContain("main.xwide{max-width:none;padding:1rem 2rem}"); // the wide table's gutter; the 640 px query keeps its own smaller padding
  expect(s.text).toContain("live from the start");
  expect(s.text).toContain("opens at 3 banked");
  expect(s.text).toContain(">Used <");
  expect(s.text).toContain(">Left <");
  expect(s.text).not.toMatch(/\bcharges\b/i);
  expect(s.text).toContain("🥧");
  expect(s.text).toContain("PIE TO THE FACE");
  expect(s.text).toMatch(/data-id="stickers"[^]*?<td class="num used muted">0<\/td><td class="num left"><strong>5<\/strong>/);
  expect(s.text).toContain('data-act="edit" data-id="stickers"');
  expect(s.text).toContain('data-act="suspend" data-id="stickers" tabindex="-1"');
  expect(s.text).toContain('data-act="retire" data-id="stickers" tabindex="-1"');
  expect(s.text).not.toContain('data-act="restock" data-id="stickers"'); // one-off
  expect(s.text).toContain('data-act="restock" data-id="oven-mitts" tabindex="-1"');
  expect(s.text).toContain('data-act="resume" data-id="oven-mitts" tabindex="-1"');
  expect(s.text).not.toContain('data-act="suspend" data-id="oven-mitts"');
  expect(s.text).not.toContain('data-act="suspend" data-id="shirt-t0"'); // retired is permanent: no buttons at all
  expect(s.text).not.toContain('data-act="retire" data-id="shirt-t0"');
  expect(s.text).toContain('class="orow retired" tabindex="0"');
  expect(s.text).toContain('class="status status-suspended">suspended<');
  expect(s.text).toContain("+ Add Outcome");
  expect(s.text).toContain('id="filter"');
  expect(s.text).toContain("The emoji on the pad. One character. It is what the crowd sees first."); // TIPS.glyph verbatim
  expect(s.text).toContain("How many more times it can come up. 0 means it's done until someone restocks it. What already happened is never changed.");
  expect(s.text).toContain('Hover or arrow to a row for its buttons · <kbd>⏎</kbd> edit · <kbd>?</kbd> keyboard shortcuts');
  expect(s.text).not.toMatch(/\bFire\b/); // mod-facing copy: an Outcome "comes up" (Firebot is a product name)
  expect(s.text).toContain('data-action="queue" data-delta="1"');
  expect(s.text).toContain('data-action="queue" data-delta="-1"');
  expect(s.text).toContain("UK GARAGE");
  expect(s.text).toContain("THIRD-PERSON MODE");
  expect(s.text).toContain('<form class="list-editor"'); // the draw lists are edited here now (T4), not "in Config"
  // the What it is line: an ⓘ right after the name whose bubble is the description — and only the ⓘ: no row title
  // (the bubble already shows on hover and on row focus; a native title would show the same words twice)
  const crate = defaultConfig().outcomes.find((o) => o.id === "friend-picks-three")!;
  expect(crate.description.length).toBeGreaterThan(0);
  expect(s.text).toContain(`data-act="edit" data-id="friend-picks-three"><td class="glyph">`);
  expect(s.text).not.toContain(`title="${crate.description}"`);
  expect(s.text).toContain(`<td class="name"><strong>A FRIEND PICKS THREE</strong><i class="tip info" data-tip="description" title="" aria-hidden="true">i<span class="bubble">${crate.description}</span></i><span class="sub">`);
  expect(s.text.match(/<i class="tip info"/g)?.length).toBe(defaultConfig().outcomes.length); // one per row, every row
  expect(s.text).toContain("tr.orow:focus-visible .tip.info .bubble{display:block}");

  const m = await page(f, "funnel", "/pool", MOD);
  expect(m.status).toBe(200);
  expect(m.text).toContain('<main class="xwide modview">');
  expect(m.text).toContain('data-act="noop" data-id="stickers"');
  expect(m.text).not.toContain('data-act="edit"');
  expect(m.text).not.toContain("+ Add Outcome");
  expect(m.text).not.toContain('class="caret');
  expect(m.text).not.toContain("<kbd>⏎</kbd> edit");
  expect(m.text).toContain('data-act="restock" data-id="chat-picks-next"'); // restockable only
  expect(m.text).not.toContain('data-act="restock" data-id="stickers"');
  expect(m.text).toContain('data-act="suspend" data-id="stickers" tabindex="-1"');
  expect(m.text).toContain(`data-act="noop" data-id="friend-picks-three"><td class="glyph">`); // mods get the ⓘ too, and no row title either
  expect(m.text.match(/<i class="tip info"/g)?.length).toBe(defaultConfig().outcomes.length);
  // (every action has a tooltip, and the row buttons are all a mod ever sees): each button carries its TIP as
  // the native title, and data-help so the help bar can name it
  expect(m.text).toContain(`data-act="suspend" data-id="stickers" tabindex="-1" title="${TIPS.suspend}" data-help="suspend">`);
  expect(m.text).toContain(`data-act="retire" data-id="stickers" tabindex="-1" title="${TIPS.retire}" data-help="retire">`);
  expect(m.text).toContain(`data-act="restock" data-id="chat-picks-next" tabindex="-1" title="${TIPS.restock}" data-help="restock">`);
  expect(m.text).toContain(`data-act="resume" data-id="oven-mitts" tabindex="-1" title="${TIPS.resume}" data-help="resume">`);
  expect(m.text).toContain(`<input id="filter" placeholder="Filter…  /" aria-label="Filter Outcomes" data-help="filter" title="${TIPS.filter}" autocomplete="off">`); // its tip works without an open editor
  expect(s.text).toContain(`title="${TIPS.suspend}" data-help="suspend">`);
});

// The Pool rows are painted twice — by pages.ts first, then by client.js after every change (kept that way on purpose). The
// buttons must come out byte-identical from both, so the client's rowButtons (plus the hint it uses) is lifted out of the
// served script and run against the same Outcomes the server rendered.
test("Pool page: client.js's rowButtons renders byte-identical buttons to the server's, for live, suspended, restockable and retired rows", async () => {
  const f = mk();
  expect((await call(f, "streamer", "POST", "/api/outcomes/oven-mitts/status", { body: { status: "suspended" } })).status).toBe(200);
  expect((await call(f, "streamer", "POST", "/api/outcomes/shirt-t0/status", { body: { status: "retired" } })).status).toBe(200);
  const m = await page(f, "funnel", "/pool", MOD);
  const island = JSON.parse(/<script id="pool-data" type="application\/json">([^]*?)<\/script>/.exec(m.text)![1]!);
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  const src = js.slice(js.indexOf("var hint = function"), js.indexOf("// the What it is line"));
  expect(src.length).toBeGreaterThan(200);
  const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rowButtons = new Function("esc", "TIPS", `${src}; return rowButtons;`)(esc, island.tips) as (o: unknown) => string;
  const statuses = new Set<string>();
  let restockable = 0;
  for (const o of island.outcomes as { id: string; status: string; restockable: boolean }[]) {
    const server = new RegExp(`data-id="${o.id}"><td class="glyph">[^]*?<div class="actions">([^]*?)</div></td></tr>`).exec(m.text);
    expect(server, o.id).not.toBeNull();
    expect(rowButtons(o), o.id).toBe(server![1]!);
    statuses.add(o.status);
    if (o.restockable && o.status !== "retired") restockable++;
  }
  expect([...statuses].sort()).toEqual(["live", "retired", "suspended"]);
  expect(restockable).toBeGreaterThan(0);
});

test("Pool page: an Outcome with no What it is line gets no ⓘ and no title — the icon is only for the ones with something to say", async () => {
  const f = mk({ config: (c) => (c.outcomes[0]!.description = "") });
  const r = await page(f, "streamer", "/pool");
  expect(r.text).toContain('data-act="edit" data-id="stickers"><td class="glyph">');
  expect(r.text).toContain('<td class="name"><strong>STICKERS</strong><span class="sub">');
  expect(r.text.match(/<i class="tip info"/g)?.length).toBe(defaultConfig().outcomes.length - 1);
});

test("Pool page carries the pool-data island the editor re-renders from", async () => {
  const f = mk();
  await credit(f, 5000);
  await fire(f); // STICKERS comes up once (rng 0)
  const r = await page(f, "streamer", "/pool");
  const m = /<script id="pool-data" type="application\/json">([^]*?)<\/script>/.exec(r.text);
  expect(m).not.toBeNull();
  expect(m![1]).not.toContain("<");
  const island = JSON.parse(m![1]!);
  expect(island.role).toBe("streamer");
  expect(island.gates).toEqual([0, 3, 6]);
  expect(island.openTier).toBe(0);
  expect(island.lists).toEqual({ genreRoulette: "Genre roulette", chatRules: "Chat rules" });
  expect(island.descriptionMax).toBe(DESCRIPTION_MAX);
  expect(island.outcomes).toHaveLength(defaultConfig().outcomes.length);
  const stickers = island.outcomes.find((o: { id: string }) => o.id === "stickers");
  expect(stickers).toMatchObject({ name: "STICKERS", glyph: "🎟️", shape: "giveaway", tier: 0, used: 1, left: 4, status: "live", restockable: false, raffle: true, occupancy: "instant", description: defaultConfig().outcomes[0]!.description });
  expect(island.tips.description).toMatch(/\bcomes up\b/); // the editor's What it is tooltip, same voice as the rest
  expect(stickers.initialLeft).toBeUndefined(); // never shown
  const mod = await page(f, "funnel", "/pool", MOD);
  expect(JSON.parse(/<script id="pool-data" type="application\/json">([^]*?)<\/script>/.exec(mod.text)![1]!).role).toBe("mod");
});

// The two mini-draw lists are edited in place on the Pool page (the streamer asked for + / − rows, not a textarea): the
// server paints every item as an input so the rows exist without JS; client.js wires + / − / Save. A mod gets the plain list.
test("Pool page: the streamer gets a row editor per draw list — every item in an input, + / − / Save, no Read-only line; a mod gets the plain list and no controls", async () => {
  const f = mk({ config: (c) => (c.lists.chatRules = ["THIRD-PERSON MODE", 'A <B>RULE</B> & "MORE"']) }); // caps: the load path upper-cases, <b> included
  const r = await page(f, "streamer", "/pool");
  expect(r.status).toBe(200);
  expect(r.text).not.toContain("Read-only here");
  const genres = f.config.get().lists.genreRoulette;
  for (const [key, name, items] of [["genreRoulette", "Genre roulette", genres], ["chatRules", "Chat rules", f.config.get().lists.chatRules]] as const) {
    expect(r.text).toContain(`<section><h2>${name}</h2><form class="list-editor" data-list="${key}" data-name="${name}" data-max="${LIST_ITEM_MAX}" autocomplete="off"><ul class="lrows">`);
    for (const item of items) {
      expect(r.text).toContain(`<li class="lrow"><input type="radio" name="sel-${key}" tabindex="-1" aria-label="Select this row"><input class="item" maxlength="${LIST_ITEM_MAX}" value="${escapeHtml(item)}" spellcheck="false" autocomplete="off" aria-label="${name} item" style="text-transform:uppercase"></li>`);
    }
  }
  expect(r.text).toContain('value="A &lt;B&gt;RULE&lt;/B&gt; &amp; &quot;MORE&quot;"');
  // the actions bar: + adds a row, − removes the selected one (disabled until a row is picked), Save is disabled until something changed
  expect(r.text.match(/<button type="button" class="sm" data-list-act="add" title="Add a row" aria-label="Add a row">\+<\/button>/g)).toHaveLength(2);
  expect(r.text.match(/<button type="button" class="sm danger" data-list-act="remove" title="Remove the selected row" aria-label="Remove the selected row" disabled>−<\/button>/g)).toHaveLength(2);
  expect(r.text.match(/<button type="submit" class="sm primary" disabled>Save<\/button>/g)).toHaveLength(2);
  expect(r.text.match(/<p class="lstatus small" aria-live="polite"><\/p>/g)).toHaveLength(2);
  expect(r.text).toContain("CAPS");
  // a mod: the plain list — no inputs, no buttons, and no "edit in Config" (a mod cannot)
  const m = await page(f, "funnel", "/pool", MOD);
  expect(m.status).toBe(200);
  expect(m.text).toContain("<section><h2>Genre roulette</h2><ul>");
  for (const item of genres) expect(m.text).toContain(`<li>${escapeHtml(item)}</li>`);
  expect(m.text).toContain("<section><h2>Chat rules</h2><ul><li>THIRD-PERSON MODE</li><li>A &lt;B&gt;RULE&lt;/B&gt; &amp; &quot;MORE&quot;</li></ul></section>");
  expect(m.text).not.toContain('<form class="list-editor"');
  expect(m.text).not.toContain('class="item"');
  expect(m.text).not.toContain('data-list-act=');
  expect(r.text).not.toContain('data-act="add" title'); // never data-act: the Outcome editor's document click handler owns that name
  expect(m.text).not.toContain("Read-only");
  expect(m.text).not.toContain("edit in Config");
});

// client.js has no DOM harness; the pure pieces of the list editors are lifted out of the served script and run here —
// itemsOf is the one helper both surfaces (Pool rows, Config textareas) save through, and listRow must paint the same row
// as pages.ts so the rows look the same before and after a save.
test("client.js: itemsOf trims, upper-cases, drops blanks and exact repeats, keeps order — from textarea text or from rows; listRow paints the server's row byte-identically", async () => {
  const f = mk();
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  const src = js.slice(js.indexOf("function itemsOf("), js.indexOf("function listRow("));
  expect(src.length).toBeGreaterThan(100);
  const { itemsOf, typedCount } = new Function(`${src}; return { itemsOf: itemsOf, typedCount: typedCount };`)() as { itemsOf: (s: string | string[]) => string[]; typedCount: (s: string | string[]) => number };
  expect(itemsOf("  funk \n\nFUNK\nhouse\r\n Funk\n")).toEqual(["FUNK", "HOUSE"]);
  expect(itemsOf([" a ", "", "A", "b", "\t"])).toEqual(["A", "B"]);
  expect(itemsOf("")).toEqual([]);
  expect(itemsOf([])).toEqual([]);
  expect(typedCount("  funk \n\nFUNK\nhouse\r\n Funk\n")).toBe(4);
  expect(typedCount([" a ", "", "A", "b", "\t"])).toBe(3);
  expect(js).toContain("normaliseList"); // itemsOf mirrors schema.ts's normaliseList and says so
  expect(js).not.toContain("function linesOf("); // one helper, not two

  const rowSrc = js.slice(js.indexOf("function listRow("), js.indexOf("// Draw lists (Config page)"));
  expect(rowSrc.length).toBeGreaterThan(100);
  const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); // client.js's esc — the server's five characters
  const listRow = new Function("esc", `${rowSrc}; return listRow;`)(esc) as (key: string, name: string, max: number, item: string) => string;
  const r = await page(f, "streamer", "/pool");
  for (const [key, name, items] of [["genreRoulette", "Genre roulette", f.config.get().lists.genreRoulette], ["chatRules", "Chat rules", f.config.get().lists.chatRules]] as const) {
    for (const item of items) expect(r.text, item).toContain(listRow(key, name, LIST_ITEM_MAX, item));
  }
  // the Pool editors and the Config textareas save through the same helper and the same whole-config PUT
  expect(js).toContain("form.list-editor");
  expect(js).toContain('api("PUT", "/api/config", cfg)');
});

test("Pool page: a user string in an Outcome is escaped in the rows and cannot close the JSON island", async () => {
  const f = mk({
    config: (c) => {
      c.outcomes[0]!.name = '</script><img src=x onerror=alert(1)>';
      c.outcomes[0]!.description = '"><img src=y onerror=alert(2)>';
    },
  });
  const r = await page(f, "streamer", "/pool");
  expect(r.text).not.toContain("<img src=x");
  expect(r.text).not.toContain("<img src=y");
  expect(r.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(r.text).toContain('<span class="bubble">&quot;&gt;&lt;img src=y onerror=alert(2)&gt;</span>'); // the bubble cannot be closed early
  expect(r.text).not.toContain('title="&quot;'); // and there is no row title to escape
  const m = /<script id="pool-data" type="application\/json">([^]*?)<\/script>/.exec(r.text);
  expect(m![1]).not.toContain("</script>");
  expect(JSON.parse(m![1]!).outcomes[0].name).toBe('</script><img src=x onerror=alert(1)>');
});

test("client.js: editor posts to /api/outcomes, keeps one tab stop per row, help bar follows focus, tooltips clamp in viewport coordinates", async () => {
  const f = mk();
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  expect(js).toContain('getElementById("pool-data")');
  expect(js).toContain('"/api/outcomes"');
  expect(js).toContain('"/api/outcomes/" + encodeURIComponent(');
  expect(js).toContain('api("PUT", outcomePath(id), body)');
  expect(js).toContain('api("DELETE", outcomePath(target.id))');
  expect(js).toContain('api("POST", outcomePath(o.id) + "/status", { status: "suspended" })');
  expect(js).toContain('api("GET", "/api/state")');
  expect(js).toContain('tabindex="-1"');
  expect(js).toContain('id="helpbar"');
  expect(js).toContain('body.classList.add("kbd")');
  expect(js).toContain("Changes apply from the next drop; the overlay updates live.");
  expect(js).toContain("Can't delete — it has come up. Retire it instead.");
  expect(js).toContain("innerWidth");
  expect(js).toContain("innerHeight");
  // the editor section is delimited; inside it nothing says "Fire" — an Outcome "comes up" (the FIRE button's own copy lives outside it)
  const editor = js.slice(js.indexOf("// ===== Outcome editor (Pool page)"), js.indexOf("// ===== end Outcome editor"));
  expect(editor.length).toBeGreaterThan(1000);
  expect(editor).not.toMatch(/\bFire\b/);
  expect(editor).toMatch(/\bcomes? up\b/);
  // the What it is line: an input in the form, its label, the same ⓘ markup as the server's rows, and the filter matches it
  expect(editor).toContain('<input name="description" data-help="description"');
  expect(editor).toContain(`maxlength="' + DESCRIPTION_MAX + '"`); // the limit comes from the island (schema.ts's DESCRIPTION_MAX), not a literal
  expect(editor).toContain("var DESCRIPTION_MAX = P.descriptionMax;");
  expect(editor).not.toContain('maxlength="240"');
  expect(editor).toContain('description: "What it is"');
  expect(editor).toContain('description: String(f.get("description") || "").trim()');
  expect(editor).toContain('<i class="tip info" data-tip="description" title="" aria-hidden="true">i<span class="bubble">'); // title="" so hovering the ⓘ shows the bubble alone, not the row's native title a second later
  expect(editor).toContain('[o.name, o.shape, "tier " + o.tier, o.status, o.occupancy, o.description, flags(o)]');
  expect(editor).not.toContain("' title=\"' + esc(o.description)"); // no row title: the ⓘ bubble is the one place the line shows
  expect(editor).toContain(`data-help="filter" title="' + esc(TIPS.filter) + '"`);
});

// Two client behaviours a grep can pin down: the mock's raffle guard sits in save() ahead of any request, and neither
// deleteOutcome nor retire lets go of `editing` before its request — only the success callback does, so a 409 (a Fire
// landed after the form opened) leaves the module and the DOM agreeing that the form is still open.
test("client.js: a ticked Firebot raffle off giveaway is refused before any request; delete and retire keep the form until the request succeeds", async () => {
  const f = mk();
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  const editor = js.slice(js.indexOf("// ===== Outcome editor (Pool page)"), js.indexOf("// ===== end Outcome editor"));
  const save = editor.slice(editor.indexOf("function save("), editor.indexOf("// --- tooltips"));
  expect(save).toContain('toast("Firebot raffles only make sense for giveaways.")');
  expect(save).toContain('form.querySelector("[name=raffle]").focus()');
  expect(save.indexOf("Firebot raffles only make sense")).toBeLessThan(save.indexOf('api("POST", "/api/outcomes"'));
  expect(save.indexOf("Firebot raffles only make sense")).toBeLessThan(save.indexOf('api("PUT", outcomePath(id)'));
  const del = editor.slice(editor.indexOf("function deleteOutcome("), editor.indexOf("function readForm("));
  expect(del).toContain("mutate(");
  expect(del.indexOf("editing = null")).toBeGreaterThan(del.indexOf("mutate("));
  const retire = editor.slice(editor.lastIndexOf('case "retire":', editor.indexOf("function deleteOutcome(")), editor.indexOf("function deleteOutcome("));
  expect(retire).toContain("mutate(");
  expect(retire.indexOf("editing = null")).toBeGreaterThan(retire.indexOf("mutate("));
});

// Restock +1 lives in client.js (its own route), not in the /pool HTML, so the Used / Left rule is checked on the script
// text. The word "charges" may survive only as the restock API body key.
test("Restock +1 (client.js) posts one go and speaks Used / Left — never charges in prose; only the API body key keeps the word", async () => {
  const f = mk();
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  expect(js).toContain('"/restock", { charges: 1 }');
  expect(js).toContain('" left"');
  expect(js.replace(/\bcharges:/g, "")).not.toMatch(/charges/i);
});

// ---------------------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------------------

test("Config: the Draw lists section shows both lists in textareas, one item per line, under their display names — and only to the streamer", async () => {
  const f = mk({ config: (c) => (c.lists.chatRules = ["THIRD-PERSON MODE", "A <B>RULE</B> & MORE"]) }); // caps: the load path upper-cases, <b> included
  const r = await page(f, "streamer", "/config");
  expect(r.status).toBe(200);
  expect(r.text).toContain("<h2>Draw lists</h2>");
  expect(r.text).toContain('<form id="lists-form"');
  const genres = f.config.get().lists.genreRoulette;
  expect(r.text).toContain(`<span>Genre roulette</span><textarea name="genreRoulette" class="lines" spellcheck="false">${genres.join("\n")}</textarea>`);
  expect(r.text).toContain('<span>Chat rules</span><textarea name="chatRules" class="lines" spellcheck="false">THIRD-PERSON MODE\nA &lt;B&gt;RULE&lt;/B&gt; &amp; MORE</textarea>');
  expect(r.text).toContain("One per line");
  expect(r.text).toContain("whatever case you type"); // caps are automatic on save (R: items are stored in CAPS), on both surfaces
  expect(r.text).toMatch(/textarea\.lines\{[^}]*text-transform:uppercase/);
  expect(r.text).toContain('id="lists-status"');
  // the keys and labels client.js saves under come from the server (one source: pages.ts's LIST_NAMES), not from the script
  expect(r.text).toContain(`<form id="lists-form" autocomplete="off" data-lists="${escapeHtml(JSON.stringify({ genreRoulette: "Genre roulette", chatRules: "Chat rules" }))}">`);
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  expect(js).toContain("JSON.parse(listsForm.dataset.lists)");
  expect(js).toContain("Object.keys(LIST_NAMES).forEach(function (key) {");
  expect(js).toContain('LIST_NAMES[key] + ": kept "');
  expect(js).not.toContain('["genreRoulette", "chatRules"]');
  expect(js).not.toContain('"Chat rules" : "Genre roulette"');
  expect(js).not.toContain("elements.genreRoulette");
  expect(js).toContain("normaliseList"); // linesOf mirrors schema.ts's normaliseList and says so
  const mod = await page(f, "funnel", "/config", MOD);
  expect(mod.status).toBe(403);
  expect(mod.text).not.toContain("Draw lists");
});

test("Config: threshold quick-set buttons from suggestedCents, the quick fields, the JSON textarea, and the broadcaster link with its status", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/config");
  expect(r.status).toBe(200);
  for (const [cents, label] of [[5000, "$50"], [3500, "$35"], [2500, "$25"], [2000, "$20"], [1000, "$10"]] as const) {
    expect(r.text).toContain(`data-action="threshold" data-cents="${cents}">${label}<`);
  }
  expect(r.text).toContain('id="threshold-custom"');
  expect(r.text).toContain('name="side"');
  expect(r.text).toContain('name="brand"');
  expect(r.text).toContain('name="theme"');
  // the dance floor's share of the frame and the room's opacity: sliders (schema FLOOR_PERCENT_MIN/MAX, 0..100), the defaults rendered, each with its readout
  expect(r.text).toContain('<input name="overlay.floorPercent" type="range" min="15" max="60" step="1" value="33"');
  expect(r.text).toContain('<output data-for="overlay.floorPercent">33</output>');
  expect(r.text).toContain('<input name="overlay.floorOpacity" type="range" min="0" max="100" step="5" value="100"');
  expect(r.text).toContain('<output data-for="overlay.floorOpacity">100</output>');
  // Quality + WebGL beside Theme: auto and the five Levels; auto / off
  expect(r.text).toContain('<select name="overlay.quality">');
  for (const value of ["auto", "5", "4", "3", "2", "1"]) expect(r.text).toContain(`<option value="${value}"`);
  expect(r.text).toContain('<option value="auto" selected>Auto</option>');
  expect(r.text).toContain('<select name="overlay.webgl">');
  expect(r.text).toContain('<option value="auto" selected>Auto (on with a real GPU)</option><option value="off">Off</option>');
  const q3 = mk({ config: (c) => ((c.overlay.quality = 3), (c.overlay.webgl = "off")) });
  const t = (await page(q3, "streamer", "/config")).text;
  expect(t).toContain('<option value="3" selected>Level 3</option>');
  expect(t).toContain('<option value="off" selected>Off</option>');
  expect(t).not.toContain('<option value="auto" selected>');
  expect(r.text).toContain("club-deck");
  expect(r.text).toContain("duck-farm");
  expect(r.text).not.toContain('name="firebotEnabled"'); // moved to the Giveaways page
  expect(r.text).toContain('id="config-json"');
  expect(r.text).toContain("&quot;suggestedCents&quot;");
  expect(r.text).toContain('href="/auth/twitch/broadcaster"');
  expect(r.text).toContain("Link broadcaster account");
  expect(r.text).toContain("@dj"); // linked: channel.broadcasterId is non-empty
  // the overlay URL moved here from Live; OBS on the same computer is the default, so localhost alone
  expect(r.text).toContain("Overlay URL for OBS");
  expect(r.text).toContain('<a href="http://localhost:8702/overlay">http://localhost:8702/overlay</a>');
  expect(r.text).not.toContain("192.168.1.20:8702");
  expect(r.text).not.toContain("127.0.0.1:8702");

  const unlinked = mk({ config: (c) => (c.channel = { login: "", broadcasterId: "", displayName: "" }) });
  const u = await page(unlinked, "streamer", "/config");
  expect(u.text).toContain("Not linked");
});

test("Config: Detail sits with the quality controls, starts at 1080p, and explains the 4K trade in plain words", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain('<select name="overlay.renderScale">');
  expect(r.text).toContain('<option value="1x" selected>Standard, 1080p</option>');
  expect(r.text).toContain('<option value="2x">Sharpest, full 4K</option>');
  expect(r.text).toContain("3840 × 2160");

  const capped = mk({ config: (c) => (c.overlay.renderScale = "2x") });
  const c = await page(capped, "streamer", "/config");
  expect(c.text).toContain('<option value="2x" selected>Sharpest, full 4K</option>');
});

test("Config, Chatter Dancers: three sliders with their readouts in plain words, the bot list one login per line with the seed, streamer only", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain("<h2>Chatter Dancers</h2>");
  expect(r.text).toContain('<form id="chatters" autocomplete="off">');
  // the four lines, verbatim; the number is an <output> the slider drives
  expect(r.text).toContain('How long someone stays on the floor after their last message · <output data-for="chatters.windowMinutes">15</output> min');
  expect(r.text).toContain('<input name="chatters.windowMinutes" type="range" min="5" max="240" step="1" value="15"');
  expect(r.text).toContain('How much of a name fits before it is cut short · <output data-for="chatters.nameLength">12</output> letters');
  expect(r.text).toContain('<input name="chatters.nameLength" type="range" min="4" max="25" step="1" value="12"');
  expect(r.text).toContain('When the floor is full, how long each person gets before the next one walks on · <output data-for="chatters.dwellSeconds">90</output> s');
  expect(r.text).toContain('<input name="chatters.dwellSeconds" type="range" min="30" max="300" step="5" value="90"');
  expect(r.text).toContain("Chat bots (one name per line). Anything on this list never gets a dancer.");
  expect(r.text).toContain('<textarea name="chatters.bots" class="lines" spellcheck="false">streamdjbot\nsery_bot\nstreamelements\nraidpal\nnightbot\nstreamlabs\nmoobot\nfossabot\nwizebot\nsoundalerts\nbotrix</textarea>');
  expect(r.text).toContain(">Save Chatter Dancers</button>");
  expect(r.text).toContain("stands on the dance floor"); // the plain sentence that says what a Chatter Dancer is

  // saved values render, and a bot name is escaped like every user string
  const set = mk({ config: (c) => ((c.chatters.windowMinutes = 30), (c.chatters.nameLength = 8), (c.chatters.dwellSeconds = 120), (c.chatters.bots = ["mybot", "<b>"])) });
  const t = (await page(set, "streamer", "/config")).text;
  expect(t).toContain('<output data-for="chatters.windowMinutes">30</output>');
  expect(t).toContain('name="chatters.windowMinutes" type="range" min="5" max="240" step="1" value="30"');
  expect(t).toContain('<output data-for="chatters.nameLength">8</output>');
  expect(t).toContain('<output data-for="chatters.dwellSeconds">120</output>');
  expect(t).toContain('spellcheck="false">mybot\n&lt;b&gt;</textarea>');

  // a mod never sees it
  const mod = await page(f, "funnel", "/config", MOD);
  expect(mod.status).toBe(403);
  expect(mod.text).not.toContain("Chatter Dancers");
});

test("Config, Chatter Dancers: client.js sets the form from the server config, saves sliders on change and the bot list one login per line; a PUT round trip renders the saved values normalised", async () => {
  const f = mk();
  const js = (await page(f, "streamer", "/dashboard/client.js")).text;
  expect(js).toContain('document.getElementById("chatters")');
  expect(js).toContain('chattersForm.elements["chatters.windowMinutes"].value = String(chattersCurrent.chatters.windowMinutes)');
  expect(js).toContain('chattersForm.elements["chatters.bots"].value = chattersCurrent.chatters.bots.join("\\n")');
  expect(js).toContain('slider.addEventListener("change", function () { chattersForm.requestSubmit(); })');
  expect(js).toContain('cfg.chatters.windowMinutes = Number(chattersForm.elements["chatters.windowMinutes"].value)');
  expect(js).toContain('cfg.chatters.nameLength = Number(chattersForm.elements["chatters.nameLength"].value)');
  expect(js).toContain('cfg.chatters.dwellSeconds = Number(chattersForm.elements["chatters.dwellSeconds"].value)');
  expect(js).toContain('cfg.chatters.bots = chattersForm.elements["chatters.bots"].value.split("\\n")');
  expect(js).toContain('return api("PUT", "/api/config", cfg);');

  // what the form does, done by hand: the whole config back with the section's values changed; the server normalises the bots
  const cfg = (await (await call(f, "streamer", "GET", "/api/config")).json()) as { config: Config };
  cfg.config.chatters.windowMinutes = 30;
  cfg.config.chatters.bots = ["  StreamDjBot ", "", "nightbot", "NIGHTBOT"];
  const put = await call(f, "streamer", "PUT", "/api/config", { body: cfg.config });
  expect(put.status).toBe(200);
  const t = (await page(f, "streamer", "/config")).text;
  expect(t).toContain('<output data-for="chatters.windowMinutes">30</output> min');
  expect(t).toContain('spellcheck="false">streamdjbot\nnightbot</textarea>');
});

test("Config, overlay URL: localhost first with a Copy button, a 1920 × 1080 browser source recommended, the LAN box off and no network address shown", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain('<a href="http://localhost:8702/overlay">http://localhost:8702/overlay</a>');
  expect(r.text).toContain('data-action="copy" data-text="http://localhost:8702/overlay"');
  expect(r.text).toContain("1920 wide and 1080 high");
  expect(r.text).toContain('<form id="overlay-lan"');
  expect(r.text).toContain('<input type="checkbox" name="listeners.overlayOnLan">OBS runs on another computer (show this computer\'s network address and allow it to connect)');
  expect(r.text).toContain("firewall");
  expect(r.text).toContain("anyone on your network");
  expect(r.text).toContain("after a restart");
  expect(r.text).not.toContain("192.168.1.20"); // the LAN address is not shown until the box is ticked
  expect(r.text).not.toContain("No network address found");
  expect(r.text).not.toContain("try them in order");
});

test("Config, overlay URL with the LAN box ticked: localhost still first, then the network address, the box rendered checked", async () => {
  const f = mk({ config: (c) => (c.listeners.overlayOnLan = true), networkInterfaces: () => ({ en0: [ipv4("192.168.1.20", false)] }) });
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain('<input type="checkbox" name="listeners.overlayOnLan" checked>');
  const local = r.text.indexOf("http://localhost:8702/overlay");
  const lan = r.text.indexOf('<a href="http://192.168.1.20:8702/overlay">http://192.168.1.20:8702/overlay</a>');
  expect(local).toBeGreaterThan(-1);
  expect(lan).toBeGreaterThan(local);
  expect(r.text).toContain("On the other computer");
  expect(r.text).not.toContain("try them in order"); // one answer needs no disambiguation
});

test("Config, overlay URL on the LAN in Docker: the host's address is the only LAN link, and the page no longer tells you to go find it yourself", async () => {
  const f = mk({ config: (c) => (c.listeners.overlayOnLan = true), hostLanIp: "192.168.1.20", networkInterfaces: () => ({ eth0: [ipv4("192.168.97.2", false)] }) });
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain('<a href="http://192.168.1.20:8702/overlay">http://192.168.1.20:8702/overlay</a>');
  expect(r.text).not.toContain("192.168.97.2"); // the container's own address reaches nobody
  expect(r.text).not.toContain("Use the laptop&#39;s LAN IP instead");
  expect(r.text).not.toContain("more than one address");
});

test("Config, overlay URL on the LAN with several addresses and none handed in: all of them, and a line saying to try them in order", async () => {
  const f = mk({ config: (c) => (c.listeners.overlayOnLan = true), networkInterfaces: () => ({ en0: [ipv4("192.168.1.20", false)], utun3: [ipv4("100.64.0.9", false)] }) });
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain("http://192.168.1.20:8702/overlay");
  expect(r.text).toContain("http://100.64.0.9:8702/overlay");
  expect(r.text).toContain("try them in order");
});

test("Config, overlay URL on the LAN with no network address at all: says so plainly instead of printing a broken link, localhost still offered", async () => {
  const f = mk({ config: (c) => (c.listeners.overlayOnLan = true), networkInterfaces: () => ({ lo0: [ipv4("127.0.0.1", true)] }) });
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain("No network address found");
  expect(r.text).toContain("http://localhost:8702/overlay");
  expect(r.text.split(":8702/overlay").length - 1).toBe(3); // the localhost link's href, its text and its Copy button, nothing else
});


test("Config: a Shut down section at the bottom — one danger button, an inline confirm (never window.confirm) with the READY warning only while Unlocks are banked; nothing of it for a mod", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/config");
  expect(r.status).toBe(200);
  expect(r.text).toContain("<h2>Shut down</h2>");
  expect(r.text.lastIndexOf("<h2>Shut down</h2>")).toBeGreaterThan(r.text.lastIndexOf("<h2>Full config (config.json)</h2>")); // the last section
  expect(r.text).toContain('<button type="button" class="danger" data-action="shutdown">Shut down the service…</button>');
  expect(r.text).toContain('<div id="shutdown-confirm" class="addbox" hidden>');
  expect(r.text).toContain("This stops the overlay server: OBS loses the overlay and this Dashboard goes offline. Start it again with <code>just show</code>.");
  expect(r.text).toContain('<button type="button" data-action="shutdown-cancel">Cancel</button>');
  expect(r.text).toContain('<button type="button" class="danger" data-action="shutdown-confirm">Yes, shut down</button>');
  expect(r.text).not.toContain("still READY");

  await credit(f, 5000); // READY 1
  const one = await page(f, "streamer", "/config");
  expect(one.text).toContain("<strong>1 Unlock is still READY.</strong> Fire it first?");
  await credit(f, 10000); // READY 3
  const three = await page(f, "streamer", "/config");
  expect(three.text).toContain("<strong>3 Unlocks are still READY.</strong> Fire them first?");

  const mod = await page(f, "funnel", "/config", MOD);
  expect(mod.status).toBe(403);
  expect(mod.text).not.toContain("Shut down");
  for (const p of ["/", "/ledger", "/pool", "/help"]) expect((await page(f, "funnel", p, MOD)).text).not.toContain("data-action=\"shutdown");
  // the broadcaster over the Funnel (phone) sees Config, but no button — streamer listener only
  const phone = await page(f, "funnel", "/config", { cookie: cookie("streamer") });
  expect(phone.status).toBe(200);
  expect(phone.text).not.toContain('data-action="shutdown"');
  expect(phone.text).toContain("Shut down from the computer running the overlay");

  // client.js: the confirm posts the literal word, then replaces the page and stops every later fetch and toast (no error storm once the process is gone)
  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  expect(js).toContain('api("POST", "/api/shutdown", { confirm: "SHUTDOWN" })');
  expect(js).toContain("Shutting down… start it again on the computer running the overlay.");
  expect(js).toContain("stopping = true;");
  expect(js).toContain("if (stopping) return");
  expect(js).not.toContain("window.confirm(");
});

// client.js has no DOM harness (it is served as text and runs only in the browser), so the sync it does on load is
// covered at the seams: the markup it reads from, and the script text that reads it.
test("Config: the quick-settings form never keeps browser-restored values — autocomplete off, and client.js sets every control from the embedded server config", async () => {
  const f = mk({ config: (c) => (c.overlay.side = "right") });
  const r = await page(f, "streamer", "/config");
  expect(r.text).toContain('<form id="quick" autocomplete="off">');
  expect(r.text).toContain('<form id="config-form" autocomplete="off">');
  expect(r.text).toContain('<option value="right" selected>right</option>');
  // The server's config is embedded as JSON for client.js to sync the controls from on load; `<` is escaped so a
  // config string can never close the script element.
  const m = /<script id="config-data" type="application\/json">([^]*?)<\/script>/.exec(r.text);
  expect(m).not.toBeNull();
  expect(m![1]).not.toContain("<");
  const embedded = JSON.parse(m![1]!);
  expect(embedded.overlay.side).toBe("right");
  expect(embedded.overlay.theme).toBe(f.config.get().overlay.theme);
  expect(embedded.firebot.enabled).toBe(f.config.get().firebot.enabled);

  const js = await (await call(f, "streamer", "GET", "/dashboard/client.js")).text();
  expect(js).toContain('getElementById("config-data")');
  for (const line of [
    "quick.elements.side.value = current.overlay.side;",
    "quick.elements.brand.value = current.overlay.brand;",
    "quick.elements.theme.value = current.overlay.theme;",
    'quick.elements["overlay.quality"].value = String(current.overlay.quality);',
    'quick.elements["overlay.webgl"].value = current.overlay.webgl;',
    // the save sends the numeric Level as a number and "auto" as the word, through PUT /api/config like the rest
    'cfg.overlay.quality = quality === "auto" ? "auto" : Number(quality);',
    'cfg.overlay.webgl = quick.elements["overlay.webgl"].value;',
    'quick.elements["overlay.floorPercent"].value = String(current.overlay.floorPercent);',
    'cfg.overlay.floorPercent = Number(quick.elements["overlay.floorPercent"].value);',
    'quick.elements["overlay.floorOpacity"].value = String(current.overlay.floorOpacity);',
    'cfg.overlay.floorOpacity = Number(quick.elements["overlay.floorOpacity"].value);',
    // a slider saves as it is let go (change), and its readout follows the thumb (input)
    'quick.requestSubmit()',
  ]) {
    expect(js).toContain(line);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------------------------------

test("/help renders the Help copy for both roles: the sections, the !unlocks text, and the current Firebot flow", async () => {
  const f = mk();
  const r = await page(f, "funnel", "/help", MOD);
  expect(r.status).toBe(200);
  for (const h3 of ["How this works", "Firing", "Threshold", "Restock", "Editing the pool", "Giveaways", "Chatter Dancers", "Chat picks what comes next", "Before signing off", "If something breaks", "Before the show"]) {
    expect(r.text).toContain(`<h3>${h3}</h3>`);
  }
  expect(r.text).toContain("Fire anything still banked");
  expect(r.text).toContain("Config → Shut down"); // the Dashboard's button, or `just down`; the Ledger replays on the next start
  expect(r.text).toContain("<code>just down</code>");
  expect(r.text).toContain("The Ledger replays on the next start");
  expect(r.text).toContain("restockable Outcomes");
  expect(r.text).toContain("adds one more go to its Left");
  expect(r.text).toContain("Delete only while Used is 0");
  expect(r.text).toContain("What it is line"); // every Outcome's line, the ⓘ on the Pool page
  expect(r.text).toContain("Restock +1");
  expect(r.text).toMatch(/\bcome up\b/);
  expect(r.text).not.toContain("charges");
  expect(r.text).toContain("<strong>Custom Power-Ups</strong>");
  expect(r.text).toContain("<strong>Run the overlay in OBS once</strong> with Quality on Auto"); // and note where it settles
  expect(r.text).toContain("Overlay · Level N");
  expect(r.text).toContain("Nothing for the mods to do"); // Chatter Dancers: a mod's view
  expect(r.text).toContain("walks off once the Chat Window has passed since their last one (15 minutes unless the streamer changes it on the Config page)"); // the window is a slider: the Help page never states it as a fact
  expect(r.text).not.toContain("walks off 15 minutes after");
  expect(r.text).toContain("Connect the broadcaster account again to hear chat"); // the Health line, so a mod knows whose click fixes it
  expect(r.text).toContain("<code>!raffle 1 120</code>");
  expect(r.text).toContain("Suggested landing spots: $50 → $35 → $25 → $20 → $10");
  expect(r.text).toContain("re-bank the Unlock");
  expect(r.text).toContain("Each unlock drops a parachute onto the board. Tips, bits and subs push the fader up.");
  expect(r.text).toContain("<code>giveaway.firebotsetup</code>");
  expect(r.text).toContain("Settings → Setups → Import");
  expect(r.text).toContain("Giveaways page");
  expect(r.text).toContain("<code>!giveaway start</code>");
  expect(r.text).toContain("<code>!giveaway enter</code>");
  expect(r.text).toContain("Close &amp; draw");
  expect(r.text).not.toContain("within the next 2 min"); // the old fixed window is gone; a countdown only runs when auto-close is set
  expect(r.text).not.toContain("<code>!enter</code>");
  expect(r.text).not.toContain("presetId");
  expect(r.text).not.toContain("curl");
  expect((await page(f, "streamer", "/help")).status).toBe(200);
});

test("renderMarkdown: headings, paragraphs, lists (checkbox lines as plain items), bold, code, and escaping", () => {
  const html = renderMarkdown(["## Top", "", "### How it works", "Line one", "continues **bold** and `code` here.", "", "- first", "- [ ] second <b>", "", "1 < 2 & 3 > 2"].join("\n"));
  expect(html).toBe(
    "<h2>Top</h2>\n<h3>How it works</h3>\n<p>Line one continues <strong>bold</strong> and <code>code</code> here.</p>\n<ul><li>first</li><li>second &lt;b&gt;</li></ul>\n<p>1 &lt; 2 &amp; 3 &gt; 2</p>",
  );
});

test("the Pool list editor's + / − styling targets the attribute the buttons actually carry (data-list-act), not the Outcome editor's data-act", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/pool");
  expect(r.text).toContain('data-list-act="add"');
  expect(r.text).toContain(".list-editor .actions button[data-list-act]"); // the page carries its CSS inline
  expect(r.text).not.toContain(".list-editor .actions button[data-act]");
});


// ---------------------------------------------------------------------------------------------------------------------
// Debug panel (streamer only): buttons that drive the same routes Twitch / Ko-fi / mods would, without any of them
// ---------------------------------------------------------------------------------------------------------------------

test("/debug is Streamer only: the tab is hidden from mods and the route 403s; the streamer gets a button board over the real routes", async () => {
  const f = mk();
  const mod = await page(f, "funnel", "/debug", MOD);
  expect(mod.status).toBe(403);
  expect((await page(f, "funnel", "/", MOD)).text).not.toContain('href="/debug"');

  const r = await page(f, "streamer", "/debug");
  expect(r.status).toBe(200);
  expect(r.text).toContain('href="/debug"');
  // one button per thing the streamer wants to try — each carries what client.js posts
  expect(r.text).toContain('data-action="debug-drop"');
  expect(r.text).toContain('data-action="debug-credit"');
  expect(r.text).toContain('data-face="{&quot;kind&quot;:&quot;bits&quot;,&quot;bits&quot;:1000}"');
  expect(r.text).toContain('data-action="debug-cross"');
  expect(r.text).toContain('data-action="debug-queue" data-delta="1"');
  expect(r.text).toContain('data-action="debug-cue" data-name="energy" data-value="1"');
  expect(r.text).toContain('id="debug-cue"');
  // the tier gates from config, one button each past the current banked count (default gates 0 / 3 / 6, nothing banked)
  expect(r.text).toContain('data-action="debug-tier" data-gate="3"');
  expect(r.text).toContain('data-action="debug-tier" data-gate="6"');
  // says plainly that these are real Ledger entries (voidable / re-bankable like any other)
  expect(r.text).toContain("real Ledger entries");
  // and that nothing here reaches Twitch chat: the drop posts raffle:false so Firebot never announces a prize
  expect(r.text).toContain("never posts to Twitch chat");
});

test("/debug's tier buttons drop the tiers already open", async () => {
  const f = mk();
  for (let i = 0; i < 3; i++) await call(f, "streamer", "POST", "/api/queue/adjust", { body: { delta: 1, reason: "t" } });
  const r = await page(f, "streamer", "/debug");
  expect(r.text).not.toContain('data-gate="3"');
  expect(r.text).toContain('data-gate="6"');
});

test("/debug: the two Chatter Dancer buttons, a plain sentence that nothing reaches chat, and client.js posts then toasts without a reload; mods still 403", async () => {
  const f = mk();
  const r = await page(f, "streamer", "/debug");
  expect(r.text).toContain("<h2>Chatter Dancers</h2>");
  expect(r.text).toContain('<button type="button" data-action="debug-chatter">Fake a new chatter</button>');
  expect(r.text).toContain('<button type="button" data-action="debug-chat-hop">Fake a message from someone here</button>');
  expect(r.text).toContain("stock picture");
  expect(r.text).toContain("Nothing here reaches Twitch chat");
  expect((await page(f, "funnel", "/debug", MOD)).status).toBe(403);

  const js = (await page(f, "streamer", "/dashboard/client.js")).text;
  expect(js).toContain('case "debug-chatter":');
  expect(js).toContain('api("POST", "/api/chatters/fake")');
  expect(js).toContain('toast("Fake chatter added: " + data.chatter.name, true)');
  expect(js).toContain('case "debug-chat-hop":');
  expect(js).toContain('api("POST", "/api/chatters/hop")');
  expect(js).toContain('toast("Hopped " + data.chatter.name, true)');
});

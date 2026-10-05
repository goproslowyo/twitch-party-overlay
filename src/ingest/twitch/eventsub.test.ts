import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { Secrets } from "../../config/secrets.ts";
import { Helix } from "./helix.ts";
import { CHAT_RETRY_DELAYS_MS, CROSS_SESSION_DEDUPE_MS, EventSubClient, mockSubscriptionsUrl, type ChatSubscribeStatus, type EventSubClientOptions, type EventSubStatus } from "./eventsub.ts";
import { normalizeEventSub, type EventSubNotification } from "./normalize.ts";

// ---- fake EventSub server -------------------------------------------------------------------------------------------

interface Conn {
  id: number;
  path: string; // pathname + search the client connected with
  ws: ServerWebSocket<{ id: number; path: string }>;
  closed: boolean;
}

/** One fake `eventsub.wss.twitch.tv`: records every socket; the test drives what each socket is sent. */
function fakeEventSub() {
  const conns: Conn[] = [];
  let nextId = 1;
  const server = Bun.serve<{ id: number; path: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      if (srv.upgrade(req, { data: { id: nextId++, path: u.pathname + u.search } })) return undefined;
      return new Response("websocket only", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ id: ws.data.id, path: ws.data.path, ws, closed: false });
      },
      message() {},
      close(ws) {
        const c = conns.find((x) => x.id === ws.data.id);
        if (c) c.closed = true;
      },
    },
  });
  const send = (conn: Conn, msg: unknown) => conn.ws.send(JSON.stringify(msg));
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    conns,
    send,
    welcome: (conn: Conn, sessionId: string, keepaliveTimeoutSeconds = 10) =>
      send(conn, {
        metadata: { message_id: `welcome-${conn.id}`, message_type: "session_welcome", message_timestamp: stamp() },
        payload: { session: { id: sessionId, status: "connected", connected_at: stamp(), keepalive_timeout_seconds: keepaliveTimeoutSeconds, reconnect_url: null } },
      }),
    keepalive: (conn: Conn) => send(conn, { metadata: { message_id: `ka-${Math.random()}`, message_type: "session_keepalive", message_timestamp: stamp() }, payload: {} }),
    reconnect: (conn: Conn, sessionId: string, reconnectUrl: string) =>
      send(conn, {
        metadata: { message_id: `reconnect-${conn.id}`, message_type: "session_reconnect", message_timestamp: stamp() },
        payload: { session: { id: sessionId, status: "reconnecting", connected_at: stamp(), keepalive_timeout_seconds: null, reconnect_url: reconnectUrl } },
      }),
    revocation: (conn: Conn, type: string) =>
      send(conn, {
        metadata: { message_id: `revoke-${conn.id}`, message_type: "revocation", message_timestamp: stamp(), subscription_type: type, subscription_version: "1" },
        payload: { subscription: { id: "sub-x", status: "authorization_revoked", type, version: "1", cost: 0, condition: { broadcaster_user_id: "1337" }, transport: { method: "websocket" }, created_at: stamp() } },
      }),
    close: (conn: Conn) => conn.ws.close(1006, "gone"),
    stop: () => server.stop(true),
  };
}

const stamp = () => new Date().toISOString();

function notification(type: string, event: Record<string, unknown>, messageId: string) {
  return {
    metadata: { message_id: messageId, message_type: "notification", message_timestamp: stamp(), subscription_type: type, subscription_version: "1" },
    payload: {
      subscription: { id: "sub-1", status: "enabled", type, version: "1", cost: 0, condition: { broadcaster_user_id: "1337" }, transport: { method: "websocket", session_id: "s" }, created_at: stamp() },
      event: { broadcaster_user_id: "1337", broadcaster_user_login: "examplestreamer", broadcaster_user_name: "ExampleStreamer", ...event },
    },
  };
}

const cheer = (bits: number, messageId: string) =>
  notification("channel.cheer", { user_id: "1234", user_login: "cool_user", user_name: "Cool_User", is_anonymous: false, message: `cheer${bits}`, bits }, messageId);

const COOL = { chatter_user_id: "1234", chatter_user_login: "cool_user", chatter_user_name: "Cool_User" };
/** A `channel.chat.message` frame: the identity fields the roster reads, the rest as Twitch sends it (the text never leaves the adapter). */
const chatMessage = (messageId: string, chatter = COOL, text = "hello") =>
  notification("channel.chat.message", { ...chatter, message_id: `u-${messageId}`, message_type: "text", message: { text, fragments: [{ type: "text", text, cheermote: null, emote: null, mention: null }] }, badges: [], color: "#FF0000", source_broadcaster_user_id: null, source_broadcaster_user_login: null, source_broadcaster_user_name: null, source_badges: null, source_message_id: null, is_source_only: null }, messageId);

// ---- fake Helix (subscription POST recorder) ------------------------------------------------------------------------

interface SubscriptionPost {
  url: string;
  body: { type: string; version: string; condition: Record<string, string>; transport: { method: string; session_id: string } };
  headers: Record<string, string>;
}

const HELIX_SUBSCRIPTIONS = "http://helix.test/helix/eventsub/subscriptions";
const MOCK_SUBSCRIPTIONS = "http://mock.test:8098/eventsub/subscriptions";

/** Decides a subscription POST's fate: a Response, an Error (thrown, like a network failure), or undefined → 202. */
type SubscribeHook = (post: SubscriptionPost, index: number) => Response | Error | undefined;

function fakeHelix(subscribe: SubscribeHook = () => undefined) {
  const subs: SubscriptionPost[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if ((String(input) === HELIX_SUBSCRIPTIONS || String(input) === MOCK_SUBSCRIPTIONS) && init?.method === "POST") {
      const post: SubscriptionPost = { url: String(input), body: JSON.parse(init.body as string), headers: Object.fromEntries(new Headers(init.headers).entries()) };
      subs.push(post);
      const fate = subscribe(post, subs.length - 1);
      if (fate instanceof Error) throw fate;
      // the retry tests reuse one fixed Response across several POSTs (`failTypeOf`/`refuseFirst` close over it); a
      // Response body can only be read once, so hand back a clone each time rather than the shared instance.
      return fate?.clone() ?? Response.json({ data: [{ id: `sub-${subs.length}`, status: "enabled" }], total: subs.length, total_cost: 0, max_total_cost: 10 }, { status: 202 });
    }
    return new Response(`unexpected ${init?.method ?? "GET"} ${String(input)}`, { status: 500 });
  };
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tpo-eventsub-")), "secrets.env");
  const secrets = new Secrets(p);
  secrets.set("TWITCH_BROADCASTER_ACCESS_TOKEN", "tok");
  secrets.set("TWITCH_BROADCASTER_REFRESH_TOKEN", "ref");
  secrets.set("TWITCH_BROADCASTER_EXPIRES_AT", new Date(Date.now() + 3_600_000).toISOString());
  const helix = new Helix({ clientId: "cid", clientSecret: "sec", secrets, fetchImpl, helixUrl: "http://helix.test/helix", idUrl: "http://id.test/oauth2" });
  return { helix, subs };
}

// ---- harness ---------------------------------------------------------------------------------------------------------

/** Consumer-side hooks run after the recorders; what they throw reaches the client (that is the point). */
interface Hooks {
  subscribe?: SubscribeHook;
  afterStatus?: (s: EventSubStatus) => void;
  afterNotification?: (m: EventSubNotification) => void;
}

function harness(url: string, overrides: Partial<EventSubClientOptions> = {}, hooks: Hooks = {}) {
  const fake = fakeHelix(hooks.subscribe);
  const notifications: EventSubNotification[] = [];
  const statuses: EventSubStatus[] = [];
  let now = new Date("2026-09-12T20:00:00.000Z");
  const client = new EventSubClient({
    url,
    sessions: 2,
    keepaliveSeconds: 10,
    helix: fake.helix,
    broadcasterId: "1337",
    onNotification: (m) => {
      notifications.push(m);
      hooks.afterNotification?.(m);
    },
    onStatus: (s) => {
      statuses.push(s);
      hooks.afterStatus?.(s);
    },
    now: () => now,
    log: () => {},
    ...overrides,
  });
  return {
    client,
    subs: fake.subs,
    notifications,
    statuses,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const EXPECTED_TYPES = ["channel.bits.use@1", "channel.chat.message@1", "channel.cheer@1", "channel.subscribe@1", "channel.subscription.gift@1", "channel.subscription.message@1"];

// ---- tests -----------------------------------------------------------------------------------------------------------

test("(a) each session connects with the keepalive query and, on its welcome, POSTs the 6 subscriptions (5 money + chat) with its own session_id", async () => {
  const server = fakeEventSub();
  const h = harness(server.url);
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    expect(server.conns.map((c) => c.path)).toEqual(["/ws?keepalive_timeout_seconds=10", "/ws?keepalive_timeout_seconds=10"]);
    await Bun.sleep(50);
    expect(h.subs).toHaveLength(0); // nothing before the welcome (no session id yet)

    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "12 subscription POSTs");

    for (const id of ["sess-A", "sess-B"]) {
      const mine = h.subs.filter((s) => s.body.transport.session_id === id);
      expect(mine.map((s) => `${s.body.type}@${s.body.version}`).sort()).toEqual(EXPECTED_TYPES);
    }
    for (const s of h.subs) {
      expect(s.url).toBe(HELIX_SUBSCRIPTIONS); // the real path: Helix, whatever scheme the socket url has
      expect(s.body.condition).toEqual(s.body.type === "channel.chat.message" ? { broadcaster_user_id: "1337", user_id: "1337" } : { broadcaster_user_id: "1337" });
      expect(s.body.transport.method).toBe("websocket");
      expect(s.headers.authorization).toBe("Bearer tok");
      expect(s.headers["client-id"]).toBe("cid");
    }
    await until(() => h.statuses.length === 2, "both connected statuses");
    expect(h.statuses.map((s) => ({ ...s, session: s.session })).sort((x, y) => x.session - y.session)).toEqual([
      { session: 1, connected: true },
      { session: 2, connected: true },
    ]);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("(b) a notification reaches onNotification as the parsed message", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    const msg = cheer(500, "m1");
    server.send(server.conns[0]!, msg);
    await until(() => h.notifications.length === 1, "notification");
    expect(h.notifications[0]).toEqual(msg);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test(
  "(c) keepalive watchdog: a keepalive resets it; silence for keepalive_timeout_seconds + 5 s → close, reconnect with backoff, re-subscribe",
  async () => {
    const server = fakeEventSub();
    const h = harness(server.url, { sessions: 1 });
    try {
      h.client.start();
      await until(() => server.conns.length === 1, "socket");
      const first = server.conns[0]!;
      server.welcome(first, "sess-A", 1); // the welcome's keepalive_timeout_seconds (1 s) wins over the config's 10 s
      const welcomedAt = Date.now();
      await until(() => h.subs.length === 6, "subscribed");

      await Bun.sleep(3000);
      server.keepalive(first); // resets the watchdog at ~3 s
      await Bun.sleep(3500); // ~6.5 s after the welcome: without the reset the socket would be gone by now
      expect(first.closed).toBe(false);

      await until(() => first.closed, "watchdog close", 6000);
      const closedAt = Date.now();
      expect(closedAt - welcomedAt).toBeGreaterThanOrEqual(3000 + 6000 - 100); // keepalive at 3 s, then 1 s + 5 s grace
      expect(h.statuses.at(-1)).toMatchObject({ session: 1, connected: false });
      expect(h.statuses.at(-1)!.reason).toMatch(/keepalive/);

      await until(() => server.conns.length === 2, "reconnect after the 1 s backoff", 3000);
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
      const second = server.conns[1]!;
      server.welcome(second, "sess-B");
      await until(() => h.subs.length === 12, "re-subscribed on the new session");
      expect(h.subs.slice(6).map((s) => s.body.transport.session_id)).toEqual(Array(6).fill("sess-B"));
      expect(h.statuses.at(-1)).toEqual({ session: 1, connected: true });
    } finally {
      h.client.stop();
      server.stop();
    }
  },
  { timeout: 30_000 },
);

test("(d) session_reconnect: opens reconnect_url as-is, closes the old socket only after the new welcome, never re-subscribes", async () => {
  const a = fakeEventSub();
  const b = fakeEventSub();
  const h = harness(a.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => a.conns.length === 1, "socket on a");
    const old = a.conns[0]!;
    a.welcome(old, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    a.reconnect(old, "sess-A", `${b.url}?id=migrated`);
    await until(() => b.conns.length === 1, "socket on the reconnect url");
    expect(b.conns[0]!.path).toBe("/ws?id=migrated"); // used verbatim — no keepalive query appended
    await Bun.sleep(100);
    expect(old.closed).toBe(false); // the old socket stays open until the new welcome

    b.welcome(b.conns[0]!, "sess-A");
    await until(() => old.closed, "old socket closed after the new welcome");
    await Bun.sleep(100);
    expect(h.subs).toHaveLength(6); // subscriptions migrate; nothing re-POSTed
    expect(a.conns).toHaveLength(1); // closing the old socket did not trigger a reconnect
    expect(h.statuses.filter((s) => !s.connected)).toEqual([]);
    expect(h.statuses.at(-1)).toEqual({ session: 1, connected: true, reason: "migrated" });

    const msg = cheer(100, "after-migration");
    b.send(b.conns[0]!, msg);
    await until(() => h.notifications.length === 1, "notification on the new socket");
    expect(h.notifications[0]).toEqual(msg);
  } finally {
    h.client.stop();
    a.stop();
    b.stop();
  }
});

test("session_reconnect with a reconnect_url the WebSocket constructor rejects never throws out of the message handler: the socket is dropped and a fresh connect re-subscribes", async () => {
  const a = fakeEventSub();
  const h = harness(a.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => a.conns.length === 1, "socket on a");
    const old = a.conns[0]!;
    a.welcome(old, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    a.reconnect(old, "sess-A", "not a url");
    await until(() => old.closed, "the old socket dropped");
    expect(h.statuses.at(-1)).toMatchObject({ session: 1, connected: false, reason: expect.stringContaining("reconnect url rejected") });

    await until(() => a.conns.length === 2, "fresh connect after the backoff", 5000);
    a.welcome(a.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "re-subscribed on the fresh socket");
    expect(h.statuses.at(-1)).toEqual({ session: 1, connected: true });
    const msg = cheer(100, "after-bad-reconnect");
    a.send(a.conns[1]!, msg);
    await until(() => h.notifications.length === 1, "notification on the fresh socket");
  } finally {
    h.client.stop();
    a.stop();
  }
});

test("(e) stop() closes every socket, reports each session disconnected, and never reconnects", async () => {
  const server = fakeEventSub();
  const h = harness(server.url);
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "subscribed");

    h.client.stop();
    await until(() => server.conns.every((c) => c.closed), "both sockets closed");
    expect(h.statuses.filter((s) => !s.connected).sort((x, y) => x.session - y.session)).toEqual([
      { session: 1, connected: false, reason: "stopped" },
      { session: 2, connected: false, reason: "stopped" },
    ]);
    await Bun.sleep(1500); // longer than the first backoff step
    expect(server.conns).toHaveLength(2);
  } finally {
    server.stop();
  }
});

test("cross-session dedupe: the same event on both sessions (different message ids) reaches onNotification once", async () => {
  const server = fakeEventSub();
  const h = harness(server.url);
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "subscribed");

    server.send(server.conns[0]!, cheer(500, "a-1"));
    server.send(server.conns[1]!, cheer(500, "b-1"));
    server.send(server.conns[0]!, cheer(1000, "a-2")); // a different event is not a repeat
    server.send(server.conns[1]!, cheer(1000, "b-2"));
    await until(() => h.notifications.length === 2, "two distinct notifications");
    await Bun.sleep(50);
    expect(h.notifications.map((n) => n.payload.event.bits)).toEqual([500, 1000]);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("cross-session dedupe: a content-identical repeat within 5 s is dropped; after 5 s it is a new event (a repeat cheer is real money)", async () => {
  expect(CROSS_SESSION_DEDUPE_MS).toBe(5000); // the cross-session dedupe window
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    const conn = server.conns[0]!;
    server.welcome(conn, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    server.send(conn, cheer(500, "t0"));
    await until(() => h.notifications.length === 1, "first delivery");

    h.advance(4_000);
    server.send(conn, cheer(500, "t4"));
    server.send(conn, cheer(1, "marker-1")); // ordering marker: proves the repeat above was processed and dropped
    await until(() => h.notifications.length === 2, "marker after the dropped repeat");
    expect(h.notifications[1]!.metadata.message_id).toBe("marker-1");

    h.advance(2_000); // 6 s after the first sighting
    server.send(conn, cheer(500, "t6"));
    await until(() => h.notifications.length === 3, "delivered again after the window");
    expect(h.notifications[2]!.metadata.message_id).toBe("t6");
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("revocation → status stays connected with reason revoked:<type>; the socket stays open", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    server.revocation(server.conns[0]!, "channel.cheer");
    await until(() => h.statuses.length === 2, "revocation status");
    expect(h.statuses[1]).toEqual({ session: 1, connected: true, reason: "revoked:channel.cheer" });
    await Bun.sleep(50);
    expect(server.conns[0]!.closed).toBe(false);
  } finally {
    h.client.stop();
    server.stop();
  }
});

// ---- subscribe failures ----------------------------------------------------------------------------------------------

/** Fails exactly one type of session `sessionId`'s POSTs with `fate`. */
const failTypeOf =
  (sessionId: string, type: string, fate: Response | Error): SubscribeHook =>
  (post) =>
    post.body.transport.session_id === sessionId && post.body.type === type ? fate : undefined;
const failCheerOf = (sessionId: string, fate: Response | Error): SubscribeHook => failTypeOf(sessionId, "channel.cheer", fate);

test("subscribe failure: a 403 on one of the five money POSTs drops the socket (reason 'subscribe failed'), then a fresh connect re-subscribes", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 }, { subscribe: failCheerOf("sess-A", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    const first = server.conns[0]!;
    server.welcome(first, "sess-A");

    await until(() => h.statuses.length === 1, "disconnected status");
    const droppedAt = Date.now();
    expect(h.statuses[0]).toMatchObject({ session: 1, connected: false });
    expect(h.statuses[0]!.reason).toMatch(/^subscribe failed: .*403/);
    await until(() => first.closed, "socket closed");

    await until(() => server.conns.length === 2, "fresh connect after the backoff");
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(900);
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.filter((s) => s.body.transport.session_id === "sess-B").length === 6, "6 new POSTs on the new session");
    await until(() => h.statuses.length === 2, "connected again");
    expect(h.statuses[1]).toEqual({ session: 1, connected: true });
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("subscribe failure: an error text longer than the 123-byte close-reason limit still closes the socket; the status carries the full text", async () => {
  const longError = `unable to connect: ${"x".repeat(300)}`;
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 }, { subscribe: failCheerOf("sess-A", new Error(longError)) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    const first = server.conns[0]!;
    server.welcome(first, "sess-A");

    await until(() => h.statuses.length === 1, "disconnected status");
    expect(h.statuses[0]).toEqual({ session: 1, connected: false, reason: `subscribe failed: ${longError}` });
    await until(() => first.closed, "socket closed");

    await until(() => server.conns.length === 2, "reconnect");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.filter((s) => s.body.transport.session_id === "sess-B").length === 6, "re-subscribed");
  } finally {
    h.client.stop();
    server.stop();
  }
});

// ---- consumer callbacks that throw ------------------------------------------------------------------------------------

test("a throwing onStatus on the disconnect does not cancel the reconnect", async () => {
  const server = fakeEventSub();
  let armed = true;
  const h = harness(server.url, { sessions: 1 }, {
    afterStatus: (s) => {
      if (!s.connected && armed) {
        armed = false;
        throw new Error("status handler blew up");
      }
    },
  });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "connected");

    server.conns[0]!.ws.close(1000, "bye"); // Twitch dropping the session
    await until(() => h.statuses.length === 2, "disconnected status");
    expect(h.statuses[1]).toMatchObject({ session: 1, connected: false });

    await until(() => server.conns.length === 2, "reconnect despite the throwing handler");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.filter((s) => s.body.transport.session_id === "sess-B").length === 6, "re-subscribed");
    await until(() => h.statuses.length === 3, "connected again");
    expect(h.statuses[2]).toEqual({ session: 1, connected: true });
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("stop(): a throwing onStatus still closes every session's socket", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, {}, {
    afterStatus: (s) => {
      if (s.reason === "stopped") throw new Error("stop handler blew up");
    },
  });
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "subscribed");

    expect(() => h.client.stop()).not.toThrow();
    await until(() => server.conns.every((c) => c.closed), "both sockets closed");
    expect(h.statuses.filter((s) => s.reason === "stopped").map((s) => s.session).sort()).toEqual([1, 2]);
  } finally {
    server.stop();
  }
});

test("a throwing onNotification is contained: the socket stays open and the next notification is delivered", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 }, {
    afterNotification: (m) => {
      if (m.metadata.message_id === "bad") throw new Error("consumer blew up");
    },
  });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    const conn = server.conns[0]!;
    server.welcome(conn, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    server.send(conn, cheer(500, "bad"));
    server.send(conn, cheer(1000, "good"));
    await until(() => h.notifications.length === 2, "both notifications");
    expect(h.notifications.map((n) => n.metadata.message_id)).toEqual(["bad", "good"]);
    await Bun.sleep(50);
    expect(conn.closed).toBe(false);
  } finally {
    h.client.stop();
    server.stop();
  }
});

// ---- late messages on a discarded link ---------------------------------------------------------------------------------

/** A WebSocket whose close() silently does nothing for URLs matching `stuck`: a close that did not take. */
function stickyCloseWebSocket(stuck: (url: string) => boolean): typeof WebSocket {
  return class extends WebSocket {
    override close(code?: number, reason?: string): void {
      if (!stuck(this.url)) super.close(code, reason);
    }
  };
}

test("a late welcome on a discarded link (its migration target was superseded before it welcomed) is ignored: no re-subscribe, no status", async () => {
  const a = fakeEventSub();
  const b = fakeEventSub();
  const h = harness(a.url, { sessions: 1, WebSocketImpl: stickyCloseWebSocket((url) => url.endsWith("id=first")) });
  try {
    h.client.start();
    await until(() => a.conns.length === 1, "socket on a");
    const old = a.conns[0]!;
    a.welcome(old, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");

    a.reconnect(old, "sess-A", `${b.url}?id=first`);
    await until(() => b.conns.length === 1, "first reconnect target");
    a.reconnect(old, "sess-A", `${b.url}?id=second`); // a second reconnect supersedes the first target before it welcomed
    await until(() => b.conns.length === 2, "second reconnect target");
    const stale = b.conns[0]!;
    const fresh = b.conns[1]!;
    await Bun.sleep(50);
    expect(stale.closed).toBe(false); // its close never took, so the late welcome below can still arrive

    b.welcome(stale, "sess-late");
    await Bun.sleep(100);
    expect(h.subs).toHaveLength(6); // nothing POSTed for a discarded link
    expect(h.statuses).toEqual([{ session: 1, connected: true }]);

    b.welcome(fresh, "sess-A");
    await until(() => old.closed, "old socket closed after the real welcome");
    expect(h.statuses.at(-1)).toEqual({ session: 1, connected: true, reason: "migrated" });
    expect(h.subs).toHaveLength(6);
  } finally {
    h.client.stop();
    a.stop();
    b.stop();
  }
});

test("(verbose) VERBOSE detail: welcome, the subscribed types and notification frames per session, and the cross-session duplicate it dropped — by message id, never the payload; keepalives go to DEBUG only", async () => {
  const server = fakeEventSub();
  const verbose: string[] = [];
  const debug: string[] = [];
  const h = harness(server.url, { verbose: (line) => void verbose.push(line), debug: (line) => void debug.push(line) });
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "subscribed");
    await until(() => verbose.filter((l) => l.includes("subscribed")).length === 2, "both subscribed lines");
    server.keepalive(server.conns[0]!);
    server.send(server.conns[0]!, cheer(500, "m1"));
    server.send(server.conns[1]!, cheer(500, "m2")); // the other session's copy of the same cheer
    await until(() => verbose.filter((l) => l.includes("notification")).length === 2, "both notifications");
    await until(() => verbose.some((l) => l.includes("duplicate")), "the duplicate line");
    expect(h.notifications).toHaveLength(1);
    expect(verbose).toEqual(
      expect.arrayContaining([
        "session 1: welcome",
        "session 2: welcome",
        "session 1: subscribed channel.cheer, channel.bits.use, channel.subscribe, channel.subscription.message, channel.subscription.gift, channel.chat.message",
        "session 2: subscribed channel.cheer, channel.bits.use, channel.subscribe, channel.subscription.message, channel.subscription.gift, channel.chat.message",
        expect.stringMatching(/^session 1: notification channel\.cheer from Cool_User \(bits=500\) at \S+$/),
        expect.stringMatching(/^session 2: notification channel\.cheer from Cool_User \(bits=500\) at \S+$/),
        "duplicate ignored m2",
      ]),
    );
    expect(verbose.filter((l) => l.includes("keepalive"))).toEqual([]);
    expect(debug).toEqual(["session 1: keepalive"]);
    for (const line of [...verbose, ...debug]) expect(line).not.toContain("{");
  } finally {
    h.client.stop();
    server.stop();
  }
});

// ---- mock mode (follow-up 1): the Twitch CLI's mock server validates subscriptions against ITS sessions ----------------

test("mockSubscriptionsUrl: a plain ws:// eventsub url (the Twitch CLI mock) → http://<same host:port>/eventsub/subscriptions; wss:// (real Twitch) → nothing", () => {
  expect(mockSubscriptionsUrl("ws://127.0.0.1:8098/ws")).toBe("http://127.0.0.1:8098/eventsub/subscriptions");
  expect(mockSubscriptionsUrl("ws://host.docker.internal:8080/ws")).toBe("http://host.docker.internal:8080/eventsub/subscriptions");
  expect(mockSubscriptionsUrl("ws://127.0.0.1:8080/ws?keepalive_timeout_seconds=10")).toBe("http://127.0.0.1:8080/eventsub/subscriptions");
  expect(mockSubscriptionsUrl("wss://eventsub.wss.twitch.tv/ws")).toBeUndefined();
  expect(mockSubscriptionsUrl("wss://127.0.0.1:8080/ws")).toBeUndefined(); // the mock's --ssl mode is real-Twitch-shaped: not mock mode
  expect(mockSubscriptionsUrl("not a url")).toBeUndefined();
});

test("subscriptionsUrl: the 6 subscription POSTs go to it instead of Helix, with the same headers and body; the socket url is untouched", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1, subscriptionsUrl: MOCK_SUBSCRIPTIONS });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    expect(server.conns[0]!.path).toBe("/ws?keepalive_timeout_seconds=10");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.subs.length === 6, "6 subscription POSTs");
    expect(h.subs.map((s) => s.url)).toEqual(Array(6).fill(MOCK_SUBSCRIPTIONS));
    expect(h.subs.map((s) => `${s.body.type}@${s.body.version}`).sort()).toEqual(EXPECTED_TYPES);
    for (const s of h.subs) {
      expect(s.body.condition).toEqual(s.body.type === "channel.chat.message" ? { broadcaster_user_id: "1337", user_id: "1337" } : { broadcaster_user_id: "1337" });
      expect(s.body.transport).toEqual({ method: "websocket", session_id: "sess-A" });
      expect(s.headers.authorization).toBe("Bearer tok");
      expect(s.headers["client-id"]).toBe("cid");
    }
    await until(() => h.statuses.some((s) => s.connected), "connected");
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("mock mode: a subscription type the Twitch CLI mock does not know (channel.bits.use → 400) is logged and skipped, the session still connects; every POST refused → dropped as usual", async () => {
  const refuseBitsUse: SubscribeHook = (post) => (post.body.type === "channel.bits.use" ? new Response('{"error":"Bad Request"}', { status: 400 }) : undefined);
  const logs: string[] = [];
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1, subscriptionsUrl: MOCK_SUBSCRIPTIONS, log: (line) => void logs.push(line) }, { subscribe: refuseBitsUse });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "a status");
    expect(h.statuses[0]).toEqual({ session: 1, connected: true });
    expect(h.subs).toHaveLength(6);
    expect(logs).toContain('session 1: mock server refused channel.bits.use (Helix POST eventsub/subscriptions → 400: {"error":"Bad Request"}) — skipped, 4 of 5 subscribed');
    expect(server.conns[0]!.closed).toBe(false);
  } finally {
    h.client.stop();
    server.stop();
  }

  const refuseAll: SubscribeHook = () => new Response("Bad Request", { status: 400 });
  const server2 = fakeEventSub();
  const all = harness(server2.url, { sessions: 1, subscriptionsUrl: MOCK_SUBSCRIPTIONS }, { subscribe: refuseAll });
  try {
    all.client.start();
    await until(() => server2.conns.length === 1, "socket");
    server2.welcome(server2.conns[0]!, "sess-B");
    await until(() => all.statuses.length === 1, "a status");
    expect(all.statuses[0]).toMatchObject({ session: 1, connected: false, reason: expect.stringMatching(/^subscribe failed: .*400/) });
  } finally {
    all.client.stop();
    server2.stop();
  }
});

test("real mode (no subscriptionsUrl): one refused POST still drops the socket — the mock-mode tolerance never applies to Twitch", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 }, { subscribe: (post) => (post.body.type === "channel.bits.use" ? new Response("Bad Request", { status: 400 }) : undefined) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "a status");
    expect(h.statuses[0]).toMatchObject({ session: 1, connected: false, reason: expect.stringMatching(/^subscribe failed: .*400/) });
  } finally {
    h.client.stop();
    server.stop();
  }
});

// ---- chat: a soft subscription on the same socket -----------------------------------------------------------------

test("chat is soft: a 403 on channel.chat.message alone — the five money POSTs stand, the session connects, the socket stays open, onChatSubscribe ok:false with the reason, one log line; a later chat frame is still delivered", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const logs: string[] = [];
  const h = harness(server.url, { sessions: 1, onChatSubscribe: (s) => void chat.push(s), log: (line) => void logs.push(line) }, { subscribe: failTypeOf("sess-A", "channel.chat.message", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "a status");
    expect(h.statuses[0]).toEqual({ session: 1, connected: true });
    expect(h.subs).toHaveLength(6);
    expect(chat).toEqual([{ session: 1, ok: false, reason: "Helix POST eventsub/subscriptions → 403" }]);
    expect(logs).toContain("session 1: chat subscription refused (Helix POST eventsub/subscriptions → 403: Forbidden) — the money events stay up, chat is not heard; retrying in 5 s");
    await Bun.sleep(50);
    expect(server.conns[0]!.closed).toBe(false);
    server.send(server.conns[0]!, chatMessage("m1")); // Twitch would not send one; the client must not choke if it did
    await until(() => h.notifications.length === 1, "chat frame delivered");
  } finally {
    h.client.stop();
    server.stop();
  }
});

/** Refuses `type` on `sessionId` for the first `times` POSTs of that type, then accepts. */
const refuseFirst = (sessionId: string, type: string, times: number, fate: Response | Error): SubscribeHook => {
  let seen = 0;
  return (post) => {
    if (post.body.transport.session_id !== sessionId || post.body.type !== type) return undefined;
    return seen++ < times ? fate : undefined;
  };
};

test("a 429 on chat is retried on the same session after the first delay and heard without a broadcaster link; the log names the delay and Twitch's body", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const logs: string[] = [];
  const body = '{"error":"Too Many Requests","status":429,"message":"subscription limit exceeded"}';
  const h = harness(server.url, { sessions: 1, chatRetryDelaysMs: [20, 20, 20], onChatSubscribe: (s) => void chat.push(s), log: (line) => void logs.push(line) }, { subscribe: refuseFirst("sess-A", "channel.chat.message", 1, new Response(body, { status: 429 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => chat.length === 2, "the refusal, then the accepted retry");
    expect(chat).toEqual([
      { session: 1, ok: false, reason: "Helix POST eventsub/subscriptions → 429" },
      { session: 1, ok: true },
    ]);
    expect(h.subs).toHaveLength(7); // 6, then the one chat retry
    expect(h.subs[6]!.body).toMatchObject({ type: "channel.chat.message", transport: { session_id: "sess-A" } });
    expect(logs).toContain(`session 1: chat subscription refused (Helix POST eventsub/subscriptions → 429: ${body}) — the money events stay up, chat is not heard; retrying in 0.02 s`);
    expect(logs).toContain("session 1: chat subscription accepted on retry 1 — chat is heard");
    expect(h.statuses).toEqual([{ session: 1, connected: true }]); // the retry is not a status event
    expect(server.conns[0]!.closed).toBe(false);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("three refused retries stop the ladder until the next broadcaster link; only chat is ever retried and the socket stays up", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const logs: string[] = [];
  const h = harness(server.url, { sessions: 1, chatRetryDelaysMs: [20, 20, 20], onChatSubscribe: (s) => void chat.push(s), log: (line) => void logs.push(line) }, { subscribe: failTypeOf("sess-A", "channel.chat.message", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.subs.length === 9, "6 POSTs then 3 chat retries");
    await Bun.sleep(120); // past where a fourth retry would have fired
    expect(h.subs).toHaveLength(9);
    expect(h.subs.slice(6).map((s) => s.body.type)).toEqual(["channel.chat.message", "channel.chat.message", "channel.chat.message"]);
    expect(chat).toEqual([{ session: 1, ok: false, reason: "Helix POST eventsub/subscriptions → 403" }]); // one report, not one per retry
    expect(logs.filter((l) => l.includes("retrying in"))).toHaveLength(3);
    expect(logs).toContain("session 1: chat subscription refused 4 times (Helix POST eventsub/subscriptions → 403: Forbidden) — not retrying until the next broadcaster link");
    expect(server.conns[0]!.closed).toBe(false);
    expect(h.statuses).toEqual([{ session: 1, connected: true }]);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("a session superseded mid-backoff (session_reconnect) never retries on the dead socket, and the migrated socket is not re-subscribed", async () => {
  const a = fakeEventSub();
  const b = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const h = harness(a.url, { sessions: 1, chatRetryDelaysMs: [200, 200, 200], onChatSubscribe: (s) => void chat.push(s) }, { subscribe: failTypeOf("sess-A", "channel.chat.message", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => a.conns.length === 1, "socket on a");
    const old = a.conns[0]!;
    a.welcome(old, "sess-A");
    await until(() => chat.length === 1, "the refusal");
    a.reconnect(old, "sess-A", `${b.url}?id=migrated`);
    await until(() => b.conns.length === 1, "socket on the reconnect url");
    b.welcome(b.conns[0]!, "sess-A");
    await until(() => old.closed, "old socket closed after the new welcome");
    await Bun.sleep(500); // past every retry delay
    expect(h.subs).toHaveLength(6); // no retry POST on the discarded link; migration never re-subscribes
    expect(chat).toHaveLength(1);
  } finally {
    h.client.stop();
    a.stop();
    b.stop();
  }
});

test("a dropped socket cancels the chat retry; the fresh connect subscribes all six as ever", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const h = harness(server.url, { sessions: 1, chatRetryDelaysMs: [200, 200, 200], onChatSubscribe: (s) => void chat.push(s) }, { subscribe: failTypeOf("sess-A", "channel.chat.message", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => chat.length === 1, "the refusal");
    server.close(server.conns[0]!); // Twitch closes it: #onClose, backoff, fresh connect
    await until(() => server.conns.length === 2, "fresh socket", 3000);
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => h.subs.length === 12, "re-subscribed on the new session");
    await Bun.sleep(300);
    expect(h.subs.filter((s) => s.body.transport.session_id === "sess-A")).toHaveLength(6); // nothing retried on the dead session
    expect(chat.at(-1)).toEqual({ session: 1, ok: true });
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("the default retry ladder is 5 s, 15 s, 45 s", () => {
  expect(CHAT_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 45_000]);
});

test("chat accepted: onChatSubscribe ok:true once per session, after the money POSTs stood", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const h = harness(server.url, { onChatSubscribe: (s) => void chat.push(s) });
  try {
    h.client.start();
    await until(() => server.conns.length === 2, "two sockets");
    server.welcome(server.conns[0]!, "sess-A");
    server.welcome(server.conns[1]!, "sess-B");
    await until(() => chat.length === 2, "both chat statuses");
    expect(chat.sort((x, y) => x.session - y.session)).toEqual([
      { session: 1, ok: true },
      { session: 2, ok: true },
    ]);
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("a refused money POST still drops the socket even when chat was accepted (the money rule wins); chat plus cheer refused → dropped too", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const h = harness(server.url, { sessions: 1, onChatSubscribe: (s) => void chat.push(s) }, { subscribe: failCheerOf("sess-A", new Response("Forbidden", { status: 403 })) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "disconnected status");
    expect(h.statuses[0]).toMatchObject({ session: 1, connected: false, reason: expect.stringMatching(/^subscribe failed: .*403/) });
    expect(chat).toEqual([]); // a dropped session reports no chat status
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("mock mode: the Twitch CLI mock refusing channel.chat.message is soft too — connected on the money types, onChatSubscribe ok:false", async () => {
  const server = fakeEventSub();
  const chat: ChatSubscribeStatus[] = [];
  const logs: string[] = [];
  const h = harness(server.url, { sessions: 1, subscriptionsUrl: MOCK_SUBSCRIPTIONS, onChatSubscribe: (s) => void chat.push(s), log: (line) => void logs.push(line) }, { subscribe: (post) => (post.body.type === "channel.chat.message" ? new Response('{"error":"Bad Request"}', { status: 400 }) : undefined) });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.statuses.length === 1, "a status");
    expect(h.statuses[0]).toEqual({ session: 1, connected: true });
    expect(chat).toEqual([{ session: 1, ok: false, reason: "Helix POST eventsub/subscriptions → 400" }]);
    expect(logs.filter((l) => l.includes("mock server refused"))).toEqual([]); // chat is not a mock-mode skip: it is the soft rule
  } finally {
    h.client.stop();
    server.stop();
  }
});

test("chat frames: delivered like any notification, two messages with the same text and different message ids are both delivered (the fingerprint covers message_id), and normalizeEventSub gives null — chat never becomes a Contribution", async () => {
  const server = fakeEventSub();
  const h = harness(server.url, { sessions: 1 });
  try {
    h.client.start();
    await until(() => server.conns.length === 1, "socket");
    server.welcome(server.conns[0]!, "sess-A");
    await until(() => h.subs.length === 6, "subscribed");
    server.send(server.conns[0]!, chatMessage("m1"));
    server.send(server.conns[0]!, chatMessage("m2")); // same text, new message_id: a second message, not a duplicate
    await until(() => h.notifications.length === 2, "both chat frames");
    expect(h.notifications.map((n) => n.metadata.message_id)).toEqual(["m1", "m2"]);
    expect(h.notifications[0]!.payload.event.chatter_user_id).toBe("1234");
    for (const n of h.notifications) expect(normalizeEventSub(n)).toBeNull();
  } finally {
    h.client.stop();
    server.stop();
  }
});

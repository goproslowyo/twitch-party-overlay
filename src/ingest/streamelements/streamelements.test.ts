import { test, expect } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import ioServer from "socket.io";
import { faceValueCents, type Contribution } from "../contribution.ts";
import type { SeSocketEvent, SeRestTipDoc } from "./normalize.ts";
import { SeSocket } from "./socket.ts";
import { SeRest, SeBackfill, SE_MAX_PAGES } from "./rest.ts";

// ---- fake realtime.streamelements.com (a real socket.io@2 server) ----------------------------------------------------

// Bun replaces `ws` with its own implementation, which hands *text* frames to engine.io@3 as (Buffer, isBinary=false);
// engine.io only understands strings for text frames and mis-decodes the Buffer as a binary packet, so every client
// packet is lost. Fixture-only shim: restore the string. The production client never runs this code path.
const EioWebSocketTransport = createRequire(import.meta.url)("engine.io/lib/transports/websocket.js");
const originalOnData = EioWebSocketTransport.prototype.onData;
EioWebSocketTransport.prototype.onData = function (this: unknown, data: unknown, isBinary?: boolean) {
  originalOnData.call(this, Buffer.isBuffer(data) && !isBinary ? data.toString("utf8") : data);
};

const GOOD_JWT = "jwt-good-token";

/** One fake StreamElements realtime server: requires `authenticate`, answers `authenticated` / `unauthorized`. */
async function fakeRealtime() {
  const http: HttpServer = createServer();
  const io = ioServer(http, { serveClient: false, transports: ["websocket"] });
  const authenticates: unknown[] = [];
  const sockets: SocketIO.Socket[] = [];
  const disconnects: string[] = [];
  io.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("authenticate", (payload: { method?: string; token?: string }) => {
      authenticates.push(payload);
      if (payload?.method === "jwt" && payload.token === GOOD_JWT) socket.emit("authenticated", { clientId: "c1", channelId: "5e9e1f2a3b4c5d6e7f8a9b0c", project: "tpo" });
      else socket.emit("unauthorized", { message: "Invalid token" });
    });
    socket.on("disconnect", (reason: string) => disconnects.push(reason));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    authenticates,
    sockets,
    disconnects,
    emitEvent: (payload: unknown) => sockets.at(-1)!.emit("event", payload),
    /** Drop the transport (as a network blip or an SE restart would) — the client is expected to reconnect. */
    kick: () => (sockets.at(-1)!.conn as unknown as { close(): void }).close(), // engine.io's Socket has close(); @types/socket.io@2 omits it
    stop: () =>
      new Promise<void>((resolve) => {
        io.close();
        http.close(() => resolve());
      }),
  };
}

function socketTip(overrides: Partial<SeSocketEvent["data"]> = {}, type = "tip"): SeSocketEvent {
  return {
    _id: "68c4a1b2c3d4e5f6a7b8c9d0",
    channel: "5e9e1f2a3b4c5d6e7f8a9b0c",
    type,
    provider: "twitch",
    data: { tipId: "68c4a1b2c3d4e5f6a7b8c9d1", username: "cool_user", displayName: "Cool_User", amount: 12.5, currency: "USD", message: "great set", ...overrides },
    createdAt: "2026-09-12T20:31:12.000Z",
    updatedAt: "2026-09-12T20:31:12.000Z",
  };
}

function socketHarness(url: string, jwt = GOOD_JWT) {
  const tips: Contribution[] = [];
  const events: unknown[] = [];
  const statuses: boolean[] = [];
  const socket = new SeSocket({ url, jwt, onTip: (c) => tips.push(c), onStatus: (s) => statuses.push(s), onEvent: (raw) => events.push(raw), log: () => {} });
  return { socket, tips, events, statuses };
}

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

// ---- socket ----------------------------------------------------------------------------------------------------------

test("socket: connects over websocket, authenticates with {method: jwt, token}, reports connected, and delivers tips normalized (raw envelope via onEvent)", async () => {
  const se = await fakeRealtime();
  const h = socketHarness(se.url);
  try {
    h.socket.start();
    await until(() => h.statuses.length > 0, "authenticated status");
    expect(h.statuses).toEqual([true]);
    expect(se.authenticates).toEqual([{ method: "jwt", token: GOOD_JWT }]);
    expect(se.sockets[0]!.conn.transport.name).toBe("websocket");

    se.emitEvent(socketTip());
    await until(() => h.tips.length > 0, "tip");
    expect(h.tips).toEqual([
      {
        source: "streamelements",
        sourceId: "se:68c4a1b2c3d4e5f6a7b8c9d1",
        face: { kind: "tip", cents: 1250 },
        displayName: "cool_user",
        anonymous: false,
        message: "great set",
        loginHint: "cool_user",
        occurredAt: "2026-09-12T20:31:12.000Z",
        currency: "USD",
      },
    ]);
    expect(h.events).toEqual([socketTip()]);

    // a non-tip activity is exposed raw (the caller decides what to keep) but never becomes a contribution
    se.emitEvent(socketTip({}, "follow"));
    await until(() => h.events.length === 2, "second raw event");
    expect(h.tips).toHaveLength(1);
    expect(h.events[1]).toEqual(socketTip({}, "follow"));
  } finally {
    h.socket.stop();
    await se.stop();
  }
});

test("socket: a rejected token → unauthorized → status false, nothing credited, and the token never reaches the log", async () => {
  const se = await fakeRealtime();
  const lines: string[] = [];
  const tips: Contribution[] = [];
  const statuses: boolean[] = [];
  const socket = new SeSocket({ url: se.url, jwt: "jwt-bad-token", onTip: (c) => tips.push(c), onStatus: (s) => statuses.push(s), log: (l) => lines.push(l) });
  try {
    socket.start();
    await until(() => statuses.length > 0, "unauthorized status");
    expect(statuses).toEqual([false]);
    expect(se.authenticates).toEqual([{ method: "jwt", token: "jwt-bad-token" }]);
    expect(lines.some((l) => /unauthorized/i.test(l))).toBe(true);
    expect(lines.join("\n")).not.toContain("jwt-bad-token");
    expect(tips).toEqual([]);
  } finally {
    socket.stop();
    await se.stop();
  }
});

test("socket: after the transport drops, the client reconnects and authenticates again (status true → false → true)", async () => {
  const se = await fakeRealtime();
  const h = socketHarness(se.url);
  try {
    h.socket.start();
    await until(() => h.statuses.length === 1, "first authenticated");
    se.kick();
    await until(() => h.statuses.length === 3, "reconnect + re-authenticate");
    expect(h.statuses).toEqual([true, false, true]);
    expect(se.authenticates).toHaveLength(2);
    expect(se.sockets).toHaveLength(2);

    se.emitEvent(socketTip({ tipId: "after-reconnect" }));
    await until(() => h.tips.length === 1, "tip on the new socket");
    expect(h.tips[0]!.sourceId).toBe("se:after-reconnect");
  } finally {
    h.socket.stop();
    await se.stop();
  }
});

test("socket: stop() disconnects (server sees it), reports status false once, and does not reconnect", async () => {
  const se = await fakeRealtime();
  const h = socketHarness(se.url);
  try {
    h.socket.start();
    await until(() => h.statuses.length === 1, "authenticated");
    h.socket.stop();
    await until(() => se.disconnects.length === 1, "server-side disconnect");
    expect(h.statuses).toEqual([true, false]);
    await Bun.sleep(1600); // longer than Socket.IO's first reconnect delay (1 s ± 50 %)
    expect(se.sockets).toHaveLength(1);
    expect(h.statuses).toEqual([true, false]);
    h.socket.stop(); // idempotent
  } finally {
    await se.stop();
  }
});

// ---- REST -----------------------------------------------------------------------------------------------------------

function restDoc(overrides: Partial<SeRestTipDoc> = {}): SeRestTipDoc {
  return {
    _id: "68c4a1b2c3d4e5f6a7b8c9d1",
    channel: "5e9e1f2a3b4c5d6e7f8a9b0c",
    provider: "paypal",
    status: "success",
    approved: "allowed",
    deleted: false,
    transactionId: "PAYID-000",
    donation: { user: { username: "cool_user", email: "cool@example.com" }, message: "great set", amount: 12.5, currency: "USD" },
    createdAt: "2026-09-12T20:31:12.000Z",
    updatedAt: "2026-09-12T20:31:12.000Z",
    ...overrides,
  };
}

const CHANNEL = "5e9e1f2a3b4c5d6e7f8a9b0c";
const BASE = "http://se.test/kappa/v2";

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** A doc that is *not* a `SeRestTipDoc`: a good one with fields overridden/removed (`undefined` drops the key in JSON). */
const malformed = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...restDoc(), ...patch });

/**
 * A fetch recorder: `pages` are answered in order for `/tips/<channel>` (or `tipsBody` verbatim when given); `/channels/me`
 * answers `_id`. `lines` collects the client's log.
 */
function fakeRest(pages: unknown[][], opts: { status?: number; channelsMe?: unknown; tipsBody?: unknown } = {}) {
  const calls: Call[] = [];
  const lines: string[] = [];
  let page = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (opts.status !== undefined) return new Response("nope", { status: opts.status });
    if (url.pathname === "/kappa/v2/channels/me") return Response.json(opts.channelsMe ?? { _id: CHANNEL, username: "examplestreamer", providerId: "1337" });
    if (url.pathname === `/kappa/v2/tips/${CHANNEL}`) {
      if (opts.tipsBody !== undefined) return Response.json(opts.tipsBody);
      const docs = pages[page++] ?? [];
      return Response.json({ docs, total: pages.flat().length, limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")) });
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  };
  const rest = new SeRest({ baseUrl: BASE, jwt: GOOD_JWT, fetchImpl, log: (l) => lines.push(l) });
  return { rest, calls, lines, tipsCalls: () => calls.filter((c) => c.url.pathname.startsWith("/kappa/v2/tips/")) };
}

const docsPage = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => restDoc({ _id: `${prefix}${i}`, createdAt: new Date(Date.UTC(2026, 8, 12, 20, 0, i)).toISOString() }));

test("rest: tipsSince follows offset pagination until a short page (100 + 3 → 103), with after/sort/limit and the bearer jwt", async () => {
  const f = fakeRest([docsPage(100, "a"), docsPage(3, "b")]);
  const out = await f.rest.tipsSince(CHANNEL, "2026-09-12T20:26:12.000Z");
  expect(out).toHaveLength(103);
  expect(out[0]!.contribution.sourceId).toBe("se:a0");
  expect(out[102]!.contribution.sourceId).toBe("se:b2");
  expect(out.every((r) => r.denied === false)).toBe(true);

  const tips = f.tipsCalls();
  expect(tips).toHaveLength(2);
  expect(tips[0]!.url.origin + tips[0]!.url.pathname).toBe(`http://se.test/kappa/v2/tips/${CHANNEL}`);
  expect(Object.fromEntries(tips[0]!.url.searchParams)).toEqual({ after: "2026-09-12T20:26:12.000Z", sort: "createdAt", limit: "100", offset: "0" });
  expect(Object.fromEntries(tips[1]!.url.searchParams)).toEqual({ after: "2026-09-12T20:26:12.000Z", sort: "createdAt", limit: "100", offset: "100" });
  expect(tips[0]!.headers["authorization"]).toBe(`Bearer ${GOOD_JWT}`);
});

test("rest: a page shorter than the limit ends pagination after one request; an empty page yields []", async () => {
  const f = fakeRest([docsPage(7, "x")]);
  expect(await f.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).toHaveLength(7);
  expect(f.tipsCalls()).toHaveLength(1);

  const empty = fakeRest([[]]);
  expect(await empty.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).toEqual([]);
  expect(empty.tipsCalls()).toHaveLength(1);
});

test("rest: exactly one full page then an empty one → 100 results from offsets 0 and 100; endless full pages stop at SE_MAX_PAGES with an error", async () => {
  const f = fakeRest([docsPage(100, "a"), []]);
  const out = await f.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z");
  expect(out).toHaveLength(100);
  expect(out[99]!.contribution.sourceId).toBe("se:a99");
  expect(f.tipsCalls().map((c) => c.url.searchParams.get("offset"))).toEqual(["0", "100"]);

  // an API that never returns a short page (e.g. ignores `offset`) must not spin forever
  const endless = fakeRest(Array.from({ length: SE_MAX_PAGES + 1 }, () => docsPage(100, "p")));
  await expect(endless.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).rejects.toThrow(/too many pages/);
  expect(endless.tipsCalls()).toHaveLength(SE_MAX_PAGES);
});

test("rest: a 2xx body whose docs is missing or not an array is an API shape change → throws, never an empty backfill", async () => {
  const noDocs = fakeRest([], { tipsBody: { total: 0, limit: 100, offset: 0 } });
  await expect(noDocs.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).rejects.toThrow(/docs/);
  expect(noDocs.lines).toEqual([]);

  const notArray = fakeRest([], { tipsBody: { docs: { a0: restDoc() }, total: 1 } });
  await expect(notArray.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).rejects.toThrow(/docs/);
});

test("rest: a malformed doc is skipped and logged (by _id when it has one); the good docs on the same page still come through", async () => {
  const f = fakeRest([[restDoc({ _id: "ok1" }), malformed({ _id: "junk1", donation: undefined }), restDoc({ _id: "ok2" })]]);
  const out = await f.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z");
  expect(out.map((r) => r.contribution.sourceId)).toEqual(["se:ok1", "se:ok2"]);
  expect(f.lines).toHaveLength(1);
  expect(f.lines[0]).toMatch(/junk1/);

  // every way a doc can fail the shape check: each is skipped, none becomes NaN cents or a thrown TypeError
  const bad = fakeRest([
    [
      restDoc({ _id: "ok3" }),
      malformed({ _id: "noAmount", donation: { user: { username: "u" }, currency: "USD" } }),
      malformed({ _id: "stringAmount", donation: { user: { username: "u" }, amount: "12.5" } }),
      malformed({ _id: "noUser", donation: { amount: 1 } }),
      malformed({ _id: "noUsername", donation: { user: { email: "u@example.com" }, amount: 1 } }),
      malformed({ _id: 42 }),
      malformed({ _id: "noCreatedAt", createdAt: undefined }),
      "not even an object",
      null,
    ],
  ]);
  const good = await bad.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z");
  expect(good.map((r) => r.contribution.sourceId)).toEqual(["se:ok3"]);
  expect(good.every((r) => Number.isFinite(faceValueCents(r.contribution.face)))).toBe(true);
  expect(bad.lines).toHaveLength(8);
  expect(bad.tipsCalls()).toHaveLength(1);
});

test("rest: channelId() → GET /channels/me → _id with the bearer jwt; non-2xx throws without echoing the token", async () => {
  const f = fakeRest([]);
  expect(await f.rest.channelId()).toBe(CHANNEL);
  expect(f.calls[0]!.url.toString()).toBe(`${BASE}/channels/me`);
  expect(f.calls[0]!.headers["authorization"]).toBe(`Bearer ${GOOD_JWT}`);

  const denied = fakeRest([], { status: 401 });
  await expect(denied.rest.channelId()).rejects.toThrow(/401/);
  await expect(denied.rest.tipsSince(CHANNEL, "2026-09-12T20:00:00.000Z")).rejects.toThrow(/401/);
  await denied.rest.channelId().catch((e: Error) => expect(e.message).not.toContain(GOOD_JWT));

  const noId = fakeRest([], { channelsMe: { username: "x" } });
  await expect(noId.rest.channelId()).rejects.toThrow(/_id/);
});

// ---- backfill --------------------------------------------------------------------------------------------------------

function backfillHarness(f: ReturnType<typeof fakeRest>, overrides: { intervalMs?: number; cursor?: () => string } = {}) {
  const tips: Contribution[] = [];
  const denied: string[] = [];
  const errors: unknown[] = [];
  const backfill = new SeBackfill({
    rest: f.rest,
    intervalMs: overrides.intervalMs ?? 60_000,
    onTip: (c) => void tips.push(c),
    onDenied: (id) => denied.push(id),
    onError: (e) => errors.push(e),
    cursor: overrides.cursor ?? (() => "2026-09-12T20:31:12.000Z"),
    log: () => {},
  });
  return { backfill, tips, denied, errors };
}

test("backfill: runOnce resolves the channel id, asks for tips after cursor − 5 min, credits allowed tips and voids denied ones", async () => {
  const f = fakeRest([[restDoc({ _id: "ok1" }), restDoc({ _id: "bad1", approved: "denied" }), restDoc({ _id: "ok2", createdAt: "2026-09-12T20:32:00.000Z" }), restDoc({ _id: "gone1", deleted: true })]]);
  const h = backfillHarness(f);
  await h.backfill.runOnce();

  expect(f.calls[0]!.url.pathname).toBe("/kappa/v2/channels/me");
  const tipsCall = f.tipsCalls()[0]!;
  expect(tipsCall.url.searchParams.get("after")).toBe("2026-09-12T20:26:12.000Z");
  expect(h.tips.map((c) => c.sourceId)).toEqual(["se:ok1", "se:ok2"]);
  expect(h.denied).toEqual(["se:bad1", "se:gone1"]);
  expect(h.errors).toEqual([]);

  // the channel id is cached: a second run makes no second /channels/me call
  await h.backfill.runOnce();
  expect(f.calls.filter((c) => c.url.pathname === "/kappa/v2/channels/me")).toHaveLength(1);
  expect(f.tipsCalls()).toHaveLength(2);
});

test("backfill: a malformed REST doc is skipped, not fatal — the good docs are credited, no NaN cents reach onTip, no error is reported", async () => {
  const f = fakeRest([[restDoc({ _id: "ok1" }), malformed({ _id: "noAmount", donation: { user: { username: "u" }, currency: "USD" } }), restDoc({ _id: "ok2" })]]);
  const h = backfillHarness(f);
  await h.backfill.runOnce();
  expect(h.tips.map((c) => c.sourceId)).toEqual(["se:ok1", "se:ok2"]);
  expect(h.tips.every((c) => Number.isFinite(faceValueCents(c.face)))).toBe(true);
  expect(h.denied).toEqual([]);
  expect(h.errors).toEqual([]);
  expect(f.lines).toHaveLength(1);

  // a body without docs is reported through onError rather than read as "nothing to backfill"
  const shape = fakeRest([], { tipsBody: { total: 0 } });
  const hs = backfillHarness(shape);
  await hs.backfill.runOnce();
  expect(hs.tips).toEqual([]);
  expect(hs.errors).toHaveLength(1);
  expect(String(hs.errors[0])).toMatch(/docs/);
});

test("backfill: a failing fetch is reported through onError and never thrown out of runOnce", async () => {
  const boom = new Error("connection reset");
  const rest = new SeRest({ baseUrl: BASE, jwt: GOOD_JWT, fetchImpl: async () => Promise.reject(boom) });
  const errors: unknown[] = [];
  const backfill = new SeBackfill({ rest, intervalMs: 60_000, onTip: () => {}, onDenied: () => {}, onError: (e) => errors.push(e), cursor: () => "2026-09-12T20:31:12.000Z", log: () => {} });
  await backfill.runOnce();
  expect(errors).toEqual([boom]);

  const f = fakeRest([], { status: 500 });
  const h = backfillHarness(f);
  await h.backfill.runOnce();
  expect(h.errors).toHaveLength(1);
  expect(String(h.errors[0])).toMatch(/500/);
});

test("backfill: start() runs immediately then every intervalMs; stop() clears the timer; a slow run is never overlapped", async () => {
  let release: () => void = () => {};
  let inFlight = 0;
  let calls = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/kappa/v2/channels/me") return Response.json({ _id: CHANNEL });
    calls++;
    inFlight++;
    if (calls === 1) await gate; // the first run hangs until the test releases it
    inFlight--;
    return Response.json({ docs: [], total: 0, limit: 100, offset: 0 });
  };
  const rest = new SeRest({ baseUrl: BASE, jwt: GOOD_JWT, fetchImpl });
  const errors: unknown[] = [];
  const backfill = new SeBackfill({ rest, intervalMs: 20, onTip: () => {}, onDenied: () => {}, onError: (e) => errors.push(e), cursor: () => "2026-09-12T20:31:12.000Z", log: () => {} });

  backfill.start();
  await until(() => calls === 1, "immediate run");
  await Bun.sleep(100); // five intervals pass while the first run is still in flight
  expect(calls).toBe(1);
  expect(inFlight).toBe(1);

  release();
  await until(() => calls >= 3, "runs resume on the interval");
  backfill.stop();
  const atStop = calls;
  await Bun.sleep(100);
  expect(calls).toBe(atStop);
  expect(errors).toEqual([]);
  backfill.stop(); // idempotent
});

test("backfill: the run summary — `N docs, M new, cursor …` — prints under VERBOSE when the run found a doc or failed, and under DEBUG only when it found nothing", async () => {
  const lines = () => ({ verbose: [] as string[], debug: [] as string[] });
  const mk = (f: ReturnType<typeof fakeRest>, seen: Set<string>) => {
    const out = lines();
    const backfill = new SeBackfill({
      rest: f.rest,
      intervalMs: 60_000,
      onTip: (c) => {
        const fresh = !seen.has(c.sourceId);
        seen.add(c.sourceId);
        return fresh; // what the Ledger dedupe would say
      },
      onDenied: () => {},
      onError: () => {},
      cursor: () => "2026-09-12T20:31:12.000Z",
      log: () => {},
      verbose: (l) => void out.verbose.push(l),
      debug: (l) => void out.debug.push(l),
    });
    return { backfill, ...out };
  };

  // two docs, one of them already in the Ledger, one denied: 3 docs, 1 new → VERBOSE
  const seen = new Set(["se:old1"]);
  const found = mk(fakeRest([[restDoc({ _id: "old1" }), restDoc({ _id: "new1" }), restDoc({ _id: "bad1", approved: "denied" })]]), seen);
  await found.backfill.runOnce();
  expect(found.verbose).toEqual(["backfill run: 3 docs, 1 new, cursor 2026-09-12T20:31:12.000Z"]);
  expect(found.debug).toEqual([]);

  // nothing in the window → DEBUG only
  const empty = mk(fakeRest([[]]), new Set());
  await empty.backfill.runOnce();
  expect(empty.verbose).toEqual([]);
  expect(empty.debug).toEqual(["backfill run: 0 docs, 0 new, cursor 2026-09-12T20:31:12.000Z"]);

  // a failed run is worth a VERBOSE line even with nothing found
  const failed = mk(fakeRest([], { status: 500 }), new Set());
  await failed.backfill.runOnce();
  expect(failed.verbose).toEqual(["backfill run failed: 0 docs, 0 new, cursor 2026-09-12T20:31:12.000Z"]);
  expect(failed.debug).toEqual([]);
});

import { test, expect } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import { FIREBOT_SAYS, Firebot } from "./firebot.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

function config(overrides: Partial<Config["firebot"]> = {}): Config {
  const c = defaultConfig();
  c.channel.login = "examplestreamer";
  c.firebot = { ...c.firebot, enabled: true, ...overrides };
  return c;
}

/** Records every (url, init) and serves canned Firebot responses; `fail`/`throwOn` break chosen calls. */
function fakeFirebot(opts: { commands?: () => unknown; fail?: (call: Call) => number | false; throwOn?: (call: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    if (opts.throwOn?.(call)) throw new TypeError("fetch failed");
    const status = opts.fail?.(call);
    if (status) return new Response("nope", { status });
    if (call.method === "GET" && call.url.endsWith("/api/v1/commands/custom")) {
      return Response.json(opts.commands?.() ?? [{ id: "cmd-1", trigger: "!giveaway" }]);
    }
    return Response.json({ status: "success" });
  };
  return { calls, fetchImpl };
}

const isRun = (c: Call, args: string) => c.url.endsWith("/run") && (c.body as { args?: string }).args === args;
const flush = () => new Promise((r) => setTimeout(r, 0));
const T0 = new Date("2026-09-12T20:00:00.000Z");

test("open: discover → start → the prize line, then nothing — entries stay open; close stops them, draw names the winner, reopen resumes, clear ends it", async () => {
  const fb = fakeFirebot();
  const slept: number[] = [];
  const firebot = new Firebot({
    config: () => config(),
    fetchImpl: fb.fetchImpl,
    now: () => T0,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  expect(firebot.current()).toBeNull();
  expect(await firebot.open("SHIRT", 7)).toEqual({ ok: true });
  expect(firebot.current()).toEqual({ prize: "SHIRT", fireSeq: 7, openedAt: T0.toISOString(), phase: "open", draws: 0 });

  // start FIRST (Firebot empties the list and says how to enter), then our one line: the prize
  expect(fb.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://localhost:7472/api/v1/commands/custom",
    "POST http://localhost:7472/api/v1/commands/custom/cmd-1/run",
    "POST http://localhost:7472/api/v1/effects",
  ]);
  expect(fb.calls[1]!.body).toEqual({ args: "start", username: "examplestreamer" });
  expect(fb.calls[2]!.body).toEqual({
    effects: {
      id: "tpo-raffle-announce",
      list: [{ id: "tpo-raffle-announce-msg", type: "firebot:chat", chatter: "Bot", message: "🎁 Tonight's prize: SHIRT — entries stay open until we draw!" }],
    },
    triggerData: { username: "examplestreamer" },
  });

  await flush();
  expect(slept).toEqual([]); // no timer: nobody closes this but a person
  expect(fb.calls.length).toBe(3);

  const args = (from: number) => fb.calls.slice(from).map((c) => (c.body as { args: string }).args);
  expect(await firebot.close()).toEqual({ ok: true });
  expect(args(3)).toEqual(["close"]);
  expect(firebot.current()).toMatchObject({ phase: "closed", draws: 0 });
  expect(await firebot.reopen()).toEqual({ ok: true });
  expect(args(4)).toEqual(["open"]);
  expect(firebot.current()).toMatchObject({ phase: "open", draws: 0 });
  expect(await firebot.closeAndDraw()).toEqual({ ok: true });
  expect(args(5)).toEqual(["close", "draw"]);
  expect(firebot.current()).toMatchObject({ phase: "closed", draws: 1 });
  expect(await firebot.draw()).toEqual({ ok: true }); // the winner never answered: one more draw, the list is Firebot's
  expect(args(7)).toEqual(["draw"]);
  expect(firebot.current()).toMatchObject({ phase: "closed", draws: 2 });
  expect(await firebot.clear()).toEqual({ ok: true }); // done: the list is emptied and nothing is tracked
  expect(args(8)).toEqual(["clear"]);
  expect(firebot.current()).toBeNull();
  expect(await firebot.draw()).toEqual({ ok: true }); // nothing tracked: still runs — Firebot holds the truth
  for (const c of fb.calls) expect(c.signal).toBeInstanceOf(AbortSignal); // 5 s AbortSignal.timeout on every call
});

test("open with autoCloseSeconds: the prize line names the window (rounded to minutes, never 0); the countdown speaks at the marks, then close + draw with no closed line of ours; the giveaway stays tracked as closed; a hand close first cancels the timer's turn", async () => {
  const fb = fakeFirebot();
  const slept: number[] = [];
  const firebot = new Firebot({
    config: () => config({ chatter: "Streamer", autoCloseSeconds: 200 }),
    fetchImpl: fb.fetchImpl,
    now: () => T0,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  expect(await firebot.open("STICKERS", 3)).toEqual({ ok: true });
  expect(firebot.current()).toEqual({ prize: "STICKERS", fireSeq: 3, openedAt: T0.toISOString(), phase: "open", draws: 0, autoCloseAt: new Date(T0.getTime() + 200_000).toISOString() });
  const said = (c: Call) => (c.body as { effects?: { list: Array<{ chatter: string; message: string }> } }).effects?.list[0];
  expect(said(fb.calls[2]!)).toMatchObject({ chatter: "Streamer", message: "🎁 Tonight's prize: STICKERS — entries close in 3 min!" });
  await flush();
  // the countdown: sleeps to each mark, one chat line per mark, then close + draw — Firebot's own lines say closed and who won
  expect(slept).toEqual([140_000, 45_000, 5_000, 5_000, 5_000]);
  expect(fb.calls.slice(3).map((c) => said(c)?.message ?? (c.body as { args: string }).args)).toEqual([
    "⏳ 1 minute left to type !giveaway enter for STICKERS!",
    "⏳ 15 seconds left to type !giveaway enter for STICKERS!",
    "⏳ 10 seconds left to type !giveaway enter for STICKERS!",
    "⏳ 5 seconds left to type !giveaway enter for STICKERS!",
    "close",
    "draw",
  ]);
  expect(firebot.current()).toMatchObject({ phase: "closed", draws: 1 }); // tracked until Done (clear)

  // a short window still says 1 min and skips the minute mark (only 15 / 10 / 5 fit in 20 s); a hand close mid-countdown
  // stops the rest: no more chat lines, no second close
  const releases: Array<() => void> = [];
  const fb2 = fakeFirebot();
  const timed = new Firebot({ config: () => config({ autoCloseSeconds: 20 }), fetchImpl: fb2.fetchImpl, now: () => T0, sleep: () => new Promise<void>((r) => releases.push(r)) });
  expect(await timed.open("SHIRT", 4)).toEqual({ ok: true });
  expect(said(fb2.calls[2]!)?.message).toContain("entries close in 1 min!");
  releases.shift()!(); // 5 s in: the 15-second line
  await flush();
  expect(said(fb2.calls[3]!)?.message).toBe("⏳ 15 seconds left to type !giveaway enter for SHIRT!");
  expect(await timed.closeAndDraw()).toEqual({ ok: true });
  while (releases.length > 0) releases.shift()!();
  await flush();
  await flush();
  expect(fb2.calls.slice(4).map((c) => said(c)?.message ?? (c.body as { args: string }).args)).toEqual(["close", "draw"]); // the hand close only
});

test("open: command trigger not found → ok:false and nothing is announced or run", async () => {
  const fb = fakeFirebot({ commands: () => [{ id: "cmd-9", trigger: "!other" }] });
  const firebot = new Firebot({ config: () => config(), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  const result = await firebot.open("SHIRT", 1);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("!giveaway");
  expect(fb.calls.length).toBe(1);
  expect(firebot.current()).toBeNull();
});

test("open: start returns 500 → ok:false, nothing open, no timer", async () => {
  const fb = fakeFirebot({ fail: (c) => (isRun(c, "start") ? 500 : false) });
  const slept: number[] = [];
  const firebot = new Firebot({
    config: () => config({ autoCloseSeconds: 120 }),
    fetchImpl: fb.fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const result = await firebot.open("SHIRT", 1);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("500");
  await flush();
  expect(slept).toEqual([]);
  expect(fb.calls.length).toBe(2); // discover, start — the prize line never goes out for a giveaway that did not open
  expect(firebot.current()).toBeNull();
});

test("open / close / draw: fetch throws → ok:false, never throws", async () => {
  const fb = fakeFirebot({ throwOn: () => true });
  const firebot = new Firebot({ config: () => config(), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  for (const result of [await firebot.open("SHIRT", 1), await firebot.close(), await firebot.closeAndDraw(), await firebot.draw(), await firebot.reopen(), await firebot.clear()]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fetch failed");
  }
});

test("disabled → { ok: false, error: 'disabled' } from open, close and draw; fetch is never called", async () => {
  const fb = fakeFirebot();
  const firebot = new Firebot({ config: () => config({ enabled: false }), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  expect(await firebot.open("SHIRT", 1)).toEqual({ ok: false, error: "disabled" });
  for (const act of [firebot.close(), firebot.closeAndDraw(), firebot.draw(), firebot.reopen(), firebot.clear()]) expect(await act).toEqual({ ok: false, error: "disabled" });
  expect(fb.calls.length).toBe(0);
});

test("closeAndDraw: a failed close → ok:false with the status, draw is not attempted, the giveaway stays open", async () => {
  const fb = fakeFirebot({ fail: (c) => (isRun(c, "close") ? 500 : false) });
  const firebot = new Firebot({ config: () => config(), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  expect(await firebot.open("USB · REKORDBOX EXPORT", 2)).toEqual({ ok: true });
  const result = await firebot.closeAndDraw();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("500");
  expect(fb.calls.filter((c) => isRun(c, "draw")).length).toBe(0);
  expect(firebot.current()).toMatchObject({ prize: "USB · REKORDBOX EXPORT", phase: "open" });
});

test("auto-close: a failed close → onWarn with the prize and the !raffle fallback; draw is not attempted", async () => {
  const fb = fakeFirebot({ fail: (c) => (isRun(c, "close") ? 500 : false) });
  const warnings: string[] = [];
  const firebot = new Firebot({ config: () => config({ autoCloseSeconds: 60 }), fetchImpl: fb.fetchImpl, sleep: async () => {}, onWarn: (t) => warnings.push(t) });
  expect(await firebot.open("USB · REKORDBOX EXPORT", 2)).toEqual({ ok: true });
  await flush();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("USB · REKORDBOX EXPORT");
  expect(warnings[0]).toContain("!raffle 1 120");
  expect(fb.calls.filter((c) => isRun(c, "draw")).length).toBe(0);
});

// bun:test fails the running test on any unhandled rejection, so "the test completes" is the assertion here.
test("auto-close: an onWarn that throws is contained — the deferred close/draw never rejects unhandled", async () => {
  const fb = fakeFirebot({ fail: (c) => (isRun(c, "close") ? 500 : false) });
  let warned = 0;
  const firebot = new Firebot({
    config: () => config({ autoCloseSeconds: 60 }),
    fetchImpl: fb.fetchImpl,
    sleep: async () => {},
    onWarn: () => {
      warned += 1;
      throw new Error("health sink exploded");
    },
  });
  expect(await firebot.open("SHIRT", 1)).toEqual({ ok: true });
  await flush(); // the deferred close 500 → onWarn throws inside #autoClose
  await flush();
  expect(warned).toBe(1);
  expect(fb.calls.filter((c) => isRun(c, "draw")).length).toBe(0);
});

test("the command id is cached across raffles and re-discovered after a 404", async () => {
  let liveId = "cmd-1"; // the id Firebot currently reports for !giveaway
  const fb = fakeFirebot({
    commands: () => [{ id: liveId, trigger: "!giveaway" }],
    fail: (c) => (c.url.includes("/run") && !c.url.includes(`/${liveId}/`) ? 404 : false), // runs against a stale id 404
  });
  const firebot = new Firebot({ config: () => config(), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  const gets = () => fb.calls.filter((c) => c.method === "GET").length;

  expect(await firebot.open("SHIRT", 1)).toEqual({ ok: true });
  await flush();
  expect(await firebot.open("STICKERS", 2)).toEqual({ ok: true });
  await flush();
  expect(gets()).toBe(1); // second raffle reused the cached id

  liveId = "cmd-2"; // Firebot was restarted / the command re-imported
  expect(await firebot.open("SHIRT", 1)).toEqual({ ok: true });
  await flush();
  expect(gets()).toBe(2); // 404 → re-discovered once
  const runs = fb.calls.filter((c) => c.url.includes("/run")).map((c) => c.url.replace("http://localhost:7472/api/v1/commands/custom/", "") + " " + (c.body as { args: string }).args);
  expect(runs.slice(-2)).toEqual(["cmd-1/run start", "cmd-2/run start"]);
});

test("openDry: the whole flow with Firebot off and nothing fetched — start, the prize line, the countdown, close + draw all land in the transcript (quoting what Firebot itself says); every act works; clear ends it", async () => {
  const fb = fakeFirebot();
  const slept: number[] = [];
  const firebot = new Firebot({
    config: () => config({ enabled: false, autoCloseSeconds: 20 }),
    fetchImpl: fb.fetchImpl,
    now: () => T0,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  expect(await firebot.openDry("USB STICK")).toEqual({ ok: true });
  expect(firebot.current()).toMatchObject({ prize: "USB STICK", fireSeq: 0, dry: true, phase: "open", draws: 0, autoCloseAt: new Date(T0.getTime() + 20_000).toISOString() });
  await flush();
  expect(slept).toEqual([5_000, 5_000, 5_000, 5_000]);
  expect(firebot.transcript()).toEqual([
    `firebot: !giveaway start → ${FIREBOT_SAYS.start}`,
    "chat (Bot): 🎁 Tonight's prize: USB STICK — entries close in 1 min!",
    "chat (Bot): ⏳ 15 seconds left to type !giveaway enter for USB STICK!",
    "chat (Bot): ⏳ 10 seconds left to type !giveaway enter for USB STICK!",
    "chat (Bot): ⏳ 5 seconds left to type !giveaway enter for USB STICK!",
    `firebot: !giveaway close → ${FIREBOT_SAYS.close}`,
    `firebot: !giveaway draw → ${FIREBOT_SAYS.draw}`,
  ]);
  expect(firebot.current()).toMatchObject({ phase: "closed", draws: 1 });
  expect(fb.calls).toEqual([]); // nothing left this computer

  // by hand, Firebot still off, still nothing fetched: draw again, reopen, close, clear (the end)
  expect(await firebot.draw()).toEqual({ ok: true });
  expect(await firebot.reopen()).toEqual({ ok: true });
  expect(await firebot.close()).toEqual({ ok: true });
  expect(await firebot.clear()).toEqual({ ok: true });
  expect(firebot.transcript().slice(7)).toEqual([`firebot: !giveaway draw → ${FIREBOT_SAYS.draw}`, `firebot: !giveaway open → ${FIREBOT_SAYS.open}`, `firebot: !giveaway close → ${FIREBOT_SAYS.close}`, `firebot: !giveaway clear → ${FIREBOT_SAYS.clear}`]);
  expect(firebot.current()).toBeNull();
  expect(fb.calls).toEqual([]);
});

test("queue: a raffle Fire waits (nothing fetched) until open() with that fireSeq takes it off the list; the same seq never queues twice", async () => {
  const fb = fakeFirebot();
  const firebot = new Firebot({ config: () => config(), fetchImpl: fb.fetchImpl, sleep: async () => {} });
  firebot.queue("STICKERS", 4);
  firebot.queue("SHIRT", 9);
  firebot.queue("STICKERS", 4);
  expect(firebot.pending()).toEqual([{ prize: "STICKERS", fireSeq: 4 }, { prize: "SHIRT", fireSeq: 9 }]);
  expect(fb.calls).toEqual([]);
  expect(await firebot.open("STICKERS", 4)).toEqual({ ok: true });
  expect(firebot.pending()).toEqual([{ prize: "SHIRT", fireSeq: 9 }]);
  expect(firebot.current()).toMatchObject({ prize: "STICKERS", fireSeq: 4, phase: "open" });
});

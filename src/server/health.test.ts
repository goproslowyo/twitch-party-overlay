import { test, expect } from "bun:test";
import { CHAT_HEALTH_ID, CHAT_UNHEARD_TEXT, Health } from "./health.ts";

/** A clock the test advances by hand so `at` ordering is deterministic. */
function clock(startMs = Date.UTC(2026, 8, 12, 20, 0, 0)) {
  let t = startMs;
  return { now: () => new Date(t), tick: (ms = 1000) => (t += ms) };
}

test("set adds a banner with level, text and an ISO timestamp", () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.set("kofi-boot", "info", "Service (re)started at 20:00 — Ko-fi webhooks during downtime are lost; check the Ko-fi dashboard");
  expect(h.list()).toEqual([
    { id: "kofi-boot", level: "info", text: "Service (re)started at 20:00 — Ko-fi webhooks during downtime are lost; check the Ko-fi dashboard", at: "2026-09-12T20:00:00.000Z" },
  ]);
});

test("set with the same id replaces the banner (one entry, new text and time)", () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.set("twitch", "warn", "Twitch EventSub: all sessions disconnected");
  c.tick();
  h.set("twitch", "info", "Twitch EventSub: reconnected");
  expect(h.list()).toEqual([{ id: "twitch", level: "info", text: "Twitch EventSub: reconnected", at: "2026-09-12T20:00:01.000Z" }]);
});

test("list is sorted by at desc (newest first), regardless of set order", () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.set("a", "info", "first");
  c.tick();
  h.set("b", "warn", "second");
  c.tick();
  h.set("c", "info", "third");
  c.tick();
  h.set("a", "info", "first again"); // re-set moves it to the top
  expect(h.list().map((i) => i.id)).toEqual(["a", "c", "b"]);
});

test("dismiss hides a banner until the next set of that id", () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.set("kofi-boot", "info", "restarted");
  h.dismiss("kofi-boot");
  expect(h.list()).toEqual([]);
  h.set("kofi-boot", "info", "restarted again");
  expect(h.list().map((i) => i.text)).toEqual(["restarted again"]);
});

test("clear removes a banner; dismiss and clear of unknown ids are no-ops", () => {
  const h = new Health();
  h.set("firebot", "warn", "Firebot didn't respond for SHIRT — type !raffle 1 120 in chat");
  h.clear("firebot");
  expect(h.list()).toEqual([]);
  expect(() => h.dismiss("nope")).not.toThrow();
  expect(() => h.clear("nope")).not.toThrow();
  expect(h.list()).toEqual([]);
});

test("without an injected clock, at is the current time as ISO", () => {
  const before = Date.now();
  const h = new Health();
  h.set("x", "info", "now");
  const at = Date.parse(h.list()[0]!.at);
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
});

test("the chat-unheard line: a keyed warn like overlay-quality; the copy tells the streamer where to click", () => {
  expect(CHAT_HEALTH_ID).toBe("chat-unheard");
  expect(CHAT_UNHEARD_TEXT).toBe("Connect the broadcaster account again to hear chat: click the broadcaster link on the Config page");
  const h = new Health({ now: () => new Date("2026-09-16T20:00:00.000Z") });
  h.set(CHAT_HEALTH_ID, "warn", CHAT_UNHEARD_TEXT);
  expect(h.list()).toEqual([{ id: "chat-unheard", level: "warn", text: CHAT_UNHEARD_TEXT, at: "2026-09-16T20:00:00.000Z" }]);
  h.clear(CHAT_HEALTH_ID);
  expect(h.list()).toEqual([]);
});

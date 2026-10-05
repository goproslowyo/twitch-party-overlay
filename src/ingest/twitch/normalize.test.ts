import { test, expect } from "bun:test";
import type { Contribution } from "../contribution.ts";
import { describeEvent, eventFingerprint, normalizeEventSub, type EventSubNotification } from "./normalize.ts";

/** Field names per the EventSub reference; every event carries the broadcaster triple. */
function notification(
  type: string,
  event: Record<string, unknown>,
  meta: { message_id?: string; message_timestamp?: string } = {},
): EventSubNotification {
  return {
    metadata: {
      message_id: meta.message_id ?? "msg-1",
      message_timestamp: meta.message_timestamp ?? "2026-09-12T20:31:12.464757833Z",
      subscription_type: type,
    },
    payload: {
      subscription: { type },
      event: { broadcaster_user_id: "1337", broadcaster_user_login: "examplestreamer", broadcaster_user_name: "ExampleStreamer", ...event },
    },
  };
}

const user = { user_id: "1234", user_login: "cool_user", user_name: "Cool_User" };
const nobody = { user_id: null, user_login: null, user_name: null };

type Expected = Omit<Contribution, "sourceId"> | null;

const table: Array<{ name: string; msg: EventSubNotification; expected: Expected }> = [
  {
    name: "channel.cheer 500 anonymous → bits 500, anonymous, no name",
    msg: notification("channel.cheer", { ...nobody, is_anonymous: true, message: "pogchamp", bits: 500 }),
    expected: { source: "twitch", face: { kind: "bits", bits: 500 }, displayName: null, anonymous: true, twitchUserId: null, message: "pogchamp", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.cheer 1000 by Cool_User → bits 1000 credited to the display name",
    msg: notification("channel.cheer", { ...user, is_anonymous: false, message: "cheer1000 great set", bits: 1000 }),
    expected: { source: "twitch", face: { kind: "bits", bits: 1000 }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", message: "cheer1000 great set", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.bits.use type cheer → null (already credited by channel.cheer)",
    msg: notification("channel.bits.use", {
      ...user,
      bits: 100,
      type: "cheer",
      power_up: null,
      message: { text: "cheer100", fragments: [{ type: "cheermote", text: "cheer100", cheermote: { prefix: "cheer", bits: 100, tier: 100 }, emote: null }] },
    }),
    expected: null,
  },
  {
    name: "channel.bits.use power_up 100 → bits 100",
    msg: notification("channel.bits.use", {
      ...user,
      bits: 100,
      type: "power_up",
      power_up: { type: "message_effect", emote: null, message_effect_id: "simmer" },
      message: { text: "hello chat", fragments: [{ type: "text", text: "hello chat", cheermote: null, emote: null }] },
    }),
    expected: { source: "twitch", face: { kind: "bits", bits: 100 }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", message: "hello chat", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    // Custom Power-up redemption as it rides channel.bits.use (EventSub reference: type custom_power_up, power_up null, custom_power_up { title, reward_id }, no message).
    name: "channel.bits.use type custom_power_up 100 (Push the fader) → bits 100 at face, no message",
    msg: notification("channel.bits.use", {
      ...user,
      bits: 100,
      type: "custom_power_up",
      power_up: null,
      custom_power_up: { title: "Push the fader · 100", reward_id: "92af127c-7326-4483-a52b-b0da0be61c01" },
      message: null,
    }),
    expected: { source: "twitch", face: { kind: "bits", bits: 100 }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.bits.use type custom_power_up 10000 → bits 10000 at face (the SUBtember 10% never changes the face)",
    msg: notification("channel.bits.use", {
      ...user,
      bits: 10000,
      type: "custom_power_up",
      power_up: null,
      custom_power_up: { title: "Push the fader · 10K", reward_id: "92af127c-7326-4483-a52b-b0da0be61c05" },
      message: null,
    }),
    expected: { source: "twitch", face: { kind: "bits", bits: 10000 }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.subscribe is_gift → null (credited gifter-side by channel.subscription.gift)",
    msg: notification("channel.subscribe", { ...user, tier: "1000", is_gift: true }),
    expected: null,
  },
  {
    name: "channel.subscribe tier 2000 → sub tier 2000",
    msg: notification("channel.subscribe", { ...user, tier: "2000", is_gift: false }),
    expected: { source: "twitch", face: { kind: "sub", tier: "2000" }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.subscription.message cumulative_months 7 tier 1000 → sub months 7 with the resub text",
    msg: notification("channel.subscription.message", {
      ...user,
      tier: "1000",
      message: { text: "Love the stream! 7 months!", emotes: [] },
      cumulative_months: 7,
      streak_months: 3,
      duration_months: 1,
    }),
    expected: {
      source: "twitch",
      face: { kind: "sub", tier: "1000", months: 7 },
      displayName: "Cool_User",
      anonymous: false,
      twitchUserId: "1234",
      message: "Love the stream! 7 months!",
      occurredAt: "2026-09-12T20:31:12.464Z",
    },
  },
  {
    name: "channel.subscription.gift total 25 tier 1000 anonymous → gift 25, anonymous",
    msg: notification("channel.subscription.gift", { ...nobody, total: 25, tier: "1000", cumulative_total: null, is_anonymous: true }),
    expected: { source: "twitch", face: { kind: "gift", tier: "1000", count: 25 }, displayName: null, anonymous: true, twitchUserId: null, occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.subscription.gift total 5 tier 2000 by Cool_User → gift 5 at tier 2000",
    msg: notification("channel.subscription.gift", { ...user, total: 5, tier: "2000", cumulative_total: 284, is_anonymous: false }),
    expected: { source: "twitch", face: { kind: "gift", tier: "2000", count: 5 }, displayName: "Cool_User", anonymous: false, twitchUserId: "1234", occurredAt: "2026-09-12T20:31:12.464Z" },
  },
  {
    name: "channel.chat.message → null (chat is presence: the roster's business, never a Contribution)",
    msg: notification("channel.chat.message", { chatter_user_id: "1234", chatter_user_login: "cool_user", chatter_user_name: "Cool_User", message_id: "u1", message_type: "text", message: { text: "cheer100 lol", fragments: [] }, badges: [], color: "", source_broadcaster_user_id: null }),
    expected: null,
  },
  {
    name: "an unsubscribed type (channel.follow) → null",
    msg: notification("channel.follow", { ...user, followed_at: "2026-09-12T20:31:12Z" }),
    expected: null,
  },
];

for (const row of table) {
  test(`normalizeEventSub: ${row.name}`, () => {
    const got = normalizeEventSub(row.msg);
    if (row.expected === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got).not.toBeNull();
    const { sourceId, ...rest } = got!;
    expect(rest).toEqual(row.expected);
    expect(sourceId).toBe(`eventsub:${row.msg.metadata.subscription_type}:msg-1`);
  });
}

test("occurredAt: Twitch's nanosecond RFC3339 message_timestamp is re-serialised to the Ledger's form (toISOString, ms precision)", () => {
  const event = { ...user, is_anonymous: false, message: "cheer1000", bits: 1000 };
  const got = normalizeEventSub(notification("channel.cheer", event, { message_timestamp: "2026-09-12T20:31:12.981000000Z" }))!;
  expect(got.occurredAt).toBe("2026-09-12T20:31:12.981Z");
  expect(got.occurredAt).toBe(new Date("2026-09-12T20:31:12.981000000Z").toISOString());
});

test("sourceId: eventsub:<subscription_type>:<message_id> — the two sessions' deliveries differ, Twitch's own redelivery of a message id is identical", () => {
  const event = { ...user, is_anonymous: false, message: "cheer1000", bits: 1000 };
  const session1 = notification("channel.cheer", event, { message_id: "session-1-msg", message_timestamp: "2026-09-12T20:31:12.464757833Z" });
  const session2 = notification("channel.cheer", event, { message_id: "session-2-msg", message_timestamp: "2026-09-12T20:31:12.981000000Z" });
  const redelivery = notification("channel.cheer", event, { message_id: "session-1-msg", message_timestamp: "2026-09-12T20:31:42.000000000Z" });

  expect(normalizeEventSub(session1)!.sourceId).toBe("eventsub:channel.cheer:session-1-msg");
  expect(normalizeEventSub(session2)!.sourceId).toBe("eventsub:channel.cheer:session-2-msg"); // a repeat cheer under a new id is its own Contribution
  expect(normalizeEventSub(redelivery)!.sourceId).toBe("eventsub:channel.cheer:session-1-msg"); // at-least-once redelivery: same id, same key
  expect(eventFingerprint(session1)).toBe(eventFingerprint(session2)); // the cross-session dedupe sees one event
});

test("eventFingerprint: eventsub:<subscription_type>:<sha256 of the sorted-key event>; message id and timestamp never take part", () => {
  const event = { ...user, is_anonymous: false, message: "cheer1000", bits: 1000 };
  const fp = eventFingerprint(notification("channel.cheer", event));
  expect(fp).toMatch(/^eventsub:channel\.cheer:[0-9a-f]{64}$/);
  const other = notification("channel.cheer", event, { message_id: "other-session", message_timestamp: "2026-09-12T20:36:00.000Z" });
  expect(eventFingerprint(other)).toBe(fp);
  expect(eventFingerprint(notification("channel.cheer", { ...event, bits: 1001 }))).not.toBe(fp);
});

test("eventFingerprint: hashes the event with keys sorted recursively, so key order never matters", () => {
  const a = eventFingerprint(notification("channel.bits.use", { bits: 100, type: "power_up", power_up: { emote: null, type: "celebration" }, message: { fragments: [], text: "" }, ...user }));
  const b = eventFingerprint(notification("channel.bits.use", { ...user, message: { text: "", fragments: [] }, power_up: { type: "celebration", emote: null }, type: "power_up", bits: 100 }));
  expect(a).toBe(b);
});

test("twitchUserId: the event's user_id rides along — null when the cheer or gift is anonymous; bits.use and the sub events always carry it; the gift's is the gifter's", () => {
  const id = (type: string, event: Record<string, unknown>) => normalizeEventSub(notification(type, event))?.twitchUserId;
  expect(id("channel.cheer", { ...user, is_anonymous: false, message: "cheer100", bits: 100 })).toBe("1234");
  expect(id("channel.cheer", { ...nobody, is_anonymous: true, message: "cheer100", bits: 100 })).toBeNull();
  expect(id("channel.bits.use", { ...user, bits: 100, type: "power_up", power_up: { type: "celebration", emote: null }, message: null })).toBe("1234");
  expect(id("channel.subscribe", { ...user, tier: "1000", is_gift: false })).toBe("1234");
  expect(id("channel.subscription.message", { ...user, tier: "1000", message: { text: "hi", emotes: [] }, cumulative_months: 2, streak_months: null, duration_months: 1 })).toBe("1234");
  expect(id("channel.subscription.gift", { ...user, total: 5, tier: "1000", cumulative_total: 5, is_anonymous: false })).toBe("1234"); // the gifter's user_* fields
  expect(id("channel.subscription.gift", { ...nobody, total: 5, tier: "1000", cumulative_total: null, is_anonymous: true })).toBeNull();
  // an event that somehow names a user without an id: unknown, never the string "undefined"
  const noId = normalizeEventSub(notification("channel.cheer", { user_id: undefined, user_login: "cool_user", user_name: "Cool_User", is_anonymous: false, message: "x", bits: 1 }))!;
  expect(noId.twitchUserId).toBeNull();
  expect("loginHint" in noId).toBe(false); // the Twitch lane never guesses from a name: the id is authoritative, absent means unknown
});

test("describeEvent names a chatter by chatter_user_name and never quotes the message text", () => {
  const line = describeEvent(notification("channel.chat.message", { chatter_user_id: "1234", chatter_user_login: "cool_user", chatter_user_name: "Cool_User", message_id: "u1", message_type: "text", message: { text: "secret text", fragments: [] } }));
  expect(line).toBe("channel.chat.message from Cool_User at 2026-09-12T20:31:12.464757833Z");
});

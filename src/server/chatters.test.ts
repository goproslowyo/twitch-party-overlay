import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, type Config } from "../config/schema.ts";
import type { HelixUser } from "../ingest/twitch/helix.ts";
import { AvatarCache, FIRST_SIGHT_WAIT_MS } from "./avatars.ts";
import { ChatterRoster, FAKE_NAMES, FAKE_PICTURE_URL, FIRST_SIGHT_BATCH_MS, type ChatMessageEvent } from "./chatters.ts";
import { chatterKey } from "./overlay.ts";

const CDN = "https://static-cdn.jtvnw.net/jtv_user_pictures";
const pic300 = (uuid: string) => `${CDN}/${uuid}-profile_image-300x300.png`;
const pic150 = (uuid: string) => `${CDN}/${uuid}-profile_image-150x150.png`;

/** The avatars.test.ts Helix double: `users` is the directory; `hold()` parks every lookup until `release()`; `fail` makes them throw. */
function fakeHelix(users: HelixUser[] = []) {
  const calls: Array<{ kind: "id" | "login"; values: string[] }> = [];
  const parked: Array<() => void> = [];
  const f = {
    calls,
    holding: false,
    fail: null as Error | null,
    hold() {
      f.holding = true;
    },
    release() {
      f.holding = false;
      for (const go of parked.splice(0)) go();
    },
    async lookup(kind: "id" | "login", values: string[]): Promise<HelixUser[]> {
      calls.push({ kind, values });
      if (f.holding) await new Promise<void>((resolve) => parked.push(resolve));
      if (f.fail !== null) throw f.fail;
      return users.filter((u) => values.includes(kind === "id" ? u.id : u.login.toLowerCase()));
    },
    usersByIds: (ids: readonly string[]) => f.lookup("id", [...ids]),
    usersByLogins: (logins: readonly string[]) => f.lookup("login", [...logins]),
  };
  return f;
}

/** The avatars.test.ts clock: `wait(ms)` resolves when `advance` carries the clock past it; every settled promise then runs. */
function clock(startMs = 1_000_000) {
  let now = startMs;
  const timers: Array<{ at: number; fire: () => void }> = [];
  return {
    now: () => now,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: now + ms, fire: resolve });
      }),
    async advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.fire();
        else timers.push(t);
      }
      await flush();
    },
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const alice: HelixUser = { id: "1", login: "alice", profileImageUrl: pic300("aaaa") };
const bob: HelixUser = { id: "2", login: "bob", profileImageUrl: pic300("bbbb") };
const carol: HelixUser = { id: "3", login: "carol", profileImageUrl: pic300("cccc") };

function mk(users: HelixUser[] = [alice, bob, carol], edit?: (c: Config) => void) {
  const helix = fakeHelix(users);
  const c = clock();
  const config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  edit?.(config);
  const cache = new AvatarCache(helix, { now: c.now, wait: c.wait, warn: () => {} });
  const hops: string[] = [];
  const logs: string[] = [];
  let changes = 0;
  const roster = new ChatterRoster({
    config: () => config,
    avatars: cache,
    now: c.now,
    wait: c.wait,
    rng: () => 0,
    onChange: () => void changes++,
    onHop: (key) => void hops.push(key),
    log: (line) => void logs.push(line),
  });
  return { helix, clock: c, config, cache, roster, hops, logs, changes: () => changes };
}

const msg = (id: string, login: string, name = login, over: Partial<ChatMessageEvent> = {}): ChatMessageEvent => ({ chatter_user_id: id, chatter_user_login: login, chatter_user_name: name, broadcaster_user_id: "100", source_broadcaster_user_id: null, ...over });

test("constants: a 500 ms first-sight batch; the fake picture is the stock default at 150x150", () => {
  expect(FIRST_SIGHT_BATCH_MS).toBe(500);
  expect(FAKE_PICTURE_URL).toBe("https://static-cdn.jtvnw.net/user-default-pictures-uv/ce57700a-def9-11e9-842d-784f43822e80-profile_image-150x150.png");
  expect(FAKE_NAMES).toHaveLength(10);
  expect(new Set(FAKE_NAMES).size).toBe(10);
});

test("first sights: nothing goes out until the batch; two new people within 500 ms → ONE usersByIds call with both ids, then one onChange with both pictures, most recent first; a later message from one of them → onHop(key), lastSeen refreshed, re-sorted (one more onChange), no new call", async () => {
  const { helix, clock, roster, hops, changes, logs } = mk();
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(200);
  roster.message(msg("2", "bob", "Bob"));
  expect(helix.calls).toEqual([]);
  expect(changes()).toBe(0);
  expect(hops).toEqual([]);
  expect(roster.count()).toBe(2); // on the roster already; the wire hears when the pictures do
  await clock.advance(300); // 500 ms after the first sight: the batch goes out
  expect(helix.calls).toEqual([{ kind: "id", values: ["1", "2"] }]);
  expect(changes()).toBe(1);
  expect(roster.list()).toEqual([
    { key: chatterKey("2"), name: "Bob", avatarUrl: pic150("bbbb"), firstSeenMs: 1_000_200, lastSeenMs: 1_000_200 },
    { key: chatterKey("1"), name: "Alice", avatarUrl: pic150("aaaa"), firstSeenMs: 1_000_000, lastSeenMs: 1_000_000 },
  ]);
  expect(logs).toEqual(["chatters: 2 new, 2 with a picture"]);

  await clock.advance(1000);
  roster.message(msg("1", "alice", "Alice"));
  expect(hops).toEqual([chatterKey("1")]);
  expect(changes()).toBe(2);
  expect(roster.list().map((c) => [c.name, c.lastSeenMs, c.firstSeenMs])).toEqual([
    ["Alice", 1_001_500, 1_000_000],
    ["Bob", 1_000_200, 1_000_200],
  ]);
  expect(helix.calls).toHaveLength(1);
});

test("a third person arriving after the batch went out starts a new batch of their own", async () => {
  const { helix, clock, roster, changes } = mk();
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(500);
  expect(helix.calls).toEqual([{ kind: "id", values: ["1"] }]);
  roster.message(msg("3", "carol", "Carol"));
  await clock.advance(499);
  expect(helix.calls).toHaveLength(1);
  await clock.advance(1);
  expect(helix.calls).toEqual([
    { kind: "id", values: ["1"] },
    { kind: "id", values: ["3"] },
  ]);
  expect(changes()).toBe(2);
});

test("a slow picture lookup: the batch goes out with avatarUrl null 500 ms after the call, then again with the picture when it lands", async () => {
  const { helix, clock, roster, changes } = mk();
  helix.hold();
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(FIRST_SIGHT_BATCH_MS);
  expect(helix.calls).toHaveLength(1);
  expect(changes()).toBe(0);
  await clock.advance(FIRST_SIGHT_WAIT_MS - 1);
  expect(changes()).toBe(0);
  await clock.advance(1);
  expect(changes()).toBe(1);
  expect(roster.list()).toEqual([{ key: chatterKey("1"), name: "Alice", avatarUrl: null, firstSeenMs: 1_000_000, lastSeenMs: 1_000_000 }]);
  helix.release();
  await flush();
  expect(changes()).toBe(2);
  expect(roster.list()[0]!.avatarUrl).toBe(pic150("aaaa"));
});

test("a picture the cache already has (a contributor seen before): onChange at once, no call, no batch", async () => {
  const { helix, cache, clock, roster, changes } = mk();
  await cache.urlFor({ twitchUserId: "1" });
  expect(helix.calls).toHaveLength(1);
  roster.message(msg("1", "alice", "Alice"));
  expect(changes()).toBe(1);
  expect(roster.list()[0]!.avatarUrl).toBe(pic150("aaaa"));
  await clock.advance(1000);
  expect(helix.calls).toHaveLength(1);
  expect(changes()).toBe(1);
});

test("Helix down: the batch goes out with null pictures and the roster is otherwise whole", async () => {
  const { helix, clock, roster, changes } = mk();
  helix.fail = new Error("Helix GET users → 503");
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(500);
  expect(changes()).toBe(1);
  expect(roster.list()[0]).toMatchObject({ name: "Alice", avatarUrl: null });
});

test("excluded: the broadcaster's own id (config's, or the event's broadcaster_user_id) and any login on the Chat Bot list whatever the case; a name added to the list between two messages takes effect on the next (config is read live)", async () => {
  const { config, clock, roster, hops, changes } = mk();
  roster.message(msg("100", "dj", "DJ Example"));
  roster.message(msg("555", "other_dj", "Other DJ", { broadcaster_user_id: "555" }));
  roster.message(msg("7", "NightBot", "Nightbot"));
  roster.message(msg("8", "STREAMELEMENTS", "StreamElements"));
  roster.message(msg("9", "StreamDJBot", "StreamDJBot"));
  expect(roster.count()).toBe(0);

  roster.message(msg("10", "helperbot", "HelperBot"));
  expect(roster.count()).toBe(1);
  await clock.advance(500);
  expect(changes()).toBe(1);
  config.chatters.bots.push("helperbot", "otherbot"); // the Config page saved two new lines (stored lower-cased)
  roster.message(msg("10", "helperbot", "HelperBot")); // present, but a bot now: no hop, no refresh; it lapses on its own
  roster.message(msg("11", "OtherBot", "OtherBot"));
  expect(hops).toEqual([]);
  expect(roster.count()).toBe(1);
  expect(roster.list()[0]!.lastSeenMs).toBe(1_000_000);
  expect(changes()).toBe(1);
});

test("shared-chat guests (non-null source_broadcaster_user_id) count, and so do mods", async () => {
  const { clock, roster } = mk();
  roster.message(msg("3", "carol", "Carol", { source_broadcaster_user_id: "999" }));
  await clock.advance(500);
  expect(roster.list().map((c) => c.name)).toEqual(["Carol"]);
});

test("a message with no usable id is ignored", () => {
  const { roster } = mk();
  roster.message(msg("", "ghost", "Ghost"));
  expect(roster.count()).toBe(0);
});

test("window lapse: a 5 minute Chat Window; sweep at 4:59.999 keeps the dancer, at 5:00 drops them with one onChange; a sweep with nothing to drop is silent; a message resets the clock", async () => {
  const { clock, roster, changes } = mk([alice], (c) => void (c.chatters.windowMinutes = 5));
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(500);
  expect(changes()).toBe(1);
  await clock.advance(5 * 60_000 - 500 - 1); // 4:59.999 after the message
  roster.sweep();
  expect(roster.count()).toBe(1);
  expect(changes()).toBe(1);
  await clock.advance(1); // 5:00
  roster.sweep();
  expect(roster.count()).toBe(0);
  expect(changes()).toBe(2);
  roster.sweep();
  expect(changes()).toBe(2);

  roster.message(msg("1", "alice", "Alice")); // back: a first sight again (the picture is cached, so at once)
  expect(changes()).toBe(3);
  await clock.advance(4 * 60_000);
  roster.message(msg("1", "alice", "Alice")); // 4:00 in: the clock restarts
  await clock.advance(4 * 60_000);
  roster.sweep();
  expect(roster.count()).toBe(1);
  await clock.advance(60_000);
  roster.sweep();
  expect(roster.count()).toBe(0);
});

test("fake(): a made-up person with the stock default picture is on the floor at once (one onChange, no Helix); repeat calls add more distinct people; fakes lapse like anyone", async () => {
  const { helix, clock, roster, changes } = mk([]);
  const a = roster.fake();
  expect(a).toEqual({ key: chatterKey("fake:1"), name: "Pixel_Pat", avatarUrl: FAKE_PICTURE_URL, firstSeenMs: 1_000_000, lastSeenMs: 1_000_000 });
  expect(changes()).toBe(1);
  const b = roster.fake();
  expect(b.key).not.toBe(a.key);
  expect(b.name).not.toBe(a.name);
  expect(roster.count()).toBe(2);
  expect(helix.calls).toEqual([]);
  for (let i = 0; i < 12; i++) roster.fake();
  expect(roster.count()).toBe(14);
  expect(new Set(roster.list().map((c) => c.name)).size).toBe(14);
  expect(new Set(roster.list().map((c) => c.key)).size).toBe(14);
  await clock.advance(15 * 60_000);
  roster.sweep();
  expect(roster.count()).toBe(0);
});

test("hopRandom(): null with nobody there; else one person on the floor (fake or real) is hopped, their lastSeen refreshed, the list re-sorted", async () => {
  const { clock, roster, hops, changes } = mk(); // rng () => 0: the first entry in insertion order
  expect(roster.hopRandom()).toBeNull();
  expect(hops).toEqual([]);
  const f = roster.fake();
  roster.message(msg("1", "alice", "Alice"));
  await clock.advance(500);
  expect(roster.list().map((c) => c.name)).toEqual(["Alice", "Pixel_Pat"]);
  await clock.advance(1000);
  const before = changes();
  expect(roster.hopRandom()).toEqual({ ...f, lastSeenMs: 1_001_500 });
  expect(hops).toEqual([f.key]);
  expect(changes()).toBe(before + 1);
  expect(roster.list().map((c) => c.name)).toEqual(["Pixel_Pat", "Alice"]);
});

test("the wire shape: list() carries key/name/avatarUrl/firstSeenMs/lastSeenMs only — never the Twitch id or login", async () => {
  const { clock, roster } = mk([{ id: "424242", login: "secret_login", profileImageUrl: pic300("s") }]);
  roster.message(msg("424242", "secret_login", "Shown Name"));
  await clock.advance(500);
  expect(Object.keys(roster.list()[0]!).sort()).toEqual(["avatarUrl", "firstSeenMs", "key", "lastSeenMs", "name"]);
  expect(JSON.stringify(roster.list())).not.toMatch(/424242|secret_login|chatter_user/);
});

test("a throwing onChange or onHop is logged and never breaks the roster", async () => {
  const helix = fakeHelix([alice]);
  const c = clock();
  const config = defaultConfig();
  const logs: string[] = [];
  const roster = new ChatterRoster({
    config: () => config,
    avatars: new AvatarCache(helix, { now: c.now, wait: c.wait, warn: () => {} }),
    now: c.now,
    wait: c.wait,
    onChange: () => {
      throw new Error("change blew up");
    },
    onHop: () => {
      throw new Error("hop blew up");
    },
    log: (line) => void logs.push(line),
  });
  roster.message(msg("1", "alice", "Alice"));
  await c.advance(500);
  roster.message(msg("1", "alice", "Alice"));
  expect(roster.count()).toBe(1);
  expect(logs.filter((l) => l.includes("threw"))).toEqual(["chatters: onChange threw: change blew up", "chatters: onHop threw: hop blew up", "chatters: onChange threw: change blew up"]);
});

test("presence, never Progress: the roster module imports nothing from the Ledger or the Engine", () => {
  const src = readFileSync(path.join(import.meta.dir, "chatters.ts"), "utf8");
  expect(src).not.toMatch(/from "\.\.\/(ledger|engine)\//);
  expect(src).not.toMatch(/\bledger\b|\bEngine\b/);
});

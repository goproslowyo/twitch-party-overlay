import { expect, test } from "bun:test";
import type { HelixUser } from "../ingest/twitch/helix.ts";
import { AVATAR_MAX, AVATAR_SIZE, AVATAR_TTL_MS, AVATAR_WARN_EVERY_MS, AvatarCache, FIRST_SIGHT_WAIT_MS, toSized } from "./avatars.ts";

const CDN = "https://static-cdn.jtvnw.net/jtv_user_pictures";
const pic300 = (uuid: string, ext = "png") => `${CDN}/${uuid}-profile_image-300x300.${ext}`;
const pic150 = (uuid: string, ext = "png") => `${CDN}/${uuid}-profile_image-150x150.${ext}`;
const DEFAULT_300 = "https://static-cdn.jtvnw.net/user-default-pictures-uv/ce57700a-def9-11e9-842d-784f43822e80-profile_image-300x300.png";

/** A Helix double: `users` is the directory; `hold()` parks every lookup until `release()`; `fail` makes them throw. */
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

/** A clock and a `wait` the test advances by hand: `wait(ms)` resolves when `advance` carries the clock past it. */
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

/** Let every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const alice: HelixUser = { id: "1", login: "alice", profileImageUrl: pic300("aaaa") };
const styler: HelixUser = { id: "2", login: "styler", profileImageUrl: pic300("ssss", "jpg") };
const blank: HelixUser = { id: "3", login: "newuser2026", profileImageUrl: DEFAULT_300 };

function mk(users: HelixUser[] = [alice, styler, blank], opts: { max?: number } = {}) {
  const helix = fakeHelix(users);
  const c = clock();
  const warnings: string[] = [];
  const cache = new AvatarCache(helix, { now: c.now, wait: c.wait, warn: (line) => void warnings.push(line), ...opts });
  return { helix, clock: c, warnings, cache };
}

test("constants: 24 h TTL, 2,000 entries, 500 ms first-sight wait, the 150x150 variant, one warning a minute", () => {
  expect(AVATAR_TTL_MS).toBe(24 * 3_600_000);
  expect(AVATAR_MAX).toBe(2_000);
  expect(FIRST_SIGHT_WAIT_MS).toBe(500);
  expect(AVATAR_SIZE).toBe("150x150");
  expect(AVATAR_WARN_EVERY_MS).toBe(60_000);
});

test("toSized: rewrites Twitch's -300x300. to -150x150. (png or jpg, user or stock default picture); another size on request; a URL without the marker is returned unchanged", () => {
  expect(toSized(pic300("aaaa"))).toBe(pic150("aaaa"));
  expect(toSized(pic300("ssss", "jpg"))).toBe(pic150("ssss", "jpg"));
  expect(toSized(DEFAULT_300)).toBe(DEFAULT_300.replace("-300x300.", "-150x150."));
  expect(toSized(pic300("aaaa"), "70x70")).toBe(`${CDN}/aaaa-profile_image-70x70.png`);
  expect(toSized("https://example.com/whatever.png")).toBe("https://example.com/whatever.png");
  expect(toSized(pic300("300x300-in-the-uuid"))).toBe(pic150("300x300-in-the-uuid")); // only the size marker before the extension moves
});

test("first sight of an id: one usersByIds call, the 150x150 URL; from then on the cache answers — peek is synchronous and urlFor makes no call", async () => {
  const { helix, cache } = mk();
  expect(cache.peek({ twitchUserId: "1" })).toBeNull();
  expect(cache.cached({ twitchUserId: "1" })).toBeUndefined();

  expect(await cache.urlFor({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(helix.calls).toEqual([{ kind: "id", values: ["1"] }]);

  expect(cache.peek({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(cache.cached({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(await cache.urlFor({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(await cache.urlFor({ twitchUserId: "1", loginHint: "ignored" })).toBe(pic150("aaaa"));
  expect(helix.calls).toHaveLength(1);
});

test("a slow lookup: urlFor gives up with null at FIRST_SIGHT_WAIT_MS, the lookup keeps running and fills the cache, so peek finds the URL afterwards", async () => {
  const { helix, clock, cache } = mk();
  helix.hold();
  let settled: string | null | undefined;
  void cache.urlFor({ twitchUserId: "1" }).then((v) => (settled = v));
  await clock.advance(FIRST_SIGHT_WAIT_MS - 1);
  expect(settled).toBeUndefined();
  await clock.advance(1);
  expect(settled).toBeNull();
  expect(cache.peek({ twitchUserId: "1" })).toBeNull();

  helix.release();
  await flush();
  expect(cache.peek({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(await cache.urlFor({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(helix.calls).toHaveLength(1);
});

test("concurrent first sights of one contributor share a single lookup", async () => {
  const { helix, cache } = mk();
  helix.hold();
  const a = cache.urlFor({ twitchUserId: "1" });
  const b = cache.urlFor({ twitchUserId: "1" });
  expect(helix.calls).toHaveLength(1);
  helix.release();
  expect(await Promise.all([a, b])).toEqual([pic150("aaaa"), pic150("aaaa")]);
});

test("a login hint (no id): one usersByLogins call; the answer is cached under the login and the id, so the same person by id later costs nothing", async () => {
  const { helix, cache } = mk();
  expect(await cache.urlFor({ loginHint: "Styler" })).toBe(pic150("ssss", "jpg"));
  expect(helix.calls).toEqual([{ kind: "login", values: ["styler"] }]);
  expect(cache.peek({ twitchUserId: "2" })).toBe(pic150("ssss", "jpg"));
  expect(cache.peek({ loginHint: "STYLER" })).toBe(pic150("ssss", "jpg"));
  expect(await cache.urlFor({ twitchUserId: "2" })).toBe(pic150("ssss", "jpg"));
  expect(helix.calls).toHaveLength(1);
});

test("nothing to look up: anonymous (id null, no hint), an empty id, or no ref at all → null at once, no call", async () => {
  const { helix, cache } = mk();
  for (const ref of [{}, { twitchUserId: null }, { twitchUserId: null, loginHint: null }, { twitchUserId: "" }, { loginHint: "" }, null, undefined]) {
    expect(await cache.urlFor(ref)).toBeNull();
    expect(cache.peek(ref)).toBeNull();
  }
  expect(helix.calls).toHaveLength(0);
});

test("a stock default picture (user-default-pictures-uv) is a picture like any other", async () => {
  const { cache } = mk();
  expect(await cache.urlFor({ twitchUserId: "3" })).toBe(DEFAULT_300.replace("-300x300.", "-150x150."));
});

test("an id Twitch does not know: null, remembered as 'no picture' so the next contribution from it costs no call; a hint that finds nobody likewise", async () => {
  const { helix, cache } = mk();
  expect(await cache.urlFor({ twitchUserId: "404" })).toBeNull();
  expect(cache.cached({ twitchUserId: "404" })).toBeNull(); // known, none — not undefined
  expect(await cache.urlFor({ twitchUserId: "404" })).toBeNull();
  expect(await cache.urlFor({ loginHint: "nobody_here" })).toBeNull();
  expect(await cache.urlFor({ loginHint: "nobody_here" })).toBeNull();
  expect(helix.calls).toEqual([
    { kind: "id", values: ["404"] },
    { kind: "login", values: ["nobody_here"] },
  ]);
});

test("TTL: an entry older than 24 h is gone — peek null, cached undefined, the next urlFor looks it up again (a viewer may have changed their picture)", async () => {
  const { helix, clock, cache } = mk();
  await cache.urlFor({ twitchUserId: "1" });
  await clock.advance(AVATAR_TTL_MS - 1);
  expect(cache.peek({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  await clock.advance(1);
  expect(cache.peek({ twitchUserId: "1" })).toBeNull();
  expect(cache.cached({ twitchUserId: "1" })).toBeUndefined();
  expect(await cache.urlFor({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(helix.calls).toHaveLength(2);
});

test("LRU cap: past `max` entries the least recently used goes first; a peek counts as use", async () => {
  const users = Array.from({ length: 6 }, (_, i): HelixUser => ({ id: `u${i}`, login: `login${i}`, profileImageUrl: pic300(`uuid${i}`) }));
  const { helix, cache } = mk(users, { max: 4 });
  for (const id of ["u0", "u1", "u2"]) await cache.urlFor({ twitchUserId: id }); // each lookup writes id + login = 2 entries
  expect(cache.size).toBe(4); // u0's pair fell out
  expect(cache.cached({ twitchUserId: "u0" })).toBeUndefined();
  expect(cache.peek({ twitchUserId: "u1" })).toBe(pic150("uuid1")); // touched: now the newest
  await cache.urlFor({ twitchUserId: "u3" });
  expect(cache.size).toBe(4);
  expect(cache.peek({ twitchUserId: "u1" })).toBe(pic150("uuid1"));
  // the two least recently used went: the login entries of u1 and u2 (a lookup's own read makes its id entry the newest)
  expect(cache.cached({ loginHint: "login1" })).toBeUndefined();
  expect(cache.cached({ loginHint: "login2" })).toBeUndefined();
  expect(cache.cached({ twitchUserId: "u2" })).toBe(pic150("uuid2"));
  expect(helix.calls).toHaveLength(4);

  const wide = new AvatarCache(helix, { now: () => 0, wait: () => new Promise(() => {}) });
  expect(wide.max).toBe(AVATAR_MAX);
});

test("Helix failing: null, nothing cached (the next sighting tries again), and one warning line per minute at most — never more", async () => {
  const { helix, clock, warnings, cache } = mk();
  helix.fail = new Error("Helix GET users → 503");
  expect(await cache.urlFor({ twitchUserId: "1" })).toBeNull();
  expect(cache.cached({ twitchUserId: "1" })).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("503");
  expect(warnings[0]).not.toMatch(/token|secret/i);

  expect(await cache.urlFor({ twitchUserId: "1" })).toBeNull();
  expect(await cache.urlFor({ loginHint: "styler" })).toBeNull();
  await clock.advance(AVATAR_WARN_EVERY_MS - 1);
  expect(await cache.urlFor({ twitchUserId: "2" })).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(helix.calls).toHaveLength(4); // every sighting tried

  await clock.advance(1);
  expect(await cache.urlFor({ twitchUserId: "1" })).toBeNull();
  expect(warnings).toHaveLength(2);

  helix.fail = null; // Helix is back: the next sighting resolves, nothing to clear, no banner anywhere
  expect(await cache.urlFor({ twitchUserId: "1" })).toBe(pic150("aaaa"));
  expect(warnings).toHaveLength(2);
});

test("a failure that lands after the 500 ms wait is still silent to the caller (already null) and is the one warning", async () => {
  const { helix, clock, warnings, cache } = mk();
  helix.hold();
  helix.fail = new Error("Helix GET users → 500");
  let settled: string | null | undefined;
  void cache.urlFor({ twitchUserId: "1" }).then((v) => (settled = v));
  await clock.advance(FIRST_SIGHT_WAIT_MS);
  expect(settled).toBeNull();
  expect(warnings).toHaveLength(0);
  helix.release();
  await flush();
  expect(warnings).toHaveLength(1);
  expect(cache.cached({ twitchUserId: "1" })).toBeUndefined();
});

test("the default wait is a real timer: without a `wait` option a parked lookup gives null in about 500 ms", async () => {
  const helix = fakeHelix([alice]);
  helix.hold();
  const cache = new AvatarCache(helix, { warn: () => undefined });
  const t0 = performance.now();
  expect(await cache.urlFor({ twitchUserId: "1" })).toBeNull();
  const elapsed = performance.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(FIRST_SIGHT_WAIT_MS - 20);
  expect(elapsed).toBeLessThan(FIRST_SIGHT_WAIT_MS + 400);
  helix.release();
  await flush();
  expect(cache.peek({ twitchUserId: "1" })).toBe(pic150("aaaa"));
});

test("a login hint that itself carries a colon reaches Helix whole (the cache key splits on the first colon only)", async () => {
  const { helix, cache } = mk();
  await cache.urlFor({ loginHint: "odd:name" });
  expect(helix.calls).toEqual([{ kind: "login", values: ["odd:name"] }]);
});

test("urlsFor (Chatter Dancers): three unseen ids → exactly one usersByIds call with all three, written under id and login like a single lookup; an unknown id is null and remembered; cached ids make no call; blanks and repeats are dropped", async () => {
  const { helix, cache } = mk();
  const first = await cache.urlsFor(["1", "2", "404"]);
  expect(helix.calls).toEqual([{ kind: "id", values: ["1", "2", "404"] }]);
  expect([...first.entries()]).toEqual([
    ["1", pic150("aaaa")],
    ["2", pic150("ssss", "jpg")],
    ["404", null],
  ]);
  expect(cache.cached({ twitchUserId: "404" })).toBeNull(); // known, none
  expect(cache.peek({ loginHint: "alice" })).toBe(pic150("aaaa"));

  const again = await cache.urlsFor(["404", "3", "1", "2"]);
  expect(helix.calls).toEqual([
    { kind: "id", values: ["1", "2", "404"] },
    { kind: "id", values: ["3"] }, // only the one nobody has seen
  ]);
  expect([...again.keys()]).toEqual(["404", "1", "2", "3"]); // cached first, then the looked-up
  expect(again.get("3")).toBe(DEFAULT_300.replace("-300x300.", "-150x150."));

  expect([...(await cache.urlsFor(["1", "1", ""])).entries()]).toEqual([["1", pic150("aaaa")]]);
  expect(await cache.urlsFor([])).toEqual(new Map());
  expect(helix.calls).toHaveLength(2);
});

test("urlsFor with Helix failing: null for every uncached id, nothing cached (the next burst tries again), the throttled warning once", async () => {
  const { helix, warnings, cache } = mk();
  await cache.urlFor({ twitchUserId: "1" });
  helix.fail = new Error("Helix GET users → 503");
  const out = await cache.urlsFor(["1", "2", "3"]);
  expect([...out.entries()]).toEqual([
    ["1", pic150("aaaa")],
    ["2", null],
    ["3", null],
  ]);
  expect(cache.cached({ twitchUserId: "2" })).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("503");
  helix.fail = null;
  expect((await cache.urlsFor(["2"])).get("2")).toBe(pic150("ssss", "jpg"));
  expect(helix.calls).toHaveLength(3);
});

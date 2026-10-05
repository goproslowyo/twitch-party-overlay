import { test, expect } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { Contribution } from "../ingest/contribution.ts";
import { Ledger } from "../ledger/ledger.ts";
import { notFound } from "./http-util.ts";
import { startListeners } from "./listeners.ts";
import { Health, OVERLAY_QUALITY_HEALTH_ID } from "./health.ts";
import { AvatarCache } from "./avatars.ts";
import { LOCKED_GLYPH, OverlayHub, avatarFor, chatterKey, fnv1a, moteWireKey, type Chatter, type ChatterSource, type OverlayMessage, type OverlayOutcome, type OverlayReport } from "./overlay.ts";
import { overlayRoutes } from "./overlay-page.ts";
import atlas from "../overlay/art/chrome-lounge.json";

const A = "system:test";
/** The boot writes one `threshold` entry and one `stock` seed per Outcome before anything else lands. */
const BOOT_SEEDS = 1 + defaultConfig().outcomes.length;

function mk(edit?: (c: Config) => void) {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  edit?.(config);
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const hub = new OverlayHub(engine, () => config);
  const msgs: OverlayMessage[] = [];
  const ws = {
    send: (s: string) => {
      msgs.push(JSON.parse(s) as OverlayMessage);
    },
  };
  hub.attach(ws);
  const theme = config.themes[config.overlay.theme]!;
  return { ledger, config, engine, hub, msgs, ws, theme };
}

let n = 0;
function contribution(face: Contribution["face"], displayName: string | null = "alice"): Contribution {
  return { source: "manual", sourceId: `manual:t${++n}`, face, displayName, anonymous: displayName === null, occurredAt: "2026-09-12T20:00:00.000Z" };
}
const tip = (cents: number, displayName: string | null = "alice") => contribution({ kind: "tip", cents }, displayName);
const last = (msgs: OverlayMessage[]) => msgs[msgs.length - 1]!;
const byId = (outcomes: OverlayOutcome[], id: string) => outcomes.find((o) => o.id === id)!;

test("fnv1a: 32-bit FNV-1a over UTF-8 bytes (reference vectors); avatarFor indexes theme.avatars by it and hashes anonymous as 'anonymous'", () => {
  expect(fnv1a("")).toBe(0x811c9dc5);
  expect(fnv1a("a")).toBe(0xe40c292c);
  expect(fnv1a("foobar")).toBe(0xbf9cf968);
  expect(fnv1a("alice")).toBe(fnv1a("alice"));
  expect(fnv1a("alice")).not.toBe(fnv1a("Alice"));

  const { theme } = mk();
  expect(theme.avatars).toHaveLength(8);
  expect(avatarFor("alice", theme)).toBe(theme.avatars[fnv1a("alice") % 8]!);
  expect(avatarFor(null, theme)).toBe(theme.avatars[fnv1a("anonymous") % 8]!);
  expect(avatarFor(null, theme)).toBe(avatarFor("anonymous", theme));
  expect(avatarFor("alice", { ...theme, avatars: [] })).toBe("");
});

test("attach sends a snapshot: outcomes above the open tier are masked (name null, 🔒, nameLength), no cabin, empty motes, skin from config", () => {
  const { msgs, config, theme } = mk();
  expect(msgs).toHaveLength(1);
  const snap = msgs[0]!;
  if (snap.type !== "snapshot") throw new Error(`expected snapshot, got ${snap.type}`);
  expect(snap.state).toMatchObject({ thresholdCents: 5000, progressCents: 0, queue: 0, bankedTotal: 0, tier: 0, gates: [0, 3, 6], drained: false, motes: { collecting: [], ready: [] } });
  expect("cabin" in snap.state).toBe(false);
  expect(snap.state.outcomes).toHaveLength(config.outcomes.length);

  const stickers = byId(snap.state.outcomes, "stickers");
  expect(stickers).toEqual({ id: "stickers", name: "STICKERS", nameLength: 8, glyph: "🎟️", shape: "giveaway", tier: 0, left: 5, used: 0, status: "live" });
  const roulette = byId(snap.state.outcomes, "genre-roulette");
  expect(roulette).toEqual({ id: "genre-roulette", name: null, nameLength: "GENRE ROULETTE".length, glyph: LOCKED_GLYPH, shape: "challenge", tier: 1, left: 1, used: 0, status: "live" });
  expect(byId(snap.state.outcomes, "pie-to-the-face").name).toBeNull();
  // the overlay never learns a locked name — nor the mini-draw list / raffle flag / occupancy of any outcome
  expect(JSON.stringify(snap.state)).not.toContain("PIE TO THE FACE");
  for (const o of snap.state.outcomes) expect(Object.keys(o).sort()).toEqual(["glyph", "id", "left", "name", "nameLength", "shape", "status", "tier", "used"]);

  expect(snap.skin).toEqual({ config: config.overlay, theme, channelName: "DJ Example", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });
  expect(snap.chatters).toEqual([]);
});

test("contribution events → contribution messages with avatar (avatarUrl null), face value, credited cents and the post-state; no cabin travels", () => {
  const { engine, msgs, theme } = mk();
  engine.contribute(tip(5000, "alice"), A);
  expect(msgs).toHaveLength(2);
  const m = last(msgs);
  expect(m).toEqual({
    type: "contribution",
    source: "manual",
    displayName: "alice",
    anonymous: false,
    avatar: avatarFor("alice", theme),
    avatarUrl: null,
    face: { kind: "tip", cents: 5000 },
    faceValueCents: 5000,
    progressCents: 5000,
    unlocksBanked: 1,
    tiersOpened: [],
    state: expect.objectContaining({ progressCents: 0, queue: 1, bankedTotal: 1, motes: { collecting: [], ready: [[{ key: moteWireKey("alice"), name: "alice", avatar: avatarFor("alice", theme), avatarUrl: null, cents: 5000 }]] } }),
  });
  if (m.type !== "contribution") throw new Error(m.type);
  expect("cabin" in m.state).toBe(false);

  engine.contribute(contribution({ kind: "gift", tier: "1000", count: 25 }, null), A); // $50 progress, $149.75 face
  const anon = last(msgs);
  if (anon.type !== "contribution") throw new Error(anon.type);
  expect(anon).toMatchObject({ displayName: null, anonymous: true, avatar: avatarFor(null, theme), faceValueCents: 25 * 599, progressCents: 5000, unlocksBanked: 1 });
  expect(anon.avatarUrl).toBeNull();
  expect(anon.state.queue).toBe(2);
  // nobody is named FOR an Unlock: the state carries no owner / solo / contributor field — only the Mote lists (a Mote's
  // `name` is for its glyph and picture), and an anonymous gift bomb is one blank Mote
  expect(anon.state.motes.ready).toEqual([[{ key: moteWireKey("alice"), name: "alice", avatar: avatarFor("alice", theme), avatarUrl: null, cents: 5000 }], [{ key: moteWireKey(`anon:${BOOT_SEEDS + 3}`), name: null, avatar: "", avatarUrl: null, cents: 5000 }]]); // the boot seeds, alice, her unlock, then this
  expect(Object.keys(anon.state).sort()).toEqual(["bankedTotal", "drained", "gates", "motes", "outcomes", "progressCents", "queue", "thresholdCents", "tier"]);
  expect(JSON.stringify(anon.state)).not.toMatch(/solo|owner|contributor|twitchUserId|loginHint|twitch:|anon:/); // no field, and no raw identity key either

  engine.adjustQueue(1, A, "mod bonus"); // an unlock with no contribution behind it
  const adjusted = last(msgs);
  if (adjusted.type !== "state") throw new Error(adjusted.type);
  expect(adjusted).toMatchObject({ reason: "queue_adjust", tiersOpened: [1] });
  expect(adjusted.state).toMatchObject({ queue: 3 });
  expect(adjusted.state.motes.collecting).toEqual([]);
  expect(adjusted.state.motes.ready.map((g) => g.length)).toEqual([1, 1, 0]);
  expect("cabin" in adjusted.state).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Contributor Motes on the wire: `motes.collecting` in lastSeq order, `motes.ready[i]` = queue position i's group,
// the fire message's `group` = the consumed Unlock's. Lists only — never a "who unlocked it".
// ---------------------------------------------------------------------------------------------------------------------

test("motes.collecting: one Mote per key in lastSeq order — a repeat giver grows in place and moves to the end, a gift bomb is the gifter's one Mote, anonymous is a blank Mote per contribution", () => {
  const { engine, msgs, theme } = mk((c) => (c.threshold.cents = 10000));
  engine.contribute(tip(1000, "alice"), A);
  engine.contribute({ ...tip(500, "Bob"), twitchUserId: "2" }, A);
  engine.contribute(contribution({ kind: "gift", tier: "1000", count: 25 }, "gifter"), A); // $50 progress, one Mote
  engine.contribute(tip(300, null), A);
  engine.contribute(tip(2000, "ALICE"), A); // the same key: alice, now 3000, newest
  const m = last(msgs);
  if (m.type !== "contribution") throw new Error(m.type);
  expect(m.state.motes.collecting).toEqual([
    { key: moteWireKey("twitch:2"), name: "Bob", avatar: avatarFor("Bob", theme), avatarUrl: null, cents: 500 },
    { key: moteWireKey("gifter"), name: "gifter", avatar: avatarFor("gifter", theme), avatarUrl: null, cents: 5000 },
    { key: moteWireKey(`anon:${BOOT_SEEDS + 4}`), name: null, avatar: "", avatarUrl: null, cents: 300 },
    { key: moteWireKey("alice"), name: "ALICE", avatar: avatarFor("ALICE", theme), avatarUrl: null, cents: 3000 },
  ]);
  expect(m.state.motes.ready).toEqual([]);
  for (const mote of m.state.motes.collecting) expect(Object.keys(mote).sort()).toEqual(["avatar", "avatarUrl", "cents", "key", "name"]);
});

test("overshoot on the wire: $62 from five then $200 → ready[0] is the five + the tipper's $38, ready[1] the tipper's $100, collecting the tipper's $62; the fire message's group is the consumed Unlock's", () => {
  const { engine, msgs } = mk((c) => (c.threshold.cents = 10000));
  for (const [name, cents] of [["ann", 1000], ["ben", 1200], ["cy", 1500], [null, 1800], ["di", 700]] as const) engine.contribute(tip(cents, name), A);
  engine.contribute({ ...tip(20000, "Tip"), twitchUserId: "9" }, A);
  const crossed = last(msgs);
  if (crossed.type !== "contribution") throw new Error(crossed.type);
  const bare = (g: readonly { key: string; cents: number }[]) => g.map((x) => [x.key, x.cents]);
  expect(crossed.state.motes.ready.map(bare)).toEqual([
    [
      [moteWireKey("ann"), 1000],
      [moteWireKey("ben"), 1200],
      [moteWireKey("cy"), 1500],
      [moteWireKey(`anon:${BOOT_SEEDS + 4}`), 1800],
      [moteWireKey("di"), 700],
      [moteWireKey("twitch:9"), 3800],
    ],
    [[moteWireKey("twitch:9"), 10000]],
  ]);
  expect(bare(crossed.state.motes.collecting)).toEqual([[moteWireKey("twitch:9"), 6200]]);

  const first = engine.fire(A);
  const drop1 = last(msgs);
  if (drop1.type !== "fire") throw new Error(drop1.type);
  expect(drop1.fireSeq).toBe(first.seq);
  expect(drop1.solo).toBeNull();
  expect(drop1.group).toEqual(crossed.state.motes.ready[0]!);
  expect(drop1.state.motes.ready.map(bare)).toEqual([[[moteWireKey("twitch:9"), 10000]]]);
  expect(bare(drop1.state.motes.collecting)).toEqual([[moteWireKey("twitch:9"), 6200]]); // the fire never touches the collecting motes

  engine.rebank(first.seq, A, "no show"); // the group comes back to the front with its Unlock
  const back = last(msgs);
  if (back.type !== "state") throw new Error(back.type);
  expect(back.state.motes.ready.map((g) => g.length)).toEqual([6, 1]);
  expect(back.state.motes.ready[0]).toEqual(drop1.group);

  engine.fire(A);
  engine.fire(A);
  const drop2 = last(msgs);
  if (drop2.type !== "fire") throw new Error(drop2.type);
  expect(bare(drop2.group)).toEqual([[moteWireKey("twitch:9"), 10000]]);
  expect(drop2.solo).toBe("Tip"); // the one allowed name: that $100 was this person's alone, from zero
  expect(drop2.state.motes.ready).toEqual([]);
});

test("a Mote's avatarUrl is the cache's synchronous answer (peek) — by id, or by the contribution's login hint — and never starts a lookup; anonymous stays blank", () => {
  const { engine, msgs, avatars } = mkWithAvatars({ "id:1": PIC, "login:styler": PIC });
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A);
  engine.contribute({ ...tip(500, "Styler"), loginHint: "styler" }, A);
  engine.contribute(tip(500, "nobody"), A); // no id, no hint: nothing to peek at
  engine.contribute(tip(500, null), A);
  const m = last(msgs);
  if (m.type !== "contribution") throw new Error(m.type);
  expect(m.state.motes.collecting.map((x) => [x.key, x.avatarUrl])).toEqual([
    [moteWireKey("twitch:1"), PIC],
    [moteWireKey("styler"), PIC],
    [moteWireKey("nobody"), null],
    [moteWireKey(`anon:${BOOT_SEEDS + 4}`), null],
  ]);
  expect(avatars.asked).toHaveLength(0);
  expect(JSON.stringify(m.state)).not.toMatch(/twitchUserId|loginHint|twitch:|"styler"|anon:/); // the id, the hint and the raw keys (`twitch:1`, `styler`, `anon:5`) all stay in the State; only the name and the URL travel
});

test("a Mote's key is an opaque hash of the State's identity key — the Twitch id never leaves the State, and the same contributor keeps the same key from message to message", () => {
  const { engine, msgs } = mk((c) => (c.threshold.cents = 10000));
  engine.contribute({ ...tip(500, "Tip"), twitchUserId: "424242" }, A);
  const first = last(msgs);
  if (first.type !== "contribution") throw new Error(first.type);
  engine.contribute({ ...tip(700, "tip"), twitchUserId: "424242" }, A); // the same person, by id
  engine.contribute(tip(300, "other"), A);
  const second = last(msgs);
  if (second.type !== "contribution") throw new Error(second.type);
  for (const m of [first, second]) {
    const wire = JSON.stringify(m.state);
    expect(wire).not.toMatch(/twitchUserId|loginHint/);
    expect(wire).not.toContain("424242"); // not as a field, not inside a key, not anywhere
    expect(wire).not.toContain("twitch:");
  }
  expect(first.state.motes.collecting.map((x) => [x.key, x.cents])).toEqual([[moteWireKey("twitch:424242"), 500]]);
  expect(second.state.motes.collecting.map((x) => [x.key, x.cents])).toEqual([
    [moteWireKey("twitch:424242"), 1200], // lastSeq order: the repeat gift came before "other"
    [moteWireKey("other"), 300],
  ]);
  expect(second.state.motes.collecting[0]!.key).toBe(first.state.motes.collecting[0]!.key);
  expect(moteWireKey("twitch:424242")).toBe(fnv1a("twitch:424242").toString(36));
  expect(moteWireKey("anon:5")).not.toBe(moteWireKey("anon:6"));
});

// ---------------------------------------------------------------------------------------------------------------------
// Avatar Pictures: the contribution message's avatarUrl comes from the AvatarCache; the hub only asks
// ---------------------------------------------------------------------------------------------------------------------

/** An AvatarSource double: `known` answers synchronously; anything else is a lookup parked until `release()`. */
function fakeAvatars(known: Record<string, string | null> = {}) {
  const asked: Array<{ twitchUserId?: string | null; loginHint?: string | null }> = [];
  const parked: Array<(url: string | null) => void> = [];
  const key = (ref: { twitchUserId?: string | null; loginHint?: string | null } | null | undefined) => (ref?.twitchUserId ? `id:${ref.twitchUserId}` : ref?.loginHint ? `login:${ref.loginHint}` : null);
  const src = {
    asked,
    parked,
    cached(ref: { twitchUserId?: string | null; loginHint?: string | null } | null | undefined) {
      const k = key(ref);
      return k === null ? null : known[k];
    },
    peek(ref: { twitchUserId?: string | null; loginHint?: string | null } | null | undefined) {
      return src.cached(ref) ?? null;
    },
    urlFor(ref: { twitchUserId?: string | null; loginHint?: string | null } | null | undefined) {
      asked.push(ref ?? {});
      const hit = src.cached(ref);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise<string | null>((resolve) => parked.push(resolve));
    },
    release(url: string | null) {
      for (const go of parked.splice(0)) go(url);
    },
  };
  return src;
}

function mkWithAvatars(known: Record<string, string | null> = {}) {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const avatars = fakeAvatars(known);
  const logs: string[] = [];
  const hub = new OverlayHub(engine, () => config, { avatars, log: (m) => void logs.push(m) });
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s: string) => void msgs.push(JSON.parse(s) as OverlayMessage) });
  return { ledger, engine, hub, msgs, avatars, logs };
}
const PIC = "https://static-cdn.jtvnw.net/jtv_user_pictures/aaaa-profile_image-150x150.png";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a cached contributor: the contribution message carries the picture URL synchronously — by Twitch id, or by login hint when there is no id", () => {
  const { engine, msgs, avatars } = mkWithAvatars({ "id:1": PIC, "login:styler": PIC });
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A);
  expect(msgs).toHaveLength(2);
  expect(last(msgs)).toMatchObject({ type: "contribution", displayName: "alice", avatarUrl: PIC });
  engine.contribute({ ...tip(500, "Styler"), loginHint: "styler" }, A);
  expect(last(msgs)).toMatchObject({ displayName: "Styler", avatarUrl: PIC });
  expect(avatars.asked).toHaveLength(0); // the synchronous read was enough
  const m = last(msgs);
  if (m.type !== "contribution") throw new Error(m.type);
  expect(JSON.stringify(m)).not.toContain("twitchUserId"); // the id stays in the Ledger; the overlay only ever sees the URL
  expect(JSON.stringify(m)).not.toContain("loginHint");
});

test("first sight: the message waits for urlFor (the cache bounds that to 500 ms) and goes out with the URL; the Ledger write and the caller never wait", async () => {
  const { ledger, engine, msgs, avatars } = mkWithAvatars();
  const r = engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A);
  expect(r.duplicate).toBe(false);
  expect(ledger.all()).toHaveLength(BOOT_SEEDS + 1); // written before any picture business
  expect(msgs).toHaveLength(1); // nothing sent yet
  expect(avatars.asked).toEqual([{ twitchUserId: "1", loginHint: undefined }]);
  avatars.release(PIC);
  await tick();
  expect(msgs).toHaveLength(2);
  expect(last(msgs)).toMatchObject({ type: "contribution", displayName: "alice", avatarUrl: PIC, progressCents: 500 });
});

test("a first sight the cache gives up on (null): the message goes out with avatarUrl null — the overlay shows the Avatar Glyph", async () => {
  const { engine, msgs, avatars } = mkWithAvatars();
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A);
  avatars.release(null);
  await tick();
  expect(last(msgs)).toMatchObject({ type: "contribution", avatar: expect.any(String), avatarUrl: null });
});

test("anonymous, or a contributor with neither id nor hint: no lookup at all, avatarUrl null, synchronous", () => {
  const { engine, msgs, avatars } = mkWithAvatars({ "id:1": PIC });
  engine.contribute({ ...tip(500, null), twitchUserId: null }, A);
  expect(msgs).toHaveLength(2);
  expect(last(msgs)).toMatchObject({ anonymous: true, avatarUrl: null });
  engine.contribute({ ...contribution({ kind: "tip", cents: 300 }, "Jo Example"), source: "kofi" }, A);
  expect(msgs).toHaveLength(3);
  expect(last(msgs)).toMatchObject({ displayName: "Jo Example", avatarUrl: null });
  // an anonymous event that still carries an id (it never does; belt and braces) is not looked up either
  engine.contribute({ ...tip(500, null), twitchUserId: "1" }, A);
  expect(last(msgs)).toMatchObject({ anonymous: true, avatarUrl: null });
  expect(avatars.asked).toHaveLength(0);
});

test("the wire stays in order: events behind a pending first sight wait for it (each with its own post-mutation state), and the fast path returns once the queue drains", async () => {
  const { engine, msgs, avatars } = mkWithAvatars({ "id:2": PIC });
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A); // first sight: pending
  engine.setThreshold(2500, A); // would be synchronous on its own
  engine.contribute({ ...tip(100, "bob"), twitchUserId: "2" }, A); // cached, but must not overtake
  expect(msgs).toHaveLength(1);
  avatars.release(PIC);
  await tick();
  await tick();
  expect(msgs.slice(1).map((m) => m.type)).toEqual(["contribution", "state", "contribution"]);
  const [first, state, second] = msgs.slice(1) as [Extract<OverlayMessage, { type: "contribution" }>, Extract<OverlayMessage, { type: "state" }>, Extract<OverlayMessage, { type: "contribution" }>];
  expect(first).toMatchObject({ displayName: "alice", avatarUrl: PIC, state: expect.objectContaining({ thresholdCents: 5000, progressCents: 500 }) });
  expect(state).toMatchObject({ reason: "threshold", state: expect.objectContaining({ thresholdCents: 2500, progressCents: 500 }) }); // its own moment: before bob's $1
  expect(second).toMatchObject({ displayName: "bob", avatarUrl: PIC, state: expect.objectContaining({ thresholdCents: 2500, progressCents: 600 }) });

  engine.setThreshold(3000, A); // the queue has drained: synchronous again
  expect(last(msgs)).toMatchObject({ type: "state", reason: "threshold" });
  expect(msgs).toHaveLength(5);
});

test("a lookup that rejects (the cache never does; a defensive path) sends the message without a picture and logs once — saying so, not 'dropped'; later events flow", async () => {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const logs: string[] = [];
  const hub = new OverlayHub(engine, () => config, { avatars: { urlFor: () => Promise.reject(new Error("boom")), cached: () => undefined, peek: () => null }, log: (m) => void logs.push(m) });
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s: string) => void msgs.push(JSON.parse(s) as OverlayMessage) });
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A);
  await tick();
  expect(last(msgs)).toMatchObject({ type: "contribution", displayName: "alice", avatarUrl: null });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("boom");
  expect(logs[0]).toContain("without a picture"); // the money went out; only the picture did not
  expect(logs[0]).not.toContain("dropped");
  engine.setThreshold(2500, A);
  expect(last(msgs)).toMatchObject({ type: "state" });
});

test("a socket attached while a first sight is pending gets the fresh snapshot only — the queued contribution goes to the sockets that were attached when the event fired (a reconnect never rolls backwards)", async () => {
  const { hub, engine, msgs, avatars } = mkWithAvatars();
  const gone: OverlayMessage[] = [];
  const wsGone = { send: (s: string) => void gone.push(JSON.parse(s) as OverlayMessage) };
  hub.attach(wsGone);
  engine.contribute({ ...tip(500, "alice"), twitchUserId: "1" }, A); // first sight: pending
  hub.detach(wsGone); // left during the wait: hears nothing more
  const late: OverlayMessage[] = [];
  hub.attach({ send: (s: string) => void late.push(JSON.parse(s) as OverlayMessage) }); // (re)loaded during the wait
  expect(late).toHaveLength(1);
  expect(late[0]).toMatchObject({ type: "snapshot", state: expect.objectContaining({ progressCents: 500 }) }); // already counted
  avatars.release(PIC);
  await tick();
  expect(msgs.map((m) => m.type)).toEqual(["snapshot", "contribution"]);
  expect(last(msgs)).toMatchObject({ displayName: "alice", avatarUrl: PIC });
  expect(late.map((m) => m.type)).toEqual(["snapshot"]); // never the older contribution behind its newer snapshot
  expect(gone.map((m) => m.type)).toEqual(["snapshot"]);
  engine.setThreshold(2500, A); // drained: the late socket is a full member again
  expect(last(late)).toMatchObject({ type: "state", reason: "threshold" });
});

/** A clock and a `wait` the test advances by hand (the AvatarCache's own seams): `wait(ms)` resolves when `advance` carries the clock past it. */
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
      await tick();
      await tick();
    },
  };
}

test("first-sight waits are bounded, not additive: ten unknown contributors within 10 ms, each lookup 400 ms → the tenth message is out within 500 ms of the first event", async () => {
  const c = clock();
  const looked: string[][] = [];
  const helix = {
    usersByIds: async (ids: readonly string[]) => {
      looked.push([...ids]);
      await c.wait(400);
      return ids.map((id) => ({ id, login: `user${id}`, profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/u${id}-profile_image-300x300.png` }));
    },
    usersByLogins: async () => [],
  };
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const cache = new AvatarCache(helix, { now: c.now, wait: c.wait, warn: () => {} });
  const hub = new OverlayHub(engine, () => config, { avatars: cache });
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s: string) => void msgs.push(JSON.parse(s) as OverlayMessage) });
  const t0 = c.now();
  for (let i = 1; i <= 10; i++) {
    engine.contribute({ ...tip(100, `user${i}`), twitchUserId: String(i) }, A);
    await c.advance(1);
  }
  expect(c.now() - t0).toBe(10);
  expect(looked).toHaveLength(10); // every lookup started when its event arrived, not when its turn on the wire came
  expect(msgs).toHaveLength(1); // nothing out yet: the first lookup is still running
  await c.advance(400); // t0 + 410: every lookup has answered
  expect(c.now() - t0).toBeLessThanOrEqual(500);
  const out = msgs.slice(1) as Array<Extract<OverlayMessage, { type: "contribution" }>>;
  expect(out.map((m) => m.displayName)).toEqual(Array.from({ length: 10 }, (_, i) => `user${i + 1}`)); // in order
  expect(out.map((m) => m.state.progressCents)).toEqual(Array.from({ length: 10 }, (_, i) => 100 * (i + 1))); // each its own moment
  for (const m of out) expect(m.avatarUrl).toBe(`https://static-cdn.jtvnw.net/jtv_user_pictures/u${m.displayName!.slice(4)}-profile_image-150x150.png`);
});

test("names are revealed as tiers open; a tier still closed stays masked", () => {
  const { engine, msgs } = mk();
  engine.contribute(contribution({ kind: "bits", bits: 15000 }, "bob"), A); // $150 → 3 unlocks → tier 1
  const m = last(msgs);
  if (m.type !== "contribution") throw new Error(m.type);
  expect(m.tiersOpened).toEqual([1]);
  expect(m.state.tier).toBe(1);
  expect(byId(m.state.outcomes, "genre-roulette")).toMatchObject({ name: "GENRE ROULETTE", glyph: "🎲" });
  expect(byId(m.state.outcomes, "pie-to-the-face")).toMatchObject({ name: null, glyph: LOCKED_GLYPH, nameLength: "PIE TO THE FACE".length });
});

test("fire events → fire messages with solo (the one who alone crossed from $0, by display name), the Unlock's group, stock after, and the post-state — no contributor", () => {
  const { engine, msgs, theme } = mk();
  engine.contribute(tip(5000, "alice"), A); // $50 at $0: alice alone
  const fire = engine.fire(A); // rng 0 → stickers (5 charges)
  const m = last(msgs);
  expect(m).toEqual({
    type: "fire",
    fireSeq: fire.seq,
    outcomeId: "stickers",
    solo: "alice",
    group: [{ key: moteWireKey("alice"), name: "alice", avatar: avatarFor("alice", theme), avatarUrl: null, cents: 5000 }],
    stockAfter: 4,
    state: expect.objectContaining({ queue: 0, motes: { collecting: [], ready: [] } }),
  });
  expect("miniDraw" in m).toBe(false);
  expect("contributor" in m).toBe(false);

  engine.adjustQueue(1, A, "bonus"); // no contribution behind it
  engine.fire(A);
  const unattributed = last(msgs);
  if (unattributed.type !== "fire") throw new Error(unattributed.type);
  expect(unattributed.solo).toBeNull();
  expect(unattributed.group).toEqual([]);
  expect(unattributed.stockAfter).toBe(3);

  engine.contribute(tip(5000, null), A); // an anonymous solo: the Unlock is solo, the name is not the overlay's
  engine.fire(A);
  const anonymous = last(msgs);
  if (anonymous.type !== "fire") throw new Error(anonymous.type);
  expect(anonymous.solo).toBeNull();

  engine.contribute(tip(3000, "bob"), A); // $30 at $0 …
  engine.contribute(tip(3000, "carol"), A); // … and $30 at $30: carol crossed, but not alone
  engine.fire(A);
  const shared = last(msgs);
  if (shared.type !== "fire") throw new Error(shared.type);
  expect(shared.solo).toBeNull();
  expect(shared.group.map((x) => [x.key, x.cents])).toEqual([
    [moteWireKey("bob"), 3000],
    [moteWireKey("carol"), 2000],
  ]); // both ride it — bob's $30 and the $20 of carol's that crossed — as a list, never as who unlocked it
  expect(shared.state.motes.collecting.map((x) => [x.key, x.cents])).toEqual([[moteWireKey("carol"), 1000]]); // the rest of hers starts the next
  expect(JSON.stringify({ ...shared, group: undefined, state: { ...shared.state, motes: undefined } })).not.toMatch(/bob|carol/); // outside the Mote lists, nobody
});

test("a voided solo contribution is not named on the drop (the solo exception requires the money to be real)", () => {
  const { engine, msgs } = mk();
  const r = engine.contribute(tip(5000, "alice"), A); // $50 at $0: alice alone → a solo Unlock, banked
  if (r.duplicate) throw new Error("duplicate");
  engine.voidContribution(r.entry.seq, "twitch:mod", "chargeback"); // the money was not real; the Unlock stays banked
  engine.fire(A);
  const m = last(msgs);
  if (m.type !== "fire") throw new Error(m.type);
  expect(m.solo).toBeNull();
  expect(JSON.stringify({ ...m, group: undefined })).not.toContain("alice");
  // the Unlock stays banked with its group (a void reaches the collecting motes only — the Queue is the crowd's); a mod who wants it gone adjusts the Queue
  expect(m.group.map((x) => x.key)).toEqual([moteWireKey("alice")]);
});

test("a mini-draw rides along on the fire message", () => {
  const { engine, msgs, config } = mk((c) => {
    c.outcomes = c.outcomes.filter((o) => o.id === "genre-roulette").map((o) => ({ ...o, tier: 0 }));
  });
  engine.contribute(tip(5000, null), A);
  engine.fire(A);
  const m = last(msgs);
  if (m.type !== "fire") throw new Error(m.type);
  expect(m.miniDraw).toEqual({ title: "GENRE ROULETTE · 10–15 MIN", list: config.lists.genreRoulette, pick: config.lists.genreRoulette[0]! });
  expect(m.state.drained).toBe(true);
});

test("state events → state messages with the reason; skinChanged and broadcast reach every attached socket; detach stops delivery", () => {
  const { engine, hub, msgs, ws, config, theme } = mk();
  engine.setThreshold(2500, A);
  expect(last(msgs)).toEqual({ type: "state", reason: "threshold", tiersOpened: [], state: expect.objectContaining({ thresholdCents: 2500 }) });

  const other: OverlayMessage[] = [];
  hub.attach({ send: (s) => void other.push(JSON.parse(s) as OverlayMessage) });
  expect(other[0]!.type).toBe("snapshot");

  hub.broadcast({ type: "cue", name: "beat", value: 0.8 });
  expect(last(msgs)).toEqual({ type: "cue", name: "beat", value: 0.8 });
  expect(last(other)).toEqual({ type: "cue", name: "beat", value: 0.8 });

  config.overlay.theme = "duck-farm";
  hub.skinChanged();
  expect(last(msgs)).toEqual({ type: "skin", skin: { config: config.overlay, theme: config.themes["duck-farm"]!, channelName: "DJ Example", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } } });
  expect(config.themes["duck-farm"]).not.toEqual(theme);

  const before = msgs.length;
  hub.detach(ws);
  hub.broadcast({ type: "cue", name: "drop" });
  expect(msgs).toHaveLength(before);
  expect(last(other)).toEqual({ type: "cue", name: "drop" });

  expect(hub.snapshot()).toEqual({ type: "snapshot", state: expect.objectContaining({ thresholdCents: 2500 }), skin: expect.objectContaining({ channelName: "DJ Example" }), chatters: [] });
});

test("a socket whose send throws does not stop delivery to the others", () => {
  const { hub, msgs } = mk();
  hub.attach({
    send: () => {
      throw new Error("gone");
    },
  });
  hub.broadcast({ type: "cue", name: "beat" });
  expect(last(msgs)).toEqual({ type: "cue", name: "beat" });
});

test("a projection failure never turns a committed mutation into a 500: the message is dropped and logged, later events flow again", () => {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  let broken = false;
  const logs: string[] = [];
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const hub = new OverlayHub(
    engine,
    () => {
      if (broken) throw new Error("projection exploded");
      return config;
    },
    { log: (m) => void logs.push(m) },
  );
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s) => void msgs.push(JSON.parse(s) as OverlayMessage) });
  expect(msgs).toHaveLength(1);

  broken = true;
  expect(() => engine.contribute(tip(100, "zed"), A)).not.toThrow(); // the Ledger already has the entry; the caller must see success
  expect(engine.state.progressCents).toBe(100);
  expect(ledger.all()).toHaveLength(1 + config.outcomes.length + 1); // the threshold seed + one stock seed per Outcome + the contribution
  expect(msgs).toHaveLength(1); // nothing half-sent
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("contribution");
  expect(logs[0]).toContain("projection exploded");

  broken = false;
  engine.contribute(tip(100, "zed"), A);
  expect(last(msgs)).toMatchObject({ type: "contribution", displayName: "zed", state: expect.objectContaining({ progressCents: 200 }) });
  expect(logs).toHaveLength(1);
});

test("overlayHttp + wsHandler + the HTML route on the overlay listener: GET /overlay is the bundled page whose script connects to overlay/ws, /overlay/ws receives the snapshot first, anything else 404", async () => {
  const { hub, engine, config } = mk();
  config.listeners = { streamerPort: 0, funnelPort: 0, overlayPort: 0, bindAll: false, overlayOnLan: false };
  const l = startListeners({
    config,
    handlers: { app: () => notFound(), overlay: (req, server) => hub.overlayHttp(req, server), overlayWs: hub.wsHandler, overlayRoutes },
  });
  try {
    const origin = `http://127.0.0.1:${l.overlay.port}`;
    const page = await fetch(`${origin}/overlay`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<canvas class="stage" id="stage">');
    expect(html).toContain('id="thanks"');
    expect(html).not.toMatch(/\b(banked|spent)\b/i);
    // Bun's HTML import externalises the page's script and stylesheet as hashed chunks it serves itself
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    const sheet = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    if (script === undefined || sheet === undefined) throw new Error(`no script/stylesheet in ${html}`);
    const js = await fetch(`${origin}${script}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const source = await js.text();
    expect(source).toContain("overlay/ws"); // the client connects to the hub's WS_PATH
    expect(source).not.toMatch(/bun:|node:|Bun\.serve|OverlayHub/); // nothing server-only reached the browser bundle
    expect((await fetch(`${origin}${sheet}`)).status).toBe(200);
    // the client imports every sheet of the Chrome Lounge Theme Sheet — one at 1x / 0.75x / 0.5x and the 2x
    // zoom as several — and Bun hashes them into routes it serves. All are routes; the 2x ones are only FETCHED
    // when Detail 2x asks for them (sprites.ts `setDetail`).
    const pngs = [...new Set([...source.matchAll(/"(\/[^"]*chrome-lounge[^"]*\.png)"/g)].map((m) => m[1]!))];
    expect(pngs).toHaveLength(3 + atlas.scales["2"].sheets.length);
    expect(pngs.filter((r) => /@2x-\d+/.test(r))).toHaveLength(atlas.scales["2"].sheets.length);
    for (const route of pngs) {
      const png = await fetch(`${origin}${route}`);
      expect(png.status, route).toBe(200);
      expect(png.headers.get("content-type"), route).toContain("image/png");
      const head = new Uint8Array(await png.arrayBuffer()).slice(0, 8);
      expect([...head], route).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    expect((await fetch(`${origin}/overlay/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${l.overlay.port}/api/state`)).status).toBe(404);

    const ws = new WebSocket(`ws://127.0.0.1:${l.overlay.port}/overlay/ws`);
    const received: OverlayMessage[] = [];
    const next = () =>
      new Promise<OverlayMessage>((resolve, reject) => {
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data)) as OverlayMessage;
          received.push(m);
          resolve(m);
        };
        ws.onerror = () => reject(new Error("websocket error"));
        ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`));
      });
    const first = await next();
    expect(first.type).toBe("snapshot");

    const pending = next();
    engine.contribute(tip(100, "zed"), A);
    const second = await pending;
    expect(second).toMatchObject({ type: "contribution", displayName: "zed", progressCents: 100 });

    ws.send("ping"); // the client never sends anything meaningful; it must be ignored, not close the socket
    const pending2 = next();
    engine.setThreshold(4000, A);
    expect((await pending2).type).toBe("state");
    ws.close();
  } finally {
    l.stop();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Upstream: the one message an overlay sends
// ---------------------------------------------------------------------------------------------------------------------

const report = (over: Partial<OverlayReport> = {}): OverlayReport => ({ type: "quality", level: 5, mode: "auto", missRatio: 0, webgl: false, stable: true, ...over });

test("a socket's valid report is kept (the latest per socket, in attach order); anything else on the socket is ignored; a detach drops its report", () => {
  const { hub, ws } = mk();
  const other = { send: () => undefined };
  hub.attach(other);
  expect(hub.reports()).toEqual([]);

  hub.wsHandler.message(ws as unknown as Bun.ServerWebSocket<unknown>, JSON.stringify(report({ level: 4, missRatio: 0.03 })));
  expect(hub.reports()).toEqual([report({ level: 4, missRatio: 0.03 })]);
  hub.receive(other, Buffer.from(JSON.stringify(report({ level: 3, mode: "manual", webgl: true }))));
  expect(hub.reports()).toEqual([report({ level: 4, missRatio: 0.03 }), report({ level: 3, mode: "manual", webgl: true })]);
  hub.receive(ws, JSON.stringify(report({ level: 4, missRatio: 0.01 })));
  expect(hub.reports()[0]).toEqual(report({ level: 4, missRatio: 0.01 }));

  for (const junk of ["not json", "42", JSON.stringify({ type: "cue" }), JSON.stringify(report({ level: 6 as never })), JSON.stringify(report({ mode: "turbo" as never })), JSON.stringify(report({ missRatio: 2 })), JSON.stringify(report({ missRatio: "x" as never })), JSON.stringify(report({ webgl: "on" as never })), JSON.stringify({ ...report(), stable: undefined }), JSON.stringify(report({ level: 2.5 as never }))]) {
    hub.receive(ws, junk);
  }
  expect(hub.reports()[0]).toEqual(report({ level: 4, missRatio: 0.01 }));
  hub.receive({ send: () => undefined }, JSON.stringify(report())); // never attached: nothing to keep
  expect(hub.reports()).toHaveLength(2);

  hub.detach(ws);
  expect(hub.reports()).toEqual([report({ level: 3, mode: "manual", webgl: true })]);
  hub.receive(ws, JSON.stringify(report())); // late frame from a socket that is gone
  expect(hub.reports()).toHaveLength(1);
});

test("Health: a step-down (a lower level than the socket's previous report, not yet stable) sets the overlay-quality warn; a stable report clears it; a manual change is not a step-down", () => {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const health = new Health({ now: () => new Date("2026-09-12T20:00:00.000Z") });
  const hub = new OverlayHub(engine, () => config, { health });
  const ws = { send: () => undefined };
  hub.attach(ws);
  const banner = () => health.list().find((b) => b.id === OVERLAY_QUALITY_HEALTH_ID);

  hub.receive(ws, JSON.stringify(report({ level: 4, stable: false }))); // a first report is never a step-down
  expect(banner()).toBeUndefined();
  hub.receive(ws, JSON.stringify(report({ level: 4, stable: false, missRatio: 0.3 })));
  expect(banner()).toBeUndefined();
  hub.receive(ws, JSON.stringify(report({ level: 3, stable: false, missRatio: 0.3 })));
  expect(banner()).toEqual({ id: "overlay-quality", level: "warn", text: "Overlay stepped down to Level 3 — Auto Quality is managing it", at: "2026-09-12T20:00:00.000Z" });
  hub.receive(ws, JSON.stringify(report({ level: 3, stable: false, missRatio: 0.1 })));
  expect(banner()?.text).toContain("Level 3");
  hub.receive(ws, JSON.stringify(report({ level: 3, stable: true, missRatio: 0.01 })));
  expect(banner()).toBeUndefined();
  hub.receive(ws, JSON.stringify(report({ level: 2, stable: false })));
  expect(banner()?.text).toBe("Overlay stepped down to Level 2 — Auto Quality is managing it");
  health.dismiss(OVERLAY_QUALITY_HEALTH_ID);
  hub.receive(ws, JSON.stringify(report({ level: 1, stable: false })));
  expect(banner()?.text).toBe("Overlay stepped down to Level 1 — Auto Quality is managing it"); // a further step is news again
  hub.receive(ws, JSON.stringify(report({ level: 1, stable: true })));
  expect(banner()).toBeUndefined();

  hub.receive(ws, JSON.stringify(report({ level: 5, mode: "manual", stable: false })));
  hub.receive(ws, JSON.stringify(report({ level: 2, mode: "manual", stable: false }))); // the streamer picked 2: not Auto's doing
  expect(banner()).toBeUndefined();

  const bare = new OverlayHub(new Engine(new Ledger(":memory:"), () => config, { rng: () => 0 }), () => config); // no Health wired: reports still kept
  bare.attach(ws);
  bare.receive(ws, JSON.stringify(report({ level: 5, stable: false })));
  bare.receive(ws, JSON.stringify(report({ level: 4, stable: false })));
  expect(bare.reports()).toEqual([report({ level: 4, stable: false })]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Chatter Dancers: the roster on the wire — a list of opaque keys, names and picture URLs; the Twitch id never travels
// ---------------------------------------------------------------------------------------------------------------------

test("chatterKey: an opaque, stable base-36 hash of `chatter:<id>` — distinct per id, distinct from the Mote key of the same person", () => {
  expect(chatterKey("424242")).toBe(fnv1a("chatter:424242").toString(36));
  expect(chatterKey("424242")).toBe(chatterKey("424242"));
  expect(chatterKey("1")).not.toBe(chatterKey("2"));
  expect(chatterKey("424242")).not.toBe(moteWireKey("twitch:424242"));
});

test("with a ChatterSource: the snapshot carries source.list(), chattersChanged broadcasts it, chatHop broadcasts the key, the skin carries the config's window/dwell/nameLength (live on skinChanged); the id never travels", () => {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  config.channel = { login: "dj", broadcasterId: "100", displayName: "DJ Example" };
  const engine = new Engine(ledger, () => config, { rng: () => 0 });
  const alice: Chatter = { key: chatterKey("424242"), name: "Alice", avatarUrl: PIC, firstSeenMs: 1_000, lastSeenMs: 2_000 };
  const people: Chatter[] = [alice];
  const source: ChatterSource = { list: () => [...people], count: () => people.length, fake: () => alice, hopRandom: () => null };
  const hub = new OverlayHub(engine, () => config, { chatters: source });
  const msgs: OverlayMessage[] = [];
  hub.attach({ send: (s: string) => void msgs.push(JSON.parse(s) as OverlayMessage) });
  expect(msgs[0]).toEqual({ type: "snapshot", state: expect.any(Object), skin: expect.objectContaining({ chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } }), chatters: [alice] });

  people.push({ key: chatterKey("7"), name: "Bob", avatarUrl: null, firstSeenMs: 3_000, lastSeenMs: 3_000 });
  hub.chattersChanged();
  expect(last(msgs)).toEqual({ type: "chatters", chatters: [alice, { key: chatterKey("7"), name: "Bob", avatarUrl: null, firstSeenMs: 3_000, lastSeenMs: 3_000 }] });
  hub.chatHop(alice.key);
  expect(last(msgs)).toEqual({ type: "chat-hop", key: alice.key });
  expect(JSON.stringify(msgs)).not.toMatch(/424242|twitchUserId|login/);

  config.chatters.windowMinutes = 5;
  config.chatters.dwellSeconds = 30;
  config.chatters.nameLength = 4;
  hub.skinChanged();
  expect(last(msgs)).toMatchObject({ type: "skin", skin: { chatters: { windowMs: 300_000, dwellMs: 30_000, nameLength: 4 } } });
});

test("without a ChatterSource: the snapshot's roster is empty and both methods still broadcast", () => {
  const { hub, msgs } = mk();
  expect((msgs[0] as Extract<OverlayMessage, { type: "snapshot" }>).chatters).toEqual([]);
  hub.chattersChanged();
  expect(last(msgs)).toEqual({ type: "chatters", chatters: [] });
  hub.chatHop("k");
  expect(last(msgs)).toEqual({ type: "chat-hop", key: "k" });
});

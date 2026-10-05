import { test, expect } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import type { Entry, EntryPayload, EntryType } from "../ledger/types.ts";
import { initialState, moteKey, reduce, replay, reprojectState, startingThresholdCents, type MoteRecord, type ReduceContext } from "./state.ts";

let seq = 0;
function entry<T extends EntryType>(type: T, payload: EntryPayload[T]): Entry<T> {
  return { seq: ++seq, ts: "2026-09-04T00:00:00.000Z", type, actor: "system:test", payload };
}
const threshold = (cents: number) => entry("threshold", { cents });
const contribution = (progressCents: number) =>
  entry("contribution", { source: "manual", sourceId: `manual:${seq}`, face: { kind: "tip", cents: progressCents }, displayName: "tester", anonymous: false, occurredAt: "2026-09-04T00:00:00.000Z", progressCents, policyVersion: 1 });
const unlock = (contributionSeq: number) => entry("unlock", { source: "threshold", contributionSeq });
const note = () => entry("note", { text: "hi" });

// startingThresholdCents: the FIRST `threshold` entry when it precedes the first `contribution`; otherwise the fallback.

test("a seeded ledger starts replay from its first threshold entry, whatever config says now", () => {
  expect(startingThresholdCents([threshold(5000), contribution(1300), threshold(3500)], 3500)).toBe(5000);
  expect(startingThresholdCents([note(), threshold(5000), contribution(1300)], 3500)).toBe(5000); // other entries before the seed are fine
});

test("a legacy ledger (contributions before any threshold entry) and an empty ledger fall back to config", () => {
  expect(startingThresholdCents([contribution(1300), threshold(3500)], 4000)).toBe(4000);
  expect(startingThresholdCents([contribution(1300)], 4000)).toBe(4000);
  expect(startingThresholdCents([note()], 4000)).toBe(4000);
  expect(startingThresholdCents([], 4000)).toBe(4000);
});

test("replay of a seeded ledger carries $13 after a threshold edit; a legacy ledger replays under the current config", () => {
  const config = defaultConfig();
  config.threshold.cents = 3500; // /api/threshold persisted the edit before the restart
  const seeded = [threshold(5000), contribution(1300), contribution(10000), unlock(2), unlock(3), threshold(3500)];
  expect(replay(seeded, config)).toMatchObject({ thresholdCents: 3500, progressCents: 1300, bankedTotal: 2 });
  const legacy = seeded.slice(1);
  expect(replay(legacy, config)).toMatchObject({ thresholdCents: 3500, progressCents: 800, bankedTotal: 2 });
});

// ---- stock: Left is Ledger-only, folded per id into State.records ------------------------------------------

const ctx = (config: Config): ReduceContext => ({ config, entry: () => undefined });

test("stock entries are signed and fold into left; seeded flips on the first stock entry for an id", () => {
  const config = defaultConfig();
  let s = initialState(config);
  expect(s.outcomes[0]!.id).toBe("stickers");
  expect(s.outcomes[0]!.left).toBe(0); // nothing seeded yet (Left is Ledger-only)
  expect(s.records["stickers"]?.seeded ?? false).toBe(false);
  s = reduce(s, entry("stock", { outcomeId: "stickers", delta: 5, reason: "initial" }), ctx(config));
  expect(s.outcomes[0]!.left).toBe(5);
  expect(s.records["stickers"]!.seeded).toBe(true);
  expect(s.records["stickers"]).toEqual({ left: 5, used: 0, status: "live", seeded: true });
  s = reduce(s, entry("stock", { outcomeId: "stickers", delta: -2, reason: "left edit" }), ctx(config));
  expect(s.outcomes[0]!.left).toBe(3);
  s = reduce(s, entry("stock", { outcomeId: "stickers", delta: -9, reason: "left edit" }), ctx(config));
  expect(s.outcomes[0]!.left).toBe(0); // the projection clamps, never negative on screen
  expect(s.records["stickers"]!.left).toBe(-6); // the record keeps the signed sum (Left is Σ, not a per-step floor)
});

test("a legacy Ledger's Fires before any stock entry fold to initialLeft − fires once the seed arrives at the tail", () => {
  const config = defaultConfig();
  const c = ctx(config);
  let s = initialState(config);
  const u1 = unlock(1);
  const u2 = unlock(2);
  s = reduce(s, u1, c);
  s = reduce(s, u2, c);
  s = reduce(s, entry("fire", { unlockSeq: u1.seq, outcomeId: "stickers", roll: 0.1, stockAfter: 4 }), c);
  s = reduce(s, entry("fire", { unlockSeq: u2.seq, outcomeId: "stickers", roll: 0.2, stockAfter: 3 }), c);
  expect(s.outcomes[0]!.left).toBe(0); // nothing seeded yet: not live, but the Fires are not lost
  expect(s.records["stickers"]!.left).toBe(-2);
  s = reduce(s, entry("stock", { outcomeId: "stickers", delta: 5, reason: "initial" }), c); // A3 appends the seed at the tail
  expect(s.outcomes[0]!.left).toBe(3);
  expect(s.outcomes[0]!.used).toBe(2);
  expect(s.records["stickers"]!.left).toBe(3);
});

test("the fold is order-independent: seed-then-fires and fires-then-seed project the same outcomes", () => {
  const config = defaultConfig();
  const fires = (u1: Entry<"unlock">, u2: Entry<"unlock">) => [
    entry("fire", { unlockSeq: u1.seq, outcomeId: "stickers", roll: 0.1, stockAfter: 4 }),
    entry("fire", { unlockSeq: u2.seq, outcomeId: "stickers", roll: 0.2, stockAfter: 3 }),
  ];
  const seed = () => entry("stock", { outcomeId: "stickers", delta: 5, reason: "initial" });
  const a1 = unlock(1);
  const a2 = unlock(2);
  const seedFirst = replay([a1, a2, seed(), ...fires(a1, a2)], config);
  const b1 = unlock(1);
  const b2 = unlock(2);
  const firesFirst = replay([b1, b2, ...fires(b1, b2), seed()], config);
  expect(firesFirst.outcomes).toEqual(seedFirst.outcomes);
  expect(firesFirst.records).toEqual(seedFirst.records);
  expect(seedFirst.outcomes[0]).toMatchObject({ id: "stickers", left: 3, used: 2 });
});

test("withRecord projects against the current config: a definition added to config shows up on the next record-touching entry, identical to reprojectState", () => {
  const config = defaultConfig();
  const s0 = initialState(config);
  config.outcomes.push({ id: "vinyl-only", name: "VINYL ONLY", glyph: "💿", shape: "challenge", tier: 0, initialLeft: 2, restockable: true, occupancy: "~1 track", description: "" });
  const s = reduce(s0, entry("stock", { outcomeId: "stickers", delta: 1, reason: "left edit" }), ctx(config));
  const vinyl = s.outcomes.find((o) => o.id === "vinyl-only");
  expect(vinyl).toMatchObject({ name: "VINYL ONLY", left: 0, used: 0, status: "live" }); // no seed yet
  expect(reprojectState(s, config).outcomes).toEqual(s.outcomes);
});

test("a stock entry for an id config no longer lists is kept in records and ignored by outcomes", () => {
  const config = defaultConfig();
  let s = reduce(initialState(config), entry("stock", { outcomeId: "ghost", delta: 3, reason: "initial" }), ctx(config));
  expect(s.records["ghost"]!.left).toBe(3);
  expect(s.outcomes.some((o) => o.id === "ghost")).toBe(false);
  config.outcomes.push({ id: "ghost", name: "GHOST", glyph: "👻", shape: "moment", tier: 0, initialLeft: 1, restockable: false, occupancy: "instant", description: "" });
  s = reprojectState(s, config);
  expect(s.outcomes.find((o) => o.id === "ghost")!.left).toBe(3); // the Ledger's stock, not initialLeft
  expect(s.outcomes.find((o) => o.id === "ghost")!.name).toBe("GHOST");
});

test("reprojectState re-settles: an Outcome config drops leaves the pool and can drain it; lastSeq is kept", () => {
  const config = defaultConfig();
  let s = reduce(initialState(config), entry("stock", { outcomeId: "stickers", delta: 1, reason: "initial" }), ctx(config));
  expect(s.drained).toBe(false);
  const without = { ...config, outcomes: config.outcomes.filter((o) => o.id !== "stickers") };
  const re = reprojectState(s, without);
  expect(re.outcomes.some((o) => o.id === "stickers")).toBe(false);
  expect(re.records["stickers"]!.left).toBe(1); // records outlive the definition
  expect(re.drained).toBe(true);
  expect(re.lastSeq).toBe(s.lastSeq);
});

test("outcome_change folds to a no-op", () => {
  const config = defaultConfig();
  const before = reduce(initialState(config), entry("stock", { outcomeId: "stickers", delta: 5, reason: "initial" }), ctx(config));
  const after = reduce(before, entry("outcome_change", { outcomeId: "stickers", action: "edit", changes: { tier: { from: 0, to: 1 } } }), ctx(config));
  expect(after).toEqual({ ...before, lastSeq: after.lastSeq });
  expect(after.lastSeq).toBe(before.lastSeq + 1);
});

test("legacy restock still adds to left; fire and rebank move left/used on the record", () => {
  const config = defaultConfig();
  const c = ctx(config);
  let s = reduce(initialState(config), entry("restock", { outcomeId: "stickers", charges: 2 }), c);
  expect(s.outcomes[0]!.left).toBe(2);
  expect(s.records["stickers"]).toEqual({ left: 2, used: 0, status: "live", seeded: false }); // restock is not a seed
  const bySeq = new Map<number, Entry>();
  const full: ReduceContext = { config, entry: (seq) => bySeq.get(seq) };
  const u = unlock(1);
  s = reduce(s, u, full);
  const f = entry("fire", { unlockSeq: u.seq, outcomeId: "stickers", roll: 0.1, stockAfter: 1 });
  bySeq.set(f.seq, f);
  s = reduce(s, f, full);
  expect(s.records["stickers"]).toMatchObject({ left: 1, used: 1 });
  s = reduce(s, entry("rebank", { fireSeq: f.seq, reason: "guest not up for it" }), full);
  expect(s.records["stickers"]).toMatchObject({ left: 2, used: 0 });
  expect(s.outcomes[0]).toMatchObject({ left: 2, used: 0 });
  s = reduce(s, entry("outcome_status", { outcomeId: "stickers", status: "suspended" }), full);
  expect(s.records["stickers"]!.status).toBe("suspended");
  expect(s.outcomes[0]!.status).toBe("suspended");
});

// ---------------------------------------------------------------------------------------------------------------------
// Contributor Motes: every Unlock carries everyone whose money is in it — nobody owns one.
// ---------------------------------------------------------------------------------------------------------------------

interface Who {
  name?: string | null;
  id?: string | null;
  anon?: boolean;
  face?: EntryPayload["contribution"]["face"];
  loginHint?: string;
}
/** A credited Contribution by `who` (default: a named tipper with no Twitch id). */
function give(progressCents: number, who: Who = {}): Entry<"contribution"> {
  const anonymous = who.anon ?? false;
  const displayName = anonymous ? null : (who.name ?? "tester");
  return entry("contribution", {
    source: "manual",
    sourceId: `manual:${seq + 1}`,
    face: who.face ?? { kind: "tip", cents: progressCents },
    displayName,
    anonymous,
    occurredAt: "2026-09-04T00:00:00.000Z",
    progressCents,
    policyVersion: 1,
    ...(who.id === undefined ? {} : { twitchUserId: who.id }),
    ...(who.loginHint === undefined ? {} : { loginHint: who.loginHint }),
  });
}
const fold = (entries: readonly Entry[], config = defaultConfig()) => replay(entries, config);
/** The bare (key, cents) view of a group or the collecting map, in wire order. */
const shares = (records: readonly MoteRecord[] | Record<string, MoteRecord>): Array<[string, number]> =>
  (Array.isArray(records) ? records : Object.values(records).sort((a, b) => a.lastSeq - b.lastSeq)).map((r) => [r.key, r.cents]);

test("moteKey: twitch:<id> when the id is known, else the lower-cased name; anonymous (or a hidden name) is anon:<seq> — one blank mote per contribution", () => {
  expect(moteKey({ anonymous: false, displayName: "Alice", twitchUserId: "1" }, 7)).toBe("twitch:1");
  expect(moteKey({ anonymous: false, displayName: "Alice" }, 7)).toBe("alice");
  expect(moteKey({ anonymous: false, displayName: "  Bob_99 " }, 7)).toBe("bob_99");
  expect(moteKey({ anonymous: false, displayName: "Alice", twitchUserId: null }, 7)).toBe("alice");
  expect(moteKey({ anonymous: true, displayName: "Alice", twitchUserId: "1" }, 7)).toBe("anon:7"); // anonymous is never merged, whatever the payload carries
  expect(moteKey({ anonymous: false, displayName: null }, 8)).toBe("anon:8");
  expect(moteKey({ anonymous: false, displayName: "   " }, 9)).toBe("anon:9");
});

test("overshoot: $62 from five people then a $200 tip at $100 → the five + the tipper's $38 in the first Unlock, the tipper's $100 alone in the second, the tipper's $62 collecting", () => {
  seq = 0;
  const T = threshold(10000);
  const five = [give(1000, { name: "Ann" }), give(1200, { name: "Ben", id: "2" }), give(1500, { name: "Cy" }), give(1800, { anon: true }), give(700, { name: "Di" })];
  const tipper = give(20000, { name: "Tip", id: "9" });
  const state = fold([T, ...five, tipper, unlock(tipper.seq), unlock(tipper.seq)]);

  expect(state.progressCents).toBe(6200);
  expect(state.queue).toHaveLength(2);
  expect(shares(state.queue[0]!.group)).toEqual([
    ["ann", 1000],
    ["twitch:2", 1200],
    ["cy", 1500],
    [`anon:${five[3]!.seq}`, 1800],
    ["di", 700],
    ["twitch:9", 3800],
  ]);
  expect(shares(state.queue[1]!.group)).toEqual([["twitch:9", 10000]]);
  expect(shares(state.collecting)).toEqual([["twitch:9", 6200]]);
  expect(state.pendingGroups).toEqual([]);

  // the records carry what the wire needs and nothing that names an owner
  expect(state.queue[0]!.group[0]).toEqual({ key: "ann", name: "Ann", twitchUserId: null, loginHint: null, cents: 1000, firstSeq: five[0]!.seq, lastSeq: five[0]!.seq });
  expect(state.queue[0]!.group[3]).toMatchObject({ key: `anon:${five[3]!.seq}`, name: null, twitchUserId: null });
  expect(state.queue[1]!.group[0]).toMatchObject({ key: "twitch:9", name: "Tip", twitchUserId: "9", firstSeq: tipper.seq, lastSeq: tipper.seq });
  expect(state.collecting["twitch:9"]).toMatchObject({ cents: 6200, firstSeq: tipper.seq, lastSeq: tipper.seq });
});

test("a repeat giver keeps ONE record with summed cents (firstSeq the first gift, lastSeq the latest); the same person by id and by name are two keys only when the id is unknown", () => {
  seq = 0;
  const a1 = give(1000, { name: "Alice", id: "1" });
  const b = give(500, { name: "bob" });
  const a2 = give(2000, { name: "ALICE", id: "1" }); // display-name case changed; the id is the identity
  const state = fold([threshold(10000), a1, b, a2]);
  expect(shares(state.collecting)).toEqual([
    ["bob", 500],
    ["twitch:1", 3000],
  ]);
  expect(state.collecting["twitch:1"]).toMatchObject({ name: "ALICE", firstSeq: a1.seq, lastSeq: a2.seq });
  expect(Object.keys(state.collecting)).toHaveLength(2);
});

test("a gift bomb is one record — the gifter's, for the whole credit; anonymous contributions are separate anon:<seq> records with name null", () => {
  seq = 0;
  const bomb = give(5000, { name: "Gifter", id: "5", face: { kind: "gift", tier: "1000", count: 25 } });
  const x = give(300, { anon: true, id: "77" });
  const y = give(400, { anon: true });
  const state = fold([threshold(10000), bomb, x, y]);
  expect(shares(state.collecting)).toEqual([
    ["twitch:5", 5000],
    [`anon:${x.seq}`, 300],
    [`anon:${y.seq}`, 400],
  ]);
  expect(state.collecting[`anon:${x.seq}`]).toEqual({ key: `anon:${x.seq}`, name: null, twitchUserId: null, loginHint: null, cents: 300, firstSeq: x.seq, lastSeq: x.seq });
});

test("a contribution credited 0 cents leaves no mote (its money is not in the Unlock)", () => {
  seq = 0;
  const state = fold([threshold(10000), give(0, { name: "Sub", face: { kind: "sub", tier: "1000" } })]);
  expect(state.collecting).toEqual({});
});

test("void subtracts the voided credit from that key's collecting record and drops it at ≤ 0; the Queue's groups are untouched", () => {
  seq = 0;
  const a1 = give(1000, { name: "Alice" });
  const b = give(500, { name: "Bob" });
  const a2 = give(2000, { name: "Alice" });
  const base = [threshold(10000), a1, b, a2];
  const partial = fold([...base, entry("void", { contributionSeq: a2.seq, reason: "chargeback" })]);
  expect(shares(partial.collecting)).toEqual([
    ["bob", 500],
    ["alice", 1000],
  ]);
  expect(partial.progressCents).toBe(1500);
  const gone = fold([...base, entry("void", { contributionSeq: a2.seq, reason: "chargeback" }), entry("void", { contributionSeq: a1.seq, reason: "chargeback" })]);
  expect(shares(gone.collecting)).toEqual([["bob", 500]]);

  // a void after the crossing: the Unlock stays banked with its group; only the collecting remainder shrinks (floored like progress)
  seq = 0;
  const c = give(6000, { name: "Cy" });
  const d = give(6000, { name: "Di" }); // crosses: Cy 6000 + Di 4000; Di 2000 collecting
  const after = fold([threshold(10000), c, d, unlock(d.seq), entry("void", { contributionSeq: d.seq, reason: "oops" })]);
  expect(shares(after.queue[0]!.group)).toEqual([
    ["cy", 6000],
    ["di", 4000],
  ]);
  expect(after.collecting).toEqual({});
  expect(after.progressCents).toBe(0);
});

test("fire moves nothing on its own; the `unlock` a rebank appends copies the fired Unlock's group to the front; an adjust Unlock's group is []", () => {
  seq = 0;
  const a = give(4000, { name: "Ann" });
  const b = give(6000, { name: "Ben" });
  const u = unlock(b.seq);
  const c = give(1000, { name: "Cy" });
  const adjust = entry("queue_adjust", { delta: 1, reason: "bonus" });
  const bonus = entry("unlock", { source: "adjust", contributionSeq: null });
  const fired = entry("fire", { unlockSeq: u.seq, outcomeId: "stickers", roll: 0, stockAfter: 4 });
  const rebank = entry("rebank", { fireSeq: fired.seq, reason: "no show" });
  const back = entry("unlock", { source: "rebank", contributionSeq: b.seq, fireSeq: fired.seq });
  const config = defaultConfig();

  const queued = fold([threshold(10000), a, b, u, c, adjust, bonus], config);
  expect(queued.queue.map((q) => shares(q.group))).toEqual([[["ann", 4000], ["ben", 6000]], []]);

  const afterFire = fold([threshold(10000), a, b, u, c, adjust, bonus, fired], config);
  expect(afterFire.queue.map((q) => shares(q.group))).toEqual([[]]);
  expect(shares(afterFire.collecting)).toEqual([["cy", 1000]]); // the fire never touches the collecting motes

  const rebanked = fold([threshold(10000), a, b, u, c, adjust, bonus, fired, rebank, back], config);
  expect(rebanked.queue.map((q) => shares(q.group))).toEqual([[["ann", 4000], ["ben", 6000]], []]);
  expect(rebanked.queue[0]!.group).toEqual(queued.queue[0]!.group);
  expect(shares(rebanked.collecting)).toEqual([["cy", 1000]]);
});

test("a threshold edit that banks gives the FIRST new Unlock the whole collecting and the rest []; collecting is then empty; an edit that banks nothing keeps the motes", () => {
  seq = 0;
  const a = give(3000, { name: "Ann" });
  const b = give(3200, { name: "Ben" }); // $62 of $100
  const banks = fold([threshold(10000), a, b, threshold(3000), entry("unlock", { source: "threshold", contributionSeq: null }), entry("unlock", { source: "threshold", contributionSeq: null })]);
  expect(banks).toMatchObject({ thresholdCents: 3000, progressCents: 200, bankedTotal: 2 });
  expect(banks.queue.map((q) => shares(q.group))).toEqual([[["ann", 3000], ["ben", 3200]], []]);
  expect(banks.collecting).toEqual({});
  expect(banks.pendingGroups).toEqual([]);

  seq = 0;
  const keeps = fold([threshold(10000), give(3000, { name: "Ann" }), threshold(20000)]);
  expect(shares(keeps.collecting)).toEqual([["ann", 3000]]);
});

test("a legacy Ledger (unlocks with no pending group, a rebank unlock with no fireSeq) folds with [] groups rather than throwing", () => {
  seq = 0;
  const state = fold([threshold(10000), entry("unlock", { source: "threshold", contributionSeq: null }), entry("unlock", { source: "rebank", contributionSeq: null })]);
  expect(state.queue.map((q) => q.group)).toEqual([[], []]);
});

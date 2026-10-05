import { test, expect, spyOn } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import type { Contribution, Face, SubTier } from "../ingest/contribution.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Entry } from "../ledger/types.ts";
import { Engine, EngineError, OUTCOME_STATUSES, type EngineEvent } from "./engine.ts";
import { isLive, replay } from "./state.ts";

/** What an Engine writes into an empty Ledger before any command: the threshold seed (seq 1) + one `stock` seed per Outcome. */
const BOOT_SEEDS = 1 + defaultConfig().outcomes.length;
const written = (ledger: Ledger) => ledger.all().slice(BOOT_SEEDS);

function mk(overrides: { rng?: () => number; config?: (c: Config) => void } = {}) {
  const ledger = new Ledger(":memory:");
  const config = defaultConfig();
  overrides.config?.(config);
  const engine = new Engine(ledger, () => config, { rng: overrides.rng });
  const events: EngineEvent[] = [];
  engine.on((ev) => events.push(ev));
  return { ledger, engine, config, events };
}

let nextSourceId = 0;
function contribution(face: Face): Contribution {
  return {
    source: "manual",
    sourceId: `manual:test-${++nextSourceId}`,
    face,
    displayName: "tester",
    anonymous: false,
    occurredAt: new Date().toISOString(),
  };
}
const tip = (cents: number) => contribution({ kind: "tip", cents });
const bits = (n: number) => contribution({ kind: "bits", bits: n });
const gift = (tier: SubTier, count: number) => contribution({ kind: "gift", tier, count });

/** Seeded PRNG (mulberry32) for the drain simulation — deterministic rolls in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Money scenarios. Defaults: threshold $50, gates [0, 3, 6].

test("progress accumulates and banks with carry", () => {
  const { engine } = mk(); engine.contribute(tip(1300), "system:test");           // $13
  const r = engine.contribute(bits(10000), "system:test");                       // $100 → 2 unlocks, carry $13
  expect(r).toMatchObject({ duplicate: false, unlocksBanked: 2 });
  expect(engine.state).toMatchObject({ progressCents: 1300, bankedTotal: 2, tier: 0 }); expect(engine.state.queue.length).toBe(2);
});

test("a long scenario ends at queue 8, tier 2, $33 of $35", () => {
  const { engine, ledger, config } = mk(); const A = "system:test";
  engine.contribute(tip(1300), A); engine.contribute(bits(10000), A);   // 2 unlocks, $13
  engine.contribute(tip(3000), A);                                       // $43
  engine.contribute(tip(1000), A);                                       // $53 → 1 unlock, $3
  engine.contribute(gift("1000", 25), A);                                // +$50 → 1 unlock, $3  (tier 1 opens at 3 banked? bankedTotal=4 → yes)
  engine.contribute(bits(20000), A);                                     // +$200 → 4 unlocks, $3 (bankedTotal 8 → tier 2)
  expect(engine.setThreshold(3500, A).unlocksBanked).toBe(0);            // $3 of $35
  config.threshold.cents = 3500;                                         // what /api/threshold persists to config.json
  engine.contribute(tip(10000), A);                                      // $103 → 2 unlocks, $33
  expect(engine.state).toMatchObject({ progressCents: 3300, thresholdCents: 3500, bankedTotal: 10, tier: 2 });
  expect(engine.state.queue.length).toBe(10);
  expect(replay(ledger.all(), config)).toEqual(engine.state);                 // pure replay
  expect(new Engine(ledger, () => config).state).toEqual(engine.state);      // restart path
});

test("tiers open on banked count, in one contribution if needed", () => {
  const { engine, events } = mk(); const r = engine.contribute(bits(30000), "a");  // $300 → 6 unlocks
  expect(r).toMatchObject({ unlocksBanked: 6, tiersOpened: [1, 2] }); expect(engine.state.tier).toBe(2);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "contribution", tiersOpened: [1, 2] });
});

test("threshold edit carries partial progress and banks immediately when crossed", () => {
  const { engine } = mk(); engine.contribute(tip(3700), "a");
  expect(engine.setThreshold(2500, "streamer@local")).toEqual({ unlocksBanked: 1 });
  expect(engine.state).toMatchObject({ progressCents: 1200, thresholdCents: 2500 });
});

test("OUTCOME_STATUSES is the one list of statuses (the API imports it): live | suspended | retired, and setOutcomeStatus rejects anything else", () => {
  expect([...OUTCOME_STATUSES]).toEqual(["live", "suspended", "retired"]);
  const { engine } = mk();
  expect(() => engine.setOutcomeStatus("accent-switch", "paused" as never, "a")).toThrow(EngineError);
});

test("duplicate sourceId is ignored", () => { const { engine } = mk(); const c = tip(100); engine.contribute(c, "a"); expect(engine.contribute(c, "a")).toEqual({ duplicate: true }); expect(engine.state.progressCents).toBe(100); });

test("void floors progress at zero and never un-banks", () => {
  const { engine } = mk(); const r = engine.contribute(tip(6000), "a") as any;   // 1 unlock, $10
  engine.voidContribution(r.entry.seq, "twitch:mod", "refunded");
  expect(engine.state.progressCents).toBe(0); expect(engine.state.queue.length).toBe(1);
});

test("queue adjust counts toward gates upward and cannot go negative", () => {
  const { engine } = mk(); engine.adjustQueue(3, "twitch:mod", "fix"); expect(engine.state.tier).toBe(1);
  engine.adjustQueue(-5, "twitch:mod", "oops"); expect(engine.state.queue.length).toBe(0); expect(engine.state.bankedTotal).toBe(3);
});

test("restock only restockable, status changes, and replay equals live state", () => {
  const { engine, ledger, config } = mk();
  expect(() => engine.restock("pie-to-the-face", 1, "a")).toThrow(/NOT_RESTOCKABLE/);
  engine.setOutcomeStatus("guest-takeover", "suspended", "a"); engine.restock("accent-switch", 2, "a");
  expect(engine.state.outcomes.find(o => o.id === "accent-switch")!).toMatchObject({ left: 3, used: 0 });
  expect(replay(ledger.all(), config)).toEqual(engine.state);
});

test("policy version is stored per contribution and replay never recomputes", () => {
  const { engine, ledger, config } = mk(); engine.contribute(gift("1000", 10), "a");    // $20
  config.policy.subCents["1000"] = 500; config.policy.version = 2;                         // forward-only
  expect(replay(ledger.all(), config).progressCents).toBe(2000);
  engine.contribute(gift("1000", 1), "a"); expect(engine.state.progressCents).toBe(2500);
});

test("events carry the post-mutation state", () => {
  const { engine, events } = mk();
  const off = engine.on(() => { throw new Error("unsubscribed listener must not run"); });
  off();
  engine.contribute(tip(1200), "a");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "contribution", unlocksBanked: 0, tiersOpened: [], state: { progressCents: 1200 } });
  engine.setThreshold(1000, "streamer@local");                                             // $12 of $10 → banks 1, carries $2
  expect(events[1]).toMatchObject({ type: "state", reason: "threshold", tiersOpened: [], state: { progressCents: 200, queue: [{ contributionSeq: null }] } });
});

test("a failed contribute records no raw event, so the retry is not a duplicate", () => {
  const { engine, ledger, events } = mk(); const c = tip(1000);
  const failing = spyOn(ledger, "appendMany").mockImplementation(() => { throw new Error("disk full"); });
  expect(() => engine.contribute(c, "a")).toThrow("disk full");
  failing.mockRestore();
  expect(written(ledger)).toEqual([]); expect(engine.state.progressCents).toBe(0); expect(events).toHaveLength(0); // only the boot seeds
  expect(engine.contribute(c, "a")).toMatchObject({ duplicate: false, unlocksBanked: 0 });
  expect(engine.state.progressCents).toBe(1000);
});

test("a negative or fractional credit is INVALID and records nothing", () => {
  const { engine, ledger, config } = mk({ config: (c) => { c.policy.tipPercent = -100; c.policy.subCents["1000"] = 2.5; } });
  const t = tip(1000); const g = gift("1000", 1);
  expect(() => engine.contribute(t, "a")).toThrow(/^INVALID/);
  expect(() => engine.contribute(g, "a")).toThrow(/^INVALID/);
  expect(written(ledger)).toEqual([]); // only the boot seeds
  config.policy.tipPercent = 100; config.policy.subCents["1000"] = 200;                   // fixed policy: same sourceIds go through
  expect(engine.contribute(t, "a")).toMatchObject({ duplicate: false });
  expect(engine.contribute(g, "a")).toMatchObject({ duplicate: false });
  expect(engine.state.progressCents).toBe(1200);
});

test("a second void of the same contribution is INVALID, also after a restart", () => {
  const { engine, ledger, config } = mk(); const r = engine.contribute(tip(6000), "a") as any;   // 1 unlock, $10
  engine.voidContribution(r.entry.seq, "twitch:mod", "refunded");
  expect(() => engine.voidContribution(r.entry.seq, "twitch:mod", "again")).toThrow(/^INVALID/);
  const restarted = new Engine(ledger, () => config);
  expect(() => restarted.voidContribution(r.entry.seq, "twitch:mod", "again")).toThrow(/^INVALID/);
  expect(ledger.all().filter((e) => e.type === "void")).toHaveLength(1);
  expect(engine.state).toMatchObject({ progressCents: 0, bankedTotal: 1 });
});

test("rejected commands throw the coded EngineError and write nothing", () => {
  const { engine, ledger, config } = mk(); const A = "twitch:mod";
  const rejects = (fn: () => unknown, code: EngineError["code"]) => {
    let caught: unknown; try { fn(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EngineError); expect((caught as EngineError).code).toBe(code);
  };
  rejects(() => engine.setThreshold(0, A), "INVALID");
  rejects(() => engine.setThreshold(1.5, A), "INVALID");
  rejects(() => engine.adjustQueue(0, A, "x"), "INVALID");
  rejects(() => engine.adjustQueue(-1, A, "x"), "INVALID");                            // empty queue
  rejects(() => engine.restock("nope", 1, A), "UNKNOWN_OUTCOME");
  rejects(() => engine.voidContribution(999, A, "x"), "UNKNOWN_ENTRY");
  rejects(() => engine.fire(A), "NO_UNLOCKS");                                         // empty queue
  rejects(() => engine.rebank(1, A, "x"), "UNKNOWN_ENTRY");                            // no such fire (seq 1 is the threshold seed)
  expect(written(ledger)).toEqual([]);                                               // only the boot seeds

  const skipped = ledger.append("restock", A, { outcomeId: "nope", charges: 1 });      // an id config never listed: replay keeps its record, outcomes unchanged
  expect(replay(ledger.all(), config)).toEqual({ ...engine.state, lastSeq: skipped.seq, records: { ...engine.state.records, nope: { left: 1, used: 0, status: "live", seeded: false } } });

  const r = engine.contribute(tip(6000), A) as any;                                    // 1 unlock, $10
  engine.voidContribution(r.entry.seq, A, "refunded");
  expect(engine.state).toMatchObject({ progressCents: 0, bankedTotal: 1 });            // a void never un-banks
});

test("a COMMIT failure leaves the live state equal to the ledger, and the retry credits once", () => {
  const { engine, ledger, config, events } = mk(); const c = tip(6000);                          // 1 unlock, $10
  const real = ledger.transaction.bind(ledger);
  const failing = spyOn(ledger, "transaction").mockImplementation((fn) =>
    real(() => { fn(); throw new Error("disk I/O error"); }),                                   // the writes go in, then COMMIT fails → rollback
  );
  expect(() => engine.contribute(c, "a")).toThrow("disk I/O error");
  failing.mockRestore();
  expect(written(ledger)).toEqual([]);                                                         // only the boot seeds
  expect(engine.state).toEqual(replay(ledger.all(), config));                                   // no phantom progress / queue ref
  expect(events).toHaveLength(0);
  expect(engine.contribute(c, "a")).toMatchObject({ duplicate: false, unlocksBanked: 1 });    // retry: credited once
  expect(engine.state).toMatchObject({ progressCents: 1000, bankedTotal: 1 });
  const c1 = BOOT_SEEDS + 1; // the contribution, after the boot seeds
  expect(engine.state.queue).toEqual([{ seq: c1 + 1, contributionSeq: c1, solo: true, group: [{ key: "tester", name: "tester", twitchUserId: null, loginHint: null, cents: 5000, firstSeq: c1, lastSeq: c1 }] }]); // $60 at $0: alone across the line, $50 of it in the Unlock
  expect(engine.state).toEqual(replay(ledger.all(), config));
});

test("a listener that throws during a void does not disarm the double-void guard", () => {
  const { engine, ledger } = mk(); const r = engine.contribute(tip(6000), "a") as any;         // 1 unlock, $10
  engine.on(() => { throw new Error("listener boom"); });
  expect(() => engine.voidContribution(r.entry.seq, "twitch:mod", "refunded")).toThrow("listener boom");
  expect(() => engine.voidContribution(r.entry.seq, "twitch:mod", "again")).toThrow(/^INVALID/);
  expect(ledger.all().filter((e) => e.type === "void")).toHaveLength(1);
  expect(engine.state).toMatchObject({ progressCents: 0, bankedTotal: 1 });
});

// Fire, draw, rebank, mini-draw, drain. Default pool: 32 left, 17 / 10 / 5 per tier.

test("fire needs an unlock and a live pool, records the roll, and consumes FIFO", () => {
  const { engine, ledger, events } = mk({ rng: () => 0.0 });
  expect(() => engine.fire("twitch:mod")).toThrow(/NO_UNLOCKS/);
  engine.contribute(tip(5000), "a"); const f = engine.fire("twitch:mod");
  expect(f.outcome.id).toBe("stickers"); expect(f.outcome).toMatchObject({ left: 4, used: 1 }); expect(f.contributor).toEqual({ displayName: "tester", anonymous: false });
  expect(engine.state.queue.length).toBe(0); expect(engine.state.firedTotal).toBe(1);
  const [c, u, fire] = [BOOT_SEEDS + 1, BOOT_SEEDS + 2, BOOT_SEEDS + 3]; // contribution, its unlock, the fire — after the boot seeds
  expect(f).toMatchObject({ seq: fire, unlock: { seq: u, contributionSeq: c }, drained: false }); expect(f.miniDraw).toBeUndefined();
  expect(ledger.get(fire)).toMatchObject({ type: "fire", actor: "twitch:mod", payload: { unlockSeq: u, outcomeId: "stickers", roll: 0, stockAfter: 4 } });
  expect(events.at(-1)).toMatchObject({ type: "fire", entry: { seq: fire }, fire: f, state: { firedTotal: 1 } });
});

test("fire.contributor is null once the crossing contribution was voided — the Unlock still fires, nobody is credited", () => {
  const { engine, events } = mk({ rng: () => 0.0 }); const r = engine.contribute(tip(5000), "a");
  if (r.duplicate) throw new Error("duplicate"); engine.voidContribution(r.entry.seq, "twitch:mod", "chargeback");
  const f = engine.fire("twitch:mod");
  expect(f.unlock).toMatchObject({ contributionSeq: r.entry.seq, solo: true }); expect(f.contributor).toBeNull();
  expect(events.at(-1)).toMatchObject({ type: "fire", fire: { contributor: null } });
});

test("fire on a drained pool is rejected without touching the ledger", () => {
  const { engine, ledger } = mk(); engine.contribute(tip(5000), "a");
  for (const o of engine.state.outcomes.filter(o => o.tier === 0)) engine.setOutcomeStatus(o.id, "retired", "a");
  const n = ledger.all().length; expect(() => engine.fire("a")).toThrow(/POOL_DRAINED/); expect(ledger.all().length).toBe(n); expect(engine.state.drained).toBe(true);
});

test("rebank refunds the fire (left +1, used −1), re-queues at the front with the same contributor, and cannot repeat", () => {
  const { engine, ledger } = mk({ rng: () => 0.0 }); engine.contribute(tip(10000), "a");   // 2 unlocks
  const f = engine.fire("a"); engine.rebank(f.seq, "twitch:mod", "guest asleep");
  expect(engine.state.outcomes.find(o => o.id === "stickers")!).toMatchObject({ left: 5, used: 0 });
  expect(engine.state.queue.length).toBe(2); expect(engine.state.queue[0]!.contributionSeq).toBe(f.unlock.contributionSeq);
  expect(engine.state.bankedTotal).toBe(2); expect(() => engine.rebank(f.seq, "a", "again")).toThrow(/INVALID/);
  expect(engine.state.firedTotal).toBe(0);
  expect(ledger.since(f.seq)).toMatchObject([
    { type: "rebank", actor: "twitch:mod", payload: { fireSeq: f.seq, reason: "guest asleep" } },
    { type: "unlock", actor: "twitch:mod", payload: { source: "rebank", contributionSeq: f.unlock.contributionSeq, fireSeq: f.seq } },
  ]);
  expect(() => engine.rebank(f.unlock.seq, "a", "not a fire")).toThrow(/UNKNOWN_ENTRY/);
});

test("mini-draw picks from the config list at fire time", () => {
  const { engine, config, ledger } = mk({ rng: () => 0.999 }); engine.contribute(bits(30000), "a");   // tiers open
  // retire everything except genre-roulette so the draw is forced
  for (const o of engine.state.outcomes) if (o.id !== "genre-roulette") engine.setOutcomeStatus(o.id, "retired", "a");
  const f = engine.fire("a"); expect(f.miniDraw).toEqual({ title: "GENRE ROULETTE · 10–15 MIN", list: config.lists.genreRoulette, pick: config.lists.genreRoulette.at(-1)! });
  expect((ledger.get(f.seq) as any).payload.miniDraw).toEqual(f.miniDraw);                            // stored, never re-rolled
  expect(f).toMatchObject({ outcome: { id: "genre-roulette", left: 0, used: 1 }, drained: true });
});

test("drain simulation pays exactly 32, tiers at 3 and 6 banked, per-tier 17/10/5", () => {
  const { engine } = mk({ rng: mulberry32(7) });   // seeded PRNG helper in the test file
  engine.contribute(bits(400000), "a");            // $4000 → 80 unlocks; gates cross immediately
  const paid = [0,0,0]; let fires = 0;
  while (!engine.state.drained) { const f = engine.fire("a"); paid[f.outcome.tier]!++; fires++; }
  expect(fires).toBe(32); expect(paid).toEqual([17,10,5]); expect(() => engine.fire("a")).toThrow(/POOL_DRAINED/);
  expect(engine.state).toMatchObject({ firedTotal: 32, bankedTotal: 80, tier: 2 }); expect(engine.state.queue.length).toBe(48);
  expect(engine.state.outcomes.every(o => o.left === 0 && o.used === o.initialLeft)).toBe(true);
});

test("used counts fires minus rebanks; left never goes below 0", () => {
  const { engine } = mk({ rng: () => 0 });
  engine.adjustQueue(2, "streamer@local", "test");
  const f1 = engine.fire("streamer@local");
  const o1 = engine.state.outcomes.find((o) => o.id === f1.outcome.id)!;
  expect(o1.used).toBe(1);
  expect(o1.left).toBe(o1.initialLeft - 1);
  engine.rebank(f1.seq, "streamer@local", "oops");
  const o2 = engine.state.outcomes.find((o) => o.id === f1.outcome.id)!;
  expect(o2.used).toBe(0);
  expect(o2.left).toBe(o2.initialLeft);
});

test("replay after fires and rebanks equals live state", () => {
  const { engine, ledger, config } = mk({ rng: mulberry32(11) }); engine.contribute(bits(30000), "a");   // 6 unlocks, tiers open
  const first = engine.fire("a"); const second = engine.fire("twitch:mod"); engine.fire("a");
  engine.rebank(second.seq, "twitch:mod", "prop missing"); engine.fire("a"); engine.rebank(first.seq, "twitch:mod", "guest asleep");
  expect(engine.state).toMatchObject({ firedTotal: 2, bankedTotal: 6 }); expect(engine.state.queue.length).toBe(4);
  expect(replay(ledger.all(), config)).toEqual(engine.state);                 // pure replay
  const restarted = new Engine(ledger, () => config);
  expect(restarted.state).toEqual(engine.state);                              // restart path
  expect(() => restarted.rebank(second.seq, "a", "again")).toThrow(/^INVALID/);   // the guard is seeded from the ledger
});

// The Ledger is the runtime truth for the Threshold: a restart after a Threshold edit must replay every earlier
// Contribution under the Threshold it was credited at — $113 at $50 carries $13; replayed at $35 it would carry $8.

test("an Engine over an empty ledger seeds the starting threshold as entry 1 by system:boot (then the stock seeds); a non-empty ledger is left alone", () => {
  const { ledger, engine } = mk();
  expect(ledger.all()[0]).toMatchObject({ seq: 1, type: "threshold", actor: "system:boot", payload: { cents: 5000 } });
  expect(ledger.all().slice(1).every((e) => e.type === "stock" && e.actor === "system:boot")).toBe(true);
  expect(engine.state).toMatchObject({ thresholdCents: 5000, progressCents: 0, queue: [], lastSeq: BOOT_SEEDS });
  const again = new Engine(ledger, () => defaultConfig());
  expect(ledger.all()).toHaveLength(BOOT_SEEDS);
  expect(again.state).toEqual(engine.state);
});

test("restart after a threshold edit replays contributions under the threshold they were credited at", () => {
  const { engine, ledger, config } = mk(); const A = "system:test";
  engine.contribute(tip(1300), A); engine.contribute(bits(10000), A);   // $113 at $50 → 2 unlocks, $13 carried
  expect(engine.setThreshold(3500, A).unlocksBanked).toBe(0);            // $13 of $35
  config.threshold.cents = 3500;                                         // what /api/threshold persists to config.json
  expect(engine.state).toMatchObject({ thresholdCents: 3500, progressCents: 1300, bankedTotal: 2 });
  expect(replay(ledger.all(), config)).toEqual(engine.state);            // pure replay
  const restarted = new Engine(ledger, () => config);
  expect(restarted.state).toEqual(engine.state);                         // restart path
});

// A hand edit of `threshold.cents` in config.json applies at the next restart: the Engine RECORDS it (a `threshold` entry by
// system:file, exactly what an API edit writes), so replay stays exact and a lower Threshold banks what Progress now crosses.

test("a config threshold that differs from the ledger's at construction is recorded as a threshold entry by system:file (crossings banked); a matching one writes nothing", () => {
  const { engine, ledger, config } = mk(); const A = "system:test";
  engine.contribute(tip(1300), A); engine.contribute(bits(10000), A);   // $113 at $50 → 2 unlocks, $13 carried
  expect(engine.state).toMatchObject({ thresholdCents: 5000, progressCents: 1300, bankedTotal: 2 });
  const before = ledger.all().length;

  config.threshold.cents = 3500;                                         // edited by hand while the service was down
  const restarted = new Engine(ledger, () => config);
  expect(restarted.state).toMatchObject({ thresholdCents: 3500, progressCents: 1300, bankedTotal: 2 });
  expect(ledger.all().slice(before)).toMatchObject([{ type: "threshold", actor: "system:file", payload: { cents: 3500 } }]);
  expect(replay(ledger.all(), config)).toEqual(restarted.state);        // replay equals live
  expect(new Engine(ledger, () => config).state).toEqual(restarted.state);
  expect(ledger.all()).toHaveLength(before + 1);                         // the second restart agrees with the Ledger: nothing more written

  config.threshold.cents = 1000;                                         // lowered below the carried $13: one Unlock banks, $3 carried
  const lowered = new Engine(ledger, () => config);
  expect(lowered.state).toMatchObject({ thresholdCents: 1000, progressCents: 300, bankedTotal: 3 });
  expect(ledger.all().slice(before + 1).map((e) => [e.type, e.actor])).toEqual([["threshold", "system:file"], ["unlock", "system:file"]]);
  expect(replay(ledger.all(), config)).toEqual(lowered.state);
});

// Outcome definitions live in config, stock (Used / Left) in the Ledger. The Engine seeds `initialLeft` as the
// first `stock` entry the moment it first meets an id, and `reproject` is the one hook (boot, the file watcher, the API)
// that rebuilds the Outcome list from config × Ledger.

test("an Outcome added to config appears in state after reproject, with Left seeded once from initialLeft", () => {
  const { engine, config, ledger } = mk();
  config.outcomes.push({ id: "vinyl-only", name: "VINYL ONLY", glyph: "💿", shape: "challenge", tier: 0, initialLeft: 2, restockable: true, occupancy: "~1 track", description: "" });
  engine.reproject("streamer@local");
  const o = engine.state.outcomes.find((x) => x.id === "vinyl-only")!;
  expect(o.left).toBe(2);
  expect(o.used).toBe(0);
  const seeds = ledger.all().filter((e) => e.type === "stock");
  expect(seeds.at(-1)!.payload).toEqual({ outcomeId: "vinyl-only", delta: 2, reason: "initial" });
  // a second reproject does not seed again, and editing initialLeft later changes nothing
  config.outcomes.at(-1)!.initialLeft = 9;
  engine.reproject("streamer@local");
  expect(engine.state.outcomes.find((x) => x.id === "vinyl-only")!.left).toBe(2);
  expect(ledger.all().filter((e) => e.type === "stock").length).toBe(seeds.length);
});

test("a fresh Ledger is seeded with one stock entry per Outcome by system:boot, and replay agrees", () => {
  const { engine, ledger, config } = mk();
  const seeds = ledger.all().filter((e): e is Entry<"stock"> => e.type === "stock");
  expect(seeds.length).toBe(config.outcomes.length);
  expect(seeds.every((e) => e.actor === "system:boot" && e.payload.reason === "initial")).toBe(true);
  expect(engine.state.outcomes.map((o) => o.left)).toEqual(config.outcomes.map((o) => o.initialLeft));
  expect(replay(ledger.all(), config)).toEqual(engine.state);
});

test("a legacy Ledger (fires, no stock entries) is seeded by system:file and keeps the old arithmetic", () => {
  const ledger = new Ledger(":memory:"); const config = defaultConfig();
  ledger.append("threshold", "system:boot", { cents: 5000 });
  ledger.append("unlock", "system:test", { source: "adjust", contributionSeq: null });
  ledger.append("fire", "system:test", { unlockSeq: 2, outcomeId: "stickers", roll: 0, stockAfter: 4 });
  const engine = new Engine(ledger, () => config);
  const stickers = engine.state.outcomes.find((o) => o.id === "stickers")!;
  expect(stickers.left).toBe(4); expect(stickers.used).toBe(1);
  expect(ledger.all().filter((e) => e.type === "stock" && e.actor === "system:file").length).toBe(config.outcomes.length);
});

test("removing an Outcome from config zeroes its Left by the actor and drops it from the pool at once", () => {
  const { engine, config, ledger } = mk();
  config.outcomes = config.outcomes.filter((o) => o.id !== "stickers");
  engine.reproject("system:file");
  expect(engine.state.outcomes.some((o) => o.id === "stickers")).toBe(false);
  const z = ledger.all().filter((e): e is Entry<"stock"> => e.type === "stock" && (e as Entry<"stock">).payload.outcomeId === "stickers").at(-1)!;
  expect(z.payload).toEqual({ outcomeId: "stickers", delta: -5, reason: "removed" });
  expect(z.actor).toBe("system:file");
});

test("setLeft writes one signed stock entry and emits state reason stock", () => {
  const { engine, ledger, events } = mk();
  engine.setLeft("stickers", 8, "streamer@local", "left edit");
  expect(ledger.all().at(-1)!.payload).toEqual({ outcomeId: "stickers", delta: 3, reason: "left edit" });
  expect(events.at(-1)).toMatchObject({ type: "state", reason: "stock" });
  engine.setLeft("stickers", 8, "streamer@local", "left edit");  // no-op
  expect(ledger.all().at(-1)!.payload).toEqual({ outcomeId: "stickers", delta: 3, reason: "left edit" });
  expect(() => engine.setLeft("nope", 1, "a", "r")).toThrow(/UNKNOWN_OUTCOME/);
  expect(() => engine.setLeft("stickers", -1, "a", "r")).toThrow(/INVALID/);
});

test("a tier edit re-locks the pad immediately: the Outcome leaves the draw pool with no guard", () => {
  const { engine, config } = mk({ rng: () => 0 });
  config.outcomes.find((o) => o.id === "stickers")!.tier = 2;
  engine.reproject("streamer@local");
  expect(isLive(engine.state.outcomes.find((o) => o.id === "stickers")!, engine.state.tier)).toBe(false);
});

test("reproject is idempotent and silent when nothing changed: no entries, no event", () => {
  const { engine, ledger, events, config } = mk();
  const n = ledger.all().length;
  engine.reproject("system:file");
  expect(ledger.all()).toHaveLength(n);
  expect(events).toHaveLength(0);
  config.outcomes.find((o) => o.id === "stickers")!.tier = 2;
  engine.reproject("system:file");
  expect(ledger.all()).toHaveLength(n); // a definition edit writes no stock entry ...
  expect(events).toEqual([expect.objectContaining({ type: "state", reason: "outcomes", tiersOpened: [] })]); // ... but the list changed, so the screen hears
  expect(replay(ledger.all(), config)).toEqual(engine.state);
});

// The solo rule: unlock k (1-based) of a contribution is `solo` when k > 1 or the progress before it was exactly 0 —
// one contributor whose money alone took the Unlock from zero to its Threshold. Every other Unlock is the crowd's.
test("solo: a $50 tip at $0 banks one solo unlock; a $30 tip at $30 banks one non-solo; a $120 tip at $10 banks a non-solo then a solo", () => {
  const A = "system:test";
  const alone = mk(); alone.engine.contribute(tip(5000), A);
  expect(alone.engine.state.queue.map((u) => u.solo)).toEqual([true]);
  expect(alone.ledger.all().filter((e) => e.type === "unlock").map((e) => e.payload)).toEqual([{ source: "threshold", contributionSeq: BOOT_SEEDS + 1, solo: true }]);

  const shared = mk(); shared.engine.contribute(tip(2000), A); shared.engine.contribute(tip(3000), A);
  expect(shared.engine.state.queue.map((u) => u.solo)).toEqual([false]);
  expect(shared.ledger.all().filter((e) => e.type === "unlock").map((e) => e.payload)).toEqual([{ source: "threshold", contributionSeq: BOOT_SEEDS + 2, solo: false }]);

  const big = mk(); big.engine.contribute(tip(1000), A); big.engine.contribute(tip(12000), A);
  expect(big.engine.state.queue.map((u) => u.solo)).toEqual([false, true]);
  expect(big.ledger.all().filter((e) => e.type === "unlock").map((e) => e.payload)).toEqual([
    { source: "threshold", contributionSeq: BOOT_SEEDS + 2, solo: false },
    { source: "threshold", contributionSeq: BOOT_SEEDS + 2, solo: true },
  ]);
  expect(replay(big.ledger.all(), big.config).queue.map((u) => u.solo)).toEqual([false, true]);
});

test("solo: threshold-edit and queue-adjust unlocks are never solo; an older ledger's unlock entry without the field folds as false; a rebank keeps the Unlock's solo", () => {
  const A = "system:test";
  const { engine, ledger, config } = mk({ rng: () => 0 });
  engine.contribute(tip(3700), A); engine.setThreshold(2500, A); engine.adjustQueue(1, A, "bonus");
  expect(engine.state.queue.map((u) => u.solo)).toEqual([false, false]);
  ledger.append("unlock", A, { source: "adjust", contributionSeq: null } as never); // an older Ledger's shape: no `solo`
  expect(replay(ledger.all(), config).queue.map((u) => u.solo)).toEqual([false, false, false]);

  const solo = mk({ rng: () => 0 }); solo.engine.contribute(tip(5000), A);
  const f = solo.engine.fire(A); solo.engine.rebank(f.seq, A, "guest asleep");
  expect(f.unlock.solo).toBe(true);
  expect(solo.engine.state.queue.map((u) => u.solo)).toEqual([true]);
});

test("Contributor Mote groups through the live Engine: overshoot, void, fire, rebank, adjust, threshold edit — replay equals the live fold at every step, and after a restart", () => {
  const { engine, ledger, config } = mk({ config: (c) => (c.threshold.cents = 10000) });
  const A = "system:test";
  const same = () => {
    expect(replay(ledger.all(), config)).toEqual(engine.state);
    expect(new Engine(ledger, () => config).state).toEqual(engine.state);
  };
  const named = (name: string, face: Face, twitchUserId?: string): Contribution => ({ ...contribution(face), displayName: name, ...(twitchUserId === undefined ? {} : { twitchUserId }) });
  const bare = (group: readonly { key: string; cents: number }[]) => group.map((m) => [m.key, m.cents]);

  engine.contribute(named("Ann", { kind: "tip", cents: 1000 }), A);
  engine.contribute(named("Ben", { kind: "bits", bits: 1200 }, "2"), A);
  engine.contribute(named("Cy", { kind: "tip", cents: 1500 }), A);
  engine.contribute({ ...contribution({ kind: "tip", cents: 1800 }), displayName: null, anonymous: true }, A);
  engine.contribute(named("Di", { kind: "tip", cents: 700 }), A); // $62 of $100 from five
  same();
  expect(Object.keys(engine.state.collecting)).toHaveLength(5);

  const tip = engine.contribute(named("Tip", { kind: "tip", cents: 20000 }, "9"), A); // $200: $38 + $100 + $62
  if (tip.duplicate) throw new Error("duplicate");
  expect(tip.unlocksBanked).toBe(2);
  same();
  expect(engine.state.queue.map((u) => bare(u.group))).toEqual([
    [
      ["ann", 1000],
      ["twitch:2", 1200],
      ["cy", 1500],
      [`anon:${tip.entry.seq - 2}`, 1800],
      ["di", 700],
      ["twitch:9", 3800],
    ],
    [["twitch:9", 10000]],
  ]);
  expect(bare(Object.values(engine.state.collecting))).toEqual([["twitch:9", 6200]]);

  const fire = engine.fire(A); // the five + the tipper ride this drop
  expect(bare(fire.unlock.group)).toHaveLength(6);
  same();
  engine.rebank(fire.seq, A, "no show"); // and come back to the front
  same();
  expect(engine.state.queue.map((u) => bare(u.group).length)).toEqual([6, 1]);
  expect(engine.state.queue[0]!.group).toEqual(fire.unlock.group);

  engine.adjustQueue(2, A, "bonus"); // nobody behind these
  same();
  expect(engine.state.queue.map((u) => u.group.length)).toEqual([6, 1, 0, 0]);

  engine.voidContribution(tip.entry.seq, A, "chargeback"); // the tipper's $62 collecting goes; the banked Unlocks stay
  same();
  expect(engine.state.collecting).toEqual({});
  expect(engine.state.queue.map((u) => u.group.length)).toEqual([6, 1, 0, 0]);

  engine.contribute(named("Eve", { kind: "tip", cents: 4500 }), A);
  engine.contribute(named("Fay", { kind: "tip", cents: 500 }), A); // $50 of $100
  expect(engine.setThreshold(2500, A).unlocksBanked).toBe(2); // $50 of $25: both bank; Eve + Fay ride the first
  config.threshold.cents = 2500;
  same();
  expect(engine.state.queue.slice(4).map((u) => bare(u.group))).toEqual([
    [
      ["eve", 4500],
      ["fay", 500],
    ],
    [],
  ]);
  expect(engine.state.collecting).toEqual({});
  expect(engine.state.progressCents).toBe(0);
});

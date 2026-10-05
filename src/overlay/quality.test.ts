import { describe, expect, test } from "bun:test";
import type { QualitySetting } from "../config/schema.ts";
import {
  AutoQuality,
  DOWN_COOLDOWN_MS,
  DOWN_RATIO,
  LEVELS,
  MIN_SAMPLES,
  MISS_MS,
  QUIET_MINUTE_MS,
  QualityController,
  SEVERE_RATIO,
  UP_BASE_MS,
  UP_CAP_MS,
  UP_MEAN_MS,
  UP_RATIO,
  WINDOW_FAST_MS,
  WINDOW_SLOW_MS,
  missThresholdMs,
  type AutoStatus,
  type Level,
} from "./quality.ts";

const S = 1000;
const MIN = 60 * S;
/** A 60 Hz frame: clean. */
const FAST_MS = 16;
/** A 30 Hz frame: clean — the cadence the fps cap gives in the real deployment. */
const CAPPED_MS = 33;
const MISS_INTERVAL_MS = 60;
/** Work inside the frame callback: light (headroom) and heavy (none: over UP_MEAN_MS). */
const LIGHT_WORK_MS = 8;
const HEAVY_WORK_MS = 30;

interface Feeder {
  auto: AutoQuality;
  t: number;
  acc: number;
  /** Every status returned so far, with the time it was returned at. */
  log: Array<{ t: number; status: AutoStatus }>;
}

const feeder = (start?: Level): Feeder => ({ auto: new AutoQuality(start), t: 0, acc: 0, log: [] });

interface FeedOpts {
  missRatio?: number;
  quiet?: boolean;
  goodMs?: number;
  missMs?: number;
  workMs?: number;
}

/** Feed frames for `durationMs`: `goodMs` intervals with a `missRatio` share of `missMs` ones (evenly spread), `workMs` of work each, all at `quiet`. */
function feed(f: Feeder, durationMs: number, opts: FeedOpts = {}): AutoStatus {
  const missRatio = opts.missRatio ?? 0;
  const quiet = opts.quiet ?? true;
  const goodMs = opts.goodMs ?? FAST_MS;
  const missMs = opts.missMs ?? MISS_INTERVAL_MS;
  const workMs = opts.workMs ?? LIGHT_WORK_MS;
  const until = f.t + durationMs;
  let status = f.auto.status;
  while (f.t < until) {
    f.acc += missRatio;
    let interval = goodMs;
    if (f.acc >= 1) {
      f.acc -= 1;
      interval = missMs;
    }
    f.t += interval;
    status = f.auto.feed({ nowMs: f.t, intervalMs: interval, workMs, quiet });
    f.log.push({ t: f.t, status });
  }
  return status;
}

/** One frame after a gap of `gapMs` (the interval is the gap itself). */
function gap(f: Feeder, gapMs: number, quiet = false): AutoStatus {
  f.t += gapMs;
  const status = f.auto.feed({ nowMs: f.t, intervalMs: gapMs, workMs: LIGHT_WORK_MS, quiet });
  f.log.push({ t: f.t, status });
  return status;
}

const level = (f: Feeder): Level => f.auto.status.level;
/** The time of the first logged status that satisfies `pred`, or null. */
const firstAt = (f: Feeder, pred: (s: AutoStatus) => boolean): number | null => f.log.find((e) => pred(e.status))?.t ?? null;
/** The times of every step down (a level lower than the frame before). */
const downsAt = (f: Feeder): number[] => f.log.filter((e, i) => i > 0 && e.status.level < f.log[i - 1]!.status.level).map((e) => e.t);
const stepsDown = (f: Feeder): number => downsAt(f).length;

describe("LEVELS — the Quality Level table, cell by cell", () => {
  test("five levels, fixed in code", () => {
    expect(LEVELS[5]).toEqual({ level: 5, fps: 30, particleCap: 400, lasers: true, smoke: true, sweeps: true, sweepScale: 1, spriteScale: 1, parallax: 5, motes: Infinity, chatters: 60 });
    expect(LEVELS[4]).toEqual({ level: 4, fps: 30, particleCap: 260, lasers: true, smoke: true, sweeps: true, sweepScale: 0.7, spriteScale: 1, parallax: 4, motes: Infinity, chatters: 60 });
    expect(LEVELS[3]).toEqual({ level: 3, fps: 30, particleCap: 160, lasers: true, smoke: false, sweeps: true, sweepScale: 1, spriteScale: 0.75, parallax: 4, motes: 24, chatters: 40 });
    expect(LEVELS[2]).toEqual({ level: 2, fps: 30, particleCap: 80, lasers: false, smoke: false, sweeps: false, sweepScale: 1, spriteScale: 0.75, parallax: 3, motes: 12, chatters: 24 });
    expect(LEVELS[1]).toEqual({ level: 1, fps: 20, particleCap: 30, lasers: false, smoke: false, sweeps: false, sweepScale: 1, spriteScale: 0.5, parallax: 2, motes: 6, chatters: 12 });
    expect(Object.keys(LEVELS).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(([5, 4, 3, 2, 1] as const).map((l) => LEVELS[l].chatters)).toEqual([60, 60, 40, 24, 12]);
  });

  test("the Auto constants are the ADR's numbers; the miss threshold is 1.5 × the level's frame budget, never under MISS_MS", () => {
    expect([MISS_MS, WINDOW_FAST_MS, WINDOW_SLOW_MS, QUIET_MINUTE_MS]).toEqual([50, 5_000, 15_000, 60_000]);
    expect([DOWN_RATIO, SEVERE_RATIO, DOWN_COOLDOWN_MS, MIN_SAMPLES]).toEqual([0.2, 0.5, 10_000, 30]);
    expect([UP_RATIO, UP_MEAN_MS, UP_BASE_MS, UP_CAP_MS]).toEqual([0.02, 25, 180_000, 900_000]);
    expect(([5, 4, 3, 2, 1] as const).map(missThresholdMs)).toEqual([50, 50, 50, 50, 75]);
  });
});

describe("AutoQuality — the state machine, fed one frame interval at a time", () => {
  test("starts at 5; 33 ms frames for 20 s keep level 5, stable, no change", () => {
    const f = feeder();
    expect(f.auto.status).toEqual({ level: 5, missRatio: 0, meanIntervalMs: 0, meanWorkMs: 0, stable: true, lastChange: null });
    const s = feed(f, 20 * S, { goodMs: CAPPED_MS });
    expect(s).toEqual({ level: 5, missRatio: 0, meanIntervalMs: CAPPED_MS, meanWorkMs: LIGHT_WORK_MS, stable: true, lastChange: null });
    expect(f.log.every((e) => e.status.level === 5)).toBe(true);
  });

  test("a miss is an interval over the threshold: at Level 5, 50 ms is not one, 51 ms is", () => {
    const a = new AutoQuality();
    expect(a.feed({ nowMs: 50, intervalMs: 50, workMs: 8, quiet: true }).missRatio).toBe(0);
    expect(a.feed({ nowMs: 101, intervalMs: 51, workMs: 8, quiet: true }).missRatio).toBe(0.5);
  });

  test("Level 1 (20 fps) misses at 75 ms: a 50 ms cadence with jitter is stable there; 76 ms is a miss", () => {
    const f = feeder(1);
    for (let i = 0; i < 400; i++) feed(f, 1, { goodMs: i % 2 === 0 ? 48 : 55 }); // one frame each: 48 / 55 ms alternating
    expect(f.auto.status).toMatchObject({ level: 1, missRatio: 0, stable: true });
    const a = new AutoQuality(1);
    expect(a.feed({ nowMs: 75, intervalMs: 75, workMs: 8, quiet: true }).missRatio).toBe(0);
    expect(a.feed({ nowMs: 151, intervalMs: 76, workMs: 8, quiet: true }).missRatio).toBe(0.5);
  });

  test("a frame keeps the verdict it was judged with: 60 ms frames that stepped 2 → 1 stay misses until they leave the window, then Level 1 is stable", () => {
    const f = feeder(2);
    feed(f, 6 * S, { goodMs: MISS_INTERVAL_MS, quiet: true }); // every frame a miss at Level 2
    expect(f.auto.status).toMatchObject({ level: 1, lastChange: "down", stable: false });
    expect(f.auto.status.missRatio).toBeGreaterThan(SEVERE_RATIO);
    const s = feed(f, WINDOW_FAST_MS + 100, { goodMs: MISS_INTERVAL_MS, quiet: true }); // the same cadence is inside Level 1's budget
    expect(s).toMatchObject({ level: 1, missRatio: 0, stable: true });
  });

  test("30 % misses at a quiet scene: 5 → 4 once the window is full (never on a half-filled window), not again inside the 10 s cooldown, again after it", () => {
    const f = feeder();
    feed(f, 6 * S, { missRatio: 0.3, quiet: true });
    expect(level(f)).toBe(4);
    const at = firstAt(f, (s) => s.level === 4)!;
    expect(at).toBeGreaterThanOrEqual(WINDOW_FAST_MS);
    expect(at).toBeLessThan(WINDOW_FAST_MS + 200);
    expect(f.log.find((e) => e.t === at)!.status).toMatchObject({ level: 4, lastChange: "down", stable: false });
    feed(f, at + DOWN_COOLDOWN_MS - 100 - f.t, { missRatio: 0.3, quiet: true });
    expect(level(f)).toBe(4);
    expect(stepsDown(f)).toBe(1);
    feed(f, 1 * S, { missRatio: 0.3, quiet: true });
    expect(level(f)).toBe(3);
    expect(stepsDown(f)).toBe(2);
  });

  test("60 % misses step immediately, quiet or not, and cascade one level per cooldown down to 1 — never below", () => {
    const f = feeder();
    feed(f, 5.2 * S, { missRatio: 0.6, quiet: false });
    expect(level(f)).toBe(4);
    feed(f, 60 * S, { missRatio: 0.6, quiet: false });
    expect(level(f)).toBe(1);
    const downs = downsAt(f);
    expect(downs).toHaveLength(4);
    for (let i = 1; i < downs.length; i++) expect(downs[i]! - downs[i - 1]!).toBeGreaterThanOrEqual(DOWN_COOLDOWN_MS);
  });

  test("a lone stall after a gap cannot step on its own: 6.4 s of clean frames, one 8 s gap, still Level 5 (the window is one sample)", () => {
    const f = feeder();
    feed(f, 6.4 * S);
    const s = gap(f, 8 * S, false);
    expect(s).toEqual({ level: 5, missRatio: 1, meanIntervalMs: 8 * S, meanWorkMs: LIGHT_WORK_MS, stable: false, lastChange: null });
    // nor at a quiet frame, nor as clean frames refill the window around it
    expect(f.auto.feed({ nowMs: f.t + FAST_MS, intervalMs: FAST_MS, workMs: LIGHT_WORK_MS, quiet: true }).level).toBe(5);
    f.t += FAST_MS;
    feed(f, 2 * S, { quiet: true });
    expect(level(f)).toBe(5);
    expect(f.auto.status.lastChange).toBeNull();
  });

  test("a source that stops rendering (multi-second gaps, one frame between) never walks the level down", () => {
    const f = feeder();
    feed(f, 10 * S);
    for (let i = 0; i < 12; i++) {
      gap(f, 8 * S, true);
      feed(f, 200, { quiet: true }); // a dozen frames, then it stalls again
    }
    expect(level(f)).toBe(5);
    expect(f.auto.status.lastChange).toBeNull();
  });

  test("a genuine sustained 60 ms cadence still steps — once the window holds MIN_SAMPLES frames spanning half of it", () => {
    const f = feeder();
    feed(f, 6.4 * S);
    gap(f, 8 * S, false);
    const gapAt = f.t;
    feed(f, 4 * S, { goodMs: MISS_INTERVAL_MS, quiet: false });
    expect(level(f)).toBe(4);
    const at = firstAt(f, (s) => s.level === 4)! - gapAt;
    expect(at).toBeGreaterThanOrEqual(WINDOW_FAST_MS / 2);
    expect(at).toBeGreaterThanOrEqual(MIN_SAMPLES * MISS_INTERVAL_MS);
    expect(at).toBeLessThan(WINDOW_FAST_MS / 2 + 2 * MISS_INTERVAL_MS);
  });

  test("30 % misses with the scene busy wait; the first quiet frame steps", () => {
    const f = feeder();
    feed(f, 20 * S, { missRatio: 0.3, quiet: false });
    expect(level(f)).toBe(5);
    expect(f.auto.status.stable).toBe(false);
    const s = f.auto.feed({ nowMs: f.t + FAST_MS, intervalMs: FAST_MS, workMs: LIGHT_WORK_MS, quiet: true });
    expect(s).toMatchObject({ level: 4, lastChange: "down" });
  });

  test("misses that stop before the scene goes quiet never step (the deferral is not a latch)", () => {
    const f = feeder();
    feed(f, 8 * S, { missRatio: 0.3, quiet: false });
    feed(f, 6 * S, { quiet: false }); // clean until the misses have left the window
    expect(f.auto.status.missRatio).toBe(0);
    feed(f, 1 * S, { quiet: true });
    expect(level(f)).toBe(5);
  });

  test("level 1 with 90 % misses (real ones: 100 ms, over its 75 ms threshold) stays 1", () => {
    const f = feeder(1);
    feed(f, 40 * S, { missRatio: 0.9, missMs: 100, quiet: true });
    expect(f.auto.status.missRatio).toBeGreaterThan(SEVERE_RATIO);
    expect(level(f)).toBe(1);
    expect(f.auto.status.lastChange).toBeNull();
  });

  test("after a step-down, 3 min of clean quiet frames with headroom step back up; only at a quiet frame; 5 never steps up", () => {
    const f = feeder();
    feed(f, 5.2 * S, { missRatio: 0.6, quiet: false });
    expect(level(f)).toBe(4);
    const down = f.t;
    // the misses drain out of the 5 s window first, then the stable stretch starts
    feed(f, UP_BASE_MS - 5 * S, { quiet: true });
    expect(level(f)).toBe(4);
    feed(f, 25 * S, { quiet: false }); // due, but the scene is busy
    expect(level(f)).toBe(4);
    const s = f.auto.feed({ nowMs: f.t + FAST_MS, intervalMs: FAST_MS, workMs: LIGHT_WORK_MS, quiet: true });
    expect(s).toMatchObject({ level: 5, lastChange: "up", stable: true });
    expect(f.t - down).toBeLessThan(UP_BASE_MS + WINDOW_FAST_MS + 26 * S);
    feed(f, 20 * MIN, { quiet: true });
    expect(level(f)).toBe(5);
  });

  test("headroom is the frame's work time, not its cadence: a capped 33 ms cadence with 8 ms of work steps back up after the stretch", () => {
    const f = feeder();
    feed(f, 5.2 * S, { missRatio: 0.6, quiet: true, goodMs: CAPPED_MS });
    expect(level(f)).toBe(4);
    const down = f.t;
    const s = feed(f, UP_BASE_MS + WINDOW_FAST_MS + 2 * S, { goodMs: CAPPED_MS, workMs: LIGHT_WORK_MS, quiet: true });
    expect(s).toMatchObject({ level: 5, lastChange: "up", stable: true, meanIntervalMs: CAPPED_MS, meanWorkMs: LIGHT_WORK_MS });
    const upAt = firstAt(f, (st) => st.level === 5 && st.lastChange === "up")! - down;
    expect(upAt).toBeGreaterThanOrEqual(UP_BASE_MS);
    expect(upAt).toBeLessThan(UP_BASE_MS + WINDOW_FAST_MS + S);
  });

  test("no headroom (work at or over UP_MEAN_MS) is stable but never steps up, however clean the cadence", () => {
    const f = feeder();
    feed(f, 5.2 * S, { missRatio: 0.6, quiet: true });
    expect(level(f)).toBe(4);
    const s = feed(f, 10 * MIN, { goodMs: FAST_MS, workMs: HEAVY_WORK_MS, quiet: true });
    expect(s).toMatchObject({ level: 4, stable: true, meanIntervalMs: FAST_MS, meanWorkMs: HEAVY_WORK_MS });
    expect(feed(f, 10 * MIN, { goodMs: CAPPED_MS, workMs: UP_MEAN_MS, quiet: true })).toMatchObject({ level: 4, stable: true });
  });

  test("a level that failed once needs 6 min the second time, 12 the third; the wait caps at 15 min", () => {
    const f = feeder();
    const fail = (): void => {
      feed(f, 6 * S, { missRatio: 0.6, quiet: true });
      expect(level(f)).toBe(4);
    };
    const recoverWithin = (waitMs: number): void => {
      const down = f.t;
      feed(f, waitMs - 10 * S, { quiet: true });
      expect(level(f)).toBe(4);
      feed(f, WINDOW_SLOW_MS + 15 * S, { quiet: true });
      expect(level(f)).toBe(5);
      expect(f.t - down).toBeLessThan(waitMs + WINDOW_SLOW_MS + 16 * S);
    };
    fail();
    recoverWithin(UP_BASE_MS);
    fail();
    recoverWithin(2 * UP_BASE_MS);
    fail();
    recoverWithin(4 * UP_BASE_MS);
    fail(); // 8 × 3 min would be 24 min: capped
    recoverWithin(UP_CAP_MS);
    fail();
    recoverWithin(UP_CAP_MS);
  });

  test("failures are counted per level: 4's history does not slow a return to 5", () => {
    const f = feeder();
    feed(f, 16 * S, { missRatio: 0.6, quiet: true }); // 5 → 4 → 3
    expect(level(f)).toBe(3);
    feed(f, UP_BASE_MS + WINDOW_FAST_MS + 5 * S, { quiet: true });
    expect(level(f)).toBe(4);
    feed(f, UP_BASE_MS + 5 * S, { quiet: true });
    expect(level(f)).toBe(5);
  });

  test("the window: 5 s from the start, 15 s after a quiet minute, back to 5 s as soon as the ratio climbs over UP_RATIO", () => {
    const fresh = feeder();
    feed(fresh, 10 * S);
    gap(fresh, MISS_INTERVAL_MS, true);
    feed(fresh, WINDOW_FAST_MS - 100);
    expect(fresh.auto.status.missRatio).toBeGreaterThan(0);
    feed(fresh, 200);
    expect(fresh.auto.status.missRatio).toBe(0);

    const calm = feeder();
    feed(calm, QUIET_MINUTE_MS + 10 * S);
    gap(calm, MISS_INTERVAL_MS, true);
    feed(calm, WINDOW_SLOW_MS - 100);
    expect(calm.auto.status.missRatio).toBeGreaterThan(0); // a lone miss lingers in the long window
    expect(calm.auto.status.stable).toBe(true);
    feed(calm, 200);
    expect(calm.auto.status.missRatio).toBe(0);

    feed(calm, 2 * S, { missRatio: 0.6 }); // over UP_RATIO even across 15 s: the window snaps back to 5 s
    expect(calm.auto.status.stable).toBe(false);
    feed(calm, WINDOW_FAST_MS + 100);
    expect(calm.auto.status.missRatio).toBe(0);
    expect(level(calm)).toBe(5); // 2 s of misses over a 5 s window is under DOWN_RATIO
  });

  test("status is a fresh snapshot: missRatio and the means describe the current window", () => {
    const f = feeder();
    feed(f, 3 * S, { missRatio: 0.5, goodMs: 40, workMs: 12 });
    const s = f.auto.status;
    expect(s.missRatio).toBeCloseTo(0.5, 1);
    expect(s.meanIntervalMs).toBeCloseTo(50, 0);
    expect(s.meanWorkMs).toBe(12);
    expect(s.stable).toBe(false);
    expect(s.level).toBe(5); // the window is not full yet: no step on a first bad second
  });
});

describe("QualityController — the setting, the debug force and Auto, behind one `spec`", () => {
  const controller = (setting: QualitySetting, forced: Level | null = null) => {
    let current = setting;
    const c = new QualityController(() => current, forced);
    return { c, set: (s: QualitySetting) => void (current = s) };
  };

  test("a manual setting: mode manual, that level's spec, feed ignored, report carries the level", () => {
    const { c } = controller(3);
    expect(c.mode).toBe("manual");
    expect(c.spec).toBe(LEVELS[3]);
    for (let t = 60; t < 30 * S; t += 60) c.feed(t, 60, 8, true);
    expect(c.spec.level).toBe(3);
    expect(c.status).toEqual({ level: 3, missRatio: 0, meanIntervalMs: 0, meanWorkMs: 0, stable: true, lastChange: null });
    expect(c.report(false)).toEqual({ type: "quality", level: 3, mode: "manual", missRatio: 0, webgl: false, stable: true });
  });

  test("forced (?quality=N in debug) wins over the setting, auto or not, and reads as manual", () => {
    expect(controller("auto", 2).c.spec.level).toBe(2);
    expect(controller(4, 2).c.spec.level).toBe(2);
    expect(controller("auto", 2).c.mode).toBe("manual");
  });

  test("auto: starts at 5, steps with the frames, reports the live level; report(true).webgl === true", () => {
    const { c } = controller("auto");
    expect(c.mode).toBe("auto");
    expect(c.spec).toBe(LEVELS[5]);
    let t = 0;
    for (let i = 0; i < 200; i++) {
      const interval = i % 2 === 0 ? 60 : 16;
      t += interval;
      c.feed(t, interval, 8, true);
    }
    expect(c.spec.level).toBe(4);
    expect(c.status).toMatchObject({ level: 4, lastChange: "down", stable: false });
    expect(c.report(true)).toMatchObject({ type: "quality", level: 4, mode: "auto", webgl: true, stable: false });
    expect(c.report(true).missRatio).toBeCloseTo(0.5, 1);
  });

  test("the setting is read live: auto → 2 → auto resumes Auto's own level", () => {
    const { c, set } = controller("auto");
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += 60;
      c.feed(t, 60, 8, true);
    }
    expect(c.spec.level).toBe(4);
    set(2);
    expect(c.mode).toBe("manual");
    expect(c.spec.level).toBe(2);
    set("auto");
    expect(c.spec.level).toBe(4);
  });
});

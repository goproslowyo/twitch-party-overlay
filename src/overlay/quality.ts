/**
 * Quality Levels and Auto Quality. `LEVELS` is the fixed table — five cost bundles the scene draws at, the
 * scene itself the same at every one. `AutoQuality` is the pure state machine: fed one frame per frame — its interval,
 * the time spent inside the frame callback (its work) and whether the scene is Quiet — it steps down when frames keep
 * missing the budget and back up only after a long stable stretch with headroom, never barring a level — it only grows
 * more patient about returning to one that has failed before. `QualityController` puts the config setting (`1..5 | "auto"`), the debug force (`?quality=N`)
 * and Auto behind one `spec`, and builds the upstream `OverlayReport`. Nothing here reads a clock, keeps a timer or
 * persists anything: time arrives as `nowMs`, and a page reload starts over at 5.
 */
import type { QualitySetting } from "../config/schema.ts";
import type { OverlayReport } from "../server/overlay.ts";

export type Level = 1 | 2 | 3 | 4 | 5;

export interface LevelSpec {
  level: Level;
  fps: 20 | 30;
  particleCap: number;
  lasers: boolean;
  smoke: boolean;
  sweeps: boolean;
  /** The sweep wedge and core at this share of their size; the pool and plate where they land are unchanged. */
  sweepScale: number;
  spriteScale: 1 | 0.75 | 0.5;
  parallax: number;
  /** Contributor Motes drawn at most; Infinity = all. */
  motes: number;
  /** Chatter Dancers drawn at most; above it the floor cycles by dwell. */
  chatters: number;
}

/** The Quality Level table, with the cuts the streamer picked after a live test: Level 4 sweep wedge and core at 0.7 of their size, Level 2 no sweeps. */
export const LEVELS: Readonly<Record<Level, LevelSpec>> = Object.freeze({
  5: { level: 5, fps: 30, particleCap: 400, lasers: true, smoke: true, sweeps: true, sweepScale: 1, spriteScale: 1, parallax: 5, motes: Infinity, chatters: 60 },
  4: { level: 4, fps: 30, particleCap: 260, lasers: true, smoke: true, sweeps: true, sweepScale: 0.7, spriteScale: 1, parallax: 4, motes: Infinity, chatters: 60 },
  3: { level: 3, fps: 30, particleCap: 160, lasers: true, smoke: false, sweeps: true, sweepScale: 1, spriteScale: 0.75, parallax: 4, motes: 24, chatters: 40 },
  2: { level: 2, fps: 30, particleCap: 80, lasers: false, smoke: false, sweeps: false, sweepScale: 1, spriteScale: 0.75, parallax: 3, motes: 12, chatters: 24 },
  1: { level: 1, fps: 20, particleCap: 30, lasers: false, smoke: false, sweeps: false, sweepScale: 1, spriteScale: 0.5, parallax: 2, motes: 6, chatters: 12 },
} as const satisfies Record<Level, LevelSpec>);

export const START_LEVEL: Level = 5;
/** A frame whose interval is over the level's threshold is a miss; this is the floor of that threshold (`missThresholdMs`). */
export const MISS_MS = 50;
/** The window must hold this many frames before a step down is judged — a lone stall after a gap is one miss, not a verdict. */
export const MIN_SAMPLES = 30;
export const WINDOW_FAST_MS = 5_000;
export const WINDOW_SLOW_MS = 15_000;
export const QUIET_MINUTE_MS = 60_000;
export const DOWN_RATIO = 0.2;
export const SEVERE_RATIO = 0.5;
export const DOWN_COOLDOWN_MS = 10_000;
export const UP_RATIO = 0.02;
export const UP_MEAN_MS = 25;
export const UP_BASE_MS = 180_000;
export const UP_CAP_MS = 900_000;

/**
 * The interval a frame may take at `level` before it is a miss: 1.5 × the level's frame budget, never under `MISS_MS`
 * — exactly 50 ms at Levels 2–5 (30 fps), 75 ms at Level 1 (20 fps), whose drawn-frame cadence sits at 50 ms by design.
 */
export function missThresholdMs(level: Level): number {
  return Math.max(MISS_MS, 1500 / LEVELS[level].fps);
}

export interface AutoInput {
  nowMs: number;
  /** The interval since the previous drawn frame (raw, not the loop's clamped dt). */
  intervalMs: number;
  /** The time spent inside the frame callback — the headroom measure. */
  workMs: number;
  /** A Quiet Scene: nothing in motion a viewer would notice being interrupted. */
  quiet: boolean;
}

export interface AutoStatus {
  level: Level;
  /** Misses over the current window, 0–1. */
  missRatio: number;
  /** Mean frame interval over the current window (0 with no frames yet) — the readout's fps. */
  meanIntervalMs: number;
  /** Mean work time over the current window (0 with no frames yet) — the headroom the step up needs. */
  meanWorkMs: number;
  /** `missRatio < UP_RATIO` over the current window. */
  stable: boolean;
  lastChange: "down" | "up" | null;
}

interface Frame {
  t: number;
  interval: number;
  work: number;
  /** Judged against the threshold of the level in force when the frame was fed; a later step does not re-judge it. */
  miss: boolean;
}

const down = (level: Level): Level => Math.max(1, level - 1) as Level;
const up = (level: Level): Level => Math.min(5, level + 1) as Level;

/**
 * Pure: feed one frame interval per frame; reads nothing from the clock. Starts at 5 (or `start`).
 *
 * The rules: a miss is an interval over the level's threshold (`missThresholdMs`); the miss
 * ratio is taken over a window that is `WINDOW_FAST_MS` and stretches to `WINDOW_SLOW_MS` once the ratio has stayed
 * under `UP_RATIO` for a full `QUIET_MINUTE_MS` — and snaps back the moment misses rise over it. **Down** one level
 * when the ratio passes `DOWN_RATIO` (only on a full window that holds at least `MIN_SAMPLES` frames spanning half of
 * it — a lone stall after a gap cannot step on its own — and at least `DOWN_COOLDOWN_MS` after the last step), at once
 * when it passes `SEVERE_RATIO`, otherwise at the next Quiet frame — and only if the misses are still there then.
 * **Up** one level, only at a Quiet frame, after a stretch with the ratio under `UP_RATIO` and the mean work time under
 * `UP_MEAN_MS` lasting `UP_BASE_MS`, doubled for every time the level above has failed before this once, capped at
 * `UP_CAP_MS`. 1 never steps down, 5 never up, no level is ever barred.
 */
export class AutoQuality {
  #level: Level;
  /** Oldest first; trimmed to the window on every feed. */
  #frames: Frame[] = [];
  #misses = 0;
  #sumIntervalMs = 0;
  #sumWorkMs = 0;
  #windowMs = WINDOW_FAST_MS;
  /** When feeding began — the window is judged full `windowMs` after it. */
  #firstAt: number | null = null;
  /** Start of the current stretch with the ratio under UP_RATIO. */
  #calmSince: number | null = null;
  /** Start of the current stretch that qualifies for a step up (calm and with headroom). */
  #stableSince: number | null = null;
  #lastStepAt: number | null = null;
  #lastChange: "down" | "up" | null = null;
  /** Step-downs taken from each level, ever (this page load). */
  readonly #failures: Record<Level, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  constructor(start: Level = START_LEVEL) {
    this.#level = start;
  }

  get status(): AutoStatus {
    const n = this.#frames.length;
    const missRatio = n === 0 ? 0 : this.#misses / n;
    return {
      level: this.#level,
      missRatio,
      meanIntervalMs: n === 0 ? 0 : this.#sumIntervalMs / n,
      meanWorkMs: n === 0 ? 0 : this.#sumWorkMs / n,
      stable: missRatio < UP_RATIO,
      lastChange: this.#lastChange,
    };
  }

  feed({ nowMs, intervalMs, workMs, quiet }: AutoInput): AutoStatus {
    this.#firstAt ??= nowMs;
    this.#push({ t: nowMs, interval: intervalMs, work: workMs, miss: intervalMs > missThresholdMs(this.#level) });
    this.#trim(nowMs);
    let ratio = this.#ratio();

    // the window: long after a quiet minute, back to short as soon as misses climb over UP_RATIO
    this.#calmSince = ratio < UP_RATIO ? (this.#calmSince ?? nowMs) : null;
    const windowMs = this.#calmSince !== null && nowMs - this.#calmSince >= QUIET_MINUTE_MS ? WINDOW_SLOW_MS : WINDOW_FAST_MS;
    if (windowMs < this.#windowMs) {
      this.#windowMs = windowMs;
      this.#trim(nowMs);
      ratio = this.#ratio();
    } else this.#windowMs = windowMs;

    const n = this.#frames.length;
    const meanWorkMs = n === 0 ? 0 : this.#sumWorkMs / n;
    this.#stableSince = ratio < UP_RATIO && meanWorkMs < UP_MEAN_MS ? (this.#stableSince ?? nowMs) : null;

    // a verdict needs a window that is full (not the first seconds after load) and actually holds frames: a gap evicts
    // everything before it, and the one frame after it must not be judged alone
    const full = nowMs - this.#firstAt >= this.#windowMs;
    const populated = n >= MIN_SAMPLES && nowMs - this.#frames[0]!.t >= this.#windowMs / 2;
    const cooled = this.#lastStepAt === null || nowMs - this.#lastStepAt >= DOWN_COOLDOWN_MS;
    if (this.#level > 1 && full && populated && cooled && ratio > DOWN_RATIO && (quiet || ratio > SEVERE_RATIO)) {
      this.#failures[this.#level]++;
      this.#level = down(this.#level);
      this.#step(nowMs, "down");
    } else if (this.#level < 5 && quiet && cooled && this.#stableSince !== null && nowMs - this.#stableSince >= this.#upWaitMs(up(this.#level))) {
      this.#level = up(this.#level);
      this.#step(nowMs, "up");
    }
    return this.status;
  }

  #step(nowMs: number, change: "down" | "up"): void {
    this.#lastStepAt = nowMs;
    this.#lastChange = change;
    this.#stableSince = null; // the next stretch is judged at the new level
  }

  /** The stable stretch a return to `level` needs: the base, doubled for every failure of that level before the latest one. */
  #upWaitMs(level: Level): number {
    return Math.min(UP_CAP_MS, UP_BASE_MS * 2 ** Math.max(0, this.#failures[level] - 1));
  }

  #push(frame: Frame): void {
    this.#frames.push(frame);
    this.#sumIntervalMs += frame.interval;
    this.#sumWorkMs += frame.work;
    if (frame.miss) this.#misses++;
  }

  #trim(nowMs: number): void {
    const oldest = nowMs - this.#windowMs;
    let drop = 0;
    while (drop < this.#frames.length && this.#frames[drop]!.t <= oldest) {
      const f = this.#frames[drop]!;
      this.#sumIntervalMs -= f.interval;
      this.#sumWorkMs -= f.work;
      if (f.miss) this.#misses--;
      drop++;
    }
    if (drop > 0) this.#frames.splice(0, drop);
  }

  #ratio(): number {
    return this.#frames.length === 0 ? 0 : this.#misses / this.#frames.length;
  }
}

/** The level in force: the debug force, else the setting, else Auto's. `feed` is a no-op unless Auto is in charge. */
export class QualityController {
  readonly #setting: () => QualitySetting;
  readonly #forced: Level | null;
  readonly #auto = new AutoQuality();

  constructor(setting: () => QualitySetting, forced: Level | null) {
    this.#setting = setting;
    this.#forced = forced;
  }

  feed(nowMs: number, intervalMs: number, workMs: number, quiet: boolean): void {
    if (this.mode === "auto") this.#auto.feed({ nowMs, intervalMs, workMs, quiet });
  }

  get mode(): "auto" | "manual" {
    return this.#forced === null && this.#setting() === "auto" ? "auto" : "manual";
  }

  get spec(): LevelSpec {
    return LEVELS[this.#level()];
  }

  get status(): AutoStatus {
    if (this.mode === "auto") return this.#auto.status;
    return { level: this.#level(), missRatio: 0, meanIntervalMs: 0, meanWorkMs: 0, stable: true, lastChange: null };
  }

  report(webgl: boolean): OverlayReport {
    const { level, missRatio, stable } = this.status;
    return { type: "quality", level, mode: this.mode, missRatio, webgl, stable };
  }

  #level(): Level {
    if (this.#forced !== null) return this.#forced;
    const setting = this.#setting();
    return setting === "auto" ? this.#auto.status.level : setting;
  }
}

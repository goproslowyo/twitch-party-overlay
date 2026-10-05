/**
 * Contributor Motes: everyone whose money is in an Unlock, as a ring in
 * the free sky — nobody's name, ever. The wire (`MoteWire`) says who is `collecting` toward the next Threshold
 * and which groups are `ready`; this module keeps a body per Mote and moves it: a new key spawns at the thank line
 * and rises to loiter in the sky; a READY group drifts under the airship and holds there in rows; `fire(group)` arms
 * the group, and once a jumper with that fireSeq is in the air the group orbits it (an ellipse at `r × [1.2, 2.2]`,
 * never inside the pilot's radius) all the way down; a landing is a soft outward burst fading over a second;
 * `rearmed` brings a group back under the airship. A key whose cents grew pulses the gold ring once for 900 ms (a
 * single swell, no oscillation — every flash ≤ 2 Hz). The Level's cap (`LevelSpec.motes`) is applied at draw in two
 * tiers: a fired group (armed / orbiting / bursting — the feature's payoff) is ranked first, and what the cap has left
 * goes to the loitering and READY cloud; within a tier the largest cents first, then the first seen — never random,
 * and a re-tip reorders nothing (it only pulses gold). Bodies are matched to the wire by key and
 * groups by shared keys, so a crossing MOVES a mote from the collecting cloud into its READY group and the queue
 * shifting when the front group fires respawns nothing. A key may sit in two groups (a tipper crossing twice): those
 * are two motes. Centres stay in the sky (`[skyL, skyR] × [skyTop, skyBottom]`) except while orbiting a jumper or
 * bursting, when they follow it below the horizon (x is still clamped: never over the rack). Time and dice arrive as
 * parameters (the scene's child rng): nothing here reads a clock or rolls its own dice.
 */
import type { Theme } from "../../config/schema.ts";
import type { Mote, MoteWire } from "../../server/overlay.ts";
import { intensity } from "../celebration.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { JUMPER_K, PILOT_FEET, RISER_DROP, type Jumper } from "./jumper.ts";
import { clamp, glyph, rgba } from "./util.ts";

export const MOTE_MIN_PX = 28;
export const MOTE_MAX_PX = 52;
export const MOTE_MIN_ALPHA = 0.35;
export const MOTE_MAX_ALPHA = 0.7;
/** A fired group (armed / orbiting) is drawn at least this bright — the payoff has to read at 1080p, whatever its cents (task-99 item 7). */
export const ORBIT_ALPHA_MIN = 0.8;
/** A burst starts here and fades to nothing over BURST_MS (one ramp down: no flash). */
export const BURST_ALPHA = 1;
/** The gold ring after a key's cents grew: one swell, this long. */
export const GOLD_MS = 900;
/** A landing's burst: outward, fading to nothing by the end. */
export const BURST_MS = 1000;
/** The orbit band about a jumper, in multiples of its radius. */
export const ORBIT_MIN = 1.2;
export const ORBIT_MAX = 2.2;
/** The ease from where a mote held into its orbit slot. */
export const ORBIT_IN_MS = 500;
/** The free sky's top: under the frame's margin, never over the top edge. */
export const SKY_TOP = 40;
/** The sheet's sky ends this far above the lit horizon (the towers' feet), so a ring never crosses it. */
export const SKY_ABOVE_HORIZON = 30;
/** The club-deck has no horizon line: its sky ends this far above the ground line. */
export const CLUB_SKY_ABOVE_GROUND = 240;
/** `mote-ring`'s ring radius and inner disc at k = 1 (scripts/sprites/draw.ts). */
export const RING_R = 22;
export const PIC_R = 20;

const TAU = Math.PI * 2;
const PLATE_FRAME = 256;
const PLATE_K = 1.3;
const PLATE_ALPHA = 0.55;
const CLUB_FILL_ALPHA = 0.55;
const CLUB_LINE = 2.5;
/** The hold under the airship: the first row this far under its centre — the sheet gondola ends 134 below it, the club-deck sign 164 — so the largest ring's top clears both; rows below that. */
const HOLD_BELOW = 180;
const HOLD_ROW = 44;
const HOLD_SPACING = 40;
const HOLD_PER_ROW = 12;
const HOLD_BOB_PX = 4;
const HOLD_BOB_MS = 900;
/** The loitering cloud: inset from the sky's edges, its band under the airship's patrol lane (the gondola ends 254 under the top, plus a ring) and over the horizon. */
const LOITER_INSET = 80;
const LOITER_TOP = 240;
const LOITER_BOTTOM = 80;
const DRIFT_X_PX = 18;
const DRIFT_Y_PX = 10;
const DRIFT_X_MS = 2300;
const DRIFT_Y_MS = 1700;
const WIND_PX_PER_FRAME = 0.4;
/** The loitering spread: the n-th mote's slot in the cloud from the R2 low-discrepancy sequence (even however the rng's early draws fall), jittered a little by its seed. */
const SPREAD_X = 0.7548776662466927;
const SPREAD_Y = 0.5698402909980532;
const SPREAD_JITTER = 0.04;
/** The eases: the rise to the loiter, the drift to the hold. */
const RISE_TAU_MS = 900;
const HOLD_TAU_MS = 450;
const ORBIT_PERIOD_MS = 3600;
/** The orbit's vertical squash: with radii in [1.6, 2.2] r the distance stays within [1.2, 2.2] r. */
const ORBIT_SQUASH = 0.75;
const ORBIT_R_MIN = ORBIT_MIN / ORBIT_SQUASH;
const BURST_PX = 90;
const BURST_LIFT_PX = 20;
const GOLD_SWELL = 0.15;
const FRAME_MS = 16.67;
const SPARKS = 3;
const SPARK_R = 1.6;
/** The club-deck rig: canopy radius 46 × canopy; the orbit centre a little up from the pilot. */
const CLUB_RIG_R = 60;
const CLUB_RIG_UP = 40;
/** The sheet rig stands RISER_DROP + PILOT_FEET tall at JUMPER_K × canopy; the orbit centre and radius take about half of it. */
const SHEET_RIG_FRACTION = 0.55;

export type MoteKind = "collecting" | "ready" | "armed" | "orbit" | "burst";

/** What `Motes.step` needs from the scene each frame. */
export interface MoteFrame {
  skyL: number;
  skyR: number;
  skyTop: number;
  skyBottom: number;
  wind: (x: number, y: number) => { x: number; y: number };
  airship: { x: number; y: number };
  jumpers: ReadonlyArray<{ fireSeq: number; x: number; y: number; r: number }>;
  /** Whether the rack shows READY: the ready groups gather under the airship only then. */
  ready: boolean;
}

/** A read-only look at one mote (tests, the debug bar). */
export interface MoteBody {
  key: string;
  x: number;
  y: number;
  /** The fade factor (1 until a burst; 0 at its end) — the drawn alpha is moteSize's × this. */
  alpha: number;
  kind: MoteKind;
  fireSeq: number | null;
  gold: boolean;
}

interface Body {
  mote: Mote;
  x: number;
  y: number;
  /** False until the first step places it (a body born with no known place: the first sync, a fire with no group on screen). */
  placed: boolean;
  seed: number;
  phase: number;
  /** Its slot in the loitering cloud, 0..1 on each axis: stratified by spawn order, not drawn. */
  spread: { x: number; y: number };
  /** First-seen order — the cap's tiebreak; never changed by growth, so a re-tip pops no ring in or out. */
  recency: number;
  grewAt: number | null;
  gold: boolean;
  /** How far through the gold swell, 0..1 (0 when not gold) — set by `step`, read by `draw`. */
  goldU: number;
  fade: number;
  orbitFrom: { x: number; y: number } | null;
  burst: { at: number; x0: number; y0: number; dx: number; dy: number } | null;
}

interface Group {
  kind: MoteKind;
  fireSeq: number | null;
  bodies: Body[];
  orbitAt: number;
  /** The last orbit centre: where a burst starts when the jumper leaves the air without a `landed` call. */
  last: { x: number; y: number } | null;
}

/** The ring from the contribution's intensity (celebration.ts): 28 px / 0.35 at $1 and below, 52 px / 0.7 at the anchor and above. */
export function moteSize(cents: number, anchorCents: number): { px: number; alpha: number } {
  const i = intensity(cents, anchorCents);
  return { px: MOTE_MIN_PX + (MOTE_MAX_PX - MOTE_MIN_PX) * i, alpha: MOTE_MIN_ALPHA + (MOTE_MAX_ALPHA - MOTE_MIN_ALPHA) * i };
}

/** The `cap` items to keep: the largest `cents` first, ties to the most `recent` (given the item and its index); returned in their original order — the list itself when nothing is cut. Pure, never random. */
function thinBy<T>(items: readonly T[], cap: number, cents: (t: T) => number, recent: (t: T, i: number) => number): readonly T[] {
  if (!(cap < items.length)) return items;
  if (cap <= 0) return [];
  return items
    .map((t, i) => ({ t, i, c: cents(t), r: recent(t, i) }))
    .sort((a, b) => b.c - a.c || b.r - a.r || a.i - b.i)
    .slice(0, cap)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.t);
}

/** `cap` of `motes`: the largest cents, then the most recent (later in the wire's list = newer); the wire's order kept. */
export function thin(motes: readonly Mote[], cap: number): Mote[] {
  return [...thinBy(motes, cap, (m) => m.cents, (_, i) => i)];
}

/** The free sky for the layout: the scene's own span beside the rack, from SKY_TOP down to just over the sheet's horizon (the club-deck's: well over its ground line). Never over the rack, never below the horizon. */
export function moteSky(L: { sceneL: number; sceneR: number; horizonY: number; gy: number }, sheet: boolean): Pick<MoteFrame, "skyL" | "skyR" | "skyTop" | "skyBottom"> {
  return { skyL: L.sceneL, skyR: L.sceneR, skyTop: SKY_TOP, skyBottom: sheet ? L.horizonY - SKY_ABOVE_HORIZON : L.gy - CLUB_SKY_ABOVE_GROUND };
}

/** Where a jumper's rig is for the orbit: its centre up from the feet (`J.y`), at the corkscrew's swing, and its radius — the sheet rig is the taller. */
export function jumperOrbit(J: Pick<Jumper, "fireSeq" | "x" | "y" | "canopy" | "spiralOff">, sheet: boolean): { fireSeq: number; x: number; y: number; r: number } {
  const x = J.x + J.spiralOff;
  if (!sheet) return { fireSeq: J.fireSeq, x, y: J.y - CLUB_RIG_UP * J.canopy, r: CLUB_RIG_R * J.canopy };
  const half = (RISER_DROP + PILOT_FEET) * JUMPER_K * J.canopy * SHEET_RIG_FRACTION;
  return { fireSeq: J.fireSeq, x, y: J.y - half, r: half };
}

const shared = (a: readonly Mote[], b: readonly Body[]): number => {
  const keys = new Set(b.map((x) => x.mote.key));
  let n = 0;
  for (const m of a) if (keys.has(m.key)) n++;
  return n;
};

/** Jaccard over keys: what fraction of the union the two share (0 when either is empty). */
const overlap = (a: readonly Mote[], b: readonly Body[]): number => {
  const n = shared(a, b);
  const union = new Set([...a.map((m) => m.key), ...b.map((x) => x.mote.key)]).size;
  return union === 0 ? 0 : n / union;
};

const bodyCents = (b: Body): number => b.mote.cents;
const bodyRecency = (b: Body): number => b.recency;
const ease = (from: number, to: number, dtMs: number, tauMs: number): number => from + (to - from) * (1 - Math.exp(-dtMs / tauMs));
const smooth = (u: number): number => u * u * (3 - 2 * u);

export class Motes {
  readonly #rng: () => number;
  readonly #anchor: () => number;
  readonly #groups: Group[] = [];
  readonly #collecting: Group = { kind: "collecting", fireSeq: null, bodies: [], orbitAt: 0, last: null };
  #synced = false;
  #recency = 0;
  /** The last stepped clock: a fade begun between frames (fire's leftovers) starts here, not at 0. */
  #tMs = 0;
  /** Per-frame scratch, reused so `step` and `draw` allocate nothing steady-state. */
  readonly #jumpers = new Map<number, MoteFrame["jumpers"][number]>();
  readonly #rows = new Map<Group, number>();
  readonly #fired: Body[] = [];
  readonly #cloud: Body[] = [];
  readonly #target = { x: 0, y: 0 };

  constructor(rng: () => number, anchorCents: () => number) {
    this.#rng = rng;
    this.#anchor = anchorCents;
    this.#groups.push(this.#collecting);
  }

  /** Every mote on screen, in draw order (before the Level's cap). */
  bodies(): MoteBody[] {
    const out: MoteBody[] = [];
    for (const g of this.#groups) for (const b of g.bodies) out.push({ key: b.mote.key, x: b.x, y: b.y, alpha: b.fade, kind: b.burst === null ? g.kind : "burst", fireSeq: g.fireSeq, gold: b.gold });
    return out;
  }

  #spawn(m: Mote, at: { x: number; y: number } | null): Body {
    const n = ++this.#recency;
    const seed = this.#rng();
    const jitter = (seed - 0.5) * 2 * SPREAD_JITTER;
    const spread = { x: clamp(((n * SPREAD_X) % 1) + jitter, 0, 1), y: clamp(((n * SPREAD_Y) % 1) - jitter, 0, 1) };
    return { mote: m, x: at?.x ?? 0, y: at?.y ?? 0, placed: at !== null, seed, phase: this.#rng() * TAU, spread, recency: n, grewAt: null, gold: false, goldU: 0, fade: 1, orbitFrom: null, burst: null };
  }

  /** A body that must leave without a landing (voided, adjusted away): it fades where it is over BURST_MS. */
  #fade(b: Body, tMs: number): void {
    if (b.burst === null) b.burst = { at: tMs, x0: b.x, y0: b.y, dx: 0, dy: 0 };
  }

  /**
   * Bring `g.bodies` to `motes`: kept keys update (a grown one pulses gold), new keys come from `moving` (a body that
   * just left another group this sync — a crossing) or spawn at `at`, gone keys go to `leaving` for the caller to
   * move or fade. The bodies end in the wire's order.
   */
  #reconcile(g: Group, motes: readonly Mote[], tMs: number, at: { x: number; y: number } | null, leaving: Map<string, Body>, moving: Map<string, Body>, gold: boolean): void {
    const have = new Map<string, Body>();
    for (const b of g.bodies) if (b.burst === null) have.set(b.mote.key, b);
    const next: Body[] = [];
    for (const m of motes) {
      let b = have.get(m.key);
      if (b !== undefined) {
        have.delete(m.key);
        if (m.cents > b.mote.cents && gold) b.grewAt = tMs; // the gold swell; its place in the cap's order stays first-seen
        b.mote = m;
      } else {
        const moved = moving.get(m.key);
        if (moved !== undefined) {
          moving.delete(m.key);
          b = moved;
          b.mote = m;
          b.burst = null;
          b.fade = 1;
        } else b = this.#spawn(m, at);
      }
      next.push(b);
    }
    for (const b of have.values()) leaving.set(b.mote.key, b);
    g.bodies = [...next, ...g.bodies.filter((b) => b.burst !== null)];
  }

  /** The wire's motes as of `tMs`: new keys spawn at `spawnAt` (the thank line) — on the very first sync they take their places at once. */
  sync(view: MoteWire, tMs: number, spawnAt: { x: number; y: number }): void {
    const at = this.#synced ? spawnAt : null;
    this.#synced = true;
    const leaving = new Map<string, Body>();
    const moving = new Map<string, Body>();
    // 1. the collecting cloud: whoever left it this sync may be crossing into a READY group
    this.#reconcile(this.#collecting, view.collecting, tMs, at, leaving, moving, true);
    for (const [k, b] of leaving) moving.set(k, b);
    leaving.clear();
    // 2. the READY groups, matched to the groups on screen by shared keys (the queue shifts; a rebank puts one back at the front)
    const pool = this.#groups.filter((g) => g.kind === "ready");
    const matched = new Set<Group>();
    const pairs: Array<[Mote[], Group]> = [];
    for (const wire of view.ready) {
      let best: Group | null = null;
      let score = 0;
      for (const g of pool) {
        if (matched.has(g)) continue;
        const s = overlap(wire, g.bodies);
        if (s > score) {
          best = g;
          score = s;
        }
      }
      if (best === null) {
        best = { kind: "ready", fireSeq: null, bodies: [], orbitAt: 0, last: null };
        this.#groups.push(best);
      }
      matched.add(best);
      pairs.push([wire, best]);
    }
    for (const [wire, g] of pairs) this.#reconcile(g, wire, tMs, at, leaving, moving, true);
    for (const g of pool) if (!matched.has(g)) for (const b of g.bodies) this.#fade(b, tMs);
    // 3. whoever left with nowhere to go fades where it is
    for (const b of [...leaving.values(), ...moving.values()]) {
      this.#fade(b, tMs);
      this.#collecting.bodies.push(b);
    }
  }

  /** A `drop` effect: the READY group behind it (matched by shared keys; built afresh if the wire shifted first) is armed to orbit the jumper with `fireSeq`. */
  fire(group: Mote[], fireSeq: number): void {
    let best: Group | null = null;
    let score = 0;
    for (const g of this.#groups) {
      if (g.kind !== "ready") continue;
      const s = overlap(group, g.bodies);
      if (s > score) {
        best = g;
        score = s;
      }
    }
    const moving = new Map<string, Body>();
    if (best === null) {
      // no READY group on screen for it (the fire came before a frame saw the crossing): the collecting cloud's motes are its people — they fly, not fade
      best = { kind: "ready", fireSeq: null, bodies: [], orbitAt: 0, last: null };
      this.#groups.push(best);
      const keys = new Set(group.map((m) => m.key));
      for (const b of this.#collecting.bodies) if (b.burst === null && keys.has(b.mote.key) && !moving.has(b.mote.key)) moving.set(b.mote.key, b);
      this.#collecting.bodies = this.#collecting.bodies.filter((b) => moving.get(b.mote.key) !== b);
    }
    const leaving = new Map<string, Body>();
    this.#reconcile(best, group, this.#tMs, null, leaving, moving, false);
    for (const b of leaving.values()) {
      this.#fade(b, this.#tMs);
      best.bodies.push(b);
    }
    best.kind = "armed";
    best.fireSeq = fireSeq;
    best.orbitAt = 0;
    best.last = null;
  }

  /** The jumper with `fireSeq` touched down at (x, y): its group bursts softly outward from there and fades over BURST_MS. */
  landed(fireSeq: number, x: number, y: number, tMs: number): void {
    const g = this.#groups.find((g) => g.fireSeq === fireSeq && (g.kind === "orbit" || g.kind === "armed"));
    if (g !== undefined) this.#burst(g, x, y, tMs);
  }

  #burst(g: Group, x: number, y: number, tMs: number): void {
    g.kind = "burst";
    const n = g.bodies.length;
    for (let j = 0; j < n; j++) {
      const b = g.bodies[j]!;
      if (b.burst !== null) continue;
      let dx = b.x - x;
      let dy = b.y - y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        const a = b.phase + (j * TAU) / Math.max(1, n);
        dx = Math.cos(a);
        dy = Math.sin(a);
      } else {
        dx /= d;
        dy /= d;
      }
      b.burst = { at: tMs, x0: b.x, y0: b.y, dx, dy };
    }
  }

  /** The fire with `fireSeq` is pending again: its group holds under the airship until a jumper with that seq is back in the air. */
  rearmed(fireSeq: number): void {
    const g = this.#groups.find((g) => g.fireSeq === fireSeq && (g.kind === "orbit" || g.kind === "armed"));
    if (g === undefined) return;
    g.kind = "armed";
    g.orbitAt = 0;
    g.last = null;
    for (const b of g.bodies) b.orbitFrom = null;
  }

  /** The loitering place in the sky for `b`: its stratified slot in the cloud, drifting on two slow sines and nudged by the wind. (Fills and returns the shared scratch target.) */
  #loiter(b: Body, f: MoteFrame, tMs: number): { x: number; y: number } {
    const w = f.skyR - f.skyL - 2 * LOITER_INSET;
    const h = f.skyBottom - f.skyTop - LOITER_TOP - LOITER_BOTTOM;
    const t = this.#target;
    t.x = f.skyL + LOITER_INSET + Math.max(0, w) * b.spread.x + DRIFT_X_PX * Math.sin(tMs / DRIFT_X_MS + b.phase);
    t.y = f.skyTop + LOITER_TOP + Math.max(0, h) * b.spread.y + DRIFT_Y_PX * Math.sin(tMs / DRIFT_Y_MS + b.phase * 1.7);
    return t;
  }

  /** Slot `j` of the `n` LIVE members (a fading corpse holds no slot) in hold row `row` under the airship, wrapped HOLD_PER_ROW to a row, bobbing gently. */
  #hold(b: Body, j: number, n: number, row: number, f: MoteFrame, tMs: number): { x: number; y: number } {
    const r = Math.floor(j / HOLD_PER_ROW);
    const inRow = Math.min(HOLD_PER_ROW, n - r * HOLD_PER_ROW);
    const c = (j % HOLD_PER_ROW) - (inRow - 1) / 2;
    const t = this.#target;
    t.x = f.airship.x + c * HOLD_SPACING;
    t.y = f.airship.y + HOLD_BELOW + (row + r) * HOLD_ROW + Math.abs(c) * 3 + HOLD_BOB_PX * Math.sin(tMs / HOLD_BOB_MS + b.phase);
    return t;
  }

  /** One frame: every group toward its place; arming groups catch their jumper; a jumper gone from the air is a landing; bursts fade and go. */
  step(tMs: number, dtMs: number, f: MoteFrame): void {
    this.#tMs = tMs;
    const k = clamp(dtMs / FRAME_MS, 0, 4);
    const anchor = this.#anchor();
    const jumperOf = this.#jumpers;
    jumperOf.clear();
    for (const J of f.jumpers) jumperOf.set(J.fireSeq, J);
    let row = 0;
    const rows = this.#rows;
    rows.clear();
    for (const g of this.#groups) if (g.kind === "armed") rows.set(g, row++);
    for (const g of this.#groups) if (g.kind === "ready" && f.ready) rows.set(g, row++);
    for (const g of this.#groups) {
      const J = g.fireSeq === null ? undefined : jumperOf.get(g.fireSeq);
      if (g.kind === "armed") {
        if (J !== undefined) {
          g.kind = "orbit";
          g.orbitAt = tMs;
          for (const b of g.bodies) b.orbitFrom = b.placed ? { x: b.x, y: b.y } : null;
        }
      } else if (g.kind === "orbit" && J === undefined) {
        const at = g.last ?? f.airship;
        this.#burst(g, at.x, at.y, tMs);
      }
      // the live members: a fading corpse holds no slot in the row or the orbit
      let live = 0;
      for (const b of g.bodies) if (b.burst === null) live++;
      const held = rows.get(g);
      const orbitTurn = (TAU * (tMs - g.orbitAt)) / ORBIT_PERIOD_MS;
      const orbitIn = smooth(clamp((tMs - g.orbitAt) / ORBIT_IN_MS, 0, 1));
      let li = 0;
      let expired = false;
      for (const b of g.bodies) {
        b.gold = b.grewAt !== null && tMs - b.grewAt < GOLD_MS;
        b.goldU = b.gold && b.grewAt !== null ? clamp((tMs - b.grewAt) / GOLD_MS, 0, 1) : 0;
        const { px } = moteSize(b.mote.cents, anchor);
        let sky = true;
        if (b.burst !== null) {
          const u = clamp((tMs - b.burst.at) / BURST_MS, 0, 1);
          if (u >= 1) expired = true;
          const out = BURST_PX * (1 - (1 - u) * (1 - u));
          b.x = b.burst.x0 + b.burst.dx * out;
          b.y = b.burst.y0 + b.burst.dy * out - BURST_LIFT_PX * u;
          b.fade = 1 - u;
          sky = g.kind !== "burst";
        } else if (g.kind === "orbit" && J !== undefined) {
          const a = b.phase + (TAU * li++) / Math.max(1, live) + orbitTurn;
          const R = J.r * (ORBIT_R_MIN + (ORBIT_MAX - ORBIT_R_MIN) * b.seed);
          const tx = J.x + R * Math.cos(a);
          const ty = J.y + R * Math.sin(a) * ORBIT_SQUASH;
          if (b.orbitFrom === null) {
            b.x = tx;
            b.y = ty;
          } else {
            b.x = b.orbitFrom.x + (tx - b.orbitFrom.x) * orbitIn;
            b.y = b.orbitFrom.y + (ty - b.orbitFrom.y) * orbitIn;
          }
          b.placed = true;
          if (g.last === null) g.last = { x: J.x, y: J.y };
          else {
            g.last.x = J.x;
            g.last.y = J.y;
          }
          sky = false;
        } else {
          const target = held === undefined ? this.#loiter(b, f, tMs) : this.#hold(b, li++, live, held, f, tMs);
          const tau = held === undefined ? RISE_TAU_MS : HOLD_TAU_MS;
          if (!b.placed) {
            b.x = target.x;
            b.y = target.y;
            b.placed = true;
          } else {
            const w = f.wind(b.x, b.y);
            b.x = ease(b.x + w.x * WIND_PX_PER_FRAME * k, target.x, dtMs, tau);
            b.y = ease(b.y, target.y, dtMs, tau);
          }
        }
        b.x = clamp(b.x, f.skyL + px / 2, f.skyR - px / 2);
        b.y = sky ? clamp(b.y, f.skyTop, f.skyBottom) : Math.max(f.skyTop, b.y);
      }
      if (expired) g.bodies = g.bodies.filter((b) => b.burst === null || tMs - b.burst.at < BURST_MS);
    }
    for (let i = this.#groups.length - 1; i >= 0; i--) {
      const g = this.#groups[i]!;
      if (g !== this.#collecting && g.bodies.length === 0) this.#groups.splice(i, 1);
    }
  }

  /**
   * The rings under the Level's cap, in two tiers: a fired group (armed / orbiting / bursting) first — the payoff is
   * never thinned away by a rich loiterer — then the loitering and READY cloud with what is left; within a tier the
   * largest cents, then the first seen. Sheet: a `plate` under, the Avatar Picture through an arc clip (or the Avatar
   * Glyph; an anonymous mote holds neither), then `mote-ring` — `mote-ring-gold` for the swell after growth — tinted
   * from the Theme. Club-deck: the same in a stroked circle. No name, no text but the glyph. The cloud is drawn
   * first, the fired group over it.
   */
  draw(ctx: CanvasRenderingContext2D, theme: Theme, sprites: SpriteSet | null, spec: LevelSpec, avatarImage: (m: Mote) => CanvasImageSource | null): void {
    const fired = this.#fired;
    const cloud = this.#cloud;
    fired.length = 0;
    cloud.length = 0;
    for (const g of this.#groups) {
      const tier = g.kind === "collecting" || g.kind === "ready" ? cloud : fired;
      for (const b of g.bodies) tier.push(b);
    }
    const keptFired = thinBy(fired, spec.motes, bodyCents, bodyRecency);
    const keptCloud = thinBy(cloud, spec.motes - keptFired.length, bodyCents, bodyRecency);
    if (keptFired.length + keptCloud.length === 0) return;
    const anchor = this.#anchor();
    const s = spec.spriteScale;
    const prevAlpha = ctx.globalAlpha;
    for (const b of keptCloud) this.#drawOne(ctx, theme, sprites, s, anchor, prevAlpha, avatarImage, b, false);
    for (const b of keptFired) this.#drawOne(ctx, theme, sprites, s, anchor, prevAlpha, avatarImage, b, true);
    ctx.globalAlpha = prevAlpha;
  }

  /** `fired`: an armed / orbiting / bursting body — drawn at the airborne floor (a burst from full), the cloud at its cents' alpha. */
  #drawOne(ctx: CanvasRenderingContext2D, theme: Theme, sprites: SpriteSet | null, s: LevelSpec["spriteScale"], anchor: number, prevAlpha: number, avatarImage: (m: Mote) => CanvasImageSource | null, b: Body, fired: boolean): void {
    const { px, alpha } = moteSize(b.mote.cents, anchor);
    const a = (b.burst !== null && (b.burst.dx !== 0 || b.burst.dy !== 0) ? BURST_ALPHA : fired ? Math.max(alpha, ORBIT_ALPHA_MIN) : alpha) * b.fade;
    if (a <= 0.005) return;
    const swell = b.gold ? 1 + GOLD_SWELL * Math.sin(Math.PI * b.goldU) : 1;
    const k = (px / (2 * RING_R)) * swell;
    const colour = b.gold ? theme.gold : theme.accent;
    const x = b.x;
    const y = b.y;
    if (sprites !== null) sprites.draw(ctx, "plate", s, x, y, { k: (px * PLATE_K) / PLATE_FRAME, alpha: PLATE_ALPHA * a });
    else {
      ctx.globalAlpha = prevAlpha * a * CLUB_FILL_ALPHA;
      ctx.fillStyle = theme.panel;
      ctx.beginPath();
      ctx.arc(x, y, PIC_R * k, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = prevAlpha * a;
    if (b.mote.name !== null) {
      const img = avatarImage(b.mote);
      if (img !== null) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, PIC_R * k, 0, TAU);
        ctx.clip();
        ctx.drawImage(img, x - PIC_R * k, y - PIC_R * k, 2 * PIC_R * k, 2 * PIC_R * k);
        ctx.restore();
      } else if (b.mote.avatar !== "") glyph(ctx, b.mote.avatar, x, y + 1, Math.round(PIC_R * k * 1.25));
    }
    if (sprites !== null) sprites.draw(ctx, b.gold ? "mote-ring-gold" : "mote-ring", s, x, y, { colour, k, alpha: a });
    else {
      ctx.strokeStyle = colour;
      ctx.lineWidth = CLUB_LINE * k;
      ctx.beginPath();
      ctx.arc(x, y, RING_R * k, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(colour, 0.35);
      ctx.lineWidth = CLUB_LINE * 2.4 * k;
      ctx.stroke();
    }
    if (b.burst !== null && (b.burst.dx !== 0 || b.burst.dy !== 0)) {
      // the landing's sparks: a few, flung a little ahead of the ring, going with it
      const reach = RING_R * k * (1 + SPARK_R * (1 - b.fade));
      for (let i = 0; i < SPARKS; i++) {
        const ang = b.phase + (TAU * i) / SPARKS;
        const sx = x + Math.cos(ang) * reach;
        const sy = y + Math.sin(ang) * reach;
        if (sprites !== null) sprites.draw(ctx, `mote-spark-${i}`, s, sx, sy, { colour: theme.gold, k, alpha: a });
        else {
          ctx.fillStyle = theme.gold;
          ctx.beginPath();
          ctx.arc(sx, sy, 2 * k, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = prevAlpha;
  }
}

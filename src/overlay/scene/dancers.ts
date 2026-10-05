/**
 * The Dancers (ported in spirit from an earlier dancers prototype): a living far
 * floor for a sheet Theme — a roster of max(`ROSTER`, the Active Chatters) up to the Level's cap (`sync`), on three
 * depth rows between the horizon and the pad strip, in pairs, groups and loners, each on its own beat, bob and pose cycle; a group waves (`up`) when a sweep's
 * pool passes it; every 20–60 s someone leaves for an edge and a newcomer walks in from one, in profile, facing the
 * way they travel. Never tied to the Ledger or a contributor; drawn at every Quality Level (only the Sheet Scale
 * changes); never an empty club, never static.
 *
 * The zone is the scene's span less the six tower bases (`towerBands`: the base rects from towers.ts widened by the
 * row's own figure half-width) — nobody stands in front of a tower, nobody is on the pad strip (`ROWS` end well above
 * the ground line), and nobody is under the rack because `sceneLayout` stops the span 70 px short of the rack panel
 * (the span rule covers it; there is no separate rack exclusion). A walker arriving or leaving never crosses a band
 * either (task-99 MUST 6 — on a still a transit read as a figure in front of a tower base): it appears at, and walks
 * to, the inner edge of the free segment its home is in, fading in over the first 1.4 s and out over its walk to the edge (at most the last 160 px),
 * so no Dancer — standing or walking — is ever inside a band. The frame arrives with `draw`
 * (`layout` remaps the roster into a new one — a resize or the rack swapping sides); until then the roster lives in
 * `DEFAULT_FRAME`.
 *
 * Drawing: the `dancer-<pose>-<i>` body plate never tints; its `-rim` Master is tinted the nearest sweep's
 * colour, brighter the closer the sweep; a reflection — the same frames under a negative y scale about the feet — goes
 * first at a fraction of the alpha. Walkers use the profile `walk` frames with `flipX` when travelling leftwards and,
 * flipped, the pre-mirrored `-rim-flip` rim drawn with the SAME flip (scripts/sprites/draw.ts). With no sheet
 * the capsule figure from `figure(p)` is stroked procedurally. Time and dice arrive as parameters (the loop's `tMs`
 * and the scene's rng) — nothing here reads a clock, rolls its own dice, or sets a canvas filter or shadow.
 */
import type { Theme } from "../../config/schema.ts";
import type { LevelSpec } from "../quality.ts";
import type { Chatter } from "../../server/overlay.ts";
import type { SpriteSet } from "../sprites.ts";
import { avatarFor } from "../theme.ts";
import { DANCE, FIGURE_W, FLOOR_Y, MOVES, POSES, assertNoNaN, figure, type Figure, type PoseName } from "./dancer-figure.ts";
import { TOWER_W, sheetTowerX, sweepPlacement, towerColour, type Tower, type TowerFrame } from "./towers.ts";
import { clamp, glyph, roundRect } from "./util.ts";

export const ROSTER = 24;
/** Three depth rows: `y` as a share of the floor from the horizon to the ground line, size `s`, row alpha `a`, parallax `px` (far rows drift and walk slower). */
export const ROWS: ReadonlyArray<{ y: number; s: number; a: number; px: number }> = [
  { y: 0.098, s: 0.24, a: 0.62, px: 0.78 },
  { y: 0.22, s: 0.42, a: 0.8, px: 0.9 },
  { y: 0.36, s: 0.62, a: 0.96, px: 1 },
];
/** Walking speed, px/s (× the row's parallax). */
export const WALK = 75;
/** The scene's `energy` for the bob: 1 at rest, this much more per celebration crowd tier (a little, never a jump). */
export const CEL_ENERGY_PER_TIER = 0.12;
/** Size jitter about the row's scale, ±10 %. */
const SZ_MIN = 0.9;
const SZ_MAX = 1.1;
/** An event (a departure, then an arrival 2–7 s later) every 20–60 s; the first one sooner. */
const EVENT_MIN_S = 20;
const EVENT_SPAN_S = 40;
const FIRST_EVENT_MIN_S = 6;
const FIRST_EVENT_SPAN_S = 4;
const ARRIVE_MIN_S = 2;
const ARRIVE_SPAN_S = 5;
const FADE_IN_S = 1.4;
const FADE_OUT_PX = 160;
const FADE_S = 1.2;
const ARRIVED_PX = 3;
/** A walker's edge sits this far inside its free segment's end, so it is never on the band's own line. */
const EDGE_IN_PX = 1;
/** Beyond this from home a standing Dancer is walking (profile frames). */
const MOVING_PX = 10;
/** Group spacing: tight or loose, re-picked every 8–20 s, eased at 0.5/s. */
const GAP_TIGHT: readonly [number, number] = [34, 46];
const GAP_LOOSE: readonly [number, number] = [70, 95];
const GAP_EASE = 0.5;
const GAP_RETIME: readonly [number, number] = [8, 20];
/** A group waves when a sweep's pool is this close to its centre, then not again for 12–20 s. */
const WAVE_NEAR_PX = 90;
const WAVE_COOLDOWN: readonly [number, number] = [12, 20];
const WAVE_BEATS = 4;
const POSE_FIRST: readonly [number, number] = [5, 15];
const POSE_NEXT: readonly [number, number] = [6, 16];
const COPY_LEADER = 0.5;
/** A Move: every 45–120 s for a Chatter Dancer, 90–240 s for a generic; four frames, one per beat, looped twice. */
const MOVE_EVERY_CHATTER: readonly [number, number] = [45, 120];
const MOVE_EVERY_GENERIC: readonly [number, number] = [90, 240];
const MOVE_BEATS = 8;
const MOVE_FRAMES = 4;
const JOIN_GROUP = 0.55;
const BPM: readonly [number, number] = [120, 128];
const HALF_TIME = 0.3;

/** The bobblehead: the picture's diameter is never under this many logical px, on any row. */
const HEAD_MIN_PX = 24;
const RING_PX = 2;
/** The glyph's font size as a share of the head's diameter (the motes' 1.25 × radius). */
const GLYPH_K = 0.625;
const LABEL_PX = 11;
const LABEL_FONT = "600 11px system-ui, sans-serif";
const LABEL_PAD_X = 4;
const LABEL_PAD_Y = 3;
const LABEL_GAP = 3;
const LABEL_RADIUS = 4;
/** The label shows this long after a hop … */
const LABEL_MS = 4000;
/** … and otherwise once every 30–60 s, staggered per dancer. */
const LABEL_EVERY: readonly [number, number] = [30, 60];
/** A Hop: this many px at the near row × the row's scale × floorK, up and down in HOP_MS, parabolic; never × energy. */
const HOP_PX = 30;
const HOP_MS = 500;
/** The first and last fifth of a hop wear the bounce crouch frame; the middle the straight one. */
const HOP_CROUCH_U = 0.2;

/** `name` cut to `max` letters with an ellipsis (the Config's name length). */
export function shortName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name;
}

/** Sway about home: a loner 12–45 px, a group 20–55 px, over 18–45 s. */
const LONER_AMP: readonly [number, number] = [12, 45];
const GROUP_AMP: readonly [number, number] = [20, 55];
const SWAY_PERIOD_S: readonly [number, number] = [18, 45];
/** The bob: 3–9 px × energy on a 120–170 frame period (60 fps frames), the bounce pose harder. */
const BOB_AMP: readonly [number, number] = [3, 9];
const BOB_FRAMES: readonly [number, number] = [120, 170];
const FRAME_MS = 1000 / 60;
const BOUNCE_BOB = 1.6;
/** A 2 px lateral jiggle on its own slow phase. */
const JIGGLE_PX = 2;
const JIGGLE_MS = 770;
const REFLECT_SY = 0.55;
const REFLECT_ALPHA = 0.15;
const REFLECT_RIM_ALPHA = 0.14;
/** The rim: this much of the tint with no sweep near, all of it with the pool on top, falling off over this many px. */
const RIM_BASE = 0.3;
const RIM_REACH_PX = 380;
/** The procedural fallback's rim outline, grown this much around the body. */
const FALLBACK_RIM_GROW = 3;
const ROW_WEIGHTS: readonly number[] = [0, 0, 1, 1, 1, 2, 2];
const ARRIVAL_ROWS: readonly number[] = [0, 1, 1, 2];
const TAU = Math.PI * 2;

export interface DancersFrame {
  horizonY: number;
  gy: number;
  /** The scene's own span beside the rack (`sceneLayout`): the roster never leaves it, so the rack panel is never stood under. */
  sceneL: number;
  sceneR: number;
  /** The floor's share over the boards' (`floorK`, `overlay.floorPercent`): every figure draws this much smaller on a shallower floor. 1 when absent. */
  scale?: number;
}

/** 1080p with the rack (300 wide) on the right: where the roster lives until the first `draw` brings the real frame. */
export const DEFAULT_FRAME: DancersFrame = { horizonY: 640, gy: 968, sceneL: 40, sceneR: 1510 };

export type DancerState = "in" | "dance" | "out" | "fade";
export type DancerKind = "generic" | "chatter";
export interface Move {
  name: PoseName;
  /** The dancer's `beat` when the Move began: the frame is floor(beat − beat0) % MOVE_FRAMES and the Move ends at MOVE_BEATS. */
  beat0: number;
  /** Started by the group's leader; ends when the leader's ends (its own eight-beat cap only once the leader has gone). */
  led: boolean;
}
export interface RosterConfig {
  /** On a full floor, one swap this often (the Config's "turn on a full floor"). */
  dwellMs: number;
  /** Names are cut to this many letters with an ellipsis. */
  nameLength: number;
}
const DEFAULT_ROSTER_CFG: RosterConfig = { dwellMs: 90_000, nameLength: 12 };
export type Segment = readonly [number, number];

export interface Group {
  row: number;
  base: number;
  amp: number;
  /** Sway angular speed (rad/s) and phase. */
  w: number;
  ph: number;
  m: Dancer[];
  gap: number;
  gapT: number;
  gapTimer: number;
  waveCd: number;
  /** The free segment the group's homes are clamped into. */
  seg: Segment;
}

export interface Dancer {
  id: number;
  row: number;
  x: number;
  /** Home right now (the edge for a leaver). */
  tx: number;
  /** A leaver's fade distance: the walk left when it turned to go, capped at FADE_OUT_PX (set by #leave). */
  outPx?: number;
  state: DancerState;
  alpha: number;
  pose: PoseName;
  beat: number;
  bpm: number;
  half: boolean;
  nextPose: number;
  wave: number;
  prev: PoseName | null;
  kind: DancerKind;
  /** The Chatter's opaque key (null for a generic). */
  key: string | null;
  name: string;
  avatarUrl: string | null;
  /** The clock (ms) when this dancer walked on — the cycling order. */
  onFloorSince: number;
  /** The name label shows until this clock (ms). */
  labelUntil: number;
  /** Seconds until the label shows unprompted. */
  nextLabelS: number;
  /** The hop in the air, from `t0` (ms). */
  hop: { t0: number } | null;
  /** One more hop armed for the landing (never more). */
  hopQueued: boolean;
  move: Move | null;
  lastMove: PoseName | null;
  /** Seconds until the next Move is due. */
  nextMove: number;
  /** A groupmate's pending join of the leader's Move, within a beat of it starting. */
  join: { name: PoseName; atS: number } | null;
  sz: number;
  /** Bob phase and period (ms), amplitude (px at the near row). */
  bob: number;
  bobMs: number;
  bobAmp: number;
  /** Jiggle phase. */
  sw: number;
  grp: Group | null;
  /** A loner's sway about `base`. */
  base: number;
  amp: number;
  w: number;
  ph: number;
  seg: Segment;
}

export interface Sweep {
  x: number;
  colour: string;
}

/** The figures behind every frame, once: `FIGURES[pose][i]`. */
const FIGURES: Readonly<Record<PoseName, readonly Figure[]>> = (() => {
  const out = {} as Record<PoseName, readonly Figure[]>;
  for (const k of Object.keys(POSES) as PoseName[]) out[k] = POSES[k].map((p) => figure(p));
  return out;
})();
const SIX: ReadonlyArray<Pick<Tower, "sideI" | "tier">> = [0, 1, 2, 3, 4, 5].map((i) => ({ sideI: i < 3 ? 0 : 1, tier: i % 3 }) as const);

/** Half the widest figure on `row`: the clearance a home keeps from a tower base and the scene's edges. */
const clearance = (row: number): number => (FIGURE_W / 2) * ROWS[row]!.s * SZ_MAX;

/** The six tower bases (from towers.ts) widened by the row's clearance: nobody stands inside one. */
export function towerBands(frame: DancersFrame, row: number): Segment[] {
  const c = clearance(row);
  return SIX.map((T) => {
    const x = sheetTowerX(T as Tower, frame);
    return [x - c, x + TOWER_W + c] as const;
  });
}

/** The free width for `row`: the scene's span inset by the clearance, less the tower bands, in x order. */
export function freeSegments(frame: DancersFrame, row: number): Segment[] {
  const c = clearance(row);
  let segs: Segment[] = [[frame.sceneL + c, frame.sceneR - c]];
  for (const [a, z] of towerBands(frame, row)) {
    const next: Segment[] = [];
    for (const [x0, x1] of segs) {
      if (z <= x0 || a >= x1) next.push([x0, x1]);
      else {
        if (a > x0) next.push([x0, a]);
        if (z < x1) next.push([z, x1]);
      }
    }
    segs = next;
  }
  return segs.filter(([x0, x1]) => x1 - x0 > 1);
}

/** The lit towers' pools (`sweepPlacement`), each in its tower's colour — what a group waves at and what lights a rim. */
export function sweepPools(theme: Theme, towers: readonly Tower[], f: TowerFrame): Sweep[] {
  const out: Sweep[] = [];
  towers.forEach((T, i) => {
    if (T.lit > 0.02) out.push({ x: sweepPlacement(T, f).base.x, colour: towerColour(theme, T, i) });
  });
  return out;
}

export class Dancers {
  readonly #rng: () => number;
  readonly #target: number;
  readonly #D: Dancer[] = [];
  readonly #groups: Group[] = [];
  #frame: DancersFrame = DEFAULT_FRAME;
  #uid = 0;
  /** The loop's clock, seconds, as of the last step. */
  #t = 0;
  #energy = 1;
  #eventS: number;
  /** Generic arrivals booked, seconds to go for each; one that fires with the gap already filled walks nobody on. */
  readonly #arrivals: number[] = [];
  #cfg: RosterConfig = DEFAULT_ROSTER_CFG;
  /** When the next swap is due on a full floor with people waiting; null while nobody waits. */
  #cycleAt: number | null = null;

  constructor(rng: () => number, roster = ROSTER) {
    this.#rng = rng;
    this.#target = roster;
    for (const [pose, figs] of Object.entries(FIGURES)) figs.forEach((f, i) => assertNoNaN(f, `${pose}-${i}`));
    this.#eventS = this.#R(FIRST_EVENT_MIN_S, FIRST_EVENT_MIN_S + FIRST_EVENT_SPAN_S);
    this.#populate(roster);
  }

  #R(a: number, b: number): number {
    return a + this.#rng() * (b - a);
  }

  #range(r: readonly [number, number]): number {
    return this.#R(r[0], r[1]);
  }

  #pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.#rng() * arr.length))]!;
  }

  /** The segment holding `x` on `row`, else the nearest one (the widest when the row has none). */
  #segmentAt(row: number, x: number): Segment {
    const segs = freeSegments(this.#frame, row);
    if (segs.length === 0) return [this.#frame.sceneL, this.#frame.sceneR];
    let best = segs[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of segs) {
      const d = x < s[0] ? s[0] - x : x > s[1] ? x - s[1] : 0;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** A home on `row` whose sway (`amp`) and slots (`slotHalf` each side) fit one free segment — the widest, with the sway trimmed, when none does. */
  #spot(row: number, slotHalf: number, amp: number): { base: number; amp: number; seg: Segment } {
    const segs = freeSegments(this.#frame, row);
    if (segs.length === 0) return { base: (this.#frame.sceneL + this.#frame.sceneR) / 2, amp: 0, seg: [this.#frame.sceneL, this.#frame.sceneR] };
    const need = amp + slotHalf;
    const fit = segs.filter(([x0, x1]) => x1 - x0 >= 2 * need);
    if (fit.length === 0) {
      const seg = segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
      return { base: (seg[0] + seg[1]) / 2, amp: Math.max(0, (seg[1] - seg[0]) / 2 - slotHalf - 1), seg };
    }
    const weights = fit.map(([x0, x1]) => x1 - x0 - 2 * need + 1);
    let r = this.#rng() * weights.reduce((a, b) => a + b, 0);
    let seg = fit[fit.length - 1]!;
    for (let i = 0; i < fit.length; i++) {
      r -= weights[i]!;
      if (r <= 0) {
        seg = fit[i]!;
        break;
      }
    }
    return { base: this.#R(seg[0] + need, seg[1] - need), amp, seg };
  }

  #newGroup(row: number, spot: { base: number; amp: number; seg: Segment }): Group {
    const gp: Group = { row, base: spot.base, amp: spot.amp, w: TAU / this.#range(SWAY_PERIOD_S), ph: this.#R(0, TAU), m: [], gap: 40, gapT: 40, gapTimer: this.#range(GAP_RETIME), waveCd: this.#R(0, 8), seg: spot.seg };
    this.#groups.push(gp);
    return gp;
  }

  /** Where `d` should be: the edge for a leaver; a slot beside the group's swaying centre; a loner's own sway — clamped into its segment. */
  #home(d: Dancer): number {
    if (d.state === "out") return d.tx;
    if (d.grp !== null) {
      const gp = d.grp;
      const i = gp.m.indexOf(d);
      return clamp(gp.base + Math.sin(this.#t * gp.w + gp.ph) * gp.amp + (i - (gp.m.length - 1) / 2) * gp.gap, gp.seg[0], gp.seg[1]);
    }
    return clamp(d.base + Math.sin(this.#t * d.w + d.ph) * d.amp, d.seg[0], d.seg[1]);
  }

  #spawn(o: { row: number; spot: { base: number; amp: number; seg: Segment }; grp: Group | null; state?: DancerState; alpha?: number; edge?: number; chatter?: Chatter | null }): Dancer {
    const d: Dancer = {
      id: ++this.#uid,
      row: o.row,
      grp: o.grp,
      base: o.spot.base,
      amp: o.spot.amp,
      w: TAU / this.#range(SWAY_PERIOD_S),
      ph: this.#R(0, TAU),
      seg: o.spot.seg,
      x: o.spot.base,
      tx: o.spot.base,
      state: o.state ?? "dance",
      alpha: o.alpha ?? 1,
      pose: this.#pick(DANCE),
      beat: this.#R(0, 4),
      bpm: this.#range(BPM),
      half: this.#rng() < HALF_TIME,
      nextPose: this.#range(POSE_FIRST),
      wave: 0,
      prev: null,
      kind: o.chatter ? "chatter" : "generic",
      key: o.chatter?.key ?? null,
      name: o.chatter?.name ?? "",
      avatarUrl: o.chatter?.avatarUrl ?? null,
      onFloorSince: this.#t * 1000,
      labelUntil: 0,
      nextLabelS: this.#range(LABEL_EVERY),
      hop: null,
      hopQueued: false,
      move: null,
      lastMove: null,
      nextMove: this.#range(o.chatter ? MOVE_EVERY_CHATTER : MOVE_EVERY_GENERIC),
      join: null,
      sz: this.#R(SZ_MIN, SZ_MAX),
      bob: this.#R(0, TAU),
      bobMs: this.#range(BOB_FRAMES) * FRAME_MS,
      bobAmp: this.#range(BOB_AMP),
      sw: this.#R(0, TAU),
    };
    if (d.grp !== null) d.grp.m.push(d);
    if (o.edge !== undefined) d.x = o.edge;
    this.#D.push(d);
    d.tx = this.#home(d);
    return d;
  }

  /** Groups on `row` with room for one more: under three, and their segment holds the wider line-up at its loosest spacing on top of the sway. */
  #joinable(row: number): Group[] {
    return this.#groups.filter((gp) => {
      const need = gp.amp + (gp.m.length / 2) * GAP_LOOSE[1];
      return gp.row === row && gp.m.length < 3 && gp.base - need >= gp.seg[0] && gp.base + need <= gp.seg[1];
    });
  }

  /** `n` people already on the floor at their homes: threes, pairs and loners across the rows. */
  #populate(n: number): void {
    let placed = 0;
    while (placed < n) {
      const row = this.#pick(ROW_WEIGHTS);
      const r = this.#rng();
      const k = Math.min(n - placed, r < 0.3 ? 3 : r < 0.65 ? 2 : 1); // the last spot never opens a one-person group
      const spot = k > 1 ? this.#spot(row, ((k - 1) / 2) * GAP_LOOSE[1], this.#range(GROUP_AMP)) : this.#spot(row, 0, this.#range(LONER_AMP));
      const gp = k > 1 ? this.#newGroup(row, spot) : null;
      const born: Dancer[] = [];
      for (let i = 0; i < k && placed < n; i++, placed++) born.push(this.#spawn({ row, spot, grp: gp }));
      for (const d of born) d.x = d.tx = this.#home(d);
    }
  }

  /** The edge a walker enters from or leaves by: the near end of the free segment its home is in — never across a tower band. */
  #edge(seg: Segment, right: boolean): number {
    return right ? Math.max(seg[0], seg[1] - EDGE_IN_PX) : Math.min(seg[1], seg[0] + EDGE_IN_PX);
  }

  #walkIn(chatter: Chatter | null): void {
    const row = this.#pick(ARRIVAL_ROWS);
    const right = this.#rng() < 0.5;
    const js = this.#joinable(row);
    let gp: Group | null = null;
    let spot: { base: number; amp: number; seg: Segment };
    if (js.length > 0 && this.#rng() < JOIN_GROUP) {
      gp = this.#pick(js);
      spot = { base: gp.base, amp: gp.amp, seg: gp.seg };
    } else {
      spot = this.#spot(row, 0, this.#range(LONER_AMP));
    }
    this.#spawn({ row, spot, grp: gp, state: "in", alpha: 0, edge: this.#edge(spot.seg, right), chatter });
  }

  #leave(d: Dancer): void {
    d.state = "out";
    d.wave = 0;
    d.move = null;
    d.join = null;
    d.hop = null;
    d.hopQueued = false;
    this.#unlink(d);
    d.tx = this.#edge(d.seg, d.x > (d.seg[0] + d.seg[1]) / 2);
    d.outPx = Math.max(1, Math.min(FADE_OUT_PX, Math.abs(d.tx - d.x))); // fade over the walk that is actually left, never a pop when the edge is near
  }

  #unlink(d: Dancer): void {
    const gp = d.grp;
    if (gp === null) return;
    if (gp.m[0] === d) {
      // the leader is going: nobody is led any more, and no invitation of theirs stands
      for (const m of gp.m) {
        if (m.move !== null) m.move.led = false;
        m.join = null;
      }
    }
    gp.m.splice(gp.m.indexOf(d), 1);
    if (gp.m.length === 0) this.#groups.splice(this.#groups.indexOf(gp), 1);
    d.grp = null;
  }

  /** Start `name` on `d` now (its own beat as the origin); a leader's start invites each groupmate within a beat with COPY_LEADER odds. */
  #startMove(d: Dancer, name: PoseName, led: boolean): void {
    d.move = { name, beat0: d.beat, led };
    d.lastMove = name;
    d.join = null;
    d.nextMove = this.#range(d.kind === "chatter" ? MOVE_EVERY_CHATTER : MOVE_EVERY_GENERIC);
    const gp = d.grp;
    if (led || gp === null || gp.m[0] !== d) return;
    for (const m of gp.m) {
      if (m === d || m.move !== null || m.state !== "dance" || m.lastMove === name) continue; // never the one they just did, even led
      if (this.#rng() < COPY_LEADER) m.join = { name, atS: this.#t + this.#R(0, 60 / m.bpm) };
    }
  }

  /** End `d`'s Move; a leader's end stops every groupmate's led Move with it and withdraws any invitation still pending. */
  #endMove(d: Dancer): void {
    d.move = null;
    const gp = d.grp;
    if (gp === null || gp.m[0] !== d) return;
    for (const m of gp.m) {
      if (m.move !== null && m.move.led) m.move = null;
      m.join = null;
    }
  }

  #remove(d: Dancer): void {
    this.#unlink(d);
    this.#D.splice(this.#D.indexOf(d), 1);
  }

  #chattersOnFloor(): Dancer[] {
    return this.#D.filter((d) => d.kind === "chatter" && d.state !== "out");
  }

  #genericsOnFloor(): Dancer[] {
    return this.#D.filter((d) => d.kind === "generic" && d.state !== "out");
  }

  /** How many generics the floor wants: the gap under the roster once the Chatter Dancers are counted. */
  #genericTarget(): number {
    return Math.max(0, this.#target - this.#chattersOnFloor().length);
  }

  /** Book `n` generic arrivals (none for n ≤ 0), each 2–7 s out on its own dice, so a crowd trickles in rather than landing on one frame. */
  #bookArrivals(n: number): void {
    for (let i = 0; i < n; i++) this.#arrivals.push(this.#R(ARRIVE_MIN_S, ARRIVE_MIN_S + ARRIVE_SPAN_S));
  }

  /** The Chatter Dancer who walked on first (ties: lowest `id`): the next to go when the floor must give someone up. */
  #longestStanding(): Dancer {
    return this.#chattersOnFloor().reduce((a, b) => (b.onFloorSince < a.onFloorSince || (b.onFloorSince === a.onFloorSince && b.id < a.id) ? b : a));
  }

  /**
   * The comings and goings, generics only: at each event a generic leaves (the gap full) and a newcomer is booked 2–7 s
   * out (the gap short, nothing booked yet). Every arrival re-checks the gap as it fires: that check is the one gate on
   * "under target", so ≤ target stays structural however the roster moved meanwhile and however many were booked.
   */
  #ambient(dt: number): void {
    this.#eventS -= dt;
    for (let i = this.#arrivals.length - 1; i >= 0; i--) {
      const left = this.#arrivals[i]! - dt;
      if (left > 0) this.#arrivals[i] = left;
      else {
        this.#arrivals.splice(i, 1);
        if (this.#genericsOnFloor().length < this.#genericTarget()) this.#walkIn(null);
      }
    }
    if (this.#eventS > 0) return;
    this.#eventS = this.#R(EVENT_MIN_S, EVENT_MIN_S + EVENT_SPAN_S);
    const target = this.#genericTarget();
    if (target === 0) return;
    if (this.#genericsOnFloor().length >= target - 1) {
      const cands = this.#genericsOnFloor().filter((d) => d.state === "dance");
      if (cands.length > 0) this.#leave(this.#pick(cands));
    }
    if (this.#genericsOnFloor().length + this.#arrivals.length < target) this.#bookArrivals(1);
  }

  /** Take the roster into `frame`: every x mapped across the new span and every home clamped into the new segments. Idempotent. */
  layout(frame: DancersFrame): void {
    const old = this.#frame;
    if (old.horizonY === frame.horizonY && old.gy === frame.gy && old.sceneL === frame.sceneL && old.sceneR === frame.sceneR) return;
    const k = (frame.sceneR - frame.sceneL) / (old.sceneR - old.sceneL);
    const map = (x: number): number => frame.sceneL + (x - old.sceneL) * k;
    this.#frame = frame;
    for (const gp of this.#groups) {
      gp.base = map(gp.base);
      gp.seg = this.#segmentAt(gp.row, gp.base);
      gp.base = clamp(gp.base, gp.seg[0], gp.seg[1]);
    }
    for (const d of this.#D) {
      d.x = clamp(map(d.x), frame.sceneL, frame.sceneR);
      d.base = map(d.base);
      d.seg = d.grp !== null ? d.grp.seg : this.#segmentAt(d.row, d.base);
      d.base = clamp(d.base, d.seg[0], d.seg[1]);
      d.tx = d.state === "out" ? this.#edge(d.seg, d.tx > (old.sceneL + old.sceneR) / 2) : this.#home(d);
    }
  }

  /**
   * Take the Active Chatters: everyone listed stands on the floor, most recent message first, up to `cap`;
   * generics fill the gap under the roster and thin one for one; a lapsed chatter walks off; a cap that fell (a
   * lower Level) sheds the excess at once, longest-standing first; whatever gap the leavers open under the roster is
   * backfilled by generics booked at once, each 2–7 s out (one lapse books one, a mass lapse or a bulk shed books the
   * lot); above the cap one swap every `dwellMs` — the longest-standing walks off, the waiting person with the most
   * recent message walks on — and the dwell runs on through a lapse and its refill, clearing only when nobody waits.
   * A leaver's key is held until it has gone, then they wait like anyone.
   */
  sync(chatters: readonly Chatter[], cap: number, cfg: RosterConfig, tMs: number): void {
    this.#cfg = cfg;
    this.#t = tMs / 1000;
    const wanted = new Map<string, Chatter>();
    for (const c of chatters) if (!wanted.has(c.key)) wanted.set(c.key, c);
    for (const d of this.#chattersOnFloor()) if (!wanted.has(d.key!)) this.#leave(d);
    for (let over = this.#chattersOnFloor().length - cap; over > 0; over--) this.#leave(this.#longestStanding());
    this.#bookArrivals(this.#genericTarget() - this.#genericsOnFloor().length - this.#arrivals.length);
    const held = new Set(this.#D.filter((d) => d.kind === "chatter").map((d) => d.key));
    const waiting = [...wanted.values()].filter((c) => !held.has(c.key)).sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    while (waiting.length > 0 && this.#chattersOnFloor().length < cap) this.#walkIn(waiting.shift()!);
    // anyone still waiting faces a floor at the cap: the dwell is judged after the refill, so a lapse never restarts it
    if (waiting.length === 0) this.#cycleAt = null;
    else if (this.#cycleAt === null) this.#cycleAt = tMs + cfg.dwellMs;
    else if (tMs >= this.#cycleAt) {
      this.#leave(this.#longestStanding());
      this.#walkIn(waiting.shift()!);
      this.#cycleAt = tMs + cfg.dwellMs;
    }
    const target = this.#genericTarget();
    for (;;) {
      const generics = this.#genericsOnFloor();
      if (generics.length <= target) break;
      const dancing = generics.filter((d) => d.state === "dance");
      this.#leave(dancing.length > 0 ? this.#pick(dancing) : generics[0]!);
    }
  }

  /** A message from `key`: the standing Chatter Dancer hops now, or arms one more for its landing; walkers and unknown keys ignore it. The label shows for LABEL_MS. */
  hop(key: string, tMs: number): void {
    const d = this.#D.find((x) => x.key === key && x.state === "dance");
    if (d === undefined || this.#moving(d)) return;
    d.labelUntil = Math.max(d.labelUntil, tMs + LABEL_MS);
    if (d.hop === null) d.hop = { t0: tMs };
    else d.hopQueued = true;
  }

  /**
   * One step on the loop's clock: group spacing and waves (a sweep's pool within `WAVE_NEAR_PX` of the group), the
   * comings and goings, then every Dancer's beat, walk toward home, fade and pose cycle. `energy` is 1 at rest and
   * higher through a Celebration; it scales the bob at draw.
   */
  step(dtMs: number, tMs: number, sweepsX: readonly number[], energy: number): void {
    const dt = dtMs / 1000;
    this.#t = tMs / 1000;
    this.#energy = energy;
    for (const gp of this.#groups) {
      gp.gapTimer -= dt;
      if (gp.gapTimer < 0) {
        gp.gapTimer = this.#range(GAP_RETIME);
        gp.gapT = this.#rng() < 0.55 ? this.#range(GAP_TIGHT) : this.#range(GAP_LOOSE);
      }
      gp.gap += (gp.gapT - gp.gap) * Math.min(1, dt * GAP_EASE);
      gp.waveCd -= dt;
      const cx = gp.base + Math.sin(this.#t * gp.w + gp.ph) * gp.amp;
      if (gp.waveCd <= 0 && sweepsX.some((sx) => Math.abs(sx - cx) < WAVE_NEAR_PX)) {
        gp.waveCd = this.#range(WAVE_COOLDOWN);
        for (const d of gp.m) {
          if (d.state !== "dance" || d.move !== null) continue; // a Move is never interrupted by a wave
          d.prev = d.pose;
          d.pose = "up";
          d.wave = (WAVE_BEATS * 60) / d.bpm;
        }
      }
    }
    this.#ambient(dt);
    for (const d of this.#D.slice()) {
      d.beat += ((dt * d.bpm) / 60) * (d.half ? 0.5 : 1);
      const h = this.#home(d);
      d.tx = h;
      const dx = h - d.x;
      d.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK * ROWS[d.row]!.px * dt);
      if (d.state === "in") {
        d.alpha = Math.min(1, d.alpha + dt / FADE_IN_S);
        if (Math.abs(dx) < ARRIVED_PX) d.state = "dance";
      } else if (d.state === "out") {
        d.alpha = Math.min(d.alpha, Math.abs(dx) / (d.outPx ?? FADE_OUT_PX));
        if (Math.abs(dx) < ARRIVED_PX) this.#remove(d);
      } else if (d.state === "fade") {
        // nothing sends anyone here today (the roster is fixed); a future roster change would
        d.alpha -= dt / FADE_S;
        if (d.alpha <= 0) this.#remove(d);
      } else {
        d.alpha = Math.min(1, d.alpha + dt / FADE_S);
        if (d.kind === "chatter") {
          d.nextLabelS -= dt;
          if (d.nextLabelS < 0) {
            d.nextLabelS = this.#range(LABEL_EVERY);
            d.labelUntil = Math.max(d.labelUntil, tMs + LABEL_MS);
          }
        }
        if (d.hop !== null && tMs - d.hop.t0 >= HOP_MS) {
          if (d.hopQueued) {
            d.hop = { t0: tMs };
            d.hopQueued = false;
          } else d.hop = null;
        }
        if (d.move !== null) {
          if (!d.move.led && d.beat - d.move.beat0 >= MOVE_BEATS) this.#endMove(d); // a led Move waits for the leader's end
        } else if (d.wave > 0) {
          d.wave -= dt;
          if (d.wave <= 0 && d.prev !== null) d.pose = d.prev;
        } else {
          const still = !this.#moving(d);
          if (d.join !== null && this.#t >= d.join.atS && still) this.#startMove(d, d.join.name, true);
          else {
            d.nextMove -= dt;
            if (d.nextMove < 0 && still) this.#startMove(d, this.#pick(MOVES.filter((m) => m !== d.lastMove)), false); // a wave in progress or a walk defers it to the next frame
          }
          d.nextPose -= dt;
          if (d.nextPose < 0) {
            d.nextPose = this.#range(POSE_NEXT);
            const leader = d.grp?.m[0];
            d.pose = leader !== undefined && leader !== d && this.#rng() < COPY_LEADER ? leader.pose : this.#pick(DANCE.filter((p) => p !== d.pose));
          }
        }
      }
    }
  }

  /** On-floor count: everyone but the leavers. */
  present(): number {
    return this.#D.reduce((n, d) => n + (d.state === "out" ? 0 : 1), 0);
  }

  /** Everyone drawn as a walker right now, with the way they face (`flip` = travelling leftwards); the same predicate `draw` uses. */
  walkers(): ReadonlyArray<{ x: number; tx: number; flip: boolean; alpha: number }> {
    return this.#D.filter((d) => this.#walking(d)).map((d) => ({ x: d.x, tx: d.tx, flip: d.tx < d.x, alpha: d.alpha }));
  }

  /** The roster as it stands (for tests and the debug bar). */
  all(): readonly Dancer[] {
    return this.#D;
  }

  /** Travelling: arriving, leaving, or more than MOVING_PX from home (the state machine's notion; a Move never starts while true). */
  #moving(d: Dancer): boolean {
    return d.state === "in" || d.state === "out" || Math.abs(d.tx - d.x) > MOVING_PX;
  }

  /** Drawn as a walker: travelling and not mid-Move (a Move plays through a re-slot slide, so that dancer is never a walker). */
  #walking(d: Dancer): boolean {
    return d.move === null && this.#moving(d);
  }

  /**
   * Paint the roster far row first. Per Dancer: the reflection (body then rim under `scale(1, −REFLECT_SY)` about the
   * feet, at a fraction of the alpha), the body plate (never tinted), the rim tinted the nearest sweep's colour at
   * `RIM_BASE` + proximity — the Theme's accent (the horizon's glow behind them) when no sweep is lit.
   */
  draw(ctx: CanvasRenderingContext2D, theme: Theme, frame: DancersFrame, sprites: SpriteSet | null, spec: LevelSpec, sweeps: ReadonlyArray<Sweep>, chatterImage: (url: string | null) => CanvasImageSource | null = () => null): void {
    this.layout(frame);
    const depth = frame.gy - frame.horizonY;
    const nearS = ROWS[ROWS.length - 1]!.s;
    const tMs = this.#t * 1000;
    const order = [...this.#D].sort((a, b) => a.row - b.row);
    const labels: Label[] = [];
    for (const d of order) {
      const row = ROWS[d.row]!;
      const a = row.a * d.alpha;
      if (a <= 0) continue;
      const walking = this.#walking(d);
      const flip = walking && d.tx < d.x;
      const u = d.hop === null ? 0 : clamp((tMs - d.hop.t0) / HOP_MS, 0, 1);
      const hopping = d.hop !== null && !walking;
      let pose: PoseName = walking ? "walk" : d.move !== null ? d.move.name : d.pose;
      let fi: number;
      if (walking) fi = Math.floor(d.beat * 2) % POSES.walk.length;
      else if (d.move !== null) fi = Math.floor(d.beat - d.move.beat0) % MOVE_FRAMES;
      else if (hopping) {
        pose = "bounce";
        fi = u < HOP_CROUCH_U || u > 1 - HOP_CROUCH_U ? 1 : 0;
      } else fi = Math.floor(d.beat) % POSES[pose].length;
      const k = row.s * d.sz * (frame.scale ?? 1);
      const bob = Math.abs(Math.sin(Math.PI * (tMs / d.bobMs) + d.bob)) * d.bobAmp * this.#energy * (row.s / nearS) * (pose === "bounce" && !hopping ? BOUNCE_BOB : 1);
      const hopY = hopping ? HOP_PX * row.s * (frame.scale ?? 1) * 4 * u * (1 - u) : 0;
      const x = d.x + Math.sin(tMs / JIGGLE_MS + d.sw) * JIGGLE_PX * row.px;
      const y = frame.horizonY + row.y * depth - bob - hopY;
      let near: Sweep | null = null;
      let prox = 0;
      for (const s of sweeps) {
        const p = Math.max(0, 1 - Math.abs(s.x - x) / RIM_REACH_PX);
        if (near === null || p > prox || (p === prox && Math.abs(s.x - x) < Math.abs(near.x - x))) {
          near = s;
          prox = p;
        }
      }
      const rimColour = near === null ? theme.accent : near.colour;
      const rimA = RIM_BASE + (1 - RIM_BASE) * prox;
      const body = `dancer-${pose}-${fi}`;
      const rim = pose === "walk" && flip ? `${body}-rim-flip` : `${body}-rim`;
      const paint = (px: number, py: number, alpha: number, tint: boolean): void => {
        if (sprites !== null) {
          if (!tint) sprites.draw(ctx, body, spec.spriteScale, px, py, { k, alpha, flipX: flip });
          else sprites.draw(ctx, rim, spec.spriteScale, px, py, { k, alpha, flipX: flip, colour: rimColour });
        } else {
          strokeFigure(ctx, FIGURES[pose][fi]!, px, py, k, flip, tint ? rimColour : theme.crowd, alpha, tint ? FALLBACK_RIM_GROW : 0);
        }
      };
      // the reflection: the same frames mirrored about the feet, faint
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, -REFLECT_SY);
      if (sprites !== null) {
        paint(0, 0, a * REFLECT_ALPHA, false);
        paint(0, 0, a * rimA * REFLECT_RIM_ALPHA, true);
      } else {
        paint(0, 0, a * rimA * REFLECT_RIM_ALPHA, true);
        paint(0, 0, a * REFLECT_ALPHA, false);
      }
      ctx.restore();
      if (sprites !== null) {
        paint(x, y, a, false);
        paint(x, y, a * rimA, true);
      } else {
        // procedural: the rim is an outline grown round the body, so it goes under
        paint(x, y, a * rimA, true);
        paint(x, y, a, false);
      }
      if (d.kind === "chatter") {
        const fig = FIGURES[pose][fi]!;
        const hd = Math.max(2 * fig.head[2] * k, HEAD_MIN_PX);
        const hx = x + (flip ? -1 : 1) * (fig.head[0] - FIGURE_W / 2) * k;
        const hy = y + (fig.head[1] - FLOOR_Y) * k;
        drawHead(ctx, theme, d, hx, hy, hd, a, rimColour, rimA, chatterImage);
        if (tMs < d.labelUntil) labels.push({ x: hx, y: hy - hd / 2 - LABEL_GAP, text: shortName(d.name, this.#cfg.nameLength), row: d.row, alpha: a });
      }
    }
    drawLabels(ctx, theme, labels);
  }
}

/** The procedural Dancer: the figure's capsules stroked round-capped and its discs filled, feet on (x, y), `k` × world size, grown by `grow` px. */
function strokeFigure(ctx: CanvasRenderingContext2D, f: Figure, x: number, y: number, k: number, flip: boolean, colour: string, alpha: number, grow: number): void {
  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * alpha;
  ctx.translate(x, y);
  ctx.scale(flip ? -k : k, k);
  ctx.translate(-FIGURE_W / 2, -FLOOR_Y);
  ctx.lineCap = "round";
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  for (const [x1, y1, x2, y2, r] of f.parts) {
    ctx.lineWidth = r * 2 + grow;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  const disc = (cx: number, cy: number, r: number): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, r + grow / 2, 0, TAU);
    ctx.fill();
  };
  disc(f.head[0], f.head[1], f.head[2]);
  if (f.cup) disc(f.cup[0], f.cup[1] - 4, 5);
  if (f.nose) disc(f.nose[0], f.nose[1], f.nose[2]);
  ctx.restore();
}

interface Label {
  x: number;
  /** The plate's bottom edge. */
  y: number;
  text: string;
  row: number;
  alpha: number;
}

/** The bobblehead: a panel disc, the Avatar Picture through an arc clip (the Avatar Glyph until it decodes), a thin ring in the rim tint. Never the Mote Ring. */
function drawHead(ctx: CanvasRenderingContext2D, theme: Theme, d: Dancer, hx: number, hy: number, hd: number, alpha: number, rimColour: string, rimA: number, image: (url: string | null) => CanvasImageSource | null): void {
  const prev = ctx.globalAlpha;
  const r = hd / 2;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = theme.panel;
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, TAU);
  ctx.fill();
  const img = image(d.avatarUrl);
  if (img !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, TAU);
    ctx.clip();
    ctx.drawImage(img, hx - r, hy - r, hd, hd);
    ctx.restore();
  } else {
    const g = avatarFor(d.name, theme);
    if (g !== "") glyph(ctx, g, hx, hy + 1, Math.round(hd * GLYPH_K));
  }
  ctx.globalAlpha = prev * alpha * rimA;
  ctx.strokeStyle = rimColour;
  ctx.lineWidth = RING_PX;
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = prev;
}

/** The name labels, nearest row first; a plate that would overlap one already placed is skipped this frame. */
function drawLabels(ctx: CanvasRenderingContext2D, theme: Theme, labels: readonly Label[]): void {
  if (labels.length === 0) return;
  const prev = ctx.globalAlpha;
  const taken: Array<readonly [number, number, number, number]> = [];
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of [...labels].sort((a, b) => b.row - a.row)) {
    const w = ctx.measureText(l.text).width + 2 * LABEL_PAD_X;
    const h = LABEL_PX + 2 * LABEL_PAD_Y;
    const x0 = l.x - w / 2;
    const y0 = l.y - h;
    const x1 = x0 + w;
    const y1 = l.y;
    if (taken.some(([a, b, c, e]) => x0 < c && x1 > a && y0 < e && y1 > b)) continue;
    taken.push([x0, y0, x1, y1]);
    ctx.globalAlpha = prev * l.alpha;
    ctx.fillStyle = theme.panel;
    roundRect(ctx, x0, y0, w, h, LABEL_RADIUS);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(l.text, l.x, l.y - h / 2 + 1);
  }
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = prev;
}

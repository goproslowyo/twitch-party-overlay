/**
 * The drop (ported from the prototype's `makeDrop`, its reveal queue and the party view's
 * celebrate/step): a `drop` effect spawns a jumper at the blimp's door — `maxAir` in the air at once, the rest waiting
 * in a FIFO for a free slot — steered to the pad the server drew. Landings queue REVEALS one at a time in landing
 * order (`REVEAL n OF m`; `revealMs`, or `revealMiniDrawMs` when the reveal carries a mini-draw); the pads stay
 * frozen from the first fire through the last reveal, then thaw (collapse / re-spread, ~1 s) and ONE shuffle runs:
 * a jumper that touches down stays as a `landed` pose on its pad (`drawLanded`: pilot standing, canopy gone) until
 * its banner has played — `BANNER_MS` from its reveal, or `revealMiniDrawMs` when the reveal is a mini-draw reel — so the payoff of every Unlock has a landing (task-99 MUST 1);
 * three passes ~1.1 s apart, pads lifting in an arc as they slide. A tier opening while nobody is in the air deals the
 * new pads in at random and reshuffles at once. Celebrations live here too: the particle burst over the floor, the
 * fireworks in the frame's `fireworkSky` — the band over the tower heads, under the airship's lane (task-99 MUST 5).
 * Every random draw comes from the scene's seeded rng; every time is the loop's `tMs` — nothing here reads a clock
 * or sets a timer. The drawing is thin: wind, jumpers, flair, the SHUFFLING callout — from the Theme Sheet's frames
 * when `draw` is handed one (the Level in force supplies the Sheet Scale), else the club-deck's vectors and glyphs.
 */
import type { Theme } from "../../config/schema.ts";
import type { Mote } from "../../server/overlay.ts";
import type { SpriteSet } from "../sprites.ts";
import { BANNER_MS } from "../alerts.ts";
import { fireworks as fireworksFor, particleCount, particleLife } from "../celebration.ts";
import { SHUFFLING } from "../copy.ts";
import type { LevelSpec } from "../quality.ts";
import { createJumper, drawJumper, drawLanded, stepJumper, type Jumper, type Landed } from "./jumper.ts";
import { SLIDE_RATE, type Pad } from "./pads.ts";
import { Fireworks, Particles, particleTints } from "./particles.ts";
import { clamp, pill } from "./util.ts";
import { WindField } from "./wind.ts";

export interface Fire {
  fireSeq: number;
  outcomeId: string;
  /** The one contributor who alone took the Unlock to its Threshold; null otherwise — nobody else is ever named. */
  solo: string | null;
  /** The Unlock's Contributor Motes. */
  group: Mote[];
  miniDraw?: { title: string; list: string[]; pick: string };
  stockAfter: number;
}

export interface DropConfig {
  descentMs: number;
  maxAir: number;
  revealMs: number;
  revealMiniDrawMs: number;
  shuffleMs: number;
}

/** What the drop needs from the scene each frame. */
export interface DropFrame {
  /** The pad strip as laid out now (frozen while anyone is in the air). */
  pads: readonly Pad[];
  strip: { x: number; w: number };
  /** Where a jumper leaves the blimp. */
  door: { x: number; y: number };
  skyY: number;
  /** The touchdown line. */
  groundY: number;
  sceneL: number;
  sceneR: number;
  /** Where fireworks are born: the sky band over the tower heads and under the airship's lane (both y, top < bottom). */
  fireworkSky: { top: number; bottom: number };
}

/** A pose left on the pad at touchdown (task-99 MUST 1): standing until `until` (set at its reveal: the banner's end). */
export interface LandedPose extends Landed {
  fireSeq: number;
  padId: string;
  /** Touchdown time. */
  at: number;
  /** When the pose goes — null until the reveal starts. */
  until: number | null;
}

/** A jumper in the air with the effect that launched it — replayed at its reveal. */
export interface Airborne extends Jumper {
  fire: Fire;
}

export type DropEvent = { kind: "reveal"; fire: Fire; n: number; total: number; padX: number } | { kind: "drained" };
export type RevealStep = { kind: "start"; fire: Fire; n: number; total: number } | { kind: "done" } | null;

export const FLASH_MS = 1800;
export const FLASH_HALF_MS = 300;
export const LIFT_MS = 1100;
export const LIFT_PX = 22;
export const RESHUFFLE_AFTER_REVEALS_MS = 900;
export const RESHUFFLE_AFTER_TIER_MS = 600;
export const SLIDE_SHUFFLE_RATE = 0.05;
const SLIDE_SLOW_AFTER_MS = 800;
const SWAP_ODDS = 0.85;
const PASS_FRACTIONS = [200 / 3600, 1300 / 3600, 2400 / 3600];
const AIR_VIS_RATE = 0.05;
const BURST_Y_ABOVE_GROUND = 50;
const FIREWORK_GAP_MIN_MS = 180;
const FIREWORK_GAP_SPAN_MS = 220;
const SHUFFLE_NOTE_ABOVE = 90;

/** Reveals one at a time in landing order; a batch's counter runs until the queue drains with nobody left to land. */
export class RevealQueue {
  #queue: Fire[] = [];
  #current: { fire: Fire; untilMs: number } | null = null;
  #n = 0;

  get busy(): boolean {
    return this.#current !== null || this.#queue.length > 0;
  }

  get pending(): number {
    return this.#queue.length;
  }

  push(fire: Fire): void {
    this.#queue.push(fire);
  }

  /** `moreComing` = jumpers still in the air or waiting: they count toward `total` and hold the batch open. */
  step(t: number, cfg: Pick<DropConfig, "revealMs" | "revealMiniDrawMs">, moreComing: number): RevealStep {
    if (this.#current !== null) {
      if (t < this.#current.untilMs) return null;
      this.#current = null;
    }
    const next = this.#queue.shift();
    if (next === undefined) {
      if (this.#n > 0 && moreComing === 0) {
        this.#n = 0;
        return { kind: "done" };
      }
      return null;
    }
    this.#n++;
    this.#current = { fire: next, untilMs: t + (next.miniDraw === undefined ? cfg.revealMs : cfg.revealMiniDrawMs) };
    return { kind: "start", fire: next, n: this.#n, total: this.#n + this.#queue.length + moreComing };
  }
}

/** The three pass times of a shuffle started at `t`, ~1.1 s apart at the default `shuffleMs`. */
export function shufflePasses(t: number, shuffleMs: number): number[] {
  return PASS_FRACTIONS.map((f) => t + Math.round(f * shuffleMs));
}

/** One pass: pair the pads up at random and swap most pairs — visible, not a teleport. Pure. */
export function shufflePass(order: readonly string[], rng: () => number): string[] {
  const out = [...order];
  const idx = out.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  for (let i = 0; i + 1 < idx.length; i += 2) {
    if (rng() < SWAP_ODDS) [out[idx[i]!], out[idx[i + 1]!]] = [out[idx[i + 1]!]!, out[idx[i]!]!];
  }
  return out;
}

/** `order` brought up to date with `ids`: gone ids leave, new ones are dealt in at random positions (the first deal keeps the pool's order). Pure. */
export function syncOrder(order: readonly string[], ids: readonly string[], rng: () => number): string[] {
  const keep = new Set(ids);
  const out = order.filter((id) => keep.has(id));
  const have = new Set(out);
  const firstDeal = order.length === 0;
  for (const id of ids) {
    if (have.has(id)) continue;
    if (firstDeal) out.push(id);
    else out.splice(Math.floor(rng() * (out.length + 1)), 0, id);
    have.add(id);
  }
  return out;
}

/** The landing pad's blink: three 300 ms flashes over 1.8 s from `startMs` (≈ 1.7 Hz). */
export function flashOn(startMs: number, t: number): boolean {
  const age = t - startMs;
  return age >= 0 && age < FLASH_MS && Math.floor(age / FLASH_HALF_MS) % 2 === 0;
}

const padCentre = (pads: readonly Pad[], id: string): number | null => {
  const pad = pads.find((p) => p.id === id);
  return pad === undefined ? null : pad.x + pad.w / 2;
};

export class Drop {
  readonly wind: WindField;
  readonly jumpers: Airborne[] = [];
  /** The pilots standing on their pads after touchdown, through their banners. */
  readonly landed: LandedPose[] = [];
  readonly pending: Fire[] = [];
  readonly particles = new Particles();
  readonly fireworks = new Fireworks();
  readonly #reveals = new RevealQueue();
  readonly #rng: () => number;
  readonly #cfg: () => DropConfig;
  readonly #theme: () => Theme;
  /** The Quality Level in force — a thunk, so a level change lands on the next burst. */
  readonly #spec: () => LevelSpec;
  readonly #log: (message: string) => void;
  #order: string[] = [];
  #orderKey = "";
  #shuffle: { at: number; passes: number[]; until: number } | null = null;
  #lifts = new Map<string, number>();
  #flash: { id: string; at: number } | null = null;
  #drainedPending = false;
  /** Outcomes already reported as having no pad — each is said once. */
  readonly #warnedMissing = new Set<string>();
  #airVis = 0;
  #fwLeft = 0;
  #fwNext = 0;
  #lastFrame: DropFrame | null = null;

  constructor(rng: () => number, cfg: () => DropConfig, theme: () => Theme, spec: () => LevelSpec, log: (message: string) => void = (m) => console.warn(m)) {
    this.#rng = rng;
    this.#cfg = cfg;
    this.#theme = theme;
    this.#spec = spec;
    this.#log = log;
    this.wind = new WindField(rng);
  }

  /** A `drop` effect: a jumper leaves the door now (or waits for a slot); any shuffle under way stops where it is (a lifted tile finishes its arc). */
  fire(fire: Fire, t: number): void {
    this.#shuffle = null;
    const frame = this.#lastFrame;
    if (frame !== null && this.jumpers.length < this.#cfg().maxAir) this.#launch(fire, t, frame);
    else this.pending.push(fire);
  }

  /** The jumper leaves the door; a pad the strip does not have (yet) is said once per outcome — the pilot aims at the strip's centre until one is dealt. */
  #launch(fire: Fire, t: number, frame: DropFrame): void {
    if (padCentre(frame.pads, fire.outcomeId) === null && !this.#warnedMissing.has(fire.outcomeId)) {
      this.#warnedMissing.add(fire.outcomeId);
      this.#log(`overlay: no pad for ${fire.outcomeId} in the strip — steering to its centre until one is dealt`);
    }
    this.jumpers.push({ ...createJumper(frame.door, fire.outcomeId, t, this.#cfg().descentMs, this.#rng, fire.fireSeq), fire }); // nobody is pictured for a drop
  }

  /** A `celebrate` effect at intensity `i`: the burst over the floor, fireworks from 0.5 up. */
  celebrate(i: number, avatar: string, t: number, frame: DropFrame): void {
    const theme = this.#theme();
    const cap = this.#spec().particleCap;
    this.particles.burst(particleCount(i, cap), frame.sceneL + 40, frame.sceneR - 40, frame.groundY - BURST_Y_ABOVE_GROUND, 1.4 + 2.6 * i, [avatar, ...theme.avatars.slice(0, 3)], particleLife(i), cap, this.#rng);
    const bursts = fireworksFor(i);
    if (bursts > 0) {
      this.#fwLeft = bursts;
      this.#fwNext = t;
    }
  }

  /** A `tier_open` effect: with nobody in the air the new pads (dealt in by `order`) get their shuffle at once. */
  tierOpen(t: number): void {
    if (!this.frozen()) this.#startShuffle(t + RESHUFFLE_AFTER_TIER_MS);
  }

  /** A `drained` effect: the moment plays once the reveals are done (at once when idle). */
  drained(): void {
    this.#drainedPending = true;
  }

  /** The pads stay frozen from the first fire through the last reveal. */
  frozen(): boolean {
    return this.jumpers.length > 0 || this.pending.length > 0 || this.#reveals.busy;
  }

  shuffling(t: number): boolean {
    const s = this.#shuffle;
    return s !== null && t >= s.at && t < s.until;
  }

  /** The pads slide slowly through the shuffle and for a beat after. */
  slideRate(t: number): number {
    const s = this.#shuffle;
    return s !== null && t >= s.at && t < s.until + SLIDE_SLOW_AFTER_MS ? SLIDE_SHUFFLE_RATE : SLIDE_RATE;
  }

  /** `live` in strip order: the shuffled order, with new pads dealt in at random. */
  order<T extends { id: string }>(live: readonly T[]): T[] {
    const key = live.map((o) => o.id).join("\n");
    if (key !== this.#orderKey) {
      this.#orderKey = key;
      const keep = new Set(live.map((o) => o.id));
      if (this.#order.length !== live.length || !this.#order.every((id) => keep.has(id))) this.#order = syncOrder(this.#order, live.map((o) => o.id), this.#rng);
    }
    const idx = new Map(this.#order.map((id, i) => [id, i]));
    return [...live].sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
  }

  /** How far a pad is lifted right now: an arc over LIFT_MS after it moved in a pass. */
  lift(id: string, t: number): number {
    const m = this.#lifts.get(id);
    return m !== undefined && t - m < LIFT_MS ? Math.sin(clamp((t - m) / LIFT_MS, 0, 1) * Math.PI) * LIFT_PX : 0;
  }

  /** The pad drawn white right now (the landing blink), or null. */
  flashing(t: number): string | null {
    return this.#flash !== null && flashOn(this.#flash.at, t) ? this.#flash.id : null;
  }

  #startShuffle(t: number): void {
    this.#shuffle = { at: t, passes: shufflePasses(t, this.#cfg().shuffleMs), until: t + this.#cfg().shuffleMs };
  }

  #pass(t: number): void {
    const before = this.#order;
    const after = shufflePass(before, this.#rng);
    after.forEach((id, i) => {
      if (before[i] !== id) this.#lifts.set(id, t);
    });
    this.#order = after;
  }

  /** One frame: the shuffle's passes, the wind, launches, the jumpers, the reveals, the flair. Returns the moments to play. */
  step(t: number, dt: number, frame: DropFrame): DropEvent[] {
    const events: DropEvent[] = [];
    const k = dt / 16.67;
    const cfg = this.#cfg();
    this.#lastFrame = frame;
    const s = this.#shuffle;
    if (s !== null && t >= s.at) {
      while (s.passes.length > 0 && t >= s.passes[0]!) {
        s.passes.shift();
        this.#pass(t);
      }
      if (t >= s.until + SLIDE_SLOW_AFTER_MS) this.#shuffle = null;
    }
    this.#airVis += ((this.jumpers.length > 0 ? 1 : 0) - this.#airVis) * Math.min(1, AIR_VIS_RATE * k);
    const bounds = { x0: frame.strip.x, x1: frame.strip.x + frame.strip.w, skyY: frame.skyY, groundY: frame.groundY };
    this.wind.step(t, dt, bounds, this.#theme().windBits, this.jumpers.length > 0 || this.#airVis > 0.02);
    while (this.pending.length > 0 && this.jumpers.length < cfg.maxAir) this.#launch(this.pending.shift()!, t, frame);
    const field = (x: number, y: number): { u: number; v: number } => this.wind.at(x, y);
    const centre = frame.strip.x + frame.strip.w / 2;
    for (let i = this.jumpers.length - 1; i >= 0; i--) {
      const J = this.jumpers[i]!;
      const target = padCentre(frame.pads, J.padId) ?? centre;
      if (stepJumper(J, t, dt, field, target, bounds, cfg.descentMs, this.#rng)) {
        this.jumpers.splice(i, 1);
        this.landed.push({ fireSeq: J.fireSeq, padId: J.padId, x: J.x, canopy: J.canopy, at: t, until: null }); // the pilot stays on the pad through the banner
        this.#reveals.push(J.fire); // the reveal replays the effect's own data
      }
    }
    for (let i = this.landed.length - 1; i >= 0; i--) if (this.landed[i]!.until !== null && t >= this.landed[i]!.until!) this.landed.splice(i, 1);
    const reveal = this.#reveals.step(t, cfg, this.jumpers.length + this.pending.length);
    if (reveal?.kind === "start") {
      const pose = this.landed.find((l) => l.fireSeq === reveal.fire.fireSeq);
      if (pose !== undefined) pose.until = t + (reveal.fire.miniDraw === undefined ? BANNER_MS : cfg.revealMiniDrawMs); // through the banner, or the whole reel for a mini-draw
      this.#flash = { id: reveal.fire.outcomeId, at: t };
      events.push({ kind: "reveal", fire: reveal.fire, n: reveal.n, total: reveal.total, padX: padCentre(frame.pads, reveal.fire.outcomeId) ?? centre });
    } else if (reveal?.kind === "done") {
      this.#startShuffle(t + RESHUFFLE_AFTER_REVEALS_MS);
    }
    if (this.#drainedPending && !this.frozen()) {
      this.#drainedPending = false;
      events.push({ kind: "drained" });
    }
    if (this.#fwLeft > 0 && t >= this.#fwNext) {
      const theme = this.#theme();
      const cols = [theme.gold, theme.accent, theme.accent2, theme.tiers[1] ?? theme.accent];
      const sky = frame.fireworkSky;
      this.fireworks.burst(frame.sceneL + 120 + this.#rng() * (frame.sceneR - frame.sceneL - 240), sky.top + this.#rng() * Math.max(0, sky.bottom - sky.top), cols[Math.floor(this.#rng() * cols.length)]!, this.#rng);
      this.#fwLeft--;
      this.#fwNext = t + FIREWORK_GAP_MIN_MS + this.#rng() * FIREWORK_GAP_SPAN_MS;
    }
    this.fireworks.step(k);
    this.particles.step(k);
    return events;
  }

  /** The SHUFFLING callout, the wind, the jumpers, the fireworks and the particles — over the scene; from the sheet's frames when `sprites` is given. */
  draw(ctx: CanvasRenderingContext2D, theme: Theme, frame: DropFrame, t: number, sprites: SpriteSet | null = null): void {
    const spec = sprites === null ? null : this.#spec();
    if (this.shuffling(t)) pill(ctx, SHUFFLING, frame.strip.x + frame.strip.w / 2, frame.groundY - SHUFFLE_NOTE_ABOVE, { bg: theme.panel, border: theme.gold, color: theme.gold });
    this.wind.draw(ctx, this.#airVis, t);
    for (const L of this.landed) drawLanded(ctx, theme, L, frame.groundY, sprites, spec);
    for (const J of this.jumpers) drawJumper(ctx, theme, J, frame.groundY, sprites, spec, frame.skyY);
    this.fireworks.draw(ctx, sprites, spec);
    this.particles.draw(ctx, sprites, spec, particleTints(theme));
  }
}

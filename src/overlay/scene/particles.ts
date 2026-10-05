/**
 * Cheap canvas flair (no blur or shadow filters, particles capped): the celebration burst — sparkles and
 * avatars rising over the floor, ported from the prototype's `makeParticles` — and the fireworks over the floor for
 * the top of the curve, from its `makeFlair`. Both are pools stepped on the loop's `k`; the burst never grows past
 * the Quality Level's particle cap, counting what is still alive. Random draws are the caller's seeded rng.
 * With a Theme Sheet a particle is a `spark` / `chevron` / `dot` frame tinted lemon / mint / pink — chosen from
 * its whole-pixel size (`particleLook`), so the club-deck's dice are untouched — and a firework burst is fourteen
 * `firework-ray` frames fanned a full turn about its centre, growing and fading over the sparks' life.
 */
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { glyph } from "./util.ts";

export const SPARKLES: readonly string[] = ["✦", "✧", "★"];
export const SPARKS_PER_BURST = 26;
const SPARKLE_ODDS = 0.3;
const GRAVITY = 0.012;
const SPARK_GRAVITY = 0.03;
const SPARK_DRAG = 0.985;
const SPARK_DECAY = 0.011;
// ---- the sheet's particles
export type ParticleSprite = "spark" | "chevron" | "dot";
export const PARTICLE_SPRITES: readonly ParticleSprite[] = ["spark", "chevron", "dot"];
/** The `spark` frame's content is 24 px across: a particle of `size` px draws at `size / 24`. */
export const PARTICLE_PX = 24;
export const RAYS_PER_BURST = 14;
/** A ray's scale over its life: 0.3 → 1.8 of the 90 px frame, eased out; its alpha is what is left of the life. */
const RAY_K_MIN = 0.3;
const RAY_K_SPAN = 1.5;
/** Each burst's fan starts a little further round than the last (a golden-angle walk), so no two fans align. */
const RAY_PHASE_STEP = 2.399963;
const NO_TINTS: readonly string[] = [];

/** Lemon / mint / pink from the Theme: its gold, second accent and accent — the pad halos' pastels. */
export function particleTints(theme: { gold: string; accent2: string; accent: string }): string[] {
  return [theme.gold, theme.accent2, theme.accent];
}

/** The sprite and tint (an index into `particleTints`) a particle wears on the sheet — a pure function of its whole-pixel size. */
export function particleLook(p: { size: number }): { sprite: ParticleSprite; tint: number } {
  const size = Math.round(p.size);
  return { sprite: PARTICLE_SPRITES[size % 3]!, tint: Math.floor(size / 3) % 3 };
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: string;
  life: number;
  size: number;
  decay: number;
}

/** How many of `want` may spawn with `live` already alive under `cap`. */
export function particleBudget(want: number, live: number, cap: number): number {
  return Math.max(0, Math.min(want, cap - live));
}

const pick = <T>(list: readonly T[], rng: () => number): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;

export class Particles {
  readonly list: Particle[] = [];

  /** `n` particles along `x0…x1` at `y`, rising at about `vy`, a sparkle 30 % of the time else one of `glyphs`; `lifeMul` stretches their life. */
  burst(n: number, x0: number, x1: number, y: number, vy: number, glyphs: readonly string[], lifeMul: number, cap: number, rng: () => number): void {
    const count = particleBudget(n, this.list.length, cap);
    for (let i = 0; i < count; i++) {
      this.list.push({
        x: x0 + rng() * (x1 - x0),
        y,
        vx: (rng() - 0.5) * 1.4,
        vy: -vy * (0.6 + rng() * 0.8),
        g: rng() < SPARKLE_ODDS ? pick(SPARKLES, rng) : pick(glyphs, rng),
        life: 1,
        size: Math.round(14 + rng() * 14 * (0.7 + lifeMul * 0.4)), // whole pixels: a handful of font strings, parsed once, not one per particle
        decay: (0.0055 + rng() * 0.004) / lifeMul,
      });
    }
  }

  step(k: number): void {
    const P = this.list;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]!;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += GRAVITY * k;
      p.life -= p.decay * k;
      if (p.life <= 0) P.splice(i, 1);
    }
  }

  /** The particles: sheet frames tinted from `tints` (by `particleLook`) when a Theme Sheet is present, else the glyphs. */
  draw(ctx: CanvasRenderingContext2D, sprites: SpriteSet | null = null, spec: LevelSpec | null = null, tints: readonly string[] = NO_TINTS): void {
    if (sprites !== null && spec !== null) {
      const s = spec.spriteScale;
      for (const p of this.list) {
        const look = particleLook(p);
        sprites.draw(ctx, look.sprite, s, p.x, p.y, { colour: tints[look.tint], k: p.size / PARTICLE_PX, alpha: Math.min(1, p.life * 1.5) });
      }
      return;
    }
    for (const p of this.list) {
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      glyph(ctx, p.g, p.x, p.y, p.size);
    }
    ctx.globalAlpha = 1;
  }
}

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  col: string;
  r: number;
}

/** A burst as the sheet draws it: a fan of rays about (x, y), `age` 0 → 1 over the sparks' life. */
export interface Burst {
  x: number;
  y: number;
  col: string;
  age: number;
  /** Where the fan's first ray points. */
  phase: number;
}

export class Fireworks {
  readonly list: Spark[] = [];
  readonly bursts: Burst[] = [];
  #fans = 0;

  /** One burst: a ring of sparks from (x, y) in `col` — and, for the sheet, the fan of rays with the same life. */
  burst(x: number, y: number, col: string, rng: () => number): void {
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      const a = (i / SPARKS_PER_BURST) * Math.PI * 2;
      const sp = 2.2 + rng() * 2.2;
      this.list.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col, r: 2 + rng() * 2 });
    }
    this.bursts.push({ x, y, col, age: 0, phase: (this.#fans++ * RAY_PHASE_STEP) % ((Math.PI * 2) / RAYS_PER_BURST) });
  }

  step(k: number): void {
    const F = this.list;
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i]!;
      f.x += f.vx * k;
      f.y += f.vy * k;
      f.vy += SPARK_GRAVITY * k;
      f.vx *= SPARK_DRAG;
      f.life -= SPARK_DECAY * k;
      if (f.life <= 0) F.splice(i, 1);
    }
    const B = this.bursts;
    for (let i = B.length - 1; i >= 0; i--) {
      const b = B[i]!;
      b.age += SPARK_DECAY * k;
      if (b.age >= 1) B.splice(i, 1);
    }
  }

  /** The fireworks: on the sheet RAYS_PER_BURST `firework-ray` frames per burst, tails at its centre, growing and fading; else the sparks. */
  draw(ctx: CanvasRenderingContext2D, sprites: SpriteSet | null = null, spec: LevelSpec | null = null): void {
    if (sprites !== null && spec !== null) {
      const s = spec.spriteScale;
      const step = (Math.PI * 2) / RAYS_PER_BURST;
      for (const b of this.bursts) {
        const eased = 1 - (1 - b.age) * (1 - b.age);
        const k = RAY_K_MIN + RAY_K_SPAN * eased;
        const alpha = 1 - b.age;
        for (let i = 0; i < RAYS_PER_BURST; i++) sprites.draw(ctx, "firework-ray", s, b.x, b.y, { colour: b.col, k, alpha, rotate: b.phase + i * step });
      }
      return;
    }
    for (const f of this.list) {
      ctx.globalAlpha = f.life;
      ctx.fillStyle = f.col;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.5 + f.life * 0.5), 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

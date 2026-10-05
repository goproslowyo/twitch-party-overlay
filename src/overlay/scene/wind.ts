/**
 * The wind (ported from the prototype's `stepWind` / `fieldAt` / `drawWind`): a 2-D field of
 * GX × GY cells, each gusting on its own; every step a cell blends toward the mean of its neighbours (strong flow
 * pushes into weak flow; opposing flows shear into a calm zone instead of cancelling by fiat), and the vertical
 * component comes from horizontal convergence (air meeting → lift, air parting → sink). Drawn as long tapered wavy
 * ribbons — thin ends, a little heavier in the middle, no bright head, so they never read as birds — evenly respawned
 * (pure advection piles them up where the flow converges), plus blown bits, only while someone is in the air. The
 * cells step every frame so the windsock answers even with an empty sky; the ribbons exist only while visible.
 * Every random draw comes from the scene's seeded rng; every time is the loop's.
 */
import { clamp, glyph } from "./util.ts";

export const GX = 6;
export const GY = 4;
export const RIBBONS = 90;
export const BITS = 18;
export const TRAIL_MAX = 28;
const TRAIL_MIN_DRAWN = 12;
const SKY_MARGIN = 140;
const GUST_MIN_MS = 1400;
const GUST_SPAN_MS = 2600;
const GUST_MILD = 1.4;
const GUST_STRONG = 2.6;
const STRONG_ODDS = 0.25;
const RAW_RATE = 0.012;
const BLEND_RATE = 0.08;
const LIFT_RATE = 0.1;
const LIFT_GAIN = 0.35;
const RIBBON_SPEED = 4.2;
const RIBBON_LIFT = 1.8;
const BIT_SPEED = 2.6;
const BIT_LIFT = 1.2;

export interface WindCell {
  raw: number;
  u: number;
  v: number;
  target: number;
  gustT: number;
  phase: number;
}

/** The field's box: the pad strip's x-span, from the sky line down to the touchdown line. */
export interface WindBounds {
  x0: number;
  x1: number;
  skyY: number;
  groundY: number;
}

export interface Ribbon {
  x: number;
  y: number;
  trail: Array<{ x: number; y: number }>;
  life: number;
  ph: number;
  amp: number;
  sp: number;
}

export interface WindBit {
  x: number;
  y: number;
  g: string;
  ph: number;
  life: number;
  age: number;
}

export function createCells(rng: () => number): WindCell[] {
  const cells: WindCell[] = [];
  for (let n = 0; n < GX * GY; n++) cells.push({ raw: 0, u: 0, v: 0, target: (rng() * 2 - 1) * GUST_MILD, gustT: rng() * 2000, phase: rng() * 6.28 });
  return cells;
}

const at = (cells: readonly WindCell[], i: number, j: number): WindCell => cells[clamp(j, 0, GY - 1) * GX + clamp(i, 0, GX - 1)]!;

/** One frame (`k` = dt / 16.67): gusts, then the neighbour blend, then lift/sink from convergence. */
export function stepCells(cells: WindCell[], t: number, k: number, rng: () => number): void {
  for (const c of cells) {
    if (t > c.gustT) {
      const strong = rng() < STRONG_ODDS;
      c.target = (rng() * 2 - 1) * (strong ? GUST_STRONG : GUST_MILD);
      c.gustT = t + GUST_MIN_MS + rng() * GUST_SPAN_MS;
    }
    c.raw += (c.target - c.raw) * Math.min(1, RAW_RATE * k);
  }
  const prev = cells.map((c) => c.u);
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const c = at(cells, i, j);
      let sum = 0;
      let n = 0;
      if (i > 0) (sum += prev[j * GX + i - 1]!), n++;
      if (i < GX - 1) (sum += prev[j * GX + i + 1]!), n++;
      if (j > 0) (sum += prev[(j - 1) * GX + i]!), n++;
      if (j < GY - 1) (sum += prev[(j + 1) * GX + i]!), n++;
      const want = 0.6 * (c.raw + Math.sin(t / 1100 + c.phase) * 0.3) + 0.4 * (sum / n);
      c.u += (want - c.u) * Math.min(1, BLEND_RATE * k);
    }
  }
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const c = at(cells, i, j);
      const uL = i > 0 ? at(cells, i - 1, j).u : c.u;
      const uR = i < GX - 1 ? at(cells, i + 1, j).u : c.u;
      c.v += ((uL - uR) * LIFT_GAIN - c.v) * Math.min(1, LIFT_RATE * k); // uL blowing right into uR blowing left → convergence → lift
    }
  }
}

/** Bilinear sample at a point: `u` sideways, `v` up-positive; clamped to the box. */
export function sampleField(cells: readonly WindCell[], b: WindBounds, x: number, y: number): { u: number; v: number } {
  const fx = clamp((x - b.x0) / (b.x1 - b.x0), 0, 1) * (GX - 1);
  const fy = clamp((y - b.skyY) / (b.groundY - b.skyY), 0, 1) * (GY - 1);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const rx = fx - i;
  const ry = fy - j;
  const c00 = at(cells, i, j);
  const c10 = at(cells, i + 1, j);
  const c01 = at(cells, i, j + 1);
  const c11 = at(cells, i + 1, j + 1);
  return {
    u: (c00.u * (1 - rx) + c10.u * rx) * (1 - ry) + (c01.u * (1 - rx) + c11.u * rx) * ry,
    v: (c00.v * (1 - rx) + c10.v * rx) * (1 - ry) + (c01.v * (1 - rx) + c11.v * rx) * ry,
  };
}

/** The ground row's mean sideways wind — what the windsock reads. */
export function groundWind(cells: readonly WindCell[]): number {
  let sum = 0;
  for (let i = 0; i < GX; i++) sum += at(cells, i, GY - 1).u;
  return sum / GX;
}

const CALM = { u: 0, v: 0 };

export class WindField {
  readonly cells: WindCell[];
  ribbons: Ribbon[] = [];
  bits: WindBit[] = [];
  #bounds: WindBounds | null = null;
  readonly #rng: () => number;

  constructor(rng: () => number) {
    this.#rng = rng;
    this.cells = createCells(rng);
  }

  at(x: number, y: number): { u: number; v: number } {
    return this.#bounds === null ? CALM : sampleField(this.cells, this.#bounds, x, y);
  }

  ground(): number {
    return groundWind(this.cells);
  }

  /** Advance the cells; while `visible`, advect the ribbons and bits through the field (spawning them on first sight). */
  step(t: number, dt: number, b: WindBounds, windBits: readonly string[], visible: boolean): void {
    const k = dt / 16.67;
    this.#bounds = b;
    stepCells(this.cells, t, k, this.#rng);
    if (!visible) {
      this.ribbons.length = 0;
      this.bits.length = 0;
      return;
    }
    const rng = this.#rng;
    const x0 = b.x0 - SKY_MARGIN;
    const x1 = b.x1 + SKY_MARGIN;
    const spawn = (r: Ribbon): void => {
      r.x = x0 + rng() * (x1 - x0);
      r.y = b.skyY + rng() * (b.groundY - b.skyY);
      r.trail = [];
      r.life = 2600 + rng() * 2600;
      r.ph = rng() * 6.28;
      r.amp = 3 + rng() * 5;
      r.sp = 0.8 + rng() * 0.7;
    };
    while (this.ribbons.length < RIBBONS) {
      const r: Ribbon = { x: 0, y: 0, trail: [], life: 0, ph: 0, amp: 0, sp: 0 };
      spawn(r);
      r.life *= rng();
      this.ribbons.push(r);
    }
    for (const r of this.ribbons) {
      const f = sampleField(this.cells, b, r.x, r.y);
      r.x += f.u * RIBBON_SPEED * r.sp * k;
      r.y += (-f.v * RIBBON_LIFT + Math.sin(t / 420 + r.ph) * 0.35) * k;
      r.trail.push({ x: r.x, y: r.y });
      if (r.trail.length > TRAIL_MAX) r.trail.shift();
      r.life -= dt;
      if (r.life <= 0 || r.x < x0 || r.x > x1 || r.y < b.skyY || r.y > b.groundY) spawn(r);
    }
    const glyphs = windBits.length > 0 ? windBits : ["·"];
    const spawnBit = (bit: WindBit): void => {
      bit.x = x0 + rng() * (x1 - x0);
      bit.y = b.skyY + rng() * (b.groundY - b.skyY);
      bit.g = glyphs[Math.min(glyphs.length - 1, Math.floor(rng() * glyphs.length))]!;
      bit.ph = rng() * 6.28;
      bit.life = 4000 + rng() * 5000;
      bit.age = 0;
    };
    while (this.bits.length < BITS) {
      const bit: WindBit = { x: 0, y: 0, g: "·", ph: 0, life: 0, age: 0 };
      spawnBit(bit);
      bit.life *= rng();
      this.bits.push(bit);
    }
    for (const bit of this.bits) {
      const f = sampleField(this.cells, b, bit.x, bit.y);
      bit.x += f.u * BIT_SPEED * k;
      bit.y += (-f.v * BIT_LIFT + Math.sin(t / 600 + bit.ph) * 0.4) * k;
      bit.life -= dt;
      bit.age += dt;
      if (bit.life <= 0 || bit.x < x0 || bit.x > x1 || bit.y < b.skyY || bit.y > b.groundY) spawnBit(bit);
    }
  }

  /** The ribbons (three chunks: faint thin tail, heavier middle, thin end — a streamer, not an arrowhead) and the bits, at `alpha`. */
  draw(ctx: CanvasRenderingContext2D, alpha: number, t: number): void {
    const b = this.#bounds;
    if (alpha <= 0.02 || b === null) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x0 - SKY_MARGIN - 10, b.skyY - 10, b.x1 - b.x0 + 2 * SKY_MARGIN + 20, b.groundY - b.skyY + 10);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const r of this.ribbons) {
      const n = r.trail.length;
      if (n < TRAIL_MIN_DRAWN) continue;
      const f = sampleField(this.cells, b, r.x, r.y);
      const str = Math.min(1, Math.hypot(f.u, f.v * 2) / GUST_STRONG);
      const fade = Math.min(1, r.life / 500, (5200 - r.life) / 500);
      // one long gentle wave along the ribbon, amplitude growing toward the middle then easing off
      const pts = r.trail.map((q, i) => ({ x: q.x, y: q.y + Math.sin(i * 0.26 + r.ph + t / 900) * r.amp * Math.sin((i / n) * Math.PI) }));
      const chunk = (a: number, z: number, w: number, al: number): void => {
        if (z - a < 2) return;
        ctx.lineWidth = w;
        ctx.strokeStyle = `rgba(255,255,255,${(al * (0.35 + 0.65 * str) * fade * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(pts[a]!.x, pts[a]!.y);
        for (let i = a + 1; i < z; i++) {
          const p = pts[i]!;
          const q = pts[Math.min(n - 1, i + 1)]!;
          ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
        }
        ctx.stroke();
      };
      const q1 = Math.floor(n / 4);
      const q3 = Math.floor((3 * n) / 4);
      chunk(0, q1 + 1, 0.9, 0.16);
      chunk(q1, q3 + 1, 1.7, 0.36);
      chunk(q3, n, 1.0, 0.2);
    }
    for (const bit of this.bits) {
      const f = sampleField(this.cells, b, bit.x, bit.y);
      const fade = Math.min(1, bit.age / 600, bit.life / 600);
      ctx.globalAlpha = (0.25 + 0.45 * Math.min(1, Math.abs(f.u) / 2.4)) * fade * alpha;
      glyph(ctx, bit.g, bit.x, bit.y, bit.g === "·" ? 22 : 16);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

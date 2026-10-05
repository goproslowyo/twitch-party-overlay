/**
 * Canvas helpers shared by the scene modules, ported from the prototype's `roundRect` / `glyph` / `pill` — plus a
 * seeded PRNG so the crowd, the towers and every wandering aim are reproducible in a test (the prototype rolled
 * unseeded dice). Nothing here reads a clock: every `t` is the loop's.
 */

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A number in [0, 1) each call — mulberry32, seeded so a scene can be replayed exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hex colour (`#rrggbb`) at alpha `a`; anything else is returned untouched (the theme may already hold an rgba). */
export function rgba(hex: string, a: number): string {
  if (hex.length !== 7 || hex[0] !== "#") return hex;
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}

const unitCache = new Map<string, readonly [number, number, number]>();

/** A hex colour (`#rrggbb`) as unit RGB for the light layer (parsed once per colour); anything else reads as white. */
export function unitRgb(hex: string): [number, number, number] {
  let c = unitCache.get(hex);
  if (c === undefined) {
    c = hex.length === 7 && hex[0] === "#" ? [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255] : [1, 1, 1];
    unitCache.set(hex, c);
  }
  return [c[0], c[1], c[2]];
}

/** A blend of two hex colours (`#rrggbb`) at `t` (0 = a, 1 = b) as `rgb(...)`; anything else falls back to the nearer one. */
export function mix(a: string, b: string, t: number): string {
  if (a.length !== 7 || b.length !== 7 || a[0] !== "#" || b[0] !== "#") return t < 0.5 ? a : b;
  const ch = (i: number): number => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
  return `rgb(${ch(1)},${ch(3)},${ch(5)})`;
}

/** A rounded rectangle path (no fill/stroke): the prototype's, radius clamped to the shorter half-side. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (w <= 0 || h <= 0) return;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** An emoji centred on (x, y) at `size` px. */
export function glyph(ctx: CanvasRenderingContext2D, g: string, x: number, y: number, size: number): void {
  ctx.font = `${size}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(g, x, y);
}

export interface PillOptions {
  font?: string;
  h?: number;
  bg: string;
  border?: string;
  color?: string;
}

/** A centred text pill: panel background, optional border. */
export function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: PillOptions): void {
  ctx.font = o.font ?? "800 15px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 26;
  const h = o.h ?? 30;
  ctx.fillStyle = o.bg;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  if (o.border !== undefined) {
    ctx.strokeStyle = o.border;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.fillStyle = o.color ?? "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 1);
  ctx.textBaseline = "alphabetic";
}

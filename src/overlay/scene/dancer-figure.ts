/**
 * The Dancer figure (sprite-list.md §8): a capsule stick figure in a 140×176 box, feet on y = 168, ported from the
 * prototype's `figure(p)` / `mirror` / `POSES`. Pure geometry — the sprite script bakes it (`figureSvg`) and the scene
 * only ever draws the baked frames. No clock, no rng, no canvas here.
 *
 * The undefined-filter fix is kept: `mirror` copies unset keys as `undefined`, and a plain Object.assign would let an
 * `undefined` crouch win over the default and turn every leg joint into NaN (the legless-Dancer bug).
 */

/** An arm: [upper-arm angle, forearm angle] in radians from straight down; positive swings outward (front view). */
export type ArmAngles = readonly [number, number];

export interface Pose {
  /** Shoulders shifted from the hips along x. */
  lean?: number;
  /** Hips lowered by this many px. */
  crouch?: number;
  /** Hips shifted along x. */
  hip?: number;
  /** Half the distance between the feet. */
  spread?: number;
  aL?: ArmAngles;
  aR?: ArmAngles;
  /** Holding a drink: a disc at the right hand. */
  cup?: boolean;
  /** Side view facing +x: narrow shoulders, a nose, arms swing fore / aft along x. */
  profile?: boolean;
}

/** A capsule: [x1, y1, x2, y2, radius]. */
export type Capsule = readonly [number, number, number, number, number];

export interface Figure {
  /** torso, shoulders, left upper arm, left forearm, right upper arm, right forearm, left thigh, left shin, right thigh, right shin. */
  parts: Capsule[];
  /** [cx, cy, r] */
  head: readonly [number, number, number];
  /** The right hand's position when the pose holds a drink, else null. */
  cup: readonly [number, number] | null;
  /** [cx, cy, r] on a profile figure, else null. */
  nose: readonly [number, number, number] | null;
}

export const FIGURE_W = 140;
export const FIGURE_H = 176;
export const FLOOR_Y = 168;
export const BODY_COLOUR = "#0a0818";

const DEFAULTS: Required<Pose> = { lean: 0, crouch: 0, hip: 0, spread: 9, aL: [0.15, 0.25], aR: [0.15, 0.25], cup: false, profile: false };

const defined = (p: Pose): Partial<Pose> => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Partial<Pose>;

export function figure(pose: Pose): Figure {
  const p: Required<Pose> = { ...DEFAULTS, ...defined(pose) };
  const hx = 70 + p.hip;
  const hy = 100 + p.crouch;
  const sx = hx + p.lean;
  const sy = hy - 42;
  const parts: Capsule[] = [];
  const sh = p.profile ? 5 : 14; // profile: narrow shoulders (side view), arms swing fore / aft along x
  parts.push([hx, hy, sx, sy, p.profile ? 11 : 13], [sx - sh, sy, sx + sh, sy, 7]);
  const arm = (x: number, y: number, a: ArmAngles, d: 1 | -1): readonly [number, number] => {
    const ex = x + d * Math.sin(a[0]) * 24;
    const ey = y + Math.cos(a[0]) * 24;
    const wx = ex + d * Math.sin(a[1]) * 22;
    const wy = ey + Math.cos(a[1]) * 22;
    parts.push([x, y, ex, ey, 5.5], [ex, ey, wx, wy, 5]);
    return [wx, wy];
  };
  arm(sx - sh + 1, sy, p.aL, -1);
  const hr = arm(sx + sh - 1, sy, p.aR, 1);
  const leg = (x: number, fx: number): void => {
    const dx = fx - x;
    const dy = FLOOR_Y - hy;
    const d = Math.hypot(dx, dy);
    const h = Math.sqrt(Math.max(0, 900 - (Math.min(d, 60) / 2) ** 2));
    let kx = (x + fx) / 2 - (dy / d) * h;
    let ky = (hy + FLOOR_Y) / 2 + (dx / d) * h;
    if ((kx - 70) * (fx - 70 || x - 70) < 0) {
      kx = (x + fx) / 2 + (dy / d) * h;
      ky = (hy + FLOOR_Y) / 2 - (dx / d) * h;
    }
    parts.push([x, hy, kx, ky, 6.5], [kx, ky, fx, FLOOR_Y, 6]);
  };
  leg(hx - 7, 70 - p.spread);
  leg(hx + 7, 70 + p.spread);
  const head = [sx + p.lean * 0.4, sy - 21, 11.5] as const;
  return { parts, head, cup: p.cup ? hr : null, nose: p.profile ? [head[0] + 11, head[1] + 2, 4] : null };
}

/** Throws (naming `label`) if any capsule, the head, the cup or the nose has a non-finite coordinate — the legless-Dancer guard, run over the whole table before anyone is drawn. */
export function assertNoNaN(f: Figure, label = "figure"): void {
  const nums: number[] = [...f.head];
  for (const c of f.parts) nums.push(...c);
  if (f.cup) nums.push(...f.cup);
  if (f.nose) nums.push(...f.nose);
  if (!nums.every(Number.isFinite)) throw new Error(`dancer figure "${label}" has non-finite geometry`);
}

/** The same pose facing the other way: lean, hip and the arms swap sides; keys the pose leaves unset stay unset. */
export const mirror = (f: Pose): Pose => ({ lean: -(f.lean ?? 0), hip: -(f.hip ?? 0), crouch: f.crouch, spread: f.spread, aL: f.aR, aR: f.aL, cup: f.cup });

const swayL: Pose[] = [
  { lean: -9, hip: -4, aL: [0.5, 0.8], aR: [0.25, 0.6] },
  { lean: -4, hip: -2, crouch: 3, aL: [0.4, 0.7], aR: [0.3, 0.5] },
];

export const POSES = {
  up: [
    { aL: [2.9, 3.05], aR: [2.9, 3.05] },
    { aL: [2.5, 2.8], aR: [2.5, 2.8], crouch: 3 },
    { aL: [3.0, 2.6], aR: [3.0, 2.6], crouch: 1 },
  ],
  swayL,
  swayR: swayL.map(mirror),
  step: [
    { spread: 20, hip: -7, crouch: 2, aL: [0.35, 1.5], aR: [0.35, 1.5] },
    { spread: 20, hip: 7, crouch: 2, aL: [0.3, 1.3], aR: [0.4, 1.6] },
  ],
  bounce: [
    { aL: [0.3, 2.3], aR: [0.3, 2.3] },
    { crouch: 8, aL: [0.35, 2.0], aR: [0.35, 2.0] },
    { crouch: 3, aL: [0.3, 2.5], aR: [0.3, 2.5] },
  ],
  drink: [
    { cup: true, aR: [0.2, -2.3], aL: [0.12, 0.25] },
    { cup: true, aR: [0.6, -2.6], aL: [0.12, 0.25], lean: 2 },
    { cup: true, aR: [0.2, -2.3], aL: [0.12, 0.25], lean: -2 },
  ],
  // the side-profile walk, drawn facing +x (stride · pass · stride); the scene flips it by the sign of travel
  walk: [
    { profile: true, lean: 4, spread: 17, aL: [0.55, 0.9], aR: [-0.5, -0.8] },
    { profile: true, lean: 4, spread: 3, crouch: 3, aL: [0.1, 0.2], aR: [-0.1, -0.2] },
    { profile: true, lean: 4, spread: 17, aL: [-0.5, -0.8], aR: [0.55, 0.9] },
  ],
  // ---- the Moves: front-facing, arms / hip / lean / crouch only, one frame per beat, looped twice
  // the Carlton: arms swing up on alternating sides while the hips sway with them
  carlton: [
    { hip: -6, lean: -5, aL: [2.6, 3.0], aR: [1.2, 2.2] },
    { crouch: 3, aL: [1.9, 2.6], aR: [1.9, 2.6] },
    { hip: 6, lean: 5, aL: [1.2, 2.2], aR: [2.6, 3.0] },
    { crouch: 5, spread: 14, aL: [1.6, 2.4], aR: [1.6, 2.4] },
  ],
  // the Sprinkler: the left hand behind the head, the right arm out and sweeping down in steps, then back up
  sprinkler: [
    { hip: -3, lean: 2, aL: [2.6, -1.2], aR: [1.5, 1.5] },
    { hip: -2, lean: 3, crouch: 2, aL: [2.6, -1.2], aR: [1.25, 1.25] },
    { hip: -1, lean: 4, crouch: 3, aL: [2.6, -1.2], aR: [1.0, 1.0] },
    { lean: 5, crouch: 4, aL: [2.6, -1.2], aR: [0.7, 0.7] },
  ],
  // the Shopping Cart: both forearms out on the bar, a lean into it, one hand then the other grabbing from the shelf
  shoppingCart: [
    { lean: 4, aL: [0.3, 1.6], aR: [0.3, 1.6] },
    { lean: 6, crouch: 2, aL: [0.3, 1.6], aR: [1.6, 2.6] },
    { lean: 3, hip: 2, crouch: 1, aL: [0.35, 1.5], aR: [0.35, 1.5] },
    { lean: 6, crouch: 2, aL: [1.6, 2.6], aR: [0.3, 1.6] },
  ],
  // the Robot: right-angle arms held, the hips shifting side to side, a small crouch
  robot: [
    { hip: 3, crouch: 2, aL: [1.35, 1.35], aR: [1.35, 3.1] },
    { hip: 3, crouch: 4, aL: [1.35, 3.1], aR: [1.35, 3.1] },
    { hip: -3, crouch: 2, aL: [1.35, 3.1], aR: [1.35, 1.35] },
    { hip: -3, crouch: 4, aL: [0.2, 1.35], aR: [0.2, 1.35] },
  ],
} as const satisfies Record<string, readonly Pose[]>;

export type PoseName = keyof typeof POSES;

/** The dance-pose cycle a standing Dancer walks through (the prototype's order; `walk` is for travel only). */
export const DANCE: readonly PoseName[] = ["up", "swayL", "swayR", "step", "bounce", "bounce", "drink", "step", "swayL", "swayR"];

/** The four Moves: a dancer breaks into one at random; four frames each, one per beat, looped twice. Never in `DANCE`. */
export const MOVES: readonly PoseName[] = ["carlton", "sprinkler", "shoppingCart", "robot"];

const n = (v: number): string => (Math.round(v * 100) / 100).toString();

/** The figure's capsules and discs as SVG, filled/stroked with `colour`, grown by `grow` px, shifted by (dx, dy). */
function shapes(f: Figure, colour: string, grow: number, dx: number, dy: number): string {
  const out: string[] = [];
  for (const [x1, y1, x2, y2, r] of f.parts) {
    out.push(`<line x1="${n(x1 + dx)}" y1="${n(y1 + dy)}" x2="${n(x2 + dx)}" y2="${n(y2 + dy)}" stroke="${colour}" stroke-width="${n(r * 2 + grow)}" stroke-linecap="round"/>`);
  }
  const disc = (cx: number, cy: number, r: number): void => {
    out.push(`<circle cx="${n(cx + dx)}" cy="${n(cy + dy)}" r="${n(r + grow / 2)}" fill="${colour}"/>`);
  };
  disc(f.head[0], f.head[1], f.head[2]);
  if (f.cup) disc(f.cup[0], f.cup[1] - 4, 5);
  if (f.nose) disc(f.nose[0], f.nose[1], f.nose[2]);
  return out.join("");
}

/**
 * One 140×176 frame of the figure as an SVG fragment (no outer `<svg>`): `body` is the flat near-black silhouette;
 * `rim` is the white rim light on the top-left edges — the white silhouette (plus a soft, grown copy shifted up-left)
 * minus the silhouette shifted down-right — for a runtime tint to the nearest sweep's colour. `id` namespaces the mask.
 */
export function figureSvg(f: Figure, mode: "body" | "rim", id = "dancer"): string {
  if (mode === "body") return `<g>${shapes(f, BODY_COLOUR, 0, 0, 0)}</g>`;
  const mask = `${id}_rimmask`;
  return (
    `<mask id="${mask}" maskUnits="userSpaceOnUse" x="0" y="0" width="${FIGURE_W}" height="${FIGURE_H}">` +
    `<rect x="0" y="0" width="${FIGURE_W}" height="${FIGURE_H}" fill="#fff"/>` +
    shapes(f, "#000", 0, 2.4, 2.4) +
    `</mask>` +
    `<g mask="url(#${mask})">` +
    `<g opacity="0.3">${shapes(f, "#fff", 3, -1.5, -1.5)}</g>` +
    shapes(f, "#fff", 0, 0, 0) +
    `</g>`
  );
}

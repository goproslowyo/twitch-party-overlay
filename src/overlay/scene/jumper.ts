/**
 * A jumper (ported from the prototype's `makeDrop.fire` / `step` and `drawJumper`): canopy size
 * ↔ sink rate (a parachute is all drag, so a smaller canopy comes down faster, ±40 %), a PILOT with its own authority
 * and steering inertia (no snap reversals), lazy S-curves carved on top of wind + steering, one trick per descent
 * (a SPIRAL corkscrew ≈ ½, a CARTWHEEL ≈ ¼, clean ≈ ¼), canopy depth shading and a ground shadow that sharpens as the
 * ground comes up. The pilot's target is the pad the server drew: it steers toward that pad's centre throughout
 * (wandering a little around it so no two jumpers fly the same line) and the last 20 % of the descent eases x onto
 * the centre exactly, so a landing never disagrees with the Ledger. Every random draw is the caller's seeded rng;
 * every time is the loop's. The jumper is nobody in particular (Unlocks are communal) — a pilot under a canopy,
 * nothing lettered over it, a plain ring for the harness disc; whoever is thanked was thanked at contribution time.
 * With a Theme Sheet the rig is the sheet's: `pilot-shadow-{0,1,2}` on the touchdown line, sharper as the ground
 * comes up → `canopy-a` / `canopy-b` (the Theme's two canopy hues) + `canopy-gloss` — the `canopy-side-{i}` trio while
 * the spiral turns the canopy side-on → `risers` → `pilot`, the one Coloured Sprite, hung RISER_DROP under the rim so
 * its hands land on the risers' straps; all at JUMPER_K × the canopy's own scale, swinging about the hands. After
 * touchdown `drawLanded` keeps the pilot standing on the pad through the banner (task-99 MUST 1): the canopy is
 * gone, the boots on the touchdown line, the sharp shadow under them — still nobody in particular.
 */
import type { Theme } from "../../config/schema.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { clamp } from "./util.ts";

export type Trick = "spiral" | "cartwheel" | "none";

export interface Jumper {
  fireSeq: number;
  padId: string;
  x: number;
  y: number;
  t0: number;
  /** Sink rate 0.65–1.45; the canopy scale follows it the other way. */
  rate: number;
  canopy: number;
  /** How much of the wind this canopy takes. */
  jw: number;
  jit: number;
  /** The eased sideways velocity (inertia). */
  lw: number;
  sPhase: number;
  sRate: number;
  sAmp: number;
  sway: number;
  trick: Trick;
  trickAt: number;
  tp: number;
  /** Side-on squash mid-spiral (1 = full width). */
  sxk: number;
  /** The corkscrew's lateral swing — a draw offset, 0 outside the trick. */
  spiralOff: number;
  pilot: { wander: number; nextT: number; authority: number };
}

export interface JumperBounds {
  /** The pad strip's edges: past them the wind eases the canopy back inward. */
  x0: number;
  x1: number;
  skyY: number;
  groundY: number;
}

export const RATE_MIN = 0.65;
export const RATE_SPAN = 0.8;
export const SPIRAL_MS = 3000;
export const CARTWHEEL_MS = 1300;
export const EASE_FROM = 0.8;
const TRICK_EARLIEST = 0.12;
const TRICK_DONE_BY = 0.75;
const WANDER_PX = 40;
const STEER_RANGE_PX = 110;
const STEER_CLAMP = 1.2;
const STEER_GAIN = 0.9;
const EDGE_INSET = 30;
const INERTIA = 0.06;
const SIDE_SPEED = 2.1;
const CANOPY_R = 46;
// ---- the sheet's rig
/** The rig's world scale: the boards' 300 px canopy is a hero; on a 55 px pad strip 0.7 of it reads right. */
export const JUMPER_K = 0.7;
/**
 * The `risers` frame is RISER_DROP + 8 tall with its Anchor 4 px in (scripts/sprites/draw.ts RISER_DROP; jumper.test.ts
 * checks it against the atlas): drawn at the canopy's Anchor (the rim centre) its straps end RISER_DROP below it, and
 * `pilot`'s Anchor is its hands line — so the pilot goes RISER_DROP under the canopy and the hands meet the straps.
 */
export const RISER_DROP = 130;
/** `pilot`: the boots' centre line under the hands (the Anchor) — scripts/sprites/draw.ts PILOT_FEET_Y, the number its boot ellipses use; jumper.test.ts pins this to it (the scene never imports the script: it loads resvg). The boots stand on the touchdown line. */
export const PILOT_FEET = 131;
/** The shadow frames: soft until half way, firmer, then the sharp one over the last tenth. */
const SHADOW_MID_FROM = 0.5;
const SHADOW_SHARP_FROM = 0.9;
const SHADOW_ALPHA_MIN = 0.35;
/** The club-deck's shadow rule — sharp over the last 500 px — is the default sky line when the caller has none. */
const SHADOW_RANGE_PX = 500;
/** The side frames' widths (draw.ts canopyDefs: 0.45 / 0.7 / 1); a squash is drawn with the nearest. */
const SIDE_XS: readonly number[] = [0.45, 0.7, 1];

/** Which `pilot-shadow-{n}` a jumper `progress` of the way down casts. */
export function shadowFrame(progress: number): 0 | 1 | 2 {
  return progress >= SHADOW_SHARP_FROM ? 2 : progress >= SHADOW_MID_FROM ? 1 : 0;
}

/** The canopy frames for a side-on squash `sxk` (1 = full width): the plain trio, or the nearest `canopy-side-{i}` trio, with the width it was baked at. */
export function canopyFrames(sxk: number): { a: string; b: string; gloss: string; xs: number } {
  let i = 0;
  for (let j = 1; j < SIDE_XS.length; j++) if (Math.abs(SIDE_XS[j]! - sxk) < Math.abs(SIDE_XS[i]! - sxk)) i = j;
  const xs = SIDE_XS[i]!;
  if (xs === 1) return { a: "canopy-a", b: "canopy-b", gloss: "canopy-gloss", xs };
  return { a: `canopy-side-${i}-a`, b: `canopy-side-${i}-b`, gloss: `canopy-side-${i}-gloss`, xs };
}

const trickOf = (r: number): Trick => (r < 0.5 ? "spiral" : r < 0.75 ? "cartwheel" : "none");
const trickMs = (trick: Trick): number => (trick === "spiral" ? SPIRAL_MS : trick === "cartwheel" ? CARTWHEEL_MS : 0);

export function createJumper(spawn: { x: number; y: number }, padId: string, t: number, descentMs: number, rng: () => number, fireSeq = 0): Jumper {
  const rate = RATE_MIN + rng() * RATE_SPAN;
  const canopy = 1.25 - (rate - RATE_MIN) * 0.45;
  const expected = descentMs / rate;
  const trick = trickOf(rng());
  const window = Math.max(0, (TRICK_DONE_BY - TRICK_EARLIEST) * expected - trickMs(trick));
  return {
    fireSeq,
    padId,
    x: spawn.x,
    y: spawn.y,
    t0: t,
    rate,
    canopy,
    jw: 0.7 + rng() * 0.5,
    jit: rng() * 6.28,
    lw: 0,
    sPhase: rng() * 6.28,
    sRate: 0.0012 + rng() * 0.0012,
    sAmp: 0.3 + rng() * 0.7,
    sway: 0,
    trick,
    trickAt: t + TRICK_EARLIEST * expected + rng() * window,
    tp: 0,
    sxk: 1,
    spiralOff: 0,
    pilot: { wander: (rng() * 2 - 1) * WANDER_PX, nextT: t + 800 + rng() * 1500, authority: 0.8 + rng() * 0.7 },
  };
}

/** How far down the descent is, 0 at the sky line, 1 at the touchdown line. */
export function progressOf(J: Pick<Jumper, "y">, b: JumperBounds): number {
  return clamp((J.y - b.skyY) / (b.groundY - b.skyY), 0, 1);
}

/** The pilot's pull toward `target`: proportional over STEER_RANGE_PX, clamped, scaled by its authority. */
export function steer(target: number, x: number, authority: number): number {
  return clamp((target - x) / STEER_RANGE_PX, -STEER_CLAMP, STEER_CLAMP) * authority * STEER_GAIN;
}

/** The final approach: from 80 % down a pull toward the pad's centre that grows to exact at 100 %. */
export function easeOnto(x: number, target: number, progress: number): number {
  if (progress <= EASE_FROM) return x;
  const e = Math.min(1, (progress - EASE_FROM) / (1 - EASE_FROM));
  return x + (target - x) * e * e;
}

/**
 * One frame toward `target` (the drawn pad's centre) through `field`; true on the frame it touches down (x is then
 * exactly on the target and the trick is over).
 */
export function stepJumper(J: Jumper, t: number, dt: number, field: (x: number, y: number) => { u: number; v: number }, target: number, b: JumperBounds, descentMs: number, rng: () => number): boolean {
  const k = dt / 16.67;
  const P = J.pilot;
  if (t > P.nextT) {
    P.wander = (rng() * 2 - 1) * WANDER_PX;
    P.nextT = t + 1500 + rng() * 2000;
  }
  const progress = progressOf(J, b);
  const aim = target + P.wander * (1 - progress);
  J.sPhase += J.sRate * dt;
  const carve = Math.sin(J.sPhase) * J.sAmp;
  const fld = field(J.x, J.y);
  let want = fld.u * J.jw + steer(aim, J.x, P.authority) + carve;
  const L = b.x0 + EDGE_INSET;
  const R = b.x1 - EDGE_INSET;
  if (J.x < L) want += (L - J.x) / 90;
  else if (J.x > R) want -= (J.x - R) / 90;
  J.lw += (want - J.lw) * Math.min(1, INERTIA * k);
  J.x = clamp(J.x + J.lw * SIDE_SPEED * k, b.x0 - 60, b.x1 + 60);
  const vy = ((b.groundY - b.skyY) / descentMs) * dt * J.rate * (1 + 0.12 * Math.sin(t / 520 + J.jit));
  J.y += vy - fld.v * 0.6 * (1 - progress) * k + Math.sin(t / 320 + J.jit) * 0.3 * k; // lift where the air converges, sink where it parts — less so near the ground, so the descent always completes
  let spin = 0;
  J.sxk = 1;
  J.spiralOff = 0;
  if (J.trick !== "none" && t >= J.trickAt) {
    J.tp = clamp((t - J.trickAt) / trickMs(J.trick), 0, 1);
    if (J.trick === "spiral") {
      const a = J.tp * 2 * Math.PI * 2;
      const radius = 46 * Math.sin(J.tp * Math.PI);
      J.spiralOff = Math.sin(a) * radius;
      J.sxk = 0.45 + 0.55 * Math.abs(Math.cos(a));
      spin = Math.sin(a) * 0.5;
    } else spin = J.tp * Math.PI * 2;
    if (J.tp >= 1) {
      J.trick = "none";
      J.tp = 0;
      J.spiralOff = 0;
      J.sxk = 1;
    }
  }
  J.sway = J.lw * 0.22 + spin;
  const landed = J.y >= b.groundY;
  J.x = easeOnto(J.x, target, landed ? 1 : progressOf(J, b));
  if (landed) {
    J.trick = "none";
    J.spiralOff = 0;
    J.sxk = 1;
  }
  return landed;
}

/**
 * The jumper. Sheet: `drawSheetJumper` (the shadow's sharpness is the descent's progress from `skyY`). Club-deck: the
 * canopy (six gores, depth-shaded), lines, the pilot's harness disc (a plain ring — no glyph, no text) and the ground
 * shadow sharpening over the last 500 px.
 */
export function drawJumper(ctx: CanvasRenderingContext2D, theme: Theme, J: Jumper, groundY: number, sprites: SpriteSet | null = null, spec: LevelSpec | null = null, skyY: number = groundY - SHADOW_RANGE_PX): void {
  if (sprites !== null && spec !== null) {
    drawSheetJumper(ctx, theme, J, groundY, skyY, sprites, spec);
    return;
  }
  const s = J.canopy;
  const x = J.x + J.spiralOff;
  const h = clamp((groundY - J.y) / 500, 0, 1);
  ctx.fillStyle = `rgba(0,0,0,${(0.35 * (1 - h)).toFixed(2)})`;
  ctx.beginPath();
  ctx.ellipse(x, groundY, (30 + 40 * h) * s, (8 + 10 * h) * s, 0, 0, 7);
  ctx.fill();
  ctx.save();
  ctx.translate(x, J.y);
  ctx.rotate(J.sway);
  ctx.scale(s * J.sxk, s);
  const gores = 6;
  for (let i = 0; i < gores; i++) {
    ctx.beginPath();
    ctx.moveTo(0, -CANOPY_R);
    ctx.arc(0, -CANOPY_R, CANOPY_R, Math.PI + (i / gores) * Math.PI, Math.PI + ((i + 1) / gores) * Math.PI);
    ctx.closePath();
    ctx.fillStyle = theme.canopy[i % 2] ?? theme.accent;
    ctx.fill();
    const lit = Math.sin((Math.PI * (i + 0.5)) / gores); // the outer gores fall away from the light
    ctx.fillStyle = `rgba(0,0,0,${(0.45 * (1 - lit)).toFixed(2)})`;
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,.16)";
  ctx.beginPath();
  ctx.ellipse(-10, -72, 20, 8, -0.35, 0, 7);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath();
  ctx.ellipse(0, -CANOPY_R, CANOPY_R, 6, 0, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-CANOPY_R, -CANOPY_R);
  ctx.lineTo(0, 0);
  ctx.moveTo(CANOPY_R, -CANOPY_R);
  ctx.lineTo(0, 0);
  ctx.moveTo(-16, -60);
  ctx.lineTo(0, 0);
  ctx.moveTo(16, -60);
  ctx.lineTo(0, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 12, 19, 0, 7);
  ctx.fillStyle = "#0e0e1c";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

/** What the landed pose needs: where the boots are and the rig's scale (the jumper's own canopy factor). */
export interface Landed {
  x: number;
  canopy: number;
}

/**
 * The pilot standing on its pad after touchdown, for as long as the banner is up: no canopy, no risers, no sway.
 * Sheet: `pilot-shadow-2` (the sharp one) on the touchdown line and `pilot` with its boots on it. Club-deck: the
 * shadow and the harness disc (a plain ring) — no image, no text.
 */
export function drawLanded(ctx: CanvasRenderingContext2D, theme: Theme, L: Landed, groundY: number, sprites: SpriteSet | null = null, spec: LevelSpec | null = null): void {
  if (sprites !== null && spec !== null) {
    const k = JUMPER_K * L.canopy;
    sprites.draw(ctx, "pilot-shadow-2", spec.spriteScale, L.x, groundY, { k, alpha: 1 });
    sprites.draw(ctx, "pilot", spec.spriteScale, L.x, groundY - PILOT_FEET * k, { k });
    return;
  }
  const s = L.canopy;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(L.x, groundY, 30 * s, 8 * s, 0, 0, 7);
  ctx.fill();
  ctx.save();
  ctx.translate(L.x, groundY);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.arc(0, -19, 19, 0, 7);
  ctx.fillStyle = "#0e0e1c";
  ctx.fill();
  ctx.strokeStyle = theme.canopy[0] ?? theme.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

/** The sheet rig: shadow on the touchdown line, then — about the hands, swung by `sway` — canopy, risers and pilot. */
function drawSheetJumper(ctx: CanvasRenderingContext2D, theme: Theme, J: Jumper, groundY: number, skyY: number, sprites: SpriteSet, spec: LevelSpec): void {
  const s = spec.spriteScale;
  const k = JUMPER_K * J.canopy;
  const x = J.x + J.spiralOff;
  const progress = progressOf(J, { x0: 0, x1: 0, skyY, groundY });
  sprites.draw(ctx, `pilot-shadow-${shadowFrame(progress)}`, s, x, groundY, { k, alpha: SHADOW_ALPHA_MIN + (1 - SHADOW_ALPHA_MIN) * progress });
  ctx.save();
  ctx.translate(x, J.y - PILOT_FEET * k); // the hands: the harness the rig swings about; the boots on J.y
  ctx.rotate(J.sway);
  const rimY = -RISER_DROP * k;
  const c = canopyFrames(J.sxk);
  sprites.draw(ctx, c.a, s, 0, rimY, { colour: theme.canopy[0] ?? theme.accent, k });
  sprites.draw(ctx, c.b, s, 0, rimY, { colour: theme.canopy[1] ?? theme.accent2, k });
  sprites.draw(ctx, c.gloss, s, 0, rimY, { k });
  if (c.xs !== 1) {
    ctx.save();
    ctx.scale(c.xs, 1); // the lines fan to the rim, so they narrow with the side frame in use
    sprites.draw(ctx, "risers", s, 0, rimY, { k });
    ctx.restore();
  } else sprites.draw(ctx, "risers", s, 0, rimY, { k });
  sprites.draw(ctx, "pilot", s, 0, 0, { k });
  ctx.restore();
}

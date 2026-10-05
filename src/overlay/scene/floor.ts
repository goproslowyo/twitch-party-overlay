/**
 * The dancefloor (ported from the prototype's `makeFloor`). Two floors live here behind one
 * `drawFloor`: the procedural club-deck slab (a lit back wall with an LED strip in tier colours, haze, the rounded slab
 * with its perspective grid, and a rim-lit crowd bobbing with the energy — the Active Chatters on its centre bobbers
 * wearing their Avatar Picture and name — the full frame width, under the rack on both sides), and — when a
 * Theme Sheet is present — the Chrome Lounge floor of the 2026-09-05 boards: a perspective grid
 * from the horizon to the bottom edge converging on a vanishing point above the horizon, baked once per resolution AND
 * skin (`floorCacheKey`: the size, the horizon and the Theme colours the bake reads, so a live Theme or floor change re-bakes) into the
 * Scene-owned offscreen cache and blitted every frame, with the `horizon-glow` strip stretched across live. A sheet
 * Theme draws no back wall, no LED strip and no procedural crowd — the Dancers are the room. The smoke (three
 * puffs at mid-floor — the boards' haze ellipses just under the horizon — drifting along the ground wind, tinted from
 * the Theme's haze, Levels 4–5) lives here too, as does the energy envelope. The floor's share of the frame is the
 * streamer's `overlay.floorPercent` (`floorGeometry`'s `floorShare`): the horizon moves with it, and everything drawn
 * for the boards' 440 px floor scales by the depth that leaves (`depthScale` for what the frame's height already
 * scaled — towers, lasers, haze; `floorK` for what it did not — the Dancers, the smoke). It is also the energy envelope's home:
 * idle it is a slow 32-bar sine (the prototype's simulated set had no live source either); a `cue` with an energy value
 * overrides it for `CUE_HOLD_MS`. The prototype's beat pulse had no source in the build and is not simulated: nothing
 * here flashes.
 */
import type { Theme } from "../../config/schema.ts";
import type { Chatter } from "../../server/overlay.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { avatarFor, fnv1a } from "../theme.ts";
import { shortName } from "./dancers.ts"; // one ellipsis rule for both floors
import { glyph, mix, roundRect, clamp } from "./util.ts";

/** 32 bars of 4/4 at 126 bpm — one breath of the idle floor. */
export const IDLE_PERIOD_MS = (32 * 4 * 60000) / 126;
export const CUE_HOLD_MS = 3000;
const IDLE_MID = 0.55;
const IDLE_SWING = 0.3;
const ENERGY_RATE = 0.02;
export const CROWD_SIZE = 46;
export const FLOOR_RADIUS = 22;
const LED_COUNT = 24;

// ---- the club-deck's Chatter Dancers: the roster's heads on the centre bobbers, no sprites
/** A Chatter's bobblehead on a bobber: the generic 9 px head × 1.5. */
export const CLUB_HEAD_R = 13.5;
/** A Hop on the club-deck: one parabola this high over this long, the whole bobber riding it. */
export const CLUB_HOP_MS = 500;
export const CLUB_HOP_PX = 14;
/** A name plate stays this long after a Hop, and shows this long each time its cadence (30–60 s, hashed from the key) comes round. */
export const CLUB_LABEL_MS = 4000;
export const CLUB_LABEL_MIN_MS = 30_000;
const CLUB_LABEL_FONT = "600 11px system-ui, sans-serif";
const CLUB_LABEL_PAD = 8;
const CLUB_LABEL_H = 15;
const CLUB_LABEL_GAP = 4;
const CLUB_LABEL_ABOVE = 10;
const CLUB_RING_W = 1.5;
const CLUB_CENTRE = Math.floor(CROWD_SIZE / 2);
const TAU = Math.PI * 2;

/** The i-th seated Chatter's bobber: the centre one first, then outward both ways (23, 22, 24, 21, 25, …). */
export const clubSeat = (i: number): number => CLUB_CENTRE + (i % 2 === 0 ? i / 2 : -(i + 1) / 2);

/** Who sits on the club-deck: the first CROWD_SIZE of the (newest-first, Level-capped) roster, in arrival order so a message moves nobody. */
export function clubSeating(chatters: readonly Chatter[]): Chatter[] {
  return chatters.slice(0, CROWD_SIZE).sort((a, b) => a.firstSeenMs - b.firstSeenMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** How far a Hop that started at `hopAt` lifts its bobber at `t`: a parabola of CLUB_HOP_PX over CLUB_HOP_MS, 0 outside it. */
export function clubLift(hopAt: number | undefined, t: number): number {
  if (hopAt === undefined) return 0;
  const u = (t - hopAt) / CLUB_HOP_MS;
  if (u <= 0 || u >= 1) return 0;
  return 4 * u * (1 - u) * CLUB_HOP_PX;
}

/** Whether `key`'s name plate shows at `t`: CLUB_LABEL_MS after its Hop, else CLUB_LABEL_MS of every 30–60 s period hashed from the key (phase hashed too, so plates stagger). */
export function labelDue(key: string, hopAt: number | undefined, t: number): boolean {
  if (hopAt !== undefined && t >= hopAt && t - hopAt < CLUB_LABEL_MS) return true;
  const h = fnv1a(key);
  const period = CLUB_LABEL_MIN_MS + (h % CLUB_LABEL_MIN_MS);
  return (t + ((h >>> 8) % period)) % period < CLUB_LABEL_MS;
}

// ---- the Chrome Lounge floor (boards: horizon y = 640 at 1080, vanishing point (900, ~565), gen-round2.mjs :38-53)
/** The boards' horizon as a share of the height: 640 of 1080 — the floor everything below was drawn for; `overlay.floorPercent` moves it. */
export const HORIZON_FRACTION = 640 / 1080;
/** The boards' floor as a share of the height: 440 of 1080. */
export const DESIGN_FLOOR_SHARE = 1 - HORIZON_FRACTION;
/** The boards' floor depth at 1080p, px. */
const DESIGN_FLOOR_DEPTH = 1080 - 640;
const VANISH_X_FRACTION = 0.47;
const VANISH_Y_FRACTION = 0.52;
/** The vanishing point's height above the horizon as a share of the floor's depth (boards: 78.4 over 440). */
const VANISH_ABOVE = (HORIZON_FRACTION - VANISH_Y_FRACTION) / DESIGN_FLOOR_SHARE;
/** The boards' row spacing as fractions of the floor's depth — tight at the horizon, opening toward the edge. */
const ROW_FRACTIONS: readonly number[] = [0, 0.06, 0.14, 0.24, 0.37, 0.53, 0.73, 1];
/** Converging lines meet the bottom edge this far apart at 1920 wide. */
const GRID_STEP_AT_1920 = 190;
const GRID_LINES = 14;
const GRID_LINE_W = 1.2;
/** The far-floor haze: lilac mist rising off the horizon, its depth at 1080 tall. */
const HAZE_DEPTH_AT_1080 = 260;
const HAZE_PEAK = 0.2;
/** The horizon glow's stretch: the strip's end fades land this far off both edges; its 16 px band is drawn this much taller. */
const HORIZON_OVERHANG = 24;
const HORIZON_GLOW_SY = 1.5;
const HORIZON_GLOW_ALPHA = 0.9;
const HORIZON_GLOW_W = 512;
// ---- smoke (boards: haze ellipses at cy 700 / 720 / 660 of 1080 — 60 / 80 / 20 px under the 640 horizon, as shares of the 440 px floor; gen-round2.mjs :63-65)
const SMOKE_PUFFS: ReadonlyArray<{ xf: number; yf: number; k: number; speed: number }> = [
  { xf: 0.18, yf: (700 - 640) / DESIGN_FLOOR_DEPTH, k: 1.35, speed: 0.55 },
  { xf: 0.52, yf: (720 - 640) / DESIGN_FLOOR_DEPTH, k: 1.6, speed: 0.8 },
  { xf: 0.84, yf: (660 - 640) / DESIGN_FLOOR_DEPTH, k: 1.45, speed: 1.1 },
];
/** Steady drift (px / frame at speed 1) plus the ground wind's share; puffs wrap this far off either edge. */
const SMOKE_DRIFT = 0.25;
const SMOKE_WIND = 0.9;
const SMOKE_MARGIN = 600;
const SMOKE_SQUASH = 0.38;
const SMOKE_ALPHA = 0.18;
const SMOKE_BOB_PX = 6;
const SMOKE_BOB_MS = 2400;

export interface EnergyCue {
  value: number;
  untilMs: number;
}

export const idleEnergy = (tMs: number): number => IDLE_MID + IDLE_SWING * Math.sin((tMs / IDLE_PERIOD_MS) * Math.PI * 2);

/** The level the envelope eases toward: the cue's while it holds, the idle curve otherwise. */
export function energyTarget(tMs: number, cue: EnergyCue | null): number {
  return cue !== null && tMs < cue.untilMs ? cue.value : idleEnergy(tMs);
}

export class Energy {
  /** The idle level until the first step (a draw before any step paints a calm floor, never NaN). */
  value = IDLE_MID;
  #stepped = false;
  #cue: EnergyCue | null = null;

  /** A `cue` effect's value, clamped to 0–1; anything that is not a finite number is ignored. */
  cue(value: number | undefined, tMs: number): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this.#cue = { value: clamp(value, 0, 1), untilMs: tMs + CUE_HOLD_MS };
  }

  step(tMs: number, k: number): void {
    const target = energyTarget(tMs, this.#cue);
    this.value = this.#stepped ? this.value + (target - this.value) * Math.min(1, ENERGY_RATE * k) : target; // the first step lands on the curve, no ramp from nothing
    this.#stepped = true;
  }
}

export interface Dancer {
  x: number;
  ph: number;
  h: number;
  arms: boolean;
  w: number;
}

export function createCrowd(rng: () => number): Dancer[] {
  const crowd: Dancer[] = [];
  for (let i = 0; i < CROWD_SIZE; i++) crowd.push({ x: i, ph: rng() * 6.28, h: 24 + rng() * 22, arms: rng() < 0.35, w: 18 + rng() * 8 });
  return crowd;
}

/** How far the crowd's bob phase advances per ms of `dt` at `energy`: faster when the floor is up. */
export const crowdPhaseStep = (dtMs: number, energy: number): number => dtMs / (170 - energy * 50);

export interface FloorGeometry {
  /** The lit floor line: the far edge of the floor. */
  horizonY: number;
  /** Where the grid's lines converge — above the horizon, toward the scene's side of the frame. */
  vanish: { x: number; y: number };
}

/**
 * The floor's depth over the boards' 440 px: what the frame's height used to scale alone (the tower heights, the laser
 * lengths, the haze depth) scales by — the height ratio on the boards' share, less on a shallower floor.
 */
export const depthScale = (horizonY: number, height: number): number => (height - horizonY) / DESIGN_FLOOR_DEPTH;
/** The floor's share over the boards' share — 1 on the boards' floor at any size: what the frame never scaled (the Dancers, the smoke) scales by. */
export const floorK = (horizonY: number, height: number): number => (height - horizonY) / height / DESIGN_FLOOR_SHARE;

/**
 * The Chrome Lounge floor's fixed points for a `width × height` frame with the floor `floorShare` of the height from the
 * bottom (`overlay.floorPercent` / 100; the boards' share by default): the horizon at the top of that share, the
 * vanishing point the boards' distance above it as a share of the depth; the vanishing x mirrors when the rack is on the left.
 */
export function floorGeometry(width: number, height: number, flip: boolean, floorShare = DESIGN_FLOOR_SHARE): FloorGeometry {
  const vx = VANISH_X_FRACTION * width;
  const horizonY = height * (1 - floorShare);
  return { horizonY, vanish: { x: flip ? width - vx : vx, y: horizonY - VANISH_ABOVE * (height - horizonY) } };
}

/** The grid's rows between the horizon and the bottom edge, at the boards' spacing. */
export function floorRows(horizonY: number, height: number): number[] {
  return ROW_FRACTIONS.map((t) => horizonY + t * (height - horizonY));
}

/** The Scene-owned offscreen floor: `drawFloor` re-bakes it only when `key` (the size and the skin's floor colours, `floorCacheKey`) changes. */
export interface FloorCache {
  canvas: HTMLCanvasElement | null;
  width: number;
  height: number;
  key: string;
}

/** What a baked floor depends on: the frame size, the horizon (`overlay.floorPercent`) and the Theme colours `bakeFloor` reads (floor, grid, haze). */
export const floorCacheKey = (theme: Pick<Theme, "floor" | "grid" | "haze">, width: number, height: number, horizonY: number): string => `${width}x${height}@${horizonY}|${theme.floor.join(",")}|${theme.grid}|${theme.haze}`;

export interface FloorFrame {
  x0: number;
  x1: number;
  gy: number;
  t: number;
  energy: number;
  phase: number;
  /** Extra crowd bounce (px) while a celebration runs. */
  bounce?: number;
  /** The frame and the sheet floor's geometry (`floorGeometry`), and the cache the baked grid lives in. */
  width: number;
  height: number;
  horizonY: number;
  vanish: { x: number; y: number };
  cache: FloorCache;
  /** The club-deck's Chatter Dancers: the roster the scene already capped to the Level, newest first. */
  chatters: readonly Chatter[];
  /** `chatters.nameLength` from the skin: how much of a name fits on the plate. */
  nameLength: number;
  /** The decoded Avatar Picture for a URL (null while loading, on failure, or for a null URL: the Avatar Glyph draws instead). */
  chatterImage: (url: string | null) => CanvasImageSource | null;
  /** key → the start `tMs` of that person's latest Hop; the scene forgets one after CLUB_LABEL_MS. */
  hops: ReadonlyMap<string, number>;
}

/**
 * Everything behind the pads. With a sheet: the baked perspective floor and the live horizon glow (no wall, no LEDs,
 * no crowd — the Dancers draw the room). Without: back wall, LED strip, haze, slab + grid, crowd (club-deck, unchanged).
 */
export function drawFloor(ctx: CanvasRenderingContext2D, theme: Theme, crowd: readonly Dancer[], f: FloorFrame, sprites: SpriteSet | null, spec: LevelSpec): void {
  if (sprites !== null) {
    drawSheetFloor(ctx, theme, f, sprites, spec);
    return;
  }
  const { x0, x1, gy, t, energy: e } = f;
  const W = x1 - x0;
  const R = FLOOR_RADIUS;
  const wall = ctx.createLinearGradient(0, gy - 150, 0, gy - 6);
  wall.addColorStop(0, `rgba(${theme.wall},0)`);
  wall.addColorStop(1, `rgba(${theme.wall},${(0.35 + 0.2 * e).toFixed(2)})`);
  ctx.fillStyle = wall;
  roundRect(ctx, x0, gy - 150, W, 150, R);
  ctx.fill();
  const ledPitch = (W - 20) / LED_COUNT;
  const tierCount = Math.max(1, theme.tiers.length);
  for (let i = 0; i < LED_COUNT; i++) {
    ctx.fillStyle = theme.tiers[i % tierCount] ?? theme.accent;
    ctx.globalAlpha = 0.25 + 0.35 * e * (0.6 + 0.4 * Math.sin(t / 1500 + i * 0.8));
    roundRect(ctx, x0 + 10 + i * ledPitch, gy - 128, ledPitch - 8, 5, 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(${theme.haze},${(0.02 + 0.015 * i + 0.02 * e).toFixed(3)})`;
    ctx.fillRect(x0, gy - 110 + i * 30, W, 20 + Math.sin(t / 1400 + i) * 6);
  }
  ctx.fillStyle = theme.floor[1] ?? theme.panel;
  roundRect(ctx, x0, gy - 6, W, 100, R);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x0, gy - 6, W, 100, R);
  ctx.clip();
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const vx = x0 + W / 2;
  for (let i = 0; i <= 12; i++) {
    const bx = x0 + (W * i) / 12;
    ctx.moveTo(vx + (bx - vx) * 0.55, gy - 6);
    ctx.lineTo(bx, gy + 94);
  }
  for (const dy of [8, 30, 58, 92]) {
    ctx.moveTo(x0, gy - 6 + dy);
    ctx.lineTo(x1, gy - 6 + dy);
  }
  ctx.stroke();
  ctx.fillStyle = theme.floorEdge;
  ctx.fillRect(x0, gy + 68, W, 5);
  ctx.restore();
  // the crowd, behind the tiles, rim-lit so silhouettes read on a dark cam. The Active Chatters sit on the
  // centre bobbers, wearing their Avatar Picture as a bobblehead and their name on a plate; a Hop lifts the whole
  // bobber. A bobber nobody sits on draws exactly as it always did (floor.test.ts pins those ops).
  const bounce = 3 + e * 6 + (f.bounce ?? 0);
  const pitch = (W - 20) / CROWD_SIZE;
  const seated: (Chatter | undefined)[] = [];
  clubSeating(f.chatters).forEach((who, i) => (seated[clubSeat(i)] = who));
  const plates: { x: number; y: number; text: string }[] = [];
  ctx.fillStyle = theme.crowd;
  ctx.strokeStyle = theme.rim;
  ctx.lineWidth = 1.2;
  for (let i = 0; i < crowd.length; i++) {
    const c = crowd[i]!;
    const who = seated[i];
    const hopAt = who === undefined ? undefined : f.hops.get(who.key);
    const cx = x0 + 10 + c.x * pitch;
    const b = Math.sin(f.phase + c.ph);
    const cy = gy - 8 + b * bounce - clubLift(hopAt, t);
    ctx.beginPath();
    ctx.arc(cx, cy - c.h, 9, 0, 7);
    ctx.fill();
    ctx.stroke();
    roundRect(ctx, cx - c.w / 2, cy - c.h + 6, c.w, c.h, 8);
    ctx.fill();
    ctx.stroke();
    if (c.arms) {
      const a = Math.abs(b);
      roundRect(ctx, cx - c.w / 2 - 6, cy - c.h - 6 - a * 10, 5, 22, 2.5);
      ctx.fill();
      ctx.stroke();
      roundRect(ctx, cx + c.w / 2 + 1, cy - c.h - 6 - a * 10, 5, 22, 2.5);
      ctx.fill();
      ctx.stroke();
    }
    if (who !== undefined) {
      const hy = cy - c.h;
      drawClubHead(ctx, theme, who, cx, hy, f.chatterImage);
      ctx.fillStyle = theme.crowd; // the head changed the pens: back to the crowd's for the next bobber
      ctx.strokeStyle = theme.rim;
      ctx.lineWidth = 1.2;
      if (labelDue(who.key, hopAt, t)) plates.push({ x: cx, y: hy - CLUB_HEAD_R - CLUB_LABEL_ABOVE, text: shortName(who.name, f.nameLength) });
    }
  }
  drawClubPlates(ctx, theme, plates);
}

/** A seated bobber's head: a crowd-coloured disc, the Avatar Picture through an arc clip (the mote's pattern) or the Avatar Glyph, and a thin ring in the rim tint — never the Mote Ring. */
function drawClubHead(ctx: CanvasRenderingContext2D, theme: Theme, who: Chatter, x: number, y: number, image: (url: string | null) => CanvasImageSource | null): void {
  ctx.fillStyle = theme.crowd;
  ctx.beginPath();
  ctx.arc(x, y, CLUB_HEAD_R, 0, TAU);
  ctx.fill();
  const img = image(who.avatarUrl);
  if (img !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, CLUB_HEAD_R, 0, TAU);
    ctx.clip();
    ctx.drawImage(img, x - CLUB_HEAD_R, y - CLUB_HEAD_R, 2 * CLUB_HEAD_R, 2 * CLUB_HEAD_R);
    ctx.restore();
  } else glyph(ctx, avatarFor(who.name, theme), x, y + 1, Math.round(CLUB_HEAD_R * 1.25));
  ctx.strokeStyle = theme.rim;
  ctx.lineWidth = CLUB_RING_W;
  ctx.beginPath();
  ctx.arc(x, y, CLUB_HEAD_R, 0, TAU);
  ctx.stroke();
}

/** The name plates, left to right: white on the Theme's panel; one that would overlap the plate drawn before it is skipped this frame. */
function drawClubPlates(ctx: CanvasRenderingContext2D, theme: Theme, plates: readonly { x: number; y: number; text: string }[]): void {
  if (plates.length === 0) return;
  ctx.font = CLUB_LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let right = Number.NEGATIVE_INFINITY;
  for (const p of plates) {
    const w = ctx.measureText(p.text).width + CLUB_LABEL_PAD;
    if (p.x - w / 2 < right + CLUB_LABEL_GAP) continue;
    ctx.fillStyle = theme.panel;
    roundRect(ctx, p.x - w / 2, p.y - CLUB_LABEL_H / 2, w, CLUB_LABEL_H, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(p.text, p.x, p.y + 1);
    right = p.x + w / 2;
  }
  ctx.textBaseline = "alphabetic";
}

/** The sheet floor: the cache (baked on a size change, or straight to the frame with no cache canvas) and the live horizon glow. */
function drawSheetFloor(ctx: CanvasRenderingContext2D, theme: Theme, f: FloorFrame, sprites: SpriteSet, spec: LevelSpec): void {
  const { cache } = f;
  if (cache.canvas === null) {
    bakeFloor(ctx, theme, f);
  } else {
    const key = floorCacheKey(theme, f.width, f.height, f.horizonY);
    if (cache.key !== key) {
      cache.canvas.width = f.width;
      cache.canvas.height = f.height;
      const off = cache.canvas.getContext("2d");
      if (off !== null) bakeFloor(off, theme, f);
      cache.width = f.width;
      cache.height = f.height;
      cache.key = key;
    }
    ctx.drawImage(cache.canvas, 0, 0);
  }
  // the lit floor line: the glow strip stretched across the frame (its end fades fall off both edges), additive over
  // the opaque floor below it and the cam above
  ctx.globalCompositeOperation = "lighter";
  ctx.save();
  ctx.translate(-HORIZON_OVERHANG, f.horizonY);
  ctx.scale((f.width + 2 * HORIZON_OVERHANG) / HORIZON_GLOW_W, HORIZON_GLOW_SY);
  sprites.draw(ctx, "horizon-glow", spec.spriteScale, 0, 0, { colour: theme.accent, alpha: HORIZON_GLOW_ALPHA });
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
}

/** The static floor: the depth gradient from the horizon down, the converging lines, the rows, the far-floor haze. */
function bakeFloor(ctx: CanvasRenderingContext2D, theme: Theme, f: FloorFrame): void {
  const { width: W, height: H, horizonY: hz, vanish: v } = f;
  const depth = H - hz;
  const near = theme.floor[0] ?? theme.panel;
  const far = theme.floor[1] ?? theme.panel;
  const ground = ctx.createLinearGradient(0, hz, 0, H);
  ground.addColorStop(0, near);
  ground.addColorStop(0.55, mix(near, far, 0.6));
  ground.addColorStop(1, far);
  ctx.fillStyle = ground;
  ctx.fillRect(0, hz, W, depth);
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = GRID_LINE_W;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  const step = GRID_STEP_AT_1920 * (W / 1920);
  const shrink = (hz - v.y) / (H - v.y); // how much closer to the vanishing x a line sits at the horizon than at the edge
  for (let i = -GRID_LINES; i <= GRID_LINES; i++) {
    const xb = v.x + i * step;
    ctx.moveTo(v.x + (xb - v.x) * shrink, hz);
    ctx.lineTo(xb, H);
  }
  ctx.stroke();
  for (const y of floorRows(hz, H)) {
    const t = (y - hz) / depth;
    ctx.globalAlpha = 0.65 + 0.7 * t;
    ctx.lineWidth = 1 + 1.4 * t;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const hazeH = HAZE_DEPTH_AT_1080 * depthScale(hz, H);
  const haze = ctx.createLinearGradient(0, hz, 0, hz + hazeH);
  haze.addColorStop(0, `rgba(${theme.haze},0.04)`);
  haze.addColorStop(0.45, `rgba(${theme.haze},${HAZE_PEAK})`);
  haze.addColorStop(1, `rgba(${theme.haze},0)`);
  ctx.fillStyle = haze;
  ctx.fillRect(0, hz, W, hazeH);
}

export interface SmokePuff {
  frame: number;
  x: number;
  /** The puff's line across the floor as a share of the floor's depth under the horizon (mid-floor). */
  yf: number;
  k: number;
  /** The parallax: the nearer puff drifts faster. */
  speed: number;
}

/** Three puffs across a `width` frame, the nearest fastest; fixed starts, no dice. */
export function createSmoke(width = 1920): SmokePuff[] {
  return SMOKE_PUFFS.map((p, i) => ({ frame: i, x: p.xf * width, yf: p.yf, k: p.k, speed: p.speed }));
}

/** Drift the puffs along the ground wind (`windX` px / frame at the pad row) one frame (`k` = dt / 16.67), wrapping round the frame. */
export function stepSmoke(puffs: SmokePuff[], windX: number, k: number, width: number): void {
  const span = width + 2 * SMOKE_MARGIN;
  for (const p of puffs) {
    p.x += (SMOKE_DRIFT + SMOKE_WIND * windX) * p.speed * k;
    while (p.x > width + SMOKE_MARGIN) p.x -= span;
    while (p.x < -SMOKE_MARGIN) p.x += span;
  }
}

/** The mid-floor haze: the three `smoke-{i}` puffs on their lines under the horizon (sized by the floor's share, `floorK`), flattened, tinted the Theme's haze, additive — Levels with `spec.smoke` only. */
export function drawSmoke(ctx: CanvasRenderingContext2D, theme: Theme, puffs: readonly SmokePuff[], f: FloorFrame, sprites: SpriteSet | null, spec: LevelSpec): void {
  if (sprites === null || !spec.smoke) return;
  const colour = `rgb(${theme.haze})`;
  const depth = f.height - f.horizonY;
  const k = floorK(f.horizonY, f.height);
  ctx.globalCompositeOperation = "lighter";
  for (const p of puffs) {
    ctx.save();
    ctx.translate(p.x, f.horizonY + p.yf * depth + Math.sin(f.t / SMOKE_BOB_MS + p.frame * 2.1) * SMOKE_BOB_PX);
    ctx.scale(1, SMOKE_SQUASH);
    sprites.draw(ctx, `smoke-${p.frame}`, spec.spriteScale, 0, 0, { colour, k: p.k * k, alpha: SMOKE_ALPHA });
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The club-deck's backstage mystery tile beside the pads: lock, tier, hidden count, and the countdown in gold — never a
 * name. A sheet Theme has no tile: its lock pads are part of the strip (pads.ts `lockPads` / `drawLockLabel`).
 */
export function drawLockTile(ctx: CanvasRenderingContext2D, theme: Theme, tile: { x: number; w: number }, gy: number, th: number, tierColor: string, lines: readonly string[], sub: string): void {
  const cx = tile.x + tile.w / 2;
  const subY = gy + 72;
  ctx.fillStyle = theme.lockTile;
  roundRect(ctx, tile.x, gy + 8, tile.w, th - 4, 8);
  ctx.fill();
  ctx.strokeStyle = tierColor;
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = "800 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let y = gy + 21;
  for (const line of lines) {
    if (line === lines[0]) {
      ctx.font = "15px serif";
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(line, cx, y);
      ctx.textBaseline = "alphabetic";
      ctx.font = "800 10px ui-monospace, monospace";
      y += 17;
      continue;
    }
    ctx.fillStyle = tierColor;
    ctx.fillText(line, cx, y);
    y += 11;
  }
  ctx.fillStyle = theme.gold;
  ctx.fillText(sub, cx, subY);
}

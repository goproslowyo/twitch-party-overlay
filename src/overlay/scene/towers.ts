/**
 * The six spotlight towers (ported from the tower/beam code inside the prototype's
 * `makeParty.step`): three a side, one per tier, tallest OUTSIDE, lit as its tier opens. Each beam aims at its own
 * wandering point on the floor — re-picked every 1.5–4.7 s from three ranges (own side 12–30 %, mid-floor 30–75 %, a
 * full sweep to the far end 75–100 %), eased at its own rate with its own slow wobble and its own brightness walk —
 * so no two are ever in sync. Club-deck: a wide cone plus a bright core from the lamp, lit all the way to the floor.
 * Chrome Lounge (a Theme Sheet present): the towers stand ACROSS the room on the horizon — 4.5 / 13.5 / 22.5 % of
 * the scene's width in from each edge, 210 / 150 / 100 px tall at 1080p scaled by the height (`sheetTowerX`,
 * `towerHeightAtHorizon`; the club-deck keeps its 44 px cluster) — with a `tower-head` lamp; every lit tower hangs a
 * sweep from a rig ABOVE the frame — the `beam-wedge` + `beam-core` with its apex off the top edge at the fixture's x,
 * leaning across the floor to where the aim walk lands, widening and dimming down to a `beam-pool` on the floor (never
 * a floor-apex wedge); laser fans of five strokes 300–1140 px long leave the lit heads, each on a `laser-halo`.
 */
import type { Theme } from "../../config/schema.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { HORIZON_FRACTION, depthScale } from "./floor.ts";
import { clamp, mix, rgba, roundRect } from "./util.ts";

export const TOWER_W = 26;
export const TOWER_GAP = 44;
const TOWER_BASE_H = 270;
const TOWER_STEP_H = 60;
const LIT_RATE = 0.04;
const BR_RATE = 0.02;
const AIM_MIN_MS = 1500;
const AIM_SPAN_MS = 3200;
// ---- the sheet's towers and lights
/** Each side's three towers stand at these shares of the scene's width in from that edge, tallest outside. */
const SHEET_TOWER_FRACTIONS: readonly number[] = [0.045, 0.135, 0.225];
/** Their heights on the boards' 440 px floor at 1080p (210 / 150 / 100), scaled by the floor's depth (`depthScale`: the height alone on the boards' share). */
const SHEET_TOWER_H_AT_1080: readonly number[] = [210, 150, 100];
/** The tower's foot below the horizon line. */
export const TOWER_FOOT = 8;
/** The club-deck's towers stand this far under the ground line (their body reaches `gy + CLUB_TOWER_FOOT`). */
export const CLUB_TOWER_FOOT = 40;
/** The lit cap on a club-deck tower, this tall, on top of the body. */
export const CLUB_TOWER_CAP = 12;
const HEAD_K = 0.7;
/** The lamp's centre above the tower top, at HEAD_K (the head sprite's lamp is 30 tall). */
const HEAD_CENTRE_UP = 15 * HEAD_K;
/** The rig: every sweep's apex sits this far above the top edge. */
export const SWEEP_APEX_Y = -40;
/** The beam frames are 640 tall, the wedge 260 wide (scripts/sprites/draw.ts). */
const BEAM_FRAME_H = 640;
const BEAM_HALF_W = 130;
/** The fixture's aperture — the wedge's painted apex is a point; the placement reports this half-width at the rig. */
const APEX_HALF_W = 6;
const POOL_K = 0.75;
const POOL_PLATE_K = 2.2;
const WEDGE_ALPHA = 0.85;
const CORE_ALPHA = 0.7;
const POOL_ALPHA = 0.7;
const POOL_PLATE_ALPHA = 0.7;
const LASER_COUNT = 5;
/** The fan: the first stroke this far from vertical (radians, toward the centre), each next one this much further. */
const LASER_BASE = 0.52;
const LASER_STEP = 0.19;
const LASER_SWAY = 0.16;
const LASER_SWAY_MS = 1500;
/** The fan's strokes at 1080p — the first 300 px long, each next one 210 px longer (300 … 1140), scaled by the height. */
const LASER_LEN_MIN = 300;
const LASER_LEN_STEP = 210;
const LASER_HALO_W = 512;
/** Idle fans are quiet; a celebration (`level` 0–1) brings them up. */
const LASER_IDLE = 0.22;
const LASER_CEL = 0.5;
const LASER_STROKE_ALPHA = 0.8;
const LASER_HALO_ALPHA = 0.28;

export interface Tower {
  sideI: 0 | 1;
  tier: number;
  /** Which way this side's beams cross: +1 aims rightwards. */
  dirC: 1 | -1;
  height: number;
  aim: number;
  aimTarget: number;
  aimT: number;
  rate: number;
  wobP: number;
  wobPh: number;
  flick: number;
  br: number;
  brTarget: number;
  lit: number;
}

export function createTowers(rng: () => number): Tower[] {
  const towers: Tower[] = [];
  for (const sideI of [0, 1] as const) {
    for (let i = 0; i <= 2; i++) {
      towers.push({ sideI, tier: i, dirC: sideI === 0 ? 1 : -1, height: TOWER_BASE_H - i * TOWER_STEP_H, aim: 0.45 + rng() * 0.3, aimTarget: 0.55, aimT: 0, rate: 0.012 + rng() * 0.022, wobP: 2200 + rng() * 3000, wobPh: rng() * 6.28, flick: rng() * 6.28, br: 0.7, brTarget: 0.7, lit: 0 });
    }
  }
  return towers;
}

/** The lamp's x: side 0 counts in from the scene's left edge, side 1 from its right. */
export function towerX(T: Tower, sceneL: number, sceneR: number): number {
  return T.sideI === 0 ? sceneL + T.tier * TOWER_GAP : sceneR - TOWER_W - T.tier * TOWER_GAP;
}

/** The sheet's tower x (its left edge, `TOWER_W` wide) — centred at the tier's share of the scene width in from its side's edge. */
export function sheetTowerX(T: Tower, f: Pick<TowerFrame, "sceneL" | "sceneR">): number {
  const inset = (SHEET_TOWER_FRACTIONS[T.tier] ?? SHEET_TOWER_FRACTIONS[SHEET_TOWER_FRACTIONS.length - 1]!) * (f.sceneR - f.sceneL);
  return (T.sideI === 0 ? f.sceneL + inset : f.sceneR - inset) - TOWER_W / 2;
}

/** The tower's height when it stands on the horizon (the sheet): 210 / 150 / 100 on the boards' floor at 1080p, scaled by the floor's depth under `horizonY` (the boards' horizon when not given: the height alone). */
export const towerHeightAtHorizon = (T: Tower, height: number, horizonY = HORIZON_FRACTION * height): number => (SHEET_TOWER_H_AT_1080[T.tier] ?? SHEET_TOWER_H_AT_1080[SHEET_TOWER_H_AT_1080.length - 1]!) * depthScale(horizonY, height);

/** A new aim as a fraction of the floor's width, from two draws: which range, then where inside it. */
export function pickAim(r: number, r2: number): number {
  return r < 0.22 ? 0.12 + r2 * 0.18 : r < 0.75 ? 0.3 + r2 * 0.45 : 0.75 + r2 * 0.25;
}

/** Advance lit / aim / brightness one frame (`k` = dt / 16.67); `tier` is the highest open tier. */
export function stepTowers(towers: Tower[], t: number, k: number, tier: number, rng: () => number): void {
  for (const T of towers) {
    T.lit += ((T.tier <= tier ? 1 : 0) - T.lit) * Math.min(1, LIT_RATE * k);
    if (T.lit < 0.001) T.lit = 0;
    if (T.lit <= 0.02) continue;
    if (t >= T.aimT) {
      T.aimTarget = pickAim(rng(), rng());
      T.brTarget = 0.35 + rng() * 0.65;
      T.aimT = t + AIM_MIN_MS + rng() * AIM_SPAN_MS;
    }
    T.aim += (T.aimTarget - T.aim) * Math.min(1, T.rate * k);
    T.br += (T.brTarget - T.br) * Math.min(1, BR_RATE * k);
  }
}

/** Where the beam lands: `reach` along the floor from the lamp at `sx`, wobbled, clamped 8–100 % and to the scene's inner edges. */
export function beamAim(T: Tower, t: number, floorW: number, sx: number, sceneR: number, sceneL: number): number {
  const reach = floorW * clamp(T.aim + 0.04 * Math.sin(t / T.wobP + T.wobPh), 0.08, 1);
  return clamp(sx + T.dirC * reach, sceneL + 20, sceneR - 20);
}

export interface TowerFrame {
  t: number;
  gy: number;
  sceneL: number;
  sceneR: number;
  /** The lit floor line the sheet's towers stand on. */
  horizonY: number;
  /** The frame's height: the sheet's tower heights and laser lengths scale with it. */
  height: number;
}

export interface SweepPlacement {
  /** The fixture on the rig, above the top edge at the tower's x. */
  apex: { x: number; y: number };
  /** Where the light lands on the floor (`beamAim`). */
  base: { x: number; y: number };
  /** Canvas rotation of the hanging wedge about its apex (negative leans it rightwards). */
  angle: number;
  /** Draw scale: the beam's length over the 640 px frame. */
  k: number;
  apexHalfWidth: number;
  baseHalfWidth: number;
}

/** The sweep's geometry: apex at the fixture above the frame, base on the floor where the aim walk points, wider there. */
export function sweepPlacement(T: Tower, f: TowerFrame): SweepPlacement {
  const fx = sheetTowerX(T, f) + TOWER_W / 2;
  const bx = beamAim(T, f.t, f.sceneR - f.sceneL, fx, f.sceneR, f.sceneL);
  const dx = bx - fx;
  const dy = f.gy - SWEEP_APEX_Y;
  const k = Math.hypot(dx, dy) / BEAM_FRAME_H;
  return { apex: { x: fx, y: SWEEP_APEX_Y }, base: { x: bx, y: f.gy }, angle: -Math.atan2(dx, dy), k, apexHalfWidth: APEX_HALF_W, baseHalfWidth: BEAM_HALF_W * k };
}

/** The tint of a tower's light: its tier's colour, or the Theme's pastels in turn for a tower past the tiers. */
export function towerColour(theme: Theme, T: Tower, i: number): string {
  const pastels = [theme.accent, theme.accent2, theme.tiers[1] ?? theme.accent];
  return theme.tiers[T.tier] ?? pastels[i % pastels.length]!;
}

/** The tower bodies with their tier lamp — club-deck behind the crowd; on the sheet standing on the horizon with the `tower-head` sprite. */
export function drawTowerBodies(ctx: CanvasRenderingContext2D, theme: Theme, towers: readonly Tower[], f: TowerFrame, sprites: SpriteSet | null, spec: LevelSpec): void {
  if (sprites !== null) {
    const foot = f.horizonY + TOWER_FOOT;
    towers.forEach((T, i) => {
      const tx = sheetTowerX(T, f);
      const h = towerHeightAtHorizon(T, f.height, f.horizonY);
      const top = foot - h;
      const body = ctx.createLinearGradient(0, top, 0, foot);
      body.addColorStop(0, mix(theme.tower, "#ffffff", 0.12));
      body.addColorStop(1, theme.tower);
      ctx.fillStyle = body;
      roundRect(ctx, tx, top, TOWER_W, h + TOWER_FOOT, 3);
      ctx.fill();
      ctx.strokeStyle = `rgba(${theme.haze},0.35)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      const cx = tx + TOWER_W / 2;
      sprites.draw(ctx, "tower-head-dark", spec.spriteScale, cx, top, { k: HEAD_K });
      if (T.lit > 0.02) sprites.draw(ctx, "tower-head", spec.spriteScale, cx, top, { colour: towerColour(theme, T, i), k: HEAD_K, alpha: T.lit });
    });
    return;
  }
  for (const T of towers) {
    const tx = towerX(T, f.sceneL, f.sceneR);
    ctx.fillStyle = theme.tower;
    roundRect(ctx, tx, clubTowerBodyTop(T, f.gy), TOWER_W, T.height, 5);
    ctx.fill();
    ctx.fillStyle = T.lit > 0.5 ? (theme.tiers[T.tier] ?? theme.accent) : "rgba(255,255,255,.12)";
    ctx.globalAlpha = 0.7;
    roundRect(ctx, tx + 4, clubTowerTop(T, f.gy), TOWER_W - 8, CLUB_TOWER_CAP, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** The sheet's tier captions under the lamps (staggered so neighbours never overlap). */
function drawCaptions(ctx: CanvasRenderingContext2D, theme: Theme, towers: readonly Tower[], captions: readonly string[], f: TowerFrame, y: number): void {
  ctx.font = "800 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const T of towers) {
    ctx.fillStyle = T.lit > 0.5 ? (theme.tiers[T.tier] ?? theme.accent) : "rgba(255,255,255,.4)";
    ctx.fillText(captions[T.tier] ?? "", sheetTowerX(T, f) + TOWER_W / 2, y + (T.tier % 2) * 14);
  }
}

/**
 * The beams and the tier captions. Club-deck: a wide cone + bright core from the lamp, bright there and still visible
 * where it lands. Sheet: for every lit tower a plate under the landing pool, then — additive — the wedge and core hung
 * from the rig, and the pool where they land; nothing when the Level has no sweeps.
 */
export function drawBeams(ctx: CanvasRenderingContext2D, theme: Theme, towers: readonly Tower[], captions: readonly string[], f: TowerFrame, sprites: SpriteSet | null, spec: LevelSpec): void {
  if (sprites !== null) {
    if (spec.sweeps) {
      const s = spec.spriteScale;
      const lit = towers.map((T, i) => ({ T, i })).filter(({ T }) => T.lit > 0.02);
      const placed = lit.map(({ T, i }) => ({ T, colour: towerColour(theme, T, i), p: sweepPlacement(T, f), a: T.lit * (0.55 + 0.45 * T.br) * (0.88 + 0.12 * Math.sin(f.t / 700 + T.flick)) }));
      for (const { T, p } of placed) sprites.draw(ctx, "plate", s, p.base.x, p.base.y, { k: POOL_PLATE_K, alpha: POOL_PLATE_ALPHA * T.lit });
      ctx.globalCompositeOperation = "lighter";
      for (const { colour, p, a } of placed) {
        sprites.draw(ctx, "beam-wedge", s, p.apex.x, p.apex.y, { colour, k: p.k * spec.sweepScale, alpha: WEDGE_ALPHA * a, rotate: p.angle });
        sprites.draw(ctx, "beam-core", s, p.apex.x, p.apex.y, { colour, k: p.k * spec.sweepScale, alpha: CORE_ALPHA * a, rotate: p.angle });
        sprites.draw(ctx, "beam-pool", s, p.base.x, p.base.y, { colour, k: POOL_K, alpha: POOL_ALPHA * a });
      }
      ctx.globalCompositeOperation = "source-over";
    }
    drawCaptions(ctx, theme, towers, captions, f, f.horizonY + TOWER_FOOT + 14);
    return;
  }
  const floorW = f.sceneR - f.sceneL;
  for (const T of towers) {
    const col = theme.tiers[T.tier] ?? theme.accent;
    const sx = towerX(T, f.sceneL, f.sceneR) + TOWER_W / 2;
    const sy = clubTowerBodyTop(T, f.gy);
    if (T.lit > 0.02) {
      const ex = beamAim(T, f.t, floorW, sx, f.sceneR, f.sceneL);
      const reach = Math.abs(ex - sx);
      const wide = 110 + reach * 0.16;
      const core = 34 + reach * 0.05;
      const fl = T.br * (0.88 + 0.12 * Math.sin(f.t / 700 + T.flick));
      const grad = ctx.createLinearGradient(sx, sy, ex, f.gy);
      grad.addColorStop(0, rgba(col, 0.9));
      grad.addColorStop(0.6, rgba(col, 0.45));
      grad.addColorStop(1, rgba(col, 0.12));
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.3 * T.lit * fl;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex + wide, f.gy + 4);
      ctx.lineTo(ex - wide, f.gy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.5 * T.lit * fl;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex + core, f.gy + 4);
      ctx.lineTo(ex - core, f.gy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.font = "800 10px ui-monospace, monospace";
    ctx.fillStyle = T.lit > 0.5 ? col : "rgba(255,255,255,.4)";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(captions[T.tier] ?? "", sx, f.gy + 62 + (T.tier % 2) * 14);
  }
}

export interface LaserStroke {
  /** Unit direction of the stroke (canvas y down) and its length in pixels. */
  dx: number;
  dy: number;
  len: number;
  colour: string;
}

/** One lit head's fan on the sheet: where it leaves (`cx`, `hy`), its five strokes, and the strokes' share of alpha. */
export interface LaserFan {
  T: Tower;
  cx: number;
  hy: number;
  /** The idle floor plus the celebration's share, times the tower's `lit` — what every stroke and halo alpha scales by. */
  alpha: number;
  strokes: LaserStroke[];
}

/** Club-deck: the top of a tower's body — the beam's origin (`gy` is the ground line). */
export const clubTowerBodyTop = (T: Pick<Tower, "height">, gy: number): number => gy + CLUB_TOWER_FOOT - T.height;
/** Club-deck: the very top of a tower, its cap included — the firework band (scene.ts) stays above the tallest of these. */
export const clubTowerTop = (T: Pick<Tower, "height">, gy: number): number => clubTowerBodyTop(T, gy) - CLUB_TOWER_CAP;

/** The lamp's centre on the sheet: the head sprite's lamp over the tower's top (where the laser fan leaves). */
export function towerHead(T: Tower, f: Pick<TowerFrame, "sceneL" | "sceneR" | "horizonY" | "height">): { x: number; y: number } {
  return { x: sheetTowerX(T, f) + TOWER_W / 2, y: f.horizonY + TOWER_FOOT - towerHeightAtHorizon(T, f.height, f.horizonY) - HEAD_CENTRE_UP };
}

/**
 * The sheet's laser fans at celebration `level` (0–1): for every lit head, five strokes up and across toward the
 * centre on a slow sway, 300–1140 px on the boards' floor at 1080p scaled by the floor's depth, alternating the tower's tint and the accent. Pure
 * geometry — `drawLasers` strokes exactly these, and the light layer's bloom wraps the same ends.
 */
export function laserFans(theme: Theme, towers: readonly Tower[], level: number, f: TowerFrame): LaserFan[] {
  const a = LASER_IDLE + LASER_CEL * clamp(level, 0, 1);
  const scale = depthScale(f.horizonY, f.height);
  return towers
    .map((T, i) => ({ T, i }))
    .filter(({ T }) => T.lit > 0.02)
    .map(({ T, i }) => {
      const { x: cx, y: hy } = towerHead(T, f);
      const sway = LASER_SWAY * Math.sin(f.t / LASER_SWAY_MS + T.wobPh);
      const strokes: LaserStroke[] = [];
      for (let j = 0; j < LASER_COUNT; j++) {
        const ang = T.dirC * (LASER_BASE + j * LASER_STEP + sway); // from vertical, toward the centre
        strokes.push({ dx: Math.sin(ang), dy: -Math.cos(ang), len: (LASER_LEN_MIN + j * LASER_LEN_STEP) * scale, colour: j % 2 ? theme.accent : towerColour(theme, T, i) });
      }
      return { T, cx, hy, alpha: a * T.lit, strokes };
    });
}

/**
 * The lasers. Club-deck: at the top of the celebration curve, two sweeping lines from every lit lamp, at `level` (0–1).
 * Sheet (Levels with `spec.lasers`): the `laserFans` — a fan of five strokes from every lit head, up and across toward
 * the centre on a slow sway, each on a `laser-halo` stretched along it (additive) — quiet idle, brighter through a celebration.
 */
export function drawLasers(ctx: CanvasRenderingContext2D, theme: Theme, towers: readonly Tower[], level: number, f: TowerFrame, sprites: SpriteSet | null, spec: LevelSpec): void {
  if (sprites !== null) {
    if (!spec.lasers) return;
    const s = spec.spriteScale;
    const fans = laserFans(theme, towers, level, f);
    ctx.globalCompositeOperation = "lighter";
    for (const { cx, hy, alpha, strokes } of fans) {
      for (const st of strokes) {
        ctx.save();
        ctx.translate(cx, hy);
        ctx.rotate(Math.atan2(st.dy, st.dx));
        ctx.scale(st.len / LASER_HALO_W, 1);
        sprites.draw(ctx, "laser-halo", s, 0, 0, { colour: st.colour, alpha: LASER_HALO_ALPHA * alpha });
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1.2;
    for (const { cx, hy, alpha, strokes } of fans) {
      ctx.globalAlpha = LASER_STROKE_ALPHA * alpha;
      for (const st of strokes) {
        ctx.strokeStyle = st.colour;
        ctx.beginPath();
        ctx.moveTo(cx, hy);
        ctx.lineTo(cx + st.dx * st.len, hy + st.dy * st.len);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (level <= 0.02) return;
  ctx.lineWidth = 2;
  ctx.globalAlpha = level * 0.5;
  for (const T of towers) {
    if (T.lit <= 0.5) continue;
    const sx = towerX(T, f.sceneL, f.sceneR) + TOWER_W / 2;
    const sy = clubTowerBodyTop(T, f.gy);
    for (let j = 0; j < 2; j++) {
      const a = Math.sin(f.t / 900 + T.tier + j * 2.1) * 0.7;
      ctx.strokeStyle = j % 2 ? theme.accent : (theme.tiers[T.tier] ?? theme.accent);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.sin(a) * 1600, sy - Math.cos(a) * 1600);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

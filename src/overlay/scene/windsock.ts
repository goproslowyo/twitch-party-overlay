/**
 * The windsock (ported from the prototype's `drawWindsock`): a striped cone on a pole that points downwind, stretches
 * with the wind's strength and droops when calm. The wind arrives as a vector from the scene's `wind` hook — a
 * constant 0 until the wind field is wired — and only its sideways component moves the sock. With a Theme Sheet
 * it is two frames tinted the Theme's accent: `windsock-pole` (pole, cap and the cap's glow; Anchor at the foot)
 * drawn upright, then `windsock-cone` (the cone alone, baked horizontal with its Anchor at the mouth) drawn at the cap
 * rotated by the sock angle itself — flipped for a westerly. No clip, no repaint: the sprite's own `rotate` is the whole story.
 */
import type { Theme } from "../../config/schema.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";

const FULL_WIND = 2.2;
/** The club-deck pole's height under its top. */
export const POLE_H = 160;
const LEN_MIN = 34;
const LEN_SPAN = 46;
const DROOP_CALM = 0.95;
const BAND_R0 = 11;
const BAND_R1 = 4;
// ---- the sheet's sock: scripts/sprites/draw.ts `windsock-pole` (Anchor at the foot) + `windsock-cone` (Anchor at the mouth)
/** The sprites' world scale: the 166 px pole beside the 210 px outer tower. */
export const WINDSOCK_K = 1;
/** The pole frame's cap centre stands this far above its Anchor, the foot (draw.ts WINDSOCK_POLE_PX; windsock.test.ts pins it to the atlas). */
const SOCK_POLE_PX = 166;

export interface SockShape {
  dir: 1 | -1;
  /** 0 calm … 1 at FULL_WIND. */
  strength: number;
  len: number;
  /** Rotation from horizontal, downwind: near 0 stretched out, DROOP_CALM hanging. */
  angle: number;
}

export function sockShape(wind: { x: number; y: number }, t: number): SockShape {
  const strength = Math.min(1, Math.abs(wind.x) / FULL_WIND);
  const dir: 1 | -1 = wind.x >= 0 ? 1 : -1;
  const len = LEN_MIN + LEN_SPAN * strength;
  const droop = (1 - strength) * DROOP_CALM + Math.sin(t / 500) * 0.06 * (1 - strength * 0.5);
  const flutter = Math.sin(t / 160) * 0.08 * strength;
  return { dir, strength, len, angle: droop + flutter };
}

/** The pole top for a sheet sock whose foot stands at `footY`. */
export const sheetSockTop = (footY: number): number => footY - SOCK_POLE_PX * WINDSOCK_K;

/** The windsock with its pole top at (`wx`, `wy`): the sheet's tinted frame when a Theme Sheet is present, else the striped cone. */
export function drawWindsock(ctx: CanvasRenderingContext2D, theme: Theme, wx: number, wy: number, wind: { x: number; y: number }, t: number, sprites: SpriteSet | null = null, spec: LevelSpec | null = null): void {
  if (sprites !== null && spec !== null) {
    drawSheetWindsock(ctx, theme, wx, wy, wind, t, sprites, spec);
    return;
  }
  const s = sockShape(wind, t);
  ctx.fillStyle = theme.tower;
  ctx.fillRect(wx - 3, wy, 6, POLE_H);
  ctx.fillStyle = "rgba(255,255,255,.6)";
  ctx.beginPath();
  ctx.arc(wx, wy, 5, 0, 7);
  ctx.fill();
  ctx.save();
  ctx.translate(wx, wy + 4);
  ctx.rotate(s.dir * s.angle);
  for (let i = 0; i < 4; i++) {
    const a = i / 4;
    const b = (i + 1) / 4;
    const ya = BAND_R0 + (BAND_R1 - BAND_R0) * a;
    const yb = BAND_R0 + (BAND_R1 - BAND_R0) * b;
    ctx.fillStyle = i % 2 ? "#f2f2f2" : "#ff7a1a";
    ctx.beginPath();
    ctx.moveTo(s.dir * s.len * a, -ya);
    ctx.lineTo(s.dir * s.len * b, -yb);
    ctx.lineTo(s.dir * s.len * b, yb);
    ctx.lineTo(s.dir * s.len * a, ya);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -BAND_R0);
  ctx.lineTo(s.dir * s.len, -BAND_R1);
  ctx.lineTo(s.dir * s.len, BAND_R1);
  ctx.lineTo(0, BAND_R0);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawSheetWindsock(ctx: CanvasRenderingContext2D, theme: Theme, wx: number, wy: number, wind: { x: number; y: number }, t: number, sprites: SpriteSet, spec: LevelSpec): void {
  const s = sockShape(wind, t);
  const k = WINDSOCK_K;
  const colour = theme.accent;
  sprites.draw(ctx, "windsock-pole", spec.spriteScale, wx, wy + SOCK_POLE_PX * k, { colour, k }); // Anchor = the foot, a pole's length under the top; never rotated
  sprites.draw(ctx, "windsock-cone", spec.spriteScale, wx, wy, { colour, k, rotate: s.dir * s.angle, flipX: s.dir < 0 }); // Anchor = the mouth, at the cap: the sock angle downwind
}

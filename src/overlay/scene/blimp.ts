/**
 * The blimp (ported from the prototype's `makePatrol`, `drawBlimp` and `drawSign`): it
 * patrols the free top strip nose-first with a visible turn at each end and a gentle bob; the envelope's livery
 * alternates the channel name and the CTA every `brandAlternateMs` (`brand` pins it); the gondola's seven windows light
 * up one per banked Unlock from the nose backwards (`min(queue, 7)` lit), each lit seat holding a generic Passenger
 * (theme glyphs rotating one seat every 9 s — never anyone in particular: Unlocks are communal) and the rest dim
 * glass with no glyph; the `×N` badge on the nose alone carries the READY count past seven, and — club-deck only — the
 * `$X of $Y` sign hangs under the gondola. The pure parts (`createPatrol`, `passengers`, `brandFace`) know nothing about a canvas.
 * With a Theme Sheet the airship is the sheet's frames composed at the offsets `scripts/sprites/draw.ts` exports as
 * `SHIP_OFFSETS` (`SHEET_SHIP` here, asserted equal): `fins` behind (the ship's hue darkened a quarter) → `ship-body` →
 * `ship-stripe` → `ship-gloss` → `propeller-{n}` on the shaft past the fins' root, one frame per 40 ms (Level 1 shows
 * only 0 and 2 — 20 fps cannot show four) → seven `gondola-window` (lit ones at full alpha with a Passenger glyph, the
 * rest at WINDOW_DIM_ALPHA and empty) → `ship-light` pulsing by alpha at 1 Hz → `ready-badge` in gold (`ready-badge-dim` with nothing queued) with the `×N`; the livery stays text.
 * The sheet airship hangs no sign and wears no EXIT tag: a Celebration never prints a dollar figure, and neither does it.
 */
import type { Theme } from "../../config/schema.ts";
import { EXIT, compactCount, faderOf, money, nextUnlockLabel } from "../copy.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { clamp, glyph, mix, roundRect } from "./util.ts";

export const CRUISE_PX_PER_FRAME = 0.55;
/** The share of the remaining turn taken per frame — about a second nose-to-nose. */
export const TURN_RATE = 0.045;
export const PATROL_Y = 120;
export const DOOR_X = 126;
export const DOOR_DROP_Y = 100;
const MIN_FORESHORTEN = 0.12;
export const SEATS = 7;
/** The Passengers shift one window along every 9 s of the loop's clock. */
export const PASSENGER_ROTATE_MS = 9000;
/** A Theme with no avatars still seats a glyph in every lit window on the sheet. */
export const PASSENGER_FALLBACK = "✦";
/** An unlit window's glass: the same window at this alpha, no Passenger (no dim frame on the sheet — nothing re-baked). */
export const WINDOW_DIM_ALPHA = 0.35;

/**
 * How many windows are lit for a READY count: one per banked Unlock, capped at the seven seats — the `×N` badge
 * alone counts past that. A step on the queue, no fade: the queue moves on bank / fire events, never per frame.
 */
export function litWindows(queue: number): number {
  return clamp(Math.floor(queue), 0, SEATS);
}
// ---- the sheet's airship
/** The ship's world scale: the boards draw the 460 px envelope at 1×. */
export const SHIP_K = 1;
/** One propeller frame per this many ms — four frames make a 160 ms turn. */
export const PROP_FRAME_MS = 40;
/** The running light's pulse: one full swell per second (≤ 2 Hz, the flash-rate rule). */
export const LIGHT_PERIOD_MS = 1000;
const LIGHT_ALPHA_MIN = 0.45;
const FINS_DARKEN = 0.25;
const LIVERY_PX = 24;
const LIVERY_UP = 6;
const PASSENGER_PX = 16;
const BADGE_PX = 20;
const BADGE_UP = 3;
const READY_PX = 7;
const READY_DOWN = 11;
/**
 * Where each piece sits off the envelope centre (the shared Anchor of body / stripe / gloss), in 1× sheet pixels —
 * `SHIP_OFFSETS` in scripts/sprites/draw.ts, kept equal by blimp.test.ts (the script is not imported: it pulls resvg in).
 */
export const SHEET_SHIP = {
  fins: [-160, 0],
  propeller: [-254, 0],
  light: [98, 112],
  gondolaY: 112,
  windowX: (i: number): number => -90 + 30 * i,
  badge: [205, -6],
} as const;

/** The tail fins' tint: the ship's hue darkened a quarter, so they read as behind the envelope. */
export const finsColour = (theme: Pick<Theme, "ship">): string => mix(theme.ship, "#000000", FINS_DARKEN);

/** The propeller frame at `t`: `floor(t / 40) % 4`; at Level 1 only frames 0 and 2 alternate (its 20 fps cannot show four). */
export function propellerFrame(t: number, level: number): number {
  const n = Math.floor(t / PROP_FRAME_MS);
  return level === 1 ? (n % 2) * 2 : n % 4;
}

/** The running light's alpha at `t`: a 1 Hz sine swell between LIGHT_ALPHA_MIN and 1 — never off, never a strobe. */
export function shipLightAlpha(t: number): number {
  return LIGHT_ALPHA_MIN + (1 - LIGHT_ALPHA_MIN) * (0.5 + 0.5 * Math.sin((t / LIGHT_PERIOD_MS) * Math.PI * 2));
}

/** The `ship-light` sprite's lamp radius at 1× (scripts/sprites/draw.ts: an 8 px disc under a soft rim). */
export const SHIP_LIGHT_R = 8;

/** Where the sheet's running light sits on the canvas for a ship at (x, y) heading `facing` — `drawSheetBlimp`'s transform (turn and foreshorten) applied to its SHEET_SHIP offset. */
export function shipLightAt(f: Pick<BlimpFrame, "x" | "y" | "facing">): { x: number; y: number } {
  const dir = f.facing >= 0 ? 1 : -1;
  const fs = Math.max(MIN_FORESHORTEN, Math.abs(f.facing));
  return { x: f.x + dir * fs * SHEET_SHIP.light[0] * SHIP_K, y: f.y + SHEET_SHIP.light[1] * SHIP_K };
}

export interface Patrol {
  x: number;
  y: number;
  vx: number;
  /** -1 … 1: the heading, eased through 0 mid-turn (the ship foreshortens as it comes about). */
  facing: number;
  step(t: number, k: number, minX: number, maxX: number): void;
  door(s: number): { x: number; y: number; facing: 1 | -1 };
}

export function createPatrol(x0: number, facing: 1 | -1): Patrol {
  const B: Patrol = {
    x: x0,
    y: PATROL_Y,
    vx: CRUISE_PX_PER_FRAME * facing,
    facing,
    step(t, k, minX, maxX) {
      B.x += B.vx * k;
      if (B.x > maxX) {
        B.x = maxX;
        B.vx = -Math.abs(B.vx);
      } else if (B.x < minX) {
        B.x = minX;
        B.vx = Math.abs(B.vx);
      }
      B.facing += (Math.sign(B.vx) - B.facing) * Math.min(1, TURN_RATE * k);
      B.y = PATROL_Y + Math.sin(t / 3100) * 14 + Math.cos(t / 1700) * 5;
    },
    door(s) {
      const dir: 1 | -1 = B.facing >= 0 ? 1 : -1;
      return { x: B.x + dir * DOOR_X * s * Math.max(MIN_FORESHORTEN, Math.abs(B.facing)), y: B.y + DOOR_DROP_Y * s, facing: dir };
    },
  };
  return B;
}

/**
 * The gondola's Passenger pool at `tMs`: SEATS glyphs from `theme.avatars`, cycling the list from an offset that moves
 * one seat every PASSENGER_ROTATE_MS; the n-th lit seat from the nose shows the n-th (no ghost, no `+N`): the windows
 * say "the crowd", never who — the READY count is the ×N badge's. `[]` only when the theme has no avatars. Pure: `tMs`
 * is the loop's.
 */
export function passengers(theme: Pick<Theme, "avatars">, tMs: number): string[] {
  const { avatars } = theme;
  const n = avatars.length;
  if (n === 0) return [];
  const offset = (((Math.floor(tMs / PASSENGER_ROTATE_MS) % n) + n) % n);
  return Array.from({ length: SEATS }, (_, i) => avatars[(i + offset) % n]!);
}

/**
 * The livery at `tMs`: `brand` pins it; otherwise channel ↔ CTA each `alternateMs`, fading out over the last 1/16 of
 * a period and back in over the first, so the swap lands in the trough (the prototype swapped at full alpha).
 */
export function brandFace(channelName: string, cta: string, brand: string, tMs: number, alternateMs: number): { text: string; alpha: number } {
  const pinned = brand.trim();
  if (pinned !== "") return { text: pinned.toUpperCase(), alpha: 1 };
  const channel = channelName.trim().toUpperCase();
  if (channel === "") return { text: cta, alpha: 1 };
  if (!(alternateMs > 0)) return { text: channel, alpha: 1 };
  const phase = (tMs % alternateMs) / alternateMs;
  const alt = Math.floor(tMs / alternateMs) % 2 === 1;
  return { text: alt ? cta : channel, alpha: Math.min(1, (0.5 - Math.abs(phase - 0.5)) * 8) };
}

export interface BlimpFrame {
  t: number;
  x: number;
  y: number;
  facing: number;
  livery: { text: string; alpha: number };
  /** `passengers(theme, t)`: the glyph pool — the n-th lit seat from the nose wears the n-th. */
  passengers: readonly string[];
  queue: number;
}

/** The airship: the sheet's frames when a Theme Sheet is present (`drawSheetBlimp`), else the club-deck's vector ship with its EXIT tag. */
export function drawBlimp(ctx: CanvasRenderingContext2D, theme: Theme, f: BlimpFrame, sprites: SpriteSet | null = null, spec: LevelSpec | null = null): void {
  if (sprites !== null && spec !== null) {
    drawSheetBlimp(ctx, theme, f, sprites, spec);
    return;
  }
  const dir = f.facing >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(Math.max(MIN_FORESHORTEN, Math.abs(f.facing)), 1); // |facing| < 1 mid-turn: the ship foreshortens as it comes about
  // fins
  ctx.fillStyle = theme.ship;
  ctx.beginPath();
  ctx.moveTo(-dir * 120, -14);
  ctx.lineTo(-dir * 200, -62);
  ctx.lineTo(-dir * 170, 0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-dir * 120, 14);
  ctx.lineTo(-dir * 200, 58);
  ctx.lineTo(-dir * 170, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = theme.shipStripe;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(-dir * 130, -12);
  ctx.lineTo(-dir * 190, -50);
  ctx.lineTo(-dir * 168, -4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  // envelope
  ctx.fillStyle = theme.ship;
  ctx.beginPath();
  ctx.ellipse(0, 0, 180, 46, 0, 0, 7);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 180, 46, 0, 0, 7);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.07)";
  ctx.beginPath();
  ctx.ellipse(0, -18, 150, 22, 0, 0, 7);
  ctx.fill();
  ctx.strokeStyle = theme.shipStripe;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 60, -60);
    ctx.lineTo(i * 60, 60);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-180, 12);
  ctx.lineTo(180, 12);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.strokeStyle = theme.shipStripe;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 180, 46, 0, 0, 7);
  ctx.stroke();
  // livery
  ctx.font = "900 15px system-ui, sans-serif";
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = f.livery.alpha;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(f.livery.text, 0, -4);
  ctx.globalAlpha = 1;
  // struts + gondola
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-dir * 80, 40);
  ctx.lineTo(-dir * 70, 56);
  ctx.moveTo(dir * 100, 40);
  ctx.lineTo(dir * 90, 56);
  ctx.moveTo(dir * 12, 46);
  ctx.lineTo(dir * 12, 56);
  ctx.stroke();
  const cabL = dir > 0 ? -116 : -140; // nose end reaches 140, tail end stops 18 px past the last seat — the seat gap
  ctx.fillStyle = theme.ship;
  roundRect(ctx, cabL, 56, 256, 36, 12);
  ctx.fill();
  ctx.strokeStyle = theme.shipStripe;
  ctx.stroke();
  // windows: i counts from the door at the nose backwards; the first litWindows(queue) are lit and seat a Passenger, the rest are dim glass
  const lit = litWindows(f.queue);
  for (let i = 0; i < SEATS; i++) {
    const wx = dir * (94 - i * 32);
    const on = i < lit;
    ctx.globalAlpha = on ? 1 : WINDOW_DIM_ALPHA;
    ctx.beginPath();
    ctx.arc(wx, 74, 11, 0, 7);
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fill();
    ctx.strokeStyle = theme.shipStripe;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const passenger = f.passengers[i];
    if (on && passenger !== undefined) glyph(ctx, passenger, wx, 75, 15);
  }
  // the door at the nose end of the gondola, with the EXIT sign over it
  const dx = dir * DOOR_X;
  ctx.fillStyle = "rgba(0,0,0,.45)";
  roundRect(ctx, dx - 8, 61, 16, 27, 3);
  ctx.fill();
  ctx.strokeStyle = theme.shipStripe;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.6)";
  ctx.beginPath();
  ctx.arc(dx - dir * 4, 76, 1.5, 0, 7);
  ctx.fill();
  ctx.fillStyle = "#1f9d55";
  roundRect(ctx, dx - 14, 46, 28, 10, 2);
  ctx.fill();
  ctx.font = "800 7px ui-monospace, monospace";
  ctx.fillStyle = "#e8fff0";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(EXIT, dx, 51.5);
  // running lights + prop
  ctx.fillStyle = theme.shipLight;
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(dir * (110 - i * 48), 93, 2.5, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,.5)";
  ctx.lineWidth = 3;
  ctx.save();
  ctx.translate(-dir * 186, 0);
  ctx.rotate(f.t / 60);
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(0, 16);
  ctx.moveTo(-16, 0);
  ctx.lineTo(16, 0);
  ctx.stroke();
  ctx.restore();
  // ×N badge on the nose
  ctx.beginPath();
  ctx.arc(dir * 176, -30, 24, 0, 7);
  ctx.fillStyle = f.queue > 0 ? theme.gold : "rgba(255,255,255,.15)";
  ctx.fill();
  ctx.font = "900 20px system-ui, sans-serif";
  ctx.fillStyle = f.queue > 0 ? "#000" : "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(compactCount(f.queue), dir * 176, -29);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

/**
 * The sheet airship. The frames are baked nose-right; `ctx.scale(dir × foreshorten, 1)` turns and thins the ship as it
 * comes about (the words are drawn in a second, unmirrored pass so they only ever foreshorten). Every piece is placed
 * at its SHEET_SHIP offset × SHIP_K off the envelope centre.
 */
function drawSheetBlimp(ctx: CanvasRenderingContext2D, theme: Theme, f: BlimpFrame, sprites: SpriteSet, spec: LevelSpec): void {
  const s = spec.spriteScale;
  const k = SHIP_K;
  const dir = f.facing >= 0 ? 1 : -1;
  const fs = Math.max(MIN_FORESHORTEN, Math.abs(f.facing));
  const at = (p: readonly [number, number]): [number, number] => [p[0] * k, p[1] * k];
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(dir * fs, 1);
  sprites.draw(ctx, "fins", s, ...at(SHEET_SHIP.fins), { colour: finsColour(theme), k });
  sprites.draw(ctx, "ship-body", s, 0, 0, { colour: theme.ship, k });
  sprites.draw(ctx, "ship-stripe", s, 0, 0, { colour: theme.shipStripe, k });
  sprites.draw(ctx, "ship-gloss", s, 0, 0, { k });
  sprites.draw(ctx, `propeller-${propellerFrame(f.t, spec.level)}`, s, ...at(SHEET_SHIP.propeller), { k });
  // windowX(i) counts from the tail; seat SEATS - 1 - i from the nose is lit while that is under litWindows(queue)
  const lit = litWindows(f.queue);
  const seatLit = (i: number): boolean => SEATS - 1 - i < lit;
  for (let i = 0; i < SEATS; i++) sprites.draw(ctx, "gondola-window", s, SHEET_SHIP.windowX(i) * k, SHEET_SHIP.gondolaY * k, seatLit(i) ? { k } : { k, alpha: WINDOW_DIM_ALPHA });
  sprites.draw(ctx, "ship-light", s, ...at(SHEET_SHIP.light), { colour: theme.shipLight, k, alpha: shipLightAlpha(f.t) });
  const queued = f.queue > 0;
  if (queued) sprites.draw(ctx, "ready-badge", s, ...at(SHEET_SHIP.badge), { colour: theme.gold, k });
  else sprites.draw(ctx, "ready-badge-dim", s, ...at(SHEET_SHIP.badge), { k });
  ctx.restore();
  // the words: foreshortened with the ship, never mirrored — x mirrored by hand as the club-deck does
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(fs, 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${LIVERY_PX * k}px system-ui, sans-serif`;
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = f.livery.alpha;
  ctx.fillText(f.livery.text, 0, -LIVERY_UP * k);
  ctx.globalAlpha = 1;
  for (let n = 0; n < lit; n++) glyph(ctx, f.passengers[n] ?? PASSENGER_FALLBACK, dir * SHEET_SHIP.windowX(SEATS - 1 - n) * k, SHEET_SHIP.gondolaY * k, PASSENGER_PX * k); // from the nose backwards
  const [bx, by] = SHEET_SHIP.badge;
  ctx.font = `900 ${BADGE_PX * k}px system-ui, sans-serif`;
  ctx.fillStyle = queued ? "#000" : "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(compactCount(f.queue), dir * bx * k, (by - BADGE_UP) * k);
  ctx.font = `800 ${READY_PX * k}px ui-monospace, monospace`;
  ctx.globalAlpha = queued ? 0.85 : 0.6;
  ctx.fillText(theme.readyWord, dir * bx * k, (by + READY_DOWN) * k);
  ctx.globalAlpha = 1;
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

export interface SignFrame {
  x: number;
  y: number;
  hangFromY: number;
  progressCents: number;
  thresholdCents: number;
  fullCount: number;
}

export const SIGN_W = 250;
const SIGN_H = 46;

/** `$X of $Y` on a panel hanging from the gondola: gold and FULL (`FULL ×n`) while a crossing holds. */
export function drawSign(ctx: CanvasRenderingContext2D, theme: Theme, f: SignFrame): void {
  const { x, y } = f;
  ctx.strokeStyle = "rgba(255,255,255,.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 20, f.hangFromY);
  ctx.lineTo(x + 20, y);
  ctx.moveTo(x + SIGN_W - 20, f.hangFromY);
  ctx.lineTo(x + SIGN_W - 20, y);
  ctx.stroke();
  ctx.fillStyle = theme.panel;
  roundRect(ctx, x, y, SIGN_W, SIGN_H, 8);
  ctx.fill();
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const full = f.fullCount > 0;
  ctx.font = "800 10px ui-monospace, monospace";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = 0.7;
  ctx.fillText(nextUnlockLabel(theme), x + 12, y + 15);
  ctx.globalAlpha = 1;
  const amount = money(f.progressCents);
  ctx.font = "900 20px system-ui, sans-serif";
  ctx.fillStyle = full ? theme.gold : "#fff";
  ctx.fillText(amount, x + 12, y + 36);
  const amountW = ctx.measureText(amount).width;
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.globalAlpha = 0.75;
  ctx.fillText(faderOf(f.thresholdCents, f.fullCount), x + 12 + amountW + 30, y + 36);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,.12)";
  roundRect(ctx, x + 150, y + 26, 88, 8, 4);
  ctx.fill();
  ctx.fillStyle = full ? theme.gold : theme.accent;
  roundRect(ctx, x + 150, y + 26, 88 * (f.thresholdCents > 0 ? clamp(f.progressCents / f.thresholdCents, 0, 1) : 0), 8, 4);
  ctx.fill();
}

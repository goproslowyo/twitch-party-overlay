/**
 * The Celebration curve: one continuous intensity from the contribution's face value —
 * `clamp(ln(face / $1) / ln(anchor / $1), 0, 1)` — and every cosmetic knob as a function of it. Log, not linear, on
 * purpose: each step up reads bigger, but a $1,000 cheer cannot drown the stream. The anchor (`intensityAnchorCents`,
 * $600 by default) is the one number to tune. Nothing here prints an amount and nothing here can touch the Ledger.
 */
import type { OverlayConfig } from "../config/schema.ts";

export const BASE_PARTICLES = 38;
export const PARTICLE_LIFE_BASE = 1.3;
export const PARTICLE_LIFE_SPAN = 1.3;
export const FIREWORKS_FROM = 0.5;
export const FIREWORKS_BASE = 2;
export const FIREWORKS_SPAN = 16;
export const SOFT_PULSE_FROM = 0.7;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 0 at $1 and below, 1 at the anchor and above. A degenerate anchor (≤ $1) makes everything above $1 the top. */
export function intensity(faceValueCents: number, anchorCents: number): number {
  if (!(faceValueCents > 100)) return 0;
  const scale = Math.log(anchorCents / 100);
  if (!(scale > 0)) return 1;
  return clamp(Math.log(faceValueCents / 100) / scale, 0, 1);
}

/** `round(38 + (cap − 38) × i)` — the burst size, `cap` being the Quality Level's particle cap. */
export function particleCount(i: number, cap: number): number {
  return Math.round(BASE_PARTICLES + (cap - BASE_PARTICLES) * i);
}

/** `1.3 + 1.3 i` — particle lifetime multiplier. */
export function particleLife(i: number): number {
  return PARTICLE_LIFE_BASE + PARTICLE_LIFE_SPAN * i;
}

/** `min + (max − min) × i` — how long the acknowledgement line dwells. */
export function thankDwellMs(i: number, cfg: Pick<OverlayConfig, "thankDwellMinMs" | "thankDwellMaxMs">): number {
  return cfg.thankDwellMinMs + (cfg.thankDwellMaxMs - cfg.thankDwellMinMs) * i;
}

/** None below 0.5, then `round(2 + 16 × (i − 0.5))` bursts over the floor. */
export function fireworks(i: number): number {
  return i < FIREWORKS_FROM ? 0 : Math.round(FIREWORKS_BASE + FIREWORKS_SPAN * (i - FIREWORKS_FROM));
}

/** The big-text moment (`{what}` uppercased + @name) from `bigIntensity` up. */
export function bigText(i: number, cfg: Pick<OverlayConfig, "bigIntensity">): boolean {
  return i >= cfg.bigIntensity;
}

/** The soft (8 %) full-screen pulse from 0.7 up. */
export function softPulse(i: number): boolean {
  return i >= SOFT_PULSE_FROM;
}

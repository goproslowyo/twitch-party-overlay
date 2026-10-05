import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import { bigText, fireworks, intensity, particleCount, particleLife, softPulse, thankDwellMs } from "./celebration.ts";

const cfg = defaultConfig().overlay; // intensityAnchorCents 60000, bigIntensity 0.6, dwell 4000–7000
const PARTICLE_CAP = 260; // Quality Level 4's particle cap
const ANCHOR = cfg.intensityAnchorCents;

describe("intensity = clamp(ln(face/100) / ln(anchor/100), 0, 1)", () => {
  // the intensity table (face → intensity at the $600 anchor)
  test.each([
    ["tip $3", 300, 0.17],
    ["500 bits", 500, 0.25],
    ["tip $15", 1500, 0.42],
    ["tip $40", 4000, 0.58],
    ["10,000 bits", 10000, 0.72],
    ["25 gift subs", 14975, 0.78],
    ["100 gift subs", 59900, 1.0],
    ["tip $1,000 (cap)", 100000, 1.0],
  ])("%s → %f", (_label, face, expected) => {
    expect(Math.abs(intensity(face, ANCHOR) - expected)).toBeLessThanOrEqual(0.01);
  });
  test("$1 and below → 0; the anchor itself → 1; never outside [0, 1]", () => {
    expect(intensity(100, ANCHOR)).toBe(0);
    expect(intensity(1, ANCHOR)).toBe(0);
    expect(intensity(0, ANCHOR)).toBe(0);
    expect(intensity(ANCHOR, ANCHOR)).toBe(1);
    expect(intensity(10 * ANCHOR, ANCHOR)).toBe(1);
  });
  test("the anchor is the one knob: a $100 anchor makes $100 the top", () => {
    expect(intensity(10000, 10000)).toBe(1);
    expect(intensity(1000, 10000)).toBeCloseTo(0.5, 5);
  });
  test("a degenerate anchor (≤ $1) cannot divide by zero: anything above $1 is the top", () => {
    expect(intensity(300, 100)).toBe(1);
    expect(intensity(100, 100)).toBe(0);
  });
});

describe("the knobs follow intensity", () => {
  test("particleCount = round(38 + (cap − 38) × i)", () => {
    expect(particleCount(0, PARTICLE_CAP)).toBe(38);
    expect(particleCount(1, PARTICLE_CAP)).toBe(260);
    expect(particleCount(0.5, PARTICLE_CAP)).toBe(149);
    expect(particleCount(0.72, 100)).toBe(83);
  });
  test("particleLife = 1.3 + 1.3 i", () => {
    expect(particleLife(0)).toBeCloseTo(1.3, 10);
    expect(particleLife(1)).toBeCloseTo(2.6, 10);
    expect(particleLife(0.5)).toBeCloseTo(1.95, 10);
  });
  test("thankDwellMs = min + (max − min) × i", () => {
    expect(thankDwellMs(0, cfg)).toBe(4000);
    expect(thankDwellMs(1, cfg)).toBe(7000);
    expect(thankDwellMs(0.5, cfg)).toBe(5500);
    expect(thankDwellMs(0.42, { thankDwellMinMs: 1000, thankDwellMaxMs: 2000 })).toBe(1420);
  });
  test("fireworks: none below 0.5, then round(2 + 16 × (i − 0.5))", () => {
    expect(fireworks(0)).toBe(0);
    expect(fireworks(0.49)).toBe(0);
    expect(fireworks(0.5)).toBe(2);
    expect(fireworks(0.75)).toBe(6);
    expect(fireworks(1)).toBe(10);
  });
  test("bigText at or above bigIntensity; softPulse at or above 0.7", () => {
    expect(bigText(0.59, cfg)).toBe(false);
    expect(bigText(0.6, cfg)).toBe(true);
    expect(bigText(0.6, { bigIntensity: 0.8 })).toBe(false);
    expect(softPulse(0.69)).toBe(false);
    expect(softPulse(0.7)).toBe(true);
  });
});

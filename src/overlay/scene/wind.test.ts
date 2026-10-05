import { describe, expect, test } from "bun:test";
import { seededRandom } from "./util.ts";
import { BITS, GX, GY, RIBBONS, TRAIL_MAX, WindField, createCells, groundWind, sampleField, stepCells, type WindBounds } from "./wind.ts";

const bounds: WindBounds = { x0: 220, x1: 1180, skyY: 60, groundY: 999 };

describe("the wind cells — own gusts, neighbour diffusion, convergence lift", () => {
  test("6×4 cells, seeded: the same seed gives the same field frame for frame", () => {
    const a = createCells(seededRandom(7));
    const b = createCells(seededRandom(7));
    expect(a).toHaveLength(GX * GY);
    for (let t = 0; t < 5000; t += 16) {
      stepCells(a, t, 1, seededRandom(t));
      stepCells(b, t, 1, seededRandom(t));
    }
    expect(a.map((c) => c.u)).toEqual(b.map((c) => c.u));
    expect(a.some((c) => Math.abs(c.u) > 0.1)).toBe(true); // it blows
  });

  test("a cell blends toward its neighbours' mean: an isolated strong cell bleeds into its calm neighbours", () => {
    const cells = createCells(seededRandom(1));
    for (const c of cells) Object.assign(c, { raw: 0, u: 0, v: 0, target: 0, gustT: 1e9 });
    cells[GX * 1 + 2]!.u = 2;
    stepCells(cells, 0, 1, () => 0.5);
    expect(cells[GX * 1 + 1]!.u).toBeGreaterThan(0);
    expect(cells[GX * 1 + 3]!.u).toBeGreaterThan(0);
    expect(cells[GX * 1 + 2]!.u).toBeLessThan(2);
  });

  test("air meeting lifts, air parting sinks: v follows the horizontal convergence", () => {
    const cells = createCells(seededRandom(1));
    for (const c of cells) Object.assign(c, { raw: 0, u: 0, v: 0, target: 0, gustT: 1e9 });
    // row 0: cell 1 blows right into cell 3 blowing left → cell 2 converges
    cells[1]!.u = 2;
    cells[3]!.u = -2;
    for (let i = 0; i < 40; i++) stepCells(cells, 0, 1, () => 0.5);
    expect(cells[2]!.v).toBeGreaterThan(0.05);
    // row 2: cell 1 blows left, cell 3 blows right → cell 2 diverges → sink
    cells[GX * 2 + 1]!.u = -2;
    cells[GX * 2 + 3]!.u = 2;
    for (let i = 0; i < 40; i++) stepCells(cells, 0, 1, () => 0.5);
    expect(cells[GX * 2 + 2]!.v).toBeLessThan(-0.05);
  });

  test("sampleField is bilinear: exact at cell centres, in between in between; outside the box it clamps", () => {
    const cells = createCells(seededRandom(1));
    cells.forEach((c, i) => Object.assign(c, { u: i % GX, v: Math.floor(i / GX) }));
    const cw = (bounds.x1 - bounds.x0) / (GX - 1);
    const rh = (bounds.groundY - bounds.skyY) / (GY - 1);
    expect(sampleField(cells, bounds, bounds.x0, bounds.skyY)).toEqual({ u: 0, v: 0 });
    expect(sampleField(cells, bounds, bounds.x0 + cw * 2, bounds.skyY + rh)).toEqual({ u: 2, v: 1 });
    expect(sampleField(cells, bounds, bounds.x0 + cw * 2.5, bounds.skyY + rh * 1.5).u).toBeCloseTo(2.5, 6);
    expect(sampleField(cells, bounds, bounds.x0 + cw * 2.5, bounds.skyY + rh * 1.5).v).toBeCloseTo(1.5, 6);
    expect(sampleField(cells, bounds, -5000, -5000)).toEqual({ u: 0, v: 0 });
    expect(sampleField(cells, bounds, 5000, 5000)).toEqual({ u: GX - 1, v: GY - 1 });
  });

  test("groundWind is the mean of the bottom row — what the windsock reads", () => {
    const cells = createCells(seededRandom(1));
    cells.forEach((c, i) => (c.u = i >= GX * (GY - 1) ? 1.5 : -9));
    expect(groundWind(cells)).toBeCloseTo(1.5, 9);
  });
});

describe("WindField — the ribbons and the blown bits, only while someone is in the air", () => {
  test("before its first step it samples calm; the ribbons exist only once it is visible", () => {
    const f = new WindField(seededRandom(3));
    expect(f.at(500, 500)).toEqual({ u: 0, v: 0 });
    f.step(0, 16, bounds, ["♪", "·"], false);
    expect(f.ribbons).toHaveLength(0);
    expect(f.bits).toHaveLength(0);
    f.step(16, 16, bounds, ["♪", "·"], true);
    expect(f.ribbons).toHaveLength(RIBBONS);
    expect(f.bits).toHaveLength(BITS);
    expect(f.bits.every((b) => b.g === "♪" || b.g === "·")).toBe(true);
  });

  test("ribbons stay inside the box (respawned when they leave or expire), trails cap at TRAIL_MAX and fill up", () => {
    const f = new WindField(seededRandom(3));
    let t = 0;
    for (; t < 12000; t += 16) f.step(t, 16, bounds, ["·"], true);
    for (const r of f.ribbons) {
      expect(r.x).toBeGreaterThanOrEqual(bounds.x0 - 140);
      expect(r.x).toBeLessThanOrEqual(bounds.x1 + 140);
      expect(r.y).toBeGreaterThanOrEqual(bounds.skyY);
      expect(r.y).toBeLessThanOrEqual(bounds.groundY);
      expect(r.trail.length).toBeLessThanOrEqual(TRAIL_MAX);
    }
    expect(f.ribbons.filter((r) => r.trail.length === TRAIL_MAX).length).toBeGreaterThan(RIBBONS / 2);
    expect(Math.abs(f.ground())).toBeGreaterThan(0);
    expect(f.ground()).toBeCloseTo(groundWind(f.cells), 9);
  });
});

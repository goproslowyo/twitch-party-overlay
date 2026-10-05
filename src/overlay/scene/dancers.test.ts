import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/schema.ts";
import { LEVELS } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { FIGURE_W, MOVES, POSES, assertNoNaN, figure, type Pose } from "./dancer-figure.ts";
import { DEFAULT_FRAME, Dancers, ROSTER, ROWS, WALK, freeSegments, shortName, sweepPools, towerBands, type Dancer, type DancersFrame } from "./dancers.ts";
import { TOWER_W, createTowers, sheetTowerX, type Tower } from "./towers.ts";
import { seededRandom } from "./util.ts";
import type { Chatter } from "../../server/overlay.ts";
import { avatarFor } from "../theme.ts";

const base = defaultConfig();
const chrome = base.themes["chrome-lounge"]!;
/** The rack on the left: the scene's span mirrored (it starts 70 px past the rack panel, as `sceneLayout` lays it). */
const LEFT_FRAME: DancersFrame = { horizonY: 640, gy: 968, sceneL: 410, sceneR: 1880 };
const DT = 1000 / 30;

/** A recording 2-D context: every call is remembered in order with its arguments; `globalAlpha` reads back. */
function recorder(): { ctx: CanvasRenderingContext2D; ops: { op: string; args: unknown[] }[] } {
  const ops: { op: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 7 });
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop(): void {} });
      return (...args: unknown[]) => void ops.push({ op: key, args });
    },
    set(target, key: string, value) {
      target[key] = value;
      ops.push({ op: `set:${key}`, args: [value] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

interface Drawn {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
}

/** A SpriteSet that records every `draw` and puts one `drawImage` on the context per call. */
function fakeSprites(): { set: SpriteSet; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const set: SpriteSet = {
    id: "chrome-lounge",
    setDetail: () => {},
    get: () => ({ image: {} as CanvasImageSource, frame: { x: 0, y: 0, w: 140, h: 176, ax: 70, ay: 168, kind: "plate" }, scale: 1 }),
    has: () => true,
    names: () => [...new Set(drawn.map((d) => d.name))],
    draw(ctx, name, scale, x, y, opts) {
      drawn.push({ name, scale, x, y, opts });
      ctx.drawImage({} as CanvasImageSource, 0, 0);
    },
  };
  return { set, drawn };
}

/** The six tower base rects (left edge, right edge) for a frame, straight from towers.ts. */
function bases(frame: DancersFrame): [number, number][] {
  return createTowers(seededRandom(1)).map((T) => {
    const x = sheetTowerX(T, frame);
    return [x, x + TOWER_W];
  });
}

const inBand = (x: number, bands: ReadonlyArray<readonly [number, number]>): boolean => bands.some(([a, b]) => x >= a && x <= b);

/** Step `dancers` for `seconds` at 30 fps, calling `each(tMs)` after every step. */
function run(dancers: Dancers, seconds: number, each: (tMs: number) => void = () => {}, sweepsX: readonly number[] = [], energy = 1): void {
  for (let t = DT; t <= seconds * 1000; t += DT) {
    dancers.step(DT, t, sweepsX, energy);
    each(t);
  }
}

describe("the roster — 24 on the far floor, never an empty club, never static", () => {
  test("exactly 24 on construction; over ten minutes it stays within [22, 24] and people arrive and leave", () => {
    const dancers = new Dancers(seededRandom(7));
    expect(dancers.present()).toBe(ROSTER);
    expect(dancers.all()).toHaveLength(ROSTER);
    const seen = new Set<string>();
    let min = ROSTER;
    let max = ROSTER;
    run(dancers, 600, () => {
      const n = dancers.present();
      min = Math.min(min, n);
      max = Math.max(max, n);
      for (const d of dancers.all()) {
        seen.add(d.state);
        expect(Number.isFinite(d.x) && Number.isFinite(d.tx)).toBe(true);
      }
    });
    expect(min).toBeGreaterThanOrEqual(22);
    expect(max).toBeLessThanOrEqual(24);
    expect(seen.has("in")).toBe(true);
    expect(seen.has("out")).toBe(true);
    expect(dancers.present()).toBeGreaterThanOrEqual(22);
  });

  test("the roster never exceeds its target, whatever the dice: 24 over several seeds, and a roster of one on the seeds where an event with nobody dancing used to admit a second", () => {
    for (const [roster, seeds] of [
      [ROSTER, [7, 8, 9]],
      [1, [10, 39, 45]],
    ] as const) {
      for (const seed of seeds) {
        const dancers = new Dancers(seededRandom(seed), roster);
        let max = 0;
        run(dancers, 600, () => {
          max = Math.max(max, dancers.present());
        });
        expect(max).toBeLessThanOrEqual(roster);
      }
    }
  });

  test("three depth rows: y as a share of the floor between the horizon and the ground line, ≈0.24× at the back to ≈0.62× at the front", () => {
    expect(ROWS).toHaveLength(3);
    expect(ROWS[0]!.s).toBeCloseTo(0.24, 2);
    expect(ROWS[2]!.s).toBeCloseTo(0.62, 2);
    for (let i = 1; i < ROWS.length; i++) {
      expect(ROWS[i]!.y).toBeGreaterThan(ROWS[i - 1]!.y);
      expect(ROWS[i]!.s).toBeGreaterThan(ROWS[i - 1]!.s);
    }
    expect(ROWS.every((r) => r.y > 0 && r.y < 1)).toBe(true); // between the horizon and the pad strip, never on it
    const roster = new Dancers(seededRandom(3)).all();
    for (const r of [0, 1, 2]) expect(roster.some((d) => d.row === r)).toBe(true);
    expect(new Set(roster.map((d) => d.sz.toFixed(3))).size).toBeGreaterThan(3); // ±10 % size jitter
    expect(roster.every((d) => d.sz >= 0.9 && d.sz <= 1.1)).toBe(true);
  });

  test("pairs, groups and loners; poses cycle on their own phases", () => {
    const dancers = new Dancers(seededRandom(11));
    const roster = dancers.all();
    const groups = new Set(roster.map((d) => d.grp).filter((g) => g !== null));
    expect(groups.size).toBeGreaterThan(2);
    expect(roster.some((d) => d.grp === null)).toBe(true);
    for (const g of groups) expect(g.m.length).toBeGreaterThanOrEqual(2);
    const before = roster.map((d) => `${d.id}:${d.pose}`);
    run(dancers, 40);
    const after = dancers.all().map((d) => `${d.id}:${d.pose}`);
    expect(after).not.toEqual(before);
    expect(new Set(dancers.all().map((d) => d.bpm.toFixed(2))).size).toBeGreaterThan(3);
  });
});

describe("the zone — the free width less the rack side and the six tower bases", () => {
  test("towerBands / freeSegments: six bands around the towers' bases, wider for a nearer row; the segments avoid every band", () => {
    for (const row of [0, 1, 2]) {
      const bands = towerBands(DEFAULT_FRAME, row);
      expect(bands).toHaveLength(6);
      const b = bases(DEFAULT_FRAME);
      bands.forEach(([a, z], i) => {
        expect(a).toBeLessThan(b[i]![0]);
        expect(z).toBeGreaterThan(b[i]![1]);
      });
      const segs = freeSegments(DEFAULT_FRAME, row);
      expect(segs.length).toBeGreaterThan(0);
      for (const [x0, x1] of segs) {
        expect(x0).toBeLessThan(x1);
        expect(x0).toBeGreaterThanOrEqual(DEFAULT_FRAME.sceneL);
        expect(x1).toBeLessThanOrEqual(DEFAULT_FRAME.sceneR);
        for (const [a, z] of bands) expect(x1 <= a || x0 >= z).toBe(true);
      }
    }
    const wide = towerBands(DEFAULT_FRAME, 2)[0]!;
    const narrow = towerBands(DEFAULT_FRAME, 0)[0]!;
    expect(wide[1] - wide[0]).toBeGreaterThan(narrow[1] - narrow[0]);
    expect(wide[1] - wide[0]).toBeGreaterThan(TOWER_W + FIGURE_W * 0.62); // the near figure's own width clears the base
  });

  test("a leaver walks off and fades over the walk it has left — never a pop to half alpha on the first frame (fix-wave residual)", () => {
    const dancers = new Dancers(seededRandom(5));
    dancers.layout(DEFAULT_FRAME);
    const prev = new Map<number, number>();
    let leavers = 0;
    run(dancers, 600, () => {
      for (const d of dancers.all()) {
        if (d.state !== "out") {
          prev.delete(d.id);
          continue;
        }
        const last = prev.get(d.id);
        if (last === undefined) {
          leavers++;
          expect(d.alpha).toBeGreaterThanOrEqual(0.85); // still whole when it turns to go
        } else {
          expect(d.alpha).toBeLessThanOrEqual(last + 1e-9); // and only ever dims from there
        }
        prev.set(d.id, d.alpha);
      }
    });
    expect(leavers).toBeGreaterThanOrEqual(5);
  });

  test("over ten minutes NOBODY — standing, arriving or leaving — is ever inside a tower band or outside the scene's span (which ends short of the rack), on either side (MUST 6)", () => {
    for (const frame of [DEFAULT_FRAME, LEFT_FRAME]) {
      const dancers = new Dancers(seededRandom(5));
      dancers.layout(frame);
      const b = bases(frame);
      let standing = 0;
      let walking = 0;
      run(dancers, 600, () => {
        for (const d of dancers.all()) {
          expect(d.x).toBeGreaterThanOrEqual(frame.sceneL);
          expect(d.x).toBeLessThanOrEqual(frame.sceneR);
          // every home — and every walker's edge — keeps clear of the bases by the figure's own half-width …
          expect(inBand(d.tx, towerBands(frame, d.row))).toBe(false);
          expect(inBand(d.tx, b)).toBe(false);
          // … and so does every body, on every frame: a walker arrives and leaves at the inner edge of its own free span, never crossing a tower foot
          expect(inBand(d.x, towerBands(frame, d.row))).toBe(false);
          expect(inBand(d.x, b)).toBe(false);
          if (d.state === "dance" && Math.abs(d.tx - d.x) <= 3) standing++;
          if (d.state === "in" || d.state === "out") walking++;
        }
      });
      expect(standing).toBeGreaterThan(1000);
      expect(walking).toBeGreaterThan(30); // people did come and go
    }
  });

  test("a new frame (a resize, the rack swapping sides) remaps everyone into the new zone", () => {
    const dancers = new Dancers(seededRandom(9));
    run(dancers, 30);
    dancers.layout(LEFT_FRAME);
    const b = bases(LEFT_FRAME);
    for (const d of dancers.all()) {
      expect(d.x).toBeGreaterThanOrEqual(LEFT_FRAME.sceneL);
      expect(d.x).toBeLessThanOrEqual(LEFT_FRAME.sceneR);
      if (d.state !== "out") expect(inBand(d.tx, b)).toBe(false);
    }
    run(dancers, 30);
    expect(dancers.present()).toBeGreaterThanOrEqual(22);
  });
});

describe("walkers — profile frames facing the way they travel", () => {
  test("every walker's flip is exactly `tx < x`; walkers move at WALK px/s toward home and are removed at the edge", () => {
    const dancers = new Dancers(seededRandom(2));
    let seenLeft = 0;
    let seenRight = 0;
    let prev = new Map<number, number>();
    run(dancers, 600, () => {
      const now = new Map<number, number>();
      for (const w of dancers.walkers()) {
        expect(w.flip).toBe(w.tx < w.x);
        if (w.flip) seenLeft++;
        else seenRight++;
      }
      for (const d of dancers.all()) {
        now.set(d.id, d.x);
        const was = prev.get(d.id);
        if (was !== undefined) expect(Math.abs(d.x - was)).toBeLessThanOrEqual(WALK * (DT / 1000) + 1e-6);
      }
      prev = now;
    });
    expect(seenLeft).toBeGreaterThan(0);
    expect(seenRight).toBeGreaterThan(0);
  });

  test("every DRAWN walk body faces its own travel: flipX exactly when that Dancer's home lies to its left, per `all()` captured before the draw", () => {
    let leftward = 0;
    let rightward = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const dancers = new Dancers(seededRandom(seed));
      for (let t = 0; t < 600_000; t += DT) {
        dancers.step(DT, t, [], 1);
        if (dancers.walkers().length === 0) continue;
        // the travel of everyone the draw will paint, in the draw's own order (far row first, stable), taken before it runs
        const travel = [...dancers.all()]
          .filter((d) => ROWS[d.row]!.a * d.alpha > 0)
          .sort((a, b) => a.row - b.row)
          .map((d) => Math.sign(d.tx - d.x));
        const sp = fakeSprites();
        dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], []);
        const bodies = sp.drawn.filter((_, i) => i % 4 === 2);
        expect(bodies).toHaveLength(travel.length);
        bodies.forEach((b, i) => {
          if (!b.name.startsWith("dancer-walk-")) return;
          if (travel[i]! < 0) {
            leftward++;
            expect(b.opts?.flipX).toBe(true); // travelling leftwards: the profile is mirrored
          } else {
            rightward++;
            expect(b.opts?.flipX).not.toBe(true); // travelling rightwards: the sheet's own +x-facing profile
          }
        });
        if (leftward > 20 && rightward > 20) break;
      }
      if (leftward > 20 && rightward > 20) break;
    }
    expect(leftward).toBeGreaterThan(20);
    expect(rightward).toBeGreaterThan(20);
  });
});

describe("the same roster at every Quality Level — only the Sheet Scale changes", () => {
  test("LEVELS[1] and LEVELS[5] give identical present() and identical frames after identical steps", () => {
    const a = new Dancers(seededRandom(4));
    const b = new Dancers(seededRandom(4));
    const sa = fakeSprites();
    const sb = fakeSprites();
    for (let t = DT; t <= 120_000; t += DT) {
      a.step(DT, t, [700], 1);
      b.step(DT, t, [700], 1);
      if (Math.round(t / DT) % 30 === 0) {
        expect(a.present()).toBe(b.present());
        sa.drawn.length = 0;
        sb.drawn.length = 0;
        a.draw(recorder().ctx, chrome, DEFAULT_FRAME, sa.set, LEVELS[1], []);
        b.draw(recorder().ctx, chrome, DEFAULT_FRAME, sb.set, LEVELS[5], []);
        expect(sa.drawn.map((d) => d.name)).toEqual(sb.drawn.map((d) => d.name));
        expect(new Set(sa.drawn.map((d) => d.scale))).toEqual(new Set([0.5]));
        expect(new Set(sb.drawn.map((d) => d.scale))).toEqual(new Set([1]));
        expect(sa.drawn.map((d) => d.opts?.k)).toEqual(sb.drawn.map((d) => d.opts?.k)); // the same world size: `k` never changes with the level
      }
    }
  });
});

describe("draw — reflection first, then the body, then the rim lit by the nearest sweep", () => {
  /** Thirty seconds in, with a walker forced onto the floor, one frame on a fake sheet. */
  function frame(sweeps: ReadonlyArray<{ x: number; colour: string }>, seed = 6) {
    const dancers = new Dancers(seededRandom(seed));
    let t = 0;
    for (; t < 30_000; t += DT) dancers.step(DT, t, sweeps.map((s) => s.x), 1);
    const { ctx, ops } = recorder();
    const sp = fakeSprites();
    dancers.draw(ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], sweeps);
    return { dancers, ops, drawn: sp.drawn, ctx };
  }

  test("per Dancer: a negative-y reflection of the body and rim, then the body (never tinted), then its rim (tinted); far rows first", () => {
    const { dancers, ops, drawn } = frame([{ x: 800, colour: "#ff0000" }]);
    const shown = dancers.all().filter((d) => d.alpha > 0);
    expect(drawn).toHaveLength(shown.length * 4);
    for (let i = 0; i < drawn.length; i += 4) {
      const [r1, r2, body, rim] = [drawn[i]!, drawn[i + 1]!, drawn[i + 2]!, drawn[i + 3]!];
      expect(body.name).toMatch(/^dancer-[a-zA-Z]+-\d$/);
      expect(body.opts?.colour).toBeUndefined();
      expect(rim.name).toMatch(new RegExp(`^${body.name}-rim(-flip)?$`));
      expect(rim.opts?.colour).toBe("#ff0000");
      expect(r1.name).toBe(body.name);
      expect(r2.name).toBe(rim.name);
      expect(r1.opts!.alpha!).toBeLessThan(body.opts!.alpha!);
      expect(r1.opts!.alpha! / body.opts!.alpha!).toBeGreaterThanOrEqual(0.13);
      expect(r1.opts!.alpha! / body.opts!.alpha!).toBeLessThanOrEqual(0.16);
      expect(rim.opts!.alpha!).toBeLessThanOrEqual(body.opts!.alpha!);
    }
    // the reflection is the same frame under a negative y scale about the feet, drawn before the body
    const scales = ops.filter((o) => o.op === "scale");
    expect(scales).toHaveLength(shown.length);
    for (const s of scales) expect(s.args[1] as number).toBeCloseTo(-0.55, 2);
    const firstImage = ops.findIndex((o) => o.op === "drawImage");
    expect(ops.slice(0, firstImage).some((o) => o.op === "scale")).toBe(true);
    // far rows first: the drawn y never decreases across the frame's bodies
    const ys = drawn.filter((_, i) => i % 4 === 2).map((d) => d.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! + 12).toBeGreaterThanOrEqual(ys[i - 1]!); // bob is at most 9 px × energy
    // feet on the row line: every body's y lies inside the far-floor band
    for (const y of ys) {
      expect(y).toBeGreaterThan(DEFAULT_FRAME.horizonY);
      expect(y).toBeLessThan(DEFAULT_FRAME.gy);
    }
    expect(ops.filter((o) => o.op.startsWith("set:")).map((o) => o.op)).not.toContain("set:filter");
    expect(ops.filter((o) => o.op.startsWith("set:")).map((o) => o.op)).not.toContain("set:shadowBlur");
  });

  test("rims take the NEAREST sweep's colour, brighter when it is close; with no sweep the horizon's accent at the idle level", () => {
    const { drawn } = frame([
      { x: 500, colour: "#ff0000" },
      { x: 1100, colour: "#00ff00" },
    ]);
    const rims = drawn.filter((_, i) => i % 4 === 3);
    expect(rims.length).toBeGreaterThan(0);
    for (const r of rims) expect(r.opts?.colour).toBe(Math.abs(r.x - 500) < Math.abs(r.x - 1100) ? "#ff0000" : "#00ff00");
    const near = rims.filter((r) => Math.abs(r.x - 500) < 60);
    const far = rims.filter((r) => Math.abs(r.x - 500) > 300 && Math.abs(r.x - 1100) > 300);
    if (near.length && far.length) expect(Math.max(...near.map((r) => r.opts!.alpha!))).toBeGreaterThan(Math.min(...far.map((r) => r.opts!.alpha!)));
    const none = frame([]).drawn.filter((_, i) => i % 4 === 3);
    for (const r of none) expect(r.opts?.colour).toBe(chrome.accent);
  });

  test("a walker is drawn with the profile walk frames, flipped by its travel; a flipped walker's rim is the pre-mirrored -rim-flip frame with the same flip", () => {
    let leftward = 0;
    let rightward = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const dancers = new Dancers(seededRandom(seed));
      for (let t = 0; t < 600_000; t += DT) {
        dancers.step(DT, t, [], 1);
        const walkers = dancers.walkers();
        if (walkers.length === 0) continue;
        const sp = fakeSprites();
        dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], []);
        const bodies = sp.drawn.filter((_, i) => i % 4 === 2);
        const rims = sp.drawn.filter((_, i) => i % 4 === 3);
        const walkBodies = bodies.map((b, i) => ({ b, r: rims[i]! })).filter(({ b }) => b.name.startsWith("dancer-walk-"));
        expect(walkBodies.length).toBeGreaterThanOrEqual(walkers.filter((w) => w.alpha > 0).length);
        for (const { b, r } of walkBodies) {
          if (b.opts?.flipX === true) {
            leftward++;
            expect(r.name).toBe(`${b.name}-rim-flip`);
            expect(r.opts?.flipX).toBe(true);
          } else {
            rightward++;
            expect(r.name).toBe(`${b.name}-rim`);
            expect(r.opts?.flipX).not.toBe(true);
          }
        }
      }
    }
    expect(leftward).toBeGreaterThan(0);
    expect(rightward).toBeGreaterThan(0);
  });

  test("dance poses are front-facing frames from the dance cycle, never the walk", () => {
    const { dancers, drawn } = frame([]);
    const standing = new Set(dancers.all().filter((d) => d.state === "dance" && Math.abs(d.tx - d.x) <= 10).map((d) => d.pose));
    expect(standing.size).toBeGreaterThan(1);
    expect(standing.has("walk")).toBe(false);
    for (const b of drawn.filter((_, i) => i % 4 === 2)) {
      const [, pose, i] = /^dancer-([a-zA-Z]+)-(\d)$/.exec(b.name)!;
      expect(POSES[pose as keyof typeof POSES]).toBeDefined();
      expect(Number(i)).toBeLessThan(POSES[pose as keyof typeof POSES].length);
    }
  });

  test("bob: 3–9 px × energy on each Dancer's own phase; a Celebration's energy lifts it a little", () => {
    const at = (energy: number): number[] => {
      const dancers = new Dancers(seededRandom(6));
      const ys: number[] = [];
      const rowY = (d: { row: number }): number => DEFAULT_FRAME.horizonY + ROWS[d.row]!.y * (DEFAULT_FRAME.gy - DEFAULT_FRAME.horizonY);
      for (let t = DT; t < 6000; t += DT) {
        dancers.step(DT, t, [], energy);
        const sp = fakeSprites();
        dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], []);
        const sorted = [...dancers.all()].filter((d) => d.alpha > 0).sort((a, b) => a.row - b.row);
        sp.drawn.filter((_, i) => i % 4 === 2).forEach((b, i) => ys.push(rowY(sorted[i]!) - b.y));
      }
      return ys;
    };
    const rest = at(1);
    expect(Math.max(...rest)).toBeLessThanOrEqual(9 * 1.6 + 1e-6); // the bounce pose bobs harder, still under 9 × 1.6
    expect(Math.max(...rest)).toBeGreaterThan(2);
    expect(Math.min(...rest)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...at(1.5))).toBeGreaterThan(Math.max(...rest));
  });

  test("with no sheet the capsule figure is stroked procedurally — no drawImage, round-capped strokes and a head per Dancer", () => {
    const dancers = new Dancers(seededRandom(6));
    run(dancers, 5);
    const { ctx, ops } = recorder();
    dancers.draw(ctx, chrome, DEFAULT_FRAME, null, LEVELS[5], [{ x: 700, colour: "#ff0000" }]);
    expect(ops.some((o) => o.op === "drawImage")).toBe(false);
    expect(ops.filter((o) => o.op === "stroke").length).toBeGreaterThan(dancers.present() * 10);
    expect(ops.filter((o) => o.op === "arc").length).toBeGreaterThanOrEqual(dancers.present());
    expect(ops.some((o) => o.op === "set:lineCap" && o.args[0] === "round")).toBe(true);
  });
});

describe("the figure geometry the frames were baked from", () => {
  test("figure() over every pose frame is finite; assertNoNaN throws on a doctored pose (the legless-Dancer bug)", () => {
    for (const frames of Object.values(POSES)) for (const p of frames) expect(() => assertNoNaN(figure(p))).not.toThrow();
    expect(() => assertNoNaN(figure({ crouch: Number.NaN } as Pose), "doctored")).toThrow(/doctored/);
    expect(() => assertNoNaN(figure({ hip: Number.POSITIVE_INFINITY } as Pose))).toThrow();
    expect(() => new Dancers(seededRandom(1))).not.toThrow(); // the constructor runs the same check over the table
  });
});

describe("sweepPools — where the lit towers' sweeps land, in the tower's colour", () => {
  test("one pool per lit tower at its beam's base, none for an unlit one", () => {
    const towers: Tower[] = createTowers(seededRandom(1));
    towers[0]!.lit = 1;
    towers[3]!.lit = 0.5;
    const f = { t: 1234, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 };
    const pools = sweepPools(chrome, towers, f);
    expect(pools).toHaveLength(2);
    for (const p of pools) {
      expect(p.x).toBeGreaterThanOrEqual(f.sceneL);
      expect(p.x).toBeLessThanOrEqual(f.sceneR);
      expect(p.colour).toBe(chrome.tiers[0]!);
    }
  });
});

describe("Dancers on a shallower floor (overlay.floorPercent): the frame's `scale` shrinks every figure", () => {
  test("scale 0.8 draws the same number of sprites at 0.8 × the k of the same roster at scale 1 (a frame without `scale` is 1)", () => {
    const a = new Dancers(seededRandom(4));
    const b = new Dancers(seededRandom(4));
    const low: DancersFrame = { ...DEFAULT_FRAME, scale: 0.8 };
    a.layout(DEFAULT_FRAME);
    b.layout(low);
    for (let t = DT; t < 3000; t += DT) {
      a.step(DT, t, [], 1);
      b.step(DT, t, [], 1);
    }
    const sa = fakeSprites();
    const sb = fakeSprites();
    a.draw(recorder().ctx, chrome, DEFAULT_FRAME, sa.set, LEVELS[5], []);
    b.draw(recorder().ctx, chrome, low, sb.set, LEVELS[5], []);
    expect(sa.drawn.length).toBeGreaterThan(0);
    expect(sb.drawn).toHaveLength(sa.drawn.length);
    sa.drawn.forEach((d, i) => expect(sb.drawn[i]!.opts?.k).toBeCloseTo((d.opts?.k ?? 1) * 0.8, 9));
  });
});

describe("Moves — every dancer breaks into one at random, on its own beat, eight beats long, never the one it just did", () => {
  /** The sprite-name frame index of every drawn body, keyed by dancer id, in the draw's own order (far row first, stable). */
  function framesByDancer(dancers: Dancers): Map<number, { pose: string; fi: number }> {
    const sp = fakeSprites();
    dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], []);
    const order = [...dancers.all()].filter((d) => d.alpha > 0).sort((a, b) => a.row - b.row);
    const out = new Map<number, { pose: string; fi: number }>();
    sp.drawn.filter((_, i) => i % 4 === 2).forEach((b, i) => {
      const [, pose, fi] = /^dancer-([a-zA-Z]+)-(\d)$/.exec(b.name)!;
      out.set(order[i]!.id, { pose: pose!, fi: Number(fi) });
    });
    return out;
  }

  test("over twenty minutes everyone who stood for four minutes did at least one Move; nobody repeats its previous Move; a Move is one of the four and its body frames are dancer-<move>-[0-3]", () => {
    const dancers = new Dancers(seededRandom(21));
    const stoodS = new Map<number, number>();
    const moves = new Map<number, string[]>();
    const inMove = new Map<number, string>();
    run(dancers, 1200, () => {
      const frames = framesByDancer(dancers);
      for (const d of dancers.all()) {
        if (d.state === "dance") stoodS.set(d.id, (stoodS.get(d.id) ?? 0) + DT / 1000);
        const was = inMove.get(d.id);
        if (d.move !== null && was === undefined) {
          inMove.set(d.id, d.move.name);
          moves.set(d.id, [...(moves.get(d.id) ?? []), d.move.name]);
        } else if (d.move === null && was !== undefined) inMove.delete(d.id);
        if (d.move !== null && d.alpha > 0 && d.state === "dance") {
          expect(MOVES).toContain(d.move.name);
          const f = frames.get(d.id)!;
          expect(f.pose).toBe(d.move.name);
          expect(f.pose).toMatch(/^(carlton|sprinkler|shoppingCart|robot)$/);
          expect(f.fi).toBeLessThan(4);
        }
      }
    });
    let judged = 0;
    for (const [id, s] of stoodS) {
      if (s < 250) continue;
      judged++;
      expect(moves.get(id)?.length ?? 0, `dancer ${id} stood ${s.toFixed(0)} s`).toBeGreaterThanOrEqual(1);
    }
    expect(judged).toBeGreaterThan(10);
    for (const seq of moves.values()) for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  test("a self-started Move lasts eight of the dancer's own beats: the drawn frame index runs 0,1,2,3,0,1,2,3 and the span is 8 × 60 / bpm seconds (twice that on half time); a led Move stops on the very step the leader's stops", () => {
    const dancers = new Dancers(seededRandom(22));
    const spans = new Map<number, { t0: number; fis: number[]; led: boolean; leader: number | null }>();
    let checked = 0;
    let ledChecked = 0;
    run(dancers, 900, (t) => {
      const frames = framesByDancer(dancers);
      const ended = new Set<number>();
      for (const d of dancers.all()) if (spans.has(d.id) && d.move === null) ended.add(d.id);
      for (const d of dancers.all()) {
        const open = spans.get(d.id);
        if (d.move !== null && d.alpha > 0) {
          const fi = frames.get(d.id)!.fi;
          if (open === undefined) spans.set(d.id, { t0: t, fis: [fi], led: d.move.led, leader: d.grp?.m[0]?.id ?? null });
          else {
            if (open.fis[open.fis.length - 1] !== fi) open.fis.push(fi);
            open.led = d.move.led; // a leader's leaving demotes the Move: from then on it runs its own eight beats
            open.leader = d.grp?.m[0]?.id ?? null;
          }
        } else if (open !== undefined && d.move === null) {
          spans.delete(d.id);
          if (d.state !== "dance") continue; // a leaver's Move is cut by the walk: not a full span
          if (open.led) {
            expect(open.leader).not.toBeNull();
            expect(ended.has(open.leader!), `dancer ${d.id}'s led Move ended but its leader's did not end this step`).toBe(true);
            ledChecked++;
            continue;
          }
          expect(open.fis).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
          const expectMs = (8 * 60_000) / d.bpm / (d.half ? 0.5 : 1);
          expect(Math.abs(t - open.t0 - expectMs)).toBeLessThanOrEqual(2 * DT);
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(20);
    expect(ledChecked).toBeGreaterThan(0);
  });

  test("a dancer sliding to a new slot mid-Move is not a walker: walkers() leaves it out and its body is drawn as a Move frame, not a walk frame", () => {
    let seen = 0;
    for (const seed of [2, 5, 7]) {
      const dancers = new Dancers(seededRandom(seed));
      run(dancers, 600, () => {
        const sliders = dancers.all().filter((d) => d.move !== null && d.state === "dance" && Math.abs(d.tx - d.x) > 10);
        if (sliders.length === 0) return;
        const walkers = dancers.walkers();
        const frames = framesByDancer(dancers);
        for (const d of sliders) {
          expect(walkers.some((w) => w.x === d.x && w.tx === d.tx)).toBe(false);
          expect(frames.get(d.id)!.pose).toBe(d.move!.name);
          seen++;
        }
      });
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("group sync: when a leader starts a Move, on some seed a groupmate joins the same Move (led) before the leader ends; loners are never led; a wave and a Move never overlap", () => {
    let led = 0;
    for (const seed of [23, 24, 25, 26]) {
      const dancers = new Dancers(seededRandom(seed));
      run(dancers, 900, () => {
        for (const d of dancers.all()) {
          if (d.move !== null && d.wave > 0) throw new Error(`dancer ${d.id} is mid-Move and mid-wave at once`);
          if (d.move === null || !d.move.led) continue;
          expect(d.grp).not.toBeNull();
          const leader = d.grp!.m[0]!;
          expect(leader).not.toBe(d);
          if (leader.move !== null) {
            expect(leader.move.name).toBe(d.move.name);
            led++;
          }
        }
      }, [700, 1100]); // pools at two x's so groups near them wave along the way
    }
    expect(led).toBeGreaterThan(0);
  });
});

describe("the roster follows the Active Chatters — max(24, chatters) up to the Level's cap, generics thin one for one, the floor cycles above the cap", () => {
  const CFG = { dwellMs: 90_000, nameLength: 12 };
  const chatter = (key: string, lastSeenMs: number): Chatter => ({ key, name: `name_${key}`, avatarUrl: null, firstSeenMs: 0, lastSeenMs });
  /** c1..cN, cN the most recent message. */
  const people = (n: number): Chatter[] => Array.from({ length: n }, (_, i) => chatter(`c${i + 1}`, (i + 1) * 1000));
  /** `sync` then `step` every frame for `seconds` from `fromMs`; returns the clock reached. */
  function runRoster(dancers: Dancers, list: readonly Chatter[], cap: number, seconds: number, fromMs = 0, each: (t: number) => void = () => {}): number {
    let t = fromMs;
    for (let i = 0; i < Math.round((seconds * 1000) / DT); i++) {
      t += DT;
      dancers.sync(list, cap, CFG, t);
      dancers.step(DT, t, [], 1);
      each(t);
    }
    return t;
  }
  const onFloor = (dancers: Dancers) => dancers.all().filter((d) => d.state !== "out");
  const counts = (dancers: Dancers) => ({ chatters: onFloor(dancers).filter((d) => d.kind === "chatter").length, generics: onFloor(dancers).filter((d) => d.kind === "generic").length });
  const keys = (dancers: Dancers) => new Set(onFloor(dancers).filter((d) => d.kind === "chatter").map((d) => d.key));

  test("10 fake chatters at Level 5 (cap 60) → 10 Chatter Dancers + 14 generics; keys never doubled; every chatter placed like a generic (rows, groups) and never in a tower band", () => {
    const dancers = new Dancers(seededRandom(31));
    dancers.layout(DEFAULT_FRAME);
    const b = bases(DEFAULT_FRAME);
    runRoster(dancers, people(10), 60, 60, 0, () => {
      const ks = dancers.all().filter((d) => d.kind === "chatter").map((d) => d.key);
      expect(new Set(ks).size).toBe(ks.length);
      for (const d of dancers.all()) {
        expect(inBand(d.x, towerBands(DEFAULT_FRAME, d.row))).toBe(false);
        expect(inBand(d.x, b)).toBe(false);
      }
    });
    const k = counts(dancers);
    expect(k.chatters).toBe(10);
    expect(k.generics).toBeGreaterThanOrEqual(13); // one generic may be mid-swap (the ambient comings and goings)
    expect(k.generics).toBeLessThanOrEqual(14);
    expect(dancers.present()).toBeLessThanOrEqual(24);
    expect([...keys(dancers)].sort()).toEqual(people(10).map((c) => c.key).sort());
    const rows = new Set(dancers.all().filter((d) => d.kind === "chatter").map((d) => d.row));
    expect(rows.size).toBeGreaterThan(1);
    for (const d of dancers.all()) if (d.kind === "chatter") expect(d.name).toBe(`name_${d.key}`);
  });

  test("30 chatters → 30 + 0, and no generic ever walks on again while they stay", () => {
    const dancers = new Dancers(seededRandom(32));
    const t = runRoster(dancers, people(30), 60, 60);
    expect(counts(dancers)).toEqual({ chatters: 30, generics: 0 });
    runRoster(dancers, people(30), 60, 300, t, () => expect(counts(dancers).generics).toBe(0));
    expect(counts(dancers)).toEqual({ chatters: 30, generics: 0 });
  });

  test("70 chatters at cap 60 → 60 drawn (the 60 most recent), cycling one swap every 90 s: the longest-standing walks off, the waiting person with the most recent message walks on", () => {
    const dancers = new Dancers(seededRandom(33));
    const list = people(70);
    let t = runRoster(dancers, list, 60, 30);
    expect(counts(dancers)).toEqual({ chatters: 60, generics: 0 });
    expect(keys(dancers)).toEqual(new Set(list.slice(10).map((c) => c.key))); // c11..c70; c1..c10 wait
    t = runRoster(dancers, list, 60, 59, t); // 89 s: nobody has cycled yet
    expect(dancers.all().some((d) => d.kind === "chatter" && d.state === "out")).toBe(false);
    t = runRoster(dancers, list, 60, 1.5, t); // 90.5 s: exactly one swap, the leaver still walking off (inspected before any spot's walk to the edge can end)
    const out = dancers.all().filter((d) => d.kind === "chatter" && d.state === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("c70"); // walked on first (the most recent message walks on first), so the longest-standing
    expect(keys(dancers).has("c10")).toBe(true); // the waiter with the most recent message
    expect(counts(dancers).chatters).toBe(60);
    t = runRoster(dancers, list, 60, 88.5, t); // 179 s: still one swap
    expect(keys(dancers).has("c69")).toBe(true);
    t = runRoster(dancers, list, 60, 1.5, t); // 180.5 s: the second swap — c69 goes, and the most recent waiter is now c70 (its message time never changed)
    expect(dancers.all().some((d) => d.key === "c69" && d.state === "out")).toBe(true);
    expect(keys(dancers).has("c70")).toBe(true);
    expect(counts(dancers).chatters).toBe(60);
  });

  test("70 chatters at Level 1 (cap 12) → 12 Chatter Dancers + 12 generics", () => {
    const dancers = new Dancers(seededRandom(34));
    runRoster(dancers, people(70), 12, 60);
    const k = counts(dancers);
    expect(k.chatters).toBe(12);
    expect(k.generics).toBeGreaterThanOrEqual(11);
    expect(k.generics).toBeLessThanOrEqual(12);
    expect(keys(dancers)).toEqual(new Set(people(70).slice(58).map((c) => c.key))); // c59..c70
  });

  test("a lapsed chatter walks off on the next frame and a generic walks on 2–7 s later; a hop from a waiter changes nothing on the floor", () => {
    const dancers = new Dancers(seededRandom(35));
    let t = runRoster(dancers, people(10), 60, 60);
    const before = new Set(dancers.all().map((d) => d.id));
    const nine = people(10).slice(1); // c1 lapsed
    t = runRoster(dancers, nine, 60, 0.1, t);
    expect(dancers.all().find((d) => d.key === "c1")?.state).toBe("out");
    let newcomerAt: number | null = null;
    runRoster(dancers, nine, 60, 8, t, (now) => {
      for (const d of dancers.all()) if (d.kind === "generic" && !before.has(d.id) && newcomerAt === null) newcomerAt = now;
    });
    expect(newcomerAt).not.toBeNull();
    expect(newcomerAt! - t).toBeGreaterThanOrEqual(2000 - DT);
    expect(newcomerAt! - t).toBeLessThanOrEqual(7000 + 2 * DT);
  });

  test("an empty list leaves the floor to 24 generics (the earlier tests' world) and present() still counts everyone not leaving", () => {
    const dancers = new Dancers(seededRandom(7));
    runRoster(dancers, [], 60, 60);
    expect(counts(dancers).chatters).toBe(0);
    expect(dancers.present()).toBeGreaterThanOrEqual(22);
    expect(dancers.present()).toBeLessThanOrEqual(24);
  });
  test("a lower cap sheds the excess at once, longest-standing first (70 at cap 60, then Level 3's cap 40 → 40 + 0 with c51..c70 gone); a cap rise refills from the queue at once, in queue order", () => {
    const dancers = new Dancers(seededRandom(36));
    const list = people(70);
    let t = runRoster(dancers, list, 60, 30);
    expect(counts(dancers)).toEqual({ chatters: 60, generics: 0 });
    const cap3 = LEVELS[3].chatters;
    expect(cap3).toBe(40);
    t = runRoster(dancers, list, cap3, 0.1, t); // the next frame: the 20 earliest walked-on are already leaving
    const out = dancers.all().filter((d) => d.kind === "chatter" && d.state === "out").map((d) => d.key);
    expect(new Set(out)).toEqual(new Set(list.slice(50).map((c) => c.key))); // c51..c70 walked on first (the most recent message walks on first)
    expect(counts(dancers)).toEqual({ chatters: 40, generics: 0 });
    t = runRoster(dancers, list, cap3, 45, t, () => { // to 75 s: inside the dwell armed at ~90 s when the floor first filled with people waiting
      expect(counts(dancers).chatters).toBeLessThanOrEqual(40);
      expect(counts(dancers).generics).toBe(0);
      expect(dancers.present()).toBeLessThanOrEqual(60);
    });
    expect(dancers.present()).toBe(40);
    expect(keys(dancers)).toEqual(new Set(list.slice(10, 50).map((c) => c.key))); // c11..c50
    t = runRoster(dancers, list, 60, 0.1, t); // back to cap 60: the floor is not full, so the queue's first 20 walk on at once
    expect(counts(dancers)).toEqual({ chatters: 60, generics: 0 });
    expect(keys(dancers)).toEqual(new Set(list.slice(10).map((c) => c.key))); // c51..c70 came back (most recent messages); c1..c10 still wait
  });
  test("the dwell keeps running through a lapse and its refill: 70 at cap 60 with someone lapsing every 20 s (and a newcomer taking the seat), the longest-standing still walks off by the dwell within 90–110 s of the first full floor", () => {
    const dancers = new Dancers(seededRandom(37));
    let list = people(70);
    let t = runRoster(dancers, list, 60, 1); // the floor is full from the first frame; c70 walked on first (lowest id) and is never dropped from the list
    expect(counts(dancers)).toEqual({ chatters: 60, generics: 0 });
    let swapAt: number | null = null;
    let extra = 0;
    for (let k = 0; k < 6 && swapAt === null; k++) {
      const victim = onFloor(dancers).find((d) => d.kind === "chatter" && d.key !== "c70" && list.some((c) => c.key === d.key))!;
      list = [...list.filter((c) => c.key !== victim.key), chatter(`n${++extra}`, t)]; // one lapse, one new person (the most recent message) so the queue never empties
      t = runRoster(dancers, list, 60, 20, t, (now) => {
        if (swapAt === null && dancers.all().some((d) => d.key === "c70" && d.state === "out")) swapAt = now;
      });
    }
    expect(list.some((c) => c.key === "c70")).toBe(true); // still listed: c70 left by the dwell, not by a lapse
    expect(swapAt).not.toBeNull();
    expect(swapAt!).toBeGreaterThanOrEqual(90_000);
    expect(swapAt!).toBeLessThanOrEqual(110_000);
  });

  test("a bulk shed backfills the generics at once: 70 settled at cap 60 (0 generics), then cap 12 (Level 1) → within 10 s the floor is 12 chatters + 12 generics, all walked in, staggered, never inside a tower band", () => {
    const dancers = new Dancers(seededRandom(38));
    dancers.layout(DEFAULT_FRAME);
    const b = bases(DEFAULT_FRAME);
    const list = people(70);
    let t = runRoster(dancers, list, 60, 30);
    expect(counts(dancers)).toEqual({ chatters: 60, generics: 0 });
    const before = new Set(dancers.all().map((d) => d.id));
    const arrived = new Map<number, number>();
    t = runRoster(dancers, list, 12, 10, t, (now) => {
      expect(counts(dancers).chatters).toBe(12);
      for (const d of dancers.all()) {
        if (d.kind === "generic" && !before.has(d.id) && !arrived.has(d.id)) arrived.set(d.id, now);
        expect(inBand(d.x, towerBands(DEFAULT_FRAME, d.row))).toBe(false);
        expect(inBand(d.x, b)).toBe(false);
      }
    });
    expect(arrived.size).toBeGreaterThanOrEqual(12);
    expect(new Set(arrived.values()).size).toBeGreaterThan(1); // staggered, not a crowd on one frame
    const k = counts(dancers);
    expect(k.chatters).toBe(12);
    expect(k.generics).toBeGreaterThanOrEqual(11); // one may be mid-swap (the ambient comings and goings)
    expect(k.generics).toBeLessThanOrEqual(12);
  });

  test("a mass lapse backfills the generics at once: 40 chatters at cap 60 (0 generics), the list drops to 3 in one call → within 10 s the floor is 3 chatters + 21 generics", () => {
    const dancers = new Dancers(seededRandom(39));
    let t = runRoster(dancers, people(40), 60, 30);
    expect(counts(dancers)).toEqual({ chatters: 40, generics: 0 });
    const before = new Set(dancers.all().map((d) => d.id));
    const arrived = new Map<number, number>();
    t = runRoster(dancers, people(3), 60, 10, t, (now) => {
      expect(counts(dancers).chatters).toBe(3);
      expect(dancers.present()).toBeLessThanOrEqual(24 + 37); // the 37 leavers count until they are off the edge; never more than the roster on top
      for (const d of dancers.all()) if (d.kind === "generic" && !before.has(d.id) && !arrived.has(d.id)) arrived.set(d.id, now);
    });
    expect(arrived.size).toBeGreaterThanOrEqual(21);
    expect(new Set(arrived.values()).size).toBeGreaterThan(1);
    const k = counts(dancers);
    expect(k.chatters).toBe(3);
    expect(k.generics).toBeGreaterThanOrEqual(20);
    expect(k.generics).toBeLessThanOrEqual(21);
  });
});

describe("Chatter Dancers — the Avatar Picture as a bobblehead, a rim-tint ring (never the Mote Ring), the name label", () => {
  const CFG = { dwellMs: 90_000, nameLength: 12 };
  const chatter = (key: string, name: string, avatarUrl: string | null = "https://example.test/pic.png"): Chatter => ({ key, name, avatarUrl, firstSeenMs: 0, lastSeenMs: 1 });
  const IMG = {} as CanvasImageSource;
  /** Settle `list` on the floor for `seconds` (sync + step each frame) and return the clock. */
  function settle(dancers: Dancers, list: readonly Chatter[], seconds: number): number {
    let t = 0;
    for (let i = 0; i < Math.round((seconds * 1000) / DT); i++) {
      t += DT;
      dancers.sync(list, 60, CFG, t);
      dancers.step(DT, t, [], 1);
    }
    return t;
  }
  function frame(dancers: Dancers, image: (url: string | null) => CanvasImageSource | null, sweeps: ReadonlyArray<{ x: number; colour: string }> = [{ x: 800, colour: "#ff0000" }]) {
    const { ctx, ops } = recorder();
    const sp = fakeSprites();
    dancers.draw(ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], sweeps, image);
    return { ops, drawn: sp.drawn };
  }

  test("one head per Chatter Dancer: an arc clip and a drawImage with the picture, a stroked ring in the rim colour, no mote-ring sprite, no filter or shadow", () => {
    const dancers = new Dancers(seededRandom(41));
    settle(dancers, [chatter("a", "alice"), chatter("b", "bob")], 30);
    const shown = dancers.all().filter((d) => d.alpha > 0);
    const chatters = shown.filter((d) => d.kind === "chatter").length;
    expect(chatters).toBe(2);
    const { ops, drawn } = frame(dancers, () => IMG);
    expect(ops.filter((o) => o.op === "clip")).toHaveLength(2);
    expect(ops.filter((o) => o.op === "drawImage")).toHaveLength(shown.length * 4 + 2); // four sprite draws per dancer + one picture per chatter
    const strokes = ops.filter((o) => o.op === "stroke");
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      const i = ops.indexOf(s);
      const style = ops.slice(0, i).reverse().find((o) => o.op === "set:strokeStyle");
      expect(style?.args[0]).toBe("#ff0000");
      expect(ops.slice(0, i).reverse().find((o) => o.op === "set:lineWidth")?.args[0]).toBe(2);
    }
    expect(drawn.some((d) => d.name.startsWith("mote-ring"))).toBe(false);
    expect(drawn.filter((_, i) => i % 4 === 2)).toHaveLength(shown.length); // the bodies are untouched: still one per dancer
    expect(ops.map((o) => o.op)).not.toContain("set:filter");
    expect(ops.map((o) => o.op)).not.toContain("set:shadowBlur");
  });

  test("the Avatar Glyph while the picture is null: the theme's glyph for the name through glyph() (a fillText), no clip", () => {
    const dancers = new Dancers(seededRandom(42));
    settle(dancers, [chatter("a", "alice", null)], 30);
    const { ops } = frame(dancers, () => null);
    expect(ops.filter((o) => o.op === "clip")).toHaveLength(0);
    const texts = ops.filter((o) => o.op === "fillText").map((o) => o.args[0]);
    expect(avatarFor("alice", chrome)).not.toBe(""); // chrome-lounge has eight avatars
    expect(texts).toContain(avatarFor("alice", chrome));
    expect(chrome.avatars).toContain(avatarFor("alice", chrome));
  });

  test("the bobblehead: the head's diameter is max(the figure's own head at this row and scale, 24 px) — 24 on the far row at floorK 0.6, larger than the figure's head on the near row at floorK 1", () => {
    const dancers = new Dancers(seededRandom(43));
    settle(dancers, [chatter("a", "alice")], 30);
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    const { ops } = frame(dancers, () => IMG);
    const pic = ops.find((o) => o.op === "drawImage" && o.args.length === 5)!; // (img, x, y, w, h): the picture; sprite draws are 3-arg
    const w = pic.args[3] as number;
    const k = ROWS[d.row]!.s * d.sz;
    expect(w).toBeCloseTo(Math.max(2 * 11.5 * k, 24), 6);
    expect(w).toBeGreaterThanOrEqual(24);
  });

  test("the label: the name cut to nameLength with an ellipsis, white on a panel plate above the head, for 4 s after a hop and otherwise once every 30–60 s", () => {
    expect(shortName("averyveryverylongname", 12)).toBe("averyveryve…");
    expect(shortName("bob", 12)).toBe("bob");
    expect(shortName("exactlytwelv", 12)).toBe("exactlytwelv");
    const dancers = new Dancers(seededRandom(44));
    const t0 = settle(dancers, [chatter("a", "averyveryverylongname")], 30);
    const names = (t: number): string[] => {
      dancers.sync([chatter("a", "averyveryverylongname")], 60, CFG, t);
      dancers.step(DT, t, [], 1);
      return frame(dancers, () => IMG).ops.filter((o) => o.op === "fillText").map((o) => o.args[0] as string);
    };
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    d.labelUntil = 0; // whatever the stagger dealt, start hidden
    d.nextLabelS = 600;
    expect(names(t0 + DT)).not.toContain("averyveryve…");
    dancers.hop("a", t0 + DT);
    expect(names(t0 + 2 * DT)).toContain("averyveryve…");
    expect(names(t0 + 3900)).toContain("averyveryve…");
    expect(names(t0 + 4100)).not.toContain("averyveryve…");
    // unprompted: the stagger timer shows it again within 30–60 s
    d.nextLabelS = 30;
    let shownAt: number | null = null;
    for (let t = t0 + 4200; t < t0 + 70_000 && shownAt === null; t += DT) if (names(t).includes("averyveryve…")) shownAt = t;
    expect(shownAt).not.toBeNull();
    expect(shownAt! - (t0 + 4200)).toBeGreaterThanOrEqual(30_000 - 2 * DT);
    expect(shownAt! - (t0 + 4200)).toBeLessThanOrEqual(30_000 + 2 * DT);
    const plate = frame(dancers, () => IMG).ops;
    const fill = plate.findIndex((o) => o.op === "fillText" && o.args[0] === "averyveryve…");
    const before = plate.slice(0, fill).map((o) => o.op);
    expect(before.slice(-8)).toContain("arcTo"); // roundRect's plate right before the text
    expect(plate.slice(0, fill).reverse().find((o) => o.op === "set:fillStyle")?.args[0]).toBe("#fff");
    expect(plate.slice(0, fill).reverse().find((o) => o.op === "set:font")?.args[0]).toBe("600 11px system-ui, sans-serif");
  });

  test("the label: the name cut to nameLength with an ellipsis, white on a panel plate above the head, while labelUntil (the field a hop sets) is ahead of the clock and otherwise once every 30–60 s", () => {
    expect(shortName("averyveryverylongname", 12)).toBe("averyveryve…");
    expect(shortName("bob", 12)).toBe("bob");
    expect(shortName("exactlytwelv", 12)).toBe("exactlytwelv");
    const dancers = new Dancers(seededRandom(44));
    const t0 = settle(dancers, [chatter("a", "averyveryverylongname")], 30);
    const names = (t: number): string[] => {
      dancers.sync([chatter("a", "averyveryverylongname")], 60, CFG, t);
      dancers.step(DT, t, [], 1);
      return frame(dancers, () => IMG).ops.filter((o) => o.op === "fillText").map((o) => o.args[0] as string);
    };
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    d.labelUntil = 0; // whatever the stagger dealt, start hidden
    d.nextLabelS = 600;
    expect(names(t0 + DT)).not.toContain("averyveryve…");
    d.labelUntil = t0 + DT + 4000; // what a hop at t0 + DT will set: 4 s from the hop
    expect(names(t0 + 2 * DT)).toContain("averyveryve…");
    expect(names(t0 + 3900)).toContain("averyveryve…");
    expect(names(t0 + 4100)).not.toContain("averyveryve…");
    // unprompted: the stagger timer shows it again within 30–60 s
    d.nextLabelS = 30;
    let shownAt: number | null = null;
    for (let t = t0 + 4200; t < t0 + 70_000 && shownAt === null; t += DT) if (names(t).includes("averyveryve…")) shownAt = t;
    expect(shownAt).not.toBeNull();
    expect(shownAt! - (t0 + 4200)).toBeGreaterThanOrEqual(30_000 - 2 * DT);
    expect(shownAt! - (t0 + 4200)).toBeLessThanOrEqual(30_000 + 2 * DT);
    const plate = frame(dancers, () => IMG).ops;
    const fill = plate.findIndex((o) => o.op === "fillText" && o.args[0] === "averyveryve…");
    const before = plate.slice(0, fill).map((o) => o.op);
    expect(before.slice(-8)).toContain("arcTo"); // roundRect's plate right before the text
    expect(plate.slice(0, fill).reverse().find((o) => o.op === "set:fillStyle")?.args[0]).toBe("#fff");
    expect(plate.slice(0, fill).reverse().find((o) => o.op === "set:font")?.args[0]).toBe("600 11px system-ui, sans-serif");
  });

  test("two labels that would overlap (two chatters forced onto one spot) → only one name is drawn that frame", () => {
    const dancers = new Dancers(seededRandom(45));
    const t0 = settle(dancers, [chatter("a", "alice"), chatter("b", "bob")], 30);
    const [A, B] = dancers.all().filter((x) => x.kind === "chatter");
    for (const d of [A!, B!]) {
      d.row = 2;
      d.x = d.tx = d.base = 900;
      d.amp = 0;
      d.grp = null;
    }
    dancers.hop("a", t0);
    dancers.hop("b", t0);
    dancers.step(DT, t0 + DT, [], 1);
    const texts = frame(dancers, () => IMG).ops.filter((o) => o.op === "fillText").map((o) => o.args[0]);
    expect(texts.filter((t) => t === "alice" || t === "bob")).toHaveLength(1);
  });

  test("two labels that would overlap (two chatters forced onto one spot, both with labelUntil ahead of the clock) → only one name is drawn that frame", () => {
    const dancers = new Dancers(seededRandom(45));
    const t0 = settle(dancers, [chatter("a", "alice"), chatter("b", "bob")], 30);
    const [A, B] = dancers.all().filter((x) => x.kind === "chatter");
    for (const d of [A!, B!]) {
      d.row = 2;
      d.x = d.tx = d.base = 900;
      d.amp = 0;
      d.grp = null;
      d.labelUntil = t0 + 4000; // what a hop at t0 will set
    }
    dancers.step(DT, t0 + DT, [], 1);
    const texts = frame(dancers, () => IMG).ops.filter((o) => o.op === "fillText").map((o) => o.args[0]);
    expect(texts.filter((t) => t === "alice" || t === "bob")).toHaveLength(1);
  });
});

describe("Hop — a standing Chatter Dancer jumps ~30 px × row scale × floorK in half a second; one queued at most; walkers ignore it", () => {
  const CFG = { dwellMs: 90_000, nameLength: 12 };
  const one = (): Chatter => ({ key: "h", name: "hopper", avatarUrl: null, firstSeenMs: 0, lastSeenMs: 1 });
  const rowLine = (d: { row: number }): number => DEFAULT_FRAME.horizonY + ROWS[d.row]!.y * (DEFAULT_FRAME.gy - DEFAULT_FRAME.horizonY);
  /** The drawn body's lift over its row line, energy 0 (no bob): the hop alone. */
  function lift(dancers: Dancers, d: Dancer): { y: number; name: string } {
    const sp = fakeSprites();
    dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sp.set, LEVELS[5], []);
    const order = [...dancers.all()].filter((x) => x.alpha > 0).sort((a, b) => a.row - b.row);
    const body = sp.drawn.filter((_, i) => i % 4 === 2)[order.indexOf(d)]!;
    return { y: rowLine(d) - body.y, name: body.name };
  }
  function settle(dancers: Dancers, seconds: number, from = 0): number {
    let t = from;
    for (let i = 0; i < Math.round((seconds * 1000) / DT); i++) {
      t += DT;
      dancers.sync([one()], 60, CFG, t);
      dancers.step(DT, t, [], 0);
    }
    return t;
  }

  test("five hops in 0.4 s → one plays and one is queued (two lifts, never higher than one hop); five hops 0.6 s apart → five separate lifts", () => {
    const dancers = new Dancers(seededRandom(51));
    let t = settle(dancers, 25);
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    expect(d.state).toBe("dance");
    expect(Math.abs(d.tx - d.x)).toBeLessThanOrEqual(10);
    const max = 30 * ROWS[d.row]!.s;
    const rises = (hopAt: number[], untilMs: number): number => {
      let n = 0;
      let up = false;
      for (let now = t + DT; now <= t + untilMs; now += DT) {
        if (hopAt.some((h) => Math.abs(t + h + DT - now) < DT / 2)) dancers.hop("h", now); // a hop due at h fires on the first frame after it (the loop's first frame is t + DT, so h = 0 would never match unshifted)
        dancers.sync([one()], 60, CFG, now);
        dancers.step(DT, now, [], 0);
        const { y } = lift(dancers, d);
        expect(y).toBeLessThanOrEqual(max + 1e-6);
        expect(y).toBeGreaterThanOrEqual(-1e-6);
        if (y > 0.5 && !up) n++;
        up = y > 0.5;
      }
      t += untilMs;
      return n;
    };
    expect(rises([0, 100, 200, 300, 400], 3000)).toBe(2);
    expect(rises([0, 600, 1200, 1800, 2400], 4000)).toBe(5);
    expect(lift(dancers, d).y).toBe(0);
  });

  test("takeoff and landing use the bounce crouch frame, the air the straight one; a hop mid-Move keeps the Move's frames; a hop reaches ~30 × 0.62 at the near row", () => {
    const dancers = new Dancers(seededRandom(52));
    let t = settle(dancers, 25);
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    d.row = 2;
    d.grp = null;
    d.x = d.tx = d.base = 900;
    d.amp = 0;
    dancers.hop("h", t);
    const names: string[] = [];
    let peak = 0;
    for (let now = t + DT; now <= t + 500; now += DT) {
      dancers.sync([one()], 60, CFG, now);
      dancers.step(DT, now, [], 0);
      const l = lift(dancers, d);
      names.push(l.name);
      peak = Math.max(peak, l.y);
    }
    expect(names[0]).toBe("dancer-bounce-1");
    expect(names[Math.floor(names.length / 2)]).toBe("dancer-bounce-0");
    expect(names[names.length - 2]).toBe("dancer-bounce-1");
    expect(peak).toBeGreaterThan(30 * 0.62 * 0.9);
    expect(peak).toBeLessThanOrEqual(30 * 0.62 + 1e-6);
    t += 500 + DT;
    // mid-Move: force a Move and hop
    d.move = { name: "robot", beat0: d.beat, led: false };
    dancers.hop("h", t);
    for (let now = t + DT; now <= t + 400; now += DT) {
      dancers.sync([one()], 60, CFG, now);
      dancers.step(DT, now, [], 0);
      const l = lift(dancers, d);
      expect(l.name).toMatch(/^dancer-robot-[0-3]$/);
      if (now > t + 150 && now < t + 350) expect(l.y).toBeGreaterThan(0);
    }
  });

  test("a walker's hop is a no-op, an unknown key is ignored, and the hop scales with the frame's floorK", () => {
    const dancers = new Dancers(seededRandom(53));
    let t = DT;
    dancers.sync([one()], 60, CFG, t);
    dancers.step(DT, t, [], 0);
    const d = dancers.all().find((x) => x.kind === "chatter")!;
    expect(d.state).toBe("in");
    dancers.hop("h", t);
    dancers.hop("nobody", t);
    expect(d.hop).toBeNull();
    expect(d.hopQueued).toBe(false);
    t = settle(dancers, 25, t);
    dancers.hop("h", t);
    dancers.step(DT, t + 250, [], 0);
    const sa = fakeSprites();
    const sb = fakeSprites();
    dancers.draw(recorder().ctx, chrome, DEFAULT_FRAME, sa.set, LEVELS[5], []);
    dancers.draw(recorder().ctx, chrome, { ...DEFAULT_FRAME, scale: 0.5 }, sb.set, LEVELS[5], []);
    const order = [...dancers.all()].filter((x) => x.alpha > 0).sort((a, b) => a.row - b.row);
    const i = order.indexOf(d);
    const ya = rowLine(d) - sa.drawn.filter((_, j) => j % 4 === 2)[i]!.y;
    const yb = rowLine(d) - sb.drawn.filter((_, j) => j % 4 === 2)[i]!.y;
    expect(ya).toBeGreaterThan(0);
    expect(yb).toBeCloseTo(ya * 0.5, 6);
  });
});

import { describe, expect, test } from "bun:test";
import { LEVELS } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { defaultConfig } from "../../config/schema.ts";
import { CLUB_TOWER_CAP, CLUB_TOWER_FOOT, beamAim, clubTowerBodyTop, clubTowerTop, createTowers, drawLasers, laserFans, pickAim, sheetTowerX, stepTowers, sweepPlacement, towerColour, towerHead, towerHeightAtHorizon, towerX } from "./towers.ts";
import { seededRandom } from "./util.ts";

describe("createTowers — six spotlights, three a side, one per tier, tallest outside", () => {
  test("the shape of the set", () => {
    const towers = createTowers(seededRandom(7));
    expect(towers).toHaveLength(6);
    expect(towers.map((T) => [T.sideI, T.tier])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    expect(towers.map((T) => T.height)).toEqual([270, 210, 150, 270, 210, 150]); // tier 0 stands outside and tallest
    expect(towers.map((T) => T.dirC)).toEqual([1, 1, 1, -1, -1, -1]); // each side's beams cross toward the other
  });

  test("never in sync: every tower gets its own easing rate, wobble period and phase", () => {
    const towers = createTowers(seededRandom(7));
    const distinct = (xs: number[]): number => new Set(xs).size;
    expect(distinct(towers.map((T) => T.rate))).toBe(6);
    expect(distinct(towers.map((T) => T.wobP))).toBe(6);
    expect(distinct(towers.map((T) => T.wobPh))).toBe(6);
    for (const T of towers) {
      expect(T.rate).toBeGreaterThanOrEqual(0.012);
      expect(T.rate).toBeLessThanOrEqual(0.034);
      expect(T.wobP).toBeGreaterThanOrEqual(2200);
      expect(T.wobP).toBeLessThanOrEqual(5200);
    }
  });

  test("towerX: side 0 counts in from the scene's left edge, side 1 from its right, 44 px apart, 26 px wide", () => {
    const towers = createTowers(seededRandom(1));
    expect(towers.map((T) => towerX(T, 40, 1480))).toEqual([40, 84, 128, 1454, 1410, 1366]);
  });
});

describe("pickAim — own side 12–30 %, mid-floor 30–75 %, far sweep 75–100 %", () => {
  test("the three ranges, by the first draw; the second draw places the aim inside the range", () => {
    expect(pickAim(0, 0)).toBeCloseTo(0.12, 9);
    expect(pickAim(0.2199, 1)).toBeCloseTo(0.3, 9);
    expect(pickAim(0.22, 0)).toBeCloseTo(0.3, 9);
    expect(pickAim(0.5, 1)).toBeCloseTo(0.75, 9);
    expect(pickAim(0.75, 0)).toBeCloseTo(0.75, 9);
    expect(pickAim(0.99, 1)).toBeCloseTo(1, 9);
  });
});

describe("stepTowers — lit follows the open tier; the aim and brightness walk on the loop clock", () => {
  test("only towers of open tiers light up, eased in", () => {
    const towers = createTowers(seededRandom(3));
    stepTowers(towers, 0, 1, 0, seededRandom(3));
    expect(towers.map((T) => T.lit > 0)).toEqual([true, false, false, true, false, false]);
    for (let i = 0; i < 300; i++) stepTowers(towers, i * 16, 1, 1, seededRandom(3));
    expect(towers[0]!.lit).toBeCloseTo(1, 2);
    expect(towers[1]!.lit).toBeCloseTo(1, 2);
    expect(towers[2]!.lit).toBe(0);
  });

  test("a lit tower re-picks its aim when its timer runs out, 1.5–4.7 s later, and eases toward it at its own rate", () => {
    const towers = createTowers(seededRandom(11));
    const T = towers[0]!;
    const rng = seededRandom(5);
    stepTowers(towers, 0, 1, 0, rng);
    const first = T.aimTarget;
    const due = T.aimT;
    expect(due).toBeGreaterThanOrEqual(1500);
    expect(due).toBeLessThanOrEqual(4700);
    stepTowers(towers, due - 1, 1, 0, rng);
    expect(T.aimTarget).toBe(first);
    stepTowers(towers, due + 1, 1, 0, rng);
    expect(T.aimT).toBeGreaterThan(due + 1);
    const before = T.aim;
    stepTowers(towers, due + 17, 1, 0, rng);
    expect(Math.sign(T.aim - before)).toBe(Math.sign(T.aimTarget - before));
    expect(T.br).toBeGreaterThan(0);
    expect(T.br).toBeLessThanOrEqual(1);
  });

  test("beamAim: reach along the floor from the lamp, wobbled, clamped to 8–100 % and to the scene's inner edges", () => {
    const towers = createTowers(seededRandom(2));
    const T = towers[0]!;
    T.aim = 0.5;
    T.wobPh = 0;
    const ex = beamAim(T, 0, 1000, 60, 1000, 100);
    expect(ex).toBeCloseTo(60 + 500, 9); // side 0 aims rightwards from sx = 60
    T.aim = 2;
    expect(beamAim(T, 0, 1000, 60, 1000, 100)).toBe(1000 - 20); // capped at the far inner edge
    towers[3]!.aim = 0.5;
    towers[3]!.wobPh = 0;
    expect(beamAim(towers[3]!, 0, 1000, 1040, 1000, 100)).toBeCloseTo(1040 - 500, 9); // side 1 aims leftwards
  });
});

describe("sweepPlacement — the wedge hangs from a rig above the frame and lands on the floor", () => {
  test("apex above the top edge at the fixture's x; base on gy across toward the centre; wider at the base; scale = beam length / the 640 px frame", () => {
    const towers = createTowers(seededRandom(2));
    const f = { t: 0, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 };
    for (const T of towers) {
      T.aim = 0.5;
      T.wobPh = 0;
      const p = sweepPlacement(T, f);
      expect(p.apex.y).toBeLessThan(0);
      expect(p.apex.x).toBe(sheetTowerX(T, f) + 13);
      expect(p.base.y).toBe(968);
      expect(p.baseHalfWidth).toBeGreaterThan(p.apexHalfWidth);
      expect(Math.sign(p.base.x - p.apex.x)).toBe(T.dirC); // leans across the floor, never back out of the frame
      expect(Math.sign(p.angle)).toBe(-T.dirC); // canvas rotation: negative leans the hanging wedge rightwards
      expect(p.k).toBeCloseTo(Math.hypot(p.base.x - p.apex.x, p.base.y - p.apex.y) / 640, 9);
      expect(p.k).toBeGreaterThan(1.4);
    }
  });

  test("on the sheet the towers stand 4.5 / 13.5 / 22.5 % of the scene width in from their edge, 210 / 150 / 100 px tall at 1080p, scaled by the height", () => {
    const towers = createTowers(seededRandom(2));
    const f = { sceneL: 40, sceneR: 1510 }; // 1470 wide
    const centres = towers.map((T) => sheetTowerX(T, f) + 13);
    const want = [40 + 0.045 * 1470, 40 + 0.135 * 1470, 40 + 0.225 * 1470, 1510 - 0.045 * 1470, 1510 - 0.135 * 1470, 1510 - 0.225 * 1470];
    centres.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 9));
    expect(towers.map((T) => towerHeightAtHorizon(T, 1080))).toEqual([210, 150, 100, 210, 150, 100]);
    towers.map((T) => towerHeightAtHorizon(T, 1440)).forEach((h, i) => expect(h).toBeCloseTo([280, 200, 400 / 3][i % 3]!, 9));
    expect(towerX(towers[1]!, 40, 1510)).toBe(84); // the club-deck keeps its 44 px spacing
  });

  test("idle laser strokes on the sheet are 300–1140 px long at 1080p (five per lit head, each longer than the last), scaled by the height", () => {
    const towers = createTowers(seededRandom(2));
    towers[0]!.lit = 1;
    const segs: Array<[number, number, number, number]> = [];
    let from: [number, number] = [0, 0];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : (...args: unknown[]) => {
              if (key === "moveTo") from = [args[0] as number, args[1] as number];
              if (key === "lineTo") segs.push([from[0], from[1], args[0] as number, args[1] as number]);
            },
      set(target, key: string, value) {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: () => {} } as unknown as SpriteSet;
    const theme = defaultConfig().themes["chrome-lounge"]!;
    drawLasers(ctx, theme, towers, 0, { t: 0, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 }, sprites, LEVELS[5]);
    const lengths = segs.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
    expect(lengths).toHaveLength(5);
    lengths.forEach((l, j) => expect(l).toBeCloseTo(300 + 210 * j, 6));
    expect(segs.every(([x0]) => Math.abs(x0 - (sheetTowerX(towers[0]!, { sceneL: 40, sceneR: 1510 }) + 13)) < 1e-9)).toBe(true); // from the head at the sheet x
    segs.length = 0;
    drawLasers(ctx, theme, towers, 0, { t: 0, gy: 1290, sceneL: 40, sceneR: 2150, horizonY: (640 * 1440) / 1080, height: 1440 }, sprites, LEVELS[5]); // the boards' horizon at 1440: the floor's depth scales with the height
    expect(Math.hypot(segs[0]![2] - segs[0]![0], segs[0]![3] - segs[0]![1])).toBeCloseTo(400, 6);
  });

  test("laserFans is the geometry drawLasers strokes (the light layer wraps the same ends), from the head towerHead names, alternating the tower's tint and the accent", () => {
    const towers = createTowers(seededRandom(2));
    towers[0]!.lit = 1;
    towers[3]!.lit = 0.5;
    const segs: Array<[number, number, number, number]> = [];
    let from: [number, number] = [0, 0];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : (...args: unknown[]) => {
              if (key === "moveTo") from = [args[0] as number, args[1] as number];
              if (key === "lineTo") segs.push([from[0], from[1], args[0] as number, args[1] as number]);
            },
      set(target, key: string, value) {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: () => {} } as unknown as SpriteSet;
    const theme = defaultConfig().themes["chrome-lounge"]!;
    const f = { t: 1234, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 };
    drawLasers(ctx, theme, towers, 0.6, f, sprites, LEVELS[5]);
    const fans = laserFans(theme, towers, 0.6, f);
    expect(fans.map((fan) => fan.T)).toEqual([towers[0]!, towers[3]!]);
    const want = fans.flatMap((fan) => fan.strokes.map((s) => [fan.cx, fan.hy, fan.cx + s.dx * s.len, fan.hy + s.dy * s.len]));
    expect(segs).toHaveLength(want.length);
    segs.forEach((seg, i) => seg.forEach((v, j) => expect(v).toBeCloseTo(want[i]![j]!, 9)));
    for (const fan of fans) {
      expect(towerHead(fan.T, f)).toEqual({ x: fan.cx, y: fan.hy });
      expect(fan.strokes.map((s) => s.colour)).toEqual([towerColour(theme, fan.T, towers.indexOf(fan.T)), theme.accent, towerColour(theme, fan.T, towers.indexOf(fan.T)), theme.accent, towerColour(theme, fan.T, towers.indexOf(fan.T))]);
    }
    expect(fans[0]!.alpha).toBeCloseTo(0.22 + 0.5 * 0.6, 9); // the idle floor plus the celebration, times lit
    expect(fans[1]!.alpha).toBeCloseTo((0.22 + 0.5 * 0.6) * 0.5, 9);
  });
});

describe("club-deck tower geometry — one place says where a tower's top is (scene.ts's firework band reads it from here)", () => {
  test("the body stands CLUB_TOWER_FOOT under the ground line; the cap sits CLUB_TOWER_CAP above the body's top", () => {
    expect(CLUB_TOWER_FOOT).toBe(40);
    expect(CLUB_TOWER_CAP).toBe(12);
    const [tallest] = createTowers(seededRandom(7));
    expect(tallest!.height).toBe(270);
    expect(clubTowerBodyTop(tallest!, 900)).toBe(900 + 40 - 270);
    expect(clubTowerTop(tallest!, 900)).toBe(900 + 40 - 270 - 12);
    expect(clubTowerTop(tallest!, 900)).toBe(clubTowerBodyTop(tallest!, 900) - CLUB_TOWER_CAP);
  });
});

describe("the towers on a shallower floor (overlay.floorPercent): heights and laser lengths scale with the floor's depth, not the frame alone", () => {
  test("towerHeightAtHorizon's third argument is the horizon: the boards' 210 / 150 / 100 at 640 of 1080, 356.4 / 440 of that at 723.6; towerHead follows", () => {
    const towers = createTowers(seededRandom(2));
    expect(towers.map((T) => towerHeightAtHorizon(T, 1080, 640))).toEqual([210, 150, 100, 210, 150, 100]);
    towers.map((T) => towerHeightAtHorizon(T, 1080, 723.6)).forEach((h, i) => expect(h).toBeCloseTo([210, 150, 100][i % 3]! * (356.4 / 440), 9));
    const tall = towerHead(towers[0]!, { sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 });
    const low = towerHead(towers[0]!, { sceneL: 40, sceneR: 1510, horizonY: 723.6, height: 1080 });
    expect(low.x).toBe(tall.x);
    expect(low.y).toBeCloseTo(tall.y + (723.6 - 640) + 210 * (1 - 356.4 / 440), 9);
  });

  test("laserFans: every stroke 356.4 / 440 as long on a 33 % floor, the same angles and colours", () => {
    const towers = createTowers(seededRandom(2));
    towers[0]!.lit = 1;
    towers[3]!.lit = 0.5;
    const theme = defaultConfig().themes["chrome-lounge"]!;
    const tall = laserFans(theme, towers, 0.6, { t: 1234, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 640, height: 1080 });
    const low = laserFans(theme, towers, 0.6, { t: 1234, gy: 968, sceneL: 40, sceneR: 1510, horizonY: 723.6, height: 1080 });
    expect(low).toHaveLength(tall.length);
    tall.forEach((fan, i) => {
      expect(low[i]!.strokes).toHaveLength(fan.strokes.length);
      fan.strokes.forEach((s, j) => {
        const l = low[i]!.strokes[j]!;
        expect(l.len).toBeCloseTo(s.len * (356.4 / 440), 9);
        expect([l.dx, l.dy, l.colour]).toEqual([s.dx, s.dy, s.colour]);
      });
    });
  });
});

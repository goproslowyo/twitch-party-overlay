import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/schema.ts";
import { LEVELS } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import type { Chatter } from "../../server/overlay.ts";
import { fnv1a } from "../theme.ts";
import { CLUB_HEAD_R, CLUB_HOP_MS, CLUB_HOP_PX, CLUB_LABEL_MS, CROWD_SIZE, CUE_HOLD_MS, DESIGN_FLOOR_SHARE, Energy, IDLE_PERIOD_MS, clubLift, clubSeat, clubSeating, createCrowd, createSmoke, depthScale, drawFloor, drawSmoke, energyTarget, floorCacheKey, floorGeometry, floorK, floorRows, idleEnergy, labelDue, stepSmoke, type FloorCache, type FloorFrame } from "./floor.ts";
import { shortName } from "./dancers.ts";

const base = defaultConfig();
const club = base.themes["club-deck"]!;
/** A frame with nobody chatting: the four roster fields every club-deck frame carries. */
const NO_ROSTER = { chatters: [] as readonly Chatter[], nameLength: 12, chatterImage: (): CanvasImageSource | null => null, hops: new Map<string, number>() as ReadonlyMap<string, number> };
import { seededRandom } from "./util.ts";

describe("the idle energy envelope — a slow 32-bar sine unless a cue overrides it for 3 s", () => {
  test("idle: 32 bars at 126 bpm ≈ 61 s per cycle, swinging 0.25–0.85", () => {
    expect(IDLE_PERIOD_MS).toBeCloseTo((32 * 4 * 60000) / 126, 6);
    expect(idleEnergy(0)).toBeCloseTo(0.55, 9);
    expect(idleEnergy(IDLE_PERIOD_MS / 4)).toBeCloseTo(0.85, 9);
    expect(idleEnergy((IDLE_PERIOD_MS * 3) / 4)).toBeCloseTo(0.25, 9);
    expect(idleEnergy(IDLE_PERIOD_MS)).toBeCloseTo(0.55, 9);
  });

  test("energyTarget: a cue holds its value for CUE_HOLD_MS, then the idle curve is back", () => {
    expect(CUE_HOLD_MS).toBe(3000);
    expect(energyTarget(1000, null)).toBe(idleEnergy(1000));
    const cue = { value: 0.9, untilMs: 4000 };
    expect(energyTarget(1000, cue)).toBe(0.9);
    expect(energyTarget(3999, cue)).toBe(0.9);
    expect(energyTarget(4000, cue)).toBe(idleEnergy(4000));
  });

  test("Energy: cue(value, t) clamps to 0–1 and overrides for 3 s; the level eases toward the target on the loop clock", () => {
    const e = new Energy();
    e.step(0, 1);
    expect(e.value).toBeCloseTo(idleEnergy(0), 6); // starts on the idle curve, no ramp from zero
    e.cue(1.7, 1000);
    for (let t = 1000; t < 3000; t += 16) e.step(t, 1);
    expect(e.value).toBeGreaterThan(0.9); // eased up to the (clamped) 1
    expect(e.value).toBeLessThanOrEqual(1);
    e.step(4000, 1);
    expect(e.value).toBeGreaterThan(idleEnergy(4000)); // heading back down
    for (let t = 4016; t < 9000; t += 16) e.step(t, 1);
    expect(e.value).toBeCloseTo(idleEnergy(9000), 1);
    e.cue(-3, 9000);
    for (let t = 9000; t < 11000; t += 16) e.step(t, 1);
    expect(e.value).toBeLessThan(0.1);
  });

  test("a cue that is not an energy value is ignored", () => {
    const e = new Energy();
    e.step(0, 1);
    e.cue(undefined, 0);
    e.cue(Number.NaN, 0);
    e.step(16, 1);
    expect(e.value).toBeCloseTo(idleEnergy(16), 3);
  });
});

describe("createCrowd — 46 rim-lit dancers, a third with their arms up, seeded so a frame is reproducible", () => {
  test("the shape of the crowd", () => {
    const crowd = createCrowd(seededRandom(9));
    expect(crowd).toHaveLength(46);
    expect(crowd.map((c) => c.x)).toEqual(Array.from({ length: 46 }, (_, i) => i));
    for (const c of crowd) {
      expect(c.h).toBeGreaterThanOrEqual(24);
      expect(c.h).toBeLessThanOrEqual(46);
      expect(c.w).toBeGreaterThanOrEqual(18);
      expect(c.w).toBeLessThanOrEqual(26);
    }
    const arms = crowd.filter((c) => c.arms).length;
    expect(arms).toBeGreaterThan(6);
    expect(arms).toBeLessThan(26);
    expect(createCrowd(seededRandom(9))).toEqual(crowd);
  });
});

describe("the Chrome Lounge floor — geometry, rows, the once-per-size cache, the smoke", () => {
  test("horizon at 640/1080 of the height, vanishing point at (0.47 w, 0.52 h), mirrored when the rack is on the left", () => {
    const g = floorGeometry(1920, 1080, false);
    expect(g.horizonY).toBe(640);
    expect(g.vanish.x).toBeCloseTo(902.4, 6);
    expect(g.vanish.y).toBeCloseTo(561.6, 6);
    expect(floorGeometry(1920, 1080, true).vanish.x).toBeCloseTo(1920 - 902.4, 6);
    expect(floorGeometry(1280, 720, false).horizonY).toBeCloseTo(426.67, 1);
  });

  test("rows: the boards' spacing — tight at the horizon, opening toward the bottom edge, first on the horizon, last on the edge", () => {
    const rows = floorRows(640, 1080);
    expect(rows[0]).toBe(640);
    expect(rows[rows.length - 1]).toBe(1080);
    for (let i = 2; i < rows.length; i++) expect(rows[i]! - rows[i - 1]!).toBeGreaterThan(rows[i - 1]! - rows[i - 2]!);
  });

  test("drawFloor bakes the static floor into the cache once per size, blits it every frame, and stretches the horizon glow live", () => {
    const stage = new Map<string, number>();
    const baked = new Map<string, number>();
    const rec = (calls: Map<string, number>): CanvasRenderingContext2D =>
      new Proxy({} as Record<string, unknown>, {
        get: (target, key: string) => (key in target ? target[key] : key === "createLinearGradient" ? () => ({ addColorStop(): void {} }) : () => void calls.set(key, (calls.get(key) ?? 0) + 1)),
        set(target, key: string, value) {
          target[key] = value;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
    const names: string[] = [];
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: (ctx: CanvasRenderingContext2D, name: string) => (names.push(name), ctx.drawImage({} as CanvasImageSource, 0, 0)) } as unknown as SpriteSet;
    const cacheCtx = rec(baked);
    const cache: FloorCache = { canvas: { width: 0, height: 0, getContext: () => cacheCtx } as unknown as HTMLCanvasElement, width: 0, height: 0, key: "" };
    const frame = (w: number, h: number): FloorFrame => ({ x0: 40, x1: w - 40, gy: h - 112, t: 0, energy: 0.5, phase: 0, ...NO_ROSTER, width: w, height: h, ...floorGeometry(w, h, false), cache });
    const ctx = rec(stage);
    drawFloor(ctx, base.themes["chrome-lounge"]!, [], frame(1920, 1080), sprites, LEVELS[5]);
    const strokes = baked.get("stroke")!;
    expect(strokes).toBeGreaterThan(0);
    drawFloor(ctx, base.themes["chrome-lounge"]!, [], frame(1920, 1080), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(strokes); // the grid once per size
    expect(cache.canvas!.width).toBe(1920);
    expect(stage.get("drawImage")).toBe(4); // the cache blit + the horizon glow, twice
    expect(names).toEqual(["horizon-glow", "horizon-glow"]);
    expect(stage.get("arc")).toBeUndefined(); // no procedural crowd, no back wall on a sheet Theme
    drawFloor(ctx, base.themes["chrome-lounge"]!, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(2 * strokes); // re-baked at the new size
    expect(cache.canvas!.height).toBe(720);
    // a live skin change: the cache is keyed on the Theme colours the bake consumes, not the size alone
    const chrome = base.themes["chrome-lounge"]!;
    drawFloor(ctx, { ...chrome, floor: ["#000000", "#111111"] }, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(3 * strokes);
    drawFloor(ctx, { ...chrome, floor: ["#000000", "#111111"] }, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(3 * strokes); // the same skin again: no re-bake
    drawFloor(ctx, { ...chrome, grid: "rgba(1,2,3,.5)" }, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(4 * strokes);
    drawFloor(ctx, { ...chrome, haze: "1,2,3" }, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(5 * strokes);
    drawFloor(ctx, { ...chrome, accent: "#123456" }, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(6 * strokes); // back to the stock floor / grid / haze: re-baked once …
    drawFloor(ctx, chrome, [], frame(1280, 720), sprites, LEVELS[5]);
    expect(baked.get("stroke")).toBe(6 * strokes); // … and a colour the bake never reads changes nothing
  });

  test("the smoke sits at mid-floor — cy 700 / 720 / 660 at 1080p, scaled by the height — tinted from the Theme's haze", () => {
    const puffs = createSmoke();
    const ys: number[] = [];
    const colours: unknown[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => void (key === "translate" && ys.push(args[1] as number))),
      set(target, key: string, value) {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: (_c: unknown, _n: string, _s: unknown, _x: unknown, _y: unknown, o?: { colour?: string }) => void colours.push(o?.colour) } as unknown as SpriteSet;
    const chrome = base.themes["chrome-lounge"]!;
    const frame = (w: number, h: number): FloorFrame => ({ x0: 40, x1: w - 40, gy: h - 112, t: 0, energy: 0.5, phase: 0, ...NO_ROSTER, width: w, height: h, ...floorGeometry(w, h, false), cache: { canvas: null, width: 0, height: 0, key: "" } });
    const near = (want: number[]): void => {
      expect(ys).toHaveLength(want.length);
      ys.forEach((y, i) => expect(Math.abs(y - want[i]!), `puff ${i}`).toBeLessThanOrEqual(6)); // ± the idle bob
    };
    drawSmoke(ctx, chrome, puffs, frame(1920, 1080), sprites, LEVELS[5]);
    near([700, 720, 660]);
    expect(new Set(colours)).toEqual(new Set([`rgb(${chrome.haze})`]));
    ys.length = 0;
    drawSmoke(ctx, chrome, puffs, frame(2560, 1440), sprites, LEVELS[5]);
    near([700 * (4 / 3), 720 * (4 / 3), 660 * (4 / 3)]);
    ys.length = 0;
    drawSmoke(ctx, chrome, puffs, frame(1920, 1080), sprites, LEVELS[3]);
    expect(ys).toEqual([]); // no smoke below Level 4
  });

  test("smoke: three puffs, front ones faster, drifting with the ground wind and wrapping round the frame", () => {
    const puffs = createSmoke();
    expect(puffs).toHaveLength(3);
    const speeds = puffs.map((p) => p.speed);
    expect(speeds[0]!).toBeLessThan(speeds[1]!);
    expect(speeds[1]!).toBeLessThan(speeds[2]!);
    const x0 = puffs.map((p) => p.x);
    stepSmoke(puffs, 1, 1, 1920);
    puffs.forEach((p, i) => expect(p.x).toBeGreaterThan(x0[i]!));
    for (let i = 0; i < 20000; i++) stepSmoke(puffs, 2, 1, 1920);
    for (const p of puffs) {
      expect(p.x).toBeGreaterThan(-700);
      expect(p.x).toBeLessThan(1920 + 700);
    }
    stepSmoke(puffs, -3, 1, 1920);
    expect(puffs.every((p) => Number.isFinite(p.x))).toBe(true);
  });
});

describe("the dance floor's share of the frame (overlay.floorPercent) — the horizon moves, the floor's furniture scales with its depth", () => {
  test("floorGeometry's fourth argument is the floor's share of the height: the boards' share is the default; 0.33 drops the horizon to 723.6 at 1080p and keeps the vanishing point the same share of the depth above it", () => {
    expect(floorGeometry(1920, 1080, false, DESIGN_FLOOR_SHARE)).toEqual(floorGeometry(1920, 1080, false));
    const g = floorGeometry(1920, 1080, false, 0.33);
    expect(g.horizonY).toBeCloseTo(723.6, 6);
    expect(g.vanish.x).toBeCloseTo(902.4, 6);
    expect(g.vanish.y).toBeCloseTo(723.6 - (78.4 / 440) * (1080 - 723.6), 6); // boards: 78.4 px above a 640 horizon over a 440 px floor
    expect(floorGeometry(1920, 1080, true, 0.33).vanish.x).toBeCloseTo(1920 - 902.4, 6);
  });

  test("depthScale is the floor's depth over the boards' 440: 1 at 1080p on the boards' floor, the height ratio at 720p, 0.81 at a 33 % floor; floorK is the same relative to the frame (1 at every size on the boards' share)", () => {
    expect(depthScale(640, 1080)).toBeCloseTo(1, 9);
    expect(depthScale(floorGeometry(1280, 720, false).horizonY, 720)).toBeCloseTo(720 / 1080, 9);
    expect(depthScale(723.6, 1080)).toBeCloseTo(356.4 / 440, 9);
    expect(floorK(640, 1080)).toBeCloseTo(1, 9);
    expect(floorK(floorGeometry(1280, 720, false).horizonY, 720)).toBeCloseTo(1, 9);
    expect(floorK(723.6, 1080)).toBeCloseTo(0.33 / (440 / 1080), 9);
  });

  test("the baked floor is keyed on the horizon too, so a floorPercent change re-bakes", () => {
    const chrome = base.themes["chrome-lounge"]!;
    expect(floorCacheKey(chrome, 1920, 1080, 640)).not.toBe(floorCacheKey(chrome, 1920, 1080, 723.6));
    expect(floorCacheKey(chrome, 1920, 1080, 640)).toBe(floorCacheKey(chrome, 1920, 1080, 640));
  });

  test("the haze band and the smoke lines follow the horizon: haze 260 px deep on the boards' floor and shallower with it; the puffs 60 / 80 / 20 px under the horizon as shares of the 440 px depth", () => {
    const rects: number[][] = [];
    const ys: number[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : key === "createLinearGradient" ? () => ({ addColorStop(): void {} }) : (...args: unknown[]) => void (key === "fillRect" ? rects.push(args as number[]) : key === "translate" && ys.push(args[1] as number))),
      set(target, key: string, value) {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: () => {} } as unknown as SpriteSet;
    const chrome = base.themes["chrome-lounge"]!;
    const frame = (share: number): FloorFrame => ({ x0: 40, x1: 1880, gy: 968, t: 0, energy: 0.5, phase: 0, ...NO_ROSTER, width: 1920, height: 1080, ...floorGeometry(1920, 1080, false, share), cache: { canvas: null, width: 0, height: 0, key: "" } });
    drawFloor(ctx, chrome, [], frame(DESIGN_FLOOR_SHARE), sprites, LEVELS[5]);
    expect(rects.at(-1)![3]).toBeCloseTo(260, 6);
    rects.length = 0;
    drawFloor(ctx, chrome, [], frame(0.33), sprites, LEVELS[5]);
    expect(rects.at(-1)![1]).toBeCloseTo(723.6, 6);
    expect(rects.at(-1)![3]).toBeCloseTo(260 * (356.4 / 440), 6);
    const near = (want: number[]): void => {
      expect(ys).toHaveLength(want.length);
      ys.forEach((y, i) => expect(Math.abs(y - want[i]!), `puff ${i}`).toBeLessThanOrEqual(6)); // ± the idle bob
    };
    ys.length = 0; // the two floors above each translated to their horizon for the glow strip
    drawSmoke(ctx, chrome, createSmoke(1920), frame(DESIGN_FLOOR_SHARE), sprites, LEVELS[5]);
    near([700, 720, 660]);
    ys.length = 0;
    drawSmoke(ctx, chrome, createSmoke(1920), frame(0.33), sprites, LEVELS[5]);
    near([60, 80, 20].map((under) => 723.6 + (under / 440) * (1080 - 723.6)));
  });
});

describe("the club-deck's Chatter Dancers — the roster's heads on the centre bobbers, generics untouched", () => {
  /** Every method call and property write, in order, as one line each — the whole frame as a string list. */
  function recorder(): { ctx: CanvasRenderingContext2D; ops: string[]; texts: string[] } {
    const ops: string[] = [];
    const texts: string[] = [];
    const gradient = { addColorStop(): void {} };
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : key === "measureText"
            ? (text: string) => ({ width: text.length * 7 })
            : key === "createLinearGradient"
              ? () => gradient
              : (...args: unknown[]) => {
                  ops.push(`${key}(${args.map(String).join(",")})`);
                  if (key === "fillText" && typeof args[0] === "string") texts.push(args[0]);
                },
      set(target, key: string, value) {
        target[key] = value;
        ops.push(`set ${key}=${String(value)}`);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, ops, texts };
  }
  const crowd = createCrowd(seededRandom(9));
  const frame = (t: number, roster: Partial<Pick<FloorFrame, "chatters" | "nameLength" | "chatterImage" | "hops">> = {}): FloorFrame => ({ x0: 40, x1: 1880, gy: 968, t, energy: 0.5, phase: 0, width: 1920, height: 1080, ...floorGeometry(1920, 1080, false), cache: { canvas: null, width: 0, height: 0, key: "" }, ...NO_ROSTER, ...roster });
  /** The `arc(x,y,r,…)` ops at radius `r`, parsed. */
  const arcs = (ops: string[], r: number): { x: number; y: number }[] =>
    ops
      .filter((o) => o.startsWith("arc("))
      .map((o) => o.slice(4, -1).split(",").map(Number))
      .filter((a) => a[2] === r)
      .map((a) => ({ x: a[0]!, y: a[1]! }));

  test("with nobody chatting the crowd's ops are what they were: 1150 ops, 46 heads, 144 fills, 119 strokes, no text, no picture (pinned by hash on main a4a6a5c)", () => {
    const { ctx, ops } = recorder();
    drawFloor(ctx, club, crowd, frame(1250), null, LEVELS[5]);
    expect(ops).toHaveLength(1150);
    expect(ops.filter((o) => o.startsWith("arc(")).length).toBe(46);
    expect(ops.filter((o) => o === "fill()").length).toBe(144);
    expect(ops.filter((o) => o === "stroke()").length).toBe(119);
    expect(ops.filter((o) => o === "clip()").length).toBe(1); // the slab's grid clip (floor.ts:217), nothing else
    expect(ops.some((o) => o.startsWith("fillText(") || o.startsWith("drawImage("))).toBe(false);
    expect(fnv1a(ops.join("\n"))).toBe(1352373122);
  });

  test("clubSeat: the centre bobber first, then outward both ways, and every bobber is reached once", () => {
    expect([0, 1, 2, 3, 4, 5].map(clubSeat)).toEqual([23, 22, 24, 21, 25, 20]);
    expect(clubSeat(44)).toBe(45);
    expect(clubSeat(45)).toBe(0);
    expect(new Set(Array.from({ length: CROWD_SIZE }, (_, i) => clubSeat(i))).size).toBe(46);
  });

  test("clubLift: a 14 px parabola over 500 ms from the Hop's start, 0 outside it and with no Hop", () => {
    expect(CLUB_HOP_MS).toBe(500);
    expect(CLUB_HOP_PX).toBe(14);
    expect(clubLift(undefined, 0)).toBe(0);
    expect(clubLift(1000, 1000)).toBe(0);
    expect(clubLift(1000, 1125)).toBeCloseTo(10.5, 9);
    expect(clubLift(1000, 1250)).toBe(14);
    expect(clubLift(1000, 1500)).toBe(0);
    expect(clubLift(1000, 5000)).toBe(0);
    expect(clubLift(1000, 999)).toBe(0); // a Hop in the future lifts nothing
  });

  test("labelDue: 4 s after a Hop; otherwise 4 s out of every 30–60 s on a cadence hashed from the key (k1: period 57489, phase 31619; k2: 34632 / 14380)", () => {
    expect(CLUB_LABEL_MS).toBe(4000);
    expect(labelDue("k1", 1000, 1000)).toBe(true);
    expect(labelDue("k1", 1000, 4999)).toBe(true);
    expect(labelDue("k1", 1000, 5000)).toBe(false);
    expect(labelDue("k1", undefined, 0)).toBe(false);
    expect(labelDue("k1", undefined, 26000)).toBe(true); // (26000 + 31619) % 57489 = 130
    expect(labelDue("k1", undefined, 30000)).toBe(false); // 4130
    expect(labelDue("k2", undefined, 0)).toBe(false);
    expect(labelDue("k2", undefined, 21000)).toBe(true); // (21000 + 14380) % 34632 = 748
    expect(labelDue("k2", undefined, 25000)).toBe(false); // 4748
  });

  test("shortName: whole names fit, longer ones end in an ellipsis inside the limit", () => {
    expect(shortName("alice", 12)).toBe("alice");
    expect(shortName("abcdefghijkl", 12)).toBe("abcdefghijkl");
    expect(shortName("abcdefghijklm", 12)).toBe("abcdefghijk…");
    expect(shortName("bartholomew", 4)).toBe("bar…");
    expect(shortName("ab", 1)).toBe("a…");
  });

  test("clubSeating: the first 46 of a newest-first roster, seated by arrival so a message moves nobody", () => {
    const roster: Chatter[] = Array.from({ length: 50 }, (_, i) => ({ key: `c${i}`, name: `name${i}`, avatarUrl: null, firstSeenMs: 1000 * (49 - i), lastSeenMs: 1000 * (49 - i) }));
    const seated = clubSeating(roster);
    expect(seated).toHaveLength(46);
    expect(seated[0]!.key).toBe("c45"); // the earliest arrival among the 46 newest talkers sits at the centre
    expect(seated[45]!.key).toBe("c0");
    expect(seated.map((c) => c.key)).not.toContain("c46");
    expect(clubSeating([])).toEqual([]);
    const tie = clubSeating([{ ...roster[0]!, key: "z", firstSeenMs: 5 }, { ...roster[0]!, key: "a", firstSeenMs: 5 }]);
    expect(tie.map((c) => c.key)).toEqual(["a", "z"]);
  });

  const image = (url: string | null): CanvasImageSource | null => (url === null ? null : ({} as CanvasImageSource));
  const person = (key: string, name: string, avatarUrl: string | null, firstSeenMs: number): Chatter => ({ key, name, avatarUrl, firstSeenMs, lastSeenMs: firstSeenMs });
  const hopped = (keys: string[], at: number): ReadonlyMap<string, number> => new Map(keys.map((k) => [k, at]));

  test("three chatters sit on bobbers 23, 22, 24 (centre outward, by arrival): a 13.5 px disc, the picture through an arc clip, a rim ring; the glyph when the picture is null; every name after a Hop", () => {
    const three = [person("k1", "al", "https://x/a.png", 1), person("k2", "bo", null, 2), person("k3", "cy", "https://x/c.png", 3)];
    const { ctx, ops, texts } = recorder();
    drawFloor(ctx, club, crowd, frame(1250, { chatters: three, chatterImage: image, hops: hopped(["k1", "k2", "k3"], 1000) }), null, LEVELS[5]);
    const heads = arcs(ops, CLUB_HEAD_R);
    expect(heads).toHaveLength(8); // al: disc + clip + ring, bo: disc + ring, cy: disc + clip + ring
    const xs = new Set(heads.map((h) => Math.round(h.x * 100) / 100));
    expect(xs).toEqual(new Set([960, 920.43, 999.57])); // bobbers 23, 22, 24 at pitch 1820 / 46
    expect(ops.filter((o) => o.startsWith("drawImage(")).length).toBe(2);
    expect(ops.filter((o) => o === "clip()").length).toBe(3); // the slab's, then al's and cy's
    expect(ops.filter((o) => o.startsWith("arc(")).length).toBe(46 + 8);
    expect(texts).toEqual(["🪩", "bo", "al", "cy"]); // bo's Avatar Glyph during the crowd pass, then the plates left to right
    expect(ops).toContain("set font=17px serif"); // the glyph: round(13.5 × 1.25)
    expect(ops).toContain(`set font=600 11px system-ui, sans-serif`);
    expect(ops).toContain(`set fillStyle=${club.panel}`); // the plate
    expect(ops.filter((o) => o === "set lineWidth=1.5").length).toBe(3); // one ring each, in the rim tint
    expect(ops.filter((o) => o === `set strokeStyle=${club.rim}`).length).toBeGreaterThanOrEqual(4); // the loop's own + one restore per seated bobber
    expect(ops.some((o) => o.startsWith("set filter") || o.startsWith("set shadow"))).toBe(false);
    // the generic bobbers around them still draw their 9 px heads
    expect(arcs(ops, 9)).toHaveLength(46);
  });

  test("a plate that would overlap one already drawn this frame is skipped this frame (left to right, the first wins)", () => {
    const three = [person("k1", "alice", "https://x/a.png", 1), person("k2", "bob", null, 2), person("k3", "carol", "https://x/c.png", 3)];
    const { ctx, texts } = recorder();
    drawFloor(ctx, club, crowd, frame(1250, { chatters: three, chatterImage: image, hops: hopped(["k1", "k2", "k3"], 1000) }), null, LEVELS[5]);
    expect(texts).toEqual(["🥁", "bob", "carol"]); // "alice" at 960 would sit on bob's plate (measureText = 7 px a letter): skipped
  });

  test("a Hop lifts the whole bobber 14 px at its midpoint and nothing once it is over; the plate goes with the head and leaves after 4 s", () => {
    const one = [person("k1", "al", "https://x/a.png", 1)];
    const mid = recorder();
    drawFloor(mid.ctx, club, crowd, frame(1250, { chatters: one, chatterImage: image, hops: hopped(["k1"], 1000) }), null, LEVELS[5]);
    const over = recorder();
    drawFloor(over.ctx, club, crowd, frame(5000, { chatters: one, chatterImage: image, hops: hopped(["k1"], 1000) }), null, LEVELS[5]);
    const headMid = arcs(mid.ops, CLUB_HEAD_R)[0]!;
    const headOver = arcs(over.ops, CLUB_HEAD_R)[0]!;
    expect(headOver.y - headMid.y).toBeCloseTo(14, 9);
    const bodyMid = arcs(mid.ops, 9)[23]!;
    const bodyOver = arcs(over.ops, 9)[23]!;
    expect(bodyOver.y - bodyMid.y).toBeCloseTo(14, 9); // the generic head under the bobblehead rides too
    expect(arcs(over.ops, 9)[22]!.y).toBe(arcs(mid.ops, 9)[22]!.y); // the neighbour does not
    expect(mid.texts).toEqual(["al"]);
    expect(over.texts).toEqual([]); // 4 s gone, and k1's own cadence is off at 5000 ((5000 + 31619) % 57489 = 36619)
  });

  test("nameLength clips the plate", () => {
    const one = [person("k1", "bartholomew", null, 1)];
    const { ctx, texts } = recorder();
    drawFloor(ctx, club, crowd, frame(1250, { chatters: one, nameLength: 4, hops: hopped(["k1"], 1000) }), null, LEVELS[5]);
    expect(texts).toEqual(["🕺", "bar…"]);
  });

  test("60 chatters at Level 5: 46 wear a head, the rest are not drawn on the club-deck; all glyphs when no picture has decoded", () => {
    const sixty = Array.from({ length: 60 }, (_, i) => person(`p${i}`, `person${i}`, `https://x/${i}.png`, i));
    const { ctx, ops, texts } = recorder();
    drawFloor(ctx, club, crowd, frame(0, { chatters: sixty, chatterImage: () => null }), null, LEVELS[5]);
    expect(arcs(ops, CLUB_HEAD_R)).toHaveLength(92); // disc + ring, 46 times
    expect(ops.filter((o) => o.startsWith("drawImage(")).length).toBe(0);
    expect(texts.filter((t) => club.avatars.includes(t))).toHaveLength(46);
    expect(arcs(ops, 9)).toHaveLength(46);
  });
});

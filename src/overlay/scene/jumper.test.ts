import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../config/schema.ts";
import { createJumper, drawJumper, easeOnto, progressOf, steer, stepJumper, type JumperBounds, type Jumper } from "./jumper.ts";
import { seededRandom } from "./util.ts";
import { WindField } from "./wind.ts";

const bounds: JumperBounds = { x0: 220, x1: 1180, skyY: 60, groundY: 999 };
const DESCENT = 12000;
const calm = () => ({ u: 0, v: 0 });
const crosswind = () => ({ u: 2.2, v: 0.3 });

/** Fly `J` to the ground under `field`, one 16 ms frame at a time; returns the landing frame's time. */
function fly(J: Jumper, target: number, field: (x: number, y: number) => { u: number; v: number }, rng: () => number, from = 0): number {
  for (let t = from; t < from + 60000; t += 16) {
    if (stepJumper(J, t, 16, field, target, bounds, DESCENT, rng)) return t;
  }
  throw new Error("never landed");
}

describe("the pilot — steering with inertia, eased onto the drawn pad", () => {
  test("steer: proportional toward the target, clamped, scaled by the pilot's authority", () => {
    expect(steer(500, 500, 1)).toBe(0);
    expect(steer(555, 500, 1)).toBeCloseTo(0.45, 6);
    expect(steer(1000, 500, 1)).toBeCloseTo(1.08, 6); // clamped at 1.2 × 0.9
    expect(steer(0, 500, 1.5)).toBeCloseTo(-1.62, 6);
  });

  test("easeOnto: nothing until 80 % of the way down, then a growing pull, exact at 100 %", () => {
    expect(easeOnto(100, 500, 0.5)).toBe(100);
    expect(easeOnto(100, 500, 0.8)).toBe(100);
    expect(easeOnto(100, 500, 0.9)).toBeGreaterThan(100);
    expect(easeOnto(100, 500, 0.9)).toBeLessThan(500);
    expect(easeOnto(100, 500, 1)).toBe(500);
    expect(easeOnto(100, 500, 1.2)).toBe(500);
  });

  test("progressOf: 0 at the door's height, 1 at the touchdown line", () => {
    const J = createJumper({ x: 400, y: bounds.skyY }, "stickers", 0, DESCENT, seededRandom(1));
    expect(progressOf(J, bounds)).toBe(0);
    J.y = (bounds.skyY + bounds.groundY) / 2;
    expect(progressOf(J, bounds)).toBeCloseTo(0.5, 9);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %d: lands within 2 px of the target pad's centre in calm air, a steady crosswind and a gusty field", (seed) => {
    const targets = [260, 700, 1150];
    const fields = [calm, crosswind, undefined];
    for (const target of targets) {
      for (const f of fields) {
        const rng = seededRandom(seed);
        const wind = new WindField(seededRandom(seed * 31));
        const field = f ?? ((x: number, y: number) => wind.at(x, y));
        const J = createJumper({ x: 456, y: 120 }, "stickers", 0, DESCENT, rng);
        const bounds2 = { ...bounds };
        for (let t = 0; t < 60000; t += 16) {
          if (f === undefined) wind.step(t, 16, bounds2, ["·"], true);
          if (stepJumper(J, t, 16, field, target, bounds2, DESCENT, rng)) {
            expect(Math.abs(J.x + J.spiralOff - target)).toBeLessThanOrEqual(2);
            expect(J.y).toBeGreaterThanOrEqual(bounds.groundY);
            break;
          }
          expect(t).toBeLessThan(59000);
        }
      }
    }
  });

  test("canopy ↔ sink rate: the descent takes ~descentMs / rate, so no two jumpers fly the same line or land together", () => {
    const rng = seededRandom(9);
    const times = [0, 1, 2, 3].map(() => {
      const J = createJumper({ x: 456, y: 120 }, "stickers", 0, DESCENT, rng);
      expect(J.rate).toBeGreaterThanOrEqual(0.65);
      expect(J.rate).toBeLessThanOrEqual(1.45);
      expect(J.canopy).toBeCloseTo(1.25 - (J.rate - 0.65) * 0.45, 9);
      const landed = fly(J, 700, calm, rng);
      expect(landed).toBeGreaterThan((DESCENT / J.rate) * 0.75);
      expect(landed).toBeLessThan((DESCENT / J.rate) * 1.25);
      return landed;
    });
    expect(new Set(times).size).toBe(4);
  });

  test("one trick per descent, drawn spiral ≈ ½ / cartwheel ≈ ¼ / clean ≈ ¼, finished before the final approach", () => {
    const counts = { spiral: 0, cartwheel: 0, none: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seededRandom(seed);
      const J = createJumper({ x: 456, y: 120 }, "stickers", 1000, DESCENT, rng);
      counts[J.trick]++;
      const expected = DESCENT / J.rate;
      expect(J.trickAt).toBeGreaterThanOrEqual(1000 + 0.12 * expected);
      expect(J.trickAt + (J.trick === "spiral" ? 3000 : J.trick === "cartwheel" ? 1300 : 0)).toBeLessThanOrEqual(1000 + 0.75 * expected + 1);
    }
    expect(counts.spiral).toBeGreaterThan(80);
    expect(counts.spiral).toBeLessThan(120);
    expect(counts.cartwheel).toBeGreaterThan(30);
    expect(counts.none).toBeGreaterThan(30);
  });

  test("the spiral swings the canopy sideways and turns it side-on mid-loop; it is over (offset 0) by touchdown", () => {
    const rng = seededRandom(4);
    let J: Jumper;
    do J = createJumper({ x: 456, y: 120 }, "stickers", 0, DESCENT, rng);
    while (J.trick !== "spiral");
    let maxOff = 0;
    let minSx = 1;
    for (let t = 0; t < 60000; t += 16) {
      const landed = stepJumper(J, t, 16, calm, 700, bounds, DESCENT, rng);
      maxOff = Math.max(maxOff, Math.abs(J.spiralOff));
      minSx = Math.min(minSx, J.sxk);
      if (landed) break;
    }
    expect(maxOff).toBeGreaterThan(30);
    expect(minSx).toBeLessThan(0.6);
    expect(J.spiralOff).toBe(0);
    expect(String(J.trick)).toBe("none");
  });
});

describe("the jumper is nobody in particular — a pilot under a canopy, no name, no avatar", () => {
  test("createJumper takes no `who`: the jumper carries no name and no avatar", () => {
    const J = createJumper({ x: 456, y: 120 }, "stickers", 0, DESCENT, seededRandom(1), 7);
    expect(J.fireSeq).toBe(7);
    expect(J.padId).toBe("stickers");
    expect("name" in J).toBe(false);
    expect("avatar" in J).toBe(false);
  });

  test("drawJumper paints no text at all: the harness disc is a plain ring, nothing over the canopy", () => {
    const calls = new Map<string, number>();
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (..._args: unknown[]) => void calls.set(key, (calls.get(key) ?? 0) + 1)),
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as CanvasRenderingContext2D;
    const club = defaultConfig().themes["club-deck"]!;
    const J = createJumper({ x: 456, y: 120 }, "stickers", 0, DESCENT, seededRandom(2));
    J.y = 400;
    drawJumper(ctx, club, J, bounds.groundY);
    expect(calls.get("fillText")).toBeUndefined();
    expect(calls.get("fill")!).toBeGreaterThan(5);
    expect(calls.get("stroke")!).toBeGreaterThan(1);
    const src = readFileSync(path.join(import.meta.dir, "jumper.ts"), "utf8");
    expect(src).not.toMatch(/fillText|handle|avatar|\bname\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the jumper from the Theme Sheet
// ---------------------------------------------------------------------------------------------------------------------
import { PILOT_FEET_Y as SCRIPT_PILOT_FEET_Y, RISER_DROP as SCRIPT_RISER_DROP } from "../../../scripts/sprites/draw.ts";
import atlasJson from "../art/chrome-lounge.json";
import { LEVELS, type LevelSpec } from "../quality.ts";
import type { Atlas, DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { JUMPER_K, PILOT_FEET, RISER_DROP, canopyFrames, shadowFrame } from "./jumper.ts";

interface Draw {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
}

function fakeSprites(): { set: SpriteSet; draws: Draw[] } {
  const draws: Draw[] = [];
  const set: SpriteSet = {
    id: "chrome-lounge",
    setDetail: () => {},
    get: () => ({ image: {} as CanvasImageSource, frame: { x: 0, y: 0, w: 10, h: 10, ax: 5, ay: 5, kind: "master" }, scale: 1 }),
    has: () => true,
    names: () => [...new Set(draws.map((d) => d.name))],
    draw(ctx, name, scale, x, y, opts) {
      draws.push({ name, scale, x, y, opts });
      ctx.drawImage({} as CanvasImageSource, 0, 0);
    },
  };
  return { set, draws };
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number>; args: Map<string, unknown[][]> } {
  const calls = new Map<string, number>();
  const args = new Map<string, unknown[][]>();
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...a: unknown[]) => {
            calls.set(key, (calls.get(key) ?? 0) + 1);
            args.set(key, [...(args.get(key) ?? []), a]);
          },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, args };
}

describe("drawJumper on the Chrome Lounge sheet", () => {
  const chrome = defaultConfig().themes["chrome-lounge"]!;
  const sky = bounds.skyY;
  const ground = bounds.groundY;

  /** A jumper `progress` of the way down (0 = the door's height, 1 = the touchdown line). */
  function jumperAt(progress: number, seed = 2): Jumper {
    const J = createJumper({ x: 456, y: sky }, "stickers", 0, DESCENT, seededRandom(seed));
    J.y = sky + (ground - sky) * progress;
    return J;
  }

  function render(J: Jumper, lvl: LevelSpec = LEVELS[5]) {
    const sp = fakeSprites();
    const c = fakeCtx();
    drawJumper(c.ctx, chrome, J, ground, sp.set, lvl, sky);
    return { ...c, draws: sp.draws, names: sp.draws.map((d) => d.name) };
  }

  test("the ground shadow sharpens with the descent: pilot-shadow-0 at the door, -1 midway, -2 from 90 % down — on the touchdown line, denser as the ground comes up", () => {
    expect(shadowFrame(0)).toBe(0);
    expect(shadowFrame(0.5)).toBe(1);
    expect(shadowFrame(0.9)).toBe(2);
    expect(shadowFrame(1)).toBe(2);
    const top = render(jumperAt(0));
    const low = render(jumperAt(0.95));
    expect(top.names).toContain("pilot-shadow-0");
    expect(top.names).not.toContain("pilot-shadow-2");
    expect(low.names).toContain("pilot-shadow-2");
    expect(low.names).not.toContain("pilot-shadow-0");
    const shadowTop = top.draws.find((d) => d.name.startsWith("pilot-shadow"))!;
    const shadowLow = low.draws.find((d) => d.name.startsWith("pilot-shadow"))!;
    expect(shadowTop.y).toBe(ground);
    expect(shadowLow.y).toBe(ground);
    expect(shadowLow.opts!.alpha!).toBeGreaterThan(shadowTop.opts!.alpha!);
    expect(top.names.indexOf("pilot-shadow-0")).toBe(0); // under everything
  });

  test("the rig in order: canopy-a (canopy[0]) → canopy-b (canopy[1]) → canopy-gloss → risers → pilot; the canopy layers and the risers share one Anchor and the pilot hangs RISER_DROP × k under it, so the hands sit on the risers", () => {
    const J = jumperAt(0.4);
    J.sxk = 1;
    J.trick = "none";
    const { draws, names, calls } = render(J);
    const rig = names.filter((n) => !n.startsWith("pilot-shadow"));
    expect(rig).toEqual(["canopy-a", "canopy-b", "canopy-gloss", "risers", "pilot"]);
    const by = (n: string): Draw => draws.find((d) => d.name === n)!;
    const k = JUMPER_K * J.canopy;
    for (const n of ["canopy-b", "canopy-gloss", "risers"]) expect([by(n).x, by(n).y]).toEqual([by("canopy-a").x, by("canopy-a").y]);
    expect(by("pilot").x).toBe(by("canopy-a").x);
    expect(by("pilot").y - by("canopy-a").y).toBeCloseTo(RISER_DROP * k, 9);
    for (const d of draws) expect(d.opts?.k).toBeCloseTo(k, 9);
    expect(by("canopy-a").opts?.colour).toBe(chrome.canopy[0]);
    expect(by("canopy-b").opts?.colour).toBe(chrome.canopy[1]);
    expect(by("canopy-gloss").opts?.colour).toBeUndefined();
    expect(by("pilot").opts?.colour).toBeUndefined(); // the one Coloured Sprite
    expect(new Set(draws.map((d) => d.scale))).toEqual(new Set([1]));
    expect(calls.get("drawImage")).toBe(names.length);
    expect(calls.get("fillText")).toBeUndefined();
    // the boots stand on the touchdown line: the rig's pivot (the hands) is PILOT_FEET × k above J.y
    const translate = (fakeArgs(J).get("translate") ?? [])[0]!;
    expect(translate[1]).toBeCloseTo(J.y - PILOT_FEET * k, 9);
    expect(new Set(render(J, LEVELS[1]).draws.map((d) => d.scale))).toEqual(new Set([0.5]));
  });

  const fakeArgs = (J: Jumper): Map<string, unknown[][]> => render(J).args;

  test("RISER_DROP and the hands line are the atlas's numbers, not magic: risers is RISER_DROP + 2·ay tall (4 px past each end) and matches the sheet script", () => {
    const r = (atlasJson as Atlas).scales["1"].frames["risers"]!;
    expect(r.h - 2 * r.ay).toBe(RISER_DROP);
    expect(RISER_DROP).toBe(SCRIPT_RISER_DROP);
    const p = (atlasJson as Atlas).scales["1"].frames["pilot"]!;
    expect(p.ay).toBeLessThan(15); // the pilot's Anchor is its hands line at the top of the frame
    expect(PILOT_FEET).toBe(SCRIPT_PILOT_FEET_Y); // the boots' line is the bake's number, not a hand copy
    expect(PILOT_FEET).toBeGreaterThan(p.h - p.ay - 30); // and it is near the frame's foot
    expect(PILOT_FEET).toBeLessThan(p.h - p.ay);
  });

  test("mid-spiral the side frames stand in, nearest the canopy's squash, and the risers squash to match", () => {
    expect(canopyFrames(1)).toEqual({ a: "canopy-a", b: "canopy-b", gloss: "canopy-gloss", xs: 1 });
    expect(canopyFrames(0.9)).toEqual({ a: "canopy-a", b: "canopy-b", gloss: "canopy-gloss", xs: 1 });
    expect(canopyFrames(0.7)).toEqual({ a: "canopy-side-1-a", b: "canopy-side-1-b", gloss: "canopy-side-1-gloss", xs: 0.7 });
    expect(canopyFrames(0.45)).toEqual({ a: "canopy-side-0-a", b: "canopy-side-0-b", gloss: "canopy-side-0-gloss", xs: 0.45 });
    expect(canopyFrames(0.5)).toEqual(canopyFrames(0.45));
    const J = jumperAt(0.4);
    J.sxk = 0.45;
    const { names, args } = render(J);
    expect(names).toContain("canopy-side-0-a");
    expect(names).toContain("canopy-side-0-b");
    expect(names).toContain("canopy-side-0-gloss");
    expect(names).toContain("pilot"); // the pilot never squashes
    expect((args.get("scale") ?? []).some((a) => a[0] === 0.45 && a[1] === 1)).toBe(true); // the risers do
    expect(args.get("rotate")![0]![0]).toBe(J.sway);
  });

  test("nobody in particular on the sheet either: no fillText, no name; the club-deck path draws no image", () => {
    const sheet = render(jumperAt(0.5));
    expect(sheet.calls.get("fillText")).toBeUndefined();
    const c = fakeCtx();
    drawJumper(c.ctx, chrome, jumperAt(0.5), ground);
    expect(c.calls.get("drawImage")).toBeUndefined();
    expect(c.calls.get("fill")!).toBeGreaterThan(5);
  });
});

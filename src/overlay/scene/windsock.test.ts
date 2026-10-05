import { describe, expect, test } from "bun:test";
import { sockShape } from "./windsock.ts";

describe("sockShape — the windsock points downwind, stretches with strength, droops when calm", () => {
  test("calm: a short sock hanging at nearly a right angle", () => {
    const s = sockShape({ x: 0, y: 0 }, 0);
    expect(s.dir).toBe(1);
    expect(s.strength).toBe(0);
    expect(s.len).toBe(34);
    expect(s.angle).toBeCloseTo(0.95, 6);
  });

  test("a full westerly stretches it out flat to the left; strength saturates at 2.2", () => {
    const s = sockShape({ x: -3, y: 0 }, 0);
    expect(s.dir).toBe(-1);
    expect(s.strength).toBe(1);
    expect(s.len).toBe(80);
    expect(Math.abs(s.angle)).toBeLessThan(0.1);
  });

  test("half strength: half way between, with a flutter that only the loop clock moves", () => {
    const a = sockShape({ x: 1.1, y: 0.4 }, 500);
    expect(a.strength).toBeCloseTo(0.5, 9);
    expect(a.len).toBeCloseTo(57, 9);
    expect(sockShape({ x: 1.1, y: 0.4 }, 500)).toEqual(a);
    expect(sockShape({ x: 1.1, y: 0.4 }, 580).angle).not.toBe(a.angle);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the windsock from the Theme Sheet
// ---------------------------------------------------------------------------------------------------------------------
import { defaultConfig } from "../../config/schema.ts";
import { LEVELS } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { drawWindsock, sheetSockTop } from "./windsock.ts";

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

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number>; args: Map<string, unknown[][]>; props: Set<string> } {
  const calls = new Map<string, number>();
  const args = new Map<string, unknown[][]>();
  const props = new Set<string>();
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...a: unknown[]) => {
            calls.set(key, (calls.get(key) ?? 0) + 1);
            args.set(key, [...(args.get(key) ?? []), a]);
          },
    set: (target, key: string, value) => ((target[key] = value), props.add(key), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, args, props };
}

describe("drawWindsock on the Chrome Lounge sheet (pole + cone frames)", () => {
  const chrome = defaultConfig().themes["chrome-lounge"]!;

  function render(wind: { x: number; y: number }, t: number, lvl = LEVELS[5]) {
    const sp = fakeSprites();
    const c = fakeCtx();
    drawWindsock(c.ctx, chrome, 130, 500, wind, t, sp.set, lvl);
    const by = (name: string): Draw => sp.draws.find((d) => d.name === name)!;
    return { ...c, draws: sp.draws, names: sp.draws.map((d) => d.name), pole: by("windsock-pole"), cone: by("windsock-cone") };
  }

  test("two frames, both tinted the accent at the Sheet Scale: the pole unrotated with its foot a pole's length under the top, then the cone at the cap", () => {
    const r = render({ x: 0, y: 0 }, 0);
    expect(r.names).toEqual(["windsock-pole", "windsock-cone"]);
    expect(r.pole.opts?.colour).toBe(chrome.accent);
    expect(r.cone.opts?.colour).toBe(chrome.accent);
    expect(r.pole.scale).toBe(1);
    expect(r.cone.scale).toBe(1);
    expect(r.pole.opts?.rotate ?? 0).toBe(0);
    expect(r.pole.opts?.flipX ?? false).toBe(false);
    expect(r.pole.x).toBe(130);
    expect(sheetSockTop(r.pole.y)).toBe(500); // drawn at the foot: the pole's own height under the top the scene passed
    expect(r.pole.y).toBeGreaterThan(580);
    expect([r.cone.x, r.cone.y]).toEqual([130, 500]); // hangs from the cap: the pole top the scene passed
    expect(r.cone.opts?.k).toBe(r.pole.opts?.k);
    expect(render({ x: 0, y: 0 }, 0, LEVELS[3]).cone.scale).toBe(0.75);
    expect(render({ x: 0, y: 0 }, 0, LEVELS[1]).pole.scale).toBe(0.5);
  });

  test("the cone is rotated by the sock angle itself — calm hangs at 0.95 rad, a half easterly at 0.475, a half westerly at −0.475 flipped", () => {
    // sockShape({0,0}, 0).angle = DROOP_CALM = 0.95; at |x| = 1.1 the strength is 0.5 → 0.475 (flutter and bob are 0 at t = 0)
    expect(render({ x: 0, y: 0 }, 0).cone.opts?.rotate).toBeCloseTo(0.95, 9);
    expect(render({ x: 0, y: 0 }, 0).cone.opts?.flipX ?? false).toBe(false);
    const east = render({ x: 1.1, y: 0 }, 0).cone;
    expect(east.opts?.rotate).toBeCloseTo(0.475, 9);
    expect(east.opts?.flipX ?? false).toBe(false);
    const west = render({ x: -1.1, y: 0 }, 0).cone;
    expect(west.opts?.rotate).toBeCloseTo(-0.475, 9);
    expect(west.opts?.flipX).toBe(true);
    expect(render({ x: 3, y: 0 }, 0).cone.opts?.rotate).toBeCloseTo(0, 9); // a full wind lifts it flat
  });

  test("no clip, no repaint, no context state left behind: the two sprite draws are all it does", () => {
    const { calls, props } = render({ x: 1, y: 0 }, 0);
    expect(calls.get("drawImage")).toBe(2);
    expect(calls.get("clip")).toBeUndefined();
    expect(calls.get("fillRect")).toBeUndefined();
    expect(calls.get("arc")).toBeUndefined();
    expect(calls.get("moveTo")).toBeUndefined(); // no striped cone
    expect(calls.get("rotate")).toBeUndefined(); // the rotation goes through the sprite's own opts
    expect(props.has("fillStyle")).toBe(false);
    expect(props.has("globalAlpha")).toBe(false);
  });

  test("sheetSockTop: the pole top for a foot on the horizon, the sprite's own pole height at its world scale", () => {
    expect(sheetSockTop(648)).toBeLessThan(648);
    expect(648 - sheetSockTop(648)).toBeGreaterThan(80);
    expect(648 - sheetSockTop(648)).toBeLessThan(170);
  });

  test("the club-deck path is untouched: no sprites → the striped cone, no drawImage", () => {
    const c = fakeCtx();
    drawWindsock(c.ctx, chrome, 130, 500, { x: 1, y: 0 }, 0);
    expect(c.calls.get("drawImage")).toBeUndefined();
    expect(c.calls.get("moveTo")!).toBeGreaterThan(3);
  });
});

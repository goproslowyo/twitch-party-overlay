import { describe, expect, test } from "bun:test";
import { Fireworks, Particles, SPARKLES, SPARKS_PER_BURST, particleBudget } from "./particles.ts";
import { seededRandom } from "./util.ts";

describe("particles — sparkles + avatars, capped", () => {
  test("particleBudget: what is asked, never past the cap counting what is still alive", () => {
    expect(particleBudget(40, 0, 260)).toBe(40);
    expect(particleBudget(300, 0, 260)).toBe(260);
    expect(particleBudget(100, 200, 260)).toBe(60);
    expect(particleBudget(10, 260, 260)).toBe(0);
  });

  test("a burst spawns inside the span, rising, sparkles or the given glyphs; the cap holds across bursts", () => {
    const P = new Particles();
    const rng = seededRandom(2);
    P.burst(50, 100, 900, 950, 2, ["🎧", "🕺"], 1, 260, rng);
    expect(P.list).toHaveLength(50);
    for (const p of P.list) {
      expect(p.x).toBeGreaterThanOrEqual(100);
      expect(p.x).toBeLessThanOrEqual(900);
      expect(p.y).toBe(950);
      expect(p.vy).toBeLessThan(0);
      expect([...SPARKLES, "🎧", "🕺"]).toContain(p.g);
    }
    expect(P.list.some((p) => SPARKLES.includes(p.g))).toBe(true);
    expect(P.list.some((p) => p.g === "🎧" || p.g === "🕺")).toBe(true);
    P.burst(500, 100, 900, 950, 2, ["🎧"], 1, 260, rng);
    expect(P.list).toHaveLength(260);
  });

  test("particles fall under gravity and die; a longer lifeMul keeps them ~proportionally longer", () => {
    const short = new Particles();
    const long = new Particles();
    short.burst(60, 0, 100, 0, 2, ["·"], 1, 260, seededRandom(5));
    long.burst(60, 0, 100, 0, 2, ["·"], 2.6, 260, seededRandom(5));
    let shortDead = 0;
    let longDead = 0;
    for (let i = 0; i < 2000; i++) {
      short.step(1);
      long.step(1);
      if (shortDead === 0 && short.list.length === 0) shortDead = i;
      if (longDead === 0 && long.list.length === 0) longDead = i;
    }
    expect(shortDead).toBeGreaterThan(80);
    expect(longDead).toBeGreaterThan(shortDead * 2);
    expect(longDead).toBeLessThan(shortDead * 3.2);
  });
});

describe("fireworks — a ring of sparks per burst, no filters", () => {
  test("one burst is SPARKS_PER_BURST sparks in every direction that spread, fall and fade out", () => {
    const F = new Fireworks();
    F.burst(500, 400, "#ffd166", seededRandom(8));
    expect(F.list).toHaveLength(SPARKS_PER_BURST);
    expect(F.list.some((s) => s.vx < -1)).toBe(true);
    expect(F.list.some((s) => s.vx > 1)).toBe(true);
    expect(F.list.some((s) => s.vy < -1)).toBe(true);
    for (let i = 0; i < 40; i++) F.step(1);
    expect(F.list.every((s) => s.life < 1 && s.life > 0)).toBe(true);
    for (let i = 0; i < 200; i++) F.step(1);
    expect(F.list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// sprite particles and fireworks from the Theme Sheet
// ---------------------------------------------------------------------------------------------------------------------
import { defaultConfig } from "../../config/schema.ts";
import { LEVELS } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { PARTICLE_PX, PARTICLE_SPRITES, RAYS_PER_BURST, particleLook, particleTints } from "./particles.ts";

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

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : (..._a: unknown[]) => void calls.set(key, (calls.get(key) ?? 0) + 1)),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("particles on the Chrome Lounge sheet", () => {
  const chrome = defaultConfig().themes["chrome-lounge"]!;

  test("Particles.draw with sprites: one drawImage per particle from spark / chevron / dot tinted lemon / mint / pink, sized by the particle, never fillText", () => {
    const P = new Particles();
    P.burst(120, 100, 900, 950, 2, ["🎧", "🕺"], 1, 400, seededRandom(3));
    const sp = fakeSprites();
    const c = fakeCtx();
    const tints = particleTints(chrome);
    expect(tints).toEqual([chrome.gold, chrome.accent2, chrome.accent]);
    P.draw(c.ctx, sp.set, LEVELS[5], tints);
    expect(c.calls.get("drawImage")).toBe(120);
    expect(c.calls.get("fillText")).toBeUndefined();
    expect(new Set(sp.draws.map((d) => d.name))).toEqual(new Set(PARTICLE_SPRITES));
    expect(new Set(sp.draws.map((d) => d.opts?.colour))).toEqual(new Set(tints));
    expect(new Set(sp.draws.map((d) => d.scale))).toEqual(new Set([1]));
    sp.draws.forEach((d, i) => {
      const p = P.list[i]!;
      expect([d.x, d.y]).toEqual([p.x, p.y]);
      expect(d.opts?.k).toBeCloseTo(p.size / PARTICLE_PX, 9);
      expect(d.opts?.alpha).toBeLessThanOrEqual(1);
      expect(d.opts?.alpha).toBeGreaterThan(0);
      const look = particleLook(p);
      expect(d.name).toBe(look.sprite);
      expect(d.opts?.colour).toBe(tints[look.tint]);
    });
    const sp3 = fakeSprites();
    P.draw(fakeCtx().ctx, sp3.set, LEVELS[3], tints);
    expect(new Set(sp3.draws.map((d) => d.scale))).toEqual(new Set([0.75]));
  });

  test("the look is a pure function of the whole-pixel size: the club-deck's dice are untouched and the null path still paints glyphs", () => {
    expect(particleLook({ size: 15 })).toEqual(particleLook({ size: 15 }));
    expect(new Set([14, 15, 16, 17, 18, 19, 20, 21, 22].map((size) => particleLook({ size }).sprite)).size).toBe(3);
    expect(new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((size) => particleLook({ size }).tint)).size).toBe(3);
    const rng = seededRandom(2);
    const first = rng();
    const P = new Particles();
    P.burst(1, 100, 900, 950, 2, ["🎧"], 1, 400, seededRandom(2));
    expect(P.list[0]!.x).toBeCloseTo(100 + first * 800, 9); // the first draw is still the x
    const c = fakeCtx();
    P.draw(c.ctx);
    expect(c.calls.get("fillText")).toBe(1);
    expect(c.calls.get("drawImage")).toBeUndefined();
  });

  test("Fireworks.draw with sprites: a burst is 14 firework-ray rays fanned a full turn about the burst in its colour, growing and fading, gone when its sparks are", () => {
    const F = new Fireworks();
    F.burst(500, 400, "#ffd166", seededRandom(8));
    expect(RAYS_PER_BURST).toBe(14);
    const sp = fakeSprites();
    const c = fakeCtx();
    F.draw(c.ctx, sp.set, LEVELS[5]);
    expect(c.calls.get("drawImage")).toBe(14);
    expect(c.calls.get("arc")).toBeUndefined();
    expect(sp.draws.every((d) => d.name === "firework-ray" && d.x === 500 && d.y === 400 && d.opts?.colour === "#ffd166" && d.scale === 1)).toBe(true);
    const rots = sp.draws.map((d) => d.opts!.rotate!).sort((a, b) => a - b);
    for (let i = 1; i < rots.length; i++) expect(rots[i]! - rots[i - 1]!).toBeCloseTo((Math.PI * 2) / 14, 6);
    const k0 = sp.draws[0]!.opts!.k!;
    const a0 = sp.draws[0]!.opts!.alpha!;
    for (let i = 0; i < 30; i++) F.step(1);
    const sp2 = fakeSprites();
    F.draw(fakeCtx().ctx, sp2.set, LEVELS[5]);
    expect(sp2.draws[0]!.opts!.k!).toBeGreaterThan(k0);
    expect(sp2.draws[0]!.opts!.alpha!).toBeLessThan(a0);
    for (let i = 0; i < 200; i++) F.step(1);
    const sp3 = fakeSprites();
    F.draw(fakeCtx().ctx, sp3.set, LEVELS[5]);
    expect(sp3.draws).toHaveLength(0);
    expect(F.list).toHaveLength(0);
    // the club-deck path: one arc per spark, no image
    const G = new Fireworks();
    G.burst(500, 400, "#ffd166", seededRandom(8));
    const c2 = fakeCtx();
    G.draw(c2.ctx);
    expect(c2.calls.get("arc")).toBe(SPARKS_PER_BURST);
    expect(c2.calls.get("drawImage")).toBeUndefined();
  });
});

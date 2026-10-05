import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../config/schema.ts";
import { type Chatter, LOCKED_GLYPH, type Mote, type OverlayOutcome, type OverlaySkin } from "../../server/overlay.ts";
import type { View } from "../state.ts";
import { LEVELS, type LevelSpec } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { PASSENGER_ROTATE_MS, passengers } from "./blimp.ts";
import { RESHUFFLE_AFTER_TIER_MS } from "./drop.ts";
import { CLUB_LABEL_MS, depthScale } from "./floor.ts";
import { BLOOM_LEVEL, PARTICLE_LEVEL, PARTICLE_STRIDE } from "../light/layer.ts";
import { ORBIT_MAX, ORBIT_MIN, jumperOrbit } from "./motes.ts";
import { LIGHT_BLOOM_LEVEL, LIGHT_PARTICLE_LEVEL, LIGHT_PARTICLE_STRIDE, SKY_Y, Scene, THANKS_GLOW_MS, celebrationTier, createScene, sceneLayout, type DropEvent } from "./scene.ts";
import { TOWER_W, sheetTowerX, type Tower } from "./towers.ts";

const base = defaultConfig();
const club = base.themes["club-deck"]!;
const skin = (side: "left" | "right" = "right", over: Partial<OverlaySkin["config"]> = {}): OverlaySkin => ({ config: { ...base.overlay, side, ...over }, theme: club, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });
const level = () => LEVELS[5];

function outcomes(tier: number): OverlayOutcome[] {
  return base.outcomes.map((o) => {
    const open = o.tier <= tier;
    return { id: o.id, name: open ? o.name : null, nameLength: o.name.length, glyph: open ? o.glyph : LOCKED_GLYPH, shape: o.shape, tier: o.tier, left: o.initialLeft, used: 0, status: "live" };
  });
}

function view(over: Partial<View> = {}): View {
  const tier = over.tier ?? 0;
  return { thresholdCents: 5000, progressDisplayCents: 1300, fullCount: 0, queue: 0, bankedTotal: 0, tier, gates: [0, 3, 6], outcomes: outcomes(tier), drained: false, justRevealed: [], motes: { collecting: [], ready: [] }, chatters: [], ...over };
}

/**
 * A recording 2-D context: every method is a counted no-op; every property write is remembered. The canvas's
 * `ownerDocument` hands out further fake canvases (the Scene's offscreen floor cache) sharing the same recorder;
 * `created` counts them.
 */
/** One recorded context call: the op, the composite and alpha in force, and for drawImage its source. */
interface CtxOp {
  key: string;
  composite: unknown;
  alpha: unknown;
  source?: unknown;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; ctx: Record<string, unknown>; calls: Map<string, number>; ops: CtxOp[]; made: HTMLCanvasElement[]; props: Set<string>; texts: string[]; created: () => number } {
  const calls = new Map<string, number>();
  const ops: CtxOp[] = [];
  const made: HTMLCanvasElement[] = [];
  const props = new Set<string>();
  const texts: string[] = [];
  const gradient = { addColorStop(): void {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 7 });
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        const op: CtxOp = { key, composite: target.globalCompositeOperation ?? "source-over", alpha: target.globalAlpha ?? 1 };
        if (key === "drawImage") op.source = args[0];
        ops.push(op);
        if (key === "fillText" && typeof args[0] === "string") texts.push(args[0]);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      props.add(key);
      return true;
    },
  });
  const doc = {
    createElement: (): unknown => {
      const c = make();
      made.push(c);
      return c;
    },
  };
  const make = (): HTMLCanvasElement => ({ width: 0, height: 0, getContext: () => ctx, ownerDocument: doc }) as unknown as HTMLCanvasElement;
  return { canvas: make(), ctx, calls, ops, made, props, texts, created: () => made.length };
}

interface SpriteDraw {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
  /** The context's composite operation at the moment of the draw. */
  op: unknown;
}

/** A SpriteSet that records every `draw(name, scale, x, y, opts)` and puts one `drawImage` on the context per call. */
function fakeSprites(): { set: SpriteSet; names: string[]; scales: SheetScale[]; draws: SpriteDraw[] } {
  const names: string[] = [];
  const scales: SheetScale[] = [];
  const draws: SpriteDraw[] = [];
  const set: SpriteSet = {
    id: "chrome-lounge",
    setDetail: () => {},
    get: () => ({ image: {} as CanvasImageSource, frame: { x: 0, y: 0, w: 10, h: 10, ax: 5, ay: 5, kind: "master" }, scale: 1 }),
    has: () => true,
    names: () => [...new Set(names)],
    draw(ctx, name, scale, x, y, opts) {
      names.push(name);
      scales.push(scale);
      draws.push({ name, scale, x, y, opts, op: (ctx as unknown as Record<string, unknown>)["globalCompositeOperation"] });
      ctx.drawImage({} as CanvasImageSource, 0, 0);
    },
  };
  return { set, names, scales, draws };
}

describe("sceneLayout — the scene beside the rack, mirrored when the rack is on the left", () => {
  test("rack on the right at 1080p: full-width floor, pads between the towers, the lock tile on the rack side", () => {
    const L = sceneLayout(1920, 1080, "right", 300, true);
    expect(L.flip).toBe(false);
    expect(L.floorX0).toBe(40);
    expect(L.floorX1).toBe(1880); // the floor runs under the rack
    expect(L.gy).toBe(1080 - 112);
    expect(L.floorTop).toBe(1080 - 118);
    expect(L.floorBottom).toBe(1080 - 18); // ~15 px off the bottom edge
    expect(L.sceneL).toBe(40);
    expect(L.sceneR).toBe(1920 - 400 - 10); // rack span = width + 40 + 60
    expect(L.padStrip).toEqual({ x: 40 + 150 + 30, w: 1510 - 40 - 300 - 60 - 150 });
    expect(L.lock).toEqual({ x: L.padStrip.x + L.padStrip.w + 10, w: 130 });
    expect(L.towerX).toEqual([40, 84, 128, 1484, 1440, 1396]);
    expect(L.windsockX).toBe(1510 - 154);
    expect(L.patrol).toEqual({ min: 40 + 230, max: 1510 - 230, home: 330, facing: 1 });
  });

  test("rack on the left is the exact mirror", () => {
    const R = sceneLayout(1920, 1080, "right", 300, true);
    const L = sceneLayout(1920, 1080, "left", 300, true);
    const m = (x: number): number => 1920 - x;
    expect(L.flip).toBe(true);
    expect([L.floorX0, L.floorX1]).toEqual([m(R.floorX1), m(R.floorX0)]);
    expect([L.sceneL, L.sceneR]).toEqual([m(R.sceneR), m(R.sceneL)]);
    expect(L.padStrip.x + L.padStrip.w).toBe(m(R.padStrip.x));
    expect(L.padStrip.w).toBe(R.padStrip.w);
    expect(L.lock!.x + L.lock!.w).toBe(m(R.lock!.x));
    expect(L.towerX.map((x) => x + 26)).toEqual([3, 4, 5, 0, 1, 2].map((i) => m(R.towerX[i]!))); // side 0 ↔ side 1
    expect(L.windsockX).toBe(m(R.windsockX));
    expect(L.patrol).toEqual({ min: m(R.patrol.max), max: m(R.patrol.min), home: m(R.patrol.home), facing: -1 });
    expect(L.gy).toBe(R.gy);
  });

  test("with every tier open the lock tile goes and the pads take its room", () => {
    const withLock = sceneLayout(1920, 1080, "right", 300, true);
    const open = sceneLayout(1920, 1080, "right", 300, false);
    expect(open.lock).toBeNull();
    expect(open.padStrip.w).toBe(withLock.padStrip.w + 150);
    expect(open.padStrip.x).toBe(withLock.padStrip.x);
    const left = sceneLayout(1920, 1080, "left", 300, false);
    expect(left.padStrip.x).toBe(sceneLayout(1920, 1080, "left", 300, true).padStrip.x - 150);
  });
});

describe("Scene — the canvas port behind the scene interface", () => {
  test("geometry: the pad strip, the door following the patrol, the floor top", () => {
    const { canvas } = fakeCanvas();
    const scene = createScene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    expect(canvas.width).toBe(1920);
    const g0 = scene.geometry();
    expect(g0.floorTop).toBe(1080 - 118);
    expect(g0.padStrip).toEqual({ x: 220, y: 1080 - 112 + 4, w: 960, h: 54 });
    expect(g0.door).toEqual({ x: 330 + 126, y: 120, facing: 1 });
    scene.step(0, 0);
    scene.draw(view(), 0);
    for (let t = 16; t < 3000; t += 16) scene.step(t, 16);
    const g1 = scene.geometry();
    expect(g1.door.x).toBeGreaterThan(g0.door.x); // the blimp moved on; the door moved with it
    expect(g1.door.facing).toBe(1);
  });

  test("mirrored geometry on the left: the door leads the other way and the strip sits on the far side", () => {
    const { canvas } = fakeCanvas();
    const scene = createScene(canvas, () => skin("left"), level);
    scene.resize(1920, 1080);
    const g = scene.geometry();
    expect(g.door.facing).toBe(-1);
    expect(g.door.x).toBe(1920 - 330 - 126);
    expect(g.padStrip.x).toBe(1920 - 220 - 960);
  });

  test("draws every layer from the view with no filter, shadow or clock of its own; every word comes from copy.ts", () => {
    const { canvas, calls, props, texts } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    scene.step(0, 0);
    scene.draw(view({ queue: 8 }), 0);
    scene.setDropsInAir(1); // one in the air: a pad the view says ran out (the model releases that at the reveal) keeps its width, greyed with its tag
    const v = view({ queue: 8, outcomes: outcomes(0).map((o) => (o.id === "accent-switch" ? { ...o, left: 0, used: o.left } : o)) });
    scene.step(16, 16);
    scene.draw(v, 16);
    scene.step(32, 16); // the pads move in `step` against the last drawn view: one more frame shows the spent pad
    scene.draw(v, 32);
    expect(calls.get("clearRect")).toBe(3);
    expect(calls.get("fill")!).toBeGreaterThan(100);
    expect(props.has("filter")).toBe(false);
    expect(props.has("shadowBlur")).toBe(false);
    expect(texts).toContain("DONE");
    expect(texts).toContain("×5");
    expect(texts).toContain("×8"); // the ×N badge alone carries the READY count
    expect(texts.join("\n")).not.toMatch(/\+\d/); // no +N seat
    for (const g of passengers(club, 0)) expect(texts).toContain(g); // the seven generic Passengers, always aboard
    expect(texts).toContain("$13");
    expect(texts).toContain("of $50");
    expect(texts).toContain("EXIT");
    expect(texts).toContain("EXAMPLESTREAMER");
    expect(texts).toContain("TIER 1"); // the tower caption and the lock tile's line
    expect(texts).toContain("8 HIDDEN");
    expect(texts).toContain("3 UNLOCKS AWAY");
    expect(texts).toContain("🔒");
    expect(texts.join("\n")).not.toMatch(/PIE|POLAROID|SHIRT/); // pads carry glyphs and counts only, never a name
  });

  test("a FULL hold paints the sign in gold with the stacked label; the drained pool says so; no lock tile once every tier is open", () => {
    const { canvas, texts } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    scene.step(0, 0);
    scene.draw(view({ progressDisplayCents: 5000, fullCount: 2 }), 0);
    expect(texts).toContain("$50");
    expect(texts).toContain("of $50 · FULL ×2");
    texts.length = 0;
    scene.draw(view({ tier: 2, drained: true }), 16);
    expect(texts).toContain("POOL DRAINED — THE CROWD DID IT");
    expect(texts.some((t) => t.endsWith("HIDDEN"))).toBe(false);
  });

  test("dropsInAir freezes the pads; cue(energy) reaches the envelope; wind is the drop's field at the ground row", () => {
    const { canvas } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    const v = view();
    for (let t = 0; t < 8000; t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    const before = scene.pads().map((p) => ({ id: p.id, x: p.x, w: p.w }));
    scene.setDropsInAir(2);
    const spent = view({ outcomes: outcomes(0).map((o) => (o.id === "stickers" ? { ...o, left: 0, used: o.left } : o)) });
    for (let t = 8000; t < 9000; t += 16) {
      scene.step(t, 16);
      scene.draw(spent, t);
    }
    expect(scene.pads().map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before);
    scene.setDropsInAir(0);
    for (let t = 9000; t < 20000; t += 16) {
      scene.step(t, 16);
      scene.draw(spent, t);
    }
    expect(scene.pads()[0]!.w).toBeLessThan(1);
    expect(scene.wind().y).toBe(0);
    expect(Math.abs(scene.wind().x)).toBeGreaterThan(0.01); // the cells gust even with an empty sky: the windsock answers
    expect(Math.abs(scene.wind().x)).toBeLessThan(3);
    scene.cue("energy", 1, 20000);
    for (let t = 20000; t < 22000; t += 16) scene.step(t, 16);
    expect(scene.energy()).toBeGreaterThan(0.9);
    scene.cue("beat", 1, 22000); // any other cue is not the scene's
    scene.cue("energy", undefined, 22000);
  });
});

describe("Scene — the drop inside it", () => {
  const fire = (seq: number, outcomeId: string, extra = {}) => ({ fireSeq: seq, outcomeId, solo: null, group: [], stockAfter: 1, ...extra });

  test("a draw before any step is safe (no NaN energy, nothing thrown); step before any draw moves only the sky", () => {
    const { canvas, props } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    expect(() => scene.draw(view(), 0)).not.toThrow();
    expect(Number.isNaN(scene.energy())).toBe(false);
    expect(props.has("filter")).toBe(false);
    const fresh = new Scene(fakeCanvas().canvas, () => skin(), level);
    fresh.resize(1920, 1080);
    expect(fresh.step(0, 16)).toEqual([]);
    expect(fresh.pads()).toEqual([]);
  });

  test("fire → a jumper from the door to its pad; the pads hold through the reveal; `step` returns the reveal, then the drained moment; the shuffle follows", () => {
    const { canvas, texts } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    const v = view();
    for (let t = 0; t < 2000; t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    const before = scene.pads().map((p) => ({ id: p.id, x: p.x, w: p.w }));
    const pad = before.find((p) => p.id === "friend-picks-three")!; // a value snapshot: the live pad moves in the shuffle later
    scene.fire(fire(1, "friend-picks-three", { stockAfter: 0 }), 2000);
    scene.drained();
    expect(scene.frozen()).toBe(true);
    const spent = view({ outcomes: outcomes(0).map((o) => (o.id === "friend-picks-three" ? { ...o, left: 0, used: o.left } : o)), drained: true });
    const events: Array<{ t: number; e: DropEvent }> = [];
    let thawedAt = -1;
    for (let t = 2000; t < 40000; t += 16) {
      for (const e of scene.step(t, 16)) events.push({ t, e });
      if (thawedAt < 0 && !scene.frozen()) thawedAt = t;
      if (thawedAt < 0) expect(scene.pads().map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before); // the DONE pad stays in place
      scene.draw(spent, t);
    }
    expect(events.map((x) => x.e.kind)).toEqual(["reveal", "drained"]);
    const reveal = events[0]!.e;
    expect(reveal).toMatchObject({ kind: "reveal", n: 1, total: 1, fire: { outcomeId: "friend-picks-three", stockAfter: 0 }, padX: pad.x + pad.w / 2 });
    expect(events[0]!.t).toBeGreaterThan(2000 + 12000 / 1.45 - 100);
    expect(events[1]!.t - events[0]!.t).toBeGreaterThanOrEqual(base.overlay.revealMs);
    expect(thawedAt).toBe(events[1]!.t);
    expect(texts).toContain("🔀 SHUFFLING THE PADS");
    expect(texts).toContain("POOL DRAINED — THE CROWD DID IT"); // painted once the reveal has played, beside the lock tile
    expect(scene.pads().find((p) => p.id === "friend-picks-three")!.w).toBeLessThan(1); // collapsed after the thaw
    expect(texts.some((t) => t.startsWith("@") || t === "Anonymous")).toBe(false); // communal: no handle over the jumper, ever
  });

  test("a solo fire (`solo: \"alice\"`) reaches the reveal event for main.ts's banner; the canvas itself never paints her, and the jumper wears no avatar", () => {
    const { canvas, calls, texts } = fakeCanvas();
    const marks = ["🅰", "🅱", "🅲", "🅳", "🅴", "🅵", "🅶", "🅷"]; // avatars no pad glyph shares, so every one painted is a Passenger's
    const marked: OverlaySkin = { ...skin(), theme: { ...club, avatars: marks } };
    const scene = new Scene(canvas, () => marked, level);
    scene.resize(1920, 1080);
    const v = view();
    for (let t = 0; t < 2000; t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    scene.fire(fire(1, "stickers", { solo: "alice", stockAfter: 4 }), 2000);
    const events: DropEvent[] = [];
    for (let t = 2000; t < 30000 && events.length === 0; t += 16) {
      events.push(...scene.step(t, 16));
      scene.draw(v, t);
    }
    expect(events[0]).toMatchObject({ kind: "reveal", fire: { outcomeId: "stickers", solo: "alice" } });
    expect(texts.join("\n")).not.toMatch(/alice|@|Anonymous/);
    expect(texts.filter((t) => marks.includes(t))).toHaveLength(0); // queue 0: the gondola is dark glass, so any Passenger glyph would be on the jumper — there is none
  });

  test("the last tier opens while a jumper is in the air: its pads are dealt into the lock tile's space, frozen pads stay, and a fire on one of them lands on it", () => {
    const { canvas } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    const v0 = view({ gates: [0, 3] }); // two tiers: tier 1 is the last, so its opening takes the lock tile away
    for (let t = 0; t < 2000; t += 16) {
      scene.step(t, 16);
      scene.draw(v0, t);
    }
    const strip0 = scene.geometry().padStrip;
    const before = scene.pads().map((p) => ({ id: p.id, x: p.x, w: p.w }));
    scene.fire(fire(1, "stickers"), 2000);
    scene.step(2000, 16);
    scene.draw(v0, 2000);
    const v1 = view({ tier: 1, gates: [0, 3] });
    scene.tierOpen(2016);
    scene.step(2016, 16);
    scene.draw(v1, 2016); // the lock tile goes: the strip grows on the rack's side
    const strip1 = scene.geometry().padStrip;
    expect(strip1.w).toBe(strip0.w + 150);
    scene.step(2032, 16);
    scene.draw(v1, 2032);
    const dealt = scene.pads();
    expect(dealt).toHaveLength(before.length + 8);
    expect(dealt.slice(0, before.length).map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before); // nothing moved under the jumper
    expect(dealt[before.length]!.x).toBeCloseTo(strip0.x + strip0.w, 3);
    const shirt = dealt.find((p) => p.id === "shirt-t1")!;
    expect(shirt.w).toBeGreaterThan(0);
    scene.fire(fire(2, "shirt-t1"), 2048);
    const events: Array<{ t: number; e: DropEvent }> = [];
    for (let t = 2048; t < 40000 && events.length < 2; t += 16) {
      for (const e of scene.step(t, 16)) events.push({ t, e });
      if (scene.frozen()) expect(scene.pads().slice(0, before.length).map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before);
      scene.draw(v1, t);
    }
    const reveal = events.find((x) => x.e.kind === "reveal" && x.e.fire.outcomeId === "shirt-t1")!.e;
    expect(reveal).toMatchObject({ kind: "reveal", padX: shirt.x + shirt.w / 2 });
    expect(Math.abs((reveal.kind === "reveal" ? reveal.padX : 0) - (strip1.x + strip1.w / 2))).toBeGreaterThan(50); // not the strip's centre
  });

  test("celebrate: the crowd tier, particles under the cap, lasers from 0.45; tierOpen deals + reshuffles when idle", () => {
    expect([0, 0.2, 0.45, 0.7, 1].map(celebrationTier)).toEqual([1, 2, 3, 4, 4]);
    const { canvas, calls } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    const v = view();
    scene.step(0, 16);
    scene.draw(v, 0);
    scene.celebrate(0.78, "🎧", 16);
    const fillsBefore = calls.get("fillText") ?? 0;
    for (let t = 16; t < 3000; t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    expect((calls.get("fillText") ?? 0) - fillsBefore).toBeGreaterThan(3000); // ~200 particles a frame for a while
    const order = scene.pads().map((p) => p.id);
    scene.tierOpen(3000);
    const v1 = view({ tier: 1 });
    for (let t = 3000; t < 9000; t += 16) {
      scene.step(t, 16);
      scene.draw(v1, t);
    }
    const after = scene.pads().map((p) => p.id);
    expect(after).toHaveLength(order.length + 8);
    expect(after.slice(0, 12)).not.toEqual(order); // dealt in among the old ones, then shuffled
    expect(scene.frozen()).toBe(false);
    expect(SKY_Y).toBe(60);
  });
});

describe("the scene's sources: no clocks, no timers, no filters", () => {
  test("no scene module reads a clock, sets a timer, or uses a canvas filter/shadow", () => {
    const dir = import.meta.dir;
    const modules = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(modules.sort()).toEqual(["blimp.ts", "dancer-figure.ts", "dancers.ts", "drop.ts", "floor.ts", "jumper.ts", "motes.ts", "pads.ts", "particles.ts", "scene.ts", "towers.ts", "util.ts", "wind.ts", "windsock.ts"]);
    for (const f of modules) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|Math\.random/);
      expect(src, f).not.toMatch(/\.filter\s*=|shadowBlur|shadowColor/);
      expect(src, f).not.toMatch(/from "\.\.\/\.\.\/server\/(?!overlay\.ts")/); // nothing server-only
    }
  });
});

describe("Scene — the Quality Level thunk and the Quiet Scene inputs", () => {
  test("shuffling(t) follows the drop's shuffle: off idle, on from the tier's reshuffle delay through shuffleMs, off after", () => {
    const { canvas } = fakeCanvas();
    const scene = new Scene(canvas, () => skin(), level);
    scene.resize(1920, 1080);
    expect(scene.shuffling(0)).toBe(false);
    scene.tierOpen(1000);
    expect(scene.shuffling(1000)).toBe(false);
    expect(scene.shuffling(1000 + RESHUFFLE_AFTER_TIER_MS)).toBe(true);
    expect(scene.shuffling(1000 + RESHUFFLE_AFTER_TIER_MS + base.overlay.shuffleMs - 1)).toBe(true);
    expect(scene.shuffling(1000 + RESHUFFLE_AFTER_TIER_MS + base.overlay.shuffleMs)).toBe(false);
    expect(scene.frozen()).toBe(false); // a shuffle is not a freeze: the two are separate Quiet Scene inputs
  });

  test("the level thunk reaches the drop: a celebration's burst is capped by the level in force at that moment", () => {
    const glyphsAt = (lvl: (typeof LEVELS)[keyof typeof LEVELS]): number => {
      const { canvas, calls } = fakeCanvas();
      let current = LEVELS[3];
      const scene = new Scene(canvas, () => skin(), () => current);
      scene.resize(1920, 1080);
      const v = view();
      scene.step(0, 16);
      scene.draw(v, 0);
      current = lvl; // switched after construction: read at the burst, not at boot
      const before = calls.get("fillText") ?? 0;
      scene.celebrate(1, "🎧", 1000);
      scene.step(1016, 16);
      scene.draw(v, 1016);
      return (calls.get("fillText") ?? 0) - before;
    };
    const rich = glyphsAt(LEVELS[5]);
    const lean = glyphsAt(LEVELS[1]);
    expect(rich - lean).toBe(LEVELS[5].particleCap - LEVELS[1].particleCap); // 400 vs 30 particle glyphs over the same scene text
  });
});

describe("Scene — the Chrome Lounge sheet path", () => {
  const chrome = base.themes["chrome-lounge"]!;
  const chromeSkin = (): OverlaySkin => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge" }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });

  /** Boot the scene on the sheet, let the towers light and the aims walk for 2 s, then record exactly one frame. */
  function frame(lvl: LevelSpec, opts: { spent?: boolean; skin?: () => OverlaySkin; sprites?: (() => SpriteSet | null) | undefined } = {}) {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, opts.skin ?? chromeSkin, () => lvl, opts.sprites ?? (() => sp.set));
    scene.resize(1920, 1080);
    scene.step(0, 16);
    let v = view({ queue: 8 });
    scene.draw(v, 0);
    for (let t = 16; t < 2000; t += 16) scene.step(t, 16);
    if (opts.spent === true) {
      scene.setDropsInAir(1); // one in the air: a pad the view says ran out keeps its width, greyed with its tag
      v = view({ queue: 8, outcomes: outcomes(0).map((o) => (o.id === "accent-switch" ? { ...o, left: 0, used: o.left } : o)) });
      scene.step(2000, 16);
      scene.draw(v, 2000);
    }
    fake.calls.clear();
    fake.texts.length = 0;
    sp.names.length = 0;
    sp.scales.length = 0;
    sp.draws.length = 0;
    scene.step(2016, 16);
    scene.draw(v, 2016);
    return { ...fake, scene, names: sp.names, scales: sp.scales, draws: sp.draws };
  }

  test("Level 5: floor, sweeps, pools, lasers, smoke, extruded pads and plates all come from the sheet; the words are still text", () => {
    const { calls, props, texts, names, scales, ctx, created, scene } = frame(LEVELS[5], { spent: true });
    expect(calls.get("drawImage")!).toBeGreaterThan(60);
    for (const n of ["beam-wedge", "beam-core", "beam-pool", "pad-top-live", "pad-front-live", "pad-halo", "pad-gloss", "plate", "horizon-glow", "laser-halo", "smoke-0", "smoke-1", "smoke-2", "tower-head", "tower-head-dark", "pad-top-done", "pad-top-lock"]) expect(names, n).toContain(n);
    expect(new Set(scales)).toEqual(new Set([1]));
    expect(props.has("filter")).toBe(false);
    expect(props.has("shadowBlur")).toBe(false);
    expect(props.has("globalCompositeOperation")).toBe(true); // the `lighter` passes …
    expect(ctx.globalCompositeOperation).toBe("source-over"); // … each restored
    expect(texts).toContain("×5");
    expect(texts).toContain("DONE");
    expect(texts).toContain("TIER 1");
    expect(texts.join("\n")).not.toMatch(/PIE|POLAROID|SHIRT/); // glyphs and counts only, never a name
    // the strip's tail: one anonymous lock pad per hidden Outcome of the next Tier, one gold label under the run, no lock tile
    expect(names.filter((n) => n === "pad-top-lock")).toHaveLength(8);
    expect(texts.filter((t) => t === "🔒")).toHaveLength(8);
    expect(texts).toContain("TIER 1 · 8 HIDDEN");
    expect(texts).toContain("3 UNLOCKS AWAY");
    expect(texts).not.toContain("8 HIDDEN");
    expect(scene.geometry().padStrip.w).toBe(960 + 150); // the lock zone is the strip's
    expect(scene.pads()).toHaveLength(20);
    expect(scene.pads().slice(12).every((p) => p.locked === true)).toBe(true);
    const ws = new Set(scene.pads().map((p) => Math.round(p.w * 100)));
    expect(ws.size).toBe(1); // equal slots
    expect(created()).toBe(1); // one offscreen floor cache for the resolution
    // the plates go down before the glow: the first `plate` of the frame precedes the first halo / pool
    expect(names.indexOf("plate")).toBeLessThan(names.indexOf("pad-halo"));
    expect(names.indexOf("plate")).toBeLessThan(names.indexOf("beam-pool"));
  });

  test("Level 4: the same picture as Level 5 with the sweep wedge and core at 0.7 of their size; the pool and plate where the beam lands are unchanged", () => {
    const five = frame(LEVELS[5]);
    const four = frame(LEVELS[4]);
    const k = (draws: SpriteDraw[], name: string) => draws.filter((d) => d.name === name).map((d) => d.opts?.k);
    expect(k(four.draws, "beam-wedge")).toEqual(k(five.draws, "beam-wedge").map((x) => x! * 0.7));
    expect(k(four.draws, "beam-core")).toEqual(k(five.draws, "beam-core").map((x) => x! * 0.7));
    expect(k(four.draws, "beam-pool")).toEqual(k(five.draws, "beam-pool"));
    expect(four.names.some((n) => n.startsWith("smoke-"))).toBe(true);
  });

  test("Level 1: no sweeps, no lasers, no smoke — pads, plates, heads and the horizon still drawn, from the 0.5× sheet", () => {
    const { names, scales, calls } = frame(LEVELS[1]);
    for (const n of ["beam-wedge", "beam-core", "beam-pool", "laser-halo"]) expect(names, n).not.toContain(n);
    expect(names.some((n) => n.startsWith("smoke-"))).toBe(false);
    for (const n of ["pad-top-live", "pad-halo", "plate", "horizon-glow", "tower-head"]) expect(names, n).toContain(n);
    expect(new Set(scales)).toEqual(new Set([0.5]));
    expect(calls.get("drawImage")!).toBeGreaterThan(30);
  });

  test("Level 3: lasers on, smoke off, sweeps on, from the 0.75× sheet", () => {
    const { names, scales } = frame(LEVELS[3]);
    expect(names).toContain("laser-halo");
    expect(names).toContain("beam-wedge");
    expect(names.some((n) => n.startsWith("smoke-"))).toBe(false);
    expect(new Set(scales)).toEqual(new Set([0.75]));
  });

  test("Level 2: no sweeps (they go with the lasers), smoke off, from the 0.75× sheet", () => {
    const { names, scales } = frame(LEVELS[2]);
    for (const n of ["beam-wedge", "beam-core", "beam-pool", "laser-halo"]) expect(names, n).not.toContain(n);
    expect(names.some((n) => n.startsWith("smoke-"))).toBe(false);
    expect(new Set(scales)).toEqual(new Set([0.75]));
  });

  test("the sheet still decoding (null) on a sheet Theme, or a set present under a procedural Theme: the club-deck drawing runs, no drawImage", () => {
    const decoding = frame(LEVELS[5], { sprites: () => null });
    expect(decoding.calls.get("drawImage")).toBeUndefined();
    expect(decoding.names).toEqual([]);
    expect(decoding.calls.get("fill")!).toBeGreaterThan(100);
    const club = frame(LEVELS[5], { skin: () => skin() });
    expect(club.calls.get("drawImage")).toBeUndefined();
    expect(club.names).toEqual([]);
    expect(club.texts).toContain("×5");
  });

  test("a tier opening washes that tier's new pads white for 25 s (pad-top-new), then they are plain live tiles", () => {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, chromeSkin, () => LEVELS[5], () => sp.set);
    scene.resize(1920, 1080);
    scene.step(0, 16);
    scene.draw(view(), 0);
    expect(sp.names).not.toContain("pad-top-new"); // the boot deal is not a reveal
    const v1 = view({ tier: 1 });
    scene.tierOpen(1000, 1);
    scene.step(1000, 16);
    scene.draw(v1, 1000); // the pads move in `step` against the last drawn view: the new Tier's pads deal in from here
    for (let t = 1016; t < 3000; t += 16) scene.step(t, 16);
    sp.names.length = 0;
    scene.draw(v1, 3000);
    expect(sp.names).toContain("pad-top-new");
    expect(sp.names.filter((n) => n === "pad-top-lock")).toHaveLength(5); // Tier 1's eight locks are live pads now; Tier 2's five wait
    expect(fake.texts).toContain("TIER 2 · 5 HIDDEN");
    for (let t = 3000; t < 27000; t += 16) scene.step(t, 16);
    sp.names.length = 0;
    scene.draw(v1, 27000);
    expect(sp.names).not.toContain("pad-top-new");
  });

  test("a jumper in the air rings the pad it is heading for (pad-top-under) until it lands", () => {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, chromeSkin, () => LEVELS[5], () => sp.set);
    scene.resize(1920, 1080);
    const v = view();
    for (let t = 0; t < 2000; t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    sp.names.length = 0;
    scene.draw(v, 2000);
    expect(sp.names).not.toContain("pad-top-under");
    scene.fire({ fireSeq: 1, outcomeId: "stickers", solo: null, group: [], stockAfter: 4 }, 2000);
    scene.step(2016, 16);
    sp.names.length = 0;
    scene.draw(v, 2016);
    expect(sp.names).toContain("pad-top-under");
    expect(sp.names.filter((n) => n === "pad-top-under")).toHaveLength(1);
    for (let t = 2032; t < 40000 && scene.frozen(); t += 16) {
      scene.step(t, 16);
      scene.draw(v, t);
    }
    sp.names.length = 0;
    scene.step(40000, 16);
    scene.draw(v, 40000);
    expect(sp.names).not.toContain("pad-top-under");
  });
});

describe("Scene — the Chrome Lounge moving pieces", () => {
  const chrome = base.themes["chrome-lounge"]!;
  const chromeSkin = (side: "left" | "right" = "right"): OverlaySkin => ({ config: { ...base.overlay, side, theme: "chrome-lounge" }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });

  /** A scene on the sheet at Level `lvl`, run to `untilMs` in 16 ms frames (drawing each), the recorders cleared, then one more frame recorded at `untilMs + 16`. */
  function run(lvl: LevelSpec, untilMs: number, act: (scene: Scene, t: number) => void = () => {}, side: "left" | "right" = "right", v: View = view({ queue: 8 })) {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, () => chromeSkin(side), () => lvl, () => sp.set);
    scene.resize(1920, 1080);
    for (let t = 0; t <= untilMs; t += 16) {
      act(scene, t);
      scene.step(t, 16);
      scene.draw(v, t);
    }
    fake.calls.clear();
    fake.texts.length = 0;
    sp.names.length = 0;
    sp.scales.length = 0;
    sp.draws.length = 0;
    const t = untilMs + 16;
    scene.step(t, 16);
    scene.draw(v, t);
    return { ...fake, scene, names: sp.names, scales: sp.scales, draws: sp.draws, t };
  }

  test("idle: the airship is fins → body → stripe → gloss → prop → seven windows → light → badge from the sheet; seven Passengers and the ×N are text; no sign, no dollar figure, no EXIT", () => {
    const { names, texts, calls, t } = run(LEVELS[5], 2000);
    const at = (n: string): number => names.indexOf(n);
    expect(at("fins")).toBeGreaterThanOrEqual(0);
    expect(at("fins")).toBeLessThan(at("ship-body"));
    expect(at("ship-body")).toBeLessThan(at("ship-stripe"));
    expect(at("ship-stripe")).toBeLessThan(at("ship-gloss"));
    expect(names).toContain(`propeller-${Math.floor(t / 40) % 4}`);
    expect(names.filter((n) => n === "gondola-window")).toHaveLength(7);
    expect(names).toContain("ship-light");
    expect(names).toContain("ready-badge");
    expect(names).toContain("windsock-pole");
    expect(names).toContain("windsock-cone");
    expect(texts.filter((s) => chrome.avatars.includes(s)).slice(-7)).toEqual(passengers(chrome, t)); // after the pads' glyphs (one Outcome wears 🎧 too)
    expect(texts).toContain("×8");
    expect(texts.join("\n")).not.toMatch(/\$|EXIT|NEXT UNLOCK|\+\d|@/);
    expect(calls.get("ellipse")).toBeUndefined(); // no procedural envelope, no procedural canopy
    expect(new Set(run(LEVELS[1], 2040).names.filter((n) => n.startsWith("propeller-")))).toEqual(new Set(["propeller-2"])); // t = 2056 → frame 3 → Level 1 shows 2
  });

  test("the Passengers rotate on the loop's clock, never a contributor: the seats after one rotation are the next glyphs along", () => {
    const a = run(LEVELS[5], 200).texts.filter((s) => chrome.avatars.includes(s)).slice(-7);
    const b = run(LEVELS[5], PASSENGER_ROTATE_MS + 200).texts.filter((s) => chrome.avatars.includes(s)).slice(-7);
    expect(a).toHaveLength(7);
    expect(b).toHaveLength(7);
    expect(b).not.toEqual(a);
    expect(b[0]).toBe(a[1]);
  });

  test("the club-deck skin under the same sprites still hangs the `$X of $Y` sign under its gondola", () => {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, () => skin(), () => LEVELS[5], () => sp.set);
    scene.resize(1920, 1080);
    scene.step(0, 16);
    scene.draw(view(), 0);
    expect(fake.texts.some((s) => s.includes("$"))).toBe(true);
    expect(fake.texts).toContain("EXIT");
    expect(sp.names).toEqual([]);
  });

  test("the windsock stands beside the outer TIER 0 tower on the rack's far side, its foot on the horizon — mirrored with the rack", () => {
    const right = run(LEVELS[5], 200);
    const L = sceneLayout(1920, 1080, "right", base.overlay.rackWidth, false);
    const towerLeft = sheetTowerX({ sideI: 0, tier: 0 } as Tower, { sceneL: L.sceneL, sceneR: L.sceneR });
    const sock = right.draws.find((d) => d.name === "windsock-pole")!;
    expect(sock.opts?.colour).toBe(chrome.accent);
    const cone = right.draws.find((d) => d.name === "windsock-cone")!;
    expect(cone.opts?.colour).toBe(chrome.accent);
    expect([sock.x, sock.y]).toEqual([right.scene.windsockAt().x, right.scene.windsockAt().footY]); // the pole stands on the foot the scene reports
    expect(cone.x).toBe(sock.x);
    expect(cone.y).toBeLessThan(sock.y - 100); // the cone hangs from the cap, a pole's length up
    const left = run(LEVELS[5], 200, () => {}, "left");
    const sockL = left.draws.find((d) => d.name === "windsock-pole")!;
    expect(sockL.opts?.colour).toBe(chrome.accent);
    // the scene tells where it put the pole
    expect(right.scene.windsockAt().x).toBeGreaterThan(towerLeft + TOWER_W);
    expect(right.scene.windsockAt().x).toBeLessThan(towerLeft + TOWER_W + 60);
    expect(right.scene.windsockAt().footY).toBe(L.horizonY + 8);
    const LL = sceneLayout(1920, 1080, "left", base.overlay.rackWidth, false);
    const towerRight = sheetTowerX({ sideI: 1, tier: 0 } as Tower, { sceneL: LL.sceneL, sceneR: LL.sceneR });
    expect(left.scene.windsockAt().x).toBeLessThan(towerRight);
    expect(left.scene.windsockAt().x).toBeGreaterThan(towerRight - 60);
    // the club-deck answers with its own foot: the pole top is WINDSOCK_UP (120) over the ground line and the pole POLE_H (160) tall
    const fake = fakeCanvas();
    const club = createScene(fake.canvas, () => skin(), () => LEVELS[5], () => null);
    club.resize(1920, 1080);
    const at = club.windsockAt();
    expect(at.x).toBe(L.windsockX);
    expect(at.footY).toBe(L.gy - 120 + 160);
    expect(at.footY).toBeGreaterThan(L.gy);
  });

  test("a fire: the jumper is the sheet's shadow + canopy (theme colours) + risers + pilot with no text; the canopy comes down from the door and the shadow sharpens", () => {
    const fireAt = (scene: Scene, t: number): void => {
      if (t === 2000) scene.fire({ fireSeq: 1, outcomeId: "stickers", solo: null, group: [], stockAfter: 4 }, t);
    };
    const early = run(LEVELS[5], 2100, fireAt);
    expect(early.scene.jumpers()).toHaveLength(1);
    for (const n of ["pilot-shadow-0", "canopy-a", "canopy-b", "canopy-gloss", "risers", "pilot"]) expect(early.names, n).toContain(n);
    const idx = (n: string): number => early.names.indexOf(n);
    expect(idx("canopy-a")).toBeLessThan(idx("canopy-b"));
    expect(idx("canopy-b")).toBeLessThan(idx("canopy-gloss"));
    expect(idx("canopy-gloss")).toBeLessThan(idx("risers"));
    expect(idx("risers")).toBeLessThan(idx("pilot"));
    expect(idx("pilot-shadow-0")).toBeLessThan(idx("canopy-a"));
    expect(early.draws.find((d) => d.name === "canopy-a")!.opts?.colour).toBe(chrome.canopy[0]);
    expect(early.draws.find((d) => d.name === "canopy-b")!.opts?.colour).toBe(chrome.canopy[1]);
    expect(early.texts.join("\n")).not.toMatch(/alice|@|Anonymous/);
    const late = run(LEVELS[5], 2000 + 11000, fireAt);
    const J = late.scene.jumpers()[0];
    if (J !== undefined && J.y > SKY_Y + 0.9 * (late.scene.geometry().padStrip.y + 27 - SKY_Y)) expect(late.names).toContain("pilot-shadow-2");
    expect(late.names.some((n) => n.startsWith("pilot-shadow-"))).toBe(J !== undefined || late.scene.landed().length > 0); // a landed pose keeps its sharp shadow through the banner (MUST 1)
  });

  test("a celebration on the sheet: particles are spark / chevron / dot images tinted from the Theme and the fireworks are firework-ray fans — no particle glyphs", () => {
    const { names, draws, texts } = run(LEVELS[5], 1200, (scene, t) => {
      if (t >= 1000 && t < 1016) scene.celebrate(1, "🎧", t); // the first frame past 1 s (t steps by 16)
    });
    for (const n of ["spark", "chevron", "dot", "firework-ray"]) expect(names, n).toContain(n);
    expect(names.filter((n) => n === "firework-ray").length % 14).toBe(0);
    const tints = new Set([chrome.gold, chrome.accent2, chrome.accent]);
    expect(draws.filter((d) => ["spark", "chevron", "dot"].includes(d.name)).every((d) => tints.has(d.opts?.colour ?? ""))).toBe(true);
    const glyphs = (list: readonly string[]): number => list.filter((s) => s === "🎧" || s === "✦" || s === "✧" || s === "★").length;
    expect(glyphs(texts)).toBe(glyphs(run(LEVELS[5], 1200).texts)); // no particle glyphs: the same avatar / sparkle texts as an idle frame (a Passenger and a pad wear 🎧)
    expect(draws.filter((d) => ["spark", "chevron", "dot"].includes(d.name)).length).toBeLessThanOrEqual(LEVELS[5].particleCap);
    const lean = run(LEVELS[1], 1200, (scene, t) => {
      if (t >= 1000 && t < 1016) scene.celebrate(1, "🎧", t); // the first frame past 1 s (t steps by 16)
    });
    expect(lean.draws.filter((d) => ["spark", "chevron", "dot"].includes(d.name)).length).toBeLessThanOrEqual(LEVELS[1].particleCap);
    expect(lean.draws.filter((d) => ["spark", "chevron", "dot"].includes(d.name)).length).toBeGreaterThan(0);
  });

  test("thank(t): the thanks-glow once behind the Acknowledgement line — a plate first, then the glow under `lighter`, fading out over a second; nothing on the club-deck", () => {
    const thankAt = (scene: Scene, t: number): void => {
      if (t >= 1000 && t < 1016) scene.thank(t);
    };
    const on = run(LEVELS[5], 1200, thankAt);
    const glow = on.draws.find((d) => d.name === "thanks-glow")!;
    expect(glow).toBeDefined();
    expect(glow.op).toBe("lighter");
    expect(glow.opts?.colour).toBe(chrome.gold);
    const plateBefore = on.draws.slice(0, on.draws.indexOf(glow)).filter((d) => d.name === "plate");
    expect(plateBefore.length).toBeGreaterThan(0);
    const plate = plateBefore[plateBefore.length - 1]!;
    expect([plate.x, plate.y]).toEqual([glow.x, glow.y]);
    expect(plate.op).toBe("source-over");
    expect(on.ctx.globalCompositeOperation).toBe("source-over");
    // centred on the scene like #thanks (left: 50% − (rackW / 2 + 50)); #thanks's box TOP is at 70 % of the height
    // (styles.css: top:70%, translate(-50%, 0)) and the box is ~53 px tall (24 px text, 10 px padding, 2 px border), so
    // the glow sits on the line's centre, THANKS_LINE_HALF_H (26) below that
    expect(glow.x).toBeCloseTo(1920 / 2 - (base.overlay.rackWidth / 2 + 50), 6);
    expect(glow.y).toBeCloseTo(1080 * 0.7 + 26, 6);
    // the plate is at least as wide as the glow it backs (plate 256 × k vs thanks-glow 512), so no `lighter` falls on bare scene
    expect((plate.opts?.k ?? 1) * 256).toBeGreaterThanOrEqual(512 * (glow.opts?.k ?? 1));
    const later = run(LEVELS[5], 1000 + THANKS_GLOW_MS - 100, thankAt);
    const glowLater = later.draws.find((d) => d.name === "thanks-glow")!;
    expect(glowLater.opts!.alpha!).toBeLessThan(glow.opts!.alpha!);
    const off = run(LEVELS[5], 1000 + THANKS_GLOW_MS + 16, thankAt);
    expect(off.names).not.toContain("thanks-glow");
    expect(THANKS_GLOW_MS).toBe(1000);
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const club = createScene(fake.canvas, () => skin(), () => LEVELS[5], () => sp.set);
    club.resize(1920, 1080);
    club.thank(0);
    club.step(16, 16);
    club.draw(view(), 16);
    expect(sp.names).toEqual([]);
  });
});

describe("Scene — the Dancers on the sheet", () => {
  const chrome = base.themes["chrome-lounge"]!;
  const chromeSkin = (): OverlaySkin => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge" }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });

  /** Three seconds on the sheet at `lvl`, then the sprite names of exactly one more frame. */
  function dancerFrame(lvl: LevelSpec): { names: string[]; calls: Map<string, number> } {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, chromeSkin, () => lvl, () => sp.set);
    scene.resize(1920, 1080);
    scene.step(0, 16);
    scene.draw(view(), 0);
    for (let t = 16; t < 3000; t += 16) scene.step(t, 16);
    sp.names.length = 0;
    fake.calls.clear();
    scene.step(3000, 16);
    scene.draw(view(), 3000);
    return { names: sp.names, calls: fake.calls };
  }

  test("the far floor fills on a sheet: 24 Dancers (reflection, body, rim each) after the floor's glow and before the tower bodies; the club-deck keeps its own crowd", () => {
    const { names } = dancerFrame(LEVELS[5]);
    const first = names.findIndex((n) => n.startsWith("dancer-"));
    expect(first).toBeGreaterThan(names.indexOf("horizon-glow"));
    expect(first).toBeLessThan(names.indexOf("tower-head-dark"));
    expect(names.filter((n) => /^dancer-[a-zA-Z]+-\d$/.test(n))).toHaveLength(48); // 24 × (reflection + body)
    expect(names.filter((n) => /^dancer-.*-rim(-flip)?$/.test(n))).toHaveLength(48);
    const club = fakeCanvas();
    const deck = createScene(club.canvas, () => skin(), level);
    deck.resize(1920, 1080);
    deck.step(0, 16);
    deck.draw(view(), 0);
    deck.step(16, 16);
    deck.draw(view(), 16);
    expect(club.calls.get("drawImage") ?? 0).toBe(0); // no sheet, no sprites — and no Dancers
  });

  test("the same roster at Level 1 as at Level 5 — only the Sheet Scale changes", () => {
    const one = dancerFrame(LEVELS[1]).names.filter((n) => n.startsWith("dancer-"));
    const five = dancerFrame(LEVELS[5]).names.filter((n) => n.startsWith("dancer-"));
    expect(one).toHaveLength(96);
    expect(one).toEqual(five);
  });

  test("Active Chatters on the sheet: three chatters → three more head clips than the empty floor, no mote-ring; a hop names its sender; the club-deck keeps its own crowd", () => {
    const three: Chatter[] = [1, 2, 3].map((i) => ({ key: `k${i}`, name: `chatter${i}`, avatarUrl: `https://example.test/${i}.png`, firstSeenMs: 0, lastSeenMs: i * 1000 }));
    const run = (chatters: Chatter[], hop: boolean) => {
      const fake = fakeCanvas();
      const sp = fakeSprites();
      const scene = createScene(fake.canvas, chromeSkin, () => LEVELS[5], () => sp.set, () => null, () => ({}) as CanvasImageSource);
      scene.resize(1920, 1080);
      const v = view({ chatters });
      scene.step(0, 33);
      scene.draw(v, 0);
      for (let t = 33; t < 20_000; t += 33) {
        scene.step(t, 33);
        if (hop && t > 10_000) scene.chatHop("k1", t);
        scene.draw(v, t);
      }
      fake.calls.clear();
      fake.texts.length = 0;
      sp.names.length = 0;
      scene.step(20_000, 33);
      if (hop) scene.chatHop("k1", 20_000);
      scene.draw(v, 20_000);
      return { clips: fake.calls.get("clip") ?? 0, texts: fake.texts, names: sp.names };
    };
    const empty = run([], false);
    const full = run(three, true);
    expect(full.clips - empty.clips).toBe(3);
    expect(full.names).not.toContain("mote-ring");
    expect(full.texts).toContain("chatter1");
    expect(empty.texts).not.toContain("chatter1");
    const club = fakeCanvas();
    const deck = createScene(club.canvas, () => skin(), level, () => null, () => null, () => ({}) as CanvasImageSource);
    deck.resize(1920, 1080);
    deck.step(0, 16);
    deck.draw(view({ chatters: three }), 0);
    deck.chatHop("k1", 16);
    deck.step(16, 16);
    deck.draw(view({ chatters: three }), 16);
    expect(club.calls.get("drawImage") ?? 0).toBe(6); // no sheet, no sprites, no Dancers: the club-deck draws its own heads, three per frame over the two frames
  });

  test("the roster syncs while the room is hidden (floorOpacity 0): chatters walk on behind the slider, so the frame it comes back up finds them standing and a hop names its sender", () => {
    const three: Chatter[] = [1, 2, 3].map((i) => ({ key: `k${i}`, name: `chatter${i}`, avatarUrl: `https://example.test/${i}.png`, firstSeenMs: 0, lastSeenMs: i * 1000 }));
    let floorOpacity = 0;
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, () => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge", floorOpacity }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } }), () => LEVELS[5], () => sp.set, () => null, () => ({}) as CanvasImageSource);
    scene.resize(1920, 1080);
    const v = view({ chatters: three });
    for (let t = 0; t < 20_000; t += 33) {
      scene.step(t, 33);
      scene.draw(v, t);
    }
    expect(sp.names.filter((n) => n.startsWith("dancer-"))).toEqual([]); // hidden: nothing of the room was painted
    floorOpacity = 100; // the streamer slides the room back up
    scene.step(20_000, 33);
    scene.chatHop("k1", 20_000);
    fake.texts.length = 0;
    scene.draw(v, 20_000);
    expect(fake.texts).toContain("chatter1"); // standing already: the hop lands and the label shows (a walker ignores a hop)
  });
});

describe("Scene — the club-deck wears the roster", () => {
  const image = (url: string | null): CanvasImageSource | null => (url === null ? null : ({} as CanvasImageSource));
  const person = (key: string, name: string, firstSeenMs: number): Chatter => ({ key, name, avatarUrl: `https://x/${key}.png`, firstSeenMs, lastSeenMs: firstSeenMs });
  const three = [person("a", "al", 1), person("b", "bo", 2), person("c", "cy", 3)];
  const names = (texts: string[]): string[] => texts.filter((t) => ["al", "bo", "cy"].includes(t));

  /** A club-deck scene (no sheet) drawn twice against `list`; `hop` hops everyone at 16 ms; the second frame's calls and texts come back. */
  function deck(list: Chatter[], hop: boolean, lvl: LevelSpec = LEVELS[5], nameLength = 12) {
    const fake = fakeCanvas();
    const scene = createScene(fake.canvas, () => ({ ...skin(), chatters: { ...skin().chatters, nameLength } }), () => lvl, () => null, () => null, image);
    scene.resize(1920, 1080);
    scene.step(0, 16);
    scene.draw(view({ chatters: list }), 0);
    if (hop) for (const c of list) scene.chatHop(c.key, 16);
    scene.step(16, 16);
    fake.calls.clear();
    fake.texts.length = 0;
    scene.draw(view({ chatters: list }), 32);
    return { scene, fake };
  }

  test("three chatters on the club-deck: three pictures through three arc clips on the centre bobbers, their names after a Hop, none of it with nobody chatting", () => {
    const none = deck([], false).fake;
    const quiet = deck(three, false).fake;
    const hopped = deck(three, true).fake;
    expect(none.calls.get("drawImage") ?? 0).toBe(0);
    expect(quiet.calls.get("drawImage") ?? 0).toBe(3);
    expect(hopped.calls.get("drawImage") ?? 0).toBe(3);
    expect((hopped.calls.get("clip") ?? 0) - (none.calls.get("clip") ?? 0)).toBe(3);
    expect(names(none.texts)).toEqual([]);
    expect(names(quiet.texts)).toEqual([]); // no Hop yet, and every cadence is off at 32 ms
    expect(names(hopped.texts)).toEqual(["bo", "al", "cy"]); // bobbers 22, 23, 24 left to right
  });

  test("the Level's cap reaches the club-deck: 70 chatters seat 12 at Level 1 and 46 (the bobbers) at Level 5", () => {
    const seventy = Array.from({ length: 70 }, (_, i) => person(`p${i}`, `person${i}`, i));
    expect(deck(seventy, false, LEVELS[1]).fake.calls.get("drawImage")).toBe(12);
    expect(deck(seventy, false, LEVELS[5]).fake.calls.get("drawImage")).toBe(46);
  });

  test("nameLength rides the skin onto the plate", () => {
    const { fake } = deck([person("a", "bartholomew", 1)], true, LEVELS[5], 4);
    expect(fake.texts).toContain("bar…");
    expect(fake.texts).not.toContain("bartholomew");
  });

  test("a Hop's plate is gone once CLUB_LABEL_MS has passed (the scene forgets the Hop in step)", () => {
    const { scene, fake } = deck([person("a", "al", 1)], true);
    expect(names(fake.texts)).toEqual(["al"]);
    for (let t = 48; t <= 5000; t += 16) scene.step(t, 16);
    fake.texts.length = 0;
    scene.draw(view({ chatters: [person("a", "al", 1)] }), 5000);
    expect(names(fake.texts)).toEqual([]); // 4 s over; "a"'s own cadence is off at 5000 ((5000 + 41661) % 42220 = 4441)
    expect(CLUB_LABEL_MS).toBe(4000);
  });
});

describe("Scene — the light layer's sources", () => {
  const chrome = base.themes["chrome-lounge"]!;
  const chromeSkin = (): OverlaySkin => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge" }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });
  const unit = (c: readonly number[]): boolean => c.length === 3 && c.every((v) => v >= 0 && v <= 1);

  /** Boot the scene on the sheet (or the club-deck), celebrate at 1 s so the lasers come up, run to `untilMs`, and read the frame's lights. */
  function lit(lvl: LevelSpec, untilMs = 3000, opts: { club?: boolean; celebrate?: boolean } = {}) {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, opts.club === true ? () => skin() : chromeSkin, () => lvl, () => sp.set);
    scene.resize(1920, 1080);
    const v = view({ queue: 8 });
    let t = 0;
    for (; t <= untilMs; t += 16) {
      if (opts.celebrate !== false && t >= 1000 && t < 1016) scene.celebrate(1, "🎧", t);
      scene.step(t, 16);
      scene.draw(v, t);
    }
    sp.draws.length = 0;
    scene.step(t, 16);
    scene.draw(v, t);
    return { scene, lights: scene.lights(), draws: sp.draws, t, pads: scene.pads() };
  }

  test("Level 5, lasers up: five segments per lit head, each leaving that head's point, 300–1140 px long on the boards' floor (scaled by the config floor's depth), in unit colour, dimmer than the stroke", () => {
    const { lights, scene } = lit(LEVELS[5]);
    const k = depthScale(sceneLayout(1920, 1080, "right", base.overlay.rackWidth, false).horizonY, 1080); // the default floorPercent's depth over the boards' 440
    const heads = lights.points.slice(0, 2); // the two lit TIER 0 towers come first
    expect(lights.segments.length).toBeGreaterThanOrEqual(5);
    expect(lights.segments.length).toBe(5 * heads.length);
    for (const s of lights.segments) {
      expect(heads.some((h) => h.x === s.x0 && h.y === s.y0)).toBe(true);
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      expect(len).toBeGreaterThanOrEqual(300 * k - 1e-6);
      expect(len).toBeLessThanOrEqual(1140 * k + 1e-6);
      expect(unit(s.colour)).toBe(true);
      expect(s.strength).toBeGreaterThan(0);
      expect(s.strength).toBeLessThan(0.8); // under LASER_STROKE_ALPHA: the halo is the dimmer of the two
    }
    expect(new Set(lights.segments.map((s) => s.colour.join(","))).size).toBeGreaterThanOrEqual(2); // the fan alternates the tower's tint and the accent
    expect(scene.lights().segments).toEqual(lights.segments); // pure: the same frame answers the same
  });

  test("points: the lit tower heads, the running light riding its 1 Hz swell, and one per lit pad — none for a lock pad", () => {
    const a = lit(LEVELS[5], 3000);
    const b = lit(LEVELS[5], 3250);
    const livePads = a.pads.filter((p) => p.w >= 3 && p.live && p.locked !== true).length;
    const lockPads = a.pads.filter((p) => p.locked === true).length;
    expect(livePads).toBeGreaterThan(0);
    expect(lockPads).toBeGreaterThan(0);
    expect(a.lights.points).toHaveLength(2 + 1 + livePads);
    for (const p of a.lights.points) {
      expect(unit(p.colour)).toBe(true);
      expect(p.r).toBeGreaterThan(0);
      expect(p.strength).toBeGreaterThan(0);
      expect(p.strength).toBeLessThanOrEqual(1);
    }
    // the running light: the one point whose strength moved a quarter-swell later while its neighbours held still
    const ship = a.lights.points[2]!;
    const shipLater = b.lights.points[2]!;
    expect(ship.strength).not.toBeCloseTo(shipLater.strength, 3);
    expect(a.lights.points[0]!.strength).toBeCloseTo(b.lights.points[0]!.strength, 3);
    // pad halos sit on the strip, under the touchdown line's neighbourhood
    const strip = a.scene.geometry().padStrip;
    for (const p of a.lights.points.slice(3)) {
      expect(p.x).toBeGreaterThan(strip.x - 20);
      expect(p.x).toBeLessThan(strip.x + strip.w + 20);
      expect(Math.abs(p.y - strip.y)).toBeLessThan(80);
    }
  });

  test("particles: seven floats per 2-D particle in flight (position, size, unit colour, alpha), never past the level's cap, none once the burst has gone", () => {
    const { lights, draws } = lit(LEVELS[5], 1200);
    const sprites = draws.filter((d) => ["spark", "chevron", "dot"].includes(d.name));
    expect(sprites.length).toBeGreaterThan(0);
    expect(lights.particles.length % 7).toBe(0);
    expect(lights.particles.length / 7).toBeGreaterThanOrEqual(sprites.length); // every drawn particle, plus the firework sparks the sheet lets fly unseen (the layer applies its own per-level cap)
    for (let o = 0; o < lights.particles.length; o += 7) {
      const [x, y, size, r, g, b, alpha] = Array.from(lights.particles.subarray(o, o + 7)) as [number, number, number, number, number, number, number];
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(size).toBeGreaterThan(0);
      expect(unit([r, g, b])).toBe(true);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThanOrEqual(1);
    }
    const drawn = new Set(sprites.map((d) => `${Math.fround(d.x)},${Math.fround(d.y)}`)); // the buffer holds float32
    let matched = 0;
    for (let o = 0; o < lights.particles.length; o += 7) if (drawn.has(`${lights.particles[o]},${lights.particles[o + 1]}`)) matched++;
    expect(matched).toBe(sprites.length); // the same positions the 2-D frame drew — no second simulation
    expect(lit(LEVELS[5], 3000, { celebrate: false }).lights.particles).toHaveLength(0);
  });

  test("Level 4 lists bloom and particles; Level 3 hands over particles only (the layer draws no bloom there — nothing built to be discarded); Levels 1–2, the club-deck and a scene before its first draw hand over nothing", () => {
    const four = lit(LEVELS[4], 1200).lights;
    expect(four.segments.length).toBeGreaterThanOrEqual(5);
    expect(four.points.length).toBeGreaterThan(0);
    expect(four.particles.length).toBeGreaterThan(0);
    const three = lit(LEVELS[3], 1200).lights;
    expect(three.segments).toEqual([]);
    expect(three.points).toEqual([]);
    expect(three.particles.length).toBeGreaterThan(0);
    expect(three.particles.length % LIGHT_PARTICLE_STRIDE).toBe(0);
    const none = (l: ReturnType<Scene["lights"]>): void => {
      expect(l.segments).toEqual([]);
      expect(l.points).toEqual([]);
      expect(l.particles).toHaveLength(0);
    };
    none(lit(LEVELS[2], 1200).lights);
    none(lit(LEVELS[1], 1200).lights);
    none(lit(LEVELS[5], 1200, { club: true }).lights);
    const fake = fakeCanvas();
    const fresh = createScene(fake.canvas, chromeSkin, () => LEVELS[5], () => fakeSprites().set);
    fresh.resize(1920, 1080);
    fresh.step(0, 16);
    none(fresh.lights());
  });

  test("the scene mirrors the layer's floors and stride (pinned equal) and imports nothing but types from light/ — the WebGL module stays out of the scene's graph", () => {
    expect(LIGHT_PARTICLE_LEVEL).toBe(PARTICLE_LEVEL);
    expect(LIGHT_BLOOM_LEVEL).toBe(BLOOM_LEVEL);
    expect(LIGHT_PARTICLE_STRIDE).toBe(PARTICLE_STRIDE);
    const dir = path.join(import.meta.dir);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const line of src.split("\n").filter((l) => /from\s+"\.\.\/light\//.test(l))) expect(line, `${f}: ${line}`).toMatch(/^import type /);
    }
  });
});

describe("Scene — Contributor Motes in the free sky", () => {
  const chrome = base.themes["chrome-lounge"]!;
  /** A short descent (~3 s at the fastest sink rate) so a whole drop fits a test. */
  const chromeSkin = (): OverlaySkin => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge", descentMs: 6000 }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });
  const mote = (key: string, cents: number, over: Partial<Mote> = {}): Mote => ({ key, name: key, avatar: "🦄", avatarUrl: null, cents, ...over });
  const group: Mote[] = [mote("k1", 500), mote("k2", 1500), mote("k3", 9000), { key: "k4", name: null, avatar: "", avatarUrl: null, cents: 300 }];
  const ringNames = new Set(["mote-ring", "mote-ring-gold"]);

  /** A scene on the sheet (or the club-deck), stepped and drawn in 16 ms frames against `viewAt(t)`; `snap(t)` records exactly the frame at `t`. */
  function boot(sheet: boolean, viewAt: (t: number) => View, avatarImage?: (m: Mote) => CanvasImageSource | null) {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, sheet ? chromeSkin : () => skin(), () => LEVELS[5], sheet ? () => sp.set : () => null, avatarImage);
    scene.resize(1920, 1080);
    let t = 0;
    const runTo = (until: number): void => {
      for (; t < until; t += 16) {
        scene.step(t, 16);
        scene.draw(viewAt(t), t);
      }
    };
    const snap = (until: number) => {
      runTo(until);
      fake.calls.clear();
      fake.texts.length = 0;
      sp.names.length = 0;
      sp.draws.length = 0;
      scene.step(t, 16);
      scene.draw(viewAt(t), t);
      const rings = sp.draws.filter((d) => ringNames.has(d.name));
      const at = t;
      t += 16;
      return { t: at, rings, names: [...sp.names], texts: [...fake.texts], calls: new Map(fake.calls) };
    };
    return { scene, snap };
  }

  test("collecting: the wire's motes rise from the thank line into the free sky — rings over the towers and sweeps, under the airship, never over the rack or below the horizon; the glyph inside, never a name", () => {
    const wire = { collecting: group, ready: [] as Mote[][] };
    const { snap } = boot(true, (t) => (t < 500 ? view() : view({ motes: wire })));
    const { rings, names, texts } = snap(4000);
    expect(rings).toHaveLength(4);
    const L = sceneLayout(1920, 1080, "right", base.overlay.rackWidth, false);
    for (const r of rings) {
      expect(r.x).toBeGreaterThanOrEqual(L.sceneL);
      expect(r.x).toBeLessThanOrEqual(L.sceneR);
      expect(r.y).toBeGreaterThanOrEqual(40);
      expect(r.y).toBeLessThan(L.horizonY);
      expect(r.name).toBe("mote-ring");
      expect(r.opts?.colour).toBe(chrome.accent);
    }
    const first = names.findIndex((n) => ringNames.has(n));
    for (const under of ["tower-head", "beam-wedge", "beam-core"]) expect(names.lastIndexOf(under), under).toBeLessThan(first);
    expect(names.indexOf("ship-body")).toBeGreaterThan(first);
    expect(texts.filter((s) => s === "🦄")).toHaveLength(3); // three named motes' glyphs; the anonymous one draws nothing inside
    expect(texts.join("\n")).not.toMatch(/k[1-4]/);
  });

  test("READY, fire, orbit, landing: the group holds under the airship, orbits the jumper at r × [1.2, 2.2] all the way down, bursts at touchdown and is gone within a second", () => {
    let fired = false;
    const ready = view({ queue: 1, motes: { collecting: [], ready: [group] } });
    const after = view({ motes: { collecting: [], ready: [] } });
    const { scene, snap } = boot(true, (t) => (t < 500 ? view() : fired ? after : ready));
    const held = snap(3000);
    expect(held.rings).toHaveLength(4);
    const door = scene.geometry().door;
    for (const r of held.rings) {
      expect(r.y).toBeGreaterThan(120 + 134); // under the gondola (its bottom is 134 under the envelope centre), never over the envelope
      expect(r.y).toBeLessThan(120 + 300);
      expect(Math.abs(r.x - (door.x - 126))).toBeLessThan(160); // about the airship's centre (the door is 126 ahead of it)
    }
    scene.fire({ fireSeq: 1, outcomeId: "stickers", solo: null, group, stockAfter: 4 }, held.t + 16);
    fired = true;
    const mid = snap(held.t + 1500);
    expect(scene.jumpers()).toHaveLength(1);
    const J = jumperOrbit(scene.jumpers()[0]!, true);
    expect(mid.rings).toHaveLength(4);
    for (const r of mid.rings) {
      const d = Math.hypot(r.x - J.x, r.y - J.y);
      expect(d).toBeGreaterThanOrEqual(J.r * ORBIT_MIN - 1e-6);
      expect(d).toBeLessThanOrEqual(J.r * ORBIT_MAX + 1e-6);
    }
    expect(mid.texts.join("\n")).not.toMatch(/k[1-4]/);
    let t = mid.t;
    while (scene.jumpers().length > 0 && t < mid.t + 12000) t = snap(t + 160).t; // ride the descent down (sink rate varies ±40 %)
    expect(scene.jumpers()).toHaveLength(0);
    const burst = snap(t + 160);
    expect(burst.rings.length).toBeGreaterThan(0); // still bursting
    expect(burst.names).toContain("mote-spark-0");
    // a burst starts at full and fades over the second (item 7): 160–320 ms in it is already under 0.85, and well over the cloud's faint end
    expect(burst.rings.every((r) => (r.opts?.alpha ?? 1) <= 0.85 && (r.opts?.alpha ?? 0) > 0.5)).toBe(true);
    expect(snap(t + 1200).rings).toHaveLength(0); // gone within a second of touchdown
  });

  test("the club-deck strokes circles under the same rules, and a decoded Avatar Picture goes through an arc clip in place of the glyph", () => {
    const wire = { collecting: group, ready: [] as Mote[][] };
    const club = boot(false, (t) => (t < 500 ? view() : view({ motes: wire }))).snap(3000);
    expect(club.names).toEqual([]);
    expect(club.texts.filter((s) => s === "🦄")).toHaveLength(3);
    expect(club.texts.join("\n")).not.toMatch(/k[1-4]/);
    expect(club.calls.get("stroke")!).toBeGreaterThanOrEqual(8); // the ring and its wider, dimmer halo per mote, over the club-deck's own strokes
    const plain = boot(true, (t) => (t < 500 ? view() : view({ motes: wire }))).snap(3000);
    expect(plain.texts.filter((s) => s === "🦄")).toHaveLength(3);
    const img = {} as CanvasImageSource;
    const pictured = { collecting: group.map((m) => (m.key === "k1" ? { ...m, avatarUrl: "https://static-cdn.jtvnw.net/k1.png" } : m)), ready: [] as Mote[][] };
    const shot = boot(true, (t) => (t < 500 ? view() : view({ motes: pictured })), (m) => (m.avatarUrl === null ? null : img)).snap(3000);
    expect(shot.rings).toHaveLength(4);
    expect(shot.texts.filter((s) => s === "🦄")).toHaveLength(2); // k1 wears its picture
    expect(shot.calls.get("clip") ?? 0).toBe((plain.calls.get("clip") ?? 0) + 1); // one arc clip more than the same frame without the picture
  });
});

describe("the dance floor's share of the frame (overlay.floorPercent)", () => {
  const chrome = base.themes["chrome-lounge"]!;

  test("sceneLayout's sixth argument is the floor's share of the height: the config default is 33 % (horizon 723.6 at 1080p); the boards' 640 comes back at 440 / 1080; every x and the ground line stay put", () => {
    const boards = sceneLayout(1920, 1080, "right", 300, false, 440 / 1080);
    const S = sceneLayout(1920, 1080, "right", 300, false, 0.33);
    expect(boards.horizonY).toBeCloseTo(640, 9);
    expect(S.horizonY).toBeCloseTo(723.6, 6);
    expect(S.vanish.y).toBeLessThan(S.horizonY);
    expect({ ...S, horizonY: boards.horizonY, vanish: boards.vanish }).toEqual(boards);
    expect(sceneLayout(1920, 1080, "right", 300, false).horizonY).toBeCloseTo((1 - base.overlay.floorPercent / 100) * 1080, 6); // no argument: the config default
  });

  test("the Scene lays the sheet's horizon from config.floorPercent — the windsock's foot reports it — and the club-deck ignores it", () => {
    const at = (floorPercent: number, sheet: boolean): number => {
      const fake = fakeCanvas();
      const sp = fakeSprites();
      const scene = createScene(fake.canvas, () => ({ config: { ...base.overlay, side: "right", theme: sheet ? "chrome-lounge" : "club-deck", floorPercent }, theme: sheet ? chrome : club, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } }), () => LEVELS[5], () => (sheet ? sp.set : null));
      scene.resize(1920, 1080);
      return scene.windsockAt().footY;
    };
    expect(at(33, true)).toBeCloseTo(723.6 + 8, 6);
    expect(at(50, true)).toBeCloseTo(540 + 8, 6);
    expect(at(33, false)).toBe(at(50, false));
  });
});

describe("the room's opacity (overlay.floorOpacity): the floor, Dancers, towers, smoke, beams, lasers and windsock dim; the pads, the drop, the airship and the rack never do", () => {
  const chrome = base.themes["chrome-lounge"]!;
  const at = (floorOpacity: number) => {
    const fake = fakeCanvas();
    const sp = fakeSprites();
    const scene = createScene(fake.canvas, () => ({ config: { ...base.overlay, side: "right", theme: "chrome-lounge", floorOpacity }, theme: chrome, channelName: "ExampleStreamer", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } }), () => LEVELS[5], () => sp.set);
    scene.resize(1920, 1080);
    const v = view({ queue: 8 });
    let t = 0;
    for (; t <= 3000; t += 16) {
      if (t >= 1000 && t < 1016) scene.celebrate(1, "🎧", t); // a Celebration: the lasers come up
      scene.step(t, 16);
      scene.draw(v, t); // the pads lay out against the drawn View
    }
    fake.calls.clear();
    fake.ops.length = 0;
    sp.names.length = 0;
    scene.step(t, 16);
    scene.draw(v, t);
    return { fake, sp, scene };
  };
  test("at 100 the room paints straight onto the stage (no extra canvas, no extra blit); under 100 only the over-pads pass uses the room canvas", () => {
    const full = at(100);
    const half = at(50);
    expect(half.fake.created()).toBe(full.fake.created() + 1); // one room canvas, made once, for the over-pads pass
    expect(half.fake.calls.get("drawImage")).toBe((full.fake.calls.get("drawImage") ?? 0) + 1); // the room blitted ONCE a frame: over the pads; the under-pads pass is knocked back in place
    expect(half.sp.names.filter((n) => n.startsWith("pad") || n.startsWith("tile"))).toEqual(full.sp.names.filter((n) => n.startsWith("pad") || n.startsWith("tile")));
    expect(half.sp.names).toContain("horizon-glow");
    expect(half.sp.names).toContain("tower-head-dark");
    // no destination-out at 100: the stage is never knocked back
    expect(full.fake.ops.filter((o) => o.key === "fillRect" && o.composite === "destination-out")).toEqual([]);
  });
  test("under 100 the under-pads pass (floor, Dancers, towers) is painted straight and knocked back by exactly one destination-out rect at 1 − opacity, before the first pad; the over-pads pass still goes through the room canvas", () => {
    const half = at(50);
    const ops = half.fake.ops;
    const knocks = ops.filter((o) => o.key === "fillRect" && o.composite === "destination-out");
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.alpha).toBeCloseTo(0.5, 9);
    // the knock-back comes after the floor and towers and before any pad: the sheet draws before it are the room's, none a pad
    const knockAt = ops.indexOf(knocks[0]!);
    const sheetDrawsBefore = ops.slice(0, knockAt).filter((o) => o.key === "drawImage" && !half.fake.made.includes(o.source as HTMLCanvasElement)).length;
    const roomNames = half.sp.names.slice(0, sheetDrawsBefore);
    expect(roomNames).toContain("horizon-glow");
    expect(roomNames).toContain("tower-head-dark");
    expect(roomNames.filter((n) => n.startsWith("pad") || n.startsWith("tile"))).toEqual([]);
    expect(half.sp.names.slice(sheetDrawsBefore).some((n) => n.startsWith("pad"))).toBe(true);
    // the room canvas is blitted once (the over-pads pass), after the knock-back; the floor cache blit is the other canvas draw
    const canvasBlits = ops.map((o, i) => ({ o, i })).filter(({ o }) => o.key === "drawImage" && half.fake.made.includes(o.source as HTMLCanvasElement));
    const roomBlits = canvasBlits.filter(({ o }) => o.alpha === 0.5);
    expect(roomBlits).toHaveLength(1);
    expect(roomBlits[0]!.i).toBeGreaterThan(knockAt);
    // both states restored by the end of the frame
    expect(half.fake.ctx.globalCompositeOperation).toBe("source-over");
    expect(half.fake.ctx.globalAlpha).toBe(1);
  });
  test("at 0 the room is not painted at all — the pads and the airship still are", () => {
    const none = at(0);
    for (const n of none.sp.names) expect(n, n).not.toMatch(/^(horizon-glow|tower-head|dancer-|smoke-|windsock-|laser|beam-)/);
    expect(none.sp.names.some((n) => n.startsWith("airship") || n.startsWith("ship") || n.startsWith("gondola") || n.startsWith("blimp"))).toBe(true);
    expect(none.sp.names.some((n) => n.startsWith("pad") || n.startsWith("tile"))).toBe(true);
    expect(none.fake.calls.get("drawImage")).toBe(none.sp.names.length); // one per sprite and nothing else: no floor-cache blit, no room blit — at 0 the room is skipped, not drawn and hidden
    expect(none.fake.ops.filter((o) => o.key === "fillRect" && o.composite === "destination-out")).toEqual([]);
  });
  test("the light layer's laser and tower-head bloom scale with it; the pad halos and the running light keep their strength", () => {
    const full = at(100).scene.lights();
    const half = at(50).scene.lights();
    expect(full.segments.length).toBeGreaterThan(0);
    expect(half.segments.map((s) => s.strength)).toEqual(full.segments.map((s) => s.strength * 0.5));
    const heads = 2;
    half.points.slice(0, heads).forEach((p, i) => expect(p.strength).toBeCloseTo(full.points[i]!.strength * 0.5, 9));
    expect(half.points.slice(heads)).toEqual(full.points.slice(heads));
    expect(at(0).scene.lights().segments).toEqual([]);
  });
});

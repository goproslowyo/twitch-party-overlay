import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/schema.ts";
import type { Mote } from "../../server/overlay.ts";
import { LEVELS } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { BURST_ALPHA, BURST_MS, CLUB_SKY_ABOVE_GROUND, GOLD_MS, MOTE_MAX_ALPHA, ORBIT_ALPHA_MIN, MOTE_MAX_PX, MOTE_MIN_ALPHA, MOTE_MIN_PX, Motes, ORBIT_MAX, ORBIT_MIN, SKY_ABOVE_HORIZON, jumperOrbit, moteSize, moteSky, thin, type MoteFrame } from "./motes.ts";
import { seededRandom } from "./util.ts";

const ANCHOR = 60000;
const theme = defaultConfig().themes["chrome-lounge"]!;

const mote = (key: string, cents: number, over: Partial<Mote> = {}): Mote => ({ key, name: key, avatar: "🎧", avatarUrl: null, cents, ...over });
const anon = (key: string, cents: number): Mote => ({ key, name: null, avatar: "", avatarUrl: null, cents });

const SKY: Omit<MoteFrame, "jumpers" | "ready" | "airship"> = { skyL: 40, skyR: 1510, skyTop: 40, skyBottom: 640, wind: () => ({ x: 0, y: 0 }) };
const frame = (over: Partial<MoteFrame> = {}): MoteFrame => ({ ...SKY, airship: { x: 700, y: 120 }, jumpers: [], ready: false, ...over });
const SPAWN = { x: 760, y: 640 };

function motes(): Motes {
  return new Motes(seededRandom(7), () => ANCHOR);
}

/** Run `n` 16 ms frames from `t0` against `f`; returns the time after the last one. */
function run(m: Motes, t0: number, n: number, f: MoteFrame): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    t += 16;
    m.step(t, 16, f);
  }
  return t;
}

/** A recording 2-D context: counted method calls, remembered property writes, every fillText's string. */
function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number>; texts: string[]; props: Record<string, unknown> } {
  const calls = new Map<string, number>();
  const texts: string[] = [];
  const props: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over" };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key in props) return props[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 7 });
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (key === "fillText" && typeof args[0] === "string") texts.push(args[0]);
      };
    },
    set(_t, key: string, value) {
      props[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, texts, props };
}

interface SpriteDraw {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
}

function fakeSprites(): { set: SpriteSet; draws: SpriteDraw[] } {
  const draws: SpriteDraw[] = [];
  const set: SpriteSet = {
    id: "chrome-lounge",
    setDetail: () => {},
    get: () => ({ image: {} as CanvasImageSource, frame: { x: 0, y: 0, w: 10, h: 10, ax: 5, ay: 5, kind: "master" }, scale: 1 }),
    has: () => true,
    names: () => [],
    draw(ctx, name, scale, x, y, opts) {
      draws.push({ name, scale, x, y, opts });
      ctx.drawImage({} as CanvasImageSource, 0, 0);
    },
  };
  return { set, draws };
}

const rings = (draws: SpriteDraw[]): SpriteDraw[] => draws.filter((d) => d.name === "mote-ring" || d.name === "mote-ring-gold");

describe("moteSize — the ring from the contribution's intensity", () => {
  test("$0 is the smallest, faintest ring; the anchor is the largest, brightest; monotonic between", () => {
    expect(moteSize(0, ANCHOR)).toEqual({ px: MOTE_MIN_PX, alpha: MOTE_MIN_ALPHA });
    expect(moteSize(ANCHOR, ANCHOR)).toEqual({ px: MOTE_MAX_PX, alpha: MOTE_MAX_ALPHA });
    expect(moteSize(ANCHOR * 10, ANCHOR)).toEqual({ px: MOTE_MAX_PX, alpha: MOTE_MAX_ALPHA });
    let last = moteSize(0, ANCHOR);
    for (const cents of [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]) {
      const s = moteSize(cents, ANCHOR);
      expect(s.px).toBeGreaterThanOrEqual(last.px);
      expect(s.alpha).toBeGreaterThanOrEqual(last.alpha);
      last = s;
    }
    expect([MOTE_MIN_PX, MOTE_MAX_PX, MOTE_MIN_ALPHA, MOTE_MAX_ALPHA]).toEqual([28, 52, 0.35, 0.7]);
  });
});

describe("thin — deterministic: the largest cents, then the most recent; never random", () => {
  test("keeps the largest, breaks ties by recency (later in the list = newer), and keeps the wire's order", () => {
    const list = [mote("a", 500), mote("b", 900), mote("c", 500), mote("d", 100), mote("e", 900)];
    expect(thin(list, 3).map((m) => m.key)).toEqual(["b", "c", "e"]); // b + e (900), then c over a (same 500, newer)
    expect(thin(list, 1).map((m) => m.key)).toEqual(["e"]);
    expect(thin(list, 5)).toEqual(list);
    expect(thin(list, Infinity)).toEqual(list);
    expect(thin(list, 0)).toEqual([]);
    expect(thin(list, 3)).toEqual(thin(list, 3)); // the same answer every time
  });
});

describe("Motes — spawn, rise, gather, orbit, burst", () => {
  test("a new key spawns at the thank line and rises: y decreases over the following frames, never above the sky's top", () => {
    const m = motes();
    m.sync({ collecting: [], ready: [] }, 0, SPAWN); // the snapshot: nothing on the wire yet
    m.sync({ collecting: [mote("alice", 1500)], ready: [] }, 1000, SPAWN);
    const b0 = m.bodies();
    expect(b0).toHaveLength(1);
    expect([b0[0]!.x, b0[0]!.y]).toEqual([SPAWN.x, SPAWN.y]);
    let t = 1000;
    let lastY = SPAWN.y;
    for (let i = 0; i < 20; i++) {
      t = run(m, t, 5, frame());
      const y = m.bodies()[0]!.y;
      expect(y).toBeLessThanOrEqual(lastY);
      lastY = y;
    }
    expect(lastY).toBeLessThan(SPAWN.y - 40);
    expect(lastY).toBeGreaterThanOrEqual(SKY.skyTop);
  });

  test("motes stay in the free sky: clamped to [skyL, skyR] × [skyTop, skyBottom] however far the spawn point lies", () => {
    const m = motes();
    m.sync({ collecting: [mote("a", 100), mote("b", 900000), mote("c", 5)], ready: [] }, 0, { x: 5000, y: 3000 });
    for (const b of m.bodies()) {
      expect(b.x).toBeLessThanOrEqual(SKY.skyR);
      expect(b.y).toBeLessThanOrEqual(SKY.skyBottom);
    }
    const t = run(m, 0, 300, frame());
    for (const b of m.bodies()) {
      expect(b.x).toBeGreaterThanOrEqual(SKY.skyL);
      expect(b.x).toBeLessThanOrEqual(SKY.skyR);
      expect(b.y).toBeGreaterThanOrEqual(SKY.skyTop);
      expect(b.y).toBeLessThanOrEqual(SKY.skyBottom);
    }
    expect(t).toBeGreaterThan(0);
  });

  test("a second sync with the same keys spawns nothing; a key that grew pulses gold for 900 ms, then not", () => {
    const m = motes();
    m.sync({ collecting: [mote("alice", 500), mote("bob", 500)], ready: [] }, 0, SPAWN);
    m.sync({ collecting: [mote("alice", 500), mote("bob", 500)], ready: [] }, 100, SPAWN);
    expect(m.bodies()).toHaveLength(2);
    expect(m.bodies().every((b) => !b.gold)).toBe(true);
    m.sync({ collecting: [mote("alice", 500), mote("bob", 2500)], ready: [] }, 1000, SPAWN);
    m.step(1016, 16, frame());
    expect(m.bodies().find((b) => b.key === "bob")!.gold).toBe(true);
    expect(m.bodies().find((b) => b.key === "alice")!.gold).toBe(false);
    m.step(1000 + GOLD_MS - 16, 16, frame());
    expect(m.bodies().find((b) => b.key === "bob")!.gold).toBe(true);
    m.step(1000 + GOLD_MS + 16, 16, frame());
    expect(m.bodies().find((b) => b.key === "bob")!.gold).toBe(false);
    expect(GOLD_MS).toBe(900);
  });

  test("a key that leaves the wire fades out and is gone within a second", () => {
    const m = motes();
    m.sync({ collecting: [mote("alice", 500), mote("bob", 500)], ready: [] }, 0, SPAWN);
    run(m, 0, 10, frame());
    m.sync({ collecting: [mote("alice", 500)], ready: [] }, 200, SPAWN);
    m.step(216, 16, frame());
    const bob = m.bodies().find((b) => b.key === "bob");
    expect(bob).toBeDefined();
    expect(bob!.alpha).toBeLessThan(1);
    run(m, 216, 70, frame());
    expect(m.bodies().map((b) => b.key)).toEqual(["alice"]);
  });

  test("ready: the group drifts toward the airship and holds under it — closer every frame, never over the envelope", () => {
    const m = motes();
    const group = [mote("a", 500), mote("b", 1500), mote("c", 200)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    let t = run(m, 0, 120, frame()); // loitering in the sky
    m.sync({ collecting: [], ready: [group] }, t, SPAWN);
    expect(m.bodies()).toHaveLength(3); // a crossing moves the motes into the group, no respawn
    const ship = { x: 700, y: 120 };
    const dist = (): number => m.bodies().reduce((s, b) => s + Math.hypot(b.x - ship.x, b.y - ship.y), 0) / 3;
    const dist0 = dist();
    let last = dist0;
    for (let i = 0; i < 12; i++) {
      t = run(m, t, 5, frame({ ready: true, airship: ship }));
      const d = dist();
      expect(d).toBeLessThanOrEqual(last + 1); // the gentle bob under the gondola is the only give
      last = d;
    }
    expect(last).toBeLessThan(dist0 - 60); // closer than where they loitered …
    expect(last).toBeLessThan(250); // … and holding just under the gondola (the first row is 180 under the centre)
    for (const b of m.bodies()) {
      expect(Math.abs(b.x - ship.x)).toBeLessThan(120);
      expect(b.y).toBeGreaterThan(ship.y + 134 + MOTE_MAX_PX / 2); // the largest ring's top clears the sheet gondola (its bottom is 134 under the centre)
      expect(b.y).toBeLessThan(ship.y + 260);
    }
  });

  test("the first sync is the snapshot: its motes take their places in the sky at once (no burst from the thank line on page load); only later keys spawn there", () => {
    const m = motes();
    m.sync({ collecting: [mote("a", 500), mote("b", 900)], ready: [[mote("c", 5000)]] }, 0, SPAWN);
    m.step(16, 16, frame({ ready: true }));
    for (const b of m.bodies()) expect(b.y).toBeLessThan(SPAWN.y - 100);
    m.sync({ collecting: [mote("a", 500), mote("b", 900), mote("d", 100)], ready: [[mote("c", 5000)]] }, 32, SPAWN);
    const d = m.bodies().find((b) => b.key === "d")!;
    expect([d.x, d.y]).toEqual([SPAWN.x, SPAWN.y]);
  });

  test("the loitering cloud spreads across the sky whatever the rng's early draws: ten motes cover both halves of the width and both halves of the band", () => {
    const m = new Motes(seededRandom(0x5eed + 2), () => ANCHOR); // the scene's own child seed: its first even draws are all under 0.2
    m.sync({ collecting: Array.from({ length: 10 }, (_, i) => mote(`k${i}`, 500)), ready: [] }, 0, SPAWN);
    run(m, 0, 240, frame());
    const xs = m.bodies().map((b) => b.x);
    const ys = m.bodies().map((b) => b.y);
    const midX = (SKY.skyL + SKY.skyR) / 2;
    const midY = (SKY.skyTop + SKY.skyBottom) / 2;
    expect(xs.filter((x) => x < midX).length).toBeGreaterThanOrEqual(3);
    expect(xs.filter((x) => x > midX).length).toBeGreaterThanOrEqual(3);
    expect(ys.filter((y) => y < midY).length).toBeGreaterThanOrEqual(2);
    expect(ys.filter((y) => y > midY).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan((SKY.skyR - SKY.skyL) / 2);
  });

  test("moteSky: the scene's span beside the rack, from 40 down to just over the sheet's horizon, or well over the club-deck's ground line", () => {
    const L = { sceneL: 40, sceneR: 1510, horizonY: 640, gy: 968 };
    expect(moteSky(L, true)).toEqual({ skyL: 40, skyR: 1510, skyTop: 40, skyBottom: 640 - SKY_ABOVE_HORIZON });
    expect(moteSky(L, false)).toEqual({ skyL: 40, skyR: 1510, skyTop: 40, skyBottom: 968 - CLUB_SKY_ABOVE_GROUND });
    expect(moteSky(L, true).skyBottom).toBeLessThan(L.horizonY);
  });

  test("a key first seen inside a READY group (a crossing under a FULL hold) spawns at the thank line — not an error", () => {
    const m = motes();
    m.sync({ collecting: [mote("a", 500)], ready: [] }, 0, SPAWN);
    run(m, 0, 30, frame());
    expect(() => m.sync({ collecting: [], ready: [[mote("a", 500), mote("tipper", 3800)]] }, 500, SPAWN)).not.toThrow();
    const tipper = m.bodies().find((b) => b.key === "tipper")!;
    expect([tipper.x, tipper.y]).toEqual([SPAWN.x, SPAWN.y]);
    expect(m.bodies()).toHaveLength(2);
  });

  test("fire(group): once its jumper is in the air the group orbits it at r × [1.2, 2.2] — never inside the pilot's radius — and follows it down", () => {
    const m = motes();
    const group = [mote("a", 500), mote("b", 1500), mote("c", 200), mote("d", 9000), anon("anon:7", 300)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    let t = run(m, 0, 60, frame());
    m.sync({ collecting: [], ready: [group] }, t, SPAWN);
    t = run(m, t, 60, frame({ ready: true }));
    m.fire(group, 1);
    m.sync({ collecting: [], ready: [] }, t, SPAWN); // the wire no longer carries the fired group
    t = run(m, t, 10, frame({ ready: false })); // the fire is pending: the group holds
    expect(m.bodies()).toHaveLength(5);
    expect(m.bodies().every((b) => b.kind === "armed")).toBe(true);
    const J = { fireSeq: 1, x: 700, y: 300, r: 60 };
    t = run(m, t, 60, frame({ jumpers: [J] })); // ~1 s: the ease-in is over
    for (let i = 0; i < 200; i++) {
      J.y += 1;
      J.x += Math.sin(i / 20);
      t += 16;
      m.step(t, 16, frame({ jumpers: [J] }));
      for (const b of m.bodies()) {
        const d = Math.hypot(b.x - J.x, b.y - J.y);
        expect(b.kind).toBe("orbit");
        expect(d).toBeGreaterThanOrEqual(J.r * ORBIT_MIN - 1e-6);
        expect(d).toBeLessThanOrEqual(J.r * ORBIT_MAX + 1e-6);
        expect(d).toBeGreaterThan(J.r);
      }
    }
    // it is an orbit: the angle of one mote about the jumper advances
    const angle = (): number => {
      const b = m.bodies()[0]!;
      return Math.atan2(b.y - J.y, b.x - J.x);
    };
    const a0 = angle();
    run(m, t, 30, frame({ jumpers: [J] }));
    expect(Math.abs(angle() - a0)).toBeGreaterThan(0.1);
    expect([ORBIT_MIN, ORBIT_MAX]).toEqual([1.2, 2.2]);
  });

  test("landed: a soft outward burst — every mote moves away from the landing point and alpha reaches 0 within 1 s, then the group is gone", () => {
    const m = motes();
    const group = [mote("a", 500), mote("b", 1500), mote("c", 200)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    let t = run(m, 0, 30, frame());
    m.fire(group, 4); // the fire before the wire's shift (main.ts's order)
    m.sync({ collecting: [], ready: [] }, t, SPAWN);
    const J = { fireSeq: 4, x: 700, y: 500, r: 60 };
    t = run(m, t, 90, frame({ jumpers: [J] }));
    const before = m.bodies().map((b) => ({ key: b.key, d: Math.hypot(b.x - J.x, b.y - J.y), alpha: b.alpha }));
    m.landed(4, J.x, J.y, t);
    t = run(m, t, 20, frame({ jumpers: [] }));
    const mid = m.bodies();
    expect(mid).toHaveLength(3);
    for (const b of mid) {
      const was = before.find((w) => w.key === b.key)!;
      expect(Math.hypot(b.x - J.x, b.y - J.y)).toBeGreaterThan(was.d);
      expect(b.alpha).toBeLessThan(was.alpha);
      expect(b.alpha).toBeGreaterThan(0);
      expect(b.kind).toBe("burst");
    }
    run(m, t, Math.ceil(BURST_MS / 16), frame({ jumpers: [] }));
    expect(m.bodies()).toHaveLength(0);
    expect(BURST_MS).toBe(1000);
  });

  test("a jumper that leaves the air without a `landed` call is a landing too (the drop only ever removes a jumper at touchdown)", () => {
    const m = motes();
    const group = [mote("a", 500)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    m.fire(group, 2);
    m.sync({ collecting: [], ready: [] }, 16, SPAWN);
    let t = run(m, 16, 60, frame({ jumpers: [{ fireSeq: 2, x: 700, y: 500, r: 50 }] }));
    expect(m.bodies()[0]!.kind).toBe("orbit");
    t = run(m, t, 2, frame({ jumpers: [] }));
    expect(m.bodies()[0]!.kind).toBe("burst");
  });

  test("rearmed: the group keeps its motes and holds again under the airship until a jumper with its fireSeq is back in the air", () => {
    const m = motes();
    const group = [mote("a", 500), mote("b", 700)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    m.fire(group, 3);
    m.sync({ collecting: [], ready: [] }, 16, SPAWN);
    let t = run(m, 16, 60, frame({ jumpers: [{ fireSeq: 3, x: 700, y: 400, r: 50 }] }));
    expect(m.bodies().every((b) => b.kind === "orbit")).toBe(true);
    m.rearmed(3);
    t = run(m, t, 120, frame({ jumpers: [], airship: { x: 400, y: 120 } }));
    expect(m.bodies()).toHaveLength(2);
    expect(m.bodies().every((b) => b.kind === "armed")).toBe(true);
    for (const b of m.bodies()) expect(Math.abs(b.x - 400)).toBeLessThan(80);
    t = run(m, t, 60, frame({ jumpers: [{ fireSeq: 3, x: 500, y: 300, r: 50 }] }));
    expect(m.bodies().every((b) => b.kind === "orbit")).toBe(true);
  });

  test("fire(group) with no matching READY group on screen (the wire shifted first) still builds the group; it is placed under the airship on its first step", () => {
    const m = motes();
    m.sync({ collecting: [], ready: [] }, 0, SPAWN);
    m.fire([mote("x", 500), mote("y", 800)], 9);
    m.step(16, 16, frame({ airship: { x: 900, y: 120 } }));
    const bodies = m.bodies();
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(Math.abs(b.x - 900)).toBeLessThan(80);
      expect(b.y).toBeGreaterThan(120);
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
    }
  });

  test("two READY groups queue in rows under the airship; when the front one fires the other keeps its motes (no respawn, no flicker)", () => {
    const m = motes();
    const g1 = [mote("a", 500), mote("b", 500)];
    const g2 = [mote("b", 10000)]; // the same key can sit in two groups: two separate motes
    m.sync({ collecting: [], ready: [g1, g2] }, 0, SPAWN);
    expect(m.bodies()).toHaveLength(3);
    let t = run(m, 0, 90, frame({ ready: true }));
    const back = m.bodies().filter((b) => b.kind === "ready").map((b) => ({ key: b.key, x: b.x, y: b.y }));
    m.fire(g1, 11);
    m.sync({ collecting: [], ready: [g2] }, t, SPAWN);
    t = run(m, t, 1, frame({ ready: true }));
    const after = m.bodies();
    expect(after).toHaveLength(3);
    expect(after.filter((b) => b.kind === "armed").map((b) => b.key).sort()).toEqual(["a", "b"]);
    const kept = after.find((b) => b.kind === "ready")!;
    const was = back.find((w) => w.key === "b" && Math.abs(w.y - kept.y) < 40)!;
    expect(was).toBeDefined();
    expect(Math.abs(kept.x - was.x)).toBeLessThan(40);
  });

  test("jumperOrbit: the orbit centre sits up the rig from the feet and the radius scales with the canopy; the sheet's rig is the taller one", () => {
    const J = { fireSeq: 5, x: 600, y: 800, canopy: 1, spiralOff: 10 };
    const club = jumperOrbit(J, false);
    const sheet = jumperOrbit(J, true);
    expect(club.fireSeq).toBe(5);
    expect(club.x).toBe(610); // the corkscrew's lateral swing is where the rig is drawn
    expect(club.y).toBeLessThan(800);
    expect(sheet.y).toBeLessThan(club.y);
    expect(sheet.r).toBeGreaterThan(club.r);
    expect(jumperOrbit({ ...J, canopy: 0.8 }, true).r).toBeLessThan(sheet.r);
    expect(club.r).toBeGreaterThan(0);
  });
});

describe("Motes.draw — a ring and a picture or a glyph; never a name; the Level's cap", () => {
  const avatarNone = (): CanvasImageSource | null => null;

  function drawn(list: Mote[], spec = LEVELS[5], avatarImage: (m: Mote) => CanvasImageSource | null = avatarNone, sheet = true) {
    const m = motes();
    m.sync({ collecting: list, ready: [] }, 0, SPAWN);
    run(m, 0, 30, frame());
    const { ctx, calls, texts, props } = fakeCtx();
    const sp = fakeSprites();
    m.draw(ctx, theme, sheet ? sp.set : null, spec, avatarImage);
    return { m, calls, texts, props, draws: sp.draws };
  }

  test("Level 5 draws one mote-ring per mote on the sheet, tinted from the Theme, with the Avatar Glyph inside and no name anywhere", () => {
    const list = [mote("alice", 500), mote("bob", 2500, { avatar: "🎸" }), anon("anon:3", 300)];
    const { draws, texts, props } = drawn(list);
    expect(rings(draws)).toHaveLength(3);
    expect(rings(draws).every((d) => d.name === "mote-ring" && d.opts?.colour === theme.accent)).toBe(true);
    expect(texts.sort()).toEqual(["🎧", "🎸"]); // two glyphs, nothing for the anonymous mote, no name
    expect(texts.join("\n")).not.toMatch(/alice|bob|anon/);
    expect(props["globalAlpha"]).toBe(1); // restored
    expect(props["globalCompositeOperation"]).toBe("source-over");
  });

  test("a bigger contribution draws a bigger ring: the draw scale follows moteSize", () => {
    const { draws } = drawn([mote("small", 200), mote("large", 30000)]);
    const [a, b] = rings(draws);
    expect(b!.opts!.k!).toBeGreaterThan(a!.opts!.k!);
    expect(b!.opts!.alpha ?? 1).toBeGreaterThanOrEqual(a!.opts!.alpha ?? 1);
  });

  test("a decoded Avatar Picture is drawn through an arc clip inside the ring instead of the glyph; a null image falls back to the glyph", () => {
    const img = {} as CanvasImageSource;
    const list = [mote("alice", 500, { avatarUrl: "https://static-cdn.jtvnw.net/a.png" }), mote("bob", 500)];
    const { calls, texts } = drawn(list, LEVELS[5], (m) => (m.avatarUrl === null ? null : img));
    expect(texts).toEqual(["🎧"]); // bob's glyph only
    expect(calls.get("clip") ?? 0).toBeGreaterThanOrEqual(1);
    expect(calls.get("drawImage") ?? 0).toBeGreaterThanOrEqual(3); // two rings + the picture (+ plates)
  });

  test("Level 1 draws at most 6 rings — the largest first, then the newest; the club-deck (no sheet) strokes circles under the same cap", () => {
    const list = Array.from({ length: 10 }, (_, i) => mote(`k${i}`, 100 * (i + 1)));
    const { draws, texts } = drawn(list, LEVELS[1]);
    expect(rings(draws)).toHaveLength(6);
    expect(texts).toHaveLength(6);
    const club = drawn(list, LEVELS[1], avatarNone, false);
    expect(club.draws).toHaveLength(0);
    expect(club.calls.get("stroke")).toBe(12); // the ring and its wider, dimmer halo — two strokes per mote
    expect(club.texts).toHaveLength(6);
    expect(club.texts.join("\n")).not.toMatch(/k\d/);
    expect(LEVELS[1].motes).toBe(6);
  });

  test("the ring is mote-ring-gold for 900 ms after a key's cents grow, then mote-ring again", () => {
    const m = motes();
    m.sync({ collecting: [mote("alice", 500)], ready: [] }, 0, SPAWN);
    run(m, 0, 10, frame());
    m.sync({ collecting: [mote("alice", 1500)], ready: [] }, 1000, SPAWN);
    m.step(1016, 16, frame());
    const on = fakeSprites();
    m.draw(fakeCtx().ctx, theme, on.set, LEVELS[5], avatarNone);
    expect(rings(on.draws).map((d) => d.name)).toEqual(["mote-ring-gold"]);
    expect(rings(on.draws)[0]!.opts?.colour).toBe(theme.gold);
    m.step(1000 + GOLD_MS + 16, 16, frame());
    const off = fakeSprites();
    m.draw(fakeCtx().ctx, theme, off.set, LEVELS[5], avatarNone);
    expect(rings(off.draws).map((d) => d.name)).toEqual(["mote-ring"]);
  });

  test("item 7: a $2 orbiter is drawn at least ORBIT_ALPHA_MIN (brighter than any loiterer at 1080p); its burst starts at BURST_ALPHA and fades from there — no oscillation, so no flash at all", () => {
    expect(ORBIT_ALPHA_MIN).toBeGreaterThanOrEqual(0.75);
    expect(BURST_ALPHA).toBe(1);
    const m = motes();
    const group = [mote("a", 200)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    const loiter = fakeSprites();
    m.step(16, 16, frame());
    m.draw(fakeCtx().ctx, theme, loiter.set, LEVELS[5], avatarNone);
    const loiterAlpha = rings(loiter.draws)[0]!.opts!.alpha!;
    expect(loiterAlpha).toBeLessThan(0.4); // $2 of a $600 anchor: the faint end of the cloud
    m.fire(group, 1);
    m.sync({ collecting: [], ready: [] }, 32, SPAWN);
    let t = run(m, 32, 60, frame({ jumpers: [{ fireSeq: 1, x: 700, y: 500, r: 50 }] }));
    const orbit = fakeSprites();
    m.draw(fakeCtx().ctx, theme, orbit.set, LEVELS[5], avatarNone);
    expect(rings(orbit.draws)[0]!.opts!.alpha!).toBeGreaterThanOrEqual(ORBIT_ALPHA_MIN);
    expect(rings(orbit.draws)[0]!.opts!.alpha!).toBeGreaterThan(loiterAlpha);
    m.landed(1, 700, 500, t);
    t = run(m, t, 1, frame());
    const first = fakeSprites();
    m.draw(fakeCtx().ctx, theme, first.set, LEVELS[5], avatarNone);
    expect(rings(first.draws)[0]!.opts!.alpha!).toBeGreaterThan(0.95);
    const alphas: number[] = [];
    for (let i = 0; i < 40; i++) {
      t = run(m, t, 1, frame());
      const sp = fakeSprites();
      m.draw(fakeCtx().ctx, theme, sp.set, LEVELS[5], avatarNone);
      alphas.push(rings(sp.draws)[0]?.opts?.alpha ?? 0);
    }
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeLessThanOrEqual(alphas[i - 1]! + 1e-9); // monotone: a fade, never a flicker
  });

  test("a bursting mote draws fainter than it did in orbit, and nothing once it is gone", () => {
    const m = motes();
    const group = [mote("a", 500)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    m.fire(group, 1);
    m.sync({ collecting: [], ready: [] }, 16, SPAWN);
    let t = run(m, 16, 60, frame({ jumpers: [{ fireSeq: 1, x: 700, y: 500, r: 50 }] }));
    const orbit = fakeSprites();
    m.draw(fakeCtx().ctx, theme, orbit.set, LEVELS[5], avatarNone);
    m.landed(1, 700, 500, t);
    t = run(m, t, 30, frame());
    const burst = fakeSprites();
    m.draw(fakeCtx().ctx, theme, burst.set, LEVELS[5], avatarNone);
    expect(rings(burst.draws)[0]!.opts!.alpha!).toBeLessThan(rings(orbit.draws)[0]!.opts!.alpha!);
    run(m, t, 70, frame());
    const gone = fakeSprites();
    m.draw(fakeCtx().ctx, theme, gone.set, LEVELS[5], avatarNone);
    expect(gone.draws).toHaveLength(0);
  });
});

describe("Motes — review fixes: the cap ranks the fired group first; recency is first-seen; fades and rows follow the live clock", () => {
  const avatarNone = (): CanvasImageSource | null => null;

  /** The glyphs `draw` puts down under `spec` — one per drawn named mote, so a unique avatar per key says who was kept. */
  function drawnGlyphs(m: Motes, spec = LEVELS[1]): { texts: string[]; ringsAt: SpriteDraw[] } {
    const { ctx, texts } = fakeCtx();
    const sp = fakeSprites();
    m.draw(ctx, theme, sp.set, spec, avatarNone);
    return { texts: texts.sort(), ringsAt: rings(sp.draws) };
  }

  test("Important 1: at Level 1 six $2 orbiters are all drawn and the $500 tipper's loiter ring is dropped — through the orbit and the burst; with room left the cloud's largest come next", () => {
    const m = motes();
    const six = Array.from({ length: 6 }, (_, i) => mote(`c${i}`, 200, { avatar: "🎧" }));
    const tipper = mote("tipper", 50000, { avatar: "💰" });
    m.sync({ collecting: six, ready: [] }, 0, SPAWN);
    let t = run(m, 0, 30, frame());
    m.sync({ collecting: [tipper], ready: [six] }, t, SPAWN); // the six crossed; the tipper collects toward the next one
    t = run(m, t, 30, frame({ ready: true }));
    m.fire(six, 1);
    m.sync({ collecting: [tipper], ready: [] }, t, SPAWN);
    const J = { fireSeq: 1, x: 700, y: 400, r: 60 };
    t = run(m, t, 60, frame({ jumpers: [J] }));
    expect(m.bodies().filter((b) => b.kind === "orbit")).toHaveLength(6);
    const orbit = drawnGlyphs(m, LEVELS[1]);
    expect(orbit.texts).toEqual(Array(6).fill("🎧")); // every orbiter, not the tipper
    expect(orbit.ringsAt).toHaveLength(6);
    for (const d of orbit.ringsAt) expect(Math.hypot(d.x - J.x, d.y - J.y)).toBeLessThanOrEqual(J.r * ORBIT_MAX + 1e-6);
    // Level 2 (cap 12): the six, then the cloud
    const roomy = drawnGlyphs(m, LEVELS[2]);
    expect(roomy.texts.filter((x) => x === "💰")).toHaveLength(1);
    expect(roomy.ringsAt).toHaveLength(7);
    // the burst still outranks the cloud until it is gone
    m.landed(1, J.x, J.y, t);
    t = run(m, t, 10, frame({ jumpers: [] }));
    const burst = drawnGlyphs(m, LEVELS[1]);
    expect(burst.texts).toEqual(Array(6).fill("🎧"));
    run(m, t, 70, frame({ jumpers: [] }));
    expect(drawnGlyphs(m, LEVELS[1]).texts).toEqual(["💰"]); // the burst over, the tipper is back
    expect(LEVELS[1].motes).toBe(6);
  });

  test("Important 1 (inverse): with nothing fired the cap still keeps the largest loiterers", () => {
    const m = motes();
    const list = [...Array.from({ length: 6 }, (_, i) => mote(`c${i}`, 200, { avatar: "🎧" })), mote("tipper", 50000, { avatar: "💰" })];
    m.sync({ collecting: list, ready: [] }, 0, SPAWN);
    run(m, 0, 30, frame());
    const { texts } = drawnGlyphs(m, LEVELS[1]);
    expect(texts).toHaveLength(6);
    expect(texts.filter((x) => x === "💰")).toHaveLength(1);
  });

  test("Minor 2: a re-tip under the cap changes no membership — recency is first-seen order, growth only pulses gold", () => {
    const m = motes();
    const list = [mote("k0", 400, { avatar: "g0" }), ...Array.from({ length: 6 }, (_, i) => mote(`k${i + 1}`, 500, { avatar: `g${i + 1}` }))];
    m.sync({ collecting: list, ready: [] }, 0, SPAWN);
    run(m, 0, 30, frame());
    const before = drawnGlyphs(m, LEVELS[1]).texts;
    expect(before).toEqual(["g1", "g2", "g3", "g4", "g5", "g6"]);
    const grown = list.map((x) => (x.key === "k0" ? { ...x, cents: 500 } : x)); // k0 re-tips into a tie with the drawn six
    m.sync({ collecting: grown, ready: [] }, 1000, SPAWN);
    m.step(1016, 16, frame());
    expect(m.bodies().find((b) => b.key === "k0")!.gold).toBe(true);
    expect(drawnGlyphs(m, LEVELS[1]).texts).toEqual(before);
  });

  test("Minor 3: a leftover of fire(group) fades over about a second from the last stepped clock — not in one frame", () => {
    const m = motes();
    const group = [mote("a", 500), mote("b", 500), mote("c", 500)];
    m.sync({ collecting: group, ready: [] }, 0, SPAWN);
    let t = run(m, 0, 90, frame()); // t = 1440, well past BURST_MS
    m.sync({ collecting: [], ready: [group] }, t, SPAWN);
    t = run(m, t, 30, frame({ ready: true }));
    m.fire([group[0]!, group[1]!], 1); // c is a leftover
    m.sync({ collecting: [], ready: [] }, t, SPAWN);
    m.step(t + 16, 16, frame());
    const c1 = m.bodies().find((b) => b.key === "c");
    expect(c1).toBeDefined();
    expect(c1!.alpha).toBeGreaterThan(0.9);
    expect(c1!.alpha).toBeLessThan(1);
    run(m, t + 16, 30, frame()); // ~0.5 s in
    const c2 = m.bodies().find((b) => b.key === "c")!;
    expect(c2.alpha).toBeGreaterThan(0.4);
    expect(c2.alpha).toBeLessThan(0.6);
    run(m, t + 16 + 30 * 16, 40, frame()); // past 1 s
    expect(m.bodies().find((b) => b.key === "c")).toBeUndefined();
  });

  test("Minor 4: a voided member closes the hold row — the live members stay centred under the airship while the corpse fades", () => {
    const m = motes();
    const ship = { x: 700, y: 120 };
    const group = [mote("a", 500), mote("b", 500), mote("c", 500)];
    m.sync({ collecting: [], ready: [group] }, 0, SPAWN);
    let t = run(m, 0, 150, frame({ ready: true, airship: ship }));
    const xs0 = m.bodies().map((b) => b.x);
    expect(Math.abs((xs0[0]! + xs0[2]!) / 2 - ship.x)).toBeLessThan(1);
    m.fire([group[0]!, group[2]!], 1); // b is gone: a and c hold on as the pending fire's group
    m.sync({ collecting: [], ready: [] }, t, SPAWN);
    for (let i = 0; i < 40; i++) {
      t += 16;
      m.step(t, 16, frame({ ready: false, airship: ship }));
      const a = m.bodies().find((b) => b.key === "a")!;
      const c = m.bodies().find((b) => b.key === "c")!;
      expect(m.bodies().find((b) => b.key === "b")).toBeDefined(); // still fading — the row must not count it
      expect(Math.abs((a.x + c.x) / 2 - ship.x)).toBeLessThan(2);
    }
    t = run(m, t, 150, frame({ ready: false, airship: ship }));
    const a = m.bodies().find((b) => b.key === "a")!;
    const c = m.bodies().find((b) => b.key === "c")!;
    expect(Math.abs(c.x - a.x - 40)).toBeLessThan(1); // one slot apart, centred
    expect(Math.abs((a.x + c.x) / 2 - ship.x)).toBeLessThan(1);
  });
});

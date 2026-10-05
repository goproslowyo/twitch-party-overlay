import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../config/schema.ts";
import { PASSENGER_ROTATE_MS, SEATS, TURN_RATE, WINDOW_DIM_ALPHA, brandFace, createPatrol, drawBlimp, litWindows, passengers } from "./blimp.ts";

const club = defaultConfig().themes["club-deck"]!;

describe("createPatrol — the blimp cruises the free sky nose-first and turns at each end", () => {
  test("starts at its home heading the given way and cruises at 0.55 px per 60 Hz frame", () => {
    const p = createPatrol(330, 1);
    expect(p.x).toBe(330);
    expect(p.facing).toBe(1);
    p.step(0, 1, 100, 1000);
    expect(p.x).toBeCloseTo(330.55, 6);
  });

  test("reaching the far bound reverses the cruise and the facing eases over about a second; the near bound turns it back", () => {
    const p = createPatrol(990, 1);
    p.step(0, 1, 100, 1000);
    p.step(16, 1, 100, 1000); // past 1000 → clamped and turned
    for (let i = 0; i < 20; i++) p.step(32 + i * 16, 1, 100, 1000);
    expect(p.x).toBeLessThan(1000);
    expect(p.vx).toBeLessThan(0);
    expect(p.facing).toBeLessThan(1); // mid-turn: foreshortened
    expect(p.facing).toBeGreaterThan(-1);
    for (let i = 0; i < 120; i++) p.step(400 + i * 16, 1, 100, 1000);
    expect(p.facing).toBeCloseTo(-1, 1); // ~1 s at TURN_RATE per frame
    expect(TURN_RATE).toBeCloseTo(0.045, 6);
    for (let i = 0; i < 2000; i++) p.step(2400 + i * 16, 1, 100, 1000);
    expect(p.x).toBeGreaterThan(100);
    expect(p.vx).toBeGreaterThan(0); // came back off the near bound
  });

  test("bobs on the loop clock only: same t → same y, and the door hangs off the nose end", () => {
    const a = createPatrol(500, 1);
    const b = createPatrol(500, 1);
    a.step(1234, 1, 0, 2000);
    b.step(1234, 1, 0, 2000);
    expect(a.y).toBe(b.y);
    expect(a.y).toBeCloseTo(120 + Math.sin(1234 / 3100) * 14 + Math.cos(1234 / 1700) * 5, 9);
    const d = a.door(1);
    expect(d).toEqual({ x: a.x + 126, y: a.y + 100, facing: 1 });
    const left = createPatrol(500, -1);
    left.step(0, 1, 0, 2000);
    expect(left.door(1).x).toBeCloseTo(left.x - 126, 9);
    expect(left.door(1).facing).toBe(-1);
  });

  test("mid-turn the door follows the foreshortened nose (never closer than 12 % of the way)", () => {
    const p = createPatrol(500, 1);
    p.facing = 0.05;
    expect(p.door(1).x).toBeCloseTo(500 + 126 * 0.12, 9);
    p.facing = -0.5;
    expect(p.door(1).x).toBeCloseTo(500 - 126 * 0.5, 9);
  });
});

describe("passengers — the gondola's windows light one per banked Unlock, each lit seat a generic Passenger; nobody is pictured for an Unlock", () => {
  const { avatars } = club;

  test("seven glyphs from theme.avatars at t = 0, in theme order", () => {
    expect(SEATS).toBe(7);
    const p = passengers(club, 0);
    expect(p).toHaveLength(7);
    expect(p.every((g) => avatars.includes(g))).toBe(true);
    expect(p).toEqual(avatars.slice(0, 7));
  });

  test("rotates one seat every PASSENGER_ROTATE_MS (9 s): the offset comes from the caller's tMs, never a clock", () => {
    expect(PASSENGER_ROTATE_MS).toBe(9000);
    expect(passengers(club, 8999)).toEqual(passengers(club, 0));
    expect(passengers(club, 9000)).toEqual(passengers(club, 0).map((_, i) => avatars[(i + 1) % avatars.length]!));
    expect(passengers(club, 9000 * avatars.length)).toEqual(passengers(club, 0)); // a full lap
  });

  test("a short avatar list cycles across every seat; only an empty list gives no Passengers (never a ghost)", () => {
    expect(passengers({ ...club, avatars: ["🦆", "🐥", "🪿"] }, 0)).toEqual(["🦆", "🐥", "🪿", "🦆", "🐥", "🪿", "🦆"]);
    expect(passengers({ ...club, avatars: ["🦆", "🐥", "🪿"] }, 9000)).toEqual(["🐥", "🪿", "🦆", "🐥", "🪿", "🦆", "🐥"]);
    expect(passengers({ ...club, avatars: [] }, 0)).toEqual([]);
  });

  /** A recording 2-D context for the club-deck path: every fillText (string, x), arc centres, and the alpha in force at each arc. */
  function clubCtx(): { ctx: CanvasRenderingContext2D; texts: string[]; fills: { text: string; x: number }[]; arcs: { x: number; r: number; alpha: number }[] } {
    const texts: string[] = [];
    const fills: { text: string; x: number }[] = [];
    const arcs: { x: number; r: number; alpha: number }[] = [];
    const target: Record<string, unknown> = { globalAlpha: 1 };
    const ctx = new Proxy(target, {
      get: (t, key: string) =>
        key in t
          ? t[key]
          : key === "measureText"
            ? (s: string) => ({ width: s.length * 7 })
            : (...args: unknown[]) => {
                if (key === "fillText" && typeof args[0] === "string") {
                  texts.push(args[0]);
                  fills.push({ text: args[0], x: args[1] as number });
                }
                if (key === "arc") arcs.push({ x: args[0] as number, r: args[2] as number, alpha: t.globalAlpha as number });
              },
      set: (t, key: string, value) => ((t[key] = value), true),
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, texts, fills, arcs };
  }
  const clubFrame = (queue: number, t = 0, facing = 1) => ({ t, x: 500, y: 120, facing, livery: { text: "DJ", alpha: 1 }, passengers: passengers(club, t), queue });

  test("litWindows is min(queue, 7), never negative: the READY count past seven is the badge's alone", () => {
    expect([0, 1, 3, 7, 8, 12, 300].map(litWindows)).toEqual([0, 1, 3, 7, 7, 7, 7]);
    expect(litWindows(-2)).toBe(0);
    expect(WINDOW_DIM_ALPHA).toBeCloseTo(0.35, 6);
  });

  test("drawBlimp paints exactly its Passengers in the lit windows and the ×N badge — no +N seat, no name, no contributor", () => {
    const { ctx, texts } = clubCtx();
    const frame = clubFrame(9);
    drawBlimp(ctx, club, frame);
    expect(texts.filter((t) => avatars.includes(t))).toEqual(avatars.slice(0, 7));
    expect(texts).toContain("×9");
    expect(texts.join("\n")).not.toMatch(/\+\d|@|Anonymous/);
    expect("seats" in frame).toBe(false);
  });

  test("club-deck: queue 0 → seven dim windows and no Passenger; queue 3 → the three seats nearest the nose lit with the first three glyphs, four dim; 7 and 12 → all seven, the badge alone counting on", () => {
    const windows = (arcs: { x: number; r: number; alpha: number }[]) => arcs.filter((a) => a.r === 11);
    const dark = clubCtx();
    drawBlimp(dark.ctx, club, clubFrame(0));
    expect(windows(dark.arcs)).toHaveLength(7);
    expect(windows(dark.arcs).every((w) => w.alpha === WINDOW_DIM_ALPHA)).toBe(true);
    expect(dark.texts.filter((t) => avatars.includes(t))).toEqual([]);
    expect(dark.texts).toContain("×0");
    const three = clubCtx();
    drawBlimp(three.ctx, club, clubFrame(3));
    const w3 = windows(three.arcs);
    expect(w3).toHaveLength(7);
    expect(w3.map((w) => w.alpha)).toEqual([1, 1, 1, WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA]);
    const glyphs = three.fills.filter((f) => avatars.includes(f.text));
    expect(glyphs.map((g) => g.text)).toEqual(avatars.slice(0, 3));
    expect(glyphs.map((g) => g.x)).toEqual([94, 62, 30]); // the seats by the door at the nose, filling backwards
    expect(w3.slice(0, 3).map((w) => w.x)).toEqual([94, 62, 30]);
    expect(three.texts).toContain("×3");
    for (const [queue, badge] of [[7, "×7"], [12, "×12"]] as const) {
      const c = clubCtx();
      drawBlimp(c.ctx, club, clubFrame(queue));
      expect(windows(c.arcs).every((w) => w.alpha === 1)).toBe(true);
      expect(c.texts.filter((t) => avatars.includes(t))).toEqual(avatars.slice(0, 7));
      expect(c.texts).toContain(badge);
      expect(c.texts.join("\n")).not.toMatch(/@/);
    }
    // facing left the nose seats are mirrored; still the same three glyphs
    const left = clubCtx();
    drawBlimp(left.ctx, club, clubFrame(3, 0, -1));
    expect(left.fills.filter((f) => avatars.includes(f.text)).map((g) => g.x)).toEqual([-94, -62, -30]);
  });

  test("club-deck: the lit seats still rotate through the pool on PASSENGER_ROTATE_MS, and the lighting is a step on the queue alone (no blink between frames)", () => {
    const a = clubCtx();
    drawBlimp(a.ctx, club, clubFrame(3, 200));
    const b = clubCtx();
    drawBlimp(b.ctx, club, clubFrame(3, PASSENGER_ROTATE_MS + 200));
    const ga = a.texts.filter((t) => avatars.includes(t));
    const gb = b.texts.filter((t) => avatars.includes(t));
    expect(ga).toHaveLength(3);
    expect(gb).toHaveLength(3);
    expect(gb[0]).toBe(ga[1]);
    const alphas = new Set<string>();
    for (let t = 0; t <= 2000; t += 16) {
      const c = clubCtx();
      drawBlimp(c.ctx, club, clubFrame(3, t));
      alphas.add(c.arcs.filter((w) => w.r === 11).map((w) => w.alpha).join(","));
    }
    expect(alphas.size).toBe(1);
  });

  test("the module has no seat plan, no +N seat and no empty-seat state left", () => {
    const src = readFileSync(path.join(import.meta.dir, "blimp.ts"), "utf8");
    expect(src).not.toMatch(/seatPlan|moreSeats|cabin|kind: "more"|kind: "empty"|contributor/);
  });
});

describe("brandFace — the envelope's livery alternates channel ↔ CTA every brandAlternateMs; brand pins it", () => {
  test("alternates on the loop clock, swapping in the trough of a short cross-fade", () => {
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 0, 12000)).toEqual({ text: "DJ", alpha: 0 });
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 750, 12000).alpha).toBeCloseTo(0.5, 9); // in over 1.5 s
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 6000, 12000).alpha).toBeCloseTo(1, 9);
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 11999, 12000).alpha).toBeLessThan(0.01); // out at the edge
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 12000, 12000)).toEqual({ text: "TIP · CHEER · SUB · GIFT", alpha: 0 });
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 12750, 12000).alpha).toBeCloseTo(0.5, 9);
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 18000, 12000)).toEqual({ text: "TIP · CHEER · SUB · GIFT", alpha: 1 });
    expect(brandFace("dj", "TIP · CHEER · SUB · GIFT", "", 24000, 12000).text).toBe("DJ");
  });

  test("brand pins the text with no fade; an empty channel name shows the CTA until the snapshot names it", () => {
    expect(brandFace("dj", "CTA", "My Brand", 12000, 12000)).toEqual({ text: "MY BRAND", alpha: 1 });
    expect(brandFace("dj", "CTA", "My Brand", 11999, 12000).alpha).toBe(1);
    expect(brandFace("", "CTA", "", 0, 12000).text).toBe("CTA");
  });

  test("a zero or negative alternate period pins the channel name", () => {
    expect(brandFace("dj", "CTA", "", 5000, 0)).toEqual({ text: "DJ", alpha: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the Chrome Lounge airship from the Theme Sheet
// ---------------------------------------------------------------------------------------------------------------------
import { SHIP_OFFSETS } from "../../../scripts/sprites/draw.ts";
import { LEVELS, type LevelSpec } from "../quality.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";
import { PASSENGER_FALLBACK, SHEET_SHIP, finsColour, propellerFrame, shipLightAlpha, shipLightAt, type BlimpFrame } from "./blimp.ts";
import { mix } from "./util.ts";

interface Draw {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
}

/** A SpriteSet recording every draw (name, Sheet Scale, point, options) and putting one drawImage on the context per call. */
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

/** A recording 2-D context: counted methods, their arguments, every fillText string. */
function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number>; args: Map<string, unknown[][]>; texts: string[] } {
  const calls = new Map<string, number>();
  const args = new Map<string, unknown[][]>();
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : key === "measureText"
          ? (t: string) => ({ width: t.length * 7 })
          : (...a: unknown[]) => {
              calls.set(key, (calls.get(key) ?? 0) + 1);
              args.set(key, [...(args.get(key) ?? []), a]);
              if (key === "fillText" && typeof a[0] === "string") texts.push(a[0]);
            },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, args, texts };
}

describe("drawBlimp on the Chrome Lounge sheet", () => {
  const chrome = defaultConfig().themes["chrome-lounge"]!;
  const frameAt = (t: number, over: Partial<BlimpFrame> = {}): BlimpFrame => ({ t, x: 500, y: 120, facing: 1, livery: { text: "DJ", alpha: 1 }, passengers: passengers(chrome, t), queue: 3, ...over });

  function render(t: number, lvl: LevelSpec = LEVELS[5], over: Partial<BlimpFrame> = {}) {
    const sp = fakeSprites();
    const c = fakeCtx();
    drawBlimp(c.ctx, chrome, frameAt(t, over), sp.set, lvl);
    return { ...c, draws: sp.draws, names: sp.draws.map((d) => d.name) };
  }

  test("layers in order: fins behind, then body, stripe, gloss, the prop on its shaft, seven windows, the running light, the badge — every frame at the Sheet Scale", () => {
    const { names, draws, calls } = render(0);
    const at = (n: string): number => names.indexOf(n);
    expect(at("fins")).toBe(0);
    expect(at("fins")).toBeLessThan(at("ship-body"));
    expect(at("ship-body")).toBeLessThan(at("ship-stripe"));
    expect(at("ship-stripe")).toBeLessThan(at("ship-gloss"));
    expect(at("ship-gloss")).toBeLessThan(at("propeller-0"));
    expect(names.filter((n) => n === "gondola-window")).toHaveLength(7);
    expect(names).toContain("ship-light");
    expect(names).toContain("ready-badge");
    expect(new Set(draws.map((d) => d.scale))).toEqual(new Set([1]));
    expect(calls.get("drawImage")).toBe(names.length);
    expect(calls.get("ellipse")).toBeUndefined(); // no procedural envelope under the sprites
    expect(new Set(render(0, LEVELS[3]).draws.map((d) => d.scale))).toEqual(new Set([0.75]));
    expect(new Set(render(0, LEVELS[1]).draws.map((d) => d.scale))).toEqual(new Set([0.5]));
  });

  test("the composition follows the sheet script's SHIP_OFFSETS (one Anchor for body / stripe / gloss, the pieces placed off it)", () => {
    expect(SHEET_SHIP.fins).toEqual([...SHIP_OFFSETS.fins]);
    expect(SHEET_SHIP.propeller).toEqual([...SHIP_OFFSETS.propeller]);
    expect(SHEET_SHIP.light).toEqual([...SHIP_OFFSETS.light]);
    expect(SHEET_SHIP.badge).toEqual([...SHIP_OFFSETS.badge]);
    expect(SHEET_SHIP.gondolaY).toBe(SHIP_OFFSETS.gondolaY);
    for (let i = 0; i < 7; i++) expect(SHEET_SHIP.windowX(i)).toBe(SHIP_OFFSETS.windowX(i));
    const { draws } = render(0);
    const by = (n: string): Draw => draws.find((d) => d.name === n)!;
    expect([by("ship-body").x, by("ship-body").y]).toEqual([0, 0]);
    expect([by("ship-stripe").x, by("ship-stripe").y]).toEqual([0, 0]);
    expect([by("ship-gloss").x, by("ship-gloss").y]).toEqual([0, 0]);
    expect(by("fins").x).toBeLessThan(by("ship-body").x); // the tail
    expect(by("propeller-0").x).toBeLessThan(by("fins").x); // on the shaft past the fins' root
    expect(draws.filter((d) => d.name === "gondola-window").map((d) => d.x)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => SHIP_OFFSETS.windowX(i)));
    expect(by("ready-badge").x).toBeGreaterThan(by("ship-body").x); // on the nose
  });

  test("tints: fins = theme.ship darkened a quarter, body = theme.ship, stripe = shipStripe, light = shipLight, badge = gold; queue 0 swaps in the untinted ready-badge-dim", () => {
    const { draws } = render(0);
    const colour = (n: string): string | undefined => draws.find((d) => d.name === n)?.opts?.colour;
    expect(finsColour(chrome)).toBe(mix(chrome.ship, "#000000", 0.25));
    expect(colour("fins")).toBe(finsColour(chrome));
    expect(colour("ship-body")).toBe(chrome.ship);
    expect(colour("ship-stripe")).toBe(chrome.shipStripe);
    expect(colour("ship-gloss")).toBeUndefined();
    expect(colour("ship-light")).toBe(chrome.shipLight);
    expect(colour("ready-badge")).toBe(chrome.gold);
    const dim = render(0, LEVELS[5], { queue: 0 });
    expect(dim.names).toContain("ready-badge-dim");
    expect(dim.names).not.toContain("ready-badge");
    expect(dim.texts).toContain("×0");
  });

  test("the propeller frame is floor(t / 40) % 4; Level 1 alternates frames 0 and 2 (its 20 fps cannot show four)", () => {
    for (const t of [0, 45, 100, 130, 170, 1234]) {
      expect(propellerFrame(t, 5)).toBe(Math.floor(t / 40) % 4);
      expect(render(t).names).toContain(`propeller-${Math.floor(t / 40) % 4}`);
    }
    expect(propellerFrame(130, 1)).toBe(2); // 3 → 2
    expect(propellerFrame(90, 1)).toBe(0); // 2 → 0
    expect(propellerFrame(45, 1)).toBe(2); // 1 → 2
    expect(render(130, LEVELS[1]).names).toContain("propeller-2");
    expect(render(130, LEVELS[1]).names).not.toContain("propeller-3");
  });

  test("one Passenger by fillText per lit window (queue 3 → three), the ×N on the badge and the livery — never a name, never a dollar figure, no EXIT tag, no +N seat", () => {
    const { texts } = render(0);
    expect(texts.filter((t) => chrome.avatars.includes(t))).toEqual(passengers(chrome, 0).slice(0, 3));
    expect(texts).toContain("×3");
    expect(texts).toContain("DJ");
    expect(texts.join("\n")).not.toMatch(/\$|EXIT|\+\d|@|Anonymous/);
    // a Theme with no avatars still seats a glyph in every lit window
    const bare = render(0, LEVELS[5], { passengers: [] });
    expect(bare.texts.filter((t) => t === PASSENGER_FALLBACK)).toHaveLength(3);
    expect(bare.names.filter((n) => n === "gondola-window")).toHaveLength(7);
    expect(render(0, LEVELS[5], { passengers: [], queue: 7 }).texts.filter((t) => t === PASSENGER_FALLBACK)).toHaveLength(7);
  });

  test("the windows fill as Unlocks bank: seven gondola-window draws always; queue 0 → all dim glass (alpha 0.35) and no glyph; queue 3 → the three nose seats lit, four dim; 7 and 12 → all lit, the badge counting on", () => {
    const windows = (r: ReturnType<typeof render>) => r.draws.filter((d) => d.name === "gondola-window");
    const glyphs = (r: ReturnType<typeof render>) => (r.args.get("fillText") ?? []).filter((a) => chrome.avatars.includes(a[0] as string)).map((a) => ({ text: a[0] as string, x: a[1] as number }));
    const dark = render(0, LEVELS[5], { queue: 0 });
    expect(windows(dark)).toHaveLength(7);
    expect(windows(dark).map((d) => d.opts?.alpha)).toEqual(Array(7).fill(WINDOW_DIM_ALPHA));
    expect(glyphs(dark)).toEqual([]);
    expect(dark.texts).toContain("×0");
    expect(dark.names).toContain("ready-badge-dim");
    const three = render(0, LEVELS[5], { queue: 3 });
    // the sheet's windowX(i) counts from the tail: seats 6, 5, 4 are the ones by the nose
    expect(windows(three).map((d) => d.opts?.alpha ?? 1)).toEqual([WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA, WINDOW_DIM_ALPHA, 1, 1, 1]);
    expect(glyphs(three).map((g) => g.text)).toEqual(passengers(chrome, 0).slice(0, 3));
    expect(glyphs(three).map((g) => g.x)).toEqual([SHEET_SHIP.windowX(6), SHEET_SHIP.windowX(5), SHEET_SHIP.windowX(4)]);
    expect(glyphs(render(0, LEVELS[5], { queue: 3, facing: -1 })).map((g) => g.x)).toEqual([-SHEET_SHIP.windowX(6), -SHEET_SHIP.windowX(5), -SHEET_SHIP.windowX(4)]);
    for (const [queue, badge] of [[7, "×7"], [12, "×12"]] as const) {
      const r = render(0, LEVELS[5], { queue });
      expect(windows(r)).toHaveLength(7);
      expect(windows(r).every((d) => (d.opts?.alpha ?? 1) === 1)).toBe(true);
      expect(glyphs(r).map((g) => g.text)).toEqual(passengers(chrome, 0));
      expect(r.texts).toContain(badge);
      expect(r.texts.join("\n")).not.toMatch(/@/);
    }
  });

  test("the lit seats rotate on PASSENGER_ROTATE_MS and the lighting is a step on the queue alone: the same alphas every frame for 2 s (no blink, ≤ 2 Hz)", () => {
    const pick = (t: number) => render(t, LEVELS[5], { queue: 3 }).texts.filter((s) => chrome.avatars.includes(s));
    expect(pick(200)).toHaveLength(3);
    expect(pick(PASSENGER_ROTATE_MS + 200)[0]).toBe(pick(200)[1]);
    const seen = new Set<string>();
    for (let t = 0; t <= 2000; t += 16) seen.add(render(t, LEVELS[5], { queue: 3 }).draws.filter((d) => d.name === "gondola-window").map((d) => d.opts?.alpha ?? 1).join(","));
    expect(seen.size).toBe(1);
  });

  test("the running light pulses by alpha, smoothly, under 2 Hz: at most 4 rising edges over 2 s and never off", () => {
    const alphas: number[] = [];
    for (let t = 0; t <= 2000; t += 16) {
      const light = render(t).draws.find((d) => d.name === "ship-light")!;
      expect(light.opts?.alpha).toBe(shipLightAlpha(t));
      alphas.push(light.opts!.alpha!);
    }
    let rising = 0;
    for (let i = 2; i < alphas.length; i++) if (alphas[i]! > alphas[i - 1]! && alphas[i - 1]! <= alphas[i - 2]!) rising++;
    expect(rising).toBeLessThanOrEqual(4);
    expect(rising).toBeGreaterThanOrEqual(1);
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.3);
    expect(Math.min(...alphas)).toBeGreaterThan(0.2);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
  });

  test("facing left mirrors the frames with a negative x scale and mid-turn foreshortens them; the words are only ever foreshortened", () => {
    const right = render(0);
    expect((right.args.get("scale") ?? []).some((a) => (a[0] as number) < 0)).toBe(false);
    const left = render(0, LEVELS[5], { facing: -1 });
    expect(left.args.get("scale")![0]).toEqual([-1, 1]); // the sprites
    expect(left.args.get("scale")!.slice(1).every((a) => (a[0] as number) > 0)).toBe(true); // the text pass
    expect(left.texts.filter((t) => chrome.avatars.includes(t))).toHaveLength(3); // queue 3 → three lit seats
    const turning = render(0, LEVELS[5], { facing: 0.05 });
    expect(turning.args.get("scale")![0]![0]).toBeCloseTo(0.12, 9); // never thinner than 12 %
  });

  test("shipLightAt is where the ship-light frame lands on the canvas: the recorded draw put through the sprite pass's own translate and scale, nose-right, nose-left and mid-turn both ways", () => {
    for (const facing of [1, -1, 0.05, -0.5]) {
      const r = render(0, LEVELS[5], { facing });
      const light = r.draws.find((d) => d.name === "ship-light")!;
      const [tx, ty] = r.args.get("translate")![0] as [number, number];
      const [sx, sy] = r.args.get("scale")![0] as [number, number];
      const expected = shipLightAt({ x: 500, y: 120, facing });
      expect(tx + sx * light.x, `facing ${facing}`).toBeCloseTo(expected.x, 9);
      expect(ty + sy * light.y, `facing ${facing}`).toBeCloseTo(expected.y, 9);
    }
  });

  test("the club-deck path is untouched: no sprites → no drawImage, the procedural envelope, the EXIT tag, the ×N", () => {
    const c = fakeCtx();
    drawBlimp(c.ctx, chrome, frameAt(0));
    expect(c.calls.get("drawImage")).toBeUndefined();
    expect(c.calls.get("ellipse")!).toBeGreaterThan(0);
    expect(c.texts).toContain("EXIT");
    expect(c.texts).toContain("×3");
  });
});

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/schema.ts";
import { Drop, FLASH_MS, LIFT_MS, RESHUFFLE_AFTER_REVEALS_MS, RESHUFFLE_AFTER_TIER_MS, RevealQueue, flashOn, shufflePass, shufflePasses, syncOrder, type DropConfig, type DropFrame, type Fire } from "./drop.ts";
import { LEVELS, type LevelSpec } from "../quality.ts";
import type { Pad } from "./pads.ts";
import { seededRandom } from "./util.ts";
import { BANNER_MS } from "../alerts.ts";
import type { DrawOpts, SheetScale, SpriteSet } from "../sprites.ts";

interface SpriteDraw {
  name: string;
  scale: SheetScale;
  x: number;
  y: number;
  opts: DrawOpts | undefined;
}

/** A SpriteSet that records every `draw` (one drawImage on the context per call). */
function fakeSprites(): { set: SpriteSet; draws: SpriteDraw[] } {
  const draws: SpriteDraw[] = [];
  const set: SpriteSet = {
    id: "chrome-lounge",
    setDetail: () => {},
    get: () => ({ image: {} as CanvasImageSource, frame: { x: 0, y: 0, w: 140, h: 176, ax: 70, ay: 168, kind: "plate" }, scale: 1 }),
    has: () => true,
    names: () => [...new Set(draws.map((d) => d.name))],
    draw(ctx, name, scale, x, y, opts) {
      draws.push({ name, scale, x, y, opts });
      ctx.drawImage({} as CanvasImageSource, 0, 0);
    },
  };
  return { set, draws };
}

/** A counting 2-D context: how many times each method ran, and every fillText's text. */
function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number>; texts: string[] } {
  const calls = new Map<string, number>();
  const texts: string[] = [];
  const props: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_, key: string) {
      if (key in props) return props[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 7 });
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop(): void {} });
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (key === "fillText" || key === "strokeText") texts.push(String(args[0]));
      };
    },
    set(_, key: string, value) {
      props[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, texts };
}

const base = defaultConfig();
const theme = base.themes["club-deck"]!;
const cfg: DropConfig = { descentMs: 12000, maxAir: 6, revealMs: 3400, revealMiniDrawMs: 8500, shuffleMs: 3600 };
/** A fixed stand-in for the Quality Level table. */
const caps = (): LevelSpec => LEVELS[4];

/** A frozen strip of the tier-0 pads, widths ∝ stock left, over 220…1180. */
function padsOf(tier = 0): Pad[] {
  const live = base.outcomes.filter((o) => o.tier <= tier);
  const total = live.reduce((a, o) => a + o.initialLeft, 0);
  let x = 220;
  return live.map((o) => {
    const w = (o.initialLeft / total) * 960;
    const pad: Pad = { id: o.id, tier: o.tier, glyph: o.glyph, left: o.initialLeft, x, w, live: true, lift: 0 };
    x += w;
    return pad;
  });
}

/** 1080p: the sky over the tower heads runs 140 … 390 (the TIER 0 head sits at ~428). */
const FIREWORK_SKY = { top: 140, bottom: 390 };
const frame = (pads: Pad[] = padsOf()): DropFrame => ({ pads, strip: { x: 220, w: 960 }, door: { x: 456, y: 120 }, skyY: 60, groundY: 999, sceneL: 40, sceneR: 1510, fireworkSky: FIREWORK_SKY });
const fire = (seq: number, outcomeId: string, extra: Partial<Fire> = {}): Fire => ({ fireSeq: seq, outcomeId, solo: null, group: [], stockAfter: 1, ...extra });
const padOf = (pads: readonly Pad[], id: string): Pad => pads.find((p) => p.id === id)!;

describe("the pure schedules", () => {
  test("shufflePasses: three passes ~1.1 s apart, scaled to shuffleMs; shufflePass pairs pads up and swaps most pairs", () => {
    expect(shufflePasses(10000, 3600)).toEqual([10200, 11300, 12400]);
    expect(shufflePasses(0, 7200)).toEqual([400, 2600, 4800]);
    const order = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const after = shufflePass(order, seededRandom(3));
    expect([...after].sort()).toEqual([...order].sort());
    expect(after).not.toEqual(order);
    expect(order).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]); // pure
  });

  test("syncOrder: gone ids leave, new ids are dealt in at random positions, the rest keep their order", () => {
    const order = ["a", "b", "c", "d"];
    expect(syncOrder(order, ["d", "b", "a"], seededRandom(1))).toEqual(["a", "b", "d"]);
    const positions = new Set<number>();
    for (let seed = 1; seed < 40; seed++) positions.add(syncOrder(order, ["a", "b", "c", "d", "x"], seededRandom(seed)).indexOf("x"));
    expect(positions.size).toBeGreaterThan(2); // not always at the end
    expect(syncOrder([], ["p", "q", "r"], seededRandom(1))).toEqual(["p", "q", "r"]); // the first deal keeps the pool's order
  });

  test("flashOn: three blinks of 300 ms on / 300 ms off over 1.8 s — 1.67 Hz, never a strobe", () => {
    const on: number[] = [];
    for (let dt = 0; dt < 2400; dt += 50) on.push(flashOn(1000, 1000 + dt) ? 1 : 0);
    const edges = on.filter((v, i) => i > 0 && v !== on[i - 1]).length;
    expect(edges).toBe(5); // on-off-on-off-on-off: three blinks
    expect(on.slice(36)).toEqual(Array(on.length - 36).fill(0)); // over after FLASH_MS
    expect(FLASH_MS).toBe(1800);
  });

  test("RevealQueue: one at a time in landing order, each holding its slot, the counter knowing what is still to come", () => {
    const q = new RevealQueue();
    expect(q.step(0, cfg, 0)).toBeNull();
    q.push(fire(1, "stickers"));
    expect(q.step(100, cfg, 2)).toEqual({ kind: "start", fire: fire(1, "stickers"), n: 1, total: 3 });
    q.push(fire(2, "accent-switch"));
    expect(q.step(200, cfg, 1)).toBeNull();
    expect(q.step(100 + cfg.revealMs - 1, cfg, 1)).toBeNull();
    expect(q.step(100 + cfg.revealMs, cfg, 1)).toEqual({ kind: "start", fire: fire(2, "accent-switch"), n: 2, total: 3 });
    const mini = fire(3, "genre-roulette", { miniDraw: { title: "GENRE ROULETTE · 10–15 MIN", list: ["A", "B"], pick: "B" } });
    q.push(mini);
    expect(q.step(100 + 2 * cfg.revealMs, cfg, 0)).toEqual({ kind: "start", fire: mini, n: 3, total: 3 });
    expect(q.busy).toBe(true);
    expect(q.step(100 + 2 * cfg.revealMs + cfg.revealMiniDrawMs - 1, cfg, 0)).toBeNull();
    expect(q.step(100 + 2 * cfg.revealMs + cfg.revealMiniDrawMs, cfg, 0)).toEqual({ kind: "done" });
    expect(q.busy).toBe(false);
    q.push(fire(4, "stickers"));
    expect(q.step(50000, cfg, 0)).toEqual({ kind: "start", fire: fire(4, "stickers"), n: 1, total: 1 }); // a new batch counts from 1
  });
});

/** Run the drop to `untilMs`, collecting events with their times. */
function run(drop: Drop, from: number, untilMs: number, f: DropFrame, onFrame?: (t: number) => void): Array<{ t: number; e: ReturnType<Drop["step"]>[number] }> {
  const out: Array<{ t: number; e: ReturnType<Drop["step"]>[number] }> = [];
  for (let t = from; t < untilMs; t += 16) {
    onFrame?.(t);
    for (const e of drop.step(t, 16, f)) out.push({ t, e });
  }
  return out;
}

describe("Drop — jumpers steered to the drawn pad, reveals in landing order, then one shuffle", () => {
  test("three fires: three jumpers, each lands on its named pad; reveals 1 OF 3 … 3 OF 3 in landing order, revealMs apart; frozen throughout; then the shuffle", () => {
    const logs: string[] = [];
    const drop = new Drop(seededRandom(11), () => cfg, () => theme, caps, (m) => logs.push(m));
    const f = frame();
    expect(drop.frozen()).toBe(false);
    drop.step(0, 16, f);
    drop.fire(fire(1, "stickers"), 0);
    drop.fire(fire(2, "friend-picks-three"), 300);
    drop.fire(fire(3, "costume-30-min"), 900);
    expect(drop.jumpers).toHaveLength(3);
    expect(drop.frozen()).toBe(true);
    // the last sight of each jumper before touchdown (within 8 px of the line): where it lands, and when
    const landings: Array<{ id: string; x: number; t: number }> = [];
    const events = run(drop, 16, 60000, f, (t) => {
      for (const J of drop.jumpers) {
        if (J.y + 8 < f.groundY) continue;
        const seen = landings.find((l) => l.id === J.padId);
        if (seen === undefined) landings.push({ id: J.padId, x: J.x + J.spiralOff, t });
        else Object.assign(seen, { x: J.x + J.spiralOff, t });
      }
    });
    expect(landings).toHaveLength(3);
    for (const l of landings) {
      const pad = padOf(f.pads, l.id);
      expect(Math.abs(l.x - (pad.x + pad.w / 2))).toBeLessThanOrEqual(2);
    }
    const reveals = events.filter((x) => x.e.kind === "reveal");
    expect(reveals.map((r) => (r.e.kind === "reveal" ? [r.e.fire.outcomeId, r.e.n, r.e.total] : null))).toEqual(landings.map((l, i) => [l.id, i + 1, 3]));
    for (let i = 0; i < 3; i++) {
      // each reveal starts at its landing, or when the previous slot ends, whichever is later (within a frame or two)
      const due = Math.max(landings[i]!.t, i === 0 ? 0 : reveals[i - 1]!.t + cfg.revealMs);
      expect(reveals[i]!.t).toBeGreaterThanOrEqual(due);
      expect(reveals[i]!.t).toBeLessThan(due + 100);
    }
    expect(reveals.map((r) => (r.e.kind === "reveal" ? r.e.padX : 0))).toEqual(landings.map((l) => padOf(f.pads, l.id).x + padOf(f.pads, l.id).w / 2));
    // frozen through the reveals, thawed after the last one, the shuffle 900 ms later with three passes
    const lastRevealEnd = reveals[2]!.t + cfg.revealMs;
    const drop2 = new Drop(seededRandom(11), () => cfg, () => theme, caps, (m) => logs.push(m));
    drop2.step(0, 16, f);
    drop2.fire(fire(1, "stickers"), 0);
    drop2.fire(fire(2, "friend-picks-three"), 300);
    drop2.fire(fire(3, "costume-30-min"), 900);
    const frozenAt: number[] = [];
    const shufflingAt: number[] = [];
    const orders: string[][] = [];
    const rates = new Map<number, number>();
    const ids = f.pads.map((p) => ({ id: p.id }));
    run(drop2, 16, 60000, f, (t) => {
      if (drop2.frozen()) frozenAt.push(t);
      if (drop2.shuffling(t)) shufflingAt.push(t);
      rates.set(t, drop2.slideRate(t));
      orders.push(drop2.order(ids).map((o) => o.id));
    });
    expect(frozenAt[0]).toBe(16);
    expect(Math.abs(frozenAt[frozenAt.length - 1]! - (lastRevealEnd - 16))).toBeLessThan(40);
    expect(shufflingAt[0]! - lastRevealEnd).toBeGreaterThanOrEqual(RESHUFFLE_AFTER_REVEALS_MS - 16);
    expect(shufflingAt[0]! - lastRevealEnd).toBeLessThan(RESHUFFLE_AFTER_REVEALS_MS + 40);
    expect(shufflingAt[shufflingAt.length - 1]! - shufflingAt[0]!).toBeGreaterThanOrEqual(cfg.shuffleMs - 32);
    const changes = orders.filter((o, i) => i > 0 && o.join() !== orders[i - 1]!.join()).length;
    expect(changes).toBe(3); // three passes, nothing else reorders the strip
    expect(rates.get(shufflingAt[10]!)).toBe(0.05);
    expect(rates.get(shufflingAt[shufflingAt.length - 1]! + 16 * 30)).toBe(0.05); // and for a beat after
    expect(rates.get(shufflingAt[shufflingAt.length - 1]! + 16 * 60)).toBe(0.14);
    expect(rates.get(frozenAt[100]!)).toBe(0.14);
    expect(logs).toEqual([]);
  });

  test("MUST 1: the jumper does not vanish at touchdown — a landed pose stands on the pad (canopy gone, nobody named) for the banner's BANNER_MS, then goes", () => {
    const drop = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.fire(fire(1, "accent-switch"), 0);
    let landAt = -1;
    run(drop, 16, 30000, f, (t) => {
      if (landAt < 0 && drop.jumpers.length === 0) landAt = t - 16; // the frame the jumper left the air
    });
    expect(landAt).toBeGreaterThan(0);
    const drop2 = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    drop2.step(0, 16, f);
    drop2.fire(fire(1, "accent-switch"), 0);
    run(drop2, 16, landAt + 16, f);
    expect(drop2.jumpers).toHaveLength(0);
    expect(drop2.landed).toHaveLength(1);
    const pad = padOf(f.pads, "accent-switch");
    expect(drop2.landed[0]).toMatchObject({ fireSeq: 1, padId: "accent-switch" });
    expect(Math.abs(drop2.landed[0]!.x - (pad.x + pad.w / 2))).toBeLessThanOrEqual(2);
    expect(Object.keys(drop2.landed[0]!)).not.toContain("who"); // nobody is pictured or named on the pad
    // still standing just before the banner would go …
    run(drop2, landAt + 16, landAt + BANNER_MS - 16, f);
    expect(drop2.landed).toHaveLength(1);
    // … drawn as the sheet's standing pilot on the touchdown line, with the sharp shadow and no canopy or risers
    const sp = fakeSprites();
    const { ctx, texts } = fakeCtx();
    drop2.draw(ctx, theme, f, landAt + BANNER_MS - 16, sp.set);
    const names = sp.draws.map((d) => d.name);
    expect(names).toContain("pilot");
    expect(names).toContain("pilot-shadow-2");
    expect(names.some((n) => n.startsWith("canopy") || n === "risers")).toBe(false);
    expect(sp.draws.find((d) => d.name === "pilot-shadow-2")!.y).toBe(f.groundY);
    expect(texts.join("\n")).not.toMatch(/@|Anonymous/);
    // … and gone once the banner is
    run(drop2, landAt + BANNER_MS - 16, landAt + BANNER_MS + 48, f);
    expect(drop2.landed).toHaveLength(0);
    // the club-deck path draws the standing pilot's disc procedurally: no image, no text
    const club = fakeCtx();
    const drop3 = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    drop3.step(0, 16, f);
    drop3.fire(fire(1, "accent-switch"), 0);
    run(drop3, 16, landAt + 32, f);
    drop3.draw(club.ctx, theme, f, landAt + 32);
    expect(club.calls.get("drawImage")).toBeUndefined();
    expect(club.calls.get("arc")).toBeGreaterThan(0);
    expect(club.texts.join("")).not.toMatch(/[@A-Za-z0-9]/); // only the wind's bits (♪ ·) — no name, no word on the pad
  });

  test("a mini-draw landing keeps the pilot on the pad for the whole reel (revealMiniDrawMs), not just BANNER_MS", () => {
    const f = frame();
    const probe = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    probe.step(0, 16, f);
    probe.fire({ ...fire(1, "accent-switch"), miniDraw: { title: "GENRE ROULETTE", list: ["FUNK", "SOUL", "DISCO"], pick: "SOUL" } }, 0);
    let landAt = -1;
    run(probe, 16, 30000, f, (t) => {
      if (landAt < 0 && probe.jumpers.length === 0) landAt = t - 16;
    });
    expect(landAt).toBeGreaterThan(0);
    const drop = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    drop.step(0, 16, f);
    drop.fire({ ...fire(1, "accent-switch"), miniDraw: { title: "GENRE ROULETTE", list: ["FUNK", "SOUL", "DISCO"], pick: "SOUL" } }, 0);
    run(drop, 16, landAt + BANNER_MS + 200, f);
    expect(drop.landed).toHaveLength(1); // a plain banner would be over by now; the reel is still spinning
    run(drop, landAt + BANNER_MS + 200, landAt + cfg.revealMiniDrawMs - 100, f);
    expect(drop.landed).toHaveLength(1);
    run(drop, landAt + cfg.revealMiniDrawMs - 100, landAt + cfg.revealMiniDrawMs + 200, f);
    expect(drop.landed).toHaveLength(0);
  });

  test("a landing lights its pad: three blinks from the reveal, and the reveal pad lifts nothing", () => {
    const drop = new Drop(seededRandom(2), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.fire(fire(1, "accent-switch"), 0);
    const events = run(drop, 16, 30000, f);
    const reveal = events.find((x) => x.e.kind === "reveal")!;
    expect(drop.flashing(reveal.t + 100)).toBe("accent-switch");
    expect(drop.flashing(reveal.t + 400)).toBeNull();
    expect(drop.flashing(reveal.t + 700)).toBe("accent-switch");
    expect(drop.flashing(reveal.t + FLASH_MS + 1)).toBeNull();
  });

  test("past maxAir the extra fires wait in a FIFO and launch as slots free — from the door as it is then", () => {
    const drop = new Drop(seededRandom(5), () => ({ ...cfg, maxAir: 2 }), () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    for (let i = 1; i <= 4; i++) drop.fire(fire(i, "stickers"), i * 10);
    expect(drop.jumpers.map((j) => j.fireSeq)).toEqual([1, 2]);
    expect(drop.jumpers.map((j) => j.fire)).toEqual([fire(1, "stickers"), fire(2, "stickers")]); // each jumper carries its own effect for the reveal
    expect(drop.pending.map((p) => p.fireSeq)).toEqual([3, 4]);
    const f2 = { ...f, door: { x: 900, y: 130 } };
    const launched: number[] = [];
    let most = 0;
    run(drop, 16, 60000, f2, () => {
      most = Math.max(most, drop.jumpers.length);
      for (const J of drop.jumpers) if (!launched.includes(J.fireSeq)) launched.push(J.fireSeq);
    });
    expect(most).toBe(2);
    expect(launched).toEqual([1, 2, 3, 4]);
    expect(drop.pending).toHaveLength(0);
    expect(drop.jumpers).toHaveLength(0);
  });

  test("a mini-draw reveal holds revealMiniDrawMs; a tier_open with nobody in the air deals the new pads in and reshuffles at once", () => {
    const drop = new Drop(seededRandom(6), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.order(f.pads); // the scene deals the strip through the drop every frame: the tier-0 pads are the first deal
    const mini = fire(1, "accent-switch", { miniDraw: { title: "CHAT RULE · 10 MIN", list: ["A", "B", "C"], pick: "C" } });
    drop.fire(mini, 0);
    drop.fire(fire(2, "stickers"), 100);
    const events = run(drop, 16, 60000, f);
    const reveals = events.filter((x) => x.e.kind === "reveal");
    expect(reveals).toHaveLength(2);
    const first = reveals[0]!.e.kind === "reveal" ? reveals[0]!.e.fire : null;
    const gap = reveals[1]!.t - reveals[0]!.t;
    if (first?.fireSeq === 1) expect(gap).toBeGreaterThanOrEqual(cfg.revealMiniDrawMs);
    else expect(gap).toBeGreaterThanOrEqual(cfg.revealMs);
    // idle now: a tier opening deals the tier-1 pads in at random and the shuffle starts 600 ms later
    const t0 = 60000;
    const tier1 = padsOf(1).map((p) => ({ id: p.id }));
    drop.tierOpen(t0);
    const before = drop.order(tier1).map((o) => o.id);
    expect([...before].sort()).toEqual(tier1.map((o) => o.id).sort());
    expect(before.slice(0, 12)).not.toEqual(tier1.slice(0, 12).map((o) => o.id)); // dealt in among the old ones
    expect(drop.shuffling(t0 + RESHUFFLE_AFTER_TIER_MS - 16)).toBe(false);
    expect(drop.shuffling(t0 + RESHUFFLE_AFTER_TIER_MS + 16)).toBe(true);
    run(drop, t0, t0 + 5000, frame(padsOf(1)));
    expect(drop.order(tier1).map((o) => o.id)).not.toEqual(before);
    expect(drop.shuffling(t0 + 5000)).toBe(false);
    // a tier opening with someone in the air does not reshuffle now (the post-reveal shuffle covers it)
    drop.fire(fire(9, "stickers"), t0 + 5000);
    drop.tierOpen(t0 + 5000);
    expect(drop.shuffling(t0 + 5000 + RESHUFFLE_AFTER_TIER_MS + 16)).toBe(false);
  });

  test("a fire whose pad is not in the layout lands at the strip's centre and still reveals with the effect's data — logged once per outcome, never thrown", () => {
    const logs: string[] = [];
    const drop = new Drop(seededRandom(7), () => cfg, () => theme, caps, (m) => logs.push(m));
    const f = frame();
    drop.fire(fire(1, "pie-to-the-face", { stockAfter: 0 }), 0); // before any frame: waits for the first, warns when it launches
    expect(logs).toEqual([]);
    drop.step(0, 16, f);
    drop.fire(fire(2, "stickers"), 50);
    let landX = 0;
    const events = run(drop, 16, 40000, f, () => {
      for (const J of drop.jumpers) if (J.y + 3 >= f.groundY && J.padId === "pie-to-the-face") landX = J.x + J.spiralOff;
    });
    expect(Math.abs(landX - (f.strip.x + f.strip.w / 2))).toBeLessThanOrEqual(2);
    const reveal = events.find((x) => x.e.kind === "reveal" && x.e.fire.outcomeId === "pie-to-the-face")!;
    expect(reveal.e).toMatchObject({ kind: "reveal", fire: { outcomeId: "pie-to-the-face", stockAfter: 0 }, padX: f.strip.x + f.strip.w / 2 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("pie-to-the-face");
    drop.fire(fire(3, "pie-to-the-face"), 40000); // the same missing pad again: already said
    drop.fire(fire(4, "guest-takeover"), 40010); // a different one: said once too
    run(drop, 40016, 40100, f);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("guest-takeover");
  });

  test("a pad dealt in while the jumper is already in the air becomes its target: it lands there, not at the strip's centre", () => {
    const drop = new Drop(seededRandom(7), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.fire(fire(1, "shirt-t1"), 0);
    run(drop, 16, 2000, f);
    const later = frame([...padsOf(), { id: "shirt-t1", tier: 1, glyph: "👕", left: 2, x: 1180, w: 60, live: true, lift: 0 }]); // appended past the frozen strip's end
    let landX = 0;
    const events = run(drop, 2000, 40000, later, () => {
      for (const J of drop.jumpers) if (J.y + 3 >= f.groundY) landX = J.x + J.spiralOff;
    });
    expect(Math.abs(landX - 1210)).toBeLessThanOrEqual(2);
    expect(events.find((x) => x.e.kind === "reveal")!.e).toMatchObject({ kind: "reveal", padX: 1210 });
  });

  test("celebrations: the particle burst honours the particle cap, fireworks(i) bursts are spaced out over the floor; a fire mid-shuffle cancels the shuffle", () => {
    const drop = new Drop(seededRandom(8), () => cfg, () => theme, () => ({ ...LEVELS[4], particleCap: 120 }), () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.celebrate(1, "🎧", 0, f);
    expect(drop.particles.list).toHaveLength(120);
    expect(drop.particles.list.every((p) => p.x >= f.sceneL + 40 && p.x <= f.sceneR - 40)).toBe(true);
    drop.celebrate(0.78, "🎧", 16, f);
    expect(drop.particles.list).toHaveLength(120);
    let bursts = 0;
    const burst = drop.fireworks.burst.bind(drop.fireworks);
    const burstY: number[] = [];
    drop.fireworks.burst = (x, y, col, rng) => {
      bursts++;
      burstY.push(y);
      burst(x, y, col, rng);
    };
    run(drop, 16, 6000, f);
    expect(bursts).toBe(6); // fireworks(0.78) = round(2 + 16 × 0.28)
    expect(drop.fireworks.list.every((s) => s.y < f.groundY)).toBe(true);
    // MUST 5: every burst is born in the sky band over the tower heads (the boards put them between the airship and the horizon), never at head height or below the horizon
    for (const y of burstY) {
      expect(y).toBeGreaterThanOrEqual(f.fireworkSky.top);
      expect(y).toBeLessThanOrEqual(f.fireworkSky.bottom);
    }
    expect(Math.max(...burstY) - Math.min(...burstY)).toBeGreaterThan(40); // spread through the band, not one row
    drop.tierOpen(10000);
    expect(drop.shuffling(10000 + RESHUFFLE_AFTER_TIER_MS + 16)).toBe(true);
    drop.fire(fire(1, "stickers"), 10000 + RESHUFFLE_AFTER_TIER_MS + 16);
    expect(drop.shuffling(10000 + RESHUFFLE_AFTER_TIER_MS + 32)).toBe(false);
    expect(drop.frozen()).toBe(true);
  });

  test("a fire mid-pass stops the shuffle where it is but lets a lifted tile finish its arc (no snap to the floor)", () => {
    const drop = new Drop(seededRandom(8), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    const ids = f.pads.map((p) => ({ id: p.id }));
    drop.order(ids);
    drop.tierOpen(0);
    run(drop, 16, RESHUFFLE_AFTER_TIER_MS + 300, f, (t) => void drop.order(ids)); // through the first pass (+200 ms into the shuffle)
    const t0 = RESHUFFLE_AFTER_TIER_MS + 300;
    const lifted = ids.map((o) => o.id).filter((id) => drop.lift(id, t0) > 0);
    expect(lifted.length).toBeGreaterThan(0);
    const id = lifted[0]!;
    const before = drop.lift(id, t0);
    drop.fire(fire(1, "stickers"), t0);
    expect(drop.shuffling(t0 + 16)).toBe(false);
    expect(drop.lift(id, t0 + 16)).toBeGreaterThan(0); // still in the air
    expect(Math.abs(drop.lift(id, t0 + 16) - before)).toBeLessThan(3); // and where it was, not snapped down
    expect(drop.lift(id, RESHUFFLE_AFTER_TIER_MS + 200 + LIFT_MS)).toBe(0); // down when its own arc (from the pass) ends
    run(drop, t0 + 16, t0 + LIFT_MS, f, (t) => void drop.order(ids));
    expect(ids.every((o) => drop.lift(o.id, t0 + LIFT_MS) === 0)).toBe(true);
  });

  test("drained: the moment waits for the reveals to finish (at once when nothing is in the air)", () => {
    const drop = new Drop(seededRandom(9), () => cfg, () => theme, caps, () => undefined);
    const f = frame();
    drop.step(0, 16, f);
    drop.fire(fire(1, "stickers", { stockAfter: 0 }), 0);
    drop.drained();
    const events = run(drop, 16, 40000, f);
    const kinds = events.map((x) => x.e.kind);
    expect(kinds).toEqual(["reveal", "drained"]);
    expect(events[1]!.t - events[0]!.t).toBeGreaterThanOrEqual(cfg.revealMs);
    drop.drained();
    expect(drop.step(40000, 16, f)).toEqual([{ kind: "drained" }]);
  });
});

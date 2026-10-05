import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/schema.ts";
import { LOCKED_GLYPH, type OverlayOutcome } from "../../server/overlay.ts";
import { OverlayModel } from "../state.ts";
import { LEVELS } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { PadLayout, SLIDE_RATE, drawLockLabel, drawPads, livePads, lockPads, padSprites, padState, type Pad, type PadSource } from "./pads.ts";

const base = defaultConfig();

/** The pool as the model hands it to the scene: masked above `tier`. */
function outcomes(tier: number, edit?: (o: OverlayOutcome) => void): OverlayOutcome[] {
  return base.outcomes.map((o) => {
    const open = o.tier <= tier;
    const out: OverlayOutcome = { id: o.id, name: open ? o.name : null, nameLength: o.name.length, glyph: open ? o.glyph : LOCKED_GLYPH, shape: o.shape, tier: o.tier, left: o.initialLeft, used: 0, status: "live" };
    edit?.(out);
    return out;
  });
}

const STRIP = { x: 100, w: 1000 };

/** Run `n` frames at k = 1 (16.67 ms each). */
function settle(layout: PadLayout, live: PadSource[], n = 400, frozen = false): void {
  for (let i = 0; i < n; i++) layout.update(live, STRIP, 1, frozen);
}

describe("livePads — which outcomes get a pad", () => {
  test("open tiers only, unmasked, status live; in pool order", () => {
    const pads = livePads(outcomes(0, (o) => void (o.id === "shirt-t0" && (o.status = "suspended"))), 0);
    expect(pads.map((p) => p.id)).toEqual(base.outcomes.filter((o) => o.tier === 0 && o.id !== "shirt-t0").map((o) => o.id));
    expect(pads[0]).toEqual({ id: "stickers", tier: 0, glyph: "🎟️", left: 5 });
    expect(livePads(outcomes(1), 1).filter((p) => p.tier === 1)).toHaveLength(8);
    expect(livePads(outcomes(0), 1)).toHaveLength(12); // the view's tier is what the model shows, but a masked outcome never gets a pad
  });

  test("a DONE outcome keeps its pad (left 0) — it is greyed, not removed", () => {
    const pads = livePads(outcomes(0, (o) => void (o.id === "accent-switch" && (o.left = 0))), 0);
    expect(pads.find((p) => p.id === "accent-switch")).toEqual({ id: "accent-switch", tier: 0, glyph: "🗣️", left: 0 });
  });
});

describe("PadLayout — width ∝ stock left, pool order, frozen while jumpers are in the air", () => {
  test("settled widths are proportional to the stock left and fill the strip edge to edge, in order", () => {
    const layout = new PadLayout();
    const live = livePads(outcomes(0), 0);
    settle(layout, live);
    const pads = layout.pads;
    expect(pads.map((p) => p.id)).toEqual(live.map((p) => p.id));
    const total = live.reduce((a, p) => a + p.left, 0); // 17
    for (const p of pads) expect(p.w).toBeCloseTo((p.left / total) * STRIP.w, 3);
    expect(pads[0]!.x).toBeCloseTo(STRIP.x, 3);
    for (let i = 1; i < pads.length; i++) expect(pads[i]!.x).toBeCloseTo(pads[i - 1]!.x + pads[i - 1]!.w, 3);
    expect(pads[pads.length - 1]!.x + pads[pads.length - 1]!.w).toBeCloseTo(STRIP.x + STRIP.w, 3);
    expect(pads.every((p) => p.live)).toBe(true);
  });

  test("the first frame lays out at the target (no growth from nothing on load); the pads array is reused", () => {
    const layout = new PadLayout();
    const live = livePads(outcomes(0), 0);
    const first = layout.update(live, STRIP, 1, false);
    expect(first[0]!.w).toBeCloseTo((5 / 17) * STRIP.w, 3);
    expect(layout.update(live, STRIP, 1, false)).toBe(first);
  });

  test("a fire leaves the pad unchanged while its jumper is in the air — the model holds the pre-fire stock — and greys it at `revealed`", () => {
    const cfg = base.overlay;
    const skin = { config: cfg, theme: base.themes[cfg.theme]!, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } };
    const pool = outcomes(0);
    const m = new OverlayModel(cfg);
    m.apply({ type: "snapshot", state: { thresholdCents: 5000, progressCents: 0, queue: 1, bankedTotal: 1, tier: 0, gates: [0, 3, 6], outcomes: pool, drained: false, motes: { collecting: [], ready: [] } }, skin, chatters: [] }, 0);
    const layout = new PadLayout();
    settle(layout, livePads(m.view.outcomes, m.view.tier));
    const before = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w, live: p.live, left: p.left }));
    const after = pool.map((o) => (o.id === "accent-switch" ? { ...o, left: 0, used: 1 } : o));
    m.apply({ type: "fire", fireSeq: 1, outcomeId: "accent-switch", solo: null, group: [], stockAfter: 0, state: { thresholdCents: 5000, progressCents: 0, queue: 0, bankedTotal: 1, tier: 0, gates: [0, 3, 6], outcomes: after, drained: false, motes: { collecting: [], ready: [] } } }, 100);
    settle(layout, livePads(m.view.outcomes, m.view.tier), 50, true); // in the air: the strip is frozen and the pad still reads ×1, live
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w, live: p.live, left: p.left }))).toEqual(before);
    m.revealed(1); // the banner names it: DONE on the same frame, still in place
    settle(layout, livePads(m.view.outcomes, m.view.tier), 1, true);
    expect(layout.pads.find((p) => p.id === "accent-switch")).toMatchObject({ live: false, left: 0, x: before.find((p) => p.id === "accent-switch")!.x, w: before.find((p) => p.id === "accent-switch")!.w });
  });

  test("frozen: a pad the view says ran out keeps its place and width, greyed; after the thaw it collapses and the rest expand", () => {
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    const before = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
    const done = livePads(outcomes(0, (o) => void (o.id === "stickers" && (o.left = 0))), 0);
    settle(layout, done, 50, true);
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before);
    expect(layout.pads[0]).toMatchObject({ id: "stickers", live: false, left: 0 });
    settle(layout, done, 600, false);
    expect(layout.pads[0]!.w).toBeLessThan(0.5);
    expect(layout.pads[1]!.x).toBeCloseTo(STRIP.x, 1);
    expect(layout.pads[1]!.w).toBeCloseTo((1 / 12) * STRIP.w, 1);
  });

  test("a tier opening deals its pads in at the end of the strip, growing from nothing", () => {
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    const opened = livePads(outcomes(1), 1);
    const pads = layout.update(opened, STRIP, 1, false);
    expect(pads.map((p) => p.id).slice(12)).toEqual(opened.slice(12).map((p) => p.id));
    expect(pads[12]!.w).toBeLessThan(10); // eased in from 0 (8 % of the way on the first frame)
    settle(layout, opened);
    expect(pads[12]!.w).toBeCloseTo((2 / 27) * STRIP.w, 2); // shirt-t1, 2 of 27 left
  });

  test("an outcome that leaves the pool (retired) drops its pad; a frozen strip ignores the change until the thaw", () => {
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    const gone = livePads(outcomes(0, (o) => void (o.id === "accent-switch" && (o.status = "retired"))), 0);
    layout.update(gone, STRIP, 1, true);
    expect(layout.pads).toHaveLength(12);
    layout.update(gone, STRIP, 1, false);
    expect(layout.pads).toHaveLength(11);
    expect(layout.pads.some((p) => p.id === "accent-switch")).toBe(false);
  });
});

describe("PadLayout — an Outcome edit mid-drop (a `state` with reason \"outcomes\" / \"stock\" while the strip is frozen)", () => {
  const five: PadSource[] = ["a", "b", "c", "d", "e"].map((id, i) => ({ id, tier: 0, glyph: "🎟️", left: i + 1 }));
  /** The editor removed `c`, added `f` and set `a`'s Left 1 → 3 — all while a jumper is in the air. */
  const edited: PadSource[] = [{ ...five[0]!, left: 3 }, five[1]!, five[3]!, five[4]!, { id: "f", tier: 0, glyph: "🎁", left: 4 }];
  const geometry = (layout: PadLayout): Array<{ id: string; x: number; w: number }> => layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
  const ids = (layout: PadLayout): string[] => layout.pads.map((p) => p.id);

  test("frozen: the strip keeps the old five in place — the vanished pad stays, the new one waits, Left refreshes where the id still exists", () => {
    const layout = new PadLayout();
    settle(layout, five);
    const before = geometry(layout);
    settle(layout, edited, 50, true);
    expect(geometry(layout)).toEqual(before); // nothing moved, nothing left, nothing came
    expect(ids(layout)).toEqual(["a", "b", "c", "d", "e"]);
    expect(layout.pads[0]).toMatchObject({ id: "a", left: 3, live: true }); // ×3 on the tile; the width still ∝ the old Left until the thaw
    expect(layout.pads[2]).toMatchObject({ id: "c", left: 3, live: true }); // the vanished one reads as it did: a jumper may be steering for it
    settle(layout, five, 50, true); // the edit undone while still frozen: still nothing
    expect(geometry(layout)).toEqual(before);
    settle(layout, edited, 50, true);
    expect(geometry(layout)).toEqual(before);
  });

  test("the thaw: the vanished pad leaves, the new one appends and grows in, the strip re-spreads ∝ the new Left — never a duplicate id", () => {
    const layout = new PadLayout();
    settle(layout, five);
    settle(layout, edited, 50, true);
    const first = layout.update(edited, STRIP, 1, false);
    expect(first.map((p) => p.id)).toEqual(["a", "b", "d", "e", "f"]); // one frame: the set is the new list, in its order
    expect(first[4]!.w).toBeLessThan(((4 / 14) * STRIP.w) / 5); // f eases in from nothing (8 % of the way on the first frame)
    for (let i = 0; i < 600; i++) {
      layout.update(edited, STRIP, 1, false);
      expect(new Set(ids(layout)).size).toBe(layout.pads.length);
    }
    const total = edited.reduce((a, p) => a + p.left, 0); // 14
    for (const p of layout.pads) expect(p.w).toBeCloseTo((p.left / total) * STRIP.w, 2);
    expect(layout.pads[0]!.x).toBeCloseTo(STRIP.x, 2);
    expect(layout.pads[4]!.x + layout.pads[4]!.w).toBeCloseTo(STRIP.x + STRIP.w, 2);
  });

  test("frozen with room (the lock tile vacated): the new pad is dealt into the free width at once, the vanished one still stays until the thaw", () => {
    const layout = new PadLayout();
    settle(layout, five);
    const before = geometry(layout);
    const wider = { x: STRIP.x, w: STRIP.w + 150 };
    layout.update(edited, wider, 1, true);
    expect(ids(layout)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(geometry(layout).slice(0, 5)).toEqual(before);
    expect(layout.pads[5]).toMatchObject({ id: "f", x: STRIP.x + STRIP.w, w: 150, live: true });
    settle(layout, edited, 50, true);
    expect(ids(layout)).toEqual(["a", "b", "c", "d", "e", "f"]);
    for (let i = 0; i < 600; i++) layout.update(edited, wider, 1, false);
    expect(ids(layout)).toEqual(["a", "b", "d", "e", "f"]);
    const total = edited.reduce((a, p) => a + p.left, 0);
    for (const p of layout.pads) expect(p.w).toBeCloseTo((p.left / total) * wider.w, 2);
  });
});

describe("PadLayout — a tier dealt in while frozen (the lock tile's space)", () => {
  test("new pads are appended into the width the lock tile vacated, edge to edge, ∝ left; every frozen pad keeps its place and width", () => {
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    const before = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
    const opened = livePads(outcomes(1), 1);
    const wider = { x: STRIP.x, w: STRIP.w + 150 }; // the last tier opened: the lock tile on the right is gone
    settle(layout, opened, 5, true);
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w })).slice(0, 12)).toEqual(before); // nothing moved
    expect(layout.pads).toHaveLength(12); // no room yet: the strip is the same width
    layout.update(opened, wider, 1, true);
    expect(layout.pads.map((p) => p.id)).toEqual(opened.map((p) => p.id)); // the old strip, then the new tier at the rack-side end
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w })).slice(0, 12)).toEqual(before);
    const added = layout.pads.slice(12);
    const total = added.reduce((a, p) => a + p.left, 0);
    let x = STRIP.x + STRIP.w;
    for (const p of added) {
      expect(p.x).toBeCloseTo(x, 3);
      expect(p.w).toBeCloseTo((p.left / total) * 150, 3);
      expect(p.live).toBe(true);
      x += p.w;
    }
    expect(x).toBeCloseTo(wider.x + wider.w, 3);
    settle(layout, opened, 50, true); // frozen: they stay put
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w })).slice(0, 12)).toEqual(before);
    expect(layout.pads[12]!.x).toBeCloseTo(STRIP.x + STRIP.w, 3);
    for (let i = 0; i < 600; i++) layout.update(opened, wider, 1, false); // the thaw: the whole strip re-spreads ∝ left
    const all = opened.reduce((a, p) => a + p.left, 0);
    for (const p of layout.pads) expect(p.w).toBeCloseTo((p.left / all) * wider.w, 2);
  });

  test("rack on the left: the vacated width is on the left, so the new pads go in front", () => {
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    const before = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
    const opened = livePads(outcomes(1), 1);
    layout.update(opened, { x: STRIP.x - 150, w: STRIP.w + 150 }, 1, true);
    expect(layout.pads.map((p) => p.id)).toEqual([...opened.slice(12).map((p) => p.id), ...opened.slice(0, 12).map((p) => p.id)]);
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w })).slice(8)).toEqual(before);
    expect(layout.pads[0]!.x).toBeCloseTo(STRIP.x - 150, 3);
    expect(layout.pads[7]!.x + layout.pads[7]!.w).toBeCloseTo(STRIP.x, 3);
  });
});

describe("PadLayout — the shuffle hooks", () => {
  test("a permuted list slides the pads to their new places at the slide rate given; the default is SLIDE_RATE", () => {
    const layout = new PadLayout();
    const live = livePads(outcomes(0), 0);
    settle(layout, live);
    const xBefore = new Map(layout.pads.map((p) => [p.id, p.x]));
    const swapped = [...live];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    layout.update(swapped, STRIP, 1, false, 0.05);
    const slow = layout.pads.find((p) => p.id === "stickers")!.x - xBefore.get("stickers")!;
    const layout2 = new PadLayout();
    settle(layout2, live);
    layout2.update(swapped, STRIP, 1, false);
    const fast = layout2.pads.find((p) => p.id === "stickers")!.x - xBefore.get("stickers")!;
    expect(slow).toBeGreaterThan(0);
    expect(fast / slow).toBeCloseTo(SLIDE_RATE / 0.05, 3);
    expect(layout.pads.map((p) => p.id).slice(0, 2)).toEqual(["shirt-t0", "stickers"]); // strip order = the list's order
    expect(layout.pads.every((p) => p.lift === 0)).toBe(true);
  });

  test("a freeze mid-slide keeps the target layout but lets the tiles finish sliding into place (no overlap under a jumper)", () => {
    const layout = new PadLayout();
    const live = livePads(outcomes(0), 0);
    settle(layout, live);
    const swapped = [...live];
    [swapped[0], swapped[5]] = [swapped[5]!, swapped[0]!];
    layout.update(swapped, STRIP, 1, false, 0.05); // one slow frame into the shuffle …
    const midway = layout.pads.map((p) => p.x);
    settle(layout, swapped, 400, true); // … then a fire freezes the strip
    const settled = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
    expect(settled.map((p) => p.x)).not.toEqual(midway);
    for (let i = 1; i < settled.length; i++) expect(settled[i]!.x).toBeCloseTo(settled[i - 1]!.x + settled[i - 1]!.w, 3); // edge to edge, in the swapped order
    expect(settled[0]!.id).toBe(swapped[0]!.id);
    settle(layout, live, 400, true); // a different order while frozen changes nothing
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(settled);
  });

  test("drawPads lifts a pad by its lift and paints the flashing pad white", () => {
    const layout = new PadLayout();
    const live = livePads(outcomes(0), 0);
    settle(layout, live);
    const ys: number[] = [];
    const fills: string[] = [];
    let fillStyle = "";
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_, key: string) => (key === "measureText" ? () => ({ width: 10 }) : (...args: unknown[]) => {
        if (key === "roundRect" || key === "arcTo") return;
        if (key === "moveTo") ys.push(args[1] as number);
        if (key === "fill") fills.push(fillStyle);
      }),
      set: (_, key: string, v) => ((key === "fillStyle" && (fillStyle = String(v))), true),
    }) as unknown as CanvasRenderingContext2D;
    layout.pads[2]!.lift = 22;
    drawPads(ctx, base.themes["club-deck"]!, layout.pads, 1000, 50, 0.5, layout.pads[3]!.id);
    expect(ys).toContain(1000 + 4); // an unlifted slab's top edge (gy + 4)
    expect(ys).toContain(1000 - 22 + 4); // the lifted one
    expect(fills).toContain("#fff");
  });
});

describe("padSprites / padState — the extruded chrome tile per state", () => {
  test("every state names a top and a front; the gold ring, the reveal wash and the dashed rim are overlays on the live tile", () => {
    expect(padSprites("live")).toEqual({ top: "pad-top-live", front: "pad-front-live", over: null, overFront: null });
    expect(padSprites("under")).toEqual({ top: "pad-top-live", front: "pad-front-live", over: "pad-top-under", overFront: "pad-front-under" });
    expect(padSprites("hit")).toEqual({ top: "pad-top-hit", front: "pad-front-live", over: null, overFront: null });
    expect(padSprites("lock")).toEqual({ top: "pad-top-live", front: "pad-front-lock", over: "pad-top-lock", overFront: null });
    expect(padSprites("new")).toEqual({ top: "pad-top-live", front: "pad-front-live", over: "pad-top-new", overFront: null });
    expect(padSprites("done")).toEqual({ top: "pad-top-done", front: "pad-front-done", over: null, overFront: null });
  });

  test("padState: used up beats everything, then the landing flash, then the ring under a jumper, then the reveal wash", () => {
    const pad = (over: Partial<Pad>): Pad => ({ id: "p", tier: 0, glyph: "🎟️", left: 2, x: 0, w: 80, live: true, lift: 0, ...over });
    expect(padState(pad({}), null)).toBe("live");
    expect(padState(pad({ live: false, under: true, fresh: 1 }), "p")).toBe("done");
    expect(padState(pad({ under: true, fresh: 1 }), "p")).toBe("hit");
    expect(padState(pad({ under: true, fresh: 1 }), "other")).toBe("under");
    expect(padState(pad({ fresh: 1 }), null)).toBe("new");
  });

  test("drawPads on a sheet: plate + halo + front + top + gloss per pad, the glow under `lighter` and source-over restored, glyph and ×N still text", () => {
    const names: string[] = [];
    const props: string[] = [];
    const texts: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => void (key === "fillText" && typeof args[0] === "string" && texts.push(args[0]))),
      set(target, key: string, value) {
        target[key] = value;
        if (key === "globalCompositeOperation") props.push(String(value));
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: (_c: unknown, name: string) => void names.push(name) } as unknown as SpriteSet;
    const layout = new PadLayout();
    settle(layout, livePads(outcomes(0), 0));
    layout.pads[1]!.live = false;
    drawPads(ctx, base.themes["chrome-lounge"]!, layout.pads, 1000, 50, 0.5, layout.pads[3]!.id, sprites, LEVELS[5]);
    const count = (n: string): number => names.filter((x) => x === n).length;
    expect(count("plate")).toBe(12);
    expect(count("pad-halo")).toBe(12);
    expect(count("pad-gloss")).toBe(11); // the DONE tile has its own baked finish
    expect(count("pad-top-live")).toBe(10);
    expect(count("pad-top-hit")).toBe(1);
    expect(count("pad-top-done")).toBe(1);
    expect(count("pad-front-done")).toBe(1);
    expect(props).toEqual(["lighter", "source-over"]);
    expect(texts).toContain("×5");
    expect(texts).toContain("🎟️");
    expect(texts).toContain("DONE");
  });
});

describe("PadLayout — equal slots on a Theme Sheet, lock pads at the strip's end (fix round 1)", () => {
  const equal = (layout: PadLayout, live: PadSource[], n = 400, frozen = false): void => {
    for (let i = 0; i < n; i++) layout.update(live, STRIP, 1, frozen, SLIDE_RATE, true);
  };

  test("equal: every settled slot is strip.w / n whatever the stock; a DONE pad still collapses after the thaw", () => {
    const layout = new PadLayout();
    equal(layout, livePads(outcomes(0), 0));
    for (const p of layout.pads) expect(p.w).toBeCloseTo(STRIP.w / 12, 3);
    expect(layout.pads[0]!.x).toBeCloseTo(STRIP.x, 3);
    expect(layout.pads[0]!.left).toBe(5); // the count still shows the stock
    const done = livePads(outcomes(0, (o) => void (o.id === "stickers" && (o.left = 0))), 0);
    equal(layout, done, 600);
    expect(layout.pads[0]!.w).toBeLessThan(0.5);
    expect(layout.pads[1]!.w).toBeCloseTo(STRIP.w / 11, 1);
  });

  test("lockPads: one per Outcome of the next Tier, locked, the masked glyph, never a name; each takes a full slot", () => {
    const locks = lockPads(outcomes(0), 0);
    expect(locks).toHaveLength(8);
    expect(locks.every((p) => p.locked === true && p.tier === 1 && p.glyph === LOCKED_GLYPH)).toBe(true);
    expect(Object.keys(locks[0]!)).not.toContain("name");
    expect(lockPads(outcomes(1), 1)).toHaveLength(5);
    expect(lockPads(outcomes(2), 2)).toEqual([]);
    const layout = new PadLayout();
    equal(layout, [...livePads(outcomes(0), 0), ...locks]);
    expect(layout.pads).toHaveLength(20);
    for (const p of layout.pads) expect(p.w).toBeCloseTo(STRIP.w / 20, 3);
    expect(layout.pads.slice(12).every((p) => p.locked === true)).toBe(true);
    expect(layout.pads.slice(0, 12).every((p) => p.locked !== true)).toBe(true);
    // the Tier opens: the same ids come back live — the slots stay, the flag flips, nothing grows from nothing
    const opened = [...livePads(outcomes(1), 1), ...lockPads(outcomes(1), 1)];
    layout.update(opened, STRIP, 1, false, SLIDE_RATE, true);
    const shirt = layout.pads.find((p) => p.id === "shirt-t1")!;
    expect(shirt).toMatchObject({ locked: false, live: true });
    expect(shirt.w).toBeGreaterThan((STRIP.w / 20) * 0.95);
    expect(layout.pads.filter((p) => p.locked === true).map((p) => p.tier)).toEqual([2, 2, 2, 2, 2]);
    equal(layout, opened);
    for (const p of layout.pads) expect(p.w).toBeCloseTo(STRIP.w / 25, 3);
  });

  test("frozen: a Tier opening flips its lock pads live in place; the next Tier's locks wait for the thaw (a full strip has no room)", () => {
    const layout = new PadLayout();
    equal(layout, [...livePads(outcomes(0), 0), ...lockPads(outcomes(0), 0)]);
    const before = layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }));
    const opened = [...livePads(outcomes(1), 1), ...lockPads(outcomes(1), 1)];
    equal(layout, opened, 50, true);
    expect(layout.pads.map((p) => ({ id: p.id, x: p.x, w: p.w }))).toEqual(before);
    expect(layout.pads.filter((p) => p.locked === true)).toHaveLength(0);
    expect(layout.pads.find((p) => p.id === "shirt-t1")).toMatchObject({ locked: false, live: true, left: 2 });
    equal(layout, opened, 600, false);
    expect(layout.pads).toHaveLength(25);
    expect(layout.pads.slice(20).every((p) => p.locked === true && p.tier === 2)).toBe(true);
  });

  test("padState: a locked pad is `lock` before anything else", () => {
    const pad: Pad = { id: "p", tier: 1, glyph: LOCKED_GLYPH, left: 2, x: 0, w: 80, live: true, lift: 0, locked: true, under: true, fresh: 1 };
    expect(padState(pad, "p")).toBe("lock");
  });
});

describe("drawPads on a sheet — one k per tile, the flat shadow, the lock pads and their label (fix round 1)", () => {
  const chrome = base.themes["chrome-lounge"]!;
  function recorder() {
    const names: string[] = [];
    const opts: Array<Record<string, unknown> | undefined> = [];
    const texts: string[] = [];
    const scales: number[][] = [];
    const fills: Array<{ text: string; x: number; y: number; style: string }> = [];
    let fillStyle = "";
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : (...args: unknown[]) => {
              if (key === "scale") scales.push(args as number[]);
              if (key === "fillText" && typeof args[0] === "string") {
                texts.push(args[0]);
                fills.push({ text: args[0], x: args[1] as number, y: args[2] as number, style: fillStyle });
              }
            },
      set(target, key: string, value) {
        target[key] = value;
        if (key === "fillStyle") fillStyle = String(value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const sprites = { id: "chrome-lounge", get: () => ({}) as never, has: () => true, names: () => [], draw: (_c: unknown, name: string, _s: unknown, _x: unknown, _y: unknown, o?: Record<string, unknown>) => void (names.push(name), opts.push(o)) } as unknown as SpriteSet;
    return { ctx, sprites, names, opts, texts, scales, fills };
  }
  const pad = (over: Partial<Pad>): Pad => ({ id: "p", tier: 0, glyph: "🎟️", left: 2, x: 100, w: 72, live: true, lift: 0, ...over });

  test("one pad's chain: shadow plate → halo → front → top → gloss → the state's overlays; every face at k = (w − 6) / 132", () => {
    const r = recorder();
    drawPads(r.ctx, chrome, [pad({ under: true })], 1000, 50, 0.5, null, r.sprites, LEVELS[5]);
    expect(r.names).toEqual(["plate", "pad-halo", "pad-front-live", "pad-top-live", "pad-gloss", "pad-top-under", "pad-front-under"]);
    const k = (72 - 6) / 132;
    for (let i = 2; i < r.names.length; i++) expect(r.opts[i]?.k, r.names[i]).toBeCloseTo(k, 9);
    expect((r.opts[1]?.k as number) * 180).toBeGreaterThan(k * 132); // the halo (180 px frame) is wider than the tile it wraps
    expect(r.scales).toHaveLength(1); // only the shadow is squashed
    expect(r.scales[0]![0]).toBeGreaterThan(r.scales[0]![1]!); // an ellipse, flat
    expect(r.opts[0]?.alpha).toBeCloseTo(0.5, 9);
  });

  test("no distortion: a wide slot and a narrow one each draw at their own uniform k, the wide one capped so the tile is never taller than the strip", () => {
    const r = recorder();
    drawPads(r.ctx, chrome, [pad({ id: "a", x: 100, w: 300, left: 5 }), pad({ id: "b", x: 400, w: 72 })], 1000, 50, 0.5, null, r.sprites, LEVELS[5]);
    const ks = r.names.map((n, i) => [n, r.opts[i]?.k as number] as const).filter(([n]) => n.startsWith("pad-top") || n.startsWith("pad-front"));
    expect(ks.slice(0, 2).every(([, k]) => Math.abs(k - 50 / 62) < 1e-9)).toBe(true);
    expect(ks.slice(2).every(([, k]) => Math.abs(k - 66 / 132) < 1e-9)).toBe(true);
    expect(r.texts).toContain("×5");
  });

  test("a lock pad: shadow, no halo, lock front + live top in the lockTile colour, gloss, the dashed rim in its Tier's colour, the 🔒 as text — no count", () => {
    const r = recorder();
    drawPads(r.ctx, chrome, [pad({ id: "l", tier: 1, glyph: LOCKED_GLYPH, left: 3, locked: true })], 1000, 50, 0.5, null, r.sprites, LEVELS[5]);
    expect(r.names).toEqual(["plate", "pad-front-lock", "pad-top-live", "pad-gloss", "pad-top-lock"]);
    expect(r.opts[1]?.colour).toBe(chrome.lockTile);
    expect(r.opts[2]?.colour).toBe(chrome.lockTile);
    expect(r.opts[4]?.colour).toBe(chrome.tiers[1]);
    expect(r.texts).toEqual([LOCKED_GLYPH]);
  });

  test("drawLockLabel: the two gold lines centred under the run of lock pads, below the tiles; nothing without a lock pad", () => {
    const r = recorder();
    const pads = [pad({ id: "a", x: 100, w: 50 }), pad({ id: "l1", x: 150, w: 50, locked: true, tier: 1 }), pad({ id: "l2", x: 200, w: 50, locked: true, tier: 1 })];
    drawLockLabel(r.ctx, chrome, pads, 1000, 50, ["TIER 1 · 8 HIDDEN", "3 UNLOCKS AWAY"]);
    expect(r.fills.map((f) => f.text)).toEqual(["TIER 1 · 8 HIDDEN", "3 UNLOCKS AWAY"]);
    for (const f of r.fills) {
      expect(f.x).toBeCloseTo(200, 6);
      expect(f.style).toBe(chrome.gold);
      expect(f.y).toBeGreaterThan(1000 + 6 + 25 + (62 * (44 / 132)) / 2 + 18 * (44 / 132)); // under the front face
    }
    expect(r.fills[1]!.y).toBeGreaterThan(r.fills[0]!.y);
    const none = recorder();
    drawLockLabel(none.ctx, chrome, [pad({})], 1000, 50, ["TIER 1 · 8 HIDDEN", "3 UNLOCKS AWAY"]);
    expect(none.texts).toEqual([]);
  });
});

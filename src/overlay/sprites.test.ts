/**
 * The Sprite Sheet loader: the bundled atlas is consistent across the three Sheet Scales and finite, a white
 * Master tints through `source-in` on an offscreen canvas once per colour, and `draw` puts a frame's Anchor on (x, y)
 * at 1× world size whatever Sheet Scale it came from. Bun test, no DOM: canvases and images are fakes.
 */
import { describe, expect, test } from "bun:test";
import { SHEET_IDS } from "../config/schema.ts";
import { MAX_SHEET_SIDE } from "./atlas.ts";
import { SHEETS, TWO_X_ATTEMPTS, assertFinite, loadImage, makeSpriteSet, pickSheet, tintFrame, type Atlas, type Frame, type SheetImages, type SheetScale } from "./sprites.ts";

interface Call {
  op: string;
  args: unknown[];
  composite: string;
  fillStyle: string;
  alpha: number;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    globalAlpha: 1,
    imageSmoothingEnabled: true,
  } as unknown as CanvasRenderingContext2D & Record<string, unknown>;
  for (const op of ["drawImage", "fillRect", "save", "restore", "translate", "rotate", "scale", "clearRect"]) {
    ctx[op] = (...args: unknown[]) => void calls.push({ op, args, composite: ctx.globalCompositeOperation, fillStyle: String(ctx.fillStyle), alpha: ctx.globalAlpha });
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

const atlas = (): Atlas => SHEETS["chrome-lounge"].atlas;
const img = (tag: string): CanvasImageSource => ({ tag } as unknown as CanvasImageSource);
/** What `loadSpriteSet` starts with: the three Quality Level sheets, no 2x until something asks for it. */
const images = (): SheetImages => ({ 1: img("one"), 0.75: img("threeq"), 0.5: img("half") });
/** The 2x Sheet Scale arrives as one image per sheet of the atlas. */
const twoX = (): CanvasImageSource[] => atlas().scales["2"].sheets.map((_, i) => img(`two-${i}`));
/** Two frames the atlas puts on different 2x sheets, so a draw can be seen to pick the frame's own. */
const onDifferentSheets = (): [string, string] => {
  const frames = Object.entries(atlas().scales["2"].frames);
  const [a, fa] = frames[0]!;
  const other = frames.find(([, f]) => f.sheet !== fa.sheet);
  if (!other) throw new Error("the atlas has every 2x frame on one sheet");
  return [a, other[0]];
};

describe("SHEETS — the bundled Chrome Lounge sheet", () => {
  test("one entry per schema sheet id, a PNG url per sheet (the 2x Sheet Scale is several), an atlas with the same frame names at every scale", () => {
    expect(Object.keys(SHEETS)).toEqual([...SHEET_IDS]);
    const s = SHEETS["chrome-lounge"];
    expect(Object.keys(s.urls).map(Number).sort((a, b) => b - a)).toEqual([2, 1, 0.75, 0.5]);
    const urls = [...s.urls[2], s.urls[1], s.urls[0.75], s.urls[0.5]];
    for (const u of urls) expect(u).toMatch(/chrome-lounge.*\.png$/);
    expect(new Set(urls).size).toBe(urls.length);
    // the bundle carries exactly one image per 2x sheet the atlas names, and none of them is 23 megapixels
    expect(s.urls[2]).toHaveLength(s.atlas.scales["2"].sheets.length);
    expect(s.urls[2].length).toBeGreaterThan(1);
    for (const [i, sheet] of s.atlas.scales["2"].sheets.entries()) {
      expect(sheet.w <= MAX_SHEET_SIDE && sheet.h <= MAX_SHEET_SIDE, `2x sheet ${i} ${sheet.w}×${sheet.h}`).toBe(true);
      expect(s.urls[2][i]).toMatch(new RegExp(`chrome-lounge@2x-${i}.*\\.png$`));
    }
    expect(s.atlas.id).toBe("chrome-lounge");
    const names = Object.keys(s.atlas.scales["1"].frames);
    expect(names.length).toBeGreaterThan(90);
    expect(Object.keys(s.atlas.scales["0.75"].frames)).toEqual(names);
    expect(Object.keys(s.atlas.scales["2"].frames)).toEqual(names);
    expect(Object.keys(s.atlas.scales["0.5"].frames)).toEqual(names);
    for (const n of ["canopy-a", "pilot", "ship-body", "fins", "pad-top-live", "beam-wedge", "mote-ring", "windsock-pole", "windsock-cone", "dancer-walk-0", "dancer-walk-0-rim", "dancer-walk-0-rim-flip"]) expect(names).toContain(n);
    for (const z of ["1", "0.75", "0.5"] as const) {
      const sheet = s.atlas.scales[z];
      for (const [n, f] of Object.entries(sheet.frames)) {
        expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= sheet.w && f.y + f.h <= sheet.h, `${n}@${z}`).toBe(true);
      }
    }
    for (const [n, f] of Object.entries(s.atlas.scales["2"].frames)) {
      const sheet = s.atlas.scales["2"].sheets[f.sheet];
      expect(sheet, `${n}@2 names sheet ${f.sheet}`).toBeDefined();
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= sheet!.w && f.y + f.h <= sheet!.h, `${n}@2`).toBe(true);
    }
    expect(() => assertFinite(s.atlas)).not.toThrow();
  });

  test("assertFinite throws naming every frame whose numbers are not finite", () => {
    const a = structuredClone(atlas());
    a.scales["0.75"].frames["spark"]!.ax = Number.NaN;
    a.scales["0.5"].frames["dancer-up-0"]!.w = Number.POSITIVE_INFINITY;
    expect(() => assertFinite(a)).toThrow(/spark.*0\.75|0\.75.*spark/);
    expect(() => assertFinite(a)).toThrow(/dancer-up-0/);
    const b = structuredClone(atlas());
    (b.scales["1"] as { w: number }).w = Number.NaN;
    expect(() => assertFinite(b)).toThrow(/sheet/);
    const c = structuredClone(atlas());
    c.scales["2"].sheets[1]!.h = Number.NaN;
    expect(() => assertFinite(c)).toThrow(/sheet@2-1/);
  });
});

describe("tintFrame", () => {
  test("draws the frame onto a frame-sized canvas, then fills the colour through source-in", () => {
    const { canvas, calls } = fakeCanvas();
    const frame: Frame = { x: 10, y: 20, w: 30, h: 40, ax: 5, ay: 6, kind: "master" };
    const src = img("sheet");
    const out = tintFrame(src, frame, "#ff9ecb", () => canvas);
    expect(out).toBe(canvas);
    expect([canvas.width, canvas.height]).toEqual([30, 40]);
    expect(calls.map((c) => c.op)).toEqual(["drawImage", "fillRect"]);
    expect(calls[0]!.args).toEqual([src, 10, 20, 30, 40, 0, 0, 30, 40]);
    expect(calls[0]!.composite).toBe("source-over");
    expect(calls[1]!.args).toEqual([0, 0, 30, 40]);
    expect(calls[1]!.composite).toBe("source-in");
    expect(calls[1]!.fillStyle).toBe("#ff9ecb");
  });
});

describe("makeSpriteSet", () => {
  test("get: a frame at the asked Sheet Scale from that sheet's image; unknown names throw; has/names", () => {
    const imgs = images();
    const set = makeSpriteSet("chrome-lounge", imgs, atlas(), () => fakeCanvas().canvas);
    expect(set.id).toBe("chrome-lounge");
    const f1 = atlas().scales["1"].frames["pad-top-live"]!;
    const s1 = set.get("pad-top-live", 1);
    expect(s1.image).toBe(imgs[1] as never);
    expect(s1.frame).toEqual(f1);
    expect(s1.scale).toBe(1);
    const s5 = set.get("pad-top-live", 0.5);
    expect(s5.frame).toEqual(atlas().scales["0.5"].frames["pad-top-live"]!);
    expect(s5.scale).toBe(0.5);
    expect(() => set.get("pad-top-live", 2)).toThrow(/2x/); // not in hand yet: nothing to draw from
  });

  test("at Sheet Scale 2 a frame comes off its own sheet of the split 2x Sheet Scale, tint included", () => {
    const two = twoX();
    const set = makeSpriteSet("chrome-lounge", { ...images(), 2: two }, atlas(), () => fakeCanvas().canvas);
    const [a, b] = onDifferentSheets();
    const fa = atlas().scales["2"].frames[a]!;
    const fb = atlas().scales["2"].frames[b]!;
    expect(set.get(a, 2).image).toBe(two[fa.sheet]!);
    expect(set.get(b, 2).image).toBe(two[fb.sheet]!);
    expect(set.get(a, 2).image).not.toBe(set.get(b, 2).image);
    const master = Object.entries(atlas().scales["2"].frames).find(([, f]) => f.kind === "master" && f.sheet === fb.sheet)![0];
    const { canvas, calls } = fakeCanvas();
    const tinted = makeSpriteSet("chrome-lounge", { ...images(), 2: two }, atlas(), () => canvas).get(master, 2, "#ff9ecb");
    expect(tinted.image).toBe(canvas);
    expect(calls[0]!.args[0]).toBe(two[fb.sheet]!); // the tint reads the frame's own sheet
    expect(() => set.get("pad-top-lives", 1)).toThrow(/pad-top-lives/);
    expect(set.has("pad-top-live")).toBe(true);
    expect(set.has("nope")).toBe(false);
    expect(set.names()).toEqual(Object.keys(atlas().scales["1"].frames));
  });

  test("get with a colour: a Master comes back as a tinted canvas whose frame is at (0, 0), cached per (name, scale, colour); non-masters ignore the colour", () => {
    let made = 0;
    const imgs = images();
    const set = makeSpriteSet("chrome-lounge", imgs, atlas(), () => {
      made++;
      return fakeCanvas().canvas;
    });
    const a = set.get("pad-top-live", 1, "#ff9ecb");
    const f = atlas().scales["1"].frames["pad-top-live"]!;
    expect(a.image).not.toBe(imgs[1] as never);
    expect(a.frame).toEqual({ x: 0, y: 0, w: f.w, h: f.h, ax: f.ax, ay: f.ay, kind: "master" });
    expect(made).toBe(1);
    expect(set.get("pad-top-live", 1, "#ff9ecb").image).toBe(a.image);
    expect(made).toBe(1);
    set.get("pad-top-live", 1, "#9df2d9");
    expect(made).toBe(2);
    set.get("pad-top-live", 0.75, "#ff9ecb");
    expect(made).toBe(3);
    const gloss = set.get("pad-gloss", 1, "#ff9ecb");
    expect(gloss.image).toBe(imgs[1] as never);
    expect(made).toBe(3);
    const pilot = set.get("pilot", 1, "#ff9ecb");
    expect(pilot.image).toBe(imgs[1] as never);
  });

  test("draw: drawImage(img, fx, fy, fw, fh, x - ax*k, y - ay*k, fw*k, fh*k) at 1×; at 0.5× the frame is scaled back up to world size", () => {
    const imgs = images();
    const set = makeSpriteSet("chrome-lounge", imgs, atlas(), () => fakeCanvas().canvas);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d")!;
    const f = atlas().scales["1"].frames["beam-wedge"]!;
    set.draw(ctx, "beam-wedge", 1, 300, 40);
    expect(calls.map((c) => c.op)).toEqual(["drawImage"]);
    expect(calls[0]!.args).toEqual([imgs[1], f.x, f.y, f.w, f.h, 300 - f.ax, 40 - f.ay, f.w, f.h]);
    set.draw(ctx, "beam-wedge", 1, 300, 40, { k: 2 });
    expect(calls[1]!.args).toEqual([imgs[1], f.x, f.y, f.w, f.h, 300 - f.ax * 2, 40 - f.ay * 2, f.w * 2, f.h * 2]);
    const h = atlas().scales["0.5"].frames["beam-wedge"]!;
    set.draw(ctx, "beam-wedge", 0.5, 300, 40);
    expect(calls[2]!.args).toEqual([imgs[0.5], h.x, h.y, h.w, h.h, 300 - h.ax * 2, 40 - h.ay * 2, h.w * 2, h.h * 2]);
    expect(h.w * 2).toBeGreaterThanOrEqual(f.w); // the same on-screen size (rounded outward)
    expect(calls.every((c) => c.composite === "source-over" && c.alpha === 1)).toBe(true);
  });

  test("draw with colour / alpha / flipX / rotate: tinted image, save-transform-restore, alpha restored", () => {
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d")!;
    const f = atlas().scales["1"].frames["spark"]!;
    set.draw(ctx, "spark", 1, 10, 20, { colour: "#ffe08a", alpha: 0.5, flipX: true, rotate: 1.2, k: 1.5 });
    expect(calls.map((c) => c.op)).toEqual(["save", "translate", "rotate", "scale", "drawImage", "restore"]);
    expect(calls[1]!.args).toEqual([10, 20]);
    expect(calls[2]!.args).toEqual([1.2]);
    expect(calls[3]!.args).toEqual([-1, 1]);
    const d = calls[4]!;
    expect(d.alpha).toBe(0.5);
    expect(d.args[0]).toBe(set.get("spark", 1, "#ffe08a").image);
    expect(d.args.slice(1)).toEqual([0, 0, f.w, f.h, -f.ax * 1.5, -f.ay * 1.5, f.w * 1.5, f.h * 1.5]);
    expect(ctx.globalAlpha).toBe(1);
  });
});

describe("pickSheet — which sheet a frame comes from", () => {
  const all: SheetScale[] = [2, 1, 0.75, 0.5];
  test("the smallest sheet at or above what will be drawn, so a frame is never scaled up", () => {
    expect(pickSheet(1, all)).toBe(1);
    expect(pickSheet(0.75, all)).toBe(0.75);
    expect(pickSheet(1.5, all)).toBe(2); // 1.5x would blow the 1x sheet up; 2x is scaled down instead
    expect(pickSheet(2, all)).toBe(2);
  });

  test("floating point never pushes an exact match onto the next sheet up", () => {
    expect(pickSheet(0.75 * 2, all)).toBe(2);
    expect(pickSheet(0.5 * 2, all)).toBe(1);
  });

  test("beyond the biggest sheet, the biggest is the answer rather than nothing", () => {
    expect(pickSheet(4, all)).toBe(2);
  });

  test("while the 2x sheet is still arriving the loaded ones still draw", () => {
    expect(pickSheet(2, [1, 0.75, 0.5])).toBe(1);
    expect(pickSheet(1, [0.5])).toBe(0.5);
  });
});

describe("setDetail — the 2x sheet is fetched only when something needs it", () => {
  const make = (fetches: SheetScale[], resolve: () => readonly CanvasImageSource[] = twoX) =>
    makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      fetches.push(2);
      return resolve();
    });

  test("Detail 1x never asks for it: the sheet most sources never need is not downloaded", () => {
    const fetches: SheetScale[] = [];
    make(fetches).setDetail(1);
    expect(fetches).toEqual([]);
  });

  test("Detail 1.5x never asks for it either: the 2x sheet is Detail 2x's alone", () => {
    // Measured 2026-09-16 (dev Mac, Chrome 152): with the 2x sheet as the source of every sprite the frame's JS cost
    // was 4–7x what the 1x sheet costs, on a stage of either size; the stage's own size cost nothing in JS. Sharper is
    // the stage at 1.5x with the 1080p art scaled up, not the 23-megapixel sheet.
    const fetches: SheetScale[] = [];
    make(fetches).setDetail(1.5);
    expect(fetches).toEqual([]);
  });

  test("with the 2x sheets already in hand, Detail 1.5x still draws off the 1x sheet — only Detail 2x ever uses them", () => {
    const two = twoX(), one = img("one");
    const set = makeSpriteSet("chrome-lounge", { 2: two, 1: one, 0.75: img("threeq"), 0.5: img("half") }, atlas(), () => fakeCanvas().canvas);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    set.setDetail(1.5);
    set.draw(ctx, "plate", 1, 0, 0);
    expect((calls.at(-1)!.args as unknown[])[0]).toBe(one);
    set.draw(ctx, "plate", 0.75, 0, 0); // 0.75 x 1.5 asks for more than the 1x sheet has; the 1x sheet is still the most it gets
    expect((calls.at(-1)!.args as unknown[])[0]).toBe(one);
    set.setDetail(2);
    set.draw(ctx, "plate", 1, 0, 0);
    expect((calls.at(-1)!.args as unknown[])[0]).toBe(two[atlas().scales["2"].frames["plate"]!.sheet]!);
  });

  test("at Detail 2x every draw takes the frame's own sheet, so two frames on different sheets draw from different images", () => {
    const two = twoX();
    const set = makeSpriteSet("chrome-lounge", { ...images(), 2: two }, atlas(), () => fakeCanvas().canvas);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    set.setDetail(2);
    const [a, b] = onDifferentSheets();
    set.draw(ctx, a, 1, 0, 0);
    set.draw(ctx, b, 1, 0, 0);
    const fa = atlas().scales["2"].frames[a]!;
    const fb = atlas().scales["2"].frames[b]!;
    expect((calls[0]!.args as unknown[])[0]).toBe(two[fa.sheet]!);
    expect((calls[1]!.args as unknown[])[0]).toBe(two[fb.sheet]!);
    expect(calls[0]!.args.slice(1, 5)).toEqual([fa.x, fa.y, fa.w, fa.h]);
    expect(calls[0]!.args.slice(5)).toEqual([-fa.ax / 2, -fa.ay / 2, fa.w / 2, fa.h / 2]); // 2x pixels drawn at 1x world size
  });

  test("Detail 2x asks once, however many times it is set", async () => {
    const fetches: SheetScale[] = [];
    const set = make(fetches);
    set.setDetail(2);
    set.setDetail(2);
    await Promise.resolve();
    set.setDetail(2);
    expect(fetches).toEqual([2]);
  });

  test("until the 2x sheet lands, frames still come off the 1x one instead of nothing being drawn", () => {
    const set = make([]);
    set.setDetail(2);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    set.draw(ctx, "plate", 1, 100, 100);
    expect(calls.length).toBe(1);
  });

  test("a 2x sheet that fails to load is not fatal: the smaller sheets keep drawing", async () => {
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      throw new Error("offline");
    });
    set.setDetail(2);
    await Promise.resolve();
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    set.draw(ctx, "plate", 1, 0, 0);
    expect(calls.length).toBe(1);
  });
});

describe("setDetail — the 2x Sheet Scale arrives whole or not at all", () => {
  test("a fetch that comes back with fewer images than the atlas names sheets is refused, the sheets in hand keep drawing, and it is retried", async () => {
    let n = 0;
    const two = twoX();
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      n += 1;
      return n === 1 ? two.slice(0, 1) : two;
    });
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const [a, b] = onDifferentSheets();
    set.setDetail(2);
    await Promise.resolve();
    await Promise.resolve();
    set.draw(ctx, b, 1, 0, 0);
    expect(calls).toHaveLength(1); // still drawn, off the 1x sheet, not a half-arrived 2x Sheet Scale
    expect(two).not.toContain((calls[0]!.args as unknown[])[0]);
    set.setDetail(2);
    await Promise.resolve();
    await Promise.resolve();
    set.draw(ctx, a, 1, 0, 0);
    set.draw(ctx, b, 1, 0, 0);
    expect((calls.at(-2)!.args as unknown[])[0]).toBe(two[atlas().scales["2"].frames[a]!.sheet]!);
    expect((calls.at(-1)!.args as unknown[])[0]).toBe(two[atlas().scales["2"].frames[b]!.sheet]!);
    expect(n).toBe(2);
  });
});

describe("setDetail — a failed 2x fetch can be retried", () => {
  test("after the 2x sheet fails, the next setDetail asks again rather than giving up for the life of the page", async () => {
    let calls = 0;
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      calls += 1;
      throw new Error("offline");
    });
    set.setDetail(2);
    await Promise.resolve();
    await Promise.resolve();
    set.setDetail(2);
    expect(calls).toBe(2);
  });

  test("once the 2x sheets have arrived, frames are taken from them — the whole point of Detail 2x", async () => {
    const two = twoX();
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => two);
    const { canvas, calls } = fakeCanvas();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    const plate = two[atlas().scales["2"].frames["plate"]!.sheet]!;
    set.setDetail(2);
    set.draw(ctx, "plate", 1, 0, 0);
    expect((calls.at(-1)!.args as unknown[])[0]).not.toBe(plate); // not arrived yet: the 1x sheet still draws

    await Promise.resolve();
    await Promise.resolve();
    set.draw(ctx, "plate", 1, 0, 0);
    expect((calls.at(-1)!.args as unknown[])[0]).toBe(plate);
  });
});

describe("loadImage — a sheet is usable once it has loaded, decoded or not", () => {
  const fakeImg = () => ({ src: "", onload: null as null | (() => void), onerror: null as null | (() => void), decode: () => new Promise<void>(() => {}) });

  test("resolves when the image loads, even though decode never settles — a throttled tab stalls decode, not loading", async () => {
    const img = fakeImg();
    const p = loadImage("/sheet.png", () => img as unknown as HTMLImageElement, 1000, () => 1, () => {});
    expect(img.src).toBe("/sheet.png");
    img.onload!();
    await expect(p).resolves.toBe(img as unknown as HTMLImageElement);
  });

  test("rejects when the image errors, naming the url so the console says which sheet", async () => {
    const img = fakeImg();
    const p = loadImage("/broken.png", () => img as unknown as HTMLImageElement, 1000, () => 1, () => {});
    img.onerror!();
    await expect(p).rejects.toThrow("/broken.png");
  });

  test("rejects on the deadline when neither load nor error ever fires, so the caller can try again", async () => {
    let fire: (() => void) | null = null;
    const p = loadImage("/slow.png", () => fakeImg() as unknown as HTMLImageElement, 50, (fn) => void (fire = fn), () => {});
    fire!();
    await expect(p).rejects.toThrow(/did not load/i);
  });
});

describe("setDetail — a 2x sheet that keeps failing must not be downloaded forever", () => {
  const failing = (calls: { n: number }) =>
    makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      calls.n += 1;
      throw new Error("offline");
    });

  test("attempts stop at the cap: the largest asset is not re-fetched on every resize for the life of the page", async () => {
    const calls = { n: 0 };
    const set = failing(calls);
    for (let i = 0; i < TWO_X_ATTEMPTS + 5; i++) {
      set.setDetail(2);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(calls.n).toBe(TWO_X_ATTEMPTS);
  });

  test("a success inside the cap stops further attempts, and the sheet is used", async () => {
    const two = twoX();
    let n = 0;
    const set = makeSpriteSet("chrome-lounge", images(), atlas(), () => fakeCanvas().canvas, async () => {
      n += 1;
      if (n === 1) throw new Error("first one missed");
      return two;
    });
    set.setDetail(2);
    await Promise.resolve();
    await Promise.resolve();
    set.setDetail(2);
    await Promise.resolve();
    await Promise.resolve();
    set.setDetail(2);
    expect(n).toBe(2);
  });
});

describe("loadImage — the deadline timer is cleared once the image settles", () => {
  test("a load that arrives clears its timer, so a stalled sheet cannot reject a page that already has its art", async () => {
    const cleared: unknown[] = [];
    const img2 = { src: "", onload: null as null | (() => void), onerror: null as null | (() => void), decode: async () => {} };
    const p = loadImage("/s.png", () => img2 as unknown as HTMLImageElement, 50, () => "HANDLE", (h) => void cleared.push(h));
    img2.onload!();
    await p;
    expect(cleared).toEqual(["HANDLE"]);
  });
});

describe("loadImage — settling once, and the decode warm-up", () => {
  test("a load that arrives after the deadline cannot un-reject the promise", async () => {
    let fire: (() => void) | null = null;
    const img2 = { src: "", onload: null as null | (() => void), onerror: null as null | (() => void), decode: async () => {} };
    const p = loadImage("/late.png", () => img2 as unknown as HTMLImageElement, 10, (fn) => void (fire = fn), () => {});
    fire!();
    await expect(p).rejects.toThrow(/did not load/i);
    expect(img2.onload).toBeNull(); // detached, so a sheet that turns up late cannot call back at all
    await expect(p).rejects.toThrow(/did not load/i);
  });

  test("decode is started as a warm-up but never awaited, and a decode that rejects is swallowed", async () => {
    let started = 0;
    const img2 = { src: "", onload: null as null | (() => void), onerror: null as null | (() => void),
                   decode: () => { started += 1; return Promise.reject(new Error("cannot decode")); } };
    const p = loadImage("/warm.png", () => img2 as unknown as HTMLImageElement, 100, () => 1, () => {});
    img2.onload!();
    await expect(p).resolves.toBe(img2 as unknown as HTMLImageElement); // resolves despite the decode failing
    expect(started).toBe(1);
  });

  test("an image with no decode at all still loads, so a stubbed or older element cannot break the sheet", async () => {
    const img2 = { src: "", onload: null as null | (() => void), onerror: null as null | (() => void) };
    const p = loadImage("/nodecode.png", () => img2 as unknown as HTMLImageElement, 100, () => 1, () => {});
    img2.onload!();
    await expect(p).resolves.toBe(img2 as unknown as HTMLImageElement);
  });
});

describe("loadImage — a load that times out is abandoned, not left running", () => {
  test("the timed-out image is detached and its src cleared, so it cannot decode 90MB nothing will draw", async () => {
    let fire: (() => void) | null = null;
    let decoded = 0;
    const img2 = { src: "", onload: null as null | (() => void), onerror: null as null | (() => void),
                   decode: () => { decoded += 1; return Promise.resolve(); } };
    const p = loadImage("/huge.png", () => img2 as unknown as HTMLImageElement, 10, (fn) => void (fire = fn), () => {});
    fire!();
    await expect(p).rejects.toThrow(/did not load/i);
    expect(img2.onload).toBeNull();
    expect(img2.src).toBe("");
    expect(decoded).toBe(0);
  });
});

test("the cached sheet choice follows a change of detail, so Detail can be switched live without a reload", () => {
  const twoAll = twoX(), one = img("one");
  const two = twoAll[atlas().scales["2"].frames["plate"]!.sheet]!;
  const set = makeSpriteSet("chrome-lounge", { 2: twoAll, 1: one, 0.75: img("threeq"), 0.5: img("half") }, atlas(), () => fakeCanvas().canvas);
  const { canvas, calls } = fakeCanvas();
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

  set.setDetail(1);
  set.draw(ctx, "plate", 1, 0, 0);
  expect((calls.at(-1)!.args as unknown[])[0]).toBe(one);

  set.setDetail(2);
  set.draw(ctx, "plate", 1, 0, 0);
  expect((calls.at(-1)!.args as unknown[])[0]).toBe(two);

  set.setDetail(1);
  set.draw(ctx, "plate", 1, 0, 0);
  expect((calls.at(-1)!.args as unknown[])[0]).toBe(one);
});

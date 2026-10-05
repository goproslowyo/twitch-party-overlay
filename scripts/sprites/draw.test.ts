/**
 * The sprite script: every sprite is well-formed SVG with no words and no glyphs, Masters are white-only so
 * a single tint pass colours them, the packer keeps a 2 px gutter, the beam wedge has its apex at the fixture (top),
 * and every Dancer frame has finite geometry (the legless-Dancer bug).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { DANCE, MOVES, POSES, figure, figureSvg } from "../../src/overlay/scene/dancer-figure.ts";
import { MAX_SHEET_SIDE } from "../../src/overlay/atlas.ts";
import { ATLAS_FILE, KENNEY, PALETTE, PILOT_FEET_Y, SPRITES, USE_KENNEY, buildAtlas, mirrorFigure, packSheet, packSheets, scaleFrames, sheetFile, type Atlas, type Frame, type SpriteDef } from "./draw.ts";

const REQUIRED = [
  // jumper
  "canopy-a", "canopy-b", "canopy-gloss",
  "canopy-side-0-a", "canopy-side-0-b", "canopy-side-1-a", "canopy-side-1-b", "canopy-side-2-a", "canopy-side-2-b",
  "risers", "pilot", "pilot-shadow-0", "pilot-shadow-1", "pilot-shadow-2",
  // airship
  "ship-body", "ship-stripe", "ship-light", "ship-gloss", "fins",
  "propeller-0", "propeller-1", "propeller-2", "propeller-3", "gondola-window", "ready-badge", "ready-badge-dim",
  // pads
  "pad-top-live", "pad-front-live", "pad-halo", "pad-top-under", "pad-front-under", "pad-top-hit",
  "pad-hit-burst-0", "pad-hit-burst-1", "pad-hit-burst-2", "pad-top-lock", "pad-front-lock", "pad-top-new",
  "pad-top-done", "pad-front-done", "pad-gloss",
  // light
  "beam-wedge", "beam-core", "beam-pool", "laser-halo", "smoke-0", "smoke-1", "smoke-2", "tower-head", "tower-head-dark",
  "horizon-glow", "plate", "firework-ray", "thanks-glow",
  // motes and particles
  "spark", "chevron", "dot", "mote-ring", "mote-ring-gold", "mote-spark-0", "mote-spark-1", "mote-spark-2",
  // windsock (pole and cone are separate frames, so the cone alone rotates)
  "windsock-pole", "windsock-cone",
];

const DANCER_FRAMES = Object.entries(POSES).flatMap(([pose, frames]) => frames.flatMap((_, i) => [`dancer-${pose}-${i}`, `dancer-${pose}-${i}-rim`]));
/** The walk frames also carry a rim for the flipped (leftward) walker. */
const RIM_FLIP_FRAMES = POSES.walk.map((_, i) => `dancer-walk-${i}-rim-flip`);

const byName = (name: string): SpriteDef => {
  const s = SPRITES.find((d) => d.name === name);
  if (!s) throw new Error(`no sprite ${name}`);
  return s;
};

/** Every colour an SVG attribute names: fill, stroke, stop-color, flood-color (and the same inside style=""). */
const colours = (svg: string): string[] => {
  const out: string[] = [];
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color|flood-color|lighting-color)\s*[=:]\s*["']?\s*([^"';>\s]+)/g)) out.push(m[1]!.toLowerCase());
  return out;
};
const WHITE_OR_BLACK = /^(#fff|#ffffff|white|#000|#000000|black|none|url\(#[^)]+\))$/;

describe("SPRITES — the list, in order", () => {
  test("every required sprite exists, plus a body + rim frame per Dancer pose frame, each name once", () => {
    const names = SPRITES.map((s) => s.name);
    for (const n of [...REQUIRED, ...DANCER_FRAMES, ...RIM_FLIP_FRAMES]) expect(names, n).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(DANCER_FRAMES).toHaveLength(2 * (3 + 2 + 2 + 2 + 3 + 3 + 3 + 16)); // up swayL swayR step bounce drink walk + four Moves × 4
    expect(RIM_FLIP_FRAMES).toHaveLength(3);
    expect(names).toHaveLength(REQUIRED.length + 3 + DANCER_FRAMES.length + RIM_FLIP_FRAMES.length); // + canopy-side-{i}-gloss
    expect(names.indexOf("canopy-a")).toBeLessThan(names.indexOf("ship-body"));
    expect(names.indexOf("ship-body")).toBeLessThan(names.indexOf("pad-top-live"));
    expect(names.indexOf("pad-top-live")).toBeLessThan(names.indexOf("beam-wedge"));
    expect(names.indexOf("beam-wedge")).toBeLessThan(names.indexOf("spark"));
    expect(names.indexOf("spark")).toBeLessThan(names.indexOf("windsock-pole"));
    expect(names.indexOf("windsock-pole")).toBeLessThan(names.indexOf("windsock-cone"));
    expect(names.indexOf("windsock-cone")).toBeLessThan(names.indexOf("dancer-up-0"));
    expect(names).not.toContain("windsock");
  });

  test("every sprite emits well-formed SVG with no text and no emoji", () => {
    for (const s of SPRITES) {
      const svg = s.svg(PALETTE);
      expect(svg.startsWith("<svg"), s.name).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>"), s.name).toBe(true);
      expect(svg, s.name).toMatch(new RegExp(`^<svg[^>]*\\bwidth="${s.w}"[^>]*\\bheight="${s.h}"`));
      expect(svg, s.name).not.toMatch(/<text[\s>]|<tspan|<image|<foreignObject|<use/);
      expect(svg, s.name).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(svg, s.name).not.toMatch(/NaN|Infinity|undefined/);
      expect(Number.isFinite(s.ax) && Number.isFinite(s.ay) && s.ax >= 0 && s.ax <= s.w && s.ay >= 0 && s.ay <= s.h, s.name).toBe(true);
      expect(Number.isInteger(s.w) && Number.isInteger(s.h) && s.w > 0 && s.h > 0, s.name).toBe(true);
    }
  });

  test("ids inside a sprite are namespaced by its name, so the composite bake never collides", () => {
    for (const s of SPRITES) {
      const svg = s.svg(PALETTE);
      for (const m of svg.matchAll(/\bid="([^"]+)"/g)) expect(m[1], `${s.name}: ${m[1]}`).toStartWith(`${s.name}_`);
      for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) expect(svg, `${s.name}: url(#${m[1]}) has no id`).toContain(`id="${m[1]}"`);
    }
  });

  test("masters are white-only: no colour other than white/black/none in a master's svg", () => {
    const masters = SPRITES.filter((s) => s.kind === "master");
    expect(masters.length).toBeGreaterThan(40);
    for (const s of masters) {
      const list = colours(s.svg(PALETTE));
      expect(list.length, s.name).toBeGreaterThan(0);
      for (const c of list) expect(c, `${s.name}: ${c}`).toMatch(WHITE_OR_BLACK);
    }
  });

  test("the kinds follow the list: pilot is the one Coloured Sprite; gloss, plates, propeller, windows, dancer bodies are never tinted", () => {
    expect(byName("pilot").kind).toBe("coloured");
    expect(SPRITES.filter((s) => s.kind === "coloured").map((s) => s.name)).toEqual(["pilot"]);
    for (const n of ["canopy-gloss", "ship-gloss", "pad-gloss"]) expect(byName(n).kind, n).toBe("overlay");
    for (const n of ["plate", "pilot-shadow-0", "propeller-0", "gondola-window", "ready-badge-dim", "pad-top-done", "pad-front-done", "tower-head-dark"]) {
      expect(["plate", "overlay"], n).toContain(byName(n).kind);
    }
    for (const n of ["canopy-a", "ship-body", "ship-stripe", "ship-light", "fins", "ready-badge", "pad-top-live", "beam-wedge", "mote-ring", "windsock-pole", "windsock-cone", "dancer-up-0-rim"]) {
      expect(byName(n).kind, n).toBe("master");
    }
    expect(byName("dancer-up-0").kind).toBe("plate");
  });

  test("sizes: the agreed content sizes at 1× (frames may add glow padding, never less)", () => {
    const atLeast: Array<[string, number, number]> = [
      ["canopy-a", 320, 220], ["canopy-side-0-a", 320, 220], ["pilot", 90, 150], ["pilot-shadow-0", 120, 36],
      ["ship-body", 520, 260], ["fins", 130, 180], ["propeller-0", 24, 64], ["gondola-window", 30, 30], ["ready-badge", 64, 64],
      ["pad-top-live", 132, 62], ["pad-front-live", 118, 18], ["pad-halo", 180, 40], ["pad-top-under", 140, 70], ["pad-hit-burst-0", 300, 120],
      ["beam-wedge", 260, 640], ["beam-core", 80, 640], ["beam-pool", 700, 260], ["laser-halo", 512, 24], ["smoke-0", 512, 512],
      ["tower-head", 40, 30], ["horizon-glow", 512, 16], ["plate", 256, 256], ["firework-ray", 96, 12], ["thanks-glow", 512, 512],
      ["spark", 24, 24], ["chevron", 20, 14], ["dot", 8, 8], ["mote-ring", 64, 64], ["windsock-pole", 28, 170], ["windsock-cone", 40, 20], ["dancer-up-0", 140, 176],
    ];
    for (const [n, w, h] of atLeast) {
      const s = byName(n);
      expect(s.w, `${n} w`).toBeGreaterThanOrEqual(w);
      expect(s.h, `${n} h`).toBeGreaterThanOrEqual(h);
    }
    // the pad faces are 132×62 / 118×18 plus 2 px of frame each side (nothing may touch the frame clip)
    for (const n of ["pad-top-live", "pad-top-hit", "pad-top-new", "pad-top-lock", "pad-gloss"]) expect([byName(n).w, byName(n).h, byName(n).ax, byName(n).ay], n).toEqual([136, 66, 61, 64]);
    for (const n of ["pad-front-live", "pad-front-lock", "pad-front-done"]) expect([byName(n).w, byName(n).h, byName(n).ax, byName(n).ay], n).toEqual([122, 22, 61, 2]);
    expect([byName("pad-top-under").w, byName("pad-top-under").h]).toEqual([164, 94]); // 16 px halo margin
    expect([byName("beam-wedge").w, byName("beam-wedge").h]).toEqual([260, 640]);
    expect([byName("dancer-walk-2-rim").w, byName("dancer-walk-2-rim").h]).toEqual([140, 176]);
    expect([byName("dancer-walk-2-rim-flip").w, byName("dancer-walk-2-rim-flip").h, byName("dancer-walk-2-rim-flip").kind]).toEqual([140, 176, "master"]);
  });

  test("the pilot's arms reach the riser attachment points at the top corners of the frame", () => {
    const p = byName("pilot");
    const svg = p.svg(PALETTE);
    // the hands: two circles near the top corners of the 90×150 frame (drawing coordinates are Anchor-relative)
    const hands = [...svg.matchAll(/<circle[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"[^>]*\br="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]) + p.ax, y: Number(m[2]) + p.ay, r: Number(m[3]) }))
      .filter((c) => c.y < 16 && c.r >= 5 && c.r <= 9);
    expect(hands).toHaveLength(2);
    expect(Math.min(...hands.map((h) => h.x))).toBeLessThan(12);
    expect(Math.max(...hands.map((h) => h.x))).toBeGreaterThan(p.w - 12);
    expect(p.ay).toBeLessThan(16); // the anchor sits on the hands line: the risers end there
  });

  test("the pilot's boots sit PILOT_FEET_Y under the hands line — the export the scene pins its touchdown to", () => {
    const svg = byName("pilot").svg(PALETTE);
    const boots = [...svg.matchAll(/<ellipse[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) })).filter((e) => Math.abs(e.x) === 15);
    expect(boots).toHaveLength(2);
    for (const b of boots) expect(b.y).toBe(PILOT_FEET_Y);
    expect(PILOT_FEET_Y).toBe(131);
  });

  test("the windsock is two frames — the pole (cap + glow, Anchor at the foot) and a horizontal cone (Anchor at its mouth), so the cone alone rotates about the cap", () => {
    const pole = byName("windsock-pole");
    const cone = byName("windsock-cone");
    expect([pole.kind, cone.kind]).toEqual(["master", "master"]);
    // the pole stands on its Anchor: the foot 2 px above the frame's bottom, the pole centred in x
    expect(pole.ay).toBe(pole.h - 2);
    expect(pole.ax).toBe(pole.w / 2);
    const poleSvg = pole.svg(PALETTE);
    expect(poleSvg).toContain("feGaussianBlur"); // the cap's glow is baked here, never in the cone
    expect(poleSvg).not.toContain("<polygon");
    // the cone: bands as polygons, no glow, no pole; its Anchor near the left edge on the centre line; its points run +x from the mouth
    const coneSvg = cone.svg(PALETTE);
    expect(coneSvg).not.toContain("feGaussianBlur");
    expect(coneSvg).not.toContain("<rect");
    const polys = [...coneSvg.matchAll(/<polygon[^>]*points="([^"]+)"/g)].map((m) => m[1]!.trim().split(/[\s,]+/).map(Number));
    expect(polys).toHaveLength(4);
    const xs = polys.flat().filter((_, i) => i % 2 === 0);
    const ys = polys.flat().filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(0, 6); // the mouth sits on the Anchor
    expect(Math.max(...xs)).toBeGreaterThan(30);
    expect(Math.max(...ys)).toBeCloseTo(-Math.min(...ys), 6); // symmetric about the centre line: no baked droop
    expect(cone.ay).toBe(cone.h / 2);
    expect(cone.ax).toBeLessThan(8);
    expect(cone.ax).toBeGreaterThanOrEqual(3);
    // the first band starts at the mouth with the largest radius; the last ends at the tail, narrower
    const mouth = polys[0]!;
    const tail = polys[3]!;
    expect(Math.abs(mouth[1]!)).toBeGreaterThan(Math.abs(tail[5]!));
  });

  test("the beam wedge is brightest at its top edge (fixture) and fades toward the floor", () => {
    for (const name of ["beam-wedge", "beam-core"]) {
      const s = byName(name);
      const svg = s.svg(PALETTE);
      // the gradient's high-opacity stop is at offset 0 (top) and the low one at offset 1 (bottom)
      expect(svg, name).toMatch(/offset="0"[^>]*stop-opacity="(0\.[5-9]\d*|1)"/);
      expect(svg, name).toMatch(/offset="1"[^>]*stop-opacity="0(\.0\d*)?"/);
      expect(svg, name).toMatch(/<linearGradient[^>]*x1="0"[^>]*y1="0"[^>]*x2="0"[^>]*y2="1"/); // top → bottom
      // the apex is the top centre: the anchor is there and the wedge's polygon starts there
      expect(s.ax).toBe(s.w / 2);
      expect(s.ay).toBe(0);
      const poly = /<polygon[^>]*points="([^"]+)"/.exec(svg)?.[1] ?? /<path[^>]*d="M([^"]+)"/.exec(svg)?.[1];
      if (poly === undefined) throw new Error(`${name}: no wedge shape`);
      const pts = poly.trim().split(/[\s,LZ]+/).filter(Boolean).map(Number);
      const ys = pts.filter((_, i) => i % 2 === 1);
      expect(Math.min(...ys), name).toBeLessThanOrEqual(1); // touches the top edge
      const top = pts.filter((_, i) => i % 2 === 1 && pts[i]! <= 1).length;
      const bottom = pts.filter((_, i) => i % 2 === 1 && pts[i]! >= s.h - 1).length;
      expect(top, `${name}: apex points`).toBeLessThanOrEqual(2);
      expect(bottom, `${name}: floor points`).toBe(2);
    }
  });

  test("propeller frames 1–3 carry painted blur; frame 0 is sharp", () => {
    expect(byName("propeller-0").svg(PALETTE)).not.toContain("feGaussianBlur");
    for (const i of [1, 2, 3]) expect(byName(`propeller-${i}`).svg(PALETTE), `propeller-${i}`).toContain("feGaussianBlur");
  });

  test("the Kenney swap stays off: the primitives it would replace are named, nothing is vendored", () => {
    expect(USE_KENNEY).toBe(false);
    expect(KENNEY["pad-halo"]).toBe("particle-pack/circle_05.png");
    expect(KENNEY["beam-wedge"]).toMatch(/^light-masks\//);
    expect(KENNEY["smoke-0"]).toMatch(/^smoke-particles\//);
    for (const name of Object.keys(KENNEY)) expect(SPRITES.some((s) => s.name === name), name).toBe(true);
  });
});

describe("packSheet", () => {
  test("places every frame inside the sheet with a 2 px gutter and no overlaps, anchors copied, kinds kept", () => {
    const { w, h, frames } = packSheet(SPRITES, 2);
    expect(Object.keys(frames).sort()).toEqual(SPRITES.map((s) => s.name).sort());
    const list = Object.entries(frames);
    for (const [name, f] of list) {
      const s = byName(name);
      expect([f.w, f.h, f.ax, f.ay, f.kind], name).toEqual([s.w, s.h, s.ax, s.ay, s.kind]);
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= w && f.y + f.h <= h, `${name} inside ${w}×${h}`).toBe(true);
      expect(Number.isInteger(f.x) && Number.isInteger(f.y), name).toBe(true);
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [an, a] = list[i]!;
        const [bn, b] = list[j]!;
        const apart = a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x || a.y + a.h + 2 <= b.y || b.y + b.h + 2 <= a.y;
        expect(apart, `${an} vs ${bn}`).toBe(true);
      }
    }
    expect(w).toBeLessThanOrEqual(MAX_SHEET_SIDE);
    expect(h).toBeLessThanOrEqual(MAX_SHEET_SIDE);
  });

  test("scaleFrames: 0.75 and 0.5 round outward, never overlap, keep the anchor on the same point and stay finite", () => {
    const one = packSheet(SPRITES, 2);
    for (const z of [0.75, 0.5]) {
      const s = scaleFrames(one, z);
      expect(s.w).toBe(Math.ceil(one.w * z));
      expect(s.h).toBe(Math.ceil(one.h * z));
      const list = Object.entries(s.frames);
      expect(list).toHaveLength(Object.keys(one.frames).length);
      for (const [name, f] of list) {
        const o = one.frames[name]!;
        expect(f.x, name).toBe(Math.floor(o.x * z));
        expect(f.y, name).toBe(Math.floor(o.y * z));
        expect(f.x + f.w, name).toBe(Math.ceil((o.x + o.w) * z));
        expect(f.y + f.h, name).toBe(Math.ceil((o.y + o.h) * z));
        expect(f.x + f.ax, name).toBeCloseTo((o.x + o.ax) * z, 6); // the anchor is the same point of the drawing
        expect(f.y + f.ay, name).toBeCloseTo((o.y + o.ay) * z, 6);
        expect(f.kind).toBe(o.kind);
        for (const v of [f.x, f.y, f.w, f.h, f.ax, f.ay]) expect(Number.isFinite(v), name).toBe(true);
      }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]![1] as Frame;
          const b = list[j]![1] as Frame;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${list[i]![0]} vs ${list[j]![0]} at ${z}`).toBe(true);
        }
      }
    }
  });
});

describe("packSheets — a Sheet Scale whose single sheet would pass the cap is baked as several", () => {
  test("with no cap it is packSheet's one sheet, frame for frame", () => {
    const [only, ...rest] = packSheets(SPRITES, 2, Number.POSITIVE_INFINITY);
    expect(rest).toEqual([]);
    expect(only).toEqual(packSheet(SPRITES, 2));
  });

  test("with a cap, every frame lands in exactly one sheet, no sheet passes the cap, frames inside with the gutter kept", () => {
    const sheets = packSheets(SPRITES, 2, 2048);
    expect(sheets.length).toBeGreaterThan(1);
    const seen = new Map<string, number>();
    for (const [i, sheet] of sheets.entries()) {
      expect(sheet.w <= 2048 && sheet.h <= 2048, `sheet ${i} ${sheet.w}×${sheet.h}`).toBe(true);
      const list = Object.entries(sheet.frames);
      expect(list.length).toBeGreaterThan(0);
      for (const [name, f] of list) {
        expect(seen.has(name), `${name} in sheets ${seen.get(name)} and ${i}`).toBe(false);
        seen.set(name, i);
        const s = byName(name);
        expect([f.w, f.h, f.ax, f.ay, f.kind], name).toEqual([s.w, s.h, s.ax, s.ay, s.kind]);
        expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= sheet.w && f.y + f.h <= sheet.h, `${name} inside sheet ${i}`).toBe(true);
      }
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const [an, fa] = list[a]!;
          const [bn, fb] = list[b]!;
          const apart = fa.x + fa.w + 2 <= fb.x || fb.x + fb.w + 2 <= fa.x || fa.y + fa.h + 2 <= fb.y || fb.y + fb.h + 2 <= fa.y;
          expect(apart, `${an} vs ${bn} in sheet ${i}`).toBe(true);
        }
      }
    }
    expect([...seen.keys()].sort()).toEqual(SPRITES.map((s) => s.name).sort());
  });

  test("a sprite that cannot fit the cap on its own is refused, not silently chopped", () => {
    expect(() => packSheets(SPRITES, 2, 100)).toThrow(/100/);
  });
});

describe("buildAtlas — the 2x Sheet Scale", () => {
  const atlas = buildAtlas();
  const one = atlas.scales["1"];
  const two = atlas.scales["2"];

  test("is several sheets, each at most 4096 px on a side, in the atlas by size", () => {
    expect(MAX_SHEET_SIDE).toBe(4096);
    expect(two.sheets.length).toBeGreaterThan(1);
    for (const [i, s] of two.sheets.entries()) expect(s.w <= MAX_SHEET_SIDE && s.h <= MAX_SHEET_SIDE, `2x sheet ${i} ${s.w}×${s.h}`).toBe(true);
  });

  test("every 2x frame names the one sheet it is on, sits inside it, and is its 1x frame at twice the size with the Anchor on the same point of the drawing", () => {
    expect(Object.keys(two.frames)).toEqual(Object.keys(one.frames)); // the list's order, at every zoom
    for (const [name, f] of Object.entries(two.frames)) {
      const o = one.frames[name]!;
      const sheet = two.sheets[f.sheet];
      expect(sheet, `${name} names sheet ${f.sheet} of ${two.sheets.length}`).toBeDefined();
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= sheet!.w && f.y + f.h <= sheet!.h, `${name} inside 2x sheet ${f.sheet}`).toBe(true);
      expect([f.w, f.h, f.ax, f.ay, f.kind], name).toEqual([o.w * 2, o.h * 2, o.ax * 2, o.ay * 2, o.kind]);
      expect(Number.isInteger(f.x) && Number.isInteger(f.y), name).toBe(true);
    }
    const perSheet = two.sheets.map((_, i) => Object.values(two.frames).filter((f) => f.sheet === i).length);
    expect(perSheet.every((n) => n > 0)).toBe(true);
    expect(perSheet.reduce((a, b) => a + b, 0)).toBe(Object.keys(one.frames).length);
  });
});

describe("dancer-figure", () => {
  test("every Dancer pose frame has finite geometry (no NaN legs)", () => {
    for (const [pose, frames] of Object.entries(POSES)) {
      frames.forEach((p, i) => {
        const f = figure(p);
        expect(f.parts.flat().concat(f.head).every(Number.isFinite), `${pose}[${i}]`).toBe(true);
        expect(f.parts, `${pose}[${i}]`).toHaveLength(10); // torso, shoulders, 2×2 arm segments, 2×2 leg segments
        for (const leg of f.parts.slice(-4)) expect(leg.every(Number.isFinite), `${pose}[${i}] leg`).toBe(true);
        if (f.cup) expect(f.cup.every(Number.isFinite), `${pose}[${i}] cup`).toBe(true);
        if (f.nose) expect(f.nose.every(Number.isFinite), `${pose}[${i}] nose`).toBe(true);
      });
    }
  });

  test("the walk pose is a profile figure and the sway poses mirror without dropping keys", () => {
    expect(POSES.walk).toHaveLength(3);
    for (const p of POSES.walk) expect(p.profile).toBe(true);
    expect(POSES.swayR).toHaveLength(POSES.swayL.length);
    expect(POSES.swayR[1]!.crouch).toBe(POSES.swayL[1]!.crouch);
    expect(POSES.swayR[0]!.lean).toBe(-POSES.swayL[0]!.lean!);
    expect(POSES.swayR[0]!.hip).toBe(-POSES.swayL[0]!.hip!);
    expect(POSES.swayR[0]!.aL).toEqual(POSES.swayL[0]!.aR);
    // the undefined-filter fix: a mirrored frame with no crouch keeps the default (0), never becomes undefined → NaN
    expect(figure(POSES.swayR[0]!).parts[0]![1]).toBe(100);
    const walk = figure(POSES.walk[0]!);
    expect(walk.nose).not.toBeNull();
    expect(walk.nose![0]).toBeGreaterThan(walk.head[0]); // faces +x
    expect(figure(POSES.up[0]!).nose).toBeNull();
    expect(Object.keys(POSES)).toEqual(["up", "swayL", "swayR", "step", "bounce", "drink", "walk", "carlton", "sprinkler", "shoppingCart", "robot"]);
    for (const k of DANCE) expect(Object.keys(POSES)).toContain(k);
    expect(figure(POSES.drink[0]!).cup).not.toBeNull();
    expect(figure(POSES.up[0]!).cup).toBeNull();
  });

  test("mirrorFigure flips x about the frame's centre line and keeps everything else; a rim-flip frame is that rim mirrored back", () => {
    const f = figure(POSES.walk[0]!);
    const m = mirrorFigure(f);
    expect(m.parts).toHaveLength(f.parts.length);
    m.parts.forEach((p, i) => expect(p).toEqual([140 - f.parts[i]![0], f.parts[i]![1], 140 - f.parts[i]![2], f.parts[i]![3], f.parts[i]![4]]));
    expect(m.head).toEqual([140 - f.head[0], f.head[1], f.head[2]]);
    expect(m.nose![0]).toBeLessThan(m.head[0]); // the mirrored walker faces −x
    expect(m.parts.flat().concat(m.head).every(Number.isFinite)).toBe(true);
    for (const i of [0, 1, 2]) {
      const svg = byName(`dancer-walk-${i}-rim-flip`).svg(PALETTE);
      expect(svg).toContain('transform="translate(140,0) scale(-1,1)"');
      expect(svg).toContain("<mask");
      for (const c of colours(svg)) expect(c).toMatch(WHITE_OR_BLACK);
    }
    expect(SPRITES.filter((s) => s.name.endsWith("-rim-flip")).map((s) => s.name)).toEqual(["dancer-walk-0-rim-flip", "dancer-walk-1-rim-flip", "dancer-walk-2-rim-flip"]);
  });

  test("four Moves — carlton, sprinkler, shoppingCart, robot — four front-facing frames each, arms/hip/lean/crouch only, finite, never in the DANCE cycle", () => {
    expect(MOVES).toEqual(["carlton", "sprinkler", "shoppingCart", "robot"]);
    for (const m of MOVES) {
      const frames = POSES[m];
      expect(frames, m).toHaveLength(4);
      expect(DANCE, m).not.toContain(m);
      for (const [i, p] of frames.entries()) {
        expect(p.profile, `${m}-${i}`).toBeUndefined();
        expect(p.cup, `${m}-${i}`).toBeUndefined();
        const f = figure(p);
        expect(f.nose, `${m}-${i}`).toBeNull();
        expect(f.cup, `${m}-${i}`).toBeNull();
        const nums = [...f.head, ...f.parts.flat()];
        expect(nums.every(Number.isFinite), `${m}-${i}`).toBe(true);
        // every capsule end stays inside the 140×176 frame with room for the rim's grown copy (3 px) and the capsule radius
        for (const [x1, y1, x2, y2, r] of f.parts) {
          for (const x of [x1, x2]) expect(x - r - 3, `${m}-${i} x`).toBeGreaterThanOrEqual(0);
          for (const x of [x1, x2]) expect(x + r + 3, `${m}-${i} x`).toBeLessThanOrEqual(140);
          for (const y of [y1, y2]) expect(y - r - 3, `${m}-${i} y`).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // the sheet carries a body plate and a rim Master per Move frame, no flip variant (only the walk flips)
    const names = SPRITES.map((s) => s.name);
    for (const m of MOVES) for (const i of [0, 1, 2, 3]) {
      expect(names).toContain(`dancer-${m}-${i}`);
      expect(names).toContain(`dancer-${m}-${i}-rim`);
      expect(names).not.toContain(`dancer-${m}-${i}-rim-flip`);
    }
  });

  test("figureSvg: feet on y = 168, body near-black and rim white-only; nothing else in either mode", () => {
    const f = figure(POSES.up[0]!);
    const body = figureSvg(f, "body");
    const rim = figureSvg(f, "rim");
    for (const c of colours(body)) expect(c).toMatch(/^(#0a0818|none|url\(#[^)]+\))$/);
    for (const c of colours(rim)) expect(c).toMatch(WHITE_OR_BLACK);
    expect(rim).toContain("<mask");
    expect(body).not.toContain("<mask");
    expect(body).not.toMatch(/<text|filter/);
    expect([f.parts.at(-3)!, f.parts.at(-1)!].every((shin) => shin[3] === 168)).toBe(true); // both feet on the floor line
  });
});

// ---------- the committed bake — decoded without a dependency (8-bit RGBA, non-interlaced, as resvg writes it)
const ART = path.join(import.meta.dir, "..", "..", "src", "overlay", "art");

function decodePng(buf: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error("not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const idat: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  for (let off = 8; off < buf.length; ) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    if (type === "IHDR") {
      w = dv.getUint32(off + 8);
      h = dv.getUint32(off + 12);
      depth = buf[off + 16]!;
      colour = buf[off + 17]!;
      interlace = buf[off + 20]!;
    } else if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth} colour ${colour} interlace ${interlace}`);
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) {
    z.set(c, at);
    at += c.length;
  }
  const raw = new Uint8Array(inflateSync(z)); // zlib-wrapped, as the PNG spec says; Bun.inflateSync wants raw deflate
  const bpp = 4;
  const stride = w * bpp;
  const rgba = new Uint8Array(stride * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]!;
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const v = raw[p++]!;
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let out: number;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad filter ${filter} on row ${y}`);
      row[x] = out & 255;
    }
  }
  if (p !== raw.length) throw new Error(`PNG data length ${raw.length}, consumed ${p}`);
  return { w, h, rgba };
}

const alphaAt = (img: { w: number; rgba: Uint8Array }, x: number, y: number): number => img.rgba[(y * img.w + x) * 4 + 3]!;

/** The largest alpha on each of a frame's four edge rows/columns. */
function edgeAlpha(img: { w: number; rgba: Uint8Array }, f: Frame): { top: number; bottom: number; left: number; right: number } {
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let x = f.x; x < f.x + f.w; x++) {
    top = Math.max(top, alphaAt(img, x, f.y));
    bottom = Math.max(bottom, alphaAt(img, x, f.y + f.h - 1));
  }
  for (let y = f.y; y < f.y + f.h; y++) {
    left = Math.max(left, alphaAt(img, f.x, y));
    right = Math.max(right, alphaAt(img, f.x + f.w - 1, y));
  }
  return { top, bottom, left, right };
}

/** Alpha-weighted centroid x (frame-relative) and the alpha sum of a frame. */
function alphaCentroid(img: { w: number; rgba: Uint8Array }, f: Frame): { cx: number; sum: number } {
  let sum = 0;
  let mx = 0;
  for (let y = f.y; y < f.y + f.h; y++) {
    for (let x = f.x; x < f.x + f.w; x++) {
      const a = alphaAt(img, x, y);
      sum += a;
      mx += a * (x - f.x + 0.5);
    }
  }
  return { cx: sum ? mx / sum : Number.NaN, sum };
}

/** Width and height from a PNG's IHDR alone: the 2x sheets are 16 megapixels each, and only their size is under test. */
function pngSize(buf: Uint8Array): { w: number; h: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[12]!, buf[13]!, buf[14]!, buf[15]!) !== "IHDR") throw new Error("not a PNG");
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

describe("the committed 2x sheets", () => {
  const atlas = JSON.parse(readFileSync(path.join(ART, ATLAS_FILE), "utf8")) as Atlas;
  const two = atlas.scales["2"];

  test("there is one PNG per sheet the atlas names, each the atlas's size and at most the cap on a side; the old single 2x sheet is gone", () => {
    expect(two.sheets.length).toBeGreaterThan(1);
    two.sheets.forEach((s, i) => {
      const got = pngSize(new Uint8Array(readFileSync(path.join(ART, sheetFile(2, i)))));
      expect([got.w, got.h], sheetFile(2, i)).toEqual([s.w, s.h]);
      expect(s.w <= MAX_SHEET_SIDE && s.h <= MAX_SHEET_SIDE, sheetFile(2, i)).toBe(true);
    });
    expect(() => readFileSync(path.join(ART, sheetFile(2)))).toThrow();
    expect(() => readFileSync(path.join(ART, sheetFile(2, two.sheets.length)))).toThrow();
  });

  test("the committed atlas is what the script builds today, so a rebake is a no-op until a sprite changes", () => {
    expect(atlas).toEqual(buildAtlas());
  });

  test("every 2x frame holds its own drawing where the atlas says: edges clear, and about four times the 1x frame's alpha", () => {
    const one = atlas.scales["1"];
    const oneImg = decodePng(new Uint8Array(readFileSync(path.join(ART, sheetFile(1)))));
    const twoImgs = two.sheets.map((_, i) => decodePng(new Uint8Array(readFileSync(path.join(ART, sheetFile(2, i))))));
    const offenders: string[] = [];
    for (const [name, f] of Object.entries(two.frames)) {
      const img = twoImgs[f.sheet]!;
      const e = edgeAlpha(img, f);
      const worst = Math.max(e.top, e.bottom, e.left, e.right);
      if (worst > 12) offenders.push(`${name}@2 edge T${e.top} B${e.bottom} L${e.left} R${e.right}`);
      const a = alphaCentroid(img, f).sum;
      const b = alphaCentroid(oneImg, one.frames[name]!).sum;
      // the same drawing at zoom 2 covers four times the pixels; antialiasing moves it a few percent either way
      if (b > 0 && (a < 3.6 * b || a > 4.4 * b)) offenders.push(`${name}@2 alpha ${a} vs 4 × ${b} at 1x`);
      if (b === 0 && a !== 0) offenders.push(`${name}@2 has ink where the 1x frame has none`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});

describe("the committed 1× sheet", () => {
  const atlas = JSON.parse(readFileSync(path.join(ART, ATLAS_FILE), "utf8")) as Atlas;
  const one = atlas.scales["1"];
  const img = decodePng(new Uint8Array(readFileSync(path.join(ART, sheetFile(1)))));

  test("is the atlas's size and holds every sprite of the list", () => {
    expect([img.w, img.h]).toEqual([one.w, one.h]);
    expect(Object.keys(one.frames)).toEqual(SPRITES.map((s) => s.name));
  });

  test("every drawing fits inside its frame: the alpha along each frame's four edges is ≤ 12/255 (nothing is chopped by the frame clip)", () => {
    const offenders: string[] = [];
    for (const [name, f] of Object.entries(one.frames)) {
      const e = edgeAlpha(img, f);
      const worst = Math.max(e.top, e.bottom, e.left, e.right);
      if (worst > 12) offenders.push(`${name} T${e.top} B${e.bottom} L${e.left} R${e.right}`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  test("a walk rim-flip frame is the rim for the same figure drawn with flipX — its light sits on the opposite side to its -rim sibling", () => {
    for (const i of [0, 1, 2]) {
      const rim = one.frames[`dancer-walk-${i}-rim`]!;
      const flip = one.frames[`dancer-walk-${i}-rim-flip`]!;
      expect(flip, `dancer-walk-${i}-rim-flip`).toBeDefined();
      expect([flip.w, flip.h, flip.ax, flip.ay, flip.kind]).toEqual([rim.w, rim.h, rim.ax, rim.ay, "master"]);
      const body = alphaCentroid(img, one.frames[`dancer-walk-${i}`]!);
      const a = alphaCentroid(img, rim);
      const b = alphaCentroid(img, flip);
      // the rim's light sits left of the body's centre, the flip's right of it (the figure is asymmetric — lean, nose,
      // arm swing — so the two are not exact mirrors; the amount of light is the same order)
      expect(a.sum).toBeGreaterThan(0);
      expect(Math.abs(a.sum - b.sum) / a.sum, `walk ${i} alpha sum`).toBeLessThan(0.2);
      expect(a.cx, `walk ${i} -rim left of the body`).toBeLessThan(body.cx - 3);
      expect(b.cx, `walk ${i} -rim-flip right of the body`).toBeGreaterThan(body.cx + 3);
    }
  });
});

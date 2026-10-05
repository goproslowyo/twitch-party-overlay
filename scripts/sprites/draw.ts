#!/usr/bin/env bun
/**
 * The sprite script: every Chrome Lounge sprite is drawn here as SVG and baked by `just sprites` with
 * resvg-js at zoom 2 / 1 / 0.75 / 0.5 into `src/overlay/art/` — one PNG sheet each at 1 / 0.75 / 0.5, the 2x scale as
 * several sheets each at most 4096 px on a side, plus one generated atlas with an Anchor per frame (glow padding
 * is asymmetric) and a 2 px gutter at 1×. The PNGs and the atlas are committed and reviewed as a diff; the atlas is
 * never hand-edited.
 *
 *   bun scripts/sprites/draw.ts [--out src/overlay/art] [--only <name>]
 *
 * The drawings derive from the design board generator, split by how they tint: single-hue pieces are white **Masters**
 * (luminance in alpha; tinted once at boot outside scene/), multi-hue pieces are per-hue Masters as layers (canopy a/b,
 * ship body / stripe / light) under never-tinted gloss **overlays** that carry the painted lighting (rim top-left,
 * shadow bottom-right), and only the pilot is a **Coloured Sprite**. No words and no glyphs in any sprite — text and
 * emoji are `fillText` at runtime. Every coordinate in a drawing is relative to its Anchor.
 *
 * Kenney: the original art plan sourced the glow blobs, smoke and light masks from Kenney's CC0 packs. Fetching them is a download
 * this pipeline does not do; a soft radial blob is the same pixels from an SVG gradient, so every primitive is drawn
 * here. `KENNEY` is the record of which pack file each drawn primitive stands in for, and `USE_KENNEY` (always false)
 * only states that none of them is vendored — no primitive branches on it. Swapping one in would mean vendoring the
 * file under src/overlay/art/kenney/ and inlining it as a data URI in that primitive's drawing.
 *
 * Every drawing must fit inside its frame: `compositeSvg` clips each sprite to its frame, so anything past the edge is
 * chopped flat in the bake. `draw.test.ts` decodes the committed 1× sheet and asserts the alpha along every frame's four
 * edges is ≤ 12/255 — glow needs ~2.5 σ of margin past its shape; solid shapes need a couple of pixels.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIGURE_H, FIGURE_W, FLOOR_Y, POSES, figure, figureSvg, type Figure } from "../../src/overlay/scene/dancer-figure.ts";
import { MAX_SHEET_SIDE, SHEET_ID, assertFinite, type Atlas, type Frame, type SheetFrames, type SplitFrame, type SplitSheetFrames, type SpriteKind } from "../../src/overlay/atlas.ts";

// ---------- palette (gen-round2.mjs :4-8) — Masters never use it; the pilot, the overlays and the plates do
export interface Palette {
  ink: string;
  far: string;
  pink: string;
  mint: string;
  lemon: string;
  lilac: string;
  peach: string;
  text: string;
  panel: string;
  line: string;
  gold: string;
  cyan: string;
  red: string;
  t0: string;
  t1: string;
  t2: string;
}

export const PALETTE: Palette = {
  ink: "#07060e",
  far: "#141130",
  pink: "#ff9ecb",
  mint: "#9df2d9",
  lemon: "#ffe08a",
  lilac: "#c7a6ff",
  peach: "#ffc27a",
  text: "#fbf5ff",
  panel: "rgba(10,8,22,.86)",
  line: "rgba(255,158,203,.55)",
  gold: "#ffe08a",
  cyan: "#7de8ff",
  red: "#ff7a8a",
  t0: "#9df2d9",
  t1: "#c7a6ff",
  t2: "#ffc27a",
};

export type { Atlas, Frame, SheetFrames, SplitFrame, SplitSheetFrames, SpriteKind };

export interface SpriteDef {
  name: string;
  /** Frame size at 1×, glow padding included. */
  w: number;
  h: number;
  /** The Anchor: the point of the frame the scene positions; every drawing coordinate is relative to it. */
  ax: number;
  ay: number;
  kind: SpriteKind;
  svg: (p: Palette) => string;
}

/** Baked at zoom 2 (several sheets, for a 4K Browser source at Detail 2x, where the 1x sheet would be upscaled and go soft), 1, 0.75 and 0.5. */
export const GUTTER = 2;

/** Nothing from Kenney's packs is vendored: every primitive named in KENNEY is drawn here. A record, not a switch. */
export const USE_KENNEY = false;
/** The Kenney pack file each drawn primitive stands in for (sprite name → `<pack>/<file>`). */
export const KENNEY: Readonly<Record<string, string>> = {
  "pad-halo": "particle-pack/circle_05.png",
  "pad-hit-burst-0": "particle-pack/circle_05.png",
  "pad-hit-burst-1": "particle-pack/circle_05.png",
  "pad-hit-burst-2": "particle-pack/circle_05.png",
  "pad-top-new": "particle-pack/circle_01.png",
  "ship-light": "particle-pack/light_01.png",
  "tower-head": "particle-pack/light_01.png",
  "beam-wedge": "light-masks/cone.png",
  "beam-core": "light-masks/cone.png",
  "laser-halo": "particle-pack/trace_01.png",
  "horizon-glow": "particle-pack/trace_02.png",
  "smoke-0": "smoke-particles/smoke_01.png",
  "smoke-1": "smoke-particles/smoke_02.png",
  "smoke-2": "smoke-particles/smoke_03.png",
  plate: "particle-pack/circle_05.png",
  "firework-ray": "particle-pack/spark_05.png",
  "thanks-glow": "particle-pack/circle_05.png",
  spark: "particle-pack/star_07.png",
  dot: "particle-pack/circle_03.png",
};

// ---------- SVG helpers
const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';
const W = "#fff";
const K = "#000";

/** A number for an attribute: two decimals, never "-0", never exponent form. */
export const n = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error(`non-finite number in a sprite: ${v}`);
  const r = Math.round(v * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

type Stop = readonly [offset: number, colour: string, opacity: number];

interface Ctx {
  p: Palette;
  defs: string[];
  id: (k: string) => string;
  /** objectBoundingBox linear gradient; returns `url(#…)`. */
  linear: (k: string, dir: readonly [number, number, number, number], stops: readonly Stop[]) => string;
  /** userSpaceOnUse linear gradient (for strokes and lines, whose boxes may be degenerate). */
  linearUser: (k: string, dir: readonly [number, number, number, number], stops: readonly Stop[]) => string;
  /** objectBoundingBox radial gradient (elliptical on an ellipse); returns `url(#…)`. */
  radial: (k: string, stops: readonly Stop[]) => string;
  /** userSpaceOnUse radial gradient centred at (cx, cy) with radius r. */
  radialUser: (k: string, cx: number, cy: number, r: number, stops: readonly Stop[]) => string;
  /** A Gaussian blur over the whole frame; returns the `filter="url(#…)"` attribute. */
  blur: (k: string, std: number) => string;
  /** A luminance mask over the whole frame; returns the `mask="url(#…)"` attribute. */
  mask: (k: string, inner: string) => string;
  /** A clip path; returns the `clip-path="url(#…)"` attribute. */
  clip: (k: string, inner: string) => string;
}

function makeCtx(name: string, p: Palette, w: number, h: number, ax: number, ay: number): Ctx {
  const defs: string[] = [];
  const id = (k: string): string => `${name}_${k}`;
  const stops = (s: readonly Stop[]): string => s.map(([o, c, a]) => `<stop offset="${n(o)}" stop-color="${c}" stop-opacity="${n(a)}"/>`).join("");
  const dir = ([x1, y1, x2, y2]: readonly [number, number, number, number]): string => `x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"`;
  const frame = `x="${n(-ax)}" y="${n(-ay)}" width="${w}" height="${h}"`;
  return {
    p,
    defs,
    id,
    linear: (k, d, s) => {
      defs.push(`<linearGradient id="${id(k)}" ${dir(d)}>${stops(s)}</linearGradient>`);
      return `url(#${id(k)})`;
    },
    linearUser: (k, d, s) => {
      defs.push(`<linearGradient id="${id(k)}" gradientUnits="userSpaceOnUse" ${dir(d)}>${stops(s)}</linearGradient>`);
      return `url(#${id(k)})`;
    },
    radial: (k, s) => {
      defs.push(`<radialGradient id="${id(k)}">${stops(s)}</radialGradient>`);
      return `url(#${id(k)})`;
    },
    radialUser: (k, cx, cy, r, s) => {
      defs.push(`<radialGradient id="${id(k)}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}">${stops(s)}</radialGradient>`);
      return `url(#${id(k)})`;
    },
    blur: (k, std) => {
      defs.push(`<filter id="${id(k)}" filterUnits="userSpaceOnUse" ${frame}><feGaussianBlur stdDeviation="${n(std)}"/></filter>`);
      return `filter="url(#${id(k)})"`;
    },
    mask: (k, inner) => {
      defs.push(`<mask id="${id(k)}" maskUnits="userSpaceOnUse" ${frame}>${inner}</mask>`);
      return `mask="url(#${id(k)})"`;
    },
    clip: (k, inner) => {
      defs.push(`<clipPath id="${id(k)}">${inner}</clipPath>`);
      return `clip-path="url(#${id(k)})"`;
    },
  };
}

function def(name: string, w: number, h: number, ax: number, ay: number, kind: SpriteKind, draw: (c: Ctx) => string): SpriteDef {
  if (![w, h, ax, ay].every(Number.isFinite) || ax < 0 || ax > w || ay < 0 || ay > h) throw new Error(`${name}: bad frame ${w}×${h} anchor ${ax},${ay}`);
  return {
    name,
    w,
    h,
    ax,
    ay,
    kind,
    svg: (p) => {
      const c = makeCtx(name, p, w, h, ax, ay);
      const body = draw(c);
      const defs = c.defs.length ? `<defs>${c.defs.join("")}</defs>` : "";
      return `<svg ${XMLNS} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}<g transform="translate(${n(ax)},${n(ay)})">${body}</g></svg>`;
    },
  };
}

const circle = (cx: number, cy: number, r: number, attrs: string): string => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" ${attrs}/>`;
const ellipse = (cx: number, cy: number, rx: number, ry: number, attrs: string): string => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" ${attrs}/>`;
const rect = (x: number, y: number, w: number, h: number, rx: number, attrs: string): string => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(rx)}" ${attrs}/>`;
const line = (x1: number, y1: number, x2: number, y2: number, attrs: string): string => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${attrs}/>`;
const pathEl = (d: string, attrs: string): string => `<path d="${d}" ${attrs}/>`;
const poly = (pts: ReadonlyArray<readonly [number, number]>, attrs: string): string => `<polygon points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" ${attrs}/>`;
const fill = (colour: string, opacity = 1): string => `fill="${colour}"${opacity === 1 ? "" : ` fill-opacity="${n(opacity)}"`}`;
const stroke = (colour: string, width: number, opacity = 1, extra = ""): string =>
  `fill="none" stroke="${colour}" stroke-width="${n(width)}"${opacity === 1 ? "" : ` stroke-opacity="${n(opacity)}"`}${extra ? ` ${extra}` : ""}`;
const g = (attrs: string, inner: string): string => `<g ${attrs}>${inner}</g>`;

/** A four-point star (✦ as geometry), radius `r`, waist `r * 0.2`. */
const star4 = (cx: number, cy: number, r: number, attrs: string, rot = 0): string => {
  const k = r * 0.2;
  const pts: Array<readonly [number, number]> = [[0, -r], [k, -k], [r, 0], [k, k], [0, r], [-k, k], [-r, 0], [-k, -k]];
  return g(`transform="translate(${n(cx)},${n(cy)}) rotate(${n(rot)})"`, poly(pts, attrs));
};

// =====================================================================================================================
// Jumper — canopy layers share one Anchor (the rim centre); risers hang from it; the pilot's Anchor is the hands line.
// At runtime: canopy at (x, y); risers at (x, y); pilot at (x, y + RISER_DROP).
// =====================================================================================================================
const CAN_R = 150;
const CAN_RY = 93;
const CAN_W = 320;
const CAN_H = 220;
const CAN_AX = 160;
const CAN_AY = 140;
/** The hands hang this far below the rim centre; the risers frame is exactly this tall. */
export const RISER_DROP = 130;
const HAND_X = 36.5;
/** The pilot's boots' centre line, this far under the hands line (the Anchor) — jumper.ts stands them on the touchdown line. */
export const PILOT_FEET_Y = 131;

const goreAngles = (i: number): [number, number] => [Math.PI + (i / 8) * Math.PI, Math.PI + ((i + 1) / 8) * Math.PI];
const rimPoint = (a: number): [number, number] => [CAN_R * Math.cos(a), CAN_RY * Math.sin(a)];
/** The rim between two angles traced as a polyline (an arc command would let the renderer pick the other ellipse). */
const rimTrace = (a0: number, a1: number, steps: number): string =>
  Array.from({ length: steps + 1 }, (_, k) => rimPoint(a0 + ((a1 - a0) * k) / steps)).map(([x, y]) => `${n(x)},${n(y)}`).join(" L");
const goreArc = (i: number): string => {
  const [a0, a1] = goreAngles(i);
  return `M${rimTrace(a0, a1, 8)}`;
};
const gorePath = (i: number): string => `M0,0 L${goreArc(i).slice(1)} Z`;
const DOME = `M${rimTrace(Math.PI, 2 * Math.PI, 64)} Z`;

/** One hue's gores (a = the 1st, 3rd, 5th, 7th gore; b = the others) with a soft rim glow along their outer arcs. */
function canopyMaster(parity: 0 | 1, xs: number): (c: Ctx) => string {
  return (c) => {
    const mine = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => i % 2 === parity);
    const glow = g(`${c.blur("glow", 3)} opacity="0.55"`, mine.map((i) => pathEl(goreArc(i), stroke(W, 5))).join(""));
    const gores = mine.map((i) => pathEl(gorePath(i), `${fill(W)} stroke="${W}" stroke-width="1.2" stroke-linejoin="round"`)).join("");
    return g(`transform="scale(${n(xs)},1)"`, glow + gores);
  };
}

/** The never-tinted lighting of the canopy: dome shading, underside, seams, rim highlight, specular, apex vent. */
function canopyGloss(xs: number): (c: Ctx) => string {
  return (c) => {
    const vert = c.linear("v", [0, 0, 0, 1], [[0, W, 0.3], [0.3, W, 0], [0.55, K, 0], [1, K, 0.38]]);
    const side = c.linear("s", [0, 0, 1, 0], [[0, W, 0.12], [0.5, W, 0], [1, K, 0.16]]);
    const under = c.linear("u", [0, 0, 0, 1], [[0, K, 0.6], [1, K, 0.25]]);
    const seams = [1, 2, 3, 4, 5, 6, 7].map((i) => {
      const [x, y] = rimPoint(goreAngles(i)[0]);
      return line(0, 0, x, y, stroke(K, 1.2, 0.3));
    }).join("");
    const specular = ellipse(-CAN_R * 0.35, -CAN_R * 0.42, CAN_R * 0.28, CAN_R * 0.1, `${fill(W, 0.55)} transform="rotate(-18)"`);
    return g(
      `transform="scale(${n(xs)},1)"`,
      pathEl(`M${n(-CAN_R)},0 A${n(CAN_R)},26 0 0 0 ${n(CAN_R)},0 Z`, fill(under)) +
        pathEl(DOME, fill(vert)) +
        pathEl(DOME, fill(side)) +
        seams +
        pathEl(DOME.replace(" Z", ""), stroke(W, 2.5, 0.9, 'stroke-linecap="round"')) +
        specular +
        circle(0, -CAN_RY + 6, 7, fill(K, 0.6)),
    );
  };
}

const canopyDefs = (): SpriteDef[] => {
  const out: SpriteDef[] = [
    def("canopy-a", CAN_W, CAN_H, CAN_AX, CAN_AY, "master", canopyMaster(0, 1)),
    def("canopy-b", CAN_W, CAN_H, CAN_AX, CAN_AY, "master", canopyMaster(1, 1)),
    def("canopy-gloss", CAN_W, CAN_H, CAN_AX, CAN_AY, "overlay", canopyGloss(1)),
  ];
  // the twirl frames: the same canopy foreshortened to 0.45 / 0.7 / 1.0 of its width
  [0.45, 0.7, 1].forEach((xs, i) => {
    out.push(def(`canopy-side-${i}-a`, CAN_W, CAN_H, CAN_AX, CAN_AY, "master", canopyMaster(0, xs)));
    out.push(def(`canopy-side-${i}-b`, CAN_W, CAN_H, CAN_AX, CAN_AY, "master", canopyMaster(1, xs)));
    out.push(def(`canopy-side-${i}-gloss`, CAN_W, CAN_H, CAN_AX, CAN_AY, "overlay", canopyGloss(xs)));
  });
  return out;
};

/** Six suspension lines from the rim to two risers at the hands — one strip so the arms meet them; 4 px of frame past each end. */
const risers = def("risers", 300, RISER_DROP + 8, 150, 4, "master", () => {
  const lines = [-0.92, -0.55, -0.18, 0.18, 0.55, 0.92]
    .map((k) => line(k * CAN_R, 0, k < 0 ? -HAND_X : HAND_X, RISER_DROP - 12, stroke(W, 1.6, 0.75, 'stroke-linecap="round"')))
    .join("");
  const straps = [-HAND_X, HAND_X].map((x) => line(x, RISER_DROP - 14, x, RISER_DROP - 1, stroke(W, 3.2, 1, 'stroke-linecap="round"'))).join("");
  return lines + straps;
});

/** The chibi pilot, the one Coloured Sprite: helmet lemon, visor, suit, arms up to the riser points at the top corners, boots. */
const pilot = def("pilot", 96, 153, 48, 11, "coloured", (c) => {
  const p = c.p;
  const dark = "#2a1a55";
  const suit = c.linear("suit", [0, 0, 1, 1], [[0, "#d9c8ff", 1], [1, "#6c4fc4", 1]]);
  const helmet = c.linear("helmet", [0, 0, 0, 1], [[0, "#ffffff", 1], [0.5, p.lemon, 1], [1, "#c98a1c", 1]]);
  const visor = c.linear("visor", [0, 0, 1, 1], [[0, "#bff5ff", 1], [0.5, "#2a6f8f", 1], [1, "#0c2233", 1]]);
  const armL = "M-14,54 Q-42,36 -36.5,4";
  const armR = "M14,54 Q42,36 36.5,4";
  const cap = 'stroke-linecap="round"';
  return (
    // arms behind the torso, dark outline then suit
    pathEl(armL, stroke(dark, 13, 1, cap)) +
    pathEl(armR, stroke(dark, 13, 1, cap)) +
    pathEl(armL, stroke(suit, 9, 1, cap)) +
    pathEl(armR, stroke(suit, 9, 1, cap)) +
    // hands on the riser attachment points (the content's top corners; the frame adds 3 px round them)
    circle(-HAND_X, 1, 7, `fill="${p.lemon}" stroke="${dark}" stroke-width="3"`) +
    circle(HAND_X, 1, 7, `fill="${p.lemon}" stroke="${dark}" stroke-width="3"`) +
    // legs and boots
    line(-12, 100, -14, 126, stroke(dark, 13, 1, cap)) +
    line(12, 100, 14, 126, stroke(dark, 13, 1, cap)) +
    line(-12, 100, -14, 124, stroke(suit, 9, 1, cap)) +
    line(12, 100, 14, 124, stroke(suit, 9, 1, cap)) +
    ellipse(-15, PILOT_FEET_Y, 11, 6, `fill="${p.lemon}" stroke="${dark}" stroke-width="3"`) +
    ellipse(15, PILOT_FEET_Y, 11, 6, `fill="${p.lemon}" stroke="${dark}" stroke-width="3"`) +
    // torso with a chest stripe and belt; rim light top-left, shadow bottom-right
    rect(-22, 48, 44, 58, 20, `fill="${suit}" stroke="${dark}" stroke-width="3"`) +
    rect(-16, 62, 32, 5, 2.5, fill(dark, 0.5)) +
    rect(-18, 86, 36, 4, 2, fill(dark, 0.35)) +
    pathEl("M-18,62 Q-20,52 -8,50", stroke(W, 2, 0.35, cap)) +
    pathEl("M10,98 Q20,92 20,78", stroke(K, 2.5, 0.25, cap)) +
    // helmet, visor, highlights, antenna
    circle(0, 26, 26, `fill="${helmet}" stroke="${dark}" stroke-width="3"`) +
    pathEl("M-22,22 Q0,12 22,22 L20,38 Q0,46 -20,38 Z", `fill="${visor}" stroke="${dark}" stroke-width="2.5"`) +
    pathEl("M-15,25 Q-5,19 5,22", stroke(W, 2.5, 0.8, cap)) +
    ellipse(-9, 10, 8, 4, `${fill(W, 0.7)} transform="rotate(-30 -9 10)"`) +
    pathEl("M10,46 Q22,40 24,28", stroke(K, 2.5, 0.22, cap)) +
    circle(0, -2, 3.5, fill(p.pink))
  );
});

/** Ground shadow under the jumper, sharpening as the ground comes up. */
const pilotShadow = (i: number): SpriteDef =>
  def(`pilot-shadow-${i}`, 120, 36, 60, 18, "plate", (c) => {
    const rx = [44, 46, 48][i]!;
    const ry = [8, 9, 10][i]!;
    const alpha = [0.35, 0.45, 0.55][i]!;
    const std = [6, 3, 1][i]!;
    return ellipse(0, 0, rx, ry, `${fill(K, alpha)} ${c.blur("b", std)}`);
  });

// =====================================================================================================================
// Airship — body / stripe / gloss share one frame and Anchor (the envelope centre). Offsets from that centre:
//   fins Anchor at (-160, 0) · propeller at (-254, 0) · running light at (+98, +112) · gondola windows at
//   (-90 + 30 i, +112) for i = 0..6 · ready-badge on the nose at about (+205, -6).
// =====================================================================================================================
const SHIP_W = 520;
const SHIP_H = 260;
const SHIP_AX = 260;
const SHIP_AY = 92;
export const SHIP_OFFSETS = { fins: [-160, 0], propeller: [-254, 0], light: [98, 112], gondolaY: 112, windowX: (i: number): number => -90 + 30 * i, badge: [205, -6] } as const;
const ENVELOPE = ellipse(0, 0, 230, 70, fill(W));
const GONDOLA_RECT = (attrs: string): string => rect(-112, 92, 224, 42, 14, attrs);
const STRIPE_TOP = "M-120,-68 C-40,-84 60,-84 150,-58 L146,-48 C60,-72 -40,-72 -118,-58 Z";
const STRIPE_BOTTOM = "M-120,62 C-40,80 60,80 150,56 L146,48 C60,70 -40,70 -118,54 Z";

const shipBody = def("ship-body", SHIP_W, SHIP_H, SHIP_AX, SHIP_AY, "master", () =>
  ENVELOPE + line(-60, 66, -52, 96, stroke(W, 3, 0.9)) + line(60, 66, 52, 96, stroke(W, 3, 0.9)) + GONDOLA_RECT(fill(W)),
);
const shipStripe = def("ship-stripe", SHIP_W, SHIP_H, SHIP_AX, SHIP_AY, "master", () => pathEl(STRIPE_TOP, fill(W)) + pathEl(STRIPE_BOTTOM, fill(W, 0.8)));
const shipGloss = def("ship-gloss", SHIP_W, SHIP_H, SHIP_AX, SHIP_AY, "overlay", (c) => {
  const vert = c.linear("v", [0, 0, 0, 1], [[0, W, 0.38], [0.28, W, 0], [0.6, K, 0], [1, K, 0.5]]);
  const side = c.linear("s", [0, 0, 1, 0], [[0, W, 0.1], [0.55, W, 0], [1, K, 0.22]]);
  const cabin = c.linear("g", [0, 0, 0, 1], [[0, W, 0.14], [0.5, K, 0.1], [1, K, 0.35]]);
  return (
    ellipse(0, 0, 230, 70, fill(vert)) +
    ellipse(0, 0, 230, 70, fill(side)) +
    pathEl("M-236,0 C-200,-40 -60,-52 40,-46 C-80,-70 -180,-40 -236,0 Z", fill(W, 0.35)) +
    ellipse(60, -38, 120, 14, fill(W, 0.28)) +
    pathEl(`M${n(-230)},0 A230,70 0 0 0 230,0`, stroke(K, 2, 0.18)) +
    line(-60, 66, -52, 96, stroke("#c9b8ff", 3)) +
    line(60, 66, 52, 96, stroke("#c9b8ff", 3)) +
    GONDOLA_RECT(fill(K, 0.62)) +
    GONDOLA_RECT(fill(cabin)) +
    GONDOLA_RECT(stroke("#cbb8ff", 2)) +
    pathEl("M-100,95 L100,95", stroke(W, 1.5, 0.25))
  );
});
/** Running light with halo (pulses ≤ 2 Hz by alpha at runtime). */
const shipLight = def("ship-light", 40, 40, 20, 20, "master", (c) => circle(0, 0, 8, `${fill(W, 0.85)} ${c.blur("h", 4)}`) + circle(0, 0, 4, fill(W)));
/** Three tail fins + the prop shaft, a separate frame so the scene draws them BEHIND the body. Anchor = (-160, 0) of the ship; the roots end at the Anchor, 6 px inside the frame. */
const fins = def("fins", 136, 180, 130, 90, "master", () =>
  g(
    'transform="translate(160,0)"',
    pathEl("M-160,-50 L-246,-88 L-230,-14 Z", `${fill(W)} stroke="${W}" stroke-width="1" stroke-linejoin="round"`) +
      pathEl("M-160,50 L-246,88 L-230,14 Z", `${fill(W, 0.72)} stroke="${W}" stroke-opacity="0.72" stroke-width="1" stroke-linejoin="round"`) +
      pathEl("M-168,-8 L-244,-12 L-244,12 L-168,8 Z", fill(W, 0.86)) +
      rect(-250, -4, 30, 8, 4, fill(W, 0.55)),
  ),
);
/** 2-blade prop on the tail shaft seen from the side, four rotation frames; blur painted into 1–3. */
const propeller = (i: number): SpriteDef =>
  def(`propeller-${i}`, 24, 64, 12, 32, "overlay", (c) => {
    const ry = [28, 20, 6, 20][i]!;
    const blur = i === 0 ? "" : c.blur("b", [0, 1.4, 2, 1.4][i]!);
    const ghost = i === 0 ? "" : ellipse(0, 0, 5, [28, 26, 24, 26][i]!, `${fill("#dcd1ff", 0.22)} ${c.blur("g", 3)}`);
    return (
      ghost +
      ellipse(0, 0, 4, ry, `${fill("#dcd1ff", 0.9)} ${blur}`) +
      circle(0, 0, 4.5, 'fill="#8f83b8" stroke="#2c2444" stroke-width="1.5"') +
      circle(-1.2, -1.2, 1.4, fill(W, 0.7))
    );
  });
/** Dark window disc + lilac rim; a Passenger glyph is drawn into it at runtime. */
const gondolaWindow = def("gondola-window", 30, 30, 15, 15, "overlay", () =>
  circle(0, 0, 12, 'fill="#0b1a2a" stroke="#cbb8ff" stroke-width="2"') +
  pathEl("M-8,-4 Q-5,-9 1,-9", stroke(W, 1.5, 0.4, 'stroke-linecap="round"')) +
  pathEl("M8,3 Q6,8 1,9", stroke(K, 1.5, 0.35, 'stroke-linecap="round"')),
);
/** The ×N READY badge on the nose: disc with an 8 px halo; the number is text at runtime. */
const readyBadge = def("ready-badge", 72, 72, 36, 36, "master", (c) => circle(0, 0, 26, `${fill(W, 0.7)} ${c.blur("h", 4)}`) + circle(0, 0, 22, fill(W)) + circle(0, 0, 19, stroke(W, 1, 1)));
const readyBadgeDim = def("ready-badge-dim", 64, 64, 32, 32, "overlay", (c) => {
  const gr = c.linear("g", [0, 0, 0, 1], [[0, "#4a4270", 1], [1, "#2a2545", 1]]);
  return circle(0, 0, 22, `fill="${gr}" stroke="#6a6090" stroke-width="1.5"`) + pathEl("M-12,-10 Q-6,-17 4,-17", stroke(W, 1.5, 0.2, 'stroke-linecap="round"'));
});

// =====================================================================================================================
// Pads — top faces share the Anchor (the front edge's centre); fronts hang from the same point (Anchor top-centre).
// Every pad frame carries PAD_M px round the face; the agreed sizes are the faces (132×62 top, 118×18 front).
// =====================================================================================================================
const PAD_W = 118;
const PAD_H = 62;
const PAD_D = 18;
const PAD_SK = 14;
const PAD_TOP: ReadonlyArray<readonly [number, number]> = [[-PAD_W / 2 + PAD_SK, -PAD_H], [PAD_W / 2 + PAD_SK, -PAD_H], [PAD_W / 2, 0], [-PAD_W / 2, 0]];
const PAD_M = 2; // frame margin round a face, so nothing is chopped by the frame clip
const padTopFrame = (name: string, kind: SpriteKind, draw: (c: Ctx) => string, margin = PAD_M): SpriteDef =>
  def(name, PAD_W + PAD_SK + 2 * margin, PAD_H + 2 * margin, PAD_W / 2 + margin, PAD_H + margin, kind, draw);
const padFrontFrame = (name: string, kind: SpriteKind, draw: (c: Ctx) => string): SpriteDef =>
  def(name, PAD_W + 2 * PAD_M, PAD_D + 2 * PAD_M, PAD_W / 2 + PAD_M, PAD_M, kind, draw);
const chromeFront = (c: Ctx): string => c.linear("cf", [0, 0, 0, 1], [[0, W, 0.45], [0.5, W, 0.7], [1, W, 0.95]]);
const frontRect = (attrs: string): string => rect(-PAD_W / 2, 0, PAD_W, PAD_D, 0, attrs);

const padTopLive = padTopFrame("pad-top-live", "master", () => poly(PAD_TOP, fill(W)));
const padFrontLive = padFrontFrame("pad-front-live", "master", (c) => frontRect(fill(chromeFront(c))));
const padHalo = def("pad-halo", 180, 40, 90, 20, "master", (c) => ellipse(0, 0, 90, 20, fill(c.radial("h", [[0, W, 0.55], [0.5, W, 0.22], [1, W, 0]]))));
/** Gold ring + white inner stroke, "would land here"; the frame adds a 16 px halo margin around the top face (8 px stroke blurred 4). */
const padTopUnder = padTopFrame(
  "pad-top-under",
  "master",
  (c) => g(`${c.blur("h", 4)} opacity="0.8"`, poly(PAD_TOP, stroke(W, 8, 1, 'stroke-linejoin="round"'))) + poly(PAD_TOP, stroke(W, 4, 1, 'stroke-linejoin="round"')) + poly(PAD_TOP, stroke(W, 2, 1, 'stroke-linejoin="round"')),
  16,
);
const padFrontUnder = padFrontFrame("pad-front-under", "master", () => frontRect(fill(W, 0.18)) + rect(-PAD_W / 2 + 1, 1, PAD_W - 2, PAD_D - 2, 0, stroke(W, 2)));
const padTopHit = padTopFrame("pad-top-hit", "master", () => poly(PAD_TOP, fill(W)));
/** Gold glow ellipse spreading on landing. */
const padHitBurst = (i: number): SpriteDef =>
  def(`pad-hit-burst-${i}`, 300, 120, 150, 60, "master", (c) => {
    const rx = [70, 105, 138][i]!;
    const ry = [22, 34, 46][i]!;
    const a = [0.85, 0.6, 0.35][i]!;
    return ellipse(0, 0, rx, ry, `${fill(c.radial("g", [[0, W, a], [0.6, W, a * 0.45], [1, W, 0]]))} ${c.blur("b", [6, 9, 12][i]!)}`);
  });
/** Dashed tier-colour rim only; the dark tile under it is the live top tinted with the Theme's lockTile. */
const padTopLock = padTopFrame("pad-top-lock", "master", (c) => g(c.clip("k", poly(PAD_TOP, "")), poly(PAD_TOP, stroke(W, 3, 0.7, 'stroke-dasharray="6 5"'))));
const padFrontLock = padFrontFrame("pad-front-lock", "master", (c) => frontRect(fill(chromeFront(c))));
/** White radial wash over a live top (Tier reveal). */
const padTopNew = padTopFrame("pad-top-new", "master", (c) => poly(PAD_TOP, fill(c.radial("w", [[0, W, 0.55], [1, W, 0]]))));
const padTopDone = padTopFrame("pad-top-done", "plate", (c) => {
  const gl = c.linear("g", [0, 0, 0, 1], [[0, W, 0.18], [0.3, W, 0], [0.32, K, 0.05], [1, K, 0.28]]);
  return poly(PAD_TOP, fill("#3a3650")) + poly(PAD_TOP, fill(gl)) + g(c.clip("k", poly(PAD_TOP, "")), poly(PAD_TOP, stroke("#8a86a0", 3, 0.6)));
});
const padFrontDone = padFrontFrame("pad-front-done", "plate", (c) => frontRect(fill("#2a2740")) + frontRect(fill(c.linear("g", [0, 0, 0, 1], [[0, K, 0.4], [1, W, 0.08]]))));
/** The chrome white/black overlay for a top face: gloss band, rim-light left, shadow right, white rim. */
const padGloss = padTopFrame("pad-gloss", "overlay", (c) => {
  const top = c.linear("t", [0, 0, 0, 1], [[0, W, 0.95], [0.28, W, 0.25], [0.3, K, 0.12], [1, K, 0.3]]);
  const side = c.linear("s", [0, 0, 1, 0], [[0, W, 0.1], [0.5, W, 0], [1, K, 0.12]]);
  return poly(PAD_TOP, fill(top)) + poly(PAD_TOP, fill(side)) + g(c.clip("k", poly(PAD_TOP, "")), poly(PAD_TOP, stroke(W, 3, 0.85, 'stroke-linejoin="round"')));
});

// =====================================================================================================================
// Light — every beam has its apex at its fixture: the wedge's Anchor is the top centre, brightest there, fading to the floor.
// =====================================================================================================================
const beamWedge = def("beam-wedge", 260, 640, 130, 0, "master", (c) => {
  const gr = c.linear("g", [0, 0, 0, 1], [[0, W, 0.55], [0.35, W, 0.2], [1, W, 0]]);
  return poly([[0, 0], [-114, 640], [114, 640]], `${fill(gr)} ${c.blur("b", 5)}`);
});
const beamCore = def("beam-core", 80, 640, 40, 0, "master", (c) => {
  const gr = c.linear("g", [0, 0, 0, 1], [[0, W, 0.9], [0.3, W, 0.35], [1, W, 0]]);
  return poly([[0, 0], [-26, 640], [26, 640]], `${fill(gr)} ${c.blur("b", 4)}`);
});
/** The soft pool where a sweep lands. */
const beamPool = def("beam-pool", 700, 260, 350, 130, "master", (c) => ellipse(0, 0, 350, 130, fill(c.radial("g", [[0, W, 0.35], [0.5, W, 0.1], [1, W, 0]]))));
/** Soft line halo under a laser stroke; Anchor at the left end, stretched along the line at runtime. */
const laserHalo = def("laser-halo", 512, 24, 0, 12, "master", (c) => {
  const across = c.linear("a", [0, 0, 0, 1], [[0, W, 0], [0.5, W, 0.55], [1, W, 0]]);
  const along = c.linearUser("l", [0, 0, 512, 0], [[0, W, 0], [0.06, W, 1], [0.94, W, 1], [1, W, 0]]);
  return g(c.mask("m", rect(0, -12, 512, 24, 0, fill(along))), rect(0, -12, 512, 24, 0, fill(across)));
});
const SMOKE: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>> = [
  [[-60, 20, 150, 0.3], [70, -30, 120, 0.26], [150, 40, 90, 0.2], [-140, -50, 100, 0.18], [20, 90, 110, 0.16]],
  [[0, 0, 170, 0.28], [-130, 60, 100, 0.22], [120, -70, 110, 0.2], [90, 100, 80, 0.16], [-90, -110, 70, 0.14]],
  [[-40, -60, 130, 0.26], [100, 20, 140, 0.24], [-150, 30, 90, 0.18], [30, 120, 100, 0.18], [160, -90, 70, 0.12]],
];
/** Floor haze puffs, greyscale; tinted lilac at runtime. */
const smoke = (i: number): SpriteDef =>
  def(`smoke-${i}`, 512, 512, 256, 256, "master", (c) =>
    SMOKE[i]!.map(([x, y, r, a], k) => circle(x, y, r, fill(c.radialUser(`p${k}`, x, y, r, [[0, W, a], [0.6, W, a * 0.36], [1, W, 0]])))).join(""),
  );
/** Lit lamp head with a 12 px halo; Anchor at the lamp's bottom centre (where it sits on the tower). */
const towerHead = def("tower-head", 64, 54, 32, 42, "master", (c) =>
  rect(-20, -30, 40, 30, 8, `${fill(W, 0.6)} ${c.blur("h", 5)}`) + rect(-20, -30, 40, 30, 8, fill(W)) + ellipse(0, -15, 12, 8, fill(W)),
);
const towerHeadDark = def("tower-head-dark", 64, 54, 32, 42, "overlay", (c) => {
  const gr = c.linear("g", [0, 0, 0, 1], [[0, "#221d40", 1], [1, "#110e22", 1]]);
  return rect(-20, -30, 40, 30, 8, `fill="${gr}" stroke="#2a2545" stroke-width="1.5"`) + ellipse(0, -15, 12, 8, 'fill="#0b0918" stroke="#2a2545" stroke-width="1"') + pathEl("M-14,-24 Q-6,-28 4,-27", stroke(W, 1.5, 0.12, 'stroke-linecap="round"'));
});
/** The lit floor line's halo (stretched strip); Anchor at the left end, mid-height; the ends fade over the last 3 %. */
const horizonGlow = def("horizon-glow", 512, 16, 0, 8, "master", (c) => {
  const along = c.linearUser("l", [0, 0, 512, 0], [[0, W, 0], [0.03, W, 1], [0.97, W, 1], [1, W, 0]]);
  return g(
    c.mask("m", rect(0, -8, 512, 16, 0, fill(along))),
    rect(0, -8, 512, 16, 0, fill(c.linear("g", [0, 0, 0, 1], [[0, W, 0], [0.5, W, 0.45], [1, W, 0]]))) + rect(0, -0.75, 512, 1.5, 0, fill(W, 0.9)),
  );
});
/** Soft black plate laid under every glow so it survives a bright cam. */
const plate = def("plate", 256, 256, 128, 128, "plate", (c) => circle(0, 0, 128, fill(c.radial("g", [[0, K, 0.55], [0.5, K, 0.25], [1, K, 0]]))));
/** One firework ray, tail at the Anchor (the burst centre), bright head at the far end; 14 are rotated per burst. */
const fireworkRay = def("firework-ray", 104, 20, 2, 10, "master", (c) => {
  const along = c.linearUser("g", [0, 0, 90, 0], [[0, W, 0.05], [0.75, W, 0.65], [1, W, 1]]);
  return pathEl("M0,-0.6 L86,-3.2 L86,3.2 L0,0.6 Z", fill(along)) + circle(88, 0, 5, `${fill(W, 0.8)} ${c.blur("h", 2)}`) + circle(88, 0, 3.2, fill(W));
});
/** Radial gold pulse behind the Acknowledgement line. */
const thanksGlow = def("thanks-glow", 512, 512, 256, 256, "master", (c) => circle(0, 0, 256, fill(c.radial("g", [[0, W, 0.5], [0.4, W, 0.18], [1, W, 0]]))));

// =====================================================================================================================
// Motes and particles
// =====================================================================================================================
const spark = def("spark", 36, 36, 18, 18, "master", (c) => star4(0, 0, 12, `${fill(W, 0.8)} ${c.blur("h", 3)}`) + star4(0, 0, 12, fill(W)));
const chevron = def("chevron", 36, 22, 18, 11, "master", (c) => {
  const d = "M-10,4 L0,-4 L10,4";
  return pathEl(d, `${stroke(W, 4, 0.7, 'stroke-linecap="round" stroke-linejoin="round"')} ${c.blur("h", 2)}`) + pathEl(d, stroke(W, 2.5, 1, 'stroke-linecap="round" stroke-linejoin="round"'));
});
const dot = def("dot", 24, 24, 12, 12, "master", (c) => circle(0, 0, 5, `${fill(W, 0.8)} ${c.blur("h", 2.5)}`) + circle(0, 0, 3, fill(W)));
/** The Contributor Mote's frame: ring + halo over a faint plate that tints with it; the picture is clipped inside at runtime. */
// The baked inner disc is part of this tinted Master (a Master cannot hold a dark colour); the dark backing under a Mote at runtime is the `plate` sprite.
const moteRing = def("mote-ring", 64, 64, 32, 32, "master", (c) =>
  circle(0, 0, 22, `${stroke(W, 5, 0.7)} ${c.blur("h", 3)}`) + circle(0, 0, 20, fill(W, 0.18)) + circle(0, 0, 22, stroke(W, 2.5)),
);
/** The "just arrived" variant: a heavier ring, a brighter halo and a thin burst ring outside. */
const moteRingGold = def("mote-ring-gold", 72, 72, 36, 36, "master", (c) =>
  circle(0, 0, 22, `${stroke(W, 8, 0.85)} ${c.blur("h", 4)}`) + circle(0, 0, 20, fill(W, 0.22)) + circle(0, 0, 22, stroke(W, 3.5)) + circle(0, 0, 28, stroke(W, 1, 0.6)),
);
const moteSpark = (i: number): SpriteDef =>
  def(`mote-spark-${i}`, 16, 16, 8, 8, "master", (c) => {
    const r = [6, 5, 4][i]!;
    const rot = [0, 30, 60][i]!;
    return star4(0, 0, r, `${fill(W, 0.8)} ${c.blur("h", 1.5)}`, rot) + star4(0, 0, r, fill(W), rot);
  });

// =====================================================================================================================
// Windsock — two Masters, so the cone alone rotates: `windsock-pole` is the pole with its cap and the cap's glow,
// Anchor at the foot (the cap's centre sits WINDSOCK_POLE_PX above it); `windsock-cone` is the cone alone, baked
// horizontal pointing +x with its Anchor at the mouth's centre, so at runtime it is drawn at the cap and `rotate` is the
// whole story (no baked droop, no clip). Bands as alpha steps so a single tint works.
// =====================================================================================================================
/** The pole frame's cap centre stands this far above its Anchor (the foot). */
export const WINDSOCK_POLE_PX = 166;
// the cap's glow (r 5, σ 3) reaches ~14 px, so the pole is centred in a 32 px frame with 2 px under the foot
const windsockPole = def("windsock-pole", 32, 182, 16, 180, "master", (c) =>
  rect(-1.5, -WINDSOCK_POLE_PX, 3, WINDSOCK_POLE_PX, 1.5, fill(W, 0.7)) + circle(0, -WINDSOCK_POLE_PX, 3.5, fill(W)) + circle(0, -WINDSOCK_POLE_PX + 2, 5, `${fill(W, 0.6)} ${c.blur("h", 3)}`),
);
// the cone: 36 px long, radius 9 at the mouth → 3.5 at the tail, four bands; the mouth 4 px in from the left edge
const windsockCone = def("windsock-cone", 44, 24, 4, 12, "master", () => {
  const LEN = 36;
  const r = (t: number): number => 9 - 5.5 * t;
  const band = (t0: number, t1: number, a: number): string =>
    poly([[LEN * t0, -r(t0)], [LEN * t1, -r(t1)], [LEN * t1, r(t1)], [LEN * t0, r(t0)]], `${fill(W, a)} stroke="${W}" stroke-opacity="${n(a)}" stroke-width="0.6" stroke-linejoin="round"`);
  return [0, 0.25, 0.5, 0.75].map((t, i) => band(t, t + 0.25, i % 2 ? 0.5 : 1)).join("");
});

// =====================================================================================================================
// Dancers — a body plate (near-black, never tinted) and a white rim Master per pose frame; Anchor at the feet's centre.
// the rim is baked top-left, so a walker drawn with flipX (leftward travel) would carry it top-right. The walk
// frames therefore also get `dancer-walk-{i}-rim-flip`: the same +x-facing figure with its rim on the top-RIGHT edge,
// drawn with the SAME flipX as its body frame, so the light lands top-left after the flip. Baked by mirroring the
// figure's geometry (here, in the script — dancer-figure.ts stays pure), taking the ordinary top-left rim of that
// mirrored figure, and mirroring the result back with scale(-1, 1). Body frames need no flip variant.
// =====================================================================================================================
/** The figure mirrored about the frame's vertical centre line (x → FIGURE_W − x). */
export function mirrorFigure(f: Figure): Figure {
  const mx = (x: number): number => FIGURE_W - x;
  return {
    parts: f.parts.map(([x1, y1, x2, y2, r]) => [mx(x1), y1, mx(x2), y2, r] as const),
    head: [mx(f.head[0]), f.head[1], f.head[2]],
    cup: f.cup ? [mx(f.cup[0]), f.cup[1]] : null,
    nose: f.nose ? [mx(f.nose[0]), f.nose[1], f.nose[2]] : null,
  };
}
const dancerDefs = (): SpriteDef[] => {
  const out: SpriteDef[] = [];
  for (const [pose, frames] of Object.entries(POSES)) {
    frames.forEach((p, i) => {
      const f = figure(p);
      const body = `dancer-${pose}-${i}`;
      const rim = `${body}-rim`;
      const place = `transform="translate(${n(-FIGURE_W / 2)},${n(-FLOOR_Y)})"`;
      out.push(def(body, FIGURE_W, FIGURE_H, FIGURE_W / 2, FLOOR_Y, "plate", () => g(place, figureSvg(f, "body", body))));
      out.push(def(rim, FIGURE_W, FIGURE_H, FIGURE_W / 2, FLOOR_Y, "master", () => g(place, figureSvg(f, "rim", rim))));
      if (pose === "walk") {
        const flip = `${rim}-flip`;
        const unmirror = `transform="translate(${FIGURE_W},0) scale(-1,1)"`;
        out.push(def(flip, FIGURE_W, FIGURE_H, FIGURE_W / 2, FLOOR_Y, "master", () => g(place, g(unmirror, figureSvg(mirrorFigure(f), "rim", flip)))));
      }
    });
  }
  return out;
};

// ---------- the list, in the agreed order
export const SPRITES: SpriteDef[] = [
  ...canopyDefs(),
  risers,
  pilot,
  pilotShadow(0),
  pilotShadow(1),
  pilotShadow(2),
  shipBody,
  shipStripe,
  shipLight,
  shipGloss,
  fins,
  propeller(0),
  propeller(1),
  propeller(2),
  propeller(3),
  gondolaWindow,
  readyBadge,
  readyBadgeDim,
  padTopLive,
  padFrontLive,
  padHalo,
  padTopUnder,
  padFrontUnder,
  padTopHit,
  padHitBurst(0),
  padHitBurst(1),
  padHitBurst(2),
  padTopLock,
  padFrontLock,
  padTopNew,
  padTopDone,
  padFrontDone,
  padGloss,
  beamWedge,
  beamCore,
  beamPool,
  laserHalo,
  smoke(0),
  smoke(1),
  smoke(2),
  towerHead,
  towerHeadDark,
  horizonGlow,
  plate,
  fireworkRay,
  thanksGlow,
  spark,
  chevron,
  dot,
  moteRing,
  moteRingGold,
  moteSpark(0),
  moteSpark(1),
  moteSpark(2),
  windsockPole,
  windsockCone,
  ...dancerDefs(),
];

// ---------- packing: shelves by height, positions on a 4 px grid so 0.75× and 0.5× stay integral, gutter ≥ `gutter`
const up4 = (v: number): number => Math.ceil(v / 4) * 4;

/**
 * Shelf-pack `defs` into as many sheets as it takes for none to pass `maxSide` on a side: a shelf that would run the
 * sheet past the cap starts the next sheet instead. With no cap this is one sheet. Each sheet's frames keep the list's
 * order, not the packer's. Throws for a sprite that cannot fit a sheet on its own.
 */
export function packSheets(defs: SpriteDef[], gutter = GUTTER, maxSide = MAX_SHEET_SIDE): SheetFrames[] {
  const order = [...defs].sort((a, b) => b.h - a.h || b.w - a.w || a.name.localeCompare(b.name));
  const area = defs.reduce((s, d) => s + (d.w + gutter) * (d.h + gutter), 0);
  const maxW = Math.max(...defs.map((d) => d.w));
  const width = Math.min(Math.max(up4(maxW), Math.ceil(Math.sqrt(area * 1.15) / 64) * 64), Math.floor(maxSide / 4) * 4);
  const placed: Array<{ frames: Record<string, Frame>; h: number }> = [];
  let frames: Record<string, Frame> = {};
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const d of order) {
    if (d.w > width || d.h > maxSide) throw new Error(`${d.name} (${d.w}×${d.h}) cannot fit a sheet of ${maxSide} on a side`);
    if (x + d.w > width) {
      const next = up4(y + shelf + gutter);
      if (up4(next + d.h) > maxSide) {
        placed.push({ frames, h: up4(y + shelf) }); // this shelf would run past the cap: it starts the next sheet
        frames = {};
        y = 0;
      } else y = next;
      x = 0;
      shelf = 0;
    }
    frames[d.name] = { x, y, w: d.w, h: d.h, ax: d.ax, ay: d.ay, kind: d.kind };
    x = up4(x + d.w + gutter);
    shelf = Math.max(shelf, d.h);
  }
  placed.push({ frames, h: up4(y + shelf) });
  return placed.map(({ frames: got, h }) => {
    const ordered: Record<string, Frame> = {};
    for (const d of defs) if (got[d.name]) ordered[d.name] = got[d.name]!;
    return { w: up4(width), h, frames: ordered };
  });
}

/** One sheet for `defs`; throws past `MAX_SHEET_SIDE` (the 1x layout is one sheet by design — the 2x zoom is split). */
export function packSheet(defs: SpriteDef[], gutter = GUTTER): SheetFrames {
  const [sheet] = packSheets(defs, gutter, Number.POSITIVE_INFINITY);
  if (!sheet) throw new Error("nothing to pack");
  if (sheet.w > MAX_SHEET_SIDE || sheet.h > MAX_SHEET_SIDE) throw new Error(`sheet ${sheet.w}×${sheet.h} exceeds ${MAX_SHEET_SIDE} — split it`);
  return sheet;
}

/** The 1× frames at a Sheet Scale: rects rounded outward, the Anchor kept on the same point of the drawing. */
export function scaleFrames(one: SheetFrames, z: number): SheetFrames {
  const frames: Record<string, Frame> = {};
  for (const [name, f] of Object.entries(one.frames)) {
    const x = Math.floor(f.x * z);
    const y = Math.floor(f.y * z);
    const w = Math.ceil((f.x + f.w) * z) - x;
    const h = Math.ceil((f.y + f.h) * z) - y;
    frames[name] = { x, y, w, h, ax: round4((f.x + f.ax) * z - x), ay: round4((f.y + f.ay) * z - y), kind: f.kind };
  }
  return { w: Math.ceil(one.w * z), h: Math.ceil(one.h * z), frames };
}
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * The 2x Sheet Scale as several sheets: the sprites are shelf-packed at 1x under half the cap, so each 1x
 * layout rendered at zoom 2 stays at most `MAX_SHEET_SIDE` on a side. These 1x layouts are what `bake` renders at
 * zoom 2; `twoXFrames` is the same in 2x pixels, each frame naming its sheet, which is what the atlas carries.
 */
export function twoXLayouts(defs = SPRITES): SheetFrames[] {
  return packSheets(defs, GUTTER, MAX_SHEET_SIDE / 2);
}

export function twoXFrames(layouts: SheetFrames[], defs = SPRITES): SplitSheetFrames {
  const scaled = layouts.map((l) => scaleFrames(l, 2));
  const frames: Record<string, SplitFrame> = {};
  for (const d of defs) {
    const sheet = scaled.findIndex((s) => d.name in s.frames);
    if (sheet < 0) throw new Error(`${d.name} is not in any sheet`);
    frames[d.name] = { ...scaled[sheet]!.frames[d.name]!, sheet };
  }
  return { sheets: scaled.map((s) => ({ w: s.w, h: s.h })), frames };
}

export function buildAtlas(defs = SPRITES): Atlas {
  const one = packSheet(defs);
  const atlas: Atlas = { id: SHEET_ID, scales: { "2": twoXFrames(twoXLayouts(defs), defs), "1": one, "0.75": scaleFrames(one, 0.75), "0.5": scaleFrames(one, 0.5) } };
  assertFinite(atlas);
  return atlas;
}

/** Every sprite in its packed place, each clipped to its frame, as one SVG the size of the 1× sheet. */
export function compositeSvg(sheet: SheetFrames, defs = SPRITES, p = PALETTE): string {
  const parts: string[] = [];
  for (const d of defs) {
    const f = sheet.frames[d.name];
    if (!f) throw new Error(`${d.name} is not in the sheet`);
    const svg = d.svg(p);
    const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    if (inner === svg) throw new Error(`${d.name}: not an <svg> document`);
    const clip = `${d.name}_frameclip`;
    parts.push(`<clipPath id="${clip}"><rect x="0" y="0" width="${f.w}" height="${f.h}"/></clipPath><g transform="translate(${f.x},${f.y})" clip-path="url(#${clip})">${inner}</g>`);
  }
  return `<svg ${XMLNS} width="${sheet.w}" height="${sheet.h}" viewBox="0 0 ${sheet.w} ${sheet.h}">${parts.join("")}</svg>`;
}

export function renderPng(svg: string, zoom: number): { png: Buffer; width: number; height: number } {
  const r = new Resvg(svg, { fitTo: { mode: "zoom", value: zoom }, background: "rgba(0,0,0,0)" }).render();
  return { png: r.asPng(), width: r.width, height: r.height };
}

/** `chrome-lounge@1x.png`; the 2x scale's several sheets are `chrome-lounge@2x-0.png`, `-1`, … */
export const sheetFile = (z: number, sheet?: number): string => `${SHEET_ID}@${z}x${sheet === undefined ? "" : `-${sheet}`}.png`;
export const ATLAS_FILE = `${SHEET_ID}.json`;

/** Bake the sheets (1x / 0.75x / 0.5x, and the 2x scale as several) and the atlas into `outDir`. With `only`, bake that one sprite at 1× to `only-<name>.png`. */
export function bake(outDir: string, opts: { only?: string } = {}): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  if (opts.only !== undefined) {
    const d = SPRITES.find((s) => s.name === opts.only);
    if (!d) throw new Error(`no sprite named ${opts.only}`);
    const file = path.join(outDir, `only-${d.name}.png`);
    writeFileSync(file, renderPng(d.svg(PALETTE), 1).png);
    return [file];
  }
  const atlas = buildAtlas();
  /** Render a 1x layout at `zoom` to `file`, checking the size against what the atlas says for it. */
  const render = (layout: SheetFrames, zoom: number, expect: { w: number; h: number }, file: string): void => {
    const defs = SPRITES.filter((d) => d.name in layout.frames);
    const { png, width, height } = renderPng(compositeSvg(layout, defs), zoom);
    if (width !== expect.w || height !== expect.h) throw new Error(`${file}: rendered ${width}×${height}, atlas says ${expect.w}×${expect.h}`);
    writeFileSync(path.join(outDir, file), png);
    written.push(path.join(outDir, file));
    console.log(`${file}  ${width}×${height}  ${(png.byteLength / 1024).toFixed(1)} KB  (${defs.length} frames)`);
  };
  twoXLayouts().forEach((layout, i) => render(layout, 2, atlas.scales["2"].sheets[i]!, sheetFile(2, i)));
  for (const z of ["1", "0.75", "0.5"] as const) render(atlas.scales["1"], Number(z), atlas.scales[z], sheetFile(Number(z)));
  const atlasFile = path.join(outDir, ATLAS_FILE);
  writeFileSync(atlasFile, `${JSON.stringify(atlas, null, 1)}\n`);
  written.push(atlasFile);
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = flag("--out") ?? path.join(import.meta.dir, "..", "..", "src", "overlay", "art");
  const only = flag("--only");
  bake(outDir, only === undefined ? {} : { only });
}

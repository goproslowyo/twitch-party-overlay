/**
 * The Atlas: the shape of `src/overlay/art/chrome-lounge.json` and the one size cap the bake keeps. Shared
 * by the bake script and the overlay's loader, so it imports nothing — the loader is bundled for the browser, and a
 * value import from `draw.ts` would drag resvg and node:fs into the page. It lives under src/ because the Docker
 * build copies only src/ (the bake script is not part of the binary).
 */
export type SpriteKind = "master" | "coloured" | "plate" | "overlay";

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  ax: number;
  ay: number;
  kind: SpriteKind;
}

export interface SheetFrames {
  w: number;
  h: number;
  frames: Record<string, Frame>;
}

/** A frame of a Sheet Scale baked as several sheets: `sheet` is the index of the one it is on. */
export interface SplitFrame extends Frame {
  sheet: number;
}

/**
 * A Sheet Scale baked as several sheets: the 2x scale is one 4864 × 4768 PNG when it is one sheet, and Chromium
 * pays several times the JS per `drawImage` off a source that large, whatever the stage's size. Each sheet here is at
 * most `MAX_SHEET_SIDE` on a side; every frame names its sheet.
 */
export interface SplitSheetFrames {
  sheets: Array<{ w: number; h: number }>;
  frames: Record<string, SplitFrame>;
}

export interface Atlas {
  id: "chrome-lounge";
  /** Frames per Sheet Scale, in that sheet's pixels; the 2x scale is several sheets. */
  scales: { "2": SplitSheetFrames; "1": SheetFrames; "0.75": SheetFrames; "0.5": SheetFrames };
}

export const SHEET_ID = "chrome-lounge" as const;
/** No baked sheet is larger than this on a side: past it a `drawImage` off the sheet costs several times the JS. */
export const MAX_SHEET_SIDE = 4096;

/** Throws listing every sheet size or frame whose numbers are not finite (the NaN guard), naming the scale and sheet. */
export function assertFinite(atlas: Atlas): void {
  const bad: string[] = [];
  const size = (label: string, s: { w: number; h: number }): void => {
    if (!Number.isFinite(s.w) || !Number.isFinite(s.h)) bad.push(`sheet@${label} ${s.w}×${s.h}`);
  };
  atlas.scales["2"].sheets.forEach((s, i) => size(`2-${i}`, s));
  for (const z of ["1", "0.75", "0.5"] as const) size(z, atlas.scales[z]);
  for (const [z, sheet] of Object.entries(atlas.scales)) {
    for (const [name, f] of Object.entries(sheet.frames)) {
      if (![f.x, f.y, f.w, f.h, f.ax, f.ay].every(Number.isFinite)) bad.push(`${name}@${z}`);
    }
  }
  if (bad.length) throw new Error(`atlas ${atlas.id} has non-finite numbers: ${bad.join(", ")}`);
}

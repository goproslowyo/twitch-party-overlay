/**
 * The overlay's logical space, and how much detail is drawn inside it.
 *
 * Everything on this page is authored for 1920 × 1080: the rack is 300 px wide, the stinger is 88 px tall, and
 * `sceneLayout`'s margins, gaps and ground line are all 1080p pixels. That is fine while the Browser source is 1080p
 * and wrong the moment it is not — at 3840 × 2160 the same 300 px rack covers half the share of the frame it should,
 * and the text reads half-size.
 *
 * So the logical space is pinned: 1080 tall, and as wide as the source's shape requires. The DOM layer is laid out in
 * it and one CSS zoom scales it to fill; the scene draws in it and the canvas is stretched to fill. Neither has to
 * know how big the source really is.
 *
 * `renderScale` then says how many real pixels back each logical one. 1× draws 1920 × 1080 and lets the browser scale
 * it up, which costs the same at 4K as it does at 1080p. 2× draws every pixel of a 4K source, which is four times the
 * fill and is what Auto Quality will answer by thinning the show if the PC cannot keep up.
 */
import type { RenderScale } from "../config/schema.ts";

/** The height every pixel in the overlay is written against. */
export const LOGICAL_HEIGHT = 1080;

export const SUPERSAMPLE: Readonly<Record<RenderScale, number>> = Object.freeze({ "1x": 1, "1.5x": 1.5, "2x": 2 });

export interface Viewport {
  /** The space the DOM and the scene work in: 1080 tall, the source's aspect wide. */
  logical: { width: number; height: number };
  /** The stage canvas's real pixels: `logical × supersample`. */
  buffer: { width: number; height: number };
  /** What one logical pixel is worth on screen — the CSS zoom the DOM layer wears. */
  zoom: number;
  supersample: number;
}

/**
 * For a Browser source of `width` × `height`. A source at or under 1080 tall is its own logical space, so nothing is
 * blown up to fit a number it never asked for; taller sources scale down to 1080. Every side stays at least 1, so a
 * collapsed or hidden source cannot produce a zero-sized canvas and throw on the WebGL layer.
 */
export function viewportFor(setting: RenderScale, width: number, height: number): Viewport {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const zoom = h > LOGICAL_HEIGHT ? h / LOGICAL_HEIGHT : 1;
  const logical = { width: Math.max(1, Math.round(w / zoom)), height: Math.max(1, Math.round(h / zoom)) };
  const supersample = SUPERSAMPLE[setting];
  return {
    logical,
    buffer: { width: Math.max(1, Math.round(logical.width * supersample)), height: Math.max(1, Math.round(logical.height * supersample)) },
    zoom,
    supersample,
  };
}

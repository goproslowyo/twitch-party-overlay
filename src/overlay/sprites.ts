/**
 * The Sprite Sheet loader: the Sheet Scales of a Theme Sheet and its Atlas are imported here — Bun's HTML
 * bundle hashes the PNGs into routes the overlay page serves itself — preloaded at boot, and looked up by frame name.
 * The 2x Sheet Scale is several sheets, one image per sheet the Atlas names, each frame drawn from its own.
 * White Masters are tinted once, lazily per colour, through `source-in` on an offscreen canvas; the scene only ever
 * calls `draw`, which puts a frame's Anchor on (x, y) at 1× world size whatever Sheet Scale the frame came from.
 * Never imported by `scene/` for loading — the scene receives a `SpriteSet`.
 */
import { assertFinite, type Atlas, type Frame, type SplitFrame } from "./atlas.ts";
import type { SheetId } from "../config/schema.ts";
import atlasJson from "./art/chrome-lounge.json";
import sheetHalf from "./art/chrome-lounge@0.5x.png";
import sheetThreeQuarters from "./art/chrome-lounge@0.75x.png";
import sheetOne from "./art/chrome-lounge@1x.png";
import sheetTwo0 from "./art/chrome-lounge@2x-0.png";
import sheetTwo1 from "./art/chrome-lounge@2x-1.png";

export { assertFinite };
export type { Atlas, Frame, SheetFrames, SplitFrame, SplitSheetFrames, SpriteKind } from "./atlas.ts";

/**
 * The Sheet Scales baked by `just sprites`. 1 / 0.75 / 0.5 are the Quality Levels' own; 2 exists for a 4K
 * Browser source at Detail 2x, where a frame off the 1x sheet would be drawn at twice its size and go soft. It is four
 * times the pixels of the 1x sheet, so it is fetched only when Detail 2x asks for it — and used only then. Drawing off
 * a 23-megapixel image costs Chromium several times the JS per `drawImage` (measured 2026-09-16: a full floor's frame
 * went from 1.4 ms to 5.8–9.6 ms on the dev machine with the one 2x sheet as the source, the stage's own size costing
 * nothing), so Detail 1.5x draws the 1x sheet scaled up rather than the 2x sheet scaled down, and now the 2x
 * scale is baked as several sheets each at most `MAX_SHEET_SIDE` on a side, every frame drawn from its own.
 */
export type SheetScale = 2 | 1 | 0.75 | 0.5;
/** Largest first — `pickSheet` walks it. */
export const SHEET_SCALES: readonly SheetScale[] = [2, 1, 0.75, 0.5];

export interface Sprite {
  image: CanvasImageSource;
  /** In `image`'s pixels; a tinted Master's frame starts at (0, 0) of its own canvas. */
  frame: Frame;
  scale: SheetScale;
}

export interface DrawOpts {
  /** Tint for a Master (ignored for anything else). */
  colour?: string;
  /** Draw scale relative to 1× world size (the frame's own Sheet Scale is compensated for). */
  k?: number;
  alpha?: number;
  flipX?: boolean;
  /** Radians, about the Anchor. */
  rotate?: number;
}

/** One thing per sheet, by Sheet Scale: the 2x scale is a list, one per sheet of the Atlas, in the Atlas's order. */
export interface PerSheetScale<T> {
  2: readonly T[];
  1: T;
  0.75: T;
  0.5: T;
}
/** The sheet images in hand. */
export type SheetImages = Partial<PerSheetScale<CanvasImageSource>>;
/** The bundled urls (`chrome-lounge@2x-0.png`, `-1`, … for the 2x scale). */
export type SheetUrls = PerSheetScale<string>;

export interface SpriteSet {
  id: SheetId;
  /** A frame at the given Sheet Scale; Masters come back tinted with `colour` (cached per colour); throws for an unknown name. */
  get(name: string, scale: SheetScale, colour?: string): Sprite;
  has(name: string): boolean;
  names(): string[];
  /** drawImage with the Anchor on (x, y); `k` = draw scale relative to 1× (a 0.5× frame is drawn twice its pixels). */
  draw(ctx: CanvasRenderingContext2D, name: string, scale: SheetScale, x: number, y: number, opts?: DrawOpts): void;
  /**
   * How many real pixels back one logical pixel (`renderScale`). Frames are then taken from a sheet big enough to be
   * drawn at that size without being scaled up, capped at the 1x sheet unless the detail is 2 (see `SheetScale`).
   * Fetches the 2x sheets the first time Detail 2x asks; drawing keeps working off the sheets already in hand until
   * they all arrive.
   */
  setDetail(supersample: number): void;
}

export const SHEETS: Record<SheetId, { urls: SheetUrls; atlas: Atlas }> = {
  "chrome-lounge": { urls: { 2: [sheetTwo0, sheetTwo1], 1: sheetOne, 0.75: sheetThreeQuarters, 0.5: sheetHalf }, atlas: atlasJson as Atlas },
};

const SCALE_KEYS: Record<SheetScale, keyof Atlas["scales"]> = { 2: "2", 1: "1", 0.75: "0.75", 0.5: "0.5" };

/**
 * The sheet to take a frame from when it will be drawn at `want` times its 1× size: the smallest one at or above that,
 * so a frame is never scaled up, and the largest loaded sheet when nothing reaches it (the 2x sheet still arriving).
 */
/**
 * How long a sheet gets to decode before the load is called a failure. A browser that never settles `decode()` (a
 * suspended or throttled tab will do this) would otherwise leave the fetch flag raised for the life of the page, and
 * every later attempt to upgrade the sheet would be skipped in silence.
 */
export const SHEET_DECODE_TIMEOUT_MS = 20_000;
/**
 * How many times the optional 2x sheets are fetched before the overlay settles for the sheets it has. They are the
 * largest assets on the page, and `setDetail` is called on every resize and every skin snapshot, so an upgrade that
 * keeps missing must not turn into a download on every one of them.
 */
export const TWO_X_ATTEMPTS = 3;

/**
 * Load one sheet. Resolves on `load`, NOT on `decode()`: a browser that has throttled the page (a hidden OBS Browser
 * source, a background tab) will happily finish the download and then never settle `decode()`, which stalled the 2x
 * sheet forever and left Detail 2x paying for a 4K canvas it had no sharper art to fill. Decoding is still kicked off
 * as a warm-up so the first draw does not hitch, but nothing waits on it.
 */
export function loadImage(
  url: string,
  make: () => HTMLImageElement = () => new Image(),
  ms = SHEET_DECODE_TIMEOUT_MS,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
  clearTimer: (handle: never) => void = clearTimeout as unknown as (handle: never) => void,
): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = make();
    let handle: unknown;
    const done = (fn: () => void): void => {
      if (handle !== undefined) clearTimer(handle as never);
      fn();
    };
    img.onload = () => done(() => {
      void (img.decode?.() as Promise<unknown> | undefined)?.catch(() => {}); // warm-up only; never awaited
      resolve(img);
    });
    img.onerror = () => done(() => reject(new Error(`sprite sheet failed to load: ${url}`)));
    handle = setTimer(() => {
      // Abandon it properly. Left attached, the download finishes anyway and the warm-up decodes a bitmap nothing can
      // draw — for a 2x sheet that is up to ~67 MB, and up to three attempts can be in flight at once.
      img.onload = null;
      img.onerror = null;
      img.src = "";
      reject(new Error(`sprite sheet did not load within ${ms}ms: ${url}`));
    }, ms);
    img.src = url;
  });
}

export function pickSheet(want: number, loaded: readonly SheetScale[]): SheetScale {
  const up = [...loaded].sort((a, b) => a - b);
  if (up.length === 0) return 1;
  return up.find((s) => s >= want - 1e-6) ?? up[up.length - 1]!;
}

/** Tint pass: a white Master → `colour` through an offscreen canvas, `source-in`. Exposed for tests. */
export function tintFrame(image: CanvasImageSource, frame: Frame, colour: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  const canvas = make();
  canvas.width = frame.w;
  canvas.height = frame.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for the tint canvas");
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, frame.w, frame.h);
  return canvas;
}

/** A SpriteSet over already-decoded sheet images; `makeCanvas` supplies the offscreen canvases for tints. */
export function makeSpriteSet(
  id: SheetId,
  images: SheetImages,
  atlas: Atlas,
  makeCanvas: () => HTMLCanvasElement,
  fetchTwoX?: () => Promise<readonly CanvasImageSource[]>,
): SpriteSet {
  assertFinite(atlas);
  const tints = new Map<string, Sprite>();
  let detail = 1;
  let fetching = false;
  let attempts = 0;
  const loaded = (): SheetScale[] => SHEET_SCALES.filter((z) => images[z] !== undefined);
  /**
   * `draw` runs for every sprite of every frame — Level 5 is 400 particles plus the dancers, motes and towers — so the
   * sheet choice is worked out once per (quality factor, detail, sheets in hand) and kept. Cleared whenever any of
   * those three change, which is a handful of times a stream rather than twenty thousand times a second.
   */
  let sheetChoice = new Map<SheetScale, SheetScale>();
  /** The 2x sheet is Detail 2x's alone: below that, the 1x sheet is the most a frame is taken from (`SheetScale`). */
  const twoXWanted = (): boolean => detail >= 2;
  const sheetFor = (scale: SheetScale): SheetScale => {
    let chosen = sheetChoice.get(scale);
    if (chosen === undefined) {
      chosen = pickSheet(twoXWanted() ? scale * detail : Math.min(1, scale * detail), loaded());
      sheetChoice.set(scale, chosen);
    }
    return chosen;
  };
  const names = Object.keys(atlas.scales["1"].frames);
  /** The image a frame is drawn from: at 2x the frame's own sheet, otherwise the Sheet Scale's one. */
  const imageFor = (name: string, scale: SheetScale, frame: Frame | SplitFrame): CanvasImageSource => {
    const image = scale === 2 ? ("sheet" in frame ? images[2]?.[frame.sheet] : undefined) : images[scale];
    if (image === undefined) throw new Error(`no ${scale}x sheet in hand for "${name}" of ${id}`);
    return image;
  };
  const get = (name: string, scale: SheetScale, colour?: string): Sprite => {
    const frame = atlas.scales[SCALE_KEYS[scale]].frames[name];
    if (!frame) throw new Error(`no sprite "${name}" in sheet ${id}`);
    const image = imageFor(name, scale, frame);
    if (colour === undefined || frame.kind !== "master") return { image, frame, scale };
    const key = `${name}\n${scale}\n${colour}`;
    let tinted = tints.get(key);
    if (!tinted) {
      tinted = {
        image: tintFrame(image, frame, colour, makeCanvas),
        frame: { x: 0, y: 0, w: frame.w, h: frame.h, ax: frame.ax, ay: frame.ay, kind: frame.kind },
        scale,
      };
      tints.set(key, tinted);
    }
    return tinted;
  };
  return {
    id,
    get,
    has: (name) => Object.hasOwn(atlas.scales["1"].frames, name),
    names: () => [...names],
    setDetail(supersample) {
      const next = supersample > 0 ? supersample : 1;
      if (next !== detail) sheetChoice = new Map();
      detail = next;
      if (!twoXWanted() || images[2] !== undefined || fetching || attempts >= TWO_X_ATTEMPTS || fetchTwoX === undefined) return;
      fetching = true;
      attempts += 1;
      void fetchTwoX().then(
        (list) => {
          fetching = false;
          const want = atlas.scales["2"].sheets.length;
          if (list.length !== want) {
            console.warn(`overlay: sheet ${id} 2x arrived as ${list.length} images, the atlas names ${want}; keeping the sheets in hand`);
            return; // a frame would name a sheet that is not there; the next call retries, until the cap
          }
          images[2] = list; // from here the guard above short-circuits on this alone
          sheetChoice = new Map(); // new sheets in hand change what every scale should be taken from
          console.info(`overlay: sheet ${id} upgraded to 2x (${want} sheets)`); // the one visible sign Detail 2x actually took
          tints.clear(); // a tint cached off a smaller sheet would keep being handed back
        },
        () => {
          // Not fatal: the smaller sheets still draw. The next call retries, until the cap.
          fetching = false;
        },
      );
    },
    draw(ctx, name, scale, x, y, opts) {
      const chosen = sheetFor(scale); // cached: this runs for every sprite of every frame
      const s = get(name, chosen, opts?.colour);
      const f = s.frame;
      const k = (opts?.k ?? 1) / chosen;
      const alpha = opts?.alpha ?? 1;
      const transformed = opts?.flipX === true || (opts?.rotate !== undefined && opts.rotate !== 0);
      const prevAlpha = ctx.globalAlpha;
      if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;
      if (transformed) {
        ctx.save();
        ctx.translate(x, y);
        if (opts?.rotate) ctx.rotate(opts.rotate);
        if (opts?.flipX) ctx.scale(-1, 1);
        ctx.drawImage(s.image, f.x, f.y, f.w, f.h, -f.ax * k, -f.ay * k, f.w * k, f.h * k);
        ctx.restore();
      } else {
        ctx.drawImage(s.image, f.x, f.y, f.w, f.h, x - f.ax * k, y - f.ay * k, f.w * k, f.h * k);
      }
      if (alpha !== 1) ctx.globalAlpha = prevAlpha;
    },
  };
}

/**
 * Preload the three Quality Level sheets; resolves once every image loaded; rejects with the failing URL. The 2x
 * sheets are NOT fetched here — together they are four times the pixels of the 1x one and most sources never need
 * them — but the set is handed the loader so `setDetail` can pull them in the moment Detail 2x asks. Never called
 * from scene/.
 */
export async function loadSpriteSet(id: SheetId, makeCanvas: () => HTMLCanvasElement = () => document.createElement("canvas")): Promise<SpriteSet> {
  const { urls, atlas } = SHEETS[id];
  assertFinite(atlas);
  if (urls[2].length !== atlas.scales["2"].sheets.length) throw new Error(`sheet ${id}: ${urls[2].length} 2x images bundled, the atlas names ${atlas.scales["2"].sheets.length}`);
  const load = (url: string): Promise<HTMLImageElement> => loadImage(url);
  const [one, threeQuarters, half] = await Promise.all([load(urls[1]), load(urls[0.75]), load(urls[0.5])]);
  return makeSpriteSet(id, { 1: one, 0.75: threeQuarters, 0.5: half }, atlas, makeCanvas, () => Promise.all(urls[2].map(load)));
}

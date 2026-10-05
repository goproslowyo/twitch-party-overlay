/**
 * The client's Avatar Picture cache: decoded images by URL for the canvas — the Contributor Motes draw a picture
 * through the Mote Ring's clip, so a mote asks `get(url)` every frame and draws the Avatar Glyph while it gets
 * null. Loads start on the first miss (handlers first, then `src`, so a browser-cached image is not missed), a failed
 * URL is remembered for the session and never requested again, and past `max` entries the least recently used image
 * goes. The CDN sends `access-control-allow-origin: *` but nothing here reads pixels back, so no `crossOrigin` is set.
 * No DOM is touched at import time (the default factory runs on the first miss), so `bun test` can load this module.
 */

export const IMAGE_CACHE_MAX = 300;

interface Slot {
  img: HTMLImageElement;
  ready: boolean;
}

export class ImageCache {
  readonly max: number;
  readonly #make: () => HTMLImageElement;
  /** Insertion order is recency: a ready hit re-inserts, eviction takes the first key. */
  readonly #slots = new Map<string, Slot>();
  readonly #failed = new Set<string>();

  constructor(max: number = IMAGE_CACHE_MAX, make: () => HTMLImageElement = () => new Image()) {
    this.max = max;
    this.#make = make;
  }

  get size(): number {
    return this.#slots.size;
  }

  /** URLs that failed this session (never retried). */
  get failed(): number {
    return this.#failed.size;
  }

  /** The decoded image for `url`, or null: no URL, still loading (a load starts on the first ask), or failed. */
  get(url: string | null): CanvasImageSource | null {
    if (url === null || url === "" || this.#failed.has(url)) return null;
    const slot = this.#slots.get(url);
    if (slot !== undefined) {
      if (!slot.ready) return null;
      this.#slots.delete(url); // most recently used
      this.#slots.set(url, slot);
      return slot.img;
    }
    const img = this.#make();
    const fresh: Slot = { img, ready: false };
    img.onload = () => {
      fresh.ready = true;
    };
    img.onerror = () => {
      this.#failed.add(url);
      if (this.#slots.get(url) === fresh) this.#slots.delete(url);
    };
    img.decoding = "async";
    img.src = url;
    this.#slots.set(url, fresh);
    while (this.#slots.size > this.max) {
      const oldest = this.#slots.keys().next().value;
      if (oldest === undefined) break;
      this.#slots.delete(oldest);
    }
    return null;
  }
}

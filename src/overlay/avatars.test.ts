import { describe, expect, test } from "bun:test";
import { IMAGE_CACHE_MAX, ImageCache } from "./avatars.ts";

/** The least an HTMLImageElement needs here: src, decoding, and the onload / onerror the cache sets. */
function fakeImage() {
  const img = { src: "", decoding: "", onload: null as null | (() => void), onerror: null as null | (() => void) };
  return img;
}
type FakeImage = ReturnType<typeof fakeImage>;

function mk(max?: number) {
  const made: FakeImage[] = [];
  const cache = new ImageCache(max, () => {
    const img = fakeImage();
    made.push(img);
    return img as unknown as HTMLImageElement;
  });
  const load = (url: string) => made.find((i) => i.src === url)!.onload!();
  const fail = (url: string) => made.find((i) => i.src === url)!.onerror!();
  return { cache, made, load, fail };
}
const url = (n: number) => `https://static-cdn.jtvnw.net/jtv_user_pictures/${n}-profile_image-150x150.png`;

describe("ImageCache — decoded pictures by URL for the canvas", () => {
  test("get: null for null; starts one load per URL and answers null until onload, then the image; the same URL is never requested twice", () => {
    const { cache, made, load } = mk();
    expect(cache.get(null)).toBeNull();
    expect(made).toHaveLength(0);

    expect(cache.get(url(1))).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]!.src).toBe(url(1));
    expect(made[0]!.decoding).toBe("async");
    expect(cache.get(url(1))).toBeNull(); // still loading: no second request
    expect(made).toHaveLength(1);

    load(url(1));
    expect(cache.get(url(1))).toBe(made[0] as unknown as CanvasImageSource);
    expect(cache.get(url(1))).toBe(made[0] as unknown as CanvasImageSource);
    expect(made).toHaveLength(1);
  });

  test("handlers are attached before src is set, so a synchronously-complete (cached) image is not missed", () => {
    const order: string[] = [];
    const cache = new ImageCache(10, () => {
      const img = fakeImage();
      return new Proxy(img, {
        set(t, k, v) {
          order.push(String(k));
          (t as Record<string, unknown>)[k as string] = v;
          return true;
        },
      }) as unknown as HTMLImageElement;
    });
    cache.get(url(1));
    expect(order.indexOf("onload")).toBeLessThan(order.indexOf("src"));
    expect(order.indexOf("onerror")).toBeLessThan(order.indexOf("src"));
  });

  test("a failed URL: null, and never requested again this session — even after many other pictures pass through", () => {
    const { cache, made, fail } = mk(3);
    expect(cache.get(url(1))).toBeNull();
    fail(url(1));
    expect(cache.get(url(1))).toBeNull();
    expect(made).toHaveLength(1);
    for (let i = 2; i <= 10; i++) cache.get(url(i)); // churn well past the cap
    expect(cache.get(url(1))).toBeNull();
    expect(made.filter((i) => i.src === url(1))).toHaveLength(1);
    expect(cache.failed).toBe(1);
  });

  test("past the cap (300 by default) the least recently used picture is dropped and would load again if asked", () => {
    expect(IMAGE_CACHE_MAX).toBe(300);
    expect(new ImageCache(undefined, () => fakeImage() as unknown as HTMLImageElement).max).toBe(300);

    const { cache, made, load } = mk(2);
    cache.get(url(1));
    cache.get(url(2));
    load(url(1));
    load(url(2));
    expect(cache.size).toBe(2);
    cache.get(url(1)); // touched: url 2 is now the least recent
    cache.get(url(3));
    expect(cache.size).toBe(2);
    expect(cache.get(url(1))).toBe(made[0] as unknown as CanvasImageSource);
    expect(made).toHaveLength(3);
    expect(cache.get(url(2))).toBeNull(); // evicted: a fresh load starts
    expect(made).toHaveLength(4);
    expect(made[3]!.src).toBe(url(2));
  });

  test("the module touches no DOM at import time (bun test loads it); the default factory is only called on the first miss", () => {
    const cache = new ImageCache(); // default factory: `new Image()` — not called yet
    expect(cache.size).toBe(0);
    expect(cache.get(null)).toBeNull();
  });
});

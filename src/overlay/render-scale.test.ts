import { describe, expect, test } from "bun:test";
import { LOGICAL_HEIGHT, viewportFor } from "./render-scale.ts";

describe("viewportFor", () => {
  test("a 1080p source is its own logical space and wears no zoom: the size everything on the page was drawn for", () => {
    const v = viewportFor("1x", 1920, 1080);
    expect(v.logical).toEqual({ width: 1920, height: 1080 });
    expect(v.zoom).toBe(1);
    expect(v.buffer).toEqual({ width: 1920, height: 1080 });
  });

  test("a 4K source still lays out at 1920 x 1080 and zooms 2x, so the rack keeps its share of the frame", () => {
    const v = viewportFor("1x", 3840, 2160);
    expect(v.logical).toEqual({ width: 1920, height: 1080 });
    expect(v.zoom).toBe(2);
  });

  test("renderScale changes only how many real pixels back the logical ones, never the layout", () => {
    for (const [setting, factor] of [["1x", 1], ["1.5x", 1.5], ["2x", 2]] as const) {
      const v = viewportFor(setting, 3840, 2160);
      expect(v.logical).toEqual({ width: 1920, height: 1080 }); // identical at every setting
      expect(v.supersample).toBe(factor);
      expect(v.buffer).toEqual({ width: 1920 * factor, height: 1080 * factor });
    }
  });

  test("2x on a 4K source draws every real pixel of it — the sharpest the source can be", () => {
    expect(viewportFor("2x", 3840, 2160).buffer).toEqual({ width: 3840, height: 2160 });
  });

  test("a source under 1080 tall is left at its own size, never blown up to a height it did not ask for", () => {
    const v = viewportFor("1x", 1280, 720);
    expect(v.logical).toEqual({ width: 1280, height: 720 });
    expect(v.zoom).toBe(1);
  });

  test("an unusual shape keeps its aspect: the logical box is 1080 tall and as wide as the source needs", () => {
    expect(viewportFor("1x", 5120, 2160).logical).toEqual({ width: 2560, height: LOGICAL_HEIGHT });
    expect(viewportFor("1x", 2160, 3840).logical).toEqual({ width: 608, height: LOGICAL_HEIGHT });
  });

  test("a collapsed or hidden source never yields a zero side, which would throw on the WebGL layer", () => {
    for (const s of ["1x", "1.5x", "2x"] as const) {
      const v = viewportFor(s, 0, 0);
      for (const n of [v.logical.width, v.logical.height, v.buffer.width, v.buffer.height]) expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  test("fractional sizes a browser can report come back as whole pixels on both boxes", () => {
    const v = viewportFor("1.5x", 3840.7, 2160.2);
    for (const n of [v.logical.width, v.logical.height, v.buffer.width, v.buffer.height]) expect(Number.isInteger(n)).toBe(true);
  });
});

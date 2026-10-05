/**
 * The WebGL light layer, tested against a hand-written fake `gl` (Bun has no WebGL): detection by the unmasked renderer
 * string, program setup, what each Quality Level draws, the upload sizes, and the shader sources checked by string.
 */
import { describe, expect, test } from "bun:test";
import type { Level } from "../quality.ts";
import { BLOOM_LEVEL, LightLayer, MAX_PARTICLES, PARTICLE_CAP, PARTICLE_LEVEL, PARTICLE_STRIDE, SEGMENT_HALO_PX, POINT_HALO_SCALE, INSTANCE_STRIDE, SOFTWARE_RENDERER, detectWebGL, type LightSources } from "./layer.ts";
import { BLOOM_FRAG, BLOOM_VERT, PARTICLE_FRAG, PARTICLE_VERT } from "./shaders.ts";

const IRIS = "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
const SWIFTSHADER = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

/** The GL constants the layer uses, with their real values, so a name the fake does not know fails loudly. */
const CONSTANTS: Record<string, number> = {
  POINTS: 0,
  TRIANGLE_STRIP: 5,
  ONE: 1,
  ZERO: 0,
  COLOR_BUFFER_BIT: 0x4000,
  BLEND: 0x0be2,
  DEPTH_TEST: 0x0b71,
  CULL_FACE: 0x0b44,
  FLOAT: 0x1406,
  RENDERER: 0x1f01,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  UNMASKED_RENDERER_WEBGL: 0x9246,
};

/** `snapshot` is the upload's contents at the call — `bufferData` copies, the way GL does, so a reused staging array is fine. */
type Call = { name: string; args: unknown[]; snapshot?: Float32Array };

interface Fake {
  gl: WebGL2RenderingContext;
  calls: Call[];
  /** Calls by name since the last `mark()`. */
  since(name: string): Call[];
  mark(): void;
  /** The last `bufferData` byte lengths since the mark, in order. */
  uploads(): number[];
}

interface FakeOptions {
  renderer?: string;
  /** No WEBGL_debug_renderer_info extension at all; `RENDERER` answers instead. */
  noDebugExt?: boolean;
  compileOk?: (source: string) => boolean;
  linkOk?: boolean;
  /** `createProgram` answers null (a lost context, an exhausted driver). */
  programOk?: boolean;
  /** The drawing buffer's size before any `resize`. */
  canvas?: { width: number; height: number };
  loseContext?: () => void;
  restoreContext?: () => void;
}

/** A recording WebGL2 context: constants are real, every method is logged, queries answer plausibly. */
function fakeGl(options: FakeOptions = {}): Fake {
  const calls: Call[] = [];
  let mark = 0;
  const shaders = new Map<object, { type: number; source: string }>();
  let nextAttrib = 0;
  const attribs = new Map<string, number>();
  const target: Record<string, unknown> = {
    canvas: options.canvas ?? { width: 0, height: 0 },
    getExtension(name: string) {
      calls.push({ name: "getExtension", args: [name] });
      if (name === "WEBGL_debug_renderer_info") return options.noDebugExt ? null : { UNMASKED_RENDERER_WEBGL: CONSTANTS.UNMASKED_RENDERER_WEBGL };
      if (name === "WEBGL_lose_context") return options.loseContext || options.restoreContext ? { loseContext: options.loseContext ?? (() => {}), restoreContext: options.restoreContext ?? (() => {}) } : null;
      return null;
    },
    getParameter(pname: number) {
      calls.push({ name: "getParameter", args: [pname] });
      if (pname === CONSTANTS.UNMASKED_RENDERER_WEBGL || pname === CONSTANTS.RENDERER) return options.renderer ?? IRIS;
      return 0;
    },
    createShader(type: number) {
      calls.push({ name: "createShader", args: [type] });
      const shader = { type };
      shaders.set(shader, { type, source: "" });
      return shader;
    },
    shaderSource(shader: object, source: string) {
      calls.push({ name: "shaderSource", args: [shader, source] });
      shaders.get(shader)!.source = source;
    },
    getShaderParameter(shader: object, pname: number) {
      calls.push({ name: "getShaderParameter", args: [shader, pname] });
      return options.compileOk ? options.compileOk(shaders.get(shader)!.source) : true;
    },
    getShaderInfoLog(shader: object) {
      return `ERROR: 0:7: fake shader failure in ${shaders.get(shader)!.type === CONSTANTS.VERTEX_SHADER ? "vertex" : "fragment"} stage`;
    },
    createProgram() {
      calls.push({ name: "createProgram", args: [] });
      return options.programOk === false ? null : { program: true };
    },
    getProgramParameter(program: object, pname: number) {
      calls.push({ name: "getProgramParameter", args: [program, pname] });
      return options.linkOk ?? true;
    },
    getProgramInfoLog() {
      return "fake link failure: varyings do not match";
    },
    getAttribLocation(program: object, name: string) {
      calls.push({ name: "getAttribLocation", args: [program, name] });
      if (!attribs.has(name)) attribs.set(name, nextAttrib++);
      return attribs.get(name)!;
    },
    getUniformLocation(program: object, name: string) {
      calls.push({ name: "getUniformLocation", args: [program, name] });
      return { uniform: name };
    },
    createBuffer() {
      calls.push({ name: "createBuffer", args: [] });
      return { buffer: calls.length };
    },
    createVertexArray() {
      calls.push({ name: "createVertexArray", args: [] });
      return { vao: calls.length };
    },
    bufferData(targetEnum: number, data: ArrayBufferView | number, usage: number) {
      calls.push({ name: "bufferData", args: [targetEnum, data, usage], snapshot: data instanceof Float32Array ? Float32Array.from(data) : undefined });
    },
  };
  const gl = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key in CONSTANTS) return CONSTANTS[key];
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`fake gl has no constant ${key}`);
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    since: (name) => calls.slice(mark).filter((c) => c.name === name),
    mark: () => {
      mark = calls.length;
    },
    uploads() {
      return calls
        .slice(mark)
        .filter((c) => c.name === "bufferData")
        .map((c) => {
          const data = c.args[1];
          return typeof data === "number" ? data : (data as ArrayBufferView).byteLength;
        });
    },
  };
}

function fakeCanvas(fake: Fake | null): { canvas: HTMLCanvasElement; contexts: string[] } {
  const contexts: string[] = [];
  const canvas = {
    getContext(kind: string) {
      contexts.push(kind);
      return kind === "webgl2" && fake ? fake.gl : null;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, contexts };
}

function sources(over: Partial<LightSources> = {}): LightSources {
  return {
    segments: [
      { x0: 100, y0: 200, x1: 300, y1: 400, colour: [1, 0.2, 0.9], strength: 1 },
      { x0: 120, y0: 200, x1: 320, y1: 420, colour: [0.2, 1, 0.9], strength: 0.5 },
    ],
    points: [
      { x: 50, y: 60, r: 6, colour: [1, 1, 0.5], strength: 0.8 },
      { x: 70, y: 60, r: 3, colour: [0.5, 1, 1], strength: 0.4 },
      { x: 90, y: 60, r: 9, colour: [1, 0.5, 1], strength: 1 },
    ],
    particles: particles(10),
    ...over,
  };
}

function particles(n: number): Float32Array {
  const out = new Float32Array(n * PARTICLE_STRIDE);
  for (let i = 0; i < n; i++) out.set([i, i * 2, 3, 1, 0.5, 0.25, 0.75], i * PARTICLE_STRIDE);
  return out;
}

const drawCalls = (fake: Fake) => [...fake.since("drawArrays"), ...fake.since("drawArraysInstanced")];

describe("detectWebGL", () => {
  test('"off" never asks the canvas for a context', () => {
    const { canvas, contexts } = fakeCanvas(fakeGl());
    expect(detectWebGL(canvas, "off")).toBeNull();
    expect(contexts).toEqual([]);
  });

  test("a real GPU renderer string (a stream PC's Iris Xe under ANGLE D3D11) yields the context", () => {
    const fake = fakeGl({ renderer: IRIS });
    const { canvas, contexts } = fakeCanvas(fake);
    expect(detectWebGL(canvas, "auto")).toBe(fake.gl);
    expect(contexts).toEqual(["webgl2"]);
    expect(fake.since("getParameter").map((c) => c.args[0])).toEqual([CONSTANTS.UNMASKED_RENDERER_WEBGL]);
  });

  test.each([SWIFTSHADER, "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", "Direct3D11 WARP", "llvmpipe (LLVM 15.0.7, 256 bits)", "Google SwiftShader"])(
    "a software renderer is not a real GPU: %s",
    (renderer) => {
      let lost = 0;
      const fake = fakeGl({ renderer, loseContext: () => lost++ });
      expect(detectWebGL(fakeCanvas(fake).canvas, "auto")).toBeNull();
      // the rejected context is NEVER lost — `WEBGL_lose_context.loseContext()` on the page makes Chromium's
      // compositor stop presenting the 2-D stage canvas (seen in a browser check); one idle context is the lesser cost
      expect(lost).toBe(0);
      expect(fake.calls.filter((c) => c.name === "getExtension" && c.args[0] === "WEBGL_lose_context")).toHaveLength(0);
      expect(SOFTWARE_RENDERER.test(renderer)).toBe(true);
    },
  );

  test("no WebGL2 at all yields null, and a canvas without a lose-context extension is still fine", () => {
    expect(detectWebGL(fakeCanvas(null).canvas, "auto")).toBeNull();
    const fake = fakeGl({ renderer: SWIFTSHADER });
    expect(detectWebGL(fakeCanvas(fake).canvas, "auto")).toBeNull();
  });

  test("without the debug-renderer extension the plain RENDERER string decides", () => {
    const fake = fakeGl({ noDebugExt: true, renderer: IRIS });
    expect(detectWebGL(fakeCanvas(fake).canvas, "auto")).toBe(fake.gl);
    expect(fake.since("getParameter").map((c) => c.args[0])).toEqual([CONSTANTS.RENDERER]);
    const soft = fakeGl({ noDebugExt: true, renderer: SWIFTSHADER });
    expect(detectWebGL(fakeCanvas(soft).canvas, "auto")).toBeNull();
  });

  test("the context is asked for with a transparent, premultiplied, depth-less back buffer", () => {
    let attrs: unknown;
    const fake = fakeGl();
    const canvas = { getContext: (_: string, a: unknown) => ((attrs = a), fake.gl) } as unknown as HTMLCanvasElement;
    detectWebGL(canvas, "auto");
    expect(attrs).toMatchObject({ alpha: true, premultipliedAlpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
  });
});

describe("LightLayer setup", () => {
  test("builds two programs (bloom, particles) from the four shader sources and checks compile and link", () => {
    const fake = fakeGl();
    new LightLayer(fake.gl);
    const sourcesFed = fake.since("shaderSource").map((c) => c.args[1]);
    expect(sourcesFed).toEqual([BLOOM_VERT, BLOOM_FRAG, PARTICLE_VERT, PARTICLE_FRAG]);
    expect(fake.since("compileShader")).toHaveLength(4);
    expect(fake.since("getShaderParameter").map((c) => c.args[1])).toEqual(Array(4).fill(CONSTANTS.COMPILE_STATUS));
    expect(fake.since("createProgram")).toHaveLength(2);
    expect(fake.since("linkProgram")).toHaveLength(2);
    expect(fake.since("getProgramParameter").map((c) => c.args[1])).toEqual([CONSTANTS.LINK_STATUS, CONSTANTS.LINK_STATUS]);
    expect(fake.since("createBuffer")).toHaveLength(3); // quad corners, bloom instances, particles
    expect(fake.since("createVertexArray")).toHaveLength(2);
    // instanced attributes advance per instance, the corner per vertex
    const divisors = fake.since("vertexAttribDivisor").map((c) => c.args[1]);
    expect(divisors).toContain(1);
    expect(divisors.filter((d) => d === 0)).toHaveLength(1);
  });

  test("a shader that fails to compile throws with the info log, naming the stage", () => {
    const fake = fakeGl({ compileOk: (source) => !source.includes("gl_PointSize") });
    expect(() => new LightLayer(fake.gl)).toThrow(/particle vertex shader.*fake shader failure/s);
    expect(fake.since("deleteShader").length).toBeGreaterThan(0);
  });

  test("a program that fails to link throws with the info log", () => {
    const fake = fakeGl({ linkOk: false });
    expect(() => new LightLayer(fake.gl)).toThrow(/bloom program.*varyings do not match/s);
  });

  test("when createProgram answers null the two compiled shaders are deleted before the throw", () => {
    const fake = fakeGl({ programOk: false });
    expect(() => new LightLayer(fake.gl)).toThrow(/could not create a bloom program/);
    expect(fake.since("compileShader")).toHaveLength(2);
    expect(fake.since("deleteShader")).toHaveLength(2);
  });

  test("resize sizes the drawing buffer, sets the viewport and the resolution uniform of both programs", () => {
    const fake = fakeGl();
    const layer = new LightLayer(fake.gl);
    fake.mark();
    layer.resize(1920, 1080);
    expect(fake.since("viewport").map((c) => c.args)).toEqual([[0, 0, 1920, 1080]]);
    expect([fake.gl.canvas.width, fake.gl.canvas.height]).toEqual([1920, 1080]); // the drawing buffer follows
    const res = fake.since("uniform2f").filter((c) => (c.args[0] as { uniform: string }).uniform === "u_resolution");
    expect(res.map((c) => c.args.slice(1))).toEqual([
      [1920, 1080],
      [1920, 1080],
    ]);
    expect(fake.since("useProgram")).toHaveLength(2);
  });

  const resolutionUploads = (fake: Fake) => fake.since("uniform2f").filter((c) => (c.args[0] as { uniform: string }).uniform === "u_resolution").map((c) => c.args.slice(1));

  test("a first draw with no resize sizes itself from the canvas — never a silent blank frame from a zero resolution", () => {
    const fake = fakeGl({ canvas: { width: 1600, height: 900 } });
    const layer = new LightLayer(fake.gl);
    fake.mark();
    layer.draw(sources(), 5, 1000);
    expect(fake.since("viewport").map((c) => c.args)).toEqual([[0, 0, 1600, 900]]);
    expect(resolutionUploads(fake)).toEqual([
      [1600, 900],
      [1600, 900],
    ]);
    expect(drawCalls(fake)).toHaveLength(3);
    // the size is known now: the next frame at the same size uploads nothing again
    fake.mark();
    layer.draw(sources(), 5, 1033);
    expect(resolutionUploads(fake)).toEqual([]);
    expect(fake.since("viewport")).toHaveLength(0);
    expect(drawCalls(fake)).toHaveLength(3);
  });

  test("a canvas resized behind the layer's back is picked up on the next draw", () => {
    const fake = fakeGl();
    const layer = new LightLayer(fake.gl);
    layer.resize(1280, 720);
    fake.gl.canvas.width = 1920;
    fake.gl.canvas.height = 1080;
    fake.mark();
    layer.draw(sources(), 4, 1000);
    expect(fake.since("viewport").map((c) => c.args)).toEqual([[0, 0, 1920, 1080]]);
    expect(resolutionUploads(fake)).toEqual([
      [1920, 1080],
      [1920, 1080],
    ]);
  });

  test("dispose deletes both programs, every buffer and vertex array, and a later draw does nothing", () => {
    const fake = fakeGl();
    const layer = new LightLayer(fake.gl);
    fake.mark();
    layer.dispose();
    expect(fake.since("deleteProgram")).toHaveLength(2);
    expect(fake.since("deleteBuffer")).toHaveLength(3);
    expect(fake.since("deleteVertexArray")).toHaveLength(2);
    fake.mark();
    layer.draw(sources(), 5, 1000);
    expect(fake.since("clear")).toHaveLength(0);
    expect(drawCalls(fake)).toHaveLength(0);
    layer.dispose(); // idempotent
  });
});

describe("dropping the layer — release blanks the canvas and keeps the context (fix round 1)", () => {
  /** A canvas whose `width` setter is observed: reassigning it is what drops the composited bitmap, context or no context. */
  function watchedCanvas(w: number, h: number): { canvas: { width: number; height: number }; widthSets: () => number } {
    let width = w;
    let sets = 0;
    const canvas = {
      get width() {
        return width;
      },
      set width(v: number) {
        width = v;
        sets++;
      },
      height: h,
    };
    return { canvas, widthSets: () => sets };
  }

  test("release disposes, resets the canvas width (same size — the box stays) and then commits a transparent clear, so the compositor shows a blank, not the last bloom frame; a second release is a no-op on the GL objects", () => {
    const { canvas, widthSets } = watchedCanvas(1920, 1080);
    let widthSetAt = -1;
    const fake = fakeGl({ canvas, loseContext: () => {} });
    const layer = new LightLayer(fake.gl);
    layer.resize(1920, 1080);
    layer.draw(sources(), 5, 1000);
    const setsBefore = widthSets();
    fake.mark();
    const markAt = fake.calls.length;
    Object.defineProperty(canvas, "width", { configurable: true, get: () => 1920, set: (v: number) => void ((widthSetAt = fake.calls.length), v) });
    layer.release();
    expect(fake.since("deleteProgram")).toHaveLength(2);
    expect(fake.since("deleteBuffer")).toHaveLength(3);
    expect(fake.since("deleteVertexArray")).toHaveLength(2);
    expect(widthSetAt).toBeGreaterThanOrEqual(markAt); // the width was reassigned during release …
    expect(fake.since("clearColor").map((c) => c.args)).toEqual([[0, 0, 0, 0]]);
    expect(fake.since("clear")).toHaveLength(1); // … and the transparent clear came after it (it commits the blank frame)
    expect(fake.calls.findIndex((c, i) => i >= markAt && c.name === "clear")).toBeGreaterThan(widthSetAt);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    void setsBefore;
    void widthSets;
    fake.mark();
    layer.draw(sources(), 5, 1016);
    expect(fake.since("clear")).toHaveLength(0);
    expect(drawCalls(fake)).toHaveLength(0);
    layer.release();
    expect(fake.since("deleteProgram")).toHaveLength(0);
  });

  test("release never loses the context: losing one makes Chromium's compositor stop presenting the 2-D stage canvas (seen in a browser check), and the kept context builds the next layer", () => {
    let lost = 0;
    const fake = fakeGl({ loseContext: () => lost++ });
    const layer = new LightLayer(fake.gl);
    layer.draw(sources(), 5, 1000);
    layer.release();
    expect(lost).toBe(0);
    expect(fake.calls.filter((c) => c.name === "getExtension" && c.args[0] === "WEBGL_lose_context")).toHaveLength(0);
    fake.mark();
    const again = new LightLayer(fake.gl); // the same context, as `main.ts` does when the setting comes back
    again.draw(sources(), 5, 2000);
    expect(drawCalls(fake).length).toBeGreaterThan(0);
  });

  test("the level floors are exported for the scene to mirror: particles from 3, bloom from 4", () => {
    expect(PARTICLE_LEVEL).toBe(3);
    expect(BLOOM_LEVEL).toBe(4);
  });
});

describe("LightLayer.draw per Quality Level", () => {
  function frame(level: Level, src: LightSources = sources()): { fake: Fake; layer: LightLayer } {
    const fake = fakeGl();
    const layer = new LightLayer(fake.gl);
    layer.resize(1280, 720);
    fake.mark();
    layer.draw(src, level, 4000);
    return { fake, layer };
  }

  test.each([1, 2] as Level[])("Level %i clears to transparent and issues no draw calls and no uploads", (level) => {
    const { fake } = frame(level);
    expect(fake.since("clearColor").map((c) => c.args)).toEqual([[0, 0, 0, 0]]);
    expect(fake.since("clear").map((c) => c.args)).toEqual([[CONSTANTS.COLOR_BUFFER_BIT]]);
    expect(drawCalls(fake)).toHaveLength(0);
    expect(fake.uploads()).toEqual([]);
  });

  test("Level 3 draws the particles only — no bloom on segments or points", () => {
    const { fake } = frame(3);
    expect(fake.since("drawArraysInstanced")).toHaveLength(0);
    expect(fake.since("drawArrays").map((c) => c.args)).toEqual([[CONSTANTS.POINTS, 0, 10]]);
    expect(fake.uploads()).toEqual([10 * PARTICLE_STRIDE * 4]);
  });

  test("Level 3 caps particles below Level 4 (2400 of 3000 offered) so the 4→3 step-down is real relief", () => {
    const { fake } = frame(3, sources({ particles: particles(MAX_PARTICLES / 2) }));
    expect(fake.since("drawArrays").map((c) => c.args)).toEqual([[CONSTANTS.POINTS, 0, 2400]]);
    expect(fake.uploads()).toEqual([2400 * PARTICLE_STRIDE * 4]);
  });

  test("Level 4 draws bloom on segments and points, and particles capped at half", () => {
    const { fake } = frame(4, sources({ particles: particles(MAX_PARTICLES) }));
    expect(fake.since("drawArraysInstanced").map((c) => c.args)).toEqual([
      [CONSTANTS.TRIANGLE_STRIP, 0, 4, 2],
      [CONSTANTS.TRIANGLE_STRIP, 0, 4, 3],
    ]);
    expect(fake.since("drawArrays").map((c) => c.args)).toEqual([[CONSTANTS.POINTS, 0, MAX_PARTICLES / 2]]);
    expect(fake.uploads()).toEqual([2 * INSTANCE_STRIDE * 4, 3 * INSTANCE_STRIDE * 4, (MAX_PARTICLES / 2) * PARTICLE_STRIDE * 4]);
  });

  test("Level 5 draws bloom and every particle up to MAX_PARTICLES, no more", () => {
    const { fake } = frame(5, sources({ particles: particles(MAX_PARTICLES + 500) }));
    expect(fake.since("drawArraysInstanced")).toHaveLength(2);
    expect(fake.since("drawArrays").map((c) => c.args)).toEqual([[CONSTANTS.POINTS, 0, MAX_PARTICLES]]);
    expect(fake.uploads().at(-1)).toBe(MAX_PARTICLES * PARTICLE_STRIDE * 4);
  });

  test("the caps: Level 5 draws all (6000) and Level 4 half; Level 3's 2400 keeps the ladder's strictly decreasing shape; 1–2 none", () => {
    expect(MAX_PARTICLES).toBe(6000);
    expect(PARTICLE_CAP).toEqual({ 1: 0, 2: 0, 3: 2400, 4: MAX_PARTICLES / 2, 5: MAX_PARTICLES });
    const ladder = ([5, 4, 3, 2] as Level[]).map((level) => PARTICLE_CAP[level]);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!); // every step down draws fewer
  });

  test("every frame is additive: blending on, ONE + ONE, depth and culling off, on a cleared transparent buffer", () => {
    const { fake } = frame(5);
    expect(fake.since("enable").map((c) => c.args[0])).toContain(CONSTANTS.BLEND);
    expect(fake.since("disable").map((c) => c.args[0])).toEqual(expect.arrayContaining([CONSTANTS.DEPTH_TEST, CONSTANTS.CULL_FACE]));
    expect(fake.since("blendFunc").map((c) => c.args)).toEqual([[CONSTANTS.ONE, CONSTANTS.ONE]]);
    const names = fake.calls.slice(fake.calls.findIndex((c) => c.name === "clearColor")).map((c) => c.name);
    expect(names.indexOf("clear")).toBeLessThan(names.indexOf("drawArraysInstanced"));
    // three draws in total: segments, points, particles — one per source kind, no post-process pass
    expect(drawCalls(fake)).toHaveLength(3);
  });

  test("the time reaches the shaders as seconds", () => {
    const { fake } = frame(5);
    const t = fake.since("uniform1f").filter((c) => (c.args[0] as { uniform: string }).uniform === "u_time");
    expect(t.map((c) => c.args[1])).toEqual([4]); // the bloom program; the particle shaders take no time
  });

  test("bloom instances carry the ends, the halo radius, the colour and the strength; a point is a zero-length segment", () => {
    const { fake } = frame(5);
    const [segs, pts] = fake.since("bufferData").map((c) => Array.from(c.snapshot!));
    expect(segs!.slice(0, INSTANCE_STRIDE)).toEqual([100, 200, 300, 400, SEGMENT_HALO_PX, 1, expect.closeTo(0.2), expect.closeTo(0.9), 1]);
    expect(segs!.slice(INSTANCE_STRIDE, 2 * INSTANCE_STRIDE)).toEqual([120, 200, 320, 420, SEGMENT_HALO_PX, expect.closeTo(0.2), 1, expect.closeTo(0.9), 0.5]);
    expect(pts!.slice(0, INSTANCE_STRIDE)).toEqual([50, 60, 50, 60, 6 * POINT_HALO_SCALE, 1, 1, 0.5, expect.closeTo(0.8)]);
    expect(pts!.slice(2 * INSTANCE_STRIDE, 3 * INSTANCE_STRIDE)).toEqual([90, 60, 90, 60, 9 * POINT_HALO_SCALE, 1, 0.5, 1, 1]);
    expect(POINT_HALO_SCALE).toBeGreaterThan(1); // the halo is wider than the neon it wraps
    expect(fake.since("bufferData").map((c) => c.args[2])).toEqual(Array(3).fill(CONSTANTS.DYNAMIC_DRAW));
  });

  test("the particle buffer is uploaded as the leading slice of the caller's array, whole particles only", () => {
    const ragged = new Float32Array(3 * PARTICLE_STRIDE + 4); // three particles and a torn fourth
    const { fake } = frame(5, sources({ particles: ragged }));
    expect(fake.since("drawArrays").map((c) => c.args)).toEqual([[CONSTANTS.POINTS, 0, 3]]);
    const upload = fake.since("bufferData").at(-1)!.args[1] as Float32Array;
    expect(upload.buffer).toBe(ragged.buffer);
    expect(upload.length).toBe(3 * PARTICLE_STRIDE);
  });

  test("empty sources at Level 5 clear and draw nothing", () => {
    const { fake } = frame(5, { segments: [], points: [], particles: new Float32Array(0) });
    expect(fake.since("clear")).toHaveLength(1);
    expect(drawCalls(fake)).toHaveLength(0);
    expect(fake.uploads()).toEqual([]);
  });

  test("a big bloom list grows the staging buffer and keeps every instance", () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ x0: i, y0: 0, x1: i, y1: 100, colour: [1, 1, 1] as [number, number, number], strength: 1 }));
    const { fake } = frame(5, sources({ segments: many }));
    expect(fake.since("drawArraysInstanced")[0]!.args[3]).toBe(700);
    expect(fake.uploads()[0]).toBe(700 * INSTANCE_STRIDE * 4);
  });
});

describe("shader sources", () => {
  const all = { BLOOM_VERT, BLOOM_FRAG, PARTICLE_VERT, PARTICLE_FRAG };
  const BANNED = /\b(banked|spent|bam|pow|boom|wham|kapow|nice|big|huge)\b/i;

  test.each(Object.entries(all))("%s is GLSL ES 3.00 with the version line first and no banned vocabulary", (_, src) => {
    expect(src.startsWith("#version 300 es\n")).toBe(true);
    expect(BANNED.test(src)).toBe(false);
  });

  test("the vertex shaders set gl_Position and take the resolution; the particle one sizes its point sprite", () => {
    expect(BLOOM_VERT).toContain("gl_Position");
    expect(PARTICLE_VERT).toContain("gl_Position");
    expect(BLOOM_VERT).toContain("uniform vec2 u_resolution");
    expect(PARTICLE_VERT).toContain("uniform vec2 u_resolution");
    expect(PARTICLE_VERT).toContain("gl_PointSize = max(0.0, a_size)"); // a negative size is undefined behaviour, not a small sprite
    expect(BLOOM_VERT).toContain("gl_InstanceID"); // the per-instance shimmer phase
  });

  test("the fragment shaders fall off as exp(-d²), write premultiplied colour and declare a precision", () => {
    for (const src of [BLOOM_FRAG, PARTICLE_FRAG]) {
      expect(src).toMatch(/precision (mediump|highp) float;/);
      expect(src).toMatch(/exp\(-/);
      expect(src).toContain("out vec4 fragColour;");
      expect(src).toMatch(/fragColour = vec4\(\w+(\.rgb)? \* \w+, \w+\);/); // rgb multiplied by the alpha it ships with
    }
    expect(PARTICLE_FRAG).toContain("gl_PointCoord");
  });
});

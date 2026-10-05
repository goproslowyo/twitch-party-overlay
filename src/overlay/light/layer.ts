/**
 * The optional WebGL light layer: a second, transparent canvas over the 2-D scene that only ever *adds* —
 * bloom on laser segments and neon points, and a mass of point-sprite particles. It never replaces anything the 2-D
 * scene draws; when it is off or unavailable every Quality Level shows its 2-D version and Auto Quality never knows.
 *
 * `detectWebGL` answers the `overlay.webgl` setting: `"off"` never asks for a context; `"auto"` takes WebGL2 only when
 * the unmasked renderer is a real GPU (SwiftShader, WARP and llvmpipe are software and cost more than they give).
 * `LightLayer` owns two programs and three buffers. Per frame: clear to transparent, then at most one draw per source
 * kind — segments and points as instanced capsule quads with an `exp(-d²)` falloff, particles as a point-sprite buffer
 * uploaded from the caller's `Float32Array` (`x, y, size, r, g, b, a` per particle). Blending is `ONE, ONE` on
 * premultiplied output. No readback, no post-process pass. What each level draws:
 *
 * - 5: bloom + particles up to `MAX_PARTICLES`
 * - 4: bloom + particles up to half of that
 * - 3: particles only (`PARTICLE_CAP[3]`, fewer than Level 4), no bloom
 * - 1–2: clears and returns — no draw calls
 *
 * `draw` sizes itself from the canvas when `resize` has not been called (or the canvas changed since): the shaders
 * divide by `u_resolution`, and an unset resolution would discard every primitive with no GL error — a silent blank.
 * Nothing here reads a clock or `Math.random`: time arrives as `tMs`, particle motion is the caller's. The scene's own
 * bans (`scene.test.ts`) do not reach this directory; it keeps to them anyway.
 */
import type { Level } from "../quality.ts";
import { BLOOM_FRAG, BLOOM_VERT, PARTICLE_FRAG, PARTICLE_VERT } from "./shaders.ts";

export interface LightSources {
  /** Laser strokes, in canvas pixels; `strength` scales the halo's alpha (1 = full). */
  segments: Array<{ x0: number; y0: number; x1: number; y1: number; colour: [number, number, number]; strength: number }>;
  /** Neon points (tower heads, running light, lit pad halos); `r` is the neon's own radius — the halo is wider. */
  points: Array<{ x: number; y: number; r: number; colour: [number, number, number]; strength: number }>;
  /** `x, y, size, r, g, b, a` per particle (`PARTICLE_STRIDE` floats), size in pixels; a torn tail is ignored. */
  particles: Float32Array;
}

export const MAX_PARTICLES = 6000;
/** Floats per particle in `LightSources.particles`. */
export const PARTICLE_STRIDE = 7;
/** Floats per bloom instance: x0 y0 x1 y1, halo radius, r g b, strength. */
export const INSTANCE_STRIDE = 9;
/** Halo radius around a laser stroke, in pixels — wider and dimmer than the ~2 px line it wraps. */
export const SEGMENT_HALO_PX = 14;
/** A neon point's halo radius is its own radius times this. */
export const POINT_HALO_SCALE = 2.5;
/**
 * Particles drawn at most per Quality Level. Level 5 draws all and Level 4 half; Level 3's 2400 is a
 * local decision following the ladder's shape — strictly decreasing at every step, so a 4→3
 * step-down draws fewer, never the same. Levels 1–2 draw nothing.
 */
export const PARTICLE_CAP: Readonly<Record<Level, number>> = Object.freeze({ 1: 0, 2: 0, 3: 2400, 4: MAX_PARTICLES / 2, 5: MAX_PARTICLES });
/** Renderer strings that are software rasterisers, not a GPU. */
export const SOFTWARE_RENDERER = /swiftshader|warp|llvmpipe|basic render/i;

/** The lowest level that draws anything; below it `draw` only clears. The scene mirrors both floors (scene.test.ts pins them). */
export const PARTICLE_LEVEL: Level = 3;
/** Bloom (segments and points) from this level up; Level 3 is particles only. */
export const BLOOM_LEVEL: Level = 4;
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
};
const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const FLOAT_BYTES = 4;
const STAGING_START = 64;

/**
 * The context for the setting: null when `"off"`, when WebGL2 is unavailable, or when the renderer is software; the
 * context otherwise. A rejected context is left as it is — never given up through `WEBGL_lose_context`:
 * losing a context on the page makes Chromium's compositor stop presenting the 2-D stage canvas (seen in a
 * browser check), and a blank overlay costs far more than one idle context. `detectWebGL` runs once per setting
 * change, and a later call on the same canvas gets the same context back, so nothing accumulates.
 */
export function detectWebGL(canvas: HTMLCanvasElement, setting: "auto" | "off"): WebGL2RenderingContext | null {
  if (setting === "off") return null;
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!gl) return null;
  if (SOFTWARE_RENDERER.test(rendererName(gl))) return null;
  return gl;
}

/** The unmasked renderer where the extension exists, else the plain `RENDERER` (Chromium unmasks that one too). */
function rendererName(gl: WebGL2RenderingContext): string {
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
}

interface ProgramSet {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  resolution: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
}

export class LightLayer {
  readonly #gl: WebGL2RenderingContext;
  readonly #bloom: ProgramSet;
  readonly #particles: ProgramSet;
  readonly #corners: WebGLBuffer;
  readonly #instances: WebGLBuffer;
  readonly #sprites: WebGLBuffer;
  /** CPU staging for bloom instances, grown as the scene's lists grow. */
  #staging = new Float32Array(STAGING_START * INSTANCE_STRIDE);
  /** The size last given to the viewport and `u_resolution`; null until the first `resize` (or self-sizing `draw`). */
  #sized: { w: number; h: number } | null = null;
  #disposed = false;

  /** Throws with the info log when a shader fails to compile or a program to link — never silently draws nothing. */
  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    const programs: WebGLProgram[] = [];
    const buffers: WebGLBuffer[] = [];
    const vaos: WebGLVertexArrayObject[] = [];
    try {
      const bloom = link(gl, "bloom", BLOOM_VERT, BLOOM_FRAG);
      programs.push(bloom);
      const particles = link(gl, "particle", PARTICLE_VERT, PARTICLE_FRAG);
      programs.push(particles);

      this.#corners = create(gl, gl.createBuffer(), "buffer");
      buffers.push(this.#corners);
      this.#instances = create(gl, gl.createBuffer(), "buffer");
      buffers.push(this.#instances);
      this.#sprites = create(gl, gl.createBuffer(), "buffer");
      buffers.push(this.#sprites);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#corners);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);

      // bloom: the corner per vertex, everything else per instance
      const bloomVao = create(gl, gl.createVertexArray(), "vertex array");
      vaos.push(bloomVao);
      gl.bindVertexArray(bloomVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#corners);
      attribute(gl, bloom, "a_corner", 2, 0, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#instances);
      const instanceBytes = INSTANCE_STRIDE * FLOAT_BYTES;
      attribute(gl, bloom, "a_ends", 4, instanceBytes, 0, 1);
      attribute(gl, bloom, "a_radius", 1, instanceBytes, 4 * FLOAT_BYTES, 1);
      attribute(gl, bloom, "a_tint", 4, instanceBytes, 5 * FLOAT_BYTES, 1);

      // particles: one vertex per particle straight from the caller's layout
      const spriteVao = create(gl, gl.createVertexArray(), "vertex array");
      vaos.push(spriteVao);
      gl.bindVertexArray(spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#sprites);
      const particleBytes = PARTICLE_STRIDE * FLOAT_BYTES;
      attribute(gl, particles, "a_position", 2, particleBytes, 0, null);
      attribute(gl, particles, "a_size", 1, particleBytes, 2 * FLOAT_BYTES, null);
      attribute(gl, particles, "a_tint", 4, particleBytes, 3 * FLOAT_BYTES, null);
      gl.bindVertexArray(null);

      this.#bloom = { program: bloom, vao: bloomVao, resolution: gl.getUniformLocation(bloom, "u_resolution"), time: gl.getUniformLocation(bloom, "u_time") };
      this.#particles = { program: particles, vao: spriteVao, resolution: gl.getUniformLocation(particles, "u_resolution"), time: null };
    } catch (error) {
      for (const vao of vaos) gl.deleteVertexArray(vao);
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      for (const program of programs) gl.deleteProgram(program);
      throw error;
    }
  }

  /** Sizes the drawing buffer (when it differs), the viewport and both programs' resolution uniform. */
  resize(w: number, h: number): void {
    if (this.#disposed) return;
    const gl = this.#gl;
    if (gl.canvas.width !== w) gl.canvas.width = w;
    if (gl.canvas.height !== h) gl.canvas.height = h;
    gl.viewport(0, 0, w, h);
    for (const set of [this.#bloom, this.#particles]) {
      gl.useProgram(set.program);
      gl.uniform2f(set.resolution, w, h);
    }
    this.#sized = { w, h };
  }

  /**
   * One frame: clear, then (by level) the bloom pass over segments and points and the particle pass. Sizes itself from
   * the canvas first when `resize` has never been called or the canvas has changed since.
   */
  draw(sources: LightSources, level: Level, tMs: number): void {
    if (this.#disposed) return;
    const gl = this.#gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (level < PARTICLE_LEVEL) return;

    const { width, height } = gl.canvas;
    if (this.#sized === null || this.#sized.w !== width || this.#sized.h !== height) this.resize(width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (level >= BLOOM_LEVEL) this.#bloomPass(sources, tMs);
    this.#particlePass(sources.particles, PARTICLE_CAP[level]);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const gl = this.#gl;
    gl.deleteVertexArray(this.#bloom.vao);
    gl.deleteVertexArray(this.#particles.vao);
    gl.deleteBuffer(this.#corners);
    gl.deleteBuffer(this.#instances);
    gl.deleteBuffer(this.#sprites);
    gl.deleteProgram(this.#bloom.program);
    gl.deleteProgram(this.#particles.program);
  }

  /**
   * Takes the layer off its canvas: `dispose`, then blank the canvas. A WebGL canvas keeps compositing its last drawn
   * frame after the drawing stops — a still of halos and glow sitting over the live 2-D scene. Reassigning `width`
   * resets the bitmap (the spec's way, and the only one that reaches a lost context) but Chromium's compositor kept
   * presenting the old frame until a WebGL frame was committed (a browser check: identical captures 2 s
   * apart), so a transparent `clear` on the live context follows and commits the blank. The context is kept, not
   * lost: `WEBGL_lose_context.loseContext()` on a page made that same compositor stop presenting the 2-D stage canvas
   * — a blank overlay is far worse than one idle context, and the same context builds the next layer when the setting
   * comes back.
   */
  release(): void {
    this.dispose();
    const gl = this.#gl;
    const { canvas } = gl;
    canvas.width = canvas.width;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  #bloomPass({ segments, points }: LightSources, tMs: number): void {
    if (segments.length === 0 && points.length === 0) return;
    const gl = this.#gl;
    gl.useProgram(this.#bloom.program);
    gl.uniform1f(this.#bloom.time, tMs / 1000);
    gl.bindVertexArray(this.#bloom.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instances);
    if (segments.length > 0) {
      const staging = this.#stage(segments.length);
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!;
        const o = i * INSTANCE_STRIDE;
        staging[o] = s.x0;
        staging[o + 1] = s.y0;
        staging[o + 2] = s.x1;
        staging[o + 3] = s.y1;
        staging[o + 4] = SEGMENT_HALO_PX;
        staging[o + 5] = s.colour[0];
        staging[o + 6] = s.colour[1];
        staging[o + 7] = s.colour[2];
        staging[o + 8] = s.strength;
      }
      this.#instanced(staging, segments.length);
    }
    if (points.length > 0) {
      const staging = this.#stage(points.length);
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        const o = i * INSTANCE_STRIDE;
        staging[o] = p.x;
        staging[o + 1] = p.y;
        staging[o + 2] = p.x;
        staging[o + 3] = p.y;
        staging[o + 4] = p.r * POINT_HALO_SCALE;
        staging[o + 5] = p.colour[0];
        staging[o + 6] = p.colour[1];
        staging[o + 7] = p.colour[2];
        staging[o + 8] = p.strength;
      }
      this.#instanced(staging, points.length);
    }
  }

  #instanced(staging: Float32Array, count: number): void {
    const gl = this.#gl;
    gl.bufferData(gl.ARRAY_BUFFER, staging.subarray(0, count * INSTANCE_STRIDE), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  #particlePass(particles: Float32Array, cap: number): void {
    const count = Math.min(cap, Math.floor(particles.length / PARTICLE_STRIDE));
    if (count === 0) return;
    const gl = this.#gl;
    gl.useProgram(this.#particles.program);
    gl.bindVertexArray(this.#particles.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#sprites);
    gl.bufferData(gl.ARRAY_BUFFER, particles.subarray(0, count * PARTICLE_STRIDE), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  /** The staging array, grown (doubling) to hold `count` instances. */
  #stage(count: number): Float32Array {
    const need = count * INSTANCE_STRIDE;
    if (this.#staging.length < need) {
      let length = this.#staging.length;
      while (length < need) length *= 2;
      this.#staging = new Float32Array(length);
    }
    return this.#staging;
  }
}

function create<T>(gl: WebGL2RenderingContext, object: T | null, what: string): T {
  if (object === null) throw new Error(`light layer: could not create a ${what}${gl.isContextLost() ? " (context lost)" : ""}`);
  return object;
}

/** Binds `name` to the currently bound ARRAY_BUFFER; `divisor` null leaves the per-vertex default untouched. */
function attribute(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, size: number, strideBytes: number, offsetBytes: number, divisor: number | null): void {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`light layer: the program has no attribute ${name}`);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, strideBytes, offsetBytes);
  if (divisor !== null) gl.vertexAttribDivisor(location, divisor);
}

function compile(gl: WebGL2RenderingContext, kind: string, stage: "vertex" | "fragment", source: string): WebGLShader {
  const shader = create(gl, gl.createShader(stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER), `${kind} ${stage} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`light layer: the ${kind} ${stage} shader failed to compile:\n${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, kind: string, vertSource: string, fragSource: string): WebGLProgram {
  const vert = compile(gl, kind, "vertex", vertSource);
  let frag: WebGLShader;
  try {
    frag = compile(gl, kind, "fragment", fragSource);
  } catch (error) {
    gl.deleteShader(vert);
    throw error;
  }
  let program: WebGLProgram;
  try {
    program = create(gl, gl.createProgram(), `${kind} program`);
  } catch (error) {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    throw error;
  }
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  // once linked the program holds what it needs; the shader objects can go
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`light layer: the ${kind} program failed to link:\n${log}`);
  }
  return program;
}

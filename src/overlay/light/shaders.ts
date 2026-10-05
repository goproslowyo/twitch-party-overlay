/**
 * GLSL ES 3.00 for the light layer — strings only, no WebGL calls. Two programs:
 *
 * - **Bloom**: one instanced quad per light source. A source is a segment `(x0,y0)–(x1,y1)` in canvas pixels with a halo
 *   radius; a point is the zero-length case. The vertex stage builds a capsule-shaped quad around the segment padded by
 *   the radius; the fragment stage takes the distance to the segment, normalises it by the radius and falls off as
 *   `exp(-d²)`, lifted so it reaches exactly zero at the quad edge (no hard rim). Strength shimmers ±4 % at 0.7 Hz on a
 *   per-instance phase — far under the 2 Hz flash ceiling.
 * - **Particles**: point sprites, one per particle, with the same radial falloff over `gl_PointCoord`.
 *
 * Both fragment stages write **premultiplied** colour (`rgb × alpha, alpha`): summed with `ONE, ONE` blending the buffer
 * stays a valid premultiplied image, so the browser composites the layer over the 2-D canvas without a dark halo.
 * Fragment precision is highp (mandatory in ES 3.00): positions arrive in pixels up to 2560 and mediump would step
 * them by 2 px. Identifiers keep clear of the on-screen vocabulary bans — `vocabulary.test.ts` sweeps these strings.
 */

export const BLOOM_VERT = `#version 300 es
precision highp float;

in vec2 a_corner;
in vec4 a_ends;
in float a_radius;
in vec4 a_tint;

uniform vec2 u_resolution;
uniform float u_time;

out vec2 v_pos;
flat out vec4 v_ends;
flat out float v_radius;
flat out vec4 v_tint;

const float SHIMMER_DEPTH = 0.04;
const float SHIMMER_RATE = 4.4;

void main() {
  vec2 p0 = a_ends.xy;
  vec2 p1 = a_ends.zw;
  vec2 axis = p1 - p0;
  float len = length(axis);
  vec2 dir = len > 0.0 ? axis / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 pos = (p0 + p1) * 0.5 + dir * (a_corner.x * (len * 0.5 + a_radius)) + nrm * (a_corner.y * a_radius);
  float shimmer = 1.0 + SHIMMER_DEPTH * sin(u_time * SHIMMER_RATE + float(gl_InstanceID) * 1.7);
  v_pos = pos;
  v_ends = a_ends;
  v_radius = a_radius;
  v_tint = vec4(a_tint.rgb, a_tint.a * shimmer);
  vec2 clip = pos / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const BLOOM_FRAG = `#version 300 es
precision highp float;

in vec2 v_pos;
flat in vec4 v_ends;
flat in float v_radius;
flat in vec4 v_tint;

out vec4 fragColour;

const float FALLOFF = 4.0;
const float PEAK = 0.55;

void main() {
  vec2 axis = v_ends.zw - v_ends.xy;
  float len2 = dot(axis, axis);
  float t = len2 > 0.0 ? clamp(dot(v_pos - v_ends.xy, axis) / len2, 0.0, 1.0) : 0.0;
  float d = length(v_pos - (v_ends.xy + axis * t)) / v_radius;
  float edge = exp(-FALLOFF);
  float glow = max(0.0, (exp(-FALLOFF * d * d) - edge) / (1.0 - edge));
  float alpha = glow * v_tint.a * PEAK;
  fragColour = vec4(v_tint.rgb * alpha, alpha);
}
`;

export const PARTICLE_VERT = `#version 300 es
precision highp float;

in vec2 a_position;
in float a_size;
in vec4 a_tint;

uniform vec2 u_resolution;

out vec4 v_tint;

void main() {
  v_tint = a_tint;
  gl_PointSize = max(0.0, a_size); // a negative size is undefined, not a small sprite
  vec2 clip = a_position / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const PARTICLE_FRAG = `#version 300 es
precision highp float;

in vec4 v_tint;

out vec4 fragColour;

const float FALLOFF = 4.0;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(q, q);
  float edge = exp(-FALLOFF);
  float glow = max(0.0, (exp(-FALLOFF * d2) - edge) / (1.0 - edge));
  float alpha = glow * v_tint.a;
  fragColour = vec4(v_tint.rgb * alpha, alpha);
}
`;

/*
 * The look: one pass over the finished frame.
 *
 * The reference painting is warm, a little bloomed round every lit window and
 * torch, and darker toward the corners. None of that is in the sprites, and
 * none of it should be: it is what a camera does to a scene, so it is done to
 * the whole frame at once. A cheap bloom (a ring of taps, thresholded so only
 * the bright parts spread), a warm grade, a filmic tone curve so the brights
 * roll off instead of clipping, a touch more saturation, and a vignette. One
 * texture and a dozen reads per pixel; nothing rendered twice.
 *
 * Two more things live here because they are also things done to the frame
 * rather than to any sprite:
 *
 * - A light anti-aliasing. The art is pixel art drawn at a fractional zoom,
 *   so every diagonal — the roof lines, the tile edges, the river bank — is a
 *   staircase whose steps are not even the same size. Four reads at half a
 *   pixel find where a hard edge crosses this pixel and lean it a little
 *   toward its neighbours, only there. Flat colour is untouched, so it does
 *   not read as blur; edges stop crawling when the camera moves.
 *
 * - A phone variant with no bloom at all. The bloom is twelve reads per pixel
 *   of a full-screen pass at the device's own resolution, which is the single
 *   most expensive thing the renderer does and the first thing to go on a
 *   device that gets warm.
 */

import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';

const bloomTaps = `
  float r1 = 2.5, r2 = 4.2, r3 = 9.0;
  vec3 glow = vec3(0.0);
  glow += texture(uTexture, vTextureCoord + vec2( r1, 0.0) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(-r1, 0.0) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(0.0,  r1) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(0.0, -r1) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2( r2,  r2) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(-r2,  r2) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2( r2, -r2) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(-r2, -r2) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2( r3, 0.0) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(-r3, 0.0) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(0.0,  r3) * px).rgb;
  glow += texture(uTexture, vTextureCoord + vec2(0.0, -r3) * px).rgb;
  glow /= 12.0;
  float lum = dot(glow, vec3(0.299, 0.587, 0.114));
  glow *= smoothstep(0.62, 1.0, lum);
  vec3 glowLin = pow(max(glow, vec3(0.0)), vec3(2.2));
`;

const fragmentFor = (bloom: boolean) => `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform float uBloom;
uniform float uWarmth;
uniform float uVignette;
uniform float uSaturation;
uniform float uAmount;
uniform float uSoften;

vec3 filmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec4 src = texture(uTexture, vTextureCoord);
  vec2 px = uInputSize.zw;

  // Light anti-aliasing: the four diagonal neighbours at half a pixel. Where
  // they agree with this pixel nothing happens; where a hard edge runs
  // through, the pixel leans toward the average by how hard the edge is.
  vec3 n0 = texture(uTexture, vTextureCoord + vec2(-0.5, -0.5) * px).rgb;
  vec3 n1 = texture(uTexture, vTextureCoord + vec2( 0.5, -0.5) * px).rgb;
  vec3 n2 = texture(uTexture, vTextureCoord + vec2(-0.5,  0.5) * px).rgb;
  vec3 n3 = texture(uTexture, vTextureCoord + vec2( 0.5,  0.5) * px).rgb;
  vec3 avg = (n0 + n1 + n2 + n3) * 0.25;
  float edge = clamp(abs(dot(avg - src.rgb, vec3(0.299, 0.587, 0.114))) * 7.0, 0.0, 1.0);
  vec3 base = mix(src.rgb, avg, edge * uSoften);

  ${bloom ? bloomTaps : 'vec3 glowLin = vec3(0.0);'}

  // The curve belongs to light, not to pixels: the frame is display-referred,
  // so it is taken back to linear light, bloomed and toned there, and
  // returned. Toning the display values directly lifted every shadow and
  // washed the whole frame to pastel.
  vec3 lin = pow(max(base, vec3(0.0)), vec3(2.2));
  vec3 col = lin + glowLin * uBloom;
  col *= mix(vec3(1.0), vec3(1.06, 0.99, 0.92), uWarmth);
  col = pow(filmic(col * 1.02), vec3(1.0 / 2.2));
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(g), col, uSaturation);

  vec2 uv = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
  vec2 dv = (uv - 0.5) * vec2(1.0, 0.86);
  float vig = 1.0 - smoothstep(0.38, 0.98, length(dv) * 1.3) * uVignette;
  col *= vig;

  finalColor = vec4(mix(base, col, uAmount), src.a);
}
`;

export class GradeFilter extends Filter {
  private readonly grade: UniformGroup;
  readonly bloom: boolean;

  constructor(options: { bloom?: boolean; soften?: boolean } = {}) {
    const bloom = options.bloom ?? true;
    const grade = new UniformGroup({
      uBloom: { value: 0.2, type: 'f32' },
      uWarmth: { value: 0.4, type: 'f32' },
      uVignette: { value: 0.16, type: 'f32' },
      uSaturation: { value: 1.05, type: 'f32' },
      uAmount: { value: 0.65, type: 'f32' },
      uSoften: { value: options.soften === false ? 0 : 0.55, type: 'f32' },
    });
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: fragmentFor(bloom), name: bloom ? 'grade-filter' : 'grade-filter-lite' }),
      resources: { gradeUniforms: grade },
    });
    this.grade = grade;
    this.bloom = bloom;
  }

  /** Night makes the glow matter and the warmth recede. */
  set night(n: number) {
    const u = this.grade.uniforms as { uBloom: number; uWarmth: number; uVignette: number };
    u.uBloom = 0.2 + 0.25 * n;
    u.uWarmth = 0.4 - 0.25 * n;
    u.uVignette = 0.16 + 0.08 * n;
  }

  /** How much the edges are softened: 0 leaves the pixels as drawn. */
  set soften(s: number) {
    (this.grade.uniforms as { uSoften: number }).uSoften = s;
  }
}

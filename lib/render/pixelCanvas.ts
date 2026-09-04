/**
 * Pixel-art drawing primitives.
 *
 * Every sprite in Emerge is painted onto a small offscreen canvas at its native
 * pixel resolution and then sampled with nearest-neighbour filtering, which is
 * what gives the world its painterly pixel look. Keeping all drawing behind
 * these helpers means the generated art can be swapped for authored PNGs later
 * without touching the renderer (see `assets.ts`).
 */

export const TILE_W = 64;
export const TILE_H = 32;
/** Vertical offset of one elevation step, in screen pixels. */
export const ELEVATION = 16;

export interface Pixels {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export function surface(w: number, h: number): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx, w, h };
}

/** Fill an axis-aligned block. All sprite drawing bottoms out here. */
export function rect(p: Pixels, x: number, y: number, w: number, h: number, color: string) {
  p.ctx.fillStyle = color;
  p.ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

export function dot(p: Pixels, x: number, y: number, color: string) {
  rect(p, x, y, 1, 1, color);
}

/** Horizontal span of the isometric diamond at row `y` of a TILE_W x TILE_H tile. */
export function diamondRow(y: number, w = TILE_W, h = TILE_H): [number, number] {
  const half = h / 2;
  const t = y < half ? y : h - 1 - y;
  const width = Math.round(((t + 1) / half) * w);
  return [Math.round((w - width) / 2), width];
}

/** Fill the isometric diamond of a tile with a flat colour. */
export function fillDiamond(p: Pixels, color: string, offsetY = 0, w = TILE_W, h = TILE_H) {
  p.ctx.fillStyle = color;
  for (let y = 0; y < h; y++) {
    const [x0, width] = diamondRow(y, w, h);
    p.ctx.fillRect(x0, y + offsetY, width, 1);
  }
}

/** True when (x, y) sits inside the tile diamond. Used to clip scatter/noise. */
export function insideDiamond(x: number, y: number, w = TILE_W, h = TILE_H) {
  if (y < 0 || y >= h) return false;
  const [x0, width] = diamondRow(y, w, h);
  return x >= x0 && x < x0 + width;
}

/** Small deterministic PRNG so every generated sprite is reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hex(r: number, g: number, b: number) {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function parseHex(color: string): [number, number, number] {
  const v = parseInt(color.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Blend two hex colours. `t` of 0 returns `a`, 1 returns `b`. */
export function mix(a: string, b: string, t: number) {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return hex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function shade(color: string, amount: number) {
  const [r, g, b] = parseHex(color);
  return amount >= 0 ? hex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount) : hex(r * (1 + amount), g * (1 + amount), b * (1 + amount));
}

/** Grey used by tintable character/part masks. 255 is full colour, lower is shadow. */
export function grey(level: number) {
  const v = Math.max(0, Math.min(255, Math.round(level)));
  return hex(v, v, v);
}

/**
 * Speckle a region with slightly varied tones. This is what stops large grass
 * and stone areas from reading as flat vector shapes.
 */
export function speckle(p: Pixels, seed: number, count: number, colors: string[], clip?: (x: number, y: number) => boolean, size = 1) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(r() * p.w);
    const y = Math.floor(r() * p.h);
    if (clip && !clip(x, y)) continue;
    rect(p, x, y, size, size, colors[Math.floor(r() * colors.length)]);
  }
}

/** Soft radial glow, used for lamps, lit windows and the selection ring. */
export function glow(p: Pixels, cx: number, cy: number, radius: number, color: string, alpha = 0.5) {
  const gradient = p.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  p.ctx.save();
  p.ctx.globalAlpha = alpha;
  p.ctx.fillStyle = gradient;
  p.ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  p.ctx.restore();
}

/** Contact shadow ellipse placed under free-standing objects. */
export function groundShadow(p: Pixels, cx: number, cy: number, rx: number, ry: number, alpha = 0.3) {
  p.ctx.save();
  p.ctx.globalAlpha = alpha;
  p.ctx.fillStyle = '#000000';
  p.ctx.beginPath();
  p.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  p.ctx.fill();
  p.ctx.restore();
}

/**
 * Draw the top face of an isometric box: a diamond of `w` x `h` centred at
 * (cx, cy). Used for building roofs, crates and plinths.
 */
export function isoTop(p: Pixels, cx: number, cy: number, w: number, h: number, color: string) {
  p.ctx.fillStyle = color;
  for (let y = 0; y < h; y++) {
    const [x0, width] = diamondRow(y, w, h);
    p.ctx.fillRect(Math.round(cx - w / 2 + x0), Math.round(cy + y), width, 1);
  }
}

/**
 * Draw the two visible vertical faces of an isometric box whose top diamond is
 * `w` x `h` at (cx, cy), extruded `depth` pixels downward.
 */
export function isoWalls(p: Pixels, cx: number, cy: number, w: number, h: number, depth: number, left: string, right: string) {
  const halfW = w / 2;
  const halfH = h / 2;
  // Left face: from the west corner down to the south corner.
  for (let i = 0; i < halfW; i++) {
    const x = Math.round(cx - halfW + i);
    const top = Math.round(cy + halfH + (i * halfH) / halfW);
    p.ctx.fillStyle = left;
    p.ctx.fillRect(x, top, 1, depth);
  }
  // Right face: from the south corner up to the east corner.
  for (let i = 0; i < halfW; i++) {
    const x = Math.round(cx + i);
    const top = Math.round(cy + h - (i * halfH) / halfW);
    p.ctx.fillStyle = right;
    p.ctx.fillRect(x, top, 1, depth);
  }
}

/** Outline the silhouette of everything already drawn, one pixel outward. */
export function outline(p: Pixels, color: string, alpha = 1) {
  const src = p.ctx.getImageData(0, 0, p.w, p.h);
  const out = p.ctx.createImageData(p.w, p.h);
  const [r, g, b] = parseHex(color);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= p.w || y >= p.h ? 0 : src.data[(y * p.w + x) * 4 + 3]);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (src.data[i + 3] > 0) continue;
      if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = Math.round(255 * alpha);
      }
    }
  }
  p.ctx.putImageData(mergeUnder(src, out, p.w, p.h), 0, 0);
}

function mergeUnder(top: ImageData, bottom: ImageData, w: number, h: number) {
  const result = new ImageData(w, h);
  for (let i = 0; i < top.data.length; i += 4) {
    if (top.data[i + 3] > 0) {
      result.data[i] = top.data[i]; result.data[i + 1] = top.data[i + 1];
      result.data[i + 2] = top.data[i + 2]; result.data[i + 3] = top.data[i + 3];
    } else {
      result.data[i] = bottom.data[i]; result.data[i + 1] = bottom.data[i + 1];
      result.data[i + 2] = bottom.data[i + 2]; result.data[i + 3] = bottom.data[i + 3];
    }
  }
  return result;
}

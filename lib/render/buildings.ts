/**
 * Isometric building art.
 *
 * Buildings are extruded from a diamond footprint: two visible wall faces, a
 * ridged or hipped roof, and per-type detailing (signs, awnings, chimneys,
 * forges, water wheels). Each type produces three things:
 *
 *   - a base sprite,
 *   - a `lit` overlay containing only the glowing windows, signs and lamps,
 *     blended additively after dark so the settlement lights up at night,
 *   - metadata giving the door and chimney positions relative to the building's
 *     ground contact point, so the renderer can stand citizens at the door and
 *     hang smoke off the right chimney.
 *
 * The look is the reference's: dark stone and timber, moss climbing the foot
 * of every wall, warm windows, and the building's name in lit green letters on
 * a dark board over the door. Every building is also drawn at three levels of
 * improvement — lanterns and a banner at the second, a glass annex and a taller
 * frame at the third — so what the player paid for is visible from across the
 * settlement.
 */

import { BLOOM, BUILD, FOLIAGE, GROUND, WATER } from './palette';
import {
  glow, groundShadow, isoTop, isoWalls, outline, rect, rng, shade, speckle, surface, type Pixels,
} from './pixelCanvas';

const DARK = '#2a1d13';

type Side = 'left' | 'right';
type RoofStyle = 'gable' | 'hip' | 'flat' | 'mansard' | 'sawtooth' | 'stepped' | 'dome' | 'curved';
type WallStyle = 'plaster' | 'stone' | 'timber' | 'dark' | 'log' | 'brick' | 'concrete' | 'composite';
type RoofColor = 'red' | 'green' | 'slate' | 'thatch' | 'shingle' | 'iron' | 'glass' | 'white' | 'garden';

interface Geometry {
  cx: number; wallTopY: number; bw: number; bh: number; wallH: number; roofH: number;
  groundY: number; canvasH: number;
}

const ROOFS: Record<RoofColor, [string, string, string]> = {
  red: [BUILD.roofRedLight, BUILD.roofRed, BUILD.roofRedDark],
  green: [BUILD.roofGreenLight, BUILD.roofGreen, BUILD.roofGreenDark],
  slate: [BUILD.roofSlateLight, BUILD.roofSlate, BUILD.roofSlateDark],
  thatch: [BUILD.roofThatchLight, BUILD.roofThatch, BUILD.roofThatchDark],
  // Split wooden shakes, weathered: the settlement's roof.
  shingle: ['#a58c6c', '#7d684e', '#554636'],
  // The later eras: iron sheet, glass, white composite, a garden on the roof.
  iron: ['#5a6068', '#3e444c', '#2a2f36'],
  glass: ['#8fd0e0', '#5aa8c0', '#3a7890'],
  white: ['#f4f6f8', '#dfe4ea', '#b8c0c8'],
  garden: ['#6fb04a', '#4a8a3a', '#2f6028'],
};
const WALLS: Record<WallStyle, [string, string, string]> = {
  plaster: [BUILD.plasterLight, BUILD.plaster, BUILD.plasterDark],
  stone: [BUILD.stoneWallLight, BUILD.stoneWall, BUILD.stoneWallDark],
  timber: [BUILD.timberLight, BUILD.timber, BUILD.timberDark],
  dark: ['#3e4139', '#2e302b', '#20221e'],
  log: ['#a27c54', '#7b5b3d', '#523a27'],
  brick: ['#9a5a44', '#7a4434', '#563024'],
  concrete: ['#b8bcc0', '#969ba2', '#6e7278'],
  composite: ['#f2f4f6', '#d8dde3', '#aeb6bf'],
};

/**
 * Paint into one of the two visible wall faces using face-local coordinates:
 * `t` runs 0..1 along the face and `v` runs 0..1 down the wall.
 */
function wallPatch(p: Pixels, g: Geometry, side: Side, t: number, v: number, w: number, h: number, color: string) {
  const halfW = g.bw / 2;
  const halfH = g.bh / 2;
  for (let i = 0; i < w; i++) {
    const u = t + i / g.bw;
    const x = side === 'left' ? g.cx - halfW + u * halfW * 2 * 0.5 : g.cx + u * halfW;
    const edgeY = side === 'left'
      ? g.wallTopY + halfH + u * halfH
      : g.wallTopY + g.bh - u * halfH;
    const y = edgeY + v * g.wallH;
    rect(p, Math.round(x), Math.round(y), 1, h, color);
  }
}

/** Corner-to-corner run of a wall face, used for beams and skirting. */
function wallBand(p: Pixels, g: Geometry, side: Side, v: number, h: number, color: string) {
  wallPatch(p, g, side, 0, v, Math.round(g.bw / 2), h, color);
}

/** Screen position of a point on a wall face, for things drawn flat to camera. */
function wallPoint(g: Geometry, side: Side, t: number, v: number): [number, number] {
  const halfW = g.bw / 2;
  const halfH = g.bh / 2;
  const x = side === 'left' ? g.cx - halfW + t * halfW : g.cx + t * halfW;
  const edgeY = side === 'left' ? g.wallTopY + halfH + t * halfH : g.wallTopY + g.bh - t * halfH;
  return [Math.round(x), Math.round(edgeY + v * g.wallH)];
}

/**
 * The material of a wall, drawn as courses rather than noise.
 *
 * Stone is laid in rows of blocks with a sand mortar line; plaster shows its
 * timber frame with braces at the corners; logs are round, lit along the
 * top and dark along the bottom; planks stand vertical with a nail in each.
 * The shaded (left) face gets the same texture a step darker, so the join
 * at the corner reads as a corner and not a seam.
 */
function paintWallTexture(p: Pixels, g: Geometry, style: WallStyle, seed: number) {
  const [light, mid, dark] = WALLS[style];
  const r = rng(seed);
  const faceLen = Math.round(g.bw / 2);
  const tone = (side: Side, c: string) => (side === 'left' ? shade(c, -0.16) : c);
  if (style === 'stone' || style === 'brick' || style === 'concrete') {
    const course = style === 'brick' ? 3 : 5;
    for (const side of ['left', 'right'] as Side[]) {
      let row = 0;
      for (let y = 0; y < g.wallH - 1; y += course, row++) {
        const v = y / g.wallH;
        // Mortar line under the course.
        wallPatch(p, g, side, 0, v + (course - 1) / g.wallH, faceLen, 1, tone(side, shade(dark, -0.12)));
        const offset = row % 2 ? 3 : 0;
        for (let x = offset; x < faceLen; x += 7 + Math.floor(r() * 4)) {
          const w = Math.min(faceLen - x, 5 + Math.floor(r() * 5));
          const c = r() < 0.3 ? light : r() < 0.7 ? mid : shade(mid, -0.08);
          wallPatch(p, g, side, x / faceLen, v, w, course - 1, tone(side, c));
          // Each block lit along its top and dark down its right edge.
          wallPatch(p, g, side, x / faceLen, v, w, 1, tone(side, shade(c, 0.14)));
          wallPatch(p, g, side, (x + w - 1) / faceLen, v, 1, course - 1, tone(side, shade(c, -0.18)));
        }
      }
    }
  } else if (style === 'plaster' || style === 'composite') {
    for (const side of ['left', 'right'] as Side[]) {
      // Plaster is never flat: a soft mottle, then the frame over it.
      for (let i = 0; i < 40; i++) {
        wallPatch(p, g, side, r() * 0.95, r() * 0.95, 2 + Math.floor(r() * 4), 1 + Math.floor(r() * 2), tone(side, r() < 0.5 ? shade(mid, 0.06) : shade(mid, -0.06)));
      }
      if (style === 'plaster') {
        const beam = tone(side, BUILD.timberDark);
        const beamLit = tone(side, BUILD.timber);
        for (const t of [0.02, 0.3, 0.58, 0.86]) {
          wallPatch(p, g, side, t, 0, 3, g.wallH, beam);
          wallPatch(p, g, side, t, 0, 1, g.wallH, beamLit);
        }
        wallBand(p, g, side, 0.46, 2, beam);
        wallBand(p, g, side, 0, 2, beam);
        // Diagonal braces in the lower panels.
        for (const t0 of [0.06, 0.62]) {
          for (let i = 0; i < 10; i++) wallPatch(p, g, side, t0 + i * 0.02, 0.9 - i * 0.04, 2, 2, beam);
        }
      }
    }
  } else if (style === 'log') {
    const logH = 4;
    for (const side of ['left', 'right'] as Side[]) {
      for (let y = 0; y < g.wallH; y += logH) {
        const v = y / g.wallH;
        wallPatch(p, g, side, 0, v, faceLen, 1, tone(side, light));
        wallPatch(p, g, side, 0, v + (logH - 1) / g.wallH, faceLen, 1, tone(side, shade(dark, -0.2)));
        if (r() < 0.6) wallPatch(p, g, side, r() * 0.8, v + 1 / g.wallH, 3 + Math.floor(r() * 6), 1, tone(side, shade(mid, 0.08)));
      }
    }
    // Log ends at the front corner, stacked.
    for (let y = 0; y < g.wallH; y += logH) {
      const [x, yy] = wallPoint(g, 'right', 0, y / g.wallH);
      rect(p, x - 2, yy, 4, logH - 1, shade(light, 0.1));
      rect(p, x - 1, yy + 1, 2, 1, dark);
    }
  } else if (style === 'timber' || style === 'dark') {
    for (const side of ['left', 'right'] as Side[]) {
      for (let x = 0; x < faceLen; x += 4) {
        const c = (x / 4) % 2 ? mid : shade(mid, -0.07);
        wallPatch(p, g, side, x / faceLen, 0, 4, g.wallH, tone(side, c));
        wallPatch(p, g, side, x / faceLen, 0, 1, g.wallH, tone(side, shade(dark, -0.1)));
        wallPatch(p, g, side, (x + 2) / faceLen, 0.18, 1, 1, tone(side, dark));
        wallPatch(p, g, side, (x + 2) / faceLen, 0.78, 1, 1, tone(side, dark));
      }
      wallBand(p, g, side, 0.5, 2, tone(side, shade(dark, -0.15)));
    }
  }
}

/**
 * Shadow under the eave and at the foot of the wall.
 *
 * This is most of what makes a box read as a building with a roof on it:
 * a band of shade where the eave hangs over, deepening on the face away
 * from the sun, and the ground's own darkness climbing the last few pixels.
 */
function ambientOcclusion(p: Pixels, g: Geometry) {
  const faceLen = Math.round(g.bw / 2);
  p.ctx.save();
  p.ctx.globalAlpha = 1;
  for (const side of ['left', 'right'] as Side[]) {
    const strength = side === 'left' ? 0.34 : 0.24;
    for (let i = 0; i < 5; i++) {
      p.ctx.globalAlpha = strength * (1 - i / 5);
      wallPatch(p, g, side, 0, i / g.wallH, faceLen, 1, '#1a1208');
    }
    for (let i = 0; i < 4; i++) {
      p.ctx.globalAlpha = 0.22 * (1 - i / 4);
      wallPatch(p, g, side, 0, 1 - (i + 1) / g.wallH, faceLen, 1, '#1a1208');
    }
  }
  p.ctx.restore();
  // The front corner: a dark seam and a lit edge on the sunward face.
  const [cx0, cy0] = wallPoint(g, 'right', 0, 0);
  rect(p, cx0 - 1, cy0, 1, g.wallH, shade(DARK, 0.08));
  p.ctx.save(); p.ctx.globalAlpha = 0.35;
  rect(p, cx0, cy0, 1, g.wallH, '#fff2d0');
  p.ctx.restore();
}

/**
 * Moss at the foot of every wall and a vine or two climbing it.
 *
 * This is most of what turns a clean isometric box into a building that has
 * stood in a damp forest for years, and it is the same pass on everything so
 * the whole town has weathered together.
 */
function weather(p: Pixels, g: Geometry, seed: number) {
  const r = rng(seed + 977);
  for (const side of ['left', 'right'] as Side[]) {
    for (let i = 0; i < 8; i++) {
      const t = r() * 0.96;
      const v = 0.86 + r() * 0.12;
      const w = 1 + Math.floor(r() * 3);
      wallPatch(p, g, side, t, v, w, 1, r() < 0.6 ? BUILD.mossDark : BUILD.moss);
    }
    // A vine on the shaded face now and then, climbing from the ground.
    if (side === 'left' && r() < 0.5) {
      const t = 0.05 + r() * 0.3;
      const height = 0.45 + r() * 0.4;
      for (let v = 1; v > 1 - height; v -= 0.06) {
        wallPatch(p, g, side, t + Math.sin(v * 9) * 0.02, v, 1, 2, BUILD.vine);
        if (r() < 0.5) wallPatch(p, g, side, t + 0.02, v - 0.02, 2, 1, BUILD.moss);
      }
    }
  }
}

function drawRoof(p: Pixels, g: Geometry, style: RoofStyle, color: RoofColor, overhang: number, seed: number) {
  const [light, mid, dark] = ROOFS[color];
  const halfW = g.bw / 2 + overhang;
  const halfH = g.bh / 2 + overhang / 2;
  const cx = g.cx;
  const cy = g.wallTopY + g.bh / 2;
  const W: [number, number] = [cx - halfW, cy];
  const E: [number, number] = [cx + halfW, cy];
  const N: [number, number] = [cx, cy - halfH];
  const S: [number, number] = [cx, cy + halfH];

  const poly = (points: [number, number][], fill: string) => {
    p.ctx.fillStyle = fill;
    p.ctx.beginPath();
    p.ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) p.ctx.lineTo(points[i][0], points[i][1]);
    p.ctx.closePath();
    p.ctx.fill();
  };

  if (style === 'flat') {
    isoTop(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, mid);
    isoWalls(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, 3, dark, shade(dark, -0.1));
    return;
  }
  // A point on the roof diamond: u runs W->N, v runs W->S.
  const at = (u: number, v: number, up = 0): [number, number] => [W[0] + u * (N[0] - W[0]) + v * (S[0] - W[0]), W[1] + u * (N[1] - W[1]) + v * (S[1] - W[1]) - up];

  if (style === 'mansard') {
    // The township's roof: steep lower slopes to a small flat top, the
    // attic storey inside it. Twice the roof a gable is, in silhouette.
    const h1 = g.roofH * 0.8, k = 0.55;
    const Wt = at(0.5 - k / 2, 0.5 - k / 2, h1), Nt = at(0.5 + k / 2, 0.5 - k / 2, h1), St = at(0.5 - k / 2, 0.5 + k / 2, h1), Et = at(0.5 + k / 2, 0.5 + k / 2, h1);
    poly([W, N, Nt, Wt], shade(dark, -0.12));
    poly([N, E, Et, Nt], shade(dark, -0.04));
    poly([W, S, St, Wt], mid);
    poly([S, E, Et, St], light);
    poly([Wt, Nt, Et, St], shade(mid, 0.18));
    for (let i = 1; i < 5; i++) {
      const t = i / 5;
      p.ctx.strokeStyle = shade(mid, -0.22); p.ctx.lineWidth = 1; p.ctx.beginPath();
      p.ctx.moveTo(W[0] + (Wt[0] - W[0]) * t, W[1] + (Wt[1] - W[1]) * t);
      p.ctx.lineTo(S[0] + (St[0] - S[0]) * t, S[1] + (St[1] - S[1]) * t);
      p.ctx.lineTo(E[0] + (Et[0] - E[0]) * t, E[1] + (Et[1] - E[1]) * t);
      p.ctx.stroke();
    }
    p.ctx.strokeStyle = shade(light, 0.2); p.ctx.lineWidth = 1; p.ctx.beginPath();
    p.ctx.moveTo(Wt[0], Wt[1]); p.ctx.lineTo(St[0], St[1]); p.ctx.lineTo(Et[0], Et[1]); p.ctx.stroke();
    return;
  }
  if (style === 'sawtooth') {
    // The mill roof: three ridges with a glass north face each, so the
    // works are lit from above and read as a works from across the town.
    const rh = Math.max(8, g.roofH * 0.7), strips = 3;
    for (let k = 0; k < strips; k++) {
      const v0 = k / strips, vm = v0 + 0.55 / strips, v1 = (k + 1) / strips;
      poly([at(0, v0), at(1, v0), at(1, vm, rh), at(0, vm, rh)], k % 2 ? mid : shade(mid, 0.06));
      poly([at(0, vm, rh), at(1, vm, rh), at(1, v1), at(0, v1)], '#5aa8c0');
      poly([at(0, vm, rh), at(1, vm, rh), at(1, vm + 0.12 / strips, rh * 0.75), at(0, vm + 0.12 / strips, rh * 0.75)], '#8fd0e0');
      p.ctx.strokeStyle = shade(dark, -0.2); p.ctx.lineWidth = 1; p.ctx.beginPath();
      const a = at(0, vm, rh), b = at(1, vm, rh); p.ctx.moveTo(a[0], a[1]); p.ctx.lineTo(b[0], b[1]); p.ctx.stroke();
    }
    return;
  }
  if (style === 'stepped') {
    // The modern roof: a flat deck with a smaller second storey set back on
    // it, its own band of glass and a flat cap.
    isoTop(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, mid);
    isoWalls(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, 3, dark, shade(dark, -0.1));
    const w2 = g.bw * 0.62, h2 = g.bh * 0.62, rh = g.roofH + 6;
    const cx2 = cx - Math.round(g.bw * 0.06), cy2 = g.wallTopY - 2 - rh + Math.round(g.bh * 0.14);
    isoWalls(p, cx2, cy2, w2, h2, rh, '#969ba2', '#6e7278');
    isoTop(p, cx2, cy2, w2, h2, shade(mid, 0.08));
    isoWalls(p, cx2, cy2 - 2, w2 + 2, h2 + 1, 2, '#dfe4ea', '#b8c0c8');
    // A glass band round the upper storey.
    const halfW2 = w2 / 2, halfH2 = h2 / 2;
    for (let i = 0; i < halfW2; i++) {
      const x = Math.round(cx2 - halfW2 + i), top = Math.round(cy2 + halfH2 + (i * halfH2) / halfW2) + 3;
      rect(p, x, top, 1, 4, i % 6 === 0 ? '#dfe4ea' : '#5aa8c0');
      const xr = Math.round(cx2 + i), topr = Math.round(cy2 + h2 - (i * halfH2) / halfW2) + 3;
      rect(p, xr, topr, 1, 4, i % 6 === 0 ? '#dfe4ea' : '#3a7890');
    }
    return;
  }
  if (style === 'dome') {
    // The AI era's dome: a shell of light over the whole body, brightest
    // where the sun would be, a seam of light round its foot.
    isoTop(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, '#dfe4ea');
    isoWalls(p, cx, g.wallTopY - 2, g.bw + overhang * 2, g.bh + overhang, 3, '#b8c0c8', '#a8b0b8');
    const domeH = g.roofH + 8, rx0 = halfW * 0.86, ry0 = halfH * 0.86, base = g.wallTopY - 2 + (g.bh + overhang) / 2;
    for (let i = 0; i <= domeH; i++) {
      const f = Math.sqrt(Math.max(0, 1 - (i / domeH) ** 2));
      const t = i / domeH;
      const tone = t < 0.35 ? '#c8d0d8' : t < 0.7 ? '#e6eaee' : '#f6f8fa';
      p.ctx.fillStyle = tone;
      p.ctx.beginPath(); p.ctx.ellipse(cx, base - i * 0.9, Math.max(1, rx0 * f), Math.max(1, ry0 * f), 0, 0, Math.PI * 2); p.ctx.fill();
    }
    p.ctx.fillStyle = '#ffffff'; p.ctx.beginPath(); p.ctx.ellipse(cx - rx0 * 0.28, base - domeH * 0.55, rx0 * 0.16, ry0 * 0.16, 0, 0, Math.PI * 2); p.ctx.fill();
    p.ctx.strokeStyle = '#5fd6c8'; p.ctx.lineWidth = 1; p.ctx.beginPath(); p.ctx.ellipse(cx, base, rx0, ry0, 0, 0, Math.PI); p.ctx.stroke();
    return;
  }
  if (style === 'curved') {
    // The AI era's home: a flat roof with a rounded rim and a garden
    // deck, the corners of the body softened by a band of light.
    isoTop(p, cx, g.wallTopY - 4, g.bw + overhang * 2 + 4, g.bh + overhang + 2, '#e9edf1');
    isoWalls(p, cx, g.wallTopY - 4, g.bw + overhang * 2 + 4, g.bh + overhang + 2, 5, '#c8d0d8', '#b0b8c0');
    isoTop(p, cx, g.wallTopY - 2, g.bw + overhang * 2 - 6, g.bh + overhang - 3, mid);
    isoTop(p, cx, g.wallTopY - 1, g.bw * 0.5, g.bh * 0.5, shade(mid, 0.12));
    return;
  }

  /*
   * Courses of tiles on a slope, drawn inside the slope's own outline.
   *
   * `a` and `b` are the two ends of the eave, `ridgeA` and `ridgeB` the
   * points above them on the ridge (the same point twice for a hip). Rows
   * run parallel to the eave, each a step higher and a little narrower.
   * Terracotta and slate get scalloped tiles; thatch gets strokes down the
   * slope and a ragged eave; the moss roof gets plank-like shingles.
   */
  const texture = (a: [number, number], b: [number, number], ridgeA: [number, number], ridgeB: [number, number], base: string, lit: boolean) => {
    p.ctx.save();
    p.ctx.beginPath();
    p.ctx.moveTo(a[0], a[1]); p.ctx.lineTo(b[0], b[1]); p.ctx.lineTo(ridgeB[0], ridgeB[1]); p.ctx.lineTo(ridgeA[0], ridgeA[1]); p.ctx.closePath();
    p.ctx.clip();
    const rr = rng(seed + 17);
    const rows = Math.max(3, Math.round(g.roofH / (color === 'thatch' ? 3 : 4)));
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const x0 = a[0] + (ridgeA[0] - a[0]) * t, y0 = a[1] + (ridgeA[1] - a[1]) * t;
      const x1 = b[0] + (ridgeB[0] - b[0]) * t, y1 = b[1] + (ridgeB[1] - b[1]) * t;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / (len || 1), uy = (y1 - y0) / (len || 1);
      if (color === 'thatch') {
        // Bundles: short strokes down the slope, lighter on the lit side.
        for (let d = 0; d < len; d += 2 + Math.floor(rr() * 2)) {
          const x = x0 + ux * d, y = y0 + uy * d;
          const c = rr() < 0.5 ? shade(base, lit ? 0.12 : 0.04) : shade(base, -0.12);
          rect(p, x, y, 1, 2 + Math.floor(rr() * 3), c);
        }
        rect(p, x0, y0, 0, 0, base);
        p.ctx.strokeStyle = shade(base, -0.22); p.ctx.lineWidth = 1; p.ctx.beginPath(); p.ctx.moveTo(x0, y0 + 0.5); p.ctx.lineTo(x1, y1 + 0.5); p.ctx.stroke();
      } else {
        // A dark seam under the course, then tiles along it with a light lip.
        p.ctx.strokeStyle = shade(base, -0.3); p.ctx.lineWidth = 1; p.ctx.beginPath(); p.ctx.moveTo(x0, y0 + 0.5); p.ctx.lineTo(x1, y1 + 0.5); p.ctx.stroke();
        const tileW = color === 'green' ? 6 : color === 'shingle' ? 3 : 4;
        const offset = i % 2 ? tileW / 2 : 0;
        for (let d = offset; d < len; d += tileW) {
          const x = x0 + ux * d, y = y0 + uy * d;
          // Shakes split unevenly, so they vary more than fired tile does.
          const c = color === 'shingle'
            ? (rr() < 0.3 ? shade(base, lit ? 0.2 : 0.1) : rr() < 0.55 ? shade(base, -0.16) : base)
            : rr() < 0.25 ? shade(base, lit ? 0.16 : 0.06) : rr() < 0.5 ? shade(base, -0.08) : base;
          rect(p, x, y - 2, tileW - 1, 2, c);
          rect(p, x, y - 3, tileW - 1, 1, shade(c, lit ? 0.22 : 0.1));
          rect(p, x + tileW - 2, y - 2, 1, 2, shade(c, -0.25));
        }
      }
    }
    p.ctx.restore();
  };

  if (style === 'hip') {
    const peak: [number, number] = [cx, cy - g.roofH];
    poly([W, N, peak], shade(dark, -0.14));
    poly([N, E, peak], shade(dark, -0.02));
    poly([W, S, peak], mid);
    poly([S, E, peak], light);
    texture(W, S, peak, peak, mid, false);
    texture(S, E, peak, peak, light, true);
    // The hip rafters, caught by the light.
    p.ctx.strokeStyle = shade(light, 0.18); p.ctx.lineWidth = 1; p.ctx.beginPath();
    p.ctx.moveTo(S[0], S[1]); p.ctx.lineTo(peak[0], peak[1]); p.ctx.lineTo(E[0], E[1]); p.ctx.stroke();
    p.ctx.strokeStyle = shade(mid, -0.1); p.ctx.beginPath(); p.ctx.moveTo(W[0], W[1]); p.ctx.lineTo(peak[0], peak[1]); p.ctx.stroke();
  } else {
    const ridgeW: [number, number] = [W[0], W[1] - g.roofH];
    const ridgeE: [number, number] = [E[0], E[1] - g.roofH];
    const ridgeM: [number, number] = [cx, cy - g.roofH];
    // Far slope first, then the near slope over the top of it.
    poly([W, N, E, ridgeE, ridgeW], shade(dark, -0.1));
    poly([W, S, ridgeM, ridgeW], mid);
    // Light catches the eastern half of the near slope: the sun is upper right.
    poly([S, E, ridgeE, ridgeM], light);
    texture(W, S, ridgeW, ridgeM, mid, false);
    texture(S, E, ridgeM, ridgeE, light, true);
    // Bargeboards and the ridge cap.
    p.ctx.strokeStyle = shade(dark, -0.2); p.ctx.lineWidth = 1; p.ctx.beginPath();
    p.ctx.moveTo(W[0], W[1]); p.ctx.lineTo(ridgeW[0], ridgeW[1]); p.ctx.moveTo(E[0], E[1]); p.ctx.lineTo(ridgeE[0], ridgeE[1]); p.ctx.stroke();
    p.ctx.strokeStyle = shade(light, 0.16);
    p.ctx.lineWidth = 2;
    p.ctx.beginPath();
    p.ctx.moveTo(ridgeW[0], ridgeW[1]); p.ctx.lineTo(ridgeE[0], ridgeE[1]);
    p.ctx.stroke();
    if (color === 'thatch') {
      // A ragged eave: the straw hangs past the edge unevenly.
      const rr = rng(seed + 5);
      for (let x = Math.round(W[0]); x < E[0]; x += 2) {
        const t = x < cx ? (x - W[0]) / (cx - W[0]) : (E[0] - x) / (E[0] - cx);
        const y = Math.round(W[1] + t * (S[1] - W[1]));
        rect(p, x, y, 2, 1 + Math.floor(rr() * 3), rr() < 0.5 ? shade(mid, -0.18) : shade(dark, -0.05));
      }
    }
  }
}

function chimney(p: Pixels, g: Geometry, dx: number, height: number): [number, number] {
  const x = Math.round(g.cx + dx);
  const topY = Math.round(g.wallTopY + g.bh / 2 - g.roofH - height + 6);
  rect(p, x - 5, topY, 5, height, shade(BUILD.stoneWall, -0.22));
  rect(p, x, topY, 5, height, BUILD.stoneWall);
  for (let y = topY + 3; y < topY + height; y += 4) {
    rect(p, x - 5, y, 10, 1, shade(BUILD.stoneWallDark, -0.1));
    rect(p, x - 4 + ((y >> 2) % 2) * 3, y - 2, 1, 2, shade(BUILD.stoneWallDark, -0.05));
  }
  rect(p, x - 6, topY - 1, 12, 3, BUILD.stoneWallDark);
  rect(p, x - 6, topY - 2, 12, 1, BUILD.stoneWallLight);
  rect(p, x - 4, topY - 4, 8, 2, '#1e1a16');
  return [x, topY];
}

/* ------------------------------------------------------------------ *
 * Lettering
 * ------------------------------------------------------------------ */

/** A 3x5 capital alphabet, one string per glyph row, `#` for a lit pixel. */
const FONT: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '.#.', '..#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  V: ['#.#', '#.#', '#.#', '.#.', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  ' ': ['...', '...', '...', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
};

const textWidth = (text: string) => text.length * 4 - 1;

function lettering(p: Pixels, x: number, y: number, text: string, color: string) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = FONT[ch] ?? FONT[' '];
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) if (row[rx] === '#') rect(p, cx + rx, y + ry, 1, 1, color);
    });
    cx += 4;
  }
}

/**
 * The name board over the door.
 *
 * Drawn flat to camera, the way the reference does it: a dark plank on the
 * wall with the name in lit green. On the base sprite the letters are bright
 * enough to read by day; on the `lit` overlay they get a halo that only shows
 * after dark, when they become the brightest thing on the building.
 */
function nameBoard(p: Pixels, lit: Pixels, g: Geometry, side: Side, t: number, text: string, strong: boolean) {
  const w = textWidth(text) + 8;
  const h = 11;
  const [ax, ay] = wallPoint(g, side, t, 0.12);
  const x = ax - Math.round(w / 2);
  const y = ay - 2;
  rect(p, x - 1, y - 1, w + 2, h + 2, BUILD.signEdge);
  rect(p, x, y, w, h, BUILD.signBoard);
  rect(p, x, y, w, 1, shade(BUILD.signEdge, 0.2));
  lettering(p, x + 4, y + 3, text, BUILD.sign);
  // Brackets holding it to the wall.
  rect(p, x + 2, y + h + 1, 1, 2, BUILD.metal);
  rect(p, x + w - 3, y + h + 1, 1, 2, BUILD.metal);

  glow(lit, x + w / 2, y + h / 2, Math.max(w, 18) * (strong ? 0.9 : 0.7), BUILD.signGlow, strong ? 0.5 : 0.36);
  lettering(lit, x + 4, y + 3, text, BUILD.signGlow);
}

/** A lit lantern on a bracket, on the base and on the overlay. */
function lantern(p: Pixels, lit: Pixels, x: number, y: number) {
  rect(p, x - 1, y, 3, 1, BUILD.metal);
  rect(p, x, y + 1, 1, 2, BUILD.metal);
  rect(p, x - 2, y + 3, 5, 6, BUILD.metal);
  rect(p, x - 1, y + 4, 3, 4, BUILD.glassLit);
  rect(p, x, y + 5, 1, 2, BUILD.glassLitCore);
  glow(lit, x, y + 6, 11, BUILD.glassLit, 0.55);
  rect(lit, x - 1, y + 4, 3, 4, BUILD.glassLitCore);
}

export interface BuildingArt {
  name: string;
  pixels: Pixels;
  lit: Pixels;
  /** The same building's roof under snow, to lay over it when it snows. */
  snow: Pixels;
  anchorY: number;
  /** Offsets from the ground contact point, in sprite pixels. */
  door: [number, number];
  chimney?: [number, number];
}

interface Recipe {
  bw: number; wallH: number; roofH: number; roof: RoofStyle; wall: WallStyle; roofColor: RoofColor;
  overhang?: number;
  windows?: [Side, number, number][];
  door?: [Side, number];
  chimneyAt?: number;
  chimneyH?: number;
  /** The name on the board over the door, if the building wears one. */
  sign?: string;
  extras?: (p: Pixels, lit: Pixels, g: Geometry, seed: number) => void;
  /** The era whose structural dressing this body wears, when it is a later era's rebuild. */
  eraLook?: 1 | 2 | 3 | 4 | 5;
}

/** The great works keep the look they were raised in, through every age after. */
const GREAT_WORK_NAMES = new Set(['Terraced Gardens', 'Aqueduct', 'Great Library', 'Grand Exchange', 'Observatory']);

const BOTTOM_MARGIN = 6;
const TOP_MARGIN = 30;

/** How far a building has been improved: 1 is as raised, 3 is as good as it gets. */
export type ArtLevel = 1 | 2 | 3;

function buildOne(name: string, seed: number, r: Recipe, level: ArtLevel): BuildingArt {
  const bw = r.bw;
  const bh = Math.round(bw / 2);
  const overhang = r.overhang ?? 5;
  // The frame grows a little with each improvement, so a level-three house is
  // visibly the taller building on the lane and not just a dressed-up one.
  const wallH = r.wallH + (level === 2 ? 3 : level === 3 ? 7 : 0);
  const canvasW = bw + overhang * 2 + 44;
  const canvasH = TOP_MARGIN + r.roofH + wallH + bh + BOTTOM_MARGIN;
  const p = surface(canvasW, canvasH);
  const lit = surface(canvasW, canvasH);
  const g: Geometry = {
    cx: Math.round(canvasW / 2),
    wallTopY: TOP_MARGIN + r.roofH,
    bw, bh, wallH, roofH: r.roofH,
    groundY: canvasH - BOTTOM_MARGIN,
    canvasH,
  };

  // The sun is upper right: the shadow falls away to the lower left.
  groundShadow(p, g.cx - bw * 0.1, g.groundY - 2, bw * 0.58, bh * 0.4, 0.34);

  // Stone plinth under the walls so buildings sit into the ground.
  isoWalls(p, g.cx, g.wallTopY + 3, bw + 4, bh + 2, wallH, shade(GROUND.stoneDark, -0.2), GROUND.stoneDark);

  // The left face is the shaded one, the right face the lit one.
  const [wLight, wMid] = WALLS[r.wall];
  isoWalls(p, g.cx, g.wallTopY, bw, bh, wallH, shade(wMid, -0.16), wMid);
  isoTop(p, g.cx, g.wallTopY, bw, bh, wLight);
  paintWallTexture(p, g, r.wall, seed);
  ambientOcclusion(p, g);

  // Windows: a timber frame, a cross of mullions, a sill, and warm glass —
  // the reference's houses glow a little even by day. At the top level a
  // second row goes in above the first, the way a building that has been
  // extended upward gets one.
  const windows = [...(r.windows ?? [])];
  if (level === 3) for (const [side, t, v] of r.windows ?? []) if (v > 0.3) windows.push([side, t, v - 0.34]);
  for (const [side, t, v] of windows) {
    const frame = side === 'left' ? shade(BUILD.timberDark, -0.1) : BUILD.timberDark;
    wallPatch(p, g, side, t, v, 9, 10, frame);
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 7, side === 'left' ? shade('#c98a44', -0.25) : '#d69a4e');
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 2, side === 'left' ? shade(BUILD.glassDark, 0.1) : shade(BUILD.glassDark, 0.3));
    wallPatch(p, g, side, t + 0.03, v + 0.14, 3, 3, side === 'left' ? '#e8b868' : '#f6d48c');
    // Mullions and the sill.
    wallPatch(p, g, side, t + 0.03 + 0.012, v + 0.06, 1, 7, frame);
    wallPatch(p, g, side, t + 0.012, v + 0.06 + 3 / g.wallH, 7, 1, frame);
    wallPatch(p, g, side, t - 0.006, v + 10 / g.wallH, 11, 1, shade(BUILD.plasterLight, side === 'left' ? -0.2 : 0.05));
    wallPatch(lit, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassLit);
    wallPatch(lit, g, side, t + 0.03, v + 0.1, 3, 4, BUILD.glassLitCore);
  }

  const doorSpec = r.door ?? (['right', 0.42] as [Side, number]);
  const [dSide, dT] = doorSpec;
  // An arched doorway: a stone surround, planked timber inside it, a step.
  const doorH = Math.round(wallH * 0.7);
  wallPatch(p, g, dSide, dT - 0.012, 0.3, 14, doorH + 2, shade(BUILD.stoneWallLight, -0.05));
  wallPatch(p, g, dSide, dT, 0.3, 12, doorH, BUILD.timberDark);
  for (let i = 1; i < 12; i += 3) wallPatch(p, g, dSide, dT + i / g.bw, 0.34, 2, doorH - 2, BUILD.timber);
  for (const [dx, dy, w] of [[1, -2, 10], [3, -3, 6], [5, -4, 2]] as [number, number, number][]) {
    wallPatch(p, g, dSide, dT + dx / g.bw, 0.3 + dy / g.wallH, w, 1, BUILD.timberDark);
    wallPatch(p, g, dSide, dT + (dx - 1) / g.bw, 0.3 + (dy - 1) / g.wallH, w + 2, 1, shade(BUILD.stoneWallLight, -0.05));
  }
  wallPatch(p, g, dSide, dT + 0.09, 0.58, 2, 2, BUILD.gold);
  wallPatch(p, g, dSide, dT - 0.02, 1 - 2 / g.wallH, 16, 2, BUILD.stoneWallLight);
  wallPatch(p, g, dSide, dT - 0.02, 1 - 1 / g.wallH, 16, 1, BUILD.stoneWallDark);
  // Light spilling out of the doorway after dark.
  wallPatch(lit, g, dSide, dT + 0.03, 0.4, 7, Math.round(wallH * 0.5), shade(BUILD.glassLit, -0.3));

  let chimneyOffset: [number, number] | undefined;
  if (r.chimneyAt !== undefined) {
    const [cxp, cyp] = chimney(p, g, r.chimneyAt, r.chimneyH ?? 20);
    chimneyOffset = [cxp - g.cx, cyp - g.groundY];
  }

  weather(p, g, seed);
  drawRoof(p, g, r.roof, r.roofColor, overhang, seed);
  // The eave's shadow on the wall, under the overhang.
  p.ctx.save();
  for (let i = 0; i < 4; i++) {
    p.ctx.globalAlpha = 0.28 * (1 - i / 4);
    wallPatch(p, g, 'left', 0, i / wallH, Math.round(bw / 2), 1, '#1a1208');
    wallPatch(p, g, 'right', 0, i / wallH, Math.round(bw / 2), 1, '#1a1208');
  }
  p.ctx.restore();
  r.extras?.(p, lit, g, seed);
  // A later era's rebuild of the body: what that era does to every building.
  if (r.eraLook) {
    const stack = ERA_LOOK[r.eraLook](p, lit, g, r, seed, [dSide, dT], overhang);
    if (stack && !chimneyOffset) chimneyOffset = [stack[0] - g.cx, stack[1] - g.groundY];
  }

  // Improvements, on top of everything the building already is.
  if (level >= 2) {
    // Lanterns either side of the door, and a banner on the far face.
    const [lx, ly] = wallPoint(g, dSide, dT - 0.1, 0.3);
    const [rx, ry] = wallPoint(g, dSide, dT + 0.3, 0.3);
    lantern(p, lit, lx, ly);
    lantern(p, lit, rx, ry);
    const other: Side = dSide === 'left' ? 'right' : 'left';
    wallPatch(p, g, other, 0.7, 0.1, 9, Math.round(wallH * 0.5), BUILD.roofGreenDark);
    wallPatch(p, g, other, 0.71, 0.12, 7, Math.round(wallH * 0.44), BUILD.roofGreen);
    wallPatch(p, g, other, 0.74, 0.22, 3, 3, BUILD.gold);
    wallPatch(p, g, other, 0.68, 0.08, 11, 1, BUILD.timberLight);
  }
  if (level === 3) {
    // A glass annex against the far face, lit from inside, and planters at
    // the door: the building has been rebuilt rather than patched.
    const other: Side = dSide === 'left' ? 'right' : 'left';
    const t = other === 'left' ? 0.08 : 0.66;
    wallPatch(p, g, other, t, 0.36, 18, Math.round(wallH * 0.64), BUILD.timberDark);
    wallPatch(p, g, other, t + 0.012, 0.4, 16, Math.round(wallH * 0.58), BUILD.labGlass);
    wallPatch(p, g, other, t + 0.05, 0.46, 3, Math.round(wallH * 0.44), shade(BUILD.labGlass, 0.35));
    wallPatch(lit, g, other, t + 0.012, 0.4, 16, Math.round(wallH * 0.58), BUILD.labGlassLit);
    wallPatch(lit, g, other, t + 0.05, 0.5, 5, Math.round(wallH * 0.3), BUILD.labCore);
    for (let i = 0; i < 20; i++) wallPatch(p, g, other, t - 0.01 + i / g.bw, 0.3 + (i / 20) * 0.05, 1, 4, BUILD.metal);
    for (const dt of [-0.2, 0.36]) {
      wallPatch(p, g, dSide, dT + dt, 0.82, 8, 5, BUILD.timberDark);
      wallPatch(p, g, dSide, dT + dt + 0.01, 0.72, 6, 4, FOLIAGE.bush);
      wallPatch(p, g, dSide, dT + dt + 0.03, 0.7, 2, 2, BLOOM.pink);
    }
    // Gold trim along the eave.
    wallBand(p, g, 'left', -0.06, 2, BUILD.gold);
    wallBand(p, g, 'right', -0.06, 2, BUILD.gold);
  }

  if (r.sign) nameBoard(p, lit, g, dSide, dT + 0.16, r.sign, level === 3);
  outline(p, DARK, 0.95);

  // Door position in sprite space, measured from the ground contact point.
  const doorHalfW = bw / 2;
  const doorHalfH = bh / 2;
  const doorX = dSide === 'left' ? -doorHalfW + dT * doorHalfW * 2 * 0.5 : dT * doorHalfW;
  const doorEdgeY = dSide === 'left' ? doorHalfH + dT * doorHalfH : bh - dT * doorHalfH;
  const doorY = g.wallTopY + doorEdgeY + wallH - g.groundY;

  return {
    name: level === 1 ? name : `${name}.L${level}`,
    pixels: p,
    lit,
    snow: snowCap(p, g, overhang),
    anchorY: (canvasH - BOTTOM_MARGIN) / canvasH,
    door: [Math.round(doorX), Math.round(doorY)],
    chimney: chimneyOffset,
  };
}

/**
 * The roof under snow.
 *
 * Every building sits on the same roof diamond — the wall footprint plus the
 * overhang — whatever shape the roof over it takes, so the snow is laid on
 * everything drawn above that diamond's lower edges: the slopes, the ridge,
 * the chimney, a tower, a set-back upper storey. The roof's own shading is
 * kept as the snow's shading, so the ridge and the eave still read, and the
 * silhouette's dark outline becomes a pale rim, which is what the edge of a
 * snow-covered roof looks like.
 */
function snowCap(p: Pixels, g: Geometry, overhang: number): Pixels {
  const out = surface(p.w, p.h);
  const src = p.ctx.getImageData(0, 0, p.w, p.h);
  const img = out.ctx.createImageData(p.w, p.h);
  const halfW = g.bw / 2 + overhang;
  const halfH = g.bh / 2 + overhang / 2;
  const cy = g.wallTopY + g.bh / 2;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (src.data[i + 3] < 40) continue;
      const eave = cy + halfH * (1 - Math.min(1, Math.abs(x - g.cx) / halfW));
      if (y > eave + 1) continue;
      const l = (src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114) / 255;
      const t = 0.5 + l * 0.5;
      img.data[i] = Math.round(190 + 65 * t);
      img.data[i + 1] = Math.round(206 + 49 * t);
      img.data[i + 2] = Math.round(224 + 31 * t);
      img.data[i + 3] = 236;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * Per-type detailing
 * ------------------------------------------------------------------ */

function awning(p: Pixels, g: Geometry, side: Side, color: string) {
  for (let i = 0; i < g.bw / 2; i++) {
    const t = i / (g.bw / 2);
    const x = side === 'left' ? g.cx - g.bw / 2 + i : g.cx + i;
    const y = (side === 'left' ? g.wallTopY + g.bh / 2 + t * g.bh / 2 : g.wallTopY + g.bh - t * g.bh / 2) + g.wallH * 0.34;
    rect(p, x, y, 1, 7, i % 8 < 4 ? color : shade(color, -0.4));
  }
}

/** A small roof on posts over the front door. */
function porch(p: Pixels, g: Geometry, side: Side, t: number, color: string) {
  wallPatch(p, g, side, t - 0.02, 0.34, 2, Math.round(g.wallH * 0.66), BUILD.timberDark);
  wallPatch(p, g, side, t + 0.16, 0.34, 2, Math.round(g.wallH * 0.66), BUILD.timberDark);
  for (let i = 0; i < 16; i++) {
    wallPatch(p, g, side, t - 0.03 + i / g.bw, 0.26, 1, 5, i % 5 < 3 ? color : shade(color, -0.25));
  }
}

/** A small extension built against one wall, breaking up the silhouette. */
function leanTo(p: Pixels, g: Geometry, side: Side, roof: string, wall: string) {
  const t = side === 'left' ? 0.06 : 0.72;
  wallPatch(p, g, side, t, 0.32, 18, Math.round(g.wallH * 0.7), wall);
  wallPatch(p, g, side, t, 0.32, 18, 2, shade(wall, 0.2));
  for (let i = 0; i < 20; i++) {
    wallPatch(p, g, side, t - 0.01 + i / g.bw, 0.24 + (i / 20) * 0.06, 1, 5, roof);
  }
  wallPatch(p, g, side, t + 0.07, 0.5, 6, Math.round(g.wallH * 0.5), BUILD.timberDark);
}

/** A big shop window, lit warm, with something on show in it. */
function shopWindow(p: Pixels, lit: Pixels, g: Geometry, side: Side, t: number, v: number, w: number, h: number) {
  wallPatch(p, g, side, t, v, w + 2, h + 3, BUILD.timberDark);
  wallPatch(p, g, side, t + 0.012, v + 0.04, w, h, shade(BUILD.glassLit, -0.5));
  wallPatch(lit, g, side, t + 0.012, v + 0.04, w, h, BUILD.glassLit);
  wallPatch(lit, g, side, t + 0.03, v + 0.08, Math.round(w * 0.4), Math.round(h * 0.5), BUILD.glassLitCore);
}

/** The lab's glass cube: a cold, lit box against the wall. */
function glassCube(p: Pixels, lit: Pixels, g: Geometry, side: Side, t: number) {
  const w = 26;
  const h = Math.round(g.wallH * 0.9);
  wallPatch(p, g, side, t, 0.08, w + 2, h + 2, BUILD.metal);
  wallPatch(p, g, side, t + 0.012, 0.1, w, h, BUILD.labGlass);
  // Mullions.
  for (const dt of [0.09, 0.18]) wallPatch(p, g, side, t + dt, 0.1, 1, h, BUILD.metal);
  wallPatch(p, g, side, t + 0.012, 0.45, w, 1, BUILD.metal);
  // Something bright growing inside.
  wallPatch(p, g, side, t + 0.1, 0.5, 6, 6, BUILD.labGlassLit);
  wallPatch(p, g, side, t + 0.12, 0.55, 2, 2, BUILD.labCore);
  wallPatch(lit, g, side, t + 0.012, 0.1, w, h, shade(BUILD.labGlassLit, -0.35));
  wallPatch(lit, g, side, t + 0.08, 0.42, 10, 10, BUILD.labGlassLit);
  wallPatch(lit, g, side, t + 0.11, 0.52, 4, 4, BUILD.labCore);
  const [gx, gy] = wallPoint(g, side, t + 0.15, 0.55);
  glow(lit, gx, gy, 26, BUILD.labGlassLit, 0.45);
}

/** A café table with a striped umbrella, out on the terrace. */
function umbrellaTable(p: Pixels, x: number, y: number, color: string) {
  rect(p, x - 5, y, 10, 3, BUILD.timber);
  rect(p, x - 5, y, 10, 1, BUILD.timberLight);
  rect(p, x - 1, y - 12, 2, 12, BUILD.metal);
  for (let i = 0; i < 16; i++) {
    const dy = Math.round(Math.abs(i - 8) * 0.45);
    rect(p, x - 8 + i, y - 16 + dy, 1, 3, i % 4 < 2 ? color : BUILD.plasterLight);
  }
  rect(p, x - 8, y - 12, 16, 1, shade(color, -0.4));
}

const RECIPES: Record<string, Recipe> = {
  // A monument: a stone plinth with an obelisk, bought as prestige. Drawn
  // narrow so it reads as a column in the square rather than a building.
  Monument: {
    bw: 44, wallH: 12, roofH: 6, roof: 'hip', wall: 'stone', roofColor: 'slate', overhang: 2,
    windows: [], door: ['right', 0.5],
    extras: (p, lit, g) => {
      const x = g.cx, top = g.wallTopY - 58;
      rect(p, x - 7, top + 10, 14, 48, BUILD.stoneWallDark);
      rect(p, x - 6, top + 10, 6, 48, BUILD.stoneWall);
      rect(p, x - 5, top + 2, 10, 8, BUILD.stoneWallDark);
      rect(p, x - 4, top + 2, 4, 8, BUILD.stoneWall);
      rect(p, x - 3, top - 4, 6, 6, BUILD.gold);
      rect(p, x - 1, top - 8, 2, 4, BUILD.gold);
      rect(lit, x - 3, top - 4, 6, 6, BUILD.glassLit);
    },
  },
  /*
   * The great works: a city's monuments, on a scale nothing else is.
   *
   * Each is drawn wide and low or tall and narrow so it reads as itself from
   * across the map, and each keeps its own look through every age rather
   * than being redressed — a city that built an aqueduct in the township
   * still has that aqueduct in the AI era.
   */
  'Terraced Gardens': {
    // A wide retaining base with the planted terraces standing on it. The
    // flat roof is drawn as a thin slab whatever `roofH` says, so the height
    // here only buys the sprite headroom for what is built on top.
    bw: 96, wallH: 18, roofH: 22, roof: 'flat', wall: 'stone', roofColor: 'garden', overhang: 3,
    windows: [], door: ['right', 0.5],
    extras: (p, _lit, g) => {
      const x = g.cx;
      // The middle of the platform: everything above is stacked from here, so
      // the terraces stand *on* the base rather than hovering over it.
      const mid = g.wallTopY + g.bh / 2;
      const tiers: [number, number][] = [[76, 0], [54, 9], [32, 18]];
      for (const [w, lift] of tiers) {
        const h = Math.round(w / 2);
        const topY = Math.round(mid - lift - h / 2);
        // The retaining wall, then the planted bed laid over the whole top.
        isoWalls(p, x, topY, w, h, 10, shade(BUILD.stoneWallDark, -0.12), BUILD.stoneWallDark);
        isoTop(p, x, topY, w, h, BUILD.stoneWallLight);
        isoTop(p, x, topY + 2, w - 8, h - 4, '#4a8a3a');
        isoTop(p, x, topY + 3, w - 20, h - 10, '#3f7a34');
        // Shrubs standing out of the bed, in rows along the terrace.
        const cy = topY + h / 2;
        for (let row = -2; row <= 2; row++) {
          const span = Math.round((w / 2) * (1 - Math.abs(row) / 3.2)) - 8;
          for (let s = -span; s <= span; s += 9) {
            const px = Math.round(x + s), py = Math.round(cy + row * (h / 6));
            rect(p, px - 2, py - 4, 5, 5, '#2f6028');
            rect(p, px - 2, py - 5, 4, 3, '#6fb04a');
            rect(p, px - 1, py - 6, 2, 2, '#8fce62');
          }
        }
      }
      // A cypress at each end of the lowest terrace, for the silhouette.
      for (const dx of [-40, 40]) {
        const by = Math.round(mid + Math.abs(dx) * 0.02);
        rect(p, x + dx - 2, by - 5, 4, 7, '#5a4230');
        for (let i = 0; i < 20; i++) {
          const w = Math.max(3, Math.round(11 * (1 - i / 23)));
          const half = Math.round(w / 2);
          rect(p, x + dx - half, by - 7 - i, w, 1, i % 4 === 0 ? '#3f7a34' : '#2f6028');
          rect(p, x + dx + half - 2, by - 7 - i, 1, 1, '#4a8a3a');
        }
        rect(p, x + dx - 1, by - 28, 3, 2, '#4a8a3a');
      }
    },
  },
  Aqueduct: {
    // A small stone footing under an arcade that strides well past it on both
    // sides, so the sky shows through the outer arches and the thing reads as
    // a structure crossing the ground rather than a shed with arches on top.
    bw: 52, wallH: 14, roofH: 34, roof: 'flat', wall: 'stone', roofColor: 'white', overhang: 2,
    windows: [], door: ['right', 0.5],
    extras: (p, _lit, g) => {
      const x = g.cx;
      const mid = g.wallTopY + g.bh / 2;
      // The footing's top, repainted in the same stone as the piers, so the
      // arcade and what it stands on are plainly one piece of masonry.
      isoTop(p, x, g.wallTopY - 2, g.bw + 4, g.bh + 2, BUILD.stoneWallLight);
      isoTop(p, x, g.wallTopY, g.bw - 10, g.bh - 5, BUILD.stoneWall);
      /**
       * One tier of an arcade: piers, the spandrel between them, and the
       * arches cut out of it as real openings rather than painted-on holes,
       * so the sky shows through the way it does under a real aqueduct.
       */
      const arcade = (footY: number, halfW: number, height: number, bays: number) => {
        const span = (halfW * 2) / bays;
        const pierW = Math.max(5, Math.round(span * 0.26));
        const deck = 6;
        const top = footY - height;
        // The deck the arches carry, and the piers standing under it.
        rect(p, x - halfW, top, halfW * 2, deck, BUILD.stoneWall);
        rect(p, x - halfW, top, halfW * 2, 2, BUILD.stoneWallLight);
        rect(p, x - halfW, top + deck - 1, halfW * 2, 1, BUILD.stoneWallDark);
        for (let i = 0; i <= bays; i++) {
          const px = Math.round(x - halfW + i * span - pierW / 2);
          rect(p, px, top + deck, pierW, height - deck, BUILD.stoneWall);
          rect(p, px, top + deck, 2, height - deck, BUILD.stoneWallLight);
          rect(p, px + pierW - 1, top + deck, 1, height - deck, BUILD.stoneWallDark);
        }
        // The spandrel, carried down each side of every opening as an arch.
        for (let i = 0; i < bays; i++) {
          const left = Math.round(x - halfW + i * span + pierW / 2);
          const w = Math.round(span - pierW);
          const r = Math.round(w / 2);
          for (let t = 0; t < r; t++) {
            const half = Math.round(Math.sqrt(Math.max(0, r * r - (r - t) * (r - t))));
            const fill = r - half;
            if (fill <= 0) continue;
            rect(p, left, top + deck + t, fill, 1, BUILD.stoneWall);
            rect(p, left + w - fill, top + deck + t, fill, 1, BUILD.stoneWall);
            // The voussoirs on the lit side of each arch.
            rect(p, left + w - fill, top + deck + t, 1, 1, BUILD.stoneWallLight);
          }
        }
      };
      // The piers stand on the footing's front face; the upper tier on the
      // deck of the lower one.
      const foot = Math.round(mid + 2);
      arcade(foot, 46, 32, 4);
      arcade(foot - 32, 38, 24, 6);
      // The channel along the top, with water catching the light in it.
      const chan = foot - 56;
      rect(p, x - 40, chan - 7, 80, 7, BUILD.stoneWallLight);
      rect(p, x - 40, chan - 7, 80, 1, BUILD.stoneWall);
      rect(p, x - 37, chan - 5, 74, 3, shade(WATER.deep, 0.25));
      rect(p, x - 37, chan - 5, 74, 1, WATER.foam);
    },
  },
  'Great Library': {
    bw: 82, wallH: 40, roofH: 20, roof: 'hip', wall: 'stone', roofColor: 'slate', overhang: 5,
    windows: [['left', 0.24, 0.34], ['left', 0.62, 0.34], ['right', 0.3, 0.34], ['right', 0.68, 0.34]],
    door: ['right', 0.5],
    extras: (p, lit, g) => {
      // A colonnade across the front, and a pediment with a lit lamp in it.
      const x = g.cx, top = g.wallTopY;
      for (let i = -3; i <= 3; i++) {
        const cx = x + i * 11;
        rect(p, cx - 3, top + 6, 6, 34, BUILD.stoneWallLight);
        rect(p, cx - 3, top + 6, 2, 34, BUILD.stoneWall);
        rect(p, cx - 5, top + 3, 10, 4, BUILD.stoneWallLight);
        rect(p, cx - 5, top + 38, 10, 4, BUILD.stoneWallDark);
      }
      rect(p, x - 40, top - 2, 80, 6, BUILD.stoneWallLight);
      rect(p, x - 6, top - 12, 12, 10, BUILD.stoneWallDark);
      rect(p, x - 3, top - 9, 6, 5, BUILD.glassLit);
      glow(lit, x, top - 7, 12, BUILD.glassLit, 0.5);
    },
  },
  'Grand Exchange': {
    // A hall with arcaded trading bays down both faces and a glazed lantern
    // seated on the ridge — not a chapel, so nothing rises to a point.
    bw: 100, wallH: 36, roofH: 16, roof: 'hip', wall: 'stone', roofColor: 'red', overhang: 6,
    windows: [],
    door: ['right', 0.5],
    extras: (p, lit, g) => {
      const x = g.cx;
      // Tall arched bays cut into both visible faces, glazed and lit.
      for (const side of ['left', 'right'] as Side[]) {
        for (const t of [0.08, 0.3, 0.52, 0.74]) {
          if (side === 'right' && t > 0.4 && t < 0.62) continue; // room for the door
          wallPatch(p, g, side, t, 0.16, 14, 24, shade(BUILD.stoneWallDark, -0.1));
          wallPatch(p, g, side, t + 0.012, 0.2, 12, 20, side === 'left' ? shade(BUILD.glassDark, -0.1) : BUILD.glassDark);
          wallPatch(p, g, side, t + 0.05, 0.24, 3, 14, side === 'left' ? '#4a6f86' : '#5f8aa4');
          wallPatch(p, g, side, t - 0.006, 0.14, 16, 2, BUILD.stoneWallLight);
          wallPatch(p, g, side, t - 0.006, 0.62, 16, 2, BUILD.stoneWallLight);
          wallPatch(lit, g, side, t + 0.012, 0.2, 12, 20, BUILD.glassLit);
        }
        // A gilded band along the head of the arcade.
        wallBand(p, g, side, 0.1, 2, BUILD.gold);
      }
      // The lantern on the ridge: a glazed drum with a shallow cap, standing
      // in the roof rather than hovering over it.
      const ridge = Math.round(g.wallTopY + g.bh / 2 - g.roofH + 4);
      isoWalls(p, x, ridge - 4, 40, 20, 18, shade(BUILD.stoneWall, -0.2), BUILD.stoneWall);
      for (let i = 0; i < 5; i++) {
        const px = x - 18 + i * 8;
        rect(p, px - 1, ridge + 7, 7, 14, shade(BUILD.stoneWallDark, -0.15));
        rect(p, px, ridge + 8, 5, 12, shade(BUILD.glassLit, -0.42));
        rect(p, px + 1, ridge + 10, 3, 7, shade(BUILD.glassLit, -0.18));
        rect(lit, px, ridge + 8, 5, 12, BUILD.glassLit);
      }
      isoTop(p, x, ridge - 12, 46, 23, BUILD.roofRed);
      isoTop(p, x, ridge - 10, 30, 15, BUILD.roofRedLight);
      glow(lit, x, ridge + 10, 30, BUILD.glassLit, 0.4);
      // A weather vane: a bar and a pointer, not a cross.
      rect(p, x - 1, ridge - 22, 2, 12, BUILD.metal);
      rect(p, x - 8, ridge - 20, 16, 2, BUILD.gold);
      rect(p, x + 6, ridge - 22, 4, 6, BUILD.gold);
      rect(p, x - 2, ridge - 25, 4, 4, BUILD.gold);
    },
  },
  Observatory: {
    // A drum tower standing in a low stone yard, with a slit dome on it.
    bw: 58, wallH: 26, roofH: 34, roof: 'flat', wall: 'stone', roofColor: 'slate', overhang: 3,
    windows: [['left', 0.3, 0.4], ['right', 0.6, 0.4]],
    door: ['right', 0.5],
    extras: (p, lit, g) => {
      const x = g.cx;
      const mid = g.wallTopY + g.bh / 2;
      // The drum: its walls run down into the yard, so the two are one thing.
      const drumTop = Math.round(mid - 30);
      isoWalls(p, x, drumTop, 34, 17, 42, shade(BUILD.stoneWall, -0.18), BUILD.stoneWall);
      for (let band = 1; band <= 3; band++) {
        const by = drumTop + 8 + band * 11;
        for (let i = 0; i < 17; i++) {
          rect(p, x - 17 + i, by + Math.round((i * 8.5) / 17), 1, 2, BUILD.stoneWallDark);
          rect(p, x + i, by + 8 - Math.round((i * 8.5) / 17), 1, 2, BUILD.stoneWallDark);
        }
      }
      isoTop(p, x, drumTop, 34, 17, BUILD.stoneWallLight);
      // The dome: a ring of shells, each narrower and higher than the last.
      isoWalls(p, x, drumTop - 4, 40, 20, 5, shade(BUILD.metalLight, -0.28), shade(BUILD.metalLight, -0.06));
      const shells: [number, number][] = [[40, 0], [34, 4], [26, 7], [16, 9], [8, 10]];
      for (const [w, lift] of shells) {
        const h = Math.round(w / 2);
        const topY = Math.round(drumTop + 6 - lift - h / 2 - 8);
        isoTop(p, x, topY, w, h, shade(BUILD.metalLight, lift / 40));
        for (let i = 0; i < w / 2; i++) rect(p, Math.round(x - w / 2 + i), Math.round(topY + h / 2 + (i * h) / w), 1, 1, shade(BUILD.metalLight, -0.22));
      }
      // The shutter slit, open, with the instrument sighting out of it.
      rect(p, x - 4, drumTop - 15, 9, 16, BUILD.glassDark);
      rect(p, x - 3, drumTop - 14, 7, 15, BUILD.labGlassLit);
      rect(p, x - 5, drumTop - 16, 2, 18, shade(BUILD.metalLight, -0.3));
      rect(p, x + 4, drumTop - 16, 2, 18, shade(BUILD.metalLight, -0.3));
      rect(lit, x - 3, drumTop - 14, 7, 15, BUILD.labGlassLit);
      // The tube, tilted up to the right, on its mounting.
      for (let i = 0; i < 20; i++) {
        const ty = Math.round(drumTop - 10 - i * 0.5);
        rect(p, x + i, ty, 1, 5, BUILD.metal);
        rect(p, x + i, ty, 1, 1, BUILD.metalLight);
      }
      rect(p, x + 19, drumTop - 22, 5, 9, BUILD.metalLight);
      rect(p, x + 20, drumTop - 21, 3, 7, shade(BUILD.glassDark, 0.1));
      rect(p, x + 1, drumTop - 8, 4, 7, shade(BUILD.metal, -0.2));
      glow(lit, x, drumTop - 6, 20, BUILD.labGlassLit, 0.45);
    },
  },
  // Eight homes with genuinely different outlines: a settlement of twenty
  // houses built from three designs reads as a housing estate.
  'House.0': {
    bw: 76, wallH: 26, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'green',
    windows: [['left', 0.2, 0.24], ['left', 0.62, 0.24], ['right', 0.68, 0.24]],
    door: ['right', 0.26], chimneyAt: -20, chimneyH: 20,
  },
  'House.1': {
    bw: 70, wallH: 22, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'thatch', overhang: 8,
    windows: [['left', 0.28, 0.3], ['right', 0.6, 0.3]],
    door: ['right', 0.22], chimneyAt: 16, chimneyH: 16,
    extras: (p, _lit, g) => porch(p, g, 'right', 0.2, BUILD.roofThatchDark),
  },
  'House.2': {
    bw: 80, wallH: 28, roofH: 30, roof: 'hip', wall: 'stone', roofColor: 'green',
    windows: [['left', 0.22, 0.22], ['left', 0.66, 0.22], ['right', 0.7, 0.22]],
    door: ['right', 0.3], chimneyAt: -18, chimneyH: 22,
  },
  // Two storeys: the tallest thing on a residential lane.
  'House.3': {
    bw: 66, wallH: 44, roofH: 22, roof: 'gable', wall: 'plaster', roofColor: 'slate',
    windows: [['left', 0.22, 0.12], ['left', 0.64, 0.12], ['right', 0.66, 0.12], ['left', 0.22, 0.52], ['right', 0.66, 0.52]],
    door: ['right', 0.24], chimneyAt: -16, chimneyH: 26,
  },
  // Long and low, with a lean-to on the end.
  'House.4': {
    bw: 92, wallH: 20, roofH: 22, roof: 'gable', wall: 'timber', roofColor: 'thatch', overhang: 9,
    windows: [['left', 0.3, 0.24], ['left', 0.62, 0.24]],
    door: ['right', 0.5], chimneyAt: 24, chimneyH: 16,
    extras: (p, _lit, g) => leanTo(p, g, 'right', BUILD.roofThatchDark, BUILD.timberLight),
  },
  // Stone cottage with a deep porch.
  'House.5': {
    bw: 72, wallH: 26, roofH: 24, roof: 'hip', wall: 'stone', roofColor: 'slate',
    windows: [['left', 0.24, 0.26], ['right', 0.68, 0.26]],
    door: ['right', 0.3], chimneyAt: -18, chimneyH: 24,
    extras: (p, _lit, g) => porch(p, g, 'right', 0.26, BUILD.roofSlateDark),
  },
  // Narrow townhouse with a steep roof.
  'House.6': {
    bw: 58, wallH: 34, roofH: 34, roof: 'gable', wall: 'dark', roofColor: 'red', overhang: 4,
    windows: [['left', 0.28, 0.16], ['right', 0.6, 0.16], ['left', 0.28, 0.58]],
    door: ['right', 0.24], chimneyAt: 14, chimneyH: 22,
  },
  // Log cabin with a broad chimney breast.
  'House.7': {
    bw: 78, wallH: 24, roofH: 26, roof: 'gable', wall: 'log', roofColor: 'green', overhang: 8,
    windows: [['left', 0.3, 0.26], ['right', 0.66, 0.26]],
    door: ['right', 0.3], chimneyAt: -24, chimneyH: 28,
    extras: (p, _lit, g) => leanTo(p, g, 'left', BUILD.roofGreenDark, FOLIAGE.trunkLight),
  },
  Market: {
    bw: 112, wallH: 22, roofH: 26, roof: 'hip', wall: 'timber', roofColor: 'green', overhang: 10,
    windows: [],
    door: ['right', 0.44], sign: 'MARKET',
    extras: (p, _lit, g) => {
      awning(p, g, 'left', BUILD.roofGreenLight);
      awning(p, g, 'right', BUILD.roofGreen);
      // Produce laid out along the open front.
      const r = rng(4041);
      for (let i = 0; i < 12; i++) {
        const t = 0.08 + r() * 0.8;
        wallPatch(p, g, r() < 0.5 ? 'left' : 'right', t, 0.62, 4, 4, [BLOOM.wheat, BLOOM.red, FOLIAGE.bushLight, BLOOM.yellow][Math.floor(r() * 4)]);
      }
    },
  },
  Bank: {
    bw: 90, wallH: 36, roofH: 20, roof: 'hip', wall: 'stone', roofColor: 'slate', overhang: 8,
    windows: [['left', 0.24, 0.2], ['left', 0.62, 0.2], ['right', 0.28, 0.2], ['right', 0.66, 0.2]],
    door: ['right', 0.46], sign: 'BANK',
    extras: (p, lit, g) => {
      // Portico columns across the front faces.
      for (const t of [0.14, 0.34, 0.56, 0.78]) {
        wallPatch(p, g, 'right', t, 0, 5, g.wallH, BUILD.stoneWallLight);
        wallPatch(p, g, 'right', t + 0.055, 0, 1, g.wallH, BUILD.stoneWallDark);
      }
      wallBand(p, g, 'right', -0.06, 4, BUILD.stoneWallLight);
      // Lamp either side of the door.
      for (const t of [0.3, 0.62]) {
        wallPatch(p, g, 'right', t, 0.14, 3, 4, BUILD.glassLit);
        wallPatch(lit, g, 'right', t, 0.14, 3, 4, BUILD.glassLitCore);
      }
    },
  },
  Storage: {
    bw: 96, wallH: 30, roofH: 22, roof: 'gable', wall: 'timber', roofColor: 'slate',
    windows: [['left', 0.7, 0.18]],
    door: ['right', 0.36], sign: 'STORE',
    extras: (p, _lit, g) => {
      wallPatch(p, g, 'right', 0.3, 0.16, 26, Math.round(g.wallH * 0.8), BUILD.timberDark);
      wallPatch(p, g, 'right', 0.315, 0.2, 11, Math.round(g.wallH * 0.72), BUILD.timber);
      wallPatch(p, g, 'right', 0.5, 0.2, 11, Math.round(g.wallH * 0.72), BUILD.timber);
      wallBand(p, g, 'left', 0.5, 2, BUILD.metal);
    },
  },
  Tavern: {
    bw: 94, wallH: 32, roofH: 30, roof: 'gable', wall: 'plaster', roofColor: 'thatch',
    windows: [['left', 0.18, 0.2], ['left', 0.52, 0.2], ['right', 0.16, 0.2], ['right', 0.7, 0.2]],
    door: ['right', 0.42], chimneyAt: -24, chimneyH: 24, sign: 'TAVERN',
    extras: (p, lit, g) => {
      awning(p, g, 'left', BUILD.roofGreen);
      // Warm porch light.
      wallPatch(p, g, 'right', 0.56, 0.12, 4, 5, BUILD.glassLit);
      wallPatch(lit, g, 'right', 0.56, 0.12, 4, 5, BUILD.glassLitCore);
    },
  },
  Farm: {
    bw: 102, wallH: 28, roofH: 30, roof: 'gable', wall: 'timber', roofColor: 'red', overhang: 7,
    windows: [['left', 0.7, 0.2]],
    door: ['right', 0.34],
    extras: (p, _lit, g) => {
      // Big barn doors with an X brace.
      wallPatch(p, g, 'right', 0.26, 0.12, 30, Math.round(g.wallH * 0.84), BUILD.timberDark);
      for (let i = 0; i < 30; i++) {
        const t = 0.265 + i / g.bw;
        wallPatch(p, g, 'right', t, 0.16 + (i / 30) * 0.6, 1, 3, BUILD.timberLight);
        wallPatch(p, g, 'right', t, 0.76 - (i / 30) * 0.6, 1, 3, BUILD.timberLight);
      }
      // Hay in the loft opening.
      wallPatch(p, g, 'left', 0.3, -0.02, 12, 8, BUILD.timberDark);
      wallPatch(p, g, 'left', 0.32, 0.02, 9, 5, BLOOM.wheat);
    },
  },
  Woodcutter: {
    bw: 82, wallH: 26, roofH: 24, roof: 'gable', wall: 'log', roofColor: 'thatch',
    windows: [['left', 0.6, 0.24]],
    door: ['right', 0.34], chimneyAt: 18, chimneyH: 18, sign: 'TIMBER',
    extras: (p, _lit, g) => {
      // Split logs stacked against the gable end.
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 5 - row; i++) {
          wallPatch(p, g, 'left', 0.06 + i * 0.07 + row * 0.03, 0.92 - row * 0.18, 5, 5, FOLIAGE.trunkDark);
          wallPatch(p, g, 'left', 0.075 + i * 0.07 + row * 0.03, 0.94 - row * 0.18, 2, 2, FOLIAGE.trunkLight);
        }
      }
    },
  },
  Fishery: {
    bw: 72, wallH: 22, roofH: 18, roof: 'gable', wall: 'log', roofColor: 'thatch',
    windows: [['left', 0.64, 0.3]],
    door: ['right', 0.36], sign: 'FISH',
    extras: (p, _lit, g) => {
      // A net hung to dry across the left wall: a dark mesh with a pale cord grid.
      const netH = Math.round(g.wallH * 0.66);
      wallPatch(p, g, 'left', 0.06, 0.12, 24, netH, '#324744');
      for (let i = 0; i <= 6; i++) wallPatch(p, g, 'left', 0.06 + i * 0.048, 0.12, 1, netH, '#9db8b0');
      for (let i = 0; i <= 5; i++) wallPatch(p, g, 'left', 0.06, 0.12 + i * 0.13, 24, 1, '#9db8b0');
      // The catch on a line under the eave of the right wall.
      for (let i = 0; i < 4; i++) {
        wallPatch(p, g, 'right', 0.58 + i * 0.09, 0.06, 3, 7, '#bccbd0');
        wallPatch(p, g, 'right', 0.59 + i * 0.09, 0.08, 1, 4, '#7c929a');
      }
      // Cork floats and a coil of rope by the door.
      wallPatch(p, g, 'right', 0.14, 0.78, 7, 6, '#c9a15a');
      wallPatch(p, g, 'right', 0.16, 0.8, 3, 2, '#e0bd78');
    },
  },
  Lodge: {
    bw: 80, wallH: 26, roofH: 22, roof: 'gable', wall: 'log', roofColor: 'green',
    windows: [['left', 0.66, 0.26], ['right', 0.72, 0.26]],
    door: ['right', 0.3], chimneyAt: 20, chimneyH: 16, sign: 'GAME',
    extras: (p, _lit, g) => {
      // A rack of antlers over the door.
      for (let i = 0; i < 4; i++) {
        wallPatch(p, g, 'right', 0.25 + i * 0.045, 0.04 + (i % 2) * 0.06, 2, 4, '#e6dcc4');
        wallPatch(p, g, 'right', 0.255 + i * 0.045, 0.02 + (i % 2) * 0.06, 1, 2, '#f4eedc');
      }
      // Pelts stretched to cure on the left wall.
      wallPatch(p, g, 'left', 0.08, 0.16, 15, 13, '#7c4f2c');
      wallPatch(p, g, 'left', 0.1, 0.2, 11, 9, '#a3703f');
      wallPatch(p, g, 'left', 0.42, 0.18, 13, 12, '#5f4129');
      wallPatch(p, g, 'left', 0.44, 0.22, 9, 8, '#8a613a');
      // Split firewood and a quiver by the step.
      wallPatch(p, g, 'right', 0.6, 0.78, 12, 6, FOLIAGE.trunkDark);
      wallPatch(p, g, 'right', 0.62, 0.8, 2, 2, FOLIAGE.trunkLight);
      wallPatch(p, g, 'right', 0.82, 0.64, 3, 9, '#8f6b3c');
    },
  },
  Forager: {
    bw: 62, wallH: 18, roofH: 16, roof: 'hip', wall: 'timber', roofColor: 'thatch',
    windows: [],
    door: ['right', 0.4], sign: 'FORAGE',
    extras: (p, _lit, g) => {
      // Baskets of the day's picking along the left wall.
      for (let i = 0; i < 3; i++) {
        wallPatch(p, g, 'left', 0.1 + i * 0.24, 0.7, 10, 8, '#b08a4c');
        wallPatch(p, g, 'left', 0.1 + i * 0.24, 0.7, 10, 2, '#c9a566');
        wallPatch(p, g, 'left', 0.13 + i * 0.24, 0.64, 6, 3, i === 1 ? '#6f4a9a' : BLOOM.red);
      }
      // Bunches of herbs drying under the eave.
      for (let i = 0; i < 5; i++) wallPatch(p, g, 'right', 0.56 + i * 0.07, 0.05, 2, 7, FOLIAGE.bush);
    },
  },
  Jail: {
    bw: 66, wallH: 24, roofH: 12, roof: 'flat', wall: 'stone', roofColor: 'slate',
    windows: [],
    door: ['right', 0.34], sign: 'JAIL',
    extras: (p, _lit, g) => {
      // Two barred windows, small and high, and a heavy door.
      for (const side of ['left', 'right'] as const) {
        const t = side === 'left' ? 0.5 : 0.72;
        wallPatch(p, g, side, t, 0.18, 12, 9, '#0f1512');
        for (let i = 0; i < 3; i++) wallPatch(p, g, side, t + 0.015 + i * 0.045, 0.18, 1, 9, '#9aa0a6');
        wallPatch(p, g, side, t, 0.34, 12, 1, '#9aa0a6');
      }
      wallPatch(p, g, 'right', 0.3, 0.3, 4, Math.round(g.wallH * 0.62), '#3a2e22');
      wallPatch(p, g, 'right', 0.31, 0.5, 2, 2, '#aeb5ba');
    },
  },
  Mine: {
    bw: 76, wallH: 24, roofH: 16, roof: 'flat', wall: 'stone', roofColor: 'slate',
    windows: [],
    door: ['right', 0.4],
    extras: (p, lit, g) => {
      // Timbered adit driven into the rock.
      wallPatch(p, g, 'right', 0.24, 0.06, 30, Math.round(g.wallH * 0.9), '#0f1210');
      wallPatch(p, g, 'right', 0.22, 0.02, 4, Math.round(g.wallH * 0.95), BUILD.timber);
      wallPatch(p, g, 'right', 0.56, 0.02, 4, Math.round(g.wallH * 0.95), BUILD.timber);
      wallBand(p, g, 'right', -0.04, 4, BUILD.timberDark);
      wallPatch(p, g, 'right', 0.38, 0.2, 4, 4, BUILD.glassLit);
      wallPatch(lit, g, 'right', 0.38, 0.2, 4, 5, BUILD.glassLitCore);
      // Spoil heap on the left face.
      wallPatch(p, g, 'left', 0.1, 0.8, 22, 8, GROUND.rockDark);
      wallPatch(p, g, 'left', 0.16, 0.72, 12, 6, GROUND.rock);
    },
  },
  Quarry: {
    bw: 88, wallH: 18, roofH: 14, roof: 'flat', wall: 'stone', roofColor: 'slate',
    windows: [],
    door: ['right', 0.5],
    extras: (p, _lit, g) => {
      // Cut blocks stacked on the working floor.
      const r = rng(5151);
      for (let i = 0; i < 9; i++) {
        const side: Side = r() < 0.5 ? 'left' : 'right';
        wallPatch(p, g, side, 0.08 + r() * 0.76, 0.5 + r() * 0.4, 8 + Math.floor(r() * 6), 6, GROUND.stoneLight);
        wallPatch(p, g, side, 0.08 + r() * 0.76, 0.86, 8, 2, GROUND.stoneDark);
      }
      wallPatch(p, g, 'right', 0.42, 0.1, 10, 10, BUILD.timberDark);
    },
  },
  Mill: {
    bw: 78, wallH: 40, roofH: 26, roof: 'hip', wall: 'plaster', roofColor: 'slate',
    windows: [['left', 0.24, 0.16], ['left', 0.62, 0.16], ['right', 0.66, 0.4]],
    door: ['right', 0.3], sign: 'MILL',
    extras: (p, _lit, g) => {
      // Mill race running out under the wheel side.
      wallPatch(p, g, 'left', 0.02, 0.86, 30, 8, WATER.mid);
      wallPatch(p, g, 'left', 0.02, 0.86, 30, 2, WATER.highlight);
      wallBand(p, g, 'left', 0.42, 3, BUILD.timberDark);
    },
  },
  Bakery: {
    bw: 84, wallH: 28, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'red',
    windows: [['left', 0.24, 0.22], ['right', 0.66, 0.22]],
    door: ['right', 0.3], chimneyAt: -22, chimneyH: 26, sign: 'BAKERY',
    extras: (p, lit, g) => {
      awning(p, g, 'right', BUILD.roofRedLight);
      shopWindow(p, lit, g, 'right', 0.08, 0.3, 14, 9);
      for (const t of [0.11, 0.16, 0.21]) wallPatch(p, g, 'right', t, 0.46, 3, 3, BLOOM.wheatDark);
    },
  },
  Carpenter: {
    bw: 86, wallH: 26, roofH: 22, roof: 'gable', wall: 'timber', roofColor: 'green', overhang: 9,
    windows: [['left', 0.66, 0.22]],
    door: ['right', 0.62], sign: 'JOINER',
    extras: (p, _lit, g) => {
      // Open workshop bay with timber stacked inside.
      wallPatch(p, g, 'right', 0.08, 0.1, 26, Math.round(g.wallH * 0.8), '#1c1913');
      for (let i = 0; i < 4; i++) wallPatch(p, g, 'right', 0.1 + i * 0.05, 0.5 + i * 0.06, 4, 12, FOLIAGE.trunk);
      wallPatch(p, g, 'right', 0.1, 0.24, 20, 4, BUILD.timberLight);
      wallBand(p, g, 'left', 0.5, 2, BUILD.timberDark);
    },
  },
  Blacksmith: {
    bw: 84, wallH: 28, roofH: 20, roof: 'gable', wall: 'dark', roofColor: 'slate',
    windows: [['left', 0.68, 0.2]],
    door: ['right', 0.66], chimneyAt: -20, chimneyH: 30, sign: 'FORGE',
    extras: (p, lit, g) => {
      // Forge mouth glowing under the open bay.
      wallPatch(p, g, 'right', 0.1, 0.16, 24, Math.round(g.wallH * 0.74), '#151513');
      wallPatch(p, g, 'right', 0.16, 0.46, 11, 8, '#d1571f');
      wallPatch(p, g, 'right', 0.19, 0.52, 6, 4, '#ffb547');
      wallPatch(lit, g, 'right', 0.15, 0.44, 13, 10, '#ff8a2e');
      wallPatch(lit, g, 'right', 0.19, 0.52, 6, 4, '#ffe1a0');
      const [fx, fy] = wallPoint(g, 'right', 0.22, 0.55);
      glow(lit, fx, fy, 22, '#ff8a2e', 0.5);
      // Anvil out front.
      wallPatch(p, g, 'left', 0.66, 0.84, 10, 4, BUILD.metal);
      wallPatch(p, g, 'left', 0.69, 0.9, 5, 4, BUILD.metalLight);
    },
  },
  Tailor: {
    bw: 80, wallH: 30, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'green',
    windows: [['left', 0.22, 0.2], ['left', 0.62, 0.2], ['right', 0.7, 0.2]],
    door: ['right', 0.3], sign: 'TAILOR',
    extras: (p, _lit, g) => {
      // Bolts of cloth hung out to show.
      const colors = ['#a86a8f', '#4a7f8f', '#8f8f4f', '#8f4f45'];
      colors.forEach((c, i) => {
        wallPatch(p, g, 'right', 0.08 + i * 0.09, 0.18, 6, 14, c);
        wallPatch(p, g, 'right', 0.08 + i * 0.09, 0.18, 6, 2, shade(c, 0.25));
      });
    },
  },
  'Town Hall': {
    bw: 108, wallH: 40, roofH: 34, roof: 'hip', wall: 'stone', roofColor: 'green', overhang: 10,
    windows: [['left', 0.2, 0.2], ['left', 0.5, 0.2], ['left', 0.78, 0.2], ['right', 0.2, 0.2], ['right', 0.76, 0.2]],
    door: ['right', 0.46], sign: 'HALL',
    extras: (p, _lit, g) => {
      for (const t of [0.32, 0.44, 0.56, 0.68]) {
        wallPatch(p, g, 'right', t, 0, 5, g.wallH, BUILD.stoneWallLight);
      }
      wallBand(p, g, 'right', -0.05, 4, BUILD.stoneWallLight);
    },
  },

  // The civic buildings the reference town is built around.
  School: {
    bw: 100, wallH: 34, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'slate', overhang: 7,
    windows: [['left', 0.14, 0.2], ['left', 0.4, 0.2], ['left', 0.66, 0.2], ['right', 0.14, 0.2], ['right', 0.72, 0.2]],
    door: ['right', 0.42], sign: 'SCHOOL',
    extras: (p, lit, g) => {
      // A little bell tower on the ridge.
      const x = g.cx - 8;
      const y = g.wallTopY + g.bh / 2 - g.roofH - 16;
      rect(p, x - 5, y + 4, 10, 12, BUILD.plasterDark);
      rect(p, x - 4, y + 5, 8, 10, BUILD.plaster);
      rect(p, x - 2, y + 7, 4, 5, BUILD.glassDark);
      rect(p, x - 1, y + 8, 2, 3, BUILD.gold);
      rect(p, x - 7, y, 14, 4, BUILD.roofSlateDark);
      rect(p, x - 5, y - 2, 10, 2, BUILD.roofSlate);
      rect(lit, x - 2, y + 7, 4, 5, shade(BUILD.glassLit, -0.2));
      // A blackboard and a bench out front.
      wallPatch(p, g, 'left', 0.72, 0.8, 12, 4, BUILD.timber);
    },
  },
  Lab: {
    bw: 96, wallH: 38, roofH: 14, roof: 'flat', wall: 'dark', roofColor: 'slate', overhang: 6,
    windows: [['left', 0.16, 0.18], ['left', 0.42, 0.18]],
    door: ['right', 0.62], sign: 'LAB',
    extras: (p, lit, g) => {
      glassCube(p, lit, g, 'right', 0.06);
      // Vents and a dish on the roof.
      const y = g.wallTopY - 6;
      rect(p, g.cx + 20, y - 6, 8, 8, BUILD.metal);
      rect(p, g.cx + 21, y - 5, 6, 6, BUILD.metalLight);
      rect(p, g.cx - 26, y - 4, 4, 6, BUILD.metal);
      rect(p, g.cx - 18, y - 4, 4, 6, BUILD.metal);
      wallBand(p, g, 'left', 0.5, 2, BUILD.metal);
      wallBand(p, g, 'right', 0.5, 2, BUILD.metal);
    },
  },
  Cafe: {
    bw: 84, wallH: 30, roofH: 22, roof: 'hip', wall: 'stone', roofColor: 'green', overhang: 9,
    windows: [['left', 0.2, 0.2], ['right', 0.7, 0.2]],
    door: ['right', 0.34], chimneyAt: -18, chimneyH: 18, sign: 'CAFE',
    extras: (p, lit, g) => {
      shopWindow(p, lit, g, 'left', 0.5, 0.24, 20, 11);
      awning(p, g, 'right', BUILD.roofGreenLight);
      // Two umbrella tables on the terrace out front.
      const [ax, ay] = wallPoint(g, 'right', 0.86, 1.05);
      const [bx, by] = wallPoint(g, 'left', 0.12, 1.05);
      umbrellaTable(p, ax + 4, ay, BUILD.roofGreenLight);
      umbrellaTable(p, bx - 2, by, BUILD.roofRedLight);
      // A lantern over the door.
      const [lx, ly] = wallPoint(g, 'right', 0.56, 0.2);
      lantern(p, lit, lx, ly);
    },
  },
  Studio: {
    bw: 90, wallH: 32, roofH: 20, roof: 'gable', wall: 'timber', roofColor: 'slate', overhang: 8,
    windows: [['left', 0.7, 0.22]],
    door: ['right', 0.64], sign: 'CREATE',
    extras: (p, lit, g) => {
      // A wide workshop window with the lights on late, and a mural.
      shopWindow(p, lit, g, 'right', 0.08, 0.18, 24, 14);
      wallPatch(p, g, 'left', 0.12, 0.3, 30, Math.round(g.wallH * 0.5), '#3b2f4a');
      wallPatch(p, g, 'left', 0.16, 0.38, 8, 6, BLOOM.pink);
      wallPatch(p, g, 'left', 0.3, 0.34, 6, 8, BUILD.sign);
      wallPatch(p, g, 'left', 0.42, 0.42, 9, 5, BLOOM.yellow);
      wallPatch(p, g, 'left', 0.24, 0.5, 5, 5, BUILD.labGlassLit);
    },
  },
  Clinic: {
    bw: 82, wallH: 30, roofH: 22, roof: 'hip', wall: 'plaster', roofColor: 'slate', overhang: 7,
    windows: [['left', 0.22, 0.22], ['left', 0.62, 0.22], ['right', 0.72, 0.22]],
    door: ['right', 0.34], sign: 'CLINIC',
    extras: (p, lit, g) => {
      // A lit cross beside the door.
      wallPatch(p, g, 'right', 0.62, 0.36, 9, 9, BUILD.signBoard);
      wallPatch(p, g, 'right', 0.65, 0.38, 3, 7, BUILD.sign);
      wallPatch(p, g, 'right', 0.62, 0.42, 9, 3, BUILD.sign);
      wallPatch(lit, g, 'right', 0.65, 0.38, 3, 7, BUILD.signGlow);
      wallPatch(lit, g, 'right', 0.62, 0.42, 9, 3, BUILD.signGlow);
      const [gx, gy] = wallPoint(g, 'right', 0.7, 0.5);
      glow(lit, gx, gy, 14, BUILD.signGlow, 0.4);
      // Herb beds along the near wall.
      for (const t of [0.06, 0.18, 0.3]) {
        wallPatch(p, g, 'left', t, 0.86, 8, 4, BUILD.timberDark);
        wallPatch(p, g, 'left', t + 0.01, 0.78, 6, 4, FOLIAGE.bushLight);
      }
    },
  },
  Library: {
    bw: 88, wallH: 42, roofH: 24, roof: 'hip', wall: 'stone', roofColor: 'green', overhang: 8,
    windows: [
      ['left', 0.16, 0.12], ['left', 0.44, 0.12], ['left', 0.72, 0.12], ['right', 0.2, 0.12], ['right', 0.74, 0.12],
      ['left', 0.16, 0.52], ['left', 0.44, 0.52], ['left', 0.72, 0.52],
    ],
    door: ['right', 0.46], sign: 'LIBRARY',
    extras: (p, _lit, g) => {
      for (const t of [0.3, 0.62]) wallPatch(p, g, 'right', t, 0, 4, g.wallH, BUILD.stoneWallLight);
      wallBand(p, g, 'right', -0.05, 3, BUILD.stoneWallLight);
      wallBand(p, g, 'left', 0.46, 2, BUILD.stoneWallLight);
    },
  },
};

/** Water wheel frames for the mill, drawn as a separate rotating overlay. */
function millWheel(frame: number): Pixels {
  const p = surface(40, 44);
  const cx = 20, cy = 22, R = 17;
  const spin = (frame / 4) * (Math.PI / 4);
  p.ctx.strokeStyle = BUILD.timberDark;
  p.ctx.lineWidth = 3;
  p.ctx.beginPath();
  p.ctx.ellipse(cx, cy, R, R * 0.86, 0, 0, Math.PI * 2);
  p.ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = spin + (i / 8) * Math.PI * 2;
    const x1 = cx + Math.cos(a) * 3, y1 = cy + Math.sin(a) * 3;
    const x2 = cx + Math.cos(a) * R, y2 = cy + Math.sin(a) * R * 0.86;
    p.ctx.strokeStyle = BUILD.timber;
    p.ctx.lineWidth = 2;
    p.ctx.beginPath();
    p.ctx.moveTo(x1, y1); p.ctx.lineTo(x2, y2); p.ctx.stroke();
    rect(p, x2 - 2, y2 - 2, 5, 4, BUILD.timberLight);
  }
  rect(p, cx - 3, cy - 3, 6, 6, BUILD.metal);
  outline(p, DARK, 0.85);
  return p;
}

export const ART_LEVELS: ArtLevel[] = [1, 2, 3];

/*
 * The township.
 *
 * Six buildings that only exist from the second era, drawn in stone and
 * tile from the start, and one dressing that puts every earlier recipe in
 * the same material: a house raised in the settlement era keeps its timber
 * until it is improved, but the atlas carries the stone version so a
 * township's new streets are stone from the day they are laid.
 */
const TOWNSHIP: Record<string, Recipe> = {
  Chapel: {
    bw: 84, wallH: 40, roofH: 34, roof: 'gable', wall: 'stone', roofColor: 'slate', overhang: 6,
    windows: [['left', 0.18, 0.14], ['left', 0.44, 0.14], ['left', 0.7, 0.14], ['right', 0.62, 0.3]],
    door: ['right', 0.28],
    extras: (p, lit, g) => {
      // A bell tower on the far corner, with a lit lancet.
      const x = g.cx + Math.round(g.bw * 0.34), top = g.wallTopY - 30;
      rect(p, x - 6, top, 12, g.wallH + 30, BUILD.stoneWallDark);
      rect(p, x - 5, top + 1, 5, g.wallH + 28, BUILD.stoneWall);
      rect(p, x - 8, top - 8, 16, 8, BUILD.roofSlateDark);
      rect(p, x - 4, top - 14, 8, 6, BUILD.roofSlate);
      rect(p, x - 2, top + 6, 4, 8, BUILD.glassDark);
      rect(lit, x - 2, top + 6, 4, 8, BUILD.glassLit);
      rect(p, x - 1, top - 20, 2, 6, BUILD.gold);
    },
  },
  Guildhall: {
    bw: 104, wallH: 40, roofH: 26, roof: 'hip', wall: 'stone', roofColor: 'red', overhang: 8,
    windows: [['left', 0.16, 0.16], ['left', 0.4, 0.16], ['left', 0.64, 0.16], ['right', 0.3, 0.16], ['right', 0.62, 0.16], ['left', 0.16, 0.56], ['left', 0.64, 0.56]],
    door: ['right', 0.44], sign: 'GUILD',
    extras: (p, _lit, g) => {
      // Banners between the upper windows.
      for (const t of [0.3, 0.52]) {
        wallPatch(p, g, 'left', t, 0.12, 6, Math.round(g.wallH * 0.36), BUILD.roofRedDark);
        wallPatch(p, g, 'left', t + 0.01, 0.14, 4, Math.round(g.wallH * 0.3), BUILD.gold);
      }
    },
  },
  Brewery: {
    bw: 96, wallH: 30, roofH: 26, roof: 'gable', wall: 'stone', roofColor: 'red', overhang: 8,
    windows: [['left', 0.22, 0.28], ['left', 0.6, 0.28], ['right', 0.7, 0.28]],
    door: ['right', 0.3], sign: 'BREW', chimneyAt: -26, chimneyH: 26,
    extras: (p, _lit, g) => {
      awning(p, g, 'right', BUILD.roofRedDark);
      // Barrels stacked along the front.
      for (let i = 0; i < 4; i++) {
        wallPatch(p, g, 'right', 0.5 + i * 0.1, 0.7, 6, 8, BUILD.timber);
        wallPatch(p, g, 'right', 0.5 + i * 0.1, 0.72, 6, 1, BUILD.metal);
        wallPatch(p, g, 'right', 0.5 + i * 0.1, 0.84, 6, 1, BUILD.metal);
      }
    },
  },
  Printer: {
    bw: 80, wallH: 32, roofH: 22, roof: 'hip', wall: 'stone', roofColor: 'slate', overhang: 6,
    windows: [['left', 0.2, 0.2], ['left', 0.56, 0.2], ['right', 0.66, 0.2], ['left', 0.2, 0.58], ['left', 0.56, 0.58]],
    door: ['right', 0.3], sign: 'PRESS',
  },
  Stables: {
    bw: 110, wallH: 22, roofH: 24, roof: 'gable', wall: 'stone', roofColor: 'thatch', overhang: 10,
    windows: [['left', 0.3, 0.3]],
    door: ['right', 0.5],
    extras: (p, _lit, g) => {
      // Open stalls along the front, with a cart under the eave.
      for (const t of [0.08, 0.26, 0.44, 0.62, 0.8]) wallPatch(p, g, 'left', t, 0.1, 2, Math.round(g.wallH * 0.9), BUILD.timberDark);
      for (const t of [0.12, 0.3, 0.48]) wallPatch(p, g, 'left', t, 0.45, 12, 3, BUILD.timber);
      const [wx, wy] = wallPoint(g, 'right', 0.78, 0.55);
      rect(p, wx - 10, wy, 20, 6, BUILD.timber);
      rect(p, wx - 11, wy + 6, 5, 5, BUILD.timberDark);
      rect(p, wx + 6, wy + 6, 5, 5, BUILD.timberDark);
      rect(p, wx - 10, wy + 7, 3, 3, BUILD.metal);
      rect(p, wx + 7, wy + 7, 3, 3, BUILD.metal);
    },
  },
  Harbour: {
    bw: 92, wallH: 24, roofH: 22, roof: 'gable', wall: 'stone', roofColor: 'slate', overhang: 8,
    windows: [['left', 0.24, 0.3], ['right', 0.66, 0.3]],
    door: ['right', 0.3], sign: 'FERRY',
    extras: (p, lit, g) => {
      // A jetty running out from the near corner, and a lamp at the end.
      const [jx, jy] = wallPoint(g, 'right', 0.98, 1);
      for (let i = 0; i < 9; i++) rect(p, jx + i * 4, jy + 2 + i * 2, 5, 3, i % 2 ? BUILD.timber : BUILD.timberDark);
      for (let i = 0; i < 9; i += 2) rect(p, jx + i * 4 + 1, jy + 5 + i * 2, 1, 4, BUILD.timberDark);
      const lx = jx + 36, ly = jy + 18;
      rect(p, lx, ly - 12, 2, 14, BUILD.metal);
      rect(p, lx - 2, ly - 15, 6, 4, BUILD.gold);
      rect(lit, lx - 3, ly - 16, 8, 6, BUILD.glassLit);
    },
  },
};

/**
 * The same recipe, as a township would build it: stone in place of plaster,
 * timber and logs, slate or tile in place of thatch. Stone and slate stay as
 * they are.
 */
/** What kind of building a recipe is, which decides the shape each era gives it. */
const CIVIC = new Set(['Town Hall', 'Bank', 'Market', 'School', 'Library', 'Lab', 'Clinic', 'Jail', 'Cafe', 'Studio', 'Tavern', 'Storage']);
type BuildingClass = 'house' | 'civic' | 'works';
const classOf = (name: string): BuildingClass => name.startsWith('House') ? 'house' : CIVIC.has(name) ? 'civic' : 'works';

/**
 * The township rebuilds in stone, and builds up: a mansard roof with the
 * attic in it on every home, a steep gable over the workshops, a hipped
 * roof with height to it on the civic buildings.
 */
/**
 * The settlement builds with what the wood gives it. Homes and workshops
 * are log cabins: round logs notched at the corners under a low gable of
 * split shakes or thatch, a porch over the door, firewood against the wall.
 * The halls are plank lodges. Nothing is dressed stone yet; that is what the
 * township is for.
 */
function settlementDress(r: Recipe, name = ''): Recipe {
  if (name === 'Monument' || GREAT_WORK_NAMES.has(name)) return r;
  const cls = classOf(name);
  const flat = r.roof === 'flat';
  const roof: RoofStyle = flat ? 'flat' : 'gable';
  const roofH = flat ? r.roofH : Math.max(9, Math.round(r.roofH * 0.7));
  const shakes: RoofColor = r.roofColor === 'thatch' ? 'thatch' : 'shingle';
  if (cls === 'house') return { ...r, wall: 'log', roofColor: shakes, roof, roofH, wallH: Math.max(14, r.wallH - 2), overhang: (r.overhang ?? 4) + 2, eraLook: 1 };
  if (cls === 'civic') return { ...r, wall: 'timber', roofColor: 'shingle', roof, roofH: flat ? r.roofH : Math.max(10, Math.round(r.roofH * 0.8)), wallH: r.wallH + 2, overhang: (r.overhang ?? 4) + 1, eraLook: 1 };
  return { ...r, wall: name === 'Farm' ? 'timber' : 'log', roofColor: r.roofColor === 'red' ? 'red' : shakes, roof, roofH, overhang: (r.overhang ?? 4) + 2, eraLook: 1 };
}

/**
 * The township is the first place built to last: timber-framed homes on two
 * floors with plaster between the beams and fired tile above, a dormer in
 * the roof; the halls in dressed stone under slate; the workshops framed
 * the same way as the homes.
 */
function townshipDress(r: Recipe, name = ''): Recipe {
  if (GREAT_WORK_NAMES.has(name)) return r;
  const cls = classOf(name);
  const tile: RoofColor = r.roofColor === 'thatch' || r.roofColor === 'green' || r.roofColor === 'shingle' ? 'red' : r.roofColor;
  const flat = r.roof === 'flat';
  if (cls === 'house') return { ...r, wall: 'plaster', roofColor: tile, roof: 'gable', roofH: r.roofH + 6, wallH: r.wallH + 10, overhang: (r.overhang ?? 4) + 1, eraLook: 2 };
  if (cls === 'civic') return { ...r, wall: 'stone', roofColor: tile === 'red' ? 'slate' : tile, roof: flat ? 'flat' : 'hip', roofH: flat ? r.roofH : r.roofH + 10, wallH: r.wallH + 8, eraLook: 2 };
  return { ...r, wall: r.wall === 'stone' ? 'stone' : 'plaster', roofColor: name === 'Farm' ? 'red' : tile === 'red' ? 'slate' : tile, roof: flat ? 'flat' : 'gable', roofH: flat ? r.roofH : r.roofH + 6, wallH: r.wallH + 4, eraLook: 2 };
}

/** As the industrial era rebuilds it: brick, and iron sheet on the roof. */
/**
 * The mill town: long low brick terraces with a shallow roof and a stack
 * at the end for homes, sawtooth roofs full of glass over the works, and
 * tall flat-topped brick blocks for the civic buildings.
 */
function industrialDress(r: Recipe, name = ''): Recipe {
  if (GREAT_WORK_NAMES.has(name)) return r;
  const cls = classOf(name);
  if (cls === 'house') return { ...r, wall: 'brick', roofColor: 'iron', roof: 'gable', roofH: Math.max(8, Math.round(r.roofH * 0.5)), wallH: r.wallH + 8, bw: Math.round(r.bw * 1.15), chimneyAt: r.chimneyAt ?? -Math.round(r.bw * 0.34), chimneyH: 22, eraLook: 3 };
  if (cls === 'civic') return { ...r, wall: 'brick', roofColor: 'iron', roof: 'flat', roofH: 8, wallH: r.wallH + 18, eraLook: 3 };
  return { ...r, wall: 'brick', roofColor: 'iron', roof: 'sawtooth', roofH: 14, wallH: r.wallH + 12, bw: Math.round(r.bw * 1.1), eraLook: 3 };
}
/** As the modern era rebuilds it: concrete, glass on the roof, flatter. */
/**
 * The modern town: stepped concrete homes with a set-back upper storey,
 * wide flat sheds for the works, and towers for the civic buildings.
 */
function modernDress(r: Recipe, name = ''): Recipe {
  if (GREAT_WORK_NAMES.has(name)) return r;
  const cls = classOf(name);
  if (cls === 'house') return { ...r, wall: 'concrete', roofColor: 'white', roof: 'stepped', roofH: 12, wallH: r.wallH + 8, bw: Math.round(r.bw * 0.9), windows: [], eraLook: 4 };
  if (cls === 'civic') return { ...r, wall: 'concrete', roofColor: 'white', roof: 'flat', roofH: 8, wallH: Math.round(r.wallH * 1.9) + 10, bw: Math.round(r.bw * 0.72), windows: [], eraLook: 4 };
  return { ...r, wall: 'concrete', roofColor: 'white', roof: 'flat', roofH: 8, wallH: r.wallH + 6, bw: Math.round(r.bw * 1.25), windows: [], eraLook: 4 };
}
/** As the AI era rebuilds it: white composite, a garden or a white roof, flat. */
/**
 * The AI era: rounded white pods with a garden deck for homes, domes of
 * light over the works, bigger domes over the civic buildings.
 */
function aiDress(r: Recipe, name = ''): Recipe {
  if (GREAT_WORK_NAMES.has(name)) return r;
  const cls = classOf(name);
  if (cls === 'house') return { ...r, wall: 'composite', roofColor: 'garden', roof: 'curved', roofH: 10, wallH: r.wallH + 2, bw: Math.round(r.bw * 1.05), windows: [], eraLook: 5 };
  if (cls === 'civic') return { ...r, wall: 'composite', roofColor: 'white', roof: 'dome', roofH: 26, wallH: r.wallH + 10, bw: Math.round(r.bw * 1.1), windows: [], eraLook: 5 };
  return { ...r, wall: 'composite', roofColor: 'white', roof: 'dome', roofH: 18, wallH: r.wallH + 4, windows: [], eraLook: 5 };
}
const isoDiamond = (p: Pixels, cx: number, cy: number, w: number, h: number, color: string) => {
  p.ctx.fillStyle = color;
  p.ctx.beginPath();
  p.ctx.moveTo(cx - w / 2, cy); p.ctx.lineTo(cx, cy - h / 2); p.ctx.lineTo(cx + w / 2, cy); p.ctx.lineTo(cx, cy + h / 2);
  p.ctx.closePath(); p.ctx.fill();
};

/**
 * What each era does to every building it rebuilds. Drawn over the finished
 * body, before the improvements, so the same recipe is a different building
 * in each era rather than the same one repainted. Returns a chimney it
 * added, if any, so smoke has somewhere to come from.
 */
type EraLook = (p: Pixels, lit: Pixels, g: Geometry, r: Recipe, seed: number, door: [Side, number], overhang: number) => [number, number] | null;
const ERA_LOOK: Record<number, EraLook> = {
  // Settlement: the cabin. Log butts crossed at the near corner, plank
  // shutters, a lean-to porch on posts over the door, a fieldstone chimney,
  // firewood stacked against the wall away from the door.
  1: (p, _lit, g, r, seed, [dSide, dT]) => {
    const rr = rng(seed + 1);
    const [logLight, logMid, logDark] = WALLS.log;
    if (r.wall === 'log') {
      const logH = 4;
      for (let y = 0, i = 0; y < g.wallH; y += logH, i++) {
        const [x, yy] = wallPoint(g, 'right', 0, y / g.wallH);
        const left = i % 2 === 0;
        const bx = left ? x - 6 : x + 1;
        rect(p, bx, yy, 5, logH - 1, left ? shade(logMid, -0.14) : logLight);
        rect(p, bx, yy + logH - 2, 5, 1, shade(logDark, -0.1));
        rect(p, left ? bx : bx + 4, yy, 1, logH - 1, shade(logLight, 0.25));
      }
    }
    for (const [side, t, v] of r.windows ?? []) {
      wallPatch(p, g, side, t - 0.035, v + 0.005, 3, 9, BUILD.timberDark);
      wallPatch(p, g, side, t + 0.05, v + 0.005, 3, 9, BUILD.timberDark);
      wallPatch(p, g, side, t - 0.03, v + 0.03, 2, 1, shade(BUILD.timberDark, 0.25));
      wallPatch(p, g, side, t + 0.055, v + 0.03, 2, 1, shade(BUILD.timberDark, 0.25));
    }
    // The porch: a plank roof on two posts, flat to the door's wall.
    const [ax, ay] = wallPoint(g, dSide, dT, 0.2);
    const [, floorY] = wallPoint(g, dSide, dT, 1);
    rect(p, ax - 10, ay - 1, 20, 3, BUILD.timberDark);
    rect(p, ax - 10, ay - 2, 20, 1, BUILD.timberLight);
    rect(p, ax - 9, ay + 2, 2, floorY - ay - 2, shade(BUILD.timberDark, -0.15));
    rect(p, ax + 7, ay + 2, 2, floorY - ay - 2, shade(BUILD.timberDark, -0.15));
    // A fieldstone stack where the recipe put a chimney.
    if (r.chimneyAt !== undefined) {
      const x = Math.round(g.cx + r.chimneyAt), h = r.chimneyH ?? 20;
      const topY = Math.round(g.wallTopY + g.bh / 2 - g.roofH - h + 6);
      for (let y = 0; y < h - 2; y += 3) {
        const off = (y / 3) % 2 ? 1 : 0;
        rect(p, x - 4 + off, topY + y, 8, 2, y % 6 === 0 ? BUILD.stoneWall : BUILD.stoneWallLight);
        rect(p, x - 4 + off + (rr() < 0.5 ? 1 : 4), topY + y, 3, 2, BUILD.stoneWallDark);
      }
      rect(p, x - 5, topY - 1, 10, 1, BUILD.stoneWallLight);
    }
    // Firewood.
    const other: Side = dSide === 'left' ? 'right' : 'left';
    const [wx, wy] = wallPoint(g, other, 0.72, 0.68);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4 - (row === 2 ? 1 : 0); col++) {
      rect(p, wx - 6 + col * 3 + (row === 2 ? 1 : 0), wy + row * 2, 2, 2, rr() < 0.5 ? logLight : shade(logMid, 0.1));
    }
    return null;
  },
  // Township: dressed stone on the halls, framed plaster on the homes.
  // Quoins up the near corner of stone, a stone base course under plaster,
  // shutters at the windows, a dormer in the roof, an arch over the door,
  // pots on the chimney.
  2: (p, _lit, g, r, seed, [dSide, dT]) => {
    const rr = rng(seed + 2);
    const cornerX = g.cx, cornerY = g.wallTopY + g.bh;
    if (r.wall === 'stone') {
      for (let i = 0; i < g.wallH; i += 4) rect(p, cornerX - 2 + (i % 8 === 0 ? 0 : 1), cornerY + i, 4, 3, i % 8 === 0 ? BUILD.stoneWallLight : shade(BUILD.stoneWallLight, 0.15));
    } else {
      for (const side of ['left', 'right'] as Side[]) {
        wallBand(p, g, side, 0.86, 3, side === 'left' ? shade(BUILD.stoneWall, -0.16) : BUILD.stoneWall);
        wallBand(p, g, side, 0.86, 1, side === 'left' ? shade(BUILD.stoneWallLight, -0.16) : BUILD.stoneWallLight);
      }
    }
    for (const [side, t, v] of r.windows ?? []) {
      wallPatch(p, g, side, t - 0.035, v + 0.005, 3, 9, '#2f5a3a');
      wallPatch(p, g, side, t + 0.05, v + 0.005, 3, 9, '#2f5a3a');
    }
    if (r.roof !== 'flat' && r.roof !== 'hip') {
      const dx = g.cx - Math.round(g.bw * 0.22), dy = g.wallTopY + g.bh / 2 - Math.round(r.roofH * 0.45);
      rect(p, dx - 6, dy - 6, 12, 10, BUILD.stoneWall);
      rect(p, dx - 8, dy - 9, 16, 4, BUILD.roofSlateDark);
      rect(p, dx - 3, dy - 4, 6, 6, BUILD.glassDark);
      rect(p, dx - 2, dy - 3, 2, 2, shade(BUILD.glassDark, 0.3));
    }
    const [ax, ay] = wallPoint(g, dSide, dT + 0.05, 0.27);
    rect(p, ax - 7, ay - 3, 14, 3, BUILD.stoneWallLight);
    rect(p, ax - 5, ay - 5, 10, 2, BUILD.stoneWallLight);
    if (r.chimneyAt !== undefined) {
      const x = Math.round(g.cx + r.chimneyAt), topY = Math.round(g.wallTopY + g.bh / 2 - g.roofH - (r.chimneyH ?? 20) + 6);
      rect(p, x - 4, topY - 4, 3, 4, '#7a4434'); rect(p, x + 1, topY - 4, 3, 4, '#7a4434');
    }
    if (rr() < 0.6) { const [vx, vy] = wallPoint(g, dSide === 'left' ? 'right' : 'left', 0.5, 0.9); rect(p, vx - 6, vy - 2, 12, 3, '#2f5a3a'); rect(p, vx - 4, vy - 4, 3, 2, BLOOM.pink); rect(p, vx + 2, vy - 4, 3, 2, BLOOM.yellow); }
    return null;
  },
  // Industrial: a mill town's brick. A soldier course, tall arched windows
  // between the old ones, iron guttering, a gas lamp at the door, a stack.
  3: (p, lit, g, r, seed, [dSide, dT]) => {
    for (const side of ['left', 'right'] as Side[]) {
      for (let t = 0; t < 0.96; t += 0.04) wallPatch(p, g, side, t, 0.36, 2, 3, ((t * 100) | 0) % 8 < 4 ? '#563024' : '#b06a50');
      wallBand(p, g, side, -0.02, 2, BUILD.metal);
      wallBand(p, g, side, 0.97, 2, '#3a2a24');
      for (const t of [0.08, 0.3, 0.52, 0.74]) {
        const h = Math.round(g.wallH * 0.42);
        wallPatch(p, g, side, t, 0.46, 6, h, '#3a2a24');
        wallPatch(p, g, side, t + 0.008, 0.5, 4, h - 4, BUILD.glassDark);
        wallPatch(lit, g, side, t + 0.008, 0.5, 4, h - 4, '#ffb060');
        wallPatch(p, g, side, t + 0.008, 0.48, 4, 1, shade(BUILD.glassDark, 0.3));
        wallPatch(p, g, side, t + 0.016, 0.52, 1, h - 6, shade(BUILD.glassDark, 0.2));
      }
    }
    const [lx, ly] = wallPoint(g, dSide, dT + 0.27, 0.32);
    rect(p, lx - 3, ly - 2, 7, 1, BUILD.metal); rect(p, lx + 2, ly - 8, 1, 7, BUILD.metal);
    rect(p, lx, ly - 12, 5, 5, '#2a2a2e'); rect(p, lx + 1, ly - 11, 3, 3, '#ffd07a');
    glow(lit, lx + 2, ly - 9, 12, '#ffcf7a', 0.6);
    if (r.chimneyAt === undefined) {
      const [cx, cy] = chimney(p, g, Math.round(g.bw * 0.28), 30);
      rect(p, cx - 6, cy, 12, 2, '#2a2a2e');
      return [cx, cy];
    }
    return null;
  },
  // Modern: concrete and glass. A window band on every floor, a canopy over
  // the door, a parapet and a plant room on the roof, an aerial.
  4: (p, lit, g, r, _seed, [dSide, dT], overhang) => {
    const floors = Math.max(2, Math.round(g.wallH / 18));
    for (const side of ['left', 'right'] as Side[]) {
      for (let f = 0; f < floors; f++) {
        const v = 0.12 + (f / floors) * 0.8;
        wallPatch(p, g, side, 0.03, v, Math.round(g.bw / 2 * 0.92), 7, '#1d2a30');
        wallPatch(p, g, side, 0.03, v + 0.01, Math.round(g.bw / 2 * 0.92), 3, '#5aa8c0');
        wallPatch(lit, g, side, 0.03, v, Math.round(g.bw / 2 * 0.92), 7, '#ffe6a0');
        for (let t = 0.03; t < 0.95; t += 0.12) wallPatch(p, g, side, t, v, 1, 7, '#dfe4ea');
        wallBand(p, g, side, v + 0.11, 1, '#7a7f86');
      }
    }
    const [cx, cy] = wallPoint(g, dSide, dT + 0.1, 0.28);
    rect(p, cx - 12, cy - 4, 24, 3, '#dfe4ea'); rect(p, cx - 12, cy - 1, 24, 1, '#6e7278');
    const px = g.cx + Math.round(g.bw * 0.18), py = g.wallTopY - 4;
    if (r.roof === 'flat') { rect(p, px - 8, py - 8, 16, 8, '#8a8f96'); rect(p, px - 8, py - 8, 16, 1, '#b8bcc0'); rect(p, px - 5, py - 6, 3, 3, '#3a3f44'); }
    rect(p, g.cx - Math.round(g.bw * 0.3), py - 22, 1, 20, BUILD.metal); rect(lit, g.cx - Math.round(g.bw * 0.3), py - 23, 2, 2, '#ff6060');
    isoWalls(p, g.cx, g.wallTopY - 4, g.bw + overhang * 2, g.bh + overhang, 2, '#dfe4ea', '#b8c0c8');
    return null;
  },
  // AI: white composite. Slit windows in a light band, teal strips at the
  // foot and the eave, a garden and solar glass on the roof, a holo sign.
  5: (p, lit, g, r, seed, [dSide, dT], overhang) => {
    const rr = rng(seed + 5);
    for (const side of ['left', 'right'] as Side[]) {
      wallPatch(p, g, side, 0.05, 0.22, Math.round(g.bw / 2 * 0.88), 4, '#7fd8e8');
      wallPatch(p, g, side, 0.05, 0.22, Math.round(g.bw / 2 * 0.88), 1, '#d8f4fa');
      wallPatch(lit, g, side, 0.05, 0.22, Math.round(g.bw / 2 * 0.88), 4, '#dffcf8');
      if (g.wallH > 30) { wallPatch(p, g, side, 0.05, 0.55, Math.round(g.bw / 2 * 0.88), 4, '#7fd8e8'); wallPatch(lit, g, side, 0.05, 0.55, Math.round(g.bw / 2 * 0.88), 4, '#dffcf8'); }
      wallBand(p, g, side, 0.94, 1, '#5fd6c8'); wallBand(lit, g, side, 0.94, 1, '#dffcf8');
      wallBand(p, g, side, 0.0, 1, '#a986d8'); wallBand(lit, g, side, 0.0, 1, '#e8dcff');
    }
    // The roof: a garden on one half, solar glass on the other, on the flat roofs.
    const rc = g.wallTopY - 2 + (g.bh + overhang) / 2;
    if (r.roof === 'curved' || r.roof === 'flat') for (let i = 0; i < 14; i++) {
      const x = g.cx - Math.round(g.bw * 0.42) + rr() * g.bw * 0.4, y = rc - 6 + rr() * 12;
      rect(p, x, y, 3, 2, rr() < 0.5 ? '#4a8a3a' : '#6fb04a'); if (rr() < 0.3) rect(p, x + 1, y - 1, 1, 1, BLOOM.pink);
    }
    if (r.roof === 'curved' || r.roof === 'flat') for (let i = 0; i < 3; i++) { const x = g.cx + 6 + i * 10, y = rc - 5 + i * 3; rect(p, x, y, 8, 4, '#1d2a30'); rect(p, x, y, 8, 1, '#7ab8ff'); }
    const [hx, hy] = wallPoint(g, dSide, dT + 0.1, 0.18);
    rect(p, hx - 8, hy - 3, 16, 1, '#5fd6c8'); glow(lit, hx, hy - 3, 16, '#5fd6c8', 0.5); rect(lit, hx - 8, hy - 4, 16, 3, '#bffaf4');
    isoWalls(p, g.cx, g.wallTopY - 4, g.bw + overhang * 2, g.bh + overhang, 2, '#f4f6f8', '#c8d0d8');
    return null;
  },
};
const DRESS: Record<number, (r: Recipe, name?: string) => Recipe> = { 2: townshipDress, 3: industrialDress, 4: modernDress, 5: aiDress };

/** A lit strip along a wall face, the AI era's signature. */
function lightStrip(p: Pixels, lit: Pixels, g: Geometry, side: Side, v: number, color = '#5fd6c8') {
  wallBand(p, g, side, v, 1, color);
  wallBand(lit, g, side, v, 1, '#dffcf8');
}

/** Tall chimneys in a row, for the industrial recipes. */
function stacks(p: Pixels, g: Geometry, at: number[], height: number) {
  for (const t of at) chimney(p, g, t * g.bw, height);
}

/** The industrial era's own buildings. Brick and iron from the day they are raised. */
const INDUSTRIAL: Record<string, Recipe> = {
  Factory: {
    bw: 112, wallH: 34, roofH: 16, roof: 'flat', wall: 'brick', roofColor: 'iron', overhang: 4,
    windows: [['left', 0.1, 0.2], ['left', 0.3, 0.2], ['left', 0.5, 0.2], ['left', 0.7, 0.2], ['right', 0.3, 0.2], ['right', 0.6, 0.2]],
    door: ['right', 0.82], sign: 'WORKS', chimneyAt: -34, chimneyH: 30,
    extras: (p, _lit, g) => stacks(p, g, [0.05, 0.3], 26),
  },
  Foundry: {
    bw: 96, wallH: 30, roofH: 18, roof: 'gable', wall: 'brick', roofColor: 'iron', overhang: 6,
    windows: [['left', 0.2, 0.25], ['left', 0.55, 0.25]],
    door: ['right', 0.4], chimneyAt: 24, chimneyH: 28,
    extras: (p, lit, g) => {
      // The furnace mouth, glowing on the near face.
      const [x, y] = wallPoint(g, 'right', 0.72, 0.45);
      rect(p, x - 6, y, 12, 10, '#2a1a12');
      rect(p, x - 4, y + 2, 8, 6, '#ff7a2a');
      rect(p, x - 2, y + 3, 4, 3, '#ffd07a');
      glow(lit, x, y + 5, 22, '#ff9a3a', 0.6);
      rect(lit, x - 4, y + 2, 8, 6, '#ffb060');
    },
  },
  'Railway Station': {
    bw: 116, wallH: 26, roofH: 18, roof: 'hip', wall: 'brick', roofColor: 'iron', overhang: 10,
    windows: [['left', 0.15, 0.3], ['left', 0.4, 0.3], ['left', 0.65, 0.3], ['right', 0.6, 0.3]],
    door: ['right', 0.3], sign: 'STATION',
    extras: (p, _lit, g) => {
      // A platform canopy on iron posts along the front, and the rails below it.
      const y = g.groundY - 4;
      for (let i = 0; i < 6; i++) rect(p, g.cx - 56 + i * 20, y - 16, 2, 16, BUILD.metal);
      rect(p, g.cx - 58, y - 18, 116, 3, BUILD.metalLight);
      rect(p, g.cx - 60, y + 1, 120, 1, BUILD.metalLight);
      rect(p, g.cx - 60, y + 3, 120, 1, BUILD.metalLight);
      for (let x = g.cx - 58; x < g.cx + 58; x += 6) rect(p, x, y, 3, 5, BUILD.timberDark);
    },
  },
  Telegraph: {
    bw: 58, wallH: 30, roofH: 18, roof: 'gable', wall: 'brick', roofColor: 'iron', overhang: 4,
    windows: [['left', 0.3, 0.25], ['right', 0.6, 0.25]],
    door: ['right', 0.3], sign: 'WIRE',
    extras: (p, _lit, g) => {
      // The pole, its crossarms and the wires running off the edge.
      const x = g.cx - Math.round(g.bw * 0.42), top = g.wallTopY - 34;
      rect(p, x, top, 2, g.wallH + 40, BUILD.timberDark);
      for (const dy of [2, 8]) { rect(p, x - 8, top + dy, 18, 1, BUILD.timber); for (const dx of [-7, -3, 3, 7]) rect(p, x + dx, top + dy - 2, 1, 2, BUILD.glassLit); }
      for (let i = 0; i < 40; i++) rect(p, x - 8 - i, top + 3 + Math.round(i * 0.15), 1, 1, BUILD.metal);
    },
  },
  Gasworks: {
    bw: 92, wallH: 24, roofH: 12, roof: 'flat', wall: 'brick', roofColor: 'iron', overhang: 3,
    windows: [['left', 0.2, 0.3], ['right', 0.65, 0.3]],
    door: ['right', 0.3], chimneyAt: -12, chimneyH: 22,
    extras: (p, _lit, g) => {
      // The gasholder: a drum on a frame beside the works.
      const x = g.cx + Math.round(g.bw * 0.36), y = g.wallTopY - 14;
      rect(p, x - 14, y, 28, 40, '#3e444c');
      rect(p, x - 14, y, 28, 2, '#7a828c');
      for (let i = 0; i < 4; i++) rect(p, x - 14, y + 6 + i * 9, 28, 1, '#2a2f36');
      rect(p, x - 17, y - 4, 2, 46, BUILD.metalLight);
      rect(p, x + 15, y - 4, 2, 46, BUILD.metalLight);
    },
  },
};

/** The modern era's own buildings. Concrete and glass. */
const MODERN: Record<string, Recipe> = {
  Hospital: {
    bw: 110, wallH: 46, roofH: 10, roof: 'flat', wall: 'concrete', roofColor: 'white', overhang: 2,
    windows: [['left', 0.1, 0.12], ['left', 0.3, 0.12], ['left', 0.5, 0.12], ['left', 0.7, 0.12], ['left', 0.1, 0.45], ['left', 0.3, 0.45], ['left', 0.5, 0.45], ['left', 0.7, 0.45], ['right', 0.6, 0.12], ['right', 0.6, 0.45]],
    door: ['right', 0.3], sign: 'HOSPITAL',
    extras: (p, lit, g) => {
      const [x, y] = wallPoint(g, 'left', 0.5, 0.78);
      rect(p, x - 8, y - 3, 16, 6, '#ffffff');
      rect(p, x - 3, y - 8, 6, 16, '#ffffff');
      rect(p, x - 6, y - 2, 12, 4, '#d04040');
      rect(p, x - 2, y - 6, 4, 12, '#d04040');
      glow(lit, x, y, 20, '#ff8080', 0.4);
    },
  },
  Stadium: {
    bw: 124, wallH: 30, roofH: 8, roof: 'flat', wall: 'concrete', roofColor: 'glass', overhang: 6,
    windows: [['left', 0.15, 0.35], ['left', 0.45, 0.35], ['left', 0.75, 0.35], ['right', 0.5, 0.35]],
    door: ['right', 0.2], sign: 'ARENA',
    extras: (p, lit, g) => {
      // Floodlight masts at the corners.
      for (const [dx, h] of [[-0.46, 40], [0.46, 40], [0, 48]] as [number, number][]) {
        const x = g.cx + Math.round(g.bw * dx), top = g.wallTopY - h;
        rect(p, x, top, 2, h, BUILD.metal);
        rect(p, x - 5, top - 4, 12, 4, '#2a2f36');
        rect(p, x - 4, top - 3, 10, 2, '#ffe6a0');
        glow(lit, x + 1, top - 2, 26, '#fff0c8', 0.55);
      }
    },
  },
  Supermarket: {
    bw: 108, wallH: 28, roofH: 8, roof: 'flat', wall: 'concrete', roofColor: 'white', overhang: 4,
    windows: [['left', 0.08, 0.25], ['left', 0.24, 0.25], ['left', 0.4, 0.25], ['left', 0.56, 0.25], ['left', 0.72, 0.25], ['right', 0.62, 0.25]],
    door: ['right', 0.3], sign: 'MART',
    extras: (p, _lit, g) => {
      // A striped awning the length of the front.
      for (let i = 0; i < 10; i++) wallPatch(p, g, 'left', 0.02 + i * 0.09, 0.12, 5, 3, i % 2 ? '#d04040' : '#f0f0ea');
    },
  },
  Office: {
    bw: 76, wallH: 64, roofH: 8, roof: 'flat', wall: 'concrete', roofColor: 'white', overhang: 2,
    windows: [['left', 0.12, 0.08], ['left', 0.4, 0.08], ['left', 0.68, 0.08], ['left', 0.12, 0.3], ['left', 0.4, 0.3], ['left', 0.68, 0.3], ['left', 0.12, 0.52], ['left', 0.4, 0.52], ['left', 0.68, 0.52], ['right', 0.55, 0.08], ['right', 0.55, 0.3], ['right', 0.55, 0.52]],
    door: ['right', 0.3], sign: 'OFFICE',
    extras: (p, _lit, g) => { wallBand(p, g, 'left', 0.22, 1, '#dfe4ea'); wallBand(p, g, 'left', 0.44, 1, '#dfe4ea'); wallBand(p, g, 'left', 0.66, 1, '#dfe4ea'); },
  },
  'Bus Depot': {
    bw: 112, wallH: 26, roofH: 10, roof: 'flat', wall: 'concrete', roofColor: 'iron', overhang: 8,
    windows: [['right', 0.6, 0.3]],
    door: ['right', 0.3], sign: 'DEPOT',
    extras: (p, _lit, g) => {
      // Wide bays along the front, a bus nosing out of one.
      for (const t of [0.05, 0.36, 0.67]) wallPatch(p, g, 'left', t, 0.25, 12, Math.round(g.wallH * 0.72), '#2a2f36');
      const [x, y] = wallPoint(g, 'left', 0.42, 0.55);
      rect(p, x - 4, y, 26, 11, '#e0c060');
      rect(p, x - 4, y, 26, 1, '#fff0c8');
      for (let i = 0; i < 4; i++) rect(p, x - 1 + i * 6, y + 2, 4, 4, '#cfe8f0');
      rect(p, x - 2, y + 10, 5, 3, '#1e1e22'); rect(p, x + 16, y + 10, 5, 3, '#1e1e22');
    },
  },
  'Power Plant': {
    bw: 104, wallH: 30, roofH: 10, roof: 'flat', wall: 'concrete', roofColor: 'iron', overhang: 3,
    windows: [['left', 0.3, 0.3], ['right', 0.6, 0.3]],
    door: ['right', 0.3], chimneyAt: -20, chimneyH: 30,
    extras: (p, lit, g) => {
      // A cooling tower and the pylon beside it.
      const x = g.cx + Math.round(g.bw * 0.34), top = g.wallTopY - 30;
      for (let i = 0; i < 50; i++) { const w = 22 - Math.round(Math.sin((i / 50) * Math.PI) * 4); rect(p, x - w / 2, top + i, w, 1, i % 6 === 0 ? '#8a8f96' : '#b0b4ba'); }
      const px = g.cx - Math.round(g.bw * 0.42), ptop = g.wallTopY - 40;
      rect(p, px, ptop, 2, g.wallH + 46, BUILD.metal);
      rect(p, px - 8, ptop + 4, 18, 1, BUILD.metalLight); rect(p, px - 6, ptop + 12, 14, 1, BUILD.metalLight);
      rect(lit, px - 7, ptop + 2, 2, 2, '#ff6060');
    },
  },
};

/** The AI era's own buildings. White composite, light, gardens on the roofs. */
const AIERA: Record<string, Recipe> = {
  'Data Centre': {
    bw: 108, wallH: 30, roofH: 8, roof: 'flat', wall: 'composite', roofColor: 'white', overhang: 2,
    door: ['right', 0.3], sign: 'DATA',
    extras: (p, lit, g) => {
      lightStrip(p, lit, g, 'left', 0.3); lightStrip(p, lit, g, 'left', 0.6); lightStrip(p, lit, g, 'right', 0.3, '#a986d8'); lightStrip(p, lit, g, 'right', 0.6, '#a986d8');
      for (let i = 0; i < 5; i++) rect(p, g.cx - 40 + i * 18, g.wallTopY - 6, 10, 6, '#c8ccd8');
    },
  },
  'Research Campus': {
    bw: 120, wallH: 36, roofH: 14, roof: 'flat', wall: 'composite', roofColor: 'garden', overhang: 6,
    windows: [['left', 0.1, 0.2], ['left', 0.3, 0.2], ['left', 0.5, 0.2], ['left', 0.7, 0.2], ['right', 0.4, 0.2], ['right', 0.7, 0.2]],
    door: ['right', 0.2], sign: 'CAMPUS',
    extras: (p, lit, g) => {
      // A glass dome over the middle.
      const x = g.cx, top = g.wallTopY - 24;
      for (let i = 0; i < 24; i++) { const w = Math.round(Math.sqrt(1 - ((24 - i) / 24) ** 2) * 30); rect(p, x - w, top + i, w * 2, 1, i % 4 === 0 ? '#5aa8c0' : '#8fd0e0'); }
      glow(lit, x, top + 14, 40, '#dffcf8', 0.35);
      lightStrip(p, lit, g, 'left', 0.85, '#8ff06a');
    },
  },
  'Vertical Farm': {
    bw: 74, wallH: 66, roofH: 8, roof: 'flat', wall: 'composite', roofColor: 'garden', overhang: 2,
    door: ['right', 0.3], sign: 'FARM',
    extras: (p, lit, g) => {
      // Green tiers the full height, each behind a light strip.
      for (let i = 0; i < 6; i++) {
        const v = 0.08 + i * 0.15;
        wallBand(p, g, 'left', v, 4, '#4a8a3a'); wallBand(p, g, 'left', v + 0.03, 2, '#6fb04a');
        wallBand(p, g, 'right', v, 4, '#3f7a32'); wallBand(p, g, 'right', v + 0.03, 2, '#5fa040');
        lightStrip(p, lit, g, 'left', v + 0.08, '#f4f0c8');
      }
    },
  },
  'Pod Hub': {
    bw: 100, wallH: 22, roofH: 10, roof: 'flat', wall: 'composite', roofColor: 'white', overhang: 12,
    door: ['right', 0.3], sign: 'HUB',
    extras: (p, lit, g) => {
      // A wide canopy on slim posts, pods waiting under it.
      for (let i = 0; i < 5; i++) rect(p, g.cx - 50 + i * 24, g.wallTopY + g.wallH - 20, 2, 20, '#c8ccd8');
      lightStrip(p, lit, g, 'left', 0.5); lightStrip(p, lit, g, 'right', 0.5);
      for (const dx of [-30, 0]) { const y = g.groundY - 12; rect(p, g.cx + dx - 10, y, 20, 8, '#eef0f4'); rect(p, g.cx + dx - 7, y + 2, 14, 3, '#7fd8e8'); rect(p, g.cx + dx - 10, y + 8, 20, 1, '#5fd6c8'); }
    },
  },
  'Drone Port': {
    bw: 96, wallH: 26, roofH: 8, roof: 'flat', wall: 'composite', roofColor: 'white', overhang: 4,
    door: ['right', 0.3], sign: 'PORT',
    extras: (p, lit, g) => {
      // A landing ring on the roof and a drone hovering over it.
      const x = g.cx, y = g.wallTopY - 4;
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; rect(p, Math.round(x + Math.cos(a) * 18), Math.round(y + Math.sin(a) * 9), 2, 1, '#5fd6c8'); }
      glow(lit, x, y, 30, '#5fd6c8', 0.35);
      rect(p, x - 6, y - 26, 12, 3, '#c8ccd8'); rect(p, x - 9, y - 27, 4, 1, '#3a3a3e'); rect(p, x + 5, y - 27, 4, 1, '#3a3a3e');
      rect(p, x - 2, y - 23, 4, 3, '#eef0f4');
      rect(lit, x - 1, y - 22, 2, 1, '#ff6060');
    },
  },
};
const ERA_SETS: [number, Record<string, Recipe>][] = [[2, TOWNSHIP], [3, INDUSTRIAL], [4, MODERN], [5, AIERA]];
const ART_ERAS = [2, 3, 4, 5];

/**
 * The bodies built at load: every building as it is first raised, at its
 * three levels. The era bodies — the same building as a later era would
 * rebuild it — are built on demand by `buildBuildingArt`, because five eras
 * of every recipe at three levels is ten atlas pages, and a plot only ever
 * shows one or two eras at a time.
 */
export function buildBuildings(): { art: BuildingArt[]; overlays: { name: string; pixels: Pixels }[] } {
  const art: BuildingArt[] = [];
  let seed = 6000;
  for (const [name, recipe] of Object.entries(RECIPES)) {
    seed += 137;
    for (const level of ART_LEVELS) art.push(buildOne(name, seed, settlementDress(recipe, name), level));
  }
  for (const [, set] of ERA_SETS) {
    for (const [name, recipe] of Object.entries(set)) {
      seed += 137;
      for (const level of ART_LEVELS) art.push(buildOne(name, seed, recipe, level));
    }
  }
  const overlays = [0, 1, 2, 3].map((f) => ({ name: `overlay.mill.wheel.${f}`, pixels: millWheel(f) }));
  return { art, overlays };
}

export const HOUSE_DESIGNS = 8;

/** Every building type that has art of its own. */
export const BUILDING_TYPES = [...Object.keys(RECIPES).filter((k) => !k.startsWith('House.')), ...ERA_SETS.flatMap(([, set]) => Object.keys(set))];
const knownType = (type: string) => !!(RECIPES[type] || ERA_SETS.some(([, set]) => set[type]));

/** The recipe behind a base art name, and the era it belongs to. */
function recipeFor(base: string): { recipe: Recipe; own: number } | null {
  if (RECIPES[base]) return { recipe: RECIPES[base], own: 1 };
  for (const [own, set] of ERA_SETS) if (set[base]) return { recipe: set[base], own };
  return null;
}

/**
 * Build one art key on demand: `<base>[.E<era>][.L<level>]`. The three
 * levels of a body are built together, since a lookup for one usually means
 * the others are coming. Returns nothing for a key that names no recipe or
 * needs no dressing, which is everything built at load.
 */
export function buildBuildingArt(key: string): BuildingArt[] {
  let rest = key;
  const lvl = /\.L([23])$/.exec(rest);
  if (lvl) rest = rest.slice(0, -lvl[0].length);
  const era = /\.E([2-5])$/.exec(rest);
  if (!era) return [];
  const base = rest.slice(0, -era[0].length);
  const found = recipeFor(base);
  if (!found) return [];
  const e = Number(era[1]);
  const body = e <= found.own ? found.recipe : DRESS[e](found.recipe, base);
  let seed = 7000;
  for (let i = 0; i < base.length; i++) seed = (seed * 31 + base.charCodeAt(i)) % 100000;
  return ART_LEVELS.map((level) => buildOne(`${base}.E${e}`, seed + 41 * e, body, level));
}

/**
 * Map a simulation building to its art.
 *
 * Houses pick a design from a hash of their id rather than their position in
 * the list, so a home keeps its face when the settlement grows around it. The
 * level picks the dressed variant, so an improved building looks improved.
 */
export function buildingArtKey(type: string, id: string, level = 1, era = 1): string {
  let base: string;
  if (type !== 'House') base = knownType(type) ? type : 'House.0';
  else {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    base = `House.${Math.abs(h) % HOUSE_DESIGNS}`;
  }
  // The era dresses the body: anything from the township on is stone and
  // tile. A building raised earlier keeps its timber until it is improved,
  // which is the caller's decision, made by passing the era it was built in.
  if (era >= 2) base = `${base}.E${Math.min(5, Math.round(era))}`;
  const lvl = Math.max(1, Math.min(3, Math.round(level)));
  return lvl === 1 ? base : `${base}.L${lvl}`;
}

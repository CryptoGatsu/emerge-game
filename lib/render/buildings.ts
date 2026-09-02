/**
 * Isometric building art.
 *
 * Buildings are extruded from a diamond footprint: two visible wall faces, a
 * ridged or hipped roof, and per-type detailing (signs, awnings, chimneys,
 * forges, water wheels). Each type produces three things:
 *
 *   - a base sprite,
 *   - a `lit` overlay containing only the glowing windows, blended additively
 *     after dark so the settlement lights up at night,
 *   - metadata giving the door and chimney positions relative to the building's
 *     ground contact point, so the renderer can stand citizens at the door and
 *     hang smoke off the right chimney.
 */

import { BLOOM, BUILD, FOLIAGE, GROUND, WATER } from './palette';
import {
  groundShadow, isoTop, isoWalls, outline, rect, rng, shade, speckle, surface, type Pixels,
} from './pixelCanvas';

const DARK = '#141c14';

type Side = 'left' | 'right';
type RoofStyle = 'gable' | 'hip' | 'flat';
type WallStyle = 'plaster' | 'stone' | 'timber' | 'dark' | 'log';
type RoofColor = 'red' | 'green' | 'slate' | 'thatch';

interface Geometry {
  cx: number; wallTopY: number; bw: number; bh: number; wallH: number; roofH: number;
  groundY: number; canvasH: number;
}

const ROOFS: Record<RoofColor, [string, string, string]> = {
  red: [BUILD.roofRedLight, BUILD.roofRed, BUILD.roofRedDark],
  green: [BUILD.roofGreenLight, BUILD.roofGreen, BUILD.roofGreenDark],
  slate: [BUILD.roofSlateLight, BUILD.roofSlate, BUILD.roofSlateDark],
  thatch: [BUILD.roofThatchLight, BUILD.roofThatch, BUILD.roofThatchDark],
};
const WALLS: Record<WallStyle, [string, string, string]> = {
  plaster: [BUILD.plasterLight, BUILD.plaster, BUILD.plasterDark],
  stone: [BUILD.stoneWallLight, BUILD.stoneWall, BUILD.stoneWallDark],
  timber: [BUILD.timberLight, BUILD.timber, BUILD.timberDark],
  dark: ['#4d4a44', '#3b3934', '#2b2a26'],
  log: ['#8a6640', '#6b4a2f', '#4c3320'],
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

function paintWallTexture(p: Pixels, g: Geometry, style: WallStyle, seed: number) {
  const [light, , dark] = WALLS[style];
  if (style === 'stone') {
    const r = rng(seed);
    for (let i = 0; i < 46; i++) {
      const side: Side = r() < 0.5 ? 'left' : 'right';
      wallPatch(p, g, side, r() * 0.9, r() * 0.85, 3 + Math.floor(r() * 5), 2 + Math.floor(r() * 2), r() < 0.5 ? light : dark);
    }
  } else if (style === 'plaster') {
    // Exposed timber framing: verticals plus a mid rail.
    for (const side of ['left', 'right'] as Side[]) {
      for (const t of [0.12, 0.38, 0.64, 0.9]) wallPatch(p, g, side, t, 0, 2, g.wallH, BUILD.timberDark);
      wallBand(p, g, side, 0.44, 2, BUILD.timberDark);
    }
  } else if (style === 'log') {
    for (let i = 0; i < 6; i++) {
      const v = i / 6;
      for (const side of ['left', 'right'] as Side[]) wallBand(p, g, side, v, 1, dark);
    }
  } else if (style === 'timber') {
    for (const side of ['left', 'right'] as Side[]) {
      for (let t = 0; t < 1; t += 0.07) wallPatch(p, g, side, t, 0, 1, g.wallH, dark);
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

  if (style === 'hip') {
    const peak: [number, number] = [cx, cy - g.roofH];
    poly([W, N, peak], shade(dark, -0.1));
    poly([N, E, peak], shade(dark, -0.05));
    poly([W, S, peak], mid);
    poly([S, E, peak], light);
    // Shingle courses running parallel to the eaves.
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      const ly: [number, number] = [W[0] + (peak[0] - W[0]) * t, W[1] + (peak[1] - W[1]) * t];
      const ry: [number, number] = [S[0] + (peak[0] - S[0]) * t, S[1] + (peak[1] - S[1]) * t];
      const ey: [number, number] = [E[0] + (peak[0] - E[0]) * t, E[1] + (peak[1] - E[1]) * t];
      p.ctx.strokeStyle = shade(mid, -0.22);
      p.ctx.lineWidth = 1;
      p.ctx.beginPath();
      p.ctx.moveTo(ly[0], ly[1]); p.ctx.lineTo(ry[0], ry[1]); p.ctx.lineTo(ey[0], ey[1]);
      p.ctx.stroke();
    }
  } else {
    const ridgeW: [number, number] = [W[0], W[1] - g.roofH];
    const ridgeE: [number, number] = [E[0], E[1] - g.roofH];
    // Far slope first, then the near slope over the top of it.
    poly([W, N, E, ridgeE, ridgeW], shade(dark, -0.06));
    poly([W, S, E, ridgeE, ridgeW], mid);
    // Light catches the western half of the near slope.
    poly([W, S, [cx, S[1]], [cx, S[1] - g.roofH], ridgeW], light);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      p.ctx.strokeStyle = shade(mid, -0.24);
      p.ctx.lineWidth = 1;
      p.ctx.beginPath();
      p.ctx.moveTo(W[0] + (ridgeW[0] - W[0]) * t, W[1] + (ridgeW[1] - W[1]) * t);
      p.ctx.lineTo(S[0] + ((ridgeW[0] + ridgeE[0]) / 2 - S[0]) * t, S[1] + ((ridgeW[1] + ridgeE[1]) / 2 - S[1]) * t);
      p.ctx.lineTo(E[0] + (ridgeE[0] - E[0]) * t, E[1] + (ridgeE[1] - E[1]) * t);
      p.ctx.stroke();
    }
    // Ridge cap.
    p.ctx.strokeStyle = light;
    p.ctx.lineWidth = 2;
    p.ctx.beginPath();
    p.ctx.moveTo(ridgeW[0], ridgeW[1]); p.ctx.lineTo(ridgeE[0], ridgeE[1]);
    p.ctx.stroke();
  }

  if (color === 'thatch') {
    speckle(p, seed + 31, 340, [shade(mid, 0.16), shade(dark, -0.12)], (x, y) => y > g.wallTopY - g.roofH - 6 && y < cy + halfH + 2);
  } else {
    speckle(p, seed + 41, 220, [shade(mid, 0.1), shade(dark, -0.08)], (x, y) => y > g.wallTopY - g.roofH - 6 && y < cy + halfH + 2);
  }
}

function chimney(p: Pixels, g: Geometry, dx: number, height: number): [number, number] {
  const x = Math.round(g.cx + dx);
  const topY = Math.round(g.wallTopY + g.bh / 2 - g.roofH - height + 6);
  rect(p, x - 5, topY, 10, height, BUILD.stoneWallDark);
  rect(p, x - 4, topY, 8, height, BUILD.stoneWall);
  speckle(p, 77, 40, [BUILD.stoneWallLight, BUILD.stoneWallDark], (px, py) => px > x - 5 && px < x + 5 && py > topY && py < topY + height);
  rect(p, x - 6, topY, 12, 3, BUILD.stoneWallDark);
  return [x, topY];
}

function hangingSign(p: Pixels, g: Geometry, glyph: (q: Pixels, x: number, y: number) => void) {
  const x = Math.round(g.cx + g.bw * 0.24);
  const y = Math.round(g.wallTopY + g.bh * 0.62);
  rect(p, x, y, 12, 2, BUILD.timberDark);
  rect(p, x + 10, y, 2, 5, BUILD.metal);
  rect(p, x + 4, y + 5, 15, 12, BUILD.timber);
  rect(p, x + 5, y + 6, 13, 10, BUILD.timberDark);
  glyph(p, x + 7, y + 8);
  return [x, y] as const;
}

export interface BuildingArt {
  name: string;
  pixels: Pixels;
  lit: Pixels;
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
  extras?: (p: Pixels, lit: Pixels, g: Geometry, seed: number) => void;
}

const BOTTOM_MARGIN = 6;
const TOP_MARGIN = 26;

function buildOne(name: string, seed: number, r: Recipe): BuildingArt {
  const bw = r.bw;
  const bh = Math.round(bw / 2);
  const overhang = r.overhang ?? 5;
  const canvasW = bw + overhang * 2 + 34;
  const canvasH = TOP_MARGIN + r.roofH + r.wallH + bh + BOTTOM_MARGIN;
  const p = surface(canvasW, canvasH);
  const lit = surface(canvasW, canvasH);
  const g: Geometry = {
    cx: Math.round(canvasW / 2),
    wallTopY: TOP_MARGIN + r.roofH,
    bw, bh, wallH: r.wallH, roofH: r.roofH,
    groundY: canvasH - BOTTOM_MARGIN,
    canvasH,
  };

  groundShadow(p, g.cx, g.groundY - 2, bw * 0.5, bh * 0.34, 0.34);

  // Stone plinth under the walls so buildings sit into the ground.
  isoWalls(p, g.cx, g.wallTopY + 3, bw + 4, bh + 2, r.wallH, GROUND.stoneDark, shade(GROUND.stoneDark, -0.12));

  const [wLight, wMid, wDark] = WALLS[r.wall];
  isoWalls(p, g.cx, g.wallTopY, bw, bh, r.wallH, wMid, wDark);
  isoTop(p, g.cx, g.wallTopY, bw, bh, wLight);
  paintWallTexture(p, g, r.wall, seed);

  // Windows, dark by day and glowing on the lit overlay.
  for (const [side, t, v] of r.windows ?? []) {
    wallPatch(p, g, side, t, v, 9, 10, BUILD.timberDark);
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassDark);
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassLit);
    wallPatch(lit, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassLit);
    wallPatch(lit, g, side, t + 0.03, v + 0.1, 3, 4, BUILD.glassLitCore);
  }
  // Repaint window frames over the day-time glass so daylight windows read dark.
  for (const [side, t, v] of r.windows ?? []) {
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassDark);
    wallPatch(p, g, side, t + 0.03, v + 0.08, 2, 5, shade(BUILD.glassDark, 0.18));
  }

  const doorSpec = r.door ?? (['right', 0.42] as [Side, number]);
  const [dSide, dT] = doorSpec;
  wallPatch(p, g, dSide, dT, 0.3, 12, Math.round(r.wallH * 0.72), BUILD.timberDark);
  wallPatch(p, g, dSide, dT + 0.014, 0.34, 10, Math.round(r.wallH * 0.68), BUILD.timber);
  wallPatch(p, g, dSide, dT + 0.09, 0.55, 2, 2, BUILD.gold);

  let chimneyOffset: [number, number] | undefined;
  if (r.chimneyAt !== undefined) {
    const [cxp, cyp] = chimney(p, g, r.chimneyAt, r.chimneyH ?? 20);
    chimneyOffset = [cxp - g.cx, cyp - g.groundY];
  }

  drawRoof(p, g, r.roof, r.roofColor, overhang, seed);
  r.extras?.(p, lit, g, seed);
  outline(p, DARK, 0.9);

  // Door position in sprite space, measured from the ground contact point.
  const doorHalfW = bw / 2;
  const doorHalfH = bh / 2;
  const doorX = dSide === 'left' ? -doorHalfW + dT * doorHalfW * 2 * 0.5 : dT * doorHalfW;
  const doorEdgeY = dSide === 'left' ? doorHalfH + dT * doorHalfH : bh - dT * doorHalfH;
  const doorY = g.wallTopY + doorEdgeY + r.wallH - g.groundY;

  return {
    name,
    pixels: p,
    lit,
    anchorY: (canvasH - BOTTOM_MARGIN) / canvasH,
    door: [Math.round(doorX), Math.round(doorY)],
    chimney: chimneyOffset,
  };
}

/* ------------------------------------------------------------------ *
 * Per-type detailing
 * ------------------------------------------------------------------ */

function awning(p: Pixels, g: Geometry, side: Side, color: string) {
  for (let i = 0; i < g.bw / 2; i++) {
    const t = i / (g.bw / 2);
    const x = side === 'left' ? g.cx - g.bw / 2 + i : g.cx + i;
    const y = (side === 'left' ? g.wallTopY + g.bh / 2 + t * g.bh / 2 : g.wallTopY + g.bh - t * g.bh / 2) + g.wallH * 0.34;
    rect(p, x, y, 1, 7, i % 8 < 4 ? color : BUILD.plasterLight);
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

function goldGlyph(q: Pixels, x: number, y: number) {
  rect(q, x, y, 9, 2, BUILD.gold);
  rect(q, x + 3, y + 2, 3, 6, BUILD.gold);
  rect(q, x, y + 6, 9, 2, BUILD.gold);
}
function breadGlyph(q: Pixels, x: number, y: number) {
  rect(q, x + 1, y + 2, 8, 5, BLOOM.wheat);
  rect(q, x + 2, y + 1, 6, 2, BLOOM.wheatDark);
}
function mugGlyph(q: Pixels, x: number, y: number) {
  rect(q, x + 1, y + 1, 6, 7, BUILD.plasterLight);
  rect(q, x + 1, y + 1, 6, 2, BLOOM.wheat);
  rect(q, x + 7, y + 3, 2, 3, BUILD.plasterLight);
}
function anvilGlyph(q: Pixels, x: number, y: number) {
  rect(q, x + 1, y + 2, 9, 3, BUILD.metalLight);
  rect(q, x + 4, y + 5, 3, 3, BUILD.metal);
  rect(q, x + 2, y + 8, 7, 2, BUILD.metal);
}
function clothGlyph(q: Pixels, x: number, y: number) {
  rect(q, x + 1, y + 1, 9, 8, '#a86a8f');
  rect(q, x + 1, y + 3, 9, 1, '#d8a8c4');
  rect(q, x + 1, y + 6, 9, 1, '#d8a8c4');
}

const RECIPES: Record<string, Recipe> = {
  // Eight homes with genuinely different outlines: a settlement of twenty
  // houses built from three designs reads as a housing estate.
  'House.0': {
    bw: 76, wallH: 26, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'red',
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
    bw: 80, wallH: 28, roofH: 30, roof: 'hip', wall: 'plaster', roofColor: 'green',
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
    bw: 58, wallH: 34, roofH: 34, roof: 'gable', wall: 'plaster', roofColor: 'red', overhang: 4,
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
    bw: 112, wallH: 20, roofH: 26, roof: 'hip', wall: 'timber', roofColor: 'red', overhang: 10,
    windows: [],
    door: ['right', 0.44],
    extras: (p, _lit, g) => {
      awning(p, g, 'left', BUILD.roofRedLight);
      awning(p, g, 'right', BUILD.roofRed);
      // Produce laid out along the open front.
      const r = rng(4041);
      for (let i = 0; i < 12; i++) {
        const t = 0.08 + r() * 0.8;
        wallPatch(p, g, r() < 0.5 ? 'left' : 'right', t, 0.62, 4, 4, [BLOOM.wheat, BLOOM.red, FOLIAGE.bushLight, BLOOM.yellow][Math.floor(r() * 4)]);
      }
      hangingSign(p, g, goldGlyph);
    },
  },
  Bank: {
    bw: 90, wallH: 36, roofH: 20, roof: 'hip', wall: 'stone', roofColor: 'slate', overhang: 8,
    windows: [['left', 0.24, 0.2], ['left', 0.62, 0.2], ['right', 0.28, 0.2], ['right', 0.66, 0.2]],
    door: ['right', 0.46],
    extras: (p, lit, g) => {
      // Portico columns across the front faces.
      for (const t of [0.14, 0.34, 0.56, 0.78]) {
        wallPatch(p, g, 'right', t, 0, 5, g.wallH, BUILD.stoneWallLight);
        wallPatch(p, g, 'right', t + 0.055, 0, 1, g.wallH, BUILD.stoneWallDark);
      }
      wallBand(p, g, 'right', -0.06, 4, BUILD.stoneWallLight);
      hangingSign(p, g, goldGlyph);
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
    door: ['right', 0.36],
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
    door: ['right', 0.42], chimneyAt: -24, chimneyH: 24,
    extras: (p, lit, g) => {
      hangingSign(p, g, mugGlyph);
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
    door: ['right', 0.34], chimneyAt: 18, chimneyH: 18,
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
  Mine: {
    bw: 76, wallH: 24, roofH: 16, roof: 'flat', wall: 'stone', roofColor: 'slate',
    windows: [],
    door: ['right', 0.4],
    extras: (p, lit, g) => {
      // Timbered adit driven into the rock.
      wallPatch(p, g, 'right', 0.24, 0.06, 30, Math.round(g.wallH * 0.9), '#171a18');
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
    door: ['right', 0.3],
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
    door: ['right', 0.3], chimneyAt: -22, chimneyH: 26,
    extras: (p, lit, g) => {
      hangingSign(p, g, breadGlyph);
      awning(p, g, 'right', BUILD.roofRedLight);
      // Shop window with loaves on display.
      wallPatch(p, g, 'right', 0.1, 0.3, 14, 9, BUILD.timberDark);
      wallPatch(p, g, 'right', 0.115, 0.34, 12, 6, BUILD.glassLit);
      wallPatch(lit, g, 'right', 0.115, 0.34, 12, 6, BUILD.glassLitCore);
      for (const t of [0.13, 0.18, 0.23]) wallPatch(p, g, 'right', t, 0.46, 3, 3, BLOOM.wheatDark);
    },
  },
  Carpenter: {
    bw: 86, wallH: 26, roofH: 22, roof: 'gable', wall: 'timber', roofColor: 'green', overhang: 9,
    windows: [['left', 0.66, 0.22]],
    door: ['right', 0.62],
    extras: (p, _lit, g) => {
      // Open workshop bay with timber stacked inside.
      wallPatch(p, g, 'right', 0.08, 0.1, 26, Math.round(g.wallH * 0.8), '#2a241c');
      for (let i = 0; i < 4; i++) wallPatch(p, g, 'right', 0.1 + i * 0.05, 0.5 + i * 0.06, 4, 12, FOLIAGE.trunk);
      wallPatch(p, g, 'right', 0.1, 0.24, 20, 4, BUILD.timberLight);
      wallBand(p, g, 'left', 0.5, 2, BUILD.timberDark);
    },
  },
  Blacksmith: {
    bw: 84, wallH: 28, roofH: 20, roof: 'gable', wall: 'dark', roofColor: 'slate',
    windows: [['left', 0.68, 0.2]],
    door: ['right', 0.66], chimneyAt: -20, chimneyH: 30,
    extras: (p, lit, g) => {
      hangingSign(p, g, anvilGlyph);
      // Forge mouth glowing under the open bay.
      wallPatch(p, g, 'right', 0.1, 0.16, 24, Math.round(g.wallH * 0.74), '#20201c');
      wallPatch(p, g, 'right', 0.16, 0.46, 11, 8, '#d1571f');
      wallPatch(p, g, 'right', 0.19, 0.52, 6, 4, '#ffb547');
      wallPatch(lit, g, 'right', 0.15, 0.44, 13, 10, '#ff8a2e');
      wallPatch(lit, g, 'right', 0.19, 0.52, 6, 4, '#ffe1a0');
      // Anvil out front.
      wallPatch(p, g, 'left', 0.66, 0.84, 10, 4, BUILD.metal);
      wallPatch(p, g, 'left', 0.69, 0.9, 5, 4, BUILD.metalLight);
    },
  },
  Tailor: {
    bw: 80, wallH: 30, roofH: 26, roof: 'gable', wall: 'plaster', roofColor: 'green',
    windows: [['left', 0.22, 0.2], ['left', 0.62, 0.2], ['right', 0.7, 0.2]],
    door: ['right', 0.3],
    extras: (p, _lit, g) => {
      hangingSign(p, g, clothGlyph);
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
    door: ['right', 0.46],
    extras: (p, _lit, g) => {
      for (const t of [0.32, 0.44, 0.56, 0.68]) {
        wallPatch(p, g, 'right', t, 0, 5, g.wallH, BUILD.stoneWallLight);
      }
      wallBand(p, g, 'right', -0.05, 4, BUILD.stoneWallLight);
      hangingSign(p, g, goldGlyph);
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

export function buildBuildings(): { art: BuildingArt[]; overlays: { name: string; pixels: Pixels }[] } {
  const art: BuildingArt[] = [];
  let seed = 6000;
  for (const [name, recipe] of Object.entries(RECIPES)) art.push(buildOne(name, (seed += 137), recipe));
  const overlays = [0, 1, 2, 3].map((f) => ({ name: `overlay.mill.wheel.${f}`, pixels: millWheel(f) }));
  return { art, overlays };
}

export const HOUSE_DESIGNS = 8;

/**
 * Map a simulation building type to its art.
 *
 * Houses pick a design from a hash of their id rather than their position in
 * the list, so a home keeps its face when the settlement grows around it.
 */
export function buildingArtKey(type: string, id: string): string {
  if (type !== 'House') return RECIPES[type] ? type : 'House.0';
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `House.${Math.abs(h) % HOUSE_DESIGNS}`;
}

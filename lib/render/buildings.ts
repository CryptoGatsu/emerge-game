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

const DARK = '#0c130d';

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
  dark: ['#3e4139', '#2e302b', '#20221e'],
  log: ['#6c5138', '#4f3a27', '#35271a'],
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
    for (let i = 0; i < 26; i++) {
      const t = r() * 0.96;
      const v = 0.72 + r() * 0.26;
      const w = 1 + Math.floor(r() * 4);
      wallPatch(p, g, side, t, v, w, 1 + Math.floor(r() * 2), r() < 0.6 ? BUILD.mossDark : BUILD.moss);
    }
    // One vine per face, climbing from the ground with a few leaves off it.
    if (r() < 0.7) {
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
  // Moss on the shaded slope: a roof in the forest is never clean.
  speckle(p, seed + 53, 70, [BUILD.mossDark, shade(BUILD.moss, -0.15)], (x, y) => x < cx - 4 && y > g.wallTopY - g.roofH && y < cy + halfH);
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
}

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

  groundShadow(p, g.cx, g.groundY - 2, bw * 0.52, bh * 0.36, 0.4);

  // Stone plinth under the walls so buildings sit into the ground.
  isoWalls(p, g.cx, g.wallTopY + 3, bw + 4, bh + 2, wallH, GROUND.stoneDark, shade(GROUND.stoneDark, -0.12));

  const [wLight, wMid, wDark] = WALLS[r.wall];
  isoWalls(p, g.cx, g.wallTopY, bw, bh, wallH, wMid, wDark);
  isoTop(p, g.cx, g.wallTopY, bw, bh, wLight);
  paintWallTexture(p, g, r.wall, seed);

  // Windows, dark by day and glowing on the lit overlay. At the top level a
  // second row goes in above the first, the way a building that has been
  // extended upward gets one.
  const windows = [...(r.windows ?? [])];
  if (level === 3) for (const [side, t, v] of r.windows ?? []) if (v > 0.3) windows.push([side, t, v - 0.34]);
  for (const [side, t, v] of windows) {
    wallPatch(p, g, side, t, v, 9, 10, BUILD.timberDark);
    wallPatch(p, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassDark);
    wallPatch(lit, g, side, t + 0.012, v + 0.06, 7, 7, BUILD.glassLit);
    wallPatch(lit, g, side, t + 0.03, v + 0.1, 3, 4, BUILD.glassLitCore);
    // Warm by day too — a little — so a home reads as lived in at noon.
    wallPatch(p, g, side, t + 0.03, v + 0.1, 3, 4, shade(BUILD.glassLit, -0.45));
    wallPatch(p, g, side, t + 0.03, v + 0.08, 2, 5, shade(BUILD.glassDark, 0.18));
  }

  const doorSpec = r.door ?? (['right', 0.42] as [Side, number]);
  const [dSide, dT] = doorSpec;
  wallPatch(p, g, dSide, dT, 0.3, 12, Math.round(wallH * 0.72), BUILD.timberDark);
  wallPatch(p, g, dSide, dT + 0.014, 0.34, 10, Math.round(wallH * 0.68), BUILD.timber);
  wallPatch(p, g, dSide, dT + 0.09, 0.55, 2, 2, BUILD.gold);
  // Light spilling out of the doorway after dark.
  wallPatch(lit, g, dSide, dT + 0.03, 0.4, 7, Math.round(wallH * 0.5), shade(BUILD.glassLit, -0.3));

  let chimneyOffset: [number, number] | undefined;
  if (r.chimneyAt !== undefined) {
    const [cxp, cyp] = chimney(p, g, r.chimneyAt, r.chimneyH ?? 20);
    chimneyOffset = [cxp - g.cx, cyp - g.groundY];
  }

  weather(p, g, seed);
  drawRoof(p, g, r.roof, r.roofColor, overhang, seed);
  r.extras?.(p, lit, g, seed);

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

export function buildBuildings(): { art: BuildingArt[]; overlays: { name: string; pixels: Pixels }[] } {
  const art: BuildingArt[] = [];
  let seed = 6000;
  for (const [name, recipe] of Object.entries(RECIPES)) {
    seed += 137;
    for (const level of ART_LEVELS) art.push(buildOne(name, seed, recipe, level));
  }
  const overlays = [0, 1, 2, 3].map((f) => ({ name: `overlay.mill.wheel.${f}`, pixels: millWheel(f) }));
  return { art, overlays };
}

export const HOUSE_DESIGNS = 8;

/** Every building type that has art of its own. */
export const BUILDING_TYPES = Object.keys(RECIPES).filter((k) => !k.startsWith('House.'));

/**
 * Map a simulation building to its art.
 *
 * Houses pick a design from a hash of their id rather than their position in
 * the list, so a home keeps its face when the settlement grows around it. The
 * level picks the dressed variant, so an improved building looks improved.
 */
export function buildingArtKey(type: string, id: string, level = 1): string {
  let base: string;
  if (type !== 'House') base = RECIPES[type] ? type : 'House.0';
  else {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    base = `House.${Math.abs(h) % HOUSE_DESIGNS}`;
  }
  const lvl = Math.max(1, Math.min(3, Math.round(level)));
  return lvl === 1 ? base : `${base}.L${lvl}`;
}

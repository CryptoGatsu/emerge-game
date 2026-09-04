/**
 * Terrain tile art.
 *
 * Every tile is a 64x32 isometric diamond painted with a base tone, tonal
 * speckle and hand-placed detail (blades, cobbles, ripples). The speckle is what
 * keeps large areas of grass and stone from reading as flat vector shapes, and
 * the multiple variants per type stop the ground from tiling visibly.
 */

import { GROUND, WATER, BLOOM, FOLIAGE } from './palette';
import {
  ELEVATION, TILE_H, TILE_W, diamondRow, fillDiamond, insideDiamond, rect,
  rng, shade, speckle, surface, type Pixels,
} from './pixelCanvas';

const tile = () => surface(TILE_W, TILE_H);
const clip = (x: number, y: number) => insideDiamond(x, y);

/**
 * Break up the tile's own silhouette.
 *
 * Anything that shades a tile's rim consistently — a bevel, an outline, a
 * light-to-dark gradient — draws the isometric grid across the entire world. So
 * edges get irregular tonal patches instead, which read as ground variation and
 * carry no repeating shape.
 */
function scuff(p: Pixels, seed: number, base: string) {
  const r = rng(seed);
  for (let i = 0; i < 26; i++) {
    const y = Math.floor(r() * TILE_H);
    const [x0, width] = diamondRow(y);
    const w = 2 + Math.floor(r() * 6);
    const x = r() < 0.5 ? x0 : x0 + width - w;
    rect(p, x, y, w, 1, shade(base, r() < 0.5 ? 0.09 : -0.11));
  }
}

/**
 * Bite irregular notches out of the tile's rim.
 *
 * Ground surfaces that meet each other — a path running through grass, a sand
 * bank against turf — are drawn over a grass tile, so erasing a ragged edge here
 * lets the grass show through and breaks the diamond staircase that a hard tile
 * boundary would otherwise produce.
 */
function ragged(p: Pixels, seed: number, depth: number) {
  const r = rng(seed);
  p.ctx.save();
  p.ctx.globalCompositeOperation = 'destination-out';
  p.ctx.fillStyle = '#000';
  for (let i = 0; i < 34; i++) {
    const y = Math.floor(r() * TILE_H);
    const [x0, width] = diamondRow(y);
    const bite = 1 + r() * depth;
    const h = 1 + Math.floor(r() * 3);
    if (r() < 0.5) p.ctx.fillRect(x0 - 1, y, bite, h);
    else p.ctx.fillRect(x0 + width - bite + 1, y, bite, h);
  }
  p.ctx.restore();
}

/** Short vertical blades that catch the light, scattered inside the diamond. */
function blades(p: Pixels, seed: number, count: number, colors: string[]) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(r() * TILE_W);
    const y = Math.floor(r() * TILE_H);
    const h = 1 + Math.floor(r() * 2);
    if (!insideDiamond(x, y) || !insideDiamond(x, y - h)) continue;
    rect(p, x, y - h, 1, h + 1, colors[Math.floor(r() * colors.length)]);
  }
}

function grassTile(seed: number, base: string, tone: 'plain' | 'flowers' | 'meadow' | 'forest'): Pixels {
  const p = tile();
  fillDiamond(p, base);
  speckle(p, seed, 260, [shade(base, 0.1), shade(base, -0.12), shade(base, 0.04), shade(base, -0.05)], clip);
  speckle(p, seed + 91, 60, [shade(base, -0.24)], clip, 2);
  blades(p, seed + 17, 34, [shade(base, 0.22), shade(base, 0.32), GROUND.grassLight]);
  if (tone === 'flowers') {
    const r = rng(seed + 401);
    const petals = [BLOOM.white, BLOOM.yellow, BLOOM.pink, BLOOM.violet];
    for (let i = 0; i < 9; i++) {
      const x = 6 + Math.floor(r() * (TILE_W - 12));
      const y = 4 + Math.floor(r() * (TILE_H - 8));
      if (!insideDiamond(x, y)) continue;
      rect(p, x, y, 1, 1, petals[Math.floor(r() * petals.length)]);
      rect(p, x, y + 1, 1, 1, shade(base, -0.2));
    }
  }
  if (tone === 'meadow') {
    blades(p, seed + 77, 46, [GROUND.meadow, shade(GROUND.meadow, 0.18), BLOOM.wheat]);
  }
  if (tone === 'forest') {
    speckle(p, seed + 213, 46, [FOLIAGE.trunkDark, GROUND.forestFloorDark, FOLIAGE.pineDark], clip);
    const r = rng(seed + 55);
    for (let i = 0; i < 5; i++) {
      const x = 8 + Math.floor(r() * (TILE_W - 16));
      const y = 6 + Math.floor(r() * (TILE_H - 12));
      if (!insideDiamond(x, y)) continue;
      rect(p, x, y, 3, 1, FOLIAGE.trunkDark);
    }
  }
  scuff(p, seed + 611, base);
  return p;
}

function soilTile(seed: number, tilled: boolean): Pixels {
  const p = tile();
  const base = tilled ? GROUND.soilTilled : GROUND.soil;
  fillDiamond(p, base);
  speckle(p, seed, 220, [shade(base, 0.1), shade(base, -0.14), shade(base, -0.06)], clip);
  if (tilled) {
    // Furrows run along the tile's north-east axis so fields read as ploughed.
    for (let i = -3; i <= 3; i++) {
      for (let t = 0; t < TILE_W; t++) {
        const x = t;
        const y = Math.round(TILE_H / 2 + (t - TILE_W / 2) * 0.5 + i * 5);
        if (!insideDiamond(x, y)) continue;
        rect(p, x, y, 1, 1, i % 2 === 0 ? GROUND.soilDark : shade(base, 0.12));
      }
    }
  }
  scuff(p, seed + 612, base);
  if (tilled) ragged(p, seed + 712, 5);
  return p;
}

function cropTile(seed: number, kind: 'wheat' | 'veg'): Pixels {
  const p = soilTile(seed, true);
  const r = rng(seed + 909);
  for (let row = -2; row <= 2; row++) {
    for (let t = 4; t < TILE_W - 4; t += 3) {
      const x = t;
      const y = Math.round(TILE_H / 2 + (t - TILE_W / 2) * 0.5 + row * 6);
      if (!insideDiamond(x, y)) continue;
      if (kind === 'wheat') {
        const h = 4 + Math.floor(r() * 3);
        rect(p, x, y - h, 1, h, BLOOM.wheatDark);
        rect(p, x, y - h - 1, 1, 2, BLOOM.wheat);
      } else {
        rect(p, x - 1, y - 3, 3, 3, FOLIAGE.bush);
        rect(p, x, y - 4, 1, 1, FOLIAGE.bushLight);
      }
    }
  }
  return p;
}

function pathTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.path);
  speckle(p, seed, 200, [GROUND.pathDark, GROUND.pathLight, shade(GROUND.path, -0.08)], clip);
  // Irregular cobbles rather than a repeating grid. Every variant carries the
  // same number of stones and differs only in where they fall.
  const r = rng(seed + 313);
  const stones = 22;
  for (let i = 0; i < stones; i++) {
    const cx = 4 + Math.floor(r() * (TILE_W - 8));
    const cy = 3 + Math.floor(r() * (TILE_H - 6));
    const w = 3 + Math.floor(r() * 4);
    const h = 2 + Math.floor(r() * 2);
    if (!insideDiamond(cx, cy) || !insideDiamond(cx + w, cy + h)) continue;
    const tone = r() < 0.5 ? GROUND.stone : GROUND.stoneLight;
    rect(p, cx, cy, w, h, tone);
    rect(p, cx, cy + h, w, 1, GROUND.stoneDark);
    rect(p, cx, cy, w, 1, shade(tone, 0.16));
  }
  // A little grass creeping in at the edges keeps paths from looking laid out.
  speckle(p, seed + 77, 26, [GROUND.grassDark, GROUND.moss], (x, y) => {
    if (!insideDiamond(x, y)) return false;
    const [x0, width] = diamondRow(y);
    return x < x0 + 6 || x > x0 + width - 6;
  });
  scuff(p, seed + 613, GROUND.path);
  ragged(p, seed + 713, 7);
  return p;
}

/**
 * A township street: close-set cobbles with the grass kept out, which is
 * what separates a town's road from a settlement's worn track.
 */
function cobbleTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, shade(GROUND.plaza, -0.06));
  speckle(p, seed, 120, [shade(GROUND.plaza, 0.06), shade(GROUND.plaza, -0.14)], clip);
  const r = rng(seed + 919);
  for (let y = 2; y < TILE_H - 2; y += 3) {
    const [x0, width] = diamondRow(y);
    const offset = ((y / 3) | 0) % 2 ? 2 : 0;
    for (let x = x0 + 1 + offset; x < x0 + width - 4; x += 5) {
      if (!insideDiamond(x, y) || !insideDiamond(x + 3, y + 2)) continue;
      const tone = r() < 0.5 ? GROUND.stone : GROUND.stoneLight;
      rect(p, x, y, 4, 2, tone);
      rect(p, x, y + 2, 4, 1, GROUND.stoneDark);
      rect(p, x, y, 4, 1, shade(tone, 0.14));
    }
  }
  scuff(p, seed + 615, shade(GROUND.plaza, -0.06));
  ragged(p, seed + 715, 3);
  return p;
}

function plazaTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.plaza);
  speckle(p, seed, 160, [shade(GROUND.plaza, 0.08), shade(GROUND.plaza, -0.12)], clip);
  // Flagstones follow the isometric axes so the square reads as laid paving.
  for (let y = 0; y < TILE_H; y++) {
    const [x0, width] = diamondRow(y);
    for (let x = x0; x < x0 + width; x++) {
      const u = Math.round((x - TILE_W / 2) / 2 + (y - TILE_H / 2));
      const v = Math.round((x - TILE_W / 2) / 2 - (y - TILE_H / 2));
      if (u % 8 === 0 || v % 8 === 0) rect(p, x, y, 1, 1, GROUND.stoneDark);
    }
  }
  scuff(p, seed + 614, GROUND.plaza);
  ragged(p, seed + 714, 3);
  return p;
}

function rockTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.rock);
  speckle(p, seed, 240, [GROUND.rockDark, GROUND.rockLight, shade(GROUND.rock, -0.1)], clip);
  const r = rng(seed + 641);
  for (let i = 0; i < 7; i++) {
    const cx = 8 + Math.floor(r() * (TILE_W - 16));
    const cy = 5 + Math.floor(r() * (TILE_H - 10));
    const w = 5 + Math.floor(r() * 8);
    const h = 3 + Math.floor(r() * 4);
    if (!insideDiamond(cx, cy) || !insideDiamond(cx + w, cy + h)) continue;
    rect(p, cx, cy, w, h, GROUND.rockLight);
    rect(p, cx, cy + h - 1, w, 1, GROUND.rockDark);
  }
  scuff(p, seed + 615, GROUND.rock);
  return p;
}

function sandTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.sand);
  speckle(p, seed, 240, [GROUND.sandDark, shade(GROUND.sand, 0.12)], clip);
  scuff(p, seed + 616, GROUND.sand);
  ragged(p, seed + 716, 8);
  return p;
}

/**
 * Desert sand.
 *
 * Wind ripples run along the tile's north-east axis, the same direction the
 * ploughed furrows use, so a dune field reads as one continuous surface with
 * weather over it rather than as tiles that each have their own pattern.
 */
function duneTile(seed: number, variant: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.dune);
  speckle(p, seed, 250, [GROUND.duneDark, GROUND.duneLight, shade(GROUND.dune, 0.06)], clip);
  const r = rng(seed + 811);
  const ripples = 3 + variant;
  for (let i = 0; i < ripples; i++) {
    const offset = -14 + i * (28 / ripples) + r() * 3;
    for (let t = 0; t < TILE_W; t++) {
      const y = Math.round(TILE_H / 2 + (t - TILE_W / 2) * 0.5 + offset + Math.sin(t * 0.12 + i) * 1.4);
      if (!insideDiamond(t, y)) continue;
      rect(p, t, y, 1, 1, GROUND.duneLight);
      if (insideDiamond(t, y + 1)) rect(p, t, y + 1, 1, 1, GROUND.duneDark);
    }
  }
  scuff(p, seed + 618, GROUND.dune);
  return p;
}

/** Sodden fen: dark ground, standing puddles, tussocks of reed. */
function marshTile(seed: number, variant: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.marsh);
  speckle(p, seed, 250, [GROUND.marshDark, shade(GROUND.marsh, 0.12), GROUND.moss], clip);
  const r = rng(seed + 902);
  // Puddles, drawn as flat blots rather than rings so they sit in the ground.
  for (let i = 0; i < 2 + variant; i++) {
    const cx = 10 + Math.floor(r() * (TILE_W - 20));
    const cy = 6 + Math.floor(r() * (TILE_H - 12));
    const w = 5 + Math.floor(r() * 9);
    for (let y = 0; y < 3; y++) {
      const inset = Math.abs(y - 1) * 2;
      if (!insideDiamond(cx + inset, cy + y)) continue;
      rect(p, cx + inset, cy + y, Math.max(1, w - inset * 2), 1, y === 0 ? GROUND.marshWet : shade(GROUND.marshWet, -0.08));
    }
  }
  blades(p, seed + 55, 30, [shade(GROUND.marsh, 0.26), GROUND.scrubDry, GROUND.moss]);
  scuff(p, seed + 619, GROUND.marsh);
  return p;
}

/** Dry steppe: bleached grass with the dust showing through it. */
function scrubTile(seed: number, variant: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.scrub);
  speckle(p, seed, 260, [GROUND.scrubDark, GROUND.scrubDry, shade(GROUND.scrub, 0.08)], clip);
  speckle(p, seed + 141, 40 + variant * 20, [GROUND.duneDark], clip, 2);
  blades(p, seed + 27, 40, [GROUND.scrubDry, shade(GROUND.scrubDry, 0.18), GROUND.scrubDark]);
  scuff(p, seed + 620, GROUND.scrub);
  return p;
}

function snowTile(seed: number): Pixels {
  const p = tile();
  fillDiamond(p, GROUND.snow);
  speckle(p, seed, 150, [shade(GROUND.snow, -0.06), '#ffffff'], clip);
  scuff(p, seed + 617, GROUND.snow);
  return p;
}

/**
 * Animated water.
 *
 * Deliberately almost flat in tone. Any per-tile gradient, rim highlight or
 * foam ring turns a river into a quilt of visible diamonds, so all the interest
 * comes from low-contrast ripples that drift across the frames.
 */
function waterTile(seed: number, frame: number, shore: boolean): Pixels {
  const p = tile();
  const base = shore ? WATER.shallow : WATER.mid;
  fillDiamond(p, base);
  speckle(p, seed + frame, 150, [shade(base, 0.05), shade(base, -0.05)], clip);
  const r = rng(seed + 17);
  for (let i = 0; i < 11; i++) {
    const y = 3 + Math.floor(r() * (TILE_H - 6));
    const w = 5 + Math.floor(r() * 11);
    const drift = Math.round(Math.sin((y * 0.4) + frame * 1.6) * 3);
    const x = Math.floor(r() * TILE_W) + drift;
    if (!insideDiamond(x, y) || !insideDiamond(x + w, y)) continue;
    rect(p, x, y, w, 1, shade(base, i % 3 === 0 ? 0.16 : 0.08));
  }
  // A couple of brighter glints, kept sparse so the repeat is not readable.
  for (let i = 0; i < 2; i++) {
    const y = 8 + Math.floor(r() * (TILE_H - 16));
    const x = 20 + Math.floor(r() * 24) + frame * 3;
    if (insideDiamond(x, y) && insideDiamond(x + 4, y)) rect(p, x, y, 4, 1, WATER.highlight);
  }
  return p;
}

/**
 * Foam along one edge of a water tile.
 *
 * Drawn per edge and applied only where water actually meets land, rather than
 * ringing every water tile — a foam ring on all four sides outlines the
 * isometric grid across the whole surface, which is what the earlier shore
 * variant did wrong.
 */
export type ShoreEdge = 'nw' | 'ne' | 'se' | 'sw';

function foamEdge(edge: ShoreEdge, seed: number): Pixels {
  const p = tile();
  const r = rng(seed);
  const half = TILE_H / 2;
  for (let y = 0; y < TILE_H; y++) {
    const [x0, width] = diamondRow(y);
    const upper = y < half;
    // Each edge occupies one half of the diamond's outline.
    const onEdge =
      (edge === 'nw' && upper) || (edge === 'sw' && !upper) ? 'left'
        : (edge === 'ne' && upper) || (edge === 'se' && !upper) ? 'right'
          : null;
    if (!onEdge) continue;
    const depth = 2 + Math.round(r() * 3);
    const x = onEdge === 'left' ? x0 : x0 + width - depth;
    rect(p, x, y, depth, 1, WATER.foam);
    if (r() < 0.45) rect(p, onEdge === 'left' ? x + depth : x - 1, y, 1, 1, shade(WATER.foam, -0.15));
  }
  return p;
}

/** The vertical rock face shown below a raised tile. */
function cliffFace(seed: number): Pixels {
  const p = surface(TILE_W, TILE_H + ELEVATION);
  for (let y = TILE_H / 2; y < TILE_H; y++) {
    const [x0, width] = diamondRow(y);
    const left = x0;
    const right = x0 + width;
    for (let d = 0; d < ELEVATION; d++) {
      rect(p, left, y + d, Math.floor(width / 2), 1, GROUND.rockDark);
      rect(p, left + Math.floor(width / 2), y + d, Math.ceil(width / 2), 1, GROUND.rock);
    }
    rect(p, left, y + ELEVATION, width, 1, shade(GROUND.rockDark, -0.3));
    void right;
  }
  speckle(p, seed, 220, [GROUND.rockLight, shade(GROUND.rockDark, -0.15)], (x, y) => {
    if (y < TILE_H / 2 || y > TILE_H + ELEVATION) return false;
    const row = Math.min(y, TILE_H - 1);
    const [x0, width] = diamondRow(row);
    return x >= x0 && x < x0 + width;
  });
  return p;
}

/** Falling water where the river drops off the plateau. Four animated frames. */
function waterfallFrame(frame: number): Pixels {
  const p = surface(TILE_W, TILE_H + ELEVATION);
  for (let y = TILE_H / 2; y < TILE_H; y++) {
    const [x0, width] = diamondRow(y);
    for (let d = 0; d < ELEVATION; d++) {
      rect(p, x0 + 4, y + d, width - 8, 1, WATER.shallow);
    }
  }
  const r = rng(frame * 71 + 5);
  for (let i = 0; i < 26; i++) {
    const x = 10 + Math.floor(r() * (TILE_W - 20));
    const y = TILE_H / 2 + ((Math.floor(r() * (ELEVATION + 8)) + frame * 4) % (ELEVATION + 8));
    rect(p, x, y, 1, 2 + Math.floor(r() * 3), i % 2 ? WATER.foam : WATER.highlight);
  }
  for (let i = 0; i < 12; i++) {
    const x = 12 + Math.floor(r() * (TILE_W - 24));
    rect(p, x, TILE_H + ELEVATION - 3 + Math.floor(r() * 3), 2, 1, WATER.foam);
  }
  return p;
}

/**
 * Seamless distant-canopy fill.
 *
 * The tile field is a diamond, so the corners of any rectangular viewport can
 * fall outside it. Rather than clamping the camera into the small rectangle that
 * fits inside the diamond, the scene lays this behind everything: what you see
 * past the edge of the settlement is deep forest, not void. Blobs are drawn with
 * their wrapped copies so the texture tiles without a seam.
 */
export function canopyPattern(): Pixels {
  const size = 128;
  const p = surface(size, size);
  rect(p, 0, 0, size, size, '#14290f');
  const r = rng(9091);
  const tones = ['#1b3616', '#22421b', '#182f12', '#2a4d21'];
  for (let i = 0; i < 210; i++) {
    const cx = r() * size;
    const cy = r() * size;
    const rad = 4 + r() * 9;
    const color = tones[Math.floor(r() * tones.length)];
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        p.ctx.fillStyle = color;
        p.ctx.beginPath();
        p.ctx.ellipse(cx + dx, cy + dy, rad, rad * 0.62, 0, 0, Math.PI * 2);
        p.ctx.fill();
      }
    }
  }
  speckle(p, 4242, 900, ['#0f2210', '#2d5626']);
  return p;
}

export interface TileArt { name: string; pixels: Pixels }

/** Build the full terrain tile set. Names are what `assets.get()` expects. */
export function buildTiles(): TileArt[] {
  const out: TileArt[] = [];
  const add = (name: string, pixels: Pixels) => out.push({ name, pixels });

  for (let i = 0; i < 4; i++) add(`tile.grass.${i}`, grassTile(1000 + i * 37, GROUND.grass, 'plain'));
  for (let i = 0; i < 2; i++) add(`tile.flowers.${i}`, grassTile(1400 + i * 53, GROUND.grass, 'flowers'));
  for (let i = 0; i < 2; i++) add(`tile.meadow.${i}`, grassTile(1600 + i * 61, GROUND.meadow, 'meadow'));
  for (let i = 0; i < 2; i++) add(`tile.forest.${i}`, grassTile(1800 + i * 71, GROUND.forestFloor, 'forest'));
  add('tile.soil.0', soilTile(2000, false));
  for (let i = 0; i < 2; i++) add(`tile.tilled.${i}`, soilTile(2100 + i * 29, true));
  add('tile.crop.wheat', cropTile(2200, 'wheat'));
  add('tile.crop.veg', cropTile(2300, 'veg'));
  for (let i = 0; i < 3; i++) add(`tile.path.${i}`, pathTile(2400 + i * 43));
  for (let i = 0; i < 2; i++) add(`tile.plaza.${i}`, plazaTile(2600 + i * 31));
  for (let i = 0; i < 3; i++) add(`tile.cobble.${i}`, cobbleTile(2700 + i * 37));
  for (let i = 0; i < 2; i++) add(`tile.rock.${i}`, rockTile(2800 + i * 47));
  add('tile.sand.0', sandTile(3000));
  add('tile.snow.0', snowTile(3100));
  for (let i = 0; i < 3; i++) add(`tile.dune.${i}`, duneTile(3600 + i * 41, i));
  for (let i = 0; i < 3; i++) add(`tile.marsh.${i}`, marshTile(3700 + i * 59, i));
  for (let i = 0; i < 3; i++) add(`tile.scrub.${i}`, scrubTile(3800 + i * 67, i));
  for (let f = 0; f < 4; f++) add(`tile.water.${f}`, waterTile(3200, f, false));
  for (let f = 0; f < 4; f++) add(`tile.watershore.${f}`, waterTile(3300, f, true));
  add('tile.cliff.0', cliffFace(3400));
  for (const edge of ['nw', 'ne', 'se', 'sw'] as ShoreEdge[]) add(`tile.foam.${edge}`, foamEdge(edge, 3500 + edge.length));
  for (let f = 0; f < 4; f++) add(`tile.waterfall.${f}`, waterfallFrame(f));
  return out;
}

/** Variant counts, so the world generator can pick without hard-coding numbers. */
export const TILE_VARIANTS: Record<string, number> = {
  grass: 4, flowers: 2, meadow: 2, forest: 2, soil: 1, tilled: 2,
  path: 3, plaza: 2, rock: 2, sand: 1, snow: 1, water: 4, watershore: 4,
  dune: 3, marsh: 3, scrub: 3,
};

/**
 * Isometric projection.
 *
 * The simulation thinks in a 0-100 square of "world units". The renderer thinks
 * in a GRID x GRID field of 2:1 isometric tiles. This module is the only place
 * that converts between them, so the simulation never has to know how the world
 * is drawn.
 */

export const GRID = 48;
export const TILE_W = 64;
export const TILE_H = 32;
/** Screen rise of one elevation step. */
export const ELEVATION = 16;

/** World units (0-100) to tile space (0-GRID). */
export const worldToTile = (v: number) => (v / 100) * GRID;
/** Tile space back to world units. */
export const tileToWorld = (v: number) => (v / GRID) * 100;

export interface ScreenPoint { x: number; y: number }

/** Tile-space coordinates to screen pixels. Fractional input is fine. */
export function tileToScreen(tx: number, ty: number, height = 0): ScreenPoint {
  return {
    x: (tx - ty) * (TILE_W / 2),
    y: (tx + ty) * (TILE_H / 2) - height * ELEVATION,
  };
}

/** World units straight to screen pixels. */
export function worldToScreen(wx: number, wy: number, height = 0): ScreenPoint {
  return tileToScreen(worldToTile(wx), worldToTile(wy), height);
}

/** Screen pixels back to tile space, for picking and click-to-place. */
export function screenToTile(sx: number, sy: number): ScreenPoint {
  return {
    x: (sy / (TILE_H / 2) + sx / (TILE_W / 2)) / 2,
    y: (sy / (TILE_H / 2) - sx / (TILE_W / 2)) / 2,
  };
}

/** Screen pixels back to world units. */
export function screenToWorld(sx: number, sy: number): ScreenPoint {
  const t = screenToTile(sx, sy);
  return { x: tileToWorld(t.x), y: tileToWorld(t.y) };
}

/**
 * Depth key for painter's-algorithm sorting. Everything in the object layer is
 * sorted by this so citizens correctly pass in front of and behind buildings.
 */
export function depthOf(wx: number, wy: number, bias = 0) {
  return worldToTile(wx) + worldToTile(wy) + bias;
}

/** Bounding box of the whole tile field in screen pixels. */
export const SCENE_BOUNDS = {
  minX: -GRID * (TILE_W / 2),
  maxX: GRID * (TILE_W / 2),
  minY: -ELEVATION - 80,
  maxY: GRID * TILE_H + 80,
};

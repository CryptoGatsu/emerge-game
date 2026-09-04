/**
 * Isometric projection.
 *
 * The simulation thinks in a 0-100 square of "world units". The renderer thinks
 * in a GRID x GRID field of 2:1 isometric tiles. This module is the only place
 * that converts between them, so the simulation never has to know how the world
 * is drawn.
 */

import { BASE_EXTENT, type Extent } from './extent';

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

/**
 * Bounding box of a plot's tile field in screen pixels, with where its tiles
 * start in absolute tile space and how many there are across.
 *
 * An expanded plot has tiles at negative indices: the land grew outward and
 * the old ground kept its coordinates, so the first row of an expanded plot
 * is row −6. Everything that loops over tiles adds `t0` to the local index
 * before projecting, and everything that clamps the camera or draws the
 * minimap reads the box from here.
 */
export interface SceneBounds {
  minX: number; maxX: number; minY: number; maxY: number;
  /** Absolute tile index of the first column and row. */
  t0: number;
  /** Tiles across. */
  grid: number;
}

export function sceneBoundsOf(extent: Extent): SceneBounds {
  const t0 = worldToTile(extent.x0);
  const t1 = worldToTile(extent.x1);
  return {
    minX: (t0 - t1) * (TILE_W / 2),
    maxX: (t1 - t0) * (TILE_W / 2),
    minY: (t0 + t0) * (TILE_H / 2) - ELEVATION - 80,
    maxY: (t1 + t1) * (TILE_H / 2) + 80,
    t0,
    grid: Math.round(t1 - t0),
  };
}

/** The base plot's box, for anything that has not asked for a world's own. */
export const SCENE_BOUNDS: SceneBounds = sceneBoundsOf(BASE_EXTENT);

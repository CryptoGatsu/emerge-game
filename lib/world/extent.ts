/**
 * How big a plot is.
 *
 * The simulation thinks in world units, and for the whole of the game's life a
 * plot was the square from 0 to 100 on both axes. An expansion makes it
 * bigger. Rather than move everything a settlement has built, the land grows
 * *outward*: every coordinate anybody saved stays exactly where it was, and a
 * ring of new ground appears beyond the old edge. Every module that used to
 * assume 0–100 — terrain, water, walking, the camera, the minimap — reads the
 * extent from here instead.
 *
 * No imports, so the renderer and the simulation can both use it without
 * dragging each other in.
 */

export interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A plot as surveyed. */
export const BASE_EXTENT: Extent = { x0: 0, y0: 0, x1: 100, y1: 100 };

/**
 * How far the land grows on every side when a plot is expanded, in world
 * units. Six tiles: the terrain grid is 48 tiles across the base plot, so the
 * ring lands exactly on tile boundaries and the old ground is not resampled.
 */
export const EXPANSION_RING = 12.5;

/** A plot after its expansion: 125 units across, about 56% more ground. */
export const EXPANDED_EXTENT: Extent = {
  x0: -EXPANSION_RING, y0: -EXPANSION_RING, x1: 100 + EXPANSION_RING, y1: 100 + EXPANSION_RING,
};

export const extentOf = (world: { expanded?: boolean }): Extent =>
  world.expanded ? EXPANDED_EXTENT : BASE_EXTENT;

/** The extent pulled in by a margin on each side, for things that stay back from the edge. */
export const inset = (e: Extent, dx: number, dy = dx): Extent =>
  ({ x0: e.x0 + dx, y0: e.y0 + dy, x1: e.x1 - dx, y1: e.y1 - dy });

export const extentKey = (e: Extent) => `${e.x0},${e.y0},${e.x1},${e.y1}`;

/** Whether the extent is the base plot. */
export const isBase = (e: Extent) => e.x0 === 0 && e.y0 === 0 && e.x1 === 100 && e.y1 === 100;

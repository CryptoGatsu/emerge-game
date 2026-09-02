/**
 * Water.
 *
 * One source of truth for where the water is, shared by everything that needs
 * to know. The terrain generator paints it, the settlement planner routes roads
 * around it and drops bridges where they must cross, and the simulation keeps
 * citizens out of it. Before this module each of those had its own idea of
 * where the river ran, which is how people ended up strolling across it.
 *
 * The field is sampled once into a coarse grid at world creation. Testing a
 * position against a few hundred polyline samples every frame, for every
 * citizen, is not affordable; a lookup is.
 */

import { PONDS, WATER_ROUTES, type BiomeProfile } from './biomes';
import { hash2, valueNoise } from './noise';
import { heightField } from './relief';

export { hash2, valueNoise };

/** Cells per side of the sampled mask. One cell is a little over a world unit. */
export const WATER_CELLS = 96;

export interface Polyline {
  pts: [number, number][];
  widths: number[];
}

export interface WaterField {
  /** The channels, for the terrain generator to paint and meander. */
  river: Polyline;
  pond: { x: number; y: number; r: number };
  /** True where a citizen would be standing in water. */
  isWater(wx: number, wy: number): boolean;
  /**
   * Unit vector toward the nearest dry ground, and how far it is. Zero-length
   * on land. This is what pushes someone who has ended up in the river back to
   * the bank, and it is precomputed rather than searched.
   */
  toLand(wx: number, wy: number): { x: number; y: number; d: number };
  /** How far the nearest water is, in world units. Zero when standing in it. */
  distanceToWater(wx: number, wy: number): number;
  /** Fraction of the map under water, which is what makes a fen a fen. */
  coverage: number;

  /**
   * Which landmass a point belongs to, or -1 in the water.
   *
   * Water divides the map into islands, and until this existed nothing knew
   * that. Citizens were pushed off a bank onto an islet with no dry route back
   * and simply stopped: one was measured standing four units from his own front
   * door for four days, unable to move at all, until he froze to death. The
   * settlement planner, the spawner and the escape push all now insist on the
   * mainland.
   */
  landAt(wx: number, wy: number): number;
  /** The largest landmass, which is where the settlement goes. */
  mainland: number;
  /** Every landmass, biggest first: id, how many cells, and a point on it. */
  islands: { id: number; cells: number; x: number; y: number }[];
  /** Unit vector to the nearest cell of the mainland, and how far. */
  toMainland(wx: number, wy: number): { x: number; y: number; d: number };
}

/** Squared distance from a point to the nearest sample, plus that sample's width. */
export function nearestOn(line: Polyline, x: number, y: number): { d: number; w: number } {
  let best = Infinity, w = 0;
  for (let i = 0; i < line.pts.length; i++) {
    const dx = line.pts[i][0] - x, dy = line.pts[i][1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; w = line.widths[i]; }
  }
  return { d: Math.sqrt(best), w };
}

function channelWidth(seed: number, t: number, scale: number) {
  return (2.5 + valueNoise(seed + 313, t * 2.4, 0) * 1.7) * scale;
}

/** Sample the biome's routes into a meandering polyline with per-sample width. */
function buildChannels(seed: number, profile: BiomeProfile): Polyline {
  const pts: [number, number][] = [];
  const widths: number[] = [];
  for (const route of WATER_ROUTES[profile.water]) {
    for (let i = 0; i < route.length - 1; i++) {
      const [ax, ay] = route[i];
      const [bx, by] = route[i + 1];
      const steps = 14;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        // Meander perpendicular to the run so the bank is never a straight edge.
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const wobble = (valueNoise(seed + 71, (i + t) * 1.7, 0) - 0.5) * 3.2;
        pts.push([ax + dx * t + nx * wobble, ay + dy * t + ny * wobble]);
        widths.push(channelWidth(seed, i + t, profile.waterScale));
      }
    }
  }
  return { pts, widths };
}

/**
 * Build the water for one world.
 *
 * The wet test is the same expression the terrain generator used to hold
 * privately, so the mask and the painted tiles agree by construction rather
 * than by two pieces of code happening to round the same way.
 */
export function buildWater(seed: number, profile: BiomeProfile): WaterField {
  const river = buildChannels(seed, profile);
  const base = PONDS[profile.water];
  const pond = { x: base.x, y: base.y, r: base.r * profile.pondScale };

  const wetAt = (wx: number, wy: number) => {
    // Water does not sit on top of the shelf. Where the channel crosses raised
    // ground it is a waterfall off the lip, which the terrain generator draws;
    // without this a highland settlement is planned on a river that runs
    // along the ridge it is standing on.
    const raised = heightField(seed, wx, wy, profile.plateau) > 0.5;
    if (river.pts.length && !raised) {
      const hit = nearestOn(river, wx, wy);
      if (hit.d < hit.w) return true;
    }
    if (raised) return false;
    const pondD = Math.hypot(wx - pond.x, wy - pond.y);
    const edge = pond.r + (valueNoise(seed + 55, wx * 0.14, wy * 0.14) - 0.5) * 5;
    return pondD < edge;
  };

  // Sample once, then work from the grid.
  const n = WATER_CELLS;
  const cell = 100 / n;
  const mask = new Uint8Array(n * n);
  let wet = 0;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const on = wetAt((gx + 0.5) * cell, (gy + 0.5) * cell) ? 1 : 0;
      mask[gy * n + gx] = on;
      wet += on;
    }
  }

  // Nearest dry cell for every wet cell, by breadth-first sweep out from the
  // bank. One pass over the grid gives every point in the water a direction to
  // walk to get out of it.
  const fromX = new Float32Array(n * n);
  const fromY = new Float32Array(n * n);
  const dist = new Float32Array(n * n).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    dist[i] = 0;
    fromX[i] = (i % n + 0.5) * cell;
    fromY[i] = (Math.floor(i / n) + 0.5) * cell;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const gx = i % n, gy = (i / n) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (dist[j] !== Infinity) continue;
      dist[j] = dist[i] + 1;
      fromX[j] = fromX[i];
      fromY[j] = fromY[i];
      queue.push(j);
    }
  }

  // And the mirror of it: how far a point on land is from the nearest water.
  // The settlement planner uses this to decide where a town wants to sit —
  // a harbour hugs the shore, a steppe hamlet keeps its distance.
  const dry = new Float32Array(n * n).fill(Infinity);
  const wetQueue: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    dry[i] = 0;
    wetQueue.push(i);
  }
  for (let head = 0; head < wetQueue.length; head++) {
    const i = wetQueue[head];
    const gx = i % n, gy = (i / n) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (dry[j] !== Infinity) continue;
      dry[j] = dry[i] + 1;
      wetQueue.push(j);
    }
  }

  // Which landmass each dry cell belongs to. A flood fill over the four
  // neighbours, so two shores separated by a channel are two islands.
  const land = new Int32Array(n * n).fill(-1);
  const islands: { id: number; cells: number; x: number; y: number }[] = [];
  let nextIsland = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || land[start] !== -1) continue;
    const id = nextIsland++;
    const stack = [start];
    land[start] = id;
    let cells = 0;
    let sx = 0, sy = 0;
    while (stack.length) {
      const i = stack.pop()!;
      cells++;
      const gx = i % n, gy = (i / n) | 0;
      sx += gx; sy += gy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (mask[j] || land[j] !== -1) continue;
        land[j] = id;
        stack.push(j);
      }
    }
    islands.push({ id, cells, x: (sx / cells + 0.5) * cell, y: (sy / cells + 0.5) * cell });
  }
  islands.sort((a, b) => b.cells - a.cells);
  const mainland = islands.length ? islands[0].id : -1;

  // And, for anything that finds itself on an islet, the way back to the
  // mainland — swept from the mainland's own cells so the answer is a real
  // destination rather than the nearest shore of wherever they are stranded.
  const mainX = new Float32Array(n * n);
  const mainY = new Float32Array(n * n);
  const mainD = new Float32Array(n * n).fill(Infinity);
  const mainQueue: number[] = [];
  for (let i = 0; i < land.length; i++) {
    if (land[i] !== mainland) continue;
    mainD[i] = 0;
    mainX[i] = (i % n + 0.5) * cell;
    mainY[i] = (Math.floor(i / n) + 0.5) * cell;
    mainQueue.push(i);
  }
  for (let head = 0; head < mainQueue.length; head++) {
    const i = mainQueue[head];
    const gx = i % n, gy = (i / n) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (mainD[j] !== Infinity) continue;
      mainD[j] = mainD[i] + 1;
      mainX[j] = mainX[i];
      mainY[j] = mainY[i];
      mainQueue.push(j);
    }
  }

  const indexOf = (wx: number, wy: number) => {
    const gx = Math.max(0, Math.min(n - 1, Math.floor(wx / cell)));
    const gy = Math.max(0, Math.min(n - 1, Math.floor(wy / cell)));
    return gy * n + gx;
  };

  return {
    river,
    pond,
    coverage: wet / mask.length,
    isWater: (wx, wy) => mask[indexOf(wx, wy)] === 1,
    // A world with no water at all leaves the sweep at infinity; report a
    // distance larger than the map instead, so callers can compare it freely.
    distanceToWater(wx, wy) {
      const d = dry[indexOf(wx, wy)];
      return Number.isFinite(d) ? d * cell : 999;
    },
    toLand(wx, wy) {
      const i = indexOf(wx, wy);
      if (!mask[i]) return { x: 0, y: 0, d: 0 };
      const dx = fromX[i] - wx, dy = fromY[i] - wy;
      const d = Math.hypot(dx, dy);
      if (d < 0.0001) return { x: 0, y: 1, d: cell };
      return { x: dx / d, y: dy / d, d };
    },
    landAt: (wx, wy) => land[indexOf(wx, wy)],
    mainland,
    islands,
    toMainland(wx, wy) {
      const i = indexOf(wx, wy);
      if (land[i] === mainland) return { x: 0, y: 0, d: 0 };
      const dx = mainX[i] - wx, dy = mainY[i] - wy;
      const d = Math.hypot(dx, dy);
      if (!Number.isFinite(d) || d < 0.0001) return { x: 0, y: 0, d: 0 };
      return { x: dx / d, y: dy / d, d };
    },
  };
}

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
import { BASE_EXTENT, isBase, type Extent } from './extent';
import { hash2, valueNoise } from './noise';
import { heightField } from './relief';

export { hash2, valueNoise };

/** Cells per side of the sampled mask. One cell is a little over a world unit. */
export const WATER_CELLS = 96;

/**
 * How far back from the water's edge a citizen has to stop, in world units.
 *
 * The mask records where the water is; the renderer draws it as whole
 * isometric tiles, each a little over two units across and painted wet if its
 * centre is. So the drawn shoreline reaches up to a tile's half-width past the
 * mask's edge, and a citizen walking right up to that edge is standing on
 * painted water — measured at one per cent of desert samples, every one of them
 * on a tile the player can see is a pond.
 *
 * Movement therefore stops clear of the drawn tile: one and a half units, which
 * is the distance from a tile's centre to its corner. Painting and placement
 * still use the exact mask, because that is what they are drawing and building
 * on.
 */
export const WALK_MARGIN = 1.5;

export interface Polyline {
  pts: [number, number][];
  widths: number[];
}

export interface WaterField {
  /** The plot this field covers. */
  extent: Extent;
  /** The channels, for the terrain generator to paint and meander. */
  river: Polyline;
  pond: { x: number; y: number; r: number };
  /** True where the mask says there is water: what the renderer paints. */
  isWater(wx: number, wy: number): boolean;
  /**
   * True where a citizen may not walk — the water, plus the margin that covers
   * the drawn tile's overhang past the mask.
   */
  blocks(wx: number, wy: number): boolean;
  /**
   * Unit vector to the nearest ground a citizen may stand on, and how far.
   *
   * `toLand` only answers for positions actually in the water, which left
   * anyone inside the margin with no way out at all: one was measured standing
   * on the same spot for an entire working day, her stall timer firing over and
   * over and handing her a new destination she could not take a single step
   * toward.
   */
  toClear(wx: number, wy: number): { x: number; y: number; d: number };
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

/**
 * A route as drawn for the base plot, carried on past its edge.
 *
 * The biome's routes end at the old map edge. On an expanded plot the river
 * would stop dead at an invisible line a dozen units short of the new shore,
 * so a route whose end sits at the old edge is continued in the direction it
 * was already going until it is well outside the new extent.
 */
function carryOn(route: [number, number][], extent: Extent): { route: [number, number][]; lead: number } {
  if (isBase(extent) || route.length < 2) return { route, lead: 0 };
  const reach = Math.max(extent.x1 - 100, -extent.x0, extent.y1 - 100, -extent.y0) + 10;
  const nearEdge = ([x, y]: [number, number]) => x < 8 || x > 92 || y < 8 || y > 92;
  const beyond = (from: [number, number], toward: [number, number]): [number, number] => {
    const dx = from[0] - toward[0], dy = from[1] - toward[1];
    const d = Math.hypot(dx, dy) || 1;
    return [from[0] + (dx / d) * reach, from[1] + (dy / d) * reach];
  };
  const out = route.slice();
  let lead = 0;
  if (nearEdge(route[0])) { out.unshift(beyond(route[0], route[1])); lead = 1; }
  const last = route.length - 1;
  if (nearEdge(route[last])) out.push(beyond(route[last], route[last - 1]));
  return { route: out, lead };
}

/** Sample the biome's routes into a meandering polyline with per-sample width. */
function buildChannels(seed: number, profile: BiomeProfile, extent: Extent): Polyline {
  const pts: [number, number][] = [];
  const widths: number[] = [];
  for (const base of WATER_ROUTES[profile.water]) {
    const { route, lead } = carryOn(base, extent);
    for (let i = 0; i < route.length - 1; i++) {
      const [ax, ay] = route[i];
      const [bx, by] = route[i + 1];
      const steps = 14;
      // The meander and the width are noise over the segment index. A segment
      // added ahead of the route must not renumber the ones behind it, or
      // every bank on the old ground would move the day the plot expanded.
      const k = i - lead;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        // Meander perpendicular to the run so the bank is never a straight edge.
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const wobble = (valueNoise(seed + 71, (k + t) * 1.7, 0) - 0.5) * 3.2;
        pts.push([ax + dx * t + nx * wobble, ay + dy * t + ny * wobble]);
        widths.push(channelWidth(seed, k + t, profile.waterScale));
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
export function buildWater(seed: number, profile: BiomeProfile, extent: Extent = BASE_EXTENT): WaterField {
  const river = buildChannels(seed, profile, extent);
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

  // Sample once, then work from the grid. The cell is a fixed size in world
  // units; an expanded plot has more of them.
  const cell = 100 / WATER_CELLS;
  const n = Math.round((extent.x1 - extent.x0) / cell);
  const { x0, y0 } = extent;
  const mask = new Uint8Array(n * n);
  let wet = 0;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const on = wetAt(x0 + (gx + 0.5) * cell, y0 + (gy + 0.5) * cell) ? 1 : 0;
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
    fromX[i] = x0 + (i % n + 0.5) * cell;
    fromY[i] = y0 + (Math.floor(i / n) + 0.5) * cell;
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
    islands.push({ id, cells, x: x0 + (sx / cells + 0.5) * cell, y: y0 + (sy / cells + 0.5) * cell });
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
    mainX[i] = x0 + (i % n + 0.5) * cell;
    mainY[i] = y0 + (Math.floor(i / n) + 0.5) * cell;
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

  // The walkable mask: the water, dilated by a real radius.
  //
  // The breadth-first sweep above counts hops, not distance, so a cell
  // diagonally next to the water reads as two cells away — and comparing that
  // against a Euclidean margin let citizens stand on painted shore tiles while
  // the field insisted they were two units clear of the water. This dilation
  // measures the distance it claims to.
  const reach = Math.ceil(WALK_MARGIN / cell);
  const blocked = new Uint8Array(n * n);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const i = gy * n + gx;
      if (mask[i]) { blocked[i] = 1; continue; }
      for (let dy = -reach; dy <= reach && !blocked[i]; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (!mask[ny * n + nx]) continue;
          if (Math.hypot(dx, dy) * cell > WALK_MARGIN) continue;
          blocked[i] = 1;
          break;
        }
      }
    }
  }

  // And the way out of the blocked zone, for anyone who ends up inside it.
  const clearX = new Float32Array(n * n);
  const clearY = new Float32Array(n * n);
  const clearD = new Float32Array(n * n).fill(Infinity);
  const clearQueue: number[] = [];
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i]) continue;
    clearD[i] = 0;
    clearX[i] = x0 + (i % n + 0.5) * cell;
    clearY[i] = y0 + (Math.floor(i / n) + 0.5) * cell;
    clearQueue.push(i);
  }
  for (let head = 0; head < clearQueue.length; head++) {
    const i = clearQueue[head];
    const gx = i % n, gy = (i / n) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (clearD[j] !== Infinity) continue;
      clearD[j] = clearD[i] + 1;
      clearX[j] = clearX[i];
      clearY[j] = clearY[i];
      clearQueue.push(j);
    }
  }

  const indexOf = (wx: number, wy: number) => {
    const gx = Math.max(0, Math.min(n - 1, Math.floor((wx - x0) / cell)));
    const gy = Math.max(0, Math.min(n - 1, Math.floor((wy - y0) / cell)));
    return gy * n + gx;
  };

  return {
    extent,
    river,
    pond,
    coverage: wet / mask.length,
    isWater: (wx, wy) => mask[indexOf(wx, wy)] === 1,
    blocks: (wx, wy) => blocked[indexOf(wx, wy)] === 1,
    toClear(wx, wy) {
      const i = indexOf(wx, wy);
      if (!blocked[i]) return { x: 0, y: 0, d: 0 };
      const dx = clearX[i] - wx, dy = clearY[i] - wy;
      const d = Math.hypot(dx, dy);
      if (!Number.isFinite(d) || d < 0.0001) return { x: 0, y: 1, d: cell };
      return { x: dx / d, y: dy / d, d: d + 0.35 };
    },
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
      // Far enough to clear the drawn tile as well as the mask, or the escape
      // leaves them standing on the water they were just pulled out of. The
      // sweep counts hops, so the reported distance is already generous; a
      // little over the margin on top of it is enough.
      return { x: dx / d, y: dy / d, d: d + WALK_MARGIN * 0.5 };
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

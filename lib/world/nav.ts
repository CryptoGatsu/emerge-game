/**
 * Walking round things.
 *
 * The road graph says which junctions to pass through; between junctions a
 * citizen walked in a straight line and dealt with whatever was in the way by
 * being pushed out of it. That works for a wall met at an angle and fails for
 * anything a straight line cannot slide past: two footprints that touch, a
 * building dropped across a lane, an inlet with a bank on both sides. The
 * push and the pull cancel and the citizen stands there — measured at a fifth
 * of all walking time on one grassland plot, and one carpenter for seventeen
 * hours in the seam between a library and the market.
 *
 * So this is a small grid over the plot, one cell to the world unit, marking
 * what cannot be walked on: water off the decks, and every footprint with a
 * shoulder's margin. A leg is checked against it before it is walked, and a
 * leg that crosses something gets a route found round it instead. The route
 * is pulled tight afterwards so people walk in the few straight lines a person
 * would, not the staircase a grid gives.
 */

import { onDeck, type WorldLayout } from './layout';
import type { WaterField } from './water';

export interface NavObstacle { x: number; y: number; r: number; id: string }

/** Cells across the plot. The world is 0–100, so one cell is one unit. */
const N = 100;
/**
 * Kept clear round a footprint, in world units. More than half a cell's
 * diagonal, so that every point of a cell counted open really is outside the
 * wall — at less than that a straight line through open cells could still
 * clip a corner, and the walker was shoved off it on every third frame.
 */
const MARGIN = 0.75;
/** The most cells one search may open before giving up. Bounds the cost of an impossible route. */
const MAX_EXPANSIONS = 7000;
/** More than one footprint covers this cell. */
const SHARED = -2;
/** Nothing built here. */
const NOBODY = -1;

export interface NavGrid {
  /** Bit 1: water. Bit 2: inside a footprint. */
  blocked: Uint8Array;
  /** Which obstacle (index into the list the grid was built from) covers a cell, NOBODY or SHARED. */
  owner: Int16Array;
  /** What the grid was built from, so a stale one is noticed. */
  key: string;
}

/** A fingerprint of everything the grid depends on. */
export function navKey(obstacles: NavObstacle[], layout: WorldLayout): string {
  let key = `${layout.bridges.length}`;
  for (const o of obstacles) key += `|${o.id}:${o.x.toFixed(1)}:${o.y.toFixed(1)}:${o.r}`;
  return key;
}

export function buildNavGrid(water: WaterField, layout: WorldLayout, obstacles: NavObstacle[], key: string): NavGrid {
  const blocked = new Uint8Array(N * N);
  const owner = new Int16Array(N * N).fill(NOBODY);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // The centre and the four quarters: a cell with water in any corner is
      // not somewhere to route a straight line through.
      let wet = false;
      for (const [ox, oy] of QUARTERS) {
        const px = cx + ox, py = cy + oy;
        if (water.blocks(px, py) && !onDeck(layout.bridges, px, py)) { wet = true; break; }
      }
      if (wet) blocked[y * N + x] = 1;
    }
  }
  obstacles.forEach((o, index) => {
    const r = o.r + MARGIN;
    const x0 = Math.max(0, Math.floor(o.x - r)), x1 = Math.min(N - 1, Math.ceil(o.x + r));
    const y0 = Math.max(0, Math.floor(o.y - r)), y1 = Math.min(N - 1, Math.ceil(o.y + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - o.x, dy = y + 0.5 - o.y;
        if (dx * dx + dy * dy >= r * r) continue;
        const i = y * N + x;
        blocked[i] |= 2;
        owner[i] = owner[i] === NOBODY ? index : SHARED;
      }
    }
  });
  return { blocked, owner, key };
}

const QUARTERS: [number, number][] = [[0, 0], [-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];

const cellOf = (v: number) => Math.min(N - 1, Math.max(0, Math.floor(v)));

/**
 * Whether a cell may be walked on, by somebody allowed inside one footprint —
 * the building they are going to, whose doorstep is inside its own wall.
 */
function passable(grid: NavGrid, i: number, allow: number): boolean {
  const b = grid.blocked[i];
  if (b === 0) return true;
  if (b & 1) return false;
  return grid.owner[i] === allow;
}

/** Whether a straight walk from a to b stays on open ground. */
export function lineClear(grid: NavGrid, ax: number, ay: number, bx: number, by: number, allow = NOBODY): boolean {
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 0.001) return true;
  const steps = Math.ceil(d / 0.5);
  // The first sample is a little way out: somebody standing inside a margin
  // is not thereby unable to leave it.
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    if (!passable(grid, cellOf(y) * N + cellOf(x), allow)) return false;
  }
  return true;
}

/** Whether a point stands on open ground. */
export function openAt(grid: NavGrid, x: number, y: number, allow = NOBODY): boolean {
  return passable(grid, cellOf(y) * N + cellOf(x), allow);
}

/* A binary heap of cell indices ordered by f. */
class Heap {
  private items: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size() { return this.items.length; }
  push(i: number) {
    const a = this.items;
    a.push(i);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[k]]) break;
      [a[p], a[k]] = [a[k], a[p]];
      k = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        k = m;
      }
    }
    return top;
  }
}

/** The nearest passable cell to (x, y) within `reach` cells, or -1. */
function nearestOpen(grid: NavGrid, x: number, y: number, allow: number, reach: number): number {
  const cx = cellOf(x), cy = cellOf(y);
  let best = -1, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const i = ny * N + nx;
      if (!passable(grid, i, allow)) continue;
      const d = (nx + 0.5 - x) ** 2 + (ny + 0.5 - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

/**
 * A walk from (ax, ay) to (bx, by) round whatever is in the way.
 *
 * The answer is a short list of points to walk to in turn, ending at the
 * destination itself, or null when there is no way through — an islet, a
 * doorstep walled in on every side. `allow` is the index of the one obstacle
 * the walker may enter, normally the building they are going to.
 */
export function findDetour(grid: NavGrid, ax: number, ay: number, bx: number, by: number, allow = NOBODY): [number, number][] | null {
  const start = nearestOpen(grid, ax, ay, allow, 2);
  const goal = nearestOpen(grid, bx, by, allow, 3);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return lineClear(grid, ax, ay, bx, by, allow) ? [[bx, by]] : null;

  const g = new Float64Array(N * N).fill(Infinity);
  const f = new Float64Array(N * N).fill(Infinity);
  const came = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);
  const gx = goal % N, gy = (goal / N) | 0;
  const h = (i: number) => {
    const dx = Math.abs((i % N) - gx), dy = Math.abs(((i / N) | 0) - gy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  g[start] = 0;
  f[start] = h(start);
  const open = new Heap(f);
  open.push(start);
  let expansions = 0;
  let found = false;

  while (open.size) {
    const current = open.pop();
    if (closed[current]) continue;
    if (current === goal) { found = true; break; }
    closed[current] = 1;
    if (++expansions > MAX_EXPANSIONS) break;
    const x = current % N, y = (current / N) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const next = ny * N + nx;
        if (closed[next] || !passable(grid, next, allow)) continue;
        // No cutting corners: a diagonal step past a wall's corner is a step
        // through it.
        if (dx && dy && (!passable(grid, y * N + nx, allow) || !passable(grid, ny * N + x, allow))) continue;
        const score = g[current] + (dx && dy ? Math.SQRT2 : 1);
        if (score >= g[next]) continue;
        came[next] = current;
        g[next] = score;
        f[next] = score + h(next);
        open.push(next);
      }
    }
  }
  if (!found) return null;

  // Cells, goal first, then turned round.
  const cells: number[] = [];
  for (let cursor = goal; cursor !== -1; cursor = came[cursor]) cells.push(cursor);
  cells.reverse();
  const points: [number, number][] = cells.map((i) => [(i % N) + 0.5, ((i / N) | 0) + 0.5]);
  points[0] = [ax, ay];
  points[points.length - 1] = [bx, by];

  // Pull the string tight: from each point, walk to the farthest later point
  // still in clear sight of it.
  const out: [number, number][] = [];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !lineClear(grid, points[i][0], points[i][1], points[j][0], points[j][1], allow)) j--;
    out.push(points[j]);
    i = j;
  }
  return out;
}

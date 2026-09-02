/**
 * The settlement planner.
 *
 * Until now every world was the same village: one hand-authored road graph and
 * one list of house plots, shared by all of them, so a fen and a highland shelf
 * differed only in the ground under an identical town. This module replaces
 * that with a plan generated per world from its seed, its biome and — crucially
 * — where its water actually is.
 *
 * Each biome has its own archetype: a crossroads square, a clearing with paths
 * winding into the trees, two terraces joined by ramps, a causeway over wet
 * ground, a single long street, an arc along a shore, a ring around the only
 * spring for miles, hamlets on dry hummocks, a road enclosing a common green.
 * The archetype decides the shape; the seed rotates and jitters it; the water
 * decides where it can go.
 *
 * The output is consumed by three things that used to disagree: the simulation
 * routes citizens along `nodes`/`edges`, the terrain generator paints those
 * same curves as worn stone, and both read `bridges` for the places a road has
 * no choice but to cross water.
 */

import type { BiomeProfile, LayoutKind } from './biomes';
import { heightField } from './relief';
import { WALK_MARGIN, type WaterField } from './water';

/** What a road node is for, which is how sites are derived from the plan. */
export type NodeRole = 'core' | 'street' | 'residential' | 'work';

/** How far a deck reaches either side of the road's centre line. */
export const BRIDGE_HALF_WIDTH = 2.2;

/**
 * How far a deck reaches past the water at each end.
 *
 * It has to clear the margin citizens keep from the water's edge, with room to
 * spare, or the approach to the bridge is a slot narrower than a person: the
 * deck ended 1.8 units past the water while the margin held people back 1.5,
 * leaving three tenths of a unit of usable ramp. Every settlement with a bridge
 * had citizens shuffling at the foot of one for days on end — nineteen of
 * twenty-one in one valley — while the three biomes that generate no bridges at
 * all had none at all.
 */
export const BRIDGE_RAMP = WALK_MARGIN + 1.6;

/**
 * How far the drawn planks reach past the water, as opposed to the walkable
 * ramp. Just past the margin, so nobody is ever standing on bare ground the
 * water rule has already claimed.
 */
export const DECK_OVERHANG = WALK_MARGIN + 0.2;

/**
 * How close two crossings may be before the second one is redundant.
 *
 * A road graph that crosses the same river in five places gets five decks, and
 * a settlement of twenty people does not build five bridges over one stream.
 * Crossings nearer than this are thinned to the cheapest one, but only where
 * the road it carried has somewhere else to go.
 */
const MIN_CROSSING_GAP = 16;

/**
 * Whether a point is on one of these bridges.
 *
 * A deck is a narrow strip along the road, not a circle around a point. Testing
 * a radius let a settlement's five river crossings blanket the ground either
 * side of them: half of every citizen sample was standing "on a bridge", which
 * meant half the town was exempt from the water rule and, being outdoors and
 * never sheltered, froze through the first winter.
 */
export function onDeck(bridges: Bridge[], x: number, y: number) {
  return deckAt(bridges, x, y) !== null;
}

/**
 * Which deck a point is on, and where on it.
 *
 * Callers need more than a yes: a citizen crossing a bridge drifts off the
 * centre line — the scatter that spreads people around a destination, the push
 * away from a wall — and one step past the handrail is open water, where the
 * water rule refuses every direction and strands them mid-river. Knowing the
 * offset lets them be walked back to the middle of the deck instead.
 */
export function deckAt(bridges: Bridge[], x: number, y: number):
{ bridge: Bridge; along: number; across: number } | null {
  for (const bridge of bridges) {
    const dx = x - bridge.x, dy = y - bridge.y;
    const cos = Math.cos(bridge.angle), sin = Math.sin(bridge.angle);
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    if (Math.abs(along) <= bridge.span && Math.abs(across) <= BRIDGE_HALF_WIDTH) {
      return { bridge, along, across };
    }
  }
  return null;
}

export interface Bridge {
  x: number;
  y: number;
  /** Along the road, in radians, so the deck can be laid the right way. */
  angle: number;
  /**
   * Half the deck's length, in world units — enough to span the water it
   * crosses, with a little bank at each end.
   *
   * It used to be a fixed four and a half for every crossing. Anything wider
   * than that had a deck stopping short of the far bank, so the road was
   * impassable while still being in the routing graph: citizens walked to the
   * gap, found every direction refused, and stopped. Six of eighteen were piled
   * on one such spot, and most of that settlement's deaths were those people
   * freezing where they stood.
   */
  span: number;
  /**
   * Half the length of the deck as it is *drawn*, which is shorter.
   *
   * The walkable span has to clear the margin citizens keep from the water at
   * both ends, plus room to turn — three units of ramp on a stream one unit
   * across, so a village with five crossings had seventy units of planking laid
   * over thirteen units of water and read as a boardwalk town. The planks are
   * therefore drawn over the water and a short landing at each bank, while the
   * ground under the rest of the ramp stays the bank it looks like.
   */
  deck: number;
}

export interface WorldLayout {
  kind: LayoutKind;
  nodes: [number, number][];
  edges: number[][];
  roles: NodeRole[];
  /** Where the open ground at the heart of the settlement is. */
  plaza: { x: number; y: number; r: number };
  /** Sites for Market, Bank, Storage and Tavern, in that order. */
  civic: [number, number][];
  /** Sites for trade buildings, longest-lived first. */
  workSites: [number, number][];
  housePlots: [number, number][];
  bridges: Bridge[];
  /** Loitering spots sampled along the roads, so wanderers spread out. */
  wanderSpots: [number, number][];
}

type Point = [number, number];

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How close to water each archetype wants its centre.
 *
 * This is the single number that most decides where a town ends up. A harbour
 * that is not on the shore is not a harbour; a steppe hamlet parked on the
 * creek loses the point of the steppe.
 */
const WANTS_WATER: Record<LayoutKind, number> = {
  hub: 13, clearing: 15, terrace: 15, causeway: 7,
  lane: 17, harbour: 7, oasis: 9, scatter: 8, ring: 14,
};

/**
 * Choose where the settlement stands.
 *
 * Candidates are scored on how well they match the archetype's appetite for
 * water, how far they are from the edge of the map, and — for a terrace — how
 * close they sit to the lip of the shelf. Picking this rather than hard-coding
 * a centre is what stops every plot in a biome from being the same town.
 */
function chooseCentre(seed: number, profile: BiomeProfile, water: WaterField, kind: LayoutKind): Point {
  const want = WANTS_WATER[kind];
  const jitter = rng(seed ^ 0x5bd1e995);
  let best: Point = [50, 50];
  let bestScore = -Infinity;

  for (let y = 26; y <= 74; y += 3) {
    for (let x = 26; x <= 74; x += 3) {
      if (water.isWater(x, y) || water.landAt(x, y) !== water.mainland) continue;
      const toWater = Math.min(water.distanceToWater(x, y), 40);
      let score = -Math.abs(toWater - want) * 1.4;
      // Keep clear of the map edge: a town half off the field looks like a bug.
      score -= Math.max(0, 22 - Math.min(x, y, 100 - x, 100 - y)) * 0.9;
      if (kind === 'terrace') {
        // The lip of the shelf, where the ground is still walkable but rising.
        const h = heightField(seed, x, y, profile.plateau);
        score -= Math.abs(h - 0.46) * 26;
      } else if (profile.plateau > 0) {
        // Everywhere else prefers the flat.
        score -= heightField(seed, x, y, profile.plateau) * 7;
      }
      score += jitter() * 4;
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Plan builders
 * ------------------------------------------------------------------ */

interface Plan {
  nodes: Point[];
  edges: number[][];
  roles: NodeRole[];
}

/** Small builder so each archetype reads as a plan rather than as index arithmetic. */
class PlanBuilder {
  nodes: Point[] = [];
  roles: NodeRole[] = [];
  private links: Set<string> = new Set();
  private adj: number[][] = [];

  add(x: number, y: number, role: NodeRole) {
    this.nodes.push([clamp(x, 8, 92), clamp(y, 10, 90)]);
    this.roles.push(role);
    this.adj.push([]);
    return this.nodes.length - 1;
  }

  link(a: number, b: number) {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (this.links.has(key)) return;
    this.links.add(key);
    this.adj[a].push(b);
    this.adj[b].push(a);
  }

  /** A chain of nodes walking out from an anchor, with a wandering heading. */
  chain(from: number, angle: number, steps: number, length: number, turn: number, rand: () => number, endRole: NodeRole) {
    let [x, y] = this.nodes[from];
    let heading = angle;
    let prev = from;
    for (let i = 0; i < steps; i++) {
      heading += (rand() - 0.5) * turn;
      const step = length * (0.82 + rand() * 0.4);
      x += Math.cos(heading) * step;
      y += Math.sin(heading) * step;
      const last = i === steps - 1;
      const node = this.add(x, y, last ? endRole : 'street');
      this.link(prev, node);
      prev = node;
      [x, y] = this.nodes[node];
    }
    return prev;
  }

  done(): Plan {
    return { nodes: this.nodes, edges: this.adj, roles: this.roles };
  }
}

function buildHub(c: Point, angle: number, rand: () => number): Plan {
  const b = new PlanBuilder();
  const square = b.add(c[0], c[1], 'core');
  const arms = 5;
  const mid: number[] = [];
  for (let i = 0; i < arms; i++) {
    const a = angle + (i / arms) * TAU + (rand() - 0.5) * 0.3;
    const near = b.add(c[0] + Math.cos(a) * 9, c[1] + Math.sin(a) * 9 * 0.9, i === 1 ? 'residential' : 'street');
    b.link(square, near);
    const far = b.add(c[0] + Math.cos(a) * 19, c[1] + Math.sin(a) * 19 * 0.9, i === 1 ? 'residential' : 'street');
    b.link(near, far);
    mid.push(far);
    b.chain(far, a, 1, 11, 0.7, rand, 'work');
  }
  // A ring road joining the arms, which is what turns five roads into a town.
  for (let i = 0; i < arms; i++) b.link(mid[i], mid[(i + 1) % arms]);
  return b.done();
}

function buildClearing(c: Point, angle: number, rand: () => number): Plan {
  const b = new PlanBuilder();
  const ring: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = angle + (i / 5) * TAU;
    ring.push(b.add(c[0] + Math.cos(a) * 7, c[1] + Math.sin(a) * 7 * 0.85, i === 3 ? 'residential' : 'core'));
  }
  for (let i = 0; i < 5; i++) b.link(ring[i], ring[(i + 1) % 5]);
  // Paths that wander off into the trees rather than radiating cleanly.
  for (let i = 0; i < 4; i++) {
    const from = ring[i];
    const a = angle + (i / 4) * TAU + 0.4 + (rand() - 0.5) * 0.5;
    b.chain(from, a, 3, 9, 1.1, rand, 'work');
  }
  b.chain(ring[3], angle + Math.PI, 2, 8, 0.9, rand, 'residential');
  return b.done();
}

function buildTerrace(c: Point, angle: number, rand: () => number): Plan {
  const b = new PlanBuilder();
  const dx = Math.cos(angle), dy = Math.sin(angle) * 0.85;
  const nx = -dy, ny = dx;
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) * 9;
    const wob = (rand() - 0.5) * 2.5;
    upper.push(b.add(c[0] + dx * t + nx * (8 + wob), c[1] + dy * t + ny * (8 + wob), i === 0 || i === 4 ? 'work' : 'street'));
    lower.push(b.add(c[0] + dx * t - nx * (8 + wob), c[1] + dy * t - ny * (8 + wob), i === 2 ? 'core' : 'residential'));
  }
  for (let i = 0; i < 4; i++) { b.link(upper[i], upper[i + 1]); b.link(lower[i], lower[i + 1]); }
  // Ramps between the two levels, deliberately few: that is what makes it a terrace.
  b.link(upper[1], lower[1]);
  b.link(upper[3], lower[3]);
  b.chain(upper[2], angle - Math.PI / 2, 2, 11, 0.5, rand, 'work');
  b.chain(lower[0], angle + Math.PI, 1, 10, 0.6, rand, 'work');
  return b.done();
}

/** Walk in a heading, at each step preferring whichever nearby bearing is driest. */
function dryWalk(from: Point, heading: number, steps: number, length: number, water: WaterField): Point[] {
  const out: Point[] = [];
  let [x, y] = from;
  let a = heading;
  for (let i = 0; i < steps; i++) {
    let bestA = a, bestScore = -Infinity;
    for (const turn of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const ta = a + turn;
      const tx = clamp(x + Math.cos(ta) * length, 10, 90);
      const ty = clamp(y + Math.sin(ta) * length * 0.9, 12, 88);
      const score = Math.min(water.distanceToWater(tx, ty), 14) - Math.abs(turn) * 2;
      if (score > bestScore) { bestScore = score; bestA = ta; }
    }
    a = bestA;
    x = clamp(x + Math.cos(a) * length, 10, 90);
    y = clamp(y + Math.sin(a) * length * 0.9, 12, 88);
    out.push([x, y]);
  }
  return out;
}

function buildCauseway(c: Point, angle: number, rand: () => number, water: WaterField): Plan {
  const b = new PlanBuilder();
  const centre = b.add(c[0], c[1], 'core');
  // A spine that follows the dry ground in both directions out of the centre.
  const spine = [centre];
  for (const dir of [angle, angle + Math.PI]) {
    let prev = centre;
    for (const [x, y] of dryWalk(c, dir, 3, 11, water)) {
      const node = b.add(x, y, 'street');
      b.link(prev, node);
      prev = node;
      spine.push(node);
    }
    b.roles[prev] = 'work';
  }
  // Platforms off the causeway, each on the driest side.
  for (let i = 1; i < spine.length; i++) {
    const [sx, sy] = b.nodes[spine[i]];
    const perp = angle + Math.PI / 2;
    const a = water.distanceToWater(sx + Math.cos(perp) * 8, sy + Math.sin(perp) * 8)
      >= water.distanceToWater(sx - Math.cos(perp) * 8, sy - Math.sin(perp) * 8) ? perp : perp + Math.PI;
    const node = b.add(sx + Math.cos(a) * (7 + rand() * 2), sy + Math.sin(a) * (7 + rand() * 2) * 0.9,
      i % 2 === 0 ? 'residential' : 'work');
    b.link(spine[i], node);
  }
  return b.done();
}

function buildLane(c: Point, angle: number, rand: () => number): Plan {
  const b = new PlanBuilder();
  const dx = Math.cos(angle), dy = Math.sin(angle) * 0.88;
  const nx = -dy, ny = dx;
  const street: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = (i - 3) * 9.5;
    // A single shallow arc along the street, so it is not a ruled line.
    const bend = Math.sin((i / 6) * Math.PI) * 3.2;
    street.push(b.add(c[0] + dx * t + nx * bend, c[1] + dy * t + ny * bend, i === 3 ? 'core' : 'street'));
  }
  for (let i = 0; i < 6; i++) b.link(street[i], street[i + 1]);
  // Spurs alternating either side, work one way and homes the other.
  for (let i = 1; i <= 5; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const [sx, sy] = b.nodes[street[i]];
    const len = 8 + rand() * 3;
    const node = b.add(sx + nx * side * len, sy + ny * side * len, side > 0 ? 'work' : 'residential');
    b.link(street[i], node);
  }
  b.roles[street[0]] = 'work';
  b.roles[street[6]] = 'work';
  return b.done();
}

function buildHarbour(c: Point, angle: number, rand: () => number, water: WaterField): Plan {
  const b = new PlanBuilder();
  // Follow the bank, keeping a constant distance from the water.
  const along: number[] = [];
  let [x, y] = c;
  let a = angle;
  for (let i = 0; i < 6; i++) {
    let bestA = a, bestScore = -Infinity;
    for (const turn of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const ta = a + turn;
      const tx = clamp(x + Math.cos(ta) * 10, 10, 90);
      const ty = clamp(y + Math.sin(ta) * 10 * 0.9, 12, 88);
      // Reward staying on the shoreline contour, not simply staying dry.
      const score = -Math.abs(water.distanceToWater(tx, ty) - 7) - Math.abs(turn);
      if (score > bestScore) { bestScore = score; bestA = ta; }
    }
    a = bestA;
    x = clamp(x + Math.cos(a) * 10, 10, 90);
    y = clamp(y + Math.sin(a) * 10 * 0.9, 12, 88);
    const node = b.add(x, y, i === 2 ? 'core' : 'street');
    if (along.length) b.link(along[along.length - 1], node);
    along.push(node);
  }
  // Streets running inland, away from the water, where the work is.
  for (let i = 1; i < along.length; i += 2) {
    const [sx, sy] = b.nodes[along[i]];
    const inland = water.distanceToWater(sx + Math.cos(a + Math.PI / 2) * 10, sy + Math.sin(a + Math.PI / 2) * 10)
      > water.distanceToWater(sx - Math.cos(a + Math.PI / 2) * 10, sy - Math.sin(a + Math.PI / 2) * 10)
      ? a + Math.PI / 2 : a - Math.PI / 2;
    b.chain(along[i], inland + (rand() - 0.5) * 0.4, 2, 10, 0.5, rand, i === 3 ? 'residential' : 'work');
  }
  b.roles[along[1]] = 'residential';
  return b.done();
}

function buildOasis(c: Point, angle: number, rand: () => number, water: WaterField): Plan {
  const b = new PlanBuilder();
  const pond = water.pond;
  const r = pond.r + 6;
  const ring: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = angle + (i / 6) * TAU;
    ring.push(b.add(pond.x + Math.cos(a) * r, pond.y + Math.sin(a) * r * 0.9, i < 2 ? 'residential' : i === 3 ? 'core' : 'street'));
  }
  for (let i = 0; i < 6; i++) b.link(ring[i], ring[(i + 1) % 6]);
  // Roads out into the dunes, to the quarries and the mine heads.
  for (let i = 0; i < 6; i += 2) {
    const a = angle + (i / 6) * TAU;
    b.chain(ring[i], a, 2, 12, 0.4, rand, 'work');
  }
  void c;
  return b.done();
}

function buildScatter(c: Point, angle: number, rand: () => number, water: WaterField): Plan {
  const b = new PlanBuilder();
  const centre = b.add(c[0], c[1], 'core');
  // Four hamlets on the driest hummocks around the centre.
  for (let i = 0; i < 4; i++) {
    const base = angle + (i / 4) * TAU + (rand() - 0.5) * 0.4;
    let best: Point = [c[0] + Math.cos(base) * 18, c[1] + Math.sin(base) * 18 * 0.9];
    let bestScore = -Infinity;
    for (const spread of [-0.45, -0.2, 0, 0.2, 0.45]) {
      for (const reach of [15, 19, 23]) {
        const px = clamp(c[0] + Math.cos(base + spread) * reach, 12, 88);
        const py = clamp(c[1] + Math.sin(base + spread) * reach * 0.9, 14, 86);
        const score = Math.min(water.distanceToWater(px, py), 12);
        if (score > bestScore) { bestScore = score; best = [px, py]; }
      }
    }
    const hub = b.add(best[0], best[1], i === 0 ? 'residential' : 'work');
    b.link(centre, hub);
    // Two cabins off each hummock, so a hamlet is a place rather than a point.
    for (let k = 0; k < 2; k++) {
      const a = base + (k === 0 ? 1.9 : -1.9);
      const node = b.add(best[0] + Math.cos(a) * 6.5, best[1] + Math.sin(a) * 6.5 * 0.9,
        i === 0 || k === 1 ? 'residential' : 'work');
      b.link(hub, node);
    }
  }
  return b.done();
}

function buildRing(c: Point, angle: number, rand: () => number): Plan {
  const b = new PlanBuilder();
  const ring: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = angle + (i / 8) * TAU;
    const r = 13 + (rand() - 0.5) * 2;
    ring.push(b.add(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r * 0.88, i < 4 ? 'residential' : 'street'));
  }
  for (let i = 0; i < 8; i++) b.link(ring[i], ring[(i + 1) % 8]);
  b.roles[ring[5]] = 'core';
  // Droves out to the far pasture.
  for (let i = 1; i < 8; i += 2) {
    const a = angle + (i / 8) * TAU;
    b.chain(ring[i], a, 2, 11, 0.5, rand, 'work');
  }
  return b.done();
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/**
 * Put a road node somewhere a citizen can actually stand.
 *
 * Two conditions, and both are load-bearing. It has to be on the settlement's
 * own landmass, or the junction is one nobody can reach and everything routed
 * through it walks at the water instead. And it has to be outside the margin
 * citizens keep from the water's edge — a node a single unit from the bank is a
 * junction that cannot be occupied, so anyone routed through it walks up to the
 * margin, finds every direction refused, and stops there. That was the largest
 * remaining source of citizens standing still: sixteen of twenty in one
 * woodland, for a hundred and forty game hours at a stretch.
 */
function beach(p: Point, water: WaterField): Point {
  let [x, y] = p;
  if (water.landAt(x, y) !== water.mainland) {
    const home = water.toMainland(x, y);
    const out = home.d > 0 ? home : water.toLand(x, y);
    x = clamp(x + out.x * (out.d + 1.6), 8, 92);
    y = clamp(y + out.y * (out.d + 1.6), 10, 90);
  }
  if (water.blocks(x, y)) {
    const clear = water.toClear(x, y);
    if (clear.d > 0) {
      x = clamp(x + clear.x * (clear.d + 0.6), 8, 92);
      y = clamp(y + clear.y * (clear.d + 0.6), 10, 90);
    }
  }
  return [x, y];
}

/** Whether every node reachable before is still reachable with an edge cut. */
function stillConnected(edges: number[][], cut: [number, number]) {
  const n = edges.length;
  const passable = (a: number, b: number) =>
    !((a === cut[0] && b === cut[1]) || (a === cut[1] && b === cut[0]));
  const seen = new Uint8Array(n);
  const queue = [0];
  seen[0] = 1;
  let reached = 1;
  while (queue.length) {
    const a = queue.pop()!;
    for (const b of edges[a]) {
      if (seen[b] || !passable(a, b)) continue;
      seen[b] = 1;
      reached++;
      queue.push(b);
    }
  }
  // Islands the graph never reached in the first place are not this cut's
  // doing: compare against the same walk with nothing cut.
  const all = new Uint8Array(n);
  const q2 = [0];
  all[0] = 1;
  let total = 1;
  while (q2.length) {
    const a = q2.pop()!;
    for (const b of edges[a]) {
      if (all[b]) continue;
      all[b] = 1;
      total++;
      q2.push(b);
    }
  }
  return reached === total;
}

/**
 * Find the places a road still crosses water after the nodes have been beached,
 * so the terrain generator can lay a deck there. A causeway town is mostly this.
 *
 * Crossings are then thinned: where two are close enough to be the same reach
 * of the same river, the longer one is dropped along with the road it carried,
 * provided the network is still whole without it. A causeway town, whose whole
 * plan is bridges, keeps them all — there the water is the street, and every
 * deck is load-bearing rather than a second way over one stream.
 */
function findBridges(nodes: Point[], edges: number[][], water: WaterField, thin: boolean): Bridge[] {
  const found: { bridge: Bridge; edge: [number, number] }[] = [];
  const seen = new Set<string>();
  edges.forEach((neighbours, a) => neighbours.forEach((bIdx) => {
    const key = a < bIdx ? `${a}-${bIdx}` : `${bIdx}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const [ax, ay] = nodes[a];
    const [bx, by] = nodes[bIdx];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(4, Math.round(len));
    // Every run of wet samples along the edge gets a deck long enough to span
    // it, with a little bank at either end.
    let runStart = -1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      const wet = water.isWater(x, y);
      if (wet && runStart < 0) runStart = s;
      if ((!wet || s === steps) && runStart >= 0) {
        const runEnd = wet ? s : s - 1;
        const mid = ((runStart + runEnd) / 2) / steps;
        const runLength = ((runEnd - runStart + 1) / steps) * len;
        found.push({
          bridge: {
            x: ax + (bx - ax) * mid,
            y: ay + (by - ay) * mid,
            angle: Math.atan2(by - ay, bx - ax),
            span: runLength / 2 + BRIDGE_RAMP,
            deck: runLength / 2 + DECK_OVERHANG,
          },
          edge: [a, bIdx],
        });
        runStart = -1;
      }
    }
  }));

  if (!thin) return found.map((f) => f.bridge);

  // Cheapest crossings first, so the one that survives a cluster is the one
  // over the narrowest water.
  found.sort((p, q) => p.bridge.span - q.bridge.span);
  const kept: Bridge[] = [];
  for (const { bridge, edge } of found) {
    const crowded = kept.some((k) => Math.hypot(k.x - bridge.x, k.y - bridge.y) < MIN_CROSSING_GAP);
    // An edge that crosses water twice contributes two bridges; cutting it for
    // one would strand the other, so only cut an edge nothing else needs.
    const doubled = found.some((o) => o.bridge !== bridge && o.edge[0] === edge[0] && o.edge[1] === edge[1]);
    if (crowded && !doubled && stillConnected(edges, edge)) {
      const from = edges[edge[0]].indexOf(edge[1]);
      if (from >= 0) edges[edge[0]].splice(from, 1);
      const back = edges[edge[1]].indexOf(edge[0]);
      if (back >= 0) edges[edge[1]].splice(back, 1);
      continue;
    }
    kept.push(bridge);
  }
  return kept;
}

/** Shortest distance from a point to any road in the plan. */
function roadClearance(nodes: Point[], edges: number[][], x: number, y: number) {
  let best = Infinity;
  for (let u = 0; u < nodes.length; u++) {
    for (const v of edges[u]) {
      if (v < u) continue;
      const [ax, ay] = nodes[u];
      const [bx, by] = nodes[v];
      const ex = bx - ax, ey = by - ay;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / len2, 0, 1) : 0;
      const d = Math.hypot(x - (ax + ex * t), y - (ay + ey * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Find somewhere a building of this size can actually stand.
 *
 * Sites used to be a fixed offset either side of a road node, which produced
 * plenty of positions that were in the river, on the carriageway, or on top of
 * the last building placed. The relaxation in the simulation was then asked to
 * rescue them, and on a dense plan it could not: measured at eight
 * interpenetrating pairs that no amount of damping would separate, because the
 * configuration handed to it had no solution near where it started.
 *
 * So legality is decided here instead, by searching outward from the anchor
 * until a spot satisfies every constraint at once. Anything that finds nothing
 * is dropped rather than placed badly.
 */
function siteNear(
  anchor: Point,
  radius: number,
  preferred: number,
  nodes: Point[],
  edges: number[][],
  placed: { x: number; y: number; r: number }[],
  water: WaterField,
  /**
   * How much walkable bank to leave between the wall and the water.
   *
   * A building that merely stands on dry land can still sit close enough to a
   * channel to leave a gap narrower than a person, and the gap becomes a trap:
   * the wall pushes a citizen one way, the water refuses them the other, and
   * they wedge there for the day. On a swamp that single pinch accounted for
   * most of the settlement's remaining jitter.
   */
  bankGap = 1.5,
): Point | null {
  for (const reach of [radius + 2.6, radius + 4.2, radius + 6, radius + 8.4, radius + 11.5, radius + 15]) {
    for (let k = 0; k < 12; k++) {
      // Sweep alternately either side of the preferred bearing, so a building
      // ends up as close to its intended side of the street as it can.
      const swing = Math.ceil(k / 2) * (Math.PI / 6) * (k % 2 === 0 ? 1 : -1);
      const a = preferred + swing;
      const x = anchor[0] + Math.cos(a) * reach;
      const y = anchor[1] + Math.sin(a) * reach * 0.9;
      if (x < 8 || x > 92 || y < 10 || y > 90) continue;
      // On the mainland, not on an islet across a channel from the town.
      if (water.landAt(x, y) !== water.mainland) continue;
      if (water.distanceToWater(x, y) < radius + bankGap) continue;
      if (roadClearance(nodes, edges, x, y) < radius + 1.2) continue;
      let clash = false;
      for (const q of placed) {
        if ((q.x - x) ** 2 + (q.y - y) ** 2 < (q.r + radius + 1) ** 2) { clash = true; break; }
      }
      if (clash) continue;
      return [x, y];
    }
  }
  return null;
}

export function createLayout(seed: number, profile: BiomeProfile, water: WaterField): WorldLayout {
  const kind = profile.layout;
  const rand = rng(seed * 2654435761);
  const angle = rand() * TAU;
  const centre = chooseCentre(seed, profile, water, kind);

  let plan: Plan;
  switch (kind) {
    case 'clearing': plan = buildClearing(centre, angle, rand); break;
    case 'terrace': plan = buildTerrace(centre, angle, rand); break;
    case 'causeway': plan = buildCauseway(centre, angle, rand, water); break;
    case 'lane': plan = buildLane(centre, angle, rand); break;
    case 'harbour': plan = buildHarbour(centre, angle, rand, water); break;
    case 'oasis': plan = buildOasis(centre, angle, rand, water); break;
    case 'scatter': plan = buildScatter(centre, angle, rand, water); break;
    case 'ring': plan = buildRing(centre, angle, rand); break;
    default: plan = buildHub(centre, angle, rand); break;
  }

  // Nobody's front door opens onto the river. A causeway keeps its crossings,
  // which is the point of it, but every node is put on dry land first.
  const nodes = plan.nodes.map((p) => beach(p, water));
  const { edges, roles } = plan;

  const coreIndex = roles.indexOf('core') >= 0 ? roles.indexOf('core') : 0;
  const core = nodes[coreIndex];
  const plaza = { x: core[0], y: core[1], r: kind === 'ring' ? 7.5 : kind === 'scatter' ? 4.6 : 5.6 };

  // Everything placed so far, so each new site can be checked against it. The
  // radii match the simulation's footprints: the market hall is the big one.
  const placed: { x: number; y: number; r: number }[] = [];
  const take = (p: Point | null, r: number) => {
    if (!p) return null;
    placed.push({ x: p[0], y: p[1], r });
    return p;
  };

  // Civic buildings ring the square, spread so they do not stack.
  const civic: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const r = i === 0 ? 4.2 : 3.2;
    const bearing = angle + 0.6 + (i / 4) * TAU;
    // A civic building will take any bearing rather than none: the square must
    // have its market. Only if every direction is blocked does it fall back to
    // the intended one and leave the simulation's relaxation to sort it out.
    let spot: Point | null = null;
    for (const gap of [1.5, 0.4]) {
      for (const turn of [0, TAU / 3, -TAU / 3, TAU / 6, -TAU / 6, Math.PI]) {
        spot = take(siteNear(core, r, bearing + turn, nodes, edges, placed, water, gap), r);
        if (spot) break;
      }
      if (spot) break;
    }
    civic.push(spot ?? [
      clamp(core[0] + Math.cos(bearing) * (plaza.r + 4.4), 8, 92),
      clamp(core[1] + Math.sin(bearing) * (plaza.r + 4.4) * 0.9, 10, 90),
    ] as Point);
  }

  const workSites: Point[] = [];
  const housePlots: Point[] = [];
  const bearingAt = (i: number) => {
    const neighbour = edges[i][0];
    if (neighbour === undefined) return angle;
    return Math.atan2(nodes[neighbour][1] - nodes[i][1], nodes[neighbour][0] - nodes[i][0]) + Math.PI / 2;
  };

  // Two sites per node, one either side of the street it stands on.
  for (const pass of ['work', 'residential'] as const) {
    for (let i = 0; i < nodes.length; i++) {
      if (roles[i] !== pass) continue;
      const r = pass === 'work' ? 3.2 : 2.6;
      const bearing = bearingAt(i);
      for (const side of [0, Math.PI]) {
        // Roomy first, then cramped: on a wet map insisting on a wide bank
        // everywhere would leave the settlement with nowhere to build at all.
        const spot = take(siteNear(nodes[i], r, bearing + side, nodes, edges, placed, water, 1.5), r)
          ?? take(siteNear(nodes[i], r, bearing + side, nodes, edges, placed, water, 0.4), r);
        if (spot) (pass === 'work' ? workSites : housePlots).push(spot);
      }
    }
  }

  // A plan that produced too few still has to house everybody and give them
  // somewhere to work, so the street nodes give up their verges.
  for (let i = 0; i < nodes.length && (housePlots.length < 12 || workSites.length < 12); i++) {
    if (roles[i] !== 'street') continue;
    const bearing = bearingAt(i);
    for (const side of [0, Math.PI]) {
      const wantHouse = housePlots.length < 12;
      const r = wantHouse ? 2.6 : 3.2;
      if (!wantHouse && workSites.length >= 12) break;
      const spot = take(siteNear(nodes[i], r, bearing + side, nodes, edges, placed, water, 1.5), r)
        ?? take(siteNear(nodes[i], r, bearing + side, nodes, edges, placed, water, 0.4), r);
      if (spot) (wantHouse ? housePlots : workSites).push(spot);
    }
  }

  // Loitering spots along every segment, so wanderers spread along the streets
  // instead of stacking on the junctions.
  const wanderSpots: Point[] = [...nodes];
  const seen = new Set<string>();
  edges.forEach((neighbours, a) => neighbours.forEach((b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const t of [0.25, 0.5, 0.75]) {
      const p: Point = [
        nodes[a][0] + (nodes[b][0] - nodes[a][0]) * t,
        nodes[a][1] + (nodes[b][1] - nodes[a][1]) * t,
      ];
      if (water.landAt(p[0], p[1]) === water.mainland && !water.blocks(p[0], p[1])) wanderSpots.push(p);
    }
  }));

  return {
    kind,
    nodes,
    edges,
    roles,
    plaza,
    civic: civic as [number, number][],
    workSites: workSites as [number, number][],
    housePlots: housePlots as [number, number][],
    bridges: findBridges(nodes, edges, water, kind !== 'causeway'),
    wanderSpots: wanderSpots as [number, number][],
  };
}

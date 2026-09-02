/**
 * Emerge — simulation core.
 *
 * This module is the brain of the world. It owns logical citizen coordinates,
 * needs, jobs, production, the market and the settlement's daily rhythm. It has
 * no knowledge of how anything is drawn: the renderer reads this state and
 * interpolates toward it.
 *
 * `advance()` mutates a world in place and is what the live client calls every
 * frame. `tick()` is the pure/cloning wrapper kept for tests and any caller that
 * wants immutable snapshots.
 */

import { biomeFor, biomeProfile, type BiomeKind } from './world/biomes';
import { BRIDGE_SPAN, createLayout, type WorldLayout } from './world/layout';
import { buildWater, type WaterField } from './world/water';

export type Terrain = 'fertile' | 'forest' | 'mountain' | 'rocky' | 'coastal' | 'river';
export type Job = 'farmer' | 'woodcutter' | 'miner' | 'quarry' | 'miller' | 'baker' | 'carpenter' | 'blacksmith' | 'tailor' | 'unemployed';
export type WorkingJob = Exclude<Job, 'unemployed'>;
export type Activity = 'walking' | 'working' | 'resting' | 'trading' | 'eating' | 'idle';
export type Phase = 'sleeping' | 'athome' | 'working' | 'eating' | 'socialising' | 'wandering';
export type Facing = 'n' | 's' | 'e' | 'w';
export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';
export type Weather = 'Clear' | 'Cloudy' | 'Rain' | 'Storm' | 'Fog' | 'Snow';
export type Resource = 'wheat' | 'vegetables' | 'wood' | 'stone' | 'ironOre' | 'wool' | 'flour' | 'bread' | 'furniture' | 'tools' | 'clothing';

/** Feed entries are typed so the UI can icon/colour them without parsing text. */
export type FeedKind = 'world' | 'build' | 'social' | 'discovery' | 'project' | 'market' | 'weather' | 'work';
export interface FeedEntry { id: string; kind: FeedKind; text: string; day: number; hour: number }

export type GatheringKind = 'meetup' | 'showcase' | 'market' | 'feast';
export interface Gathering {
  id: string; name: string; kind: GatheringKind;
  day: number; hour: number; duration: number;
  buildingId: string; attendees: string[];
}

export interface Bond { a: string; b: string; strength: number; friends: boolean }
export interface Project { id: string; ownerId: string; name: string; buildingId: string; progress: number; length: number }

export interface Citizen {
  id: string; name: string; handle: string; familyId: string; age: number; job: Job; hash: number;
  hunger: number; rest: number; social: number; clothing: number; purpose: number;
  happiness: number; wage: number; wallet: number;
  x: number; y: number;
  destX: number; destY: number; destId?: string;
  path: number[]; dwell: number; wanderIdx: number; errand: boolean;
  phase: Phase; activity: Activity; facing: Facing; moving: boolean;
  targetBuildingId?: string; inside: boolean;
  /** Game hours spent making no progress toward the destination. */
  stalled: number;
  /**
   * Closest they have got to the current destination.
   *
   * Progress is judged against this rather than against the previous frame. A
   * citizen shuffling back and forth by a fifth of a unit gets closer on every
   * other frame, which reset a frame-to-frame detector forever and let them
   * oscillate at the water's edge for the rest of the day.
   */
  bestAway: number;
  /** True when they have no bed and are sleeping out in the open. */
  roughSleeper: boolean;
  /** Cosmetic seed the renderer turns into a stable appearance. Never read by logic. */
  look: number;
}
export interface Family { id: string; name: string; members: string[]; homeId: string; wealth: number }
export interface Building { id: string; type: string; x: number; y: number; workers: string[]; active: boolean; production?: string }
export interface MarketQuote {
  price: number; supply: number; demand: number; volume: number; trend: number;
  /** Recent prices, oldest first, sampled once per game day. */
  history: number[];
}

export interface World {
  id: string; name: string; seed: number; biome: BiomeKind; day: number; hour: number; terrain: Terrain[];
  /**
   * The settlement plan for this world: its roads, its square, and where its
   * buildings stand. Generated from the seed and the biome, so a fen and a
   * desert are laid out as different places rather than the same village.
   */
  layout: WorldLayout;
  season: Season; weather: Weather; weatherSeed: number; treasury: number; population: number;
  families: Family[]; citizens: Citizen[]; buildings: Building[];
  resources: Record<Resource, number>; market: Record<Resource, MarketQuote>;
  feed: FeedEntry[]; gatherings: Gathering[]; bonds: Record<string, Bond>; projects: Project[];
  unlockedAreas: string[];
  /** Accumulates game hours so the market trades on the clock, not per frame. */
  marketClock: number;
  /**
   * What actually moved yesterday, per resource. The renderer fells exactly as
   * many trees as the woodcutters really cut, and the market panel shows real
   * throughput rather than a guess from stock levels.
   */
  flow: { produced: Partial<Record<Resource, number>>; consumed: Partial<Record<Resource, number>> };
  counter: number;
}

export const RESOURCE_LABELS: Record<Resource, string> = { wheat: 'Wheat', vegetables: 'Vegetables', wood: 'Wood', stone: 'Stone', ironOre: 'Iron Ore', wool: 'Wool', flour: 'Flour', bread: 'Bread', furniture: 'Furniture', tools: 'Tools', clothing: 'Clothing' };
export const JOB_LABELS: Record<Job, string> = { farmer: 'Farmer', woodcutter: 'Woodcutter', miner: 'Miner', quarry: 'Quarry worker', miller: 'Miller', baker: 'Baker', carpenter: 'Carpenter', blacksmith: 'Blacksmith', tailor: 'Tailor', unemployed: 'Unemployed' };
export const ACTIVITY_LABELS: Record<Activity, string> = { walking: 'Walking', working: 'Working', resting: 'At home', trading: 'Socialising', eating: 'Eating', idle: 'Idle' };
export const PHASE_LABELS: Record<Phase, string> = { sleeping: 'Asleep', athome: 'At home', working: 'At work', eating: 'Getting food', socialising: 'Socialising', wandering: 'Wandering' };

export const JOBS: Record<WorkingJob, { wage: number; output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>>; building: string }> = {
  farmer: { wage: 10, output: { wheat: 10, vegetables: 5 }, building: 'Farm' },
  woodcutter: { wage: 11, output: { wood: 12.5 }, building: 'Woodcutter' },
  miner: { wage: 14, output: { ironOre: 3.33 }, building: 'Mine' },
  quarry: { wage: 12, output: { stone: 9 }, building: 'Quarry' },
  miller: { wage: 13, output: { flour: 10 }, input: { wheat: 10 }, building: 'Mill' },
  baker: { wage: 15, output: { bread: 10 }, input: { flour: 10, wood: 2.5 }, building: 'Bakery' },
  carpenter: { wage: 15, output: { furniture: 5 }, input: { wood: 10 }, building: 'Carpenter' },
  blacksmith: { wage: 18, output: { tools: 4 }, input: { ironOre: 8, wood: 4 }, building: 'Blacksmith' },
  tailor: { wage: 16, output: { clothing: 4 }, input: { wool: 4 }, building: 'Tailor' },
};
const jobs = JOBS;

const names = ['Nova', 'Kai', 'Mira', 'Atlas', 'Luna', 'Theo', 'Iris', 'Miles', 'Lena', 'Jonah', 'Ruby', 'Owen', 'Nora', 'Eli', 'Clara', 'Finn', 'Milo', 'June', 'Ada', 'Leo', 'Mae', 'Sol', 'Wren', 'Rune', 'Rose', 'Jack', 'Lily', 'Ben', 'Anna', 'Vale'];
const familyNames = ['Carter', 'Mason', 'Hayes', 'Bennett', 'Reed', 'Morgan', 'Brooks', 'Parker'];
const marketPrices: Record<Resource, number> = { wheat: 2, vegetables: 2.5, wood: 3, stone: 4, ironOre: 7, wool: 6, flour: 5, bread: 7, furniture: 14, tools: 20, clothing: 18 };
const marketBuffers: Record<Resource, number> = { wheat: 60, vegetables: 40, wood: 70, stone: 30, ironOre: 20, wool: 15, flour: 25, bread: 40, furniture: 10, tools: 8, clothing: 15 };
const terrainBonuses: Record<Terrain, Partial<Record<WorkingJob, number>>> = { fertile: { farmer: 1.3 }, forest: { woodcutter: 1.3 }, mountain: { miner: 1.3 }, rocky: { quarry: 1.25 }, coastal: {}, river: { farmer: 1.15 } };

/**
 * The water for a world.
 *
 * Held here rather than on the world object because it carries lookup closures
 * and `tick()` structured-clones worlds for its callers. Keyed by seed, which
 * is what the water is a function of, and capped so a session that visits many
 * plots does not accumulate fields for all of them.
 */
const waterCache = new Map<number, WaterField>();
export function waterOf(world: { seed: number; biome: BiomeKind }): WaterField {
  const cached = waterCache.get(world.seed);
  if (cached) return cached;
  const field = buildWater(world.seed, biomeProfile(world.biome));
  if (waterCache.size >= 12) waterCache.delete(waterCache.keys().next().value as number);
  waterCache.set(world.seed, field);
  return field;
}

export function mulberry32(seed: number) {
  return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function pushFeed(world: World, kind: FeedKind, text: string) {
  world.feed.unshift({ id: `e${world.counter++}`, kind, text, day: world.day, hour: world.hour });
  if (world.feed.length > 40) world.feed.length = 40;
}

// Deterministic golden-angle scatter so citizens sharing a destination stand in a
// ring around it instead of on the same pixel. Y is squashed to read as ground plane.
function standingOffset(hash: number, spread = 2.4): [number, number] {
  const angle = hash * 2.399963229728653;
  const r = spread + (hash % 4) * 0.75;
  return [Math.cos(angle) * r, Math.sin(angle) * r * 0.6];
}

/**
 * One citizen's day.
 *
 * The offsets are drawn from the whole hash rather than from `hash % 3`, and
 * that is the entire point of this function. Three or four distinct wake times
 * across a whole settlement meant everybody stepped out of their door in the
 * same minute: measured at peak, all twenty-eight citizens were on the street
 * at once, which is why a village of twenty-eight read as a crowd of far more.
 * Spreading departures over a couple of hours costs nothing and makes the
 * streets fill and empty the way a real one does.
 */
function scheduleFor(hash: number) {
  // Three independent fractions from the hash, so wake time does not determine
  // lunch time and the day does not move as a block.
  const a = ((hash * 2654435761) >>> 0) / 4294967296;
  const b = ((hash * 40503 + 12345) >>> 0) / 4294967296;
  const c = ((hash * 1103515245 + 98765) >>> 0) / 4294967296;
  const wake = 5.4 + a * 2.6;
  return {
    wake,
    workStart: wake + 1.3 + b * 1.4,
    lunch: 11.6 + c * 1.6,
    lunchEnd: 12.6 + c * 1.6 + b * 0.5,
    workEnd: 16.2 + a * 2.4,
    homeTime: 20.2 + b * 2.6,
  };
}

function phaseFor(c: Citizen, hour: number): Phase {
  const s = scheduleFor(c.hash);
  const nightOwl = c.hash % 7 === 0;
  if (c.age < 16) {
    if (hour < s.wake || hour >= s.homeTime - 1.5) return 'sleeping';
    return 'wandering';
  }
  if (hour < s.wake || hour >= s.homeTime + 1) return nightOwl ? 'wandering' : 'sleeping';
  if (hour < s.workStart) return 'athome';
  if (hour < s.lunch) return 'working';
  if (hour < s.lunchEnd) return 'eating';
  if (hour < s.workEnd) return 'working';
  if (hour < s.homeTime) return 'socialising';
  return 'athome';
}

function activityFor(phase: Phase): Activity {
  return phase === 'working' ? 'working' : phase === 'eating' ? 'eating' : phase === 'socialising' ? 'trading' : phase === 'wandering' ? 'idle' : 'resting';
}

// Routing runs on the world's own plan, not on a shared one. Every helper here
// takes the layout rather than reading a module constant, because two worlds
// open at once — the one being played and the one being previewed in the land
// office — have different roads.
function nearestRoad(layout: WorldLayout, x: number, y: number) {
  const nodes = layout.nodes;
  let best = 0, dist = Infinity;
  for (let i = 0; i < nodes.length; i++) { const n = nodes[i], d = (n[0] - x) ** 2 + (n[1] - y) ** 2; if (d < dist) { dist = d; best = i; } }
  return best;
}

/** Whether a straight walk between two points stays out of the water. */
function dryLine(water: WaterField, layout: WorldLayout, ax: number, ay: number, bx: number, by: number) {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(len));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    if (water.isWater(x, y) && !onBridge(layout, x, y)) return false;
  }
  return true;
}

/**
 * The road node to join or leave the network at.
 *
 * Nearest is not good enough when there is water about: the nearest junction to
 * a house on the far bank is often across the channel from it, and a citizen
 * routed through it walks straight at the river. This prefers the closest node
 * whose last leg is walkable, and only falls back to plain nearest when no node
 * qualifies — at which point the stall detector will find them something else
 * to do rather than leave them swimming.
 */
function joinRoad(layout: WorldLayout, water: WaterField, x: number, y: number) {
  const nodes = layout.nodes;
  const order = nodes
    .map((n, i) => ({ i, d: (n[0] - x) ** 2 + (n[1] - y) ** 2 }))
    .sort((a, b) => a.d - b.d);
  for (const { i } of order) {
    if (dryLine(water, layout, x, y, nodes[i][0], nodes[i][1])) return i;
  }
  return order[0].i;
}
function roadDistance(layout: WorldLayout, a: number, b: number) {
  const n = layout.nodes;
  return Math.hypot(n[a][0] - n[b][0], n[a][1] - n[b][1]);
}
function roadPath(layout: WorldLayout, start: number, end: number): number[] {
  if (start === end) return [start];
  const open = [start], came = new Map<number, number>(), g = new Map([[start, 0]]), f = new Map([[start, roadDistance(layout, start, end)]]);
  while (open.length) {
    open.sort((a, b) => (f.get(a) ?? Infinity) - (f.get(b) ?? Infinity));
    const current = open.shift()!;
    if (current === end) { const path = [current]; let cursor = current; while (came.has(cursor)) { cursor = came.get(cursor)!; path.unshift(cursor); } return path; }
    for (const next of layout.edges[current]) {
      const score = (g.get(current) ?? Infinity) + roadDistance(layout, current, next);
      if (score < (g.get(next) ?? Infinity)) { came.set(next, current); g.set(next, score); f.set(next, score + roadDistance(layout, next, end)); if (!open.includes(next)) open.push(next); }
    }
  }
  return [start, end];
}

function findBuilding(world: World, type: string) { return world.buildings.find((b) => b.type === type); }
function homeOf(world: World, c: Citizen) {
  const family = world.families.find((f) => f.id === c.familyId);
  return family ? world.buildings.find((b) => b.id === family.homeId) : undefined;
}
function jobBuilding(world: World, c: Citizen) { return c.job === 'unemployed' ? undefined : findBuilding(world, jobs[c.job].building); }

/** The gathering currently running, if any. Socialising citizens are drawn to it. */
export function activeGathering(world: World): Gathering | undefined {
  return world.gatherings.find((g) => g.day === world.day && world.hour >= g.hour && world.hour < g.hour + g.duration);
}

// Destinations are committed and persist until the citizen actually arrives, rather
// than being recomputed every tick (which would make everyone reverse direction mid-walk).
function assignDestination(world: World, c: Citizen, phase: Phase) {
  c.phase = phase;
  let target: { x: number; y: number; id?: string } | undefined;
  let spread = 2.4;

  if (phase === 'sleeping' || phase === 'athome') {
    // A bed if they have one, a bench at the tavern if not, and the square if
    // there is neither. Nobody simply stops existing at night.
    const home = homeOf(world, c);
    if (home) {
      target = home;
      spread = 2.0;
      c.roughSleeper = false;
    } else {
      const shelter = findBuilding(world, 'Tavern') ?? findBuilding(world, 'Market');
      target = shelter;
      spread = 4.0;
      c.roughSleeper = !shelter || phase === 'sleeping';
    }
  } else if (phase === 'working') {
    // Mostly at the workbench, with an occasional delivery run so work is a
    // visible loop rather than a statue. It used to alternate every trip, which
    // meant a worker was on the road for half the working day — with the whole
    // settlement doing it at once, the streets never emptied and eighteen
    // people read as a crowd of far more.
    const workplace = jobBuilding(world, c);
    const depot = findBuilding(world, 'Storage') ?? findBuilding(world, 'Market');
    const runErrand = (c.wanderIdx + c.hash) % 3 === 0;
    target = runErrand ? depot ?? workplace : workplace ?? depot;
    c.errand = runErrand;
    c.wanderIdx = (c.wanderIdx + 1) % Math.max(1, world.layout.wanderSpots.length);
  } else if (phase === 'eating') {
    target = findBuilding(world, 'Market') ?? findBuilding(world, 'Bakery');
  } else if (phase === 'socialising') {
    const gathering = activeGathering(world);
    const venue = gathering && world.buildings.find((b) => b.id === gathering.buildingId);
    if (venue) {
      if (gathering && !gathering.attendees.includes(c.id)) gathering.attendees.push(c.id);
      target = venue;
      spread = 4.0;
    } else {
      const options = [findBuilding(world, 'Tavern'), findBuilding(world, 'Market'), undefined];
      target = options[c.wanderIdx % options.length];
      spread = 3.0;
    }
  }

  if (!target) {
    const spots = world.layout.wanderSpots;
    c.wanderIdx = (c.wanderIdx * 7 + c.hash + 3) % spots.length;
    const spot = spots[c.wanderIdx];
    target = { x: spot[0], y: spot[1] };
    spread = 1.2;
  }

  const [ox, oy] = standingOffset(c.hash + c.wanderIdx, spread);
  c.destX = clamp(target.x + ox, 3, 97);
  c.destY = clamp(target.y + oy, 5, 95);
  c.destId = target.id;
  // Never send anyone to a spot inside someone else's wall. Left uncorrected,
  // they walk to it, get pushed off it, walk back, and spend the afternoon
  // vibrating against a neighbour's house.
  for (const b of world.buildings) {
    if (b.id === c.destId) continue;
    const r = footprintRadius(b) + 0.6;
    const dx = c.destX - b.x, dy = c.destY - b.y;
    const d = Math.hypot(dx, dy);
    if (d >= r) continue;
    if (d < 0.0001) { c.destX = clamp(b.x + r, 3, 97); continue; }
    c.destX = clamp(b.x + (dx / d) * r, 3, 97);
    c.destY = clamp(b.y + (dy / d) * r, 5, 95);
  }
  // And not in the river. `standingOffset` scatters people in a ring around
  // their target, and on a fen or a coast that ring reaches the water; without
  // this they walk to a spot they cannot stand on, get pushed out, and walk
  // back to it — the same loop that footprints used to cause.
  const water = waterOf(world);
  if (water.isWater(c.destX, c.destY)) {
    const out = water.toLand(c.destX, c.destY);
    c.destX = clamp(c.destX + out.x * (out.d + 1.2), 3, 97);
    c.destY = clamp(c.destY + out.y * (out.d + 1.2), 5, 95);
  }
  const full = roadPath(
    world.layout,
    joinRoad(world.layout, water, c.x, c.y),
    joinRoad(world.layout, water, c.destX, c.destY),
  );
  // Pull the string tight at the near end: skip leading junctions the citizen
  // can already walk past. This used to drop the first node unconditionally,
  // which is where the swimming came from — the line to the *second* node was
  // never checked for water, so somebody standing on a bank was routed straight
  // across the channel and spent the day shuffling against it.
  let from = 0;
  while (from + 1 < full.length) {
    const here = world.layout.nodes[full[from]];
    const next = world.layout.nodes[full[from + 1]];
    if (!dryLine(water, world.layout, c.x, c.y, next[0], next[1])) break;
    const detour = Math.hypot(here[0] - c.x, here[1] - c.y) + Math.hypot(next[0] - here[0], next[1] - here[1]);
    if (Math.hypot(next[0] - c.x, next[1] - c.y) > detour - 0.5) break;
    from++;
  }
  c.path = full.slice(from);
  c.bestAway = Infinity;
  // How long they stay put once they get there. Long enough at work that the
  // working day is spent working, and staggered across the population so the
  // settlement does not turn over all at once.
  c.dwell = phase === 'working' ? 2.6 + (c.hash % 5) * 0.62
    : phase === 'socialising' ? 1.3 + (c.hash % 4) * 0.55
      : 0.9 + (c.hash % 5) * 0.45;
  if (phase === 'socialising' || phase === 'wandering') c.wanderIdx = (c.wanderIdx + 1) % world.layout.wanderSpots.length;
}

function hasArrived(c: Citizen) { return c.path.length === 0 && Math.hypot(c.destX - c.x, c.destY - c.y) < 0.35; }

export interface Obstacle { x: number; y: number; r: number; id: string }

/** Kept a little tighter than the drawn building so people hug the walls. */
function footprintRadius(b: Building) {
  return b.type === 'Market' || b.type === 'Town Hall' ? 4.2 : b.type === 'House' ? 2.6 : 3.2;
}

function buildObstacles(world: World): Obstacle[] {
  return world.buildings.map((b) => ({ x: b.x, y: b.y, r: footprintRadius(b), id: b.id }));
}

/**
 * Keep citizens out of buildings.
 *
 * This resolves overlap after a step rather than steering to predict one.
 * Predictive steering proved unstable: the push away from a wall and the pull
 * toward the destination formed a limit cycle, so citizens vibrated in place
 * instead of arriving — measured at a direction reversal on four frames in
 * five, and only 7% of their time spent standing still. Pushing out of a
 * footprint preserves movement along the wall, so people slide around a
 * building and still reach the far side.
 *
 * Obstacles at or near the target are ignored: doorsteps and road junctions sit
 * inside footprints by design, and someone pushed off the very spot they are
 * walking to would never get there.
 */
function resolveOverlap(c: Citizen, obstacles: Obstacle[], tx: number, ty: number, water: WaterField, onBridge: boolean) {
  // A fixed side per citizen, so nobody dithers left and right along a wall.
  const side = c.hash % 2 === 0 ? 1 : -1;
  let pushX = 0, pushY = 0, hits = 0;

  for (const o of obstacles) {
    if (o.id === c.destId) continue;
    const toTargetX = o.x - tx, toTargetY = o.y - ty;
    // Only skip a footprint that genuinely contains the target. Road junctions
    // are kept clear of buildings by `enforceSpacing`, and destinations are
    // nudged out of other people's walls when they are assigned, so a wide
    // exemption here just lets citizens cut through.
    if (toTargetX * toTargetX + toTargetY * toTargetY < o.r * o.r) continue;

    const dx = c.x - o.x, dy = c.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d >= o.r) continue;
    hits++;
    if (d < 0.0001) { pushX += o.r; continue; }
    const nx = dx / d, ny = dy / d;
    const depth = o.r - d;
    pushX += nx * depth - ny * side * 0.2;
    pushY += ny * depth + nx * side * 0.2;
  }

  if (hits) {
    // One combined correction. Resolving each footprint in turn let a citizen
    // caught between two of them be pushed out of one straight into the other,
    // every frame, forever.
    const len = Math.hypot(pushX, pushY);
    const limit = 0.4;
    const k = len > limit ? limit / len : 1;
    c.x = clamp(c.x + pushX * k, 2, 98);
    c.y = clamp(c.y + pushY * k, 4, 96);
  }

  // And out of the river.
  //
  // The step is uncapped on purpose — being briefly inside a wall looks like a
  // near miss, a single frame standing on open water does not — but a straight
  // shove toward the nearest bank drives people into whatever is built on it,
  // which on a fen is most of the town: measured at fourteen per cent of frames
  // spent inside somebody's wall. So the escape is a short search for a spot
  // that is both dry and clear, and only settles for merely dry.
  if (!onBridge && water.isWater(c.x, c.y)) {
    const out = water.toLand(c.x, c.y);
    const reach = out.d + 0.8;
    let bestX = clamp(c.x + out.x * reach, 2, 98);
    let bestY = clamp(c.y + out.y * reach, 4, 96);
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const nx = out.x * cos - out.y * sin;
      const ny = out.x * sin + out.y * cos;
      const x = clamp(c.x + nx * reach, 2, 98);
      const y = clamp(c.y + ny * reach, 4, 96);
      if (water.isWater(x, y)) continue;
      if (turn === 0) { bestX = x; bestY = y; }
      const clear = obstacles.every((o) => o.id === c.destId || (o.x - x) ** 2 + (o.y - y) ** 2 >= o.r * o.r);
      if (clear) { bestX = x; bestY = y; break; }
    }
    c.x = bestX;
    c.y = bestY;
  }
}

/**
 * Whether a position is on one of the world's bridges.
 *
 * A causeway settlement is roads over water by design, so the water push has to
 * know where the decks are or its own citizens would be shoved off them.
 */
function onBridge(layout: WorldLayout, x: number, y: number) {
  for (const b of layout.bridges) {
    if ((b.x - x) ** 2 + (b.y - y) ** 2 < BRIDGE_SPAN * BRIDGE_SPAN) return true;
  }
  return false;
}

function stepCitizen(c: Citizen, hours: number, obstacles: Obstacle[], layout: WorldLayout, water: WaterField) {
  let budget = (c.age < 16 ? 9 : 12.5) * hours;
  const startX = c.x, startY = c.y;
  c.moving = false;
  let guard = 0;
  let lastTargetX = c.destX, lastTargetY = c.destY;

  while (budget > 0 && guard++ < 24) {
    const final = c.path.length === 0;
    const tx = final ? c.destX : layout.nodes[c.path[0]][0];
    const ty = final ? c.destY : layout.nodes[c.path[0]][1];
    lastTargetX = tx; lastTargetY = ty;
    const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
    if (d < 0.0001) { if (final) break; c.path.shift(); continue; }

    const step = Math.min(d, budget);
    let nx = clamp(c.x + (dx / d) * step, 2, 98);
    let ny = clamp(c.y + (dy / d) * step, 4, 96);

    // Do not step into the water in the first place.
    //
    // Undoing the step afterwards looked equivalent and was not: walking in,
    // being shoved out and walking in again is a limit cycle, and it showed up
    // as a direction reversal on one frame in six across the fen and the swamp
    // — the same signature as the vibration that predictive steering used to
    // cause. Refusing the step and sliding along the bank instead is stable,
    // and it makes people walk around an inlet the way they walk around a wall.
    if (water.isWater(nx, ny) && !onBridge(layout, nx, ny)) {
      const out = water.toLand(nx, ny);
      // Slide along the bank: the tangent to the escape direction, taking
      // whichever way points closer to where they are going.
      // The side is fixed per citizen rather than chosen by which tangent
      // points nearer the target. Choosing per frame flips as the geometry
      // changes and the citizen shuffles left and right against the bank —
      // measured at a reversal on one frame in five, worse than not sliding at
      // all. This is the same fix the wall push needed.
      const first = c.hash % 2 === 0 ? 0 : 1;
      const tangents: [number, number][] = [[-out.y, out.x], [out.y, -out.x]];
      let slid = false;
      for (const t of [tangents[first], tangents[1 - first]]) {
        const sx = clamp(c.x + t[0] * step, 2, 98);
        const sy = clamp(c.y + t[1] * step, 4, 96);
        if (water.isWater(sx, sy)) continue;
        nx = sx; ny = sy; slid = true;
        break;
      }
      if (!slid) break;
      c.x = nx; c.y = ny;
      c.moving = true;
      budget -= step;
      continue;
    }

    c.x = nx;
    c.y = ny;
    c.moving = true;
    budget -= step;
    if (step >= d && !final) c.path.shift(); else if (step >= d) break;
  }

  resolveOverlap(c, obstacles, lastTargetX, lastTargetY, water, onBridge(layout, c.x, c.y));

  // Facing comes from the whole frame's movement, not from each sub-step, and
  // only when the frame actually took someone somewhere.
  const netX = c.x - startX, netY = c.y - startY;
  if (Math.hypot(netX, netY) > 0.02) {
    if (Math.abs(netX) > Math.abs(netY)) c.facing = netX > 0 ? 'e' : 'w';
    else c.facing = netY > 0 ? 's' : 'n';
  }
}

function moveCitizens(world: World, hours: number) {
  const obstacles = buildObstacles(world);
  const water = waterOf(world);
  for (const c of world.citizens) {
    if (c.age < 16) c.job = 'unemployed';
    let phase = phaseFor(c, world.hour);
    if (c.hunger < 35 && phase !== 'sleeping') phase = 'eating';

    if (phase !== c.phase) {
      assignDestination(world, c, phase);
    } else if (hasArrived(c)) {
      // Only re-roll a destination after dwelling, never mid-journey.
      if (phase === 'wandering' || phase === 'socialising' || phase === 'working') {
        c.dwell -= hours;
        if (c.dwell <= 0) assignDestination(world, c, phase);
      }
    }

    stepCitizen(c, hours, obstacles, world.layout, water);

    // Safety net: squeezing past a crowded corner or an inlet can leave someone
    // shuffling on the spot. Progress is judged against the closest they have
    // ever got to this destination, so trading a fifth of a unit back and forth
    // no longer counts as getting somewhere; if they genuinely cannot make
    // headway, they pick somewhere else to be rather than stand there all day.
    const nowAway = Math.hypot(c.destX - c.x, c.destY - c.y);
    if (hasArrived(c)) {
      c.stalled = 0;
      c.bestAway = 0;
    } else if (nowAway < c.bestAway - 0.25) {
      c.bestAway = nowAway;
      c.stalled = 0;
    } else {
      c.stalled += hours;
      if (c.stalled > 0.75) { c.stalled = 0; assignDestination(world, c, phase); }
    }

    const arrived = hasArrived(c);
    c.activity = arrived ? activityFor(phase) : 'walking';
    // Someone with nowhere to go stays out in the open where you can see them.
    c.inside = arrived && !!c.destId && phase !== 'wandering' && !(c.roughSleeper && phase === 'sleeping');
    c.targetBuildingId = c.destId;
  }
}

function updateBuildingWorkers(world: World) {
  for (const b of world.buildings) { b.workers = []; b.production = undefined; }
  for (const c of world.citizens) {
    if (!c.targetBuildingId || !c.inside) continue;
    const b = world.buildings.find((x) => x.id === c.targetBuildingId);
    if (!b) continue;
    if (c.activity === 'working' || c.activity === 'trading' || c.activity === 'resting' || c.activity === 'eating') {
      if (b.workers.length < 8) b.workers.push(c.id);
      if (c.activity === 'working') b.production = c.job;
    }
  }
}

const bondKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Friendships form from actual co-presence: two adults socialising in the same
 * venue build a bond, and crossing the threshold is a real, reportable event.
 */
function socialStep(world: World, hours: number) {
  const mingling = world.citizens.filter((c) => c.activity === 'trading' || c.activity === 'eating');
  for (let i = 0; i < mingling.length; i++) {
    for (let j = i + 1; j < mingling.length; j++) {
      const a = mingling[i], b = mingling[j];
      // Co-presence means standing together, not merely sharing a roof. Everyone
      // in the settlement passes through the tavern; only neighbours in the
      // crowd actually get to know each other.
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4.5) continue;
      const key = bondKey(a.id, b.id);
      const bond = world.bonds[key] ?? (world.bonds[key] = { a: a.id, b: b.id, strength: 0, friends: false });
      bond.strength = Math.min(100, bond.strength + hours * 3.2);
      a.social = Math.min(100, a.social + hours * 3);
      b.social = Math.min(100, b.social + hours * 3);
      if (!bond.friends && bond.strength >= 78) {
        bond.friends = true;
        pushFeed(world, 'social', `${a.name} and ${b.name} are now good friends.`);
      }
    }
  }
}

/**
 * Bonds fade a little each day. Without this, thirty citizens sharing one tavern
 * eventually befriend everyone, and "X and Y are now good friends" stops meaning
 * anything.
 */
function decayBonds(world: World) {
  for (const [key, bond] of Object.entries(world.bonds)) {
    bond.strength -= bond.friends ? 1.2 : 3.5;
    if (bond.friends && bond.strength < 45) bond.friends = false;
    if (bond.strength <= 0) delete world.bonds[key];
  }
}

/** Friends of a citizen, most-bonded first. Used by the inspector panel. */
export function friendsOf(world: World, id: string): { citizen: Citizen; strength: number }[] {
  const out: { citizen: Citizen; strength: number }[] = [];
  for (const bond of Object.values(world.bonds)) {
    if (!bond.friends) continue;
    const otherId = bond.a === id ? bond.b : bond.b === id ? bond.a : undefined;
    if (!otherId) continue;
    const citizen = world.citizens.find((c) => c.id === otherId);
    if (citizen) out.push({ citizen, strength: bond.strength });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

function createMarket(): Record<Resource, MarketQuote> {
  return Object.fromEntries((Object.keys(marketPrices) as Resource[]).map((r) => [r, { price: marketPrices[r], supply: 0, demand: 0, volume: 0, trend: 0, history: [marketPrices[r]] }])) as Record<Resource, MarketQuote>;
}
function seasonForDay(day: number): Season { const n = (day - 1) % 120; return n < 30 ? 'Spring' : n < 60 ? 'Summer' : n < 90 ? 'Autumn' : 'Winter'; }
function weatherFor(season: Season, seed: number, day: number): Weather {
  const r = mulberry32(seed + day * 71)();
  if (season === 'Winter') return r < .42 ? 'Snow' : r < .64 ? 'Cloudy' : r < .73 ? 'Fog' : 'Clear';
  if (season === 'Spring') return r < .25 ? 'Rain' : r < .42 ? 'Cloudy' : r < .48 ? 'Fog' : 'Clear';
  if (season === 'Autumn') return r < .2 ? 'Rain' : r < .42 ? 'Cloudy' : r < .5 ? 'Fog' : 'Clear';
  return r < .15 ? 'Storm' : r < .3 ? 'Rain' : r < .5 ? 'Cloudy' : 'Clear';
}
function chooseJobFromSeed(terrain: Terrain[], n: number): WorkingJob {
  const a: WorkingJob[] = ['farmer', 'woodcutter', 'miner', 'quarry', 'miller', 'baker', 'carpenter', 'blacksmith', 'tailor'];
  return a[Math.abs(n + terrain.reduce((s, t) => s + t.length, 0)) % a.length];
}

const WORLD_NAMES = ['Emerge', 'Greenhollow', 'Fernrest', 'Alderwatch', 'Mosswater', 'Thornebrook', 'Sunmere', 'Elderford'];

/** A name for a world the player did not name themselves. */
export function defaultWorldName(seed: number) {
  return WORLD_NAMES[Math.abs(seed) % WORLD_NAMES.length];
}

/** Rename one citizen. Their handle follows the new name. */
export function renameCitizen(world: World, id: string, name: string) {
  const trimmed = name.trim().slice(0, 18);
  const citizen = world.citizens.find((c) => c.id === id);
  if (!citizen || !trimmed || trimmed === citizen.name) return false;
  const was = citizen.name;
  citizen.name = trimmed;
  citizen.handle = `@${trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')}${(citizen.hash % 90) + 10}`;
  pushFeed(world, 'social', `${was} goes by ${trimmed} now.`);
  return true;
}

/** Rename a world in place. Citizens refer to it by name when they speak. */
export function renameWorld(world: World, name: string) {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return;
  world.name = trimmed;
  pushFeed(world, 'world', `This place is called ${trimmed} now.`);
}

/**
 * The starter settlement.
 *
 * The civic core is the same everywhere; the trades are whatever the land
 * supports, so a highland plot opens with mines and a forge while a fen opens
 * with fields and a mill. Plots differ in what you can do on them, not just in
 * how they look.
 */
function starterBuildings(seed: number, layout: WorldLayout): Building[] {
  const make = (id: string, type: string, x: number, y: number): Building => ({ id, type, x, y, workers: [], active: true });
  const civic = layout.civic;
  const buildings = [
    make('market', 'Market', civic[0][0], civic[0][1]),
    make('bank', 'Bank', civic[1][0], civic[1][1]),
    make('storage', 'Storage', civic[2][0], civic[2][1]),
    make('tavern', 'Tavern', civic[3][0], civic[3][1]),
  ];

  // Trades go on the sites the plan set aside for them — the outer ends of the
  // arms, the far side of the ring, the head of the causeway — so the shape of
  // the settlement decides where its work happens.
  const sites = layout.workSites;
  const trades = biomeFor(seed).trades;
  trades.forEach((type, i) => {
    const [x, y] = sites[i % sites.length];
    buildings.push(make(`w${i}`, type, x, y));
  });
  return buildings;
}

/**
 * Settle the buildings into legal positions.
 *
 * Three constraints have to hold at once: no two footprints may overlap, none
 * may sit on a road, and none may stand in water. An earlier version applied
 * them in sequence within each pass, so whichever ran last simply overwrote the
 * others and the loop never converged — measured at four interpenetrating pairs
 * and thirteen buildings standing in the street on a single plot, which is
 * exactly the condition that leaves a corridor with no room to walk in and sets
 * citizens vibrating between two walls.
 *
 * This accumulates every correction for a pass and applies the sum, damped.
 * That is an ordinary relaxation and it actually converges; the loop exits on
 * the residual rather than on a pass count.
 */
function enforceSpacing(buildings: Building[], layout: WorldLayout, water: WaterField) {
  const n = buildings.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let pass = 0; pass < 240; pass++) {
    dx.fill(0);
    dy.fill(0);
    let residual = 0;

    // Footprints must not overlap.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = buildings[i], b = buildings[j];
        const need = footprintRadius(a) + footprintRadius(b) + 0.8;
        let ex = b.x - a.x, ey = b.y - a.y;
        let d = Math.hypot(ex, ey);
        if (d >= need) continue;
        if (d < 0.0001) { ex = 1; ey = 0; d = 1; }
        const push = (need - d) / 2;
        residual = Math.max(residual, need - d);
        dx[i] -= (ex / d) * push; dy[i] -= (ey / d) * push;
        dx[j] += (ex / d) * push; dy[j] += (ey / d) * push;
      }
    }

    // Clear of the whole road, not just its junctions. Plans generated per
    // biome put buildings far closer to the carriageway than the old
    // hand-placed sites did, and a house whose wall overlaps a street is a
    // house every passer-by walks into.
    for (let i = 0; i < n; i++) {
      const b = buildings[i];
      const need = footprintRadius(b) + 1;
      for (let u = 0; u < layout.nodes.length; u++) {
        for (const v of layout.edges[u]) {
          if (v < u) continue;
          const [ax, ay] = layout.nodes[u];
          const [bx, by] = layout.nodes[v];
          const ex = bx - ax, ey = by - ay;
          const len2 = ex * ex + ey * ey;
          // Closest point on the segment to the building's centre.
          const t = len2 > 0 ? clamp(((b.x - ax) * ex + (b.y - ay) * ey) / len2, 0, 1) : 0;
          const px = ax + ex * t, py = ay + ey * t;
          let ox = b.x - px, oy = b.y - py;
          let d = Math.hypot(ox, oy);
          if (d >= need) continue;
          if (d < 0.0001) { ox = -ey; oy = ex; d = Math.hypot(ox, oy) || 1; }
          residual = Math.max(residual, need - d);
          dx[i] += (ox / d) * (need - d);
          dy[i] += (oy / d) * (need - d);
        }
      }
    }

    // And nothing stands in the river.
    for (let i = 0; i < n; i++) {
      const b = buildings[i];
      if (!water.isWater(b.x, b.y)) continue;
      const out = water.toLand(b.x, b.y);
      residual = Math.max(residual, out.d + 2.4);
      dx[i] += out.x * (out.d + 2.4);
      dy[i] += out.y * (out.d + 2.4);
    }

    if (residual < 0.02) return;

    // Damped, because a full correction against several constraints at once
    // overshoots and the whole set oscillates.
    for (let i = 0; i < n; i++) {
      buildings[i].x = clamp(buildings[i].x + dx[i] * 0.5, 6, 94);
      buildings[i].y = clamp(buildings[i].y + dy[i] * 0.5, 8, 92);
    }
  }

  // Anything still in violation is not going to be nudged free: it is wedged
  // somewhere with no valid position nearby. Move it instead. A building that
  // ends up a little further from its intended plot is invisible; two buildings
  // sharing a wall is a corridor citizens cannot walk down.
  relocateStuck(buildings, layout, water);
}

/** Somewhere this building can legally stand, searched outward in a spiral. */
function relocateStuck(buildings: Building[], layout: WorldLayout, water: WaterField) {
  const legal = (b: Building, x: number, y: number, bankGap: number) => {
    if (x < 6 || x > 94 || y < 8 || y > 92) return false;
    // Leave walkable bank, not merely dry ground: a wall closer to the water
    // than a person is wide turns the gap between them into a trap.
    if (water.distanceToWater(x, y) < footprintRadius(b) + bankGap) return false;
    const need = footprintRadius(b) + 1;
    for (let u = 0; u < layout.nodes.length; u++) {
      for (const v of layout.edges[u]) {
        if (v < u) continue;
        const [ax, ay] = layout.nodes[u];
        const [bx, by] = layout.nodes[v];
        const ex = bx - ax, ey = by - ay;
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / len2, 0, 1) : 0;
        if (Math.hypot(x - (ax + ex * t), y - (ay + ey * t)) < need) return false;
      }
    }
    for (const other of buildings) {
      if (other === b) continue;
      const gap = footprintRadius(b) + footprintRadius(other) + 0.8;
      if ((other.x - x) ** 2 + (other.y - y) ** 2 < gap * gap) return false;
    }
    return true;
  };

  for (const b of buildings) {
    if (legal(b, b.x, b.y, 1.5)) continue;
    let moved = false;
    // Roomy first, then cramped, so a fen still gets its buildings placed.
    for (const bankGap of [1.5, 0.4]) {
      for (let ring = 1; ring <= 14 && !moved; ring++) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + ring * 0.4;
          const x = b.x + Math.cos(a) * ring * 2.4;
          const y = b.y + Math.sin(a) * ring * 2.4 * 0.9;
          if (!legal(b, x, y, bankGap)) continue;
          b.x = x; b.y = y; moved = true;
          break;
        }
      }
      if (moved) break;
    }
  }
}

export function createWorld(seed = 481516, name?: string): World {
  const rand = mulberry32(seed);
  const profile = biomeFor(seed);
  const water = waterOf({ seed, biome: profile.kind });
  const layout = createLayout(seed, profile, water);
  const terrain = Array.from({ length: 3 }, () => (['fertile', 'forest', 'mountain', 'rocky', 'coastal', 'river'] as Terrain[])[Math.floor(rand() * 6)]);
  // How many people the land carries. A desert supports fewer than a grassland,
  // and the settlement should read as the size the ground can feed.
  const count = Math.max(12, Math.round((17 + rand() * 8) * profile.populationScale));
  const families: Family[] = [];
  const citizens: Citizen[] = [];
  for (let i = 0; i < Math.ceil(count / 4); i++) families.push({ id: `f${i}`, name: familyNames[i % familyNames.length], homeId: `h${i}`, members: [], wealth: 80 + Math.floor(rand() * 80) });
  for (let i = 0; i < count; i++) {
    const family = families[i % families.length];
    const age = i % 5 === 0 ? 8 + Math.floor(rand() * 8) : 18 + Math.floor(rand() * 42);
    const hash = i * 37 + 11;
    const name = names[i % names.length];
    // Everyone starts somewhere near the square rather than in a fixed box, so
    // a settlement built on the far side of the map does not open with its
    // population standing in a field.
    const spawn = layout.wanderSpots[Math.floor(rand() * layout.wanderSpots.length)];
    const x = clamp(spawn[0] + (rand() - 0.5) * 6, 4, 96), y = clamp(spawn[1] + (rand() - 0.5) * 6, 6, 94);
    const citizen: Citizen = {
      id: `c${i}`, name, handle: `@${name.toLowerCase()}${(hash % 90) + 10}`, familyId: family.id, age, hash,
      job: age >= 16 ? chooseJobFromSeed(terrain, i) : 'unemployed',
      hunger: 82 + rand() * 18, rest: 72 + rand() * 28, social: 60 + rand() * 40, clothing: 72 + rand() * 28,
      purpose: 55 + rand() * 45, happiness: 78, wage: 0, wallet: 45 + Math.floor(rand() * 55),
      x, y, destX: x, destY: y, path: [], dwell: 0, wanderIdx: i * 5, errand: false,
      phase: 'wandering', activity: 'idle', facing: 's', moving: false, inside: false,
      stalled: 0, bestAway: Infinity, roughSleeper: false,
      look: Math.floor(rand() * 0xffffff),
    };
    citizens.push(citizen);
    family.members.push(citizen.id);
  }
  const buildings = starterBuildings(seed, layout);
  families.forEach((f, i) => {
    const [hx, hy] = layout.housePlots[i % layout.housePlots.length];
    buildings.push({ id: f.homeId, type: 'House', x: hx, y: hy, workers: [], active: true });
  });
  enforceSpacing(buildings, layout, water);

  const world: World = {
    id: `world-${seed.toString(36)}`, name: name?.trim() || defaultWorldName(seed), seed, biome: profile.kind, layout, day: 1, hour: 8, terrain, season: 'Spring',
    weather: weatherFor('Spring', seed, 1), weatherSeed: seed, treasury: 3000, population: count,
    families, citizens, buildings,
    resources: { wheat: 60, vegetables: 30, wood: 50, stone: 20, ironOre: 10, wool: 8, flour: 0, bread: 20, furniture: 0, tools: 5, clothing: 10 },
    market: createMarket(),
    feed: [], gatherings: [], bonds: {}, projects: [], unlockedAreas: ['Settlement'],
    marketClock: 0, flow: { produced: {}, consumed: {} }, counter: 0,
  };
  pushFeed(world, 'world', `${world.name} has emerged.`);
  pushFeed(world, 'world', 'Families are settling into their homes.');
  pushFeed(world, 'market', 'The market is open and trade has begun.');
  scheduleGatherings(world);
  // Give everyone a real first destination so the world is in motion on frame one.
  for (const c of world.citizens) assignDestination(world, c, phaseFor(c, world.hour));
  return world;
}

/** Each day gets its own social calendar, seeded so replays match. */
function scheduleGatherings(world: World) {
  const rand = mulberry32(world.seed + world.day * 977);
  const tavern = findBuilding(world, 'Tavern');
  const market = findBuilding(world, 'Market');
  const square = tavern ?? market;
  const next: Gathering[] = [];
  if (square) next.push({ id: `g${world.day}-meetup`, name: 'Town Meetup', kind: 'meetup', day: world.day, hour: 19, duration: 2, buildingId: square.id, attendees: [] });
  if (market && rand() < 0.7) next.push({ id: `g${world.day}-showcase`, name: 'Art Showcase', kind: 'showcase', day: world.day, hour: 21, duration: 1.5, buildingId: market.id, attendees: [] });
  if (market && world.day % 5 === 0) next.push({ id: `g${world.day}-market`, name: 'Market Day', kind: 'market', day: world.day, hour: 10, duration: 4, buildingId: market.id, attendees: [] });
  world.gatherings = next;
}

/**
 * Household spending.
 *
 * This is the return leg of the economy: wages leave the treasury and come back
 * when families buy what they need. Without it, citizens hoard gold forever and
 * the treasury drains to nothing no matter how productive the settlement is.
 */
function householdTrade(world: World) {
  for (const c of world.citizens) {
    if (c.age < 16 || c.wallet < 1) continue;

    if (c.hunger <= 62) {
      const r = (['bread', 'wheat', 'vegetables'] as Resource[]).find((x) => world.resources[x] >= 1);
      if (r) {
        const price = world.market[r].price;
        if (c.wallet >= price) {
          c.wallet -= price; world.treasury += price; world.resources[r] -= 1;
          note(world, 'consumed', r, 1);
          c.hunger = Math.min(100, c.hunger + 18);
        }
      }
    }

    if (c.clothing < 60 && world.resources.clothing >= 1) {
      const price = world.market.clothing.price;
      if (c.wallet >= price) {
        c.wallet -= price; world.treasury += price; world.resources.clothing -= 1;
        note(world, 'consumed', 'clothing', 1);
        c.clothing = Math.min(100, c.clothing + 34);
      }
    }

    // Comfort spending, spread across the day so households do not all buy at once.
    if (c.wallet > 130 && world.resources.furniture >= 1 && c.hash % 6 === Math.floor(world.hour) % 6) {
      const price = world.market.furniture.price;
      if (c.wallet >= price) {
        c.wallet -= price; world.treasury += price; world.resources.furniture -= 1;
        note(world, 'consumed', 'furniture', 1);
        c.purpose = Math.min(100, c.purpose + 2.5);
      }
    }

    if (c.wallet > 200 && world.resources.tools >= 1 && c.job !== 'unemployed' && c.hash % 11 === Math.floor(world.hour) % 11) {
      const price = world.market.tools.price;
      if (c.wallet >= price) {
        c.wallet -= price; world.treasury += price; world.resources.tools -= 1;
        note(world, 'consumed', 'tools', 1);
        c.purpose = Math.min(100, c.purpose + 4);
      }
    }
  }
}

/**
 * One hour of trade.
 *
 * This is deliberately driven by a game-hour accumulator rather than called per
 * frame. The order sizes have a one-unit floor, so running it every frame made
 * the volume traded — and the gold moved — scale with the client's frame rate
 * instead of with game time.
 */
function marketStep(world: World, hours: number) {
  // The feed is a record of the settlement's life, so routine trade gets at most
  // one line a day. Left unthrottled it buries every friendship and discovery.
  const reportedToday = world.feed.some((e) => e.kind === 'market' && e.day === world.day);
  let reported = reportedToday;

  const localOutputs = new Set<Resource>();
  for (const [job, recipe] of Object.entries(jobs)) {
    if (!world.buildings.some((b) => b.type === recipe.building && b.active)) continue;
    if (!world.citizens.some((c) => c.job === job)) continue;
    for (const key of Object.keys(recipe.output) as Resource[]) localOutputs.add(key);
  }

  for (const r of Object.keys(marketPrices) as Resource[]) {
    const q = world.market[r], stock = world.resources[r], buffer = marketBuffers[r];
    const base = marketPrices[r];
    const scarcity = clamp((buffer - stock) / Math.max(buffer, 1), -1, 1.5);
    // Prices ease toward a scarcity-adjusted target rather than compounding a
    // percentage every step. Compounding sends a persistently well-stocked good
    // to the floor within a fortnight and takes the treasury down with it.
    const target = clamp(base * (1 + scarcity * 0.8), base * 0.45, base * 3.5);
    const old = q.price;
    q.price += (target - q.price) * Math.min(1, 0.06 * hours);
    q.supply = Math.max(0, stock - buffer); q.demand = Math.max(0, buffer - stock); q.volume = 0; q.trend = q.price - old;
    // The settlement imports what it cannot make for itself. For goods it does
    // produce, the market only steps in during a real shortage — otherwise it
    // spends the treasury buying back the bread its own bakery is making.
    const importer = !localOutputs.has(r);
    if (stock < buffer * (importer ? 0.65 : 0.3)) {
      const qty = Math.min(Math.max(1, Math.round((buffer - stock) * .2 * hours)), Math.max(0, buffer - stock)), cost = qty * q.price;
      if (qty > 0 && world.treasury >= cost) {
        world.resources[r] += qty; world.treasury -= cost; q.volume += qty;
        if (qty >= 6 && !reported) { reported = true; pushFeed(world, 'market', `The market bought ${qty} ${RESOURCE_LABELS[r].toLowerCase()} for ${cost.toFixed(0)} Gold.`); }
      }
    } else if (stock > buffer * 1.2) {
      const qty = Math.min(Math.max(1, Math.round((stock - buffer) * .25 * hours)), Math.floor(stock - buffer));
      if (qty > 0) {
        const revenue = qty * q.price; world.resources[r] -= qty; world.treasury += revenue; q.volume += qty;
        if (qty >= 6 && !reported) { reported = true; pushFeed(world, 'market', `The market sold ${qty} ${RESOURCE_LABELS[r].toLowerCase()} for ${revenue.toFixed(0)} Gold.`); }
      }
    }
  }
  householdTrade(world);
}

/** Run whole hours of trade out of the accumulator. */
function runMarket(world: World, hours: number) {
  world.marketClock += hours;
  let guard = 0;
  while (world.marketClock >= 1 && guard++ < 48) {
    world.marketClock -= 1;
    marketStep(world, 1);
  }
}

function terrainMultiplier(world: World, job: WorkingJob) { return world.terrain.reduce((s, t) => s + (terrainBonuses[t][job] || 1), 0) / world.terrain.length; }
/**
 * How badly the settlement wants one more worker in a trade.
 *
 * Scored from the real gap between what the stores hold and what the market
 * wants to keep, for every output the trade produces — and dampened when its
 * inputs are missing, since a baker with no flour is not what a shortage of
 * bread calls for.
 */
function jobScore(world: World, j: WorkingJob) {
  const spec = world.terrain.map((t) => terrainBonuses[t][j] || 1).reduce((a, b) => a + b, 0) / world.terrain.length;
  const recipe = jobs[j];

  let demand = 0.6;
  for (const key of Object.keys(recipe.output) as Resource[]) {
    const buffer = Math.max(1, marketBuffers[key]);
    demand += clamp((buffer - world.resources[key]) / buffer, -0.4, 1.5) * 1.3;
  }

  let feasible = 1;
  for (const [key, amount] of Object.entries(recipe.input ?? {})) {
    if (world.resources[key as Resource] < (amount as number) * 2) feasible *= 0.3;
  }

  return Math.max(0.05, spec * Math.max(0.15, demand) * feasible);
}

/** How many workers a job can usefully employ, given the buildings that exist. */
function jobCapacity(world: World, j: WorkingJob) {
  const sites = world.buildings.filter((b) => b.type === jobs[j].building && b.active).length;
  return sites * (j === 'miner' ? 3 : 2);
}

/**
 * Pick a job for one citizen.
 *
 * Scoring divides by how many people already do the work and collapses once a
 * trade is at the capacity its buildings can actually use, so labour spreads
 * across the settlement and follows shortages instead of everyone piling into
 * whichever single trade scores highest.
 */
function chooseJob(world: World, counts?: Partial<Record<Job, number>>): WorkingJob {
  const tally = counts ?? world.citizens.reduce((acc, c) => {
    acc[c.job] = (acc[c.job] ?? 0) + 1;
    return acc;
  }, {} as Partial<Record<Job, number>>);

  const available = (Object.keys(jobs) as WorkingJob[]).filter((j) => world.buildings.some((b) => b.type === jobs[j].building));
  const a: WorkingJob[] = available.length ? available : ['farmer'];
  return a
    .map((j) => {
      const taken = tally[j] ?? 0;
      const capacity = Math.max(1, jobCapacity(world, j));
      const crowding = taken >= capacity ? 0.12 : 1;
      return { j, s: (jobScore(world, j) / (1 + taken)) * crowding };
    })
    .sort((x, y) => y.s - x.s)[0].j;
}

/** Record a resource movement for the day's flow figures. */
function note(world: World, side: 'produced' | 'consumed', key: Resource, amount: number) {
  if (!(amount > 0)) return;
  world.flow[side][key] = (world.flow[side][key] ?? 0) + amount;
}

function produce(world: World) {
  const counts: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) counts[c.job] = (counts[c.job] || 0) + 1;
  for (const [job, count] of Object.entries(counts)) {
    if (!job || job === 'unemployed' || !count) continue;
    const wj = job as WorkingJob, recipe = jobs[wj], workers = Math.min(count, jobCapacity(world, wj));
    const seasonal = world.season === 'Winter' && wj === 'farmer' ? .65 : world.season === 'Summer' && wj === 'farmer' ? 1.15 : 1;
    const weather = world.weather === 'Storm' ? .65 : world.weather === 'Rain' && wj === 'farmer' ? 1.08 : world.weather === 'Snow' ? .7 : 1;
    if (recipe.input && !Object.entries(recipe.input).every(([r, n]) => world.resources[r as Resource] >= (n as number) * workers)) continue;
    for (const [r, n] of Object.entries(recipe.input || {})) {
      const used = (n as number) * workers;
      world.resources[r as Resource] -= used;
      note(world, 'consumed', r as Resource, used);
    }
    for (const [r, n] of Object.entries(recipe.output)) {
      const made = (n as number) * workers * terrainMultiplier(world, wj) * seasonal * weather;
      world.resources[r as Resource] += made;
      note(world, 'produced', r as Resource, made);
    }
  }
  if (counts.farmer) pushFeed(world, 'work', `${counts.farmer} farmers tended the fields.`);
  if (counts.woodcutter) pushFeed(world, 'work', `${counts.woodcutter} woodcutters worked the forest.`);
  if (world.weather === 'Storm') pushFeed(world, 'weather', 'A storm slowed outdoor work today.');
  if (world.weather === 'Snow') pushFeed(world, 'weather', 'Snow settled over the settlement.');
}

/** Extraction jobs occasionally turn up something rare, credited to a real worker. */
function discoveries(world: World) {
  const rand = mulberry32(world.seed + world.day * 1531);
  const diggers = world.citizens.filter((c) => c.job === 'miner' || c.job === 'quarry');
  if (!diggers.length || rand() > 0.28) return;
  const finder = diggers[Math.floor(rand() * diggers.length)];
  const rare: Resource = finder.job === 'miner' ? 'ironOre' : 'stone';
  const amount = 8 + Math.floor(rand() * 14);
  world.resources[rare] += amount;
  finder.purpose = Math.min(100, finder.purpose + 12);
  pushFeed(world, 'discovery', `${finder.name} discovered a rich seam of ${RESOURCE_LABELS[rare].toLowerCase()}.`);
}

const PROJECT_NAMES = ['a new workshop bench', 'a river footbridge', 'a set of lanterns for the square', 'a mural for the market wall', 'a longer harvest cart', 'a stone well', 'a bench by the pond'];

/** Citizens with a strong sense of purpose start and finish visible projects. */
function projects(world: World) {
  const rand = mulberry32(world.seed + world.day * 2237);
  for (const p of world.projects) p.progress += 1;
  const done = world.projects.filter((p) => p.progress >= p.length);
  for (const p of done) {
    const owner = world.citizens.find((c) => c.id === p.ownerId);
    if (owner) {
      owner.purpose = Math.min(100, owner.purpose + 18);
      owner.happiness = Math.min(100, owner.happiness + 6);
      pushFeed(world, 'project', `${owner.name} finished ${p.name}.`);
    }
  }
  world.projects = world.projects.filter((p) => p.progress < p.length);

  const candidates = world.citizens.filter((c) => c.age >= 16 && c.purpose > 62 && !world.projects.some((p) => p.ownerId === c.id));
  if (candidates.length && world.projects.length < 3 && rand() < 0.5) {
    const owner = candidates[Math.floor(rand() * candidates.length)];
    const name = PROJECT_NAMES[Math.floor(rand() * PROJECT_NAMES.length)];
    world.projects.push({ id: `p${world.counter++}`, ownerId: owner.id, name, buildingId: owner.targetBuildingId ?? '', progress: 0, length: 2 + Math.floor(rand() * 3) });
    pushFeed(world, 'project', `${owner.name} started ${name}.`);
  }
}

/** The settlement opens up new ground as it grows. */
function checkUnlocks(world: World) {
  const milestones: [string, boolean][] = [
    ['Riverside', world.buildings.length >= 16],
    ['North Ridge', world.population >= 26 && world.treasury >= 3500],
    ['Deep Woods', world.resources.wood >= 220],
  ];
  for (const [area, reached] of milestones) {
    if (reached && !world.unlockedAreas.includes(area)) {
      world.unlockedAreas.push(area);
      pushFeed(world, 'build', `The community unlocked ${area}.`);
    }
  }
}

function consume(world: World) {
  const need = world.citizens.reduce((s, c) => s + (c.age < 16 ? .5 : .9), 0);
  let remaining = need;
  for (const r of ['bread', 'wheat', 'vegetables'] as Resource[]) {
    const take = Math.min(world.resources[r], remaining);
    world.resources[r] -= take;
    note(world, 'consumed', r, take);
    remaining -= take;
  }
  if (remaining > 0) pushFeed(world, 'market', 'Food is running low. Families are searching the market.');
}

export function maintenanceCost(type: string) {
  return ({ Bank: 0, Market: 15, Storage: 3, House: 1, Farm: 3, Woodcutter: 2, Quarry: 4, Mine: 6, Mill: 5, Bakery: 6, Carpenter: 5, Blacksmith: 8, Tailor: 6, Tavern: 7, 'Town Hall': 10 } as Record<string, number>)[type] ?? 2;
}

function daily(world: World) {
  world.flow = { produced: {}, consumed: {} };
  const workers = world.citizens.filter((c) => c.age >= 16);
  const upkeep = world.buildings.filter((b) => b.active).reduce((s, b) => s + maintenanceCost(b.type), 0);

  // Assign jobs first, tracking the running tally so each choice sees the
  // settlement as it is being staffed rather than as it was yesterday.
  const tally: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) {
    if (c.age < 16) { c.job = 'unemployed'; c.wage = 0; continue; }
    const need = Math.min(c.hunger, c.rest, c.social, c.clothing, c.purpose);
    const overCapacity = (tally[c.job] ?? 0) >= Math.max(1, jobCapacity(world, c.job as WorkingJob));
    let jobKey: WorkingJob = c.job === 'unemployed' ? chooseJob(world, tally) : c.job;
    if (need < 35 || overCapacity) jobKey = chooseJob(world, tally);
    c.job = jobKey;
    tally[jobKey] = (tally[jobKey] ?? 0) + 1;
  }

  // Payroll is paid from the treasury, pro rata when it cannot cover the bill.
  const payroll = workers.reduce((s, c) => s + jobs[c.job as WorkingJob].wage, 0);
  const affordable = Math.max(0, world.treasury - upkeep);
  const ratio = payroll > 0 ? Math.min(1, affordable / payroll) : 1;
  if (ratio < 0.999 && workers.length) {
    pushFeed(world, 'market', ratio <= 0
      ? 'The treasury is empty. Nobody was paid today.'
      : `The treasury could only cover ${Math.round(ratio * 100)}% of wages today.`);
  }
  for (const c of world.citizens) {
    if (c.age < 16) continue;
    c.wage = jobs[c.job as WorkingJob].wage * ratio;
    c.wallet += c.wage;
    c.hunger = Math.max(0, c.hunger - 7); c.rest = Math.max(0, c.rest - 5);
    c.social = Math.max(0, c.social - 2); c.clothing = Math.max(0, c.clothing - 2.5);
    // Unpaid work erodes a sense of purpose; paid work slowly builds it.
    c.purpose = clamp(c.purpose + (ratio > 0.5 ? 0.5 : -1.5), 0, 100);
  }
  world.treasury = Math.max(0, world.treasury - payroll * ratio - upkeep);

  for (const r of Object.keys(marketPrices) as Resource[]) {
    const q = world.market[r];
    q.history.push(Number(q.price.toFixed(3)));
    if (q.history.length > 30) q.history.shift();
  }

  const homeless = world.citizens.filter((c) => c.age >= 16 && !homeOf(world, c));
  if (homeless.length) {
    const shelter = findBuilding(world, 'Tavern');
    pushFeed(world, 'social', shelter
      ? `${homeless.length} ${homeless.length === 1 ? 'person has' : 'people have'} no home and slept at the tavern.`
      : `${homeless.length} ${homeless.length === 1 ? 'person' : 'people'} slept outside. The settlement needs houses.`);
  }

  produce(world);
  consume(world);
  discoveries(world);
  projects(world);
  decayBonds(world);
  for (const f of world.families) f.wealth = world.citizens.filter((c) => c.familyId === f.id).reduce((s, c) => s + c.wallet, 0);
  world.population = world.citizens.length;
  checkUnlocks(world);
  scheduleGatherings(world);
}

/**
 * Advance the world in place by `hours` of game time. Called every animation
 * frame by the client; safe to call with very small deltas.
 */
export function advance(world: World, hours: number): World {
  if (!(hours > 0)) return world;
  world.hour += hours;
  moveCitizens(world, hours);
  runMarket(world, hours);
  let guard = 0;
  while (world.hour >= 24 && guard++ < 8) {
    world.hour -= 24; world.day++;
    world.season = seasonForDay(world.day);
    world.weather = weatherFor(world.season, world.weatherSeed, world.day);
    daily(world);
  }
  updateBuildingWorkers(world);
  socialStep(world, hours);
  for (const c of world.citizens) {
    c.rest = Math.max(0, c.rest - hours * (world.weather === 'Storm' ? 2.3 : 2));
    c.social = Math.max(0, c.social - hours * .35);
    c.hunger = Math.max(0, c.hunger - hours * .75);
    if (c.activity === 'eating') c.hunger = Math.min(100, c.hunger + hours * 1.4);
    if (c.activity === 'resting') c.rest = Math.min(100, c.rest + hours * (c.roughSleeper ? 0.45 : 1.1));
    c.happiness = clamp((c.hunger + c.rest + c.social + c.clothing + c.purpose) / 5, 0, 100);
  }
  return world;
}

/** Immutable wrapper around `advance`, kept for callers that want snapshots. */
export function tick(world: World, hours = 1): World {
  return advance(structuredClone(world), hours);
}

/** Player-driven construction. Returns the new building, or null if unaffordable. */
export function constructBuilding(world: World, type: string, cost: number, x: number, y: number): Building | null {
  if (world.treasury < cost) return null;
  // Refuse the river rather than quietly moving the building somewhere else:
  // a player who clicked on water should be told no, not have their choice
  // silently overridden.
  if (waterOf(world).isWater(x, y)) return null;
  const building: Building = { id: `b${world.counter++}`, type, x: clamp(x, 6, 94), y: clamp(y, 8, 92), workers: [], active: true };
  world.treasury -= cost;
  world.buildings.push(building);
  pushFeed(world, 'build', `A new ${type.toLowerCase()} was built for ${cost} Gold.`);
  checkUnlocks(world);
  return building;
}

/** Add Gold to the treasury from outside the settlement's own economy. */
export function fundTreasury(world: World, gold: number, note: string) {
  if (!(gold > 0)) return;
  world.treasury += gold;
  pushFeed(world, 'market', note);
}

/** Take Gold out of the treasury. Returns false when it cannot cover the draw. */
export function drawFromTreasury(world: World, gold: number, note: string) {
  if (!(gold > 0) || world.treasury < gold) return false;
  world.treasury -= gold;
  pushFeed(world, 'market', note);
  return true;
}

/**
 * The player's "Inspire" action. It never puppeteers a citizen — it nudges the
 * whole settlement's mood and purpose and lets behaviour follow from that.
 */
export function inspireWorld(world: World): FeedEntry | null {
  const rand = mulberry32(world.seed + world.counter * 13 + Math.floor(world.hour));
  const adults = world.citizens.filter((c) => c.age >= 16);
  if (!adults.length) return null;
  for (const c of world.citizens) {
    c.purpose = Math.min(100, c.purpose + 6 + rand() * 6);
    c.social = Math.min(100, c.social + 4);
  }
  const focus = adults[Math.floor(rand() * adults.length)];
  pushFeed(world, 'project', `A wave of inspiration moved through the settlement. ${focus.name} feels a new idea forming.`);
  return world.feed[0];
}

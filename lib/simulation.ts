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
import { BRIDGE_RAMP, DECK_OVERHANG, createLayout, deckAt, onDeck, type WorldLayout } from './world/layout';
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
  id: string; name: string; handle: string; familyId: string;
  /**
   * Years lived, carried as a fraction.
   *
   * It has to be fractional: at half a year per day, an integer age plus a half
   * floored straight back to where it started and nobody aged at all. Round it
   * for display, never for storage.
   */
  age: number;
  job: Job; hash: number;
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

  /**
   * Game days lived since this citizen appeared. `age` is derived from it, so
   * the world does not have to remember birthdays.
   */
  livedDays: number;
  /** The age they are unlikely to see the far side of, in years. */
  lifespan: number;
  /**
   * How warm they are, 0 (dangerously cold) to 100 (comfortable). Cold drives
   * people to fires and hearths, and kills the ones who have neither.
   */
  warmth: number;
  /** Amenity they are currently occupying, if any: a bench, a fire, the well. */
  usingId?: string;
  /** True while sat on a bench or crouched at a fire, which the renderer draws. */
  seated: boolean;
  /**
   * True while they have gone indoors to escape the weather.
   *
   * A latch, not a test. Deciding it afresh each frame from a single threshold
   * made the phase flip every time `warmth` crossed it, and each flip picked a
   * new destination: citizens turned round on the spot for as long as the cold
   * lasted, which is a reversal on nearly half of all frames.
   */
  sheltering: boolean;
  /**
   * Whether their discomfort is cold rather than heat. Both drain `warmth`,
   * but a settlement that reports a desert death as "could not keep warm" is
   * lying to the player.
   */
  chilled: boolean;
}

/**
 * Something in the settlement a citizen can go and use.
 *
 * These are owned by the simulation and drawn by the terrain generator, the
 * same arrangement roads and bridges use. A bench nobody can sit on is set
 * dressing; a bench the simulation knows about is somewhere to be.
 */
export interface BridgeWorks {
  /** Which landmass this crossing reaches. */
  island: number;
  /** The near bank, the far bank, and the deck between them. */
  fromX: number; fromY: number;
  toX: number; toY: number;
  /** Days of work done, and how many it takes. */
  progress: number;
  length: number;
}

export type AmenityKind = 'bench' | 'campfire' | 'well' | 'stall';
export interface Amenity {
  id: string;
  kind: AmenityKind;
  x: number;
  y: number;
  /** How many people can use it at once. */
  capacity: number;
  /** Citizen ids currently using it. */
  users: string[];
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
  /** Air temperature right now, in degrees Celsius. */
  temperature: number;
  /** Everyone who has ever died here, so a settlement has a history. */
  deaths: number;
  births: number;
  /** Benches, fires, wells and stalls, and who is using them. */
  amenities: Amenity[];
  /**
   * A bridge the settlement is building to land it cannot otherwise reach, and
   * the islands it has already connected.
   *
   * A settlement penned onto one island by water stays that size forever. This
   * is how it grows past its shore: it finds the narrowest crossing to the
   * biggest piece of land it cannot walk to, and spends wood and gold on
   * getting there.
   */
  bridgeWorks: BridgeWorks | null;
  connectedIslands: number[];
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
    if (water.blocks(x, y) && !onBridge(layout, x, y)) return false;
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

/** Let go of whatever bench or fire they were on. */
function releaseAmenity(world: World, c: Citizen) {
  if (c.usingId === undefined) return;
  const held = world.amenities.find((a) => a.id === c.usingId);
  if (held) held.users = held.users.filter((id) => id !== c.id);
  c.usingId = undefined;
  c.seated = false;
}

/**
 * Claim the nearest free amenity of a kind, if there is one worth walking to.
 *
 * Capacity is real: two to a bench, four round a fire. Without it the whole
 * settlement piles onto the same seat and the rest of the furniture may as well
 * not exist.
 */
function claimAmenity(world: World, c: Citizen, kinds: AmenityKind[], reach: number): Amenity | undefined {
  let best: Amenity | undefined;
  let bestD = reach * reach;
  for (const a of world.amenities) {
    if (!kinds.includes(a.kind)) continue;
    if (a.users.length >= a.capacity && !a.users.includes(c.id)) continue;
    const d = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    if (d < bestD) { bestD = d; best = a; }
  }
  if (!best) return undefined;
  releaseAmenity(world, c);
  best.users.push(c.id);
  c.usingId = best.id;
  return best;
}

// Destinations are committed and persist until the citizen actually arrives, rather
// than being recomputed every tick (which would make everyone reverse direction mid-walk).
function assignDestination(world: World, c: Citizen, phase: Phase) {
  c.phase = phase;
  let target: { x: number; y: number; id?: string } | undefined;
  let spread = 2.4;

  // A new destination means giving up the bench.
  releaseAmenity(world, c);

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
    // A market stall to buy at, if one is free, rather than the doorway.
    const stall = claimAmenity(world, c, ['stall'], 60);
    target = stall ?? findBuilding(world, 'Market') ?? findBuilding(world, 'Bakery');
    if (stall) spread = 0.9;
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

  // Cold, dark or simply idle: the settlement's furniture is somewhere to be.
  //
  // A fire beats a bench when someone is genuinely cold, which is what makes a
  // campfire worth having in a desert night or a highland winter. Otherwise
  // people sit down between errands like anyone would.
  if (!target && (phase === 'socialising' || phase === 'wandering' || phase === 'athome')) {
    const cold = c.warmth < 55 || world.temperature < 6;
    const night = world.hour >= 19 || world.hour < 6;
    const wants: AmenityKind[] = cold || night ? ['campfire', 'bench'] : ['bench', 'campfire'];
    // Only if one is reasonably close: nobody crosses the settlement to sit.
    const spot = ((c.hash + Math.floor(world.hour)) % 3 !== 0 || cold)
      ? claimAmenity(world, c, wants, cold ? 45 : 22)
      : undefined;
    if (spot) {
      target = { x: spot.x, y: spot.y };
      spread = spot.kind === 'campfire' ? 2.1 : 1.1;
    }
  }

  // A thirsty errand: someone fetches water from the well.
  if (!target && phase === 'wandering' && (c.hash + world.day) % 4 === 0) {
    const well = claimAmenity(world, c, ['well'], 40);
    if (well) { target = { x: well.x, y: well.y }; spread = 1.4; }
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
  if (water.blocks(c.destX, c.destY)) {
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
  //
  // And never within sight of the water. A shortcut that looks dry from where
  // the citizen is standing can put them on a bank with the last leg of the
  // journey across a channel, and there they slide back and forth for the rest
  // of the day: one worker was measured jittering a tenth of a unit at the
  // water's edge, five units from a workplace on the far side.
  const nearShore = water.distanceToWater(c.x, c.y) < 3.5;
  let from = 0;
  while (!nearShore && from + 1 < full.length) {
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
function resolveOverlap(c: Citizen, obstacles: Obstacle[], tx: number, ty: number, water: WaterField, onBridge: boolean, hours: number) {
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
    //
    // The correction has to be decisive.
    //
    // Capping it at a walking pace was tried, on the theory that a gentler
    // nudge would look more natural. It does the opposite: a citizen who is not
    // ejected promptly spends several frames inside the wall with the push and
    // the pull toward their destination fighting, which is the limit cycle
    // again — direction reversals went from three per cent of frames to
    // forty-four, and time spent inside walls quintupled. So the floor stays
    // where it was measured to work, and only rises for a long frame, which
    // fixes the one real flaw in the old constant: it applied the same shove
    // whether the frame covered a minute of game time or ten.
    const len = Math.hypot(pushX, pushY);
    const limit = Math.max(0.4, (c.age < 16 ? 9 : 12.5) * hours * 1.6);
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
  // Never on a deck. A bridge is where a citizen is *supposed* to be over the
  // water, and nudging them toward the bank from it fights their own next step:
  // they walked a fifth of a unit along the crossing and were pushed a third of
  // one back, every frame, for as long as they were on it. That is the jitter,
  // exactly. The dead-end case this was meant to cover — a deck with every exit
  // blocked — is handled where it belongs, by walking the deck's own axis.
  if (!onBridge && water.blocks(c.x, c.y)) {
    // Toward the mainland when there is one within reach, so nobody is shoved
    // out of a channel onto an islet they can never leave. Otherwise toward the
    // nearest ground they are actually allowed to stand on — which, unlike the
    // way out of the water itself, also answers for someone inside the margin.
    const home = water.toMainland(c.x, c.y);
    const out = home.d > 0 && home.d < 14 ? home : water.toClear(c.x, c.y);
    const reach = out.d + 0.2;
    let bestX = clamp(c.x + out.x * reach, 2, 98);
    let bestY = clamp(c.y + out.y * reach, 4, 96);
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const nx = out.x * cos - out.y * sin;
      const ny = out.x * sin + out.y * cos;
      const x = clamp(c.x + nx * reach, 2, 98);
      const y = clamp(c.y + ny * reach, 4, 96);
      if (water.blocks(x, y)) continue;
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
  return onDeck(layout.bridges, x, y);
}

function stepCitizen(c: Citizen, hours: number, obstacles: Obstacle[], layout: WorldLayout, water: WaterField) {
  let blocked = false;
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

    // Slow down near a wall, the way anyone does rounding a corner. This is
    // what makes negotiating a building read as care rather than as a bounce:
    // the correction that follows is smaller because less ground was covered
    // into the obstacle in the first place.
    let crowding = 1;
    for (const o of obstacles) {
      if (o.id === c.destId) continue;
      const gap = Math.hypot(c.x - o.x, c.y - o.y) - o.r;
      if (gap < 1.6) crowding = Math.min(crowding, 0.45 + Math.max(0, gap) * 0.34);
    }

    const step = Math.min(d, budget * crowding + 0.0001);
    let nx = clamp(c.x + (dx / d) * step, 2, 98);
    let ny = clamp(c.y + (dy / d) * step, 4, 96);

    // Do not step into the water in the first place.
    //
    // Undoing the step afterwards looked equivalent and was not: walking in,
    // being shoved out and walking in again is a limit cycle. Refusing the step
    // and going round is stable, and it makes people walk around an inlet the
    // way they walk around a wall.
    //
    // Going round is an angular sweep, not a pair of tangents. Two candidates
    // at right angles to the shore fail whenever both happen to be blocked —
    // and then the citizen simply stops, for good. One was measured standing on
    // the same spot for an entire working day with six of sixteen directions
    // around her free. Sweeping outward from the heading she wants also turns
    // her by the smallest angle that clears the obstacle rather than snapping
    // her ninety degrees, which is what made rounding a corner look mechanical.
    if (water.blocks(nx, ny) && !onBridge(layout, nx, ny)) {
      const heading = Math.atan2(dy, dx);
      const side = c.hash % 2 === 0 ? 1 : -1;
      let slid = false;
      for (const turn of [0.35, 0.7, 1.05, 1.4, 1.75, 2.1]) {
        for (const sign of [side, -side]) {
          const a = heading + turn * sign;
          const sx = clamp(c.x + Math.cos(a) * step, 2, 98);
          const sy = clamp(c.y + Math.sin(a) * step, 4, 96);
          if (water.blocks(sx, sy) && !onBridge(layout, sx, sy)) continue;
          nx = sx; ny = sy; slid = true;
          break;
        }
        if (slid) break;
      }
      // Standing on a bridge with nowhere to go but the water: walk the deck.
      //
      // A citizen who ends up on a crossing whose far side is not on their
      // route has every heading refused, because the deck is surrounded by
      // water on both sides. Following the deck's own axis to whichever end is
      // nearer their target always gets them back onto open ground, and normal
      // navigation takes over from there.
      if (!slid) {
        const here = deckAt(layout.bridges, c.x, c.y);
        if (here) {
          const cos = Math.cos(here.bridge.angle), sin = Math.sin(here.bridge.angle);
          const forward = cos * dx + sin * dy >= 0 ? 1 : -1;
          nx = clamp(c.x + cos * step * forward, 2, 98);
          ny = clamp(c.y + sin * step * forward, 4, 96);
          slid = true;
        }
      }
      if (!slid) { blocked = true; break; }
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

  resolveOverlap(c, obstacles, lastTargetX, lastTargetY, water, onBridge(layout, c.x, c.y), hours);

  // Walk the middle of the bridge. Anything that nudges a citizen sideways
  // while they are crossing — the scatter around a destination, a push away
  // from a wall — puts them a step from open water, and the water rule then
  // refuses every direction and leaves them standing in the river. Two in five
  // citizen-samples were on a deck, and thirty-five of the settlement's forty
  // five deaths were those people freezing where they stood.
  //
  // Only while they are actually over the water. A deck's rectangle also covers
  // the dry ground at either end of it, and anyone walking a different road
  // through that ground was being hauled back to the bridge's centre line every
  // frame — half a unit of correction against a step of a fifth of one, which
  // cancels their movement exactly. Whole settlements stood still: nineteen of
  // twenty-one citizens in one, shuffling for days at a junction that happened
  // to sit near a crossing.
  if (water.isWater(c.x, c.y)) {
    const deck = deckAt(layout.bridges, c.x, c.y);
    if (deck && Math.abs(deck.across) > 0.35) {
      const pull = Math.min(Math.abs(deck.across) - 0.2, 0.25) * Math.sign(deck.across);
      const cos = Math.cos(deck.bridge.angle), sin = Math.sin(deck.bridge.angle);
      c.x = clamp(c.x + sin * pull, 2, 98);
      c.y = clamp(c.y - cos * pull, 4, 96);
    }
  }

  // Facing comes from the whole frame's movement, not from each sub-step, and
  // only when the frame actually took someone somewhere.
  const netX = c.x - startX, netY = c.y - startY;
  if (Math.hypot(netX, netY) > 0.02) {
    if (Math.abs(netX) > Math.abs(netY)) c.facing = netX > 0 ? 'e' : 'w';
    else c.facing = netY > 0 ? 's' : 'n';
  }
  return blocked;
}

function moveCitizens(world: World, hours: number) {
  const obstacles = buildObstacles(world);
  const water = waterOf(world);
  for (const c of world.citizens) {
    if (c.age < 16) c.job = 'unemployed';
    let phase = phaseFor(c, world.hour);
    if (c.hunger < 35 && phase !== 'sleeping') phase = 'eating';
    // Anyone genuinely freezing goes in out of it, and stays in until they have
    // properly warmed up. People do not stand in a blizzard until they drop,
    // and children — who wander all day by definition and are never counted as
    // indoors — were doing exactly that. The wide band between going in and
    // coming back out is what stops them pivoting in the doorway.
    if (c.warmth < 30) c.sheltering = true;
    else if (c.warmth > 58) c.sheltering = false;
    if (c.sheltering && phase !== 'sleeping' && homeOf(world, c)) phase = 'athome';

    if (phase !== c.phase) {
      assignDestination(world, c, phase);
    } else if (hasArrived(c)) {
      // Only re-roll a destination after dwelling, never mid-journey.
      if (phase === 'wandering' || phase === 'socialising' || phase === 'working') {
        c.dwell -= hours;
        if (c.dwell <= 0) assignDestination(world, c, phase);
      }
    }

    // Marooned: standing on a scrap of land with no dry route to the roads.
    // The step below cannot help — every direction out is water — so they wade
    // the short way back rather than standing there until they die of exposure,
    // which is exactly what was measured before landmasses were tracked.
    // `landAt` is -1 in the water, and the water is not the rescue's business:
    // stepping in is already refused and being in it is already resolved. Only
    // someone standing on the wrong piece of dry land needs carrying home.
    const standingOn = water.landAt(c.x, c.y);
    if (standingOn >= 0 && standingOn !== water.mainland && !world.connectedIslands.includes(standingOn)) {
      const back = water.toMainland(c.x, c.y);
      if (back.d > 0) {
        const stride = Math.min(back.d + 0.6, 14 * hours + 0.35);
        c.x = clamp(c.x + back.x * stride, 2, 98);
        c.y = clamp(c.y + back.y * stride, 4, 96);
        c.moving = true;
        c.activity = 'walking';
        continue;
      }
    }

    // Pull the string tight at the far end as well.
    //
    // A route ends at the road node nearest the destination, but a citizen can
    // easily be past that node already — standing a fifth of a unit from their
    // own front door with a junction still on the list. They then walked back
    // out to the junction and returned, over and over: one desert worker
    // accounted for four thousand of the settlement's direction reversals doing
    // exactly that. Dropping the rest of the route once the destination is both
    // visible and nearer than the next junction only ever shortens the walk.
    if (c.path.length === 1 && dryLine(water, world.layout, c.x, c.y, c.destX, c.destY)) {
      const last = world.layout.nodes[c.path[0]];
      // Only when that junction is no longer on the way — when standing at it
      // would put them no closer to where they are going than they already are.
      //
      // The test used to be whether the direct line was shorter than the route
      // through the junction, which is the triangle inequality and therefore
      // always true. Every citizen threw away the entire road network on the
      // first frame and walked at their destination in a straight line, across
      // open country and through whatever buildings were in the way. That is
      // most of the jitter: a beeline runs into walls the roads were laid to
      // avoid, and each one is a shove.
      if (Math.hypot(c.destX - c.x, c.destY - c.y) <= Math.hypot(c.destX - last[0], c.destY - last[1])) {
        c.path.length = 0;
      }
    }

    const blocked = stepCitizen(c, hours, obstacles, world.layout, water);
    // Water stopped them dead. Sliding along the bank cannot solve this — the
    // way round is the road, and the road graph knows where the bridges are —
    // so re-route now rather than shuffling until the stall detector notices.
    if (blocked) {
      const full = roadPath(
        world.layout,
        joinRoad(world.layout, water, c.x, c.y),
        joinRoad(world.layout, water, c.destX, c.destY),
      );
      if (full.length > c.path.length) {
        c.path = full;
        c.bestAway = Infinity;
      } else {
        c.stalled += hours * 4;
      }
    }

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
      if (c.stalled > 2.5) {
        // Nothing has worked for two and a half hours: not the route, not the
        // sweep, not a fresh destination. Rather than let them stand there for
        // the rest of the week — one grassland citizen managed eighty-six game
        // hours — send them at the nearest spot they can definitely reach, off
        // the road network entirely, and let the day resume from wherever that
        // leaves them.
        c.stalled = 0;
        c.bestAway = Infinity;
        c.path = [];
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (const spot of world.layout.wanderSpots) {
          const d = (spot[0] - c.x) ** 2 + (spot[1] - c.y) ** 2;
          if (d >= bestD || d < 4) continue;
          if (!dryLine(water, world.layout, c.x, c.y, spot[0], spot[1])) continue;
          bestD = d; best = spot;
        }
        if (best) {
          c.destX = best[0];
          c.destY = best[1];
          c.destId = undefined;
          c.dwell = 0.5;
        } else {
          assignDestination(world, c, phase);
        }
      } else if (c.stalled > 0.75 && c.stalled - hours <= 0.75) {
        assignDestination(world, c, phase);
      }
    }

    const arrived = hasArrived(c);
    c.activity = arrived ? activityFor(phase) : 'walking';
    // Someone with nowhere to go stays out in the open where you can see them.
    c.inside = arrived && !!c.destId && phase !== 'wandering' && !(c.roughSleeper && phase === 'sleeping');
    c.targetBuildingId = c.destId;
    // Sat down only once they have actually got there, and never at a stall —
    // you stand at a market stall.
    const held = c.usingId !== undefined ? world.amenities.find((a) => a.id === c.usingId) : undefined;
    c.seated = !!held && arrived && held.kind !== 'well' && held.kind !== 'stall';
    if (held && arrived) c.activity = held.kind === 'well' ? 'trading' : 'resting';
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
/**
 * The length of a year, in days.
 *
 * Short on purpose. At a hundred and twenty days a season lasted about eighty
 * real minutes and most players would never see winter at all; at twenty-four,
 * a full turn of the year takes about an hour at 1x and ten minutes at 6x, so
 * the seasons are something you watch happen rather than read about.
 */
export const DAYS_PER_YEAR = 24;
const DAYS_PER_SEASON = DAYS_PER_YEAR / 4;

function seasonForDay(day: number): Season {
  const n = (day - 1) % DAYS_PER_YEAR;
  return n < DAYS_PER_SEASON ? 'Spring'
    : n < DAYS_PER_SEASON * 2 ? 'Summer'
      : n < DAYS_PER_SEASON * 3 ? 'Autumn' : 'Winter';
}

/** How far through the year we are, 0 at the first day of spring. */
const yearPhase = (day: number) => ((day - 1) % DAYS_PER_YEAR) / DAYS_PER_YEAR;

/** What the weather does to the air temperature. */
const WEATHER_TEMP: Record<Weather, number> = {
  Clear: 1, Cloudy: -1, Rain: -2.5, Storm: -4, Fog: -1.5, Snow: -7,
};

/**
 * The temperature right now, in degrees Celsius.
 *
 * Three cycles and an offset: the biome's mean, a seasonal swing peaking at
 * midsummer, a daily swing coldest before dawn and warmest mid-afternoon, and
 * whatever the weather is doing. A desert takes the widest daily swing of any
 * biome and a coast the narrowest, which is most of what makes them feel like
 * different places to stand in.
 */
export function temperatureAt(world: { biome: BiomeKind; day: number; hour: number; weather: Weather }) {
  const profile = biomeProfile(world.biome);
  // Midsummer sits a quarter of the way through the year, at the middle of the
  // summer season.
  const seasonal = Math.cos((yearPhase(world.day) - 0.375) * Math.PI * 2);
  // Coldest around 04:00, warmest around 15:00.
  const diurnal = Math.cos(((world.hour - 15) / 24) * Math.PI * 2);
  return profile.baseTemp
    + seasonal * profile.seasonSwing
    + diurnal * (profile.diurnalSwing / 2)
    + WEATHER_TEMP[world.weather];
}

/** How the temperature reads to a person, for the interface. */
export function describeTemperature(celsius: number) {
  if (celsius <= -5) return 'Bitter';
  if (celsius <= 2) return 'Freezing';
  if (celsius <= 9) return 'Cold';
  if (celsius <= 16) return 'Cool';
  if (celsius <= 23) return 'Mild';
  if (celsius <= 30) return 'Warm';
  if (celsius <= 37) return 'Hot';
  return 'Scorching';
}
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
function starterBuildings(seed: number, layout: WorldLayout, population: number): Building[] {
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
  // Only as many trades as the settlement can staff and pay for. The lists are
  // written as what the land *could* support; opening every one of them on a
  // desert of twelve people meant a wage bill and an upkeep bill that its
  // exports could never cover, and the treasury drained to nothing by the third
  // week. The rest is ground for the player to build on.
  const affordable = Math.max(4, Math.round(population / 2.2));
  const trades = biomeFor(seed).trades.slice(0, affordable);
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

/**
 * How long this citizen is likely to live, in years.
 *
 * Drawn once at birth rather than rolled each day, so a person has a life with
 * a shape to it rather than a constant chance of dropping dead.
 */
function lifespanFor(roll: number) {
  return 62 + roll * 26;
}

/**
 * Where the settlement's benches, fires, wells and stalls stand.
 *
 * Owned here rather than by the terrain generator, because a bench nobody can
 * sit on is set dressing. The generator draws props at exactly these positions,
 * so what you see is what a citizen can walk up to and use — the same
 * arrangement the roads and bridges already use.
 */
function buildAmenities(buildings: Building[], layout: WorldLayout, water: WaterField): Amenity[] {
  const out: Amenity[] = [];
  let n = 0;
  const at = (type: string) => buildings.find((b) => b.type === type);
  const add = (kind: AmenityKind, x: number, y: number, capacity: number) => {
    if (water.blocks(x, y)) return;
    if (x < 4 || x > 96 || y < 6 || y > 94) return;
    // Never inside a wall: an amenity you cannot reach is worse than none.
    for (const b of buildings) {
      if ((b.x - x) ** 2 + (b.y - y) ** 2 < (footprintRadius(b) + 0.8) ** 2) return;
    }
    out.push({ id: `a${n++}`, kind, x, y, capacity, users: [] });
  };

  const plaza = layout.plaza;
  add('well', plaza.x + 3.5, plaza.y + 1.5, 2);
  add('bench', plaza.x - 5, plaza.y + 2.5, 2);
  add('bench', plaza.x + 5.5, plaza.y - 3, 2);

  const tavern = at('Tavern');
  if (tavern) {
    add('bench', tavern.x - 5.5, tavern.y + 3.5, 2);
    add('bench', tavern.x + 5.5, tavern.y + 3.5, 2);
    add('campfire', tavern.x - 2, tavern.y + 6.5, 4);
  }

  const market = at('Market');
  if (market) {
    add('campfire', market.x + 4, market.y + 8.5, 4);
    const spots: [number, number][] = [[-7, 4.5], [-2.5, 6], [2.5, 6], [7, 4.5], [-8.5, 0.5], [8.5, 0.5]];
    for (const [dx, dy] of spots) add('stall', market.x + dx, market.y + dy, 1);
  }

  return out;
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
    // `wanderSpots` are already filtered to the mainland, so a spawn is too.
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
      livedDays: 0, lifespan: lifespanFor(rand()), warmth: 82 + rand() * 18, seated: false, chilled: true, sheltering: false,
    };
    citizens.push(citizen);
    family.members.push(citizen.id);
  }
  const buildings = starterBuildings(seed, layout, count);
  families.forEach((f, i) => {
    const [hx, hy] = layout.housePlots[i % layout.housePlots.length];
    buildings.push({ id: f.homeId, type: 'House', x: hx, y: hy, workers: [], active: true });
  });
  enforceSpacing(buildings, layout, water);

  const weather = weatherFor('Spring', seed, 1);
  const world: World = {
    id: `world-${seed.toString(36)}`, name: name?.trim() || defaultWorldName(seed), seed, biome: profile.kind, layout, day: 1, hour: 8, terrain, season: 'Spring',
    weather, weatherSeed: seed, treasury: 3000, population: count,
    temperature: temperatureAt({ biome: profile.kind, day: 1, hour: 8, weather }),
    deaths: 0, births: 0,
    amenities: buildAmenities(buildings, layout, water),
    bridgeWorks: null,
    connectedIslands: [],
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

/**
 * The settlement eats.
 *
 * This used to take food out of the store and give it to nobody: hunger was
 * only ever relieved by an individual buying at the market, so a child, or
 * anyone whose wages the treasury could not cover, starved beside a full
 * granary. That was invisible while hunger had no consequence. It is not
 * invisible now that people can die of it — measured at ten starvations in
 * forty days on a plot holding a hundred and forty units of food.
 *
 * The hungriest are served first, so a shortage thins everyone rather than
 * killing whoever happens to be last in the list, and adults pay the market
 * price for what they take. Handing the ration out free fixed the starving but
 * broke the economy: buying food was the settlement's main income, so with
 * everyone permanently full the treasury drained to nothing and stayed there —
 * measured at a desert bankrupt by day twenty and extinct by day two hundred.
 * Anyone who cannot pay still eats. A settlement feeds its own; it just does
 * not get the money back.
 */
function consume(world: World) {
  const queue = [...world.citizens].sort((a, b) => a.hunger - b.hunger);
  const larder: Resource[] = ['bread', 'wheat', 'vegetables'];
  let unfed = 0;

  for (const c of queue) {
    const portion = c.age < 16 ? 0.5 : 0.9;
    let wanted = portion;
    let eaten = 0;
    let bill = 0;
    for (const r of larder) {
      if (wanted <= 0) break;
      const take = Math.min(world.resources[r], wanted);
      if (take <= 0) continue;
      world.resources[r] -= take;
      note(world, 'consumed', r, take);
      wanted -= take;
      bill += take * world.market[r].price;
      // Bread goes further than raw grain, which is the point of the bakery.
      eaten += take * (r === 'bread' ? 1.15 : 1);
    }
    if (eaten <= 0) { unfed++; continue; }
    c.hunger = Math.min(100, c.hunger + (eaten / portion) * 26);
    if (c.age >= 16) {
      const paid = Math.min(c.wallet, bill);
      c.wallet -= paid;
      world.treasury += paid;
    }
  }

  if (unfed > 0) {
    pushFeed(world, 'market', unfed === world.citizens.length
      ? 'The stores are empty. Nobody ate today.'
      : `${unfed} ${unfed === 1 ? 'person' : 'people'} went without food today.`);
  }
}

/**
 * How fast a citizen ages, in years per game day.
 *
 * Deliberately decoupled from the weather year. Both rates want to be
 * watchable and they want very different numbers: a season should turn in
 * minutes, and a life should run its course in an evening rather than in a
 * hundred hours. Tying them together would mean either seasons nobody sees or
 * citizens nobody outlives. So a year of weather is twenty-four days and a year
 * of a life is two, and the interface never claims otherwise — it reports a
 * citizen's age and the world's season, never a shared calendar.
 */
export const YEARS_PER_DAY = 0.5;

const YOUNG_NAMES = ['Wren', 'Elm', 'Fen', 'Ash', 'Sage', 'Vale', 'Rook', 'Bly', 'Ivy', 'Corin', 'Lark', 'Nell', 'Tam', 'Pike', 'Marlow', 'Bram'];

/**
 * A day of living and dying.
 *
 * Citizens age, and past their lifespan the odds catch up with them. Hunger,
 * cold and having nowhere to sleep all shorten the odds, so a settlement that
 * cannot feed or house itself buries people — and a settlement that can does
 * not, which is the point of running the economy at all.
 */
function lifeAndDeath(world: World) {
  const rand = mulberry32(world.seed + world.day * 7919);
  const dead: Citizen[] = [];

  for (const c of world.citizens) {
    c.livedDays += 1;
    c.age += YEARS_PER_DAY;

    // Frailty rises steeply once someone is past their span, and hardship
    // brings it forward. Below sixty nobody dies of age alone.
    const overrun = c.age - c.lifespan;
    let risk = overrun >= 0 ? 0.04 + overrun * 0.03 : Math.max(0, (c.age - 55) / 900);
    if (c.hunger <= 4) risk += 0.16;
    else if (c.hunger < 18) risk += 0.05;
    if (c.warmth <= 6) risk += 0.14;
    else if (c.warmth < 22) risk += 0.04;
    if (c.roughSleeper) risk += 0.02;

    if (rand() < risk) dead.push(c);
  }

  for (const c of dead) {
    world.citizens = world.citizens.filter((x) => x.id !== c.id);
    for (const f of world.families) f.members = f.members.filter((id) => id !== c.id);
    // Their bonds go with them, or the friend list fills with the departed.
    for (const [key, bond] of Object.entries(world.bonds)) {
      if (bond.a === c.id || bond.b === c.id) delete world.bonds[key];
    }
    world.projects = world.projects.filter((p) => p.ownerId !== c.id);
    for (const a of world.amenities) a.users = a.users.filter((id) => id !== c.id);
    world.deaths += 1;
    const cause = c.hunger <= 4 ? 'went hungry'
      : c.warmth <= 6 ? (c.chilled ? 'could not keep warm' : 'could not escape the heat')
        : c.age >= c.lifespan ? `died at ${Math.floor(c.age)}, of old age`
          : `died at ${Math.floor(c.age)}`;
    pushFeed(world, 'social', c.age >= c.lifespan && c.hunger > 4 && c.warmth > 6
      ? `${c.name} ${cause}.`
      : `${c.name} ${cause}. The settlement is smaller today.`);
  }

  settlementBuilds(world);
  bridgeBuilding(world);
  formHouseholds(world, rand);
  births(world, rand);
  world.population = world.citizens.length;
}

/**
 * Reaching the far shore.
 *
 * A settlement hemmed in by water can only grow to the size of its own island.
 * This finds the biggest piece of land it cannot walk to, picks the narrowest
 * crossing to it, and spends wood and gold getting a deck across — over days,
 * visibly, with the feed reporting it. Once it stands, the far side joins the
 * road network and becomes ground the settlement and the player can build on.
 */
function bridgeBuilding(world: World) {
  const water = waterOf(world);
  const works = world.bridgeWorks;

  if (works) {
    // A day's work needs timber and wages. Short of either, the work waits.
    const timber = Math.min(6, world.resources.wood);
    if (timber < 4 || world.treasury < 40) {
      if (world.day % 3 === 0) pushFeed(world, 'build', 'Work on the bridge is held up for want of timber.');
      return;
    }
    world.resources.wood -= timber;
    note(world, 'consumed', 'wood', timber);
    world.treasury -= 40;
    works.progress += 1;
    if (works.progress < works.length) {
      if (works.progress === 1 || works.progress === Math.floor(works.length / 2)) {
        pushFeed(world, 'build', `The bridge is ${Math.round((works.progress / works.length) * 100)}% built.`);
      }
      return;
    }
    completeBridge(world, works);
    return;
  }

  // Only worth starting when there is somewhere worth reaching and the
  // settlement is comfortable enough to spare the timber.
  if (world.treasury < 900 || world.resources.wood < 45) return;
  const target = water.islands.find((i) =>
    i.id !== water.mainland && i.cells >= 40 && !world.connectedIslands.includes(i.id));
  if (!target) return;

  const crossing = narrowestCrossing(world, target.id);
  if (!crossing) return;

  world.bridgeWorks = {
    island: target.id,
    fromX: crossing.fromX, fromY: crossing.fromY,
    toX: crossing.toX, toY: crossing.toY,
    progress: 0,
    length: Math.max(3, Math.round(crossing.gap / 2.5)),
  };
  pushFeed(world, 'build', 'The settlement has begun a bridge to the far shore.');
}

/**
 * Where to cross to another island.
 *
 * Searched from the target's side, because the water field already knows the
 * distance from every point back to the mainland. The shortest gap alone is not
 * the answer: on a coast the narrowest point was a one-unit sliver at the very
 * edge of the map, and the deck built there landed on a strip too thin and too
 * far out to put anything on. So the span is weighed against how close the far
 * end is to the heart of the island and how far it is from the map's edge.
 */
function narrowestCrossing(world: World, island: number) {
  const water = waterOf(world);
  const centre = water.islands.find((i) => i.id === island);
  if (!centre) return null;

  let best: { fromX: number; fromY: number; toX: number; toY: number; gap: number } | null = null;
  let bestScore = Infinity;
  for (let y = 5; y < 96; y += 1.5) {
    for (let x = 5; x < 96; x += 1.5) {
      if (water.landAt(x, y) !== island) continue;
      // The far end has to be ground somebody could stand a building on. The
      // shortest gap is often a one-cell sliver at the edge of the map, and a
      // deck landing there reaches nowhere: the settlement spent a week's
      // timber on it and never put a single building across.
      if (water.distanceToWater(x, y) < 3.2) continue;
      const back = water.toMainland(x, y);
      if (back.d <= 1 || back.d >= 26) continue;
      const edge = Math.max(0, 12 - Math.min(x, y, 100 - x, 100 - y));
      const inland = Math.hypot(x - centre.x, y - centre.y);
      const score = back.d + edge * 1.4 + inland * 0.22;
      if (score >= bestScore) continue;
      bestScore = score;
      best = {
        toX: x,
        toY: y,
        gap: back.d,
        fromX: clamp(x + back.x * back.d, 2, 98),
        fromY: clamp(y + back.y * back.d, 4, 96),
      };
    }
  }
  return best;
}

/** Lay the deck, and wire the far side into the road network. */
function completeBridge(world: World, works: BridgeWorks) {
  const layout = world.layout;
  const angle = Math.atan2(works.toY - works.fromY, works.toX - works.fromX);
  const span = Math.hypot(works.toX - works.fromX, works.toY - works.fromY);
  layout.bridges.push({
    x: (works.fromX + works.toX) / 2,
    y: (works.fromY + works.toY) / 2,
    angle,
    span: span / 2 + BRIDGE_RAMP,
    deck: span / 2 + DECK_OVERHANG,
  });

  // Two new junctions, one either side, joined to each other and to whichever
  // existing junction is nearest the near bank.
  const addNode = (x: number, y: number): number => {
    layout.nodes.push([clamp(x, 3, 97), clamp(y, 4, 96)]);
    layout.roles.push('street');
    layout.edges.push([]);
    return layout.nodes.length - 1;
  };
  const link = (a: number, b: number) => {
    if (!layout.edges[a].includes(b)) layout.edges[a].push(b);
    if (!layout.edges[b].includes(a)) layout.edges[b].push(a);
  };

  const step = 1.6;
  const near = addNode(works.fromX - Math.cos(angle) * step, works.fromY - Math.sin(angle) * step);
  const far = addNode(works.toX + Math.cos(angle) * step, works.toY + Math.sin(angle) * step);
  // The road on the far side heads for the middle of the island, not straight
  // on along the line of the bridge — which, at the edge of the map, walks off
  // it. Stop as soon as the ground stops being the island's.
  const water = waterOf(world);
  const centre = water.islands.find((i) => i.id === works.island);
  const heading = centre
    ? Math.atan2(centre.y - works.toY, centre.x - works.toX)
    : angle;
  let reach = 4;
  for (let probe = 5; probe <= 14; probe += 1.5) {
    const px = works.toX + Math.cos(heading) * probe;
    const py = works.toY + Math.sin(heading) * probe;
    if (px < 6 || px > 94 || py < 8 || py > 92) break;
    if (water.landAt(px, py) !== works.island) break;
    reach = probe;
  }
  const inland = addNode(works.toX + Math.cos(heading) * reach, works.toY + Math.sin(heading) * reach);
  link(near, far);
  link(far, inland);
  layout.roles[inland] = 'work';

  // Join the near bank to the settlement it came from.
  let anchor = 0, anchorD = Infinity;
  for (let i = 0; i < layout.nodes.length - 3; i++) {
    const d = (layout.nodes[i][0] - works.fromX) ** 2 + (layout.nodes[i][1] - works.fromY) ** 2;
    if (d < anchorD) { anchorD = d; anchor = i; }
  }
  link(anchor, near);

  layout.wanderSpots.push(layout.nodes[far], layout.nodes[inland]);

  // Plots on the far shore, found by searching it rather than by guessing.
  //
  // Offsetting a fixed distance either side of the new road produced nothing at
  // all: these islands are narrow strips, so a plot five units off the
  // carriageway is usually in the water. Scanning the island for ground that
  // actually has room around it always finds the spots that exist, and finds
  // none when there are none.
  const spacing = 7;
  const found: [number, number][] = [];
  for (const clearance of [4.4, 3.6]) {
    for (let py = 9; py <= 91 && found.length < 4; py += 2) {
      for (let px = 7; px <= 93 && found.length < 4; px += 2) {
        if (water.landAt(px, py) !== works.island) continue;
        if (water.distanceToWater(px, py) < clearance) continue;
        if (found.some(([qx, qy]) => (qx - px) ** 2 + (qy - py) ** 2 < spacing * spacing)) continue;
        found.push([px, py]);
      }
    }
    if (found.length) break;
  }
  for (const plot of found) {
    layout.housePlots.push(plot);
    layout.workSites.push(plot);
  }

  world.connectedIslands.push(works.island);
  world.bridgeWorks = null;
  world.unlockedAreas.push('The Far Shore');
  pushFeed(world, 'build', 'The bridge is finished. The far shore is open.');
}

/** What a settlement pays to raise a building for itself. Mirrors the build menu. */
const SELF_BUILD_COST: Record<string, number> = { House: 100, Woodcutter: 125, Farm: 150 };
const TRADE_BUILD_COST: Record<string, number> = {
  Quarry: 175, Mine: 250, Mill: 250, Bakery: 300, Carpenter: 275, Blacksmith: 400, Tailor: 325,
};

/**
 * The settlement builds for itself.
 *
 * Housing is the ceiling on population — a household needs somewhere to live —
 * and without this the ceiling never moved: a desert opened with three houses,
 * grew to exactly sixteen people, and then shrank, while a grassland that could
 * not spend its income piled up thirty-five thousand gold doing nothing.
 *
 * The settlement now spends on what it is short of: a roof when people have
 * nowhere to live, a woodcutter when the hearths are going cold, a farm when
 * the stores are thin. It builds only from a comfortable surplus, so a
 * settlement in trouble spends its gold on wages instead.
 */
function settlementBuilds(world: World) {
  const houses = world.buildings.filter((b) => b.type === 'House' && b.active).length;
  const homeless = world.citizens.filter((c) => c.age >= 16 && !homeOf(world, c)).length;
  const crowded = world.citizens.length > houses * 3.4;

  let want: string | null = null;
  if (homeless > 0 || crowded) want = 'House';
  else if (world.resources.wood < 22 && !world.buildings.some((b) => b.type === 'Woodcutter')) want = 'Woodcutter';
  else if (world.resources.wheat + world.resources.bread < world.citizens.length * 2.5) want = 'Farm';
  else if (world.treasury > 4000) {
    // A settlement with money it does not need takes up a trade its land
    // supports and it has not opened yet. Otherwise the gold simply piles up:
    // a grassland reached thirty-five thousand and never spent a coin of it.
    want = biomeProfile(world.biome).trades
      .find((type) => !world.buildings.some((b) => b.type === type)) ?? null;
  }
  if (!want) return;

  const cost = SELF_BUILD_COST[want] ?? TRADE_BUILD_COST[want] ?? 250;
  // Three times over, and a fortnight of running costs left standing.
  //
  // The cost multiple alone was not a brake: a desert kept raising houses it
  // could not staff, and every one of them added upkeep and wages until it
  // could not meet payroll on a hundred and thirty-seven days out of two
  // hundred. A settlement that cannot pay its people should not be building.
  const payroll = world.citizens
    .filter((c) => c.age >= 16 && c.job !== 'unemployed')
    .reduce((sum, c) => sum + jobs[c.job as WorkingJob].wage, 0);
  const upkeep = world.buildings.filter((b) => b.active).reduce((sum, b) => sum + maintenanceCost(b.type), 0);
  if (world.treasury < cost * 3 || world.treasury < (payroll + upkeep) * 14) return;

  const site = freeSite(world, want === 'House');
  if (!site) return;

  world.treasury -= cost;
  world.buildings.push({ id: `b${world.counter++}`, type: want, x: site[0], y: site[1], workers: [], active: true });
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  pushFeed(world, 'build', want === 'House'
    ? 'The settlement raised another house.'
    : `The settlement built a ${want.toLowerCase()}.`);
}

/** A legal, empty plot from the settlement's own plan. */
function freeSite(world: World, housing: boolean): [number, number] | null {
  const water = waterOf(world);
  const plots = housing ? world.layout.housePlots : world.layout.workSites;
  const radius = housing ? 2.6 : 3.2;
  // Land the settlement crossed water to reach comes first. Otherwise the
  // search always finds a plot at home before it gets to the far shore, and a
  // bridge that cost the town its timber and a week's gold is never used for
  // anything — measured at nought buildings across it after a hundred and fifty
  // days.
  const all: [number, number][] = [...plots, ...world.layout.wanderSpots];
  const candidates = world.connectedIslands.length === 0 ? all : [
    ...all.filter(([x, y]) => world.connectedIslands.includes(water.landAt(x, y))),
    ...all.filter(([x, y]) => !world.connectedIslands.includes(water.landAt(x, y))),
  ];
  for (const [x, y] of candidates) {
    if (water.distanceToWater(x, y) < radius + 1.5) continue;
    if (x < 7 || x > 93 || y < 9 || y > 91) continue;
    // The far shore counts as buildable once a bridge reaches it. That is the
    // point of having built one.
    const on = water.landAt(x, y);
    if (on !== water.mainland && !world.connectedIslands.includes(on)) continue;
    let clear = true;
    for (const b of world.buildings) {
      const gap = radius + footprintRadius(b) + 0.8;
      if ((b.x - x) ** 2 + (b.y - y) ** 2 < gap * gap) { clear = false; break; }
    }
    if (!clear) continue;
    // And not on the road, which is what the relaxation guarantees at creation.
    let onRoad = false;
    for (let u = 0; u < world.layout.nodes.length && !onRoad; u++) {
      for (const v of world.layout.edges[u]) {
        if (v < u) continue;
        const [ax, ay] = world.layout.nodes[u];
        const [bx, by] = world.layout.nodes[v];
        const ex = bx - ax, ey = by - ay;
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / len2, 0, 1) : 0;
        if (Math.hypot(x - (ax + ex * t), y - (ay + ey * t)) < radius + 1) { onRoad = true; break; }
      }
    }
    if (onRoad) continue;
    return [x, y];
  }
  return null;
}

/**
 * New households.
 *
 * Without this, aging is a one-way trip to extinction and the numbers say so:
 * over a hundred and twenty days the binding constraint on births was a family
 * having two adults of an age to raise a child, and it bound on four hundred
 * and twenty-seven of them. Children only ever joined the family they were born
 * into, so when a household's last adult died the house stood empty for good —
 * two of five families were extinct within four months while the treasury grew.
 *
 * So adults pair off and move out, the way people do. A pair who are already
 * friends go first, because the settlement already tracks who knows whom and it
 * costs nothing to let that decide. An empty house — or one the player just
 * built — is what they move into.
 */
function formHouseholds(world: World, rand: () => number) {
  const livingIn = (familyId: string) => world.citizens.filter((c) => c.familyId === familyId);
  const vacant = world.buildings.filter((b) => {
    if (b.type !== 'House' || !b.active) return false;
    const owner = world.families.find((f) => f.homeId === b.id);
    return !owner || livingIn(owner.id).length === 0;
  });
  if (!vacant.length) return;

  // Someone free to move: an adult of an age to start a household whose leaving
  // does not strip their old home of its own pair.
  const eligible = world.citizens.filter((c) => {
    if (c.age < 18 || c.age > 40) return false;
    const kin = livingIn(c.familyId).filter((k) => k.age >= 18 && k.age <= 44);
    return kin.length >= 3;
  });
  if (eligible.length < 2) return;

  let best: [Citizen, Citizen] | null = null;
  let bestScore = -1;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i], b = eligible[j];
      if (a.familyId === b.familyId && livingIn(a.familyId).length < 4) continue;
      const bond = world.bonds[bondKey(a.id, b.id)];
      // Friends first, then anyone: a settlement of strangers still has to go on.
      const score = (bond ? bond.strength : 0) + (bond?.friends ? 60 : 0) + rand() * 8;
      if (score > bestScore) { bestScore = score; best = [a, b]; }
    }
  }
  if (!best) return;

  const home = vacant[0];
  const [a, b] = best;
  const surname = familyNames[world.families.length % familyNames.length];
  const family: Family = {
    id: `f${world.counter++}`,
    name: surname,
    homeId: home.id,
    members: [a.id, b.id],
    wealth: a.wallet + b.wallet,
  };
  for (const person of [a, b]) {
    const old = world.families.find((f) => f.id === person.familyId);
    if (old) old.members = old.members.filter((id) => id !== person.id);
    person.familyId = family.id;
  }
  world.families.push(family);
  pushFeed(world, 'social', `${a.name} and ${b.name} have set up a household together.`);
}

/**
 * New people.
 *
 * A household with a home, two adults of an age to raise a child, food in the
 * store and reasonable spirits has one. Without this, aging is just a slow
 * extinction — the settlement would empty out and nothing would replace it.
 */
function births(world: World, rand: () => number) {
  const housed = world.buildings.filter((b) => b.type === 'House').length;
  // Room to grow, food to do it on, and not a settlement already starving.
  if (world.citizens.length >= housed * 4 + 4) return;
  if (world.resources.bread + world.resources.wheat + world.resources.vegetables < world.citizens.length * 2) return;

  for (const family of world.families) {
    const members = family.members
      .map((id) => world.citizens.find((c) => c.id === id))
      .filter((c): c is Citizen => !!c);
    const parents = members.filter((c) => c.age >= 19 && c.age <= 46 && c.happiness > 50);
    const children = members.filter((c) => c.age < 16);
    if (parents.length < 2 || children.length >= 3) continue;
    if (!world.buildings.some((b) => b.id === family.homeId)) continue;
    if (rand() > 0.16) continue;

    const hash = world.counter * 37 + 11;
    const name = YOUNG_NAMES[Math.floor(rand() * YOUNG_NAMES.length)];
    const parent = parents[0];
    const child: Citizen = {
      id: `c${world.counter++}`,
      name,
      handle: `@${name.toLowerCase()}${(hash % 90) + 10}`,
      familyId: family.id,
      age: 0,
      job: 'unemployed',
      hash,
      hunger: 88, rest: 92, social: 80, clothing: 84, purpose: 60,
      happiness: 84, wage: 0, wallet: 0,
      x: parent.x, y: parent.y, destX: parent.x, destY: parent.y,
      path: [], dwell: 0, wanderIdx: hash % 17, errand: false,
      phase: 'wandering', activity: 'idle', facing: 's', moving: false, inside: false,
      stalled: 0, bestAway: Infinity, roughSleeper: false,
      look: Math.floor(rand() * 0xffffff),
      livedDays: 0, lifespan: lifespanFor(rand()), warmth: 88, seated: false, chilled: true, sheltering: false,
    };
    world.citizens.push(child);
    family.members.push(child.id);
    world.births += 1;
    pushFeed(world, 'social', `${parent.name}'s family welcomed ${name}.`);
    // Every household gets its own chance, rather than the settlement getting
    // one between them. Deaths scale with the population; a single birth a day
    // for the whole settlement could never keep pace with them, and every world
    // ran slowly and silently extinct.
  }
}

export function maintenanceCost(type: string) {
  return ({ Bank: 0, Market: 15, Storage: 3, House: 1, Farm: 3, Woodcutter: 2, Quarry: 4, Mine: 6, Mill: 5, Bakery: 6, Carpenter: 5, Blacksmith: 8, Tailor: 6, Tavern: 7, 'Town Hall': 10 } as Record<string, number>)[type] ?? 2;
}

/**
 * Firewood.
 *
 * A cold day costs the settlement wood, and a settlement that runs out of it
 * spends the night cold. This is what gives winter and the desert night a price
 * rather than a colour: the woodcutters matter most exactly when the trees are
 * hardest to work.
 */
function heatTheHomes(world: World) {
  // How much heating the day called for, from the coldest part of it.
  const dawn = temperatureAt({ biome: world.biome, day: world.day, hour: 5, weather: world.weather });
  if (dawn > 12) return;
  const households = world.buildings.filter((b) => b.type === 'House' && b.active).length;
  const need = Math.round((12 - dawn) * 0.22 * Math.max(1, households) * 0.5);
  if (need <= 0) return;
  const burned = Math.min(need, Math.floor(world.resources.wood));
  world.resources.wood -= burned;
  note(world, 'consumed', 'wood', burned);
  if (burned < need) {
    pushFeed(world, 'weather', burned <= 0
      ? 'There is no firewood left. The hearths went cold.'
      : `Firewood ran short in the cold — only ${burned} of ${need} loads to burn.`);
  } else if (need >= 8) {
    pushFeed(world, 'weather', `A cold day. ${burned} loads of firewood went on the hearths.`);
  }
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
    const need = Math.min(c.hunger, c.rest, c.social, c.clothing, c.purpose, c.warmth);
    // Order matters: the capacity check reads the recipe for the citizen's
    // current job, and 'unemployed' has no recipe. Before citizens could be
    // born, everyone over sixteen already had a trade and this never came up;
    // the first child to have a birthday in-world crashed the settlement.
    const current: WorkingJob | null = c.job === 'unemployed' ? null : c.job;
    const overCapacity = current !== null
      && (tally[current] ?? 0) >= Math.max(1, jobCapacity(world, current));
    let jobKey: WorkingJob = current ?? chooseJob(world, tally);
    if (need < 35 || overCapacity) jobKey = chooseJob(world, tally);
    if (c.job === 'unemployed') {
      pushFeed(world, 'work', `${c.name} is old enough to work, and took up ${JOB_LABELS[jobKey].toLowerCase()}.`);
    }
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

  heatTheHomes(world);
  produce(world);
  consume(world);
  lifeAndDeath(world);
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
  world.temperature = temperatureAt(world);
  updateBuildingWorkers(world);
  socialStep(world, hours);

  // What the air is doing to a person standing in it. Indoors and beside a fire
  // are both shelter; clothing is the difference between the rest.
  const air = world.temperature;
  const warm = world.resources.wood > 0;
  for (const c of world.citizens) {
    c.rest = Math.max(0, c.rest - hours * (world.weather === 'Storm' ? 2.3 : 2));
    c.social = Math.max(0, c.social - hours * .35);
    c.hunger = Math.max(0, c.hunger - hours * .75);
    if (c.activity === 'eating') c.hunger = Math.min(100, c.hunger + hours * 1.4);
    if (c.activity === 'resting') c.rest = Math.min(100, c.rest + hours * (c.roughSleeper ? 0.45 : 1.1));

    const byFire = c.usingId !== undefined
      && world.amenities.some((a) => a.id === c.usingId && a.kind === 'campfire');
    // Four walls stop the drain; a fire in them is what actually warms you.
    //
    // Shelter used to require firewood in the store, which made running out of
    // it instantly fatal for the whole settlement at once: nobody anywhere
    // counted as sheltered, so everyone froze together. Forty-seven of a
    // valley's fifty-eight deaths over two hundred days were that, at a mean
    // age of forty-one. A cold house should be uncomfortable, not lethal.
    const heated = byFire || (c.inside && warm);
    const sheltered = heated || c.inside;
    // Comfortable between about twelve and twenty-six degrees; outside that,
    // clothing and shelter decide how fast it tells.
    const chill = air < 12 ? (12 - air) : air > 26 ? (air - 26) * 0.7 : 0;
    if (chill > 0) c.chilled = air < 12;
    if (chill <= 0 || sheltered) {
      c.warmth = Math.min(100, c.warmth + hours * (heated ? 9 : chill <= 0 ? 5 : 1.5));
    } else {
      // Clothing is most of the difference, and shelter overnight makes good
      // the day. A working day outdoors in a hard winter should cost a
      // well-dressed citizen something and cost a rough sleeper a great deal;
      // at four-tenths per degree it cost everyone everything.
      const insulation = 0.45 + (c.clothing / 100) * 0.55;
      c.warmth = Math.max(0, c.warmth - hours * chill * 0.07 / insulation * (c.roughSleeper ? 1.6 : 1));
    }

    c.happiness = clamp((c.hunger + c.rest + c.social + c.clothing + c.purpose + c.warmth) / 6, 0, 100);
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
  if (waterOf(world).blocks(x, y)) return null;
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

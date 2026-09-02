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
  /**
   * What came of it, once it has finished. A gathering used to be a place
   * people walked to and nothing more: the meeting decided nothing, the
   * showcase showed nothing, and market day traded exactly like a Tuesday.
   * This is set when the last hour runs out, and only once.
   */
  outcome?: string;
}

/**
 * What a town meeting decided, and how long the decision stands.
 *
 * The settlement builds what it is short of, and left to itself it always
 * reads that shortage the same way. A resolution is the town's own answer to
 * the same question, taken in front of everybody, and it outranks the default
 * for as long as it holds — so a meeting is a thing that changes what gets
 * built rather than a crowd standing in a tavern.
 */
export interface Resolution {
  /** What was resolved, in the words the feed and the panel use. */
  text: string;
  /** The building the town wants raised, if the resolution names one. */
  want: string | null;
  /** The day it was taken. It stands for three days. */
  day: number;
  /** How many were in the room. */
  voters: number;
}

/** A work made at a showcase, kept so the settlement has a body of work. */
export interface Artwork { id: string; title: string; maker: string; day: number; subject: string }

export type HazardKind = 'fire' | 'blight' | 'wolves' | 'flood';

/**
 * Something going wrong.
 *
 * A settlement with no way to fail is a diorama. These are drawn from the
 * world's own state rather than a die roll against nothing: a fire starts in
 * dry heat and takes hold when there is no water nearby, blight comes to a
 * town living hand to mouth off its own fields, wolves come out of a hard
 * winter to a settlement with no fires burning, and a flood follows a storm on
 * a river. Each has a defence the player can actually build, each is announced
 * in the feed with what it cost, and none of them can kill a prepared town.
 */
export interface Hazard {
  id: string;
  kind: HazardKind;
  /** What it is, in a heading. */
  label: string;
  /** What it is doing, in a sentence the panel can print. */
  effect: string;
  day: number;
  /** Days left to run. */
  days: number;
  /** A building it has taken out of use, restored when it passes. */
  buildingId?: string;
}

/**
 * What two people are to each other.
 *
 * Strength runs from -100 to 100, and it is a memory rather than a running
 * total. Friendship used to fade at better than a point a day and be forgotten
 * outright at zero, so a settlement's oldest friends quietly became strangers
 * over a fortnight of not happening to stand near each other. Now a friendship,
 * once made, decays slowly and never falls below the floor that made it: people
 * remember who their friends are.
 *
 * The negative half is new. Not everyone gets on: two people whose tempers run
 * opposite ways grate on each other every time they meet, and a bond deep in
 * the negative is a grudge, which is remembered exactly as stubbornly.
 */
export interface Bond {
  a: string;
  b: string;
  strength: number;
  friends: boolean;
  /** True once the bond has soured past the point of ordinary dislike. */
  rivals: boolean;
  /** The day they first stood together, so the panel can say how long. */
  met: number;
  /** How many times they have come to blows. */
  fights: number;
}

/**
 * Two people talking to each other.
 *
 * Citizens have always had something to say — a line drawn from what they are
 * doing, the hour and the weather — but they said it into the air, and two of
 * them standing together said two unrelated things at once. A conversation is
 * a real exchange held in the simulation: an opening, a reply, an answer and a
 * closing, all on one subject that both of them have a reason to raise, with
 * the turns taken in order. The renderer shows whichever line is being spoken
 * now, so a bubble is an utterance rather than a mood.
 */
export interface Conversation {
  id: string;
  /** The two of them, in the order they speak. */
  a: string;
  b: string;
  /** What it is about, for the inspector and the feed. */
  topic: string;
  /** The exchange, alternating a, b, a, b. */
  lines: string[];
  /** Which line is being spoken, and how long it has been up. */
  index: number;
  held: number;
}
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
  /**
   * The last gathering this person was called to, so the bell rings once.
   * Without it, someone settled at a fire before the meeting was called never
   * re-picks a destination and never goes.
   */
  calledTo?: string;
  /** Held by the player right now: they go where the pointer goes. */
  carried?: boolean;
  /**
   * Swimming back to shore after being set down in the water.
   *
   * Somebody dropped in a river should not stand on it, and should not vanish
   * either. They swim — slowly, in a straight line for the nearest dry ground —
   * and are cold and unhappy about it when they get there.
   */
  swimming?: boolean;
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
  /** Conversations happening right now. */
  conversations: Conversation[];
  /** Whatever is currently going wrong. */
  hazards: Hazard[];
  /** The standing decision of the last town meeting, if it is still in force. */
  resolution: Resolution | null;
  /** Everything the settlement's showcases have produced, newest first. */
  artworks: Artwork[];
  unlockedAreas: string[];
  /** Accumulates game hours so the market trades on the clock, not per frame. */
  marketClock: number;
  /**
   * What actually moved yesterday, per resource. The renderer fells exactly as
   * many trees as the woodcutters really cut, and the market panel shows real
   * throughput rather than a guess from stock levels.
   */
  flow: { produced: Partial<Record<Resource, number>>; consumed: Partial<Record<Resource, number>> };
  /**
   * Where the settlement's Gold came from and went, today and on the last full
   * day. Every movement in or out of the treasury is booked against a heading,
   * so the player can read a day's trading rather than watch one number drift.
   */
  ledger: DayLedger;
  ledgerYesterday: DayLedger;
  /**
   * What the player has earned by looking after this place, and why.
   *
   * Gold is the settlement's own money and always was; what changed is that it
   * is no longer a tap into the token. A world left alone used to pile up gold
   * at up to three hundred and sixty a day, every coin of it withdrawable — an
   * untouched grassland made eighty million $EMERGE in sixty game days. That is
   * not a game, it is a faucet, and it would have buried the token in sell
   * pressure from people who never opened the tab.
   *
   * So $EMERGE is now minted only against stewardship: how well the settlement
   * is actually run, times how recently the player did anything about it, times
   * a hard daily ceiling.
   */
  stewardship: Stewardship;
  counter: number;
}

/** The day the player last did something here, and what it is worth. */
export interface Stewardship {
  /**
   * How well the place is run, 0 to 1: housed, fed, employed, content and safe,
   * weighted and then squared, so a mediocre settlement earns markedly less
   * than a good one rather than slightly less.
   */
  score: number;
  /**
   * How recently the player intervened, 1 down to ATTENTION_FLOOR. This is the
   * term that makes an idle world nearly worthless to farm.
   */
  attention: number;
  /** The last day a player action touched this world. */
  lastActionDay: number;
  /** $EMERGE earned yesterday. */
  dailyYield: number;
  /** $EMERGE earned and not yet collected by the client. */
  pending: number;
  /** $EMERGE this world has earned in total, for the panel. */
  lifetime: number;
}

/** The headings a day's Gold is booked under. */
export type LedgerLine =
  | 'wages' | 'upkeep' | 'imports' | 'building' | 'works'
  | 'exports' | 'households' | 'food' | 'vault';

export const LEDGER_LABELS: Record<LedgerLine, string> = {
  wages: 'Wages',
  upkeep: 'Upkeep',
  imports: 'Imports',
  building: 'Building',
  works: 'Public works',
  exports: 'Exports',
  households: 'Household spending',
  food: 'Food sales',
  vault: 'Vault',
};

export interface DayLedger {
  in: Partial<Record<LedgerLine, number>>;
  out: Partial<Record<LedgerLine, number>>;
}

const emptyLedger = (): DayLedger => ({ in: {}, out: {} });

/**
 * Gold into the treasury, booked under a heading.
 *
 * Every treasury movement goes through `earn` or `spend`, and a day's headings
 * add up to exactly the day's change in the treasury — which is checkable, and
 * is checked: an unbooked movement would show as a discrepancy rather than
 * quietly making the ledger a decoration.
 */
function earn(world: World, line: LedgerLine, amount: number) {
  if (!(amount > 0)) return 0;
  world.treasury += amount;
  world.ledger.in[line] = (world.ledger.in[line] ?? 0) + amount;
  return amount;
}

/** Gold out, booked under a heading. Never spends past empty; returns what moved. */
function spend(world: World, line: LedgerLine, amount: number) {
  if (!(amount > 0)) return 0;
  const paid = Math.min(amount, world.treasury);
  world.treasury -= paid;
  world.ledger.out[line] = (world.ledger.out[line] ?? 0) + paid;
  return paid;
}

/** What a day's headings add up to, in and out. */
export function ledgerTotals(ledger: DayLedger) {
  const sum = (side: Partial<Record<LedgerLine, number>>) =>
    Object.values(side).reduce((t: number, v) => t + (v ?? 0), 0);
  return { earned: sum(ledger.in), spent: sum(ledger.out) };
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
    // Held by the player, or swimming for the bank: both are handled elsewhere
    // and every rule below is about walking on land.
    if (c.carried || c.swimming) continue;
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

/** The bond between two people, created on first meeting. */
function bondBetween(world: World, a: Citizen, b: Citizen): Bond {
  const key = bondKey(a.id, b.id);
  return world.bonds[key] ?? (world.bonds[key] = {
    a: a.id, b: b.id, strength: 0, friends: false, rivals: false, met: world.day, fights: 0,
  });
}

/** How these two feel about each other right now, whether or not they have met. */
export function bondOf(world: World, a: string, b: string): Bond | undefined {
  return world.bonds[bondKey(a, b)];
}

/**
 * Friendships form from actual co-presence: two adults socialising in the same
 * venue build a bond, and crossing the threshold is a real, reportable event.
 */
function socialStep(world: World, hours: number) {
  // Phase, not activity: `activity` only reads 'trading' inside the third of a
  // unit that counts as having arrived, and arriving at a building puts the
  // person inside it. Testing it meant a settlement of twenty-five built four
  // acquaintanceships in forty days and nobody ever fell out with anybody.
  const mingling = world.citizens.filter((c) => outAndAbout(c));
  for (let i = 0; i < mingling.length; i++) {
    for (let j = i + 1; j < mingling.length; j++) {
      const a = mingling[i], b = mingling[j];
      // Co-presence means standing together, not merely sharing a roof. Everyone
      // in the settlement passes through the tavern; only neighbours in the
      // crowd actually get to know each other.
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4.5) continue;
      const bond = bondBetween(world, a, b);
      // Time together deepens whatever is already there. For a pair who do not
      // get on, that is the point: more of each other makes it worse.
      const drift = hours * 3.2 * chemistry(a, b);
      bond.strength = clamp(bond.strength + drift, -100, 100);
      // Only good company is company. Being stuck next to somebody you cannot
      // stand does not meet anybody's need for society.
      const social = drift > 0 ? hours * 3 : hours * -1.2;
      a.social = clamp(a.social + social, 0, 100);
      b.social = clamp(b.social + social, 0, 100);
      if (!bond.friends && bond.strength >= 78) {
        bond.friends = true;
        pushFeed(world, 'social', `${a.name} and ${b.name} are now good friends.`);
      }
      if (!bond.rivals && bond.strength <= -55) {
        bond.rivals = true;
        pushFeed(world, 'social', `${a.name} and ${b.name} have fallen out badly.`);
      }
    }
  }
}

/**
 * How long one line of an exchange stays up, in game hours.
 *
 * Long enough to read at the ordinary clock and not so long that a four-line
 * conversation outlasts the evening. At the default speed this is a little
 * under three seconds a line.
 */
const LINE_HOLD = 0.42;

/**
 * How close two people stand to be talking rather than merely near each other.
 *
 * A shade over the four units a crowd spreads itself around a venue, so two
 * people at the same gathering can be in earshot without everybody in the
 * square counting as one conversation.
 */
const TALKING_RANGE = 4.6;

/**
 * Whether somebody is out and about with time to talk.
 *
 * The phase, not the activity. `activity` only reads 'trading' inside the
 * third of a unit that counts as having arrived, and arriving at a building
 * puts the person inside it — so across four game days in three biomes the
 * number of citizens who were both outdoors and 'trading' averaged one in ten.
 * Nobody ever met anybody. Phase is what the person is doing with their
 * afternoon, which is the thing that decides whether they will stop and speak.
 */
function outAndAbout(c: Citizen) {
  return c.age >= 16 && !c.inside && (c.phase === 'socialising' || c.phase === 'eating' || c.phase === 'wandering');
}

/**
 * What these two have to talk about.
 *
 * Read from the world they are both standing in, in order of how immediate it
 * is: the weather on their skin, then the day's news, then the work they share,
 * then each other. Every branch returns a full exchange — an opening, a reply,
 * an answer and a closing — so a conversation is on one subject from start to
 * finish rather than four unrelated lines taking turns.
 */
function conversationFor(world: World, a: Citizen, b: Citizen): { topic: string; lines: string[] } {
  const shared = a.job !== 'unemployed' && a.job === b.job;
  const friends = world.bonds[bondKey(a.id, b.id)]?.friends ?? false;
  const art = world.artworks[0];

  // People who cannot stand each other are not making small talk.
  const bond = bondOf(world, a.id, b.id);
  if (bond && bond.strength <= -40) {
    return {
      topic: bond.fights > 0 ? 'what happened last time' : 'an old grievance',
      lines: bond.fights > 0
        ? [
          'You have a nerve, showing your face.',
          'It is a small settlement. I go where I like.',
          'Not where I am, you do not.',
          'Then move.',
        ]
        : [
          'I heard what you said about the yard.',
          'I said what everybody is thinking.',
          'Say it to me next time, then.',
          'I just did.',
        ],
    };
  }

  // Urgent business first, because these are things happening to the two of
  // them right now and nobody talks about the price of wool in a blizzard.
  if (world.weather === 'Storm' || world.weather === 'Snow') {
    return {
      topic: 'the weather',
      lines: [
        world.weather === 'Snow' ? 'Cold enough to see your breath out here.' : 'That wind is getting up.',
        world.weather === 'Snow' ? 'Second fall this season. Earlier than last year.' : 'It will be through here by dark.',
        'Have you enough firewood put by?',
        'Enough for a week. Come round if you run short.',
      ],
    };
  }

  if (a.hunger < 32 || b.hunger < 32) {
    return {
      topic: 'the stores',
      lines: [
        'Have you eaten today?',
        world.resources.bread > 4 ? 'There was bread at the market this morning.' : 'The stores were bare when I looked.',
        world.resources.bread > 4 ? 'I will go down before it goes.' : 'Somebody ought to say something at the meeting.',
        'I will walk with you.',
      ],
    };
  }

  // Everything else is small talk, and small talk is a choice among the things
  // both of them could reasonably raise — not a fixed order. Running it as a
  // priority chain made the last town meeting the subject of four
  // conversations in five, for the three days a resolution stands.
  const options: { topic: string; lines: string[] }[] = [];

  if (world.resolution && world.day - world.resolution.day <= 1) {
    options.push({
      topic: 'the meeting',
      lines: [
        `They resolved ${world.resolution.text}.`,
        `${world.resolution.voters} in the room, I heard.`,
        'About time somebody decided it.',
        'We will see if it comes to anything.',
      ],
    });
  }

  if (art && world.day - art.day <= 2) {
    options.push({
      topic: 'the showcase',
      lines: [
        `Did you see ${art.maker}'s piece? “${art.title}”.`,
        'I stood in front of it a good while.',
        'It is the light on it that gets me.',
        'They should show another.',
      ],
    });
  }

  if (shared) {
    options.push({
      topic: `the ${JOB_LABELS[a.job].toLowerCase()}'s work`,
      lines: [
        'How did you get on today?',
        'Slow start, then it came right after noon.',
        'Same. My hands are finished.',
        'Tomorrow, then.',
      ],
    });
    options.push({
      topic: `the ${JOB_LABELS[a.job].toLowerCase()}'s work`,
      lines: [
        'Are you on the same run as me tomorrow?',
        'If the weather holds I will be.',
        'Two of us would halve it.',
        'Then two of us it is.',
      ],
    });
  }

  if (friends) {
    options.push({
      topic: 'each other',
      lines: [
        `Good to see you, ${b.name}.`,
        'And you. It has been days.',
        'Come by the house this week.',
        'I will bring something.',
      ],
    });
  }

  const babies = world.citizens.filter((c) => c.age < 3).length;
  if (babies > 0) {
    options.push({
      topic: 'the children',
      lines: [
        babies === 1 ? 'There is a new one in the settlement.' : `${babies} little ones about the place now.`,
        'They will need somewhere to live before long.',
        'They always do. We managed.',
        'We did at that.',
      ],
    });
  }

  const site = world.projects[0];
  if (site) {
    options.push({
      topic: site.name,
      lines: [
        `Have you seen how far along ${site.name.toLowerCase()} is?`,
        'I walked past this morning. Further than I expected.',
        'It will change this end of town.',
        'For the better, I hope.',
      ],
    });
  }

  options.push({
    topic: world.name,
    lines: [
      `${JOB_LABELS[a.job]}, is it? I do not think we have spoken.`,
      `${b.name}. I am mostly down the other end of ${world.name}.`,
      'Long enough here to know the shortcuts, then.',
      'Ask me any time.',
    ],
  });

  // The weather as a thing you can say out loud. Dropping `weather` straight
  // into a sentence gives you "and the cloudy with it".
  const skies: Record<Weather, string> = {
    Clear: 'these bright mornings',
    Cloudy: 'this flat grey light',
    Rain: 'all this rain',
    Storm: 'the wind that comes with it',
    Fog: 'the fog off the water',
    Snow: 'the snow on top of it',
  };
  options.push({
    topic: 'the season',
    lines: [
      `${world.season} always comes round faster than I expect.`,
      `It does. And ${skies[world.weather]}.`,
      'Still, it is a good place to be in it.',
      'It is.',
    ],
  });

  return options[(a.hash + b.hash + world.day) % options.length];
}

/**
 * Start conversations, run the ones already going, and end them.
 *
 * A pair talks when they are both out socialising, standing within a few
 * paces, and neither is already in an exchange. The talking itself is worth
 * more than passing co-presence — people who have actually spoken get on
 * faster than people who merely stood in the same room — so this is the thing
 * that builds friendships, not proximity alone.
 */
function converse(world: World, hours: number) {
  const busy = new Set<string>();
  for (const talk of world.conversations) { busy.add(talk.a); busy.add(talk.b); }

  // Run and retire the exchanges already going.
  for (let i = world.conversations.length - 1; i >= 0; i--) {
    const talk = world.conversations[i];
    const a = world.citizens.find((c) => c.id === talk.a);
    const b = world.citizens.find((c) => c.id === talk.b);
    // Someone walked off, went inside or died: the conversation is over, which
    // is what happens to conversations.
    if (!a || !b || a.inside || b.inside || Math.hypot(a.x - b.x, a.y - b.y) > TALKING_RANGE + 2.5) {
      world.conversations.splice(i, 1);
      continue;
    }
    talk.held += hours;
    if (talk.held >= LINE_HOLD) {
      talk.held = 0;
      talk.index++;
    }
    if (talk.index >= talk.lines.length) {
      const bond = bondBetween(world, a, b);
      // A conversation is worth more than standing near somebody, in whichever
      // direction the two of them are already headed.
      bond.strength = clamp(bond.strength + 9 * chemistry(a, b), -100, 100);
      a.social = Math.min(100, a.social + 10);
      b.social = Math.min(100, b.social + 10);
      if (!bond.friends && bond.strength >= 78) {
        bond.friends = true;
        pushFeed(world, 'social', `${a.name} and ${b.name} are now good friends.`);
      }
      world.conversations.splice(i, 1);
    }
  }

  // Start new ones. Bounded, because thirty people all talking at once is a
  // crowd scene rather than a settlement.
  const open = world.citizens.filter((c) => outAndAbout(c) && !busy.has(c.id));
  for (let i = 0; i < open.length && world.conversations.length < 6; i++) {
    const a = open[i];
    if (busy.has(a.id)) continue;
    for (let j = i + 1; j < open.length; j++) {
      const b = open[j];
      if (busy.has(b.id)) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > TALKING_RANGE) continue;
      // Not every meeting of eyes is a conversation.
      if ((a.hash + b.hash + Math.floor(world.hour * 4)) % 5 !== 0) continue;
      const { topic, lines } = conversationFor(world, a, b);
      world.conversations.push({ id: `t${world.counter++}`, a: a.id, b: b.id, topic, lines, index: 0, held: 0 });
      busy.add(a.id); busy.add(b.id);
      break;
    }
  }
}

/**
 * Two people who cannot stand each other, in the same place, at the end of
 * their tether.
 *
 * A settlement where nothing ever goes wrong between anybody reads as a
 * diorama. A fight needs all of it to line up: a real grudge, both of them
 * within arm's reach, and at least one of them already tired, hungry or
 * miserable — which is when people actually snap. It costs both of them, it
 * deepens the grudge, and everybody who saw it thinks less of the day.
 */
function quarrels(world: World, hours: number) {
  for (const bond of Object.values(world.bonds)) {
    if (!bond.rivals) continue;
    const a = world.citizens.find((c) => c.id === bond.a);
    const b = world.citizens.find((c) => c.id === bond.b);
    if (!a || !b || a.inside || b.inside || a.carried || b.carried || a.swimming || b.swimming) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 3.2) continue;
    // Somebody has to be at the end of their tether. Two well-fed, well-rested
    // people who dislike each other simply avoid each other.
    const frayed = Math.min(a.happiness, b.happiness) < 45
      || Math.min(a.rest, b.rest) < 30
      || Math.min(a.hunger, b.hunger) < 30;
    if (!frayed) continue;
    // Rare even then: a few times a season between one bad pair, not daily.
    if (Math.random() > hours * 0.05) continue;

    bond.fights += 1;
    bond.strength = Math.max(-100, bond.strength - 12);
    for (const person of [a, b]) {
      person.happiness = Math.max(0, person.happiness - 18);
      person.rest = Math.max(0, person.rest - 12);
      person.purpose = Math.max(0, person.purpose - 6);
    }
    // Anyone who saw it. A fight in the square is everybody's afternoon.
    let witnesses = 0;
    for (const c of world.citizens) {
      if (c === a || c === b || c.inside || c.age < 10) continue;
      if (Math.hypot(c.x - a.x, c.y - a.y) > 9) continue;
      c.happiness = Math.max(0, c.happiness - 5);
      witnesses++;
    }
    // The conversation, if they were having one, is over.
    world.conversations = world.conversations.filter((t) =>
      t.a !== a.id && t.b !== a.id && t.a !== b.id && t.b !== b.id);
    pushFeed(world, 'social', witnesses > 0
      ? `${a.name} and ${b.name} came to blows in front of ${witnesses} ${witnesses === 1 ? 'person' : 'people'}.`
      : `${a.name} and ${b.name} came to blows.`);
  }
}

/** A building by id, for anything that wants to name where somebody is going. */
export function buildingOf(world: World, id: string | undefined): Building | undefined {
  return id ? world.buildings.find((b) => b.id === id) : undefined;
}

/**
 * What this person means to do today, in their own words.
 *
 * Read from their trade, the settlement's shortages and their own state, so a
 * line names something true: a baker short of flour says so, and a woodcutter
 * in a town with a bare yard says something different from one in a town with
 * a full one. This is what the speech bubbles draw on before they fall back to
 * anything generic.
 */
export function plannedDay(world: World, c: Citizen): { work: string; today: string; evening: string | null } {
  const res = world.resources;
  const short = (r: Resource, per: number) => res[r] < world.citizens.length * per;
  const gathering = world.gatherings.find((g) => g.day === world.day && world.hour < g.hour + g.duration);

  const work: Record<WorkingJob, string> = {
    farmer: short('wheat', 2) ? 'The stores are low — everything I cut today goes straight to the mill.' : 'The far field wants turning today.',
    woodcutter: short('wood', 1.5) ? 'The yard is nearly bare. Timber all day.' : 'A dozen loads and I can call it done.',
    miner: 'Down the shaft again. There is a seam worth following.',
    quarry: short('stone', 1) ? 'They want stone faster than I can cut it.' : 'Blocks for the square today.',
    miller: res.wheat < 8 ? 'No wheat in yet. I am waiting on the fields.' : 'Wheat in, flour out, all morning.',
    baker: res.flour < 8 ? 'No flour to work with. I will go and ask the mill.' : 'Bread by noon, if the oven holds.',
    carpenter: res.wood < 10 ? 'I cannot build without timber. Waiting on the woodcutters.' : 'Two chairs and a table before dark.',
    blacksmith: res.ironOre < 6 ? 'The forge is cold until the ore comes up.' : 'Tools for half the street on the bench today.',
    tailor: res.wool < 5 ? 'No wool. Nothing I can do until there is.' : 'Coats before the cold sets in.',
  };

  const today = c.hunger < 35
    ? 'I need to get to the market before I do anything else.'
    : c.rest < 30
      ? 'I am running on nothing. An early night.'
      : c.job === 'unemployed'
        ? 'Looking for something useful to put my hands to.'
        : `${JOB_LABELS[c.job]}'s day ahead of me.`;

  const evening = gathering
    ? `I will be at the ${gathering.name.toLowerCase()} later.`
    : c.social < 35
      ? 'I should find some company tonight.'
      : null;

  return { work: c.job === 'unemployed' ? 'Nothing of my own to do today.' : work[c.job as WorkingJob], today, evening };
}

/** The line this citizen is speaking right now, if they are in a conversation. */
export function spokenLine(world: World, id: string): { text: string; topic: string } | null {
  for (const talk of world.conversations) {
    const speaker = talk.index % 2 === 0 ? talk.a : talk.b;
    if (speaker !== id) continue;
    const text = talk.lines[talk.index];
    if (!text) return null;
    return { text, topic: talk.topic };
  }
  return null;
}

/** Who this citizen is talking to right now, for the inspector. */
export function talkingWith(world: World, id: string): Citizen | null {
  const talk = world.conversations.find((t) => t.a === id || t.b === id);
  if (!talk) return null;
  return world.citizens.find((c) => c.id === (talk.a === id ? talk.b : talk.a)) ?? null;
}

/**
 * Bonds fade a little each day. Without this, thirty citizens sharing one tavern
 * eventually befriend everyone, and "X and Y are now good friends" stops meaning
 * anything.
 */
/**
 * How a day changes what people are to each other.
 *
 * Acquaintance is shallow and fades fast — that is what stops a settlement of
 * thirty from befriending everybody. A friendship does not: it settles at the
 * level that made it and drifts by a third of a point a day, so somebody you
 * have not seen for a fortnight is still your friend when you next meet. A
 * grudge is just as durable in the other direction, and only softens if the two
 * of them have not been near each other for a long time.
 */
const FRIEND_FLOOR = 46;
const RIVAL_FLOOR = -48;

function decayBonds(world: World) {
  for (const [key, bond] of Object.entries(world.bonds)) {
    if (bond.friends) {
      bond.strength = Math.max(FRIEND_FLOOR, bond.strength - 0.35);
    } else if (bond.rivals) {
      // A grudge fades even more slowly than a friendship. People forgive an
      // acquaintance in a week and remember a slight for a season.
      bond.strength = Math.min(RIVAL_FLOOR, bond.strength + 0.2);
    } else if (bond.strength > 0) {
      bond.strength -= 3.5;
      if (bond.strength <= 0) delete world.bonds[key];
    } else {
      bond.strength += 1.2;
      if (bond.strength >= 0) delete world.bonds[key];
    }
  }
}

/**
 * Whether two people rub each other up the wrong way, before they have met.
 *
 * Drawn from their hashes, so it is a fact about the pair and never changes:
 * the same two people dislike each other in every replay of the same world.
 * About one pair in six is off to a bad start, which in a settlement of twenty
 * is a handful of frictions rather than a town at war with itself.
 */
function chemistry(a: Citizen, b: Citizen) {
  const mix = ((a.hash * 31 + b.hash * 17) ^ (a.hash + b.hash)) >>> 0;
  const roll = (mix % 1000) / 1000;
  if (roll < 0.17) return -1.6;
  if (roll > 0.72) return 1.35;
  return 1;
}

/** People this citizen cannot stand, worst first. */
export function rivalsOf(world: World, id: string): { citizen: Citizen; strength: number }[] {
  const out: { citizen: Citizen; strength: number }[] = [];
  for (const bond of Object.values(world.bonds)) {
    if (!bond.rivals) continue;
    const otherId = bond.a === id ? bond.b : bond.b === id ? bond.a : undefined;
    if (!otherId) continue;
    const citizen = world.citizens.find((c) => c.id === otherId);
    if (citizen) out.push({ citizen, strength: bond.strength });
  }
  return out.sort((x, y) => x.strength - y.strength);
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
  noteAttention(world);
  pushFeed(world, 'social', `${was} goes by ${trimmed} now.`);
  return true;
}

/** Rename a world in place. Citizens refer to it by name when they speak. */
export function renameWorld(world: World, name: string) {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return;
  world.name = trimmed;
  noteAttention(world);
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
/**
 * What a settlement opens with, in Gold.
 *
 * Enough to run a handful of families for a few days and no more. It used to be
 * three thousand, which covered a fortnight of wages with change to spare, so a
 * player had no reason to deposit anything and no sense that the treasury
 * mattered. Now the first week is close-run, and funding it is a real decision.
 */
export const OPENING_TREASURY = 400;

function starterBuildings(seed: number, layout: WorldLayout, population: number): Building[] {
  const make = (id: string, type: string, x: number, y: number): Building => ({ id, type, x, y, workers: [], active: true });
  const civic = layout.civic;
  // A market to trade at, somewhere to keep the surplus, and nothing else given.
  // The bank and the tavern were here too, which meant the settlement opened
  // with the buildings a player would most want the satisfaction of raising.
  const buildings = [
    make('market', 'Market', civic[0][0], civic[0][1]),
    make('storage', 'Storage', civic[2][0], civic[2][1]),
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
  const affordable = Math.max(2, Math.round(population / 4));
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

  // A town that spreads sinks another well and keeps another fire, out at the
  // junctions rather than all in the square. They are what stands between a
  // kitchen fire and a burnt-out bakery, and between a hard winter and wolves
  // in among the pens — and they go in slower than the town grows, so a
  // settlement that builds fast is briefly more exposed than one that does not.
  const extra = Math.floor(buildings.length / 9);
  for (let i = 0; i < extra && layout.nodes.length; i++) {
    const node = layout.nodes[(i * 7 + 3) % layout.nodes.length];
    if (i % 2 === 0) add('well', node[0] + 2.2, node[1] + 1.6, 2);
    else add('campfire', node[0] - 2.4, node[1] + 1.8, 4);
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
  // A camp, not a town.
  //
  // A world used to open with twenty-odd people, a dozen buildings and three
  // thousand Gold — which is a finished settlement, and left the player nothing
  // to do and no reason to put anything in. It starts as a handful of families
  // now and grows: people migrate in as the place becomes somewhere worth
  // moving to, which is the thing the player is actually building.
  const count = Math.max(6, Math.round((7 + rand() * 4) * profile.populationScale));
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
    weather, weatherSeed: seed, treasury: OPENING_TREASURY, population: count,
    temperature: temperatureAt({ biome: profile.kind, day: 1, hour: 8, weather }),
    deaths: 0, births: 0,
    amenities: buildAmenities(buildings, layout, water),
    bridgeWorks: null,
    connectedIslands: [],
    families, citizens, buildings,
    resources: { wheat: 60, vegetables: 30, wood: 50, stone: 20, ironOre: 10, wool: 8, flour: 0, bread: 20, furniture: 0, tools: 5, clothing: 10 },
    market: createMarket(),
    feed: [], gatherings: [], bonds: {}, projects: [], conversations: [], hazards: [],
    resolution: null, artworks: [],
    unlockedAreas: ['Settlement'],
    marketClock: 0, flow: { produced: {}, consumed: {} },
    ledger: emptyLedger(), ledgerYesterday: emptyLedger(),
    stewardship: { score: 0, attention: 1, lastActionDay: 1, dailyYield: 0, pending: 0, lifetime: 0 },
    counter: 0,
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
  // A feast when there is genuinely enough to feast on. It eats real bread, so
  // a settlement that throws one on the strength of a good harvest is a little
  // shorter afterwards — which is the point of a feast. A feast is the whole
  // evening: nothing else is scheduled against it, because the evening is the
  // only window when people are neither at work nor asleep, and two gatherings
  // in it means one of them draws nobody.
  //
  // One thing per evening, and it is always the same hour.
  //
  // The evening is narrow: the working day ends somewhere between half four
  // and half six depending on the person, and the walk home starts at eight.
  // Two gatherings stacked into it meant one of them was always held while
  // half the town was still at work or already in bed — the showcase drew
  // nobody at all on twenty-six of forty days at half five, and on twenty-six
  // of forty at nine at night. So the evening holds one gathering: a feast
  // when the stores can carry one, a showcase now and then, and otherwise the
  // meeting.
  const larder = world.resources.bread + world.resources.vegetables;
  const feasting = square && larder > world.citizens.length * 4 && world.day % 6 === 3;
  if (feasting) {
    next.push({ id: `g${world.day}-feast`, name: 'Harvest Feast', kind: 'feast', day: world.day, hour: 19, duration: 2.5, buildingId: square!.id, attendees: [] });
  } else if (square && rand() < 0.35) {
    // At the same place the town gathers anyway. Holding it at the market
    // instead sounds better and worked worse: one valley's market stands
    // thirteen units from its tavern, and every one of its eleven showcases
    // was held to an empty room while the town drank down the road.
    next.push({ id: `g${world.day}-showcase`, name: 'Art Showcase', kind: 'showcase', day: world.day, hour: 19, duration: 2, buildingId: square.id, attendees: [] });
  } else if (square) {
    next.push({ id: `g${world.day}-meetup`, name: 'Town Meetup', kind: 'meetup', day: world.day, hour: 19, duration: 2, buildingId: square.id, attendees: [] });
  }
  // Market day is the exception: it runs over the middle of the day, when the
  // town is at work, and draws the lunch crowd to the stalls rather than the
  // evening crowd to a room.
  if (market && world.day % 5 === 0) next.push({ id: `g${world.day}-market`, name: 'Market Day', kind: 'market', day: world.day, hour: 10, duration: 4, buildingId: market.id, attendees: [] });
  world.gatherings = next;
}

/** Is a market day running right now? Trade moves faster while one is. */
export function marketDayRunning(world: World) {
  const live = activeGathering(world);
  return live?.kind === 'market';
}

/**
 * What the town would resolve on, given the state it is actually in.
 *
 * Read in order of how badly it hurts: a roofless family first, then hunger,
 * then the cold, then the trades the land supports and the settlement has not
 * taken up. The last case is not a building at all — a town with nothing
 * pressing resolves to put something by, which is a real decision even though
 * it raises nothing.
 */
function meetingBusiness(world: World): { text: string; want: string | null } {
  const homeless = world.citizens.filter((c) => c.age >= 16 && !homeOf(world, c)).length;
  if (homeless > 0) {
    return {
      want: 'House',
      text: `to raise more housing — ${homeless} ${homeless === 1 ? 'person has' : 'people have'} nowhere to live`,
    };
  }
  const food = world.resources.bread + world.resources.wheat + world.resources.vegetables;
  if (food < world.citizens.length * 2.5) {
    return { want: 'Farm', text: 'to break more ground for crops, with the stores this low' };
  }
  if (world.resources.wood < 20) {
    return { want: 'Woodcutter', text: 'to put more hands to the timber, with the yard nearly bare' };
  }
  if (world.temperature < 4 && !world.amenities.some((a) => a.kind === 'campfire')) {
    return { want: null, text: 'to keep a fire burning in the square through the cold' };
  }
  const trade = biomeProfile(world.biome).trades.find((type) => !world.buildings.some((b) => b.type === type));
  if (trade && world.treasury > 2200) {
    return { want: trade, text: `to open a ${trade.toLowerCase()}, which this land will support` };
  }
  if (!findBuilding(world, 'Tavern')) {
    return { want: 'Tavern', text: 'to build somewhere proper to gather' };
  }
  return { want: null, text: 'that things are well enough, and to put the surplus by' };
}

const ART_SUBJECTS = [
  'the river at first light', 'the long field after harvest', 'a neighbour asleep by the fire',
  'the road out of town', 'the hills under snow', 'hands at work', 'the market on a full day',
  'the old tree by the well', 'a storm coming in', 'the bridge, from below',
];

/**
 * Close out a gathering that has just finished, once.
 *
 * This is where a gathering stops being a place people walked to. A meeting
 * takes a resolution that outranks what the settlement would otherwise build;
 * a showcase produces a named work by a named maker; a market day pays out the
 * stallholders' takings; a feast eats real food and lifts everyone who came.
 */
function concludeGatherings(world: World) {
  markAttendance(world);
  for (const g of world.gatherings) {
    if (g.outcome !== undefined) continue;
    if (g.day !== world.day || world.hour < g.hour + g.duration) continue;
    const present = g.attendees
      .map((id) => world.citizens.find((c) => c.id === id))
      .filter((c): c is Citizen => !!c);

    // Nobody came. That is an outcome, and an honest one.
    if (present.length < 2) {
      g.outcome = 'Nobody came.';
      continue;
    }

    if (g.kind === 'meetup') {
      const business = meetingBusiness(world);
      world.resolution = { text: business.text, want: business.want, day: world.day, voters: present.length };
      g.outcome = `Resolved ${business.text}.`;
      pushFeed(world, 'social', `${present.length} met at the ${venueName(world, g)}. They resolved ${business.text}.`);
      // A town that has just agreed on something feels better about itself.
      for (const c of present) {
        c.purpose = Math.min(100, c.purpose + 5);
        c.social = Math.min(100, c.social + 12);
      }
    } else if (g.kind === 'showcase') {
      // The maker is whoever came with the most to say — the highest sense of
      // purpose in the room — so the showcase belongs to somebody in
      // particular rather than to a random attendee.
      const maker = present.reduce((best, c) => (c.purpose > best.purpose ? c : best), present[0]);
      const subject = ART_SUBJECTS[(maker.hash + world.day) % ART_SUBJECTS.length];
      const title = `${subject[0].toUpperCase()}${subject.slice(1)}`;
      world.artworks.unshift({ id: `art${world.counter++}`, title, maker: maker.name, day: world.day, subject });
      if (world.artworks.length > 24) world.artworks.length = 24;
      g.outcome = `${maker.name} showed “${title}”.`;
      pushFeed(world, 'social', `${maker.name} showed a piece at the showcase: “${title}”. ${present.length - 1} stayed to look.`);
      maker.purpose = Math.min(100, maker.purpose + 14);
      for (const c of present) {
        c.happiness = Math.min(100, c.happiness + 4);
        c.social = Math.min(100, c.social + 9);
      }
    } else if (g.kind === 'market') {
      // Visiting traders. The takings are real Gold, booked as exports, and
      // scale with how many stallholders turned out.
      const takings = Math.round(present.length * 6 + world.resources.wheat * 0.2 + world.resources.furniture * 1.2);
      earn(world, 'exports', takings);
      g.outcome = `${takings} Gold taken across the stalls.`;
      pushFeed(world, 'market', `Market day drew ${present.length} to the stalls and took ${takings} Gold.`);
      for (const c of present) c.social = Math.min(100, c.social + 8);
    } else {
      // A feast eats what the settlement has, and everyone who came goes home
      // fed, warm and better company than they were.
      const wanted = present.length * 1.6;
      const bread = Math.min(world.resources.bread, wanted * 0.7);
      const veg = Math.min(world.resources.vegetables, wanted - bread);
      world.resources.bread -= bread;
      world.resources.vegetables -= veg;
      note(world, 'consumed', 'bread', bread);
      note(world, 'consumed', 'vegetables', veg);
      g.outcome = `${present.length} ate together.`;
      pushFeed(world, 'social', `${present.length} sat down to the harvest feast at the ${venueName(world, g)}.`);
      for (const c of present) {
        c.hunger = Math.min(100, c.hunger + 30);
        c.social = Math.min(100, c.social + 20);
        c.happiness = Math.min(100, c.happiness + 7);
        c.warmth = Math.min(100, c.warmth + 12);
      }
    }
  }

  // A resolution stands for three days, then the town is free to think again.
  if (world.resolution && world.day - world.resolution.day > 3) world.resolution = null;
}

/**
 * Who is actually at the gathering that is running.
 *
 * Attendance used to be recorded when a citizen chose the venue as their
 * destination, which is a statement of intent and not the same thing. It only
 * ran when someone picked a new destination, so anyone already settled — and
 * in a desert, that is most of the town, sat at a fire against the cold —
 * never counted: the desert's meetings recorded nobody present on
 * thirty-one days out of forty while three people stood in the square.
 *
 * So it is measured where they are standing. Being at a market day means
 * buying your dinner at the stalls; being at anything else means standing
 * about with people, which is what socialising is.
 */
function markAttendance(world: World) {
  const g = activeGathering(world);
  if (!g) return;
  const venue = world.buildings.find((b) => b.id === g.buildingId);
  if (!venue) return;
  const wanted: Phase = g.kind === 'market' ? 'eating' : 'socialising';
  const reach = g.kind === 'market' ? 11 : 9;
  for (const c of world.citizens) {
    if (c.age < 16) continue;
    // The bell. Someone already settled somewhere only re-picks a destination
    // when their dwell runs out, which can be an hour or more — long enough to
    // miss the whole meeting from a bench two streets away. Being called
    // reassigns them once, which sends them to the venue.
    if (c.phase === wanted && c.calledTo !== g.id) {
      c.calledTo = g.id;
      assignDestination(world, c, c.phase);
    }
    // What they are doing, not what they are doing this frame. `activity` reads
    // 'walking' for as long as someone is on their way, so testing it counted
    // only the people who had already sat down: at half twelve on a market day
    // eight citizens were in the eating phase and not one of them registered.
    if (c.phase !== wanted) continue;
    // A stall *is* the market day, wherever the town put it, so being at one
    // counts without measuring back to the market building. Everything else is
    // measured from the venue.
    const atStall = g.kind === 'market' && c.usingId !== undefined
      && world.amenities.some((a) => a.id === c.usingId && a.kind === 'stall');
    if (!atStall && Math.hypot(c.x - venue.x, c.y - venue.y) > reach) continue;
    if (!g.attendees.includes(c.id)) g.attendees.push(c.id);
  }
}

function venueName(world: World, g: Gathering) {
  return (world.buildings.find((b) => b.id === g.buildingId)?.type ?? 'square').toLowerCase();
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
        c.wallet -= price; earn(world, 'households', price); world.resources.clothing -= 1;
        note(world, 'consumed', 'clothing', 1);
        c.clothing = Math.min(100, c.clothing + 34);
      }
    }

    // Comfort spending, spread across the day so households do not all buy at once.
    if (c.wallet > 130 && world.resources.furniture >= 1 && c.hash % 6 === Math.floor(world.hour) % 6) {
      const price = world.market.furniture.price;
      if (c.wallet >= price) {
        c.wallet -= price; earn(world, 'households', price); world.resources.furniture -= 1;
        note(world, 'consumed', 'furniture', 1);
        c.purpose = Math.min(100, c.purpose + 2.5);
      }
    }

    if (c.wallet > 200 && world.resources.tools >= 1 && c.job !== 'unemployed' && c.hash % 11 === Math.floor(world.hour) % 11) {
      const price = world.market.tools.price;
      if (c.wallet >= price) {
        c.wallet -= price; earn(world, 'households', price); world.resources.tools -= 1;
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
  const busy = marketDayRunning(world);

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
    // A market day is a market day: stock moves faster in both directions while
    // one is running, which is what makes it worth walking to.
    const pace = busy ? 1.8 : 1;
    if (stock < buffer * (importer ? 0.65 : 0.3)) {
      const qty = Math.min(Math.max(1, Math.round((buffer - stock) * .2 * pace * hours)), Math.max(0, buffer - stock)), cost = qty * q.price;
      if (qty > 0 && world.treasury >= cost) {
        world.resources[r] += qty; spend(world, 'imports', cost); q.volume += qty;
        if (qty >= 6 && !reported) { reported = true; pushFeed(world, 'market', `The market bought ${qty} ${RESOURCE_LABELS[r].toLowerCase()} for ${cost.toFixed(0)} Gold.`); }
      }
    } else if (stock > buffer * 1.2) {
      const qty = Math.min(Math.max(1, Math.round((stock - buffer) * .25 * pace * hours)), Math.floor(stock - buffer));
      if (qty > 0) {
        const revenue = qty * q.price; world.resources[r] -= qty; earn(world, 'exports', revenue); q.volume += qty;
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
    // Blight is in the fields, not in the mine: it costs the farmers and only
    // the farmers, which is what makes a granary the answer to it.
    const blighted = wj === 'farmer' && hazardActive(world, 'blight') ? 0.45 : 1;
    const weather = world.weather === 'Storm' ? .65 : world.weather === 'Rain' && wj === 'farmer' ? 1.08 : world.weather === 'Snow' ? .7 : 1;
    if (recipe.input && !Object.entries(recipe.input).every(([r, n]) => world.resources[r as Resource] >= (n as number) * workers)) continue;
    for (const [r, n] of Object.entries(recipe.input || {})) {
      const used = (n as number) * workers;
      world.resources[r as Resource] -= used;
      note(world, 'consumed', r as Resource, used);
    }
    for (const [r, n] of Object.entries(recipe.output)) {
      const made = (n as number) * workers * terrainMultiplier(world, wj) * seasonal * weather * blighted;
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

/**
 * How ready the settlement is for each kind of trouble, 0 to 1.
 *
 * Everything here is something the player can change: wells and a fire brigade
 * of people awake nearby, a full granary and somewhere to keep it, fires
 * burning through the winter, buildings set back from the bank. Readiness does
 * not stop a hazard starting — a dry summer is a dry summer — but it decides
 * what the hazard costs, and at full readiness the answer is close to nothing.
 */
export function readiness(world: World): Record<HazardKind, number> {
  const wells = world.amenities.filter((a) => a.kind === 'well').length;
  const fires = world.amenities.filter((a) => a.kind === 'campfire').length;
  const stores = world.buildings.filter((b) => b.type === 'Storage' && b.active).length;
  const food = world.resources.bread + world.resources.wheat + world.resources.vegetables;
  const mouths = Math.max(1, world.citizens.length);
  const water = waterOf(world);
  const buildings = world.buildings.length || 1;
  const backFromBank = world.buildings.filter((b) => water.distanceToWater(b.x, b.y) >= 6).length / buildings;
  // Measured against the size of the thing being defended, not as a flat
  // count: one well was enough for a hamlet of eight and read as complete
  // readiness for a town of thirty-one, which meant nothing could ever burn.
  return {
    fire: clamp(wells / (1 + buildings / 8), 0, 1),
    blight: clamp(food / (mouths * 9) * 0.7 + stores * 0.3, 0, 1),
    wolves: clamp(fires / (1 + mouths / 14), 0, 1),
    flood: clamp(backFromBank, 0, 1),
  };
}

/** Labels for the panel, so a hazard is named the same way everywhere. */
export const HAZARD_LABELS: Record<HazardKind, string> = {
  fire: 'Fire',
  blight: 'Blight',
  wolves: 'Wolves',
  flood: 'Flood',
};

export const HAZARD_DEFENCE: Record<HazardKind, string> = {
  fire: 'Wells within reach, and enough hands to pass the buckets.',
  blight: 'A granary and a season of food put by.',
  wolves: 'Fires burning through the night, and numbers.',
  flood: 'Buildings set back from the bank.',
};

/**
 * Whether a hazard of this kind is plausible today, given the world.
 *
 * The point is that trouble comes from somewhere. A fire wants heat and dry
 * air; blight wants a growing season and fields; wolves want a cold night and
 * woodland; a flood wants a storm and a river.
 */
function hazardChance(world: World, kind: HazardKind): number {
  const water = waterOf(world);
  if (kind === 'fire') {
    if (world.temperature < 17 || world.weather === 'Rain' || world.weather === 'Snow') return 0;
    const hearths = world.buildings.filter((b) => b.type === 'Bakery' || b.type === 'Blacksmith' || b.type === 'House').length;
    return Math.min(0.09, 0.006 * hearths) * (world.season === 'Summer' ? 1.6 : 1);
  }
  if (kind === 'blight') {
    if (world.season === 'Winter') return 0;
    const farms = world.buildings.filter((b) => b.type === 'Farm' && b.active).length;
    if (!farms) return 0;
    return Math.min(0.07, 0.022 * farms);
  }
  if (kind === 'wolves') {
    if (world.temperature > 6) return 0;
    const woods = world.biome === 'woodland' || world.biome === 'valley' || world.biome === 'swamp' ? 1.5 : 1;
    return 0.035 * woods;
  }
  // Flood: a storm, on a settlement that has water in it at all.
  if (world.weather !== 'Storm') return 0;
  return water.mainland >= 0 ? 0.16 : 0;
}

/**
 * Run the day's trouble: retire what has passed, and see what starts.
 *
 * One hazard at a time. Two at once is not drama, it is a settlement being
 * bullied — and the feed becomes a list of disasters rather than a story about
 * a place.
 */
function hazards(world: World) {
  // Retire what has run its course, and give back what it took.
  for (let i = world.hazards.length - 1; i >= 0; i--) {
    const h = world.hazards[i];
    h.days -= 1;
    if (h.days > 0) continue;
    if (h.buildingId) {
      const b = world.buildings.find((x) => x.id === h.buildingId);
      if (b) {
        b.active = true;
        pushFeed(world, 'build', `The ${b.type.toLowerCase()} is back in use.`);
      }
    }
    world.hazards.splice(i, 1);
  }
  if (world.hazards.length) return;
  // Nothing happens to a settlement in its first days. A town that burns down
  // before it has a well is not a challenge, it is a bad opening hand.
  if (world.day < 5) return;

  const rand = mulberry32(world.seed + world.day * 3319);
  const ready = readiness(world);
  const kinds: HazardKind[] = ['fire', 'blight', 'wolves', 'flood'];
  for (const kind of kinds) {
    const chance = hazardChance(world, kind);
    if (chance <= 0 || rand() > chance) continue;
    startHazard(world, kind, ready[kind], rand);
    return;
  }
}

function startHazard(world: World, kind: HazardKind, ready: number, rand: () => number) {
  // How badly it lands. Full readiness is not immunity — it is the difference
  // between a bad afternoon and a bad month.
  const severity = Math.max(0.12, 1 - ready);
  const days = Math.max(1, Math.round(1 + severity * 4));
  const add = (effect: string, buildingId?: string) => {
    world.hazards.push({ id: `h${world.counter++}`, kind, label: HAZARD_LABELS[kind], effect, day: world.day, days, buildingId });
  };

  if (kind === 'fire') {
    const candidates = world.buildings.filter((b) => b.active && b.type !== 'Market');
    const hit = candidates[Math.floor(rand() * candidates.length)];
    if (!hit) return;
    if (ready > 0.75) {
      pushFeed(world, 'world', `A fire started at the ${hit.type.toLowerCase()} and was put out before it spread. The wells did their job.`);
      add('Put out the same day. No lasting damage.');
      world.hazards[world.hazards.length - 1].days = 1;
      return;
    }
    hit.active = false;
    const wood = Math.min(world.resources.wood, Math.round(12 * severity));
    world.resources.wood -= wood;
    note(world, 'consumed', 'wood', wood);
    pushFeed(world, 'world', `Fire took hold at the ${hit.type.toLowerCase()}. It is out of use, and ${wood} timber went with it.`);
    add(`The ${hit.type.toLowerCase()} is out of use.`, hit.id);
    return;
  }

  if (kind === 'blight') {
    const lost = Math.round((world.resources.wheat + world.resources.vegetables) * 0.35 * severity);
    const wheat = Math.min(world.resources.wheat, Math.round(lost * 0.6));
    const veg = Math.min(world.resources.vegetables, lost - wheat);
    world.resources.wheat -= wheat;
    world.resources.vegetables -= veg;
    note(world, 'consumed', 'wheat', wheat);
    note(world, 'consumed', 'vegetables', veg);
    pushFeed(world, 'world', lost > 0
      ? `Blight is through the fields. ${wheat + veg} of the crop is gone and the harvest will be short for days.`
      : 'Blight is through the fields. There was little standing to lose.');
    add('The fields yield less while it lasts.');
    return;
  }

  if (kind === 'wolves') {
    const outdoors = world.citizens.filter((c) => !c.inside && c.age >= 16);
    if (ready > 0.7 || !outdoors.length) {
      pushFeed(world, 'world', 'Wolves came down to the edge of the settlement in the night and turned back at the fires.');
      add('Kept at the treeline by the fires.');
      world.hazards[world.hazards.length - 1].days = 1;
      return;
    }
    const wool = Math.min(world.resources.wool, Math.round(6 * severity));
    world.resources.wool -= wool;
    note(world, 'consumed', 'wool', wool);
    for (const c of outdoors) {
      c.warmth = Math.max(0, c.warmth - 14 * severity);
      c.happiness = Math.max(0, c.happiness - 9 * severity);
    }
    pushFeed(world, 'world', `Wolves were in among the pens overnight. ${wool} wool lost, and nobody outdoors slept well.`);
    add('Nobody wants to be out after dark.');
    return;
  }

  // Flood.
  const bank = world.buildings.filter((b) => b.active && waterOf(world).distanceToWater(b.x, b.y) < 6);
  if (!bank.length || ready > 0.85) {
    pushFeed(world, 'world', 'The river came up in the storm and went down again. The settlement is built well back from it.');
    add('The water stayed in its channel.');
    world.hazards[world.hazards.length - 1].days = 1;
    return;
  }
  const hit = bank[Math.floor(rand() * bank.length)];
  hit.active = false;
  const stone = Math.min(world.resources.stone, Math.round(8 * severity));
  world.resources.stone -= stone;
  note(world, 'consumed', 'stone', stone);
  pushFeed(world, 'world', `The river came over its bank and into the ${hit.type.toLowerCase()}. It is out of use until the ground dries.`);
  add(`The ${hit.type.toLowerCase()} is flooded out.`, hit.id);
}

/** Whether a hazard of this kind is running. Production and needs both ask. */
export function hazardActive(world: World, kind: HazardKind) {
  return world.hazards.some((h) => h.kind === kind);
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
      earn(world, 'food', paid);
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
    spend(world, 'works', 40);
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

  // A building people cannot walk to is the most urgent reason to bridge, and
  // it beats every threshold below.
  //
  // A player can place a building anywhere they can see, including across the
  // water; the settlement then routed people at it, they walked to the bank,
  // found the water in the way, and shuffled there. Now the town treats a
  // stranded building as a reason to start a crossing, and it will spend down
  // to its last few loads of timber to do it, because the alternative is a
  // building nobody can use and people stuck on a shore.
  const stranded = strandedBuilding(world);
  if (stranded !== null) {
    const reach = narrowestCrossing(world, stranded);
    if (reach && world.resources.wood >= 12) {
      world.bridgeWorks = {
        island: stranded,
        fromX: reach.fromX, fromY: reach.fromY,
        toX: reach.toX, toY: reach.toY,
        progress: 0,
        length: Math.max(3, Math.round(reach.gap / 2.5)),
      };
      pushFeed(world, 'build', 'There are buildings across the water nobody can reach. Work has begun on a crossing.');
      return;
    }
  }

  // Otherwise: only worth starting when there is somewhere worth reaching and
  // the settlement is comfortable enough to spare the timber.
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
 * An island the settlement has a building on and cannot walk to.
 *
 * Returns the island id, or null when everything is reachable. The mainland is
 * by definition reachable, and an island already on the connected list has a
 * deck: this is looking for the case where somebody built across water that
 * nothing spans.
 */
function strandedBuilding(world: World): number | null {
  const water = waterOf(world);
  for (const b of world.buildings) {
    const island = water.landAt(b.x, b.y);
    if (island === water.mainland) continue;
    if (island < 0) continue;
    if (world.connectedIslands.includes(island)) continue;
    return island;
  }
  return null;
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
 * What a building is made of, on top of what it costs.
 *
 * Gold alone made the woodcutter's whole output an abstraction: a settlement
 * with a full timber yard and one with an empty one built at exactly the same
 * rate, and the only thing wood was ever really *for* was the bakery's ovens
 * and the hearths in winter. Now a house is timber and a forge is stone, so
 * the yard is a thing the town watches, and a settlement that has felled its
 * last tree has to wait for it to grow back before it raises another roof.
 *
 * The quantities are deliberately modest against a woodcutter's twelve and a
 * half loads a day: this is meant to be a real constraint in a bad season, not
 * a wall that stops a healthy town growing.
 */
export const BUILD_MATERIALS: Record<string, { wood: number; stone: number }> = {
  House: { wood: 14, stone: 4 },
  Farm: { wood: 12, stone: 2 },
  Woodcutter: { wood: 8, stone: 2 },
  Storage: { wood: 12, stone: 3 },
  Quarry: { wood: 10, stone: 0 },
  Mine: { wood: 16, stone: 6 },
  Mill: { wood: 18, stone: 10 },
  Bakery: { wood: 12, stone: 16 },
  Carpenter: { wood: 20, stone: 4 },
  Blacksmith: { wood: 12, stone: 20 },
  Tailor: { wood: 14, stone: 6 },
  Tavern: { wood: 24, stone: 10 },
  Bank: { wood: 18, stone: 26 },
};

/** What this kind of building takes to raise. Anything unlisted is a modest shed. */
export function buildMaterials(type: string) {
  return BUILD_MATERIALS[type] ?? { wood: 10, stone: 4 };
}

/** Whether the stores can cover a building of this kind. */
export function materialsInStore(world: World, type: string) {
  const need = buildMaterials(type);
  return world.resources.wood >= need.wood && world.resources.stone >= need.stone;
}

function drawMaterials(world: World, type: string) {
  const need = buildMaterials(type);
  world.resources.wood -= need.wood;
  world.resources.stone -= need.stone;
  note(world, 'consumed', 'wood', need.wood);
  note(world, 'consumed', 'stone', need.stone);
}

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

  // What the settlement would choose on its own, reading its own shortages.
  let ownChoice: string | null = null;
  if (homeless > 0 || crowded) ownChoice = 'House';
  else if (world.resources.wood < 22 && !world.buildings.some((b) => b.type === 'Woodcutter')) ownChoice = 'Woodcutter';
  else if (world.resources.wheat + world.resources.bread < world.citizens.length * 2.5) ownChoice = 'Farm';
  else if (world.treasury > 4000) {
    // A settlement with money it does not need takes up a trade its land
    // supports and it has not opened yet. Otherwise the gold simply piles up:
    // a grassland reached thirty-five thousand and never spent a coin of it.
    ownChoice = biomeProfile(world.biome).trades
      .find((type) => !world.buildings.some((b) => b.type === type)) ?? null;
  }

  // What the last town meeting resolved on outranks that, for as long as the
  // resolution stands. That is the whole point of holding one. Housing and
  // farmland are always wanted more of; a trade building only until the town
  // has one.
  const resolved = world.resolution?.want ?? null;
  const stillWanted = resolved !== null
    && (resolved === 'House' || resolved === 'Farm' || !world.buildings.some((b) => b.type === resolved));
  const want = stillWanted ? resolved : ownChoice;
  const bySay = stillWanted && resolved !== ownChoice;
  if (!want) return;

  const cost = SELF_BUILD_COST[want] ?? TRADE_BUILD_COST[want] ?? 250;
  // The cost multiple alone was not a brake: a desert kept raising houses it
  // could not staff, and every one of them added upkeep and wages until it
  // could not meet payroll on a hundred and thirty-seven days out of two
  // hundred. A settlement that cannot pay its people should not be building.
  const payroll = world.citizens
    .filter((c) => c.age >= 16 && c.job !== 'unemployed')
    .reduce((sum, c) => sum + jobs[c.job as WorkingJob].wage, 0);
  const upkeep = world.buildings.filter((b) => b.active).reduce((sum, b) => sum + maintenanceCost(b.type), 0);
  // Three times over, and a fortnight of running costs left standing — unless
  // the town resolved on this in front of everybody, in which case it will
  // accept a thinner cushion for it. That is what a vote is worth: the same
  // settlement, slightly braver about the thing it agreed on.
  const reserveDays = bySay ? 10 : 14;
  const multiple = bySay ? 2 : 3;
  if (world.treasury < cost * multiple || world.treasury < (payroll + upkeep) * reserveDays) return;
  // Gold is not enough: the timber and stone have to be in the yard. A town
  // that has run its forest down waits for it to grow rather than conjuring a
  // house out of its treasury.
  if (!materialsInStore(world, want)) {
    if (world.hour < 1) {
      const need = buildMaterials(want);
      pushFeed(world, 'build', `A ${want.toLowerCase()} is wanted, but the yard is short of timber and stone — ${need.wood} wood and ${need.stone} stone are needed.`);
    }
    return;
  }

  const site = freeSite(world, want === 'House');
  if (!site) return;

  spend(world, 'building', cost);
  drawMaterials(world, want);
  const raised: Building = { id: `b${world.counter++}`, type: want, x: site[0], y: site[1], workers: [], active: true };
  world.buildings.push(raised);
  linkToRoads(world, raised);
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  pushFeed(world, 'build', bySay
    ? `The settlement built a ${want.toLowerCase()}, as the meeting resolved.`
    : want === 'House'
      ? 'The settlement raised another house.'
      : `The settlement built a ${want.toLowerCase()}.`);
}

/**
 * Put somebody in a building that has nobody in it.
 *
 * Jobs are only re-rolled for a citizen whose needs have dipped or whose trade
 * is over capacity, which is right for a settled town and wrong the moment a
 * new building goes up: a contented, fully employed settlement would raise a
 * bakery and leave it dark, because nobody was unhappy enough to change trade.
 * A player who has just spent Gold and timber on a building should see somebody
 * walk into it.
 *
 * The person who moves is taken from the most crowded trade, so filling the new
 * place does not empty an old one.
 */
function fillEmptyTrades(world: World, tally: Partial<Record<Job, number>>) {
  const workers = world.citizens.filter((c) => c.age >= 16);
  for (const job of Object.keys(jobs) as WorkingJob[]) {
    if (!jobCapacity(world, job)) continue;
    if ((tally[job] ?? 0) > 0) continue;

    // The trade with the most people beyond what its buildings can use, or
    // failing that simply the most crowded one.
    let from: WorkingJob | null = null;
    let surplus = 0;
    for (const other of Object.keys(jobs) as WorkingJob[]) {
      const have = tally[other] ?? 0;
      if (have < 2) continue;
      const over = have - jobCapacity(world, other);
      const score = over > 0 ? over + 10 : have;
      if (score > surplus) { surplus = score; from = other; }
    }
    const mover = from
      ? workers.find((c) => c.job === from)
      : workers.find((c) => c.job === 'unemployed');
    if (!mover) continue;

    tally[mover.job] = (tally[mover.job] ?? 1) - 1;
    mover.job = job;
    tally[job] = (tally[job] ?? 0) + 1;
    pushFeed(world, 'work', `${mover.name} took up ${JOB_LABELS[job].toLowerCase()} at the new ${jobs[job].building.toLowerCase()}.`);
  }
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

const SETTLER_NAMES = [
  'Maren', 'Osric', 'Talia', 'Bram', 'Ines', 'Caleb', 'Rowan', 'Sena',
  'Halvard', 'Perrin', 'Mira', 'Dain', 'Orla', 'Sigrid', 'Tobias', 'Wren',
];

/**
 * People moving in.
 *
 * A settlement that only ever grows by having children takes a season to add
 * anybody, and the player's building work has no visible consequence: they
 * raise a house and it stands empty for a fortnight. Word gets around instead.
 * Somewhere with a spare roof, food in the store, wages it can meet and people
 * who seem content attracts settlers, and they arrive on the road.
 *
 * Every one of those conditions is a thing the player controls, which is the
 * point: a plot begins as a handful of families and becomes a town because the
 * player made it somewhere worth moving to.
 */
function migration(world: World, rand: () => number) {
  const houses = world.buildings.filter((b) => b.type === 'House' && b.active).length;
  // A spare roof. Nobody moves to a place they would have to sleep outside in.
  if (world.citizens.length >= houses * 3.2) return;
  const food = world.resources.bread + world.resources.wheat + world.resources.vegetables;
  if (food < world.citizens.length * 4) return;
  // And a settlement that can pay them.
  const payroll = world.citizens.filter((c) => c.age >= 16 && c.job !== 'unemployed')
    .reduce((sum, c) => sum + jobs[c.job as WorkingJob].wage, 0);
  if (world.treasury < payroll * 4 + 120) return;
  // Word travels on how the place is doing, so a miserable town attracts nobody.
  const content = world.citizens.reduce((s, c) => s + c.happiness, 0) / Math.max(1, world.citizens.length);
  if (content < 55) return;
  // Bigger places draw more people, but never more than one a day.
  const draw = 0.18 + Math.min(0.32, world.buildings.length * 0.02);
  if (rand() > draw) return;

  const hash = world.counter * 37 + 11;
  const name = SETTLER_NAMES[Math.floor(rand() * SETTLER_NAMES.length)];
  // In on the road: the wander spot furthest from the square, so they are
  // visibly arriving from somewhere rather than appearing in the middle of it.
  const plaza = world.layout.plaza;
  const spots = world.layout.wanderSpots;
  const arrival = spots.reduce((far, spot) =>
    Math.hypot(spot[0] - plaza.x, spot[1] - plaza.y) > Math.hypot(far[0] - plaza.x, far[1] - plaza.y) ? spot : far,
  spots[0] ?? [plaza.x, plaza.y]);

  const family: Family = {
    id: `f${world.counter++}`,
    name: familyNames[world.families.length % familyNames.length],
    homeId: '',
    members: [],
    wealth: 40 + Math.floor(rand() * 40),
  };
  // A vacant house if there is one; otherwise they lodge until one is raised.
  const vacant = world.buildings.find((b) =>
    b.type === 'House' && !world.families.some((f) => f.homeId === b.id));
  family.homeId = vacant?.id ?? '';

  const settler: Citizen = {
    id: `c${world.counter++}`,
    name,
    handle: `@${name.toLowerCase()}${(hash % 90) + 10}`,
    familyId: family.id,
    age: 18 + Math.floor(rand() * 26),
    job: 'unemployed',
    hash,
    hunger: 70, rest: 62, social: 55, clothing: 70, purpose: 62,
    happiness: 74, wage: 0, wallet: 30 + Math.floor(rand() * 40),
    x: arrival[0], y: arrival[1], destX: arrival[0], destY: arrival[1],
    path: [], dwell: 0, wanderIdx: hash % 17, errand: false,
    phase: 'wandering', activity: 'idle', facing: 's', moving: false, inside: false,
    stalled: 0, bestAway: Infinity, roughSleeper: false,
    look: Math.floor(rand() * 0xffffff),
    livedDays: 0, lifespan: lifespanFor(rand()), warmth: 80, seated: false, chilled: true, sheltering: false,
  };
  world.families.push(family);
  family.members.push(settler.id);
  world.citizens.push(settler);
  pushFeed(world, 'social', `${name} arrived on the road, looking for work and a roof.`);
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

/**
 * The most $EMERGE one world can mint in a day, at a perfectly run settlement
 * the player is actively managing.
 *
 * Set against what a plot costs — a few hundred thousand — so a fortnight or
 * so of real attention earns back a plot, and sixty days of leaving the tab
 * open earns a fraction of one. The old arrangement paid eighty million for
 * the latter.
 */
export const STEWARDSHIP_DAILY_CAP = 25_000;

/** How many days of neglect it takes to fall to the floor. */
const ATTENTION_DAYS = 3;

/**
 * What a wholly neglected world still earns, as a share of an attended one.
 *
 * Not zero: a settlement the player set up well and left running is worth
 * something, and a hard zero would make the whole thing feel punitive. Eight
 * per cent of the ceiling, times whatever score a drifting town holds, comes
 * to about a thousand a day — enough to notice, nowhere near enough to farm.
 */
const ATTENTION_FLOOR = 0.08;

/**
 * Mark that the player did something here.
 *
 * Called from every player-driven action: raising a building, pulling one
 * down, picking a citizen up, funding the treasury, renaming. This is the
 * whole anti-farming mechanism, so it is deliberately not called from anything
 * the simulation does by itself.
 */
export function noteAttention(world: World) {
  world.stewardship.lastActionDay = world.day;
}

/** How well this settlement is being run, 0 to 1. */
export function stewardshipScore(world: World) {
  const adults = world.citizens.filter((c) => c.age >= 16);
  if (!adults.length) return 0;
  const housed = adults.filter((c) => homeOf(world, c)).length / adults.length;
  const employed = adults.filter((c) => c.job !== 'unemployed').length / adults.length;
  const content = world.citizens.reduce((s, c) => s + c.happiness, 0) / (world.citizens.length * 100);
  const food = world.resources.bread + world.resources.wheat + world.resources.vegetables;
  const fed = clamp(food / (world.citizens.length * 6), 0, 1);
  // An unanswered hazard is the clearest sign nobody is minding the place.
  const ready = readiness(world);
  const safe = world.hazards.length
    ? world.hazards.reduce((s, h) => s + ready[h.kind], 0) / world.hazards.length
    : 1;
  const quality = housed * 0.25 + fed * 0.25 + employed * 0.2 + content * 0.2 + safe * 0.1;
  // Squared, so running a place well is worth much more than running it.
  return clamp(quality * quality, 0, 1);
}

/** Accrue the day's stewardship yield. */
function accrueYield(world: World) {
  const s = world.stewardship;
  const idleDays = Math.max(0, world.day - s.lastActionDay);
  s.attention = Math.max(ATTENTION_FLOOR, 1 - idleDays / ATTENTION_DAYS);
  s.score = stewardshipScore(world);
  s.dailyYield = Math.round(STEWARDSHIP_DAILY_CAP * s.score * s.attention);
  s.pending += s.dailyYield;
  s.lifetime += s.dailyYield;
}

/**
 * Hand the accrued yield to the caller, once.
 *
 * The world is regenerated from its seed each time the player opens it, so the
 * running total cannot live here — the client drains this into the player's
 * ledger, which is what persists.
 */
export function collectYield(world: World) {
  const amount = Math.round(world.stewardship.pending);
  world.stewardship.pending = 0;
  return amount;
}

function daily(world: World) {
  world.flow = { produced: {}, consumed: {} };
  // Yesterday's books close before today's wages are drawn, so the figures the
  // player reads are a whole day rather than a day and a morning.
  world.ledgerYesterday = world.ledger;
  world.ledger = emptyLedger();
  accrueYield(world);
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

  fillEmptyTrades(world, tally);

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
  spend(world, 'wages', payroll * ratio);
  spend(world, 'upkeep', upkeep);

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
  migration(world, mulberry32(world.seed + world.day * 4111));
  hazards(world);
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
  swimmers(world, hours);
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
  converse(world, hours);
  quarrels(world, hours);
  concludeGatherings(world);

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

/* ------------------------------------------------------------------ *
 * Picking people up
 * ------------------------------------------------------------------ */

/** Lift a citizen out of their day. They stop where they are until set down. */
export function pickUpCitizen(world: World, id: string) {
  const c = world.citizens.find((x) => x.id === id);
  if (!c) return false;
  releaseAmenity(world, c);
  c.carried = true;
  c.swimming = false;
  c.path = [];
  c.inside = false;
  c.moving = false;
  c.activity = 'idle';
  return true;
}

/** Move somebody who is being carried. Nothing else about them changes. */
export function carryCitizenTo(world: World, id: string, x: number, y: number) {
  const c = world.citizens.find((x2) => x2.id === id);
  if (!c?.carried) return;
  c.x = clamp(x, 2, 98);
  c.y = clamp(y, 4, 96);
  c.destX = c.x;
  c.destY = c.y;
}

/**
 * Set a carried citizen down.
 *
 * On land they simply pick their day back up from where they are. In the water
 * they start swimming for the nearest bank, which is the honest answer to being
 * dropped in a river: not standing on it, and not disappearing.
 */
export function dropCitizen(world: World, id: string, x: number, y: number) {
  const c = world.citizens.find((x2) => x2.id === id);
  if (!c?.carried) return;
  c.carried = false;
  c.x = clamp(x, 2, 98);
  c.y = clamp(y, 4, 96);
  const water = waterOf(world);
  if (water.blocks(c.x, c.y)) {
    c.swimming = true;
    c.happiness = Math.max(0, c.happiness - 8);
    pushFeed(world, 'social', `${c.name} went into the water and is swimming for the bank.`);
  } else {
    c.path = [];
    c.dwell = 0;
    assignDestination(world, c, phaseFor(c, world.hour));
  }
  noteAttention(world);
}

/** How fast somebody swims, in world units per game hour. Slower than walking. */
const SWIM_SPEED = 5.5;

/**
 * Move anyone in the water toward dry ground.
 *
 * Runs ahead of the ordinary movement step and takes those citizens out of it
 * entirely, because every rule in there is about walking: the water mask
 * refuses the ground they are standing on, and the escape nudge would fight
 * their own progress.
 */
function swimmers(world: World, hours: number) {
  const water = waterOf(world);
  for (const c of world.citizens) {
    if (!c.swimming) continue;
    c.activity = 'walking';
    c.inside = false;
    c.moving = true;
    if (!water.blocks(c.x, c.y)) {
      // Ashore. Shake off the water and get on with the day.
      c.swimming = false;
      c.warmth = Math.max(0, c.warmth - 12);
      c.path = [];
      c.dwell = 0;
      assignDestination(world, c, phaseFor(c, world.hour));
      pushFeed(world, 'social', `${c.name} made it back to dry land.`);
      continue;
    }
    // The nearest unblocked cell, which is what `toClear` is for. `toLand` only
    // answers for someone in the mask's own water, and the margin around it is
    // exactly where a dropped citizen tends to land.
    const out = water.toClear(c.x, c.y);
    const dir = out.d > 0 ? out : water.toLand(c.x, c.y);
    if (!(dir.d > 0)) { c.swimming = false; continue; }
    const stepLen = Math.min(SWIM_SPEED * hours, dir.d + 0.4);
    c.x = clamp(c.x + dir.x * stepLen, 2, 98);
    c.y = clamp(c.y + dir.y * stepLen, 4, 96);
    c.destX = c.x;
    c.destY = c.y;
    c.facing = Math.abs(dir.x) > Math.abs(dir.y) ? (dir.x > 0 ? 'e' : 'w') : (dir.y > 0 ? 's' : 'n');
  }
}

/** Immutable wrapper around `advance`, kept for callers that want snapshots. */
export function tick(world: World, hours = 1): World {
  return advance(structuredClone(world), hours);
}

/** Player-driven construction. Returns the new building, or null if unaffordable. */
export function constructBuilding(world: World, type: string, cost: number, x: number, y: number): Building | null {
  if (world.treasury < cost) return null;
  // A building is Gold and materials both. The panel already greys out what the
  // yard cannot cover, so reaching here without them means the stores moved
  // between the click and the placement.
  if (!materialsInStore(world, type)) return null;
  // Refuse the river rather than quietly moving the building somewhere else:
  // a player who clicked on water should be told no, not have their choice
  // silently overridden.
  if (waterOf(world).blocks(x, y)) return null;
  const need = buildMaterials(type);
  const building: Building = { id: `b${world.counter++}`, type, x: clamp(x, 6, 94), y: clamp(y, 8, 92), workers: [], active: true };
  noteAttention(world);
  spend(world, 'building', cost);
  drawMaterials(world, type);
  world.buildings.push(building);
  // The settlement notices it straight away rather than at the next day roll: a
  // lane is run out to it if it stands off the plan, amenities are laid out
  // around it, and somebody changes trade to work in it.
  if (linkToRoads(world, building)) {
    pushFeed(world, 'build', `A lane was cut through to the new ${type.toLowerCase()}.`);
  }
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  staffNow(world);
  pushFeed(world, 'build', `A new ${type.toLowerCase()} was built for ${cost} Gold, ${need.wood} wood and ${need.stone} stone.`);
  checkUnlocks(world);
  return building;
}

/**
 * How far a building may stand from the nearest road before a lane is run out
 * to it. Roughly the width of the plaza: further than that and people are
 * picking their way across open ground to reach it.
 */
const ROAD_REACH = 9;

/**
 * Run a lane out to a building that has none.
 *
 * A player can place a building anywhere, including well off the plan, and the
 * settlement would simply route people at it across whatever was in the way.
 * Adding a junction beside it and joining it to the nearest one gives them a
 * road to walk, and gives the terrain generator something to draw — the same
 * machinery the original plan uses, so the new lane bends and wears like the
 * rest of them.
 */
function linkToRoads(world: World, building: Building) {
  const layout = world.layout;
  const water = waterOf(world);
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < layout.nodes.length; i++) {
    const [x, y] = layout.nodes[i];
    const d = Math.hypot(x - building.x, y - building.y);
    if (d < best) { best = d; nearest = i; }
  }
  if (nearest < 0 || best <= ROAD_REACH) return false;

  // The junction goes beside the building, not in it: a node inside a footprint
  // is a place nobody can stand, which is what stranded citizens on the plan's
  // own junctions in the first place.
  const away = Math.atan2(layout.nodes[nearest][1] - building.y, layout.nodes[nearest][0] - building.x);
  const gap = (building.type === 'Market' || building.type === 'Town Hall' ? 4.2 : 3.2) + 1.6;
  let nx = clamp(building.x + Math.cos(away) * gap, 3, 97);
  let ny = clamp(building.y + Math.sin(away) * gap, 4, 96);
  if (water.blocks(nx, ny)) {
    const clear = water.toClear(nx, ny);
    if (!(clear.d > 0)) return false;
    nx = clamp(nx + clear.x * (clear.d + 0.6), 3, 97);
    ny = clamp(ny + clear.y * (clear.d + 0.6), 4, 96);
  }

  layout.nodes.push([nx, ny]);
  layout.roles.push('work');
  layout.edges.push([nearest]);
  layout.edges[nearest].push(layout.nodes.length - 1);
  // Somewhere to loiter at the new end of the street, so wanderers use it.
  layout.wanderSpots.push([nx, ny]);
  return true;
}

/** Fill any trade a building has just opened, without waiting for the day to turn. */
function staffNow(world: World) {
  const tally: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) if (c.age >= 16) tally[c.job] = (tally[c.job] ?? 0) + 1;
  fillEmptyTrades(world, tally);
}

/**
 * Pull a building down.
 *
 * Half the timber and stone come back — salvage, not a refund — and the Gold
 * does not, because the Gold went on wages and haulage and those were spent.
 * Anyone working there changes trade at once rather than walking to a building
 * that is no longer standing.
 */
/** Buildings the settlement cannot function without, so the button is never offered. */
export const UNDEMOLISHABLE = ['Market', 'Bank', 'Town Hall'];

export function demolishBuilding(world: World, id: string): { ok: boolean; message: string } {
  const building = world.buildings.find((b) => b.id === id);
  if (!building) return { ok: false, message: 'That building is not there.' };
  // The market is where the settlement eats and trades and the bank is where its
  // Gold lives; pulling either down strands everybody at once, and no amount of
  // salvage is worth that.
  if (UNDEMOLISHABLE.includes(building.type)) {
    return { ok: false, message: `The ${building.type.toLowerCase()} holds the settlement together. It cannot be pulled down.` };
  }
  const home = world.families.find((f) => f.homeId === building.id);
  if (home && home.members.length) {
    return { ok: false, message: `The ${home.name} family lives there. Rehouse them first.` };
  }

  const need = buildMaterials(building.type);
  const wood = Math.floor(need.wood / 2);
  const stone = Math.floor(need.stone / 2);
  world.resources.wood += wood;
  world.resources.stone += stone;
  note(world, 'produced', 'wood', wood);
  note(world, 'produced', 'stone', stone);

  world.buildings = world.buildings.filter((b) => b.id !== id);
  // Anyone who was heading there needs somewhere else to be, now.
  for (const c of world.citizens) {
    if (c.destId === id) { c.destId = undefined; c.path = []; c.dwell = 0; }
    if (c.targetBuildingId === id) c.targetBuildingId = undefined;
  }
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  staffNow(world);
  noteAttention(world);
  pushFeed(world, 'build', `The ${building.type.toLowerCase()} was pulled down. ${wood} timber and ${stone} stone were salvaged.`);
  return { ok: true, message: `Salvaged ${wood} timber and ${stone} stone. The Gold is gone.` };
}

/** Add Gold to the treasury from outside the settlement's own economy. */
export function fundTreasury(world: World, gold: number, note: string) {
  if (!(gold > 0)) return;
  noteAttention(world);
  earn(world, 'vault', gold);
  pushFeed(world, 'market', note);
}

/** Take Gold out of the treasury. Returns false when it cannot cover the draw. */
export function drawFromTreasury(world: World, gold: number, note: string) {
  if (!(gold > 0) || world.treasury < gold) return false;
  noteAttention(world);
  spend(world, 'vault', gold);
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

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

import {
  BASE_PRICES, MARKET_BUFFERS, RESOURCE_LABELS, RESOURCES, shortageOf, targetPrice,
  type Resource,
} from './world/goods';
import { biomeFor, biomeProfile, type BiomeKind } from './world/biomes';
import { BRIDGE_RAMP, DECK_OVERHANG, createLayout, deckAt, onDeck, type WorldLayout } from './world/layout';
import { buildNavGrid, findDetour, lineClear, navKey, type NavGrid } from './world/nav';
import { buildWater, type WaterField } from './world/water';
import { woodedAt } from './world/cover';
import { BASE_EXTENT, extentOf, inset, type Extent } from './world/extent';
import {
  ERAS, OPEN_ERA, eraSpec, nextEra, type EraSpec,
  MAX_CITY_LEVEL, cityLevelSpec, levelForSize, plotCeiling, charterMultiplier, ERA_CITY_LEVEL, BUILDERS_DISCOUNT,
} from './world/eras';
import {
  ANIMAL_LABELS, ANIMAL_PACE, ANIMAL_YIELD, FLEE_RANGE, HERD_CAP, HUNT_RANGE, HUNT_REACH, WATERSIDE, WILDLIFE,
  type Animal, type AnimalKind,
} from './world/wildlife';

export type Terrain = 'fertile' | 'forest' | 'mountain' | 'rocky' | 'coastal' | 'river';
export type Job = 'farmer' | 'woodcutter' | 'fisher' | 'hunter' | 'forager' | 'miner' | 'quarry' | 'miller' | 'baker' | 'carpenter' | 'blacksmith' | 'tailor' | 'unemployed';
export type WorkingJob = Exclude<Job, 'unemployed'>;
export type Activity = 'walking' | 'working' | 'resting' | 'trading' | 'eating' | 'idle';
export type Phase = 'sleeping' | 'athome' | 'working' | 'eating' | 'socialising' | 'wandering' | 'rogue' | 'pursuit' | 'jailed' | 'fleeing';
export type Facing = 'n' | 's' | 'e' | 'w';
export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';
export type Weather = 'Clear' | 'Cloudy' | 'Rain' | 'Storm' | 'Fog' | 'Snow';
export type { Resource };
export { RESOURCES, RESOURCE_LABELS };
export type { Animal, AnimalKind };
export { ANIMAL_LABELS };

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

export type HazardKind = 'fire' | 'blight' | 'wolves' | 'flood' | 'earthquake' | 'tornado' | 'plague';

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
  /** How hard it landed, from a little over nothing to one. */
  severity: number;
  /** Game hours left for a hazard that runs by the hour: the shaking, the funnel. */
  hours?: number;
  /** Where a moving hazard is, and which way it is going. The tornado. */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** How high the water stands, nought to one. The flood. */
  level?: number;
  /** Buildings it has left in ruins, by id. */
  wrecked: string[];
  /** The player has spent Gold against it. */
  fought?: boolean;
  /** Feed lines it has been allowed so far, so a long one does not flood the feed. */
  told?: number;
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
  /**
   * Points to walk to in turn, found round whatever a straight leg of the
   * route would have run into. Empty or absent when the way is clear.
   */
  detour?: [number, number][];
  /** Game hours before a route round an obstacle is looked for again, after one could not be found. */
  navWait?: number;
  /** True when they have no bed and are sleeping out in the open. */
  roughSleeper: boolean;
  /** Cosmetic seed the renderer turns into a stable appearance. Never read by logic. */
  look: number;

  /**
   * How much work they have done at each trade, in days.
   *
   * Kept per trade rather than as one number, so somebody who farmed for a
   * year, spent a winter at the forge and went back to the fields is still a
   * good farmer. It only ever rises: a skill is not forgotten because it was
   * not used this month.
   */
  skills: Partial<Record<WorkingJob, number>>;

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
   * Who they are crossing the settlement to find.
   *
   * Set when somebody short of company sets off toward a friend, so the
   * interface can say "going to find Mira" rather than "wandering", which is
   * the difference between a crowd and a set of people.
   */
  seeking?: string;
  /**
   * The last gathering this person was called to, so the bell rings once.
   * Without it, someone settled at a fire before the meeting was called never
   * re-picks a destination and never goes.
   */
  calledTo?: string;
  /** Held by the player right now: they go where the pointer goes. */
  carried?: boolean;
  /** The animal this hunter is closing on. */
  hunting?: string;
  /**
   * Turned on the settlement: wrecking what they can until the others stop
   * them. `damage` counts the buildings they have brought down, which is what
   * decides whether they are jailed or killed when they are caught.
   */
  rogue?: { since: number; damage: number; targetId?: string; escapes: number; caught?: boolean };
  /** Days left in the jail. */
  jailed?: number;
  /** The rogue this person is going after. */
  chasing?: string;
  /** Hours left in a scuffle, during which nobody moves. */
  scuffle?: number;
  /** Days sick with the plague, from one. */
  sick?: number;
  /** Hours left running for open ground, from an earthquake or a funnel. */
  fleeing?: number;
  /** Carrying a kill back to the store, which is the next place they go. */
  hauling?: boolean;
  /**
   * Swimming back to shore after being set down in the water.
   *
   * Somebody dropped in a river should not stand on it, and should not vanish
   * either. They swim — slowly, in a straight line for the nearest dry ground —
   * and are cold and unhappy about it when they get there.
   */
  swimming?: boolean;
  /**
   * Crossing open water on the ferry, which a Harbour runs. The renderer puts
   * a boat under them. Cleared the moment they step ashore.
   */
  afloat?: boolean;
  /** On a cart from the Stables: a working adult on the move, drawn riding. */
  riding?: boolean;
  /** What they ride, when they do: the era and the town's transport decide. */
  ride?: Ride;
  /**
   * A trade the player trained them for. Held against the settlement's own
   * daily reshuffling for `hold` days from `since`, so a town does not undo
   * the owner's plan the next morning.
   */
  trained?: { job: WorkingJob; since: number; hold: number };
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
  /** A crossing over water people could already walk round, rather than to a new shore. */
  shortcut?: boolean;
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
export interface Building {
  id: string; type: string; x: number; y: number; workers: string[]; active: boolean;
  production?: string;
  /** How badly it is knocked about, nought to one. At one it is a ruin. */
  damage?: number;
  /** Wrecked: out of use until the player rebuilds it. */
  ruined?: boolean;
  /** The era it was raised in, which is the era its body is drawn in until it is improved. */
  era?: number;
  /**
   * How far this building has been improved, 1 to `MAX_BUILDING_LEVEL`.
   *
   * Absent on anything raised before improvement existed, which is why every
   * reader goes through `levelOf` rather than touching it.
   */
  level?: number;
}
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
  /** The animals on the land, which the hunters go after. */
  wildlife: Animal[];
  /** The day's hunting so far: kills, how many the feed has told of, and whether the quiver is full. */
  hunt: { today: number; lines: number; arrows: boolean; game?: number; hides?: number };
  /** The standing decision of the last town meeting, if it is still in force. */
  resolution: Resolution | null;
  /** Everything the settlement's showcases have produced, newest first. */
  artworks: Artwork[];
  unlockedAreas: string[];
  /**
   * Whether the plot's outer belt has been opened for building.
   *
   * The survey leaves a margin round every plot — the last few units on each
   * side — that nothing is built on. An expansion, bought once per plot,
   * opens it: about a fifth more ground, and the settlement's roads and
   * people follow the buildings out into it.
   */
  expanded?: boolean;
  /**
   * Which era the plot is in, 1 for a settlement, and the day it entered it.
   * Absent on a save from before eras existed, which reads as the first.
   */
  era?: number;
  eraSince?: number;
  /**
   * The public works the settlement has paid for: its city level.
   *
   * A city's level is the smaller of what it has paid for here and what its
   * size has earned, plus one; so a town grows into a level and then buys it.
   * Absent on a save from before levels existed, which is read as whatever the
   * size has earned, so nobody who built a city before this loses it.
   */
  works?: { level: number };
  /** Wall-clock time until which a charter or insurance bought for this plot runs. */
  charterUntil?: number;
  insuredUntil?: number;
  buildersUntil?: number;
  /** The banner the plot flies: an emblem, bought as prestige. */
  banner?: string;
  /** The last day the settlement held a festival, so there is one a day at most. */
  festivalDay?: number;
  /** The player has closed the gates: nobody new is taken in until they open them. */
  gatesClosed?: boolean;
  /**
   * What the settlement pays, as a multiple of each trade's standing wage.
   *
   * The one lever a player has over how hard people work. 1 is the going rate;
   * below it the town saves money and gets less done, above it the town spends
   * money and gets a happier, more productive settlement for it.
   */
  wageRate: number;
  /**
   * What the market has sold since anybody last looked.
   *
   * Kept so the interface can tell a player their settlement is trading
   * without making them read the feed for it. Emptied by `takeSales`, which
   * the client calls when it raises a card, so nothing accumulates forever and
   * a world nobody is watching does not build a backlog of good news.
   */
  sales: { gold: number; units: number; best: Resource | null; bestUnits: number };
  /** Accumulates game hours so the market trades on the clock, not per frame. */
  marketClock: number;
  /**
   * What actually moved yesterday, per resource. The renderer fells exactly as
   * many trees as the woodcutters really cut, and the market panel shows real
   * throughput rather than a guess from stock levels.
   */
  flow: { produced: Partial<Record<Resource, number>>; consumed: Partial<Record<Resource, number>> };
  /**
   * The same figures for the day that just closed.
   *
   * Job choice needs them: today's flow is empty at the moment work is handed
   * out, and a stock figure on its own cannot tell a full barn from a barn
   * that is being emptied.
   */
  flowYesterday: { produced: Partial<Record<Resource, number>>; consumed: Partial<Record<Resource, number>> };
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
  /**
   * One-off grants this settlement has already had, by id.
   *
   * Kept on the world rather than in the browser, because the world is what
   * travels between devices: a marker in one browser's storage let a second
   * device hand the same compensation out again.
   */
  grants: string[];
  /**
   * Ground the player has cleared of trees: where, and on what day. The wood
   * grows back over the following days, so the renderer reads this to know
   * which trees to show as stumps after a reload.
   */
  clearings?: [number, number, number][];
  counter: number;
}

/** The day the player last did something here, and what it is worth. */
export interface Stewardship {
  /**
   * Wall-clock time the player last acted here, and real seconds banked toward
   * the next payout.
   *
   * Both are real time on purpose. Everything else in this simulation runs on
   * the game clock, which the player controls: at six times speed a settlement
   * lives a hundred and thirty-five days in a real hour. Paying a daily yield
   * against *that* clock meant the fast-forward button was worth about two and
   * three quarter million $EMERGE an hour. Speed is a way to watch the world
   * sooner, not a way to earn faster.
   */
  lastActionAt: number;
  banked: number;
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
  /**
   * Wall-clock time the yield was last paid up to.
   *
   * The yield is paid for the real time that passed, whether or not the
   * game was open: a player who saw "16,000 a day" and closed the tab for
   * eleven hours was paid 8,800, because accrual used to run only while the
   * page drew frames. Attention still falls the longer the plot goes without
   * a hand on it, so an abandoned world earns the floor and no more.
   */
  accruedAt?: number;
}

/** The headings a day's Gold is booked under. */
export type LedgerLine =
  | 'wages' | 'upkeep' | 'imports' | 'building' | 'works' | 'gear'
  | 'exports' | 'households' | 'food' | 'vault' | 'arena' | 'training' | 'festival';

export const LEDGER_LABELS: Record<LedgerLine, string> = {
  wages: 'Wages',
  upkeep: 'Upkeep',
  imports: 'Imports',
  building: 'Building',
  works: 'Public works',
  gear: 'Bait and arrows',
  exports: 'Exports',
  households: 'Household spending',
  training: 'Training',
  festival: 'Festivals',
  food: 'Food sales',
  vault: 'Vault',
  arena: 'The arena',
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

export const JOB_LABELS: Record<Job, string> = { farmer: 'Farmer', woodcutter: 'Woodcutter', fisher: 'Fisher', hunter: 'Hunter', forager: 'Forager', miner: 'Miner', quarry: 'Quarry worker', miller: 'Miller', baker: 'Baker', carpenter: 'Carpenter', blacksmith: 'Blacksmith', tailor: 'Tailor', unemployed: 'Unemployed' };
export const ACTIVITY_LABELS: Record<Activity, string> = { walking: 'Walking', working: 'Working', resting: 'At home', trading: 'Socialising', eating: 'Eating', idle: 'Idle' };
export const PHASE_LABELS: Record<Phase, string> = { sleeping: 'Asleep', athome: 'At home', working: 'At work', eating: 'Getting food', socialising: 'Socialising', wandering: 'Wandering', rogue: 'Turned on the settlement', pursuit: 'Giving chase', jailed: 'In the jail', fleeing: 'Running for open ground' };

export const JOBS: Record<WorkingJob, { wage: number; output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>>; building: string }> = {
  farmer: { wage: 10, output: { wheat: 10, vegetables: 5 }, building: 'Farm' },
  woodcutter: { wage: 11, output: { wood: 12.5 }, building: 'Woodcutter' },
  fisher: { wage: 11, output: { fish: 9 }, building: 'Fishery' },
  hunter: { wage: 13, output: { game: 5, hides: 2 }, building: 'Lodge' },
  forager: { wage: 9, output: { berries: 8, herbs: 2 }, building: 'Forager' },
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
const marketPrices = BASE_PRICES;
const marketBuffers = MARKET_BUFFERS;
const terrainBonuses: Record<Terrain, Partial<Record<WorkingJob, number>>> = {
  fertile: { farmer: 1.3, forager: 1.1 }, forest: { woodcutter: 1.3, hunter: 1.3, forager: 1.3 }, mountain: { miner: 1.3, hunter: 1.1 },
  rocky: { quarry: 1.25 }, coastal: { fisher: 1.35 }, river: { farmer: 1.15, fisher: 1.2 },
};

/**
 * What the fishing and the hunting cost, on top of wages.
 *
 * Bait is bought: every fisher goes through `BAIT_GOLD` a day, booked under
 * gear. Rods snap — about one day in seven — and a new one is `ROD_WOOD` out
 * of the yard; a fisher whose rod cannot be replaced fishes at half the rate
 * until it can. Hunters go through `ARROW_WOOD` a day, and a quiver the yard
 * cannot fill means lighter kills.
 */
export const BAIT_GOLD = 2;
export const ROD_WOOD = 3;
export const ROD_BREAK_CHANCE = 0.15;
export const ARROW_WOOD = 1;

/**
 * The water for a world.
 *
 * Held here rather than on the world object because it carries lookup closures
 * and `tick()` structured-clones worlds for its callers. Keyed by seed, which
 * is what the water is a function of, and capped so a session that visits many
 * plots does not accumulate fields for all of them.
 */
const waterCache = new Map<string, WaterField>();
export function waterOf(world: { seed: number; biome: BiomeKind; expanded?: boolean }): WaterField {
  // An expanded plot is a different field: the same channels, carried on
  // into the new ground, over a bigger grid.
  const key = `${world.seed}:${world.expanded ? 'x' : ''}`;
  const cached = waterCache.get(key);
  if (cached) return cached;
  const field = buildWater(world.seed, biomeProfile(world.biome), extentOf(world));
  if (waterCache.size >= 12) waterCache.delete(waterCache.keys().next().value as string);
  waterCache.set(key, field);
  return field;
}

export function mulberry32(seed: number) {
  return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/*
 * Where the land ends, for the world being worked on.
 *
 * Every edge in this file used to be a literal — nobody walks past 97, no
 * animal spawns inside 8 of the side — and the plot was always 0–100. An
 * expanded plot is bigger, so those edges come from its extent. Rather than
 * thread the extent through two hundred call sites, the one world being
 * advanced sets it here on the way in: the simulation only ever works on one
 * world at a time, and every exported entry point sets it before it touches
 * anything.
 */
let activeExtent: Extent = BASE_EXTENT;
function useWorld(world: { expanded?: boolean }) { activeExtent = extentOf(world); }
/** Clamp to the land, a margin in from each side. The plot is square, so one helper serves both axes. */
const edge = (v: number, lo: number, hi: number) => clamp(v, activeExtent.x0 + lo, activeExtent.x1 - (100 - hi));
/** A random position across the land, a margin in from each side. */
const across = (rand: () => number, margin: number) => activeExtent.x0 + margin + rand() * (activeExtent.x1 - activeExtent.x0 - margin * 2);

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
  switch (phase) {
    case 'working': return 'working';
    // A rogue at a wall is swinging at it; that is the working animation.
    case 'rogue': return 'working';
    case 'eating': return 'eating';
    case 'socialising': return 'trading';
    case 'wandering': case 'pursuit': case 'fleeing': return 'idle';
    default: return 'resting';
  }
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
  useWorld(world);
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
  // A spot chosen for what it is — a bank to cast from, an animal — rather
  // than a building to stand near, so no ring is scattered round it.
  let exact = false;

  // A new destination means giving up the bench.
  releaseAmenity(world, c);
  if (c.hunting && !(phase === 'working' && c.job === 'hunter')) releasePrey(world, c);

  if (phase === 'sleeping' || phase === 'athome') {
    // A bed if they have one, a bench at the tavern if not, and the square if
    // there is neither. Nobody simply stops existing at night.
    const home = homeOf(world, c);
    if (home) {
      target = home;
      spread = 2.0;
      c.roughSleeper = false;
    } else {
      const shelter = gatheringPlace(world) ?? findBuilding(world, 'Market');
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
    // The outdoor trades run their errand only after a spell at work: a
    // fisher whose first trip of the morning was to the store spent the day
    // on the road and cast for an hour.
    const outdoors = c.job === 'fisher' || c.job === 'hunter' || c.job === 'forager';
    const runErrand = (c.wanderIdx + c.hash) % 3 === 0 && (!outdoors || (c.activity === 'working' && !c.errand));
    target = runErrand ? depot ?? workplace : workplace ?? depot;
    c.errand = runErrand;
    c.wanderIdx = (c.wanderIdx + 1) % Math.max(1, world.layout.wanderSpots.length);

    /*
     * The trades that work out of doors.
     *
     * A fisher's day is spent on the bank, not in the hut; a hunter's in the
     * wood, after something; a forager's out on the wild ground. Sending them
     * indoors made the three most watchable trades in the settlement
     * invisible. They still run the same errand to the store every third trip,
     * which is when the fish, the kill and the basket are seen going in.
     */
    if (c.job === 'fisher' && !runErrand) {
      // The nearest few spots to the hut, not any of them: the far ones are
      // a three-hour walk on a big lake, and a fisher who alternated between
      // ends of the shore spent the afternoon on the road.
      const spots = fishingSpotsOf(world).slice(0, 3);
      if (spots.length) {
        const [sx, sy] = spots[(c.hash + c.wanderIdx) % spots.length];
        target = { x: sx, y: sy };
        exact = true;
      }
    } else if (c.job === 'hunter') {
      releasePrey(world, c);
      if (c.hauling) {
        // Back to the store with the kill, whatever the errand roll said.
        target = depot ?? workplace;
        c.errand = true;
        c.hauling = false;
      } else if (!runErrand) {
        const prey = pickPrey(world, c, workplace);
        if (prey) {
          prey.stalkedBy = c.id;
          c.hunting = prey.id;
          target = { x: prey.x, y: prey.y };
          exact = true;
        }
      }
    } else if (c.job === 'forager' && !runErrand) {
      const spots = forageSpotsOf(world).slice(0, 4);
      if (spots.length) {
        const [sx, sy] = spots[(c.hash + c.wanderIdx) % spots.length];
        target = { x: sx, y: sy };
        exact = true;
      }
    }
  } else if (phase === 'rogue') {
    // At the wall of whatever they mean to wreck, in the open where the
    // settlement can see them and get to them.
    const mark = world.buildings.find((b) => b.id === c.rogue?.targetId);
    if (mark) { target = { x: mark.x, y: mark.y }; spread = 1.0; }
  } else if (phase === 'pursuit') {
    const quarry = world.citizens.find((x) => x.id === c.chasing);
    if (quarry) { target = { x: quarry.x, y: quarry.y }; exact = true; }
  } else if (phase === 'jailed') {
    const cell = findBuilding(world, 'Jail') ?? findBuilding(world, 'Market');
    if (cell) { target = cell; spread = 1.2; }
  } else if (phase === 'fleeing') {
    // The square: open ground, away from walls that might come down.
    target = { x: world.layout.plaza.x, y: world.layout.plaza.y };
    spread = 3.5;
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
      const options = [gatheringPlace(world), findBuilding(world, 'Market'), undefined];
      target = options[c.wanderIdx % options.length];
      spread = 3.0;
    }
  }

  /*
   * Going to find somebody.
   *
   * The one thing a settlement of strangers was missing. People had friends —
   * the bonds were there, and they changed how a conversation went — but
   * nobody ever *went anywhere* because of one. Everybody wandered the same
   * circuit of spots and became friends with whoever happened to be standing
   * on the same one.
   *
   * Now somebody who is short of company and off the clock walks toward their
   * closest friend, if that friend is out of doors and within reach. It costs
   * one lookup, it is the reason two particular people keep ending up in the
   * same corner of the square, and it is what makes a friendship something you
   * can watch rather than read about.
   *
   * Placed above the benches and fires deliberately: somebody who wants company
   * should walk over to their friend rather than sit down on the way. It is
   * also why the threshold is generous — the median citizen sits at ninety-five
   * for company, so a cut-off low enough to mean "lonely" fired for nobody at
   * all, and the behaviour existed without ever once happening.
   */
  if (!target && (phase === 'wandering' || phase === 'socialising') && c.social < 88 && !c.inside) {
    const friend = companionFor(world, c);
    if (friend) {
      target = { x: friend.x, y: friend.y };
      spread = 1.6;
      c.seeking = friend.id;
    } else {
      c.seeking = undefined;
    }
  } else if (phase !== 'socialising') {
    c.seeking = undefined;
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

  const [ox, oy] = exact ? [0, 0] : standingOffset(c.hash + c.wanderIdx, spread);
  c.destX = edge(target.x + ox, 3, 97);
  c.destY = edge(target.y + oy, 5, 95);
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
    if (d < 0.0001) { c.destX = edge(b.x + r, 3, 97); continue; }
    c.destX = edge(b.x + (dx / d) * r, 3, 97);
    c.destY = edge(b.y + (dy / d) * r, 5, 95);
  }
  // And not in the river. `standingOffset` scatters people in a ring around
  // their target, and on a fen or a coast that ring reaches the water; without
  // this they walk to a spot they cannot stand on, get pushed out, and walk
  // back to it — the same loop that footprints used to cause.
  const water = waterOf(world);
  if (water.blocks(c.destX, c.destY)) {
    const out = water.toLand(c.destX, c.destY);
    c.destX = edge(c.destX + out.x * (out.d + 1.2), 3, 97);
    c.destY = edge(c.destY + out.y * (out.d + 1.2), 5, 95);
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
  c.detour = undefined;
  c.navWait = 0;
  c.bestAway = Infinity;
  // How long they stay put once they get there. Long enough at work that the
  // working day is spent working, and staggered across the population so the
  // settlement does not turn over all at once.
  c.dwell = phase === 'working' ? 2.6 + (c.hash % 5) * 0.62
    : phase === 'socialising' ? 1.3 + (c.hash % 4) * 0.55
      : 0.9 + (c.hash % 5) * 0.45;
  if (phase === 'socialising' || phase === 'wandering') c.wanderIdx = (c.wanderIdx + 1) % world.layout.wanderSpots.length;
}

function hasArrived(c: Citizen) { return c.path.length === 0 && !c.detour?.length && Math.hypot(c.destX - c.x, c.destY - c.y) < 0.35; }

export interface Obstacle { x: number; y: number; r: number; id: string }

/** Kept a little tighter than the drawn building so people hug the walls. */
function footprintRadius(b: Building) {
  return FOOTPRINTS[b.type] ?? 3.2;
}
const FOOTPRINTS: Record<string, number> = {
  Market: 4.2, 'Town Hall': 4.2, House: 2.6, School: 3.8, Library: 3.6, Lab: 3.7, Cafe: 3.5,
  Fishery: 3.0, Forager: 2.6,
  Chapel: 3.6, Guildhall: 4.0, Brewery: 3.4, Printer: 3.2, Stables: 3.8, Harbour: 3.6, Monument: 2.6,
  Factory: 4.4, Foundry: 4.0, 'Railway Station': 4.4, Telegraph: 2.8, Gasworks: 4.0,
  Hospital: 4.2, Stadium: 4.8, Supermarket: 4.2, Office: 3.8, 'Bus Depot': 4.2, 'Power Plant': 4.4,
  'Data Centre': 4.2, 'Research Campus': 4.6, 'Vertical Farm': 3.8, 'Pod Hub': 4.0, 'Drone Port': 4.0,
};

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
  // The two footprints they are deepest inside, for the seam case below.
  let first: Obstacle | null = null, second: Obstacle | null = null, firstDepth = 0, secondDepth = 0;

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
    if (depth > firstDepth) { second = first; secondDepth = firstDepth; first = o; firstDepth = depth; }
    else if (depth > secondDepth) { second = o; secondDepth = depth; }
  }

  // The seam. Two footprints that touch push in opposite directions, and the
  // sum is nothing: the citizen stands in the crack between them for as long
  // as it takes somebody to notice — seventeen hours, for one carpenter. The
  // way out of a seam is along it, whichever end is nearer where they are
  // going.
  if (hits >= 2 && first && second && Math.hypot(pushX, pushY) < 0.6 * firstDepth) {
    const ax = second.x - first.x, ay = second.y - first.y;
    const len = Math.hypot(ax, ay) || 1;
    let sx = -ay / len, sy = ax / len;
    if (sx * (tx - c.x) + sy * (ty - c.y) < 0) { sx = -sx; sy = -sy; }
    const reach = firstDepth + 0.35;
    pushX = sx * reach;
    pushY = sy * reach;
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
    c.x = edge(c.x + pushX * k, 2, 98);
    c.y = edge(c.y + pushY * k, 4, 96);
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
    let bestX = edge(c.x + out.x * reach, 2, 98);
    let bestY = edge(c.y + out.y * reach, 4, 96);
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const nx = out.x * cos - out.y * sin;
      const ny = out.x * sin + out.y * cos;
      const x = edge(c.x + nx * reach, 2, 98);
      const y = edge(c.y + ny * reach, 4, 96);
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

function stepCitizen(c: Citizen, hours: number, obstacles: Obstacle[], layout: WorldLayout, water: WaterField, pace = 1) {
  let blocked = false;
  let budget = (c.age < 16 ? 9 : 12.5) * hours * (c.sick ? 0.65 : 1) * pace;
  const startX = c.x, startY = c.y;
  c.moving = false;
  let guard = 0;
  let lastTargetX = c.destX, lastTargetY = c.destY;

  while (budget > 0 && guard++ < 24) {
    // A detour round an obstacle comes before the road, and the road before
    // the last walk to the door.
    const detour = c.detour?.length ? c.detour[0] : null;
    const final = !detour && c.path.length === 0;
    const tx = detour ? detour[0] : final ? c.destX : layout.nodes[c.path[0]][0];
    const ty = detour ? detour[1] : final ? c.destY : layout.nodes[c.path[0]][1];
    lastTargetX = tx; lastTargetY = ty;
    const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
    const reached = () => { if (detour) c.detour!.shift(); else c.path.shift(); };
    if (d < 0.0001) { if (final) break; reached(); continue; }

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
    let nx = edge(c.x + (dx / d) * step, 2, 98);
    let ny = edge(c.y + (dy / d) * step, 4, 96);

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
          const sx = edge(c.x + Math.cos(a) * step, 2, 98);
          const sy = edge(c.y + Math.sin(a) * step, 4, 96);
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
          nx = edge(c.x + cos * step * forward, 2, 98);
          ny = edge(c.y + sin * step * forward, 4, 96);
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
    if (step >= d) { if (final) break; reached(); }
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
      c.x = edge(c.x + sin * pull, 2, 98);
      c.y = edge(c.y - cos * pull, 4, 96);
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

/** The walkability grid for a world, rebuilt only when what it depends on has changed. */
const navCache = new WeakMap<World, NavGrid>();
function navOf(world: World, obstacles: Obstacle[], water: WaterField): NavGrid {
  const key = `${navKey(obstacles, world.layout)}|${world.expanded ? 'x' : ''}${hasFerry(world) ? 'f' : ''}`;
  const held = navCache.get(world);
  if (held && held.key === key) return held;
  const built = buildNavGrid(water, world.layout, obstacles, key, extentOf(world));
  navCache.set(world, built);
  return built;
}

/**
 * Look before walking.
 *
 * If the next straight leg — to the next junction, or to the door — would
 * cross a wall or the water, find a way round now and walk that instead of
 * discovering the wall by being pushed out of it. The route is to the
 * destination itself rather than to the junction: a road leg that is blocked
 * is usually blocked by something built across the road, and the rest of that
 * road is no longer the way.
 */
function lookAhead(world: World, c: Citizen, nav: NavGrid, obstacles: Obstacle[], water: WaterField, hours: number) {
  if (c.detour?.length || hasArrived(c)) return;
  if ((c.navWait ?? 0) > 0) { c.navWait = (c.navWait ?? 0) - hours; return; }
  const node = c.path.length ? world.layout.nodes[c.path[0]] : null;
  const tx = node ? node[0] : c.destX, ty = node ? node[1] : c.destY;
  const allow = c.destId ? obstacles.findIndex((o) => o.id === c.destId) : -1;
  // The grid is coarse and the water is not: a leg the grid calls clear can
  // still cross a channel's margin, so the fine test has the last word.
  if (lineClear(nav, c.x, c.y, tx, ty, allow) && dryLine(water, world.layout, c.x, c.y, tx, ty)) return;
  const route = findDetour(nav, c.x, c.y, c.destX, c.destY, allow);
  if (route) {
    c.detour = route;
    c.path = [];
    c.bestAway = Infinity;
  } else {
    // No way through at all. Try again in a while rather than every frame:
    // the search is bounded but not free, and nothing about the map will
    // have changed in the next tenth of an hour.
    c.navWait = 0.4;
  }
}

function moveCitizens(world: World, hours: number) {
  const obstacles = buildObstacles(world);
  const ferry = hasFerry(world);
  const water = ferry ? ferried(waterOf(world)) : waterOf(world);
  const nav = navOf(world, obstacles, water);
  const ride = rideOf(world);
  const pace = transportBoost(world);
  for (const c of world.citizens) {
    // Held by the player, or swimming for the bank: both are handled elsewhere
    // and every rule below is about walking on land.
    if (c.carried || c.swimming) continue;
    // The ferry stopped running with them on it: a ruined Harbour leaves
    // anyone out on the water swimming for the bank.
    if (c.afloat && !ferry) {
      c.afloat = false;
      c.riding = false;
      c.ride = undefined;
      c.swimming = true;
      c.happiness = Math.max(0, c.happiness - 6);
      continue;
    }
    if (c.age < 16) c.job = 'unemployed';
    // Nobody in a scuffle moves.
    if (c.scuffle && c.scuffle > 0) { c.moving = false; c.activity = 'idle'; continue; }
    let phase = phaseFor(c, world.hour);
    if (c.hunger < 35 && phase !== 'sleeping') phase = 'eating';
    // Trouble outranks the day's routine: the jailed stay in, a rogue is at
    // the walls whatever the hour, their pursuers are after them, and a
    // settlement with the ground moving under it is out in the square.
    if (c.jailed) phase = 'jailed';
    else if (c.rogue) phase = 'rogue';
    else if (c.chasing) phase = 'pursuit';
    else if (c.fleeing && c.fleeing > 0) phase = 'fleeing';
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
      // A hunter who has got to where the animal was.
      if (c.hunting && phase === 'working') huntArrival(world, c);
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
    //
    // And only once walking has actually failed. The landmass map is coarse,
    // and a sliver of bank at a channel's edge can be its own "island" while
    // the walking rules happily let people stand on it: one child spent a
    // morning being carried a hand's width toward the mainland by this and
    // stepping back off it, on every frame, with the stall clock never
    // running because the rescue skipped it. Half an hour of no progress is
    // the test that somebody is truly cut off.
    const standingOn = water.landAt(c.x, c.y);
    if (standingOn >= 0 && !reachable(world, water, standingOn) && c.stalled > 0.5) {
      const back = water.toMainland(c.x, c.y);
      if (back.d > 0) {
        const stride = Math.min(back.d + 0.6, 14 * hours + 0.35);
        c.x = edge(c.x + back.x * stride, 2, 98);
        c.y = edge(c.y + back.y * stride, 4, 96);
        c.moving = true;
        c.activity = 'walking';
        c.stalled += hours;
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

    lookAhead(world, c, nav, obstacles, water, hours);
    // A working adult rides whatever the town offers; nobody rides it onto
    // the ferry.
    const own = ride && c.age >= 16 && phase === 'working' && !c.afloat ? rideFor(ride, c) : null;
    const blocked = stepCitizen(c, hours, obstacles, world.layout, water, own ? RIDE_PACE[own] * pace : 1);
    if (ferry) {
      const wet = waterOf(world).isWater(c.x, c.y) && !onBridge(world.layout, c.x, c.y);
      c.afloat = wet;
    } else if (c.afloat) c.afloat = false;
    c.riding = !!own && c.moving && !c.afloat;
    c.ride = c.riding ? own! : undefined;
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
        c.detour = undefined;
        c.detour = undefined;
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
        // Judged from here, not from nothing: a fresh destination used to
        // reset the closest-yet distance, which counted as progress on the
        // next frame and started the stall clock over. The two-and-a-half
        // hour escape below never fired; people stood in a seam all night
        // being handed new places to go every forty-five minutes.
        c.bestAway = Math.hypot(c.destX - c.x, c.destY - c.y);
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
  useWorld(world);
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
      a.social = edge(a.social + social, 0, 100);
      b.social = edge(b.social + social, 0, 100);
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
  useWorld(world);
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
  useWorld(world);
  const res = world.resources;
  const short = (r: Resource, per: number) => res[r] < world.citizens.length * per;
  const gathering = world.gatherings.find((g) => g.day === world.day && world.hour < g.hour + g.duration);

  const work: Record<WorkingJob, string> = {
    farmer: short('wheat', 2) ? 'The stores are low — everything I cut today goes straight to the mill.' : 'The far field wants turning today.',
    woodcutter: short('wood', 1.5) ? 'The yard is nearly bare. Timber all day.' : 'A dozen loads and I can call it done.',
    fisher: world.treasury < BAIT_GOLD * 4 ? 'No Gold for bait. I will try the shallows with what I have.' : world.weather === 'Storm' ? 'Nothing bites in this. I will cast anyway.' : 'Down to the water before the light is on it.',
    hunter: world.wildlife.length === 0 ? 'The wood has gone quiet. I will walk the far side and see.' : `There is ${ANIMAL_LABELS[world.wildlife[0].kind]} in the wood. I mean to have one.`,
    forager: world.season === 'Winter' ? 'Nothing under the snow but roots. A thin basket today.' : 'The hedges are full. I will be back with a basket by noon.',
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
  useWorld(world);
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
  useWorld(world);
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
  useWorld(world);
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
/**
 * Somebody worth crossing the settlement for.
 *
 * Not `friendsOf`, deliberately. That returns bonds the simulation has marked
 * as friendships, and those are rare on purpose — five out of a hundred and
 * fifty-eight bonds in a town of forty-eight over two months. A behaviour
 * keyed on them fired for nobody at all, which I only found by counting.
 *
 * People do not only seek out their closest friend. They drift toward whoever
 * they are on decent terms with, and toward their own household. So this takes
 * the warmest positive bond available and falls back to family, which
 * everybody has.
 */
export function companionFor(world: World, c: Citizen): Citizen | null {
  useWorld(world);
  const reachable = (other: Citizen | undefined): other is Citizen =>
    !!other && other.id !== c.id && !other.inside && !other.carried && !other.swimming
    && other.age >= 12 && Math.hypot(other.x - c.x, other.y - c.y) < 34;

  let best: { citizen: Citizen; strength: number } | null = null;
  for (const bond of Object.values(world.bonds)) {
    if (bond.rivals || bond.strength <= 0) continue;
    const otherId = bond.a === c.id ? bond.b : bond.b === c.id ? bond.a : undefined;
    if (!otherId) continue;
    const other = world.citizens.find((x) => x.id === otherId);
    if (!reachable(other)) continue;
    // A marked friendship counts for more than an acquaintance of the same
    // nominal strength, which is what keeps real friends the usual answer.
    const weight = bond.strength * (bond.friends ? 2 : 1);
    if (!best || weight > best.strength) best = { citizen: other, strength: weight };
  }
  if (best) return best.citizen;

  const family = world.families.find((f) => f.id === c.familyId);
  const kin = family?.members
    .map((id) => world.citizens.find((x) => x.id === id))
    .find(reachable);
  return kin ?? null;
}

export function friendsOf(world: World, id: string): { citizen: Citizen; strength: number }[] {
  useWorld(world);
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
 * a full turn of the year takes about an hour at 1x and half that at 2x, so
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
  useWorld(world);
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
  useWorld(world);
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

/**
 * Game hours per real second at ordinary speed, mirrored from the client.
 *
 * Only used to guess how much real time a caller meant when it did not say —
 * the client always says.
 */
const HOURS_PER_SECOND_BASE = 0.15;

function starterBuildings(seed: number, layout: WorldLayout, population: number, water: WaterField): Building[] {
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
  // A plan can come back with no work sites at all — one seed in a few
  // hundred, where every candidate stood in water — and indexing an empty
  // list crashed the world before it opened. The trades then go on the house
  // plots, or failing those in a ring round the plaza.
  const sites: [number, number][] = layout.workSites.length ? layout.workSites
    : layout.housePlots.length ? layout.housePlots
      : [0, 1, 2, 3].map((i) => [
        layout.plaza.x + Math.cos(i * Math.PI / 2 + 0.6) * (layout.plaza.r + 7),
        layout.plaza.y + Math.sin(i * Math.PI / 2 + 0.6) * (layout.plaza.r + 7),
      ]);
  // Only as many trades as the settlement can staff and pay for. The lists are
  // written as what the land *could* support; opening every one of them on a
  // desert of twelve people meant a wage bill and an upkeep bill that its
  // exports could never cover, and the treasury drained to nothing by the third
  // week. The rest is ground for the player to build on.
  const affordable = Math.max(2, Math.round(population / 4));
  const profile = biomeFor(seed);
  const trades = profile.trades.slice(0, affordable);

  /*
   * Whatever else it does, a settlement must be able to feed itself.
   *
   * Each biome's list is ordered by what the land is best at, and only the
   * first two or three are affordable to open — so a highland shelf opened
   * with two mines, a deep wood with two woodcutters, and the Farm further
   * down the list never got built. Four of the nine biomes started with no
   * food production of any kind. They did not fail loudly: the opening store
   * of grain lasted months, so the settlement read as healthy while it ate
   * through the last of it, and then died over the following hundred days
   * whatever the player did. Measured on a highland seed: eight people down to
   * none by day 106.
   *
   * So the last affordable trade gives way to the best food trade the land
   * supports. The character survives — a highland plot still opens with a mine
   * and reads as a mining town, and its farm is a poor one because the terrain
   * bonuses say so — but every plot can now eat.
   */
  if (!trades.includes('Farm')) {
    const farm = profile.trades.find((type) => type === 'Farm');
    if (farm) trades[trades.length - 1] = farm;
  }

  // A fishery goes on whichever site is nearest the water. Left to the
  // list's order it landed on the far side of the town, and the fishers
  // walked twenty-eight units to the bank and back and fished for an hour.
  const order = sites.map((_, i) => i);
  const fishery = trades.indexOf('Fishery');
  if (fishery >= 0 && sites.length > 1) {
    const nearest = order.reduce((best, i) =>
      water.distanceToWater(sites[i][0], sites[i][1]) < water.distanceToWater(sites[best][0], sites[best][1]) ? i : best, 0);
    order.splice(order.indexOf(nearest), 1);
    order.splice(fishery % sites.length, 0, nearest);
  }
  trades.forEach((type, i) => {
    const [x, y] = sites[order[i % sites.length]];
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
      buildings[i].x = edge(buildings[i].x + dx[i] * 0.5, 6, 94);
      buildings[i].y = edge(buildings[i].y + dy[i] * 0.5, 8, 92);
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

  const cafe = at('Cafe');
  if (cafe) {
    add('bench', cafe.x - 5.5, cafe.y + 4, 2);
    add('bench', cafe.x + 5.5, cafe.y + 4, 2);
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
  // A new world is the base plot; a save that was expanded says so afterwards.
  useWorld({});
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
      // Founders arrive with a little of their trade behind them: a camp of
      // twelve total novices is a camp that cannot feed itself.
      skills: {},
      livedDays: 0, lifespan: lifespanFor(rand()), warmth: 82 + rand() * 18, seated: false, chilled: true, sheltering: false,
    };
    if (citizen.job !== 'unemployed') {
      citizen.skills[citizen.job as WorkingJob] = 4 + Math.floor(rand() * 12);
    }
    citizens.push(citizen);
    family.members.push(citizen.id);
  }
  const buildings = starterBuildings(seed, layout, count, water);
  // The same guard as the trades: a plan without house plots puts the homes
  // round the plaza rather than failing to open.
  const homes: [number, number][] = layout.housePlots.length ? layout.housePlots
    : [0, 1, 2, 3, 4, 5].map((i) => [
      layout.plaza.x + Math.cos(i * Math.PI / 3) * (layout.plaza.r + 5),
      layout.plaza.y + Math.sin(i * Math.PI / 3) * (layout.plaza.r + 5),
    ]);
  families.forEach((f, i) => {
    const [hx, hy] = homes[i % homes.length];
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
    resources: {
      wheat: 60, vegetables: 30, fish: 0, game: 0, berries: 0, wood: 50, stone: 20, ironOre: 10, wool: 8, hides: 0, herbs: 0,
      flour: 0, bread: 20, furniture: 0, tools: 5, clothing: 10,
    },
    market: createMarket(),
    feed: [], gatherings: [], bonds: {}, projects: [], conversations: [], hazards: [],
    resolution: null, artworks: [],
    unlockedAreas: ['Settlement'],
    era: 1,
    eraSince: 1,
    wageRate: WAGE_STANDARD,
    sales: { gold: 0, units: 0, best: null, bestUnits: 0 },
    marketClock: 0, flow: { produced: {}, consumed: {} },
    flowYesterday: { produced: {}, consumed: {} },
    ledger: emptyLedger(), ledgerYesterday: emptyLedger(),
    stewardship: {
      score: 0, attention: 1, lastActionDay: 1, lastActionAt: Date.now(),
      banked: 0, dailyYield: 0, pending: 0, lifetime: 0,
    },
    grants: [],
    clearings: [],
    wildlife: [],
    hunt: { today: 0, lines: 0, arrows: true },
    counter: 0,
  };
  // The land has its animals before it has its people.
  for (let i = 0; i < Math.round(HERD_CAP[world.biome] * 0.7); i++) spawnAnimal(world, rand);
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
  const tavern = gatheringPlace(world);
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
  useWorld(world);
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
  const food = foodInStore(world);
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
  if (!gatheringPlace(world)) {
    return { want: 'Tavern', text: 'to build somewhere proper to gather' };
  }
  if (!findBuilding(world, 'School') && world.citizens.length >= 14) {
    return { want: 'School', text: 'to open a school, so the young learn their trades sooner' };
  }
  if (!findBuilding(world, 'Clinic') && world.citizens.length >= 20) {
    return { want: 'Clinic', text: 'to open a clinic before the next hard winter' };
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
/**
 * What a person keeps by them before they will spend freely.
 *
 * Above this, money in a purse is money doing nothing for anybody.
 */
const COMFORTABLE_SAVINGS = 110;

/** How much of their spare money a comfortable household spends each day. */
const SPEND_RATE = 0.14;

/**
 * Money going round, rather than piling up in purses.
 *
 * This is the leak that made a settlement structurally loss-making. Wages left
 * the treasury every morning and came back only when somebody bought bread or
 * happened to want a chair — about seven Gold a day against forty-eight paid
 * out — so the difference sat in citizens' pockets forever. Measured over
 * eight settlements: 147 Gold a day in, 158 out, a permanent deficit of ten
 * that only looked survivable because half the payroll was already going
 * unpaid. Any Gold a player deposited was absorbed within days, which is
 * exactly what people were reporting.
 *
 * So people who have more than they need spend some of it, in the settlement,
 * on whatever the settlement has going on. This cannot create Gold — every
 * coin here came out of the treasury as wages — it only stops it falling down
 * a hole.
 */
function householdSpending(world: World) {
  for (const c of world.citizens) {
    if (c.age < 16) continue;
    const spare = c.wallet - COMFORTABLE_SAVINGS;
    if (spare <= 0) continue;
    const spent = spare * SPEND_RATE;
    c.wallet -= spent;
    earn(world, 'households', spent);
    // An evening out is an evening out.
    c.social = Math.min(100, c.social + 1.2);
  }
}

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

/* ------------------------------------------------------------------ *
 * Skill
 *
 * People get better at what they keep doing. A farmer of two hundred days is
 * not a farmer of two, and a settlement that lets its trades settle rather
 * than shuffling everybody every fortnight should have something to show for
 * it.
 *
 * Measured in days of work, not in an abstract score, because that is what it
 * is: turn up, do the work, get better at it. The curve is deliberately slow
 * and it flattens — the difference between a novice and a journeyman is most
 * of the gain, and the last levels are a long grind for a little, which is how
 * getting good at something actually goes.
 * ------------------------------------------------------------------ */

/** The highest anybody gets. */
export const MAX_SKILL_LEVEL = 10;

/** How many days of work the first level takes. Later ones take the square. */
const SKILL_PACE = 2.5;

/** What each level adds to output. Ten levels is a third again as much work. */
const SKILL_STEP = 0.035;

/** What a trade calls somebody, by how long they have done it. */
export const SKILL_TITLES = [
  'Newcomer', 'Apprentice', 'Improver', 'Journeyman', 'Hand',
  'Craftsman', 'Practised', 'Seasoned', 'Expert', 'Master', 'Grandmaster',
];

/** Days of work at a trade, turned into a level from 0 to `MAX_SKILL_LEVEL`. */
export function skillLevel(days: number): number {
  if (!(days > 0)) return 0;
  return Math.min(MAX_SKILL_LEVEL, Math.floor(Math.sqrt(days / SKILL_PACE)));
}

/** How many more days until the next level, or null at the top. */
export function daysToNextLevel(days: number): number | null {
  const level = skillLevel(days);
  if (level >= MAX_SKILL_LEVEL) return null;
  return Math.max(0, Math.ceil(((level + 1) ** 2) * SKILL_PACE - days));
}

/** What one person has done at one trade, in days. */
export const skillDays = (c: Citizen, job: WorkingJob) => c.skills?.[job] ?? 0;

/** What one person is worth at their trade, as a multiple of a novice. */
export function skillOutput(c: Citizen): number {
  if (c.job === 'unemployed') return 1;
  return 1 + skillLevel(skillDays(c, c.job)) * SKILL_STEP;
}

/**
 * The whole settlement's ability at a trade, as a multiple.
 *
 * Averaged over the people actually doing it, so one master among four
 * novices lifts the trade a little rather than a lot.
 */
export function tradeSkill(world: World, job: WorkingJob): number {
  useWorld(world);
  const hands = world.citizens.filter((c) => c.job === job && c.age >= 16);
  if (!hands.length) return 1;
  return hands.reduce((sum, c) => sum + skillOutput(c), 0) / hands.length;
}

/* ------------------------------------------------------------------ *
 * Wages
 *
 * A settlement pays its people every morning, and until now the rate was
 * fixed. This is the player's hand on it.
 *
 * The two directions are deliberately not mirror images, because a lever that
 * is worth pulling one way and neutral the other is not a decision.
 *
 * **Paying less is a worse deal than it looks.** Effort falls faster than the
 * wage bill does — halve the pay and you lose more than half the output — so
 * underpaying is what you do to survive a bad winter, not a way to run a town.
 *
 * **Paying more barely moves the work at all.** That is deliberate, and it was
 * measured rather than guessed: with a generous production bonus, the extra
 * goods sold more than repaid the extra wages — because wages come back to the
 * treasury through the stalls — and generosity became free money. Eight
 * settlements over a hundred and fifty days each said so. What paying well
 * buys is a contented settlement, which is what stewardship is scored on, and
 * it is paid for in Gold that does not all come home.
 * ------------------------------------------------------------------ */

/** The least a settlement may pay, as a multiple of the standing wage. */
export const WAGE_MIN = 0.5;
/** The most it may pay. */
export const WAGE_MAX = 1.6;
/** The going rate. */
export const WAGE_STANDARD = 1;

/** Keep a wage rate inside its bounds, and never let a bad number through. */
export const cleanWageRate = (rate: number) =>
  Number.isFinite(rate) ? clamp(Math.round(rate * 100) / 100, WAGE_MIN, WAGE_MAX) : WAGE_STANDARD;

/**
 * How much work a wage buys, as a multiple of ordinary output.
 *
 * Steeper below the going rate than above it — see above. The floor is
 * deliberately not zero: people short of money still turn up, they just do
 * less, and a settlement that has stopped producing entirely is a bug rather
 * than a hard week.
 */
export function wageEffort(rate: number): number {
  const w = cleanWageRate(rate);
  return w < WAGE_STANDARD
    ? Math.max(0.5, 1 - (WAGE_STANDARD - w) * 0.55)
    : 1 + (w - WAGE_STANDARD) * 0.12;
}

/** What a settlement pays. Refused outside the bounds rather than clamped silently. */
export function setWageRate(world: World, rate: number): boolean {
  useWorld(world);
  const next = cleanWageRate(rate);
  if (next === world.wageRate) return false;
  const raised = next > world.wageRate;
  world.wageRate = next;
  noteAttention(world);
  pushFeed(world, 'work', raised
    ? `Wages were raised to ${Math.round(next * 100)}% of the going rate.`
    : `Wages were cut to ${Math.round(next * 100)}% of the going rate.`);
  return true;
}

/* ------------------------------------------------------------------ *
 * The world market
 *
 * Prices are not a settlement's own opinion of its granary any more. They come
 * from one index the server keeps across every world being played, so bread is
 * dear everywhere at once when bread is short somewhere, and a valley with a
 * full barn has something worth carting out rather than a number that only
 * meant anything to itself.
 *
 * The settlement's own position has not gone anywhere — it is what the
 * settlement reports into the index, and it is still what decides whether this
 * town is buying or selling. What changed is the price it does that at.
 *
 * Kept in a module variable rather than on the world, and deliberately so:
 * every world open in this browser trades at the same prices, including the
 * ones being visited, and a saved world does not carry yesterday's quotes back
 * with it. When there is no index to be had — the relay is down, or this is a
 * lone development machine — everything below falls back to what it always
 * did, and each settlement prices its own stores.
 * ------------------------------------------------------------------ */

interface WorldMarket {
  /** The fixing `prices` belongs to. */
  epoch: number;
  /** How long a fixing stands, in milliseconds. */
  epochMs: number;
  prices: Record<Resource, number>;
  /** The fixing after it, held ready so the changeover needs no round trip. */
  next: Record<Resource, number>;
  /** How far this browser's clock is ahead of the server's. */
  skew: number;
  /** When *this browser* received them, so a lost relay is noticed. */
  received: number;
  /** How many settlements the server read into them. */
  traders: number;
  /** True when the index is the shared one rather than a single instance's. */
  shared: boolean;
}

let worldMarket: WorldMarket | null = null;

/**
 * How long prices are believed after they last arrived.
 *
 * Longer than the poll interval by a good margin, so an ordinary missed request
 * changes nothing, and short enough that a settlement left running against a
 * dead relay goes back to pricing what it can actually see rather than trading
 * all night on figures from this morning.
 */
const WORLD_PRICE_TTL_MS = 5 * 60_000;

/** Take delivery of the world's prices. `null` puts the settlement back on its own. */
export function setWorldPrices(next: {
  epoch: number; epochMs: number; skew: number; traders: number; shared: boolean;
  prices: Record<Resource, number>; next: Record<Resource, number>;
} | null): void {
  if (!next) { worldMarket = null; return; }
  const clean = (source: Record<Resource, number>, fallback: Record<Resource, number> | null) => {
    const out = {} as Record<Resource, number>;
    for (const r of RESOURCES) {
      const value = Number(source?.[r]);
      // A price the server could not give us is not guessed at: that good
      // falls back to local pricing on its own while the rest trade globally.
      if (Number.isFinite(value) && value > 0) out[r] = value;
      else if (fallback && fallback[r] > 0) out[r] = fallback[r];
    }
    return out;
  };
  const prices = clean(next.prices, null);
  worldMarket = {
    epoch: next.epoch,
    epochMs: next.epochMs > 0 ? next.epochMs : 120_000,
    prices,
    next: clean(next.next, prices),
    skew: Number.isFinite(next.skew) ? next.skew : 0,
    received: Date.now(),
    traders: next.traders,
    shared: next.shared,
  };
}

/**
 * Which set of prices is in force at this instant.
 *
 * The whole reason a fixing is handed out with the one after it. A settlement
 * that last asked ninety seconds ago and one that asked five seconds ago are
 * both holding the same two sets, and both work out the same answer from the
 * server's clock rather than from when they happened to ask. Without this,
 * every world quoted whatever the index said at the moment of its own last
 * request, and two towns forty seconds out of step priced bread at 7.39 and
 * 7.46 — which is not a shared market, it is two markets that nearly agree.
 */
function fixing(): Record<Resource, number> | null {
  const m = worldMarket;
  if (!m) return null;
  if (Date.now() - m.received > WORLD_PRICE_TTL_MS) return null;
  const epochNow = Math.floor((Date.now() - m.skew) / m.epochMs);
  if (epochNow === m.epoch) return m.prices;
  if (epochNow === m.epoch + 1) return m.next;
  // Further ahead than the server told us about. The next poll will bring the
  // fixing; until it does, hold the last one we were actually given rather
  // than inventing one.
  if (epochNow > m.epoch + 1) return m.next;
  // Behind what we were told — a clock that jumped. Current is the best answer.
  return m.prices;
}

/** Are we trading on the world's prices, or on our own? */
export function worldPricesLive(): boolean {
  return fixing() !== null;
}

/** What the world pays for a good, or `null` when nobody has said. */
export function worldPriceOf(resource: Resource): number | null {
  return fixing()?.[resource] ?? null;
}

/** Enough for the market panel to say where its figures come from. */
export function worldMarketState(): { live: boolean; traders: number; shared: boolean } {
  const live = worldPricesLive();
  return { live, traders: live ? (worldMarket?.traders ?? 0) : 0, shared: live && !!worldMarket?.shared };
}

/**
 * What this settlement would tell the index, if asked.
 *
 * Its stores, as they stand. The server turns them into a position on its own
 * scale — nothing is normalised here, because a client that did the
 * normalising would be a client that could choose the answer.
 */
export function marketReport(world: World): Partial<Record<Resource, number>> {
  useWorld(world);
  const stocks: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) stocks[r] = Math.max(0, Math.round(world.resources[r]));
  return stocks;
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

  for (const r of RESOURCES) {
    const q = world.market[r], stock = world.resources[r], buffer = marketBuffers[r];
    const old = q.price;

    const abroad = worldPriceOf(r);
    if (abroad !== null) {
      // The world's price, taken as it stands rather than eased toward.
      // Easing here would have meant every settlement quoting a slightly
      // different figure depending on how long its tab had been open, which is
      // the exact thing a shared market is for not doing. The index is already
      // eased on the server, so the line on the chart stays a line.
      q.price = abroad;
    } else {
      // No index to be had. Price what is in the barn, exactly as a settlement
      // did before there was a wider world to ask.
      q.price += (targetPrice(r, shortageOf(r, stock)) - q.price) * Math.min(1, 0.06 * hours);
    }

    // Supply and demand stay this settlement's own: they are what it has too
    // much or too little of, which is what decides whether it is buying or
    // selling and what the panel shows as pressure. Only the price is shared.
    q.supply = Math.max(0, stock - buffer); q.demand = Math.max(0, buffer - stock); q.volume = 0; q.trend = q.price - old;
    // The settlement imports what it cannot make for itself. For goods it does
    // produce, the market only steps in during a real shortage — otherwise it
    // spends the treasury buying back the bread its own bakery is making.
    const importer = !localOutputs.has(r);
    // What this order would cost, and whether the settlement can responsibly
    // afford it — see `importReserve`.
    const essential = ESSENTIAL_IMPORTS.has(r);
    // Never buy food the settlement effectively already has.
    const wellStocked = FOOD.includes(r) && fedFromStores(world);
    // A market day is a market day: stock moves faster in both directions while
    // one is running, which is what makes it worth walking to.
    const pace = busy ? 1.8 : 1;
    if (stock < buffer * (importer ? 0.65 : 0.3)) {
      const qty = Math.min(Math.max(1, Math.round((buffer - stock) * .2 * pace * hours)), Math.max(0, buffer - stock)), cost = qty * q.price;
      // The market keeps something back. Without this it bought whenever it
      // could afford that single order, which meant it bought until the
      // treasury was empty and then kept it empty — a settlement measured over
      // twenty-four days sat between 4 and 274 Gold the whole time, and every
      // Gold a player put in was absorbed within days. Food and firewood may
      // still be bought down to the last coin, because people have to eat and
      // a cold night kills; everything else waits until the town can cover a
      // couple of days of wages and upkeep first.
      const floor = essential ? 0 : importReserve(world);
      if (qty > 0 && !wellStocked && world.treasury - cost >= floor) {
        world.resources[r] += qty; spend(world, 'imports', cost); q.volume += qty;
        if (qty >= 6 && !reported) { reported = true; pushFeed(world, 'market', `The market bought ${qty} ${RESOURCE_LABELS[r].toLowerCase()} for ${cost.toFixed(0)} Gold.`); }
      }
    } else if (stock > buffer * 1.2) {
      const qty = Math.min(Math.max(1, Math.round((stock - buffer) * .25 * pace * hours)), Math.floor(stock - buffer));
      if (qty > 0) {
        const revenue = qty * q.price * marketEdge(world); world.resources[r] -= qty; earn(world, 'exports', revenue); q.volume += qty;
        // Tallied rather than announced one at a time: the market trades every
        // game hour, and a card per sale would be a card every few seconds.
        const tally = world.sales;
        tally.gold += revenue;
        tally.units += qty;
        if (qty > tally.bestUnits) { tally.best = r; tally.bestUnits = qty; }
        if (qty >= 6 && !reported) { reported = true; pushFeed(world, 'market', `The market sold ${qty} ${RESOURCE_LABELS[r].toLowerCase()} for ${revenue.toFixed(0)} Gold.`); }
      }
    }
  }
  worldNews(world);
  householdTrade(world);
}

/**
 * What the other settlements are doing to the price of things.
 *
 * A shared market that nobody can see the working of is just a number that
 * changes on its own. This is the line that makes it legible: once a day, if
 * some good has gone notably dear or notably cheap across the worlds, the feed
 * says so — and says it as news from elsewhere, because that is what it is.
 *
 * Deliberately separate from the trade line above and separately throttled. A
 * settlement that happened to buy six wheat this morning should not lose the
 * one piece of news it had that day to it.
 */
function worldNews(world: World) {
  if (!worldPricesLive()) return;
  if (world.feed.some((e) => e.kind === 'market' && e.day === world.day && e.text.startsWith('Word from'))) return;

  let loudest: { r: Resource; ratio: number } | null = null;
  for (const r of RESOURCES) {
    const price = worldPriceOf(r);
    if (price === null) continue;
    const ratio = price / BASE_PRICES[r];
    // How far from ordinary it is, in either direction.
    const away = Math.abs(Math.log(ratio));
    if (away < Math.log(1.45)) continue;
    if (!loudest || away > Math.abs(Math.log(loudest.ratio))) loudest = { r, ratio };
  }
  if (!loudest) return;

  const good = RESOURCE_LABELS[loudest.r].toLowerCase();
  const stock = world.resources[loudest.r];
  const plenty = stock > marketBuffers[loudest.r];
  const text = loudest.ratio > 1
    ? plenty
      ? `Word from the other settlements: ${good} is scarce everywhere. Ours is worth carting out.`
      : `Word from the other settlements: ${good} is scarce everywhere, and dear to buy.`
    : plenty
      ? `Word from the other settlements: nobody is short of ${good}. Ours will not fetch much.`
      : `Word from the other settlements: ${good} is cheap everywhere. A good week to stock up.`;
  pushFeed(world, 'market', text);
}

/**
 * What a settlement will buy in even when it is poor.
 *
 * People have to eat and a house has to be warm. Everything else — iron,
 * cloth, furniture, tools — can wait for a better week, and waiting is what
 * stops the market emptying the treasury on a settlement's behalf.
 */
const ESSENTIAL_IMPORTS = new Set<Resource>(['wheat', 'vegetables', 'bread', 'wood']);

/**
 * The things people eat, in the order they reach for them.
 *
 * Food is interchangeable at the table — a settlement out of bread eats grain,
 * and out of grain eats vegetables — so what matters is whether there is food,
 * not whether there is bread. The market did not know that. It read an empty
 * bread shelf against a bread-sized buffer and bought bread, every day, in
 * settlements sitting on fourteen surplus wheat a day because they had a mill
 * and no bakery. That single line was most of the money: about sixty Gold a
 * day of a settlement's eighty-six in imports, against eighty-eight in total
 * export income. It is why treasuries sat at nothing and why Gold put in
 * vanished.
 */
const FOOD: Resource[] = ['bread', 'fish', 'game', 'vegetables', 'berries', 'wheat'];

/** Everything in store that people can eat, in portions. */
export function foodInStore(world: { resources: Record<Resource, number> }): number {
  return FOOD.reduce((sum, r) => sum + (world.resources[r] ?? 0), 0);
}

/** How many portions a settlement likes to have in the larder per head. */
const FOOD_PER_HEAD = 6;

/** True when the settlement has enough to eat, whatever form it is in. */
function fedFromStores(world: World): boolean {
  const held = FOOD.reduce((sum, r) => sum + world.resources[r], 0);
  return held >= world.citizens.length * FOOD_PER_HEAD;
}

/** How many days of wages and upkeep the market leaves untouched. */
const IMPORT_RESERVE_DAYS = 2;

/**
 * The Gold the market will not spend.
 *
 * Read from what the settlement is actually committed to — its payroll at the
 * wage it has chosen, and the upkeep on what it has built — rather than a flat
 * number, so a village of eight and a town of forty are each left with a
 * couple of days of their own running costs.
 */
function importReserve(world: World): number {
  const rate = cleanWageRate(world.wageRate);
  const payroll = world.citizens
    .filter((c) => c.age >= 16 && c.job !== 'unemployed')
    .reduce((sum, c) => sum + jobs[c.job as WorkingJob].wage * rate, 0);
  const upkeep = world.buildings
    .filter((b) => b.active)
    .reduce((sum, b) => sum + upkeepOf(b), 0);
  return (payroll + upkeep) * IMPORT_RESERVE_DAYS;
}

/**
 * What has been sold since this was last asked, and clear it.
 *
 * Deliberately destructive: the caller is announcing it, so leaving it in
 * place would announce it again. A world carried over from a save without the
 * field reads as nothing sold, which is right — it was sold before anybody was
 * watching.
 */
export function takeSales(world: World): { gold: number; units: number; best: Resource | null; bestUnits: number } {
  useWorld(world);
  const held = world.sales ?? { gold: 0, units: 0, best: null, bestUnits: 0 };
  world.sales = { gold: 0, units: 0, best: null, bestUnits: 0 };
  return held;
}

/* ------------------------------------------------------------------ *
 * The arena
 * ------------------------------------------------------------------ */

/**
 * Take a stake out of the treasury for a bout.
 *
 * Refuses rather than overdrawing, and books it where the player can see it:
 * the Bank's daily books show exactly what the arena has cost, which is the
 * only honest way to run a thing people bet on.
 */
export function stakeOnBout(world: World, gold: number, on: string): boolean {
  useWorld(world);
  const amount = Math.floor(gold);
  if (!(amount > 0) || world.treasury < amount) return false;
  noteAttention(world);
  spend(world, 'arena', amount);
  pushFeed(world, 'world', `${amount.toLocaleString()} Gold went on ${on} at the colosseum.`);
  return true;
}

/** Pay a winning bet back into the treasury. */
export function settleBout(world: World, gold: number, note: string): void {
  useWorld(world);
  const amount = Math.floor(gold);
  if (!(amount > 0)) return;
  earn(world, 'arena', amount);
  pushFeed(world, 'world', note);
}

/**
 * How fit somebody is for a fight, 0 to 100.
 *
 * Not a hidden combat stat — it is the person as the settlement made them.
 * Somebody rested, fed, warm and in good clothes is somebody who can go a few
 * rounds; somebody who has been sleeping rough on an empty stomach is not.
 * Which means the way to a good fighter is to run a good settlement, and the
 * arena is one more thing stewardship is worth.
 */
export function vigourOf(c: Citizen): number {
  const prime = c.age < 16 ? 0.3 : c.age > 55 ? 0.62 : c.age > 42 ? 0.85 : 1;
  const body = (c.rest * 0.3 + c.hunger * 0.3 + c.warmth * 0.25 + c.clothing * 0.15) / 100;
  return Math.round(edge(body * prime * 100, 0, 100));
}

/* ------------------------------------------------------------------ *
 * Civic buildings
 *
 * None of these employs anybody or makes anything. Each changes a rate the
 * whole settlement runs at, and all of them cost upkeep, so raising one is a
 * bet that the rate is worth the Gold. Every effect is a plain number here so
 * the wiki can quote it.
 * ------------------------------------------------------------------ */

/** True when the settlement has a working building of this kind. */
export const hasCivic = (world: World, type: string) =>
  world.buildings.some((b) => b.type === type && b.active);

/** School and library: how much faster a day at the bench teaches. */
export const SCHOOL_LEARNING = 0.35;
/** A tavern is an evening with the town in it; a monument is something to be proud of. */
export const TAVERN_SOCIAL = 2;
export const MONUMENT_PRIDE = 2;
export const LIBRARY_LEARNING = 0.15;
/**
 * How strongly a civic building does its job: nothing without one, its full
 * effect at level one, and a quarter more with every improvement. This is
 * what improving a school, a clinic or a cafe is for.
 */
export const LEVEL_BOOST = 0.25;
export function civicStrength(world: World, type: string): number {
  const b = world.buildings.find((x) => x.type === type && x.active && !x.ruined);
  return b ? 1 + LEVEL_BOOST * (levelOf(b) - 1) : 0;
}
/** The highest level among buildings of these types that stand, or 0. */
const bestLevelOf = (world: World, types: string[]) =>
  world.buildings.filter((b) => types.includes(b.type) && b.active && !b.ruined).reduce((m, b) => Math.max(m, levelOf(b)), 0);
/** Exports sell for MARKET_EDGE more per level of the market. */
export const MARKET_EDGE = 0.05;
export const marketEdge = (world: World) => 1 + MARKET_EDGE * Math.max(0, bestLevelOf(world, ['Market']) - 1);
/** The bank keeps the books: every building's upkeep BANK_RELIEF cheaper per level. */
export const BANK_RELIEF = 0.05;
export const bankRelief = (world: World) => 1 - BANK_RELIEF * Math.max(0, bestLevelOf(world, ['Bank']) - 1);
/** The town hall keeps order: stewardship quality TOWN_HALL_ORDER better per level. */
export const TOWN_HALL_ORDER = 0.02;
export const townHallOrder = (world: World) => TOWN_HALL_ORDER * Math.max(0, bestLevelOf(world, ['Town Hall']) - 1);
/** Transport: whatever people ride goes TRANSPORT_PACE faster per level of the building that provides it. */
export const TRANSPORT_PACE = 0.1;
export const TRANSPORT_TYPES = ['Stables', 'Railway Station', 'Bus Depot', 'Pod Hub'];
export const transportBoost = (world: World) => 1 + TRANSPORT_PACE * Math.max(0, bestLevelOf(world, TRANSPORT_TYPES) - 1);

export function learningRate(world: World): number {
  useWorld(world);
  return 1 + SCHOOL_LEARNING * civicStrength(world, 'School') + LIBRARY_LEARNING * civicStrength(world, 'Library')
    + GUILDHALL_LEARNING * civicStrength(world, 'Guildhall') + PRINTER_LEARNING * civicStrength(world, 'Printer')
    + TELEGRAPH_LEARNING * civicStrength(world, 'Telegraph') + DATA_CENTRE_LEARNING * civicStrength(world, 'Data Centre')
    + CAMPUS_LEARNING * civicStrength(world, 'Research Campus');
}

/** Lab: better methods, applied to every trade's output. */
export const LAB_METHODS = 0.1;
/** The later eras' industry: what a factory, a foundry, a power plant and a research campus add to every trade's output. */
export const FACTORY_METHODS = 0.15;
export const FOUNDRY_METHODS = 0.1;
export const POWER_METHODS = 0.15;
export const CAMPUS_METHODS = 0.2;
export const methodBonus = (world: World) => 1 + LAB_METHODS * civicStrength(world, 'Lab')
  + FACTORY_METHODS * civicStrength(world, 'Factory') + FOUNDRY_METHODS * civicStrength(world, 'Foundry')
  + POWER_METHODS * civicStrength(world, 'Power Plant') + CAMPUS_METHODS * civicStrength(world, 'Research Campus');

/** Cafe, studio, library: what they put back into people, every day. */
export const CAFE_SOCIAL = 1.6;
export const CHAPEL_SOCIAL = 0.8;
export const CHAPEL_PURPOSE = 0.6;
export const BREWERY_SOCIAL = 1.4;
export const PRINTER_PURPOSE = 0.5;
/** How much faster a trade is learned with a guildhall or a printer in town. */
export const GUILDHALL_LEARNING = 0.3;
export const PRINTER_LEARNING = 0.1;
export const TELEGRAPH_LEARNING = 0.1;
export const DATA_CENTRE_LEARNING = 0.4;
export const CAMPUS_LEARNING = 0.3;
/** The later eras' civic buildings: what they put back into people each day. */
export const TELEGRAPH_SOCIAL = 0.5;
export const TELEGRAPH_PURPOSE = 0.4;
export const STADIUM_SOCIAL = 1.8;
export const SUPERMARKET_HUNGER = 1.5;
export const OFFICE_PURPOSE = 0.8;
export const VERTICAL_FARM_HUNGER = 2.5;
export const DRONE_PORT_SOCIAL = 0.4;
export const DRONE_PORT_PURPOSE = 0.6;
/**
 * Smog. An industrial town without a Gasworks burns everything in the open,
 * and everybody feels it: a slow drain on happiness that the Gasworks
 * clears, and that the modern era leaves behind for good.
 */
export const SMOG_HAPPINESS = 0.9;
export const smogged = (world: World) => eraOf(world) === 3 && !hasCivic(world, 'Gasworks');
export const STUDIO_PURPOSE = 1.5;
export const LIBRARY_PURPOSE = 0.6;

/** Clinic: how much of the daily risk of death it takes away. A hospital takes more. */
export const CLINIC_SURVIVAL = 0.45;
export const HOSPITAL_SURVIVAL = 0.65;
export const HOSPITAL_CARE = 0.25;
/** Whether the town has somewhere to be treated, and how well. */
export const hasCare = (world: World) => hasCivic(world, 'Clinic') || hasCivic(world, 'Hospital');
export const careOf = (world: World) => Math.min(0.6, hasCivic(world, 'Hospital') ? HOSPITAL_CARE * civicStrength(world, 'Hospital') : hasCivic(world, 'Clinic') ? CLINIC_CARE * civicStrength(world, 'Clinic') : 0);
export const survivalOf = (world: World) => Math.min(0.9, hasCivic(world, 'Hospital') ? HOSPITAL_SURVIVAL * civicStrength(world, 'Hospital') : hasCivic(world, 'Clinic') ? CLINIC_SURVIVAL * civicStrength(world, 'Clinic') : 0);

/** Lab and clinic: what they add to readiness for the hazards they can see coming. */
export const LAB_WARNING = 0.12;
export const CLINIC_CARE = 0.15;

/**
 * Where the settlement gathers when it has nowhere built for it: the tavern
 * first, the cafe when there is no tavern.
 */
export function gatheringPlace(world: World): Building | undefined {
  useWorld(world);
  return findBuilding(world, 'Tavern') ?? findBuilding(world, 'Cafe');
}

/* ------------------------------------------------------------------ *
 * Housing
 * ------------------------------------------------------------------ */

/**
 * Put homeless families into empty houses.
 *
 * A family that arrived, or formed, when every house was full was written
 * down with no home — and then nothing ever looked again. The settlement
 * would raise house after house, the feed would say so, and the same people
 * went on sleeping at the tavern and saying they needed somewhere to live,
 * because the only moment anybody was ever matched to a house was the moment
 * they appeared. This runs every morning and the moment a house is raised.
 *
 * Empty families — everybody in them dead or married out — give their house
 * up first, or a town of ghosts would keep the living on the street.
 */
export function rehouse(world: World): number {
  useWorld(world);
  const alive = new Set(world.citizens.map((c) => c.id));
  for (const f of world.families) {
    f.members = f.members.filter((id) => alive.has(id));
    if (!f.members.length) f.homeId = '';
  }
  const standing = (id: string) => world.buildings.some((b) => b.id === id && b.type === 'House' && b.active);
  // How many people each house already sleeps. A house is not one family's:
  // it holds as many as it has room for, so a newcomer who came alone shares
  // a roof rather than taking a whole house for one bed. "One house, one
  // person" was the single most-asked question in the feedback.
  const sleeping = new Map<string, number>();
  for (const f of world.families) if (f.members.length && standing(f.homeId)) sleeping.set(f.homeId, (sleeping.get(f.homeId) ?? 0) + f.members.length);
  const houses = world.buildings.filter((b) => b.type === 'House' && b.active);
  const roomIn = (b: Building) => houseRoom(b) - (sleeping.get(b.id) ?? 0);
  // The largest family first: the most people off the street per house.
  const homeless = world.families
    .filter((f) => f.members.length && !standing(f.homeId))
    .sort((a, b) => b.members.length - a.members.length);
  let moved = 0;
  for (const family of homeless) {
    // The house with the least room that still fits them, so big families
    // do not scatter the small ones. Failing that, the emptiest house that
    // is not full: a family may squeeze in one over.
    const fits = houses.filter((b) => roomIn(b) >= family.members.length).sort((a, b) => roomIn(a) - roomIn(b));
    const house = fits[0] ?? houses.filter((b) => roomIn(b) > 0).sort((a, b) => roomIn(b) - roomIn(a))[0];
    if (!house) break;
    family.homeId = house.id;
    sleeping.set(house.id, (sleeping.get(house.id) ?? 0) + family.members.length);
    moved += family.members.length;
    pushFeed(world, 'social', `The ${family.name} family moved into ${sleeping.get(house.id)! > family.members.length ? 'a shared house' : 'the new house'}.`);
  }
  return moved;
}

/* ------------------------------------------------------------------ *
 * The plot helper
 *
 * What to build next, and why, read off the settlement itself. Everything
 * here is a condition the player could find for themselves in the panels;
 * the helper's job is to have found it already and put it in order.
 * ------------------------------------------------------------------ */

export interface Advice {
  /** What to do: raise a building, improve one, or move a lever. */
  kind: 'build' | 'improve' | 'wages' | 'rebuild';
  /** The building type, where there is one. */
  type?: string;
  /** For an improvement, which building. */
  buildingId?: string;
  title: string;
  /** What in the settlement is asking for it. */
  why: string;
  /** What it will do, in plain words. */
  gain: string;
}

export function adviseBuild(world: World): Advice[] {
  useWorld(world);
  // Nothing from an era the plot has not reached is suggested, or the
  // settlement would keep asking for a chapel it cannot have.
  return adviseBuildAll(world).filter((a) => a.kind !== 'build' || !a.type || allowedInEra(world, a.type));
}

function adviseBuildAll(world: World): Advice[] {
  const out: Advice[] = [];
  const adults = world.citizens.filter((c) => c.age >= 16);
  const people = world.citizens.length;
  const has = (type: string) => world.buildings.some((b) => b.type === type);
  const count = (type: string) => world.buildings.filter((b) => b.type === type && b.active).length;
  const r = world.resources;
  const supported = new Set(biomeProfile(world.biome).trades);

  // Ruins first: nothing else on the list matters as much as a building the
  // settlement already paid for lying in a heap.
  for (const b of world.buildings.filter((x) => x.ruined)) {
    const cost = rebuildCost(b);
    out.push({ kind: 'rebuild', type: b.type, buildingId: b.id, title: `Rebuild the ${b.type.toLowerCase()}`,
      why: b.type === 'House' ? 'It is a ruin, and the family that lived there has no roof.' : 'It is a ruin: out of use until it is raised again.',
      gain: `${cost.gold} Gold, ${cost.wood} timber and ${cost.stone} stone, about six tenths of new.` });
  }
  const homeless = adults.filter((c) => !homeOf(world, c)).length;
  if (homeless > 0) {
    out.push({ kind: 'build', type: 'House', title: 'Raise a house',
      why: `${homeless} ${homeless === 1 ? 'adult has' : 'adults have'} nowhere to live and are sleeping rough.`,
      gain: 'Housing is a quarter of stewardship, and people with a bed rest twice as fast.' });
  } else if (people >= housingRoom(world)) {
    out.push({ kind: 'build', type: 'House', title: 'Raise a house',
      why: `${people} people in ${count('House')} houses is full, and nobody moves to a town with no spare roof.`,
      gain: 'Room for the next family to arrive. An improved house sleeps more, too.' });
  }

  const food = foodInStore(world);
  if (food < people * 2.5) {
    out.push({ kind: 'build', type: 'Farm', title: 'Break more ground',
      why: `${Math.round(food)} food in store is about ${(food / Math.max(1, people)).toFixed(1)} days for ${people} people.`,
      gain: 'Fed people are a quarter of stewardship, and the market stops buying bread at a premium.' });
  }
  if (food < people * 4 && supported.has('Fishery') && !has('Fishery')) {
    out.push({ kind: 'build', type: 'Fishery', title: 'Cast from the shore',
      why: `${Math.round(food)} food in store, and water at the edge of the settlement nobody fishes.`,
      gain: 'Fish feeds people and sells at the market. Bait costs a little Gold, rods a little timber.' });
  }
  const herd = world.wildlife.filter((a) => a.state !== 'down').length;
  if (herd >= 5 && supported.has('Lodge') && !has('Lodge') && people >= 8) {
    out.push({ kind: 'build', type: 'Lodge', title: 'Open a hunting lodge',
      why: `${herd} animals on the land and nobody hunting them.`,
      gain: 'Game is a meal and hides sell dear. Hunters also keep the wolves further off.' });
  }
  if (supported.has('Forager') && !has('Forager') && people >= 10 && food < people * 5) {
    out.push({ kind: 'build', type: 'Forager', title: 'Send foragers out',
      why: 'The wild ground round the settlement goes unpicked.',
      gain: 'Berries feed people for nothing but a wage, and herbs are the dearest thing a small town sells.' });
  }
  if (r.wood < 22 && !has('Woodcutter')) {
    out.push({ kind: 'build', type: 'Woodcutter', title: 'Put hands to the timber',
      why: `${Math.round(r.wood)} wood in the yard, and nobody felling.`,
      gain: 'Every building and every winter fire is timber; without it the town stops.' });
  }

  // Chains with a link missing: something piling up that a trade would turn
  // into something worth more.
  const chain: [Resource, number, string, string][] = [
    ['wheat', 40, 'Mill', 'Flour sells for more than grain, and it is what the bakery needs.'],
    ['flour', 20, 'Bakery', 'Bread is the settlement\u2019s own food rather than an import.'],
    ['ironOre', 15, 'Blacksmith', 'Tools sell well and lift every trade that uses them.'],
    ['wool', 8, 'Tailor', 'Clothing is a need people pay for every winter.'],
    ['wood', 90, 'Carpenter', 'Furniture is the highest-priced thing a forest town makes.'],
  ];
  for (const [res, at, type, gain] of chain) {
    if ((r[res] ?? 0) >= at && !has(type) && supported.has(type)) {
      out.push({ kind: 'build', type, title: `Open a ${type.toLowerCase()}`,
        why: `${Math.round(r[res])} ${RESOURCE_LABELS[res].toLowerCase()} is sitting in store with nothing to turn it into.`,
        gain });
    }
  }

  if (!has('Storage') && world.buildings.length >= 6) {
    out.push({ kind: 'build', type: 'Storage', title: 'Build a store',
      why: 'The town has grown and keeps no surplus anywhere.',
      gain: 'Readiness for blight, and room for a harvest to be put by.' });
  }
  if (!has('Tavern') && !has('Cafe') && people >= 10) {
    out.push({ kind: 'build', type: 'Cafe', title: 'Give them somewhere to meet',
      why: `${people} people and nowhere to gather but the market.`,
      gain: 'Company every day, and gatherings — which are what turn neighbours into friends.' });
  }
  if (people >= 14 && !has('School')) {
    out.push({ kind: 'build', type: 'School', title: 'Open a school',
      why: `${adults.length} adults learning their trades the slow way.`,
      gain: `Everybody learns ${Math.round(SCHOOL_LEARNING * 100)}% faster, and skill is output.` });
  }
  const social = people ? world.citizens.reduce((sum, c) => sum + c.social, 0) / people : 100;
  const purpose = people ? world.citizens.reduce((sum, c) => sum + c.purpose, 0) / people : 100;
  if (social < 45 && !has('Cafe')) {
    out.push({ kind: 'build', type: 'Cafe', title: 'Open a cafe',
      why: `Company is the lowest need in town, at ${Math.round(social)}%.`,
      gain: `Everybody gains ${CAFE_SOCIAL} company a day. Happiness is a fifth of stewardship.` });
  }
  if (purpose < 45 && !has('Studio')) {
    out.push({ kind: 'build', type: 'Studio', title: 'Open a studio',
      why: `Purpose is the lowest need in town, at ${Math.round(purpose)}%.`,
      gain: `Everybody gains ${STUDIO_PURPOSE} purpose a day, and purpose is what keeps people at their trades.` });
  }
  if (people >= 20 && !has('Clinic')) {
    out.push({ kind: 'build', type: 'Clinic', title: 'Open a clinic',
      why: `${people} people and no clinic; the next hard winter will take somebody.`,
      gain: `Nearly half the daily risk of death gone.` });
  }
  if (!has('Lab') && world.treasury > 3000 && world.buildings.filter((b) => b.production !== undefined || JOB_BUILDINGS.has(b.type)).length >= 4) {
    out.push({ kind: 'build', type: 'Lab', title: 'Open a lab',
      why: 'Four trades or more, all working the old way.',
      gain: `Every trade gets ${Math.round(LAB_METHODS * 100)}% more out of the same day, and trouble is seen coming.` });
  }

  // Improve the busiest workshop once there is Gold to spare.
  if (world.treasury > 2500) {
    const busiest = world.buildings
      .filter((b) => JOB_BUILDINGS.has(b.type) && b.active && levelOf(b) < MAX_BUILDING_LEVEL)
      .sort((a, b) => b.workers.length - a.workers.length)[0];
    if (busiest) {
      const cost = upgradeCost(busiest);
      out.push({ kind: 'improve', type: busiest.type, buildingId: busiest.id, title: `Improve the ${busiest.type.toLowerCase()}`,
        why: `It is the busiest workshop in town and still at level ${levelOf(busiest)}.`,
        gain: `${Math.round(OUTPUT_PER_LEVEL * 100)}% more from it for ${cost?.gold ?? 0} Gold, against ${Math.round(UPKEEP_PER_LEVEL * 100)}% more upkeep.` });
    }
  }

  const happiness = people ? world.citizens.reduce((sum, c) => sum + c.happiness, 0) / people : 100;
  if (world.wageRate < WAGE_STANDARD && happiness < 60) {
    out.push({ kind: 'wages', title: 'Pay the going rate',
      why: `Wages are at ${Math.round(world.wageRate * 100)}% and happiness is ${Math.round(happiness)}%.`,
      gain: 'Underpaid people do less and lose heart; over a long run it costs more than it saves.' });
  }

  return out.slice(0, 4);
}

/** The trade buildings, for telling a workshop from a house. */
const JOB_BUILDINGS = new Set(Object.values(JOBS).map((j) => j.building));

/** Everybody a settlement could reasonably send to the arena, best first. */
export function fightersOf(world: World): Citizen[] {
  useWorld(world);
  return world.citizens
    .filter((c) => c.age >= 16 && !c.carried)
    .sort((a, b) => vigourOf(b) - vigourOf(a));
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
/**
 * How much the settlement wants one more person doing this work.
 *
 * Demand reads two things about every resource the trade makes: how much is in
 * store, and what happened to it yesterday. The second half is not decoration.
 * Judged on stock alone, a barn holding a hundred wheat reads as "we have
 * plenty" even when nobody is farming and the hundred is being eaten — so a
 * settlement would put its last farmer down the mine, keep reading a full barn
 * every morning, and starve over the following hundred days with the granary
 * figure sliding one loaf at a time. A trade whose output is draining is wanted
 * however full the store looks; one with a surplus flow is not, however empty.
 */
function jobScore(world: World, j: WorkingJob) {
  const spec = world.terrain.map((t) => terrainBonuses[t][j] || 1).reduce((a, b) => a + b, 0) / world.terrain.length;
  const recipe = jobs[j];

  let demand = 0.6;
  for (const key of Object.keys(recipe.output) as Resource[]) {
    const buffer = Math.max(1, marketBuffers[key]);
    const stock = clamp((buffer - world.resources[key]) / buffer, -0.4, 1.5);
    const made = world.flowYesterday?.produced[key] ?? 0;
    const used = world.flowYesterday?.consumed[key] ?? 0;
    // Weighted above the stock reading, because the flow is the half that says
    // where the settlement is heading rather than where it has been.
    const drain = clamp((used - made) / buffer, -0.5, 1.5);
    demand += (stock + drain * 1.8) * 1.3;

    // What the wider world will pay for it.
    //
    // This is how a global market reaches the people rather than stopping at
    // the price panel. A settlement with a full barn used to have no reason to
    // put anybody in the fields; if wheat is dear across every world, it now
    // has one, and the trades people take up shift toward what is short
    // somewhere else. Weighted below the settlement's own hunger on purpose —
    // a town that cannot feed itself should feed itself first, whatever the
    // price of tools is doing abroad.
    const abroad = worldPriceOf(key);
    if (abroad !== null) {
      demand += clamp(abroad / BASE_PRICES[key] - 1, -0.55, 2.5) * 1.1;
    }
  }

  let feasible = 1;
  for (const [key, amount] of Object.entries(recipe.input ?? {})) {
    if (world.resources[key as Resource] < (amount as number) * 2) feasible *= 0.3;
  }

  return Math.max(0.05, spec * Math.max(0.15, demand) * feasible);
}

/** How many workers a job can usefully employ, given the buildings that exist. */
function jobCapacity(world: World, j: WorkingJob) {
  const base = j === 'miner' ? 3 : 2;
  // Summed per building rather than multiplied by a count, because two sheds
  // and one improved workshop are no longer the same thing.
  return world.buildings
    .filter((b) => b.type === jobs[j].building && b.active)
    .reduce((room, b) => room + buildingCapacity(b, base), 0);
}

/**
 * What improving a building does, said in one line on its card. Every type
 * has an answer: a player who pays for an improvement is owed one.
 */
export function upgradeEffect(type: string): string {
  if (type === 'House') return `${HOUSE_ROOM_PER_LEVEL} more beds`;
  if (WORKPLACES.has(type)) return `${Math.round(OUTPUT_PER_LEVEL * 100)}% more output`;
  const quarter = `a quarter stronger`;
  const effects: Record<string, string> = {
    Storage: 'half again the readiness a store gives',
    Market: `exports sell for ${Math.round(MARKET_EDGE * 100)}% more`,
    Bank: `every building's upkeep ${Math.round(BANK_RELIEF * 100)}% cheaper`,
    'Town Hall': `stewardship quality ${Math.round(TOWN_HALL_ORDER * 100)}% better`,
    Jail: 'rogue odds halved again, one fewer building a rogue can wreck',
    School: `learning ${quarter}`, Library: `learning and its daily lift ${quarter}`, Guildhall: `learning ${quarter}`,
    Printer: `learning and its daily lift ${quarter}`, Telegraph: `learning and its daily lift ${quarter}`,
    'Data Centre': `learning ${quarter}`, 'Research Campus': `learning and methods ${quarter}`,
    Lab: `methods ${quarter}`, Factory: `methods ${quarter}`, Foundry: `methods ${quarter}`, 'Power Plant': `methods ${quarter}`,
    Clinic: `care ${quarter}`, Hospital: `care ${quarter}`,
    Cafe: `its daily lift ${quarter}`, Tavern: `its daily lift ${quarter}`, Studio: `its daily lift ${quarter}`, Chapel: `its daily lift ${quarter}`,
    Brewery: `its daily lift ${quarter}`, Stadium: `its daily lift ${quarter}`, Supermarket: `its daily lift ${quarter}`, Office: `its daily lift ${quarter}`,
    'Vertical Farm': `its daily lift ${quarter}`, 'Drone Port': `its daily lift ${quarter}`, Monument: `its daily pride ${quarter}`,
    Stables: `people travel ${Math.round(TRANSPORT_PACE * 100)}% faster`, 'Railway Station': `people travel ${Math.round(TRANSPORT_PACE * 100)}% faster`,
    'Bus Depot': `people travel ${Math.round(TRANSPORT_PACE * 100)}% faster`, 'Pod Hub': `people travel ${Math.round(TRANSPORT_PACE * 100)}% faster`,
    Harbour: 'nothing yet: the ferry does its one job', Gasworks: 'nothing yet: it keeps the smog off and that is all',
  };
  return effects[type] ?? 'nothing yet';
}

/** Posts at one workplace, by its level. Three at a mine, two elsewhere. */
export function buildingPosts(b: Building) {
  const base = b.type === 'Mine' ? 3 : 2;
  return buildingCapacity(b, base);
}
/** How many people a trade can employ across its standing workplaces. */
export const tradeCapacity = (world: World, job: WorkingJob) => { useWorld(world); return jobCapacity(world, job); };
/** Posts nobody fills, in a trade. */
export function openPosts(world: World, job: WorkingJob) {
  const working = world.citizens.filter((c) => c.job === job).length;
  return Math.max(0, jobCapacity(world, job) - working);
}

/*
 * Targeted training.
 *
 * The settlement picks trades for itself, and mostly picks well; but a town
 * with thirty workplaces and one owner who can see what is short needs a
 * lever, not a suggestion. Training moves one person into a trade now, for
 * Gold, gives them a head start in skill, and holds them there for a while
 * against the daily reshuffle. It is a Gold sink on purpose.
 */
const FOOD_TRADES = new Set<Job>(['farmer', 'fisher', 'hunter', 'forager']);
/** Whether somebody is still held to a trade the owner trained them for. */
export const heldTrade = (world: World, c: Citizen) => !!c.trained && world.day - c.trained.since < c.trained.hold;
export const TRAIN_COST_GOLD = 60;
export const TRAIN_HOLD_DAYS = 40;
/** The head start, in days of skill; the School doubles it. */
export const TRAIN_SKILL_DAYS = 12;

export function trainCitizen(world: World, id: string, job: WorkingJob): { ok: boolean; message: string } {
  useWorld(world);
  const c = world.citizens.find((x) => x.id === id);
  if (!c) return { ok: false, message: 'Nobody by that name.' };
  if (!jobs[job]) return { ok: false, message: 'That is not a trade.' };
  if (c.age < 16) return { ok: false, message: `${c.name} is too young to work.` };
  if (c.job === job) return { ok: false, message: `${c.name} is already a ${JOB_LABELS[job].toLowerCase()}.` };
  if (jobCapacity(world, job) <= 0) return { ok: false, message: `There is no ${jobs[job].building.toLowerCase()} for a ${JOB_LABELS[job].toLowerCase()} to work at.` };
  if (world.treasury < TRAIN_COST_GOLD) return { ok: false, message: `Training costs ${TRAIN_COST_GOLD} Gold, and the treasury holds ${Math.floor(world.treasury)}.` };
  spend(world, 'training', TRAIN_COST_GOLD);
  const was = c.job;
  c.job = job;
  c.trained = { job, since: world.day, hold: TRAIN_HOLD_DAYS };
  c.wage = jobs[job].wage * cleanWageRate(world.wageRate);
  const head = TRAIN_SKILL_DAYS * (hasCivic(world, 'School') ? 2 : 1);
  c.skills = c.skills ?? {};
  c.skills[job] = Math.max(c.skills[job] ?? 0, head);
  // New trade, new day: drop what they were walking toward.
  c.path = []; c.detour = undefined; c.dwell = 0;
  pushFeed(world, 'work', was === 'unemployed'
    ? `${c.name} was trained as a ${JOB_LABELS[job].toLowerCase()}.`
    : `${c.name} was retrained from ${JOB_LABELS[was].toLowerCase()} to ${JOB_LABELS[job].toLowerCase()}.`);
  noteAttention(world);
  return { ok: true, message: '' };
}

/**
 * Fill open posts in a trade with the people who can best be spared: the
 * unemployed first, then anyone in a trade with more hands than posts, then
 * the least skilled of the rest. Stops at the posts, at the Gold, or at the
 * count asked for, whichever comes first.
 */
export function trainTrade(world: World, job: WorkingJob, count: number): { ok: boolean; message: string; trained: number } {
  useWorld(world);
  if (!jobs[job]) return { ok: false, message: 'That is not a trade.', trained: 0 };
  const open = openPosts(world, job);
  const want = Math.min(Math.max(0, Math.floor(count)), open);
  if (want <= 0) return { ok: false, message: `Every ${JOB_LABELS[job].toLowerCase()} post is filled.`, trained: 0 };
  if (world.treasury < TRAIN_COST_GOLD) return { ok: false, message: `Training costs ${TRAIN_COST_GOLD} Gold a head, and the treasury holds ${Math.floor(world.treasury)}.`, trained: 0 };
  const tally: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) tally[c.job] = (tally[c.job] ?? 0) + 1;
  const spare = (c: Citizen) => {
    if (c.job === 'unemployed') return 0;
    const over = (tally[c.job] ?? 0) - jobCapacity(world, c.job as WorkingJob);
    return over > 0 ? 1 : 2;
  };
  const pool = world.citizens
    .filter((c) => c.age >= 16 && c.job !== job && !heldTrade(world, c))
    .sort((a, b) => spare(a) - spare(b) || (a.job === 'unemployed' ? 0 : skillDays(a, a.job as WorkingJob)) - (b.job === 'unemployed' ? 0 : skillDays(b, b.job as WorkingJob)));
  let trained = 0;
  for (const c of pool) {
    if (trained >= want || world.treasury < TRAIN_COST_GOLD) break;
    // Never strip a food trade to nothing to fill another: a town can do
    // without its last carpenter for a while, not its last farmer.
    if (c.job !== 'unemployed' && (tally[c.job] ?? 0) <= 1 && FOOD_TRADES.has(c.job)) continue;
    const r = trainCitizen(world, c.id, job);
    if (!r.ok) continue;
    tally[c.job] = (tally[c.job] ?? 0) + 1;
    trained++;
  }
  if (trained === 0) return { ok: false, message: 'Nobody could be spared for it.', trained: 0 };
  return { ok: true, message: `${trained} trained as ${JOB_LABELS[job].toLowerCase()}${trained === 1 ? '' : 's'}.`, trained };
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
    let seasonal = world.season === 'Winter' && wj === 'farmer' ? .65 : world.season === 'Summer' && wj === 'farmer' ? 1.15 : 1;
    // Nothing to pick under snow; the hedges are heavy in autumn.
    if (wj === 'forager') seasonal = world.season === 'Winter' ? 0.35 : world.season === 'Autumn' ? 1.3 : 1;
    if (wj === 'fisher' && world.season === 'Winter') seasonal = 0.7;
    // What the day's fishing and hunting cost, and what it did to the catch.
    let gear = 1;
    if (wj === 'fisher') gear = outfitFishers(world, workers);
    // What the hunters were seen to bring down today, kill by kill. The
    // stalking on screen is the visible part of the day's hunting; the
    // snares, the lines and the ground beyond the plot's edge bring in the
    // rest, so the lodge is paid like any other trade and six hunters at an
    // improved lodge are not left sharing one plot's herd of ten.
    let taken: Partial<Record<Resource, number>> = {};
    if (wj === 'hunter') {
      const bag = outfitHunters(world, workers);
      gear = bag.gear;
      taken = { game: bag.game, hides: bag.hides };
      // A wood hunted bare still feeds the snares, but thinly.
      if (bag.herd === 0) seasonal *= 0.6;
    }
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
    const effort = wageEffort(world.wageRate);
    // What the people doing it are actually worth. Averaged over the hands at
    // the trade, so one master among four novices lifts it a little.
    const craft = tradeSkill(world, wj);
    // And the state of the places they work in. Averaged over the sites, so
    // improving one of three workshops lifts the trade by a third of a step.
    const sites = world.buildings.filter((b) => b.type === recipe.building && b.active);
    const premises = sites.length
      ? sites.reduce((sum, b) => sum + buildingOutput(b), 0) / sites.length
      : 1;
    for (const [r, n] of Object.entries(recipe.output)) {
      const due = (n as number) * workers * terrainMultiplier(world, wj) * seasonal * weather * blighted * effort * craft * premises * methodBonus(world) * gear;
      // Less what was already booked as it happened, never below nothing.
      const made = Math.max(0, due - (taken[r as Resource] ?? 0));
      if (made <= 0) continue;
      world.resources[r as Resource] += made;
      note(world, 'produced', r as Resource, made);
    }
  }
  if (counts.farmer) pushFeed(world, 'work', `${counts.farmer} farmers tended the fields.`);
  if (counts.woodcutter) pushFeed(world, 'work', `${counts.woodcutter} woodcutters worked the forest.`);
  if (world.weather === 'Storm') pushFeed(world, 'weather', 'A storm slowed outdoor work today.');
  if (world.weather === 'Snow') pushFeed(world, 'weather', 'Snow settled over the settlement.');
}

/* ------------------------------------------------------------------ *
 * The shore, the wood and the wild ground
 * ------------------------------------------------------------------ */

const spotCache = new Map<string, [number, number][]>();

/**
 * Where the fishers stand.
 *
 * A band of dry ground along the water — close enough to cast, far enough
 * that the walking rules allow standing there — nearest the hut, half a dozen
 * spots spread out so two fishers are not on the same pixel. Recomputed when
 * the hut moves or a bridge opens new bank, and cached because the scan is a
 * few thousand samples.
 */
export function fishingSpotsOf(world: World): [number, number][] {
  useWorld(world);
  const hut = findBuilding(world, 'Fishery');
  const key = `${world.seed}:fish:${hut ? `${hut.x.toFixed(1)},${hut.y.toFixed(1)}` : 'none'}:${world.layout.bridges.length}:${world.buildings.length}`;
  const held = spotCache.get(key);
  if (held) return held;
  const water = waterOf(world);
  const ax = hut?.x ?? world.layout.plaza.x, ay = hut?.y ?? world.layout.plaza.y;
  const found: { x: number; y: number; d: number }[] = [];
  for (let py = 6; py <= 94; py += 1.5) {
    for (let px = 6; px <= 94; px += 1.5) {
      if (water.blocks(px, py)) continue;
      const dw = water.distanceToWater(px, py);
      if (dw > 2.6) continue;
      const land = water.landAt(px, py);
      if (!reachable(world, water, land)) continue;
      if (world.buildings.some((b) => Math.hypot(b.x - px, b.y - py) < footprintRadius(b) + 1.6)) continue;
      found.push({ x: px, y: py, d: Math.hypot(px - ax, py - ay) });
    }
  }
  found.sort((a, b) => a.d - b.d);
  const spots: [number, number][] = [];
  for (const f of found) {
    if (spots.some(([sx, sy]) => Math.hypot(sx - f.x, sy - f.y) < 3)) continue;
    spots.push([f.x, f.y]);
    if (spots.length >= 6) break;
  }
  if (spotCache.size > 40) spotCache.clear();
  spotCache.set(key, spots);
  return spots;
}

/**
 * Where the foragers pick: open ground well clear of the houses and the
 * water, within a walk of the camp.
 */
export function forageSpotsOf(world: World): [number, number][] {
  useWorld(world);
  const camp = findBuilding(world, 'Forager');
  const key = `${world.seed}:forage:${camp ? `${camp.x.toFixed(1)},${camp.y.toFixed(1)}` : 'none'}:${world.buildings.length}`;
  const held = spotCache.get(key);
  if (held) return held;
  const water = waterOf(world);
  const ax = camp?.x ?? world.layout.plaza.x, ay = camp?.y ?? world.layout.plaza.y;
  const found: { x: number; y: number; d: number }[] = [];
  for (let py = 8; py <= 92; py += 3) {
    for (let px = 8; px <= 92; px += 3) {
      if (water.blocks(px, py) || water.distanceToWater(px, py) < 3) continue;
      const land = water.landAt(px, py);
      if (!reachable(world, water, land)) continue;
      if (world.buildings.some((b) => Math.hypot(b.x - px, b.y - py) < footprintRadius(b) + 5)) continue;
      const d = Math.hypot(px - ax, py - ay);
      if (d < 6 || d > 34) continue;
      found.push({ x: px, y: py, d });
    }
  }
  found.sort((a, b) => a.d - b.d);
  const spots: [number, number][] = [];
  for (const f of found) {
    if (spots.some(([sx, sy]) => Math.hypot(sx - f.x, sy - f.y) < 5)) continue;
    spots.push([f.x, f.y]);
    if (spots.length >= 6) break;
  }
  if (spotCache.size > 40) spotCache.clear();
  spotCache.set(key, spots);
  return spots;
}

/** A small, stable random stream for one animal at one moment. */
function animalRand(world: World, a: Animal) {
  let h = world.seed ^ (world.day * 7919) ^ Math.floor(world.hour * 97);
  for (let i = 0; i < a.id.length; i++) h = Math.imul(h ^ a.id.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
}

/** Whether an animal can stand here: dry, on land people can reach, and out of the village. */
function wildGround(world: World, water: WaterField, kind: AnimalKind, x: number, y: number, clearance = 4): boolean {
  // A margin in from the plot's edge, whatever size the plot is: an expanded
  // plot read the old 0–100 bounds here and threw away half its spawns.
  const ext = activeExtent;
  if (x < ext.x0 + 6 || x > ext.x1 - 6 || y < ext.y0 + 8 || y > ext.y1 - 8) return false;
  if (water.blocks(x, y)) return false;
  const land = water.landAt(x, y);
  if (!reachable(world, water, land)) return false;
  const dw = water.distanceToWater(x, y);
  if (WATERSIDE.includes(kind) ? dw > 6 : dw < 2.4) return false;
  for (const b of world.buildings) if (Math.hypot(b.x - x, b.y - y) < footprintRadius(b) + clearance) return false;
  return true;
}

/** True where an animal would be under the canopy, out of sight. */
function underCanopy(world: World, x: number, y: number): boolean {
  return woodedAt(world.seed, biomeProfile(world.biome), world.layout.plaza, x, y);
}

/**
 * Put one more animal on the land, somewhere out of the way.
 *
 * Open ground first: a herd that spawned under a deep wood's canopy was
 * invisible, to the player watching and to the hunter alike, and a hunt
 * nobody can see is a number in a feed. The first forty tries want a spot
 * the trees do not cover; only then does the wood itself do.
 */
function spawnAnimal(world: World, rand: () => number): Animal | null {
  const water = waterOf(world);
  const kinds = WILDLIFE[world.biome];
  const kind = kinds[Math.floor(rand() * kinds.length)];
  for (let i = 0; i < 80; i++) {
    const x = across(rand, 8), y = across(rand, 10);
    if (!wildGround(world, water, kind, x, y, 9)) continue;
    if (Math.hypot(x - world.layout.plaza.x, y - world.layout.plaza.y) < 16) continue;
    if (i < 40 && underCanopy(world, x, y)) continue;
    const a: Animal = {
      id: `a${world.counter++}`, kind, x, y, homeX: x, homeY: y, destX: x, destY: y,
      state: 'grazing', timer: 0.3 + rand() * 1.2, facing: rand() < 0.5 ? 1 : -1,
    };
    world.wildlife.push(a);
    return a;
  }
  return null;
}

/**
 * The herd comes back.
 *
 * One animal a day while the land is below what it carries, two while it is
 * badly thinned, and a third in spring. Hunting faster than this is what
 * empties a wood, which is the hunters' problem to notice.
 */
function replenishWildlife(world: World) {
  const rand = mulberry32(world.seed + world.day * 6091);
  const cap = HERD_CAP[world.biome];
  const alive = world.wildlife.filter((a) => a.state !== 'down').length;
  if (alive >= cap) return;
  let more = alive < cap / 2 ? 2 : 1;
  if (world.season === 'Spring') more++;
  for (let i = 0; i < more && world.wildlife.length < cap; i++) spawnAnimal(world, rand);
}

/**
 * The animals go about their day.
 *
 * Grazing, then a short move within reach of home, then grazing again; a
 * bolt away from anybody who comes too close. An animal a hunter is stalking
 * has not seen them and stays put, which is the whole difference between a
 * hunt that ends in a kill and one that ends in a chase.
 */
function moveWildlife(world: World, hours: number) {
  if (!world.wildlife.length) return;
  const water = waterOf(world);
  const people = world.citizens;
  for (const a of world.wildlife) {
    if (a.state === 'down') { a.timer -= hours; continue; }
    if (a.stalkedBy) {
      const stalker = people.find((c) => c.id === a.stalkedBy);
      if (!stalker || stalker.hunting !== a.id || stalker.phase !== 'working') a.stalkedBy = undefined;
      else { a.state = 'grazing'; continue; }
    }
    // Anybody too close, and it bolts the other way.
    let nearest: Citizen | undefined;
    let nd = FLEE_RANGE;
    for (const c of people) {
      if (c.inside) continue;
      const d = Math.hypot(c.x - a.x, c.y - a.y);
      if (d < nd) { nd = d; nearest = c; }
    }
    if (nearest && a.state !== 'fleeing') {
      const dx = a.x - nearest.x, dy = a.y - nearest.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const rand = animalRand(world, a);
      // Straight away, or off to one side if that runs into water or a wall.
      const angles = [0, 0.7, -0.7, 1.4, -1.4];
      for (const turn of angles) {
        const ang = Math.atan2(dy, dx) + turn;
        const tx = a.x + Math.cos(ang) * (6 + rand() * 3), ty = a.y + Math.sin(ang) * (6 + rand() * 3);
        if (!wildGround(world, water, a.kind, tx, ty, 2)) continue;
        a.destX = tx; a.destY = ty; a.state = 'fleeing'; a.timer = 0;
        break;
      }
      if (a.state !== 'fleeing') { a.state = 'grazing'; a.timer = 0.2; }
    }
    if (a.state === 'grazing') {
      a.timer -= hours;
      if (a.timer > 0) continue;
      const rand = animalRand(world, a);
      for (let i = 0; i < 8; i++) {
        const ang = rand() * Math.PI * 2, r = 2 + rand() * 5;
        const tx = a.homeX + Math.cos(ang) * r, ty = a.homeY + Math.sin(ang) * r;
        if (!wildGround(world, water, a.kind, tx, ty, 3)) continue;
        // Browse the edge rather than wander into the deep wood.
        if (i < 5 && underCanopy(world, tx, ty)) continue;
        a.destX = tx; a.destY = ty; a.state = 'moving';
        break;
      }
      if (a.state === 'grazing') a.timer = 0.5 + rand() * 1.5;
      continue;
    }
    // Moving or fleeing: step toward the spot, and never into the water.
    const pace = a.state === 'fleeing' ? ANIMAL_PACE[a.kind].flee : ANIMAL_PACE[a.kind].graze;
    const dx = a.destX - a.x, dy = a.destY - a.y, d = Math.hypot(dx, dy);
    const step = Math.min(d, pace * hours);
    if (Math.abs(dx) > 0.05) a.facing = dx > 0 ? 1 : -1;
    const nx = a.x + (dx / Math.max(0.001, d)) * step, ny = a.y + (dy / Math.max(0.001, d)) * step;
    const arrived = d - step < 0.15;
    if (water.blocks(nx, ny) || arrived) {
      if (!water.blocks(nx, ny)) { a.x = nx; a.y = ny; }
      a.state = 'grazing';
      a.timer = 0.4 + (animalRand(world, a)() * 1.4);
      // Somewhere it has fled to becomes home, so a herd pushed off its ground
      // does not walk straight back into the village.
      if (Math.hypot(a.x - a.homeX, a.y - a.homeY) > 8) { a.homeX = a.x; a.homeY = a.y; }
      continue;
    }
    a.x = nx; a.y = ny;
  }
  world.wildlife = world.wildlife.filter((a) => a.state !== 'down' || a.timer > 0);
}

/** The nearest animal a hunter can go after, or nothing worth the walk. */
function pickPrey(world: World, c: Citizen, lodge: Building | undefined): Animal | undefined {
  const water = waterOf(world);
  const fromX = lodge?.x ?? c.x, fromY = lodge?.y ?? c.y;
  let best: Animal | undefined;
  let bestD = Infinity;
  for (const a of world.wildlife) {
    if (a.state === 'down') continue;
    if (a.stalkedBy && a.stalkedBy !== c.id && world.citizens.some((o) => o.id === a.stalkedBy && o.hunting === a.id)) continue;
    const land = water.landAt(a.x, a.y);
    if (!reachable(world, water, land)) continue;
    if (Math.hypot(a.x - fromX, a.y - fromY) > HUNT_RANGE) continue;
    const d = Math.hypot(a.x - c.x, a.y - c.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/** Let go of whatever this hunter was closing on. */
function releasePrey(world: World, c: Citizen) {
  if (!c.hunting) return;
  const prey = world.wildlife.find((a) => a.id === c.hunting);
  if (prey && prey.stalkedBy === c.id) prey.stalkedBy = undefined;
  c.hunting = undefined;
}

/** The hunter has reached where the animal was. Take it, or go again. */
function huntArrival(world: World, c: Citizen) {
  const prey = world.wildlife.find((a) => a.id === c.hunting);
  if (!prey || prey.state === 'down') {
    c.hunting = undefined;
    c.dwell = 0;
    return;
  }
  if (Math.hypot(prey.x - c.x, prey.y - c.y) <= HUNT_REACH) {
    takeAnimal(world, c, prey);
    return;
  }
  // It has moved on. Stand a moment, then go after it again.
  c.dwell = Math.min(c.dwell, 0.2);
}

/** Bring an animal down, and book what it was worth. */
function takeAnimal(world: World, c: Citizen, prey: Animal) {
  prey.state = 'down';
  prey.timer = 0.5;
  prey.stalkedBy = undefined;
  c.hunting = undefined;
  c.hauling = true;
  // Stand over it briefly, then carry it in.
  c.dwell = 0.3;
  const yields = ANIMAL_YIELD[prey.kind];
  const quality = skillOutput(c) * methodBonus(world) * (world.hunt.arrows ? 1 : 0.6);
  const game = yields.game * quality;
  const hides = yields.hides * quality;
  world.resources.game += game;
  world.resources.hides += hides;
  note(world, 'produced', 'game', game);
  note(world, 'produced', 'hides', hides);
  world.hunt.today++;
  world.hunt.game = (world.hunt.game ?? 0) + game;
  world.hunt.hides = (world.hunt.hides ?? 0) + hides;
  c.purpose = Math.min(100, c.purpose + 2);
  if (world.hunt.lines < 3) {
    world.hunt.lines++;
    pushFeed(world, 'work', `${c.name} brought down a ${ANIMAL_LABELS[prey.kind]}.`);
  }
}

/**
 * The fishers' day: bait out of the treasury, rods out of the yard.
 *
 * Returns the multiplier on the catch — one when everything was paid for,
 * less when the bait could not be bought or a snapped rod could not be
 * replaced.
 */
function outfitFishers(world: World, workers: number): number {
  let gear = 1;
  const bait = BAIT_GOLD * workers;
  const paid = spend(world, 'gear', bait);
  if (paid < bait) gear *= 0.5;
  const rand = mulberry32(world.seed + world.day * 977);
  let broken = 0;
  for (let i = 0; i < workers; i++) if (rand() < ROD_BREAK_CHANCE) broken++;
  let remade = 0;
  if (broken) {
    remade = Math.min(broken, Math.floor(world.resources.wood / ROD_WOOD));
    if (remade) {
      world.resources.wood -= remade * ROD_WOOD;
      note(world, 'consumed', 'wood', remade * ROD_WOOD);
    }
    if (remade < broken) gear *= 1 - (broken - remade) / (workers * 2);
    pushFeed(world, 'work', broken === 1
      ? `A rod snapped on the shore. ${remade ? `${ROD_WOOD} timber went to a new one.` : 'There was no timber for a new one.'}`
      : `${broken} rods snapped on the shore. ${remade ? `${remade * ROD_WOOD} timber went to new ones.` : 'There was no timber for new ones.'}`);
  }
  pushFeed(world, 'work', `${workers} ${workers === 1 ? 'fisher' : 'fishers'} cast from the shore. Bait cost ${Math.round(paid)} Gold.`);
  return gear;
}

/**
 * The hunters' day: arrows out of the yard, and the tally of what they brought in.
 *
 * Returns the multiplier the quiver puts on the day's take, what the live
 * kills already booked, and how many animals are left on the land.
 */
function outfitHunters(world: World, workers: number): { gear: number; game: number; hides: number; herd: number } {
  const arrows = ARROW_WOOD * workers;
  const had = Math.min(world.resources.wood, arrows);
  world.resources.wood -= had;
  note(world, 'consumed', 'wood', had);
  world.hunt.arrows = had >= arrows;
  const took = world.hunt.today;
  const bag = { gear: world.hunt.arrows ? 1 : 0.6, game: world.hunt.game ?? 0, hides: world.hunt.hides ?? 0, herd: 0 };
  const herd = world.wildlife.filter((a) => a.state !== 'down').length;
  bag.herd = herd;
  if (took > 0) {
    pushFeed(world, 'work', `${workers} ${workers === 1 ? 'hunter' : 'hunters'} took ${took} ${took === 1 ? 'animal' : 'animals'} from the wild ground.`);
  } else if (herd === 0) {
    pushFeed(world, 'work', 'The hunters found nothing. The land needs time for the herd to come back.');
  } else {
    pushFeed(world, 'work', 'The hunters came back empty-handed.');
  }
  if (!world.hunt.arrows) pushFeed(world, 'work', 'The hunters are short of arrows. Timber in the yard would fix it.');
  world.hunt.today = 0;
  world.hunt.lines = 0;
  world.hunt.game = 0;
  world.hunt.hides = 0;
  return bag;
}

/** The animals alive on the land, and how many of them a lodge's hunters can reach. */
export function herdOf(world: World, lodge?: Building): { land: number; reach: number } {
  useWorld(world);
  const alive = world.wildlife.filter((a) => a.state !== 'down');
  const at = lodge ?? findBuilding(world, 'Lodge');
  const reach = at ? alive.filter((a) => Math.hypot(a.x - at.x, a.y - at.y) <= HUNT_RANGE).length : 0;
  return { land: alive.length, reach };
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
  useWorld(world);
  const wells = world.amenities.filter((a) => a.kind === 'well').length;
  const fires = world.amenities.filter((a) => a.kind === 'campfire').length;
  // An improved store is half again the store: sturdier, drier, fuller.
  const stores = world.buildings.filter((b) => b.type === 'Storage' && b.active).reduce((s, b) => s + 1 + 0.5 * (levelOf(b) - 1), 0);
  const food = foodInStore(world);
  const mouths = Math.max(1, world.citizens.length);
  const water = waterOf(world);
  const buildings = world.buildings.length || 1;
  const backFromBank = world.buildings.filter((b) => water.distanceToWater(b.x, b.y) >= 6).length / buildings;
  // Measured against the size of the thing being defended, not as a flat
  // count: one well was enough for a hamlet of eight and read as complete
  // readiness for a town of thirty-one, which meant nothing could ever burn.
  // A lab sees fire, blight and wolves coming; a clinic makes a blight a
  // sickness the town gets over rather than one it does not.
  const warned = hasCivic(world, 'Lab') ? LAB_WARNING : 0;
  const cared = careOf(world);
  const improved = world.buildings.filter((b) => levelOf(b) > 1).length / buildings;
  return {
    fire: clamp(wells / (1 + buildings / 8) + warned, 0, 1),
    blight: clamp(food / (mouths * 9) * 0.7 + stores * 0.3 + warned + cared, 0, 1),
    // Stone in the yard is what shores a wall up; a storehouse is somewhere
    // to shelter; a clinic and herbs are what stands between a sickness and
    // a burial.
    earthquake: clamp(Math.min(1, world.resources.stone / 40) * 0.6 + warned + (stores ? 0.15 : 0), 0, 1),
    tornado: clamp((stores ? 0.3 : 0) + improved * 0.45 + warned, 0, 1),
    plague: clamp((hasCare(world) ? 0.45 : 0) + Math.min(1, world.resources.herbs / 12) * 0.35 + warned, 0, 1),
    // Hunters know the wood, and a lodge with people in it is a lodge wolves keep clear of.
    wolves: clamp(fires / (1 + mouths / 14) + warned + world.citizens.filter((c) => c.job === 'hunter').length * 0.2, 0, 1),
    flood: clamp(backFromBank, 0, 1),
  };
}

/** Labels for the panel, so a hazard is named the same way everywhere. */
export const HAZARD_LABELS: Record<HazardKind, string> = {
  fire: 'Fire',
  blight: 'Blight',
  wolves: 'Wolves',
  flood: 'Flood',
  earthquake: 'Earthquake',
  tornado: 'Tornado',
  plague: 'Plague',
};

export const HAZARD_DEFENCE: Record<HazardKind, string> = {
  fire: 'Wells within reach, and enough hands to pass the buckets.',
  blight: 'A granary and a season of food put by.',
  wolves: 'Fires burning through the night, and numbers.',
  flood: 'Buildings set back from the bank.',
  earthquake: 'Stone in the yard to shore walls up with, a storehouse, and a lab to read the ground.',
  tornado: 'A storehouse to shelter in, sturdy improved buildings, and a lab to see it coming.',
  plague: 'A clinic, herbs in store, and a lab to catch it early.',
};

/**
 * What the player can spend against each kind of trouble, and what it does.
 *
 * This is the one place a player's hand reaches into a disaster. It costs
 * Gold, once, scaled by how bad the thing is and how much town there is to
 * save, and it is always worth less than losing a building — which is what
 * keeps it a decision rather than a tax.
 */
export const HAZARD_FIGHT: Record<HazardKind, { gold: number; title: string; blurb: string }> = {
  fire: { gold: 60, title: 'Bucket chains', blurb: 'Every hand to the wells. The fire is out by nightfall and the building is back in use.' },
  blight: { gold: 90, title: 'Burn the blighted rows', blurb: 'Lose a little more of the crop now, and the rest of the harvest is saved.' },
  wolves: { gold: 70, title: 'A night watch', blurb: 'Torches and people up all night. The wolves do not come back.' },
  flood: { gold: 160, title: 'Sandbags along the bank', blurb: 'The water stops where it stands, and the buildings on the bank are spared.' },
  earthquake: { gold: 220, title: 'Shore up the walls', blurb: 'Props and braces on every damaged wall. The aftershocks take nothing more, and the worst of the damage is patched.' },
  tornado: { gold: 200, title: 'Storm crews', blurb: 'Shutters up and everyone in the cellars. The funnel takes far less, and breaks up sooner.' },
  plague: { gold: 180, title: 'Quarantine and physic', blurb: 'The sick are kept apart and dosed with what herbs there are. It spreads far less and kills fewer.' },
};

/** What fighting this hazard costs, here and now. */
export function fightCost(world: World, h: Hazard): number {
  useWorld(world);
  return Math.round(HAZARD_FIGHT[h.kind].gold * (0.6 + (h.severity ?? 0.5)) * (1 + world.buildings.length / 24));
}

/** Say something on a hazard's behalf, a few times at most. */
function hazardSays(world: World, h: Hazard, text: string, limit = 4) {
  h.told = (h.told ?? 0) + 1;
  if (h.told <= limit) pushFeed(world, 'world', text);
}

/**
 * Knock a building about. Returns true if this is what brought it down.
 *
 * The market, the bank and the town hall can be battered but never wrecked:
 * losing them strands everybody at once, which is a dead plot rather than a
 * damaged one.
 */
function damageBuilding(world: World, b: Building, amount: number, cause: string, h?: Hazard): boolean {
  if (b.ruined || amount <= 0) return false;
  // An insured plot takes half of everything: trouble still comes, and half
  // as much of it sticks.
  if (insured(world)) amount *= 0.5;
  const cap = UNDEMOLISHABLE.includes(b.type) ? 0.9 : 1;
  b.damage = Math.min(cap, (b.damage ?? 0) + amount);
  if (b.damage < 1) return false;
  b.ruined = true;
  b.active = false;
  b.workers = [];
  b.production = undefined;
  // A ruined house is nobody's home: the family lodges until it is rebuilt
  // or another roof goes up.
  for (const f of world.families) if (f.homeId === b.id) f.homeId = '';
  if (b.type === 'House') rehouse(world);
  for (const c of world.citizens) {
    if (c.destId === b.id) { c.destId = undefined; c.path = []; c.detour = undefined; c.dwell = 0; c.inside = false; }
  }
  h?.wrecked.push(b.id);
  pushFeed(world, 'world', `${cause} left the ${b.type.toLowerCase()} in ruins.`);
  return true;
}

/** What raising a ruin again costs: less than new, since the ground and the footings are there. */
export function rebuildCost(b: Building): { gold: number; wood: number; stone: number } {
  const need = buildMaterials(b.type);
  return {
    gold: Math.round((BUILD_COSTS[b.type] ?? 250) * 0.6),
    wood: Math.ceil(need.wood * 0.6),
    stone: Math.ceil(need.stone * 0.6),
  };
}

/** The player raises a ruin again, for Gold and materials. */
export function rebuildBuilding(world: World, id: string): { ok: boolean; message: string } {
  useWorld(world);
  const b = world.buildings.find((x) => x.id === id);
  if (!b) return { ok: false, message: 'That building is not there.' };
  if (!b.ruined) return { ok: false, message: 'It is standing. Nothing to rebuild.' };
  const cost = rebuildCost(b);
  if (world.treasury < cost.gold) return { ok: false, message: `Rebuilding takes ${cost.gold} Gold. The treasury holds ${Math.floor(world.treasury)}.` };
  if (world.resources.wood < cost.wood || world.resources.stone < cost.stone) {
    return { ok: false, message: `Rebuilding takes ${cost.wood} timber and ${cost.stone} stone, and the yard is short.` };
  }
  spend(world, 'building', cost.gold);
  world.resources.wood -= cost.wood;
  world.resources.stone -= cost.stone;
  note(world, 'consumed', 'wood', cost.wood);
  note(world, 'consumed', 'stone', cost.stone);
  b.ruined = false;
  b.damage = 0;
  b.active = true;
  noteAttention(world);
  pushFeed(world, 'build', `The ${b.type.toLowerCase()} was rebuilt for ${cost.gold} Gold, ${cost.wood} timber and ${cost.stone} stone.`);
  staffNow(world);
  if (b.type === 'House') rehouse(world);
  return { ok: true, message: `The ${b.type.toLowerCase()} stands again.` };
}

/**
 * The carpenters patch what is knocked about but still standing, a little a
 * day, out of the yard. A ruin they cannot touch: that is the player's.
 */
function repairs(world: World) {
  let said = false;
  for (const b of world.buildings) {
    if (b.ruined || !(b.damage && b.damage > 0)) continue;
    if (world.resources.wood < 2) break;
    world.resources.wood -= 2;
    note(world, 'consumed', 'wood', 2);
    b.damage = Math.max(0, b.damage - 0.2);
    if (!said) { said = true; pushFeed(world, 'build', `The carpenters patched up the ${b.type.toLowerCase()}.`); }
  }
}

/**
 * The player spends Gold against a hazard. Once per hazard.
 *
 * Each kind answers differently, and the answer is written in `HAZARD_FIGHT`
 * so the panel promises exactly what happens here.
 */
export function fightHazard(world: World, id: string): { ok: boolean; message: string } {
  useWorld(world);
  const h = world.hazards.find((x) => x.id === id);
  if (!h) return { ok: false, message: 'That has passed.' };
  if (h.fought) return { ok: false, message: 'Everything that can be done is being done.' };
  const gold = fightCost(world, h);
  if (world.treasury < gold) return { ok: false, message: `That takes ${gold} Gold. The treasury holds ${Math.floor(world.treasury)}.` };
  spend(world, 'works', gold);
  noteAttention(world);
  h.fought = true;
  const fight = HAZARD_FIGHT[h.kind];
  switch (h.kind) {
    case 'fire': {
      const b = world.buildings.find((x) => x.id === h.buildingId);
      if (b && !b.ruined) b.active = true;
      h.days = 0;
      h.effect = 'Out. The bucket chains did it.';
      break;
    }
    case 'blight': {
      const lost = Math.min(world.resources.wheat, 6);
      world.resources.wheat -= lost;
      note(world, 'consumed', 'wheat', lost);
      h.days = 0;
      h.effect = 'The blighted rows were burned. The rest of the harvest is safe.';
      break;
    }
    case 'wolves':
      for (const c of world.citizens) c.warmth = Math.min(100, c.warmth + 10);
      h.days = 0;
      h.effect = 'A watch is up all night. The wolves have gone back to the trees.';
      break;
    case 'flood':
      h.effect = 'Sandbags hold the water where it stands. The bank is safe.';
      break;
    case 'earthquake':
      h.hours = Math.min(h.hours ?? 0, 0.5);
      for (const b of world.buildings) if (!b.ruined && b.damage) b.damage = Math.max(0, b.damage - 0.3);
      h.effect = 'Every damaged wall is braced. The aftershocks will take nothing more.';
      break;
    case 'tornado':
      h.hours = (h.hours ?? 0) * 0.6;
      h.effect = 'Shutters are up and everyone is in the cellars. The funnel is taking far less.';
      break;
    case 'plague':
      h.effect = 'The sick are kept apart and dosed. It is spreading far less.';
      break;
  }
  pushFeed(world, 'world', `${gold.toLocaleString()} Gold went on ${fight.title.toLowerCase()}.`);
  return { ok: true, message: fight.blurb };
}

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
  if (kind === 'earthquake') {
    // Hard ground moves. A shelf or a desert plateau more than a fen.
    if (world.day < 8) return 0;
    return 0.004 + biomeProfile(world.biome).plateau * 0.005;
  }
  if (kind === 'tornado') {
    if (world.weather !== 'Storm' && world.weather !== 'Cloudy') return 0;
    const open = world.biome === 'steppe' || world.biome === 'grassland' || world.biome === 'desert' ? 0.028 : 0.006;
    return open * (world.season === 'Summer' || world.season === 'Autumn' ? 1.5 : 1);
  }
  if (kind === 'plague') {
    if (world.citizens.length < 9) return 0;
    const season = world.season === 'Autumn' || world.season === 'Winter' ? 0.018 : 0.007;
    return season * (hasCare(world) ? 0.45 : 1);
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
    h.wrecked ??= [];
    if (h.kind === 'plague') plagueDay(world, h);
    h.days -= 1;
    if (h.days > 0) continue;
    if (h.buildingId) {
      const b = world.buildings.find((x) => x.id === h.buildingId);
      if (b && !b.ruined) {
        b.active = true;
        pushFeed(world, 'build', `The ${b.type.toLowerCase()} is back in use.`);
      }
    }
    if (h.kind === 'plague') {
      for (const c of world.citizens) c.sick = undefined;
      pushFeed(world, 'world', 'The sickness has run its course.');
    }
    if (h.kind === 'flood') pushFeed(world, 'world', 'The water has gone down.');
    world.hazards.splice(i, 1);
  }
  if (world.hazards.length) return;
  // Nothing happens to a settlement in its first days. A town that burns down
  // before it has a well is not a challenge, it is a bad opening hand.
  if (world.day < 5) return;

  const rand = mulberry32(world.seed + world.day * 3319);
  const ready = readiness(world);
  const kinds: HazardKind[] = ['fire', 'blight', 'wolves', 'flood', 'earthquake', 'tornado', 'plague'];
  for (const kind of kinds) {
    const chance = hazardChance(world, kind);
    if (chance <= 0 || rand() > chance) continue;
    startHazard(world, kind, ready[kind], rand);
    return;
  }
}

/** How many buildings one disaster may wreck: a quarter of what stands, and never fewer than three. */
export function hazardBudget(world: World) {
  const standing = world.buildings.filter((b) => !b.ruined).length;
  return Math.max(3, Math.round(standing * HAZARD_SHARE));
}
export const HAZARD_SHARE = 0.25;

function startHazard(world: World, kind: HazardKind, ready: number, rand: () => number) {
  // How badly it lands. Full readiness is not immunity — it is the difference
  // between a bad afternoon and a bad month.
  const severity = Math.max(0.12, 1 - ready);
  const days = Math.max(1, Math.round(1 + severity * 4));
  const add = (effect: string, buildingId?: string): Hazard => {
    const h: Hazard = { id: `h${world.counter++}`, kind, label: HAZARD_LABELS[kind], effect, day: world.day, days, buildingId, severity, wrecked: [] };
    world.hazards.push(h);
    return h;
  };
  const scatter = (hours: number) => { for (const c of world.citizens) if (!c.jailed) c.fleeing = hours; };

  if (kind === 'earthquake') {
    const h = add('The ground is moving. Walls are cracking across the settlement.');
    h.days = 2;
    h.hours = 2 + severity * 4;
    let damaged = 0, wrecked = 0;
    // A quake shakes the whole settlement, but it does not level it: at most
    // a quarter of what stands is hit, however hard it comes. A player who
    // came back to a city with two buildings left out of forty had not been
    // given a setback, they had been given a reason to stop.
    const standing = world.buildings.filter((b) => !b.ruined);
    const most = hazardBudget(world);
    for (const b of standing) {
      if (damaged >= most) break;
      if (rand() > 0.4 + severity * 0.35) continue;
      const before = b.ruined;
      damageBuilding(world, b, (0.2 + rand() * 0.7) * severity * 1.6, 'The earthquake', h);
      damaged++;
      if (b.ruined && !before) wrecked++;
    }
    scatter(h.hours + 1);
    pushFeed(world, 'world', `The ground heaved under ${world.name}. ${damaged} ${damaged === 1 ? 'building is' : 'buildings are'} damaged and ${wrecked} ${wrecked === 1 ? 'lies' : 'lie'} in ruins.`);
    return;
  }

  if (kind === 'tornado') {
    const plaza = world.layout.plaza;
    // In from an edge, aimed roughly at the square.
    const side = Math.floor(rand() * 4);
    const x = side === 0 ? activeExtent.x0 + 4 : side === 1 ? activeExtent.x1 - 4 : across(rand, 8);
    const y = side === 2 ? activeExtent.y0 + 4 : side === 3 ? activeExtent.y1 - 4 : across(rand, 8);
    const dx = plaza.x - x, dy = plaza.y - y, d = Math.max(1, Math.hypot(dx, dy));
    const pace = 7;
    const h = add('A funnel cloud is down and moving on the settlement.');
    h.days = 1;
    h.hours = 6 + severity * 5;
    h.x = x; h.y = y; h.vx = (dx / d) * pace; h.vy = (dy / d) * pace;
    scatter(h.hours);
    const from = side === 0 ? 'west' : side === 1 ? 'east' : side === 2 ? 'north' : 'south';
    pushFeed(world, 'world', `A funnel cloud has come down to the ${from} of ${world.name} and is moving on the settlement.`);
    return;
  }

  if (kind === 'plague') {
    const adults = world.citizens.filter((c) => c.age >= 16 && !c.sick);
    const first = 2 + Math.round(severity * 3);
    for (let i = 0; i < first && adults.length; i++) {
      const c = adults.splice(Math.floor(rand() * adults.length), 1)[0];
      c.sick = 1;
    }
    const h = add('Sickness is spreading from person to person.');
    h.days = 6 + Math.round(severity * 6);
    pushFeed(world, 'world', `Sickness is in ${world.name}. ${first} people are down with it, and it is catching.`);
    return;
  }

  if (kind === 'fire') {
    const candidates = world.buildings.filter((b) => b.active && b.type !== 'Market');
    const hit = candidates[Math.floor(rand() * candidates.length)];
    if (!hit) return;
    if (ready > 0.75) {
      pushFeed(world, 'world', `A fire started at the ${hit.type.toLowerCase()} and was put out before it spread. The wells did their job.`);
      const h = add('Put out the same day. No lasting damage.');
      h.days = 1;
      h.severity = 0;
      return;
    }
    hit.active = false;
    hit.damage = Math.min(0.9, (hit.damage ?? 0) + 0.5 * severity);
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
      const h = add('Kept at the treeline by the fires.');
      h.days = 1;
      h.severity = 0;
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

  // Flood: the water comes up over days, and takes the buildings on the bank
  // with it unless the player sandbags it.
  const bank = world.buildings.filter((b) => b.active && waterOf(world).distanceToWater(b.x, b.y) < 8);
  if (!bank.length || ready > 0.85) {
    pushFeed(world, 'world', 'The river came up in the storm and went down again. The settlement is built well back from it.');
    const h = add('The water stayed in its channel.');
    h.days = 1;
    h.severity = 0;
    return;
  }
  const h = add('The water is rising along the bank.');
  h.days = 2 + Math.round(severity * 3);
  h.level = 0.15;
  pushFeed(world, 'world', `The river is over its banks and rising through ${world.name}. ${bank.length} ${bank.length === 1 ? 'building stands' : 'buildings stand'} in its way.`);
}

/**
 * The hour-by-hour of a disaster: the funnel moves, the ground shakes, the
 * water climbs, the sickness passes between people standing together.
 */
function hazardStep(world: World, hours: number) {
  for (const c of world.citizens) if (c.fleeing && c.fleeing > 0) c.fleeing -= hours;
  if (!world.hazards.length) return;
  const water = waterOf(world);
  for (let i = world.hazards.length - 1; i >= 0; i--) {
    const h = world.hazards[i];
    h.wrecked ??= [];
    const severity = h.severity ?? 0.5;
    if (h.kind === 'earthquake' && (h.hours ?? 0) > 0) {
      h.hours = (h.hours ?? 0) - hours;
      const rand = mulberry32(world.seed + Math.floor(world.hour * 60) + world.day * 1440);
      if (!h.fought && rand() < 0.12 * hours) {
        const standing = world.buildings.filter((b) => !b.ruined);
        const hit = standing[Math.floor(rand() * standing.length)];
        if (hit) {
          damageBuilding(world, hit, (0.1 + rand() * 0.15) * severity, 'An aftershock', h);
          hazardSays(world, h, `An aftershock rattled the ${hit.type.toLowerCase()}.`, 3);
        }
      }
      if (h.hours <= 0) h.effect = h.fought ? 'Braced and still. It is over.' : 'The ground is still. It may move again before it settles.';
    }
    if (h.kind === 'tornado') {
      h.hours = (h.hours ?? 0) - hours;
      if (h.hours <= 0 || h.x === undefined || h.y === undefined) {
        pushFeed(world, 'world', h.wrecked.length
          ? `The funnel lifted and broke up. It left ${h.wrecked.length} ${h.wrecked.length === 1 ? 'building' : 'buildings'} in ruins.`
          : 'The funnel lifted and broke up. The settlement was spared the worst of it.');
        world.hazards.splice(i, 1);
        continue;
      }
      const rand = mulberry32(world.seed + Math.floor(world.hour * 30) + world.day * 720);
      // Wander a little, and turn back at the map's edge. Until it has
      // crossed the square it keeps bending back toward it: a funnel that
      // came down on the settlement is a funnel that goes through it.
      const turn = (rand() - 0.5) * 1.2 * hours;
      const vx = h.vx ?? 0, vy = h.vy ?? 0;
      const cos = Math.cos(turn), sin = Math.sin(turn);
      h.vx = vx * cos - vy * sin; h.vy = vx * sin + vy * cos;
      const square = world.layout.plaza;
      const toSquare = Math.hypot(square.x - h.x, square.y - h.y);
      if (toSquare < 6) h.level = 1;
      if (!h.level && toSquare > 0.5) {
        const speed = Math.hypot(h.vx, h.vy) || 7;
        const k = Math.min(1, 0.6 * hours);
        h.vx += ((square.x - h.x) / toSquare * speed - h.vx) * k;
        h.vy += ((square.y - h.y) / toSquare * speed - h.vy) * k;
      }
      h.x += h.vx * hours; h.y += h.vy * hours;
      if (h.x < activeExtent.x0 + 4 || h.x > activeExtent.x1 - 4) { h.vx = -h.vx; h.x = edge(h.x, 4, 96); }
      if (h.y < activeExtent.y0 + 4 || h.y > activeExtent.y1 - 4) { h.vy = -h.vy; h.y = edge(h.y, 4, 96); }
      // Hard enough that a building the funnel passes straight over comes down
      // in the hour or so it is overhead, and one it only brushes is knocked about.
      const rate = 1.05 * severity * hours * (h.fought ? 0.35 : 1);
      // Once the funnel has taken its share of the settlement it only
      // frightens people: the same quarter-of-the-town ceiling a quake has.
      const most = hazardBudget(world);
      for (const b of world.buildings) {
        if (b.ruined) continue;
        const d = Math.hypot(b.x - h.x, b.y - h.y);
        if (d > 5.5) continue;
        if (h.wrecked.length >= most && !b.damage) continue;
        damageBuilding(world, b, rate * (1 - d / 7), 'The tornado', h);
      }
      for (const c of world.citizens) {
        if (c.inside || Math.hypot(c.x - h.x, c.y - h.y) > 4) continue;
        c.happiness = Math.max(0, c.happiness - 6 * hours);
        c.rest = Math.max(0, c.rest - 6 * hours);
        c.fleeing = Math.max(c.fleeing ?? 0, 2);
      }
      const plaza = world.layout.plaza;
      const where = Math.hypot(h.x - plaza.x, h.y - plaza.y) < 10 ? 'over the square'
        : h.x < plaza.x - 8 ? 'over the west side' : h.x > plaza.x + 8 ? 'over the east side' : h.y < plaza.y ? 'to the north' : 'to the south';
      h.effect = `The funnel is ${where}${h.wrecked.length ? `. ${h.wrecked.length} ${h.wrecked.length === 1 ? 'building is' : 'buildings are'} gone` : ''}.`;
    }
    if (h.kind === 'flood' && h.level !== undefined) {
      if (!h.fought) h.level = Math.min(1, h.level + hours / 36);
      const reach = 2.5 + h.level * 5;
      if (!h.fought) {
        for (const b of world.buildings) {
          if (b.ruined || water.distanceToWater(b.x, b.y) > reach) continue;
          damageBuilding(world, b, 0.011 * severity * hours * 1.3, 'The flood', h);
        }
        h.effect = h.level >= 1 ? `The water is as high as it will go. ${h.wrecked.length} ${h.wrecked.length === 1 ? 'building has' : 'buildings have'} gone under.` : 'The water is rising along the bank.';
      }
    }
    if (h.kind === 'plague') {
      const sick = world.citizens.filter((c) => c.sick && !c.inside);
      if (!sick.length) continue;
      const rate = 0.05 * hours * (hasCare(world) ? 0.6 : 1) * (h.fought ? 0.25 : 1);
      const rand = mulberry32(world.seed + Math.floor(world.hour * 20) + world.day * 480);
      for (const c of world.citizens) {
        if (c.sick || c.inside || c.age < 4) continue;
        for (const s of sick) {
          if (Math.hypot(c.x - s.x, c.y - s.y) > 2.6) continue;
          if (rand() < rate) { c.sick = 1; break; }
        }
      }
      const down = world.citizens.filter((c) => c.sick).length;
      h.effect = `${down} ${down === 1 ? 'person is' : 'people are'} down with it${h.fought ? ', kept apart and dosed' : ''}.`;
    }
  }
}

/** A day of the plague: who gets better, who does not. */
function plagueDay(world: World, h: Hazard) {
  const rand = mulberry32(world.seed + world.day * 4441);
  const severity = h.severity ?? 0.5;
  let recovered = 0;
  const dead: Citizen[] = [];
  for (const c of world.citizens) {
    if (!c.sick) continue;
    c.sick += 1;
    c.happiness = Math.max(0, c.happiness - 3);
    c.rest = Math.max(0, c.rest - 4);
    // Herbs are the physic: one a day per patient, while there are any.
    let risk = 0.05 * severity;
    if (hasCare(world)) risk *= 0.5;
    if (h.fought) risk *= 0.5;
    if (world.resources.herbs >= 1) { world.resources.herbs -= 1; note(world, 'consumed', 'herbs', 1); risk *= 0.5; }
    if (c.sick > 4 && rand() < 0.35) { c.sick = undefined; recovered++; continue; }
    if (rand() < risk) dead.push(c);
  }
  for (const c of dead) bury(world, c, `${c.name} died of the sickness. The settlement is smaller today.`);
  if (recovered) pushFeed(world, 'world', `${recovered} ${recovered === 1 ? 'person is' : 'people are'} over the sickness.`);
  if (!world.citizens.some((c) => c.sick)) h.days = Math.min(h.days, 1);
}

/** Take somebody out of the world, and tidy everything that pointed at them. */
function bury(world: World, c: Citizen, line: string) {
  forget(world, c);
  world.deaths += 1;
  world.population = world.citizens.length;
  pushFeed(world, 'social', line);
}

/** Everything that pointed at somebody, cleared: the lists, the bonds, the bed, the post. */
function forget(world: World, c: Citizen) {
  world.citizens = world.citizens.filter((x) => x.id !== c.id);
  for (const f of world.families) f.members = f.members.filter((id) => id !== c.id);
  // The bed they leave behind is somebody else's tonight, not tomorrow.
  rehouse(world);
  for (const [key, bond] of Object.entries(world.bonds)) {
    if (bond.a === c.id || bond.b === c.id) delete world.bonds[key];
  }
  world.projects = world.projects.filter((p) => p.ownerId !== c.id);
  for (const a of world.amenities) a.users = a.users.filter((id) => id !== c.id);
  for (const o of world.citizens) if (o.chasing === c.id) o.chasing = undefined;
  for (const a of world.wildlife) if (a.stalkedBy === c.id) a.stalkedBy = undefined;
  for (const b of world.buildings) b.workers = b.workers.filter((id) => id !== c.id);
  world.population = world.citizens.length;
}

/** What it costs to send somebody away: a few days' pay to see them down the road. */
export const DISMISS_GOLD = 40;

/**
 * Send somebody away.
 *
 * "There needs to be a way to dismiss NPCs": a town whose posts are all
 * filled still feeds everybody, and a player who has more people than work
 * had no way to say so. An adult, never a child, never the last adult; they
 * leave on the road with a few days' pay, and their bed and their post are
 * free the same day.
 */
export function dismissCitizen(world: World, id: string): { ok: boolean; message: string } {
  useWorld(world);
  const c = world.citizens.find((x) => x.id === id);
  if (!c) return { ok: false, message: 'They are not here.' };
  if (c.age < 16) return { ok: false, message: `${c.name} is a child. Children stay with their family.` };
  if (world.citizens.filter((x) => x.age >= 16).length <= 1) return { ok: false, message: 'Somebody has to stay to keep the place.' };
  if (world.treasury < DISMISS_GOLD) return { ok: false, message: `Seeing somebody down the road costs ${DISMISS_GOLD} Gold.` };
  spend(world, 'wages', DISMISS_GOLD);
  forget(world, c);
  staffNow(world);
  noteAttention(world);
  pushFeed(world, 'social', `${c.name} was sent on their way with ${DISMISS_GOLD} Gold. The road took them.`);
  return { ok: true, message: `${c.name} has left.` };
}

/** Open or close the gates to newcomers. */
export function setGates(world: World, closed: boolean) {
  useWorld(world);
  if (!!world.gatesClosed === closed) return;
  world.gatesClosed = closed || undefined;
  noteAttention(world);
  pushFeed(world, 'social', closed ? 'The gates are closed. Nobody new will be taken in until they open again.' : 'The gates are open again. Newcomers may come.');
}

/** Posts standing empty across every trade: the work there is for somebody new. */
export function openPostsOf(world: World): number {
  useWorld(world);
  const counts: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) if (c.age >= 16) counts[c.job] = (counts[c.job] ?? 0) + 1;
  let open = 0;
  for (const job of Object.keys(jobs) as WorkingJob[]) open += Math.max(0, jobCapacity(world, job) - (counts[job] ?? 0));
  return open;
}

/* ------------------------------------------------------------------ *
 * Unrest: the rogue, and the people who stop them
 * ------------------------------------------------------------------ */

/** A rogue who has brought down this many buildings is not taken alive. */
export const ROGUE_KILL_AT = 2;
/** How close a pursuer has to get. */
const CATCH_REACH = 1.8;
/** How long a scuffle lasts, in game hours. */
const SCUFFLE_HOURS = 0.35;

/**
 * Once a day, somebody may turn.
 *
 * Not out of nowhere: the miserable, the purposeless, and people with a
 * real enemy in the settlement. A jail halves it — a place with somewhere
 * to put people is a place fewer people test. Never in the first days, and
 * never two at once.
 */
function unrest(world: World) {
  for (const c of world.citizens) {
    if (!c.jailed) continue;
    c.jailed -= 1;
    if (c.jailed > 0) continue;
    c.jailed = undefined;
    c.happiness = Math.max(c.happiness, 55);
    c.purpose = Math.max(c.purpose, 40);
    c.dwell = 0;
    pushFeed(world, 'social', `${c.name} was let out of the jail, quieter than they went in.`);
  }
  if (world.day < 6 || world.citizens.some((c) => c.rogue)) return;
  const rand = mulberry32(world.seed + world.day * 5573);
  // Every jail halves the chance of anybody turning, down to a tenth of it.
  // Two jails in a town of a hundred and fifty used to make no more
  // difference than one, and that one only halved a chance nobody could see.
  const chance = 0.05 * jailFactor(world);
  for (const c of world.citizens) {
    if (c.age < 16 || c.jailed || c.sick || c.carried) continue;
    const enemy = rivalsOf(world, c.id).some((r) => r.strength < -65);
    const bitter = c.happiness < 32 || c.purpose < 12 || enemy;
    if (!bitter || rand() > chance) continue;
    turnRogue(world, c, enemy ? 'a grudge that has been building for days' : c.happiness < 32 ? 'misery' : 'having nothing to live for');
    return;
  }
}

/** How much the jails hold trouble down: half per jail standing, never below a tenth. */
export function jailFactor(world: World) {
  const jail = world.buildings.find((b) => b.type === 'Jail' && b.active && !b.ruined);
  return jail ? Math.max(0.1, Math.pow(0.5, levelOf(jail))) : 1;
}

/**
 * How many buildings one rogue can bring down before the whole settlement
 * closes in on them: three with no jail, and fewer the better the jail — a
 * level-three jail has a warden who stops them at the first.
 */
export function rogueLimit(world: World) {
  const jail = world.buildings.find((b) => b.type === 'Jail' && b.active && !b.ruined);
  return jail ? Math.max(1, 4 - levelOf(jail)) : 3;
}

/**
 * The settlement corners a rogue without a chase: they have wrecked what the
 * jail allows, or been loose a whole day. Jailed where a jail stands, killed
 * past the kill mark otherwise. A rogue who wrecked twenty-seven buildings
 * past a level-three jail was the single worst thing in the feedback.
 */
function cornerRogue(world: World, r: Citizen, why: string) {
  if (!r.rogue) return;
  const wrecked = r.rogue.damage;
  for (const c of world.citizens) if (c.chasing === r.id) { c.chasing = undefined; c.scuffle = 0; c.dwell = 0; }
  r.scuffle = 0;
  const cell = findBuilding(world, 'Jail');
  if (!cell && wrecked >= ROGUE_KILL_AT) {
    bury(world, r, `${r.name} was cornered by the whole settlement ${why} and killed, after wrecking ${wrecked} buildings.`);
    return;
  }
  r.rogue = undefined;
  r.jailed = 4 + wrecked * 3;
  r.happiness = 30;
  r.chasing = undefined;
  assignDestination(world, r, 'jailed');
  pushFeed(world, 'social', `${r.name} was cornered by the whole settlement ${why} and thrown in the ${cell ? 'jail' : 'market cellar'}. ${r.jailed} days.`);
}

/** Somebody turns on the settlement. */
function turnRogue(world: World, c: Citizen, why: string) {
  releaseAmenity(world, c);
  releasePrey(world, c);
  c.rogue = { since: world.day, damage: 0, escapes: 0 };
  c.chasing = undefined;
  c.inside = false;
  c.dwell = 0;
  pickRogueTarget(world, c);
  pushFeed(world, 'social', `${c.name} has turned on the settlement, out of ${why}. Whatever stands nearest is in danger.`);
}

/** The nearest thing worth wrecking, or nothing, in which case the rogue gives up. */
function pickRogueTarget(world: World, c: Citizen): Building | undefined {
  if (!c.rogue) return undefined;
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of world.buildings) {
    if (b.ruined || !b.active || UNDEMOLISHABLE.includes(b.type) || b.type === 'Jail') continue;
    const d = Math.hypot(b.x - c.x, b.y - c.y);
    if (d < bestD) { bestD = d; best = b; }
  }
  c.rogue.targetId = best?.id;
  if (!best) {
    pushFeed(world, 'social', `${c.name} ran out of things to wreck and slunk off home.`);
    c.rogue = undefined;
    c.happiness = Math.max(c.happiness, 40);
  }
  assignDestination(world, c, c.rogue ? 'rogue' : phaseFor(c, world.hour));
  return best;
}

/**
 * The rogue at the walls, and the chase.
 *
 * A rogue walks to the nearest building and sets about it; it comes down in
 * a few hours. The nearest three adults awake drop what they are doing and
 * go after them, and when one gets within arm's reach there is a scuffle
 * that nobody moves during. It ends with the rogue caught, or — twice at
 * most — broken free and off after the next building. The player has no
 * hand in any of it.
 */
function unrestStep(world: World, hours: number) {
  const rogues = world.citizens.filter((c) => c.rogue);
  // Pursuers whose quarry is gone go back to their day.
  for (const c of world.citizens) {
    if (c.chasing && !rogues.some((r) => r.id === c.chasing)) { c.chasing = undefined; c.scuffle = 0; c.dwell = 0; }
  }
  for (const r of rogues) {
    if (!r.rogue) continue;
    if (r.scuffle && r.scuffle > 0) {
      r.scuffle -= hours;
      if (r.scuffle <= 0) resolveScuffle(world, r);
      continue;
    }
    // At the walls.
    let mark = world.buildings.find((b) => b.id === r.rogue?.targetId);
    if (!mark || mark.ruined || !mark.active) mark = pickRogueTarget(world, r);
    if (!r.rogue || !mark) continue;
    if (Math.hypot(mark.x - r.x, mark.y - r.y) <= footprintRadius(mark) + 2.6) {
      r.activity = 'working';
      if (damageBuilding(world, mark, 0.25 * hours, r.name)) {
        r.rogue.damage += 1;
        r.rogue.targetId = undefined;
      }
    }
    // Enough. The town does not need a chase to end this.
    if (r.rogue.damage >= rogueLimit(world)) { cornerRogue(world, r, 'at the last building'); continue; }
    if (world.day - r.rogue.since >= 1) { cornerRogue(world, r, 'by morning'); continue; }
    // The chase.
    const chasers = world.citizens.filter((c) => c.chasing === r.id);
    if (chasers.length < 3) {
      const able = world.citizens
        .filter((c) => c.id !== r.id && c.age >= 16 && !c.rogue && !c.chasing && !c.jailed && !c.sick && !c.carried && !c.swimming
          && Math.hypot(c.x - r.x, c.y - r.y) < 45)
        .sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y));
      // The awake first; failing anybody awake, the noise wakes the nearest.
      // A rogue used to have the whole night to themselves.
      const awake = able.filter((c) => phaseFor(c, world.hour) !== 'sleeping');
      const recruits = (awake.length ? awake : able).slice(0, 3 - chasers.length);
      for (const c of recruits) {
        releaseAmenity(world, c);
        c.chasing = r.id;
        c.inside = false;
        assignDestination(world, c, 'pursuit');
        chasers.push(c);
      }
      if (recruits.length && !r.rogue.caught) {
        r.rogue.caught = true;
        pushFeed(world, 'social', `${recruits.map((c) => c.name).join(' and ')} ${recruits.length === 1 ? 'has' : 'have'} gone after ${r.name}.`);
      }
    }
    for (const c of chasers) {
      if (c.scuffle && c.scuffle > 0) { c.scuffle -= hours; continue; }
      const d = Math.hypot(c.x - r.x, c.y - r.y);
      if (d <= CATCH_REACH) {
        r.scuffle = SCUFFLE_HOURS;
        for (const o of chasers) if (Math.hypot(o.x - r.x, o.y - r.y) <= 3.5) o.scuffle = SCUFFLE_HOURS;
        pushFeed(world, 'social', `${c.name} has caught up with ${r.name}. There is a scuffle at the ${mark.type.toLowerCase()}.`);
        break;
      }
      // Keep the chase pointed at where the rogue is now, not where they were.
      c.dwell -= hours;
      if (c.dwell <= 0 || Math.hypot(c.destX - r.x, c.destY - r.y) > 2.5) {
        assignDestination(world, c, 'pursuit');
        c.dwell = 0.2;
      }
    }
  }
}

/** The scuffle ends: broken free, jailed, or killed. */
function resolveScuffle(world: World, r: Citizen) {
  if (!r.rogue) return;
  const chasers = world.citizens.filter((c) => c.chasing === r.id && Math.hypot(c.x - r.x, c.y - r.y) <= 4);
  const rand = mulberry32(world.seed + world.day * 811 + Math.floor(world.hour * 100));
  r.scuffle = 0;
  for (const c of chasers) c.scuffle = 0;
  // With a jail standing there is a warden about, and a rogue in a scuffle is
  // rarely off again: once in ten, against once in three without one.
  const slip = hasCivic(world, 'Jail') ? 0.1 : 0.3;
  if (!chasers.length || (r.rogue.escapes < 2 && rand() < slip)) {
    r.rogue.escapes += 1;
    r.rogue.targetId = undefined;
    pushFeed(world, 'social', `${r.name} broke free and ran.`);
    pickRogueTarget(world, r);
    return;
  }
  const names = chasers.slice(0, 2).map((c) => c.name).join(' and ');
  const wrecked = r.rogue.damage;
  for (const c of chasers) { c.chasing = undefined; c.dwell = 0; c.purpose = Math.min(100, c.purpose + 6); }
  if (wrecked >= ROGUE_KILL_AT) {
    bury(world, r, `${r.name} was killed by ${names} after wrecking ${wrecked} buildings. The settlement will not forget it.`);
    return;
  }
  const cell = findBuilding(world, 'Jail');
  r.rogue = undefined;
  r.jailed = 4 + wrecked * 3;
  r.happiness = 30;
  r.chasing = undefined;
  assignDestination(world, r, 'jailed');
  pushFeed(world, 'social', `${names} threw ${r.name} in the ${cell ? 'jail' : 'market cellar'}${wrecked ? ` for wrecking the ${wrecked === 1 ? 'building' : 'buildings'}` : ''}. ${r.jailed} days.`);
}

/**
 * Bring trouble on, for a test or a demonstration. Not reachable from play.
 *
 * Starts the named hazard at a stated severity whatever the weather, or turns
 * the unhappiest adult rogue.
 */
export function trial(world: World, what: HazardKind | 'rogue', severity = 0.8) {
  useWorld(world);
  if (what === 'rogue') {
    const c = [...world.citizens].filter((x) => x.age >= 16 && !x.rogue && !x.jailed).sort((a, b) => a.happiness - b.happiness)[0];
    if (c) turnRogue(world, c, 'misery');
    return;
  }
  world.hazards = [];
  startHazard(world, what, 1 - severity, mulberry32(world.seed + world.day * 97 + 5));
}

/** Whether a hazard of this kind is running. Production and needs both ask. */
export function hazardActive(world: World, kind: HazardKind) {
  useWorld(world);
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
  const larder: Resource[] = FOOD;
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
      // Bread goes further than raw grain, which is the point of the bakery;
      // a fish or a cut of game is a proper meal too.
      eaten += take * (r === 'bread' ? 1.15 : r === 'fish' || r === 'game' ? 1.1 : 1);
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
    // A clinic does not stop anybody growing old. It stops a bad week
    // being the end of them.
    if (hasCare(world)) risk *= 1 - survivalOf(world);

    if (rand() < risk) dead.push(c);
  }

  for (const c of dead) {
    const cause = c.hunger <= 4 ? 'went hungry'
      : c.warmth <= 6 ? (c.chilled ? 'could not keep warm' : 'could not escape the heat')
        : c.age >= c.lifespan ? `died at ${Math.floor(c.age)}, of old age`
          : `died at ${Math.floor(c.age)}`;
    bury(world, c, c.age >= c.lifespan && c.hunger > 4 && c.warmth > 6
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
const BRIDGE_TIMBER_PRICE = (world: World) => Math.max(3, Math.ceil((world.market.wood?.price ?? 3) * 1.5));

/** What a crossing ordered by the player costs to start, in Gold. */
export const BRIDGE_GOLD = 600;

/**
 * Start a bridge where the player pointed.
 *
 * The town builds bridges on its own when it is rich enough and the far
 * shore is worth it; this is the player choosing the far shore themselves.
 * The point is any land the settlement cannot walk to; the crossing is still
 * the narrowest sound one to that island, so the deck lands somewhere useful.
 * Gold up front, timber from the yard by the day, bought in when short.
 */
export function startBridgeAt(world: World, x: number, y: number): { ok: boolean; message: string } {
  useWorld(world);
  const water = waterOf(world);
  if (world.bridgeWorks) return { ok: false, message: 'A bridge is already being built. One crossing at a time.' };
  if (world.treasury < BRIDGE_GOLD) return { ok: false, message: `A crossing costs ${BRIDGE_GOLD.toLocaleString()} Gold to start.` };
  const island = water.landAt(x, y);
  const reachable = island >= 0 && (island === water.mainland || world.connectedIslands.includes(island));
  if (island >= 0 && !reachable) {
    // Land nobody can walk to: the crossing goes wherever the water is
    // narrowest between here and there, which is what the crew would pick.
    const crossing = narrowestCrossing(world, island);
    if (!crossing) return { ok: false, message: 'No sound crossing to that shore could be found.' };
    spend(world, 'works', BRIDGE_GOLD);
    world.bridgeWorks = {
      island,
      fromX: crossing.fromX, fromY: crossing.fromY,
      toX: crossing.toX, toY: crossing.toY,
      progress: 0,
      length: Math.max(3, Math.round(crossing.gap / 2.5)),
    };
    noteAttention(world);
    pushFeed(world, 'build', 'The crossing you ordered has been staked out. The bridge crew starts in the morning.');
    return { ok: true, message: 'The bridge is staked out.' };
  }
  // Water, or a bank people can already reach the long way round: a bridge
  // where the player pointed, across the narrowest stretch of water there.
  // "People can already walk there" was the answer a player got for a lake
  // in the middle of their town, and it was no answer at all.
  const chord = shortcutCrossing(world, x, y);
  if (!chord) {
    return {
      ok: false,
      message: island < 0
        ? 'No bank within reach of that water. Tap nearer the shore you want to bridge.'
        : 'No water near there to bridge. Tap the water you want crossed, or the land across it.',
    };
  }
  if (world.layout.bridges.some((b) => Math.hypot(b.x - (chord.fromX + chord.toX) / 2, b.y - (chord.fromY + chord.toY) / 2) < 6)) {
    return { ok: false, message: 'There is a bridge there already.' };
  }
  spend(world, 'works', BRIDGE_GOLD);
  world.bridgeWorks = {
    island: water.landAt(chord.toX, chord.toY),
    shortcut: true,
    fromX: chord.fromX, fromY: chord.fromY,
    toX: chord.toX, toY: chord.toY,
    progress: 0,
    length: Math.max(3, Math.round(chord.gap / 2.5)),
  };
  noteAttention(world);
  pushFeed(world, 'build', 'The crossing you ordered has been staked out across the water. The bridge crew starts in the morning.');
  return { ok: true, message: 'The bridge is staked out.' };
}

/**
 * The narrowest stretch of water at the point the player tapped.
 *
 * From a tap on the water, a line is cast in every direction and the
 * shortest one with a bank at both ends wins. From a tap on land, the line
 * runs from that bank out over the water to the next one. Either way both
 * ends are dry ground inside the plot, and the deck is never longer than a
 * crew could build.
 */
function shortcutCrossing(world: World, x: number, y: number): { fromX: number; fromY: number; toX: number; toY: number; gap: number } | null {
  const water = waterOf(world);
  const ext = activeExtent;
  const STEP = 0.5, REACH = 36, TO_SHORE = 10, MIN_GAP = 2;
  const inside = (px: number, py: number) => px >= ext.x0 + 2 && px <= ext.x1 - 2 && py >= ext.y0 + 3 && py <= ext.y1 - 3;
  const dry = (px: number, py: number) => inside(px, py) && water.landAt(px, py) >= 0;
  // Walk from a point on the water to the first dry ground along a heading.
  const toBank = (sx: number, sy: number, dx: number, dy: number): [number, number] | null => {
    let px = sx, py = sy;
    for (let over = 0; over < REACH; over += STEP) {
      px += dx * STEP; py += dy * STEP;
      if (!inside(px, py)) return null;
      if (water.landAt(px, py) >= 0) return [px, py];
    }
    return null;
  };
  // Walk from a point on land to its shore along a heading: the last dry point.
  const toShore = (sx: number, sy: number, dx: number, dy: number): [number, number] | null => {
    let px = sx, py = sy, last: [number, number] = [sx, sy];
    for (let walked = 0; walked < TO_SHORE; walked += STEP) {
      px += dx * STEP; py += dy * STEP;
      if (!inside(px, py)) return null;
      if (water.landAt(px, py) < 0) return last;
      last = [px, py];
    }
    return null;
  };
  const onLand = dry(x, y);
  let best: { fromX: number; fromY: number; toX: number; toY: number; gap: number } | null = null;
  const headings = onLand ? 48 : 24;
  for (let k = 0; k < headings; k++) {
    const ang = (k / headings) * (onLand ? Math.PI * 2 : Math.PI);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let from: [number, number] | null, to: [number, number] | null;
    if (onLand) {
      from = toShore(x, y, dx, dy);
      if (!from) continue;
      to = toBank(from[0], from[1], dx, dy);
    } else {
      from = toBank(x, y, -dx, -dy);
      to = toBank(x, y, dx, dy);
    }
    if (!from || !to) continue;
    const gap = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (gap < MIN_GAP) continue;
    if (!best || gap < best.gap) best = { fromX: from[0], fromY: from[1], toX: to[0], toY: to[1], gap };
  }
  return best;
}

function bridgeBuilding(world: World) {
  const water = waterOf(world);
  const works = world.bridgeWorks;

  if (works) {
    // A day's work needs timber and wages. Short of either, the work waits.
    let timber = Math.min(6, world.resources.wood);
    // Short of timber, the treasury buys it in, at the market's price and a
    // half. Players whose towns had stopped bridging had run their woodcutters
    // down to nothing and had a hundred thousand Gold sitting idle.
    if (timber < 4 && world.treasury >= 40 + BRIDGE_TIMBER_PRICE(world) * (6 - timber)) {
      const bought = 6 - timber;
      spend(world, 'imports', BRIDGE_TIMBER_PRICE(world) * bought);
      world.resources.wood += bought;
      timber = 6;
      if (works.progress === 0) pushFeed(world, 'build', 'The bridge crew bought timber in for the crossing.');
    }
    if (timber < 4 || world.treasury < 40) {
      if (world.day % 3 === 0) pushFeed(world, 'build', 'Work on the bridge is held up for want of timber and Gold.');
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
  for (let y = activeExtent.y0 + 5; y < activeExtent.y1 - 4; y += 1.5) {
    for (let x = activeExtent.x0 + 5; x < activeExtent.x1 - 4; x += 1.5) {
      if (water.landAt(x, y) !== island) continue;
      // The far end has to be ground somebody could stand a building on. The
      // shortest gap is often a one-cell sliver at the edge of the map, and a
      // deck landing there reaches nowhere: the settlement spent a week's
      // timber on it and never put a single building across.
      if (water.distanceToWater(x, y) < 3.2) continue;
      const back = water.toMainland(x, y);
      if (back.d <= 1 || back.d >= 26) continue;
      const rim = Math.max(0, 12 - Math.min(x - activeExtent.x0, y - activeExtent.y0, activeExtent.x1 - x, activeExtent.y1 - y));
      const inland = Math.hypot(x - centre.x, y - centre.y);
      const score = back.d + rim * 1.4 + inland * 0.22;
      if (score >= bestScore) continue;
      bestScore = score;
      best = {
        toX: x,
        toY: y,
        gap: back.d,
        fromX: edge(x + back.x * back.d, 2, 98),
        fromY: edge(y + back.y * back.d, 4, 96),
      };
    }
  }
  return best;
}

/** What the player pays to have one tree felled, in Gold. */
export const CLEAR_TREE_GOLD = 12;
/** What one felled tree puts in the yard. */
export const CLEAR_TREE_WOOD = 3;
/** How far round the tap a clearing reaches, in world units. */
export const CLEAR_RADIUS = 6;
/** Days before a clearing has grown back enough to stop being one. */
export const CLEARING_DAYS = 12;

/**
 * Clear trees off the plot.
 *
 * The renderer owns the trees — it knows where they stand and fells them —
 * so this is the ledger side: how many the treasury can pay for, the Gold
 * out, the timber in, and a note of where, so the wood shows as cleared after
 * a reload and grows back over the days that follow. Returns how many the
 * player can afford, which the renderer then actually fells.
 */
export function clearTrees(world: World, x: number, y: number, standing: number): { felled: number; gold: number; wood: number } {
  useWorld(world);
  const affordable = Math.floor(world.treasury / CLEAR_TREE_GOLD);
  const felled = Math.max(0, Math.min(standing, affordable));
  if (felled === 0) return { felled: 0, gold: 0, wood: 0 };
  const gold = felled * CLEAR_TREE_GOLD;
  const wood = felled * CLEAR_TREE_WOOD;
  spend(world, 'works', gold);
  world.resources.wood += wood;
  note(world, 'produced', 'wood', wood);
  world.clearings = [...(world.clearings ?? []).filter(([, , day]) => world.day - day < CLEARING_DAYS), [x, y, world.day]];
  noteAttention(world);
  pushFeed(world, 'build', felled === 1
    ? `A tree was cleared for ${gold} Gold. ${wood} timber went to the yard.`
    : `${felled} trees were cleared for ${gold} Gold. ${wood} timber went to the yard.`);
  return { felled, gold, wood };
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
    layout.nodes.push([edge(x, 3, 97), edge(y, 4, 96)]);
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
    if (px < activeExtent.x0 + 6 || px > activeExtent.x1 - 6 || py < activeExtent.y0 + 8 || py > activeExtent.y1 - 8) break;
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
    for (let py = activeExtent.y0 + 9; py <= activeExtent.y1 - 9 && found.length < 4; py += 2) {
      for (let px = activeExtent.x0 + 7; px <= activeExtent.x1 - 7 && found.length < 4; px += 2) {
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

  if (works.island !== water.mainland && !world.connectedIslands.includes(works.island)) world.connectedIslands.push(works.island);
  world.bridgeWorks = null;
  if (works.shortcut) {
    pushFeed(world, 'build', 'The bridge is finished. The crossing is open.');
  } else {
    world.unlockedAreas.push('The Far Shore');
    pushFeed(world, 'build', 'The bridge is finished. The far shore is open.');
  }
}

/** What a settlement pays to raise a building for itself. Mirrors the build menu. */
const SELF_BUILD_COST: Record<string, number> = { House: 100, Woodcutter: 125, Farm: 150 };
const TRADE_BUILD_COST: Record<string, number> = {
  Fishery: 140, Lodge: 180, Forager: 90,
  Quarry: 175, Mine: 250, Mill: 250, Bakery: 300, Carpenter: 275, Blacksmith: 400, Tailor: 325,
  Storage: 120, Tavern: 350, Bank: 450,
  // The civic buildings. None employs anybody; each changes how the town lives.
  Cafe: 300, School: 380, Library: 360, Studio: 340, Clinic: 420, Lab: 520,
  Jail: 220, 'Town Hall': 480,
  // The township. Stone and tile, and each one changes how the town moves
  // or thinks: the stables put carts on the roads, the harbour a ferry on
  // the water, the chapel and the brewery give people somewhere to be, the
  // guildhall and the printer make them better at what they do.
  Chapel: 380, Guildhall: 460, Brewery: 340, Printer: 360, Stables: 280, Harbour: 420, Monument: 0,
  // The industrial era: brick and iron, and the first machines.
  Factory: 640, Foundry: 600, 'Railway Station': 720, Telegraph: 380, Gasworks: 560,
  // The modern era: concrete and glass, and the roads fill up.
  Hospital: 900, Stadium: 1100, Supermarket: 700, Office: 760, 'Bus Depot': 680, 'Power Plant': 1000,
  // The AI era: light and quiet.
  'Data Centre': 1400, 'Research Campus': 1600, 'Vertical Farm': 1200, 'Pod Hub': 1300, 'Drone Port': 1100,
};

/** What a building costs to raise, by type. Everything the panel shows comes from here. */
export const BUILD_COSTS: Record<string, number> = { ...SELF_BUILD_COST, ...TRADE_BUILD_COST };

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
  Fishery: { wood: 10, stone: 2 },
  Lodge: { wood: 14, stone: 4 },
  Forager: { wood: 6, stone: 0 },
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
  Cafe: { wood: 18, stone: 8 },
  School: { wood: 22, stone: 14 },
  Library: { wood: 20, stone: 16 },
  Studio: { wood: 20, stone: 8 },
  Clinic: { wood: 12, stone: 24 },
  Lab: { wood: 14, stone: 30 },
  Jail: { wood: 8, stone: 22 },
  'Town Hall': { wood: 20, stone: 30 },
  Chapel: { wood: 10, stone: 30 },
  Monument: { wood: 0, stone: 0 },
  Guildhall: { wood: 16, stone: 28 },
  Brewery: { wood: 20, stone: 14 },
  Printer: { wood: 14, stone: 18 },
  Stables: { wood: 24, stone: 6 },
  Harbour: { wood: 30, stone: 12 },
  Factory: { wood: 30, stone: 40 },
  Foundry: { wood: 20, stone: 44 },
  'Railway Station': { wood: 36, stone: 36 },
  Telegraph: { wood: 24, stone: 10 },
  Gasworks: { wood: 14, stone: 40 },
  Hospital: { wood: 30, stone: 60 },
  Stadium: { wood: 40, stone: 80 },
  Supermarket: { wood: 30, stone: 40 },
  Office: { wood: 24, stone: 56 },
  'Bus Depot': { wood: 34, stone: 40 },
  'Power Plant': { wood: 20, stone: 80 },
  'Data Centre': { wood: 20, stone: 90 },
  'Research Campus': { wood: 40, stone: 100 },
  'Vertical Farm': { wood: 50, stone: 60 },
  'Pod Hub': { wood: 30, stone: 70 },
  'Drone Port': { wood: 30, stone: 60 },
};

/** What this kind of building takes to raise. Anything unlisted is a modest shed. */
export function buildMaterials(type: string) {
  return BUILD_MATERIALS[type] ?? { wood: 10, stone: 4 };
}

/** Whether the stores can cover a building of this kind. */
export function materialsInStore(world: World, type: string) {
  useWorld(world);
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
  const homeless = world.citizens.filter((c) => c.age >= 16 && !homeOf(world, c)).length;
  const crowded = world.citizens.length > housingRoom(world) * 1.06;

  // What the settlement would choose on its own, reading its own shortages.
  let ownChoice: string | null = null;
  // The need behind the choice, when it came off the helper's list, so the
  // feed can say why the town built what it built.
  let needSaid: string | null = null;
  if (homeless > 0 || crowded) ownChoice = 'House';
  else if (world.resources.wood < 22 && !world.buildings.some((b) => b.type === 'Woodcutter')) ownChoice = 'Woodcutter';
  else if (foodInStore(world) < world.citizens.length * 2.5) {
    // A shore town feeds itself from the water first, if the land is that kind of land.
    const shore = biomeProfile(world.biome).trades.indexOf('Fishery');
    const farm = biomeProfile(world.biome).trades.indexOf('Farm');
    ownChoice = shore >= 0 && shore < farm && !world.buildings.some((b) => b.type === 'Fishery') ? 'Fishery' : 'Farm';
  }
  else {
    /*
     * With the roof, the hearth and the larder seen to, the settlement reads
     * its own needs the way the plot helper does — the store with nothing to
     * keep a surplus in, the town with nowhere to meet, the trade with nobody
     * to learn it faster, the winter with no clinic — and raises the first of
     * them it can pay for. The list is the same one the player is shown, so
     * what the town builds on its own is what it would have asked for.
     */
    const seen = adviseBuild(world).find((a) => a.kind === 'build' && a.type
      && world.treasury >= (BUILD_COSTS[a.type] ?? TRADE_BUILD_COST[a.type] ?? 250) * 2
      && materialsInStore(world, a.type));
    if (seen?.type) {
      ownChoice = seen.type;
      needSaid = seen.why;
    } else if (world.treasury > 4000) {
      // A settlement with money it does not need takes up a trade its land
      // supports and it has not opened yet. Otherwise the gold simply piles up:
      // a grassland reached thirty-five thousand and never spent a coin of it.
      ownChoice = biomeProfile(world.biome).trades
        .find((type) => !world.buildings.some((b) => b.type === type)) ?? null;
    }
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
  const upkeep = world.buildings.filter((b) => b.active).reduce((sum, b) => sum + upkeepOf(b), 0);
  // Three times over, and a fortnight of running costs left standing — unless
  // the town resolved on this in front of everybody, in which case it will
  // accept a thinner cushion for it. That is what a vote is worth: the same
  // settlement, slightly braver about the thing it agreed on.
  if (uniqueStanding(world, want)) return;
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
  const raised: Building = { id: `b${world.counter++}`, type: want, x: site[0], y: site[1], workers: [], active: true, era: eraOf(world) };
  world.buildings.push(raised);
  if (raised.type === 'House') rehouse(world);
  linkToRoads(world, raised);
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  pushFeed(world, 'build', bySay
    ? `The settlement built a ${want.toLowerCase()}, as the meeting resolved.`
    : want === 'House'
      ? 'The settlement raised another house.'
      : needSaid && want === ownChoice
        ? `The settlement built a ${want.toLowerCase()} for itself, seeing the need.`
        : `The settlement built a ${want.toLowerCase()}.`);
  if (needSaid && want === ownChoice && !bySay) pushFeed(world, 'build', needSaid);
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
      if (!have) continue;
      const room = jobCapacity(world, other);
      // A trade with no building at all is a trade in name only: its one
      // worker is the first to move. A coast opened with a fishery and nobody
      // in it for weeks, because every founder was the sole carpenter or
      // smith of a workshop that did not exist.
      if (have < 2 && room > 0) continue;
      const over = have - room;
      const score = room === 0 ? have + 20 : over > 0 ? over + 10 : have;
      if (score > surplus) { surplus = score; from = other; }
    }
    // Never somebody the owner trained and is still holding to a trade.
    const mover = from
      ? workers.find((c) => c.job === from && !heldTrade(world, c))
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
    if (!reachable(world, water, on)) continue;
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
  if (foodInStore(world) < world.citizens.length * 2) return;

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
      skills: {},
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
/**
 * How few people a settlement can fall to before word gets out that there is
 * land going spare.
 */
const LAST_RESORT_POPULATION = 3;

/** How many people a house is thought to sleep, and what each improvement adds. */
// Three beds, and two more with every improvement: 3, 5, 7. Improving a house
// used to add less than one bed, which left players asking what the point was.
export const HOUSE_ROOM = 3;
export const HOUSE_ROOM_PER_LEVEL = 2;
/** How many people this one house sleeps, whole. */
export const houseRoom = (b: Building) => Math.round(HOUSE_ROOM + (levelOf(b) - 1) * HOUSE_ROOM_PER_LEVEL);

/**
 * How many people the settlement's houses can sleep between them.
 *
 * An improved house is a roomier one: this is where improving a home pays,
 * since a house holds no workers to give more of.
 */
export function housingRoom(world: World): number {
  useWorld(world);
  return world.buildings
    .filter((b) => b.type === 'House' && b.active)
    .reduce((sum, b) => sum + HOUSE_ROOM + (levelOf(b) - 1) * HOUSE_ROOM_PER_LEVEL, 0);
}

/** What draws people: the most a well-run town can expect in one day. */
export const MAX_ARRIVALS_PER_DAY = 3;

function migration(world: World, rand: () => number) {
  const roomFor = () => world.citizens.length < housingRoom(world);
  const fedFor = () => {
    const food = foodInStore(world);
    return food >= Math.max(12, world.citizens.length * 4);
  };
  // A spare roof and a full store. Nobody moves to a place they would have
  // to sleep outside in, or go hungry in.
  if (!roomFor() || !fedFor()) return;
  // The player's say. A closed gate is absolute.
  if (world.gatesClosed) {
    if (world.day % 6 === 0) pushFeed(world, 'social', 'The gates are closed: nobody new is taken in.');
    return;
  }

  /*
   * Below a handful of people, a roof and a meal are the whole test.
   *
   * The gates underneath are a prosperity test — a treasury four days deep and
   * a contented population — and they are the right test for whether a healthy
   * place keeps growing. They are the wrong test for a place in trouble,
   * because a settlement whose treasury has been thin for a season can never
   * pass them again. Births need two parents of an age in one household, which
   * a shrinking settlement also stops being able to supply, so nothing comes
   * in at all: it loses its elders one at a time and arrives at zero, and a
   * plot at zero is finished for good — no work, no yield, nothing the player
   * can do from inside the game to restart it. Measured on the opening seeds,
   * two of nine went from eight people to none inside a hundred and ten days.
   *
   * Hard times should be survivable and recoverable, not terminal. Somebody
   * will always try their luck on standing houses with grain in the store,
   * whatever the books look like.
   */
  const desperate = world.citizens.length <= LAST_RESORT_POPULATION;
  // And work to come to. A big plot with a spare bed in every house drew
  // people by the dozen with every post already filled, and the newcomers
  // sat idle, eating imported bread the treasury paid for. Past the last
  // few people, the road brings at most as many as there are posts open.
  const posts = openPostsOf(world);
  if (!desperate && posts <= 0) {
    if (world.day % 4 === 0) pushFeed(world, 'social', `Nobody new is moving to ${world.name}: every post is filled.`);
    return;
  }

  /*
   * The prosperity tests slow arrivals rather than stop them.
   *
   * They used to be hard gates, and a plot with plenty of houses and plenty of
   * buildings sat at eight people for eighty days because the upkeep on all
   * those buildings kept the treasury under four days of payroll: nobody
   * could ever come, and nothing told the player why. A thin treasury or a
   * glum town now draws a third as many people, and the feed says so once
   * every few days, which is the difference between a plot that has stalled
   * and a plot that is telling you what it needs.
   */
  let welcome = 1;
  let held: string | null = null;
  if (!desperate) {
    const payroll = world.citizens.filter((c) => c.age >= 16 && c.job !== 'unemployed')
      .reduce((sum, c) => sum + jobs[c.job as WorkingJob].wage, 0);
    const content = world.citizens.reduce((s, c) => s + c.happiness, 0) / Math.max(1, world.citizens.length);
    if (world.treasury < payroll * 4 + 120) { welcome *= 0.35; held = 'the treasury cannot promise a wage'; }
    if (content < 55) { welcome *= 0.4; held = held ? `${held}, and the town is unhappy` : 'the town is unhappy'; }
    if (held && world.day % 4 === 0) {
      pushFeed(world, 'social', `Few people are moving to ${world.name}: word is ${held}.`);
    }
  }

  /*
   * How many come.
   *
   * Word travels on how the place is run. A bare camp draws somebody every
   * few days; a town that is well stewarded, has a cafe and a school and a
   * clinic, and has improved what it built, draws a couple of people most
   * days. That is the reward for improving a plot: it fills up. A settlement
   * down to its last few draws steadily rather than quickly — enough to come
   * back from, not enough to make neglect free.
   */
  const renown = stewardshipScore(world);
  const civic = ['Cafe', 'School', 'Library', 'Studio', 'Clinic', 'Lab', 'Tavern']
    .filter((type) => hasCivic(world, type)).length;
  const improved = world.buildings.reduce((sum, b) => sum + (levelOf(b) - 1), 0);
  const draw = desperate
    ? 0.22
    : (0.16 + Math.min(0.3, world.buildings.length * 0.02) + renown * 0.5 + civic * 0.06 + Math.min(0.24, improved * 0.04)) * welcome;
  let coming = Math.min(MAX_ARRIVALS_PER_DAY, Math.floor(draw) + (rand() < draw - Math.floor(draw) ? 1 : 0));
  if (!desperate) coming = Math.min(coming, posts);
  let arrived = 0;
  while (coming-- > 0 && roomFor() && fedFor()) {
    arriveOne(world, rand);
    arrived += 1;
  }
  if (arrived >= 2) {
    pushFeed(world, 'social', `${arrived} people arrived on the road today. Word of ${world.name} is getting round.`);
  }
}

/** One settler, on the road, with a family record of their own. */
function arriveOne(world: World, rand: () => number) {
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
    // Somebody who walked here has done something with their life; they just
    // have not done it here.
    skills: {},
    livedDays: 0, lifespan: lifespanFor(rand()), warmth: 80, seated: false, chilled: true, sheltering: false,
  };
  world.families.push(family);
  family.members.push(settler.id);
  world.citizens.push(settler);
  pushFeed(world, 'social', `${name} arrived on the road, looking for work and a roof.`);
  // Housed now, by the same rule as everybody else, not at dawn tomorrow: a
  // town with arrivals most days otherwise always had somebody sleeping rough
  // beside a house with a spare bed, and the helper said so.
  rehouse(world);
}

/**
 * Somebody arrives, from outside the ordinary migration rules.
 *
 * Used by the gacha, where a player has spent real tokens on the chance of
 * people. That purchase is honoured whatever the settlement's housing and food
 * look like — refusing it because the granary is low would be taking payment
 * for nothing. They arrive on the road like any other settler and take their
 * chances with the winter.
 */
export function addSettler(world: World, name?: string): Citizen {
  useWorld(world);
  const rand = mulberry32(world.seed + world.counter * 7919);
  const hash = world.counter * 37 + 11;
  const plaza = world.layout.plaza;
  const spots = world.layout.wanderSpots;
  const arrival = spots.reduce((far, spot) =>
    Math.hypot(spot[0] - plaza.x, spot[1] - plaza.y) > Math.hypot(far[0] - plaza.x, far[1] - plaza.y) ? spot : far,
  spots[0] ?? [plaza.x, plaza.y]);
  const chosen = name ?? SETTLER_NAMES[Math.floor(rand() * SETTLER_NAMES.length)];

  const family: Family = {
    id: `f${world.counter++}`,
    name: familyNames[world.families.length % familyNames.length],
    homeId: '',
    members: [],
    wealth: 40 + Math.floor(rand() * 40),
  };
  const settler: Citizen = {
    id: `c${world.counter++}`,
    name: chosen,
    handle: `@${chosen.toLowerCase()}${(hash % 90) + 10}`,
    familyId: family.id,
    age: 18 + Math.floor(rand() * 26),
    job: 'unemployed',
    hash,
    hunger: 74, rest: 66, social: 58, clothing: 72, purpose: 64,
    happiness: 78, wage: 0, wallet: 30 + Math.floor(rand() * 40),
    x: arrival[0], y: arrival[1], destX: arrival[0], destY: arrival[1],
    path: [], dwell: 0, wanderIdx: hash % 17, errand: false,
    phase: 'wandering', activity: 'idle', facing: 's', moving: false, inside: false,
    stalled: 0, bestAway: Infinity, roughSleeper: false,
    look: Math.floor(rand() * 0xffffff),
    // Somebody who walked here has done something with their life; they just
    // have not done it here.
    skills: {},
    livedDays: 0, lifespan: lifespanFor(rand()), warmth: 80, seated: false, chilled: true, sheltering: false,
  };
  world.families.push(family);
  family.members.push(settler.id);
  world.citizens.push(settler);
  world.population = world.citizens.length;
  pushFeed(world, 'social', `${chosen} walked back with the prospecting party, looking for work.`);
  rehouse(world);
  return settler;
}

/** Put materials in the yard from outside the settlement's own production. */
export function grantResource(world: World, key: Resource, amount: number) {
  useWorld(world);
  if (!(amount > 0)) return;
  world.resources[key] += amount;
  note(world, 'produced', key, amount);
}

/**
 * What one building costs to keep standing, as it actually stands.
 *
 * The counterweight to improving things: a level-three workshop costs twice
 * the upkeep, every day, whether or not anybody is working in it. It is meant
 * to be an investment that pays back rather than one that pays back many times
 * over — see `buildingCapacity` for what happened when it did.
 */
export function upkeepOf(b: Building) {
  // A later era's building is a dearer one to keep: a quarter more per era
  // it was raised in. This is the Gold sink that scales with the city.
  return maintenanceCost(b.type) * (1 + (levelOf(b) - 1) * UPKEEP_PER_LEVEL) * (1 + UPKEEP_PER_ERA * (Math.max(1, b.era ?? 1) - 1));
}
export const UPKEEP_PER_ERA = 0.25;

export function maintenanceCost(type: string) {
  return ({
    Bank: 0, Market: 15, Storage: 3, House: 1, Farm: 3, Woodcutter: 2, Fishery: 2, Lodge: 3, Forager: 1, Quarry: 4, Mine: 6, Mill: 5, Bakery: 6,
    Carpenter: 5, Blacksmith: 8, Tailor: 6, Tavern: 7, 'Town Hall': 10,
    Cafe: 5, School: 6, Library: 5, Studio: 5, Clinic: 7, Lab: 9, Jail: 3,
    Chapel: 4, Guildhall: 7, Brewery: 6, Printer: 6, Stables: 5, Harbour: 8, Monument: 2,
    Factory: 12, Foundry: 11, 'Railway Station': 12, Telegraph: 5, Gasworks: 10,
    Hospital: 14, Stadium: 16, Supermarket: 10, Office: 9, 'Bus Depot': 10, 'Power Plant': 15,
    'Data Centre': 18, 'Research Campus': 20, 'Vertical Farm': 14, 'Pod Hub': 14, 'Drone Port': 12,
  } as Record<string, number>)[type] ?? 2;
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
 * The most $EMERGE one world can mint in a **real** day, at a perfectly run
 * settlement the player is actively managing.
 *
 * Set against what a plot costs — a few hundred thousand — so a couple of weeks
 * of real attention earns back a plot. The rate is per day of wall-clock time,
 * not per day of settlement time, because those differ by two orders of
 * magnitude and the player picks which.
 */
export const STEWARDSHIP_DAILY_CAP = 25_000;

/** Real seconds in a day, which is what the yield is paced against. */
const REAL_DAY = 86_400;

/**
 * How many hours of real neglect it takes to fall to the attention floor.
 *
 * A day and a half: somebody who looks in on their settlement daily keeps the
 * full rate, and somebody who set one up last week and forgot about it does
 * not.
 */
const ATTENTION_HOURS = 36;

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
  useWorld(world);
  world.stewardship.lastActionDay = world.day;
  world.stewardship.lastActionAt = Date.now();
  walletActionAt = Math.max(walletActionAt, world.stewardship.lastActionAt);
}

/**
 * When the player last acted on any of their plots.
 *
 * Attention is the player's, not the plot's: somebody running two
 * settlements can only have one open, and the one they are not looking at
 * should not be counted as neglected while they are busy on the other. Every
 * action stamps this, the client keeps it under the wallet, and each owned
 * world is brought up to it before it is advanced.
 */
let walletActionAt = 0;
export function setWalletAttention(at: number) {
  if (Number.isFinite(at) && at > walletActionAt) walletActionAt = at;
}
export function walletAttentionAt() { return walletActionAt; }
/** Count the wallet's last action as this world's, if it is the more recent. */
export function attendedFrom(world: World, at: number) {
  if (Number.isFinite(at) && at > world.stewardship.lastActionAt) world.stewardship.lastActionAt = at;
}

/** How well this settlement is being run, 0 to 1. */
export function stewardshipScore(world: World) {
  useWorld(world);
  const adults = world.citizens.filter((c) => c.age >= 16);
  if (!adults.length) return 0;
  const housed = adults.filter((c) => homeOf(world, c)).length / adults.length;
  const employed = adults.filter((c) => c.job !== 'unemployed').length / adults.length;
  const content = world.citizens.reduce((s, c) => s + c.happiness, 0) / (world.citizens.length * 100);
  /*
   * How fed the people are — not how full the granary is.
   *
   * This used to be stores divided by mouths, which reads a barn rather than a
   * settlement, and the two come apart in exactly the case that matters: a
   * town whose people have no money cannot buy food, so the food sits in the
   * store and the score called them well fed while they starved. With a wage
   * lever in the player's hand that stopped being a curiosity and became a
   * strategy — cut wages to the floor, let everybody go hungry, and score
   * *better* for it.
   *
   * So it asks the people, and only the people. The granary is not ignored —
   * it is counted where it belongs, in how ready the settlement is for a bad
   * winter, which is already part of `safe`. Counting it here as well both
   * double-counted it and quietly punished growth: stores divided by mouths
   * falls every time somebody is born, so a settlement of thirty-five well-fed
   * people scored worse than one of twenty-four hungry ones.
   */
  const fed = world.citizens.length
    ? clamp(world.citizens.reduce((s, c) => s + c.hunger, 0) / (world.citizens.length * 100), 0, 1)
    : 1;
  // An unanswered hazard is the clearest sign nobody is minding the place.
  const ready = readiness(world);
  const safe = world.hazards.length
    ? world.hazards.reduce((s, h) => s + ready[h.kind], 0) / world.hazards.length
    : 1;
  // An improved town hall keeps order: a little on top, before the square.
  const quality = clamp(housed * 0.25 + fed * 0.25 + employed * 0.2 + content * 0.2 + safe * 0.1 + townHallOrder(world), 0, 1);
  // Squared, so running a place well is worth much more than running it.
  return clamp(quality * quality, 0, 1);
}

/**
 * Accrue stewardship yield for a slice of real time.
 *
 * Called from the tick rather than the day roll, and paid in proportion to the
 * wall-clock seconds that actually passed. Running the settlement faster shows
 * the player more of its life in the same minute; it does not pay them more.
 */
/**
 * Attention averaged over a stretch of real time, given how long the plot
 * had already gone unattended when the stretch began. Attention falls in a
 * straight line to the floor, so the average is the integral of that line.
 */
export function meanAttention(idleHoursAtStart: number, hours: number): number {
  if (!(hours > 0)) return Math.max(ATTENTION_FLOOR, 1 - Math.max(0, idleHoursAtStart) / ATTENTION_HOURS);
  const a = Math.max(0, idleHoursAtStart), b = a + hours;
  const knee = (1 - ATTENTION_FLOOR) * ATTENTION_HOURS; // where the line meets the floor
  const line = (h: number) => h - (h * h) / (2 * ATTENTION_HOURS); // integral of 1 - h/H
  const upTo = (h: number) => (h <= knee ? line(h) : line(knee) + (h - knee) * ATTENTION_FLOOR);
  return (upTo(b) - upTo(a)) / hours;
}

/** The longest stretch paid at once: a month; beyond that the plot has been abandoned. */
const ACCRUAL_CAP_MS = 30 * 86_400_000;

function accrueYield(world: World, realSeconds: number, now = Date.now()) {
  const s = world.stewardship;
  void realSeconds;
  // The time since the yield was last paid up to, on the wall clock, whether
  // or not the game was open in between. A save from before this field
  // existed starts here rather than being paid for its whole history.
  const since = s.accruedAt ?? now;
  const elapsed = Math.max(0, Math.min(ACCRUAL_CAP_MS, now - since));
  s.accruedAt = now;
  const idleHours = Math.max(0, (now - s.lastActionAt) / 3_600_000);
  s.attention = Math.max(ATTENTION_FLOOR, 1 - idleHours / ATTENTION_HOURS);
  s.score = stewardshipScore(world);
  // What a full real day at this rate would come to, which is the figure worth
  // showing: "you are earning this much a day, if you keep this up".
  s.dailyYield = Math.round(dailyCeiling(world) * s.score * s.attention);
  if (elapsed <= 0) return;
  // Paid for the stretch at the attention it actually had through it, not
  // the attention it has now: eleven hours away is paid as eleven hours of
  // a slowly falling rate, not as eleven hours at the rate on return.
  const hours = elapsed / 3_600_000;
  const idleAtStart = Math.max(0, (since - s.lastActionAt) / 3_600_000);
  s.banked += dailyCeiling(world, now) * s.score * meanAttention(idleAtStart, hours) * (elapsed / (REAL_DAY * 1000));
  // Hand over whole tokens only, and keep the remainder banked, so a tick of a
  // sixtieth of a second is not silently rounded away to nothing.
  const whole = Math.floor(s.banked);
  if (whole <= 0) return;
  s.banked -= whole;
  s.pending += whole;
  s.lifetime += whole;
}

/**
 * The most this plot can earn in a real day, from what it has become: its
 * city level and its era, and a charter while one runs. The server judges the
 * same figure from the published copy, so a client cannot talk it up.
 */
export function dailyCeiling(world: World, now = Date.now()) {
  return Math.round(plotCeiling(cityLevel(world), eraOf(world)) * charterMultiplier(world.charterUntil, now));
}

/**
 * Hand the accrued yield to the caller, once.
 *
 * The world is regenerated from its seed each time the player opens it, so the
 * running total cannot live here — the client drains this into the player's
 * ledger, which is what persists.
 */
export function collectYield(world: World) {
  useWorld(world);
  const amount = Math.round(world.stewardship.pending);
  world.stewardship.pending = 0;
  return amount;
}

/** Put back what the ledger would not take today, so nothing earned is lost. */
export function returnYield(world: World, amount: number) {
  if (!(amount > 0)) return;
  world.stewardship.pending += Math.round(amount);
}

function daily(world: World) {
  rehouse(world);
  world.flowYesterday = world.flow;
  world.flow = { produced: {}, consumed: {} };
  // Yesterday's books close before today's wages are drawn, so the figures the
  // player reads are a whole day rather than a day and a morning.
  world.ledgerYesterday = world.ledger;
  world.ledger = emptyLedger();
  const workers = world.citizens.filter((c) => c.age >= 16);
  const upkeep = world.buildings.filter((b) => b.active).reduce((s, b) => s + upkeepOf(b), 0);

  // Assign jobs first, tracking the running tally so each choice sees the
  // settlement as it is being staffed rather than as it was yesterday.
  const tally: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) {
    if (c.age < 16) { c.job = 'unemployed'; c.wage = 0; continue; }
    // Whether this person wants to try something else.
    //
    // This used to be the lowest of every need they have, warmth and clothing
    // included — so the first cold week of winter had the entire settlement
    // change trade at once, all of them picking whatever scored highest that
    // morning. Being cold is a reason to want a coat and a fire, not a reason
    // to give up farming. Only the two needs that are actually about the work
    // count: whether it feels worth doing, and whether it is feeding them.
    const need = Math.min(c.purpose, c.hunger);
    // Order matters: the capacity check reads the recipe for the citizen's
    // current job, and 'unemployed' has no recipe. Before citizens could be
    // born, everyone over sixteen already had a trade and this never came up;
    // the first child to have a birthday in-world crashed the settlement.
    const current: WorkingJob | null = c.job === 'unemployed' ? null : c.job;
    const overCapacity = current !== null
      && (tally[current] ?? 0) >= Math.max(1, jobCapacity(world, current));
    let jobKey: WorkingJob = current ?? chooseJob(world, tally);
    if (need < 35 || overCapacity) jobKey = chooseJob(world, tally);
    // A trade the owner trained them for holds, while it has somewhere to work.
    const held = c.trained;
    if (held && heldTrade(world, c)) {
      if (jobCapacity(world, held.job) > 0) jobKey = held.job;
      else c.trained = undefined;
    }
    if (c.job === 'unemployed') {
      pushFeed(world, 'work', `${c.name} is old enough to work, and took up ${JOB_LABELS[jobKey].toLowerCase()}.`);
    }
    c.job = jobKey;
    tally[jobKey] = (tally[jobKey] ?? 0) + 1;
  }

  fillEmptyTrades(world, tally);

  // Payroll is paid from the treasury, pro rata when it cannot cover the bill.
  // What the settlement has chosen to pay multiplies every wage in it, so a
  // generous town's bill is a generous town's bill and it has to be met.
  const rate = cleanWageRate(world.wageRate);
  const payroll = workers.reduce((s, c) => s + jobs[c.job as WorkingJob].wage * rate, 0);
  const affordable = Math.max(0, world.treasury - upkeep);
  const ratio = payroll > 0 ? Math.min(1, affordable / payroll) : 1;
  if (ratio < 0.999 && workers.length) {
    pushFeed(world, 'market', ratio <= 0
      ? 'The treasury is empty. Nobody was paid today.'
      : `The treasury could only cover ${Math.round(ratio * 100)}% of wages today.`);
  }
  for (const c of world.citizens) {
    if (c.age < 16) continue;
    c.wage = jobs[c.job as WorkingJob].wage * rate * ratio;
    c.wallet += c.wage;
    // A day at the trade is a day's learning — less of one when the settlement
    // could not pay for it, because half a day spent wondering whether you
    // will be paid is not a day at the bench.
    if (c.job !== 'unemployed') {
      if (!c.skills) c.skills = {};
      const job = c.job as WorkingJob;
      // A school or a library makes the same day teach more.
      const gain = (ratio > 0.5 ? 1 : 0.4) * learningRate(world);
      c.skills[job] = (c.skills[job] ?? 0) + gain;
      const before = skillLevel((c.skills[job] ?? 0) - gain);
      const after = skillLevel(c.skills[job] ?? 0);
      if (after > before && after >= 3) {
        pushFeed(world, 'work', `${c.name} is now a ${SKILL_TITLES[after].toLowerCase()} ${JOB_LABELS[job].toLowerCase()}.`);
      }
    }
    c.hunger = Math.max(0, c.hunger - 7); c.rest = Math.max(0, c.rest - 5);
    c.social = Math.max(0, c.social - 2); c.clothing = Math.max(0, c.clothing - 2.5);
    // What the town's civic buildings put back. Small, daily, and for
    // everybody: a cafe is an evening out, a studio is something to make,
    // a library is somewhere to sit with a thought.
    // Each a quarter stronger per level of the building: see civicStrength.
    if (hasCivic(world, 'Cafe')) c.social = Math.min(100, c.social + CAFE_SOCIAL * civicStrength(world, 'Cafe'));
    if (hasCivic(world, 'Tavern')) c.social = Math.min(100, c.social + TAVERN_SOCIAL * civicStrength(world, 'Tavern'));
    if (hasCivic(world, 'Studio')) c.purpose = Math.min(100, c.purpose + STUDIO_PURPOSE * civicStrength(world, 'Studio'));
    if (hasCivic(world, 'Library')) c.purpose = Math.min(100, c.purpose + LIBRARY_PURPOSE * civicStrength(world, 'Library'));
    // The township's own: a chapel is somewhere to be quiet together, a
    // brewery is an evening with everybody in it, a printer is something
    // to read.
    if (hasCivic(world, 'Chapel')) { c.social = Math.min(100, c.social + CHAPEL_SOCIAL * civicStrength(world, 'Chapel')); c.purpose = Math.min(100, c.purpose + CHAPEL_PURPOSE * civicStrength(world, 'Chapel')); }
    if (hasCivic(world, 'Brewery')) c.social = Math.min(100, c.social + BREWERY_SOCIAL * civicStrength(world, 'Brewery'));
    if (hasCivic(world, 'Printer')) c.purpose = Math.min(100, c.purpose + PRINTER_PURPOSE * civicStrength(world, 'Printer'));
    // The later eras'. A telegraph is news from everywhere; a stadium is a
    // crowd; a supermarket and a vertical farm keep the larder full; an office
    // is work that means something; a drone port brings things to the door.
    if (hasCivic(world, 'Telegraph')) { c.social = Math.min(100, c.social + TELEGRAPH_SOCIAL * civicStrength(world, 'Telegraph')); c.purpose = Math.min(100, c.purpose + TELEGRAPH_PURPOSE * civicStrength(world, 'Telegraph')); }
    if (hasCivic(world, 'Stadium')) c.social = Math.min(100, c.social + STADIUM_SOCIAL * civicStrength(world, 'Stadium'));
    if (hasCivic(world, 'Supermarket')) c.hunger = Math.min(100, c.hunger + SUPERMARKET_HUNGER * civicStrength(world, 'Supermarket'));
    if (hasCivic(world, 'Office')) c.purpose = Math.min(100, c.purpose + OFFICE_PURPOSE * civicStrength(world, 'Office'));
    if (hasCivic(world, 'Vertical Farm')) c.hunger = Math.min(100, c.hunger + VERTICAL_FARM_HUNGER * civicStrength(world, 'Vertical Farm'));
    if (hasCivic(world, 'Drone Port')) { c.social = Math.min(100, c.social + DRONE_PORT_SOCIAL * civicStrength(world, 'Drone Port')); c.purpose = Math.min(100, c.purpose + DRONE_PORT_PURPOSE * civicStrength(world, 'Drone Port')); }
    if (hasCivic(world, 'Monument')) c.happiness = Math.min(100, c.happiness + MONUMENT_PRIDE * civicStrength(world, 'Monument'));
    // Smog, until the town lights its gas.
    if (smogged(world)) c.happiness = Math.max(0, c.happiness - SMOG_HAPPINESS);
    // Unpaid work erodes a sense of purpose; paid work slowly builds it — and
    // what the work is worth is felt on top of whether it was paid at all.
    // This is the half of the wage lever that stewardship is actually scored
    // on: a well-paid settlement is a contented one.
    const paid = ratio > 0.5 ? 0.5 : -1.5;
    c.purpose = edge(c.purpose + paid + (rate - WAGE_STANDARD) * 3, 0, 100);
  }
  spend(world, 'wages', payroll * ratio);
  spend(world, 'upkeep', upkeep * bankRelief(world));
  // Paid in the morning, spent through the day: what people do not need to
  // keep by them goes back into the settlement rather than sitting in a purse.
  householdSpending(world);

  for (const r of Object.keys(marketPrices) as Resource[]) {
    const q = world.market[r];
    q.history.push(Number(q.price.toFixed(3)));
    if (q.history.length > 30) q.history.shift();
  }

  const homeless = world.citizens.filter((c) => c.age >= 16 && !homeOf(world, c));
  if (homeless.length) {
    const shelter = gatheringPlace(world);
    pushFeed(world, 'social', shelter
      ? `${homeless.length} ${homeless.length === 1 ? 'person has' : 'people have'} no home and slept at the ${shelter.type.toLowerCase()}.`
      : `${homeless.length} ${homeless.length === 1 ? 'person' : 'people'} slept outside. The settlement needs houses.`);
  }

  heatTheHomes(world);
  produce(world);
  replenishWildlife(world);
  consume(world);
  lifeAndDeath(world);
  migration(world, mulberry32(world.seed + world.day * 4111));
  hazards(world);
  repairs(world);
  unrest(world);
  discoveries(world);
  projects(world);
  decayBonds(world);
  for (const f of world.families) f.wealth = world.citizens.filter((c) => c.familyId === f.id).reduce((s, c) => s + c.wallet, 0);
  world.population = world.citizens.length;
  checkUnlocks(world);
  scheduleGatherings(world);
  // Once more at the end of the day: a bed freed by a death, a family put
  // out by a ruin, a house the settlement raised for itself — all of it is
  // taken up today, not tomorrow. The first pass at dawn is kept so the
  // helper's figures are right from the morning.
  rehouse(world);
}

/**
 * Advance the world in place by `hours` of game time. Called every animation
 * frame by the client; safe to call with very small deltas.
 */
export function advance(world: World, hours: number, realSeconds?: number): World {
  useWorld(world);
  if (!(hours > 0)) return world;
  // Yield is paid against the wall clock. A caller that does not say how much
  // real time passed is assumed to be running at ordinary speed, which is what
  // the probes do.
  accrueYield(world, realSeconds ?? hours / HOURS_PER_SECOND_BASE);
  world.hour += hours;
  swimmers(world, hours);
  moveCitizens(world, hours);
  moveWildlife(world, hours);
  hazardStep(world, hours);
  unrestStep(world, hours);
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

    c.happiness = edge((c.hunger + c.rest + c.social + c.clothing + c.purpose + c.warmth) / 6, 0, 100);
  }
  return world;
}

/* ------------------------------------------------------------------ *
 * Picking people up
 * ------------------------------------------------------------------ */

/** Lift a citizen out of their day. They stop where they are until set down. */
export function pickUpCitizen(world: World, id: string) {
  useWorld(world);
  const c = world.citizens.find((x) => x.id === id);
  if (!c) return false;
  // The settlement deals with its own rogues: nobody lifts one out of a
  // chase, or carries a pursuer off it, or lets somebody out of the jail.
  if (c.rogue || c.chasing || c.jailed || (c.scuffle && c.scuffle > 0)) return false;
  releaseAmenity(world, c);
  c.carried = true;
  c.swimming = false;
  c.path = [];
  c.detour = undefined;
  c.inside = false;
  c.moving = false;
  c.activity = 'idle';
  return true;
}

/** Move somebody who is being carried. Nothing else about them changes. */
export function carryCitizenTo(world: World, id: string, x: number, y: number) {
  useWorld(world);
  const c = world.citizens.find((x2) => x2.id === id);
  if (!c?.carried) return;
  c.x = edge(x, 2, 98);
  c.y = edge(y, 4, 96);
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
/**
 * Where somebody actually lands when they are let go over a building.
 *
 * Dropping a person onto a roof left them standing inside the walls, which the
 * walking code spends its whole life preventing: they either sat there unable
 * to path anywhere or squeezed out through a wall on the next step. The nearest
 * point outside the footprint is where a person put down on a building would
 * end up anyway, so that is where they go.
 */
function outsideBuildings(world: World, x: number, y: number) {
  let px = x;
  let py = y;
  // A few passes, because stepping clear of one building can put somebody
  // inside its neighbour on a tight terrace.
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const b of world.buildings) {
      const need = footprintRadius(b) + 0.9;
      let dx = px - b.x;
      let dy = py - b.y;
      let d = Math.hypot(dx, dy);
      if (d >= need) continue;
      if (d < 0.0001) { dx = 1; dy = 0; d = 1; }
      px = b.x + (dx / d) * need;
      py = b.y + (dy / d) * need;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: edge(px, 2, 98), y: edge(py, 4, 96) };
}

export function dropCitizen(world: World, id: string, x: number, y: number) {
  useWorld(world);
  const c = world.citizens.find((x2) => x2.id === id);
  if (!c?.carried) return;
  c.carried = false;
  const spot = outsideBuildings(world, edge(x, 2, 98), edge(y, 4, 96));
  c.x = spot.x;
  c.y = spot.y;
  const water = waterOf(world);
  if (water.blocks(c.x, c.y)) {
    c.swimming = true;
    c.happiness = Math.max(0, c.happiness - 8);
    pushFeed(world, 'social', `${c.name} went into the water and is swimming for the bank.`);
  } else {
    c.path = [];
    c.detour = undefined;
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
      c.detour = undefined;
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
    c.x = edge(c.x + dir.x * stepLen, 2, 98);
    c.y = edge(c.y + dir.y * stepLen, 4, 96);
    c.destX = c.x;
    c.destY = c.y;
    c.facing = Math.abs(dir.x) > Math.abs(dir.y) ? (dir.x > 0 ? 'e' : 'w') : (dir.y > 0 ? 's' : 'n');
  }
}

/** Immutable wrapper around `advance`, kept for callers that want snapshots. */
export function tick(world: World, hours = 1): World {
  useWorld(world);
  return advance(structuredClone(world), hours);
}

/** Player-driven construction. Returns the new building, or null if unaffordable. */
/** The gap left between two footprints so that a person can walk between them. */
const WALK_GAP = 1.2;

/**
 * Why a building cannot stand at a spot, or null when it can.
 *
 * Two footprints that touch leave a seam nobody can pass, and until now nothing
 * stopped a player making one: a library dropped against the market pinned
 * half the settlement in the crack between them. The water is refused for the
 * same reason it always was — so the player is told no rather than having the
 * choice quietly moved.
 */
/** The name the outer belt goes by once it is opened. */
export const EXPAND_AREA = 'The Outer Belt';

/**
 * How far out a building may stand.
 *
 * The margin the survey leaves round a plot until its owner expands it, and
 * the near-edge the expansion opens. Read here by everything that places or
 * moves a building, so the two never disagree about where the plot ends.
 */
export function buildBounds(world: World): { x0: number; x1: number; y0: number; y1: number } {
  useWorld(world);
  return inset(extentOf(world), 6, 8);
}

/* ------------------------------------------------------------------ *
 * Eras
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * City levels
 *
 * What a plot has become, one to ten. Size earns a level and Gold buys it:
 * the level is the smaller of the works paid for and one past what the
 * town's people and buildings have earned. The reward ceiling runs on it,
 * so the Gold a city makes goes back into the city and comes out as
 * $EMERGE. This is where the "too much Gold" and the "rewards fall as the
 * city grows" complaints were both answered.
 * ------------------------------------------------------------------ */

/** The size that counts toward a level: people, and buildings that stand. */
function citySize(world: World) {
  return { people: world.citizens.length, buildings: world.buildings.filter((b) => !b.ruined).length };
}

/**
 * Bring an old save up to the levels: a city that was already the size of a
 * level four town is a level four town, with nothing to pay. Called before
 * anything reads the level.
 */
export function ensureWorks(world: World) {
  if (world.works) return world.works;
  const { people, buildings } = citySize(world);
  world.works = { level: levelForSize(people, buildings) };
  return world.works;
}

/** The plot's city level, one to ten. */
export function cityLevel(world: World): number {
  const works = ensureWorks(world);
  const { people, buildings } = citySize(world);
  return Math.max(1, Math.min(MAX_CITY_LEVEL, works.level, levelForSize(people, buildings) + 1));
}

export interface CityGate {
  level: number;
  /** The next level, or null at the top. */
  next: number | null;
  /** What the next level asks, and what the town has. */
  people: { have: number; need: number };
  buildings: { have: number; need: number };
  /** Gold the public works cost. */
  cost: number;
  /** The town is big enough; the town can pay; both. */
  grown: boolean;
  affordable: boolean;
  ready: boolean;
}

/** What stands between this settlement and its next level. */
export function cityGate(world: World): CityGate {
  useWorld(world);
  const level = cityLevel(world);
  const { people, buildings } = citySize(world);
  if (level >= MAX_CITY_LEVEL) {
    return { level, next: null, people: { have: people, need: 0 }, buildings: { have: buildings, need: 0 }, cost: 0, grown: true, affordable: true, ready: false };
  }
  const spec = cityLevelSpec(level + 1);
  const grown = people >= spec.people && buildings >= spec.buildings;
  const affordable = world.treasury >= spec.works;
  return {
    level, next: level + 1,
    people: { have: people, need: spec.people },
    buildings: { have: buildings, need: spec.buildings },
    cost: spec.works, grown, affordable, ready: grown && affordable,
  };
}

/** Pay for the public works and raise the city a level. */
export function raiseCity(world: World): { ok: boolean; message: string } {
  useWorld(world);
  const gate = cityGate(world);
  const works = ensureWorks(world);
  if (!gate.next) return { ok: false, message: 'The city is at the top level.' };
  if (!gate.grown) return { ok: false, message: `Level ${gate.next} needs ${gate.people.need} people and ${gate.buildings.need} buildings standing.` };
  if (!gate.affordable) return { ok: false, message: `The public works cost ${gate.cost.toLocaleString()} Gold.` };
  spend(world, 'works', gate.cost);
  works.level = gate.next;
  noteAttention(world);
  pushFeed(world, 'build', `The public works are done. ${world.name} is a level ${gate.next} city, and earns like one.`);
  return { ok: true, message: `${world.name} is now level ${gate.next}.` };
}

/** Whether insurance bought for this plot still runs. */
export const insured = (world: World, now = Date.now()) => !!world.insuredUntil && world.insuredUntil > now;
/** Whether master builders are on the plot. */
export const buildersHere = (world: World, now = Date.now()) => !!world.buildersUntil && world.buildersUntil > now;
/** What building and improving cost, as a multiple, with builders on the plot. */
export const buildDiscount = (world: World) => (buildersHere(world) ? 1 - BUILDERS_DISCOUNT : 1);

export type CoverKind = 'charter' | 'insurance' | 'builders';

/** Record a charter, insurance or builders the registry has accepted for this plot. */
export function setCover(world: World, kind: CoverKind, until: number) {
  useWorld(world);
  if (kind === 'charter') world.charterUntil = Math.max(world.charterUntil ?? 0, until);
  else if (kind === 'insurance') world.insuredUntil = Math.max(world.insuredUntil ?? 0, until);
  else world.buildersUntil = Math.max(world.buildersUntil ?? 0, until);
  noteAttention(world);
  pushFeed(world, 'build', kind === 'charter'
    ? 'A charter has been granted. The plot earns a fifth more while it runs.'
    : kind === 'insurance'
      ? 'The plot is insured. Whatever comes, half the damage is made good.'
      : 'Master builders have set up in the square. Building and improving cost a quarter less while they stay.');
}

/* ------------------------------------------------------------------ *
 * Unique buildings
 *
 * A town hall, a jail, a tavern: buildings whose whole effect is that one
 * stands. A second did nothing, cost upkeep, and confused everybody who
 * built it — so the plot refuses it, and the panel says so. Houses, stores
 * and every workplace with posts in it are the ones worth more of.
 * ------------------------------------------------------------------ */
const WORKPLACES = new Set(Object.values(JOBS).map((j) => j.building));
export const isUnique = (type: string) => type !== 'House' && type !== 'Storage' && !WORKPLACES.has(type);
export const UNIQUE_BUILDINGS = Object.keys(BUILD_COSTS).filter(isUnique);
/** The one of a unique type this plot has, standing or in ruins. */
export const uniqueStanding = (world: World, type: string, ignoreId?: string) =>
  isUnique(type) ? world.buildings.find((b) => b.type === type && b.id !== ignoreId) : undefined;

/**
 * A festival: Gold spent on the whole town's spirits, once a day at most.
 *
 * Costs by the head, so a big city pays a big city's price, and lifts
 * everyone's happiness and the bonds between them. A Gold sink that is
 * worth using, which is what the treasury was missing.
 */
export const FESTIVAL_GOLD_PER_HEAD = 25;
export const FESTIVAL_MIN_GOLD = 400;
export const festivalCost = (world: World) => Math.max(FESTIVAL_MIN_GOLD, FESTIVAL_GOLD_PER_HEAD * world.citizens.length);
export function holdFestival(world: World): { ok: boolean; message: string } {
  useWorld(world);
  if (world.festivalDay === world.day) return { ok: false, message: 'There has already been a festival today.' };
  const cost = festivalCost(world);
  if (world.treasury < cost) return { ok: false, message: `A festival for ${world.citizens.length} people costs ${cost.toLocaleString()} Gold.` };
  spend(world, 'festival', cost);
  world.festivalDay = world.day;
  for (const c of world.citizens) {
    if (c.jailed || c.rogue) continue;
    c.happiness = Math.min(100, c.happiness + 18);
    c.social = Math.min(100, (c.social ?? 50) + 25);
    c.purpose = Math.min(100, c.purpose + 6);
  }
  noteAttention(world);
  pushFeed(world, 'social', `${world.name} held a festival in the square. Everyone went.`);
  return { ok: true, message: 'The festival is on.' };
}

/* ------------------------------------------------------------------ *
 * Boons: paid for in $EMERGE, delivered at once
 * ------------------------------------------------------------------ */

export type BoonKind = 'settlers' | 'shipment' | 'restore' | 'monument' | 'banner';
export const BOON_SETTLERS = 5;
export const BOON_SHIPMENT: Partial<Record<Resource, number>> = { wood: 400, stone: 300, bread: 120, vegetables: 120 };

/** Whether a boon would do anything here, said before anybody pays for it. */
export function boonCheck(world: World, kind: BoonKind): { ok: boolean; message: string } {
  useWorld(world);
  if (kind === 'settlers') {
    const room = Math.floor(housingRoom(world) - world.citizens.length);
    if (room < BOON_SETTLERS) return { ok: false, message: `There is room for ${Math.max(0, room)} more. Build houses for ${BOON_SETTLERS} before sending for settlers.` };
    return { ok: true, message: '' };
  }
  if (kind === 'restore') {
    const ruins = world.buildings.filter((b) => b.ruined).length;
    if (!ruins && !world.bridgeWorks) return { ok: false, message: 'Nothing here needs restoring: no ruins, and no bridge under way.' };
    return { ok: true, message: '' };
  }
  if (kind === 'monument') {
    if (uniqueStanding(world, 'Monument')) return { ok: false, message: 'A monument already stands in the square.' };
    if (!freeSite(world, false)) return { ok: false, message: 'There is no open ground near the square for a monument.' };
    return { ok: true, message: '' };
  }
  return { ok: true, message: '' };
}

/** Fly a banner: prestige, recorded on the claim row by the registry. */
export function setBanner(world: World, emblem: string) {
  useWorld(world);
  world.banner = emblem;
  noteAttention(world);
  pushFeed(world, 'build', 'A banner was raised over the square. Every map now shows it.');
}

/** Deliver a boon. The caller has checked it and paid for it. */
export function applyBoon(world: World, kind: BoonKind, emblem?: string): { ok: boolean; message: string } {
  const check = boonCheck(world, kind);
  if (!check.ok) return check;
  if (kind === 'banner') {
    if (!emblem) return { ok: false, message: 'Choose an emblem.' };
    setBanner(world, emblem);
    return { ok: true, message: 'The banner flies.' };
  }
  if (kind === 'monument') {
    const site = freeSite(world, false);
    if (!site) return { ok: false, message: 'There is no open ground near the square for a monument.' };
    const gold = world.treasury;
    const raised = constructBuilding(world, 'Monument', 0, site[0], site[1]);
    world.treasury = gold;
    if (!raised) return { ok: false, message: 'The monument could not be raised there.' };
    pushFeed(world, 'build', `A monument was raised in ${world.name}. People will be proud of this place for as long as it stands.`);
    return { ok: true, message: 'The monument stands.' };
  }
  if (kind === 'settlers') {
    const names: string[] = [];
    for (let i = 0; i < BOON_SETTLERS; i++) names.push(addSettler(world).name);
    rehouse(world);
    world.population = world.citizens.length;
    noteAttention(world);
    pushFeed(world, 'social', `A party of ${BOON_SETTLERS} settlers arrived together: ${names.slice(0, 3).join(', ')} and the others. They have taken houses.`);
    return { ok: true, message: `${BOON_SETTLERS} settlers have arrived.` };
  }
  if (kind === 'shipment') {
    for (const [key, amount] of Object.entries(BOON_SHIPMENT) as [Resource, number][]) grantResource(world, key, amount);
    noteAttention(world);
    pushFeed(world, 'market', 'A shipment came in: timber, stone and food, straight into the yard and the larder.');
    return { ok: true, message: 'The shipment is in the yard.' };
  }
  let rebuilt = 0;
  for (const b of world.buildings) {
    if (!b.ruined) continue;
    b.ruined = false; b.active = true; b.damage = 0;
    rebuilt++;
  }
  let bridged = false;
  if (world.bridgeWorks) {
    completeBridge(world, world.bridgeWorks);
    bridged = true;
  }
  if (rebuilt) rehouse(world);
  noteAttention(world);
  pushFeed(world, 'build', `The restoration crews were through in a day: ${rebuilt} ${rebuilt === 1 ? 'ruin' : 'ruins'} rebuilt${bridged ? ' and the bridge finished' : ''}.`);
  return { ok: true, message: `${rebuilt} rebuilt${bridged ? ', the bridge finished' : ''}.` };
}

export interface EraCheck { label: string; done: boolean }
export interface EraGate {
  /** The era the plot is in. */
  era: EraSpec;
  /** The one it could advance to, or null at the end of what is built. */
  next: EraSpec | null;
  /** Whether the next era exists in the game yet. */
  open: boolean;
  /** Days lived in the current era, against what the step needs. */
  days: { have: number; need: number };
  checks: EraCheck[];
  /** Every check met and the days served. */
  ready: boolean;
}

/**
 * What stands between this settlement and the next era.
 *
 * Two gates, both required: days lived in the era, and a checklist drawn
 * from things the simulation already measures. The list is shown to the
 * player exactly as it is judged here, so there is never a "why not?".
 */
export function eraGate(world: World): EraGate {
  const era = eraSpec(eraOf(world));
  const next = nextEra(era.id);
  const have = Math.max(0, world.day - (world.eraSince ?? 1));
  if (!next) return { era, next: null, open: false, days: { have, need: 0 }, checks: [], ready: false };
  const open = next.id <= OPEN_ERA;
  const has = (type: string) => world.buildings.some((b) => b.type === type && !b.ruined);
  const count = world.buildings.filter((b) => !b.ruined).length;
  const ruins = world.buildings.filter((b) => b.ruined).length;
  let checks: EraCheck[];
  if (next.id === 2) {
    checks = [
      { label: `${world.population} of 40 people`, done: world.population >= 40 },
      { label: `${count} of 30 buildings standing`, done: count >= 30 },
      { label: 'A Town Hall, a Bank, a School and a Jail', done: has('Town Hall') && has('Bank') && has('School') && has('Jail') },
      { label: `${Math.floor(world.treasury).toLocaleString()} of 20,000 Gold in the treasury`, done: world.treasury >= 20_000 },
      { label: ruins ? `${ruins} ruin${ruins === 1 ? '' : 's'} still standing` : 'No ruins standing', done: ruins === 0 },
    ];
  } else if (next.id === 3) {
    checks = [
      { label: `${world.population} of 70 people`, done: world.population >= 70 },
      { label: `${count} of 50 buildings standing`, done: count >= 50 },
      { label: 'A Lab and a Library', done: has('Lab') && has('Library') },
      { label: `${Math.floor(world.resources.ironOre ?? 0)} of 300 iron ore in the store`, done: (world.resources.ironOre ?? 0) >= 300 },
      { label: 'The plot expanded', done: !!world.expanded },
    ];
  } else if (next.id === 4) {
    checks = [
      { label: `${world.population} of 110 people`, done: world.population >= 110 },
      { label: `${count} of 75 buildings standing`, done: count >= 75 },
      { label: 'A Hospital and a Stadium', done: has('Hospital') && has('Stadium') },
      { label: 'The plot expanded', done: !!world.expanded },
    ];
  } else {
    checks = [
      { label: `${world.population} of 160 people`, done: world.population >= 160 },
      { label: `${count} of 100 buildings standing`, done: count >= 100 },
      { label: 'A Research Campus and a Power Plant', done: has('Research Campus') && has('Power Plant') },
      { label: 'The plot expanded', done: !!world.expanded },
      { label: 'Stewardship above 0.7', done: world.stewardship.score >= 0.7 },
    ];
  }
  const needLevel = ERA_CITY_LEVEL[next.id] ?? 1;
  const level = cityLevel(world);
  checks.push({ label: `City level ${level} of ${needLevel}`, done: level >= needLevel });
  const daysDone = have >= next.days;
  const ready = open && daysDone && checks.every((c) => c.done);
  return { era, next, open, days: { have, need: next.days }, checks, ready };
}

/**
 * Advance the plot one era. Only when the gate says so; the charge is the
 * caller's business, and the registry checks the gate again on its own copy.
 */
export function advanceEra(world: World): boolean {
  const gate = eraGate(world);
  if (!gate.ready || !gate.next) return false;
  setEra(world, gate.next.id);
  return true;
}

/**
 * Put the plot in an era without asking. For a device catching up with the
 * registry's row, which already paid and passed the gate elsewhere.
 */
export function setEra(world: World, era: number): boolean {
  const target = Math.max(1, Math.min(ERAS.length, Math.round(era)));
  if (target <= eraOf(world)) return false;
  world.era = target;
  world.eraSince = world.day;
  noteAttention(world);
  const spec = eraSpec(target);
  if (!world.unlockedAreas.includes(spec.name)) world.unlockedAreas.push(spec.name);
  pushFeed(world, 'build', `The settlement has entered the ${spec.name.toLowerCase()} era. ${spec.arrives}`);
  return true;
}

/**
 * Open the outer belt. Once per plot; the charge is the caller's business.
 *
 * Returns false when it was already open, so a second device that learns of
 * the expansion from the registry can apply it without a second feed line.
 */
export function expandPlot(world: World): boolean {
  useWorld(world);
  if (world.expanded) return false;
  world.expanded = true;
  if (!world.unlockedAreas.includes(EXPAND_AREA)) world.unlockedAreas.push(EXPAND_AREA);
  noteAttention(world);
  pushFeed(world, 'build', `The plot was expanded: ${EXPAND_AREA.toLowerCase()} is open for building.`);
  return true;
}

/**
 * The earliest era each building may be raised in. Anything not listed is
 * there from the start.
 */
export const BUILDING_ERA: Record<string, number> = {
  Chapel: 2, Guildhall: 2, Brewery: 2, Printer: 2, Stables: 2, Harbour: 2,
  Factory: 3, Foundry: 3, 'Railway Station': 3, Telegraph: 3, Gasworks: 3,
  Hospital: 4, Stadium: 4, Supermarket: 4, Office: 4, 'Bus Depot': 4, 'Power Plant': 4,
  'Data Centre': 5, 'Research Campus': 5, 'Vertical Farm': 5, 'Pod Hub': 5, 'Drone Port': 5,
};

/** Which shelf of the Build panel a building sits on. */
export type BuildingCategory = 'Homes' | 'Food' | 'Materials' | 'Civic' | 'Care & learning' | 'Leisure' | 'Transport' | 'Utilities';
export const BUILDING_CATEGORY: Record<string, BuildingCategory> = {
  House: 'Homes',
  Farm: 'Food', Fishery: 'Food', Lodge: 'Food', Forager: 'Food', Mill: 'Food', Bakery: 'Food', Brewery: 'Food',
  Woodcutter: 'Materials', Quarry: 'Materials', Mine: 'Materials', Carpenter: 'Materials', Blacksmith: 'Materials', Tailor: 'Materials',
  'Town Hall': 'Civic', Jail: 'Civic', Storage: 'Civic', Market: 'Civic', Bank: 'Civic', Guildhall: 'Civic', Chapel: 'Civic', Monument: 'Civic',
  School: 'Care & learning', Clinic: 'Care & learning', Library: 'Care & learning', Lab: 'Care & learning', Printer: 'Care & learning',
  Tavern: 'Leisure', Cafe: 'Leisure', Studio: 'Leisure', Stadium: 'Leisure',
  Stables: 'Transport', Harbour: 'Transport', 'Railway Station': 'Transport', 'Bus Depot': 'Transport', 'Pod Hub': 'Transport', 'Drone Port': 'Transport',
  Factory: 'Materials', Foundry: 'Materials',
  Telegraph: 'Civic', Office: 'Civic',
  Hospital: 'Care & learning', 'Research Campus': 'Care & learning', 'Data Centre': 'Care & learning',
  Supermarket: 'Food', 'Vertical Farm': 'Food',
  Gasworks: 'Utilities', 'Power Plant': 'Utilities',
};
export const BUILDING_CATEGORIES: BuildingCategory[] = ['Homes', 'Food', 'Materials', 'Civic', 'Care & learning', 'Leisure', 'Transport', 'Utilities'];

/** The era a plot is in. Saves from before eras read as the first. */
export const eraOf = (world: { era?: number }) => Math.max(1, Math.min(ERAS.length, world.era ?? 1));

/** Whether a building type may be raised in this plot's era. */
export const allowedInEra = (world: { era?: number }, type: string) => (BUILDING_ERA[type] ?? 1) <= eraOf(world);

/** Whether a building of this type stands and is not a ruin. */
export const hasWorking = (world: { buildings: Building[] }, type: string) =>
  world.buildings.some((b) => b.type === type && !b.ruined);

/**
 * The ferry. A Harbour puts a boat on every channel: people cross open water
 * where there is no bridge, and an islet with no bridge counts as connected.
 * Bridges stay, and are still where the roads go.
 */
export const hasFerry = (world: { buildings: Building[] }) => hasWorking(world, 'Harbour');

/** Carts. A Stables puts every working adult on wheels while they are on the move. */
export const hasStables = (world: { buildings: Building[] }) => hasWorking(world, 'Stables');
/** How much faster a cart is than walking. */
export const CART_PACE = 1.4;

/**
 * What the town rides, by era. Every ride is the same mechanic as the cart:
 * a working adult on the move goes faster and is drawn on the vehicle. The
 * building that provides it has to stand, and the era has to allow it; a
 * later era keeps the earlier rides as fallbacks, so a modern town whose
 * Bus Depot burns down is back on the rails, and then the carts.
 */
export type Ride = 'cart' | 'rail' | 'bike' | 'car' | 'pod';
export const RIDE_PACE: Record<Ride, number> = { cart: CART_PACE, rail: 2.2, bike: 2.0, car: 3.0, pod: 3.4 };
export const RIDE_BUILDING: Record<Ride, string> = { cart: 'Stables', rail: 'Railway Station', bike: 'Bus Depot', car: 'Bus Depot', pod: 'Pod Hub' };
/** The best ride the town offers right now, or null when everybody walks. */
export function rideOf(world: { buildings: Building[]; era?: number }): Ride | null {
  const era = eraOf(world);
  if (era >= 5 && hasWorking(world, 'Pod Hub')) return 'pod';
  if (era >= 4 && hasWorking(world, 'Bus Depot')) return 'car';
  if (era >= 3 && hasWorking(world, 'Railway Station')) return 'rail';
  if (hasStables(world)) return 'cart';
  return null;
}
/** A person's own ride from the town's: a third of a modern town cycles. */
export const rideFor = (ride: Ride | null, c: { hash: number }): Ride | null => (ride === 'car' && c.hash % 3 === 0 ? 'bike' : ride);

/** Whether people may stand on this landmass without a bridge to it. */
function reachable(world: { buildings: Building[]; connectedIslands: number[] }, water: WaterField, land: number) {
  return land === water.mainland || world.connectedIslands.includes(land) || hasFerry(world);
}

/**
 * The water as the ferry sees it: the same field, but nothing blocks. Every
 * movement rule reads `blocks`, so a plot with a Harbour hands this view to
 * them and leaves the real one to placement, spawning and the renderer.
 */
const ferryViews = new WeakMap<WaterField, WaterField>();
function ferried(water: WaterField): WaterField {
  let view = ferryViews.get(water);
  if (!view) {
    view = { ...water, blocks: () => false, toClear: () => ({ x: 0, y: 0, d: 0 }), toLand: () => ({ x: 0, y: 0, d: 0 }) };
    ferryViews.set(water, view);
  }
  return view;
}
/** The field people walk on: the real one, or the ferry's view of it. */
function walkWater(world: World): WaterField {
  const water = waterOf(world);
  return hasFerry(world) ? ferried(water) : water;
}

export function placementProblem(world: World, type: string, x: number, y: number, ignoreId?: string): string | null {
  useWorld(world);
  if (!allowedInEra(world, type)) return `A ${type.toLowerCase()} belongs to the ${eraSpec(BUILDING_ERA[type] ?? 1).name.toLowerCase()} era. Advance the plot first.`;
  const one = uniqueStanding(world, type, ignoreId);
  if (one) return one.ruined ? `The ${type.toLowerCase()} lies in ruins. Rebuild it rather than raising another.` : `A ${type.toLowerCase()} already stands here. A settlement keeps one; improve it instead.`;
  const bb = buildBounds(world);
  const px = clamp(x, bb.x0, bb.x1), py = clamp(y, bb.y0, bb.y1);
  if (waterOf(world).blocks(px, py)) return 'Nothing can stand on the water.';
  const r = FOOTPRINTS[type] ?? 3.2;
  for (const b of world.buildings) {
    if (b.id === ignoreId) continue;
    const gap = Math.hypot(b.x - px, b.y - py) - r - footprintRadius(b);
    if (gap < WALK_GAP) return `Too close to the ${b.type.toLowerCase()}. Leave room to walk between.`;
  }
  return null;
}

export function constructBuilding(world: World, type: string, cost: number, x: number, y: number): Building | null {
  useWorld(world);
  cost = Math.round(cost * buildDiscount(world));
  if (world.treasury < cost) return null;
  const problem = placementProblem(world, type, x, y);
  if (problem) {
    pushFeed(world, 'build', `The ${type.toLowerCase()} was not built: ${problem.toLowerCase()}`);
    return null;
  }
  // A building is Gold and materials both. The panel already greys out what the
  // yard cannot cover, so reaching here without them means the stores moved
  // between the click and the placement.
  if (!materialsInStore(world, type)) return null;
  // Refuse the river rather than quietly moving the building somewhere else:
  // a player who clicked on water should be told no, not have their choice
  // silently overridden.
  if (waterOf(world).blocks(x, y)) return null;
  const need = buildMaterials(type);
  const bb = buildBounds(world);
  const building: Building = { id: `b${world.counter++}`, type, x: clamp(x, bb.x0, bb.x1), y: clamp(y, bb.y0, bb.y1), workers: [], active: true, era: eraOf(world) };
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
  if (type === 'House') rehouse(world);
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
  let nx = edge(building.x + Math.cos(away) * gap, 3, 97);
  let ny = edge(building.y + Math.sin(away) * gap, 4, 96);
  if (water.blocks(nx, ny)) {
    const clear = water.toClear(nx, ny);
    if (!(clear.d > 0)) return false;
    nx = edge(nx + clear.x * (clear.d + 0.6), 3, 97);
    ny = edge(ny + clear.y * (clear.d + 0.6), 4, 96);
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
  useWorld(world);
  const building = world.buildings.find((b) => b.id === id);
  if (!building) return { ok: false, message: 'That building is not there.' };
  // The market is where the settlement eats and trades and the bank is where its
  // Gold lives; pulling either down strands everybody at once, and no amount of
  // salvage is worth that.
  if (UNDEMOLISHABLE.includes(building.type)) {
    return { ok: false, message: `The ${building.type.toLowerCase()} holds the settlement together. It cannot be pulled down.` };
  }
  // A lived-in house comes down with its family moved out first: into
  // another house with room if there is one, and onto the tavern benches
  // until one is raised if there is not. "Rehouse them first" was a wall,
  // because nothing in the game let the player do that.
  const home = world.families.find((f) => f.homeId === building.id && f.members.length > 0);

  const need = buildMaterials(building.type);
  const wood = Math.floor(need.wood / 2);
  const stone = Math.floor(need.stone / 2);
  world.resources.wood += wood;
  world.resources.stone += stone;
  note(world, 'produced', 'wood', wood);
  note(world, 'produced', 'stone', stone);

  world.buildings = world.buildings.filter((b) => b.id !== id);
  if (home) {
    home.homeId = '';
    const moved = rehouse(world);
    if (!moved) pushFeed(world, 'social', `The ${home.name} family is without a roof. They will take the next house raised.`);
  }
  // Anyone who was heading there needs somewhere else to be, now.
  for (const c of world.citizens) {
    if (c.destId === id) { c.destId = undefined; c.path = []; c.detour = undefined; c.dwell = 0; }
    if (c.targetBuildingId === id) c.targetBuildingId = undefined;
  }
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  staffNow(world);
  noteAttention(world);
  pushFeed(world, 'build', `The ${building.type.toLowerCase()} was pulled down. ${wood} timber and ${stone} stone were salvaged.`);
  return { ok: true, message: `Salvaged ${wood} timber and ${stone} stone. The Gold is gone.` };
}

/* ------------------------------------------------------------------ *
 * Moving and improving
 * ------------------------------------------------------------------ */

/** The most a building can be improved. */
export const MAX_BUILDING_LEVEL = 3;

/** What level a building is, whatever version of the game raised it. */
export const levelOf = (b: Building) => Math.max(1, Math.min(MAX_BUILDING_LEVEL, Math.round(b.level ?? 1)));

/**
 * What an improved building is worth, as a multiple.
 *
 * Deliberately modest per level and paid for twice — once in Gold and timber to
 * raise, and again in upkeep every day after. A settlement that improves
 * everything it owns and cannot feed the bill will find out.
 */
/** What one level of improvement adds to a building's output, and to its bill. */
export const OUTPUT_PER_LEVEL = 0.22;
export const UPKEEP_PER_LEVEL = 0.5;

export const buildingOutput = (b: Building) => 1 + (levelOf(b) - 1) * OUTPUT_PER_LEVEL;

/**
 * How many people an improved building can hold.
 *
 * It does not hold more, and that is the result of measuring rather than a
 * decision made up front. An extra worker per level doubled what a trade could
 * absorb by level three, so a settlement that improved everything ended two
 * hundred days with 30,694 Gold against 2,962 for one that improved nothing —
 * ten times richer, for a cost it earned back many times over. Improvement is
 * meant to be worth doing, not the only thing worth doing.
 *
 * Room for more hands comes from raising another building, which costs
 * materials and carries its own upkeep for ever. What Gold buys here is a
 * better place to work, not a bigger one.
 */
export const buildingCapacity = (b: Building, base: number) => { void b; return base; };

/** What it costs to move a building: a share of raising it, and no materials. */
/** Moving a building costs this share of what it cost to raise. */
export const MOVE_SHARE = 0.35;

export function moveCost(type: string): number {
  return Math.round((SELF_BUILD_COST[type] ?? TRADE_BUILD_COST[type] ?? 250) * MOVE_SHARE);
}

/**
 * What each improvement costs, as a share of the original price — in Gold and
 * in materials alike. The second step is nearly twice the first, so the top
 * level is something a settlement grows into rather than buys on day one.
 */
export const UPGRADE_STEPS = [0.8, 1.4];

/** What the next improvement costs, in Gold and in the yard. */
export function upgradeCost(b: Building): { gold: number; wood: number; stone: number } | null {
  const level = levelOf(b);
  if (level >= MAX_BUILDING_LEVEL) return null;
  const base = SELF_BUILD_COST[b.type] ?? TRADE_BUILD_COST[b.type] ?? 250;
  const need = buildMaterials(b.type);
  // Each step costs more than the last, so the third level is a decision.
  const step = UPGRADE_STEPS[level - 1];
  return {
    gold: Math.round(base * step),
    wood: Math.round(need.wood * step),
    stone: Math.round(need.stone * step),
  };
}

/**
 * Pick a building up and put it down somewhere else.
 *
 * The same placement rules as raising one — not on water, inside the map — and
 * the same consequences: roads are cut to it, the amenities around it are
 * rebuilt, and anybody who was walking to it is given somewhere else to be
 * rather than continuing toward a patch of ground where it used to stand.
 */
export function moveBuilding(world: World, id: string, x: number, y: number): { ok: boolean; message: string } {
  useWorld(world);
  const building = world.buildings.find((b) => b.id === id);
  if (!building) return { ok: false, message: 'That building is not there.' };
  const cost = moveCost(building.type);
  if (world.treasury < cost) {
    return { ok: false, message: `Moving the ${building.type.toLowerCase()} costs ${cost} Gold.` };
  }
  const problem = placementProblem(world, building.type, x, y, id);
  if (problem) return { ok: false, message: problem };
  const bb = buildBounds(world);
  const to = { x: clamp(x, bb.x0, bb.x1), y: clamp(y, bb.y0, bb.y1) };
  if (Math.hypot(to.x - building.x, to.y - building.y) < 2) {
    return { ok: false, message: 'That is where it already is.' };
  }

  spend(world, 'building', cost);
  building.x = to.x;
  building.y = to.y;
  linkToRoads(world, building);
  world.amenities = buildAmenities(world.buildings, world.layout, waterOf(world));
  // Everybody heading for the old spot re-picks, or they walk to bare ground.
  for (const c of world.citizens) {
    if (c.destId === id || c.targetBuildingId === id) {
      c.destId = undefined;
      c.targetBuildingId = undefined;
      c.path = [];
      c.detour = undefined;
      c.dwell = 0;
    }
  }
  noteAttention(world);
  pushFeed(world, 'build', `The ${building.type.toLowerCase()} was moved, at a cost of ${cost} Gold.`);
  return { ok: true, message: `Moved for ${cost} Gold.` };
}

/**
 * Improve a building.
 *
 * More room and more output, paid for in Gold, in timber and stone out of the
 * yard, and in upkeep for as long as it stands. The upkeep is the part that
 * makes this a decision: a settlement that improves everything is a settlement
 * with a daily bill it may not be able to meet.
 */
export function upgradeBuilding(world: World, id: string): { ok: boolean; message: string } {
  useWorld(world);
  const building = world.buildings.find((b) => b.id === id);
  if (!building) return { ok: false, message: 'That building is not there.' };
  const cost = upgradeCost(building);
  if (!cost) return { ok: false, message: 'That is as good as it gets.' };
  cost.gold = Math.round(cost.gold * buildDiscount(world));
  if (world.treasury < cost.gold) {
    return { ok: false, message: `That costs ${cost.gold} Gold and the treasury cannot cover it.` };
  }
  if (world.resources.wood < cost.wood || world.resources.stone < cost.stone) {
    return { ok: false, message: `The yard is short: ${cost.wood} timber and ${cost.stone} stone are needed.` };
  }

  spend(world, 'building', cost.gold);
  world.resources.wood -= cost.wood;
  world.resources.stone -= cost.stone;
  note(world, 'consumed', 'wood', cost.wood);
  note(world, 'consumed', 'stone', cost.stone);
  building.level = levelOf(building) + 1;
  staffNow(world);
  noteAttention(world);
  pushFeed(world, 'build', `The ${building.type.toLowerCase()} was improved to level ${building.level}.`);
  return { ok: true, message: `Improved to level ${building.level}.` };
}

/** Add Gold to the treasury from outside the settlement's own economy. */
export function fundTreasury(world: World, gold: number, note: string) {
  useWorld(world);
  if (!(gold > 0)) return;
  noteAttention(world);
  earn(world, 'vault', gold);
  pushFeed(world, 'market', note);
}

/** Take Gold out of the treasury. Returns false when it cannot cover the draw. */
export function drawFromTreasury(world: World, gold: number, note: string) {
  useWorld(world);
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
  useWorld(world);
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

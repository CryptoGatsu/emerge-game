/**
 * Saving a settlement.
 *
 * Until this existed, a world was rebuilt from its seed every time the page
 * loaded. The claim persisted — seed, name, price, owner — and nothing else
 * did, so every building raised, every person born, every friendship and
 * grudge, the treasury and the calendar were all regenerated from scratch. A
 * player who spent an evening building a town came back to the opening camp.
 *
 * What is stored is everything the simulation mutates. That includes the road
 * plan, which is nominally derived from the seed but grows at runtime: lanes
 * are cut through to new buildings and decks are laid across water. The
 * terrain, the water mask and the biome are *not* stored — those are pure
 * functions of the seed and regenerating them is both cheaper than reading
 * them back and impossible to get out of step.
 *
 * A save that cannot be read is not an error worth showing anybody: the world
 * is regenerated and play continues. That is the same trade the rest of this
 * module's storage makes, and it is the right one — a corrupt entry should
 * cost a player their progress, never their ability to open the game.
 */

import { createWorld, type World } from '../simulation';
import { RESOURCES } from './goods';
import { clientKey } from '../limits';

/**
 * Bump when the shape of a saved world changes incompatibly. An older save is
 * then ignored rather than revived into a shape the simulation cannot run.
 */
const SAVE_VERSION = 1;

const keyFor = (seed: number) => clientKey(`save.${seed}.v${SAVE_VERSION}`);
/** Where the save stands, kept beside it so a write can be checked without reading 50KB. */
const markFor = (seed: number) => clientKey(`save.${seed}.v${SAVE_VERSION}.mark`);

export interface SavedWorld {
  version: number;
  /** Which world this is, checked against the seed being opened. */
  seed: number;
  /** Wall-clock time of the save, for the "while you were away" line. */
  at: number;
  world: unknown;
}

/**
 * Fields worth keeping. Everything the simulation writes to, and nothing it
 * derives — listing them explicitly means a new field is a deliberate decision
 * about whether it should survive a reload rather than an accident either way.
 */
const KEEP = [
  'id', 'name', 'seed', 'biome', 'day', 'hour', 'terrain', 'layout',
  'season', 'weather', 'weatherSeed', 'treasury', 'population', 'temperature',
  'deaths', 'births', 'amenities', 'bridgeWorks', 'connectedIslands',
  'families', 'citizens', 'buildings', 'resources', 'market',
  'feed', 'gatherings', 'bonds', 'projects', 'hazards', 'resolution',
  'artworks', 'unlockedAreas', 'wageRate', 'marketClock', 'flow', 'flowYesterday', 'ledger',
  'ledgerYesterday', 'stewardship', 'grants', 'clearings', 'wildlife', 'hunt', 'counter', 'expanded', 'era', 'eraSince', 'works', 'charterUntil', 'insuredUntil', 'buildersUntil', 'festivalDay',
] as const;

/**
 * Conversations are deliberately not saved: an exchange resumed three days
 * later, mid-sentence, between two people who have since walked to opposite
 * ends of the settlement, is worse than no exchange at all. They start again.
 */

/**
 * Where the copy in storage stands, or null when there is none.
 *
 * Read from the mark written beside the save rather than from the save
 * itself, which is tens of kilobytes and is written every fifteen seconds.
 */
function markOf(seed: number): { day: number; hour: number } | null {
  try {
    const raw = window.localStorage.getItem(markFor(seed));
    if (!raw) return null;
    const [day, hour] = raw.split(':').map(Number);
    return Number.isFinite(day) && Number.isFinite(hour) ? { day, hour } : null;
  } catch {
    return null;
  }
}

/**
 * Whether writing `world` would put the copy in storage backwards.
 *
 * Two tabs on the same world each save it, and the one that has been sitting
 * in the background all afternoon still holds the settlement as it was at
 * lunchtime. Its timer used to write that over the copy the other tab had
 * been building all day, so the next open continued from lunchtime. The
 * store only ever moves forward in the settlement's own time.
 */
export function wouldRegress(world: World): boolean {
  if (typeof window === 'undefined') return false;
  const held = markOf(world.seed);
  if (!held) return false;
  return held.day > world.day || (held.day === world.day && held.hour > world.hour + 0.5);
}

export function saveWorld(world: World) {
  if (typeof window === 'undefined') return;
  if (wouldRegress(world)) return;
  const payload = snapshotOf(world);
  try {
    window.localStorage.setItem(keyFor(world.seed), JSON.stringify(payload));
    window.localStorage.setItem(markFor(world.seed), `${world.day}:${world.hour}`);
  } catch {
    // A full quota or a private window. The world keeps running; it just will
    // not be here next time.
  }
}

/**
 * Read a settlement back, or return null if there is nothing sound to read.
 *
 * The checks are deliberately shallow but load-bearing: the right version, the
 * right seed, and a population and building list that are actually arrays. A
 * save that fails any of them is discarded rather than half-applied, because a
 * world missing its citizens array crashes on the first frame and a world
 * regenerated from its seed does not.
 */
export function loadWorld(seed: number, name: string): World | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(seed));
  } catch {
    return null;
  }
  if (!raw) return null;

  let world: World | null = null;
  try {
    world = worldFromSave(JSON.parse(raw) as SavedWorld, seed, name);
  } catch {
    world = null;
  }
  // A save that cannot be read must not go on guarding its place: the next
  // write would be refused as a regression against a copy nobody can open.
  if (!world) {
    try { window.localStorage.removeItem(markFor(seed)); } catch { /* nothing to do */ }
  }
  return world;
}

/**
 * Build a world from a save payload, wherever it came from.
 *
 * Local storage is one source; a snapshot another player published so their
 * settlement can be visited is the other. Both go through the same checks,
 * because a payload off the network deserves at least the suspicion given to
 * one out of this browser's own storage.
 */
export function worldFromSave(parsed: SavedWorld | null, seed: number, name: string): World | null {
  if (parsed?.version !== SAVE_VERSION || parsed.seed !== seed) return null;
  const saved = parsed.world as Partial<World>;
  if (!Array.isArray(saved?.citizens) || !Array.isArray(saved.buildings)) return null;
  if (!saved.layout || !Array.isArray(saved.layout.nodes)) return null;
  if (!Number.isFinite(saved.day) || !Number.isFinite(saved.treasury)) return null;

  // Start from a fresh world of the same seed and lay the saved state over
  // it. Anything a future version adds that this save predates keeps the
  // value a new world would have given it, rather than arriving undefined.
  const world = createWorld(seed, name);
  const freshMarket = world.market;
  for (const field of KEEP) {
    const value = (saved as Record<string, unknown>)[field];
    if (value !== undefined) (world as unknown as Record<string, unknown>)[field] = value;
  }
  // Goods that did not exist when the save was written: the store holds none
  // and the market quotes them as a new world would, rather than a reader
  // meeting `undefined` where a number should be.
  for (const r of RESOURCES) {
    if (!Number.isFinite(world.resources[r])) world.resources[r] = 0;
    if (!world.market[r]) world.market[r] = freshMarket[r];
  }
  // Never revived: see above.
  world.conversations = [];
  // The name comes from the claim, which the player can have changed in the
  // world map since.
  world.name = name;
  return world;
}

/** The save payload for a world, to hand to the relay for visitors. */
export function snapshotOf(world: World): SavedWorld {
  const slim: Record<string, unknown> = {};
  for (const field of KEEP) slim[field] = world[field];
  return { version: SAVE_VERSION, seed: world.seed, at: Date.now(), world: slim };
}

/** Forget a settlement. Used when a plot is given up. */
export function clearWorld(seed: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(keyFor(seed));
    window.localStorage.removeItem(markFor(seed));
  } catch { /* nothing to do */ }
}

/** When this world was last saved, or null if it never was. */
export function savedAt(seed: number): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(keyFor(seed));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedWorld;
    return Number.isFinite(parsed?.at) ? parsed.at : null;
  } catch {
    return null;
  }
}

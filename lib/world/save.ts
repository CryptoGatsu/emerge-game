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
import { clientKey } from '../limits';

/**
 * Bump when the shape of a saved world changes incompatibly. An older save is
 * then ignored rather than revived into a shape the simulation cannot run.
 */
const SAVE_VERSION = 1;

const keyFor = (seed: number) => clientKey(`save.${seed}.v${SAVE_VERSION}`);

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
  'artworks', 'unlockedAreas', 'marketClock', 'flow', 'flowYesterday', 'ledger',
  'ledgerYesterday', 'stewardship', 'counter',
] as const;

/**
 * Conversations are deliberately not saved: an exchange resumed three days
 * later, mid-sentence, between two people who have since walked to opposite
 * ends of the settlement, is worse than no exchange at all. They start again.
 */

export function saveWorld(world: World) {
  if (typeof window === 'undefined') return;
  const payload = snapshotOf(world);
  try {
    window.localStorage.setItem(keyFor(world.seed), JSON.stringify(payload));
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

  try {
    return worldFromSave(JSON.parse(raw) as SavedWorld, seed, name);
  } catch {
    return null;
  }
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
  for (const field of KEEP) {
    const value = (saved as Record<string, unknown>)[field];
    if (value !== undefined) (world as unknown as Record<string, unknown>)[field] = value;
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

/**
 * The eighteen things a settlement makes, needs and trades.
 *
 * Pulled out of the simulation so the server can read the same tables. The
 * global market lives on the server and the settlements live in the browser,
 * and the two have to agree about what bread is worth in a world with the
 * usual amount of it — otherwise every client would be told a price computed
 * against a different baseline and the whole index would mean nothing.
 *
 * Nothing here has any behaviour. It is the reference the market is quoted
 * against: a base price per unit, and the amount of each good a settlement
 * likes to keep on hand.
 */

export type Resource =
  | 'wheat' | 'vegetables' | 'fish' | 'game' | 'berries'
  | 'wood' | 'stone' | 'ironOre' | 'wool' | 'hides' | 'herbs'
  | 'flour' | 'bread' | 'furniture' | 'tools' | 'clothing'
  | 'meals' | 'steel';

/** Every resource, in the order the market panel lists them. */
export const RESOURCES: Resource[] = [
  'wheat', 'vegetables', 'fish', 'game', 'berries',
  'wood', 'stone', 'ironOre', 'wool', 'hides', 'herbs',
  'flour', 'bread', 'meals', 'furniture', 'tools', 'steel', 'clothing',
];

export const RESOURCE_LABELS: Record<Resource, string> = {
  wheat: 'Wheat', vegetables: 'Vegetables', fish: 'Fish', game: 'Game', berries: 'Berries',
  wood: 'Wood', stone: 'Stone', ironOre: 'Iron Ore', wool: 'Wool', hides: 'Hides', herbs: 'Herbs',
  flour: 'Flour', bread: 'Bread', furniture: 'Furniture', tools: 'Tools', clothing: 'Clothing',
  meals: 'Meals', steel: 'Steel',
};

/**
 * What a unit is worth when nothing in particular is going on.
 *
 * Every price in the game is expressed as a movement away from these, and the
 * clamps below are multiples of them, so a good never leaves the range the
 * economy was balanced in however the world's mood goes.
 */
export const BASE_PRICES: Record<Resource, number> = {
  wheat: 2, vegetables: 2.5, fish: 4, game: 6, berries: 2.5,
  wood: 3, stone: 4, ironOre: 7, wool: 6, hides: 9, herbs: 8,
  flour: 5, bread: 7, furniture: 14, tools: 20, clothing: 18,
  // The later ages' goods: a prepared meal from the food plant, steel from
  // the ironworks. Dearer than what they are made from, as they should be.
  meals: 13, steel: 32,
};

/**
 * The age a good belongs to.
 *
 * A settlement has no use for steel and no kitchen to put up meals, and its
 * market should not be buying either. It was: both goods were added to the
 * table for the later ages and the market, which imports anything the plot
 * cannot make for itself, dutifully bought thirty meals and ten steel into
 * every settlement in the game and charged the treasury for them.
 */
export const RESOURCE_ERA: Record<Resource, number> = {
  wheat: 1, vegetables: 1, fish: 1, game: 1, berries: 1,
  wood: 1, stone: 1, ironOre: 1, wool: 1, hides: 1, herbs: 1,
  flour: 1, bread: 1, furniture: 1, tools: 1, clothing: 1,
  meals: 3, steel: 3,
};

/** Whether a good is traded at all in this age. */
export const tradedIn = (r: Resource, era: number) => RESOURCE_ERA[r] <= Math.max(1, era);

/** How much of each a settlement wants in store. Shortage is measured against this. */
export const MARKET_BUFFERS: Record<Resource, number> = {
  wheat: 60, vegetables: 40, fish: 30, game: 20, berries: 25,
  wood: 70, stone: 30, ironOre: 20, wool: 15, hides: 6, herbs: 6,
  flour: 25, bread: 40, furniture: 10, tools: 8, clothing: 15,
  meals: 30, steel: 10,
};

/**
 * The floor and ceiling a price may reach, as a multiple of its base.
 *
 * A market with no bounds is a market that eventually pays nothing for wheat or
 * everything for tools, and either one takes a settlement's treasury with it.
 */
export const PRICE_FLOOR = 0.45;
export const PRICE_CEILING = 3.5;

/** How hard a shortage pushes on a price. Shared so local and global agree. */
export const SCARCITY_WEIGHT = 0.8;

/**
 * Where a price wants to sit given how short of the good the world is.
 *
 * `shortage` runs from -1 (drowning in it) through 0 (exactly the buffer) to
 * 1.5 (nothing at all, and wanting more than the buffer). The one function is
 * used by the global index and by a settlement trading on its own, so an
 * offline world and a connected one price the same conditions the same way.
 */
export function targetPrice(resource: Resource, shortage: number): number {
  const base = BASE_PRICES[resource];
  const wanted = base * (1 + shortage * SCARCITY_WEIGHT);
  return Math.min(base * PRICE_CEILING, Math.max(base * PRICE_FLOOR, wanted));
}

/** How short of a good a store is, on the scale `targetPrice` expects. */
export function shortageOf(resource: Resource, stock: number): number {
  const buffer = Math.max(1, MARKET_BUFFERS[resource]);
  return Math.min(1.5, Math.max(-1, (buffer - stock) / buffer));
}

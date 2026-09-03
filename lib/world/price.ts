/**
 * What a plot costs.
 *
 * Derived from the seed and nothing else, which is the property that matters:
 * the browser showing a price and the server enforcing one have to arrive at
 * the same number without talking to each other, and without either of them
 * running the world generator to find out.
 *
 * It used to include the settlement's population and the trades its land
 * supports, which meant pricing a plot meant generating a world — fine in a
 * browser that was about to draw it anyway, and much less fine in an API route
 * that has to check a payment. The biome premium already carries most of that
 * signal, since it is *why* a valley supports more trades than a desert.
 *
 * It is also, deliberately, the same formula `EmergeLand.priceOf` uses. Deploy
 * the contract later and every price in the game is already the price it
 * charges, with nothing to migrate.
 *
 * No imports on purpose: a client component, an API route and a Solidity port
 * all read from here.
 */

/** Biomes in the order the seed hash indexes them. */
export const BIOME_KINDS_BY_INDEX = [
  'valley', 'woodland', 'highland', 'wetland', 'steppe', 'coast', 'desert', 'swamp', 'grassland',
] as const;

export type PricedBiome = (typeof BIOME_KINDS_BY_INDEX)[number];

/** What each biome is worth, since land that supports more trades is worth more. */
export const BIOME_PREMIUM: Record<PricedBiome, number> = {
  valley: 190, woodland: 120, highland: 165, wetland: 110, steppe: 95,
  coast: 130, desert: 85, swamp: 100, grassland: 175,
};

export const BASE_PRICE = 180;
export const PRICE_SCALE = 800;

/**
 * Which biome a seed grows.
 *
 * The same 32-bit mix `biomeKindFor` uses, repeated here so this module can
 * stay import-free. The two are checked against each other in the test sweep,
 * and against the Solidity port in `contracts/EmergeLand.sol`.
 */
export function biomeIndexFor(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return Math.abs(h) % BIOME_KINDS_BY_INDEX.length;
}

/** What a plot costs, in whole $EMERGE. */
export function priceOfSeed(seed: number): number {
  const biome = BIOME_KINDS_BY_INDEX[biomeIndexFor(seed)];
  return (BASE_PRICE + BIOME_PREMIUM[biome]) * PRICE_SCALE;
}

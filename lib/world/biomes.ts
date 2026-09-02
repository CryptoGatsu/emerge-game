/**
 * Biomes.
 *
 * A plot's seed decides what kind of place it is, and that decision reaches
 * everything: how much of it is wood or bare rock, where the water runs and how
 * much of it there is, whether there is a highland shelf worth mining, which
 * trees grow, what colour the ground and the canopy read as, and which trades
 * the first settlers can practise there.
 *
 * This module imports nothing, so both the simulation and the terrain generator
 * can depend on it without a cycle.
 */

export type BiomeKind = 'valley' | 'woodland' | 'highland' | 'wetland' | 'steppe' | 'coast';
export type WaterShape = 'river' | 'creek' | 'lake' | 'delta';
export type TreeSpecies = 'pine' | 'oak' | 'birch';

export interface BiomeProfile {
  kind: BiomeKind;
  label: string;
  blurb: string;

  /** Multiplied into the ground and canopy tints by the renderer. */
  groundTint: number;
  foliageTint: number;
  /** A gentle wash over built structures, so stone reads cold and timber warm. */
  buildingTint: number;

  /** Added to the woodland noise. Positive means more trees. */
  forest: number;
  /** Threshold for exposed rock. Lower means more of it. */
  rockThreshold: number;
  /** How often meadow gives way to flowers. */
  bloom: number;

  water: WaterShape;
  /** Multiplies river width. */
  waterScale: number;
  /** Multiplies the pond radius. */
  pondScale: number;
  /** How much of the map rises into a shelf, 0 for none. */
  plateau: number;

  trees: TreeSpecies[];
  /** Trades the land supports, on top of the civic core. */
  trades: string[];
}

const BIOMES: Record<BiomeKind, Omit<BiomeProfile, 'kind'>> = {
  valley: {
    label: 'River Valley',
    blurb: 'Broad fertile ground either side of fast water, with woodland on the slopes.',
    groundTint: 0xffffff, foliageTint: 0xffffff, buildingTint: 0xffffff,
    forest: 0, rockThreshold: 0.76, bloom: 0.68,
    water: 'river', waterScale: 1, pondScale: 1, plateau: 1,
    trees: ['oak', 'birch', 'pine'],
    trades: ['Farm', 'Farm', 'Woodcutter', 'Mill', 'Bakery', 'Carpenter', 'Blacksmith', 'Tailor', 'Quarry', 'Mine'],
  },
  woodland: {
    label: 'Deep Woodland',
    blurb: 'Old forest on every side. Timber is everywhere; open ground is not.',
    groundTint: 0xdff0d8, foliageTint: 0xd8f2c8, buildingTint: 0xf0f4ea,
    forest: 0.16, rockThreshold: 0.84, bloom: 0.74,
    water: 'creek', waterScale: 0.7, pondScale: 0.8, plateau: 0.5,
    trees: ['pine', 'oak', 'pine'],
    trades: ['Woodcutter', 'Woodcutter', 'Carpenter', 'Carpenter', 'Farm', 'Mill', 'Bakery', 'Tailor'],
  },
  highland: {
    label: 'Highland Shelf',
    blurb: 'Stone near the surface and iron in the hills. Hard ground, rich under it.',
    groundTint: 0xe8ecf0, foliageTint: 0xdce8e0, buildingTint: 0xe6ecf2,
    forest: -0.1, rockThreshold: 0.58, bloom: 0.8,
    water: 'creek', waterScale: 0.8, pondScale: 0.7, plateau: 1.9,
    trees: ['pine', 'pine', 'birch'],
    trades: ['Mine', 'Mine', 'Quarry', 'Quarry', 'Blacksmith', 'Woodcutter', 'Farm', 'Mill', 'Bakery'],
  },
  wetland: {
    label: 'Wetland Fen',
    blurb: 'Braided water and reed beds. Good soil where it is dry enough to plough.',
    groundTint: 0xe6f4e4, foliageTint: 0xe0f4d8, buildingTint: 0xf0f6f0,
    forest: 0.05, rockThreshold: 0.88, bloom: 0.58,
    water: 'delta', waterScale: 1.35, pondScale: 1.7, plateau: 0,
    trees: ['birch', 'oak', 'birch'],
    trades: ['Farm', 'Farm', 'Mill', 'Bakery', 'Tailor', 'Woodcutter', 'Carpenter'],
  },
  steppe: {
    label: 'Open Steppe',
    blurb: 'Wide grassland under a big sky. Little shade, and a long way to the trees.',
    groundTint: 0xfff2d8, foliageTint: 0xf6e8b8, buildingTint: 0xfff4e2,
    forest: -0.2, rockThreshold: 0.7, bloom: 0.5,
    water: 'creek', waterScale: 0.6, pondScale: 1.2, plateau: 0.6,
    trees: ['oak', 'birch', 'oak'],
    trades: ['Farm', 'Farm', 'Farm', 'Mill', 'Bakery', 'Tailor', 'Quarry', 'Woodcutter'],
  },
  coast: {
    label: 'Coastal Shallows',
    blurb: 'A great lake at the edge of it, sand along the shore, and shelter inland.',
    groundTint: 0xf0f6ee, foliageTint: 0xe8f6e4, buildingTint: 0xf4f8fa,
    forest: 0.02, rockThreshold: 0.8, bloom: 0.64,
    water: 'lake', waterScale: 1.1, pondScale: 2.2, plateau: 0.4,
    trees: ['pine', 'birch', 'oak'],
    trades: ['Farm', 'Woodcutter', 'Mill', 'Bakery', 'Carpenter', 'Tailor', 'Quarry'],
  },
};

export const BIOME_KINDS = Object.keys(BIOMES) as BiomeKind[];

/** Which biome a seed produces. Same seed, same land, always. */
export function biomeKindFor(seed: number): BiomeKind {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return BIOME_KINDS[Math.abs(h) % BIOME_KINDS.length];
}

export function biomeFor(seed: number): BiomeProfile {
  const kind = biomeKindFor(seed);
  return { kind, ...BIOMES[kind] };
}

export function biomeProfile(kind: BiomeKind): BiomeProfile {
  return { kind, ...BIOMES[kind] };
}

/**
 * The water each biome carries, as polylines in world units. Routes are chosen
 * in isometric screen space: a channel laid along a world axis projects to the
 * straight edge of a diamond and reads as a moat rather than a river.
 */
export const WATER_ROUTES: Record<WaterShape, [number, number][][]> = {
  river: [[
    [86, 1], [78, 4], [68, 8], [58, 12], [48, 15], [38, 19], [30, 24],
    [23, 31], [18, 40], [14, 50], [15, 63], [19, 76], [26, 89], [34, 99],
  ]],
  creek: [[
    [72, 2], [64, 7], [55, 12], [45, 17], [36, 23], [30, 32], [27, 43], [26, 55],
  ]],
  lake: [[
    [96, 4], [88, 9], [79, 14], [70, 18],
  ]],
  delta: [
    [[88, 2], [78, 7], [67, 12], [56, 17], [45, 22], [35, 29], [28, 39], [24, 52], [25, 66], [30, 80], [37, 95]],
    [[56, 17], [50, 27], [46, 38], [45, 50], [48, 63], [54, 76], [61, 90]],
  ],
};

/** Where the standing water sits, and how big it is before the biome scales it. */
export const PONDS: Record<WaterShape, { x: number; y: number; r: number }> = {
  river: { x: 12, y: 56, r: 8 },
  creek: { x: 22, y: 62, r: 7 },
  lake: { x: 74, y: 26, r: 15 },
  delta: { x: 34, y: 70, r: 9 },
};

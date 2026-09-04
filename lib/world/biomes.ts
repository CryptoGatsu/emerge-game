/**
 * Biomes.
 *
 * A plot's seed decides what kind of place it is, and that decision reaches
 * everything: how much of it is wood, bare rock, dune or marsh, where the water
 * runs and how much of it there is, whether there is a highland shelf worth
 * mining, which trees grow, what colour the ground and the canopy read as,
 * which trades the first settlers can practise there — and, since this round,
 * what shape the settlement itself takes. A fen village strung along a causeway
 * and a desert town wrapped around its only water are not the same place with a
 * different palette.
 *
 * This module imports nothing, so both the simulation and the terrain generator
 * can depend on it without a cycle.
 */

export type BiomeKind =
  | 'valley' | 'woodland' | 'highland' | 'wetland' | 'steppe'
  | 'coast' | 'desert' | 'swamp' | 'grassland';

/** The shape of a biome's water. */
export type WaterShape = 'river' | 'creek' | 'lake' | 'delta' | 'oasis' | 'marsh' | 'brook';

export type TreeSpecies = 'pine' | 'oak' | 'birch' | 'palm' | 'mangrove' | 'acacia';

/**
 * The settlement plan. Nine biomes, nine plans — a town built around a
 * crossroads is a different object from one that clings to a shoreline, and
 * this is the field that says which.
 */
export type LayoutKind =
  | 'hub'       // a square with roads spoking out of it
  | 'clearing'  // a tight core with paths winding into the trees
  | 'terrace'   // two lanes at different heights, joined by ramps
  | 'causeway'  // a spine over wet ground with platforms off it
  | 'lane'      // one long street with spurs alternating either side
  | 'harbour'   // an arc following the shore, piers pointing at the water
  | 'oasis'     // a ring around the only water for miles
  | 'scatter'   // hamlets on dry hummocks, linked by boardwalk
  | 'ring';     // a road enclosing a common green

/** Ground cover a biome favours where nothing else claims the tile. */
export type GroundKind = 'grass' | 'dune' | 'marsh' | 'scrub';

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
  /** What the open ground is made of when it is not wood, rock or field. */
  ground: GroundKind;
  /** How much of the open ground takes the biome's own cover, 0-1. */
  groundCover: number;

  water: WaterShape;
  /** Multiplies river width. */
  waterScale: number;
  /** Multiplies the pond radius. */
  pondScale: number;
  /** How much of the map rises into a shelf, 0 for none. */
  plateau: number;

  layout: LayoutKind;
  /** Roughly how many people the land supports. */
  populationScale: number;

  /** Mean temperature over the year, in degrees Celsius. */
  baseTemp: number;
  /** How far midsummer and midwinter swing either side of the mean. */
  seasonSwing: number;
  /** How far a day swings between its coldest hour and its warmest. */
  diurnalSwing: number;

  trees: TreeSpecies[];
  /** Trades the land supports, on top of the civic core. */
  trades: string[];
}

const BIOMES: Record<BiomeKind, Omit<BiomeProfile, 'kind'>> = {
  valley: {
    label: 'River Valley',
    blurb: 'Broad fertile ground either side of fast water, with woodland on the slopes.',
    groundTint: 0xffffff, foliageTint: 0xffffff, buildingTint: 0xffffff,
    forest: 0, rockThreshold: 0.76, bloom: 0.68, ground: 'grass', groundCover: 0,
    water: 'river', waterScale: 1, pondScale: 1, plateau: 1,
    layout: 'hub', populationScale: 1,
    baseTemp: 12, seasonSwing: 12, diurnalSwing: 8,
    trees: ['oak', 'birch', 'pine'],
    trades: ['Farm', 'Farm', 'Woodcutter', 'Fishery', 'Mill', 'Bakery', 'Carpenter', 'Lodge', 'Blacksmith', 'Tailor', 'Forager', 'Quarry', 'Mine'],
  },
  woodland: {
    label: 'Deep Woodland',
    blurb: 'Old forest on every side. Timber is everywhere; open ground is not.',
    groundTint: 0xdff0d8, foliageTint: 0xd8f2c8, buildingTint: 0xf0f4ea,
    forest: 0.16, rockThreshold: 0.84, bloom: 0.74, ground: 'grass', groundCover: 0,
    water: 'creek', waterScale: 0.7, pondScale: 0.8, plateau: 0.5,
    layout: 'clearing', populationScale: 0.85,
    // Under a canopy the air moves less and the day swings less.
    baseTemp: 10, seasonSwing: 11, diurnalSwing: 6,
    trees: ['pine', 'oak', 'pine'],
    trades: ['Woodcutter', 'Woodcutter', 'Lodge', 'Carpenter', 'Carpenter', 'Forager', 'Farm', 'Mill', 'Bakery', 'Tailor', 'Fishery'],
  },
  highland: {
    label: 'Highland Shelf',
    blurb: 'Stone near the surface and iron in the hills. Hard ground, rich under it.',
    groundTint: 0xe8ecf0, foliageTint: 0xdce8e0, buildingTint: 0xe6ecf2,
    forest: -0.1, rockThreshold: 0.58, bloom: 0.8, ground: 'grass', groundCover: 0,
    water: 'creek', waterScale: 0.8, pondScale: 0.7, plateau: 1.9,
    layout: 'terrace', populationScale: 0.8,
    baseTemp: 5, seasonSwing: 12, diurnalSwing: 9,
    trees: ['pine', 'pine', 'birch'],
    trades: ['Mine', 'Mine', 'Quarry', 'Quarry', 'Blacksmith', 'Lodge', 'Woodcutter', 'Farm', 'Mill', 'Bakery', 'Forager'],
  },
  wetland: {
    label: 'Wetland Fen',
    blurb: 'Braided water and reed beds. Good soil where it is dry enough to plough.',
    groundTint: 0xe6f4e4, foliageTint: 0xe0f4d8, buildingTint: 0xf0f6f0,
    forest: 0.05, rockThreshold: 0.88, bloom: 0.58, ground: 'marsh', groundCover: 0.35,
    water: 'delta', waterScale: 1.35, pondScale: 1.7, plateau: 0,
    layout: 'causeway', populationScale: 1.05,
    baseTemp: 12, seasonSwing: 10, diurnalSwing: 6,
    trees: ['birch', 'oak', 'birch'],
    trades: ['Farm', 'Farm', 'Fishery', 'Mill', 'Bakery', 'Forager', 'Tailor', 'Woodcutter', 'Carpenter', 'Lodge'],
  },
  steppe: {
    label: 'Open Steppe',
    blurb: 'Wide grassland under a big sky. Little shade, and a long way to the trees.',
    groundTint: 0xfff2d8, foliageTint: 0xf6e8b8, buildingTint: 0xfff4e2,
    forest: -0.2, rockThreshold: 0.7, bloom: 0.5, ground: 'scrub', groundCover: 0.4,
    water: 'creek', waterScale: 0.6, pondScale: 1.2, plateau: 0.6,
    layout: 'lane', populationScale: 0.8,
    // Nothing to hold the heat in: a continental swing, hot and cold.
    baseTemp: 13, seasonSwing: 16, diurnalSwing: 12,
    trees: ['oak', 'birch', 'acacia'],
    trades: ['Farm', 'Farm', 'Farm', 'Lodge', 'Mill', 'Bakery', 'Tailor', 'Quarry', 'Woodcutter', 'Forager'],
  },
  coast: {
    label: 'Coastal Shallows',
    blurb: 'A great lake at the edge of it, sand along the shore, and shelter inland.',
    groundTint: 0xf0f6ee, foliageTint: 0xe8f6e4, buildingTint: 0xf4f8fa,
    forest: 0.02, rockThreshold: 0.8, bloom: 0.64, ground: 'grass', groundCover: 0,
    water: 'lake', waterScale: 1.1, pondScale: 2.2, plateau: 0.4,
    layout: 'harbour', populationScale: 1.05,
    // A body of water is a flywheel for temperature.
    baseTemp: 13, seasonSwing: 8, diurnalSwing: 5,
    trees: ['pine', 'birch', 'oak'],
    trades: ['Fishery', 'Farm', 'Woodcutter', 'Mill', 'Bakery', 'Carpenter', 'Tailor', 'Quarry', 'Lodge', 'Forager'],
  },
  desert: {
    label: 'Red Desert',
    blurb: 'Dune and bare rock to the horizon, and one spring the whole town is built around.',
    groundTint: 0xffe4bc, foliageTint: 0xf2dfa8, buildingTint: 0xffeed2,
    forest: -0.55, rockThreshold: 0.62, bloom: 0.94, ground: 'dune', groundCover: 0.82,
    water: 'oasis', waterScale: 0.35, pondScale: 1.15, plateau: 1.2,
    layout: 'oasis', populationScale: 0.62,
    // Fierce by day, bitter after dark. The widest daily swing of any biome.
    baseTemp: 27, seasonSwing: 11, diurnalSwing: 17,
    trees: ['palm', 'acacia', 'palm'],
    trades: ['Quarry', 'Quarry', 'Mine', 'Mine', 'Blacksmith', 'Lodge', 'Tailor', 'Farm', 'Bakery', 'Fishery'],
  },
  swamp: {
    label: 'Blackwater Swamp',
    blurb: 'Standing water under a closed canopy. Everything here is built up on stilts.',
    groundTint: 0xcfe0cc, foliageTint: 0xbcd8b4, buildingTint: 0xdde6da,
    forest: 0.22, rockThreshold: 0.93, bloom: 0.86, ground: 'marsh', groundCover: 0.66,
    water: 'marsh', waterScale: 1.7, pondScale: 0.85, plateau: 0,
    layout: 'scatter', populationScale: 0.75,
    baseTemp: 21, seasonSwing: 7, diurnalSwing: 5,
    trees: ['mangrove', 'mangrove', 'birch'],
    trades: ['Woodcutter', 'Woodcutter', 'Fishery', 'Lodge', 'Carpenter', 'Forager', 'Tailor', 'Farm', 'Mill', 'Bakery'],
  },
  grassland: {
    label: 'Green Grassland',
    blurb: 'Deep pasture and gentle rises, a stream through the middle of it, room to grow.',
    groundTint: 0xf2ffe8, foliageTint: 0xeafbdc, buildingTint: 0xf8fbf0,
    forest: -0.05, rockThreshold: 0.86, bloom: 0.58, ground: 'grass', groundCover: 0,
    water: 'brook', waterScale: 0.75, pondScale: 1.35, plateau: 0.3,
    layout: 'ring', populationScale: 1.15,
    baseTemp: 14, seasonSwing: 12, diurnalSwing: 8,
    trees: ['oak', 'oak', 'birch'],
    trades: ['Farm', 'Farm', 'Farm', 'Mill', 'Mill', 'Bakery', 'Lodge', 'Tailor', 'Carpenter', 'Woodcutter', 'Quarry', 'Forager', 'Fishery'],
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
  // A spring has no run to it. The pond is the whole of the water.
  oasis: [],
  // Blackwater: several sluggish channels that never quite become a river.
  marsh: [
    [[92, 10], [82, 16], [71, 21], [60, 27], [50, 34], [42, 44], [38, 56], [39, 70], [44, 84]],
    [[70, 4], [64, 14], [61, 25], [62, 37], [67, 49], [74, 61]],
    [[16, 34], [23, 44], [27, 57], [28, 71], [33, 85]],
  ],
  brook: [[
    [78, 3], [70, 10], [61, 17], [51, 23], [41, 29], [33, 37], [29, 48], [30, 60], [35, 73], [42, 86], [48, 98],
  ]],
};

/** Where the standing water sits, and how big it is before the biome scales it. */
export const PONDS: Record<WaterShape, { x: number; y: number; r: number }> = {
  river: { x: 12, y: 56, r: 8 },
  creek: { x: 22, y: 62, r: 7 },
  lake: { x: 74, y: 26, r: 15 },
  delta: { x: 34, y: 70, r: 9 },
  oasis: { x: 50, y: 50, r: 7 },
  marsh: { x: 55, y: 68, r: 11 },
  brook: { x: 26, y: 66, r: 8 },
};

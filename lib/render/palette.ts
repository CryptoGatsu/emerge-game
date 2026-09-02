/**
 * The Emerge colour script.
 *
 * A lush, deep-green forest world lit from the upper left, with warm
 * cream/gold accents for anything human-made and luminous green for the UI.
 * Every generated sprite pulls from here so the world reads as one painting.
 */

export const GROUND = {
  grassLight: '#5f9d4a',
  grass: '#4c8a3d',
  grassDark: '#3c7132',
  grassDeep: '#2f5b28',
  meadow: '#6cae51',
  moss: '#356b34',
  forestFloor: '#2c4f27',
  forestFloorDark: '#22401f',
  soil: '#5d452c',
  soilDark: '#46331f',
  soilTilled: '#6a4e30',
  sand: '#c2ab72',
  sandDark: '#9c8757',
  stone: '#8d8b7d',
  stoneDark: '#6d6b60',
  stoneLight: '#a8a596',
  path: '#a89468',
  pathDark: '#87764f',
  pathLight: '#c4b184',
  plaza: '#9d9682',
  rock: '#767466',
  rockDark: '#54533f',
  rockLight: '#95927f',
  snow: '#dfe9e4',
} as const;

export const WATER = {
  deep: '#1c4d63',
  mid: '#26688a',
  shallow: '#3a90ab',
  foam: '#c9edf2',
  highlight: '#6fc0cf',
} as const;

export const FOLIAGE = {
  pineLight: '#4d8f45',
  pine: '#357034',
  pineDark: '#23502a',
  oakLight: '#68a94b',
  oak: '#4e8c3a',
  oakDark: '#376328',
  birchLight: '#84bd5e',
  birch: '#639a45',
  birchDark: '#456f30',
  bush: '#417a35',
  bushLight: '#5c9a44',
  trunk: '#5b432c',
  trunkDark: '#3f2e1e',
  trunkLight: '#77593a',
} as const;

export const BLOOM = {
  white: '#f2f4e6',
  yellow: '#f0d05e',
  pink: '#e88bab',
  violet: '#a986d8',
  red: '#d9563f',
  wheat: '#dcc169',
  wheatDark: '#b79c47',
} as const;

export const BUILD = {
  plasterLight: '#d9cfae',
  plaster: '#c0b38e',
  plasterDark: '#9c8f6d',
  timber: '#6b4a2f',
  timberDark: '#4c3320',
  timberLight: '#8a6640',
  roofRed: '#9a4a37',
  roofRedDark: '#733527',
  roofRedLight: '#b6614a',
  roofGreen: '#3f6b46',
  roofGreenDark: '#2c4d33',
  roofGreenLight: '#557f58',
  roofSlate: '#4c5560',
  roofSlateDark: '#363d47',
  roofSlateLight: '#616c78',
  roofThatch: '#b39355',
  roofThatchDark: '#8b7040',
  roofThatchLight: '#ccab68',
  stoneWall: '#8a8574',
  stoneWallDark: '#6a6657',
  stoneWallLight: '#a39d89',
  glassDark: '#2b3a44',
  glassLit: '#ffd88a',
  glassLitCore: '#fff2cc',
  metal: '#5c6169',
  metalLight: '#868c96',
  gold: '#e0b95c',
} as const;

export const UI = {
  emerald: '#8bf16b',
  emeraldDim: '#5fae4c',
  cream: '#f3ead2',
  gold: '#e8c169',
  night: '#050b07',
} as const;

/** Skin, hair and clothing ranges citizens are generated from. */
export const PEOPLE = {
  skin: ['#f2c9a4', '#e2ab7f', '#c98d63', '#a86f48', '#82563a', '#5f3d29'],
  hair: ['#2b2119', '#4a3222', '#6f4a26', '#a9702f', '#c9a24a', '#8d3f2c', '#3f4a5a', '#5f8f6a', '#7a5f8f', '#d6d2c4'],
  shirt: ['#4a7f8f', '#7a4f6a', '#4f7a45', '#8f6a3f', '#5a5f8f', '#8f4f45', '#3f6b6b', '#8f8f4f', '#6a4f8f', '#a86a4f'],
  pants: ['#3c4450', '#4a3d33', '#33473c', '#4d3f4a', '#2f3a45', '#5a4a38'],
  shoes: ['#3a2c22', '#2b2b30', '#4a3a2a'],
} as const;

/** Ambient light by hour, applied as a full-scene tint. */
export interface AmbientStop { hour: number; color: number; alpha: number }
export const AMBIENT: AmbientStop[] = [
  { hour: 0, color: 0x1a2a4d, alpha: 0.56 },
  { hour: 4, color: 0x1f3050, alpha: 0.52 },
  { hour: 6, color: 0x51406a, alpha: 0.34 },
  { hour: 7.5, color: 0xffb96b, alpha: 0.16 },
  { hour: 10, color: 0xfff3d4, alpha: 0.04 },
  { hour: 14, color: 0xffffff, alpha: 0.0 },
  { hour: 17, color: 0xffd9a0, alpha: 0.09 },
  { hour: 19, color: 0xf58a4b, alpha: 0.22 },
  { hour: 20.5, color: 0x6a4f7a, alpha: 0.38 },
  { hour: 22, color: 0x22305a, alpha: 0.5 },
  { hour: 24, color: 0x1a2a4d, alpha: 0.56 },
];

/** Weather adds its own wash on top of the time-of-day tint. */
export const WEATHER_TINT: Record<string, { color: number; alpha: number }> = {
  Clear: { color: 0xffffff, alpha: 0 },
  Cloudy: { color: 0x8fa0ab, alpha: 0.14 },
  Rain: { color: 0x5f7f96, alpha: 0.24 },
  Storm: { color: 0x3d4d63, alpha: 0.36 },
  Fog: { color: 0xbcc9c4, alpha: 0.3 },
  Snow: { color: 0xc6d8e2, alpha: 0.22 },
};

/** Seasonal shift applied to foliage so the world visibly turns over the year. */
export const SEASON_TINT: Record<string, number> = {
  Spring: 0xffffff,
  Summer: 0xf6ffe8,
  Autumn: 0xffd9a8,
  Winter: 0xdfe9f2,
};

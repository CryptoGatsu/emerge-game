/**
 * The Emerge colour script.
 *
 * A deep night-forest world: dark, saturated greens on the ground and in the
 * canopy, buildings of dark stone and timber gone mossy at the foot, warm
 * gold in every window and luminous green for anything that is a sign, a
 * screen or a piece of the interface. The daylight hours are still daylight,
 * but the whole thing sits a stop or two darker than a sunny meadow game
 * would, so that the lights have something to be bright against.
 *
 * Every generated sprite pulls from here so the world reads as one painting.
 */

export const GROUND = {
  grassLight: '#4f8f3c',
  grass: '#3a7030',
  grassDark: '#2c5826',
  grassDeep: '#20421f',
  meadow: '#578f3f',
  moss: '#2b5a2c',
  forestFloor: '#213c1e',
  forestFloorDark: '#172d16',
  soil: '#4b3823',
  soilDark: '#372818',
  soilTilled: '#563f27',
  sand: '#b3a06a',
  sandDark: '#8d7c4f',
  // Paving is cool grey-green cobble now rather than warm gravel: the
  // reference town is laid in stone, and stone in a forest goes green.
  stone: '#707a69',
  stoneDark: '#4f584a',
  stoneLight: '#8f9986',
  path: '#5c6754',
  pathDark: '#444d3f',
  pathLight: '#788470',
  plaza: '#5a6553',
  rock: '#5f665b',
  rockDark: '#43493f',
  rockLight: '#7d857a',
  snow: '#d6e1dc',
  // Biome ground. Desert sand runs warmer and lighter than the river banks,
  // fen mud is green-black, and steppe scrub is bleached grass over dust.
  dune: '#c9aa6c',
  duneDark: '#a38647',
  duneLight: '#dfc48c',
  marsh: '#4c6a3d',
  marshDark: '#34492a',
  marshWet: '#31493b',
  scrub: '#7f914b',
  scrubDark: '#627236',
  scrubDry: '#a89c60',
} as const;

export const WATER = {
  deep: '#0e3644',
  mid: '#155869',
  shallow: '#278594',
  foam: '#bfe9ec',
  highlight: '#5dc6cd',
} as const;

export const FOLIAGE = {
  pineLight: '#3f8a44',
  pine: '#2a6234',
  pineDark: '#1a4325',
  oakLight: '#5aa04a',
  oak: '#3f7f36',
  oakDark: '#2a5727',
  birchLight: '#74b356',
  birch: '#548f3f',
  birchDark: '#39652b',
  bush: '#356b2f',
  bushLight: '#4f8c3d',
  trunk: '#4a3524',
  trunkDark: '#31231a',
  trunkLight: '#66492f',
  // The three species the new biomes brought with them.
  palmLight: '#6ea84e',
  palm: '#4f8838',
  palmDark: '#336027',
  mangroveLight: '#427543',
  mangrove: '#2d5834',
  mangroveDark: '#1c3c23',
  acaciaLight: '#8ea854',
  acacia: '#6f8b3f',
  acaciaDark: '#4f632b',
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
  // "Plaster" is the light wall: a pale, mossy render over stone rather than
  // cream. It still reads as the light face against the dark timber.
  plasterLight: '#98a38e',
  plaster: '#76806c',
  plasterDark: '#565f4e',
  timber: '#4f3a27',
  timberDark: '#35271a',
  timberLight: '#6c5138',
  roofRed: '#7a3f31',
  roofRedDark: '#562b22',
  roofRedLight: '#955444',
  roofGreen: '#2f5a3a',
  roofGreenDark: '#20402a',
  roofGreenLight: '#3f7048',
  roofSlate: '#3a4550',
  roofSlateDark: '#27303a',
  roofSlateLight: '#4c5966',
  roofThatch: '#7f7a46',
  roofThatchDark: '#5c5830',
  roofThatchLight: '#9a9558',
  stoneWall: '#66705f',
  stoneWallDark: '#4a5245',
  stoneWallLight: '#828c79',
  glassDark: '#1d2a30',
  glassLit: '#ffcf7a',
  glassLitCore: '#fff0c8',
  metal: '#4f555c',
  metalLight: '#7a828c',
  gold: '#e0b95c',
  // Signage. Every shop in the reference wears its name in lit green letters
  // on a dark board, and that is the single strongest style cue there is.
  signBoard: '#101a12',
  signEdge: '#2a3b2c',
  sign: '#8ff06a',
  signDim: '#4d9a3d',
  signGlow: '#b8ff8a',
  // The lab's glass: cold teal lit from inside.
  labGlass: '#1e4e52',
  labGlassLit: '#4fd6c8',
  labCore: '#9dfff0',
  // Growing green mould at the foot of every wall in a damp forest town.
  moss: '#3f7a3a',
  mossDark: '#2b5a2b',
  vine: '#4c8f44',
} as const;

export const UI = {
  emerald: '#8bf16b',
  emeraldDim: '#5fae4c',
  cream: '#f3ead2',
  gold: '#e8c169',
  night: '#050b07',
} as const;

/**
 * Skin, hair and clothing ranges citizens are generated from.
 *
 * Clothes went dark: the reference crowd wears deep blues, greens, plums and
 * charcoal with one bright accent, and it is the accent that tells people
 * apart at a glance. Hair got its vivid options — violet, teal, spring green —
 * alongside the natural ones, because a settlement of AI beings is allowed to
 * look like one.
 */
export const PEOPLE = {
  skin: ['#f4cfae', '#e6b48c', '#cf946c', '#ad7550', '#875b3e', '#63402b', '#f0d9c4', '#b8865f'],
  hair: [
    '#221a15', '#3e2a1c', '#6b4622', '#a96f2e', '#d5b04e', '#8d3f2c', '#3b4557',
    '#7b3fb0', '#4fb56a', '#3fa3a8', '#c94f7c', '#e8dcc2', '#5a6d3a', '#d97b3a',
  ],
  shirt: [
    '#2f3a44', '#3b2f4a', '#24413a', '#4a3a2a', '#1f3a4a', '#3d2f2f', '#2a4a2a',
    '#4a4a2f', '#4a2f5a', '#2a3a5a', '#33333a', '#3a4a3a',
  ],
  accent: ['#8ff06a', '#e8c169', '#5fd6c8', '#e88bab', '#f0d05e', '#a986d8', '#f4f4e8', '#ff8a4a'],
  pants: ['#262c34', '#2e2723', '#20302a', '#2f2731', '#1e262e', '#3a3026'],
  shoes: ['#241c16', '#1b1b20', '#2e241a'],
} as const;

/**
 * Ambient light by hour, applied as a full-scene tint.
 *
 * Night is teal-green rather than blue — a forest at night, lit by what the
 * town has lit — and it goes deeper than it did, because the windows and
 * signs are the point of the look and they need dark to glow against.
 * Midday keeps a faint green cast so the world never reads as a different
 * game between noon and midnight.
 */
export interface AmbientStop { hour: number; color: number; alpha: number }
export const AMBIENT: AmbientStop[] = [
  { hour: 0, color: 0x0b2a26, alpha: 0.62 },
  { hour: 4, color: 0x0e2d2a, alpha: 0.6 },
  { hour: 6, color: 0x2f4a5a, alpha: 0.4 },
  { hour: 7.5, color: 0xd9a86a, alpha: 0.16 },
  // Midday keeps a cool green wash rather than going to white: the reference
  // is a forest under a canopy, and full sun on it reads as a different game.
  { hour: 10, color: 0xb9e3c8, alpha: 0.13 },
  { hour: 14, color: 0xb4e0c6, alpha: 0.12 },
  { hour: 17, color: 0xe0cf9a, alpha: 0.14 },
  { hour: 19, color: 0xd4703c, alpha: 0.24 },
  { hour: 20.5, color: 0x3b4d5f, alpha: 0.44 },
  { hour: 22, color: 0x12332e, alpha: 0.58 },
  { hour: 24, color: 0x0b2a26, alpha: 0.62 },
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

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
 * What a township wears: wool coats in bottle green, navy, burgundy and
 * brown, brass and cream at the collar, dark trousers and leather. The same
 * faces, better cloth.
 */
export const PEOPLE_TOWNSHIP = {
  skin: PEOPLE.skin,
  hair: PEOPLE.hair,
  shirt: [
    '#2e4a3a', '#243a58', '#5a2a30', '#4a3826', '#3a3a4a', '#2f4a44', '#563a2a',
    '#2a3a2a', '#44304a', '#34424a', '#4a4030', '#2c3c50',
  ],
  accent: ['#e8d8a8', '#c9a552', '#b8c8d0', '#d8a878', '#e8e0c8', '#a8b890', '#d0b060', '#c8a0a0'],
  pants: ['#1e2228', '#26201c', '#1c2822', '#241e28', '#181e24', '#2e2820'],
  shoes: ['#241c16', '#1b1b20', '#2e241a', '#3a2a1c'],
} as const;

/**
 * The industrial era: caps, aprons and overalls in soot grey, indigo and
 * brown, a brass or a red kerchief at the neck.
 */
export const PEOPLE_INDUSTRIAL = {
  skin: PEOPLE.skin,
  hair: PEOPLE.hair,
  shirt: [
    '#3a3a3e', '#2c3450', '#4a3a30', '#33403a', '#2a2a30', '#4a4038', '#38304a',
    '#2e3a44', '#463a2a', '#3c3c34', '#2a3648', '#40343c',
  ],
  accent: ['#c9a552', '#b8433a', '#d8d0b8', '#8fa0b0', '#e0b070', '#a8a8a0', '#c8c0a0', '#d0605a'],
  pants: ['#24262c', '#2a2420', '#1e2430', '#2c2a2a', '#202428', '#302a24'],
  shoes: ['#1c1a18', '#241c16', '#1a1a20', '#2a221a'],
} as const;

/**
 * The modern era: jackets, tees and jeans, brighter and lighter, with a
 * white or a neon accent and trainers.
 */
export const PEOPLE_MODERN = {
  skin: PEOPLE.skin,
  hair: PEOPLE.hair,
  shirt: [
    '#3a5a9a', '#c84a4a', '#3a8a6a', '#e0c060', '#6a4aa0', '#e07a3a', '#4a8ac0',
    '#d8d8d0', '#2a2a30', '#8ab04a', '#c05a90', '#3a3a5a',
  ],
  accent: ['#ffffff', '#ff5a5a', '#5ad8ff', '#ffe05a', '#8fff6a', '#ff8ad8', '#2a2a2a', '#ffb05a'],
  pants: ['#33456a', '#2a3550', '#3a3a3a', '#5a4a3a', '#24304a', '#48505a'],
  shoes: ['#f0f0ea', '#2a2a2a', '#c8c8c0', '#3a3a50'],
} as const;

/**
 * The AI era: light suits in white, pearl and pale grey, a soft glow at the
 * collar in teal, violet or spring green.
 */
export const PEOPLE_AI = {
  skin: PEOPLE.skin,
  hair: PEOPLE.hair,
  shirt: [
    '#e8ecf0', '#d8dce4', '#c8d0d8', '#eef0e8', '#d0d8e8', '#e0e4ec', '#c8ccd8',
    '#f0f0f4', '#b8c4d0', '#dce8e4', '#e4dce8', '#ccd4dc',
  ],
  accent: ['#5fd6c8', '#a986d8', '#8ff06a', '#5ad8ff', '#ffe05a', '#ff8ad8', '#ffffff', '#7ab8ff'],
  pants: ['#d8dce4', '#c8ccd4', '#e0e4ea', '#b8bec8', '#cdd3dc', '#dfe3ea'],
  shoes: ['#f4f4f0', '#d8d8d4', '#c0c4cc', '#e8e8e4'],
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

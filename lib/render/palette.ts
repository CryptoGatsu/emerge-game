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
  // Golden-hour ground: saturated warm greens that the sun sits on, not the
  // blue-black moss of a night forest. Everything below is keyed to the
  // reference painting: amber light from the upper right, teal water.
  grassLight: '#8cc650',
  grass: '#66a63c',
  grassDark: '#4f8a30',
  grassDeep: '#3c6c27',
  meadow: '#93c455',
  moss: '#4d8f3a',
  forestFloor: '#3f7a2f',
  forestFloorDark: '#2f5f25',
  soil: '#8a6640',
  soilDark: '#664a2c',
  soilTilled: '#9a7248',
  sand: '#dcc58c',
  sandDark: '#b9a065',
  // Paving is warm dressed stone, sun-bleached on top and sand between.
  stone: '#a89b80',
  stoneDark: '#7a6f58',
  stoneLight: '#cbbf9f',
  path: '#b89c6c',
  pathDark: '#8e7650',
  pathLight: '#d2b885',
  plaza: '#b3a284',
  rock: '#8d8677',
  rockDark: '#605a4e',
  rockLight: '#b3ac9c',
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
  deep: '#125260',
  mid: '#1c7684',
  shallow: '#2f9aa4',
  foam: '#eaf9f7',
  highlight: '#8fe4dc',
} as const;

export const FOLIAGE = {
  pineLight: '#7fc251',
  pine: '#3f8c3c',
  pineDark: '#245c2b',
  oakLight: '#9ad65e',
  oak: '#5aa33e',
  oakDark: '#35722e',
  birchLight: '#b0e070',
  birch: '#6fb04a',
  birchDark: '#427a33',
  bush: '#4f9c3c',
  bushLight: '#84cc56',
  trunk: '#6a4a2e',
  trunkDark: '#3e2a1a',
  trunkLight: '#956a42',
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
  // Plaster is warm cream, sun-struck on the lit face; timber is a dark,
  // warm brown; roofs are terracotta, moss-green, blue slate and golden
  // thatch. Stone walls are pale dressed blocks with sand-coloured mortar.
  plasterLight: '#f0e2c2',
  plaster: '#d4c39a',
  plasterDark: '#a8956c',
  timber: '#6a4a2e',
  timberDark: '#3d2917',
  timberLight: '#8f6a45',
  roofRed: '#a3493a',
  roofRedDark: '#6f3027',
  roofRedLight: '#cd6f55',
  roofGreen: '#3f7a48',
  roofGreenDark: '#28542f',
  roofGreenLight: '#5d9c5c',
  roofSlate: '#4a5a6c',
  roofSlateDark: '#303d4c',
  roofSlateLight: '#6d8093',
  roofThatch: '#bc9c54',
  roofThatchDark: '#8a6f36',
  roofThatchLight: '#e0c47a',
  stoneWall: '#a09582',
  stoneWallDark: '#6f6656',
  stoneWallLight: '#c9bea6',
  glassDark: '#2c3648',
  glassLit: '#ffcf7a',
  glassLitCore: '#fff0c8',
  metal: '#55595e',
  metalLight: '#82898f',
  gold: '#e6bd5e',
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
  // A little green at the foot of a wall, and a vine on the shaded face.
  moss: '#5d9c45',
  mossDark: '#3f7a33',
  vine: '#5aa64a',
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
  { hour: 0, color: 0x0f2740, alpha: 0.6 },
  { hour: 4, color: 0x122b44, alpha: 0.58 },
  { hour: 6, color: 0x5a6a90, alpha: 0.36 },
  { hour: 7.5, color: 0xffc27c, alpha: 0.14 },
  // The day is the painting's own light: a faint cream so noon stays warm
  // without washing the colour out.
  { hour: 10, color: 0xfff1d6, alpha: 0.05 },
  { hour: 14, color: 0xfff4e0, alpha: 0.04 },
  { hour: 17, color: 0xffc86e, alpha: 0.16 },
  { hour: 18.5, color: 0xf7963f, alpha: 0.3 },
  { hour: 19.5, color: 0xd86a3a, alpha: 0.34 },
  { hour: 20.5, color: 0x4a4e80, alpha: 0.44 },
  { hour: 22, color: 0x142c48, alpha: 0.56 },
  { hour: 24, color: 0x0f2740, alpha: 0.6 },
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

/**
 * The eras.
 *
 * A plot starts as a settlement and can be advanced, one step at a time, as
 * far as the game has been built. Each step costs the same and is gated on
 * two things money cannot buy: days lived in the current era, and a
 * checklist of things the settlement has to *be* before it becomes the next
 * thing. The checklist itself lives in the simulation, which is where the
 * numbers are; this file is the table everything else reads — names, days,
 * what arrives — with no imports, so the wiki, the map and the server can
 * all use it.
 */

export type EraId = 1 | 2 | 3 | 4 | 5;

export interface EraSpec {
  id: EraId;
  name: string;
  /** Days that must pass in the era before this one, to reach it. */
  days: number;
  /** What it looks like, in a line. */
  look: string;
  /** What arrives with it, in a line. */
  arrives: string;
}

export const ERAS: EraSpec[] = [
  {
    id: 1, name: 'Settlement', days: 0,
    look: 'Timber and thatch, hand tools, dirt lanes, everybody on foot.',
    arrives: 'Where every plot begins.',
  },
  {
    id: 2, name: 'Township', days: 60,
    look: 'Stone and brick, tiled roofs, cobbled streets.',
    arrives: 'Carts on the roads, a ferry across the water, a Chapel, a Guildhall, a Brewery, a Printer, Stables and a Harbour.',
  },
  {
    id: 3, name: 'Industrial', days: 90,
    look: 'Brick and iron, chimneys, gaslight, rail.',
    arrives: 'Rail on the roads, a steamboat on the water, a Factory, a Foundry, a Railway Station, a Telegraph and a Gasworks. Smog, until the gas is lit.',
  },
  {
    id: 4, name: 'Modern', days: 120,
    look: 'Concrete, glass, tarmac, streetlights at night.',
    arrives: 'Cars and bikes on the roads, a motorboat, a Hospital, a Stadium, a Supermarket, an Office, a Bus Depot and a Power Plant.',
  },
  {
    id: 5, name: 'AI', days: 150,
    look: 'Clean lines, light, gardens on roofs, quiet.',
    arrives: 'Pods on the roads, a hydrofoil on the water, a Data Centre, a Research Campus, a Vertical Farm, a Pod Hub and a Drone Port.',
  },
];

/**
 * Rewards grow with the era. Each era a plot advances to lifts its daily
 * stewardship ceiling by this share of the base: a township earns up to 15%
 * more than a settlement, an AI-era city up to 60% more.
 */
export const ERA_YIELD_STEP = 0.15;
export const eraYield = (era: number) => 1 + Math.max(0, Math.min(ERAS.length - 1, Math.round(era) - 1)) * ERA_YIELD_STEP;

/**
 * City levels.
 *
 * A plot's level is what it has become: the people living there and the
 * buildings standing, and the public works paid for in Gold to carry the
 * place to the next level. Rewards run on the level, so a developed city
 * earns more than a fresh claim, and the Gold a city makes has somewhere to
 * go. Ten levels, each asking for more of both.
 */
export interface CityLevel { level: number; people: number; buildings: number; works: number }
export const CITY_LEVELS: CityLevel[] = [
  { level: 1, people: 0, buildings: 0, works: 0 },
  { level: 2, people: 12, buildings: 8, works: 1_500 },
  { level: 3, people: 20, buildings: 14, works: 4_000 },
  { level: 4, people: 30, buildings: 20, works: 8_000 },
  { level: 5, people: 45, buildings: 28, works: 15_000 },
  { level: 6, people: 60, buildings: 38, works: 25_000 },
  { level: 7, people: 80, buildings: 50, works: 40_000 },
  { level: 8, people: 105, buildings: 65, works: 60_000 },
  { level: 9, people: 130, buildings: 80, works: 90_000 },
  { level: 10, people: 160, buildings: 100, works: 130_000 },
];
export const MAX_CITY_LEVEL = CITY_LEVELS.length;
/** The highest level a settlement of this size has earned by size alone. */
export function levelForSize(people: number, buildings: number): number {
  let level = 1;
  for (const row of CITY_LEVELS) if (people >= row.people && buildings >= row.buildings) level = row.level;
  return level;
}
export const cityLevelSpec = (level: number): CityLevel => CITY_LEVELS[Math.max(1, Math.min(MAX_CITY_LEVEL, Math.round(level))) - 1];

/**
 * What a plot can earn in a real day, from its level and its era.
 *
 * A fresh claim earns a fraction of a city: the ceiling runs from
 * PLOT_CEILING_MIN at level one to PLOT_CEILING_MAX at level ten, and the era
 * multiplies that. This is what makes developing a city worth more than
 * claiming another.
 */
export const PLOT_CEILING_MIN = 6_000;
export const PLOT_CEILING_MAX = 25_000;
export function plotCeiling(level: number, era: number): number {
  const l = Math.max(1, Math.min(MAX_CITY_LEVEL, Math.round(level)));
  const base = PLOT_CEILING_MIN + (PLOT_CEILING_MAX - PLOT_CEILING_MIN) * ((l - 1) / (MAX_CITY_LEVEL - 1));
  return Math.round(base * eraYield(era));
}

/** A charter: $EMERGE burned for a share more on the plot's ceiling, for a while. */
export const CHARTER_BONUS = 0.2;
export const CHARTER_DAYS = 30;
/** Insurance: $EMERGE burned so trouble does half the damage, for a while. */
export const INSURANCE_DAYS = 30;
export const charterMultiplier = (charterUntil: number | undefined, now = Date.now()) => (charterUntil && charterUntil > now ? 1 + CHARTER_BONUS : 1);

/** The city level each era asks for, on top of its own checklist. */
export const ERA_CITY_LEVEL: Record<number, number> = { 2: 3, 3: 5, 4: 7, 5: 9 };

/** How far the game has been built. Eras past this are described, not reachable. */
export const OPEN_ERA: EraId = 5;

export const eraSpec = (id: number): EraSpec => ERAS[Math.max(1, Math.min(ERAS.length, Math.round(id))) - 1];
export const eraName = (id: number) => eraSpec(id).name;
export const nextEra = (id: number): EraSpec | null => (id < ERAS.length ? ERAS[id] : null);

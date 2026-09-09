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
    arrives: 'Carts for the well-off, a ferry for those who can pay, a Chapel, a Guildhall, a Brewery, a Printer, Stables and a Harbour.',
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
 * The old per-era step on a plot's ceiling.
 *
 * A plot's ceiling no longer works this way: the era is a position on the
 * fifty-rung ladder below rather than a multiplier over a ten-level one, which
 * is what lets a city go back to level one of a new age without losing income.
 * This is kept for the wallet-wide ceiling, which is still read per era.
 */
export const ERA_YIELD_STEP = 0.15;
export const eraYield = (era: number) => 1 + Math.max(0, Math.min(ERAS.length - 1, Math.round(era) - 1)) * ERA_YIELD_STEP;

/**
 * City levels, ten to an era.
 *
 * A plot's level is what it has become inside the age it is in: the people
 * living there, the buildings standing, and the public works paid for in Gold
 * to carry the place to the next level. Advancing an era puts the city back to
 * level one *of that era*, and the ten levels ahead of it are a bigger city
 * than the ten behind.
 *
 * The two together are one ladder, not two. A plot's rung is
 * `(era - 1) * 10 + level`, one to fifty, and the reward ceiling runs up that
 * rung — so the level number resets and the earning never does. Level one of
 * the township pays a little *more* than level ten of the settlement, which is
 * the whole point: a player who advances is never worse off for it, and the
 * work behind them stays in the ladder they are standing on.
 *
 * Each era's tenth level is the size the next era's gate asks for, and its
 * first is the size that got the plot in. So "ready for level ten" and "ready
 * to advance" are the same sentence, and the ladder has no dead rungs.
 */
export interface CityLevel { level: number; people: number; buildings: number; works: number }

/** Levels to an era, and rungs on the whole ladder. */
export const LEVELS_PER_ERA = 10;
export const MAX_CITY_LEVEL = LEVELS_PER_ERA;
export const LADDER_RUNGS = 5 * LEVELS_PER_ERA;

/**
 * Where each era's ladder starts and ends, in people and in buildings.
 *
 * The low end is what the plot had when it arrived in the era; the high end is
 * what the gate out of it asks for. Era one starts at the size a claim is
 * founded with, so a fresh plot is level one rather than level four.
 */
const SIZE: Record<number, { people: [number, number]; buildings: [number, number] }> = {
  1: { people: [8, 40], buildings: [6, 30] },
  2: { people: [40, 70], buildings: [30, 50] },
  3: { people: [70, 110], buildings: [50, 75] },
  4: { people: [110, 160], buildings: [75, 100] },
  5: { people: [160, 240], buildings: [100, 140] },
};

/**
 * Sizes are spread evenly across an era's ten levels.
 *
 * Not a curve. A back-loaded one bunched the first rungs of the settlement era
 * a single person apart — level two at nine people, level three at ten — and a
 * level is held only while the size that earned it is still there, so one death
 * in a hard winter took back a level the player had paid Gold for. Played out,
 * the level flickered up and down for hundreds of days. Even spacing puts three
 * or four people between rungs, which together with the one level of slack
 * below means a level is lost only to a real decline and never to a wobble.
 *
 * The climb still gets harder as the game goes on; that is carried by the
 * anchors themselves, since an era's ten levels sit above the whole of the era
 * before it.
 */
const between = ([lo, hi]: [number, number], level: number) =>
  Math.round(lo + (hi - lo) * ((level - 1) / (LEVELS_PER_ERA - 1)));

/**
 * What the public works of each level cost, before the era's multiplier.
 *
 * Deliberately modest in the settlement era and steep at the top. Reaching the
 * tenth level is now what opens the next era, so the first era's whole climb
 * has to cost about what the old gate out of it asked for — a few tens of
 * thousands — or the age nobody could leave would be the first one instead of
 * the third. The multiplier is where the growth lives: the same rung costs a
 * settlement 1x and an AI-era city 25x, against a city many times the size.
 */
const WORKS: number[] = [0, 400, 900, 1_600, 2_600, 4_000, 6_000, 9_000, 13_000, 18_000];
const WORKS_ERA: Record<number, number> = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 25 };

const eraOfLevel = (era: number) => Math.max(1, Math.min(5, Math.round(era)));
const levelIn = (level: number) => Math.max(1, Math.min(LEVELS_PER_ERA, Math.round(level)));

/** What one level of one era asks for. */
export function cityLevelSpec(level: number, era = 1): CityLevel {
  const e = eraOfLevel(era), l = levelIn(level);
  return {
    level: l,
    people: between(SIZE[e].people, l),
    buildings: between(SIZE[e].buildings, l),
    works: Math.round(WORKS[l - 1] * WORKS_ERA[e] / 500) * 500,
  };
}

/** An era's whole table, for the wiki and the guide. */
export const cityLevels = (era = 1): CityLevel[] =>
  Array.from({ length: LEVELS_PER_ERA }, (_, i) => cityLevelSpec(i + 1, era));

/**
 * How far below a level's size the city may fall and still be counted at it.
 *
 * A level is earned by size and paid for in Gold, and it is not kept once the
 * city that earned it is gone — otherwise a player could buy the top level and
 * walk away from the town. But "gone" has to mean a decline, not a bad winter:
 * with rungs three or four people apart, an exact reading took a paid-for
 * level away over a single death and handed it back a week later, over and
 * over. Gaining a level asks for the whole size; holding one asks for most of
 * it.
 */
export const LEVEL_HOLD = 0.85;

/**
 * The highest level of this era a settlement of this size has earned by size
 * alone. `hold` relaxes the bar to what it takes to keep a level rather than
 * to reach it.
 */
export function levelForSize(people: number, buildings: number, era = 1, hold = false): number {
  const bar = hold ? LEVEL_HOLD : 1;
  let level = 1;
  for (const row of cityLevels(era)) {
    if (people >= row.people * bar && buildings >= row.buildings * bar) level = row.level;
  }
  return level;
}

/** Where a plot stands on the whole fifty-rung ladder. */
export const ladderRung = (level: number, era: number) => (eraOfLevel(era) - 1) * LEVELS_PER_ERA + levelIn(level);

/**
 * What a plot can earn in a real day, from where it stands on the ladder.
 *
 * One straight line from the bottom rung to the top, so every level is worth
 * the same step up and no era boundary is a cliff in either direction. The era
 * is in the rung rather than a multiplier on top of it, which is what stops a
 * reset to level one from being a pay cut.
 */
export const PLOT_CEILING_MIN = 40_000;
/** The last rung: a level-ten city in the AI era, and the most any plot can earn. */
export const PLOT_CEILING_MAX = 250_000;
export function plotCeiling(level: number, era: number): number {
  const rung = ladderRung(level, era);
  return Math.round(PLOT_CEILING_MIN + (PLOT_CEILING_MAX - PLOT_CEILING_MIN) * ((rung - 1) / (LADDER_RUNGS - 1)));
}

/**
 * How much Gold a settlement may hold, by where it stands on the ladder.
 *
 * A town's treasury has a top. It is shown beside the Gold itself — 512,400 of
 * 1,200,000 — and it climbs with every level and every age, so the answer to
 * "how much can I keep?" is a number on the screen rather than something to be
 * inferred.
 *
 * This replaces the carrying cost on idle Gold that 2.9 introduced. Both exist
 * to stop a player sitting on a hoard so large that Gold stops being a
 * decision, and the carrying cost did work — but it worked invisibly, as a
 * daily subtraction a player had to go looking for in the Bank to understand.
 * A ceiling you can see does the same job and can be read at a glance, which
 * was the whole of the complaint. Only one of the two should exist, so the
 * carrying cost is gone.
 *
 * What it costs to hit the ceiling is the income the town turns away, not Gold
 * taken off it: nothing a player has earned is ever removed. A full treasury
 * is a town telling you to spend, and spending is what the ladder's public
 * works are for.
 *
 * The floor of every era is comfortably above what that era's public works
 * cost — the AI era's tenth level is 450,000 Gold and the smallest AI-era
 * treasury holds several times that — so the cap can never stand between a
 * player and the next rung.
 */
const TREASURY: Record<number, [number, number]> = {
  1: [60_000, 300_000],
  2: [320_000, 700_000],
  3: [740_000, 1_400_000],
  4: [1_460_000, 2_600_000],
  5: [2_700_000, 5_000_000],
};

export function treasuryCap(level: number, era: number): number {
  const [lo, hi] = TREASURY[eraOfLevel(era)];
  return Math.round(between([lo, hi], levelIn(level)) / 10_000) * 10_000;
}

/**
 * What a plot claimed before the fifty-rung ladder is guaranteed.
 *
 * The ladder redrew the middle of the curve. The top and the bottom are where
 * they were, but a plot that climbed levels without advancing an age sat higher
 * on the old ten-level table than the new one puts it — and the players in that
 * position are mostly there because two of the four age gates were impassable
 * until 2.9.2. They were stuck by a bug of ours; they are not going to be paid
 * less for it.
 *
 * So a plot claimed before the change is never judged below what the old system
 * would have paid it. That is computed rather than remembered, which is what
 * makes it trustworthy: the old level was a pure function of the settlement's
 * size, and the size is in the published world, so the old answer can be worked
 * out again at any time from the same evidence. Nothing had to be written down
 * at the moment of the change, and nothing can drift.
 *
 * It does not collapse when a grandfathered plot advances an age, because the
 * old level came from size rather than from a counter that now resets — the old
 * era multiplier applies on top, exactly as it used to, so advancing raises the
 * floor as well. A plot grows past its floor and stops needing it.
 */
export const LADDER_AT = 1_788_912_000_000;

/** The ten-level size table the game used before the ladder. */
const LEGACY_LEVELS: { level: number; people: number; buildings: number }[] = [
  { level: 1, people: 0, buildings: 0 },
  { level: 2, people: 12, buildings: 8 },
  { level: 3, people: 20, buildings: 14 },
  { level: 4, people: 30, buildings: 20 },
  { level: 5, people: 45, buildings: 28 },
  { level: 6, people: 60, buildings: 38 },
  { level: 7, people: 80, buildings: 50 },
  { level: 8, people: 105, buildings: 65 },
  { level: 9, people: 130, buildings: 80 },
  { level: 10, people: 160, buildings: 100 },
];

/** The level the old table gave a settlement of this size. */
export function legacyLevelForSize(people: number, buildings: number): number {
  let level = 1;
  for (const row of LEGACY_LEVELS) if (people >= row.people && buildings >= row.buildings) level = row.level;
  return level;
}

/**
 * The old ceiling: ten levels from 40,000 to 156,250, times the era.
 *
 * Kept in full rather than described, so the floor is auditable against what
 * players were actually being paid rather than against a memory of it.
 */
export function legacyPlotCeiling(level: number, era: number): number {
  const l = Math.max(1, Math.min(10, Math.round(level)));
  const base = PLOT_CEILING_MIN + (156_250 - PLOT_CEILING_MIN) * ((l - 1) / 9);
  return Math.round(base * eraYield(era));
}

/** A charter: $EMERGE for a share more on the plot's ceiling, for a while. */
export const CHARTER_BONUS = 0.2;
export const CHARTER_DAYS = 30;
/**
 * A charter costs CHARTER_CEILING_DAYS of the plot's own ceiling, so it is
 * the same bargain at every level: thirty days of a fifth more, for four
 * days' worth. A flat price was break-even for a new plot and five to one
 * for a city.
 */
export const CHARTER_CEILING_DAYS = 4;
export const charterCost = (level: number, era: number) => CHARTER_CEILING_DAYS * plotCeiling(level, era);
/** What the step into an era costs: a million per step already taken. */
export const advanceCost = (targetEra: number) => Math.max(1, Math.round(targetEra) - 1) * 1_000_000;
/** Insurance: $EMERGE burned so trouble does half the damage, for a while. */
export const INSURANCE_DAYS = 30;
/** Master builders: $EMERGE burned so building and improving cost less Gold, for a while. */
export const BUILDERS_DAYS = 30;
export const BUILDERS_DISCOUNT = 0.25;
export const charterMultiplier = (charterUntil: number | undefined, now = Date.now()) => (charterUntil && charterUntil > now ? 1 + CHARTER_BONUS : 1);

/** The city level each era asks for, on top of its own checklist. */
/**
 * The level a plot must reach to leave its era: the top of that era's ladder,
 * every time. It used to be 3, 5, 7 and 9 of one ten-level table spanning the
 * whole game, which meant an era could be left half-climbed and the level
 * number said nothing about the age it was in.
 */
export const ERA_CITY_LEVEL: Record<number, number> = { 2: 10, 3: 10, 4: 10, 5: 10 };

/** How far the game has been built. Eras past this are described, not reachable. */
export const OPEN_ERA: EraId = 5;

export const eraSpec = (id: number): EraSpec => ERAS[Math.max(1, Math.min(ERAS.length, Math.round(id))) - 1];
export const eraName = (id: number) => eraSpec(id).name;
export const nextEra = (id: number): EraSpec | null => (id < ERAS.length ? ERAS[id] : null);

/**
 * The animals that live on a plot.
 *
 * A wood with nothing moving in it is scenery. This is what the hunters are
 * hunting: real animals with positions, that graze and browse and bolt from
 * anybody who walks too close, and that come back over the days after they
 * are taken. Which animals depends on the land — deer and boar under the
 * trees, goats on the shelf, gazelle on the dunes, a gator in the swamp.
 *
 * This module imports nothing but the biome list, so the simulation and the
 * renderer both read the same table without a cycle.
 */

import type { BiomeKind } from './biomes';

export type AnimalKind = 'deer' | 'boar' | 'hare' | 'goat' | 'elk' | 'antelope' | 'gazelle' | 'duck' | 'gator' | 'fox';
export type AnimalState = 'grazing' | 'moving' | 'fleeing' | 'down';

export interface Animal {
  id: string;
  kind: AnimalKind;
  x: number;
  y: number;
  /** Where it lives; it browses within a few units of here. */
  homeX: number;
  homeY: number;
  destX: number;
  destY: number;
  state: AnimalState;
  /** Hours left grazing, or hours a downed animal stays on the ground. */
  timer: number;
  /** 1 faces east on screen, -1 west. */
  facing: 1 | -1;
  /** The hunter closing on it. A stalked animal has not noticed yet, and holds still. */
  stalkedBy?: string;
}

export const ANIMAL_KINDS: AnimalKind[] = ['deer', 'boar', 'hare', 'goat', 'elk', 'antelope', 'gazelle', 'duck', 'gator', 'fox'];

export const ANIMAL_LABELS: Record<AnimalKind, string> = {
  deer: 'deer', boar: 'boar', hare: 'hare', goat: 'goat', elk: 'elk',
  antelope: 'antelope', gazelle: 'gazelle', duck: 'duck', gator: 'gator', fox: 'fox',
};

/** What each land carries, commonest first. Repeats weight the draw. */
export const WILDLIFE: Record<BiomeKind, AnimalKind[]> = {
  valley: ['deer', 'deer', 'boar', 'hare', 'fox'],
  woodland: ['deer', 'deer', 'boar', 'boar', 'fox', 'hare'],
  highland: ['goat', 'goat', 'elk', 'hare', 'fox'],
  wetland: ['duck', 'duck', 'deer', 'boar', 'hare'],
  steppe: ['antelope', 'antelope', 'hare', 'hare', 'fox'],
  coast: ['deer', 'hare', 'duck', 'duck', 'fox'],
  desert: ['gazelle', 'gazelle', 'hare', 'fox'],
  swamp: ['boar', 'boar', 'gator', 'duck', 'deer'],
  grassland: ['deer', 'hare', 'hare', 'antelope', 'fox'],
};

/** How many animals the land holds at most. Hunting below this is what thins the herd. */
export const HERD_CAP: Record<BiomeKind, number> = {
  valley: 10, woodland: 12, highland: 8, wetland: 9, steppe: 10, coast: 7, desert: 5, swamp: 9, grassland: 10,
};

/** What one animal brings back, before skill. */
export const ANIMAL_YIELD: Record<AnimalKind, { game: number; hides: number }> = {
  deer: { game: 3, hides: 1.2 },
  boar: { game: 3.5, hides: 0.8 },
  hare: { game: 0.8, hides: 0.3 },
  goat: { game: 2.2, hides: 1 },
  elk: { game: 4.5, hides: 1.6 },
  antelope: { game: 2.6, hides: 1 },
  gazelle: { game: 2, hides: 0.8 },
  duck: { game: 0.6, hides: 0 },
  gator: { game: 3, hides: 2.2 },
  fox: { game: 0.5, hides: 1.4 },
};

/** World units per game hour, browsing and bolting. */
export const ANIMAL_PACE: Record<AnimalKind, { graze: number; flee: number }> = {
  deer: { graze: 5, flee: 16 },
  boar: { graze: 4, flee: 12 },
  hare: { graze: 6, flee: 18 },
  goat: { graze: 4, flee: 11 },
  elk: { graze: 4.5, flee: 14 },
  antelope: { graze: 6, flee: 20 },
  gazelle: { graze: 6, flee: 20 },
  duck: { graze: 3, flee: 10 },
  gator: { graze: 2, flee: 7 },
  fox: { graze: 5, flee: 15 },
};

/** How close a person may come before an animal bolts. */
export const FLEE_RANGE = 3.4;
/** How close a hunter has to get to take the animal. */
export const HUNT_REACH = 3.2;
/** How far from the lodge a hunter will go after something. */
export const HUNT_RANGE = 48;
/** Water birds keep to the bank; everything else keeps clear of it. */
export const WATERSIDE: AnimalKind[] = ['duck', 'gator'];

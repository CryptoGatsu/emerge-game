/**
 * The dig.
 *
 * A player spends $EMERGE — burned, like every other cost in this game — and
 * hires a prospecting party for a day. What they come back with is drawn from a
 * table with published odds, and everything on that table is something the
 * settlement can actually use: Gold for the treasury, timber and stone for the
 * yard, naming rights, or people.
 *
 * Two rules make this a game mechanic rather than a slot machine.
 *
 * **Nothing is a blank.** The worst outcome on the table still pays something.
 * A pull that gives a player nothing at all in exchange for burning tokens is
 * the kind of thing that reads as a con, and it would be one.
 *
 * **The odds are printed on the panel.** Every weight in `PRIZES` is shown to
 * the player before they spend anything, as a real percentage computed from
 * this table rather than a number written separately in the interface and
 * hoped to match.
 */

import type { Resource } from '../simulation';

/** What a pull costs, and burns. */
export const DIG_COST_EMERGE = 80_000;

export type PrizeKind = 'gold' | 'resource' | 'naming' | 'settlers';

export interface Prize {
  id: string;
  kind: PrizeKind;
  /** What the player sees when they win it. */
  label: string;
  /** Relative likelihood. Percentages on the panel are computed from these. */
  weight: number;
  /** Gold into the treasury. */
  gold?: number;
  /** Materials into the yard. */
  resource?: { key: Resource; amount: number };
  /** Naming rights, each good for one citizen rename. */
  naming?: number;
  /** People who walk in looking for work. */
  settlers?: number;
}

/**
 * The table.
 *
 * Weighted so that the common outcomes are the useful-but-modest ones a
 * settlement gets through in a day, and the rare one is people — because
 * people are the thing a player cannot otherwise buy at any price, and a plot
 * grows by attracting them rather than by purchasing them.
 */
export const PRIZES: Prize[] = [
  { id: 'gold-small', kind: 'gold', label: '120 Gold', weight: 26, gold: 120 },
  { id: 'gold-mid', kind: 'gold', label: '400 Gold', weight: 13, gold: 400 },
  { id: 'gold-big', kind: 'gold', label: '1,200 Gold', weight: 3, gold: 1200 },
  { id: 'wood', kind: 'resource', label: '40 timber', weight: 18, resource: { key: 'wood', amount: 40 } },
  { id: 'stone', kind: 'resource', label: '30 stone', weight: 14, resource: { key: 'stone', amount: 30 } },
  { id: 'ore', kind: 'resource', label: '20 iron ore', weight: 8, resource: { key: 'ironOre', amount: 20 } },
  { id: 'grain', kind: 'resource', label: '60 wheat', weight: 8, resource: { key: 'wheat', amount: 60 } },
  { id: 'naming', kind: 'naming', label: 'Naming rights', weight: 6, naming: 1 },
  { id: 'settler', kind: 'settlers', label: 'A settler joins you', weight: 3, settlers: 1 },
  { id: 'family', kind: 'settlers', label: 'A family of three arrives', weight: 1, settlers: 3 },
];

const TOTAL_WEIGHT = PRIZES.reduce((sum, p) => sum + p.weight, 0);

/** The odds, as the panel prints them. Derived from the table, never restated. */
export function odds() {
  return PRIZES.map((prize) => ({
    ...prize,
    percent: (prize.weight / TOTAL_WEIGHT) * 100,
  })).sort((a, b) => b.weight - a.weight);
}

/**
 * Draw a prize.
 *
 * `roll` is injected so a test can pin the outcome; play passes nothing and
 * gets `Math.random`.
 */
export function drawPrize(roll: () => number = Math.random): Prize {
  let ticket = roll() * TOTAL_WEIGHT;
  for (const prize of PRIZES) {
    ticket -= prize.weight;
    if (ticket <= 0) return prize;
  }
  // Floating point can leave a hair of the range unclaimed; the last row is as
  // good an answer as any and better than undefined.
  return PRIZES[PRIZES.length - 1];
}

/** A sentence describing what came back, for the feed and the panel. */
export function prizeStory(prize: Prize) {
  switch (prize.kind) {
    case 'gold':
      return `The party came back with ${prize.gold?.toLocaleString()} Gold.`;
    case 'resource':
      return `The party came back with ${prize.label}.`;
    case 'naming':
      return 'The party came back with naming rights — one citizen, renamed free.';
    default:
      return prize.settlers === 1
        ? 'Somebody walked back with the party, looking for work.'
        : `${prize.settlers} people walked back with the party, looking for work.`;
  }
}

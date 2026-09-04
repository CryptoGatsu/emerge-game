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

/** How far the game has been built. Eras past this are described, not reachable. */
export const OPEN_ERA: EraId = 5;

export const eraSpec = (id: number): EraSpec => ERAS[Math.max(1, Math.min(ERAS.length, Math.round(id))) - 1];
export const eraName = (id: number) => eraSpec(id).name;
export const nextEra = (id: number): EraSpec | null => (id < ERAS.length ? ERAS[id] : null);

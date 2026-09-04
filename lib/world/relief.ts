/**
 * Relief.
 *
 * The elevation field, kept apart from the terrain generator because two other
 * things need it: the settlement planner, since a highland town wants to sit on
 * the lip of the shelf and cannot know where that is without asking the same
 * function the renderer will later draw; and the water field, since a river
 * does not run along the top of a plateau — it falls off the edge of one.
 */

import { fbm } from './noise';

export { fbm };

/**
 * Height at a world position, 0 to 1. A shelf rising toward the north-east that
 * the mine road climbs, dissolved into noise at its edge so the lip is ragged
 * rather than a drawn line. Biomes with no plateau are flat everywhere.
 */
export function heightField(seed: number, wx: number, wy: number, plateau: number) {
  if (plateau <= 0) return 0;
  const ridge = ((wx - 70) * 0.06 + (34 - wy) * 0.045) * plateau;
  const noise = (fbm(seed + 4001, wx * 0.05, wy * 0.05, 3) - 0.5) * 0.7;
  return Math.max(0, Math.min(1, ridge + noise));
}

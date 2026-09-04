/**
 * Where the wood is.
 *
 * The terrain decides which tiles are forest from one noise field, and this
 * is that decision on its own, so the simulation can ask the same question
 * without drawing the map: the animals keep to open ground and the wood's
 * edge, where they can be seen, rather than spawning under a canopy that
 * hides them from the player and the hunter alike.
 */

import { fbm } from './noise';
import type { BiomeProfile } from './biomes';

/** True where the land is wooded, by the same rule that paints forest tiles. */
export function woodedAt(seed: number, profile: BiomeProfile, core: { x: number; y: number }, wx: number, wy: number): boolean {
  const forest = fbm(seed + 1300, wx * 0.045, wy * 0.045, 4);
  const fromCore = Math.min(Math.hypot(wx - core.x, wy - core.y), 34) / 60;
  return forest + fromCore * 0.28 + profile.forest > 0.62;
}

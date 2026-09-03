/**
 * Making good on a bug.
 *
 * A settlement's market bought bread every day in towns that were sitting on a
 * wheat surplus, because it read an empty bread shelf rather than a full
 * larder. It cost about sixty Gold a day against eighty-eight of income, so
 * treasuries sat at nothing and Gold players deposited was absorbed within
 * days. The cause is fixed; this is the apology.
 *
 * Applied once per settlement and remembered *on the settlement*, so it
 * travels with the save. The first cut remembered it in the browser instead,
 * and a player who opened the same plot on their phone was handed it again
 * on a day-one world — and lost their real settlement into the bargain, but
 * that is `EmergeClient`'s story. The old browser marker is still read, once,
 * so a world that had the grant before it was written down does not get it
 * twice on the same device either.
 *
 * Gold cannot leave a world — what the vault will pay out is capped by what
 * the chain says was deposited — so this cannot become tokens. It buys back
 * the buildings and wages the bug ate.
 */

import type { World } from '../simulation';
import { clientKey } from '../limits';

/** The grant, and the name it is remembered under. */
export const GOODWILL = {
  id: 'import-drain-v1.1',
  gold: 1500,
  reason: 'Compensation for the market buying bread it did not need.',
} as const;

const LEGACY_KEY = clientKey(`grant.${GOODWILL.id}`);

/** Which settlements this browser handed the grant to before it was kept on the world. */
function legacyGranted(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

/** True once this world has had the grant, whichever device gave it. */
export const hasGoodwill = (world: World) => (world.grants ?? []).includes(GOODWILL.id);

/** Write it down without paying it: for a world that arrived already made good. */
export function markGoodwill(world: World): void {
  if (!Array.isArray(world.grants)) world.grants = [];
  if (!world.grants.includes(GOODWILL.id)) world.grants.push(GOODWILL.id);
}

/**
 * Has this settlement had the grant? If not, mark it as having it now.
 *
 * The marker is written *before* the Gold is added, deliberately: a browser
 * that dies between the two loses the grant, which is a far better failure
 * than one that hands it out on every reload.
 */
export function claimGoodwill(world: World): number {
  if (hasGoodwill(world)) return 0;
  // Granted by this browser before the world carried the record: write it
  // down and pay nothing.
  if (legacyGranted().has(world.seed)) { markGoodwill(world); return 0; }
  markGoodwill(world);
  return GOODWILL.gold;
}

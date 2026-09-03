/**
 * Making good on a bug.
 *
 * A settlement's market bought bread every day in towns that were sitting on a
 * wheat surplus, because it read an empty bread shelf rather than a full
 * larder. It cost about sixty Gold a day against eighty-eight of income, so
 * treasuries sat at nothing and Gold players deposited was absorbed within
 * days. The cause is fixed; this is the apology.
 *
 * Applied once per settlement, marked in this browser, and deliberately
 * modest: it is meant to undo a few days of a bug rather than to be a
 * windfall. Gold cannot leave a world — what the vault will pay out is capped
 * by what the chain says was deposited — so this cannot become tokens. It
 * buys back the buildings and wages the bug ate.
 */

import { clientKey } from '../limits';

/** The grant, and the name it is remembered under. */
export const GOODWILL = {
  id: 'import-drain-v1.1',
  gold: 1500,
  reason: 'Compensation for the market buying bread it did not need.',
} as const;

const KEY = clientKey(`grant.${GOODWILL.id}`);

/** Which settlements have already had it. */
function granted(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

function remember(seed: number, held: Set<number>): void {
  held.add(seed);
  try {
    // Bounded: a browser that has visited a great many worlds should not carry
    // an unbounded list around for ever.
    window.localStorage.setItem(KEY, JSON.stringify([...held].slice(-200)));
  } catch {
    // No storage. The grant is not repeated within this session either way,
    // because the caller only asks once per world it opens.
  }
}

/**
 * Has this settlement had the grant? If not, mark it as having it now.
 *
 * The marker is written *before* the Gold is added, deliberately: a browser
 * that dies between the two loses the grant, which is a far better failure
 * than one that hands it out on every reload.
 */
export function claimGoodwill(seed: number): number {
  if (!Number.isInteger(seed) || seed <= 0) return 0;
  const held = granted();
  if (held.has(seed)) return 0;
  remember(seed, held);
  return GOODWILL.gold;
}

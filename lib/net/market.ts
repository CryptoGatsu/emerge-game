/**
 * The client half of the world market.
 *
 * One call does both halves of the exchange: it tells the server what this
 * settlement has in store and reads back the prices every settlement is
 * trading at. Reporting and reading in one round trip is not a shortcut — it
 * is what makes the two consistent, since the prices that come back are the
 * ones the reading has just been folded into.
 *
 * Like everything in `lib/net`, it answers rather than throwing. A world whose
 * market is unreachable keeps running and prices its own stores, exactly as it
 * did before there was a shared market; the panel says which one is happening.
 */

import type { Resource } from '@/lib/world/goods';

export interface WorldPrices {
  /** Which fixing `prices` belongs to. */
  epoch: number;
  /** How long a fixing stands, in milliseconds. */
  epochMs: number;
  /** What everything costs during that fixing. */
  prices: Record<Resource, number>;
  /** What everything costs during the fixing after it. */
  next: Record<Resource, number>;
  /**
   * How far this browser's clock is ahead of the server's, in milliseconds.
   *
   * Computed at receipt rather than sent. It is what lets every client change
   * over to the next fixing at the same instant — which is the whole reason a
   * price is the same everywhere instead of nearly the same.
   */
  skew: number;
  /** How many settlements were read into it. */
  traders: number;
  /** True when this is the shared index rather than one instance's own. */
  shared: boolean;
}

/** Read one answer from the market endpoint, or nothing we can use. */
function received(json: Record<string, unknown>): WorldPrices | null {
  const prices = json.prices as Record<Resource, number> | undefined;
  const epoch = Number(json.epoch);
  const epochMs = Number(json.epochMs);
  if (json.offline || !prices || !Number.isFinite(epoch) || !(epochMs > 0)) return null;
  const serverNow = Number(json.now);
  return {
    epoch,
    epochMs,
    prices,
    // A server that did not send the next fixing is answered by standing still
    // at the current one, which is right: better a price that holds than one
    // guessed at.
    next: (json.next as Record<Resource, number> | undefined) ?? prices,
    skew: Number.isFinite(serverNow) ? Date.now() - serverNow : 0,
    traders: Math.max(0, Math.round(Number(json.traders) || 0)),
    shared: json.shared === true,
  };
}

/**
 * Report this settlement's stores and read the world's prices.
 *
 * `stocks` is sent as it stands. The server converts it into a position on its
 * own scale and clamps it before counting it, so nothing here needs to round or
 * normalise, and nothing the client sends can be a bigger vote than anyone
 * else's.
 */
export async function syncMarket(
  seed: number,
  stocks: Partial<Record<Resource, number>>,
): Promise<WorldPrices | null> {
  try {
    const response = await fetch('/api/market', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, stocks }),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return received((await response.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** The prices alone, for a screen with no settlement behind it. */
export async function fetchMarket(): Promise<WorldPrices | null> {
  try {
    const response = await fetch('/api/market', { cache: 'no-store' });
    if (!response.ok) return null;
    return received((await response.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

import 'server-only';

/**
 * The land for sale, in one list.
 *
 * Players could put a plot up for sale and make offers on one since 1.2, but
 * finding what was for sale meant walking twenty-one charts looking for the
 * tag. This is every listed plot with what a buyer wants to know before
 * walking over: the asking price and the offers against it, the age, and
 * the level, stewardship, people and buildings the server read off the copy
 * when the owner last published it. Nothing here is the seller's word.
 *
 * Built from the claims and the headline index, no snapshot read, and kept a
 * minute: a listing changes when somebody lists, buys or offers, and a
 * minute is the most anybody waits to see it.
 */

import { biomeFor } from '../world/biomes';
import { getValue, setValue } from './kv';
import { serverKey } from '../limits';
import { allClaims, worldHeadlines } from './registry';

export interface LandListing {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  /** The asking price, in whole $EMERGE. */
  price: number;
  listedAt: number;
  /** Offers standing against it, and the best of them. */
  offers: number;
  bestOffer: number | null;
  era: number;
  expanded: boolean;
  banner: string | null;
  biome: string;
  /** Read off the last published copy; null when the owner has never published. */
  level: number | null;
  score: number | null;
  population: number | null;
  buildings: number | null;
  day: number | null;
  publishedAt: number | null;
  charter: boolean;
  insured: boolean;
}

export interface LandMarket {
  rows: LandListing[];
  total: number;
  at: number;
}

const KEY = serverKey('land-market');
const KEEP_SECONDS = 60;

/**
 * Forget the board, so the next read rebuilds it.
 *
 * The cache exists because the board is assembled from every claim and every
 * headline, which is not a thing to do on every page view. A minute of lag is
 * fine for a board nobody is watching — and wrong the moment the page exists
 * to tell people what land costs, because a plot that has just sold would go
 * on being advertised at its asking price. Anything that lists, delists or
 * moves a plot drops the board rather than waiting the minute out.
 */
export async function forgetLandMarket(): Promise<void> {
  await setValue(KEY, '', 1).catch(() => { /* the board rebuilds on its own clock anyway */ });
}

export async function landMarket(fresh = false): Promise<LandMarket> {
  if (!fresh) {
    const held = await getValue(KEY);
    if (held) { try { return JSON.parse(held) as LandMarket; } catch { /* rebuilt below */ } }
  }
  const [claims, heads] = await Promise.all([allClaims(), worldHeadlines()]);
  const headOf = new Map(heads.map((h) => [h.seed, h]));
  const now = Date.now();
  const rows: LandListing[] = claims
    .filter((c) => typeof c.forSale === 'number' && c.forSale > 0)
    .map((c) => {
      const head = headOf.get(c.seed);
      const offers = (c.offers ?? []).filter((o) => o.price > 0);
      return {
        seed: c.seed, region: c.region, worldName: c.worldName, owner: c.owner, ownerName: c.ownerName,
        price: c.forSale as number, listedAt: c.listedAt ?? c.at,
        offers: offers.length, bestOffer: offers.length ? Math.max(...offers.map((o) => o.price)) : null,
        era: c.era ?? 1, expanded: !!c.expandedAt, banner: c.banner ?? null,
        biome: biomeFor(c.seed).label,
        level: head?.level ?? null, score: head?.score ?? null, population: head?.population ?? null,
        buildings: head?.buildings ?? null, day: head?.day ?? null, publishedAt: head?.at ?? null,
        charter: (c.charterUntil ?? 0) > now, insured: (c.insuredUntil ?? 0) > now,
      };
    })
    .sort((a, b) => a.price - b.price || b.listedAt - a.listedAt);
  const board: LandMarket = { rows, total: rows.length, at: now };
  await setValue(KEY, JSON.stringify(board), KEEP_SECONDS).catch(() => {});
  return board;
}

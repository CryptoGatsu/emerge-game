import 'server-only';

/**
 * Every plot there is, for the land marketplace.
 *
 * `landMarket` answers "what is for sale", which is the board the game has
 * always shown. A marketplace needs the other question too — "what exists,
 * and who holds it" — because a plot nobody has listed is still a thing a
 * buyer wants to look at, follow and make an offer on elsewhere. So this is
 * the same join, unfiltered: every claimed plot, with its settlement's
 * headline, its holder, and its asking price when it has one.
 *
 * The price is the chain's, never the row's. A row can say what it likes;
 * the market contract is what will actually take somebody's money.
 */

import { biomeKindFor, biomeProfile } from '../world/biomes';
import { serverKey } from '../limits';
import { getValue, setValue } from './kv';
import { allClaims, worldHeadlines } from './registry';
import { marketBoard, nftLive } from './nft';

export interface CataloguePlot {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  /** The asking price in whole $EMERGE, or null when it is not for sale. */
  price: number | null;
  listedAt: number | null;
  claimedAt: number;
  era: number;
  expanded: boolean;
  banner: string | null;
  biome: string;
  level: number | null;
  population: number | null;
  buildings: number | null;
  day: number | null;
  publishedAt: number | null;
}

export interface LandCatalogue {
  plots: CataloguePlot[];
  total: number;
  listed: number;
  /** The cheapest asking price on the board, or null when nothing is listed. */
  floor: number | null;
  holders: number;
  at: number;
}

const KEY = serverKey('land-catalogue');
const KEEP_SECONDS = 60;

/** Forget the catalogue, so the next read rebuilds it. Called wherever a plot moves or is listed. */
export async function forgetLandCatalogue(): Promise<void> {
  await setValue(KEY, '', 1).catch(() => { /* it rebuilds on its own clock anyway */ });
}

export async function landCatalogue(fresh = false): Promise<LandCatalogue> {
  if (!fresh) {
    const held = await getValue(KEY);
    if (held) { try { return JSON.parse(held) as LandCatalogue; } catch { /* rebuilt below */ } }
  }
  const [claims, heads] = await Promise.all([allClaims(), worldHeadlines()]);
  const headOf = new Map(heads.map((h) => [h.seed, h]));
  // Only a listing the contract would honour counts: the seller still holds
  // the plot and the market may still move it.
  const onChain = nftLive()
    ? new Map((await marketBoard().catch(() => [])).filter((l) => l.live).map((l) => [l.seed, l]))
    : null;
  const plots: CataloguePlot[] = claims.map((c) => {
    const head = headOf.get(c.seed);
    const listing = onChain?.get(c.seed);
    const live = listing && listing.seller === c.owner.toLowerCase() ? listing : null;
    const price = onChain ? (live ? live.price : null) : (typeof c.forSale === 'number' && c.forSale > 0 ? c.forSale : null);
    return {
      seed: c.seed,
      region: c.region,
      worldName: c.worldName,
      owner: c.owner.toLowerCase(),
      ownerName: c.ownerName,
      price,
      listedAt: price === null ? null : c.listedAt ?? c.at,
      claimedAt: c.at,
      era: c.era ?? 1,
      expanded: !!c.expandedAt,
      banner: c.banner ?? null,
      biome: biomeProfile(biomeKindFor(c.seed)).label,
      level: head?.level ?? null,
      population: head?.population ?? null,
      buildings: head?.buildings ?? null,
      day: head?.day ?? null,
      publishedAt: head?.at ?? null,
    };
  });
  const asking = plots.map((p) => p.price).filter((p): p is number => p !== null);
  const out: LandCatalogue = {
    plots: plots.sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || (b.population ?? 0) - (a.population ?? 0) || a.seed - b.seed),
    total: plots.length,
    listed: asking.length,
    floor: asking.length ? Math.min(...asking) : null,
    holders: new Set(plots.map((p) => p.owner)).size,
    at: Date.now(),
  };
  await setValue(KEY, JSON.stringify(out), KEEP_SECONDS).catch(() => {});
  return out;
}

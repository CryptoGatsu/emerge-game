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
 * A price is never the row's own. The game's market contract is one source
 * and OpenSea is the other, and a plot can be listed on both at once for
 * different money — so a plot carries its listings rather than a price, each
 * saying where it lives and what it is priced in.
 */

import { TOKEN } from '../chain/emerge';
import { biomeKindFor, biomeProfile } from '../world/biomes';
import { serverKey } from '../limits';
import { getValue, setValue } from './kv';
import { allClaims, worldHeadlines } from './registry';
import { marketBoard, nftLive } from './nft';
import { openSeaConfigured, openSeaListings } from './openSea';

export interface PlotListing {
  /** `market` is the game's own contract, priced in $EMERGE; `opensea` is OpenSea, priced in whatever it took. */
  where: 'market' | 'opensea';
  price: number;
  currency: string;
  at: number;
}

export interface CataloguePlot {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  /** Everywhere this plot is listed. Empty when it is not for sale. */
  listings: PlotListing[];
  /** The cheapest listing's figures, for sorting and for the card's headline. */
  price: number | null;
  currency: string | null;
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
  /** How many are listed where; a plot on both is counted in both. */
  listedBy: { market: number; opensea: number };
  /** The cheapest asking price per currency: one number across currencies would mean nothing. */
  floors: { currency: string; price: number }[];
  holders: number;
  /** False when OpenSea could not be read, so the page can say the board is only half the story. */
  openSeaRead: boolean;
  at: number;
}

const TICKER = TOKEN.ticker;

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
  // OpenSea is asked in parallel with nothing depending on it: a marketplace
  // we do not run being slow or down is not a reason for this page to be.
  const fromOpenSea = await openSeaListings().catch(() => []);
  const openSeaOf = new Map(fromOpenSea.map((l) => [l.seed, l]));
  const plots: CataloguePlot[] = claims.map((c) => {
    const head = headOf.get(c.seed);
    const listing = onChain?.get(c.seed);
    const live = listing && listing.seller === c.owner.toLowerCase() ? listing : null;
    const inGame = onChain ? (live ? live.price : null) : (typeof c.forSale === 'number' && c.forSale > 0 ? c.forSale : null);
    const listings: PlotListing[] = [];
    if (inGame !== null) listings.push({ where: 'market', price: inGame, currency: TICKER, at: c.listedAt ?? c.at });
    const os = openSeaOf.get(c.seed);
    // Only if its holder is the one selling: a listing left behind by whoever
    // held the plot last is not an offer anybody can take.
    if (os) listings.push({ where: 'opensea', price: os.price, currency: os.currency, at: os.at || c.at });
    listings.sort((a, b) => a.price - b.price);
    const first = listings[0] ?? null;
    return {
      seed: c.seed,
      region: c.region,
      worldName: c.worldName,
      owner: c.owner.toLowerCase(),
      ownerName: c.ownerName,
      listings,
      price: first ? first.price : null,
      currency: first ? first.currency : null,
      listedAt: first ? first.at : null,
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
  const cheapest = new Map<string, number>();
  for (const p of plots) {
    for (const l of p.listings) {
      const standing = cheapest.get(l.currency);
      if (standing === undefined || l.price < standing) cheapest.set(l.currency, l.price);
    }
  }
  const out: LandCatalogue = {
    plots: plots.sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || (b.population ?? 0) - (a.population ?? 0) || a.seed - b.seed),
    total: plots.length,
    listed: plots.filter((p) => p.listings.length > 0).length,
    listedBy: {
      market: plots.filter((p) => p.listings.some((l) => l.where === 'market')).length,
      opensea: plots.filter((p) => p.listings.some((l) => l.where === 'opensea')).length,
    },
    floors: [...cheapest.entries()].map(([currency, price]) => ({ currency, price })).sort((a, b) => a.currency.localeCompare(b.currency)),
    holders: new Set(plots.map((p) => p.owner)).size,
    openSeaRead: openSeaConfigured(),
    at: Date.now(),
  };
  await setValue(KEY, JSON.stringify(out), KEEP_SECONDS).catch(() => {});
  return out;
}

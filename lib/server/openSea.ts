import 'server-only';

/**
 * What the plots are listed for on OpenSea.
 *
 * Most land will change hands there rather than on the game's own market,
 * because that is where the buyers are and because OpenSea prices in USDG,
 * which is what this chain's marketplaces list in. A land page that only knew
 * the in-game market would show a board of a dozen plots while a hundred sat
 * for sale a click away, and would quote every price in the one currency
 * nobody was actually being asked to pay.
 *
 * So the listings are read from OpenSea and carried alongside the contract's
 * own, each labelled with where it lives and what it is priced in. Nothing
 * here is trusted for settlement: a price shown is a price to go and check,
 * and buying on OpenSea happens on OpenSea. The chain remains the only word
 * on who holds a plot.
 *
 * Needs a key, because OpenSea's listing endpoints do:
 *
 *   OPENSEA_API_KEY       from opensea.io/account/settings; without it this
 *                         returns nothing and the page shows the in-game
 *                         market alone
 *   OPENSEA_COLLECTION    the collection's slug, from its OpenSea URL
 *   OPENSEA_LISTINGS_URL  optional: the endpoint, with {slug} and {chain}
 *                         filled in. Overridable so a deployment can point at
 *                         a different version of their API without a release,
 *                         and so this can be tested against a stub.
 */

import { serverKey } from '../limits';
import { OPENSEA_CHAIN } from '../chain/plots';
import { getValue, setValue } from './kv';

export interface OpenSeaListing {
  seed: number;
  /** The asking price in whole units of `currency`. */
  price: number;
  currency: string;
  /** When the listing was made, where OpenSea says. */
  at: number;
}

const CACHE = serverKey('opensea:listings');
const KEEP_SECONDS = 90;
const DEFAULT_URL = 'https://api.opensea.io/api/v2/listings/collection/{slug}/all?limit=100';

export const openSeaConfigured = () =>
  !!process.env.OPENSEA_API_KEY && !!process.env.OPENSEA_COLLECTION && !!OPENSEA_CHAIN;

async function readJson(url: string, key: string, ms = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'x-api-key': key },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a token id and a price out of one listing.
 *
 * Written to survive the shape moving: the id sits in the Seaport order's
 * offer and the price in a small object beside it, and either can be nested
 * a little differently than the last time somebody looked. A listing that
 * cannot be read is skipped rather than failing the page.
 */
function readListing(row: unknown): OpenSeaListing | null {
  if (!row || typeof row !== 'object') return null;
  const it = row as Record<string, unknown>;
  const protocol = (it.protocol_data as Record<string, unknown> | undefined)?.parameters as Record<string, unknown> | undefined;
  const offer = Array.isArray(protocol?.offer) ? (protocol!.offer as Record<string, unknown>[]) : [];
  const idText = offer.map((o) => o?.identifierOrCriteria).find((v) => typeof v === 'string' || typeof v === 'number');
  const seed = Number(idText);
  if (!Number.isInteger(seed) || seed <= 0) return null;

  const current = (it.price as Record<string, unknown> | undefined)?.current as Record<string, unknown> | undefined;
  const value = current?.value;
  const decimals = Number(current?.decimals);
  if (value === undefined || !Number.isInteger(decimals)) return null;
  let price: number;
  try {
    const raw = BigInt(String(value));
    // Kept exact down to six places, so a stablecoin's cents survive and an
    // eighteen-decimal price does not lose its integer part to a float.
    price = decimals <= 6 ? Number(raw) / 10 ** decimals : Number(raw / 10n ** BigInt(decimals - 6)) / 1e6;
  } catch {
    return null;
  }
  if (!Number.isFinite(price) || price < 0) return null;

  const currency = typeof current?.currency === 'string' ? current.currency : 'USDG';
  const started = Number(protocol?.startTime);
  return { seed, price, currency, at: Number.isInteger(started) ? started * 1000 : 0 };
}

/**
 * Every live listing on OpenSea, cheapest first per plot.
 *
 * Answers with an empty list rather than throwing: an outage at a
 * marketplace we do not run is not a reason for the land page to fail.
 */
export async function openSeaListings(): Promise<OpenSeaListing[]> {
  if (!openSeaConfigured()) return [];
  const held = await getValue(CACHE).catch(() => null);
  if (held) { try { return JSON.parse(held) as OpenSeaListing[]; } catch { /* re-read below */ } }
  const key = process.env.OPENSEA_API_KEY!;
  const template = process.env.OPENSEA_LISTINGS_URL ?? DEFAULT_URL;
  const base = template
    .replace('{slug}', encodeURIComponent(process.env.OPENSEA_COLLECTION!))
    .replace('{chain}', encodeURIComponent(OPENSEA_CHAIN!));
  const best = new Map<number, OpenSeaListing>();
  try {
    let url: string | null = base;
    // A few pages at most: a board is not worth a hundred round trips, and
    // the cheapest listings are what a buyer is looking at anyway.
    for (let page = 0; page < 5 && url; page++) {
      const body = (await readJson(url, key)) as Record<string, unknown>;
      const rows = Array.isArray(body?.listings) ? (body.listings as unknown[]) : [];
      for (const row of rows) {
        const listing = readListing(row);
        if (!listing) continue;
        const standing = best.get(listing.seed);
        if (!standing || listing.price < standing.price) best.set(listing.seed, listing);
      }
      const next = typeof body?.next === 'string' && body.next ? body.next : null;
      url = next ? `${base}${base.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}` : null;
    }
  } catch {
    // Keep whatever pages did come back; an empty answer is a quiet one.
  }
  const out = [...best.values()].sort((a, b) => a.price - b.price);
  await setValue(CACHE, JSON.stringify(out), KEEP_SECONDS).catch(() => {});
  return out;
}

/** Forget the listings, so the next read asks OpenSea again. */
export async function forgetOpenSea(): Promise<void> {
  await setValue(CACHE, '', 1).catch(() => {});
}

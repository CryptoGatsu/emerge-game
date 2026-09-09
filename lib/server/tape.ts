/**
 * The public tape: what has actually changed hands, across the whole game.
 *
 * The exchange already keeps a private history per wallet, which is the record
 * a player checks against their own trades. This is the other half — one
 * anonymous-of-address, public list of every fill and every plot sale, so that
 * anybody can see what things are really worth rather than only what they are
 * being asked for.
 *
 * Written names, not wallets. A seller's player name is already on every order
 * in the exchange and every plot on the land market, so putting it here shows
 * nothing that was private; the wallet address is not carried, because a public
 * ledger of one address's entire trading is a different thing from a market
 * tape and nobody asked for it.
 *
 * Advisory, exactly like the private history: the orders and the deliveries are
 * what the money moves on. A write that fails here must never fail a trade, so
 * every call is wrapped by its caller and the reader tolerates a gap.
 *
 * Two things worth knowing about what this can show. It starts empty — there is
 * no way to reconstruct trades that happened before it existed — so the history
 * on the page begins the day this ships and fills from there. And it is capped:
 * the tape holds the most recent fills and sales, not all of them for ever.
 */

import 'server-only';
import type { Resource } from '../world/goods';
import { serverKey } from '../limits';
import { hdel, hgetall, hset } from './kv';

/** One fill on the exchange, from the buyer's side. */
export interface TradeTick {
  id: string;
  at: number;
  kind: 'resource' | 'gold';
  resource?: Resource;
  /** Units of the good, or Gold in a Gold lot. */
  qty: number;
  /** Gold each for goods; $EMERGE each for Gold. */
  unitPrice: number;
  /** Gold burned on the trade. */
  burned: number;
  sellerName: string;
  buyerName: string;
}

/** One plot changing hands, at the price it went for. */
export interface LandSale {
  id: string;
  at: number;
  seed: number;
  region: string;
  worldName: string;
  /** In $EMERGE. */
  price: number;
  sellerName: string;
  buyerName: string;
  era: number;
  level: number | null;
}

/**
 * How much of each is kept.
 *
 * Enough to draw a week of a busy market and to price a plot against what
 * comparable ones went for, and small enough that the whole tape is one read.
 */
const TRADES_KEPT = 400;
const SALES_KEPT = 200;

const TRADES = serverKey('tape:trades');
const SALES = serverKey('tape:sales');

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Read one side of the tape, newest first, and drop what has aged out. */
async function read<T extends { id: string; at: number }>(key: string, kept: number): Promise<T[]> {
  const rows = await hgetall(key);
  const out: T[] = [];
  for (const raw of Object.values(rows)) { try { out.push(JSON.parse(raw) as T); } catch { /* a bad row is not the tape */ } }
  out.sort((a, b) => b.at - a.at);
  if (out.length > kept) {
    // Trimmed on read rather than on write: a trade must never wait on
    // housekeeping, and the reader is the one that knows what is spare.
    for (const spare of out.slice(kept)) await hdel(key, spare.id).catch(() => {});
    return out.slice(0, kept);
  }
  return out;
}

export const recentTrades = () => read<TradeTick>(TRADES, TRADES_KEPT);
export const recentSales = () => read<LandSale>(SALES, SALES_KEPT);

/** Write a fill onto the tape. Never throws: the trade already happened. */
export async function noteTrade(t: Omit<TradeTick, 'id'>): Promise<void> {
  const id = `x${stamp()}`;
  try { await hset(TRADES, id, JSON.stringify({ ...t, id })); } catch { /* the tape is advisory */ }
}

/** Write a plot sale onto the tape. Never throws: the plot already moved. */
export async function noteLandSale(s: Omit<LandSale, 'id'>): Promise<void> {
  const id = `l${stamp()}`;
  try { await hset(SALES, id, JSON.stringify({ ...s, id })); } catch { /* the tape is advisory */ }
}

/**
 * What a Gold is worth in $EMERGE.
 *
 * There is no oracle for this and there should not be one: Gold is a
 * settlement's own money and never becomes tokens by any route the vault
 * controls. What there is instead is a market — players selling Gold to each
 * other for $EMERGE, wallet to wallet — so the honest answer is what those
 * trades actually went for.
 *
 * Two figures, because they answer different questions. `traded` is the
 * volume-weighted average of the Gold lots that really filled in the window,
 * which is what a Gold has been worth. `asked` is the cheapest Gold standing
 * unsold on the exchange right now, which is what one would cost you today.
 * Where nothing has traded, `traded` is null rather than a guess.
 */
export interface GoldRate {
  /** $EMERGE per Gold, volume-weighted over the window. Null if nothing filled. */
  traded: number | null;
  /** $EMERGE per Gold, the cheapest lot standing. Null if none is up. */
  asked: number | null;
  /** Gold that changed hands in the window, and how many fills. */
  volume: number;
  fills: number;
  /** How far back `traded` looks, in hours. */
  windowHours: number;
}

export const GOLD_RATE_WINDOW_HOURS = 24 * 7;

export function goldRate(trades: TradeTick[], asks: number[], now = Date.now()): GoldRate {
  const since = now - GOLD_RATE_WINDOW_HOURS * 3_600_000;
  const fills = trades.filter((t) => t.kind === 'gold' && t.at >= since && t.qty > 0 && t.unitPrice > 0);
  const volume = fills.reduce((s, t) => s + t.qty, 0);
  const paid = fills.reduce((s, t) => s + t.qty * t.unitPrice, 0);
  const standing = asks.filter((p) => p > 0);
  return {
    traded: volume > 0 ? paid / volume : null,
    asked: standing.length ? Math.min(...standing) : null,
    volume,
    fills: fills.length,
    windowHours: GOLD_RATE_WINDOW_HOURS,
  };
}

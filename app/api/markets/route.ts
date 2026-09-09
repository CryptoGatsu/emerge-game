/**
 * Everything that has a price, in one open read.
 *
 * `GET /api/markets` — the world market's prices, the exchange's standing
 * orders and its recent fills, what a Gold is worth in $EMERGE, the plots for
 * sale and the plots that have sold.
 *
 * Open, with no wallet and no session: every figure here is already public
 * somewhere in the game, and the point of gathering them is that a player
 * should not have to hold land, or hold anything, to find out what things
 * cost before deciding to.
 *
 * It reads and never writes, so nothing a visitor does here can move a market.
 */

import { NextResponse } from 'next/server';
import { orders } from '@/lib/server/exchange';
import { landMarket } from '@/lib/server/landMarket';
import { readMarket } from '@/lib/server/market';
import { goldRate, recentSales, recentTrades } from '@/lib/server/tape';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [index, book, trades, sales, land] = await Promise.all([
      readMarket().catch(() => null),
      orders().catch(() => []),
      recentTrades().catch(() => []),
      recentSales().catch(() => []),
      landMarket().catch(() => ({ rows: [], total: 0, at: Date.now() })),
    ]);
    // The asks a Gold rate is read off: Gold lots still standing, priced in
    // $EMERGE each. A lot nobody has bought is an opinion, which is why the
    // rate carries it separately from what has actually traded.
    const goldAsks = book.filter((o) => o.kind === 'gold' && o.remaining > 0).map((o) => o.unitPrice);
    return NextResponse.json({
      at: Date.now(),
      prices: index?.prices ?? {},
      epoch: index?.epoch ?? 0,
      traders: index?.traders ?? 0,
      orders: book,
      trades,
      gold: goldRate(trades, goldAsks),
      land: land.rows,
      landTotal: land.total,
      sales,
    });
  } catch {
    return NextResponse.json({
      at: Date.now(), prices: {}, epoch: 0, traders: 0,
      orders: [], trades: [], gold: { traded: null, asked: null, volume: 0, fills: 0, windowHours: 168 },
      land: [], landTotal: 0, sales: [], degraded: true,
    });
  }
}

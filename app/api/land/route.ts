/**
 * The land board, and the whole catalogue behind it.
 *
 * `GET /api/land` — what is for sale, as the game's map has always shown it.
 * `GET /api/land?all=1` — every claimed plot with its holder, its
 * settlement's headline and its asking price when it has one, plus what
 * plots have actually sold for on the market contract. This is what the
 * marketplace page reads. Public: all of it is on chain already.
 */

import { NextResponse } from 'next/server';
import { landMarket } from '@/lib/server/landMarket';
import { landCatalogue } from '@/lib/server/landCatalogue';
import { recentChainSales } from '@/lib/server/nft';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.EMERGE_CRON_SECRET || process.env.CRON_SECRET;
  const fresh = url.searchParams.get('fresh') === '1' && !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  if (url.searchParams.get('all')) {
    try {
      const [catalogue, sales] = await Promise.all([
        landCatalogue(fresh),
        recentChainSales().catch(() => []),
      ]);
      return NextResponse.json({ ...catalogue, sales }, { headers: { 'cache-control': 'public, max-age=30, s-maxage=30' } });
    } catch {
      return NextResponse.json({ plots: [], total: 0, listed: 0, floor: null, holders: 0, sales: [], at: Date.now(), degraded: true });
    }
  }
  try {
    return NextResponse.json(await landMarket(fresh));
  } catch {
    return NextResponse.json({ rows: [], total: 0, at: Date.now(), degraded: true });
  }
}

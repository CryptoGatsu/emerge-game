/**
 * The land for sale. `GET /api/land`.
 *
 * Open to anybody: a listing is public by definition. Cached a minute on the
 * server; `?fresh=1` with the cron secret rebuilds it now, for the tests.
 */

import { NextResponse } from 'next/server';
import { landMarket } from '@/lib/server/landMarket';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.EMERGE_CRON_SECRET || process.env.CRON_SECRET;
  const fresh = url.searchParams.get('fresh') === '1' && !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  try {
    return NextResponse.json(await landMarket(fresh));
  } catch {
    return NextResponse.json({ rows: [], total: 0, at: Date.now(), degraded: true });
  }
}

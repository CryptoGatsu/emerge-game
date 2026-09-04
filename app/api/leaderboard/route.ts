/**
 * The cities, ranked. `GET /api/leaderboard`.
 *
 * Cached for ten minutes on the server; `?fresh=1` with the cron secret
 * rebuilds it now, for the crons and the tests, never for a browser.
 */

import { NextResponse } from 'next/server';
import { leaderboard } from '@/lib/server/leaderboard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.EMERGE_CRON_SECRET || process.env.CRON_SECRET;
  const fresh = url.searchParams.get('fresh') === '1' && !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  try {
    return NextResponse.json(await leaderboard(fresh));
  } catch {
    return NextResponse.json({ rows: [], total: 0, at: Date.now(), degraded: true });
  }
}

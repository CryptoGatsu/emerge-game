/**
 * `GET /api/token` — what $EMERGE is doing in the market, for the front page.
 *
 * Read through the server so the sources are asked once a minute rather than
 * once per visitor, and so the price history can be kept.
 */

import { NextResponse } from 'next/server';
import { readTokenStats } from '@/lib/server/tokenStats';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await readTokenStats();
    return NextResponse.json(stats, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ available: false, reason: 'Market data is not reachable right now.', history: [] }, { status: 503 });
  }
}

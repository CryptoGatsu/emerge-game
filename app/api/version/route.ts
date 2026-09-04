/**
 * Which build is being served right now.
 *
 * `GET /api/version` — the deployment answering this request.
 *
 * Small on purpose: a client polls it every few minutes, and the answer has to
 * be cheap enough that doing so is free. No store is touched and nothing is
 * computed; it reads one environment variable.
 */

import { NextResponse } from 'next/server';
import { buildId } from '@/lib/server/build';
import { VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ build: buildId(), version: VERSION }, {
    // Must never be cached: a cached answer is the old build telling everybody
    // it is still the current one, which is the one thing this cannot do.
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}

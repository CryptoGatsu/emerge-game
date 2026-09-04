/**
 * The dividend door.
 *
 * GET: the pool, this week's epoch, the caller's standing (land weight,
 * soft stake, GLD waiting) and the last settlements. Public figures, and
 * the caller's own where a session is held.
 *
 * POST { register: true } registers a soft stake for the session's wallet.
 * POST { claim: true } sends the session's wallet its GLD.
 * GET ?sample=1 and ?settle=1, with the cron secret, are the daily balance
 * sample and the weekly settlement.
 */

import { NextResponse } from 'next/server';
import { claimGld, registerStake, sampleBalances, settleEpoch, standingOf } from '@/lib/server/dividend';
import { sessionAddress } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const cronAllowed = (request: Request) => {
  const secret = process.env.EMERGE_CRON_SECRET ?? process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}` || request.headers.get('x-cron-secret') === secret;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('sample') || url.searchParams.get('settle')) {
    if (!cronAllowed(request)) return NextResponse.json({ error: 'Not for you.' }, { status: 401 });
    try {
      if (url.searchParams.get('sample')) return NextResponse.json({ sampled: await sampleBalances() });
      return NextResponse.json(await settleEpoch(url.searchParams.get('epoch') || undefined));
    } catch {
      return NextResponse.json({ error: 'The dividend could not run.' }, { status: 503 });
    }
  }
  try {
    return NextResponse.json(await standingOf(sessionAddress(request)), { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'The dividend book is not reachable.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: { register?: boolean; claim?: boolean };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  const address = sessionAddress(request);
  if (!address) return NextResponse.json({ error: 'Sign in with your wallet first.', needsSession: true }, { status: 401 });
  try {
    if (body.register) {
      const first = await registerStake(address);
      return NextResponse.json({ ok: true, registered: true, first, standing: await standingOf(address) });
    }
    if (body.claim) {
      const result = await claimGld(address);
      if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
      return NextResponse.json({ ...result, standing: await standingOf(address) });
    }
    return NextResponse.json({ error: 'Nothing asked for.' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'The dividend is not reachable.' }, { status: 503 });
  }
}

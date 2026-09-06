/**
 * `GET /api/vault` — the vault's book: what charges have paid in, what is
 * kept to cover withdrawals, what is owed to the burn address and what has
 * been burned, with the recent burn transactions. Public, because the whole
 * point of the split is that anybody can check it.
 *
 * `POST /api/vault` with `{ sweep: true }` asks the vault to burn what it
 * owes now rather than after the next charge. Anybody may ask; it only ever
 * burns the vault's own owed share, once, under a lock.
 *
 * `GET /api/vault?probe=1`, with the cron secret, simulates the GLD swap as
 * configured and says what it would do, allowances and revert reason
 * included; `&search=1` also tries every kind and fee tier and lists the
 * routes that fill; `&pool=<id>` reads a v4 pool's key by the id a chart
 * shows and writes the route from it. Nothing is sent.
 */

import { NextResponse } from 'next/server';
import { sweepBurn, vaultBook } from '@/lib/server/treasury';
import { incrWindow } from '@/lib/server/kv';
import { serverKey } from '@/lib/limits';
import { probeSwap } from '@/lib/server/signer';

export const dynamic = 'force-dynamic';
// A probe with search simulates a few dozen swaps.
export const maxDuration = 60;

const cronAllowed = (request: Request) => {
  const secret = process.env.EMERGE_CRON_SECRET ?? process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}` || request.headers.get('x-cron-secret') === secret;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('probe')) {
    if (!cronAllowed(request)) return NextResponse.json({ error: 'Not for you.' }, { status: 401 });
    const amount = Number(url.searchParams.get('amount')) || 100;
    // `search=1` also tries every kind and standard fee tier along the configured tokens.
    const from = BigInt(Math.max(0, Math.floor(Number(url.searchParams.get('from')) || 0)));
    // `pool=<id>` names a v4 pool by the id a chart shows; its key is read off the chain.
    const pool = url.searchParams.get('pool') ?? '';
    const poolId = /^0x[0-9a-fA-F]{64}$/.test(pool) ? (pool as `0x${string}`) : null;
    return NextResponse.json(await probeSwap(amount, !!url.searchParams.get('search'), from, poolId), { headers: { 'cache-control': 'no-store, max-age=0' } });
  }
  try {
    return NextResponse.json(await vaultBook(), { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'The vault book is not reachable right now.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: { sweep?: boolean };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  if (!body.sweep) return NextResponse.json({ error: 'Nothing asked for.' }, { status: 400 });
  // A handful an hour, so a sweep cannot be used to make the vault pay gas all day.
  if ((await incrWindow(serverKey('vault:sweep-asks'), 1, 3600)) > 12) {
    return NextResponse.json({ error: 'The vault has been asked enough this hour.' }, { status: 429 });
  }
  try {
    const result = await sweepBurn();
    return NextResponse.json({ ...result, book: await vaultBook() });
  } catch {
    return NextResponse.json({ error: 'The sweep could not run.' }, { status: 503 });
  }
}

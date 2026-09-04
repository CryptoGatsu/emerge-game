/**
 * `GET /api/vault` — the vault's book: what charges have paid in, what is
 * kept to cover withdrawals, what is owed to the burn address and what has
 * been burned, with the recent burn transactions. Public, because the whole
 * point of the split is that anybody can check it.
 *
 * `POST /api/vault` with `{ sweep: true }` asks the vault to burn what it
 * owes now rather than after the next charge. Anybody may ask; it only ever
 * burns the vault's own owed share, once, under a lock.
 */

import { NextResponse } from 'next/server';
import { sweepBurn, vaultBook } from '@/lib/server/treasury';
import { incrWindow } from '@/lib/server/kv';
import { serverKey } from '@/lib/limits';

export const dynamic = 'force-dynamic';

export async function GET() {
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

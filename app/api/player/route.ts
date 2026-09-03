/**
 * A player's own record, for the wallet that proved itself.
 *
 * `GET  /api/player` — what this wallet saved last, from any device.
 * `POST /api/player` — save it.
 *
 * Both need a session: the record carries a name and a ledger, and neither
 * is anybody else's to read or to write. Nothing here is money the server
 * trusts — payouts check the chain and their own caps regardless — so a
 * record is a convenience the player carries between devices, not a claim
 * on the vault.
 */

import { NextResponse } from 'next/server';
import { readPlayerRecord, savePlayerRecord } from '@/lib/server/registry';
import { sessionAddress } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** A record is a few kilobytes; this is room for a player with many plots. */
const MAX_RECORD = 64_000;

export async function GET(request: Request) {
  const address = sessionAddress(request);
  if (!address) return NextResponse.json({ error: 'Sign in first.', needsSession: true }, { status: 401 });
  try {
    const record = await readPlayerRecord(address);
    return NextResponse.json({ record }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ record: null, reason: 'The store is not reachable.' });
  }
}

export async function POST(request: Request) {
  const address = sessionAddress(request);
  if (!address) return NextResponse.json({ error: 'Sign in first.', needsSession: true }, { status: 401 });
  let body: { record?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }
  const record = body.record as { ledger?: unknown; claims?: unknown } | undefined;
  if (!record || typeof record !== 'object' || typeof record.ledger !== 'object' || !Array.isArray(record.claims)) {
    return NextResponse.json({ error: 'That is not a player record.' }, { status: 400 });
  }
  if (JSON.stringify(record).length > MAX_RECORD) {
    return NextResponse.json({ error: 'That record is too large.' }, { status: 413 });
  }
  try {
    await savePlayerRecord(address, { ...record, savedAt: Date.now() });
    return NextResponse.json({ saved: true });
  } catch {
    return NextResponse.json({ error: 'The store is not reachable.' }, { status: 502 });
  }
}

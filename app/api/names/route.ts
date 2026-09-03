/**
 * What each wallet is called.
 *
 * `GET  /api/names` — every name the relay knows, by address.
 * `POST /api/names` — set the name of the wallet this session has proved.
 *
 * The read is open, because a name is public the moment somebody says
 * something under it. The write is not, and the address written to is never
 * taken from the request body: it is the one the session proved. That is the
 * whole security property here — a person can call themselves anything, but
 * they cannot attach a name to an address that is not theirs.
 */

import { NextResponse } from 'next/server';
import { MAX_DISPLAY_NAME, displayNames, setDisplayName } from '@/lib/server/registry';
import { sessionAddress } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ names: await displayNames() });
  } catch {
    // A name nobody can read is a cosmetic loss, never an error worth showing.
    return NextResponse.json({ names: {} });
  }
}

export async function POST(request: Request) {
  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const address = sessionAddress(request);
  if (!address) {
    return NextResponse.json({
      error: 'Sign in with your wallet to set a name.', needsSession: true,
    }, { status: 401 });
  }

  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length > MAX_DISPLAY_NAME) {
    return NextResponse.json({
      error: `Keep it under ${MAX_DISPLAY_NAME} characters.`,
    }, { status: 400 });
  }

  try {
    await setDisplayName(address, name);
    return NextResponse.json({ ok: true, name });
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

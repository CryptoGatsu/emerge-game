/**
 * Who is watching a world.
 *
 * `POST /api/presence` — "I am still here", and who else is.
 * `POST /api/presence` with `leaving` — going now.
 * `GET  /api/presence?seed=<n>` — who is there, without joining them.
 *
 * A heartbeat rather than a sign-in, because nobody closes a tab politely: the
 * only definition of "here" that survives a killed browser is "said something
 * in the last minute".
 *
 * The identifier a client sends is its own — a wallet address when it has one,
 * otherwise a random per-session id. It is only ever counted and compared, and
 * the count is all the interface shows.
 */

import { NextResponse } from 'next/server';
import { depart, heartbeat, watchers } from '@/lib/server/registry';

export const dynamic = 'force-dynamic';

/** Long enough for an address, short enough not to be a payload. */
const MAX_ID = 64;

const cleanId = (value: string) => value.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, MAX_ID);

export async function GET(request: Request) {
  const seed = Number(new URL(request.url).searchParams.get('seed'));
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  try {
    const here = await watchers(seed);
    return NextResponse.json({ count: here.length });
  } catch {
    return NextResponse.json({ count: 0, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: { seed?: number; who?: string; leaving?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  const who = cleanId(String(body.who ?? ''));
  if (!Number.isInteger(seed) || seed <= 0 || !who) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }

  try {
    if (body.leaving) {
      await depart(seed, who);
      return NextResponse.json({ count: (await watchers(seed)).length });
    }
    const here = await heartbeat(seed, who);
    // The count includes the caller, which is what a player expects to read:
    // "2 watching" with one other person there, not "1 other".
    return NextResponse.json({ count: here.length });
  } catch {
    return NextResponse.json({ count: 0, degraded: true });
  }
}

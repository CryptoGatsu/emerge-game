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
import { depart, heartbeat, noteActed, playersOnline, watchers } from '@/lib/server/registry';

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
    const [here, online] = await Promise.all([watchers(seed), playersOnline()]);
    return NextResponse.json({ count: here.length, online });
  } catch {
    return NextResponse.json({ count: 0, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: { seed?: number; who?: string; leaving?: boolean; acted?: number };
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
    // The wallet's last action, by its own account, kept so another device
    // opens the same world as attended. A wallet address only: a visitor's
    // random id has no plots to attend.
    const acted = /^0x[0-9a-fA-F]{40}$/.test(who) && Number.isFinite(Number(body.acted))
      ? noteActed(who, Number(body.acted))
      : Promise.resolve(0);
    const [here, online, actedAt] = await Promise.all([heartbeat(seed, who), playersOnline(), acted]);
    // The owner is never in this count. On your own world it reads as the
    // number of people who have come to look; on somebody else's, as how many
    // others are looking with you.
    return NextResponse.json({ count: here.length, online, acted: actedAt });
  } catch {
    return NextResponse.json({ count: 0, degraded: true });
  }
}

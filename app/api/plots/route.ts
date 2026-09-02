/**
 * The land registry.
 *
 * `GET  /api/plots` — every claim on record.
 * `POST /api/plots` — take a plot, or be told who already has it.
 * `POST /api/plots?release=1` — give one up.
 *
 * This is what stops two players owning the same land. Everything a client
 * sends is treated as hostile: the address is pattern-matched against what an
 * Ethereum address actually looks like, names are length-capped and stripped of
 * control characters, the seed must be a plain positive integer, and the
 * timestamp is set here rather than accepted from the caller.
 */

import { NextResponse } from 'next/server';
import { allClaims, registryShared, releaseClaim, takeClaim, type Claim } from '@/lib/server/registry';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_NAME = 32;

/** Strip control characters and collapse runs of whitespace. */
const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function GET() {
  try {
    return NextResponse.json({ claims: await allClaims(), shared: registryShared() });
  } catch {
    // A store that is unreachable should leave the land office usable and
    // honest, not throw a red panel at the player.
    return NextResponse.json({ claims: [], shared: false, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: {
    seed?: number; region?: string; worldName?: string; owner?: string;
    ownerName?: string; price?: number; release?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  if (!Number.isInteger(seed) || seed <= 0 || seed > 1e12) {
    return NextResponse.json({ error: 'Unknown plot.' }, { status: 400 });
  }
  const owner = String(body.owner ?? '');
  if (!ADDRESS.test(owner)) {
    // Not a formality: the whole point of the registry is that a plot belongs
    // to a wallet, so a claim without one has nothing to belong to.
    return NextResponse.json({ error: 'Connect a wallet before claiming land.' }, { status: 400 });
  }

  if (body.release) {
    try {
      const released = await releaseClaim(seed, owner);
      return NextResponse.json({ released });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  const claim: Claim = {
    seed,
    region: clean(String(body.region ?? 'Unnamed'), MAX_NAME),
    worldName: clean(String(body.worldName ?? 'Emerge'), MAX_NAME),
    owner,
    ownerName: clean(String(body.ownerName ?? ''), MAX_NAME),
    price: Math.max(0, Math.round(Number(body.price) || 0)),
    // Ours, not the caller's: a client that could set this could claim to have
    // held a plot since before the person who actually did.
    at: Date.now(),
  };

  try {
    const result = await takeClaim(claim);
    if (!result.ok) {
      return NextResponse.json({
        error: `${result.taken.region} already belongs to somebody else.`,
        taken: result.taken,
      }, { status: 409 });
    }
    return NextResponse.json({ claim: result.claim, shared: registryShared() });
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

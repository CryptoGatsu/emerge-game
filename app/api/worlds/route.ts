/**
 * Published worlds.
 *
 * `GET  /api/worlds?seed=<n>` — somebody's settlement, as they last left it.
 * `POST /api/worlds` — the owner puts theirs up.
 *
 * This is what makes visiting real. Without it a visitor could only be shown a
 * world regenerated from the seed — the same land, but not the place the owner
 * actually built, with none of their people in it. That would look like a visit
 * and be a fiction.
 *
 * Only the address that holds the claim may publish, so a settlement cannot be
 * rewritten by somebody who does not own it.
 */

import { NextResponse } from 'next/server';
import { claimOf, publishWorld, readWorld } from '@/lib/server/registry';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The largest snapshot accepted.
 *
 * A large settlement saves at about 55KB; this leaves headroom for one that
 * has been played for months without letting a caller push arbitrary bulk into
 * the store.
 */
const MAX_SNAPSHOT = 400_000;

export async function GET(request: Request) {
  const seed = Number(new URL(request.url).searchParams.get('seed'));
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  try {
    const world = await readWorld(seed);
    if (!world) {
      return NextResponse.json({
        world: null,
        reason: 'Nobody has opened this world lately, so there is nothing to show yet.',
      });
    }
    return NextResponse.json({ world });
  } catch {
    return NextResponse.json({ world: null, reason: 'The world store is not reachable.' });
  }
}

export async function POST(request: Request) {
  let body: {
    seed?: number; owner?: string; ownerName?: string; worldName?: string;
    day?: number; population?: number; snapshot?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  const owner = String(body.owner ?? '');
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  if (!ADDRESS.test(owner)) {
    return NextResponse.json({ error: 'Only a wallet can publish a world.' }, { status: 400 });
  }
  if (!body.snapshot) {
    return NextResponse.json({ error: 'Nothing to publish.' }, { status: 400 });
  }

  const encoded = JSON.stringify(body.snapshot);
  if (encoded.length > MAX_SNAPSHOT) {
    return NextResponse.json({ error: 'That world is too large to publish.' }, { status: 413 });
  }

  try {
    // The registry decides who may write here, not the caller.
    const claim = await claimOf(seed);
    if (!claim) {
      return NextResponse.json({ error: 'That plot is not claimed.' }, { status: 409 });
    }
    if (claim.owner.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'That world belongs to somebody else.' }, { status: 403 });
    }

    await publishWorld({
      seed,
      owner: owner.toLowerCase(),
      ownerName: String(body.ownerName ?? claim.ownerName ?? '').slice(0, 32),
      worldName: String(body.worldName ?? claim.worldName ?? '').slice(0, 32),
      day: Math.max(0, Math.round(Number(body.day) || 0)),
      population: Math.max(0, Math.round(Number(body.population) || 0)),
      at: Date.now(),
      snapshot: body.snapshot,
    });
    return NextResponse.json({ published: true });
  } catch {
    return NextResponse.json({ error: 'The world store is not reachable.' }, { status: 502 });
  }
}

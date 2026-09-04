/**
 * The world market.
 *
 * `GET  /api/market` — what everything costs everywhere, right now.
 * `POST /api/market` — "here is what my settlement has in store", and the same
 *                      prices back in the same round trip.
 *
 * The read is open: a price is public, and a visitor watching somebody else's
 * town should see the same figures its own baker does. The write is not. A
 * settlement's position is only counted for a plot the caller holds a session
 * for and owns in the registry, so a reading costs a plot and a signature —
 * and the index averages readings rather than adding them up, which is what
 * stops one loud settlement from being the market.
 */

import { NextResponse } from 'next/server';
import { EPOCH_MS, readMarket, recordSample } from '@/lib/server/market';
import { claimOf } from '@/lib/server/registry';
import { sessionAddress } from '@/lib/server/session';
import { RESOURCES } from '@/lib/world/goods';

export const dynamic = 'force-dynamic';

/** The prices, plus enough for the interface to say how real they are. */
async function quote() {
  const index = await readMarket();
  return {
    epoch: index.epoch,
    epochMs: EPOCH_MS,
    prices: index.prices,
    next: index.next,
    at: index.at,
    // The server's own clock. A browser five seconds fast must not change
    // over to the next fixing five seconds early.
    now: index.now,
    traders: index.traders,
    shared: index.shared,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await quote());
  } catch {
    // The market being unreachable must never stop a world running. The client
    // reads this and falls back to pricing its own stores, as it did before
    // there was an index at all.
    return NextResponse.json({ offline: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: { seed?: number; stocks?: Record<string, number> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }

  try {
    const address = sessionAddress(request);
    if (address) {
      const claim = await claimOf(seed);
      // Only the settlement's owner speaks for it. A visitor standing in
      // somebody else's town reads the market like everybody else; they do not
      // get to report that town's granary as empty.
      if (claim && claim.owner.toLowerCase() === address.toLowerCase()) {
        const stocks: Record<string, number> = {};
        for (const r of RESOURCES) {
          const value = Number(body.stocks?.[r]);
          if (Number.isFinite(value)) stocks[r] = value;
        }
        await recordSample(seed, stocks);
      }
    }
    // Either way the caller gets the prices. A reading that was not counted is
    // not an error the player should see — it means their world is not one of
    // the ones moving the market, which is true of every visitor.
    return NextResponse.json(await quote());
  } catch {
    return NextResponse.json({ offline: true }, { status: 503 });
  }
}

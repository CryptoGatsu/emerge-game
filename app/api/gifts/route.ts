/**
 * Gold sent to somebody else's settlement.
 *
 * `POST /api/gifts` — leave Gold for a world's owner.
 * `POST /api/gifts` with `collect` — the owner takes what is waiting.
 *
 * A queue rather than a direct write, because a visitor's browser runs its own
 * copy of the world it is looking at: Gold added there would live for as long
 * as the visit and then vanish. The owner's client is the only thing that can
 * put it into the settlement that actually persists, so the gift waits until
 * that client next asks.
 *
 * The $EMERGE side is the sender's own business and is burned in their wallet
 * before this is called. What crosses the wire is Gold, and the server cannot
 * see the burn — so a client that lied about paying could otherwise mint Gold
 * into any world for nothing, as often as it liked.
 *
 * So the burn is checked, exactly as a land claim's is: a real transaction from
 * this wallet, settled, worth at least the Gold being sent at the usual rate,
 * and not already spent on something else. Without that a client could mint
 * Gold into any world for nothing, as often as it liked.
 *
 * Even before that check existed the damage was bounded — Gold has no exit,
 * since the only door out of the game is a withdrawal of principal and that is
 * limited by deposits the chain has confirmed — but "cannot drain the vault" is
 * a much weaker promise than "cannot be conjured", and the second one is cheap.
 */

import { NextResponse } from 'next/server';
import { MAX_GIFT_GOLD, claimOf, collectGifts, leaveGift, type Gift } from '@/lib/server/registry';
import { holdsAddress, sessionsAvailable } from '@/lib/server/session';
import { spendBurn, verifyBurn } from '@/lib/server/burns';
import { EMERGE_PER_GOLD } from '@/lib/chain/vault';
import { tokenLive } from '@/lib/chain/emerge';
import { incrWindow } from '@/lib/server/kv';
import { serverKey } from '@/lib/limits';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The most Gold one wallet may give away in a day, across every world. */
const MAX_GIFT_GOLD_PER_DAY = 10_000;

const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function POST(request: Request) {
  let body: {
    seed?: number; gold?: number; from?: string; fromName?: string; collect?: boolean;
    /** The transaction that burned the Gold's worth in $EMERGE. */
    burnTx?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  const from = String(body.from ?? '');
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  if (!ADDRESS.test(from)) {
    return NextResponse.json({ error: 'A gift comes from a wallet.' }, { status: 400 });
  }
  if (sessionsAvailable() && !holdsAddress(request, from)) {
    return NextResponse.json({ error: 'Sign in with this wallet first.', needsSession: true }, { status: 401 });
  }

  /* The owner, taking what has been left for them. */
  if (body.collect) {
    try {
      const claim = await claimOf(seed);
      if (!claim || claim.owner.toLowerCase() !== from.toLowerCase()) {
        // Not an error worth showing: a client polling a world it has just
        // given up should simply be told there is nothing for it.
        return NextResponse.json({ gifts: [] });
      }
      return NextResponse.json({ gifts: await collectGifts(seed) });
    } catch {
      return NextResponse.json({ gifts: [] });
    }
  }

  const gold = Math.floor(Number(body.gold) || 0);
  if (!(gold > 0)) {
    return NextResponse.json({ error: 'Enter an amount to send.' }, { status: 400 });
  }
  if (gold > MAX_GIFT_GOLD) {
    return NextResponse.json(
      { error: `A single gift carries at most ${MAX_GIFT_GOLD.toLocaleString()} Gold.` },
      { status: 400 },
    );
  }

  // What one wallet may put into other people's worlds in a day. Far above
  // generosity, far below what minting Gold for free would be worth.
  const given = await incrWindow(serverKey(`gifts:from:${from.toLowerCase()}`), gold, 26 * 3600);
  if (given > MAX_GIFT_GOLD_PER_DAY) {
    return NextResponse.json({
      error: `That is ${MAX_GIFT_GOLD_PER_DAY.toLocaleString()} Gold given today. Be generous again tomorrow.`,
    }, { status: 429 });
  }

  // Paid for, at the same rate a deposit buys Gold.
  if (tokenLive()) {
    const burnTx = String(body.burnTx ?? '');
    const paid = await verifyBurn(burnTx, from, gold * EMERGE_PER_GOLD);
    if (!paid.ok) {
      return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
    }
    if (!(await spendBurn(burnTx, `gift:${seed}`, paid.whole))) {
      return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
    }
  }

  try {
    const claim = await claimOf(seed);
    if (!claim) {
      return NextResponse.json({ error: 'Nobody owns that plot.' }, { status: 409 });
    }
    if (claim.owner.toLowerCase() === from.toLowerCase()) {
      // Sending Gold to yourself through this door would convert $EMERGE into
      // treasury Gold at a rate nobody set, which is the deposit path's job.
      return NextResponse.json({ error: 'That world is already yours.' }, { status: 409 });
    }

    const gift: Gift = {
      id: `g${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      seed,
      gold,
      from: from.toLowerCase(),
      fromName: clean(String(body.fromName ?? ''), 32),
      at: Date.now(),
    };
    await leaveGift(gift);
    return NextResponse.json({ gift, to: claim.ownerName || claim.owner });
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

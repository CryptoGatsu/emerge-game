/*
 * The game's public ledger, in three numbers.
 *
 * What players have paid into the game, what the vault has burned of it, and
 * what has gone back out to players' wallets. Read from the vault book and
 * the payout ledger, cached for twenty seconds because the landing page asks
 * on every visit and the payout list is read whole.
 */

import { NextResponse } from 'next/server';
import { vaultBook } from '@/lib/server/treasury';
import { allPayouts } from '@/lib/server/payouts';

export const dynamic = 'force-dynamic';

export interface GameStats {
  at: number;
  /** $EMERGE paid into the game by every charge, whole tokens. */
  used: number;
  /** Burned by the vault on chain. */
  burned: number;
  /** Owed to the burn address, awaiting the next sweep. */
  awaitingBurn: number;
  /** Paid out to players' wallets, net of the held share. */
  withdrawn: number;
  /** How many withdrawals that was. */
  payouts: number;
}

let cache: { at: number; body: GameStats } | null = null;
const HOLD_MS = 20_000;

export async function GET() {
  if (cache && Date.now() - cache.at < HOLD_MS) return NextResponse.json(cache.body, { headers: { 'cache-control': 'no-store, max-age=0' } });
  try {
    const [book, payouts] = await Promise.all([vaultBook(), allPayouts()]);
    const paid = payouts.filter((p) => !p.failed);
    const body: GameStats = {
      at: Date.now(),
      used: Math.max(0, Math.round(book.received)),
      burned: Math.max(0, Math.round(book.burned)),
      awaitingBurn: Math.max(0, Math.round(book.owed)),
      withdrawn: Math.max(0, Math.round(paid.reduce((s, p) => s + (Number(p.net) || 0), 0))),
      payouts: paid.length,
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'The ledger is not reachable right now.' }, { status: 503 });
  }
}

/**
 * The settlement queue.
 *
 * `GET  /api/payouts?address=0x…` — what one wallet has asked for, and where
 *   each request stands.
 * `POST /api/payouts` — ask to be paid out of the vault.
 *
 * A request is a request. It is paid by hand from the vault wallet, because
 * the vault is a wallet and not a contract, and nothing here tells a player
 * their tokens have moved. Everything a client sends is treated as hostile:
 * the address is pattern-matched, names are cleaned and capped, the amounts
 * are recomputed from the Gold rather than believed, and the timestamp is set
 * here.
 *
 * The full queue is deliberately not served to anybody who asks: it is a list
 * of wallets and the sums they are owed, which is nobody else's business.
 */

import { NextResponse } from 'next/server';
import { WITHDRAW_BURN_RATE, EMERGE_PER_GOLD } from '@/lib/chain/vault';
import { registryShared } from '@/lib/server/registry';
import { payoutsFor, requestPayout } from '@/lib/server/payouts';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_NAME = 32;

const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address') ?? '';
  if (!ADDRESS.test(address)) return NextResponse.json({ payouts: [], shared: registryShared() });
  try {
    return NextResponse.json({ payouts: await payoutsFor(address), shared: registryShared() });
  } catch {
    return NextResponse.json({ payouts: [], shared: false, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: {
    address?: string; name?: string; seed?: number; worldName?: string;
    kind?: string; gold?: number; gross?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const address = String(body.address ?? '');
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: 'A payout belongs to a wallet address.' }, { status: 400 });
  }

  const kind = body.kind === 'earnings' ? 'earnings' : 'principal';
  const gold = Math.max(0, Math.floor(Number(body.gold) || 0));

  /*
   * The amounts are derived here, not accepted.
   *
   * A principal withdrawal is worth exactly the Gold it takes out at the fixed
   * rate; an earnings collection is denominated in tokens to begin with. Either
   * way the burn share is computed from the rate rather than sent, so a client
   * cannot ask for a smaller burn than everybody else pays.
   */
  const gross = kind === 'principal'
    ? gold * EMERGE_PER_GOLD
    : Math.max(0, Math.floor(Number(body.gross) || 0));
  const burned = Math.round(gross * WITHDRAW_BURN_RATE);

  try {
    const result = await requestPayout({
      address,
      name: clean(String(body.name ?? ''), MAX_NAME),
      seed: Number.isInteger(Number(body.seed)) ? Number(body.seed) : 0,
      worldName: clean(String(body.worldName ?? ''), MAX_NAME),
      kind,
      gold: kind === 'principal' ? gold : 0,
      gross,
      burned,
      net: gross - burned,
    });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
    return NextResponse.json({ payout: result.payout, shared: registryShared() });
  } catch {
    return NextResponse.json({ error: 'The settlement queue is not reachable.' }, { status: 502 });
  }
}

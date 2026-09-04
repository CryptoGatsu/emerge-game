/**
 * Crediting a deposit.
 *
 * `POST /api/deposits` — "here is the transaction where I sent $EMERGE to the
 * vault". The server goes and reads it off the chain, and credits principal
 * only if it really happened, really went to the vault, and really came from
 * the wallet asking.
 *
 * This is the half of the settlement ledger that cannot be forged, and it is
 * why the withdrawal endpoint can sign without a person watching: what it pays
 * back is bounded by deposits the chain itself confirms.
 */

import { NextResponse } from 'next/server';
import { VAULT_ADDRESS } from '@/lib/chain/emerge';
import { creditPrincipal, depositSeen, markDeposit, principalOf } from '@/lib/server/accounts';
import { verifyDeposit } from '@/lib/server/deposits';
import { registryShared } from '@/lib/server/registry';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address') ?? '';
  if (!ADDRESS.test(address)) return NextResponse.json({ principal: 0 });
  try {
    return NextResponse.json({ principal: await principalOf(address), shared: registryShared() });
  } catch {
    return NextResponse.json({ principal: 0, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: { address?: string; txHash?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const address = String(body.address ?? '');
  const txHash = String(body.txHash ?? '');
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: 'A deposit belongs to a wallet address.' }, { status: 400 });
  }

  /*
   * A ledger that cannot be shared between instances is not a ledger.
   *
   * On serverless every request runs somewhere else, so principal held in
   * process memory would read as zero to the next caller — and, far worse, the
   * daily emission counters the payout route depends on would reset per
   * instance. Refuse rather than half-work.
   */
  if (!registryShared()) {
    return NextResponse.json({
      error: 'This deployment has no shared store, so deposits cannot be credited. Nothing was taken.',
    }, { status: 503 });
  }

  try {
    if (await depositSeen(txHash)) {
      return NextResponse.json({ error: 'That deposit has already been credited.', already: true }, { status: 409 });
    }

    const check = await verifyDeposit(txHash, address, VAULT_ADDRESS);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason, retry: check.retry }, { status: check.retry ? 202 : 400 });
    }

    /*
     * Claim the transaction before crediting it.
     *
     * `markDeposit` is a set-if-absent, so of two requests replaying the same
     * hash exactly one gets `true`. Claiming first and crediting second means
     * the worst case is a deposit that needs crediting by hand; claiming second
     * would mean a deposit credited twice, which is minting.
     */
    if (!(await markDeposit(txHash, address))) {
      return NextResponse.json({ error: 'That deposit has already been credited.', already: true }, { status: 409 });
    }

    let principal: number;
    try {
      principal = await creditPrincipal(address, check.whole);
    } catch (error) {
      // Give the claim back so a retry can succeed, then admit what happened.
      const { dropDeposit } = await import('@/lib/server/accounts');
      await dropDeposit(txHash).catch(() => {});
      throw error;
    }

    return NextResponse.json({ credited: check.whole, principal });
  } catch {
    return NextResponse.json({ error: 'The settlement ledger is not reachable.' }, { status: 502 });
  }
}

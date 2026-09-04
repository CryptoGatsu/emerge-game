import 'server-only';

/**
 * The vault's book: what charges have paid into it, what it owes the burn
 * address for them, and what it has burned.
 *
 * Since v2.1 a charge is one transfer into the vault rather than a burn. A
 * share stays to pay withdrawals with; the rest the vault burns itself, from
 * its own key, so the burn is as real and as checkable as it was when players
 * burned directly — it just happens a moment later and in one transaction for
 * many charges. The share owed accumulates here and is swept whenever it is
 * worth a transaction, after each charge and on demand.
 */

import { chargeSplit, CHARGE_VAULT_SHARE, CHARGE_DIVIDEND_SHARE } from '../chain/vault';
import { serverKey } from '../limits';
import { counter, incrBy, push, range, releaseLock, takeLock } from './kv';
import { burnFromVault, vaultCanSign } from './signer';

const RECEIVED = serverKey('vault:received');
export const DIVIDEND_POOL = serverKey('dividend:pool');
const OWED = serverKey('vault:owed-burn');
const BURNED = serverKey('vault:burned');
const BURNS = serverKey('vault:burns');
const SWEEP_LOCK = serverKey('vault:sweep');

/** Below this the burn share waits: a transaction's gas is worth more than the tidiness. */
export const MIN_SWEEP_EMERGE = 10_000;

/** Book a charge the vault has received, and try to burn what it now owes. */
export async function noteCharge(whole: number): Promise<void> {
  const split = chargeSplit(whole);
  if (split.whole <= 0) return;
  await incrBy(RECEIVED, split.whole);
  await incrBy(OWED, split.burned);
  if (split.dividend > 0) await incrBy(DIVIDEND_POOL, split.dividend);
  void sweepBurn().catch(() => {});
}

/**
 * Book the share held back from a withdrawal: it stayed in the vault, and
 * half of it is owed to the burn address like a charge's share is.
 */
export async function noteHold(whole: number): Promise<void> {
  // Split the same way a charge is.
  await noteCharge(whole);
}

export interface VaultBook {
  /** Whole $EMERGE charges have paid into the vault, ever. */
  received: number;
  /** The share of that kept to pay withdrawals. */
  kept: number;
  /** The burn share not yet burned. */
  owed: number;
  /** Burned from the vault, ever. */
  burned: number;
  /** The dividend pool waiting for the week's settlement, in $EMERGE. */
  dividendPool: number;
  share: number;
  dividendShare: number;
  /** Whether this deployment can burn from the vault at all. */
  automatic: boolean;
  burns: { txHash: string; whole: number; at: number }[];
}

export async function vaultBook(): Promise<VaultBook> {
  const [received, owed, burned, lines, dividendPool] = await Promise.all([counter(RECEIVED), counter(OWED), counter(BURNED), range(BURNS), counter(DIVIDEND_POOL)]);
  const burns = lines.map((l) => { try { return JSON.parse(l) as { txHash: string; whole: number; at: number }; } catch { return null; } })
    .filter((x): x is { txHash: string; whole: number; at: number } => !!x);
  return { received, kept: received - owed - burned - dividendPool, owed, burned, dividendPool, share: CHARGE_VAULT_SHARE, dividendShare: CHARGE_DIVIDEND_SHARE, automatic: vaultCanSign(), burns };
}

export type Sweep = { ok: true; burned: number; txHash: string | null } | { ok: false; reason: string };

/**
 * Burn what the vault owes, if it is worth a transaction and nobody else is
 * doing it. Refuses quietly: a sweep that does not happen now happens after
 * the next charge.
 */
export async function sweepBurn(): Promise<Sweep> {
  const owed = await counter(OWED);
  if (owed < MIN_SWEEP_EMERGE) return { ok: true, burned: 0, txHash: null };
  if (!vaultCanSign()) return { ok: false, reason: 'The vault is not configured to sign.' };
  if (!(await takeLock(SWEEP_LOCK, 60))) return { ok: false, reason: 'A sweep is already running.' };
  try {
    const sent = await burnFromVault(owed);
    if (!sent.ok) return { ok: false, reason: sent.problem };
    await incrBy(OWED, -owed);
    await incrBy(BURNED, owed);
    await push(BURNS, JSON.stringify({ txHash: sent.txHash, whole: owed, at: Date.now() }), 50);
    return { ok: true, burned: owed, txHash: sent.txHash };
  } finally {
    await releaseLock(SWEEP_LOCK);
  }
}

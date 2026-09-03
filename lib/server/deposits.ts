import 'server-only';

/**
 * Reading a deposit off the chain.
 *
 * A player deposits by signing an ordinary ERC-20 transfer into the vault, then
 * telling us the transaction hash. Nothing about that claim is trusted: this
 * goes and looks. The transaction has to exist, have succeeded, be a call to
 * the configured $EMERGE contract, be a `transfer` whose recipient is the
 * vault, and come from the address claiming it.
 *
 * That last check is the one that matters most and the easiest to leave out.
 * Without it, anybody could watch the chain for somebody else's deposit and
 * claim the credit for it — the transaction would verify perfectly and the
 * money would land in the wrong ledger.
 */

import { createPublicClient, decodeFunctionData, defineChain, http, type Hex } from 'viem';
import { ACTIVE_CHAIN, TOKEN } from '../chain/emerge';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const ERC20 = [
  {
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }],
  },
] as const;

/**
 * How many blocks deep a deposit must be before it is credited.
 *
 * Robinhood Chain settles quickly, so this is a couple of seconds rather than a
 * wait anybody notices. Raise it with `EMERGE_DEPOSIT_CONFIRMATIONS` if the
 * network ever justifies it.
 */
const CONFIRMATIONS = Math.max(1, Number(process.env.EMERGE_DEPOSIT_CONFIRMATIONS) || 3);

export type DepositCheck =
  | { ok: true; whole: number }
  | { ok: false; reason: string; retry: boolean };

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Confirm a deposit really happened, and say how much it was worth.
 *
 * `retry` separates "this will never be true" from "ask again in a moment" —
 * a transaction the node has not seen yet is the normal case immediately after
 * signing, and telling a player their deposit was rejected because we asked
 * one second too early would be both wrong and alarming.
 */
export async function verifyDeposit(
  txHash: string,
  claimant: string,
  vault: string,
): Promise<DepositCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'That is not a transaction hash.', retry: false };
  }
  if (!ACTIVE_CHAIN.tokenAddress) {
    return { ok: false, reason: `No ${TOKEN.ticker} contract is configured.`, retry: false };
  }

  const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });

  let receipt;
  let tx;
  try {
    [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash: txHash as Hex }),
      client.getTransaction({ hash: txHash as Hex }),
    ]);
  } catch {
    return { ok: false, reason: 'The chain has not seen that transaction yet.', retry: true };
  }
  if (!receipt || !tx) {
    return { ok: false, reason: 'The chain has not seen that transaction yet.', retry: true };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'That transaction failed on chain, so nothing was deposited.', retry: false };
  }

  /*
   * Wait for the block to settle.
   *
   * A transaction in the newest block can still be undone by a short reorg, and
   * crediting one that is later orphaned would hand out principal against a
   * deposit that no longer exists. A handful of blocks costs a player a few
   * seconds; the retry loop in the Bank covers the wait.
   */
  try {
    const head = await client.getBlockNumber();
    // A transaction in the newest block has one confirmation, not none, which
    // is the usual reading and the one `CONFIRMATIONS` is written against.
    const confirmations = head - receipt.blockNumber + 1n;
    if (confirmations < BigInt(CONFIRMATIONS)) {
      return {
        ok: false,
        reason: `Waiting for the deposit to settle — ${confirmations} of ${CONFIRMATIONS} confirmations.`,
        retry: true,
      };
    }
  } catch {
    return { ok: false, reason: 'Could not reach the chain to confirm that deposit.', retry: true };
  }

  // Who sent it. A deposit belongs to the wallet that signed it, not to
  // whoever tells us about it first.
  if (!same(tx.from, claimant)) {
    return { ok: false, reason: 'That deposit was sent from a different wallet.', retry: false };
  }
  if (!same(tx.to, ACTIVE_CHAIN.tokenAddress)) {
    return { ok: false, reason: `That transaction is not a ${TOKEN.ticker} transfer.`, retry: false };
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ERC20, data: tx.input });
  } catch {
    return { ok: false, reason: `That transaction is not a ${TOKEN.ticker} transfer.`, retry: false };
  }
  if (decoded.functionName !== 'transfer') {
    return { ok: false, reason: `That transaction is not a ${TOKEN.ticker} transfer.`, retry: false };
  }

  const [to, units] = decoded.args as readonly [Hex, bigint];
  if (!same(to, vault)) {
    return { ok: false, reason: 'That transfer did not go to the vault.', retry: false };
  }

  try {
    const decimals = await client.readContract({
      address: ACTIVE_CHAIN.tokenAddress as Hex, abi: ERC20, functionName: 'decimals',
    });
    // Whole tokens, rounded down: a deposit is credited for what it certainly
    // covers, never for a fraction rounded up in the player's favour.
    const whole = Number(units / 10n ** BigInt(Number(decimals)));
    if (!(whole > 0)) {
      return { ok: false, reason: 'That deposit was too small to buy any Gold.', retry: false };
    }
    return { ok: true, whole };
  } catch {
    return { ok: false, reason: 'Could not reach the chain to price that deposit.', retry: true };
  }
}

/**
 * Paying for something, in whichever world the build is running in.
 *
 * There are two, and the difference is one environment variable:
 *
 * **No token deployed.** `charge()` moves a number in this browser's ledger and
 * adds it to a burn total. Nothing leaves anybody's wallet because there is
 * nothing to leave it. Every panel says so.
 *
 * **A token deployed.** The player signs a transfer to the burn address and the
 * tokens are gone — checkable on any explorer, with no contract of ours
 * involved. The local ledger stops being the record and becomes a cache of what
 * the chain says.
 *
 * Everything that costs $EMERGE goes through here so the two paths can never
 * drift apart, and so that adding the contract is one variable rather than
 * seven edits.
 */

import { burnTokens, tokenBalance, tokenLive } from './emerge';
import { charge, type VaultLedger } from './vault';

export interface SpendResult {
  ok: boolean;
  /** The ledger to store. Unchanged when the spend failed. */
  ledger: VaultLedger;
  /** Why it failed, for the panel to print. Null on success. */
  refused: string | null;
  /** Set when the burn actually happened on chain. */
  txHash: string | null;
}

/**
 * Take `cost` $EMERGE off a player, for good.
 *
 * A refusal must cost nothing: callers apply the returned ledger only when
 * `ok`, and a wallet prompt the player dismisses is a refusal like any other.
 */
export async function spend(
  ledger: VaultLedger,
  cost: number,
  address: string | null,
): Promise<SpendResult> {
  if (!(cost > 0)) return { ok: true, ledger, refused: null, txHash: null };

  if (!tokenLive()) {
    const paid = charge(ledger, cost);
    if (!paid) {
      return {
        ok: false,
        ledger,
        refused: `That costs ${cost.toLocaleString()} and you hold ${Math.floor(ledger.balance).toLocaleString()}.`,
        txHash: null,
      };
    }
    return { ok: true, ledger: paid, refused: null, txHash: null };
  }

  if (!address) {
    return { ok: false, ledger, refused: 'Connect a wallet to pay.', txHash: null };
  }
  if (ledger.balance < cost) {
    return {
      ok: false,
      ledger,
      refused: `That costs ${cost.toLocaleString()} and your wallet holds ${Math.floor(ledger.balance).toLocaleString()}.`,
      txHash: null,
    };
  }

  const burn = await burnTokens(address, cost);
  if (!burn.ok) return { ok: false, ledger, refused: burn.message, txHash: null };

  /*
   * Read the wallet back rather than subtracting.
   *
   * The chain is the authority once it exists, and the transaction may not have
   * been mined yet — so the optimistic figure is used only if the read fails,
   * and the balance poll corrects it either way within half a minute.
   */
  const fresh = await tokenBalance(address);
  return {
    ok: true,
    ledger: {
      ...ledger,
      balance: fresh ?? Math.max(0, ledger.balance - cost),
      burnedEmerge: ledger.burnedEmerge + cost,
    },
    refused: null,
    txHash: burn.txHash,
  };
}

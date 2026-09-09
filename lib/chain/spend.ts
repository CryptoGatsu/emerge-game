/**
 * Paying for something, in whichever world the build is running in.
 *
 * There are two, and the difference is one environment variable:
 *
 * **No token deployed.** `charge()` moves a number in this browser's ledger and
 * adds it to a burn total. Nothing leaves anybody's wallet because there is
 * nothing to leave it. Every panel says so.
 *
 * **A token deployed.** The player signs one transfer into the vault. The vault
 * burns three quarters of it itself and keeps a quarter to pay withdrawals from —
 * both checkable on any explorer, with no contract of ours involved. Without a
 * vault configured the charge is burned outright, as it always was. The local
 * ledger stops being the record and becomes a cache of what the chain says.
 *
 * Everything that costs $EMERGE goes through here so the two paths can never
 * drift apart, and so that adding the contract is one variable rather than
 * seven edits.
 */

import { VAULT_ADDRESS, burnTokens, tokenBalance, tokenLive, transferTokens, vaultLive } from './emerge';
import { charge, chargeSplit, type VaultLedger } from './vault';

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
/*
 * Which build this page is.
 *
 * Stamped into the page by the build that served it and remembered here by
 * the update notice on mount. Before any real payment the page asks the
 * server which build is answering, and a page that is behind does not pay:
 * its prices are the old build's, and a payment at an old price is a payment
 * the registry has to bank rather than accept. The notice offered a reload
 * and a "later"; later was five payments on one wallet.
 */
let pageBuild: string | null = null;

/** The update notice tells this module which build the page is. */
export function rememberBuild(build: string) {
  pageBuild = build || null;
}

/** For tests: what the page believes it is. */
export function pageBuildId(): string | null {
  return pageBuild;
}

export const STALE_BUILD = 'This page is on an older build of the game, so its prices may be out of date. Reload the page and try again — your land and your balance are safe.';
export const BUILD_UNKNOWN = 'Could not reach the game to confirm this page is current. Nothing was paid. Check your connection and try again.';

/**
 * Whether this page may pay: it is the build the server is running, or
 * neither side is stamped. A page that cannot ask does not pay.
 */
export async function buildIsCurrent(): Promise<{ ok: true } | { ok: false; refused: string }> {
  if (!pageBuild || pageBuild === 'local') return { ok: true };
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return { ok: false, refused: BUILD_UNKNOWN };
    const json = (await response.json()) as { build?: string };
    const now = typeof json.build === 'string' ? json.build : '';
    if (!now || now === 'local' || now === pageBuild) return { ok: true };
    // The notice shows itself the moment it hears this, rather than on its
    // next five-minute poll.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('emerge:check-build'));
    return { ok: false, refused: STALE_BUILD };
  } catch {
    return { ok: false, refused: BUILD_UNKNOWN };
  }
}

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
  const current = await buildIsCurrent();
  if (!current.ok) return { ok: false, ledger, refused: current.refused, txHash: null };

  // Into the vault where there is one: most to burn, a share to pay withdrawals.
  const burn = vaultLive()
    ? await transferTokens(address, VAULT_ADDRESS, cost)
    : await burnTokens(address, cost);
  if (!burn.ok) return { ok: false, ledger, refused: burn.message, txHash: null };

  /*
   * Read the wallet back rather than subtracting.
   *
   * The chain is the authority once it exists, and the transaction may not have
   * been mined yet — so the optimistic figure is used only if the read fails,
   * and the balance poll corrects it either way within half a minute.
   */
  return {
    ok: true,
    ledger: await settleBurn(ledger, cost, address, vaultLive() ? chargeSplit(cost) : undefined),
    refused: null,
    txHash: burn.txHash,
  };
}

/**
 * Pay another player, wallet to wallet.
 *
 * The one movement of $EMERGE in the game that is neither burned nor vaulted:
 * a plot bought from its owner is paid for to that owner. With a token
 * deployed the buyer signs a plain transfer to the seller's address; without
 * one the buyer's local ledger is debited and nothing else moves, which the
 * panel says.
 */
export async function pay(
  ledger: VaultLedger,
  cost: number,
  from: string | null,
  to: string,
): Promise<SpendResult> {
  if (!(cost > 0)) return { ok: true, ledger, refused: null, txHash: null };
  if (!tokenLive()) {
    if (ledger.balance < cost) {
      return {
        ok: false, ledger, txHash: null,
        refused: `That costs ${cost.toLocaleString()} and you hold ${Math.floor(ledger.balance).toLocaleString()}.`,
      };
    }
    return { ok: true, ledger: { ...ledger, balance: ledger.balance - cost }, refused: null, txHash: null };
  }
  if (!from) return { ok: false, ledger, refused: 'Connect a wallet to pay.', txHash: null };
  const current = await buildIsCurrent();
  if (!current.ok) return { ok: false, ledger, refused: current.refused, txHash: null };
  if (ledger.balance < cost) {
    return {
      ok: false, ledger, txHash: null,
      refused: `That costs ${cost.toLocaleString()} and your wallet holds ${Math.floor(ledger.balance).toLocaleString()}.`,
    };
  }
  const sent = await transferTokens(from, to, cost);
  if (!sent.ok) return { ok: false, ledger, refused: sent.message, txHash: null };
  const fresh = await tokenBalance(from);
  return {
    ok: true,
    ledger: { ...ledger, balance: fresh ?? Math.max(0, ledger.balance - cost) },
    refused: null,
    txHash: sent.txHash,
  };
}

/**
 * Bring the ledger up to date after tokens were burned somewhere else.
 *
 * The land registry takes its own payment and burns it inside the contract, so
 * the tokens are gone without `spend()` having sent anything. The running burn
 * total still has to count them, and the balance still has to be re-read —
 * this is that, kept here so the arithmetic lives in one file rather than
 * being repeated at every call site that has its own way of paying.
 */
export async function settleBurn(
  ledger: VaultLedger,
  cost: number,
  address: string,
  split?: { kept: number; burned: number; dividend: number },
): Promise<VaultLedger> {
  const fresh = await tokenBalance(address);
  return {
    ...ledger,
    balance: fresh ?? Math.max(0, ledger.balance - cost),
    burnedEmerge: ledger.burnedEmerge + (split ? split.burned : cost),
    fundedEmerge: (ledger.fundedEmerge ?? 0) + (split ? split.kept + split.dividend : 0),
  };
}

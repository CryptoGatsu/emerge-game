import 'server-only';

/**
 * The vault's signature.
 *
 * This is the only file in the project that can move money without a person
 * clicking something, and it is deliberately small and dull. It loads one
 * private key from the environment, sends ERC-20 transfers out of the wallet
 * that key controls, and does nothing else. It cannot mint, cannot approve,
 * cannot call an arbitrary contract, and cannot send the chain's native token.
 * If it is ever asked to do more than `transfer(to, amount)` on the configured
 * $EMERGE contract, that is a bug rather than a feature.
 *
 * `import 'server-only'` is the first line for a reason: it makes the build
 * fail rather than succeed if any client component ever pulls this in, so the
 * key cannot reach a browser bundle by accident.
 *
 * **The key.** `EMERGE_VAULT_PRIVATE_KEY`, without a `NEXT_PUBLIC_` prefix, so
 * Next will not inline it into client JavaScript. It is read here, used here,
 * and never returned, logged or included in any response — errors from this
 * module are rewritten into sentences a player can read, because a raw signing
 * error can carry the request that produced it.
 *
 * **Nonces.** Serverless runs every request in its own instance, so two
 * withdrawals arriving together would read the same nonce, build two
 * transactions on it, and the chain would keep one. A short lock in the shared
 * store covers reading the nonce, signing and broadcasting — the only stretch
 * where that matters.
 */

import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACTIVE_CHAIN, TOKEN } from '../chain/emerge';
import { serverKey } from '../limits';
import { releaseLock, takeLock } from './kv';

/** The key, or null when this deployment is not configured to pay anybody. */
function vaultKey(): Hex | null {
  const raw = (process.env.EMERGE_VAULT_PRIVATE_KEY ?? '').trim();
  if (!raw) return null;
  const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

/** True when the vault can sign. Safe to call from anywhere; reveals nothing. */
export const vaultCanSign = () => vaultKey() !== null;

/**
 * The address the key controls.
 *
 * Derived rather than configured, and checked against `NEXT_PUBLIC_EMERGE_VAULT`
 * by the caller: a key for a different wallet than the one deposits are sent to
 * is a misconfiguration that would otherwise show up as an empty vault.
 */
export function vaultAddress(): string | null {
  const key = vaultKey();
  if (!key) return null;
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return null;
  }
}

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const reader = () => createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });

/** The $EMERGE contract this deployment pays in, or null. */
const token = () => ACTIVE_CHAIN.tokenAddress;

const ERC20 = [
  {
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }],
  },
] as const;

/**
 * Roughly what one ERC-20 transfer costs, with room to spare.
 *
 * Used as a floor rather than an estimate: the point is to notice an empty
 * vault before signing, not to price the transaction.
 */
const MIN_GAS_WEI = 2_000_000_000_000_000n; // 0.002 native

/** How long the nonce lock is held before it is assumed to have died. */
const LOCK_SECONDS = 45;
const NONCE_LOCK = serverKey('vault:nonce');

export interface VaultHealth {
  ok: boolean;
  /** Whole $EMERGE the vault holds. */
  tokens: number;
  /** Native balance in wei, for gas. */
  gas: bigint;
  /** Set when something is wrong, in words a player could be shown. */
  problem: string | null;
}

/**
 * Whether the vault can actually pay right now.
 *
 * Read before every payout rather than assumed, because the two ways this
 * silently stops working — the vault running out of $EMERGE, and the vault
 * running out of gas to send it with — both look like a failed transaction to
 * a player and like nothing at all to us.
 */
export async function vaultHealth(): Promise<VaultHealth> {
  const address = vaultAddress();
  if (!address || !token()) {
    return { ok: false, tokens: 0, gas: 0n, problem: 'The vault is not configured to pay out.' };
  }
  try {
    const client = reader();
    const [units, gas, decimals] = await Promise.all([
      client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'balanceOf', args: [address as Hex] }),
      client.getBalance({ address: address as Hex }),
      client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'decimals' }),
    ]);
    const tokens = Number(units / 10n ** BigInt(decimals));
    /*
     * Enough gas for a transfer, not merely more than zero.
     *
     * A vault with a few wei left would pass a non-zero check and then fail
     * every transaction, which reads to a player as the game refusing to pay.
     * Better to say so before signing.
     */
    if (gas < MIN_GAS_WEI) {
      return { ok: false, tokens, gas, problem: 'The vault is out of gas to send with. This is ours to fix, not yours.' };
    }
    return { ok: true, tokens, gas, problem: null };
  } catch {
    return { ok: false, tokens: 0, gas: 0n, problem: 'Could not reach the chain to check the vault.' };
  }
}

export type SendResult =
  | { ok: true; txHash: string }
  | { ok: false; problem: string };

/**
 * Send $EMERGE out of the vault.
 *
 * Everything that decides *whether* to send lives in the caller; this decides
 * only how. It refuses rather than throws, and the sentence it refuses with is
 * safe to show a player — nothing here passes an underlying error outward,
 * because those carry the request that produced them.
 */
export async function sendFromVault(to: string, whole: number): Promise<SendResult> {
  const key = vaultKey();
  if (!key) return { ok: false, problem: 'The vault is not configured to pay out.' };
  if (!token()) return { ok: false, problem: `No ${TOKEN.ticker} contract is configured.` };
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { ok: false, problem: 'That is not a wallet address.' };
  const amount = Math.floor(whole);
  if (!(amount > 0)) return { ok: false, problem: 'There is nothing to send.' };

  if (!(await takeLock(NONCE_LOCK, LOCK_SECONDS))) {
    return { ok: false, problem: 'The vault is sending something else. Try again in a moment.' };
  }

  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    const wallet = createWalletClient({ account, chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });

    const decimals = await client.readContract({
      address: token() as Hex, abi: ERC20, functionName: 'decimals',
    });
    const units = parseUnits(String(amount), Number(decimals));

    const held = await client.readContract({
      address: token() as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address],
    });
    if (held < units) {
      // Said plainly. A player whose withdrawal fails is owed an explanation
      // that is true, and "the vault is short" is both true and ours to fix.
      return { ok: false, problem: 'The vault cannot cover that right now. Nothing has been taken from your balance.' };
    }

    // `pending` rather than `latest`: a transaction we sent seconds ago and the
    // chain has not mined yet still owns its nonce.
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });

    const txHash = await wallet.writeContract({
      address: token() as Hex,
      abi: ERC20,
      functionName: 'transfer',
      args: [to as Hex, units],
      nonce,
    });
    return { ok: true, txHash };
  } catch {
    return { ok: false, problem: 'The transfer could not be sent. Nothing has been taken from your balance.' };
  } finally {
    await releaseLock(NONCE_LOCK);
  }
}

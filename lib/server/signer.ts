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
import { ACTIVE_CHAIN, BURN_ADDRESS, GLD_ADDRESS, SWAP_ROUTER, TOKEN, burnTargetBroken, tokenBurnable } from '../chain/emerge';
import { serverKey } from '../limits';
import { releaseLock, takeLock } from './kv';
import { PERMIT2, PERMIT2_ADDRESS, QUOTER_V2, UNIVERSAL_ROUTER, parseRoute, universalSwap, v3Path } from '../chain/universal';

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
    type: 'function', name: 'burn', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [],
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

/**
 * Burn $EMERGE out of the vault: the share of every charge the vault owes the
 * burn address. `burn(uint256)` where the token has it, a transfer to the burn
 * address otherwise, and a refusal rather than a reverting transaction when
 * neither would work.
 */
export async function burnFromVault(whole: number): Promise<SendResult> {
  const key = vaultKey();
  if (!key) return { ok: false, problem: 'The vault is not configured to sign.' };
  if (!token()) return { ok: false, problem: `No ${TOKEN.ticker} contract is configured.` };
  const amount = Math.floor(whole);
  if (!(amount > 0)) return { ok: false, problem: 'There is nothing to burn.' };
  if (!tokenBurnable() && burnTargetBroken()) {
    return { ok: false, problem: 'This build has no working burn target.' };
  }
  if (!(await takeLock(NONCE_LOCK, LOCK_SECONDS))) {
    return { ok: false, problem: 'The vault is sending something else. Try again in a moment.' };
  }
  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    const wallet = createWalletClient({ account, chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const decimals = await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'decimals' });
    const units = parseUnits(String(amount), Number(decimals));
    const held = await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    if (held < units) return { ok: false, problem: 'The vault holds less than it owes the burn address.' };
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const txHash = tokenBurnable()
      ? await wallet.writeContract({ address: token() as Hex, abi: ERC20, functionName: 'burn', args: [units], nonce })
      : await wallet.writeContract({ address: token() as Hex, abi: ERC20, functionName: 'transfer', args: [BURN_ADDRESS as Hex, units], nonce });
    return { ok: true, txHash };
  } catch {
    return { ok: false, problem: 'The burn could not be sent.' };
  } finally {
    await releaseLock(NONCE_LOCK);
  }
}

const ERC20_APPROVE = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const ROUTER_V2 = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ type: 'uint256[]' }] },
] as const;
const ROUTER_V3 = [
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type TokenSend = { ok: true; txHash: string } | { ok: false; problem: string };

/** Send any ERC-20 the vault holds, in base units. GLD dividends go out this way. */
export async function sendTokenFromVault(tokenAddress: string, to: string, units: bigint): Promise<TokenSend> {
  const key = vaultKey();
  if (!key) return { ok: false, problem: 'The vault is not configured to pay out.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return { ok: false, problem: 'That is not an address.' };
  if (!(units > 0n)) return { ok: false, problem: 'There is nothing to send.' };
  if (!(await takeLock(NONCE_LOCK, LOCK_SECONDS))) return { ok: false, problem: 'The vault is sending something else. Try again in a moment.' };
  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    const wallet = createWalletClient({ account, chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const held = await client.readContract({ address: tokenAddress as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    if (held < units) return { ok: false, problem: 'The vault holds less than that.' };
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const txHash = await wallet.writeContract({ address: tokenAddress as Hex, abi: ERC20, functionName: 'transfer', args: [to as Hex, units], nonce });
    return { ok: true, txHash };
  } catch {
    return { ok: false, problem: 'The transfer could not be sent.' };
  } finally {
    await releaseLock(NONCE_LOCK);
  }
}

export type Swap = { ok: true; txHash: string; received: bigint; unquoted?: boolean } | { ok: false; problem: string };

/**
 * Swap $EMERGE the vault holds into GLD through the router.
 *
 * Three shapes, picked by `EMERGE_SWAP_KIND`:
 *
 *  - `universal`: Uniswap's Universal Router, which is what Robinhood Chain
 *    has. One `execute` with a V3 exact-input command along the route in
 *    `EMERGE_SWAP_PATH` (fee, token, fee…; GLD's pool is against USDG, so
 *    the route goes through it). Paid through Permit2, so the tokens never
 *    rest in the router. Floored three percent under QuoterV2's answer when
 *    `EMERGE_SWAP_QUOTER` is set; unfloored, and said so, when it is not.
 *  - `v3`: a plain SwapRouter's `exactInputSingle`, fee from `EMERGE_SWAP_FEE`.
 *  - `v2`, the default: `swapExactTokensForTokens`, floored under `getAmountsOut`.
 *
 * What was received is measured from the vault's GLD balance before and
 * after, which is the one figure that does not depend on the router's
 * return value. Every send is simulated first, so a route that cannot
 * fill fails before any gas is spent.
 */
export async function swapForGld(wholeEmerge: number): Promise<Swap> {
  const key = vaultKey();
  if (!key) return { ok: false, problem: 'The vault is not configured to sign.' };
  if (!token()) return { ok: false, problem: `No ${TOKEN.ticker} contract is configured.` };
  const amount = Math.floor(wholeEmerge);
  if (!(amount > 0)) return { ok: false, problem: 'There is nothing to swap.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(SWAP_ROUTER) || !/^0x[0-9a-fA-F]{40}$/.test(GLD_ADDRESS)) return { ok: false, problem: 'No router or GLD address is configured.' };
  if (!(await takeLock(NONCE_LOCK, LOCK_SECONDS * 2))) return { ok: false, problem: 'The vault is sending something else.' };
  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    const wallet = createWalletClient({ account, chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const decimals = await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'decimals' });
    const units = parseUnits(String(amount), Number(decimals));
    const held = await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    if (held < units) return { ok: false, problem: 'The vault holds less than the pool.' };
    const before = await client.readContract({ address: GLD_ADDRESS as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    let nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const allowance = await client.readContract({ address: token() as Hex, abi: ERC20_APPROVE, functionName: 'allowance', args: [account.address, SWAP_ROUTER as Hex] });
    if (allowance < units) {
      const approveTx = await wallet.writeContract({ address: token() as Hex, abi: ERC20_APPROVE, functionName: 'approve', args: [SWAP_ROUTER as Hex, units], nonce });
      await client.waitForTransactionReceipt({ hash: approveTx });
      nonce += 1;
    }
    const kind = (process.env.EMERGE_SWAP_KIND ?? 'v2').toLowerCase();
    let txHash: Hex;
    let unquoted = false;
    if (kind === 'universal') {
      // Permit2 pays the router out of the vault: the token approves Permit2
      // once, and Permit2 approves the router for this amount and the hour.
      const permit2 = ((process.env.EMERGE_PERMIT2 ?? PERMIT2_ADDRESS) as Hex);
      const toPermit = await client.readContract({ address: token() as Hex, abi: ERC20_APPROVE, functionName: 'allowance', args: [account.address, permit2] });
      if (toPermit < units) {
        const tx = await wallet.writeContract({ address: token() as Hex, abi: ERC20_APPROVE, functionName: 'approve', args: [permit2, 2n ** 256n - 1n], nonce });
        await client.waitForTransactionReceipt({ hash: tx });
        nonce += 1;
      }
      const now = Math.floor(Date.now() / 1000);
      const [granted, expires] = await client.readContract({ address: permit2, abi: PERMIT2, functionName: 'allowance', args: [account.address, token() as Hex, SWAP_ROUTER as Hex] });
      if (granted < units || expires <= now + 300) {
        const tx = await wallet.writeContract({ address: permit2, abi: PERMIT2, functionName: 'approve', args: [token() as Hex, SWAP_ROUTER as Hex, units, now + 3600], nonce });
        await client.waitForTransactionReceipt({ hash: tx });
        nonce += 1;
      }
      const route = parseRoute(process.env.EMERGE_SWAP_PATH, Number(process.env.EMERGE_SWAP_FEE) || 3000);
      const path = v3Path(token() as Hex, route, GLD_ADDRESS as Hex);
      let minOut = 0n;
      const quoter = process.env.EMERGE_SWAP_QUOTER ?? '';
      if (/^0x[0-9a-fA-F]{40}$/.test(quoter)) {
        const [quoted] = await client.readContract({ address: quoter as Hex, abi: QUOTER_V2, functionName: 'quoteExactInput', args: [path, units] });
        minOut = (quoted * 97n) / 100n;
      } else unquoted = true;
      const { commands, inputs } = universalSwap(account.address, units, minOut, path);
      const deadline = BigInt(now + 600);
      const { request } = await client.simulateContract({ account, address: SWAP_ROUTER as Hex, abi: UNIVERSAL_ROUTER, functionName: 'execute', args: [commands, inputs, deadline], nonce });
      txHash = await wallet.writeContract(request);
    } else if (kind === 'v3') {
      const fee = Number(process.env.EMERGE_SWAP_FEE) || 3000;
      txHash = await wallet.writeContract({
        address: SWAP_ROUTER as Hex, abi: ROUTER_V3, functionName: 'exactInputSingle',
        args: [{ tokenIn: token() as Hex, tokenOut: GLD_ADDRESS as Hex, fee, recipient: account.address, amountIn: units, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
        nonce,
      });
    } else {
      const path = [token() as Hex, GLD_ADDRESS as Hex];
      const quote = await client.readContract({ address: SWAP_ROUTER as Hex, abi: ROUTER_V2, functionName: 'getAmountsOut', args: [units, path] });
      const floor = (quote[quote.length - 1] * 97n) / 100n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      txHash = await wallet.writeContract({ address: SWAP_ROUTER as Hex, abi: ROUTER_V2, functionName: 'swapExactTokensForTokens', args: [units, floor, path, account.address, deadline], nonce });
    }
    await client.waitForTransactionReceipt({ hash: txHash });
    const after = await client.readContract({ address: GLD_ADDRESS as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    return { ok: true, txHash, received: after > before ? after - before : 0n, unquoted };
  } catch (error) {
    const why = error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : 'unknown';
    return { ok: false, problem: `The swap could not be sent: ${why}` };
  } finally {
    await releaseLock(NONCE_LOCK);
  }
}

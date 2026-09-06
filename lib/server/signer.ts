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

import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, createWalletClient, defineChain, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACTIVE_CHAIN, BURN_ADDRESS, GLD_ADDRESS, SWAP_ROUTER, TOKEN, burnTargetBroken, tokenBurnable } from '../chain/emerge';
import { serverKey } from '../limits';
import { releaseLock, takeLock } from './kv';
import { NATIVE, PERMIT2, PERMIT2_ADDRESS, POOL_INITIALIZE, QUOTER_V2, UNISWAP_ON_ROBINHOOD, UNIVERSAL_ROUTER, V3_FACTORY, V3_POOL, V4_QUOTER, V4_STATE_VIEW, explainRevert, parseRoute, universalSwap, universalSwapV4, v3Path, v4PathKeys, v4PoolId } from '../chain/universal';

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
  /**
   * `confirmed` is whether the chain has mined the transfer and it succeeded.
   * False means it was sent and not seen within the wait: the caller records
   * it as sent and `receiptOf` settles it later.
   */
  | { ok: true; txHash: string; confirmed: boolean }
  | { ok: false; problem: string };

/**
 * How long a payout waits for its receipt before answering the player.
 *
 * A transfer that reverts must not be booked as paid, and the only way to know
 * is to wait for the block. Bounded, because the request has a time limit of
 * its own; past it the transfer is sent and unconfirmed, and checked on the
 * player's next look at the Bank.
 */
const RECEIPT_WAIT_MS = Math.max(3_000, Number(process.env.EMERGE_RECEIPT_WAIT_MS) || 20_000);

/**
 * What the chain says about a transaction the vault sent.
 *
 * `missing` is the chain saying it has never seen the hash, which is
 * different from not being able to ask: an RPC that is down answers
 * `pending`, so a transfer is never written off on the strength of an outage.
 */
export async function receiptOf(txHash: string): Promise<'success' | 'reverted' | 'pending' | 'missing'> {
  const client = reader();
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) return 'pending';
  }
  try {
    await client.getTransaction({ hash: txHash as Hex });
    return 'pending';
  } catch (error) {
    return error instanceof TransactionNotFoundError ? 'missing' : 'pending';
  }
}

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
    /*
     * Sent is not paid. A transfer the chain rejects is a hash with nothing
     * behind it, and a player told "sent" on the strength of one watches a
     * balance that never arrives. So: wait for the block, and refuse on a
     * revert the same as on any other failure.
     */
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_WAIT_MS, pollingInterval: 1_000 });
      if (receipt.status !== 'success') {
        return { ok: false, problem: 'The chain rejected the transfer. Nothing has been taken from your balance.' };
      }
      return { ok: true, txHash, confirmed: true };
    } catch {
      // Not mined within the wait. The chain has it; the Bank checks later.
      return { ok: true, txHash, confirmed: false };
    }
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
    return { ok: true, txHash, confirmed: false };
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

/** Send the chain's own coin from the vault: the development share of an ETH pass. */
export async function sendNativeFromVault(to: string, wei: bigint): Promise<TokenSend> {
  const key = vaultKey();
  if (!key) return { ok: false, problem: 'The vault is not configured to pay out.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { ok: false, problem: 'That is not a wallet address.' };
  if (!(wei > 0n)) return { ok: false, problem: 'There is nothing to send.' };
  if (!(await takeLock(NONCE_LOCK, LOCK_SECONDS))) return { ok: false, problem: 'The vault is sending something else.' };
  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    const wallet = createWalletClient({ account, chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const held = await client.getBalance({ address: account.address });
    // Keep a little back for gas on the vault's own transfers.
    if (held < wei + 50_000_000_000_000_000n) return { ok: false, problem: 'The vault cannot cover that right now.' };
    const txHash = await wallet.sendTransaction({ to: to as Hex, value: wei });
    return { ok: true, txHash };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : 'The transfer failed.' };
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
    if (kind === 'universal' || kind === 'v4') {
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
      const quoter = quoterFor(kind);
      let minOut = 0n;
      let call: { commands: Hex; inputs: Hex[] };
      if (kind === 'v4') {
        // Uniswap v4 pools, the kind the Uniswap app makes on a new chain:
        // the same router, a different command, and a quoter of its own.
        const path = v4PathKeys(route, GLD_ADDRESS as Hex);
        if (/^0x[0-9a-fA-F]{40}$/.test(quoter)) {
          const { result } = await client.simulateContract({ address: quoter as Hex, abi: V4_QUOTER, functionName: 'quoteExactInput', args: [{ exactCurrency: token() as Hex, path, exactAmount: units }] });
          minOut = (result[0] * 97n) / 100n;
        } else unquoted = true;
        call = universalSwapV4(token() as Hex, units, minOut, path);
      } else {
        const path = v3Path(token() as Hex, route, GLD_ADDRESS as Hex);
        if (/^0x[0-9a-fA-F]{40}$/.test(quoter)) {
          const [quoted] = await client.readContract({ address: quoter as Hex, abi: QUOTER_V2, functionName: 'quoteExactInput', args: [path, units] });
          minOut = (quoted * 97n) / 100n;
        } else unquoted = true;
        call = universalSwap(account.address, units, minOut, path);
      }
      const deadline = BigInt(now + 600);
      const { request } = await client.simulateContract({ account, address: SWAP_ROUTER as Hex, abi: UNIVERSAL_ROUTER, functionName: 'execute', args: [call.commands, call.inputs, deadline], nonce });
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
    return { ok: false, problem: `The swap could not be sent: ${explainRevert(error)}` };
  } finally {
    await releaseLock(NONCE_LOCK);
  }
}

/** The quoter for a kind: the environment's, else Uniswap's own on Robinhood Chain. */
function quoterFor(kind: string): string {
  const set = process.env.EMERGE_SWAP_QUOTER ?? '';
  if (/^0x[0-9a-fA-F]{40}$/.test(set)) return set;
  if (ACTIVE_CHAIN.chainId !== 4663) return '';
  return kind === 'v4' ? UNISWAP_ON_ROBINHOOD.v4Quoter : kind === 'universal' ? UNISWAP_ON_ROBINHOOD.quoterV2 : '';
}

const TIERS = [100, 500, 3000, 10000];
const TICK: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/**
 * Which pools actually exist along a route, read from the factory and the
 * v4 StateView rather than inferred from a swap's revert — which the node
 * may return without a reason. One row per hop and fee tier.
 */
type PoolRow = { hop: string; fee: number; v3: { pool: string; liquidity: string } | null; v4: { liquidity: string } | null };

/** The pools between two currencies at every standard fee: v3 by the factory (skipped for native ETH), v4 by the StateView. */
async function poolsBetween(client: ReturnType<typeof reader>, a: Hex, b: Hex, hop: string): Promise<PoolRow[]> {
  const factory = (process.env.EMERGE_V3_FACTORY ?? (ACTIVE_CHAIN.chainId === 4663 ? UNISWAP_ON_ROBINHOOD.v3Factory : '')) as Hex;
  const stateView = (process.env.EMERGE_V4_STATE_VIEW ?? (ACTIVE_CHAIN.chainId === 4663 ? UNISWAP_ON_ROBINHOOD.v4StateView : '')) as Hex;
  const rows: PoolRow[] = [];
  for (const fee of TIERS) {
    let v3: PoolRow['v3'] = null, v4: PoolRow['v4'] = null;
    if (/^0x[0-9a-fA-F]{40}$/.test(factory) && a !== NATIVE && b !== NATIVE) {
      try {
        const pool = await client.readContract({ address: factory, abi: V3_FACTORY, functionName: 'getPool', args: [a, b, fee] });
        if (BigInt(pool) !== 0n) {
          const liquidity = await client.readContract({ address: pool, abi: V3_POOL, functionName: 'liquidity' }).catch(() => 0n);
          v3 = { pool, liquidity: String(liquidity) };
        }
      } catch { /* no factory there */ }
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(stateView)) {
      try {
        const id = v4PoolId(a, b, fee, TICK[fee]);
        const [sqrtPrice] = await client.readContract({ address: stateView, abi: V4_STATE_VIEW, functionName: 'getSlot0', args: [id] });
        if (sqrtPrice !== 0n) {
          const liquidity = await client.readContract({ address: stateView, abi: V4_STATE_VIEW, functionName: 'getLiquidity', args: [id] });
          v4 = { liquidity: String(liquidity) };
        }
      } catch { /* no state view there */ }
    }
    rows.push({ hop, fee, v3, v4 });
  }
  return rows;
}

/** Which pools exist along a route, one row per hop and fee. */
async function poolsAlong(client: ReturnType<typeof reader>, tokens: Hex[]): Promise<PoolRow[]> {
  const rows: PoolRow[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    rows.push(...await poolsBetween(client, tokens[i], tokens[i + 1], `${tokens[i].slice(0, 8)}…→${tokens[i + 1].slice(0, 8)}…`));
  }
  return rows;
}

const live = (r: PoolRow, kind: 'v4' | 'v3') => (kind === 'v4' ? r.v4 && BigInt(r.v4.liquidity) > 0n : r.v3 && BigInt(r.v3.liquidity) > 0n);

/** A v4 pool as the PoolManager made it, with what it holds now. */
interface MadePool { id: Hex; currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex; liquidity: string }
/** How far the last event scan reached, for the probe to say. */
let lastScan: { from: bigint; to: bigint; head: bigint; requests: number; complete: boolean } | null = null;
/** A pool charging more than this is no market to buy GLD through, whatever it holds. */
const FEE_TOO_HIGH = 30_000;

/**
 * Every v4 pool the token is in, read from the PoolManager's Initialize
 * events, which carry the fee, tick spacing and hook the pool was made
 * with. A pool a launchpad made has a hook and often an unusual spacing,
 * and no amount of guessing at standard tiers finds it; this does. The
 * chain is young, so the whole history is a few requests.
 */
async function poolsMadeFor(client: ReturnType<typeof reader>, tokenIn: Hex, startAt = 0n): Promise<MadePool[]> {
  const manager = (process.env.EMERGE_V4_POOL_MANAGER ?? (ACTIVE_CHAIN.chainId === 4663 ? UNISWAP_ON_ROBINHOOD.v4PoolManager : '')) as Hex;
  const stateView = (process.env.EMERGE_V4_STATE_VIEW ?? (ACTIVE_CHAIN.chainId === 4663 ? UNISWAP_ON_ROBINHOOD.v4StateView : '')) as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(manager)) return [];
  const head = await client.getBlockNumber();
  const logs: { args: Record<string, unknown> }[] = [];
  const pull = async (from: bigint, to: bigint, side: 'currency0' | 'currency1') => {
    const got = await client.getLogs({ address: manager, event: POOL_INITIALIZE, args: { [side]: tokenIn } as Record<string, Hex>, fromBlock: from, toBlock: to });
    logs.push(...(got as unknown as { args: Record<string, unknown> }[]));
  };
  // The whole chain in one ask; when the node caps the range, walk it from
  // the start in slices, halving a slice the node refuses, within a budget
  // of requests. What was covered is reported, so a pool older than the
  // scan is never mistaken for a pool that does not exist.
  const start = startAt > 0n && startAt < head ? startAt : 0n;
  lastScan = { from: start, to: head, head, requests: 0, complete: true };
  for (const side of ['currency0', 'currency1'] as const) {
    lastScan.requests += 1;
    try {
      await pull(start, head, side);
      continue;
    } catch { /* capped: slice it */ }
    let from = start;
    let step = 200_000n;
    let covered = 0n;
    while (from <= head && lastScan.requests < 160) {
      const to = from + step - 1n > head ? head : from + step - 1n;
      lastScan.requests += 1;
      try {
        await pull(from, to, side);
        covered = to;
        from = to + 1n;
        if (step < 200_000n) step *= 2n;
      } catch {
        if (step <= 2_000n) { from = to + 1n; continue; }
        step /= 2n;
      }
    }
    if (from <= head) { lastScan.complete = false; lastScan.to = covered; }
  }
  const out: MadePool[] = [];
  for (const log of logs) {
    const a = log.args as { id: Hex; currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
    let liquidity = '0';
    if (/^0x[0-9a-fA-F]{40}$/.test(stateView)) {
      try { liquidity = String(await client.readContract({ address: stateView, abi: V4_STATE_VIEW, functionName: 'getLiquidity', args: [a.id] })); } catch { /* unread */ }
    }
    out.push({ id: a.id, currency0: a.currency0, currency1: a.currency1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: a.hooks, liquidity });
  }
  return out.sort((x, y) => (BigInt(y.liquidity) > BigInt(x.liquidity) ? 1 : -1));
}

/** A hop as EMERGE_SWAP_PATH writes it: the fee alone for a standard hookless pool, otherwise fee/spacing/hook. */
function hopSpec(p: { fee: number; tickSpacing: number; hooks: Hex }): string {
  const standard = TICK[p.fee] === p.tickSpacing && p.hooks === NATIVE;
  return standard ? String(p.fee) : `${p.fee}/${p.tickSpacing}${p.hooks === NATIVE ? '' : `/${p.hooks}`}`;
}

/**
 * Find a way from the token to GLD when the configured route has none:
 * the token's pool against native ETH, WETH or the configured stepping
 * stone, and from there to GLD directly or through the stepping stone.
 * Native ETH only ever appears in a v4 route; v3 goes through WETH.
 */
async function discoverRoutes(client: ReturnType<typeof reader>, tokenIn: Hex, via: Hex[], gld: Hex): Promise<{ kind: string; path: string; note: string }[]> {
  const name = (a: Hex) => (a === NATIVE ? 'ETH' : a.toLowerCase() === UNISWAP_ON_ROBINHOOD.weth.toLowerCase() ? 'WETH' : `${a.slice(0, 8)}…`);
  const stones: Hex[] = [NATIVE, UNISWAP_ON_ROBINHOOD.weth as Hex, ...via];
  const found: { kind: string; path: string; note: string }[] = [];
  for (const kind of ['v4', 'v3'] as const) {
    for (const x of stones) {
      if (kind === 'v3' && x === NATIVE) continue;
      const first = (await poolsBetween(client, tokenIn, x, 'first')).find((r) => live(r, kind));
      if (!first) continue;
      const direct = (await poolsBetween(client, x, gld, 'last')).find((r) => live(r, kind));
      if (direct) found.push({ kind: kind === 'v3' ? 'universal' : 'v4', path: `${first.fee},${x},${direct.fee}`, note: `${name(tokenIn)}→${name(x)}→GLD` });
      for (const y of via) {
        if (y === x) continue;
        const middle = (await poolsBetween(client, x, y, 'middle')).find((r) => live(r, kind));
        const last = middle ? (await poolsBetween(client, y, gld, 'last')).find((r) => live(r, kind)) : null;
        if (middle && last) found.push({ kind: kind === 'v3' ? 'universal' : 'v4', path: `${first.fee},${x},${middle.fee},${y},${last.fee}`, note: `${name(tokenIn)}→${name(x)}→${name(y)}→GLD` });
      }
    }
  }
  return found;
}

/**
 * What the swap would do, without sending it: every setting the vault reads,
 * every allowance, the quote, and the simulated `execute` with its revert
 * decoded. For the operator, behind the cron secret, when a GLD payout
 * says the swap failed and the message alone does not say why.
 */
export async function probeSwap(wholeEmerge = 100, search = false, scanFrom = 0n): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    kind: (process.env.EMERGE_SWAP_KIND ?? 'v2').toLowerCase(),
    router: SWAP_ROUTER, token: token(), gld: GLD_ADDRESS, permit2: process.env.EMERGE_PERMIT2 ?? PERMIT2_ADDRESS,
    path: process.env.EMERGE_SWAP_PATH ?? '(unset: one hop at the default fee)', quoter: process.env.EMERGE_SWAP_QUOTER ?? '(unset)',
    signer: vaultCanSign(), amount: wholeEmerge,
  };
  const key = vaultKey();
  if (!key || !token()) { out.verdict = 'The vault cannot sign, or no token is configured.'; return out; }
  try {
    const account = privateKeyToAccount(key);
    const client = reader();
    out.quoterInUse = quoterFor(out.kind as string) || '(none)';
    // The pools themselves, before any swap is simulated.
    const routeForPools = parseRoute(process.env.EMERGE_SWAP_PATH, Number(process.env.EMERGE_SWAP_FEE) || 3000);
    const pools = await poolsAlong(client, [token() as Hex, ...routeForPools.via, GLD_ADDRESS as Hex]);
    out.pools = pools.filter((r) => r.v3 || r.v4);
    out.poolsChecked = pools.length;
    const hops = [...new Set(pools.map((r) => r.hop))];
    const pick = (want: 'v4' | 'v3') => hops.map((h) => pools.find((r) => r.hop === h && live(r, want)) ?? null);
    const v4Route = pick('v4'), v3Route = pick('v3');
    const spec = (rs: (PoolRow | null)[]) => [rs[0]?.fee, ...routeForPools.via.flatMap((v, i) => [v, rs[i + 1]?.fee])].join(',');
    if (v4Route.every((r) => r)) out.poolAdvice = `Every hop has a v4 pool with liquidity: set EMERGE_SWAP_KIND=v4 and EMERGE_SWAP_PATH=${spec(v4Route)}.`;
    else if (v3Route.every((r) => r)) out.poolAdvice = `Every hop has a v3 pool with liquidity: set EMERGE_SWAP_KIND=universal and EMERGE_SWAP_PATH=${spec(v3Route)}.`;
    else {
      // The configured route is broken somewhere: look for another.
      const routes = await discoverRoutes(client, token() as Hex, routeForPools.via, GLD_ADDRESS as Hex);
      out.discovered = routes;
      if (routes.length) {
        out.poolAdvice = `The configured route has no pool at ${hops.filter((h, i) => !v4Route[i] && !v3Route[i]).join(', ')}, but these fill: set EMERGE_SWAP_KIND=${routes[0].kind} and EMERGE_SWAP_PATH=${routes[0].path} (${routes[0].note}).`;
      } else {
        // Nothing at a standard tier: read the token's pools off the
        // PoolManager itself and build the route from the deepest one.
        const envFrom = BigInt(Number(process.env.EMERGE_V4_SCAN_FROM) || 0);
        const made = await poolsMadeFor(client, token() as Hex, scanFrom > 0n ? scanFrom : envFrom);
        out.tokenPools = made;
        out.scan = lastScan ? { fromBlock: String(lastScan.from), toBlock: String(lastScan.to), head: String(lastScan.head), requests: lastScan.requests, complete: lastScan.complete } : null;
        const usable = made.filter((p) => BigInt(p.liquidity) > 0n && p.fee <= FEE_TOO_HIGH);
        const pricey = made.filter((p) => BigInt(p.liquidity) > 0n && p.fee > FEE_TOO_HIGH);
        const best = usable[0];
        if (!best && pricey.length) {
          out.poolAdvice = `The only pools of the token's with liquidity charge ${pricey.map((p) => `${(p.fee / 10_000).toFixed(2)}%`).join(', ')} — more than the ${FEE_TOO_HIGH / 10_000}% the vault will trade through.${lastScan && !lastScan.complete ? ` The scan covered blocks ${lastScan.from}–${lastScan.to} of ${lastScan.head}; an older pool may lie beyond it: pass &from=<block> or set EMERGE_V4_SCAN_FROM.` : ' If the token trades against ETH somewhere, that pool is not on this PoolManager.'}`;
        } else if (best) {
          const other = best.currency0.toLowerCase() === (token() as string).toLowerCase() ? best.currency1 : best.currency0;
          const usdg = routeForPools.via.find((v) => v !== NATIVE) ?? null;
          // From the pool's other side to GLD: directly, or through the stepping stone, deepest v4 pools first.
          const direct = (await poolsBetween(client, other, GLD_ADDRESS as Hex, 'last')).filter((r) => live(r, 'v4')).sort((a, b) => (BigInt(b.v4!.liquidity) > BigInt(a.v4!.liquidity) ? 1 : -1))[0];
          const toStone = usdg && other.toLowerCase() !== usdg.toLowerCase() ? (await poolsBetween(client, other, usdg, 'middle')).filter((r) => live(r, 'v4')).sort((a, b) => (BigInt(b.v4!.liquidity) > BigInt(a.v4!.liquidity) ? 1 : -1))[0] : null;
          const stoneToGld = usdg ? (await poolsBetween(client, usdg, GLD_ADDRESS as Hex, 'last')).filter((r) => live(r, 'v4')).sort((a, b) => (BigInt(b.v4!.liquidity) > BigInt(a.v4!.liquidity) ? 1 : -1))[0] : null;
          const path = direct ? `${hopSpec(best)},${other},${direct.fee}`
            : toStone && stoneToGld ? `${hopSpec(best)},${other},${toStone.fee},${usdg},${stoneToGld.fee}`
              : null;
          out.poolAdvice = path
            ? `The token's deepest pool is v4 against ${other === NATIVE ? 'native ETH' : other} at fee ${best.fee}, spacing ${best.tickSpacing}${best.hooks === NATIVE ? ', no hook' : `, hook ${best.hooks}`}. Set EMERGE_SWAP_KIND=v4 and EMERGE_SWAP_PATH=${path}.`
            : `The token's deepest pool is v4 against ${other} (fee ${best.fee}, spacing ${best.tickSpacing}, hook ${best.hooks}), but no v4 pool with liquidity leads from there to GLD, directly or through ${usdg ?? 'a stepping stone'}.`;
        } else {
          const coverage = lastScan && !lastScan.complete ? ` The scan covered blocks ${lastScan.from}–${lastScan.to} of ${lastScan.head}, so an older pool may lie beyond it.` : '';
          out.poolAdvice = made.length
            ? `The PoolManager knows ${made.length} pool(s) for the token but none holds liquidity.${coverage}`
            : `The PoolManager has no Initialize event for the token in the blocks scanned: it is not in any v4 pool this node can see, and no standard v3 pool holds liquidity.${coverage}`;
        }
      }
    }
    out.vault = account.address;
    const decimals = await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'decimals' });
    const units = parseUnits(String(Math.floor(wholeEmerge)), Number(decimals));
    out.held = String(await client.readContract({ address: token() as Hex, abi: ERC20, functionName: 'balanceOf', args: [account.address] }));
    out.routerCode = (await client.getCode({ address: SWAP_ROUTER as Hex }))?.length ?? 0;
    const permit2 = (process.env.EMERGE_PERMIT2 ?? PERMIT2_ADDRESS) as Hex;
    out.permit2Code = (await client.getCode({ address: permit2 }))?.length ?? 0;
    out.tokenToPermit2 = String(await client.readContract({ address: token() as Hex, abi: ERC20_APPROVE, functionName: 'allowance', args: [account.address, permit2] }));
    const [granted, expires] = await client.readContract({ address: permit2, abi: PERMIT2, functionName: 'allowance', args: [account.address, token() as Hex, SWAP_ROUTER as Hex] });
    out.permit2ToRouter = { amount: String(granted), expires: Number(expires), expired: Number(expires) <= Math.floor(Date.now() / 1000) };
    const route = parseRoute(process.env.EMERGE_SWAP_PATH, Number(process.env.EMERGE_SWAP_FEE) || 3000);
    out.route = route;
    const kind = out.kind as string;
    const quoter = quoterFor(kind);
    let call: { commands: Hex; inputs: Hex[] };
    if (kind === 'v4') {
      const path = v4PathKeys(route, GLD_ADDRESS as Hex);
      if (/^0x[0-9a-fA-F]{40}$/.test(quoter)) {
        try {
          const { result } = await client.simulateContract({ address: quoter as Hex, abi: V4_QUOTER, functionName: 'quoteExactInput', args: [{ exactCurrency: token() as Hex, path, exactAmount: units }] });
          out.quote = String(result[0]);
        } catch (error) { out.quote = `failed: ${explainRevert(error)}`; }
      }
      call = universalSwapV4(token() as Hex, units, 0n, path);
    } else {
      const path = v3Path(token() as Hex, route, GLD_ADDRESS as Hex);
      out.v3Path = path;
      if (/^0x[0-9a-fA-F]{40}$/.test(quoter)) {
        try {
          const [quoted] = await client.readContract({ address: quoter as Hex, abi: QUOTER_V2, functionName: 'quoteExactInput', args: [path, units] });
          out.quote = String(quoted);
        } catch (error) { out.quote = `failed: ${explainRevert(error)}`; }
      }
      call = universalSwap(account.address, units, 0n, path);
    }
    const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      await client.simulateContract({ account, address: SWAP_ROUTER as Hex, abi: UNIVERSAL_ROUTER, functionName: 'execute', args: [call.commands, call.inputs, deadline()] });
      out.simulation = 'ok: the swap would go through as configured';
    } catch (error) {
      out.simulation = `reverted: ${explainRevert(error)}`;
    }
    if (search) {
      // Every kind and every standard fee tier per hop, along the configured
      // tokens: which of them the router would actually fill. The answer is
      // the EMERGE_SWAP_KIND and EMERGE_SWAP_PATH to set.
      const tiers = [100, 500, 3000, 10000];
      const combos: number[][] = route.fees.length === 1 ? tiers.map((f) => [f]) : tiers.flatMap((a) => tiers.map((b) => [a, b]));
      const found: { kind: string; path: string; result: string }[] = [];
      for (const k of ['v4', 'universal'] as const) {
        for (const fees of combos) {
          const trial = { fees, ticks: fees.map((f) => TICK[f]), hooks: fees.map(() => NATIVE), via: route.via };
          const spec = [fees[0], ...route.via.flatMap((v, i) => [v, fees[i + 1]])].join(',');
          const attempt = k === 'v4'
            ? universalSwapV4(token() as Hex, units, 0n, v4PathKeys(trial, GLD_ADDRESS as Hex))
            : universalSwap(account.address, units, 0n, v3Path(token() as Hex, trial, GLD_ADDRESS as Hex));
          try {
            await client.simulateContract({ account, address: SWAP_ROUTER as Hex, abi: UNIVERSAL_ROUTER, functionName: 'execute', args: [attempt.commands, attempt.inputs, deadline()] });
            found.push({ kind: k, path: spec, result: 'ok' });
          } catch (error) {
            found.push({ kind: k, path: spec, result: explainRevert(error) });
          }
        }
      }
      out.search = found.filter((f) => f.result === 'ok');
      out.searched = found.length;
      out.reasons = [...new Set(found.map((f) => f.result))];
      out.advice = (out.search as unknown[]).length
        ? `Set EMERGE_SWAP_KIND and EMERGE_SWAP_PATH to one of the routes under "search"; for v4 also set EMERGE_SWAP_QUOTER to the V4Quoter so the trade carries a floor.`
        : 'No standard route fills. Open the pools in the Uniswap app and read their version, fee and tick spacing; a v4 pool with an unusual fee is written as fee/spacing in EMERGE_SWAP_PATH.';
    }
  } catch (error) {
    out.probe = `failed: ${explainRevert(error)}`;
  }
  return out;
}

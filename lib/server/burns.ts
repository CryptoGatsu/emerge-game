import 'server-only';

/**
 * Proving somebody paid.
 *
 * With the land contract deployed this file would not exist: `claim` took the
 * price and minted the title in one transaction, so there was no moment where
 * one had happened and the other had not. Without it the two are separate —
 * the player burns tokens from their own wallet, and the server writes a row
 * saying they own a plot — and the only thing that can bind them together is
 * the server refusing to write the row until it has read the burn off the
 * chain itself.
 *
 * Everything here is the same shape as `deposits.ts`, for the same reasons:
 * the transaction has to exist, have succeeded, be settled a few blocks deep,
 * come from the wallet claiming it, and be worth at least what was being paid
 * for. The amount is summed from `Transfer` events rather than read out of the
 * calldata, so a fee-on-transfer token cannot be used to pay less than it looks
 * like — and so it does not matter whether the token burns by calling `burn`
 * or by sending to a dead address. Both emit the same log.
 *
 * A burn is single-use. `spendBurn` claims a transaction hash with a
 * set-if-absent write, so the same payment cannot buy two plots.
 */

import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ACTIVE_CHAIN, BURN_ADDRESS, TOKEN } from '../chain/emerge';
import { serverKey } from '../limits';
import { hsetnx } from './kv';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const ERC20 = [{
  type: 'function', name: 'decimals', stateMutability: 'view',
  inputs: [], outputs: [{ type: 'uint8' }],
}] as const;

/** `keccak256("Transfer(address,address,uint256)")`. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const CONFIRMATIONS = Math.max(1, Number(process.env.EMERGE_DEPOSIT_CONFIRMATIONS) || 3);

const ZERO = '0x0000000000000000000000000000000000000000';

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type BurnCheck =
  | { ok: true; whole: number }
  | { ok: false; reason: string; retry: boolean };

/**
 * Confirm a burn happened, was this wallet's, and was big enough.
 *
 * `retry` separates "ask again in a moment" from "this will never be true":
 * a transaction the node has not mined yet is the ordinary case one second
 * after signing, and telling somebody their payment was rejected because we
 * looked too early would be both wrong and alarming.
 */
export async function verifyBurn(
  txHash: string,
  payer: string,
  atLeastWhole: number,
): Promise<BurnCheck> {
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
    return { ok: false, reason: 'The chain has not seen that payment yet.', retry: true };
  }
  if (!receipt || !tx) {
    return { ok: false, reason: 'The chain has not seen that payment yet.', retry: true };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'That payment failed on chain.', retry: false };
  }
  if (!same(tx.from, payer)) {
    return { ok: false, reason: 'That payment was made from a different wallet.', retry: false };
  }

  try {
    const head = await client.getBlockNumber();
    const confirmations = head - receipt.blockNumber + 1n;
    if (confirmations < BigInt(CONFIRMATIONS)) {
      return {
        ok: false,
        reason: `Waiting for the payment to settle — ${confirmations} of ${CONFIRMATIONS} confirmations.`,
        retry: true,
      };
    }
  } catch {
    return { ok: false, reason: 'Could not reach the chain to confirm that payment.', retry: true };
  }

  /*
   * How much was destroyed.
   *
   * Both burn routes look identical in the log — `burn()` emits a transfer to
   * the zero address and a dead-address burn emits one to that address — so
   * accepting either means this does not have to know which the token uses.
   */
  let burned = 0n;
  for (const log of receipt.logs) {
    if (!same(log.address, ACTIVE_CHAIN.tokenAddress)) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = log.topics[2];
    if (!to) continue;
    const target = `0x${to.slice(-40)}`;
    if (!same(target, ZERO) && !same(target, BURN_ADDRESS)) continue;
    try {
      burned += BigInt(log.data);
    } catch {
      // A malformed log buys nothing.
    }
  }

  if (burned === 0n) {
    return { ok: false, reason: `That transaction did not burn any ${TOKEN.ticker}.`, retry: false };
  }

  try {
    const decimals = await client.readContract({
      address: ACTIVE_CHAIN.tokenAddress as Hex, abi: ERC20, functionName: 'decimals',
    });
    const whole = Number(burned / 10n ** BigInt(Number(decimals)));
    if (whole < atLeastWhole) {
      return {
        ok: false,
        reason: `That payment was ${whole.toLocaleString()} ${TOKEN.ticker}; this costs ${atLeastWhole.toLocaleString()}.`,
        retry: false,
      };
    }
    return { ok: true, whole };
  } catch {
    return { ok: false, reason: 'Could not reach the chain to price that payment.', retry: true };
  }
}

const SPENT = serverKey('burns');

/**
 * Use a payment, once.
 *
 * Answers true for the first caller and false for every other, so one burn
 * cannot buy two plots however many times it is submitted.
 */
export const spendBurn = (txHash: string, forWhat: string) =>
  hsetnx(SPENT, txHash.toLowerCase(), `${forWhat}:${Date.now()}`);

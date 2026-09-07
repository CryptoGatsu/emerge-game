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
import { ACTIVE_CHAIN, BURN_ADDRESS, TOKEN, VAULT_ADDRESS } from '../chain/emerge';
import { serverKey } from '../limits';
import { hdel, hgetall, hset, hsetnx } from './kv';
import { noteCharge } from './treasury';

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
  return verifyPayment(txHash, payer, atLeastWhole, null);
}

/**
 * Confirm a payment from one wallet to another — a plot bought from its
 * owner, wallet to wallet. Nothing is burned: the tokens land in the seller's
 * wallet, and this checks that they did, from the buyer, and enough of them.
 */
export async function verifyTransfer(
  txHash: string,
  payer: string,
  recipient: string,
  atLeastWhole: number,
): Promise<BurnCheck> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return { ok: false, reason: 'That is not a wallet address.', retry: false };
  }
  return verifyPayment(txHash, payer, atLeastWhole, recipient);
}

/**
 * The check behind both: the transaction exists, succeeded, is settled, came
 * from the payer, and its `Transfer` logs to the target — the burn addresses
 * when `recipient` is null, one named wallet otherwise — add up to the price.
 */
async function verifyPayment(
  txHash: string,
  payer: string,
  atLeastWhole: number,
  recipient: string | null,
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
    // A charge is paid into the vault since v2.1; a burn from an older client
    // still counts, and so does a token that burns by calling `burn`.
    if (recipient ? !same(target, recipient) : (!same(target, ZERO) && !same(target, BURN_ADDRESS) && !same(target, VAULT_ADDRESS))) continue;
    try {
      burned += BigInt(log.data);
    } catch {
      // A malformed log buys nothing.
    }
  }

  if (burned === 0n) {
    return {
      ok: false,
      reason: recipient
        ? `That transaction did not send any ${TOKEN.ticker} to the seller.`
        : `That transaction did not pay any ${TOKEN.ticker} into the vault.`,
      retry: false,
    };
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

/**
 * Confirm an ETH payment landed: from this wallet, to this address, at least
 * this much, mined and confirmed. The same shape as the token check, for the
 * chain's own coin.
 */
export type NativeCheck =
  | { ok: true; wei: bigint }
  | { ok: false; reason: string; retry: boolean };
export async function verifyNative(txHash: string, payer: string, recipient: string, atLeastWei: bigint): Promise<NativeCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'That is not a transaction hash.', retry: false };
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return { ok: false, reason: 'That is not a wallet address.', retry: false };
  const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: txHash as Hex }), client.getTransaction({ hash: txHash as Hex })]);
  } catch {
    return { ok: false, reason: 'The chain has not seen that payment yet.', retry: true };
  }
  if (!receipt || !tx) return { ok: false, reason: 'The chain has not seen that payment yet.', retry: true };
  if (receipt.status !== 'success') return { ok: false, reason: 'That payment failed on chain.', retry: false };
  if (!same(tx.from, payer)) return { ok: false, reason: 'That payment was made from a different wallet.', retry: false };
  if (!same(tx.to, recipient)) return { ok: false, reason: 'That payment went somewhere else.', retry: false };
  if (tx.value < atLeastWei) return { ok: false, reason: 'That payment was short.', retry: false };
  try {
    const head = await client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(CONFIRMATIONS)) return { ok: false, reason: 'Waiting for the chain to confirm the payment.', retry: true };
  } catch {
    return { ok: false, reason: 'Waiting for the chain to confirm the payment.', retry: true };
  }
  return { ok: true, wei: tx.value };
}

const SPENT = serverKey('burns');

/**
 * Use a payment, once.
 *
 * Answers true for the first caller and false for every other, so one burn
 * cannot buy two plots however many times it is submitted.
 */
export async function spendBurn(txHash: string, forWhat: string, whole?: number): Promise<boolean> {
  const first = await hsetnx(SPENT, txHash.toLowerCase(), `${forWhat}:${Date.now()}`);
  // The first use of a payment is the one that books it: what the vault
  // received, and what it owes the burn address for it.
  if (first && whole && whole > 0) await noteCharge(whole).catch(() => {});
  return first;
}

/* ------------------------------------------------------------------ *
 * Payments on account
 * ------------------------------------------------------------------ */

/**
 * What a wallet has paid the vault and not yet had anything for.
 *
 * A payment the registry refused used to be simply gone. The commonest
 * refusal was a page on an older build paying an older price — 120,000 for a
 * survey that had become 240,000, 224,000 for a plot that had become 672,000
 * — and the answer was "keep the receipt and tell us". Players did: three
 * surveys and two claims paid for on one wallet and nothing to show for any
 * of them. So a real payment that falls short is now banked against the
 * wallet that made it, and whatever is on account goes toward the next thing
 * that wallet pays for. Nothing paid into the vault is lost any more.
 *
 * Kept as a hash of transaction hash -> whole tokens, so what was paid is
 * still attributable, with a `rest:` field for the remainder of a payment
 * partly drawn.
 */
const creditKey = (owner: string) => serverKey(`credit:${owner.toLowerCase()}`);

/** Whole tokens this wallet has on account. */
export async function creditOf(owner: string): Promise<number> {
  const rows = await hgetall(creditKey(owner));
  let total = 0;
  for (const raw of Object.values(rows)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/**
 * Put a payment on account. False when the payment was already used for
 * something, which is the one case a receipt buys nothing.
 */
export async function bankCredit(owner: string, txHash: string, whole: number): Promise<{ banked: boolean; credit: number }> {
  const first = whole > 0 && (await spendBurn(txHash, `credit:${owner.toLowerCase()}`, whole));
  if (first) await hset(creditKey(owner), txHash.toLowerCase(), String(whole));
  return { banked: first, credit: await creditOf(owner) };
}

/** Draw this much from what is on account, largest payments first. Returns what was actually drawn. */
async function drawCredit(owner: string, amount: number): Promise<number> {
  if (amount <= 0) return 0;
  const key = creditKey(owner);
  const rows = Object.entries(await hgetall(key))
    .map(([field, raw]) => [field, Number(raw)] as const)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1]);
  let drawn = 0;
  for (const [field, n] of rows) {
    if (drawn >= amount) break;
    await hdel(key, field);
    const take = Math.min(n, amount - drawn);
    drawn += take;
    const rest = n - take;
    if (rest > 0) await hset(key, `rest:${field}:${Date.now()}`, String(rest));
  }
  return drawn;
}

export type Settlement =
  | { ok: true; whole: number; fromCredit: number }
  | { ok: false; reason: string; retry: boolean; used?: boolean; banked?: number; credit?: number; short?: number };

/**
 * Settle a charge from a payment, what is on account, or both.
 *
 * The payment has to be real, from this wallet and settled, as before. Then:
 * enough on its own or with the account, and the charge is paid, the payment
 * spent and any surplus banked; short, and the payment is banked rather than
 * refused, with the shortfall said plainly. No payment, and the account
 * alone can pay.
 */
export async function settleCharge(
  owner: string,
  burnTx: string,
  due: number,
  purpose: string,
  verify: (txHash: string, payer: string, atLeastWhole: number) => Promise<BurnCheck> = verifyBurn,
): Promise<Settlement> {
  const credit = await creditOf(owner);
  const tx = burnTx.trim();
  if (!tx) {
    if (credit >= due) {
      const fromCredit = await drawCredit(owner, due);
      return { ok: true, whole: 0, fromCredit };
    }
    return {
      ok: false, retry: false, credit, short: due - credit,
      reason: `This costs ${due.toLocaleString()} ${TOKEN.ticker}; ${credit.toLocaleString()} is on account and nothing was paid.`,
    };
  }
  const paid = await verify(tx, owner, 1);
  if (!paid.ok) return paid;
  if (paid.whole + credit >= due) {
    if (!(await spendBurn(tx, purpose, paid.whole))) {
      return { ok: false, reason: 'That payment has already been used.', retry: false, used: true };
    }
    const fromCredit = paid.whole >= due ? 0 : await drawCredit(owner, due - paid.whole);
    // Paid over the odds — a page quoting a higher price than today's, say.
    // The difference is theirs, on account.
    if (paid.whole > due) await hset(creditKey(owner), `rest:${tx.toLowerCase()}`, String(paid.whole - due));
    return { ok: true, whole: paid.whole, fromCredit };
  }
  const banked = await bankCredit(owner, tx, paid.whole);
  if (!banked.banked) {
    return { ok: false, reason: 'That payment has already been used.', retry: false, used: true };
  }
  const short = due - banked.credit;
  return {
    ok: false, retry: false, banked: paid.whole, credit: banked.credit, short,
    reason: `That payment was ${paid.whole.toLocaleString()} ${TOKEN.ticker}; this costs ${due.toLocaleString()}. It is banked against your wallet — ${banked.credit.toLocaleString()} on account — and ${short.toLocaleString()} more settles it.`,
  };
}

/**
 * The settlement queue.
 *
 * $EMERGE spent in Emerge is burned by the player's own signature, which needs
 * nothing from us. Money coming *back* is the opposite problem: a withdrawal
 * or a collection has to send tokens the player does not hold yet, and the
 * vault is a wallet rather than a contract, so it cannot pay anybody on its
 * own. Somebody has to sign.
 *
 * So this is a queue of requests, not a promise of payment, and every surface
 * built on it says exactly that. A request records who asked, for how much, on
 * which world, and what the burn share was; it is paid from the vault wallet
 * and marked settled with the transaction hash that paid it.
 *
 * **What this cannot do.** The ledger a request is computed from lives in the
 * player's browser, so a forged request is a POST anybody can write. That is
 * why the queue is reviewed before it is paid rather than paid automatically,
 * and why nothing here is called a balance. The fix is a vault contract that
 * holds the tokens and enforces its own accounting — `docs/CONTRACTS.md` sets
 * out what that would take. Until then, a human reads the queue.
 */

import { serverKey } from '../limits';
import { hdel, hget, hgetall, hset } from './kv';

export interface Payout {
  id: string;
  /** The wallet that asked, lower-cased. */
  address: string;
  /** What they are called in chat, so a queue is readable. */
  name: string;
  /** Which world it came out of. */
  seed: number;
  worldName: string;
  /** What the request is for: principal put in, or stewardship earned. */
  kind: 'principal' | 'earnings';
  /** Gold leaving the treasury. Zero for an earnings collection. */
  gold: number;
  /** $EMERGE before the burn share. */
  gross: number;
  /** The share that stays in the vault to be burned by hand. */
  burned: number;
  /** What the player should actually receive. */
  net: number;
  at: number;
  /** Set once somebody has paid it from the vault. */
  paidAt: number | null;
  txHash: string | null;
}

const PAYOUTS = serverKey('payouts');

/**
 * The most a single request may be for.
 *
 * A day's ceiling across every plot a player can earn on, times a week — well
 * past anything a real session produces, and small enough that a forged
 * request is not worth writing. The real defence is that a person reads the
 * queue; this is the guard rail that keeps an obviously absurd row out of it.
 */
export const MAX_PAYOUT_EMERGE = 700_000;

export type PayoutResult =
  | { ok: true; payout: Payout }
  | { ok: false; reason: string };

/** Ask to be paid out of the vault. */
export async function requestPayout(
  request: Omit<Payout, 'id' | 'at' | 'paidAt' | 'txHash'>,
): Promise<PayoutResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.address)) {
    return { ok: false, reason: 'A payout belongs to a wallet address.' };
  }
  if (!(request.net > 0) || !Number.isFinite(request.net)) {
    return { ok: false, reason: 'There is nothing to pay out.' };
  }
  if (request.gross > MAX_PAYOUT_EMERGE) {
    return {
      ok: false,
      reason: `A single request is capped at ${MAX_PAYOUT_EMERGE.toLocaleString()} $EMERGE. Take it out in stages.`,
    };
  }
  const payout: Payout = {
    ...request,
    address: request.address.toLowerCase(),
    id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`,
    at: Date.now(),
    paidAt: null,
    txHash: null,
  };
  await hset(PAYOUTS, payout.id, JSON.stringify(payout));
  return { ok: true, payout };
}

/** Every request on record, newest first. */
export async function allPayouts(): Promise<Payout[]> {
  const rows = await hgetall(PAYOUTS);
  const out: Payout[] = [];
  for (const raw of Object.values(rows)) {
    try {
      const payout = JSON.parse(raw) as Payout;
      if (payout && typeof payout.id === 'string') out.push(payout);
    } catch {
      // A malformed row is skipped rather than failing the whole read.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** One wallet's requests, so a player can see where theirs stands. */
export async function payoutsFor(address: string): Promise<Payout[]> {
  const want = address.toLowerCase();
  return (await allPayouts()).filter((p) => p.address === want);
}

/** Mark a request paid, with the transaction that paid it. */
export async function settlePayout(id: string, txHash: string): Promise<boolean> {
  const raw = await hget(PAYOUTS, id);
  if (!raw) return false;
  try {
    const payout = JSON.parse(raw) as Payout;
    await hset(PAYOUTS, id, JSON.stringify({ ...payout, paidAt: Date.now(), txHash }));
    return true;
  } catch {
    return false;
  }
}

/** Drop a request, for one that should never have been in the queue. */
export async function dropPayout(id: string): Promise<void> {
  await hdel(PAYOUTS, id);
}

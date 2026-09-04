/**
 * The record of what has been paid.
 *
 * This used to be a queue of requests waiting for somebody to sign them. It is
 * not any more: `/api/payouts` signs, so by the time a row is written here the
 * tokens have already left the vault and the row carries the transaction that
 * sent them. It is history, not a to-do list — kept so a player can see what
 * they have taken out and check every line of it on an explorer.
 *
 * Nothing in this file decides whether to pay. That lives in
 * `lib/server/accounts.ts`, which is where the caps and the verified principal
 * are, and in the route, which is where they are enforced.
 */

import { serverKey } from '../limits';
import { hdel, hgetall, hset } from './kv';

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
  /** The transfer that paid it. Always set: a row is only written after one. */
  txHash: string;
}

const PAYOUTS = serverKey('payouts');

/**
 * The most one withdrawal may move.
 *
 * Not a security boundary — the daily caps and the verified principal are that
 * — but a blast radius. A bug, or a key somebody else got hold of, drains the
 * vault one capped transfer at a time rather than in a single call, which is
 * the difference between noticing and not.
 */
export const MAX_PAYOUT_EMERGE = 1_000_000;

/** Write down a payout that has already been sent. */
export async function recordPayout(
  paid: Omit<Payout, 'id' | 'at'>,
): Promise<Payout> {
  const payout: Payout = {
    ...paid,
    address: paid.address.toLowerCase(),
    id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`,
    at: Date.now(),
  };
  await hset(PAYOUTS, payout.id, JSON.stringify(payout));
  return payout;
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

/** Drop a row, for one that should never have been written. */
export async function dropPayout(id: string): Promise<void> {
  await hdel(PAYOUTS, id);
}

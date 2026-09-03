/**
 * What the server believes each address is owed.
 *
 * This file exists because of one change: the vault can now sign. Until it
 * could, the amounts on a payout came from the player's browser and a person
 * read the queue before paying it, so a forged request was a nuisance rather
 * than a theft. A server that signs automatically pays whatever it believes —
 * so what it believes has to stop coming from the browser.
 *
 * Two kinds of money are owed, and they are on very different footings. Both
 * are stated plainly here rather than blurred together, because the difference
 * is the difference between "cannot be forged" and "cannot be forged for more
 * than the game was going to emit anyway".
 *
 * **Principal — cryptographically safe.** A deposit is an on-chain transfer to
 * the vault, so the server verifies it against the chain: the transaction must
 * exist, have succeeded, be a `transfer` to the vault, come from the address
 * claiming it, and not have been credited before. Nothing about that reading
 * involves trusting the client, and a withdrawal of principal can never exceed
 * the sum of deposits the chain actually shows. This half is airtight.
 *
 * **Earnings — bounded, not verified.** Stewardship yield is produced by the
 * simulation, which runs in the player's browser. The server cannot recompute
 * it without running every world itself, so it cannot be verified at all. What
 * it can be is *capped*, in exactly the way the game already caps it:
 *
 *   - at most `DAILY_EARN_CEILING` per address per UTC day, which is the same
 *     four-plots-well-run ceiling the game shows in the Bank;
 *   - only to an address that holds land, checked against the registry
 *     contract, so an identity has to buy and burn a plot before it can earn;
 *   - and under a global daily budget for the vault as a whole, which is the
 *     backstop that stops any single day draining it.
 *
 * So the worst a dishonest client can do is claim the maximum the game was
 * willing to pay an honest one. That is a real and deliberate limit rather
 * than a proof, and it is written down here so nobody has to infer it.
 */

import { DAILY_EARN_CEILING, EMERGE_PER_GOLD, WITHDRAW_BURN_RATE } from '../chain/vault';
import { serverKey } from '../limits';
import { counter, hget, hsetnx, incrBy, incrWindow } from './kv';

/** Today, in UTC, as a plain key. The server's day, not the player's. */
export const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The smallest payout the vault will send.
 *
 * Two reasons, and the second is the one that matters. A collection of nine
 * $EMERGE rounds its five per cent burn down to nothing, so dust withdrawals
 * skip the burn entirely. Worse, every payout is a transaction the *vault*
 * pays gas for — so without a floor, a wallet can spend its daily allowance a
 * token at a time and make the vault sign a hundred thousand transfers to do
 * it. The floor makes both pointless.
 */
export const MIN_PAYOUT_EMERGE = 1_000;

/**
 * How many payouts one wallet may ask for in a day, and how often.
 *
 * The floor above caps how cheap a single request can be; these cap how many
 * there can be. Between them the vault signs at most a few dozen transfers per
 * wallet per day, which is far more than playing the game generates and far
 * less than an attacker needs.
 */
export const MAX_PAYOUTS_PER_DAY = 24;
export const PAYOUT_COOLDOWN_SECONDS = 20;

const payoutCountKey = (address: string, day: string) => serverKey(`payouts:${day}:${address.toLowerCase()}`);
const cooldownKey = (address: string) => serverKey(`cooldown:${address.toLowerCase()}`);

export type PayoutAllowance =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * May this wallet ask for a payout right now?
 *
 * Counted before the transfer and deliberately not given back on failure: the
 * cost being rationed is the vault signing and paying gas, which a failed
 * attempt still consumes.
 */
export async function takePayoutSlot(address: string): Promise<PayoutAllowance> {
  const day = utcDay();
  const recent = await incrWindow(cooldownKey(address), 1, PAYOUT_COOLDOWN_SECONDS);
  if (recent > 1) {
    return { ok: false, reason: `One withdrawal at a time — try again in ${PAYOUT_COOLDOWN_SECONDS} seconds.` };
  }
  const today = await incrWindow(payoutCountKey(address, day), 1, 26 * 3600);
  if (today > MAX_PAYOUTS_PER_DAY) {
    return { ok: false, reason: `That is ${MAX_PAYOUTS_PER_DAY} withdrawals today. Take the rest out tomorrow.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Principal
 * ------------------------------------------------------------------ */

const principalKey = (address: string) => serverKey(`principal:${address.toLowerCase()}`);

/** Whole $EMERGE this address has deposited and not yet taken back. */
export const principalOf = (address: string) => counter(principalKey(address));

/** Credit a verified deposit. Only ever called after the chain has confirmed it. */
export const creditPrincipal = (address: string, whole: number) =>
  incrBy(principalKey(address), Math.floor(whole));

/** Debit principal on the way out. */
export const debitPrincipal = (address: string, whole: number) =>
  incrBy(principalKey(address), -Math.floor(whole));

/* ------------------------------------------------------------------ *
 * Deposits already seen
 * ------------------------------------------------------------------ */

const DEPOSITS = serverKey('deposits');

/** True when this transaction has already been credited to somebody. */
export const depositSeen = async (txHash: string) =>
  (await hget(DEPOSITS, txHash.toLowerCase())) !== null;

/**
 * Record a transaction as credited, and say whether we were first.
 *
 * The check and the write are one call so two requests replaying the same
 * deposit cannot both pass the check before either writes. `HSETNX` answers 1
 * for the writer that created the field and 0 for every other, which is
 * exactly the question being asked.
 */
export const markDeposit = (txHash: string, address: string) =>
  hsetnx(DEPOSITS, txHash.toLowerCase(), `${address.toLowerCase()}:${Date.now()}`);

/* ------------------------------------------------------------------ *
 * Emission — the part that is capped rather than proved
 * ------------------------------------------------------------------ */

const earnedKey = (address: string, day: string) => serverKey(`earned:${day}:${address.toLowerCase()}`);
const globalKey = (day: string) => serverKey(`emitted:${day}`);

/**
 * The most the vault will pay out in stewardship in one UTC day, across
 * everybody.
 *
 * Ten addresses' worth of the per-address ceiling. Not a limit any honest
 * population is likely to reach, and a hard stop on the day a bug or a
 * borrowed key tries to empty the vault overnight. Override with
 * `EMERGE_DAILY_EMISSION` once the real player count is known.
 */
export const dailyEmissionBudget = () => {
  const configured = Number(process.env.EMERGE_DAILY_EMISSION);
  return Number.isFinite(configured) && configured > 0 ? configured : DAILY_EARN_CEILING * 10;
};

export interface EmissionRoom {
  /** What this address has already been paid today. */
  spent: number;
  /** What it may still be paid. */
  left: number;
  /** What the vault as a whole has left today. */
  globalLeft: number;
}

/** How much stewardship this address may still be paid today. */
export async function emissionRoom(address: string): Promise<EmissionRoom> {
  const day = utcDay();
  const [spent, emitted] = await Promise.all([
    counter(earnedKey(address, day)),
    counter(globalKey(day)),
  ]);
  return {
    spent,
    left: Math.max(0, DAILY_EARN_CEILING - spent),
    globalLeft: Math.max(0, dailyEmissionBudget() - emitted),
  };
}

/**
 * Reserve emission before sending it.
 *
 * Taken first and given back on failure, rather than recorded after a
 * successful send: between the check and the transfer is exactly where a second
 * request would slip through, and a reservation that is occasionally too
 * cautious is better than one that is occasionally too late. Both counters move
 * atomically, and a reservation that turns out to breach either is rolled back
 * before anything is signed.
 */
export async function reserveEmission(address: string, whole: number): Promise<boolean> {
  const day = utcDay();
  const amount = Math.floor(whole);
  if (!(amount > 0)) return false;

  // Expiring, so a day's tally does not become a key that lives for ever.
  const mine = await incrWindow(earnedKey(address, day), amount, 26 * 3600);
  if (mine > DAILY_EARN_CEILING) {
    await incrBy(earnedKey(address, day), -amount);
    return false;
  }
  const all = await incrWindow(globalKey(day), amount, 26 * 3600);
  if (all > dailyEmissionBudget()) {
    await incrBy(globalKey(day), -amount);
    await incrBy(earnedKey(address, day), -amount);
    return false;
  }
  return true;
}

/** Give a reservation back when the transfer did not happen. */
export async function releaseEmission(address: string, whole: number): Promise<void> {
  const day = utcDay();
  const amount = Math.floor(whole);
  if (!(amount > 0)) return;
  await incrBy(earnedKey(address, day), -amount);
  await incrBy(globalKey(day), -amount);
}

/* ------------------------------------------------------------------ *
 * What a withdrawal is worth
 * ------------------------------------------------------------------ */

export interface Settlement {
  /** Whole $EMERGE before the burn share. */
  gross: number;
  /** The share held back, which stays in the vault. */
  burned: number;
  /** What actually leaves the vault for the player. */
  net: number;
}

/**
 * The arithmetic, in one place and on the server.
 *
 * The client shows the same numbers, but showing is not deciding: these are
 * the ones the transfer is built from, so a client that sends a different
 * burn rate or a different exchange rate gets this answer regardless.
 */
export function settlementFor(kind: 'principal' | 'earnings', amount: number): Settlement {
  const gross = kind === 'principal'
    ? Math.floor(amount) * EMERGE_PER_GOLD
    : Math.floor(amount);
  const burned = Math.round(gross * WITHDRAW_BURN_RATE);
  return { gross, burned, net: gross - burned };
}

/** Let go of a claimed deposit, so a failed credit can be retried. */
export async function dropDeposit(txHash: string): Promise<void> {
  const { hdel } = await import('./kv');
  await hdel(DEPOSITS, txHash.toLowerCase());
}

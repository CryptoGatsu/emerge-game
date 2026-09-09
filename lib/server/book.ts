import 'server-only';

/**
 * The arena's token book.
 *
 * A bet in $EMERGE is a transfer into the vault, verified like any payment,
 * held here against the bout, and settled from the vault's own key when the
 * bout is revealed. Nothing about the fight changes: the same sealed secret
 * decides it for Gold bets and token bets alike. What changes is that the
 * house is the vault, so what the house makes goes where every charge goes.
 */

import { HOUSE_EDGE, MAX_TOKEN_STAKE, MAX_TOKEN_STAKE_PER_DAY, payout } from '../arena/betting';
import { serverKey } from '../limits';
import { counter, hget, hgetall, hset, hsetnx, incrBy, incrWindow, releaseLock, takeLock } from './kv';
import { sendFromVault, vaultCanSign } from './signer';
import { noteCharge } from './treasury';
import type { Bout } from './arena';

const BETS = (boutId: number) => serverKey(`arena:bets:${boutId}`);
const PAID = (boutId: number) => serverKey(`arena:paid:${boutId}`);
const STAKED = (who: string, day: number) => serverKey(`arena:staked:${who.toLowerCase()}:${day}`);
const BOOKED = (boutId: number) => serverKey(`arena:booked:${boutId}`);
const utcDay = () => Math.floor(Date.now() / 86_400_000);
const stakedToday = async (who: string) => Math.max(0, await counter(STAKED(who, utcDay())).catch(() => 0));

export interface TokenBet { side: 'red' | 'blue'; stake: number; odds: number; at: number; txHash: string | null }
export interface BetResult { won: boolean; amount: number; txHash: string | null; paid: boolean }

export type Placed = { ok: true; bet: TokenBet } | { ok: false; reason: string };

/**
 * Whether the book would take this bet, read without writing anything: asked
 * before a stake is paid into the vault, so a refusal costs nothing.
 */
export async function mayPlaceTokenBet(bout: Bout, who: string, stake: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const amount = Math.floor(stake);
  if (!(amount > 0) || amount > MAX_TOKEN_STAKE) return { ok: false, reason: `A token stake is between 1 and ${MAX_TOKEN_STAKE.toLocaleString()}.` };
  const staked = await stakedToday(who);
  if (staked + amount > MAX_TOKEN_STAKE_PER_DAY) return { ok: false, reason: `That is over ${MAX_TOKEN_STAKE_PER_DAY.toLocaleString()} staked today.` };
  const rows = await hgetall(BETS(bout.id));
  if (rows[who.toLowerCase()]) return { ok: false, reason: 'You already have a token bet on this bout.' };
  return { ok: true };
}

/** Hold a bet against a bout. One per wallet per bout; capped per day. */
export async function placeTokenBet(bout: Bout, who: string, side: 'red' | 'blue', stake: number, txHash: string | null): Promise<Placed> {
  const amount = Math.floor(stake);
  if (!(amount > 0) || amount > MAX_TOKEN_STAKE) return { ok: false, reason: `A token stake is between 1 and ${MAX_TOKEN_STAKE.toLocaleString()}.` };
  const today = await incrWindow(STAKED(who, utcDay()), amount, 26 * 3600);
  if (today > MAX_TOKEN_STAKE_PER_DAY) {
    await incrBy(STAKED(who, utcDay()), -amount);
    return { ok: false, reason: `That is over ${MAX_TOKEN_STAKE_PER_DAY.toLocaleString()} staked today.` };
  }
  const odds = side === 'red' ? bout.odds.red : bout.odds.blue;
  const offeredOdds = Math.max(1.05, Math.round(odds * (1 - HOUSE_EDGE) * 100) / 100);
  const bet: TokenBet = { side, stake: amount, odds: offeredOdds, at: Date.now(), txHash };
  const first = await hsetnx(BETS(bout.id), who.toLowerCase(), JSON.stringify(bet));
  if (!first) {
    await incrBy(STAKED(who, utcDay()), -amount);
    return { ok: false, reason: 'You already have a token bet on this bout.' };
  }
  return { ok: true, bet };
}

/** This wallet's bet on a bout, and how it went if the bout is over. */
export async function betOf(boutId: number, who: string): Promise<{ bet: TokenBet; result: BetResult | null } | null> {
  const rows = await hgetall(BETS(boutId));
  const raw = rows[who.toLowerCase()];
  if (!raw) return null;
  try {
    const bet = JSON.parse(raw) as TokenBet;
    const paid = await hgetall(PAID(boutId));
    const done = paid[who.toLowerCase()];
    return { bet, result: done ? (JSON.parse(done) as BetResult) : null };
  } catch {
    return null;
  }
}

/**
 * Settle every token bet on a revealed bout, once each.
 *
 * Winners are paid from the vault where it can sign; where it cannot, the
 * result is recorded unpaid and the client credits its own ledger, which is
 * the development build's way. The house edge on the bout's whole book is
 * booked like a charge the first time the bout is settled.
 */
export async function settleTokenBets(bout: Bout): Promise<void> {
  if (!bout.winner) return;
  const rows = await hgetall(BETS(bout.id));
  const entries = Object.entries(rows);
  if (!entries.length) return;
  const paidRows = await hgetall(PAID(bout.id));
  const freshlyBooked = await hsetnx(BOOKED(bout.id), 'edge', String(Date.now()));
  const done = !freshlyBooked && !!(await hget(BOOKED(bout.id), 'done').catch(() => null));
  if (freshlyBooked) {
    let total = 0;
    for (const [, raw] of entries) { try { total += (JSON.parse(raw) as TokenBet).stake; } catch { /* a bad row books nothing */ } }
    const edge = Math.floor(total * HOUSE_EDGE);
    if (edge > 0) await noteCharge(edge).catch(() => {});
  }
  for (const [who, raw] of entries) {
    let bet: TokenBet;
    try { bet = JSON.parse(raw) as TokenBet; } catch { continue; }
    const won = bet.side === bout.winner;
    const amount = won ? payout(bet.stake, bet.odds) : 0;
    /*
     * A bout settled through to the end, with no row for this wallet, was
     * settled by an earlier build whose rows expired after two hours — and a
     * quiet arena re-reading its last bout after that would have paid every
     * winner on it a second time. Done and rowless means settled and gone. A
     * bout booked but never finished (the settlement died mid-way) is the
     * other case: those wallets have not been settled, and are now.
     */
    if (done && !(who in paidRows)) continue;
    // Claim the settlement first, so two polls cannot pay the same win twice.
    const claimed = await hsetnx(PAID(bout.id), who, JSON.stringify({ won, amount, txHash: null, paid: false } satisfies BetResult));
    if (!won || amount <= 0) continue;
    if (!vaultCanSign()) continue;
    if (!claimed) {
      // Settled before, and a win the vault could not pay at the time is
      // still owed: paid now, under a lock so two polls do not both send it.
      let result: BetResult | null = null;
      try { result = JSON.parse(paidRows[who] ?? 'null') as BetResult | null; } catch { result = null; }
      if (!result || !result.won || result.paid || result.txHash) continue;
    }
    const lock = serverKey(`arena:paying:${bout.id}:${who}`);
    if (!(await takeLock(lock, 60))) continue;
    try {
      const sent = await sendFromVault(who, amount);
      // Sent, or possibly sent: the hash is written down either way, so the
      // win is never sent twice on the strength of a reply that was lost.
      const txHash = sent.ok ? sent.txHash : sent.maybeSent ? sent.txHash ?? null : null;
      if (txHash) await hset(PAID(bout.id), who, JSON.stringify({ won, amount, txHash, paid: true } satisfies BetResult));
    } finally {
      await releaseLock(lock);
    }
  }
  // Every wallet on the book has a row now; from here a missing row is one that expired.
  await hset(BOOKED(bout.id), 'done', String(Date.now())).catch(() => {});
}

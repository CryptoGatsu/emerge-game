/*
 * The casino, server side.
 *
 * Two games of pure chance — a coin, and a coin under one of three cups —
 * played for Gold, with the prize in Gold or in $EMERGE. The draw is made
 * here, never in the browser. Gold is the settlement's own money and lives
 * in the browser, so its stake and prize are booked there on the server's
 * word; $EMERGE won is booked here as credit that the vault pays out under
 * the same daily room and burn share as stewardship.
 *
 * The house keeps an edge on every game (a coin pays 1.9 to 1, the cups 2.7
 * to 1) and the $EMERGE prizes are small and capped by the day, so the tables
 * amuse without draining the vault. Three plays a day come free; a pass of
 * five more costs about five dollars, paid in $EMERGE into the vault (burned
 * and kept like every charge) or in ETH, of which a share goes to the
 * development wallet and the rest stays in the vault.
 *
 * The GLD table is the third game, played for $EMERGE rather than Gold and
 * outside the daily plays. The stake goes into the vault before the draw. A
 * loss is booked like any charge: burned, kept and pooled by the usual
 * split. A win is paid in GLD: the vault swaps the winnings' worth of
 * $EMERGE for GLD through the router and sends the GLD to the player's
 * wallet, and while the chain is slow the payout waits here and is retried.
 */

import { randomInt } from 'crypto';
import { serverKey } from '@/lib/limits';
import { counter, getValue, incrBy, incrWindow, setValue } from './kv';
import { utcDay } from './accounts';
import { readTokenStats } from './tokenStats';
import { GLD_ADDRESS, tokenLive } from '../chain/emerge';
import { hdel, hgetall, hset, push, range, releaseLock, takeLock } from './kv';
import { sendTokenFromVault, swapForGld, vaultCanSign } from './signer';

export type CasinoGame = 'coin' | 'cups';
export type CasinoPrize = 'gold' | 'emerge' | 'gld';

export const FREE_PLAYS_PER_DAY = 3;
export const PASS_PLAYS = 5;
export const PASS_USD = 5;
export const MIN_BET_GOLD = 100;
export const MIN_BET_GOLD_FOR_EMERGE = 500;
export const MAX_BET_GOLD = 5_000;
export const MAX_BET_GOLD_FOR_EMERGE = 2_500;
/** What a win pays, as a multiple of the Gold staked, when the prize is Gold. */
export const GOLD_PAYS: Record<CasinoGame, number> = { coin: 1.9, cups: 2.7 };
/** What a win pays in $EMERGE per Gold staked, when the prize is $EMERGE. */
export const EMERGE_PER_GOLD_WON: Record<CasinoGame, number> = { coin: 2, cups: 3 };
/** The most $EMERGE one wallet can win at the tables in a day. */
export const MAX_EMERGE_WON_PER_DAY = 15_000;
/** Of an ETH pass, the share that goes to the development wallet. */
export const DEV_SHARE = 0.3;
export const FALLBACK_EMERGE_PER_PASS = 5_000;
export const FALLBACK_ETH_USD = 3_000;
export const PLAY_COOLDOWN_SECONDS = 2;
/** The GLD table: staked in whole $EMERGE, paid in GLD at the Gold tables' odds. */
export const MIN_STAKE_EMERGE = 5_000;
export const MAX_STAKE_EMERGE = 100_000;
/** The most one wallet can win at the GLD table in a day, in $EMERGE before the swap. */
export const MAX_GLD_WON_PER_DAY_EMERGE = 500_000;
/** The most the GLD table pays out in a day across everybody, in $EMERGE before the swap. */
export const MAX_GLD_TABLE_PER_DAY_EMERGE = 3_000_000;
export const PICKS: Record<CasinoGame, number> = { coin: 2, cups: 3 };

const playsKey = (a: string, day: string) => serverKey(`casino:plays:${day}:${a.toLowerCase()}`);
const extraKey = (a: string) => serverKey(`casino:extra:${a.toLowerCase()}`);
const wonKey = (a: string, day: string) => serverKey(`casino:won:${day}:${a.toLowerCase()}`);
const cooldownKey = (a: string) => serverKey(`casino:cooldown:${a.toLowerCase()}`);
/** What the development wallet is owed from ETH passes, in gwei, and what it has been paid. */
export const DEV_OWED_GWEI = serverKey('casino:dev-owed-gwei');
export const DEV_PAID_GWEI = serverKey('casino:dev-paid-gwei');
const ETH_USD = serverKey('casino:eth-usd');
/** How the tables have done, whole units, for the ledger. */
export const STAKED_GOLD = serverKey('casino:staked-gold');
export const PAID_GOLD = serverKey('casino:paid-gold');
export const PAID_EMERGE = serverKey('casino:paid-emerge');
export const PASSES_SOLD = serverKey('casino:passes');
/** What the passes brought in: whole $EMERGE, gwei of ETH, and cents at the day's prices. */
export const PASS_EMERGE = serverKey('casino:pass-emerge');
export const PASS_GWEI = serverKey('casino:pass-gwei');
export const PASS_CENTS = serverKey('casino:pass-cents');
/** The GLD table: $EMERGE staked, $EMERGE paid out (before the swap), and GLD sent, in micro-GLD. */
export const GLD_STAKED_EMERGE = serverKey('casino:gld-staked');
export const GLD_PAID_EMERGE = serverKey('casino:gld-paid-emerge');
export const GLD_PAID_MICRO = serverKey('casino:gld-paid-micro');
const GLD_PENDING = serverKey('casino:gld-pending');
const GLD_SETTLED = serverKey('casino:gld-settled');
const gldWonKey = (a: string, day: string) => serverKey(`casino:gld-won:${day}:${a.toLowerCase()}`);
const gldTableKey = (day: string) => serverKey(`casino:gld-table:${day}`);
const gldLock = (id: string) => serverKey(`casino:gld-lock:${id}`);

export interface CasinoTotals {
  /** $EMERGE staked at the GLD table, and what it has paid: $EMERGE before the swap, GLD after. */
  emergeStaked: number;
  emergePaidForGld: number;
  gldWon: number;
  /** Gold staked at the tables, all time. */
  staked: number;
  /** Gold paid back to winners. */
  paidGold: number;
  /** $EMERGE won, whole tokens. */
  paidEmerge: number;
  /** Plays bought, and the passes that carried them. */
  plays: number;
  passes: number;
  /** What those passes brought in. */
  revenue: { emerge: number; eth: number; usd: number };
}

/** How the tables have done since they opened, for the public ledger. */
export async function casinoTotals(): Promise<CasinoTotals> {
  const [staked, paidGold, paidEmerge, passes, emerge, gwei, cents, gldStaked, gldPaidEmerge, gldMicro] = await Promise.all([
    counter(STAKED_GOLD), counter(PAID_GOLD), counter(PAID_EMERGE), counter(PASSES_SOLD), counter(PASS_EMERGE), counter(PASS_GWEI), counter(PASS_CENTS),
    counter(GLD_STAKED_EMERGE), counter(GLD_PAID_EMERGE), counter(GLD_PAID_MICRO),
  ]);
  const clean = (n: number) => Math.max(0, Math.round(n));
  return {
    emergeStaked: clean(gldStaked), emergePaidForGld: clean(gldPaidEmerge), gldWon: Math.max(0, gldMicro) / 1e6,
    staked: clean(staked), paidGold: clean(paidGold), paidEmerge: clean(paidEmerge),
    plays: clean(passes) * PASS_PLAYS, passes: clean(passes),
    revenue: { emerge: clean(emerge), eth: Math.max(0, gwei) / 1e9, usd: Math.max(0, cents) / 100 },
  };
}

export const devWallet = () => {
  const w = process.env.EMERGE_DEV_WALLET ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(w) ? w : null;
};

export async function playsOf(address: string): Promise<{ free: number; extra: number }> {
  const used = await counter(playsKey(address, utcDay()));
  return { free: Math.max(0, FREE_PLAYS_PER_DAY - used), extra: Math.max(0, await counter(extraKey(address))) };
}

/** Spend a play: one of today's free ones first, then a bought one. Null when there are none. */
export async function takePlay(address: string): Promise<'free' | 'extra' | null> {
  const key = playsKey(address, utcDay());
  const used = await incrWindow(key, 1, 26 * 3600);
  if (used <= FREE_PLAYS_PER_DAY) return 'free';
  await incrBy(key, -1);
  const extra = await incrBy(extraKey(address), -1);
  if (extra >= 0) return 'extra';
  await incrBy(extraKey(address), 1);
  return null;
}

export async function grantPlays(address: string, n: number): Promise<number> {
  return incrBy(extraKey(address), n);
}

/** True when this wallet may play now; false inside the cooldown. */
export async function mayPlay(address: string): Promise<boolean> {
  return (await incrWindow(cooldownKey(address), 1, PLAY_COOLDOWN_SECONDS)) === 1;
}

export const wonToday = (address: string) => counter(wonKey(address, utcDay()));
export const noteWon = (address: string, n: number) => incrWindow(wonKey(address, utcDay()), Math.floor(n), 26 * 3600);

/** The draw. A coin has two faces; three cups, one coin. */
export function draw(game: CasinoGame): number {
  return randomInt(PICKS[game]);
}

/** ETH in dollars, from CoinGecko, held ten minutes; a fixed figure when it cannot be read. */
export async function ethUsd(): Promise<number> {
  const held = await getValue(ETH_USD);
  if (held && Number(held) > 0) return Number(held);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const json = (await r.json()) as { ethereum?: { usd?: number } };
    const price = Number(json.ethereum?.usd);
    if (price > 0) { await setValue(ETH_USD, String(price), 600); return price; }
  } catch { /* the fallback below */ }
  return FALLBACK_ETH_USD;
}

export interface PassPrices {
  /** Whole $EMERGE for a pass. */
  emerge: number;
  /** Wei for a pass, as a decimal string. */
  ethWei: string;
  emergeUsd: number | null;
  ethUsd: number;
}

export async function passPrices(): Promise<PassPrices> {
  const [stats, eth] = await Promise.all([readTokenStats().catch(() => null), ethUsd()]);
  const emergeUsd = stats?.priceUsd && stats.priceUsd > 0 ? stats.priceUsd : null;
  const emerge = emergeUsd ? Math.max(100, Math.ceil(PASS_USD / emergeUsd)) : FALLBACK_EMERGE_PER_PASS;
  const ethWei = BigInt(Math.round((PASS_USD / eth) * 1e9)) * 1_000_000_000n;
  return { emerge, ethWei: ethWei.toString(), emergeUsd, ethUsd: eth };
}

/* ------------------------------------------------------------------ *
 * The GLD table
 * ------------------------------------------------------------------ */

/** A win at the GLD table, waiting to be swapped and sent, or done. */
export interface GldPayout {
  id: string;
  address: string;
  /** What the win came to, in whole $EMERGE, before the swap. */
  emerge: number;
  game: CasinoGame;
  /** The $EMERGE put down for it, when written down: a win booked before this field is without one. */
  stake?: number;
  at: number;
  /** Set once the GLD is in the player's wallet. */
  settledAt?: number;
  /** GLD sent, in base units, as a string. */
  units?: string;
  swapTx?: string | null;
  sendTx?: string | null;
  /** Which form of the swap the vault sent. */
  plan?: string;
  /** Why the last attempt did not go through, for the player and the operator. */
  problem?: string;
  tries?: number;
  simulated?: boolean;
}

export const gldWonToday = (address: string) => counter(gldWonKey(address, utcDay()));
export const gldTableToday = () => counter(gldTableKey(utcDay()));

/** Book a win before it is paid, and say how much of it the day's caps allow. */
export async function bookGldWin(address: string, game: CasinoGame, due: number, stake?: number): Promise<{ emerge: number; capped: boolean; payout: GldPayout | null }> {
  const [mine, table] = await Promise.all([gldWonToday(address), gldTableToday()]);
  const room = Math.max(0, Math.min(MAX_GLD_WON_PER_DAY_EMERGE - mine, MAX_GLD_TABLE_PER_DAY_EMERGE - table));
  const emerge = Math.max(0, Math.min(Math.floor(due), room));
  if (emerge <= 0) return { emerge: 0, capped: true, payout: null };
  await incrWindow(gldWonKey(address, utcDay()), emerge, 26 * 3600);
  await incrWindow(gldTableKey(utcDay()), emerge, 26 * 3600);
  await incrBy(GLD_PAID_EMERGE, emerge);
  const payout: GldPayout = { id: `${Date.now().toString(36)}-${randomInt(1e9).toString(36)}`, address: address.toLowerCase(), emerge, game, at: Date.now(), tries: 0, ...(stake && stake > 0 ? { stake: Math.floor(stake) } : {}) };
  await hset(GLD_PENDING, payout.id, JSON.stringify(payout));
  return { emerge, capped: emerge < due, payout };
}

/** Whole GLD from base units, to a millionth: enough for a win worth a few dollars. */
export const gldFromUnits = (units: string | null | undefined): number => {
  if (!units || !/^\d+$/.test(units)) return 0;
  return Number(BigInt(units) / 1_000_000_000_000n) / 1e6;
};

/** Every win still waiting to be paid, oldest first; one wallet's when asked. */
export async function pendingGld(address?: string): Promise<GldPayout[]> {
  const all = Object.values(await hgetall(GLD_PENDING))
    .map((raw) => { try { return JSON.parse(raw) as GldPayout; } catch { return null; } })
    .filter((p): p is GldPayout => !!p && (!address || p.address === address.toLowerCase()));
  return all.sort((a, b) => a.at - b.at);
}

/** The last wins paid, newest first; one wallet's when asked. */
export async function settledGld(address?: string, limit = 8): Promise<GldPayout[]> {
  const lines = await range(GLD_SETTLED);
  return lines.map((raw) => { try { return JSON.parse(raw) as GldPayout; } catch { return null; } })
    .filter((p): p is GldPayout => !!p && (!address || p.address === address.toLowerCase()))
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0)).slice(0, limit);
}

export type GldSettle = { ok: true; payout: GldPayout } | { ok: false; problem: string; payout: GldPayout | null };

/**
 * Pay one win: swap its $EMERGE for GLD and send the GLD on. Under a lock,
 * so two calls cannot pay it twice; kept on the list with the problem when
 * the chain will not have it, for the next try. Without a live token the
 * payout is written down as one GLD per $EMERGE, so the tables can be
 * played through on a test build.
 */
export async function settleGld(id: string): Promise<GldSettle> {
  const raw = (await hgetall(GLD_PENDING))[id];
  if (!raw) return { ok: false, problem: 'That win is not waiting.', payout: null };
  let payout: GldPayout;
  try { payout = JSON.parse(raw) as GldPayout; } catch { return { ok: false, problem: 'That win is unreadable.', payout: null }; }
  if (!(await takeLock(gldLock(id), 120))) return { ok: false, problem: 'That win is being paid now.', payout };
  try {
    const fail = async (problem: string) => {
      payout.tries = (payout.tries ?? 0) + 1;
      payout.problem = problem;
      await hset(GLD_PENDING, id, JSON.stringify(payout));
      return { ok: false as const, problem, payout };
    };
    let units: bigint;
    if (tokenLive()) {
      if (!vaultCanSign()) return fail('The vault is not configured to pay out.');
      if (payout.units && payout.swapTx) {
        // Swapped on an earlier try; only the send is owed.
        units = BigInt(payout.units);
      } else {
        const swap = await swapForGld(payout.emerge);
        if (!swap.ok) return fail(`The swap failed: ${swap.problem}`);
        if (!(swap.received > 0n)) return fail('The swap returned no GLD.');
        payout.swapTx = swap.txHash;
        payout.plan = swap.plan;
        // Written down the moment the GLD is in the vault, so a send that
        // fails is retried as a send and never as a second swap.
        payout.units = String(swap.received);
        await hset(GLD_PENDING, id, JSON.stringify(payout));
        units = swap.received;
      }
      const sent = await sendTokenFromVault(GLD_ADDRESS, payout.address, units);
      if (!sent.ok) return fail(`The GLD could not be sent: ${sent.problem}`);
      payout.sendTx = sent.txHash;
    } else {
      units = BigInt(payout.emerge) * 1_000_000_000_000_000_000n;
      payout.units = String(units);
      payout.simulated = true;
      payout.swapTx = null; payout.sendTx = null;
    }
    payout.settledAt = Date.now();
    delete payout.problem;
    await incrBy(GLD_PAID_MICRO, Number(units / 1_000_000_000_000n));
    await push(GLD_SETTLED, JSON.stringify(payout), 200);
    await hdel(GLD_PENDING, id);
    return { ok: true, payout };
  } finally {
    await releaseLock(gldLock(id));
  }
}

/** Pay every win that is waiting, one after another, and say how it went. */
export async function settlePendingGld(address?: string, limit = 10): Promise<{ paid: number; waiting: number; problems: string[] }> {
  const queue = (await pendingGld(address)).slice(0, limit);
  let paid = 0;
  const problems: string[] = [];
  for (const p of queue) {
    const r = await settleGld(p.id);
    if (r.ok) paid += 1; else problems.push(r.problem);
  }
  return { paid, waiting: (await pendingGld(address)).length, problems };
}

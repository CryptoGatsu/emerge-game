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
 */

import { randomInt } from 'crypto';
import { serverKey } from '@/lib/limits';
import { counter, getValue, incrBy, incrWindow, setValue } from './kv';
import { utcDay } from './accounts';
import { readTokenStats } from './tokenStats';

export type CasinoGame = 'coin' | 'cups';
export type CasinoPrize = 'gold' | 'emerge';

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

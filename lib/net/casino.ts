/* The casino, as the browser talks to it. */
import { withSession } from './session';
import type { CasinoGame, CasinoPrize, GldPayout } from '../server/casino';
export type { GldPayout };

export interface CasinoInfo {
  live: boolean;
  plays: { free: number; extra: number } | null;
  prices: { emerge: number; ethWei: string; emergeUsd: number | null; ethUsd: number };
  wonToday: number;
  credit: number;
  devWallet: boolean;
  rules: {
    freePlays: number; passPlays: number; passUsd: number;
    minBet: number; minBetEmerge: number; maxBet: number; maxBetEmerge: number;
    goldPays: Record<CasinoGame, number>; emergePerGold: Record<CasinoGame, number>; maxEmergeDay: number;
    minStakeEmerge: number; maxStakeEmerge: number; maxGldDay: number; maxGldTableDay: number;
  };
  gld: { wonToday: number; tableToday: number; waiting: GldPayout[]; paid: GldPayout[] };
}

export interface PlayResult {
  won: boolean; drawn: number; gold: number; emerge: number; capped: boolean;
  plays: { free: number; extra: number };
  /** The GLD table only: what was staked and, on a win, the payout as it stands. */
  stake?: number; prize?: CasinoPrize; gldPayout?: GldPayout | null;
}

export async function fetchCasino(address: string | null): Promise<CasinoInfo | null> {
  try {
    const r = await fetch(`/api/casino${address ? `?address=${encodeURIComponent(address)}` : ''}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as CasinoInfo;
  } catch { return null; }
}

export async function playCasino(
  address: string,
  play: { game: CasinoGame; pick: number; bet?: number; prize: CasinoPrize; stake?: number; txHash?: string | null },
): Promise<{ ok: true; result: PlayResult } | { ok: false; error: string; plays?: { free: number; extra: number }; settling?: boolean }> {
  try {
    const response = await withSession(
      address,
      () => fetch('/api/casino', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, play }) }),
      async (r) => r,
    );
    const json = (await response.json()) as Partial<PlayResult> & { error?: string; plays?: { free: number; extra: number }; retry?: boolean };
    if (!response.ok || typeof json.won !== 'boolean') return { ok: false, error: json.error ?? 'The table refused the play.', plays: json.plays, settling: json.retry === true };
    return { ok: true, result: json as PlayResult };
  } catch { return { ok: false, error: 'Could not reach the casino.' }; }
}

/** Ask the vault to pay this wallet's GLD wins that are still waiting. */
export async function settleGldWins(address: string): Promise<{ paid: number; waiting: GldPayout[]; done: GldPayout[]; problems: string[] } | null> {
  try {
    const response = await withSession(
      address,
      () => fetch('/api/casino', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, settle: true }) }),
      async (r) => r,
    );
    const json = (await response.json()) as { paid?: number; problems?: string[]; gld?: { waiting: GldPayout[]; paid: GldPayout[] } };
    if (!response.ok || !json.gld) return null;
    return { paid: json.paid ?? 0, waiting: json.gld.waiting, done: json.gld.paid, problems: json.problems ?? [] };
  } catch { return null; }
}

export async function buyPass(address: string, method: 'emerge' | 'eth', txHash: string | null, passes = 1): Promise<{ ok: true; plays: { free: number; extra: number } } | { ok: false; error: string; settling?: boolean }> {
  try {
    const response = await withSession(
      address,
      () => fetch('/api/casino', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, buy: { method, txHash, passes } }) }),
      async (r) => r,
    );
    const json = (await response.json()) as { plays?: { free: number; extra: number }; error?: string; retry?: boolean };
    if (!response.ok || !json.plays) return { ok: false, error: json.error ?? 'The pass was refused.', settling: json.retry === true };
    return { ok: true, plays: json.plays };
  } catch { return { ok: false, error: 'Could not reach the casino.' }; }
}

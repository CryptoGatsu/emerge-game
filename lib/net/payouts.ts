/**
 * The client half of settlement.
 *
 * Thin wrappers over `/api/deposits` and `/api/payouts`. Neither endpoint
 * believes anything sent from here — the server verifies deposits against the
 * chain and computes payout amounts itself — so these carry as little as
 * possible: a transaction hash, or how much the player asked for.
 *
 * Like the rest of `lib/net`, every call answers rather than throwing.
 */

import { withSession } from './session';

export interface Payout {
  id: string;
  address: string;
  name: string;
  seed: number;
  worldName: string;
  kind: 'principal' | 'earnings';
  gold: number;
  gross: number;
  burned: number;
  net: number;
  at: number;
  txHash: string;
}

/** How much of today's ceiling a wallet has left. */
export interface EmissionRoom {
  spent: number;
  left: number;
  globalLeft: number;
}

export interface PayoutHistory {
  payouts: Payout[];
  /** Whole $EMERGE the chain says this wallet has deposited and not taken back. */
  principal: number;
  room: EmissionRoom | null;
  /** True when the vault can sign for itself. */
  automatic: boolean;
  shared: boolean;
  /**
   * Whether this wallet can collect stewardship, and if not, why. `none` is
   * the only one of these that means "you hold no land"; the other two are the
   * deployment's problem, not the player's, and are worth saying out loud.
   */
  land: 'holds' | 'none' | 'no-registry' | 'unreachable' | null;
  /** No land, but a job: this wallet is paid as a hired hand. */
  hand: boolean;
}

/* ------------------------------------------------------------------ *
 * Deposits
 * ------------------------------------------------------------------ */

export type CreditResult =
  | { ok: true; credited: number; principal: number }
  | { ok: false; reason: string; retry: boolean; already: boolean };

/**
 * Tell the server about a deposit, so it can go and verify it.
 *
 * `retry` is the normal answer in the second after signing: the node has taken
 * the transaction but not mined it, and there is nothing yet to read.
 */
export async function creditDeposit(address: string, txHash: string): Promise<CreditResult> {
  try {
    const response = await fetch('/api/deposits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, txHash }),
    });
    const json = (await response.json()) as {
      credited?: number; principal?: number; error?: string; retry?: boolean; already?: boolean;
    };
    if (response.ok && typeof json.credited === 'number') {
      return { ok: true, credited: json.credited, principal: json.principal ?? 0 };
    }
    return {
      ok: false,
      reason: json.error ?? 'The deposit could not be credited.',
      retry: json.retry === true || response.status === 202,
      already: json.already === true,
    };
  } catch {
    return { ok: false, reason: 'Could not reach the settlement ledger.', retry: true, already: false };
  }
}

/** What the chain says this wallet has standing as principal. */
export async function fetchPrincipal(address: string): Promise<number | null> {
  try {
    const response = await fetch(`/api/deposits?address=${encodeURIComponent(address)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as { principal?: number };
    return typeof json.principal === 'number' ? json.principal : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Withdrawals
 * ------------------------------------------------------------------ */

export interface WithdrawRequest {
  address: string;
  name: string;
  seed: number;
  worldName: string;
  kind: 'principal' | 'earnings';
  /** Gold to take out, for a principal withdrawal. */
  gold: number;
  /** $EMERGE to collect, for earnings. */
  emerge: number;
}

export type PayoutResult =
  | { ok: true; payout: Payout; txHash: string }
  | { ok: false; reason: string };

/** Take money out of the vault. Resolves once the transfer has been sent. */
export async function withdrawFromVault(request: WithdrawRequest): Promise<PayoutResult> {
  try {
    const response = await withSession(
      request.address,
      () => fetch('/api/payouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { payout?: Payout; txHash?: string; error?: string };
    if (!response.ok || !json.payout || !json.txHash) {
      return { ok: false, reason: json.error ?? 'The vault refused the withdrawal.' };
    }
    return { ok: true, payout: json.payout, txHash: json.txHash };
  } catch {
    return { ok: false, reason: 'Could not reach the vault. Nothing was taken.' };
  }
}

/** What a wallet has been paid, and what it may still be paid today. */
export async function fetchPayouts(address: string): Promise<PayoutHistory> {
  const empty: PayoutHistory = {
    payouts: [], principal: 0, room: null, automatic: false, shared: false, land: null, hand: false,
  };
  try {
    const response = await fetch(`/api/payouts?address=${encodeURIComponent(address)}`, { cache: 'no-store' });
    if (!response.ok) return empty;
    const json = (await response.json()) as Partial<PayoutHistory>;
    return {
      payouts: json.payouts ?? [],
      principal: json.principal ?? 0,
      room: json.room ?? null,
      automatic: json.automatic === true,
      shared: json.shared === true,
      land: json.land ?? null,
      hand: json.hand === true,
    };
  } catch {
    return empty;
  }
}

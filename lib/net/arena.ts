/**
 * The client half of the colosseum.
 *
 * Reading is open to anybody; entering a fighter needs the wallet that holds
 * the settlement they come from. Like the rest of `lib/net`, every call answers
 * rather than throwing — an arena that cannot be reached is a closed arena, not
 * a broken game.
 */

import { withSession } from './session';

export interface Fighter {
  id: string;
  name: string;
  worldName: string;
  seed: number;
  owner: string;
  ownerName: string;
  job: string;
  level: number;
  vigour: number;
  at: number;
  won: number;
  lost: number;
}

export interface Round {
  by: 'red' | 'blue';
  move: number;
  hit: number;
  redLeft: number;
  blueLeft: number;
}

export interface Bout {
  id: number;
  opensAt: number;
  closesAt: number;
  endsAt: number;
  red: Fighter;
  blue: Fighter;
  commit: string;
  reveal?: string;
  winner?: 'red' | 'blue';
  rounds?: Round[];
  odds: { red: number; blue: number };
}

export interface ArenaState {
  /** The server's clock, so every viewer counts down to the same instant. */
  now: number;
  boutMs: number;
  bettingMs: number;
  bout: Bout | null;
  previous: Bout | null;
  roster: Fighter[];
  results: { id: number; at: number; winner: string; winnerWorld: string; loser: string; loserWorld: string }[];
  /** True when this is the one shared arena rather than an instance on its own. */
  shared: boolean;
  /** How far this browser's clock is ahead of the arena's. */
  skew: number;
}

export async function fetchArena(): Promise<ArenaState | null> {
  try {
    const response = await fetch('/api/arena', { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<ArenaState> & { offline?: boolean };
    if (json.offline || typeof json.now !== 'number') return null;
    return {
      now: json.now,
      boutMs: json.boutMs ?? 180_000,
      bettingMs: json.bettingMs ?? 120_000,
      bout: json.bout ?? null,
      previous: json.previous ?? null,
      roster: json.roster ?? [],
      results: json.results ?? [],
      shared: json.shared === true,
      // Measured at receipt, the same way the market does it, so the bell
      // rings at the same moment for everybody however wrong their clock is.
      skew: Date.now() - json.now,
    };
  } catch {
    return null;
  }
}

/** Put one of your citizens forward. */
export async function enterFighter(
  address: string | null,
  fighter: {
    seed: number; citizenId: string; name: string; worldName: string;
    job: string; level: number; vigour: number; ownerName: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!address) return { ok: false, error: 'Connect a wallet to enter a fighter.' };
  try {
    const response = await withSession(
      address,
      () => fetch('/api/arena', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fighter),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { error?: string };
    if (!response.ok) return { ok: false, error: json.error ?? 'The arena refused that.' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the arena.' };
  }
}

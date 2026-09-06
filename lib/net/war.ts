/**
 * War, from the browser: the registry's war rows and the actions on them.
 * Every action goes through the wallet's session, as the registry demands.
 */

import { withSession } from './session';
import type { Army, Battle, Occupation, WarEvent } from '@/lib/world/war';

export type { Army, Battle, Occupation, WarEvent };

/** The war-facing part of a plot's row. */
export interface WarRow {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  era: number;
  army: Army | null;
  occupation: Occupation | null;
  shieldUntil: number;
  battle: Battle | null;
  occupying: number | null;
}

export type WarAction = { ok: true; war: WarRow; battle?: Battle; home?: WarRow; trained?: number; gold?: number; already?: boolean } | { ok: false; reason: string; settling?: boolean };

async function act(address: string, body: Record<string, unknown>): Promise<WarAction> {
  try {
    const response = await withSession(
      address,
      () => fetch('/api/war', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, address }) }),
      async (r) => r,
    );
    const json = (await response.json()) as { war?: WarRow; battle?: Battle; home?: WarRow; trained?: number; gold?: number; already?: boolean; error?: string; retry?: boolean };
    if (!response.ok || !json.war) return { ok: false, reason: json.error ?? 'The registry refused it.', settling: json.retry === true };
    return { ok: true, war: json.war, battle: json.battle, home: json.home, trained: json.trained, gold: json.gold, already: json.already };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

export const buyBase = (seed: number, address: string, burnTx?: string) => act(address, { action: 'base', seed, burnTx });
export const trainTroops = (seed: number, address: string, count: number) => act(address, { action: 'train', seed, count });
export const invadePlot = (seed: number, address: string, from: number, troops: number) => act(address, { action: 'invade', seed, from, troops });
export const retakePlot = (seed: number, address: string, troops: number) => act(address, { action: 'retake', seed, troops });
export const withdrawFrom = (seed: number, address: string) => act(address, { action: 'withdraw', seed });
export const payOccupation = (seed: number, address: string) => act(address, { action: 'pay', seed });

/** One plot's war row, or null when it has none or the registry is out. */
export async function fetchWarRow(seed: number): Promise<WarRow | null> {
  try {
    const res = await fetch(`/api/war?seed=${seed}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return ((await res.json()) as { war?: WarRow | null }).war ?? null;
  } catch {
    return null;
  }
}

/** Every plot under occupation, and the latest events. */
export async function fetchSieges(): Promise<{ sieges: WarRow[]; events: WarEvent[] }> {
  try {
    const res = await fetch('/api/war', { cache: 'no-store' });
    if (!res.ok) return { sieges: [], events: [] };
    const body = (await res.json()) as { sieges?: WarRow[]; events?: WarEvent[] };
    return { sieges: body.sieges ?? [], events: body.events ?? [] };
  } catch {
    return { sieges: [], events: [] };
  }
}

/** War events since a moment, newest first. */
export async function fetchWarFeed(since: number): Promise<{ events: WarEvent[]; now: number }> {
  try {
    const res = await fetch(`/api/war?feed=1&since=${Math.max(0, Math.floor(since))}`, { cache: 'no-store' });
    if (!res.ok) return { events: [], now: Date.now() };
    const body = (await res.json()) as { events?: WarEvent[]; now?: number };
    return { events: body.events ?? [], now: body.now ?? Date.now() };
  } catch {
    return { events: [], now: Date.now() };
  }
}

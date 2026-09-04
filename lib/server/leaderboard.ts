/**
 * The cities, ranked.
 *
 * By the level the vault judges each plot at — the published city level,
 * bounded by the owner's days of presence, the same rule the payouts use —
 * then by how well the place is run, then by how many live there. Nothing
 * here is the client's word: the level and score were read off the copy
 * when it was published, and presence is the server's own record.
 *
 * Built from the headline index and the claims, plus one presence read per
 * owner, and kept for ten minutes: a world map open on two hundred phones
 * should not read two hundred snapshots each.
 */

import { allClaims, presenceDays, worldHeadlines } from './registry';
import { gldBookedFor } from './dividend';
import { LEVEL_PRESENCE_DAYS } from './land';
import { getValue, setValue } from './kv';
import { serverKey } from '../limits';

export interface Leader {
  rank: number;
  seed: number;
  worldName: string;
  region: string;
  owner: string;
  ownerName: string;
  era: number;
  banner: string | null;
  /** The judged city level. */
  level: number;
  /** Stewardship score, 0 to 1, as published. */
  score: number;
  population: number;
  day: number;
  /** GLD booked to the owner over its life, in base units. */
  gld: string;
}

export interface Leaderboard {
  rows: Leader[];
  total: number;
  at: number;
}

const KEY = serverKey('leaderboard');
const KEEP_SECONDS = 600;
export const LEADERBOARD_TOP = 25;

export async function leaderboard(fresh = false): Promise<Leaderboard> {
  if (!fresh) {
    const held = await getValue(KEY);
    if (held) { try { return JSON.parse(held) as Leaderboard; } catch { /* rebuilt below */ } }
  }
  const [claims, heads] = await Promise.all([allClaims(), worldHeadlines()]);
  const headOf = new Map(heads.map((h) => [h.seed, h]));
  const owners = [...new Set(claims.map((c) => c.owner.toLowerCase()))];
  const days = new Map<string, number>();
  const gld = new Map<string, string>();
  await Promise.all(owners.map(async (o) => {
    days.set(o, await presenceDays(o).catch(() => 0));
    gld.set(o, (await gldBookedFor(o).catch(() => 0n)).toString());
  }));
  const rows: Leader[] = claims.map((c) => {
    const h = headOf.get(c.seed);
    const o = c.owner.toLowerCase();
    const judged = Math.max(1, Math.min(h?.level ?? 1, 1 + Math.floor((days.get(o) ?? 0) / LEVEL_PRESENCE_DAYS)));
    return {
      rank: 0, seed: c.seed, worldName: c.worldName, region: c.region, owner: o, ownerName: c.ownerName,
      era: c.era ?? 1, banner: c.banner ?? null, level: judged, score: h?.score ?? 0,
      population: h?.population ?? 0, day: h?.day ?? 0, gld: gld.get(o) ?? '0',
    };
  }).sort((a, b) => b.level - a.level || b.score - a.score || b.population - a.population || a.seed - b.seed);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const board: Leaderboard = { rows: rows.slice(0, LEADERBOARD_TOP), total: rows.length, at: Date.now() };
  await setValue(KEY, JSON.stringify(board), KEEP_SECONDS).catch(() => {});
  return board;
}

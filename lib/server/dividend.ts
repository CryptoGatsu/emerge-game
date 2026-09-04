import 'server-only';

/**
 * The dividend.
 *
 * A share of every charge is set aside in a pool. Once a week the vault
 * sends the development share on, swaps the rest into GLD, and books the
 * GLD to two kinds of holder: people who hold land, weighted by the level
 * their plots are judged at and the days they were present that week; and
 * people who registered a soft stake, weighted by the lowest $EMERGE balance
 * they held through the week. Nothing is locked; selling mid-week forfeits
 * the week. Each wallet's GLD waits here until they claim it, and the vault
 * sends it on claim.
 */

import { DIVIDEND_DEV_SHARE, DIVIDEND_LAND_SHARE, DIVIDEND_STAKE_SHARE, EARNING_PLOT_LIMIT, STAKE_CAP_EMERGE, STAKE_MIN_EMERGE } from '../chain/vault';
import { GLD_ADDRESS, tokenBalance, tokenLive } from '../chain/emerge';
import { serverKey } from '../limits';
import { worldFromSave, type SavedWorld } from '../world/save';
import { counter, getValue, hget, hgetall, hset, hsetnx, incrBy, push, range, releaseLock, setValue, takeLock } from './kv';
import { allClaims, presenceDaysBetween, readWorld, type Claim } from './registry';
import { judgedLevel } from './land';
import { sendFromVault, sendTokenFromVault, swapForGld, vaultCanSign } from './signer';
import { DIVIDEND_POOL } from './treasury';
import type { World } from '../simulation';

const STAKERS = serverKey('dividend:stakers');
const MIN = (epoch: string) => serverKey(`dividend:min:${epoch}`);
const CLAIMS = serverKey('dividend:claims');
const PAID = serverKey('dividend:paid');
const EPOCHS = serverKey('dividend:epochs');
const SETTLED = serverKey('dividend:settled');
const DEV_OWED = serverKey('dividend:dev-owed');
const LOCK = serverKey('dividend:lock');

/** Below this the pool waits for next week: a swap costs gas and moves a price. */
export const MIN_SETTLE_EMERGE = 20_000;
const DAY = 86_400_000;

/** ISO week, UTC: the epoch a moment belongs to. */
export function epochOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** The UTC day numbers an epoch spans: [from, to). */
export function epochDays(epoch: string): { from: number; to: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(epoch);
  if (!m) return { from: 0, to: 0 };
  const year = Number(m[1]), week = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (week - 1) * 7 * DAY;
  return { from: Math.floor(monday / DAY), to: Math.floor(monday / DAY) + 7 };
}
export const previousEpoch = (ms = Date.now()) => epochOf(ms - 7 * DAY);

/** Share a whole out by weights, in base units, largest remainder to the heaviest. */
export function shareOut(units: bigint, weights: Map<string, number>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const total = [...weights.values()].reduce((s, w) => s + Math.max(0, w), 0);
  if (!(total > 0) || units <= 0n) return out;
  let given = 0n;
  const scale = 1_000_000n;
  for (const [who, w] of weights) {
    if (!(w > 0)) continue;
    const part = (units * BigInt(Math.round((w / total) * 1_000_000))) / scale;
    out.set(who, part);
    given += part;
  }
  const rest = units - given;
  if (rest > 0n) {
    const heaviest = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    if (heaviest) out.set(heaviest[0], (out.get(heaviest[0]) ?? 0n) + rest);
  }
  return out;
}

/* ---------------- soft stake ---------------- */

export async function registerStake(who: string): Promise<boolean> {
  return hsetnx(STAKERS, who.toLowerCase(), String(Date.now()));
}
export async function stakers(): Promise<string[]> {
  return Object.keys(await hgetall(STAKERS));
}
/** Read every staker's balance and keep the week's lowest. Meant to run daily. */
export async function sampleBalances(now = Date.now()): Promise<number> {
  if (!tokenLive()) return 0;
  const epoch = epochOf(now);
  let sampled = 0;
  for (const who of await stakers()) {
    const held = await tokenBalance(who);
    if (held === null) continue;
    const prior = await hget(MIN(epoch), who);
    const low = prior === null ? held : Math.min(Number(prior), held);
    await hset(MIN(epoch), who, String(Math.floor(low)));
    sampled += 1;
  }
  return sampled;
}
/** The stake weights for an epoch: the lowest balance held, above the floor, up to the cap. */
export async function stakeWeights(epoch: string): Promise<Map<string, number>> {
  const rows = await hgetall(MIN(epoch));
  const out = new Map<string, number>();
  for (const [who, raw] of Object.entries(rows)) {
    const low = Number(raw) || 0;
    if (low >= STAKE_MIN_EMERGE) out.set(who, Math.min(STAKE_CAP_EMERGE, low));
  }
  return out;
}

/* ---------------- land ---------------- */

/** The land weights for an epoch: judged level times the share of the week the owner was present, summed over earning plots. */
export async function landWeights(epoch: string): Promise<Map<string, number>> {
  const { from, to } = epochDays(epoch);
  let rows: Claim[] = [];
  try { rows = await allClaims(); } catch { return new Map(); }
  const byOwner = new Map<string, Claim[]>();
  for (const c of rows) {
    const me = c.owner.toLowerCase();
    byOwner.set(me, [...(byOwner.get(me) ?? []), c]);
  }
  const out = new Map<string, number>();
  for (const [owner, mine] of byOwner) {
    const days = await presenceDaysBetween(owner, from, to).catch(() => 0);
    if (days <= 0) continue;
    let weight = 0;
    for (const row of mine.sort((a, b) => a.at - b.at).slice(0, EARNING_PLOT_LIMIT)) {
      let world: World | null = null;
      try {
        const published = await readWorld(row.seed);
        world = published ? worldFromSave(published.snapshot as SavedWorld, row.seed, row.worldName) : null;
      } catch { world = null; }
      weight += judgedLevel(world, days * 3) * (days / 7);
    }
    if (weight > 0) out.set(owner, weight);
  }
  return out;
}

/* ---------------- settlement ---------------- */

export interface Settlement {
  epoch: string; at: number; pool: number; dev: number; swapped: number;
  gldUnits: string; landUnits: string; stakeUnits: string; landHolders: number; stakers: number;
  txHash: string | null; simulated: boolean; problem?: string;
}

/**
 * Settle the week that has ended: the dev share on, the rest swapped into
 * GLD, the GLD booked to holders. Once per epoch, under a lock, and a pool
 * too small to be worth a swap waits for next week. Without a live token
 * the settlement is simulated in $EMERGE units, so the whole flow can be
 * exercised before launch.
 */
export async function settleEpoch(epoch = previousEpoch()): Promise<Settlement | { skipped: string }> {
  if (await getValue(`${SETTLED}:${epoch}`)) return { skipped: 'That week is settled.' };
  if (!(await takeLock(LOCK, 300))) return { skipped: 'A settlement is running.' };
  try {
    const pool = await counter(DIVIDEND_POOL);
    if (pool < MIN_SETTLE_EMERGE) return { skipped: `The pool holds ${pool.toLocaleString()}; it settles at ${MIN_SETTLE_EMERGE.toLocaleString()}.` };
    const dev = Math.floor(pool * DIVIDEND_DEV_SHARE);
    const rest = pool - dev;
    const live = tokenLive() && vaultCanSign();
    let txHash: string | null = null;
    let gldUnits: bigint;
    let problem: string | undefined;
    if (live) {
      const devTo = process.env.EMERGE_DEV_ADDRESS ?? '';
      if (/^0x[0-9a-fA-F]{40}$/.test(devTo)) {
        const sent = await sendFromVault(devTo, dev);
        if (!sent.ok) return { skipped: `The development share could not be sent: ${sent.problem}` };
      } else {
        await incrBy(DEV_OWED, dev);
      }
      const swap = await swapForGld(rest);
      if (!swap.ok) {
        // The dev share went; the pool keeps the rest for another try.
        await incrBy(DIVIDEND_POOL, -dev);
        return { skipped: `The swap failed: ${swap.problem}` };
      }
      txHash = swap.txHash;
      gldUnits = swap.received;
    } else {
      // Simulated: units are $EMERGE, one to one, so the arithmetic is visible.
      await incrBy(DEV_OWED, dev);
      gldUnits = BigInt(rest);
      problem = 'simulated: no live token, units are $EMERGE';
    }
    await incrBy(DIVIDEND_POOL, -pool);
    const landUnits = (gldUnits * BigInt(Math.round((DIVIDEND_LAND_SHARE / (DIVIDEND_LAND_SHARE + DIVIDEND_STAKE_SHARE)) * 1000))) / 1000n;
    const stakeUnits = gldUnits - landUnits;
    const [land, stake] = await Promise.all([landWeights(epoch), stakeWeights(epoch)]);
    const landOut = shareOut(landUnits, land);
    const stakeOut = shareOut(stakeUnits, stake);
    const credit = async (who: string, units: bigint) => {
      const had = BigInt((await hget(CLAIMS, who)) ?? '0');
      await hset(CLAIMS, who, String(had + units));
    };
    for (const [who, units] of landOut) if (units > 0n) await credit(who, units);
    for (const [who, units] of stakeOut) if (units > 0n) await credit(who, units);
    const record: Settlement = {
      epoch, at: Date.now(), pool, dev, swapped: rest, gldUnits: String(gldUnits), landUnits: String(landUnits), stakeUnits: String(stakeUnits),
      landHolders: landOut.size, stakers: stakeOut.size, txHash, simulated: !live, problem,
    };
    await setValue(`${SETTLED}:${epoch}`, JSON.stringify(record), 400 * 86_400);
    await push(EPOCHS, JSON.stringify(record), 60);
    return record;
  } finally {
    await releaseLock(LOCK);
  }
}

/* ---------------- what a wallet sees, and the claim ---------------- */

export interface Standing {
  epoch: string;
  pool: number;
  registered: boolean;
  /** This week's lowest sampled balance, or null. */
  lowBalance: number | null;
  /** Days present this week, and the land weight it comes to. */
  presentDays: number;
  landWeight: number;
  /** GLD waiting to be claimed, in base units, as a string. */
  claimable: string;
  paid: { at: number; units: string; txHash: string | null }[];
  settlements: Settlement[];
  gld: string;
  automatic: boolean;
}

export async function standingOf(who: string | null, now = Date.now()): Promise<Standing> {
  const epoch = epochOf(now);
  const me = who?.toLowerCase() ?? '';
  const [pool, lines] = await Promise.all([counter(DIVIDEND_POOL), range(EPOCHS)]);
  const settlements = lines.map((l) => { try { return JSON.parse(l) as Settlement; } catch { return null; } }).filter((x): x is Settlement => !!x).slice(-8);
  if (!me) return { epoch, pool, registered: false, lowBalance: null, presentDays: 0, landWeight: 0, claimable: '0', paid: [], settlements, gld: GLD_ADDRESS, automatic: vaultCanSign() };
  const { from, to } = epochDays(epoch);
  const [registered, low, days, claimable, paidRaw] = await Promise.all([
    hget(STAKERS, me), hget(MIN(epoch), me), presenceDaysBetween(me, from, to).catch(() => 0), hget(CLAIMS, me), hget(PAID, me),
  ]);
  let landWeight = 0;
  if (days > 0) {
    try {
      const mine = (await allClaims()).filter((c) => c.owner.toLowerCase() === me).sort((a, b) => a.at - b.at).slice(0, EARNING_PLOT_LIMIT);
      for (const row of mine) {
        let world: World | null = null;
        try {
          const published = await readWorld(row.seed);
          world = published ? worldFromSave(published.snapshot as SavedWorld, row.seed, row.worldName) : null;
        } catch { world = null; }
        landWeight += judgedLevel(world, days * 3) * (days / 7);
      }
    } catch { landWeight = 0; }
  }
  let paid: Standing['paid'] = [];
  try { paid = paidRaw ? (JSON.parse(paidRaw) as Standing['paid']).slice(-8) : []; } catch { paid = []; }
  return {
    epoch, pool, registered: !!registered, lowBalance: low === null ? null : Number(low), presentDays: days, landWeight: Math.round(landWeight * 100) / 100,
    claimable: claimable ?? '0', paid, settlements, gld: GLD_ADDRESS, automatic: vaultCanSign(),
  };
}

export type Claimed = { ok: true; units: string; txHash: string | null; simulated: boolean } | { ok: false; reason: string };

/** Send a wallet its GLD. Zeroed first, so a slow chain cannot pay twice; put back if the send fails. */
export async function claimGld(who: string): Promise<Claimed> {
  const me = who.toLowerCase();
  const units = BigInt((await hget(CLAIMS, me)) ?? '0');
  if (units <= 0n) return { ok: false, reason: 'Nothing to claim yet.' };
  if (!(await takeLock(`${LOCK}:${me}`, 60))) return { ok: false, reason: 'A claim is already going out.' };
  try {
    await hset(CLAIMS, me, '0');
    const live = tokenLive() && vaultCanSign();
    let txHash: string | null = null;
    if (live) {
      const sent = await sendTokenFromVault(GLD_ADDRESS, me, units);
      if (!sent.ok) { await hset(CLAIMS, me, String(units)); return { ok: false, reason: sent.problem }; }
      txHash = sent.txHash;
    }
    let paid: Standing['paid'] = [];
    try { paid = JSON.parse((await hget(PAID, me)) ?? '[]') as Standing['paid']; } catch { paid = []; }
    paid.push({ at: Date.now(), units: String(units), txHash });
    await hset(PAID, me, JSON.stringify(paid.slice(-20)));
    return { ok: true, units: String(units), txHash, simulated: !live };
  } finally {
    await releaseLock(`${LOCK}:${me}`);
  }
}

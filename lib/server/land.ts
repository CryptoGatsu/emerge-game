import { DAILY_EARN_CEILING, EARNING_PLOT_LIMIT, WALLET_DAILY_CEILING, HAND_SHARE } from '../chain/vault';
import { charterMultiplier, plotCeiling } from '../world/eras';
import { cityLevel, stewardshipScore, type World } from '../simulation';
import { worldFromSave, type SavedWorld } from '../world/save';
import 'server-only';

/**
 * Does this wallet hold any land?
 *
 * Asked before paying stewardship out, and it is the one real defence against
 * a wallet farm. Earnings are the half of the ledger the server cannot verify —
 * the simulation runs in the player's browser — so the question becomes how
 * expensive it is to *be* a player at all. A plot costs two hundred thousand
 * $EMERGE or more and burns it, so an identity has to spend before it can earn.
 *
 * Where a registry is deployed the chain is asked and nothing else: `balanceOf`
 * on the land registry cannot be talked into a wrong answer.
 *
 * **Where there is no registry, a claim row counts — but only while the token
 * is live.** The relay's claims are the server's own word about who owns what,
 * and on their own they would be worthless here: an attacker who can write a
 * claim could unlock earnings. What makes them worth something in this one
 * configuration is `/api/plots`, which in exactly this case refuses to write a
 * row until it has read a burn off the chain: a real transaction, from this
 * wallet, settled, worth at least the plot price, and single-use. So the row is
 * evidence that this identity spent, which is the whole property the registry
 * was here to provide. The question is only ever *how* it was proved.
 *
 * With no registry **and** no token, claiming costs nothing at all, so a claim
 * row proves nothing and this answers false. That is the case the earlier
 * blanket refusal was really written for — a live token with a free claim would
 * have been a faucet, not a game. Deposits and principal withdrawals never
 * depended on any of this.
 */

import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ACTIVE_CHAIN, tokenBalance, tokenLive } from '../chain/emerge';
import { HAND_MIN_EMERGE } from '../chain/vault';
import { allClaims, jobOf, readWorld, type Claim, presenceDays, lastSeenAt } from './registry';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const ERC721 = [
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }],
  },
] as const;

export type LandCheck = 'holds' | 'none' | 'no-registry' | 'unreachable';

/** Whether the relay shows any plot standing in this wallet's name. */
/**
 * The highest era among the plots this wallet holds, from the claim rows.
 * The row's era is set only by the advance route, which re-runs the gate on
 * the published world and verifies the burn, so it is the record to pay by.
 */
export async function eraHeldBy(address: string): Promise<number> {
  try {
    const me = address.toLowerCase();
    const rows = await allClaims();
    return rows.filter((c) => c.owner.toLowerCase() === me).reduce((era, c) => Math.max(era, c.era ?? 1), 1);
  } catch {
    return 1;
  }
}

/**
 * The level a plot is paid on.
 *
 * The published world says what the city has become, and a published world
 * is the client's word. What the client cannot write is the days its owner
 * was actually present, which the heartbeat records; so the level is the
 * smaller of the two, three present days per level. A day-old claim with a
 * level-ten snapshot is paid as level one; a city somebody has looked in on
 * for a month is paid as what it is.
 */
export const LEVEL_PRESENCE_DAYS = 3;
export function judgedLevel(world: World | null, presentDays: number): number {
  const fromWorld = world ? cityLevel(world) : 1;
  const fromPresence = 1 + Math.floor(Math.max(0, presentDays) / LEVEL_PRESENCE_DAYS);
  return Math.max(1, Math.min(fromWorld, fromPresence));
}

/** The same attention rule the settlement runs, on the server's own record of the owner's presence. */
const ATTENTION_HOURS = 36;
const ATTENTION_FLOOR = 0.08;
/**
 * A day's grace: somebody who played this morning and withdraws tonight was
 * attending all day, and is judged so. The decay starts a day after the last
 * heartbeat, at the same slope the settlement uses.
 */
const GRACE_MS = 24 * 3_600_000;
export const attentionFrom = (lastSeen: number, now = Date.now()) =>
  lastSeen > 0 ? Math.max(ATTENTION_FLOOR, 1 - Math.max(0, now - lastSeen - GRACE_MS) / 3_600_000 / ATTENTION_HOURS) : ATTENTION_FLOOR;

export interface Judged {
  /** The wallet's earning plots' ceilings, added up. */
  ceiling: number;
  /** What those plots earn in a real day as the server sees them: ceiling times score times attention. */
  yield: number;
  plots: { seed: number; level: number; era: number; score: number; attention: number; ceiling: number }[];
}

/**
 * What this wallet may collect in a day, judged here rather than reported.
 *
 * Each earning plot: its ceiling from the judged level, the era and charter
 * on its claim row; its stewardship score computed from the published world
 * with the same function the settlement runs; its attention from the owner's
 * last heartbeat on it. The payout route pays the lesser of what the client
 * claims and this. Never more than WALLET_DAILY_CEILING.
 */
export async function judgedFor(address: string): Promise<Judged> {
  const me = address.toLowerCase();
  let rows: Claim[];
  try { rows = await allClaims(); } catch { return { ceiling: DAILY_EARN_CEILING, yield: 0, plots: [] }; }
  const mine = rows.filter((c) => c.owner.toLowerCase() === me).sort((a, b) => a.at - b.at).slice(0, EARNING_PLOT_LIMIT);
  if (!mine.length) return { ceiling: DAILY_EARN_CEILING, yield: 0, plots: [] };
  const now = Date.now();
  let days = 0;
  try { days = await presenceDays(me); } catch { days = 0; }
  const plots: Judged['plots'] = [];
  let ceiling = 0, yieldSum = 0;
  for (const row of mine) {
    let world: World | null = null;
    try {
      const published = await readWorld(row.seed);
      world = published ? worldFromSave(published.snapshot as SavedWorld, row.seed, row.worldName) : null;
    } catch { world = null; }
    const level = judgedLevel(world, days);
    const era = row.era ?? 1;
    const cap = Math.round(plotCeiling(level, era) * charterMultiplier(row.charterUntil, now));
    let score = 0;
    try { score = world ? stewardshipScore(world) : 0; } catch { score = 0; }
    let attention = ATTENTION_FLOOR;
    try { attention = attentionFrom(await lastSeenAt(row.seed, me), now); } catch { attention = ATTENTION_FLOOR; }
    ceiling += cap;
    yieldSum += cap * score * attention;
    plots.push({ seed: row.seed, level, era, score, attention, ceiling: cap });
  }
  // Five plots at the top would come to more than a wallet may take in a day.
  return { ceiling: Math.max(1, Math.min(WALLET_DAILY_CEILING, ceiling)), yield: Math.max(0, Math.min(WALLET_DAILY_CEILING, Math.round(yieldSum))), plots };
}

/** Kept for callers that only want the ceiling. */
export async function ceilingHeldBy(address: string): Promise<number> {
  return (await judgedFor(address)).ceiling;
}

/** A hand's ceiling: a tenth of the ceiling of the plot they work, judged the same way. */
export async function handCeilingFor(address: string): Promise<number> {
  try {
    const job = await jobOf(address);
    if (!job) return 0;
    let world: World | null = null;
    try {
      const published = await readWorld(job.seed);
      world = published ? worldFromSave(published.snapshot as SavedWorld, job.seed, job.worldName) : null;
    } catch { world = null; }
    const days = await presenceDays(job.owner).catch(() => 0);
    const level = judgedLevel(world, days);
    return Math.max(1, Math.round(plotCeiling(level, job.era ?? 1) * HAND_SHARE));
  } catch {
    return 0;
  }
}

async function claimsHeldBy(address: string): Promise<boolean> {
  const wanted = address.toLowerCase();
  const claims = await allClaims();
  return claims.some((c) => c.owner.toLowerCase() === wanted);
}

/**
 * The same question, answered in a way the caller can explain to a player.
 *
 * All three refusals used to be one `false`, and the player was told the same
 * thing every time: that they hold no land. Somebody standing in a settlement
 * they own reads that as the game lying to them — and where the registry is
 * unreachable or not deployed, it was. Failing closed is right; saying the
 * wrong reason is not.
 */
export async function landCheck(address: string): Promise<LandCheck> {
  const registry = ACTIVE_CHAIN.registryAddress;
  if (!registry) {
    // No registry and no token: claiming is free, so a claim row is not
    // evidence of anything and stewardship stays shut.
    if (!tokenLive()) return 'no-registry';
    try {
      const held = await claimsHeldBy(address);
      return held ? 'holds' : 'none';
    } catch {
      // The relay is the only record there is here, so not being able to read
      // it is the same kind of "we could not find out" as an unreachable node.
      return 'unreachable';
    }
  }
  try {
    const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const held = await client.readContract({
      address: registry as Hex, abi: ERC721, functionName: 'balanceOf', args: [address as Hex],
    });
    return held > 0n ? 'holds' : 'none';
  } catch {
    /*
     * A chain we cannot reach must not become a way to be paid.
     *
     * Failing closed here costs an honest player a retry; failing open would
     * mean an RPC outage is an open door.
     */
    return 'unreachable';
  }
}

/**
 * Whether this wallet may be paid as a hired hand.
 *
 * The job row is the server's own word, written only after the same checks
 * the hiring made — no land, a live session — and the balance floor is read
 * off the chain at the moment of paying, so a wallet that took the job and
 * then emptied itself is not paid on the strength of what it used to hold.
 * Without a live token there is nothing to hold, and the door stays shut
 * the same way it does for landholders.
 */
export async function handCheck(address: string): Promise<'hand' | 'none' | 'unreachable'> {
  if (!tokenLive()) return 'none';
  try {
    const job = await jobOf(address);
    if (!job) return 'none';
    const held = await tokenBalance(address);
    if (held === null) return 'unreachable';
    return held >= HAND_MIN_EMERGE ? 'hand' : 'none';
  } catch {
    return 'unreachable';
  }
}

export async function holdsLand(address: string): Promise<boolean> {
  return (await landCheck(address)) === 'holds';
}

/**
 * Who the chain says holds one plot, or null if nobody does.
 *
 * Used to stop the relay being squatted. The relay's claim rows are what the
 * world map draws, and writing one costs nothing — so without this a single
 * script could POST a claim for every seed on every chart and make the whole
 * map read as taken, blocking real players who would have paid. Once a registry
 * exists the relay may only record what the chain already agrees with.
 *
 * Throws rather than returning null on an unreachable chain, so the caller can
 * tell "nobody owns it" from "we could not find out" — treating the second as
 * the first is how an RPC outage becomes an open door.
 */
export async function ownerOnChain(seed: number): Promise<string | null> {
  const registry = ACTIVE_CHAIN.registryAddress;
  if (!registry) return null;
  const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
  try {
    const owner = await client.readContract({
      address: registry as Hex, abi: ERC721, functionName: 'ownerOf', args: [BigInt(seed)],
    });
    return /^0x0+$/.test(owner) ? null : owner.toLowerCase();
  } catch (error) {
    // `ownerOf` reverts for a plot nobody has claimed. That is an answer, not a
    // failure — but a network error is a failure, and must not read as one.
    const message = error instanceof Error ? error.message : '';
    if (/revert|nonexistent|not a token|execution/i.test(message)) return null;
    throw error;
  }
}

/** True when this deployment has a land contract to check against. */
export const registryConfigured = () => !!ACTIVE_CHAIN.registryAddress;

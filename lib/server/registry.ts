/**
 * The shared record of who owns what, what their world looks like, and who is
 * watching it.
 *
 * Until the land registry contract is deployed this is the only thing standing
 * between two players and both "owning" the same plot. It is deliberately the
 * server's word and not the client's: a claim is accepted or refused here, and
 * a browser that says it already owns something is not evidence.
 *
 * Three things live in it.
 *
 * **Claims.** One row per plot seed, holding the owner's address and when they
 * took it. First write wins; a second claim on the same seed is refused rather
 * than overwritten.
 *
 * **Worlds.** A snapshot the owner publishes every so often, so a visitor sees
 * the settlement as it actually is rather than a fresh one regenerated from the
 * seed. Snapshots expire, so a world nobody has opened in a day stops being
 * served and stops taking up room.
 *
 * **Presence.** Who is looking at which world, as a heartbeat with a timeout.
 * Nobody logs out cleanly, so the only workable definition of "here" is "said
 * something recently".
 *
 * **Discoveries.** Land somebody surveyed into existence. Also one row per
 * place, and also allocated here rather than by the client: two players
 * prospecting the same chart used to pick their slot from their own record
 * alone, so they took the same one, their markers landed on top of each other,
 * and neither could see the other's island at all.
 *
 * **Gifts.** Gold sent to another player's treasury, queued until their world
 * next opens. A visitor's browser runs its own copy of the world it is looking
 * at; a gift applied there would vanish with the visit.
 */

import { MAX_GIFT_GOLD } from '../limits';
import { clear, getValue, hdel, hget, hgetall, hset, push, range, setValue, shared } from './kv';

export { MAX_GIFT_GOLD };

export { shared as registryShared };

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export interface Claim {
  seed: number;
  /** The plot's place name, as the world map shows it. */
  region: string;
  /** What the owner called their world. */
  worldName: string;
  /** The wallet address that holds it. Lower-cased on the way in. */
  owner: string;
  /** What the owner is called in chat, so a claim can be attributed to a person. */
  ownerName: string;
  price: number;
  at: number;
}

const CLAIMS = 'emerge:claims';

/** Every claim on record, newest first. */
export async function allClaims(): Promise<Claim[]> {
  const rows = await hgetall(CLAIMS);
  const out: Claim[] = [];
  for (const raw of Object.values(rows)) {
    try {
      const claim = JSON.parse(raw) as Claim;
      if (claim && typeof claim.seed === 'number') out.push(claim);
    } catch {
      // A malformed row is skipped rather than failing the whole read.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Who holds one plot, or null. */
export async function claimOf(seed: number): Promise<Claim | null> {
  const raw = await hget(CLAIMS, String(seed));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Claim;
  } catch {
    return null;
  }
}

export type ClaimResult =
  | { ok: true; claim: Claim }
  | { ok: false; taken: Claim };

/**
 * Take a plot, if nobody has it.
 *
 * The read and the write are not atomic, which on a busy registry would be a
 * race. Two people claiming the same seed inside the same few milliseconds is
 * not a load this game will see before the contract exists, and the failure
 * mode — the later writer wins and the earlier one is told they own it — is
 * repaired the moment the real registry lands. Said plainly here rather than
 * left for a reader to discover.
 *
 * A claim by the address that already holds the plot is not a conflict: it is
 * the same player walking back into their own world.
 */
export async function takeClaim(claim: Claim): Promise<ClaimResult> {
  const existing = await claimOf(claim.seed);
  if (existing && existing.owner.toLowerCase() !== claim.owner.toLowerCase()) {
    return { ok: false, taken: existing };
  }
  const row: Claim = { ...claim, owner: claim.owner.toLowerCase() };
  await hset(CLAIMS, String(claim.seed), JSON.stringify(row));
  return { ok: true, claim: row };
}

/** Give a plot up, if it is yours to give up. */
export async function releaseClaim(seed: number, owner: string): Promise<boolean> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() !== owner.toLowerCase()) return false;
  await hdel(CLAIMS, String(seed));
  await hdel(WORLDS_INDEX, String(seed));
  return true;
}

/* ------------------------------------------------------------------ *
 * Discoveries
 * ------------------------------------------------------------------ */

export interface Find {
  seed: number;
  chart: number;
  slot: number;
  /** Who paid to survey it. Everybody can see it; only they get the credit. */
  finder: string;
  finderName: string;
  at: number;
}

const FINDS = 'emerge:finds';
const findKey = (chart: number, slot: number) => `${chart}:${slot}`;

/** Every plot anybody has surveyed into existence. */
export async function allFinds(): Promise<Find[]> {
  const rows = await hgetall(FINDS);
  const out: Find[] = [];
  for (const raw of Object.values(rows)) {
    try {
      const find = JSON.parse(raw) as Find;
      if (find && Number.isFinite(find.seed)) out.push(find);
    } catch {
      // A malformed row is skipped rather than failing the whole read.
    }
  }
  return out;
}

export type SurveyResult =
  | { ok: true; find: Find }
  | { ok: false; reason: string };

/**
 * Survey a new plot on a chart.
 *
 * The server picks the slot, not the caller. A client choosing its own slot can
 * only see the plots it already knows about, which is why two players who had
 * never met could both survey "the third berth on Kestrel Reach" and end up
 * with two settlements at the same point on the map.
 *
 * `capacity` comes from the caller because the island geometry is the client's
 * to know, but it is clamped: a client claiming a chart holds a thousand plots
 * gets the same answer as one telling the truth about a full chart.
 */
export async function survey(
  chart: number,
  capacity: number,
  finder: string,
  finderName: string,
): Promise<SurveyResult> {
  const room = Math.max(0, Math.min(64, Math.floor(capacity)));
  const taken = new Set((await allFinds()).filter((f) => f.chart === chart).map((f) => f.slot));
  let slot = -1;
  for (let i = 0; i < room; i++) {
    if (!taken.has(i)) { slot = i; break; }
  }
  if (slot < 0) return { ok: false, reason: 'Every island on this chart has been surveyed.' };

  const find: Find = {
    // Ours, so two people surveying at once cannot be handed the same land.
    seed: ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 8) || 1,
    chart,
    slot,
    finder: finder.toLowerCase(),
    finderName,
    at: Date.now(),
  };
  await hset(FINDS, findKey(chart, slot), JSON.stringify(find));
  return { ok: true, find };
}

/* ------------------------------------------------------------------ *
 * Gifts
 * ------------------------------------------------------------------ */

export interface Gift {
  id: string;
  seed: number;
  /** Gold to add to the settlement's treasury. */
  gold: number;
  fromName: string;
  from: string;
  at: number;
}

const giftKey = (seed: number) => `emerge:gifts:${seed}`;



/** How many gifts a world keeps waiting. */
const GIFT_QUEUE = 50;

/** Leave Gold for a settlement's owner to find. */
export async function leaveGift(gift: Gift): Promise<void> {
  await push(giftKey(gift.seed), JSON.stringify(gift), GIFT_QUEUE);
}

/**
 * Take everything waiting for a world, and clear the queue.
 *
 * Read-and-clear rather than read-then-mark, because the owner's client applies
 * what it gets to a running settlement and there is no second chance to ask.
 * The window in which a gift arriving at this exact moment could be dropped is
 * one round trip; a lost gift is better than one applied twice, which would be
 * minting Gold.
 */
export async function collectGifts(seed: number): Promise<Gift[]> {
  const key = giftKey(seed);
  const raw = await range(key);
  if (!raw.length) return [];
  await clear(key);
  const out: Gift[] = [];
  for (const entry of raw) {
    try {
      const gift = JSON.parse(entry) as Gift;
      if (gift && gift.gold > 0) out.push(gift);
    } catch {
      // As above.
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Published worlds
 * ------------------------------------------------------------------ */

/**
 * How long a published snapshot is served for.
 *
 * Long enough that a visitor to a world whose owner logged off this morning
 * still sees the settlement; short enough that abandoned worlds fall out on
 * their own rather than accumulating for ever.
 */
const WORLD_TTL_SECONDS = 36 * 3600;

const WORLDS_INDEX = 'emerge:worlds';
const worldKey = (seed: number) => `emerge:world:${seed}`;

export interface PublishedWorld {
  seed: number;
  owner: string;
  ownerName: string;
  worldName: string;
  day: number;
  population: number;
  at: number;
  /** The saved world, exactly as the owner's browser keeps it. */
  snapshot: unknown;
}

/** Put a world up for visitors. */
export async function publishWorld(world: PublishedWorld): Promise<void> {
  await setValue(worldKey(world.seed), JSON.stringify(world), WORLD_TTL_SECONDS);
  // The index carries only the headline, so a listing does not have to read
  // every snapshot in the store.
  const { snapshot: _snapshot, ...headline } = world;
  await hset(WORLDS_INDEX, String(world.seed), JSON.stringify(headline));
}

/** One published world, or null when nobody has published it lately. */
export async function readWorld(seed: number): Promise<PublishedWorld | null> {
  const raw = await getValue(worldKey(seed));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublishedWorld;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/**
 * How long after their last heartbeat somebody still counts as watching.
 *
 * Nobody closes a tab politely, so presence is a timeout rather than a
 * sign-out. Three missed beats at the client's fifteen-second interval.
 */
const PRESENCE_TTL_MS = 50_000;

const presenceKey = (seed: number) => `emerge:seen:${seed}`;

/**
 * Say that somebody is looking at a world, and return who else is.
 *
 * The owner is recorded but never counted. "2 watching" on your own settlement
 * when one visitor has arrived reads as two strangers; what the player wants to
 * know is how many people are looking at their world besides themselves, and a
 * badge that says 1 when nobody is there is worse than no badge.
 */
export async function heartbeat(seed: number, who: string): Promise<string[]> {
  const key = presenceKey(seed);
  await hset(key, who, String(Date.now()));
  const rows = await hgetall(key);
  const now = Date.now();
  const live: string[] = [];
  for (const [id, at] of Object.entries(rows)) {
    if (now - Number(at) <= PRESENCE_TTL_MS) live.push(id);
    // Sweep as we read: there is no other moment when a stale row is noticed,
    // and without this the hash grows by one for every visitor ever.
    else await hdel(key, id);
  }
  return withoutOwner(seed, live);
}

/** Who is looking at a world right now, without joining them. */
export async function watchers(seed: number): Promise<string[]> {
  const rows = await hgetall(presenceKey(seed));
  const now = Date.now();
  const live = Object.entries(rows)
    .filter(([, at]) => now - Number(at) <= PRESENCE_TTL_MS)
    .map(([id]) => id);
  return withoutOwner(seed, live);
}

/** Everyone present except whoever owns the place. */
async function withoutOwner(seed: number, present: string[]): Promise<string[]> {
  const claim = await claimOf(seed);
  if (!claim) return present;
  const owner = claim.owner.toLowerCase();
  return present.filter((id) => id.toLowerCase() !== owner);
}

/** Stop counting somebody as present, when they do leave politely. */
export async function depart(seed: number, who: string): Promise<void> {
  await hdel(presenceKey(seed), who);
}

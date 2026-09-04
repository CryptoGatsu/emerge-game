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

import { MAX_GIFT_GOLD, serverKey } from '../limits';
import { HOME_CHART_INDEX, HOME_CHART_RESERVED, chartCapacity } from '../world/charts';
import {
  clear, getValue, hdel, hget, hgetall, hset, hsetnx, push, range, releaseLock, setValue, shared,
  takeLock,
} from './kv';

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
  /** The asking price, in whole tokens, while the owner has it up for sale. */
  forSale?: number;
  listedAt?: number;
  /** Offers other players have made on it, best first. */
  offers?: Offer[];
  /** The owner is looking for a hired hand. */
  hiring?: boolean;
  /** Whoever holds that job. */
  hand?: Hand;
  /** When the owner expanded the plot. Once per plot, so this is the record that stops a second charge. */
  expandedAt?: number;
}

/**
 * A hired hand: a player with no land of their own, paid to attend somebody
 * else's. The row is the job; there is one per plot and one per wallet.
 */
export interface Hand {
  address: string;
  name: string;
  since: number;
  /** When they last had the plot open, so the owner's attention can count it. */
  lastSeen: number;
}

/**
 * An offer on somebody's plot.
 *
 * Not binding and not escrowed: nobody's tokens are held. An offer is a price
 * the bidder says they will pay; the owner accepting it reserves the plot for
 * that bidder at that price for a while, and the bidder then pays the owner
 * wallet to wallet exactly as they would for a listed plot.
 */
export interface Offer {
  buyer: string;
  buyerName: string;
  price: number;
  at: number;
  /** Set when the owner accepted it: the bidder may buy at this price until then. */
  acceptedUntil?: number;
}

/** How long an accepted offer holds the plot for its bidder. */
const OFFER_HOLD_MS = 48 * 3600_000;
/** The most offers one plot carries; the lowest goes when a better one arrives. */
const MAX_OFFERS = 8;

const CLAIMS = serverKey('claims');

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
 * **This is the whole of land ownership.** With no registry contract deployed
 * there is no chain to appeal to: this row is the title, so it is written with
 * a set-if-absent and never with a read followed by a write. Two players
 * claiming the same seed in the same millisecond both used to pass the read and
 * the later write won, leaving the earlier player told they owned something
 * they did not. `HSETNX` answers true to exactly one of them.
 *
 * A claim by the address that already holds the plot is not a conflict — it is
 * the same player walking back into their own world — but it does not overwrite
 * the row either. The date and the price on a title are the ones it was taken
 * at, and an owner re-entering should not be able to rewrite them.
 */
export async function takeClaim(claim: Claim): Promise<ClaimResult> {
  const row: Claim = { ...claim, owner: claim.owner.toLowerCase() };
  const mine = await hsetnx(CLAIMS, String(claim.seed), JSON.stringify(row));
  if (mine) return { ok: true, claim: row };

  // Somebody already holds it. Theirs, unless it is this player walking back in.
  const existing = await claimOf(claim.seed);
  if (!existing) {
    // The row vanished between the write and the read — the only way that
    // happens is a release landing in the gap, so let them try again rather
    // than reporting an owner that is not there.
    return { ok: false, taken: { ...row, owner: '' } };
  }
  if (existing.owner.toLowerCase() === row.owner.toLowerCase()) {
    return { ok: true, claim: existing };
  }
  return { ok: false, taken: existing };
}

/* ------------------------------------------------------------------ *
 * Reservations
 * ------------------------------------------------------------------ */

/**
 * How long a plot is held while its buyer pays for it.
 *
 * Paying is a wallet prompt and a few blocks of confirmation, so a plot has to
 * be off the market for as long as that takes or two people can burn tokens for
 * the same land and only one can have it. Long enough for a slow confirmation,
 * short enough that an abandoned checkout frees the plot again while somebody
 * is still looking at it.
 */
const RESERVE_SECONDS = 240;

const reserveKey = (seed: number) => serverKey(`hold:${seed}`);

export type ReserveResult =
  | { ok: true; seconds: number }
  | { ok: false; reason: string };

/**
 * Hold a plot for one wallet while they pay.
 *
 * Taken before any money moves, so the answer to "can I have this?" arrives
 * before the answer to "will you pay for it?" — which is the order that means
 * nobody burns tokens for land they cannot get.
 */
export async function reservePlot(seed: number, owner: string): Promise<ReserveResult> {
  const existing = await claimOf(seed);
  if (existing && existing.owner.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, reason: 'Somebody else already holds that plot.' };
  }
  const key = reserveKey(seed);
  const got = await takeLock(key, RESERVE_SECONDS);
  if (got) {
    await setValue(key, owner.toLowerCase(), RESERVE_SECONDS);
    return { ok: true, seconds: RESERVE_SECONDS };
  }
  const heldBy = await getValue(key);
  if (heldBy && heldBy.toLowerCase() === owner.toLowerCase()) {
    return { ok: true, seconds: RESERVE_SECONDS };
  }
  return { ok: false, reason: 'Somebody is buying that plot right now. Try again in a few minutes.' };
}

/** Whether this wallet is the one holding a plot open. */
export async function holdsReservation(seed: number, owner: string): Promise<boolean> {
  const heldBy = await getValue(reserveKey(seed));
  return !!heldBy && heldBy.toLowerCase() === owner.toLowerCase();
}

/** Let a plot go, once it is claimed or abandoned. */
export const dropReservation = (seed: number) => releaseLock(reserveKey(seed));

/**
 * Put a plot up for sale, or take it back off the market.
 *
 * The listing lives on the claim row itself, so every reader of the map sees
 * it without a second lookup, and it goes away with the row when the plot
 * changes hands.
 */
export async function listClaim(seed: number, owner: string, price: number | null): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() !== owner.toLowerCase()) return null;
  const { forSale: _forSale, listedAt: _listedAt, ...rest } = existing;
  const row: Claim = price && price > 0 ? { ...rest, forSale: Math.round(price), listedAt: Date.now() } : rest;
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/* ------------------------------------------------------------------ *
 * Hired hands
 * ------------------------------------------------------------------ */

/** Turn hiring on or off. Off dismisses whoever held the job. */
export async function setHiring(seed: number, owner: string, hiring: boolean): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() !== owner.toLowerCase()) return null;
  const { hiring: _hiring, hand: _hand, ...rest } = existing;
  const row: Claim = hiring ? { ...rest, hiring: true } : rest;
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/**
 * Record that a plot was expanded.
 *
 * The row is what makes "once per plot" true across devices: the world save
 * carries the flag too, but a browser that never saw the expansion would
 * otherwise offer to sell it again.
 */
export async function markExpanded(seed: number, owner: string): Promise<{ claim: Claim; already: boolean } | null> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() !== owner.toLowerCase()) return null;
  if (existing.expandedAt) return { claim: existing, already: true };
  const row: Claim = { ...existing, expandedAt: Date.now() };
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return { claim: row, already: false };
}

/** The plot this wallet works at, if any. */
export async function jobOf(worker: string): Promise<Claim | null> {
  const me = worker.toLowerCase();
  const claims = await allClaims();
  return claims.find((c) => c.hand?.address === me) ?? null;
}

export type JobResult = { ok: true; claim: Claim } | { ok: false; reason: string };

/**
 * Take the job at a plot.
 *
 * One hand per plot and one job per wallet, and never a landholder: a player
 * with a plot has their own attention to give it, and the point of the job
 * is to let somebody without land into the game. Taking the job you already
 * hold is not an error.
 */
export async function takeJob(seed: number, worker: string, name: string): Promise<JobResult> {
  const me = worker.toLowerCase();
  const existing = await claimOf(seed);
  if (!existing) return { ok: false, reason: 'Nobody holds that plot.' };
  if (existing.owner.toLowerCase() === me) return { ok: false, reason: 'That is your own plot.' };
  if (existing.hand && existing.hand.address === me) return { ok: true, claim: existing };
  if (!existing.hiring) return { ok: false, reason: 'That plot is not hiring.' };
  if (existing.hand) return { ok: false, reason: `${existing.hand.name || 'Somebody'} already works there.` };
  const claims = await allClaims();
  if (claims.some((c) => c.owner.toLowerCase() === me)) {
    return { ok: false, reason: 'Landholders run their own plots. Hired hands are for players without one.' };
  }
  const elsewhere = claims.find((c) => c.hand?.address === me);
  if (elsewhere) {
    return { ok: false, reason: `You already work at ${elsewhere.worldName || elsewhere.region}. Quit there first.` };
  }
  const now = Date.now();
  const row: Claim = { ...existing, hand: { address: me, name: name.slice(0, 32), since: now, lastSeen: now } };
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return { ok: true, claim: row };
}

/** Leave the job, or as the owner, let the hand go. */
export async function quitJob(seed: number, who: string): Promise<Claim | null> {
  const me = who.toLowerCase();
  const existing = await claimOf(seed);
  if (!existing) return null;
  const owner = existing.owner.toLowerCase() === me;
  if (!owner && existing.hand?.address !== me) return null;
  const { hand: _hand, ...row } = existing;
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/** The hand says they are at work: their presence is what the owner's attention counts. */
export async function attendJob(seed: number, worker: string): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing?.hand || existing.hand.address !== worker.toLowerCase()) return null;
  const row: Claim = { ...existing, hand: { ...existing.hand, lastSeen: Date.now() } };
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/** Whether an accepted offer is still good. */
const offerLive = (offer: Offer, now = Date.now()) => !!offer.acceptedUntil && offer.acceptedUntil > now;

/** Put an offer on a plot, replacing the bidder's earlier one. */
export async function placeOffer(seed: number, buyer: string, buyerName: string, price: number): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() === buyer.toLowerCase()) return null;
  const mine = buyer.toLowerCase();
  const offers = (existing.offers ?? []).filter((o) => o.buyer !== mine);
  offers.push({ buyer: mine, buyerName, price: Math.round(price), at: Date.now() });
  offers.sort((a, b) => b.price - a.price);
  const row: Claim = { ...existing, offers: offers.slice(0, MAX_OFFERS) };
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/** Take an offer back. */
export async function withdrawOffer(seed: number, buyer: string): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing) return null;
  const mine = buyer.toLowerCase();
  const row: Claim = { ...existing, offers: (existing.offers ?? []).filter((o) => o.buyer !== mine) };
  if (!row.offers?.length) delete row.offers;
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/**
 * The owner answers an offer.
 *
 * Accepting holds the plot for that bidder at that price for two days —
 * long enough to come back and pay, short enough that a bidder who walks
 * away does not tie the plot up. Only one offer is accepted at a time.
 */
export async function answerOffer(seed: number, owner: string, buyer: string, accept: boolean): Promise<Claim | null> {
  const existing = await claimOf(seed);
  if (!existing || existing.owner.toLowerCase() !== owner.toLowerCase()) return null;
  const who = buyer.toLowerCase();
  const offers = (existing.offers ?? []).map((o) => {
    const { acceptedUntil: _until, ...rest } = o;
    return o.buyer === who && accept ? { ...rest, acceptedUntil: Date.now() + OFFER_HOLD_MS } : rest;
  }).filter((o) => accept || o.buyer !== who);
  const row: Claim = { ...existing, offers };
  if (!row.offers?.length) delete row.offers;
  await hset(CLAIMS, String(seed), JSON.stringify(row));
  return row;
}

/**
 * What this bidder may buy the plot for: their accepted offer while it
 * holds, otherwise the public asking price, otherwise nothing.
 */
export function priceFor(claim: Claim, buyer: string): number | null {
  const mine = buyer.toLowerCase();
  const accepted = (claim.offers ?? []).find((o) => o.buyer === mine && offerLive(o));
  if (accepted) return accepted.price;
  return claim.forSale && claim.forSale > 0 ? claim.forSale : null;
}

export type TransferResult =
  | { ok: true; claim: Claim; price: number; seller: string }
  | { ok: false; reason: string };

/**
 * Move a plot from its seller to its buyer.
 *
 * Only a plot that is actually up for sale, and only at the price it was
 * listed at: the price the buyer paid is checked against this row by the
 * caller, so a seller cannot be paid less than they asked by a client that
 * quotes its own number. The settlement goes with the land — the published
 * world is re-stamped with the new owner, so the buyer walks into the town as
 * it stands rather than a fresh one grown from the seed — and the seller's
 * own record lets go of it, so they are not shown a plot they no longer hold.
 */
export async function transferClaim(seed: number, buyer: string, buyerName: string): Promise<TransferResult> {
  const existing = await claimOf(seed);
  if (!existing) return { ok: false, reason: 'Nobody holds that plot.' };
  if (existing.owner.toLowerCase() === buyer.toLowerCase()) return { ok: false, reason: 'That plot is already yours.' };
  const due = priceFor(existing, buyer);
  if (due === null) return { ok: false, reason: 'That plot is not for sale.' };
  const seller = existing.owner.toLowerCase();
  const row: Claim = {
    seed,
    region: existing.region,
    worldName: existing.worldName,
    owner: buyer.toLowerCase(),
    ownerName: buyerName,
    price: due,
    at: Date.now(),
  };
  await hset(CLAIMS, String(seed), JSON.stringify(row));

  // The settlement changes hands with the land.
  const world = await readWorld(seed);
  if (world) {
    await publishWorld({ ...world, owner: row.owner, ownerName: buyerName }).catch(() => {});
  }

  // The seller's record stops carrying it.
  try {
    const record = await readPlayerRecord(seller) as {
      claims?: { seed: number }[]; listings?: { seed: number }[];
    } | null;
    if (record && (Array.isArray(record.claims) || Array.isArray(record.listings))) {
      await savePlayerRecord(seller, {
        ...record,
        claims: (record.claims ?? []).filter((c) => c.seed !== seed),
        listings: (record.listings ?? []).filter((l) => l.seed !== seed),
        savedAt: Date.now(),
      });
    }
  } catch {
    // The map and the registry row are the title; the record catches up on
    // the seller's next visit either way.
  }
  return { ok: true, claim: row, price: due, seller };
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

const FINDS = serverKey('finds');
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
 * How much room a chart has is **not** the caller's to say. It used to be
 * clamped at sixty-four rather than at what the islands actually hold, and a
 * client that said "this chart has room for sixty-four" got sixty-four berths
 * on a chart with seventeen. Every slot past the last island has nowhere to
 * stand, so the map put all of them at the exact centre — a heap of markers
 * with only the top one readable, and the settlements underneath unreachable.
 * The geometry is in `lib/world/charts.ts` precisely so this side can read it,
 * so this side reads it.
 */
export async function survey(
  chart: number,
  capacity: number,
  finder: string,
  finderName: string,
): Promise<SurveyResult> {
  // The caller's figure is still honoured as a *lower* bound, so an older
  // client that knows about fewer islands than this build does cannot be handed
  // land it has no way to draw.
  const asked = Math.max(0, Math.min(64, Math.floor(capacity)));
  const room = Math.min(asked, chartCapacity(chart));
  const taken = new Set((await allFinds()).filter((f) => f.chart === chart).map((f) => f.slot));
  // The home chart opens with nine plots already standing in its first nine
  // berths. They are not in the finds hash — nobody surveyed them — so without
  // this the first survey is handed slot zero and the new settlement is drawn
  // on top of one that has been there since the game opened.
  const first = chart === HOME_CHART_INDEX ? HOME_CHART_RESERVED : 0;
  let slot = -1;
  for (let i = first; i < room; i++) {
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
 * Names
 *
 * What a wallet is called, kept once per address rather than copied onto
 * every row that mentions it.
 *
 * A claim carries the name its owner had on the day they bought the land, and
 * that is right for a record of a purchase — but it is wrong for "who is
 * talking", which is what chat needs. Somebody who changed their name went on
 * appearing under the old one for as long as the claim stood, and somebody who
 * had connected a wallet appeared as a hexadecimal address forever, because
 * that is what chat had to go on.
 *
 * Held here, keyed by the address the session proved, so it cannot be sent in
 * a message body and therefore cannot be aimed at somebody else's identity.
 * ------------------------------------------------------------------ */

const NAMES = serverKey('names');

/** The longest a display name may be. Matches what the interface will show. */
export const MAX_DISPLAY_NAME = 24;

/** Set what an address is called. The caller must already have proved it. */
export async function setDisplayName(address: string, name: string): Promise<void> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME);
  const key = address.toLowerCase();
  if (!clean) {
    await hdel(NAMES, key);
    return;
  }
  await hset(NAMES, key, JSON.stringify({ name: clean, at: Date.now() }));
}

/** Every name the relay knows, by lower-cased address. */
export async function displayNames(): Promise<Record<string, string>> {
  const rows = await hgetall(NAMES);
  const out: Record<string, string> = {};
  for (const [address, raw] of Object.entries(rows)) {
    try {
      const parsed = JSON.parse(raw) as { name?: string };
      if (typeof parsed.name === 'string' && parsed.name) out[address] = parsed.name;
    } catch {
      // A row we cannot read is a row we do not show.
    }
  }
  return out;
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

const giftKey = (seed: number) => serverKey(`gifts:${seed}`);



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
 * How long a published snapshot is kept.
 *
 * This used to be a day and a half, on the theory that a visitor only needs
 * to see a world whose owner was here recently. But the published copy is
 * also the owner's own backup: it is what a second device, a cleared browser
 * or a phone that lost its storage continues from. A day and a half meant
 * that a player who took a long weekend off came back to a world regenerated
 * from its seed — every building gone, the opening handful of people — and
 * that is the one thing this game must never do to somebody. So a snapshot
 * now lives for over a year, the same as the player's own record, and is
 * refreshed on every publish. Two hundred settlements at their largest come
 * to well under a hundred megabytes, which the store holds without noticing.
 */
const WORLD_TTL_SECONDS = 400 * 86_400;

const WORLDS_INDEX = serverKey('worlds');
const worldKey = (seed: number) => serverKey(`world:${seed}`);

export interface PublishedWorld {
  seed: number;
  owner: string;
  ownerName: string;
  worldName: string;
  day: number;
  /** The hour within that day, so two copies of the same day can be ordered. */
  hour?: number;
  population: number;
  at: number;
  /** The saved world, exactly as the owner's browser keeps it. */
  snapshot: unknown;
}

/**
 * Whether a snapshot at `day`/`hour` is behind one already held.
 *
 * Later means further along in the settlement's own time, never more recent
 * on the wall clock: a stale tab or an old phone saving a day-nine world
 * over a day-forty one is exactly the regression this exists to refuse.
 * The same day is accepted unless the held copy is more than an hour ahead,
 * so two devices trading publishes within a day never fight over minutes.
 */
export function isBehind(held: PublishedWorld, day: number, hour: number): boolean {
  if (held.day > day) return true;
  if (held.day < day) return false;
  const heldHour = typeof held.hour === 'number'
    ? held.hour
    : Number((held.snapshot as { world?: { hour?: unknown } } | null)?.world?.hour) || 0;
  return heldHour > hour + 1;
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

const presenceKey = (seed: number) => serverKey(`seen:${seed}`);

/**
 * Everybody playing, anywhere.
 *
 * Kept beside the per-world rows rather than derived from them: working out
 * how many people are in the game by reading the presence hash of every world
 * anybody has ever claimed is a request that gets slower the more successful
 * the game is.
 */
const EVERYONE = serverKey('seen:everyone');

/**
 * How many people are playing right now.
 *
 * Swept on read, like the per-world count, so somebody who closed their tab
 * stops counting within the heartbeat window rather than for ever.
 */
export async function playersOnline(): Promise<number> {
  const rows = await hgetall(EVERYONE);
  const now = Date.now();
  let live = 0;
  const stale: string[] = [];
  for (const [id, at] of Object.entries(rows)) {
    if (now - Number(at) <= PRESENCE_TTL_MS) live += 1;
    else stale.push(id);
  }
  for (const id of stale.slice(0, 64)) await hdel(EVERYONE, id);
  return live;
}

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
  // The same beat counts them as playing at all. One write rather than a
  // second heartbeat from the client, because a player is present in the game
  // exactly when they are present in a world.
  await hset(EVERYONE, who, String(Date.now()));
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

/**
 * Stop counting somebody as present, when they do leave politely.
 *
 * Only from the world, not from the game: leaving a settlement usually means
 * walking into another one, and a player who steps between two of their own
 * worlds should not blink out of the online count on the way.
 */
export async function depart(seed: number, who: string): Promise<void> {
  await hdel(presenceKey(seed), who);
}


/* ------------------------------------------------------------------ *
 * The player's own record
 *
 * Name, ledger, holdings: what used to live only in one browser's storage,
 * so a second device met a stranger with the same wallet. Written by the
 * session that proved the address and read back by any device that does.
 * ------------------------------------------------------------------ */

const playerKey = (address: string) => serverKey(`player:${address.toLowerCase()}`);
const PLAYER_TTL_SECONDS = 400 * 86_400;

export async function savePlayerRecord(address: string, record: unknown): Promise<void> {
  await setValue(playerKey(address), JSON.stringify(record), PLAYER_TTL_SECONDS);
}

export async function readPlayerRecord(address: string): Promise<unknown | null> {
  const raw = await getValue(playerKey(address));
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

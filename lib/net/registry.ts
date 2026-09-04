/**
 * The client half of the land registry.
 *
 * Thin wrappers over `/api/plots`, `/api/worlds` and `/api/presence`. Every one
 * of them answers rather than throwing: the game stays playable when the relay
 * is down, and the interface says what it could not reach instead of showing an
 * error where a settlement should be.
 */

import { withSession } from './session';

export interface Claim {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  price: number;
  at: number;
  /** The asking price while the owner has it up for sale. */
  forSale?: number;
  listedAt?: number;
  /** Offers other players have made, best first. */
  offers?: Offer[];
  /** The owner is looking for a hired hand. */
  hiring?: boolean;
  /** Whoever holds that job. */
  hand?: { address: string; name: string; since: number; lastSeen: number };
  /** When the owner expanded the plot. */
  expandedAt?: number;
  /** Which era the plot is in, as the registry has it. Absent means the first. */
  era?: number;
  eraAt?: number;
  charterUntil?: number;
  insuredUntil?: number;
  buildersUntil?: number;
}

export interface Offer {
  buyer: string;
  buyerName: string;
  price: number;
  at: number;
  /** The owner accepted it: the bidder may buy at this price until then. */
  acceptedUntil?: number;
}

/** What this wallet may buy a plot for: its accepted offer while it holds, else the asking price. */
export function priceFor(claim: Claim, buyer: string | null): number | null {
  const mine = buyer?.toLowerCase();
  const accepted = mine ? (claim.offers ?? []).find((o) => o.buyer === mine && !!o.acceptedUntil && o.acceptedUntil > Date.now()) : undefined;
  if (accepted) return accepted.price;
  return claim.forSale && claim.forSale > 0 ? claim.forSale : null;
}

export interface Find {
  seed: number;
  chart: number;
  slot: number;
  finder: string;
  finderName: string;
  at: number;
}

export interface Gift {
  id: string;
  seed: number;
  gold: number;
  from: string;
  fromName: string;
  at: number;
}

/** Who is here: at this settlement, and in the game at all. */
export interface Presence {
  /** People looking at this world, not counting its owner. */
  watching: number;
  /** People playing anywhere, or null when the relay could not say. */
  online: number | null;
}

export interface PublishedWorld {
  seed: number;
  owner: string;
  ownerName: string;
  worldName: string;
  day: number;
  population: number;
  at: number;
  snapshot: unknown;
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export interface ClaimsResult {
  claims: Claim[];
  /** Land anybody has surveyed into existence, so everyone sees the same map. */
  finds: Find[];
  /** True when the registry can actually see other players' claims. */
  shared: boolean;
  offline: boolean;
}

/** Every plot anybody holds, and every one anybody has found. */
export async function fetchClaims(): Promise<ClaimsResult> {
  try {
    const response = await fetch('/api/plots', { cache: 'no-store' });
    if (!response.ok) return { claims: [], finds: [], shared: false, offline: true };
    const json = (await response.json()) as { claims?: Claim[]; finds?: Find[]; shared?: boolean };
    return {
      claims: json.claims ?? [],
      finds: json.finds ?? [],
      shared: json.shared === true,
      offline: false,
    };
  } catch {
    return { claims: [], finds: [], shared: false, offline: true };
  }
}

export type ReserveResult =
  | { ok: true; seconds: number }
  | { ok: false; reason: string };

/**
 * Hold a plot before paying for it.
 *
 * Asked first, always. A player refused here has burned nothing — which is the
 * whole reason the two steps are in this order.
 */
export async function reservePlot(seed: number, owner: string): Promise<ReserveResult> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, reserve: true }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { reserved?: boolean; seconds?: number; error?: string };
    if (!response.ok || !json.reserved) {
      return { ok: false, reason: json.error ?? 'That plot could not be held.' };
    }
    return { ok: true, seconds: json.seconds ?? 240 };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

export type SurveyResult =
  | { ok: true; find: Find }
  | { ok: false; reason: string; settling?: boolean };

/**
 * Pay to find new land.
 *
 * The server chooses where: it is the only party that can see every plot
 * already surveyed on a chart, so it is the only one that can avoid putting
 * two settlements on the same berth.
 */
export async function surveyPlot(input: {
  chart: number; capacity: number; owner: string; ownerName: string; burnTx?: string;
}): Promise<SurveyResult> {
  try {
    const response = await withSession(
      input.owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, survey: true }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { find?: Find; error?: string; retry?: boolean };
    if (!response.ok || !json.find) {
      return {
        ok: false,
        reason: json.error ?? 'The registry refused the survey.',
        settling: json.retry === true,
      };
    }
    return { ok: true, find: json.find };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

export type TakeResult =
  | { ok: true; claim: Claim }
  | {
      ok: false; reason: string; taken?: Claim;
      /** The payment is real but the chain has not settled it yet. Worth waiting. */
      settling?: boolean;
    };

/**
 * Take a plot.
 *
 * The server decides. A refusal here is the whole reason this call exists, so
 * the caller must not treat a failure as "claim it locally anyway" — that is
 * exactly the behaviour that let two players own the same land.
 */
export async function takePlot(input: {
  seed: number; region: string; worldName: string; owner: string; ownerName: string;
  price: number; burnTx?: string;
}): Promise<TakeResult> {
  try {
    const response = await withSession(
      input.owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as {
      claim?: Claim; error?: string; taken?: Claim; retry?: boolean;
    };
    if (!response.ok || !json.claim) {
      return {
        ok: false,
        reason: json.error ?? 'The registry refused the claim.',
        taken: json.taken,
        settling: json.retry === true,
      };
    }
    return { ok: true, claim: json.claim };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** Put a plot up for sale at a price, or take it down with null. */
export async function listPlot(seed: number, owner: string, price: number | null): Promise<{ ok: boolean; reason?: string; claim?: Claim }> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, list: true, price }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; error?: string };
    if (!response.ok || !json.claim) return { ok: false, reason: json.error ?? 'The registry refused the listing.' };
    return { ok: true, claim: json.claim };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** One call for the offer verbs: they all come back with the claim as it now stands. */
async function offerCall(owner: string, body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; claim?: Claim }> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, owner }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; error?: string };
    if (!response.ok || !json.claim) return { ok: false, reason: json.error ?? 'The registry refused that.' };
    return { ok: true, claim: json.claim };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** Offer a price for somebody else's plot. */
export const placeOffer = (seed: number, bidder: string, bidderName: string, price: number) =>
  offerCall(bidder, { seed, offer: true, price, ownerName: bidderName });

export type ExpandResult =
  | { ok: true; claim: Claim; already: boolean }
  | { ok: false; reason: string; settling?: boolean };

/**
 * Expand a plot, once.
 *
 * The server checks the burn where the token is live, so the order is pay
 * first, then ask — and a plot already expanded comes back `already` rather
 * than refused, so a lost reply can be asked for again.
 */
export async function expandPlot(seed: number, owner: string, burnTx?: string): Promise<ExpandResult> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, expand: true, burnTx }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; already?: boolean; error?: string; retry?: boolean };
    if (!response.ok || !json.claim) {
      return { ok: false, reason: json.error ?? 'The registry refused the expansion.', settling: json.retry === true };
    }
    return { ok: true, claim: json.claim, already: json.already === true };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** Buy a charter or insurance on the plot: burned $EMERGE for a span of days on the row. */
/** Buy a boon for the plot: the registry verifies the payment; the world applies it. */
export async function boonPlot(seed: number, owner: string, kind: string, burnTx?: string): Promise<{ ok: true } | { ok: false; reason: string; settling?: boolean }> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, boon: kind, burnTx }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { ok?: boolean; error?: string; retry?: boolean };
    if (!response.ok || !json.ok) return { ok: false, reason: json.error ?? 'The registry refused.', settling: !!json.retry };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The registry could not be reached.' };
  }
}

export async function coverPlot(seed: number, owner: string, kind: 'charter' | 'insurance' | 'builders', burnTx?: string): Promise<{ ok: true; claim: Claim; until: number } | { ok: false; reason: string; settling?: boolean }> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, [kind === 'charter' ? 'charter' : kind === 'insurance' ? 'insure' : 'builders']: true, burnTx }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; until?: number; error?: string; retry?: boolean };
    if (!response.ok || !json.claim) {
      return { ok: false, reason: json.error ?? 'The registry refused it.', settling: json.retry === true };
    }
    return { ok: true, claim: json.claim, until: json.until ?? 0 };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/**
 * Advance a plot to the next era.
 *
 * The server judges the gate on the published copy, so the world is
 * published just before this is called. Pay first, then ask; a plot already
 * in the era comes back `already`.
 */
export async function advancePlot(seed: number, owner: string, era: number, burnTx?: string): Promise<ExpandResult> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, advance: true, era, burnTx }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; already?: boolean; error?: string; retry?: boolean };
    if (!response.ok || !json.claim) {
      return { ok: false, reason: json.error ?? 'The registry refused the advance.', settling: json.retry === true };
    }
    return { ok: true, claim: json.claim, already: json.already === true };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** As the owner: open the job at this plot, or close it and let the hand go. */
export const setHiring = (seed: number, owner: string, hiring: boolean) =>
  offerCall(owner, { seed, hire: hiring });

/** Take the job at somebody's plot. */
export const takeJob = (seed: number, worker: string, name: string) =>
  offerCall(worker, { seed, takeJob: true, ownerName: name });

/** Leave the job, or as the owner, dismiss the hand. */
export const quitJob = (seed: number, who: string) => offerCall(who, { seed, quitJob: true });

/** Say you are at work. The owner's attention counts it. */
export const attendJob = (seed: number, worker: string) => offerCall(worker, { seed, attend: true });

/** How often a hand at work says so, in milliseconds. */
export const ATTEND_INTERVAL = 5 * 60_000;

/** How recently a hand must have attended for the owner's world to count it. */
export const HAND_PRESENT_MS = 15 * 60_000;

/** Take an offer back. */
export const withdrawOffer = (seed: number, bidder: string) => offerCall(bidder, { seed, withdrawOffer: true });

/** The owner accepts or declines an offer. */
export const answerOffer = (seed: number, owner: string, bidder: string, accept: boolean) =>
  offerCall(owner, { seed, answer: accept ? 'accept' : 'decline', bidder });

export type BuyResult =
  | { ok: true; claim: Claim; price: number; seller: string }
  | { ok: false; reason: string; settling?: boolean };

/**
 * Buy a listed plot from its owner. `transferTx` is the payment to the seller;
 * the registry checks it before moving the title.
 */
export async function buyPlot(input: {
  seed: number; owner: string; ownerName: string; transferTx?: string;
}): Promise<BuyResult> {
  try {
    const response = await withSession(
      input.owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, buy: true }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { claim?: Claim; price?: number; seller?: string; error?: string; retry?: boolean };
    if (!response.ok || !json.claim) {
      return { ok: false, reason: json.error ?? 'The registry refused the sale.', settling: json.retry === true };
    }
    return { ok: true, claim: json.claim, price: json.price ?? 0, seller: json.seller ?? '' };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** Give a plot up. */
export async function releasePlot(seed: number, owner: string): Promise<boolean> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/plots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, owner, release: true }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { released?: boolean };
    return json.released === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Worlds
 * ------------------------------------------------------------------ */

export interface PublishResult {
  ok: boolean;
  /** The store holds a later copy of this world; read it back and continue from it. */
  behind?: boolean;
  /** Where that later copy is, when the store said. */
  day?: number;
  hour?: number | null;
}

/**
 * How large a snapshot may be before it is worth packing.
 *
 * Below this it goes as plain JSON, which is simplest and fits comfortably
 * within what a `keepalive` request may carry.
 */
const PACK_OVER = 24_000;

/**
 * Gzip a snapshot in the browser, or null where the browser cannot.
 *
 * A settlement a few weeks old saves at more than the 64KB a `keepalive`
 * request is allowed, so the publish on closing the tab — the one that
 * mattered most — used to fail without a word. Packed, the same world is a
 * tenth of the size.
 */
async function pack(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Put this world up so visitors see the real settlement, and so the owner's
 * other devices have something to continue from.
 *
 * Refused by the relay when the copy it holds is further along, and that
 * answer is handed back rather than swallowed: the caller reads the held copy
 * and continues from it, which is how a stale tab catches up instead of
 * quietly losing a week of somebody's building.
 */
export async function publishWorld(input: {
  seed: number; owner: string; ownerName: string; worldName: string;
  day: number; hour?: number; population: number; snapshot: unknown;
}, keepalive = false): Promise<PublishResult> {
  try {
    const text = JSON.stringify(input);
    let body: BodyInit = text;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Packed only when the size warrants it. On the way out of the page the
    // packing is a few milliseconds of asynchronous work the page may not
    // get, so a small world is sent as it is rather than risked.
    const packed = text.length > PACK_OVER ? await pack(text) : null;
    if (packed) {
      body = packed;
      headers['content-type'] = 'application/octet-stream';
      headers['x-emerge-encoding'] = 'gzip';
    }
    // `keepalive` lets the request outlive the page: this is how a phone
    // that is being put in a pocket gets its last few minutes saved.
    const response = await fetch('/api/worlds', { method: 'POST', headers, body, keepalive });
    if (response.ok) return { ok: true };
    const json = (await response.json().catch(() => ({}))) as { behind?: boolean; day?: number; hour?: number | null };
    return { ok: false, behind: json.behind === true, day: json.day, hour: json.hour };
  } catch {
    return { ok: false };
  }
}

/** Somebody's settlement, or a sentence saying why there is nothing to show. */
export async function fetchWorld(seed: number): Promise<{ world: PublishedWorld | null; reason?: string }> {
  try {
    const response = await fetch(`/api/worlds?seed=${seed}`, { cache: 'no-store' });
    if (!response.ok) return { world: null, reason: 'Could not reach that world.' };
    return (await response.json()) as { world: PublishedWorld | null; reason?: string };
  } catch {
    return { world: null, reason: 'Could not reach that world.' };
  }
}

/* ------------------------------------------------------------------ *
 * Gifts
 * ------------------------------------------------------------------ */

/** Leave Gold for the owner of a world you are visiting. */
export async function sendGift(input: {
  seed: number; gold: number; from: string; fromName: string; burnTx?: string;
}): Promise<{ ok: true; to: string } | { ok: false; reason: string; settling?: boolean }> {
  try {
    const response = await withSession(
      input.from,
      () => fetch('/api/gifts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as {
      gift?: Gift; to?: string; error?: string; retry?: boolean;
    };
    if (!response.ok || !json.gift) {
      return { ok: false, reason: json.error ?? 'The gift did not go.', settling: json.retry === true };
    }
    return { ok: true, to: json.to ?? 'them' };
  } catch {
    return { ok: false, reason: 'Could not reach the registry. Check your connection.' };
  }
}

/** Take whatever has been left for a world you own. */
export async function collectGifts(seed: number, owner: string): Promise<Gift[]> {
  try {
    const response = await withSession(
      owner,
      () => fetch('/api/gifts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, from: owner, collect: true }),
      }),
      async (r) => r,
    );
    const json = (await response.json()) as { gifts?: Gift[] };
    return json.gifts ?? [];
  } catch {
    return [];
  }
}

/** How often an owner checks for gifts, in milliseconds. */
export const GIFT_POLL = 25_000;

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/** How often a client says it is still watching, in milliseconds. */
export const HEARTBEAT_INTERVAL = 15_000;

/** Say you are here, and find out how many others are. */
export async function heartbeat(seed: number, who: string): Promise<Presence> {
  try {
    const response = await fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, who }),
    });
    const json = (await response.json()) as { count?: number; online?: number };
    return {
      watching: Math.max(0, json.count ?? 0),
      // Null rather than nought when the relay did not say, so the interface
      // can leave the figure out instead of announcing that nobody is playing.
      online: typeof json.online === 'number' ? Math.max(0, json.online) : null,
    };
  } catch {
    return { watching: 0, online: null };
  }
}

/**
 * Say you are leaving.
 *
 * Sent with `keepalive` so it still goes when the page is being torn down,
 * which is the only moment it is ever useful.
 */
export function departWorld(seed: number, who: string) {
  try {
    fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, who, leaving: true }),
      keepalive: true,
    }).catch(() => { /* leaving is best effort; presence times out anyway */ });
  } catch { /* as above */ }
}

/**
 * A stable id for a browser that has no wallet connected.
 *
 * Presence needs something to count, and counting by address alone would make
 * every wallet-less visitor invisible. Kept for the session only.
 */
export function visitorId(): string {
  if (typeof window === 'undefined') return 'server';
  const KEY = 'emerge.visitor.v1';
  try {
    const held = window.sessionStorage.getItem(KEY);
    if (held) return held;
    const made = `v${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(KEY, made);
    return made;
  } catch {
    return `v${Math.random().toString(36).slice(2, 12)}`;
  }
}

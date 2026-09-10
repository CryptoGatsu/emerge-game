/**
 * A player's own record, for the wallet that proved itself.
 *
 * `GET  /api/player` — what this wallet saved last, from any device.
 * `POST /api/player` — save it.
 *
 * Both need a session: the record carries a name and a ledger, and neither
 * is anybody else's to read or to write. Nothing here is money the server
 * trusts — payouts check the chain and their own caps regardless — so a
 * record is a convenience the player carries between devices, not a claim
 * on the vault.
 */

import { NextResponse } from 'next/server';
import { allClaims, readPlayerRecord, savePlayerRecord } from '@/lib/server/registry';
import { sessionAddress } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** A record is a few kilobytes; this is room for a player with many plots. */
const MAX_RECORD = 64_000;

type Rec = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bySeed = (a: unknown, b: unknown) => {
  const out = new Map<number, unknown>();
  for (const item of [...(Array.isArray(b) ? b : []), ...(Array.isArray(a) ? a : [])]) {
    const seed = (item as { seed?: unknown })?.seed;
    if (typeof seed === 'number') out.set(seed, item);
  }
  return [...out.values()];
};

/** The incoming record laid over the held one, keeping whatever the held one knows that the incoming does not. */
function mergeHeld(held: Rec | null, incoming: Rec): Rec {
  if (!held) return incoming;
  const heldLedger = (held.ledger ?? {}) as Rec, inLedger = (incoming.ledger ?? {}) as Rec;
  const heldChanges = num(held.nameChanges), inChanges = num(incoming.nameChanges);
  return {
    ...incoming,
    name: heldChanges > inChanges ? held.name : incoming.name,
    nameChanges: Math.max(heldChanges, inChanges),
    nameTokens: Math.max(num(held.nameTokens), num(incoming.nameTokens)),
    ledger: { ...inLedger, earnedEmerge: Math.max(num(heldLedger.earnedEmerge), num(inLedger.earnedEmerge)) },
    claims: bySeed(incoming.claims, held.claims),
    prospected: bySeed(incoming.prospected, held.prospected),
    listings: bySeed(incoming.listings, held.listings),
  };
}

/**
 * The plots this wallet holds, whether or not its record knows about them.
 *
 * The registry row is the title: it follows the token, and the map reads it,
 * so a plot always shows under whoever holds it. The record is what the
 * player's own list of plots is drawn from, and it is written by their
 * browser — which is never party to a transfer made from a wallet app. A
 * plot sent between two wallets therefore arrived on the map and nowhere
 * else: the new holder could walk into their settlement but never saw it
 * listed as theirs.
 *
 * Moving a plot now writes both sides, but only from the move onward. A
 * transfer that had already happened left a record that would never catch
 * up, since a sync does not move a row that already sits with the right
 * owner. So the two are reconciled on every read: any row the registry says
 * is this wallet's and the record does not carry is added here. It is the
 * registry's word either way, so this can only agree with what the map is
 * already showing.
 *
 * Plots the wallet no longer holds are dropped, because a record that keeps
 * them does more than look untidy. Which of a player's worlds pay is decided
 * by claim order, and land they had given up sat at the front of that order
 * pushing the real ones past the limit — a player holding one plot was told
 * that plot does not pay.
 *
 * Two ways a record names land that is not the wallet's. The registry gives
 * the seed to somebody else, which is plain. Or the registry has never heard
 * of the seed at all, which is what a plot given up or burnt leaves behind:
 * releasing a plot deletes its row, so nothing afterwards can contradict the
 * record's copy and it sits there for good. Both are dropped, and neither
 * costs the holder anything — payouts are judged from the registry, so a
 * plot with no row there was never being paid for in the first place. It was
 * only ever taking up one of the five places that do pay.
 *
 * The one thing that must not be swept up is a claim still on its way to the
 * registry, so a seed the registry does not know is kept while it is new.
 */
const CLAIM_GRACE_MS = 15 * 60_000;
async function withHeldPlots(address: string, record: Rec | null): Promise<Rec | null> {
  let rows: { seed: number; region: string; worldName: string; owner: string; price?: number; at: number }[];
  try {
    rows = await allClaims();
  } catch {
    return record; // The registry is the extra, not the record itself.
  }
  const me = address.toLowerCase();
  const mine = rows.filter((row) => row.owner?.toLowerCase() === me);
  const known = new Set(rows.map((row) => row.seed));
  const ours = new Set(mine.map((row) => row.seed));
  const held = Array.isArray(record?.claims) ? (record!.claims as { seed?: unknown; claimedAt?: unknown }[]) : [];
  const fresh = Date.now() - CLAIM_GRACE_MS;
  const kept = held.filter((c) => {
    if (typeof c?.seed !== 'number') return true;
    if (ours.has(c.seed)) return true;
    if (known.has(c.seed)) return false;              // the registry gives it to somebody else
    const at = typeof c.claimedAt === 'number' ? c.claimedAt : 0;
    return at > fresh;                                 // unknown to the registry: only a claim still in flight
  });
  const carried = new Set(kept.map((c) => (typeof c?.seed === 'number' ? c.seed : -1)));
  const added = mine.filter((row) => !carried.has(row.seed)).map((row) => ({
    seed: row.seed,
    name: row.worldName,
    region: row.region,
    price: row.price ?? 0,
    claimedAt: row.at,
    owner: me,
    txHash: null,
  }));
  if (!added.length && kept.length === held.length) return record;
  return { ...(record ?? {}), claims: [...kept, ...added] };
}

export async function GET(request: Request) {
  const address = sessionAddress(request);
  if (!address) return NextResponse.json({ error: 'Sign in first.', needsSession: true }, { status: 401 });
  try {
    const held = (await readPlayerRecord(address)) as Rec | null;
    const record = await withHeldPlots(address, held);
    return NextResponse.json({ record }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ record: null, reason: 'The store is not reachable.' });
  }
}

export async function POST(request: Request) {
  const address = sessionAddress(request);
  if (!address) return NextResponse.json({ error: 'Sign in first.', needsSession: true }, { status: 401 });
  let body: { record?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }
  const record = body.record as { ledger?: unknown; claims?: unknown } | undefined;
  if (!record || typeof record !== 'object' || typeof record.ledger !== 'object' || !Array.isArray(record.claims)) {
    return NextResponse.json({ error: 'That is not a player record.' }, { status: 400 });
  }
  if (JSON.stringify(record).length > MAX_RECORD) {
    return NextResponse.json({ error: 'That record is too large.' }, { status: 413 });
  }
  try {
    /*
     * Merged with what is held, never written over it. A browser can only
     * push what it knows, and a fresh one knows nothing: before this, a
     * player who opened the game in a second browser pushed an empty record
     * and every $EMERGE they had earned was gone from the server too. What
     * has been earned only ever goes up here; claims, surveys and listings
     * are the union; the name follows whoever changed it.
     */
    const held = await withHeldPlots(address, (await readPlayerRecord(address)) as Rec | null);
    await savePlayerRecord(address, { ...mergeHeld(held, record as Record<string, unknown>), savedAt: Date.now() });
    return NextResponse.json({ saved: true });
  } catch {
    return NextResponse.json({ error: 'The store is not reachable.' }, { status: 502 });
  }
}

/**
 * Published worlds.
 *
 * `GET  /api/worlds?seed=<n>` — somebody's settlement, as they last left it.
 * `POST /api/worlds` — the owner puts theirs up.
 *
 * This is what makes visiting real. Without it a visitor could only be shown a
 * world regenerated from the seed — the same land, but not the place the owner
 * actually built, with none of their people in it. That would look like a visit
 * and be a fiction.
 *
 * It is also the owner's backup. The copy here is what a second device, a
 * cleared browser or a phone that lost its storage continues from, so two
 * rules protect it. Only the address that holds the claim may publish, so a
 * settlement cannot be rewritten by somebody who does not own it. And **a
 * snapshot that is behind the one already held is refused**, whoever sends
 * it: a tab left open on a desktop while the same player built for a week on
 * their phone used to publish its stale day-nine world over the real day-forty
 * one the moment it woke up, and the phone's next open then "continued" from
 * it. Progress is what must never be lost, so the store only ever moves
 * forward in the settlement's own time. A client told it is behind reads the
 * held copy back and continues from that instead.
 */

import { gunzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { claimOf, isBehind, publishWorld, readWorld } from '@/lib/server/registry';
import { worldFromSave, type SavedWorld } from '@/lib/world/save';
import { cityLevel, stewardshipScore } from '@/lib/simulation';
import { holdsAddress, sessionsAvailable } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The largest snapshot accepted.
 *
 * A settlement of two hundred people and a hundred buildings, played for
 * months, saves at around 300KB now that the save is trimmed; the old limit
 * of 400KB turned one such world away, and a world that cannot be published
 * cannot advance an era. This leaves room for a world twice that size
 * without letting a caller push arbitrary bulk into the store.
 */
const MAX_SNAPSHOT = 1_000_000;

export async function GET(request: Request) {
  const seed = Number(new URL(request.url).searchParams.get('seed'));
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  try {
    const world = await readWorld(seed);
    if (!world) {
      /*
       * Nothing published, but the plot may still be somebody's. A visitor used
       * to be turned away with "nobody has opened this world lately", which
       * read as though a settlement went dark when its owner did — and a
       * spectator could not look at a claimed plot at all until its owner
       * came back and published. The claim row is enough for the client to
       * grow the plot from its seed at the age the registry has it, so the
       * visit goes ahead and says plainly that the owner has not published.
       */
      const claim = await claimOf(seed);
      if (!claim) {
        return NextResponse.json({ world: null, reason: 'Nobody has claimed this plot yet, so there is nothing to show.' });
      }
      return NextResponse.json({
        world: null,
        claim: {
          seed: claim.seed, owner: claim.owner, ownerName: claim.ownerName, worldName: claim.worldName,
          region: claim.region, at: claim.at, era: claim.era ?? 1, expanded: !!claim.expandedAt,
        },
        reason: 'Its owner has not published this settlement yet.',
      });
    }
    return NextResponse.json({ world });
  } catch {
    return NextResponse.json({ world: null, reason: 'The world store is not reachable.' });
  }
}

interface PublishBody {
  seed?: number; owner?: string; ownerName?: string; worldName?: string;
  day?: number; hour?: number; population?: number; snapshot?: unknown;
}

/**
 * Read the body, packed or plain.
 *
 * A browser putting the page away sends its last snapshot with `keepalive`,
 * and the browsers cap what a keepalive request may carry at about 64KB — a
 * settlement a few weeks old is bigger than that, so the save that mattered
 * most, the one on closing the tab, was the one that silently failed. The
 * client gzips the snapshot where it can, which brings a large world down to
 * a tenth of the size, and says so in its own header rather than in
 * `Content-Encoding` because a proxy along the way may honour that one and
 * hand over the body already unpacked. Unpacking is tried and, if the body
 * turns out to be plain after all, it is read as it came.
 */
async function readBody(request: Request): Promise<PublishBody> {
  const packed = request.headers.get('x-emerge-encoding') === 'gzip';
  if (!packed) return (await request.json()) as PublishBody;
  const raw = Buffer.from(await request.arrayBuffer());
  let text: string;
  try {
    text = gunzipSync(raw).toString('utf8');
  } catch {
    text = raw.toString('utf8');
  }
  return JSON.parse(text) as PublishBody;
}

export async function POST(request: Request) {
  let body: PublishBody;
  try {
    body = await readBody(request);
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const seed = Number(body.seed);
  const owner = String(body.owner ?? '');
  if (!Number.isInteger(seed) || seed <= 0) {
    return NextResponse.json({ error: 'Unknown world.' }, { status: 400 });
  }
  if (sessionsAvailable() && !holdsAddress(request, owner)) {
    // The snapshot is what every visitor to this world sees, so publishing one
    // is speaking as its owner. Without this, anybody could replace somebody
    // else's settlement with whatever they liked.
    return NextResponse.json({ error: 'Sign in with this wallet first.', needsSession: true }, { status: 401 });
  }
  if (!ADDRESS.test(owner)) {
    return NextResponse.json({ error: 'Only a wallet can publish a world.' }, { status: 400 });
  }
  if (!body.snapshot) {
    return NextResponse.json({ error: 'Nothing to publish.' }, { status: 400 });
  }
  /*
   * The shape a client can read back.
   *
   * A snapshot the reader would reject is worse than none: it would replace
   * a good copy with one every device then ignores, which is losing the
   * world by another route.
   */
  const snap = body.snapshot as {
    version?: unknown; seed?: unknown;
    world?: { citizens?: unknown; buildings?: unknown; day?: unknown; hour?: unknown };
  };
  if (
    typeof snap !== 'object' || snap.seed !== seed
    || !Array.isArray(snap.world?.citizens) || !Array.isArray(snap.world?.buildings)
    || !Number.isFinite(Number(snap.world?.day))
  ) {
    return NextResponse.json({ error: 'That is not a world this game can read.' }, { status: 400 });
  }

  const encoded = JSON.stringify(body.snapshot);
  if (encoded.length > MAX_SNAPSHOT) {
    // Which parts are the bulk, so the report says where the world grew
    // rather than only that it did.
    const parts = Object.entries((snap.world ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => `${k} ${Math.round(n / 1024)}KB`).join(', ');
    return NextResponse.json({ error: `That world is too large to publish: ${Math.round(encoded.length / 1024)}KB, and the relay takes ${Math.round(MAX_SNAPSHOT / 1024)}KB. The largest parts: ${parts}.` }, { status: 413 });
  }

  // Where the settlement is, read from the world itself rather than from
  // the headline the client put beside it, so the two cannot disagree.
  const day = Math.max(0, Math.round(Number(snap.world?.day) || 0));
  const hour = Math.max(0, Number(snap.world?.hour) || 0);

  try {
    // The registry decides who may write here, not the caller.
    const claim = await claimOf(seed);
    if (!claim) {
      return NextResponse.json({ error: 'That plot is not claimed.' }, { status: 409 });
    }
    if (claim.owner.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'That world belongs to somebody else.' }, { status: 403 });
    }

    // Never backwards. See the top of the file.
    const held = await readWorld(seed);
    if (held && held.owner.toLowerCase() === owner.toLowerCase() && isBehind(held, day, hour)) {
      return NextResponse.json({
        error: 'A later copy of this world is already published.',
        behind: true,
        day: held.day,
        hour: held.hour ?? null,
        at: held.at,
      }, { status: 409 });
    }

    // The level and the score, read here off the copy rather than taken from
    // the client, so the leaderboard ranks what was actually published.
    let level: number | undefined, score: number | undefined, buildings: number | undefined;
    try {
      const world = worldFromSave(body.snapshot as SavedWorld, seed, String(body.worldName ?? claim.worldName ?? ''));
      if (world) {
        level = cityLevel(world); score = Math.round(stewardshipScore(world) * 1000) / 1000;
        buildings = world.buildings.filter((b) => b.active && !b.ruined).length;
      }
    } catch { /* the headline goes without them */ }

    await publishWorld({
      seed,
      level,
      score,
      buildings,
      owner: owner.toLowerCase(),
      ownerName: String(body.ownerName ?? claim.ownerName ?? '').slice(0, 32),
      worldName: String(body.worldName ?? claim.worldName ?? '').slice(0, 32),
      day,
      hour,
      population: Math.max(0, Math.round(Number(body.population) || 0)),
      at: Date.now(),
      snapshot: body.snapshot,
    });
    return NextResponse.json({ published: true, bytes: encoded.length });
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message.slice(0, 120) : '';
    return NextResponse.json({ error: why ? `The world store refused the copy: ${why}` : 'The world store is not reachable.' }, { status: 502 });
  }
}

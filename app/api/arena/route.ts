/**
 * The colosseum.
 *
 * `GET  /api/arena` — the bout on now, the one before it, the roster, results.
 * `POST /api/arena` — enter one of your citizens.
 *
 * The read is open, because the arena is a public place and the crowd includes
 * people who hold no land at all. The write is not: a fighter can only be
 * entered from a plot the caller has a session for and owns in the registry,
 * which is what stops somebody filling the roster with fighters they invented.
 */

import { NextResponse } from 'next/server';
import {
  BETTING_MS, BOUT_MS, arenaShared, currentBout, enter, lastBout, recentResults, roster,
  type Fighter,
} from '@/lib/server/arena';
import { claimOf } from '@/lib/server/registry';
import { sessionAddress } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const MAX_NAME = 24;

/** Strip control characters and collapse whitespace, as the chat relay does. */
const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function GET() {
  try {
    /*
     * Settle before reading the board, not alongside it.
     *
     * `lastBout` is what fights a bout whose bell has gone and writes the
     * result into the history; `recentResults` reads that history. Run
     * together, the read raced the write and a bout that had just been
     * decided was missing from the board until the next poll — the one
     * moment anybody is actually looking at it.
     */
    const [bout, previous] = await Promise.all([currentBout(), lastBout()]);
    const [entrants, results] = await Promise.all([roster(), recentResults()]);
    return NextResponse.json({
      now: Date.now(),
      boutMs: BOUT_MS,
      bettingMs: BETTING_MS,
      // The odds ride with the bout: they were measured when it was made.
      bout,
      previous,
      roster: entrants.slice(0, 24),
      results,
      shared: arenaShared(),
    }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ offline: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: {
    seed?: number; citizenId?: string; name?: string; worldName?: string;
    job?: string; level?: number; vigour?: number; ownerName?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const address = sessionAddress(request);
  if (!address) {
    return NextResponse.json({
      error: 'Sign in with your wallet to enter a fighter.', needsSession: true,
    }, { status: 401 });
  }

  const seed = Number(body.seed);
  const citizenId = clean(String(body.citizenId ?? ''), 32);
  const name = clean(String(body.name ?? ''), MAX_NAME);
  if (!Number.isInteger(seed) || seed <= 0 || !citizenId || !name) {
    return NextResponse.json({ error: 'That is not a fighter.' }, { status: 400 });
  }

  try {
    const claim = await claimOf(seed);
    if (!claim || claim.owner.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({
        error: 'You can only enter somebody from a settlement you hold.',
      }, { status: 403 });
    }

    // Nobody is in the ring and queuing for it at the same time. An entry is
    // spent the moment a bout is drawn, so re-entering is allowed and expected
    // — but not until the bell has gone on the fight they are already in.
    const id = `${seed}:${citizenId}`;
    const running = await currentBout();
    if (running && Date.now() < running.endsAt && (running.red.id === id || running.blue.id === id)) {
      return NextResponse.json({ error: 'They are in the ring. Wait for the bell.' }, { status: 409 });
    }

    const fighter: Fighter = {
      // Ours, from the plot and the citizen, so one person cannot be entered
      // twice over and nobody can claim somebody else's fighter id.
      id,
      name,
      worldName: clean(String(body.worldName ?? claim.worldName ?? 'Somewhere'), MAX_NAME),
      seed,
      owner: claim.owner,
      ownerName: clean(String(body.ownerName ?? claim.ownerName ?? ''), MAX_NAME),
      job: clean(String(body.job ?? 'Unemployed'), 20),
      // Clamped, not trusted: these come from a simulation running in somebody
      // else's browser, and the arena is built so that lying about them buys a
      // small edge in a game of Gold rather than anything that leaves the world.
      level: Math.max(0, Math.min(10, Math.round(Number(body.level) || 0))),
      vigour: Math.max(0, Math.min(100, Math.round(Number(body.vigour) || 0))),
      at: Date.now(),
      won: 0,
      lost: 0,
    };
    await enter(fighter);
    return NextResponse.json({ fighter });
  } catch {
    return NextResponse.json({ error: 'The arena is not reachable.' }, { status: 502 });
  }
}

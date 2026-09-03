/**
 * The land registry.
 *
 * `GET  /api/plots` — every claim on record, and every plot anybody surveyed.
 * `POST /api/plots` — take a plot, or be told who already has it.
 * `POST /api/plots` with `survey` — pay to find new land.
 * `POST /api/plots` with `release` — give a plot up.
 *
 * This is what stops two players owning the same land. Everything a client
 * sends is treated as hostile: the address is pattern-matched against what an
 * Ethereum address actually looks like, names are length-capped and stripped of
 * control characters, the seed must be a plain positive integer, and the
 * timestamp is set here rather than accepted from the caller.
 *
 * **Once a land contract exists, the relay may only agree with it.** Writing a
 * claim row costs nothing, so without that rule one script could post a claim
 * for every seed on every chart and make the whole map read as taken — land
 * nobody paid for, blocking players who would have. A claim is now checked
 * against `ownerOf` before it is written, and a claim the chain does not back
 * is refused.
 *
 * Surveying and claiming both also want a wallet the caller has proved is
 * theirs, and are rate limited per wallet: land is finite, and exhausting it is
 * cheaper than defending it.
 */

import { NextResponse } from 'next/server';
import {
  allClaims, allFinds, registryShared, releaseClaim, survey, takeClaim, type Claim,
} from '@/lib/server/registry';
import { ownerOnChain, registryConfigured } from '@/lib/server/land';
import { holdsAddress, sessionsAvailable } from '@/lib/server/session';
import { incrWindow } from '@/lib/server/kv';
import { serverKey } from '@/lib/limits';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_NAME = 32;

/** Surveys one wallet may run in an hour. Generous for a player, useless for a script. */
const MAX_SURVEYS_PER_HOUR = 12;

/** Strip control characters and collapse runs of whitespace. */
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
    const [claims, finds] = await Promise.all([allClaims(), allFinds()]);
    return NextResponse.json({ claims, finds, shared: registryShared() });
  } catch {
    // A store that is unreachable should leave the world map usable and
    // honest, not throw a red panel at the player.
    return NextResponse.json({ claims: [], finds: [], shared: false, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: {
    seed?: number; region?: string; worldName?: string; owner?: string;
    ownerName?: string; price?: number; release?: boolean;
    survey?: boolean; chart?: number; capacity?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const owner = String(body.owner ?? '');
  if (!ADDRESS.test(owner)) {
    // Not a formality: the whole point of the registry is that a plot belongs
    // to a wallet, so a claim without one has nothing to belong to.
    return NextResponse.json({ error: 'Connect a wallet before claiming land.' }, { status: 400 });
  }
  /*
   * Prove the wallet, where this deployment can check.
   *
   * A build with no session secret keeps working as it did — that is a
   * development build, and refusing there would make the game unplayable
   * locally for no gain. Anywhere that can pay people can also check this.
   */
  if (sessionsAvailable() && !holdsAddress(request, owner)) {
    return NextResponse.json({ error: 'Sign in with this wallet first.', needsSession: true }, { status: 401 });
  }

  /*
   * Surveying new land.
   *
   * The slot and the seed are both chosen here. A client picking its own could
   * only avoid the plots it already knew about, so two players surveying the
   * same chart took the same berth and put two settlements on one point of the
   * map, each invisible to the other.
   */
  if (body.survey) {
    const chart = Number(body.chart);
    if (!Number.isInteger(chart) || chart < 0 || chart > 32) {
      return NextResponse.json({ error: 'Unknown chart.' }, { status: 400 });
    }
    // Land is finite and surveying is the only way to make more of it, so a
    // script that can survey freely can exhaust every chart in the game.
    const surveys = await incrWindow(serverKey(`surveys:${owner.toLowerCase()}`), 1, 3600);
    if (surveys > MAX_SURVEYS_PER_HOUR) {
      return NextResponse.json({
        error: `That is ${MAX_SURVEYS_PER_HOUR} surveys in an hour. The land will still be there later.`,
      }, { status: 429 });
    }
    try {
      const result = await survey(
        chart,
        Number(body.capacity) || 0,
        owner,
        clean(String(body.ownerName ?? ''), MAX_NAME),
      );
      if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
      return NextResponse.json({ find: result.find, shared: registryShared() });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  const seed = Number(body.seed);
  if (!Number.isInteger(seed) || seed <= 0 || seed > 1e12) {
    return NextResponse.json({ error: 'Unknown plot.' }, { status: 400 });
  }

  if (body.release) {
    try {
      const released = await releaseClaim(seed, owner);
      return NextResponse.json({ released });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  /*
   * Where there is a contract, it decides.
   *
   * The relay's job shrinks to caching a name and a date once a plot is a token
   * — so a row it cannot corroborate is not written at all. An unreachable
   * chain refuses rather than waves it through: the claim can be retried, and a
   * network blip must not become the one moment squatting works.
   */
  if (registryConfigured()) {
    let onChain: string | null;
    try {
      onChain = await ownerOnChain(seed);
    } catch {
      return NextResponse.json({ error: 'Could not reach the chain to check that plot. Try again.' }, { status: 503 });
    }
    if (onChain === null) {
      return NextResponse.json({
        error: 'That plot is not claimed on chain yet. Claim it in the land contract first.',
      }, { status: 409 });
    }
    if (onChain !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'The chain says somebody else holds that plot.' }, { status: 409 });
    }
  }

  const claim: Claim = {
    seed,
    region: clean(String(body.region ?? 'Unnamed'), MAX_NAME),
    worldName: clean(String(body.worldName ?? 'Emerge'), MAX_NAME),
    owner,
    ownerName: clean(String(body.ownerName ?? ''), MAX_NAME),
    price: Math.max(0, Math.round(Number(body.price) || 0)),
    // Ours, not the caller's: a client that could set this could claim to have
    // held a plot since before the person who actually did.
    at: Date.now(),
  };

  try {
    const result = await takeClaim(claim);
    if (!result.ok) {
      return NextResponse.json({
        error: `${result.taken.region} already belongs to somebody else.`,
        taken: result.taken,
      }, { status: 409 });
    }
    return NextResponse.json({ claim: result.claim, shared: registryShared() });
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

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
 * **With no land contract deployed, this route is the title.** That raises the
 * bar on it considerably, because the contract used to guarantee two things
 * this had been leaving to the client.
 *
 * *That a claim was paid for.* `claim` took the price and minted in one
 * transaction. Here the burn and the row are separate, so the row is not
 * written until the burn has been read off the chain: right payer, right
 * amount, settled, and not already spent on something else. Before this, a
 * player could take a plot and then dismiss the wallet prompt, and nothing
 * rolled the claim back.
 *
 * *That only one person gets it.* The contract's `require` was atomic. Here
 * the write is a set-if-absent, and a plot is reserved for its buyer before
 * they are asked to pay — so nobody burns tokens for land somebody else is
 * about to take.
 *
 * **Where a land contract does exist, the relay may only agree with it.** A
 * claim is checked against `ownerOf` before it is written, and one the chain
 * does not back is refused.
 *
 * Surveying and claiming both also want a wallet the caller has proved is
 * theirs, and are rate limited per wallet: land is finite, and exhausting it is
 * cheaper than defending it.
 */

import { NextResponse } from 'next/server';
import {
  allClaims, allFinds, dropReservation, holdsReservation, registryShared, releaseClaim,
  reservePlot, survey, takeClaim, type Claim,
} from '@/lib/server/registry';
import { spendBurn, verifyBurn } from '@/lib/server/burns';
import { tokenLive } from '@/lib/chain/emerge';
import { priceOfSeed } from '@/lib/world/price';
import { PROSPECT_COST_EMERGE } from '@/lib/chain/vault';
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
    /** Hold a plot while its buyer pays, before any money moves. */
    reserve?: boolean;
    /** The transaction that burned the price. Checked against the chain. */
    burnTx?: string;
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
   * Holding a plot while its buyer pays.
   *
   * Answered before any money moves. A player who is refused here has burned
   * nothing, which is the entire point of doing it in this order.
   */
  if (body.reserve) {
    const seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed <= 0 || seed > 1e12) {
      return NextResponse.json({ error: 'Unknown plot.' }, { status: 400 });
    }
    try {
      const held = await reservePlot(seed, owner);
      if (!held.ok) return NextResponse.json({ error: held.reason }, { status: 409 });
      return NextResponse.json({ reserved: true, seconds: held.seconds });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
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
    /*
     * Surveying is charged too, and the charge is checked the same way.
     *
     * Without this a script with a wallet could survey every chart in the game
     * to exhaustion for nothing, and land is finite.
     */
    if (tokenLive()) {
      const burnTx = String(body.burnTx ?? '');
      const paid = await verifyBurn(burnTx, owner, PROSPECT_COST_EMERGE);
      if (!paid.ok) {
        return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      }
      if (!(await spendBurn(burnTx, `survey:${chart}`))) {
        return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
      }
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
      if (released) await dropReservation(seed).catch(() => {});
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

  /*
   * Proof of payment, where there is no contract to take it.
   *
   * The price is computed here from the seed — never read from the request —
   * and the burn has to be a real transaction from this wallet, settled, worth
   * at least that much, and not already spent. Without this the row is free to
   * write, and a player could take a plot and then simply dismiss the wallet
   * prompt.
   *
   * Skipped where a land contract exists, because there the claim *is* the
   * payment and the `ownerOf` check above already proves it happened.
   */
  if (!registryConfigured() && tokenLive()) {
    if (!(await holdsReservation(seed, owner))) {
      return NextResponse.json({
        error: 'That plot is not held for you. Open it again to start over.',
      }, { status: 409 });
    }
    const burnTx = String(body.burnTx ?? '');
    const due = priceOfSeed(seed);
    const paid = await verifyBurn(burnTx, owner, due);
    if (!paid.ok) {
      return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
    }
    // Claim the payment before the plot, so one burn cannot buy two.
    if (!(await spendBurn(burnTx, `plot:${seed}`))) {
      return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
    }
  }

  const claim: Claim = {
    seed,
    region: clean(String(body.region ?? 'Unnamed'), MAX_NAME),
    worldName: clean(String(body.worldName ?? 'Emerge'), MAX_NAME),
    owner,
    ownerName: clean(String(body.ownerName ?? ''), MAX_NAME),
    // Ours, from the seed. A client that could set this could write its own
    // history of what land cost.
    price: priceOfSeed(seed),
    // Ours, not the caller's: a client that could set this could claim to have
    // held a plot since before the person who actually did.
    at: Date.now(),
  };

  try {
    const result = await takeClaim(claim);
    if (result.ok) await dropReservation(seed).catch(() => {});
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

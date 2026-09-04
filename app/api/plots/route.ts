/**
 * The land registry.
 *
 * `GET  /api/plots` — every claim on record, and every plot anybody surveyed.
 * `POST /api/plots` — take a plot, or be told who already has it.
 * `POST /api/plots` with `survey` — pay to find new land.
 * `POST /api/plots` with `release` — give a plot up.
 * `POST /api/plots` with `list` — put a plot up for sale, or take it down.
 * `POST /api/plots` with `buy` — buy a listed plot from its owner, wallet to
 * wallet. The price goes to the seller and nothing is burned.
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
  allClaims, allFinds, answerOffer, attendJob, claimOf, dropReservation, holdsReservation, listClaim, markEra, markExpanded, placeOffer,
  priceFor, quitJob, registryShared, releaseClaim, reservePlot, setHiring, survey, takeClaim, takeJob, transferClaim,
  withdrawOffer,
  type Claim, markCover } from '@/lib/server/registry';
import { spendBurn, verifyBurn, verifyTransfer } from '@/lib/server/burns';
import { tokenBalance, tokenLive } from '@/lib/chain/emerge';
import { ADVANCE_COST_EMERGE, EXPAND_COST_EMERGE, HAND_MIN_EMERGE, CHARTER_COST_EMERGE, INSURANCE_COST_EMERGE } from '@/lib/chain/vault';
import { readWorld } from '@/lib/server/registry';
import { worldFromSave, type SavedWorld } from '@/lib/world/save';
import { eraGate, eraOf } from '@/lib/simulation';
import { OPEN_ERA, CHARTER_DAYS, INSURANCE_DAYS } from '@/lib/world/eras';
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
    /** Put the plot up for sale at `price`, or with null take it down. */
    list?: boolean;
    /** Buy a listed plot; `transferTx` paid the seller. */
    buy?: boolean;
    transferTx?: string;
    /** Offer `price` for somebody else's plot, or take the offer back. */
    offer?: boolean;
    withdrawOffer?: boolean;
    /** The owner answers a bidder's offer. */
    answer?: 'accept' | 'decline';
    bidder?: string;
    /** Expand the plot, once; `burnTx` paid for it where the token is live. */
    expand?: boolean;
    /** Advance the plot to `era`; `burnTx` paid for it where the token is live. */
    advance?: boolean;
    charter?: boolean;
    insure?: boolean;
    era?: number;
    /** Hired hands: the owner opens or closes the job; a player takes, keeps or leaves it. */
    hire?: boolean;
    takeJob?: boolean;
    quitJob?: boolean;
    attend?: boolean;
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

  /*
   * Offers. Nothing is held: an offer is a price somebody says they will
   * pay, and an accepted one reserves the plot for them at that price for a
   * while. The payment happens the same way as any sale, wallet to wallet.
   */
  if (body.offer || body.withdrawOffer) {
    if (registryConfigured()) {
      return NextResponse.json({ error: 'A plot on the land contract changes hands as a token.' }, { status: 409 });
    }
    try {
      if (body.withdrawOffer) {
        const row = await withdrawOffer(seed, owner);
        return row ? NextResponse.json({ claim: row }) : NextResponse.json({ error: 'Nobody holds that plot.' }, { status: 409 });
      }
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0 || price > 1e12) {
        return NextResponse.json({ error: 'Name a price in whole tokens.' }, { status: 400 });
      }
      const row = await placeOffer(seed, owner, clean(String(body.ownerName ?? ''), MAX_NAME), price);
      if (!row) return NextResponse.json({ error: 'That plot is not somebody else’s to make an offer on.' }, { status: 409 });
      return NextResponse.json({ claim: row });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }
  /*
   * Expanding a plot.
   *
   * Once per plot, and the charge is checked the same way a survey's is: a
   * real burn from this wallet, settled, worth the price, and single-use. A
   * plot already expanded answers with its row rather than a refusal, so a
   * device that paid and then lost the reply can ask again and be told.
   */
  if (body.expand) {
    let claim: Claim | null;
    try {
      claim = await claimOf(seed);
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
    if (!claim || claim.owner.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
    }
    if (claim.expandedAt) return NextResponse.json({ claim, already: true });
    if (tokenLive()) {
      const burnTx = String(body.burnTx ?? '');
      const paid = await verifyBurn(burnTx, owner, EXPAND_COST_EMERGE);
      if (!paid.ok) {
        return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      }
      if (!(await spendBurn(burnTx, `expand:${seed}`))) {
        return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
      }
    }
    try {
      const result = await markExpanded(seed, owner);
      if (!result) return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
      return NextResponse.json({ claim: result.claim, already: result.already });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  /*
   * A charter or insurance on the plot.
   *
   * Both are burned $EMERGE for a span of days recorded on the row: a charter
   * lifts the plot's ceiling by a fifth, insurance halves what trouble does.
   * Verified like an expansion, and never refused for being bought again: a
   * second purchase runs on from the end of the first.
   */
  if (body.charter || body.insure) {
    const kind: 'charter' | 'insurance' = body.charter ? 'charter' : 'insurance';
    let claim: Claim | null;
    try {
      claim = await claimOf(seed);
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
    if (!claim || claim.owner.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
    }
    if (tokenLive()) {
      const burnTx = String(body.burnTx ?? '');
      const paid = await verifyBurn(burnTx, owner, kind === 'charter' ? CHARTER_COST_EMERGE : INSURANCE_COST_EMERGE);
      if (!paid.ok) {
        return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      }
      if (!(await spendBurn(burnTx, `${kind}:${seed}:${burnTx}`))) {
        return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
      }
    }
    try {
      const result = await markCover(seed, owner, kind, kind === 'charter' ? CHARTER_DAYS : INSURANCE_DAYS);
      if (!result) return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
      return NextResponse.json({ claim: result.claim, until: result.until });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  /*
   * Advancing an era.
   *
   * The gate is judged here, on the copy of the world the owner published,
   * not on the client's say-so: a browser that claims to have forty people
   * and a school is not evidence, but the snapshot every visitor sees is
   * the same snapshot the owner has to stand behind. The charge is checked
   * the way a survey's is. A plot already in the era answers with its row.
   */
  if (body.advance) {
    const era = Math.round(Number(body.era) || 0);
    let claim: Claim | null;
    try {
      claim = await claimOf(seed);
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
    if (!claim || claim.owner.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
    }
    const held = claim.era ?? 1;
    if (era <= held) return NextResponse.json({ claim, already: true });
    if (era !== held + 1) return NextResponse.json({ error: 'One era at a time.' }, { status: 400 });
    if (era > OPEN_ERA) return NextResponse.json({ error: 'That era is not built yet.' }, { status: 409 });
    const published = await readWorld(seed);
    const world = published ? worldFromSave(published.snapshot as SavedWorld, seed, claim.worldName) : null;
    if (!world) return NextResponse.json({ error: 'Publish the world first, then advance it.' }, { status: 409 });
    if (eraOf(world) !== held) {
      // The published copy and the row disagree; the row wins for the charge,
      // the world for the checklist. Read the checklist as if the world were
      // in the row's era.
      world.era = held;
    }
    const gate = eraGate(world);
    if (!gate.ready) {
      return NextResponse.json({
        error: 'The settlement has not earned the next era yet.',
        gate: { days: gate.days, checks: gate.checks },
      }, { status: 409 });
    }
    if (tokenLive()) {
      const burnTx = String(body.burnTx ?? '');
      const paid = await verifyBurn(burnTx, owner, ADVANCE_COST_EMERGE);
      if (!paid.ok) {
        return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      }
      if (!(await spendBurn(burnTx, `era:${seed}:${era}`))) {
        return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
      }
    }
    try {
      const result = await markEra(seed, owner, era);
      if (!result) return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
      return NextResponse.json({ claim: result.claim, already: result.already });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  /*
   * Hired hands.
   *
   * The owner opens the job; a player without land takes it. The balance
   * floor is read off the chain here, at the moment of hiring, and again
   * whenever the hand is paid — a job is not a licence, it is a standing
   * check.
   */
  if (body.hire !== undefined) {
    try {
      const row = await setHiring(seed, owner, body.hire === true);
      return row ? NextResponse.json({ claim: row }) : NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }
  if (body.takeJob) {
    if (tokenLive()) {
      const held = await tokenBalance(owner);
      if (held === null) {
        return NextResponse.json({ error: 'Your balance could not be read just now. Try again in a minute.' }, { status: 503 });
      }
      if (held < HAND_MIN_EMERGE) {
        return NextResponse.json({
          error: `A hired hand holds at least ${HAND_MIN_EMERGE.toLocaleString()} $EMERGE. This wallet holds ${Math.floor(held).toLocaleString()}.`,
        }, { status: 403 });
      }
    }
    try {
      const result = await takeJob(seed, owner, clean(String(body.ownerName ?? ''), MAX_NAME));
      if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
      return NextResponse.json({ claim: result.claim });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }
  if (body.quitJob) {
    try {
      const row = await quitJob(seed, owner);
      return row ? NextResponse.json({ claim: row }) : NextResponse.json({ error: 'No such job.' }, { status: 409 });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }
  if (body.attend) {
    try {
      const row = await attendJob(seed, owner);
      return row ? NextResponse.json({ claim: row }) : NextResponse.json({ error: 'You do not work there.' }, { status: 409 });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }
  if (body.answer) {
    const bidder = String(body.bidder ?? '');
    if (!ADDRESS.test(bidder)) return NextResponse.json({ error: 'Unknown bidder.' }, { status: 400 });
    try {
      const row = await answerOffer(seed, owner, bidder, body.answer === 'accept');
      if (!row) return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
      return NextResponse.json({ claim: row });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  if (body.list) {
    const price = body.price === null || body.price === undefined ? null : Number(body.price);
    if (price !== null && (!Number.isFinite(price) || price <= 0 || price > 1e12)) {
      return NextResponse.json({ error: 'Name a price in whole tokens.' }, { status: 400 });
    }
    if (registryConfigured()) {
      return NextResponse.json({
        error: 'A plot on the land contract is an ERC-721 token: sell it wallet to wallet, or on any marketplace.',
      }, { status: 409 });
    }
    try {
      const row = await listClaim(seed, owner, price === null ? null : Math.round(price));
      if (!row) return NextResponse.json({ error: 'That plot is not yours to list.' }, { status: 409 });
      return NextResponse.json({ claim: row });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
  }

  /*
   * Buying a plot from another player.
   *
   * The money goes to the seller, not to the burn address: this is a sale
   * between two people, and the registry's only part in it is to check that
   * the seller was paid what they asked — from this wallet, on chain, settled,
   * and not a payment already used for something else — and then to move the
   * title. `owner` here is the buyer.
   */
  if (body.buy) {
    if (registryConfigured()) {
      return NextResponse.json({
        error: 'A plot on the land contract changes hands as a token, not through the registry.',
      }, { status: 409 });
    }
    let listed: Claim | null;
    try {
      listed = await claimOf(seed);
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
    if (!listed) {
      return NextResponse.json({ error: 'Nobody holds that plot.' }, { status: 409 });
    }
    if (listed.owner.toLowerCase() === owner.toLowerCase()) {
      return NextResponse.json({ error: 'That plot is already yours.' }, { status: 409 });
    }
    // The bidder's accepted offer, while it holds; otherwise the public price.
    const due = priceFor(listed, owner);
    if (due === null) {
      return NextResponse.json({ error: 'That plot is not for sale.' }, { status: 409 });
    }
    if (tokenLive()) {
      const transferTx = String(body.transferTx ?? '');
      const paid = await verifyTransfer(transferTx, owner, listed.owner, due);
      if (!paid.ok) {
        return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      }
      if (!(await spendBurn(transferTx, `resale:${seed}`))) {
        return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
      }
    }
    try {
      const moved = await transferClaim(seed, owner, clean(String(body.ownerName ?? ''), MAX_NAME));
      if (!moved.ok) return NextResponse.json({ error: moved.reason }, { status: 409 });
      return NextResponse.json({ claim: moved.claim, price: moved.price, seller: moved.seller });
    } catch {
      return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
    }
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

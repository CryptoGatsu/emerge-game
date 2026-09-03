/**
 * Paying a player out.
 *
 * `GET  /api/payouts?address=0x…` — what this wallet has been paid, and what
 *   it may still be paid today.
 * `POST /api/payouts` — take money out, and get the transaction that sent it.
 *
 * This route signs. There is no person in the loop and no queue to review, so
 * everything it needs in order to be safe is checked here rather than assumed:
 *
 *  0. **The caller proves the wallet is theirs.** Without that, "pay this
 *     address" is an instruction anybody can give for anybody — the tokens
 *     would reach real players, which is not theft, and an attacker would still
 *     be choosing when the day's emission budget empties and how much gas the
 *     vault burns doing it. A signed cookie settles who is asking.
 *  1. **A shared store, or nothing.** The daily caps live in it. On serverless
 *     each request runs in a different instance, so caps held in process memory
 *     would reset per request — which is not a cap. Refuse rather than
 *     half-work.
 *  2. **Amounts are computed here.** The body says *how much Gold* or *how much
 *     earnings*; the exchange rate, the burn share and the net all come from
 *     `settlementFor`. A client sending its own figures gets ours.
 *  3. **Principal is bounded by verified deposits.** `/api/deposits` only
 *     credits transfers the chain confirms, so principal out can never exceed
 *     principal in. This half cannot be forged at all.
 *  4. **Earnings are bounded rather than verified.** The simulation runs in the
 *     player's browser and no server can check it. So: only to an address that
 *     holds land on chain, at most the game's own daily ceiling per address,
 *     and under a global budget for the whole vault. The worst a dishonest
 *     client can take is what the game was going to pay an honest one.
 *  5. **The debit happens before the transfer**, and is given back if the
 *     transfer does not happen. Reserving late is how the same balance gets
 *     spent twice.
 *
 * The burn share never leaves the vault. It stays there and is burned
 * deliberately, which is what the owner asked for and what every surface says.
 */

import { NextResponse } from 'next/server';
import { MAX_PAYOUT_EMERGE, recordPayout, payoutsFor } from '@/lib/server/payouts';
import {
  MIN_PAYOUT_EMERGE, debitPrincipal, emissionRoom, principalOf, releaseEmission, reserveEmission,
  settlementFor, takePayoutSlot,
} from '@/lib/server/accounts';
import { holdsAddress, sessionsAvailable } from '@/lib/server/session';
import { sendFromVault, vaultAddress, vaultCanSign, vaultHealth } from '@/lib/server/signer';
import { registryShared } from '@/lib/server/registry';
import { TOKEN, VAULT_ADDRESS, tokenLive } from '@/lib/chain/emerge';
import { landCheck } from '@/lib/server/land';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_NAME = 32;

const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address') ?? '';
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ payouts: [], automatic: vaultCanSign(), shared: registryShared() });
  }
  try {
    const [payouts, principal, room, land] = await Promise.all([
      payoutsFor(address), principalOf(address), emissionRoom(address), landCheck(address),
    ]);
    return NextResponse.json({
      payouts, principal, room,
      // Whether stewardship can be collected at all, and if not, why — so the
      // Bank can say so before somebody presses the button.
      land,
      automatic: vaultCanSign(),
      shared: registryShared(),
    });
  } catch {
    return NextResponse.json({ payouts: [], automatic: vaultCanSign(), shared: false, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: {
    address?: string; name?: string; seed?: number; worldName?: string;
    kind?: string; gold?: number; emerge?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const address = String(body.address ?? '');
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: 'A payout belongs to a wallet address.' }, { status: 400 });
  }
  if (!sessionsAvailable()) {
    return NextResponse.json({
      error: 'This deployment cannot verify wallets, so it will not pay out. Nothing was taken.',
    }, { status: 503 });
  }
  if (!holdsAddress(request, address)) {
    return NextResponse.json({
      error: 'Sign in with this wallet first. Nothing was taken.', needsSession: true,
    }, { status: 401 });
  }
  if (!tokenLive()) {
    return NextResponse.json({ error: 'No $EMERGE contract is configured.' }, { status: 503 });
  }
  if (!registryShared()) {
    return NextResponse.json({
      error: 'This deployment has no shared store, so it will not pay out. Nothing was taken.',
    }, { status: 503 });
  }
  if (!vaultCanSign()) {
    return NextResponse.json({
      error: 'The vault is not configured to pay out. Nothing was taken.',
    }, { status: 503 });
  }
  /*
   * The key must control the wallet deposits go to.
   *
   * A key for some other wallet would pass every other check here and then fail
   * on an empty balance, which reads to a player as "the game owes me and will
   * not pay". Caught at the door instead.
   */
  if (vaultAddress()?.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) {
    return NextResponse.json({
      error: 'The vault key does not match the vault address. Nothing was taken.',
    }, { status: 503 });
  }

  const kind = body.kind === 'earnings' ? 'earnings' : 'principal';
  const asked = kind === 'principal'
    ? Math.floor(Number(body.gold) || 0)
    : Math.floor(Number(body.emerge) || 0);
  if (!(asked > 0)) {
    return NextResponse.json({ error: 'There is nothing to take out.' }, { status: 400 });
  }

  // Ours, from the amount asked for — never from figures the client sent.
  const money = settlementFor(kind, asked);
  if (money.gross < MIN_PAYOUT_EMERGE) {
    return NextResponse.json({
      error: `The smallest withdrawal is ${MIN_PAYOUT_EMERGE.toLocaleString()} $EMERGE.`,
    }, { status: 400 });
  }
  if (money.gross > MAX_PAYOUT_EMERGE) {
    return NextResponse.json({
      error: `A single withdrawal is capped at ${MAX_PAYOUT_EMERGE.toLocaleString()} $EMERGE. Take it out in stages.`,
    }, { status: 400 });
  }

  const health = await vaultHealth();
  if (!health.ok) return NextResponse.json({ error: health.problem }, { status: 503 });
  if (health.tokens < money.net) {
    return NextResponse.json({
      error: 'The vault cannot cover that right now. Nothing has been taken from your balance.',
    }, { status: 503 });
  }

  /* ---------------- Ration, reserve, then send ---------------- */

  /*
   * Rationed here rather than at the door.
   *
   * What is being rationed is the vault signing and paying gas, so a request
   * that was never going to reach that point — too small, more principal than
   * standing, no land — should not spend somebody's allowance. Once past this
   * line the vault is about to work, and a failed attempt costs it the same as
   * a successful one, so the slot is not given back.
   */
  if (kind === 'earnings') {
    const land = await landCheck(address);
    if (land !== 'holds') {
      // Same refusal in every case — the difference is what the player is told,
      // because "you hold no land" is false for two of the three.
      const said = land === 'no-registry'
        ? `Stewardship cannot be paid until ${TOKEN.ticker} is live on this deployment. Your balance is safe and nothing was taken.`
        : land === 'unreachable'
          ? 'We could not check what land this wallet holds. Nothing was taken — try again in a minute.'
          : 'Stewardship is paid to the wallet that holds the land. No plot stands in this one\u2019s name — if you claimed with a different wallet, collect from that one.';
      return NextResponse.json({ error: said, land }, { status: 403 });
    }
  }
  if (kind === 'principal') {
    const standing = await principalOf(address);
    if (money.gross > standing) {
      return NextResponse.json({
        error: standing < 1
          ? 'This door returns $EMERGE you deposited, and the chain shows no deposits from this wallet.'
          : `You have ${standing.toLocaleString()} $EMERGE of principal standing.`,
      }, { status: 400 });
    }
  }

  const slot = await takePayoutSlot(address);
  if (!slot.ok) return NextResponse.json({ error: slot.reason }, { status: 429 });

  let give: () => Promise<void>;

  if (kind === 'principal') {
    /*
     * Debit before sending, and re-read rather than trusting the check above:
     * between a check and a transfer is exactly where the same principal gets
     * withdrawn twice. The debit is the check that counts.
     */
    const left = await debitPrincipal(address, money.gross);
    if (left < 0) {
      await debitPrincipal(address, money.gross);
      return NextResponse.json({
        error: 'That is more principal than the chain shows you deposited.',
      }, { status: 400 });
    }
    give = async () => { await debitPrincipal(address, -money.gross); };
  } else {
    if (!(await reserveEmission(address, money.gross))) {
      const room = await emissionRoom(address);
      return NextResponse.json({
        error: room.globalLeft <= 0
          ? 'The vault has paid out everything it will today. Try again tomorrow.'
          : `You can collect ${room.left.toLocaleString()} more $EMERGE today.`,
      }, { status: 429 });
    }
    give = () => releaseEmission(address, money.gross);
  }

  const sent = await sendFromVault(address, money.net);
  if (!sent.ok) {
    // Put it back. A refusal must cost nothing.
    await give().catch(() => {});
    return NextResponse.json({ error: sent.problem }, { status: 502 });
  }

  const payout = await recordPayout({
    address,
    name: clean(String(body.name ?? ''), MAX_NAME),
    seed: Number.isInteger(Number(body.seed)) ? Number(body.seed) : 0,
    worldName: clean(String(body.worldName ?? ''), MAX_NAME),
    kind,
    gold: kind === 'principal' ? asked : 0,
    gross: money.gross,
    burned: money.burned,
    net: money.net,
    txHash: sent.txHash,
  });

  return NextResponse.json({ payout, txHash: sent.txHash });
}

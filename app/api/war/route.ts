/**
 * War.
 *
 * `GET  /api/war`                     every plot under occupation, for the map, and the latest events.
 * `GET  /api/war?seed=<n>`            one plot's war row: base, army, occupation, shield, last battle.
 * `GET  /api/war?feed=1&since=<ms>`   events since a moment, for the cards on every screen.
 * `POST /api/war` `{action, address, seed, …}`:
 *   `base`      open a base on your plot; `burnTx` paid for it where the token is live.
 *   `train`     count troops the settlement has paid for.
 *   `invade`    march `troops` from `from` onto `seed`.
 *   `retake`    march `troops` from your own base against the garrison on `seed`.
 *   `withdraw`  bring the army home from `seed`.
 *   `pay`       another day's stay on `seed`; the settlement paid the Gold.
 *
 * Everything that moves troops or Gold is signed by the wallet's session,
 * and every fight is decided here.
 */

import { NextResponse } from 'next/server';
import { holdsAddress } from '@/lib/server/session';
import { operator } from '@/lib/server/operator';
import { spendBurn, verifyBurn } from '@/lib/server/burns';
import { tokenLive } from '@/lib/chain/emerge';
import { noteCharge } from '@/lib/server/treasury';
import { ageClaim, buyBase, invade, payOccupation, retake, sieges, shieldedUntil, trainTroops, warFeed, warRow, withdraw } from '@/lib/server/war';
import { BASE_COST_EMERGE } from '@/lib/world/war';
import { judgedFor } from '@/lib/server/land';
import type { Claim } from '@/lib/server/registry';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const noStore = { headers: { 'cache-control': 'no-store, max-age=0' } };

/** The war-facing part of a row: what the map and the panels need, nothing a stranger should not see. */
function warView(claim: Claim) {
  return {
    seed: claim.seed, region: claim.region, worldName: claim.worldName, owner: claim.owner, ownerName: claim.ownerName, era: claim.era ?? 1,
    army: claim.army ?? null, occupation: claim.occupation ?? null, shieldUntil: shieldedUntil(claim), battle: claim.battle ?? null, occupying: claim.occupying ?? null,
  };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('feed')) {
      const since = Number(params.get('since')) || 0;
      return NextResponse.json({ events: await warFeed(since), now: Date.now() }, noStore);
    }
    // What the vault judges a wallet earns, occupation and all: for the operator, with the cron secret.
    const judge = params.get('judge');
    if (judge) {
      if (!operator(request)) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
      if (!ADDRESS.test(judge)) return NextResponse.json({ error: 'A wallet address is needed.' }, { status: 400 });
      return NextResponse.json({ judged: await judgedFor(judge) }, noStore);
    }
    const seed = Number(params.get('seed'));
    if (Number.isFinite(seed) && seed > 0) {
      const row = await warRow(seed);
      return NextResponse.json({ war: row ? warView(row) : null, now: Date.now() }, noStore);
    }
    const rows = await sieges();
    return NextResponse.json({ sieges: rows.map(warView), events: await warFeed(0, 12), now: Date.now() }, noStore);
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let body: { action?: string; address?: string; seed?: number; from?: number; troops?: number; count?: number; burnTx?: string };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  const address = String(body.address ?? '');
  if (!ADDRESS.test(address)) return NextResponse.json({ error: 'A wallet address is needed.' }, { status: 400 });
  if (!holdsAddress(request, address)) return NextResponse.json({ error: 'Sign in with this wallet first.', needsSession: true }, { status: 401 });
  const seed = Math.round(Number(body.seed) || 0);
  if (!(seed > 0)) return NextResponse.json({ error: 'Which plot?' }, { status: 400 });
  const action = String(body.action ?? '');
  try {
    if (action === 'base') {
      // Ask the registry first, and only then take the money. Spending the
      // burn before this check meant paying for a base on somebody else's
      // plot, or a second one on your own, consumed 250,000 $EMERGE and
      // delivered nothing — the same way round as every other charge here.
      const standing = await warRow(seed);
      if (!standing || standing.owner.toLowerCase() !== address.toLowerCase()) {
        return NextResponse.json({ error: 'That plot is not yours.' }, { status: 409 });
      }
      if (standing.army) return NextResponse.json({ war: warView(standing), already: true }, noStore);
      if (tokenLive()) {
        const burnTx = String(body.burnTx ?? '');
        const paid = await verifyBurn(burnTx, address, BASE_COST_EMERGE);
        if (!paid.ok) return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
        if (!(await spendBurn(burnTx, `base:${seed}`, paid.whole))) return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
        await noteCharge(paid.whole);
      }
      const r = await buyBase(seed, address);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim), already: r.already }, noStore);
    }
    if (action === 'train') {
      const r = await trainTroops(seed, address, Number(body.count) || 0);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim), trained: r.trained }, noStore);
    }
    if (action === 'invade') {
      const from = Math.round(Number(body.from) || 0);
      const r = await invade(seed, address, from, Number(body.troops) || 0);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim), battle: r.battle, home: warView(r.home) }, noStore);
    }
    if (action === 'retake') {
      const r = await retake(seed, address, Number(body.troops) || 0);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim), battle: r.battle }, noStore);
    }
    if (action === 'withdraw') {
      const r = await withdraw(seed, address);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim) }, noStore);
    }
    if (action === 'pay') {
      const r = await payOccupation(seed, address);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim), gold: r.gold }, noStore);
    }
    if (action === 'age') {
      // A test hook: age a claim past its shield, so the rehearsal can reach
      // an invasion without waiting a day. Needs both the cron secret and
      // EMERGE_TEST_HOOKS=1, which is set only in the harness. It used to be
      // gated on the token instead, which refused it in every configuration
      // the rehearsal actually runs, so invasion had no end-to-end test.
      if (process.env.EMERGE_TEST_HOOKS !== '1' || !operator(request)) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
      const r = await ageClaim(seed, Number((body as { hours?: number }).hours) || 0);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status ?? 409 });
      return NextResponse.json({ war: warView(r.claim) }, noStore);
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'The registry is not reachable.' }, { status: 502 });
  }
}

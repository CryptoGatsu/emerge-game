/*
 * /api/casino
 *
 * GET  ?address=  the tables' rules, prices, and this wallet's plays and winnings.
 * POST {address, play: {game, pick, bet, prize}}   one play, drawn here.
 * POST {address, play: {game, pick, prize: 'gld', stake, txHash}}   the GLD table: $EMERGE in, GLD out.
 * POST {address, buy:  {method: 'emerge'|'eth', txHash, passes}}   passes of five plays.
 * POST {address, settle: true}   pay this wallet's GLD wins that are still waiting.
 */

import { NextResponse } from 'next/server';
import { holdsAddress } from '@/lib/server/session';
import { VAULT_ADDRESS, tokenLive } from '@/lib/chain/emerge';
import { spendBurn, verifyNative, verifyTransfer } from '@/lib/server/burns';
import { sendNativeFromVault } from '@/lib/server/signer';
import { addCasinoCredit, casinoCreditOf } from '@/lib/server/accounts';
import { counter, incrBy } from '@/lib/server/kv';
import { noteCharge } from '@/lib/server/treasury';
import { displayNames } from '@/lib/server/registry';
import {
  DEV_OWED_GWEI, DEV_PAID_GWEI, DEV_SHARE, EMERGE_PER_GOLD_WON, FREE_PLAYS_PER_DAY, GLD_STAKED_EMERGE, GOLD_PAYS, MAX_BET_GOLD, MAX_BET_GOLD_FOR_EMERGE,
  MAX_GLD_TABLE_PER_DAY_EMERGE, MAX_GLD_WON_PER_DAY_EMERGE, MAX_STAKE_EMERGE, MIN_STAKE_EMERGE,
  MAX_EMERGE_WON_PER_DAY, MIN_BET_GOLD, MIN_BET_GOLD_FOR_EMERGE, PAID_EMERGE, PAID_GOLD, PASSES_SOLD, PASS_CENTS, PASS_EMERGE, PASS_GWEI, PASS_PLAYS, PASS_USD, PICKS, STAKED_GOLD,
  bookGldWin, devWallet, draw, gldFromUnits, gldTableToday, gldWonToday, grantPlays, mayPlay, noteWon, passPrices, pendingGld, playsOf, settleGld, settlePendingGld, settledGld, takePlay, wonToday, type CasinoGame, type CasinoPrize,
} from '@/lib/server/casino';

export const dynamic = 'force-dynamic';
// A GLD win is swapped and sent inside the request when the chain is quick enough.
export const maxDuration = 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Below this the development share is left to accumulate rather than paid as dust. */
const DEV_SWEEP_GWEI = 1_000_000; // 0.001 ETH
/** Passes in one payment; enough for an evening, few enough to price sanely. */
const MAX_PASSES_AT_ONCE = 20;

const rules = () => ({
  freePlays: FREE_PLAYS_PER_DAY, passPlays: PASS_PLAYS, passUsd: PASS_USD,
  minBet: MIN_BET_GOLD, minBetEmerge: MIN_BET_GOLD_FOR_EMERGE, maxBet: MAX_BET_GOLD, maxBetEmerge: MAX_BET_GOLD_FOR_EMERGE,
  goldPays: GOLD_PAYS, emergePerGold: EMERGE_PER_GOLD_WON, maxEmergeDay: MAX_EMERGE_WON_PER_DAY,
  minStakeEmerge: MIN_STAKE_EMERGE, maxStakeEmerge: MAX_STAKE_EMERGE, maxGldDay: MAX_GLD_WON_PER_DAY_EMERGE, maxGldTableDay: MAX_GLD_TABLE_PER_DAY_EMERGE,
});

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get('wins')) return wins(Number(params.get('since')) || 0);
  const address = params.get('address') ?? '';
  const known = ADDRESS.test(address);
  try {
    const [prices, plays, won, credit, gldWon, tableWon, waiting, paid] = await Promise.all([
      passPrices(), known ? playsOf(address) : Promise.resolve(null), known ? wonToday(address) : Promise.resolve(0), known ? casinoCreditOf(address) : Promise.resolve(0),
      known ? gldWonToday(address) : Promise.resolve(0), gldTableToday(), known ? pendingGld(address) : Promise.resolve([]), known ? settledGld(address, 5) : Promise.resolve([]),
    ]);
    return NextResponse.json({
      live: tokenLive(), plays, prices, wonToday: won, credit, devWallet: devWallet() !== null, rules: rules(),
      gld: { wonToday: gldWon, tableToday: tableWon, waiting, paid },
    }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'The casino is closed for a moment.' }, { status: 503 });
  }
}

/**
 * `GET /api/casino?wins=1&since=<ms>` — GLD wins paid since `since`, newest
 * first, with the winner's chosen name when they have one. Public: a win at
 * the tables is news for every screen, and the wallet is on the chain anyway.
 */
async function wins(since: number) {
  try {
    const [paid, names] = await Promise.all([settledGld(undefined, 10), displayNames().catch(() => ({} as Record<string, string>))]);
    const list = paid
      .filter((p) => (p.settledAt ?? 0) > since)
      .map((p) => ({ id: p.id, address: p.address, name: names[p.address] ?? names[p.address.toLowerCase()] ?? null, emerge: p.emerge, stake: p.stake ?? null, gld: gldFromUnits(p.units), game: p.game, at: p.settledAt ?? p.at }));
    return NextResponse.json({ wins: list, now: Date.now() }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ wins: [], now: Date.now() }, { headers: { 'cache-control': 'no-store, max-age=0' } });
  }
}

/** Pay the development wallet what it is owed, once that is worth a transaction. */
async function sweepDev(): Promise<void> {
  const to = devWallet();
  if (!to) return;
  const owed = await counter(DEV_OWED_GWEI);
  if (owed < DEV_SWEEP_GWEI) return;
  const sent = await sendNativeFromVault(to, BigInt(owed) * 1_000_000_000n);
  if (!sent.ok) return;
  await incrBy(DEV_OWED_GWEI, -owed);
  await incrBy(DEV_PAID_GWEI, owed);
}

export async function POST(request: Request) {
  let body: {
    address?: string;
    play?: { game?: string; pick?: number; bet?: number; prize?: string; stake?: number; txHash?: string | null };
    buy?: { method?: string; txHash?: string | null; passes?: number };
    settle?: boolean;
  };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  const address = String(body.address ?? '');
  if (!ADDRESS.test(address)) return NextResponse.json({ error: 'Connect a wallet to play.' }, { status: 400 });
  if (!holdsAddress(request, address)) return NextResponse.json({ error: 'Sign in with this wallet first.', needsSession: true }, { status: 401 });

  if (body.settle) {
    const result = await settlePendingGld(address, 3);
    const [waiting, paid] = await Promise.all([pendingGld(address), settledGld(address, 5)]);
    return NextResponse.json({ ...result, gld: { waiting, paid } });
  }

  if (body.play && body.play.prize === 'gld') {
    // The GLD table. The stake is $EMERGE already in the vault; the draw is
    // made once the chain says so, and never counts against the day's plays.
    const game = body.play.game as CasinoGame;
    if (game !== 'coin' && game !== 'cups') return NextResponse.json({ error: 'No such game.' }, { status: 400 });
    const pick = Math.floor(Number(body.play.pick));
    if (!(pick >= 0 && pick < PICKS[game])) return NextResponse.json({ error: 'Pick a side.' }, { status: 400 });
    let stake = Math.floor(Number(body.play.stake) || 0);
    if (stake < MIN_STAKE_EMERGE) return NextResponse.json({ error: `The GLD table takes ${MIN_STAKE_EMERGE.toLocaleString()} $EMERGE at least.` }, { status: 400 });
    if (stake > MAX_STAKE_EMERGE) return NextResponse.json({ error: `The GLD table takes ${MAX_STAKE_EMERGE.toLocaleString()} $EMERGE at most.` }, { status: 400 });
    const txHash = body.play.txHash ? String(body.play.txHash) : null;
    if (tokenLive()) {
      if (!txHash) return NextResponse.json({ error: 'The stake has not been paid.' }, { status: 402 });
      const paid = await verifyTransfer(txHash, address, VAULT_ADDRESS, Math.floor(stake * 0.97));
      if (!paid.ok) return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
      stake = Math.min(stake, Math.floor(paid.whole));
      // Not booked as a charge here: what the stake becomes depends on the draw.
      if (!(await spendBurn(txHash, 'casino-gld'))) return NextResponse.json({ error: 'That stake has already been played.' }, { status: 409 });
    } else if (!(await mayPlay(address))) return NextResponse.json({ error: 'One play at a time.' }, { status: 429 });
    const drawn = draw(game);
    const won = drawn === pick;
    await incrBy(GLD_STAKED_EMERGE, stake);
    let emerge = 0, capped = false, payout = null;
    if (won) {
      const booked = await bookGldWin(address, game, stake * GOLD_PAYS[game], stake);
      emerge = booked.emerge; capped = booked.capped; payout = booked.payout;
      // The house keeps the stake either way; on a win it pays out more than
      // it took, from the kept share. What is not paid for the cap stays
      // in the vault as a charge would.
      if (emerge <= 0) await noteCharge(stake);
    } else {
      // The stake is the house's: burned, kept and pooled like every charge.
      await noteCharge(stake);
    }
    // Pay now if the chain is quick; otherwise it waits on the list.
    let settled = null;
    if (payout) {
      const r = await settleGld(payout.id);
      settled = r.ok ? r.payout : r.payout ?? payout;
    }
    return NextResponse.json({ won, drawn, gold: 0, emerge, capped, stake, prize: 'gld', gldPayout: settled, plays: await playsOf(address) });
  }

  if (body.play) {
    const game = body.play.game as CasinoGame;
    if (game !== 'coin' && game !== 'cups') return NextResponse.json({ error: 'No such game.' }, { status: 400 });
    const pick = Math.floor(Number(body.play.pick));
    if (!(pick >= 0 && pick < PICKS[game])) return NextResponse.json({ error: 'Pick a side.' }, { status: 400 });
    const prize: CasinoPrize = body.play.prize === 'emerge' ? 'emerge' : 'gold';
    const bet = Math.floor(Number(body.play.bet) || 0);
    const min = prize === 'emerge' ? MIN_BET_GOLD_FOR_EMERGE : MIN_BET_GOLD;
    const max = prize === 'emerge' ? MAX_BET_GOLD_FOR_EMERGE : MAX_BET_GOLD;
    if (bet < min) return NextResponse.json({ error: `The smallest stake ${prize === 'emerge' ? 'for $EMERGE ' : ''}is ${min} Gold.` }, { status: 400 });
    if (bet > max) return NextResponse.json({ error: `The table takes ${max.toLocaleString()} Gold at most${prize === 'emerge' ? ' for $EMERGE' : ''}.` }, { status: 400 });
    if (!(await mayPlay(address))) return NextResponse.json({ error: 'One play at a time.' }, { status: 429 });
    const slot = await takePlay(address);
    if (!slot) {
      return NextResponse.json({
        error: `Your ${FREE_PLAYS_PER_DAY} plays today are used. A pass of ${PASS_PLAYS} more costs about $${PASS_USD}.`, plays: await playsOf(address),
      }, { status: 402 });
    }
    const drawn = draw(game);
    const won = drawn === pick;
    let gold = 0, emerge = 0, capped = false;
    if (won) {
      if (prize === 'gold') gold = Math.floor(bet * GOLD_PAYS[game]);
      else {
        const due = bet * EMERGE_PER_GOLD_WON[game];
        const room = Math.max(0, MAX_EMERGE_WON_PER_DAY - (await wonToday(address)));
        emerge = Math.min(due, room);
        capped = emerge < due;
        if (emerge > 0) { await noteWon(address, emerge); await addCasinoCredit(address, emerge); await incrBy(PAID_EMERGE, emerge); }
      }
    }
    await incrBy(STAKED_GOLD, bet);
    if (gold > 0) await incrBy(PAID_GOLD, gold);
    return NextResponse.json({ won, drawn, gold, emerge, capped, slot, plays: await playsOf(address) });
  }

  if (body.buy) {
    const method = body.buy.method === 'eth' ? 'eth' : 'emerge';
    const txHash = body.buy.txHash ? String(body.buy.txHash) : null;
    // As many passes as they like in one payment, within reason.
    const passes = Math.max(1, Math.min(MAX_PASSES_AT_ONCE, Math.floor(Number(body.buy.passes) || 1)));
    const prices = await passPrices();
    // What the passes brought in, for the public ledger: the asking price
    // until the payment is read, then what was actually paid.
    let emergeIn = method === 'emerge' ? prices.emerge * passes : 0;
    let weiIn = method === 'eth' ? BigInt(prices.ethWei) * BigInt(passes) : 0n;
    if (tokenLive()) {
      if (!txHash) return NextResponse.json({ error: 'The pass has not been paid for.' }, { status: 402 });
      if (method === 'emerge') {
        const paid = await verifyTransfer(txHash, address, VAULT_ADDRESS, Math.floor(prices.emerge * passes * 0.97));
        if (!paid.ok) return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
        if (!(await spendBurn(txHash, 'casino-pass', paid.whole))) return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
        emergeIn = paid.whole;
      } else {
        const wei = BigInt(prices.ethWei) * BigInt(passes);
        const paid = await verifyNative(txHash, address, VAULT_ADDRESS, (wei * 97n) / 100n);
        if (!paid.ok) return NextResponse.json({ error: paid.reason, retry: paid.retry }, { status: paid.retry ? 202 : 402 });
        if (!(await spendBurn(txHash, 'casino-pass-eth'))) return NextResponse.json({ error: 'That payment has already been used.' }, { status: 409 });
        weiIn = paid.wei;
        // The development share, kept in gwei so it stays a safe integer.
        const devGwei = Number((paid.wei * BigInt(Math.round(DEV_SHARE * 100))) / 100n / 1_000_000_000n);
        if (devGwei > 0) await incrBy(DEV_OWED_GWEI, devGwei);
        void sweepDev().catch(() => {});
      }
    }
    await grantPlays(address, PASS_PLAYS * passes);
    await incrBy(PASSES_SOLD, passes);
    // Book the take at the prices of the day, in cents, so the ledger can say
    // what the tables made in dollars without re-pricing history.
    const gweiIn = Number(weiIn / 1_000_000_000n);
    const usd = method === 'emerge' ? emergeIn * (prices.emergeUsd ?? PASS_USD / prices.emerge) : (gweiIn / 1e9) * prices.ethUsd;
    if (emergeIn > 0) await incrBy(PASS_EMERGE, Math.floor(emergeIn));
    if (gweiIn > 0) await incrBy(PASS_GWEI, gweiIn);
    if (usd > 0) await incrBy(PASS_CENTS, Math.round(usd * 100));
    return NextResponse.json({ plays: await playsOf(address) });
  }

  return NextResponse.json({ error: 'Nothing asked for.' }, { status: 400 });
}

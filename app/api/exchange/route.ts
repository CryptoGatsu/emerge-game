/**
 * The exchange. `GET /api/exchange?seed=` — the orders, and what the signed-in
 * wallet's world is owed. `POST /api/exchange` — list, cancel, buy, buyGold,
 * collect; every one bound to the session's wallet.
 */

import { NextResponse } from 'next/server';
import { buyGold, buyGoods, cancelOrder, collect, history, listOrder, makeGood, orders, owed, recordPaid, releaseGold, reserveGold, settleMine, unsettled, TRADE_FEE, MIN_GOLD_LOT, MAX_GOODS_LOT } from '@/lib/server/exchange';
import { registryShared } from '@/lib/server/registry';
import { holdsAddress, sessionAddress, sessionsAvailable } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const terms = { fee: TRADE_FEE, minGoldLot: MIN_GOLD_LOT, maxGoodsLot: MAX_GOODS_LOT };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const seed = Number(url.searchParams.get('seed'));
  // Where sessions cannot be proved, the query's address is the caller's word, as it is for every write there.
  const asked = String(url.searchParams.get('address') ?? '').toLowerCase();
  const me = sessionAddress(request) ?? (!sessionsAvailable() && /^0x[0-9a-f]{40}$/.test(asked) ? asked : null);
  try {
    // A payment waiting to settle is settled here, so simply looking at the
    // exchange finishes a purchase the browser that made it gave up on.
    if (me) await settleMine(me, '').catch(() => {});
    const [rows, mine, mineDone, waiting] = await Promise.all([
      orders(),
      me && Number.isFinite(seed) ? owed(me, seed) : Promise.resolve([]),
      me ? history(me).catch(() => []) : Promise.resolve([]),
      me ? unsettled(me).catch(() => []) : Promise.resolve([]),
    ]);
    return NextResponse.json({ orders: rows, owed: mine, history: mineDone, paid: waiting, terms, shared: registryShared() });
  } catch {
    return NextResponse.json({ orders: [], owed: [], history: [], paid: [], terms, shared: false, degraded: true });
  }
}

/**
 * The deployment's own secret, for the one action no player may take.
 *
 * A make-good puts Gold into a plot without anybody paying for it, so it is
 * authorised the way the cron routes are — by a secret only the deployment
 * holds — and never by a session, however well signed in.
 */
function operator(request: Request): boolean {
  const secret = process.env.EMERGE_CRON_SECRET ?? process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}` || request.headers.get('x-cron-secret') === secret;
}

export async function POST(request: Request) {
  let body: {
    action?: string; address?: string; name?: string; seed?: number; id?: string;
    kind?: 'resource' | 'gold'; resource?: string; qty?: number; unitPrice?: number; txHash?: string; ids?: string[];
    gold?: number; note?: string;
  };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  const address = String(body.address ?? '').toLowerCase();
  if (body.action === 'makeGood') {
    if (!operator(request)) return NextResponse.json({ error: 'Not for this door.' }, { status: 403 });
    if (!/^0x[0-9a-f]{40}$/.test(address)) return NextResponse.json({ error: 'A make-good belongs to a wallet.' }, { status: 400 });
    const r = await makeGood(address, Number(body.seed), Number(body.gold), String(body.note ?? '').slice(0, 120));
    return r.ok ? NextResponse.json({ delivery: r.delivery }) : NextResponse.json({ error: r.reason }, { status: 400 });
  }
  /*
   * A payment made before the exchange kept its own record, handed in on the
   * player's behalf.
   *
   * Safe to allow without their session because nothing here is taken on
   * trust: the transfer is read off the chain and has to be a real one, from
   * this buyer to this seller, for this price, not already spent. An operator
   * can recover a payment; they cannot invent one.
   */
  if (body.action === 'recoverPaid') {
    if (!operator(request)) return NextResponse.json({ error: 'Not for this door.' }, { status: 403 });
    if (!/^0x[0-9a-f]{40}$/.test(address)) return NextResponse.json({ error: 'A payment belongs to a wallet.' }, { status: 400 });
    const noted = await recordPaid({ id: String(body.id ?? ''), buyer: address, seed: Number(body.seed), qty: Number(body.qty), txHash: String(body.txHash ?? '') });
    if (!noted.ok) return NextResponse.json({ error: noted.reason }, { status: 400 });
    const done = await settleMine(address, String(body.name ?? '').slice(0, 32));
    return NextResponse.json({ recorded: true, delivered: done.delivered, problems: done.problems });
  }
  if (!/^0x[0-9a-f]{40}$/.test(address)) return NextResponse.json({ error: 'A trade belongs to a wallet.' }, { status: 400 });
  if (sessionsAvailable() && !holdsAddress(request, address)) return NextResponse.json({ error: 'Sign in with this wallet first.' }, { status: 403 });
  if (!registryShared() && process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_TRIALS) {
    return NextResponse.json({ error: 'This deployment has no shared store, so nothing can be traded. Nothing was taken.' }, { status: 503 });
  }
  const seed = Number(body.seed);
  const name = String(body.name ?? '').slice(0, 32);
  try {
    switch (body.action) {
      case 'paid': {
        /*
         * "I have paid; here is the transaction."
         *
         * Written down before anything that could refuse it, because by the
         * time this is called the $EMERGE has left the buyer's wallet and the
         * seller has it. Refusing here would be refusing to remember money
         * that has already moved, which is how a player lost theirs.
         */
        const r = await recordPaid({ id: String(body.id ?? ''), buyer: address, seed, qty: Number(body.qty), txHash: String(body.txHash ?? '') });
        if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
        // Try it at once; if it cannot settle yet it is safe on the record.
        const done = await settleMine(address, name).catch(() => ({ delivered: [], problems: [] as string[] }));
        return NextResponse.json({ recorded: true, delivered: done.delivered, problems: done.problems });
      }
      case 'settleMine': {
        const done = await settleMine(address, name);
        return NextResponse.json({ delivered: done.delivered, problems: done.problems });
      }
      case 'list': {
        const r = await listOrder({ seller: address, sellerName: name, seed, kind: body.kind as 'resource' | 'gold', resource: body.resource, qty: Number(body.qty), unitPrice: Number(body.unitPrice) });
        return r.ok ? NextResponse.json({ order: r.order }) : NextResponse.json({ error: r.reason }, { status: 400 });
      }
      case 'cancel': {
        const r = await cancelOrder(String(body.id ?? ''), address);
        return r.ok ? NextResponse.json({ delivery: r.delivery, seed: r.seed }) : NextResponse.json({ error: r.reason, retry: r.retry === true }, { status: r.retry ? 202 : 400 });
      }
      case 'buy': {
        const r = await buyGoods({ id: String(body.id ?? ''), buyer: address, buyerName: name, seed, qty: Number(body.qty) });
        return r.ok ? NextResponse.json({ delivery: r.delivery, paid: r.paid, burned: r.burned, remaining: r.remaining }) : NextResponse.json({ error: r.reason, retry: r.retry === true }, { status: r.retry ? 202 : 400 });
      }
      case 'reserve': {
        const r = await reserveGold(String(body.id ?? ''), address, Number(body.qty));
        return r.ok ? NextResponse.json({ until: r.until }) : NextResponse.json({ error: r.reason, retry: r.retry === true }, { status: r.retry ? 202 : 400 });
      }
      case 'release': {
        await releaseGold(String(body.id ?? ''), address);
        return NextResponse.json({ ok: true });
      }
      case 'buyGold': {
        const r = await buyGold({ id: String(body.id ?? ''), buyer: address, buyerName: name, seed, qty: Number(body.qty), txHash: body.txHash });
        return r.ok ? NextResponse.json({ delivery: r.delivery, paid: r.paid, burned: r.burned, remaining: r.remaining }) : NextResponse.json({ error: r.reason, retry: r.retry === true }, { status: r.retry ? 202 : 400 });
      }
      case 'collect': {
        await collect(address, seed, Array.isArray(body.ids) ? body.ids.map(String) : []);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'The exchange is not reachable.' }, { status: 502 });
  }
}

/**
 * The exchange. `GET /api/exchange?seed=` — the orders, and what the signed-in
 * wallet's world is owed. `POST /api/exchange` — list, cancel, buy, buyGold,
 * collect; every one bound to the session's wallet.
 */

import { NextResponse } from 'next/server';
import { buyGold, buyGoods, cancelOrder, collect, listOrder, orders, owed, releaseGold, reserveGold, TRADE_FEE, DAILY_GOLD_SALE_CAP, MIN_GOLD_LOT, MAX_GOODS_LOT } from '@/lib/server/exchange';
import { registryShared } from '@/lib/server/registry';
import { holdsAddress, sessionAddress, sessionsAvailable } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const terms = { fee: TRADE_FEE, dailyGoldCap: DAILY_GOLD_SALE_CAP, minGoldLot: MIN_GOLD_LOT, maxGoodsLot: MAX_GOODS_LOT };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const seed = Number(url.searchParams.get('seed'));
  // Where sessions cannot be proved, the query's address is the caller's word, as it is for every write there.
  const asked = String(url.searchParams.get('address') ?? '').toLowerCase();
  const me = sessionAddress(request) ?? (!sessionsAvailable() && /^0x[0-9a-f]{40}$/.test(asked) ? asked : null);
  try {
    const [rows, mine] = await Promise.all([orders(), me && Number.isFinite(seed) ? owed(me, seed) : Promise.resolve([])]);
    return NextResponse.json({ orders: rows, owed: mine, terms, shared: registryShared() });
  } catch {
    return NextResponse.json({ orders: [], owed: [], terms, shared: false, degraded: true });
  }
}

export async function POST(request: Request) {
  let body: {
    action?: string; address?: string; name?: string; seed?: number; id?: string;
    kind?: 'resource' | 'gold'; resource?: string; qty?: number; unitPrice?: number; txHash?: string; ids?: string[];
  };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  const address = String(body.address ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return NextResponse.json({ error: 'A trade belongs to a wallet.' }, { status: 400 });
  if (sessionsAvailable() && !holdsAddress(request, address)) return NextResponse.json({ error: 'Sign in with this wallet first.' }, { status: 403 });
  if (!registryShared() && process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_TRIALS) {
    return NextResponse.json({ error: 'This deployment has no shared store, so nothing can be traded. Nothing was taken.' }, { status: 503 });
  }
  const seed = Number(body.seed);
  const name = String(body.name ?? '').slice(0, 32);
  try {
    switch (body.action) {
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

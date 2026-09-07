import 'server-only';

/**
 * The exchange: players trading with each other.
 *
 * Two kinds of order. A settlement sells goods out of its store for Gold —
 * timber, grain, tools — and another settlement buys them for Gold out of its
 * treasury. And a player sells Gold itself for $EMERGE, paid wallet to wallet
 * like a plot resale: the tokens never touch the vault, and the game mints
 * none. Every trade burns a share of the Gold that changes hands, which is the
 * exchange's sink: the seller of goods receives the price less the fee, the
 * buyer of Gold receives the Gold less the fee.
 *
 * **What the server holds.** Gold and goods live in each owner's world, in
 * their own browser, so the server cannot move them; it keeps the orders and
 * a ledger of deliveries owed. Listing takes the goods (or the Gold) out of
 * the seller's world into escrow here; a fill writes what each side is owed
 * into their delivery queue; each side's world collects its deliveries the
 * next time it is open, once each, by id. A buyer pays Gold out of the
 * treasury in front of them before the fill is asked for, and gets the Gold
 * back if the fill is refused.
 *
 * **What bounds a Gold sale.** Gold is the sim's own coin and a world is its
 * owner's browser, so a Gold sale is bounded by what the server can see: the
 * treasury in the copy the owner last published, and a daily cap per wallet.
 * The $EMERGE side is the buyer's own transfer to the seller's wallet, read
 * off the chain before the Gold is owed, and used once.
 */

import type { Resource } from '../world/goods';
import { RESOURCES } from '../world/goods';
import { serverKey } from '../limits';
import { tokenLive } from '../chain/emerge';
import { utcDay } from './accounts';
import { spendBurn, verifyTransfer } from './burns';
import { counter, hdel, hget, hgetall, hset, incrBy } from './kv';
import { claimOf, readWorld } from './registry';

/** The share of the Gold in every trade that is burned. */
export const TRADE_FEE = 0.05;
/** The most Gold a wallet may put up for $EMERGE in one UTC day. */
export const DAILY_GOLD_SALE_CAP = 20_000;
/** The smallest Gold lot, and the most goods one order may hold. */
export const MIN_GOLD_LOT = 100;
export const MAX_GOODS_LOT = 5_000;
/** How many orders one wallet may have standing. */
export const MAX_OPEN_ORDERS = 12;

export interface ExchangeOrder {
  id: string;
  kind: 'resource' | 'gold';
  seller: string;
  sellerName: string;
  /** The world the goods or Gold came out of, and where a refund goes. */
  seed: number;
  resource?: Resource;
  /** Units listed, and units still unsold. */
  qty: number;
  remaining: number;
  /** Gold a unit for goods; $EMERGE a Gold for a Gold lot. Whole numbers. */
  unitPrice: number;
  at: number;
}

export interface Delivery {
  id: string;
  kind: 'gold' | 'resource';
  resource?: Resource;
  amount: number;
  /** What it is, for the feed. */
  note: string;
  at: number;
}

const ORDERS = serverKey('exchange:orders');
const owedKey = (owner: string, seed: number) => serverKey(`exchange:owed:${owner.toLowerCase()}:${seed}`);
const soldKey = (owner: string) => serverKey(`exchange:gold:${owner.toLowerCase()}:${utcDay()}`);
const BURNED = serverKey('exchange:burned');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const fee = (gold: number) => Math.ceil(gold * TRADE_FEE);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function orders(): Promise<ExchangeOrder[]> {
  const rows = await hgetall(ORDERS);
  const out: ExchangeOrder[] = [];
  for (const raw of Object.values(rows)) {
    try { const o = JSON.parse(raw) as ExchangeOrder; if (o.remaining > 0) out.push(o); } catch { /* not an order */ }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || (a.resource ?? '').localeCompare(b.resource ?? '') || a.unitPrice - b.unitPrice || a.at - b.at);
}

async function orderOf(id: string): Promise<ExchangeOrder | null> {
  const raw = await hget(ORDERS, id);
  if (!raw) return null;
  try { return JSON.parse(raw) as ExchangeOrder; } catch { return null; }
}

async function owe(owner: string, seed: number, d: Omit<Delivery, 'id' | 'at'>): Promise<Delivery> {
  const delivery: Delivery = { ...d, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: Date.now() };
  await hset(owedKey(owner, seed), delivery.id, JSON.stringify(delivery));
  return delivery;
}

/** What a world is owed and has not yet collected. */
export async function owed(owner: string, seed: number): Promise<Delivery[]> {
  const rows = await hgetall(owedKey(owner, seed));
  const out: Delivery[] = [];
  for (const raw of Object.values(rows)) { try { out.push(JSON.parse(raw) as Delivery); } catch { /* skip */ } }
  return out.sort((a, b) => a.at - b.at);
}

/** The world took these in: forget them. */
export async function collect(owner: string, seed: number, ids: string[]): Promise<void> {
  for (const id of ids.slice(0, 200)) await hdel(owedKey(owner, seed), id);
}

/** Gold burned by the exchange over its life. */
export const burnedGold = async () => counter(BURNED);
const burn = async (gold: number) => { if (gold > 0) await incrBy(BURNED, gold).catch(() => {}); };

type Result<T> = { ok: true } & T | { ok: false; reason: string };

const ownsPlot = async (owner: string, seed: number) => {
  const claim = await claimOf(seed);
  return !!claim && same(claim.owner, owner);
};

/**
 * Put goods or Gold up. The caller's world has already taken them out of its
 * store; the server records the order and, for Gold, checks it against what
 * the last published copy of that world could actually spare.
 */
export async function listOrder(input: {
  seller: string; sellerName: string; seed: number; kind: 'resource' | 'gold'; resource?: string; qty: number; unitPrice: number;
}): Promise<Result<{ order: ExchangeOrder }>> {
  const { seller, seed, kind } = input;
  if (!ADDRESS.test(seller)) return { ok: false, reason: 'An order belongs to a wallet.' };
  const qty = Math.floor(Number(input.qty)), unitPrice = Math.floor(Number(input.unitPrice));
  if (!(qty > 0) || !(unitPrice > 0)) return { ok: false, reason: 'Say how many, and a whole price each.' };
  if (!(await ownsPlot(seller, seed))) return { ok: false, reason: 'Goods come out of a plot you own.' };
  const standing = (await orders()).filter((o) => same(o.seller, seller));
  if (standing.length >= MAX_OPEN_ORDERS) return { ok: false, reason: `You have ${MAX_OPEN_ORDERS} orders standing already. Cancel one first.` };
  let resource: Resource | undefined;
  if (kind === 'resource') {
    if (!RESOURCES.includes(input.resource as Resource)) return { ok: false, reason: 'That is not a good the market knows.' };
    if (qty > MAX_GOODS_LOT) return { ok: false, reason: `One order holds at most ${MAX_GOODS_LOT.toLocaleString()} of a good.` };
    resource = input.resource as Resource;
  } else if (kind === 'gold') {
    if (qty < MIN_GOLD_LOT) return { ok: false, reason: `A Gold lot is at least ${MIN_GOLD_LOT} Gold.` };
    const sold = Number(await hget(soldKey(seller), 'gold')) || 0;
    if (sold + qty > DAILY_GOLD_SALE_CAP) return { ok: false, reason: `A wallet may put up ${DAILY_GOLD_SALE_CAP.toLocaleString()} Gold a day for ${'$EMERGE'}; ${(DAILY_GOLD_SALE_CAP - sold).toLocaleString()} is left today.` };
    // What the last published copy of this world held: the only reading of a
    // treasury the server has that is not the seller's word right now.
    const published = await readWorld(seed);
    const treasury = Number((published?.snapshot as { world?: { treasury?: unknown } } | null)?.world?.treasury);
    if (!published) return { ok: false, reason: 'Open the plot once on this build so its treasury is on record, then list.' };
    const escrowed = standing.filter((o) => o.kind === 'gold' && o.seed === seed).reduce((s, o) => s + o.remaining, 0);
    if (!(treasury >= qty + escrowed)) return { ok: false, reason: `The plot's last published treasury was ${Math.floor(treasury || 0).toLocaleString()} Gold, which does not cover this lot and what is already up.` };
    await hset(soldKey(seller), 'gold', String(sold + qty));
  } else {
    return { ok: false, reason: 'An order is for goods or for Gold.' };
  }
  const order: ExchangeOrder = {
    id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    kind, seller: seller.toLowerCase(), sellerName: input.sellerName.slice(0, 32), seed, resource, qty, remaining: qty, unitPrice, at: Date.now(),
  };
  await hset(ORDERS, order.id, JSON.stringify(order));
  return { ok: true, order };
}

/** Take an order down: what is unsold goes back to the seller's world as a delivery. */
export async function cancelOrder(id: string, seller: string): Promise<Result<{ delivery: Delivery | null }>> {
  const order = await orderOf(id);
  if (!order || order.remaining <= 0) return { ok: false, reason: 'That order is gone.' };
  if (!same(order.seller, seller)) return { ok: false, reason: 'That is not your order.' };
  await hdel(ORDERS, id);
  if (order.kind === 'gold') {
    const sold = Number(await hget(soldKey(seller), 'gold')) || 0;
    await hset(soldKey(seller), 'gold', String(Math.max(0, sold - order.remaining)));
  }
  const delivery = await owe(order.seller, order.seed, order.kind === 'gold'
    ? { kind: 'gold', amount: order.remaining, note: 'Gold back from an order you took down' }
    : { kind: 'resource', resource: order.resource, amount: order.remaining, note: 'goods back from an order you took down' });
  return { ok: true, delivery };
}

/**
 * Buy goods for Gold. The buyer's world has already paid the Gold out of its
 * treasury; the seller is owed the price less the fee, the buyer the goods.
 */
export async function buyGoods(input: { id: string; buyer: string; buyerName: string; seed: number; qty: number }): Promise<Result<{ delivery: Delivery; paid: number; burned: number; remaining: number }>> {
  const { id, buyer, seed } = input;
  const qty = Math.floor(Number(input.qty));
  if (!(qty > 0)) return { ok: false, reason: 'Say how many.' };
  const order = await orderOf(id);
  if (!order || order.remaining <= 0 || order.kind !== 'resource' || !order.resource) return { ok: false, reason: 'That order is gone.' };
  if (same(order.seller, buyer)) return { ok: false, reason: 'That is your own order.' };
  if (qty > order.remaining) return { ok: false, reason: `Only ${order.remaining.toLocaleString()} left on that order.` };
  if (!(await ownsPlot(buyer, seed))) return { ok: false, reason: 'Goods are delivered to a plot you own.' };
  const paid = qty * order.unitPrice;
  const burned = fee(paid);
  const remaining = order.remaining - qty;
  if (remaining > 0) await hset(ORDERS, id, JSON.stringify({ ...order, remaining }));
  else await hdel(ORDERS, id);
  await owe(order.seller, order.seed, { kind: 'gold', amount: paid - burned, note: `${qty.toLocaleString()} ${order.resource} sold to ${input.buyerName.slice(0, 32) || 'a buyer'} for ${paid.toLocaleString()} Gold, ${burned.toLocaleString()} burned` });
  const delivery = await owe(buyer, seed, { kind: 'resource', resource: order.resource, amount: qty, note: `${qty.toLocaleString()} ${order.resource} bought from ${order.sellerName || 'a seller'} for ${paid.toLocaleString()} Gold` });
  await burn(burned);
  return { ok: true, delivery, paid, burned, remaining };
}

/**
 * Buy Gold for $EMERGE. The buyer transferred the price to the seller's wallet;
 * that transfer is read off the chain and used once, then the buyer is owed
 * the Gold less the fee. Off chain (the token not live) the transfer is not
 * checked, as with a plot resale.
 */
export async function buyGold(input: { id: string; buyer: string; buyerName: string; seed: number; qty: number; txHash?: string }): Promise<Result<{ delivery: Delivery; paid: number; burned: number; remaining: number }>> {
  const { id, buyer, seed } = input;
  const qty = Math.floor(Number(input.qty));
  if (!(qty > 0)) return { ok: false, reason: 'Say how much Gold.' };
  const order = await orderOf(id);
  if (!order || order.remaining <= 0 || order.kind !== 'gold') return { ok: false, reason: 'That order is gone.' };
  if (same(order.seller, buyer)) return { ok: false, reason: 'That is your own order.' };
  if (qty > order.remaining) return { ok: false, reason: `Only ${order.remaining.toLocaleString()} Gold left on that order.` };
  if (!(await ownsPlot(buyer, seed))) return { ok: false, reason: 'Gold is delivered to a plot you own.' };
  const price = qty * order.unitPrice;
  if (tokenLive()) {
    const tx = String(input.txHash ?? '');
    const paid = await verifyTransfer(tx, buyer, order.seller, price);
    if (!paid.ok) return { ok: false, reason: paid.reason };
    if (!(await spendBurn(tx, `exchange:${id}`))) return { ok: false, reason: 'That payment was already used.' };
  }
  const burned = fee(qty);
  const remaining = order.remaining - qty;
  if (remaining > 0) await hset(ORDERS, id, JSON.stringify({ ...order, remaining }));
  else await hdel(ORDERS, id);
  const delivery = await owe(buyer, seed, { kind: 'gold', amount: qty - burned, note: `${qty.toLocaleString()} Gold bought from ${order.sellerName || 'a seller'} for ${price.toLocaleString()} $EMERGE, ${burned.toLocaleString()} burned` });
  await burn(burned);
  return { ok: true, delivery, paid: price, burned, remaining };
}


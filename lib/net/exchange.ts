/**
 * The exchange, from the browser.
 *
 * Orders and deliveries are the server's; Gold and goods are the world's in
 * front of you. So every trade here is two steps the client keeps honest:
 * take the Gold or the goods out of the world first, ask the server second,
 * and put them back if the server says no.
 */

import type { Resource } from '@/lib/world/goods';
import { pay } from '@/lib/chain/spend';
import type { VaultLedger } from '@/lib/chain/vault';

export interface ExchangeOrder {
  id: string; kind: 'resource' | 'gold'; seller: string; sellerName: string; seed: number;
  resource?: Resource; qty: number; remaining: number; unitPrice: number; at: number;
}
export interface Delivery { id: string; kind: 'gold' | 'resource'; resource?: Resource; amount: number; note: string; at: number }
export interface ExchangeTerms { fee: number; dailyGoldCap: number; minGoldLot: number; maxGoodsLot: number }
export interface ExchangeView { orders: ExchangeOrder[]; owed: Delivery[]; terms: ExchangeTerms; shared: boolean; degraded?: boolean }

const DEFAULT_TERMS: ExchangeTerms = { fee: 0.05, dailyGoldCap: 20_000, minGoldLot: 100, maxGoodsLot: 5_000 };

export async function fetchExchange(seed: number | null): Promise<ExchangeView | null> {
  try {
    const response = await fetch(`/api/exchange${seed !== null ? `?seed=${seed}` : ''}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<ExchangeView>;
    return { orders: json.orders ?? [], owed: json.owed ?? [], terms: json.terms ?? DEFAULT_TERMS, shared: !!json.shared, degraded: json.degraded };
  } catch {
    return null;
  }
}

type Reply<T> = ({ ok: true } & T) | { ok: false; reason: string };

async function post<T>(body: Record<string, unknown>): Promise<Reply<T>> {
  try {
    const response = await fetch('/api/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) return { ok: false, reason: json.error ?? 'The exchange did not answer.' };
    return { ok: true, ...json };
  } catch {
    return { ok: false, reason: 'The exchange could not be reached.' };
  }
}

export const listOrder = (address: string, name: string, seed: number, kind: 'resource' | 'gold', qty: number, unitPrice: number, resource?: Resource) =>
  post<{ order: ExchangeOrder }>({ action: 'list', address, name, seed, kind, resource, qty, unitPrice });
export const cancelOrder = (address: string, seed: number, id: string) =>
  post<{ delivery: Delivery | null }>({ action: 'cancel', address, seed, id });
export const buyGoods = (address: string, name: string, seed: number, id: string, qty: number) =>
  post<{ delivery: Delivery; paid: number; burned: number; remaining: number }>({ action: 'buy', address, name, seed, id, qty });
export const collectDeliveries = (address: string, seed: number, ids: string[]) =>
  post<{ ok: true }>({ action: 'collect', address, seed, ids });

/**
 * Buy Gold: pay the seller's wallet in $EMERGE first, then hand the receipt
 * to the server. Off chain the payment is the ledger's own bookkeeping, as it
 * is for a plot resale.
 */
export async function buyGold(ledger: VaultLedger, address: string, name: string, seed: number, order: ExchangeOrder, qty: number): Promise<Reply<{ delivery: Delivery; paid: number; burned: number; remaining: number; ledger: VaultLedger }>> {
  const price = qty * order.unitPrice;
  const paid = await pay(ledger, price, address, order.seller);
  if (!paid.ok) return { ok: false, reason: paid.refused ?? 'The payment was refused.' };
  const r = await post<{ delivery: Delivery; paid: number; burned: number; remaining: number }>({ action: 'buyGold', address, name, seed, id: order.id, qty, txHash: paid.txHash ?? undefined });
  if (!r.ok) return r;
  return { ...r, ledger: paid.ledger };
}

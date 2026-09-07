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

export async function fetchExchange(seed: number | null, address: string | null = null): Promise<ExchangeView | null> {
  try {
    const query = [seed !== null ? `seed=${seed}` : '', address ? `address=${address}` : ''].filter(Boolean).join('&');
    const response = await fetch(`/api/exchange${query ? `?${query}` : ''}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<ExchangeView>;
    return { orders: json.orders ?? [], owed: json.owed ?? [], terms: json.terms ?? DEFAULT_TERMS, shared: !!json.shared, degraded: json.degraded };
  } catch {
    return null;
  }
}

type Reply<T> = ({ ok: true } & T) | { ok: false; reason: string; retry?: boolean };

async function post<T>(body: Record<string, unknown>): Promise<Reply<T>> {
  try {
    const response = await fetch('/api/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as T & { error?: string; retry?: boolean };
    if (!response.ok) return { ok: false, reason: json.error ?? 'The exchange did not answer.', retry: json.retry === true || response.status === 202 };
    return { ok: true, ...json };
  } catch {
    return { ok: false, reason: 'The exchange could not be reached.', retry: true };
  }
}

export const listOrder = (address: string, name: string, seed: number, kind: 'resource' | 'gold', qty: number, unitPrice: number, resource?: Resource) =>
  post<{ order: ExchangeOrder }>({ action: 'list', address, name, seed, kind, resource, qty, unitPrice });
export const cancelOrder = (address: string, seed: number, id: string) =>
  post<{ delivery: Delivery | null; seed: number }>({ action: 'cancel', address, seed, id });
export const buyGoods = (address: string, name: string, seed: number, id: string, qty: number) =>
  post<{ delivery: Delivery; paid: number; burned: number; remaining: number }>({ action: 'buy', address, name, seed, id, qty });
export const collectDeliveries = (address: string, seed: number, ids: string[]) =>
  post<{ ok: true }>({ action: 'collect', address, seed, ids });

/**
 * A Gold purchase paid for but not yet settled: the receipt is kept in the
 * browser so the same payment can be handed in again, never paid twice.
 */
export interface PendingPurchase { id: string; seed: number; qty: number; txHash: string | null; at: number; address: string }
const PENDING = 'emerge.exchange.pending.v1';
export function pendingPurchases(address: string | null): PendingPurchase[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(PENDING) ?? '[]') as PendingPurchase[];
    return all.filter((p) => !address || p.address === address.toLowerCase());
  } catch { return []; }
}
function rememberPending(p: PendingPurchase | null, dropId?: string) {
  try {
    const all = pendingPurchases(null).filter((x) => x.id !== (dropId ?? p?.id));
    if (p) all.push(p);
    window.localStorage.setItem(PENDING, JSON.stringify(all.slice(-20)));
  } catch { /* private browsing: the receipt is only in the wallet's history then */ }
}

type Settled = { delivery: Delivery; paid: number; burned: number; remaining: number };

/** Hand a receipt in, asking again while the chain has not settled it. */
async function settle(address: string, name: string, p: PendingPurchase, tries = 12): Promise<Reply<Settled>> {
  let last: Reply<Settled> = { ok: false, reason: 'The exchange did not answer.', retry: true };
  for (let i = 0; i < tries; i++) {
    last = await post<Settled>({ action: 'buyGold', address, name, seed: p.seed, id: p.id, qty: p.qty, txHash: p.txHash ?? undefined });
    if (last.ok || !last.retry) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return last;
}

/**
 * Buy Gold, in the order that cannot lose the buyer's money.
 *
 * The lot is held first, so a session or a fill that would fail fails before
 * anything is paid. Then the seller's wallet is paid in $EMERGE. Then the
 * receipt is handed in, and asked about again while the chain has not
 * settled it; if it still is not settled, the receipt is kept and "Finish a
 * paid purchase" hands the same one in later. Off chain the payment is the
 * ledger's own bookkeeping, as it is for a plot resale.
 */
export async function buyGold(ledger: VaultLedger, address: string, name: string, seed: number, order: ExchangeOrder, qty: number): Promise<Reply<Settled & { ledger: VaultLedger }>> {
  const held = await post<{ until: number }>({ action: 'reserve', address, seed, id: order.id, qty });
  if (!held.ok) return held;
  const price = qty * order.unitPrice;
  const paid = await pay(ledger, price, address, order.seller);
  if (!paid.ok) {
    void post({ action: 'release', address, seed, id: order.id });
    return { ok: false, reason: paid.refused ?? 'The payment was refused.' };
  }
  const pending: PendingPurchase = { id: order.id, seed, qty, txHash: paid.txHash, at: Date.now(), address: address.toLowerCase() };
  rememberPending(pending);
  const r = await settle(address, name, pending);
  if (r.ok) { rememberPending(null, pending.id); return { ...r, ledger: paid.ledger }; }
  if (!r.retry) rememberPending(null, pending.id);
  return { ok: false, reason: r.retry ? `${r.reason} Your payment is kept: use “Finish a paid purchase” on the exchange to hand it in again.` : r.reason };
}

/** Hand every kept receipt in again. Returns what was settled, and the first refusal. */
export async function finishPending(address: string, name: string): Promise<{ settled: Settled[]; reason: string | null }> {
  const settled: Settled[] = [];
  let reason: string | null = null;
  for (const p of pendingPurchases(address)) {
    const r = await settle(address, name, p, 3);
    if (r.ok) { settled.push(r); rememberPending(null, p.id); }
    else { if (!r.retry) rememberPending(null, p.id); reason ??= r.reason; }
  }
  return { settled, reason };
}

/**
 * The exchange, from the browser.
 *
 * Orders and deliveries are the server's; Gold and goods are the world's in
 * front of you. So every trade here is two steps the client keeps honest:
 * take the Gold or the goods out of the world first, ask the server second,
 * and put them back if the server says no.
 */

import type { Resource } from '@/lib/world/goods';
import { pay, spend } from '@/lib/chain/spend';
import type { VaultLedger } from '@/lib/chain/vault';
import { goldSaleSplit } from '@/lib/chain/vault';

export interface ExchangeOrder {
  id: string; kind: 'resource' | 'gold'; seller: string; sellerName: string; seed: number;
  resource?: Resource; qty: number; remaining: number; unitPrice: number; at: number;
}
export interface Delivery { id: string; kind: 'gold' | 'resource'; resource?: Resource; amount: number; note: string; at: number }
export interface ExchangeTerms { fee: number; minGoldLot: number; maxGoodsLot: number }
export interface TradeRecord {
  id: string; at: number; side: 'bought' | 'sold'; kind: 'resource' | 'gold';
  resource?: Resource; qty: number; unitPrice: number; burned: number; got: number; seed: number; other: string; otherName: string;
}
/** A payment made and not yet settled, as the server holds it. */
export interface PaidIntent { txHash: string; burnTx?: string; id: string; buyer: string; seed: number; qty: number; at: number; problem?: string; tries?: number }
export interface ExchangeView { orders: ExchangeOrder[]; owed: Delivery[]; history: TradeRecord[]; paid: PaidIntent[]; terms: ExchangeTerms; shared: boolean; degraded?: boolean }

const DEFAULT_TERMS: ExchangeTerms = { fee: 0.05, minGoldLot: 100, maxGoodsLot: 5_000 };

export async function fetchExchange(seed: number | null, address: string | null = null): Promise<ExchangeView | null> {
  try {
    const query = [seed !== null ? `seed=${seed}` : '', address ? `address=${address}` : ''].filter(Boolean).join('&');
    const response = await fetch(`/api/exchange${query ? `?${query}` : ''}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<ExchangeView>;
    return { orders: json.orders ?? [], owed: json.owed ?? [], history: json.history ?? [], paid: json.paid ?? [], terms: json.terms ?? DEFAULT_TERMS, shared: !!json.shared, degraded: json.degraded };
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
export interface PendingPurchase { id: string; seed: number; qty: number; txHash: string | null; burnTx?: string | null; at: number; address: string }
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

type Settled = { delivery: Delivery; paid: number; burned: number; tokensBurned?: number; remaining: number };

/**
 * Hand a receipt in, asking again while the chain has not settled it.
 *
 * The wait used to be a minute, and the chain wants three confirmations: on a
 * slow block a buyer paid the seller, waited out twelve tries, and was told to
 * come back and press a button they had no reason to expect. Players reported
 * buying Gold and receiving none, which is exactly what that looks like from
 * the outside. So the first attempt waits long enough for three blocks to be
 * unlikely to miss, and whatever is still unsettled is handed in again on its
 * own — see `resumePending` — rather than waiting on the player.
 */
async function settle(address: string, name: string, p: PendingPurchase, tries = 40): Promise<Reply<Settled>> {
  let last: Reply<Settled> = { ok: false, reason: 'The exchange did not answer.', retry: true };
  for (let i = 0; i < tries; i++) {
    last = await post<Settled>({ action: 'buyGold', address, name, seed: p.seed, id: p.id, qty: p.qty, txHash: p.txHash ?? undefined, burnTx: p.burnTx ?? undefined });
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
  /*
   * The price divides in two: the seller's share and the share that is
   * destroyed. Wallet to wallet is the whole point of a Gold sale, so there is
   * no contract in the middle to split one payment — the buyer signs both, the
   * seller's first.
   *
   * Order matters. The seller's share goes first because it is the leg the
   * trade cannot do without and the leg the server can retry for ever; the
   * burn follows. A burn that fails after the seller has been paid leaves the
   * receipt on the browser's books and settles later, and the server will
   * wait rather than refuse — see `buyGold`, which checks both receipts before
   * it spends either.
   */
  const split = goldSaleSplit(price);
  const paid = await pay(ledger, split.toSeller, address, order.seller);
  if (!paid.ok) {
    void post({ action: 'release', address, seed, id: order.id });
    return { ok: false, reason: paid.refused ?? 'The payment was refused.' };
  }
  const gone = await spend(paid.ledger, split.burned, address);
  if (!gone.ok) {
    // The seller has been paid and the burn has not gone through. Nothing is
    // lost — the receipt is kept and handed in — but this purchase cannot
    // settle until the burn does, so say so plainly rather than silently.
    void post({ action: 'release', address, seed, id: order.id });
    return { ok: false, reason: `${gone.refused ?? 'The burn was refused.'} The seller has been paid; the purchase finishes once the burn goes through.` };
  }
  const pending: PendingPurchase = { id: order.id, seed, qty, txHash: paid.txHash, burnTx: gone.txHash, at: Date.now(), address: address.toLowerCase() };
  rememberPending(pending);
  /*
   * Tell the server the money has moved, before asking it for anything.
   *
   * This browser used to be the only thing that knew: it paid the seller and
   * then asked for the Gold, and a refusal it could not retry — a lapsed
   * session, a store that blinked, a five-hundred — dropped the receipt and
   * the money was gone with no record of it anywhere. A player lost $EMERGE
   * that way. The hash goes on the server's books first now; settling is
   * something either side can retry afterwards, for as long as it takes.
   */
  if (paid.txHash) {
    const noted = await post<{ recorded: true; delivered: Delivery[] }>({ action: 'paid', address, name, seed, id: order.id, qty, txHash: paid.txHash, burnTx: gone.txHash ?? undefined });
    if (noted.ok && noted.delivered?.length) {
      rememberPending(null, pending.id);
      const d = noted.delivered[0];
      return { ok: true, delivery: d, paid: split.whole, burned: 0, remaining: 0, ledger: gone.ledger };
    }
  }
  const r = await settle(address, name, pending);
  if (r.ok) { rememberPending(null, pending.id); return { ...r, ledger: gone.ledger }; }
  /*
   * The receipt is kept unless the chain says this payment was never valid.
   * It used to be dropped on any refusal that was not marked retryable, which
   * threw away the only record of money that had already moved.
   */
  if (spent(r.reason)) rememberPending(null, pending.id);
  return { ok: false, reason: `${r.reason} Your payment is on the exchange's books and the Gold is still coming: the purchase finishes by itself.` };
}

/**
 * Whether a refusal means this receipt is finished with — either the trade
 * went through already, or the payment can never be right. Anything else is
 * kept and tried again.
 */
function spent(reason: string): boolean {
  return /already used|failed on chain|different wallet|not a transaction hash/i.test(reason);
}

/**
 * Quietly hand in whatever is still owed, once each.
 *
 * Called on entering a world and on a timer, so a purchase that outlasted its
 * first settling window finishes on its own. A receipt that is still not
 * settled is left alone for the next round; one the chain has refused for
 * good is dropped.
 */
export async function resumePending(address: string, name: string): Promise<{ delivery: Delivery }[]> {
  const out: { delivery: Delivery }[] = [];
  // The server's own record first: it settles payments this browser may never
  // have known about, including ones made on another device.
  const mine = await post<{ delivered: Delivery[] }>({ action: 'settleMine', address, name });
  if (mine.ok) for (const d of mine.delivered ?? []) out.push({ delivery: d });
  for (const p of pendingPurchases(address)) {
    const r = await settle(address, name, p, 1);
    if (r.ok) { out.push(r); rememberPending(null, p.id); }
    else if (spent(r.reason)) rememberPending(null, p.id);
  }
  return out;
}

/** Hand every kept receipt in again. Returns what was settled, and the first refusal. */
export async function finishPending(address: string, name: string): Promise<{ settled: Settled[]; reason: string | null }> {
  const settled: Settled[] = [];
  let reason: string | null = null;
  const mine = await post<{ delivered: Delivery[]; problems: string[] }>({ action: 'settleMine', address, name });
  if (mine.ok) for (const d of mine.delivered ?? []) settled.push({ delivery: d, paid: 0, burned: 0, remaining: 0 });
  for (const p of pendingPurchases(address)) {
    const r = await settle(address, name, p, 3);
    if (r.ok) { settled.push(r); rememberPending(null, p.id); }
    else { if (spent(r.reason)) rememberPending(null, p.id); reason ??= r.reason; }
  }
  if (!settled.length && !reason && mine.ok && mine.problems?.length) reason = mine.problems[0];
  return { settled, reason };
}

/**
 * Receipts for payments the game has not yet honoured.
 *
 * Every purchase in the game is a transfer the wallet signs and then a
 * request to the registry that has to be read off the chain and acted on.
 * Between the two is where a player used to lose money: the chain slower
 * than the button's patience, the connection dropping, a reply lost on the
 * way back. The receipt was shown once, ten characters of it, in a toast
 * that said keep it and tell us — and the next press paid again.
 *
 * So the receipt is kept here the moment the wallet has paid, and handed in
 * again before anything else is paid: on the next press of the same button,
 * and once every time the world or the map opens. What handing it in means
 * depends on what it bought — the registry accepts the same receipt for the
 * same step as often as it is offered, and a receipt it will not take back
 * for its step is redeemed on account, where it pays for the next thing.
 * Either way it is let go only once the registry has said so.
 *
 * The Gold exchange keeps its own receipts (`PendingPurchase`) and the era
 * step its own (`PendingEra`), from before this was general; this is the
 * same idea for everything else.
 */

import { redeemPayment } from './registry';
import { t } from '../i18n';
import { TOKEN } from '../chain/emerge';

export type ReceiptKind = 'expand' | 'cover' | 'boon' | 'hire' | 'gift' | 'survey' | 'claim' | 'resale-fee' | 'bet';

export interface Receipt {
  kind: ReceiptKind;
  txHash: string;
  /** The wallet that paid, lower-cased. */
  address: string;
  /** The plot it was for, or 0 when it was not for one. */
  seed: number;
  at: number;
  /** What the request needs to be made again: the boon's kind, the bet's side. */
  payload?: Record<string, unknown>;
  /** How many times handing it in has been tried and not settled either way. */
  tries?: number;
}

const KEY = 'emerge.receipts.v1';
/** After this many tries that settled nothing, the receipt is let go — it is still in the wallet's history. */
const GIVE_UP_AFTER = 40;

export function receipts(address?: string | null, kind?: ReceiptKind): Receipt[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as Receipt[];
    return all.filter((r) => (!address || r.address === address.toLowerCase()) && (!kind || r.kind === kind));
  } catch { return []; }
}

function write(all: Receipt[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(all.slice(-30))); } catch { /* private browsing: the receipt is only in the wallet's history then */ }
}

/** Keep a receipt, once: the same transaction is never kept twice. */
export function keepReceipt(r: Omit<Receipt, 'at' | 'tries'> & { at?: number }) {
  const all = receipts().filter((x) => x.txHash.toLowerCase() !== r.txHash.toLowerCase());
  all.push({ ...r, address: r.address.toLowerCase(), at: r.at ?? Date.now(), tries: 0 });
  write(all);
}

export function dropReceipt(txHash: string) {
  write(receipts().filter((x) => x.txHash.toLowerCase() !== txHash.toLowerCase()));
}

/**
 * What handing one receipt in came to.
 *
 * `done` means the registry has settled it one way or the other — the step
 * delivered, the payment on account, or a receipt that will never be taken
 * — and it can be let go. `note` is a line for the player when there is
 * something to say.
 */
export type Outcome = { done: boolean; note?: string };
export type Handler = (r: Receipt) => Promise<Outcome>;

/**
 * Hand every kept receipt in, each to its own handler, and let the settled
 * ones go. A receipt with no handler of its own is redeemed by the fallback.
 * One receipt at a time, oldest first, so two of them never pay for one
 * thing between them.
 */
export async function resumeReceipts(address: string, handlers: Partial<Record<ReceiptKind, Handler>>, fallback: Handler, only?: ReceiptKind[]): Promise<{ receipt: Receipt; note: string }[]> {
  const said: { receipt: Receipt; note: string }[] = [];
  /*
   * Each screen hands in only the receipts it knows how to: a bet is the
   * arena's, an expansion the world's, a survey the map's. Left to a fallback
   * on the wrong screen, a receipt with a step still willing to take it back
   * would be redeemed on account instead — or, once spent on that step,
   * answered "already used" and let go with the thing it bought undelivered.
   */
  const mine = receipts(address).filter((r) => !only || only.includes(r.kind));
  for (const r of mine.sort((a, b) => a.at - b.at)) {
    const handle = handlers[r.kind] ?? fallback;
    let outcome: Outcome;
    try { outcome = await handle(r); } catch { outcome = { done: false }; }
    if (outcome.done) {
      dropReceipt(r.txHash);
    } else {
      const tries = (r.tries ?? 0) + 1;
      if (tries >= GIVE_UP_AFTER) dropReceipt(r.txHash);
      else write(receipts().map((x) => (x.txHash === r.txHash ? { ...x, tries } : x)));
    }
    if (outcome.note) said.push({ receipt: r, note: outcome.note });
  }
  return said;
}

/**
 * The registry's answers that mean a receipt is settled and can be let go,
 * whichever door it was handed in at: it bought what it was for, it is on
 * account, or it will never be accepted.
 */
export const SETTLED_ANSWER = /already been used|already used|already (?:yours|expanded|advanced)|on account|failed on chain|not a transaction hash|different wallet|did not (?:send|pay) any|no payments to redeem/i;

/**
 * The fallback for a receipt with no step of its own to hand it back to:
 * redeemed on account, where it pays for the next thing this wallet buys.
 * "Already used" is the registry saying it bought what it was for, or was
 * given back on account already — settled either way.
 */
export const redeemFallback = (owner: string): Handler => async (r) => {
  const res = await redeemPayment({ owner, burnTx: r.txHash });
  if (res.ok) {
    return { done: true, note: t('A payment kept from before was redeemed: {n} {ticker} is on account and pays for the next thing you buy.', { n: res.banked.toLocaleString(), ticker: TOKEN.ticker }) };
  }
  if (res.settling) return { done: false };
  return { done: SETTLED_ANSWER.test(res.reason) };
};

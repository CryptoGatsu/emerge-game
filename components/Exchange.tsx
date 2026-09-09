'use client';

/**
 * The exchange panel: buy and sell with other players.
 *
 * Goods for Gold between settlements, and Gold for $EMERGE between wallets.
 * The panel only asks; the world in front of you takes the Gold or goods out
 * before the server is asked and puts them back if it says no (see
 * EmergeClient), so nothing on screen can promise what the store does not
 * hold.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RESOURCE_LABELS, type Resource } from '@/lib/world/goods';
import { TOKEN } from '@/lib/chain/emerge';
import { GOLD_SALE_BURN_RATE, goldSaleSplit } from '@/lib/chain/vault';
import { shortAddress } from '@/lib/chain/emerge';
import { fetchExchange, pendingPurchases, type ExchangeOrder, type ExchangeView, type TradeRecord } from '@/lib/net/exchange';
import type { Snapshot } from '@/lib/hud';
import { t, tn, useLocale } from '@/lib/i18n';

export interface ExchangeActions {
  list: (kind: 'resource' | 'gold', qty: number, unitPrice: number, resource?: Resource) => Promise<string | null>;
  buy: (order: ExchangeOrder, qty: number) => Promise<string | null>;
  cancel: (id: string) => Promise<string | null>;
  /** Hand kept receipts in again. */
  finish: () => Promise<string | null>;
}

export function ExchangePanel({ view, seed, me, spectating, actions }: {
  view: Snapshot; seed: number; me: string | null; spectating: boolean; actions: ExchangeActions;
}) {
  useLocale();
  const [tab, setTab] = useState<'buy' | 'sell' | 'mine' | 'past'>('buy');
  const [book, setBook] = useState<ExchangeView | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const reload = useCallback(async () => { setBook(await fetchExchange(seed, me)); setPending(pendingPurchases(me).length); }, [seed, me]);
  const [pending, setPending] = useState(0);
  useEffect(() => { void reload(); }, [reload]);
  const mine = me?.toLowerCase() ?? '';
  const terms = book?.terms ?? { fee: 0.05, minGoldLot: 100, maxGoodsLot: 5_000 };
  const feePct = Math.round(terms.fee * 100);
  /** The share of a Gold lot's $EMERGE that is burned, out of the seller's end. */
  const tokenPct = Math.round(GOLD_SALE_BURN_RATE * 100);
  const orders = book?.orders ?? [];
  const goods = useMemo(() => orders.filter((o) => o.kind === 'resource'), [orders]);
  const gold = useMemo(() => orders.filter((o) => o.kind === 'gold'), [orders]);
  const own = useMemo(() => orders.filter((o) => o.seller === mine), [orders, mine]);
  const past = book?.history ?? [];
  // Payments the server holds and has not settled: shown, never silent.
  const waiting = book?.paid ?? [];
  const canAct = !spectating && !!me;
  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true); setNote(null);
    const why = await fn();
    setBusy(false);
    setNote(why);
    await reload();
    return why;
  };
  const stock = (r: Resource) => view.resources.find((x) => x.key === r)?.amount ?? 0;

  // Sell form.
  const [kind, setKind] = useState<'resource' | 'gold'>('resource');
  const [resource, setResource] = useState<Resource>('wood');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const q = Math.floor(Number(qty) || 0), p = Math.floor(Number(price) || 0);
  const sellOk = q > 0 && p > 0 && (kind === 'gold' ? q >= terms.minGoldLot && q <= view.treasury : q <= stock(resource) && q <= terms.maxGoodsLot);

  /*
   * One line of what actually happened.
   *
   * Deliveries arrive the next time a world is open and the Gold goes into a
   * treasury that upkeep draws on, so "did my purchase go through" was a
   * question the panel could not answer. It answers it here.
   */
  const done = (h: TradeRecord) => {
    const what = h.kind === 'gold'
      ? t('{n} Gold', { n: h.qty.toLocaleString() })
      : `${h.qty.toLocaleString()} ${tn(RESOURCE_LABELS[h.resource as Resource] ?? h.resource ?? '')}`;
    const price = h.kind === 'gold'
      ? t('{n} {ticker} each', { n: h.unitPrice.toLocaleString(), ticker: TOKEN.ticker })
      : t('{n} Gold each', { n: h.unitPrice.toLocaleString() });
    // What this wallet came away with: Gold or goods for a buyer, Gold or
    // $EMERGE for a seller.
    const got = h.side === 'bought'
      ? (h.kind === 'gold' ? t('you received {n} Gold', { n: h.got.toLocaleString() }) : t('you received {n}', { n: what }))
      : (h.kind === 'gold' ? t('you were paid {n} {ticker}', { n: h.got.toLocaleString(), ticker: TOKEN.ticker }) : t('you were paid {n} Gold', { n: h.got.toLocaleString() }));
    return (
      <div key={h.id} className="people-row exchange-past">
        <b>{h.side === 'bought' ? t('Bought') : t('Sold')}</b>
        <span className="exchange-past-what">{what}</span>
        <span className="exchange-past-price muted">{price}</span>
        <span className="exchange-past-got muted">{got}{h.burned > 0 ? ` · ${t('{n} Gold burned', { n: h.burned.toLocaleString() })}` : ''}</span>
        <small className="exchange-past-who muted">{h.otherName || (h.other ? shortAddress(h.other) : '')} · {new Date(h.at).toLocaleDateString()}</small>
      </div>
    );
  };

  const row = (o: ExchangeOrder) => {
    const yours = o.seller === mine;
    const want = Math.max(0, Math.min(o.remaining, Math.floor(Number(amounts[o.id] ?? o.remaining) || 0)));
    const total = want * o.unitPrice;
    const afterFee = o.kind === 'gold' ? want - Math.ceil(want * terms.fee) : want;
    return (
      <div key={o.id} className={`people-row exchange-row ${yours ? 'mine' : ''}`}>
        <span className="exchange-what">
          <b>{o.kind === 'gold' ? t('{n} Gold', { n: o.remaining.toLocaleString() }) : `${o.remaining.toLocaleString()} ${tn(RESOURCE_LABELS[o.resource as Resource])}`}</b>
          <small className="muted">{yours ? (o.seed === seed ? t('yours') : t('yours, from another plot')) : (o.sellerName || shortAddress(o.seller))}</small>
        </span>
        <span className="exchange-price">
          <b>{o.kind === 'gold' ? t('{n} {ticker} a Gold', { n: o.unitPrice.toLocaleString(), ticker: TOKEN.ticker }) : t('{n} Gold each', { n: o.unitPrice.toLocaleString() })}</b>
          <small className="muted">{o.kind === 'gold'
            ? t('you receive {n} Gold after the {pct}% burn; {pct2}% of the {ticker} is burned too', { n: afterFee.toLocaleString(), pct: feePct, pct2: tokenPct, ticker: TOKEN.ticker })
            : t('{pct}% of the Gold is burned', { pct: feePct })}</small>
        </span>
        {canAct && !yours ? (
          <span className="exchange-buy">
            <input type="number" min={1} max={o.remaining} value={amounts[o.id] ?? String(o.remaining)} onChange={(e) => setAmounts((a) => ({ ...a, [o.id]: e.target.value }))} />
            <button className="claim-button small" disabled={busy || want <= 0 || (o.kind === 'resource' && total > view.treasury)} onClick={() => act(() => actions.buy(o, want))}>
              {o.kind === 'gold' ? t('Buy for {n} {ticker}', { n: total.toLocaleString(), ticker: TOKEN.ticker }) : t('Buy for {n} Gold', { n: total.toLocaleString() })}
            </button>
          </span>
        ) : yours && canAct ? (
          <span className="exchange-buy"><button className="ghost small" disabled={busy} onClick={() => act(() => actions.cancel(o.id))}>{t('Take down')}</button></span>
        ) : <span className="muted small">{spectating ? t('watching') : t('connect a wallet to buy')}</span>}
      </div>
    );
  };

  return (
    <div className="exchange">
      <p className="muted small">
        {t('Settlements sell goods to each other for Gold, and players sell Gold to each other for {ticker}, wallet to wallet. {pct}% of the Gold in every trade is burned, and on a Gold lot {pct2}% of the {ticker} is burned as well, out of the seller’s end. Goods and Gold you list leave your store at once and come back if you take the order down; what you buy arrives in the world in front of you.', { ticker: TOKEN.ticker, pct: feePct, pct2: tokenPct })}
      </p>
      <div className="build-shelves">
        <button className={tab === 'buy' ? 'on' : ''} onClick={() => setTab('buy')}>{t('Buy')}{orders.length > 0 && <span className="people-open"> · {orders.length}</span>}</button>
        <button className={tab === 'sell' ? 'on' : ''} onClick={() => setTab('sell')} disabled={!canAct}>{t('Sell')}</button>
        <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')} disabled={!canAct}>{t('Your orders')}{own.length > 0 && <span className="people-open"> · {own.length}</span>}</button>
        <button className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')} disabled={!canAct}>{t('History')}{past.length > 0 && <span className="people-open"> · {past.length}</span>}</button>
        <button className="ghost small" onClick={() => void reload()} disabled={busy}>{t('Refresh')}</button>
      </div>
      {note && <p className="people-note">{note}</p>}
      {(pending > 0 || waiting.length > 0) && canAct && (
        <p className="people-note">
          {t('{n} Gold purchase(s) paid for and not yet settled.', { n: Math.max(pending, waiting.length) })}{' '}
          {t('Your payment is on the exchange\u2019s books; it finishes by itself.')}{' '}
          <button className="ghost small" disabled={busy} onClick={() => act(() => actions.finish())}>{t('Finish a paid purchase')}</button>
          {waiting.map((w) => (
            <small key={w.txHash} className="muted exchange-waiting">
              {t('{n} Gold, paid {tx}', { n: w.qty.toLocaleString(), tx: `${w.txHash.slice(0, 10)}…` })}
              {w.problem ? ` · ${w.problem}` : ''}
            </small>
          ))}
        </p>
      )}
      {book === undefined && <p className="muted small">{t('Reading the exchange…')}</p>}
      {book === null && <p className="muted small">{t('The exchange could not be read just now.')}</p>}
      {tab === 'buy' && book && (
        <div className="people-rows">
          {orders.length === 0 && <p className="muted small">{t('Nothing is on the exchange right now. Put something up under Sell.')}</p>}
          {goods.length > 0 && <h4>{t('Goods, for Gold')}</h4>}
          {goods.map(row)}
          {gold.length > 0 && <h4>{t('Gold, for {ticker}', { ticker: TOKEN.ticker })}</h4>}
          {gold.map(row)}
        </div>
      )}
      {tab === 'past' && canAct && (
        <div className="people-rows">
          {past.length === 0 && <p className="muted small">{t('Nothing bought or sold yet. What you trade here is written down, both sides of it.')}</p>}
          {past.map(done)}
        </div>
      )}
      {tab === 'sell' && canAct && (
        <div className="exchange-sell">
          <div className="exchange-kind">
            <button className={`ghost small ${kind === 'resource' ? 'on' : ''}`} onClick={() => setKind('resource')}>{t('Goods for Gold')}</button>
            <button className={`ghost small ${kind === 'gold' ? 'on' : ''}`} onClick={() => setKind('gold')}>{t('Gold for {ticker}', { ticker: TOKEN.ticker })}</button>
          </div>
          {kind === 'resource' ? (
            <>
              <label>{t('Good')}
                <select value={resource} onChange={(e) => setResource(e.target.value as Resource)}>
                  {view.resources.map((r) => <option key={r.key} value={r.key}>{tn(r.label)} · {Math.floor(r.amount).toLocaleString()} {t('in store')}</option>)}
                </select>
              </label>
              <label>{t('How many')}<input type="number" min={1} max={Math.min(stock(resource), terms.maxGoodsLot)} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={String(Math.min(Math.floor(stock(resource)), terms.maxGoodsLot))} /></label>
              <label>{t('Gold each')}<input type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1" /></label>
              <p className="muted small">{t('You receive {n} Gold if it all sells, after the {pct}% burn. The goods leave the store now and come back if you take the order down.', { n: Math.max(0, q * p - Math.ceil(q * p * terms.fee)).toLocaleString(), pct: feePct })}</p>
            </>
          ) : (
            <>
              <label>{t('Gold to sell')}<input type="number" min={terms.minGoldLot} max={Math.floor(view.treasury)} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={String(terms.minGoldLot)} /></label>
              <label>{t('{ticker} a Gold', { ticker: TOKEN.ticker })}<input type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="10000" /></label>
              <p className="muted small">{t('The buyer pays {n} {ticker}: {net} straight to your wallet and {gone} burned. They receive the Gold less the {pct}% burn. Lots are {min} Gold or more, and never more than the treasury in your last published copy. The Gold leaves the treasury now.', { n: goldSaleSplit(q * p).whole.toLocaleString(), net: goldSaleSplit(q * p).toSeller.toLocaleString(), gone: goldSaleSplit(q * p).burned.toLocaleString(), ticker: TOKEN.ticker, pct: feePct, min: terms.minGoldLot })}</p>
            </>
          )}
          <button className="claim-button" disabled={busy || !sellOk} onClick={() => act(async () => { const why = await actions.list(kind, q, p, kind === 'resource' ? resource : undefined); if (!why) { setQty(''); setPrice(''); setTab('mine'); } return why; })}>
            {t('Put it up')}
          </button>
        </div>
      )}
      {tab === 'mine' && canAct && (
        <div className="people-rows">
          {own.length === 0 && <p className="muted small">{t('You have nothing on the exchange.')}</p>}
          {own.map(row)}
        </div>
      )}
    </div>
  );
}

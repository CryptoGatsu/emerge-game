'use client';

/**
 * Everything that has a price, on one page.
 *
 * Four markets run in Emerge and until now you had to be inside the game, with
 * a wallet, to see any of them. This is the outside view: the world market's
 * goods prices, the player exchange's standing orders and what has actually
 * filled on it, what a Gold has been worth in $EMERGE, and the land — what is
 * for sale and what has sold.
 *
 * Read-only and open to anybody. Nothing here needs a wallet, because deciding
 * whether to buy in is exactly the moment you cannot be asked to have bought in
 * already.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RESOURCES, RESOURCE_LABELS, type Resource } from '@/lib/world/goods';
import { TOKEN } from '@/lib/chain/emerge';
import { eraName } from '@/lib/world/eras';
import { useText } from '@/lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';
import { BrandLine } from './Brand';

interface Order {
  id: string; kind: 'resource' | 'gold'; sellerName: string; seed: number;
  resource?: Resource; qty: number; remaining: number; unitPrice: number; at: number;
}
interface Tick {
  id: string; at: number; kind: 'resource' | 'gold'; resource?: Resource;
  qty: number; unitPrice: number; burned: number; sellerName: string; buyerName: string;
}
interface Listing {
  seed: number; region: string; worldName: string; ownerName: string; price: number;
  listedAt: number; offers: number; bestOffer: number | null; era: number;
  level: number | null; population: number | null; biome: string;
}
interface Sale {
  id: string; at: number; seed: number; region: string; worldName: string;
  price: number; sellerName: string; buyerName: string; era: number; level: number | null;
}
interface Gold { traded: number | null; asked: number | null; volume: number; fills: number; windowHours: number }
interface Board {
  at: number; prices: Partial<Record<Resource, number>>; traders: number;
  orders: Order[]; trades: Tick[]; gold: Gold;
  land: Listing[]; landTotal: number; sales: Sale[]; degraded?: boolean;
}

const n = (v: number) => Math.round(v).toLocaleString();
/** A rate is a small number and rounding it to nothing would be a lie. */
const rate = (v: number) => (v >= 100 ? n(v) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));

function ago(at: number, now: number, t: (text: string, vars?: Record<string, string | number>) => string) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return t('{n}s ago', { n: s });
  const m = Math.round(s / 60);
  if (m < 90) return t('{n}m ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('{n}h ago', { n: h });
  return t('{n}d ago', { n: Math.round(h / 24) });
}

export default function Markets() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Not `t` straight from the module: the server renders this page in English
  // and this keeps the first client render agreeing with it. See `useText`.
  const { t, tn } = useText();

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/markets', { cache: 'no-store' });
      if (!r.ok) { setFailed(true); return; }
      setBoard(await r.json() as Board);
      setFailed(false);
      setNow(Date.now());
    } catch { setFailed(true); }
  }, []);

  useEffect(() => {
    void load();
    // The market fixes on its own clock and land moves rarely; a minute is
    // often enough to be current and rare enough not to be a load on anybody.
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const goods = board ? RESOURCES.filter((r) => typeof board.prices[r] === 'number') : [];
  const goodsOrders = board?.orders.filter((o) => o.kind === 'resource' && o.remaining > 0) ?? [];
  const goldOrders = board?.orders.filter((o) => o.kind === 'gold' && o.remaining > 0) ?? [];
  const goodsTrades = board?.trades.filter((x) => x.kind === 'resource') ?? [];
  const goldTrades = board?.trades.filter((x) => x.kind === 'gold') ?? [];

  return (
    <main className="wiki markets">
      <div className="wiki-inner">
        {/* The same head the guide wears, down to the mark that takes you home:
            two pages of the same site should not have two different ways back. */}
        <header className="wiki-head">
          <Link href="/" className="wiki-home"><BrandLine size={40} /></Link>
          <LanguageSwitch className="wiki-lang" />
          <h1>{t('Markets')}</h1>
          <p className="wiki-lede">
            {t('Every price in the game, in one place: what goods cost, what players are asking each other, what a Gold is worth in {ticker}, and what land is going for. No wallet needed to look.', { ticker: TOKEN.ticker })}
          </p>
        </header>

        {!board && !failed && <p className="muted">{t('Reading the markets…')}</p>}
        {failed && <p className="muted">{t('The markets could not be read just now. It will try again in a minute.')}</p>}

        {board && (
          <>
            {board.degraded && <p className="muted">{t('Some of this could not be read just now.')}</p>}

            {/* --- What a Gold is worth. The headline, because it is the number
                   that connects the settlement's own money to the token and the
                   one nobody could previously find. */}
            <section id="gold">
              <h2>{t('Gold in {ticker}', { ticker: TOKEN.ticker })}</h2>
              <div className="markets-rate">
                <div className="markets-figure">
                  <em>{t('TRADED')}</em>
                  <b>{board.gold.traded === null ? '—' : rate(board.gold.traded)}</b>
                  <span>{t('{ticker} a Gold, weighted by size over {n} days', { ticker: TOKEN.ticker, n: Math.round(board.gold.windowHours / 24) })}</span>
                </div>
                <div className="markets-figure">
                  <em>{t('ASKED')}</em>
                  <b>{board.gold.asked === null ? '—' : rate(board.gold.asked)}</b>
                  <span>{t('the cheapest Gold standing on the exchange right now')}</span>
                </div>
                <div className="markets-figure">
                  <em>{t('CHANGED HANDS')}</em>
                  <b>{n(board.gold.volume)}</b>
                  <span>{t('Gold across {n} sale(s) in the window', { n: board.gold.fills })}</span>
                </div>
              </div>
              <p className="wiki-note">
                {t('There is no official rate and there will not be one. Gold is a settlement’s own money and the vault never turns it into tokens: what is here is what players have actually paid each other, wallet to wallet, on the exchange. Where nothing has traded yet, the figure is blank rather than a guess.')}
              </p>
            </section>

            {/* --- The world market: prices set by what every settlement produces
                   and needs, the same figures the market panel shows in game. */}
            <section id="goods">
              <h2>{t('The world market')}</h2>
              <p>{t('One market across every settlement. These are the prices your own baker buys and sells at, fixed from what every plot reported holding — {n} of them at the last fixing.', { n: board.traders })}</p>
              <table className="wiki-table">
                <thead><tr><th>{t('Good')}</th><th>{t('Gold each')}</th><th>{t('Players asking')}</th><th>{t('Best ask')}</th></tr></thead>
                <tbody>
                  {goods.map((r) => {
                    const asks = goodsOrders.filter((o) => o.resource === r);
                    const best = asks.length ? Math.min(...asks.map((o) => o.unitPrice)) : null;
                    return (
                      <tr key={r}>
                        <td>{tn(RESOURCE_LABELS[r])}</td>
                        <td className="num">{n(board.prices[r] as number)}</td>
                        <td className="num">{asks.length || '—'}</td>
                        <td className="num">{best === null ? '—' : n(best)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* --- The player exchange: what people are asking, then what has
                   actually filled, which is the part that was never public. */}
            <section id="exchange">
              <h2>{t('Player to player')}</h2>
              <p>{t('Goods and Gold that players have put up for each other. Goods are paid for in Gold; Gold is paid for in {ticker}, wallet to wallet.', { ticker: TOKEN.ticker })}</p>

              <h3>{t('Goods on offer')}</h3>
              {goodsOrders.length === 0 ? <p className="muted">{t('Nothing is up right now.')}</p> : (
                <table className="wiki-table">
                  <thead><tr><th>{t('Good')}</th><th>{t('Left')}</th><th>{t('Gold each')}</th><th>{t('Seller')}</th><th>{t('Up')}</th></tr></thead>
                  <tbody>
                    {goodsOrders.sort((a, b) => a.unitPrice - b.unitPrice).slice(0, 60).map((o) => (
                      <tr key={o.id}>
                        <td>{tn(RESOURCE_LABELS[o.resource as Resource])}</td>
                        <td className="num">{n(o.remaining)}</td>
                        <td className="num">{n(o.unitPrice)}</td>
                        <td>{o.sellerName || '—'}</td>
                        <td className="num">{ago(o.at, now, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3>{t('Gold on offer')}</h3>
              {goldOrders.length === 0 ? <p className="muted">{t('No Gold is up right now.')}</p> : (
                <table className="wiki-table">
                  <thead><tr><th>{t('Gold left')}</th><th>{t('{ticker} each', { ticker: TOKEN.ticker })}</th><th>{t('For the lot')}</th><th>{t('Seller')}</th><th>{t('Up')}</th></tr></thead>
                  <tbody>
                    {goldOrders.sort((a, b) => a.unitPrice - b.unitPrice).slice(0, 60).map((o) => (
                      <tr key={o.id}>
                        <td className="num">{n(o.remaining)}</td>
                        <td className="num">{rate(o.unitPrice)}</td>
                        <td className="num">{n(o.remaining * o.unitPrice)}</td>
                        <td>{o.sellerName || '—'}</td>
                        <td className="num">{ago(o.at, now, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3>{t('What has sold')}</h3>
              {board.trades.length === 0 ? (
                <p className="muted">{t('Nothing has filled yet. This begins the day the tape was added and fills from there — trades before that were never written down publicly and cannot be recovered.')}</p>
              ) : (
                <table className="wiki-table">
                  <thead><tr><th>{t('What')}</th><th>{t('How many')}</th><th>{t('Each')}</th><th>{t('Buyer')}</th><th>{t('Seller')}</th><th>{t('When')}</th></tr></thead>
                  <tbody>
                    {[...goldTrades, ...goodsTrades].sort((a, b) => b.at - a.at).slice(0, 80).map((x) => (
                      <tr key={x.id}>
                        <td>{x.kind === 'gold' ? t('Gold') : tn(RESOURCE_LABELS[x.resource as Resource])}</td>
                        <td className="num">{n(x.qty)}</td>
                        <td className="num">{x.kind === 'gold' ? `${rate(x.unitPrice)} ${TOKEN.ticker}` : `${n(x.unitPrice)} ${t('Gold')}`}</td>
                        <td>{x.buyerName || '—'}</td>
                        <td>{x.sellerName || '—'}</td>
                        <td className="num">{ago(x.at, now, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* --- Land: the asking prices, and then what plots have gone for,
                   which is the only figure that says what land is worth. */}
            <section id="land">
              <h2>{t('Land')}</h2>
              <p>{t('{n} plot(s) for sale, paid wallet to wallet in {ticker}. A plot carries its settlement with it — the people, the buildings and the level all change hands.', { n: board.landTotal, ticker: TOKEN.ticker })}</p>
              {board.land.length === 0 ? <p className="muted">{t('No land is for sale right now.')}</p> : (
                <table className="wiki-table">
                  <thead><tr><th>{t('Plot')}</th><th>{t('Where')}</th><th>{t('Age')}</th><th>{t('Level')}</th><th>{t('People')}</th><th>{t('Asking')}</th><th>{t('Offers')}</th></tr></thead>
                  <tbody>
                    {board.land.slice(0, 80).map((l) => (
                      <tr key={l.seed}>
                        <td>{l.worldName || `#${l.seed}`}</td>
                        <td>{l.region}{l.biome ? ` · ${tn(l.biome)}` : ''}</td>
                        <td>{tn(eraName(l.era))}</td>
                        <td className="num">{l.level ?? '—'}</td>
                        <td className="num">{l.population ?? '—'}</td>
                        <td className="num">{n(l.price)}</td>
                        <td className="num">{l.offers ? `${l.offers} · ${n(l.bestOffer ?? 0)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3>{t('What land has sold for')}</h3>
              {board.sales.length === 0 ? (
                <p className="muted">{t('No sale has been recorded yet. Nothing kept a record of completed plot sales before this page, so the history begins here.')}</p>
              ) : (
                <table className="wiki-table">
                  <thead><tr><th>{t('Plot')}</th><th>{t('Where')}</th><th>{t('Age')}</th><th>{t('Level')}</th><th>{t('Went for')}</th><th>{t('Buyer')}</th><th>{t('When')}</th></tr></thead>
                  <tbody>
                    {board.sales.slice(0, 60).map((s) => (
                      <tr key={s.id}>
                        <td>{s.worldName || `#${s.seed}`}</td>
                        <td>{s.region}</td>
                        <td>{tn(eraName(s.era))}</td>
                        <td className="num">{s.level ?? '—'}</td>
                        <td className="num">{n(s.price)}</td>
                        <td>{s.buyerName || '—'}</td>
                        <td className="num">{ago(s.at, now, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <p className="wiki-note">
              {t('Read again every minute. Prices are the world market’s own fixing; the asks are what players have standing; the sales are what actually happened. Nothing on this page can be traded from here — open the game to buy or sell.')}
              {' '}<Link href="/wiki">{t('How the markets work')}</Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}

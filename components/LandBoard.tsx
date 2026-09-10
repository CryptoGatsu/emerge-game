'use client';

/**
 * The land marketplace: every plot in Emerge, on one page.
 *
 * A plot is an ERC-721 whose token id is the seed that grows its land, so
 * this page is a view of the chain rather than of us: what exists, who holds
 * it, what it is being asked for, and what plots have actually sold for. The
 * picture on each card is drawn from the plot's own terrain and its owner's
 * last published settlement, so a town that has grown looks like one.
 *
 * Anybody can look without a wallet — deciding whether to buy in is exactly
 * the moment you cannot be asked to have bought in already. A wallet is only
 * wanted at the point of buying, and then the sale settles on the market
 * contract in one transaction: the seller is paid, the holders' royalty goes
 * to the dividend pool, and the plot moves. The game follows the chain.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ACTIVE_CHAIN, TOKEN, tokenBalance } from '@/lib/chain/emerge';
import { buyOnChain, marketAllowance, approveMarketSpend, marketListing, marketLive, mined, openSeaUrl, plotExplorerUrl, onChainClaimsLive } from '@/lib/chain/registry';
import { ROYALTY_PERCENT } from '@/lib/chain/plots';
import { followPlot } from '@/lib/net/registry';
import { eraName } from '@/lib/world/eras';
import { useText } from '@/lib/i18n';
import { SiteNav } from './SiteNav';
import { WalletPicker, useWallet } from './WalletPicker';

interface PlotListing { where: 'market' | 'opensea'; price: number; currency: string; at: number }
interface Plot {
  seed: number; region: string; worldName: string; owner: string; ownerName: string;
  listings: PlotListing[]; price: number | null; currency: string | null; listedAt: number | null; claimedAt: number;
  era: number; expanded: boolean; banner: string | null; biome: string;
  level: number | null; population: number | null; buildings: number | null;
  day: number | null; publishedAt: number | null;
}
interface Sale { seed: number; seller: string; buyer: string; price: number; fee: number; at: number; txHash: string }
interface Catalogue {
  plots: Plot[]; total: number; listed: number;
  listedBy: { market: number; opensea: number };
  floors: { currency: string; price: number }[];
  holders: number; openSeaRead: boolean;
  sales: Sale[]; at: number; degraded?: boolean;
}

type Sort = 'price-up' | 'price-down' | 'level' | 'people' | 'recent' | 'seed';

const n = (v: number) => Math.round(v).toLocaleString();
/**
 * A price, kept whole.
 *
 * Counts round; money does not. A stablecoin asking price has cents in it,
 * and rounding 480.50 to 481 on a page people buy from is a small lie about
 * what something costs.
 */
const money = (v: number) =>
  Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function ago(at: number, now: number, t: (text: string, vars?: Record<string, string | number>) => string) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return t('{n}s ago', { n: s });
  const m = Math.round(s / 60);
  if (m < 90) return t('{n}m ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 36) return t('{n}h ago', { n: h });
  return t('{n}d ago', { n: Math.round(h / 24) });
}

export default function LandMarket() {
  const { t } = useText();
  const { wallet } = useWallet();
  const me = wallet.address?.toLowerCase() ?? null;

  const [board, setBoard] = useState<Catalogue | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [search, setSearch] = useState('');
  const [biome, setBiome] = useState('');
  const [era, setEra] = useState('');
  const [forSale, setForSale] = useState(false);
  const [currencyOnly, setCurrencyOnly] = useState('');
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<Sort>('price-up');
  const [shown, setShown] = useState(36);

  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const r = await fetch('/api/land?all=1', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setBoard((await r.json()) as Catalogue);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    // The board moves slowly; a minute is soon enough, and the clock ticks so
    // "listed 2m ago" does not sit there being wrong.
    const board = setInterval(() => { void read(); }, 60_000);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(board); clearInterval(clock); };
  }, [read]);

  useEffect(() => {
    if (!me) { setBalance(null); return; }
    void tokenBalance(me).then(setBalance).catch(() => setBalance(null));
  }, [me]);

  const biomes = useMemo(() => [...new Set((board?.plots ?? []).map((p) => p.biome))].sort(), [board]);
  const currencies = useMemo(() => (board?.floors ?? []).map((f) => f.currency), [board]);
  const eras = useMemo(() => [...new Set((board?.plots ?? []).map((p) => p.era))].sort((a, b) => a - b), [board]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (board?.plots ?? []).filter((p) => {
      if (forSale && p.listings.length === 0) return false;
      if (currencyOnly && !p.listings.some((l) => l.currency === currencyOnly)) return false;
      if (mine && p.owner !== me) return false;
      if (biome && p.biome !== biome) return false;
      if (era && String(p.era) !== era) return false;
      if (!q) return true;
      return p.worldName.toLowerCase().includes(q) || p.region.toLowerCase().includes(q)
        || String(p.seed).includes(q) || p.owner.includes(q) || (p.ownerName ?? '').toLowerCase().includes(q);
    });
    // An unlisted plot has no price, and sorting by price should not bury or
    // promote it arbitrarily: it always sits after the priced ones.
    const byPrice = (a: Plot, b: Plot, dir: number) =>
      a.price === null && b.price === null ? a.seed - b.seed
        : a.price === null ? 1 : b.price === null ? -1 : (a.price - b.price) * dir;
    return out.sort((a, b) => {
      switch (sort) {
        case 'price-up': return byPrice(a, b, 1);
        case 'price-down': return byPrice(a, b, -1);
        case 'level': return (b.level ?? 0) - (a.level ?? 0) || (b.population ?? 0) - (a.population ?? 0);
        case 'people': return (b.population ?? 0) - (a.population ?? 0);
        case 'recent': return (b.listedAt ?? b.claimedAt) - (a.listedAt ?? a.claimedAt);
        default: return a.seed - b.seed;
      }
    });
  }, [board, search, biome, era, forSale, mine, currencyOnly, sort, me]);

  useEffect(() => { setShown(36); }, [search, biome, era, forSale, mine, currencyOnly, sort]);

  /**
   * Buy a listed plot.
   *
   * The price is read from the contract at the moment of buying, never from
   * this page's copy of the board, and passed back as the buyer's ceiling: a
   * seller who raises the price between the render and the signature gets a
   * refusal rather than the buyer's money.
   */
  const buy = useCallback(async (plot: Plot, listing: PlotListing) => {
    if (listing.where !== 'market') return;
    if (!me) { setNotice(t('Connect a wallet to buy.')); return; }
    if (!marketLive()) { setNotice(t('The land market is not open on this build.')); return; }
    setBusy(plot.seed);
    setNotice(null);
    try {
      const onChain = await marketListing(plot.seed);
      if (!onChain || !onChain.live) { setNotice(t('That plot is not listed on the game’s market right now. The holder may have taken it down.')); return; }
      const price = onChain.price;
      if (balance !== null && balance < price) {
        setNotice(t('{world} costs {price} {ticker}, and your wallet holds {held}.', { world: plot.worldName, price: money(price), ticker: TOKEN.ticker, held: money(balance) }));
        return;
      }
      if ((await marketAllowance(me)) < price) {
        setNotice(t('First, let the market take the price: one signature.'));
        const allowed = await approveMarketSpend(me, price);
        if (!allowed.ok) { setNotice(allowed.message); return; }
        if ((await mined(allowed.txHash)) === 'reverted') { setNotice(t('The chain refused the approval.')); return; }
      }
      setNotice(t('Now the purchase: {price} {ticker} to the holder, and the plot to you.', { price: money(price), ticker: TOKEN.ticker }));
      const bought = await buyOnChain(me, plot.seed, price);
      if (!bought.ok) { setNotice(bought.message); return; }
      const state = await mined(bought.txHash);
      if (state === 'reverted') { setNotice(t('The chain refused the purchase: the plot may have sold to somebody else first.')); return; }
      await followPlot(plot.seed, me).catch(() => null);
      setNotice(t('{world} is yours. Open it from the world map.', { world: plot.worldName }));
      void tokenBalance(me).then(setBalance).catch(() => {});
      void read();
    } catch (error) {
      setNotice(error instanceof Error ? error.message.slice(0, 160) : t('That did not go through.'));
    } finally {
      setBusy(null);
    }
  }, [me, balance, read, t]);

  const tokens = onChainClaimsLive();

  return (
    <main className="wiki landmkt">
      <div className="wiki-inner">
        <SiteNav current="/land" />
        <header className="wiki-head">
          <h1>{t('Land')}</h1>
          <p className="wiki-lede">
            {tokens
              ? t('Every plot in Emerge, and who holds it. A plot is a token whose id is the seed that grows its land, and it carries its settlement with it — the people, the buildings and the level all change hands. Look without a wallet; connect one to buy.')
              : t('Every plot in Emerge, and who holds it. A plot carries its settlement with it — the people, the buildings and the level all change hands.')}
          </p>
        </header>

        {!board && !failed && <p className="muted">{t('Reading the land…')}</p>}
        {failed && <p className="muted">{t('The land could not be read just now. It will try again in a minute.')}</p>}

        {board && (
          <>
            {board.degraded && <p className="muted">{t('Some of this could not be read just now.')}</p>}
            {tokens && !board.openSeaRead && (
              <p className="muted">{t('Showing the game’s own market only. Plots listed on OpenSea are not counted here yet.')}</p>
            )}

            <section className="landmkt-stats" aria-label={t('The board at a glance')}>
              <div className="markets-figure">
                <em>{t('PLOTS SETTLED')}</em><b>{n(board.total)}</b>
                <span>{t('held by {n} wallet(s)', { n: board.holders })}</span>
              </div>
              <div className="markets-figure">
                <em>{t('FOR SALE')}</em><b>{n(board.listed)}</b>
                <span>
                  {board.listed === 0 ? t('nothing listed right now')
                    : t('{a} on OpenSea · {b} on the game’s market', { a: n(board.listedBy.opensea), b: n(board.listedBy.market) })}
                </span>
              </div>
              <div className="markets-figure">
                <em>{t('FLOOR')}</em>
                {board.floors.length === 0 ? <b>—</b> : (
                  <b className="landmkt-floors">
                    {board.floors.map((f) => <span key={f.currency}>{money(f.price)} <i>{f.currency}</i></span>)}
                  </b>
                )}
                <span>{board.floors.length > 1 ? t('the cheapest in each currency') : t('the cheapest asking price')}</span>
              </div>
              <div className="markets-figure">
                <em>{t('ROYALTY')}</em><b>{ROYALTY_PERCENT}%</b>
                <span>{t('of every resale, back to land holders')}</span>
              </div>
            </section>

            {tokens && (
              <div className="landmkt-wallet">
                <WalletPicker compact />
                {me && balance !== null && <span className="muted">{t('Your wallet holds {n} {ticker}.', { n: money(balance), ticker: TOKEN.ticker })}</span>}
              </div>
            )}
            {notice && <p className="landmkt-notice" role="status">{notice}</p>}

            <div className="landmkt-controls">
              <label className="landmkt-search">
                <span className="sr-only">{t('Search the land')}</span>
                <input
                  id="land-search" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('Search a name, a region, a seed or a wallet')}
                />
              </label>
              <label>
                <span className="sr-only">{t('Biome')}</span>
                <select id="land-biome" value={biome} onChange={(e) => setBiome(e.target.value)}>
                  <option value="">{t('Every biome')}</option>
                  {biomes.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label>
                <span className="sr-only">{t('Age')}</span>
                <select id="land-era" value={era} onChange={(e) => setEra(e.target.value)}>
                  <option value="">{t('Every age')}</option>
                  {eras.map((e) => <option key={e} value={String(e)}>{eraName(e)}</option>)}
                </select>
              </label>
              <label>
                <span className="sr-only">{t('Order')}</span>
                <select id="land-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="price-up">{t('Price: low to high')}</option>
                  <option value="price-down">{t('Price: high to low')}</option>
                  <option value="level">{t('City level')}</option>
                  <option value="people">{t('People')}</option>
                  <option value="recent">{t('Recently listed')}</option>
                  <option value="seed">{t('Token id')}</option>
                </select>
              </label>
              {currencies.length > 1 && (
                <label>
                  <span className="sr-only">{t('Currency')}</span>
                  <select id="land-money" value={currencyOnly} onChange={(e) => setCurrencyOnly(e.target.value)}>
                    <option value="">{t('Any currency')}</option>
                    {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className={`landmkt-toggle ${forSale ? 'on' : ''}`} aria-pressed={forSale} onClick={() => setForSale((v) => !v)}>
                {t('For sale only')}
              </button>
              {me && (
                <button type="button" className={`landmkt-toggle ${mine ? 'on' : ''}`} aria-pressed={mine} onClick={() => setMine((v) => !v)}>
                  {t('Mine')}
                </button>
              )}
              <span className="landmkt-count">{t('{n} plot(s)', { n: rows.length })}</span>
            </div>

            {rows.length === 0 ? (
              <p className="muted">{t('No plot matches that.')}</p>
            ) : (
              <>
                <ul className="landmkt-grid">
                  {rows.slice(0, shown).map((p) => {
                    const os = openSeaUrl(p.seed);
                    const ex = plotExplorerUrl(p.seed);
                    const isMine = !!me && p.owner === me;
                    return (
                      <li key={p.seed} className={`landmkt-card ${isMine ? 'mine' : ''}`}>
                        <Link href={`/?plot=${p.seed}`} className="landmkt-art" aria-label={t('Open {world} on the world map', { world: p.worldName })}>
                          {/* The plot's own land, drawn from its terrain and its
                              owner's last published settlement. */}
                          <img src={`/api/nft/${p.seed}/image`} alt="" loading="lazy" width={512} height={512} />
                          {p.expanded && <em className="landmkt-tag">{t('Expanded')}</em>}
                        </Link>
                        <div className="landmkt-body">
                          <h3>{p.worldName}</h3>
                          <p className="landmkt-where">{p.region} · {p.biome} · {eraName(p.era)}</p>
                          <p className="landmkt-facts">
                            {p.level !== null && <span>{t('Level {n}', { n: p.level })}</span>}
                            {p.population !== null && <span>{t('{n} people', { n: p.population })}</span>}
                            {p.buildings !== null && <span>{t('{n} buildings', { n: p.buildings })}</span>}
                            {p.level === null && <span className="muted">{t('never published')}</span>}
                          </p>
                          <p className="landmkt-holder">
                            {isMine ? t('Yours') : t('Held by {who}', { who: p.ownerName || short(p.owner) })}
                            {tokens && <> · <span className="muted">#{p.seed}</span></>}
                          </p>
                          <div className="landmkt-deal">
                            {p.listings.length === 0 ? (
                              <span className="muted">{t('Not for sale')}</span>
                            ) : (
                              <span className="landmkt-prices">
                                {p.listings.map((l) => (
                                  <span key={l.where} className="landmkt-price">
                                    <b>{money(l.price)} {l.currency}</b>
                                    <em>{l.where === 'opensea' ? t('on OpenSea') : t('in the game')}</em>
                                  </span>
                                ))}
                              </span>
                            )}
                            {p.listedAt ? <span className="muted">{ago(p.listedAt, now, t)}</span> : null}
                          </div>
                          <div className="landmkt-actions">
                            {!isMine && marketLive() && p.listings.filter((l) => l.where === 'market').map((l) => (
                              <button key="market" type="button" disabled={busy !== null} onClick={() => void buy(p, l)}>
                                {busy === p.seed ? t('Buying…') : !me ? t('Connect a wallet to buy') : t('Buy for {n} {c}', { n: money(l.price), c: l.currency })}
                              </button>
                            ))}
                            {!isMine && os && p.listings.some((l) => l.where === 'opensea') && (
                              <a href={os} target="_blank" rel="noreferrer noopener" className="landmkt-os">{t('Buy on OpenSea')}</a>
                            )}
                            <Link href={`/?plot=${p.seed}`} className="ghost">{t('Visit')}</Link>
                            {os && !(!isMine && p.listings.some((l) => l.where === 'opensea')) && (
                              <a href={os} target="_blank" rel="noreferrer noopener" className="ghost">OpenSea</a>
                            )}
                            {ex && <a href={ex} target="_blank" rel="noreferrer noopener" className="ghost">{t('Chain')}</a>}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {shown < rows.length && (
                  <button type="button" className="landmkt-more" onClick={() => setShown((s) => s + 36)}>
                    {t('Show more ({n} left)', { n: rows.length - shown })}
                  </button>
                )}
              </>
            )}

            {/* What plots have actually gone for, read from the market
                contract. An asking price is an opinion; this is the record. */}
            <section id="sold">
              <h2>{t('What land has sold for')}</h2>
              {board.sales.length === 0 ? (
                <p className="muted">
                  {tokens
                    ? t('No plot has changed hands on the land market yet. Sales made on OpenSea are not listed here; the chain and the holder on each card are always current.')
                    : t('No plot has changed hands yet.')}
                </p>
              ) : (
                <div className="landmkt-sales">
                  {board.sales.map((s) => {
                    const plot = board.plots.find((p) => p.seed === s.seed);
                    return (
                      <div key={s.txHash + s.seed} className="landmkt-sale">
                        <span className="landmkt-sale-what">
                          <b>{plot?.worldName ?? t('Plot #{n}', { n: s.seed })}</b>
                          {plot && <em className="muted"> {plot.region}</em>}
                        </span>
                        <span className="landmkt-sale-price">{money(s.price)} {TOKEN.ticker}</span>
                        <span className="muted landmkt-sale-who">
                          {t('{from} → {to}', { from: short(s.seller), to: short(s.buyer) })}
                          {s.fee > 0 && <> · {t('{n} to holders', { n: money(s.fee) })}</>}
                        </span>
                        <span className="muted landmkt-sale-when">{s.at ? ago(s.at, now, t) : ''}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section id="how">
              <h2>{t('How it works')}</h2>
              <p>
                {tokens
                  ? t('Every plot is an ERC-721 token on {chain}: the token id is the seed that grows the land, so the thing you own and the thing the game draws are the same number. Selling is two signatures — one to let the market move the plot when it sells, one to name the price — and the plot stays in your wallet until a buyer pays. A sale pays the seller and pays {fee}% to the holders’ dividend pool, in one transaction.', { chain: ACTIVE_CHAIN.label, fee: ROYALTY_PERCENT })
                  : t('Land is bought and sold between players, wallet to wallet.')}
              </p>
              <p className="muted">
                {t('You list a plot from inside its world, in the On-Chain panel. Buying can happen here, on the world map, or on OpenSea.')}
              </p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

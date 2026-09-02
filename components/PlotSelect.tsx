'use client';

/**
 * The land office.
 *
 * Plots are browsed, prospected and claimed here. Each preview runs the real
 * terrain generator on that plot's seed, so the ground shown is the ground you
 * get, and each plot belongs to a biome that decides what can be done there —
 * a highland shelf opens with mines and a forge, a fen with fields and a mill.
 *
 * Claims and listings are honest about where they stand: with no registry
 * contract deployed they are recorded in this browser, and the panel says so
 * rather than showing a transaction that bought nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultWorldName } from '@/lib/simulation';
import {
  drawPlotPreview, loadPlayer, marketPlots, prospectPlot, savePlayer,
  type ClaimedWorld, type PlayerRecord, type Plot,
} from '@/lib/world/plots';
import { ACTIVE_CHAIN, TOKEN, chainConfigured, claimPlot } from '@/lib/chain/emerge';
import { LOCAL_TEST_ALLOCATION, PROSPECT_COST_EMERGE } from '@/lib/chain/vault';
import { WalletPicker, useWallet } from './WalletPicker';

function PlotPreview({ seed, size = 240 }: { seed: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Generation is a few tens of milliseconds; yielding a frame first keeps a
    // page of previews from appearing all at once after a visible stall.
    const id = requestAnimationFrame(() => drawPlotPreview(canvas, seed));
    return () => cancelAnimationFrame(id);
  }, [seed]);
  return <canvas ref={ref} width={size} height={Math.round(size * 0.56)} className="plot-canvas" />;
}

export default function PlotSelect({ onEnter }: { onEnter: (world: ClaimedWorld) => void }) {
  const [player, setPlayer] = useState<PlayerRecord | null>(null);
  const [selectedSeed, setSelectedSeed] = useState<number | null>(null);
  const [name, setName] = useState('');
  const { wallet } = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = chainConfigured();

  useEffect(() => { setPlayer(loadPlayer()); }, []);

  const plots = useMemo(() => (player ? marketPlots(player) : []), [player]);
  const selected: Plot | null = plots.find((p) => p.seed === selectedSeed) ?? plots[0] ?? null;

  const prospect = useCallback(() => {
    if (!player) return;
    if (player.ledger.balance < PROSPECT_COST_EMERGE) {
      setNotice(`Prospecting costs ${PROSPECT_COST_EMERGE.toLocaleString()} ${TOKEN.ticker}.`);
      return;
    }
    const found = prospectPlot(player.prospected.length);
    const next: PlayerRecord = {
      ...player,
      ledger: { ...player.ledger, balance: player.ledger.balance - PROSPECT_COST_EMERGE },
      prospected: [...player.prospected, found.seed],
    };
    savePlayer(next);
    setPlayer(next);
    setSelectedSeed(found.seed);
    setNotice(`Surveyed ${found.region} — ${found.biomeLabel.toLowerCase()}.`);
  }, [player]);

  const claim = useCallback(async () => {
    if (!selected) return;
    setClaiming(true);
    setNotice(null);
    const worldName = name.trim() || defaultWorldName(selected.seed);
    const result = await claimPlot({
      seed: selected.seed,
      region: selected.region,
      worldName,
      price: selected.price,
      address: wallet.address,
    });
    setClaiming(false);
    if (result.reason) setNotice(result.reason);
    onEnter({
      seed: selected.seed,
      name: worldName,
      region: selected.region,
      price: selected.price,
      claimedAt: Date.now(),
      owner: wallet.address,
      txHash: result.txHash,
    });
  }, [name, selected, wallet.address, onEnter]);

  const unlist = useCallback((seed: number) => {
    if (!player) return;
    const next = { ...player, listings: player.listings.filter((l) => l.seed !== seed) };
    savePlayer(next);
    setPlayer(next);
  }, [player]);

  if (!player || !selected) return <main className="land-office" />;

  return (
    <main className="land-office">
      <div className="land-inner">
        <header className="land-head">
          <div className="brand-line">
            <div className="brand-mark">✦</div>
            <div>
              <div className="wordmark">EMERGE</div>
              <div className="tagline">THE AI WORLD</div>
            </div>
          </div>
          <p>
            Every plot is a world waiting to happen, and no two are the same land. Claim one with
            {' '}{TOKEN.ticker}, give it a name, and the beings who live there will call it that.
          </p>
          <div className="land-balance">
            <span>YOUR BALANCE</span>
            <b>{Math.floor(player.ledger.balance).toLocaleString()}</b>
            <em>{TOKEN.ticker}</em>
          </div>
        </header>

        <div className="land-body">
          <section>
            <div className="land-section-head">
              <h2>Land for sale</h2>
              <button
                className="ghost"
                onClick={prospect}
                disabled={player.ledger.balance < PROSPECT_COST_EMERGE}
              >
                Prospect new land · {PROSPECT_COST_EMERGE.toLocaleString()} {TOKEN.ticker}
              </button>
            </div>

            <div className="plot-list">
              {plots.map((plot) => (
                <button
                  key={plot.id}
                  className={`plot-card ${selected.seed === plot.seed ? 'selected' : ''}`}
                  onClick={() => setSelectedSeed(plot.seed)}
                >
                  <PlotPreview seed={plot.seed} />
                  <div className="plot-meta">
                    <div className="plot-title">
                      <h3>{plot.region}</h3>
                      <span className={`biome-tag ${plot.biome}`}>{plot.biomeLabel}</span>
                    </div>
                    <p>{plot.blurb}</p>
                    <div className="plot-facts">
                      <span>{plot.population} beings</span>
                      <span>{plot.trades.length} trades</span>
                      <b>{plot.price} {TOKEN.ticker}</b>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {player.listings.length > 0 && (
              <>
                <div className="land-section-head"><h2>Your listings</h2></div>
                <div className="listing-list">
                  {player.listings.map((listing) => (
                    <div key={listing.seed} className="listing-row">
                      <span>{listing.region}</span>
                      <b>{listing.price.toLocaleString()} {TOKEN.ticker}</b>
                      <em>Awaiting a buyer</em>
                      <button className="ghost" onClick={() => unlist(listing.seed)}>Withdraw</button>
                    </div>
                  ))}
                </div>
                <p className="muted small">
                  Resale between players needs the plot registry on {ACTIVE_CHAIN.label}. Until it is
                  deployed a listing is recorded in this browser and no one else can see it.
                </p>
              </>
            )}
          </section>

          <aside className="land-claim">
            <span className="eyebrow">CLAIM</span>
            <h2>{selected.region}</h2>
            <div className="plot-traits">
              <span className={`biome-tag ${selected.biome}`}>{selected.biomeLabel}</span>
            </div>
            <p className="muted">{selected.blurb}</p>

            <span className="eyebrow">TRADES THIS LAND SUPPORTS</span>
            <div className="plot-traits">
              {selected.trades.map((t) => <span key={t}>{t}</span>)}
            </div>

            <label className="name-field">
              <span>NAME YOUR WORLD</span>
              <input
                value={name}
                maxLength={24}
                placeholder={defaultWorldName(selected.seed)}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className="claim-price">
              <span>PRICE</span>
              <b>{selected.price}</b>
              <em>{TOKEN.ticker}</em>
            </div>

            <div className="claim-wallet"><WalletPicker compact /></div>

            <button className="claim-button" onClick={claim} disabled={claiming}>
              {claiming ? 'Claiming…' : `Claim ${selected.region}`}
            </button>

            {!configured && (
              <p className="muted small">
                {ACTIVE_CHAIN.label} is not configured in this build, so claims are recorded in this
                browser rather than on chain, and you start with a local development allocation of
                {' '}{LOCAL_TEST_ALLOCATION.toLocaleString()} {TOKEN.ticker}. Neither is a token transfer.
              </p>
            )}
            {notice && <p className="warn">{notice}</p>}
          </aside>
        </div>
      </div>
    </main>
  );
}
